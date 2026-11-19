import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Message, Usage, WaitResult } from "../src/base/bot.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, type Job, Jobs, type JobsOptions, SLEEP_WARNING, usageOut } from "../src/daemon/jobs.ts";
import { daemonMethods } from "../src/daemon/server.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (const t0 = Date.now(); !check(); await sleep(5)) if (Date.now() - t0 > ms) throw new Error("timed out");
}

const reply = (key: string, text: string): Message => ({ key, role: "assistant", kind: "message", text, links: [], at: null });
const userMessage = (key: string, text: string): Message => ({ key, role: "user", kind: "message", text, links: [], at: null });

type WaitCall = { botId: string; since?: string; onUpdate: (m: Message) => void; resolve: (r: Omit<WaitResult, "bot">) => void };

/** A Bot layer whose waits stay open until the test resolves them. */
function fakeLayer() {
  const bots = [
    { id: "b1", name: "Alpha" },
    { id: "b2", name: "Beta" },
  ];
  const sent: { botId: string; brief: string }[] = [];
  const waits: WaitCall[] = [];
  const reads: { botId: string; since: string }[] = [];
  /** What `read` returns: the messages after `since` in the Bot's conversation. */
  const after: Message[] = [];
  /** When set, `send` waits for this before it resolves. */
  const gate: { open?: Promise<void> } = {};
  const layer: BotLayer = {
    async find(q) {
      const b = bots.find((x) => x.id === q || x.name === q);
      if (!b) throw new Error(`No Bot named "${q}".`);
      return b;
    },
    async send(botId, brief) {
      sent.push({ botId, brief });
      const n = sent.length;
      await gate.open;
      return `nonce_${n}`;
    },
    async read(botId, since) {
      reads.push({ botId, since });
      return after;
    },
    wait(botId, opts) {
      return new Promise((resolve) =>
        waits.push({ botId, since: opts.since, onUpdate: opts.onUpdate, resolve: (r) => resolve({ bot: botId, ...r }) }),
      );
    },
  };
  return { layer, sent, waits, reads, after, gate };
}

let home: string;
let fake: ReturnType<typeof fakeLayer>;
let events: EventLog;
const open: Jobs[] = [];

function jobs(extra: Partial<JobsOptions> = {}): Jobs {
  const j = new Jobs({
    dir: join(home, "jobs"),
    events,
    layer: fake.layer,
    link: { connected: true },
    log: () => {},
    pollMs: 10,
    ...extra,
  });
  open.push(j);
  j.start();
  return j;
}

const file = (jobId: string): Job => JSON.parse(readFileSync(join(home, "jobs", `${jobId}.json`), "utf8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glk-jobs-"));
  fake = fakeLayer();
  events = new EventLog(join(home, "events.jsonl"));
});

afterEach(() => {
  for (const j of open.splice(0)) j.close();
  rmSync(home, { recursive: true, force: true });
});

test("create → working → done, with untrusted messages and events", async () => {
  const j = jobs();
  const { jobId, status } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  assert.match(jobId, /^j_[0-9a-f]{12}$/);
  assert.equal(status, "queued");
  await until(() => file(jobId).status === "working");
  const saved = file(jobId);
  assert.equal(saved.status, "working");
  assert.equal(saved.briefKey, "nonce_1");
  assert.equal(saved.attempts, 1);
  await until(() => fake.waits.length === 1);
  const w = fake.waits[0];
  assert.equal(w.since, "nonce_1");
  const pending = j.get({ jobId, wait_seconds: 5 });
  w.onUpdate(reply("m1", "pong"));
  w.resolve({ status: "done", messages: [reply("m1", "pong")], elapsedMs: 10 });
  const done = await pending;
  assert.equal(done.status, "done");
  assert.equal(done.messages.length, 1);
  assert.equal(done.messages[0].text, "pong");
  assert.equal(done.messages[0].untrusted, true);
  assert.equal(file(jobId).status, "done");
  const evs = events.since(0, 50);
  assert.deepEqual(
    evs.map((e) => e.type),
    ["working", "message", "done"],
  );
  assert.deepEqual(
    evs.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    events.since(2, 50).map((e) => e.type),
    ["done"],
  );
  assert.deepEqual(j.list("done"), [{ jobId, bot: "Alpha", status: "done", updatedAt: done.updatedAt }]);
});

test("the event log restores its last seq on start", () => {
  events.append({ jobId: null, bot: "Alpha", type: "idle" });
  events.append({ jobId: null, bot: "Alpha", type: "working" });
  const again = new EventLog(join(home, "events.jsonl"));
  assert.equal(again.append({ jobId: null, bot: "Alpha", type: "idle" }).seq, 3);
});

test("an unknown Bot is not_found and nothing is sent", async () => {
  await assert.rejects(jobs().create({ bot: "Nope", brief: "hi" }), { code: "not_found" });
  assert.equal(fake.sent.length, 0);
});

test("on restart, unfinished jobs are reloaded and their waiters restarted", async () => {
  const first = jobs();
  const { jobId } = await first.create({ bot: "Alpha", brief: "one" });
  await until(() => fake.waits.length === 1);
  first.close();
  // A fresh daemon on the same folder picks the job up without resending the brief.
  const second = jobs();
  await until(() => fake.waits.length === 2);
  assert.equal(fake.waits[1].since, "nonce_1");
  assert.equal(fake.sent.length, 1);
  fake.waits[1].resolve({ status: "done", messages: [reply("m1", "ok")], elapsedMs: 1 });
  await until(() => file(jobId).status === "done");
  assert.equal((await second.get({ jobId })).messages[0].text, "ok");
});

test("waiters restart after a reconnect", async () => {
  const link = { connected: true };
  const j = jobs({ link, retryMs: 10 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "one" });
  await until(() => fake.waits.length === 1);
  link.connected = false;
  await sleep(30);
  link.connected = true;
  // The old wait is still open, so the reconnect doesn't start a second one for the same job.
  await sleep(30);
  assert.equal(fake.waits.length, 1);
  fake.waits[0].resolve({ status: "needs_input", messages: [], elapsedMs: 1 });
  await until(() => file(jobId).status === "needs_input");
  link.connected = false;
  await sleep(30);
  link.connected = true;
  await until(() => fake.waits.length === 2);
  fake.waits[1].resolve({ status: "done", messages: [reply("m1", "ok")], elapsedMs: 1 });
  await until(() => file(jobId).status === "done");
});

test("two jobs on one Bot queue; different Bots run at once", async () => {
  const j = jobs();
  const a = await j.create({ bot: "Alpha", brief: "first" });
  const b = await j.create({ bot: "Alpha", brief: "second" });
  const c = await j.create({ bot: "Beta", brief: "other" });
  assert.equal(b.status, "queued");
  await until(() => fake.waits.length === 2);
  assert.equal(file(a.jobId).status, "working");
  assert.equal(file(c.jobId).status, "working");
  assert.equal(file(b.jobId).status, "queued");
  assert.equal(file(b.jobId).briefKey, null);
  assert.deepEqual(
    fake.sent.map((s) => s.brief),
    ["first", "other"],
  );
  // wait_seconds returns at once for a job that isn't working.
  assert.equal((await j.get({ jobId: b.jobId, wait_seconds: 5 })).status, "queued");
  fake.waits[0].resolve({ status: "done", messages: [reply("m1", "ok")], elapsedMs: 1 });
  await until(() => fake.sent.length === 3);
  assert.equal(fake.sent[2].brief, "second");
  await until(() => file(b.jobId).status === "working");
  assert.equal(file(b.jobId).briefKey, "nonce_3");
});

test("task replies before the send resolves; working with briefKey once it does", async () => {
  let release = () => {};
  // A send that takes 5 s unless the test lets it finish sooner.
  fake.gate.open = new Promise<void>((r) => {
    const timer = setTimeout(r, 5000);
    release = () => {
      clearTimeout(timer);
      r();
    };
  });
  const j = jobs();
  const t0 = Date.now();
  const { jobId, status } = await j.create({ bot: "Alpha", brief: "one" });
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.equal(status, "queued");
  assert.equal(fake.sent.length, 1);
  assert.equal(file(jobId).status, "queued");
  assert.equal(file(jobId).briefKey, null);
  // A second task on the same Bot queues behind the one being sent.
  const second = await j.create({ bot: "Alpha", brief: "two" });
  assert.equal(fake.sent.length, 1);
  // job with wait_seconds keeps waiting while the brief is being sent.
  const pending = j.get({ jobId, wait_seconds: 5 });
  release();
  await until(() => file(jobId).status === "working");
  assert.equal(file(jobId).briefKey, "nonce_1");
  await until(() => fake.waits.length === 1);
  fake.waits[0].resolve({ status: "done", messages: [reply("m1", "pong")], elapsedMs: 1 });
  assert.equal((await pending).status, "done");
  await until(() => file(second.jobId).status === "working");
});

test("a failed send marks the job failed with the error", async () => {
  fake.layer.send = async () => {
    throw new Error("send journal rejected the prompt");
  };
  const j = jobs();
  const { jobId, status } = await j.create({ bot: "Alpha", brief: "one" });
  assert.equal(status, "queued");
  await until(() => file(jobId).status === "failed");
  assert.deepEqual(file(jobId).error, { code: "internal", message: "send journal rejected the prompt" });
  assert.equal(events.since(0, 50).at(-1)?.type, "failed");
});

test("a needs_input job isn't re-followed on reload once a newer user message exists", async () => {
  const first = jobs();
  const { jobId } = await first.create({ bot: "Alpha", brief: "one" });
  await until(() => fake.waits.length === 1);
  fake.waits[0].resolve({ status: "needs_input", messages: [reply("m1", "Which one?")], elapsedMs: 1 });
  await until(() => file(jobId).status === "needs_input");
  first.close();
  // Someone answered the Bot in the app while the daemon was down.
  fake.after.push(reply("m1", "Which one?"), userMessage("u2", "the blue one"));
  jobs();
  await until(() => fake.reads.length === 1);
  assert.deepEqual(fake.reads[0], { botId: "b1", since: "nonce_1" });
  await sleep(50);
  assert.equal(fake.waits.length, 1);
  assert.equal(file(jobId).status, "needs_input");
});

test("a quiet Bot makes the job stale; resume restarts its waiter", async () => {
  const j = jobs({ staleMs: 50 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "long research" });
  await until(() => fake.waits.length === 1);
  fake.waits[0].resolve({ status: "timeout", messages: [], elapsedMs: 1 });
  // Not quiet long enough yet: the waiter waits again.
  await until(() => fake.waits.length === 2);
  await sleep(60);
  fake.waits[1].resolve({ status: "timeout", messages: [], elapsedMs: 1 });
  await until(() => file(jobId).status === "stale");
  assert.equal(events.since(0, 50).at(-1)?.type, "idle");
  await assert.rejects(j.get({ jobId: "j_000000000000", resume: true }), { code: "not_found" });
  const resumed = await j.get({ jobId, resume: true });
  assert.equal(resumed.status, "working");
  await until(() => fake.waits.length === 3);
  assert.equal(fake.waits[2].since, "nonce_1");
  fake.waits[2].resolve({ status: "done", messages: [reply("m9", "found it")], elapsedMs: 1 });
  await until(() => file(jobId).status === "done");
  assert.equal(file(jobId).messages[0].text, "found it");
  await assert.rejects(j.get({ jobId, resume: true }), { code: "bad_request" });
});

test("job files older than 7 days are deleted at start", () => {
  const dir = join(home, "jobs");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "j_aaaaaaaaaaaa.json");
  const fresh = join(dir, "j_bbbbbbbbbbbb.json");
  const other = join(dir, "notes.txt");
  for (const f of [old, fresh, other]) writeFileSync(f, JSON.stringify({ status: "done" }));
  const eightDaysAgo = (Date.now() - 8 * 24 * 3_600_000) / 1000;
  utimesSync(old, eightDaysAgo, eightDaysAgo);
  utimesSync(other, eightDaysAgo, eightDaysAgo);
  jobs();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(other), true);
});

test("bad job ids are rejected", async () => {
  await assert.rejects(jobs().get({ jobId: "../token" }), { code: "bad_request" });
});

test("idle with no reply isn't done: the waiter keeps waiting from the brief's key", async () => {
  const j = jobs({ retryMs: 5 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.waits.length === 1);
  fake.waits[0].resolve({ status: "done", messages: [], elapsedMs: 1 });
  await until(() => fake.waits.length === 2);
  assert.equal(fake.waits[1].since, "nonce_1");
  assert.equal(file(jobId).status, "working");
  assert.ok(!events.since(0, 50).some((e) => e.type === "done"));
});

test("a reply after an empty idle makes the job done", async () => {
  const j = jobs({ retryMs: 5 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.waits.length === 1);
  fake.waits[0].resolve({ status: "done", messages: [], elapsedMs: 1 });
  await until(() => fake.waits.length === 2);
  fake.waits[1].resolve({ status: "done", messages: [reply("m1", "pong")], elapsedMs: 1 });
  await until(() => file(jobId).status === "done");
  assert.equal(file(jobId).messages[0].text, "pong");
  assert.equal(file(jobId).error, null);
});

test("45 minutes idle with no reply → stale with no_reply (fake clock)", async () => {
  let t = Date.parse("2026-11-16T10:00:00Z");
  const j = jobs({ retryMs: 5, clock: () => t });
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.waits.length === 1);
  t += 44 * 60_000;
  fake.waits[0].resolve({ status: "done", messages: [], elapsedMs: 1 });
  await until(() => fake.waits.length === 2);
  assert.equal(file(jobId).status, "working");
  t += 60_000;
  fake.waits[1].resolve({ status: "done", messages: [], elapsedMs: 1 });
  await until(() => file(jobId).status === "stale");
  assert.deepEqual(file(jobId).error, { code: "no_reply", message: "The Bot went idle without replying." });
  assert.equal(fake.waits.length, 2);
});

test("the Bot's computer falling asleep adds one warning event and one warnings entry; status unchanged", async () => {
  let phase: string | null = "settled";
  fake.layer.phase = async () => phase;
  const j = jobs({ phaseEveryMs: 10 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.waits.length === 1);
  await sleep(40);
  assert.deepEqual(file(jobId).warnings, []);
  phase = "away";
  await until(() => events.since(0, 50).some((e) => e.type === "warning"));
  await sleep(60);
  const warnings = events.since(0, 50).filter((e) => e.type === "warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].jobId, jobId);
  assert.equal(warnings[0].text, SLEEP_WARNING);
  assert.deepEqual(file(jobId).warnings, [SLEEP_WARNING]);
  assert.equal(file(jobId).status, "working");
});

const usageAt = (percentUsed: number, onDemand: Usage["onDemand"] = null): Usage => ({
  percentUsed,
  resetsAt: "2026-11-20T00:00:00.000Z",
  plan: "SuperGrok",
  // The app reported true at 100% with on-demand off, so it must not be trusted.
  hasAvailableUsage: true,
  onDemand,
});

test("usageOut: 100% with on-demand off or at its limit is out; on-demand with room left, or under 100%, isn't", () => {
  assert.equal(usageOut(usageAt(100)), true);
  assert.equal(usageOut(usageAt(100, { enabled: false, usedCents: 0, limitCents: null })), true);
  assert.equal(usageOut(usageAt(100, { enabled: true, usedCents: 500, limitCents: 500 })), true);
  assert.equal(usageOut(usageAt(100, { enabled: true, usedCents: 100, limitCents: 500 })), false);
  assert.equal(usageOut(usageAt(100, { enabled: true, usedCents: 900, limitCents: null })), false);
  assert.equal(usageOut(usageAt(99.5)), false);
});

test("usage used up: task is refused with usage_exhausted and nothing is sent", async () => {
  fake.layer.usage = async () => usageAt(100);
  const j = jobs();
  await assert.rejects(j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." }), {
    code: "usage_exhausted",
    message:
      "Grok Bot weekly usage is used up (100%). It resets at 2026-11-20T00:00:00.000Z. Enable on-demand usage in Grok Bot to continue sooner. Nothing was sent.",
  });
  await sleep(30);
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(j.list(), []);
});

test("on-demand enabled at 100%: the task goes ahead", async () => {
  fake.layer.usage = async () => usageAt(100, { enabled: true, usedCents: 0, limitCents: 1000 });
  const j = jobs();
  await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.sent.length === 1);
});

test("usage can't be read: the task isn't blocked", async () => {
  fake.layer.usage = async () => {
    throw new Error("Couldn't read usage from Grok Bot: 503");
  };
  const j = jobs();
  await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.sent.length === 1);
  assert.equal(await j.usageSummary(), null);
});

test("usage runs out mid-job: the job fails with usage_exhausted, keeps its messages, and its waiter stops", async () => {
  let current = usageAt(40);
  fake.layer.usage = async () => current;
  const j = jobs({ usageEveryMs: 10, usageCacheMs: 0 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.waits.length === 1);
  fake.waits[0].onUpdate(reply("m1", "working on it"));
  await sleep(30);
  assert.equal(file(jobId).status, "working");
  current = usageAt(100);
  await until(() => file(jobId).status === "failed");
  const job = file(jobId);
  assert.equal(job.error?.code, "usage_exhausted");
  assert.equal(
    job.error?.message,
    "Grok Bot weekly usage is used up (100%). It resets at 2026-11-20T00:00:00.000Z. Enable on-demand usage in Grok Bot to continue sooner. The Bot stopped because Grok usage ran out.",
  );
  assert.deepEqual(
    job.messages.map((m) => m.text),
    ["working on it"],
  );
  assert.ok(events.since(0, 50).some((e) => e.type === "failed" && e.jobId === jobId));
  // A late reply from the stopped wait changes nothing.
  fake.waits[0].onUpdate(reply("m2", "pong"));
  fake.waits[0].resolve({ status: "done", messages: [reply("m2", "pong")], elapsedMs: 1 });
  await sleep(30);
  assert.equal(file(jobId).status, "failed");
  assert.equal(file(jobId).messages.length, 1);
  assert.equal(fake.waits.length, 1);
});

test("an idle with no reply checks usage at once: out → failed with usage_exhausted", async () => {
  let current = usageAt(40);
  fake.layer.usage = async () => current;
  const j = jobs({ retryMs: 5, usageCacheMs: 0 });
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.waits.length === 1);
  current = usageAt(100);
  fake.waits[0].resolve({ status: "done", messages: [], elapsedMs: 1 });
  await until(() => file(jobId).status === "failed");
  assert.equal(file(jobId).error?.code, "usage_exhausted");
  assert.equal(fake.waits.length, 1);
});

// ---- T16: a stale "out" usage reading ----

const RESET = Date.parse("2026-11-20T00:00:00.000Z");

/** Usage answers from `answers` in turn (the last repeats), counting calls; the start-up read is awaited. */
async function usageSequence(answers: (Usage | Error)[], now: { t: number }) {
  let calls = 0;
  fake.layer.usage = async () => {
    const a = answers[Math.min(calls++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  const j = jobs({ clock: () => now.t });
  await until(() => calls >= 1);
  await sleep(5);
  return { j, calls: () => calls };
}

test('usage cache: an "out" reading past its reset time isn\'t reused; create goes through', async () => {
  const now = { t: RESET - 10_000 };
  const u = await usageSequence([usageAt(100), usageAt(0)], now);
  assert.equal(u.j.usageSnapshot()?.out, true);
  now.t = RESET + 1_000; // 11 s later: still inside the 60 s cache window, but the reset has passed
  assert.deepEqual(await u.j.usageSummary(), { percentUsed: 0, resetsAt: "2026-11-20T00:00:00.000Z", out: false });
  assert.equal(u.calls(), 2, "read fresh instead of reusing the stale out reading");
  await u.j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  await until(() => fake.sent.length === 1);
});

test("usage cache: a stale out cache past reset goes straight to a fresh read on create", async () => {
  const now = { t: RESET - 10_000 };
  const u = await usageSequence([usageAt(100), usageAt(0)], now);
  now.t = RESET;
  await u.j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  assert.equal(u.calls(), 2);
  await until(() => fake.sent.length === 1);
});

test("usage cache: a cached out before its reset time triggers exactly one fresh read before blocking", async () => {
  const now = { t: RESET - 60 * 60_000 };
  const u = await usageSequence([usageAt(100)], now);
  assert.equal(u.calls(), 1);
  await assert.rejects(u.j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." }), { code: "usage_exhausted" });
  assert.equal(u.calls(), 2, "one fresh usage() call, then blocked");
  await sleep(30);
  assert.deepEqual(fake.sent, []);
});

test("usage cache: a fresh read that is still out blocks; a fresh read that is no longer out lets the task through", async () => {
  const now = { t: RESET - 60 * 60_000 };
  const out = await usageSequence([usageAt(100), usageAt(100)], now);
  await assert.rejects(out.j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." }), { code: "usage_exhausted" });
  assert.deepEqual(fake.sent, []);
  const back = await usageSequence([usageAt(100), usageAt(0)], now);
  await back.j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." });
  assert.equal(back.calls(), 2);
  await until(() => fake.sent.length === 1);
});

test("usage cache: if the fresh read fails, the cached out reading still blocks", async () => {
  const now = { t: RESET - 60 * 60_000 };
  const u = await usageSequence([usageAt(100), new Error("Couldn't read usage from Grok Bot: 503")], now);
  await assert.rejects(u.j.create({ bot: "Alpha", brief: "Reply with the word pong and nothing else." }), { code: "usage_exhausted" });
  assert.equal(u.calls(), 2);
  assert.deepEqual(fake.sent, []);
});

test("health shows usage: percent, reset time and out (null until it has been read)", async () => {
  fake.layer.usage = async () => usageAt(100);
  const link = { connected: false };
  const j = jobs({ link });
  const health = () =>
    (
      daemonMethods(
        {
          mode: "pipe",
          connected: link.connected,
          appVersion: "1.1.0",
          requireCdp: () => {
            throw new Error("no CDP");
          },
        },
        { jobs: j },
      ).health({}) as { usage: unknown }
    ).usage;
  assert.equal(health(), null);
  link.connected = true;
  await until(() => health() !== null);
  assert.deepEqual(health(), { percentUsed: 100, resetsAt: "2026-11-20T00:00:00.000Z", out: true });
  assert.deepEqual(await j.usageSummary(), { percentUsed: 100, resetsAt: "2026-11-20T00:00:00.000Z", out: true });
});
