// T01 probe: does Grok Bot accept CDP over --remote-debugging-pipe (fd 3 in / fd 4 out, \0-terminated JSON)?
// Prints only counts and pass/fail, never target URLs, titles or transcript text.
import { execFileSync, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const BIN = `${process.env.GROKLINK_APP ?? "/Applications/Grok Bot.app"}/Contents/MacOS/Grok Bot`;
const PATTERN = "Grok Bot.app/Contents/MacOS/Grok Bot";
const MAIN_WINDOW = /app\.asar|\/renderer\/index\.html/;
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

async function main(): Promise<void> {
  await quitApp();
  if (isRunning()) throw new Error("Grok Bot is still running; quit it first");

  const child = spawn(BIN, ["--remote-debugging-pipe"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let exited: string | null = null;
  child.on("exit", (code, signal) => {
    exited = `app exited (code ${code}, signal ${signal})`;
  });
  const toApp = child.stdio[3] as Writable;
  const fromApp = child.stdio[4] as Readable;

  let buf = "";
  let nextId = 0;
  const pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  fromApp.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let end = buf.indexOf("\0");
    while (end !== -1) {
      const msg = JSON.parse(buf.slice(0, end));
      buf = buf.slice(end + 1);
      if (msg.id) pending.get(msg.id)?.(msg);
      end = buf.indexOf("\0");
    }
  });

  function send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++nextId;
    toApp.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result as T)));
    });
  }

  type Info = { targetId: string; type: string; url: string };
  const deadline = Date.now() + 20_000;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(exited ?? "no reply on fd 4 within 20 s")), 20_000));

  try {
    // The first request is sent straight away, exactly as the brief describes.
    const first = await Promise.race([send<{ targetInfos: Info[] }>("Target.getTargets"), timeout]);
    console.log(`PIPE OK ${first.targetInfos.length} targets`);

    // Step 7: the renderer page may load a moment after the browser target answers.
    let page: Info | undefined;
    let n = first.targetInfos.length;
    while (Date.now() < deadline) {
      const { targetInfos } = await send<{ targetInfos: Info[] }>("Target.getTargets");
      n = targetInfos.length;
      page = targetInfos.find((t) => t.type === "page" && MAIN_WINDOW.test(t.url));
      if (page) break;
      await sleep(500);
    }
    if (!page) {
      console.log(`PIPE MAIN WINDOW FAIL (${n} targets, none match the base filter)`);
    } else {
      console.log("PIPE MAIN WINDOW OK");
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const r = await send<{ result: { type: string; value: unknown } }>(
        "Runtime.evaluate",
        { expression: "document.title", returnByValue: true },
        sessionId,
      );
      console.log(typeof r.result.value === "string" ? "PIPE EVAL OK document.title is a string" : `PIPE EVAL FAIL got ${r.result.type}`);
    }

    // Optional hold so `lsof` can inspect the app while the pipe is open.
    await sleep(Number(process.env.PROBE_HOLD_MS ?? 0));

    // Behavior check: does the app exit when the pipe closes?
    toApp.end();
    fromApp.destroy();
    await sleep(3000);
    console.log(exited ? `PIPE NOTE ${exited} after the pipe closed` : "PIPE NOTE app kept running after the pipe closed");
  } catch (e) {
    console.log(`PIPE FAIL ${(e as Error).message}`);
  } finally {
    await quitApp();
    if (isRunning()) child.kill("SIGTERM");
    process.exit(0);
  }
}

main().catch((e) => {
  console.log(`PIPE FAIL ${(e as Error).message}`);
  process.exit(1);
});
