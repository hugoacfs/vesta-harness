import { useId } from 'react'

/** Mark presentation shared by the sidebar and hero occupants. */
export interface VestaMarkProps {
  /** Square edge in px. */
  size: number
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * The Vesta ember orb: a warm gradient core with a soft halo and a specular
 * highlight, colored by the brand palette rather than currentColor so it reads
 * the same on every surface.
 * @param props - size and placement class.
 * @returns the decorative orb svg (aria-hidden; pair with the brand name).
 */
export function VestaMark({ size, className }: VestaMarkProps) {
  // useId yields `:r0:`-style ids; strip the colons so `url(#…)` stays unquoted-safe.
  const id = useId().replace(/:/g, '')
  const halo = `vesta-halo-${id}`
  const core = `vesta-core-${id}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={halo} cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#ff7847" stopOpacity="0.38" />
          <stop offset="100%" stopColor="#ff7847" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={core} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#fff3d9" />
          <stop offset="32%" stopColor="#ffc46b" />
          <stop offset="68%" stopColor="#ff7847" />
          <stop offset="100%" stopColor="#ff4d6d" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill={`url(#${halo})`} />
      <circle cx="16" cy="16" r="10.5" fill={`url(#${core})`} />
      <circle cx="12.4" cy="11.8" r="3.1" fill="#ffffff" fillOpacity="0.5" />
    </svg>
  )
}
