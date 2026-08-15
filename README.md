# DeepSeek Harness Web UI — Windows quick launch

A double-click launcher for the DeepSeek Harness Web UI on Windows. It starts `dsh --profile web` silently in the background, opens the system default browser on the Web UI, and stops the harness it started once every browser that opened the Web UI is closed.

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
