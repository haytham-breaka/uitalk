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

import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync, existsSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, relative, join, dirname, sep, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { toolDefinitions, text, failed } from "./tool-defs.mjs";
import { countUsages } from "./usage.mjs";
import { findSourceCandidates } from "./candidates.mjs";

const DEFAULT_MODEL = {
  openai: "gpt-5",
  anthropic: "claude-opus-5",
  gemini: "gemini-2.5-pro",
};

const MAX_ROUNDS = 24; // a turn that calls tools forever is a bug, not a long task
const MAX_READ = 120_000; // bytes of one file, so a bundle cannot fill the window
const SEARCH_CHUNK = 64 * 1024; // how much of an oversized file to read at a time when searching
const MAX_SEARCH_BYTES = 5 * 1024 * 1024; // stream-search a big file up to here; past it, report it skipped
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".cov"]);

/**
 * Search a file too big to read whole (see MAX_READ) without loading it into memory
 * or the model's context: read it in fixed chunks, decode across chunk boundaries,
 * and hand each matching line to onMatch(lineNumber, line) — searching does not need
 * read_file's context-size limit, only its own bounded memory. Returns "ok",
 * "binary" (a NUL byte — not text, skip silently) or "too-large" (past
 * MAX_SEARCH_BYTES — reported skipped so a match there is never read as "no match").
 * onMatch returns false to stop early (the caller's match limit is reached).
 */
function searchStreaming(full, query, onMatch) {
  const fd = openSync(full, "r");
  try {
    const buf = Buffer.allocUnsafe(SEARCH_CHUNK);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let lineNo = 0;
    let scanned = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, SEARCH_CHUNK, null);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      if (chunk.includes(0)) return "binary"; // a NUL byte means it isn't text
      scanned += n;
      if (scanned > MAX_SEARCH_BYTES) return "too-large";
      const parts = (carry + decoder.write(chunk)).split("\n");
      carry = parts.pop(); // a partial final line carries into the next chunk
      for (const line of parts) {
        lineNo++;
        if (line.includes(query) && onMatch(lineNo, line) === false) return "ok";
      }
    }
    carry += decoder.end();
    if (carry) {
      lineNo++;
      if (carry.includes(query)) onMatch(lineNo, carry);
    }
    return "ok";
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------- the file tools

/**
 * Editing source is the whole point of an approval, so the adapter needs its own
 * file tools. Every path is resolved and checked to be inside the project: a model
 * asking for ../../.ssh/id_rsa gets a refusal, not a read.
 */
export function fileTools(project, report = () => {}, onWrite = () => {}) {
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

  // Does a filesystem entry exist at this exact path — following NO symlink? A
  // dangling symlink (its target missing) is an entry here, though existsSync,
  // which follows the link, says it is not; writeFileSync would still follow it
  // and create the target, so it must count as present and be resolved.
  const entryExists = (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  // write_file can create a path that doesn't exist yet, so there is nothing at
  // `full` to realpath. Walk up to the nearest ancestor that does exist — a
  // symlinked directory anywhere on the way there is exactly as much an escape
  // as a symlinked file would be — and check that instead. If `full` itself
  // already exists (overwriting a file, or a symlink writeFileSync would follow),
  // that ancestor search starts, and ends, at `full`. A dangling symlink can't be
  // realpath'd — where it would land is unknowable — so refuse rather than follow it.
  const insideForWrite = (path) => {
    const full = lexicallyInside(path);
    let check = full;
    while (!entryExists(check)) check = dirname(check);
    let real;
    try {
      real = realpathSync(check);
    } catch {
      throw outside(path); // a dangling symlink on the path: writeFileSync would follow it out
    }
    if (!withinRoot(real)) throw outside(path);
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
        onWrite(path); // so undo can scope to what the agent actually wrote
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
        onWrite(path); // so undo can scope to what the agent actually wrote
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
        const tooLarge = [];
        const record = (full, lineNo, line) => hits.push(`${relative(root, full)}:${lineNo}: ${line.trim().slice(0, 200)}`);
        walk(root, (full) => {
          if (hits.length >= limit) return;
          if (exts.length && !exts.includes(full.split(".").pop())) return;
          let size;
          try {
            size = statSync(full).size;
          } catch {
            return;
          }
          if (size <= MAX_READ) {
            let body;
            try {
              body = readFileSync(full, "utf8");
            } catch {
              return;
            }
            if (body.includes(" ") || !body.includes(query)) return; // skip binary; skip a non-match cheaply
            body.split("\n").forEach((line, i) => {
              if (hits.length < limit && line.includes(query)) record(full, i + 1, line);
            });
            return;
          }
          // An oversized file was silently skipped before, so a match in a big
          // source/config/style file read as "no match". Stream it instead, bounded.
          let outcome;
          try {
            outcome = searchStreaming(full, query, (lineNo, line) => {
              if (hits.length >= limit) return false;
              record(full, lineNo, line);
              return hits.length < limit;
            });
          } catch {
            return;
          }
          if (outcome === "too-large") tooLarge.push(relative(root, full));
        });
        const out = hits.length ? [...hits] : [`no match for ${JSON.stringify(query)}`];
        if (tooLarge.length) {
          // Never let a file that couldn't be searched masquerade as "no match".
          out.push(`[not searched — too large (> ${Math.round(MAX_SEARCH_BYTES / 1024 / 1024)}MB): ${tooLarge.slice(0, 10).join(", ")}${tooLarge.length > 10 ? ", …" : ""}]`);
        }
        return out.join("\n");
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
  onWrite = () => {},
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
    ...toolDefinitions(
      callPage,
      report,
      null,
      (name, file) => countUsages(project, name, file),
      (needles) => findSourceCandidates(project, needles),
    ),
    ...fileTools(project, report, onWrite),
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
  let chatTurns = 0; // ordinary send() turns in flight (not summarize/clear)
  const queue = (fn) => (busy = busy.then(fn, fn));

  return {
    mode: "adapter",
    label,
    provider: name,
    model,
    tools: defs.map((d) => d.name),

    /** Whether an ordinary chat turn is being processed right now — so the bridge
     * can hold an approval that arrives mid-turn rather than snapshotting against
     * it. summarize()/clear() are excluded: they don't run the post-edit capture. */
    busy: () => chatTurns > 0,

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
        chatTurns++;
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
        } finally {
          chatTurns--;
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
