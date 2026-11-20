// Thin client for the groklinkd socket: one request per connection, authenticated with the token file.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { statePaths } from "../daemon/state.ts";
import { type ErrorCode, type Method, ProtocolError, type Response } from "../shared/protocol.ts";

const NOT_RUNNING =
  "Grok Link daemon isn't running. Start it with: groklink install (or launchctl kickstart gui/$(id -u)/dev.groklink.daemon)";

/**
 * The daemon's error as a ProtocolError. A policy or file block keeps its `rule`, and a `bot_asleep` error its
 * `retryAfterSec`, both as fields and as `rule: <name>` / `retryAfterSec: <n>` lines in the message, so MCP clients
 * (which see only the text) get them too.
 */
function daemonError(e: { code: string; message: string; rule?: unknown; retryAfterSec?: unknown }): ProtocolError {
  const rule = typeof e.rule === "string" ? e.rule : undefined;
  const retryAfterSec = typeof e.retryAfterSec === "number" ? e.retryAfterSec : undefined;
  const lines = [
    e.message,
    ...(rule ? [`rule: ${rule}`] : []),
    ...(retryAfterSec !== undefined ? [`retryAfterSec: ${retryAfterSec}`] : []),
  ];
  const err = new ProtocolError(e.code as ErrorCode, lines.join("\n"));
  return Object.assign(err, rule ? { rule } : {}, retryAfterSec !== undefined ? { retryAfterSec } : {});
}

/** Send one request to the daemon and return its result, or throw a ProtocolError with the daemon's `{ code, message }`. */
export async function call(method: Method, params: Record<string, unknown> = {}, paths = statePaths()): Promise<unknown> {
  let token: string;
  try {
    token = readFileSync(paths.token, "utf8").trim();
  } catch {
    throw new ProtocolError("not_connected", NOT_RUNNING);
  }
  return new Promise((resolve, reject) => {
    const c = createConnection(paths.socket);
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      c.destroy();
      fn();
    };
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${JSON.stringify({ id: 1, token, method, params })}\n`));
    c.on("error", (e: NodeJS.ErrnoException) => {
      const missing = e.code === "ENOENT" || e.code === "ECONNREFUSED";
      finish(() => reject(missing ? new ProtocolError("not_connected", NOT_RUNNING) : new ProtocolError("internal", e.message)));
    });
    c.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let res: Response;
      try {
        res = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(() => reject(new ProtocolError("internal", "The daemon sent a reply that isn't valid JSON.")));
      }
      if ("error" in res) finish(() => reject(daemonError(res.error)));
      else finish(() => resolve(res.result));
    });
    c.on("close", () => finish(() => reject(new ProtocolError("not_connected", "The daemon closed the connection before replying."))));
  });
}
