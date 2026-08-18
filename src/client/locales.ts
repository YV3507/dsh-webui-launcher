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
  unknown: 'Unknown',
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
  unknown: '未知',
}

export type WebUiKey = keyof typeof en
