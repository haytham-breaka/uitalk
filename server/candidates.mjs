// A project-source fallback for locate_source when no framework carries
// dev-time metadata (a production build, or a framework locateSource doesn't
// know), and the served-HTML fallback (findInServedHtml) has nothing either.
//
// The difference from that HTML fallback matters: this searches the project's
// own source files, not the markup a dev server rendered, so it can point at
// the file an agent would actually open. It never gets promoted past
// "candidate" confidence, the same rule locate_source already applies to a
// served-HTML match — a text hit is a lead, not a location to edit blind.
//
// Approximate and capped, in the same spirit as usage.mjs and search_files:
// enough to point somewhere real, not a project-wide index. No AST — this is
// the same substring search search_files already does, applied to whichever
// identifier is currently the most distinctive.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".cov"]);
const SOURCE_EXTENSIONS = /\.(jsx?|tsx?|vue|svelte|html?|erb|php)$/i;
const MAX_FILE_BYTES = 500_000; // a generated bundle is not worth scanning
const MAX_FILES_WALKED = 5000; // a hard ceiling so a huge repo cannot hang a tool call
const MAX_CANDIDATES = 8;

/**
 * Up to a handful of file:line matches for an element's identifiers, most
 * distinctive first — a caller passes them ranked (testid/id/aria before
 * plain text or a class), and this only falls back to a weaker identifier
 * when nothing in the project matches a stronger one at all.
 */
export function findSourceCandidates(project, needles, { max = MAX_CANDIDATES } = {}) {
  const ranked = needles.filter(Boolean);
  if (!ranked.length) return [];

  const root = resolve(project);
  const hitsByNeedle = ranked.map(() => []);
  let walked = 0;
  let stopped = false;

  const bestSoFar = () => hitsByNeedle.find((h) => h.length);

  const walk = (dir, depth = 0) => {
    if (stopped || depth > 10) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stopped) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.test(entry.name)) continue;

      if (++walked > MAX_FILES_WALKED) {
        stopped = true;
        return;
      }
      let body;
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }

      for (let i = 0; i < ranked.length; i++) {
        const at = body.indexOf(ranked[i]);
        if (at === -1) continue;
        const lineNo = body.slice(0, at).split("\n").length;
        hitsByNeedle[i].push({
          file: relative(root, full),
          line: lineNo,
          matched: ranked[i],
          excerpt: (body.split("\n")[lineNo - 1] ?? "").trim().slice(0, 160),
        });
        break; // this file's one candidate slot goes to its best-ranked match
      }

      const best = bestSoFar();
      if (best && best.length >= max) {
        stopped = true;
        return;
      }
    }
  };

  walk(root);
  return bestSoFar() ?? [];
}
