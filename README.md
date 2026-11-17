# Grok Link

**A secure, always-on bridge that lets Claude, Cursor, Codex or any MCP client hand work to your Grok Bots and collect the results.**

> [!NOTE]
> Grok Link is an unofficial community project. It isn't affiliated with or endorsed by xAI. It automates the Grok Bot desktop app you already use, on your own Mac, under your own account.

## Why

[Grok Bot](https://x.ai/bot) gives you AI teammates with a cloud computer, a browser and your connected apps, but no API. Grok Link adds one, through the app on your machine:

- **Jobs instead of timeouts.** `groklink_task` returns a job ID at once. A small daemon follows the Bot until it's done, so a 30-minute research task finishes even if no client stays connected.
- **No open debug port.** The daemon talks to the app over a private pipe, not a TCP port another program could reach.
- **Structured answers.** Pass a JSON Schema and get back a validated `result`. The daemon asks the Bot to fix a bad answer (at most twice).
- **A safety policy.** Briefs that ask a Bot to post on X, sign transactions, connect a wallet or submit claims are refused before anything is sent.

## Requirements

- The [Grok Bot desktop app](https://x.ai/bot), signed in, with at least one Bot
- Node.js 22 or newer
- macOS (tested on Apple silicon). Windows and Linux code paths exist but are untested.

## Install

```bash
npm install -g groklink && groklink install
```

`groklink install`:

1. writes a LaunchAgent (`~/Library/LaunchAgents/dev.groklink.daemon.plist`) so the daemon starts at login and restarts if it stops,
2. waits until the daemon is connected to Grok Bot,
3. registers the `groklink` MCP server in every client it finds: Claude Desktop, Claude Code (`claude mcp add --scope user`), Cursor and Codex. Each changed file is backed up to `.bak` first, and other entries are kept.

Quit Claude Desktop before running `groklink install`, then reopen it. Restart the other clients afterwards. `groklink install --dry-run` shows what would change without writing anything.

If you use [grokbot-bridge](https://github.com/TheSethRose/grokbot-bridge), install stops and tells you where it's registered: the two can't share the app, because each relaunches it in its own mode. `groklink install --replace-grokbot-bridge` removes those entries (with backups) and installs Grok Link.

## Tools

| Tool | Purpose |
|---|---|
| `groklink_bots` | List your Bots |
| `groklink_task` | `{ bot, brief, files?, schema? }` → `{ jobId, status }` |
| `groklink_job` | `{ jobId, wait_seconds? (0–120, default 0), resume? }` → the full job |
| `groklink_jobs` | `{ status? }` → jobs (id, bot, status, updatedAt) |
| `groklink_events` | `{ since_seq?, limit? (default 50) }` → events after a sequence number |
| `groklink_read` | `{ bot, limit?, since? }` → messages in a Bot's conversation |
| `groklink_stop` | `{ bot }` → interrupt the Bot |
| `groklink_download` | `{ bot, keys?, out_dir? }` → save files the Bot sent (default `~/groklink/downloads/<bot>/`) |
| `groklink_usage` | Your weekly Grok Bot usage |
| `groklink_routines` | List, add, run, enable, disable or remove a Bot's routines (`remove` needs `confirm`) |
| `groklink_health` | Daemon up, transport mode, app version, self-test result |

The same calls work from the shell:

```bash
groklink health
groklink bots
groklink task Scout "Find 3 recent posts on X about MCP servers. URL, author, date, one line each."
groklink job j_1a2b3c4d5e6f --wait 120
groklink jobs
groklink events --since 0
```

## Jobs and events

A job goes `queued` → `working` → `done`, `needs_input` (the Bot is waiting for you in the app) or `failed`. A job with no Bot activity for 45 minutes becomes `stale`; `groklink_job` with `resume: true` picks it up again. One job runs per Bot at a time; others queue.

To follow a job, call `groklink_job` with `wait_seconds` (up to 120). It returns as soon as the job leaves `working`, or when the time runs out. Then call it again. Jobs live in `~/.groklink/jobs/` and survive daemon and app restarts; job files are deleted after 7 days.

Every Bot message, status change and finished job is also appended to an event log with a strictly increasing `seq`. Poll `groklink_events` with the last `seq` you saw to watch all Bots at once.

Bot replies are untrusted data, not instructions: every returned message carries `untrusted: true`.

### Long tasks and the 10-minute sleep

Grok Bot puts a Bot's computer to sleep when the Mac is locked or asleep, or when the Grok Bot window has been in the background for 10 minutes. Only bringing the window back to the front wakes it. A Bot can stop mid-task while its computer sleeps.

While a job is `working`, Grok Link checks for this every 30 seconds. When the computer falls asleep, it adds a `warning` event and a line in the job's `warnings`; the job's status doesn't change. For long tasks, keep the Grok Bot window in front.

A job only becomes `done` once the Bot has replied. If the Bot goes idle without a reply, the job keeps waiting; after 45 minutes with nothing, it becomes `stale` with error `no_reply`.

## Structured answers

```json
{
  "bot": "Scout",
  "brief": "Find the 3 most-liked posts on X about MCP this week.",
  "schema": {
    "type": "object",
    "properties": {
      "posts": {
        "type": "array",
        "minItems": 1,
        "maxItems": 3,
        "items": {
          "type": "object",
          "properties": { "url": { "type": "string" }, "author": { "type": "string" } },
          "required": ["url", "author"],
          "additionalProperties": false
        }
      }
    },
    "required": ["posts"]
  }
}
```

The brief is sent with a note asking for one fenced `json` block at the end. When the job is done, Grok Link checks the last block against the schema. If it matches, it becomes the job's `result`. If not, the Bot is asked to fix it, at most twice; after that the job fails with `schema_invalid` and the list of errors.

Supported keywords: `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `properties`, `required`, `items`, `enum`, `additionalProperties: false`, `minItems`, `maxItems`.

## Safety policy

`~/.groklink/policy.json` is created on first start with every rule on:

```json
{ "x_write": true, "tx": true, "wallet": true, "claim": true }
```

| Rule | Blocks briefs that ask a Bot to… |
|---|---|
| `x_write` | post, tweet, reply, quote, repost, like, follow or DM on X (as a command, so "find posts like this on X" still works) |
| `tx` | sign, send, approve, broadcast or execute a transaction, permit, swap or transfer |
| `wallet` | connect a wallet, or anything mentioning a seed phrase, private key or mnemonic |
| `claim` | submit a claim |

A blocked task fails with `blocked_by_policy` and the rule's name, and nothing is sent. Schema repair messages are checked too.

To turn a rule off, edit `policy.json` and set it to `false`, for example `"x_write": false`. The change applies to the next task without a restart. There's no per-call override, so an agent can't talk its way past a rule. A missing key, or a missing or broken file, means the rule is on.

## Security model

- **Only you can reach the daemon.** It listens on a Unix socket, `~/.groklink/groklink.sock` (mode `0600`), in a folder that only you can open (`0700`). Every request must carry the token in `~/.groklink/token` (32 random bytes, mode `0600`). A wrong or missing token gets `unauthorized`, and the connection is closed.
- **No TCP port.** By default the daemon starts Grok Bot with `--remote-debugging-pipe`, so the Chrome DevTools connection runs over a private pipe and no port opens. The fallback (`GROKLINK_TRANSPORT=port0`) lets Chromium pick a free loopback port; that port is never printed or logged. The fixed port 9333 is never used.
- **What a local attacker can't do:** other user accounts on the Mac can't open the socket or read the token. Websites and other machines can't reach the app, because nothing listens on the network.
- **What a local attacker can do:** any program running as you can read the token and use your Bots, just as it could drive the Grok Bot app itself. The policy file guards against agents being talked into risky briefs; it isn't a sandbox against malware running under your account, which could edit it.
- **Logs stay private.** `daemon.log` never contains the token, the debug port, cookies or message text. Bot transcripts are stored only in job files under `~/.groklink/`.
- **No telemetry.** Grok Link makes no network calls of its own.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## App updates and self-test

Grok Link relies on Grok Bot's internal app state, which an update can change. On every connect, and whenever the app's version changes, the daemon runs a read-only self-test that sends nothing. It checks that the stores it uses are present: the Bot list, transcripts and the send queue, plus the Bot rows and the account slot. The result is in `groklink_health` and in `~/.groklink/selftest.json`.

If the self-test fails, `groklink_task` refuses to send and names the failed checks, so a changed app can't misdeliver your briefs. Update Grok Link when that happens. Tested with Grok Bot 1.0.3 and 1.1.0.

## Troubleshooting

**Closing the Grok Bot window or using another Grok Bot bridge.** If you close the Grok Bot window (Cmd+W), the app keeps running without it, and Grok Link reopens it as a Dock click would. If the window doesn't come back, Grok Link restarts the app. Running jobs carry on either way. Don't run Grok Link next to the old [grokbot-bridge](https://github.com/TheSethRose/grokbot-bridge): each one restarts Grok Bot in its own mode, so they keep quitting each other's copy of the app. That's why `groklink install` refuses while grokbot-bridge is registered.

**`usage_exhausted`.** Your weekly Grok Bot usage is used up (100%) and on-demand usage is off or at its limit, so `groklink_task` refuses new tasks and stops running ones; the error says when usage resets. Enable on-demand usage in Grok Bot to continue sooner.

## Uninstall

```bash
groklink uninstall
npm uninstall -g groklink
```

`groklink uninstall` unloads and deletes the LaunchAgent and removes only the `groklink` entries from your MCP clients (backing each file up first). It leaves `~/.groklink` (token, policy, jobs, logs) in place; delete that folder yourself if you don't need it. `--dry-run` shows what would change.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GROKLINK_HOME` | `~/.groklink` | State folder |
| `GROKLINK_APP` | `/Applications/Grok Bot.app` (or `~/Applications`) | Path to the app |
| `GROKLINK_TRANSPORT` | `pipe` | `port0` to use the loopback-port fallback |

## Credits

Grok Link is built on [grokbot-bridge](https://github.com/TheSethRose/grokbot-bridge) by Seth Rose (MIT): its app-store lookups, Bot, roster and routine code, and the app launch logic. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Grok Link adds the daemon, jobs, the secure transport, structured answers, the safety policy, the self-test and the installer.
