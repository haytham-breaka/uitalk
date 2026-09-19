// The panel, driven by a model the user has their own key for.
//
// The built-in session is Claude Code on the user's subscription: it brings the agent
// loop, the file tools and the context management with it. This is the same panel
// answered over a plain HTTP API instead, so the loop, the file editing and the
// token accounting have to exist here.
//
// Three providers, because their wire shapes differ in ways no single abstraction
// hides well: who holds the tool schema, how a tool result is sent back, and where
// an image may appear. Each one owns those three decisions and nothing else.
//
// What it deliberately does not do: stream. A turn arrives as one block of text
// rather than token by token. Everything else the panel shows — tool names, the
// context meter, compaction — works the same as with the built-in session.

import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, join, dirname, sep, isAbsolute } from "node:path";
import { toolDefinitions, text, failed } from "./tool-defs.mjs";
import { countUsages } from "./usage.mjs";

const DEFAULT_MODEL = {
  openai: "gpt-5",
  anthropic: "claude-opus-5",
  gemini: "gemini-2.5-pro",
};

const MAX_ROUNDS = 24; // a turn that calls tools forever is a bug, not a long task
const MAX_READ = 120_000; // bytes of one file, so a bundle cannot fill the window
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".cov"]);

// ------------------------------------------------------------- the file tools

/**
 * Editing source is the whole point of an approval, so the adapter needs its own
 * file tools. Every path is resolved and checked to be inside the project: a model
 * asking for ../../.ssh/id_rsa gets a refusal, not a read.
 */
export function fileTools(project, report = () => {}) {
  const root = resolve(project);
  const realRoot = realpathSync(root);
  const outside = (path) => new Error(`${path} is outside the project, so it will not be touched`);

  // resolve()+relative() alone only reject a *lexical* escape (../../.ssh) — a
  // symlink inside the project pointing outside it (project/data -> /home/you)
  // resolves to a path string that still looks contained, but the filesystem
  // follows the link to somewhere real files tools were never meant to reach.
  // realpathSync resolves every symlink on the way, so it's checked against
  // where a read or write actually lands, not just what the string looks like.
  const withinRoot = (real) => {
    const rel = relative(realRoot, real);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  };

  const lexicallyInside = (path) => {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw outside(path);
    return full;
  };

  // read_file, edit_file and list_dir all require the target to already exist,
  // so its real location can be checked directly.
  const inside = (path) => {
    const full = lexicallyInside(path);
    if (!withinRoot(realpathSync(full))) throw outside(path);
    return full;
  };

  // write_file can create a path that doesn't exist yet, so there is nothing at
  // `full` to realpath. Walk up to the nearest ancestor that does exist — a
  // symlinked directory anywhere on the way there is exactly as much an escape
  // as a symlinked file would be — and check that instead. If `full` itself
  // already exists (overwriting a file, or a symlink writeFileSync would follow),
  // that ancestor search starts, and ends, at `full`.
  const insideForWrite = (path) => {
    const full = lexicallyInside(path);
    let check = full;
    while (!existsSync(check)) check = dirname(check);
    if (!withinRoot(realpathSync(check))) throw outside(path);
    return full;
  };

  const guard = (name, fn) => async (args) => {
    try {
      return text(await fn(args));
    } catch (err) {
      report(name, err.message);
      return failed(err);
    }
  };

  const walk = (dir, hit, depth = 0) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".uitalk.json") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, hit, depth + 1);
      else if (entry.isFile()) hit(full);
    }
  };

  return [
    {
      name: "read_file",
      readOnly: true,
      description:
        "Read a file from the project. The path is relative to the project root. Read before " +
        "you edit: edit_file needs the exact text that is in the file.",
      schema: { path: { type: "string", description: "Path relative to the project root" } },
      required: ["path"],
      run: guard("read_file", ({ path }) => {
        const body = readFileSync(inside(path), "utf8");
        return body.length > MAX_READ
          ? `${body.slice(0, MAX_READ)}\n\n[truncated at ${MAX_READ} of ${body.length} bytes]`
          : body;
      }),
    },
    {
      name: "edit_file",
      description:
        "Replace an exact span of text in a file. `find` must appear exactly once — that is what " +
        "makes the edit unambiguous. Prefer this over write_file: it cannot lose the rest of the file.",
      schema: {
        path: { type: "string", description: "Path relative to the project root" },
        find: { type: "string", description: "The exact text to replace, including its indentation" },
        replace: { type: "string", description: "What to put in its place" },
      },
      required: ["path", "find", "replace"],
      run: guard("edit_file", ({ path, find, replace }) => {
        const full = inside(path);
        const body = readFileSync(full, "utf8");
        const count = body.split(find).length - 1;
        if (count === 0) throw new Error(`that text is not in ${path} — read it again`);
        if (count > 1) throw new Error(`that text appears ${count} times in ${path}; include more context`);
        writeFileSync(full, body.replace(find, replace));
        return `edited ${path}`;
      }),
    },
    {
      name: "write_file",
      description:
        "Write a whole file, creating it or replacing every byte of it. For a change to an " +
        "existing file use edit_file instead.",
      schema: {
        path: { type: "string", description: "Path relative to the project root" },
        content: { type: "string", description: "The complete new contents" },
      },
      required: ["path", "content"],
      run: guard("write_file", ({ path, content }) => {
        writeFileSync(insideForWrite(path), content);
        return `wrote ${path} (${content.length} bytes)`;
      }),
    },
    {
      name: "list_dir",
      readOnly: true,
      description: "List one directory of the project. Build and dependency directories are skipped.",
      schema: { path: { type: "string", description: "Directory relative to the project root (default the root)" } },
      run: guard("list_dir", ({ path = "." }) =>
        readdirSync(inside(path), { withFileTypes: true })
          .filter((e) => !SKIP_DIRS.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n") || "(empty)"),
    },
    {
      name: "search_files",
      readOnly: true,
      description:
        "Find a string in the project's source, returning file:line for each match. This is how " +
        "you locate a class name, a selector or a component without guessing at paths.",
      schema: {
        query: { type: "string", description: "Plain text to look for (not a regular expression)" },
        extensions: { type: "string", description: "Comma-separated extensions to limit the search, e.g. css,tsx" },
        limit: { type: "number", description: "Most matches to return (default 60)" },
      },
      required: ["query"],
      run: guard("search_files", ({ query, extensions, limit = 60 }) => {
        const exts = (extensions ?? "")
          .split(",")
          .map((e) => e.trim().replace(/^\./, ""))
          .filter(Boolean);
        const hits = [];
        walk(root, (full) => {
          if (hits.length >= limit) return;
          if (exts.length && !exts.includes(full.split(".").pop())) return;
          let body;
          try {
            if (statSync(full).size > MAX_READ) return;
            body = readFileSync(full, "utf8");
          } catch {
            return;
          }
          if (!body.includes(query)) return;
          body.split("\n").forEach((line, i) => {
            if (hits.length < limit && line.includes(query)) {
              hits.push(`${relative(root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        });
        return hits.length ? hits.join("\n") : `no match for ${JSON.stringify(query)}`;
      }),
    },
  ];
}

// ----------------------------------------------------------------- the wires

/** MCP content blocks -> the parts this module passes around: text and PNGs. */
export const normalize = (content) => {
  if (typeof content === "string") return [{ text: content }];
  return (content ?? []).flatMap((b) => {
    if (b.type === "text") return [{ text: b.text }];
    if (b.type === "image") return [{ png: b.data ?? b.source?.data }];
    return [];
  });
};

const schemaOf = (def) => ({
  type: "object",
  properties: def.schema ?? {},
  required: def.required ?? [],
});

export const providers = {
  openai: {
    endpoint: (cfg) => `${cfg.base || "https://api.openai.com/v1"}/chat/completions`,
    headers: (key) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" }),
    body: (model, system, history, defs) => ({
      model,
      messages: [{ role: "system", content: system }, ...history],
      tools: defs.map((d) => ({
        type: "function",
        function: { name: d.name, description: d.description, parameters: schemaOf(d) },
      })),
    }),
    user: (parts) => [{
      role: "user",
      content: parts.map((p) =>
        p.png
          ? { type: "image_url", image_url: { url: `data:image/png;base64,${p.png}` } }
          : { type: "text", text: p.text }),
    }],
    read: (json) => {
      const m = json.choices?.[0]?.message ?? {};
      return {
        text: m.content ?? "",
        calls: (m.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function?.name,
          args: parseArgs(c.function?.arguments),
        })),
        raw: m,
        tokens: json.usage?.prompt_tokens ?? 0,
      };
    },
    assistant: (turn) => [turn.raw],
    // A tool message may only carry text, so images come back as a following user
    // message instead of being dropped.
    result: (call, parts) => {
      const said = parts.filter((p) => p.text).map((p) => p.text).join("\n");
      const shots = parts.filter((p) => p.png);
      const out = [{ role: "tool", tool_call_id: call.id, content: said || "(no text)" }];
      if (shots.length) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: `${shots.length} image(s) returned by ${call.name}:` },
            ...shots.map((p) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${p.png}` } })),
          ],
        });
      }
      return out;
    },
  },

  anthropic: {
    endpoint: (cfg) => `${cfg.base || "https://api.anthropic.com/v1"}/messages`,
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }),
    body: (model, system, history, defs) => ({
      model,
      max_tokens: 8192,
      system,
      messages: history,
      tools: defs.map((d) => ({ name: d.name, description: d.description, input_schema: schemaOf(d) })),
    }),
    user: (parts) => [{
      role: "user",
      content: parts.map((p) =>
        p.png
          ? { type: "image", source: { type: "base64", media_type: "image/png", data: p.png } }
          : { type: "text", text: p.text }),
    }],
    read: (json) => ({
      text: (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""),
      calls: (json.content ?? [])
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      raw: json.content ?? [],
      tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.cache_read_input_tokens ?? 0),
    }),
    assistant: (turn) => [{ role: "assistant", content: turn.raw }],
    // Anthropic takes images inside a tool result, so nothing has to be moved.
    result: (call, parts) => [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: call.id,
        content: parts.map((p) =>
          p.png
            ? { type: "image", source: { type: "base64", media_type: "image/png", data: p.png } }
            : { type: "text", text: p.text }),
      }],
    }],
  },

  gemini: {
    endpoint: (cfg, model) =>
      `${cfg.base || "https://generativelanguage.googleapis.com/v1beta"}` +
      `/models/${model}:generateContent`,
    headers: (key) => ({ "x-goog-api-key": key, "content-type": "application/json" }),
    body: (model, system, history, defs) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: history,
      tools: [{
        functionDeclarations: defs.map((d) => ({
          name: d.name,
          description: d.description,
          parameters: stripEmpty(schemaOf(d)),
        })),
      }],
    }),
    user: (parts) => [{
      role: "user",
      parts: parts.map((p) =>
        p.png ? { inline_data: { mime_type: "image/png", data: p.png } } : { text: p.text }),
    }],
    read: (json) => {
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts.filter((p) => p.text).map((p) => p.text).join(""),
        calls: parts
          .filter((p) => p.functionCall)
          .map((p, i) => ({ id: `${p.functionCall.name}-${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} })),
        raw: parts,
        tokens: json.usageMetadata?.promptTokenCount ?? 0,
      };
    },
    assistant: (turn) => [{ role: "model", parts: turn.raw }],
    result: (call, parts) => {
      const said = parts.filter((p) => p.text).map((p) => p.text).join("\n");
      const shots = parts.filter((p) => p.png);
      const out = [{
        role: "user",
        parts: [{ functionResponse: { name: call.name, response: { result: said || "(no text)" } } }],
      }];
      if (shots.length) {
        out.push({
          role: "user",
          parts: [
            { text: `${shots.length} image(s) returned by ${call.name}:` },
            ...shots.map((p) => ({ inline_data: { mime_type: "image/png", data: p.png } })),
          ],
        });
      }
      return out;
    },
  },
};

const parseArgs = (raw) => {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
};

/** Gemini rejects an empty `properties` and an empty `required`, so drop them. */
function stripEmpty(schema) {
  const out = { ...schema };
  if (!Object.keys(out.properties ?? {}).length) delete out.properties;
  if (!out.required?.length) delete out.required;
  if (!out.properties) out.type = "object";
  return out;
}

// --------------------------------------------------------------- the session

/**
 * One turn-taking session against a provider. The shape it returns is the shape
 * the bridge's built-in session also presents — send, summarize, clear — so the
 * panel's compaction and New-session controls work identically either way.
 */
export function createAdapter({
  config,
  project,
  callPage,
  report = () => {},
  toPanel = () => {},
  record = () => {},
  onUsage = () => {},
  onTurnEnd = () => {},
  log = () => {},
  systemPrompt = "",
  fetchImpl = globalThis.fetch,
}) {
  const name = config.agentProvider ?? "openai";
  const wire = providers[name];
  if (!wire) throw new Error(`unknown provider "${name}" — choose openai, anthropic or gemini`);
  const model = config.agentModel || DEFAULT_MODEL[name];
  const cfg = { base: (config.agentBaseUrl ?? "").replace(/\/$/, "") };

  const defs = [
    ...toolDefinitions(callPage, report, null, (name, file) => countUsages(project, name, file)),
    ...fileTools(project, report),
  ];
  const system =
    `${systemPrompt}\n\n` +
    `You are driving this page through tools over an HTTP API. You also have file tools ` +
    `(read_file, edit_file, write_file, list_dir, search_files) scoped to the project at ` +
    `${project}; use them to commit an approved change to source. Keep replies short: they ` +
    `are read in a small panel beside the app.`;

  let history = [];
  let busy = Promise.resolve();
  const label = `${name}/${model}`;

  async function ask() {
    const res = await fetchImpl(wire.endpoint(cfg, model), {
      method: "POST",
      headers: wire.headers(keyOrThrow()),
      body: JSON.stringify(wire.body(model, system, history, defs)),
    });
    const body = await res.text();
    if (!res.ok) {
      const detail = body.slice(0, 400);
      throw new Error(
        `${label} refused the request (HTTP ${res.status}): ${detail}` +
          (res.status === 404 || /model/i.test(detail)
            ? `\nIf the model name is wrong, set agentModel in .uitalk.json.`
            : ""),
      );
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`${label} returned something that is not JSON: ${body.slice(0, 200)}`);
    }
    return wire.read(json);
  }

  let credential = () => ({ key: null, from: null });
  const keyOrThrow = () => {
    const { key } = credential(name);
    if (key) return key;
    // A custom base URL means the request is not going to the vendor's own API — a
    // local or self-hosted server (llama.cpp, Ollama, an internal gateway) commonly
    // takes no key at all, so send a placeholder rather than refuse to even try.
    if (cfg.base) return "not-required";
    throw new Error(
      `no API key for ${name}. Put it in the environment (UITALK_API_KEY) or in ` +
        `~/.uitalk/credentials.json as {"${name}": "sk-..."}.`,
    );
  };

  /** One user message, then tools until the model stops asking for them. */
  async function turn(content, { quiet = false } = {}) {
    history.push(...wire.user(normalize(content)));
    let said = "";

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const out = await ask();
      if (out.tokens) onUsage(out.tokens);
      history.push(...wire.assistant(out));
      if (out.text) said += (said ? "\n" : "") + out.text;

      if (!out.calls.length) break;

      for (const call of out.calls) {
        if (!quiet) toPanel({ kind: "tool", name: call.name });
        const def = defs.find((d) => d.name === call.name);
        const result = def
          ? await def.run(call.args).catch((err) => failed(err))
          : { content: [{ type: "text", text: `There is no tool called ${call.name}.` }], isError: true };
        history.push(...wire.result(call, normalize(result.content)));
      }

      if (round === MAX_ROUNDS - 1) {
        said += `\n[stopped after ${MAX_ROUNDS} rounds of tool calls]`;
      }
    }
    return said.trim();
  }

  /** Serialized: a second message arriving mid-turn waits rather than interleaving. */
  const queue = (fn) => (busy = busy.then(fn, fn));

  return {
    mode: "adapter",
    label,
    provider: name,
    model,
    tools: defs.map((d) => d.name),

    /** Wired to the credential lookup by the bridge, so this module reads no files itself. */
    useCredentials(fn) {
      credential = fn;
    },

    start() {
      toPanel({ kind: "status", text: `ready · ${label}` });
      log(`adapter session ready: ${label} (${defs.length} tools)`);
    },

    send(content) {
      queue(async () => {
        try {
          const said = await turn(content);
          if (said) {
            toPanel({ kind: "delta", text: said });
            record("agent", said);
          }
          toPanel({ kind: "turn_end" });
          onTurnEnd();
        } catch (err) {
          log(`adapter turn failed: ${err.message}`);
          toPanel({ kind: "error", text: err.message });
          toPanel({ kind: "turn_end", text: "error" });
          // A failed turn may still have written files before it errored — the
          // undo snapshot's post-edit capture needs to run here too, or a revert
          // after a partial failure falls back to the coarser whole-file behavior
          // right when the safer, scoped one matters most.
          onTurnEnd();
        }
      });
    },

    /** The handover note compaction needs. Asked for without showing it as chat. */
    summarize(request) {
      return queue(() => turn(request, { quiet: true }));
    },

    /** Nothing to send anywhere: the conversation is this array. */
    clear() {
      return queue(() => {
        history = [];
      });
    },

    // For the tests: the history is the whole state.
    size: () => history.length,
  };
}
