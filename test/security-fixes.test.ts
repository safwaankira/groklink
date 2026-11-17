import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkDownloadDir } from "../src/base/bot.ts";
import { CDP, type CDPChannel } from "../src/base/cdp.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, checkAttachment, Jobs } from "../src/daemon/jobs.ts";
import { daemonMethods, guardSocket, PORT0_WARNING, startServer } from "../src/daemon/server.ts";
import { ensureState, statePaths } from "../src/daemon/state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !(await ok()); await sleep(10)) if (Date.now() - t0 > ms) throw new Error("timed out");
}

let root: string;
let home: string;
let stateHome: string;
const cleanup: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "glk-fix-"));
  home = join(root, "home");
  stateHome = join(root, "state");
  mkdirSync(home);
  mkdirSync(stateHome);
});
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  rmSync(root, { recursive: true, force: true });
});

const put = (p: string, text = "x") => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

// ---- step 1: routines get the policy ----

const ROUTINES = [
  {
    id: "r1",
    name: "Morning digest",
    prompt: "Post the digest on X every morning",
    trigger: "cron 0 9 * * *",
    enabled: false,
    lastRun: null,
  },
];
const BOTS = [
  {
    id: "b1",
    name: "Alpha",
    description: "",
    hidden: false,
    running: false,
    needsInput: false,
    unread: 0,
    lastActivity: null,
    preview: null,
  },
];

/** A page that answers the base Bot and routine reads, and records every evaluation. */
function fakePage() {
  const evals: string[] = [];
  let deliver: (text: string) => void = () => {};
  const channel: CDPChannel = {
    send(text) {
      const { id, params } = JSON.parse(text);
      const expr: string = params.expression ?? "";
      evals.push(expr);
      const value = /\.\.\.\["list",/.test(expr) ? { value: ROUTINES } : /\.\.\.\["run",/.test(expr) ? { value: ROUTINES[0] } : BOTS;
      queueMicrotask(() => deliver(JSON.stringify({ id, result: { result: { type: "object", value } } })));
    },
    onMessage(cb) {
      deliver = cb;
    },
    close() {},
  };
  return { cdp: new CDP(channel), evals };
}

function methodsWithPolicy() {
  const layer: BotLayer = {
    find: async () => ({ id: "b1", name: "Alpha" }),
    send: async () => "k",
    read: async () => [],
    wait: () => new Promise(() => {}),
  };
  const jobs = new Jobs({
    dir: join(stateHome, "jobs"),
    events: new EventLog(join(stateHome, "events.jsonl")),
    layer,
    link: { connected: true },
    log: () => {},
    home,
  });
  jobs.start();
  cleanup.push(() => jobs.close());
  const page = fakePage();
  const methods = daemonMethods({ mode: "pipe", connected: true, appVersion: "1.2.0", requireCdp: () => page.cdp }, { jobs });
  return { methods, page };
}

test("routines: add with a blocked prompt or name is refused with the rule, and nothing reaches the page", async () => {
  const { methods, page } = methodsWithPolicy();
  await assert.rejects(
    async () => methods.routines({ action: "add", bot: "Alpha", name: "digest", schedule: "0 * * * *", prompt: "post this on X" }),
    { code: "blocked_by_policy", rule: "x_write" },
  );
  await assert.rejects(
    async () =>
      methods.routines({ action: "add", bot: "Alpha", name: "sign the transaction", schedule: "0 * * * *", prompt: "Summarize my inbox" }),
    { code: "blocked_by_policy", rule: "tx" },
  );
  // Look-alike letters are normalized here too.
  await assert.rejects(
    async () => methods.routines({ action: "add", bot: "Alpha", name: "d", schedule: "0 * * * *", prompt: "pоst this on X" }),
    { code: "blocked_by_policy" },
  );
  assert.deepEqual(page.evals, []);
});

test("routines: enable and run check the routine name and its stored prompt; nothing is run or sent", async () => {
  const { methods, page } = methodsWithPolicy();
  await assert.rejects(async () => methods.routines({ action: "enable", bot: "Alpha", routine: "post this on X" }), {
    code: "blocked_by_policy",
  });
  await assert.rejects(async () => methods.routines({ action: "enable", bot: "Alpha", routine: "Morning digest" }), {
    code: "blocked_by_policy",
    rule: "x_write",
  });
  await assert.rejects(async () => methods.routines({ action: "run", bot: "Alpha", routine: "Morning digest" }), {
    code: "blocked_by_policy",
    rule: "x_write",
  });
  assert.ok(!page.evals.some((e) => /\.\.\.\["run",/.test(e)), "no routine was run");
  assert.ok(!page.evals.some((e) => /sendPrompt|journal/.test(e)), "no message was sent");
});

// ---- step 2: download folders ----

test("download folders: ~/.ssh, ~/Library/LaunchAgents and /tmp are refused; the default roots are allowed", () => {
  const ctx = { home, stateHome };
  for (const d of [join(home, ".ssh"), join(home, "Library/LaunchAgents"), "/tmp", join(home, "Documents"), join(home, ".config/x")])
    assert.throws(() => checkDownloadDir(d, ctx), { code: "dir_blocked" }, d);
  assert.doesNotThrow(() => checkDownloadDir(join(stateHome, "downloads", "Alpha"), ctx));
  assert.doesNotThrow(() => checkDownloadDir(join(home, "Downloads/groklink"), ctx));
  assert.doesNotThrow(() => checkDownloadDir(join(home, "Downloads/groklink/project"), ctx));
  // Nothing is created by the check.
  assert.throws(() => statSync(join(stateHome, "downloads")));
});

test("download folders: dot-folders below a root, symlinks out of a root, and listed roots in dot-folders or ~/Library are refused", () => {
  const ctx = { home, stateHome };
  assert.throws(() => checkDownloadDir(join(home, "Downloads/groklink/.hidden"), ctx), { code: "dir_blocked" });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(stateHome, "downloads"), { recursive: true });
  symlinkSync(join(home, ".ssh"), join(stateHome, "downloads", "Alpha"));
  assert.throws(() => checkDownloadDir(join(stateHome, "downloads", "Alpha"), ctx), { code: "dir_blocked" });
  const projects = join(home, "Projects/out");
  writeFileSync(
    join(stateHome, "download-roots.json"),
    JSON.stringify([projects, join(home, ".config/out"), join(home, "Library/LaunchAgents")]),
  );
  assert.doesNotThrow(() => checkDownloadDir(projects, ctx));
  assert.throws(() => checkDownloadDir(join(home, ".config/out"), ctx), { code: "dir_blocked" });
  assert.throws(() => checkDownloadDir(join(home, "Library/LaunchAgents"), ctx), { code: "dir_blocked" });
  writeFileSync(join(stateHome, "download-roots.json"), "{ nope");
  assert.throws(() => checkDownloadDir(projects, ctx), { code: "dir_blocked" });
});

test("download: groklink_download with out_dir in ~/Library/LaunchAgents is refused before anything is fetched or created", async () => {
  const { methods, page } = methodsWithPolicy();
  await assert.rejects(async () => methods.download({ bot: "Alpha", out_dir: join(home, "Library/LaunchAgents") }), {
    code: "dir_blocked",
  });
  assert.throws(() => statSync(join(home, "Library")));
  assert.ok(!page.evals.some((e) => /readAttachmentBytes/.test(e)), "no file was read from the Bot");
});

// ---- step 3: more denylist entries ----

test("attachments: every new denylist folder and file pattern is refused", () => {
  const paths = [
    ".docker/config.json",
    ".git-credentials",
    ".config/gh/hosts.yml",
    ".config/solana/id.json",
    ".foundry/keystores/deployer",
    ".ethereum/keystore/UTC--2026",
    ".local/share/keyrings/login.keyring",
    "Library/Cookies/Cookies.binarycookies",
    "Library/Application Support/Google/Chrome/Default/Login Data",
    "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
    "Library/Application Support/Firefox/Profiles/x/logins.json",
    "Library/Application Support/Arc/User Data/Default/Cookies",
    "Library/Application Support/Microsoft Edge/Default/Cookies",
    "Library/Safari/History.db",
    "Library/Messages/chat.db",
    "Library/Mail/V10/x.emlx",
    "work/release.keystore",
    "work/my-keypair.json",
    "work/cert.p12",
    "work/cert.pfx",
    "work/wallet-mnemonic.txt",
    "work/seed_phrase.txt",
    "work/my seed phrase backup.txt",
    "work/.git-credentials",
  ].map((p) => put(join(home, p)));
  for (const f of paths) assert.throws(() => checkAttachment(f, { home, stateHome }), { code: "file_blocked" }, f);
  assert.doesNotThrow(() => checkAttachment(put(join(home, "work/notes.txt")), { home, stateHome }));
});

// ---- step 4: socket replacement ----

function raw(socketPath: string, line: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const c = createConnection(socketPath);
    let buf = "";
    c.setEncoding("utf8");
    c.on("error", () => resolve(null));
    c.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        c.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    c.on("close", () => resolve(null));
    c.write(line);
  });
}

test("socket guard: a replaced socket file is noticed, the daemon listens again, and the token never reaches the impostor afterwards", async () => {
  const paths = statePaths(stateHome);
  const { token } = ensureState(paths);
  const logs: string[] = [];
  const start = () => startServer({ socketPath: paths.socket, token, methods: { health: () => ({ ok: true }) }, log: () => {} });
  const guard = guardSocket({ socketPath: paths.socket, server: await start(), start, log: (l) => logs.push(l), everyMs: 20 });
  cleanup.push(() => {
    guard.stop();
    guard.server.close();
  });
  unlinkSync(paths.socket);
  const seen: string[] = [];
  const impostor: Server = createServer((c) => c.on("data", (d) => seen.push(String(d))));
  await new Promise<void>((r) => impostor.listen(paths.socket, r));
  cleanup.push(() => impostor.close());
  await until(() => logs.includes("socket replaced; recreating"));
  await until(async () => (await raw(paths.socket, `${JSON.stringify({ id: 1, token, method: "health" })}\n`))?.result !== undefined);
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
  assert.deepEqual(seen, [], "no request reached the replacement socket");
});

test("socket guard: a loosened mode (0644) is put right by listening again", async () => {
  const paths = statePaths(stateHome);
  const { token } = ensureState(paths);
  const logs: string[] = [];
  const start = () => startServer({ socketPath: paths.socket, token, methods: { health: () => ({ ok: true }) }, log: () => {} });
  const guard = guardSocket({ socketPath: paths.socket, server: await start(), start, log: (l) => logs.push(l), everyMs: 20 });
  cleanup.push(() => {
    guard.stop();
    guard.server.close();
  });
  chmodSync(paths.socket, 0o644);
  const modeIs600 = () => {
    try {
      return (statSync(paths.socket).mode & 0o777) === 0o600;
    } catch {
      return false; // mid-recreate
    }
  };
  await until(() => logs.includes("socket replaced; recreating") && modeIs600());
  assert.ok((await raw(paths.socket, `${JSON.stringify({ id: 2, token, method: "health" })}\n`))?.result);
});

// ---- step 5: port0 warning ----

test("health: port0 mode carries the debug-port warning; pipe mode has none", () => {
  const link = (mode: "pipe" | "port0") => ({ mode, connected: true, appVersion: "1.2.0", requireCdp: () => fakePage().cdp });
  const h0 = daemonMethods(link("port0")).health({}) as { mode: string; warnings: string[] };
  assert.equal(h0.mode, "port0");
  assert.deepEqual(h0.warnings, [PORT0_WARNING]);
  assert.equal(PORT0_WARNING, "Debug port fallback in use: local processes can reach Grok Bot while it runs.");
  assert.deepEqual((daemonMethods(link("pipe")).health({}) as { warnings: string[] }).warnings, []);
});

test("attachments: a different letter case doesn't get past the rules (macOS disks ignore case)", () => {
  const key = put(join(home, ".aws/credentials"));
  put(join(home, ".config/gh/hosts.yml"));
  put(join(home, "Library/Keychains/login.keychain-db"));
  const variants = [
    join(home, ".AWS/credentials"),
    join(home, ".config/GH/hosts.yml"),
    join(home, "LIBRARY/Keychains/login.keychain-db"),
    join(home, ".Aws/Credentials"),
  ];
  assert.throws(() => checkAttachment(key, { home, stateHome }), { code: "file_blocked" });
  for (const v of variants) assert.throws(() => checkAttachment(v, { home, stateHome }), { code: "file_blocked" }, v);
});

test("download folders: a different letter case of an allowed root is allowed, and of ~/Library is still refused", () => {
  mkdirSync(join(home, "Downloads/groklink"), { recursive: true });
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  const ctx = { home, stateHome };
  assert.doesNotThrow(() => checkDownloadDir(join(home, "downloads/GROKLINK"), ctx));
  assert.throws(() => checkDownloadDir(join(home, "LIBRARY/LaunchAgents"), ctx), { code: "dir_blocked" });
});

test("routines: a schedule carrying a blocked instruction is refused", async () => {
  const { methods, page } = methodsWithPolicy();
  await assert.rejects(
    async () => methods.routines({ action: "add", bot: "Alpha", name: "digest", schedule: "post this on X", prompt: "Summarize my inbox" }),
    { code: "blocked_by_policy", rule: "x_write" },
  );
  assert.deepEqual(page.evals, []);
});
