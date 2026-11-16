// Grok Link's state folder ($GROKLINK_HOME or ~/.groklink): socket, token, policy, jobs, events and log.
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = { home: string; socket: string; token: string; policy: string; jobs: string; events: string; log: string };

export function statePaths(home = process.env.GROKLINK_HOME || join(homedir(), ".groklink")): Paths {
  return {
    home,
    socket: join(home, "groklink.sock"),
    token: join(home, "token"),
    policy: join(home, "policy.json"),
    jobs: join(home, "jobs"),
    events: join(home, "events.jsonl"),
    log: join(home, "daemon.log"),
  };
}

/** Create the folder (0700) and the token (0600) if missing, tighten both modes, and return the token. */
export function ensureState(paths = statePaths()): { paths: Paths; token: string } {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  try {
    writeFileSync(paths.token, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  chmodSync(paths.token, 0o600);
  const token = readFileSync(paths.token, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${paths.token} isn't a 64-character hex token. Delete it and restart groklinkd.`);
  return { paths, token };
}

export type Log = (line: string) => void;

/** Append timestamped lines to daemon.log. Callers pass fixed text only: never the token, the port or message text. */
export function logger(file: string): Log {
  return (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {}
  };
}
