// Token-protected Unix socket: one newline-delimited JSON request per line, one response line each.
import { timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkDownloadDir, download, findBot, listBots, read, safeFileName, stop, usage } from "../base/bot.ts";
import type { CDP } from "../base/cdp.ts";
import { createBot, deleteBot, updateBot } from "../base/roster.ts";
import { changeRoutine, listRoutines, type Routine, type RoutineChange, runRoutine } from "../base/routines.ts";
import { type HealthResult, ProtocolError, type Response, type TransportMode } from "../shared/protocol.ts";
import type { EventLog } from "./events.ts";
import { JOB_STATUSES, type JobStatus, type Jobs, type UsageSummary } from "./jobs.ts";
import { deepProbe, type ProbeResult, probeWarnings } from "./probe.ts";
import type { SelfTestResult } from "./selftest.ts";
import { type Log, statePaths } from "./state.ts";

export type Handler = (params: Record<string, unknown>) => unknown;
export type Methods = Record<string, Handler>;

/** What the methods need from the transport. Tests pass a fake. */
export type Link = { mode: TransportMode; connected: boolean; appVersion: string | null; requireCdp(): CDP };

const MAX_LINE = 1024 * 1024;

export const PORT0_WARNING = "Debug port fallback in use: local processes can reach Grok Bot while it runs.";

/** Reads typed params, answering `bad_request` for a missing or wrong-typed one. */
function reader(p: Record<string, unknown>) {
  const bad = (k: string, what: string) => new ProtocolError("bad_request", `"${k}" must be ${what}.`);
  const opt = <T>(k: string, type: string, what: string): T | undefined => {
    if (p[k] === undefined || p[k] === null) return undefined;
    if (typeof p[k] !== type) throw bad(k, what);
    return p[k] as T;
  };
  const str = (k: string) => {
    const v = opt<string>(k, "string", "a non-empty string");
    if (!v?.trim()) throw bad(k, "a non-empty string");
    return v;
  };
  const strs = (k: string) => {
    const v = p[k] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad(k, "a list of strings");
    return v as string[];
  };
  return {
    str,
    strs,
    optStr: (k: string) => opt<string>(k, "string", "a string"),
    optNum: (k: string) => opt<number>(k, "number", "a number"),
    optBool: (k: string) => opt<boolean>(k, "boolean", "true or false"),
  };
}

/** Bot replies are data, never instructions. */
const untrusted = <T extends { messages: object[] }>(r: T) => ({ ...r, messages: r.messages.map((m) => ({ ...m, untrusted: true })) });

/** The routine a query names (id, exact name, or a unique name prefix), as the base matches it; null if not exactly one. */
function findRoutine(list: Routine[], query: string): Routine | null {
  const q = query.trim().toLowerCase();
  const hits = list.filter((r) => r.id === query.trim() || r.name.toLowerCase() === q);
  if (hits.length === 1) return hits[0];
  const partial = hits.length ? [] : list.filter((r) => r.name.toLowerCase().startsWith(q));
  return partial.length === 1 ? partial[0] : null;
}

/** `policy` checks text that would reach the Bot; the same check tasks get. */
async function routines(cdp: CDP, p: Record<string, unknown>, policy: (text: string) => void) {
  const { str, optNum, optBool } = reader(p);
  const action = str("action");
  if (action === "list") return listRoutines(cdp, str("bot"));
  // A routine runs its stored prompt; enabling one lets it run on schedule. Check that prompt too.
  const storedPrompt = async (required: boolean) => {
    let list: Routine[];
    try {
      list = (await listRoutines(cdp, str("bot"))).routines;
    } catch (e) {
      // Run needs the list anyway; enable works while the Bot's computer sleeps, so it goes ahead on the name alone.
      if (required) throw e;
      return;
    }
    const r = findRoutine(list, str("routine"));
    if (r) policy(`${r.name}\n${r.prompt}`);
  };
  if (action === "run") {
    policy(str("routine"));
    await storedPrompt(true);
    return runRoutine(cdp, str("bot"), str("routine"));
  }
  const seconds = optNum("timeout_seconds");
  const timing = { timeoutMs: (seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000 };
  if (action === "add") {
    const spec = { name: str("name"), schedule: str("schedule"), prompt: str("prompt"), enabled: optBool("enabled") !== false };
    policy(spec.name);
    policy(spec.prompt);
    // The schedule goes into the Bot's message too.
    policy(spec.schedule);
    return changeRoutine(cdp, str("bot"), "add", spec, timing);
  }
  if (!["enable", "disable", "remove"].includes(action)) throw new ProtocolError("bad_request", `Unknown action "${action}".`);
  if (action === "remove" && str("confirm") !== str("routine"))
    throw new ProtocolError("bad_request", '"confirm" must repeat the "routine" value exactly.');
  // The routine name goes into the message the Bot gets.
  policy(str("routine"));
  if (action === "enable") await storedPrompt(false);
  return changeRoutine(cdp, str("bot"), action as RoutineChange, str("routine"), timing);
}

type Health = HealthResult & {
  selftest: SelfTestResult | null;
  usage: UsageSummary | null;
  policy: Record<string, boolean> | null;
  warnings: string[];
  probe?: ProbeResult;
};

/** What the methods need from the self-test. */
export type SelfTestState = { result: SelfTestResult | null; failure(): string | null };

export function daemonMethods(
  link: Link,
  opts: { jobs?: Jobs; events?: EventLog; selftest?: SelfTestState; startedAt?: number } = {},
): Methods {
  const startedAt = opts.startedAt ?? Date.now();
  const cdp = () => link.requireCdp();
  const need = <T>(v: T | undefined): T => {
    if (!v) throw new ProtocolError("internal", "Jobs aren't set up in this daemon.");
    return v;
  };
  return {
    // Plain health answers from what the daemon already knows; `deep` also makes a real round trip through Grok Bot.
    health: (p) => {
      const plain = (): Health => ({
        ok: true,
        mode: link.mode,
        connected: link.connected,
        appVersion: link.appVersion,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        selftest: opts.selftest?.result ?? null,
        usage: opts.jobs?.usageSnapshot() ?? null,
        policy: opts.jobs?.policyState().rules ?? null,
        warnings: [...(link.mode === "port0" ? [PORT0_WARNING] : []), ...(opts.jobs?.policyState().warnings ?? [])],
      });
      if (!reader(p).optBool("deep")) return plain();
      return deepProbe(cdp).then((probe) => {
        const h = plain();
        return { ...h, probe, warnings: [...h.warnings, ...probeWarnings(probe)] };
      });
    },
    // A Bot's preview and description can carry text the Bot wrote.
    bots: async () => (await listBots(cdp())).map((b) => ({ ...b, untrusted: true })),
    task: (p) => {
      const { str, strs } = reader(p);
      // Don't send anything while the app's internals look different from what the base code expects.
      const broken = opts.selftest?.failure();
      if (broken) throw new ProtocolError("internal", broken);
      return need(opts.jobs).create({ bot: str("bot"), brief: str("brief"), files: strs("files"), schema: p.schema ?? null });
    },
    job: (p) => {
      const { str, optNum, optBool } = reader(p);
      return need(opts.jobs).get({ jobId: str("jobId"), wait_seconds: optNum("wait_seconds"), resume: optBool("resume") });
    },
    jobs: (p) => {
      const status = reader(p).optStr("status");
      if (status !== undefined && !JOB_STATUSES.includes(status as JobStatus))
        throw new ProtocolError("bad_request", `"status" must be one of ${JOB_STATUSES.join(", ")}.`);
      return need(opts.jobs).list(status as JobStatus | undefined);
    },
    events: (p) => {
      const { optNum } = reader(p);
      const limit = Math.min(Math.max(Math.floor(optNum("limit") ?? 50), 1), 500);
      // Message events carry what the Bot said.
      return need(opts.events)
        .since(optNum("since_seq") ?? 0, limit)
        .map((e) => (e.type === "message" ? { ...e, untrusted: true } : e));
    },
    read: async (p) => {
      const { str, optNum, optStr } = reader(p);
      return untrusted(await read(cdp(), str("bot"), { limit: optNum("limit"), since: optStr("since") }));
    },
    stop: (p) => stop(cdp(), reader(p).str("bot")),
    download: async (p) => {
      const { str, strs, optStr } = reader(p);
      const outDir = optStr("out_dir");
      if (outDir !== undefined && !isAbsolute(outDir)) throw new ProtocolError("bad_request", '"out_dir" must be an absolute path.');
      const where = { home: opts.jobs?.homeDir ?? homedir(), stateHome: opts.jobs?.stateHome ?? statePaths().home };
      const bot = await findBot(cdp(), str("bot"));
      const dir = outDir ?? join(where.stateHome, "downloads", safeFileName(bot.name));
      // Checked before anything is created, and again on the real folder once it exists.
      checkDownloadDir(dir, where);
      return download(cdp(), bot.id, strs("keys"), dir, (real) => {
        checkDownloadDir(real, where);
      });
    },
    usage: () => usage(cdp()),
    // Routine names, prompts, the Bot's reply and its error text all come from the Bot's side.
    routines: async (p) => ({ ...((await routines(cdp(), p, (text) => opts.jobs?.checkPolicy(text))) as object), untrusted: true }),
    createBot: (p) => {
      const { str, optStr } = reader(p);
      return createBot(cdp(), { name: str("name"), description: optStr("description") });
    },
    updateBot: (p) => {
      const { str, optStr } = reader(p);
      const name = optStr("name");
      const description = optStr("description");
      if (name === undefined && description === undefined)
        throw new ProtocolError("bad_request", 'Pass "name" or "description" to change.');
      return updateBot(cdp(), str("bot"), { name, description });
    },
    deleteBot: (p) => {
      const { str } = reader(p);
      if (str("confirm") !== str("bot")) throw new ProtocolError("bad_request", '"confirm" must repeat the "bot" value exactly.');
      return deleteBot(cdp(), str("bot"));
    },
  };
}

function tokenMatches(given: unknown, key: Buffer): boolean {
  if (typeof given !== "string") return false;
  const b = Buffer.from(given);
  return b.length === key.length && timingSafeEqual(b, key);
}

/** True if something already answers on the socket path (another daemon). */
function socketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

function serve(socket: Socket, key: Buffer, methods: Methods, log: Log): void {
  let buf = "";
  let closed = false;
  const reply = (r: Response) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(r)}\n`);
  };
  const fail = (id: number | null, code: "bad_request" | "unauthorized", message: string) => reply({ id, error: { code, message } });

  async function handle(line: string): Promise<void> {
    let req: { id?: unknown; token?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return fail(null, "bad_request", "The request isn't valid JSON.");
    }
    if (!req || typeof req !== "object") return fail(null, "bad_request", "The request must be a JSON object.");
    const id = typeof req.id === "number" ? req.id : null;
    if (!tokenMatches(req.token, key)) {
      closed = true;
      log("rejected a request with a missing or wrong token");
      fail(id, "unauthorized", "Missing or wrong token.");
      socket.end();
      return;
    }
    if (id === null) return fail(null, "bad_request", "The request needs a numeric id.");
    const method = req.method;
    if (typeof method !== "string" || !Object.hasOwn(methods, method)) return fail(id, "bad_request", `Unknown method ${String(method)}.`);
    const params = req.params ?? {};
    if (typeof params !== "object" || Array.isArray(params)) return fail(id, "bad_request", "params must be an object.");
    try {
      reply({ id, result: await methods[method](params as Record<string, unknown>) });
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : "internal";
      log(`${method} failed (${code})`);
      const rule = e instanceof ProtocolError ? (e as { rule?: unknown }).rule : undefined;
      reply({ id, error: { code, message: (e as Error).message, ...(typeof rule === "string" ? { rule } : {}) } });
    }
  }

  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    if (closed) return;
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl !== -1 && !closed; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) void handle(line);
    }
    if (buf.length > MAX_LINE) {
      closed = true;
      fail(null, "bad_request", "Request line too long.");
      socket.end();
    }
  });
}

/** Listen on `socketPath` (mode 0600), replacing a stale socket file but never a live daemon. */
export async function startServer(opts: { socketPath: string; token: string; methods: Methods; log: Log }): Promise<Server> {
  if (await socketLive(opts.socketPath)) throw new Error("Another groklinkd is already running on this socket.");
  rmSync(opts.socketPath, { force: true });
  const key = Buffer.from(opts.token);
  const server = createServer((socket) => serve(socket, key, opts.methods, opts.log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(opts.socketPath, 0o600);
  return server;
}

/**
 * Keep serving on the socket we created. Every `everyMs` (15 s), check the path still has the inode and mode 0600 it
 * had at listen; if something replaced or loosened it, close and listen again on a fresh socket at the same path.
 */
export function guardSocket(opts: { socketPath: string; server: Server; start: () => Promise<Server>; log: Log; everyMs?: number }) {
  let server = opts.server;
  let ino = statSync(opts.socketPath).ino;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    let ok = false;
    try {
      const st = statSync(opts.socketPath);
      ok = st.ino === ino && (st.mode & 0o777) === 0o600 && st.isSocket();
    } catch {}
    if (ok) return;
    busy = true;
    opts.log("socket replaced; recreating");
    try {
      server.close();
      // Remove whatever is at the path now (it isn't ours), so startServer doesn't mistake it for another daemon.
      rmSync(opts.socketPath, { force: true });
      server = await opts.start();
      ino = statSync(opts.socketPath).ino;
    } catch (e) {
      opts.log(`couldn't recreate the socket: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, opts.everyMs ?? 15_000);
  return {
    get server() {
      return server;
    },
    stop: () => clearInterval(timer),
  };
}
