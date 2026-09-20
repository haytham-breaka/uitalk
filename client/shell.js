// Split-screen shell: the app in a resizable frame, the panel beside it.
//
// The frame is not decoration. Media queries answer to a real viewport, so the
// only way to see a genuine mobile layout is to give the app a viewport that size
// — which means an iframe. Resizing a div would change nothing a `@media` rule can
// observe. Because the frame is served by the same proxy, it is same-origin, so
// the panel reaches into it directly rather than negotiating postMessage.

globalThis.UITalkShell = (() => {
  if (!globalThis.__UITALK_SHELL__) return null;

  const DEVICES = [
    { id: "fit", label: "Fit", w: 0, h: 0 },
    { id: "iphone-se", label: "iPhone SE", w: 375, h: 667 },
    { id: "iphone-14", label: "iPhone 14", w: 390, h: 844 },
    { id: "pixel-7", label: "Pixel 7", w: 412, h: 915 },
    { id: "ipad-mini", label: "iPad mini", w: 744, h: 1133 },
    { id: "ipad-pro", label: "iPad Pro", w: 1024, h: 1366 },
    { id: "laptop", label: "Laptop", w: 1280, h: 800 },
    { id: "desktop", label: "Desktop", w: 1440, h: 900 },
  ];

  const state = { device: "fit", portrait: true, zoom: 0, dock: "right" };
  const CUSTOM = DEVICES[0]; // the "Fit" slot doubles as the custom size

  // The frame names a same-origin path via the hash (#/dashboard). A hash like
  // #//evil.com would resolve cross-origin through the origin base, loading a
  // foreign page into the stage; the frame is meant to be same-origin (see top),
  // so anything that resolves elsewhere falls back to the root.
  const frameHref = (raw) => {
    const u = new URL(raw || "/", location.origin);
    return (u.origin === location.origin ? u : new URL("/", location.origin)).href;
  };
  const listeners = new Set();
  let frame = null;
  let bar = null;
  let stage = null;
  let shim = null;

  const device = () => DEVICES.find((d) => d.id === state.device) ?? DEVICES[0];

  function size() {
    const d = device();
    if (!d.w) return { w: stage.clientWidth, h: stage.clientHeight, label: "Fit", free: true };
    const [w, h] = state.portrait ? [d.w, d.h] : [d.h, d.w];
    return { w, h, label: d.label, free: false };
  }

  // Scale a device larger than the stage down to fit, so an iPad is inspectable on
  // a laptop. The app still believes it has the full device viewport.
  function scale() {
    if (state.zoom) return state.zoom;
    const { w, h, free } = size();
    if (free) return 1;
    // A stage narrower than the padding would otherwise yield a zero or negative
    // scale, which collapses the frame and reports nonsense as the zoom level.
    const fit = Math.min(1, (stage.clientWidth - 32) / w, (stage.clientHeight - 32) / h);
    return Math.max(0.2, Number.isFinite(fit) ? fit : 1);
  }

  function apply() {
    const { w, h, free } = size();
    const s = scale();

    if (free) {
      Object.assign(frame.style, { width: "100%", height: "100%", transform: "none" });
      Object.assign(shim.style, { width: "100%", height: "100%" });
    } else {
      Object.assign(frame.style, {
        width: `${w}px`, height: `${h}px`,
        transform: `scale(${s})`, transformOrigin: "top left",
      });
      Object.assign(shim.style, { width: `${w * s}px`, height: `${h * s}px` });
    }

    document.documentElement.dataset.uitalkDock = state.dock;
    bar.querySelector("[data-act=dock]").textContent = `Panel: ${state.dock} ▸`;
    for (const btn of bar.querySelectorAll("[data-device]")) {
      btn.classList.toggle("on", btn.dataset.device === state.device);
    }
    bar.querySelector("[data-act=rotate]").disabled = !device().w;
    bar.querySelector(".readout").textContent = free
      ? `${Math.round(stage.clientWidth)}×${Math.round(stage.clientHeight)} · fit`
      : `${w}×${h} · ${state.portrait ? "portrait" : "landscape"}${s < 0.999 ? ` · ${Math.round(s * 100)}%` : ""}`;

    for (const fn of listeners) fn();
  }

  function build() {
    document.documentElement.dataset.uitalkShell = "1";

    const style = document.createElement("style");
    style.textContent = `
      html, body { margin: 0; height: 100%; background: #0b0c0f; }
      html[data-uitalk-dock="right"] #uitalk-stage { right: 392px; }
      html[data-uitalk-dock="left"]  #uitalk-stage { left: 392px; }
      html[data-uitalk-dock="bottom"] #uitalk-stage { bottom: 332px; }
      #uitalk-bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; display: flex;
                align-items: center; gap: 5px; padding: 0 10px; background: #14161a;
                border-bottom: 1px solid #2c3039; color: #e8eaed; z-index: 3;
                font: 12px/1 ui-sans-serif, system-ui, sans-serif; overflow-x: auto; }
      #uitalk-bar button, #uitalk-bar select, #uitalk-bar input {
        font: inherit; color: #e8eaed; background: #20242b; border: 1px solid #333842;
        border-radius: 6px; padding: 4px 8px; cursor: pointer; white-space: nowrap; }
      #uitalk-bar button:hover:not(:disabled) { background: #272c34; }
      #uitalk-bar button.on { background: #1d4ed8; border-color: #1d4ed8; }
      #uitalk-bar button:disabled { opacity: .4; cursor: default; }
      #uitalk-bar input[type=number] { width: 62px; cursor: text; }
      #uitalk-bar .readout { margin-left: auto; color: #868d98; padding-left: 10px; }
      #uitalk-bar .sep { width: 1px; height: 20px; background: #2c3039; margin: 0 3px; }
      #uitalk-stage { position: fixed; top: 40px; left: 0; right: 0; bottom: 0; overflow: auto;
                  display: flex; align-items: flex-start; justify-content: center; padding: 16px; }
      #uitalk-shim { position: relative; }
      #uitalk-app { position: absolute; top: 0; left: 0; border: 0; background: #fff;
                box-shadow: 0 0 0 1px #2c3039, 0 18px 50px rgb(0 0 0 / .5); }

      /* Drag the frame's edges to size it by hand. The corner does both at once. */
      .uitalk-grip { position: absolute; background: transparent; z-index: 2; }
      .uitalk-grip::after { content: ""; position: absolute; inset: 0; margin: auto; background: #3a4150;
                        border-radius: 3px; transition: background .15s; }
      .uitalk-grip:hover::after, .uitalk-grip.dragging::after { background: #1d4ed8; }
      .uitalk-grip.e { top: 0; bottom: 0; right: -9px; width: 18px; cursor: ew-resize; }
      .uitalk-grip.e::after { width: 4px; height: 40px; }
      .uitalk-grip.s { left: 0; right: 0; bottom: -9px; height: 18px; cursor: ns-resize; }
      .uitalk-grip.s::after { width: 40px; height: 4px; }
      .uitalk-grip.se { right: -9px; bottom: -9px; width: 18px; height: 18px; cursor: nwse-resize; }
      .uitalk-grip.se::after { width: 9px; height: 9px; border-radius: 0 0 3px 0;
                           border-right: 3px solid #3a4150; border-bottom: 3px solid #3a4150;
                           background: none; }
      .uitalk-grip.se:hover::after, .uitalk-grip.se.dragging::after {
        border-right-color: #1d4ed8; border-bottom-color: #1d4ed8; background: none; }
      html[data-uitalk-dock="bottom"] .panel { right: 16px !important; }
    `;
    document.head.appendChild(style);

    bar = document.createElement("div");
    bar.id = "uitalk-bar";
    bar.innerHTML =
      DEVICES.map((d) => `<button data-device="${d.id}">${d.label}</button>`).join("") +
      `<span class="sep"></span>` +
      `<button data-act="rotate" title="Swap width and height">⟲ Rotate</button>` +
      `<span class="sep"></span>` +
      `<input type="number" class="cw" placeholder="w" min="200" max="4000">` +
      `<input type="number" class="ch" placeholder="h" min="200" max="4000">` +
      `<button data-act="custom">Set</button>` +
      `<span class="sep"></span>` +
      `<button data-act="dock" title="Move the chat panel to another edge of the screen">Panel: right ▸</button>` +
      `<span class="readout"></span>`;
    document.body.appendChild(bar);

    stage = document.createElement("div");
    stage.id = "uitalk-stage";
    shim = document.createElement("div");
    shim.id = "uitalk-shim";
    frame = document.createElement("iframe");
    frame.id = "uitalk-app";
    frame.src = frameHref(location.hash.slice(1));
    shim.appendChild(frame);
    for (const edge of ["e", "s", "se"]) {
      const grip = document.createElement("div");
      grip.className = `uitalk-grip ${edge}`;
      grip.dataset.edge = edge;
      grip.title = edge === "e" ? "Drag to set width" : edge === "s" ? "Drag to set height" : "Drag to set both";
      shim.appendChild(grip);
    }
    stage.appendChild(shim);
    document.body.appendChild(stage);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.dataset.device) {
        // Presets are defined portrait-first, so selecting one starts portrait.
        if (btn.dataset.device === "fit") { CUSTOM.w = 0; CUSTOM.h = 0; CUSTOM.label = "Fit"; }
        state.device = btn.dataset.device;
        state.portrait = true;
        state.zoom = 0;
      }
      if (btn.dataset.act === "rotate") state.portrait = !state.portrait;
      if (btn.dataset.act === "custom") {
        const w = Number(bar.querySelector(".cw").value);
        const h = Number(bar.querySelector(".ch").value);
        if (w >= 200 && h >= 200) {
          CUSTOM.w = w;
          CUSTOM.h = h;
          CUSTOM.label = "Custom";
          state.device = "fit";
          state.portrait = true;
        }
      }
      if (btn.dataset.act === "dock") {
        state.dock = { right: "bottom", bottom: "left", left: "right" }[state.dock];
      }
      apply();
    });

    // Dragging an edge switches to the custom size, so a hand-set width is not
    // silently overwritten the next time apply() reads a preset.
    let drag = null;

    shim.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest(".uitalk-grip");
      if (!grip) return;
      const { w, h } = size();
      drag = { edge: grip.dataset.edge, x: e.clientX, y: e.clientY, w, h, grip };
      grip.classList.add("dragging");
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    shim.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const s = scale();
      // The frame is drawn scaled, so pointer travel has to be divided by it or a
      // scaled-down device would resize faster than the cursor moves.
      const next = {
        w: drag.edge === "s" ? drag.w : Math.round(drag.w + (e.clientX - drag.x) / s),
        h: drag.edge === "e" ? drag.h : Math.round(drag.h + (e.clientY - drag.y) / s),
      };
      CUSTOM.w = Math.max(200, Math.min(4000, next.w));
      CUSTOM.h = Math.max(200, Math.min(4000, next.h));
      CUSTOM.label = "Custom";
      state.device = "fit";
      state.portrait = true;
      state.zoom = 0;
      apply();
    });

    shim.addEventListener("pointerup", (e) => {
      if (!drag) return;
      drag.grip.classList.remove("dragging");
      drag.grip.releasePointerCapture(e.pointerId);
      drag = null;
      bar.querySelector(".cw").value = CUSTOM.w;
      bar.querySelector(".ch").value = CUSTOM.h;
    });

    addEventListener("resize", apply);
    frame.addEventListener("load", () => {
      // replaceState, not `location.hash = ...`: assigning the hash pushed a
      // top-level history entry for every frame load, so the browser's Back button
      // spent its steps undoing those instead of moving the app.
      try {
        const l = frame.contentWindow.location;
        history.replaceState(null, "", `#${l.pathname}${l.search}`);
      } catch {}
      apply();
      for (const fn of listeners) fn();
    });

    // If a Back does land on an older hash, put the frame where it says.
    const syncFrameToHash = () => {
      const want = location.hash.slice(1) || "/";
      let have = null;
      try {
        const l = frame.contentWindow.location;
        have = l.pathname + l.search;
      } catch {}
      if (have !== null && want !== have) {
        try {
          frame.contentWindow.location.replace(frameHref(want));
        } catch {}
      }
    };
    addEventListener("popstate", syncFrameToHash);
    addEventListener("hashchange", syncFrameToHash);
    apply();
  }

  build();

  return {
    /** The injected client inside the frame — the panel's API. */
    frameApi: () => {
      try {
        return frame.contentWindow?.UITalk ?? null;
      } catch {
        return null;
      }
    },
    frameWindow: () => {
      try {
        return frame.contentWindow ?? null;
      } catch {
        return null;
      }
    },
    /** Frame coordinates -> shell coordinates. */
    transform: () => {
      const r = frame.getBoundingClientRect();
      return { left: r.left, top: r.top, scale: scale() };
    },
    /** Describes the simulated screen, for the metadata sent with each message. */
    screen: () => {
      const { w, h, label, free } = size();
      // Read the orientation off the dimensions rather than tracking it: whatever
      // the rotate button and the presets did, the numbers cannot disagree.
      return {
        preset: free ? "Fit" : label,
        width: Math.round(w),
        height: Math.round(h),
        orientation: w >= h ? "landscape" : "portrait",
        zoom: Math.round(scale() * 100) / 100,
      };
    },
    /**
     * Resize the frame, let it settle, run fn, then put it back. Used to look at
     * one element across several widths without the user losing their place.
     */
    async withWidth(width, fn) {
      const before = { device: state.device, portrait: state.portrait, zoom: state.zoom,
                       w: CUSTOM.w, h: CUSTOM.h, label: CUSTOM.label };
      try {
        CUSTOM.w = width;
        CUSTOM.h = Math.max(600, before.h || 900);
        CUSTOM.label = `${width}px`;
        state.device = "fit";
        state.portrait = true;
        state.zoom = 0;
        apply();
        // Two frames for layout, then a beat for anything that animates on resize.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 120));
        return await fn();
      } finally {
        Object.assign(CUSTOM, { w: before.w, h: before.h, label: before.label });
        state.device = before.device;
        state.portrait = before.portrait;
        state.zoom = before.zoom;
        apply();
      }
    },

    /** Which edge the panel sits on. The panel lives in a shadow root, so it cannot
     *  see the document attribute and has to be told. */
    dock: () => state.dock,
    onChange: (fn) => listeners.add(fn),
    element: () => frame,
  };
})();
