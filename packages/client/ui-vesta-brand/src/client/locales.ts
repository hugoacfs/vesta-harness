/** `brand.vesta` namespace dictionaries (the brand occupants' copy). */

/** Namespace owning this feature's copy. */
export const BRAND_NS = 'brand.vesta'

/** Simplified Chinese dictionary (the key-set source of truth). Proper nouns stay as-is. */
export const zh = {
  'brand.name': 'Vesta',
  'brand.suffix': 'Harness',
} satisfies Record<string, string>

/** The brand.vesta namespace key union. */
export type BrandKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'brand.name': 'Vesta',
  'brand.suffix': 'Harness',
} satisfies Record<BrandKey, string>
