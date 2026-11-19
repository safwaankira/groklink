// Safety policy: refuse briefs that ask a Bot to write on X, sign or send transactions, connect a wallet or submit claims.
// tx, wallet and claim are on unless policy.json sets them to false. x_write has a mode: block (default), approve (the
// user approves each posting task in a dialog on their Mac) or allow. There's no per-call override.
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ProtocolError } from "./protocol.ts";

export const RULES = ["x_write", "tx", "wallet", "claim"] as const;
export type Rule = (typeof RULES)[number];
export type PolicyResult = { ok: true } | { ok: false; rule: Rule };

const DEFAULT_FILE = '{ "x_write": "block", "tx": true, "wallet": true, "claim": true }\n';

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
 * Set x_write's mode in the policy file, keeping the other keys: written to a temp file (0600) and renamed over the old
 * one. A missing file starts from the defaults. A file that exists but can't be read or parsed is never replaced (its
 * other settings would be lost): this throws instead.
 */
export function writeXMode(file: string, mode: XMode, rename: (from: string, to: string) => void = renameSync): Record<string, unknown> {
  const broken = policyFileError(file);
  if (broken) throw new Error(`${file} can't be read (${broken}). Fix or delete it first; nothing was changed.`);
  const parsed = loadPolicy(file);
  const base: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : JSON.parse(DEFAULT_FILE);
  const next = { ...base, x_write: mode };
  // A symlinked policy.json is written through: the link stays, and the file it points to gets the new content.
  let target = file;
  try {
    if (lstatSync(file).isSymbolicLink()) target = realpathSync(file);
  } catch {}
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
