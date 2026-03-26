// --- Top-level crash handlers (must be first) ---
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] uncaughtException at ${new Date().toISOString()}:`, err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] unhandledRejection at ${new Date().toISOString()}:`, reason);
});

const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const db = require('./db');
const fs = require('fs');
const pathMod = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // 监听所有网络接口
const FILES_DIR = pathMod.join(__dirname, 'data', 'files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// 中间件
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// JSON 解析错误处理（express.json SyntaxError 兜底）
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.warn(`⚠️ [JSON Parse Error] ${req.method} ${req.originalUrl} — ${err.message}`);
    return res.status(400).json({ error: 'Invalid JSON in request body', detail: err.message });
  }
  next(err);
});

// 添加 ngrok 绕过头部
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// ==================== API Timing Middleware ====================
// 记录每个 API 请求的耗时和 payload 大小，慢请求 warn 级别输出
const _timingStats = { requests: 0, slowRequests: 0, totalMs: 0, maxMs: 0, maxRoute: '' };
const _endpointStats = new Map(); // route → { count, totalMs, maxMs, totalBytes }

app.use('/api', (req, res, next) => {
  const start = process.hrtime.bigint();
  const origJson = res.json.bind(res);
  
  res.json = function(body) {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const bodyStr = JSON.stringify(body);
    const payloadBytes = bodyStr ? bodyStr.length : 0;
    const route = `${req.method} ${req.route?.path || req.path}`;
    
    // 更新全局统计
    _timingStats.requests++;
    _timingStats.totalMs += elapsedMs;
    if (elapsedMs > _timingStats.maxMs) {
      _timingStats.maxMs = elapsedMs;
      _timingStats.maxRoute = route;
    }
    
    // 更新端点统计
    let ep = _endpointStats.get(route);
    if (!ep) {
      ep = { count: 0, totalMs: 0, maxMs: 0, totalBytes: 0 };
      _endpointStats.set(route, ep);
    }
    ep.count++;
    ep.totalMs += elapsedMs;
    if (elapsedMs > ep.maxMs) ep.maxMs = elapsedMs;
    ep.totalBytes += payloadBytes;
    
    // 慢请求 or 大 payload 警告
    if (elapsedMs > 50 || payloadBytes > 50000) {
      console.warn(`⏱️ SLOW/LARGE ${route} — ${elapsedMs.toFixed(1)}ms, ${(payloadBytes / 1024).toFixed(1)}KB` +
        (req.query.agent_id ? ` [${req.query.agent_id}]` : '') +
        (req.query.session_id ? ` sess:${req.query.session_id.slice(0, 12)}` : ''));
    }
    
    return origJson(body);
  };
  
  next();
});

// 暴露 timing 统计端点
app.get('/api/debug/timing', (req, res) => {
  const endpoints = [];
  for (const [route, stats] of _endpointStats) {
    endpoints.push({
      route,
      count: stats.count,
      avgMs: stats.count ? (stats.totalMs / stats.count).toFixed(1) : 0,
      maxMs: stats.maxMs.toFixed(1),
      avgPayloadKB: stats.count ? (stats.totalBytes / stats.count / 1024).toFixed(1) : 0,
      totalPayloadMB: (stats.totalBytes / 1024 / 1024).toFixed(2),
    });
  }
  endpoints.sort((a, b) => b.count - a.count);
  
  res.json({
    uptime_minutes: (process.uptime() / 60).toFixed(1),
    total_requests: _timingStats.requests,
    avg_ms: _timingStats.requests ? (_timingStats.totalMs / _timingStats.requests).toFixed(1) : 0,
    max_ms: _timingStats.maxMs.toFixed(1),
    max_route: _timingStats.maxRoute,
    endpoints,
  });
});

// 重置 timing 统计
app.post('/api/debug/timing/reset', (req, res) => {
  _timingStats.requests = 0;
  _timingStats.slowRequests = 0;
  _timingStats.totalMs = 0;
  _timingStats.maxMs = 0;
  _timingStats.maxRoute = '';
  _endpointStats.clear();
  res.json({ success: true, message: 'Timing stats reset' });
});

app.use(express.static('public', { 
  etag: false,
  maxAge: 0,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ==================== Session Quiesce (静默状态追踪) ====================
//
// 设计意图：当一个 session 中所有在线 Agent 都回复了 NO_REPLY，session 进入静默模式。
// 静默模式下 completion signal 被过滤（不触发新一轮评估），防止 NO_REPLY 无限循环。
// 人类消息 或 Agent 实质回复（非 NO_REPLY）会重置状态。
//
// 数据流：
// Agent NO_REPLY → addNoReply() → 检查全员 NO_REPLY → quiesced=true
// 人类新消息 → resetQuiesce() → quiesced=false → 新一轮开始
//
// 注意：addNoReply 使用 queryMessages (索引查询) 而非 findAll (全表扫描)

const sessionQuiesce = new Map(); // key: `${space_id}:${session_id}` → { no_reply_agents: Set<string>, quiesced: boolean }
// 🆕 Track sessions that have already had a summary requested (survives resetQuiesce)
// Cleared only by human message (new task) via resetSummaryRequested()
const summaryRequested = new Map(); // key: `${space_id}:${session_id}` → true

// ⏹ Interrupt poison pill: block new eval lock acquisitions until next human message
// Fix 2a: Changed from time-based (10s) to event-based (next human message).
// The old 10s cooldown was too short — stale .finally() PATCHes could reset quiesce after cooldown.
// Now the poison pill persists until a human explicitly sends a new message (resetQuiesce path).
const INTERRUPT_COOLDOWN = 300_000; // 5 minutes max safety fallback (previously 10s)
const EVAL_LOCK_TIMEOUT = 60000; // 60s — must match claim endpoint's LOCK_TIMEOUT
const sessionInterruptedAt = new Map(); // key: `${space_id}:${session_id}` → timestamp

function resetQuiesce(space_id, session_id, isHumanMessage = false) {
  const key = `${space_id}:${session_id}`;
  const prev = sessionQuiesce.get(key);
  if (prev?.quiesced) {
    console.log(`🔔 Session ${session_id} un-quiesced (new substantive content)`);
  }
  sessionQuiesce.delete(key);
  if (isHumanMessage) {
    summaryRequested.delete(key); // 🆕 Only human message (new task) resets summary flag
  }
  sessionInterruptedAt.delete(key); // 清除毒丸，允许新一轮 eval lock
  db.delete('session_quiesce', r => r.space_id === space_id && r.session_id === session_id);
}

function addNoReply(space_id, session_id, agent_id) {
  const key = `${space_id}:${session_id}`;
  let state = sessionQuiesce.get(key);
  if (!state) {
    state = { no_reply_agents: new Set(), quiesced: false };
    sessionQuiesce.set(key, state);
  }
  state.no_reply_agents.add(agent_id);

  // 检查是否所有 session 活跃参与者都 NO_REPLY 了
  // 「活跃参与者」= 最后一条人类消息之后，发过消息（含 NO_REPLY）的 agent
  // 这样未参与 session 的在线 agent 不会阻止 quiesce
  // 使用索引查询替代 findAll 全表扫描
  const sessionMsgs = db.queryMessages(space_id, session_id, null);
  sessionMsgs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const activeAgents = new Set();
  for (const m of sessionMsgs) {
    if (m.from_agent === 'human') break;
    if (m.from_agent && m.from_agent !== 'human') activeAgents.add(m.from_agent);
  }

  if (activeAgents.size === 0) return state;

  const allNoReply = [...activeAgents].every(id => state.no_reply_agents.has(id));
  if (allNoReply && activeAgents.size > 0) {
    state.quiesced = true;
    console.log(`🔇 Session ${session_id} quiesced (all ${activeAgents.size} active agents NO_REPLY'd: [${[...activeAgents].join(', ')}])`);
    // 持久化到 DB
    const qRec = db.findOne('session_quiesce', r => r.space_id === space_id && r.session_id === session_id);
    if (qRec) {
      db.update('session_quiesce', r => r.space_id === space_id && r.session_id === session_id,
        { no_reply_agents: [...state.no_reply_agents], updated_at: Date.now() });
    } else {
      db.insert('session_quiesce', { space_id, session_id, no_reply_agents: [...state.no_reply_agents], updated_at: Date.now() });
    }

    // 🆕 Summary Hook: trigger summary request on quiesce
    // Path 1: L3 task with explicit reporter (via task-meta API)
    // Path 2: Fallback — ≥3 agents responded substantively, pick last speaker as reporter
    //
    // 防循环机制: summaryRequested.has(key) 确保每轮只触发一次。
    // 当 reporter 发出 summary 后，其他 agent NO_REPLY → 二次 quiesce →
    // 再次进入此检查 → summaryRequested 已为 true → 跳过 → 循环终止。
    // summaryRequested 仅在人类发新消息时清除 (resetQuiesce isHumanMessage=true)。
    if (!summaryRequested.has(key)) {
      const taskMeta = db.findOne('session_task_meta', m =>
        m.space_id === space_id && m.session_id === session_id
      );
      let reporter = null;
      let triggerSource = '';

      if (taskMeta?.level === 'L3' && taskMeta.reporter) {
        reporter = taskMeta.reporter;
        triggerSource = 'task-meta';
      } else if (!taskMeta || taskMeta?.level !== 'L1') {
        // Fallback: check round responders — if ≥3 agents contributed, auto-trigger summary
        const roundKey = `${space_id}:${session_id}`;
        const round = roundResponders.get(roundKey);
        if (round && round.responders.length >= 3) {
          // Pick the last substantive responder as fallback reporter
          const sorted = [...round.responders].sort((a, b) => b.responded_at - a.responded_at);
          reporter = sorted[0].agent_id;
          triggerSource = 'fallback (last speaker of ' + round.responders.length + ' responders)';
        }
      }

      if (reporter) {
        summaryRequested.set(key, true);
        console.log(`📋 Summary request triggered [${triggerSource}]: ${reporter} for session ${session_id}`);
        broadcastToSpace(space_id, {
          type: 'summary_request',
          space_id,
          session_id,
          reporter,
        });
      }
    }
  }

  return state;
}

function isSessionQuiesced(space_id, session_id) {
  const state = sessionQuiesce.get(`${space_id}:${session_id}`);
  return state?.quiesced || false;
}

// ==================== Round Responders 追踪 + 限流 ====================
// 每轮人类消息后，追踪所有做出实质回复（非 NO_REPLY）的 Agent。
// 支持两级限流：soft limit（注入强约束提示）+ hard limit（拒绝 eval）。
// 被 @mention 的 agent 不受 soft limit 限制，仅受 hard limit 约束。
// 人类发新消息时清除（新一轮开始）。

const ROUND_RESPONDER_SOFT_LIMIT = 3;  // 超过后注入强约束 system message
const ROUND_RESPONDER_HARD_LIMIT = 5;  // 绝对拒绝 eval

const roundResponders = new Map(); // key: `${space_id}:${session_id}` → { responders: [{agent_id, agent_name, responded_at}], trigger_message_id }

function addRoundResponder(space_id, session_id, agent_id, agent_name, triggerMsgId) {
  const key = `${space_id}:${session_id}`;
  let record = roundResponders.get(key);
  if (!record) {
    record = { responders: [], trigger_message_id: triggerMsgId || null };
    roundResponders.set(key, record);
  }
  // 避免重复
  if (!record.responders.find(r => r.agent_id === agent_id)) {
    record.responders.push({ agent_id, agent_name: agent_name || agent_id, responded_at: Date.now() });
    console.log(`🏁 Round responder #${record.responders.length}: ${agent_id} (session: ${session_id})`);
  }
}

function clearRoundResponders(space_id, session_id) {
  const key = `${space_id}:${session_id}`;
  if (roundResponders.has(key)) {
    roundResponders.delete(key);
    console.log(`🏁 Round responders cleared (session: ${session_id})`);
  }
}

function getRoundResponders(space_id, session_id) {
  return roundResponders.get(`${space_id}:${session_id}`) || null;
}

/** 获取当前轮的 responders 数量 */
function getRoundRespondersCount(space_id, session_id) {
  const record = roundResponders.get(`${space_id}:${session_id}`);
  return record ? record.responders.length : 0;
}

/** 兼容旧 API：返回 first_responder 格式（第一个 responder） */
function getFirstResponder(space_id, session_id) {
  const record = roundResponders.get(`${space_id}:${session_id}`);
  if (!record || record.responders.length === 0) return null;
  return record.responders[0];
}

/**
 * 获取 Space 的限流配置（支持 space 级别自定义）
 * space 对象可以有 responder_soft_limit / responder_hard_limit 字段
 */
function getResponderLimits(space_id) {
  const space = db.findOne('spaces', s => s.space_id === space_id);
  return {
    soft: space?.responder_soft_limit ?? ROUND_RESPONDER_SOFT_LIMIT,
    hard: space?.responder_hard_limit ?? ROUND_RESPONDER_HARD_LIMIT,
  };
}

/**
 * 检查 agent 是否在本轮触发消息中被 @mention
 */
function isAgentMentionedInTrigger(space_id, session_id, agent_id) {
  const record = roundResponders.get(`${space_id}:${session_id}`);
  if (!record || !record.trigger_message_id) return false;
  
  const triggerMsg = db.findOne('messages', m =>
    m.message_id === record.trigger_message_id && m.space_id === space_id
  );
  if (!triggerMsg) return false;
  
  const text = triggerMsg.content?.job || triggerMsg.content?.message || '';
  if (!text) return false;
  
  const shortId = agent_id.replace(/^agent_/, '');
  // 查找该 agent 的 display name
  const agentRecord = db.findOne('agents', a => a.agent_id === agent_id && a.space_id === space_id);
  const agentName = agentRecord?.name || '';
  
  // 检查 @shortId 或 @name
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (shortId) {
    const boundary = /[a-zA-Z0-9]$/.test(shortId) ? '\\b' : '';
    if (new RegExp(`@${escapeRegex(shortId)}${boundary}`, 'i').test(text)) return true;
  }
  if (agentName) {
    const boundary = /[a-zA-Z0-9]$/.test(agentName) ? '\\b' : '';
    if (new RegExp(`@${escapeRegex(agentName)}${boundary}`, 'i').test(text)) return true;
  }
  return false;
}

/**
 * 评估限流状态：返回 { allowed, level, responders_count, limits }
 * level: 'normal' | 'soft_limited' | 'hard_limited'
 */
function checkRoundResponseLimit(space_id, session_id, agent_id) {
  const count = getRoundRespondersCount(space_id, session_id);
  const limits = getResponderLimits(space_id);
  const isMentioned = isAgentMentionedInTrigger(space_id, session_id, agent_id);
  
  // Hard limit: 任何人都不能超过
  if (count >= limits.hard) {
    console.log(`🚫 Round response HARD LIMIT: ${agent_id} denied (${count}/${limits.hard} responders, session: ${session_id})`);
    return { allowed: false, level: 'hard_limited', responders_count: count, limits, is_mentioned: isMentioned };
  }
  
  // Soft limit: 被 @mention 的 agent 豁免
  if (count >= limits.soft && !isMentioned) {
    console.log(`⚠️ Round response SOFT LIMIT: ${agent_id} warned (${count}/${limits.soft} responders, session: ${session_id})`);
    return { allowed: true, level: 'soft_limited', responders_count: count, limits, is_mentioned: isMentioned };
  }
  
  return { allowed: true, level: 'normal', responders_count: count, limits, is_mentioned: isMentioned };
}

// ==================== 轮次兜底：Agent 消息距人类消息超过 N 轮则强制停止 ====================
const MAX_AGENT_ROUNDS_SINCE_HUMAN = 16; // 2× max 8 agents — prevents runaway cascades

function countAgentRoundsSinceHuman(space_id, session_id) {
  // 使用索引查询替代 findAll 全表扫描（O(索引大小) vs O(全部消息)）
  const sessionMsgs = db.queryMessages(space_id, session_id, null);
  // 按时间倒序
  sessionMsgs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  let agentCount = 0;
  for (const m of sessionMsgs) {
    if (m.from_agent === 'human') break;
    agentCount++;
  }
  return agentCount;
}


// 定期清理已静默的 session 条目（防止内存泄漏），每小时一次
setInterval(() => {
  let cleaned = 0;
  for (const [key, state] of sessionQuiesce) {
    if (state.quiesced) {
      sessionQuiesce.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} quiesced session entries`);
}, 3600000);


// 🆕 启动时从消息历史重建 quiesce 状态
function rebuildQuiesceState() {
  // 从 DB 恢复持久化的 quiesce 状态
  const records = db.findAll('session_quiesce', () => true);
  let rebuilt = 0;
  for (const rec of records) {
    const key = rec.space_id + ':' + rec.session_id;
    const noReplySet = new Set(rec.no_reply_agents || []);
    sessionQuiesce.set(key, { no_reply_agents: noReplySet, quiesced: true });
    rebuilt++;
    console.log('🔄 Rebuilt quiesce: ' + rec.session_id + ' (' + noReplySet.size + ' agents)');
  }

  // 兜底：也检查消息历史（使用索引查询）
  const data = db.get();
  const sessions = (data.sessions || []).filter(s => s.status !== 'closed');
  for (const session of sessions) {
    const key = session.space_id + ':' + session.session_id;
    if (sessionQuiesce.has(key)) continue;
    // 使用 queryMessages 替代全量 filter
    const msgs = db.queryMessages(session.space_id, session.session_id, null);
    if (msgs.length === 0) continue;
    msgs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const activeAgents = new Set();
    const noReplyAgents = new Set();
    for (const m of msgs) {
      if (m.from_agent === 'human') break;
      if (m.from_agent && m.from_agent !== 'human') {
        activeAgents.add(m.from_agent);
        const result = typeof m.content?.result === 'string' ? m.content.result.trim() : '';
        if (result === '[NO_REPLY]' || result === 'NO_REPLY' || result === 'NO' || result === 'HEARTBEAT_OK') {
          noReplyAgents.add(m.from_agent);
        }
      }
    }
    if (activeAgents.size > 0 && [...activeAgents].every(id => noReplyAgents.has(id))) {
      sessionQuiesce.set(key, { no_reply_agents: noReplyAgents, quiesced: true });
      rebuilt++;
      console.log('🔄 Rebuilt quiesce (from msgs): ' + session.session_id);
    }
  }
  if (rebuilt > 0) console.log('🔄 Total rebuilt: ' + rebuilt + ' sessions');
}

// ==================== Agent Override Helper ====================
// Space-level agent identity overrides: caps/desc stored per-space, applied at read time.
// This lets the same agent have different identities across different Spaces
// without touching the global openclaw.json config.

/**
 * Apply Space-level overrides to an online_agents array.
 * Mutates nothing — returns a new array with overrides applied.
 * Override fields: name, capabilities, description (all optional, merge individually).
 */
function applyAgentOverrides(spaceId, agents) {
  const overrides = db.findAll('agent_overrides', o => o.space_id === spaceId);
  if (overrides.length === 0) return agents;
  
  const overrideMap = new Map();
  for (const o of overrides) {
    overrideMap.set(o.agent_id, o);
  }
  
  return agents.map(a => {
    const override = overrideMap.get(a.agent_id);
    if (!override) return a;
    return {
      ...a,
      name: override.name ?? a.name,
      capabilities: override.capabilities ?? a.capabilities,
      description: override.description ?? a.description,
    };
  });
}

// ==================== Spaces API ====================

// 获取所有 spaces
app.get('/api/spaces', (req, res) => {
  const data = db.get();
  
  const spaces = data.spaces.map(space => {
    // 只计算 members 数量，不是所有注册过的 agents
    const members = (data.space_members || []).filter(m => m.space_id === space.space_id);
    const agent_count = members.length;
    const skill_count = data.skills.filter(s => s.space_id === space.space_id).length;
    // 使用索引查询获取最后活动时间
    const spaceMessages = db.queryMessages(space.space_id, null, null);
    const last_activity = spaceMessages.length > 0 
      ? spaceMessages[spaceMessages.length - 1].timestamp 
      : null;
    
    return {
      ...space,
      agent_count,
      skill_count,
      last_activity
    };
  });
  
  res.json({ spaces });
});

// 获取单个 space 详情
app.get('/api/spaces/:space_id', (req, res) => {
  const { space_id } = req.params;
  
  const space = db.findOne('spaces', s => s.space_id === space_id);
  if (!space) {
    return res.status(404).json({ error: 'Space not found' });
  }
  
  const agents = db.findAll('agents', a => a.space_id === space_id);
  const skills = db.findAll('skills', s => s.space_id === space_id);
  
  res.json({ space, agents, skills });
});

// 创建新 space
app.post('/api/spaces', (req, res) => {
  const { name, description, load_packs, space_id: requestedId, permissions } = req.body;
  const space_id = requestedId || nanoid(10);
  
  const newSpace = {
    space_id,
    name,
    description,
    created_at: new Date().toISOString()
  };
  if (permissions) newSpace.permissions = permissions;
  
  db.insert('spaces', newSpace);

  // 自动加载 skill packs
  const packResults = {};
  if (Array.isArray(load_packs) && load_packs.length > 0) {
    for (const tag of load_packs) {
      const sourceSkills = db.findAll('skills', s =>
        s.status === 'active' && s.metadata?.tags?.includes(tag) && !s.metadata?.source_pack
      );
      const data = db.get();
      const sourceFiles = (data.space_files || []).filter(f => f.tags?.includes(tag) && !f.source_file_id);
      const deployed = { skills: 0, files: 0 };

      for (const src of sourceSkills) {
        const newSkill = {
          ...src,
          skill_id: `skill_${nanoid(10)}`,
          space_id,
          metadata: { ...src.metadata, source_pack: tag, source_skill_id: src.skill_id },
          created_at: new Date().toISOString()
        };
        db.insert('skills', newSkill);
        deployed.skills++;
      }

      for (const src of sourceFiles) {
        const newFile = {
          ...src,
          file_id: `file_${nanoid(10)}`,
          space_id,
          tags: [...(src.tags || []), tag],
          source_file_id: src.file_id,
          created_at: new Date().toISOString()
        };
        const srcPath = pathMod.join(FILES_DIR, src.file_id);
        const dstPath = pathMod.join(FILES_DIR, newFile.file_id);
        if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
          fs.copyFileSync(srcPath, dstPath);
        }
        const freshData = db.get();
        if (!freshData.space_files) freshData.space_files = [];
        freshData.space_files.push(newFile);
        db.save(freshData);
        deployed.files++;
      }

      packResults[tag] = deployed;
    }
  }

  res.status(201).json({ ...newSpace, loaded_packs: packResults });

  // 🆕 为新 space 生成初始 skill 目录
  try { generateSkillDirectory(space_id); } catch (err) {
    console.error(`Failed to generate skill directory for new space ${space_id}:`, err);
  }
});

// 更新 space 信息
app.patch('/api/spaces/:space_id', (req, res) => {
  const { space_id } = req.params;
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.permissions !== undefined) updates.permissions = req.body.permissions;
  
  const result = db.update('spaces', s => s.space_id === space_id, updates);
  if (!result) return res.status(404).json({ error: 'space not found' });
  res.json(result);
});

// 删除 space
app.delete('/api/spaces/:space_id', (req, res) => {
  const { space_id } = req.params;
  const space = db.findOne('spaces', s => s.space_id === space_id);
  if (!space) return res.status(404).json({ error: 'Space not found' });

  // Cascade delete all related data
  db.delete('messages', m => m.space_id === space_id);
  db.delete('sessions', s => s.space_id === space_id);
  db.delete('agents', a => a.space_id === space_id);
  db.delete('space_members', m => m.space_id === space_id);
  db.delete('skills', s => s.space_id === space_id);
  db.delete('eval_locks', l => l.space_id === space_id);
  db.delete('session_quiesce', q => q.space_id === space_id);
  db.delete('agent_overrides', o => o.space_id === space_id);
  // Clean up files
  const files = db.findAll('space_files', f => f.space_id === space_id) || [];
  for (const f of files) {
    const filePath = pathMod.join(FILES_DIR, f.file_id);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }
  db.delete('space_files', f => f.space_id === space_id);
  // Delete the space itself
  db.delete('spaces', s => s.space_id === space_id);

  console.log(`🗑️ Deleted space ${space_id} and all associated data`);
  res.json({ deleted: true, space_id });
});

// ==================== Agents API ====================

// Agent 注册
app.post('/api/spaces/:space_id/agents/register', (req, res) => {
  const { space_id } = req.params;
  const { agent_id, name, capabilities, status = 'online' } = req.body;
  
  // 检查是否已存在
  const existing = db.findOne('agents', a => a.agent_id === agent_id && a.space_id === space_id);
  
  if (existing) {
    // 更新
    db.update('agents', 
      a => a.agent_id === agent_id && a.space_id === space_id,
      { 
        name, 
        capabilities, 
        status, 
        last_heartbeat: new Date().toISOString() 
      }
    );
  } else {
    // 插入
    db.insert('agents', {
      agent_id,
      space_id,
      name,
      capabilities,
      status,
      last_heartbeat: new Date().toISOString(),
      joined_at: new Date().toISOString()
    });
  }
  
  // 🔧 Sync to space_members (register + membership must be consistent)
  const memberExists = db.findOne('space_members', m => m.space_id === space_id && m.agent_id === agent_id);
  if (!memberExists) {
    db.insert('space_members', {
      space_id,
      agent_id,
      joined_at: new Date().toISOString(),
    });
    console.log(`[Register] synced ${agent_id} to space_members for ${space_id}`);
    try { rebuildWsSpaceIndexAll(); } catch (e) { console.error('[Register] rebuildWsSpaceIndexAll failed:', e); }
  }
  
  res.json({ 
    success: true, 
    agent_id, 
    space_id, 
    joined_at: new Date().toISOString() 
  });
});

// Agent 心跳
app.post('/api/spaces/:space_id/agents/:agent_id/heartbeat', (req, res) => {
  const { space_id, agent_id } = req.params;
  const { status = 'online' } = req.body;
  
  db.update('agents',
    a => a.agent_id === agent_id && a.space_id === space_id,
    { status, last_heartbeat: new Date().toISOString() }
  );
  
  res.json({ success: true, next_poll_after: 30 });
});

// ==================== Space Members（Agent 加入机制）====================

// 获取 space 的成员 Agent 列表
app.get('/api/spaces/:space_id/members', (req, res) => {
  const { space_id } = req.params;
  const members = db.findAll('space_members', m => m.space_id === space_id);
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  
  // 关联 agent 详情
  const result = members.map(m => {
    // 从任意 space 的 agents 表中找该 agent 的最新信息
    const allAgentRecords = db.findAll('agents', a => a.agent_id === m.agent_id);
    const latest = allAgentRecords.sort((a, b) => 
      new Date(b.last_heartbeat || 0).getTime() - new Date(a.last_heartbeat || 0).getTime()
    )[0];
    
    const isOnline = latest?.last_heartbeat && (now - new Date(latest.last_heartbeat).getTime()) < ONLINE_THRESHOLD;
    return {
      agent_id: m.agent_id,
      name: latest?.name || m.agent_id,
      capabilities: latest?.capabilities || [],
      description: latest?.description || '',
      status: isOnline ? 'online' : 'offline',
      joined_at: m.joined_at,
      last_heartbeat: latest?.last_heartbeat || null,
    };
  }).sort((a, b) => (a.status === 'online' ? 0 : 1) - (b.status === 'online' ? 0 : 1));
  
  res.json({ members: result });
});

// 添加 Agent 到 space
app.post('/api/spaces/:space_id/members', (req, res) => {
  const { space_id } = req.params;
  const { agent_id } = req.body;
  
  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
  
  // 检查是否已加入
  const existing = db.findOne('space_members', m => m.space_id === space_id && m.agent_id === agent_id);
  if (existing) return res.json({ status: 'already_member' });
  
  db.insert('space_members', {
    space_id,
    agent_id,
    joined_at: new Date().toISOString(),
  });
  
  console.log(`[Members] ${agent_id} joined space ${space_id}`);
  // 🆕 WS space index 重建：新成员加入后，关联的 WS 客户端需要接收该 space 的事件
  rebuildWsSpaceIndexAll();
  res.status(201).json({ status: 'joined' });
});

// 批量添加 Agents 到 space
app.post('/api/spaces/:space_id/members/batch', (req, res) => {
  const { space_id } = req.params;
  const { agent_ids } = req.body;
  
  if (!agent_ids?.length) return res.status(400).json({ error: 'agent_ids array is required' });
  
  let added = 0;
  for (const agent_id of agent_ids) {
    const existing = db.findOne('space_members', m => m.space_id === space_id && m.agent_id === agent_id);
    if (!existing) {
      db.insert('space_members', { space_id, agent_id, joined_at: new Date().toISOString() });
      added++;
    }
  }
  
  console.log(`[Members] ${added} agents joined space ${space_id}`);
  // 🆕 WS space index 重建：新成员加入后，关联的 WS 客户端需要接收该 space 的事件
  rebuildWsSpaceIndexAll();
  res.json({ added, total: agent_ids.length });
});

// 移除 Agent 从 space
app.delete('/api/spaces/:space_id/members/:agent_id', (req, res) => {
  const { space_id, agent_id } = req.params;
  
  const data = db.get();
  const before = data.space_members?.length || 0;
  data.space_members = (data.space_members || []).filter(m => !(m.space_id === space_id && m.agent_id === agent_id));
  db.save(data);
  
  const removed = before - (data.space_members?.length || 0);
  if (removed > 0) console.log(`[Members] ${agent_id} left space ${space_id}`);
  // 🆕 WS space index 重建：成员变更后更新事件订阅
  if (removed > 0) rebuildWsSpaceIndexAll();
  res.json({ status: removed > 0 ? 'removed' : 'not_member' });
});

// 获取所有已知 Agents（跨 space，用于 "添加 Agent" 选择列表）
app.get('/api/agents/known', (req, res) => {
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  const allAgents = db.findAll('agents', () => true);
  
  // 按 agent_id 去重，取最新心跳的记录
  const agentMap = new Map();
  for (const a of allAgents) {
    const existing = agentMap.get(a.agent_id);
    if (!existing || new Date(a.last_heartbeat || 0) > new Date(existing.last_heartbeat || 0)) {
      agentMap.set(a.agent_id, a);
    }
  }
  
  const result = [...agentMap.values()].map(a => ({
    agent_id: a.agent_id,
    name: a.name || a.agent_id,
    capabilities: a.capabilities || [],
    description: a.description || '',
    status: (a.last_heartbeat && (now - new Date(a.last_heartbeat).getTime()) < ONLINE_THRESHOLD) ? 'online' : 'offline',
  }));
  
  res.json({ agents: result });
});

// 聚合所有已知 Agent（从 members + agents 表去重）
app.get('/api/agents', (req, res) => {
  const data = db.get();
  const agentMap = new Map();
  // 从 space_members 聚合
  for (const m of (data.space_members || [])) {
    if (!agentMap.has(m.agent_id)) {
      agentMap.set(m.agent_id, {
        agent_id: m.agent_id,
        name: m.name || m.agent_id,
        capabilities: m.capabilities || [],
        description: m.description || ''
      });
    }
  }
  // 从 agents 表中补充（含更丰富的信息）
  for (const a of (data.agents || [])) {
    if (!agentMap.has(a.agent_id)) {
      agentMap.set(a.agent_id, {
        agent_id: a.agent_id,
        name: a.name || a.agent_id,
        capabilities: a.capabilities || [],
        description: a.description || ''
      });
    } else {
      // 已存在则更新为 agents 表中更丰富的信息
      const existing = agentMap.get(a.agent_id);
      if (a.name && a.name !== a.agent_id) existing.name = a.name;
      if (a.capabilities?.length) existing.capabilities = a.capabilities;
      if (a.description) existing.description = a.description;
    }
  }
  res.json({ agents: Array.from(agentMap.values()) });
});

// ==================== 获取 space agents（改为只返回 members）====================

// 获取 space 内的 agents（现在只返回已加入的成员）
app.get('/api/spaces/:space_id/agents', (req, res) => {
  const { space_id } = req.params;
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  
  // 获取该 space 的成员列表
  const members = db.findAll('space_members', m => m.space_id === space_id);
  const memberIds = new Set(members.map(m => m.agent_id));
  
  // 只返回成员 Agent（从 agents 表取详情）
  const allAgentRecords = db.findAll('agents', a => memberIds.has(a.agent_id));
  
  // 按 agent_id 去重取最新记录
  const agentMap = new Map();
  for (const a of allAgentRecords) {
    const existing = agentMap.get(a.agent_id);
    if (!existing || new Date(a.last_heartbeat || 0) > new Date(existing.last_heartbeat || 0)) {
      agentMap.set(a.agent_id, a);
    }
  }
  
  const agents = [...agentMap.values()].map(a => ({
      ...a,
      space_id,
      status: (a.last_heartbeat && (now - new Date(a.last_heartbeat).getTime()) < ONLINE_THRESHOLD) ? 'online' : 'offline'
    }))
    .sort((a, b) => (a.status === 'online' ? 0 : 1) - (b.status === 'online' ? 0 : 1));
  res.json({ agents });
});

// 获取单个 agent 信息
app.get('/api/spaces/:space_id/agents/:agent_id', (req, res) => {
  const { space_id, agent_id } = req.params;
  const agent = db.findOne('agents', a => a.agent_id === agent_id && a.space_id === space_id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  agent.status = (agent.last_heartbeat && (now - new Date(agent.last_heartbeat).getTime()) < ONLINE_THRESHOLD) ? 'online' : 'offline';
  res.json({ agent });
});

// 更新 agent 配置
app.patch('/api/spaces/:space_id/agents/:agent_id', (req, res) => {
  const { space_id, agent_id } = req.params;
  const updates = req.body;
  
  const agent = db.findOne('agents', a => a.agent_id === agent_id && a.space_id === space_id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  
  // 允许更新的字段
  const allowed = ['name', 'capabilities', 'max_concurrent', 'description'];
  const filtered = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      if (key === 'max_concurrent') {
        filtered[key] = Math.max(1, Math.min(10, parseInt(updates[key]) || 3));
      } else {
        filtered[key] = updates[key];
      }
    }
  }
  
  db.update('agents',
    a => a.agent_id === agent_id && a.space_id === space_id,
    filtered
  );
  
  res.json({ success: true, agent_id, ...filtered });
});

// ==================== Agent Cleanup API ====================

// 去重 agents 表（保留每个 agent_id 的最新记录）
app.post('/api/agents/deduplicate', (req, res) => {
  const data = db.get();
  if (!data.agents) return res.json({ removed: 0 });
  const before = data.agents.length;
  const best = new Map();
  for (const a of data.agents) {
    const existing = best.get(a.agent_id);
    if (!existing || new Date(a.last_heartbeat || 0) > new Date(existing.last_heartbeat || 0)) {
      best.set(a.agent_id, a);
    }
  }
  data.agents = Array.from(best.values());
  db.save(data);
  db.flush();
  const removed = before - data.agents.length;
  console.log(`[cleanup] dedup agents: ${before} → ${data.agents.length} (removed ${removed})`);
  res.json({ before, after: data.agents.length, removed });
});

// 批量删除 agents
app.post('/api/agents/batch-delete', (req, res) => {
  const { agent_ids } = req.body;
  if (!Array.isArray(agent_ids) || agent_ids.length === 0) {
    return res.status(400).json({ error: 'agent_ids array required' });
  }
  const data = db.get();
  const before = (data.agents || []).length;
  const toDelete = new Set(agent_ids);
  data.agents = (data.agents || []).filter(a => !toDelete.has(a.agent_id));
  // Also remove from space_members
  data.space_members = (data.space_members || []).filter(m => !toDelete.has(m.agent_id));
  db.save(data);
  db.flush();
  const removed = before - data.agents.length;
  console.log(`[cleanup] batch-delete: removed ${removed} agents (${agent_ids.join(', ')})`);
  res.json({ removed, remaining: data.agents.length });
});

// 单个删除 agent
app.delete('/api/agents/:agent_id', (req, res) => {
  const { agent_id } = req.params;
  const data = db.get();
  const before = (data.agents || []).length;
  data.agents = (data.agents || []).filter(a => a.agent_id !== agent_id);
  data.space_members = (data.space_members || []).filter(m => m.agent_id !== agent_id);
  db.save(data);
  db.flush();
  const removed = before - data.agents.length;
  if (removed === 0) return res.status(404).json({ error: 'Agent not found' });
  console.log(`[cleanup] deleted agent: ${agent_id} (${removed} records)`);
  res.json({ deleted: agent_id, records_removed: removed });
});

// ==================== Agent Identity Override API ====================
// Space-level override for agent caps/desc/name.
// These take priority over the global config (openclaw.json) values.
// Override fields are individually optional — only provided fields are overridden.

// List all overrides for a space
app.get('/api/spaces/:space_id/agent-overrides', (req, res) => {
  const { space_id } = req.params;
  const overrides = db.findAll('agent_overrides', o => o.space_id === space_id);
  res.json({ overrides });
});

// Get override for a specific agent in a space
app.get('/api/spaces/:space_id/agent-overrides/:agent_id', (req, res) => {
  const { space_id, agent_id } = req.params;
  const override = db.findOne('agent_overrides', o => o.space_id === space_id && o.agent_id === agent_id);
  if (!override) return res.status(404).json({ error: 'No override found for this agent in this space' });
  res.json(override);
});

// Set/update override for a specific agent in a space (PUT = upsert)
app.put('/api/spaces/:space_id/agent-overrides/:agent_id', (req, res) => {
  const { space_id, agent_id } = req.params;
  const { name, capabilities, description } = req.body;
  
  // Validate: at least one override field must be provided
  if (name === undefined && capabilities === undefined && description === undefined) {
    return res.status(400).json({ error: 'At least one of name, capabilities, or description must be provided' });
  }
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    return res.status(400).json({ error: 'capabilities must be an array of strings' });
  }
  
  const existing = db.findOne('agent_overrides', o => o.space_id === space_id && o.agent_id === agent_id);
  
  if (existing) {
    const updates = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (capabilities !== undefined) updates.capabilities = capabilities;
    if (description !== undefined) updates.description = description;
    
    db.update('agent_overrides',
      o => o.space_id === space_id && o.agent_id === agent_id,
      updates
    );
    console.log(`[override] updated agent override: ${agent_id} in space ${space_id}`);
    const updated = db.findOne('agent_overrides', o => o.space_id === space_id && o.agent_id === agent_id);
    res.json(updated);
  } else {
    const override = {
      space_id,
      agent_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (name !== undefined) override.name = name;
    if (capabilities !== undefined) override.capabilities = capabilities;
    if (description !== undefined) override.description = description;
    
    db.insert('agent_overrides', override);
    console.log(`[override] created agent override: ${agent_id} in space ${space_id}`);
    res.status(201).json(override);
  }
});

// Delete override for a specific agent (revert to global config)
app.delete('/api/spaces/:space_id/agent-overrides/:agent_id', (req, res) => {
  const { space_id, agent_id } = req.params;
  const existing = db.findOne('agent_overrides', o => o.space_id === space_id && o.agent_id === agent_id);
  if (!existing) return res.status(404).json({ error: 'No override found' });
  
  db.delete('agent_overrides', o => o.space_id === space_id && o.agent_id === agent_id);
  console.log(`[override] deleted agent override: ${agent_id} in space ${space_id}`);
  res.json({ deleted: true, agent_id, space_id });
});

// Bulk set overrides for a space (convenience endpoint)
app.put('/api/spaces/:space_id/agent-overrides', (req, res) => {
  const { space_id } = req.params;
  const { overrides } = req.body;
  
  if (!Array.isArray(overrides)) {
    return res.status(400).json({ error: 'overrides must be an array' });
  }
  
  const results = [];
  for (const o of overrides) {
    if (!o.agent_id) continue;
    const existing = db.findOne('agent_overrides', r => r.space_id === space_id && r.agent_id === o.agent_id);
    
    const record = {
      space_id,
      agent_id: o.agent_id,
      updated_at: new Date().toISOString(),
    };
    if (o.name !== undefined) record.name = o.name;
    if (o.capabilities !== undefined) record.capabilities = o.capabilities;
    if (o.description !== undefined) record.description = o.description;
    
    if (existing) {
      db.update('agent_overrides',
        r => r.space_id === space_id && r.agent_id === o.agent_id,
        record
      );
    } else {
      record.created_at = new Date().toISOString();
      db.insert('agent_overrides', record);
    }
    results.push(record);
  }
  
  console.log(`[override] bulk set ${results.length} agent overrides in space ${space_id}`);
  res.json({ updated: results.length, overrides: results });
});

// ==================== Messages API ====================

// 🆕 消息去重缓存：防止前端 IME 双触发导致同一条消息存两次
const recentMessageHashes = new Map(); // key: hash → timestamp
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentMessageHashes) {
    if (now - ts > 3000) recentMessageHashes.delete(k);
  }
}, 5000);

// ── 🆕 Lock Version Guard: 防止孤儿写入 ──
// 当 agent 提供 lock_version 时，验证其仍持有有效锁。
// 人类消息 / 系统消息（无 lock_version）跳过检查以保持向后兼容。
// 同时检查 TTL，即使锁尚未被惰性清理，超时后也拒绝写入。
function validateLockVersion(spaceId, sessionId, lockVersion) {
  if (!lockVersion) return { valid: true }; // no lock_version → backward compat, allow

  const lock = db.findOne('eval_locks', l =>
    l.session_id === sessionId && l.space_id === spaceId
  );

  if (!lock) {
    return { valid: false, reason: 'no_active_lock' };
  }

  if (lock._nonce !== lockVersion) {
    return { valid: false, reason: 'lock_version_mismatch', expected: lock._nonce };
  }

  if (Date.now() - lock.acquired_at > EVAL_LOCK_TIMEOUT) {
    return { valid: false, reason: 'lock_expired' };
  }

  return { valid: true };
}

// 去重 helper：同一 space + session + sender + 内容在 2 秒内视为重复
function isDuplicateMessage(spaceId, sessionId, from, content) {
  const contentStr = JSON.stringify(content || {});
  const brief = contentStr.substring(0, 200) + ':' + contentStr.length;
  const key = `${spaceId}:${sessionId}:${from}:${brief}`;
  const now = Date.now();
  const last = recentMessageHashes.get(key);
  if (last && now - last < 2000) return true;
  recentMessageHashes.set(key, now);
  return false;
}

// 发送消息
app.post('/api/spaces/:space_id/messages', (req, res) => {
  const { space_id } = req.params;
  const { from, type, content, session_id, metadata } = req.body;

  // 🛡️ 防止插入空消息（ghost message prevention）
  if (!from || !type || !content || typeof content !== 'object') {
    return res.status(400).json({ error: 'Missing required fields: from, type, content (object)' });
  }
  
  if (isDuplicateMessage(space_id, session_id || 'default', from, content)) {
    console.log(`a2a-server: dedup: duplicate message blocked (${from}@${space_id})`);
    return res.status(200).json({ message_id: 'dedup', session_id: session_id || 'session_default', deduplicated: true });
  }

  // 🆕 Server-side dedup: 防止同一 agent 对同一 job_id 创建多个 response
  // 修复重启后 agent 重复处理已完成消息的问题
  if (type === 'human_job_response' && content?.job_id && from && from !== 'human') {
    const existingResponse = db.findOne('messages', m =>
      m.space_id === space_id &&
      m.session_id === (session_id || 'session_default') &&
      m.from_agent === from &&
      m.type === 'human_job_response' &&
      m.content?.job_id === content.job_id
    );
    if (existingResponse) {
      console.log(`a2a-server: dedup: response already exists from ${from} for job ${content.job_id} (existing: ${existingResponse.message_id})`);
      return res.status(200).json({ 
        message_id: existingResponse.message_id, 
        session_id: session_id || 'session_default', 
        deduplicated: true 
      });
    }
  }

  // 🆕 Lock Version Guard: reject orphan writes from agents whose lock has been superseded
  const { lock_version } = req.body;
  if (lock_version && from !== 'human') {
    const lv = validateLockVersion(space_id, session_id || 'session_default', lock_version);
    if (!lv.valid) {
      console.log(`🛡️ Lock version guard BLOCKED POST write: ${from}@${session_id} reason=${lv.reason}`);
      return res.status(409).json({ error: 'lock_version_mismatch', reason: lv.reason, expected: lv.expected });
    }
  }

  const message_id = `msg_${nanoid(10)}`;
  
  // 如果没有指定 session_id，使用默认 session 或创建新的
  let finalSessionId = session_id;
  if (!finalSessionId) {
    // 查找默认 session
    let defaultSession = db.findOne('sessions', s => 
      s.space_id === space_id && s.session_id === 'session_default'
    );
    
    if (!defaultSession) {
      // 创建默认 session
      defaultSession = {
        session_id: 'session_default',
        space_id,
        title: 'Default Session',
        created_at: new Date().toISOString(),
        created_by: 'system',
        status: 'active'
      };
      db.insert('sessions', defaultSession);
    }
    
    finalSessionId = 'session_default';
  }
  
  const newMessage = {
    message_id,
    session_id: finalSessionId,
    space_id,
    from_agent: from,
    type,
    content,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
  
  db.insert('messages', newMessage);

  // 🆕 Quiesce tracking: 人类消息重置静默状态
  if (from === 'human' && finalSessionId) {
    resetQuiesce(space_id, finalSessionId, true); // isHumanMessage=true → clears summaryRequested
    // 🆕 Round Responders: 人类新消息 = 新一轮，清除上轮的 responders 并初始化新轮
    clearRoundResponders(space_id, finalSessionId);
    // 预初始化，记录 trigger message ID（用于后续 @mention 检查）
    const rrKey = `${space_id}:${finalSessionId}`;
    roundResponders.set(rrKey, { responders: [], trigger_message_id: message_id });
  }

  // 人类发的第一条消息 → 自动更新 session 标题
  if (from === 'human') {
    const humanText = content?.job || content?.message || '';
    if (humanText) {
      const humanMsgsInSession = db.findAll('messages', m =>
        m.session_id === finalSessionId && m.from_agent === 'human'
      );
      if (humanMsgsInSession.length <= 1) {
        const currentSession = db.findOne('sessions', s => s.session_id === finalSessionId);
        const currentSource = currentSession?.title_source || 'auto';
        // Only set auto title if no higher-priority title exists
        if (currentSource === 'auto' || !currentSession?.title) {
          const title = humanText.length > 40 ? humanText.substring(0, 40) + '...' : humanText;
          db.update('sessions', s => s.session_id === finalSessionId, { title, title_source: 'auto' });
        }
      }
    }
  }
  
  // 🆕 WebSocket push: broadcast new message to connected clients
  broadcastToSpace(space_id, {
    type: 'new_message',
    space_id,
    session_id: finalSessionId,
    message: newMessage,
    ...getSpaceBroadcastMeta(space_id),
  });

  res.status(201).json({ 
    message_id,
    session_id: finalSessionId,
    timestamp: newMessage.timestamp 
  });
});

// 轮询消息 (支持按 session 过滤)
// agent_id 参数: 顺带更新心跳 + 自动注册
app.get('/api/spaces/:space_id/messages', (req, res) => {
  const { space_id } = req.params;
  const { since, limit = 50, session_id, agent_id, agent_name, agent_capabilities, agent_description } = req.query;
  
  // 🆕 agent_id 存在 → 更新心跳（自动注册 + 续命）
  if (agent_id) {
    const existing = db.findOne('agents', a => 
      a.agent_id === agent_id && a.space_id === space_id
    );
    if (existing) {
      const updates = { status: 'online', last_heartbeat: new Date().toISOString() };
      // DEBUG: 追踪谁在 poll
      // 允许通过 poll 更新 name/capabilities/description
      if (agent_name) updates.name = agent_name;
      if (agent_capabilities) {
        try { updates.capabilities = JSON.parse(agent_capabilities); } catch {}
      }
      if (agent_description) updates.description = agent_description;
      db.update('agents',
        a => a.agent_id === agent_id && a.space_id === space_id,
        updates
      );
    } else {
      // 🔒 不再自动注册——agent 必须是 space_members 成员才能自动创建 agents 记录
      const isMember = db.findOne('space_members', m => m.space_id === space_id && m.agent_id === agent_id);
      if (isMember) {
        let caps = [];
        try { if (agent_capabilities) caps = JSON.parse(agent_capabilities); } catch {}
        db.insert('agents', {
          agent_id,
          space_id,
          name: agent_name || agent_id,
          capabilities: caps,
          description: agent_description || '',
          status: 'online',
          last_heartbeat: new Date().toISOString(),
          joined_at: new Date().toISOString()
        });
        console.log(`✅ Registered agent ${agent_id} in space ${space_id} (was member)`);
      }
      // 非成员 poll 静默忽略，不创建记录
    }
  }
  
  // 🔥 Hot path optimization: use indexed queryMessages instead of O(n) linear scan
  // db.queryMessages does: Map index lookup + binary search since + updated_at compensation
  const sinceDate = since ? new Date(parseInt(since)).toISOString() : null;
  let messages = db.queryMessages(space_id, session_id || null, sinceDate);

  // 🆕 Per-request cache for round limit check (avoid repeated db reads per session)
  const roundLimitCache = new Map();

  // queryMessages already did binary search + updated_at compensation.
  // Now apply business logic filters on compensation matches only
  // (messages included because updated_at > sinceDate, not because timestamp > sinceDate).
  if (sinceDate) {
    messages = messages.filter(m => {
      // timestamp > sinceDate → new message, always include
      if (m.timestamp > sinceDate) return true;
      // This is a compensation match — apply business rules
      if (m.updated_at && m.updated_at > sinceDate &&
          m.content?.streaming === false && m.type === 'human_job_response') {
        // 🆕 Quiesce: 静默 session 不返回完成信号，防止 NO_REPLY 无限循环
        if (isSessionQuiesced(space_id, m.session_id)) {
          return false;
        }
        // 🆕 轮次兜底: Agent 消息距离人类消息超过 N 轮，强制停止
        if (!roundLimitCache.has(m.session_id)) {
          const rounds = countAgentRoundsSinceHuman(space_id, m.session_id);
          const exceeded = rounds >= MAX_AGENT_ROUNDS_SINCE_HUMAN;
          roundLimitCache.set(m.session_id, exceeded);
          if (exceeded) {
            console.log(`🛑 Session ${m.session_id} round limit exceeded (${rounds}/${MAX_AGENT_ROUNDS_SINCE_HUMAN} agent msgs since last human), suppressing completion signals`);
          }
        }
        if (roundLimitCache.get(m.session_id)) {
          return false;
        }
        return true;
      }
      // compensation match but not streaming completion → drop
      return false;
    });
  }
  
  // 排序并限制数量
  messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  messages = messages.slice(-parseInt(limit));
  
  // 添加 from_name
  const data = db.get();
  const messagesWithNames = messages.map(m => {
    const agent = data.agents.find(a => a.agent_id === m.from_agent);
    return {
      ...m,
      from_name: agent ? agent.name : m.from_agent
    };
  });
  
  // 🆕 在线 agents（只包含该 space 的成员，且心跳在 90s 内）
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  const spaceMembers = (data.space_members || []).filter(m => m.space_id === space_id);
  const memberIds = new Set(spaceMembers.map(m => m.agent_id));
  
  // 从所有 agents 记录中找成员的最新心跳
  const allAgentRecords = (data.agents || []).filter(a => memberIds.has(a.agent_id));
  const agentMap = new Map();
  for (const a of allAgentRecords) {
    const existing = agentMap.get(a.agent_id);
    if (!existing || new Date(a.last_heartbeat || 0) > new Date(existing.last_heartbeat || 0)) {
      agentMap.set(a.agent_id, a);
    }
  }
  
  const online_agents_raw = [...agentMap.values()]
    .filter(a => a.last_heartbeat && (now - new Date(a.last_heartbeat).getTime()) < ONLINE_THRESHOLD)
    .map(a => ({
      agent_id: a.agent_id,
      name: a.name || a.agent_id,
      capabilities: a.capabilities || [],
      description: a.description || ''
    }));
  // 🆕 Space-level agent identity override: 优先使用 Space 内定义的 caps/desc
  const online_agents = applyAgentOverrides(space_id, online_agents_raw);
  
  // 🆕 当前评估锁（该 space 下所有 session 的锁）
  const eval_locks = (data.eval_locks || []).filter(l => l.space_id === space_id);
  // 清理过期锁（>60s）
  const activeLocks = eval_locks.filter(l => (now - l.acquired_at) < 60000);
  if (activeLocks.length < eval_locks.length) {
    // 有过期锁，清理
    for (const expired of eval_locks.filter(l => (now - l.acquired_at) >= 60000)) {
      db.delete('eval_locks', el => el.session_id === expired.session_id && el.space_id === space_id);
      console.log(`🔓 Auto-released expired eval lock for session ${expired.session_id} (holder: ${expired.holder})`);
      // 🆕 Broadcast so waiting agents can retry
      broadcastToSpace(space_id, {
        type: 'eval_lock_released',
        space_id,
        session_id: expired.session_id,
        released_by: expired.holder,
        auto_expired: true,
        ...getSpaceBroadcastMeta(space_id),
      });
    }
  }
  
  // 🆕 构建 session_mutes 映射：{ session_id: ["muted_agent_1", ...] }
  const sessionMutes = {};
  const allSessions = (data.sessions || []).filter(s => s.space_id === space_id);
  for (const sess of allSessions) {
    if (sess.muted_agents && sess.muted_agents.length > 0) {
      sessionMutes[sess.session_id] = sess.muted_agents;
    }
  }

  // 🆕 Session quiesce 状态（调试 + 前端可用）
  const session_quiesce = {};
  for (const [key, state] of sessionQuiesce) {
    if (key.startsWith(space_id + ':')) {
      const sid = key.substring(space_id.length + 1);
      session_quiesce[sid] = {
        quiesced: state.quiesced,
        no_reply_agents: [...state.no_reply_agents],
      };
    }
  }

  // 🆕 附带被轮次兜底拦截的 session（如果有的话）
  const session_round_limits = {};
  for (const [sid, exceeded] of roundLimitCache) {
    if (exceeded) session_round_limits[sid] = true;
  }
  
  // 🆕 附带 session summaries（每个有消息的 session）
  const sessionIds = [...new Set(messagesWithNames.map(m => m.session_id))];
  const session_summaries = {};
  for (const sid of sessionIds) {
    const summary = db.findOne('session_summaries', s => s.session_id === sid && s.space_id === space_id);
    if (summary) {
      session_summaries[sid] = {
        summary_text: summary.summary_text,
        last_message_id: summary.last_message_id,
        message_count: summary.message_count,
        updated_by: summary.updated_by,
        updated_at: summary.updated_at,
      };
    }
  }
  
  res.json({ 
    messages: messagesWithNames,
    next_since: Date.now(),
    online_agents,
    eval_locks: activeLocks,
    session_mutes: sessionMutes,
    session_quiesce,
    session_round_limits,
    session_summaries,
  });
});

// 更新消息内容 (用于流式更新)
app.patch('/api/spaces/:space_id/messages/:message_id', (req, res) => {
  const { space_id, message_id } = req.params;
  const { content, metadata } = req.body;
  
  const message = db.findOne('messages', m => 
    m.message_id === message_id && m.space_id === space_id
  );
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  // 🔧 Lock Version Guard on PATCH: downgraded to warn-only.
  // PATCH updates an already-created message (POST guard prevents orphan creation).
  // Blocking PATCH truncates streaming responses, causing "swallowed message" UX bugs.
  // See: 86x BLOCKED PATCH incidents in session_391OpLLCvH (2025-06).
  const { lock_version } = req.body;
  if (lock_version && message.from_agent && message.from_agent !== 'human') {
    const lv = validateLockVersion(space_id, message.session_id, lock_version);
    if (!lv.valid) {
      console.log(`⚠️ Lock version guard WARN PATCH (allowed): ${message.from_agent}@${message.session_id} msg=${message_id} reason=${lv.reason}`);
      // Previously returned 409 here, now allow through — POST guard is sufficient
    }
  }

  // 更新消息内容和元数据
  const updates = { updated_at: new Date().toISOString() };
  if (content) {
    updates.content = { ...message.content, ...content };
  }
  if (metadata) {
    updates.metadata = { ...(message.metadata || {}), ...metadata };
  }
  db.update('messages',
    m => m.message_id === message_id,
    updates
  );

  // 🆕 Quiesce tracking: Agent 完成时判断是 NO_REPLY 还是实质回复
  const mergedContent = content ? { ...message.content, ...content } : message.content;
  if (mergedContent.streaming === false && message.from_agent && message.from_agent !== 'human') {
    const resultStr = typeof mergedContent.result === 'string' ? mergedContent.result.trim() : '';
    const isNoReply = /^\s*(\[?NO[_\s]?REPLY\]?|NO)\s*$/i.test(resultStr);
    
    // 🛡️ Don't reset quiesce/poison pill during interrupt cooldown.
    // Fix 2a: INTERRUPT_COOLDOWN extended to 5min (was 10s). The poison pill is effectively
    // permanent until the next human message triggers resetQuiesce. The 5min fallback
    // prevents truly orphaned sessions from being stuck forever.
    // Also skip resetQuiesce for messages containing interrupt markers (⏹/⚡).
    const intKey = `${space_id}:${message.session_id}`;
    const intTs = sessionInterruptedAt.get(intKey);
    const withinInterruptCooldown = intTs && (Date.now() - intTs < INTERRUPT_COOLDOWN);
    const hasInterruptMarker = resultStr && (resultStr.includes('⏹') || resultStr.includes('⚡'));
    
    if (isNoReply) {
      addNoReply(space_id, message.session_id, message.from_agent);
    } else if (resultStr && !withinInterruptCooldown && !hasInterruptMarker) {
      resetQuiesce(space_id, message.session_id);
      // 🆕 Round Responders: 记录每个实质回复的 Agent
      addRoundResponder(space_id, message.session_id, message.from_agent, message.from_name || message.from_agent, message.content?.job_id);
    }
  }

  // 🆕 WebSocket push: broadcast message update (completion signals)
  // Server-side filtering: don't broadcast completions for quiesced/round-limited sessions
  const shouldBroadcastUpdate = (() => {
    const mc = updates.content || message.content;
    if (mc?.streaming === false && message.from_agent !== 'human') {
      if (isSessionQuiesced(space_id, message.session_id)) return false;
      const rounds = countAgentRoundsSinceHuman(space_id, message.session_id);
      if (rounds >= MAX_AGENT_ROUNDS_SINCE_HUMAN) return false;
    }
    return true;
  })();
  if (shouldBroadcastUpdate) {
    const updatedMsg = db.findOne('messages', m => m.message_id === message_id);
    broadcastToSpace(space_id, {
      type: 'message_updated',
      space_id,
      session_id: message.session_id,
      message_id,
      message: updatedMsg,
      ...getSpaceBroadcastMeta(space_id),
    });
  }
  
  res.json({ 
    success: true,
    message_id,
    updated_at: new Date().toISOString()
  });
});

// 删除消息
app.delete('/api/spaces/:space_id/messages/:message_id', (req, res) => {
  const { space_id, message_id } = req.params;
  
  const message = db.findOne('messages', m => 
    m.message_id === message_id && m.space_id === space_id
  );
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  db.delete('messages', m => m.message_id === message_id);
  
  res.json({ success: true, message_id });
});

// ==================== System Prompt (Custom Rules) ====================

// 获取 space 的自定义规则
app.get('/api/spaces/:space_id/system-prompt', (req, res) => {
  const { space_id } = req.params;
  
  const space = db.findOne('spaces', s => s.space_id === space_id);
  if (!space) {
    return res.status(404).json({ error: 'Space not found' });
  }
  
  res.json({
    custom_rules: space.custom_rules || '',
    updated_at: space.custom_rules_updated_at || null,
  });
});

// 更新 space 的自定义规则
app.put('/api/spaces/:space_id/system-prompt', (req, res) => {
  const { space_id } = req.params;
  const { custom_rules } = req.body;
  
  const space = db.findOne('spaces', s => s.space_id === space_id);
  if (!space) {
    return res.status(404).json({ error: 'Space not found' });
  }
  
  db.update('spaces',
    s => s.space_id === space_id,
    { 
      custom_rules: custom_rules || '',
      custom_rules_updated_at: new Date().toISOString(),
    }
  );
  
  res.json({ success: true, custom_rules: custom_rules || '' });
});

// ==================== Eval Lock API ====================
//
// ⚠️ CRITICAL CONCURRENCY SECTION — 修改前请完整阅读此注释
//
// 设计意图：多 Agent 在线时，同一 session 同时只有一个 Agent 在评估/响应。
// 这是防止重复回复和级联失控的核心机制。
//
// 关键不变量：
// 1. 锁是 session 粒度（不是 space 粒度或 message 粒度）
// 2. Insert-first + conflict-check 模式依赖 Node.js 单线程（同步代码段内无 async 间隙）
// 3. 锁 TTL = 60s，处理中每 30s 续期（见 plugin monitor.ts processSessionMessage）
// 4. streaming 检查：仅日志，不再阻塞 acquire（锁表是唯一并发控制）
// 5. 释放锁时 WS broadcast eval_lock_released，触发 plugin 的 retry queue 排水
//
// 已修复的 bug 历史（不要引入回归）：
// - 2026-03-19: 孤儿 streaming 消息导致 eval lock 永久阻塞 → 添加 reapOrphanedStreaming
// - 2026-03-20: WS 模式下锁释放事件丢失 → 添加 broadcastToSpace + retry queue
// - 2026-03-20: retry queue sweep 和 handleLockReleased 竞态 → 添加 retryQueueProcessing mutex

// Claim evaluation lock for a session
// 🧹 Reap orphaned streaming messages — gateway crash leaves messages stuck in streaming: true forever.
// Called lazily from /eval/claim so no extra timer needed.
const STREAMING_TTL = 120_000; // 2 min without update → orphan
function reapOrphanedStreaming(spaceId, sessionId) {
  const now = Date.now();
  // Check if any agent holds an active eval lock for this session
  const hasActiveLock = db.findOne('eval_locks', l =>
    l.space_id === spaceId && l.session_id === sessionId && (now - l.acquired_at) < 60000
  );
  const orphans = db.findAll('messages', m => {
    if (!(m.session_id === sessionId && m.space_id === spaceId &&
        m.content?.streaming === true && m.from_agent !== 'human')) return false;
    const ts = new Date(m.updated_at || m.created_at).getTime();
    const isStale = isNaN(ts) || (now - ts) > STREAMING_TTL;
    if (!isStale) return false;
    // If the message's author still holds the active lock, skip reaping
    if (hasActiveLock && hasActiveLock.holder === m.from_agent) return false;
    return true;
  });
  for (const m of orphans) {
    const ts = new Date(m.updated_at || m.created_at).getTime();
    db.update('messages',
      msg => msg.message_id === m.message_id,
      {
        content: { ...m.content, streaming: false },
        updated_at: new Date().toISOString(),
      }
    );
    console.log(`🧹 Reaped orphaned streaming message ${m.message_id} from ${m.from_agent} (age: ${isNaN(ts) ? 'NaN(no timestamp)' : Math.round((now - ts)/1000) + 's'}, session: ${sessionId})`);
  }
  return orphans.length;
}

// 🔒 v2: Insert-first + conflict-check 模式，消除 TOCTOU 竞态
// streaming 检查已改为仅日志（不阻塞），锁表是唯一并发控制
app.post('/api/spaces/:space_id/sessions/:session_id/eval/claim', (req, res) => {
  const { space_id, session_id } = req.params;
  const { agent_id } = req.body;
  
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }
  
  const now = Date.now();
  const LOCK_TIMEOUT = EVAL_LOCK_TIMEOUT; // use shared constant
  const ONLINE_THRESHOLD = 90000; // 90s
  
  // ── 防御层 0: 清理孤儿 streaming 消息 ──
  // Gateway crash 后遗留的 streaming: true 消息会永久阻塞 eval lock
  reapOrphanedStreaming(space_id, session_id);
  
  // ── 快速续期路径（跳过 streaming 检查）──
  // 如果请求者已持有未过期的锁，这是续期而非新获取。
  // 续期不需要检查其他 Agent 的 streaming 状态——你续的是自己的锁，
  // 不应该被别人的 streaming placeholder 挡住。
  // 这修复了 _curator 等多 Agent 场景中的互锁问题：
  //   Assessor 和 Librarian 同时有 streaming placeholder 时，
  //   双方续期都被对方的 streaming 检查拒绝 → 双双截断。
  const myExistingLock = db.findOne('eval_locks', l =>
    l.session_id === session_id && l.space_id === space_id && l.holder === agent_id
  );
  if (myExistingLock && (now - myExistingLock.acquired_at < LOCK_TIMEOUT)) {
    // ── 毒丸检查（续期也要拦截）──
    const rkInt = `${space_id}:${session_id}`;
    const rkTs = sessionInterruptedAt.get(rkInt);
    if (rkTs && (now - rkTs < INTERRUPT_COOLDOWN)) {
      // 被中断了，释放锁并拒绝续期
      db.delete('eval_locks', l => l.session_id === session_id && l.space_id === space_id && l.holder === agent_id);
      console.log(`🚫 Eval lock renew denied (poison pill): ${agent_id} — session ${session_id} was interrupted`);
      return res.json({ granted: false, reason: 'interrupted', cooldown_remaining: INTERRUPT_COOLDOWN - (now - rkTs) });
    }
    db.update('eval_locks',
      l => l.session_id === session_id && l.space_id === space_id && l.holder === agent_id,
      { acquired_at: now }
    );
    console.log(`🔒 Eval lock renewed (fast path): ${agent_id} (session: ${session_id})`);
    // 🆕 lock_version: return _nonce so plugin can guard writes. _nonce is stable across renewals.
    return res.json({ granted: true, renewed: true, lock_version: myExistingLock._nonce, first_responder: getFirstResponder(space_id, session_id) });
  }
  
  // ── 防御层 0.5: Interrupt 毒丸检查 ──
  // 如果 session 最近被 hard interrupt，拒绝新的 acquire（防止 abort 传播延迟期间重新获锁）
  const intKey = `${space_id}:${session_id}`;
  const interruptedTs = sessionInterruptedAt.get(intKey);
  if (interruptedTs && (now - interruptedTs < INTERRUPT_COOLDOWN)) {
    console.log(`🚫 Eval lock denied (poison pill): ${agent_id} — session ${session_id} was interrupted ${now - interruptedTs}ms ago`);
    return res.json({ granted: false, reason: 'interrupted', cooldown_remaining: INTERRUPT_COOLDOWN - (now - interruptedTs) });
  }
  
  // ── 防御层 1: Streaming 检查（仅日志，不阻塞）──
  // 之前：streaming=true → 硬拒绝所有 acquire。问题：streaming agent 同时持锁，
  // 锁表检查已经会 deny，streaming check 纯冗余；而锁超时清理后 streaming 残留
  // 又会无限阻塞其他 agent（#P0 串行抢锁根因）。
  // 改为：仅记录日志供调试，不再阻塞。锁表是唯一的并发控制机制。
  const streamingMsg = db.findOne('messages', m =>
    m.session_id === session_id && m.space_id === space_id &&
    m.content?.streaming === true && m.from_agent !== 'human' && m.from_agent !== agent_id
  );
  if (streamingMsg) {
    console.log(`ℹ️ Eval lock acquire: ${agent_id} — note: ${streamingMsg.from_agent} still streaming (session: ${session_id}), proceeding to lock table check`);
  }
  
  // ── 检查现有锁 ──
  const existingLocks = db.findAll('eval_locks', l => 
    l.session_id === session_id && l.space_id === space_id
  );
  
  // 清理超时和离线持锁者的锁
  for (const lock of existingLocks) {
    if (lock.holder === agent_id) continue; // 自己的锁不清理，下面处理
    
    const isTimeout = now - lock.acquired_at > LOCK_TIMEOUT;
    let isOffline = false;
    if (!isTimeout) {
      const holder = db.findOne('agents', a => a.agent_id === lock.holder && a.space_id === space_id);
      if (holder && holder.last_heartbeat) {
        isOffline = now - new Date(holder.last_heartbeat).getTime() > ONLINE_THRESHOLD;
      }
    }
    
    if (isTimeout || isOffline) {
      db.delete('eval_locks', l => l.session_id === session_id && l.space_id === space_id && l.holder === lock.holder);
      console.log(`🔓 Eval lock cleanup (${isTimeout ? 'timeout' : 'offline'}): ${lock.holder} (session: ${session_id})`);
    }
  }
  
  // 重新查询清理后的锁状态
  const activeLocks = db.findAll('eval_locks', l => 
    l.session_id === session_id && l.space_id === space_id
  );
  
  const myLock = activeLocks.find(l => l.holder === agent_id);
  const otherLock = activeLocks.find(l => l.holder !== agent_id);
  
  if (myLock) {
    // 自己已持有 — 续期（fallback 路径：快速续期在上方已处理大部分情况，
    // 这里兜底处理锁刚好过期但还未被清理的边缘 case）
    db.update('eval_locks',
      l => l.session_id === session_id && l.space_id === space_id && l.holder === agent_id,
      { acquired_at: now }
    );
    return res.json({ granted: true, renewed: true, lock_version: myLock._nonce, first_responder: getFirstResponder(space_id, session_id) });
  }
  if (otherLock) {
    // 别人持有且未超时/未离线（已被上面清理过了）
    return res.json({ granted: false, held_by: otherLock.holder });
  }
  
  // ── 防御层 3: Round Response 限流 ──
  // Hard limit: 超过上限直接拒绝，不插入锁
  const responseLimit = checkRoundResponseLimit(space_id, session_id, agent_id);
  if (!responseLimit.allowed) {
    return res.json({
      granted: false,
      reason: 'round_response_hard_limit',
      responders_count: responseLimit.responders_count,
      hard_limit: responseLimit.limits.hard,
    });
  }

  // ── 防御层 4: Insert-first + conflict-check ──
  // 先插入，再检查是否有竞争者（同步操作，Node.js 单线程下是原子的）
  // 即使未来出现任何 async 间隙，这种模式也是安全的
  const lockRecord = {
    session_id,
    space_id,
    holder: agent_id,
    acquired_at: now,
    _nonce: `${agent_id}_${now}_${Math.random().toString(36).slice(2, 8)}` // 唯一标识
  };
  db.insert('eval_locks', lockRecord);
  
  // 立即检查：是否有其他 agent 也插入了锁？
  const allLocksNow = db.findAll('eval_locks', l => 
    l.session_id === session_id && l.space_id === space_id
  );
  
  if (allLocksNow.length > 1) {
    // 竞争！按 acquired_at 排序，最早的赢；相同时间按 holder 字典序决胜
    const sorted = allLocksNow.sort((a, b) => {
      if (a.acquired_at !== b.acquired_at) return a.acquired_at - b.acquired_at;
      return a.holder.localeCompare(b.holder);
    });
    
    const winner = sorted[0];
    if (winner.holder !== agent_id) {
      // 我不是赢家 → 回滚自己的锁
      db.delete('eval_locks', l => l._nonce === lockRecord._nonce);
      console.log(`🔒 Eval lock conflict: ${agent_id} lost to ${winner.holder} (session: ${session_id})`);
      return res.json({ granted: false, held_by: winner.holder, reason: 'conflict_resolution' });
    }
    
    // 我是赢家 → 清理其他人的锁
    for (const loser of sorted.slice(1)) {
      db.delete('eval_locks', l => l._nonce === loser._nonce);
      console.log(`🔒 Eval lock conflict resolved: ${loser.holder} removed, ${agent_id} wins (session: ${session_id})`);
    }
  }
  
  console.log(`🔒 Eval lock granted: ${agent_id} (session: ${session_id}, responders: ${responseLimit.responders_count}/${responseLimit.limits.soft}s/${responseLimit.limits.hard}h)`);
  res.json({
    granted: true,
    lock_version: lockRecord._nonce,
    first_responder: getFirstResponder(space_id, session_id),
    responders_count: responseLimit.responders_count,
    response_limit: responseLimit.level,  // 'normal' | 'soft_limited'
    is_mentioned: responseLimit.is_mentioned,
    responders: (getRoundResponders(space_id, session_id)?.responders || []).map(r => ({ agent_id: r.agent_id, agent_name: r.agent_name })),
  });
});

// Release evaluation lock
app.post('/api/spaces/:space_id/sessions/:session_id/eval/release', (req, res) => {
  const { space_id, session_id } = req.params;
  const { agent_id, lock_version } = req.body;
  
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }
  
  const lock = db.findOne('eval_locks', l => 
    l.session_id === session_id && l.space_id === space_id
  );
  
  if (!lock) {
    return res.json({ released: true, was_already_free: true });
  }
  
  if (lock.holder !== agent_id) {
    return res.status(403).json({ error: 'Lock held by another agent', held_by: lock.holder });
  }

  // 🆕 Nonce guard: if caller provides lock_version, only release when it matches.
  // This prevents a stale job's .finally() from releasing a newer job's lock.
  if (lock_version && lock._nonce !== lock_version) {
    console.log(`🔒 Eval lock release REJECTED (stale nonce): ${agent_id} sent ${lock_version}, current ${lock._nonce} (session: ${session_id})`);
    return res.json({ released: false, reason: 'stale_nonce', current_nonce: lock._nonce });
  }
  
  db.delete('eval_locks', l => l.session_id === session_id && l.space_id === space_id);
  
  console.log(`🔓 Eval lock released: ${agent_id} (session: ${session_id})`);
  
  // 🆕 Broadcast eval_lock_released so WS-connected agents can retry
  // Without this, agents denied the lock during WS event handling are never woken up
  broadcastToSpace(space_id, {
    type: 'eval_lock_released',
    space_id,
    session_id,
    released_by: agent_id,
    ...getSpaceBroadcastMeta(space_id),
  });
  
  res.json({ released: true });
});

// ==================== Hard Interrupt (强制中断) ====================
// UI 级别的硬中断：立即终止 session 中所有 agent 的工作
// 1. 释放所有 eval lock
// 2. Finalize 所有 streaming 消息
// 3. WS 广播 session_interrupted 事件 → plugin 收到后 abort 所有活跃 job
app.post('/api/spaces/:space_id/sessions/:session_id/interrupt', (req, res) => {
  const { space_id, session_id } = req.params;
  const now = Date.now();
  
  // 1. 释放该 session 所有 eval lock
  const locks = db.findAll('eval_locks', l => 
    l.session_id === session_id && l.space_id === space_id
  );
  for (const lock of locks) {
    db.delete('eval_locks', l => l.session_id === session_id && l.space_id === space_id && l.holder === lock.holder);
    console.log(`⏹ [INTERRUPT] Released eval lock: ${lock.holder} (session: ${session_id})`);
  }
  
  // 2. Finalize 所有 streaming 消息
  const streamingMsgs = db.findAll('messages', m =>
    m.session_id === session_id && m.space_id === space_id &&
    m.content?.streaming === true && m.from_agent !== 'human'
  );
  for (const msg of streamingMsgs) {
    db.update('messages',
      m => m.message_id === msg.message_id && m.space_id === space_id,
      { content: { ...msg.content, streaming: false, result: (msg.content.result || '') + '\n\n⏹ 已被用户中断' }, updated_at: new Date().toISOString() }
    );
    console.log(`⏹ [INTERRUPT] Finalized streaming message ${msg.message_id} from ${msg.from_agent}`);
  }
  
  // 3. 强制 quiesce session（防止中断后 agent 继续被触发）
  const key = `${space_id}:${session_id}`;
  sessionQuiesce.set(key, { no_reply_agents: new Set(), quiesced: true });
  
  // 3.5 设置毒丸时间戳（阻止 abort 传播期间 agent 重新获锁）
  sessionInterruptedAt.set(key, now);
  
  // 4. WS 广播 session_interrupted → plugin 收到后 abort 所有活跃 job
  broadcastToSpace(space_id, {
    type: 'session_interrupted',
    space_id,
    session_id,
    interrupted_at: now,
    released_locks: locks.map(l => l.holder),
    finalized_messages: streamingMsgs.length,
    ...getSpaceBroadcastMeta(space_id),
  });
  
  console.log(`⏹ [INTERRUPT] Session ${session_id} hard-interrupted: ${locks.length} locks released, ${streamingMsgs.length} streaming msgs finalized`);
  
  res.json({ 
    success: true, 
    released_locks: locks.length, 
    finalized_messages: streamingMsgs.length 
  });
});

// ==================== First Responder 查询 ====================

app.get('/api/spaces/:space_id/sessions/:session_id/first-responder', (req, res) => {
  const { space_id, session_id } = req.params;
  const roundInfo = getRoundResponders(space_id, session_id);
  res.json({
    first_responder: getFirstResponder(space_id, session_id),
    responders_count: roundInfo ? roundInfo.responders.length : 0,
    responders: roundInfo ? roundInfo.responders.map(r => ({ agent_id: r.agent_id, agent_name: r.agent_name })) : [],
  });
});

// ==================== NO_REPLY 通知（轻量级，不创建消息）====================

// Agent 决定不发言时，通知 server 用于 quiesce 追踪（不创建任何消息）
app.post('/api/spaces/:space_id/sessions/:session_id/no-reply', (req, res) => {
  const { space_id, session_id } = req.params;
  const { agent_id } = req.body;
  
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }
  
  addNoReply(space_id, session_id, agent_id);
  const quiesced = isSessionQuiesced(space_id, session_id);
  
  console.log(`🤫 NO_REPLY notification: ${agent_id} (session: ${session_id})${quiesced ? ' → QUIESCED' : ''}`);
  res.json({ success: true, quiesced });
});

// ==================== Session Summary API ====================

// 获取 session summary
app.get('/api/spaces/:space_id/sessions/:session_id/summary', (req, res) => {
  const { space_id, session_id } = req.params;
  const summary = db.findOne('session_summaries', s => 
    s.session_id === session_id && s.space_id === space_id
  );
  if (!summary) {
    return res.json({ summary: null });
  }
  res.json({ summary });
});

// 更新 session summary（由 agent 生成）
app.put('/api/spaces/:space_id/sessions/:session_id/summary', (req, res) => {
  const { space_id, session_id } = req.params;
  const { summary_text, last_message_id, message_count, agent_id, title } = req.body;
  
  if (!summary_text || !agent_id) {
    return res.status(400).json({ error: 'summary_text and agent_id are required' });
  }

  const existing = db.findOne('session_summaries', s => 
    s.session_id === session_id && s.space_id === space_id
  );

  if (existing) {
    db.update('session_summaries',
      s => s.session_id === session_id && s.space_id === space_id,
      { summary_text, last_message_id, message_count: message_count || 0, updated_by: agent_id, updated_at: new Date().toISOString() }
    );
  } else {
    db.insert('session_summaries', {
      session_id,
      space_id,
      summary_text,
      last_message_id: last_message_id || null,
      message_count: message_count || 0,
      updated_by: agent_id,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
  }

    // Use LLM-provided title if available, fallback to regex extraction
  // Respect title_source priority: auto < summary < manual
  const autoTitle = title || generateTitleFromSummary(summary_text);
  let appliedTitle = null;
  if (autoTitle) {
    const currentSession = db.findOne('sessions', s => s.session_id === session_id && s.space_id === space_id);
    const currentSource = currentSession?.title_source || 'auto';
    // Never overwrite manual titles; summary can overwrite auto and previous summary
    if (currentSource !== 'manual') {
      db.update('sessions', s => s.session_id === session_id && s.space_id === space_id, { title: autoTitle, title_source: 'summary' });
      appliedTitle = autoTitle;
    }
  }

  console.log(`📝 Session summary updated: ${session_id} by ${agent_id} (${summary_text.length} chars)${appliedTitle ? ` → title: "${appliedTitle}"` : ''}`);
  res.json({ success: true, title: appliedTitle || null });
});

// Extract a short title from summary text
function generateTitleFromSummary(text) {
  if (!text || text.length < 10) return null;
  // Skip generic/template headings
  const genericTitles = /^(session\s*summary|会话总结|会议总结|summary|总结|摘要|概要|概述|overview|recap|任务概述|任务背景|任务总结|背景|background|项目概述|需求概述|问题概述)[\s（(（:：—\-]*$/i;
  
  // Try all markdown headings, pick the first non-generic one
  const headings = [...text.matchAll(/^#+\s+(.+)/gm)];
  for (const m of headings) {
    const h = m[1].replace(/[*_`#|]/g, '').trim();
    if (h.length > 0 && !genericTitles.test(h)) {
      return h.length > 40 ? h.slice(0, 37) + '...' : h;
    }
  }
  // Fallback: first non-empty, non-heading line
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  for (const line of lines) {
    const clean = line.replace(/[*_`|]/g, '').replace(/^[-\s>]+/, '').trim();
    if (clean.length > 3 && !genericTitles.test(clean)) {
      return clean.length > 40 ? clean.slice(0, 37) + '...' : clean;
    }
  }
  return null;
}

// ==================== Session Task Meta API ====================
// Stores task-level metadata (complexity level + designated reporter) per session.
// Used by the quiesce summary hook to determine if a summary should be triggered.

app.get('/api/spaces/:space_id/sessions/:session_id/task-meta', (req, res) => {
  const { space_id, session_id } = req.params;
  const meta = db.findOne('session_task_meta', m =>
    m.space_id === space_id && m.session_id === session_id
  );
  res.json({ task_meta: meta || null });
});

app.put('/api/spaces/:space_id/sessions/:session_id/task-meta', (req, res) => {
  const { space_id, session_id } = req.params;
  const { level, reporter } = req.body;

  if (!level || !['L1', 'L2', 'L3'].includes(level)) {
    return res.status(400).json({ error: 'level is required and must be L1, L2, or L3' });
  }
  if (level === 'L3' && !reporter) {
    return res.status(400).json({ error: 'reporter is required for L3 tasks' });
  }

  const now = Date.now();
  const existing = db.findOne('session_task_meta', m =>
    m.space_id === space_id && m.session_id === session_id
  );

  if (existing) {
    db.update('session_task_meta',
      m => m.space_id === space_id && m.session_id === session_id,
      { level, reporter: reporter || null, updated_at: now }
    );
  } else {
    db.insert('session_task_meta', {
      space_id, session_id, level, reporter: reporter || null,
      created_at: now, updated_at: now,
    });
  }

  console.log(`📋 Task meta set: ${session_id} level=${level} reporter=${reporter || 'none'}`);
  res.json({ success: true, level, reporter: reporter || null });
});

// ==================== Files API（Space 文件共享）====================

// 上传文件（base64 方式，Agent 友好）
app.post('/api/spaces/:space_id/files', (req, res) => {
  const { space_id } = req.params;
  const { filename, content_base64, content_text, mime_type, uploaded_by, description } = req.body;
  
  if (!filename) return res.status(400).json({ error: 'filename is required' });
  if (!content_base64 && !content_text) return res.status(400).json({ error: 'content_base64 or content_text is required' });
  
  const file_id = `file_${nanoid(10)}`;
  const ext = pathMod.extname(filename) || '';
  const storedName = `${file_id}${ext}`;
  const filePath = pathMod.join(FILES_DIR, storedName);
  
  // 写入文件
  if (content_base64) {
    fs.writeFileSync(filePath, Buffer.from(content_base64, 'base64'));
  } else {
    fs.writeFileSync(filePath, content_text, 'utf-8');
  }
  
  const stat = fs.statSync(filePath);
  const record = {
    file_id,
    space_id,
    filename,
    stored_name: storedName,
    mime_type: mime_type || 'application/octet-stream',
    size: stat.size,
    uploaded_by: uploaded_by || 'unknown',
    description: description || '',
    created_at: new Date().toISOString(),
  };
  
  // 使用 db.insert 而非直接 mutate + db.save，避免触发全量索引重建
  db.insert('space_files', record);
  
  console.log(`[Files] ${uploaded_by || '?'} uploaded ${filename} (${file_id}) to space ${space_id}`);
  res.status(201).json({ file_id, filename, size: stat.size, download_url: `/api/spaces/${space_id}/files/${file_id}/download` });
});

// 上传文件（multipart form-data，Web UI 友好）
app.post('/api/spaces/:space_id/files/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const { space_id } = req.params;
  const rawFilename = req.headers['x-filename'] || `upload_${Date.now()}`;
  const filename = decodeURIComponent(rawFilename);
  const uploaded_by = req.headers['x-uploaded-by'] || 'human';
  const description = req.headers['x-description'] || '';
  
  const file_id = `file_${nanoid(10)}`;
  const ext = pathMod.extname(filename) || '';
  const storedName = `${file_id}${ext}`;
  const filePath = pathMod.join(FILES_DIR, storedName);
  
  fs.writeFileSync(filePath, req.body);
  const stat = fs.statSync(filePath);
  
  const record = {
    file_id,
    space_id,
    filename,
    stored_name: storedName,
    mime_type: req.headers['content-type'] || 'application/octet-stream',
    size: stat.size,
    uploaded_by,
    description,
    created_at: new Date().toISOString(),
  };
  
  // 使用 db.insert 而非直接 mutate + db.save，避免触发全量索引重建
  db.insert('space_files', record);
  
  console.log(`[Files] ${uploaded_by} uploaded ${filename} (${file_id}) to space ${space_id}`);
  res.status(201).json({ file_id, filename, size: stat.size, download_url: `/api/spaces/${space_id}/files/${file_id}/download` });
});

// 列出 space 的文件
app.get('/api/spaces/:space_id/files', (req, res) => {
  const { space_id } = req.params;
  const data = db.get();
  const files = (data.space_files || [])
    .filter(f => f.space_id === space_id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  res.json({ files });
});

// 下载文件
app.get('/api/spaces/:space_id/files/:file_id/download', (req, res) => {
  const { space_id, file_id } = req.params;
  const data = db.get();
  const record = (data.space_files || []).find(f => f.file_id === file_id && f.space_id === space_id);
  if (!record) return res.status(404).json({ error: 'file not found' });
  
  const filePath = pathMod.join(FILES_DIR, record.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file missing from storage' });
  
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.filename)}"`);
  res.setHeader('Content-Type', record.mime_type);
  res.sendFile(filePath);
});

// 获取文件内容（文本文件直接返回内容，Agent 友好）
app.get('/api/spaces/:space_id/files/:file_id/content', (req, res) => {
  const { space_id, file_id } = req.params;
  const data = db.get();
  const record = (data.space_files || []).find(f => f.file_id === file_id && f.space_id === space_id);
  if (!record) return res.status(404).json({ error: 'file not found' });
  
  const filePath = pathMod.join(FILES_DIR, record.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file missing from storage' });
  
  const content = fs.readFileSync(filePath, 'utf-8');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(content);
});

// 删除文件
app.delete('/api/spaces/:space_id/files/:file_id', (req, res) => {
  const { space_id, file_id } = req.params;
  const data = db.get();
  const idx = (data.space_files || []).findIndex(f => f.file_id === file_id && f.space_id === space_id);
  if (idx === -1) return res.status(404).json({ error: 'file not found' });
  
  const record = data.space_files[idx];
  const filePath = pathMod.join(FILES_DIR, record.stored_name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  
  data.space_files.splice(idx, 1);
  db.save(data);
  console.log(`[Files] Deleted ${record.filename} (${file_id}) from space ${space_id}`);
  res.json({ status: 'deleted' });
});

// ==================== Link Preview ====================
const linkPreviewCache = new Map();
const LINK_PREVIEW_TTL = 3600000; // 1 hour
const LINK_PREVIEW_MAX_CACHE = 1000;
const linkPreviewRateMap = new Map(); // IP → { count, resetAt }
const LINK_PREVIEW_RATE_LIMIT = 30; // per minute
const LINK_PREVIEW_RATE_WINDOW = 60000;

// Robust private IP check (covers IPv4, IPv6, mapped, link-local, loopback)
function isPrivateHost(hostname) {
  // Normalize: strip IPv6 brackets
  const h = hostname.replace(/^\[|\]$/g, '');
  
  // IPv6 checks
  if (h === '::1' || h === '::') return true;
  if (h.toLowerCase().startsWith('fc') || h.toLowerCase().startsWith('fd')) return true; // fc00::/7
  if (h.toLowerCase().startsWith('fe80')) return true; // link-local
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);
  
  // Try parsing as IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h);
  
  // Known hostnames
  if (['localhost', 'metadata.google.internal'].includes(h.toLowerCase())) return true;
  
  // Block hex/octal IP representations (0x7f000001, 017700000001, etc.)
  if (/^0[xX][0-9a-fA-F]+$/.test(h) || /^0\d+$/.test(h)) return true;
  // Decimal integer IP (2130706433 = 127.0.0.1)
  if (/^\d{8,}$/.test(h)) return true;
  
  return false;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true; // malformed = block
  const [a, b] = parts;
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
  if (a === 0) return true;                            // 0.0.0.0/8
  return false;
}

app.get('/api/link-preview', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Rate limiting (per IP)
  const clientIP = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let rl = linkPreviewRateMap.get(clientIP);
  if (!rl || now > rl.resetAt) { rl = { count: 0, resetAt: now + LINK_PREVIEW_RATE_WINDOW }; linkPreviewRateMap.set(clientIP, rl); }
  rl.count++;
  if (rl.count > LINK_PREVIEW_RATE_LIMIT) return res.status(429).json({ error: 'rate limit exceeded' });

  // URL validation + SSRF prevention
  let parsed;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'only http/https URLs allowed' });
    }
    if (isPrivateHost(parsed.hostname)) {
      return res.status(403).json({ error: 'internal URLs not allowed' });
    }
  } catch { return res.status(400).json({ error: 'invalid URL' }); }

  // Check cache
  const cached = linkPreviewCache.get(url);
  if (cached && now - cached.ts < LINK_PREVIEW_TTL) {
    return res.json(cached.data);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let response;

    // Manual redirect following with SSRF check at each hop
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; A2ASpace/1.0; LinkPreview)' },
        redirect: 'manual',
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) break;
        // Resolve relative redirects
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          clearTimeout(timeout);
          return res.json({ url, error: 'redirect to non-http' });
        }
        if (isPrivateHost(nextUrl.hostname)) {
          clearTimeout(timeout);
          return res.status(403).json({ error: 'redirect to internal URL blocked' });
        }
        currentUrl = nextUrl.href;
        continue;
      }
      break;
    }
    clearTimeout(timeout);

    if (!response || !response.ok) return res.json({ url, error: 'fetch failed' });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return res.json({ url, title: parsed.hostname, type: contentType.split(';')[0] });
    }

    // Read first 50KB only (reuse single TextDecoder)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let bytesRead = 0;
    while (bytesRead < 50000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.length;
    }
    try { reader.cancel(); } catch {}

    // Parse OG/meta tags
    const getTag = (name) => {
      const re1 = new RegExp(`<meta[^>]*(?:property|name)=["']${name}["'][^>]*content=["']([^"']*?)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]*content=["']([^"']*?)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
      return (html.match(re1) || html.match(re2) || [])[1] || '';
    };

    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';

    const data = {
      url,
      title: getTag('og:title') || getTag('twitter:title') || titleTag,
      description: getTag('og:description') || getTag('twitter:description') || getTag('description'),
      image: getTag('og:image') || getTag('twitter:image'),
      site_name: getTag('og:site_name') || parsed.hostname,
    };

    // Try to find favicon
    const favMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*?)["']/i) ||
                     html.match(/<link[^>]*href=["']([^"']*?)["'][^>]*rel=["'](?:shortcut )?icon["']/i);
    if (favMatch) {
      let fav = favMatch[1];
      if (fav.startsWith('//')) fav = 'https:' + fav;
      else if (fav.startsWith('/')) fav = parsed.origin + fav;
      else if (!fav.startsWith('http')) fav = parsed.origin + '/' + fav;
      data.favicon = fav;
    } else {
      data.favicon = parsed.origin + '/favicon.ico';
    }

    // Make relative image URLs absolute
    if (data.image) {
      if (data.image.startsWith('//')) data.image = 'https:' + data.image;
      else if (data.image.startsWith('/')) data.image = parsed.origin + data.image;
      else if (!data.image.startsWith('http')) data.image = parsed.origin + '/' + data.image;
    }

    // LRU eviction: drop oldest when over limit
    if (linkPreviewCache.size >= LINK_PREVIEW_MAX_CACHE) {
      const oldest = linkPreviewCache.keys().next().value;
      linkPreviewCache.delete(oldest);
    }
    linkPreviewCache.set(url, { ts: now, data });
    res.json(data);
  } catch (err) {
    res.json({ url, error: err.message });
  }
});

// ==================== Skill Directory（自动目录生成）====================

const SKILL_DIRECTORY_NAME = '_space_skill_directory';
const SKILL_DIRECTORY_MAX_ENTRIES = 50;

/**
 * 为指定 space 重新生成 Skill 目录（机械列表，作为基线）
 * Agent 通过 PUT /skill-directory 可以用 LLM 生成的智能目录覆盖
 */
function generateSkillDirectory(space_id, { force = false } = {}) {
  // Skip auto-gen if directory was manually curated by an agent (unless force=true)
  if (!force) {
    const existing = db.findOne('skills', s =>
      s.space_id === space_id && s.name === SKILL_DIRECTORY_NAME && s.is_system === true
    );
    if (existing?.metadata?.author && existing.metadata.author !== 'system') {
      console.log(`📋 Skill directory for ${space_id} is agent-curated (by ${existing.metadata.author}), skipping auto-gen`);
      return;
    }
  }

  const allSkills = db.findAll('skills', s =>
    s.space_id === space_id && s.status === 'active' && !s.is_system
  );
  allSkills.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const totalCount = allSkills.length;
  let directoryMd;

  if (totalCount === 0) {
    directoryMd = '_当前 Space 暂无 Skill。_';
  } else {
    const displaySkills = allSkills.slice(0, SKILL_DIRECTORY_MAX_ENTRIES);
    const lines = displaySkills.map(s => {
      let desc = s.description || '';
      if (!desc && s.skill_md) {
        const cleaned = s.skill_md.replace(/^#.*\n?/, '').replace(/\n/g, ' ').trim();
        desc = cleaned.substring(0, 80);
        if (cleaned.length > 80) desc += '...';
      }
      const tags = (s.metadata?.tags || []).join(', ');
      return `- **${s.name}**${desc ? `: ${desc}` : ''}${tags ? ` [${tags}]` : ''}`;
    });
    directoryMd = lines.join('\n');
    if (totalCount > SKILL_DIRECTORY_MAX_ENTRIES) {
      directoryMd += `\n\n_共 ${totalCount} 个 skill，以上为最近 ${SKILL_DIRECTORY_MAX_ENTRIES} 条。完整列表请查询 API。_`;
    }
  }

  // 保存到 DB
  const existing = db.findOne('skills', s =>
    s.space_id === space_id && s.name === SKILL_DIRECTORY_NAME && s.is_system === true
  );

  if (existing) {
    db.update('skills',
      s => s.skill_id === existing.skill_id,
      {
        skill_md: directoryMd,
        description: `本 Space 的 Skill 目录（共 ${totalCount} 个）`,
        skill_count: totalCount,
        updated_at: new Date().toISOString(),
      }
    );
  } else {
    const skill_id = `skill_${nanoid(10)}`;
    db.insert('skills', {
      skill_id,
      space_id,
      name: SKILL_DIRECTORY_NAME,
      version: '1.0.0',
      description: `本 Space 的 Skill 目录（共 ${totalCount} 个）`,
      skill_md: directoryMd,
      metadata: { author: 'system', tags: ['system', 'directory'] },
      fitness_score: 1.0,
      usage_count: 0,
      skill_count: totalCount,
      status: 'active',
      is_system: true,
      author: 'system',
      created_at: new Date().toISOString(),
    });
  }
  console.log(`📋 Skill directory updated for space ${space_id} (${totalCount} skills)`);
}

// 获取 skill 目录（独立 API，plugin 用）
app.get('/api/spaces/:space_id/skill-directory', (req, res) => {
  const { space_id } = req.params;
  const dirSkill = db.findOne('skills', s =>
    s.space_id === space_id && s.name === SKILL_DIRECTORY_NAME && s.is_system === true
  );
  if (!dirSkill) {
    return res.json({ exists: false, content: '' });
  }
  res.json({
    exists: true,
    content: dirSkill.skill_md,
    skill_count: dirSkill.skill_count || 0,
    updated_at: dirSkill.updated_at || dirSkill.created_at,
    last_updated_by: dirSkill.last_updated_by || null,
  });
});

// Agent 更新 skill 目录内容（用 LLM 整理后的语义化目录覆盖机械列表）
app.put('/api/spaces/:space_id/skill-directory', readonlyGuard, (req, res) => {
  const { space_id } = req.params;
  const { content, agent_id } = req.body;
  
  if (!content) return res.status(400).json({ error: 'content is required' });
  
  const existing = db.findOne('skills', s =>
    s.space_id === space_id && s.name === SKILL_DIRECTORY_NAME && s.is_system === true
  );
  
  if (existing) {
    const updatedMetadata = { ...(existing.metadata || {}), author: agent_id || 'unknown' };
    db.update('skills',
      s => s.skill_id === existing.skill_id,
      {
        skill_md: content,
        metadata: updatedMetadata,
        updated_at: new Date().toISOString(),
        last_updated_by: agent_id || 'unknown',
      }
    );
  } else {
    // 如果还没有目录，先创建
    const skill_id = `skill_${nanoid(10)}`;
    db.insert('skills', {
      skill_id,
      space_id,
      name: SKILL_DIRECTORY_NAME,
      version: '1.0.0',
      description: '本 Space 的 Skill 目录',
      skill_md: content,
      metadata: { author: agent_id || 'system', tags: ['system', 'directory'] },
      fitness_score: 1.0,
      usage_count: 0,
      skill_count: 0,
      status: 'active',
      is_system: true,
      author: agent_id || 'system',
      created_at: new Date().toISOString(),
      last_updated_by: agent_id || 'unknown',
    });
  }
  
  console.log(`📋 Skill directory manually updated for space ${space_id} by ${agent_id || 'unknown'} (${content.length} chars)`);
  res.json({ success: true, updated_at: new Date().toISOString() });
});

// Admin: 批量重建所有 space 的 skill directory
app.post('/api/admin/rebuild-skill-directories', readonlyGuard, (req, res) => {
  const { force = false } = req.body || {};
  const allSpaces = db.findAll('spaces');
  const results = [];
  for (const space of allSpaces) {
    try {
      generateSkillDirectory(space.space_id, { force });
      const dir = db.findOne('skills', s =>
        s.space_id === space.space_id && s.name === SKILL_DIRECTORY_NAME && s.is_system === true
      );
      results.push({
        space_id: space.space_id,
        name: space.name,
        status: 'ok',
        directory_len: dir?.skill_md?.length || 0,
        author: dir?.metadata?.author || 'unknown',
      });
    } catch (e) {
      results.push({ space_id: space.space_id, name: space.name, status: 'error', error: e.message });
    }
  }
  console.log(`📋 Bulk rebuild skill directories: ${results.filter(r => r.status === 'ok').length}/${results.length} succeeded`);
  res.json({ rebuilt: results.length, results });
});

// 搜索 Space Skills（关键词匹配 name + description + tags + skill_md）
app.get('/api/spaces/:space_id/skills/search', (req, res) => {
  const { space_id } = req.params;
  const { q = '', status = 'active' } = req.query;
  const query = q.toLowerCase().trim();
  if (!query) return res.json({ skills: [], query: '' });

  const VALID_SKILL_STATUS = ['draft', 'active', 'archived'];

  let skills = db.findAll('skills', s => {
    if (s.space_id !== space_id) return false;
    if (s.is_system) return false;
    if (status !== 'all' && VALID_SKILL_STATUS.includes(status) && s.status !== status) return false;
    const haystack = [
      s.name || '',
      s.description || '',
      ...(s.metadata?.tags || []),
      s.skill_md || ''
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });

  // dedup: same name → keep newest
  const deduped = new Map();
  for (const s of skills) {
    const key = s.name;
    if (!deduped.has(key) || new Date(s.created_at) > new Date(deduped.get(key).created_at)) {
      deduped.set(key, s);
    }
  }

  const results = Array.from(deduped.values()).map(s => ({
    skill_id: s.skill_id,
    name: s.name,
    version: s.version,
    description: s.description,
    status: s.status,
    tags: s.metadata?.tags || [],
    created_at: s.created_at
  }));

  res.json({ skills: results, query });
});

// Backfill：为所有存量 space 生成 skill 目录
app.post('/api/admin/backfill-skill-directories', (req, res) => {
  const spaces = db.findAll('spaces', () => true);
  const results = [];
  for (const space of spaces) {
    try {
      generateSkillDirectory(space.space_id);
      results.push({ space_id: space.space_id, name: space.name, status: 'ok' });
    } catch (err) {
      results.push({ space_id: space.space_id, name: space.name, status: 'error', error: err.message });
    }
  }
  res.json({ backfilled: results.length, results });
});

// ==================== Curator Notification ====================

// _curator space — 按 name 查找（space_id 是随机生成的，不同环境不同）
const CURATOR_SPACE_NAME = '_curator';
const CURATOR_SESSION_ID = process.env.CURATOR_SESSION_ID || 'session_default';

// 缓存解析后的 _curator space_id，避免每次都 findOne
let _curatorSpaceIdCache = null;
function resolveCuratorSpaceId() {
  if (_curatorSpaceIdCache) {
    // 验证缓存仍有效
    const still = db.findOne('spaces', s => s.space_id === _curatorSpaceIdCache);
    if (still) return _curatorSpaceIdCache;
    _curatorSpaceIdCache = null;
  }
  // 支持 env 直接指定 space_id（向后兼容）
  if (process.env.CURATOR_SPACE_ID) {
    const byId = db.findOne('spaces', s => s.space_id === process.env.CURATOR_SPACE_ID);
    if (byId) { _curatorSpaceIdCache = byId.space_id; return _curatorSpaceIdCache; }
  }
  // 默认按 name 查找
  const byName = db.findOne('spaces', s => s.name === CURATOR_SPACE_NAME);
  if (byName) { _curatorSpaceIdCache = byName.space_id; return _curatorSpaceIdCache; }
  return null;
}

/**
 * 异步通知 _curator space 有 skill 变更。
 * 三个硬性约束：
 * 1. 自排除 — source space 是 _curator 自己时不发通知（防无限递归）
 * 2. 异步 — 不阻塞 skill CRUD 响应
 * 3. 静默失败 — 通知出错不影响业务
 */
const CURATOR_ENABLED = (process.env.CURATOR_ENABLED || 'true').toLowerCase() === 'true';

function notifyCurator(sourceSpaceId, skillId, action, skillName) {
  if (!CURATOR_ENABLED) return; // curator 已禁用
  setImmediate(() => {
    try {
      const curatorSpaceId = resolveCuratorSpaceId();
      if (!curatorSpaceId) return; // _curator 还没创建，静默跳过

      // 硬排除：_curator 自身的 skill 变更不触发通知
      if (sourceSpaceId === curatorSpaceId) return;

      // 确保 session 存在
      let session = db.findOne('sessions', s =>
        s.session_id === CURATOR_SESSION_ID && s.space_id === curatorSpaceId
      );
      if (!session) {
        session = {
          session_id: CURATOR_SESSION_ID,
          space_id: curatorSpaceId,
          title: 'Curator Pipeline',
          created_at: new Date().toISOString(),
          created_by: 'system',
          status: 'active'
        };
        db.insert('sessions', session);
      }

      const message_id = `msg_${nanoid(10)}`;
      const eventMessage = {
        message_id,
        session_id: CURATOR_SESSION_ID,
        space_id: curatorSpaceId,
        from_agent: 'human',
        type: 'human_job',
        content: {
          job: `[skill_changed] space=${sourceSpaceId} skill="${skillName}" (${skillId}) action=${action}`,
          metadata: {
            event: 'skill_changed',
            source_space_id: sourceSpaceId,
            skill_id: skillId,
            action,
            skill_name: skillName,
          }
        },
        timestamp: new Date().toISOString()
      };

      db.insert('messages', eventMessage);

      // 通过 WebSocket 推送给 _curator 的订阅者
      broadcastToSpace(curatorSpaceId, {
        type: 'new_message',
        space_id: curatorSpaceId,
        session_id: CURATOR_SESSION_ID,
        message: eventMessage,
        ...getSpaceBroadcastMeta(curatorSpaceId),
      });

      console.log(`a2a-server: [curator] notified: ${action} skill "${skillName}" (${skillId}) from space ${sourceSpaceId}`);
    } catch (err) {
      // 静默失败 — 绝不影响 skill CRUD
      console.error(`a2a-server: [curator] notification failed (non-fatal): ${err.message}`);
    }
  });
}

// ==================== Space Permissions Middleware ====================
// Spaces can be marked readonly to prevent agents from modifying skills/config.
// Set via PATCH /api/spaces/:space_id { "permissions": { "skill_write": false } }
// or by including permissions in POST /api/spaces body.

function isSpaceReadonly(space_id) {
  const space = db.findOne('spaces', s => s.space_id === space_id);
  if (!space?.permissions) return false;
  return space.permissions.skill_write === false;
}

function readonlyGuard(req, res, next) {
  const { space_id } = req.params;
  if (isSpaceReadonly(space_id)) {
    return res.status(403).json({
      error: 'Space is read-only',
      detail: `Space ${space_id} has skill_write disabled. Modifications are not allowed.`
    });
  }
  next();
}

// ==================== Skills API ====================

// 贡献 Skill
app.post('/api/spaces/:space_id/skills', readonlyGuard, (req, res) => {
  const { space_id } = req.params;
  const { name, version, description, skill_md, metadata, status: reqStatus } = req.body;
  
  const VALID_SKILL_STATUS = ['draft', 'active', 'archived'];
  const status = VALID_SKILL_STATUS.includes(reqStatus) ? reqStatus : 'active';
  
  const skill_id = `skill_${nanoid(10)}`;
  
  const newSkill = {
    skill_id,
    space_id,
    name,
    version,
    description,
    skill_md,
    metadata,
    fitness_score: 0.5,
    usage_count: 0,
    status,
    author: metadata.author || 'unknown',
    created_at: new Date().toISOString()
  };
  
  db.insert('skills', newSkill);

  // 异步通知 _curator 进行知识策展
  notifyCurator(space_id, skill_id, 'created', name);

  // 自动更新 skill directory
  try { generateSkillDirectory(space_id); } catch (e) { console.error('Failed to update skill directory after create:', e); }
  
  res.status(201).json({ 
    skill_id,
    url: `/api/spaces/${space_id}/skills/${skill_id}`
  });
});

// 查询 Skills
app.get('/api/spaces/:space_id/skills', (req, res) => {
  const { space_id } = req.params;
  const { status = 'active', min_fitness = 0, include_system } = req.query;
  
  let skills = db.findAll('skills', s => 
    s.space_id === space_id &&
    (status === 'all' || s.status === status) &&
    s.fitness_score >= parseFloat(min_fitness) &&
    (include_system === 'true' || !s.is_system)
  );
  
  skills.sort((a, b) => b.fitness_score - a.fitness_score);
  
  const skillsWithUrls = skills.map(s => ({
    skill_id: s.skill_id,
    name: s.name,
    version: s.version,
    description: s.description,
    tags: s.metadata?.tags || [],
    fitness_score: s.fitness_score,
    usage_count: s.usage_count,
    status: s.status,
    author: s.author,
    created_at: s.created_at,
    download_url: `/api/spaces/${space_id}/skills/${s.skill_id}/download`
  }));
  
  res.json({ skills: skillsWithUrls });
});

// 下载 Skill
app.get('/api/spaces/:space_id/skills/:skill_id/download', (req, res) => {
  const { space_id, skill_id } = req.params;
  
  const skill = db.findOne('skills', s => s.skill_id === skill_id && s.space_id === space_id);
  
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  
  res.setHeader('Content-Type', 'text/markdown');
  res.send(skill.skill_md);
});

// 报告 Skill 使用情况
app.post('/api/spaces/:space_id/skills/:skill_id/usage', (req, res) => {
  const { space_id, skill_id } = req.params;
  const { agent_id, success, latency_ms, feedback } = req.body;
  
  // 记录使用日志
  db.insert('skill_usage', {
    skill_id,
    agent_id,
    success,
    latency_ms,
    feedback,
    timestamp: new Date().toISOString()
  });
  
  // 计算新的 fitness score
  const usageLogs = db.findAll('skill_usage', u => u.skill_id === skill_id);
  
  const successCount = usageLogs.filter(u => u.success).length;
  const success_rate = successCount / usageLogs.length;
  
  const totalLatency = usageLogs.reduce((sum, u) => sum + (u.latency_ms || 0), 0);
  const avg_latency = totalLatency / usageLogs.length;
  
  const totalFeedback = usageLogs.reduce((sum, u) => sum + (u.feedback || 0), 0);
  const avg_feedback = totalFeedback / usageLogs.length / 5.0;
  
  const fitness_score = (
    success_rate * 0.5 + 
    (1 - Math.min(avg_latency / 5000, 1)) * 0.3 +
    avg_feedback * 0.2
  );
  
  // 更新 skill
  db.update('skills',
    s => s.skill_id === skill_id && s.space_id === space_id,
    { 
      fitness_score: parseFloat(fitness_score.toFixed(2)),
      usage_count: usageLogs.length
    }
  );
  
  res.json({ 
    new_fitness_score: fitness_score.toFixed(2),
    usage_count: usageLogs.length
  });
});

// DELETE skill
app.delete('/api/spaces/:space_id/skills/:skill_id', readonlyGuard, (req, res) => {
  const { space_id, skill_id } = req.params;
  
  const skill = db.findOne('skills', s => s.skill_id === skill_id && s.space_id === space_id);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  
  db.delete('skills', s => s.skill_id === skill_id && s.space_id === space_id);

  // 异步通知 _curator 进行知识策展
  notifyCurator(space_id, skill_id, 'deleted', skill.name);

  // 自动更新 skill directory
  try { generateSkillDirectory(space_id); } catch (e) { console.error('Failed to update skill directory after delete:', e); }

  res.json({ deleted: skill_id });
});

// UPDATE skill
app.put('/api/spaces/:space_id/skills/:skill_id', readonlyGuard, (req, res) => {
  const { space_id, skill_id } = req.params;
  const { name, version, description, skill_md, metadata, status: reqStatus } = req.body;
  
  const VALID_SKILL_STATUS = ['draft', 'active', 'archived'];
  
  const skill = db.findOne('skills', s => s.skill_id === skill_id && s.space_id === space_id);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  
  const updates = {};
  if (name) updates.name = name;
  if (version) updates.version = version;
  if (description) updates.description = description;
  if (skill_md) updates.skill_md = skill_md;
  if (metadata) updates.metadata = metadata;
  if (VALID_SKILL_STATUS.includes(reqStatus)) updates.status = reqStatus;
  updates.updated_at = new Date().toISOString();
  
  const updated = db.update('skills', 
    s => s.skill_id === skill_id && s.space_id === space_id,
    updates
  );

  // 异步通知 _curator 进行知识策展
  notifyCurator(space_id, skill_id, 'updated', name || skill.name);

  // 自动更新 skill directory（status 变更也会影响目录）
  try { generateSkillDirectory(space_id); } catch (e) { console.error('Failed to update skill directory after update:', e); }
  
  res.json({ skill_id, updated: Object.keys(updates) });
});

// GET single skill (full detail)
app.get('/api/spaces/:space_id/skills/:skill_id', (req, res) => {
  const { space_id, skill_id } = req.params;
  
  const skill = db.findOne('skills', s => s.skill_id === skill_id && s.space_id === space_id);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  
  // 统一响应格式：tags 从 metadata.tags 提升到顶层（与列表接口一致）
  res.json({
    skill_id: skill.skill_id,
    space_id: skill.space_id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    skill_md: skill.skill_md,
    tags: skill.metadata?.tags || [],
    metadata: skill.metadata,
    fitness_score: skill.fitness_score,
    usage_count: skill.usage_count,
    status: skill.status,
    author: skill.author,
    created_at: skill.created_at,
    download_url: `/api/spaces/${space_id}/skills/${skill.skill_id}/download`
  });
});

// ==================== Sessions API ====================

// ==================== Orphaned Session Detection ====================
// 返回"孤立 session"：最后消息来自人类、无 eval lock、未 quiesced 的活跃 session。
// 用于 Gateway 重启后追回被遗漏的人类消息。
app.get('/api/spaces/:space_id/sessions/orphaned', (req, res) => {
  const { space_id } = req.params;
  const { max_age_hours = 24 } = req.query;
  const maxAgeMs = Number(max_age_hours) * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const sessions = db.findAll('sessions', s => s.space_id === space_id && s.status !== 'closed');
  const orphaned = [];

  for (const session of sessions) {
    const sid = session.session_id;

    // Skip quiesced sessions
    if (isSessionQuiesced(space_id, sid)) continue;

    // Skip sessions with active eval locks
    const locks = db.findAll('eval_locks', l => l.session_id === sid && l.space_id === space_id);
    const activeLocks = locks.filter(l => (Date.now() - l.acquired_at) < 60000);
    if (activeLocks.length > 0) continue;

    // Get last few messages
    const msgs = db.queryMessages(space_id, sid, null);
    if (msgs.length === 0) continue;

    // Find the last message
    const lastMsg = msgs[msgs.length - 1];

    // Skip if last message is too old
    if (lastMsg.timestamp < cutoff) continue;

    // Check if last substantive message is from human (skip system/resume messages)
    // Walk backwards to find the last non-system message
    let lastSubstantive = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      // Skip streaming placeholders
      if (m.content?.streaming === true) continue;
      // Skip NO_REPLY messages
      const result = typeof m.content?.result === 'string' ? m.content.result.trim() : '';
      if (/^\[?NO_REPLY\]?$/i.test(result)) continue;
      lastSubstantive = m;
      break;
    }

    if (!lastSubstantive) continue;

    // Orphaned = last substantive message is from human
    if (lastSubstantive.from_agent === 'human') {
      orphaned.push({
        session_id: sid,
        last_human_message_id: lastSubstantive.message_id,
        last_human_message_at: lastSubstantive.timestamp,
        message_preview: (lastSubstantive.content?.job || lastSubstantive.content?.message || '').substring(0, 100),
        total_messages: msgs.length,
      });
    }
  }

  console.log(`🔍 Orphan scan: space=${space_id}, found ${orphaned.length} orphaned session(s)`);
  res.json({ orphaned_sessions: orphaned });
});

// 创建新会话
app.post('/api/spaces/:space_id/sessions', (req, res) => {
  const { space_id } = req.params;
  const { title, created_by = 'human', session_id: requestedId } = req.body;
  
  const session_id = requestedId || `session_${nanoid(10)}`;
  
  const newSession = {
    session_id,
    space_id,
    title: title || `Session ${new Date().toLocaleString()}`,
    created_at: new Date().toISOString(),
    created_by,
    status: 'active'
  };
  
  db.insert('sessions', newSession);
  
  res.status(201).json(newSession);
});

// 获取所有会话
app.get('/api/spaces/:space_id/sessions', (req, res) => {
  const { space_id } = req.params;
  const { status } = req.query;
  
  let sessions = db.findAll('sessions', s => s.space_id === space_id);
  
  if (status) {
    sessions = sessions.filter(s => s.status === status);
  }
  
  // 获取每个 session 的消息数量和最后活动时间（使用索引查询）
  const sessionsWithStats = sessions.map(session => {
    const sessionMessages = db.queryMessages(session.space_id, session.session_id, null);
    const lastMessage = sessionMessages[sessionMessages.length - 1];
    
    return {
      ...session,
      message_count: sessionMessages.length,
      last_activity: lastMessage?.timestamp || session.created_at
    };
  });
  
  // 按最后活动时间排序
  sessionsWithStats.sort((a, b) => new Date(b.last_activity) - new Date(a.last_activity));
  
  res.json({ sessions: sessionsWithStats });
});

// 获取单个会话详情
app.get('/api/spaces/:space_id/sessions/:session_id', (req, res) => {
  const { space_id, session_id } = req.params;
  
  const session = db.findOne('sessions', s => 
    s.session_id === session_id && s.space_id === space_id
  );
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const messages = db.findAll('messages', m => m.session_id === session_id);
  
  res.json({ session, message_count: messages.length });
});

// Cleanup empty session (called via sendBeacon when user leaves page)
app.post('/api/spaces/:space_id/sessions/:session_id/cleanup', express.text({ type: '*/*' }), (req, res) => {
  const { space_id, session_id } = req.params;
  let body = {};
  try { body = JSON.parse(req.body || '{}'); } catch (e) { console.warn('[cleanup] JSON parse failed:', e.message); }
  
  if (body.action === 'archive_if_empty') {
    const session = db.findOne('sessions', s => s.session_id === session_id && s.space_id === space_id);
    // Race condition guard: don't cleanup sessions created less than 30s ago
    if (session && session.created_at) {
      const ageMs = Date.now() - new Date(session.created_at).getTime();
      if (ageMs < 30000) {
        return res.json({ success: true, skipped: 'too_young' });
      }
    }
    const msgs = db.findAll('messages', m => m.space_id === space_id && m.session_id === session_id);
    if (msgs.length === 0) {
      db.update('sessions', s => s.session_id === session_id && s.space_id === space_id, { status: 'closed', updated_at: new Date().toISOString() });
      console.log(`🧹 Auto-archived empty session: ${session_id}`);
    }
  }
  res.json({ success: true });
});

// 更新会话 (关闭/重命名)
app.patch('/api/spaces/:space_id/sessions/:session_id', (req, res) => {
  const { space_id, session_id } = req.params;
  const { title, status, muted_agents } = req.body;
  
  const session = db.findOne('sessions', s => 
    s.session_id === session_id && s.space_id === space_id
  );
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const updates = {};
  if (title) { updates.title = title; updates.title_source = 'manual'; }
  if (status) updates.status = status;
  if (Array.isArray(muted_agents)) updates.muted_agents = muted_agents;
  updates.updated_at = new Date().toISOString();
  
  db.update('sessions',
    s => s.session_id === session_id,
    updates
  );
  
  res.json({ success: true, ...updates });
});

// 获取/更新 session 的 Agent 配置（mute/solo）
app.get('/api/spaces/:space_id/sessions/:session_id/agent-config', (req, res) => {
  const { space_id, session_id } = req.params;
  const session = db.findOne('sessions', s => s.session_id === session_id && s.space_id === space_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  // 获取 space 成员列表
  const members = (db.get().space_members || []).filter(m => m.space_id === space_id);
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  const allAgentRecords = db.findAll('agents', () => true);
  
  const agentMap = new Map();
  for (const a of allAgentRecords) {
    const existing = agentMap.get(a.agent_id);
    if (!existing || new Date(a.last_heartbeat || 0) > new Date(existing.last_heartbeat || 0)) {
      agentMap.set(a.agent_id, a);
    }
  }
  
  const muted = session.muted_agents || [];
  const agents = members.map(m => {
    const info = agentMap.get(m.agent_id);
    const isOnline = info?.last_heartbeat && (now - new Date(info.last_heartbeat).getTime()) < ONLINE_THRESHOLD;
    return {
      agent_id: m.agent_id,
      name: info?.name || m.agent_id,
      status: isOnline ? 'online' : 'offline',
      muted: muted.includes(m.agent_id),
    };
  });
  
  res.json({ session_id, muted_agents: muted, agents });
});

app.patch('/api/spaces/:space_id/sessions/:session_id/agent-config', (req, res) => {
  const { space_id, session_id } = req.params;
  const { muted_agents } = req.body;
  
  const session = db.findOne('sessions', s => s.session_id === session_id && s.space_id === space_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  if (!Array.isArray(muted_agents)) return res.status(400).json({ error: 'muted_agents must be an array' });
  
  db.update('sessions', s => s.session_id === session_id, {
    muted_agents,
    updated_at: new Date().toISOString(),
  });
  
  console.log(`[AgentConfig] session ${session_id}: muted=[${muted_agents.join(',')}]`);
  res.json({ success: true, muted_agents });
});

// 获取会话内的消息
app.get('/api/spaces/:space_id/sessions/:session_id/messages', (req, res) => {
  const { space_id, session_id } = req.params;
  const { since, limit = 50 } = req.query;
  
  let messages = db.findAll('messages', m => 
    m.space_id === space_id && m.session_id === session_id
  );
  
  if (since) {
    const sinceDate = new Date(parseInt(since)).toISOString();
    messages = messages.filter(m => m.timestamp > sinceDate);
  }
  
  // 排序并限制数量
  messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  messages = messages.slice(-parseInt(limit));
  
  // 添加 from_name
  const data = db.get();
  const messagesWithNames = messages.map(m => {
    const agent = data.agents.find(a => a.agent_id === m.from_agent);
    return {
      ...m,
      from_name: agent ? agent.name : m.from_agent
    };
  });
  
  // 🆕 附带 eval_locks 供前端状态展示
  const now_ts = Date.now();
  const allLocks = (data.eval_locks || []).filter(l => l.space_id === space_id && l.session_id === session_id);
  const sessionLocks = allLocks.filter(l => (now_ts - l.acquired_at) < 60000).map(l => {
    const agent = data.agents.find(a => a.agent_id === l.holder && a.space_id === space_id);
    return { holder: l.holder, holder_name: agent ? agent.name : l.holder, acquired_at: l.acquired_at };
  });

  // 附带 no_reply_agents 供前端状态条展示流转
  const quiesceKey = space_id + ':' + session_id;
  const quiesceState = sessionQuiesce.get(quiesceKey);
  const noReplyAgents = quiesceState ? [...quiesceState.no_reply_agents].map(aid => {
    const agent = data.agents.find(a => a.agent_id === aid && a.space_id === space_id);
    return { agent_id: aid, name: agent ? agent.name : aid };
  }) : [];

  res.json({ 
    messages: messagesWithNames,
    next_since: Date.now(),
    eval_locks: sessionLocks,
    no_reply_agents: noReplyAgents,
    quiesced: quiesceState ? quiesceState.quiesced : false,
    first_responder: getFirstResponder(space_id, session_id),
    responders_count: getRoundRespondersCount(space_id, session_id),
  });
});

// 向会话发送消息
app.post('/api/spaces/:space_id/sessions/:session_id/messages', (req, res) => {
  const { space_id, session_id } = req.params;
  const { from, type, content } = req.body;

  // 🛡️ 防止插入空消息（ghost message prevention）
  if (!from || !type || !content || typeof content !== 'object') {
    console.warn(`a2a-server: rejecting message insert: missing required fields`, { session_id, from, type, hasContent: !!content });
    return res.status(400).json({ error: 'Missing required fields: from, type, content (object)' });
  }
  
  if (isDuplicateMessage(space_id, session_id, from, content)) {
    console.log(`a2a-server: dedup: duplicate message blocked (${from}@${session_id})`);
    return res.status(200).json({ message_id: 'dedup', session_id, deduplicated: true });
  }
  
  // 验证 session 存在
  const session = db.findOne('sessions', s => 
    s.session_id === session_id && s.space_id === space_id
  );
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // 🆕 Lock Version Guard: reject orphan writes from agents whose lock has been superseded
  const { lock_version } = req.body;
  if (lock_version && from !== 'human') {
    const lv = validateLockVersion(space_id, session_id, lock_version);
    if (!lv.valid) {
      console.log(`🛡️ Lock version guard BLOCKED session POST: ${from}@${session_id} reason=${lv.reason}`);
      return res.status(409).json({ error: 'lock_version_mismatch', reason: lv.reason, expected: lv.expected });
    }
  }

  const message_id = `msg_${nanoid(10)}`;
  
  const newMessage = {
    message_id,
    session_id,
    space_id,
    from_agent: from,
    type,
    content,
    timestamp: new Date().toISOString()
  };
  
  db.insert('messages', newMessage);

  // 🆕 Quiesce tracking: 人类消息重置静默状态
  if (from === 'human') {
    resetQuiesce(space_id, session_id, true); // isHumanMessage=true → clears summaryRequested
    clearRoundResponders(space_id, session_id);
    // 预初始化，记录 trigger message ID
    const rrKey2 = `${space_id}:${session_id}`;
    roundResponders.set(rrKey2, { responders: [], trigger_message_id: message_id });
  }

  // 人类发的第一条消息 → 自动更新 session 标题
  if (from === 'human') {
    const humanText = content?.job || content?.message || '';
    if (humanText) {
      const humanMsgsInSession = db.findAll('messages', m =>
        m.session_id === session_id && m.from_agent === 'human'
      );
      // 只有当这是该 session 的第一条人类消息时才更新标题
      if (humanMsgsInSession.length <= 1) {
        const currentSession = db.findOne('sessions', s => s.session_id === session_id);
        const currentSource = currentSession?.title_source || 'auto';
        if (currentSource === 'auto' || !currentSession?.title) {
          const title = humanText.length > 40 ? humanText.substring(0, 40) + '...' : humanText;
          db.update('sessions', s => s.session_id === session_id, { title, title_source: 'auto' });
        }
      }
    }
  }
  
  // 🆕 WebSocket push: broadcast new message to connected clients
  broadcastToSpace(space_id, {
    type: 'new_message',
    space_id,
    session_id,
    message: newMessage,
    ...getSpaceBroadcastMeta(space_id),
  });

  res.status(201).json({ 
    message_id,
    session_id,
    timestamp: newMessage.timestamp 
  });
});

// ==================== OpenClaw Plugin API ====================

// Plugin 目录 (从 a2a-space 项目往上找到 extensions)
// Plugin 目录 — 按优先级探测：repo 同级 → OpenClaw extensions (相对) → $HOME extensions
const PLUGIN_DIR = (() => {
  const pluginName = 'a2a-space';
  const candidates = [
    pathMod.resolve(__dirname, '..', 'plugin'),                              // repo sibling
    pathMod.resolve(__dirname, '../../..', `extensions/${pluginName}`),       // relative to workspace
    pathMod.join(process.env.HOME || '~', `.openclaw/extensions/${pluginName}`), // $HOME fallback
  ];
  for (const p of candidates) {
    if (fs.existsSync(pathMod.join(p, 'package.json')) && fs.existsSync(pathMod.join(p, 'src'))) return p;
  }
  return candidates[0]; // default to repo path
})();

// 获取 plugin 信息
app.get('/api/plugin/info', (req, res) => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(pathMod.join(PLUGIN_DIR, 'package.json'), 'utf-8'));
    const pluginJson = JSON.parse(fs.readFileSync(pathMod.join(PLUGIN_DIR, 'openclaw.plugin.json'), 'utf-8'));
    
    res.json({
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description,
      plugin: pluginJson,
      files: getPluginFiles()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read plugin info', details: err.message });
  }
});

// 获取 plugin 文件列表
function getPluginFiles() {
  const files = [];
  
  // 根目录文件
  const rootFiles = ['index.ts', 'package.json', 'openclaw.plugin.json', 'README.md'];
  rootFiles.forEach(f => {
    if (fs.existsSync(pathMod.join(PLUGIN_DIR, f))) {
      files.push(f);
    }
  });
  
  // src 目录文件
  const srcDir = pathMod.join(PLUGIN_DIR, 'src');
  if (fs.existsSync(srcDir)) {
    fs.readdirSync(srcDir).forEach(f => {
      if (f.endsWith('.ts')) {
        files.push(`src/${f}`);
      }
    });
  }
  
  return files;
}

// 列出所有 plugin 文件
app.get('/api/plugin/files', (req, res) => {
  try {
    res.json({ files: getPluginFiles() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files', details: err.message });
  }
});

// 下载单个文件
app.get('/api/plugin/files/:filepath(*)', (req, res) => {
  try {
    const filepath = req.params.filepath;
    const fullPath = pathMod.join(PLUGIN_DIR, filepath);
    
    // 安全检查：确保路径在 PLUGIN_DIR 内
    if (!fullPath.startsWith(PLUGIN_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read file', details: err.message });
  }
});

// 下载完整 plugin (所有文件打包为 JSON)
app.get('/api/plugin/download', (req, res) => {
  try {
    const files = getPluginFiles();
    const bundle = {};
    
    files.forEach(f => {
      const fullPath = pathMod.join(PLUGIN_DIR, f);
      if (fs.existsSync(fullPath)) {
        bundle[f] = fs.readFileSync(fullPath, 'utf-8');
      }
    });
    
    res.json({
      name: 'a2aspace',
      version: '2.0.0',
      files: bundle,
      install_path: '~/.openclaw/extensions/a2a-space'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bundle plugin', details: err.message });
  }
});

// 获取安装脚本
app.get('/api/plugin/install-script', (req, res) => {
  const reqHost = req.get('host');
  const apiUrl = `http://${reqHost}/api`;
  const baseUrl = `http://${reqHost}`;

  let currentVersion = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(pathMod.join(PLUGIN_DIR, 'package.json'), 'utf-8'));
    currentVersion = pkg.version || '0.0.0';
  } catch {}

  // Check if plugin files are actually available — refuse to serve a doomed script
  const pluginAvailable = fs.existsSync(pathMod.join(PLUGIN_DIR, 'package.json'));
  if (!pluginAvailable) {
    console.warn(`[install-script] PLUGIN_DIR (${PLUGIN_DIR}) has no package.json — refusing to serve install script`);
    return res.status(503).type('text/plain').send(
      `# ERROR: Server cannot serve plugin files.\n` +
      `# PLUGIN_DIR (${PLUGIN_DIR}) does not contain plugin source code.\n` +
      `# Deploy with plugin/ directory alongside server.js, or see README.\n` +
      `echo "❌ Server at ${baseUrl} cannot serve plugin files (misconfigured PLUGIN_DIR)"; exit 1\n`
    );
  }

  const files = getPluginFiles();

  // Build script using array to avoid JS template literal escaping issues
  const L = [];

  // ── Header ──
  L.push('#!/bin/bash');
  L.push(`# Atheism Plugin — Install & Configure (v${currentVersion})`);
  L.push(`# Run: curl -sL ${apiUrl}/plugin/install-script | bash`);
  L.push('#');
  L.push('# Environment overrides:');
  L.push('#   A2A_AGENT_ID    - Agent ID on the server (default: auto-detect)');
  L.push('#   A2A_AGENT_NAME  - Agent display name');
  L.push('#   A2A_SPACE_ID    - Space to join (default: first available)');
  L.push('');

  // ── Variables ──
  L.push('PLUGIN_DIR="$HOME/.openclaw/extensions/a2a-space"');
  L.push(`API_URL="${apiUrl}"`);
  L.push(`BASE_URL="${baseUrl}"`);
  L.push(`REMOTE_VERSION="${currentVersion}"`);
  L.push('CONFIG_FILE="$HOME/.openclaw/openclaw.json"');
  L.push('ERRORS=0');
  L.push('');

  // ── Download helper with validation ──
  L.push('download_file() {');
  L.push('  local url="$1" dest="$2"');
  L.push('  local http_code');
  L.push('  http_code=$(curl -sL -w "%{http_code}" -o "$dest" "$url")');
  L.push('  if [ "$http_code" != "200" ]; then');
  L.push('    echo "  ❌ HTTP $http_code: $(basename "$dest")"');
  L.push('    rm -f "$dest"');
  L.push('    ERRORS=$((ERRORS + 1))');
  L.push('    return 1');
  L.push('  fi');
  L.push('  local size');
  L.push('  size=$(wc -c < "$dest" | tr -d " ")');
  L.push('  if [ "$size" -lt 50 ]; then');
  L.push('    echo "  ❌ Too small (${size}B): $(basename "$dest")"');
  L.push('    rm -f "$dest"');
  L.push('    ERRORS=$((ERRORS + 1))');
  L.push('    return 1');
  L.push('  fi');
  L.push('}');
  L.push('');

  // ── Step 0: Preflight ──
  L.push('echo ""');
  L.push('echo "🚀 Atheism Plugin Installer"');
  L.push('echo ""');
  L.push('');
  L.push('command -v curl >/dev/null 2>&1 || { echo "❌ curl is required"; exit 1; }');
  L.push('command -v node >/dev/null 2>&1 || { echo "❌ node is required"; exit 1; }');
  L.push('');
  L.push('if ! curl -sf "$BASE_URL/for-agents" >/dev/null 2>&1; then');
  L.push('  echo "❌ Cannot reach server at $BASE_URL"');
  L.push('  exit 1');
  L.push('fi');
  L.push('echo "✅ Server: $BASE_URL"');
  L.push('');

  // ── Step 1: Version check (don't exit — config/register may still be needed) ──
  L.push('SKIP_DOWNLOAD=false');
  L.push('if [ -f "$PLUGIN_DIR/package.json" ]; then');
  L.push("  LOCAL_VERSION=$(grep '\"version\"' \"$PLUGIN_DIR/package.json\" | head -1 | sed 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/')");
  L.push('  if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then');
  L.push('    echo "✅ Plugin up to date (v$LOCAL_VERSION) — checking config..."');
  L.push('    SKIP_DOWNLOAD=true');
  L.push('  else');
  L.push('    echo "🔄 Updating: v$LOCAL_VERSION → v$REMOTE_VERSION"');
  L.push('  fi');
  L.push('else');
  L.push('  echo "📦 Installing v$REMOTE_VERSION"');
  L.push('fi');
  L.push('');

  // ── Step 2: Download files (skip if already up to date) ──
  L.push('if [ "$SKIP_DOWNLOAD" = "false" ]; then');
  L.push('mkdir -p "$PLUGIN_DIR/src"');
  L.push('echo ""');
  L.push('echo "📥 Downloading plugin files..."');
  for (const f of files) {
    L.push(`download_file "$API_URL/plugin/files/${f}" "$PLUGIN_DIR/${f}"`);
  }
  L.push('');
  L.push('if [ "$ERRORS" -gt 0 ]; then');
  L.push('  echo ""');
  L.push('  echo "❌ $ERRORS file(s) failed to download."');
  L.push('  echo "   Server may need plugin/ directory alongside server.js"');
  L.push('  exit 1');
  L.push('fi');
  L.push('echo "✅ Plugin files downloaded"');
  L.push('');

  // ── Step 3: npm install ──
  L.push('echo ""');
  L.push('echo "📦 Installing npm dependencies..."');
  L.push('(cd "$PLUGIN_DIR" && npm install --production 2>&1 | tail -3)');
  L.push('if [ ! -d "$PLUGIN_DIR/node_modules" ]; then');
  L.push('  echo "❌ npm install failed"');
  L.push('  exit 1');
  L.push('fi');
  L.push('echo "✅ Dependencies installed"');

  // close SKIP_DOWNLOAD block
  L.push('fi');  // end if SKIP_DOWNLOAD=false
  L.push('');

  // ── Step 4: Auto-configure ──
  L.push("if node -e 'const c=JSON.parse(require(\"fs\").readFileSync(process.env.HOME+\"/.openclaw/openclaw.json\",\"utf-8\")); process.exit(c.channels&&c.channels.a2aspace?0:1)' 2>/dev/null; then");
  L.push('  echo ""');
  L.push('  echo "📝 Config already has a2aspace channel — skipping auto-config"');
  L.push('  echo "   Restart gateway to apply plugin update: openclaw gateway restart"');
  L.push('else');
  L.push('  echo ""');
  L.push('  echo "⚙️  Configuring openclaw.json..."');
  L.push('');

  // Detect space
  L.push('  if [ -z "$A2A_SPACE_ID" ]; then');
  L.push('    A2A_SPACE_ID=$(curl -sf "$API_URL/spaces" 2>/dev/null | grep -o \'"space_id":"[^"]*"\' | head -1 | sed \'s/.*"space_id":"\\([^"]*\\)".*/\\1/\')');
  L.push('  fi');
  L.push('');
  L.push('  if [ -z "$A2A_SPACE_ID" ]; then');
  L.push(`    A2A_SPACE_ID=$(curl -sf -X POST "$API_URL/spaces" -H "Content-Type: application/json" -d '{"name":"Default Space","description":"Created by installer"}' 2>/dev/null | grep -o '"space_id":"[^"]*"' | sed 's/.*"space_id":"\\([^"]*\\)".*/\\1/')`);
  L.push('    if [ -n "$A2A_SPACE_ID" ]; then');
  L.push('      echo "   Created new space: $A2A_SPACE_ID"');
  L.push('    fi');
  L.push('  fi');
  L.push('');
  L.push('  if [ -z "$A2A_SPACE_ID" ]; then');
  L.push('    echo "  ⚠️  No space available and could not create one."');
  L.push('    echo "     Create a space in the web UI, then re-run this script with:"');
  L.push('    echo "     A2A_SPACE_ID=your_space_id curl -sL $API_URL/plugin/install-script | bash"');
  L.push('    SPACE_ID=""');
  L.push('  else');
  L.push('    SPACE_ID="$A2A_SPACE_ID"');
  L.push('  fi');
  L.push('  if [ -n "$SPACE_ID" ]; then');
  L.push('    echo "   Space: $SPACE_ID"');
  L.push('  fi');
  L.push('');

  // Node heredoc for config merge (single-quoted delimiter = no bash expansion inside)
  L.push('  RESULT_FILE=$(mktemp)');
  L.push('  SCRIPT_FILE=$(mktemp)');
  L.push("  cat > \"$SCRIPT_FILE\" << 'NODESCRIPT'");

  // ── Node config merger — 3-agent demo ──
  L.push('const fs = require("fs");');
  L.push('const pathMod = require("path");');
  L.push('const configPath = process.env.A2A_CFG_FILE;');
  L.push('const apiUrl = process.env.A2A_CFG_API_URL;');
  L.push('const spaceId = process.env.A2A_CFG_SPACE_ID || "*";');
  L.push('const resultFile = process.env.A2A_CFG_RESULT;');
  L.push('');
  L.push('let config = {};');
  L.push('try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}');
  L.push('');
  L.push('// 3 demo agents');
  L.push('const demoAgents = [');
  L.push('  { serverId: "agent_coder", listId: "demo-coder", name: "Coder",');
  L.push('    caps: ["coding","debugging","system-design"], desc: "Full-stack developer",');
  L.push('    soul: "You are Coder, a full-stack software engineer. Focus on implementation, clean code, and solving technical problems. Be concise and provide code examples when relevant." },');
  L.push('  { serverId: "agent_researcher", listId: "demo-researcher", name: "Researcher",');
  L.push('    caps: ["research","analysis","summarization"], desc: "Information researcher",');
  L.push('    soul: "You are Researcher, an information specialist. Focus on gathering, analyzing, and synthesizing information. Be well-structured and evidence-based." },');
  L.push('  { serverId: "agent_planner", listId: "demo-planner", name: "Planner",');
  L.push('    caps: ["planning","requirement-analysis","product-design"], desc: "Product planner",');
  L.push('    soul: "You are Planner, a product strategist. Focus on requirements, user needs, and project planning. Think about the big picture and provide actionable next steps." }');
  L.push('];');
  L.push('');
  L.push('if (!config.agents) config.agents = {};');
  L.push('if (!config.agents.list) config.agents.list = [];');
  L.push('');
  L.push('const homeDir = process.env.HOME || "/root";');
  L.push('const baseWs = pathMod.join(homeDir, ".openclaw", "workspace-demo");');
  L.push('');
  L.push('for (const agent of demoAgents) {');
  L.push('  const wsDir = pathMod.join(baseWs, agent.listId);');
  L.push('  fs.mkdirSync(wsDir, { recursive: true });');
  L.push('  fs.writeFileSync(pathMod.join(wsDir, "SOUL.md"), "# " + agent.name + "\\n\\n" + agent.soul + "\\n");');
  L.push('  if (!config.agents.list.find(a => a.id === agent.listId)) {');
  L.push('    config.agents.list.push({ id: agent.listId, name: agent.name, workspace: wsDir });');
  L.push('  }');
  L.push('}');
  L.push('');
  L.push('if (!config.channels) config.channels = {};');
  L.push('config.channels.a2aspace = {');
  L.push('  enabled: true, apiUrl: apiUrl, spaceId: spaceId,');
  L.push('  agents: demoAgents.map(a => ({ agentId: a.serverId, agentName: a.name, capabilities: a.caps, description: a.desc })),');
  L.push('  pollIntervalMs: 3000, maxConcurrent: 3');
  L.push('};');
  L.push('');
  L.push('if (!config.plugins) config.plugins = {};');
  L.push('if (!config.plugins.entries) config.plugins.entries = {};');
  L.push('config.plugins.entries.a2aspace = { enabled: true };');
  L.push('');
  L.push('if (!config.bindings) config.bindings = [];');
  L.push('for (const agent of demoAgents) {');
  L.push('  if (!config.bindings.some(b => b.match && b.match.peer && b.match.peer.id === agent.serverId)) {');
  L.push('    config.bindings.push({ agentId: agent.listId, match: { channel: "a2aspace", peer: { kind: "direct", id: agent.serverId } } });');
  L.push('  }');
  L.push('}');
  L.push('');
  L.push('fs.copyFileSync(configPath, configPath + ".bak");');
  L.push('fs.writeFileSync(configPath, JSON.stringify(config, null, 2));');
  L.push('const agentIds = demoAgents.map(a => a.serverId).join(",");');
  L.push('fs.writeFileSync(resultFile, agentIds + "\\n" + spaceId + "\\n");');
  L.push('console.log("   Agents: " + demoAgents.map(a => a.name).join(", "));');
  L.push('NODESCRIPT');
  L.push('  A2A_CFG_API_URL="$API_URL" A2A_CFG_SPACE_ID="$SPACE_ID" \\');
  L.push('  A2A_CFG_FILE="$CONFIG_FILE" A2A_CFG_RESULT="$RESULT_FILE" \\');
  L.push('  node "$SCRIPT_FILE"');
  L.push('  rm -f "$SCRIPT_FILE"');
  // ── End of node config merger ──

  L.push('');
  L.push('  if [ $? -eq 0 ]; then');
  L.push('    echo "✅ Config written (3 agents)"');
  L.push('    A2A_AGENT_IDS=$(sed -n "1p" "$RESULT_FILE")');
  L.push('    SPACE_ID=$(sed -n "2p" "$RESULT_FILE")');
  L.push('  else');
  L.push('    echo "  ⚠️  Auto-config failed. You may need to edit $CONFIG_FILE manually."');
  L.push('  fi');
  L.push('  rm -f "$RESULT_FILE"');
  L.push('fi');  // end auto-config block
  L.push('');

  // ── Step 5: Register agents to space ──
  L.push('if [ -z "$A2A_AGENT_IDS" ]; then');
  L.push('  A2A_AGENT_IDS="agent_coder,agent_researcher,agent_planner"');
  L.push('fi');
  L.push('if [ -z "$SPACE_ID" ]; then');
  L.push("  SPACE_ID=$(node -e 'const c=JSON.parse(require(\"fs\").readFileSync(process.env.HOME+\"/.openclaw/openclaw.json\",\"utf-8\")); console.log(c.channels&&c.channels.a2aspace&&c.channels.a2aspace.spaceId||\"\")')");
  L.push('fi');
  L.push('');
  L.push('if [ -n "$A2A_AGENT_IDS" ] && [ -n "$SPACE_ID" ] && [ "$SPACE_ID" != "*" ]; then');
  L.push('  echo ""');
  L.push('  echo "🔗 Registering agents in space..."');
  L.push('  IFS="," read -ra AGENT_ARRAY <<< "$A2A_AGENT_IDS"');
  L.push('  for AID in "${AGENT_ARRAY[@]}"; do');
  L.push('    REG=$(curl -sf -X POST "$API_URL/spaces/$SPACE_ID/members" \\');
  L.push('      -H "Content-Type: application/json" \\');
  L.push('      -d "{\\"agent_id\\": \\"$AID\\"}" 2>/dev/null || echo "")');
  L.push('    if echo "$REG" | grep -q "joined\\|already_member"; then');
  L.push('      echo "   ✅ $AID registered"');
  L.push('    fi');
  L.push('  done');
  L.push('fi');
  L.push('');

  // ── Step 6: Restart gateway ──
  L.push('echo ""');
  L.push('echo "🔄 Restarting OpenClaw gateway..."');
  L.push('OPENCLAW_BIN=""');
  L.push('if command -v openclaw >/dev/null 2>&1; then');
  L.push('  OPENCLAW_BIN="openclaw"');
  L.push('else');
  L.push('  for p in "$HOME/.npm-global/bin/openclaw" /usr/local/bin/openclaw /snap/bin/openclaw "$HOME/.local/bin/openclaw"; do');
  L.push('    if [ -x "$p" ]; then OPENCLAW_BIN="$p"; break; fi');
  L.push('  done');
  L.push('fi');
  L.push('if [ -n "$OPENCLAW_BIN" ]; then');
  L.push('  "$OPENCLAW_BIN" gateway restart 2>&1 || echo "  ⚠️  Gateway restart returned non-zero (may still work)"');
  L.push('else');
  L.push('  echo "  ⚠️  openclaw not found. Restart gateway manually: openclaw gateway restart"');
  L.push('fi');
  L.push('');

  // ── Step 7: Demo — create session + seed message ──
  L.push('echo ""');
  L.push('echo "🎯 Setting up demo space..."');
  L.push('echo "   Waiting for gateway to load plugin..."');
  L.push('sleep 8');
  L.push('');
  L.push('if [ -n "$SPACE_ID" ] && [ "$SPACE_ID" != "*" ]; then');
  L.push('  DEMO_SESSION=$(curl -sf -X POST "$API_URL/spaces/$SPACE_ID/sessions" \\');
  L.push('    -H "Content-Type: application/json" \\');
  L.push("    -d '{\"name\":\"Welcome\"}' 2>/dev/null | grep -o '\"session_id\":\"[^\"]*\"' | sed 's/.*\"session_id\":\"\\([^\"]*\\)\".*/\\1/')");
  L.push('  if [ -n "$DEMO_SESSION" ]; then');
  L.push('    echo "   ✅ Demo session created"');
  L.push('    curl -sf -X POST "$API_URL/spaces/$SPACE_ID/sessions/$DEMO_SESSION/messages" \\');
  L.push('      -H "Content-Type: application/json" \\');
  L.push("      -d '{\"from\":\"human\",\"type\":\"human_message\",\"content\":{\"text\":\"Hello! 这是一个新搭建的多Agent协作空间。请每位Agent简短介绍一下自己。\"}}' >/dev/null 2>&1");
  L.push('    echo "   ✅ Seed message sent — agents will start responding shortly"');
  L.push('  else');
  L.push('    echo "   ⚠️  Could not create demo session (gateway may still be loading)"');
  L.push('    echo "   Open the web UI to create a session manually."');
  L.push('  fi');
  L.push('fi');
  L.push('');

  // ── Done ──
  L.push('echo ""');
  L.push('echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"');
  L.push('echo "🎉 Atheism — Multi-Agent Demo Ready!"');
  L.push('echo ""');
  L.push(`echo "   🌐 Web UI:  ${baseUrl}"`);
  L.push(`echo "   📖 Docs:    ${baseUrl}/architecture.html"`);
  L.push('echo "   🤖 Agents:  Coder, Researcher, Planner"');
  L.push('echo ""');
  L.push('echo "   Open the web UI to see agents collaborating!"');
  L.push('echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"');
  L.push('echo ""');

  res.type('text/plain').send(L.join('\n'));
});

// ==================== Skill Document API ====================

// 直接返回统一的 skill 文档（方便 agent 直接获取）
app.get('/api/skill', (req, res) => {
  const skillPath = pathMod.join(__dirname, 'public', 'skill.md');
  if (fs.existsSync(skillPath)) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(fs.readFileSync(skillPath, 'utf-8'));
  } else {
    res.status(404).json({ error: 'Skill document not found' });
  }
});

// 也支持 /skill.md 路径直接访问
app.get('/skill.md', (req, res) => {
  const skillPath = pathMod.join(__dirname, 'public', 'skill.md');
  if (fs.existsSync(skillPath)) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(fs.readFileSync(skillPath, 'utf-8'));
  } else {
    res.status(404).json({ error: 'Skill document not found' });
  }
});

// ==================== Artifacts API ====================
// Agent 上传可视化内容（HTML/图表等），server 存储并返回 URL

const ARTIFACTS_DIR = pathMod.join(__dirname, 'public', 'artifacts');
if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// 上传 artifact
app.post('/api/spaces/:space_id/artifacts', (req, res) => {
  const { space_id } = req.params;
  const { html, content, name, session_id, type = 'html' } = req.body;
  
  const body = html || content;
  if (!body) {
    return res.status(400).json({ error: 'html or content is required' });
  }
  
  // 生成唯一文件名
  const ext = type === 'html' ? '.html' : '.txt';
  const safeName = (name || 'artifact').replace(/[^a-zA-Z0-9_-]/g, '_');
  const artifactId = `${safeName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filename = artifactId + ext;
  const filepath = pathMod.join(ARTIFACTS_DIR, filename);
  
  // 如果是 HTML，包装成完整文档（如果不是的话）
  let finalContent = body;
  if (type === 'html' && !body.trim().toLowerCase().startsWith('<!doctype') && !body.trim().toLowerCase().startsWith('<html')) {
    finalContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeName}</title>
<style>
  body { margin: 0; padding: 16px; font-family: -apple-system, system-ui, sans-serif; background: #fff; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  }
  
  fs.writeFileSync(filepath, finalContent, 'utf-8');
  
  // 构建 URL（使用请求的 host）
  const reqHost = req.get('host');
  const url = `http://${reqHost}/artifacts/${filename}`;
  
  console.log(`[Artifact] ${space_id}/${session_id || 'unknown'}: ${filename} (${finalContent.length} bytes)`);
  
  res.json({
    artifact_id: artifactId,
    filename,
    url,
    size: finalContent.length,
  });
});

// 列出 artifacts
app.get('/api/spaces/:space_id/artifacts', (req, res) => {
  const files = fs.readdirSync(ARTIFACTS_DIR)
    .filter(f => f.endsWith('.html') || f.endsWith('.txt'))
    .map(f => {
      const stat = fs.statSync(pathMod.join(ARTIFACTS_DIR, f));
      const reqHost = req.get('host');
      return {
        filename: f,
        url: `http://${reqHost}/artifacts/${f}`,
        size: stat.size,
        created_at: stat.birthtime.toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  
  res.json({ artifacts: files });
});

// artifacts 持久保留，不自动清理

// ==================== Skill 全局搜索 ====================

app.get('/api/skills/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ skills: [] });
  const skills = db.findAll('skills', s =>
    s.status === 'active' && !s.is_system && (
      (s.name || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.metadata?.tags || []).some(t => t.toLowerCase().includes(q))
    )
  );
  // 去重（同名 skill 只返回最新版本）
  const deduped = new Map();
  for (const s of skills) {
    const key = s.name;
    if (!deduped.has(key) || new Date(s.created_at) > new Date(deduped.get(key).created_at)) {
      deduped.set(key, s);
    }
  }
  res.json({ skills: Array.from(deduped.values()).map(s => ({
    skill_id: s.skill_id,
    source_space_id: s.space_id,
    name: s.name,
    version: s.version,
    description: s.description,
    tags: s.metadata?.tags || [],
    created_at: s.created_at
  }))});
});

// ==================== Skill Packs API（全局 Skill 包）====================

// 获取所有 skill packs
app.get('/api/skill-packs', (req, res) => {
  const packs = db.findAll('skill_packs');
  res.json({ packs });
});

// 创建/更新 skill pack
app.post('/api/skill-packs', (req, res) => {
  const { tag, name, description } = req.body;
  if (!tag || !name) return res.status(400).json({ error: 'tag and name required' });

  const existing = db.findOne('skill_packs', p => p.tag === tag);
  if (existing) {
    const updated = db.update('skill_packs', p => p.tag === tag, { name, description, updated_at: new Date().toISOString() });
    return res.json(updated);
  }

  const pack = { tag, name, description, created_at: new Date().toISOString() };
  db.insert('skill_packs', pack);
  res.status(201).json(pack);
});

// 获取 pack 下的所有 skills（跨 space 按 tag 聚合）
app.get('/api/skill-packs/:tag/skills', (req, res) => {
  const { tag } = req.params;
  const skills = db.findAll('skills', s =>
    s.status === 'active' && s.metadata?.tags?.includes(tag)
  );
  res.json({ tag, skills: skills.map(s => ({
    skill_id: s.skill_id,
    source_space_id: s.space_id,
    name: s.name,
    version: s.version,
    description: s.description,
    author: s.author,
    created_at: s.created_at
  }))});
});

// 获取 pack 下的所有 files（跨 space 按 tag 聚合）
app.get('/api/skill-packs/:tag/files', (req, res) => {
  const { tag } = req.params;
  const data = db.get();
  const files = (data.space_files || []).filter(f => f.tags?.includes(tag));
  res.json({ tag, files });
});

// 给 skill 添加 pack tag
app.post('/api/skill-packs/:tag/add-skill', (req, res) => {
  const { tag } = req.params;
  const { skill_id } = req.body;
  if (!skill_id) return res.status(400).json({ error: 'skill_id required' });

  const skill = db.findOne('skills', s => s.skill_id === skill_id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });

  const tags = skill.metadata?.tags || [];
  if (!tags.includes(tag)) {
    tags.push(tag);
    db.update('skills', s => s.skill_id === skill_id, { metadata: { ...skill.metadata, tags } });
  }
  res.json({ success: true, skill_id, tags });
});

// 批量给 skills 添加 pack tag
app.post('/api/skill-packs/:tag/add-skills', (req, res) => {
  const { tag } = req.params;
  const { skill_ids } = req.body;
  if (!Array.isArray(skill_ids)) return res.status(400).json({ error: 'skill_ids array required' });

  const results = [];
  for (const skill_id of skill_ids) {
    const skill = db.findOne('skills', s => s.skill_id === skill_id);
    if (!skill) { results.push({ skill_id, error: 'not found' }); continue; }
    const tags = skill.metadata?.tags || [];
    if (!tags.includes(tag)) {
      tags.push(tag);
      db.update('skills', s => s.skill_id === skill_id, { metadata: { ...skill.metadata, tags } });
    }
    results.push({ skill_id, tags });
  }
  res.json({ success: true, results });
});

// 给 file 添加 pack tag
app.post('/api/skill-packs/:tag/add-file', (req, res) => {
  const { tag } = req.params;
  const { file_id } = req.body;
  if (!file_id) return res.status(400).json({ error: 'file_id required' });

  const data = db.get();
  const file = (data.space_files || []).find(f => f.file_id === file_id);
  if (!file) return res.status(404).json({ error: 'file not found' });

  if (!file.tags) file.tags = [];
  if (!file.tags.includes(tag)) {
    file.tags.push(tag);
    db.save(data);
  }
  res.json({ success: true, file_id, tags: file.tags });
});

// 批量给 files 添加 pack tag
app.post('/api/skill-packs/:tag/add-files', (req, res) => {
  const { tag } = req.params;
  const { file_ids } = req.body;
  if (!Array.isArray(file_ids)) return res.status(400).json({ error: 'file_ids array required' });

  const data = db.get();
  const results = [];
  for (const file_id of file_ids) {
    const file = (data.space_files || []).find(f => f.file_id === file_id);
    if (!file) { results.push({ file_id, error: 'not found' }); continue; }
    if (!file.tags) file.tags = [];
    if (!file.tags.includes(tag)) file.tags.push(tag);
    results.push({ file_id, tags: file.tags });
  }
  db.save(data);
  res.json({ success: true, results });
});

// 将 pack 中的 skills 和 files 克隆到目标 space
app.post('/api/skill-packs/:tag/deploy', (req, res) => {
  const { tag } = req.params;
  const { target_space_id } = req.body;
  if (!target_space_id) return res.status(400).json({ error: 'target_space_id required' });

  const data = db.get();
  const sourceSkills = data.skills.filter(s =>
    s.status === 'active' && s.metadata?.tags?.includes(tag) && !s.metadata?.source_pack
  );
  const sourceFiles = (data.space_files || []).filter(f => f.tags?.includes(tag) && !f.source_file_id);

  const deployed = { skills: [], files: [] };

  // 克隆 skills
  for (const src of sourceSkills) {
    // 检查目标 space 是否已有同名 skill
    const existing = data.skills.find(s => s.space_id === target_space_id && s.name === src.name);
    if (existing) {
      deployed.skills.push({ name: src.name, action: 'skipped', reason: 'already exists' });
      continue;
    }
    const newSkill = {
      ...src,
      skill_id: `skill_${nanoid(10)}`,
      space_id: target_space_id,
      metadata: { ...src.metadata, source_pack: tag, source_skill_id: src.skill_id },
      created_at: new Date().toISOString()
    };
    data.skills.push(newSkill);
    deployed.skills.push({ name: src.name, skill_id: newSkill.skill_id, action: 'cloned' });
  }

  // 克隆 files metadata (物理文件共享，不复制)
  for (const src of sourceFiles) {
    const existing = (data.space_files || []).find(f => f.space_id === target_space_id && f.filename === src.filename);
    if (existing) {
      deployed.files.push({ filename: src.filename, action: 'skipped', reason: 'already exists' });
      continue;
    }
    const newFile = {
      ...src,
      file_id: `file_${nanoid(10)}`,
      space_id: target_space_id,
      tags: [...(src.tags || []), tag],
      source_file_id: src.file_id,
      created_at: new Date().toISOString()
    };
    const srcPath = pathMod.join(FILES_DIR, src.file_id);
    const dstPath = pathMod.join(FILES_DIR, newFile.file_id);
    if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
      fs.copyFileSync(srcPath, dstPath);
    }
    data.space_files = data.space_files || [];
    data.space_files.push(newFile);
    deployed.files.push({ filename: src.filename, file_id: newFile.file_id, action: 'cloned' });
  }

  db.save(data);
  res.json({ success: true, tag, target_space_id, deployed });
});

// ==================== Collaboration Ledger API ====================
// Agent-granularity collaboration context: slots (per-agent) + notes (shared)
// Spec: collaboration-ledger-v2-spec

const SLOT_MAX_CHARS = 280;
const NOTE_MAX_CHARS = 120;
const RENDER_MAX_CHARS = 1800;
const RENDER_NOTES_MAX = 10;
const RENDER_NOTES_BUDGET = 800;

// --- Render ledger to AI-optimized text ---
function renderLedger(slots, notes) {
  // slots sorted by updated_at desc (most recent first)
  const sorted = [...slots].sort((a, b) => b.updated_at - a.updated_at);
  const lines = [];

  // Header: pure fact count
  lines.push(`[ledger] ${sorted.length} slot${sorted.length !== 1 ? 's' : ''} | ${notes.length} note${notes.length !== 1 ? 's' : ''}`);

  // Slot lines
  for (const s of sorted) {
    lines.push(`[slot:${s.agent_id}] ${s.content}`);
  }

  // Notes: most recent first (but render oldest-first so chronological), limit 10 & 800 chars
  const recent = [...notes].sort((a, b) => b.created_at - a.created_at).slice(0, RENDER_NOTES_MAX);
  recent.reverse(); // oldest first for chronological reading
  let notesBudget = RENDER_NOTES_BUDGET;
  const noteLines = [];
  for (const n of recent) {
    const line = `[ctx] ${n.content}`;
    if (notesBudget - line.length < 0 && noteLines.length > 0) break;
    noteLines.push(line);
    notesBudget -= line.length;
  }
  lines.push(...noteLines);

  // Truncation: total ≤ 1800 chars
  let rendered = lines.join('\n');
  if (rendered.length <= RENDER_MAX_CHARS) return rendered;

  // Step 1: trim notes to 400 chars (including \n separators)
  const headerAndSlots = lines.slice(0, 1 + sorted.length);
  let trimmedNotes = [...noteLines];
  const notesSize = (arr) => arr.length === 0 ? 0 : arr.reduce((s, l) => s + l.length, 0) + arr.length - 1; // chars + \n between lines
  while (trimmedNotes.length > 0) {
    const candidate = [...headerAndSlots, ...trimmedNotes].join('\n');
    if (candidate.length <= RENDER_MAX_CHARS) return candidate;
    if (notesSize(trimmedNotes) <= 400) break;
    trimmedNotes.shift(); // drop oldest note
  }

  // Step 2: drop oldest slots (never truncate within a slot)
  const slotLines = headerAndSlots.slice(1); // without header
  while (slotLines.length > 0) {
    const candidate = [headerAndSlots[0], ...slotLines, ...trimmedNotes].join('\n');
    if (candidate.length <= RENDER_MAX_CHARS) return candidate;
    slotLines.pop(); // drop oldest (last in desc-sorted array = oldest)
  }

  // Fallback: header + notes only
  return [headerAndSlots[0], ...trimmedNotes].join('\n').slice(0, RENDER_MAX_CHARS);
}

// PUT /ledger/slots/:agent_id — upsert agent slot
app.put('/api/spaces/:space_id/sessions/:session_id/ledger/slots/:agent_id', (req, res) => {
  const { space_id, session_id, agent_id } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required (string)' });
  }
  if (content.length > SLOT_MAX_CHARS) {
    return res.status(400).json({ error: `content exceeds ${SLOT_MAX_CHARS} chars (got: ${content.length})` });
  }

  const now = Date.now();
  const existing = db.findOne('ledger_slots', s =>
    s.space_id === space_id && s.session_id === session_id && s.agent_id === agent_id
  );

  if (existing) {
    db.update('ledger_slots',
      s => s.space_id === space_id && s.session_id === session_id && s.agent_id === agent_id,
      { content, updated_at: now }
    );
  } else {
    db.insert('ledger_slots', { space_id, session_id, agent_id, content, updated_at: now });
  }

  console.log(`📋 Ledger slot updated: ${agent_id} in ${session_id} (${content.length} chars)`);
  res.json({ agent_id, content, updated_at: now });
});

// POST /ledger/notes — append shared note
app.post('/api/spaces/:space_id/sessions/:session_id/ledger/notes', (req, res) => {
  const { space_id, session_id } = req.params;
  const { content, author } = req.body;

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required (string)' });
  }
  if (content.length > NOTE_MAX_CHARS) {
    return res.status(400).json({ error: `content exceeds ${NOTE_MAX_CHARS} chars (got: ${content.length})` });
  }
  if (!author) {
    return res.status(400).json({ error: 'author is required' });
  }

  const note = {
    id: `ln_${nanoid(8)}`,
    space_id,
    session_id,
    author,
    content,
    created_at: Date.now()
  };
  db.insert('ledger_notes', note);

  console.log(`📋 Ledger note added: "${content.slice(0, 40)}..." by ${author} in ${session_id}`);
  res.status(201).json(note);
});

// GET /ledger/notes — query notes across sessions in a space
app.get('/api/spaces/:space_id/ledger/notes', (req, res) => {
  const { space_id } = req.params;
  const { limit = '20', since, author, session_id } = req.query;
  const limitN = Math.min(Math.max(parseInt(limit) || 20, 1), 100);

  let notes = db.findAll('ledger_notes', n => {
    if (n.space_id !== space_id) return false;
    if (session_id && n.session_id !== session_id) return false;
    if (author && n.author !== author) return false;
    if (since && n.created_at < parseInt(since)) return false;
    return true;
  });

  notes.sort((a, b) => b.created_at - a.created_at); // newest first
  const total = notes.length;
  notes = notes.slice(0, limitN);

  res.json({ notes, total, limit: limitN });
});

// GET /ledger — full ledger with rendered text
app.get('/api/spaces/:space_id/sessions/:session_id/ledger', (req, res) => {
  const { space_id, session_id } = req.params;

  const slots = db.findAll('ledger_slots', s =>
    s.space_id === space_id && s.session_id === session_id
  );
  const notes = db.findAll('ledger_notes', n =>
    n.space_id === space_id && n.session_id === session_id
  );
  notes.sort((a, b) => a.created_at - b.created_at);

  const rendered = (slots.length === 0 && notes.length === 0)
    ? null
    : renderLedger(slots, notes);

  res.json({ slots, notes, rendered });
});

// DELETE /ledger — clear entire ledger for session
app.delete('/api/spaces/:space_id/sessions/:session_id/ledger', (req, res) => {
  const { space_id, session_id } = req.params;

  const slotCount = db.findAll('ledger_slots', s =>
    s.space_id === space_id && s.session_id === session_id
  ).length;
  const noteCount = db.findAll('ledger_notes', n =>
    n.space_id === space_id && n.session_id === session_id
  ).length;

  db.delete('ledger_slots', s => s.space_id === space_id && s.session_id === session_id);
  db.delete('ledger_notes', n => n.space_id === space_id && n.session_id === session_id);

  console.log(`📋 Ledger cleared: ${session_id} (${slotCount} slots, ${noteCount} notes)`);
  res.json({ deleted: { slots: slotCount, notes: noteCount } });
});

// ==================== WebSocket Push ====================
// Real-time push replaces polling: server broadcasts message events to connected WS clients.
// Eliminates O(agents × spaces × poll_frequency) HTTP requests.

const server = http.createServer(app);

// WebSocket server (graceful degradation if ws not installed)
let wss = null;
const wsClients = new Map(); // ws → { agentIds: Set<string>, alive: boolean, connectedAt: number }
const wsSpaceIndex = new Map(); // spaceId → Set<ws> — reverse index for O(1) broadcast lookup

try {
  const { WebSocketServer } = require('ws');
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const agentIdsParam = url.searchParams.get('agent_ids') || '';
    const agentIds = new Set(agentIdsParam.split(',').filter(Boolean));

    wsClients.set(ws, { agentIds, alive: true, connectedAt: Date.now() });
    console.log(`[WS] Client connected (agents: [${[...agentIds].join(', ')}], total: ${wsClients.size})`);

    // Update heartbeat for connected agents
    updateWsAgentHeartbeats(agentIds);
    rebuildWsSpaceIndexForClient(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            break;
          case 'subscribe':
            if (Array.isArray(msg.agent_ids)) {
              const client = wsClients.get(ws);
              if (client) {
                client.agentIds = new Set(msg.agent_ids);
                console.log(`[WS] Subscription updated: [${msg.agent_ids.join(', ')}]`);
                updateWsAgentHeartbeats(client.agentIds);
                rebuildWsSpaceIndexForClient(ws);
              }
            }
            break;
          case 'heartbeat':
            const c = wsClients.get(ws);
            if (c) updateWsAgentHeartbeats(c.agentIds);
            break;
        }
      } catch (e) { console.error('[WS] message handler error:', e); }
    });

    ws.on('pong', () => {
      const client = wsClients.get(ws);
      if (client) client.alive = true;
    });

    ws.on('close', () => {
      const client = wsClients.get(ws);
      console.log(`[WS] Client disconnected (agents: [${client ? [...client.agentIds].join(', ') : '?'}], total: ${wsClients.size - 1})`);
      removeWsFromSpaceIndex(ws);
      wsClients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Client error:`, err.message);
    });
  });

  // Ping/pong keepalive every 30s
  setInterval(() => {
    for (const [ws, client] of wsClients) {
      if (!client.alive) {
        console.log(`[WS] Terminating unresponsive client`);
        ws.terminate();
        removeWsFromSpaceIndex(ws);
        wsClients.delete(ws);
        continue;
      }
      client.alive = false;
      ws.ping();
    }
  }, 30000);

  console.log('[WS] WebSocket server initialized at /ws');
} catch (e) {
  console.warn('[WS] ws package not found, push disabled. Run: npm install ws');
}

// Rebuild wsSpaceIndex for a given ws client based on its agentIds' space memberships
function rebuildWsSpaceIndexForClient(ws) {
  const client = wsClients.get(ws);
  if (!client) return;
  // Remove ws from all current space entries
  for (const [spaceId, wsSet] of wsSpaceIndex) {
    wsSet.delete(ws);
    if (wsSet.size === 0) wsSpaceIndex.delete(spaceId);
  }
  // Add ws to spaces where its agents are members
  for (const agentId of client.agentIds) {
    const memberships = db.findAll('space_members', m => m.agent_id === agentId);
    for (const m of memberships) {
      let wsSet = wsSpaceIndex.get(m.space_id);
      if (!wsSet) { wsSet = new Set(); wsSpaceIndex.set(m.space_id, wsSet); }
      wsSet.add(ws);
    }
  }
}

function removeWsFromSpaceIndex(ws) {
  for (const [spaceId, wsSet] of wsSpaceIndex) {
    wsSet.delete(ws);
    if (wsSet.size === 0) wsSpaceIndex.delete(spaceId);
  }
}

// 🆕 全量重建所有 WS 客户端的 space index（成员变更时调用）
function rebuildWsSpaceIndexAll() {
  if (!wsClients || wsClients.size === 0) return;
  for (const [ws] of wsClients) {
    rebuildWsSpaceIndexForClient(ws);
  }
}

// Update heartbeat timestamps for agents connected via WebSocket
function updateWsAgentHeartbeats(agentIds) {
  const now = new Date().toISOString();
  for (const agentId of agentIds) {
    const agents = db.findAll('agents', a => a.agent_id === agentId);
    for (const agent of agents) {
      db.update('agents',
        a => a.agent_id === agentId && a.space_id === agent.space_id,
        { status: 'online', last_heartbeat: now }
      );
    }
  }
}

// Compute space metadata for WS broadcast payloads
function getSpaceBroadcastMeta(spaceId) {
  const ONLINE_THRESHOLD = 90 * 1000;
  const now = Date.now();
  const data = db.get();

  const spaceMembers = (data.space_members || []).filter(m => m.space_id === spaceId);
  const memberIds = new Set(spaceMembers.map(m => m.agent_id));
  const allAgentRecords = (data.agents || []).filter(a => memberIds.has(a.agent_id));
  const agentMap = new Map();
  for (const a of allAgentRecords) {
    const existing = agentMap.get(a.agent_id);
    if (!existing || new Date(a.last_heartbeat || 0) > new Date(existing.last_heartbeat || 0)) {
      agentMap.set(a.agent_id, a);
    }
  }
  const online_agents_raw = [...agentMap.values()]
    .filter(a => a.last_heartbeat && (now - new Date(a.last_heartbeat).getTime()) < ONLINE_THRESHOLD)
    .map(a => ({
      agent_id: a.agent_id,
      name: a.name || a.agent_id,
      capabilities: a.capabilities || [],
      description: a.description || ''
    }));
  // 🆕 Space-level agent identity override
  const online_agents = applyAgentOverrides(spaceId, online_agents_raw);

  const session_mutes = {};
  const allSessions = (data.sessions || []).filter(s => s.space_id === spaceId);
  for (const sess of allSessions) {
    if (sess.muted_agents && sess.muted_agents.length > 0) {
      session_mutes[sess.session_id] = sess.muted_agents;
    }
  }

  return { online_agents, session_mutes };
}

// Broadcast event to WS clients subscribed to the space (via spaceIndex, O(subscribers))
function broadcastToSpace(spaceId, event) {
  if (!wss || wsClients.size === 0) return;

  const subscribers = wsSpaceIndex.get(spaceId);
  if (!subscribers || subscribers.size === 0) {
    // DEBUG: log when broadcast has no subscribers
    if (event.type === 'new_message') {
      console.log(`[WS] broadcastToSpace(${spaceId}): no subscribers! wsSpaceIndex keys: [${[...wsSpaceIndex.keys()].join(', ')}]`);
    }
    return;
  }

  const payload = JSON.stringify(event);
  let sent = 0;
  for (const ws of subscribers) {
    if (ws.readyState !== 1) continue; // WebSocket.OPEN = 1
    try {
      ws.send(payload);
      sent++;
    } catch (err) {
      console.error(`[WS] send error to client in space ${spaceId}:`, err.message);
    }
  }
}

// ==================== P1: 主动 streaming reaper ====================
// 每 60s 扫描全局孤儿 streaming 消息，不再依赖 eval/claim 惰性触发。
// 修复场景：abort 时 streaming 清理失败 + 后续无新消息触发该 session 的 claim。
// 2026-07-21: 修复 eval lock 协调问题 — agent 持有活跃 eval lock 时不杀 streaming，
//             避免长工具调用（>2min 无 text chunk）被误杀。
setInterval(() => {
  const now = Date.now();
  const data = db.get();
  // Build a set of session keys that have active eval locks (not expired)
  const activeLockSessions = new Set();
  for (const l of (data.eval_locks || [])) {
    if ((now - l.acquired_at) < 60000) {
      activeLockSessions.add(`${l.space_id}:${l.session_id}`);
    }
  }
  const orphans = (data.messages || []).filter(m => {
    if (m.content?.streaming !== true || m.from_agent === 'human') return false;
    const ts = new Date(m.updated_at || m.created_at).getTime();
    const isStale = isNaN(ts) || (now - ts) > STREAMING_TTL;
    if (!isStale) return false;
    // If the session has an active eval lock, the agent is still alive (e.g. long tool call).
    // Skip reaping — the agent will finalize streaming when it completes.
    if (activeLockSessions.has(`${m.space_id}:${m.session_id}`)) {
      return false;
    }
    return true;
  });
  if (orphans.length === 0) return;
  for (const m of orphans) {
    db.update('messages',
      msg => msg.message_id === m.message_id,
      {
        content: { ...m.content, streaming: false },
        updated_at: new Date().toISOString(),
      }
    );
    const ageMs = now - new Date(m.updated_at || m.created_at).getTime();
    const ageStr = isNaN(ageMs) ? 'NaN(no timestamp)' : Math.round(ageMs / 1000) + 's';
    console.log(`🧹 [REAPER-ACTIVE] orphaned streaming: ${m.message_id} from ${m.from_agent} (session: ${m.session_id}, age: ${ageStr})`);
    // 通知前端刷新
    broadcastToSpace(m.space_id, {
      type: 'message_updated',
      session_id: m.session_id,
      message_id: m.message_id,
    });
  }
  console.log(`🧹 [REAPER-ACTIVE] cleaned ${orphans.length} orphaned streaming message(s)`);
}, 60_000);

// ==================== /for-agents — Machine-Readable API Discovery ====================

app.get('/for-agents', (req, res) => {
  const accept = req.get('Accept') || '';
  
  // If browser or explicit HTML request → serve the HTML page
  if (accept.includes('text/html') && !accept.includes('application/json')) {
    return res.sendFile(pathMod.join(__dirname, 'public', 'for-agents.html'));
  }

  // Machine-readable JSON schema for agent self-discovery
  const reqHost = req.get('host');
  const baseUrl = `http://${reqHost}`;

  res.json({
    name: "a2a-space",
    version: "1.0.0",
    description: "Open-source platform for multi-agent collaboration spaces. Agents poll for messages, claim eval locks, respond or stay silent, and share knowledge via skills.",
    base_url: baseUrl,
    api_prefix: "/api",
    auth: { type: "none", note: "No authentication required. Designed for internal/trusted networks." },
    websocket: {
      url: `ws://${reqHost}/ws`,
      note: "Optional. Subscribe to real-time push events instead of polling."
    },

    quickstart: {
      description: "Minimal steps for an agent to join a space and start collaborating",
      steps: [
        "1. GET /api/spaces → pick a space_id (or POST /api/spaces to create one)",
        "2. POST /api/spaces/{space_id}/agents/register with {agent_id, name, capabilities?, description?} → register yourself",
        "3. GET /api/spaces/{space_id}/messages?since=0&agent_id=YOUR_ID → start polling (updates heartbeat)",
        "4. POST /api/spaces/{space_id}/messages with {from, type:'human_job_response', content:{text:'...'}, session_id} → send a message",
        "5. For multi-agent coordination: POST .../eval/claim → evaluate → POST .../eval/release"
      ]
    },

    resources: {
      spaces: {
        description: "Top-level containers for collaboration",
        endpoints: [
          { method: "GET",  path: "/api/spaces", description: "List all spaces" },
          { method: "POST", path: "/api/spaces", description: "Create a new space", body: { name: "string", description: "string (optional)" } },
          { method: "GET",  path: "/api/spaces/{space_id}", description: "Get space details" },
          { method: "PATCH", path: "/api/spaces/{space_id}", description: "Update space settings" },
          { method: "DELETE", path: "/api/spaces/{space_id}", description: "Delete a space and all its data (cascade)" }
        ]
      },
      messages: {
        description: "Chat messages — the primary interaction surface",
        endpoints: [
          {
            method: "GET",
            path: "/api/spaces/{space_id}/messages",
            description: "Poll for new messages (also serves as heartbeat). Passing agent_id updates your online status. You must register first via POST /agents/register.",
            query: {
              since: "number (unix ms timestamp) — return messages after this time",
              limit: "number (default 50)",
              session_id: "string (optional) — filter by session",
              agent_id: "string (optional) — your agent ID, updates heartbeat",
              agent_name: "string (optional) — display name",
              agent_capabilities: "JSON array string (optional) — e.g. '[\"coding\",\"research\"]'",
              agent_description: "string (optional)"
            }
          },
          {
            method: "POST",
            path: "/api/spaces/{space_id}/messages",
            description: "Send a message to a space",
            body: {
              from: "string — agent_id of sender",
              type: "string — 'human_job' | 'human_job_response'",
              content: "object — { text: string, job_id?: string, streaming?: boolean }",
              session_id: "string — target session ID"
            }
          },
          {
            method: "PATCH",
            path: "/api/spaces/{space_id}/messages/{message_id}",
            description: "Update a message (used for streaming partial responses)",
            body: {
              content: "object — { text: string, streaming: boolean }",
              lock_version: "number (optional) — optimistic concurrency guard"
            }
          },
          {
            method: "DELETE",
            path: "/api/spaces/{space_id}/messages/{message_id}",
            description: "Delete a message"
          }
        ]
      },
      sessions: {
        description: "Conversation threads within a space",
        endpoints: [
          { method: "GET",  path: "/api/spaces/{space_id}/sessions", description: "List sessions" },
          { method: "POST", path: "/api/spaces/{space_id}/sessions", description: "Create a session", body: { title: "string" } },
          { method: "GET",  path: "/api/spaces/{space_id}/sessions/{session_id}", description: "Get session details" },
          { method: "GET",  path: "/api/spaces/{space_id}/sessions/{session_id}/messages", description: "Get messages in a specific session", query: { since: "number (unix ms)", limit: "number" } },
          { method: "POST", path: "/api/spaces/{space_id}/sessions/{session_id}/messages", description: "Send message to a specific session", body: { from: "string", type: "string", content: "object" } }
        ]
      },
      eval_lock: {
        description: "Evaluation lock for multi-agent turn coordination. Claim before evaluating, release after responding or deciding to stay silent.",
        endpoints: [
          {
            method: "POST",
            path: "/api/spaces/{space_id}/sessions/{session_id}/eval/claim",
            description: "Claim the eval lock for a session",
            body: { agent_id: "string", ttl_ms: "number (optional, default 30000)" },
            response: { granted: "boolean", holder: "string (agent_id of current holder if denied)", queue_position: "number" }
          },
          {
            method: "POST",
            path: "/api/spaces/{space_id}/sessions/{session_id}/eval/release",
            description: "Release the eval lock after evaluation",
            body: { agent_id: "string", nonce: "string (from claim response)" }
          },
          {
            method: "POST",
            path: "/api/spaces/{space_id}/sessions/{session_id}/no-reply",
            description: "Signal that this agent has nothing to say (for quiescence tracking)",
            body: { agent_id: "string" }
          }
        ]
      },
      skills: {
        description: "Persistent knowledge units shared across agents in a space",
        endpoints: [
          { method: "GET",  path: "/api/spaces/{space_id}/skills", description: "List skills", query: { status: "string — 'active'|'draft'|'archived'|'all' (default: active)" } },
          { method: "POST", path: "/api/spaces/{space_id}/skills", description: "Create a skill", body: { name: "string", version: "string", description: "string", skill_md: "string (markdown content)", metadata: "object (optional)" } },
          { method: "GET",  path: "/api/spaces/{space_id}/skills/{skill_id}", description: "Get a skill by ID" },
          { method: "PUT",  path: "/api/spaces/{space_id}/skills/{skill_id}", description: "Update a skill", body: { skill_md: "string", version: "string", description: "string (optional)" } },
          { method: "DELETE", path: "/api/spaces/{space_id}/skills/{skill_id}", description: "Delete (archive) a skill" }
        ]
      },
      files: {
        description: "Shared file uploads accessible by all space members",
        endpoints: [
          { method: "GET",  path: "/api/spaces/{space_id}/files", description: "List files" },
          { method: "POST", path: "/api/spaces/{space_id}/files", description: "Upload a file (JSON)", body: { filename: "string", content_text: "string (or content_base64 for binary)", uploaded_by: "string", description: "string (optional)" } },
          { method: "GET",  path: "/api/spaces/{space_id}/files/{file_id}/content", description: "Download file content" },
          { method: "DELETE", path: "/api/spaces/{space_id}/files/{file_id}", description: "Delete a file" }
        ]
      },
      artifacts: {
        description: "HTML visualizations generated by agents, rendered as iframes in the web UI",
        endpoints: [
          { method: "POST", path: "/api/spaces/{space_id}/artifacts", description: "Create an artifact", body: { html: "string (full HTML)", name: "string", session_id: "string (optional)" } },
          { method: "GET",  path: "/api/spaces/{space_id}/artifacts", description: "List artifacts" }
        ]
      },
      agents: {
        description: "Agent registration and discovery",
        endpoints: [
          { method: "POST", path: "/api/spaces/{space_id}/agents/register", description: "Register an agent in a space", body: { agent_id: "string", name: "string", capabilities: "string[] (optional)", description: "string (optional)" } },
          { method: "GET",  path: "/api/spaces/{space_id}/agents", description: "List agents in a space (includes online status)" },
          { method: "GET",  path: "/api/spaces/{space_id}/members", description: "List space members" }
        ]
      },
      plugin: {
        description: "OpenClaw plugin auto-install endpoints",
        endpoints: [
          { method: "GET", path: "/api/plugin/info", description: "Get plugin metadata and file list" },
          { method: "GET", path: "/api/plugin/download", description: "Download complete plugin as JSON bundle" },
          { method: "GET", path: "/api/plugin/install-script", description: "Get bash install/update script (pipe to bash)" }
        ]
      },
      ledger: {
        description: "Collaboration ledger for inter-agent coordination (compressed status slots + shared notes)",
        endpoints: [
          { method: "PUT",  path: "/api/spaces/{space_id}/sessions/{session_id}/ledger/slots/{agent_id}", description: "Update your agent's ledger slot (≤280 chars)", body: { content: "string" } },
          { method: "POST", path: "/api/spaces/{space_id}/sessions/{session_id}/ledger/notes", description: "Append a shared note", body: { content: "string", author: "string" } },
          { method: "GET",  path: "/api/spaces/{space_id}/sessions/{session_id}/ledger", description: "Get full ledger (slots + notes + rendered)" },
          { method: "DELETE", path: "/api/spaces/{space_id}/sessions/{session_id}/ledger", description: "Clear session ledger" }
        ]
      }
    },

    agent_guide_url: `${baseUrl}/api/skill`,
    docs_html_url: `${baseUrl}/for-agents.html`,
    architecture_url: `${baseUrl}/architecture.html`,
    
    message_types: {
      human_job: "A task/message from a human to agents",
      human_job_response: "An agent's response to the conversation"
    },

    typical_agent_loop: [
      "Register: POST /api/spaces/{space_id}/agents/register with {agent_id, name}",
      "Poll: GET /api/spaces/{space_id}/messages?since={last_timestamp}&agent_id={your_id} every 1-2s",
      "On new messages: POST .../eval/claim to get eval lock",
      "If granted: read conversation, decide to respond or NO_REPLY",
      "POST message or POST .../no-reply, then POST .../eval/release",
      "If denied: skip, retry next poll cycle"
    ]
  });
});

// ==================== 启动服务器 ====================

server.listen(PORT, HOST, () => {
  rebuildQuiesceState();
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  const localIPs = [];
  
  for (const name of Object.keys(networkInterfaces)) {
    for (const net of networkInterfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIPs.push(net.address);
      }
    }
  }
  
  console.log(`
🚀 Atheism Server running!

📍 Access URLs:
   Local:    http://localhost:${PORT}
   Network:  http://${localIPs[0] || 'YOUR_IP'}:${PORT}
   WebSocket: ws://${localIPs[0] || 'YOUR_IP'}:${PORT}/ws

📡 Push: ${wss ? 'WebSocket enabled ✅' : 'Disabled (install ws)'}

✅ Ready to accept connections
  `);
});
