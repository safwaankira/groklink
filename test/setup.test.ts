import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { LABEL } from "../src/client/install.ts";
import { type SetupCheck, type SetupEnv, setup } from "../src/client/setup.ts";

const run = promisify(execFile);
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glk-setup-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NODE = "/opt/node/bin/node";
const CLI = "/opt/groklink/dist/groklink.js";
const P = {
  desktop: () => join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
  cursor: () => join(home, ".cursor/mcp.json"),
  claude: () => join(home, ".claude.json"),
  plist: () => join(home, "Library/LaunchAgents", `${LABEL}.plist`),
  skill: () => join(home, ".claude/skills/groklink/SKILL.md"),
};
const put = (file: string, v: unknown) => {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v, null, 2));
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function snapshot(dir = home): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) Object.assign(out, snapshot(f));
    else out[f] = readFileSync(f, "utf8");
  }
  return out;
}

const HEALTHY: SetupCheck[] = ["app", "account", "roster", "transcript", "usage", "awake"].map((name) => ({
  name,
  ok: true,
  detail: "fine",
}));

type Fake = {
  claude?: boolean;
  /** Health answers `connected: true` from this call on (default: always); Infinity = never connects. */
  connectsAfter?: number;
  /** The daemon doesn't answer at all until launchctl bootstrap has run. */
  downUntilLoaded?: boolean;
  desktop?: boolean;
  bootstrapFails?: boolean;
  checks?: SetupCheck[] | Error;
  bots?: string[] | Error;
  skill?: string | null;
};

/** A setup env with fake launchctl, claude, daemon health, doctor and Bot list. Records every command and Bot-facing call. */
function fakeEnv(o: Fake = {}) {
  const calls: string[][] = [];
  const out: string[] = [];
  /** Every call that reaches the daemon; setup may only make read-only ones. */
  const daemon: string[] = [];
  let healthCalls = 0;
  let loaded = !o.downUntilLoaded;
  const skillSource = o.skill === undefined ? join(home, "pkg/SKILL.md") : o.skill;
  if (skillSource) put(skillSource, "# Grok Link skill\n");
  const env: SetupEnv = {
    home,
    stateHome: join(home, ".groklink"),
    uid: 501,
    node: NODE,
    cli: CLI,
    run(cmd, args) {
      calls.push([cmd, ...args]);
      if (cmd === "claude") {
        const cfg = existsSync(P.claude()) ? json(P.claude()) : {};
        cfg.mcpServers ??= {};
        if (args[1] === "add") cfg.mcpServers[args[4]] = { type: "stdio", command: args[6], args: args.slice(7) };
        put(P.claude(), cfg);
      }
      if (cmd === "launchctl" && args[0] === "print") return { status: 113 };
      if (cmd === "launchctl" && args[0] === "bootstrap") {
        if (o.bootstrapFails) return { status: 5 };
        loaded = true;
      }
      return { status: 0 };
    },
    desktopRunning: () => o.desktop === true,
    onPath: (name) => name === "claude" && o.claude !== false,
    health: async () => {
      daemon.push("health");
      if (!loaded) throw new Error("not running");
      return { connected: ++healthCalls > (o.connectsAfter ?? 0), appVersion: "1.2.3", mode: "pipe" };
    },
    doctor: async () => {
      daemon.push("doctor");
      if (o.checks instanceof Error) throw o.checks;
      return o.checks ?? HEALTHY;
    },
    bots: async () => {
      daemon.push("bots");
      if (o.bots instanceof Error) throw o.bots;
      return o.bots ?? ["Alpha", "Beta"];
    },
    out: (line) => out.push(line),
    skillSource,
    waitMs: 100,
    pollMs: 10,
    bootoutWaitMs: 100,
    launchPollMs: 5,
    bootstrapRetryMs: 5,
  };
  return { env, calls, out, daemon };
}

const marks = (out: string[]) => out.filter((l) => /^[✓✗] /.test(l)).map((l) => l.split(/\s+/).slice(0, 2).join(" "));

test("setup: a fresh Mac runs the four steps in order, one ✓ line each, then the Try it line with the first Bot; exit 0", async () => {
  put(P.cursor(), { mcpServers: {} });
  const f = fakeEnv();
  assert.equal(await setup(f.env), 0);
  assert.deepEqual(marks(f.out), ["✓ install", "✓ skill", "✓ daemon", "✓ doctor"]);
  assert.equal(f.out.length, 5, "one line per step, plus Try it");
  assert.match(f.out[0], /daemon runs at login; MCP server registered in Claude Code, Cursor \(restart them to load it\)/);
  assert.match(f.out[1], /installed for Claude Code/);
  assert.match(f.out[2], /connected to Grok Bot 1\.2\.3 \(pipe mode\)/);
  assert.match(f.out[3], /PASS \(6 checks\)/);
  assert.equal(f.out[4], "Try it: groklink doctor --send Alpha  (uses one Grok message)");
  assert.ok(existsSync(P.plist()));
  assert.equal(readFileSync(P.skill(), "utf8"), "# Grok Link skill\n");
  assert.deepEqual(json(P.cursor()).mcpServers.groklink, { command: NODE, args: [CLI, "mcp"] });
  assert.ok(f.calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap"));
});

test("setup never sends a Bot message: it only reads health, doctor's checks and the Bot list", async () => {
  const f = fakeEnv();
  assert.equal(await setup(f.env), 0);
  assert.deepEqual([...new Set(f.daemon)].sort(), ["bots", "doctor", "health"]);
  const text = readFileSync("src/client/setup.ts", "utf8");
  assert.doesNotMatch(text, /call\(|"task"|sendCheck/, "setup.ts has no way to reach the task method");
});

test("setup: the Try it line quotes a Bot name with spaces, and falls back to <bot> if the list can't be read", async () => {
  const spaced = fakeEnv({ bots: ["My $Bot"] });
  await setup(spaced.env);
  assert.equal(spaced.out.at(-1), 'Try it: groklink doctor --send "My \\$Bot"  (uses one Grok message)');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
  const none = fakeEnv({ bots: new Error("no") });
  assert.equal(await setup(none.env), 0);
  assert.equal(none.out.at(-1), "Try it: groklink doctor --send <bot>  (uses one Grok message)");
});

test("setup again is safe: nothing is reloaded or rewritten, the skill and registrations are kept, exit 0", async () => {
  const first = fakeEnv();
  assert.equal(await setup(first.env), 0);
  const before = snapshot();
  const again = fakeEnv();
  assert.equal(await setup(again.env), 0);
  assert.deepEqual(marks(again.out), ["✓ install", "✓ skill", "✓ daemon", "✓ doctor"]);
  assert.match(again.out[0], /MCP clients were already registered/);
  assert.match(again.out[1], /already installed/);
  assert.deepEqual(again.calls, [], "no launchctl or claude command the second time");
  assert.deepEqual(snapshot(), before);
});

test("setup again after the daemon stopped: the LaunchAgent is loaded again", async () => {
  assert.equal(await setup(fakeEnv().env), 0);
  const f = fakeEnv({ downUntilLoaded: true });
  assert.equal(await setup(f.env), 0);
  assert.ok(f.calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap"));
});

test("setup: an edited skill is kept; without Claude Code the skill step is skipped", async () => {
  put(P.skill(), "# my edits\n");
  const f = fakeEnv();
  assert.equal(await setup(f.env), 0);
  assert.match(f.out[1], /^✓ skill +kept your edited copy$/);
  assert.equal(readFileSync(P.skill(), "utf8"), "# my edits\n");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
  const none = fakeEnv({ claude: false });
  assert.equal(await setup(none.env), 0);
  assert.match(none.out[1], /^✓ skill +skipped \(Claude Code not found\)$/);
  assert.equal(existsSync(join(home, ".claude")), false);
});

test("setup fails at install: Claude Desktop running → one ✗ line with the fix, exit 1, nothing written, later steps not run", async () => {
  put(P.desktop(), { mcpServers: {} });
  const before = snapshot();
  const f = fakeEnv({ desktop: true });
  assert.equal(await setup(f.env), 1);
  assert.equal(f.out.length, 1);
  assert.match(f.out[0], /^✗ install +Claude Desktop is running.* Fix: quit Claude Desktop \(Cmd\+Q\), then run `groklink setup` again\.$/);
  // The skill source the fake wrote is the only new file.
  assert.deepEqual(
    Object.keys(snapshot()).filter((k) => !(k in before)),
    [join(home, "pkg/SKILL.md")],
  );
  assert.deepEqual(f.daemon, []);
});

test("setup fails at install: the old grokbot-bridge, a failed launchctl, a daemon that never connects", async () => {
  put(P.cursor(), { mcpServers: { grokbot: { command: "grokbot", args: ["mcp"] } } });
  const bridge = fakeEnv();
  assert.equal(await setup(bridge.env), 1);
  assert.deepEqual(marks(bridge.out), ["✗ install"]);
  assert.match(bridge.out[0], /Fix: run `groklink install --replace-grokbot-bridge`, then run `groklink setup` again\.$/);
  assert.equal(existsSync(P.plist()), false);

  rmSync(P.cursor());
  const launch = fakeEnv({ bootstrapFails: true });
  assert.equal(await setup(launch.env), 1);
  assert.match(
    launch.out[0],
    /^✗ install +launchctl couldn't load the LaunchAgent\. Fix: check .*daemon\.log, then run `groklink setup` again\.$/,
  );

  const never = fakeEnv({ connectsAfter: Number.POSITIVE_INFINITY });
  assert.equal(await setup(never.env), 1);
  assert.deepEqual(marks(never.out), ["✗ install"]);
  assert.match(never.out[0], /didn't connect to Grok Bot\. Fix: open Grok Bot and sign in, then run `groklink setup` again/);
  assert.equal(existsSync(P.claude()), false, "no client was registered");
});

test("setup fails at the skill step: earlier steps stay done, exit 1", async () => {
  const f = fakeEnv({ skill: null });
  assert.equal(await setup(f.env), 1);
  assert.deepEqual(marks(f.out), ["✓ install", "✗ skill"]);
  assert.match(f.out[1], /Fix: reinstall with `npm i -g groklink`, then run `groklink setup` again\.$/);
  assert.ok(existsSync(P.plist()), "the install step is not undone");
  assert.ok(json(P.claude()).mcpServers.groklink);
});

test("setup fails at the daemon step when it stops answering after install", async () => {
  // Health answers connected for install's own wait (call 1), then never again.
  const f = fakeEnv();
  let n = 0;
  f.env.health = async () => ({ connected: ++n === 1, appVersion: "1.2.3", mode: "pipe" });
  assert.equal(await setup(f.env), 1);
  assert.deepEqual(marks(f.out), ["✓ install", "✓ skill", "✗ daemon"]);
  assert.match(f.out[2], /Fix: open Grok Bot and sign in, then run `groklink setup` again/);
});

test("setup fails at doctor: the failed check and its detail in one line, exit 1, no Try it line; a doctor error too", async () => {
  const checks = HEALTHY.map((c) => (c.name === "account" ? { ...c, ok: false, detail: "signed_out" } : c));
  const f = fakeEnv({ checks });
  assert.equal(await setup(f.env), 1);
  assert.deepEqual(marks(f.out), ["✓ install", "✓ skill", "✓ daemon", "✗ doctor"]);
  assert.match(f.out[3], /^✗ doctor +account: signed_out\. Fix that, then run `groklink doctor`\.$/);
  assert.equal(f.out.length, 4);
  assert.ok(!f.daemon.includes("bots"));
  const thrown = fakeEnv({ checks: new Error("socket closed") });
  assert.equal(await setup(thrown.env), 1);
  assert.match(thrown.out.at(-1) ?? "", /^✗ doctor +socket closed Fix: run `groklink doctor` to see each check\.$/);
});

test("setup: doctor warnings don't fail it and are shown on the doctor line", async () => {
  const checks = HEALTHY.map((c) => (c.name === "usage" ? { ...c, warn: true, detail: "85% used (warn at 80%)" } : c));
  const f = fakeEnv({ checks });
  assert.equal(await setup(f.env), 0);
  assert.match(f.out[3], /^✓ doctor +PASS \(6 checks; warnings: usage: 85% used \(warn at 80%\)\)$/);
});

test("setup --dry-run prints the four steps and writes, runs and sends nothing", async () => {
  put(P.cursor(), { mcpServers: {} });
  const f = fakeEnv();
  const before = snapshot();
  assert.equal(await setup(f.env, { dryRun: true }), 0);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.daemon, []);
  const text = f.out.join("\n");
  assert.match(text, /^Dry run; nothing was written and nothing was sent\. groklink setup would:/);
  for (const step of ["1. install:", "2. skill:", "3. daemon: wait up to 0.1 s", "4. doctor:"]) assert.ok(text.includes(step), step);
  assert.match(text, /Cursor: add mcpServers\.groklink/);
  assert.match(text, /would write .*\.claude\/skills\/groklink\/SKILL\.md/);
  assert.match(text, /It never sends a Bot message\.$/);
});

test("CLI: groklink setup --dry-run works from the built CLI; an unknown option exits 2; help lists it", async () => {
  const env = { HOME: home, GROKLINK_HOME: join(home, ".groklink"), PATH: "/usr/bin:/bin" };
  const { stdout } = await run(process.execPath, ["dist/groklink.js", "setup", "--dry-run"], { env });
  assert.match(stdout, /groklink setup would:/);
  assert.match(stdout, /Library\/LaunchAgents\/dev\.groklink\.daemon\.plist/);
  assert.deepEqual(readdirSync(home), []);
  await assert.rejects(run(process.execPath, ["dist/groklink.js", "setup", "--send"], { env }), { code: 2 });
  const help = await run(process.execPath, ["dist/groklink.js", "--help"], { env });
  assert.match(help.stdout, /groklink setup \[--dry-run\]/);
});

test("README quick start is two lines: npm i -g groklink, then groklink setup", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /```bash\nnpm i -g groklink\ngroklink setup\n```/);
});
