/** The archive-box glyph for the sidebar's panel list. */
export function ArchiveIcon({ size, active }: { size: number; active: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.85 }}>
      <rect x="3" y="4" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 11.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
