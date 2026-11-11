// Runs on a paired site, just before client.js, in the extension's isolated world:
// the site's own scripts share the DOM with it but cannot see its globals.
//
// The client opens its connection through __UITALK_CONNECT__ when one is defined.
// This one is a WebSocket-shaped object over a runtime Port to the service worker,
// which holds the real socket and the token — see background.js.

(() => {
  globalThis.__UITALK_EXTENSION__ = true;

  let invalidated = false; // the extension was reloaded or removed under this page

  class PortSocket {
    constructor() {
      this.readyState = 0;
      this.onopen = this.onclose = this.onerror = this.onmessage = null;
      this.port = null;
      this.ping = null;
      // Defer, so the caller has attached its handlers before anything fires.
      queueMicrotask(() => this.start());
    }

    start() {
      if (invalidated) return this.finish();
      try {
        this.port = chrome.runtime.connect({ name: "uitalk-socket" });
      } catch {
        // "Extension context invalidated": the extension was updated or reloaded, and
        // this page still runs the scripts of the old one. Only a reload fixes that.
        invalidated = true;
        this.deliver({ kind: "error", text: "the uitalk extension was updated or reloaded — reload this page to reconnect" });
        return this.finish();
      }
      this.port.onMessage.addListener((m) => {
        if (m?.type === "open") {
          this.readyState = 1;
          this.onopen?.({});
        } else if (m?.type === "message") {
          this.onmessage?.({ data: m.data });
        } else if (m?.type === "refused") {
          this.deliver({ kind: "error", text: m.text });
        }
      });
      this.port.onDisconnect.addListener(() => this.finish());
      this.port.postMessage({ type: "hello", build: globalThis.__UITALK_BUILD__ ?? null });
      // A message from the page is what keeps the service worker, and with it the
      // socket, alive between turns.
      this.ping = setInterval(() => {
        try {
          this.port?.postMessage({ type: "ping" });
        } catch {
          this.finish();
        }
      }, 20000);
    }

    deliver(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }

    send(data) {
      if (this.readyState !== 1) return;
      try {
        this.port.postMessage({ type: "send", data });
      } catch {
        this.finish();
      }
    }

    close() {
      try {
        this.port?.disconnect();
      } catch {}
      this.finish();
    }

    finish() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      clearInterval(this.ping);
      this.port = null;
      this.onclose?.({});
    }
  }

  globalThis.__UITALK_CONNECT__ = () => new PortSocket();
})();
