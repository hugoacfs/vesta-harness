import type { Context } from '@deepseek-ai/cordis'
import vesta from '../styles/vesta.css?inline'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-vesta-theme'

/**
 * Mount the Vesta global sheet (fonts + ambient ground) for exactly the owning
 * plugin lifetime.
 * @param ctx - Owning plugin context.
 */
export function installVestaStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/vesta.css`
    tag.textContent = vesta
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'ui-vesta-theme: vesta.css stylesheet')
}
