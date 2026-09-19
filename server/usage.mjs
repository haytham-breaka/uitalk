// How widely a component is reused across the project, so the agent can tell
// "this is the one thing everyone shares" from "this is just this instance"
// and ask, rather than silently rippling a style change through every place
// the component appears.
//
// Approximate and capped, in the same spirit as search_files: enough evidence
// to decide whether to ask about scope, not a real reference index. A name is
// only worth counting when its own file lives inside the project — a UI-library
// wrapper (Box, Flex, styled.div) can be resolved as the "component" by the
// same dev-time metadata locate_source reads, and those are used everywhere
// for reasons that have nothing to do with what the user actually clicked.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".cov"]);
const COMPONENT_EXTENSIONS = /\.(jsx?|tsx?|vue|svelte)$/i;
const MAX_FILE_BYTES = 500_000; // a generated bundle is not worth scanning
const MAX_FILES_WALKED = 5000; // a hard ceiling so a huge repo cannot hang a tool call
const MAX_DISTINCT_FILES = 20; // enough to tell "a few" from "everywhere" without counting forever

/** PascalCase -> kebab-case, for Vue templates, which accept either spelling. */
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * How many other files in the project render <Name ...> (or, for Vue's
 * template syntax, <kebab-name ...>) — not counting the file that defines it.
 * Returns null when there is nothing sensible to count: no name, a name that
 * doesn't look like a component, or a defining file outside the project.
 */
export function countUsages(project, name, definingFile) {
  if (!name || !/^[A-Z][A-Za-z0-9]*$/.test(name)) return null;
  if (!definingFile) return null;

  const root = resolve(project);
  const defining = resolve(root, definingFile);
  const rel = relative(root, defining);
  if (rel.startsWith(`..`) || isAbsolute(rel)) return null; // outside the project: not ours to ripple-check

  const needles = [`<${name}`, `<${kebab(name)}`];
  const files = new Set();
  let walked = 0;
  let stopped = false;

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
      if (!entry.isFile() || !COMPONENT_EXTENSIONS.test(entry.name) || full === defining) continue;

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
      if (needles.some((n) => body.includes(n))) {
        files.add(relative(root, full));
        if (files.size >= MAX_DISTINCT_FILES) {
          stopped = true;
          return;
        }
      }
    }
  };

  walk(root);
  return { otherFiles: files.size, capped: stopped };
}
