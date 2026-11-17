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
  "file_blocked",
  "dir_blocked",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type TransportMode = "pipe" | "port0";

export type Request = { id: number; token: string; method: Method; params?: Record<string, unknown> };
/** `rule` is set for `blocked_by_policy`. */
export type RpcError = { code: ErrorCode; message: string; rule?: string };
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
