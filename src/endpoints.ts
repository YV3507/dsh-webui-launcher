/**
 * JSON endpoint layer for the dsh-webui-launcher plugin: `/webui/<verb>` routes
 * over one {@link WebUiRuntime}. Every route is POST-only and guarded against
 * cross-site requests (a browser request must carry a local Origin/Referer),
 * mirroring the proven dsh-git-panel pattern. The settings card fetches these.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebUiRuntime, WebUiStatus } from './webui.ts'

/** The webServer registration surface this plugin injects. */
export interface WebServerLike {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }) => () => void
}

/** The verb table: one JSON endpoint per runtime operation. */
type WebUiVerb = 'status' | 'start' | 'stop' | 'open'

/** A completed operation: a human message plus the status snapshot. */
interface OperationResult {
  message: string
  status: WebUiStatus
}

/** Cross-site request guard: a browser request always carries an Origin (and
 * usually a Referer); any present one must be the local web surface. Requests
 * with neither header (curl, plugin-internal) pass. */
function isLocalOrigin(req: IncomingMessage): boolean {
  for (const name of ['origin', 'referer']) {
    const value = req.headers[name]
    if (value === undefined) continue
    try {
      const host = new URL(Array.isArray(value) ? value[0]! : value).hostname
      if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') continue
    } catch {
      /* unparsable header — treat as non-local */
    }
    return false
  }
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Register the `/webui/*` routes over one runtime.
 * @param webServer - the injected webServer service.
 * @param runtime - the web UI runtime instance.
 * @returns the disposer unregistering every route and aborting in-flight starts.
 */
export function registerWebUiEndpoints(webServer: WebServerLike, runtime: WebUiRuntime): () => void {
  // `start` aborts its readiness wait when the requesting client disconnects;
  // each request owns an AbortController stored here and aborted on close.
  const aborters = new Set<AbortController>()

  const handlers: Record<WebUiVerb, (signal: AbortSignal) => Promise<OperationResult>> = {
    status: async () => {
      const status = await runtime.status()
      return { message: status.ready ? `Web UI ready at ${status.url}` : `nothing serving ${status.url}`, status }
    },
    start: async (signal) => runtime.start(signal),
    stop: async () => runtime.stop(),
    open: async () => runtime.open(),
  }

  const disposers = (Object.keys(handlers) as WebUiVerb[]).map((verb) =>
    webServer.register({
      kind: 'exact',
      path: `/webui/${verb}`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isLocalOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden: non-local origin' })
          return
        }
        const controller = new AbortController()
        aborters.add(controller)
        req.once('close', () => {
          aborters.delete(controller)
          controller.abort()
        })
        try {
          const result = await handlers[verb](controller.signal)
          sendJson(res, 200, { ok: true, message: result.message, status: result.status })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 200, { ok: false, error: message })
        } finally {
          aborters.delete(controller)
        }
      },
    }),
  )
  return () => {
    for (const controller of aborters) controller.abort()
    for (const dispose of disposers) dispose()
  }
}
