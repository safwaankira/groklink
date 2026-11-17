// Safety policy: refuse briefs that ask a Bot to write on X, sign or send transactions, connect a wallet or submit claims.
// Rules are on unless policy.json sets them to false; there's no per-call override.
import { readFileSync, writeFileSync } from "node:fs";
import { ProtocolError } from "./protocol.ts";

export const RULES = ["x_write", "tx", "wallet", "claim"] as const;
export type Rule = (typeof RULES)[number];
export type PolicyResult = { ok: true } | { ok: false; rule: Rule };

const DEFAULT_FILE = '{ "x_write": true, "tx": true, "wallet": true, "claim": true }\n';

const WHAT: Record<Rule, string> = {
  x_write: "post, reply, quote, like, repost, follow or DM on X",
  tx: "sign or send transactions",
  wallet: "connect a wallet or handle its keys",
  claim: "submit claims",
};

/** A whole word or phrase; `@handle` counts as a word. */
const word = (alt: string) => `(?<![\\w@])(?:${alt})(?![\\w])`;
/** `a`, then `b` as a later word, at most 6 words after it. */
const near = (a: string, b: string) => `${word(a)}\\S*(?:\\s\\S+){0,6}?\\s[^\\s\\w@]*${word(b)}`;
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

const PATTERNS: Record<Rule, RegExp[]> = {
  x_write: [
    new RegExp(
      COMMAND +
        NOT_COMMAND +
        near(
          "send a dm|post|tweet|publish|reply|quote|repost|retweet|like|follow|dm|message",
          "on x|to x|on twitter|tweet|x account|@\\w+",
        ),
    ),
  ],
  tx: [new RegExp(near("sign|send|submit|approve|broadcast|execute", "transaction|tx|txn|permit|signature|swap|transfer"))],
  wallet: [new RegExp(word("connect (?:a |my |the )?wallet")), new RegExp(word("seed phrase|private key|mnemonic"))],
  claim: [new RegExp(near("submit", "claim|poidh"))],
};

/** The first enabled rule `text` breaks. `enabled` is the parsed policy file; any key not set to false is on. */
export function check(text: string, enabled: unknown): PolicyResult {
  const on = (r: Rule) => !(enabled && typeof enabled === "object" && (enabled as Record<string, unknown>)[r] === false);
  // Newlines are kept (one per run): they end a clause.
  const t = text
    .toLowerCase()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
  for (const rule of RULES) if (on(rule) && PATTERNS[rule].some((p) => p.test(t))) return { ok: false, rule };
  return { ok: true };
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
