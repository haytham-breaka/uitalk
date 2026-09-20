// A per-project capability token, so only a client the bridge actually handed the
// token to can open the control socket.
//
// Binding to loopback keeps other machines out, and the Origin check keeps a
// remote web page out, but neither stops another app on the same machine — a
// second dev server on localhost:3000, or a site the user is visiting — from
// opening a socket to this bridge and driving it. The token is the thing those
// cannot obtain: it is injected into the pages this bridge serves (never into the
// shared client.js bundle, which anyone can load cross-origin), and required on
// the socket handshake.
//
// It lives in the uitalk home, readable only by its owner, and never in the
// project — a token committed to a repo would defeat the point. Persisting it per
// project keeps a bookmarklet and an already-open page working across a bridge
// restart rather than silently failing to reconnect.
//
// One file per project, not one shared JSON object: two processes (a bridge and
// its MCP server) asking for the same project's token at once would each read
// "no token", generate a different one, and the second write would win — leaving
// the store holding a token the running bridge never accepted. Electing a single
// writer with an atomic exclusive create means every concurrent caller converges
// on the one token.

import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, chmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const DIR = join(HOME, "tokens");
const LEGACY = join(HOME, "tokens.json"); // the pre-per-project single-object store

/** The one spelling of a project two paths to the same directory agree on, so a
 * bridge and an MCP server started with different spellings still share a token. */
function key(project) {
  let p;
  try {
    p = realpathSync.native ? realpathSync.native(project) : realpathSync(project);
  } catch {
    p = project;
  }
  return process.platform === "win32" ? p.toLowerCase() : p;
}

const tokenFile = (k) => join(DIR, `${createHash("sha256").update(k).digest("hex")}.token`);

const readTrim = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
};

/** A token already recorded for this project in the old shared store, so
 * migrating never rotates a token a running bridge or a saved bookmarklet holds. */
function legacyToken(k) {
  try {
    const v = JSON.parse(readFileSync(LEGACY, "utf8"));
    return v && typeof v === "object" && typeof v[k] === "string" ? v[k].trim() : "";
  } catch {
    return "";
  }
}

/** This project's token, created on first use and reused after. Concurrent
 * first-time callers for the same project all get the one token the winner wrote. */
export function projectToken(project) {
  const k = key(project);
  const file = tokenFile(k);

  const existing = readTrim(file);
  if (existing) return existing;

  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const token = legacyToken(k) || randomBytes(24).toString("hex");

  // Write the whole token to a temp file, then hard-link it into place: link is
  // atomic and fails with EEXIST if the target already exists, so exactly one
  // caller wins, and the target — the moment it appears — is a link to fully
  // written content, never an empty file a racing reader could observe.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {}
    return token;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return readTrim(file); // a concurrent caller won; use the token it wrote
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
