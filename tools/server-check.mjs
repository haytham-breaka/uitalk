// The bridge's own logic: settings, the instance registry, git snapshots, the
// proxy's injection and diagnosis, the message the agent receives, and every page
// tool's handler. None of it needs a browser, an agent, or a listening socket —
// which is why it had no coverage until now.

process.env.UITALK_IMPORT_ONLY = "1"; // importing the bridge must not start one

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

const fail = [];
const check = (n, ok, d) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail.push(n);
};

const sandbox = mkdtempSync(join(tmpdir(), "uitalk-server-check-"));
process.env.UITALK_HOME = join(sandbox, "home");
// The bridge reads its project root at import time; point it at the sandbox so a
// settings test cannot drop a file into the repository it is testing.
process.env.UITALK_PROJECT = join(sandbox, "bridge-project");
mkdirSync(process.env.UITALK_PROJECT, { recursive: true });

// ---------------------------------------------------------------- settings
{
  const settings = await import("../server/settings.mjs");
  const project = join(sandbox, "proj");
  mkdirSync(project, { recursive: true });

  const base = settings.load(project);
  check("defaults load with nothing on disk", base.compactAtPercent === 20 && base.autoCompact === true,
    JSON.stringify({ pct: base.compactAtPercent }));

  const clamp = settings.validate({ compactAtPercent: 999, contextTokens: 1, bogus: 1 });
  check("out-of-range numbers are clamped, not rejected", clamp.clean.compactAtPercent === 95,
    String(clamp.clean.compactAtPercent));
  check("a clamp is reported rather than applied silently",
    clamp.rejected.some((r) => /clamped/.test(r)), clamp.rejected.join("; "));
  check("an unknown key is refused", clamp.rejected.some((r) => /not a setting/.test(r)));
  check("a value below the floor is raised to it", clamp.clean.contextTokens === 20000,
    String(clamp.clean.contextTokens));

  const choice = settings.validate({ reloadAfterEdit: "never" });
  check("a valid choice passes", choice.clean.reloadAfterEdit === "never");
  const badChoice = settings.validate({ reloadAfterEdit: "sometimes" });
  check("an invalid choice is refused with the options",
    !("reloadAfterEdit" in badChoice.clean) && /auto, always, never/.test(badChoice.rejected[0] ?? ""),
    badChoice.rejected[0]);

  const saved = settings.save(project, { compactAtPercent: 40, reloadAfterEdit: "always" });
  check("saving writes the project's own file", existsSync(join(project, ".uitalk.json")));
  check("and the merged view comes back", saved.settings.compactAtPercent === 40);
  check("the file holds only what was set",
    Object.keys(JSON.parse(readFileSync(join(project, ".uitalk.json"), "utf8"))).sort().join(",") ===
      "compactAtPercent,reloadAfterEdit");

  // env beats the project file, which beats the global one
  mkdirSync(join(sandbox, "home"), { recursive: true });
  writeFileSync(join(sandbox, "home", "settings.json"),
    JSON.stringify({ compactAtPercent: 11, replayLimit: 33 }), { flag: "w" });
  process.env.UITALK_COMPACT_AT_PERCENT = "77";
  const layered = settings.load(project);
  check("env wins over the project file", layered.compactAtPercent === 77, String(layered.compactAtPercent));
  check("the project file wins over the global one", layered.reloadAfterEdit === "always");
  check("the global file still supplies what nothing else set", layered.replayLimit === 33,
    String(layered.replayLimit));
  delete process.env.UITALK_COMPACT_AT_PERCENT;

  writeFileSync(join(project, ".uitalk.json"), "{ not json");
  check("a corrupt project file falls back rather than throwing",
    settings.load(project).compactAtPercent === 11, String(settings.load(project).compactAtPercent));
  rmSync(join(project, ".uitalk.json"));

  // Who answers the panel is a setting, so a project can commit its own choice.
  const agentOff = settings.validate({ agent: "off" });
  check("a project can choose to run with no built-in agent", agentOff.clean.agent === "off");
  const agentBad = settings.validate({ agent: "gpt" });
  check("and a mode that does not exist is refused with the list",
    !("agent" in agentBad.clean) && /builtin, adapter, off/.test(agentBad.rejected[0] ?? ""),
    agentBad.rejected[0]);

  const model = settings.validate({ agentModel: "  gemini-2.5-pro  " });
  check("a free-text setting is trimmed", model.clean.agentModel === "gemini-2.5-pro",
    JSON.stringify(model.clean.agentModel));
  const longModel = settings.validate({ agentModel: "x".repeat(200) });
  check("and capped, so a pasted essay cannot become a model name",
    !("agentModel" in longModel.clean) && /longer than/.test(longModel.rejected[0] ?? ""),
    longModel.rejected[0]);

  process.env.UITALK_AGENT = "adapter";
  check("the mode can be set for one run without editing a file",
    settings.load(project).agent === "adapter", settings.load(project).agent);
  delete process.env.UITALK_AGENT;

  // A key is not a setting: it must not be reachable through the settings surface,
  // because everything there is written to a committed file and sent to the page.
  const keyAsSetting = settings.validate({ apiKey: "sk-secret", agentApiKey: "sk-secret" });
  check("an API key cannot be smuggled in as a setting",
    Object.keys(keyAsSetting.clean).length === 0 && keyAsSetting.rejected.length === 2,
    keyAsSetting.rejected.join("; "));

  process.env.OPENAI_API_KEY = "sk-from-env";
  const fromEnv = settings.credential("openai");
  check("a provider's own variable is read", fromEnv.key === "sk-from-env" && fromEnv.from === "$OPENAI_API_KEY",
    fromEnv.from);
  process.env.UITALK_API_KEY = "sk-explicit";
  check("and UITALK_API_KEY takes precedence over it",
    settings.credential("openai").from === "$UITALK_API_KEY", settings.credential("openai").from);
  delete process.env.UITALK_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const written = settings.saveCredential("gemini", " key-on-disk ");
  check("a key written to disk lands in the uitalk home, not the project",
    written === join(sandbox, "home", "credentials.json") && !existsSync(join(project, "credentials.json")),
    written);
  check("only its owner can read it", (statSync(written).mode & 0o777) === 0o600,
    (statSync(written).mode & 0o777).toString(8));
  const fromFile = settings.credential("gemini");
  check("and it is read back trimmed, with its source named",
    fromFile.key === "key-on-disk" && fromFile.from === written, fromFile.from);
  check("a provider with no key anywhere reports none rather than guessing",
    settings.credential("anthropic").key === null, String(settings.credential("anthropic").key));
}

// ---------------------------------------------------------------- registry
{
  const registry = await import("../server/registry.mjs");
  registry.add({ pid: process.pid, port: 8400, appHost: "127.0.0.1", appPort: 5173, project: "/a" });
  check("an entry is listed while its process lives",
    registry.list().some((e) => e.pid === process.pid), JSON.stringify(registry.list()));

  registry.add({ pid: 999999, port: 8401, appHost: "127.0.0.1", appPort: 5174, project: "/b" });
  const live = registry.list();
  check("an entry whose process is gone is pruned", !live.some((e) => e.pid === 999999),
    `${live.length} live`);

  check("a bridge already serving an app is found",
    registry.servingApp("127.0.0.1", 5173)?.pid === process.pid);
  check("and one serving a different app is not", !registry.servingApp("127.0.0.1", 9999));

  registry.remove(process.pid);
  check("removing the last entry leaves no file behind", !existsSync(registry.registryPath),
    existsSync(registry.registryPath) ? readFileSync(registry.registryPath, "utf8") : "gone");
  check("listing an empty registry is empty, not an error", registry.list().length === 0);
}

// --------------------------------------------------------------- snapshots
{
  const snapshots = await import("../server/snapshots.mjs");
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });

  check("a directory that is not a repository says so", (await snapshots.isRepo(repo)) === false);
  check("and cannot be snapshotted", (await snapshots.snapshot(repo, "x")) === null);

  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "style.css"), ".a { color: red }\n");
  git("add", ".");
  git("commit", "-qm", "first");

  const snap = await snapshots.snapshot(repo, "before the edit");
  check("a clean tree snapshots to a restorable point", Boolean(snap?.ref), snap?.ref?.slice(0, 8));

  writeFileSync(join(repo, "style.css"), ".a { color: blue }\n");
  writeFileSync(join(repo, "extra.css"), ".b { color: green }\n");
  check("what changed since is reported", (await snapshots.changedSince(repo, snap)).length > 0);

  const out = await snapshots.revertTo(repo, snap);
  check("reverting names the files it restored", out.reverted.includes("style.css"),
    JSON.stringify(out.reverted));
  check("and the content really went back",
    readFileSync(join(repo, "style.css"), "utf8").includes("red"),
    readFileSync(join(repo, "style.css"), "utf8").trim());
  check("a file the agent added is left alone, not deleted",
    existsSync(join(repo, "extra.css")));

  const nothing = await snapshots.revertTo(repo, snap);
  check("reverting twice is harmless", nothing.reverted.length === 0, JSON.stringify(nothing));

  let refused = null;
  try { await snapshots.revertTo(repo, null); } catch (e) { refused = e.message; }
  check("reverting without a snapshot is refused", /no snapshot/.test(refused ?? ""), refused);

  // a dirty tree must still be restorable
  writeFileSync(join(repo, "style.css"), ".a { color: rebeccapurple }\n");
  const dirty = await snapshots.snapshot(repo, "dirty");
  writeFileSync(join(repo, "style.css"), ".a { color: black }\n");
  await snapshots.revertTo(repo, dirty);
  check("a snapshot of a dirty tree restores the dirty state",
    readFileSync(join(repo, "style.css"), "utf8").includes("rebeccapurple"),
    readFileSync(join(repo, "style.css"), "utf8").trim());
}

// ------------------------------------------------------------------- proxy
{
  const { createProxy, proxyUpgrade } = await import("../server/proxy.mjs");

  const app = createServer((req, res) => {
    if (req.url === "/nohead") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<body>bare</body>");
    }
    if (req.url === "/fragment") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("just text, no tags");
    }
    if (req.url === "/asset.js") {
      res.writeHead(200, { "content-type": "text/javascript", etag: 'W/"asset-1"' });
      return res.end("console.log(1)");
    }
    if (req.url === "/cached") {
      // The app's own HTML has not changed, so upstream is right to answer 304. The
      // injected tag is not covered by that validator, which is the whole problem.
      if (req.headers["if-none-match"] === 'W/"app-1"') {
        res.writeHead(304, { etag: 'W/"app-1"' });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html", etag: 'W/"app-1"' });
      return res.end("<html><head></head><body>cached</body></html>");
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'none'",
    });
    res.end("<html><head><title>t</title></head><body>hi</body></html>");
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const target = { host: "127.0.0.1", port: app.address().port };

  const injected = [];
  const proxy = createServer(createProxy({ target, onInject: (u) => injected.push(u), onHtml: () => {} }));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const at = (path) => `http://127.0.0.1:${proxy.address().port}${path}`;

  const home = await fetch(at("/"));
  const html = await home.text();
  check("the client is injected into html", html.includes('src="/__uitalk/client.js"'));
  check("it goes before </head> when there is one", html.indexOf("__uitalk/client.js") < html.indexOf("</head>"));
  check("a strict CSP is stripped from what we rewrite", !home.headers.get("content-security-policy"),
    home.headers.get("content-security-policy") ?? "removed");
  check("content-length matches the rewritten body",
    Number(home.headers.get("content-length")) === Buffer.byteLength(html), home.headers.get("content-length"));
  check("the injection is reported", injected.includes("/"));

  check("a page with no head is still injected", (await (await fetch(at("/nohead"))).text()).includes("__uitalk/client.js"));
  check("even a bare fragment is injected", (await (await fetch(at("/fragment"))).text()).includes("__uitalk/client.js"));

  const asset = await fetch(at("/asset.js"));
  check("non-html passes through untouched", (await asset.text()) === "console.log(1)");
  check("and an asset keeps its validator, so reloads stay cheap",
    asset.headers.get("etag") === 'W/"asset-1"', asset.headers.get("etag") ?? "stripped");

  // The bug this guards: the injected tag is not covered by upstream's ETag, so a
  // browser that revalidates gets 304, keeps its cached document, and goes on loading
  // whatever client path was current the first time it visited — across restarts and
  // renames. It presents as "the panel stopped appearing" with nothing in any log.
  const fresh = await fetch(at("/cached"));
  check("a rewritten document carries no upstream validator",
    !fresh.headers.get("etag"), fresh.headers.get("etag") ?? "none");
  check("and is marked not to be stored at all",
    /no-store/.test(fresh.headers.get("cache-control") ?? ""), fresh.headers.get("cache-control") ?? "(none)");

  const revalidated = await fetch(at("/cached"), { headers: { "if-none-match": 'W/"app-1"' } });
  const revalidatedBody = await revalidated.text();
  check("a conditional navigation gets a full injected document, never a bare 304",
    revalidated.status === 200 && revalidatedBody.includes("__uitalk/client.js"),
    `HTTP ${revalidated.status}, ${revalidatedBody.length} bytes`);

  const conditionalAsset = await fetch(at("/asset.js"), { headers: { "if-none-match": 'W/"asset-1"' } });
  check("an asset may still revalidate: only documents we rewrite are forced",
    conditionalAsset.status === 200, `HTTP ${conditionalAsset.status}`);

  app.close();
  const dead = await fetch(at("/"));
  const page = await dead.text();
  check("an app that is down produces a diagnosis, not a stack trace",
    dead.status === 502 && /No app on/.test(page), String(dead.status));
  check("the diagnosis carries the panel, so the tool does not vanish with the app",
    page.includes("__uitalk/client.js"));
  // Which advice it gives depends on whether anything else is answering nearby, so
  // assert that it gives a runnable command either way.
  check("and suggests a command to fix it", /npm run dev|uitalk --(dev|stop|app-port)/.test(page),
    (page.match(/<pre[^>]*>([^<]{0,60})/) ?? [])[1]);
  proxy.close();
  check("the upgrade forwarder is exported", typeof proxyUpgrade === "function");
}

// -------------------------------------------- the message the agent receives
{
  const bridge = await import("../server/index.mjs");

  const plain = bridge.buildUserContent({
    text: "align 2 to 1", selectionCount: 2,
    page: { path: "/pricing", viewport: { w: 1440, h: 900, dpr: 2 } },
  });
  check("a plain message is a string with a header", typeof plain === "string" && plain.includes("/pricing"),
    String(plain).split("\n")[0]);
  check("the header carries the viewport and the selection count",
    /1440x900 @2x \| 2 element\(s\) selected/.test(plain), String(plain).split("\n")[0]);

  const mobile = bridge.buildUserContent({
    text: "why does this wrap", selectionCount: 0,
    page: { path: "/", viewport: { w: 390, h: 844, dpr: 2 },
            screen: { preset: "iPhone 14", width: 390, height: 844, orientation: "portrait", zoom: 0.5 } },
  });
  check("a simulated screen replaces the window viewport",
    /iPhone 14 390x844 portrait \(shown at 50%\)/.test(mobile), String(mobile).split("\n")[0]);

  const withShots = bridge.buildUserContent({
    text: "the flip", selectionCount: 0,
    page: { path: "/", viewport: { w: 800, h: 600, dpr: 1 } },
    shots: [
      { png: "AAAA", label: "frame 1", triggeredBy: [{ at: 0, element: { selector: "button.card" } }] },
      { png: "BBBB", label: "frame 2" },
    ],
  });
  check("screenshots arrive as image blocks", Array.isArray(withShots) &&
    withShots.filter((b) => b.type === "image").length === 2, `${withShots.length} blocks`);
  check("each image is introduced by its label",
    withShots.some((b) => b.type === "text" && /Screenshot 1 of 2: frame 1/.test(b.text)));
  check("the interaction timeline rides with the first",
    withShots.some((b) => b.type === "text" && /\+0ms clicked button\.card/.test(b.text)),
    withShots.find((b) => /timeline/.test(b.text ?? ""))?.text?.slice(-60));

  // the served-html fallback for pages with no framework metadata
  bridge.servedHtml.set("/about", "<html>\n<body>\n<button data-testid=\"go\">Go</button>\n</body>\n</html>");
  const hit = bridge.findInServedHtml("/about", ['data-testid="go"']);
  check("an element is found in the html we served", hit.found && hit.line === 3, JSON.stringify(hit));
  check("and the line is quoted back", /data-testid/.test(hit.excerpt ?? ""), hit.excerpt);
  check("a miss says why", bridge.findInServedHtml("/about", ["nope"]).found === false);
  check("a path never served says so", /nothing served/.test(bridge.findInServedHtml("/never", ["x"]).reason ?? ""));

  // transcript and context accounting
  bridge.transcript.length = 0;
  bridge.record("me", "first");
  bridge.record("agent", "reply");
  bridge.record("me", "");
  check("the transcript keeps finished messages", bridge.transcript.length === 2,
    `${bridge.transcript.length} entries`);
  check("and drops empty ones", !bridge.transcript.some((e) => e.text === ""));

  bridge.resetContextMeter();
  bridge.noteUsage({ type: "assistant", message: { id: "m1", usage: { input_tokens: 100, cache_read_input_tokens: 900 } } });
  check("context is the whole prompt, not just fresh tokens", bridge.context.tokens === 1000,
    String(bridge.context.tokens));
  bridge.noteUsage({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5000 } } });
  check("the same message id is not counted twice", bridge.context.tokens === 1000,
    String(bridge.context.tokens));
  bridge.noteUsage({ type: "assistant", parent_tool_use_id: "t1",
    message: { id: "m2", usage: { input_tokens: 90000 } } });
  check("a subagent's context is its own, not ours", bridge.context.tokens === 1000,
    String(bridge.context.tokens));
  bridge.resetContextMeter();
  check("resetting clears the meter", bridge.context.tokens === 0 && bridge.context.percent === 0);
}

// --------------------------------------------------------------- page tools
{
  const { createPageServer } = await import("../server/page-tools.mjs");
  const calls = [];
  const failures = [];
  let answer = { ok: true };

  const srv = createPageServer(
    async (method, params) => {
      calls.push({ method, params });
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(method, params) : answer;
    },
    (method, message) => failures.push({ method, message }),
    (path, needles) => ({ found: true, line: 7, column: 1, matched: needles[0], excerpt: "<button>" }),
  );

  const tools = srv.instance._registeredTools;
  const run = (name, args = {}) => tools[name].handler(args, {});

  check("every page tool is registered", Object.keys(tools).length === 12, Object.keys(tools).length);
  check("each tool carries a description the agent can choose from",
    Object.values(tools).every((t) => typeof t.description === "string" && t.description.length > 40),
    Object.entries(tools).find(([, t]) => (t.description ?? "").length <= 40)?.[0] ?? "all described");

  answer = { selected: 2 };
  const sel = await run("read_selection");
  check("read_selection passes the page's answer through",
    /"selected": 2/.test(sel.content[0].text), sel.content[0].text.slice(0, 40));

  answer = { png: "AAAA", width: 10, height: 10, dpr: 2, inventory: [] };
  const shot = await run("capture", { inventory: true });
  check("capture returns an image block", shot.content.some((b) => b.type === "image"));
  check("with the inventory beside it", shot.content.some((b) => b.type === "text" && /Coordinates/.test(b.text)));

  answer = { png: "A", frames: [{ png: "A", at: 0 }, { png: "B", at: 40 }], width: 4, height: 4, dpr: 1 };
  const strip = await run("capture", { frames: 2, every: 40 });
  check("a strip becomes one image block per frame",
    strip.content.filter((b) => b.type === "image").length === 2);
  check("each frame is introduced with its offset",
    strip.content.some((b) => b.type === "text" && /Frame 2 of 2, \+40ms/.test(b.text)));
  check("a strip is given a longer budget than a single shot",
    calls.at(-1).method === "capture", calls.at(-1).method);

  answer = { tier: "react", file: "/src/App.jsx", line: 44 };
  const loc = await run("locate_source", { ref: 1 });
  check("locate_source reports the tier that answered", /"tier": "react"/.test(loc.content[0].text));

  answer = { tier: "none", element: { testId: "go" }, page: { path: "/about" } };
  const fallback = await run("locate_source", { ref: 1 });
  check("with no framework metadata it falls back to the served html",
    /"tier": "served-html"/.test(fallback.content[0].text), fallback.content[0].text.slice(0, 60));

  answer = { frames: [{ png: "A", at: 390, label: "390px · 300×100" }], notes: ["1440px: the element is not present"] };
  const bp = await run("capture_breakpoints", { ref: 1, widths: [390, 1440] });
  check("breakpoints return one image per width", bp.content.filter((b) => b.type === "image").length === 1);
  check("and a note for a width where the element was missing",
    bp.content.some((b) => b.type === "text" && /not present/.test(b.text)));

  answer = new Error("the app frame is not ready");
  const broken = await run("try_style", { ref: 1, declarations: "color: red" });
  check("a page that cannot answer produces an error result, not a throw", broken.isError === true);
  check("the message reaches the agent", /not ready/.test(broken.content[0].text), broken.content[0].text);
  check("and is reported so the panel can show it",
    failures.some((f) => f.method === "tryStyle" && /not ready/.test(f.message)),
    JSON.stringify(failures.at(-1)));

  answer = { ok: true };
  const noneShot = await run("capture", { inventory: false });
  check("a capture with no image still answers rather than hanging", Array.isArray(noneShot.content));
}

// ------------------------------------------------- the bridge's frame router
{
  const bridge = await import("../server/index.mjs");

  // A stand-in for a connected page: the router only needs on/send/readyState.
  const makePage = () => {
    const sent = [];
    const handlers = {};
    const ws = {
      readyState: 1,
      OPEN: 1,
      sent,
      on: (type, fn) => (handlers[type] = fn),
      send: (data) => sent.push(JSON.parse(data)),
      deliver: (frame) => handlers.message?.(Buffer.from(JSON.stringify(frame))),
      close: () => handlers.close?.(),
    };
    bridge.wss.emit("connection", ws, {});
    return ws;
  };

  const page = makePage();
  const ready = page.sent.find((f) => f.kind === "ready");
  check("a connecting page is greeted with its settings and build", Boolean(ready?.settings && ready?.build),
    JSON.stringify({ build: ready?.build, hasSettings: Boolean(ready?.settings) }));
  check("and told which project it is attached to", typeof ready?.project === "string");

  bridge.transcript.length = 0;
  bridge.record("me", "earlier message");
  const second = makePage();
  check("a page joining later is replayed what it missed",
    second.sent.some((f) => f.kind === "replay" && f.entries.length === 1),
    JSON.stringify(second.sent.map((f) => f.kind)));

  // a chat frame is recorded with what rode along
  bridge.transcript.length = 0;
  page.deliver({ kind: "chat", text: "make it bolder", selectionCount: 2,
    page: { path: "/", viewport: { w: 1, h: 1, dpr: 1 } },
    shots: [{ png: "A", label: "one" }] });
  check("a chat message is recorded for replay", bridge.transcript.length === 1);
  check("and the record says what was attached",
    /1 screenshot, 2 element\(s\) selected/.test(bridge.transcript[0].text),
    bridge.transcript[0].text.split("\n")[1]);

  // announcing makes a page the active one, which is where page calls go
  const older = page;
  const newer = makePage();
  newer.deliver({ kind: "focus", url: "http://127.0.0.1:8400/", visible: true });
  older.sent.length = 0;
  newer.sent.length = 0;
  const inflight = bridge.callPage("readSelection", {}, 500);
  check("a page call goes to the tab that announced itself last",
    newer.sent.some((f) => f.kind === "rpc") && !older.sent.some((f) => f.kind === "rpc"),
    `newer ${newer.sent.length}, older ${older.sent.length}`);

  const rpc = newer.sent.find((f) => f.kind === "rpc");
  newer.deliver({ kind: "rpc_result", id: rpc.id, result: { selected: 3 } });
  check("and its answer settles the call", (await inflight).selected === 3);

  const timing = bridge.callPage("capture", {}, 60).then(() => null, (e) => e.message);
  check("a page that never answers times out rather than hanging",
    /timed out/.test(await timing), await timing);

  newer.deliver({ kind: "rpc_result", id: 99999, result: { stray: true } });
  check("an answer to a call that already timed out is ignored", true);

  page.deliver({ kind: "nonsense" });
  check("an unknown frame is ignored rather than crashing the bridge", true);

  // settings arrive from the panel and come back merged
  newer.sent.length = 0;
  page.deliver({ kind: "settings", patch: { compactAtPercent: 44, bogus: 1 } });
  await new Promise((r) => setTimeout(r, 50));
  const saved = newer.sent.find((f) => f.kind === "settings");
  check("a settings change is applied and broadcast", saved?.settings?.compactAtPercent === 44,
    JSON.stringify(saved?.settings?.compactAtPercent));
  check("and what was refused is said out loud", saved?.rejected?.some((r) => /not a setting/.test(r)),
    JSON.stringify(saved?.rejected));

  // revert with nothing to go back to must not pretend
  newer.sent.length = 0;
  page.deliver({ kind: "revert" });
  await new Promise((r) => setTimeout(r, 80));
  check("reverting with no snapshot says so rather than failing silently",
    newer.sent.some((f) => f.kind === "reverted" && f.ok === false),
    JSON.stringify(newer.sent.find((f) => f.kind === "reverted")));

  const openBefore = bridge.clients.size;
  page.close();
  check("a page that disconnects is forgotten", bridge.clients.size === openBefore - 1,
    `${openBefore} -> ${bridge.clients.size}`);

  for (const c of [...bridge.clients]) bridge.clients.delete(c);
  let noPage = null;
  await bridge.callPage("readSelection", {}, 50).catch((e) => (noPage = e.message));
  check("with no page connected a call is refused immediately", /no page is connected/.test(noPage ?? ""),
    noPage);
}

// ------------------------------------- the client is served fresh, not from boot
{
  const bridge = await import("../server/index.mjs");
  const { readFileSync, writeFileSync, utimesSync } = await import("node:fs");
  const uiPath = new URL("../client/ui.js", import.meta.url).pathname;

  const first = bridge.readClient();
  check("the client is assembled with a build stamp", /__UITALK_BUILD__ = "[0-9a-f]{8}"/.test(first.body),
    first.build);
  check("reading it again without a change reuses what it had",
    bridge.readClient().build === first.build);

  // Touch the source the way an update would, and the bridge must notice without a
  // restart — otherwise a plugin update appears to do nothing.
  const original = readFileSync(uiPath, "utf8");
  try {
    writeFileSync(uiPath, `${original}\n// touched by the test\n`);
    const after = bridge.readClient();
    check("a changed client is picked up without restarting the bridge",
      after.build !== first.build, `${first.build} -> ${after.build}`);
    check("and the new stamp travels in the bundle",
      after.body.includes(`__UITALK_BUILD__ = "${after.build}"`));
  } finally {
    writeFileSync(uiPath, original);
  }

  const restored = bridge.readClient();
  check("restoring the file restores the stamp", restored.build === first.build,
    `${restored.build} vs ${first.build}`);

  check("checking the bridge's own freshness is harmless when nothing changed",
    bridge.checkServerFreshness() === undefined);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
