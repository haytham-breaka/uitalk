// The browser extension's service worker and content script, against a fake `chrome`
// API: pairing (what an offer must prove before the user is even asked), injection
// on paired sites only, the Port-to-WebSocket relay that keeps the token out of the
// page, finding a bridge that restarted on another port, and the self-update that
// follows a client change.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const fail = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXT_URL = `chrome-extension://${EXT_ID}/`;
const PROJECT = "/home/me/shop";
const TOKEN = "f".repeat(48);
const SITE = "https://staging.example.com";

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.map((f) => f(...a)), fns };
}

function storageArea() {
  const data = {};
  return {
    data,
    // Copies, as chrome.storage hands out: a caller's object is never the stored one.
    get: async (k) => structuredClone(typeof k === "string" ? (k in data ? { [k]: data[k] } : {}) : data),
    set: async (o) => Object.assign(data, structuredClone(o)),
    remove: async (k) => { delete data[k]; },
  };
}

/** A fresh worker with its own fake world. `bridges` maps port -> project. */
function loadWorker({ bridges = { 8400: PROJECT }, diskBuild = "bbbbbbbb", granted = [] } = {}) {
  const world = {
    tabUpdates: [], registered: [], reloads: 0, sockets: [], granted: new Set(granted),
    bridges, diskBuild,
  };
  const onMessage = event();
  const onConnect = event();
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p) => EXT_URL + p,
      onMessage, onConnect,
      onInstalled: event(), onStartup: event(),
      reload: () => { world.reloads++; },
    },
    storage: { local: storageArea(), session: storageArea() },
    permissions: {
      contains: async ({ origins }) => origins.every((o) => world.granted.has(o)),
      remove: async ({ origins }) => origins.forEach((o) => world.granted.delete(o)),
      onRemoved: event(),
    },
    scripting: {
      registerContentScripts: async (scripts) => { world.registered = scripts; },
      unregisterContentScripts: async () => { world.registered = []; },
    },
    tabs: { update: async (id, props) => { world.tabUpdates.push({ id, ...props }); } },
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      world.sockets.push(this);
    }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; this.onclose?.({}); }
    // test helpers
    open() { this.readyState = 1; this.onopen?.({}); }
    deliver(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    refuse() { this.readyState = 3; this.onclose?.({}); }
  }
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (url.startsWith(EXT_URL)) {
      return { ok: true, text: async () => `globalThis.__UITALK_BUILD__ = "${world.diskBuild}";\n` };
    }
    const project = world.bridges[Number(u.port)];
    if (u.pathname === "/__uitalk/health" && project) return { ok: true, json: async () => ({ project }) };
    throw new Error("connection refused");
  };
  const ctx = vm.createContext({
    chrome, fetch: fetchImpl, WebSocket: FakeWebSocket, crypto: globalThis.crypto, AbortSignal,
    URL, setTimeout, clearTimeout, console, structuredClone,
  });
  const file = new URL("../extension/background.js", import.meta.url);
  vm.runInContext(readFileSync(file, "utf8"), ctx, { filename: fileURLToPath(file) });

  /** Send a runtime message as `sender`, resolving with the reply. */
  const message = (msg, sender) => new Promise((resolve) => {
    let replied = false;
    for (const f of onMessage.fns) {
      f(msg, sender, (r) => { replied = true; resolve(r); });
    }
    setTimeout(() => { if (!replied) resolve(undefined); }, 200);
  });
  /** Open a Port from a page on `origin`. */
  const connect = (origin) => {
    const port = {
      name: "uitalk-socket", sender: { origin, url: `${origin}/pricing` },
      received: [], disconnected: false,
      onMessage: event(), onDisconnect: event(),
      postMessage(m) { this.received.push(m); },
      disconnect() { this.disconnected = true; },
    };
    onConnect.fire(port);
    return port;
  };
  return { world, chrome, message, connect };
}

const pairPage = (port = 8400) => ({ tab: { id: 7 }, url: `http://127.0.0.1:${port}/__uitalk/pair?site=${encodeURIComponent(SITE)}`, id: EXT_ID });
const extPage = { id: EXT_ID, url: `${EXT_URL}grant.html#x` };
const offer = (over = {}) => ({ v: 1, site: SITE, project: PROJECT, port: 8400, token: TOKEN, build: "aaaaaaaa", ...over });

// ------------------------------------------------------------------ pairing
{
  const w = loadWorker();
  const fromSite = await w.message({ type: "pair-offer", offer: offer() }, { tab: { id: 1 }, url: `${SITE}/x`, id: EXT_ID });
  check("an offer from anything but a bridge's pairing page is refused", fromSite?.ok === false, fromSite?.error);

  const otherPort = await w.message({ type: "pair-offer", offer: offer({ port: 8401 }) }, pairPage(8400));
  check("an offer naming a different bridge than the page it came from is refused",
    otherPort?.ok === false, otherPort?.error);

  const wrongProject = await w.message({ type: "pair-offer", offer: offer({ project: "/elsewhere" }) }, pairPage());
  check("an offer for a project the bridge on that port does not serve is refused",
    wrongProject?.ok === false, wrongProject?.error);

  check("nothing was opened for the refused offers", w.world.tabUpdates.length === 0);

  const good = await w.message({ type: "pair-offer", offer: offer() }, pairPage());
  const grant = w.world.tabUpdates[0]?.url ?? "";
  check("a valid offer opens the extension's own confirmation page in that tab",
    good?.ok === true && w.world.tabUpdates[0]?.id === 7 && grant.startsWith(`${EXT_URL}grant.html#`), grant);
  check("and pairs nothing yet", !(await w.chrome.storage.local.get("pairings")).pairings);

  const id = grant.split("#")[1];
  const fromPage = await w.message({ type: "get-offer", id }, { id: EXT_ID, url: `${SITE}/x` });
  check("a content script cannot read a pending offer", fromPage?.ok === false, fromPage?.error);
  const shown = await w.message({ type: "get-offer", id }, extPage);
  check("the confirmation page sees the site and project, but not the token",
    shown?.ok && shown.offer.site === SITE && shown.offer.project === PROJECT && !("token" in shown.offer),
    JSON.stringify(shown));

  const early = await w.message({ type: "accept-offer", id }, extPage);
  check("accepting without Chrome's permission for the site pairs nothing", early?.ok === false, early?.error);

  w.world.granted.add(`${SITE}/*`);
  const accepted = await w.message({ type: "accept-offer", id }, extPage);
  const saved = (await w.chrome.storage.local.get("pairings")).pairings?.[SITE];
  check("accepting with permission saves the pairing, token included",
    accepted?.ok && saved?.token === TOKEN && saved.port === 8400 && saved.project === PROJECT, JSON.stringify(accepted));
  check("and registers the panel on that site only",
    JSON.stringify(w.world.registered[0]?.matches) === JSON.stringify([`${SITE}/*`]) &&
      JSON.stringify(w.world.registered[0]?.js) === JSON.stringify(["content.js", "client.js"]),
    JSON.stringify(w.world.registered));
  const again = await w.message({ type: "accept-offer", id }, extPage);
  check("an offer is used once", again?.ok === false, again?.error);

  const listed = await w.message({ type: "list" }, { id: EXT_ID, url: `${EXT_URL}popup.html` });
  check("the popup lists pairings without their tokens",
    listed?.pairings?.length === 1 && !("token" in listed.pairings[0]), JSON.stringify(listed));
  await w.message({ type: "unpair", site: SITE }, { id: EXT_ID, url: `${EXT_URL}popup.html` });
  check("removing a pairing drops the injection and Chrome's permission",
    w.world.registered.length === 0 && !w.world.granted.has(`${SITE}/*`));
}

// ---------------------------------------------------------------- transport
async function paired(opts) {
  const w = loadWorker({ granted: [`${SITE}/*`], ...opts });
  await w.chrome.storage.local.set({ pairings: { [SITE]: { site: SITE, project: PROJECT, port: 8400, token: TOKEN } } });
  return w;
}
{
  const w = await paired();
  const stranger = w.connect("https://elsewhere.example");
  await tick(5);
  check("a page on an unpaired site is refused and gets no socket",
    stranger.received[0]?.type === "refused" && stranger.disconnected && w.world.sockets.length === 0,
    JSON.stringify(stranger.received));

  const page = w.connect(SITE);
  page.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  await tick(5);
  const ws = w.world.sockets[0];
  check("a paired page gets a socket to its bridge, carrying the token the page never sees",
    ws?.url === `ws://127.0.0.1:8400/__uitalk/socket?token=${TOKEN}`, ws?.url);
  ws.open();
  check("the page is told when it is open", page.received.some((m) => m.type === "open"));
  page.onMessage.fire({ type: "send", data: '{"kind":"hello"}' });
  check("what the page sends reaches the bridge", ws.sent[0] === '{"kind":"hello"}', JSON.stringify(ws.sent));
  ws.deliver({ kind: "ready", build: "bbbbbbbb" });
  check("what the bridge sends reaches the page",
    page.received.some((m) => m.type === "message" && JSON.parse(m.data).kind === "ready"));
  page.onMessage.fire({ type: "ping" });
  check("a keepalive ping is not forwarded to the bridge", ws.sent.length === 1);
  ws.close();
  check("the bridge closing closes the page's side", page.disconnected === true);

  const page2 = w.connect(SITE);
  await tick(5);
  page2.onDisconnect.fire();
  page2.disconnected = true;
  await tick(5);
  check("the page going away closes its socket", w.world.sockets[1]?.readyState === 3);
}

// ------------------------------------------- a bridge that came back elsewhere
{
  const w = await paired({ bridges: { 8402: PROJECT, 8401: "/some/other/project" } });
  const page = w.connect(SITE);
  await tick(5);
  w.world.sockets[0].refuse(); // nothing on 8400 any more
  await tick(50);
  const p = (await w.chrome.storage.local.get("pairings")).pairings[SITE];
  check("a socket that never opens looks for the project's bridge on another port",
    p.port === 8402, `port ${p.port}`);
  check("and the page sees a close, so its own retry reconnects there", page.disconnected === true);
}

// A rediscovery scan is slow; what the user did meanwhile must survive it.
{
  const w = await paired({ bridges: { 8402: PROJECT } });
  const page = w.connect(SITE);
  await tick(5);
  w.world.sockets[0].refuse();
  // The user removes the site while the scan is running.
  const all = (await w.chrome.storage.local.get("pairings")).pairings;
  delete all[SITE];
  await w.chrome.storage.local.set({ pairings: { ...all } });
  await tick(50);
  check("a site removed during a rediscovery scan stays removed",
    !(await w.chrome.storage.local.get("pairings")).pairings[SITE]);
}
{
  const w = await paired({ bridges: { 8402: PROJECT } });
  w.connect(SITE);
  await tick(5);
  w.world.sockets[0].refuse();
  await w.chrome.storage.local.set({ pairings: { [SITE]: { site: SITE, project: "/other", port: 8500, token: "x".repeat(48) } } });
  await tick(50);
  const p = (await w.chrome.storage.local.get("pairings")).pairings[SITE];
  check("a site re-paired with another session during the scan keeps the new pairing",
    p.project === "/other" && p.port === 8500, JSON.stringify(p));
}

// --------------------------------------------------------------- self-update
{
  // The bridge's client changed and it already rewrote the extension folder: the
  // folder has the bridge's build, the page still runs the old one.
  const w = await paired({ diskBuild: "cccccccc" });
  const page = w.connect(SITE);
  page.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  await tick(5);
  w.world.sockets[0].open();
  w.world.sockets[0].deliver({ kind: "ready", build: "cccccccc" });
  await tick(400);
  check("an extension whose folder already has the bridge's build reloads itself", w.world.reloads === 1);
  const said = page.received.filter((m) => m.type === "message").map((m) => JSON.parse(m.data)).find((f) => f.kind === "error");
  check("and tells the page to reload", /reload this page/.test(said?.text ?? ""), said?.text);

  const page2 = w.connect(SITE);
  page2.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  await tick(5);
  w.world.sockets[1].open();
  w.world.sockets[1].deliver({ kind: "ready", build: "cccccccc" });
  await tick(400);
  check("it reloads once per build, not in a loop", w.world.reloads === 1, `${w.world.reloads} reloads`);
}
{
  // Another tab is mid-work: reloading would cut it off and drop its previews.
  const w = await paired({ diskBuild: "cccccccc" });
  const busy = w.connect(SITE);
  busy.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  const fresh = w.connect(SITE);
  fresh.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  await tick(5);
  w.world.sockets[1].open();
  w.world.sockets[1].deliver({ kind: "ready", build: "cccccccc" });
  await tick(400);
  const said = fresh.received.filter((m) => m.type === "message").map((m) => JSON.parse(m.data)).find((f) => f.kind === "error");
  check("it does not reload while another tab is using uitalk", w.world.reloads === 0 && /another tab/.test(said?.text ?? ""),
    said?.text);
  check("and the other tab stays connected", busy.disconnected === false);
}
{
  // A copy the bridge does not keep current: reloading would not help.
  const w = await paired({ diskBuild: "bbbbbbbb" });
  const page = w.connect(SITE);
  page.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  await tick(5);
  w.world.sockets[0].open();
  w.world.sockets[0].deliver({ kind: "ready", build: "cccccccc" });
  await tick(50);
  const said = page.received.filter((m) => m.type === "message").map((m) => JSON.parse(m.data)).find((f) => f.kind === "error");
  check("a stale copy uitalk does not keep current says how to fix it instead of reloading",
    w.world.reloads === 0 && /uitalk --extension/.test(said?.text ?? ""), said?.text);
}
{
  const w = await paired({ diskBuild: "bbbbbbbb" });
  const page = w.connect(SITE);
  page.onMessage.fire({ type: "hello", build: "bbbbbbbb" });
  await tick(5);
  w.world.sockets[0].open();
  w.world.sockets[0].deliver({ kind: "ready", build: "bbbbbbbb" });
  await tick(50);
  check("matching builds change nothing",
    w.world.reloads === 0 && !page.received.some((m) => m.type === "message" && /"error"/.test(m.data)));
}

// ------------------------------------------------------------ content script
{
  const posted = [];
  let port = null;
  let invalid = false;
  const chrome = {
    runtime: {
      connect: () => {
        if (invalid) throw new Error("Extension context invalidated.");
        port = { onMessage: event(), onDisconnect: event(), postMessage: (m) => posted.push(m), disconnect() {} };
        return port;
      },
    },
  };
  const ctx = vm.createContext({ chrome, queueMicrotask, setInterval, clearInterval, JSON, __UITALK_BUILD__: "bbbbbbbb" });
  ctx.globalThis = ctx;
  const file = new URL("../extension/content.js", import.meta.url);
  vm.runInContext(readFileSync(file, "utf8"), ctx, { filename: fileURLToPath(file) });

  check("the content script marks the page as running in the extension", ctx.__UITALK_EXTENSION__ === true);
  const sock = ctx.__UITALK_CONNECT__("ignored");
  const events = [];
  sock.onopen = () => events.push("open");
  sock.onmessage = (e) => events.push(JSON.parse(e.data).kind);
  sock.onclose = () => events.push("close");
  await tick();
  check("it says which build it runs, so the worker can tell a stale page",
    posted[0]?.type === "hello" && posted[0].build === "bbbbbbbb", JSON.stringify(posted[0]));
  sock.send("early");
  check("nothing is sent before the bridge is reached", !posted.some((m) => m.type === "send"));
  port.onMessage.fire({ type: "open" });
  sock.send('{"kind":"chat"}');
  port.onMessage.fire({ type: "message", data: '{"kind":"ready"}' });
  check("once open it behaves like a WebSocket both ways",
    sock.readyState === 1 && posted.some((m) => m.type === "send" && m.data === '{"kind":"chat"}') &&
      events.join(",") === "open,ready", events.join(","));
  port.onMessage.fire({ type: "refused", text: "not paired" });
  check("a refusal reaches the panel as an error it shows", events.includes("error"));
  port.onDisconnect.fire();
  check("the worker going away reads as a close, so the panel retries", events.at(-1) === "close" && sock.readyState === 3);

  invalid = true;
  const dead = ctx.__UITALK_CONNECT__("ignored");
  const deadEvents = [];
  dead.onmessage = (e) => deadEvents.push(JSON.parse(e.data).text);
  dead.onclose = () => deadEvents.push("close");
  await tick();
  check("after the extension is reloaded under the page, it says to reload the page",
    /reload this page/.test(deadEvents[0] ?? "") && deadEvents[1] === "close", JSON.stringify(deadEvents));
}

// ------------------------------------------------------ the extension's pages
//
// The consent step: the bridge's pairing page only hands an offer over, and nothing
// is paired until the user allows it on the extension's own page.
{
  const { JSDOM, VirtualConsole } = await import("jsdom");
  // jsdom cannot navigate; a navigation surfaces as a jsdomError, counted here.
  let navigations = 0;
  const quiet = new VirtualConsole();
  quiet.on("jsdomError", (e) => { if (/navigation/i.test(e.message)) navigations++; else console.log("!! page error:", e.message); });
  const page = (file, html, url, chrome) => {
    const dom = new JSDOM(html, { url, runScripts: "outside-only", virtualConsole: quiet });
    dom.window.chrome = chrome;
    const src = new URL(`../extension/${file}`, import.meta.url);
    dom.window.eval(`${readFileSync(src, "utf8")}\n//# sourceURL=${fileURLToPath(src)}`);
    return dom.window;
  };

  // pair.js on a bridge's pairing page
  const sentOffers = [];
  const pairChrome = { runtime: { lastError: null, sendMessage: (m, cb) => { sentOffers.push(m); cb({ ok: false, error: "no bridge" }); } } };
  const pairHtml = (json) => `<script type="application/json" id="uitalk-pairing">${json}</script>` +
    `<p id="uitalk-pair-status"></p><div id="uitalk-no-extension">install it</div>`;
  const pw = page("pair.js", pairHtml(JSON.stringify(offer())), "http://127.0.0.1:8400/__uitalk/pair?site=x", pairChrome);
  check("the pairing page's offer is handed to the extension as is",
    sentOffers[0]?.type === "pair-offer" && sentOffers[0].offer.token === TOKEN, JSON.stringify(sentOffers[0]?.type));
  check("the 'not installed' hint is hidden once the extension is there",
    pw.document.getElementById("uitalk-no-extension").hidden === true);
  check("a refusal is shown on the page", /Could not pair: no bridge/.test(pw.document.getElementById("uitalk-pair-status").textContent));
  sentOffers.length = 0;
  const bad = page("pair.js", pairHtml("{not json"), "http://127.0.0.1:8400/__uitalk/pair", pairChrome);
  check("a malformed offer is reported, not sent", sentOffers.length === 0 &&
    /malformed/.test(bad.document.getElementById("uitalk-pair-status").textContent));

  // grant.js, the confirmation page
  const grantHtml = readFileSync(new URL("../extension/grant.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
  const grantWorld = (permission) => {
    const calls = [];
    const chrome = {
      permissions: { request: async (p) => { calls.push(["request", p]); return permission; } },
      runtime: {
        sendMessage: (m, cb) => {
          calls.push([m.type, m.id]);
          if (m.type === "get-offer") cb({ ok: true, offer: { site: SITE, project: PROJECT, port: 8400 }, paired: false });
          else if (m.type === "accept-offer") cb({ ok: true, site: SITE });
        },
      },
    };
    const w = page("grant.js", grantHtml, `${EXT_URL}grant.html#offer-1`, chrome);
    return { w, calls };
  };
  {
    const { w, calls } = grantWorld(true);
    navigations = 0;
    check("the confirmation page shows the site and project before anything is asked",
      w.document.getElementById("site").textContent === SITE && w.document.getElementById("project").textContent === PROJECT &&
        w.document.getElementById("offer").hidden === false && !calls.some(([t]) => t === "request" || t === "accept-offer"),
      JSON.stringify(calls));
    w.document.getElementById("allow").click();
    await tick(10);
    check("allowing asks Chrome for exactly that site, then accepts this offer",
      JSON.stringify(calls.find(([t]) => t === "request")?.[1]) === JSON.stringify({ origins: [`${SITE}/*`] }) &&
        calls.some(([t, id]) => t === "accept-offer" && id === "offer-1"), JSON.stringify(calls));
    check("and then opens the site", navigations === 1, `${navigations} navigation(s)`);
  }
  {
    const { w, calls } = grantWorld(false);
    w.document.getElementById("allow").click();
    await tick(10);
    check("when Chrome's permission is declined, nothing is paired",
      !calls.some(([t]) => t === "accept-offer") && /declined/.test(w.document.getElementById("status").textContent));
  }
  {
    const { w, calls } = grantWorld(true);
    w.document.getElementById("cancel").click();
    check("cancelling pairs nothing", !calls.some(([t]) => t === "request" || t === "accept-offer") &&
      w.document.getElementById("offer").hidden === true);
  }

  // popup.js
  let listed = [{ site: SITE, project: PROJECT, port: 8400 }];
  const unpaired = [];
  const popupHtml = readFileSync(new URL("../extension/popup.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/, "");
  const pop = page("popup.js", popupHtml, `${EXT_URL}popup.html`, {
    runtime: { sendMessage: (m, cb) => {
      if (m.type === "list") cb({ ok: true, pairings: listed });
      if (m.type === "unpair") { unpaired.push(m.site); listed = []; cb({ ok: true }); }
    } },
  });
  check("the popup lists each paired site with its project",
    pop.document.querySelectorAll("#list li").length === 1 && pop.document.querySelector("#list li").textContent.includes(PROJECT));
  pop.document.querySelector("#list li button").click();
  check("removing one unpairs it and empties the list",
    unpaired[0] === SITE && pop.document.querySelectorAll("#list li").length === 0 && pop.document.getElementById("empty").hidden === false);
}

console.log(fail.length ? `\n${fail.length} failing: ${fail.join(", ")}` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
