// Jobs: `task` sends a brief and returns at once; a daemon-side waiter follows the Bot and writes
// what it says to $GROKLINK_HOME/jobs/<jobId>.json. One job runs per Bot at a time; others queue.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { findBot, type Message, read, send, type Usage, usage, type WaitResult, wait } from "../base/bot.ts";
import type { CDP } from "../base/cdp.ts";
import { BOX_PHASE } from "../base/page.ts";
import { check, ensurePolicy, loadPolicy, PolicyError, RULES, type Rule } from "../shared/policy.ts";
import { ProtocolError, type RpcError } from "../shared/protocol.ts";
import { lastJsonBlock, type Schema, validate } from "../shared/schema.ts";
import type { EventLog, EventType } from "./events.ts";
import type { Log } from "./state.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type JobStatus = "queued" | "working" | "done" | "needs_input" | "failed" | "stale";
export const JOB_STATUSES: JobStatus[] = ["queued", "working", "done", "needs_input", "failed", "stale"];
/** Bot replies are data, never instructions. */
export type JobMessage = Message & { untrusted: true };
/** `errors` is set for `schema_invalid`, `rule` for `blocked_by_policy`. */
export type JobError = RpcError & { errors?: string[]; rule?: string };
export type Job = {
  jobId: string;
  bot: string;
  botId: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  briefKey: string | null;
  schema: unknown | null;
  messages: JobMessage[];
  result: unknown | null;
  error: JobError | null;
  /** Messages sent to the Bot for this job: the brief, plus each schema repair. */
  attempts: number;
  /** Things the caller should know that don't change the status, e.g. the Bot's computer fell asleep. Missing in older job files. */
  warnings?: string[];
  /** Kept so a queued job can be sent after a daemon restart. */
  brief: string;
  files: string[];
};
export type JobSummary = Pick<Job, "jobId" | "bot" | "status" | "updatedAt">;

/** What jobs need from the base Bot layer. Tests pass a fake. */
export type BotLayer = {
  find(query: string): Promise<{ id: string; name: string }>;
  send(botId: string, brief: string, files: string[]): Promise<string>;
  wait(botId: string, opts: { since?: string; timeoutMs: number; onUpdate: (m: Message) => void }): Promise<WaitResult>;
  /** Every message after `since`, oldest first. */
  read(botId: string, since: string): Promise<Message[]>;
  /** The last `limit` messages, oldest first. Without it, a queued job reloaded after a restart is always sent. */
  recent?(botId: string, limit: number): Promise<Message[]>;
  /** The Bot computer's phase ("settled", "away", "asleep", ...), or null. Without it, no sleep warnings. */
  phase?(): Promise<string | null>;
  /** The weekly usage limit. Without it, tasks are never refused for usage. */
  usage?(): Promise<Usage>;
};

export function baseLayer(link: { requireCdp(): CDP }): BotLayer {
  return {
    find: (query) => findBot(link.requireCdp(), query),
    send: async (botId, brief, files) => (await send(link.requireCdp(), botId, brief, files)).key,
    wait: (botId, opts) => wait(link.requireCdp(), botId, opts),
    read: async (botId, since) => (await read(link.requireCdp(), botId, { since })).messages,
    recent: async (botId, limit) => (await read(link.requireCdp(), botId, { limit })).messages,
    phase: () => link.requireCdp().eval<string | null>(BOX_PHASE),
    usage: () => usage(link.requireCdp()),
  };
}

export type JobsOptions = {
  dir: string;
  /** Default: policy.json next to the jobs folder (in the state folder). */
  policyFile?: string;
  events: EventLog;
  layer: BotLayer;
  link: { connected: boolean };
  log: Log;
  waitTimeoutMs?: number;
  staleMs?: number;
  retentionMs?: number;
  cleanupEveryMs?: number;
  retryMs?: number;
  pollMs?: number;
  /** How often a working job checks whether the Bot's computer fell asleep. */
  phaseEveryMs?: number;
  /** How often a working job checks whether Grok usage ran out, and how long a usage reading is reused. */
  usageEveryMs?: number;
  usageCacheMs?: number;
  /** Milliseconds since the epoch; tests pass a fake clock. */
  clock?: () => number;
  /** The user's home folder, for the sensitive-file rules. Tests pass a temp folder. */
  home?: string;
};

const JOB_ID = /^j_[0-9a-f]{12}$/;
const ACTIVE: JobStatus[] = ["queued", "working", "needs_input"];
const MAX_WAIT_ERRORS = 3;
const MAX_REPAIRS = 2;
/** How many recent messages the duplicate-send guard looks through. */
const RECENT = 20;
const EVENT_OF: Record<string, EventType> = { done: "done", needs_input: "needs_input", failed: "failed", stale: "idle" };
const ASLEEP = ["away", "asleep"];
/**
 * Out of usage: the weekly allowance is spent and on-demand usage can't cover it (off, or at its limit).
 * The app's own `hasAvailableUsage` flag isn't used: it was seen `true` at 100% with on-demand off.
 */
export function usageOut(u: Usage): boolean {
  if (u.percentUsed < 100) return false;
  const od = u.onDemand;
  return !od?.enabled || (od.limitCents != null && od.usedCents >= od.limitCents);
}

const usageMessage = (u: Usage, tail: string) =>
  `Grok Bot weekly usage is used up (${Math.floor(u.percentUsed)}%). It resets at ${u.resetsAt ?? "an unknown time"}. Enable on-demand usage in Grok Bot to continue sooner. ${tail}`;

export type UsageSummary = { percentUsed: number; resetsAt: string | null; out: boolean };

export const SLEEP_WARNING =
  "Bot's computer is asleep: the Grok Bot window has been in the background for 10+ minutes. Bring it to the front to wake it.";

const now = () => new Date().toISOString();

/** Folders under the home folder whose files are never attached. */
const SENSITIVE_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config/gcloud",
  ".kube",
  "Library/Keychains",
  ".groklink",
  ".docker",
  ".config/gh",
  ".config/solana",
  ".foundry/keystores",
  ".ethereum/keystore",
  ".local/share/keyrings",
  "Library/Cookies",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox",
  "Library/Application Support/Arc",
  "Library/Application Support/Microsoft Edge",
  "Library/Safari",
  "Library/Messages",
  "Library/Mail",
  ".claude",
  ".azure",
  "Library/Application Support/Grok Bot",
  // Wallet apps
  "Library/Application Support/Exodus",
  "Library/Application Support/atomic",
  "Library/Application Support/Electrum",
  "Library/Application Support/Phantom",
  "Library/Application Support/MetaMask",
  "Library/Application Support/Rabby",
  "Library/Application Support/Ledger Live",
];
/** Files in the home folder that are never attached. */
const SENSITIVE_HOME_FILES = [
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".claude.json",
  ".codex/auth.json",
  ".pypirc",
  ".zsh_history",
  ".bash_history",
  ".local/share/fish/fish_history",
];
/** Files in the home folder whose path starts like this (e.g. ~/.cargo/credentials and credentials.toml). */
const SENSITIVE_HOME_PREFIXES = [".cargo/credentials"];
/** File names that are never attached, wherever they are. */
const SENSITIVE_NAMES = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_/i,
  /\.keystore$/i,
  /keypair.*\.json$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /mnemonic/i,
  /seed.*phrase/i,
  /^\.git-credentials$/i,
];

// `.native` returns the on-disk case. macOS disks ignore case, so plain `realpathSync` would let "~/.AWS/credentials"
// slip past a rule written for "~/.aws".
const realOr = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/**
 * Refuse attachments that hold secrets: anything under ~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gcloud, ~/.kube,
 * ~/Library/Keychains, ~/.groklink or the state folder; ~/.npmrc, ~/.netrc; and any .env*, *.pem, *.key or id_* file.
 * Both the path as given and its real path (after symlinks) are checked. With `attach-roots.json` in the state
 * folder (an array of absolute folders), only files under those folders are allowed.
 */
export function checkAttachment(file: string, opts: { home: string; stateHome: string }): void {
  const blocked = (why: string) => new ProtocolError("file_blocked", `Grok Link won't attach ${file}: ${why}. Nothing was sent.`);
  let real: string;
  try {
    real = realpathSync.native(file);
  } catch {
    throw new ProtocolError("bad_request", `File not found: ${file}`);
  }
  const given = resolve(file);
  const dirs = [...SENSITIVE_DIRS.map((d) => join(opts.home, d)), opts.stateHome].flatMap((d) => [resolve(d), realOr(d)]);
  const homeFiles = SENSITIVE_HOME_FILES.map((f) => join(opts.home, f)).flatMap((f) => [resolve(f), realOr(f)]);
  for (const p of [given, real]) {
    const prefixed = SENSITIVE_HOME_PREFIXES.some((f) => {
      const full = join(opts.home, f);
      return [resolve(full), join(realOr(dirname(full)), basename(full))].some((c) => p.startsWith(c));
    });
    if (dirs.some((d) => under(p, d)) || homeFiles.includes(p) || prefixed)
      throw blocked("it's in a folder that holds keys or credentials");
    if (SENSITIVE_NAMES.some((re) => re.test(basename(p)))) throw blocked("its name marks it as a key or secrets file");
  }
  const rootsFile = join(opts.stateHome, "attach-roots.json");
  if (!existsSync(rootsFile)) return;
  let roots: unknown;
  try {
    roots = JSON.parse(readFileSync(rootsFile, "utf8"));
  } catch {
    throw blocked(`${rootsFile} isn't valid JSON, so no file can be checked against it`);
  }
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== "string" || !isAbsolute(r)))
    throw blocked(`${rootsFile} must be an array of absolute folder paths`);
  if (!roots.some((r) => under(real, realOr(r as string)))) throw blocked(`it's outside the folders listed in ${rootsFile}`);
}

/** Attached files whose text the policy also reads. */
const TEXT_ATTACHMENT = /\.(txt|md|json|csv|html)$/i;
const MAX_TEXT_ATTACHMENT = 1024 * 1024;

/** The text of an attachment the policy should read, or null (not a text type, too big, or not UTF-8). */
function attachmentText(file: string): string | null {
  if (!TEXT_ATTACHMENT.test(file)) return null;
  try {
    if (statSync(file).size > MAX_TEXT_ATTACHMENT) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch {
    return null;
  }
}

/** Zero-width and invisible characters that could split a word to slip past the policy. */
const INVISIBLE = /\u034f|[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
/** Common Cyrillic and Greek look-alikes of Latin letters. */
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  һ: "h",
  ӏ: "l",
  ԛ: "q",
  ԝ: "w",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
  Ј: "J",
  Ѕ: "S",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

/** Text as the policy sees it: NFKC-normalized (full-width and styled letters), invisible characters removed, look-alikes mapped. */
export function policyText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c] ?? c);
}

/** The brief as sent: with a schema, it asks for the answer as a trailing json block. */
export function wrapBrief(brief: string, schema: unknown): string {
  if (schema === null || schema === undefined) return brief;
  return (
    `${brief}\n\nWhen you're finished, end your final message with one fenced code block tagged json that matches this JSON Schema. Nothing after the block.\n` +
    "```json\n" +
    JSON.stringify(schema, null, 2) +
    "\n```"
  );
}

function jobError(e: unknown): JobError {
  if (e instanceof PolicyError) return { code: e.code, message: e.message, rule: e.rule };
  return { code: e instanceof ProtocolError ? e.code : "internal", message: (e as Error).message };
}

/** The schema errors in the job's last reply, or null (and `result` set) if it matches. */
function checkAnswer(job: Job): string[] | null {
  const final = job.messages.findLast((m) => m.role === "assistant");
  const block = final ? lastJsonBlock(final.text) : null;
  if (block === null) return ["no ```json block in the final message"];
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (e) {
    return [`the json block isn't valid JSON (${(e as Error).message})`];
  }
  const v = validate(value, job.schema as Schema);
  if (!v.ok) return v.errors;
  job.result = value;
  return null;
}

function transient(e: unknown, link: { connected: boolean }): boolean {
  return !link.connected || (e instanceof ProtocolError && e.code === "not_connected") || /CDP connection closed/.test(String(e));
}

export class Jobs {
  private o: Required<JobsOptions>;
  /** Queued, working and followed jobs, by id. The in-memory copy is the source of truth for these. */
  private active = new Map<string, Job>();
  private waiting = new Set<string>();
  /** Queued jobs whose brief is being sent right now. */
  private sending = new Set<string>();
  /** Queued jobs reloaded from disk: the daemon may have died after sending their brief. */
  private recovered = new Set<string>();
  private listeners = new Set<(job: Job) => void>();
  private timers: NodeJS.Timeout[] = [];
  /** Per-job sleep-warning polls, cleared when the job's waiter ends or the daemon closes. */
  private watches = new Set<NodeJS.Timeout>();
  private usageCache: { at: number; value: Usage } | null = null;
  /** The policy as read at start; later edits to policy.json aren't applied until a restart. */
  private policy: { parsed: unknown; raw: string | null } | null = null;
  private policyChanged = false;
  private closed = false;

  constructor(opts: JobsOptions) {
    this.o = {
      waitTimeoutMs: 600_000,
      staleMs: 45 * 60_000,
      retentionMs: 7 * 24 * 3_600_000,
      cleanupEveryMs: 6 * 3_600_000,
      retryMs: 5_000,
      pollMs: 1_000,
      phaseEveryMs: 30_000,
      usageEveryMs: 60_000,
      usageCacheMs: 60_000,
      clock: Date.now,
      home: homedir(),
      policyFile: join(dirname(opts.dir), "policy.json"),
      ...opts,
    };
  }

  /** Delete old job files now and every 6 h; reload unfinished jobs once connected, and again after every reconnect. */
  start(): void {
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    ensurePolicy(this.o.policyFile);
    this.loadedPolicy();
    this.cleanup();
    let wasConnected = false;
    const poll = () => {
      this.watchPolicy();
      const connected = this.o.link.connected;
      if (connected && !wasConnected) {
        void this.reload();
        void this.readUsage();
      }
      wasConnected = connected;
    };
    this.timers.push(
      setInterval(() => this.cleanup(), this.o.cleanupEveryMs),
      setInterval(poll, this.o.pollMs),
      // Keeps the usage shown by `health` at most a minute old.
      setInterval(() => {
        if (this.o.link.connected) void this.readUsage();
      }, this.o.usageEveryMs),
    );
    poll();
  }

  close(): void {
    this.closed = true;
    for (const t of [...this.timers, ...this.watches]) clearInterval(t);
  }

  async create(params: { bot: string; brief: string; files?: string[]; schema?: unknown }): Promise<{ jobId: string; status: JobStatus }> {
    const brief = params.brief.trim();
    if (!brief) throw new ProtocolError("bad_request", '"brief" is empty.');
    const schema = params.schema ?? null;
    if (schema !== null && (typeof schema !== "object" || Array.isArray(schema)))
      throw new ProtocolError("bad_request", '"schema" must be a JSON Schema object.');
    this.enforce(wrapBrief(brief, schema));
    let u = await this.readUsage();
    // A cached "out" can be up to usageCacheMs old: confirm with one fresh read before refusing.
    if (u && usageOut(u)) u = await this.readUsage({ fresh: true });
    if (u && usageOut(u)) throw new ProtocolError("usage_exhausted", usageMessage(u, "Nothing was sent."));
    const files = params.files ?? [];
    const relative = files.find((f) => !isAbsolute(f));
    if (relative !== undefined) throw new ProtocolError("bad_request", `File paths must be absolute: ${relative}`);
    for (const f of files) checkAttachment(f, { home: this.o.home, stateHome: dirname(this.o.dir) });
    // An attached text file can carry the instructions a brief can't.
    for (const f of files) {
      const text = attachmentText(f);
      if (text === null) continue;
      try {
        this.enforce(text);
      } catch (e) {
        if (e instanceof PolicyError)
          e.message = e.message.replace("Nothing was sent.", `(in attachment ${basename(f)}). Nothing was sent.`);
        throw e;
      }
    }
    let bot: { id: string; name: string };
    try {
      bot = await this.o.layer.find(params.bot);
    } catch (e) {
      if (/^No Bot named/.test((e as Error).message)) throw new ProtocolError("not_found", (e as Error).message);
      throw e;
    }
    const at = now();
    const job: Job = {
      jobId: `j_${randomBytes(6).toString("hex")}`,
      bot: bot.name,
      botId: bot.id,
      createdAt: at,
      updatedAt: at,
      status: "queued",
      briefKey: null,
      schema,
      messages: [],
      result: null,
      error: null,
      attempts: 0,
      warnings: [],
      brief,
      files,
    };
    this.active.set(job.jobId, job);
    this.save(job);
    // Sending can take seconds, so it happens after the reply.
    void this.next(job.botId);
    return { jobId: job.jobId, status: "queued" };
  }

  /** The user's home folder and the state folder (for the download-folder rules). */
  get homeDir(): string {
    return this.o.home;
  }
  get stateHome(): string {
    return dirname(this.o.dir);
  }

  /** The policy check tasks get (normalized text, the live policy file), for other text sent to a Bot. */
  checkPolicy(text: string): void {
    this.enforce(text);
  }

  /** Each rule on or off as loaded at start, plus warnings: rules turned off, or policy.json edited since. */
  policyState(): { rules: Record<Rule, boolean>; warnings: string[] } {
    const parsed = this.loadedPolicy().parsed;
    const rules = Object.fromEntries(
      RULES.map((r) => [r, !(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>)[r] === false)]),
    ) as Record<Rule, boolean>;
    const warnings = RULES.filter((r) => !rules[r]).map((r) => `Safety rule ${r} is off (policy.json).`);
    if (this.policyChanged) warnings.push("policy.json changed; restart groklinkd to apply");
    return { rules, warnings };
  }

  private enforce(text: string): void {
    const r = check(policyText(text), this.loadedPolicy().parsed);
    if (!r.ok) throw new PolicyError(r.rule);
  }

  private loadedPolicy(): { parsed: unknown; raw: string | null } {
    if (!this.policy) {
      let raw: string | null = null;
      try {
        raw = readFileSync(this.o.policyFile, "utf8");
      } catch {}
      this.policy = { parsed: loadPolicy(this.o.policyFile), raw };
    }
    return this.policy;
  }

  /** Notice (once) that policy.json was edited after start. The edit isn't applied: an agent with file access could make it. */
  private watchPolicy(): void {
    if (this.policyChanged) return;
    let raw: string | null = null;
    try {
      raw = readFileSync(this.o.policyFile, "utf8");
    } catch {}
    if (raw === this.loadedPolicy().raw) return;
    this.policyChanged = true;
    this.o.log("policy.json changed; restart groklinkd to apply");
  }

  /** The full job. With `wait_seconds`, resolves when it's no longer being sent or `working`, or the time passes (max 120 s). */
  async get(params: { jobId: string; wait_seconds?: number; resume?: boolean }): Promise<Job> {
    let job = this.load(params.jobId);
    if (params.resume) job = this.resume(job);
    const ms = Math.min(Math.max(params.wait_seconds ?? 0, 0), 120) * 1000;
    const running = (j: Job) => j.status === "working" || this.sending.has(j.jobId);
    if (ms <= 0 || !running(job)) return job;
    return new Promise<Job>((resolve) => {
      const done = (j: Job) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(j);
      };
      const listener = (j: Job) => {
        if (j.jobId === job.jobId && !running(j)) done(j);
      };
      const timer = setTimeout(() => done(this.load(job.jobId)), ms);
      this.listeners.add(listener);
    });
  }

  list(status?: JobStatus): JobSummary[] {
    const out: JobSummary[] = [];
    for (const name of this.files()) {
      const job = this.read(name);
      if (job && (!status || job.status === status))
        out.push({ jobId: job.jobId, bot: job.bot, status: job.status, updatedAt: job.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---- internals ----

  private resume(job: Job): Job {
    if (job.status !== "stale") throw new ProtocolError("bad_request", `Only a stale job can be resumed; ${job.jobId} is ${job.status}.`);
    if (this.busy(job.botId)) throw new ProtocolError("bad_request", `${job.bot} is busy with another job. Try again when it ends.`);
    job.status = "working";
    this.active.set(job.jobId, job);
    this.update(job);
    this.event(job, "working");
    this.follow(job);
    return job;
  }

  /** Re-adopt unfinished jobs from disk and restart their waiters (daemon start and every reconnect). */
  private async reload(): Promise<void> {
    for (const name of this.files()) {
      const disk = this.read(name);
      if (!disk || !ACTIVE.includes(disk.status)) continue;
      const fromDisk = !this.active.has(disk.jobId);
      const job = this.active.get(disk.jobId) ?? disk;
      if (job.status === "needs_input" && !this.waiting.has(job.jobId) && !(await this.unanswered(job))) continue;
      this.active.set(job.jobId, job);
      if (job.status === "queued" && fromDisk && !job.briefKey) this.recovered.add(job.jobId);
      if (job.status === "queued" || this.waiting.has(job.jobId)) continue;
      this.follow(job);
      // The base names each wait's heartbeat after Date.now(), so don't start two in the same millisecond.
      await sleep(5);
    }
    for (const botId of new Set([...this.active.values()].map((j) => j.botId))) void this.next(botId);
  }

  /**
   * True if no user message came after the brief, so the Bot's question is still this job's.
   * Otherwise a later reply in the same conversation belongs to someone else's message.
   */
  private async unanswered(job: Job): Promise<boolean> {
    // After an app restart the brief may be known only by its entry id; fall back to the last reply we have.
    for (const since of new Set([job.briefKey, job.messages.at(-1)?.key])) {
      if (!since) continue;
      try {
        const after = await this.o.layer.read(job.botId, since);
        if (!after.some((m) => m.role === "user")) return true;
        this.o.log(`job ${job.jobId} has a newer user message; left as needs_input`);
        return false;
      } catch (e) {
        if (/^No message with key/.test((e as Error).message)) continue;
        this.o.log(`job ${job.jobId} reload check failed; left as needs_input`);
        return false;
      }
    }
    this.o.log(`job ${job.jobId} brief not found in the conversation; left as needs_input`);
    return false;
  }

  /** A Bot is busy while one of its jobs is being sent, working or being followed. */
  private busy(botId: string): boolean {
    for (const j of this.active.values())
      if (j.botId === botId && (this.sending.has(j.jobId) || j.status === "working" || this.waiting.has(j.jobId))) return true;
    return false;
  }

  private queuedOn(botId: string): Job[] {
    return [...this.active.values()]
      .filter((j) => j.botId === botId && j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Send the oldest queued job on this Bot, if the Bot is free. */
  private async next(botId: string): Promise<void> {
    if (this.closed || this.busy(botId)) return;
    const job = this.queuedOn(botId)[0];
    if (!job) return;
    this.sending.add(job.jobId);
    try {
      await this.dispatch(job);
    } catch (e) {
      this.sending.delete(job.jobId);
      this.finish(job, "failed", jobError(e));
      this.active.delete(job.jobId);
      void this.next(botId);
    }
  }

  private async dispatch(job: Job): Promise<void> {
    const brief = wrapBrief(job.brief, job.schema);
    // The policy may have changed since the job was queued.
    this.enforce(brief);
    const sent = this.recovered.delete(job.jobId) ? await this.alreadySent(job, brief) : null;
    if (sent) this.o.log(`job ${job.jobId} brief was already sent before the restart; not sending again`);
    job.briefKey = sent ?? (await this.o.layer.send(job.botId, brief, job.files));
    job.attempts += 1;
    job.status = "working";
    this.sending.delete(job.jobId);
    this.update(job);
    this.event(job, "working");
    this.follow(job);
  }

  /** The key of a user message sent since the job was created whose text is the brief, if any. */
  private async alreadySent(job: Job, brief: string): Promise<string | null> {
    if (!this.o.layer.recent) return null;
    const created = Date.parse(job.createdAt);
    const found = (await this.o.layer.recent(job.botId, RECENT)).findLast(
      (m) => m.role === "user" && m.at !== null && Date.parse(m.at) >= created && m.text.trim() === brief.trim(),
    );
    return found?.key ?? null;
  }

  private follow(job: Job): void {
    if (this.waiting.has(job.jobId)) return;
    this.waiting.add(job.jobId);
    const watch = this.watchPhase(job);
    const usageWatch = this.watchUsage(job);
    void this.waitLoop(job).finally(() => {
      for (const t of [watch, usageWatch]) {
        clearInterval(t);
        this.watches.delete(t);
      }
      this.waiting.delete(job.jobId);
      if (job.status !== "working" && job.status !== "queued") this.active.delete(job.jobId);
      void this.next(job.botId);
    });
  }

  /** The usage summary for `health`: null if it can't be read. */
  async usageSummary(): Promise<UsageSummary | null> {
    await this.readUsage();
    return this.usageSnapshot();
  }

  /** The last usage reading, without waiting (refreshed in the background while connected); null if none yet. */
  usageSnapshot(): UsageSummary | null {
    const u = this.usageCache?.value;
    return u ? { percentUsed: u.percentUsed, resetsAt: u.resetsAt, out: usageOut(u) } : null;
  }

  /**
   * Current usage, reused for `usageCacheMs`, except a cached "out" reading whose reset time has passed. `fresh`
   * always reads again and, if that read fails, falls back to the cached reading. Null (logged, never thrown) if it
   * can't be read and there's nothing to fall back to.
   */
  private async readUsage(opts: { fresh?: boolean } = {}): Promise<Usage | null> {
    if (!this.o.layer.usage) return null;
    const now = this.o.clock();
    const cached = this.usageCache;
    const resetPassed = (u: Usage) => u.resetsAt !== null && Date.parse(u.resetsAt) <= now;
    if (!opts.fresh && cached && now - cached.at < this.o.usageCacheMs && !(usageOut(cached.value) && resetPassed(cached.value)))
      return cached.value;
    try {
      const value = await this.o.layer.usage();
      this.usageCache = { at: now, value };
      return value;
    } catch {
      if (opts.fresh && cached) {
        this.o.log("couldn't re-read Grok usage; using the last reading");
        return cached.value;
      }
      this.o.log("couldn't read Grok usage; not blocking");
      return null;
    }
  }

  /** Fail a working job if usage ran out. Returns true if it did. */
  private async failIfOut(job: Job): Promise<boolean> {
    if (job.status !== "working") return false;
    const u = await this.readUsage();
    if (!u || !usageOut(u) || job.status !== "working") return false;
    this.o.log(`job ${job.jobId} stopped: Grok usage ran out`);
    this.finish(job, "failed", { code: "usage_exhausted", message: usageMessage(u, "The Bot stopped because Grok usage ran out.") });
    return true;
  }

  private watchUsage(job: Job): NodeJS.Timeout {
    const timer = setInterval(() => void this.failIfOut(job), this.o.usageEveryMs);
    this.watches.add(timer);
    return timer;
  }

  /** While the job is working, warn once the Bot's computer falls asleep (the status doesn't change). */
  private watchPhase(job: Job): NodeJS.Timeout {
    let last: string | null = null;
    const timer = setInterval(async () => {
      if (job.status !== "working" || !this.o.layer.phase) return;
      let phase: string | null;
      try {
        phase = await this.o.layer.phase();
      } catch {
        return;
      }
      const asleep = phase !== null && ASLEEP.includes(phase);
      if (asleep && !(last !== null && ASLEEP.includes(last))) {
        this.event(job, "warning", SLEEP_WARNING);
        job.warnings ??= [];
        if (!job.warnings.includes(SLEEP_WARNING)) {
          job.warnings.push(SLEEP_WARNING);
          this.update(job);
        }
        this.o.log(`job ${job.jobId}: Bot computer is ${phase}`);
      }
      last = phase;
    }, this.o.phaseEveryMs);
    this.watches.add(timer);
    return timer;
  }

  private async waitLoop(job: Job): Promise<void> {
    let anchor = job.briefKey ?? undefined;
    let errors = 0;
    // When the Bot last said something (or the wait began): the clock for "idle without replying".
    let quietSince = this.o.clock();
    const heard = () => {
      quietSince = this.o.clock();
    };
    while (!this.closed) {
      let r: WaitResult;
      try {
        r = await this.o.layer.wait(job.botId, {
          since: anchor,
          timeoutMs: this.o.waitTimeoutMs,
          onUpdate: (m) => {
            if (job.status === "failed") return;
            if (m.role !== "user") heard();
            this.add(job, m);
          },
        });
        errors = 0;
      } catch (e) {
        if (this.closed) return;
        // After an app restart the brief may be known only by its entry id; fall back to the last reply we have.
        if (anchor && /^No message with key/.test((e as Error).message)) {
          anchor = anchor === job.briefKey ? job.messages.at(-1)?.key : undefined;
          continue;
        }
        if (!transient(e, this.o.link) && ++errors >= MAX_WAIT_ERRORS) {
          this.finish(job, "failed", { code: "internal", message: (e as Error).message });
          return;
        }
        this.o.log(`job ${job.jobId} wait failed, retrying`);
        await sleep(this.o.retryMs);
        continue;
      }
      // Failed while waiting (usage ran out): keep what arrived before, stop here.
      if (job.status === "failed") return;
      for (const m of r.messages) this.add(job, m);
      if (r.messages.some((m) => m.role !== "user")) heard();
      // A job is done only once the Bot has replied. Idle with nothing new: keep waiting from the same key.
      if (r.status === "done" && !job.messages.length) {
        if (await this.failIfOut(job)) return;
        if (this.o.clock() - quietSince >= this.o.staleMs)
          return this.finish(job, "stale", { code: "no_reply", message: "The Bot went idle without replying." });
        await sleep(this.o.retryMs);
        continue;
      }
      if (r.status === "done" && job.schema !== null) {
        const errors = checkAnswer(job);
        if (!errors) return this.finish(job, "done");
        if (job.attempts - 1 >= MAX_REPAIRS) {
          const message = `The Bot's answer didn't match the schema after ${MAX_REPAIRS} repairs.`;
          return this.finish(job, "failed", { code: "schema_invalid", message, errors });
        }
        const repair = `Your JSON didn't match the schema: ${errors.slice(0, 5).join("; ")}. Send only the corrected json block.`;
        try {
          this.enforce(repair);
          anchor = await this.o.layer.send(job.botId, repair, []);
        } catch (e) {
          return this.finish(job, "failed", e instanceof PolicyError ? jobError(e) : { code: "internal", message: (e as Error).message });
        }
        job.attempts += 1;
        this.update(job);
        this.event(job, "working");
        continue;
      }
      if (r.status === "done" || r.status === "needs_input") return this.finish(job, r.status);
      if (Date.now() - Date.parse(job.updatedAt) >= this.o.staleMs) return this.finish(job, "stale");
    }
  }

  /** Add a new reply, or replace one whose text changed. */
  private add(job: Job, m: Message): void {
    if (m.role === "user") return;
    const msg: JobMessage = { ...m, untrusted: true };
    const i = job.messages.findIndex((x) => x.key === m.key);
    if (i >= 0) {
      const prev = job.messages[i] as JobMessage & { streaming?: boolean };
      if (prev.text === m.text && !!prev.streaming === !!(m as { streaming?: boolean }).streaming) return;
      job.messages[i] = msg;
    } else job.messages.push(msg);
    this.update(job);
    this.event(job, "message", m.text);
  }

  private finish(job: Job, status: JobStatus, error: JobError | null = null): void {
    job.status = status;
    job.error = error;
    this.update(job);
    this.event(job, EVENT_OF[status]);
  }

  private event(job: Job, type: EventType, text?: string): void {
    this.o.events.append({ jobId: job.jobId, bot: job.bot, type, ...(text === undefined ? {} : { text }) });
  }

  private update(job: Job): void {
    job.updatedAt = now();
    this.save(job);
    for (const l of this.listeners) l(job);
  }

  private path(jobId: string): string {
    return join(this.o.dir, `${jobId}.json`);
  }

  /** Atomic: write a temp file, then rename over the old one. */
  private save(job: Job): void {
    const file = this.path(job.jobId);
    writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private load(jobId: string): Job {
    if (!JOB_ID.test(jobId)) throw new ProtocolError("bad_request", `"${jobId}" isn't a job id (j_ + 12 hex characters).`);
    const job = this.active.get(jobId) ?? this.read(`${jobId}.json`);
    if (!job) throw new ProtocolError("not_found", `No job ${jobId}. Job files are kept for 7 days.`);
    return job;
  }

  private read(name: string): Job | null {
    try {
      return JSON.parse(readFileSync(join(this.o.dir, name), "utf8")) as Job;
    } catch {
      return null;
    }
  }

  private files(): string[] {
    try {
      return readdirSync(this.o.dir).filter((n) => JOB_ID.test(n.replace(/\.json$/, "")) && n.endsWith(".json"));
    } catch {
      return [];
    }
  }

  /** Delete job files (and leftover temp files) not written to for 7 days, except jobs still in progress. */
  private cleanup(): void {
    const cutoff = Date.now() - this.o.retentionMs;
    try {
      this.o.events.prune(this.o.retentionMs);
    } catch {
      this.o.log("couldn't prune events.jsonl");
    }
    let names: string[];
    try {
      names = readdirSync(this.o.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.split(".")[0];
      if (!JOB_ID.test(id) || this.active.has(id)) continue;
      const file = join(this.o.dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {}
    }
  }
}
