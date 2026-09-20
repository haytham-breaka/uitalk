// A stable, collision-resistant identity for one project's launcher files.
//
// The launcher keeps per-project state on disk — a dev-server pidfile, a dev log,
// the bridge's own log. Naming those by the project's basename alone collides
// across unrelated repos that share a leaf directory name: /a/frontend and
// /b/frontend both resolve to "frontend". That is not cosmetic — one project's
// `--stop` reads the other's pidfile and can kill its dev server, and `--status`
// misreports a sibling's process as this project's. The canonical project path is
// what actually distinguishes them, so the identity is derived from it: a readable,
// filesystem-safe basename kept for humans, plus a short hash of the full path that
// makes the whole slug unique. Same path in, same slug out (so a later run finds
// the files it wrote); different path, different slug (so two projects never share).
import { createHash } from "node:crypto";
import { basename } from "node:path";

/**
 * A single path-segment identifier for `project` (which should already be a
 * canonical, resolved path so the same directory always hashes the same). The
 * basename is sanitised to the characters safe in a filename on every platform;
 * the 8-hex-char suffix is enough to separate same-basename projects while keeping
 * the slug short and legible.
 */
export function projectSlug(project) {
  const safe = basename(project).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}
