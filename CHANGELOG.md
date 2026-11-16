# Changelog

## 0.1.0

- Daemon (`groklinkd`) that owns the Grok Bot app and keeps one connection to it, relaunching the app if it quits.
- Secure transport: `--remote-debugging-pipe` by default (no TCP port), with a loopback `port0` fallback; the fixed port 9333 is never used.
- Token-protected Unix socket (`0600` in a `0700` folder); wrong tokens get `unauthorized`.
- Jobs: `groklink_task` returns a job ID at once; a daemon-side waiter follows the Bot to `done`, `needs_input`, `failed` or `stale`, and jobs survive daemon and app restarts.
- Event log with strictly increasing sequence numbers (`groklink_events`).
- Structured answers: an optional JSON Schema, validated, with up to 2 automatic repair requests.
- Duplicate-send guard: a brief that was already delivered before a restart isn't sent again.
- Safety policy (`x_write`, `tx`, `wallet`, `claim`), on by default, editable in `policy.json`, with no per-call override.
- Read-only self-test on every connect and app version change; tasks are refused if it fails.
- Thin MCP server with 11 `groklink_*` tools, and a CLI (`health`, `bots`, `task`, `job`, `jobs`, `events`).
- `groklink install` / `uninstall`: LaunchAgent, MCP registration in Claude Desktop, Claude Code, Cursor and Codex, backups, `--dry-run`, and a grokbot-bridge conflict check.
- Bot replies are marked `untrusted: true`.
- A job is `done` only once the Bot has replied; an idle Bot with no reply keeps it `working`, and after 45 minutes it becomes `stale` with `no_reply`.
- Sleep warnings: a `warning` event and a job `warnings` entry when the Bot's computer falls asleep (the Grok Bot window was in the background for 10+ minutes).
- Closed-window recovery: if the Grok Bot window is closed (Cmd+W), the daemon reopens it as a Dock click would, and relaunches the app if that fails.
- Install refuses while Claude Desktop is running, because Claude Desktop rewrites its config when it quits and would undo the change. Every check that can fail runs before anything is changed, and client configs are only edited after the daemon is running.
- Install waits for `launchctl bootout` to finish before `bootstrap`, and retries `bootstrap` once.
