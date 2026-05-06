const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 使用环境变量 DATABASE_URL 来连接 Render 提供的 PostgreSQL 数据库
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Render 要求启用 SSL
  }
});

// 初始化数据库表结构 (在应用启动时运行)
const initDb = async () => {
  const client = await pool.connect();
  try {
    // 创建词条表
    await client.query(`
      CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 创建版本表
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        version INTEGER DEFAULT 0,
        last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // 初始化版本号
    await client.query(`
      INSERT INTO sync_meta (key, version) VALUES ('entries_version', 0)
      ON CONFLICT (key) DO NOTHING
    `);
    console.log("✅ 数据库初始化成功");
  } catch (err) {
    console.error("❌ 数据库初始化失败:", err);
  } finally {
    client.release();
  }
};

initDb();

// 获取所有词条（按分类返回）
app.get('/api/entries', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, text, category FROM entries ORDER BY category, id ASC');
    const rows = result.rows;
    
    // 按分类整理数据
    const categorized = {
      costume: [],
      action: [],
      place: []
    };
    
    rows.forEach(row => {
      if (categorized[row.category]) {
        categorized[row.category].push({ id: row.id, text: row.text });
      }
    });
    
    const versionRes = await pool.query(`SELECT version FROM sync_meta WHERE key = 'entries_version'`);
    const version = versionRes.rows[0]?.version || 0;
    
    res.json({
      categories: categorized,
      version: version
    });
  } catch (err) {
    console.error('获取词条失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 添加词条
app.post('/api/entries', async (req, res) => {
  const { text, category } = req.body;
  
  if (!text || text.trim() === '') {
    res.status(400).json({ error: '词条内容不能为空' });
    return;
  }
  if (!category || !['costume', 'action', 'place'].includes(category)) {
    res.status(400).json({ error: '请选择有效的分区 (costume/action/place)' });
    return;
  }
  
  try {
    const result = await pool.query(
      'INSERT INTO entries (text, category) VALUES ($1, $2) RETURNING id',
      [text.trim(), category]
    );
    
    // 更新版本号
    await pool.query(`UPDATE sync_meta SET version = version + 1, last_modified = CURRENT_TIMESTAMP WHERE key = 'entries_version'`);
    
    res.json({
      id: result.rows[0].id,
      text: text.trim(),
      category: category,
      message: '添加成功'
    });
  } catch (err) {
    console.error('添加词条失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 编辑词条
app.put('/api/entries/:id', async (req, res) => {
  const { id } = req.params;
  const { text, category } = req.body;
  
  if (!text || text.trim() === '') {
    res.status(400).json({ error: '词条内容不能为空' });
    return;
  }
  
  try {
    let result;
    if (category && ['costume', 'action', 'place'].includes(category)) {
      result = await pool.query(
        'UPDATE entries SET text = $1, category = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [text.trim(), category, id]
      );
    } else {
      result = await pool.query(
        'UPDATE entries SET text = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [text.trim(), id]
      );
    }
    
    if (result.rowCount === 0) {
      res.status(404).json({ error: '词条不存在' });
      return;
    }
    
    await pool.query(`UPDATE sync_meta SET version = version + 1, last_modified = CURRENT_TIMESTAMP WHERE key = 'entries_version'`);
    res.json({ message: '更新成功' });
  } catch (err) {
    console.error('编辑词条失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 删除词条
app.delete('/api/entries/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query('DELETE FROM entries WHERE id = $1', [id]);
    
    if (result.rowCount === 0) {
      res.status(404).json({ error: '词条不存在' });
      return;
    }
    
    await pool.query(`UPDATE sync_meta SET version = version + 1, last_modified = CURRENT_TIMESTAMP WHERE key = 'entries_version'`);
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('删除词条失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 批量同步接口
app.post('/api/entries/sync', async (req, res) => {
  const { clientVersion } = req.body;
  
  try {
    const versionRes = await pool.query(`SELECT version FROM sync_meta WHERE key = 'entries_version'`);
    const serverVersion = versionRes.rows[0]?.version || 0;
    
    if (clientVersion === serverVersion) {
      res.json({ needSync: false, version: serverVersion });
    } else {
      const result = await pool.query('SELECT id, text, category FROM entries ORDER BY category, id ASC');
      const rows = result.rows;
      
      const categorized = { costume: [], action: [], place: [] };
      rows.forEach(row => {
        if (categorized[row.category]) {
          categorized[row.category].push({ id: row.id, text: row.text });
        }
      });
      
      res.json({
        needSync: true,
        version: serverVersion,
        categories: categorized
      });
    }
  } catch (err) {
    console.error('同步失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
  console.log(`📱 在同一WiFi下，其他设备可通过 http://<本机IP>:${PORT} 访问`);
  console.log(`📂 三分区奖池已就绪: costume(扮成) / action(这样做) / place(在这里)`);
  console.log(`🔗 生产环境请确保设置了 DATABASE_URL 环境变量`);
});