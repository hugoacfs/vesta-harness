/** `brand.vesta` namespace dictionaries (the brand occupants' copy). */

/** Namespace owning this feature's copy. */
export const BRAND_NS = 'brand.vesta'

/** Simplified Chinese dictionary (the key-set source of truth). Proper nouns stay as-is. */
export const zh = {
  'brand.name': 'vesta',
  'brand.suffix': 'harness',
  'brand.suffix.staging': 'staging',
  'home.label': 'Vesta 主页',
  'notify.on': '提醒已开启',
  'notify.off': '开启提醒',
  'notify.install': '添加到主屏幕以接收提醒',
  'notify.blocked': '提醒已在系统设置中关闭',
  'notify.failed': '无法更改提醒',
} satisfies Record<string, string>

/** The brand.vesta namespace key union. */
export type BrandKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'brand.name': 'vesta',
  'brand.suffix': 'harness',
  'brand.suffix.staging': 'staging',
  'home.label': 'Vesta home',
  'notify.on': 'Alerts on',
  'notify.off': 'Turn on alerts',
  'notify.install': 'Add to Home Screen for alerts',
  'notify.blocked': 'Alerts blocked in Settings',
  'notify.failed': 'Could not change alerts',
} satisfies Record<BrandKey, string>
