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
  try {
    _cache = JSON.parse(raw);
  } catch (parseErr) {
    // JSON 腐化（可能由 kill -9 / OOM killer 导致的不完整写入）
    // 尝试从备份恢复
    const bakFile = DB_FILE + '.bak';
    console.error(`[db] ⚠️ db.json corrupted: ${parseErr.message}`);
    if (fs.existsSync(bakFile)) {
      try {
        const bakRaw = fs.readFileSync(bakFile, 'utf8');
        _cache = JSON.parse(bakRaw);
        console.warn(`[db] ✅ recovered from backup (${bakFile}), some recent data may be lost`);
        // 用备份覆盖腐化的主文件
        fs.writeFileSync(DB_FILE, bakRaw);
      } catch (bakErr) {
        console.error(`[db] ❌ backup also corrupted: ${bakErr.message}`);
        throw new Error(`db.json and db.json.bak both corrupted. Manual recovery needed.`);
      }
    } else {
      throw new Error(`db.json corrupted and no backup found. Manual recovery needed.`);
    }
  }
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
    // 原子写入：write-rename 模式，防止 kill -9 / OOM killer 导致 JSON 腐化
    // POSIX rename 是原子操作：要么完整替换，要么不变
    const tmpFile = DB_FILE + '.tmp';
    fs.writeFileSync(tmpFile, json);
    fs.renameSync(tmpFile, DB_FILE);
    _dirty = false;
  } catch (err) {
    console.error('[db] flush error:', err.message);
    // 清理可能残留的 tmp 文件
    try { fs.unlinkSync(DB_FILE + '.tmp'); } catch {}
  }
}

// 安全网：即使防抖定时器出问题，也保证数据最终落盘
// 同时定期创建备份（每次安全网 flush 时）
setInterval(() => {
  if (_dirty) flushNow();
  // 定期备份：每次安全网触发时创建 .bak（约每 10s）
  if (_cache && fs.existsSync(DB_FILE)) {
    try {
      fs.copyFileSync(DB_FILE, DB_FILE + '.bak');
    } catch {}
  }
}, SAFETY_FLUSH_MS);

// 进程退出时同步落盘
process.on('exit', flushNow);
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => { flushNow(); process.exit(0); });
});

// ═══════════════════════════════════════════════════════════════
// Message Index: 两级 Map 索引 + 二分查找 since 过滤
//
// 热路径 GET /messages?since=xxx 原来对全量 messages 做 O(n) 线性扫描。
// 56 agent×space 组合 × 每秒 poll = 每秒 ~26 万次比较。
// 改为：按 space_id 和 space_id:session_id 建内存索引（按 timestamp 有序），
// since 查询用二分切片 O(log n) + updated_at 补偿扫描。
// ═══════════════════════════════════════════════════════════════

const _spaceIndex   = new Map();  // Map<space_id, Message[]> — 按 timestamp 升序
const _sessionIndex = new Map();  // Map<"space_id:session_id", Message[]> — 按 timestamp 升序

function _appendToIndex(msg) {
  // space 级索引
  const sk = msg.space_id;
  if (sk) {
    if (!_spaceIndex.has(sk)) _spaceIndex.set(sk, []);
    _spaceIndex.get(sk).push(msg);
  }
  // session 级索引
  if (sk && msg.session_id) {
    const key = `${sk}:${msg.session_id}`;
    if (!_sessionIndex.has(key)) _sessionIndex.set(key, []);
    _sessionIndex.get(key).push(msg);
  }
}

function _rebuildIndexes() {
  _spaceIndex.clear();
  _sessionIndex.clear();
  const msgs = (_cache && _cache.messages) || [];
  for (const msg of msgs) {
    _appendToIndex(msg);
  }
  console.log(`[db] indexes built: ${_spaceIndex.size} spaces, ${_sessionIndex.size} sessions, ${msgs.length} messages`);
}

/**
 * 二分查找：找到第一条 timestamp > sinceDate 的位置
 * msgs 必须按 timestamp 升序排列
 * 返回 index，使得 msgs[index..] 全部 timestamp > sinceDate
 */
function _bsearchSince(msgs, sinceDate) {
  let lo = 0, hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (msgs[mid].timestamp <= sinceDate) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 高效查询 messages by space_id [+ session_id] [+ since]
 * 替代 findAll('messages', ...) 的热路径
 */
function queryMessages(space_id, session_id, sinceDate) {
  // 选择索引
  let msgs;
  if (session_id) {
    msgs = _sessionIndex.get(`${space_id}:${session_id}`);
  } else {
    msgs = _spaceIndex.get(space_id);
  }
  if (!msgs || msgs.length === 0) return [];

  if (!sinceDate) return msgs.slice(); // 无 since，返回全部（浅拷贝）

  // 二分切片：timestamp > sinceDate 的部分
  const idx = _bsearchSince(msgs, sinceDate);
  const result = msgs.slice(idx);

  // 补偿扫描：timestamp <= sinceDate 但 updated_at > sinceDate 的消息
  // （streaming 完成的 human_job_response 等场景）
  // 只需回扫二分切点之前的部分，且这类消息极少，代价很小
  for (let i = idx - 1; i >= 0; i--) {
    const m = msgs[i];
    // 如果 timestamp 离 sinceDate 太远（>1小时），不可能有 updated_at 命中，停止
    // 这是一个合理的时间窗口上限，避免极端情况下扫全量
    if (sinceDate > m.timestamp && _isoTimeDiffMs(sinceDate, m.timestamp) > 3600000) break;
    if (m.updated_at && m.updated_at > sinceDate) {
      result.push(m);
    }
  }

  return result;
}

/** 估算两个 ISO string 时间差（毫秒），用于补偿扫描剪枝 */
function _isoTimeDiffMs(a, b) {
  // 快速路径：直接 Date.parse，V8 对 ISO string 做了优化
  return Date.parse(a) - Date.parse(b);
}

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

    // 迁移：添加 agent_overrides 集合（Space 级 Agent 身份重载）
    if (!_cache.agent_overrides) {
      _cache.agent_overrides = [];
      needsSave = true;
      console.log('✅ Added agent_overrides collection');
    }

    if (needsSave) {
      flushNow(); // 迁移后立即落盘
    }

    const sizeMB = (Buffer.byteLength(JSON.stringify(_cache)) / 1024 / 1024).toFixed(1);
    console.log(`[db] cache initialized: ${sizeMB}MB, ${(_cache.messages || []).length} messages, ${(_cache.agents || []).length} agents`);
  }

  // 初始化完成后构建消息索引
  _rebuildIndexes();
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
    _rebuildIndexes(); // 全量替换后重建索引
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
    // 维护消息索引
    if (collection === 'messages') {
      _appendToIndex(item);
    }
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
    // 删除消息后重建索引（delete 很少发生，重建代价可接受）
    if (collection === 'messages') {
      _rebuildIndexes();
    }
    scheduleDiskFlush();
  },

  // 手动强制落盘（需要持久性保证时调用）
  flush: flushNow,

  // 消息索引查询（替代热路径的 findAll + filter）
  // 返回 Message[]，sinceDate 为 ISO string 或 null
  queryMessages,

  // 重建消息索引（外部需要时调用，如批量修改消息后）
  rebuildMessageIndexes: _rebuildIndexes,
};

initDB();

module.exports = db;
