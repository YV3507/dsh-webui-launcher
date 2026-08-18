/**
 * Browser half of the dsh-webui-launcher plugin: registers the launch card
 * into the Settings page's `settings.section` hole. The card fetches the
 * plugin's own `/webui/*` JSON endpoints (host half), so it works in any web
 * profile that mounts the bundle — no dependency on the official connection
 * API. Self-contained, mirroring dsh-git-panel's browser half.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { WebUISection } from './WebUISection.tsx'
import type { WebUiSectionInjected } from './WebUISection.tsx'
import { en, NS, zh } from './locales.ts'

export type { WebUiSectionInjected, WebUiSectionProps } from './WebUISection.tsx'
export type { WebUiStatus } from './WebUISection.tsx'
export type { WebUiKey } from './locales.ts'

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the section dictionaries and the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-webui-launcher: dictionaries')

  // Registration-time text (the nav label thunk) and the inject face share one
  // bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as WebUiSectionInjected['t']

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'webui-launcher',
    order: 200,
    label: () => t('nav'),
    inject: (): WebUiSectionInjected => ({ t }),
  }, WebUISection))
}
