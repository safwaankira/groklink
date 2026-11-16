import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CDP, type CDPChannel } from "../src/base/cdp.ts";
import { SelfTest, type SelfTestResult } from "../src/daemon/selftest.ts";
import { daemonMethods } from "../src/daemon/server.ts";

/** React context values the fake page exposes, innermost first. */
const GOOD = () => [
  { roster: { createAgent() {}, snapshots: { get: () => ({ agents: { rows: [] } }) } } },
  { transcript: { snapshotsFor() {} } },
  { sendJournal: { sendPrompt() {} } },
  { accountSlot: "slot-1" },
];

/**
 * A page that really runs each evaluated expression against a fake DOM: one element whose React
 * fiber chain carries `values` as context-provider props. Counts evaluations.
 */
function fakePage(values: object[]) {
  let fiber: object | null = null;
  for (const value of [...values].reverse()) fiber = { memoizedProps: { value }, return: fiber };
  const el = { __reactFiber$test: fiber };
  const document = { querySelector: (sel: string) => (sel.startsWith(".sand-agent-item") ? el : null) };
  const page = { evals: 0 };
  let deliver: (text: string) => void = () => {};
  const channel: CDPChannel = {
    send(text) {
      const { id, params } = JSON.parse(text);
      page.evals++;
      let reply: object;
      try {
        const value = new Function("document", `return ${params.expression}`)(document);
        reply = { id, result: { result: { type: "object", value } } };
      } catch (e) {
        reply = { id, result: { result: { type: "undefined" }, exceptionDetails: { text: String(e) } } };
      }
      queueMicrotask(() => deliver(JSON.stringify(reply)));
    },
    onMessage(cb) {
      deliver = cb;
    },
    close() {},
  };
  return { cdp: new CDP(channel), page };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "glk-selftest-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const saved = (): SelfTestResult => JSON.parse(readFileSync(join(home, "selftest.json"), "utf8"));

test("a passing page: every check ok, version and result saved", async () => {
  const { cdp } = fakePage(GOOD());
  const st = new SelfTest({ home, cdp: () => cdp, log: () => {}, readVersion: async () => "1.0.3" });
  const r = await st.run();
  assert.equal(r.ok, true);
  assert.equal(r.appVersion, "1.0.3");
  assert.ok(!Number.isNaN(Date.parse(r.testedAt)));
  assert.deepEqual(
    r.checks.map((c) => [c.name, c.ok]),
    [
      ["roster.createAgent", true],
      ["transcript.snapshotsFor", true],
      ["sendJournal.sendPrompt", true],
      ["roster.rows", true],
      ["accountSlot", true],
    ],
  );
  assert.deepEqual(saved(), r);
  assert.equal(readFileSync(join(home, "app-version"), "utf8").trim(), "1.0.3");
  assert.equal(st.failure(), null);
});

test("a failing page: missing stores fail their checks, and task is refused", async () => {
  const values = GOOD().filter((v) => !("sendJournal" in v) && !("accountSlot" in v));
  (values[0] as { roster: { snapshots: unknown } }).roster.snapshots = { get: () => ({ agents: {} }) };
  const { cdp } = fakePage(values);
  const st = new SelfTest({ home, cdp: () => cdp, log: () => {}, readVersion: async () => "2.0.0" });
  const r = await st.run();
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.checks.filter((c) => !c.ok).map((c) => c.name),
    ["sendJournal.sendPrompt", "roster.rows", "accountSlot"],
  );
  assert.ok(r.checks.every((c) => c.ok || c.error));
  assert.equal(saved().ok, false);
  const message =
    "Grok Bot 2.0.0 changed its internals; self-test failed: sendJournal.sendPrompt, roster.rows, accountSlot. Grok Link needs an update.";
  assert.equal(st.failure(), message);

  const link = { mode: "pipe" as const, connected: true, appVersion: "2.0.0", requireCdp: () => cdp };
  const methods = daemonMethods(link, { selftest: st });
  await assert.rejects(async () => methods.task({ bot: "Alpha", brief: "Reply with the word pong." }), { code: "internal", message });
  const health = methods.health({}) as { selftest: SelfTestResult };
  assert.equal(health.selftest.ok, false);
});

test("a page that can't be evaluated fails the self-test", async () => {
  const st = new SelfTest({
    home,
    cdp: () => {
      throw new Error("not connected");
    },
    log: () => {},
    readVersion: async () => "1.0.3",
  });
  const r = await st.run();
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks, [{ name: "page", ok: false, error: "not connected" }]);
});

test("a version change triggers a new self-test; the same version doesn't", async () => {
  const { cdp, page } = fakePage(GOOD());
  let version = "1.0.3";
  const st = new SelfTest({ home, cdp: () => cdp, log: () => {}, readVersion: async () => version });
  await st.run();
  assert.equal(page.evals, 1);
  await st.checkVersion();
  assert.equal(page.evals, 1);
  version = "1.0.4";
  await st.checkVersion();
  assert.equal(page.evals, 2);
  assert.equal(st.result?.appVersion, "1.0.4");
  assert.equal(saved().appVersion, "1.0.4");
  assert.equal(readFileSync(join(home, "app-version"), "utf8").trim(), "1.0.4");
});

test("health includes the self-test result", async () => {
  const { cdp } = fakePage(GOOD());
  const st = new SelfTest({ home, cdp: () => cdp, log: () => {}, readVersion: async () => "1.0.3" });
  const link = { mode: "pipe" as const, connected: true, appVersion: "1.0.3", requireCdp: () => cdp };
  const methods = daemonMethods(link, { selftest: st });
  assert.equal((methods.health({}) as { selftest: unknown }).selftest, null);
  await st.run();
  const h = methods.health({}) as { selftest: SelfTestResult };
  assert.equal(h.selftest.ok, true);
  assert.equal(h.selftest.appVersion, "1.0.3");
});
