# Security

## Reporting a vulnerability

Please report security problems privately through a GitHub security advisory: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for them. Include the Grok Link and Grok Bot versions, what you did and what happened. You'll get a reply as soon as possible, and fixes are released before details are made public.

## Threat model

- **Other local users:** the daemon's socket (`~/.groklink/groklink.sock`, `0600`) sits in a folder only you can open (`0700`), and every request needs the 32-byte token in `~/.groklink/token` (`0600`). Other accounts on the Mac can't reach your Bots.
- **The network and websites:** nothing listens on a TCP port. Grok Bot is driven over `--remote-debugging-pipe`; the optional `port0` fallback binds to loopback only, on a random port that is never logged.
- **Programs running as you:** these can read the token and use your Bots, as they could drive the app itself. Grok Link doesn't defend against malware in your own account.
- **Prompt-injected agents:** the policy (`~/.groklink/policy.json`) refuses briefs that ask a Bot to post on X, sign or send transactions, connect a wallet or submit claims, and has no per-call override. It matches phrases, so treat it as a guard rail, not a guarantee.
- **Untrusted Bot output:** Bots read the web. Every returned message carries `untrusted: true`, and clients should treat replies as data, not instructions.
- **A changed Grok Bot app:** a self-test checks the app's internals on every connect and version change, and blocks sending if they changed.
- **Secrets on disk and in logs:** logs never contain the token, the debug port, cookies or message text. Transcripts are stored only in job files under `~/.groklink/`, which are deleted after 7 days.
- **No telemetry:** Grok Link makes no network calls of its own.
