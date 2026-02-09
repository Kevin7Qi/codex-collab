// File loading utilities for context injection

import { glob } from "glob";
import { readFileSync, statSync } from "fs";
import { resolve, relative } from "path";

export interface FileContent {
  path: string;
  content: string;
}

export async function loadFiles(
  patterns: string[],
  baseDir: string = process.cwd()
): Promise<FileContent[]> {
  const files: FileContent[] = [];
  const seen = new Set<string>();

  const excluded = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      const negPattern = pattern.slice(1);
      const matches = await glob(negPattern, { cwd: baseDir, absolute: true });
      for (const match of matches) {
        excluded.add(match);
        seen.delete(match);
      }
      continue;
    }

    const matches = await glob(pattern, { cwd: baseDir, absolute: true });

    for (const match of matches) {
      if (seen.has(match) || excluded.has(match)) continue;

      try {
        const stat = statSync(match);
        if (!stat.isFile()) continue;
        if (stat.size > 500000) continue;

        const content = readFileSync(match, "utf-8");
        if (content.includes("\0")) continue;

        seen.add(match);
        files.push({
          path: relative(baseDir, match),
          content,
        });
      } catch {
        // Skip files we can't read
      }
    }
  }

  // Remove any files that were later excluded by negation patterns
  return files.filter((f) => !excluded.has(resolve(baseDir, f.path)));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatPromptWithFiles(
  prompt: string,
  files: FileContent[]
): string {
  if (files.length === 0) return prompt;

  let result = prompt + "\n\n---\n\n## File Context\n\n";

  for (const file of files) {
    const ext = file.path.split(".").pop() || "";
    result += `### ${file.path}\n\n\`\`\`${ext}\n${file.content}\n\`\`\`\n\n`;
  }

  return result;
}

export async function loadCodebaseMap(cwd: string): Promise<string | null> {
  const mapPaths = [
    resolve(cwd, "docs/CODEBASE_MAP.md"),
    resolve(cwd, "CODEBASE_MAP.md"),
    resolve(cwd, "docs/ARCHITECTURE.md"),
  ];

  for (const mapPath of mapPaths) {
    try {
      const content = readFileSync(mapPath, "utf-8");
      return content;
    } catch {
      // Try next path
    }
  }

  return null;
}
