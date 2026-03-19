const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const db = require('./db');
const fs = require('fs');
const pathMod = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // 监听所有网络接口
const FILES_DIR = pathMod.join(__dirname, 'data', 'files');

// 中间件
app.use(cors());
app.use(express.json({ limit: '5mb' }));

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
// 当一个 session 中所有在线 Agent 都回复了 NO_REPLY，session 进入等待人类消息/Agent实质回复的模式
// 人类消息 或 Agent 实质回复（非 NO_REPLY）会重置状态

const sessionQuiesce = new Map(); // key: `${space_id}:${session_id}` → { no_reply_agents: Set<string>, quiesced: boolean }

function resetQuiesce(space_id, session_id) {
  const key = `${space_id}:${session_id}`;
  const prev = sessionQuiesce.get(key);
  if (prev?.quiesced) {
    console.log(`🔔 Session ${session_id} un-quiesced (new substantive content)`);
  }
  sessionQuiesce.delete(key);
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
  const sessionMsgs = db.findAll('messages', m =>
    m.session_id === session_id && m.space_id === space_id
  );
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
  }

  return state;
}

function isSessionQuiesced(space_id, session_id) {
  const state = sessionQuiesce.get(`${space_id}:${session_id}`);
  return state?.quiesced || false;
}

// ==================== 轮次兜底：Agent 消息距人类消息超过 N 轮则强制停止 ====================
const MAX_AGENT_ROUNDS_SINCE_HUMAN = 16; // 2× max 8 agents — prevents runaway cascades

function countAgentRoundsSinceHuman(space_id, session_id) {
  const sessionMsgs = db.findAll('messages', m =>
    m.session_id === session_id && m.space_id === space_id
  );
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

  // 兜底：也检查消息历史
  const data = db.get();
  const sessions = (data.sessions || []).filter(s => s.status !== 'closed');
  for (const session of sessions) {
    const key = session.space_id + ':' + session.session_id;
    if (sessionQuiesce.has(key)) continue;
    const msgs = (data.messages || []).filter(m =>
      m.session_id === session.session_id && m.space_id === session.space_id
    );
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

// ==================== Spaces API ====================

// 获取所有 spaces
app.get('/api/spaces', (req, res) => {
  const data = db.get();
  
  const spaces = data.spaces.map(space => {
    // 只计算 members 数量，不是所有注册过的 agents
    const members = (data.space_members || []).filter(m => m.space_id === space.space_id);
    const agent_count = members.length;
    const skill_count = data.skills.filter(s => s.space_id === space.space_id).length;
    const spaceMessages = data.messages.filter(m => m.space_id === space.space_id);
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
  const { name, description, load_packs } = req.body;
  const space_id = nanoid(10);
  
  const newSpace = {
    space_id,
    name,
    description,
    created_at: new Date().toISOString()
  };
  
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
  
  const result = db.update('spaces', s => s.space_id === space_id, updates);
  if (!result) return res.status(404).json({ error: 'space not found' });
  res.json(result);
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

// ==================== Messages API ====================

// 🆕 消息去重缓存：防止前端 IME 双触发导致同一条消息存两次
const recentMessageHashes = new Map(); // key: hash → timestamp
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentMessageHashes) {
    if (now - ts > 3000) recentMessageHashes.delete(k);
  }
}, 5000);

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
  const { from, type, content, session_id } = req.body;
  
  if (isDuplicateMessage(space_id, session_id || 'default', from, content)) {
    console.log(`atheism-server: dedup: duplicate message blocked (${from}@${space_id})`);
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
      console.log(`atheism-server: dedup: response already exists from ${from} for job ${content.job_id} (existing: ${existingResponse.message_id})`);
      return res.status(200).json({ 
        message_id: existingResponse.message_id, 
        session_id: session_id || 'session_default', 
        deduplicated: true 
      });
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
    timestamp: new Date().toISOString()
  };
  
  db.insert('messages', newMessage);

  // 🆕 Quiesce tracking: 人类消息重置静默状态
  if (from === 'human' && finalSessionId) {
    resetQuiesce(space_id, finalSessionId);
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
      // 首次 poll = 自动注册
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
      console.log(`✅ Auto-registered agent ${agent_id} in space ${space_id}`);
    }
    
    // 🆕 Auto-join: 确保 agent 也在 space_members 表中（poll = 隐式 join）
    const isMember = db.findOne('space_members', m => m.space_id === space_id && m.agent_id === agent_id);
    if (!isMember) {
      db.insert('space_members', {
        space_id,
        agent_id,
        joined_at: new Date().toISOString(),
      });
      console.log(`✅ Auto-joined agent ${agent_id} to space ${space_id} members`);
    }
  }
  
  let messages = db.findAll('messages', m => m.space_id === space_id);
  
  // 按 session 过滤
  if (session_id) {
    messages = messages.filter(m => m.session_id === session_id);
  }

  // 🆕 Per-request cache for round limit check (avoid repeated db reads per session)
  const roundLimitCache = new Map();
  
  if (since) {
    const sinceDate = new Date(parseInt(since)).toISOString();
    messages = messages.filter(m => {
      // 新创建的消息
      if (m.timestamp > sinceDate) return true;
      // 🆕 最近完成的消息（streaming 结束，updated_at 在 since 之后）
      // 让 Agent 完成工作后能被对方感知到
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
  
  const online_agents = [...agentMap.values()]
    .filter(a => a.last_heartbeat && (now - new Date(a.last_heartbeat).getTime()) < ONLINE_THRESHOLD)
    .map(a => ({
      agent_id: a.agent_id,
      name: a.name || a.agent_id,
      capabilities: a.capabilities || [],
      description: a.description || ''
    }));
  
  // 🆕 当前评估锁（该 space 下所有 session 的锁）
  const eval_locks = (data.eval_locks || []).filter(l => l.space_id === space_id);
  // 清理过期锁（>60s）
  const activeLocks = eval_locks.filter(l => (now - l.acquired_at) < 60000);
  if (activeLocks.length < eval_locks.length) {
    // 有过期锁，清理
    for (const expired of eval_locks.filter(l => (now - l.acquired_at) >= 60000)) {
      db.delete('eval_locks', el => el.session_id === expired.session_id && el.space_id === space_id);
      console.log(`🔓 Auto-released expired eval lock for session ${expired.session_id} (holder: ${expired.holder})`);
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
  const { content } = req.body;
  
  const message = db.findOne('messages', m => 
    m.message_id === message_id && m.space_id === space_id
  );
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  // 更新消息内容
  db.update('messages',
    m => m.message_id === message_id,
    { 
      content: { ...message.content, ...content },
      updated_at: new Date().toISOString()
    }
  );

  // 🆕 Quiesce tracking: Agent 完成时判断是 NO_REPLY 还是实质回复
  const mergedContent = { ...message.content, ...content };
  if (mergedContent.streaming === false && message.from_agent && message.from_agent !== 'human') {
    const resultStr = typeof mergedContent.result === 'string' ? mergedContent.result.trim() : '';
    const isNoReply = /^\s*(\[?NO[_\s]?REPLY\]?|NO)\s*$/i.test(resultStr);
    if (isNoReply) {
      addNoReply(space_id, message.session_id, message.from_agent);
    } else if (resultStr) {
      resetQuiesce(space_id, message.session_id);
    }
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

// Claim evaluation lock for a session
// 🔒 v2: Insert-first + conflict-check 模式，消除 TOCTOU 竞态
// 额外防御：如果 session 已有 agent 在 streaming，直接拒绝
app.post('/api/spaces/:space_id/sessions/:session_id/eval/claim', (req, res) => {
  const { space_id, session_id } = req.params;
  const { agent_id } = req.body;
  
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }
  
  const now = Date.now();
  const LOCK_TIMEOUT = 60000; // 60s
  const ONLINE_THRESHOLD = 90000; // 90s
  
  // ── 防御层 1: Streaming 双重检查 ──
  // 如果 session 中已有 agent 在 streaming，直接拒绝（不管锁表状态）
  const streamingMsg = db.findOne('messages', m =>
    m.session_id === session_id && m.space_id === space_id &&
    m.content?.streaming === true && m.from_agent !== 'human' && m.from_agent !== agent_id
  );
  if (streamingMsg) {
    console.log(`🚫 Eval lock denied (streaming active): ${agent_id} blocked by ${streamingMsg.from_agent} (session: ${session_id})`);
    return res.json({ granted: false, held_by: streamingMsg.from_agent, reason: 'streaming_active' });
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
    // 自己已持有 — 续期
    db.update('eval_locks',
      l => l.session_id === session_id && l.space_id === space_id && l.holder === agent_id,
      { acquired_at: now }
    );
    return res.json({ granted: true, renewed: true });
  }
  
  if (otherLock) {
    // 别人持有且未超时/未离线（已被上面清理过了）
    return res.json({ granted: false, held_by: otherLock.holder });
  }
  
  // ── 防御层 2: Insert-first + conflict-check ──
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
  
  console.log(`🔒 Eval lock granted: ${agent_id} (session: ${session_id})`);
  res.json({ granted: true });
});

// Release evaluation lock
app.post('/api/spaces/:space_id/sessions/:session_id/eval/release', (req, res) => {
  const { space_id, session_id } = req.params;
  const { agent_id } = req.body;
  
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
  
  db.delete('eval_locks', l => l.session_id === session_id && l.space_id === space_id);
  
  console.log(`🔓 Eval lock released: ${agent_id} (session: ${session_id})`);
  res.json({ released: true });
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
  
  const data = db.get();
  if (!data.space_files) data.space_files = [];
  data.space_files.push(record);
  db.save(data);
  
  console.log(`[Files] ${uploaded_by || '?'} uploaded ${filename} (${file_id}) to space ${space_id}`);
  res.status(201).json({ file_id, filename, size: stat.size, download_url: `/api/spaces/${space_id}/files/${file_id}/download` });
});

// 上传文件（multipart form-data，Web UI 友好）
app.post('/api/spaces/:space_id/files/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const { space_id } = req.params;
  const filename = req.headers['x-filename'] || `upload_${Date.now()}`;
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
  
  const data = db.get();
  if (!data.space_files) data.space_files = [];
  data.space_files.push(record);
  db.save(data);
  
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

// ==================== Skill Directory（自动目录生成）====================

const SKILL_DIRECTORY_NAME = '_space_skill_directory';
const SKILL_DIRECTORY_MAX_ENTRIES = 50;

/**
 * 为指定 space 重新生成 Skill 目录（机械列表，作为基线）
 * Agent 通过 PUT /skill-directory 可以用 LLM 生成的智能目录覆盖
 */
function generateSkillDirectory(space_id) {
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
  });
});

// Agent 更新 skill 目录内容（用 LLM 整理后的语义化目录覆盖机械列表）
app.put('/api/spaces/:space_id/skill-directory', (req, res) => {
  const { space_id } = req.params;
  const { content, agent_id } = req.body;
  
  if (!content) return res.status(400).json({ error: 'content is required' });
  
  const existing = db.findOne('skills', s =>
    s.space_id === space_id && s.name === SKILL_DIRECTORY_NAME && s.is_system === true
  );
  
  if (existing) {
    db.update('skills',
      s => s.skill_id === existing.skill_id,
      {
        skill_md: content,
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

// ==================== Skills API ====================

// 贡献 Skill
app.post('/api/spaces/:space_id/skills', (req, res) => {
  const { space_id } = req.params;
  const { name, version, description, skill_md, metadata } = req.body;
  
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
    status: 'active',
    author: metadata.author || 'unknown',
    created_at: new Date().toISOString()
  };
  
  db.insert('skills', newSkill);

  // 目录维护交给 Agent 通过 PUT /skill-directory 自主更新
  
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
    s.status === status &&
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
app.delete('/api/spaces/:space_id/skills/:skill_id', (req, res) => {
  const { space_id, skill_id } = req.params;
  
  const skill = db.findOne('skills', s => s.skill_id === skill_id && s.space_id === space_id);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }
  
  db.delete('skills', s => s.skill_id === skill_id && s.space_id === space_id);

  // 目录维护交给 Agent 通过 PUT /skill-directory 自主更新

  res.json({ deleted: skill_id });
});

// UPDATE skill
app.put('/api/spaces/:space_id/skills/:skill_id', (req, res) => {
  const { space_id, skill_id } = req.params;
  const { name, version, description, skill_md, metadata } = req.body;
  
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
  updates.updated_at = new Date().toISOString();
  
  const updated = db.update('skills', 
    s => s.skill_id === skill_id && s.space_id === space_id,
    updates
  );

  // 目录维护交给 Agent 通过 PUT /skill-directory 自主更新
  
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

// 创建新会话
app.post('/api/spaces/:space_id/sessions', (req, res) => {
  const { space_id } = req.params;
  const { title, created_by = 'human' } = req.body;
  
  const session_id = `session_${nanoid(10)}`;
  
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
  
  // 获取每个 session 的消息数量和最后活动时间
  const data = db.get();
  const sessionsWithStats = sessions.map(session => {
    const sessionMessages = data.messages.filter(m => m.session_id === session.session_id);
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
  try { body = JSON.parse(req.body || '{}'); } catch {}
  
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
  });
});

// 向会话发送消息
app.post('/api/spaces/:space_id/sessions/:session_id/messages', (req, res) => {
  const { space_id, session_id } = req.params;
  const { from, type, content } = req.body;
  
  if (isDuplicateMessage(space_id, session_id, from, content)) {
    console.log(`atheism-server: dedup: duplicate message blocked (${from}@${session_id})`);
    return res.status(200).json({ message_id: 'dedup', session_id, deduplicated: true });
  }
  
  // 验证 session 存在
  const session = db.findOne('sessions', s => 
    s.session_id === session_id && s.space_id === space_id
  );
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
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
    resetQuiesce(space_id, session_id);
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
  
  res.status(201).json({ 
    message_id,
    session_id,
    timestamp: newMessage.timestamp 
  });
});

// ==================== OpenClaw Plugin API ====================

// Plugin directory — configurable via ATHEISM_PLUGIN_DIR env var, defaults to sibling ../plugin
const PLUGIN_DIR = process.env.ATHEISM_PLUGIN_DIR || pathMod.resolve(__dirname, '..', 'plugin');

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
      name: 'atheism',
      version: '2.0.0',
      files: bundle,
      install_path: PLUGIN_DIR
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to bundle plugin', details: err.message });
  }
});

// 获取安装脚本
app.get('/api/plugin/install-script', (req, res) => {
  // 使用实际请求的 host（支持内网 IP 访问）
  const reqHost = req.get('host');
  const apiUrl = `http://${reqHost}/api`;
  
  // 读取当前版本
  let currentVersion = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(pathMod.join(PLUGIN_DIR, 'package.json'), 'utf-8'));
    currentVersion = pkg.version || '0.0.0';
  } catch {}
  
  const script = `#!/bin/bash
# Atheism Plugin — Install / Update
# Run: curl -sL ${apiUrl}/plugin/install-script | bash

set -e

PLUGIN_DIR="$HOME/.openclaw/extensions/atheism"
API_URL="${apiUrl}"
REMOTE_VERSION="${currentVersion}"

echo ""

# Check if already installed
if [ -f "$PLUGIN_DIR/package.json" ]; then
  LOCAL_VERSION=$(cat "$PLUGIN_DIR/package.json" | grep '"version"' | head -1 | sed 's/.*"version": *"\\([^"]*\\)".*/\\1/')
  
  if [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
    echo "✅ Atheism Plugin is already up to date (v$LOCAL_VERSION)"
    echo ""
    echo "   To force reinstall: rm -rf $PLUGIN_DIR && curl -sL $API_URL/plugin/install-script | bash"
    exit 0
  fi
  
  echo "🔄 Updating Atheism Plugin: v$LOCAL_VERSION → v$REMOTE_VERSION"
else
  echo "🔧 Installing Atheism Plugin v$REMOTE_VERSION"
fi

echo "   Source: $API_URL"
echo ""

# Create directories
mkdir -p "$PLUGIN_DIR/src"

# Download files
echo "📥 Downloading plugin files..."

curl -sL "$API_URL/plugin/files/index.ts" -o "$PLUGIN_DIR/index.ts"
curl -sL "$API_URL/plugin/files/package.json" -o "$PLUGIN_DIR/package.json"
curl -sL "$API_URL/plugin/files/openclaw.plugin.json" -o "$PLUGIN_DIR/openclaw.plugin.json"
curl -sL "$API_URL/plugin/files/README.md" -o "$PLUGIN_DIR/README.md"
curl -sL "$API_URL/plugin/files/src/channel.ts" -o "$PLUGIN_DIR/src/channel.ts"
curl -sL "$API_URL/plugin/files/src/monitor.ts" -o "$PLUGIN_DIR/src/monitor.ts"
curl -sL "$API_URL/plugin/files/src/bot.ts" -o "$PLUGIN_DIR/src/bot.ts"
curl -sL "$API_URL/plugin/files/src/reply-dispatcher.ts" -o "$PLUGIN_DIR/src/reply-dispatcher.ts"
curl -sL "$API_URL/plugin/files/src/outbound.ts" -o "$PLUGIN_DIR/src/outbound.ts"
curl -sL "$API_URL/plugin/files/src/send.ts" -o "$PLUGIN_DIR/src/send.ts"
curl -sL "$API_URL/plugin/files/src/runtime.ts" -o "$PLUGIN_DIR/src/runtime.ts"
curl -sL "$API_URL/plugin/files/src/types.ts" -o "$PLUGIN_DIR/src/types.ts"

echo ""
echo "✅ Plugin v$REMOTE_VERSION installed to $PLUGIN_DIR"
echo ""

# Check if config exists
if grep -q '"atheism"' "$HOME/.openclaw/openclaw.json" 2>/dev/null; then
  echo "📝 Config already has atheism channel. Restart gateway to apply updates:"
  echo "   openclaw gateway restart"
else
  echo "📝 Add to ~/.openclaw/openclaw.json:"
  echo ""
  echo '  "channels": {'
  echo '    "atheism": {'
  echo '      "enabled": true,'
  echo "      \\"apiUrl\\": \\"$API_URL\\","
  echo '      "spaceId": "*",'
  echo '      "agents": [{'
  echo '        "agentId": "agent_YOUR_NAME",'
  echo '        "agentName": "Your Agent Name",'
  echo '        "capabilities": ["coding", "research"],'
  echo '        "description": "What this agent is good at"'
  echo '      }],'
  echo '      "pollIntervalMs": 1000,'
  echo '      "maxConcurrent": 3'
  echo '    }'
  echo '  },'
  echo '  "plugins": { "entries": { "atheism": { "enabled": true } } },'
  echo '  "bindings": [{ "agentId": "YOUR_AGENT_ID", "match": { "channel": "atheism", "peer": { "kind": "direct", "id": "agent_YOUR_NAME" } } }]'
  echo ""
  echo "Then restart gateway:"
  echo "   openclaw gateway restart"
fi

echo ""
echo "📖 Docs: http://${reqHost}/architecture.html"
echo "📄 Agent guide: http://${reqHost}/api/skill"
echo ""
echo "🎉 Done!"
`;

  res.type('text/plain').send(script);
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

// ==================== 启动服务器 ====================

app.listen(PORT, HOST, () => {
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

📡 API Endpoints:
   GET  /api/spaces
   POST /api/spaces
   GET  /api/spaces/:space_id
   POST /api/spaces/:space_id/agents/register
   POST /api/spaces/:space_id/agents/:agent_id/heartbeat
   GET  /api/spaces/:space_id/agents
   POST /api/spaces/:space_id/messages
   GET  /api/spaces/:space_id/messages
   POST /api/spaces/:space_id/skills
   GET  /api/spaces/:space_id/skills
   GET  /api/spaces/:space_id/skills/:skill_id/download
   POST /api/spaces/:space_id/skills/:skill_id/usage

✅ Ready to accept connections
  `);
});
