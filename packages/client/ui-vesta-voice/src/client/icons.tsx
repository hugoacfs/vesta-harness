/**
 * Inline glyphs for the voice controls, drawn on the 16-grid the harness icon
 * set uses (filled paths, currentColor, decorative). The harness ships no
 * microphone or handset glyph, so these live here.
 */

interface GlyphProps {
  size?: number
}

/**
 * Microphone glyph.
 * @param props.size - square edge in px (default 16).
 * @returns the svg.
 */
export function MicGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.6" y="1.4" width="4.8" height="8" rx="2.4" fill="currentColor" />
      <path d="M3.3 7.6a4.7 4.7 0 0 0 9.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 12.3v2.2M5.6 14.5h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Muted microphone glyph.
 * @param props.size - square edge in px (default 16).
 * @returns the svg.
 */
export function MicOffGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.6" y="1.4" width="4.8" height="8" rx="2.4" fill="currentColor" />
      <path d="M3.3 7.6a4.7 4.7 0 0 0 9.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 12.3v2.2M5.6 14.5h4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Ember heart glyph for the perception toggle.
 * @param props.size - square edge in px (default 16).
 * @returns the svg.
 */
export function HeartGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 14.2S3 11 1.7 7.9C.9 5.8 2.2 3.4 4.6 3.4c1.3 0 2.3.7 3.4 2 1.1-1.3 2.1-2 3.4-2 2.4 0 3.7 2.4 2.9 4.5C13 11 8 14.2 8 14.2z" />
    </svg>
  )
}

/**
 * End-call glyph (handset down).
 * @param props.size - square edge in px (default 16).
 * @returns the svg.
 */
export function EndGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 5.2c-2.6 0-5 .8-6.9 2.3a1.3 1.3 0 0 0-.3 1.7l1 1.5c.3.5 1 .7 1.5.4l1.7-.9c.5-.2.7-.7.6-1.2l-.2-1.1c.8-.3 1.7-.5 2.6-.5s1.8.2 2.6.5l-.2 1.1c-.1.5.1 1 .6 1.2l1.7.9c.5.3 1.2.1 1.5-.4l1-1.5a1.3 1.3 0 0 0-.3-1.7C13 6 10.6 5.2 8 5.2z" />
    </svg>
  )
}
