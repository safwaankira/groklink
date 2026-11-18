#!/usr/bin/env node
// groklink CLI: `groklink mcp` runs the stdio MCP server; the other commands call the daemon once and print JSON.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Method } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";
import { defaultEnv, install, installSkill, uninstall } from "./install.ts";
import { serveMcp } from "./mcp.ts";
import { call } from "./socket.ts";

const USAGE = `groklink ${VERSION}

Usage:
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
  groklink uninstall [--dry-run]                 Undo install (keeps the state folder)`;

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

const line = (c: Check) => `${c.ok ? (c.warn ? "!" : "✓") : "✗"} ${c.name.padEnd(10)} ${c.detail}`;

/** `--send <bot>`: one real task, passed only if a Bot reply within 120 s contains "pong". */
async function sendCheck(bot: string): Promise<Check & { jobId?: string }> {
  const started = Date.now();
  let jobId: string | undefined;
  try {
    ({ jobId } = (await call("task", { bot, brief: SEND_BRIEF })) as { jobId: string });
    type Job = { status: string; messages?: { role: string; text: string }[]; error?: { code: string; message: string } | null };
    let job: Job = { status: "queued" };
    while (Date.now() - started < SEND_WAIT_MS) {
      const wait = Math.max(1, Math.min(120, Math.ceil((SEND_WAIT_MS - (Date.now() - started)) / 1000)));
      job = (await call("job", { jobId, wait_seconds: wait })) as Job;
      if (job.status !== "queued" && job.status !== "working") break;
    }
    const ms = Date.now() - started;
    const replied = (job.messages ?? []).some((m) => m.role !== "user" && /pong/i.test(m.text));
    if (job.status === "done" && replied)
      return { name: "send", ok: true, ms, detail: `${bot} replied pong (${Math.round(ms / 1000)} s)`, jobId };
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

  type DeepHealth = { probe?: { ok: boolean; checks: Check[] }; warnings?: string[]; [k: string]: unknown };
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

const [cmd = "", ...args] = process.argv.slice(2);
if (cmd === "mcp") {
  serveMcp();
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(USAGE);
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
