/**
 * muse_vtuber / state.js —— 形象界面的运行状态（state.json，schemaVersion 1）
 *
 * 存什么：摄像头/麦克风开关、模型名、当前表情与叠加开关、可见性、最后写入者与时间。
 * 为什么不放 config.json：配置是「人定的意图」（设置页保存），状态是「界面当前的实况」
 * （按钮点一下就要写，且刷新后要能恢复）。两者混一个文件会让「撤销改动」把实况也撤掉。
 *
 * 约定7：schemaVersion 不匹配 → 保留原文件、拒绝使用（工具会报 config/schema），不静默清空。
 */

import { join } from 'node:path'

import {
  MiraError, checkSchema, ensureDir, nowIso, readJsonStrict, writeJsonAtomic,
} from './kit.mjs'

export const STATE_SCHEMA = 1

/** 摄像头/麦克风的来源：本机设备、外部采集器（muse_galaxy 等）、没有。 */
export const CAPTURE_SOURCES = ['device', 'galaxy', 'none']

export const DEFAULT_STATE = {
  cameraOn: false,
  micOn: false,
  // 采集来源：'device'（浏览器 getUserMedia）| 'galaxy'（外部采集器推流）| 'none'
  cameraSource: 'device',
  micSource: 'device',
  visible: true,
  model: '',
  expression: '',
  toggles: [],
  // 最近一次要求播放的动作组名（'' = 没要求；模型加载时会自己播 Idle）
  motion: '',
  updatedAt: '',
  by: 'init',
}

export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.baseDir `$DSH_HOME/mira_config/muse_vtuber`
   * @param {object} [options.logger]
   */
  constructor({ baseDir, logger = null }) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'state.json')
    this.logger = logger
    this.state = structuredClone(DEFAULT_STATE)
    this.loadError = null
  }

  load() {
    ensureDir(this.baseDir)
    const strict = readJsonStrict(this.file)
    if (strict.reason === 'missing') return { created: false }
    if (!strict.ok) {
      this.loadError = {
        code: 'config/corrupt',
        message: '状态文件不可用：' + this.file + (strict.detail ? '（' + strict.detail + '）' : ''),
        hint: '删掉 ' + this.file + ' 让插件按默认重建（只会丢摄像头/麦克风开关这类界面状态）',
      }
      return { error: this.loadError }
    }
    const checked = checkSchema(strict.value, STATE_SCHEMA, this.file)
    if (!checked.ok) {
      this.loadError = checked.error?.error || checked.error
      return { error: this.loadError }
    }
    this.state = { ...structuredClone(DEFAULT_STATE), ...sanitize(strict.value) }
    return { created: false, state: this.snapshot() }
  }

  /** 读：坏文件时抛（工具要能说清哪里坏了），而不是悄悄给默认值。 */
  get() {
    if (this.loadError) {
      throw new MiraError(this.loadError.code, this.loadError.message, this.loadError.hint)
    }
    return this.state
  }

  snapshot() {
    if (this.loadError) return structuredClone(DEFAULT_STATE)
    return structuredClone(this.state)
  }

  status() {
    return {
      file: this.file,
      state: this.snapshot(),
      error: this.loadError ? { ...this.loadError } : null,
    }
  }

  /** 合并写入（按钮/工具/客户端上报都走这里）。返回 { state, changed:[] }。 */
  set(patch, { by = 'tool' } = {}) {
    if (this.loadError) {
      throw new MiraError(this.loadError.code, this.loadError.message, this.loadError.hint)
    }
    const next = { ...this.state }
    const changed = []
    const input = patch && typeof patch === 'object' ? patch : {}
    if (typeof input.cameraOn === 'boolean' && input.cameraOn !== next.cameraOn) {
      next.cameraOn = input.cameraOn
      changed.push('cameraOn')
    }
    if (typeof input.micOn === 'boolean' && input.micOn !== next.micOn) {
      next.micOn = input.micOn
      changed.push('micOn')
    }
    if (typeof input.visible === 'boolean' && input.visible !== next.visible) {
      next.visible = input.visible
      changed.push('visible')
    }
    if (typeof input.model === 'string' && input.model !== next.model) {
      next.model = clampText(input.model, 200)
      changed.push('model')
    }
    if (typeof input.expression === 'string' && input.expression !== next.expression) {
      next.expression = clampText(input.expression, 200)
      changed.push('expression')
    }
    if (typeof input.motion === 'string' && input.motion !== next.motion) {
      next.motion = clampText(input.motion, 200)
      changed.push('motion')
    }
    // 采集来源：只认白名单，写错值不落盘（否则界面会去等一个不存在的源）
    for (const key of ['cameraSource', 'micSource']) {
      if (typeof input[key] !== 'string') continue
      const value = clampText(input[key], 20).toLowerCase()
      if (!CAPTURE_SOURCES.includes(value)) continue
      if (value !== next[key]) {
        next[key] = value
        changed.push(key)
      }
    }
    if (Array.isArray(input.toggles)) {
      const toggles = input.toggles.map((x) => clampText(x, 200)).filter(Boolean).slice(0, 64)
      if (JSON.stringify(toggles) !== JSON.stringify(next.toggles)) {
        next.toggles = toggles
        changed.push('toggles')
      }
    }
    if (changed.length === 0) return { state: this.snapshot(), changed }
    next.updatedAt = nowIso()
    next.by = clampText(by, 40) || 'tool'
    this.state = next
    this.flush()
    return { state: this.snapshot(), changed }
  }

  /** 落盘（失败只 warn，不把界面操作带崩）。 */
  flush() {
    const payload = { schemaVersion: STATE_SCHEMA, ...this.state }
    const written = writeJsonAtomic(this.file, payload)
    if (!written) {
      this.logger?.warn?.('[muse_vtuber] 状态落盘失败：' + this.file + '（界面操作仍生效，重启后会丢）')
    }
    return written
  }
}

function clampText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
}

function sanitize(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw || {})) {
    if (key === 'schemaVersion') continue
    if (key === 'cameraOn' || key === 'micOn' || key === 'visible') {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (key === 'model' || key === 'expression' || key === 'motion' || key === 'updatedAt' || key === 'by') {
      if (typeof value === 'string') out[key] = clampText(value, 200)
      continue
    }
    if (key === 'cameraSource' || key === 'micSource') {
      const source = clampText(value, 20).toLowerCase()
      if (CAPTURE_SOURCES.includes(source)) out[key] = source
      continue
    }
    if (key === 'toggles' && Array.isArray(value)) {
      out.toggles = value.map((x) => clampText(x, 200)).filter(Boolean).slice(0, 64)
    }
  }
  return out
}
