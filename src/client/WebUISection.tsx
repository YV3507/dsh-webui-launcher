/**
 * The dsh-webui-launcher settings section: a one-click launch card for the
 * DeepSeek Harness Web UI. It polls the plugin's own `/webui/status` endpoint
 * every few seconds and drives `/webui/start`, `/webui/stop` and `/webui/open`
 * from its buttons. Self-contained — no dependency on the official connection
 * API; the wire is the plugin's JSON endpoints, like dsh-git-panel.
 */

import { useEffect, useRef, useState } from 'react'
import type { WebUiKey } from './locales.ts'

/** Wire status shape echoed by the `/webui/status` endpoint. */
export interface WebUiStatus {
  port: number
  host: string
  url: string
  listening: boolean
  ready: boolean
  spawned: boolean
  adopted: boolean
  /** stop() can close the current server (spawned, or launcher-recorded). */
  stoppable: boolean
  pid: number | null
  exitCode: number | null
  logs: string[]
}

/** Wire response envelope of the `/webui/*` endpoints. */
interface WireResponse {
  ok: boolean
  message?: string
  error?: string
  status?: WebUiStatus
}

/** POST one verb and parse the wire envelope. */
async function call(verb: string, body = '{}'): Promise<WireResponse> {
  try {
    const response = await fetch(`/webui/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return (await response.json()) as WireResponse
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Injected dependencies of {@link WebUISection} (slot `inject`). */
export interface WebUiSectionInjected {
  /** Section copy. */
  t: (key: WebUiKey) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type WebUiSectionProps = Partial<WebUiSectionInjected>

const styles = {
  row: { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' },
  dot: (color: string) => ({
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
    flex: 'none',
  }),
  button: {
    padding: '4px 14px',
    border: '1px solid rgba(127,127,127,.4)',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 13,
  },
  muted: { color: 'rgba(127,127,127,.85)', fontSize: 12, margin: '4px 0' },
  message: { fontSize: 12, margin: '6px 0 0' },
} as const

/** The launch card. */
export function WebUISection({ t }: WebUiSectionProps) {
  const translate = (key: WebUiKey): string => (t ? t(key) : key)
  const [status, setStatus] = useState<WebUiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [iconData, setIconData] = useState('')
  const [iconPreview, setIconPreview] = useState('')
  const [iconName, setIconName] = useState('')
  const [iconBusy, setIconBusy] = useState(false)
  const [iconResult, setIconResult] = useState<{ ok: boolean; text: string } | null>(null)
  const alive = useRef(true)

  // Poll status while the section is mounted.
  useEffect(() => {
    alive.current = true
    const tick = async (): Promise<void> => {
      const result = await call('status')
      if (!alive.current) return
      if (result.ok && result.status) setStatus(result.status)
    }
    void tick()
    const id = setInterval(() => void tick(), 3000)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [])

  const run = async (verb: 'start' | 'stop' | 'open'): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    const result = await call(verb)
    if (!alive.current) return
    setBusy(false)
    if (result.ok) {
      if (result.status) setStatus(result.status)
      setMessage(result.message ?? '')
    } else {
      setError(result.error ?? translate('unknown'))
    }
    // Refresh status once more after the action settles.
    const fresh = await call('status')
    if (alive.current && fresh.ok && fresh.status) setStatus(fresh.status)
  }

  const onIconFile = (file: File | undefined): void => {
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const comma = dataUrl.indexOf(',')
      setIconData(comma >= 0 ? dataUrl.slice(comma + 1) : '')
      setIconPreview(dataUrl)
      setIconName(file.name)
      setIconResult(null)
    }
    reader.readAsDataURL(file)
  }

  const applyIcon = async (): Promise<void> => {
    if (iconData === '') return
    setIconBusy(true)
    setIconResult(null)
    const result = await call('icon', JSON.stringify({ data: iconData, name: iconName }))
    if (!alive.current) return
    setIconBusy(false)
    setIconResult({ ok: result.ok, text: result.message ?? result.error ?? translate('unknown') })
  }

  const stateLabel = status
    ? status.ready
      ? translate('ready')
      : status.listening
        ? translate('listening')
        : translate('notServing')
    : translate('unknown')
  const dotColor = status?.ready ? '#3fb950' : status?.listening ? '#d29922' : '#8b949e'
  const startDisabled = busy || (status?.listening ?? false)
  // Stop is enabled whenever the host can actually close the server: our own
  // spawned child, or a launcher-recorded adopted server (status.stoppable).
  const stopDisabled = busy || !(status?.stoppable ?? false)
  const openDisabled = busy || !(status?.listening ?? false)

  return (
    <div>
      <p style={styles.muted}>{translate('intro')}</p>
      <div style={styles.row}>
        <span style={styles.dot(dotColor)} />
        <strong>{stateLabel}</strong>
        {status?.url ? <span style={styles.muted}>{status.url}</span> : null}
      </div>
      {status?.spawned ? <p style={styles.muted}>{translate('spawned')} (pid {status.pid})</p> : null}
      {status?.adopted
        ? <p style={styles.muted}>{status.stoppable ? translate('adoptedLauncher') : translate('adopted')}</p>
        : null}
      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <button type="button" style={styles.button} disabled={startDisabled} onClick={() => void run('start')}>
          {busy ? translate('busy') : translate('start')}
        </button>
        <button type="button" style={styles.button} disabled={stopDisabled} onClick={() => void run('stop')}>
          {translate('stop')}
        </button>
        <button type="button" style={styles.button} disabled={openDisabled} onClick={() => void run('open')}>
          {translate('open')}
        </button>
      </div>
      {error !== '' ? (
        <p style={{ ...styles.message, color: '#f85149' }}>
          {translate('error')}: {error}
        </p>
      ) : null}
      {message !== '' ? <p style={styles.message}>{message}</p> : null}
      <hr style={{ border: 'none', borderTop: '1px solid rgba(127,127,127,.25)', margin: '14px 0' }} />
      <strong>{translate('iconTitle')}</strong>
      <p style={styles.muted}>{translate('iconHint')}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
        <label
          style={{
            ...styles.button,
            display: 'inline-block',
            cursor: 'pointer',
            padding: '4px 10px',
          }}
        >
          {translate('chooseIcon')}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(event) => onIconFile(event.target.files?.[0])}
          />
        </label>
        {iconPreview !== '' ? (
          <img src={iconPreview} alt={iconName} style={{ width: 40, height: 40, objectFit: 'contain', border: '1px solid rgba(127,127,127,.4)', borderRadius: 6 }} />
        ) : null}
        <button type="button" style={styles.button} disabled={iconBusy || iconData === ''} onClick={() => void applyIcon()}>
          {iconBusy ? translate('busy') : translate('applyIcon')}
        </button>
      </div>
      {iconResult !== null ? (
        <p style={iconResult.ok ? styles.message : { ...styles.message, color: '#f85149' }}>
          {iconResult.ok ? translate('iconApplied') : translate('iconFailed')}: {iconResult.text}
        </p>
      ) : null}
    </div>
  )
}
