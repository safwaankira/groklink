# Changelog

## 0.1.7

- **Usage guard.** `policy.json` takes `"usage": { "warn": 80, "pause": 100 }` (percent of weekly Grok usage used; those are the defaults). From `warn`, `groklink_health` warns "Grok usage is at N% (warn at W%)." and `groklink doctor` shows the usage line as `!`. From `pause` (when below 100), new tasks and routine runs are refused with the new code `usage_paused`, and nothing is sent; running jobs aren't stopped. `pause: 100` keeps the old behaviour. Files without the key use the defaults; invalid values use the defaults too, with a health warning.
- **`groklink policy usage`** shows the two numbers; `groklink policy usage warn <0-100>` and `groklink policy usage pause <1-100>` rewrite `policy.json` (0600, atomic) and restart the daemon. CLI only.
- **`groklink setup`.** One command for first use: installs the LaunchAgent and registers your MCP clients, adds the agent skill (an existing copy is kept), waits for the daemon and runs doctor, printing one `✓`/`✗` line per step. A failed step says how to fix it and exits 1. It never sends a Bot message, is safe to run again, and has `--dry-run`. The quick start is now `npm i -g groklink`, then `groklink setup`.
- **Approval dialog.** The Bot's name is shown only if it's plain text (the same rule as the brief, one line, at most 60 characters); otherwise the dialog shows the Bot's id. Approve mode now accepts skin-tone emoji, flags and keycaps, and refuses code points that aren't assigned yet.
- **`groklink policy` and a dangling symlink.** A symlinked `policy.json` whose target doesn't exist yet is written through (the target is created); the link is no longer replaced by a file.
- **Daemon log.** A failed call logs its message only for Grok Link's own errors. Errors that come from the app or a Bot's side (routine names, the app's error text) log the code alone.
- **Partial downloads.** If a file fails after others were saved, `groklink_download` returns the saved files with `partial: true` and an `error` (code, message, `failedKey`) instead of failing the whole call.
- **`file_blocked` through a link.** When only a link's target is protected, the message names the link and says it points to a blocked location; the target isn't named.
- **Asleep detection.** `bot_asleep` now comes from the app's own failure code, never from message text, so a routine or file whose name mentions sleep can't trigger a wake. Sending and stopping report `bot_asleep` too. The once-a-minute wake limit follows the Bot's id, whatever name a call uses.
- **Docs.** The README opens with what Grok Link is and the two-line quick start, and has a Questions section. `llms.txt` (shipped in the package) lists the tools and what an agent should do for each error code.

## 0.1.6

- **Asleep Bots aren't "internal" errors any more.** A call that needs the Bot's computer while Grok Bot has parked it now fails with the new code `bot_asleep` and `retryAfterSec: 10`: "<Bot>'s computer is asleep. Bring the Grok Bot window to the front, then try again in ~10 s."
- **One automatic wake.** Before failing, `read`, `download` and routine `list`/`run` bring the Grok Bot window to the front once (at most once per 60 s per Bot), wait up to 15 s for the computer to wake, and retry once. Routine changes that message the Bot are never retried.
- **`no_files`** when a Bot hasn't sent any files to download (was `internal`).
- **Clearer `file_blocked`.** The message names the attachment's file name and the rule (`credential_folder`, `secret_name` or `attach_roots`), and the error carries `rule`.
- **Daemon log.** Every failed call logs `<method> failed (<code>[, rule <rule>]): <first line of the message>`, plus `woke <bot> for <method>` or `wake failed`. Never Bot text or file contents.
- Tool descriptions and the skill say what to do on `bot_asleep` (retry once after `retryAfterSec`, never loop) and `file_blocked` (don't retry with the same or a renamed file).

## 0.1.5

- **Posting to X has three modes.** `x_write` in `policy.json` is `block` (default, as before), `approve` or `allow`. Old files keep working: `true` is `block`, `false` is `allow`, and an unknown value is `block` with a warning.
- **`approve` mode.** A task that would post to X starts as `needs_approval` and nothing is sent until you click **Approve and send** in a macOS dialog showing the Bot and the whole brief. **Deny** fails the task with `approval_denied`, and no answer within 10 minutes with `approval_timeout`. Approve mode accepts plain text only: every character of a posting brief must be printable ASCII, a newline or an emoji, with at most 40 lines, no more than 2 blank lines in a row and at most 1,500 characters; anything else is `blocked_by_policy`. The dialog shows the brief exactly as it's sent, and a task that needs approval can't have attachments or a schema (a posting request in an attachment or schema is blocked too). At most 5 tasks wait for approval at once; more fail with `approval_queue_full`. If the dialog can't be shown, the task fails with `approval_error`. After a daemon restart, held tasks follow the current mode. One dialog at a time; each decision goes to the event log (rule, decision, job id; no brief text). No tool, socket method or flag can approve a task, and the socket now refuses unknown parameters on `task`, `job` and `jobs`.
- **`allow` mode.** Posting briefs pass, and `groklink_health` warns about it.
- **`groklink policy`** shows each rule and mode. `groklink policy x_write <block|approve|allow>` rewrites `policy.json` (0600, atomic) and restarts the daemon. CLI only. It refuses to rewrite a `policy.json` it can't parse (prints the error, exits 1), so your other settings aren't lost, and writes through a symlinked `policy.json`.
- `groklink_job` over MCP waits at most 50 s (`wait_seconds` maximum 50; larger values are clamped), to stay under MCP clients that time out a tool call after about a minute. `groklink job --wait` still allows 120.
- `groklink_health` shows `policy.x_write` as the mode, and `groklink doctor` prints it (`!` when `allow`).

## 0.1.4

- **Usage gate after a reset.** A cached "used up" reading is no longer reused once its reset time has passed, and `groklink_task` re-reads usage once before refusing with `usage_exhausted`. Before, a task sent just after the weekly reset could still be refused for up to a minute. If the re-read fails, the last reading still applies.
- **`groklink doctor --send`.** It passes as soon as the Bot's reply contains "pong", even if the Bot keeps working on other tasks afterwards; the line then says so. It checks every 15 s at most and never stops the job.

## 0.1.3

- **Deep health.** `groklink_health` takes `deep: true` to make a real, read-only round trip through Grok Bot. It returns a `probe` with one result per check: `app`, `account` (signed in / signed out / unknown), `roster`, `transcript`, `usage` and `awake`. Each check is capped at 10 s. Failed checks add plain-English lines to `warnings`, e.g. "Grok Bot is signed out — open the app and sign in". Plain health is unchanged.
- **`groklink doctor`.** Prints one line per check, then `PASS` or `FAIL: <check>`, with exit code 0 or 1. `--send <bot>` also runs one real "pong" task (uses one Grok message), and `--json` prints the raw result. Without `--send`, nothing is sent.
- **Agent skill.** `skills/groklink/SKILL.md` ships in the package, and `groklink install --skill` copies it to `~/.claude/skills/groklink/`. It keeps an edited copy unless `--force` is given.

## 0.1.2

- Routines get the safety policy: a new routine's name and prompt, and the name and stored prompt of a routine being enabled or run, are checked; blocked → `blocked_by_policy`, nothing sent.
- Download folders are restricted: `out_dir` must be under `~/.groklink/downloads` (the new default, per Bot), `~/Downloads/groklink`, or a folder in `~/.groklink/download-roots.json`; dot-folders and `~/Library` are always refused (`dir_blocked`). Checked on real paths before anything is created, and again after.
- More secrets are never attached: Docker, GitHub CLI, Solana, Foundry and Ethereum keystores, keyrings, cookies, browser profiles, Safari, Messages and Mail data, `~/.git-credentials`, and `*.keystore`, `*keypair*.json`, `*.p12`, `*.pfx`, `*mnemonic*`, `*seed*phrase*` files.
- The daemon watches its socket file and listens again if it's replaced or its mode is loosened.
- `groklink_health` has `warnings`; in port0 mode it says local processes can reach Grok Bot.
- Attachment and download-folder rules compare real paths in their on-disk case, so `~/.AWS/credentials` no longer slips past a rule for `~/.aws` on macOS.
- Routine schedules are policy-checked too.
- Policy coverage: `x_write` adds share, send, upload, thread, boost and amplify, and targets your account, timeline or profile; `tx` adds confirm, authorize and accept, and targets approvals, pending requests, wallets, contract calls and bridges, matched within 10 words in either order ("send me…" and "confirm whether…" excluded).
- The policy also reads attached text files (`.txt`, `.md`, `.json`, `.csv`, `.html`, up to 1 MB); a blocked one is named in the error.
- `policy.json` is read at daemon start only; a later edit isn't applied, and `groklink_health` shows `policy` (each rule on/off) and warns about rules that are off and about an edited file.
- More secrets are never attached: `~/.claude.json`, `~/.claude/`, `~/.codex/auth.json`, `~/.cargo/credentials*`, `~/.pypirc`, `~/.azure`, shell history, Grok Bot's own data folder, and wallet apps (Exodus, Atomic, Electrum, Phantom, MetaMask, Rabby, Ledger Live).
- Downloads: Unicode format characters (such as right-to-left overrides) are removed from file names, launcher and installer extensions get `.download` added, and saved files are marked with macOS's quarantine flag.
- `groklink install` no longer saves `GROKLINK_TRANSPORT` in the LaunchAgent, and warns if it's set.
- `events.jsonl` is pruned after 7 days like the job files; message events, Bot previews and routine results are flagged `untrusted: true`.
- Process checks (`pgrep`/`pkill`) only look at your own processes.
- Attachments that hold secrets are refused with `file_blocked`: anything under `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/Library/Keychains` or `~/.groklink`, `~/.npmrc`, `~/.netrc`, and any `.env*`, `*.pem`, `*.key` or `id_*` file, also through symlinks. Optional allowlist: `~/.groklink/attach-roots.json`.
- Downloads: file names from a Bot are reduced to a safe basename, and the file must land inside the download folder.
- Policy: text is NFKC-normalized, zero-width characters are removed and Cyrillic/Greek look-alike letters are mapped before matching.

## 0.1.1

- `usage_exhausted`: when the weekly Grok Bot usage is used up and on-demand usage can't cover it, `groklink_task` refuses at once (nothing is sent) and running jobs fail instead of waiting 45 minutes for `no_reply`. `groklink_health` shows `usage: { percentUsed, resetsAt, out }`.
- Policy: `x_write` no longer blocks briefs that only describe a refusal, such as "refuses to post on X" or "when asked to reply to @someone".

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
