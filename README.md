# uitalk

Edit a running web app from inside the page. A floating icon opens a tool palette:
pick elements in order, describe the change, flip through alternatives, approve
one, and the agent commits it to real source.

Nothing is written into your project to install it, and no credentials live in the
client — the agent is your own already-authenticated Claude Code, so there is no
second API bill.

## Install

Either as a standalone command, or as a Claude Code plugin. Both give you the same
`uitalk` binary and the same panel.

**As a command** (not on npm yet, so from a clone):

```bash
git clone https://github.com/haytham-breaka/uitalk.git ~/src/uitalk
cd ~/src/uitalk && npm install && npm link
cd ~/code/my-app
uitalk --dev "npm run dev"
```

**For Claude Code**, so the agent can start it for you:

```bash
cd ~/src/uitalk && npm run install-plugin
```

That symlinks the directory into `~/.claude/skills/`, which is the quickest way to load
it: no marketplace, no `--plugin-dir`, and an edit to the source shows up in the next
session. The repository is also a valid plugin — `.claude-plugin/plugin.json`, checked
by `claude plugin validate .` — if you would rather install it the packaged way.

Then, from inside your app:

```bash
cd ~/code/my-app
npm run dev &
claude
> /uitalk
```

The skill starts the bridge, finds your dev server, and hands you the URL.

```bash
uitalk                 # start detached, print the URL, exit
uitalk --dev "npm run dev"   # run the dev server detached too
uitalk --app-port 3000
uitalk --status        # is one running for this project?
uitalk --stop          # stop this project's bridge
uitalk --list          # every bridge running
uitalk --fg            # foreground instead (Ctrl-C to stop)
```

Requires **Node 20.11+** and, for native screen capture, a Chromium browser. The
default mode needs nothing but your existing Claude Code login. A key is required only
if you choose `--agent adapter`, and then it is read from the environment or
`~/.uitalk/credentials.json` — never from the project, and never sent to the page.

The `uitalk` launcher (`bin/uitalk`) is plain Node, so it runs the same way on Linux,
macOS and native Windows (cmd.exe or PowerShell) — no bash, WSL or Git Bash required.

**It detaches by default, and that matters.** A bridge has to outlive the shell that
started it. Run as a background job of an agent's shell, it gets reaped when that shell
goes away — which kills the live session mid-edit. `uitalk` puts the server in its own
session (a new process group on Linux/macOS; a console-detached process on Windows), so
a signal aimed at the caller cannot reach it, then waits for it to claim a port and
prints the real URL. Logs go to `~/.uitalk/logs/<project>.log` (`%USERPROFILE%\.uitalk\logs\` on Windows).

Starting it again while one is already up for the same project just prints that URL, so
it is safe to re-run.

## Which model answers

The page half of uitalk is model-agnostic: selection, screenshots, preview, variants
and undo are the browser's and git's work, not a model's. What varies is who reads
your message. One setting chooses:

| `agent` | Who answers | Costs |
| --- | --- | --- |
| `builtin` *(default)* | the Claude Code session the bridge runs itself | your existing subscription, no API key |
| `adapter` | any model you hold a key for — OpenAI, Anthropic, Gemini, or anything OpenAI-compatible | that provider's per-token price |
| `off` | nobody here: an MCP client drives the page tools from your editor | whatever your editor already costs |

```bash
uitalk                                     # built-in Claude session
uitalk --no-agent                          # MCP client drives it
uitalk --agent adapter                     # your key, OpenAI by default
uitalk --agent adapter --provider gemini --model gemini-2.5-pro
```

Or commit the choice to the project, in `.uitalk.json`:

```json
{ "agent": "adapter", "agentProvider": "anthropic", "agentModel": "claude-opus-5" }
```

What each mode can and cannot do:

| | `builtin` | `adapter` | `off` |
| --- | --- | --- | --- |
| The 12 page tools | ✅ | ✅ | ✅ |
| Edits source after an approval | ✅ Claude Code's own file tools | ✅ `read_file`, `edit_file`, `write_file`, `list_dir`, `search_files`, scoped to the project | ✅ your editor's |
| Chat in the panel | ✅ | ✅ | ❌ — type in your editor; the panel says so instead of swallowing it |
| Context meter, compaction, New session | ✅ | ✅ | ❌ — the conversation is in your editor, so there is nothing here to measure or compact |
| Undo a committed change | ✅ | ✅ | ✅ — and the MCP client is told it happened, so it will not re-apply it |
| Streams the reply token by token | ✅ | ❌ — a turn arrives whole | n/a |

### Your own key

The adapter needs a key, and never takes one as an argument — that would put it in
your shell history. It reads, in order: `$UITALK_API_KEY`, then the provider's own
variable (`$OPENAI_API_KEY`, `$ANTHROPIC_API_KEY`, `$GEMINI_API_KEY`), then
`~/.uitalk/credentials.json`:

```json
{ "openai": "sk-…", "gemini": "…" }
```

That file is written `0600`, and a key is never a setting: it cannot go in
`.uitalk.json` (which is meant to be committed) and is never sent to the page.

`agentBaseUrl` points the OpenAI shape at something else — a local llama.cpp server,
OpenRouter, Groq, an internal gateway. `agentModel` defaults to a current model per
provider; if the provider answers `404`, the error names the setting to change.

The built-in session is the only mode that needs `@anthropic-ai/claude-agent-sdk`, so
it is an **optional** dependency. `npm install --omit=optional` gives you a uitalk that
runs the adapter and MCP modes with nothing from Anthropic installed.

## Other editors

A standalone MCP server exposes all of the page tools over stdio, so Cursor, Cline,
Windsurf, Zed, Continue — any MCP client — can select elements, capture, preview and
offer variants. Start the bridge with `--no-agent` so it is not also running a session
you are not using:

```json
{
  "mcpServers": {
    "uitalk": {
      "command": "uitalk-mcp",
      "env": { "UITALK_PROJECT": "/path/to/your/app" }
    }
  }
}
```

Start the bridge as usual (`uitalk --dev "npm run dev"`); the MCP server finds it
through the registry, or takes `UITALK_PORT` if you would rather be explicit.

**One thing changes shape.** With the built-in session, your choice of variant — or your
answer to a plain question — arrives as a *message*. MCP is request/response and a
server cannot push one, so there are two extra tools: after `show_options`, the client
calls **`await_choice`**; after `ask_choice`, it calls **`await_answer`**. Each blocks
until you pick and returns what you chose. Everything else is identical.

What stays behind with the built-in session: the in-panel chat, context compaction, the
context meter, transcript replay, and the unprompted "that edit did not take effect"
nudge — all of which need an agent the bridge can push messages into. The panel hides
those controls rather than leaving them to do nothing.

The other direction has the same problem and is solved the same way: when you undo a
change or start a new session, there is no way to call your editor. The message waits
and is prepended to the next tool result it asks for, so a client cannot re-apply an
edit you have just reverted.

### Two agents, not one

The session you type `/uitalk` into and the session behind the panel are
**different agents with separate contexts**. The skill only launches the bridge; the
bridge runs its own agent against the same project. That keeps your terminal session
free, and it means the panel's context meter and compaction settings apply to the
panel's agent alone. The bridge proxies your
dev server and injects the panel into the HTML on the way through, so the app needs
no change — this is what makes it work with Vite, Next, Rails, Django, PHP, Go
templates, or plain static files without any framework-specific code.

Prefer your own URL? `curl http://127.0.0.1:8400/__uitalk/bookmarklet` prints a
bookmarklet that loads the same client. It needs re-clicking after each reload, and
a strict app CSP can block it.

From a terminal agent, `skill/SKILL.md` is an agent skill: ask for live editing and
it finds the port, starts the bridge, and hands back the URL.

| Env var | Default | Meaning |
|---|---|---|
| `UITALK_PROJECT` | `cwd` | Project root the agent reads and edits |
| `UITALK_APP_PORT` | `5173` | Your dev server's port |
| `UITALK_APP_HOST` | `127.0.0.1` | Your dev server's host |
| `UITALK_PORT` | *first free from 8400* | Pin the bridge's port. Leave unset to run several at once. |
| `UITALK_HOME` | `~/.uitalk` | Where the instance registry lives |
| `UITALK_RPC_TIMEOUT` | `5000` | Milliseconds before a page call is abandoned |
| `UITALK_DEBUG` | unset | `1` logs agent events, `2` dumps them |

## Several at once

One bridge serves one app, so run as many as you have projects — each claims its own
port and owns its own agent session, project root and page sockets. The injected
client derives its socket from `location.host`, so nothing needs configuring per
instance.

```bash
# terminal 1
UITALK_PROJECT=~/code/my-app   UITALK_APP_PORT=5173 npm start   # -> :8400

# terminal 2
UITALK_PROJECT=~/code/storefront UITALK_APP_PORT=3000 npm start   # -> :8401

node server/index.mjs --list
#   :8400 -> 127.0.0.1:5173  pid 8117  /home/you/code/my-app
#   :8401 -> 127.0.0.1:3000  pid 8159  /home/you/code/storefront
```

**Several tabs on one bridge** is fine: each announces itself, and page calls follow
whichever you last used. The meter row shows a count when more than one is connected,
so you can tell. A background tab is never asked — its `requestAnimationFrame` is
paused, which used to make captures hang.

Instances are recorded in `~/.uitalk/instances.json`, removed on exit, and
pruned if a process dies, so `--list` never shows a phantom.

## Context and settings

The panel shows a context meter (percent, tokens used, window). When usage crosses
the threshold, the bridge compacts between turns: the agent writes a handover note to
itself, the session is cleared, and the note is pushed back in — so facts survive but
the token cost of the transcript does not.

`/compact` is not available to an SDK-driven session (sent as a message it is read as
plain English), which is why compaction is built from `/clear`, which is.

Settings live behind the ⚙ in the meter row, and persist to `.uitalk.json` in the
project — per app, so each can have its own budget.

| Setting | Default | Means |
|---|---|---|
| `autoCompact` | `true` | Compact automatically at the threshold |
| `compactAtPercent` | `20` | Percent of the window that triggers compaction |
| `contextTokens` | `200000` | Your window size. **Raise to `1000000` on a 1M-context setup** |
| `compactCooldownTurns` | `2` | Turns to wait before compacting again |
| `reloadAfterEdit` | `auto` | Reload the app after an edit: `auto` only when no live reload is detected, or `always` / `never` |
| `replayLimit` | `200` | Transcript entries kept for replay |
| `inventoryWithCapture` | `true` | Ship the element inventory with screenshots |
| `inventoryMaxNodes` | `150` | Cap on inventory size |

Precedence: defaults < `~/.uitalk/settings.json` < `<project>/.uitalk.json` <
env (`UITALK_COMPACT_AT_PERCENT`, `UITALK_CONTEXT_TOKENS`, …).

Because compaction here summarizes and restarts rather than compacting incrementally,
it is lossier than the harness's own. A low threshold compacts more often and throws
away more each time — 20 is what you asked for; raise it if summaries start losing
detail you needed.

**Sessions:** one per bridge process. Opening the panel, reloading the page, or
navigating does not start a new one — the agent keeps its context and the panel
replays the transcript. **New session** (⚙ pane) is the only reset short of
restarting the bridge.

## How screenshots are taken

Real screen pixels, via the Screen Capture API. The browser asks once which surface
to share (pick this tab), then every capture is a crop of the live compositor output —
so canvas, video, cross-origin images and backdrop filters are all captured as they
actually look.

If you decline the prompt, or the browser lacks the API, it falls back to rendering the
DOM to an image and labels those shots **rendered**, since that path cannot reproduce
canvas, video or cross-origin content. Turn the native path off in ⚙ if you prefer it.

## After a change lands

Approving records the computed values the preview was producing, then re-reads them once
the agent has finished. If they drifted — the usual cause being a rule written somewhere
that loses the cascade — the panel says so and the agent is told which properties missed
and pointed at `describe_styles`. That failure is otherwise silent: the page looks
unchanged and the edit was reported as done.

Approving also captures the element **before** the edit and again once the agent finishes,
and shows them side by side in the panel — so "did that work?" is a look rather than a
memory. An **↩ undo** button appears beside the tray: the bridge snapshots the working
tree with `git stash create` before the agent writes, and reverting restores exactly the
files that changed since. Projects without git history get no undo button rather than a
broken one.

## Apps without live reload

Vite, webpack and Next push changes into the browser themselves. A Flask, Django or
FastAPI dev server restarts but leaves the page exactly as it was, so after an approved
edit the page still shows the old markup — and both the after-shot and the verification
would be comparing against a stale page.

The panel detects whether the app hot-reloads and, when it does not, reloads it before
judging the result: the frame in split screen, the whole page otherwise. In that second
case the pending check is handed to the next page load rather than lost. Set
`reloadAfterEdit` to `always` or `never` in ⚙ to override the detection.

## Device sizes

Click **⧉** in the panel's meter row. The shell puts your app in an iframe, which is the only way to test a mobile layout
honestly: `@media` rules answer to a real viewport, so resizing a `<div>` would change
nothing they can observe. Inside the frame the app genuinely believes it is 390px wide.

Presets for iPhone SE/14, Pixel 7, iPad mini/Pro, laptop and desktop, plus **Rotate**,
a custom width×height, and **drag handles** on the frame's right edge, bottom edge and
corner. **Panel: right ▸** cycles which edge the chat sits on.

The browser's own back, forward and reload act on the app in the frame, as they would
on any page.
A device bigger than your screen is scaled down to fit while still reporting its full
viewport to the app.

The simulated screen travels with every message as
`page.screen = { preset, width, height, orientation, zoom }`, and the agent sees it in
each message header — so "why does this wrap" is answerable.

## The panel

Click the floating **◈** (drag it anywhere; the pip shows how many elements are
selected, the dot shows the socket). The panel resizes by dragging its **top edge**
for height, its **left edge** for width, or the **top-left corner** for both — it is
anchored bottom-right, so both edges grow away from that corner.

| Tool | Does |
|---|---|
| **Select** | Arms the picker. Click elements in order; each gets a numbered badge. |
| **Screenshot** | Sends a picture of the selection with your next message. |
| **Clear** | Drops the selection. |
| **Reset** | Throws away every previewed style and restores replaced markup. |
| **↑ / ↓** in the composer | Recalls what you have sent, to resend or edit first. Your part-typed draft is put back when you come forward past the newest, and Esc cancels the recall. On a multi-line message the arrows move the caret as usual — recall only triggers from the edge line. |
| **Ctrl/Cmd-Z** | Steps the selection back — a pick, a deselect, an area drag, or a clear. |
| **Esc** | Unwinds one layer: dismiss alternatives, then clear the selection, then turn the tool off. |
| **← →** | Steps through alternatives — including **Original**, so comparing against the unstyled page is part of the same sequence. In the screenshot viewer they step between queued shots. |
| **Variant buttons** | A wrapping row of numbers under the label — **Original** plus 1…N — for jumping straight to any variant instead of walking the arrows. The active variant's full name is spelled out above it; each number's is in its tooltip. |
| **Approve** | Sends the chosen alternative to the agent to commit to source. |

Refer to selections by number: "align element 2 to the top of element 1", "make 1
and 2 the same width", "give me 3 versions of 2".

You can also send **just a screenshot** and ask for variations, with nothing selected —
the agent scans the region, identifies the element, and targets it by CSS selector.

## Layout

```
.claude-plugin/
  plugin.json     plugin manifest
SKILL.md          the skill Claude Code invokes as /uitalk
bin/
  uitalk     launcher, on PATH while the plugin is enabled
server/
  index.mjs       proxy + socket + whichever session is answering
  tool-defs.mjs   the 12 page tools, defined once, owned by no agent SDK
  page-tools.mjs  those definitions shaped for the Claude Agent SDK
  adapter.mjs     the same tools driven by your own key, plus file tools
  mcp.mjs         the same tools over stdio, for any MCP client
  registry.mjs    which bridges are running, on which ports
  settings.mjs    layered per-app settings, validated and clamped; key lookup
  snapshots.mjs   git-backed snapshot and revert of a committed change
  proxy.mjs       HTML-response injection, CSP strip, websocket passthrough
client/           concatenated and served at /__uitalk/client.js
  api.js          identity, geometry, selection, preview layer
  raster.js       element/region -> PNG via foreignObject, fonts and images embedded
  native.js       real screen pixels via getDisplayMedia, cropped to the selection
  shell.js        split screen: device frame, presets, rotate, dock
  ui.js           launcher, tool palette, tray, chat, option flipper
skill/
  SKILL.md        terminal entry point for an agent
tools/
  dom-check.mjs          selection, geometry, preview, capture logic
  ui-check.mjs           panel gestures and the shell, via synthetic events
  raster-check.mjs       the DOM rasterizer, including what it refuses to inline
  capture-check.mjs      frame strips, click-triggered timelines, region cropping
  agent-check.mjs        the adapter's loop and wires, and the panel with no agent
  mcp-check.mjs          the MCP server end to end, over real stdio JSON-RPC
  probe-context.mjs      meter, settings, compaction, replay (costs tokens)
  probe-tabs.mjs         multi-tab routing: calls follow the active tab
  probe-ws.mjs           HMR passthrough, including a frame packed into the handshake
  server-check.mjs       settings, keys, registry, git snapshots, proxy, tool handlers
  coverage.sh            runs every offline suite under c8, gated at 85% lines
  probe-variations.mjs   screenshot-only request still mounts variants
  install-plugin.mjs     symlink into ~/.claude/skills/
  fake-page.mjs          agent loop, one turn
  fake-page-approve.mjs  alternatives -> approval -> source edit
  make-png.mjs           PNG encoder for the harnesses
```

## Tests

```bash
node tools/dom-check.mjs                  # no server needed
node tools/ui-check.mjs                  # no server needed
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

`dom-check` runs the real client against a synthetic DOM: selection ordering,
handle stamping, greppable identifiers, ancestor layout, deltas, specificity
doubling, `!important` stripping, option mounting, and reset. The fake-page
harnesses speak the real socket protocol, so they exercise the bridge and the tool
surface without a browser.

## Coverage

`npm run coverage` runs every suite that needs no bridge, no agent and no tokens, and
fails under **85% lines**. It currently sits at ~87%: the client around 89%, the bridge
around 83%.

One file stays low on purpose. `index.mjs` (~64%) is mostly the parts a test cannot
reach without spending money or taking a port: binding, the Claude session, the three
dispatch paths. What it does around those — message building, routing, context
accounting, compaction, replay, reverts — is covered. `native.js` and `raster.js` can
be driven up to the point where real pixels are needed and no further: jsdom has no
Screen Capture API and cannot rasterize an SVG, and mocking those would measure the
mock.

The agent-driven probes (`fake-page`, `probe-context`, `probe-tabs`, `probe-variations`)
run the bridge as a subprocess, so they cost tokens and contribute no coverage. They are
run by hand when the agent-facing behaviour changes.

## Status

Verified against a React 19 + Vite app:

- Proxy injects into its HTML; `/src/main.jsx` and other assets pass through; HMR
  upgrades are forwarded.
- Push-driven input — a message reaches the agent with no polling.
- `read_selection` → relational reasoning produced `align-self: flex-start` from the
  ancestor's flex context rather than a margin hack.
- `capture` → image plus inventory reaches the agent as an image block.
- `show_options` → three labelled alternatives, then the turn ends to wait.
- Approval → the agent found the rule in `src/App.css`, merged declarations into the
  existing block, preserved nested `&:hover` selectors, and leaked no handle.
  (That test edit was reverted.)
- jsdom assertions on the client logic, the panel and the shell (click to
  pick, drag to rubber-band, drag to screenshot, tray, preview, discard, Escape,
  device presets, rotate, fit-scaling, docking, and screen metadata reaching the
  message).
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
  kill; an explicit `UITALK_PORT` on a taken port failed with a clear message; the freed
  port was reclaimed by the next start.

**Not yet run in a real browser.** The launcher, badge positioning, drag, and above
all the rasterizer's fidelity are unexercised — jsdom has no layout engine and no
canvas. Expect to debug those on the first real load.

Also unexercised: `try_markup` and `scan_region` end to end.

Open items: one agent session is shared by every tab, and `try_markup` is discarded by
a framework re-render.

## Updating

As a plugin, bump `version` in `.claude-plugin/plugin.json` and users get the new
version; installed from a marketplace, Claude Code installs the dependencies itself
with `npm ci --ignore-scripts` (which is why the lockfile is committed and `.npmrc`
carries `omit=dev` — jsdom and c8 have no business in a user's plugin cache).

Two things about a *running* bridge, because a long-lived process is the part that goes
stale:

- **The client is served from disk**, re-read when it changes. Updating the plugin or
  editing `client/` needs only a page reload, and a page still running an older build
  is told so by its build stamp rather than looking like a live bug.
- **The bridge's own code cannot be swapped under itself.** When `server/` changes on
  disk the panel says so and asks for `uitalk --stop && uitalk`. Silently
  serving old behaviour is how an already-fixed bug gets chased twice.

## Contributing

```bash
npm install --include=dev   # .npmrc omits dev deps, which the suites need
npm test                    # every offline suite
npm run coverage            # the same, measured, failing under 85% lines
```

Three conventions the codebase holds to, because each was learned from a bug:

1. **A comment says why, not what.** The non-obvious constraints — why the upgrade
   `head` is written rather than unshifted, why the roll waits a frame past the click,
   why the dock side is a class rather than an attribute selector — are the ones worth
   writing down, and they are why those bugs have not come back.
2. **A test must fail against the bug it describes.** Several assertions here were
   written, passed, and proved worthless until checked against the broken code. If you
   add a regression test, revert the fix and watch it fail first.
3. **Tell the user what the tool could not do.** A capture that could not embed a font,
   a `locate_source` that fell back to searching HTML, a stylesheet that could not be
   read: each is reported rather than silently degraded. An answer with a hole in it is
   only useful if the hole is visible.

## Licence

MIT — see [LICENSE](LICENSE). No code in this project is derived from any other; see
[NOTICE.md](NOTICE.md) for the dependencies it uses.
