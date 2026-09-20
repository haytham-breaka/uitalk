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
// gated on that text first would never look at it. Path aliases (`@/components
// /Button`) are resolved through the project's own declared mapping —
// tsconfig/jsconfig `paths`/`baseUrl` and a Vite config's `resolve.alias` — so
// an aliased import of the defining file counts as confirmed too. A same-named
// tag whose import still can't be tied to this file (a barrel re-export, an
// alias defined by code we won't evaluate, no import at all) is reported as
// "possible" rather than "confirmed."

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parseJsonc } from "./jsonc.mjs";

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
 * A (possibly extensionless) base path resolved to a real file, trying common
 * source extensions and directory-index files, the way a bundler would.
 */
function resolveFileAt(base) {
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

/** A relative specifier resolved to a real file, or null when it isn't relative. */
function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  return resolveFileAt(resolve(dirname(fromFile), specifier));
}

const TS_CONFIGS = ["tsconfig.json", "jsconfig.json"];
const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs", "vite.config.cts"];

// --- resolving path aliases (@/components/Button) ---------------------------
// A path alias can't be resolved by walking the filesystem — it means whatever
// the project's own config says it means. We read the two declarative places
// that hold that mapping: tsconfig/jsconfig `compilerOptions.paths`/`baseUrl`,
// and a Vite config's `resolve.alias`. Anything an alias can't be resolved
// through (a barrel re-export, an alias defined by arbitrary code we won't
// evaluate) still falls back to "possible", never a wrong "confirmed" — a
// mis-resolved alias would have to land on the exact defining file to matter.

/** i points at a quote; returns the index of the matching close quote. */
function skipString(text, i) {
  const q = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === q) return i;
    i++;
  }
  return i;
}

/** openIdx points at { or [; returns the index of its matching close, string-aware. */
function matchBracket(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i); continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an object/array body at its top-level commas, respecting nesting and strings. */
function topLevelSplit(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(inner, i); continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (inner.slice(start).trim()) parts.push(inner.slice(start));
  return parts;
}

/** `key: value` object members, as { key, valueRaw }, keys and values unparsed. */
function objectMembers(inner) {
  const out = [];
  for (const part of topLevelSplit(inner)) {
    let colon = -1;
    for (let i = 0; i < part.length && colon < 0; i++) {
      const c = part[i];
      if (c === '"' || c === "'" || c === "`") { i = skipString(part, i); continue; }
      if (c === ":") colon = i;
    }
    if (colon < 0) continue;
    out.push({ key: part.slice(0, colon), valueRaw: part.slice(colon + 1) });
  }
  return out;
}

/** The string inside a quoted literal, or null. */
function unquote(s) {
  const m = /^\s*(['"`])([^'"`]*)\1\s*$/.exec(s);
  return m ? m[2] : null;
}

/**
 * A Vite alias replacement expression resolved to an absolute base path, for the
 * literal forms configs actually use: a string, `path.resolve(__dirname, "…")`,
 * or `fileURLToPath(new URL("…", import.meta.url))`. Anything else is left null.
 */
function aliasTarget(raw, dir) {
  const s = raw.trim();
  let m;
  if ((m = /^(['"`])([^'"`]*)\1/.exec(s))) return isAbsolute(m[2]) ? m[2] : resolve(dir, m[2]);
  if ((m = /^(?:path\.)?(?:resolve|join)\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*\)/.exec(s))) return resolve(dir, m[2]);
  if ((m = /^fileURLToPath\(\s*new\s+URL\(\s*(['"`])([^'"`]+)\1/.exec(s))) return resolve(dir, m[2]);
  return null;
}

/** `resolve.alias` entries from the project's Vite config, as { find, replacement }. */
function viteAliases(root) {
  let text = null;
  for (const name of VITE_CONFIGS) {
    try {
      text = readFileSync(join(root, name), "utf8");
      break;
    } catch {
      // not this one
    }
  }
  if (!text) return [];
  const at = /\balias\s*:\s*[[{]/.exec(text);
  if (!at) return [];
  const openIdx = at.index + at[0].length - 1;
  const closeIdx = matchBracket(text, openIdx);
  if (closeIdx < 0) return [];
  const kind = text[openIdx];
  const inner = text.slice(openIdx + 1, closeIdx);
  const out = [];
  if (kind === "{") {
    // { "@": path.resolve(__dirname, "src"), ... }
    for (const { key, valueRaw } of objectMembers(inner)) {
      const find = unquote(key);
      const replacement = aliasTarget(valueRaw, root);
      if (find && replacement) out.push({ find, replacement });
    }
  } else {
    // [ { find: "@", replacement: … }, … ]
    for (const part of topLevelSplit(inner)) {
      const bi = part.indexOf("{");
      if (bi < 0) continue;
      const be = matchBracket(part, bi);
      if (be < 0) continue;
      let find = null;
      let replacement = null;
      for (const { key, valueRaw } of objectMembers(part.slice(bi + 1, be))) {
        const k = key.trim().replace(/^['"`]|['"`]$/g, "");
        if (k === "find") find = unquote(valueRaw);
        else if (k === "replacement") replacement = aliasTarget(valueRaw, root);
      }
      if (find && replacement) out.push({ find, replacement });
    }
  }
  return out;
}

/** The project's alias table: tsconfig/jsconfig paths + baseUrl, and Vite aliases. */
function loadAliases(root) {
  const tsPaths = [];
  let baseUrlDir = null;
  for (const name of TS_CONFIGS) {
    let raw;
    try {
      raw = readFileSync(join(root, name), "utf8");
    } catch {
      continue;
    }
    const co = parseJsonc(raw)?.compilerOptions;
    if (co && typeof co === "object") {
      // paths resolve relative to baseUrl when it's set, else to the config dir.
      const dir = typeof co.baseUrl === "string" ? resolve(root, co.baseUrl) : root;
      if (typeof co.baseUrl === "string") baseUrlDir = dir;
      if (co.paths && typeof co.paths === "object") {
        for (const [pattern, targets] of Object.entries(co.paths)) {
          if (!Array.isArray(targets)) continue;
          const strs = targets.filter((t) => typeof t === "string");
          if (strs.length) tsPaths.push({ pattern, star: pattern.includes("*"), targets: strs, dir });
        }
      }
    }
    break; // tsconfig wins over jsconfig; don't merge the two
  }
  return { tsPaths, baseUrlDir, viteAliases: viteAliases(root) };
}

/** A non-relative specifier resolved through the alias table, or null. */
function resolveAliasImport(specifier, aliases) {
  for (const e of aliases.tsPaths) {
    if (e.star) {
      const star = e.pattern.indexOf("*");
      const pre = e.pattern.slice(0, star);
      const post = e.pattern.slice(star + 1);
      if (!specifier.startsWith(pre) || !specifier.endsWith(post) || specifier.length < pre.length + post.length) continue;
      const mid = specifier.slice(pre.length, specifier.length - post.length);
      for (const t of e.targets) {
        const hit = resolveFileAt(resolve(e.dir, t.includes("*") ? t.replace("*", mid) : t));
        if (hit) return hit;
      }
    } else if (specifier === e.pattern) {
      for (const t of e.targets) {
        const hit = resolveFileAt(resolve(e.dir, t));
        if (hit) return hit;
      }
    }
  }
  for (const a of aliases.viteAliases) {
    let sub = null;
    if (specifier === a.find) sub = "";
    else if (specifier.startsWith(a.find + "/")) sub = specifier.slice(a.find.length);
    if (sub !== null) {
      const hit = resolveFileAt(a.replacement + sub);
      if (hit) return hit;
    }
  }
  if (aliases.baseUrlDir) {
    const hit = resolveFileAt(resolve(aliases.baseUrlDir, specifier));
    if (hit) return hit;
  }
  return null;
}

/** An import specifier resolved to a real file — relative first, then aliases. */
function resolveImport(fromFile, specifier, aliases) {
  return specifier.startsWith(".") ? resolveRelativeImport(fromFile, specifier) : resolveAliasImport(specifier, aliases);
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
  const aliases = loadAliases(root);
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
        if (resolveImport(full, imp.specifier, aliases) !== defining) continue;
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
