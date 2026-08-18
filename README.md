# dsh-webui-launcher — cross-platform Web UI launcher for DeepSeek Harness

English | [中文](README.zh.md)

A DSH plugin that starts, stops, checks and opens the DeepSeek Harness Web UI from inside the harness — cross-platform (Windows / macOS / Linux), no desktop scripts needed.

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

- Model tools `webui.status`, `webui.start`, `webui.stop`, `webui.open` — start the Web UI (spawning `dsh --profile web` in the background), wait until it answers HTTP 200, report or stop it, open the default browser.
- A `/webui start|stop|status|open` slash command.
- A "Web UI Launcher" card on the Settings page of the web GUI (browser half, `exports["./client"]`), driving the same `/webui/*` JSON endpoints.
- Plugin config: `port` (default 3080), `host` (127.0.0.1), `cliBin` ("" = reuse the running CLI), `startupTimeoutMs` (120000), `openBrowserOnStart` (true).

## Behavior and robustness

- **Adopt-or-start**: a server already listening on the port is adopted — never restarted, never stopped. `webui.stop` only ever kills the process tree this plugin spawned.
- **Explicit state machine**: `idle → starting → running → stopping`, with single-flight serialization — concurrent `start`/`stop` calls never interleave.
- **Orphan cleanup**: when the plugin unloads or hot-reloads, any server it spawned is stopped (`ctx.effect` dispose).
- **PID identity guard**: before killing, the process is re-checked (alive, still our child, and on Windows still `node.exe` via tasklist) so a recycled PID is never touched.
- **Abort/timeout hygiene**: an aborted or timed-out start kills the child it spawned and surfaces the output tail in the error.
- **CLI location fallback chain**: the running CLI (`process.argv[1]`) → the `@deepseek-ai/dsh` package → explicit `cliBin` config; resolution failure throws an actionable error.

## Development

```sh
npm run build    # esbuild → lib/index.js (host) + lib/client.js (browser)
npm test         # node --test, zero-dependency (mocks the two external packages)
```

The state-machine failure paths (child death, timeout, abort, sibling adoption, concurrency, dispose) are unit-tested against the built bundle with scripted fake dependencies — no real processes or timers.

## Security

Loopback-only by default, no elevation, no external network. The plugin kills only the process tree it spawned, after verifying the PID still belongs to that process.

## License

MIT
