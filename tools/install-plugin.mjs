// Links this directory into ~/.claude/skills/ so Claude Code auto-loads it in
// every project, with no --plugin-dir flag and no marketplace.
//
// A symlink rather than a copy: edit the source and the next session picks it up.

import { mkdirSync, symlinkSync, rmSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(homedir(), ".claude", "skills");
const link = join(dir, "uitalk");

mkdirSync(dir, { recursive: true });

try {
  const existing = lstatSync(link);
  if (existing.isSymbolicLink() && readlinkSync(link) === root) {
    console.log(`already linked: ${link} -> ${root}`);
    process.exit(0);
  }
  if (existing.isSymbolicLink()) {
    rmSync(link);
  } else {
    console.error(`${link} exists and is not a symlink. Move it aside and re-run.`);
    process.exit(1);
  }
} catch {
  // nothing there yet
}

symlinkSync(root, link, "dir");
console.log(`linked ${link} -> ${root}`);
console.log("Start a new Claude Code session (or run /reload-plugins) and the");
console.log("uitalk skill plus the `uitalk` command will be available.");
