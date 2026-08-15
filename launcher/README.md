# DeepSeek Harness Web UI — Windows quick launch

English | [中文](README.zh.md)

A double-click launcher for the DeepSeek Harness Web UI on Windows. It starts `dsh --profile web` silently in the background, opens the system default browser on the Web UI, and stops the harness it started once every browser that opened the Web UI is closed. The [Agent Note](../../.agents/notes/implemented/process/2026-08-15-windows-quick-launch.md) records the design.

## What is here

- `dsh-webui.vbs` — the double-click entry point; runs the watchdog hidden and shows a message box only on failure.
- `dsh-webui.ps1` — the watchdog: starts the server, opens the browser, watches TCP connections from browsers to the Web UI port, and stops the harness.
- `install-shortcut.ps1` — installs a desktop (and optional Start Menu) shortcut named "DeepSeek Harness Web UI" that points at `dsh-webui.vbs`.
- `dsh-webui.ico` / `dsh-webui-dark.ico` — the shortcut icons, rendered from the Web UI favicon (`apps/web/public/favicon.svg`): black mark for light desktops, white mark for dark ones.
- `build-icon.ps1` — regenerates the .ico files from the SVG (needs Microsoft Edge; `-ColorScheme dark` for the white mark).

## Install

Double-click `dsh-webui.vbs`, or install the application-style shortcut with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-shortcut.ps1 -StartMenu
```

The shortcut icon is the dsh mark (`dsh-webui.ico`); pass `-IconPath scripts\windows\dsh-webui-dark.ico` for the white mark on a dark desktop, or regenerate both with `build-icon.ps1`. Run the shortcut (or the .vbs) again any time; it also works while another instance already serves the Web UI.

## Distribution

For installs outside a deepseek-harness checkout the watchdog resolves the dsh root from `-ShRoot` or the `dsh-webui.json` sidecar (`{ "shRoot": "<path>" }`) written next to the script, and accepts either a checkout root or an npm-style `@deepseek-ai/dsh` package directory. The standalone, MIT-licensed distribution of this launcher (one-command installer, GitHub Actions release zips) lives in its own repository; see the top-level README there.

## How it works

The watchdog boots the same command as `pnpm dsh --profile web` (`node apps/cli/lib/bin.js`, or the tsx source launcher when the built bin is absent), waits until the port answers HTTP, opens `http://127.0.0.1:<port>` in the default browser, then polls every two seconds.

The harness stays alive only while a browser holds an established TCP connection to the Web UI port; the page keeps its `/api/events.mux` WebSocket open while a tab is open. When every such connection is gone for the grace period (6 seconds default), the watchdog stops the harness process tree with `taskkill /T /F` and exits.

A server already listening on the port is adopted, never restarted and never stopped: the watchdog shuts down only the harness it started itself, so it cannot kill a server launched another way. Two near-simultaneous launches share one server: the loser's harness exits on the occupied port and its watchdog adopts the winner instead of failing. An adopted server going away is a normal end of watching, reported quietly.

## Configuration

The defaults live as parameters at the top of `dsh-webui.ps1`: `-Port` (3080), `-HostAddress` (127.0.0.1), `-ShRoot` (the dsh root; auto-derived from the script location or the `dsh-webui.json` sidecar), `-Launch` (`auto` prefers the built CLI bin, else source via tsx), `-StartupTimeoutSeconds` (120), `-BrowserObservationSeconds` (30), `-ShutdownGraceSeconds` (6), `-LogDir` (the `logs` folder beside the script), `-DshHome` (inherits the ambient `DSH_HOME`). Pass them through a shortcut or a console for one-off runs; to make a permanent change, edit the defaults in the file. An invalid `-Port` (outside 1..65535) or `-HostAddress` (anything but a hostname or IP literal, or `0.0.0.0`) fails fast before anything starts. `-SelfTest` prints diagnostics and exits; `-NoBrowser` watches without opening a browser; `-AdoptOnly` watches an existing server without ever starting or stopping one.

## Security

The launcher runs only with the invoking user's rights: no elevation or UAC, no registry, services, scheduled tasks, or global environment changes, and no credentials are read or stored. It writes only to the gitignored `scripts/windows/logs` folder, the harness's `DSH_HOME`, and (for the installer) the user's Desktop. The harness binds loopback (`127.0.0.1`) only — `0.0.0.0` is rejected both here and by `dsh web` itself — and nothing in the launcher opens an external network connection.

The only destructive primitive is the shutdown kill, and it is constrained: the watchdog terminates solely the process tree it spawned, after verifying the PID still belongs to that process (name and start time); a reused PID is left untouched, and adopted servers are never killed. `netstat` and `taskkill` are invoked from `%SystemRoot%\System32` by absolute path so a hostile PATH entry cannot substitute them; `node` is resolved from PATH like any launcher and the resolved path is written to the log.

## Logs and failure reporting

Watchdog and server logs accumulate under `scripts/windows/logs` (gitignored). Exit code 1 (and the `.vbs` message box) is reserved for startup failure or a self-started harness crash; a normal lifecycle — browser closed and a self-started harness stopped, or an adopted server left running or gone — exits 0 silently.

## Known limitations

Shutdown is force-kill (`taskkill /T /F`), so the harness gets no graceful teardown; the session log is append-only and survives. Closing the last Web UI tab also stops the harness, since the tab is what holds the browser connection. Browsers that never connect to the port (no page ever loaded) do not keep the harness alive.
