/** Inline glyphs for the voice controls (currentColor, decorative). */

interface GlyphProps {
  size?: number
}

/**
 * Microphone glyph.
 * @param props.size - square edge in px (default 18).
 * @returns the svg.
 */
export function MicGlyph({ size = 18 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 18v3M9 21h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Muted microphone glyph.
 * @param props.size - square edge in px (default 18).
 * @returns the svg.
 */
export function MicOffGlyph({ size = 18 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 18v3M9 21h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21s-7.5-4.6-9.5-9.3C1.3 8.6 3.2 5 6.8 5c2 0 3.4 1.1 5.2 3 1.8-1.9 3.2-3 5.2-3 3.6 0 5.5 3.6 4.3 6.7C19.5 16.4 12 21 12 21z" />
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.7 15.6l-2.9-2.9a1.5 1.5 0 0 0-2.1 0l-1.3 1.3a13.5 13.5 0 0 1-5.4-5.4l1.3-1.3a1.5 1.5 0 0 0 0-2.1L8.4 2.3a1.5 1.5 0 0 0-2.1 0L4.5 4.1C3 5.6 3.4 8.4 5.6 11.5c2.5 3.6 5.9 7 9.5 9.5 3.1 2.2 5.9 2.6 7.4 1.1l1.8-1.8a1.5 1.5 0 0 0 0-2.1z" transform="rotate(135 12 12)" />
    </svg>
  )
}
