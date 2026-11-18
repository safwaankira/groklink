import assert from "node:assert/strict";
import { test } from "node:test";
import type { CDP } from "../src/base/cdp.ts";
import { accountState, deepProbe, probeWarnings } from "../src/daemon/probe.ts";
import { daemonMethods, type Link } from "../src/daemon/server.ts";

const BOT = {
  id: "b1",
  name: "Alpha",
  description: "",
  hidden: false,
  running: false,
  needsInput: false,
  unread: 0,
  lastActivity: null,
  preview: null,
};
const SECRET_TEXT = "secret transcript text";

type Page = {
  ready?: "complete" | "loading";
  stores?: boolean;
  auth?: unknown;
  bots?: object[];
  readFails?: boolean;
  usage?: object | null;
  phase?: unknown;
  hang?: string;
};

/** Answers the page code the probe sends, by what each piece of code looks like. */
function fakeCdp(p: Page = {}): CDP {
  const answer = (code: string, args: unknown[]): unknown => {
    if (code.includes("document.readyState")) return { state: p.ready ?? "complete", stores: p.stores ?? true };
    if (code.includes("getCursorAuthStatus")) return p.auth === undefined ? "logged-in" : p.auth;
    if (code.includes("getCursorUsageSummary"))
      return p.usage === undefined ? { sandUsagePercent: 42, sandUsageResetTimestampMs: Date.UTC(2026, 10, 19, 8) } : p.usage;
    if (code.includes("boxHostPhase")) return p.phase === undefined ? "settled" : p.phase;
    if (args.length === 3) {
      if (p.readFails) throw new Error("transcript store not found");
      return [{ key: "k1", role: "assistant", kind: "text", text: SECRET_TEXT, links: [], at: null }];
    }
    return p.bots ?? [BOT];
  };
  const run = async (code: string, args: unknown[]) => {
    if (p.hang && code.includes(p.hang)) return new Promise(() => {});
    return answer(code, args);
  };
  return { eval: (expr: string) => run(expr, []), call: (fn: string, ...args: unknown[]) => run(fn, args) } as unknown as CDP;
}

const byName = (r: Awaited<ReturnType<typeof deepProbe>>) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

test("probe: every check passes on a healthy app, with no message text in any detail", async () => {
  const r = await deepProbe(() => fakeCdp());
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.checks.map((c) => c.name),
    ["app", "account", "roster", "transcript", "usage", "awake"],
  );
  for (const c of r.checks) {
    assert.equal(c.ok, true, c.name);
    assert.equal(typeof c.ms, "number");
    assert.ok(!c.detail.includes(SECRET_TEXT));
  }
  const c = byName(r);
  assert.equal(c.account.detail, "signed_in");
  assert.equal(c.roster.detail, "1 Bot");
  assert.equal(c.usage.detail, "42% used");
  assert.ok(!JSON.stringify(r).includes(SECRET_TEXT));
  assert.deepEqual(probeWarnings(r), []);
});

test("probe app: no connection fails app and skips the rest", async () => {
  const r = await deepProbe(() => {
    throw new Error("Grok Bot isn't connected yet");
  });
  assert.equal(r.ok, false);
  const c = byName(r);
  assert.equal(c.app.ok, false);
  assert.match(c.app.detail, /isn't connected/);
  for (const n of ["account", "roster", "transcript", "usage", "awake"]) assert.match(c[n].detail, /^skipped/);
  assert.equal(probeWarnings(r).length, 1);
});

test("probe app: a page still loading, or missing stores, fails app", async () => {
  assert.match(byName(await deepProbe(() => fakeCdp({ ready: "loading" }))).app.detail, /not loaded/);
  assert.match(byName(await deepProbe(() => fakeCdp({ stores: false }))).app.detail, /stores/);
});

test("probe account: logged-out is signed_out (fails); other answers are unknown (warn)", async () => {
  const out = await deepProbe(() => fakeCdp({ auth: "logged-out" }));
  assert.equal(out.ok, false);
  assert.deepEqual({ ok: byName(out).account.ok, detail: byName(out).account.detail }, { ok: false, detail: "signed_out" });
  assert.ok(probeWarnings(out).includes("Grok Bot is signed out — open the app and sign in."));
  for (const auth of [null, "logging-in", 7]) {
    const r = await deepProbe(() => fakeCdp({ auth }));
    assert.equal(r.ok, true);
    assert.deepEqual([byName(r).account.ok, byName(r).account.warn, byName(r).account.detail], [true, true, "unknown"]);
  }
  assert.equal(accountState("logged-in"), "signed_in");
  assert.equal(accountState("logged-out"), "signed_out");
  assert.equal(accountState(undefined), "unknown");
});

test("probe roster: no Bots fails roster and skips transcript", async () => {
  const r = await deepProbe(() => fakeCdp({ bots: [] }));
  assert.equal(r.ok, false);
  assert.deepEqual([byName(r).roster.ok, byName(r).roster.detail], [false, "no Bots"]);
  assert.match(byName(r).transcript.detail, /^skipped/);
  assert.match(probeWarnings(r).join("\n"), /can't list your Bots/);
});

test("probe transcript: a read error fails transcript", async () => {
  const r = await deepProbe(() => fakeCdp({ readFails: true }));
  assert.equal(r.ok, false);
  assert.deepEqual([byName(r).transcript.ok, byName(r).transcript.detail], [false, "transcript store not found"]);
});

test("probe usage: used up is a failure in plain English with the reset time; unreadable fails too", async () => {
  const r = await deepProbe(() =>
    fakeCdp({ usage: { sandUsagePercent: 100, sandUsageResetTimestampMs: Date.UTC(2026, 10, 19, 8), onDemand: null } }),
  );
  assert.equal(r.ok, false);
  assert.equal(byName(r).usage.detail, "Grok usage used up, resets Thu, 19 Nov 2026 08:00:00 GMT");
  assert.ok(probeWarnings(r).includes("Grok usage used up, resets Thu, 19 Nov 2026 08:00:00 GMT."));
  const none = await deepProbe(() => fakeCdp({ usage: null }));
  assert.equal(byName(none).usage.ok, false);
  assert.match(probeWarnings(none).join("\n"), /Couldn't read Grok usage/);
});

test("probe awake: away is a warning, not a failure", async () => {
  const r = await deepProbe(() => fakeCdp({ phase: "away" }));
  assert.equal(r.ok, true);
  assert.deepEqual([byName(r).awake.ok, byName(r).awake.warn], [true, true]);
  assert.match(probeWarnings(r)[0], /asleep|away/);
});

test("probe: each check is capped (a hung check fails with a timeout, the rest still run)", async () => {
  const r = await deepProbe(() => fakeCdp({ hang: "getCursorAuthStatus" }), { timeoutMs: 50 });
  assert.deepEqual([byName(r).account.ok, byName(r).account.detail], [false, "timed out after 0.05 s"]);
  assert.equal(byName(r).awake.ok, true);
});

const link = (cdp: CDP | null): Link => ({
  mode: "pipe",
  connected: cdp !== null,
  appVersion: "1.2.0",
  requireCdp: () => {
    if (!cdp) throw new Error("not connected");
    return cdp;
  },
});

test("health: plain health is unchanged (no probe); deep adds probe and plain-English warnings", async () => {
  let touched = false;
  const spy = fakeCdp();
  const watched = new Proxy(spy, {
    get: (t, k) => {
      touched = true;
      return Reflect.get(t, k);
    },
  });
  const m = daemonMethods(link(watched));
  const plain = m.health({}) as Record<string, unknown>;
  assert.ok(!(plain instanceof Promise));
  assert.equal(plain.probe, undefined);
  assert.equal(touched, false, "plain health doesn't touch the page");

  const out = daemonMethods(link(fakeCdp({ auth: "logged-out" })));
  const deep = (await out.health({ deep: true })) as { probe: { ok: boolean }; warnings: string[] };
  assert.equal(deep.probe.ok, false);
  assert.ok(deep.warnings.includes("Grok Bot is signed out — open the app and sign in."));
  assert.throws(() => out.health({ deep: "yes" }), /"deep" must be true or false/);
});
