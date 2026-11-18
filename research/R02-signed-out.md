# R02: How Grok Bot 1.2.0 shows the signed-out state

Goal: let the deep health probe (`src/daemon/probe.ts`) report `signed_in`, `signed_out` or `unknown` without signing the app out.

## What I checked
- **App version:** `/Applications/Grok Bot.app`, `CFBundleShortVersionString` = `1.2.0`.
- **App code, read-only.** I read the asar header and copied out three files to a scratch folder: the renderer bundle `dist/renderer/assets/index.eager-app-*.js` and the main-process bundle `dist/electron-main/main-app.cjs`. I searched them for `accountSlot`, `isSignedIn`, `authStatus`, `getCursorAuthStatus`, `logged-in`, `logged-out` and `signed-out`.
- **Not done:**
  - Nothing was signed out.
  - No CDP session was opened. The installed daemon owns the app over its pipe, and attaching would have meant stopping it.
  - No Bot was messaged.

## Findings
1. **The app has its own auth-status getter.** The main process exposes `getCursorAuthStatus: () => cursorAccount.getAuthStatus()` on the app-window bridge. The renderer's allowlist for `window.desktop.main` lists it with no arguments (`getCursorAuthStatus: noArgs`), in the same list as `getCursorUsageSummary`. `usage()` already calls `getCursorUsageSummary` successfully through `window.desktop.main`.
2. **What the getter returns.** It returns an object with a `kind` field:

   | `kind` | Meaning | Other fields |
   |---|---|---|
   | `"logged-in"` | Signed in | `authId`, `email`, `displayName`, `expiresAt` and more |
   | `"logged-out"` | Signed out | `cause`, e.g. `"sign-in-expired"` or `"retained-after-failed-logout"` |
   | `"logging-in"` | A sign-in is in progress | none |

   The main process also falls back to `{ kind: "logged-out" }` when it can't read the status (`reportDesktopEdgeFailure("sand-access", "auth-status-read")`). A real logged-out and an unreadable status therefore look the same from the page.
   The app's own onboarding gate decides "signed in" exactly this way: `getCursorAuthStatus().then(s => s.kind === "logged-in")`.
3. **`ACCOUNT_SLOT` agrees, but is weaker.** The renderer derives the account slot with `kind !== "logged-in" ? null : (authId ?? email)`, so the slot is null whenever the app isn't signed in. But `ACCOUNT_SLOT` is also null when the React context lookup simply fails, so on its own a null slot doesn't prove signed out.
4. **No separate login route was found.** The signed-out UI is the onboarding / sign-in flow (`loginCursor`, `getCursorLoginFlight`) rendered inside the same window, not a different URL. Checking the DOM or the URL would be more brittle than the getter.

## What the probe does
- It calls `window.desktop.main.getCursorAuthStatus()` in the page and returns **only** `kind`. The email, auth id and name never leave the page, and nothing is logged.
- It maps the result:

  | Page returns | Probe reports | Check |
  |---|---|---|
  | `logged-in` | `signed_in` | ok |
  | `logged-out` | `signed_out` | not ok |
  | `logging-in`, a missing getter, another value, or an error | `unknown` | warning, not a failure |

- The roster check still catches a signed-out app whose status couldn't be read, because `listBots` finds no Bots.

## Not confirmed live
- The `signed_in` path is confirmed by the live `groklink doctor` run.
- The `signed_out` path comes from reading the code only. The app was never signed out, per the brief.
- If a future version renames the getter, the check reports `unknown` instead of a false `signed_out`.
