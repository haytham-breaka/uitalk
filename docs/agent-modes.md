# Agent modes

The page half of uitalk is model-agnostic: selection, screenshots, preview, variants and undo are the browser's and git's work. What varies is who reads your message. One setting chooses:

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

## What each mode can and cannot do

| | `builtin` | `adapter` | `opencode` | `off` |
| --- | --- | --- | --- | --- |
| The 12 page tools | ✅ | ✅ | ✅ uitalk wires its MCP server into `opencode.jsonc` on startup — see below | ✅ |
| Edits source after an approval | ✅ Claude Code's own file tools | ✅ `read_file`, `edit_file`, `write_file`, `list_dir`, `search_files`, scoped to the project | ✅ OpenCode's own file tools | ✅ your editor's |
| Chat in the panel | ✅ | ✅ | ✅ | ❌ — type in your editor; the panel says so instead of swallowing it |
| Context meter, compaction, New session | ✅ | ✅ | ✅ | ❌ — the conversation is in your editor |
| Undo a committed change | ✅ | ✅ | ✅ | ✅ — and the MCP client is told, so it will not re-apply it |
| Streams the reply token by token | ✅ | ❌ — a turn arrives whole | ✅ | n/a |

`builtin` needs `@anthropic-ai/claude-agent-sdk` and `opencode` needs `@opencode-ai/sdk` — both **optional** dependencies, so neither is required by the other. `npm install --omit=optional` gives you a uitalk that runs the adapter and MCP modes with neither installed.

## Your own key, or no key at all

The adapter never takes a key as an argument — that would put it in your shell history. It reads, in order: `$UITALK_API_KEY`, then the provider's own variable (`$OPENAI_API_KEY`, `$ANTHROPIC_API_KEY`, `$GEMINI_API_KEY`), then `~/.uitalk/credentials.json`:

```json
{ "openai": "sk-…", "gemini": "…" }
```

That file is written `0600`, and a key is never a setting: it cannot go in `.uitalk.json` (which is meant to be committed) and is never sent to the page.

`agentBaseUrl` points the OpenAI shape at something else — a local llama.cpp, Ollama or vLLM server, OpenRouter, Groq, an internal gateway. **When a base URL is set, no key is required**, so a self-hosted open-weights model works with nothing to configure but the URL and the model name. `agentModel` defaults to a current model per provider; if the provider answers `404`, the error names the setting to change.

## Setting up `opencode` mode

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

4. **Let it see the page.** OpenCode has no way to receive custom tools programmatically — a session only gets tools from its own config — so it needs uitalk's MCP server named in this project's `opencode.jsonc` / `opencode.json`:

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

   **uitalk wires this up for you** on startup in `opencode` mode: it creates `opencode.json` when the project has none, or splices the `uitalk` entry into an existing config. An existing file is *edited, not rewritten* — the entry is inserted at a single spot and every other byte, comments included, is left exactly as it was, and the result is re-parsed before it's saved. If it can't do that safely (a config it can't parse, or an `mcp` key that isn't an object) it leaves the file untouched and logs how to add the block by hand. Without this entry, `opencode` mode still chats in the panel and edits files — it just can't select elements, screenshot, or preview, since it never sees those tools.

## `off`: any MCP editor

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

**One thing changes shape.** With the built-in session, your choice of variant — or your answer to a plain question — arrives as a *message*. MCP is request/response and a server cannot push one, so there are two extra tools: after `show_options`, the client calls **`await_choice`**; after `ask_choice`, it calls **`await_answer`**. Each blocks until you pick and returns what you chose. There is a third: after the client commits an approved change to source — in its own editor, which the bridge never sees — it calls **`note_edit`**, so the bridge can record the post-edit state and let you undo the change. A built-in/adapter/OpenCode session gets that for free at the end of its turn; MCP has no turn, so it says so explicitly. Everything else is identical.

What stays behind with the built-in session: the in-panel chat, context compaction, the context meter, transcript replay, and the unprompted "that edit did not take effect" nudge — all of which need an agent the bridge can push messages into. The panel hides those controls rather than leaving them to do nothing. The other direction has the same problem and is solved the same way: when you undo a change or start a new session, the message waits and is prepended to the next tool result the client asks for, so it cannot re-apply an edit you have just reverted.

---

Settings that affect these modes (`agent`, `agentProvider`, `agentModel`, `agentBaseUrl`, `opencodeServerUrl`) are listed with the rest in [configuration.md](configuration.md).
