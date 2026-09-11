/** Dictionaries of the archived-sessions panel. */
export const SESSIONS_NS = 'vesta.sessions'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.label': '已归档',
  'panel.title': '已归档的会话',
  'panel.empty': '没有已归档的会话。',
  'panel.loading': '加载中…',
  'panel.error': '无法加载已归档的会话',
  'panel.refresh': '刷新',
  'row.untitled': '未命名会话',
  'row.restore': '恢复',
  'row.download': '下载日志',
  'row.delete': '永久删除…',
  'row.confirm': '删除这个会话？它会先导出到服务器的备份目录，然后从磁盘删除。',
  'row.confirmYes': '删除',
  'row.confirmNo': '取消',
  'row.deleted': '已删除，导出到',
  'row.busy': '请稍候…',
} satisfies Record<string, string>

/** The vesta.sessions namespace key union. */
export type SessionsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.label': 'Archived',
  'panel.title': 'Archived sessions',
  'panel.empty': 'No archived sessions.',
  'panel.loading': 'Loading…',
  'panel.error': 'Could not load the archived sessions',
  'panel.refresh': 'Refresh',
  'row.untitled': 'Untitled session',
  'row.restore': 'Restore',
  'row.download': 'Download log',
  'row.delete': 'Delete for good…',
  'row.confirm': 'Delete this session? It is exported to the server’s backup directory first, then removed from disk.',
  'row.confirmYes': 'Delete',
  'row.confirmNo': 'Cancel',
  'row.deleted': 'Deleted; exported to',
  'row.busy': 'One moment…',
} satisfies Record<SessionsKey, string>
