const { ChromaClient } = require('chromadb');
const { DefaultEmbeddingFunction } = require('chromadb-default-embed');

// 初始化 ChromaDB 客户端
const client = new ChromaClient({
  path: "http://localhost:8000" // ChromaDB 服务地址
});

// 嵌入函数（用于生成向量）
const embedder = new DefaultEmbeddingFunction();

let messagesCollection;
let memoriesCollection;
let sessionsMap = new Map(); // 会话元数据用内存存储

async function initChroma() {
  try {
    // 创建或获取集合
    messagesCollection = await client.getOrCreateCollection({
      name: "chat_messages",
      embeddingFunction: embedder,
      metadata: { description: "聊天消息存储" }
    });

    memoriesCollection = await client.getOrCreateCollection({
      name: "long_term_memories",
      embeddingFunction: embedder,
      metadata: { description: "长期记忆摘要" }
    });

    console.log('✅ ChromaDB 初始化成功');
  } catch (error) {
    console.error('❌ ChromaDB 初始化失败:', error.message);
    console.log('💡 请确保 ChromaDB 服务正在运行：');
    console.log('   docker run -p 8000:8000 chromadb/chroma');
    process.exit(1);
  }
}

// ========== 数据库操作接口（兼容原有代码） ==========

const db = {
  prepare: (sql) => {
    // 模拟 SQL 接口，内部转换为 ChromaDB 操作
    
    // INSERT OR IGNORE INTO sessions
    if (sql.includes('INSERT OR IGNORE INTO sessions')) {
      return {
        run: (sessionId, createdAt, updatedAt) => {
          if (!sessionsMap.has(sessionId)) {
            sessionsMap.set(sessionId, { 
              id: sessionId, 
              createdAt, 
              updatedAt,
              messageCount: 0
            });
          }
        }
      };
    }
    
    // INSERT INTO messages
    if (sql.includes('INSERT INTO messages')) {
      return {
        run: async (sessionId, role, content, tokens, timestamp) => {
          const messageId = `${sessionId}_${timestamp}`;
          
          await messagesCollection.add({
            ids: [messageId],
            documents: [content],
            metadatas: [{
              session_id: sessionId,
              role: role,
              tokens: tokens,
              timestamp: timestamp,
              is_summarized: 0
            }]
          });
          
          // 更新消息计数
          const session = sessionsMap.get(sessionId);
          if (session) session.messageCount++;
        }
      };
    }
    
    // UPDATE sessions
    if (sql.includes('UPDATE sessions SET updated_at')) {
      return {
        run: (updatedAt, sessionId) => {
          const session = sessionsMap.get(sessionId);
          if (session) session.updatedAt = updatedAt;
        }
      };
    }
    
    // SELECT COUNT(*) - 获取未压缩的消息数
    if (sql.includes('SELECT COUNT(*) as count FROM messages')) {
      return {
        get: async (sessionId) => {
          const results = await messagesCollection.get({
            where: {
              session_id: sessionId,
              is_summarized: 0
            }
          });
          return { count: results.ids.length };
        }
      };
    }
    
    // SELECT role, content - 获取最近的对话历史
    if (sql.includes('SELECT role, content FROM messages') && 
        sql.includes('ORDER BY timestamp DESC')) {
      return {
        all: async (sessionId, limit) => {
          const results = await messagesCollection.get({
            where: {
              session_id: sessionId,
              is_summarized: 0
            }
          });
          
          // 按时间戳排序并限制数量
          const messages = results.ids.map((id, i) => ({
            role: results.metadatas[i].role,
            content: results.documents[i],
            timestamp: results.metadatas[i].timestamp
          }));
          
          messages.sort((a, b) => b.timestamp - a.timestamp);
          return messages.slice(0, limit);
        }
      };
    }
    
    // SELECT summary - 获取长期记忆
    if (sql.includes('SELECT summary FROM long_term_memory')) {
      return {
        all: async (sessionId) => {
          const results = await memoriesCollection.get({
            where: { session_id: sessionId }
          });
          
          if (results.ids.length === 0) return [];
          
          const memories = results.ids.map((id, i) => ({
            summary: results.documents[i],
            created_at: results.metadatas[i].created_at
          }));
          
          memories.sort((a, b) => a.created_at - b.created_at);
          return memories;
        }
      };
    }
    
    // SELECT 未压缩的消息（用于生成摘要）
    if (sql.includes('SELECT id, role, content FROM messages') && 
        sql.includes('is_summarized = 0')) {
      return {
        all: async (sessionId) => {
          const results = await messagesCollection.get({
            where: {
              session_id: sessionId,
              is_summarized: 0
            }
          });
          
          const messages = results.ids.map((id, i) => ({
            id: id,
            role: results.metadatas[i].role,
            content: results.documents[i],
            timestamp: results.metadatas[i].timestamp
          }));
          
          messages.sort((a, b) => a.timestamp - b.timestamp);
          return messages;
        }
      };
    }
    
    // INSERT INTO long_term_memory
    if (sql.includes('INSERT INTO long_term_memory')) {
      return {
        run: async (sessionId, summary, createdAt) => {
          const memoryId = `${sessionId}_summary_${createdAt}`;
          
          await memoriesCollection.add({
            ids: [memoryId],
            documents: [summary],
            metadatas: [{
              session_id: sessionId,
              created_at: createdAt
            }]
          });
        }
      };
    }
    
    // UPDATE messages SET is_summarized = 1
    if (sql.includes('UPDATE messages SET is_summarized = 1')) {
      return {
        run: async (messageId) => {
          await messagesCollection.update({
            ids: [messageId],
            metadatas: [{ is_summarized: 1 }]
          });
        }
      };
    }
    
    // 默认返回空操作
    return { 
      run: async () => {}, 
      get: async () => null, 
      all: async () => [] 
    };
  },
  
  transaction: (fn) => {
    return async (params) => {
      // ChromaDB 没有事务，直接执行
      await fn(params);
    };
  }
};

// ========== 新增：语义检索功能 ==========

async function semanticSearch(sessionId, query, limit = 5) {
  // 基于语义相似度检索历史对话
  const results = await messagesCollection.query({
    queryTexts: [query],
    nResults: limit,
    where: { session_id: sessionId }
  });
  
  return results.documents[0].map((doc, i) => ({
    content: doc,
    role: results.metadatas[0][i].role,
    similarity: results.distances[0][i]
  }));
}

module.exports = { 
  initChroma, 
  db, 
  semanticSearch 
};