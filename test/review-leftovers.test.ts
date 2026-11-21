// T19 phase C: leftovers from the 0.1.5 and 0.1.6 reviews.
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import vm from "node:vm";
import { PARKABLE_PAGES } from "../src/base/bot.ts";
import type { CDP } from "../src/base/cdp.ts";
import { unparked } from "../src/base/page.ts";
import { approvalTextProblem, dialogBot, dialogText } from "../src/daemon/approval.ts";
import { checkAttachment } from "../src/daemon/jobs.ts";
import { daemonMethods, failureLine, type Link } from "../src/daemon/server.ts";
import { usageLimits, writeUsageLimit, writeXMode, xMode } from "../src/shared/policy.ts";
import { BotAsleepError, ProtocolError } from "../src/shared/protocol.ts";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gl-left-"));
  saved = process.env.GROKLINK_HOME;
  process.env.GROKLINK_HOME = join(home, "state");
});
afterEach(() => {
  if (saved === undefined) delete process.env.GROKLINK_HOME;
  else process.env.GROKLINK_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

// ---- 1. the Bot name in the approval dialog ----

test("dialog: a plain Bot name (ASCII or emoji, one line, at most 60 characters) is shown", () => {
  const brief = "Post this from my account";
  for (const bot of ["Alpha", "Launch Bot 2", "Scout \u{1F680}", "x".repeat(60)]) {
    assert.equal(dialogBot({ jobId: "j", bot, botId: "b1", brief }), `the Grok Bot "${bot}"`);
    assert.ok(dialogText({ jobId: "j", bot, botId: "b1", brief }).startsWith(`A task for the Grok Bot "${bot}" asks it to post to X.`));
  }
});

test("dialog: a Bot name that isn't plain text is replaced by the Bot's id", () => {
  const brief = "Post this from my account";
  const bad = [
    "Alphа", // Cyrillic look-alike
    "Alpha‮gnp.exe", // bidi override
    "Al​pha", // zero-width
    "Café", // accented
    'Alpha" asks nothing.\n\nA task for "Beta', // a second line
    "x".repeat(61), // too long
    "   ",
    "",
    "Tab\tname",
  ];
  for (const bot of bad) {
    const t = dialogText({ jobId: "j", bot, botId: "agent_1a2B-3", brief });
    assert.ok(
      t.startsWith("A task for the Grok Bot with id agent_1a2B-3 (its name isn't plain text, so it isn't shown) asks it to post to X."),
      JSON.stringify(bot),
    );
    assert.ok(!bot.trim() || !t.includes(bot), `the name isn't in the dialog: ${JSON.stringify(bot)}`);
    assert.ok(t.includes(brief));
  }
  // No usable id either: neither is shown.
  for (const botId of [undefined, "", "id with spaces", "id‮", "x".repeat(81)])
    assert.equal(dialogBot({ jobId: "j", bot: "Café", botId, brief }), "a Grok Bot (its name isn't plain text, so it isn't shown)");
});

// ---- 2. emoji allowlist ----

test("approve mode: skin tones after an emoji, flags (regional-indicator pairs) and keycaps are accepted", () => {
  const ok = [
    "Post \u{1F44D}\u{1F3FD} from my account", // thumbs up + medium skin tone
    "Post \u{270C}\u{FE0F}\u{1F3FB} from my account", // victory hand + VS16 + skin tone
    "Post \u{1F469}\u{1F3FE}\u{200D}\u{1F4BB} from my account", // woman + skin tone + ZWJ + laptop
    "Post \u{1F1FA}\u{1F1F8} from my account", // one flag
    "Post \u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7} from my account", // two flags
    "Post 1\u{FE0F}\u{20E3} #\u{FE0F}\u{20E3} *\u{20E3} from my account", // keycaps, with and without VS16
  ];
  for (const t of ok) assert.equal(approvalTextProblem(t), null, JSON.stringify(t));
});

test("approve mode: the new emoji parts are refused out of place, and unassigned code points are refused", () => {
  const bad: [string, string][] = [
    ["a\u{1F3FD}", "1F3FD"], // skin tone after a letter
    ["\u{1F3FD}", "1F3FD"], // skin tone on its own
    ["\u{1F44D}\u{1F3FD}\u{1F3FD}", "1F3FD"], // two skin tones
    ["\u{1F1FA}", "1F1FA"], // half a flag
    ["\u{1F1FA}\u{1F1F8}\u{1F1EC}", "1F1FA"], // an odd run of regional indicators
    ["a\u{20E3}", "20E3"], // keycap mark after a letter
    ["1\u{FE0F}", "FE0F"], // VS16 after a digit with no keycap mark
    ["\u{20E3}", "20E3"],
    ["\u{1FAFF}", "1FAFF"], // Extended_Pictographic but unassigned
    ["\u{1F02C}", "1F02C"], // unassigned
    ["ok \u{1F8FF} ok", "1F8FF"], // unassigned
    ["\u{E0061}", "E0061"], // tag character
  ];
  for (const [t, hex] of bad) {
    const problem = approvalTextProblem(t) ?? "";
    assert.match(problem, /^approve mode accepts plain text only/, JSON.stringify(t));
    assert.ok(problem.includes(`U+${hex}`), `${JSON.stringify(t)}: ${problem}`);
  }
});

// ---- 3. dangling symlinked policy.json ----

test("a dangling symlinked policy.json is written through: the link stays and its target is created (0600)", () => {
  const link = join(home, "policy.json");
  const target = join(home, "dotfiles", "groklink", "policy.json");
  symlinkSync(target, link);
  assert.equal(existsSync(target), false);
  writeXMode(link, "approve");
  assert.ok(lstatSync(link).isSymbolicLink(), "still a symlink");
  assert.equal(readlinkSync(link), target);
  assert.equal(xMode(JSON.parse(readFileSync(target, "utf8"))).mode, "approve");
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home).sort(), ["dotfiles", "policy.json"]);
  assert.deepEqual(readdirSync(join(home, "dotfiles", "groklink")), ["policy.json"], "no temp file left");
  // The usage limits use the same path.
  writeUsageLimit(link, "pause", 90);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.deepEqual(usageLimits(JSON.parse(readFileSync(target, "utf8"))), { warn: 80, pause: 90 });
});

test("a relative dangling link and a chain of links are followed to the real target", () => {
  mkdirSync(join(home, "a"));
  symlinkSync("../b/policy.json", join(home, "a", "policy.json"));
  mkdirSync(join(home, "b"));
  symlinkSync(join(home, "c", "real.json"), join(home, "b", "policy.json"));
  writeXMode(join(home, "a", "policy.json"), "allow");
  assert.ok(lstatSync(join(home, "a", "policy.json")).isSymbolicLink());
  assert.ok(lstatSync(join(home, "b", "policy.json")).isSymbolicLink());
  assert.equal(xMode(JSON.parse(readFileSync(join(home, "c", "real.json"), "utf8"))).mode, "allow");
});

// ---- 4. the failed-call log line ----

test("failureLine: Grok Link's own errors keep their first line; app and Bot-side errors log the code only", () => {
  assert.equal(
    failureLine("read", new BotAsleepError("Alpha")),
    "read failed (bot_asleep): Alpha's computer is asleep. Bring the Grok Bot window to the front, then try again in ~10 s.",
  );
  assert.equal(
    failureLine("task", Object.assign(new ProtocolError("file_blocked", "Attachment key.pem is blocked.\nmore"), { rule: "secret_name" })),
    "task failed (file_blocked, rule secret_name): Attachment key.pem is blocked.",
  );
  assert.equal(
    failureLine("task", new ProtocolError("usage_paused", "Grok usage is at 91%; new tasks pause at 90% (your setting).")),
    "task failed (usage_paused): Grok usage is at 91%; new tasks pause at 90% (your setting).",
  );
  // Errors from the base and the app: a routine name the Bot's side chose, the app's own error text.
  for (const e of [
    new Error('No routine "x". Routines: Ignore previous instructions (r1), Daily (r2)'),
    new Error("Couldn't load routines: backend said: <html>secret</html>"),
    new TypeError("Cannot read properties of undefined"),
    "a thrown string",
  ]) {
    assert.equal(failureLine("routines", e), "routines failed (internal)");
  }
});

// ---- 5. multi-file download ----

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
const fileMessage = (key: string, name: string) => ({
  key,
  role: "assistant",
  kind: "file",
  text: "",
  links: [],
  at: null,
  file: { name, path: `/home/${name}` },
});

/** A fake page with three file messages; `fail(path)` decides what each file read does. */
function downloads(fail: (path: string) => unknown) {
  const reads: string[] = [];
  const cdp = {
    eval: async () => "away",
    call: async (fn: string, ...args: unknown[]) => {
      if (fn.includes("readAttachmentBytes")) {
        reads.push(String(args[1]));
        const r = fail(String(args[1]));
        if (r instanceof Error) throw r;
        return r ?? Buffer.from(`data ${args[1]}`).toString("base64");
      }
      if (args.length === 3) return [fileMessage("m1", "a.csv"), fileMessage("m2", "b.csv"), fileMessage("m3", "c.csv")];
      return [BOT];
    },
    send: async () => ({}),
  } as unknown as CDP;
  const link: Link = { mode: "pipe", connected: true, appVersion: "1.2.3", requireCdp: () => cdp, wake: async () => {} };
  const lines: string[] = [];
  const m = daemonMethods(link, { log: (l) => lines.push(l), wake: { waitMs: 30, pollMs: 5 } });
  return { m, reads, lines, dir: join(process.env.GROKLINK_HOME ?? "", "downloads", "Alpha") };
}
type Result = {
  files: { name: string; savedTo: string }[];
  partial?: true;
  error?: { code: string; message: string; retryAfterSec?: number; failedKey: string };
};

test("download: every file saved → no partial flag", async () => {
  const d = downloads(() => undefined);
  const r = (await d.m.download({ bot: "Alpha", keys: ["m1", "m2", "m3"] })) as Result;
  assert.deepEqual(
    r.files.map((f) => f.name),
    ["a.csv", "b.csv", "c.csv"],
  );
  assert.equal(r.partial, undefined);
  assert.equal(r.error, undefined);
});

test("download: a later file hits an asleep Bot → the saved files come back with partial: true and the bot_asleep error", async () => {
  const d = downloads((path) => (path === "/home/b.csv" ? { groklinkAsleep: "SAND_AWAY_PARK" } : undefined));
  const r = (await d.m.download({ bot: "Alpha", keys: ["m1", "m2", "m3"] })) as Result;
  assert.equal(r.partial, true);
  assert.deepEqual(
    r.files.map((f) => f.name),
    ["a.csv"],
  );
  assert.equal(readFileSync(r.files[0].savedTo, "utf8"), "data /home/a.csv");
  assert.deepEqual(r.error, {
    code: "bot_asleep",
    message: "Alpha's computer is asleep. Bring the Grok Bot window to the front, then try again in ~10 s.",
    retryAfterSec: 10,
    failedKey: "m2",
  });
  assert.deepEqual(readdirSync(d.dir), ["a.csv"]);
  assert.ok(!d.reads.includes("/home/c.csv"), "it stops at the failed file");
});

test("download: a later file fails for another reason → partial with that error; the first file failing still throws", async () => {
  const d = downloads((path) => (path === "/home/c.csv" ? new Error("Couldn't read /home/c.csv (too-large)") : undefined));
  const r = (await d.m.download({ bot: "Alpha", keys: ["m1", "m2", "m3"] })) as Result;
  assert.equal(r.partial, true);
  assert.deepEqual(
    r.files.map((f) => f.name),
    ["a.csv", "b.csv"],
  );
  assert.deepEqual(r.error, { code: "internal", message: "Couldn't read /home/c.csv (too-large)", failedKey: "m3" });
  const before = readdirSync(d.dir);
  const first = downloads((path) => (path === "/home/a.csv" ? { groklinkAsleep: "SAND_AWAY_PARK" } : undefined));
  await assert.rejects(
    Promise.resolve().then(() => first.m.download({ bot: "Alpha", keys: ["m1", "m2"] })),
    { code: "bot_asleep" },
  );
  assert.deepEqual(readdirSync(first.dir), before, "nothing new was saved");
});

// ---- 6. file_blocked through a symlink ----

test("file_blocked on a symlink names the link and says it points to a blocked location, never the target", () => {
  const user = join(home, "user");
  const state = join(user, ".groklink");
  mkdirSync(join(user, ".ssh"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(user, "work"), { recursive: true });
  writeFileSync(join(user, ".ssh", "id_ed25519"), "x");
  writeFileSync(join(user, "work", "server.pem"), "x");
  writeFileSync(join(user, "work", "plain.txt"), "x");
  const blockedBy = (file: string) => {
    try {
      checkAttachment(file, { home: user, stateHome: state });
      return null;
    } catch (e) {
      return e as ProtocolError & { rule?: string };
    }
  };
  const toFolder = join(user, "work", "notes.txt");
  symlinkSync(join(user, ".ssh", "id_ed25519"), toFolder);
  const a = blockedBy(toFolder);
  assert.equal(a?.code, "file_blocked");
  assert.equal(a?.rule, "credential_folder");
  assert.equal(
    a?.message,
    "Attachment notes.txt is a link that points to a blocked location (a file that is in a folder that holds keys or credentials) (rule credential_folder); Grok Link won't send it. Don't retry with the same file or a renamed copy. Nothing was sent.",
  );
  assert.ok(!a?.message.includes("id_ed25519") && !a?.message.includes(".ssh"), "the target isn't named");
  const toName = join(user, "work", "report.txt");
  symlinkSync(join(user, "work", "server.pem"), toName);
  const b = blockedBy(toName);
  assert.equal(b?.rule, "secret_name");
  assert.match(
    b?.message ?? "",
    /^Attachment report\.txt is a link that points to a blocked location \(a file that is a credential file by its name\) \(rule secret_name\)/,
  );
  assert.ok(!b?.message.includes("server.pem"));
  // A link whose own name is the problem, and a plain blocked file, keep the direct wording.
  const named = join(user, "work", "backup.key");
  symlinkSync(join(user, "work", "plain.txt"), named);
  assert.match(blockedBy(named)?.message ?? "", /^Attachment backup\.key is a credential file by its name \(rule secret_name\)/);
  assert.match(blockedBy(join(user, "work", "server.pem"))?.message ?? "", /^Attachment server\.pem is a credential file by its name/);
  // A link to an ordinary file is fine.
  const fine = join(user, "work", "alias.txt");
  symlinkSync(join(user, "work", "plain.txt"), fine);
  assert.equal(blockedBy(fine), null);
});

// ---- 7. asleep from the app's failure code, in the page ----

/** Runs a page function against a fake Grok Bot page: one Bot, a transcript and a file reader that can fail. */
function runPage(
  src: string,
  args: unknown[],
  page: { loadFailure?: unknown; readFile?: () => unknown; send?: () => unknown; stop?: () => unknown },
) {
  const row = { id: "b1", name: "Alpha", isRunning: true, runningSessionIds: [] };
  const snap = { loadState: page.loadFailure ? "failed" : "ready", failure: page.loadFailure ?? null, entries: [], hasOlder: false };
  const value = {
    roster: {
      createAgent() {},
      snapshots: { get: () => ({ agents: { rows: [row] }, agentsById: new Map([["b1", row]]) }) },
      interruptAgentRun: async () => page.stop?.(),
    },
    transcript: { snapshotsFor: () => ({ get: () => snap }), observeEntries: () => () => {}, load() {} },
    desktop: { readAttachmentBytes: async () => page.readFile?.() },
    sendJournal: { sendPrompt: async () => page.send?.() },
    accountSlot: "slot",
  };
  const element = { __reactFiberTest: { memoizedProps: { value }, return: null } };
  const context = {
    document: { querySelector: () => element },
    window: {},
    setTimeout,
    Date,
    Promise,
    btoa,
    atob,
    Uint8Array,
    Blob,
    Map,
    Set,
    Error,
  };
  // Values made in the other realm are copied, so they compare equal to plain objects here.
  const copy = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return (vm.runInNewContext(`(${src})`, context)(...args) as Promise<unknown>).then(copy);
}
const parkFailure = () =>
  Object.assign(new Error("box blocked"), { failure: { code: "sand-box-blocked", sandBoxBlockReason: "SAND_AWAY_PARK" } });

test("every parkable page function compiles", () => {
  const pages = PARKABLE_PAGES();
  assert.deepEqual(Object.keys(pages).sort(), ["download", "read", "send", "stop"]);
  for (const [name, src] of Object.entries(pages)) assert.equal(typeof vm.runInNewContext(`(${src})`, {}), "function", name);
});

test("page: the app's park failure code comes back as a parked value from read, download, send and stop", async () => {
  const p = PARKABLE_PAGES();
  const parked = { groklinkAsleep: "SAND_AWAY_PARK" };
  const fail = () => {
    throw parkFailure();
  };
  assert.deepEqual(await runPage(p.download, ["b1", "/home/a.csv", 1000], { readFile: fail }), parked);
  assert.deepEqual(await runPage(p.send, ["b1", "hi", []], { send: fail }), parked);
  assert.deepEqual(await runPage(p.stop, ["b1"], { stop: fail }), parked);
  // The transcript store reports the failure itself (not wrapped in an error).
  assert.deepEqual(
    await runPage(p.read, ["b1", 10, null], { loadFailure: { code: "sand-box-blocked", sandBoxBlockReason: "SAND_AWAY_PARK" } }),
    parked,
  );
  assert.throws(
    () => unparked(parked, "Alpha"),
    (e: unknown) => e instanceof BotAsleepError && e.bot === "Alpha",
  );
});

test("page: success and other failures are untouched, and text that merely mentions sleep is not a parked value", async () => {
  const p = PARKABLE_PAGES();
  assert.deepEqual(await runPage(p.read, ["b1", 10, null], {}), []);
  assert.equal(
    await runPage(p.download, ["b1", "/home/a.csv", 1000], { readFile: () => ({ kind: "bytes", bytes: [104, 105] }) }),
    btoa("hi"),
  );
  assert.equal(unparked("aGk=", "Alpha"), "aGk=");
  assert.deepEqual(unparked([], "Alpha"), []);
  await assert.rejects(
    runPage(p.download, ["b1", "/home/a.csv", 1000], {
      readFile: () => {
        throw Object.assign(new Error("gone"), { failure: { code: "not-found" } });
      },
    }),
    /Couldn't read \/home\/a\.csv from the Bot's computer: not-found: gone/,
  );
  // A file path and an error message that both say "asleep": still an ordinary error.
  await assert.rejects(
    runPage(p.download, ["b1", "/home/computer is asleep SAND_AWAY_PARK.csv", 1000], {
      readFile: () => {
        throw new Error("sand-box-blocked: put the Bot's computer to sleep (SAND_AWAY_PARK)");
      },
    }),
    /Couldn't read \/home\/computer is asleep SAND_AWAY_PARK\.csv/,
  );
  // A non-park sand-box block isn't asleep either.
  await assert.rejects(
    runPage(p.stop, ["b1"], {
      stop: () => {
        throw Object.assign(new Error("blocked"), { failure: { code: "sand-box-blocked", sandBoxBlockReason: "SAND_STARTING" } });
      },
    }),
    /Grok Bot couldn't stop the Bot/,
  );
});
