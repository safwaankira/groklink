# Security

## Reporting a vulnerability

Please report security problems privately through a GitHub security advisory: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for them. Include the Grok Link and Grok Bot versions, what you did and what happened. You'll get a reply as soon as possible, and fixes are released before details are made public.

## Threat model

- **Other local users:** the daemon's socket (`~/.groklink/groklink.sock`, `0600`) sits in a folder only you can open (`0700`), and every request needs the 32-byte token in `~/.groklink/token` (`0600`). In the default pipe mode, other accounts on the Mac can't reach your Bots. **Exception:** while the `port0` fallback is in use, its loopback debug port has no token and every account on the Mac can reach Grok Bot through it. Grok Link never saves port0 in the LaunchAgent, and `groklink_health` warns while it's on.
- **The network and websites:** in pipe mode nothing listens on a TCP port. The optional `port0` fallback binds to loopback only (not the network), on a random port that is never logged.
- **Programs running as you:** these can read the token and use your Bots, as they could drive the app itself. Grok Link doesn't defend against malware in your own account.
- **Prompt-injected agents:** the policy (`~/.groklink/policy.json`) refuses briefs, routines and attached text files that ask a Bot to post on X, sign or send transactions, connect a wallet or submit claims, with no per-call override. It's a **best-effort seatbelt**: it matches phrases, so unusual wording can get past it. The owner can turn rules off or set `x_write` to `allow` (`groklink policy`), and so can a local process with your file access (the daemon reads the file only at start and warns in `health` if it changes, but a process that can also restart the daemon can apply its edit).
- **Approving posts to X:** in `x_write: approve` mode, a task that would post waits for you to click **Approve and send** in a macOS dialog. No MCP tool or socket method can approve it. But the dialog is only as safe as your screen: any process that can click on your screen (for example an app with Accessibility or screen-control permission, or an agent with computer use) could approve it. If that worries you, keep `block`.
- **Untrusted Bot output:** Bots read the web. Messages, message events, Bot previews and routine results carry `untrusted: true`, and clients should treat them as data, not instructions. Downloaded files get safe names, launcher extensions are neutralized, and macOS's quarantine flag is set.
- **A changed Grok Bot app:** a self-test checks the app's internals on every connect and version change, and blocks sending if they changed.
- **Secrets on disk and in logs:** logs never contain the token, the debug port, cookies or message text. Transcripts are stored only in job files and the event log under `~/.groklink/`, both pruned after 7 days.
- **No telemetry:** Grok Link makes no network calls of its own.
