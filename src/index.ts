/**
 * dsh-webui-launcher, host half: a cross-platform controller for the DeepSeek
 * Harness Web UI. It registers model tools `webui.status` / `webui.start` /
 * `webui.stop` / `webui.open`, a `/webui start|stop|status|open` slash
 * command, and the `/webui/*` JSON endpoints the browser half's Settings card
 * fetches. The heavy lifting lives in {@link WebUiRuntime} — the Node port of
 * the repo's Windows watchdog (`launcher/dsh-webui.ps1`). The PowerShell
 * launcher stays the desktop double-click product; this half is the
 * installable plugin core that makes the repo listable in the plugin
 * marketplace (`dsh plugin --profile web add github:YV3507/dsh-webui-launcher`).
 *
 * @module dsh-webui-launcher
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { registerWebUiEndpoints } from './endpoints.ts'
import { WebUiRuntime, type WebUiStatus } from './webui.ts'

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
}

export const Config: Schema<Config> = Schema.object({
  port: Schema.number().step(1).min(1).max(65535).default(3080),
  host: Schema.string().default('127.0.0.1'),
  cliBin: Schema.string().default(''),
  startupTimeoutMs: Schema.number().step(1).min(1000).default(120000),
  openBrowserOnStart: Schema.boolean().default(true),
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
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
      status: {
        type: 'object',
        properties: {
          port: { type: 'number' },
          host: { type: 'string' },
          url: { type: 'string' },
          listening: { type: 'boolean' },
          ready: { type: 'boolean' },
          spawned: { type: 'boolean' },
          adopted: { type: 'boolean' },
          pid: { type: 'number' },
          exitCode: { type: 'number' },
        },
        required: ['port', 'host', 'url', 'listening', 'ready', 'spawned', 'adopted'],
      },
    },
    required: ['ok', 'message', 'status'],
  },
  render: (_args: Record<string, unknown>, value: WebUiToolValue) => [
    { type: 'text' as const, text: value.message },
  ],
}

/** Build the four model tools over one runtime. */
function buildTools(runtime: WebUiRuntime) {
  return [
    defineTool({
      name: 'webui.status',
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
      name: 'webui.start',
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
      name: 'webui.stop',
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
      name: 'webui.open',
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

/** Load the runtime, register tools/commands/routes, and release them with the fiber. */
export function apply(ctx: Context, config: Partial<Config> | undefined): void {
  const options = {
    port: config?.port ?? 3080,
    host: config?.host ?? '127.0.0.1',
    cliBin: config?.cliBin ?? '',
    startupTimeoutMs: config?.startupTimeoutMs ?? 120000,
    openBrowserOnStart: config?.openBrowserOnStart ?? true,
    maxLogLines: 25,
  }
  const runtime = new WebUiRuntime(options)

  const disposeRoutes = registerWebUiEndpoints(ctx.webServer, runtime)
  ctx.effect(() => disposeRoutes, 'dsh-webui-launcher.routes')

  for (const tool of buildTools(runtime)) {
    ctx.tools.register(tool)
  }
  ctx.commands.register(buildCommand(runtime))
}
