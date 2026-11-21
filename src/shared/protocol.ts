// Wire types for the groklinkd Unix socket: newline-delimited JSON, one request or response per line.

export const METHODS = [
  "health",
  "bots",
  "task",
  "job",
  "jobs",
  "events",
  "read",
  "stop",
  "download",
  "usage",
  "routines",
  "createBot",
  "updateBot",
  "deleteBot",
] as const;
export type Method = (typeof METHODS)[number];

export const ERROR_CODES = [
  "unauthorized",
  "bad_request",
  "not_connected",
  "not_found",
  "blocked_by_policy",
  "schema_invalid",
  "no_reply",
  "usage_exhausted",
  "usage_paused",
  "file_blocked",
  "dir_blocked",
  "bot_asleep",
  "no_files",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type TransportMode = "pipe" | "port0";

export type Request = { id: number; token: string; method: Method; params?: Record<string, unknown> };
/** `rule` is set for `blocked_by_policy` and `file_blocked`; `retryAfterSec` for `bot_asleep`. */
export type RpcError = { code: ErrorCode; message: string; rule?: string; retryAfterSec?: number };
/** `id` is null only when the request line couldn't be read far enough to find one. */
export type Response = { id: number | null; result: unknown } | { id: number | null; error: RpcError };

export type HealthResult = { ok: boolean; mode: TransportMode; connected: boolean; appVersion: string | null; uptimeSec: number };

/** An error that goes back to the client with its code. Anything else is sent as `internal`. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** How long to wait before retrying a call that failed because the Bot's computer was asleep. */
export const ASLEEP_RETRY_SEC = 10;

/** The Bot's computer is asleep (Grok Bot parks it while its window is in the background): expected and temporary. */
export class BotAsleepError extends ProtocolError {
  readonly retryAfterSec = ASLEEP_RETRY_SEC;
  readonly bot: string;

  constructor(bot: string) {
    super("bot_asleep", `${bot}'s computer is asleep. Bring the Grok Bot window to the front, then try again in ~${ASLEEP_RETRY_SEC} s.`);
    this.name = "BotAsleepError";
    this.bot = bot;
  }
}
