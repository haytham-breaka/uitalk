// The in-page surface: a floating launcher that opens a tool palette.
//
// Everything lives in a shadow root so the host app's CSS cannot reach it and
// ours cannot leak out. The launcher is draggable, because the one place it
// should never sit is on top of the thing you want to edit.

(() => {
  // Inside the shell's frame the app only needs the API; the panel lives in the
  // shell, so rendering a second one here would put it inside the simulated phone.
  const embedded = (() => {
    try {
      return window.parent !== window && window.parent.document.documentElement.dataset.uitalkShell === "1";
    } catch {
      return false;
    }
  })();
  if (embedded) return;

  const shell = globalThis.UITalkShell ?? null;
  const SOCKET = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/__uitalk/socket`;

  // In the shell the API lives in the frame, and the frame can be mid-navigation,
  // so every call goes through an accessor with an inert stand-in behind it.
  const INERT = {
    picked: [],
    optionState: null,
    pick: () => null, unpick: () => null, pickArea: () => ({ added: [], total: 0 }),
    clearSelection: () => ({ cleared: 0, previewCleared: false }),
    readSelection: () => ({ selected: 0 }), capture: async () => { throw new Error("the app frame is not ready"); },
    scanRegion: () => ({ elements: [] }), tryStyle: () => {}, tryMarkup: () => {},
    showOptions: () => {}, resetPreview: () => {}, flip: () => {}, chosenOption: () => null,
    dismissOptions: () => {}, identify: () => ({}), setUiHost: () => {},
    pageContext: () => ({ path: location.pathname, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } }),
  };
  const api = () => (shell ? shell.frameApi() ?? INERT : UITalk);
  const source = () => (shell ? shell.frameWindow() ?? window : window);
  const xform = () => (shell ? shell.transform() : { left: 0, top: 0, scale: 1 });

  const host = document.createElement("div");
  host.id = "uitalk-host";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);
  api().setUiHost?.(host);

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
      .layer { position: fixed; inset: 0; pointer-events: none; }
      .badge { position: fixed; min-width: 20px; height: 20px; padding: 0 6px; display: flex;
               align-items: center; justify-content: center; line-height: 1;
               border-radius: 10px; background: #1d4ed8; color: #fff;
               font-weight: 700; font-size: 11px; box-shadow: 0 1px 5px rgb(0 0 0 / .45);
               pointer-events: auto; cursor: pointer; }
      .badge:hover { background: #b4472f; }
      .badge:hover::after { content: "✕"; position: absolute; font-size: 9px; }
      .ring  { position: fixed; border: 2px solid #1d4ed8; border-radius: 3px; }
      .hover { position: fixed; border: 2px dashed #1d4ed8; background: rgb(29 78 216 / .08); }
      .marquee { position: fixed; border: 1px solid #1d4ed8; background: rgb(29 78 216 / .14);
                 border-radius: 2px; pointer-events: none; }
      .marquee.shot { border-style: dashed; border-color: #e0a03a; background: rgb(224 160 58 / .12); }

      /* The chosen area stays visible through the wait, and changes state when the
         shutter is about to roll — otherwise the countdown is the only clue and it
         is nowhere near the thing being photographed. */
      .armed { position: fixed; pointer-events: none; border-radius: 2px;
               border: 2px dashed #e0a03a; background: rgb(224 160 58 / .10); }
      .armed .tag { position: absolute; top: -20px; left: 0; padding: 1px 6px; border-radius: 3px;
                    background: #e0a03a; color: #14161a; font: 700 10px/1.5 ui-sans-serif, system-ui, sans-serif;
                    white-space: nowrap; }
      .armed.rolling { border-style: solid; border-color: #d3553f; background: rgb(211 85 63 / .10);
                       animation: lbpulse .9s ease-in-out infinite; }
      .armed.rolling .tag { background: #d3553f; color: #fff; }
      @keyframes lbpulse { 0%, 100% { border-color: #d3553f; } 50% { border-color: #f0836c; } }
      /* What the marquee would take, shown while the drag is still in progress. */
      .cand { position: fixed; border: 2px solid #2ea043; background: rgb(46 160 67 / .14);
              border-radius: 2px; pointer-events: none; }
      .cand.already { border-color: #1d4ed8; border-style: dotted; background: none; }
      .cand .n { position: absolute; top: -1px; left: -1px; background: #2ea043; color: #fff;
                 font-size: 9px; font-weight: 700; padding: 0 3px; border-radius: 2px; }

      .fab { position: fixed; right: 20px; bottom: 20px; width: 46px; height: 46px; border-radius: 23px;
             pointer-events: auto; cursor: pointer; display: grid; place-items: center;
             background: #14161a; border: 1px solid #31363f; color: #e8eaed;
             box-shadow: 0 6px 22px rgb(0 0 0 / .45); user-select: none; }
      .fab:hover { border-color: #1d4ed8; }
      .fab.dragging { cursor: grabbing; }
      .fab.armed { background: #1d4ed8; border-color: #1d4ed8; }
      .fab .mark { width: 23px; height: 23px; display: block; }
      .fab .mark .frame { fill: none; stroke: currentColor; stroke-width: 1.7;
                          stroke-linecap: round; stroke-linejoin: round; opacity: .75; }
      .fab .mark .arrow { fill: currentColor; }
      .fab:hover .mark .frame, .fab.armed .mark .frame { opacity: 1; }
      .fab .pip { position: absolute; top: -3px; right: -3px; min-width: 17px; height: 17px; padding: 0 4px;
                  border-radius: 9px; background: #1d4ed8; color: #fff; font-size: 10px; font-weight: 700;
                  display: none; place-items: center; border: 2px solid #14161a; }
      .fab .pip.on { display: grid; }
      .fab .link { position: absolute; bottom: -1px; left: -1px; width: 9px; height: 9px;
                   border-radius: 50%; background: #d33; border: 2px solid #14161a; }
      .fab .link.on { background: #2ea043; }

      .panel { position: fixed; right: 20px; bottom: 78px; width: 372px; height: 520px;
               max-height: 82vh; min-height: 220px;
               display: none; flex-direction: column; pointer-events: auto; overflow: hidden;
               background: #14161a; color: #e8eaed; border: 1px solid #2c3039; border-radius: 13px;
               box-shadow: 0 16px 48px rgb(0 0 0 / .55); }
      .panel.open { display: flex; }

      /* Height on the top edge, width on the left edge (the panel is anchored
         right, so the left edge is the one that can move), both at the corner. */
      .grip { height: 8px; flex: 0 0 8px; cursor: ns-resize; display: grid; place-items: center; }
      .grip::after { content: ""; width: 34px; height: 3px; border-radius: 2px; background: #343a44; }
      .grip:hover::after, .grip.dragging::after { background: #1d4ed8; }

      .grip-w { position: absolute; left: 0; top: 0; bottom: 0; width: 9px; cursor: ew-resize; z-index: 2; }
      .grip-w::after { content: ""; position: absolute; top: 50%; left: 3px; width: 3px; height: 34px;
                       margin-top: -17px; border-radius: 2px; background: #343a44; }
      .grip-w:hover::after, .grip-w.dragging::after { background: #1d4ed8; }

      .grip-nw { position: absolute; left: 0; top: 0; width: 15px; height: 15px;
                 cursor: nwse-resize; z-index: 3; }
      .grip-nw::after { content: ""; position: absolute; left: 3px; top: 3px; width: 7px; height: 7px;
                        border-left: 3px solid #343a44; border-top: 3px solid #343a44;
                        border-radius: 3px 0 0 0; }
      .grip-nw:hover::after, .grip-nw.dragging::after { border-color: #1d4ed8; }

      .panel.docked .grip-w, .panel.docked .grip-nw { display: none; }

      /* Docked in the shell, the panel *is* the split column, so the transcript
         should own it. Everything else is capped so it cannot crowd the chat out. */
      .panel.docked { right: 0; left: auto; top: 40px; bottom: 0; width: 392px;
                      height: auto; max-height: none; border-radius: 0;
                      border-top: 0; border-right: 0; border-bottom: 0; box-shadow: none; }
      .panel.docked .grip { display: none; }
      .panel.docked .log { flex: 1 1 auto; min-height: 0; }
      .panel.docked .tray { max-height: 34%; overflow-y: auto; }
      .panel.docked .settings { flex: 1 1 auto; min-height: 0; }
      .panel.docked textarea { height: 92px; }
      .panel.docked .att img { max-height: 68px; max-width: 168px; }
      .panel.docked.dock-left { left: 0; right: auto;
                                border-left: 0; border-right: 1px solid #2c3039; }
      .panel.docked.dock-bottom { left: 0; right: 0; top: auto; height: 332px; width: auto;
                                  border-left: 0; border-right: 0; border-bottom: 0;
                                  border-top: 1px solid #2c3039; }

      .tools { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 9px;
               border-bottom: 1px solid #2c3039; }
      .tool { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 2px;
              border-radius: 8px; border: 1px solid #2a2f38; background: #1a1d23; cursor: pointer;
              color: #c9ced8; font-size: 10.5px; }
      .tool:hover { background: #21252c; color: #fff; }
      .tool.on { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
      .tool.queued { border-color: #1d4ed8; color: #fff; }
      .tool.queued .g::after { content: "•"; color: #1d4ed8; font-size: 18px; vertical-align: top; }
      .tool.queued[data-count]:not([data-count=""]) .g::after { content: attr(data-count); font-size: 10px;
        background: #1d4ed8; color: #fff; border-radius: 7px; padding: 0 4px; vertical-align: super; }
      .tool .g { font-size: 15px; line-height: 1.1; }

      .tray { display: none; flex-direction: column; gap: 6px; padding: 7px 10px;
              border-bottom: 1px solid #2c3039; background: #171a1f; }
      .tray.on { display: flex; }
      .capopts { display: none; align-items: center; gap: 10px; font-size: 10.5px; color: #868d98; }
      .capopts.on { display: flex; }
      .capopts label { display: inline-flex; align-items: center; gap: 4px; }
      .capopts select { font: inherit; font-size: 10.5px; background: #1b1e24; color: #e8eaed;
                        border: 1px solid #333842; border-radius: 5px; padding: 1px 3px; }
      .capopts .every { display: none; }
      .capopts.motion .every { display: inline-flex; }
      .chips { display: flex; flex-wrap: wrap; gap: 4px; }
      .chip-sel { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
                  background: #1d4ed8; color: #fff; border-radius: 10px; padding: 1px 4px 1px 7px; }
      .chip-sel b { font-weight: 700; }
      .chip-sel .x { cursor: pointer; opacity: .7; padding: 0 3px; line-height: 1;
                     display: inline-flex; align-items: center; }
      .chip-sel .x:hover { opacity: 1; }
      .att { display: none; flex-direction: column; gap: 6px; }
      .att.on { display: flex; }
      .strip { display: flex; flex-wrap: wrap; gap: 10px; padding: 7px 7px 0 0; }
      .thumb { position: relative; display: inline-flex; }
      /* The cross is drawn, not typed. A text glyph sits wherever the font's
         metrics put it, which is why it kept looking off-centre at this size. */
      .thumb .x { position: absolute; top: -7px; right: -7px; width: 16px; height: 16px;
                  border-radius: 50%; background: #14161a; border: 1px solid #333842;
                  color: #c9ced8; font-size: 0; padding: 0; cursor: pointer; }
      .thumb .x::before, .thumb .x::after {
        content: ""; position: absolute; top: 50%; left: 50%;
        width: 8px; height: 1.5px; border-radius: 1px; background: currentColor; }
      .thumb .x::before { transform: translate(-50%, -50%) rotate(45deg); }
      .thumb .x::after { transform: translate(-50%, -50%) rotate(-45deg); }
      .thumb .x:hover { background: #d3553f; color: #fff; border-color: #d3553f; }
      .thumb .count { position: absolute; left: -6px; bottom: -6px; padding: 0 5px; height: 15px;
                      border-radius: 8px; background: #1d4ed8; color: #fff; font-size: 9px;
                      font-weight: 700; line-height: 15px; cursor: pointer; }
      .thumb .count:hover { background: #3b6ae1; }
      .strip .fold { align-self: center; font-size: 10px; padding: 2px 8px; }
      .att img { max-height: 54px; max-width: 150px; border-radius: 5px; border: 1px solid #333842;
                 cursor: zoom-in; background: #0d0f12; }

      /* Enlarging inside the panel was pointless: the panel has a fixed height and
         hides its overflow, so a big image was clipped by its own container. */
      .lightbox { position: fixed; inset: 0; display: none; pointer-events: auto; z-index: 1;
                  background: rgb(8 9 11 / .88); padding: 24px; overflow: auto;
                  place-items: center; cursor: zoom-out; }
      .lightbox.on { display: grid; }
      .lightbox img { max-width: 100%; max-height: calc(100vh - 96px); border-radius: 6px;
                      border: 1px solid #333842; background: #0d0f12; }
      .lightbox .cap { position: fixed; top: 14px; left: 0; right: 0; text-align: center;
                       color: #c9ced8; font-size: 11.5px; }
      .lightbox .drop { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
                        cursor: pointer; }
      .lightbox .drop:hover { background: #d3553f; border-color: #d3553f; color: #fff; }
      .att .meta { font-size: 10.5px; color: #868d98; display: flex; align-items: center; gap: 8px; }
      .att .x { cursor: pointer; color: #868d98; font-size: 11px; line-height: 1; }
      .att .x:hover { color: #d3553f; }
      .hint { font-size: 10.5px; color: #868d98; min-height: 0; }
      .undo { display: none; align-self: flex-start; font-size: 10.5px; padding: 2px 8px; }
      .undo.on { display: inline-flex; }
      .undo:hover { background: #d3553f; border-color: #d3553f; color: #fff; }

      .log { flex: 1 1 auto; min-height: 90px; overflow-y: auto; padding: 10px;
             display: flex; flex-direction: column; gap: 7px; }
      .msg { padding: 7px 9px; border-radius: 9px; white-space: pre-wrap; word-break: break-word; }
      .msg.me { background: #1d4ed8; color: #fff; align-self: flex-end; max-width: 86%; }
      .msg.agent { background: #1b1e24; max-width: 96%; white-space: normal; }
      .msg.agent .md-run:first-child { margin-top: 0; }
      .msg.agent p { margin: 0 0 6px; }
      .msg.agent p:last-child { margin-bottom: 0; }
      .msg.agent ul, .msg.agent ol { margin: 4px 0 6px; padding-left: 20px; }
      .msg.agent li { margin: 2px 0; }
      .msg.agent pre { margin: 6px 0; padding: 8px 10px; background: #0d0f12;
                        border: 1px solid #2c3039; border-radius: 6px; overflow-x: auto;
                        font-size: 11.5px; line-height: 1.4; }
      .msg.agent pre code { background: none; border: none; padding: 0; }
      .msg.agent .tok-comment { color: #7f848e; font-style: italic; }
      .msg.agent .tok-string { color: #98c379; }
      .msg.agent .tok-keyword { color: #c678dd; }
      .msg.agent .tok-number { color: #d19a66; }
      .msg.agent .tok-prop, .msg.agent .tok-attr { color: #61afef; }
      .msg.agent .tok-tag { color: #e06c75; }
      .msg.agent code { background: #0d0f12; border: 1px solid #2c3039; border-radius: 4px;
                         padding: 1px 5px; font-size: 11.5px; font-family: ui-monospace, monospace; }
      .msg.agent a { color: #6ea8fe; }
      .msg.note { color: #868d98; font-size: 11px; padding: 0 2px; }
      /* What actually went with a message, kept in the message itself. */
      .sent { display: flex; flex-direction: column; gap: 5px; margin-top: 6px;
              padding-top: 6px; border-top: 1px solid rgb(255 255 255 / .22); }
      .sent .shots { display: flex; flex-wrap: wrap; gap: 5px; }
      .sent img { height: 40px; max-width: 110px; border-radius: 4px;
                  border: 1px solid rgb(255 255 255 / .3); cursor: zoom-in; background: #0d0f12; }
      .sent .what { font-size: 10.5px; opacity: .85; }
      .compare { display: flex; gap: 8px; margin-top: 7px; }
      .compare figure { margin: 0; flex: 1 1 0; min-width: 0; }
      .compare img { width: 100%; border-radius: 5px; border: 1px solid #333842;
                     background: #0d0f12; cursor: zoom-in; }
      .compare figcaption { font-size: 10px; color: #868d98; text-align: center; padding-top: 3px; }
      .msg.warn { color: #e0a03a; font-size: 11px; padding: 0 2px; }
      .chip { display: inline-block; font-size: 10px; color: #868d98; border: 1px solid #31363f;
              border-radius: 4px; padding: 0 5px; margin: 0 4px 2px 0; }

      .choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .choice-btn { font: inherit; font-size: 12px; color: #e8eaed; background: #262b33;
                    border: 1px solid #3a4049; border-radius: 999px; padding: 6px 12px;
                    cursor: pointer; }
      .choice-btn:hover:not(:disabled) { border-color: #5b6472; background: #2c323b; }
      .choice-btn:disabled { opacity: .55; cursor: default; }
      .choice-btn.picked { border-color: #1d4ed8; background: #1d4ed8; color: #fff; opacity: 1; }

      .opts { display: none; flex-direction: column; gap: 7px; padding: 9px 10px; border-top: 1px solid #2c3039;
              background: #171a1f; }
      .opts.on { display: flex; }
      .opts .head { display: flex; align-items: baseline; gap: 7px; }
      .opts .label { font-weight: 700; flex: 1; }
      .opts .count { color: #868d98; font-size: 11px; }
      .opts .row { display: flex; gap: 6px; }
      .opts button { flex: 1; }
      .opts button:disabled { opacity: .45; cursor: default; }
      /* Direct access to every variant. Numbers rather than labels, wrapping rather
         than scrolling: ten of them fit in two rows, nothing is hidden off the edge,
         and the active variant's full label is already spelled out above. */
      .picks { display: flex; flex-wrap: wrap; gap: 4px; }
      .picks button { flex: 0 0 auto; width: 26px; height: 26px; padding: 0; font-size: 11px;
                      font-weight: 600; line-height: 1; display: inline-flex;
                      align-items: center; justify-content: center; }
      .picks button.on { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
      .picks button.original { width: auto; padding: 0 9px; border-style: dashed; font-weight: 500; }

      button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
               background: #20242b; color: #e8eaed; border: 1px solid #333842; }
      button:hover { background: #272c34; }
      button.go { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }

      .meter { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-bottom: 1px solid #2c3039;
               font-size: 10.5px; color: #868d98; }
      .meter .track { flex: 1; height: 4px; border-radius: 2px; background: #262b33; overflow: hidden; }
      .meter .fill { height: 100%; width: 0%; background: #2ea043; transition: width .4s, background .4s; }
      .meter .fill.warm { background: #d9a13b; }
      .meter .fill.hot  { background: #d3553f; }
      .meter .pages { display: none; color: #e0a03a; font-size: 10px; white-space: nowrap; }
      .meter .pages.on { display: inline; }
      .meter .split { color: #868d98; font-size: 13px; text-decoration: none; line-height: 1;
                      display: inline-flex; align-items: center; }
      .meter .split:hover { color: #fff; }
      .meter .gear { cursor: pointer; color: #868d98; font-size: 13px; }
      .meter .gear:hover { color: #fff; }

      /* Settings takes the body rather than squeezing in beside the transcript,
         which left it a couple of rows tall and unscrollable. */
      .settings { display: none; flex-direction: column; gap: 8px; padding: 10px;
                  border-top: 1px solid #2c3039; background: #171a1f; flex: 1; overflow-y: auto; }
      .settings.on { display: flex; }
      .panel.settings-open .log,
      .panel.settings-open .tray,
      .panel.settings-open .opts,
      .panel.settings-open .composer { display: none; }
      .settings .title { display: flex; align-items: center; gap: 8px; font-weight: 700; }
      .settings .title .close { margin-left: auto; cursor: pointer; color: #868d98; font-size: 14px; }
      .settings .title .close:hover { color: #fff; }
      .settings .row { display: flex; align-items: center; gap: 8px; }
      .settings .row label { flex: 1; color: #c9ced8; font-size: 11.5px; }
      .settings input[type=number] { width: 88px; padding: 3px 6px; border-radius: 6px; background: #1b1e24;
                                      color: #e8eaed; border: 1px solid #333842; font: inherit; font-size: 11.5px; }
      .settings input[type=checkbox] { accent-color: #1d4ed8; }
      .settings select { padding: 3px 6px; border-radius: 6px; background: #1b1e24; color: #e8eaed;
                         border: 1px solid #333842; font: inherit; font-size: 11.5px; }
      .settings .where { color: #6d7480; font-size: 10px; }
      .settings .acts { display: flex; gap: 6px; }
      .settings .acts button { flex: 1; }

      .settings input[type=text] { flex: 1; min-width: 0; padding: 3px 6px; border-radius: 6px;
                                   background: #1b1e24; color: #e8eaed; border: 1px solid #333842;
                                   font: inherit; font-size: 11.5px; }
      .settings .row.needs-restart label::after { content: " · on restart"; color: #6d7480; }

      .composer { display: flex; padding: 9px; border-top: 1px solid #2c3039; }
      /* Nobody is listening: the chat, the context meter and Compact now would all be
         controls for an agent that is not there. The tools still work. */
      .panel.no-agent .composer,
      .panel.no-agent .meter .pct,
      .panel.no-agent .meter .track,
      .panel.no-agent [data-act="compact-now"] { display: none; }
      .elsewhere { display: none; padding: 8px 9px; border-top: 1px solid #2c3039;
                   color: #868d98; font-size: 11px; line-height: 1.45; }
      .panel.no-agent .elsewhere { display: block; }
      .panel.settings-open .elsewhere { display: none; }
      textarea { flex: 1; resize: none; height: 54px; padding: 7px 9px; border-radius: 8px;
                 background: #1b1e24; color: #e8eaed; border: 1px solid #333842; font: inherit; }
      textarea:focus { outline: 1px solid #1d4ed8; }
    </style>

    <div class="layer"></div>
    <div class="lightbox">
      <span class="cap"></span>
      <img alt="screenshot">
      <button class="drop" data-act="drop-frame" title="Remove the frame you are looking at">Remove this frame</button>
    </div>

    <div class="panel">
      <div class="grip" title="Drag to set the height"></div>
      <div class="grip-w" title="Drag to set the width"></div>
      <div class="grip-nw" title="Drag to set both"></div>
      <div class="tools">
        <button class="tool" data-act="pick" data-mode="pick"><span class="g">⊹</span>Select</button>
        <button class="tool" data-act="shot" data-mode="shot"><span class="g">▣</span>Screenshot</button>
        <button class="tool" data-act="clear"><span class="g">⊘</span>Clear</button>
        <button class="tool" data-act="reset"><span class="g">↺</span>Reset</button>
      </div>
      <div class="meter">
        <span class="pct">—</span>
        <span class="track"><span class="fill"></span></span>
        <span class="pages" title="Other tabs are also connected to this bridge"></span>
        <a class="split" data-act="split" href="#"></a>
        <span class="gear" data-act="settings" title="Settings">⚙</span>
      </div>
      <div class="tray">
        <div class="capopts">
          <label>wait <select class="cap-delay">
            <option value="0">none</option><option value="-1">until I click</option>
            <option value="1000">1s</option><option value="3000">3s</option>
            <option value="5000">5s</option><option value="10000">10s</option>
          </select></label>
          <label>frames <select class="cap-frames">
            <option value="1">1</option><option value="3">3</option>
            <option value="5">5</option><option value="8">8</option>
            <option value="12">12</option><option value="16">16</option>
          </select></label>
          <label class="every">every <select class="cap-every">
            <option value="0">max</option><option value="16">16ms</option>
            <option value="25">25ms</option><option value="40">40ms</option>
            <option value="80">80ms</option><option value="150" selected>150ms</option>
            <option value="300">300ms</option><option value="600">600ms</option>
            <option value="1000">1s</option>
          </select></label>
        </div>
        <div class="chips"></div>
        <div class="att"></div>
        <div class="hint"></div>
        <button class="undo" data-act="revert"></button>
      </div>
      <div class="log"></div>
      <div class="settings">
        <div class="title">Settings<span class="close" data-act="settings" title="Close">✕</span></div>
        <div class="rows"></div>
        <div class="where"></div>
        <div class="acts">
          <button data-act="compact-now">Compact now</button>
          <button data-act="clear-session">New session</button>
        </div>
      </div>
      <div class="opts">
        <div class="head"><span class="label"></span><span class="count"></span></div>
        <div class="picks"></div>
        <div class="row">
          <button data-act="prev">←</button>
          <button data-act="next">→</button>
          <button data-act="approve" class="go">Approve</button>
          <button data-act="discard">Discard</button>
        </div>
      </div>
      <div class="composer"><textarea placeholder="Describe a change…  (Enter sends, ↑ recalls)"></textarea></div>
      <div class="elsewhere"></div>
    </div>

    <div class="fab" title="uitalk">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <path class="frame" d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3
                               M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3"/>
        <path class="arrow" d="M10 9.5l6.2 3.1-2.5.9-1 2.6z"/>
      </svg>
      <span class="pip"></span>
      <span class="link"></span>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const ui = {
    layer: $(".layer"), panel: $(".panel"), fab: $(".fab"), pip: $(".fab .pip"), link: $(".fab .link"),
    log: $(".log"), opts: $(".opts"), optLabel: $(".opts .label"), optCount: $(".opts .count"),
    input: $("textarea"),
    pct: $(".meter .pct"), fill: $(".meter .fill"),
    tray: $(".tray"), chips: $(".chips"), att: $(".att"), hint: $(".hint"), pages: $(".meter .pages"),
    undo: $(".undo"),
    capopts: $(".capopts"), capDelay: $(".cap-delay"), capFrames: $(".cap-frames"), capEvery: $(".cap-every"),
    picks: $(".picks"),
    split: $(".meter .split"),
    lightbox: $(".lightbox"), lightboxImg: $(".lightbox img"), lightboxCap: $(".lightbox .cap"),
    settings: $(".settings"), rows: $(".settings .rows"), where: $(".settings .where"),
    elsewhere: $(".elsewhere"),
  };

  let config = {};
  let fields = {};

  // Shell-style recall. Up walks back through what you have sent, Down comes
  // forward again, and the draft you were part-way through typing is put back when
  // you walk off the end of the list.
  const history = [];
  const MAX_RECALL = 100;
  let recallIndex = null;
  let draft = "";
  let revertReady = false;
  let revertLabel = "";
  // Several captures can be queued and sent together: comparing two regions, or a
  // before and after, is the common case. The cap counts *captures*, not frames —
  // a strip of eight is one thing the user took, and counting frames meant a single
  // strip exhausted the queue and the next capture was refused.
  const MAX_SHOTS = 6;
  const MAX_FRAMES_SENT = 16; // one full strip, or several short ones
  const shots = []; // each entry: { frames: [{png, at}], label, triggeredBy, source }

  // ------------------------------------------------------------ transcript

  let streaming = null;
  // Called once per streamed text delta (potentially dozens/sec) plus once per tool-use
  // chip. Coalesce into one scroll per animation frame so a large screenshot already in
  // the log doesn't force a synchronous layout on every call.
  let scrollQueued = false;
  const scroll = () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      ui.log.scrollTop = ui.log.scrollHeight;
    });
  };

  // A light, dependency-free markdown renderer for the agent's own replies — not
  // for "me"/"note"/"warn" text, which is either the user's own literal typing or
  // a plain string we wrote ourselves. Deliberately narrow: bold/italic use only
  // asterisks, never underscores, because this is a coding tool and snake_case
  // identifiers (read_selection, data_uitalk_ref) are exactly the kind of prose
  // that underscore-emphasis misfires on.
  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function renderInline(line) {
    let out = escapeHtml(line);
    out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, b) => `<strong>${b}</strong>`);
    out = out.replace(/\*([^*\n]+)\*/g, (_, i) => `<em>${i}</em>`);
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
    return out;
  }

  // A tiny, dependency-free syntax highlighter — not a full grammar, just enough
  // to make a CSS/JS/HTML/JSON snippet in a reply scannable at a glance. Each rule
  // set is tried in order against the whole block; the earliest-starting match at
  // each position wins, so a rule for comments/strings ahead of keywords/numbers
  // keeps their contents from being re-tokenized.
  const TOKEN_RULES = {
    css: [
      ["comment", /\/\*[\s\S]*?\*\//],
      ["string", /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
      ["keyword", /!important\b|@[a-zA-Z-]+/],
      ["prop", /[a-zA-Z-]+(?=\s*:)/],
      ["number", /-?\d+\.?\d*(px|em|rem|%|vh|vw|vmin|vmax|deg|s|ms)?\b/],
    ],
    js: [
      ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
      ["string", /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
      ["keyword", /\b(const|let|var|function|return|if|else|for|while|import|export|from|default|class|extends|new|this|async|await|try|catch|finally|throw|typeof|instanceof|in|of|switch|case|break|continue|null|undefined|true|false)\b/],
      ["number", /\b\d+\.?\d*\b/],
    ],
    html: [
      ["comment", /<!--[\s\S]*?-->/],
      ["string", /"[^"]*"|'[^']*'/],
      ["tag", /<\/?[a-zA-Z][a-zA-Z0-9-]*|\/?>/],
      ["attr", /[a-zA-Z-]+(?=\s*=)/],
    ],
    json: [
      ["prop", /"(?:[^"\\]|\\.)*"(?=\s*:)/],
      ["string", /"(?:[^"\\]|\\.)*"/],
      ["keyword", /\b(true|false|null)\b/],
      ["number", /-?\d+\.?\d*\b/],
    ],
  };
  TOKEN_RULES.scss = TOKEN_RULES.css;
  TOKEN_RULES.jsx = TOKEN_RULES.js;
  TOKEN_RULES.ts = TOKEN_RULES.js;
  TOKEN_RULES.tsx = TOKEN_RULES.js;
  TOKEN_RULES.javascript = TOKEN_RULES.js;
  TOKEN_RULES.typescript = TOKEN_RULES.js;
  TOKEN_RULES.htm = TOKEN_RULES.html;
  TOKEN_RULES.xml = TOKEN_RULES.html;

  function highlightCode(code, lang) {
    const rules = TOKEN_RULES[lang];
    if (!rules) return escapeHtml(code);

    const combined = new RegExp(rules.map(([, re]) => `(${re.source})`).join("|"), "g");
    let out = "";
    let last = 0;
    let m;
    while ((m = combined.exec(code))) {
      out += escapeHtml(code.slice(last, m.index));
      const cls = rules[m.slice(1).findIndex((g) => g !== undefined)][0];
      out += `<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
      last = m.index + m[0].length;
      if (m[0].length === 0) combined.lastIndex++; // never loop on a zero-width match
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function renderMarkdown(raw) {
    const lines = raw.split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const fence = lines[i].match(/^```(\w*)\s*$/);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++; // the closing fence, if a delta has delivered one yet
        blocks.push(`<pre><code>${highlightCode(code.join("\n"), fence[1].toLowerCase())}</code></pre>`);
        continue;
      }
      if (/^[-*]\s+/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
          i++;
        }
        blocks.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
      if (/^\d+\.\s+/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
          i++;
        }
        blocks.push(`<ol>${items.join("")}</ol>`);
        continue;
      }
      if (!lines[i].trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^```/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) {
        para.push(renderInline(lines[i]));
        i++;
      }
      blocks.push(`<p>${para.join("<br>")}</p>`);
    }
    return blocks.join("");
  }

  function say(cls, text) {
    const el = document.createElement("div");
    el.className = `msg ${cls}`;
    if (cls === "agent") el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
    ui.log.appendChild(el);
    scroll();
    return el;
  }

  // Once sent, the tray is emptied — so the record of what went with a message has
  // to live in the message. Otherwise there is no way to tell afterwards.
  function sayMine(text, sent) {
    const el = say("me", text);
    if (!sent.shots.length && !sent.refs.length) return el;

    const box = document.createElement("div");
    box.className = "sent";

    if (sent.shots.length) {
      const row = document.createElement("div");
      row.className = "shots";
      for (const shot of sent.shots) {
        const img = document.createElement("img");
        img.src = `data:image/png;base64,${shot.png}`;
        img.title = `${shot.label} — click to view full size`;
        img.addEventListener("click", () => showImage(img.src, `${shot.label} (sent)`));
        row.appendChild(img);
      }
      box.appendChild(row);
    }

    const what = document.createElement("div");
    what.className = "what";
    what.textContent = [
      sent.shots.length ? `${sent.shots.length} screenshot${sent.shots.length === 1 ? "" : "s"}` : null,
      sent.refs.length ? `element${sent.refs.length === 1 ? "" : "s"} ${sent.refs.join(", ")}` : null,
    ].filter(Boolean).join(" · ") + " sent with this message";
    box.appendChild(what);

    el.appendChild(box);
    scroll();
    return el;
  }

  // Re-parsing on every token would re-run the whole markdown pass dozens of
  // times a second on a long reply; batch it the same way scroll() is batched.
  function scheduleMdRender(run) {
    if (run.__renderQueued) return;
    run.__renderQueued = true;
    requestAnimationFrame(() => {
      run.__renderQueued = false;
      run.innerHTML = renderMarkdown(run.__raw);
    });
  }

  function delta(text) {
    if (!streaming) streaming = say("agent", "");
    // A chip breaks the run: the text before and after it are two separate spans,
    // in the same left-to-right order, rather than one span a chip has to be
    // spliced into.
    let run = streaming.__run;
    if (!run) {
      run = document.createElement("div");
      run.className = "md-run";
      run.__raw = "";
      streaming.appendChild(run);
      streaming.__run = run;
    }
    run.__raw += text;
    scheduleMdRender(run);
    scroll();
  }

  // Raw tool names are implementation detail — "read_selection" reads like a log
  // line, not a step a person is watching happen. This is cosmetic only: there is
  // no per-tool "finished" event to time a real progress indicator against, so a
  // friendlier label is what closes the gap between a stack of jargon and someone
  // watching a first reply take shape.
  const TOOL_LABEL = {
    read_selection: "Reading selection",
    capture: "Capturing screenshot",
    capture_breakpoints: "Checking breakpoints",
    wait_for: "Waiting for the page",
    locate_source: "Locating source",
    describe_styles: "Checking styles",
    scan_region: "Scanning the page",
    try_style: "Previewing style",
    try_markup: "Previewing markup",
    show_options: "Preparing options",
    ask_choice: "Asking a question",
    reset_preview: "Clearing preview",
    read_file: "Reading file",
    edit_file: "Editing file",
    write_file: "Writing file",
    list_dir: "Listing files",
    search_files: "Searching files",
    // The built-in Claude Code session's own tools (allowedTools in runBuiltin),
    // not a uitalk page tool — shown with their own mcp__page__ prefix stripped
    // above, but under their native, capitalized names, which need the same
    // treatment.
    Read: "Reading file",
    Edit: "Editing file",
    Write: "Writing file",
    Grep: "Searching files",
    Glob: "Finding files",
    Bash: "Running a command",
    TodoWrite: "Updating the task list",
    WebFetch: "Fetching a page",
    WebSearch: "Searching the web",
    Task: "Delegating a task",
    // An OpenCode session's own native tools — lowercase, unlike Claude Code's.
    read: "Reading file",
    write: "Writing file",
    edit: "Editing file",
    patch: "Editing file",
    glob: "Finding files",
    grep: "Searching files",
    list: "Listing files",
    bash: "Running a command",
    webfetch: "Fetching a page",
    todowrite: "Updating the task list",
    todoread: "Checking the task list",
    task: "Delegating a task",
  };

  function chip(name) {
    if (!streaming) streaming = say("agent", "");
    streaming.__run = null; // the next delta starts a fresh run after this chip
    const el = document.createElement("span");
    el.className = "chip";
    const bare = name.replace(/^mcp__page__/, "");
    el.textContent = TOOL_LABEL[bare] ?? bare;
    streaming.appendChild(el);
    scroll();
  }

  /** ask_choice's answer: a plain reply, so it looks exactly like typed chat. */
  function sendChoice(text) {
    sayMine(text, { shots: [], refs: [] });
    send({ kind: "choice_answer", label: text });
  }

  /** ask_choice's question, rendered as tappable buttons instead of retyped text. */
  function renderAskChoice({ question, options = [] }) {
    const el = say("agent", question);
    const box = document.createElement("div");
    box.className = "choices";
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice-btn";
      btn.textContent = opt;
      btn.onclick = () => {
        for (const b of box.querySelectorAll("button")) b.disabled = true;
        btn.classList.add("picked");
        sendChoice(opt);
      };
      box.appendChild(btn);
    }
    el.appendChild(box);
    scroll();
    return { presented: true };
  }

  // Switching between the plain page and the device shell is a button, not a URL
  // to know. Both directions keep the route you are on.
  function syncDock() {
    if (!shell) return;
    const side = shell.dock?.() ?? "right";
    for (const s of ["right", "bottom", "left"]) ui.panel.classList.toggle(`dock-${s}`, s === side);
  }

  function syncSplitLink() {
    if (shell) {
      let here = "/";
      try {
        const loc = shell.frameWindow()?.location;
        if (loc) here = loc.pathname + loc.search;
      } catch {}
      ui.split.href = here;
      ui.split.textContent = "⤢";
      ui.split.title = "Leave split screen";
    } else {
      ui.split.href = `/__uitalk/shell#${location.pathname}${location.search}`;
      ui.split.textContent = "⧉";
      ui.split.title = "Split screen with device sizes";
    }
  }

  // ------------------------------------------------------------------- tray

  // Selection state and a pending screenshot belong here, not in the transcript:
  // picking something is not a message, and nothing in this strip has been sent.
  let hintTimer = null;

  function hint(text) {
    ui.hint.textContent = text ?? "";
    clearTimeout(hintTimer);
    if (text) hintTimer = setTimeout(() => { ui.hint.textContent = ""; renderTray(); }, 5000);
    renderTray();
  }

  // A still frame cannot show motion, and some states only exist briefly. These sit
  // beside the shutter rather than in settings, because they are per-shot choices.
  const UNTIL_CLICK_CEILING = 120000; // a wait with no timer still needs a way out

  const captureOpts = () => {
    const wait = Number(ui.capDelay.value) || 0;
    const untilClick = wait < 0;
    return {
      delay: untilClick ? UNTIL_CLICK_CEILING : wait,
      untilClick,
      frames: Number(ui.capFrames.value) || 1,
      every: Number(ui.capEvery.value), // 0 means "as fast as the stream allows"
    };
  };

  function syncCaptureOpts() {
    ui.capopts.classList.toggle("on", mode === "shot");
    ui.capopts.classList.toggle("motion", Number(ui.capFrames.value) > 1);
  }

  /** Drop one frame from a capture; the last one takes the capture with it. */
  function removeFrame(shotIndex, frameIndex) {
    const shot = shots[shotIndex];
    if (!shot) return;
    shot.frames.splice(frameIndex, 1);
    if (!shot.frames.length) shots.splice(shotIndex, 1);
    if (!shots.length) hideLightbox();
    syncShotBadge();
    renderTray();
    if (ui.lightbox.classList.contains("on")) paintLightbox();
  }

  function renderTray() {
    ui.chips.textContent = "";
    for (const [i, el] of api().picked.entries()) {
      const chip = document.createElement("span");
      chip.className = "chip-sel";
      const n = document.createElement("b");
      n.textContent = String(i + 1);
      const label = document.createElement("span");
      label.textContent = describe(el).replace(/^<|>$/g, "");
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.title = `Deselect ${i + 1}`;
      x.addEventListener("click", (e) => { e.stopPropagation(); report(api().unpick(i + 1)); });
      chip.append(n, label, x);
      ui.chips.appendChild(chip);
    }

    ui.att.classList.toggle("on", shots.length > 0);
    ui.att.textContent = "";
    if (shots.length) {
      const strip = document.createElement("div");
      strip.className = "strip";
      shots.forEach((shot, i) => {
        const many = shot.frames.length > 1;

        // Expanded, every frame is its own thumbnail with its own ✕, so a strip can
        // be pruned rather than only kept or dropped whole.
        const visible = shot.expanded ? shot.frames : [shot.frames[0]];

        visible.forEach((f, fi) => {
          const thumb = document.createElement("span");
          thumb.className = "thumb";

          const img = document.createElement("img");
          img.src = `data:image/png;base64,${f.png}`;
          img.title = shot.expanded
            ? `${shot.label} · frame ${fi + 1} of ${shot.frames.length} (+${f.at}ms) — click to view full size`
            : `${shot.label}${many ? ` — ${shot.frames.length} frames` : ""} — click to view full size`;
          img.addEventListener("click", () => showLightbox(i, shot.expanded ? fi : 0));

          if (many && !shot.expanded) {
            const n = document.createElement("span");
            n.className = "count";
            n.textContent = `×${shot.frames.length}`;
            n.title = "Show every frame, to remove some";
            n.addEventListener("click", (e) => {
              e.stopPropagation();
              shot.expanded = true;
              renderTray();
            });
            thumb.appendChild(n);
          }

          const x = document.createElement("span");
          x.className = "x";
          x.setAttribute("role", "button");
          const what = shot.expanded && many ? `frame ${fi + 1}` : many ? "these frames" : "this screenshot";
          x.setAttribute("aria-label", `Remove ${what}`);
          x.title = `Remove ${what}`;
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            if (shot.expanded && many) {
              removeFrame(i, fi);
              hint("frame removed");
            } else {
              shots.splice(i, 1);
              if (!shots.length) hideLightbox();
              syncShotBadge();
              renderTray();
              hint("capture removed");
            }
          });

          thumb.append(img, x);
          strip.appendChild(thumb);
        });

        if (shot.expanded && many) {
          const fold = document.createElement("button");
          fold.className = "fold";
          fold.textContent = "collapse";
          fold.title = "Show this capture as one thumbnail again";
          fold.addEventListener("click", () => {
            shot.expanded = false;
            renderTray();
          });
          strip.appendChild(fold);
        }
      });

      const meta = document.createElement("span");
      meta.className = "meta";
      const total = shots.reduce((n, s) => n + s.frames.length, 0);
      const count = document.createElement("span");
      count.textContent =
        `${shots.length} capture${shots.length === 1 ? "" : "s"} queued` +
        (total !== shots.length ? ` · ${total} frames` : "");
      const note = document.createElement("span");
      note.textContent = "sent with your next message";
      const all = document.createElement("span");
      all.className = "x";
      all.textContent = "discard all";
      all.dataset.act = "discard-shot";
      meta.append(count, note, all);

      ui.att.append(strip, meta);
    }

    syncCaptureOpts();
    // An approval is only cheap if it can be taken back.
    ui.undo.classList.toggle("on", revertReady);
    ui.undo.textContent = revertReady ? `↩ undo "${revertLabel}"` : "";

    ui.tray.classList.toggle("on",
      Boolean(api().picked.length || shots.length || ui.hint.textContent || mode === "shot" || revertReady));
  }

  let viewing = 0;

  function showImage(src, caption) {
    ui.lightboxImg.src = src;
    ui.lightboxCap.textContent = `${caption}  ·  click anywhere to close`;
    ui.lightbox.classList.add("on");
  }

  /** Every frame of every queued capture, flattened, so ←/→ walks a whole strip. */
  const allFrames = () =>
    shots.flatMap((shot, s) =>
      shot.frames.map((f, i) => ({
        png: f.png,
        caption: `${shot.label}${shot.frames.length > 1 ? ` · frame ${i + 1} of ${shot.frames.length} (+${f.at}ms)` : ""}`,
        shot: s,
        frame: i,
      })),
    );

  function showLightbox(shotIndex = 0, frameIndex = 0) {
    const flat = allFrames();
    if (!flat.length) return;
    const first = flat.findIndex((f) => f.shot === shotIndex && f.frame === frameIndex);
    viewing = Math.max(0, Math.min(first === -1 ? 0 : first, flat.length - 1));
    paintLightbox(flat);
  }

  function paintLightbox(flat = allFrames()) {
    if (!flat.length) return hideLightbox();
    viewing = Math.max(0, Math.min(viewing, flat.length - 1));
    const f = flat[viewing];
    ui.lightboxImg.src = `data:image/png;base64,${f.png}`;
    ui.lightboxCap.textContent =
      `${f.caption}` +
      (flat.length > 1 ? `  ·  ${viewing + 1} of ${flat.length}, ←/→ to step, Del to remove` : "") +
      `  ·  click anywhere to close`;
    ui.lightbox.classList.add("on");
  }

  function hideLightbox() {
    ui.lightbox.classList.remove("on");
    ui.lightboxImg.removeAttribute("src");
  }

  ui.lightbox.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=drop-frame]")) return; // handled below
    hideLightbox();
  });

  ui.lightbox.querySelector("[data-act=drop-frame]").addEventListener("click", (e) => {
    e.stopPropagation();
    const flat = allFrames();
    const here = flat[viewing];
    if (!here) return;
    removeFrame(here.shot, here.frame);
  });
  ui.capFrames.addEventListener("change", syncCaptureOpts);

  // ------------------------------------------------------- meter + settings

  function showContext({ tokens, percent, limit }) {
    ui.pct.textContent = `${percent}% · ${(tokens / 1000).toFixed(1)}k / ${(limit / 1000).toFixed(0)}k`;
    ui.fill.style.width = `${Math.min(100, percent)}%`;
    const at = config.compactAtPercent ?? 20;
    ui.fill.classList.toggle("warm", percent >= at * 0.75 && percent < at);
    ui.fill.classList.toggle("hot", percent >= at);
  }

  // Who is answering changes what the panel can honestly offer. Typing into a chat
  // nobody reads, or watching a context meter that can never move, is worse than not
  // being offered either.
  let agent = { mode: "builtin", label: null };

  function applyAgentMode(info) {
    agent = { mode: info?.mode ?? "builtin", label: info?.label ?? null, of: info?.of };
    const alone = agent.mode === "off";
    ui.panel.classList.toggle("no-agent", alone);
    ui.elsewhere.textContent = alone
      ? "No agent here — your editor is driving over MCP. Select, screenshot and preview from " +
        "these tools; ask for changes in the editor. Undo still works."
      : "";
    if (alone) ui.input.disabled = true;
  }

  function renderSettings() {
    ui.rows.textContent = "";
    for (const [key, field] of Object.entries(fields)) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      label.textContent = field.label ?? key;
      // A setting with a fixed set of values is a select; rendering it as a number
      // box would let anything be typed and rejected server-side.
      const input = document.createElement(field.type === "choice" ? "select" : "input");
      input.dataset.key = key;
      // A session cannot be swapped underneath a conversation, so say so on the row
      // rather than letting the change look as though it took effect.
      if (field.restart) row.classList.add("needs-restart");
      if (field.type === "text") {
        input.type = "text";
        input.value = config[key] ?? "";
        input.placeholder = field.placeholder ?? "";
      } else if (field.type === "choice") {
        for (const choice of field.choices) {
          const opt = document.createElement("option");
          opt.value = choice;
          opt.textContent = choice;
          opt.selected = config[key] === choice;
          input.appendChild(opt);
        }
      } else if (field.type === "boolean") {
        input.type = "checkbox";
        input.checked = Boolean(config[key]);
      } else {
        input.type = "number";
        input.min = field.min;
        input.max = field.max;
        input.value = config[key];
      }
      input.addEventListener("change", () => {
        const value =
          field.type === "choice" || field.type === "text" ? input.value
          : field.type === "boolean" ? input.checked
          : Number(input.value);
        send({ kind: "settings", patch: { [key]: value } });
      });
      row.append(label, input);
      ui.rows.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- socket

  let ws = null;
  let backoff = 500;

  function connect() {
    ws = new WebSocket(SOCKET);

    ws.onopen = () => {
      backoff = 500;
      ui.link.classList.add("on");
      ui.fab.title = "uitalk — connected";
      announce("hello");
    };

    ws.onclose = () => {
      ui.link.classList.remove("on");
      ui.fab.title = "uitalk — offline, retrying";
      setTimeout(connect, (backoff = Math.min(backoff * 2, 8000)));
    };

    ws.onerror = () => {};

    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      switch (f.kind) {
        case "ready":
          // The page runs whatever it loaded. If the bridge has restarted with a
          // newer client since, say so rather than letting a fixed bug look alive.
          if (f.build && globalThis.__UITALK_BUILD__ && f.build !== globalThis.__UITALK_BUILD__) {
            say("warn",
              `this panel is build ${globalThis.__UITALK_BUILD__}, the bridge now serves ${f.build} — ` +
              `reload the page to pick it up`);
          }
          config = f.settings ?? {};
          fields = f.fields ?? {};
          renderSettings();
          applyAgentMode(f.agent);
          if (f.context) showContext(f.context);
          return say("note",
            `connected · ${f.project}` + (agent.mode === "builtin" ? "" : ` · ${agent.label ?? agent.of ?? agent.mode}`));

        case "replay":
          for (const e of f.entries) {
            say(e.role === "me" ? "me" : e.role === "note" ? "note" : "agent", e.text);
            // Seed recall from the replayed transcript, minus the attachment note
            // the bridge appends for the record.
            if (e.role === "me") remember(e.text.replace(/\n\[sent with [^\]]*\]$/, ""));
          }
          recallIndex = null;
          return say("note", "— earlier in this session —");

        case "agent_absent": return say("warn", f.text);

        case "context": return showContext(f);

        case "pages":
          ui.pages.textContent = f.total > 1 ? `${f.total} tabs · this one is active` : "";
          ui.pages.classList.toggle("on", f.total > 1);
          return;

        case "settings":
          config = f.settings;
          renderSettings();
          ui.where.textContent = `saved to ${f.written}`;
          if (f.rejected?.length) say("warn", f.rejected.join("; "));
          return;

        case "compacting":
          if (f.stage === "failed") return say("warn", `compaction failed: ${f.reason}`);
          return say("note", f.stage === "summarizing" ? `compacting context (${f.reason})…` : "clearing context…");

        case "compacted": return say("note", "context compacted; the handover note was carried over");

        case "cleared":
          ui.log.textContent = "";
          return say("note", "new session started");
        case "delta": return delta(f.text);
        case "tool": return chip(f.name);
        case "status": return;
        case "turn_end":
          streaming = null;
          void captureAfter();
          if (f.text) say("note", `turn ended: ${f.text}`);
          return;
        case "revertable":
          revertReady = f.available;
          revertLabel = f.label;
          renderTray();
          if (!f.available) say("note", "this project is not a git repository, so changes cannot be undone from here");
          return;

        case "reverted":
          revertReady = false;
          renderTray();
          return say(f.ok
            ? "note"
            : "warn", f.ok
              ? `reverted "${f.label}"` +
                (f.files?.length ? ` · restored ${f.files.join(", ")}` : "") +
                (f.removed?.length ? ` · removed ${f.removed.join(", ")}` : "") +
                (f.skipped?.length ? ` · left alone (edited again since): ${f.skipped.join(", ")}` : "") +
                (!f.files?.length && !f.removed?.length && !f.skipped?.length ? " · nothing to undo" : "")
              : `could not revert: ${f.text}`);

        case "client_updated":
          return say("warn",
            `the panel has been updated to build ${f.build} — reload the page to pick it up`);

        case "bridge_stale":
          return say("warn",
            "the bridge's own code has changed on disk; restart it with " +
            "uitalk --stop && uitalk to pick that up");

        case "tool_error":
          // Say what actually failed, rather than leaving the agent to paraphrase it.
          return say("warn", `${f.method.replace(/^mcp__page__/, "")} failed: ${f.text}`);

        case "error":
          streaming = null;
          return say("note", `error: ${f.text}`);
        case "rpc": return serve(f);
      }
    };
  }

  const send = (frame) => ws?.readyState === 1 && ws.send(JSON.stringify(frame));

  // Which tab the user is actually looking at. Without this the bridge cannot tell
  // several open tabs apart, and a request can land on a background one — where
  // rAF is paused and the selection belongs to someone else.
  const announce = (kind) => send({ kind, url: location.href, visible: !document.hidden });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) announce("focus");
  });
  addEventListener("focus", () => announce("focus"));
  ui.panel.addEventListener("pointerdown", () => announce("focus"));

  async function serve({ id, method, params }) {
    // A selector-targeted preview's stamped attribute can be sitting on a node
    // a re-render already replaced — reconciling here, before any tool acts,
    // catches that on the very next thing that touches the page rather than
    // needing a continuously-running observer.
    api().reconcileTargets();

    // Named `handlers`, not `api`: a local `api` here shadows the accessor above,
    // and every call became `api()` on an object literal — which broke every page
    // tool the agent has.
    const handlers = {
      readSelection: () => api().readSelection(),
      capture: async (p = {}) => {
        // Pixels natively where possible; the inventory and geometry still come
        // from the page, which is the only thing that knows about elements.
        if (!p.region) return api().capture(p);
        const shot = await captureBest(p.region, p);
        if (p.inventory === false) return shot;
        const scanned = api().scanRegion({
          x: p.region.left, y: p.region.top,
          w: p.region.right - p.region.left, h: p.region.bottom - p.region.top,
        });
        return { ...shot, inventory: scanned.elements };
      },
      scanRegion: (p) => api().scanRegion(p),
      waitFor: (p) => api().waitFor(p),
      locateSource: (p) => ({ ...api().locateSource(p), page: api().pageContext() }),
      describeStyles: (p) => api().describeStyles(p),
      captureBreakpoints: async (p) => {
        const out = await shootBreakpoints({
          ref: p.ref, selector: p.selector,
          widths: (p.widths ?? [390, 768, 1440]).slice(0, 6),
        });
        return { ...out, page: api().pageContext() };
      },
      tryStyle: (p) => api().tryStyle(p),
      tryMarkup: (p) => api().tryMarkup(p),
      showOptions: (p) => api().showOptions(p),
      resetPreview: () => api().resetPreview(),
      askChoice: (p) => renderAskChoice(p),
    };
    try {
      if (!handlers[method]) throw new Error(`unknown method ${method}`);
      const result = await handlers[method](params ?? {});
      if (result?.warnings) for (const w of result.warnings) say("warn", `capture: ${w}`);
      send({ kind: "rpc_result", id, result });
      if (method !== "readSelection") paint();
    } catch (err) {
      send({ kind: "rpc_result", id, error: err.message });
    }
  }

  // -------------------------------------------------------------- screenshot

  function syncShotBadge() {
    const btn = root.querySelector('[data-act="shot"]');
    btn.classList.toggle("queued", shots.length > 0);
    const total = shots.reduce((n, s) => n + s.frames.length, 0);
    btn.dataset.count = total > 1 ? String(total) : "";
  }

  const native = globalThis.UITalkNative ?? null;

  /**
   * Region coordinates arrive in the app's own space. Native capture photographs
   * this window, so in split screen they have to be projected onto the shell's
   * viewport first — the same mapping the overlay uses to draw over the frame.
   */
  async function grabNative(region, opts, origin) {
    const box = project({
      left: region.left, top: region.top,
      width: region.right - region.left, height: region.bottom - region.top,
    });
    const rect = { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height };

    const strip = [];
    const started = origin ?? Date.now();
    const count = Math.max(1, Math.min(opts.frames ?? 1, 16));

    await withPanelHidden(async () => {
      const gap = opts.every ?? 300;
      for (let i = 0; i < count; i++) {
        // gap 0 is "as fast as the stream runs": no sleep, just wait for the next
        // compositor frame, which is the real ceiling.
        if (i && gap > 0) await new Promise((r) => setTimeout(r, gap));
        const frame = await native.grab(rect, { frameBudget: gap > 0 ? Math.max(20, Math.min(gap, 120)) : 60 });
        strip.push({ png: frame.png, at: Date.now() - started, width: frame.width, height: frame.height });
      }
    });

    return {
      png: strip[0].png,
      frames: strip.length > 1 ? strip.map((f) => ({ png: f.png, at: f.at })) : undefined,
      width: strip[0].width,
      height: strip[0].height,
      region: { x: Math.round(region.left), y: Math.round(region.top),
                w: Math.round(region.right - region.left), h: Math.round(region.bottom - region.top) },
      page: api().pageContext(),
      source: "screen",
    };
  }

  // Our own panel must not appear in a capture of the tab.
  async function withPanelHidden(fn) {
    host.style.visibility = "hidden";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      return await fn();
    } finally {
      host.style.visibility = "";
    }
  }

  /** Native pixels when we can get them, the DOM renderer when we cannot. */
  async function captureBest(region, opts) {
    if (native?.supported() && !native.declined && config.nativeCapture !== false && region) {
      try {
        // The agent calls capture on its own, with nothing on screen to explain why a
        // browser permission prompt would suddenly appear — and an unexplained one
        // reads as something to dismiss on reflex. Say what it is and that declining
        // is fine, before asking, the one time per session it is actually asked.
        if (!native.active) {
          say("note", "your browser may ask to share this tab — that's for a pixel-accurate " +
            "screenshot; declining just falls back to a rendered one.");
        }
        if (await native.ready()) return await grabNative(region, opts, opts.origin);
      } catch (err) {
        say("warn", `${err.message}`);
      }
    }
    const shot = await api().capture(region ? { region, ...opts } : opts);
    return { ...shot, source: "rendered" };
  }

  /**
   * Hand the page back for a moment so the user can trigger whatever they want to
   * photograph, recording what they click so the agent knows what caused the state
   * it is looking at.
   */
  /**
   * Hand the page back so the user can trigger what they want to photograph.
   *
   * With a strip, the first click *is* the start signal: waiting out the rest of
   * the countdown would miss the animation it just began. Everything is stamped on
   * one clock, so a click and a frame can be placed on the same timeline.
   */
  /** Keeps the chosen area on screen through the wait, and marks when it rolls. */
  function armedMarker(region) {
    const box = project({
      left: region.left, top: region.top,
      width: region.right - region.left, height: region.bottom - region.top,
    });
    const el = document.createElement("div");
    el.className = "armed";
    Object.assign(el.style, {
      left: `${box.left}px`, top: `${box.top}px`,
      width: `${box.width}px`, height: `${box.height}px`,
    });
    const tag = document.createElement("span");
    tag.className = "tag";
    el.appendChild(tag);
    ui.layer.appendChild(el);

    return {
      say: (text) => (tag.textContent = text),
      roll: () => el.classList.add("rolling"),
      remove: () => el.remove(),
    };
  }

  async function interactionWindow(ms, { startOnClick = false, marker = null, untilClick = false } = {}) {
    const clicks = [];
    const w = source();
    let trigger = null;
    let cancelled = false;
    let release = null;
    const waited = new Promise((r) => (release = r));

    const record = (e) => {
      // The click that ends the drag is the drag's, not a trigger — without this
      // the roll starts the instant the rectangle is released, every time.
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      const entry = { time: Date.now(), element: api().identify(el) };
      clicks.push(entry);
      if (startOnClick && !trigger) {
        trigger = entry;
        // This listener is capture-phase, so it runs *before* the app's own click
        // handler and before any resulting style change is applied. Rolling here
        // would photograph the state the click is about to replace. Yield a task so
        // the whole dispatch completes, then a frame so the style lands — the time
        // origin stays the click itself, so offsets remain honest.
        setTimeout(() => requestAnimationFrame(() => release()), 0);
      }
    };

    const bail = (e) => {
      if (e.key !== "Escape") return;
      cancelled = true;
      release();
    };

    interacting = true;
    clearHover();
    setPageCursor("");
    w?.addEventListener("click", record, true); // capture-phase, but never blocks
    addEventListener("keydown", bail, true);
    w?.addEventListener("keydown", bail, true);

    const countdown = (async () => {
      if (untilClick) {
        // No timer to show: the shutter is waiting on the user, not the clock.
        marker?.say("click to start");
        hint("waiting for your click — the page is yours; press Esc to cancel");
        for (let waited = 0; waited < ms && !trigger && !cancelled; waited += 250) {
          await new Promise((r) => setTimeout(r, 250));
        }
        return release();
      }
      for (let left = Math.ceil(ms / 1000); left > 0 && !trigger && !cancelled; left--) {
        const text = startOnClick ? `click to start · ${left}s` : `capturing in ${left}s`;
        marker?.say(text);
        hint(startOnClick
          ? `click to start — or capturing anyway in ${left}s`
          : `the page is yours — click or hover to set the state · capturing in ${left}s`);
        await new Promise((r) => setTimeout(r, Math.min(1000, ms)));
      }
      release();
    })();

    await waited;
    await Promise.race([countdown, Promise.resolve()]);

    // The shield stays down through the capture as well, so a second click during
    // the animation is possible and lands on the same timeline.
    setPageCursor(mode === "shot" ? "crosshair" : "");
    marker?.roll();
    marker?.say(trigger ? "recording" : "capturing");
    hint(trigger ? `rolling from your click on ${describeIdentity(trigger.element)}` : "capturing");

    return {
      clicks,
      trigger,
      cancelled,
      stop: () => {
        w?.removeEventListener("click", record, true);
        removeEventListener("keydown", bail, true);
        w?.removeEventListener("keydown", bail, true);
        interacting = false;
      },
    };
  }

  /**
   * The same element at several widths. Deliberately an *element*, not a rectangle:
   * a rectangle means something different at every width, so comparing "the same
   * region" across breakpoints compares different things. The frame is resized, the
   * element re-measured where it now sits, captured, and the frame put back.
   */
  async function shootBreakpoints({ ref, selector, widths }) {
    if (!shell) throw new Error("breakpoints need split screen — open the shell first");

    const frames = [];
    const notes = [];
    for (const width of widths) {
      await shell.withWidth(width, async () => {
        const target = api().rectOf({ ref, selector });
        if (!target) {
          notes.push(`${width}px: the element is not present`);
          return;
        }
        const region = { left: target.left, top: target.top,
                         right: target.left + target.width, bottom: target.top + target.height };
        const shot = await captureBest(region, { inventory: false });
        frames.push({
          png: shot.png,
          at: width,
          label: `${width}px · ${Math.round(target.width)}×${Math.round(target.height)}`,
        });
      });
    }
    return { frames, notes };
  }

  async function shoot({ region, what } = {}) {
    if (shots.length >= MAX_SHOTS) {
      hint(`${MAX_SHOTS} captures queued — send them, or remove one with its ✕`);
      say("warn", `${MAX_SHOTS} captures are already queued; send the message or discard one before taking another`);
      return;
    }
    let marker = null;
    try {
      const opts = { inventory: false, ...captureOpts() };

      // Get the screen-share prompt out of the way first. Asking mid-wait steals the
      // seconds the user meant to spend triggering something, and the picker dialog
      // covers the page they were about to interact with.
      if (opts.delay > 0 && native?.supported() && !native.declined && config.nativeCapture !== false) {
        try {
          hint("allow screen capture to continue…");
          await native.ready();
        } catch (err) {
          say("warn", err.message);
        }
      }

      // The wait is the user's, not the shutter's: spend it with the page live and
      // the tool standing down, then capture with no further delay.
      if (opts.delay > 0 && region) marker = armedMarker(region);
      const session = opts.delay > 0
        ? await interactionWindow(opts.delay, {
            // An open-ended wait is by definition waiting for the click.
            startOnClick: opts.untilClick || opts.frames > 1,
            untilClick: opts.untilClick,
            marker,
          })
        : null;

      if (session?.cancelled && !session.trigger) {
        session.stop();
        marker?.remove();
        return hint("capture cancelled");
      }

      // One clock for clicks and frames alike, anchored on the click that started
      // it when there was one — so "+120ms" means 120ms after the flip began.
      const origin = session?.trigger?.time ?? Date.now();
      let shot;
      try {
        shot = await captureBest(region, { ...opts, delay: 0, origin });
      } finally {
        session?.stop();
        marker?.remove();
      }

      const timeline = (session?.clicks ?? []).map((c) => ({
        at: c.time - origin,
        element: c.element,
      }));
      const triggeredBy = timeline;

      // A strip of frames queues one thumbnail each, so motion is reviewable.
      const strip = shot.frames ?? [{ png: shot.png, at: 0 }];
      const base = what ?? (shot.region
        ? `${shot.region.w}×${shot.region.h} of ${shot.renderedFrom ? describeIdentity(shot.renderedFrom) : "the page"}`
        : "the page");

      const how = shot.source === "screen" ? "" : " · rendered";
      const anchor = session?.trigger ? ` after clicking ${describeIdentity(session.trigger.element)}` : "";
      const clicked = !anchor && timeline.length
        ? ` · after ${timeline.map((c) => describeIdentity(c.element)).join(", ")}`
        : "";

      shots.push({
        frames: strip.map((f) => ({ png: f.png, at: f.at })),
        label: `${base}${anchor ? ` ·${anchor}` : clicked}${how}`,
        triggeredBy: timeline.length ? timeline : undefined,
      });

      syncShotBadge();
      for (const w of shot.warnings ?? []) say("warn", `capture: ${w}`);
      renderTray();
      open(true); // so the preview is actually visible before it is sent
    } catch (err) {
      marker?.remove();
      hint(`no screenshot: ${err.message}`);
    }
  }

  // --------------------------------------------------------- before and after

  // An approval changes source and the app re-renders. Without a picture of what it
  // looked like first there is nothing to compare against, and "did that work?"
  // becomes a matter of memory.
  let pending = null;

  const declaredProperties = (css = "") =>
    css
      .split(";")
      .map((d) => d.split(":")[0].trim())
      .filter((p) => /^[-a-z]+$/.test(p));

  async function captureBefore(choice, verify = {}) {
    if (!native?.supported() || native.declined || config.nativeCapture === false) return;
    try {
      const rect = api().rectOf({ ref: choice.ref, selector: choice.element?.selector });
      if (!rect) return;
      const region = { left: rect.left, top: rect.top,
                       right: rect.left + rect.width, bottom: rect.top + rect.height };
      if (!(await native.ready())) return;
      const shot = await grabNative(region, { frames: 1 }, Date.now());
      pending = { label: choice.label, region, ref: choice.ref,
                  selector: choice.element?.selector, before: shot.png, ...verify };
    } catch {
      // A missing before-shot must not block the approval, but the verification does
      // not need pixels — keep it.
      pending = { label: choice.label, ref: choice.ref, selector: choice.element?.selector, ...verify };
    }
  }

  const RESUME_KEY = "uitalk.pendingVerify";

  /**
   * An app without HMR keeps showing the old markup after an edit, so both the
   * after-shot and the verification would be comparing against a stale page. Reload
   * it first — the frame in split screen, the whole page otherwise, in which case
   * the job has to survive the reload.
   */
  async function reloadForResult(job) {
    const mode = config.reloadAfterEdit ?? "auto";
    if (mode === "never") return false;
    if (mode === "auto" && api().liveReload?.()) return false;

    say("note", "no live reload detected — reloading the app to see the change");

    if (shell) {
      const w = source();
      const done = new Promise((r) => shell.element().addEventListener("load", r, { once: true }));
      try {
        w.location.reload();
      } catch {
        return false;
      }
      await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
      await new Promise((r) => setTimeout(r, 250)); // let it paint
      return false; // same document as far as we are concerned; carry on inline
    }

    // Standalone: reloading takes the panel with it, so hand the job to the next load.
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...job, before: undefined }));
    } catch {}
    location.reload();
    return true; // this document is going away
  }

  async function captureAfter() {
    if (!pending) return;
    const job = pending;
    pending = null;
    try {
      // Give the edit time to reach the browser through the dev server.
      await new Promise((r) => setTimeout(r, 900));
      if (await reloadForResult(job)) return; // resumed after the reload
      const rect = api().rectOf({ ref: job.ref, selector: job.selector }) ?? null;
      const region = rect
        ? { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height }
        : job.region;
      const shot = await grabNative(region, { frames: 1 }, Date.now());
      showComparison(job.label, job.before, shot.png);
    } catch (err) {
      say("note", `could not capture the result: ${err.message}`);
    } finally {
      verifyCommitted(job);
    }
  }

  /**
   * Did the committed edit actually reproduce the preview? The failure this catches
   * is silent: the rule lands somewhere with lower specificity, the page looks
   * unchanged, and nobody notices because the agent reported success.
   */
  function verifyCommitted(job) {
    if (!job?.props?.length || !job.previewed) return;
    const now = api().computedOf({ ref: job.ref, selector: job.selector, properties: job.props });
    if (!now) return say("warn", `could not re-check ${job.label}: the element is no longer on the page`);

    const drift = job.props
      .filter((p) => (job.previewed[p] ?? "") !== (now[p] ?? ""))
      .map((p) => ({ property: p, approved: job.previewed[p], now: now[p] }));

    if (!drift.length) {
      say("note", `verified: ${job.label} looks the same committed as it did previewed`);
      return;
    }

    say("warn",
      `${job.label} did not survive the edit — ` +
        drift.map((d) => `${d.property}: approved "${d.approved}", now "${d.now}"`).join("; "));
    // The nudge is a message to an agent. With none here the warning above is the whole
    // report, and sending would only earn a "nobody read that" reply.
    if (agent.mode === "off") {
      return say("note", "tell your editor to call describe_styles on it: the winning rule is elsewhere");
    }
    send({
      kind: "chat",
      text:
        `That edit did not take effect on the page. Comparing what I approved against the ` +
        `computed styles now: ` +
        drift.map((d) => `${d.property} should be "${d.approved}" but is "${d.now}"`).join("; ") +
        `. The usual cause is the rule landing somewhere that loses the cascade — call ` +
        `describe_styles on the element to see which rule is winning, then fix it there.`,
      page: { ...api().pageContext(), screen: shell?.screen() },
      selectionCount: api().picked.length,
    });
  }

  function showComparison(label, before, after) {
    const el = say("agent", "");
    const wrap = document.createElement("div");
    wrap.className = "compare";

    for (const [caption, png] of [["before", before], ["after", after]]) {
      const cell = document.createElement("figure");
      const img = document.createElement("img");
      img.src = `data:image/png;base64,${png}`;
      img.title = `${label} — ${caption}`;
      img.addEventListener("click", () => showImage(img.src, `${label} — ${caption}`));
      const cap = document.createElement("figcaption");
      cap.textContent = caption;
      cell.append(img, cap);
      wrap.appendChild(cell);
    }

    el.textContent = `${label} — before and after`;
    el.appendChild(wrap);
    scroll();
  }

  // ---------------------------------------------------------------- picker

  // Exactly one tool is ever active, but the selection outlives a tool switch:
  // Screenshot captures regions and never touches the selection, so a selection
  // made in Select stays valid and visible while a shot is taken. Selecting
  // elements and attaching a screenshot to the same message is a real combination.
  // Clear and Escape remain the explicit ways to drop a selection.
  let mode = null;
  let hover = null;
  const picking = () => mode === "pick";

  function setPageCursor(value) {
    try {
      const doc = source()?.document;
      if (doc) doc.documentElement.style.cursor = value;
    } catch {}
  }

  function setMode(next) {
    const target = mode === next ? null : next;
    mode = target;

    // Arming is the moment the listeners have to be live. Re-attaching here costs
    // nothing (addEventListener ignores a repeat of the same type/callback/capture)
    // and removes any dependence on having caught the frame's load event.
    if (target) {
      reattach();
      if (shell && api() === INERT) {
        hint("the app frame is not ready yet — reload the page");
      }
    }
    setPageCursor(mode === "shot" ? "crosshair" : "");
    for (const btn of root.querySelectorAll(".tool[data-mode]")) {
      btn.classList.toggle("on", btn.dataset.mode === mode);
    }
    ui.fab.classList.toggle("armed", mode === "pick");
    if (mode !== "pick") clearHover();
    paint();
  }

  // A rect read inside the frame has to be translated (and scaled) before it can
  // be drawn over the frame from out here.
  function project(r) {
    const t = xform();
    return {
      left: r.left * t.scale + t.left,
      top: r.top * t.scale + t.top,
      width: r.width * t.scale,
      height: r.height * t.scale,
    };
  }

  function paint() {
    const armed = ui.layer.querySelector(".armed"); // survives a repaint
    ui.layer.textContent = "";
    if (armed) ui.layer.appendChild(armed);
    hover = null;

    // While a variant is mounted the selection markers are worse than useless: a
    // variant can change the element's size, so boxes drawn from the pre-variant
    // geometry are stale, and a ring over the thing being judged interferes with
    // judging it. The selection itself stays — the preview is keyed to those refs,
    // so clearing it would unmount the variants — only the drawing pauses, and
    // Original brings it back.
    const comparing = (api().optionState?.active ?? -1) >= 0;

    if (!comparing) api().picked.forEach((el, i) => {
      const r = project(el.getBoundingClientRect());
      const ring = document.createElement("div");
      ring.className = "ring";
      Object.assign(ring.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const tag = document.createElement("div");
      tag.className = "badge";
      tag.textContent = String(i + 1);
      tag.title = `Element ${i + 1} — click to deselect`;
      tag.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        report(api().unpick(i + 1));
      });
      Object.assign(tag.style, { left: `${r.left}px`, top: `${Math.max(0, r.top - 10)}px` });
      ui.layer.append(ring, tag);
    });

    ui.pip.title = comparing ? "selection markers hidden while comparing variants" : "";
    ui.pip.textContent = String(api().picked.length);
    ui.pip.classList.toggle("on", api().picked.length > 0);
    renderTray();
  }

  // Page-level gestures attach to whichever window actually shows the app: this
  // one when standalone, the frame's when running in the shell. The frame can
  // navigate, so they are re-attached on every load.
  const pageListeners = [];
  let attachedTo = null;

  function onSource(type, fn, capture) {
    pageListeners.push([type, fn, capture]);
    const w = source();
    if (w) w.addEventListener(type, fn, capture);
    attachedTo = w;
  }

  // An iframe's contentWindow keeps the same identity across navigations while its
  // document — and every listener on it — is replaced. Comparing window identity
  // therefore skipped the re-attach and left the new document with no listeners at
  // all, which is why the tools did nothing in split screen. Re-register every
  // time: addEventListener ignores a repeat of the same type/callback/capture.
  function reattach() {
    const w = source();
    if (!w) return;
    for (const [type, fn, capture] of pageListeners) w.addEventListener(type, fn, capture);
    attachedTo = w.document ?? w;
    setPageCursor(mode === "shot" ? "crosshair" : "");
    api().setUiHost?.(shell ? null : host);
    watchSheets?.();
    checkFrameBuild();
  }

  // In the shell the panel is one document and the app is another, each with its own
  // copy of this client. The panel already notices when *it* is behind the bridge — but
  // the app frame doing the actual work could be running an older build with nothing
  // said about it, and every tool would then quietly do nothing. So it is checked and
  // repaired rather than reported: one reload of the frame, then a warning if that did
  // not settle it.
  let frameFixAttempt = null;

  function checkFrameBuild() {
    if (!shell) return;
    const mine = globalThis.__UITALK_BUILD__;
    if (!mine) return;

    let theirs;
    let frame;
    try {
      frame = shell.frameWindow();
      if (!frame) return;
      theirs = frame.__UITALK_BUILD__;
    } catch {
      return; // a cross-origin frame is not ours to police
    }
    if (theirs === mine) return;

    const attempt = `${theirs ?? "none"}->${mine}`;
    if (frameFixAttempt === attempt) {
      return say("warn",
        `the app in the frame is running ${theirs ? `an older client (${theirs})` : "no client"} ` +
        `while this panel is ${mine}. The tools act on the app, so reload the page.`);
    }
    frameFixAttempt = attempt;
    say("note",
      theirs
        ? `the app frame was on an older client (${theirs}); reloading it to match ${mine}`
        : `the app frame has no panel client yet; reloading it`);
    try {
      frame.location.reload();
    } catch {}
  }

  function installOptionHook() {
    const a = api();
    if (a && a !== INERT) a.onOptions = optionHook;
  }

  // While a tool is armed the app must not also react to the pointer: dragging a
  // marquee across a map would otherwise pan the map, and a press on a carousel
  // would advance it — both of which move the very thing being captured.
  // Registered after the gesture handlers, so those still see the event, then it
  // stops descending before any app listener does.
  //
  // Move events are deliberately NOT blocked: a press cannot start a pan once
  // pointerdown is shielded, and leaving hover alive means a hover state can still
  // be captured.
  const SHIELDED = [
    "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick",
    "contextmenu", "dragstart", "selectstart", "touchstart", "touchend",
  ];

  const fromOurUi = (e) => !shell && e.target instanceof Node && host.contains(e.target);

  // During a capture's wait the page has to be usable: a card flip, a menu, a
  // hover state — none of them can be photographed if the tool is swallowing the
  // click that triggers them.
  let interacting = false;

  function installShield() {
    for (const type of SHIELDED) {
      onSource(type, (e) => {
        if (!banding() || interacting || fromOurUi(e)) return;
        e.stopPropagation();
        // These would start a native drag or a text selection over the app.
        if (type === "dragstart" || type === "selectstart") e.preventDefault();
      }, true);
    }
  }

  // Rubber band. A press that travels more than a few pixels becomes a rectangle
  // instead of a click; the click it would otherwise produce is swallowed.
  let band = null;
  let swallowClick = false;

  const banding = () => mode === "pick" || mode === "shot";

  onSource("pointerdown", (e) => {
    if (!banding() || interacting || e.button !== 0) return;
    if (!shell && e.target instanceof Node && host.contains(e.target)) return;
    band = { x: e.clientX, y: e.clientY, box: null, mode };
  }, true);

  onSource("pointermove", (e) => {
    if (!band) return;
    // Tracked every move so holding or releasing Alt mid-drag re-highlights, rather
    // than the modifier only mattering at the instant you let go.
    band.container = e.altKey;
    if (!band.box && Math.abs(e.clientX - band.x) + Math.abs(e.clientY - band.y) < 6) return;

    if (!band.box) {
      band.cands = document.createElement("div");
      ui.layer.appendChild(band.cands);
      band.box = document.createElement("div");
      band.box.className = `marquee${band.mode === "shot" ? " shot" : ""}`;
      ui.layer.appendChild(band.box);
      document.documentElement.style.userSelect = "none"; // or the drag selects text
      clearHover();
    }
    e.preventDefault();

    const r = project({
      left: Math.min(band.x, e.clientX), top: Math.min(band.y, e.clientY),
      width: Math.abs(e.clientX - band.x), height: Math.abs(e.clientY - band.y),
    });
    Object.assign(band.box.style, {
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    });

    if (band.mode === "pick") showCandidates({
      left: band.x, top: band.y, right: e.clientX, bottom: e.clientY,
    });
  }, true);

  // Drawn on a frame boundary rather than on every pointermove: the scan walks the
  // whole document, and a fast drag fires far more moves than frames.
  function showCandidates(box) {
    if (!band) return;
    // Coalesce: keep the newest rectangle and let the scheduled scan read that,
    // rather than closing over whichever box happened to schedule it. Otherwise a
    // fast drag highlights a stale rectangle and every later move is dropped.
    band.pendingBox = box;
    if (band.scanning) return;
    band.scanning = true;
    requestAnimationFrame(() => {
      if (!band?.cands) return;
      band.scanning = false;
      const found = api().previewArea(band.pendingBox, { container: band.container });
      band.cands.textContent = "";
      let n = 0;
      for (const c of found) {
        const r = project(c.rect);
        const el = document.createElement("div");
        el.className = `cand${c.already ? " already" : ""}`;
        Object.assign(el.style, {
          left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
        });
        if (!c.already) {
          const tag = document.createElement("span");
          tag.className = "n";
          tag.textContent = String(api().picked.length + ++n);
          el.appendChild(tag);
        }
        band.cands.appendChild(el);
      }
      const fresh = found.filter((c) => !c.already).length;
      ui.hint.textContent = fresh
        ? `${fresh} element${fresh === 1 ? "" : "s"} inside` +
          (found.length - fresh ? `, ${found.length - fresh} already picked` : "")
        : "nothing selectable inside yet";
      ui.tray.classList.add("on");
    });
  }

  onSource("pointerup", (e) => {
    if (!band) return;
    const dragged = Boolean(band.box);
    const start = { x: band.x, y: band.y };
    const dragMode = band.mode;
    if (band.box) band.box.remove();
    if (band.cands) band.cands.remove();
    band = null;
    document.documentElement.style.userSelect = "";
    if (!dragged) return;

    // Cleared by the click it swallows, not by a timer: nothing here should depend
    // on a click arriving before the next macrotask. The timer is only a backstop
    // for the case where no click follows at all.
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 400);

    const box = { left: start.x, top: start.y, right: e.clientX, bottom: e.clientY };
    if (dragMode === "shot") return void shoot({ region: box });

    const result = api().pickArea(box, { container: e.altKey });
    paint();
    if (result.note) return hint(result.note);
    if (!result.added.length) {
      return hint(result.already ? "those were already selected" : "nothing selectable in that rectangle");
    }
    hint(`added ${result.added.join(", ")}` +
      (result.already ? ` · ${result.already} already picked` : "") +
      (result.skipped ? ` · ${result.skipped} ignored, cap is 20` : "") +
      // Discoverable where it is relevant: the moment the marquee picked children and
      // the container might have been wanted instead.
      (e.altKey ? " · container" : result.added.length > 1 ? " · hold Alt for the container" : ""));
  }, true);

  function clearHover() {
    if (!hover) return;
    hover.remove();
    hover = null;
  }

  onSource("mousemove", (e) => {
    if (interacting) return clearHover();
    // Only Select highlights elements. Showing it in Screenshot mode read as
    // "selection is live" when the tool captures regions, not elements.
    if (mode !== "pick" || band?.box) return clearHover();
    // Over our own UI there is nothing to highlight. Returning without clearing
    // used to leave the last box stranded on the page.
    const el = elementAt(e.clientX, e.clientY);
    if (!el) return clearHover();
    const r = project(el.getBoundingClientRect());
    if (!hover) {
      hover = document.createElement("div");
      hover.className = "hover";
      ui.layer.appendChild(hover);
    }
    Object.assign(hover.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }, true);

  // Leaving the page stops mousemove entirely, so the highlight has to be cleared
  // by something else: the pointer crossing out of the window, or onto the panel.
  onSource("mouseout", (e) => {
    if (!e.relatedTarget) clearHover();
  }, true);
  onSource("blur", clearHover, true);
  ui.panel.addEventListener("pointerenter", clearHover);
  ui.fab.addEventListener("pointerenter", clearHover);

  // Hit-testing has to ask the document that actually holds the app.
  function elementAt(x, y) {
    const doc = source()?.document;
    if (!doc) return null;
    const el = doc.elementFromPoint(x, y);
    if (!el) return null;
    if (!shell && host.contains(el)) return null;
    return el;
  }

  const describeIdentity = (id) =>
    id.id ? `#${id.id}` : id.classes?.length ? `${id.tag}.${id.classes[0]}` : (id.tag ?? "?");

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `<${tag}#${el.id}>`;
    const cls = String(el.className || "").split(/\s+/).filter(Boolean)[0];
    return cls ? `<${tag}.${cls}>` : `<${tag}>`;
  }

  function report(result) {
    if (!result) return;
    paint();
    if (result.action === "deselected") {
      hint(`dropped ${result.ref}` +
        (result.total ? `, renumbered 1–${result.total}` : "") +
        (result.previewCleared ? " · preview cleared" : ""));
    } else {
      hint("");
    }
  }

  onSource("click", (e) => {
    // Without this, approving a variant, flipping between them, or any other
    // click on the panel's own controls — all real clicks, all handled — was
    // also reaching here, where the page has nothing at those coordinates, and
    // reporting a confusing "hit nothing selectable" for a click that worked.
    if (!banding() || interacting || fromOurUi(e)) return;
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const el = elementAt(e.clientX, e.clientY);
    if (!el) {
      hint("that click reached the tool but hit nothing selectable — try /diag");
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (mode === "shot") {
      // Region-only: without the element highlight there is no way to see what a
      // click would capture, so a click is a miss rather than a surprise.
      return hint("drag a rectangle over the area you want");
    }
    report(api().pick(el));
  }, true);

  onSource("pointerdown", () => announce("focus"), true);
  installShield(); // last, so the gesture handlers above still receive events
  onSource("scroll", paint, true);
  onSource("resize", paint);

  // A stylesheet swap — Vite's HMR, a live-reload shim, or the agent's own edit
  // landing — moves elements without a scroll or a resize, and the rings used to
  // stay where the elements had been, so a fix that moved a button looked like it
  // had torn the button out of its outline. Sheet churn in <head> and a stylesheet
  // finishing loading both mean layout may have moved; repaint once it settles.
  let settling = false;
  function settleThenPaint() {
    if (settling || !api().picked.length) return;
    settling = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { settling = false; paint(); }));
  }
  onSource("load", (e) => { if (e.target?.tagName === "LINK") settleThenPaint(); }, true);
  let sheetWatch = null;
  function watchSheets() {
    sheetWatch?.disconnect();
    const head = source()?.document?.head;
    if (!head) return;
    sheetWatch = new MutationObserver(settleThenPaint);
    sheetWatch.observe(head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
  }
  watchSheets();

  // --------------------------------------------------------------- options

  installOptionHook();

  function optionHook(state) {
    ui.opts.classList.toggle("on", !!state);
    if (!state) {
      ui.picks.textContent = "";
      return;
    }
    open(true);

    const onOriginal = state.active < 0;
    ui.optLabel.textContent = onOriginal ? "Original" : state.options[state.active].label;
    ui.optCount.textContent = onOriginal
      ? `the page as it is · ${state.options.length} variants · markers back`
      : `${state.active + 1} of ${state.options.length} · markers hidden`;

    ui.picks.textContent = "";
    const chip = (face, title, index, extra = "") => {
      const b = document.createElement("button");
      b.textContent = face;
      b.className = `${extra}${index === state.active ? " on" : ""}`;
      b.title = title;
      b.addEventListener("click", () => api().flip(index));
      ui.picks.appendChild(b);
    };

    chip("Original", "The page as it is", -1, "original");
    state.options.forEach((opt, i) => chip(String(i + 1), `${i + 1} — ${opt.label}`, i));

    paint(); // the markers hide on a variant and return on the original

    const approve = root.querySelector('[data-act="approve"]');
    approve.disabled = onOriginal;
    approve.title = onOriginal ? "Pick a variant to approve" : "Send this variant to be written to source";
  };

  addEventListener("keydown", (e) => {
    if (!ui.lightbox.classList.contains("on")) return;
    if (e.key === "Escape") { hideLightbox(); e.stopPropagation(); return; }
    if (e.key === "ArrowRight") { viewing++; paintLightbox(); e.stopPropagation(); }
    if (e.key === "ArrowLeft") { viewing--; paintLightbox(); e.stopPropagation(); }
    if (e.key === "Delete" || e.key === "Backspace") {
      const here = allFrames()[viewing];
      if (here) removeFrame(here.shot, here.frame);
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  function onKey(e) {
    if (e.target === ui.input) return;

    // Ctrl/Cmd-Z steps the selection back.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      const result = api().undo();
      paint();
      hint(result
        ? `undone · ${result.total} selected` + (result.previewCleared ? " · preview cleared" : "")
        : "nothing to undo");
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Escape unwinds one layer at a time, innermost first.
    if (e.key === "Escape") {
      // A capture waiting on you is the innermost layer of all, and it has its own
      // handler; unwinding further would disarm the tool in the same keystroke.
      if (interacting) return;
      if (api().optionState) { api().dismissOptions(); hint("options dismissed"); return; }
      if (api().picked.length) {
        const { cleared, previewCleared } = api().clearSelection();
        paint();
        hint(`deselected ${cleared}` + (previewCleared ? " · preview cleared" : ""));
        return;
      }
      if (mode) { setMode(null); hint("tool off"); return; }
      return;
    }

    if (!api().optionState) return;
    if (e.key === "ArrowRight") api().flip(api().optionState.active + 1);
    if (e.key === "ArrowLeft") api().flip(api().optionState.active - 1);
  }

  onSource("keydown", onKey, true);   // keys pressed over the app
  addEventListener("keydown", onKey, true); // and over the panel

  // ------------------------------------------------------- launcher + drag

  // A reload is not always ours to avoid: Vite does a full one whenever a change is
  // not hot-updatable, and the panel came back closed and back in the corner, with the
  // user's size and position gone. Kept per tab, so a *new* tab still starts closed —
  // which is the right default for a tool nobody has opened yet.
  const UI_STATE_KEY = "uitalk.ui";

  function saveUiState() {
    try {
      sessionStorage.setItem(UI_STATE_KEY, JSON.stringify({
        open: ui.panel.classList.contains("open"),
        width: ui.panel.style.width || null,
        height: ui.panel.style.height || null,
        right: ui.fab.style.right || null,
        bottom: ui.fab.style.bottom || null,
      }));
    } catch {}
  }

  function restoreUiState() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(UI_STATE_KEY) ?? "null");
    } catch {}
    if (!saved) return;

    ui.panel.classList.toggle("open", Boolean(saved.open));
    // In the shell the panel is the split column: its geometry belongs to the dock,
    // not to a remembered drag.
    if (shell) return;
    if (saved.height) {
      ui.panel.style.height = saved.height;
      ui.panel.style.maxHeight = "none";
    }
    if (saved.width) ui.panel.style.width = saved.width;
    if (saved.right) {
      ui.fab.style.right = saved.right;
      ui.panel.style.right = `${Math.min(parseFloat(saved.right) || 20, innerWidth - 392)}px`;
    }
    if (saved.bottom) {
      ui.fab.style.bottom = saved.bottom;
      ui.panel.style.bottom = `${(parseFloat(saved.bottom) || 20) + 58}px`;
    }
  }

  const open = (on) => {
    ui.panel.classList.toggle("open", on ?? !ui.panel.classList.contains("open"));
    saveUiState();
  };

  let drag = null;
  ui.fab.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    ui.fab.setPointerCapture(e.pointerId);
  });

  ui.fab.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) {
      drag.moved = true;
      ui.fab.classList.add("dragging");
    }
    if (!drag.moved) return;
    const right = Math.max(8, innerWidth - e.clientX - 23);
    const bottom = Math.max(8, innerHeight - e.clientY - 23);
    ui.fab.style.right = `${right}px`;
    ui.fab.style.bottom = `${bottom}px`;
    ui.panel.style.right = `${Math.min(right, innerWidth - 392)}px`;
    ui.panel.style.bottom = `${bottom + 58}px`;
  });

  ui.fab.addEventListener("pointerup", (e) => {
    const wasDrag = drag?.moved;
    drag = null;
    ui.fab.classList.remove("dragging");
    ui.fab.releasePointerCapture(e.pointerId);
    if (wasDrag) saveUiState();
    else open();
  });

  // ------------------------------------------------------------- resize grip

  (() => {
    const MIN = { w: 300, h: 220 };
    const grips = {
      n: root.querySelector(".grip"),
      w: root.querySelector(".grip-w"),
      nw: root.querySelector(".grip-nw"),
    };
    let from = null;

    for (const [edge, grip] of Object.entries(grips)) {
      grip.addEventListener("pointerdown", (e) => {
        const box = ui.panel.getBoundingClientRect();
        from = { edge, x: e.clientX, y: e.clientY, w: box.width, h: box.height, grip };
        grip.classList.add("dragging");
        grip.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      grip.addEventListener("pointermove", (e) => {
        if (!from) return;
        // The panel is anchored bottom-right, so both edges grow as the pointer
        // travels away from that corner.
        if (from.edge !== "w") {
          const h = Math.max(MIN.h, Math.min(innerHeight - 60, from.h + (from.y - e.clientY)));
          ui.panel.style.height = `${h}px`;
          ui.panel.style.maxHeight = "none";
        }
        if (from.edge !== "n") {
          const w = Math.max(MIN.w, Math.min(innerWidth - 40, from.w + (from.x - e.clientX)));
          ui.panel.style.width = `${w}px`;
        }
      });

      const end = (e) => {
        if (!from) return;
        from.grip.classList.remove("dragging");
        try {
          from.grip.releasePointerCapture(e.pointerId);
        } catch {}
        from = null;
        saveUiState();
      };
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
    }
  })();

  // Runtime state, printed locally rather than sent anywhere. When a gesture does
  // nothing, this says which link in the chain is missing.
  function diagnose() {
    const w = source();
    let frameUrl = "n/a";
    let frameApi = "n/a";
    let bodyChildren = "n/a";
    try {
      if (shell) {
        frameUrl = w?.location?.href ?? "unreachable";
        frameApi = typeof w?.UITalk?.pick === "function" ? "ready" : `missing (${typeof w?.UITalk})`;
        bodyChildren = String(w?.document?.body?.children?.length ?? "?");
      } else {
        frameUrl = location.href;
        frameApi = typeof UITalk?.pick === "function" ? "ready" : "missing";
        bodyChildren = String(document.body?.children?.length ?? "?");
      }
    } catch (err) {
      frameUrl = `threw: ${err.message}`;
    }

    const t = xform();
    return [
      `build: ${globalThis.__UITALK_BUILD__ ?? "unstamped"}`,
      `mode: ${mode ?? "none"}   shell: ${shell ? "yes" : "no"}`,
      `page window: ${w ? "present" : "MISSING"}   same as panel: ${w === window}`,
      `page url: ${frameUrl}`,
      `page api: ${frameApi}   body children: ${bodyChildren}`,
      `client build: panel ${globalThis.__UITALK_BUILD__ ?? "?"}` +
        (shell ? `   frame ${(() => { try { return w?.__UITALK_BUILD__ ?? "none"; } catch { return "unreachable"; } })()}` : ""),
      `gesture listeners: ${pageListeners.length} registered, attached to ${attachedTo ? "a document" : "NOTHING"}`,
      `socket: ${ws?.readyState === 1 ? "open" : `state ${ws?.readyState}`}`,
      `selected: ${api().picked.length}   transform: x${t.scale} at ${Math.round(t.left)},${Math.round(t.top)}`,
      `tools row: ${root.querySelector(".tools") ? "present" : "MISSING"}   ` +
        `select button: ${(() => {
          const b = root.querySelector('[data-act="pick"]');
          return b ? `[${[...b.classList].join(" ")}] mode-attr=${b.dataset.mode ?? "none"}` : "MISSING";
        })()}`,
      `panel clicks seen: ${panelClicks} (last act: ${lastAct ?? "none"})`,
      `elementFromPoint at centre: ${(() => {
        try {
          const el = w?.document?.elementFromPoint(
            Math.round((w.innerWidth ?? 0) / 2), Math.round((w.innerHeight ?? 0) / 2));
          return el ? `<${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}>` : "null";
        } catch (err) { return `threw: ${err.message}`; }
      })()}`,
    ].join("\n");
  }

  // --------------------------------------------------------------- actions


  let panelClicks = 0;
  let lastAct = null;

  root.addEventListener("click", async (e) => {
    panelClicks++;
    const act = e.target.closest("[data-act]")?.dataset.act;
    lastAct = act ?? `(no data-act on <${e.target.tagName?.toLowerCase?.() ?? "?"}>)`;
    if (!act) return;

    if (act === "settings") {
      const on = ui.settings.classList.toggle("on");
      ui.panel.classList.toggle("settings-open", on);
    }
    if (act === "compact-now") { say("note", "compacting on request…"); send({ kind: "compact_now" }); }
    if (act === "clear-session") { send({ kind: "clear" }); }
    if (act === "pick") setMode("pick");

    if (act === "clear") {
      const { cleared } = api().clearSelection();
      paint();
      hint(cleared ? `cleared ${cleared} element${cleared === 1 ? "" : "s"}` : "nothing was selected");
    }

    // An action, not a mode: it shoots what is selected right now. As a mode it
    // would have to drop the selection on activation, and could then only ever
    // photograph the whole page.
    if (act === "shot") {
      setMode("shot");
      if (mode === "shot") hint("drag over an area, or click one element");
    }

    if (act === "revert") {
      send({ kind: "revert" });
      hint("reverting…");
    }

    if (act === "discard-shot") {
      const n = shots.length;
      shots.length = 0;
      hideLightbox();
      syncShotBadge();
      renderTray();
      hint(n ? `discarded ${n} screenshot${n === 1 ? "" : "s"}` : "nothing queued");
    }

    if (act === "reset") { api().resetPreview(); paint(); hint("preview cleared"); }
    if (act === "prev") api().flip(api().optionState.active - 1);
    if (act === "next") api().flip(api().optionState.active + 1);

    if (act === "approve") {
      const choice = api().chosenOption();
      if (!choice) return hint("that is the original — pick a variant first");

      // Read the values the preview is producing *now*, before it is dismissed:
      // they are what the committed edit has to reproduce, and the usual failure is
      // an edit that lands somewhere with lower specificity and changes nothing.
      const props = declaredProperties(choice.declarations);
      const previewed = api().computedOf({ ref: choice.ref, selector: choice.element?.selector, properties: props });

      // Photograph the element as it stands, so the committed result can be judged
      // against it rather than described.
      void captureBefore(choice, { props, previewed });
      sayMine(`approved: ${choice.label}`, { shots: [], refs: choice.ref ? [choice.ref] : [] });
      send({ kind: "approval", ...choice });
      api().dismissOptions();
    }

    if (act === "discard") { api().resetPreview(); paint(); say("note", "options discarded"); }
  });

  // Only recall when the caret is on the edge line; otherwise Up and Down should
  // move the caret through a multi-line message, as they normally would.
  const caretOnFirstLine = () =>
    ui.input.selectionStart === ui.input.selectionEnd &&
    !ui.input.value.slice(0, ui.input.selectionStart).includes("\n");

  const caretOnLastLine = () =>
    ui.input.selectionStart === ui.input.selectionEnd &&
    !ui.input.value.slice(ui.input.selectionEnd).includes("\n");

  function remember(text) {
    if (history.at(-1) !== text) history.push(text);
    while (history.length > MAX_RECALL) history.shift();
    recallIndex = null;
    draft = "";
  }

  function recall(step) {
    if (!history.length) return false;

    if (recallIndex === null) {
      if (step > 0) return false; // nothing newer than the draft
      draft = ui.input.value;
      recallIndex = history.length;
    }

    const next = recallIndex + step;
    if (next < 0) return true; // already at the oldest; swallow rather than wrap

    if (next >= history.length) {
      recallIndex = null;
      ui.input.value = draft;
      hint(draft ? "back to your draft" : "");
    } else {
      recallIndex = next;
      ui.input.value = history[next];
      hint(`recalled ${history.length - next} of ${history.length} — edit and send, or Esc to cancel`);
    }

    const end = ui.input.value.length;
    setTimeout(() => ui.input.setSelectionRange(end, end), 0);
    return true;
  }

  function cancelRecall() {
    if (recallIndex === null) return false;
    recallIndex = null;
    ui.input.value = draft;
    draft = "";
    hint("");
    return true;
  }

  ui.input.addEventListener("keydown", async (e) => {
    if (e.key === "ArrowUp" && caretOnFirstLine()) {
      if (recall(-1)) e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" && caretOnLastLine()) {
      if (recall(1)) e.preventDefault();
      return;
    }
    if (e.key === "Escape" && cancelRecall()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    const typed = ui.input.value.trim();
    if (typed === "/diag" || typed === "/diag pick") {
      e.preventDefault();
      ui.input.value = "";
      if (typed.endsWith("pick")) {
        // Bisect: arm the tool directly, bypassing the button. If this works and
        // the button does not, the fault is in the click path, not in setMode.
        const before = mode;
        setMode("pick");
        say("note", `setMode called directly: ${before ?? "none"} -> ${mode ?? "none"}`);
      }
      say("note", diagnose());
      return;
    }
    e.preventDefault();
    const text = ui.input.value.trim();
    if (!text) return;
    ui.input.value = "";
    remember(text);
    const wentWith = {
      shots: shots
        .flatMap((s) =>
          s.frames.map((f, i) => ({
            png: f.png,
            label: s.frames.length > 1 ? `${s.label} · frame ${i + 1} (+${f.at}ms)` : s.label,
            triggeredBy: i === 0 ? s.triggeredBy : undefined,
          })),
        )
        .slice(0, MAX_FRAMES_SENT),
      refs: api().picked.map((_, i) => i + 1),
    };
    sayMine(text, wentWith);

    const frame = {
      kind: "chat", text,
      page: { ...api().pageContext(), screen: shell?.screen() },
      selectionCount: api().picked.length,
    };
    if (shots.length) {
      frame.shots = wentWith.shots;
      shots.length = 0;
      hideLightbox();
      syncShotBadge();
      renderTray();
    }
    send(frame);
  });

  syncSplitLink();
  if (shell) {
    document.documentElement.dataset.uitalkPanel = "docked";
    ui.panel.classList.add("docked", "open");
    syncDock();
    shell.onChange(() => { reattach(); installOptionHook(); paint(); syncSplitLink(); syncDock(); });
    reattach();
  }

  // Put the panel back the way it was before the reload. After the shell block, so a
  // docked panel keeps its layout and only its open state is restored.
  restoreUiState();

  // A verification that outlived a reload picks up where it left off.
  (() => {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null");
      sessionStorage.removeItem(RESUME_KEY);
    } catch {}
    if (!saved?.props?.length) return;
    setTimeout(() => {
      say("note", `checking "${saved.label}" after the reload`);
      verifyCommitted(saved);
    }, 600);
  })();

  connect();
  paint();
  say("note", "Select: click elements in order, or drag a rectangle — what it would take is highlighted as you drag. Screenshot: drag over an area; several can be queued. Ctrl-Z steps a selection back, Esc clears it, Esc again turns the tool off.");
})();
