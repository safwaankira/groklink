// Safety policy: refuse briefs that ask a Bot to write on X, sign or send transactions, connect a wallet or submit claims.
// tx, wallet and claim are on unless policy.json sets them to false. x_write has a mode: block (default), approve (the
// user approves each posting task in a dialog on their Mac) or allow. There's no per-call override.
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ProtocolError } from "./protocol.ts";

export const RULES = ["x_write", "tx", "wallet", "claim"] as const;
export type Rule = (typeof RULES)[number];
export type PolicyResult = { ok: true } | { ok: false; rule: Rule };

const DEFAULT_FILE = '{ "x_write": "block", "tx": true, "wallet": true, "claim": true, "usage": { "warn": 80, "pause": 100 } }\n';

/** Percent of weekly Grok usage at which health warns, and at which new tasks are refused (100 = only when used up). */
export type UsageLimits = { warn: number; pause: number };
export const DEFAULT_USAGE: UsageLimits = { warn: 80, pause: 100 };
export const USAGE_WARNING = `policy.json has invalid usage limits; using warn ${DEFAULT_USAGE.warn}, pause ${DEFAULT_USAGE.pause}. Use numbers: warn 0-100, pause 1-100, warn no higher than pause.`;

/**
 * The usage limits in a parsed policy file. A missing `usage` key (or a missing number in it) means the defaults.
 * Anything invalid (not numbers, out of range, warn above pause) means both defaults, with a warning.
 */
export function usageLimits(parsed: unknown): UsageLimits & { warning?: string } {
  const v = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).usage : undefined;
  if (v === undefined) return { ...DEFAULT_USAGE };
  const bad = { ...DEFAULT_USAGE, warning: USAGE_WARNING };
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad;
  const { warn = DEFAULT_USAGE.warn, pause = DEFAULT_USAGE.pause } = v as Record<string, unknown>;
  const num = (n: unknown, min: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= 100;
  return num(warn, 0) && num(pause, 1) && warn <= pause ? { warn, pause } : bad;
}

export const X_MODES = ["block", "approve", "allow"] as const;
export type XMode = (typeof X_MODES)[number];

/**
 * The x_write mode in a parsed policy file. Legacy booleans map true → block, false → allow; a missing key is block.
 * Any other value is block, with a warning.
 */
export function xMode(parsed: unknown): { mode: XMode; warning?: string } {
  const v = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).x_write : undefined;
  if (v === undefined || v === true) return { mode: "block" };
  if (v === false) return { mode: "allow" };
  if (typeof v === "string" && (X_MODES as readonly string[]).includes(v)) return { mode: v as XMode };
  return { mode: "block", warning: 'policy.json has an unknown x_write value; using "block". Use block, approve or allow.' };
}

const WHAT: Record<Rule, string> = {
  x_write: "post, reply, quote, like, repost, follow or DM on X",
  tx: "sign or send transactions",
  wallet: "connect a wallet or handle its keys",
  claim: "submit claims",
};

/** A whole word or phrase; `@handle` counts as a word. */
const word = (alt: string) => `(?<![\\w@])(?:${alt})(?![\\w])`;
/** `a`, then `b` as a later word, at most `n` words after it. */
const near = (a: string, b: string, n = 10) => `${word(a)}\\S*(?:\\s\\S+){0,${n}}?\\s[^\\s\\w@]*${word(b)}`;
/**
 * Where a verb reads as a command: the start of the text or of a clause, or right after a word like "please".
 * So "please like this tweet" counts but "find posts like this on X" doesn't.
 */
const COMMAND = `(?:^[^\\w@]*|[.!?;:,\\n][^\\w@]*|${word("please|and|then|also|to|go|you should|can you|could you|i want you to|make sure to")} )`;
/**
 * A verb right after one of these describes a refusal or a condition, not a command:
 * "refuses to post on X", "when asked to reply to @foo". ("when/if asked to" are covered by "asked to".)
 */
const NOT_COMMAND = "(?<!(?<![\\w@])(?:asked to|refuses to|refusing to|won['\u2019]t|will not|never|blocks attempts to) )";

/** "send me…", "confirm whether…" ask for information, not an action, so those don't count. */
const TX_VERBS =
  "(?:sign|send|submit|approve|broadcast|execute|confirm|authorize|accept)(?! (?:me|us|whether|if|that|how|what|why|when)\\b)";
const TX_TARGETS = "transaction|transactions|tx|txn|permit|signature|swap|transfer|approval|pending|wallet|contract call|bridge";

const PATTERNS: Record<Rule, RegExp[]> = {
  x_write: [
    new RegExp(
      COMMAND +
        NOT_COMMAND +
        near(
          "send a dm|post|tweet|publish|reply|quote|repost|retweet|like|follow|dm|message|share|send|upload|thread|boost|amplify",
          "on x|to x|on twitter|tweet|x account|@\\w+|from my account|my account|my timeline|my profile",
        ),
    ),
  ],
  // A verb and a target within 10 words, in either order.
  tx: [new RegExp(near(TX_VERBS, TX_TARGETS)), new RegExp(near(TX_TARGETS, TX_VERBS))],
  wallet: [new RegExp(word("connect (?:a |my |the )?wallet")), new RegExp(word("seed phrase|private key|mnemonic"))],
  claim: [new RegExp(near("submit", "claim|poidh"))],
};

/**
 * Every enabled rule `text` breaks, in RULES order. `enabled` is the parsed policy file: tx, wallet and claim are on
 * unless set to false; x_write is checked unless its mode is allow (in approve mode the caller decides what a match means).
 */
export function matches(text: string, enabled: unknown): Rule[] {
  const on = (r: Rule) =>
    r === "x_write"
      ? xMode(enabled).mode !== "allow"
      : !(enabled && typeof enabled === "object" && (enabled as Record<string, unknown>)[r] === false);
  // Newlines are kept (one per run): they end a clause.
  const t = text
    .toLowerCase()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
  return RULES.filter((rule) => on(rule) && PATTERNS[rule].some((p) => p.test(t)));
}

/** The first enabled rule `text` breaks (see `matches`). */
export function check(text: string, enabled: unknown): PolicyResult {
  const hit = matches(text, enabled)[0];
  return hit ? { ok: false, rule: hit } : { ok: true };
}

/** The parsed policy file, or null (all rules on) if it's missing or unreadable. */
export function loadPolicy(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write the default policy (every rule on, mode 0600) if there's no file yet. */
export function ensurePolicy(file: string): void {
  try {
    writeFileSync(file, DEFAULT_FILE, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

/** Why the policy file can't be used, or null if it's fine or missing (a missing file means the defaults). */
export function policyFileError(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : (e as Error).message;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : "it isn't a JSON object";
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Change the policy file, keeping its other keys: written to a temp file (0600) and renamed over the old one. A missing
 * file starts from the defaults. A file that exists but can't be read or parsed is never replaced (its other settings
 * would be lost): this throws instead.
 */
function writePolicy(
  file: string,
  change: (base: Record<string, unknown>) => Record<string, unknown>,
  rename: (from: string, to: string) => void,
): Record<string, unknown> {
  const broken = policyFileError(file);
  if (broken) throw new Error(`${file} can't be read (${broken}). Fix or delete it first; nothing was changed.`);
  const parsed = loadPolicy(file);
  const base: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : JSON.parse(DEFAULT_FILE);
  const next = change(base);
  // A symlinked policy.json is written through: the link stays, and the file it points to gets the new content. A
  // dangling link is followed too (its target is created), so the link is never replaced by a plain file.
  let target = file;
  for (let hops = 0; hops < 20; hops++) {
    let link: string;
    try {
      if (!lstatSync(target).isSymbolicLink()) break;
      link = readlinkSync(target);
    } catch {
      break;
    }
    target = resolve(dirname(target), link);
  }
  if (target !== file) mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    rename(tmp, target);
  } catch (e) {
    // Don't leave a half-written temp file next to policy.json.
    rmSync(tmp, { force: true });
    throw e;
  }
  return next;
}

/** Set x_write's mode in the policy file (see `writePolicy`). */
export function writeXMode(file: string, mode: XMode, rename: (from: string, to: string) => void = renameSync): Record<string, unknown> {
  return writePolicy(file, (base) => ({ ...base, x_write: mode }), rename);
}

/**
 * Set one usage limit in the policy file (see `writePolicy`), keeping the other. `warn` is a whole number 0-100,
 * `pause` 1-100, and warn may not end up above pause: otherwise this throws and nothing is changed.
 */
export function writeUsageLimit(
  file: string,
  key: keyof UsageLimits,
  value: number,
  rename: (from: string, to: string) => void = renameSync,
): UsageLimits {
  const min = key === "warn" ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > 100) throw new RangeError(`${key} must be a whole number from ${min} to 100.`);
  let out: UsageLimits = DEFAULT_USAGE;
  writePolicy(
    file,
    (base) => {
      const { warn, pause } = usageLimits(base);
      out = { warn, pause, [key]: value };
      if (out.warn > out.pause)
        throw new RangeError(
          `warn (${out.warn}) can't be higher than pause (${out.pause}). Change ${key === "warn" ? "pause" : "warn"} first; nothing was changed.`,
        );
      return { ...base, usage: out };
    },
    rename,
  );
  return out;
}

export class PolicyError extends ProtocolError {
  readonly rule: Rule;

  constructor(rule: Rule) {
    super(
      "blocked_by_policy",
      `Blocked by Grok Link's safety policy (rule ${rule}): a Bot may not be asked to ${WHAT[rule]}. Nothing was sent.`,
    );
    this.name = "PolicyError";
    this.rule = rule;
  }
}

/** Throw a PolicyError if `text` breaks a rule enabled in the policy file. The file is read on every call. */
export function enforce(text: string, file: string): void {
  const r = check(text, loadPolicy(file));
  if (!r.ok) throw new PolicyError(r.rule);
}
