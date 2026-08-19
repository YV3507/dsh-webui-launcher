/**
 * Copy dictionaries for the dsh-webui-launcher settings section.
 */

/** Locale namespace owned by this plugin. */
export const NS = 'settings.webui'

export const en = {
  nav: 'Web UI Launcher',
  title: 'Web UI Launcher',
  intro: 'Start, stop or open the DeepSeek Harness Web UI from here.',
  ready: 'Ready',
  listening: 'Listening',
  notServing: 'Not serving',
  url: 'URL',
  start: 'Start',
  stop: 'Stop',
  open: 'Open browser',
  busy: 'Working…',
  error: 'Error',
  spawned: 'Started by this plugin',
  adopted: 'Adopted — this plugin did not start it and will not stop it',
  adoptedLauncher: 'Adopted — started by the desktop launcher; can be stopped',
  unknown: 'Unknown',
  iconTitle: 'Shortcut icon',
  iconHint: 'PNG, JPEG, BMP, GIF or TIFF — converted automatically (ICO on Windows, PNG on Linux).',
  chooseIcon: 'Choose an image',
  applyIcon: 'Apply icon',
  iconApplied: 'Shortcut icon updated',
  iconFailed: 'Icon update failed',
  noShortcut: 'No desktop shortcut exists yet',
}

export const zh = {
  nav: 'Web UI 启动器',
  title: 'Web UI 启动器',
  intro: '从这里启动、停止或打开 DeepSeek Harness Web UI。',
  ready: '就绪',
  listening: '正在监听',
  notServing: '未在服务',
  url: '地址',
  start: '启动',
  stop: '停止',
  open: '打开浏览器',
  busy: '处理中…',
  error: '错误',
  spawned: '由本插件启动',
  adopted: '已接管（非本插件启动，不会被停止）',
  adoptedLauncher: '已接管（由桌面启动器启动，可停止）',
  unknown: '未知',
  iconTitle: '快捷方式图标',
  iconHint: '支持 PNG/JPEG/BMP/GIF/TIFF，自动转换（Windows 用 ICO，Linux 用 PNG）。',
  chooseIcon: '选择图片',
  applyIcon: '应用图标',
  iconApplied: '快捷方式图标已更新',
  iconFailed: '图标更新失败',
  noShortcut: '尚未创建桌面快捷方式',
}

export type WebUiKey = keyof typeof en
