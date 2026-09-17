# Contributing to uitalk

The [README](README.md) covers what uitalk does and how to use it. This file is for
people changing it: how the suites are laid out, what is and is not measured, what has
actually been verified, and the one thing about a running bridge that will otherwise
cost you an afternoon.

## Setup

```bash
git clone https://github.com/haytham-breaka/uitalk.git
cd uitalk
npm install --include=dev   # .npmrc omits dev deps, which the suites need
npm test                    # every offline suite
npm run coverage            # the same, measured, failing under 85% lines
```

`.npmrc` carries `omit=dev` because Claude Code installs a plugin's dependencies with
`npm ci --ignore-scripts`, and jsdom and c8 have no business in a user's plugin cache.
That is also why the lockfile is committed.

To work on the plugin against a real app, `npm run install-plugin` symlinks the checkout
into `~/.claude/skills/uitalk`, so edits to `client/` or `server/` are what the next
session loads — there is no build step and no copy to keep in sync.

## Three conventions

Each was learned from a bug, which is why they are conventions and not preferences.

1. **A comment says why, not what.** The non-obvious constraints — why the upgrade
   `head` is written rather than unshifted, why the roll waits a frame past the click,
   why the dock side is a class rather than an attribute selector — are the ones worth
   writing down, and they are why those bugs have not come back.
2. **A test must fail against the bug it describes.** Several assertions here were
   written, passed, and proved worthless until checked against the broken code. If you
   add a regression test, revert the fix and watch it fail first. If it cannot be made
   to fail in the harness — jsdom has no layout engine, so anything that depends on real
   pixel coordinates is in that category — say so in the PR and verify it by hand
   instead of committing a test that only measures the mock.
3. **Tell the user what the tool could not do.** A capture that could not embed a font,
   a `locate_source` that fell back to searching HTML, a stylesheet that could not be
   read: each is reported rather than silently degraded. An answer with a hole in it is
   only useful if the hole is visible.

## Tests

```bash
node tools/dom-check.mjs                 # no server needed
node tools/ui-check.mjs                  # no server needed
node tools/raster-check.mjs              # the DOM rasterizer
node tools/capture-check.mjs             # frame strips, timelines, region cropping
node tools/agent-check.mjs               # the adapter and the agentless panel
node tools/mcp-check.mjs                 # the MCP server over real stdio
node tools/server-check.mjs              # bridge logic, no browser or agent needed
node tools/probe-ws.mjs                  # HMR passthrough, no server needed

node tools/fake-page.mjs "align element 2 to the top of element 1"
node tools/fake-page-approve.mjs         # these two drive a real agent
node tools/probe-context.mjs             # settings, meter, compaction, replay

npm test                                 # every offline suite
npm run coverage                         # the same, measured, failing under 85% lines
```

```
tools/
  dom-check.mjs          selection, geometry, preview, capture logic
  ui-check.mjs           panel gestures and the shell, via synthetic events
  raster-check.mjs       the DOM rasterizer, including what it refuses to inline
  capture-check.mjs      frame strips, click-triggered timelines, region cropping
  agent-check.mjs        the adapter's loop and wires, and the panel with no agent
  mcp-check.mjs          the MCP server end to end, over real stdio JSON-RPC
  server-check.mjs       settings, keys, registry, git snapshots, proxy, tool handlers
  probe-ws.mjs           HMR passthrough, including a frame packed into the handshake
  probe-context.mjs      meter, settings, compaction, replay (costs tokens)
  probe-tabs.mjs         multi-tab routing: calls follow the active tab
  probe-variations.mjs   screenshot-only request still mounts variants
  coverage.sh            runs every offline suite under c8, gated at 85% lines
  fake-page.mjs          agent loop, one turn
  fake-page-approve.mjs  alternatives -> approval -> source edit
  make-png.mjs           PNG encoder for the harnesses
  install-plugin.mjs     symlink into ~/.claude/skills/
```

`dom-check` runs the real client against a synthetic DOM: selection ordering, handle
stamping, greppable identifiers, ancestor layout, deltas, specificity doubling,
`!important` stripping, option mounting, and reset. The fake-page harnesses speak the
real socket protocol, so they exercise the bridge and the tool surface without a
browser.

## Coverage

`npm run coverage` runs every suite that needs no bridge, no agent and no tokens, and
fails under **85% lines**. As of 0.6.1 it sits at **84.6%** — the client at 89.7%, the
bridge at 77.0% — so **the gate currently fails on `main`** even though every suite
passes. The drop is `index.mjs`, at 51.8%: the OpenCode runner and the `ask_choice` /
`choice_answer` plumbing were added without an offline harness for them. The right fix
is the one `agent-check` already uses for the adapter — a fake HTTP server standing in
for `opencode serve` — not a lower threshold.

One file will always stay low. `index.mjs` is mostly the parts a test cannot reach
without spending money or taking a port: binding, the Claude session, the dispatch
paths. What it does around those — message building, routing, context accounting,
compaction, replay, reverts — is covered. `native.js` and `raster.js` can be driven up
to the point where real pixels are needed and no further: jsdom has no Screen Capture
API and cannot rasterize an SVG, and mocking those would measure the mock.

The agent-driven probes (`fake-page`, `probe-context`, `probe-tabs`, `probe-variations`)
run the bridge as a subprocess, so they cost tokens and contribute no coverage. They are
run by hand when the agent-facing behaviour changes.

## What has been verified

Against a React 19 + Vite app, with the built-in agent:

- Proxy injects into its HTML; `/src/main.jsx` and other assets pass through; HMR
  upgrades are forwarded.
- Push-driven input — a message reaches the agent with no polling.
- `read_selection` → relational reasoning produced `align-self: flex-start` from the
  ancestor's flex context rather than a margin hack.
- `capture` → image plus inventory reaches the agent as an image block.
- `show_options` → three labelled alternatives, then the turn ends to wait.
- Approval → the agent found the rule in `src/App.css`, merged declarations into the
  existing block, preserved nested `&:hover` selectors, and leaked no handle.
- Loads as a Claude Code plugin (`claude plugin validate` passes, no load errors),
  auto-loads from inside a project with no flags once linked, and `bin/uitalk`
  resolves on the Bash PATH.
- Zero-argument launcher from the app directory detected `:5173`, set the project to
  the working directory, and proxied the app's real page with the panel injected.
- 16/16 context assertions: settings round-trip with clamping, usage measured from
  real token counts, compaction through both stages, meter reset, transcript replayed
  to a second client — and **a fact stated before compaction was still known after
  it**, which is the only test that proves compaction is not just amnesia.
- Two bridges at once: auto-claimed 8400 and 8401, each proxying its own app, each
  agent reading only its own project root with no cross-talk. Registry pruned on
  kill; an explicit `UITALK_PORT` on a taken port failed with a clear message; the
  freed port was reclaimed by the next start.

In a real Chromium browser, driven by Playwright against a scripted model (this is how
the demo clips in `docs/media/` are made, and it is the one path that exercises real
layout and real pixel coordinates):

- Click-to-pick, drag to rubber-band, Ctrl-Z, Esc; drag to screenshot with the shot
  landing in the tray and travelling with the message.
- `show_options` mounting three variants, flipping between them, approving one, the
  bridge committing it to `style.css`, and undo reverting it through the git snapshot.
- `ask_choice` rendering buttons and the tap continuing the conversation.
- The split screen reached from the panel's ⧉, device presets, rotate.
- The panel-click false-hint bug that jsdom could not reproduce was found in this
  footage and is fixed — which is the argument for keeping this path around.

In `opencode` mode, against a live `opencode serve`: session creation, a message with a
selection reaching the session, a reply streaming back into the panel.

**Not yet exercised anywhere:** the native `getDisplayMedia` capture path in a headed
browser (the demo harness turns it off, because headless Chromium hangs on the
permission prompt), `try_markup` and `scan_region` end to end, and the rasterizer's
fidelity on fonts and images from a real page.

Open items: one agent session is shared by every tab, and `try_markup` is discarded by
a framework re-render.

## Updating a bridge that is already running

As a plugin, bump `version` in both `package.json` and `.claude-plugin/plugin.json` —
they are meant to match — and users get the new version; installed from a marketplace,
Claude Code installs the dependencies itself with `npm ci --ignore-scripts`.

Two things about a *running* bridge, because a long-lived process is the part that goes
stale:

- **The client is served from disk**, re-read when it changes. Updating the plugin or
  editing `client/` needs only a page reload, and a page still running an older build
  is told so by its build stamp rather than looking like a live bug.
- **The bridge's own code cannot be swapped under itself.** When `server/` changes on
  disk the panel says so and asks for `uitalk --stop && uitalk`. Silently serving old
  behaviour is how an already-fixed bug gets chased twice.

## Pull requests

- One change per PR, with the version bumped in both manifests when behaviour changes.
- `npm test` must pass. If a regression test would not fail against the bug, say so in
  the description rather than adding one that passes either way.
- Describe what the user sees differently, not what the diff does.
