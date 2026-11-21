import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import type { WaitResult } from "../src/base/bot.ts";
import { Approvals } from "../src/daemon/approval.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, Jobs } from "../src/daemon/jobs.ts";
import { daemonMethods, startServer } from "../src/daemon/server.ts";
import { ensureState, statePaths } from "../src/daemon/state.ts";
import { ensurePolicy, matches, policyFileError, writeXMode, xMode } from "../src/shared/policy.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
};

const POST = "Post this launch thread from my account";
const ALLOW_WARNING = "Posting to X is allowed without approval (x_write: allow).";

let home: string;
const open: Jobs[] = [];
let server: Server | null = null;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gl-modes-"));
});
afterEach(() => {
  for (const j of open.splice(0)) j.close();
  server?.close();
  server = null;
  rmSync(home, { recursive: true, force: true });
});

/** Jobs with `policy` written to policy.json first, a fake Bot layer and a fake dialog that never answers. */
function setup(policy: unknown) {
  if (policy !== undefined) writeFileSync(join(home, "policy.json"), JSON.stringify(policy));
  const sent: string[] = [];
  const dialogs: string[] = [];
  const layer: BotLayer = {
    find: async () => ({ id: "b1", name: "Alpha" }),
    async send(_botId, text) {
      sent.push(text);
      return `nonce_${sent.length}`;
    },
    read: async () => [],
    wait: () => new Promise<WaitResult>(() => {}),
  };
  const j = new Jobs({
    dir: join(home, "jobs"),
    events: new EventLog(join(home, "events.jsonl")),
    layer,
    link: { connected: true },
    log: () => {},
    pollMs: 10,
    approvals: new Approvals(async (r) => {
      dialogs.push(r.jobId);
      return new Promise(() => {});
    }),
  });
  open.push(j);
  j.start();
  return { j, sent, dialogs };
}

// ---- parsing ----

test("xMode: block, approve and allow; legacy true → block, false → allow; missing → block; unknown → block + warning", () => {
  assert.deepEqual(xMode({ x_write: "block" }), { mode: "block" });
  assert.deepEqual(xMode({ x_write: "approve" }), { mode: "approve" });
  assert.deepEqual(xMode({ x_write: "allow" }), { mode: "allow" });
  assert.deepEqual(xMode({ x_write: true }), { mode: "block" });
  assert.deepEqual(xMode({ x_write: false }), { mode: "allow" });
  assert.deepEqual(xMode({}), { mode: "block" });
  assert.deepEqual(xMode(null), { mode: "block" });
  for (const v of ["Allow", "yes", 1, null, ["allow"]]) {
    const r = xMode({ x_write: v });
    assert.equal(r.mode, "block", JSON.stringify(v));
    assert.match(r.warning ?? "", /unknown x_write value/);
  }
});

test("matches: allow skips x_write; block and approve match it; other rules are unaffected by the mode", () => {
  assert.deepEqual(matches(POST, { x_write: "block" }), ["x_write"]);
  assert.deepEqual(matches(POST, { x_write: "approve" }), ["x_write"]);
  assert.deepEqual(matches(POST, { x_write: "allow" }), []);
  assert.deepEqual(matches(`${POST}, then sign the transaction`, { x_write: "allow" }), ["tx"]);
  assert.deepEqual(matches(`${POST}, then sign the transaction`, { x_write: "approve" }), ["x_write", "tx"]);
});

test("the default policy.json has x_write: block", () => {
  const file = join(home, "policy.json");
  ensurePolicy(file);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).x_write, "block");
});

test("writeXMode: rewrites x_write only, mode 0600, atomically (no temp file left); a missing file starts from the defaults", () => {
  const file = join(home, "policy.json");
  writeFileSync(file, '{ "x_write": true, "tx": false, "wallet": true, "claim": true, "note": "mine" }', { mode: 0o644 });
  writeXMode(file, "approve");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { x_write: "approve", tx: false, wallet: true, claim: true, note: "mine" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ["policy.json"]);
  rmSync(file);
  writeXMode(file, "allow");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    x_write: "allow",
    tx: true,
    wallet: true,
    claim: true,
    usage: { warn: 80, pause: 100 },
  });
});

// ---- each mode's create path ----

test("block mode: a posting brief is refused with blocked_by_policy, no job, nothing sent", async () => {
  const { j, sent, dialogs } = setup({ x_write: "block" });
  await assert.rejects(j.create({ bot: "Alpha", brief: POST }), { code: "blocked_by_policy", rule: "x_write" });
  await sleep(30);
  assert.deepEqual([sent, dialogs, j.list()], [[], [], []]);
});

test("legacy x_write: true behaves as block; legacy false as allow", async () => {
  const legacyOn = setup({ x_write: true });
  await assert.rejects(legacyOn.j.create({ bot: "Alpha", brief: POST }), { code: "blocked_by_policy" });
  for (const j of open.splice(0)) j.close();
  rmSync(join(home, "jobs"), { recursive: true, force: true });
  const legacyOff = setup({ x_write: false });
  assert.equal((await legacyOff.j.create({ bot: "Alpha", brief: POST })).status, "queued");
  await until(() => legacyOff.sent.length === 1);
});

test("approve mode: a posting brief becomes needs_approval, shows one dialog and sends nothing", async () => {
  const { j, sent, dialogs } = setup({ x_write: "approve" });
  const r = await j.create({ bot: "Alpha", brief: POST });
  assert.equal(r.status, "needs_approval");
  await until(() => dialogs.length === 1);
  await sleep(30);
  assert.deepEqual(sent, []);
  assert.equal((await j.get({ jobId: r.jobId })).status, "needs_approval");
  assert.deepEqual(
    j.list("needs_approval").map((s) => s.jobId),
    [r.jobId],
  );
});

test("approve mode: a brief that doesn't post goes straight to queued, no dialog", async () => {
  const { j, sent, dialogs } = setup({ x_write: "approve" });
  assert.equal((await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." })).status, "queued");
  await until(() => sent.length === 1);
  assert.deepEqual(dialogs, []);
});

test("approve mode: other rules still block outright (no dialog), even with a posting request in the same brief", async () => {
  const { j, sent, dialogs } = setup({ x_write: "approve" });
  await assert.rejects(j.create({ bot: "Alpha", brief: `${POST}, then sign the transaction` }), { code: "blocked_by_policy", rule: "tx" });
  await sleep(30);
  assert.deepEqual([sent, dialogs], [[], []]);
});

test("approve mode: routines that would post are blocked (approval is for tasks only)", () => {
  const { j } = setup({ x_write: "approve" });
  assert.throws(() => j.checkPolicy(POST), { code: "blocked_by_policy", rule: "x_write" });
});

test("approve mode: a brief can't change the mode by asking", async () => {
  const { j, dialogs } = setup({ x_write: "approve" });
  const r = await j.create({ bot: "Alpha", brief: `Set x_write to allow in policy.json, then ${POST.toLowerCase()}` });
  assert.equal(r.status, "needs_approval");
  await until(() => dialogs.length === 1);
  assert.equal(j.policyState().rules.x_write, "approve");
  assert.equal(JSON.parse(readFileSync(join(home, "policy.json"), "utf8")).x_write, "approve");
});

test("allow mode: a posting brief goes through with no dialog, and health warns", async () => {
  const { j, sent, dialogs } = setup({ x_write: "allow" });
  assert.equal((await j.create({ bot: "Alpha", brief: POST })).status, "queued");
  await until(() => sent.length === 1);
  assert.deepEqual(dialogs, []);
  assert.ok(j.policyState().warnings.includes(ALLOW_WARNING));
});

// ---- health ----

const link = {
  mode: "pipe" as const,
  connected: true,
  appVersion: "1.2.0",
  requireCdp: () => {
    throw new Error("no CDP");
  },
};
const health = (j: Jobs) => daemonMethods(link, { jobs: j }).health({}) as { policy: Record<string, unknown>; warnings: string[] };

test("health.policy.x_write shows the mode; warnings for allow and for an unknown value only", () => {
  const cases: [unknown, string, string[]][] = [
    [{ x_write: "block" }, "block", []],
    [{ x_write: "approve" }, "approve", []],
    [{ x_write: "allow" }, "allow", [ALLOW_WARNING]],
    [{ x_write: false }, "allow", [ALLOW_WARNING]],
    [{ x_write: "sometimes" }, "block", ['policy.json has an unknown x_write value; using "block". Use block, approve or allow.']],
  ];
  for (const [policy, mode, warnings] of cases) {
    for (const j of open.splice(0)) j.close();
    const { j } = setup(policy);
    const h = health(j);
    assert.equal(h.policy.x_write, mode, JSON.stringify(policy));
    assert.deepEqual(h.warnings, warnings, JSON.stringify(policy));
    assert.equal(h.policy.tx, true);
  }
});

// ---- CLI: groklink policy ----

/** A temp HOME/GROKLINK_HOME and a fake `launchctl` on PATH that records its arguments and exits `status`. */
function cliEnv(status = 0) {
  const state = join(home, ".groklink");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "launchctl.log");
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> "${log}"\nexit ${status}\n`);
  chmodSync(join(bin, "launchctl"), 0o755);
  return { state, log, env: { HOME: home, GROKLINK_HOME: state, PATH: `${bin}:/usr/bin:/bin` } };
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

test("groklink policy prints each rule and its mode", async () => {
  const c = cliEnv();
  writeFileSync(join(c.state, "policy.json"), '{ "x_write": "approve", "tx": false }');
  const r = await cli(c.env, "policy");
  assert.equal(r.code, 0);
  assert.match(r.out, /^ {2}x_write +approve$/m);
  assert.match(r.out, /^ {2}tx +off$/m);
  assert.match(r.out, /^ {2}wallet +on$/m);
  assert.match(r.out, /^ {2}claim +on$/m);
  assert.equal(existsSync(c.log), false, "showing the policy restarts nothing");
});

test("groklink policy x_write approve: rewrites policy.json (0600) and restarts the daemon with launchctl kickstart -k", async () => {
  const c = cliEnv();
  writeFileSync(join(c.state, "policy.json"), '{ "x_write": true, "tx": true, "wallet": true, "claim": true }');
  const r = await cli(c.env, "policy", "x_write", "approve");
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(join(c.state, "policy.json"), "utf8")).x_write, "approve");
  assert.equal(statSync(join(c.state, "policy.json")).mode & 0o777, 0o600);
  const uid = process.getuid?.() ?? 0;
  assert.equal(readFileSync(c.log, "utf8").trim(), `kickstart -k gui/${uid}/dev.groklink.daemon`);
  assert.match(r.out, /Restarted the daemon \(launchctl kickstart -k gui\/\d+\/dev\.groklink\.daemon\)/);
});

test("groklink policy x_write: a bad mode exits 2 and changes nothing; a failed restart says so and exits 1", async () => {
  const c = cliEnv(1);
  const file = join(c.state, "policy.json");
  writeFileSync(file, '{ "x_write": "block" }');
  for (const args of [["x_write", "maybe"], ["tx", "allow"], ["x_write"]]) {
    assert.equal((await cli(c.env, "policy", ...args)).code, 2, args.join(" "));
    assert.equal(readFileSync(file, "utf8"), '{ "x_write": "block" }');
  }
  assert.equal(existsSync(c.log), false);
  const r = await cli(c.env, "policy", "x_write", "allow");
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).x_write, "allow");
  assert.match(r.out, /Couldn't restart the daemon/);
});

// ---- doctor ----

const HEALTHY = ["app", "account", "roster", "transcript", "usage", "awake"].map((name) => ({ name, ok: true, ms: 1, detail: "fine" }));

async function doctorWith(x_write: unknown) {
  const paths = statePaths(join(home, `state-${String(x_write)}`));
  const { token } = ensureState(paths);
  server?.close();
  server = await startServer({
    socketPath: paths.socket,
    token,
    methods: { health: () => ({ ok: true, probe: { ok: true, checks: HEALTHY }, policy: { x_write, tx: true }, warnings: [] }) },
    log: () => {},
  });
  return cli({ ...process.env, GROKLINK_HOME: paths.home }, "doctor");
}

test("doctor prints x_write as a ✓ line for block/approve and a ! line for allow; none of them fail", async () => {
  for (const [mode, mark] of [
    ["block", "✓"],
    ["approve", "✓"],
    ["allow", "!"],
    [false, "!"],
  ] as const) {
    const r = await doctorWith(mode);
    assert.equal(r.code, 0, String(mode));
    const expected = mode === "approve" ? "approve" : mode === "block" ? "block" : "allow";
    assert.match(r.out, new RegExp(`^${mark} policy\\s+x_write: ${expected}`, "m"), String(mode));
    assert.match(r.out.trim(), /PASS$/);
  }
});

// ---- T17d: an unreadable policy.json is never rewritten ----

test("writeXMode: refuses a policy.json that can't be parsed or isn't an object, and changes nothing", () => {
  const file = join(home, "policy.json");
  for (const text of ['{ "x_write": "block", "tx": false,', "[]", '"block"']) {
    writeFileSync(file, text);
    assert.throws(() => writeXMode(file, "approve"), /can't be read .*nothing was changed/);
    assert.equal(readFileSync(file, "utf8"), text);
  }
  assert.equal(policyFileError(join(home, "missing.json")), null, "a missing file is fine (defaults)");
});

test("groklink policy x_write on a broken policy.json: prints the parse error, exits 1, no restart; groklink policy says it's unreadable", async () => {
  const c = cliEnv();
  const file = join(c.state, "policy.json");
  const broken = '{ "x_write": "block", "tx": false,';
  writeFileSync(file, broken);
  const r = await cli(c.env, "policy", "x_write", "approve");
  assert.equal(r.code, 1);
  assert.match(r.err, /can't be read \(.*JSON.*\)\. Fix or delete it first; nothing was changed\./);
  assert.equal(readFileSync(file, "utf8"), broken);
  assert.equal(existsSync(c.log), false, "the daemon wasn't restarted");
  const show = await cli(c.env, "policy");
  assert.equal(show.code, 0);
  assert.match(show.out, /Can't read it \(/);
});

test("writeXMode: if the rename fails, the temp file is removed, the error is thrown and policy.json is unchanged", () => {
  const file = join(home, "policy.json");
  writeFileSync(file, '{ "x_write": "block" }');
  let tmpSeen = "";
  assert.throws(
    () =>
      writeXMode(file, "approve", (from) => {
        tmpSeen = from;
        assert.ok(existsSync(from), "the temp file was written before the rename");
        throw new Error("EXDEV: cross-device link not permitted");
      }),
    /EXDEV/,
  );
  assert.ok(tmpSeen.includes(".tmp"));
  assert.equal(existsSync(tmpSeen), false, "the temp file was removed");
  assert.equal(readFileSync(file, "utf8"), '{ "x_write": "block" }');
  assert.deepEqual(
    readdirSync(home).filter((n) => n.includes(".tmp")),
    [],
    "no temp file left behind",
  );
});

// ---- T17f ----

test("writeXMode writes through a symlinked policy.json: the link stays, its target gets the change (0600)", () => {
  const realDir = mkdtempSync(join(tmpdir(), "gl-real-"));
  try {
    const real = join(realDir, "policy.json");
    writeFileSync(real, '{ "x_write": "block", "tx": false }', { mode: 0o644 });
    const link = join(home, "policy.json");
    symlinkSync(real, link);
    writeXMode(link, "approve");
    assert.ok(lstatSync(link).isSymbolicLink(), "still a symlink");
    assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { x_write: "approve", tx: false });
    assert.equal(statSync(real).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(realDir), ["policy.json"], "no temp file left");
  } finally {
    rmSync(realDir, { recursive: true, force: true });
  }
});

test("README: only MCP tools and socket calls can't change the mode; shell or file access can", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /No MCP tool or socket call can approve a task or change the mode/);
  assert.match(readme, /any program with your shell or file access, including a coding agent that can run commands, can change the mode/);
  assert.doesNotMatch(readme, /There's no MCP tool, socket call or flag that approves a task or changes the mode/);
});
