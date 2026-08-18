/**
 * Port probes: a TCP connect check (is anything listening) and an HTTP GET
 * check (is the surface answering). Pure and dependency-light so the runtime
 * state machine can drive them and tests can substitute fakes.
 */

import net from 'node:net'

/** True when the process at `host:port` accepts TCP connections. */
export function probeListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** True when GET / on the surface answers 200 within the bound. */
export async function probeHttpReady(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.status === 200
  } catch {
    return false
  }
}
