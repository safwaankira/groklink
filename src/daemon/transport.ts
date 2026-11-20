// Owns the Grok Bot app and one long-lived CDP connection to its main window.
// pipe (default, chosen in research/R01-cdp-transport.md): CDP over fds 3/4, so no TCP port is opened.
// port0 (fallback, GROKLINK_TRANSPORT=port0): Chromium picks a free loopback port and writes it to
// DevToolsActivePort. The port is never logged.
// In pipe mode the app quits when the pipe closes, so the daemon owns its lifetime and relaunches it.
import { type ChildProcess, execFile, type StdioOptions, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { findApp, isRunning } from "../base/app.ts";
import { CDP, type CDPChannel, listTargets } from "../base/cdp.ts";
import { store } from "../base/page.ts";
import { ProtocolError, type TransportMode } from "../shared/protocol.ts";
import type { Log } from "./state.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `p`'s value, or `fallback` if it hasn't settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const MAIN_WINDOW = /app\.asar|\/renderer\/index\.html/;
const RETRY_MS = 5_000;
const WINDOW_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 500;
const READY_WAIT_MS = 30_000;
/** The window has loaded far enough for Bot methods once both stores the base page code needs resolve. */
const STORES_READY = `!!(${store("roster", "createAgent")}) && !!(${store("transcript", "snapshotsFor")})`;

export function transportMode(): TransportMode {
  return process.env.GROKLINK_TRANSPORT === "port0" ? "port0" : "pipe";
}

function appPath(): string {
  return process.env.GROKLINK_APP || findApp();
}

function binaryOf(app: string): string {
  return process.platform === "darwin" ? join(app, "Contents/MacOS/Grok Bot") : app;
}

/** CFBundleShortVersionString on macOS; null elsewhere (untested platforms). */
async function readAppVersion(app: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents/Info.plist")]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Same steps as the base's quit() in src/base/app.ts, which isn't exported.
async function quitApp(): Promise<void> {
  if (!(await isRunning())) return;
  if (process.platform === "darwin") await run("osascript", ["-e", `tell application "Grok Bot" to quit`]).catch(() => {});
  else if (process.platform === "win32") await run("taskkill", ["/IM", "Grok Bot.exe"]).catch(() => {});
  else await run("pkill", ["-TERM", "-f", "grok-bot|Grok Bot"]).catch(() => {});
  for (let i = 0; i < 40 && (await isRunning()); i++) await sleep(250);
  if (await isRunning()) throw new Error("Grok Bot didn't quit");
}

type TargetInfo = { targetId: string; type: string; url: string };
const isMainWindow = (t: { type: string; url: string }) => t.type === "page" && MAIN_WINDOW.test(t.url);

/** macOS: the reopen event a Dock click sends, which brings back a closed main window. */
async function reopenApp(): Promise<void> {
  if (process.platform === "darwin") await run("open", ["-a", appPath()]).catch(() => {});
}

export type WindowRecovery = {
  getTargets(): Promise<{ type: string; url: string }[]>;
  reopen(): Promise<void>;
  relaunch(): Promise<void>;
  log: Log;
  tries?: number;
  waitMs?: number;
  pollMs?: number;
};

/**
 * The app is running but may have no main window (the user closed it with Cmd+W). Ask it to reopen the
 * window, as a Dock click does; if it's still gone after `tries` attempts, quit and relaunch the app.
 * Does nothing while a main window exists.
 */
export async function recoverWindow(o: WindowRecovery): Promise<"present" | "back" | "relaunched"> {
  const hasWindow = async () => (await o.getTargets()).some(isMainWindow);
  if (await hasWindow()) return "present";
  for (let i = 0; i < (o.tries ?? 2); i++) {
    o.log("window closed; reopening");
    await o.reopen();
    for (const deadline = Date.now() + (o.waitMs ?? 10_000); Date.now() < deadline; ) {
      await sleep(o.pollMs ?? 500);
      if (await hasWindow()) {
        o.log("window back");
        return "back";
      }
    }
  }
  o.log("window still gone; relaunching");
  await o.relaunch();
  return "relaunched";
}

/** Electron's userData folder, where port-0 mode writes DevToolsActivePort. Windows/Linux untested. */
function userDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library/Application Support/Grok Bot");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "Grok Bot");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Grok Bot");
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Session = { message: ((text: string) => void)[]; close: (() => void)[] };

/** The browser end of --remote-debugging-pipe: `\0`-framed JSON, with page sessions routed by sessionId. */
class PipeConnection {
  closed = false;
  private toApp: Writable;
  private buf = "";
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, Session>();

  constructor(toApp: Writable, fromApp: Readable) {
    this.toApp = toApp;
    fromApp.setEncoding("utf8");
    fromApp.on("data", (chunk: string) => {
      this.buf += chunk;
      for (let end = this.buf.indexOf("\0"); end !== -1; end = this.buf.indexOf("\0")) {
        const frame = this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 1);
        this.dispatch(frame);
      }
    });
    fromApp.on("close", () => this.close());
    fromApp.on("error", () => this.close());
    toApp.on("error", () => this.close());
  }

  private dispatch(frame: string): void {
    let msg: {
      id?: number;
      method?: string;
      sessionId?: string;
      params?: { sessionId?: string };
      result?: unknown;
      error?: { message: string };
    };
    try {
      msg = JSON.parse(frame);
    } catch {
      return;
    }
    if (msg.sessionId) {
      for (const cb of this.sessions.get(msg.sessionId)?.message ?? []) cb(frame);
      return;
    }
    if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
      this.endSession(msg.params.sessionId);
      return;
    }
    const p = msg.id ? this.pending.get(msg.id) : undefined;
    if (!p || msg.id === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private write(msg: object): void {
    if (this.closed) throw new Error("CDP connection closed");
    this.toApp.write(`${JSON.stringify(msg)}\0`);
  }

  /** A browser-level command (no session). */
  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no reply within ${REQUEST_TIMEOUT_MS / 1000} s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** A CDP channel for one attached target: outgoing messages get its sessionId, replies are routed back. */
  session(sessionId: string): CDPChannel {
    const s: Session = { message: [], close: [] };
    this.sessions.set(sessionId, s);
    return {
      send: (text) => {
        if (!this.sessions.has(sessionId)) throw new Error("CDP connection closed");
        this.write({ ...JSON.parse(text), sessionId });
      },
      onMessage: (cb) => s.message.push(cb),
      onClose: (cb) => s.close.push(cb),
      close: () => {
        if (!this.sessions.has(sessionId)) return;
        this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        this.endSession(sessionId);
      },
    };
  }

  private endSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    for (const cb of s.close) cb();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    for (const id of [...this.sessions.keys()]) this.endSession(id);
    this.toApp.destroy();
  }
}

export type TransportOptions = {
  /** Replaces launching the app and opening CDP. Tests pass a fake. */
  open?: () => Promise<CDP>;
  readyPollMs?: number;
};

export class Transport {
  readonly mode: TransportMode;
  appVersion: string | null = null;
  private log: Log;
  private opts: TransportOptions;
  private cdp: CDP | null = null;
  private child: ChildProcess | null = null;
  private pipe: PipeConnection | null = null;
  private timer: NodeJS.Timeout | null = null;
  private connecting = false;
  private stopped = false;

  constructor(mode: TransportMode, log: Log, opts: TransportOptions = {}) {
    this.mode = mode;
    this.log = log;
    this.opts = opts;
  }

  /** True once the main window's stores are ready, not just when CDP is open. */
  get connected(): boolean {
    return this.cdp !== null;
  }

  /** The live, ready connection to the main window, or a `not_connected` error. */
  requireCdp(): CDP {
    if (this.cdp) return this.cdp;
    if (this.connecting) throw new ProtocolError("not_connected", "Grok Bot is starting; try again in a few seconds.");
    throw new ProtocolError("not_connected", "groklinkd isn't connected to Grok Bot yet. It retries every 5 s; check daemon.log.");
  }

  /**
   * Bring the Grok Bot window to the front, the way the app is woken by hand: Grok Bot parks a Bot's computer
   * ("away") while its window has been unfocused for 10 minutes, and wakes it once the window is focused again.
   * CDP's Page.bringToFront first, then the macOS reopen/activate a Dock click sends. This takes focus from the user.
   */
  async wake(): Promise<void> {
    await this.cdp?.send("Page.bringToFront").catch(() => {});
    await reopenApp();
  }

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.cdp?.close();
    this.cdp = null;
    this.pipe?.close();
    // Port-0 mode leaves a debug port open while the app runs, so quit it with the daemon.
    if (this.mode === "port0" && this.child && this.child.exitCode === null) await quitApp().catch(() => {});
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.cdp) return;
    this.connecting = true;
    try {
      const cdp = this.opts.open ? await this.opts.open() : this.mode === "pipe" ? await this.connectPipe() : await this.connectPort0();
      await this.whenReady(cdp);
      this.cdp = cdp;
      this.log(`connected (${this.mode}, Grok Bot ${this.appVersion ?? "unknown version"})`);
    } catch (e) {
      this.log(`connect failed: ${(e as Error).message}`);
      this.retry();
    } finally {
      this.connecting = false;
    }
  }

  /** Poll the page until the roster and transcript stores resolve (the window is still loading right after connect). */
  private async whenReady(cdp: CDP): Promise<void> {
    const deadline = Date.now() + READY_WAIT_MS;
    for (;;) {
      try {
        if (await within(cdp.eval<boolean>(STORES_READY), Math.max(deadline - Date.now(), 0), false)) return;
      } catch (e) {
        if (/CDP connection closed/.test(String(e))) throw e;
      }
      if (this.stopped || Date.now() >= deadline) break;
      await sleep(this.opts.readyPollMs ?? READY_POLL_MS);
    }
    cdp.close();
    throw new Error(`Grok Bot's stores weren't ready within ${READY_WAIT_MS / 1000} s`);
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, RETRY_MS);
  }

  private lost(cdp: CDP | null, reason: string): void {
    if (this.stopped || (cdp && this.cdp !== cdp)) return;
    if (this.cdp) this.log(`disconnected: ${reason}`);
    this.cdp = null;
    this.retry();
  }

  private appAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Quit any running copy and spawn the binary directly, so its exit (including the user quitting it) is seen. */
  private async launch(args: string[], stdio: StdioOptions): Promise<ChildProcess> {
    const app = appPath();
    await quitApp();
    this.appVersion = await readAppVersion(app);
    const child = spawn(binaryOf(app), args, { stdio });
    child.on("error", (e) => {
      this.log(`app spawn error: ${e.message}`);
      if (this.child === child) this.child = null;
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      this.log(`app exited (code ${code}, signal ${signal})`);
      this.lost(null, "app exited");
    });
    this.child = child;
    this.log(`launched Grok Bot (${this.mode})`);
    return child;
  }

  private async openPipe(): Promise<PipeConnection> {
    this.pipe?.close();
    const child = await this.launch(["--remote-debugging-pipe"], ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    this.pipe = new PipeConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    return this.pipe;
  }

  private async connectPipe(): Promise<CDP> {
    const targets = async () => (await (this.pipe as PipeConnection).send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos;
    if (!this.appAlive() || !this.pipe || this.pipe.closed) await this.openPipe();
    // Reconnecting to a running app: its window may have been closed.
    else
      await recoverWindow({
        getTargets: targets,
        reopen: reopenApp,
        relaunch: async () => {
          await this.openPipe();
        },
        log: this.log,
      });
    const pipe = this.pipe as PipeConnection;
    let page: TargetInfo | undefined;
    for (const deadline = Date.now() + WINDOW_WAIT_MS; !page && Date.now() < deadline; ) {
      page = (await targets()).find(isMainWindow);
      if (!page) await sleep(500);
    }
    if (!page) throw new Error("no Grok Bot main window on the pipe");
    const { sessionId } = await pipe.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const channel = pipe.session(sessionId);
    const cdp = new CDP(channel);
    channel.onClose?.(() => this.lost(cdp, "main window detached"));
    return cdp;
  }

  private async connectPort0(): Promise<CDP> {
    const file = join(userDataDir(), "DevToolsActivePort");
    if (!this.appAlive()) {
      rmSync(file, { force: true });
      await this.launch(["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], "ignore");
    }
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) {
      try {
        port = Number(readFileSync(file, "utf8").split("\n")[0]) || 0;
      } catch {}
      if (!port) await sleep(250);
    }
    if (!port) throw new Error("Grok Bot never wrote DevToolsActivePort");
    // Errors from here on may name the port, so they're replaced with fixed text.
    let url: string | undefined;
    for (const deadline = Date.now() + WINDOW_WAIT_MS; !url && Date.now() < deadline; ) {
      url = (await listTargets(port))?.find((t) => t.type === "page" && MAIN_WINDOW.test(t.url))?.webSocketDebuggerUrl;
      if (!url) await sleep(500);
    }
    if (!url) throw new Error("no Grok Bot main window on the debug port");
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("couldn't open the CDP WebSocket")), { once: true });
    });
    const cdp = new CDP({
      send: (text) => ws.send(text),
      onMessage: (cb) => ws.addEventListener("message", (ev) => cb(String(ev.data))),
      onClose: (cb) => ws.addEventListener("close", () => cb()),
      close: () => ws.close(),
    });
    ws.addEventListener("close", () => this.lost(cdp, "debug WebSocket closed"));
    return cdp;
  }
}
