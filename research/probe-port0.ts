// T01 probe: does Grok Bot accept --remote-debugging-port=0 and write DevToolsActivePort?
// Prints only counts and pass/fail. Never prints the port number, target URLs, titles or transcript text.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN = `${process.env.GROKLINK_APP ?? "/Applications/Grok Bot.app"}/Contents/MacOS/Grok Bot`;
const PATTERN = "Grok Bot.app/Contents/MacOS/Grok Bot";
const MAIN_WINDOW = /app\.asar|\/renderer\/index\.html/;
const SUPPORT = join(homedir(), "Library/Application Support");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRunning(): boolean {
  try {
    execFileSync("pgrep", ["-f", PATTERN], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function quitApp(): Promise<void> {
  if (!isRunning()) return;
  try {
    execFileSync("osascript", ["-e", 'tell application "Grok Bot" to quit'], { stdio: "ignore" });
  } catch {}
  for (let i = 0; i < 80 && isRunning(); i++) await sleep(250);
}

/** DevToolsActivePort files under Application Support folders whose name contains "Grok", written after `since`. */
function findPortFiles(since: number): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(SUPPORT)) {
    if (!/grok/i.test(dir)) continue;
    const file = join(SUPPORT, dir, "DevToolsActivePort");
    if (existsSync(file) && statSync(file).mtimeMs >= since) out.push(file);
  }
  return out;
}

type Target = { type: string; url: string; webSocketDebuggerUrl: string };

async function evalTitle(wsUrl: string): Promise<unknown> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("could not open the CDP websocket")), { once: true });
  });
  const reply = new Promise<{ result?: { result: { value: unknown } }; error?: { message: string } }>((resolve) => {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1) resolve(msg);
    });
  });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }));
  const msg = await reply;
  ws.close();
  if (msg.error) throw new Error(msg.error.message);
  return msg.result?.result.value;
}

async function main(): Promise<void> {
  await quitApp();
  if (isRunning()) throw new Error("Grok Bot is still running; quit it first");

  const started = Date.now() - 1000;
  const child = spawn(BIN, ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], { stdio: "ignore" });
  let exited: string | null = null;
  child.on("exit", (code, signal) => {
    exited = `app exited (code ${code}, signal ${signal})`;
  });

  try {
    let files: string[] = [];
    for (let i = 0; i < 80 && !files.length && !exited; i++) {
      await sleep(250);
      files = findPortFiles(started);
    }
    if (!files.length) throw new Error(exited ?? "no fresh DevToolsActivePort under Application Support/*Grok* within 20 s");
    console.log(`PORT0 DevToolsActivePort at ${files.map((f) => f.replace(homedir(), "~")).join(", ")}`);

    const port = Number(readFileSync(files[0], "utf8").split("\n")[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("line 1 of DevToolsActivePort is not a port");

    let targets: Target[] | null = null;
    let page: Target | undefined;
    for (let i = 0; i < 40 && !page; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        targets = (await res.json()) as Target[];
        page = targets.find((t) => t.type === "page" && MAIN_WINDOW.test(t.url));
      } catch {}
      if (!page) await sleep(500);
    }
    if (!targets) throw new Error("/json/list never answered");
    console.log(`PORT0 OK ${targets.length} targets`);

    // Step 7: base main-window filter + Runtime.evaluate.
    if (!page) {
      console.log("PORT0 MAIN WINDOW FAIL (no target matches the base filter)");
    } else {
      console.log("PORT0 MAIN WINDOW OK");
      const title = await evalTitle(page.webSocketDebuggerUrl);
      console.log(typeof title === "string" ? "PORT0 EVAL OK document.title is a string" : `PORT0 EVAL FAIL got ${typeof title}`);
    }
  } catch (e) {
    console.log(`PORT0 FAIL ${(e as Error).message}`);
  } finally {
    await quitApp();
    if (isRunning()) child.kill("SIGTERM");
    process.exit(0);
  }
}

main().catch((e) => {
  console.log(`PORT0 FAIL ${(e as Error).message}`);
  process.exit(1);
});
