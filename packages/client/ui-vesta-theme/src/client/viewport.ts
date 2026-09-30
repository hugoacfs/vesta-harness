/**
 * Keyboard-aware page height for phones.
 *
 * iOS (and Android Chrome, by default) leaves the layout viewport alone when
 * the on-screen keyboard opens: only the *visual* viewport shrinks, and the
 * browser pans the page to keep the focused field visible. In this app that
 * pushes the header off-screen and leaves the composer half under the keys.
 * While the keyboard is open this module therefore publishes the visual
 * viewport's height as `--vesta-visual-height` and sets `data-vesta-keyboard`
 * on `<html>`; `vesta.css` sizes the page to that height, so the layout is
 * exactly the visible area. Nothing is set while the keyboard is closed, so
 * desktop and non-touch browsers are untouched.
 *
 * The decision ({@link readViewport}) is pure; {@link trackViewport} takes the
 * browser's objects through {@link ViewportHost} so both run under test.
 */

/** `<html>` attribute present while the keyboard is open. */
export const KEYBOARD_ATTRIBUTE = 'data-vesta-keyboard'
/** `<html>` custom property carrying the visible height while the keyboard is open. */
export const HEIGHT_PROPERTY = '--vesta-visual-height'
/**
 * How much shorter than the layout viewport the visual viewport must be before
 * it counts as a keyboard. A collapsing Safari toolbar moves it by well under
 * this; on-screen keyboards take 200 px or more.
 */
export const KEYBOARD_MIN_PX = 120
/** Pinch-zoom shrinks the visual viewport too; any scale above this is a zoom, not a keyboard. */
export const ZOOM_TOLERANCE = 1.01

/** The measurements {@link readViewport} decides from. */
export interface ViewportSample {
  /** `window.innerHeight`: the layout viewport, unchanged by an on-screen keyboard. */
  readonly layoutHeight: number
  /** `visualViewport.height`. */
  readonly visualHeight: number
  /** `visualViewport.scale`. */
  readonly scale: number
}

/** What the page should do about the viewport. */
export interface ViewportReading {
  /** An on-screen keyboard is covering the bottom of the layout viewport. */
  readonly keyboard: boolean
  /** The visible height, in CSS px. */
  readonly height: number
}

/**
 * Decide whether a keyboard is open.
 * @param sample - the viewport measurements.
 * @returns whether the keyboard is open and the visible height.
 */
export function readViewport(sample: ViewportSample): ViewportReading {
  const zoomed = sample.scale > ZOOM_TOLERANCE
  const covered = sample.layoutHeight - sample.visualHeight
  return { keyboard: !zoomed && covered >= KEYBOARD_MIN_PX, height: sample.visualHeight }
}

/** The parts of `VisualViewport` this module uses. */
export interface VisualViewportLike {
  readonly height: number
  readonly scale: number
  readonly offsetTop: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

/** The parts of `<html>` this module writes. */
export interface RootLike {
  readonly style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): unknown
  }
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/** Everything {@link trackViewport} reads from the page. */
export interface ViewportHost {
  readonly visualViewport: VisualViewportLike | null | undefined
  readonly root: RootLike
  readonly innerHeight: number
  readonly scrollY: number
  /** Whether the primary input is touch (`(pointer: coarse)`). */
  readonly coarsePointer: boolean
  scrollTo(x: number, y: number): void
}

/**
 * Read the host from the page.
 * @returns the host, or undefined without a window (server rendering, tests).
 */
export function browserHost(): ViewportHost | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  return {
    visualViewport: window.visualViewport,
    root: document.documentElement,
    get innerHeight() { return window.innerHeight },
    get scrollY() { return window.scrollY },
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    scrollTo: (x, y) => { window.scrollTo(x, y) },
  }
}

/**
 * Keep `<html>` in step with the visual viewport while the keyboard is open.
 * Does nothing on a device without `visualViewport` or without a touch pointer.
 * @param host - the page's viewport objects.
 * @returns a function that stops tracking and clears what was set.
 */
export function trackViewport(host: ViewportHost): () => void {
  const viewport = host.visualViewport
  if (viewport === null || viewport === undefined || !host.coarsePointer) return () => undefined
  const { root } = host

  const clear = () => {
    root.removeAttribute(KEYBOARD_ATTRIBUTE)
    root.style.removeProperty(HEIGHT_PROPERTY)
  }
  const sync = () => {
    const reading = readViewport({ layoutHeight: host.innerHeight, visualHeight: viewport.height, scale: viewport.scale })
    if (!reading.keyboard) {
      clear()
      return
    }
    root.setAttribute(KEYBOARD_ATTRIBUTE, '')
    root.style.setProperty(HEIGHT_PROPERTY, `${String(Math.round(reading.height))}px`)
    // The browser panned the page to show the focused field; the page now fits the visible area, so pan back.
    if (host.scrollY !== 0 || viewport.offsetTop !== 0) host.scrollTo(0, 0)
  }

  viewport.addEventListener('resize', sync)
  viewport.addEventListener('scroll', sync)
  sync()
  return () => {
    viewport.removeEventListener('resize', sync)
    viewport.removeEventListener('scroll', sync)
    clear()
  }
}
