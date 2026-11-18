import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { type InstallEnv, installSkill } from "../src/client/install.ts";
import type { ProbeCheck } from "../src/daemon/probe.ts";
import { type Methods, startServer } from "../src/daemon/server.ts";
import { ensureState, statePaths } from "../src/daemon/state.ts";

const run = promisify(execFile);

const check = (name: ProbeCheck["name"], ok = true, detail = "fine", warn = false): ProbeCheck => ({
  name,
  ok,
  ...(warn ? { warn: true as const } : {}),
  ms: 3,
  detail,
});
const HEALTHY = ["app", "account", "roster", "transcript", "usage", "awake"].map((n) => check(n as ProbeCheck["name"]));

let server: Server | null = null;
let home: string | null = null;
afterEach(() => {
  server?.close();
  server = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

/** A fake daemon answering health (deep → `checks`), task and job; counts every task sent. */
async function daemon(checks: ProbeCheck[] | null, reply = "pong", status = "done") {
  home = mkdtempSync(join(tmpdir(), "gl-doc-"));
  const paths = statePaths(home);
  const { token } = ensureState(paths);
  const sent: unknown[] = [];
  const methods: Methods = {
    health: (p) => ({
      ok: true,
      connected: true,
      warnings: checks?.some((c) => !c.ok) ? ["Grok usage used up, resets Thu, 19 Nov 2026 08:00:00 GMT."] : [],
      ...(p.deep && checks ? { probe: { ok: checks.every((c) => c.ok), checks } } : {}),
    }),
    task: (p) => {
      sent.push(p);
      return { jobId: "j_000000000001", status: "queued" };
    },
    job: () => ({ jobId: "j_000000000001", status, messages: [{ role: "assistant", text: reply, untrusted: true }] }),
  };
  server = await startServer({ socketPath: paths.socket, token, methods, log: () => {} });
  return { home, sent };
}

async function doctor(stateHome: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(process.execPath, ["dist/groklink.js", "doctor", ...args], {
      env: { ...process.env, GROKLINK_HOME: stateHome },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, out: err.stdout };
  }
}

test("doctor: all checks pass → one line per check, PASS, exit 0, nothing sent", async () => {
  const d = await daemon([...HEALTHY.slice(0, 5), check("awake", true, "Bot's computer is away", true)]);
  const r = await doctor(d.home);
  assert.equal(r.code, 0);
  const lines = r.out.trim().split("\n");
  assert.deepEqual(
    lines.map((l) => l.split(/\s+/).slice(0, 2).join(" ")),
    ["✓ app", "✓ account", "✓ roster", "✓ transcript", "✓ usage", "! awake", "PASS"],
  );
  assert.equal(d.sent.length, 0);
});

test("doctor: a failed check → ✗ line, FAIL: <first failed>, exit 1, warnings shown", async () => {
  const checks = HEALTHY.map((c) =>
    c.name === "usage" ? check("usage", false, "Grok usage used up, resets Thu, 19 Nov 2026 08:00:00 GMT") : c,
  );
  const d = await daemon(checks);
  const r = await doctor(d.home);
  assert.equal(r.code, 1);
  assert.match(r.out, /^✗ usage\s+Grok usage used up, resets Thu, 19 Nov 2026/m);
  assert.match(r.out, /Grok usage used up, resets Thu, 19 Nov 2026 08:00:00 GMT\.$/m);
  assert.match(r.out.trim(), /FAIL: usage$/);
});

test("doctor: no daemon, or a daemon without deep health, fails on daemon", async () => {
  home = mkdtempSync(join(tmpdir(), "gl-doc-"));
  const none = await doctor(home);
  assert.equal(none.code, 1);
  assert.match(none.out, /^✗ daemon\s+not_connected/m);
  assert.match(none.out.trim(), /FAIL: daemon$/);
  rmSync(home, { recursive: true, force: true });
  const old = await daemon(null);
  const r = await doctor(old.home);
  assert.equal(r.code, 1);
  assert.match(r.out, /no deep health/);
});

test("doctor --send: sends exactly one task and passes on a pong reply; never sends without the flag", async () => {
  const d = await daemon(HEALTHY);
  assert.equal((await doctor(d.home)).code, 0);
  assert.equal(d.sent.length, 0, "no --send, nothing sent");
  const r = await doctor(d.home, "--send", "Alpha");
  assert.equal(r.code, 0);
  assert.deepEqual(d.sent, [{ bot: "Alpha", brief: "Reply with only the word: pong" }]);
  assert.match(r.out, /uses one Grok message/);
  assert.match(r.out, /^✓ send\s+Alpha replied pong/m);
  assert.match(r.out.trim(), /PASS$/);
});

test("doctor --send: a reply without pong fails; a failed check skips the send", async () => {
  const d = await daemon(HEALTHY, "hello");
  const r = await doctor(d.home, "--send", "Alpha");
  assert.equal(r.code, 1);
  assert.match(r.out.trim(), /FAIL: send$/);
  server?.close();
  rmSync(d.home, { recursive: true, force: true });
  const bad = await daemon(HEALTHY.map((c) => (c.name === "account" ? check("account", false, "signed_out") : c)));
  const s = await doctor(bad.home, "--send", "Alpha");
  assert.equal(s.code, 1);
  assert.equal(bad.sent.length, 0);
  assert.match(s.out, /✗ send\s+skipped/);
  assert.match(s.out.trim(), /FAIL: account$/);
});

test("doctor --json prints the raw result; exit code still follows the checks", async () => {
  const d = await daemon(HEALTHY);
  const r = await doctor(d.home, "--json");
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.pass, true);
  assert.equal(j.probe.checks.length, 6);
  assert.equal(d.sent.length, 0);
});

test("doctor: bad arguments exit 2", async () => {
  home = mkdtempSync(join(tmpdir(), "gl-doc-"));
  assert.equal((await doctor(home, "extra")).code, 2);
  assert.equal((await doctor(home, "--send")).code, 2);
});

// ---- skill ----

const SKILL = join("skills", "groklink", "SKILL.md");

test("skill: valid frontmatter, at most 80 lines, covers the key rules", () => {
  const text = readFileSync(SKILL, "utf8");
  assert.ok(text.split("\n").length <= 80);
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "frontmatter block");
  const fm = Object.fromEntries(
    (m?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
  );
  assert.deepEqual(fm, {
    name: "groklink",
    description: "How to use the Grok Link MCP tools to send tasks to Grok Bot and read results.",
  });
  for (const s of [
    "groklink_health",
    "wait_seconds",
    "needs_input",
    "stale",
    "blocked_by_policy",
    "untrusted",
    "~/.groklink/downloads/<bot>/",
  ])
    assert.ok(text.includes(s), s);
});

test("skill: npm pack lists skills/groklink/SKILL.md", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const files = (JSON.parse(r.stdout)[0].files as { path: string }[]).map((f) => f.path);
  assert.ok(files.includes("skills/groklink/SKILL.md"), files.join(", "));
});

function skillEnv(): InstallEnv & { lines: string[] } {
  home = mkdtempSync(join(tmpdir(), "gl-skill-"));
  const lines: string[] = [];
  return {
    home,
    stateHome: join(home, ".groklink"),
    uid: 501,
    node: process.execPath,
    cli: "/x/groklink.js",
    run: () => ({ status: 0 }),
    onPath: () => false,
    health: async () => ({}),
    out: (l) => lines.push(l),
    skillSource: SKILL,
    lines,
  };
}

test("install --skill: copies the skill; keeps a different copy unless forced", () => {
  const env = skillEnv();
  const dest = join(env.home, ".claude", "skills", "groklink", "SKILL.md");
  assert.equal(installSkill(env), 0);
  assert.equal(readFileSync(dest, "utf8"), readFileSync(SKILL, "utf8"));
  assert.equal(installSkill(env), 0);
  assert.match(env.lines.at(-1) ?? "", /already installed/);
  writeFileSync(dest, "my own edits\n");
  assert.equal(installSkill(env), 0);
  assert.match(env.lines.at(-1) ?? "", /^Skipped: .*differs.*--force/);
  assert.equal(readFileSync(dest, "utf8"), "my own edits\n");
  assert.equal(installSkill(env, { force: true }), 0);
  assert.equal(readFileSync(dest, "utf8"), readFileSync(SKILL, "utf8"));
});

test("install --skill: dry run writes nothing; a missing packaged skill fails", () => {
  const env = skillEnv();
  assert.equal(installSkill(env, { dryRun: true }), 0);
  assert.equal(existsSync(join(env.home, ".claude")), false);
  assert.equal(installSkill({ ...env, skillSource: null }), 1);
});

test("install --skill via the CLI writes to ~/.claude/skills/groklink and touches nothing else", () => {
  home = mkdtempSync(join(tmpdir(), "gl-skill-"));
  mkdirSync(join(home, ".groklink"));
  const r = spawnSync(process.execPath, ["dist/groklink.js", "install", "--skill"], {
    env: { HOME: home, GROKLINK_HOME: join(home, ".groklink"), PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, ".claude", "skills", "groklink", "SKILL.md")));
  assert.equal(existsSync(join(home, "Library", "LaunchAgents")), false, "no LaunchAgent written");
});

// ---- review fixes (OpenQodex 1, 2, 7) ----

test("doctor --send: a job waiting on the user is reported as needs_input, not a 120 s timeout", async () => {
  const d = await daemon(HEALTHY, "", "needs_input");
  const started = Date.now();
  const r = await doctor(d.home, "--send", "Alpha");
  assert.equal(r.code, 1);
  assert.match(r.out, /^✗ send\s+Alpha: the Bot is waiting for input in Grok Bot \(needs_input\)/m);
  assert.doesNotMatch(r.out, /after 120 s/);
  assert.ok(Date.now() - started < 30_000, "returns as soon as the job needs input");
  assert.equal(d.sent.length, 1);
});

test("skill: only a used-up usage check means used up; any other usage failure is unreadable usage", () => {
  const text = readFileSync(SKILL, "utf8");
  assert.doesNotMatch(text, /the `usage` check fails, or `usage\.out` is true: Grok usage is used up/);
  assert.match(text, /`usage\.out` is true, or the `usage` check's detail starts with "Grok usage used up": usage is used up/);
  assert.match(text, /`usage` check fails with any other detail: usage couldn't be read \(not "used up"\)/);
});

test("install --skill: a filesystem error is reported with exit 1, not thrown", () => {
  const env = skillEnv();
  writeFileSync(join(env.home, ".claude"), "not a folder\n");
  assert.doesNotThrow(() => installSkill(env));
  assert.equal(installSkill(env), 1);
  assert.match(env.lines.at(-1) ?? "", /^groklink install --skill: couldn't install the skill: /);
});

test("install --skill via the CLI: a filesystem error exits 1 with a one-line message, no stack trace", () => {
  home = mkdtempSync(join(tmpdir(), "gl-skill-"));
  writeFileSync(join(home, ".claude"), "not a folder\n");
  const r = spawnSync(process.execPath, ["dist/groklink.js", "install", "--skill"], {
    env: { HOME: home, GROKLINK_HOME: join(home, ".groklink"), PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /couldn't install the skill/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
});
