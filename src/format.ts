// src/format.ts — small text formatters shared by commands and library code


export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

/** A duration that may run to weeks, such as how long ago a session
 *  stopped: as `formatDuration` has it under an hour, then hours and
 *  minutes, then whole days. */
export function formatLongDuration(ms: number): string {
  if (ms < 3_600_000) return formatDuration(ms);
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(hours / 24)} days`;
}

export function formatAge(unixTimestamp: number): string {
  const seconds = Math.round(Date.now() / 1000 - unixTimestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "a", "a and b", "a, b and c". */
export function listed(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
