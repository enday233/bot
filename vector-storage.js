const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('./config');

// 向量存储（使用文件持久化）
const dataDir = path.join(__dirname, 'vector_data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

const messagesFile = path.join(dataDir, 'messages.json');
const memoriesFile = path.join(dataDir, 'memories.json');
const sessionsFile = path.join(dataDir, 'sessions.json');

// 加载数据
let messages = [];
let memories = [];
let sessions = new Map();

function loadData() {
  if (fs.existsSync(messagesFile)) {
    messages = JSON.parse(fs.readFileSync(messagesFile, 'utf-8'));
  }
  if (fs.existsSync(memoriesFile)) {
    memories = JSON.parse(fs.readFileSync(memoriesFile, 'utf-8'));
  }
  if (fs.existsSync(sessionsFile)) {
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    sessions = new Map(data);
  }
}

function saveData() {
  fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
  fs.writeFileSync(memoriesFile, JSON.stringify(memories, null, 2));
  fs.writeFileSync(sessionsFile, JSON.stringify([...sessions], null, 2));
}

// 生成嵌入向量（使用 API）
async function getEmbedding(text) {
  try {
    const response = await fetch(config.BOHE_API_ENDPOINT.replace('/chat/completions', '/embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.BOHE_API_KEY}`
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: text
      })
    });

    if (!response.ok) {
      // 如果 API 不支持 embeddings，返回简单的词频向量
      return simpleEmbedding(text);
    }

    const data = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    // 降级方案：使用简单的词频向量
    return simpleEmbedding(text);
  }
}

// 简单嵌入（降级方案）
function simpleEmbedding(text) {
  // 使用字符哈希生成固定维度向量
  const vector = new Array(128).fill(0);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    vector[charCode % 128] += 1;
  }
  // 归一化
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map(v => v / (magnitude || 1));
}

// 计算余弦相似度
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 初始化
async function initVectorDB() {
  loadData();
  console.log('✅ 向量数据库初始化成功');
  console.log(`📊 已加载 ${messages.length} 条消息, ${memories.length} 条记忆`);
}

// ========== 数据库接口 ==========

let messageIdCounter = messages.length > 0 ? 
  Math.max(...messages.map(m => m.id)) + 1 : 1;

const db = {
  prepare: (sql) => {
    if (sql.includes('INSERT OR IGNORE INTO sessions')) {
      return {
        run: (sessionId, createdAt, updatedAt) => {
          if (!sessions.has(sessionId)) {
            sessions.set(sessionId, { id: sessionId, createdAt, updatedAt });
            saveData();
          }
        }
      };
    }
    
    if (sql.includes('INSERT INTO messages')) {
      return {
        run: async (sessionId, role, content, tokens, timestamp) => {
          const embedding = await getEmbedding(content);
          messages.push({
            id: messageIdCounter++,
            session_id: sessionId,
            role,
            content,
            tokens,
            timestamp,
            is_summarized: 0,
            embedding
          });
          saveData();
        }
      };
    }
    
    if (sql.includes('UPDATE sessions SET updated_at')) {
      return {
        run: (updatedAt, sessionId) => {
          const session = sessions.get(sessionId);
          if (session) {
            session.updatedAt = updatedAt;
            saveData();
          }
        }
      };
    }
    
    if (sql.includes('SELECT COUNT(*) as count FROM messages')) {
      return {
        get: (sessionId) => {
          const count = messages.filter(
            m => m.session_id === sessionId && m.is_summarized === 0
          ).length;
          return { count };
        }
      };
    }
    
    if (sql.includes('SELECT role, content FROM messages') && 
        sql.includes('ORDER BY timestamp DESC')) {
      return {
        all: (sessionId, limit) => {
          const filtered = messages
            .filter(m => m.session_id === sessionId && m.is_summarized === 0)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit)
            .map(m => ({ role: m.role, content: m.content }));
          return filtered;
        }
      };
    }
    
    if (sql.includes('SELECT summary FROM long_term_memory')) {
      return {
        all: (sessionId) => {
          return memories
            .filter(m => m.session_id === sessionId)
            .sort((a, b) => a.created_at - b.created_at)
            .map(m => ({ summary: m.summary }));
        }
      };
    }
    
    if (sql.includes('SELECT id, role, content FROM messages') && 
        sql.includes('is_summarized = 0')) {
      return {
        all: (sessionId) => {
          return messages
            .filter(m => m.session_id === sessionId && m.is_summarized === 0)
            .sort((a, b) => a.timestamp - b.timestamp)
            .map(m => ({ id: m.id, role: m.role, content: m.content }));
        }
      };
    }
    
    if (sql.includes('INSERT INTO long_term_memory')) {
      return {
        run: async (sessionId, summary, createdAt) => {
          const embedding = await getEmbedding(summary);
          memories.push({
            session_id: sessionId,
            summary,
            created_at: createdAt,
            embedding
          });
          saveData();
        }
      };
    }
    
    if (sql.includes('UPDATE messages SET is_summarized = 1')) {
      return {
        run: (id) => {
          const msg = messages.find(m => m.id === id);
          if (msg) {
            msg.is_summarized = 1;
            saveData();
          }
        }
      };
    }
    
    return { run: () => {}, get: () => null, all: () => [] };
  },
  
  transaction: (fn) => {
    return (params) => fn(params);
  }
};

// ========== 语义检索 ==========

async function semanticSearch(sessionId, query, limit = 5) {
  const queryEmbedding = await getEmbedding(query);
  
  const sessionMessages = messages.filter(m => m.session_id === sessionId);
  
  const results = sessionMessages.map(msg => ({
    content: msg.content,
    role: msg.role,
    similarity: cosineSimilarity(queryEmbedding, msg.embedding)
  }));
  
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

module.exports = { 
  initVectorDB, 
  db, 
  semanticSearch 
};