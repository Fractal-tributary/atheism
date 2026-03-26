import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { A2AMessage, A2ASpaceConfig, ActiveJob, OnlineAgent, AgentProfile, SessionSummary } from "./types.js";
import { createA2AResponse, fetchSessionMessages, updateA2AMessage, deleteA2AMessage, fetchCustomRules, fetchSessionSummary, updateSessionSummary, fetchSkillDirectory, notifyNoReply, fetchLedgerRendered } from "./send.js";
import { getA2ARuntime } from "./runtime.js";
import { createA2AReplyDispatcher } from "./reply-dispatcher.js";
import { extractUsageFromTranscript } from "./usage-extractor.js";

// ─── @mention 辅助 ─────────────────────────────────────────

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 检查消息文本是否 @了指定 Agent。
 * 单一来源：bot.ts 和 monitor.ts 均使用此函数。
 */
export function isAgentMentioned(text: string, agentId: string, agentName?: string): boolean {
  if (!text) return false;
  const shortId = agentId.replace(/^agent_/, '');
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

const processedMessages = new Set<string>();

// 🆕 定期清理 processedMessages，防止内存泄漏
// 之前完全没有清理逻辑，240 poll 路径持续运行几小时后积累数十万条目
setInterval(() => {
  if (processedMessages.size > 500) {
    const arr = [...processedMessages];
    const toRemove = arr.slice(0, arr.length - 200);
    for (const id of toRemove) processedMessages.delete(id);
    console.log(`atheism: [GC] trimmed processedMessages: ${arr.length} → ${processedMessages.size}`);
  }
}, 60_000);

/** 检查某条消息是否已被某 Agent 处理过（供 monitor.ts 判断 completion signal） */
export function isMessageProcessed(agentId: string, messageId: string): boolean {
  return processedMessages.has(`${agentId}:${messageId}`);
}

/** 手动标记某条消息为已处理（startup cleanup 用，防止重启后重复处理） */
export function markMessageProcessed(agentId: string, messageId: string): void {
  processedMessages.add(`${agentId}:${messageId}`);
}

// ─── 并发任务管理 ─────────────────────────────────────────
// key = `${agentId}:${sessionId}` — 每个逻辑 Agent 在每个 session 独立
const activeJobs = new Map<string, ActiveJob>();
const pendingQueue: Array<{
  cfg: OpenClawConfig;
  message: A2AMessage;
  config: A2ASpaceConfig;
  onlineAgents: OnlineAgent[];
  agentProfile: AgentProfile;
}> = [];

let maxConcurrent = 3;

export function setMaxConcurrent(n: number) {
  maxConcurrent = Math.max(1, n);
}
export function getMaxConcurrent() { return maxConcurrent; }

/** 生成 job key：agentId + sessionId */
function jobKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`;
}

export function getActiveJob(sessionId: string, agentId?: string): ActiveJob | undefined {
  if (agentId) {
    return activeJobs.get(jobKey(agentId, sessionId));
  }
  // 向后兼容：任意 agent 在该 session 有 job 即算
  for (const [k, v] of activeJobs) {
    if (v.sessionId === sessionId) return v;
  }
  return undefined;
}

export function getActiveJobForAgent(agentId: string, sessionId: string): ActiveJob | undefined {
  return activeJobs.get(jobKey(agentId, sessionId));
}

export function getActiveJobCount(): number {
  return activeJobs.size;
}
export function getAllActiveJobs(): Map<string, ActiveJob> {
  return activeJobs;
}

export function clearActiveJob(sessionId: string, agentId?: string) {
  if (agentId) {
    activeJobs.delete(jobKey(agentId, sessionId));
  } else {
    // 向后兼容
    for (const [k, v] of activeJobs) {
      if (v.sessionId === sessionId) { activeJobs.delete(k); break; }
    }
  }
  drainQueue();
}

/** 中断指定 agent 在指定 session 的活跃任务 */
export async function abortActiveJob(sessionId: string, reason: string, agentId?: string, skipMessageUpdate?: boolean): Promise<void> {
  const key = agentId ? jobKey(agentId, sessionId) : undefined;
  let job: ActiveJob | undefined;
  
  if (key) {
    job = activeJobs.get(key);
  } else {
    for (const [k, v] of activeJobs) {
      if (v.sessionId === sessionId) { job = v; break; }
    }
  }
  
  if (!job) return;
  const log = console.log;
  
  log(`atheism: [ABORT] ${job.agentId}@${sessionId}, job ${job.jobId}: ${reason}${skipMessageUpdate ? ' (skip msg update)' : ''}`);
  job.abortController.abort();
  
  // Only update the message if a response was actually created (non-deferred or deferred that got created)
  // skipMessageUpdate: when server already finalized the message (e.g. hard interrupt), skip to avoid
  // undoing the server's quiesce/poison pill via resetQuiesce triggered by the PUT
  if (job.responseId && !skipMessageUpdate) {
    try {
      // 🆕 对于"新消息到达"导致的中断，如果 agent 还在占位状态，直接删除消息
      // 避免 "⚡ 新消息到达，中断当前任务" 噪声（用户看到一堆 ⚡ 毫无信息量）
      // 对于 @human 暂停等有语义的中断，仍然保留标记
      const isNewMsgInterrupt = reason.includes('新消息到达') || reason.includes('中断当前');
      const isLockRenewalDenied = reason.includes('锁续期被拒');
      if (isNewMsgInterrupt || isLockRenewalDenied) {
        await deleteA2AMessage({ config: job.config, messageId: job.responseId });
        log(`atheism: [ABORT] deleted placeholder message ${job.responseId} (reason: ${reason})`);
      } else {
        await updateA2AMessage({
          config: job.config,
          messageId: job.responseId,
          result: `⚡ ${reason}`,
          streaming: false,
        });
      }
    } catch (err) {
      log(`atheism: [ABORT] failed to update/delete message: ${err}`);
    }
  }
  
  activeJobs.delete(jobKey(job.agentId, sessionId));
}

/** 计算指定 space 的活跃 job 数量 */
function spaceActiveCount(spaceId: string): number {
  let count = 0;
  for (const job of activeJobs.values()) {
    if (job.spaceId === spaceId) count++;
  }
  return count;
}

/** 处理排队任务 */
function drainQueue() {
  const log = console.log;
  const remaining: typeof pendingQueue = [];
  while (pendingQueue.length > 0) {
    const next = pendingQueue.shift()!;
    const sid = next.message.session_id || "session_default";
    const spc = next.message.space_id || "default";
    const aId = next.agentProfile.agentId;
    if (activeJobs.has(jobKey(aId, sid))) { remaining.push(next); continue; }
    if (spaceActiveCount(spc) >= maxConcurrent) { remaining.push(next); continue; }
    log(`atheism: [DEQUEUE] ${aId}@${sid} (space ${spc}: ${spaceActiveCount(spc) + 1}/${maxConcurrent})`);
    handleA2AMessage(next).catch(err => console.error(`atheism: [BG] error: ${err}`));
  }
  pendingQueue.push(...remaining);
}

// ─── 多 Agent 协作协议（自然语言驱动）─────────────────────────
function buildCollaborationProtocol(selfAgentId: string, onlineAgents: OnlineAgent[], apiBaseUrl?: string, sessionId?: string): string {
  const agentList = onlineAgents.map(a => {
    const isMe = a.agent_id === selfAgentId;
    const caps = a.capabilities?.length ? ` [${a.capabilities.join(', ')}]` : '';
    const desc = a.description ? ` — ${a.description}` : '';
    return `  · ${a.name || a.agent_id}${isMe ? ' (你)' : ''}${caps}${desc}`;
  }).join('\n');

  const isAlone = onlineAgents.length <= 1;

  if (isAlone) {
    return `You are the only agent in this Atheism collaboration session.
Handle all tasks directly. If the human message needs a response, respond helpfully.
If a previous agent message already fully addressed the topic and there's nothing to add, reply with exactly NO_REPLY.`;
  }

  return `# 多 Agent 协作协议

你是协作空间中的一个 Agent。每次被唤醒时，你会看到完整的会话历史。
你的唯一决策：**发言，还是 NO_REPLY。**

## 当前在线 Agents（共 ${onlineAgents.length} 个）
${agentList}

## ⚠️ 任务复杂度分流（收到新任务后先判断）

第一个响应的 Agent 判断任务复杂度，选择对应模式：
**任何 Agent 认为评级不当时，可在首轮发言中提议调整。**

### Level 1：轻量级（讨论/意见类）
特征：阅读材料、发表看法、回答问题、头脑风暴
→ 各自发言，不需要分工协商。有价值就说，没有就 NO_REPLY。

### Level 2：中等（调研+输出类）
特征：有明确产出目标，但不需要多步骤协作
→ 一轮表态认领，各自执行，完成后汇报。

### Level 3：重度（多步骤协作类）
特征：需要多 Agent 配合、有依赖关系、产出物相互引用
→ 完整分工流程：分析 → 分工 → 确认依赖 → 执行。**分工阶段不调用工具。**

## 阅读历史，判断当前阶段

### 阶段 1：分工讨论（新任务，还没人开始做）
- 如果你是第一个看到任务的 Agent：
  → **先查看已有 Skill 列表**（见下方 Skill 查询方法），看有没有可直接复用的
  → 判断任务复杂度（L1/L2/L3），选择对应协作模式
  → 如果是 L1，直接发言；如果是 L2/L3，分析需求并提出分工
  → 如果找到相关 Skill，在分工中说明"可复用 Skill: xxx"
  → **L3 任务：只讨论，不执行**
  → **禁止阻塞式等待。** 不要说"等确认再开始"、"等你同意后执行"。提出方案后直接标注认领并开始执行。沉默 = 同意。其他 Agent 有异议时主动发言调整。
- 如果已有 Agent 提出分工方案：
  → 表态同意/调整/认领你的部分
  → 如果对方的方案合理且已覆盖你 → NO_REPLY

### 阶段 2：执行（分工已明确，至少两个 Agent 都已表态）
- 执行你在分工阶段认领的部分（此时可以调用工具）
- 如果分工中提到了可复用的 Skill，先获取其详情参考
- 完成后汇报结果

### 阶段 3：协调（执行过程中需要配合）
- 跟你有关（需要你的输出/有冲突） → 发言协调
- 跟你无关 → NO_REPLY

### 阶段 4：汇报（所有任务都做完了）
- 由分工阶段**显式指定**的汇报人负责整合（分工时必须在 ledger 中写明汇报人，不依赖"最后完成的人自觉汇报"）
- 汇报面向人类，不是面向其他 Agent：
  → 过滤 agent 间的协调细节，突出结论、交付物和下一步行动
  → 产出结构化信息（对比、统计、流程、状态）时，或者需要人类观察的信息时，优先可视化，注意人类友好的内容产出
- 汇报后同步触发沉淀检查：本轮有无可复用产出？有则主动发起沉淀

### 阶段 5：反馈（人类给了反馈）
- 需要修改 → 回到阶段 1 讨论修改方案
- 人类满意 → 如果成果有复用价值，建议归档为 skill

### 阶段 6：显式检查点（讨论收敛时）
当出现连续 NO_REPLY（收敛信号）时，**最后一个发过实质内容的 Agent** 必须检查：
- 本轮是否有未持久化的有价值产出？
- 如果有 → 发起沉淀提议：「建议沉淀为 Skill: [名称]，由 [Agent] 负责整理。」
- 如果没有 → 显式声明「本轮无需沉淀」
- 实际整理工作按角色映射分配（详见 \`a2a-collaboration-protocol\` Skill 第 2 章）

## 如何判断当前阶段

看会话历史中最近的消息：
- 只有人类任务，没有 Agent 回复 → **阶段 1**
- 有 Agent 的分工建议，但还没有执行结果 → **阶段 1**（继续讨论）或进入 **阶段 2**（所有人都表态了）
- 有 Agent 发了执行结果 → **阶段 2~3**
- 所有认领的任务都有结果了 → **阶段 4**
- 人类说了"修改/不对/重来" → **阶段 5 → 回到 1**
- 连续 NO_REPLY 出现 → **阶段 6**（显式检查点）

### 收敛重激活规则
当对话已经收敛（连续 NO_REPLY 或阶段 6 完成）后，**人类的下一条消息 = 新任务**，所有 Agent 回到阶段 1 重新评估。
不要因为之前收敛了就继续沉默——人类开口就是新的触发。

## NO_REPLY 原则

宁可沉默也不要说废话。**发言前必须通过以下两道自检，任一未通过 → NO_REPLY：**

### 🚦 发言自检（必须先过这两关）

1. **角色独占性检查**：去掉你的角色名，这段话换成任何其他 Agent 发出来是否完全成立？如果是 → NO_REPLY。你的回复必须携带只有你的专业角色才能提供的东西（代码方案、数据引用、产品判断、审查意见等）。
2. **信息增量检查**：去掉你的回复中与前面已有回复重叠的内容，剩下的部分能否构成一段完整的、独立的新论点或新信息？如果不能 → NO_REPLY。

### 兜底规则（自检通过后仍需注意）

以下情况 **必须 NO_REPLY**：
- 别人已经说得很好，你只是想说"同意"或"好的"
- 与你无关的执行进展
- 你刚说完话，别人还没回应，不要连续自言自语
- 对话中没有需要你回应的新内容
- **你的回复和你之前某条消息内容高度相似（>80%）→ 不要发，这是复读**
- 已有多个 Agent 从不同角度回复了同一问题，你没有**前面回复中明确缺失的信息或反对意见** → NO_REPLY

如果你决定不发言，**整条回复仅包含** \`NO_REPLY\` 这一个词，不要有任何其他内容。

**禁止全员沉默。** 如果你是最后一个被唤醒的 Agent，且你看到其他所有 Agent 都 NO_REPLY 了，而任务明显没完成——你必须发言推进，不允许也 NO_REPLY。

## 发言原则

- 每条消息都应该推进任务（分析、认领、执行结果、协调、汇报）
- 不要重复别人说过的话
- 不要空泛讨论，要具体行动
- 简洁有力，不要客套
- 产出有复用价值的结论时，主动沉淀为 Skill，不要等收敛检查点
- 产出结论/数据/方案后，判断是否有跨任务复用价值——有就立即沉淀，不等收敛
- 产出结构化信息（对比、统计、流程、状态）时，或者需要人类观察的信息时，优先可视化，注意人类友好的内容产出

## 🏷️ audience 自标注（必做）

摘要模式下连续 agent 消息会被折叠。为让面向人类的消息不被埋没，**每条回复末尾必须附加标签**：

\`[audience:user]\` — 人类需要看到的消息
\`[audience:agent]\` — agent 间协调（或不标，默认视为 agent）

标签会被系统自动剥离，用户看不到。

**标 \`user\` 的场景：**
- 汇报交付物、总结结论（阶段 4 产出）
- 包含 \`@human\` 或显式求人类决策
- 回答人类的直接提问
- 新任务后的**首条分工提议**
- 发起需要人类确认的方案

**标 \`agent\`（或不标）的场景：**
- 分工表态、认领、技术细节
- \`@其他Agent\` 的定向沟通
- 工具调用的过程性输出

**简单判断法：这条消息如果人类没看到，会 miss 什么？会 → \`user\`，不会 → \`agent\`。**
一条消息同时面向人类和 agent → 标 \`user\`。宁可多露不漏埋。

## 📋 Collaboration Ledger — Agent 间协调索引

你被唤醒时会看到 \`[Collaboration Ledger]\` 块。这是 agent 间的压缩协调通道，不是给人类看的。

**写给下一个 agent 看。** 对方只读你的 slot，就知道当前局面和自己该干什么——这是唯一标准。

### 三个写入时机

1. **分工确定后** — 把 plan 写进去。谁干什么、产出物是什么。这是最高价值的写入——后续 agent 醒来不用翻聊天记录。
2. **有产出要交接时** — 核心结论 + 引用（→skill:name / →file:id / →msg#N）+ 对下游的指引
3. **被卡住时** — 需要谁提供什么

### 格式

≤280 字符。用 \`→\` 指向产出物，用 \`|\` 分隔信息单元。

示例：
- \`plan: R调研竞品|C写原型|CR review | 依赖: R先出→skill:competitive\`
- \`竞品分析完成→skill:competitive-landscape | @Coder 可以基于第3节API对比开始实现\`
- \`blocked: 等@Researcher API文档才能写适配层\`

### 更新方法

**你的 Agent ID**: \`${selfAgentId}\`${sessionId ? `\n**当前 Session ID**: \\\`${sessionId}\\\`` : ''}

\`\`\`bash
curl -s -X PUT "${apiBaseUrl || 'http://localhost:3000/api'}/sessions/${sessionId || 'SESSION_ID'}/ledger/slots/${selfAgentId}" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "你的 slot 内容，≤280字符"}'
\`\`\`

### 追加共享笔记（可选，用于记录关键决策）
\`\`\`bash
curl -s -X POST "${apiBaseUrl || 'http://localhost:3000/api'}/sessions/${sessionId || 'SESSION_ID'}/ledger/notes" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "决策=选方案A，原因是XX", "author": "${selfAgentId}"}'
\`\`\`

消息是给人类看的叙事，ledger 是给 agent 看的压缩指令。两者不冲突，都要写。

## 📣 @提及机制

在消息中使用 \`@AgentName\` 可以指定希望哪个 Agent 优先响应。**鼓励使用 @ 来提高协作效率。**

### @Agent — 指定 Agent 优先响应
- \`@Coder 帮忙看看这个实现\` → Coder 优先拿到评估锁，其他 Agent 等 Coder 完成后再评估
- 可以 @ 多个：\`@Coder @Code Reviewer 这段代码需要你们看看\`
- 支持显示名和 ID（不含 agent_ 前缀）

### @human — 暂停协作，等待人类输入
- 当你需要人类补充信息、确认方向或做决策时，在消息中加入 \`@human\`
- 例如：\`方案 A 和 B 各有利弊，@human 请决定方向\`
- 效果：**所有 Agent 暂停该 session 的协作**，直到人类发新消息

### 使用建议
- 分工指派用 @：\`@Researcher 负责调研，@Coder 负责实现\`
- 定向提问用 @：\`@Coder 你那边进展如何？\`
- 遇到阻塞需人类决策用 @human
- 不需要指定时不 @ 任何人，按正常轮询顺序

## 📦 Space Skills — 共享知识库

**Skill 是 Space 级别的共享数据层。** 所有 Agent 都能读写同一个 Space 的 Skills。
用途：
- **共享调研成果**：一个 Agent 的调研结果沉淀为 Skill，其他 Agent 直接复用
- **共享数据和中间产物**：大段数据、分析结果、渠道清单等，写成 Skill 供协作伙伴引用
- **持久化知识**：Skill 持久保存，跨 session 可用

### ⚡ 执行过程中的数据共享

**当你的工作产物需要被其他 Agent 使用时，立即创建/更新 Skill，不要等任务全部结束。**

例如：
- Researcher 完成了产品调研 → 立即创建 Skill "eve-product-profile"，其他 Agent 可以 curl 获取
- API Researcher 找到了 API 文档 → 立即创建 Skill "eve-api-endpoints"
- 策划完成竞品分析 → 创建 Skill "ai-roleplay-competitive-landscape"

这样其他 Agent 在执行阶段可以直接拉取你的成果，而不是等你发消息再从聊天记录里找。

### 查询已有 Skill（分工前必查）

\`\`\`bash
# 列出当前 Space 的所有 Skill
curl -s "${apiBaseUrl || 'http://localhost:3000/api'}/skills"
# 返回: {"skills": [{"skill_id": "...", "name": "...", "description": "...", ...}]}

# 获取单个 Skill 的完整内容
curl -s "${apiBaseUrl || 'http://localhost:3000/api'}/skills/SKILL_ID"
# 返回包含 skill_md 的完整文档
\`\`\`

### 创建 / 更新 Skill

**版本迭代规则：** 更新已有 Skill 时用 **PUT**（覆盖更新），不要 POST 创建新副本。同一个 skill 只保留一份，通过 version 字段标记版本号。

\`\`\`bash
# 创建新 Skill（首次）
curl -s -X POST "${apiBaseUrl || 'http://localhost:3000/api'}/skills" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "skill-name-kebab-case",
    "version": "1.0.0",
    "description": "一句话描述",
    "skill_md": "完整的 Markdown 内容（调研数据、分析结果、方法流程等）",
    "metadata": {
      "author": "你的 agent_id",
      "tags": ["标签1", "标签2"],
      "source_session": "当前 session_id"
    }
  }'
\`\`\`

### 何时沉淀（按信息价值，非产出形式）

核心原则：**按信息价值判断是否沉淀，不按产出形式。** 聊天消息中的结构化分析与正式文档具有同等沉淀资格。

**触发条件 1：可复用知识** — 方法论、框架、对比分析、最佳实践、趋势判断。无论来自执行还是讨论，只要有通用性就沉淀。结构化分析不因发表形式（聊天消息 vs 正式文档）而降级。标记 \`info_type: reusable-knowledge\`。

**触发条件 2：决策记录** — 为什么选 A 不选 B、权衡了哪些因素、被推翻的假设。标记 \`info_type: decision-record\`。

**触发条件 3：高价值讨论** — ≥3 个 Agent 各自产出结构化分析，或讨论涉及方法论/框架的系统性总结，或人类给出正面反馈。标记 \`info_type: high-value-discussion\`。

**不沉淀的**：纯转述（无推断）、一次性回答（绑定当前上下文）、与已有 Skill 高度重复且无新信息。

> 创建 Skill 前先查阅 \`a2a-collaboration-protocol\` Skill 的 Golden Principles（M1-M5 质量门禁 + S1-S4 建议项）。

创建后告知协作伙伴和人类："已创建 Skill: xxx，可通过 \`curl .../skills/SKILL_ID\` 获取。"

### 🔍 Skill 自检（创建/更新后必做）

创建或更新 Skill 后，立即 read-back 确认内容完整：
\`\`\`bash
curl -s "${apiBaseUrl || 'http://localhost:3000/api'}/skills/SKILL_ID" | head -c 200
\`\`\`
检查：1) skill_md 不为空 2) 内容没被截断 3) version 正确。如果不完整，立即用 PUT 修复。

### 📋 Skill 目录维护（重要！）

每次创建、更新或删除 Skill 后，你**必须**同步更新 Space 的 Skill 目录。
目录是所有 Agent 的路由表——它决定了大家能不能找到正确的 Skill。

**更新方法：**
1. 先获取当前目录：\`curl -s "${apiBaseUrl || 'http://localhost:3000/api'}/skill-directory"\`
2. 结合你刚才的操作（新增/修改/删除了哪个 skill），重新整理目录
3. 写回更新后的目录：
\`\`\`bash
curl -s -X PUT "${apiBaseUrl || 'http://localhost:3000/api'}/skill-directory" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "整理后的目录 Markdown", "agent_id": "你的 agent_id"}'
\`\`\`

**整理原则：**
- 按领域/主题分组（如"部署运维"、"Prompt 工程"、"数据查询"等）
- 每个 skill 用一行说明：**skill_name**: 它包含什么、什么场景该用它
- 同一主题的迭代版本合并说明（"v3→v4→v5，最新为 v6"），不要逐个重复
- 保留 skill name（其他 Agent 需要用 name 来获取完整内容）
- 简洁有力，让其他 Agent 一眼就能判断"我需要查哪个 skill"

## 📁 文件共享 — Space Files

Space 内的所有 Agent 可以通过文件 API 共享文件（代码、数据、图片、文档等）。

### 上传文件

\`\`\`bash
# 上传文本文件（直接传内容）
curl -s -X POST "${apiBaseUrl || 'http://localhost:3000/api'}/files" \\
  -H "Content-Type: application/json" \\
  -d '{
    "filename": "analysis-result.md",
    "content_text": "文件的文本内容...",
    "uploaded_by": "你的 agent_id",
    "description": "简短描述"
  }'

# 上传二进制文件（base64）
curl -s -X POST "${apiBaseUrl || 'http://localhost:3000/api'}/files" \\
  -H "Content-Type: application/json" \\
  -d '{
    "filename": "data.csv",
    "content_base64": "base64编码的内容...",
    "mime_type": "text/csv",
    "uploaded_by": "你的 agent_id"
  }'
# 返回: {"file_id": "file_xxx", "download_url": "/api/spaces/.../files/file_xxx/download"}
\`\`\`

### 查看和下载文件

\`\`\`bash
# 列出 Space 的所有文件
curl -s "${apiBaseUrl || 'http://localhost:3000/api'}/files"
# 返回: {"files": [{"file_id": "...", "filename": "...", "size": ..., "uploaded_by": "...", ...}]}

# 下载/读取文件内容（文本文件）
curl -s "${apiBaseUrl || 'http://localhost:3000/api'}/files/FILE_ID/content"
\`\`\`

### 何时使用文件共享（而非 Skill）
- **代码文件、数据文件、配置文件** → 用 Files（保留原始格式）
- **分析报告、调研结论、方法论** → 用 Skills（结构化知识）
- **大段原始数据、日志、CSV** → 用 Files
- **需要其他 Agent 直接 \`cat\` 或处理的内容** → 用 Files

上传后告知协作伙伴："已上传文件 xxx (file_id: file_xxx)，可通过 \`curl .../files/file_xxx/content\` 获取。"

## 📊 可视化 — Artifact API

当需要展示图表、数据可视化、HTML 内容时，**不要使用 canvas 工具**，使用 Artifact API：

\`\`\`bash
# 上传 HTML 可视化到 server
curl -s -X POST "${apiBaseUrl || 'http://localhost:3000/api'}/artifacts" \\
  -H "Content-Type: application/json" \\
  -d '{"html": "<完整的HTML内容>", "name": "chart-name", "session_id": "当前session"}'
# 返回: {"artifact_id": "...", "url": "http://host:3000/artifacts/xxx.html"}
\`\`\`

上传后，在回复中包含返回的 URL，Web 端会自动以 iframe 嵌入展示。

技巧：
- HTML 中可以使用 Chart.js、ECharts 等 CDN 库做图表
- 可以用 \`<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>\` 引入图表库
- 图表的背景设为白色，确保可读性
- 如果内容复杂，先用 exec 把 HTML 写到临时文件，再 curl 上传`;
}

async function buildGroupSystemPrompt(
  config: A2ASpaceConfig, agentId: string, onlineAgents: OnlineAgent[],
  actualSpaceId?: string, sessionId?: string,
  /** B' 分层注入: session summary 放入 extraSystemPrompt（不进 transcript） */
  sessionSummary?: string | null,
  /** B' 分层注入: collaboration ledger 放入 extraSystemPrompt（不进 transcript） */
  ledgerRendered?: string | null,
): Promise<string> {
  const apiBase = config.apiUrl || 'http://localhost:3000/api';
  // 使用消息实际所在的 space_id，而非 config 中的 spaceId（可能是 "*"）
  const spaceId = actualSpaceId || (typeof config.spaceId === 'string' && config.spaceId !== '*' ? config.spaceId : 'default');
  const spaceConfig = { ...config, spaceId } as A2ASpaceConfig;
  const protocol = buildCollaborationProtocol(agentId, onlineAgents, `${apiBase}/spaces/${spaceId}`, sessionId);
  
  let customRules = "";
  try {
    customRules = await fetchCustomRules({ config: spaceConfig });
  } catch {}

  // 🆕 获取 Skill 目录
  let skillDirectory = "";
  try {
    skillDirectory = await fetchSkillDirectory({ config: spaceConfig }) || "";
  } catch {}
  
  let result = "";

  // B' 分层注入: summary 和 ledger 作为 pinned context 每轮刷新，不进 transcript
  if (sessionSummary?.trim()) {
    result += `## 会话摘要\n${sessionSummary}\n\n`;
  }
  if (ledgerRendered?.trim()) {
    result += `## Collaboration Ledger\n${ledgerRendered}\n\n`;
  }

  result += protocol;
  
  if (skillDirectory.trim()) {
    result += `\n\n## 📦 本 Space 已有 Skills\n\n${skillDirectory}`;
  }
  
  if (customRules.trim()) {
    result += `\n\n## 额外规则（由人类设定）\n${customRules}`;
  }
  
  return result;
}

/** 将会话历史转为 InboundHistory 结构 */
function buildInboundHistory(messages: A2AMessage[], selfAgentId: string): Array<{ sender: string; body: string; timestamp?: number }> {
  if (!messages || messages.length === 0) return [];
  
  return messages.map(msg => {
    // 🛡️ 防御残缺消息（缺少 content/type/from_agent 字段的 zombie placeholder）
    if (!msg.content || !msg.type) return null;

    const isMe = msg.from_agent === selfAgentId;
    const sender = msg.from_agent === "human" 
      ? "human" 
      : isMe ? "assistant" : (msg.from_name || msg.from_agent || "unknown");
    
    let body = "";
    if (msg.type === "human_job") {
      body = msg.content.job || msg.content.message || "";
    } else if (msg.type === "human_job_response") {
      body = typeof msg.content.result === "string" ? msg.content.result : JSON.stringify(msg.content.result);
      if (body.length > 800) body = body.substring(0, 800) + "... (truncated)";
      
      // 🆕 检测历史中的截断标记（由 dispatcher 在响应异常中断时添加）
      // 如果消息已经包含截断标记，保留原文
      // 如果消息仍在 streaming 状态，说明 Agent 可能已经退出（zombie 未清理）
      if (msg.content.streaming === true) {
        body += '\n\n⚠️ [此 Agent 的回复仍在生成中或已异常中断]';
      }
    } else if (msg.type === "chat") {
      body = msg.content.message || "";
    } else {
      const raw = JSON.stringify(msg.content);
      body = (raw && raw !== '{}') ? raw : "";
    }
    
    return { sender, body: body || "", timestamp: new Date(msg.timestamp).getTime() };
  }).filter((h): h is NonNullable<typeof h> => h != null && (h.body?.length ?? 0) > 0);
}

export async function handleA2AMessage(params: {
  cfg: OpenClawConfig;
  message: A2AMessage;
  config: A2ASpaceConfig;
  onlineAgents?: OnlineAgent[];
  /** 当前处理这条消息的逻辑 Agent 身份 */
  agentProfile: AgentProfile;
  /** 🆕 First Responder: 本轮已有哪个 Agent 实质回复 */
  firstResponder?: { agent_id: string; agent_name?: string; responded_at: number } | null;
  /** 🆕 Lock version for orphan write prevention */
  lockVersion?: string;
  /** 🆕 Round response limit info */
  respondersCount?: number;
  responseLimit?: 'normal' | 'soft_limited' | 'hard_limited';
  isMentioned?: boolean;
  responders?: Array<{ agent_id: string; agent_name: string }>;
}): Promise<void> {
  const { cfg, message, config, onlineAgents = [], agentProfile, firstResponder, lockVersion, respondersCount, responseLimit, isMentioned, responders } = params;
  const core = getA2ARuntime();
  const log = console.log;
  const error = console.error;

  const agentId = agentProfile.agentId;
  const msgId = message.message_id;
  const sessionId = message.session_id || "session_default";
  const spaceId = message.space_id || "default";
  const isHuman = message.from_agent === "human";
  // 🆕 completion signal 触发的 re-evaluation 应保留 tool 权限
  // 合成消息 ID 包含 "_completed_"，说明是其他 agent 完成后触发的二次评估
  const isCompletionTrigger = msgId.includes("_completed_");

  // 🆕 per-agent + per-message 去重
  const dedupKey = `${agentId}:${msgId}`;
  if (processedMessages.has(dedupKey)) return;
  
  // 检查该 agent 在该 session 是否已有活跃任务
  const jk = jobKey(agentId, sessionId);
  if (activeJobs.has(jk)) {
    log(`atheism: ${agentId}@${sessionId} busy, skipping ${msgId}`);
    return;
  }
  
  // 检查该 space 的并发上限（per-space 独立）
  const spaceCount = spaceActiveCount(spaceId);
  if (spaceCount >= maxConcurrent) {
    log(`atheism: [QUEUE] space ${spaceId} concurrent limit (${spaceCount}/${maxConcurrent}), queuing ${agentId}@${sessionId}:${msgId}`);
    pendingQueue.push(params);
    processedMessages.add(dedupKey);
    return;
  }

  // Defensive: skip corrupted messages with missing content
  if (!message.content || typeof message.content !== 'object') {
    log(`atheism: [${agentId}@${sessionId}] skipping ${msgId}: missing or invalid content`);
    processedMessages.add(dedupKey);
    return;
  }
  const msgText = message.content.job || message.content.message || message.content.result || "";
  if (!msgText) {
    log(`atheism: no text in message ${msgId}`);
    return;
  }

  // 🆕 Detect summary request trigger from quiesce hook
  const isSummaryRequest = msgId.startsWith('summary_request_');

  processedMessages.add(dedupKey);
  const abortController = new AbortController();
  let responseId = ""; // 🆕 声明在 try 外部，供 catch 清理 zombie placeholder
  let markDispatchAborted: (() => void) | undefined; // 🆕 声明在 try 外部，供 catch 使用

  try {
    log(`atheism: [${agentId}@${sessionId}] processing ${msgId} (space: ${spaceId}, from: ${message.from_agent}, agents: ${onlineAgents.length}, space-concurrent: ${spaceActiveCount(spaceId) + 1}/${maxConcurrent}, global: ${activeJobs.size + 1}): "${msgText.substring(0, 60)}"`);

    // 获取完整会话历史
    let fullHistory: A2AMessage[] = [];
    try {
      fullHistory = await fetchSessionMessages({ config, sessionId, limit: 30 });
    } catch (err) {
      log(`atheism: [${sessionId}] failed to fetch history: ${err}`);
    }
    
    // 🆕 获取 session summary
    let sessionSummary: { summary_text: string; last_message_id: string | null; message_count: number } | null = null;
    try {
      sessionSummary = await fetchSessionSummary({ config, sessionId });
    } catch {}

    // 🆕 获取 collaboration ledger (AI-optimized context)
    let ledgerRendered: string | null = null;
    try {
      ledgerRendered = await fetchLedgerRendered({ config, sessionId });
    } catch {}
    
    // B' DELTA mode: 只发 agent 上次回复后的增量消息，不发全量历史
    // 全量历史已在 OpenClaw transcript 中累积，避免双重叠加
    // Summary + Ledger 移入 GroupSystemPrompt（extraSystemPrompt 通道，不进 transcript）
    const historyWithoutCurrent = fullHistory.filter(m => m.message_id !== msgId);
    let myLastIdx = -1;
    for (let i = historyWithoutCurrent.length - 1; i >= 0; i--) {
      if (historyWithoutCurrent[i].from_agent === agentId) {
        myLastIdx = i;
        break;
      }
    }
    // Delta: 只包含 agent 上次回复之后的消息（其他 agent 的回复 + 新的人类消息）
    // 首次 dispatch（myLastIdx === -1）时发近期历史（transcript 为空，无重复）
    // Cap at 30: 防御竞态——若 agent 上次回复还在 streaming 未入 history，myLastIdx 会误判为 -1
    // 此时 transcript 已有前轮内容，全量历史会导致一次性重叠。Cap 限制最坏情况下的重叠量
    // 30 条足以覆盖 8-agent L3 分工讨论（一轮约 20-25 条），同时保底包含首条人类消息
    const MAX_INITIAL_HISTORY = 30;
    let deltaMessages = myLastIdx >= 0
      ? historyWithoutCurrent.slice(myLastIdx + 1)
      : historyWithoutCurrent.slice(-MAX_INITIAL_HISTORY);
    // 保底: 首次 dispatch 时确保包含本轮第一条人类消息（任务原文），即使被 cap 截断
    if (myLastIdx < 0 && deltaMessages.length > 0) {
      const firstHumanInRound = historyWithoutCurrent.find(m => m.from_agent === 'human');
      if (firstHumanInRound && !deltaMessages.includes(firstHumanInRound)) {
        deltaMessages = [firstHumanInRound, ...deltaMessages];
      }
    }
    const inboundHistory = buildInboundHistory(deltaMessages, agentId);
    // Note: summary 和 ledger 不再注入 inboundHistory，已移入 GroupSystemPrompt

    // 🆕 Round Responders 提示 — 两级限流
    if (responseLimit === 'soft_limited' && !isMentioned) {
      // Soft limit: 强约束提示，但仍允许 agent 评估
      const responderNames = (responders || []).map(r => r.agent_name || r.agent_id).join(', ');
      inboundHistory.push({
        sender: "system",
        body: `[⚠️ Round Response Limit] 本轮已有 ${respondersCount || 0} 个 Agent 实质回复（${responderNames}），已达到 soft limit。除非你要**纠正前面回复中的事实错误**，否则你**必须 NO_REPLY**。「补充一点」「从另一个角度看」都不构成回复理由。只有「前面说错了」才可以。`,
        timestamp: 0,
      });
    } else if (firstResponder && firstResponder.agent_id !== agentId) {
      // 正常情况：有前序回复但未触发 soft limit
      const frName = firstResponder.agent_name || firstResponder.agent_id;
      const responderNames = (responders || []).map(r => r.agent_name || r.agent_id).join(', ');
      const countInfo = (respondersCount && respondersCount > 1) ? `（已有 ${respondersCount} 个 Agent 回复：${responderNames}）` : '';
      inboundHistory.push({
        sender: "system",
        body: `[Round Responders] ${frName} 已率先对本轮人类消息做出实质回复${countInfo}。除非你有独特的、不重叠的专业补充（如不同领域的诊断、对方遗漏的关键信息），否则应 NO_REPLY。重复执行同一任务（如都去 SSH 检查同一台机器）是浪费。`,
        timestamp: 0,
      });
    }

    // 🆕 Summary Request: inject summary template when triggered by quiesce hook
    if (isSummaryRequest) {
      inboundHistory.push({
        sender: "system",
        body: `[📋 SUMMARY REQUEST — 你是本次任务的指定汇报人]

所有 Agent 已完成讨论，session 已收敛。请整合前面所有讨论内容，向人类提供任务总结。

**严格按以下格式输出，全文不超过 300 字：**

📋 **任务总结**
**结论：** 一句话回答人类的问题
**关键发现：**
- 要点1（一行，不超过两句）
- 要点2
- 要点3
**需要决策：** 列出需要人类拍板的点（没有就写"无"）
**下一步：** 谁做什么

**规则：**
- 不要出现"A agent 认为…B agent 提出…"的转述——人类不关心谁说的，只关心结论
- 如果 agent 之间有分歧未收敛，明确写"方案 X 和 Y 各有支持，核心分歧在于 Z，需要你来定"
- 信息密度高，手机上扫一眼能 get 到重点
- 必须标注 [audience:user]`,
        timestamp: Date.now(),
      });
    }

    // 🆕 始终延迟创建 placeholder — 只有当 Agent 有实质输出时才创建消息
    // 原来只对 completion signal 延迟，现在对所有 trigger 都延迟，
    // 彻底消除 ⏳ → [NO_REPLY] → delete 的可见噪声循环
    const deferPlaceholder = true;

    // 注册活跃任务（responseId 可能为空，deferred mode 时会在 createResponse 回调中更新）
    activeJobs.set(jk, { jobId: msgId, sessionId, spaceId, responseId, config, agentId, abortController, lockVersion });
    log(`atheism: [${agentId}@${sessionId}] active jobs: space ${spaceId}=${spaceActiveCount(spaceId)}/${maxConcurrent}, global=${activeJobs.size}`);

    // 🆕 两步路由:
    // Step 1: 用 agentId 做 peer.id 精确匹配 binding → 拿到正确的 agentId（a2a-coder / a2a-researcher）
    // Step 2: 手动构建 sessionKey 包含 space+session 信息 → 不同 session 不会共享上下文
    const route = core.channel.routing.resolveAgentRoute({
      cfg, channel: "a2aspace", accountId: "default", peer: { kind: "direct", id: agentId },
    });
    
    // B' 改造: 稳定 sessionKey（去掉 msgId），让 OpenClaw transcript 自然累积对话历史
    // 配合 DELTA mode InboundHistory，避免 transcript 与 InboundHistory 双重叠加
    // 解锁 OpenClaw compaction、token tracking、原生 usage API
    const stableSessionKey = `agent:${route.agentId}:a2aspace:direct:${agentId}:${spaceId}:${sessionId}`;
    const sessionKey = stableSessionKey;

    const senderName = isHuman ? "human" : (message.from_name || message.from_agent);
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Atheism", from: senderName, timestamp: new Date(), body: msgText,
    });

    // 协作协议使用当前 agentId — B' 分层注入: summary + ledger 进 extraSystemPrompt
    const groupSystemPrompt = await buildGroupSystemPrompt(
      config, agentId, onlineAgents, spaceId, sessionId,
      sessionSummary?.summary_text, ledgerRendered,
    );

    const ctx = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: msgText,
      RawBody: msgText,
      CommandBody: msgText,
      InboundHistory: inboundHistory,
      GroupSystemPrompt: groupSystemPrompt,
      GroupSubject: `Atheism Session`,
      From: `a2aspace:${message.from_agent}`,
      To: `a2aspace:${agentId}`,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: "group",
      SenderName: senderName,
      SenderId: message.from_agent,
      Provider: "a2aspace",
      Surface: "a2aspace",
      MessageSid: `${agentId}:${msgId}`,
      Timestamp: Date.now(),
      WasMentioned: isHuman || isCompletionTrigger || isAgentMentioned(msgText, agentId, agentProfile.agentName),
      CommandAuthorized: isHuman || isCompletionTrigger,
      OriginatingChannel: "a2aspace",
      OriginatingTo: `a2aspace:${agentId}`,
    });

    // 🆕 Deferred creation callback: 当 Agent 有实质输出时，才创建 response 消息
    const createResponseCallback = deferPlaceholder
      ? async (initialText: string): Promise<string> => {
          const id = await createA2AResponse({
            config, jobId: msgId, sessionId, initialResult: initialText, agentId, lockVersion,
          });
          // Update activeJob with the newly created responseId
          const job = activeJobs.get(jk);
          if (job) job.responseId = id;
          responseId = id;
          return id;
        }
      : undefined;

    const { dispatcher, replyOptions, markDispatchIdle, markDispatchAborted: _markAborted, isCompleted, isSilent, getResponseId } = createA2AReplyDispatcher({
      cfg, agentId: route.agentId, responseId, config, lockVersion,
      createResponse: createResponseCallback,
      onComplete: () => {
        log(`atheism: [${agentId}@${sessionId}] COMPLETE job ${msgId}`);
        clearActiveJob(sessionId, agentId);
        // 🆕 异步回填 token usage（不阻塞主流程）
        backfillUsageMetadata({
          config, agentId: route.agentId, sessionKey: stableSessionKey,
          getResponseId, log, error,
        }).catch(() => {});
      },
      onSilent: async () => {
        log(`atheism: [${agentId}@${sessionId}] SILENT for ${msgId}`);
        // 🆕 通知 server 用于 quiesce 追踪（不创建消息）
        try { await notifyNoReply({ config, sessionId, agentId }); } catch {}
        // 如果有创建过 placeholder（非 deferred 或 deferred 后创建了），删除它
        const effectiveId = getResponseId();
        if (effectiveId) {
          try { await deleteA2AMessage({ config, messageId: effectiveId }); } catch {}
        }
        clearActiveJob(sessionId, agentId);
      },
    });
    markDispatchAborted = _markAborted;  // 🆕 赋值到外部变量，供 catch 使用

    const result = await core.channel.reply.dispatchReplyFromConfig({
      ctx, cfg, dispatcher,
      replyOptions: { ...replyOptions, abortSignal: abortController.signal },
    });

    // 🆕 Bug 1 fix: 先检查 abort，再触发 onIdle
    // 如果 job 已被中断，通知 dispatcher 不要 deliver，避免覆盖 abortActiveJob 的 ⚡ 标记
    if (abortController.signal.aborted) {
      markDispatchAborted?.();
      log(`atheism: [${agentId}@${sessionId}] job was aborted, dispatcher notified`);
      return;
    }

    markDispatchIdle();

    if (!result?.queuedFinal && result?.counts?.final === 0) {
      if (!isCompleted() && !isSilent()) {
        // 没有产出任何消息 → 通知 quiesce 并清理 placeholder
        log(`atheism: [${agentId}@${sessionId}] no output for ${msgId}, notifying NO_REPLY`);
        try { await notifyNoReply({ config, sessionId, agentId }); } catch {}
        const effectiveId = getResponseId();
        if (effectiveId) {
          try { await deleteA2AMessage({ config, messageId: effectiveId }); } catch {}
        }
      }
      clearActiveJob(sessionId, agentId);
    }
    
    // 🆕 Summary 触发：每 10 条消息后，由当前 agent 生成/更新 summary
    if (!abortController.signal.aborted) {
      triggerSummaryIfNeeded({ config, sessionId, agentId, fullHistory, sessionSummary, isHuman }).catch(() => {});
    }

  } catch (err: any) {
    if (err?.name === "AbortError" || abortController.signal.aborted) {
      markDispatchAborted?.();  // 🆕 确保 abort 路径也通知 dispatcher
      log(`atheism: [${agentId}@${sessionId}] interrupted`);
      // P2: best-effort streaming cleanup on abort — 防止 abortActiveJob 的 update 失败后 streaming 残留
      const effectiveResponseId = activeJobs.get(jk)?.responseId || responseId;
      if (effectiveResponseId) {
        try {
          await updateA2AMessage({ config, messageId: effectiveResponseId, streaming: false });
          log(`atheism: [${agentId}@${sessionId}] abort path: streaming finalized for ${effectiveResponseId}`);
        } catch (e) {
          console.warn(`atheism: [${agentId}@${sessionId}] abort path: failed to finalize streaming for ${effectiveResponseId}:`, e);
        }
      }
      clearActiveJob(sessionId, agentId);
    } else {
      error(`atheism: [${agentId}@${sessionId}] error: ${err}`);
      // 🆕 清理 zombie placeholder — 检查 activeJob 中可能被 deferred 更新的 responseId
      const effectiveResponseId = activeJobs.get(jk)?.responseId || responseId;
      if (effectiveResponseId) {
        try {
          await updateA2AMessage({ config, messageId: effectiveResponseId, result: `❌ 处理出错: ${String(err).substring(0, 200)}`, streaming: false });
        } catch (e) {
          console.warn(`atheism: [${agentId}@${sessionId}] error path: failed to update message ${effectiveResponseId}:`, e);
        }
      }
      clearActiveJob(sessionId, agentId);
    }
  }
}

// 🆕 Token usage backfill — 异步从 session transcript 提取 usage 数据，PATCH 到消息 metadata
async function backfillUsageMetadata(params: {
  config: A2ASpaceConfig;
  agentId: string;
  sessionKey: string;
  getResponseId: () => string;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}): Promise<void> {
  const { config, agentId, sessionKey, getResponseId, log, error } = params;
  const responseId = getResponseId();
  if (!responseId) return;

  try {
    const usage = await extractUsageFromTranscript({ agentId, sessionKey });
    if (!usage) {
      log(`atheism: [USAGE] no usage data found for ${agentId} session ${sessionKey}`);
      return;
    }

    const metadata: Record<string, unknown> = {};
    if (usage.input_tokens) metadata.input_tokens = usage.input_tokens;
    if (usage.output_tokens) metadata.output_tokens = usage.output_tokens;
    if (usage.cost !== undefined && usage.cost > 0) metadata.cost_usd = usage.cost;

    if (Object.keys(metadata).length > 0) {
      await updateA2AMessage({ config, messageId: responseId, metadata });
      log(`atheism: [USAGE] backfilled ${responseId}: in=${usage.input_tokens} out=${usage.output_tokens} cost=$${usage.cost?.toFixed(4)}`);
    }
  } catch (err) {
    error(`atheism: [USAGE] backfill failed for ${responseId}: ${err}`);
  }
}

// 🆕 Summary generation
const SUMMARY_THRESHOLD = 5; // 每 5 条新消息触发一次总结（人类消息强制触发）
const summaryInProgress = new Set<string>(); // 防止同一 session 并发生成

async function triggerSummaryIfNeeded(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  agentId: string;
  fullHistory: A2AMessage[];
  sessionSummary: { summary_text: string; last_message_id: string | null; message_count: number } | null;
  isHuman: boolean;
}) {
  const { config, sessionId, agentId, fullHistory, sessionSummary, isHuman } = params;
  const log = console.log;
  
  if (summaryInProgress.has(sessionId)) return;
  
  // 计算上次 summary 之后的新消息数
  const substantiveMessages = fullHistory.filter(m => {
    const result = m.content?.result || m.content?.job || m.content?.message || '';
    const isNoReply = /^\s*(\[?NO_REPLY\]?|NO)\s*$/i.test(String(result));
    return !isNoReply && !m.content?.streaming && String(result).length > 10;
  });
  
  const lastSummarizedId = sessionSummary?.last_message_id;
  let newMessageCount = substantiveMessages.length;
  
  if (lastSummarizedId) {
    const lastIdx = substantiveMessages.findIndex(m => m.message_id === lastSummarizedId);
    if (lastIdx >= 0) {
      newMessageCount = substantiveMessages.length - lastIdx - 1;
    }
  }
  
  if (newMessageCount < SUMMARY_THRESHOLD) {
    // 人类消息强制触发 summary 更新（至少有 1 条新实质消息）
    // 防止 summary 过期导致 agent 复读旧状态
    if (!isHuman || newMessageCount < 1) return;
  }
  
  summaryInProgress.add(sessionId);
  try {
    log(`atheism: [${agentId}@${sessionId}] triggering summary generation (${newMessageCount} new messages)`);
    
    // 构建要总结的内容
    const previousSummary = sessionSummary?.summary_text || '';
    const messagesToSummarize = substantiveMessages.slice(-(newMessageCount + 2));
    
    const messagesText = messagesToSummarize.map(m => {
      const sender = m.from_agent === 'human' ? 'Human' : (m.from_name || m.from_agent);
      const body = m.content?.result || m.content?.job || m.content?.message || '';
      const bodyStr = String(body).substring(0, 500);
      return `[${sender}]: ${bodyStr}`;
    }).join('\n\n');
    
    const systemPrompt = 'You are a session summarizer. Generate concise summaries focusing on: tasks, decisions, actions taken, current status, and pending items. Use Chinese if the conversation is in Chinese.\n\nIMPORTANT: Your first line MUST be a short title (≤20 chars) prefixed with "TITLE: " that describes what this session is about. Then a blank line, then the summary body.\n\nExample format:\nTITLE: Redis缓存修复\n\n## 任务背景\n...';
    const userPrompt = previousSummary
      ? `Previous summary:\n${previousSummary}\n\nNew messages:\n${messagesText}\n\nUpdate the summary to incorporate new information. Remember: first line must be TITLE: <short title>.`
      : `Messages:\n${messagesText}\n\nGenerate a comprehensive summary. Remember: first line must be TITLE: <short title>.`;
    
    // 直接调用 LLM API (使用 sonnet 节省成本)
    const summaryText = await callLLMForSummary(systemPrompt, userPrompt);
    
    if (summaryText && summaryText.length > 20) {
      // Extract title from LLM response (first line: "TITLE: xxx")
      let sessionTitle: string | undefined;
      let cleanSummary = summaryText;
      const titleMatch = summaryText.match(/^TITLE:\s*(.+)/m);
      if (titleMatch) {
        sessionTitle = titleMatch[1].trim().slice(0, 40);
        // Remove the TITLE line from summary body
        cleanSummary = summaryText.replace(/^TITLE:\s*.+\n*/, '').trim();
      }
      
      const lastMsg = substantiveMessages[substantiveMessages.length - 1];
      await updateSessionSummary({
        config,
        sessionId,
        summaryText: cleanSummary,
        lastMessageId: lastMsg?.message_id,
        messageCount: substantiveMessages.length,
        agentId,
        title: sessionTitle,
      });
      log(`atheism: [${agentId}@${sessionId}] summary updated (${cleanSummary.length} chars)${sessionTitle ? ` title: "${sessionTitle}"` : ''}`);
    }
  } catch (err) {
    console.error(`atheism: [${agentId}@${sessionId}] summary generation failed: ${err}`);
  } finally {
    summaryInProgress.delete(sessionId);
  }
}

/** 轻量 LLM 调用（用 sonnet 生成 summary，不走 OpenClaw dispatch） */
async function callLLMForSummary(system: string, user: string): Promise<string | null> {
  const log = console.log;
  let baseUrl = process.env.A2A_LLM_BASE_URL || '';
  let apiKey = process.env.A2A_LLM_API_KEY || '';
  let model = process.env.A2A_LLM_MODEL || 'claude-sonnet-4-5-20250929';
  
  // 从 openclaw.json 读取配置：优先 a2a.llm，fallback 到 models.providers
  if (!apiKey || !baseUrl) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      // 优先从 a2a.llm 读取
      if (!apiKey) apiKey = config?.a2a?.llm?.apiKey || '';
      if (!baseUrl) baseUrl = config?.a2a?.llm?.baseUrl || '';
      
      // fallback: 从 models.providers 中找第一个有 anthropic-messages API 的 provider
      if (!apiKey || !baseUrl) {
        const providers = config?.models?.providers || {};
        for (const [, prov] of Object.entries(providers) as [string, any][]) {
          if (prov?.api === 'anthropic-messages' && prov?.apiKey && prov?.baseUrl) {
            if (!apiKey) apiKey = prov.apiKey;
            if (!baseUrl) baseUrl = prov.baseUrl;
            break;
          }
        }
      }
    } catch (err) {
      log(`atheism: [summary] failed to read config file: ${err}`);
    }
  }
  if (!apiKey || !baseUrl) {
    log(`atheism: [summary] skipped — missing ${!baseUrl ? 'LLM base URL' : 'API key'}. Set A2A_LLM_BASE_URL/A2A_LLM_API_KEY env vars, or configure models.providers in openclaw.json`);
    return null;
  }
  
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`atheism: [summary] LLM returned ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as any;
    return data?.content?.[0]?.text?.trim() || null;
  } catch (err) {
    log(`atheism: [summary] LLM call failed: ${err}`);
    return null;
  }
}

// 清理过期 processedMessages
setInterval(() => {
  if (processedMessages.size > 1000) {
    const arr = [...processedMessages];
    for (const id of arr.slice(0, arr.length - 500)) processedMessages.delete(id);
  }
}, 60000);
