// A reverse proxy in front of the app's dev server.
//
// Browse the proxy port instead of the app's and one script tag is injected into
// every HTML response as it passes through. This is the whole reason the tool
// needs no per-framework handling: the injection happens on rendered HTML, so a
// server-rendered document shell is indistinguishable from a static file, and
// nothing in the project is ever written to.

import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { Transform } from "node:stream";

const CLIENT_TAG = `<script src="/__uitalk/client.js" data-uitalk></script>`;

// The capability token rides on the script *tag*, not inside client.js — the
// bundle is served to anyone and can be loaded cross-origin, so a token baked
// into it would leak. On the tag it is only readable by same-origin script,
// which a cross-origin attacker is not. Hex only, so it is attribute-safe.
const clientTagWith = (token) =>
  token ? `<script src="/__uitalk/client.js" data-uitalk data-uitalk-token="${token}"></script>` : CLIENT_TAG;

// Dev-only, and only for responses this proxy is already rewriting: a strict app
// CSP would otherwise refuse both the injected script and its socket.
const CSP_HEADERS = ["content-security-policy", "content-security-policy-report-only"];

const isHtml = (headers) => /text\/html/i.test(headers["content-type"] ?? "");

// Whether this request might be answered with HTML — decided before the response, so
// it cannot be decided by content-type. Three signals, any of which is enough: the
// Accept header, the fetch metadata a browser sends with a navigation, and a path with
// no file extension (every SSR route, and "/"). Assets miss all three, which is what
// keeps their revalidation working.
const mayBeDocument = (req) => {
  if (/text\/html/i.test(req.headers["accept"] ?? "")) return true;
  if ((req.headers["sec-fetch-dest"] ?? "") === "document") return true;
  const path = (req.url ?? "/").split(/[?#]/)[0];
  return !/\.[a-z0-9]+$/i.test(path);
};

// The validators upstream computed describe the *original* body, and we are about to
// rewrite it. Left alone they let a browser revalidate, get 304 Not Modified from the
// dev server — whose own HTML genuinely has not changed — and go on using a cached
// document with a stale injected tag in it. That survives restarts, renames and
// plugin updates, and presents as "the panel just stopped appearing".
const CONDITIONAL_HEADERS = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since"];
const VALIDATOR_HEADERS = ["etag", "last-modified"];

// The exact marker of an already-injected client: uitalk's own script src, which
// no ordinary page contains. Matching the bare "data-uitalk" substring instead
// would wrongly suppress injection on any page that merely mentions it — docs, an
// example, or an unrelated attribute like data-uitalk-demo.
const INJECTED_MARKER = "/__uitalk/client.js";

function injectInto(html, tag) {
  if (html.includes(INJECTED_MARKER)) return html;
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) return html.slice(0, head) + tag + html.slice(head);
  const body = html.search(/<\/body\s*>/i);
  if (body !== -1) return html.slice(0, body) + tag + html.slice(body);
  const open = html.search(/<html[^>]*>/i);
  if (open !== -1) {
    const at = html.indexOf(">", open) + 1;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

// How far to hold bytes waiting for </head> before placing the tag by fallback,
// and how much served HTML to keep for locate_source. Both bound memory so it does
// not grow with the response — a streamed SSR body flows through once injected.
const HEAD_SEARCH_CAP = 256 * 1024;
const CAPTURE_CAP = 2 * 1024 * 1024;

/**
 * Inject the client tag into a streaming HTML response without buffering the whole
 * body. Bytes are held only until the insertion point is found — normally within
 * <head>, near the top — then the tag is emitted once and everything after passes
 * straight through, so a server-rendered response stays streamed and memory stays
 * bounded. Slicing is done by byte offset, never by re-encoding a decoded string,
 * so a multi-byte character split across a chunk boundary is preserved intact.
 */
class InjectClient extends Transform {
  constructor(tag, onCapture) {
    super();
    this.tag = Buffer.from(tag, "utf8");
    this.onCapture = onCapture;
    this.pre = []; // bytes buffered before the injection point
    this.preLen = 0;
    this.injected = false;
    this.cap = []; // bounded copy of the served HTML, for locate_source
    this.capLen = 0;
  }

  _capture(chunk) {
    if (this.capLen >= CAPTURE_CAP) return;
    const room = CAPTURE_CAP - this.capLen;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.cap.push(slice);
    this.capLen += slice.length;
  }

  // The byte offset to inject at, or null while </head> may still be coming. The
  // priority matches injectInto(): before </head>, else (once we stop waiting)
  // before </body>, else after <html ...>, else the very front.
  _offset(s, final) {
    const head = /<\/head\s*>/i.exec(s);
    if (head) return Buffer.byteLength(s.slice(0, head.index), "utf8");
    if (!final && this.preLen < HEAD_SEARCH_CAP) return null;
    const body = final ? /<\/body\s*>/i.exec(s) : null;
    if (body) return Buffer.byteLength(s.slice(0, body.index), "utf8");
    const html = /<html[^>]*>/i.exec(s);
    if (html) return Buffer.byteLength(s.slice(0, html.index + html[0].length), "utf8");
    return 0; // prepend
  }

  _emit(buf, at) {
    this.push(buf.subarray(0, at));
    this.push(this.tag);
    this.push(buf.subarray(at));
    this.injected = true;
    this.pre = null;
  }

  _transform(chunk, _enc, cb) {
    this._capture(chunk);
    if (this.injected) {
      this.push(chunk);
      return cb();
    }
    this.pre.push(chunk);
    this.preLen += chunk.length;
    const buf = Buffer.concat(this.pre);
    const s = buf.toString("utf8");
    if (s.includes(INJECTED_MARKER)) {
      // already injected upstream (a re-proxied page) — do not inject twice
      this.injected = true;
      this.pre = null;
      this.push(buf);
      return cb();
    }
    const at = this._offset(s, false);
    if (at !== null) this._emit(buf, at);
    cb();
  }

  _flush(cb) {
    if (!this.injected) {
      const buf = Buffer.concat(this.pre);
      this._emit(buf, this._offset(buf.toString("utf8"), true));
    }
    this.onCapture?.(Buffer.concat(this.cap).toString("utf8"));
    cb();
  }
}

/** Ask upstream for a full body when we mean to rewrite it, never a 304. */
export function upstreamHeaders(req, target) {
  const headers = {
    ...req.headers,
    host: `${target.host}:${target.port}`,
    "accept-encoding": "identity",
  };
  if (mayBeDocument(req)) for (const name of CONDITIONAL_HEADERS) delete headers[name];
  return headers;
}

/**
 * @param {{ target: {host: string, port: number}, onInject?: (url: string) => void }} opts
 * @returns {(req, res) => void}
 */
export function createProxy({ target, onInject, onHtml, token }) {
  const clientTag = clientTagWith(token);
  return function proxy(req, res) {
    const upstream = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req, target),
      },
      (up) => {
        const headers = { ...up.headers };

        if (!isHtml(headers)) {
          // A non-HTML response gets nothing injected, so it keeps its own headers —
          // including any Content-Security-Policy. Stripping CSP is only for the HTML
          // branch below, where the injected <script> would otherwise be blocked;
          // doing it here would needlessly weaken an API/JSON/asset response's policy.
          res.writeHead(up.statusCode, headers);
          // If upstream drops mid-asset (a dev server restart, a socket reset),
          // `up` emits 'error'; with no listener that is an uncaught exception
          // that takes down the whole bridge. Tear the response down instead. Pair
          // it with the reverse so a client that aborts doesn't crash us either.
          up.on("error", () => res.destroy());
          res.on("error", () => up.destroy());
          up.pipe(res);
          return;
        }

        // This IS the HTML we inject a <script> into, so drop any Content-Security-
        // Policy — a strict one would refuse the injected client. (Only here: see the
        // non-HTML branch above, which keeps a response's CSP intact.)
        for (const name of CSP_HEADERS) delete headers[name];
        // We rewrite the body as it streams, so its length is unknown up front and
        // no longer whatever upstream said: drop content-length (the response goes
        // out chunked) and transfer/content-encoding, rather than leaving a stale
        // length or a chunked header beside our own framing.
        delete headers["transfer-encoding"];
        delete headers["content-encoding"];
        delete headers["content-length"];
        // A document we rewrote must not be cached or revalidated against upstream's
        // view of a body we changed. Assets keep their validators (they revalidate
        // untouched); losing those would make every reload refetch the whole app.
        for (const name of VALIDATOR_HEADERS) delete headers[name];
        headers["cache-control"] = "no-store, must-revalidate";
        res.writeHead(up.statusCode, headers);

        // Inject as the body streams through — the head arrives first, so the tag is
        // placed and the rest passes straight on without buffering the whole page.
        // A bounded copy is kept for locate_source (see onHtml): enough to place an
        // element, not the whole SSR stream.
        const inject = new InjectClient(clientTag, (html) => onHtml?.(req.url, html));
        // Any stream in the chain can fail — upstream dropping, the transform
        // throwing, the client aborting — and an unhandled 'error' on any of them
        // would crash the bridge. Tear the whole chain down on any of them.
        const teardown = () => { up.destroy(); inject.destroy(); res.destroy(); };
        up.on("error", teardown);
        inject.on("error", teardown);
        res.on("error", teardown);
        inject.on("end", () => onInject?.(req.url));
        up.pipe(inject).pipe(res);
      },
    );

    upstream.on("error", async (err) => {
      // A dev server that restarted on a different port is the usual cause, and a
      // bare ECONNREFUSED gives no hint of it. Look before reporting.
      const elsewhere = await findDevServers(target.port);
      if (res.headersSent) return res.destroy(); // already streaming a body; can't send a 502 now
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(diagnosis({ target, err, elsewhere, clientTag }));
    });

    // A client that aborts its request mid-upload would otherwise surface as an
    // unhandled 'error' on req; drop the upstream leg with it.
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  };
}

const CANDIDATE_PORTS = [5173, 5174, 5175, 5176, 3000, 3001, 4200, 8080, 8000, 1313];

const answers = (port, timeout = 250) =>
  new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });

async function findDevServers(exclude) {
  const found = await Promise.all(
    CANDIDATE_PORTS.filter((p) => p !== exclude).map(async (p) => ((await answers(p)) ? p : null)),
  );
  return found.filter(Boolean);
}

function diagnosis({ target, err, elsewhere, clientTag = CLIENT_TAG }) {
  const shell = (cmd) =>
    `<pre style="background:#f4f4f5;padding:10px 12px;border-radius:8px;overflow:auto">${cmd}</pre>`;

  const hint = elsewhere.length
    ? `<p><strong>Something is answering on ${elsewhere.map((p) => `:${p}`).join(", ")}.</strong> ` +
      `Your dev server has probably restarted on a different port — this bridge was pointed at ` +
      `${target.port} when it started. Repoint it:</p>` +
      shell(`uitalk --stop &amp;&amp; uitalk --app-port ${elsewhere[0]}`)
    : `<p>Nothing is answering on any of the usual dev-server ports either, so the app is not ` +
      `running. Start it, then reload this page:</p>` + shell("npm run dev") +
      `<p style="color:#666">Or let the bridge run it, so the two live and die together:</p>` +
      shell("uitalk --stop &amp;&amp; uitalk --dev &quot;npm run dev&quot;");

  return (
    `<!doctype html><meta charset="utf-8"><title>uitalk — no app</title>` +
    `<body style="font:14px/1.6 ui-sans-serif,system-ui,sans-serif;padding:40px;max-width:46em;color:#222">` +
    `<h1 style="font-size:17px;margin:0 0 4px">No app on ${target.host}:${target.port}</h1>` +
    `<p style="color:#666;margin-top:0">uitalk proxies your dev server, so that server has to be running.</p>` +
    hint +
    `<p style="color:#888;font-size:12px">${err.message}</p>` +
    // The panel rides on this page too. Losing the dev server should not also mean
    // losing the agent: leaving split screen lands here, and a page with no panel
    // looks like the tool itself vanished.
    clientTag
  );
}

/** HMR and any other app websocket has to reach the dev server untouched. */
export function proxyUpgrade({ target }) {
  return function upgrade(req, socket, head) {
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${target.host}:${target.port}` },
    });

    upstream.on("upgrade", (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (const [k, v] of Object.entries(upRes.headers)) {
        for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      // upHead is data the SERVER already sent past its upgrade response, so it
      // belongs to the client. unshift() put it back on the client socket's READ
      // side, which piped those server-origin — and therefore unmasked — frames
      // straight back to the server. A WebSocket server rejects an unmasked client
      // frame (WS_ERR_EXPECTED_MASK, 1002), and Vite's HMR socket has no error
      // handler, so the dev server crashed outright.
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });

    upstream.on("error", () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  };
}
