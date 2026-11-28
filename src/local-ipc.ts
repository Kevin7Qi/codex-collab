import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const COLLAB_PIPE_PREFIX = "\\\\.\\pipe\\LOCAL\\codex-collab-";

export function isCollabPipe(path: string, purpose = ""): boolean {
  return path.toLowerCase().startsWith(COLLAB_PIPE_PREFIX.toLowerCase() + purpose);
}

export function localAddress(dir: string, name: string, scope = dir): string {
  if (process.platform !== "win32") return join(dir, `${name}.sock`);
  const hash = createHash("sha256").update(resolve(homedir()).toLowerCase())
    .update("\0").update(resolve(scope).toLowerCase()).digest("hex").slice(0, 24);
  return `${COLLAB_PIPE_PREFIX}${name}-${hash}`;
}

export function privateSocketUmask(): () => void {
  if (process.platform === "win32") return () => {};
  const previous = process.umask(0o077);
  return () => { process.umask(previous); };
}
