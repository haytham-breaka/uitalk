// A cross-process mutex around "is a bridge already serving this project? if not,
// register myself as the one that does."
//
// Two launchers started for the same project at the same moment can both look at the
// registry, both see nothing, and both spawn a bridge — leaving two bridges (two
// ports, two agent sessions) fronting one project, with a later lookup finding only
// one of them. The check and the registration have to be one indivisible step, and
// across processes that needs a lock the OS enforces, not a plain check-then-write.
//
// The lock itself lives in server/file-lock.mjs, which takes it by hard-linking a
// temp file that already holds the owner's pid — so the lock is never observable in
// an empty, half-created state that a second starter could mistake for stale.

import { homedir } from "node:os";
import { join } from "node:path";
import { withLock } from "./file-lock.mjs";
import { projectSlug } from "./project-id.mjs";

const HOME = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const LOCK_DIR = join(HOME, "locks");

/**
 * Run `critical` while holding this project's startup lock. Returns whatever
 * `critical` returns. The critical section is expected to be short.
 */
export function withProjectLock(project, critical) {
  return withLock(join(LOCK_DIR, `${projectSlug(project)}.lock`), critical);
}
