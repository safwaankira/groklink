import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { CDP } from "../src/base/cdp.ts";
import { call } from "../src/client/socket.ts";
import { checkAttachment } from "../src/daemon/jobs.ts";
import { daemonMethods, isAsleep, type Link, logLine, startServer, Waker } from "../src/daemon/server.ts";
import { ensureState, statePaths } from "../src/daemon/state.ts";
import { BotAsleepError, ProtocolError } from "../src/shared/protocol.ts";

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
/** What the app's own error says when the computer is parked. The daemon must never decide "asleep" from this text. */
const APP_ASLEEP =
  "Couldn't read /home/out.csv from the Bot's computer: Grok Bot has put the Bot's computer to sleep because its window hasn't been in front for 10 minutes (SAND_AWAY_PARK).";
/** What a page function returns when the app's failure code says the computer is parked. */
const PARKED = { groklinkAsleep: "SAND_AWAY_PARK" };

let home: string;
let saved: string | undefined;
let server: Server | null = null;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gl-asleep-"));
  saved = process.env.GROKLINK_HOME;
  process.env.GROKLINK_HOME = join(home, "state");
});
afterEach(() => {
  server?.close();
  server = null;
  if (saved === undefined) delete process.env.GROKLINK_HOME;
  else process.env.GROKLINK_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

type Page = {
  phase: string;
  /** Messages in the Bot's conversation. */
  messages: object[];
  /** How many file reads fail as asleep before one works. */
  asleepReads: number;
  /** How many routine reads come back { asleep } before one works. */
  asleepRoutines: number;
};

/** A fake page: Bots, a transcript, file reads and routines, with the Bot computer's phase. `wake` sets it to settled. */
function fakeApp(p: Partial<Page> = {}) {
  const page: Page = { phase: "away", messages: [], asleepReads: 0, asleepRoutines: 0, ...p };
  const counts = { wakes: 0, fileReads: 0, routineReads: 0 };
  const answer = (code: string, args: unknown[]): unknown => {
    if (code.includes("boxHostPhase") && !code.includes("automations")) return page.phase;
    if (code.includes("readAttachmentBytes")) {
      counts.fileReads++;
      if (page.asleepReads-- > 0) return PARKED;
      return Buffer.from("hello").toString("base64");
    }
    if (code.includes("automations")) {
      counts.routineReads++;
      if (page.asleepRoutines-- > 0) return { asleep: "away" };
      return { value: [] };
    }
    if (args.length === 3) return page.messages;
    return [BOT];
  };
  const cdp = {
    eval: async (expr: string) => answer(expr, []),
    call: async (fn: string, ...args: unknown[]) => answer(fn, args),
    send: async () => ({}),
  } as unknown as CDP;
  const link: Link = {
    mode: "pipe",
    connected: true,
    appVersion: "1.2.3",
    requireCdp: () => cdp,
    wake: async () => {
      counts.wakes++;
      page.phase = "settled";
    },
  };
  return { page, counts, link, cdp };
}

const fileMessage = {
  key: "m1",
  role: "assistant",
  kind: "file",
  text: "",
  links: [],
  at: null,
  file: { name: "out.csv", path: "/home/out.csv" },
};

function methods(app: ReturnType<typeof fakeApp>, now = { t: 0 }, extraLink: Partial<Link> = {}) {
  const lines: string[] = [];
  const m = daemonMethods({ ...app.link, ...extraLink }, { log: (l) => lines.push(l), wake: { waitMs: 200, pollMs: 5, now: () => now.t } });
  return { m, lines };
}

// ---- asleep → wake → retry ----

test("asleep → wake succeeds → the retry works (download), the file is saved once, and the log says so", async () => {
  const app = fakeApp({ messages: [fileMessage], asleepReads: 1 });
  const { m, lines } = methods(app);
  const r = (await m.download({ bot: "Alpha" })) as { files: { savedTo: string }[] };
  assert.equal(r.files.length, 1);
  assert.equal(app.counts.wakes, 1);
  assert.equal(app.counts.fileReads, 2);
  const dir = join(process.env.GROKLINK_HOME ?? "", "downloads", "Alpha");
  assert.deepEqual(readdirSync(dir), ["out.csv"]);
  assert.ok(lines.includes("woke Alpha for download"));
});

test("asleep → wake succeeds → the retry works (routines list)", async () => {
  const app = fakeApp({ asleepRoutines: 1 });
  const { m, lines } = methods(app);
  const r = (await m.routines({ action: "list", bot: "Alpha" })) as { routines: unknown[]; untrusted: boolean };
  assert.deepEqual(r.routines, []);
  assert.equal(app.counts.wakes, 1);
  assert.ok(lines.includes("woke Alpha for routines"));
});

test("asleep → wake succeeds → the retry works (read)", async () => {
  const app = fakeApp();
  let first = true;
  const cdp = app.link.requireCdp();
  const inner = cdp.call.bind(cdp);
  (cdp as unknown as { call: (fn: string, ...args: unknown[]) => Promise<unknown> }).call = async (fn: string, ...args: unknown[]) => {
    if (args.length === 3 && first) {
      first = false;
      return PARKED;
    }
    return inner(fn, ...args);
  };
  const { m, lines } = methods(app);
  assert.deepEqual(((await m.read({ bot: "Alpha" })) as { messages: unknown[] }).messages, []);
  assert.ok(lines.includes("woke Alpha for read"));
});

test("asleep → wake fails (still away) → bot_asleep with retryAfterSec 10, never internal; the log says wake failed", async () => {
  const app = fakeApp({ messages: [fileMessage], asleepReads: 5 });
  const { m, lines } = methods(app, { t: 0 }, { wake: async () => {} }); // the window came forward but the phase stays away
  await assert.rejects(
    Promise.resolve().then(() => m.download({ bot: "Alpha" })),
    (e: Error & { code?: string; retryAfterSec?: number }) => {
      assert.ok(e instanceof BotAsleepError);
      assert.equal(e.code, "bot_asleep");
      assert.equal(e.retryAfterSec, 10);
      assert.equal(e.message, "Alpha's computer is asleep. Bring the Grok Bot window to the front, then try again in ~10 s.");
      return true;
    },
  );
  assert.ok(lines.some((l) => l.startsWith("wake failed for Alpha (download)")));
  assert.equal(app.counts.fileReads, 1, "no retry when the wake didn't work");
});

test("asleep → woke but still asleep on the retry → bot_asleep (one retry only)", async () => {
  const app = fakeApp({ asleepRoutines: 5 });
  const { m } = methods(app);
  await assert.rejects(
    Promise.resolve().then(() => m.routines({ action: "list", bot: "Alpha" })),
    { code: "bot_asleep" },
  );
  assert.equal(app.counts.routineReads, 2);
  assert.equal(app.counts.wakes, 1);
});

test("focus rate limit: at most one wake per Bot per 60 s; the next call fails fast with bot_asleep", async () => {
  const app = fakeApp({ asleepRoutines: 1 });
  const now = { t: 1_000_000 };
  const { m, lines } = methods(app, now);
  await m.routines({ action: "list", bot: "Alpha" });
  assert.equal(app.counts.wakes, 1);
  // Asleep again 30 s later: no second focus grab.
  app.page.phase = "away";
  app.page.asleepRoutines = 1;
  now.t += 30_000;
  await assert.rejects(
    Promise.resolve().then(() => m.routines({ action: "list", bot: "Alpha" })),
    { code: "bot_asleep" },
  );
  assert.equal(app.counts.wakes, 1);
  assert.ok(lines.some((l) => l.startsWith("wake skipped for Alpha (routines)")));
  // After 60 s it may wake again.
  now.t += 31_000;
  app.page.asleepRoutines = 1;
  await m.routines({ action: "list", bot: "Alpha" });
  assert.equal(app.counts.wakes, 2);
});

test("the rate limit is per Bot", async () => {
  const app = fakeApp();
  const lines: string[] = [];
  let wakes = 0;
  const w = new Waker({ ...app.link, wake: async () => void wakes++ }, (l) => lines.push(l), { waitMs: 20, pollMs: 5, now: () => 0 });
  const asleep = (bot: string) => () => Promise.reject(new BotAsleepError(bot));
  const alpha = { id: "b1", name: "Alpha" };
  await assert.rejects(w.attempt("read", alpha, asleep("Alpha")), { code: "bot_asleep" });
  await assert.rejects(w.attempt("read", { id: "b2", name: "Beta" }, asleep("Beta")), { code: "bot_asleep" });
  assert.equal(wakes, 2);
  await assert.rejects(w.attempt("read", alpha, asleep("Alpha")), { code: "bot_asleep" });
  assert.equal(wakes, 2);
  // The limit follows the Bot's id: the same Bot under another name (its id, a prefix, different case) isn't woken again.
  await assert.rejects(w.attempt("read", { id: "b1", name: "b1" }, asleep("b1")), { code: "bot_asleep" });
  await assert.rejects(w.attempt("read", { id: "b1", name: "ALPHA" }, asleep("ALPHA")), { code: "bot_asleep" });
  assert.equal(wakes, 2);
  // And a different Bot that happens to share a name isn't held back by it.
  await assert.rejects(w.attempt("read", { id: "b3", name: "Alpha" }, asleep("Alpha")), { code: "bot_asleep" });
  assert.equal(wakes, 3);
});

test("non-asleep errors are passed through untouched, with no wake", async () => {
  const app = fakeApp();
  const w = new Waker(app.link, () => {}, { waitMs: 20, pollMs: 5 });
  await assert.rejects(
    w.attempt("read", { id: "b1", name: "Alpha" }, () => Promise.reject(new ProtocolError("not_found", "nope"))),
    { code: "not_found" },
  );
  assert.equal(app.counts.wakes, 0);
  assert.equal(isAsleep(new Error("Couldn't read usage")), false);
});

test("asleep is decided by the error's class, never by message text", async () => {
  assert.equal(isAsleep(new BotAsleepError("Alpha")), true);
  // Text that used to match: the app's own wording, our wording, the app's failure code.
  for (const text of [APP_ASLEEP, "Alpha's computer is asleep.", "sand-box-blocked", "SAND_AWAY_PARK"]) {
    assert.equal(isAsleep(new Error(text)), false, text);
    assert.equal(isAsleep(new ProtocolError("internal", text)), false, text);
  }
  // A routine named like an asleep error: the "no such routine" error names it, and is not treated as asleep.
  const app = fakeApp({ phase: "settled" });
  const { m, lines } = methods(app);
  await assert.rejects(
    Promise.resolve().then(() => m.routines({ action: "run", bot: "Alpha", routine: "computer is asleep" })),
    (e: Error & { code?: string }) => e.code === undefined && /^No routine "computer is asleep"/.test(e.message),
  );
  assert.equal(app.counts.wakes, 0);
  assert.deepEqual(lines, []);
});

test("routine actions that message the Bot are never retried; an asleep failure there is still bot_asleep", async () => {
  const app = fakeApp();
  const { m } = methods(app);
  // "remove" goes through the Bot (a message). The send reports the computer parked.
  const cdp = app.link.requireCdp();
  const inner = cdp.call.bind(cdp);
  let sends = 0;
  (cdp as unknown as { call: (fn: string, ...args: unknown[]) => Promise<unknown> }).call = async (fn: string, ...args: unknown[]) => {
    if (fn.includes("sendPrompt")) {
      sends++;
      return PARKED;
    }
    return inner(fn, ...args);
  };
  await assert.rejects(
    Promise.resolve().then(() => m.routines({ action: "remove", bot: "Alpha", routine: "Daily", confirm: "Daily" })),
    { code: "bot_asleep", message: "Alpha's computer is asleep. Bring the Grok Bot window to the front, then try again in ~10 s." },
  );
  assert.equal(sends, 1, "not retried");
  assert.equal(app.counts.wakes, 0);
});

// ---- no_files ----

test("download: a Bot with no file messages is no_files, not internal", async () => {
  const app = fakeApp({ messages: [{ key: "m1", role: "assistant", kind: "text", text: "hi", links: [], at: null }] });
  const { m } = methods(app);
  await assert.rejects(
    Promise.resolve().then(() => m.download({ bot: "Alpha" })),
    (e: Error & { code?: string }) => {
      assert.equal(e.code, "no_files");
      assert.equal(e.message, "Alpha hasn't sent any files.");
      return true;
    },
  );
  await assert.rejects(
    Promise.resolve().then(() => m.download({ bot: "Alpha", keys: ["nope"] })),
    { code: "not_found" },
  );
  await assert.rejects(
    Promise.resolve().then(() => m.download({ bot: "Alpha", keys: ["m1"] })),
    { code: "bad_request" },
  );
  assert.equal(app.counts.wakes, 0);
});

// ---- log lines and the wire ----

async function serve(methods: Record<string, (p: Record<string, unknown>) => unknown>) {
  const paths = statePaths(join(home, "sock"));
  const { token } = ensureState(paths);
  const lines: string[] = [];
  server = await startServer({ socketPath: paths.socket, token, methods, log: (l) => lines.push(l) });
  return { paths, lines };
}

test("log lines: Grok Link's own errors log <method> failed (<code>[, rule <rule>]): <first line>; app and Bot-side errors log the code only", async () => {
  const fileErr = Object.assign(
    new ProtocolError("file_blocked", "Attachment key.pem is a credential file (rule secret_name); Grok Link won't send it.\nsecond line"),
    {
      rule: "secret_name",
    },
  );
  const { paths, lines } = await serve({
    task: () => {
      throw fileErr;
    },
    read: () => {
      throw new BotAsleepError("Alpha");
    },
    routines: () => {
      throw new Error(APP_ASLEEP);
    },
    bots: () => {
      throw new Error("boom\nBot said: secret reply text");
    },
  });
  await assert.rejects(
    call("task", {}, paths),
    (e: Error & { code?: string; rule?: string }) => e.code === "file_blocked" && e.rule === "secret_name",
  );
  await assert.rejects(call("read", {}, paths), (e: Error & { code?: string; retryAfterSec?: number }) => {
    assert.equal(e.code, "bot_asleep");
    assert.equal(e.retryAfterSec, 10);
    assert.match(e.message, /\nretryAfterSec: 10$/, "MCP clients see it in the text");
    return true;
  });
  // An app error whose text mentions sleep is not bot_asleep: only BotAsleepError is.
  await assert.rejects(call("routines", {}, paths), { code: "internal" });
  await assert.rejects(call("bots", {}, paths), { code: "internal" });
  // Grok Link's own errors keep their first line; app and Bot-side errors log the code only.
  assert.deepEqual(lines, [
    "task failed (file_blocked, rule secret_name): Attachment key.pem is a credential file (rule secret_name); Grok Link won't send it.",
    "read failed (bot_asleep): Alpha's computer is asleep. Bring the Grok Bot window to the front, then try again in ~10 s.",
    "routines failed (internal)",
    "bots failed (internal)",
  ]);
  for (const l of lines) assert.ok(!l.includes("secret reply text") && !l.includes("boom"));
});

test("logLine: first line only, at most 200 characters", () => {
  assert.equal(logLine("one\ntwo"), "one");
  assert.equal(logLine("x".repeat(300)), `${"x".repeat(200)}…`);
});

// ---- file_blocked ----

test("file_blocked names the rule and the basename, and says not to retry", () => {
  const user = join(home, "user");
  const state = join(user, ".groklink");
  mkdirSync(join(user, ".ssh"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(user, "work"), { recursive: true });
  const key = join(user, "work", "key.pem");
  const inSsh = join(user, ".ssh", "config");
  writeFileSync(key, "x");
  writeFileSync(inSsh, "x");
  const check = (file: string) => {
    try {
      checkAttachment(file, { home: user, stateHome: state });
      return null;
    } catch (e) {
      return e as ProtocolError & { rule?: string };
    }
  };
  const k = check(key);
  assert.equal(k?.code, "file_blocked");
  assert.equal(k?.rule, "secret_name");
  assert.equal(
    k?.message,
    "Attachment key.pem is a credential file by its name (rule secret_name); Grok Link won't send it. Don't retry with the same file or a renamed copy. Nothing was sent.",
  );
  assert.ok(!k?.message.includes(user), "basename only, not the full path");
  const s = check(inSsh);
  assert.equal(s?.rule, "credential_folder");
  assert.match(s?.message ?? "", /^Attachment config is in a folder that holds keys or credentials \(rule credential_folder\)/);
  writeFileSync(join(state, "attach-roots.json"), JSON.stringify([join(user, "elsewhere")]));
  const fine = join(user, "work", "notes.md");
  writeFileSync(fine, "x");
  const r = check(fine);
  assert.equal(r?.rule, "attach_roots");
  assert.match(r?.message ?? "", /^Attachment notes\.md is outside the folders listed in attach-roots\.json \(rule attach_roots\)/);
  assert.ok(existsSync(fine));
});
