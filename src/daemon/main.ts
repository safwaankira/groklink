#!/usr/bin/env node
// groklinkd: owns the Grok Bot app and its CDP connection, and serves clients on a token-protected Unix socket.
import { rmSync } from "node:fs";
import { VERSION } from "../shared/version.ts";
import { EventLog } from "./events.ts";
import { baseLayer, Jobs } from "./jobs.ts";
import { SelfTest } from "./selftest.ts";
import { daemonMethods, guardSocket, startServer } from "./server.ts";
import { ensureState, logger } from "./state.ts";
import { Transport, transportMode } from "./transport.ts";

const { paths, token } = ensureState();
const log = logger(paths.log);
const transport = new Transport(transportMode(), log);
log(`start groklinkd ${VERSION} (${transport.mode})`);
const events = new EventLog(paths.events);
const jobs = new Jobs({ dir: paths.jobs, events, layer: baseLayer(transport), link: transport, log });
const selftest = new SelfTest({ home: paths.home, cdp: () => transport.requireCdp(), log });

let server: Awaited<ReturnType<typeof startServer>>;
const methods = daemonMethods(transport, { jobs, events, selftest });
const listen = () => startServer({ socketPath: paths.socket, token, methods, log });
try {
  server = await listen();
} catch (e) {
  log(`error: ${(e as Error).message}`);
  console.error(`groklinkd: ${(e as Error).message}`);
  process.exit(1);
}
// If the socket file is replaced or its mode loosened, listen again on a fresh one.
const socketGuard = guardSocket({ socketPath: paths.socket, server, start: listen, log });
transport.start();
jobs.start();
// Self-test on every connect, and again if the app on disk changes version while connected.
let wasConnected = false;
const watch = [
  setInterval(() => {
    if (transport.connected && !wasConnected) selftest.run().catch((e) => log(`self-test error: ${(e as Error).message}`));
    wasConnected = transport.connected;
  }, 1_000),
  setInterval(() => {
    if (transport.connected) selftest.checkVersion().catch((e) => log(`self-test error: ${(e as Error).message}`));
  }, 60_000),
];
console.log(`groklinkd ${VERSION} running (${transport.mode})`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stop (${signal})`);
  jobs.close();
  for (const t of watch) clearInterval(t);
  socketGuard.stop();
  socketGuard.server.close();
  rmSync(paths.socket, { force: true });
  await transport.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
