#!/usr/bin/env node
/**
 * Protocol Auditor Moderator
 * 
 * 两阶段触发机制：
 * Phase 1: 注入话题 → 4个辩论角色讨论 → 等待quiesce
 * Phase 2: 注入总结指令 → Synthesizer出纪要 → 结束
 * 
 * 用法:
 *   node moderator.js                    # 自动选题并运行
 *   node moderator.js --topic "..."      # 指定话题
 *   node moderator.js --section "..."    # 指定协议章节审查
 *   node moderator.js --phase2 SESSION   # 手动触发phase2（调试用）
 */

const BASE_URL = process.env.PA_SERVER_URL || 'http://localhost:3000';
const SPACE_ID = process.env.PA_SPACE_ID || 'YOUR_PA_SPACE_ID';
const MAIN_SPACE_ID = process.env.PA_MAIN_SPACE_ID || 'YOUR_SPACE_ID';

const DEBATE_AGENTS = [
  'agent_pa_challenger',
  'agent_pa_practitioner', 
  'agent_pa_systems_analyst',
  'agent_pa_evo_thinker'
];
const SYNTHESIZER = 'agent_pa_synthesizer';

// Quiesce polling config
const QUIESCE_POLL_INTERVAL = 30_000;  // 30s
const QUIESCE_TIMEOUT = 600_000;       // 10min max for debate phase
const PHASE2_TIMEOUT = 300_000;        // 5min max for synthesis phase

// ==================== HTTP helpers ====================

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BASE_URL}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${method} ${path} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ==================== Session management ====================

async function createSession(title) {
  const result = await api('POST', `/api/spaces/${SPACE_ID}/sessions`, {
    title,
    created_by: 'moderator'
  });
  console.log(`📋 Session created: ${result.session_id} — "${title}"`);
  return result.session_id;
}

async function sendMessage(sessionId, from, content) {
  const result = await api('POST', `/api/spaces/${SPACE_ID}/sessions/${sessionId}/messages`, {
    from,
    type: 'text',
    content: { message: content }
  });
  console.log(`💬 Message sent by ${from}: ${content.substring(0, 80)}...`);
  return result;
}

// ==================== Quiesce detection ====================

async function waitForQuiesce(sessionId, timeoutMs = QUIESCE_TIMEOUT) {
  const start = Date.now();
  console.log(`⏳ Waiting for quiesce (timeout: ${timeoutMs / 1000}s)...`);
  
  while (Date.now() - start < timeoutMs) {
    await sleep(QUIESCE_POLL_INTERVAL);
    
    // Check session messages for quiesce signal
    const messages = await api('GET', `/api/spaces/${SPACE_ID}/sessions/${sessionId}/messages?limit=20`);
    const msgs = messages.messages || messages;
    
    // Count recent NO_REPLY from debate agents
    const recentAgentMsgs = msgs.filter(m => 
      DEBATE_AGENTS.includes(m.from_agent) && 
      Date.parse(m.timestamp) > start
    );
    
    // If we have at least one substantive message and all recent are NO_REPLY or done
    if (recentAgentMsgs.length >= DEBATE_AGENTS.length) {
      // Check the last round
      const lastRound = msgs.slice(-10);
      const noReplyCount = lastRound.filter(m => 
        DEBATE_AGENTS.includes(m.from_agent) && 
        (m.content?.message === 'NO_REPLY' || m.content === 'NO_REPLY')
      ).length;
      
      if (noReplyCount >= DEBATE_AGENTS.length) {
        console.log(`🔇 Quiesce detected after ${Math.round((Date.now() - start) / 1000)}s`);
        return true;
      }
    }
    
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  ... ${elapsed}s elapsed, debate ongoing`);
  }
  
  console.log(`⚠️ Quiesce timeout reached (${timeoutMs / 1000}s), proceeding anyway`);
  return false;
}

// ==================== Topic generation ====================

async function getProtocolContent() {
  try {
    // Fetch the a2a-collaboration-protocol skill from main space
    const skills = await api('GET', `/api/spaces/${MAIN_SPACE_ID}/skills`);
    const protocol = (skills.skills || skills).find(s => 
      s.name === 'a2a-collaboration-protocol'
    );
    if (protocol) {
      const full = await api('GET', `/api/spaces/${MAIN_SPACE_ID}/skills/${protocol.skill_id}`);
      const raw = full.skill_md || full.content || '';
      // Escape @human/@Agent to prevent triggering pause/mention detection
      return raw.replace(/@human\b/gi, '＠human').replace(/@Agent\b/g, '＠Agent');
    }
  } catch (e) {
    console.warn(`⚠️ Could not fetch protocol: ${e.message}`);
  }
  return '';
}

// Pre-defined topic templates for rotation
const TOPIC_TEMPLATES = [
  {
    topic: 'NO_REPLY 原则是否导致信息丢失？',
    focus: '当多个Agent都选择NO_REPLY时，是否存在有价值的视角被系统性遗漏的风险？沉默=同意的假设是否合理？'
  },
  {
    topic: 'Ledger 280字符限制是帮助还是阻碍？',
    focus: '压缩通道的字符限制是否能有效传递足够的协调信息？是否存在信息丢失导致的协调失败？'
  },
  {
    topic: '角色独占性检查的实际效果',
    focus: '要求"去掉角色名后换成其他Agent是否成立"这个自检是否过于严格？是否导致有价值的补充观点被压制？'
  },
  {
    topic: '分工阶段"禁止调用工具"规则的合理性',
    focus: 'L3任务要求分工阶段不执行、不调工具。这是否导致了不必要的延迟？有没有边界情况？'
  },
  {
    topic: '沉默=同意 vs 显式确认',
    focus: '当前协议假设"提出方案后直接开始，沉默=同意"。这在什么场景下会出问题？'
  },
  {
    topic: '任务复杂度分流（L1/L2/L3）的判定标准',
    focus: '第一个响应的Agent负责判断复杂度。这个机制是否导致了误判？L2和L3的边界是否清晰？'
  },
  {
    topic: 'Skill沉淀的触发时机和质量门禁',
    focus: '当前的沉淀规则（触发条件1/2/3 + M1-M5门禁）是否在效率和质量之间取得了好的平衡？'
  },
  {
    topic: '@提及机制的优先级语义',
    focus: '@某个Agent是否真的改变了评估顺序？当@和角色职责冲突时如何处理？'
  },
  {
    topic: '阶段判定规则的歧义性',
    focus: '"看会话历史中最近的消息"来判断当前阶段——这在快速对话中是否存在判断延迟或误判？'
  },
  {
    topic: '信息增量检查的80%相似度阈值',
    focus: '要求"与前面回复重叠>80%则不发"——Agent如何准确判断相似度？这个阈值是否合理？'
  },
  {
    topic: '汇报人指定机制的鲁棒性',
    focus: '分工阶段必须在ledger中指定汇报人——如果指定的Agent出错或被截断怎么办？有没有fallback？'
  },
  {
    topic: '多Agent协作中的锚定效应',
    focus: '第一个发言的Agent是否对后续讨论产生了不成比例的影响？协议有没有机制防止锚定？'
  }
];

function pickTopic(explicitTopic) {
  if (explicitTopic) {
    return {
      topic: explicitTopic,
      focus: '请围绕上述话题展开深入讨论。'
    };
  }
  // Rotate based on day of year
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const idx = dayOfYear % TOPIC_TEMPLATES.length;
  return TOPIC_TEMPLATES[idx];
}

// ==================== Message formatting ====================

function formatPhase1Message(topicInfo, protocolExcerpt) {
  let msg = `【协议审查话题】${topicInfo.topic}\n\n`;
  
  if (protocolExcerpt) {
    // Extract relevant section (simplified - in production would use semantic search)
    const excerpt = protocolExcerpt.substring(0, 2000);
    msg += `【协议原文参考】\n${excerpt}\n\n`;
  }
  
  msg += `【审查焦点】${topicInfo.focus}\n\n`;
  msg += `请各位从各自视角展开讨论。Challenger质疑合理性，Practitioner检验可操作性，Systems Analyst分析系统效应，Evolutionary Thinker审视演化方向。`;
  
  return msg;
}

function formatPhase2Message() {
  return `【辩论阶段结束，进入总结】\n\n以上是四位审查员的完整讨论记录。请 Synthesizer 阅读全部内容，提取结构化纪要。\n\n纪要应包含：共识、争议、发现的问题（按优先级排序）、建议改进项、未解决的问题。`;
}

// ==================== Main flow ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runAudit(options = {}) {
  const { topic, section, phase2Session } = options;
  
  // Phase 2 only mode (for debugging)
  if (phase2Session) {
    console.log(`🔄 Phase 2 only — session: ${phase2Session}`);
    await sendMessage(phase2Session, 'human', formatPhase2Message());
    console.log('✅ Phase 2 triggered');
    return;
  }
  
  // Full run
  const topicInfo = pickTopic(topic || section);
  console.log(`\n🎯 Topic: ${topicInfo.topic}`);
  
  // Fetch protocol content for context
  const protocol = await getProtocolContent();
  
  // Create session
  const dateStr = new Date().toISOString().split('T')[0];
  const sessionId = await createSession(`协议审查 — ${topicInfo.topic} (${dateStr})`);
  
  // Phase 1: Inject topic for debate agents
  console.log(`\n--- Phase 1: Debate ---`);
  await sendMessage(sessionId, 'human', formatPhase1Message(topicInfo, protocol));
  
  // Wait for quiesce
  const quiesced = await waitForQuiesce(sessionId);
  
  // Brief pause between phases
  await sleep(5000);
  
  // Phase 2: Trigger Synthesizer
  console.log(`\n--- Phase 2: Synthesis ---`);
  await sendMessage(sessionId, 'human', formatPhase2Message());
  
  // Wait for Synthesizer to finish
  await waitForQuiesce(sessionId, PHASE2_TIMEOUT);
  
  console.log(`\n✅ Audit complete — session: ${sessionId}`);
  console.log(`   View: ${BASE_URL}/main.html#/space/${SPACE_ID}/session/${sessionId}`);
}

// ==================== CLI ====================

const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--topic' && args[i + 1]) options.topic = args[++i];
  if (args[i] === '--section' && args[i + 1]) options.section = args[++i];
  if (args[i] === '--phase2' && args[i + 1]) options.phase2Session = args[++i];
}

runAudit(options).catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
