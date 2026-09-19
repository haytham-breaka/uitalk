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
//
// A tag match alone is not enough to call a file confirmed: `<Button` also
// matches a comment, a string literal, or a same-named component imported from
// somewhere else entirely (components/Button.tsx and legacy/Button.tsx are not
// the same component). Every import in a file is resolved first — no AST,
// just a conservative parser for the common forms — and a file counts as
// confirmed only once one of those imports resolves to the defining file
// itself *and* the local name it binds is actually rendered. Resolving by
// import first, rather than searching for the original name and only then
// checking the import, is what catches a renamed import (`{ Button as
// PrimaryButton }`) or a default import under any local name at all — the
// file never contains the literal text `<Button` in that case, so anything
// gated on that text first would never look at it. A same-named tag whose
// import can't be verified this way (a path alias, a barrel re-export, no
// import found at all) is still reported, just as "possible" rather than
// "confirmed."

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".cov"]);
const COMPONENT_EXTENSIONS = /\.(jsx?|tsx?|vue|svelte)$/i;
const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".vue", ".svelte"];
const MAX_FILE_BYTES = 500_000; // a generated bundle is not worth scanning
const MAX_FILES_WALKED = 5000; // a hard ceiling so a huge repo cannot hang a tool call
const MAX_DISTINCT_FILES = 20; // enough to tell "a few" from "everywhere" without counting forever

/** PascalCase -> kebab-case, for Vue templates, which accept either spelling. */
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** Whether `body` renders `localName` as a tag, in either spelling Vue accepts.
 * Single-word names skip the kebab form — see the note where `needles` is built. */
const rendersAsTag = (body, localName) => {
  if (body.includes(`<${localName}`)) return true;
  const k = kebab(localName);
  return k.includes("-") && body.includes(`<${k}`);
};

const IMPORT_RE = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;

/**
 * The local binding names an import clause introduces — `import Default, {
 * Named, Other as Renamed } from "spec"` or `import * as NS from "spec"` —
 * so a renamed import can be followed by the name it's actually used under,
 * not the name it was exported as.
 */
function bindingsFromClause(clause) {
  const trimmed = clause.trim();
  const ns = trimmed.match(/^\*\s+as\s+(\w+)$/);
  if (ns) return [ns[1]];

  const bindings = [];
  const namedMatch = trimmed.match(/\{([^}]*)\}/);
  const defaultPart = trimmed.replace(/\{[^}]*\}/, "").replace(/,\s*$/, "").trim();
  if (defaultPart && /^\w+$/.test(defaultPart)) bindings.push(defaultPart);
  if (namedMatch) {
    for (const piece of namedMatch[1].split(",")) {
      const p = piece.trim();
      if (!p) continue;
      const asMatch = p.match(/^(\w+)\s+as\s+(\w+)$/);
      bindings.push(asMatch ? asMatch[2] : p);
    }
  }
  return bindings;
}

/** Every `import ... from "spec"` in `body`, as { specifier, bindings }. */
function importsIn(body) {
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(body))) {
    const [, clause, specifier] = m;
    out.push({ specifier, bindings: bindingsFromClause(clause) });
  }
  return out;
}

/**
 * A relative specifier resolved to a real file, trying common source
 * extensions and directory-index files. Returns null for a bare import or a
 * path alias (`@/components/Button`) — resolving those needs the project's
 * own bundler config, which this deliberately doesn't depend on.
 */
function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  if (extname(base) && existsSync(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexed = join(base, `index${ext}`);
    if (existsSync(indexed)) return indexed;
  }
  return existsSync(base) ? base : null;
}

/**
 * How many other files in the project render <Name ...> (or, for Vue's
 * template syntax, <kebab-name ...>) — not counting the file that defines it.
 * `confirmedFiles` counted an import that resolves to the defining file
 * itself; `possibleFiles` counted a matching tag whose import couldn't be
 * verified as the same component. Returns null when there is nothing sensible
 * to count: no name, a name that doesn't look like a component, or a defining
 * file outside the project.
 */
export function countUsages(project, name, definingFile) {
  if (!name || !/^[A-Z][A-Za-z0-9]*$/.test(name)) return null;
  if (!definingFile) return null;

  const root = resolve(project);
  const defining = resolve(root, definingFile);
  const rel = relative(root, defining);
  if (rel.startsWith(`..`) || isAbsolute(rel)) return null; // outside the project: not ours to ripple-check

  // A single-word name's "kebab-case" is just its lowercased self ("Button" ->
  // "button"), indistinguishable from the native HTML element of the same
  // name — that fallback is only meaningful, and only added, for a genuinely
  // multi-word name ("MyWidget" -> "my-widget").
  const kebabName = kebab(name);
  const needles = kebabName.includes("-") ? [`<${name}`, `<${kebabName}`] : [`<${name}`];
  const confirmed = new Set();
  const possible = new Set();
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

      // Resolve every import first, regardless of what name it binds locally
      // — a rename (`{ Button as PrimaryButton }`) or a default import under
      // any name at all still points at the same file, and a file rendering
      // it under that local name is confirmed reuse whether or not the local
      // name has anything to do with the original one.
      let confirmedHere = false;
      for (const imp of importsIn(body)) {
        if (resolveRelativeImport(full, imp.specifier) !== defining) continue;
        if (imp.bindings.some((b) => rendersAsTag(body, b))) {
          confirmedHere = true;
          break;
        }
      }

      const relPath = relative(root, full);
      if (confirmedHere) confirmed.add(relPath);
      else if (needles.some((n) => body.includes(n))) possible.add(relPath);
      else continue;

      if (confirmed.size + possible.size >= MAX_DISTINCT_FILES) {
        stopped = true;
        return;
      }
    }
  };

  walk(root);
  return { confirmedFiles: confirmed.size, possibleFiles: possible.size, capped: stopped };
}
