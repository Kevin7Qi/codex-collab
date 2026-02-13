// Pure utility functions shared across codex-collab

export function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/**
 * Word-wrap a single line to `width`, preserving leading indentation.
 * Continuation lines are indented to the same level as the original.
 */
export function wrapLine(line: string, width: number): string {
  if (line.length <= width) return line;

  const indent = line.match(/^(\s*)/)![1];
  const content = line.slice(indent.length);

  // Don't wrap lines that look like structural/code content
  // (box-drawing, tree connectors, separators)
  if (/^[│└┌┐┘─╭╰…]/.test(content)) return line;

  const words = content.split(/(\s+)/);
  const lines: string[] = [];
  let current = indent;

  for (const word of words) {
    if (current.length + word.length > width && current.trim() !== '') {
      lines.push(current.trimEnd());
      current = indent + word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim() !== '') lines.push(current.trimEnd());

  return lines.join('\n');
}

export function extractContent(text: string, width?: number): string {
  const cols = width ?? process.stdout.columns ?? 80;
  const lines = text.split('\n');
  const result: string[] = [];
  let inBanner = false;
  let inTip = false;

  for (const line of lines) {
    // Skip banner block (╭ through ╰ inclusive)
    if (line.trimStart().startsWith('╭')) {
      inBanner = true;
      continue;
    }
    if (inBanner) {
      if (line.trimStart().startsWith('╰')) {
        inBanner = false;
      }
      continue;
    }

    // Skip tip lines (including wrapped continuations)
    if (/^\s*Tip:/.test(line)) {
      inTip = true;
      continue;
    }
    if (inTip) {
      // Continuation: indented, not a content marker (›, •, ─)
      if (line.trim() === '' || (/^\s/.test(line) && !/^\s*[›•─]/.test(line))) {
        continue;
      }
      inTip = false;
    }

    // Skip shortcuts/context line
    if (line.includes('? for shortcuts') || /\d+%\s*context left/.test(line)) continue;

    result.push(wrapLine(line, cols));
  }

  // Remove trailing idle prompt placeholder and blank lines
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last.trim() === '' || /^\s*›/.test(last)) {
      result.pop();
    } else {
      break;
    }
  }

  // Remove leading empty lines
  while (result.length > 0 && result[0].trim() === '') {
    result.shift();
  }

  return result.join('\n');
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

export function processOutput(
  output: string,
  options: { contentOnly: boolean; stripAnsi: boolean }
): string {
  if (options.contentOnly) {
    return extractContent(stripAnsiCodes(output));
  }
  if (options.stripAnsi) {
    return stripAnsiCodes(output);
  }
  return output;
}
