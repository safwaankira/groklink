// Self-test: read-only page checks that the Grok Bot internals the base code relies on are still there.
// Runs on every connect and again whenever the app's version on disk changes. Sends nothing.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { findApp } from "../base/app.ts";
import type { CDP } from "../base/cdp.ts";
import { ACCOUNT_SLOT, store } from "../base/page.ts";
import type { Log } from "./state.ts";

const run = promisify(execFile);

export type Check = { name: string; ok: boolean; error?: string };
export type SelfTestResult = { ok: boolean; appVersion: string | null; testedAt: string; checks: Check[] };

/** Page-side: each check returns true, or a string saying what's missing. Only reads. */
export const PAGE_SELFTEST = `(() => {
  const out = [];
  const t = (name, fn) => {
    try {
      const v = fn();
      out.push(v === true ? { name, ok: true } : { name, ok: false, error: typeof v === "string" ? v : "not found" });
    } catch (e) {
      out.push({ name, ok: false, error: String((e && e.message) || e) });
    }
  };
  t("roster.createAgent", () => !!(${store("roster", "createAgent")}) || "roster store not found");
  t("transcript.snapshotsFor", () => !!(${store("transcript", "snapshotsFor")}) || "transcript store not found");
  t("sendJournal.sendPrompt", () => !!(${store("sendJournal", "sendPrompt")}) || "sendJournal store not found");
  t("roster.rows", () => {
    const roster = ${store("roster", "createAgent")};
    if (!roster) return "roster store not found";
    return Array.isArray(roster.snapshots.get().agents.rows) || "agents.rows isn't an array";
  });
  t("accountSlot", () => typeof (${ACCOUNT_SLOT}) === "string" || "account slot not found");
  return out;
})()`;

/** CFBundleShortVersionString of the app on disk; null if unreadable or not macOS (untested platforms). */
export async function readAppVersion(app = process.env.GROKLINK_APP || findApp()): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents/Info.plist")]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export type SelfTestOptions = {
  /** `$GROKLINK_HOME`: app-version and selftest.json are written here. */
  home: string;
  cdp: () => CDP;
  log: Log;
  readVersion?: () => Promise<string | null>;
};

export class SelfTest {
  result: SelfTestResult | null = null;
  private o: Required<SelfTestOptions>;
  private running: Promise<SelfTestResult> | null = null;

  constructor(opts: SelfTestOptions) {
    this.o = { readVersion: () => readAppVersion(), ...opts };
  }

  private get versionFile(): string {
    return join(this.o.home, "app-version");
  }

  private savedVersion(): string | null {
    try {
      return readFileSync(this.versionFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  /** Read and save the app version, run the page checks, and save the result. One run at a time. */
  run(): Promise<SelfTestResult> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Run again if the app's version on disk differs from the saved one. */
  async checkVersion(): Promise<void> {
    const version = await this.o.readVersion();
    if (version !== this.savedVersion()) await this.run();
  }

  /** The `task` error message while the last self-test failed, else null. */
  failure(): string | null {
    const r = this.result;
    if (!r || r.ok) return null;
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    return `Grok Bot ${r.appVersion ?? "(unknown version)"} changed its internals; self-test failed: ${failed.join(", ")}. Grok Link needs an update.`;
  }

  private async runOnce(): Promise<SelfTestResult> {
    const appVersion = await this.o.readVersion();
    writeFileSync(this.versionFile, `${appVersion ?? ""}\n`, { mode: 0o600 });
    let checks: Check[];
    try {
      checks = await this.o.cdp().eval<Check[]>(PAGE_SELFTEST);
      if (!Array.isArray(checks)) throw new Error("the page returned no results");
    } catch (e) {
      checks = [{ name: "page", ok: false, error: (e as Error).message }];
    }
    const result = { ok: checks.every((c) => c.ok), appVersion, testedAt: new Date().toISOString(), checks };
    this.result = result;
    writeFileSync(join(this.o.home, "selftest.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    this.o.log(`self-test ${result.ok ? "passed" : "failed"} (Grok Bot ${appVersion ?? "unknown version"})`);
    return result;
  }
}
