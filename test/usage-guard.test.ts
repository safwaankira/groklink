import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import type { Usage } from "../src/base/bot.ts";
import type { CDP } from "../src/base/cdp.ts";
import { TOOLS } from "../src/client/mcp.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, Jobs, type JobsOptions } from "../src/daemon/jobs.ts";
import { deepProbe, probeWarnings } from "../src/daemon/probe.ts";
import { daemonMethods } from "../src/daemon/server.ts";
import { DEFAULT_USAGE, USAGE_WARNING, usageLimits, writeUsageLimit } from "../src/shared/policy.ts";
import { ERROR_CODES, METHODS } from "../src/shared/protocol.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 2000) => {
  for (const t0 = Date.now(); !fn(); await sleep(5)) if (Date.now() - t0 > ms) throw new Error("timed out");
};

const BRIEF = "Reply with the word pong and nothing else.";
const RESET = "2026-11-27T00:00:00.000Z";
const usageAt = (percentUsed: number, onDemand: Usage["onDemand"] = null): Usage => ({
  percentUsed,
  resetsAt: RESET,
  plan: "SuperGrok",
  hasAvailableUsage: true,
  onDemand,
});

let home: string;
const open: Jobs[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gl-usage-"));
});
afterEach(() => {
  for (const j of open.splice(0)) j.close();
  rmSync(home, { recursive: true, force: true });
});

/** Jobs with `policy` written to policy.json first (undefined: no file yet) and a fake Bot layer at `percent` usage. */
function setup(policy: unknown, percent: number | (() => Usage), extra: Partial<JobsOptions> = {}) {
  if (policy !== undefined) writeFileSync(join(home, "policy.json"), JSON.stringify(policy));
  const sent: string[] = [];
  let reads = 0;
  const layer: BotLayer = {
    find: async (q) => ({ id: "b1", name: q }),
    send: async (_id, brief) => {
      sent.push(brief);
      return `k${sent.length}`;
    },
    wait: () => new Promise(() => {}),
    read: async () => [],
    usage: async () => {
      reads++;
      return typeof percent === "number" ? usageAt(percent) : percent();
    },
  };
  const j = new Jobs({
    dir: join(home, "jobs"),
    events: new EventLog(join(home, "events.jsonl")),
    layer,
    link: { connected: true },
    log: () => {},
    pollMs: 10,
    ...extra,
  });
  open.push(j);
  j.start();
  return { j, sent, reads: () => reads };
}

const link = {
  mode: "pipe" as const,
  connected: true,
  appVersion: "1.2.3",
  requireCdp: (): CDP => {
    throw new Error("no CDP");
  },
};
type Health = { policy: Record<string, unknown>; warnings: string[] };

// ---- 1. policy.json ----

test("usageLimits: defaults for a missing key or a legacy file; a partial object keeps the other default", () => {
  assert.deepEqual(DEFAULT_USAGE, { warn: 80, pause: 100 });
  for (const legacy of [null, {}, { x_write: true, tx: true, wallet: true, claim: true }, { x_write: "approve" }])
    assert.deepEqual(usageLimits(legacy), { warn: 80, pause: 100 }, JSON.stringify(legacy));
  assert.deepEqual(usageLimits({ usage: { warn: 50, pause: 90 } }), { warn: 50, pause: 90 });
  assert.deepEqual(usageLimits({ usage: { pause: 90 } }), { warn: 80, pause: 90 });
  assert.deepEqual(usageLimits({ usage: { warn: 0 } }), { warn: 0, pause: 100 });
});

test("usageLimits: invalid values mean both defaults plus a warning", () => {
  const bad = [
    { usage: "90" },
    { usage: [80, 100] },
    { usage: null },
    { usage: { warn: "80" } },
    { usage: { warn: -1 } },
    { usage: { pause: 0 } },
    { usage: { pause: 101 } },
    { usage: { warn: 95, pause: 90 } },
    { usage: { pause: 50 } },
    { usage: { warn: Number.NaN } },
  ];
  for (const p of bad) assert.deepEqual(usageLimits(p), { warn: 80, pause: 100, warning: USAGE_WARNING }, JSON.stringify(p));
});

test("health: policy.usage shows the limits; invalid limits add a health warning and tasks behave as the defaults", async () => {
  const ok = setup({ usage: { warn: 50, pause: 90 } }, 10);
  const h = daemonMethods(link, { jobs: ok.j }).health({}) as Health;
  assert.deepEqual(h.policy.usage, { warn: 50, pause: 90 });
  assert.deepEqual(h.warnings, []);
  const bad = setup({ usage: { warn: 95, pause: 90 } }, 97);
  await bad.j.usageSummary();
  const hb = daemonMethods(link, { jobs: bad.j }).health({}) as Health;
  assert.deepEqual(hb.policy.usage, { warn: 80, pause: 100 });
  assert.deepEqual(hb.warnings, [USAGE_WARNING, "Grok usage is at 97% (warn at 80%)."]);
  await bad.j.create({ bot: "Alpha", brief: BRIEF });
});

// ---- 2. warn ----

test("warn: at or above the warn percent, health.warnings has the line; below it, nothing", async () => {
  for (const [policy, percent, expected] of [
    [undefined, 79.9, []],
    [undefined, 80, ["Grok usage is at 80% (warn at 80%)."]],
    [{ x_write: true }, 93.7, ["Grok usage is at 93% (warn at 80%)."]],
    [{ usage: { warn: 50, pause: 100 } }, 49, []],
    [{ usage: { warn: 50, pause: 100 } }, 62, ["Grok usage is at 62% (warn at 50%)."]],
  ] as [unknown, number, string[]][]) {
    for (const j of open.splice(0)) j.close();
    rmSync(join(home, "policy.json"), { force: true });
    const { j } = setup(policy, percent);
    await j.usageSummary();
    assert.deepEqual((daemonMethods(link, { jobs: j }).health({}) as Health).warnings, expected, `${JSON.stringify(policy)} at ${percent}`);
  }
});

test("warn: a task at the warn percent still goes ahead", async () => {
  const { j, sent } = setup({ usage: { warn: 50, pause: 100 } }, 99);
  await j.create({ bot: "Alpha", brief: BRIEF });
  await until(() => sent.length === 1);
});

const BOT = {
  id: "b1",
  name: "Alpha",
  description: "",
  hidden: false,
  running: false,
  needsInput: false,
  unread: 0,
  lastActivity: null,
  preview: null,
};
const ROUTINE = { id: "r1", name: "Daily", prompt: "Summarize the news", schedule: "0 9 * * *", enabled: true };

/** A page that answers the probe's and the routines' calls; usage is at `percent`. `ran` collects routine runs. */
function pageCdp(percent: number, ran: string[] = []): CDP {
  const answer = async (code: string, args: unknown[]): Promise<unknown> => {
    if (args[0] === "list") return { value: [ROUTINE] };
    if (args[0] === "run") {
      ran.push(String(args[2]));
      return { value: ROUTINE };
    }
    if (code.includes("document.readyState")) return { state: "complete", stores: true };
    if (code.includes("getCursorAuthStatus")) return "logged-in";
    if (code.includes("getCursorUsageSummary")) return { sandUsagePercent: percent, sandUsageResetTimestampMs: Date.parse(RESET) };
    if (code.includes("boxHostPhase")) return "settled";
    if (args.length === 3) return [];
    return [BOT];
  };
  return { eval: (expr: string) => answer(expr, []), call: (fn: string, ...args: unknown[]) => answer(fn, args) } as unknown as CDP;
}

test("doctor's usage check: ✓ below warn, ! (a passing warning) from warn, and from pause it names the pause; never a failure", async () => {
  const usageCheck = async (percent: number, usage?: { warn: number; pause: number }) => {
    const r = await deepProbe(() => pageCdp(percent), { usage });
    const c = r.checks.find((x) => x.name === "usage");
    assert.ok(c);
    // The user's limits never add a "couldn't read usage" line.
    assert.doesNotMatch(probeWarnings({ ok: true, checks: [c] }).join("\n"), /usage/i);
    return [c.ok, c.warn ?? false, c.detail];
  };
  assert.deepEqual(await usageCheck(40, { warn: 80, pause: 100 }), [true, false, "40% used"]);
  assert.deepEqual(await usageCheck(85, { warn: 80, pause: 100 }), [true, true, "85% used (warn at 80%)"]);
  assert.deepEqual(await usageCheck(92, { warn: 80, pause: 90 }), [true, true, "92% used; new tasks pause at 90% (your setting)"]);
  assert.deepEqual(await usageCheck(85), [true, false, "85% used"]);
});

test("doctor prints a warned usage check as a ! line and still passes", async () => {
  const { startServer } = await import("../src/daemon/server.ts");
  const { ensureState, statePaths } = await import("../src/daemon/state.ts");
  const paths = statePaths(join(home, "state"));
  const { token } = ensureState(paths);
  const checks = ["app", "account", "roster", "transcript", "usage", "awake"].map((name) => ({
    name,
    ok: true,
    ms: 1,
    ...(name === "usage" ? { warn: true, detail: "85% used (warn at 80%)" } : { detail: "fine" }),
  }));
  const server = await startServer({
    socketPath: paths.socket,
    token,
    methods: { health: () => ({ ok: true, warnings: ["Grok usage is at 85% (warn at 80%)."], probe: { ok: true, checks } }) },
    log: () => {},
  });
  try {
    const { stdout } = await run(process.execPath, ["dist/groklink.js", "doctor"], { env: { ...process.env, GROKLINK_HOME: paths.home } });
    assert.match(stdout, /^! usage +85% used \(warn at 80%\)$/m);
    assert.match(stdout, /Grok usage is at 85% \(warn at 80%\)\.$/m);
    assert.match(stdout.trim(), /PASS$/);
  } finally {
    server.close();
  }
});

// ---- 3. pause ----

const PAUSED = `Grok usage is at 91%; new tasks pause at 90% (your setting). It resets at ${RESET}. Nothing was sent.`;

test("pause: at or above the pause percent a task is refused with usage_paused and nothing is sent; just below it goes ahead", async () => {
  const at = setup({ usage: { warn: 80, pause: 90 } }, 91.4);
  await assert.rejects(at.j.create({ bot: "Alpha", brief: BRIEF }), { code: "usage_paused", message: PAUSED });
  await sleep(30);
  assert.deepEqual(at.sent, []);
  assert.deepEqual(at.j.list(), []);
  assert.ok(ERROR_CODES.includes("usage_paused"));
  for (const j of open.splice(0)) j.close();
  const exact = setup({ usage: { warn: 80, pause: 90 } }, 90);
  await assert.rejects(exact.j.create({ bot: "Alpha", brief: BRIEF }), { code: "usage_paused" });
  for (const j of open.splice(0)) j.close();
  const below = setup({ usage: { warn: 80, pause: 90 } }, 89.9);
  await below.j.create({ bot: "Alpha", brief: BRIEF });
  await until(() => below.sent.length === 1);
});

test("pause 100 (the default, and legacy files without the key) keeps today's behaviour: only used-up usage refuses", async () => {
  for (const policy of [undefined, { x_write: true, tx: true, wallet: true, claim: true }, { usage: { warn: 80, pause: 100 } }]) {
    for (const j of open.splice(0)) j.close();
    rmSync(join(home, "policy.json"), { force: true });
    const near = setup(policy, 99.9);
    await near.j.create({ bot: "Alpha", brief: BRIEF });
    for (const j of open.splice(0)) j.close();
    const out = setup(policy, 100);
    await assert.rejects(out.j.create({ bot: "Alpha", brief: BRIEF }), { code: "usage_exhausted" });
    for (const j of open.splice(0)) j.close();
    // 100% with on-demand room isn't out, and pause 100 doesn't pause it.
    const onDemand = setup(policy, () => usageAt(100, { enabled: true, usedCents: 0, limitCents: 1000 }));
    await onDemand.j.create({ bot: "Alpha", brief: BRIEF });
  }
});

test("pause below 100: used-up usage is still usage_exhausted; 100% with on-demand room is usage_paused", async () => {
  const out = setup({ usage: { warn: 80, pause: 90 } }, 100);
  await assert.rejects(out.j.create({ bot: "Alpha", brief: BRIEF }), { code: "usage_exhausted" });
  for (const j of open.splice(0)) j.close();
  const onDemand = setup({ usage: { warn: 80, pause: 90 } }, () => usageAt(100, { enabled: true, usedCents: 0, limitCents: 1000 }));
  await assert.rejects(onDemand.j.create({ bot: "Alpha", brief: BRIEF }), { code: "usage_paused" });
});

test("pause: a cached reading is re-read fresh before refusing, so a reset in between lets the task through", async () => {
  let current = usageAt(95);
  const s = setup({ usage: { warn: 80, pause: 90 } }, () => current, { usageCacheMs: 60_000 });
  await s.j.usageSummary();
  const before = s.reads();
  current = usageAt(2);
  await s.j.create({ bot: "Alpha", brief: BRIEF });
  assert.equal(s.reads(), before + 1, "one fresh read before deciding");
  await until(() => s.sent.length === 1);
});

test("pause: a running job is not stopped when usage passes the pause percent", async () => {
  let current = usageAt(50);
  const s = setup({ usage: { warn: 80, pause: 90 } }, () => current, { usageEveryMs: 10, usageCacheMs: 0 });
  const { jobId } = await s.j.create({ bot: "Alpha", brief: BRIEF });
  await until(() => s.j.list()[0]?.status === "working");
  current = usageAt(95);
  await sleep(80);
  assert.equal((await s.j.get({ jobId })).status, "working");
  await assert.rejects(s.j.create({ bot: "Beta", brief: BRIEF }), { code: "usage_paused" });
});

test("pause: a routine run is refused with usage_paused and the routine doesn't run; list still works; below pause it runs", async () => {
  const s = setup({ usage: { warn: 80, pause: 90 } }, 91.4);
  const ran: string[] = [];
  const m = daemonMethods({ ...link, requireCdp: () => pageCdp(0, ran) }, { jobs: s.j });
  await assert.rejects(
    Promise.resolve().then(() => m.routines({ action: "run", bot: "Alpha", routine: "Daily" })),
    { code: "usage_paused", message: PAUSED },
  );
  assert.deepEqual(ran, []);
  const list = (await m.routines({ action: "list", bot: "Alpha" })) as { routines: unknown[] };
  assert.equal(list.routines.length, 1);
  for (const j of open.splice(0)) j.close();
  const ok = setup({ usage: { warn: 80, pause: 90 } }, 40);
  await daemonMethods({ ...link, requireCdp: () => pageCdp(0, ran) }, { jobs: ok.j }).routines({
    action: "run",
    bot: "Alpha",
    routine: "Daily",
  });
  assert.deepEqual(ran, ["r1"]);
  for (const j of open.splice(0)) j.close();
  const out = setup(undefined, 100);
  await assert.rejects(
    Promise.resolve().then(() =>
      daemonMethods({ ...link, requireCdp: () => pageCdp(0, ran) }, { jobs: out.j }).routines({
        action: "run",
        bot: "Alpha",
        routine: "Daily",
      }),
    ),
    { code: "usage_exhausted" },
  );
});

// ---- 4. CLI only ----

function cliEnv(status = 0) {
  const state = join(home, ".groklink");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "launchctl.log");
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> "${log}"\nexit ${status}\n`);
  chmodSync(join(bin, "launchctl"), 0o755);
  return { state, log, file: join(state, "policy.json"), env: { HOME: home, GROKLINK_HOME: state, PATH: `${bin}:/usr/bin:/bin` } };
}

async function cli(env: NodeJS.ProcessEnv, ...args: string[]) {
  try {
    const { stdout } = await run(process.execPath, ["dist/groklink.js", ...args], { env });
    return { code: 0, out: stdout, err: "" };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

test("groklink policy usage prints the two numbers (defaults for a legacy file) and restarts nothing", async () => {
  const c = cliEnv();
  writeFileSync(c.file, '{ "x_write": true, "tx": true, "wallet": true, "claim": true }');
  const legacy = await cli(c.env, "policy", "usage");
  assert.equal(legacy.code, 0);
  assert.match(legacy.out, /^ {2}usage +warn at 80%, pause new tasks at 100% \(only when used up\)$/m);
  writeFileSync(c.file, '{ "usage": { "warn": 60, "pause": 85 } }');
  assert.match((await cli(c.env, "policy", "usage")).out, /^ {2}usage +warn at 60%, pause new tasks at 85%$/m);
  assert.match((await cli(c.env, "policy")).out, /^ {2}usage +warn at 60%, pause new tasks at 85%$/m);
  assert.equal(existsSync(c.log), false);
});

test("groklink policy usage warn/pause: rewrites policy.json atomically (0600), keeps other keys, restarts the daemon", async () => {
  const c = cliEnv();
  writeFileSync(c.file, '{ "x_write": "approve", "tx": false, "note": "mine" }', { mode: 0o644 });
  const p = await cli(c.env, "policy", "usage", "pause", "90");
  assert.equal(p.code, 0, p.err);
  assert.match(p.out, /Set usage pause to 90% .*\(warn at 80%, pause new tasks at 90%\)/);
  const w = await cli(c.env, "policy", "usage", "warn", "70");
  assert.equal(w.code, 0, w.err);
  assert.deepEqual(JSON.parse(readFileSync(c.file, "utf8")), {
    x_write: "approve",
    tx: false,
    note: "mine",
    usage: { warn: 70, pause: 90 },
  });
  assert.equal(statSync(c.file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(c.state), ["policy.json"]);
  const uid = process.getuid?.() ?? 0;
  assert.deepEqual(readFileSync(c.log, "utf8").trim().split("\n"), Array(2).fill(`kickstart -k gui/${uid}/dev.groklink.daemon`));
});

test("groklink policy usage: bad values exit 2 and change nothing (range, non-numbers, warn above pause)", async () => {
  const c = cliEnv();
  const before = '{ "usage": { "warn": 70, "pause": 90 } }';
  writeFileSync(c.file, before);
  for (const args of [
    ["warn", "101"],
    ["warn", "-1"],
    ["warn", "7.5"],
    ["warn", "abc"],
    ["pause", "0"],
    ["pause", "101"],
    ["warn", "91"],
    ["pause", "69"],
    ["limit", "50"],
    ["warn"],
  ]) {
    const r = await cli(c.env, "policy", "usage", ...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(readFileSync(c.file, "utf8"), before, args.join(" "));
  }
  assert.match((await cli(c.env, "policy", "usage", "warn", "91")).err, /warn \(91\) can't be higher than pause \(90\)/);
  assert.equal(existsSync(c.log), false);
});

test("writeUsageLimit: same write path as x_write — refuses a broken file, cleans up a failed rename, starts a missing file from the defaults", () => {
  const file = join(home, "policy.json");
  assert.deepEqual(writeUsageLimit(file, "pause", 95), { warn: 80, pause: 95 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    x_write: "block",
    tx: true,
    wallet: true,
    claim: true,
    usage: { warn: 80, pause: 95 },
  });
  assert.throws(
    () =>
      writeUsageLimit(file, "warn", 10, () => {
        throw new Error("rename failed");
      }),
    /rename failed/,
  );
  assert.deepEqual(readdirSync(home), ["policy.json"]);
  assert.equal(usageLimits(JSON.parse(readFileSync(file, "utf8"))).warn, 80);
  writeFileSync(file, "{ not json");
  assert.throws(() => writeUsageLimit(file, "warn", 10), /can't be read/);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
  // Invalid limits in the file are replaced starting from the defaults.
  writeFileSync(file, '{ "usage": { "warn": 95, "pause": 90 } }');
  assert.deepEqual(writeUsageLimit(file, "warn", 10), { warn: 10, pause: 100 });
});

test("the limits can't be set over MCP or the socket: no tool, method or parameter for it", () => {
  assert.equal(
    METHODS.some((m) => /policy|limit/i.test(m)),
    false,
  );
  assert.equal(
    TOOLS.some((t) => /policy/i.test(t.name)),
    false,
  );
  for (const t of TOOLS) assert.doesNotMatch(JSON.stringify(t.inputSchema), /"(warn|pause|usage)"/, t.name);
});

// ---- 5. docs ----

test("skill and tool descriptions: on usage_paused, tell the user the numbers and stop", () => {
  const skill = readFileSync("skills/groklink/SKILL.md", "utf8");
  assert.match(skill, /`usage_paused`[^\n]*tell the user[^\n]*(don't|never) retry/i);
  for (const name of ["groklink_task", "groklink_routines"]) {
    const d = TOOLS.find((t) => t.name === name)?.description ?? "";
    assert.match(d, /usage_paused[^.]*tell the user[^.]*don't retry/, name);
  }
});
