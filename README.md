# DeepSeek Harness Web UI — Windows quick launch

English | [中文](README.zh.md)

A double-click launcher for the DeepSeek Harness Web UI on Windows. It starts `dsh --profile web` silently in the background, opens the system default browser on the Web UI, and stops the harness it started once every browser that opened the Web UI is closed.

## Install as a DSH plugin

This repo is also a DSH plugin (`dsh.bundle` in the root `package.json`): install it into any profile and the harness itself gains a Web UI controller. The Windows scripts in `launcher/` remain the desktop double-click product; the plugin is the same functionality running inside dsh.

```sh
dsh plugin --profile web add github:YV3507/dsh-webui-launcher
```

or from a checkout:

```sh
cd dsh-webui-launcher
npm install && npm run build     # or: pnpm install && pnpm run build
dsh plugin --profile web add .
```

What the plugin adds:

- Model tools `webui.status`, `webui.start`, `webui.stop`, `webui.open` — cross-platform Node implementations of the launcher's watchdog (adopt-or-start, readiness wait, PID-guarded process-tree stop, browser open). A server the plugin did not start is adopted, never stopped.
- A `/webui start|stop|status|open` slash command.
- A "Web UI Launcher" card on the Settings page of the web GUI (browser half, `exports["./client"]`), driving the same `/webui/*` JSON endpoints.
- Plugin config: `port` (default 3080), `host` (127.0.0.1), `cliBin` ("" = reuse the running CLI), `startupTimeoutMs` (120000), `openBrowserOnStart` (true).

## Install

Requires Windows 10/11 and Node.js 22 or newer. Run the installer with PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

or double-click `install.cmd`. The installer finds dsh in this order: the `-ShRoot` argument, the `DSH_ROOT` environment variable, a `runtime\` folder from a release zip next to the installer, and a globally npm-installed `@deepseek-ai/dsh`. When none exists it prints what to install first (a deepseek-harness checkout, or `npm install -g @deepseek-ai/dsh` once published).

A source checkout without a built CLI is built automatically (`pnpm install && pnpm run build`) unless you pass `-SkipBuild`.

After installing, a desktop shortcut "DeepSeek Harness Web UI" launches the Web UI; pass `-StartMenu` for a Start Menu entry too.

## Release zips

`dsh-webui-launcher-windows-<ref>.zip` from GitHub Releases is self-contained: unzip anywhere, then run `install.cmd`. The zip's `runtime\` folder holds a prebuilt dsh installation, so no checkout or npm publish is needed. The `release` workflow builds it on Windows from the harness repo and attaches it to releases and tags.

## How it works

The watchdog boots `dsh --profile web` (the built CLI, or the tsx source launcher in a checkout), waits until the port answers HTTP, opens `http://127.0.0.1:<port>` in the default browser, then polls every two seconds. The harness stays alive only while a browser holds an established TCP connection to the Web UI port; when every such connection is gone for the grace period (6 seconds), the watchdog stops the harness process tree it started and exits. A server already listening on the port is adopted, never restarted and never stopped. See `launcher/README.md` for configuration and security notes.

## Layout

- `launcher/` — the watchdog (`dsh-webui.ps1`), the silent entry (`dsh-webui.vbs`), the shortcut installer, the icon builder and icons, and the per-file docs.
- `install.ps1` / `install.cmd` — the one-command installer.
- `.github/workflows/release.yml` — builds the harness on Windows and publishes a self-contained zip.

## Security

The launcher runs with the invoking user's rights only: no elevation, no registry or service changes, no external network, loopback-only bind, and it kills only the process tree it spawned after verifying the PID still belongs to that process. Details in `launcher/README.md`.

## Uninstall

Delete the desktop shortcut and the launcher folder (default `%LOCALAPPDATA%\dsh-webui-launcher`). The dsh installation itself is left untouched.

## License

MIT
