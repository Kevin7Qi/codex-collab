// scripts/check-bun.ts — the installers' Bun version check.
//
// Exits 1 with the reason when this Bun is older than package.json's
// `engines.bun`, before anything is built or copied.

import { bunTooOldMessage } from "../src/bun-version";

const message = bunTooOldMessage();
if (message) {
  console.error(`${message}, then run the installer again.`);
  process.exit(1);
}
