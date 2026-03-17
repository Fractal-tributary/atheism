const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════
// In-memory cache: load once, serve from RAM, debounced write-back
//
// 原来每次 readDB/writeDB 都全量读写 4.4MB JSON 文件。
// 56 agent×space 组合 × 6 次 db 读/次 = 每秒 ~336 次文件读。
// 改为：启动时加载到内存，所有读操作零 I/O，写操作防抖合并。
// 预期效果：每次 poll 延迟从 ~334ms 降到 <5ms（67x 提升）。
// ═══════════════════════════════════════════════════════════════

let _cache = null;       // 内存中的完整 db 对象
let _dirty = false;      // 是否有未落盘的修改
let _flushTimer = null;  // 防抖定时器
const FLUSH_DELAY_MS = 500;        // 写入防抖：500ms
const SAFETY_FLUSH_MS = 10_000;    // 安全网：每 10s 强制落盘一次

function ensureCache() {
  if (_cache) return _cache;
  if (!fs.existsSync(DB_FILE)) return null;
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  _cache = JSON.parse(raw);
  console.log(`[db] loaded ${(Buffer.byteLength(raw) / 1024 / 1024).toFixed(1)}MB into memory cache`);
  return _cache;
}

function scheduleDiskFlush() {
  _dirty = true;
  if (_flushTimer) return; // 已有定时器在跑
  _flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
}

function flushNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_dirty || !_cache) return;
  try {
    const json = JSON.stringify(_cache, null, 2);
    fs.writeFileSync(DB_FILE, json);
    _dirty = false;
  } catch (err) {
    console.error('[db] flush error:', err.message);
  }
}

// 安全网：即使防抖定时器出问题，也保证数据最终落盘
setInterval(() => {
  if (_dirty) flushNow();
}, SAFETY_FLUSH_MS);

// 进程退出时同步落盘
process.on('exit', flushNow);
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => { flushNow(); process.exit(0); });
});

// ═══════════════════════════════════════════════════════════════
// 初始化 / 迁移（逻辑与原版完全一致，只是操作内存而非磁盘）
// ═══════════════════════════════════════════════════════════════

const initDB = () => {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      spaces: [
        {
          space_id: 'default',
          name: 'Default Space',
          description: 'Default collaboration space',
          created_at: new Date().toISOString()
        }
      ],
      sessions: [
        {
          session_id: 'session_default',
          space_id: 'default',
          title: 'Default Session',
          created_at: new Date().toISOString(),
          created_by: 'system',
          status: 'active'
        }
      ],
      agents: [
        {
          agent_id: 'agent_demo_01',
          space_id: 'default',
          name: 'Demo Agent 1',
          capabilities: ['coding', 'research'],
          status: 'online',
          last_heartbeat: new Date().toISOString(),
          joined_at: new Date().toISOString()
        }
      ],
      messages: [],
      skills: [
        {
          skill_id: 'skill_demo_01',
          space_id: 'default',
          name: 'web-search',
          version: '1.0.0',
          description: 'Web search capability',
          skill_md: '# Web Search\n\nSearch the web for information.',
          metadata: { author: 'agent_demo_01' },
          fitness_score: 0.87,
          usage_count: 42,
          status: 'active',
          author: 'agent_demo_01',
          created_at: new Date().toISOString()
        }
      ],
      skill_usage: [],
      eval_locks: []
    };

    _cache = initialData;
    flushNow(); // 初始化立即落盘
    console.log('✅ Database initialized with sessions support');
  } else {
    // 加载到内存
    _cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    let needsSave = false;

    if (!_cache.eval_locks) {
      _cache.eval_locks = [];
      needsSave = true;
      console.log('✅ Added eval_locks collection to existing database');
    }

    if (!_cache.sessions) {
      _cache.sessions = [
        {
          session_id: 'session_default',
          space_id: (_cache.spaces && _cache.spaces[0]?.space_id) || 'default',
          title: 'Default Session',
          created_at: new Date().toISOString(),
          created_by: 'system',
          status: 'active'
        }
      ];
      needsSave = true;
      console.log('✅ Added sessions collection to existing database');
    }

    // 迁移现有消息：添加 session_id
    if (_cache.messages && _cache.messages.length > 0) {
      let migratedCount = 0;
      _cache.messages = _cache.messages.map(msg => {
        if (!msg.session_id) {
          migratedCount++;
          return { ...msg, session_id: 'session_default' };
        }
        return msg;
      });
      if (migratedCount > 0) {
        needsSave = true;
        console.log(`✅ Migrated ${migratedCount} messages to default session`);
      }
    }

    // 迁移：添加 space_members 集合
    if (!_cache.space_members) {
      _cache.space_members = [];
      needsSave = true;
      console.log('✅ Added space_members collection');
    }

    // 迁移：添加 skill_packs 集合（全局 Skill 包）
    if (!_cache.skill_packs) {
      _cache.skill_packs = [];
      needsSave = true;
      console.log('✅ Added skill_packs collection');
    }

    if (needsSave) {
      flushNow(); // 迁移后立即落盘
    }

    const sizeMB = (Buffer.byteLength(JSON.stringify(_cache)) / 1024 / 1024).toFixed(1);
    console.log(`[db] cache initialized: ${sizeMB}MB, ${(_cache.messages || []).length} messages, ${(_cache.agents || []).length} agents`);
  }
};

// ═══════════════════════════════════════════════════════════════
// Public API（签名与原版完全一致，无需改 server.js）
// ═══════════════════════════════════════════════════════════════

const db = {
  // 返回内存中的完整 db 对象（引用，非拷贝）
  get: () => ensureCache(),

  // 替换整个 db 对象并调度落盘
  save: (data) => {
    _cache = data;
    scheduleDiskFlush();
  },

  findOne: (collection, predicate) => {
    const data = ensureCache();
    return data[collection]?.find(predicate);
  },

  findAll: (collection, predicate = () => true) => {
    const data = ensureCache();
    return (data[collection] || []).filter(predicate);
  },

  insert: (collection, item) => {
    const data = ensureCache();
    if (!data[collection]) {
      data[collection] = [];
    }
    data[collection].push(item);
    scheduleDiskFlush();
    return item;
  },

  update: (collection, predicate, updates) => {
    const data = ensureCache();
    if (!data[collection]) return null;
    const index = data[collection].findIndex(predicate);
    if (index !== -1) {
      data[collection][index] = { ...data[collection][index], ...updates };
      scheduleDiskFlush();
      return data[collection][index];
    }
    return null;
  },

  delete: (collection, predicate) => {
    const data = ensureCache();
    if (!data[collection]) return;
    data[collection] = data[collection].filter(item => !predicate(item));
    scheduleDiskFlush();
  },

  // 手动强制落盘（需要持久性保证时调用）
  flush: flushNow,
};

initDB();

module.exports = db;
