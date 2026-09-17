---
name: uitalk
description: Edit a running web app from inside the page. Starts a proxy that injects a floating tool panel into any locally served app, then answers element selections, screenshots, and change requests from the page and commits approved changes to source. Use when the user says "live edit", "edit the page", "start uitalk", "open the panel", or asks to change how something looks in a running app.
---

# uitalk

You drive a panel inside the user's running web app. They pick elements, you read
them, preview changes, and commit the ones they approve.

## Start

```bash
uitalk
```

`uitalk` is on your PATH whenever this plugin is enabled. Run it **as an
ordinary foreground command** — it starts the bridge detached, prints the URL, and
exits in about a second.

**Never run it as a background Bash task.** It does not need to be backgrounded, and
a long-lived server held by an agent-managed shell dies when that shell is reaped,
taking the user's session with it mid-edit. The command already detaches into its own
session; your shell call just reads back the URL.

It defaults the project to the working directory and probes the usual dev-server
ports. If it reports finding nothing, the app is not running: ask the user to start
it, or pass the port once you know it from `package.json`:

```bash
uitalk --app-port 4321
```

Running it again when one is already up for this project prints the existing URL
instead of starting a second, so it is safe to call without checking first. The other
modes, should you need them:

| Command | Does |
|---|---|
| `uitalk --status` | Is one running for this project? |
| `uitalk --list` | Every bridge running, with ports and projects |
| `uitalk --stop` | Stop the one serving this project |
| `uitalk --fg` | Run in the foreground instead (rarely what you want) |
| `uitalk --no-agent` | Start the panel with no session behind it, for an MCP client |
| `uitalk --agent adapter` | Answer the panel with a model the user has a key for |

The default is right for almost every case: the bridge runs its own Claude session on
the user's subscription, and that session — not you — answers the panel. Only pass
`--no-agent` or `--agent adapter` if the user asks for a different model or says they
will drive it from another editor.

**Never pass `UITALK_PORT`.** The bridge claims the first free port from 8400 upward,
which is what lets several run at once. Read the port out of the command's output and
give the user that URL — never assume 8400.

Tell the user both entry points, in one line each, and that the app must stay running
behind the proxy:

- the printed URL — their app with the panel floating over it;
- the same URL plus `/__uitalk/shell` — split screen, with device sizes for testing
  mobile and landscape layouts.

From that point the panel is their interface; their messages arrive as ordinary user
messages.

## Working in the page

The panel's messages reach you as ordinary user messages. The page tools are:

| Tool | Use |
|---|---|
| `read_selection` | Always first. Selections are numbered in pick order. |
| `capture` | See the selection. Call again after a change to check it. |
| `scan_region` | Identify something a capture left ambiguous. |
| `try_style` | Preview CSS. Writes nothing. |
| `try_markup` | Preview replacement markup. A re-render discards it. |
| `show_options` | Offer alternatives, then end your turn. |
| `ask_choice` | Ask a plain question with no visual preview. Ends your turn too. |
| `reset_preview` | Drop every preview. |

### Rules

**Read before you answer.** Every question about position, size, spacing, or
alignment needs `read_selection` first. It returns each element's box, its own
metrics, the nearest common ancestor's layout, and the pixel deltas between
selections.

**Let the ancestor choose the fix.** "Align 2 to the top of 1" resolves differently
per layout: `align-items` or `align-self` under flex, `align-self: start` under
grid, a `top` offset under `position: relative`, a margin change or a restructure
in static flow. Never reach for a margin when the parent is a flex or grid
container — that is the signature of not having looked.

**Edit directly when the request is clear.** "Make this button blue" needs no preview
— read the current styles, make the edit, then capture to confirm it took. Preview
with `try_style` instead when the change is exploratory, more than one reasonable
interpretation exists, or the user is comparing options; the page is the user's
verification channel there, and a capture after the change is yours.

**Alternatives end your turn.** After `show_options` or `ask_choice`, stop. The
user's choice arrives as a new message. Do not poll, and do not guess which one
they will pick.

**On approval, own the placement.** The approval message carries the chosen
declarations, the element's identifiers, and the page path. Find where that element
and its styles actually live, then make the edit the way the surrounding code would
— merge into the existing rule rather than appending a duplicate, keep nested
selectors, match the project's formatting. The preview CSS is the intent, not the
patch. Never carry a `data-uitalk-*` attribute into source; those are preview handles.

**Identify by what source contains.** Generated class names and utility classes
match everything or nothing. Prefer `id`, `data-testid`, `aria-label`, and the text
snippet when grepping for an element's definition.

**Keep replies short.** The user is looking at the page, not at your prose. Say
what changed and which file, and stop.

## Settings

The panel's gear pane writes `.uitalk.json` in the project. `contextTokens`
defaults to 200,000; if the session's context window is larger, say so once so the
user can correct it, because the meter and the compaction threshold both depend on
it.

## Finishing

`uitalk --stop` when the user is done. There is nothing to clean up in their
project, because nothing was put there. A bridge left running is harmless — it simply
keeps serving — so do not stop one the user has not finished with.
