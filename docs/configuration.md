# Configuration

Settings live behind the ⚙ in the panel's meter row and persist to `.uitalk.json` in the project — per app, so each can have its own budget. Precedence, lowest to highest: defaults < `~/.uitalk/settings.json` < `<project>/.uitalk.json` < environment (`UITALK_COMPACT_AT_PERCENT`, `UITALK_CONTEXT_TOKENS`, …).

## Settings

| Setting | Default | Means |
|---|---|---|
| `agent` | `builtin` | Who answers: `builtin`, `adapter`, `opencode` or `off` — see [agent-modes.md](agent-modes.md) |
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

Changing `agent*` or `opencodeServerUrl` takes effect on the next bridge start. A key is never a setting — it cannot go in `.uitalk.json`, which is meant to be committed; see [Your own key, or no key at all](agent-modes.md#your-own-key-or-no-key-at-all) for where keys are read from.

## Environment variables

| Env var | Default | Meaning |
|---|---|---|
| `UITALK_PROJECT` | `cwd` | Project root the agent reads and edits |
| `UITALK_APP_PORT` | `5173` | Your dev server's port |
| `UITALK_APP_HOST` | `127.0.0.1` | Your dev server's host — not the bridge's; the bridge itself always binds to `127.0.0.1` |
| `UITALK_PORT` | *first free from 8400* | Pin the bridge's port. Leave unset to run several at once |
| `UITALK_HOME` | `~/.uitalk` | Where the instance registry, logs and credentials live |
| `UITALK_RPC_TIMEOUT` | `5000` | Milliseconds before a page call is abandoned |
| `UITALK_DEBUG` | unset | `1` logs agent events, `2` dumps them |
