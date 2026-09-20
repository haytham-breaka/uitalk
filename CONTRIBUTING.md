# Contributing to uitalk

The [README](README.md) covers what uitalk does and how to use it. This file is for
people changing it.

## Before you start

For a bug fix or a small, self-contained change, open a pull request directly. For
anything larger — a new agent mode, a new page tool, a change to the wire protocol —
open an issue first describing what you want to do and why. It's a single-maintainer
project, so aligning on the approach before you write the code saves a rewrite later.

## Development setup

```bash
git clone https://github.com/haytham-breaka/uitalk.git
cd uitalk
npm install --include=dev   # .npmrc omits dev deps; the suites need them
npm test
```

`.npmrc` carries `omit=dev` because Claude Code installs a plugin's dependencies with
`npm ci --ignore-scripts`, and jsdom and c8 have no reason to be in a user's plugin
cache. That's also why the lockfile is committed.

To try changes against a real app, `npm run install-plugin` symlinks the checkout into
`~/.claude/skills/uitalk`. There's no build step: an edit to `client/` or `server/` is
live in the next session.

```
.claude-plugin/
  plugin.json     plugin manifest
SKILL.md          the skill Claude Code invokes as /uitalk
bin/
  uitalk          launcher (Node, cross-platform); on PATH while the plugin is enabled
  uitalk.cmd      Windows shim for the same
server/
  index.mjs       proxy + socket + whichever session is answering
  tool-defs.mjs   the 12 page tools, defined once, owned by no agent SDK
  page-tools.mjs  those definitions shaped for the Claude Agent SDK
  adapter.mjs     the same tools driven by your own key, plus file tools
  mcp.mjs         the same tools over stdio, for any MCP client
  registry.mjs    which bridges are running, on which ports
  settings.mjs    layered per-app settings, validated and clamped; key lookup
  snapshots.mjs   git-backed snapshot and revert of a committed change
  usage.mjs       how widely a component is reused, for the ask-before-rippling check
  candidates.mjs  project-source search behind locate_source's last fallback
  proxy.mjs       HTML-response injection, CSP strip, websocket passthrough
client/           concatenated and served at /__uitalk/client.js
  api.js          identity, geometry, selection, preview layer
  raster.js       element/region -> PNG via foreignObject, fonts and images embedded
  native.js       real screen pixels via getDisplayMedia, cropped to the selection
  shell.js        split screen: device frame, presets, rotate, dock
  ui.js           launcher, tool palette, tray, chat, option flipper
tools/            test suites and agent-driven probes — see Testing below
docs/
  architecture.mmd  source of the README's diagram; media/ holds its two SVGs and the demo clips
  agent-modes.md    the four agent modes in full, keys, OpenCode and MCP setup
  configuration.md  every setting and environment variable
```

## Coding conventions

No linter or formatter is configured. Match the style of the file you're editing.
A few patterns are consistent across the codebase and PRs are expected to keep to them:

- ESM only, no default exports — `export const` / `export function` everywhere.
- One file, one responsibility (`tool-defs.mjs` defines tools, `settings.mjs` owns
  settings, `snapshots.mjs` owns git snapshots). A new concern gets a new file rather
  than a new corner of an existing one.
- `camelCase`; verb-first for a function that does something (`createAdapter`,
  `revertTo`, `saveCredential`), a noun for something that holds state.
- A failure path returns a result rather than throwing across the panel/agent boundary
  — `{ kind: "reverted", ok: false, text }` over the socket, `failed(err)` for an MCP
  tool. `settings.mjs`'s `validate()` collects every rejected field instead of stopping
  at the first.
- Shaping repeated in more than one place goes in a shared helper instead — `text()`
  and `failed()` in `tool-defs.mjs` are why every MCP content block has the same shape.
- A `/** */` block goes on an exported function only when its name and signature don't
  already say what it does. A plain `//` above a block is for a constraint the code
  itself can't show — why a handler waits a frame before acting, why a selector is a
  class and not an attribute — not a restatement of the line below it.

## Testing

```bash
npm test          # every offline suite
npm run coverage  # the same, measured
```

A regression test must fail against the bug it fixes. Before adding one, revert the fix
and confirm the test actually goes red. If the harness can't reproduce the bug — jsdom
has no layout engine, so anything depending on real pixel coordinates is in that
category — say so in the PR description and verify by hand instead of committing a test
that would pass either way.

| Suite | Covers |
|---|---|
| `tools/dom-check.mjs` | selection, geometry, preview, capture logic |
| `tools/ui-check.mjs` | panel gestures and the shell, via synthetic events |
| `tools/raster-check.mjs` | the DOM rasterizer, including what it refuses to inline |
| `tools/capture-check.mjs` | frame strips, click-triggered timelines, region cropping |
| `tools/agent-check.mjs` | the adapter's loop and wiring, and the panel with no agent |
| `tools/mcp-check.mjs` | the MCP server end to end, over real stdio JSON-RPC |
| `tools/server-check.mjs` | settings, keys, registry, git snapshots, proxy, tool handlers, the frame router and the OpenCode agent loop |
| `tools/probe-ws.mjs` | HMR passthrough, including a frame packed into the handshake |

`dom-check` runs the real client against a synthetic DOM. The `fake-page*` and `probe-*`
harnesses speak the real socket protocol and drive a live bridge as a subprocess, so
they exercise the agent-facing behaviour without a browser; they cost tokens and are
run by hand, not in CI:

```bash
node tools/fake-page.mjs "align element 2 to the top of element 1"
node tools/fake-page-approve.mjs   # alternatives -> approval -> source edit
node tools/probe-context.mjs       # settings, meter, compaction, replay
node tools/probe-tabs.mjs          # multi-tab routing
node tools/probe-variations.mjs    # screenshot-only request still mounts variants
```

### Coverage

`npm run coverage` gates the offline suites at 85% lines. It currently sits at **90%**
and passes. `server/index.mjs` is the lowest module (~76%): the OpenCode agent loop
is now exercised offline by faking the SDK (`setOpencodeForTest` in `server-check`, the
way `agent-check` fakes the adapter's `fetchImpl`), and the `ask_choice` / `choice_answer`
plumbing is covered too. What's left uncovered there is mostly the parts a test can't
reach without spending money or holding a port (see below).

`server/index.mjs` will always read lower than the rest: it's mostly the parts a test
can't reach without spending money or holding a port (binding, the live agent session,
the dispatch paths). `client/native.js` and `client/raster.js` are driven up to the
point where real pixels are needed and no further — jsdom has no Screen Capture API and
can't rasterize an SVG, and mocking those would just measure the mock.

### What's actually been verified

Everything above proves the code paths run; it doesn't prove the product works end to
end. Separately verified, by hand:

- Against a React 19 + Vite app, `builtin` mode: proxy injection and HMR passthrough,
  push-driven input, relational style reasoning (`align-self: flex-start` from the
  ancestor's flex context, not a margin hack), an approval that merged into an existing
  rule and preserved a nested `&:hover`, two bridges running at once with no cross-talk,
  a compacted session that still recalled a fact stated before compaction.
- In a real Chromium browser, via Playwright against a scripted model — the same
  pipeline that produces `docs/media/`: click-to-pick, drag-to-rubber-band, drag-to-
  screenshot, `show_options` through approval through undo, `ask_choice`, split screen.
  This is the only path that exercises real layout and real pixel coordinates, which is
  how the panel-click false-hint bug was found and fixed.
- In `opencode` mode, against a live `opencode serve`: session creation, a selection
  reaching the session, a streamed reply.
- **In Firefox**, `--agent off`: proxy injection, the panel opening from a cold page,
  click-to-select drawing a numbered badge, a screenshot drag producing a thumbnail
  through the `raster.js` `foreignObject`→canvas path, and split screen loading the app
  inside the device iframe — 8/8, no uncaught page errors. This is the one client code
  path with real cross-engine risk (canvas tainting and `foreignObject` support have
  historically diverged between engines), and it holds up. Script:
  `uitalk-demos/scripts/smoke-firefox.mjs`.

**Known not to work here, not in the product:** WebKit could not be installed on this
machine — `playwright install webkit` downloads it, but launching it needs a GTK4 /
GStreamer stack (`libgtk-4.so.1` and ~18 others) this Linux box doesn't have. That's a
missing system library, not a finding about uitalk; it has not been run against WebKit
at all, in either direction.

**Not exercised anywhere:** the native `getDisplayMedia` path in a headed browser (every
headless engine — not just Chromium — either has no real display to share or hangs on
the permission prompt, which is why the demo harness disables it), `try_markup` and
`scan_region` end to end, rasterizer fidelity on fonts and images from a real page.

**Known gaps:** one agent session is shared by every browser tab; `try_markup` swaps in
raw HTML behind React/Vue/Svelte's back, so the replacement carries no component state
or event bindings and a re-render discards it outright — treat it as a visual mockup,
never as evidence that the real component would behave the same way.

## Updating a running bridge

A bridge is a long-lived process, which is the part that goes stale:

- **The client is served from disk** and re-read on every request. A page reload picks
  up a `client/` change with no restart; a page running an older build is told so by its
  build stamp rather than silently misbehaving.
- **The bridge's own code can't be swapped under itself.** When `server/` changes on
  disk, the panel says so and asks for `uitalk --stop && uitalk`. Serving the old
  behaviour silently is how an already-fixed bug gets chased twice.

As a plugin, bump `version` in both `package.json` and `.claude-plugin/plugin.json` —
they're meant to match. Installed from the marketplace, Claude Code installs
dependencies itself with `npm ci --ignore-scripts`.

## Submitting a pull request

- Keep it to one change. Bump `version` in both manifests when behaviour changes.
- `npm test` passes. If a regression test can't be made to fail against the bug, say so
  in the description instead of adding one that would pass either way.
- Describe what changes for the user, not what changed in the diff — the diff is right
  there.

## Reporting a bug

Open an [issue](https://github.com/haytham-breaka/uitalk/issues) with:

- What you expected, what happened instead.
- The `agent` mode in use, and the app you were testing against (framework, dev server).
- `~/.uitalk/logs/<project>.log` (`%USERPROFILE%\.uitalk\logs\` on Windows), or a
  `UITALK_DEBUG=2` run if the log doesn't show it.
- Steps to reproduce, if you have them. If you don't, say what you were doing when it
  happened — that's still useful.
