// uitalk extension service worker.
//
// It does three things, and holds the only secret the extension has:
//
// 1. Pairing. A bridge's pairing page (http://127.0.0.1:<port>/__uitalk/pair) carries
//    an offer: this site, this project, this bridge, this token. pair.js hands it
//    here; the user confirms it on the extension's own grant page, which is also
//    where Chrome asks for permission to run on the site.
// 2. Injection. Every paired site gets the content script and the client, through
//    one dynamically registered content script.
// 3. Transport. A page's panel talks to its bridge through a runtime Port to this
//    worker, which holds the WebSocket. The token never reaches the page, and the
//    site's own scripts cannot see or write to this channel — a postMessage bridge
//    in the page would give them both. (Nor can they drive the panel itself: its
//    shadow root is closed and it ignores events a script fakes; see client/ui.js.)

const SCRIPT_ID = "uitalk-sites";
const BRIDGE_PORTS = Array.from({ length: 40 }, (_, i) => 8400 + i);

// ------------------------------------------------------------------ storage

async function pairings() {
  const { pairings = {} } = await chrome.storage.local.get("pairings");
  return pairings;
}

async function savePairings(next) {
  await chrome.storage.local.set({ pairings: next });
  await syncContentScripts();
}

const originOf = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
};

// --------------------------------------------------------------- injection

/** Register the panel on every paired site Chrome has granted us. */
async function syncContentScripts() {
  const all = Object.keys(await pairings());
  const granted = [];
  for (const site of all) {
    if (await chrome.permissions.contains({ origins: [`${site}/*`] })) granted.push(site);
  }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {} // not registered yet
  if (!granted.length) return;
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    matches: granted.map((s) => `${s}/*`),
    js: ["content.js", "client.js"],
    runAt: "document_idle",
    persistAcrossSessions: true,
  }]);
}

chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());

// ----------------------------------------------------------------- pairing

const isPairPage = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      u.pathname === "/__uitalk/pair" && Number(u.port) > 0;
  } catch {
    return false;
  }
};

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__uitalk/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Validate an offer against the page it came from. The port is taken from that
 * page's own URL, never from the offer, and the bridge on it must answer for the
 * offered project — a page on some other local port cannot point us elsewhere.
 */
async function checkOffer(offer, senderUrl) {
  if (!isPairPage(senderUrl)) return { ok: false, error: "the offer did not come from a uitalk pairing page" };
  const port = Number(new URL(senderUrl).port);
  const site = originOf(offer?.site);
  if (!site) return { ok: false, error: "the offer names no site" };
  if (typeof offer.token !== "string" || offer.token.length < 16) return { ok: false, error: "the offer carries no token" };
  if (offer.port !== port) return { ok: false, error: "the offer names a different bridge than the page it came from" };
  const h = await health(port);
  if (!h || h.project !== offer.project) return { ok: false, error: `no uitalk bridge for ${offer.project} answers on :${port}` };
  return { ok: true, offer: { site, project: offer.project, port, token: offer.token } };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg?.type === "pair-offer" && sender.tab?.id != null) {
      const checked = await checkOffer(msg.offer, sender.url);
      if (!checked.ok) return reply(checked);
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ [`offer:${id}`]: checked.offer });
      // The user decides on our own page, not on the bridge's: a page Chrome shows
      // as the extension's is the only place a permission prompt can come from.
      await chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL(`grant.html#${id}`) });
      return reply({ ok: true });
    }

    // Everything below is for the extension's own pages only.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      return reply({ ok: false, error: "not allowed" });
    }
    if (msg?.type === "get-offer") {
      const key = `offer:${msg.id}`;
      const { [key]: offer } = await chrome.storage.session.get(key);
      if (!offer) return reply({ ok: false, error: "this pairing has expired; open the pairing link again" });
      const { token, ...visible } = offer; // the page needs to show it, not to hold the token
      return reply({ ok: true, offer: visible, paired: Boolean((await pairings())[offer.site]) });
    }
    if (msg?.type === "accept-offer") {
      const key = `offer:${msg.id}`;
      const { [key]: offer } = await chrome.storage.session.get(key);
      if (!offer) return reply({ ok: false, error: "this pairing has expired; open the pairing link again" });
      if (!(await chrome.permissions.contains({ origins: [`${offer.site}/*`] }))) {
        return reply({ ok: false, error: `Chrome has not granted access to ${offer.site}` });
      }
      await chrome.storage.session.remove(key);
      await savePairings({ ...(await pairings()), [offer.site]: { ...offer, pairedAt: Date.now() } });
      return reply({ ok: true, site: offer.site });
    }
    if (msg?.type === "list") {
      const list = Object.values(await pairings()).map(({ token, ...p }) => p);
      return reply({ ok: true, pairings: list });
    }
    if (msg?.type === "unpair") {
      const all = await pairings();
      delete all[msg.site];
      await savePairings(all);
      try {
        await chrome.permissions.remove({ origins: [`${msg.site}/*`] });
      } catch {}
      return reply({ ok: true });
    }
    reply({ ok: false, error: "unknown request" });
  })();
  return true; // reply is async
});

// --------------------------------------------------------------- transport

/**
 * A bridge picks the first free port at startup, so after a restart it may be on a
 * different one. Its token is per project and survives the restart, so finding the
 * bridge that answers for the paired project is enough to reconnect.
 */
async function rediscover(site) {
  const p = (await pairings())[site];
  if (!p) return;
  const found = await Promise.all(BRIDGE_PORTS.map(async (port) => ((await health(port))?.project === p.project ? port : null)));
  const port = found.find((x) => x != null);
  if (!port || port === p.port) return;
  // The scan takes a while; in the meantime the user may have removed this site or
  // paired it with another session, and another tab may have moved its own. Write
  // onto what is stored now, and only if it is still the pairing that was scanned for.
  const now = await pairings();
  const still = now[site];
  if (!still || still.project !== p.project || still.token !== p.token) return;
  await chrome.storage.local.set({ pairings: { ...now, [site]: { ...still, port } } });
}

async function diskBuild() {
  try {
    const text = await (await fetch(chrome.runtime.getURL("client.js"), { cache: "no-store" })).text();
    return /^globalThis\.__UITALK_BUILD__ = "([0-9a-f]{8})";$/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The bridge rewrites the extension's folder when its client changes, but Chrome
 * keeps running the files it loaded. When the folder already has the bridge's build,
 * reloading the extension picks it up; when it does not, this copy is not one the
 * bridge keeps current, and only the user can fix that.
 */
async function reconcileBuild(pageBuild, bridgeBuild) {
  if (!bridgeBuild || !pageBuild || pageBuild === bridgeBuild) return null;
  if ((await diskBuild()) !== bridgeBuild) {
    return "this copy of the uitalk extension is older than the bridge and is not a folder uitalk keeps " +
      "up to date. Run `uitalk --extension` in the project, load the folder it prints, then reload this page.";
  }
  // Reloading the extension cuts every tab's connection and drops its previews, so
  // it waits until this is the only uitalk tab in use.
  if (livePorts.size > 1) {
    return "uitalk was updated. The extension updates itself once it isn't in use in another tab — " +
      "finish there, then reload this page.";
  }
  const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
  if (reloadedFor === bridgeBuild) return "uitalk was updated — reload this page to pick it up.";
  await chrome.storage.local.set({ reloadedFor: bridgeBuild });
  setTimeout(() => chrome.runtime.reload(), 300);
  return "uitalk was updated — reload this page in a moment to pick it up.";
}

const livePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "uitalk-socket") return;
  void relay(port);
});

async function relay(port) {
  const site = originOf(port.sender?.origin ?? port.sender?.url);
  let ws = null;
  let closed = false;
  let pageBuild = null;
  livePorts.add(port);
  const end = () => {
    if (closed) return;
    closed = true;
    livePorts.delete(port);
    try { ws?.close(); } catch {}
    try { port.disconnect(); } catch {}
  };
  port.onDisconnect.addListener(end);
  port.onMessage.addListener((m) => {
    if (m?.type === "hello") pageBuild = typeof m.build === "string" ? m.build : null;
    else if (m?.type === "send" && ws?.readyState === WebSocket.OPEN) ws.send(m.data);
    // "ping" needs no answer: receiving it is what keeps this worker awake.
  });

  const pairing = site ? (await pairings())[site] : null;
  if (!pairing) {
    port.postMessage({ type: "refused", text: `${site ?? "this page"} is not paired with a uitalk session` });
    return end();
  }
  if (closed) return;

  ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/__uitalk/socket?token=${encodeURIComponent(pairing.token)}`);
  let opened = false;
  let first = true;
  ws.onopen = () => {
    opened = true;
    if (!closed) port.postMessage({ type: "open" });
  };
  ws.onmessage = (ev) => {
    if (closed) return;
    port.postMessage({ type: "message", data: ev.data });
    if (!first) return;
    first = false;
    let frame = null;
    try {
      frame = JSON.parse(ev.data);
    } catch {}
    if (frame?.kind !== "ready") return;
    void reconcileBuild(pageBuild, frame.build).then((text) => {
      if (text && !closed) port.postMessage({ type: "message", data: JSON.stringify({ kind: "error", text }) });
    });
  };
  ws.onclose = () => {
    // Never reached the bridge: it may have restarted on another port.
    if (!opened) void rediscover(site);
    end();
  };
}
