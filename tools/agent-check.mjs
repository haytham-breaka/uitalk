// Who answers the panel: the adapter's loop and wires, and the bridge's behaviour
// when the answer is "nobody". Offline — the only HTTP is a fake fetch, so this
// costs nothing and needs no key.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createAdapter, fileTools, providers, normalize } from "../server/adapter.mjs";

const fail = [];
const check = (n, ok, d) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail.push(n);
};

// --------------------------------------------------------------- file tools

{
  const root = mkdtempSync(join(tmpdir(), "uitalk-files-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "src", "app.css"), ".hero {\n  padding: 14px;\n}\n.card { gap: 8px; }\n");
  writeFileSync(join(root, "node_modules", "huge.css"), ".hero { padding: 999px; }\n");

  const tools = Object.fromEntries(fileTools(root).map((t) => [t.name, t]));
  const ran = (name, args) => tools[name].run(args).then((r) => ({
    text: r.content.map((c) => c.text).join("\n"),
    failed: Boolean(r.isError),
  }));

  check("the adapter gets file tools, because an approval has to reach source",
    Object.keys(tools).join(",") === "read_file,edit_file,write_file,list_dir,search_files",
    Object.keys(tools).join(","));

  const read = await ran("read_file", { path: "src/app.css" });
  check("read_file returns the file", read.text.includes("padding: 14px"), read.text.split("\n")[0]);

  const escape = await ran("read_file", { path: "../../../etc/passwd" });
  check("a path outside the project is refused, not read",
    escape.failed && /outside the project/.test(escape.text), escape.text.slice(0, 70));

  const edited = await ran("edit_file", { path: "src/app.css", find: "padding: 14px", replace: "padding: 20px" });
  check("edit_file replaces an exact span", !edited.failed &&
    readFileSync(join(root, "src/app.css"), "utf8").includes("padding: 20px"), edited.text);

  const missing = await ran("edit_file", { path: "src/app.css", find: "padding: 14px", replace: "x" });
  check("text that is no longer there is an error, not a silent no-op",
    missing.failed && /not in/.test(missing.text), missing.text.slice(0, 60));

  writeFileSync(join(root, "src", "dup.css"), ".a { gap: 8px; }\n.b { gap: 8px; }\n");
  const ambiguous = await ran("edit_file", { path: "src/dup.css", find: "gap: 8px", replace: "gap: 9px" });
  check("an ambiguous edit is refused rather than guessing which one",
    ambiguous.failed && /appears 2 times/.test(ambiguous.text), ambiguous.text.slice(0, 60));

  const listed = await ran("list_dir", {});
  check("list_dir hides node_modules", !listed.text.includes("node_modules") && listed.text.includes("src/"),
    listed.text.replace(/\n/g, " "));

  const found = await ran("search_files", { query: "gap", extensions: "css" });
  check("search_files reports file:line for each match",
    /^src\/(app|dup)\.css:\d+: /m.test(found.text), found.text.split("\n")[0]);
  check("and it does not search dependencies", !found.text.includes("node_modules"),
    found.text.includes("node_modules") ? "node_modules leaked in" : "dependencies skipped");

  const nothing = await ran("search_files", { query: "zzz-not-here" });
  check("a search with no match says so plainly", /no match/.test(nothing.text), nothing.text);
}

// ------------------------------------------------------------------- wires

{
  const parts = normalize([
    { type: "text", text: "two frames" },
    { type: "image", data: "AAA" },
    { type: "resource", uri: "x" },
  ]);
  check("MCP content becomes text and PNG parts, dropping what no provider takes",
    parts.length === 2 && parts[0].text === "two frames" && parts[1].png === "AAA",
    JSON.stringify(parts));

  const defs = [{ name: "capture", description: "shoot it", schema: { ref: { type: "number" } } }];
  const history = [{ role: "user", content: "hi" }];

  const oa = providers.openai.body("gpt-5", "SYS", history, defs);
  check("openai takes the system prompt as a message and tools under function",
    oa.messages[0].role === "system" && oa.tools[0].function.name === "capture",
    `${oa.messages[0].role} / ${oa.tools[0].type}`);

  const an = providers.anthropic.body("claude-opus-5", "SYS", history, defs);
  check("anthropic takes system at the top level and input_schema per tool",
    an.system === "SYS" && Boolean(an.tools[0].input_schema) && an.max_tokens > 0,
    `system=${typeof an.system} schema=${Boolean(an.tools[0].input_schema)}`);

  const ge = providers.gemini.body("gemini-2.5-pro", "SYS", history, defs);
  check("gemini takes systemInstruction and functionDeclarations",
    ge.systemInstruction.parts[0].text === "SYS" && ge.tools[0].functionDeclarations[0].name === "capture",
    JSON.stringify(ge.tools[0].functionDeclarations[0].name));

  const empty = providers.gemini.body("m", "S", history, [{ name: "read_selection", description: "d", schema: {} }]);
  const decl = empty.tools[0].functionDeclarations[0];
  check("a no-argument tool carries no empty properties, which gemini rejects",
    !("properties" in decl.parameters) && !("required" in decl.parameters),
    JSON.stringify(decl.parameters));

  // The one real difference between the three: where an image may appear.
  const call = { id: "c1", name: "capture" };
  const shot = [{ text: "Frame 1" }, { png: "PNGDATA" }];

  const oaRes = providers.openai.result(call, shot);
  check("openai cannot put an image in a tool result, so it follows as a user message",
    oaRes.length === 2 && oaRes[0].role === "tool" && oaRes[1].role === "user" &&
      oaRes[1].content.some((c) => c.type === "image_url"),
    oaRes.map((m) => m.role).join(" then "));

  const anRes = providers.anthropic.result(call, shot);
  check("anthropic takes the image inside the tool result, so nothing is moved",
    anRes.length === 1 && anRes[0].content[0].content.some((c) => c.type === "image"),
    `${anRes.length} message(s)`);

  const geRes = providers.gemini.result(call, shot);
  check("gemini answers with functionResponse and carries the image separately",
    geRes[0].parts[0].functionResponse.name === "capture" &&
      geRes[1].parts.some((p) => p.inline_data),
    geRes.map((m) => (m.parts[0].functionResponse ? "functionResponse" : "inline_data")).join(" then "));

  const userParts = providers.openai.user([{ text: "look" }, { png: "Z" }]);
  check("a screenshot reaches openai as a data URI",
    userParts[0].content[1].image_url.url.startsWith("data:image/png;base64,Z"),
    userParts[0].content[1].image_url.url.slice(0, 30));
}

// --------------------------------------------------------------- the loop

/** A provider that answers from a script, and records what it was sent. */
function fakeProvider(script) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const next = script.shift() ?? { choices: [{ message: { role: "assistant", content: "done" } }] };
    if (next.status) return { ok: false, status: next.status, text: async () => next.body ?? "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  return { sent, fetchImpl };
}

const toolCall = (name, args = {}) => ({
  choices: [{
    message: {
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
  }],
  usage: { prompt_tokens: 1234 },
});

const said = (text, tokens = 2000) => ({
  choices: [{ message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: tokens },
});

const settle = () => new Promise((r) => setTimeout(r, 30));

{
  const { sent, fetchImpl } = fakeProvider([toolCall("read_selection"), said("Element 1 is 8px lower.")]);
  const asked = [];
  const panel = [];
  const usage = [];
  let turns = 0;

  const adapter = createAdapter({
    config: { agent: "adapter", agentProvider: "openai", agentModel: "test-model" },
    project: process.cwd(),
    callPage: async (method) => {
      asked.push(method);
      return { selected: 1 };
    },
    toPanel: (f) => panel.push(f),
    onUsage: (t) => usage.push(t),
    onTurnEnd: () => turns++,
    fetchImpl,
  });
  adapter.useCredentials(() => ({ key: "test-key", from: "$TEST" }));

  check("the adapter reports which model is answering", adapter.label === "openai/test-model", adapter.label);
  check("it offers the page tools and the file tools together",
    adapter.tools.includes("read_selection") && adapter.tools.includes("edit_file"),
    `${adapter.tools.length} tools`);

  adapter.send([{ type: "text", text: "why is element 1 low?" }]);
  await settle();

  check("a tool call from the model reaches the page", asked.join(",") === "readSelection", asked.join(","));
  check("the model's answer is shown in the panel",
    panel.some((f) => f.kind === "delta" && f.text.includes("8px lower")),
    panel.map((f) => f.kind).join(","));
  check("the tool it called is named in the panel while it works",
    panel.some((f) => f.kind === "tool" && f.name === "read_selection"),
    panel.filter((f) => f.kind === "tool").map((f) => f.name).join(","));
  check("the turn ends, so the panel stops waiting", panel.at(-1).kind === "turn_end", panel.at(-1).kind);
  check("prompt tokens feed the same context meter the built-in session uses",
    usage.join(",") === "1234,2000", usage.join(","));
  check("a finished turn is what triggers compaction, not each round of tools",
    turns === 1, `${turns} turn(s) for 2 requests`);
  check("the key goes in the provider's own auth header",
    sent[0].url.includes("api.openai.com") && sent[0].body.model === "test-model",
    sent[0].url);
  check("the tool result is sent back before the second request",
    sent[1].body.messages.some((m) => m.role === "tool"),
    sent[1].body.messages.map((m) => m.role).join(","));
}

{
  // An HTTP error has to name the model and say where to change it: a bad model name
  // is the likeliest first-run failure and the message is all the user gets.
  const { fetchImpl } = fakeProvider([{ status: 404, body: '{"error":{"message":"model not found"}}' }]);
  const panel = [];
  const adapter = createAdapter({
    config: { agentProvider: "openai", agentModel: "nope-5" },
    project: process.cwd(),
    callPage: async () => ({}),
    toPanel: (f) => panel.push(f),
    fetchImpl,
  });
  adapter.useCredentials(() => ({ key: "k", from: "$TEST" }));
  adapter.send("hello");
  await settle();
  const err = panel.find((f) => f.kind === "error");
  check("a refused request is reported with the status and a way forward",
    Boolean(err) && /HTTP 404/.test(err.text) && /agentModel/.test(err.text),
    err?.text?.slice(0, 90) ?? "no error frame");
  check("and the turn still ends, so the panel is not left spinning",
    panel.at(-1).kind === "turn_end", panel.at(-1).kind);
}

{
  const { fetchImpl } = fakeProvider([said("hi")]);
  const panel = [];
  const adapter = createAdapter({
    config: { agentProvider: "openai" },
    project: process.cwd(),
    callPage: async () => ({}),
    toPanel: (f) => panel.push(f),
    fetchImpl,
  });
  adapter.send("hello"); // no useCredentials: nothing has supplied a key
  await settle();
  const err = panel.find((f) => f.kind === "error");
  check("with no key the message says exactly where to put one",
    /UITALK_API_KEY/.test(err?.text ?? "") && /credentials\.json/.test(err?.text ?? ""),
    err?.text?.slice(0, 80) ?? "no error frame");
}

{
  // Compaction against an adapter: the summary is asked for without appearing as
  // chat, and clearing is just dropping the array.
  const { fetchImpl } = fakeProvider([said("notes to self"), said("after")]);
  const panel = [];
  const recorded = [];
  const adapter = createAdapter({
    config: { agentProvider: "openai" },
    project: process.cwd(),
    callPage: async () => ({}),
    toPanel: (f) => panel.push(f),
    record: (role, text) => recorded.push(`${role}: ${text}`),
    fetchImpl,
  });
  adapter.useCredentials(() => ({ key: "k", from: "$TEST" }));

  const summary = await adapter.summarize("write a handover note");
  check("summarize returns the note itself", summary === "notes to self", JSON.stringify(summary));
  check("and it is not shown as a reply in the panel",
    !panel.some((f) => f.kind === "delta") && !recorded.length,
    `${panel.length} panel frame(s), ${recorded.length} recorded`);

  const before = adapter.size();
  await adapter.clear();
  check("clearing drops the conversation, which is all the adapter's context is",
    before > 0 && adapter.size() === 0, `${before} -> ${adapter.size()}`);
}

{
  const { fetchImpl } = fakeProvider([toolCall("no_such_tool")]);
  const panel = [];
  const adapter = createAdapter({
    config: { agentProvider: "openai" },
    project: process.cwd(),
    callPage: async () => ({}),
    toPanel: (f) => panel.push(f),
    fetchImpl,
  });
  adapter.useCredentials(() => ({ key: "k", from: "$TEST" }));
  adapter.send("go");
  await settle();
  check("a tool the model invented is answered, not thrown",
    panel.at(-1).kind === "turn_end" && !panel.some((f) => f.kind === "error"),
    panel.map((f) => f.kind).join(","));
}

// ------------------------------------------- the bridge with nobody answering

{
  const bridge = spawn("node", ["-e", `
    process.env.UITALK_IMPORT_ONLY = "1";
    const { wss } = await import("./server/index.mjs");
    const { createServer } = await import("node:http");
    const http = createServer((req, res) => res.end("ok"));
    http.on("upgrade", (req, socket, head) => {
      if (req.url !== "/__uitalk/socket") return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    process.on("SIGTERM", () => process.exit(0));
    http.listen(0, "127.0.0.1", () => console.log("PORT " + http.address().port));
  `], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, UITALK_IMPORT_ONLY: "1", UITALK_AGENT: "off" } });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    bridge.stdout.on("data", (d) => {
      buf += d;
      const m = /PORT (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    bridge.stderr.on("data", (d) => reject(new Error(String(d).slice(0, 300))));
    setTimeout(() => reject(new Error("the agentless bridge never started")), 8000);
  });

  const frames = [];
  const page = new WebSocket(`ws://127.0.0.1:${port}/__uitalk/socket`);
  page.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r) => page.on("open", r));

  const agentFrames = [];
  const mcpish = new WebSocket(`ws://127.0.0.1:${port}/__uitalk/socket`);
  mcpish.on("message", (raw) => agentFrames.push(JSON.parse(raw.toString())));
  await new Promise((r) => mcpish.on("open", r));
  mcpish.send(JSON.stringify({ kind: "hello", role: "agent" }));
  await settle();

  const ready = frames.find((f) => f.kind === "ready");
  check("the page is told which mode it connected to, before it draws itself",
    ready?.agent?.mode === "off" && /MCP/.test(ready.agent.of ?? ""),
    JSON.stringify(ready?.agent));
  check("the agent mode is a setting, so a project can hold it",
    ready?.fields?.agent?.choices?.join(",") === "builtin,adapter,off" && ready.fields.agent.restart === true,
    JSON.stringify(ready?.fields?.agent?.choices));

  page.send(JSON.stringify({ kind: "chat", text: "make it blue", page: { path: "/" } }));
  await settle();
  const absent = frames.find((f) => f.kind === "agent_absent");
  check("typing with nobody there is answered, not swallowed",
    Boolean(absent) && /MCP/.test(absent.text), absent?.text?.slice(0, 60) ?? "no reply");

  page.send(JSON.stringify({ kind: "compact_now" }));
  await settle();
  const compacting = frames.find((f) => f.kind === "compacting" && f.stage === "failed");
  check("compaction says why it cannot run rather than appearing to work",
    /no conversation here/.test(compacting?.reason ?? ""), compacting?.reason ?? "no reply");

  page.send(JSON.stringify({ kind: "clear" }));
  await settle();
  check("a new session still clears what the bridge itself holds",
    frames.some((f) => f.kind === "cleared"),
    frames.map((f) => f.kind).join(","));
  check("and the MCP client is told, so it does not keep stale history",
    agentFrames.some((f) => f.kind === "notice" && /new session/.test(f.text)),
    agentFrames.map((f) => f.kind).join(",") || "nothing reached the agent");

  page.close();
  mcpish.close();
  bridge.kill("SIGTERM");
  await new Promise((r) => bridge.on("exit", r));
}

console.log(fail.length ? `\n${fail.length} failed: ${fail.join("; ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
