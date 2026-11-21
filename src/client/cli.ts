#!/usr/bin/env node
// groklink CLI: `groklink mcp` runs the stdio MCP server; the other commands call the daemon once and print JSON.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { statePaths } from "../daemon/state.ts";
import {
  loadPolicy,
  policyFileError,
  RULES,
  usageLimits,
  writeUsageLimit,
  writeXMode,
  X_MODES,
  type XMode,
  xMode,
} from "../shared/policy.ts";
import type { Method } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";
import { defaultEnv, install, installSkill, LABEL, uninstall } from "./install.ts";
import { serveMcp } from "./mcp.ts";
import { setup } from "./setup.ts";
import { call } from "./socket.ts";

const USAGE = `groklink ${VERSION}

Usage:
  groklink setup [--dry-run]                     First use: install, add the skill, wait for the daemon, run doctor
  groklink mcp                                   Run the MCP server on stdio
  groklink health [--deep]                       Daemon and app status (--deep: live checks through Grok Bot)
  groklink doctor [--send <bot>] [--json]        Check the whole path, one line per check; exit 0 = PASS
                                                 --send also gives <bot> a one-line test task (uses one Grok message)
  groklink bots                                  List Bots
  groklink task <bot> <brief…> [--schema file.json] [--file path]…
  groklink job <jobId> [--wait N]                Show a job, waiting up to N seconds (max 120)
  groklink jobs                                  List jobs
  groklink events [--since N]                    Events after seq N
  groklink install [--dry-run] [--replace-grokbot-bridge]
                                                 Run the daemon at login and register the MCP server in your clients
  groklink install --skill [--force] [--dry-run] Add the agent skill to ~/.claude/skills/groklink/ (only that)
  groklink uninstall [--dry-run]                 Undo install (keeps the state folder)
  groklink policy                                Show each safety rule and its mode
  groklink policy x_write <block|approve|allow>  How Bots may post to X: block (default), approve (you approve
                                                 each posting task in a dialog on this Mac) or allow; restarts the daemon
  groklink policy usage                          Show the usage limits (percent of weekly Grok usage)
  groklink policy usage warn <0-100>             Warn in health and doctor from this percent (default 80)
  groklink policy usage pause <1-100>            Refuse new tasks from this percent (default 100: only when used up);
                                                 both restart the daemon`;

class UsageError extends Error {}

/** Split argv into positionals and `--flag value` pairs (flags may repeat). */
function parse(args: string[], flags: string[]): { pos: string[]; opts: Record<string, string[]> } {
  const pos: string[] = [];
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!flags.includes(name)) throw new UsageError(`Unknown option ${a}.`);
    const v = args[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value.`);
    opts[name] = [...(opts[name] ?? []), v];
  }
  return { pos, opts };
}

function num(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${flag} must be a number.`);
  return n;
}

function request(cmd: string, args: string[]): [Method, Record<string, unknown>] {
  switch (cmd) {
    case "health": {
      const deep = args.includes("--deep");
      parse(
        args.filter((a) => a !== "--deep"),
        [],
      );
      return ["health", deep ? { deep: true } : {}];
    }
    case "bots":
    case "jobs":
      parse(args, []);
      return [cmd, {}];
    case "task": {
      const { pos, opts } = parse(args, ["schema", "file"]);
      if (pos.length < 2) throw new UsageError("task needs a bot and a brief.");
      const params: Record<string, unknown> = { bot: pos[0], brief: pos.slice(1).join(" ") };
      if (opts.file) params.files = opts.file.map((f) => resolve(f));
      if (opts.schema) {
        try {
          params.schema = JSON.parse(readFileSync(opts.schema[0], "utf8"));
        } catch (e) {
          throw new UsageError(`Can't read --schema ${opts.schema[0]}: ${(e as Error).message}`);
        }
      }
      return ["task", params];
    }
    case "job": {
      const { pos, opts } = parse(args, ["wait"]);
      if (pos.length !== 1) throw new UsageError("job needs one jobId.");
      return ["job", { jobId: pos[0], wait_seconds: num("wait", opts.wait?.[0]) }];
    }
    case "events": {
      const { pos, opts } = parse(args, ["since"]);
      if (pos.length) throw new UsageError("events takes no arguments besides --since.");
      return ["events", { since_seq: num("since", opts.since?.[0]) }];
    }
    default:
      throw new UsageError(cmd ? `Unknown command ${cmd}.` : "No command given.");
  }
}

// ---- doctor ----

type Check = { name: string; ok: boolean; warn?: boolean; ms?: number; detail: string };
const SEND_BRIEF = "Reply with only the word: pong";
const SEND_WAIT_MS = 120_000;
/** Longest single `job` wait while polling, so a reply is noticed quickly. */
const SEND_POLL_S = 15;

const line = (c: Check) => `${c.ok ? (c.warn ? "!" : "✓") : "✗"} ${c.name.padEnd(10)} ${c.detail}`;

/**
 * `--send <bot>`: one real task, passed as soon as a Bot reply in the job contains "pong", whatever the job's status
 * (a Bot can reply and then carry on with older work). Polls every 15 s at most, for up to 120 s. Never stops the job.
 */
async function sendCheck(bot: string): Promise<Check & { jobId?: string }> {
  const started = Date.now();
  let jobId: string | undefined;
  try {
    ({ jobId } = (await call("task", { bot, brief: SEND_BRIEF })) as { jobId: string });
    type Job = { status: string; messages?: { role: string; text: string }[]; error?: { code: string; message: string } | null };
    let job: Job = { status: "queued" };
    const replied = () => (job.messages ?? []).some((m) => m.role !== "user" && /pong/i.test(m.text));
    while (Date.now() - started < SEND_WAIT_MS) {
      const wait = Math.max(1, Math.min(SEND_POLL_S, Math.ceil((SEND_WAIT_MS - (Date.now() - started)) / 1000)));
      job = (await call("job", { jobId, wait_seconds: wait })) as Job;
      if (replied() || (job.status !== "queued" && job.status !== "working")) break;
    }
    const ms = Date.now() - started;
    if (replied()) {
      const still = job.status === "working" ? " (the Bot kept working on other tasks after replying)" : "";
      return { name: "send", ok: true, ms, detail: `${bot} replied pong (${Math.round(ms / 1000)} s)${still}`, jobId };
    }
    const why = job.error
      ? `${job.error.code}: ${job.error.message.split("\n")[0]}`
      : job.status === "done"
        ? "the reply had no pong"
        : job.status === "needs_input"
          ? "the Bot is waiting for input in Grok Bot (needs_input)"
          : job.status === "queued" || job.status === "working"
            ? `still ${job.status} after 120 s`
            : `the job ended ${job.status}`;
    return { name: "send", ok: false, ms, detail: `${bot}: ${why} (job ${jobId})`, jobId };
  } catch (e) {
    const { code = "internal", message } = e as { code?: string; message: string };
    return {
      name: "send",
      ok: false,
      ms: Date.now() - started,
      detail: `${code}: ${String(message).split("\n")[0]}`,
      ...(jobId ? { jobId } : {}),
    };
  }
}

type DeepHealth = { probe?: { ok: boolean; checks: Check[] }; warnings?: string[]; [k: string]: unknown };

/** Doctor's checks: deep health (read-only; nothing is sent), plus the policy line. Never throws. */
async function deepChecks(): Promise<{ health: DeepHealth | null; checks: Check[] }> {
  let health: DeepHealth | null = null;
  let checks: Check[];
  try {
    const h = (await call("health", { deep: true })) as DeepHealth;
    health = h;
    checks = h.probe?.checks ?? [
      {
        name: "daemon",
        ok: false,
        detail:
          "the running daemon is older than this CLI and has no deep health: update groklink, then restart the daemon (launchctl kickstart -k gui/$(id -u)/dev.groklink.daemon)",
      },
    ];
  } catch (e) {
    const { code = "internal", message } = e as { code?: string; message: string };
    checks = [{ name: "daemon", ok: false, detail: `${code}: ${String(message).split("\n")[0]}` }];
  }
  // How Bots may post to X; `!` when it's allowed without approval. Older daemons report a boolean.
  const policy = (health as DeepHealth | null)?.policy as Record<string, unknown> | null | undefined;
  if (health?.probe && policy && "x_write" in policy) {
    const mode = xMode({ x_write: policy.x_write }).mode;
    checks = [
      ...checks,
      {
        name: "policy",
        ok: true,
        ...(mode === "allow" ? { warn: true } : {}),
        detail: mode === "allow" ? "x_write: allow (Bots may post to X without approval)" : `x_write: ${mode}`,
      },
    ];
  }
  return { health, checks };
}

/** `groklink doctor`: deep health, one line per check, then PASS or FAIL: <first failed check>. Returns the exit code. */
async function doctor(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const { pos, opts } = parse(
    args.filter((a) => a !== "--json"),
    ["send"],
  );
  if (pos.length) throw new UsageError("doctor takes no arguments besides --send <bot> and --json.");
  const bot = opts.send?.[0];
  if (bot !== undefined && !bot.trim()) throw new UsageError("--send needs a Bot name.");
  const say = (s: string) => {
    if (!json) console.log(s);
  };

  const { health, checks: deep } = await deepChecks();
  let checks = deep;
  for (const c of checks) say(line(c));

  let send: (Check & { jobId?: string }) | undefined;
  if (bot !== undefined) {
    if (checks.every((c) => c.ok)) {
      say(`Sending one test task to ${bot} ("${SEND_BRIEF}"); this uses one Grok message.`);
      send = await sendCheck(bot);
    } else send = { name: "send", ok: false, detail: "skipped: fix the failed check first (nothing was sent)" };
    checks = [...checks, send];
    say(line(send));
  }

  const failed = checks.find((c) => !c.ok);
  if (json) console.log(JSON.stringify({ ...health, checks, ...(send ? { send } : {}), pass: !failed }, null, 2));
  else {
    for (const w of (health as DeepHealth | null)?.warnings ?? []) say(`  ${w}`);
    say(failed ? `FAIL: ${failed.name}` : "PASS");
  }
  return failed ? 1 : 0;
}

// ---- policy ----

/** `groklink policy`: each rule's mode as policy.json says (what the daemon applies after its next start). */
function showPolicy(file: string): void {
  const parsed = loadPolicy(file);
  const x = xMode(parsed);
  const on = (r: string) => !(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)[r] === false);
  console.log(`Policy: ${file}`);
  const broken = policyFileError(file);
  if (broken) console.log(`Can't read it (${broken}); the daemon treats every rule as on (x_write: block) until it's fixed.`);
  for (const r of RULES) console.log(`  ${r.padEnd(8)} ${r === "x_write" ? x.mode : on(r) ? "on" : "off"}`);
  showUsage(parsed);
  if (x.warning) console.log(x.warning);
}

/** The two usage limits, one line each. */
function showUsage(parsed: unknown): void {
  const u = usageLimits(parsed);
  console.log(`  usage    warn at ${u.warn}%, pause new tasks at ${u.pause}%${u.pause === 100 ? " (only when used up)" : ""}`);
  if (u.warning) console.log(u.warning);
}

/** Restart the daemon so a policy change applies. Returns the exit code. */
function restartDaemon(what: string): number {
  const uid = process.getuid?.() ?? 0;
  const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  if (r.status === 0) {
    console.log(`Restarted the daemon (launchctl kickstart -k gui/${uid}/${LABEL}) so the new ${what} applies.`);
    return 0;
  }
  console.log(`Couldn't restart the daemon with launchctl. Restart groklinkd yourself to apply the new ${what}.`);
  return 1;
}

/** `groklink policy usage <warn|pause> <percent>`: rewrite policy.json atomically (0600), then restart the daemon. */
function setUsage(file: string, key: string, value: string): number {
  if (key !== "warn" && key !== "pause") throw new UsageError("policy usage takes: warn <0-100> or pause <1-100>.");
  if (!/^\d{1,3}$/.test(value)) throw new UsageError(`${key} must be a whole number from ${key === "warn" ? 0 : 1} to 100.`);
  let limits: { warn: number; pause: number };
  try {
    limits = writeUsageLimit(file, key, Number(value));
  } catch (e) {
    if (e instanceof RangeError) throw new UsageError(e.message);
    throw e;
  }
  console.log(`Set usage ${key} to ${limits[key]}% in ${file} (warn at ${limits.warn}%, pause new tasks at ${limits.pause}%).`);
  return restartDaemon("limit");
}

/** `groklink policy x_write <mode>`: rewrite policy.json atomically (0600), then restart the daemon to apply it. */
function setXMode(file: string, mode: string): number {
  if (!(X_MODES as readonly string[]).includes(mode)) throw new UsageError(`x_write must be one of ${X_MODES.join(", ")}.`);
  writeXMode(file, mode as XMode);
  console.log(`Set x_write to ${mode} in ${file}.`);
  if (mode === "allow") console.log("Bots may now post to X without asking you.");
  if (mode === "approve") console.log("Tasks that would post to X now wait for you to click Approve in a dialog on this Mac.");
  return restartDaemon("mode");
}

const [cmd = "", ...args] = process.argv.slice(2);
if (cmd === "mcp") {
  serveMcp();
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(USAGE);
} else if (cmd === "policy") {
  try {
    const file = statePaths().policy;
    if (args.length === 0) {
      showPolicy(file);
      process.exit(0);
    }
    if (args[0] === "usage" && args.length === 1) {
      console.log(`Policy: ${file}`);
      showUsage(loadPolicy(file));
      process.exit(0);
    }
    if (args[0] === "usage" && args.length === 3) process.exit(setUsage(file, args[1], args[2]));
    if (args.length !== 2 || args[0] !== "x_write")
      throw new UsageError("policy takes no arguments, or: x_write <block|approve|allow>, usage, usage warn <0-100>, usage pause <1-100>.");
    process.exit(setXMode(file, args[1]));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`groklink policy: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "setup") {
  const bad = args.find((a) => a !== "--dry-run");
  if (bad !== undefined) {
    console.error(`Unknown option ${bad} (setup takes only --dry-run).\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    process.exit(
      await setup(
        {
          ...defaultEnv(),
          doctor: async () => (await deepChecks()).checks,
          bots: async () => ((await call("bots")) as { name: string }[]).map((b) => b.name),
        },
        { dryRun: args.includes("--dry-run") },
      ),
    );
  } catch (e) {
    console.error(`groklink setup: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "doctor") {
  try {
    process.exit(await doctor(args));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(`groklink doctor: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "install" && args.includes("--skill")) {
  const bad = args.find((a) => !["--skill", "--force", "--dry-run"].includes(a));
  if (bad !== undefined) {
    console.error(`Unknown option ${bad} (with --skill, only --force and --dry-run).\n\n${USAGE}`);
    process.exit(2);
  }
  process.exit(installSkill(defaultEnv(), { force: args.includes("--force"), dryRun: args.includes("--dry-run") }));
} else if (cmd === "install" || cmd === "uninstall") {
  const allowed = cmd === "install" ? ["--dry-run", "--replace-grokbot-bridge"] : ["--dry-run"];
  const bad = args.find((a) => !allowed.includes(a));
  if (bad !== undefined) {
    console.error(`Unknown option ${bad}.\n\n${USAGE}`);
    process.exit(2);
  }
  const opts = { dryRun: args.includes("--dry-run"), replaceGrokbotBridge: args.includes("--replace-grokbot-bridge") };
  try {
    process.exit(await (cmd === "install" ? install : uninstall)(defaultEnv(), opts));
  } catch (e) {
    console.error(`groklink ${cmd}: ${(e as Error).message}`);
    process.exit(1);
  }
} else {
  try {
    const [method, params] = request(cmd, args);
    console.log(JSON.stringify(await call(method, params), null, 2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    const { code = "internal", message, rule } = e as { code?: string; message: string; rule?: string };
    console.error(JSON.stringify({ error: { code, message, ...(rule ? { rule } : {}) } }, null, 2));
    process.exit(1);
  }
}
