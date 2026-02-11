const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { initVectorDB, db, semanticSearch } = require('./vector-storage'); // ← 修改这里
const config = require('./config');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== 核心函数 ==========

function estimateTokens(text) {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function ensureSession(sessionId) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, created_at, updated_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(sessionId, now, now);
}

async function saveMessage(sessionId, role, content) {
  const now = Date.now();
  const tokens = estimateTokens(content);
  
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, role, content, tokens, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  await stmt.run(sessionId, role, content, tokens, now);
  
  const updateStmt = db.prepare(`
    UPDATE sessions SET updated_at = ? WHERE id = ?
  `);
  updateStmt.run(now, sessionId);
}

function getMessageCount(sessionId) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM messages 
    WHERE session_id = ? AND is_summarized = 0
  `);
  const result = stmt.get(sessionId);
  return result.count;
}

function getRecentHistory(sessionId, limit) {
  const stmt = db.prepare(`
    SELECT role, content FROM messages
    WHERE session_id = ? AND is_summarized = 0
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const results = stmt.all(sessionId, limit);
  return results.reverse();
}

function getLongTermMemory(sessionId) {
  const stmt = db.prepare(`
    SELECT summary FROM long_term_memory
    WHERE session_id = ?
    ORDER BY created_at ASC
  `);
  return stmt.all(sessionId);
}

async function callAPI(messages) {
  const response = await fetch(config.BOHE_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.BOHE_API_KEY}`
    },
    body: JSON.stringify({
      model: config.MODEL,
      messages: messages,
      max_tokens: 800,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 调用失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('API 返回格式异常: ' + JSON.stringify(data));
}

async function generateSummary(sessionId) {
  const stmt = db.prepare(`
    SELECT id, role, content FROM messages
    WHERE session_id = ? AND is_summarized = 0
    ORDER BY timestamp ASC
  `);
  const unsummarized = stmt.all(sessionId);
  
  if (unsummarized.length < 5) return;
  
  const conversationText = unsummarized
    .map(msg => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`)
    .join('\n');
  
  const summaryMessages = [
    {
      role: 'system',
      content: '你是一个对话摘要助手。请将对话内容压缩为简洁的摘要，保留关键信息。'
    },
    {
      role: 'user',
      content: `请总结以下对话，提取：\n1. 用户的基本信息（姓名、偏好、个人情况等）\n2. 讨论的主要话题\n3. 重要的决定或结论\n\n对话内容：\n${conversationText}\n\n请用简洁的中文总结：`
    }
  ];
  
  try {
    const summary = await callAPI(summaryMessages);
    
    const insertStmt = db.prepare(`
      INSERT INTO long_term_memory (session_id, summary, created_at)
      VALUES (?, ?, ?)
    `);
    await insertStmt.run(sessionId, summary, Date.now());
    
    const updateStmt = db.prepare(`
      UPDATE messages SET is_summarized = 1 WHERE id = ?
    `);
    const update = db.transaction((ids) => {
      for (const id of ids) {
        updateStmt.run(id);
      }
    });
    update(unsummarized.map(m => m.id));
    
    console.log(`✅ 已压缩 ${unsummarized.length} 条消息`);
  } catch (error) {
    console.error('❌ 生成摘要失败:', error);
  }
}

function buildContext(sessionId) {
  const messages = [];
  
  messages.push({
    role: 'system',
    content: '你是一个友好、有记忆的助手。你能记住之前的对话内容，并根据历史信息提供连贯的回复。'
  });
  
  const longTermMemory = getLongTermMemory(sessionId);
  if (longTermMemory.length > 0) {
    const summaryText = longTermMemory.map(m => m.summary).join('\n\n');
    messages.push({
      role: 'system',
      content: `以下是之前对话的摘要信息：\n${summaryText}`
    });
  }
  
  const shortTermHistory = getRecentHistory(
    sessionId, 
    config.MAX_SHORT_TERM_ROUNDS * 2
  );
  
  messages.push(...shortTermHistory.map(msg => ({
    role: msg.role,
    content: msg.content
  })));
  
  return messages;
}

// ========== API 路由 ==========

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;
    
    ensureSession(sessionId);
    await saveMessage(sessionId, 'user', message);
    
    const messageCount = getMessageCount(sessionId);
    if (messageCount > 0 && messageCount % config.SUMMARY_TRIGGER_ROUNDS === 0) {
      await generateSummary(sessionId);
    }
    
    const context = buildContext(sessionId);
    const aiResponse = await callAPI(context);
    await saveMessage(sessionId, 'assistant', aiResponse);
    
    const longTermCount = getLongTermMemory(sessionId).length;
    const shortTermRounds = Math.floor((context.length - 1 - (longTermCount > 0 ? 1 : 0)) / 2);
    
    res.json({
      reply: aiResponse,
      debug: {
        totalMessages: messageCount + 1,
        model: config.MODEL,
        contextLayers: {
          longTermMemory: longTermCount,
          shortTermRounds: shortTermRounds
        }
      }
    });
    
  } catch (error) {
    console.error('处理请求出错:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// 语义检索 API
app.post('/api/search', async (req, res) => {
  try {
    const { query, sessionId = 'default', limit = 5 } = req.body;
    const results = await semanticSearch(sessionId, query, limit);
    res.json({ results });
  } catch (error) {
    console.error('搜索出错:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== 启动服务器 ==========

async function start() {
  await initVectorDB(); // ← 修改这里
  
  app.listen(config.PORT, config.HOST, () => {
    console.log(`
╔════════════════════════════════════════╗
║  🧠 记忆聊天机器人 (向量存储)           ║
║                                        ║
║  服务器运行在:                          ║
║  http://${config.HOST}:${config.PORT}           ║
║                                        ║
║  🔍 支持语义检索                        ║
║  💾 数据保存在 vector_data/             ║
║  按 Ctrl+C 停止服务器                   ║
╚════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);