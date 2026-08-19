/**
 * JSON endpoint layer for the dsh-webui-launcher plugin: `/webui/<verb>` routes
 * over one {@link WebUiRuntime}, plus the `/webui/icon` upload for the desktop
 * shortcut. Every route is POST-only and guarded against cross-site requests
 * (a browser request must carry a local Origin/Referer), mirroring the proven
 * dsh-git-panel pattern. The settings card fetches these.
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

/** Result of processing an uploaded icon image. */
export interface IconUploadResult {
  ok: boolean
  message: string
  formats?: string[]
}

/** The verb table: one JSON endpoint per runtime operation. */
type WebUiVerb = 'status' | 'start' | 'stop' | 'open' | 'icon'

/** A completed operation: a human message plus the status snapshot. */
interface OperationResult {
  message: string
  status: WebUiStatus
}

/** Upper bound on an uploaded icon (decoded bytes). */
const MAX_ICON_BYTES = 8 * 1024 * 1024

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

/** Read the request body as a string, bounded to prevent abuse. Settles even
 * when the client disconnects mid-body (no 'end' event): an aborted or errored
 * request resolves to an empty body so the route never hangs. */
function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    let settled = false
    const done = (value: string): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      bytes += chunk.length
      if (bytes > cap) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(overflow ? '' : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(''))
    req.on('aborted', () => done(''))
    req.on('close', () => {
      if (!req.complete) done('')
    })
  })
}

/**
 * Register the `/webui/*` routes over one runtime.
 * @param webServer - the injected webServer service.
 * @param runtime - the web UI runtime instance.
 * @param iconUpload - handles an uploaded icon image (decode → convert → apply).
 * @returns the disposer unregistering every route and aborting in-flight starts.
 */
export function registerWebUiEndpoints(
  webServer: WebServerLike,
  runtime: WebUiRuntime,
  iconUpload: (bytes: Buffer, name: string) => Promise<IconUploadResult>,
): () => void {
  // `start` aborts its readiness wait when the requesting client disconnects;
  // each request owns an AbortController stored here and aborted on close.
  const aborters = new Set<AbortController>()

  const handlers: Record<WebUiVerb, (signal: AbortSignal, body: string) => Promise<OperationResult | IconUploadResult>> = {
    status: async () => {
      const status = await runtime.status()
      return { message: status.ready ? `Web UI ready at ${status.url}` : `nothing serving ${status.url}`, status }
    },
    start: async (signal) => runtime.start(signal),
    stop: async () => runtime.stop(),
    open: async () => runtime.open(),
    icon: async (_signal, body) => {
      let parsed: { data?: unknown; name?: unknown }
      try {
        parsed = JSON.parse(body || '{}') as { data?: unknown; name?: unknown }
      } catch {
        return { ok: false, message: 'invalid JSON body' }
      }
      if (typeof parsed.data !== 'string' || parsed.data === '') {
        return { ok: false, message: 'missing base64 image data' }
      }
      const bytes = Buffer.from(parsed.data, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
        return { ok: false, message: `image size must be between 1 and ${Math.round(MAX_ICON_BYTES / 1024 / 1024)} MiB` }
      }
      return iconUpload(bytes, typeof parsed.name === 'string' ? parsed.name : 'icon')
    },
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
          // Only the icon upload carries a body; status/start/stop/open do not.
          const body = verb === 'icon' ? await readBody(req, MAX_ICON_BYTES * 2) : ''
          const result = await handlers[verb](controller.signal, body)
          sendJson(res, 200, { ok: true, ...result })
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
