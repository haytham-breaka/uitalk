// A reverse proxy in front of the app's dev server.
//
// Browse the proxy port instead of the app's and one script tag is injected into
// every HTML response as it passes through. This is the whole reason the tool
// needs no per-framework handling: the injection happens on rendered HTML, so a
// server-rendered document shell is indistinguishable from a static file, and
// nothing in the project is ever written to.

import { request as httpRequest } from "node:http";
import { connect } from "node:net";

const CLIENT_TAG = `<script src="/__uitalk/client.js" data-uitalk></script>`;

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

function injectInto(html) {
  if (html.includes("data-uitalk")) return html;
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) return html.slice(0, head) + CLIENT_TAG + html.slice(head);
  const body = html.search(/<\/body\s*>/i);
  if (body !== -1) return html.slice(0, body) + CLIENT_TAG + html.slice(body);
  const open = html.search(/<html[^>]*>/i);
  if (open !== -1) {
    const at = html.indexOf(">", open) + 1;
    return html.slice(0, at) + CLIENT_TAG + html.slice(at);
  }
  return CLIENT_TAG + html;
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
export function createProxy({ target, onInject, onHtml }) {
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
        for (const name of CSP_HEADERS) delete headers[name];

        if (!isHtml(headers)) {
          res.writeHead(up.statusCode, headers);
          up.pipe(res);
          return;
        }

        // Buffer only HTML, which is small, so the tag can be placed correctly.
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const original = Buffer.concat(chunks).toString("utf8");
          // Keep what was served: for a static site this *is* the source, and for a
          // rendered one it still locates the block. It is the only source signal
          // that needs nothing from the framework.
          onHtml?.(req.url, original);
          const html = injectInto(original);
          const body = Buffer.from(html, "utf8");

          // We buffered and rewrote the body, so it is no longer chunked and no
          // longer whatever length upstream said. Leaving transfer-encoding in place
          // beside a content-length is an invalid response that strict clients reject
          // outright — and most dev servers chunk dynamic HTML.
          delete headers["transfer-encoding"];
          delete headers["content-encoding"];
          delete headers["content-length"];
          headers["content-length"] = String(body.length);

          // And the document we just built must not be cached or revalidated against
          // upstream's view of a body we changed. Assets keep their validators: losing
          // those would make every reload refetch the whole app.
          for (const name of VALIDATOR_HEADERS) delete headers[name];
          headers["cache-control"] = "no-store, must-revalidate";
          res.writeHead(up.statusCode, headers);
          res.end(body);
          onInject?.(req.url);
        });
      },
    );

    upstream.on("error", async (err) => {
      // A dev server that restarted on a different port is the usual cause, and a
      // bare ECONNREFUSED gives no hint of it. Look before reporting.
      const elsewhere = await findDevServers(target.port);
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(diagnosis({ target, err, elsewhere }));
    });

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

function diagnosis({ target, err, elsewhere }) {
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
    CLIENT_TAG
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
