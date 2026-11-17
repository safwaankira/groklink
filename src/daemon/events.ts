// Append-only event log ($GROKLINK_HOME/events.jsonl): one JSON event per line, `seq` strictly increasing.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";

export type EventType = "message" | "working" | "idle" | "needs_input" | "done" | "failed" | "warning";
export type JobEvent = { seq: number; at: string; jobId: string | null; bot: string; type: EventType; text?: string };

const TAIL_BYTES = 64 * 1024;

/** The seq on the last complete line, read from the file's tail so a big log costs the same as a small one. */
function lastSeq(file: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const seq = JSON.parse(lines[i]).seq;
        if (Number.isInteger(seq)) return seq;
      } catch {}
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

export class EventLog {
  private file: string;
  private seq: number;

  constructor(file: string) {
    this.file = file;
    this.seq = lastSeq(file);
  }

  append(e: Omit<JobEvent, "seq" | "at">): JobEvent {
    const event: JobEvent = { seq: this.seq + 1, at: new Date().toISOString(), ...e };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.seq = event.seq;
    return event;
  }

  /**
   * Drop events older than `maxAgeMs` (they hold Bot text), rewriting the file atomically. Kept events keep their seq,
   * and new ones continue from the last seq, so seq stays strictly increasing.
   */
  prune(maxAgeMs: number): number {
    if (!existsSync(this.file)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    const keep = lines.filter((line) => {
      try {
        return Date.parse((JSON.parse(line) as JobEvent).at) >= cutoff;
      } catch {
        return false;
      }
    });
    if (keep.length === lines.length) return 0;
    // A restart reads the next seq from the last line, so never leave the file empty: keep the newest event, text removed.
    if (!keep.length) {
      try {
        const { text: _text, ...last } = JSON.parse(lines[lines.length - 1]) as JobEvent;
        keep.push(JSON.stringify(last));
      } catch {}
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, keep.length ? `${keep.join("\n")}\n` : "", { mode: 0o600 });
    renameSync(tmp, this.file);
    return lines.length - keep.length;
  }

  /** Up to `limit` events with a seq greater than `seq`, oldest first. */
  since(seq = 0, limit = 50): JobEvent[] {
    if (!existsSync(this.file)) return [];
    const out: JobEvent[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as JobEvent;
        if (e.seq > seq) out.push(e);
      } catch {}
      if (out.length >= limit) break;
    }
    return out;
  }
}
