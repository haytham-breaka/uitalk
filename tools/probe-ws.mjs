// HMR passes through the proxy as a raw socket relay, and getting the direction
// wrong corrupts the stream: server-origin frames fed back to the server are
// unmasked, which a WebSocket server rejects with 1002 — and Vite has no handler
// for that, so the dev server dies. This stands an upstream WS server behind the
// proxy and pushes traffic both ways.
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { createProxy, proxyUpgrade } from "../server/proxy.mjs";

const fail = [];
const check = (n, ok, d) => { console.log(`${ok ? "  ok  " : " FAIL "} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail.push(n); };

// upstream: an app with an HMR-style websocket
const appErrors = [];
const app = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>hi</body></html>"); });
const appWss = new WebSocketServer({ server: app, path: "/hmr" });
appWss.on("connection", (ws) => {
  ws.on("error", (e) => appErrors.push(e.code ?? e.message));
  ws.on("message", (m) => ws.send(`echo:${m}`));
  ws.send("hello-from-server");
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const appPort = app.address().port;

// the bridge in front of it
const target = { host: "127.0.0.1", port: appPort };
const proxy = createServer(createProxy({ target }));
proxy.on("upgrade", proxyUpgrade({ target }));
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;

const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/hmr`);
const seen = [];
client.on("message", (m) => seen.push(m.toString()));
await new Promise((res, rej) => {
  client.on("open", res);
  client.on("error", rej);
  setTimeout(() => rej(new Error("never connected")), 5000);
});
check("the websocket upgrades through the proxy", client.readyState === WebSocket.OPEN);

await new Promise((r) => setTimeout(r, 300));
check("the server's first push reaches the client", seen.includes("hello-from-server"), seen.join(", "));

client.send("ping");
await new Promise((r) => setTimeout(r, 300));
check("client frames reach the server and come back", seen.some((m) => m === "echo:ping"), seen.join(", "));

for (let i = 0; i < 20; i++) client.send(`burst-${i}`);
await new Promise((r) => setTimeout(r, 600));
check("a burst survives intact", seen.filter((m) => m.startsWith("echo:burst-")).length === 20,
  `${seen.filter((m) => m.startsWith("echo:burst-")).length} of 20`);

check("the upstream saw no protocol errors", appErrors.length === 0, appErrors.join(", ") || "none");

client.close();
appWss.close(); app.close(); proxy.close();

// --- the case that actually bit: a server that packs its first frame into the
// same TCP write as the 101 response. Node hands those bytes to the proxy as the
// upgrade `head`, and sending them the wrong way loses them (and, against a real
// ws server, feeds unmasked frames back upstream until it dies with 1002).
{
  const { createHash } = await import("node:crypto");
  const { createServer: createRawServer } = await import("node:net");

  const raw = createRawServer((sock) => {
    sock.once("data", (buf) => {
      const key = /sec-websocket-key: (.+)/i.exec(buf.toString())?.[1]?.trim() ?? "";
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      const frame = Buffer.from([0x81, 0x04, 0x62, 0x6f, 0x6f, 0x74]); // unmasked "boot"
      // one write: headers AND the first frame, so the frame arrives as `head`
      sock.write(Buffer.concat([
        Buffer.from(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        ),
        frame,
      ]));
    });
  });
  await new Promise((r) => raw.listen(0, "127.0.0.1", r));
  const rawTarget = { host: "127.0.0.1", port: raw.address().port };

  const p2 = createServer(createProxy({ target: rawTarget }));
  p2.on("upgrade", proxyUpgrade({ target: rawTarget }));
  await new Promise((r) => p2.listen(0, "127.0.0.1", r));

  const c2 = new WebSocket(`ws://127.0.0.1:${p2.address().port}/hmr`);
  const got = [];
  c2.on("message", (m) => got.push(m.toString()));
  await new Promise((res) => { c2.on("open", res); c2.on("error", res); setTimeout(res, 3000); });
  await new Promise((r) => setTimeout(r, 400));

  check("a frame packed into the handshake still reaches the client",
    got.includes("boot"), got.join(", ") || "nothing arrived");

  c2.close(); p2.close(); raw.close();
}
console.log(fail.length ? `\n${fail.length} failing` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
