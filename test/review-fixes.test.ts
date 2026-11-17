import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { quarantine, safeFileName } from "../src/base/bot.ts";
import { CDP, type CDPChannel } from "../src/base/cdp.ts";
import { type InstallEnv, plist } from "../src/client/install.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, checkAttachment, Jobs, policyText } from "../src/daemon/jobs.ts";
import { daemonMethods } from "../src/daemon/server.ts";
import { check } from "../src/shared/policy.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !ok(); await sleep(10)) if (Date.now() - t0 > ms) throw new Error("timed out");
}

let root: string;
let home: string;
let stateHome: string;
const open: Jobs[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "glk-rev-"));
  home = join(root, "home");
  stateHome = join(root, "state");
  mkdirSync(home);
  mkdirSync(stateHome);
});
afterEach(() => {
  for (const j of open.splice(0)) j.close();
  rmSync(root, { recursive: true, force: true });
});

const put = (p: string, data: string | Buffer = "x") => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
};

function jobsWith() {
  const sent: string[] = [];
  const layer: BotLayer = {
    find: async () => ({ id: "b1", name: "Alpha" }),
    async send(_b, brief) {
      sent.push(brief);
      return `k${sent.length}`;
    },
    read: async () => [],
    wait: () => new Promise(() => {}),
  };
  const j = new Jobs({
    dir: join(stateHome, "jobs"),
    events: new EventLog(join(stateHome, "events.jsonl")),
    layer,
    link: { connected: true },
    log: () => {},
    home,
    pollMs: 10,
  });
  open.push(j);
  j.start();
  return { j, sent };
}

// ---- step 1: policy coverage ----

const BLOCKED: [string, string][] = [
  ["Post the daily market summary you wrote this morning on X.", "x_write"],
  ["Share this thread on X from my account.", "x_write"],
  ["Sign the pending approval request from the bridge contract sitting in my wallet transaction queue.", "tx"],
  ["upload this video to X", "x_write"],
  ["boost this post on my timeline", "x_write"],
  ["Thread these notes on my profile", "x_write"],
  ["please amplify @foo", "x_write"],
  ["send this to @alice", "x_write"],
  ["confirm the pending transaction", "tx"],
  ["authorize the contract call", "tx"],
  ["accept the bridge transfer", "tx"],
  ["The transaction is ready, sign it.", "tx"],
];

const ALLOWED = [
  "summarize the pending transactions on this wallet",
  "who shared this thread on X",
  "find threads on X about MCP servers",
  "summarize the replies on my timeline",
  "what did people post on my profile this week",
  "explain what this contract call does",
  "how do token approvals work",
  "check whether this wallet has any pending transactions",
  "list the bridges with the most volume this week",
  "find the transaction hash for this swap",
  "send me a summary of my wallet activity",
  "Can you confirm whether this wallet belongs to a known exchange?",
  "find accounts that amplify scam posts on X",
];

test("policy: the reviewer's sentences and the new verbs and targets are blocked", () => {
  for (const [t, rule] of BLOCKED) assert.deepEqual(check(policyText(t), {}), { ok: false, rule }, t);
});

test("policy: read-only X and crypto requests still pass", () => {
  for (const t of ALLOWED) assert.deepEqual(check(policyText(t), {}), { ok: true }, t);
});

// ---- step 2: attachment contents ----

test("attachments: a text file whose contents break a rule is refused, naming the file; nothing is sent", async () => {
  const { j, sent } = jobsWith();
  const plan = put(join(home, "work/plan.txt"), "Step 1: research.\nStep 2: post this on X.");
  await assert.rejects(
    j.create({ bot: "Alpha", brief: "Do what plan.txt says.", files: [plan] }),
    (e: Error & { code?: string; rule?: string }) => {
      assert.equal(e.code, "blocked_by_policy");
      assert.equal(e.rule, "x_write");
      assert.match(e.message, /in attachment plan\.txt/);
      return true;
    },
  );
  for (const ext of ["md", "json", "csv", "html"]) {
    const f = put(join(home, `work/plan.${ext}`), "sign the transaction");
    await assert.rejects(j.create({ bot: "Alpha", brief: "Summarize it.", files: [f] }), { code: "blocked_by_policy", rule: "tx" }, ext);
  }
  assert.deepEqual(sent, []);
});

test("attachments: other types, files over 1 MB and non-UTF-8 files aren't read; clean text files pass", async () => {
  const { j, sent } = jobsWith();
  const files = [
    put(join(home, "work/scan.pdf"), "post this on X"),
    put(join(home, "work/big.txt"), `${"a ".repeat(600 * 1024)}post this on X`),
    put(join(home, "work/latin1.txt"), Buffer.from([0x70, 0x6f, 0x73, 0x74, 0x20, 0xff, 0xfe, 0x20])),
    put(join(home, "work/notes.md"), "Research notes about MCP."),
  ];
  for (const f of files) await j.create({ bot: "Alpha", brief: "Summarize it.", files: [f] });
  await until(() => sent.length === 1);
});

// ---- step 3: tampering ----

test("health shows each rule on/off and warns when policy.json changes after start (the change isn't applied)", async () => {
  const { j } = jobsWith();
  const methods = daemonMethods(
    { mode: "pipe", connected: true, appVersion: "1.2.0", requireCdp: () => new CDP({ send() {}, onMessage() {}, close() {} }) },
    { jobs: j },
  );
  const health = () => methods.health({}) as { policy: Record<string, boolean>; warnings: string[] };
  assert.deepEqual(health().policy, { x_write: true, tx: true, wallet: true, claim: true });
  assert.deepEqual(health().warnings, []);
  writeFileSync(join(stateHome, "policy.json"), '{ "x_write": false }');
  await until(() => health().warnings.includes("policy.json changed; restart groklinkd to apply"));
  assert.equal(health().policy.x_write, true, "the edit isn't applied");
  await assert.rejects(j.create({ bot: "Alpha", brief: "post this on X" }), { code: "blocked_by_policy" });
});

// ---- step 4: more denylist entries ----

test("attachments: the new denylist entries are refused", () => {
  const paths = [
    ".claude.json",
    ".claude/settings.json",
    ".codex/auth.json",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".pypirc",
    ".azure/accessTokens.json",
    ".zsh_history",
    ".bash_history",
    ".local/share/fish/fish_history",
    "Library/Application Support/Grok Bot/Cookies",
    "Library/Application Support/Exodus/exodus.wallet/seed.seco",
    "Library/Application Support/atomic/Local Storage/x",
    "Library/Application Support/Electrum/wallets/default_wallet",
    "Library/Application Support/Phantom/x",
    "Library/Application Support/MetaMask/x",
    "Library/Application Support/Rabby/x",
    "Library/Application Support/Ledger Live/app.json",
  ].map((p) => put(join(home, p)));
  for (const f of paths) assert.throws(() => checkAttachment(f, { home, stateHome }), { code: "file_blocked" }, f);
  assert.doesNotThrow(() => checkAttachment(put(join(home, ".cargo/config.toml")), { home, stateHome }));
});

// ---- step 5: download names and quarantine ----

test("download names: format characters (U+202E…) are removed and launchers get .download", () => {
  assert.equal(safeFileName("invoice‮fdp.terminal"), "invoicefdp.terminal.download");
  assert.equal(safeFileName("a​b﻿⁦.txt"), "ab.txt");
  for (const ext of [
    ".app",
    ".command",
    ".terminal",
    ".tool",
    ".sh",
    ".pkg",
    ".dmg",
    ".scpt",
    ".applescript",
    ".workflow",
    ".webloc",
    ".inetloc",
    ".fileloc",
    ".jar",
  ])
    assert.equal(safeFileName(`x${ext}`), `x${ext}.download`, ext);
  assert.equal(safeFileName("x.COMMAND"), "x.COMMAND.download");
  assert.equal(safeFileName("report.pdf"), "report.pdf");
});

test("quarantine: sets com.apple.quarantine on macOS; a failure is reported, not thrown", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS only");
  const calls: string[][] = [];
  assert.equal(
    await quarantine("/x/a.pdf", async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "" };
    }),
    true,
  );
  assert.equal(calls[0][0], "xattr");
  assert.deepEqual(calls[0].slice(1, 3), ["-w", "com.apple.quarantine"]);
  assert.match(calls[0][3], /^0081;[0-9a-f]+;GrokLink;$/);
  assert.equal(calls[0][4], "/x/a.pdf");
  assert.equal(
    await quarantine("/x/a.pdf", async () => {
      throw new Error("no xattr");
    }),
    false,
  );
});

// ---- step 6: install never saves GROKLINK_TRANSPORT ----

test("install: GROKLINK_TRANSPORT is never written into the LaunchAgent", () => {
  const env = { home, stateHome, uid: 501, node: "/n", cli: "/c/groklink.js" } as unknown as InstallEnv;
  const before = process.env.GROKLINK_TRANSPORT;
  process.env.GROKLINK_TRANSPORT = "port0";
  try {
    assert.ok(!plist(env).includes("GROKLINK_TRANSPORT"));
    assert.ok(!plist(env).includes("port0"));
  } finally {
    if (before === undefined) delete process.env.GROKLINK_TRANSPORT;
    else process.env.GROKLINK_TRANSPORT = before;
  }
});

// ---- step 7: event retention and untrusted flags ----

test("events: entries older than 7 days are pruned atomically, and seq keeps increasing after a restart", () => {
  const file = join(stateHome, "events.jsonl");
  const old = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
  appendFileSync(file, `${JSON.stringify({ seq: 1, at: old, jobId: null, bot: "Alpha", type: "message", text: "old secret" })}\n`);
  appendFileSync(file, `${JSON.stringify({ seq: 2, at: old, jobId: null, bot: "Alpha", type: "message", text: "old secret 2" })}\n`);
  const log = new EventLog(file);
  log.append({ jobId: null, bot: "Alpha", type: "message", text: "new" });
  assert.equal(log.prune(7 * 24 * 3_600_000), 2);
  assert.deepEqual(
    log.since(0).map((e) => [e.seq, e.text]),
    [[3, "new"]],
  );
  // Everything old: the newest event stays as a seq anchor, without its text.
  const file2 = join(stateHome, "events2.jsonl");
  appendFileSync(file2, `${JSON.stringify({ seq: 41, at: old, jobId: null, bot: "Alpha", type: "message", text: "old secret" })}\n`);
  new EventLog(file2).prune(7 * 24 * 3_600_000);
  assert.ok(!readFileSync(file2, "utf8").includes("old secret"));
  assert.equal(new EventLog(file2).append({ jobId: null, bot: "Alpha", type: "working" }).seq, 42);
});

test("events and routines: Bot text comes back flagged untrusted", async () => {
  const events = new EventLog(join(stateHome, "events.jsonl"));
  events.append({ jobId: null, bot: "Alpha", type: "message", text: "hello" });
  events.append({ jobId: null, bot: "Alpha", type: "working" });
  const ROUTINES = [{ id: "r1", name: "Digest", prompt: "Summarize my inbox", trigger: "cron 0 9 * * *", enabled: true, lastRun: null }];
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
  let deliver: (t: string) => void = () => {};
  const channel: CDPChannel = {
    send(text) {
      const { id, params } = JSON.parse(text);
      const value = /\.\.\.\["list",/.test(params.expression) ? { value: ROUTINES } : BOTS;
      queueMicrotask(() => deliver(JSON.stringify({ id, result: { result: { type: "object", value } } })));
    },
    onMessage(cb) {
      deliver = cb;
    },
    close() {},
  };
  const cdp = new CDP(channel);
  const methods = daemonMethods({ mode: "pipe", connected: true, appVersion: "1.2.0", requireCdp: () => cdp }, { events });
  const evs = (await methods.events({})) as { type: string; untrusted?: boolean }[];
  assert.equal(evs.find((e) => e.type === "message")?.untrusted, true);
  assert.equal(evs.find((e) => e.type === "working")?.untrusted, undefined);
  const list = (await methods.routines({ action: "list", bot: "Alpha" })) as { untrusted?: boolean; routines: unknown[] };
  assert.equal(list.untrusted, true);
  assert.equal(list.routines.length, 1);
  const bots = (await methods.bots({})) as { untrusted?: boolean }[];
  assert.equal(bots[0].untrusted, true);
});
