import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverWindow } from "../src/daemon/transport.ts";

const MAIN = { type: "page", url: "file:///Applications/Grok%20Bot.app/Contents/Resources/app.asar/renderer/index.html" };
const OTHER = { type: "service_worker", url: "chrome-extension://x/sw.js" };

/**
 * Stands in for the pipe's Target.getTargets, plus fake `open -a` and relaunch. `reopenBrings` says
 * whether a reopen makes the window come back.
 */
function fakeApp(opts: { window: boolean; reopenBrings: boolean }) {
  const app = { window: opts.window, reopens: 0, relaunches: 0, logs: [] as string[] };
  return {
    app,
    deps: {
      getTargets: async () => (app.window ? [OTHER, MAIN] : [OTHER]),
      reopen: async () => {
        app.reopens++;
        if (opts.reopenBrings) setTimeout(() => (app.window = true), 15);
      },
      relaunch: async () => {
        app.relaunches++;
        app.window = true;
      },
      log: (line: string) => app.logs.push(line),
      waitMs: 60,
      pollMs: 5,
    },
  };
}

test("a main window exists: neither reopen nor relaunch is called", async () => {
  const { app, deps } = fakeApp({ window: true, reopenBrings: true });
  assert.equal(await recoverWindow(deps), "present");
  assert.equal(app.reopens, 0);
  assert.equal(app.relaunches, 0);
  assert.deepEqual(app.logs, []);
});

test("the window comes back after the reopen: no relaunch", async () => {
  const { app, deps } = fakeApp({ window: false, reopenBrings: true });
  assert.equal(await recoverWindow(deps), "back");
  assert.equal(app.reopens, 1);
  assert.equal(app.relaunches, 0);
  assert.deepEqual(app.logs, ["window closed; reopening", "window back"]);
});

test("the window stays gone: relaunch after 2 tries", async () => {
  const { app, deps } = fakeApp({ window: false, reopenBrings: false });
  const t0 = Date.now();
  assert.equal(await recoverWindow(deps), "relaunched");
  assert.equal(app.reopens, 2);
  assert.equal(app.relaunches, 1);
  assert.ok(Date.now() - t0 >= 2 * 60, "waited for each try");
  assert.deepEqual(app.logs, ["window closed; reopening", "window closed; reopening", "window still gone; relaunching"]);
});
