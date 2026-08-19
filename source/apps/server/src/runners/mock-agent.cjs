#!/usr/bin/env node
/*
 * Daimon-OS mock agent — runs inside a node-pty pseudo-terminal.
 * Emits a realistic agent loop: ANSI-colored output, tool calls, spinners,
 * and in-band OSC 6973 telemetry (status + token metrics) that the server's
 * Argus parser strips and converts into status/metrics frames.
 * Set DAIMON_FAST=1 for a short deterministic run (used by integration tests).
 */
"use strict";

const NAME = process.env.DAIMON_AGENT_NAME || "daimon";
const TASK = process.env.DAIMON_TASK || "idle loop";
const TOOLS = (process.env.DAIMON_TOOLS || "bash").split(",").filter(Boolean);
const MODEL = process.env.DAIMON_MODEL || "default";
const FAST = process.env.DAIMON_FAST === "1";
const CRASH = process.env.DAIMON_CRASH === "1"; // exit non-zero right after startup (test hook)
const CYCLES = process.env.DAIMON_CYCLES ? Number(process.env.DAIMON_CYCLES) : null;
const DELAY_MS = process.env.DAIMON_DELAY_MS ? Number(process.env.DAIMON_DELAY_MS) : null;

const ESC = "\x1b";
const c = (n, s) => `${ESC}[${n}m${s}${ESC}[0m`;
const dim = (s) => c("2", s);
const grn = (s) => c("32", s);
const cyn = (s) => c("36", s);
const ylw = (s) => c("33", s);
const mag = (s) => c("35", s);

const SPINNERS = ["Gallianting", "Coalescing", "Brewing", "Cogitating", "Churning", "Conjuring", "Percolating", "Daimoning"];
const DONE = ["Crunched", "Cooked", "Cogitated", "Churned", "Worked", "Conjured"];
const label = SPINNERS[Math.floor(Math.random() * SPINNERS.length)];
const doneLabel = DONE[Math.floor(Math.random() * DONE.length)];

const metrics = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, toolCalls: 0, durationMs: 0 };
const startedAt = Date.now();

function osc(event) {
  process.stdout.write(`${ESC}]6973;${JSON.stringify(event)}\x07`);
}
function sendMetrics() {
  metrics.durationMs = Date.now() - startedAt;
  osc({ kind: "metrics", metrics });
}
function sendStatus(status, lbl, activeTools) {
  osc({ kind: "status", status, label: lbl, activeTools: activeTools || [] });
}

process.stdin.setEncoding("utf8");
let lineBuf = "";
process.stdin.on("data", (chunk) => {
  process.stdout.write(chunk); // local echo so typing is visible
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.search(/[\r\n]/)) !== -1) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (line) {
      process.stdout.write(`\r\n${mag("steer>")} acknowledged: ${c("1", line)}\r\n`);
      metrics.inputTokens += Math.ceil(line.length / 4);
      sendMetrics();
    }
  }
});

const w = (s) => process.stdout.write(s + "\r\n");
const sleep = (ms) =>
  new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 5) : (DELAY_MS ?? ms)));

async function toolCall(tool, detail, ms) {
  sendStatus("waiting_tool", label, [tool]);
  w(`${cyn(`→ tool ${tool}`)} ${dim(`(${detail})`)}`);
  metrics.toolCalls += 1;
  await sleep(ms);
  metrics.inputTokens += 120 + Math.floor(Math.random() * 300);
  metrics.outputTokens += 40 + Math.floor(Math.random() * 160);
  metrics.cacheReadTokens += Math.floor(Math.random() * 500);
  metrics.costUsd = +(metrics.inputTokens * 3e-6 + metrics.outputTokens * 15e-6).toFixed(4);
  sendMetrics();
  sendStatus("running", label, []);
}

async function main() {
  sendStatus("running", label, []);
  w(`${dim("$")} agent run ${dim(`--model ${MODEL}`)} --task ${c("1", JSON.stringify(TASK))}`);
  w(`${grn("✓")} ${NAME} online · tools: ${TOOLS.map((t) => cyn(t)).join(" ")}`);
  sendMetrics();

  if (CRASH) {
    // deterministic crash for tests — exits non-zero so the scheduler sees "crashed".
    // Note: exits before the OSC "failed" status frame; reason is derived purely
    // from the non-zero exit code in ProcessManager.handleExit.
    w(c("31", "✗ simulated crash"));
    process.exit(1);
  }

  const cycles = CYCLES ?? (FAST ? 3 : 90);
  for (let i = 1; i <= cycles; i++) {
    const tool = TOOLS[i % TOOLS.length] || "bash";
    await toolCall(tool, `step ${i}/${cycles}`, 400 + Math.random() * 900);
    if (i % 3 === 0) w(`${grn("✓")} checkpoint ${i} ${dim(`· ${metrics.outputTokens} tokens out`)}`);
    if (i % 7 === 0) w(`${ylw("! note")} ${dim("partial result staged for review")}`);
    w(`${mag("✻")} ${ylw(`${label}… (${Math.round((Date.now() - startedAt) / 1000)}s · ↑ ${(metrics.inputTokens / 1000).toFixed(1)}k tokens)`)}`);
    await sleep(300);
  }

  metrics.durationMs = Date.now() - startedAt;
  sendStatus("completed", doneLabel, []);
  sendMetrics();
  w(`${grn(`● ${doneLabel} for ${Math.round(metrics.durationMs / 1000)}s`)} ${dim(`· $${metrics.costUsd}`)}`);
  w(dim(`recap: ${TASK} — done. exit 0`));
  process.exit(0);
}

main().catch((err) => {
  sendStatus("failed", "Crashed", []);
  w(c("31", `✗ ${err && err.message ? err.message : err}`));
  process.exit(1);
});
