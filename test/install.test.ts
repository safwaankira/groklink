import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type InstallEnv, install, isGrokbotBridge, LABEL, uninstall } from "../src/client/install.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glk-install-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NODE = "/opt/node/bin/node";
const CLI = "/opt/groklink/dist/groklink.js";
const P = {
  desktop: () => join(home, "Library/Application Support/Claude/claude_desktop_config.json"),
  cursor: () => join(home, ".cursor/mcp.json"),
  claude: () => join(home, ".claude.json"),
  codex: () => join(home, ".codex/config.toml"),
  plist: () => join(home, "Library/LaunchAgents", `${LABEL}.plist`),
};
const GROKLINK = { command: NODE, args: [CLI, "mcp"] };

const put = (file: string, v: unknown) => {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v, null, 2));
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

/** Every file under HOME with its contents, to prove nothing was written. */
function snapshot(dir = home): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) Object.assign(out, snapshot(f));
    else out[f] = readFileSync(f, "utf8");
  }
  return out;
}

/**
 * An env with fake launchctl/claude (claude mcp add/remove edit ~/.claude.json like the real one).
 * `stillLoaded`: how many `launchctl print` calls report the service present after bootout.
 * `bootstrapFails`: how many `launchctl bootstrap` calls fail before one succeeds.
 */
function fakeEnv(opts: { claude?: boolean; connects?: boolean; desktop?: boolean; stillLoaded?: number; bootstrapFails?: number } = {}) {
  const calls: string[][] = [];
  let stillLoaded = opts.stillLoaded ?? 0;
  let bootstrapFails = opts.bootstrapFails ?? 0;
  const out: string[] = [];
  const env: InstallEnv = {
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
        if (args[1] === "remove") delete cfg.mcpServers[args[4]];
        put(P.claude(), cfg);
      }
      if (cmd === "launchctl" && args[0] === "print") return { status: stillLoaded-- > 0 ? 0 : 113 };
      if (cmd === "launchctl" && args[0] === "bootstrap" && bootstrapFails-- > 0) return { status: 5 };
      return { status: 0 };
    },
    desktopRunning: () => opts.desktop === true,
    onPath: (name) => name === "claude" && opts.claude !== false,
    health: async () => ({ connected: opts.connects !== false, appVersion: "1.1.0", mode: "pipe" }),
    out: (line) => out.push(line),
    waitMs: 100,
    pollMs: 10,
    bootoutWaitMs: 500,
    launchPollMs: 5,
    bootstrapRetryMs: 5,
  };
  return { env, calls, out };
}

/** Configs for all four clients, each with unrelated content to keep. */
function seedClients() {
  put(P.desktop(), { mcpServers: { other: { command: "x" } }, theme: "dark" });
  put(P.cursor(), { mcpServers: { other: { command: "y" } }, foo: 1 });
  put(P.claude(), { mcpServers: { other: { command: "z" } }, numStartups: 3, projects: { "/p": { mcpServers: {} } } });
  put(P.codex(), 'model = "o4"\n\n[mcp_servers.other]\ncommand = "w"\n');
}

test("isGrokbotBridge matches the old bridge, not groklink", () => {
  assert.ok(isGrokbotBridge("node", ["/u/lib/node_modules/grokbot-bridge/dist/cli.js", "mcp"]));
  assert.ok(isGrokbotBridge("grokbot", ["mcp"]));
  assert.ok(isGrokbotBridge("/usr/local/bin/grokbot", ["mcp"]));
  assert.ok(!isGrokbotBridge(NODE, [CLI, "mcp"]));
  assert.ok(!isGrokbotBridge("grokbot", ["ask"]));
});

test("install writes the LaunchAgent, waits for the daemon, and registers every client, keeping other keys", async () => {
  seedClients();
  const { env, calls, out } = fakeEnv();
  assert.equal(await install(env), 0);

  const plist = readFileSync(P.plist(), "utf8");
  for (const s of [
    `<string>${LABEL}</string>`,
    `<string>${NODE}</string>`,
    "<string>/opt/groklink/dist/groklinkd.js</string>",
    "<key>RunAtLoad</key>\n  <true/>",
    "<key>KeepAlive</key>\n  <true/>",
    "<string>Interactive</string>",
    `<string>${join(home, ".groklink", "daemon.out")}</string>`,
  ])
    assert.ok(plist.includes(s), s);
  assert.deepEqual(calls.slice(0, 3), [
    ["launchctl", "bootout", `gui/501/${LABEL}`],
    ["launchctl", "print", `gui/501/${LABEL}`],
    ["launchctl", "bootstrap", "gui/501", P.plist()],
  ]);
  assert.deepEqual(calls[3], ["claude", "mcp", "add", "--scope", "user", "groklink", "--", NODE, CLI, "mcp"]);

  assert.deepEqual(json(P.desktop()), { mcpServers: { other: { command: "x" }, groklink: GROKLINK }, theme: "dark" });
  assert.deepEqual(json(P.cursor()), { mcpServers: { other: { command: "y" }, groklink: GROKLINK }, foo: 1 });
  assert.equal(json(P.claude()).numStartups, 3);
  assert.equal(
    readFileSync(P.codex(), "utf8"),
    `model = "o4"\n\n[mcp_servers.other]\ncommand = "w"\n\n[mcp_servers.groklink]\ncommand = "${NODE}"\nargs = ["${CLI}", "mcp"]\n`,
  );
  assert.ok(existsSync(`${P.desktop()}.bak`));
  assert.ok(out.some((l) => l.includes("connected: true")));
  assert.ok(out.some((l) => /Claude Desktop, Claude Code, Cursor, Codex/.test(l)));
  assert.ok(out.some((l) => /Restart/.test(l)));
});

test("a second install doesn't duplicate anything; the Claude Code add runs once", async () => {
  seedClients();
  await install(fakeEnv().env);
  const first = snapshot();
  const second = fakeEnv();
  assert.equal(await install(second.env), 0);
  assert.equal(second.calls.filter((c) => c[0] === "claude").length, 0);
  assert.equal((readFileSync(P.codex(), "utf8").match(/\[mcp_servers\.groklink\]/g) ?? []).length, 1);
  for (const f of [P.desktop(), P.cursor(), P.claude(), P.codex()]) assert.equal(readFileSync(f, "utf8"), first[f], f);
});

test("only clients that exist are registered", async () => {
  const { env, calls } = fakeEnv({ claude: false });
  assert.equal(await install(env), 0);
  assert.ok(!existsSync(P.desktop()) && !existsSync(P.cursor()) && !existsSync(P.codex()) && !existsSync(P.claude()));
  assert.ok(!calls.some((c) => c[0] === "claude"));
});

test("if the daemon doesn't connect, install prints the log path and registers nothing", async () => {
  seedClients();
  const before = json(P.desktop());
  const { env, out } = fakeEnv({ connects: false });
  assert.equal(await install(env), 1);
  assert.ok(out.some((l) => l.includes(join(home, ".groklink", "daemon.log"))));
  assert.deepEqual(json(P.desktop()), before);
});

test("uninstall removes only groklink and leaves the state folder", async () => {
  seedClients();
  await install(fakeEnv().env);
  mkdirSync(join(home, ".groklink"), { recursive: true });
  const { env, calls, out } = fakeEnv();
  assert.equal(await uninstall(env), 0);
  assert.ok(!existsSync(P.plist()));
  assert.deepEqual(calls[0], ["launchctl", "bootout", `gui/501/${LABEL}`]);
  assert.ok(calls.some((c) => c.join(" ") === "claude mcp remove --scope user groklink"));
  assert.deepEqual(json(P.desktop()), { mcpServers: { other: { command: "x" } }, theme: "dark" });
  assert.deepEqual(json(P.cursor()), { mcpServers: { other: { command: "y" } }, foo: 1 });
  assert.deepEqual(json(P.claude()).mcpServers, { other: { command: "z" } });
  assert.equal(readFileSync(P.codex(), "utf8"), 'model = "o4"\n\n[mcp_servers.other]\ncommand = "w"\n');
  assert.ok(existsSync(`${P.cursor()}.bak`));
  assert.ok(existsSync(join(home, ".groklink")));
  assert.ok(out.some((l) => l.includes(join(home, ".groklink")) && /Left/.test(l)));
});

test("--dry-run writes nothing and runs nothing, for install and uninstall", async () => {
  seedClients();
  const before = snapshot();
  const i = fakeEnv();
  assert.equal(await install(i.env, { dryRun: true }), 0);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(i.calls, []);
  assert.ok(i.out.some((l) => l.includes("Claude Code")));

  await install(fakeEnv().env);
  const installed = snapshot();
  const u = fakeEnv();
  assert.equal(await uninstall(u.env, { dryRun: true }), 0);
  assert.deepEqual(snapshot(), installed);
  assert.deepEqual(u.calls, []);
});

/** grokbot-bridge registered the ways it's found in the wild. */
function seedBridge() {
  const bridge = { command: "/u/bin/node", args: ["/u/lib/node_modules/grokbot-bridge/dist/cli.js", "mcp"] };
  put(P.desktop(), { mcpServers: { grokbot: bridge, other: { command: "x" } } });
  put(P.claude(), { mcpServers: { grokbot: { command: "grokbot", args: ["mcp"] } }, projects: { "/p": { mcpServers: { gb: bridge } } } });
  put(P.codex(), '[mcp_servers.grokbot]\ncommand = "grokbot"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "w"\n');
}

test("a grokbot-bridge entry without the flag: exit 1, names each one, writes and runs nothing", async () => {
  seedBridge();
  for (const dryRun of [false, true]) {
    const before = snapshot();
    const { env, calls, out } = fakeEnv();
    assert.equal(await install(env, { dryRun }), 1);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(calls, []);
    assert.ok(out.some((l) => l.includes('Claude Desktop: entry "grokbot"')));
    assert.ok(out.some((l) => l.includes('Claude Code: entry "grokbot"')));
    assert.ok(out.some((l) => l.includes('Claude Code: entry "gb"')));
    assert.ok(out.some((l) => l.includes('Codex: entry "grokbot"')));
    assert.ok(out.some((l) => /can't share/.test(l)));
  }
});

test("with --replace-grokbot-bridge: the entries are removed, backups exist, groklink is registered", async () => {
  seedBridge();
  const before = snapshot();
  const { env } = fakeEnv();
  assert.equal(await install(env, { replaceGrokbotBridge: true }), 0);
  for (const f of [P.desktop(), P.claude(), P.codex()]) assert.equal(readFileSync(`${f}.bak`, "utf8"), before[f], `${f}.bak`);
  assert.deepEqual(json(P.desktop()).mcpServers, { other: { command: "x" }, groklink: GROKLINK });
  const claude = json(P.claude());
  assert.equal(claude.mcpServers.grokbot, undefined);
  assert.deepEqual(claude.projects["/p"].mcpServers, {});
  assert.ok(claude.mcpServers.groklink);
  const codex = readFileSync(P.codex(), "utf8");
  assert.ok(!codex.includes("[mcp_servers.grokbot]"));
  assert.ok(codex.includes("[mcp_servers.other]") && codex.includes("[mcp_servers.groklink]"));
});

test("end to end: groklink.js install with a temp HOME and fake launchctl and claude on PATH", () => {
  const bin = join(home, "bin");
  const state = join(home, "state");
  mkdirSync(bin);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "token"), "ef".repeat(32), { mode: 0o600 });
  mkdirSync(join(home, "Library/Application Support/Claude"), { recursive: true });
  // Stands in for groklinkd: answers health on the state folder's socket, then exits.
  writeFileSync(
    join(home, "fake-daemon.mjs"),
    `import { createServer } from "node:net";
const s = createServer((c) => c.on("data", (d) => c.write(JSON.stringify({ id: JSON.parse(d).id, result: { connected: true, mode: "pipe", appVersion: "1.1.0" } }) + "\\n")));
s.listen(${JSON.stringify(join(state, "groklink.sock"))});
setTimeout(() => process.exit(0), 5000);
`,
  );
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(home, "calls.log")}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script(
    "launchctl",
    `[ "$1" = print ] && exit 113\n[ "$1" = bootstrap ] && "${process.execPath}" "${join(home, "fake-daemon.mjs")}" >/dev/null 2>&1 &\nexit 0`,
  );
  script("claude", "exit 0");
  // Claude Desktop "isn't running" for this test.
  script("pgrep", "exit 1");
  const r = spawnSync(process.execPath, ["dist/groklink.js", "install"], {
    env: { HOME: home, GROKLINK_HOME: state, PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cli = resolve("dist/groklink.js");
  const calls = readFileSync(join(home, "calls.log"), "utf8").trim().split("\n");
  const uid = process.getuid?.();
  assert.deepEqual(calls, [
    `pgrep -a -x Claude`,
    `launchctl bootout gui/${uid}/${LABEL}`,
    `launchctl print gui/${uid}/${LABEL}`,
    `launchctl bootstrap gui/${uid} ${P.plist()}`,
    `claude mcp add --scope user groklink -- ${process.execPath} ${cli} mcp`,
  ]);
  const plist = readFileSync(P.plist(), "utf8");
  assert.ok(plist.includes(`<string>${resolve("dist/groklinkd.js")}</string>`));
  assert.ok(plist.includes(`<key>GROKLINK_HOME</key>\n    <string>${state}</string>`));
  assert.deepEqual(json(P.desktop()).mcpServers.groklink, { command: process.execPath, args: [cli, "mcp"] });
  assert.match(r.stdout, /connected: true/);
});

test("Claude Desktop running: exit 1 with the quit message, nothing written, no launchctl calls", async () => {
  seedClients();
  for (const run of [install, uninstall]) {
    // Uninstall only blocks when it would change Desktop's config, so give it a groklink entry to remove.
    if (run === uninstall) {
      const d = json(P.desktop());
      d.mcpServers.groklink = GROKLINK;
      put(P.desktop(), d);
    }
    const before = snapshot();
    const { env, calls, out } = fakeEnv({ desktop: true });
    assert.equal(await run(env, { replaceGrokbotBridge: true }), 1);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(calls, []);
    assert.deepEqual(out, [
      "Quit Claude Desktop (Cmd+Q) first: it rewrites its config when it quits and would undo this change. Then run this command again.",
    ]);
  }
});

test("Claude Desktop running with --dry-run: the warning is printed, then the plan; exit 0", async () => {
  seedClients();
  const before = snapshot();
  const { env, calls, out } = fakeEnv({ desktop: true });
  assert.equal(await install(env, { dryRun: true }), 0);
  assert.match(out[0], /^Quit Claude Desktop \(Cmd\+Q\) first/);
  assert.ok(out.some((l) => l.startsWith("Dry run")));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(calls, []);
});

test("a slow bootout: bootstrap runs only after launchctl stops reporting the service", async () => {
  seedClients();
  const { env, calls } = fakeEnv({ stillLoaded: 3 });
  assert.equal(await install(env), 0);
  const launch = calls.filter((c) => c[0] === "launchctl").map((c) => c[1]);
  assert.deepEqual(launch, ["bootout", "print", "print", "print", "print", "bootstrap"]);
});

test("bootstrap fails once: it's retried and install succeeds", async () => {
  seedClients();
  const { env, calls } = fakeEnv({ bootstrapFails: 1 });
  assert.equal(await install(env), 0);
  assert.equal(calls.filter((c) => c[1] === "bootstrap").length, 2);
  assert.ok(json(P.desktop()).mcpServers.groklink);
});

test("bootstrap fails twice: exit 1 and the client configs are unchanged (old bridge entries kept, no backups)", async () => {
  seedBridge();
  const configs = [P.desktop(), P.claude(), P.codex()];
  const before = Object.fromEntries(configs.map((f) => [f, readFileSync(f, "utf8")]));
  const { env, calls, out } = fakeEnv({ bootstrapFails: 2 });
  assert.equal(await install(env, { replaceGrokbotBridge: true }), 1);
  for (const f of configs) {
    assert.equal(readFileSync(f, "utf8"), before[f], f);
    assert.ok(!existsSync(`${f}.bak`), `${f}.bak`);
  }
  assert.equal(calls.filter((c) => c[1] === "bootstrap").length, 2);
  assert.ok(!calls.some((c) => c[0] === "claude"));
  assert.ok(out.some((l) => /tried twice/.test(l) && /No client config was changed/.test(l)));
});

test("Claude Desktop running but its config already has groklink and nothing to remove: install proceeds, Desktop config untouched", async () => {
  seedClients();
  const d = json(P.desktop());
  d.mcpServers.groklink = GROKLINK;
  put(P.desktop(), d);
  const desktopBefore = readFileSync(P.desktop(), "utf8");
  const { env, out } = fakeEnv({ desktop: true });
  assert.equal(await install(env), 0);
  assert.equal(readFileSync(P.desktop(), "utf8"), desktopBefore);
  assert.ok(!existsSync(`${P.desktop()}.bak`));
  assert.ok(!out.some((l) => l.startsWith("Quit Claude Desktop")));
  assert.ok(json(P.cursor()).mcpServers.groklink, "other clients are still registered");
});

test("Claude Desktop running and its config has an old bridge entry to remove: still blocked", async () => {
  seedBridge();
  const d = json(P.desktop());
  d.mcpServers.groklink = GROKLINK;
  put(P.desktop(), d);
  const before = snapshot();
  const { env, calls, out } = fakeEnv({ desktop: true });
  assert.equal(await install(env, { replaceGrokbotBridge: true }), 1);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(calls, []);
  assert.ok(out.some((l) => l.startsWith("Quit Claude Desktop")));
});

test("uninstall with Claude Desktop running but no groklink entry in its config: proceeds without touching it", async () => {
  seedClients();
  await install(fakeEnv().env);
  const d = json(P.desktop());
  delete d.mcpServers.groklink;
  put(P.desktop(), d);
  const desktopBefore = readFileSync(P.desktop(), "utf8");
  const { env, out } = fakeEnv({ desktop: true });
  assert.equal(await uninstall(env), 0);
  assert.equal(readFileSync(P.desktop(), "utf8"), desktopBefore);
  assert.ok(!out.some((l) => l.startsWith("Quit Claude Desktop")));
  assert.ok(!json(P.cursor()).mcpServers.groklink, "other clients are still unregistered");
});
