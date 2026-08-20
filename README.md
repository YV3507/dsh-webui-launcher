# dsh-webui-launcher — cross-platform Web UI launcher for DeepSeek Harness

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

Start, stop, check and open the DeepSeek Harness Web UI from inside the harness — cross-platform (Windows / macOS / Linux), no desktop scripts needed.

## Install

```sh
dsh plugin --profile web add github:YV3507/dsh-webui-launcher
```

or from a checkout:

```sh
cd dsh-webui-launcher
npm install && npm run build
dsh plugin --profile web add .
```

## What it adds

- **Model tools** — `webui_start`, `webui_stop`, `webui_status`, `webui_open`: start the Web UI (spawning `dsh --profile web` in the background), wait until it answers HTTP 200, report or stop it, open the default browser.
- **Slash command** — `/webui start|stop|status|open`.
- **Settings card** — a "Web UI Launcher" card on the Settings page of the web GUI (browser half, `exports["./client"]`), driving the same `/webui/*` JSON endpoints.
- **Desktop shortcut** — on the first plugin start, a launcher shortcut is created on the desktop (`.lnk` on Windows, `.desktop` on Linux, `.command` on macOS) that starts the Web UI and opens the browser once ready. Headless hosts (no Desktop, no DISPLAY) skip creation silently; disable with `desktopShortcut: false`.
- **dsh default icon** — the shortcut uses the official dsh icon by default (the web-app favicon rasterized and bundled in `assets/`; `.ico` on Windows, `.png` on Linux), copied into the persistent state directory so a reinstall never orphans it.
- **Custom shortcut icon** — upload any image (PNG/JPEG/BMP/GIF/TIFF) from the Settings card; it is converted automatically (multi-size `.ico` on Windows, `.png` on Linux) and the existing shortcut's icon is updated immediately. An explicit `shortcutIconPath` overrides the default.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `3080` | Web UI port. |
| `host` | `127.0.0.1` | Loopback host dsh web binds. |
| `cliBin` | `""` | Explicit dsh CLI script; empty reuses the running CLI. |
| `startupTimeoutMs` | `120000` | How long `start` waits for the surface to answer HTTP 200. |
| `openBrowserOnStart` | `true` | Open the default browser once the Web UI is ready. |
| `desktopShortcut` | `true` | Create the desktop launcher shortcut on the first plugin start. |
| `shortcutName` | `"DeepSeek Harness Web UI"` | Display name of the desktop shortcut. |
| `shortcutIconPath` | `""` | Explicit icon image; empty uses the bundled dsh icon. |

## Behavior and robustness

- **Adopt-or-start** — a server already listening on the port is adopted: never restarted, never stopped. `webui_stop` kills the tree this plugin spawned, and also an adopted server whose PID the launcher (or an earlier instance) recorded — only when that PID is the one currently listening, and only for the process hosting this plugin, with the same `node.exe` identity guard before killing. A foreign server without a PID record is never touched.
- **Explicit state machine** — `idle → starting → running → stopping`, single-flight serialized: concurrent `start`/`stop` calls never interleave.
- **Orphan cleanup** — when the plugin unloads or hot-reloads, any server it spawned is stopped (`ctx.effect` dispose).
- **PID identity guard** — before killing, the process is re-checked (alive, still our child, still `node.exe` via tasklist on Windows) so a recycled PID is never touched.
- **Abort/timeout hygiene** — an aborted or timed-out start kills the child it spawned and surfaces the output tail in the error.
- **CLI location fallback** — the running CLI (`process.argv[1]`) → the `@deepseek-ai/dsh` package → explicit `cliBin`; resolution failure throws an actionable error.

## Development

```sh
npm run build    # esbuild → lib/index.js (host) + lib/client.js (browser)
npm test         # node --test, zero-dependency (mocks the two external packages)
```

The state-machine failure paths (child death, timeout, abort, sibling adoption, concurrency, dispose) are unit-tested against the built bundle with scripted fake dependencies — no real processes or timers.

## Security

Loopback-only by default, no elevation, no external network. The plugin kills only the process tree it spawned — or a PID-recorded launcher server it hosts — after verifying the PID still belongs to that process.

## License

MIT
