/**
 * Browser opening across platforms: `start` on Windows, `open` on macOS,
 * `xdg-open` on Linux. Never waits for the browser to exit.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

/** Open the system default browser on `url`; resolves true when spawned. */
export function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform
  let command: string
  let args: string[]
  if (platform === 'win32') {
    command = 'cmd.exe'
    args = ['/c', 'start', '', url]
  } else if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else {
    command = 'xdg-open'
    args = [url]
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
