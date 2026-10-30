/**
 * muse_vtuber / config.js —— 配置：默认值 + 规整 + 落盘（config.json，schemaVersion 1）
 *
 * 两条来源（与 mira_live2d 同口径）：
 *   · cordis patch 里的 config：宿主启动时给的一份基线（升级时会被覆盖的那层）；
 *   · `$DSH_HOME/mira_config/muse_vtuber/config.json`：**权威值**，设置页保存就写这里，热生效。
 * 文件不存在时按「配置 → 内置默认」原子写一份出来（README 里写明这是唯一会自动创建的文件）。
 *
 * 约定2（显式优先）：这里只给「只影响显示与性能」的项兜底默认值，并且每一个默认值都写进
 * README 的配置表；必填项（API key）一律不给默认，缺了就是 creds/missing + 去哪填。
 * 约定7（配置版本）：schemaVersion 不匹配 → 保留原文件、拒绝使用、给迁移提示，不静默兼容。
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  MiraError, checkSchema, deepMerge, ensureDir, writeJsonAtomic,
} from './kit.mjs'

export const CONFIG_SCHEMA = 1

/**
 * 默认供应商入口（用户口径 2026-10-29）：token-plan 的 MaaS 网关。
 * 同一个 host 上两个前缀各有分工，**不能混用**（实测各自的路由都在）：
 *   compatible-mode/v1  OpenAI 兼容口：/audio/speech（合成）、/audio/transcriptions（识别）、/chat/completions
 *   api/v1             阿里云原生口：/services/aigc/multimodal-generation/generation（qwen-vl 识图等）
 * 想换回官方 DashScope：把三个 base 分别换成 dashscope.aliyuncs.com 的对应前缀即可。
 */
const QWEN_COMPAT = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1'
const QWEN_API = 'https://token-plan.maas.qianwenaiapi.com/api/v1'

export const DEFAULTS = {
  enabled: true,
  // 形象（LIVE2D）。modelsDir 留空 = 按 resolveModelsDir() 的顺序找（见下）
  live2d: {
    modelsDir: '',
    model: '',
    width: 420,
    height: 560,
  },
  // 摄像头：宽度/高度是请求分辨率（浏览器可能给更接近的档位）
  camera: {
    enabled: true,
    deviceId: '',
    width: 640,
    height: 480,
  },
  // 麦克风：sampleRate 是送 ASR 的目标采样率（浏览器侧重采样）；
  // deviceId 与 camera.deviceId 同口径：留空 = 浏览器默认输入设备
  mic: {
    enabled: true,
    deviceId: '',
    sampleRate: 16000,
    vad: {
      threshold: 0.02,
      silenceMs: 650,
      minSpeechMs: 320,
      maxMs: 15000,
    },
  },
  // 语音合成：任何 OpenAI 兼容的 POST {base}/audio/speech 都能用，默认阿里云 qwen-tts
  // 语音合成。provider（两边都用同一个 host，只是路径不同）：
  //   aliyun（实测可用）= POST {base}/services/audio/tts/SpeechSynthesizer
  //                       body {model, input:{text, voice, format, sample_rate}} → output.audio.url → 再下载
  //   openai            = POST {base}/audio/speech（OpenAI 兼容口，直接回音频字节）
  tts: {
    enabled: true,
    provider: 'aliyun',
    base: QWEN_API,
    model: 'qwen-audio-3.0-tts-plus',
    // Qwen-Audio-TTS 的系统音色是 longan* 系列（不是 CosyVoice 的 Cherry/Serena）；
    // 完整清单见 docs 的「Qwen-Audio-TTS 音色列表」
    voice: 'longanhuan_v3.6',
    maxChars: 600,
    timeoutMs: 30000,
  },
  // 语音识别。provider：
  //   aliyun（实测可用）= POST {base}/services/aigc/multimodal-generation/generation
  //                        content [{type:'input_audio', input_audio:{data:'data:audio/wav;base64,…'}}]
  //                        + parameters {format, sample_rate, language_hints}（format 必填！）
  //   openai            = POST {base}/audio/transcriptions（multipart 上传 WAV）
  // base 的写法随 provider 变：aliyun 用 api/v1，openai 用 compatible-mode/v1
  asr: {
    enabled: true,
    provider: 'aliyun',
    base: QWEN_API,
    model: 'qwen-audio-3.0-asr-flash',
    language: 'zh',
    timeoutMs: 30000,
  },
  // 图像识别
  vision: {
    enabled: true,
    // dsh    = 把这一帧作为图片放进工具返回值，交给当前会话的模型自己看（不调第三方、不额外花钱）
    // aliyun = 服务端调 qwen-vl 返回一段文字（自动事件流必须用它，因为那条路不经过模型）
    provider: 'dsh',
    base: QWEN_API,
    // 这个网关没有专门的 VL 模型，qwen3.8-flash 能收图（实测 /chat/completions + image_url 返回 200）。
    // 换回官方 DashScope 时改成 qwen-vl-max-latest。vtuber_look 默认走 dsh，不需要这个模型。
    model: 'qwen3.8-flash',
    prompt: '用一句中文说清画面里发生了什么、有谁、在做什么。只描述你真正看到的，不要猜测。',
    timeoutMs: 30000,
    autoIntervalMs: 0,
  },
  // 事件流（功能点7）：识别结果作为插话（steer）投进会话
  events: {
    enabled: true,
    steer: true,
    voiceTemplate: '[感知·语音] {text}',
    visionTemplate: '[感知·画面] {text}',
    minIntervalMs: 5000,
    maxPerMin: 6,
    cooldownKeyMs: 30000,
    maxChars: 400,
  },
  // 「形象是一个账号」的权限（借 mira_account 的绑定模型）：
  //   · 账号 = vtuber-main（platform=vtuber，本地虚拟账号，不需要连接）
  //   · peer = 形象本身（avatar/main），会话是绑定的主体：一个 taker + 多个 observer
  //   · 接收（看/听/喂采集流）需要 observer 或 taker
  //   · 控制（说话/表情/动作/模型）必须 taker
  //   · 首次控制自动认领 taker；被占着时报冲突（force 可抢，旧 taker 降级 observer）
  //   · mira_account 不在 → 全禁止（mode='off' 可临时放开，等于谁都能控制）
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
  // 外部采集器（muse_galaxy 等）：把视频流/直播流包成"虚拟摄像头 / 虚拟麦克风"。
  // 注意分工：取帧策略（vision.autoIntervalMs）、断句阈值（mic.vad）、识别与限流都在本插件；
  // 这里只是"设备口径" —— 告诉采集器要几帧、多宽、要不要音频。
  capture: {
    enabled: true,
    // 真机看 4fps/480 偏糊：默认抬到 8fps/720（采集器按这个换算 scale 与 fps）
    fps: 8,
    width: 720,
    audio: true,
    autoSwitch: true,
    maxAudioMs: 30000,
    staleMs: 3000,
    lostMs: 15000,
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
  'camera.width': [160, 4096],
  'camera.height': [120, 4096],
  'mic.sampleRate': [8000, 48000],
  'mic.vad.threshold': [0.001, 0.5],
  'mic.vad.silenceMs': [150, 5000],
  'mic.vad.minSpeechMs': [100, 5000],
  'mic.vad.maxMs': [1000, 120000],
  'tts.maxChars': [1, 8000],
  'tts.timeoutMs': [1000, 120000],
  'asr.timeoutMs': [1000, 120000],
  'vision.timeoutMs': [1000, 120000],
  'vision.autoIntervalMs': [0, 3600000],
  'capture.fps': [1, 15],
  'capture.width': [160, 1920],
  'capture.maxAudioMs': [1000, 120000],
  'capture.staleMs': [500, 60000],
  'capture.lostMs': [1000, 300000],
  'events.minIntervalMs': [0, 3600000],
  'events.maxPerMin': [1, 600],
  'events.cooldownKeyMs': [0, 86400000],
  'events.maxChars': [1, 4000],
}

const BOOL_KEYS = [
  'enabled',
  'camera.enabled',
  'mic.enabled',
  'tts.enabled',
  'asr.enabled',
  'vision.enabled',
  'capture.enabled',
  'capture.audio',
  'capture.autoSwitch',
  'events.enabled',
  'events.steer',
  'security.autoClaim',
  'security.autoObserve',
  'legacyNode.enabled',
  'ui.showHint',
]

const STRING_KEYS = [
  'live2d.modelsDir',
  'live2d.model',
  'camera.deviceId',
  'mic.deviceId',
  'tts.provider',
  'tts.base',
  'tts.model',
  'tts.voice',
  'asr.base',
  'asr.model',
  'asr.provider',
  'asr.language',
  'vision.base',
  'vision.model',
  'vision.provider',
  'vision.prompt',
  'events.voiceTemplate',
  'events.visionTemplate',
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
  value.tts.base = String(value.tts.base || '').replace(/\/+$/, '')
  value.asr.base = String(value.asr.base || '').replace(/\/+$/, '')
  value.vision.base = String(value.vision.base || '').replace(/\/+$/, '')
  value.tts.provider = String(value.tts.provider || 'aliyun').toLowerCase()
  value.asr.provider = String(value.asr.provider || 'aliyun').toLowerCase()
  value.vision.provider = String(value.vision.provider || 'dsh').toLowerCase()
  if (value.tts.provider !== 'aliyun' && value.tts.provider !== 'openai') {
    warnings.push('tts.provider 只支持 aliyun / openai，已回落到 aliyun（tts.provider=' + JSON.stringify(value.tts.provider) + '）')
    value.tts.provider = 'aliyun'
  }
  if (value.asr.provider !== 'openai' && value.asr.provider !== 'aliyun') {
    warnings.push('asr.provider 只支持 openai / aliyun，已回落到 aliyun（asr.provider=' + JSON.stringify(value.asr.provider) + '）')
    value.asr.provider = 'aliyun'
  }
  if (value.vision.provider !== 'dsh' && value.vision.provider !== 'aliyun') {
    warnings.push('vision.provider 只支持 dsh / aliyun，已回落到 dsh（vision.provider=' + JSON.stringify(value.vision.provider) + '）')
    value.vision.provider = 'dsh'
  }
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

/**
 * 配置仓库：读 config.json（权威）→ 规整；写回原子替换；文件改动按 mtime 热生效（约定9）。
 */
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

  /** 启动读：缺文件 → 按 patch+默认写一份；坏文件/schema 不匹配 → 记 fatalError，不动原文件。 */
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

  /** 读文件原文；不存在返回 null（读失败也当不存在，不把 IO 错当成配置错）。 */
  readText() {
    try {
      return readFileSync(this.file, 'utf8')
    } catch {
      return null
    }
  }

  /** 用一段原文刷新缓存：schema/坏 JSON 只记 fatalError，绝不覆盖原文件。 */
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

  /**
   * 热生效：文件内容变了就重新加载（约定9）。
   *
   * 为什么比**内容**而不是比 mtime：Windows 上文件时间戳是懒更新的（同一瞬间连续写可能拿到同一个
   * mtimeNs），靠时间戳判断会漏掉改动 —— 自检里 C6 就偶发失败。配置文件只有几 KB，每次读一遍
   * 再字符串比较是最省心的确定性做法。
   */
  current() {
    const text = this.readText()
    if (text !== this.cacheRaw) {
      const result = this.load()
      if (result.error) {
        // 文件被改坏了：保留上一次好用的值，但仍然对外报错（工具要能说清哪里坏了）
        this.fatalError = result.error
      }
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

  /** 设置页保存：深合并 → 原子写（保留未知字段）→ 立即热生效。 */
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

/** 内部字段（绝对路径）不落盘。 */
function stripRuntime(value) {
  const { configFile, ...rest } = value
  return rest
}

/** 给浏览器的一份配置（不含路径、不含凭据状态以外的任何东西）。 */
export function publicConfig(cfg) {
  return {
    live2d: { width: cfg.live2d.width, height: cfg.live2d.height, model: cfg.live2d.model },
    camera: { enabled: cfg.camera.enabled, deviceId: cfg.camera.deviceId, width: cfg.camera.width, height: cfg.camera.height },
    mic: { enabled: cfg.mic.enabled, deviceId: cfg.mic.deviceId, sampleRate: cfg.mic.sampleRate, vad: { ...cfg.mic.vad } },
    // 前端要按这个间隔决定「自动识图」定时器（0 = 不自动抓帧）
    vision: { autoIntervalMs: cfg.vision.autoIntervalMs, provider: cfg.vision.provider },
    events: { enabled: cfg.events.enabled, steer: cfg.events.steer, minIntervalMs: cfg.events.minIntervalMs },
    features: {
      tts: cfg.tts.enabled === true,
      asr: cfg.asr.enabled === true,
      vision: cfg.vision.enabled === true,
    },
    ui: { showHint: cfg.ui.showHint !== false },
  }
}
