// src/test-helpers.ts — helpers shared by tests

/** The shell operators in a documented command line, once its placeholders
 *  (`<name>`, `<id>`) and a trailing `# comment` or `(then: …)` note are set
 *  aside: what makes Codex treat a `bash -lc` command as a script rather
 *  than one plain command. */
export function shellOperators(line: string): string[] {
  const command = line
    .replace(/\s+#\s.*$/, "")
    .replace(/\s+\(then:.*\)\s*$/, "")
    .replace(/<[a-z][a-z-]*>/g, "PLACEHOLDER");
  return [...command.matchAll(/<<|>>|[<>|;&`]|\$\(/g)].map((m) => m[0]);
}
