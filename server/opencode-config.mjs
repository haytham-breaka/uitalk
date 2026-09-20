// Wiring uitalk into a project's OpenCode config so `opencode` mode can see the
// page tools. OpenCode only hands a session the tools named in opencode.jsonc /
// opencode.json, so without this entry the mode chats and edits files but can't
// select, capture or preview. We used to only warn, for fear of destroying a
// hand-edited JSONC file's comments on a parse-and-rewrite round-trip. This adds
// the entry without that round-trip: a fresh file is created outright, and an
// existing one is edited by splicing a single member in at a located brace, so
// every other byte — comments included — is left exactly as it was. Anything we
// can't do that safely to falls back to leaving the file alone.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CANDIDATES = ["opencode.jsonc", "opencode.json"];

// The entry OpenCode needs. environment.UITALK_PROJECT pins the stdio MCP server
// to this project, so it finds the right bridge in the registry.
function uitalkEntry(project) {
  return { type: "local", command: ["uitalk-mcp"], environment: { UITALK_PROJECT: project } };
}

// Read the config to a plain value, tolerating JSONC (line/block comments and
// trailing commas), string-aware so a `//`, `/*` or `,` inside a string is left
// alone. Returns null when it isn't valid enough to reason about. Exported for
// tests that need to re-read what was written the same forgiving way.
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        out += text[i];
        if (text[i] === "\\") {
          out += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === ",") {
      // A trailing comma is one followed only by whitespace before a } or ]. We
      // are past comment stripping for the chars we emit, but the source may still
      // hold comments between the comma and the bracket, so skip those too.
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === " " || d === "\t" || d === "\r" || d === "\n") { j++; continue; }
        if (d === "/" && text[j + 1] === "/") { j += 2; while (j < n && text[j] !== "\n") j++; continue; }
        if (d === "/" && text[j + 1] === "*") { j += 2; while (j < n && !(text[j] === "*" && text[j + 1] === "/")) j++; j = Math.min(j + 2, n); continue; }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++; // drop the trailing comma
        continue;
      }
    }
    out += c;
    i++;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// The byte offset just after the opening brace we should splice a new member in
// after: the value object of a top-level `mcp` key when it exists, else the root
// object. String- and comment-aware so braces inside those don't fool it. Returns
// null when the top level isn't a brace-delimited object.
function insertionPoint(text) {
  let i = 0;
  const n = text.length;
  const skip = () => {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
      if (c === "/" && text[i + 1] === "/") { i += 2; while (i < n && text[i] !== "\n") i++; continue; }
      if (c === "/" && text[i + 1] === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++; i = Math.min(i + 2, n); continue; }
      break;
    }
  };
  const readString = () => {
    const start = i;
    i++;
    while (i < n) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === '"') { i++; break; }
      i++;
    }
    return text.slice(start + 1, i - 1);
  };

  skip();
  if (text[i] !== "{") return null;
  const rootOpen = i + 1;
  i++;
  let depth = 1;
  let mcpOpen = null;
  while (i < n && depth > 0) {
    skip();
    if (i >= n) break;
    const c = text[i];
    if (c === '"') {
      const key = readString();
      if (depth === 1 && key === "mcp") {
        skip();
        if (text[i] === ":") {
          i++;
          skip();
          if (text[i] === "{") mcpOpen = i + 1;
        }
      }
      continue;
    }
    if (c === "{" || c === "[") { depth++; i++; continue; }
    if (c === "}" || c === "]") { depth--; i++; continue; }
    i++;
  }
  return { rootOpen, mcpOpen };
}

// Splice a `"key": value` member in right after the brace at `at`, adding a
// trailing comma when the object already has members that follow it.
function spliceMember(text, at, key, value, hasFollowing) {
  const member = `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}${hasFollowing ? "," : ""}`;
  return text.slice(0, at) + member + text.slice(at);
}

/**
 * Make sure this project's OpenCode config points at uitalk's MCP server. Never
 * throws and never rewrites a file wholesale: it creates one when absent, or
 * splices a single member into an existing one and re-parses to confirm the
 * result is still valid before writing. Returns what it did:
 *   { action: "present" | "created" | "inserted" | "skipped", file, reason? }
 */
export function ensureUitalkMcp(project) {
  const entry = uitalkEntry(project);

  let found = null;
  for (const name of CANDIDATES) {
    const path = join(project, name);
    try {
      found = { path, name, text: readFileSync(path, "utf8") };
      break;
    } catch {
      // not this one
    }
  }

  // No config yet: create opencode.json outright. Nothing to preserve.
  if (!found) {
    const path = join(project, "opencode.json");
    const body = { $schema: "https://opencode.ai/config.json", mcp: { uitalk: entry } };
    try {
      writeFileSync(path, JSON.stringify(body, null, 2) + "\n", "utf8");
      return { action: "created", file: "opencode.json" };
    } catch (err) {
      return { action: "skipped", file: "opencode.json", reason: err.message };
    }
  }

  const parsed = parseJsonc(found.text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { action: "skipped", file: found.name, reason: "could not parse config" };
  }
  const mcp = parsed.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp) && mcp.uitalk) {
    return { action: "present", file: found.name };
  }
  if (mcp !== undefined && (typeof mcp !== "object" || Array.isArray(mcp))) {
    return { action: "skipped", file: found.name, reason: "mcp is not an object" };
  }

  const spot = insertionPoint(found.text);
  if (!spot) return { action: "skipped", file: found.name, reason: "unexpected shape" };

  let next;
  if (mcp) {
    if (spot.mcpOpen == null) return { action: "skipped", file: found.name, reason: "could not locate mcp" };
    next = spliceMember(found.text, spot.mcpOpen, "uitalk", entry, Object.keys(mcp).length > 0);
  } else {
    next = spliceMember(found.text, spot.rootOpen, "mcp", { uitalk: entry }, Object.keys(parsed).length > 0);
  }

  // Trust nothing: only write if the spliced text still parses and now carries us.
  const check = parseJsonc(next);
  if (!check || typeof check.mcp !== "object" || check.mcp === null || !check.mcp.uitalk) {
    return { action: "skipped", file: found.name, reason: "edit would not have parsed" };
  }
  try {
    writeFileSync(found.path, next, "utf8");
    return { action: "inserted", file: found.name };
  } catch (err) {
    return { action: "skipped", file: found.name, reason: err.message };
  }
}
