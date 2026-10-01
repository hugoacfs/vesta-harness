/**
 * The login page of `vesta-login`: one small dark page, no scripts, two forms.
 * It is served from the fork's own route, so it carries its own `<base>` and
 * styles and needs nothing from the app bundle.
 */

/** What the page shows. */
export type PageState =
  /** Nothing pending: offer to send a code. */
  | 'ask'
  /** A code is on its way: offer the field. */
  | 'sent'

/** Inputs of {@link renderPage}. */
export interface PageInput {
  /** The app's mount path, with trailing slash (`/harness/`). */
  readonly mount: string
  /** Which harness this is, shown in the title and the message (`vesta`, `vesta staging`). */
  readonly label: string
  readonly state: PageState
  /** A line to show above the form, if any. */
  readonly notice?: string
  /** The identity the page sees, if any, so a refused one can be read off. */
  readonly identity?: string
  /** Whether that identity may sign in here. */
  readonly allowed: boolean
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

const STYLE = `
  :root { color-scheme: dark; }
  html, body { margin: 0; min-height: 100%; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d0b0a; color: #eee5de;
    display: flex; align-items: center; justify-content: center;
    padding: calc(24px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px));
    box-sizing: border-box;
  }
  main { width: 100%; max-width: 360px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  h1 span { color: #f28b4b; }
  p { margin: 0 0 16px; color: #b8aca3; }
  .notice { color: #f3c99b; }
  .refused { color: #e07a7a; }
  form { display: grid; gap: 12px; margin-top: 20px; }
  input {
    font: inherit; font-size: 28px; letter-spacing: 0.3em; text-align: center;
    padding: 12px; border-radius: 12px; border: 1px solid #3a2f29; background: #17120f; color: #fff;
  }
  input:focus { outline: 2px solid #f28b4b; border-color: transparent; }
  button {
    font: inherit; font-weight: 600; padding: 14px; border: 0; border-radius: 12px;
    background: #f28b4b; color: #1a0f08; cursor: pointer;
  }
  button.quiet { background: #241c18; color: #eee5de; }
  small { color: #7f746c; }
`

/**
 * Render the login page.
 * @param input - what to show.
 * @returns the HTML document.
 */
export function renderPage(input: PageInput): string {
  const label = escapeHtml(input.label)
  const base = escapeHtml(input.mount)
  const notice = input.notice === undefined ? '' : `<p class="notice">${escapeHtml(input.notice)}</p>`
  const identity = input.identity === undefined
    ? '<p class="refused">This browser is not on the tailnet, so it cannot ask for a code.</p>'
    : input.allowed
      ? `<small>Signed in to the tailnet as ${escapeHtml(input.identity)}.</small>`
      : `<p class="refused">${escapeHtml(input.identity)} is on the tailnet but not on this harness's list.</p>`
  const form = !input.allowed
    ? ''
    : input.state === 'sent'
      ? `<form method="post" action="auth/verify">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" autofocus required aria-label="Code">
        <button type="submit">Sign in for seven days</button>
      </form>
      <form method="post" action="auth/send"><button type="submit" class="quiet">Send another code</button></form>`
      : '<form method="post" action="auth/send"><button type="submit">Send me a code on Telegram</button></form>'
  const lead = input.state === 'sent'
    ? 'A six-digit code is on its way to your Telegram. It lives five minutes.'
    : 'A new device signs in with a one-time code sent to your Telegram. It stays signed in for seven days.'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<base href="${base}">
<title>${label} · sign in</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1><span>${label}</span> · sign in</h1>
<p>${lead}</p>
${notice}
${form}
${identity}
</main>
</body>
</html>
`
}
