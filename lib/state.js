/**
 * muse_vtuber / state.js —— 形象的运行状态（state.json，schemaVersion 1）
 *
 * 存什么：可见性、模型名、当前表情与叠加开关、最后要求的动作组、最后写入者与时间。
 * 为什么跟输入侧的状态分开：摄像头/麦克风开关是"输入的实况"，归 mira_input 的 state.json；
 * 这里只记"形象长什么样"。两件事写一个文件，任意一边落盘都会覆盖另一边的现场。
 *
 * 约定7：schemaVersion 不匹配 → 保留原文件、拒绝使用（工具会报 config/schema），不静默清空。
 * 旧版（拆分前）的 state.json 里还有 cameraOn/micOn/cameraSource/micSource —— 本仓库
 * `sanitize()` 会**忽略**它们（不报错），下一次写入时自然消失。
 */

import { join } from 'node:path'

import {
  MiraError, checkSchema, ensureDir, nowIso, readJsonStrict, writeJsonAtomic,
} from './kit.mjs'

export const STATE_SCHEMA = 1

export const DEFAULT_STATE = {
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
        hint: '删掉 ' + this.file + ' 让插件按默认重建（只会丢模型/表情这类界面状态）',
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

  /** 合并写入（设置页/工具/客户端上报都走这里）。返回 { state, changed:[] }。 */
  set(patch, { by = 'tool' } = {}) {
    if (this.loadError) {
      throw new MiraError(this.loadError.code, this.loadError.message, this.loadError.hint)
    }
    const next = { ...this.state }
    const changed = []
    const input = patch && typeof patch === 'object' ? patch : {}
    if (typeof input.visible === 'boolean' && input.visible !== next.visible) {
      next.visible = input.visible
      changed.push('visible')
    }
    for (const key of ['model', 'expression', 'motion']) {
      if (typeof input[key] !== 'string' || input[key] === next[key]) continue
      next[key] = clampText(input[key], 200)
      changed.push(key)
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
    if (key === 'visible') {
      if (typeof value === 'boolean') out.visible = value
      continue
    }
    if (key === 'model' || key === 'expression' || key === 'motion' || key === 'updatedAt' || key === 'by') {
      if (typeof value === 'string') out[key] = clampText(value, 200)
      continue
    }
    if (key === 'toggles' && Array.isArray(value)) {
      out.toggles = value.map((x) => clampText(x, 200)).filter(Boolean).slice(0, 64)
    }
    // 其余键（旧版的 cameraOn/micOn/cameraSource/micSource）忽略：它们已经搬到 mira_input
  }
  return out
}
