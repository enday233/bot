// 内存存储（重启后数据会丢失，但无需任何依赖）

const sessions = new Map();
const messages = [];
const longTermMemory = [];
let messageIdCounter = 1;

module.exports = {
  prepare: (sql) => {
    // 模拟 SQLite 的 prepare 接口
    
    if (sql.includes('INSERT OR IGNORE INTO sessions')) {
      return {
        run: (sessionId, createdAt, updatedAt) => {
          if (!sessions.has(sessionId)) {
            sessions.set(sessionId, { id: sessionId, createdAt, updatedAt });
          }
        }
      };
    }
    
    if (sql.includes('INSERT INTO messages')) {
      return {
        run: (sessionId, role, content, tokens, timestamp) => {
          messages.push({
            id: messageIdCounter++,
            session_id: sessionId,
            role,
            content,
            tokens,
            timestamp,
            is_summarized: 0
          });
        }
      };
    }
    
    if (sql.includes('UPDATE sessions SET updated_at')) {
      return {
        run: (updatedAt, sessionId) => {
          const session = sessions.get(sessionId);
          if (session) session.updatedAt = updatedAt;
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
    
    if (sql.includes('SELECT role, content FROM messages') && sql.includes('ORDER BY timestamp DESC')) {
      return {
        all: (sessionId, limit) => {
          const filtered = messages
            .filter(m => m.session_id === sessionId && m.is_summarized === 0)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
          return filtered;
        }
      };
    }
    
    if (sql.includes('SELECT summary FROM long_term_memory')) {
      return {
        all: (sessionId) => {
          return longTermMemory
            .filter(m => m.session_id === sessionId)
            .sort((a, b) => a.created_at - b.created_at);
        }
      };
    }
    
    if (sql.includes('SELECT id, role, content FROM messages') && sql.includes('is_summarized = 0')) {
      return {
        all: (sessionId) => {
          return messages
            .filter(m => m.session_id === sessionId && m.is_summarized === 0)
            .sort((a, b) => a.timestamp - b.timestamp);
        }
      };
    }
    
    if (sql.includes('INSERT INTO long_term_memory')) {
      return {
        run: (sessionId, summary, createdAt) => {
          longTermMemory.push({
            session_id: sessionId,
            summary,
            created_at: createdAt
          });
        }
      };
    }
    
    if (sql.includes('UPDATE messages SET is_summarized = 1')) {
      return {
        run: (id) => {
          const msg = messages.find(m => m.id === id);
          if (msg) msg.is_summarized = 1;
        }
      };
    }
    
    return { run: () => {}, get: () => null, all: () => [] };
  },
  
  transaction: (fn) => {
    return (params) => fn(params);
  }
};