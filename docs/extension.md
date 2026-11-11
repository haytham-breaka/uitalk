# Deployed sites: the browser extension

uitalk normally works on an app running on your machine: the bridge proxies your dev
server and injects the panel into it. A deployed site (staging, production) can't be
proxied like that. It's HTTPS on someone else's host, it sits behind a login, and its
security headers block injected scripts. The uitalk browser extension puts the same
panel on the real site, in your own browser, already signed in, and connects it to the
uitalk session for your local checkout.

You pick elements, take screenshots and preview changes on the live page. The agent
works on your local code. Nothing is ever changed on the site itself.

## Setup

**1. Install the extension once.**

```bash
uitalk --extension
```

This writes the extension to a folder and prints its path: `~/.uitalk/extension`, or
under WSL a folder on the Windows side (`%LOCALAPPDATA%\uitalk\extension`), because
Chrome on Windows doesn't reliably load extensions from `\\wsl.localhost` paths. In
Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
and choose that folder.

You only do this once. Every uitalk session keeps that folder up to date, and the
extension reloads itself when uitalk changes (you then reload the page you're on).
To install somewhere else, pass a folder: `uitalk --extension ~/somewhere`. uitalk
only writes into a folder that is empty or already holds the extension.

**2. Pair a site with your project.** In the project directory:

```bash
uitalk --url https://staging.example.com
```

This starts the project's session if it isn't running (with no local app needed) and
prints a pairing link. Open it in the Chrome that has the extension. The extension
shows which site and which project you're pairing, and Chrome asks for permission to
run on that site. Allow it and the site opens with the panel on it.

A site stays paired: next time, just open it. Run `uitalk --url` again whenever the
session isn't running, or to pair another site (`https://app.example.com` for
production, for example). The extension's toolbar popup lists paired sites and removes
them.

## What works, and what's different

- **Selecting, screenshots, previews, variants, `ask_choice`:** work the same as on a
  local app.
- **Edits go to your local checkout.** The agent knows the page is deployed. It edits
  your code and tells you the change will show on the site after your next deploy. It
  doesn't try to confirm the edit on the live page, which still runs the old build.
- **Finding the source is a lead, not an exact line.** A deployed build doesn't record
  which file and line each element came from. `locate_source` searches your checkout
  for the element's test id, id, class name and text, and says it's a candidate to
  confirm. The deployed build may also differ from what you have checked out.
- **No split screen.** The device-size shell frames the app through the local proxy,
  which a deployed site doesn't go through. Use Chrome's device toolbar instead.
- **Read-only on the site.** The agent's page tools look at the page and preview
  changes in your tab. None of them clicks, types or submits anything, so the agent
  can't act on the site as you. A markup preview (`try_markup`) is inert: scripts,
  embedded frames, inline event handlers and `javascript:` links are stripped before
  it's inserted. Text on a deployed page, such as other people's content, could otherwise
  talk the agent into running script under your session.

## How it works

```
your Chrome                                          your machine
┌──────────────────────────────────────────┐        ┌──────────────────────┐
│ staging.example.com (signed in)          │        │ uitalk bridge         │
│   panel + client  ── runtime Port ──┐    │        │  127.0.0.1:84xx       │
│   (extension's isolated world)      │    │        │  agent session on     │
│                                     ▼    │  ws    │  your checkout        │
│   extension service worker ──────────────┼──────▶ │                       │
│   (holds the bridge's token)             │        └──────────────────────┘
└──────────────────────────────────────────┘
```

- **The site's scripts can't drive the panel.** A production page runs code you don't
  control: analytics, tag managers, chat widgets. If that code could type into the chat
  or click approve, it could steer an agent that reads and edits your checkout. So the
  panel runs in the extension's isolated world, where the site can't see its JavaScript.
  Its shadow root is closed, so the site can't reach its controls. And on the page itself
  it only acts on real input: a click or keypress a script fakes is ignored.
- **The connection goes through the service worker.** The panel talks to the extension's
  service worker over a runtime Port, and the worker holds the WebSocket to the bridge
  and the bridge's token. The token never reaches the page, and the site can't see or
  forge this channel. A `postMessage` bridge in the page would have exposed both.
- **The bridge accepts the extension's origin.** Its socket refuses web-page origins
  other than loopback. It also accepts a `chrome-extension://` origin, which no web page
  can send, and still requires the token, as for every caller.
- **Pairing can't be started by a website.** The pairing page only offers a site that
  `uitalk --url` recorded from your terminal (in `~/.uitalk/sites/`). A page that opens
  the pairing URL for a site of its own choosing gets a refusal. The extension also
  checks that the offer came from a bridge's own pairing page and that the bridge on that
  port serves the offered project. Nothing is paired until you confirm on the
  extension's own page.
- **Bridges move ports; pairings follow.** A bridge takes the first free port from 8400
  at startup. If a paired site can't reach its bridge, the extension looks for the bridge
  serving that project on the other ports and reconnects there. The token is per project
  and survives restarts.

## Troubleshooting

- **The pairing page says "Waiting for the uitalk extension…"** — the extension isn't
  installed in this Chrome profile, or it was installed after the page loaded. Install
  it, then reload the page.
- **The panel says "offline, retrying"** — the session isn't running. Run
  `uitalk --url <site>` in the project.
- **"the uitalk extension was updated or reloaded — reload this page"** — the page still
  runs the previous version's scripts. Reload it.
- **"this copy of the uitalk extension is older than the bridge"** — Chrome loaded a
  folder uitalk doesn't keep current (copied by hand, say). Run `uitalk --extension` and
  load the folder it prints.
