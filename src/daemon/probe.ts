// Deep health: a real, read-only round trip through Grok Bot (page, account, Bot list, a transcript, usage,
// the Bot computer's phase). Sends nothing, and returns no message text, names of people or account details.
import { listBots, read, usage } from "../base/bot.ts";
import type { CDP } from "../base/cdp.ts";
import { BOX_PHASE, store } from "../base/page.ts";
import { usageOut } from "./jobs.ts";

export type ProbeCheck = {
  name: "app" | "account" | "roster" | "transcript" | "usage" | "awake";
  ok: boolean;
  /** Passed, but worth telling the user about (e.g. the Bot's computer is asleep). */
  warn?: true;
  ms: number;
  detail: string;
};
export type ProbeResult = { ok: boolean; checks: ProbeCheck[] };
export type Account = "signed_in" | "signed_out" | "unknown";

const CHECK_MS = 10_000;

/** Page-side: whether the window has loaded and the stores the Bot methods need are there. */
export const PAGE_LOADED = `(() => ({ state: document.readyState, stores: !!(${store("roster", "createAgent")}) && !!(${store("transcript", "snapshotsFor")}) }))()`;

/** Page-side: only the `kind` of the app's own auth status (see research/R02-signed-out.md); never the account details. */
export const PAGE_AUTH_KIND = `async () => {
  const m = window.desktop && window.desktop.main;
  if (!m || typeof m.getCursorAuthStatus !== "function") return null;
  const s = await m.getCursorAuthStatus();
  return s && typeof s.kind === "string" ? s.kind : null;
}`;

export function accountState(kind: unknown): Account {
  if (kind === "logged-in") return "signed_in";
  if (kind === "logged-out") return "signed_out";
  return "unknown";
}

/** `p`, or a rejection once `ms` passes. */
function capped<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
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

const message = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

/** `when` formatted for people, e.g. "Wed, 19 Nov 2026 08:00:00 GMT"; the raw value if it isn't a date. */
function readableTime(when: string | null): string {
  if (!when) return "at an unknown time";
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? when : d.toUTCString();
}

/**
 * Run every check, each capped at `timeoutMs` (10 s). `usage` is the user's warn and pause percents (policy.json). `cdp` throws if there's no connection, in which case
 * `app` fails and the rest are skipped.
 */
export async function deepProbe(
  cdp: () => CDP,
  opts: { timeoutMs?: number; usage?: { warn: number; pause: number } } = {},
): Promise<ProbeResult> {
  const cap = opts.timeoutMs ?? CHECK_MS;
  const checks: ProbeCheck[] = [];
  const run = async (name: ProbeCheck["name"], fn: () => Promise<Omit<ProbeCheck, "name" | "ms">>) => {
    const started = Date.now();
    let r: Omit<ProbeCheck, "name" | "ms">;
    try {
      r = await capped(fn(), cap);
    } catch (e) {
      r = { ok: false, detail: message(e) };
    }
    checks.push({ name, ok: r.ok, ...(r.warn ? { warn: true as const } : {}), ms: Date.now() - started, detail: r.detail });
    return r.ok;
  };
  const skip = (name: ProbeCheck["name"], why: string) => checks.push({ name, ok: false, ms: 0, detail: `skipped: ${why}` });

  let page: CDP | null = null;
  const appOk = await run("app", async () => {
    page = cdp();
    const s = await page.eval<{ state: string; stores: boolean } | null>(PAGE_LOADED);
    if (s?.state !== "complete") return { ok: false, detail: `page not loaded (${s?.state ?? "no answer"})` };
    if (!s.stores) return { ok: false, detail: "page loaded, but Grok Bot's stores weren't found" };
    return { ok: true, detail: "page loaded" };
  });
  if (!appOk || !page) {
    for (const n of ["account", "roster", "transcript", "usage", "awake"] as const) skip(n, "Grok Bot isn't reachable");
    return { ok: false, checks };
  }
  const c: CDP = page;

  await run("account", async () => {
    const state = accountState(await c.call<unknown>(PAGE_AUTH_KIND));
    if (state === "signed_out") return { ok: false, detail: "signed_out" };
    return state === "signed_in" ? { ok: true, detail: "signed_in" } : { ok: true, warn: true, detail: "unknown" };
  });

  let firstBot: string | null = null;
  const rosterOk = await run("roster", async () => {
    // listBots throws when the roster is empty; report that as a plain "no Bots".
    const bots = await listBots(c).catch((e: unknown) => {
      if (/^No Bots found/.test(message(e))) return [];
      throw e;
    });
    firstBot = bots[0]?.id ?? null;
    return bots.length ? { ok: true, detail: `${bots.length} Bot${bots.length === 1 ? "" : "s"}` } : { ok: false, detail: "no Bots" };
  });

  if (rosterOk && firstBot) {
    const id: string = firstBot;
    await run("transcript", async () => {
      const r = await read(c, id, { limit: 1 });
      return { ok: true, detail: `readable (${r.messages.length} message${r.messages.length === 1 ? "" : "s"} checked)` };
    });
  } else skip("transcript", "no Bot to read");

  await run("usage", async () => {
    const u = await usage(c);
    if (usageOut(u)) return { ok: false, detail: `Grok usage used up, resets ${readableTime(u.resetsAt)}` };
    const used = `${Math.floor(u.percentUsed)}% used`;
    const { warn, pause } = opts.usage ?? { warn: 101, pause: 100 };
    // The user's own limits: a warning, never a failure.
    if (pause < 100 && u.percentUsed >= pause)
      return { ok: true, warn: true, detail: `${used}; new tasks pause at ${pause}% (your setting)` };
    if (u.percentUsed >= warn) return { ok: true, warn: true, detail: `${used} (warn at ${warn}%)` };
    return { ok: true, detail: used };
  });

  await run("awake", async () => {
    const phase = await c.eval<unknown>(BOX_PHASE);
    if (phase === "away" || phase === "asleep")
      return { ok: true, warn: true, detail: `Bot's computer is ${phase}: bring the Grok Bot window to the front to wake it` };
    return { ok: true, detail: typeof phase === "string" ? phase : "phase unknown" };
  });

  return { ok: checks.every((ch) => ch.ok), checks };
}

/** One plain-English line for each failed or warning check, for `health.warnings`. */
export function probeWarnings(r: ProbeResult): string[] {
  const out: string[] = [];
  for (const ch of r.checks) {
    if (ch.ok && !ch.warn) continue;
    if (ch.detail.startsWith("skipped:")) continue;
    switch (ch.name) {
      case "app":
        out.push(`Grok Bot isn't reachable (${ch.detail}). Make sure the app is open with its main window.`);
        break;
      case "account":
        out.push(ch.ok ? "Couldn't tell whether Grok Bot is signed in." : "Grok Bot is signed out — open the app and sign in.");
        break;
      case "roster":
        out.push(`Grok Link can't list your Bots (${ch.detail}). Open Grok Bot and check you're signed in.`);
        break;
      case "transcript":
        out.push(`Grok Link can't read Bot conversations (${ch.detail}). This Grok Bot version may have changed.`);
        break;
      case "usage":
        // At the user's warn or pause percent, the check passes with a warning; health adds its own line for that.
        if (ch.ok) break;
        out.push(ch.detail.startsWith("Grok usage used up") ? `${ch.detail}.` : `Couldn't read Grok usage (${ch.detail}).`);
        break;
      case "awake":
        out.push(`${ch.detail}.`);
        break;
    }
  }
  return out;
}
