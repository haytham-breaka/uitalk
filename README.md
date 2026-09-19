<p align="center">
  <img src="docs/media/mascot.png" alt="uitalk mascot: a browser window with an oversized, listening ear and sunglasses, pointing at one of its own buttons as it changes colour" width="260">
</p>

# uitalk

**Stop describing your UI to an agent that can't see it.** Click the element, say what you want, flip through live alternatives, approve one — and your coding agent commits it to real source. No screenshot pasted into chat, no CSS selector spelled out by hand, no "the second button, no, the *other* second button."

[![test](https://github.com/haytham-breaka/uitalk/actions/workflows/test.yml/badge.svg)](https://github.com/haytham-breaka/uitalk/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥ 20.11](https://img.shields.io/badge/node-%E2%89%A5%2020.11-brightgreen.svg)](package.json)
[![Version 0.6.3](https://img.shields.io/badge/version-0.6.3-informational.svg)](.claude-plugin/plugin.json)

<p align="center">
  <img src="docs/media/story.gif" alt="Talk to your UI, not about it: five acts in one session — centring one button on another by number, fixing a headline that wraps on phones from inside the split-screen frame, a colour change that stays scoped to the selected button, five live style options before anything is written, and a one-click undo" width="100%">
</p>
<p align="center"><sub>A few things you stop explaining once you can point at them. <a href="docs/media/story.mp4">Full-quality video</a>.</sub></p>

Nothing is written into your project to install it, and no credentials live in the page.
By default the agent is the Claude Code session you are already logged into — no second
API bill — but any OpenAI-compatible model, a self-hosted one, an OpenCode session, or
any MCP-capable editor can answer instead.

## Contents

- [Why uitalk](#why-uitalk)
- [Install](#install)
- [Who answers: agent modes](#who-answers-agent-modes)
- [Usage](#usage)
- [Features](#features)
- [Other editors (MCP)](#other-editors-mcp)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Contributing](#contributing)
- [Licence](#licence)

## Why uitalk

- **Works with any stack.** The bridge proxies your dev server and injects the panel on the way through, so Vite, Next, Rails, Django, PHP, Go templates or plain static files all work with zero framework-specific code. It doesn't know or care what's rendering the page.
- **Model-agnostic where it counts.** Selection, screenshots, preview, variants and undo are the browser's and git's work, not a model's. The model only reads your message — and you choose which one, including one running on your own machine with no API key at all.
- **Real pixels, not a DOM guess.** Screenshots come from the Screen Capture API, so canvas, video, cross-origin images and backdrop filters look the way they actually look — not the way a headless renderer thinks they should.
- **Nothing lands until you say so.** Variants are live CSS on the real page, not a diff you have to imagine. Approving commits the one you chose; undo reverts it, because "approved" and "final" are not the same word.
- **An answer with a hole in it says so.** A font that wouldn't embed, a stylesheet that couldn't be read, an edit that didn't take effect: reported, not silently swallowed. The one thing worse than a tool that fails is a tool that fails quietly.

## Install

**Fastest path:** in Claude Code, `/plugin marketplace add haytham-breaka/uitalk` then `/plugin install uitalk@uitalk`; in your app's directory, `claude` then `/uitalk`. That's a panel open on your running app in about a minute. Everything below is for when the default agent, or the default install route, isn't the one you want.

Requires **Node 20.11+** and, for native screen capture, a Chromium browser. The launcher is plain Node, so it runs the same way on Linux, macOS and native Windows (cmd.exe or PowerShell) — no bash, WSL or Git Bash required.

### As a Claude Code plugin (recommended)

The repository is its own marketplace. From inside Claude Code:

```
/plugin marketplace add haytham-breaka/uitalk
/plugin install uitalk@uitalk
```

Or from a terminal, `claude plugin marketplace add haytham-breaka/uitalk` then `claude plugin install uitalk@uitalk`. Claude Code clones the repo into its plugin cache and installs the dependencies itself, so there is nothing else to run; `uitalk` is on the PATH of every session while the plugin is enabled, and `/plugin` updates it.

### From a clone, for hacking on it

```bash
git clone https://github.com/haytham-breaka/uitalk.git ~/src/uitalk
cd ~/src/uitalk && npm install && npm run install-plugin
```

That symlinks the checkout into `~/.claude/skills/`, so an edit to the source shows up in the next session with no reinstall. Don't run both routes at once — each registers `/uitalk`.

### As a standalone command

Not on npm yet, so from the clone:

```bash
cd ~/src/uitalk && npm install && npm link
```

All three routes give you the same `uitalk` binary and the same panel.

## Who answers: agent modes

The page half of uitalk is model-agnostic. What varies is who reads your message. One setting chooses:

| `agent` | Who answers | Costs |
| --- | --- | --- |
| `builtin` *(default)* | the Claude Code session the bridge runs itself | your existing subscription, no API key |
| `adapter` | any model you hold a key for — OpenAI, Anthropic, Gemini, or anything OpenAI-compatible, including a local one | that provider's per-token price, or nothing for a local server |
| `opencode` | an OpenCode session, driven over its own HTTP API | whatever OpenCode is already configured with |
| `off` | nobody here: an MCP client drives the page tools from your editor | whatever your editor already costs |

```bash
uitalk                                     # built-in Claude session
uitalk --no-agent                          # MCP client drives it
uitalk --agent adapter                     # your key, OpenAI by default
uitalk --agent adapter --provider gemini --model gemini-2.5-pro
uitalk --agent adapter --base-url http://127.0.0.1:8080/v1 --model qwen2.5-coder   # local, no key
uitalk --agent opencode                    # an OpenCode session you already have configured
```

Or commit the choice to the project, in `.uitalk.json`:

```json
{ "agent": "adapter", "agentProvider": "anthropic", "agentModel": "claude-opus-5" }
```

What each mode can and cannot do:

| | `builtin` | `adapter` | `opencode` | `off` |
| --- | --- | --- | --- | --- |
| The 12 page tools | ✅ | ✅ | ⚠️ only if `opencode.jsonc` points at uitalk's MCP server — see below | ✅ |
| Edits source after an approval | ✅ Claude Code's own file tools | ✅ `read_file`, `edit_file`, `write_file`, `list_dir`, `search_files`, scoped to the project | ✅ OpenCode's own file tools | ✅ your editor's |
| Chat in the panel | ✅ | ✅ | ✅ | ❌ — type in your editor; the panel says so instead of swallowing it |
| Context meter, compaction, New session | ✅ | ✅ | ✅ | ❌ — the conversation is in your editor |
| Undo a committed change | ✅ | ✅ | ✅ | ✅ — and the MCP client is told, so it will not re-apply it |
| Streams the reply token by token | ✅ | ❌ — a turn arrives whole | ✅ | n/a |

`builtin` needs `@anthropic-ai/claude-agent-sdk` and `opencode` needs `@opencode-ai/sdk` — both **optional** dependencies, so neither is required by the other. `npm install --omit=optional` gives you a uitalk that runs the adapter and MCP modes with neither installed.

### Your own key, or no key at all

The adapter never takes a key as an argument — that would put it in your shell history. It reads, in order: `$UITALK_API_KEY`, then the provider's own variable (`$OPENAI_API_KEY`, `$ANTHROPIC_API_KEY`, `$GEMINI_API_KEY`), then `~/.uitalk/credentials.json`:

```json
{ "openai": "sk-…", "gemini": "…" }
```

That file is written `0600`, and a key is never a setting: it cannot go in `.uitalk.json` (which is meant to be committed) and is never sent to the page.

`agentBaseUrl` points the OpenAI shape at something else — a local llama.cpp, Ollama or vLLM server, OpenRouter, Groq, an internal gateway. **When a base URL is set, no key is required**, so a self-hosted open-weights model works with nothing to configure but the URL and the model name. `agentModel` defaults to a current model per provider; if the provider answers `404`, the error names the setting to change.

### Setting up `opencode` mode

uitalk doesn't bundle or manage OpenCode — it only talks to an existing installation over HTTP, the same way `builtin` talks to your existing Claude Code login.

1. **Install OpenCode and configure a provider**, if you haven't already:

   ```bash
   npm install -g opencode-ai
   opencode auth login   # or however you've already set up a model with it
   ```

2. **Give uitalk its optional dependency** — `@opencode-ai/sdk` ships as an `optionalDependencies` entry, so a plain install picks it up:

   ```bash
   cd ~/src/uitalk && npm install
   ```

3. **Start uitalk pointed at it:**

   ```bash
   uitalk --agent opencode
   ```

   This finds an `opencode serve` already running on its default port (`4096`) and uses it, or starts one itself if nothing answers there. To use one already running elsewhere, set `opencodeServerUrl` in `.uitalk.json`.

4. **Let it see the page.** OpenCode has no way to receive custom tools programmatically — a session only gets tools from its own config — so add uitalk's MCP server to this project's `opencode.jsonc`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "uitalk": {
         "type": "local",
         "command": ["uitalk-mcp"],
         "environment": { "UITALK_PROJECT": "/path/to/this/project" }
       }
     }
   }
   ```

   Without this step, `opencode` mode still chats in the panel and edits files — it just can't select elements, screenshot, or preview, since it never sees those tools. uitalk checks for this at startup and logs a warning if it looks missing, but never writes to `opencode.jsonc` itself — comments in a hand-edited JSONC file would not survive a parse-and-rewrite round-trip.

## Usage

### From Claude Code

```bash
cd ~/code/my-app
claude
> /uitalk
```

You do not need to start your dev server first — the skill reads `package.json` for a `dev` script, starts it detached along with the bridge, and hands you the URL. If it is already running, the skill just finds it.

### From the command line

```bash
uitalk                        # start detached, print the URL, exit
uitalk --dev "npm run dev"    # run the dev server detached too
uitalk --app-port 3000        # your dev server is not on :5173
uitalk --status               # is one running for this project?
uitalk --stop                 # stop this project's bridge
uitalk --list                 # every bridge running
uitalk --fg                   # foreground instead (Ctrl-C to stop)
```

**It detaches by default, and that matters.** A bridge has to outlive the shell that started it. Run as a background job of an agent's shell, it gets reaped when that shell goes away — which kills the live session mid-edit. `uitalk` puts the server in its own session (a new process group on Linux/macOS; a console-detached process on Windows), so a signal aimed at the caller cannot reach it, then waits for it to claim a port and prints the real URL. Logs go to `~/.uitalk/logs/<project>.log` (`%USERPROFILE%\.uitalk\logs\` on Windows). Starting it again while one is already up for the same project just prints that URL, so it is safe to re-run.

### The panel

Open the app at the URL the launcher printed and click the floating **◈** (drag it anywhere; the pip shows how many elements are selected, the dot shows the socket). The panel resizes by dragging its **top edge** for height, its **left edge** for width, or the **top-left corner** for both.

| Tool | Does |
|---|---|
| **Select** | Arms the picker. Click elements in order; each gets a numbered badge. Drag on empty background to select by region. |
| **Screenshot** | Sends a picture of the selection — or a dragged region — with your next message. |
| **Clear** | Drops the selection. |
| **Reset** | Throws away every previewed style and restores replaced markup. |
| **Ctrl/Cmd-Z** | Steps the selection back — a pick, a deselect, an area drag, or a clear. |
| **Esc** | Unwinds one layer: dismiss alternatives, then clear the selection, then turn the tool off. |
| **← →** | Steps through alternatives — including **Original**, so comparing against the unstyled page is part of the same sequence. In the screenshot viewer they step between queued shots. |
| **Variant buttons** | **Original** plus 1…N under the label, for jumping straight to any variant. |
| **Approve** | Sends the chosen alternative to the agent to commit to source. |
| **↑ / ↓** in the composer | Recalls what you have sent, to resend or edit first. Esc cancels the recall. On a multi-line message the arrows move the caret as usual — recall only triggers from the edge line. |

Refer to selections by number: "align element 2 to the top of element 1", "make 1 and 2 the same width", "give me 3 versions of 2". You can also send **just a screenshot** and ask for variations, with nothing selected — the agent scans the region, identifies the element, and targets it by CSS selector.

![Clicking three cards in order, Ctrl+Z stepping one back, dragging a rectangle to select by region, then Esc twice to clear the selection and turn the tool off](docs/media/feature-selecting.gif)

## Features

### Live variants and approval

Ask for options and the agent mounts them as live CSS on the real page — flip through with the arrows or the numbered buttons, compare against **Original**, then approve one. Only then does the agent touch a file. A clear, single-answer request ("make this button a deep purple gradient") skips the preview and edits directly — asking permission to do the obvious thing isn't careful, it's just slow.

![Asking for five style options on a pricing card, flipping through Accent border, Soft tint, Gradient fill, Lifted and Glow ring, then approving Lifted, which lands in the stylesheet](docs/media/feature-variants.gif)

### Undo, backed by git

Before the agent writes, the bridge snapshots the working tree with `git stash create`. An **↩ undo** button appears beside the tray; reverting restores exactly the files that changed since. Projects without git history get no undo button rather than a broken one — better to admit there's nothing to revert to than to pretend there is.

![Approving a headline resize, seeing it committed, then clicking undo and watching the reverted note appear](docs/media/feature-undo.gif)

### Verified edits, with before/after

Approving records the computed values the preview was producing, then re-reads them once the agent has finished. If they drifted — the usual cause being a rule written somewhere that loses the cascade — the panel says so and the agent is told which properties missed and pointed at `describe_styles`. Approving also captures the element **before** the edit and again after, and shows them side by side, so "did that work?" is a look rather than a memory.

### Real-pixel screenshots

Via the Screen Capture API: the browser asks once which surface to share (pick this tab), then every capture is a crop of the live compositor output. The panel warns you before that prompt appears, so it is not mistaken for something to dismiss. If you decline, or the browser lacks the API, it falls back to rendering the DOM to an image and labels those shots **rendered**, since that path cannot reproduce canvas, video or cross-origin content. Turn the native path off in ⚙ (`nativeCapture`) if you prefer it.

![Dragging a rectangle over three feature cards, sending the crop with a question about narrow screens, and getting back a reply grounded in what's actually in the shot](docs/media/feature-screenshot.gif)

### Device sizes and split screen

Click **⧉** in the panel's meter row. The shell puts your app in an iframe, which is the only way to test a mobile layout honestly: `@media` rules answer to a real viewport, so resizing a `<div>` would change nothing they can observe. Inside the frame the app genuinely believes it is 390px wide.

Presets for iPhone SE/14, Pixel 7, iPad mini/Pro, laptop and desktop, plus **Rotate**, a custom width×height, and **drag handles** on the frame's edges. **Panel: right ▸** cycles which edge the chat sits on. A device bigger than your screen is scaled down to fit while still reporting its full viewport to the app. The simulated screen travels with every message as `page.screen = { preset, width, height, orientation, zoom }`, so "why does this wrap" is answerable — the agent isn't guessing about your viewport any more than it's guessing about your CSS.

![Reaching the split screen from the panel's own control, picking an iPhone 14, then switching to an iPad mini in portrait](docs/media/feature-splitscreen.gif)

### Apps without live reload

Vite, webpack and Next push changes into the browser themselves. A Flask, Django or FastAPI dev server restarts but leaves the page as it was. The panel detects whether the app hot-reloads and, when it does not, reloads it before judging the result — the frame in split screen, the whole page otherwise, with the pending check handed to the next page load rather than lost. Set `reloadAfterEdit` to `always` or `never` to override the detection.

### Context meter and compaction

The panel shows a context meter (percent, tokens used, window). When usage crosses the threshold, the bridge compacts between turns: the agent writes a handover note to itself, the session is cleared, and the note is pushed back in — so facts survive but the token cost of the transcript does not. Because this summarizes and restarts rather than compacting incrementally, it is lossier than the harness's own; raise `compactAtPercent` if summaries start losing detail you needed.

**Sessions:** one per bridge process. Opening the panel, reloading the page, or navigating does not start a new one — the agent keeps its context and the panel replays the transcript. **New session** (⚙ pane) is the only reset short of restarting the bridge.

### Several projects at once

One bridge serves one app, so run as many as you have projects — each claims its own port and owns its own agent session, project root and page sockets.

```bash
# terminal 1
UITALK_PROJECT=~/code/my-app     UITALK_APP_PORT=5173 npm start   # -> :8400
# terminal 2
UITALK_PROJECT=~/code/storefront UITALK_APP_PORT=3000 npm start   # -> :8401

uitalk --list
#   :8400 -> 127.0.0.1:5173  pid 8117  /home/you/code/my-app
#   :8401 -> 127.0.0.1:3000  pid 8159  /home/you/code/storefront
```

**Several tabs on one bridge** is fine: each announces itself, and page calls follow whichever you last used. A background tab is never asked — its `requestAnimationFrame` is paused, which used to make captures hang. Instances are recorded in `~/.uitalk/instances.json`, removed on exit, and pruned if a process dies, so `--list` never shows a phantom.

## Other editors (MCP)

A standalone MCP server exposes all of the page tools over stdio, so Cursor, Cline, Windsurf, Zed, Continue, OpenCode — any MCP client — can select elements, capture, preview and offer variants. Start the bridge with `--no-agent` so it is not also running a session you are not using, then point your editor at `uitalk-mcp`.

Cursor, Cline, Windsurf, Continue, and most others read a config shaped like this:

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

OpenCode's `opencode.jsonc` shape differs — the server key is `mcp`, the command is an array, and the environment key is `environment` (see the block in [Setting up `opencode` mode](#setting-up-opencode-mode)).

Start the bridge as usual (`uitalk --dev "npm run dev"`); the MCP server finds it through the registry, or takes `UITALK_PORT` if you would rather be explicit.

**One thing changes shape.** With the built-in session, your choice of variant — or your answer to a plain question — arrives as a *message*. MCP is request/response and a server cannot push one, so there are two extra tools: after `show_options`, the client calls **`await_choice`**; after `ask_choice`, it calls **`await_answer`**. Each blocks until you pick and returns what you chose. Everything else is identical.

What stays behind with the built-in session: the in-panel chat, context compaction, the context meter, transcript replay, and the unprompted "that edit did not take effect" nudge — all of which need an agent the bridge can push messages into. The panel hides those controls rather than leaving them to do nothing. The other direction has the same problem and is solved the same way: when you undo a change or start a new session, the message waits and is prepended to the next tool result the client asks for, so it cannot re-apply an edit you have just reverted.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/architecture-dark.svg">
  <img src="docs/media/architecture.svg" alt="Your dev server → uitalk bridge (proxy, WebSocket, 12 page tools) → your browser with the injected panel; the tools are answered by builtin, adapter, opencode or an MCP editor, which edit the project source with a git snapshot for undo">
</picture>

The bridge sits between your browser and your dev server. It proxies every request, injecting the panel client into HTML responses on the way through — so the app itself needs no change. The panel talks to the bridge over a WebSocket; the bridge exposes the page as **12 tools** (`read_selection`, `capture`, `capture_breakpoints`, `scan_region`, `describe_styles`, `locate_source`, `try_style`, `try_markup`, `show_options`, `ask_choice`, `reset_preview`, `wait_for`), defined once in `server/tool-defs.mjs` and shaped for whichever agent is answering.

**Two agents, not one.** The session you type `/uitalk` into and the session behind the panel are **different agents with separate contexts**. The skill only launches the bridge; the bridge runs its own agent against the same project. That keeps your terminal session free, and it means the panel's context meter and compaction settings apply to the panel's agent alone.

Prefer your own URL? `curl http://127.0.0.1:8400/__uitalk/bookmarklet` prints a bookmarklet that loads the same client. It needs re-clicking after each reload, and a strict app CSP can block it.

### Layout

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
  proxy.mjs       HTML-response injection, CSP strip, websocket passthrough
client/           concatenated and served at /__uitalk/client.js
  api.js          identity, geometry, selection, preview layer
  raster.js       element/region -> PNG via foreignObject, fonts and images embedded
  native.js       real screen pixels via getDisplayMedia, cropped to the selection
  shell.js        split screen: device frame, presets, rotate, dock
  ui.js           launcher, tool palette, tray, chat, option flipper
tools/            test suites and agent-driven probes — see CONTRIBUTING.md
docs/
  architecture.mmd  source of the diagram above; media/ holds its two SVGs and the demo (story.gif, story.mp4)
```

## Configuration

Settings live behind the ⚙ in the meter row and persist to `.uitalk.json` in the project — per app, so each can have its own budget. Precedence: defaults < `~/.uitalk/settings.json` < `<project>/.uitalk.json` < env (`UITALK_COMPACT_AT_PERCENT`, `UITALK_CONTEXT_TOKENS`, …).

| Setting | Default | Means |
|---|---|---|
| `agent` | `builtin` | Who answers: `builtin`, `adapter`, `opencode` or `off` |
| `agentProvider` | `openai` | Adapter provider: `openai`, `anthropic` or `gemini` |
| `agentModel` | *provider default* | Adapter model name |
| `agentBaseUrl` | *unset* | An OpenAI-compatible endpoint that is not OpenAI's own. Set, no key is needed |
| `opencodeServerUrl` | *auto* | An `opencode serve` to use instead of discovering one on `:4096` |
| `nativeCapture` | `true` | Capture real screen pixels via the Screen Capture API (asks once) |
| `reloadAfterEdit` | `auto` | Reload the app after an edit: `auto` only when no live reload is detected, or `always` / `never` |
| `autoCompact` | `true` | Compact automatically at the threshold |
| `compactAtPercent` | `20` | Percent of the window that triggers compaction |
| `contextTokens` | `200000` | Your window size. **Raise to `1000000` on a 1M-context setup** |
| `compactCooldownTurns` | `2` | Turns to wait before compacting again |
| `replayLimit` | `200` | Transcript entries kept for replay |
| `inventoryWithCapture` | `true` | Ship the element inventory with screenshots |
| `inventoryMaxNodes` | `150` | Cap on inventory size |

Changing `agent*` or `opencodeServerUrl` takes effect on the next bridge start. A key is never a setting — see [Your own key](#your-own-key-or-no-key-at-all).

| Env var | Default | Meaning |
|---|---|---|
| `UITALK_PROJECT` | `cwd` | Project root the agent reads and edits |
| `UITALK_APP_PORT` | `5173` | Your dev server's port |
| `UITALK_APP_HOST` | `127.0.0.1` | Your dev server's host |
| `UITALK_PORT` | *first free from 8400* | Pin the bridge's port. Leave unset to run several at once |
| `UITALK_HOME` | `~/.uitalk` | Where the instance registry, logs and credentials live |
| `UITALK_RPC_TIMEOUT` | `5000` | Milliseconds before a page call is abandoned |
| `UITALK_DEBUG` | unset | `1` logs agent events, `2` dumps them |

## Contributing

```bash
npm install --include=dev   # .npmrc omits dev deps, which the suites need
npm test                    # every offline suite
npm run coverage            # the same, measured, failing under 85% lines
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: coding conventions, what each suite covers, how coverage is measured and where it is deliberately low, what has been verified and what has not, and what to know about updating a bridge that is already running.

## Licence

MIT — see [LICENSE](LICENSE). No code in this project is derived from any other; see [NOTICE.md](NOTICE.md) for the dependencies it uses.
