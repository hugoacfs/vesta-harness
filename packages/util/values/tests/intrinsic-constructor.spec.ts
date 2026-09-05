import { afterEach, describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

/** SpiderMonkey and JavaScriptCore render native constructors across lines; V8 keeps one line. */
const SPIDERMONKEY_SOURCE = 'function Object() {\n    [native code]\n}'
const SPIDERMONKEY_ARRAY_SOURCE = 'function Array() {\n    [native code]\n}'

describe('snapshotJsonValue across engines', () => {
  const original = Function.prototype.toString

  afterEach(() => {
    Function.prototype.toString = original
  })

  it('accepts plain objects and arrays when native source is multi-line', () => {
    Function.prototype.toString = function (this: unknown): string {
      if (this === Object) return SPIDERMONKEY_SOURCE
      if (this === Array) return SPIDERMONKEY_ARRAY_SOURCE
      return original.call(this)
    }
    expect(snapshotJsonValue({ type: 'text-delta', text: 'hi', parts: [1, 'a', null] }))
      .toEqual({ type: 'text-delta', text: 'hi', parts: [1, 'a', null] })
  })

  it('still rejects a forged constructor whose source is not native', () => {
    const forgedPrototype = Object.create(null) as object
    function Object2(): void {}
    Object.defineProperty(Object2, 'name', { value: 'Object' })
    Object2.prototype = forgedPrototype
    Object.defineProperty(forgedPrototype, 'constructor', { value: Object2, enumerable: false })
    expect(snapshotJsonValue(Object.create(forgedPrototype) as object)).toBeUndefined()
  })
})
