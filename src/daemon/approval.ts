// Approve mode for x_write: a task that would post to X waits until the user approves it in a native macOS dialog on
// their Mac. Nothing here can be reached from the socket or MCP: the only way to approve is to click the dialog.
import { execFile } from "node:child_process";

/**
 * What came of one request. `error`: the dialog couldn't be shown (or the dialog function threw), so nobody decided.
 * `queue_full`: too many requests were already waiting; no dialog was shown.
 */
export type Decision = "approved" | "denied" | "timeout" | "error" | "queue_full";
export type ApprovalRequest = { jobId: string; bot: string; brief: string };
/** Shows one dialog for `seconds` at most and resolves with what the user did. Tests pass a fake. */
export type Dialog = (r: ApprovalRequest, seconds: number) => Promise<Decision>;

/** Longest brief that can be approved: the dialog shows all of it, and a longer one can't be read safely in a dialog. */
export const MAX_APPROVAL_BRIEF = 1500;
export const DIALOG_SECONDS = 600;
/** Requests showing or waiting at once; more are refused. */
export const MAX_PENDING = 5;
const APPROVE = "Approve and send";
const DENY = "Deny";

/** Most lines a brief that needs approval may have, so nothing can be pushed far down out of view. */
export const MAX_APPROVAL_LINES = 40;

const PICTO = /\p{Extended_Pictographic}/u;
const VS16 = 0xfe0f;
const ZWJ = 0x200d;

/**
 * Why `brief` can't be approved, or null if it can. Approve mode accepts plain text only: every character must be
 * printable ASCII (U+0020–U+007E), a newline, or an emoji (Extended_Pictographic, with U+FE0F and U+200D allowed only
 * inside an emoji sequence). At most 40 lines, and no more than 2 blank lines in a row. So the dialog can only show
 * text that reads the way it looks: no look-alike letters, invisible or blank-looking characters, or bidi tricks.
 */
export function approvalTextProblem(brief: string): string | null {
  const cps = [...brief].map((c) => c.codePointAt(0) ?? 0);
  const picto = (cp: number | undefined) => cp !== undefined && PICTO.test(String.fromCodePoint(cp));
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if ((cp >= 0x20 && cp <= 0x7e) || cp === 0x0a || picto(cp)) continue;
    // U+FE0F right after an emoji; U+200D between an emoji (or its U+FE0F) and the next emoji.
    if (cp === VS16 && picto(cps[i - 1])) continue;
    if (cp === ZWJ && (picto(cps[i - 1]) || (cps[i - 1] === VS16 && picto(cps[i - 2]))) && picto(cps[i + 1])) continue;
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    return `approve mode accepts plain text only (printable ASCII, newlines and emoji); the brief has U+${hex} at character ${i + 1}`;
  }
  if (brief.split("\n").length > MAX_APPROVAL_LINES)
    return `approve mode accepts plain text only, at most ${MAX_APPROVAL_LINES} lines; the brief has ${brief.split("\n").length}`;
  // Three or more blank (space-only) lines in a row.
  if (/(?:^|\n)(?: *\n){3,}/.test(brief)) return "approve mode accepts plain text only, with no more than 2 blank lines in a row";
  return null;
}

/** "10 minutes", "1 minute", "90 seconds". */
export function duration(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** The dialog's text: the Bot and the whole brief (briefs over MAX_APPROVAL_BRIEF never get a dialog). */
export function dialogText(r: ApprovalRequest, seconds = DIALOG_SECONDS): string {
  return `A task for the Grok Bot "${r.bot}" asks it to post to X. This is the whole brief:\n\n${r.brief}\n\nSend it? (Deny is the default; this closes itself after ${duration(seconds)}.)`;
}

/** What osascript printed on success, as a decision. Anything but a clear "Approve and send" in time is a denial. */
export function parseDialogOutput(stdout: string): Decision {
  if (/gave up:true/.test(stdout)) return "timeout";
  return new RegExp(`button returned:${APPROVE}(?:,|$)`).test(stdout.trim()) ? "approved" : "denied";
}

/**
 * An osascript failure, as a decision. Deny is the dialog's cancel button, so clicking it (or pressing Esc) makes
 * osascript fail with "User canceled" (-128): that's a real denial. Any other failure means the dialog wasn't shown.
 */
export function parseDialogFailure(stderr: string): Decision {
  return /\(-128\)|User cancel+ed/i.test(stderr) ? "denied" : "error";
}

/**
 * The real dialog, through `osascript`. The text goes in as an argument (`on run argv`), never spliced into the
 * script, so a brief can't inject AppleScript.
 */
export const osascriptDialog: Dialog = (r, seconds) =>
  new Promise((resolve) => {
    const script = [
      "on run argv",
      `display dialog (item 1 of argv) with title "Grok Link: approve a post to X" buttons {"${DENY}", "${APPROVE}"} default button "${DENY}" cancel button "${DENY}" with icon caution giving up after ${seconds}`,
      "end run",
    ];
    execFile(
      "osascript",
      [...script.flatMap((l) => ["-e", l]), dialogText(r, seconds)],
      { timeout: (seconds + 30) * 1000 },
      (err, stdout, stderr) => resolve(err ? parseDialogFailure(String(stderr)) : parseDialogOutput(String(stdout))),
    );
  });

/** A place in the approval queue, held from the moment a task is accepted until its dialog is answered. */
export type Slot = { released: boolean };

/** One dialog at a time; later requests wait their turn, up to `max` in all. */
export class Approvals {
  readonly timeoutSeconds: number;
  readonly max: number;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private dialog: Dialog;

  constructor(dialog: Dialog = osascriptDialog, opts: { timeoutSeconds?: number; max?: number } = {}) {
    this.dialog = dialog;
    this.timeoutSeconds = opts.timeoutSeconds ?? DIALOG_SECONDS;
    this.max = opts.max ?? MAX_PENDING;
  }

  /** How many requests are showing or waiting. */
  get waiting(): number {
    return this.pending;
  }

  get full(): boolean {
    return this.pending >= this.max;
  }

  /** Take a place in the queue now (null if it's full), so concurrent tasks can't all be accepted past the cap. */
  reserve(): Slot | null {
    if (this.full) return null;
    this.pending++;
    return { released: false };
  }

  /** Give a reserved place back (a task that failed before its dialog). Releasing twice is a no-op. */
  release(slot: Slot): void {
    if (slot.released) return;
    slot.released = true;
    this.pending--;
  }

  /** Show the dialog in turn, using `slot` if one was reserved, else taking a place now (queue_full if there's none). */
  request(r: ApprovalRequest, slot?: Slot): Promise<Decision> {
    const held = slot && !slot.released ? slot : this.reserve();
    if (!held) return Promise.resolve("queue_full");
    const turn = this.chain.then(() =>
      Promise.resolve()
        .then(() => this.dialog(r, this.timeoutSeconds))
        .catch((): Decision => "error"),
    );
    this.chain = turn.finally(() => this.release(held));
    return turn;
  }
}
