#!/usr/bin/env node
/**
 * A2A Space Performance Benchmark
 * 
 * 模拟 plugin 侧的 poll 循环，测量关键 API 的响应时间。
 * 部署前跑一次做回归检查，确认性能没有退化。
 *
 * 用法:
 *   node benchmark.js [--server http://localhost:3000] [--rounds 3] [--verbose]
 * 
 * 输出:
 *   - 每个 API 端点的 P50/P95/P99/Max 延迟
 *   - 单轮 poll 总耗时
 *   - db.json 文件大小和记录数统计
 *   - Pass/Fail 判定（基于可配置阈值）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 配置 ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = (name) => args.includes(name);

const SERVER = getArg('--server', 'http://localhost:3000');
const ROUNDS = parseInt(getArg('--rounds', '3'), 10);
const VERBOSE = hasFlag('--verbose');

// 性能阈值（超过则 FAIL）
const THRESHOLDS = {
  poll_single_p95_ms: 50,      // 单次 poll 请求 P95 ≤ 50ms
  poll_round_total_ms: 2000,   // 一轮完整 poll ≤ 2s
  api_messages_post_p95_ms: 100, // 发消息 P95 ≤ 100ms
  db_size_mb: 20,              // db.json ≤ 20MB
};

// ── HTTP 请求工具 ─────────────────────────────────────────────
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const method = options.method || 'GET';
    const reqOptions = {
      method,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    };

    const req = mod.request(url, reqOptions, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), raw: body });
        } catch {
          resolve({ status: res.statusCode, data: null, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function timedFetch(url, options = {}) {
  const start = performance.now();
  const result = await fetch(url, options);
  const elapsed = performance.now() - start;
  return { ...result, elapsed_ms: elapsed };
}

// ── 统计工具 ──────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] || 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] || 0,
    avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
  };
}

// ── 主测试 ────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     A2A Space Performance Benchmark             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Server:  ${SERVER}`);
  console.log(`Rounds:  ${ROUNDS}`);
  console.log(`Date:    ${new Date().toISOString()}`);
  console.log();

  // 1. 预检：获取 spaces 和 agents
  console.log('── Step 1: Preflight ──────────────────────────────');
  const spacesRes = await timedFetch(`${SERVER}/api/spaces`);
  if (spacesRes.status !== 200) {
    console.error(`❌ Server unreachable or error (status ${spacesRes.status})`);
    process.exit(1);
  }
  const spaces = spacesRes.data.spaces || [];
  console.log(`Spaces: ${spaces.length} (fetched in ${spacesRes.elapsed_ms.toFixed(1)}ms)`);

  // 收集每个 space 的 agents（模拟 membership lookup）
  const spaceAgents = new Map(); // space_id → [agent_ids]
  for (const sp of spaces) {
    const res = await fetch(`${SERVER}/api/spaces/${sp.space_id}`);
    const agents = (res.data?.agents || []).filter(a => a.status === 'online');
    spaceAgents.set(sp.space_id, agents);
    if (VERBOSE) {
      console.log(`  ${sp.space_id} (${sp.name}): ${agents.length} online agents`);
    }
  }

  // 计算 agent×space 组合数（模拟 plugin 实际 poll 拓扑）
  const combos = [];
  for (const [spaceId, agents] of spaceAgents) {
    for (const agent of agents) {
      combos.push({ spaceId, agentId: agent.agent_id, agentName: agent.name });
    }
  }
  console.log(`Agent×Space combos: ${combos.length}`);
  console.log();

  // 2. Poll 模拟
  console.log('── Step 2: Poll Simulation ────────────────────────');
  const pollLatencies = [];     // 每次 poll 的延迟
  const roundLatencies = [];    // 每轮总耗时

  for (let round = 0; round < ROUNDS; round++) {
    const roundStart = performance.now();
    const since = Date.now() - 5000; // 5s 窗口

    for (const { spaceId, agentId, agentName } of combos) {
      const url = `${SERVER}/api/spaces/${spaceId}/messages?since=${since}&limit=50&agent_id=${agentId}&agent_name=${encodeURIComponent(agentName)}`;
      const res = await timedFetch(url);
      pollLatencies.push(res.elapsed_ms);

      if (VERBOSE && res.elapsed_ms > 20) {
        console.log(`  ⚠️ slow: ${agentId}@${spaceId} = ${res.elapsed_ms.toFixed(1)}ms`);
      }
    }

    const roundTotal = performance.now() - roundStart;
    roundLatencies.push(roundTotal);
    console.log(`  Round ${round + 1}/${ROUNDS}: ${combos.length} polls in ${roundTotal.toFixed(0)}ms (avg ${(roundTotal / combos.length).toFixed(1)}ms/poll)`);
  }

  const pollStats = stats(pollLatencies);
  const roundStats = stats(roundLatencies);

  console.log();
  console.log('── Poll Results ──────────────────────────────────');
  console.log(`  Single poll:  P50=${pollStats.p50.toFixed(1)}ms  P95=${pollStats.p95.toFixed(1)}ms  P99=${pollStats.p99.toFixed(1)}ms  Max=${pollStats.max.toFixed(1)}ms  Avg=${pollStats.avg.toFixed(1)}ms  (n=${pollStats.count})`);
  console.log(`  Full round:   P50=${roundStats.p50.toFixed(0)}ms  P95=${roundStats.p95.toFixed(0)}ms  Max=${roundStats.max.toFixed(0)}ms  Avg=${roundStats.avg.toFixed(0)}ms`);
  console.log();

  // 3. 写入测试（POST message 到一个临时 session，然后删除）
  console.log('── Step 3: Write Benchmark ────────────────────────');
  const writeLatencies = [];
  const testSpace = spaces[0]?.space_id;
  const testSessionId = `bench_${Date.now()}`;
  const messageIdsToClean = [];

  if (testSpace) {
    for (let i = 0; i < 10; i++) {
      const res = await timedFetch(`${SERVER}/api/spaces/${testSpace}/messages`, {
        method: 'POST',
        body: {
          from_agent: '_benchmark_',
          type: 'agent',
          content: { text: `benchmark message ${i}` },
          session_id: testSessionId,
        },
      });
      writeLatencies.push(res.elapsed_ms);
      if (res.data?.message_id) messageIdsToClean.push(res.data.message_id);
    }

    const writeStats = stats(writeLatencies);
    console.log(`  POST message: P50=${writeStats.p50.toFixed(1)}ms  P95=${writeStats.p95.toFixed(1)}ms  Max=${writeStats.max.toFixed(1)}ms  Avg=${writeStats.avg.toFixed(1)}ms  (n=${writeStats.count})`);

    // 清理测试数据
    for (const mid of messageIdsToClean) {
      await fetch(`${SERVER}/api/spaces/${testSpace}/messages/${mid}`, { method: 'DELETE' });
    }
    console.log(`  Cleaned up ${messageIdsToClean.length} test messages`);
  } else {
    console.log('  ⚠️ No spaces found, skipping write benchmark');
  }
  console.log();

  // 4. 数据库体积检查
  console.log('── Step 4: Database Health ────────────────────────');
  const dbPath = path.join(__dirname, 'data', 'db.json');
  let dbSizeMB = 0;
  let dbRecords = {};
  if (fs.existsSync(dbPath)) {
    const stat = fs.statSync(dbPath);
    dbSizeMB = stat.size / 1024 / 1024;
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const db = JSON.parse(raw);
      for (const [key, val] of Object.entries(db)) {
        if (Array.isArray(val)) dbRecords[key] = val.length;
      }
    } catch {}
    console.log(`  db.json size: ${dbSizeMB.toFixed(2)} MB`);
    for (const [k, v] of Object.entries(dbRecords)) {
      console.log(`    ${k}: ${v} records`);
    }
  } else {
    console.log('  db.json not found (remote server?)');
  }
  console.log();

  // 5. 综合评估
  console.log('══════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('══════════════════════════════════════════════════');
  const checks = [
    {
      name: 'Single poll P95',
      value: pollStats.p95,
      threshold: THRESHOLDS.poll_single_p95_ms,
      unit: 'ms',
    },
    {
      name: 'Full round avg',
      value: roundStats.avg,
      threshold: THRESHOLDS.poll_round_total_ms,
      unit: 'ms',
    },
    {
      name: 'POST message P95',
      value: writeLatencies.length ? stats(writeLatencies).p95 : 0,
      threshold: THRESHOLDS.api_messages_post_p95_ms,
      unit: 'ms',
    },
    {
      name: 'db.json size',
      value: dbSizeMB,
      threshold: THRESHOLDS.db_size_mb,
      unit: 'MB',
    },
  ];

  let allPass = true;
  for (const c of checks) {
    const pass = c.value <= c.threshold;
    if (!pass) allPass = false;
    const icon = pass ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${c.value.toFixed(1)}${c.unit} (threshold: ≤${c.threshold}${c.unit})`);
  }

  console.log();
  if (allPass) {
    console.log('  🎉 ALL CHECKS PASSED');
  } else {
    console.log('  ⚠️  SOME CHECKS FAILED — investigate before deploying');
  }
  console.log();

  // 6. 输出 JSON 报告（可选保存）
  const report = {
    timestamp: new Date().toISOString(),
    server: SERVER,
    rounds: ROUNDS,
    combos: combos.length,
    poll: pollStats,
    round: roundStats,
    write: writeLatencies.length ? stats(writeLatencies) : null,
    db: { size_mb: dbSizeMB, records: dbRecords },
    thresholds: THRESHOLDS,
    pass: allPass,
  };

  const reportPath = path.join(__dirname, 'data', `benchmark-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved to: ${reportPath}`);

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(2);
});
