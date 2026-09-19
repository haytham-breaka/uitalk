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
import { toolDefinitions, text, failed } from "./tool-defs.mjs";
import * as registry from "./registry.mjs";
import { countUsages } from "./usage.mjs";

const PORT = Number(process.env.UITALK_PORT ?? 0);
const PROJECT = process.env.UITALK_PROJECT ?? process.cwd();

/** Find the bridge to talk to: an explicit port, or the one serving this project. */
function bridgeUrl() {
  if (PORT) return `ws://127.0.0.1:${PORT}/__uitalk/socket`;
  const mine = registry.list().find((e) => e.project === PROJECT) ?? registry.list()[0];
  if (!mine) {
    throw new Error(
      "no uitalk is running. Start one in your project first:\n" +
        "  uitalk --dev \"npm run dev\"",
    );
  }
  return `ws://127.0.0.1:${mine.port}/__uitalk/socket`;
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
const notices = [];

function connect() {
  const url = bridgeUrl();
  socket = new WebSocket(url);

  socket.on("message", (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

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

  socket.on("close", () => {
    socket = null;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("the bridge disconnected"));
      pending.delete(id);
    }
  });
  socket.on("error", () => {});

  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      // Identify as an agent, not a page: the bridge must not route page questions
      // here, and approvals have to be relayed to us because MCP cannot be pushed to.
      socket.send(JSON.stringify({ kind: "hello", role: "agent" }));
      resolve();
    });
    socket.once("error", () => reject(new Error(`could not reach the bridge at ${url}`)));
  });
}

async function ready() {
  if (socket?.readyState === WebSocket.OPEN) return;
  await connect();
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

const defs = toolDefinitions(callPage, () => {}, null, (name, file) => countUsages(PROJECT, name, file));

// Request/response cannot receive an unsolicited choice, so it has to be asked for.
defs.push({
  name: "await_choice",
  readOnly: true,
  description:
    "Wait for the user to approve one of the alternatives you mounted with show_options, and " +
    "return which they picked along with its CSS and the element's identifiers. Call this " +
    "straight after show_options. It blocks until they choose or the timeout passes — your " +
    "client cannot be sent a message, so this is how their answer reaches you.",
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

await server.connect(new StdioServerTransport());
