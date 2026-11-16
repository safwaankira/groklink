import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:net";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CDP, type CDPChannel } from "../src/base/cdp.ts";
import { daemonMethods, startServer } from "../src/daemon/server.ts";
import { ensureState, statePaths } from "../src/daemon/state.ts";
import { Transport } from "../src/daemon/transport.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BOTS = [
  {
    id: "b1",
    name: "Alpha",
    description: "",
    hidden: false,
    running: false,
    needsInput: false,
    unread: 0,
    lastActivity: null,
    preview: null,
  },
];

/**
 * Answers Runtime.evaluate like the page would: the store-readiness check gets `page.ready`,
 * everything else gets the fake Bot list (what the page's listBots code returns).
 */
function fakeChannel(page = { ready: true }): CDPChannel {
  let deliver: (text: string) => void = () => {};
  return {
    send(text) {
      const { id, method, params } = JSON.parse(text);
      const readiness = method === "Runtime.evaluate" && params.expression.startsWith("!!");
      const value = readiness ? page.ready : BOTS;
      const result = method === "Runtime.evaluate" ? { result: { type: "object", value } } : {};
      queueMicrotask(() => deliver(JSON.stringify({ id, result })));
    },
    onMessage(cb) {
      deliver = cb;
    },
    close() {},
  };
}

type Reply = { id: number | null; result?: Record<string, unknown>; error?: { code: string; message: string } };

/** Send one request line; resolve with the first reply and whether the server then closed the connection. */
function rpc(socketPath: string, req: object): Promise<{ reply: Reply; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socketPath);
    let buf = "";
    let reply: Reply | undefined;
    c.setEncoding("utf8");
    c.on("error", reject);
    c.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl !== -1 && !reply) reply = JSON.parse(buf.slice(0, nl));
    });
    c.on("end", () => reply && resolve({ reply, closed: true }));
    c.write(`${JSON.stringify(req)}\n`);
    // Requests that succeed leave the connection open; give the reply a moment, then hang up.
    setTimeout(() => {
      if (reply) resolve({ reply, closed: false });
      else reject(new Error("no reply"));
      c.destroy();
    }, 300);
  });
}

let home: string;
let token: string;
let server: Server;
const paths = () => statePaths(home);

before(async () => {
  home = join(mkdtempSync(join(tmpdir(), "glk-")), "state");
  ({ token } = ensureState(paths()));
  const link = { mode: "pipe" as const, connected: true, appVersion: "1.0.3", requireCdp: () => new CDP(fakeChannel()) };
  server = await startServer({ socketPath: paths().socket, token, methods: daemonMethods(link), log: () => {} });
});

after(() => {
  server.close();
  rmSync(join(home, ".."), { recursive: true, force: true });
});

test("state dir is 0700, token and socket are 0600", () => {
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(paths().token).mode & 0o777, 0o600);
  assert.equal(statSync(paths().socket).mode & 0o777, 0o600);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test("ensureState keeps an existing token", () => {
  assert.equal(ensureState(paths()).token, token);
});

test("a wrong token gets unauthorized and the connection is closed", async () => {
  const { reply, closed } = await rpc(paths().socket, { id: 1, token: "0".repeat(64), method: "health", params: {} });
  assert.equal(reply.id, 1);
  assert.equal(reply.error?.code, "unauthorized");
  assert.equal(reply.result, undefined);
  assert.equal(closed, true);
});

test("a missing token gets unauthorized", async () => {
  const { reply } = await rpc(paths().socket, { id: 2, method: "health" });
  assert.equal(reply.error?.code, "unauthorized");
});

test("health works with the right token", async () => {
  const { reply } = await rpc(paths().socket, { id: 3, token, method: "health", params: {} });
  assert.equal(reply.id, 3);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result?.ok, true);
  assert.equal(reply.result?.mode, "pipe");
  assert.equal(reply.result?.connected, true);
  assert.equal(reply.result?.appVersion, "1.0.3");
  assert.equal(typeof reply.result?.uptimeSec, "number");
});

test("bots returns the list from the CDP channel", async () => {
  const { reply } = await rpc(paths().socket, { id: 4, token, method: "bots" });
  assert.deepEqual(reply.result, BOTS);
});

test("an unknown method gets bad_request", async () => {
  const { reply } = await rpc(paths().socket, { id: 5, token, method: "nope" });
  assert.equal(reply.error?.code, "bad_request");
});

test("Bot methods return not_connected until the page's stores are ready", async () => {
  const page = { ready: false };
  const transport = new Transport("pipe", () => {}, { open: async () => new CDP(fakeChannel(page)), readyPollMs: 10 });
  const methods = daemonMethods(transport);
  transport.start();
  try {
    await sleep(50);
    assert.equal((methods.health({}) as { connected: boolean }).connected, false);
    await assert.rejects(async () => methods.bots({}), {
      code: "not_connected",
      message: "Grok Bot is starting; try again in a few seconds.",
    });
    page.ready = true;
    for (const t0 = Date.now(); !transport.connected; await sleep(5)) if (Date.now() - t0 > 2000) throw new Error("timed out");
    assert.equal((methods.health({}) as { connected: boolean }).connected, true);
    assert.deepEqual(await methods.bots({}), BOTS);
  } finally {
    await transport.stop();
  }
});
