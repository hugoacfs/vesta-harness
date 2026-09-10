import type { Context } from '@deepseek-ai/cordis'
import vesta from '../styles/vesta.css?inline'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-vesta-theme'

/**
 * Anchor the sheet's root-absolute font URLs at the page's base path so a
 * reverse-proxy sub-path (the served <base href>, e.g. `/harness/`) is honoured.
 * The source keeps `url('/vesta/fonts/…')` because bundlers pass root-absolute
 * URLs through untouched; at the site root the base path is `/` and the text is
 * returned unchanged.
 * @param sheet - The inlined vesta.css text.
 * @returns the sheet with its font URLs resolved under the document base path.
 */
function anchorFontUrls(sheet: string): string {
  const pathname = new URL(document.baseURI).pathname
  const basePath = pathname.endsWith('/') ? pathname : `${pathname}/`
  if (basePath === '/') return sheet
  // The bundler minifies the inlined sheet and drops the url() quotes, so match
  // an optional quote and carry it through unchanged.
  return sheet.replace(/url\((['"]?)\/vesta\/fonts\//g, (_match: string, quote: string) => `url(${quote}${basePath}vesta/fonts/`)
}

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
    tag.textContent = anchorFontUrls(vesta)
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'ui-vesta-theme: vesta.css stylesheet')
}
