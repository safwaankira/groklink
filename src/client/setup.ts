// `groklink setup`: first use in one command. Runs install (LaunchAgent + MCP clients), installs the agent skill, waits
// for the daemon and runs doctor, printing one line per step. It never sends a Bot message.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type InstallEnv, type InstallFailure, install, installSkill, waitConnected } from "./install.ts";

export type SetupCheck = { name: string; ok: boolean; warn?: boolean; detail: string };
export type SetupEnv = InstallEnv & {
  /** Doctor's checks (deep health, read-only; nothing is sent). */
  doctor(): Promise<SetupCheck[]>;
  /** The Bots' names, in the app's order. */
  bots(): Promise<string[]>;
};

const AGAIN = "then run `groklink setup` again";

const line = (ok: boolean, step: string, detail: string) => `${ok ? "✓" : "✗"} ${step.padEnd(8)} ${detail}`;

/** The one-line fix for each way install can fail. */
function installFix(env: InstallEnv, why: InstallFailure | null): string {
  const log = join(env.stateHome, "daemon.log");
  switch (why) {
    case "grokbot_bridge":
      return `The old grokbot-bridge is registered and can't share Grok Bot. Fix: run \`groklink install --replace-grokbot-bridge\`, ${AGAIN}.`;
    case "desktop_running":
      return `Claude Desktop is running and would undo the change to its config. Fix: quit Claude Desktop (Cmd+Q), ${AGAIN}.`;
    case "launchctl":
      return `launchctl couldn't load the LaunchAgent. Fix: check ${log}, ${AGAIN}.`;
    case "not_connected":
      return `The daemon didn't connect to Grok Bot. Fix: open Grok Bot and sign in, ${AGAIN} (log: ${log}).`;
    default:
      return `Install failed. Fix: run \`groklink install\` to see why, ${AGAIN}.`;
  }
}

/** A Bot name as a shell argument, without control characters. */
function shellName(name: string): string {
  const clean = [...name].filter((c) => c >= " " && c !== "\u007f").join("");
  return /^[A-Za-z0-9_.-]+$/.test(clean) ? clean : `"${clean.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Returns the exit code: 0 only if every step passed. Steps already done stay done; running it again is safe. */
export async function setup(env: SetupEnv, opts: { dryRun?: boolean } = {}): Promise<number> {
  const quiet = (lines: string[]): InstallEnv => ({ ...env, out: (l) => lines.push(l) });
  /** Claude Code is the client that loads skills from ~/.claude/skills. */
  const hasClaudeCode = env.onPath("claude") || existsSync(join(env.home, ".claude"));

  if (opts.dryRun) {
    env.out("Dry run; nothing was written and nothing was sent. groklink setup would:");
    const lines: string[] = [];
    const code = await install(quiet(lines), { dryRun: true });
    env.out("1. install: run the daemon at login and register the MCP server in your clients");
    for (const l of lines) if (!/^Dry run/.test(l)) env.out(`   ${l}`);
    if (hasClaudeCode) {
      const skill: string[] = [];
      installSkill(quiet(skill), { dryRun: true });
      env.out("2. skill: add the agent skill for Claude Code");
      for (const l of skill) env.out(`   ${l.replace(/^Dry run; nothing was written\. /, "")}`);
    } else env.out("2. skill: skipped (Claude Code not found)");
    env.out(`3. daemon: wait up to ${(env.waitMs ?? 30_000) / 1000} s for the daemon to connect to Grok Bot`);
    env.out("4. doctor: run the read-only checks (app, account, roster, transcript, usage, awake)");
    env.out("It never sends a Bot message.");
    return code;
  }

  // 1. LaunchAgent + client registration. A daemon that is already installed and answering is left running.
  const lines: string[] = [];
  let why: InstallFailure | null = null;
  let code: number;
  try {
    code = await install(quiet(lines), {
      keepRunning: true,
      onFail: (w) => {
        why = w;
      },
    });
  } catch (e) {
    env.out(line(false, "install", `${(e as Error).message.split("\n")[0]} Fix that, ${AGAIN}.`));
    return 1;
  }
  if (code !== 0) {
    env.out(line(false, "install", installFix(env, why)));
    return 1;
  }
  const registered = lines.find((l) => l.startsWith("Registered the groklink MCP server in: "));
  env.out(
    line(
      true,
      "install",
      registered
        ? `daemon runs at login; MCP server registered in ${registered.slice(registered.indexOf(": ") + 2).replace(/\.$/, "")} (restart them to load it)`
        : "daemon runs at login; MCP clients were already registered",
    ),
  );

  // 2. The agent skill; an existing copy is kept.
  if (!hasClaudeCode) env.out(line(true, "skill", "skipped (Claude Code not found)"));
  else {
    const skill: string[] = [];
    if (installSkill(quiet(skill)) !== 0) {
      env.out(
        line(false, "skill", `${skill.at(-1) ?? "Couldn't install the skill."} Fix: reinstall with \`npm i -g groklink\`, ${AGAIN}.`),
      );
      return 1;
    }
    const said = skill.at(-1) ?? "";
    env.out(
      line(
        true,
        "skill",
        /^Installed/.test(said) ? "installed for Claude Code" : /^Skipped/.test(said) ? "kept your edited copy" : "already installed",
      ),
    );
  }

  // 3. The daemon, connected to Grok Bot.
  const h = await waitConnected(env);
  if (!h) {
    env.out(line(false, "daemon", installFix(env, "not_connected")));
    return 1;
  }
  env.out(line(true, "daemon", `connected to Grok Bot ${h.appVersion ?? "(unknown version)"} (${h.mode ?? "?"} mode)`));

  // 4. Doctor: read-only checks; nothing is sent.
  let checks: SetupCheck[];
  try {
    checks = await env.doctor();
  } catch (e) {
    env.out(line(false, "doctor", `${(e as Error).message.split("\n")[0]} Fix: run \`groklink doctor\` to see each check.`));
    return 1;
  }
  const failed = checks.find((c) => !c.ok);
  if (failed) {
    env.out(line(false, "doctor", `${failed.name}: ${failed.detail}. Fix that, then run \`groklink doctor\`.`));
    return 1;
  }
  const warned = checks.filter((c) => c.warn);
  env.out(
    line(
      true,
      "doctor",
      `PASS (${checks.length} checks${warned.length ? `; warnings: ${warned.map((c) => `${c.name}: ${c.detail}`).join("; ")}` : ""})`,
    ),
  );

  const first = await env.bots().then(
    (b) => b[0],
    () => undefined,
  );
  env.out(`Try it: groklink doctor --send ${first ? shellName(first) : "<bot>"}  (uses one Grok message)`);
  return 0;
}
