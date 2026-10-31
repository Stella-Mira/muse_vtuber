/**
 * muse_vtuber / config.js —— 「形象」插件的配置：默认值 + 规整 + 落盘（config.json，schemaVersion 1）
 *
 * 拆分之后这里只剩**形象本身**的配置：LIVE2D、可见性提示、以及「形象是一个账号」的权限。
 * 声音（TTS/ASR/VAD/凭据）在 mira_audio 的配置里；摄像头/麦克风/采集器/自动推帧在 mira_input
 * 的配置里。旧 config.json 里遗留的那些键**原样留着不删**（本插件不再读它们），
 * 迁移脚本见 README「迁移」。
 *
 * 两条来源（与 mira_live2d 同口径）：
 *   · cordis patch 里的 config：宿主启动时给的一份基线（升级时会被覆盖的那层）；
 *   · `$DSH_HOME/mira_config/muse_vtuber/config.json`：**权威值**，设置页保存就写这里，热生效。
 * 文件不存在时按「配置 → 内置默认」原子写一份出来（这是唯一会自动创建的文件）。
 *
 * 约定7（配置版本）：schemaVersion 不匹配 → 保留原文件、拒绝使用、给迁移提示，不静默兼容。
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  MiraError, checkSchema, deepMerge, ensureDir, writeJsonAtomic,
} from './kit.mjs'

export const CONFIG_SCHEMA = 1

export const DEFAULTS = {
  enabled: true,
  // 形象（LIVE2D）。modelsDir 留空 = 按 resolveModelsDir() 的顺序找（见下）
  live2d: {
    modelsDir: '',
    model: '',
    width: 420,
    height: 560,
  },
  // 「形象是一个账号」的权限（借 mira_account 的绑定模型）：
  //   · 账号 = vtuber-main（platform=vtuber，本地虚拟账号，不需要连接）
  //   · peer = 形象本身（avatar/main），会话是绑定的主体：一个 taker + 多个 observer
  //   · 控制（表情/动作/显隐/模型）必须 taker
  //   · 首次控制自动认领 taker；被占着时报冲突（force 可抢，旧 taker 降级 observer）
  //   · mira_account 不在 → 全禁止（mode='off' 可临时放开，等于谁都能控制）
  // 注意：说话（audio_say）与输入（input_*）不在这里判定 —— 它们已拆成独立插件。
  security: {
    mode: 'enforce',
    accountId: 'vtuber-main',
    peerKind: 'avatar',
    peerId: 'main',
    cacheMs: 30000,
    autoClaim: true,
    autoObserve: true,
  },
  // 旧的外部「stella muse_vtuber 节点」桥（任务书范围外的历史功能，默认不加载）
  legacyNode: {
    enabled: false,
    base: 'http://127.0.0.1:11102/dsh',
    mcpUrl: 'http://127.0.0.1:11110/mcp',
  },
  ui: {
    showHint: true,
  },
}

const NUM_RULES = {
  'live2d.width': [200, 4096],
  'live2d.height': [200, 4096],
  // 权限判定缓存：0 = 每次都重新查（绑定关系改完立刻生效，但每次工具调用都读一次盘）
  'security.cacheMs': [0, 600000],
}

const BOOL_KEYS = [
  'enabled',
  'security.autoClaim',
  'security.autoObserve',
  'legacyNode.enabled',
  'ui.showHint',
]

const STRING_KEYS = [
  'live2d.modelsDir',
  'live2d.model',
  'security.mode',
  'security.accountId',
  'security.peerKind',
  'security.peerId',
  'legacyNode.base',
  'legacyNode.mcpUrl',
]

function getPath(obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[keys[keys.length - 1]] = value
}

/** `~/x` / 相对路径 都落成绝对路径；空值原样返回空串。 */
export function expandPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(text)
}

/**
 * 规整配置（不抛）：返回 { value, warnings }。
 * 类型不对/越界的项回落到默认值并留一条 warning（不静默吞掉用户写错的东西）。
 * 未知字段（含旧版的 camera/mic/tts/asr/vision/capture/events）原样保留 —— 前向兼容，
 * 也让用户从旧配置里看得出"这些已经搬到别的插件了"。
 */
export function normalizeConfig(raw, { configFile = '' } = {}) {
  const warnings = []
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('配置不是 JSON 对象，已整体回落到默认值')
  }
  const value = deepMerge(structuredClone(DEFAULTS), input)

  for (const [path, [min, max]] of Object.entries(NUM_RULES)) {
    const current = getPath(value, path)
    const num = typeof current === 'number' ? current : Number(current)
    if (current === '' || current === null || current === undefined || Number.isNaN(num)) {
      setPath(value, path, getPath(DEFAULTS, path))
      warnings.push(path + ' 不是数字，已用默认值 ' + getPath(DEFAULTS, path))
      continue
    }
    if (num < min || num > max) {
      const clamped = Math.min(max, Math.max(min, num))
      setPath(value, path, clamped)
      warnings.push(path + '=' + num + ' 超出 [' + min + ',' + max + ']，已改成 ' + clamped)
      continue
    }
    setPath(value, path, num)
  }

  for (const path of BOOL_KEYS) {
    const current = getPath(value, path)
    if (typeof current !== 'boolean') {
      setPath(value, path, getPath(DEFAULTS, path))
      warnings.push(path + ' 不是布尔值，已用默认值 ' + getPath(DEFAULTS, path))
    }
  }

  for (const path of STRING_KEYS) {
    const current = getPath(value, path)
    if (typeof current === 'string') continue
    if (current === undefined || current === null) {
      setPath(value, path, getPath(DEFAULTS, path))
      continue
    }
    setPath(value, path, String(current))
    warnings.push(path + ' 不是字符串，已按字符串处理')
  }

  value.live2d.modelsDir = expandPath(value.live2d.modelsDir)
  if (configFile) value.configFile = configFile
  return { value, warnings }
}

/**
 * 模型目录解析（功能点3 / 功能点9 都靠它）：
 *   1) config.live2d.modelsDir（手填优先，绝对路径）
 *   2) `$DSH_HOME/mira_config/muse_vtuber/model`
 *   3) `$DSH_HOME/mira_config/mira_live2d/model`（与 mira_live2d 共用的那套模型，存在才用）
 * 只影响显示，允许默认；README 与 status 里都把这个顺序写明。
 */
export function resolveModelsDir(cfg, miraConfigRoot, { exists = defaultExists } = {}) {
  const explicit = expandPath(cfg?.live2d?.modelsDir)
  if (explicit) return { dir: explicit, source: 'config' }
  const own = join(miraConfigRoot, 'muse_vtuber', 'model')
  if (exists(own)) return { dir: own, source: 'own-default' }
  const shared = join(miraConfigRoot, 'mira_live2d', 'model')
  if (exists(shared)) return { dir: shared, source: 'mira_live2d-default' }
  return { dir: own, source: 'own-default-missing' }
}

function defaultExists(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 配置仓库：读 config.json（权威）→ 规整；写回原子替换；文件改动按内容热生效（约定9）。 */
export class ConfigStore {
  /**
   * @param {object} options
   * @param {string} options.baseDir  `$DSH_HOME/mira_config/muse_vtuber`
   * @param {object} [options.patch]  cordis patch 里的 config（基线）
   * @param {object} [options.logger]
   */
  constructor({ baseDir, patch = {}, logger = null }) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'config.json')
    this.patch = patch && typeof patch === 'object' ? patch : {}
    this.logger = logger
    this.cache = null
    this.cacheRaw = null
    this.fatalError = null
    this.createdFile = false
    this.warnings = []
  }

  load() {
    ensureDir(this.baseDir)
    const text = this.readText()
    if (text === null) {
      const { value, warnings } = normalizeConfig(this.patch, { configFile: this.file })
      const payload = { schemaVersion: CONFIG_SCHEMA, ...stripRuntime(value) }
      this.createdFile = writeJsonAtomic(this.file, payload)
      this.cache = value
      this.warnings = warnings
      this.cacheRaw = this.createdFile ? JSON.stringify(payload, null, 2) + '\n' : null
      return { created: true, warnings }
    }
    return this.applyRaw(text)
  }

  readText() {
    try {
      return readFileSync(this.file, 'utf8')
    } catch {
      return null
    }
  }

  applyRaw(text) {
    this.cacheRaw = text
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.fatalError = {
        code: 'config/corrupt',
        message: '配置文件不可用：' + this.file + '（' + (error?.message || error) + '）',
        hint: '修好这个 JSON 文件（或删掉它让插件按默认重建），然后重载插件',
      }
      return { created: false, error: this.fatalError }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fatalError = {
        code: 'config/corrupt',
        message: '配置文件不是 JSON 对象：' + this.file,
        hint: '顶层必须是对象（{ "schemaVersion": 1, ... }）',
      }
      return { created: false, error: this.fatalError }
    }
    const checked = checkSchema(parsed, CONFIG_SCHEMA, this.file)
    if (!checked.ok) {
      this.fatalError = checked.error?.error || checked.error
      return { created: false, error: this.fatalError }
    }
    const { value, warnings } = normalizeConfig(parsed, { configFile: this.file })
    this.cache = value
    this.warnings = warnings
    this.fatalError = null
    return { created: false, warnings }
  }

  current() {
    const text = this.readText()
    if (text !== this.cacheRaw) {
      const result = this.load()
      if (result.error) this.fatalError = result.error
    }
    if (this.fatalError) {
      throw new MiraError(this.fatalError.code, this.fatalError.message, this.fatalError.hint)
    }
    if (!this.cache) {
      const { value } = normalizeConfig(this.patch, { configFile: this.file })
      this.cache = value
    }
    return this.cache
  }

  save(patch) {
    const before = this.current()
    const { value, warnings } = normalizeConfig(deepMerge(structuredClone(before), patch || {}), {
      configFile: this.file,
    })
    const payload = { schemaVersion: CONFIG_SCHEMA, ...stripRuntime(value) }
    const written = writeJsonAtomic(this.file, payload)
    if (!written) {
      throw new MiraError('config/write-failed', '写配置失败：' + this.file,
        '检查目录权限；文件会被原样保留，不会写坏的半截 JSON')
    }
    this.cache = value
    this.warnings = warnings
    this.fatalError = null
    this.cacheRaw = JSON.stringify(payload, null, 2) + '\n'
    return { value, warnings }
  }

  status() {
    return {
      file: this.file,
      createdFile: this.createdFile,
      warnings: this.warnings.slice(),
      error: this.fatalError ? { ...this.fatalError } : null,
    }
  }
}

function stripRuntime(value) {
  const { configFile, ...rest } = value
  return rest
}

/** 给浏览器的一份配置（不含路径、不含凭据）。 */
export function publicConfig(cfg) {
  return {
    live2d: { width: cfg.live2d.width, height: cfg.live2d.height, model: cfg.live2d.model },
    ui: { showHint: cfg.ui.showHint !== false },
  }
}
