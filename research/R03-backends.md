# R03: Other backends (OpenMausBot, Rakazo)

Goal: users who move from Grok Bot to an open-source alternative should be able to keep Grok Link. This note covers how an outside program can drive each project, and what a `Backend` interface in Grok Link would look like. No product code was changed.

## What I checked
- **Read-only, public pages only**, on 2026-11-21. Neither project was installed or run, and no account was created.
- **OpenMausBot** (`milind-soni/OpenMausBot`): the GitHub repo page, `README.md`, `docs/mcp-server.md`, `docs/headless-cli.md`, `package.json`, and the first part of `server/index.ts`.
- **Rakazo** (`elie222/rakazo`): the GitHub repo page, `README.md`, `package.json`, and `docs/self-host.md`, `self-host-clients.md`, `self-host-integrations.md`, `self-host-storage.md`, `self-host-audit-log.md`, `fleet-management.md`, `computer-runtime.md`.
- **Not read:**
  - OpenMausBot: `routes/table.ts` (the HTTP route table), `docs/self-hosting.md`, `docs/custom-mcp-servers.md`, `AGENTS.md`.
  - Rakazo: the `apps/api` route listing, `docs/self-host-billing.md`, `self-host-configuration.md`, `self-host-accounts.md`, `AGENTS.md`, `CHANGELOG.md`.
  - "Not found" below means not in the pages read, not that it doesn't exist.

## Summary
- **OpenMausBot can be a backend now.** It has an official CLI and a stdio MCP server that cover listing Bots, sending, reading, waiting and interrupting, with a pairing token. Grok Link would call its local HTTP server or CLI; no app internals are needed.
- **Rakazo has no documented interface for outside programs.** Its clients use one internal API (`/rpc`, session cookies). A backend would depend on that internal API, as Grok Link depends on Grok Bot's internals today. I'd wait for a public API or ask the maintainers.

## OpenMausBot
| | |
|---|---|
| License | Apache-2.0 (`LICENSE`); `enterprise/` has its own source-available license |
| Version | `0.1.175` in `package.json`; latest release tag not confirmed |
| Shape | Electron desktop app plus a headless `openmausbot` npm CLI and server. macOS, Windows x64, Ubuntu (beta), Fedora (community) |
| Processes | A local "harness server" (`server/index.ts`) on `127.0.0.1:8799` (`OMB_PORT`) owns the agents; the app talks to it over HTTP and one SSE stream. A webhook receiver listens on `127.0.0.1:8800` |
| Agents | The user's own `claude`, `codex` or `grok` CLI |
| State | `~/.openmausbot`; transcripts are NDJSON per thread |

**How an outside program does each thing**

| Need | Official way | Notes |
|---|---|---|
| List Bots | CLI `openmausbot bots`; MCP `list_bots` | |
| Send a message | CLI `openmausbot send TARGET TEXT`; MCP `send_bot_message` | `--send-id` makes a retry idempotent, which would replace Grok Link's duplicate-send guard |
| Read replies | CLI `openmausbot messages TARGET`, `openmausbot events` (JSON lines), `openmausbot wait`; MCP `get_bot_messages`, `wait_for_conversation`; HTTP `GET /api/threads/:id/job` (with `wait` and `version`) | The job endpoint is close to Grok Link's own `job` |
| Stop | CLI `openmausbot interrupt TARGET`; MCP `interrupt_conversation` | |
| Fetch files | CLI `openmausbot export TARGET --out DIR` (writes `manifest.json`, `transcripts/`, `files/`) | No MCP tool found; no per-file fetch found |
| Usage | Not found | Usage belongs to whichever CLI subscription the Bot runs on. `openmausbot doctor` and `get_system_health` exist; I didn't confirm they report usage |
| Routines | Exist (`server/routines.ts`); created by Bots through a `trigger` tool, or in a team file (`openmausbot team apply FILE`) | No list/run/enable command found for outside programs |
| Bot computer | Cloud desktop, local VM, or the user's own machine. `openmausbot computers start BOT` / `sleep BOT` | An explicit wake command, so no window-focus trick |

- **Auth:** pairing. `POST /api/auth/pair` with a code returns a bearer token (`omb_sess_…`), also via `openmausbot login` (30-day session, stored in the Keychain) or `openmausbot token create` (expiring tokens for CI). Read-only tools work on loopback without a session in packaged builds; anything that changes state needs one, and the desktop app shows an approval card first.
- **MCP:** the app is itself a stdio MCP server (`openmausbot mcp`), described as "the v1 server". It leaves out approvals, deletion, credentials and computer lifecycle on purpose.
- **Stability:** the README's status is "Early but real". No statement on API stability was found. The repo moves fast (about 12,000 commits). The CLI and MCP tool names are the documented surface, so they're the safest thing to build on.

**What this means for Grok Link.** OpenMausBot already ships what Grok Link adds to Grok Bot: an MCP server, a job-style wait, tokens. A user there can connect Claude to OpenMausBot's own MCP server directly. Grok Link's value on top would be the parts OpenMausBot's server doesn't have: the safety policy and X approval dialog, structured answers with schema repair, the usage guard, attachment and download rules, and one set of `groklink_*` tools that keeps working when the user changes app.

## Rakazo
| | |
|---|---|
| License | Apache-2.0 (README, `package.json`) |
| Version | `0.1.0` in `package.json`; latest release tag not confirmed |
| Shape | A self-hosted server with web, Electron desktop and Expo mobile clients. Also hosted at the project's own site |
| Processes | `api` (Hono + oRPC, clients call `/rpc`), `worker` (Graphile Worker), `web`, PostgreSQL (Prisma, row-level security), a sandbox supervisor that owns the Docker socket, and one container per Bot computer |
| State | PostgreSQL for metadata and encrypted content; files and Bot homes under `DATA_DIR`, or object storage |

**How an outside program does each thing**

| Need | Official way | Notes |
|---|---|---|
| List Bots | Not found | `list_fleet` is a tool for Bots during a run, not for outside programs |
| Send a message | Not found | Inbound chat-platform webhooks exist at `/api/v1/messaging/webhook/<provider>`; they're for chat platforms, not a general API |
| Read replies | CLI `content-encryption export --bot <id>` inside the api container (JSON Lines, plaintext) | A bulk export for admins, not a way to follow a conversation |
| Stop | Not found | |
| Fetch files | UI download only ("Download needs a running computer") | |
| Usage | Not found (the billing doc wasn't read) | |
| Routines | Exist, with schedule, email, webhook, Git and chat triggers | No outside interface found |
| Audit | `GET /api/audit-events/export` and the `audit.events` RPC | Events only, no message content |

- **Auth:** browser and app sessions through Better Auth (cookies, passkeys, devices). No API key or token scheme for outside programs was found, and no no-auth localhost mode.
- **MCP:** Rakazo consumes MCP servers (remote HTTPS; stdio only with `MCP_STDIO_ENABLED=true`). It doesn't appear to be an MCP server itself.
- **Bot computers:** Docker by default, plus E2B and other providers. Computers sleep when idle and are restored from a saved home.
- **Stability:** no beta label and no API-stability statement found. The README says every client uses "the same Rakazo API", so that API exists and is complete, but it's internal: undocumented, cookie-authenticated, and free to change.

**What this means for Grok Link.** A Rakazo backend is possible only by calling the internal `/rpc` API with a signed-in session. That's the same kind of dependency Grok Link has on Grok Bot today (and needs the same self-test to catch changes), plus a new problem: getting a session without handling the user's password. I wouldn't build it until Rakazo documents an API or token, or its maintainers say the RPC routes are fair to use. Opening an issue to ask is the cheap next step, and it's the user's call since it posts publicly.

## Proposed `Backend` interface
Today the daemon reaches Grok Bot through three shapes: `BotLayer` in `src/daemon/jobs.ts` (find, send, wait, read, recent, phase, usage), direct calls to `src/base/*` from `src/daemon/server.ts` (list, read, stop, download, routines, roster), and `Link` (transport, `requireCdp`, `wake`). A backend interface merges them and removes `CDP` from everything above it.

```ts
/** What a backend can do. The daemon answers `not_supported` for the rest and health lists them. */
type Capabilities = {
  files: boolean;        // attach on send, download
  usage: boolean;        // usage(), and so the usage guard
  routines: "none" | "read" | "full";
  roster: boolean;       // create / update / delete Bots
  wake: boolean;         // can wake an asleep Bot computer
  needsInput: boolean;   // can tell "waiting on the user" from "done"
};

interface Backend {
  readonly name: string;              // "grokbot", "openmausbot"
  readonly capabilities: Capabilities;

  // lifecycle
  start(): void;
  stop(): Promise<void>;
  readonly connected: boolean;
  readonly appVersion: string | null;
  /** Read-only checks for health and doctor (today: selftest.ts and probe.ts). */
  selfTest(): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>;

  // Bots and conversations
  listBots(): Promise<Bot[]>;
  findBot(query: string): Promise<{ id: string; name: string }>;
  send(botId: string, text: string, files: string[], opts?: { sendId?: string }): Promise<string>; // message key
  wait(botId: string, opts: { since?: string; timeoutMs: number; onUpdate(m: Message): void }): Promise<WaitResult>;
  read(botId: string, opts: { since?: string; limit?: number }): Promise<Message[]>;
  interrupt(botId: string): Promise<boolean>;

  // optional, by capability
  download?(botId: string, keys: string[], save: (name: string, data: Buffer) => Promise<string>): Promise<Download[]>;
  usage?(): Promise<Usage>;
  computerPhase?(botId: string): Promise<string | null>;
  wake?(botId: string): Promise<void>;
  routines?: { list(botId: string): Promise<Routine[]>; run?(botId: string, id: string): Promise<Routine>; change?(…): Promise<RoutineChangeResult> };
  roster?: { create(…): Promise<BotProfile>; update(…): Promise<BotProfile>; remove(botId: string): Promise<void> };
}
```

Rules that stay above the interface, so every backend gets them: the policy and approval dialog, attachment and download-folder checks, jobs and the event log, schema repair, the usage guard, `untrusted: true`, and the socket. Errors a backend throws use Grok Link's classes (`BotAsleepError`, `ProtocolError`), never text to be matched; T19c already moved the Grok Bot code that way.

**Which Grok Link feature each backend could support**

| Feature | Grok Bot (today) | OpenMausBot | Rakazo |
|---|---|---|---|
| List Bots, task, job, events | yes | yes (CLI or HTTP) | only through the internal RPC |
| Read, stop | yes | yes | only through the internal RPC |
| Schema answers, policy, approval dialog | yes | yes (all above the interface) | yes, once send and wait work |
| Attach files | yes | not confirmed (no attach flag found on `send`) | not found |
| Download files | yes, per file | partly: `export` writes a whole folder | UI only |
| Usage and the usage guard | yes | no (not found) | not found |
| Asleep warning and wake | yes (window focus) | yes, and simpler (`computers start`) | sleep exists; no outside control found |
| Routines | list, run, change | no outside interface found | no outside interface found |
| `needs_input` | yes | not confirmed | not found |
| Self-test against app changes | needed | light: check the CLI and server version | needed, heavy |

## Work estimate
In Grok Link task sizes (one brief each, with tests):

1. **Backend interface, no behaviour change.** Define `Backend` and `Capabilities`; wrap today's `src/base/*`, `Transport`, `SelfTest` and the probe as the `grokbot` backend; make `jobs.ts` and `server.ts` use only the interface. Largest and riskiest task, because it touches every method and can't be checked without live tests against Grok Bot. 2 tasks (jobs side, then server side) plus one live-test round.
2. **Capabilities on the wire.** `health` reports the backend and its capabilities; unsupported calls fail with a new `not_supported` code; tool descriptions and the skill say so. 1 task.
3. **Backend choice and setup.** `GROKLINK_BACKEND` or a config key; `groklink setup` and `doctor` per backend; the LaunchAgent no longer assumes Grok Bot is the app to own. 1 task.
4. **OpenMausBot backend.** Pairing and token storage (0600), list, send with `--send-id`, wait or the job endpoint, read, interrupt, computer phase and wake; fakes for tests. 2 tasks, plus a research probe first (R04) to read `routes/table.ts` and confirm attachments, `needs_input` and whether HTTP or the CLI is the better transport. Needs the user to install OpenMausBot for the live check.
5. **Rakazo backend.** Not estimated. Blocked on a documented API or token; at least a research probe (session handling, the RPC routes) and likely 3 or more tasks after that.

So: about 5 tasks to make Grok Link backend-neutral with Grok Bot unchanged, then about 3 for OpenMausBot. Rakazo waits.

## Open questions
- Is a second backend worth it for OpenMausBot users, who already have an MCP server from the app itself? The case rests on the policy, approval, schema and usage features, and on one tool set across apps.
- One daemon per backend, or one daemon with several backends at once (Bots from both apps in `groklink_bots`)? The interface above allows either; the estimate assumes one backend at a time.
- The name: tools are `groklink_*` and the docs say "Grok Bot" throughout. A second backend makes both slightly wrong.
