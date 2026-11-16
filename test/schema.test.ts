import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Message, WaitResult } from "../src/base/bot.ts";
import { EventLog } from "../src/daemon/events.ts";
import { type BotLayer, type Job, Jobs, wrapBrief } from "../src/daemon/jobs.ts";
import { lastJsonBlock, type Schema, validate } from "../src/shared/schema.ts";

// ---- validator ----

const errs = (value: unknown, schema: Schema) => {
  const r = validate(value, schema);
  return r.ok ? [] : r.errors;
};

test("type: each type passes its own values and fails others", () => {
  const cases: [string, unknown, unknown][] = [
    ["object", {}, []],
    ["array", [], {}],
    ["string", "x", 1],
    ["number", 1.5, "1"],
    ["integer", 2, 2.5],
    ["boolean", false, 0],
    ["null", null, undefined],
  ];
  for (const [type, good, bad] of cases) {
    assert.deepEqual(validate(good, { type }), { ok: true }, type);
    assert.equal(validate(bad, { type }).ok, false, type);
  }
  assert.deepEqual(errs("x", { type: "number" }), ["/: expected number, got string"]);
});

test("properties validate nested values with JSON-pointer paths", () => {
  const s: Schema = { type: "object", properties: { a: { type: "object", properties: { "b/c": { type: "string" } } } } };
  assert.deepEqual(validate({ a: { "b/c": "ok" } }, s), { ok: true });
  assert.deepEqual(errs({ a: { "b/c": 1 } }, s), ["/a/b~1c: expected string, got number"]);
});

test("required", () => {
  const s: Schema = { type: "object", required: ["word"] };
  assert.deepEqual(validate({ word: "x" }, s), { ok: true });
  assert.deepEqual(errs({}, s), ['/: missing required property "word"']);
});

test("items", () => {
  const s: Schema = { type: "array", items: { type: "integer" } };
  assert.deepEqual(validate([1, 2], s), { ok: true });
  assert.deepEqual(errs([1, "2"], s), ["/1: expected integer, got string"]);
});

test("enum", () => {
  const s: Schema = { enum: ["pong", 1, { a: [1] }] };
  assert.deepEqual(validate("pong", s), { ok: true });
  assert.deepEqual(validate({ a: [1] }, s), { ok: true });
  assert.deepEqual(errs("ping", s), ['/: must be one of "pong", 1, {"a":[1]}']);
});

test("additionalProperties: false", () => {
  const s: Schema = { type: "object", properties: { word: { type: "string" } }, additionalProperties: false };
  assert.deepEqual(validate({ word: "x" }, s), { ok: true });
  assert.deepEqual(errs({ word: "x", extra: 1 }, s), ["/extra: property not allowed"]);
});

test("minItems and maxItems", () => {
  const s: Schema = { type: "array", minItems: 1, maxItems: 2 };
  assert.deepEqual(validate([1], s), { ok: true });
  assert.deepEqual(errs([], s), ["/: needs at least 1 items, has 0"]);
  assert.deepEqual(errs([1, 2, 3], s), ["/: allows at most 2 items, has 3"]);
});

// ---- block extraction and brief wrapping ----

test("lastJsonBlock: none, one, several → last", () => {
  assert.equal(lastJsonBlock("no block here"), null);
  assert.equal(lastJsonBlock("```js\n1\n```"), null);
  assert.equal(lastJsonBlock('Done.\n```json\n{"word":"pong"}\n```'), '{"word":"pong"}\n');
  assert.equal(lastJsonBlock('```json\n{"n":1}\n```\ntext\n```json \n{"n":2}\n```'), '{"n":2}\n');
});

test("wrapBrief appends the exact instruction and the pretty-printed schema", () => {
  const schema = { type: "object" };
  assert.equal(wrapBrief("Do it.", null), "Do it.");
  assert.equal(
    wrapBrief("Do it.", schema),
    'Do it.\n\nWhen you\'re finished, end your final message with one fenced code block tagged json that matches this JSON Schema. Nothing after the block.\n```json\n{\n  "type": "object"\n}\n```',
  );
});

// ---- jobs with a schema ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (const t0 = Date.now(); !check(); await sleep(5)) if (Date.now() - t0 > ms) throw new Error("timed out");
}

const reply = (key: string, text: string): Message => ({ key, role: "assistant", kind: "message", text, links: [], at: null });
const SCHEMA = {
  type: "object",
  properties: { word: { type: "string", enum: ["pong"] } },
  required: ["word"],
  additionalProperties: false,
};

type WaitCall = { since?: string; resolve: (r: Omit<WaitResult, "bot">) => void };

function fakeLayer(recent: Message[] = []) {
  const sent: string[] = [];
  const waits: WaitCall[] = [];
  const layer: BotLayer = {
    find: async () => ({ id: "b1", name: "Alpha" }),
    async send(_botId, brief) {
      sent.push(brief);
      return `nonce_${sent.length}`;
    },
    read: async () => [],
    recent: async () => recent,
    wait: (_botId, opts) => new Promise((resolve) => waits.push({ since: opts.since, resolve: (r) => resolve({ bot: "Alpha", ...r }) })),
  };
  return { layer, sent, waits };
}

let home: string;
const open: Jobs[] = [];

function jobs(layer: BotLayer): Jobs {
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
  return j;
}

const file = (jobId: string): Job => JSON.parse(readFileSync(join(home, "jobs", `${jobId}.json`), "utf8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glk-schema-"));
});

afterEach(() => {
  for (const j of open.splice(0)) j.close();
  rmSync(home, { recursive: true, force: true });
});

test("a schema job sends the wrapped brief and a valid answer becomes result", async () => {
  const fake = fakeLayer();
  const j = jobs(fake.layer);
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong.", schema: SCHEMA });
  await until(() => fake.waits.length === 1);
  assert.equal(fake.sent[0], wrapBrief("Reply with the word pong.", SCHEMA));
  fake.waits[0].resolve({ status: "done", messages: [reply("m1", 'Here:\n```json\n{"word":"pong"}\n```')], elapsedMs: 1 });
  await until(() => file(jobId).status === "done");
  assert.deepEqual(file(jobId).result, { word: "pong" });
  assert.equal(file(jobId).attempts, 1);
});

test("an invalid answer gets a repair message, and a fixed one is accepted", async () => {
  const fake = fakeLayer();
  const j = jobs(fake.layer);
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong.", schema: SCHEMA });
  await until(() => fake.waits.length === 1);
  fake.waits[0].resolve({ status: "done", messages: [reply("m1", '```json\n{"word":"ping"}\n```')], elapsedMs: 1 });
  await until(() => fake.waits.length === 2);
  assert.equal(fake.sent[1], `Your JSON didn't match the schema: /word: must be one of "pong". Send only the corrected json block.`);
  assert.equal(fake.waits[1].since, "nonce_2");
  assert.equal(file(jobId).status, "working");
  assert.equal(file(jobId).attempts, 2);
  fake.waits[1].resolve({ status: "done", messages: [reply("m2", '```json\n{"word":"pong"}\n```')], elapsedMs: 1 });
  await until(() => file(jobId).status === "done");
  assert.deepEqual(file(jobId).result, { word: "pong" });
});

test("after 2 failed repairs the job fails with schema_invalid", async () => {
  const fake = fakeLayer();
  const j = jobs(fake.layer);
  const { jobId } = await j.create({ bot: "Alpha", brief: "Reply with the word pong.", schema: SCHEMA });
  for (let i = 0; i < 3; i++) {
    await until(() => fake.waits.length === i + 1);
    fake.waits[i].resolve({ status: "done", messages: [reply(`m${i}`, "pong, no block")], elapsedMs: 1 });
  }
  await until(() => file(jobId).status === "failed");
  const job = file(jobId);
  assert.equal(fake.sent.length, 3, "the brief plus exactly 2 repairs");
  assert.equal(job.attempts, 3);
  assert.equal(job.result, null);
  assert.equal(job.error?.code, "schema_invalid");
  assert.deepEqual(job.error?.errors, ["no ```json block in the final message"]);
});

test("create rejects a schema that isn't an object", async () => {
  const j = jobs(fakeLayer().layer);
  await assert.rejects(j.create({ bot: "Alpha", brief: "x", schema: "nope" }), { code: "bad_request" });
});

// ---- duplicate-send guard ----

/** A queued job left on disk by a daemon that died while sending it. */
function queuedOnDisk(createdAt: string): Job {
  const job: Job = {
    jobId: "j_00000000000a",
    bot: "Alpha",
    botId: "b1",
    createdAt,
    updatedAt: createdAt,
    status: "queued",
    briefKey: null,
    schema: SCHEMA,
    messages: [],
    result: null,
    error: null,
    attempts: 0,
    brief: "Reply with the word pong.",
    files: [],
  };
  mkdirSync(join(home, "jobs"), { recursive: true });
  writeFileSync(join(home, "jobs", `${job.jobId}.json`), JSON.stringify(job));
  return job;
}

const userMessage = (key: string, text: string, at: string): Message => ({ key, role: "user", kind: "message", text, links: [], at });

test("guard: a reloaded queued job whose brief is already in the transcript isn't sent again", async () => {
  const job = queuedOnDisk("2026-11-14T10:00:00.000Z");
  const fake = fakeLayer([userMessage("entry_7", wrapBrief(job.brief, job.schema), "2026-11-14T10:00:01.000Z")]);
  jobs(fake.layer);
  await until(() => fake.waits.length === 1);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.waits[0].since, "entry_7");
  assert.equal(file(job.jobId).status, "working");
  assert.equal(file(job.jobId).briefKey, "entry_7");
  assert.equal(file(job.jobId).attempts, 1);
});

test("guard: not found (older copy or different text) → sent once", async () => {
  const job = queuedOnDisk("2026-11-14T10:00:00.000Z");
  const fake = fakeLayer([
    userMessage("old", wrapBrief(job.brief, job.schema), "2026-11-14T09:59:00.000Z"),
    userMessage("other", "Something else", "2026-11-14T10:00:02.000Z"),
  ]);
  jobs(fake.layer);
  await until(() => fake.waits.length === 1);
  assert.deepEqual(fake.sent, [wrapBrief(job.brief, job.schema)]);
  assert.equal(file(job.jobId).briefKey, "nonce_1");
});
