/**
 * dsh-webui-launcher, host half: a cross-platform controller for the DeepSeek
 * Harness Web UI. It registers model tools `webui_status` / `webui_start` /
 * `webui_stop` / `webui_open`, a `/webui start|stop|status|open` slash
 * command, and the `/webui/*` JSON endpoints the browser half's Settings card
 * fetches. The heavy lifting lives in {@link WebUiRuntime} — the state-machine
 * core (adopt-or-start, readiness wait, PID-guarded stop, orphan cleanup on
 * unload). Installable into any profile via
 * `dsh plugin --profile web add github:YV3507/dsh-webui-launcher`.
 *
 * @module dsh-webui-launcher
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolveCli } from './cli.ts'
import { registerWebUiEndpoints, type IconUploadResult } from './endpoints.ts'
import { convertImageToIcon } from './icon.ts'
import { managedDirFor, ShortcutManager, defaultShortcutDeps } from './shortcut.ts'
import { defaultDeps, WebUiRuntime, type WebUiStatus } from './webui.ts'

// Exported for the failure-path unit tests, which instantiate the runtime
// with scripted fake dependencies against the built bundle.
export { WebUiRuntime, defaultDeps } from './webui.ts'
export type { WebUiOptions, WebUiRuntimeDeps, WebUiStatus, WebUiResult, RuntimeState } from './webui.ts'
// Exported for the icon/shortcut unit tests.
export { ShortcutManager, defaultShortcutDeps, managedDirFor } from './shortcut.ts'
export type { ShortcutManagerDeps, ShortcutManagerOptions } from './shortcut.ts'
export { convertImageToIcon, packIco } from './icon.ts'
export type { IconSet } from './icon.ts'
// Exported for the launcher-script/spawn tests (desktop .cmd polarity, spawn
// failure fast-path).
export { writeLauncherScript } from './desktop.ts'
export { killPidTree, parseNetstatPid, pidForPort, spawnServer } from './process.ts'
export type { SpawnedServer, SpawnOptions } from './process.ts'
export { detectDesktopDir } from './desktop.ts'
export type { LauncherSpec, ShortcutHandle } from './desktop.ts'

/** The plugin's name, as cordis entries reference it. */
export const name = 'dsh-webui-launcher'

/** This plugin needs the tool registry, the slash-command registry and the
 * web server (for its `/webui/*` JSON routes). */
export const inject = ['tools', 'commands', 'webServer']

export interface Config {
  /** Web UI port (1..65535). Default 3080 (the dsh web default). */
  port: number
  /** Loopback host dsh web binds. dsh web rejects 0.0.0.0. */
  host: string
  /** Explicit dsh CLI script override ("" = reuse the running CLI). */
  cliBin: string
  /** How long `start` waits for the surface to answer HTTP 200. */
  startupTimeoutMs: number
  /** Open the default browser once the Web UI is ready. */
  openBrowserOnStart: boolean
  /** Create a desktop launcher shortcut on the first plugin start. */
  desktopShortcut: boolean
  /** Display name of the desktop shortcut. */
  shortcutName: string
  /** Optional explicit icon image path used when creating the shortcut. */
  shortcutIconPath: string
}

export const Config: Schema<Config> = Schema.object({
  port: Schema.number().step(1).min(1).max(65535).default(3080),
  host: Schema.string().default('127.0.0.1'),
  cliBin: Schema.string().default(''),
  startupTimeoutMs: Schema.number().step(1).min(1000).default(120000),
  openBrowserOnStart: Schema.boolean().default(true),
  desktopShortcut: Schema.boolean().default(true),
  shortcutName: Schema.string().min(1).default('DeepSeek Harness Web UI'),
  shortcutIconPath: Schema.string().default(''),
})

/** The canonical value of every webui tool: status + one human message. */
interface WebUiToolValue {
  ok: boolean
  message: string
  status: WebUiStatus
}

/** Shared output schema for the four webui tools. */
const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      message: { type: 'string', required: true },
      status: {
        type: 'object',
        additionalProperties: true,
        required: true,
        properties: {
          port: { type: 'number', required: true },
          host: { type: 'string', required: true },
          url: { type: 'string', required: true },
          state: { type: 'string', required: true },
          listening: { type: 'boolean', required: true },
          ready: { type: 'boolean', required: true },
          spawned: { type: 'boolean', required: true },
          adopted: { type: 'boolean', required: true },
          stoppable: { type: 'boolean', required: true },
          pid: { type: 'number' },
          exitCode: { type: 'number' },
        },
      },
    },
  },
  render: (_args: Record<string, unknown>, value: WebUiToolValue) => [
    { type: 'text' as const, text: value.message },
  ],
}

/** Build the four model tools over one runtime. */
function buildTools(runtime: WebUiRuntime) {
  return [
    defineTool({
      name: 'webui_status',
      description: 'Report whether the DeepSeek Harness Web UI is listening and ready on host:port.',
      parameters: {},
      output,
      async execute() {
        const status = await runtime.status()
        return {
          ok: status.ready,
          message: status.ready
            ? `Web UI ready at ${status.url}`
            : `nothing serving ${status.url} (listening: ${status.listening})`,
          status,
        }
      },
    }),
    defineTool({
      name: 'webui_start',
      description:
        'Start the DeepSeek Harness Web UI: adopts a server already listening on the port, otherwise spawns `dsh --profile web` in the background and waits until it answers HTTP 200.',
      parameters: {},
      output,
      async execute(_args, exec) {
        const result = await runtime.start(exec.signal)
        return { ok: true, message: result.message, status: result.status }
      },
    }),
    defineTool({
      name: 'webui_stop',
      description:
        'Stop the Web UI server this plugin spawned. A server this plugin did not start (adopted) is never stopped.',
      parameters: {},
      output,
      async execute() {
        const result = await runtime.stop()
        return { ok: true, message: result.message, status: result.status }
      },
    }),
    defineTool({
      name: 'webui_open',
      description: 'Open the default browser on the Web UI URL without starting or stopping anything.',
      parameters: {},
      output,
      async execute() {
        const result = await runtime.open()
        return { ok: true, message: result.message, status: result.status }
      },
    }),
  ]
}

/** The `/webui start|stop|status|open` slash command. */
function buildCommand(runtime: WebUiRuntime): CommandDefinition {
  return {
    name: 'webui',
    description: 'Start, stop, check or open the DeepSeek Harness Web UI.',
    input: { hint: 'start | stop | status | open' },
    handler: async ({ rawInput, signal }) => {
      const verb = (rawInput.trim().split(/\s+/)[0] ?? '').toLowerCase()
      try {
        switch (verb) {
          case 'start': {
            const result = await runtime.start(signal)
            return { kind: 'success' as const, text: result.message }
          }
          case 'stop': {
            const result = await runtime.stop()
            return { kind: 'success' as const, text: result.message }
          }
          case 'status': {
            const status = await runtime.status()
            const state = status.ready
              ? `ready at ${status.url}`
              : status.listening
                ? `listening on ${status.url} but not answering`
                : `not serving ${status.url}`
            const owner = status.spawned ? ` (spawned by this plugin, pid ${status.pid})` : status.adopted ? ' (adopted)' : ''
            return { kind: 'success' as const, text: `Web UI ${state}${owner}` }
          }
          case 'open': {
            const result = await runtime.open()
            return { kind: 'success' as const, text: result.message }
          }
          case '':
            return { kind: 'error' as const, text: 'usage: /webui start | stop | status | open' }
          default:
            return { kind: 'error' as const, text: `unknown /webui verb "${verb}" — usage: /webui start | stop | status | open` }
        }
      } catch (error) {
        return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** Resolve the bundled dsh default icon (the dsh web favicon, rasterized at
 * build time into assets/), or '' when the asset is absent (partial install).
 * Windows shortcuts need an .ico; Linux .desktop entries take a .png. */
function bundledDshIcon(): string {
  try {
    const dir = fileURLToPath(new URL('../assets/', import.meta.url))
    const file = join(dir, process.platform === 'win32' ? 'dsh-icon.ico' : 'dsh-icon.png')
    return existsSync(file) ? file : ''
  } catch {
    return ''
  }
}

/** Load the runtime, register tools/commands/routes, and release them with the fiber. */
export function apply(ctx: Context, config: Partial<Config> | undefined): void {
  // The managed dir is computed first: the runtime records the spawned
  // server's PID here so a later instance (or the desktop launcher) can stop
  // it, and the shortcut/icon features below reuse it.
  const managedDir = managedDirFor()
  const options = {
    port: config?.port ?? 3080,
    host: config?.host ?? '127.0.0.1',
    cliBin: config?.cliBin ?? '',
    startupTimeoutMs: config?.startupTimeoutMs ?? 120000,
    openBrowserOnStart: config?.openBrowserOnStart ?? true,
    maxLogLines: 25,
    adoptedPidFile: join(managedDir, 'server.pid'),
  }
  const runtime = new WebUiRuntime(options, defaultDeps(options))

  // Desktop shortcut: created once on the first start, headless-safe. The
  // launcher spec reuses the same CLI resolution as the runtime's spawn;
  // resolution failure degrades the shortcut feature only (never the boot).
  // Default shortcut icon: the bundled dsh icon, copied into the persistent
  // managed dir so a node_modules reinstall never orphans the .lnk's icon.
  // An explicit `shortcutIconPath` config wins; an unavailable asset degrades
  // to the platform-default icon.
  let defaultIcon = ''
  try {
    const bundled = bundledDshIcon()
    if (bundled !== '') {
      mkdirSync(managedDir, { recursive: true })
      const dest = join(managedDir, process.platform === 'win32' ? 'dsh-icon.ico' : 'dsh-icon.png')
      if (!existsSync(dest)) copyFileSync(bundled, dest)
      defaultIcon = dest
    }
  } catch (error) {
    console.log(`[dsh-webui-launcher] default icon unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  let shortcut: ShortcutManager | null = null
  try {
    const cli = resolveCli(options.cliBin)
    const spec = {
      command: process.execPath,
      cliArgs: [...cli.prefixArgs, cli.entry, '--profile', 'web', '--host', options.host, '--port', String(options.port)],
      cwd: cli.cwd,
      url: `http://${options.host}:${options.port}`,
      description: 'Launch the DeepSeek Harness Web UI',
    }
    shortcut = new ShortcutManager({
      desktopShortcut: config?.desktopShortcut ?? true,
      shortcutName: config?.shortcutName ?? 'DeepSeek Harness Web UI',
      shortcutIconPath: config?.shortcutIconPath ?? defaultIcon,
      managedDir,
      spec,
    }, defaultShortcutDeps())
    // Never blocks or crashes boot: creation failures are logged inside.
    void shortcut.ensure()
  } catch (error) {
    console.log(`[dsh-webui-launcher] desktop shortcut disabled: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Uploaded shortcut icons: convert to the platform format, persist, and
  // apply to the existing shortcut immediately.
  const iconUpload = async (bytes: Buffer, name: string): Promise<IconUploadResult> => {
    try {
      const set = await convertImageToIcon(bytes)
      mkdirSync(managedDir, { recursive: true })
      const icoPath = join(managedDir, 'icon.ico')
      const pngPath = join(managedDir, 'icon.png')
      writeFileSync(icoPath, set.ico)
      writeFileSync(pngPath, set.png)
      const iconFile = process.platform === 'win32' ? icoPath : pngPath
      const applied = shortcut !== null
        ? await shortcut.applyIcon(iconFile)
        : { ok: false, message: 'desktop shortcut unavailable' }
      return {
        ok: applied.ok,
        message: `${applied.message} (converted from "${name || 'image'}" to ${process.platform === 'win32' ? 'ICO' : 'PNG'})`,
        formats: ['ico', 'png'],
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // One effect owns the whole lifecycle: on unload the routes are unregistered
  // AND any server this plugin spawned is stopped (orphan guard for plugin
  // unload/hot-reload).
  ctx.effect(() => {
    const disposeRoutes = registerWebUiEndpoints(ctx.webServer, runtime, iconUpload)
    return () => {
      disposeRoutes()
      void runtime.dispose()
    }
  }, 'dsh-webui-launcher.lifecycle')

  for (const tool of buildTools(runtime)) {
    ctx.tools.register(tool)
  }
  ctx.commands.register(buildCommand(runtime))
}
