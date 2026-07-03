// src/render.ts — Log-entry parsing and human-facing rendering for `follow`
//
// The thread log is an append-only stream of timestamped entries written by
// EventDispatcher. This module turns that stream back into a calm, readable
// live view: dim progress noise, prominent approvals, a visually distinct
// final answer. Parsing and rendering are pure (no I/O) so the display
// contract is unit-testable.

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface LogEntry {
  /** ISO timestamp, or null for orphan continuation lines (attach mid-entry). */
  ts: string | null;
  /** Entry body lines. Single-line for everything except agent-output blocks. */
  lines: string[];
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/;
const AGENT_OUTPUT_END = "<<END_AGENT_OUTPUT>>";

/**
 * Incremental parser over log bytes. Emits single-line entries as soon as
 * their newline arrives (an approval prompt must display immediately, not
 * when the *next* entry happens to start) and holds multi-line agent-output
 * blocks until their end marker.
 */
export class LogEntryParser {
  private buf = "";
  private block: LogEntry | null = null;

  feed(chunk: string): LogEntry[] {
    this.buf += chunk;
    const out: LogEntry[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);

      if (this.block) {
        if (line === AGENT_OUTPUT_END) {
          out.push(this.block);
          this.block = null;
        } else {
          this.block.lines.push(line);
        }
        continue;
      }

      const m = TS_RE.exec(line);
      if (!m) {
        // Orphan continuation (attached mid-entry) — surface rather than drop.
        if (line.trim() !== "" && line !== AGENT_OUTPUT_END) out.push({ ts: null, lines: [line] });
        continue;
      }
      if (m[2] === "agent output:") {
        this.block = { ts: m[1], lines: [m[2]] };
      } else {
        out.push({ ts: m[1], lines: [m[2]] });
      }
    }
    return out;
  }

  /** Flush an unterminated agent-output block (writer crashed mid-entry). */
  drain(): LogEntry[] {
    const out: LogEntry[] = [];
    if (this.block) {
      // A partial last line without its newline still belongs to the block —
      // emitting it separately would render the tail of the final answer as
      // an orphan log line.
      if (this.buf.trim() !== "") this.block.lines.push(this.buf);
      this.buf = "";
      out.push(this.block);
      this.block = null;
    }
    if (this.buf.trim() !== "") {
      const m = TS_RE.exec(this.buf);
      out.push(m ? { ts: m[1], lines: [m[2]] } : { ts: null, lines: [this.buf] });
      this.buf = "";
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Emit ANSI styling. Callers gate this on TTY + NO_COLOR. */
  color: boolean;
  /** Terminal width for truncating one-line progress noise. */
  width: number;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function style(text: string, codes: string[], color: boolean): string {
  if (!color || codes.length === 0) return text;
  return codes.join("") + text + ANSI.reset;
}

/** Truncate to the terminal width, accounting for an already-styled prefix length. */
function clip(text: string, width: number, used: number): string {
  const room = Math.max(20, width - used);
  return text.length > room ? text.slice(0, room - 1) + "…" : text;
}

function timePrefix(ts: string | null, color: boolean): string {
  if (!ts) return "         ";
  return style(ts.slice(11, 19), [ANSI.dim], color) + " ";
}

/**
 * Render one log entry to display lines. Returns [] for entries that are
 * log-only detail (raw Guardian payloads, duplicate error records).
 */
export function renderEntry(entry: LogEntry, opts: RenderOptions): string[] {
  const body = entry.lines[0] ?? "";
  const T = 9; // display columns used by the "HH:MM:SS " time prefix
  const pre = timePrefix(entry.ts, opts.color);

  // --- agent output block: the deliverable, visually separated ---
  if (body === "agent output:") {
    const rule = style("─── result ───", [ANSI.dim], opts.color);
    return [pre + rule, ...entry.lines.slice(1), ""];
  }

  // --- log-only detail: skip (already surfaced by their [codex] twins) ---
  if (/^guardian review (started|completed): /.test(body)) return [];
  if (body.startsWith("error: ")) return [];
  if (/^review output \(\d+ chars\)$/.test(body)) return [];

  // --- command completion records ---
  const cmd = /^command: (.*) \(exit (.+)\)$/.exec(body);
  if (cmd) {
    const ok = cmd[2] === "0";
    const mark = ok ? style("✓", [ANSI.green], opts.color) : style("✗", [ANSI.red], opts.color);
    const text = `${clip(cmd[1], opts.width, T + 2)}${ok ? "" : ` (exit ${cmd[2]})`}`;
    return [pre + mark + " " + style(text, ok ? [ANSI.dim] : [ANSI.red], opts.color)];
  }

  if (!body.startsWith("[codex] ")) {
    // Unknown entry shape — fail open, dimmed.
    return [pre + style(clip(body, opts.width, T), [ANSI.dim], opts.color)];
  }
  const msg = body.slice("[codex] ".length);

  // --- approvals: the one thing a viewer must not miss ---
  if (msg.startsWith("APPROVAL NEEDED")) {
    return [pre + style("⏸ " + msg, [ANSI.bold, ANSI.yellow], opts.color)];
  }
  if (/^\s{2,}/.test(msg)) {
    // Indented continuation of an approval block (Command/Reason/Approve/Decline)
    return [pre + style(msg, [ANSI.yellow], opts.color)];
  }

  if (msg.startsWith("Guardian ")) {
    return [pre + style("⚑ " + clip(msg, opts.width, T + 2), [ANSI.cyan], opts.color)];
  }
  if (msg.startsWith("Running: ")) {
    return [pre + style("▸ " + clip(msg.slice("Running: ".length), opts.width, T + 2), [ANSI.dim], opts.color)];
  }
  if (msg.startsWith("Edited: ")) {
    return [pre + style("± " + clip(msg.slice("Edited: ".length), opts.width, T + 2), [], opts.color)];
  }
  if (msg.startsWith("Error: ")) {
    return [pre + style("✗ " + msg.slice("Error: ".length), [ANSI.red], opts.color)];
  }

  // Intermediate progress / planning messages — present but quiet.
  return [pre + style(clip(msg, opts.width, T), [ANSI.dim], opts.color)];
}

/** Final status line rendered by `follow` from the run record. */
export function renderFinalStatus(
  status: string,
  detail: { elapsed?: string | null; filesChanged?: number; error?: string | null },
  color: boolean,
): string {
  const parts: string[] = [];
  if (detail.elapsed) parts.push(detail.elapsed);
  if (detail.filesChanged) parts.push(`${detail.filesChanged} file${detail.filesChanged === 1 ? "" : "s"} changed`);
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";

  switch (status) {
    case "completed":
      return style(`✔ completed${suffix}`, [ANSI.bold, ANSI.green], color);
    case "cancelled":
      return style(`■ interrupted${suffix}`, [ANSI.bold, ANSI.yellow], color);
    case "failed":
      return style(`✖ failed${suffix}${detail.error ? ` — ${detail.error}` : ""}`, [ANSI.bold, ANSI.red], color);
    default:
      return style(`● ${status}${suffix}`, [ANSI.bold], color);
  }
}
