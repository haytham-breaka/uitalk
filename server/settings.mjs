// Per-app settings, layered so a project can differ from the global default and
// an env var can override both for one run.
//
//   built-in defaults  <  ~/.uitalk/settings.json  <  <project>/.uitalk.json  <  env
//
// Writes from the panel go to the project file, because a context budget that
// suits a small landing page is the wrong budget for a large app.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.UITALK_HOME ?? join(homedir(), ".uitalk");
const GLOBAL_FILE = join(HOME, "settings.json");
const PROJECT_FILE = ".uitalk.json";

export const DEFAULTS = {
  // Compaction. Ours is summarize-then-restart, so it is lossier than a native
  // incremental compaction: a low threshold compacts more often and discards
  // more detail each time.
  autoCompact: true,
  compactAtPercent: 20,
  contextTokens: 200_000,
  compactCooldownTurns: 2,

  // How much transcript the bridge replays to a page that just connected.
  replayLimit: 200,

  // An app with no live reload leaves the page showing the old markup after an edit,
  // so the before/after and the verification would both compare against a stale page.
  // "auto" reloads only when no HMR client is detected.
  reloadAfterEdit: "auto", // auto | always | never

  // Real pixels from the browser's compositor rather than a re-rendered clone.
  // Costs a one-time permission prompt; falls back on its own if declined.
  nativeCapture: true,

  // The inventory of elements shipped with each capture: what is in the shot, named.
  inventoryWithCapture: true,
  inventoryMaxNodes: 150,

  // Who answers the panel.
  //
  //   builtin   the Claude Code session the bridge runs itself, on the user's
  //             subscription. Needs @anthropic-ai/claude-agent-sdk.
  //   adapter   any model the user has a key for, driven over its own HTTP API.
  //   opencode  an OpenCode session, driven over its HTTP API. Needs the
  //             "opencode" CLI installed and its own model already configured —
  //             uitalk only owns the conversation loop, not its auth. Needs
  //             @opencode-ai/sdk.
  //   off       nobody: an MCP client drives the page tools instead, and the
  //             panel's chat, context meter and compaction step aside for it.
  //
  // Changing this takes effect when the bridge restarts: a session cannot be
  // swapped underneath a conversation.
  agent: "builtin",
  agentProvider: "openai", // openai | anthropic | gemini  (adapter only)
  agentModel: "", // empty means the provider's default below
  agentBaseUrl: "", // an OpenAI-compatible endpoint that is not OpenAI's own
  opencodeServerUrl: "", // empty: use one already on :4096, else start one (opencode only)
};

export const FIELDS = {
  autoCompact: { type: "boolean", label: "Compact automatically" },
  compactAtPercent: { type: "number", min: 5, max: 95, label: "Compact at % of context" },
  contextTokens: { type: "number", min: 20_000, max: 2_000_000, label: "Context window (tokens)" },
  compactCooldownTurns: { type: "number", min: 0, max: 50, label: "Turns to wait before recompacting" },
  replayLimit: { type: "number", min: 0, max: 2000, label: "Transcript entries kept" },
  nativeCapture: { type: "boolean", label: "Capture real screen pixels (asks once)" },
  reloadAfterEdit: { type: "choice", choices: ["auto", "always", "never"], label: "Reload the app after an edit" },
  inventoryWithCapture: { type: "boolean", label: "Send element inventory with screenshots" },
  inventoryMaxNodes: { type: "number", min: 10, max: 1000, label: "Max inventory nodes" },
  agent: { type: "choice", choices: ["builtin", "adapter", "opencode", "off"], label: "Who answers the panel", restart: true },
  agentProvider: { type: "choice", choices: ["openai", "anthropic", "gemini"], label: "Adapter provider", restart: true },
  agentModel: { type: "text", max: 120, label: "Adapter model", restart: true },
  agentBaseUrl: { type: "text", max: 300, label: "OpenAI-compatible base URL", restart: true },
  opencodeServerUrl: { type: "text", max: 300, label: "OpenCode server URL (blank: auto)", restart: true },
};

const ENV = {
  autoCompact: (v) => v !== "0" && v !== "false",
  compactAtPercent: Number,
  contextTokens: Number,
  compactCooldownTurns: Number,
  replayLimit: Number,
  nativeCapture: (v) => v !== "0" && v !== "false",
  reloadAfterEdit: String,
  inventoryWithCapture: (v) => v !== "0" && v !== "false",
  inventoryMaxNodes: Number,
  agent: String,
  agentProvider: String,
  agentModel: String,
  agentBaseUrl: String,
  opencodeServerUrl: String,
};

const readJson = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {}; // absent or unreadable: fall back to defaults silently — the normal case
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch (err) {
    // Present but not valid JSON — a hand-edit typo. Silently reverting every
    // setting (or ignoring a key the user clearly put in credentials.json) sends
    // them hunting in the wrong place, so say so rather than swallow it.
    console.warn(`[uitalk] ignoring ${path}: not valid JSON (${err.message})`);
    return {};
  }
};

/** Coerce and clamp, so a bad value in a hand-edited file cannot wedge a session. */
export function validate(patch) {
  const clean = {};
  const rejected = [];
  for (const [key, raw] of Object.entries(patch ?? {})) {
    const field = FIELDS[key];
    if (!field) {
      rejected.push(`${key}: not a setting`);
      continue;
    }
    if (field.type === "boolean") {
      // A real JSON boolean only. Boolean("false") is true, so coercing would read
      // a hand-edited "nativeCapture": "false" as on — the opposite of the intent,
      // and the opposite of how the same value parses as an env var. Reject the
      // wrong type out loud instead, and let the layer below stand.
      if (typeof raw === "boolean") clean[key] = raw;
      else rejected.push(`${key}: must be true or false, not ${JSON.stringify(raw)}`);
      continue;
    }
    if (field.type === "text") {
      const str = String(raw ?? "").trim();
      if (str.length > field.max) rejected.push(`${key}: longer than ${field.max} characters`);
      else clean[key] = str;
      continue;
    }
    if (field.type === "choice") {
      if (field.choices.includes(raw)) clean[key] = raw;
      else rejected.push(`${key}: must be one of ${field.choices.join(", ")}`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      rejected.push(`${key}: not a number`);
      continue;
    }
    clean[key] = Math.min(field.max, Math.max(field.min, Math.round(n)));
    if (clean[key] !== n) rejected.push(`${key}: clamped to ${clean[key]}`);
  }
  return { clean, rejected };
}

export function load(projectRoot) {
  const fromEnv = {};
  for (const [key, coerce] of Object.entries(ENV)) {
    const raw = process.env[`UITALK_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
    if (raw !== undefined) fromEnv[key] = coerce(raw);
  }
  const merged = {
    ...DEFAULTS,
    ...validate(readJson(GLOBAL_FILE)).clean,
    ...validate(readJson(join(projectRoot, PROJECT_FILE))).clean,
    ...validate(fromEnv).clean,
  };
  return merged;
}

/** Persist to the project's file and return the freshly merged view. */
export function save(projectRoot, patch) {
  const { clean, rejected } = validate(patch);
  const file = join(projectRoot, PROJECT_FILE);
  const current = readJson(file);
  const next = { ...current, ...clean };

  mkdirSync(projectRoot, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);

  return { settings: load(projectRoot), written: file, rejected };
}

// A key is not a setting. It never goes in the project file — that file is meant to
// be committed — and it is never sent to the panel, so it cannot leak into a page.
// Env first (the name each provider's own tools already use), then a file in the
// uitalk home that only the user can read.
const KEY_ENV = {
  openai: ["UITALK_API_KEY", "OPENAI_API_KEY"],
  anthropic: ["UITALK_API_KEY", "ANTHROPIC_API_KEY"],
  gemini: ["UITALK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

export const CREDENTIALS_FILE = join(HOME, "credentials.json");

/** The key for one provider, and where it came from, for a log line that names neither. */
export function credential(provider) {
  for (const name of KEY_ENV[provider] ?? ["UITALK_API_KEY"]) {
    const v = process.env[name];
    if (v) return { key: v.trim(), from: `$${name}` };
  }
  const file = readJson(CREDENTIALS_FILE);
  const v = file[provider] ?? file.apiKey;
  if (typeof v === "string" && v.trim()) return { key: v.trim(), from: CREDENTIALS_FILE };
  return { key: null, from: null };
}

/** Write one provider's key to the uitalk home, readable only by its owner. */
export function saveCredential(provider, key) {
  mkdirSync(HOME, { recursive: true });
  const next = { ...readJson(CREDENTIALS_FILE), [provider]: String(key).trim() };
  const tmp = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_FILE);
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {}
  return CREDENTIALS_FILE;
}

export const paths = { global: GLOBAL_FILE, project: PROJECT_FILE, credentials: CREDENTIALS_FILE };
