#!/usr/bin/env node
/**
 * Protocol Auditor — Moderator Script (v2)
 * 
 * A+ 模式：协议全文 + 轻量运行脉搏，让 5 个角色自由切入审查。
 * 
 * 用法:
 *   node moderator-pa.js                    # 标准审查
 *   node moderator-pa.js --focus "某个章节"   # 指定审查焦点
 *   node moderator-pa.js --dry-run           # 只打印不执行
 * 
 * 环境:
 *   PA_SPACE_ID      — Protocol Auditor Space ID (default: YOUR_PA_SPACE_ID)
 *   A2A_SERVER       — Atheism Server URL (default: http://localhost:3000)
 *   SOURCE_SPACE_ID  — 主协作 Space ID (default: YOUR_SPACE_ID)
 */

const PA_SPACE_ID = process.env.PA_SPACE_ID || 'YOUR_PA_SPACE_ID';
const A2A_SERVER = process.env.A2A_SERVER || 'http://localhost:3000';
const SOURCE_SPACE_ID = process.env.SOURCE_SPACE_ID || 'YOUR_SPACE_ID';

// ─── HTTP 工具 ──────────────────────────────────────────

async function apiGet(path) {
  const resp = await fetch(`${A2A_SERVER}${path}`);
  if (!resp.ok) throw new Error(`GET ${path} → ${resp.status}`);
  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetch(`${A2A_SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST ${path} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ─── 运行脉搏采集 ──────────────────────────────────────

async function collectPulse() {
  const pulse = {};
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  try {
    // 主 Space sessions
    const { sessions } = await apiGet(`/api/spaces/${SOURCE_SPACE_ID}/sessions?status=active`);
    const recent = sessions.filter(s => {
      const created = new Date(s.created_at || '2000-01-01').getTime();
      return (now - created) < weekMs;
    });
    pulse.sessionCount = recent.length;
    const totalMsgs = recent.reduce((sum, s) => sum + (s.message_count || 0), 0);
    pulse.avgMessages = recent.length > 0 ? (totalMsgs / recent.length).toFixed(1) : '0';
    pulse.totalMessages = totalMsgs;

    // 活跃 session 中消息最多的 top 3（看热点）
    const sorted = [...recent].sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
    pulse.hotSessions = sorted.slice(0, 3).map(s => ({
      title: s.title || '(无标题)',
      msgs: s.message_count || 0,
    }));
  } catch (err) {
    console.error('Failed to collect session pulse:', err.message);
    pulse.sessionCount = '?';
    pulse.avgMessages = '?';
  }

  try {
    // Skills 统计
    const { skills } = await apiGet(`/api/spaces/${SOURCE_SPACE_ID}/skills`);
    pulse.skillCount = skills.length;
    // 最近一周创建/更新的 skill
    const recentSkills = skills.filter(s => {
      const updated = new Date(s.updated_at || s.created_at || '2000-01-01').getTime();
      return (now - updated) < weekMs;
    });
    pulse.recentSkillUpdates = recentSkills.length;
    pulse.recentSkillNames = recentSkills.map(s => s.name).slice(0, 5);
  } catch (err) {
    console.error('Failed to collect skill pulse:', err.message);
    pulse.skillCount = '?';
  }

  try {
    // PA Space 历史讨论统计
    const { sessions } = await apiGet(`/api/spaces/${PA_SPACE_ID}/sessions?status=active`);
    pulse.paSessionCount = sessions.length;
    pulse.paTotalMessages = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);
  } catch (err) {
    pulse.paSessionCount = 0;
  }

  return pulse;
}

function formatPulse(pulse) {
  const lines = [
    `本周协作 session 数: ${pulse.sessionCount}`,
    `本周总消息数: ${pulse.totalMessages} | 平均每 session: ${pulse.avgMessages} 条`,
    `活跃 Skill 总数: ${pulse.skillCount} | 本周更新: ${pulse.recentSkillUpdates} 个`,
  ];

  if (pulse.recentSkillNames && pulse.recentSkillNames.length > 0) {
    lines.push(`近期更新的 Skill: ${pulse.recentSkillNames.join(', ')}`);
  }

  if (pulse.hotSessions && pulse.hotSessions.length > 0) {
    lines.push(`热门 session: ${pulse.hotSessions.map(s => `「${s.title}」(${s.msgs}条)`).join(', ')}`);
  }

  if (pulse.paSessionCount > 0) {
    lines.push(`PA 历史讨论: ${pulse.paSessionCount} 轮, ${pulse.paTotalMessages} 条消息`);
  }

  return lines.join('\n');
}

// ─── 协议获取 ──────────────────────────────────────────

async function fetchProtocol() {
  const { skills } = await apiGet(`/api/spaces/${SOURCE_SPACE_ID}/skills`);
  const proto = skills.find(s => s.name === 'a2a-collaboration-protocol');
  if (!proto) throw new Error('Protocol skill not found');

  const full = await apiGet(`/api/spaces/${SOURCE_SPACE_ID}/skills/${proto.skill_id}`);
  return {
    version: full.version || '?',
    updatedAt: full.updated_at || full.created_at,
    // Escape @human/@Agent mentions in protocol text to prevent triggering
    // pause/mention detection when injected as moderator message
    content: (full.skill_md || '').replace(/@human\b/gi, '＠human').replace(/@Agent\b/g, '＠Agent'),
  };
}

// ─── 主流程 ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const focusIdx = args.indexOf('--focus');
  const focusHint = focusIdx !== -1 ? args[focusIdx + 1] : null;

  console.log(`[${new Date().toISOString()}] Moderator PA v2 starting...`);

  // 1. 拉协议全文
  const protocol = await fetchProtocol();
  console.log(`📜 Protocol: v${protocol.version}, ${protocol.content.length} chars`);

  // 2. 采集运行脉搏
  const pulse = await collectPulse();
  const pulseText = formatPulse(pulse);
  console.log(`📊 Pulse:\n${pulseText}`);

  // 3. 组装 prompt
  const focusLine = focusHint
    ? `\n\n**本次审查焦点（由人类指定）：${focusHint}**\n请优先围绕这个方向展开，但不限于此。`
    : '';

  const prompt = `请基于当前协议和运行情况进行审查。你可以从任意角度切入：逻辑漏洞、执行歧义、规则冲突、过时条款、扩展性问题、实际运行数据反映的问题。${focusLine}

【近期运行概况】
${pulseText}

【协议全文 — a2a-collaboration-protocol v${protocol.version}】
${protocol.content}`;

  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(`Prompt length: ${prompt.length} chars`);
    console.log('First 500 chars:');
    console.log(prompt.slice(0, 500));
    console.log('\n--- END DRY RUN ---');
    return;
  }

  // 4. 创建 session
  const dateStr = new Date().toISOString().split('T')[0];
  const timeStr = new Date().toTimeString().split(' ')[0].slice(0, 5);
  const title = focusHint
    ? `协议审查：${focusHint} (${dateStr})`
    : `协议审查 ${dateStr} ${timeStr}`;

  const session = await apiPost(`/api/spaces/${PA_SPACE_ID}/sessions`, {
    title,
    created_by: 'moderator',
  });
  console.log(`✅ Session: ${session.session_id}`);

  // 5. 注入审查消息
  const message = await apiPost(
    `/api/spaces/${PA_SPACE_ID}/sessions/${session.session_id}/messages`,
    {
      from: 'human',
      type: 'human_job',
      content: {
        job: prompt,
        metadata: {
          moderator: true,
          protocol_version: protocol.version,
          pulse_snapshot: pulse,
          date: dateStr,
        },
      },
    }
  );
  console.log(`✅ Injected: ${message.message_id}`);
  console.log(`🔗 ${A2A_SERVER}/main.html#/space/${PA_SPACE_ID}/session/${session.session_id}`);
}

main().catch(err => {
  console.error('❌ Moderator failed:', err.message);
  process.exit(1);
});
