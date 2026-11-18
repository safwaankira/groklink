// `groklink install` / `uninstall`: a LaunchAgent that runs groklinkd at login, plus MCP registration in
// whichever supported clients exist (Claude Desktop, Claude Code, Cursor, Codex). No scripts, no fixed paths.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statePaths } from "../daemon/state.ts";
import { call } from "./socket.ts";

export const LABEL = "dev.groklink.daemon";
const NAME = "groklink";
const WAIT_MS = 30_000;

type Health = { connected?: boolean; appVersion?: string | null; mode?: string };
export type InstallEnv = {
  home: string;
  /** $GROKLINK_HOME (default ~/.groklink). */
  stateHome: string;
  uid: number;
  node: string;
  /** Absolute path of the running groklink.js; groklinkd.js sits next to it. */
  cli: string;
  run(cmd: string, args: string[]): { status: number };
  onPath(name: string): boolean;
  health(): Promise<Health>;
  out(line: string): void;
  /**
   * Whether the Claude Desktop app is running (it rewrites its config when it quits). macOS `pgrep` skips its own
   * ancestors unless given `-a`, and install often runs from a Claude Code session inside Claude Desktop.
   */
  desktopRunning?(): boolean;
  /** The packaged skills/groklink/SKILL.md; null if it can't be found. */
  skillSource?: string | null;
  waitMs?: number;
  pollMs?: number;
  /** How long to wait for `launchctl bootout` to finish, how often to check, and the pause before retrying `bootstrap`. */
  bootoutWaitMs?: number;
  launchPollMs?: number;
  bootstrapRetryMs?: number;
};

export function defaultEnv(): InstallEnv {
  return {
    home: homedir(),
    stateHome: statePaths().home,
    uid: process.getuid?.() ?? 0,
    node: process.execPath,
    cli: realpathSync(process.argv[1]),
    run: (cmd, args) => ({ status: spawnSync(cmd, args, { stdio: "ignore" }).status ?? 1 }),
    onPath: (name) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, name))),
    health: async () => (await call("health")) as Health,
    out: (line) => console.log(line),
    skillSource: packagedSkill(),
    desktopRunning: () =>
      process.platform === "darwin" &&
      spawnSync("pgrep", ["-a", "-U", String(process.getuid?.() ?? ""), "-x", "Claude"], { stdio: "ignore" }).status === 0,
  };
}

export type Options = { dryRun?: boolean; replaceGrokbotBridge?: boolean };

const SKILL = join("skills", "groklink", "SKILL.md");

/** skills/groklink/SKILL.md in the package: next to dist/ when built, two folders up from src/client/ in a checkout. */
function packagedSkill(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 3; i++, dir = dirname(dir)) if (existsSync(join(dir, SKILL))) return join(dir, SKILL);
  return null;
}

/**
 * `groklink install --skill`: copy the agent skill to ~/.claude/skills/groklink/SKILL.md. An existing, different copy is
 * kept unless `force`. Returns the exit code.
 */
export function installSkill(env: InstallEnv, opts: { force?: boolean; dryRun?: boolean } = {}): number {
  try {
    return copySkill(env, opts);
  } catch (e) {
    // e.g. ~/.claude is a file, or a folder isn't writable.
    env.out(`groklink install --skill: couldn't install the skill: ${(e as Error).message}`);
    return 1;
  }
}

function copySkill(env: InstallEnv, opts: { force?: boolean; dryRun?: boolean }): number {
  const src = env.skillSource;
  if (!src || !existsSync(src)) {
    env.out("Couldn't find the packaged skill (skills/groklink/SKILL.md). Reinstall groklink.");
    return 1;
  }
  const dest = join(env.home, ".claude", SKILL);
  const text = readFileSync(src, "utf8");
  if (existsSync(dest)) {
    if (readFileSync(dest, "utf8") === text) {
      env.out(`The Grok Link skill is already installed at ${dest}.`);
      return 0;
    }
    if (!opts.force) {
      env.out(
        `Skipped: ${dest} already exists and differs from this version's skill. Run \`groklink install --skill --force\` to replace it.`,
      );
      return 0;
    }
  }
  if (opts.dryRun) {
    env.out(`Dry run; nothing was written. groklink install --skill would write ${dest}.`);
    return 0;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  env.out(`Installed the Grok Link skill at ${dest}. New Claude Code sessions will load it.`);
  return 0;
}

const SKILL_HINT = "Tip: run `groklink install --skill` to add the Grok Link skill for Claude Code (~/.claude/skills/groklink/).";

// ---- client configs ----

type Server = { command?: unknown; args?: unknown };
type JsonObject = Record<string, unknown>;
type Conflict = { client: string; file: string; name: string; remove: () => void };

/** An MCP entry that runs TheSethRose/grokbot-bridge. */
export function isGrokbotBridge(command: unknown, args: unknown): boolean {
  const s = [command, ...(Array.isArray(args) ? args : [])].map(String).join(" ");
  return /grokbot-bridge/.test(s) || /(^|[\s/])grokbot mcp(\s|$)/.test(s);
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Writes config files, each backed up to `.bak` once per run before its first change. */
class Writer {
  private backedUp = new Set<string>();

  backup(file: string): void {
    if (this.backedUp.has(file)) return;
    this.backedUp.add(file);
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  }

  write(file: string, text: string): void {
    this.backup(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

function readJson(file: string): JsonObject | null {
  if (!existsSync(file)) return null;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} isn't valid JSON. Fix or move it and run this again; nothing was changed.`);
  }
  if (!isObject(v)) throw new Error(`${file} isn't a JSON object. Fix or move it and run this again; nothing was changed.`);
  return v;
}

const jsonText = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** The `mcpServers` maps in a JSON config: top level, plus each project's in ~/.claude.json. */
function serverMaps(cfg: JsonObject, withProjects: boolean): JsonObject[] {
  const maps = isObject(cfg.mcpServers) ? [cfg.mcpServers] : [];
  if (withProjects && isObject(cfg.projects))
    for (const p of Object.values(cfg.projects)) if (isObject(p) && isObject(p.mcpServers)) maps.push(p.mcpServers);
  return maps;
}

function jsonConflicts(client: string, file: string, withProjects: boolean, w: Writer): Conflict[] {
  const cfg = readJson(file);
  if (!cfg) return [];
  const out: Conflict[] = [];
  for (const [i, map] of serverMaps(cfg, withProjects).entries())
    for (const [name, s] of Object.entries(map))
      if (isObject(s) && isGrokbotBridge((s as Server).command, (s as Server).args))
        out.push({
          client,
          file,
          name,
          remove: () => {
            const now = readJson(file);
            if (!now) return;
            delete serverMaps(now, withProjects)[i]?.[name];
            w.write(file, jsonText(now));
          },
        });
  return out;
}

/** `[mcp_servers.<name>]` tables in a TOML file: name, first line, end line (exclusive). */
function tomlTables(text: string): { name: string; start: number; end: number }[] {
  const lines = text.split("\n");
  const out: { name: string; start: number; end: number }[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/^\s*\[/.test(line)) continue;
    const last = out.at(-1);
    if (last && last.end === -1) last.end = i;
    const m = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/);
    if (m) out.push({ name: m[1] ?? m[2], start: i, end: -1 });
  }
  const last = out.at(-1);
  if (last && last.end === -1) last.end = lines.length;
  return out;
}

function tomlWithout(text: string, name: string): string {
  const t = tomlTables(text).find((x) => x.name === name);
  if (!t) return text;
  const lines = text.split("\n");
  lines.splice(t.start, t.end - t.start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function tomlConflicts(file: string, w: Writer): Conflict[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  return tomlTables(text)
    .filter((t) => {
      const body = lines.slice(t.start + 1, t.end).join("\n");
      const command = body.match(/^\s*command\s*=\s*["']([^"']*)["']/m)?.[1];
      const args = [...(body.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      return /grokbot-bridge/.test(body) || isGrokbotBridge(command, args);
    })
    .map((t) => ({
      client: "Codex",
      file,
      name: t.name,
      remove: () => w.write(file, tomlWithout(readFileSync(file, "utf8"), t.name)),
    }));
}

type Paths = { desktop: string; cursor: string; claudeJson: string; codex: string; plist: string };

function paths(env: InstallEnv): Paths {
  return {
    desktop: join(env.home, "Library/Application Support/Claude/claude_desktop_config.json"),
    cursor: join(env.home, ".cursor/mcp.json"),
    claudeJson: join(env.home, ".claude.json"),
    codex: join(env.home, ".codex/config.toml"),
    plist: join(env.home, "Library/LaunchAgents", `${LABEL}.plist`),
  };
}

function conflicts(env: InstallEnv, w: Writer): Conflict[] {
  const p = paths(env);
  return [
    ...jsonConflicts("Claude Desktop", p.desktop, false, w),
    ...jsonConflicts("Claude Code", p.claudeJson, true, w),
    ...jsonConflicts("Cursor", p.cursor, false, w),
    ...tomlConflicts(p.codex, w),
  ];
}

/** A change to make: what it is, whether it's needed, and how to make it. */
type Step = { client: string; describe: string; apply: () => void };

function registrations(env: InstallEnv, w: Writer): Step[] {
  const p = paths(env);
  const entry = { command: env.node, args: [env.cli, "mcp"] };
  const steps: Step[] = [];
  const json = (client: string, file: string) => {
    if (!existsSync(dirname(file))) return;
    const cfg = readJson(file) ?? {};
    if (isObject(cfg.mcpServers) && Object.hasOwn(cfg.mcpServers, NAME)) return env.out(`${client}: already has "${NAME}", skipped.`);
    steps.push({
      client,
      describe: `add mcpServers.${NAME} to ${file}`,
      apply: () => {
        const now = readJson(file) ?? {};
        now.mcpServers = { ...(isObject(now.mcpServers) ? now.mcpServers : {}), [NAME]: entry };
        w.write(file, jsonText(now));
      },
    });
  };
  json("Claude Desktop", p.desktop);
  if (env.onPath("claude")) {
    const cfg = readJson(p.claudeJson);
    if (cfg && isObject(cfg.mcpServers) && Object.hasOwn(cfg.mcpServers, NAME)) env.out(`Claude Code: already has "${NAME}", skipped.`);
    else
      steps.push({
        client: "Claude Code",
        describe: `run: claude mcp add --scope user ${NAME} -- ${env.node} ${env.cli} mcp`,
        apply: () => {
          w.backup(p.claudeJson);
          if (env.run("claude", ["mcp", "add", "--scope", "user", NAME, "--", env.node, env.cli, "mcp"]).status !== 0)
            throw new Error("claude mcp add failed.");
        },
      });
  }
  json("Cursor", p.cursor);
  if (existsSync(dirname(p.codex))) {
    const text = existsSync(p.codex) ? readFileSync(p.codex, "utf8") : "";
    if (tomlTables(text).some((t) => t.name === NAME)) env.out(`Codex: already has [mcp_servers.${NAME}], skipped.`);
    else
      steps.push({
        client: "Codex",
        describe: `append [mcp_servers.${NAME}] to ${p.codex}`,
        apply: () => {
          const now = existsSync(p.codex) ? readFileSync(p.codex, "utf8") : "";
          const table = `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(env.node)}\nargs = [${JSON.stringify(env.cli)}, "mcp"]\n`;
          w.write(p.codex, `${now}${now && !now.endsWith("\n") ? "\n" : ""}${now ? "\n" : ""}${table}`);
        },
      });
  }
  return steps;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(env: InstallEnv): string {
  const daemon = join(dirname(env.cli), "groklinkd.js");
  const out = join(env.stateHome, "daemon.out");
  // launchd doesn't see the shell's environment, so pass on a custom state folder or app path. GROKLINK_TRANSPORT is
  // never saved: port0 exposes the debug port to every account, so it mustn't stick across logins.
  const vars = ["GROKLINK_HOME", "GROKLINK_APP"].filter((k) => process.env[k]);
  const envXml = vars.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${vars.map((k) => `    <key>${k}</key>\n    <string>${xml(process.env[k] as string)}</string>\n`).join("")}  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(env.node)}</string>
    <string>${xml(daemon)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(out)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(out)}</string>
${envXml}</dict>
</plist>
`;
}

async function waitConnected(env: InstallEnv): Promise<Health | null> {
  const deadline = Date.now() + (env.waitMs ?? WAIT_MS);
  for (;;) {
    try {
      const h = await env.health();
      if (h.connected) return h;
    } catch {}
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, env.pollMs ?? 1_000));
  }
}

const QUIT_DESKTOP =
  "Quit Claude Desktop (Cmd+Q) first: it rewrites its config when it quits and would undo this change. Then run this command again.";

const DESKTOP = "Claude Desktop";

/** True if this run would edit the Claude Desktop config while Claude Desktop is running. */
function desktopBusy(env: InstallEnv, changesDesktop: boolean): boolean {
  return changesDesktop && (env.desktopRunning?.() ?? false);
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `bootout` returns before the service is gone, so wait for that before `bootstrap`; retry `bootstrap` once. */
async function loadAgent(env: InstallEnv, plistFile: string): Promise<boolean> {
  const target = `gui/${env.uid}/${LABEL}`;
  env.run("launchctl", ["bootout", target]);
  const deadline = Date.now() + (env.bootoutWaitMs ?? 10_000);
  while (env.run("launchctl", ["print", target]).status === 0 && Date.now() < deadline) await sleepMs(env.launchPollMs ?? 250);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleepMs(env.bootstrapRetryMs ?? 1_000);
    if (env.run("launchctl", ["bootstrap", `gui/${env.uid}`, plistFile]).status === 0) return true;
  }
  return false;
}

/** Returns the exit code. */
export async function install(env: InstallEnv, opts: Options = {}): Promise<number> {
  const w = new Writer();
  const p = paths(env);
  // Every check that can fail runs before anything is changed, so a failed run leaves no half-done state.
  const found = conflicts(env, w);
  const blocked = found.length > 0 && !opts.replaceGrokbotBridge;
  if (blocked) {
    for (const c of found) env.out(`Found the old Grok Bot bridge (grokbot-bridge) in ${c.client}: entry "${c.name}" in ${c.file}.`);
    env.out("Grok Link and grokbot-bridge can't share the Grok Bot app: each relaunches it in its own mode and closes the other's copy.");
    env.out(
      "Run `groklink install --replace-grokbot-bridge` to remove those entries (each file is backed up to .bak first). Nothing was changed.",
    );
  }
  const register = registrations(env, w);
  const busy = desktopBusy(env, found.some((c) => c.client === DESKTOP) || register.some((s) => s.client === DESKTOP));
  if (busy) env.out(QUIT_DESKTOP);
  if (blocked || (busy && !opts.dryRun)) return 1;
  const launchAgent = `write ${p.plist} and load it with launchctl (gui/${env.uid}/${LABEL})`;
  if (opts.dryRun) {
    env.out("Dry run; nothing was written. groklink install would:");
    for (const c of found) env.out(`- remove "${c.name}" (grokbot-bridge) from ${c.client} (${c.file}, backed up to .bak)`);
    env.out(`- ${launchAgent}`);
    for (const s of register) env.out(`- ${s.client}: ${s.describe}`);
    return 0;
  }
  if (process.env.GROKLINK_TRANSPORT)
    env.out(
      "GROKLINK_TRANSPORT is set, but it isn't saved in the LaunchAgent: the installed daemon always starts in pipe mode (port0 lets every account on this Mac reach Grok Bot).",
    );
  // The LaunchAgent goes first: if it fails, no client config has been touched.
  mkdirSync(env.stateHome, { recursive: true, mode: 0o700 });
  w.write(p.plist, plist(env));
  if (!(await loadAgent(env, p.plist))) {
    env.out(
      `launchctl bootstrap failed for ${p.plist} (tried twice). No client config was changed. See ${join(env.stateHome, "daemon.log")}.`,
    );
    return 1;
  }
  const h = await waitConnected(env);
  if (!h) {
    env.out(
      `The daemon didn't connect to Grok Bot within ${(env.waitMs ?? WAIT_MS) / 1000} s. No client config was changed. See ${join(env.stateHome, "daemon.log")}.`,
    );
    return 1;
  }
  env.out(`Grok Link is running: connected: true (${h.mode ?? "?"} mode, Grok Bot ${h.appVersion ?? "unknown version"}).`);
  for (const c of found) {
    c.remove();
    env.out(`Removed "${c.name}" (grokbot-bridge) from ${c.client}; backup at ${c.file}.bak`);
  }
  for (const s of register) s.apply();
  if (register.length) {
    env.out(`Registered the groklink MCP server in: ${register.map((s) => s.client).join(", ")}.`);
    env.out("Restart those apps to load it.");
  } else env.out("No new MCP client registrations were needed.");
  env.out(SKILL_HINT);
  return 0;
}

/** Returns the exit code. */
export async function uninstall(env: InstallEnv, opts: Options = {}): Promise<number> {
  const w = new Writer();
  const p = paths(env);
  const steps: Step[] = [];
  if (existsSync(p.plist))
    steps.push({
      client: "LaunchAgent",
      describe: `unload gui/${env.uid}/${LABEL} and delete ${p.plist}`,
      apply: () => {
        env.run("launchctl", ["bootout", `gui/${env.uid}/${LABEL}`]);
        rmSync(p.plist, { force: true });
      },
    });
  for (const [client, file] of [
    ["Claude Desktop", p.desktop],
    ["Cursor", p.cursor],
  ] as const) {
    const cfg = readJson(file);
    if (cfg && isObject(cfg.mcpServers) && Object.hasOwn(cfg.mcpServers, NAME))
      steps.push({
        client,
        describe: `remove mcpServers.${NAME} from ${file}`,
        apply: () => {
          const now = readJson(file);
          if (!now || !isObject(now.mcpServers)) return;
          delete now.mcpServers[NAME];
          w.write(file, jsonText(now));
        },
      });
  }
  const claude = readJson(p.claudeJson);
  if (claude && isObject(claude.mcpServers) && Object.hasOwn(claude.mcpServers, NAME))
    steps.push({
      client: "Claude Code",
      describe: `run: claude mcp remove --scope user ${NAME}`,
      apply: () => {
        w.backup(p.claudeJson);
        if (env.run("claude", ["mcp", "remove", "--scope", "user", NAME]).status !== 0) throw new Error("claude mcp remove failed.");
      },
    });
  if (existsSync(p.codex) && tomlTables(readFileSync(p.codex, "utf8")).some((t) => t.name === NAME))
    steps.push({
      client: "Codex",
      describe: `remove [mcp_servers.${NAME}] from ${p.codex}`,
      apply: () => w.write(p.codex, tomlWithout(readFileSync(p.codex, "utf8"), NAME)),
    });
  if (
    desktopBusy(
      env,
      steps.some((s) => s.client === DESKTOP),
    )
  ) {
    env.out(QUIT_DESKTOP);
    if (!opts.dryRun) return 1;
  }
  if (opts.dryRun) {
    env.out("Dry run; nothing was written. groklink uninstall would:");
    for (const s of steps) env.out(`- ${s.client}: ${s.describe}`);
    if (!steps.length) env.out("- nothing (Grok Link isn't installed)");
    return 0;
  }
  for (const s of steps) {
    s.apply();
    env.out(`${s.client}: done (${s.describe}).`);
  }
  if (!steps.length) env.out("Grok Link wasn't installed; nothing to remove.");
  env.out(`Left ${env.stateHome} in place (token, policy, jobs, logs). Delete it yourself if you don't need it.`);
  return 0;
}
