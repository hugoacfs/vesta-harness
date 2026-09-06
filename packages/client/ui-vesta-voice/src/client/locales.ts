/** `vesta.voice` namespace dictionaries (the mic button and call HUD copy). */

/** Namespace owning this feature's copy. */
export const VOICE_NS = 'vesta.voice'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'mic.start': '开始语音通话',
  'mic.stop': '结束语音通话',
  'mic.busy': '另一个会话正在通话中',
  'hud.connecting': '连接中…',
  'hud.initializing': '准备中…',
  'hud.listening': '在听',
  'hud.thinking': '思考中',
  'hud.speaking': '说话中',
  'hud.idle': '已连接',
  'hud.error': '通话失败',
  'hud.mute': '静音麦克风',
  'hud.unmute': '取消静音',
  'hud.device': '选择麦克风',
  'hud.deviceDefault': '默认麦克风',
  'hud.noDevices': '未找到麦克风',
  'hud.micLevel': '麦克风音量',
  'hud.signal': '连接质量',
  'hud.emotionOn': '正在分享语气（点击隐藏）',
  'hud.emotionOff': '语气已隐藏（点击分享）',
  'hud.end': '结束通话',
} satisfies Record<string, string>

/** The vesta.voice namespace key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'mic.start': 'Start a voice call',
  'mic.stop': 'End the voice call',
  'mic.busy': 'A call is active in another session',
  'hud.connecting': 'Connecting…',
  'hud.initializing': 'Warming up…',
  'hud.listening': 'Listening',
  'hud.thinking': 'Thinking',
  'hud.speaking': 'Speaking',
  'hud.idle': 'Connected',
  'hud.error': 'Call failed',
  'hud.mute': 'Mute microphone',
  'hud.unmute': 'Unmute microphone',
  'hud.device': 'Choose microphone',
  'hud.deviceDefault': 'Default microphone',
  'hud.noDevices': 'No microphones found',
  'hud.micLevel': 'Microphone level',
  'hud.signal': 'Connection',
  'hud.emotionOn': 'Sharing your tone (click to hide)',
  'hud.emotionOff': 'Tone hidden (click to share)',
  'hud.end': 'End call',
} satisfies Record<VoiceKey, string>
