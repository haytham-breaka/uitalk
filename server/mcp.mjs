#!/usr/bin/env node
// The page, as a standalone MCP server, for editors that are not Claude Code.
//
// The built-in session drives the same tools in-process. This exposes them over
// stdio instead, so Cursor, Cline, Windsurf, Zed, Continue — anything that speaks
// MCP — can select elements, capture, preview and offer variants.
//
// One thing does not survive the change of shape. In the built-in session the user's
// choice of variant arrives as a *message*; MCP is request/response and a server
// cannot push one. So `await_choice` blocks until they pick, and clients are told to
// call it after show_options.

import { WebSocket } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { toolDefinitions, text, failed } from "./tool-defs.mjs";
import * as registry from "./registry.mjs";
import { isFrame } from "./protocol.mjs";
import { projectToken } from "./token.mjs";
import { countUsages } from "./usage.mjs";
import { findSourceCandidates } from "./candidates.mjs";

const PORT = Number(process.env.UITALK_PORT ?? 0);
const PROJECT = process.env.UITALK_PROJECT ?? process.cwd();

/**
 * A project path in the one form two spellings of the same directory share:
 * symlinks resolved, relative made absolute, trailing separator dropped. On
 * Windows the filesystem is case-insensitive, so the drive letter and the rest
 * are lowercased there too. realpathSync needs the path to exist; a path that
 * does not (a stale registry entry, say) still normalizes enough to compare.
 */
export function canonical(p) {
  let out;
  try {
    out = realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    out = resolve(p);
  }
  return process.platform === "win32" ? out.toLowerCase() : out;
}

/**
 * The bridge to talk to: an explicit port wins outright; otherwise only the
 * bridge serving *this* project, never someone else's. The registry is built
 * for several projects at once, so connecting to whichever happened to start
 * first would leave the file tools on this project and the page tools on an
 * unrelated app — the confusing split this refuses to create.
 */
// The socket is token-gated — the bridge rejects EVERY connection without the
// correct per-project capability token. The token is derived from a project path,
// so we need one to connect: the registry entry's project when we can find it,
// otherwise UITALK_PROJECT (which, when it matches the bridge's own project, yields
// the same token). A wrong or absent project yields a token the bridge refuses,
// which is correct — that connection was never authorized.
const socketFor = (port, project) => {
  const token = project ? projectToken(project) : null;
  return `ws://127.0.0.1:${port}/__uitalk/socket${token ? `?token=${token}` : ""}`;
};

export function bridgeUrl({ port = PORT, project = PROJECT } = {}) {
  const running = registry.list();
  if (port) {
    // Explicit port wins, but still needs a token. Prefer the registered project
    // for that port; fall back to UITALK_PROJECT so an explicit port to a bridge
    // not (yet) in the registry can still authenticate when the project matches.
    const entry = running.find((e) => e.port === port);
    return socketFor(port, entry?.project ?? project);
  }
  const me = canonical(project);
  const mine = running.find((e) => canonical(e.project) === me);
  if (!mine) {
    const elsewhere = running.map((e) => `${e.project} (:${e.port})`).join(", ");
    throw new Error(
      `no uitalk is running for ${project}. Start one in your project first:\n` +
        `  uitalk --dev "npm run dev"` +
        (running.length ? `\n(running elsewhere: ${elsewhere})` : ""),
    );
  }
  return socketFor(mine.port, mine.project);
}

// ------------------------------------------------------------ the page link

let socket = null;
let seq = 0;
const pending = new Map();
const choices = [];
const waitingForChoice = [];
const answers = [];
const waitingForAnswer = [];
// Things that happened in the page which this client has to know about but cannot be
// told: it is a server, nothing can call it. They ride out on the next tool result.
const NOTICE_CAP = 64; // most recent bridge notices held for the next tool result
const notices = [];

function connect() {
  const url = bridgeUrl();
  // Bind every handler to THIS socket instance, and guard each on `socket === s`,
  // so a socket that is superseded by a reconnect can neither process a frame nor
  // (on close) null out or drain the state that now belongs to its replacement.
  const s = new WebSocket(url);
  socket = s;

  s.on("message", (raw) => {
    if (socket !== s) return;
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isFrame(frame)) return;

    if (frame.kind === "call_result") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.error) entry.reject(new Error(frame.error));
      else entry.resolve(frame.result);
      return;
    }

    // Reverts and new sessions are pushed to the built-in agent. Queued here instead,
    // so a client does not re-apply an edit the user has just undone.
    if (frame.kind === "notice" && frame.text) {
      notices.push(frame.text);
      // Flushed on the next tool result; a client that receives notices but never
      // calls another tool would otherwise let this grow without bound. Keep the
      // most recent, dropping the oldest — a stale revert notice is the least useful.
      if (notices.length > NOTICE_CAP) notices.shift();
      return;
    }

    // An approval is a message in the built-in session; here it is the answer to a
    // blocking call, so hold it until something asks.
    if (frame.kind === "approval") {
      const waiter = waitingForChoice.shift();
      if (waiter) waiter(frame);
      else choices.push(frame);
    }

    // ask_choice's answer, the same way: a plain reply held for await_answer rather
    // than pushed, since there is nothing here to push it to.
    if (frame.kind === "choice_answer") {
      const waiter = waitingForAnswer.shift();
      if (waiter) waiter(frame);
      else answers.push(frame);
    }
  });

  s.on("close", () => {
    if (socket !== s) return; // a stale socket's close must not disturb the live one
    socket = null;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("the bridge disconnected"));
      pending.delete(id);
    }
    // A blocking await_choice/await_answer would otherwise hang until its own
    // timeout (up to 15 min) after the bridge drops, and the parked waiter would
    // still be there to catch an unrelated answer after a reconnect. Resolve them
    // now, the way a timeout does.
    for (const wake of waitingForChoice.splice(0)) wake(null);
    for (const wake of waitingForAnswer.splice(0)) wake(null);
    // Drop queued-but-unclaimed picks too: they belong to the bridge session that
    // just ended. Kept, a stale approval/answer from before the disconnect would be
    // handed to the first await_* after a reconnect — an answer to a question that
    // bridge session is no longer showing. The waiters above are cleared for the same
    // reason; the queues need the same treatment or the staleness just moves here.
    choices.length = 0;
    answers.length = 0;
  });
  s.on("error", () => {});

  return new Promise((resolve, reject) => {
    s.once("open", () => {
      // Identify as an agent, not a page: the bridge must not route page questions
      // here, and approvals have to be relayed to us because MCP cannot be pushed to.
      s.send(JSON.stringify({ kind: "hello", role: "agent" }));
      resolve();
    });
    s.once("error", () => reject(new Error(`could not reach the bridge at ${url}`)));
  });
}

// One connection attempt at a time: concurrent callers await the same connect
// rather than each racing to create (and overwrite) the global socket, which left
// a caller sending on a socket that was replaced and possibly not yet open.
let connecting = null;
async function ready() {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  return connecting;
}

async function callPage(method, params = {}, timeoutMs = 5000) {
  await ready();
  const id = ++seq;
  // The bridge owns the link to the page, so it relays on our behalf.
  socket.send(JSON.stringify({ kind: "call", id, method, params, timeout: timeoutMs }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

// ------------------------------------------------------------- the MCP face

const defs = toolDefinitions(
  callPage,
  () => {},
  null,
  (name, file) => countUsages(PROJECT, name, file),
  (needles) => findSourceCandidates(PROJECT, needles),
);

// Request/response cannot receive an unsolicited choice, so it has to be asked for.
defs.push({
  name: "await_choice",
  readOnly: true,
  description:
    "Wait for the user to approve one of the alternatives you mounted with show_options, and " +
    "return which they picked along with its CSS and the element's identifiers. Call this " +
    "straight after show_options. It blocks until they choose or the timeout passes — your " +
    "client cannot be sent a message, so this is how their answer reaches you. Once you have " +
    "committed the approved change to source, call note_edit so the user can undo it.",
  schema: {
    timeout: { type: "number", description: "Give up after this many milliseconds (default 300000)" },
  },
  run: async (args) => {
    await ready();
    const queued = choices.shift();
    if (queued) return text(queued);

    const waited = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = waitingForChoice.indexOf(hand);
        if (i !== -1) waitingForChoice.splice(i, 1);
        resolve(null);
      }, Math.min(Math.max(args.timeout ?? 300000, 1000), 900000));
      const hand = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waitingForChoice.push(hand);
    });

    return waited
      ? text(waited)
      : text({ chose: null, note: "the user did not pick anything before the timeout" });
  },
});

// The same gap, for ask_choice: a plain multiple-choice question rather than a
// CSS comparison.
defs.push({
  name: "await_answer",
  readOnly: true,
  description:
    "Wait for the user to tap one of the options you asked with ask_choice, and return what " +
    "they picked. Call this straight after ask_choice. It blocks until they answer or the " +
    "timeout passes — your client cannot be sent a message, so this is how their answer " +
    "reaches you.",
  schema: {
    timeout: { type: "number", description: "Give up after this many milliseconds (default 300000)" },
  },
  run: async (args) => {
    await ready();
    const queued = answers.shift();
    if (queued) return text(queued);

    const waited = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = waitingForAnswer.indexOf(hand);
        if (i !== -1) waitingForAnswer.splice(i, 1);
        resolve(null);
      }, Math.min(Math.max(args.timeout ?? 300000, 1000), 900000));
      const hand = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waitingForAnswer.push(hand);
    });

    return waited
      ? text(waited)
      : text({ chose: null, note: "the user did not answer before the timeout" });
  },
});

// A built-in/adapter session ends a turn, which is when uitalk freezes the
// post-edit state that makes an approved change undoable. Over MCP the edit
// happens in the client's own editor, invisible to the bridge, so the client has
// to say when it is done — otherwise undo has nothing to scope to and declines.
defs.push({
  name: "note_edit",
  readOnly: true,
  description:
    "Call this once you have committed an approved change (from await_choice) to source. It lets " +
    "uitalk record the post-edit state so the user can undo the change, and tell a later edit of " +
    "theirs apart from yours. Pass `files` — the project-relative paths you changed for this " +
    "approval — so undo scopes to exactly those; omit it and undo falls back to the whole diff " +
    "since the change was approved. Call it after each approved change you write.",
  schema: {
    files: {
      type: "array",
      items: { type: "string" },
      description: "The paths you changed for this approved change, project-relative (optional but preferred).",
    },
  },
  run: async ({ files } = {}) => {
    await ready();
    const scoped = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f) : undefined;
    socket.send(JSON.stringify({ kind: "note_edit", files: scoped }));
    return text({ ok: true, note: "post-edit state recorded; the user can undo this change" });
  },
});

// A newly mounted question supersedes any earlier one: show_options and ask_choice
// replace what is on screen, so the previous question can no longer be answered.
// Two kinds of stale state have to go, or the next answer resolves the wrong
// request: (1) a queued approval/answer left by an await_* that already timed out,
// and (2) an await_* STILL blocking on the previous question — its parked waiter
// would otherwise catch the new question's answer (show A, await A, show B, approve
// B → A's await returns B's pick). Cancel the waiter (resolve it null, a "nothing
// picked") so only a fresh await_* for the new question can receive its answer.
// Only ever runs for MCP: these queues and the await_* tools exist nowhere else.
const supersedes = (name, queue, waiters) => {
  const def = defs.find((d) => d.name === name);
  const inner = def.run;
  def.run = (args) => {
    queue.length = 0;
    for (const wake of waiters.splice(0)) wake(null);
    return inner(args);
  };
};
supersedes("show_options", choices, waitingForChoice);
supersedes("ask_choice", answers, waitingForAnswer);

const asJsonSchema = (def) => ({
  type: "object",
  properties: def.schema ?? {},
  required: def.required ?? [],
  additionalProperties: false,
});

const server = new Server(
  { name: "uitalk", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: asJsonSchema(d),
    annotations: { readOnlyHint: Boolean(d.readOnly) },
  })),
}));

/** Prepend anything the page has to tell this client, then empty the queue. */
function withNotices(result) {
  if (!notices.length) return result;
  const heads = notices.splice(0).map((text) => ({ type: "text", text: `[uitalk] ${text}` }));
  return { ...result, content: [...heads, ...(result.content ?? [])] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const def = defs.find((d) => d.name === request.params.name);
  if (!def) return failed(new Error(`unknown tool ${request.params.name}`));
  try {
    return withNotices(await def.run(request.params.arguments ?? {}));
  } catch (err) {
    return withNotices(failed(err));
  }
});

// Importing this module for a test must not hijack stdio with a live MCP server.
if (process.env.UITALK_IMPORT_ONLY !== "1") {
  await server.connect(new StdioServerTransport());
}
