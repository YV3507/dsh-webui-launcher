/**
 * Shortcut orchestration: creates the desktop launcher shortcut exactly once
 * on the first plugin start (marker file), skips silently on headless hosts
 * and when disabled by config, and applies converted icons to the existing
 * shortcut. Dependencies are injectable so tests script every path without
 * touching a real desktop.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  createShortcut as defaultCreateShortcut,
  detectDesktopDir as defaultDetectDesktopDir,
  updateShortcutIcon as defaultUpdateShortcutIcon,
  type LauncherSpec,
  type ShortcutHandle,
} from './desktop.ts'

export interface ShortcutManagerDeps {
  detectDesktopDir(): string | null
  createShortcut(desktopDir: string, managedDir: string, spec: LauncherSpec): Promise<ShortcutHandle | null>
  updateShortcutIcon(handle: ShortcutHandle, iconFile: string): Promise<boolean>
}

export interface ShortcutManagerOptions {
  /** Whether the desktop shortcut feature is enabled at all. */
  desktopShortcut: boolean
  /** Shortcut display name. */
  shortcutName: string
  /** Optional explicit icon image path used at creation time. */
  shortcutIconPath: string
  /** Launcher spec without name/iconPath (filled from the options above). */
  spec: Omit<LauncherSpec, 'name' | 'iconPath'>
  /** Directory holding the marker, the launcher script and icons. */
  managedDir: string
}

/** The production wiring. */
export function defaultShortcutDeps(): ShortcutManagerDeps {
  return {
    detectDesktopDir: defaultDetectDesktopDir,
    createShortcut: defaultCreateShortcut,
    updateShortcutIcon: defaultUpdateShortcutIcon,
  }
}

/** The plugin's managed state directory under DSH_HOME. */
export function managedDirFor(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-webui-launcher')
}

/** First-start marker content. */
interface ShortcutMarker {
  createdAt: number
  path: string
}

export class ShortcutManager {
  private readonly markerPath: string

  constructor(
    private readonly options: ShortcutManagerOptions,
    private readonly deps: ShortcutManagerDeps,
  ) {
    this.markerPath = join(options.managedDir, 'shortcut.json')
  }

  private log(message: string): void {
    console.log(`[dsh-webui-launcher] ${message}`)
  }

  /**
   * Create the desktop shortcut once. Never throws: headless hosts, disabled
   * config and creation failures all degrade to a log line.
   */
  async ensure(): Promise<void> {
    try {
      if (!this.options.desktopShortcut) {
        this.log('desktop shortcut disabled by config; skipping')
        return
      }
      if (existsSync(this.markerPath)) {
        return // already created on a previous start
      }
      const desktopDir = this.deps.detectDesktopDir()
      if (desktopDir === null) {
        this.log('no interactive desktop detected; skipping shortcut creation (headless host)')
        return
      }
      const spec: LauncherSpec = {
        ...this.options.spec,
        name: this.options.shortcutName,
        iconPath: this.options.shortcutIconPath,
      }
      const handle = await this.deps.createShortcut(desktopDir, this.options.managedDir, spec)
      if (handle === null) {
        this.log('desktop shortcut creation failed or was skipped')
        return
      }
      mkdirSync(this.options.managedDir, { recursive: true })
      const marker: ShortcutMarker = { createdAt: Date.now(), path: handle.path }
      writeFileSync(this.markerPath, JSON.stringify(marker), 'utf8')
      this.log(`desktop shortcut created at ${handle.path}`)
    } catch (error) {
      // The shortcut feature must never take the plugin down.
      this.log(`desktop shortcut creation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Apply a converted icon file to the existing shortcut. When no shortcut
   * exists (headless host, disabled, or creation failed) the icon is simply
   * reported as not applied — the caller may still persist it for a future
   * creation.
   */
  async applyIcon(iconFile: string): Promise<{ ok: boolean; message: string }> {
    try {
      if (!existsSync(this.markerPath)) {
        return { ok: false, message: 'no desktop shortcut has been created (headless host, disabled, or creation failed)' }
      }
      const marker = JSON.parse(readFileSync(this.markerPath, 'utf8')) as ShortcutMarker
      const ok = await this.deps.updateShortcutIcon({ path: marker.path }, iconFile)
      return ok
        ? { ok: true, message: `shortcut icon updated: ${iconFile}` }
        : { ok: false, message: 'shortcut icon update is not supported on this platform or failed' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Whether a shortcut was previously created (marker present). */
  hasShortcut(): boolean {
    return existsSync(this.markerPath)
  }
}
