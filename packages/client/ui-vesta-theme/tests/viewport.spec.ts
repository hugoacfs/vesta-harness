import { describe, expect, it } from 'vitest'
import {
  HEIGHT_PROPERTY,
  KEYBOARD_ATTRIBUTE,
  KEYBOARD_MIN_PX,
  readViewport,
  trackViewport,
} from '../src/client/viewport.ts'
import type { ViewportHost } from '../src/client/viewport.ts'

describe('readViewport', () => {
  it('reads a keyboard when the visual viewport is much shorter than the layout viewport', () => {
    expect(readViewport({ layoutHeight: 800, visualHeight: 500, scale: 1 })).toEqual({ keyboard: true, height: 500 })
    expect(readViewport({ layoutHeight: 800, visualHeight: 800 - KEYBOARD_MIN_PX, scale: 1 }).keyboard).toBe(true)
  })

  it('ignores the small changes of a collapsing browser toolbar', () => {
    expect(readViewport({ layoutHeight: 800, visualHeight: 740, scale: 1 }).keyboard).toBe(false)
    expect(readViewport({ layoutHeight: 800, visualHeight: 800 - KEYBOARD_MIN_PX + 1, scale: 1 }).keyboard).toBe(false)
    expect(readViewport({ layoutHeight: 800, visualHeight: 800, scale: 1 }).keyboard).toBe(false)
  })

  it('does not mistake a pinch-zoom for a keyboard', () => {
    expect(readViewport({ layoutHeight: 800, visualHeight: 400, scale: 2 }).keyboard).toBe(false)
    expect(readViewport({ layoutHeight: 800, visualHeight: 500, scale: 1.005 }).keyboard).toBe(true)
  })
})

interface FakeOptions {
  viewport?: 'present' | 'absent' | 'null'
  coarsePointer?: boolean
  innerHeight?: number
  scrollY?: number
}

function fakePage(options: FakeOptions = {}) {
  const listeners = new Map<string, Set<() => void>>()
  const attributes = new Map<string, string>()
  const properties = new Map<string, string>()
  const scrolls: [number, number][] = []
  const visual = { height: 800, scale: 1, offsetTop: 0 }
  const state = { scrollY: options.scrollY ?? 0 }
  const viewportKind = options.viewport ?? 'present'
  const host: ViewportHost = {
    visualViewport: viewportKind === 'present'
      ? {
          get height() { return visual.height },
          get scale() { return visual.scale },
          get offsetTop() { return visual.offsetTop },
          addEventListener(type, listener) {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
          },
          removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener)
          },
        }
      : viewportKind === 'null' ? null : undefined,
    root: {
      style: {
        setProperty: (name, value) => { properties.set(name, value) },
        removeProperty: name => properties.delete(name),
      },
      setAttribute: (name, value) => { attributes.set(name, value) },
      removeAttribute: name => { attributes.delete(name) },
    },
    innerHeight: options.innerHeight ?? 800,
    get scrollY() { return state.scrollY },
    coarsePointer: options.coarsePointer ?? true,
    // As in a browser: scrolling to the top also brings the visual viewport back to it.
    scrollTo: (x, y) => {
      scrolls.push([x, y])
      state.scrollY = y
      visual.offsetTop = y
    },
  }
  /** Change the visual viewport and fire the events a browser would. */
  const resize = (next: Partial<typeof visual>) => {
    Object.assign(visual, next)
    for (const type of ['resize', 'scroll']) for (const listener of listeners.get(type) ?? []) listener()
  }
  const listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  return { host, attributes, properties, scrolls, visual, state, resize, listenerCount }
}

describe('trackViewport', () => {
  it('sets nothing while no keyboard is open', () => {
    const page = fakePage()
    trackViewport(page.host)
    expect(page.attributes.size).toBe(0)
    expect(page.properties.size).toBe(0)
  })

  it('publishes the visible height while the keyboard is open and clears it when it closes', () => {
    const page = fakePage()
    trackViewport(page.host)
    page.resize({ height: 480 })
    expect(page.attributes.get(KEYBOARD_ATTRIBUTE)).toBe('')
    expect(page.properties.get(HEIGHT_PROPERTY)).toBe('480px')
    page.resize({ height: 470.4 })
    expect(page.properties.get(HEIGHT_PROPERTY)).toBe('470px')
    page.resize({ height: 800 })
    expect(page.attributes.size).toBe(0)
    expect(page.properties.size).toBe(0)
  })

  it('pans the page back to the top only when the browser panned it', () => {
    const page = fakePage()
    trackViewport(page.host)
    page.resize({ height: 480 })
    expect(page.scrolls).toEqual([])
    page.resize({ offsetTop: 120 })
    expect(page.scrolls).toEqual([[0, 0]])
    expect(page.visual.offsetTop).toBe(0)
    page.state.scrollY = 90
    page.resize({})
    expect(page.scrolls).toEqual([[0, 0], [0, 0]])
  })

  it('does nothing on a device with a fine pointer or without a visual viewport', () => {
    for (const options of [{ coarsePointer: false }, { viewport: 'absent' as const }, { viewport: 'null' as const }]) {
      const page = fakePage(options)
      const stop = trackViewport(page.host)
      expect(page.listenerCount()).toBe(0)
      stop()
      expect(page.attributes.size).toBe(0)
    }
  })

  it('removes its listeners and what it set when stopped', () => {
    const page = fakePage()
    const stop = trackViewport(page.host)
    page.resize({ height: 480 })
    expect(page.listenerCount()).toBe(2)
    stop()
    expect(page.listenerCount()).toBe(0)
    expect(page.attributes.size).toBe(0)
    expect(page.properties.size).toBe(0)
  })

  it('is correct when the keyboard is already open at the start', () => {
    const page = fakePage()
    page.visual.height = 450
    trackViewport(page.host)
    expect(page.properties.get(HEIGHT_PROPERTY)).toBe('450px')
  })
})
