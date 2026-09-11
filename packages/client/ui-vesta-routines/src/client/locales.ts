/** Dictionaries of the routines panel. */
export const ROUTINES_NS = 'vesta.routines'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.label': '例程',
  'panel.title': '例程',
  'panel.empty': '尚无例程。',
  'panel.loading': '加载中…',
  'panel.error': '无法加载例程',
  'panel.refresh': '刷新',
  'panel.file': '文件',
  'panel.errors': '文件中的问题',
  'row.schedule': '计划',
  'row.next': '下次',
  'row.last': '上次',
  'row.never': '从未',
  'row.running': '运行中…',
  'row.run': '立即运行',
  'row.pause': '暂停',
  'row.resume': '恢复',
  'row.open': '打开上次会话',
  'row.paused': '已暂停',
  'row.disabled': '已停用',
} satisfies Record<string, string>

/** The vesta.routines namespace key union. */
export type RoutinesKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.label': 'Routines',
  'panel.title': 'Routines',
  'panel.empty': 'No routines yet.',
  'panel.loading': 'Loading…',
  'panel.error': 'Could not load the routines',
  'panel.refresh': 'Refresh',
  'panel.file': 'File',
  'panel.errors': 'Problems in the file',
  'row.schedule': 'Schedule',
  'row.next': 'Next',
  'row.last': 'Last',
  'row.never': 'never',
  'row.running': 'Running…',
  'row.run': 'Run now',
  'row.pause': 'Pause',
  'row.resume': 'Resume',
  'row.open': 'Open last session',
  'row.paused': 'paused',
  'row.disabled': 'disabled',
} satisfies Record<RoutinesKey, string>
