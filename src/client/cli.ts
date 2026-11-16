#!/usr/bin/env node
// groklink CLI: `groklink mcp` runs the stdio MCP server; the other commands call the daemon once and print JSON.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Method } from "../shared/protocol.ts";
import { VERSION } from "../shared/version.ts";
import { defaultEnv, install, uninstall } from "./install.ts";
import { serveMcp } from "./mcp.ts";
import { call } from "./socket.ts";

const USAGE = `groklink ${VERSION}

Usage:
  groklink mcp                                   Run the MCP server on stdio
  groklink health                                Daemon and app status
  groklink bots                                  List Bots
  groklink task <bot> <brief…> [--schema file.json] [--file path]…
  groklink job <jobId> [--wait N]                Show a job, waiting up to N seconds (max 120)
  groklink jobs                                  List jobs
  groklink events [--since N]                    Events after seq N
  groklink install [--dry-run] [--replace-grokbot-bridge]
                                                 Run the daemon at login and register the MCP server in your clients
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
    case "health":
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

const [cmd = "", ...args] = process.argv.slice(2);
if (cmd === "mcp") {
  serveMcp();
} else if (cmd === "--version" || cmd === "-v") {
  console.log(VERSION);
} else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(USAGE);
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
