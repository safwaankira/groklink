# R01: CDP transport probe (pipe vs port 0)

Date: 2026-11-14. Machine: macOS (Apple M4), Bun 1.4.4, Node 22.23.1.

## App
- Grok Bot version (`CFBundleShortVersionString`): **1.0.3**
- Binary: `/Applications/Grok Bot.app/Contents/MacOS/Grok Bot`, spawned directly (not through `open`).

## Results
| Probe | Script | Result |
|---|---|---|
| `--remote-debugging-pipe` | `research/probe-pipe.ts` | `PIPE OK 1 targets` |
| `--remote-debugging-port=0` + `--remote-debugging-address=127.0.0.1` | `research/probe-port0.ts` | `PORT0 OK 1 targets` |

Main-window check (step 7) passed in **both** modes:
- A `page` target matches the base filter `/app\.asar|\/renderer\/index\.html/`.
- `Runtime.evaluate` of `document.title` returns a string. In pipe mode this goes through `Target.attachToTarget` with `flatten: true`, then `Runtime.evaluate` with that `sessionId`.

Pipe details: requests are written to fd 3 and replies are read from fd 4, each message being JSON followed by `\0`. The first `Target.getTargets` answered within about 1 s of spawn, and the main window was already listed on that first reply.

## DevToolsActivePort path
`~/Library/Application Support/Grok Bot/DevToolsActivePort`. This is the Electron userData folder; `grok-bot-computer-use` sits next to it but doesn't get the file. Line 1 is the port. The port number was never printed or logged.

## App behavior seen
- **The app exits when the pipe closes.** After the probe ended fd 3 and destroyed fd 4, Grok Bot exited with code 0 within 3 s, in every run. So the daemon owns the app's lifetime in pipe mode: if the daemon dies, the app quits, and a restarted daemon must spawn the app again. (That matches the "killing the daemon brings it back, reconnects" acceptance check, but jobs must survive an app restart.)
- **No TCP listener in pipe mode.** With the pipe held open (`PROBE_HOLD_MS=6000`), `lsof -iTCP -sTCP:LISTEN -a -c "Grok Bot"` showed 0 listeners and `lsof -iTCP:9333` showed nothing. As a control, port-0 mode showed 1 listener, loopback only, so the check does detect a listener when one exists.
- `osascript ... to quit` quits a directly spawned instance cleanly, and the `pgrep -f "Grok Bot.app/Contents/MacOS/Grok Bot"` pattern finds it.
- Not tested: single-instance lock behavior (the app was always quit before each probe), and whether the window is visible on screen in pipe mode (not observed; the renderer page loads and evaluates).
- After the probes, `open -a "Grok Bot"` relaunched the app normally with no debug listener.

## Conclusion
**CHOSEN MODE: `pipe`.** Grok Bot 1.0.3 honors `--remote-debugging-pipe`, finds the main window and evaluates in it, and opens no TCP port. `port0` also works (file at `~/Library/Application Support/Grok Bot/DevToolsActivePort`) and stays as the fallback.
