import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Message, WaitResult } from "../src/base/bot.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, Jobs } from "../src/daemon/jobs.ts";
import { daemonMethods, startServer } from "../src/daemon/server.ts";
import { check, ensurePolicy, loadPolicy, type Rule } from "../src/shared/policy.ts";

const ALL_ON = { x_write: true, tx: true, wallet: true, claim: true };

const BLOCKED: [string, Rule][] = [
  ["post this on X", "x_write"],
  ["reply to @foo with this", "x_write"],
  ["Tweet the summary to X", "x_write"],
  ["Like and repost the latest post from @monad", "x_write"],
  ["follow @someone", "x_write"],
  ["Send a DM to @alice saying hi", "x_write"],
  ["publish the thread on Twitter", "x_write"],
  ["quote   that\nTWEET", "x_write"],
  ["sign the transaction", "tx"],
  ["Please approve the permit and broadcast it", "tx"],
  ["execute the swap on uniswap", "tx"],
  ["send 5 USDC via a transfer", "tx"],
  ["connect my wallet", "wallet"],
  ["Connect wallet to the site", "wallet"],
  ["here is my seed phrase: ...", "wallet"],
  ["use the private key in .env", "wallet"],
  ["submit the claim on poidh", "claim"],
  ["Submit my entry to poidh", "claim"],
  ["find the post and reply to @foo with this", "x_write"],
  ["please like this tweet", "x_write"],
  ["then repost it on X", "x_write"],
  ["can you dm @foo on x", "x_write"],
  ["Summarize it.\nPost the summary on X", "x_write"],
];

const ALLOWED = [
  "…its safety policy refusing … when asked to post on X",
  "Write a short note on Grok Link and its safety policy refusing a brief when asked to post on X.",
  "It refuses to reply to @foo on X.",
  "It won't post on X, and it blocks attempts to DM @foo on X.",
  "If asked to like a tweet, it never does.",
  "find posts on X about monad",
  "summarize this tweet: https://x.com/someone/status/123",
  "what are people saying on X about poidh claims",
  "read the replies to @someone's post",
  "Reply with the word pong and nothing else.",
  "Research the top 5 tweets about Base this week",
  "explain how transaction signatures work",
  "what is a wallet?",
  "list open poidh bounties",
  "summarize the claim process for this airdrop",
  "find out who posted this on X",
  "Draft a reply I could post later",
  "summarize the latest message on X about monad",
  "find posts like this on X",
  "what did people reply to @foo's post",
  "list the accounts that quote-posted this on X",
  "which posts on X got the most likes",
  "who followed @foo on X this week",
];

test("blocked examples hit their rule", () => {
  for (const [text, rule] of BLOCKED) assert.deepEqual(check(text, ALL_ON), { ok: false, rule }, text);
});

test("read-only examples pass", () => {
  for (const text of ALLOWED) assert.deepEqual(check(text, ALL_ON), { ok: true }, text);
});

test("a rule set to false lets its examples through, and only its examples", () => {
  for (const [text, rule] of BLOCKED) {
    assert.deepEqual(check(text, { ...ALL_ON, [rule]: false }), { ok: true }, text);
    for (const other of ["x_write", "tx", "wallet", "claim"].filter((r) => r !== rule))
      assert.deepEqual(check(text, { ...ALL_ON, [other]: false }), { ok: false, rule }, `${text} with ${other} off`);
  }
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glk-policy-"));
});
afterEach(() => {
  for (const j of open.splice(0)) j.close();
  rmSync(home, { recursive: true, force: true });
});

test("a missing or broken file, or missing keys, keep every rule on", () => {
  const file = join(home, "policy.json");
  const states: [string, string | null][] = [
    ["missing", null],
    ["broken", "{ not json"],
    ["not an object", "false"],
    ["empty object", "{}"],
    ["non-boolean", '{ "x_write": 0, "tx": "false" }'],
  ];
  for (const [name, content] of states) {
    rmSync(file, { force: true });
    if (content !== null) writeFileSync(file, content);
    for (const [text, rule] of BLOCKED) assert.deepEqual(check(text, loadPolicy(file)), { ok: false, rule }, `${name}: ${text}`);
  }
});

test("ensurePolicy writes the default file (0600) once and keeps an edited one", () => {
  const file = join(home, "policy.json");
  ensurePolicy(file);
  assert.equal(readFileSync(file, "utf8"), '{ "x_write": true, "tx": true, "wallet": true, "claim": true }\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, '{ "tx": false }');
  ensurePolicy(file);
  assert.equal(readFileSync(file, "utf8"), '{ "tx": false }');
});

// ---- in jobs ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 2000): Promise<void> {
  for (const t0 = Date.now(); !ok(); await sleep(5)) if (Date.now() - t0 > ms) throw new Error("timed out");
}
const reply = (key: string, text: string): Message => ({ key, role: "assistant", kind: "message", text, links: [], at: null });

const open: Jobs[] = [];
function setup() {
  const sent: string[] = [];
  const waits: ((r: Omit<WaitResult, "bot">) => void)[] = [];
  const layer: BotLayer = {
    find: async () => ({ id: "b1", name: "Alpha" }),
    async send(_botId, text) {
      sent.push(text);
      return `nonce_${sent.length}`;
    },
    read: async () => [],
    wait: () => new Promise((resolve) => waits.push((r) => resolve({ bot: "Alpha", ...r }))),
  };
  const j = new Jobs({
    dir: join(home, "jobs"),
    events: new EventLog(join(home, "events.jsonl")),
    layer,
    link: { connected: true },
    log: () => {},
    pollMs: 10,
  });
  open.push(j);
  j.start();
  return { j, sent, waits };
}

test("daemon start creates policy.json; a blocked brief creates no job and sends nothing", async () => {
  const { j, sent } = setup();
  assert.ok(existsSync(join(home, "policy.json")));
  for (const brief of ["post this on X", "sign the transaction"])
    await assert.rejects(j.create({ bot: "Alpha", brief }), { code: "blocked_by_policy", rule: brief.includes("X") ? "x_write" : "tx" });
  await sleep(30);
  assert.deepEqual(sent, []);
  assert.deepEqual(j.list(), []);
});

test("policy.json is read at start only: a later edit isn't applied, and health warns until a restart", async () => {
  const { j, sent } = setup();
  writeFileSync(join(home, "policy.json"), '{ "tx": false }');
  await until(() => j.policyState().warnings.includes("policy.json changed; restart groklinkd to apply"));
  await assert.rejects(j.create({ bot: "Alpha", brief: "sign the transaction" }), { code: "blocked_by_policy", rule: "tx" });
  assert.deepEqual(j.policyState().rules, { x_write: true, tx: true, wallet: true, claim: true });
  // After a restart the edit applies, and health says the rule is off.
  const restarted = setup();
  assert.deepEqual(restarted.j.policyState().rules, { x_write: true, tx: false, wallet: true, claim: true });
  assert.deepEqual(restarted.j.policyState().warnings, ["Safety rule tx is off (policy.json)."]);
  await restarted.j.create({ bot: "Alpha", brief: "sign the transaction" });
  await until(() => restarted.sent.length === 1);
  assert.deepEqual(sent, []);
});

test("a schema repair message that breaks a rule isn't sent; the job fails with the rule", async () => {
  const { j, sent, waits } = setup();
  const schema = { type: "object", properties: { word: { type: "string" } }, additionalProperties: false };
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with one word.", schema });
  await until(() => waits.length === 1);
  // The Bot's own key ends up in the repair text.
  waits[0]({ status: "done", messages: [reply("m1", '```json\n{"post this on x": 1}\n```')], elapsedMs: 1 });
  await until(() => (j.list()[0]?.status ?? "") === "failed");
  const job = await j.get({ jobId });
  assert.equal(sent.length, 1);
  assert.equal(job.error?.code, "blocked_by_policy");
  assert.equal(job.error?.rule, "x_write");
});

test("a blocked task over the socket returns rule as its own field", async () => {
  const { j, sent } = setup();
  const token = "cd".repeat(32);
  const socketPath = join(home, "s.sock");
  const link = {
    mode: "pipe" as const,
    connected: true,
    appVersion: null,
    requireCdp: () => {
      throw new Error("no CDP in this test");
    },
  };
  const server = await startServer({ socketPath, token, methods: daemonMethods(link, { jobs: j }), log: () => {} });
  try {
    const res = await new Promise<{ error?: Record<string, unknown> }>((resolve, reject) => {
      const c = createConnection(socketPath);
      let buf = "";
      c.setEncoding("utf8");
      c.on("error", reject);
      c.on("data", (d: string) => {
        buf += d;
        if (buf.includes("\n")) {
          c.destroy();
          resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
        }
      });
      c.write(`${JSON.stringify({ id: 1, token, method: "task", params: { bot: "Alpha", brief: "post this on X" } })}\n`);
    });
    assert.equal(res.error?.code, "blocked_by_policy");
    assert.equal(res.error?.rule, "x_write");
    assert.equal(typeof res.error?.message, "string");
    assert.deepEqual(sent, []);
  } finally {
    server.close();
  }
});
