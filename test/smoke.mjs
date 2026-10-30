/**
 * muse_vtuber / test/smoke.mjs —— 离线自检（不需要 DSH、不联网、不碰真 ~/.dsh）
 *
 * 覆盖：
 *   A kit 副本一致 / B 配置规整 / C 配置仓库 / D 状态仓库 / E 模型与资源诊断
 *   F 阿里云三件事（假 fetch）/ G 事件总线与插话投递 / H HTTP 面（假 req/res）
 *   I 10 个工具 / J 入口装配、单实例、退场
 *
 * 跑法：node test/smoke.mjs        （退出码 0 = 全过；末行打印断言数）
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'muse-vtuber-smoke-'))
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')

let pass = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass += 1
  } catch (error) {
    failures.push(name + '：' + (error && error.message ? error.message : String(error)))
    console.log('[FAIL] ' + name + '：' + (error && error.message ? error.message : String(error)))
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/* ── 假件 ───────────────────────────────────────────────── */

class FakeReq {
  constructor({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    this.method = method
    this.url = url
    this.headers = headers
    this.body = body
    this._handlers = { data: [], end: [], error: [] }
  }

  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn)
    return this
  }

  emit(event, value) {
    for (const fn of this._handlers[event] || []) fn(value)
    return this
  }

  start() {
    const chunks = this.body === null || this.body === undefined
      ? []
      : [Buffer.from(typeof this.body === 'string' ? this.body : JSON.stringify(this.body), 'utf8')]
    setImmediate(() => {
      for (const chunk of chunks) this.emit('data', chunk)
      this.emit('end')
    })
    return this
  }
}

class FakeRes {
  constructor() {
    this.status = 0
    this.headers = {}
    this.chunks = []
    this.ended = false
    this._handlers = {}
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    return this
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
    return true
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    this.ended = true
    return this
  }

  on(event, fn) {
    ;(this._handlers[event] || (this._handlers[event] = [])).push(fn)
    return this
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get json() {
    try {
      return JSON.parse(this.text)
    } catch {
      return null
    }
  }
}

/**
 * 假 mira_account：vtuber 的权限判定只用 resolve/bind 两个方法。
 * 绑定键 = (accountId, peerKind, peerId)；一个 peer 只允许一个 taker，其余是 observer。
 */
function makeAccountBook() {
  return {
    bindings: new Map(),
    resolve(accountId, kind, peerId) {
      const row = this.bindings.get(accountId + '|' + kind + '|' + peerId)
      if (!row) return { taker: null, observers: [] }
      return {
        taker: row.taker ? { sessionId: row.taker } : null,
        observers: [...row.observers].map((s) => ({ sessionId: s })),
      }
    },
    bind({ sessionId, accountId, kind, peerId, mode = 'taker', force = false }) {
      const key = accountId + '|' + kind + '|' + peerId
      const row = this.bindings.get(key) || { taker: '', observers: new Set() }
      if (mode === 'observer') {
        if (row.taker === sessionId) row.taker = ''
        row.observers.add(sessionId)
        this.bindings.set(key, row)
        return { ok: true, action: 'observer' }
      }
      if (row.taker && row.taker !== sessionId && !force) {
        throw Object.assign(new Error('binding/conflict'), { code: 'binding/conflict' })
      }
      if (row.taker && row.taker !== sessionId && force) row.observers.add(row.taker)
      row.taker = sessionId
      row.observers.delete(sessionId)
      this.bindings.set(key, row)
      return { ok: true, action: 'taker' }
    },
  }
}

function makeCtx() {
  const registered = new Map()
  const routes = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
      tapIndex() {
        return () => {}
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        const entry = ctx.agents.get(String(sessionId))
        if (!entry) return { error: { code: 'session/not-found', message: 'no such session' } }
        return { agent: entry }
      },
    },
    sessions: { async flush() {} },
    accounts: makeAccountBook(),
    get(name) {
      return name === 'miraAccount' ? ctx.accounts : undefined
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return () => {
        try {
          dispose?.()
        } catch { /* 忽略 */ }
      }
    },
    agents: new Map(),
    registered,
    routes,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch { /* 忽略 */ }
      }
    },
  }
  return ctx
}

function fakeAgent() {
  const steered = []
  return {
    session: { id: 'sess-1' },
    steered,
    steer(message) {
      steered.push(message)
    },
  }
}

function fakeAgentThatThrows() {
  return {
    session: { id: 'sess-2' },
    steer() {
      throw new Error('steer 坏了')
    },
  }
}

/** 宽松解析：JSON 字符串就解析，FormData/其它原样留着（兼容识别口用 FormData）。 */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function makeFetch(routes) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      options,
      body: typeof options.body === 'string' ? safeJson(options.body) : options.body,
    })
    for (const [needle, responder] of routes) {
      if (String(url).includes(needle)) return responder(options)
    }
    throw new Error('假 fetch 没有匹配：' + url)
  }
  impl.calls = calls
  return impl
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
    async arrayBuffer() {
      return new TextEncoder().encode(JSON.stringify(payload)).buffer
    },
  }
}

function audioResponse(bytes = 128) {
  const buffer = Buffer.alloc(bytes, 7)
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/mpeg' },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
    async text() {
      return ''
    },
    async json() {
      return {}
    },
  }
}

/** 原生 TTS 的假上游：① POST SpeechSynthesizer 回一个 audio.url，② GET 那个 URL 拿字节。 */
function wavResponse(bytes = 128) {
  const buffer = Buffer.alloc(bytes, 7)
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/wav' },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
    async text() {
      return ''
    },
    async json() {
      return {}
    },
  }
}

const AUDIO_URL = 'https://fake-audio.invalid/tts/self.wav'

/** 组装「原生口合成」需要的假 fetch：SpeechSynthesizer + 音频下载。其它保留给 caller。 */
function makeSpeakFetch(bytes = 128, extra = []) {
  return makeFetch([
    ['/services/audio/tts/SpeechSynthesizer', () => jsonResponse({
      output: { finish_reason: 'stop', audio: { data: '', url: AUDIO_URL, id: 'audio_x', expires_at: 1 } },
      usage: { characters: 5 },
    })],
    ['fake-audio.invalid', () => wavResponse(bytes)],
    ...extra,
  ])
}

/** 假 attachments：照内置 read_image 用到的形状（saveImage → 带 attachmentId 的引用）。 */
function fakeAttachments() {
  const saved = []
  return {
    saved,
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] },
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: 'att-' + saved.length,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 640,
        height: 480,
      }
    },
  }
}

/* ── 载入被测模块（先钉 DSH_HOME，再 import） ──────────────── */

const kit = await import('../lib/kit.mjs')
const configMod = await import('../lib/config.js')
const stateMod = await import('../lib/state.js')
const modelsMod = await import('../lib/models.js')
const aliyunMod = await import('../lib/aliyun.js')
const eventsMod = await import('../lib/events.js')
const captureMod = await import('../lib/capture.js')
const authzMod = await import('../lib/authz.js')
const routesMod = await import('../lib/routes.js')
const toolsMod = await import('../lib/tools.js')
const indexMod = await import('../lib/index.js')

const BASE = kit.miraConfigDir('muse_vtuber')

/* ══════════════════════════════════════════════════════════
 * A. kit 副本一致
 * ══════════════════════════════════════════════════════════ */

await t('A1 lib/kit.mjs 与 tool_shared/kit/kit.mjs 逐字节一致', () => {
  const canonical = resolve(ROOT, '..', 'tool_shared', 'kit', 'kit.mjs')
  if (!existsSync(canonical)) return
  assert.equal(sha256(join(ROOT, 'lib', 'kit.mjs')), sha256(canonical))
})

/* ══════════════════════════════════════════════════════════
 * B. 配置规整
 * ══════════════════════════════════════════════════════════ */

await t('B1 默认值覆盖全部功能点', () => {
  const { value } = configMod.normalizeConfig({})
  for (const key of ['enabled', 'live2d', 'camera', 'mic', 'tts', 'asr', 'vision', 'events', 'ui']) {
    assert.ok(value[key] !== undefined, '缺默认值：' + key)
  }
  assert.equal(value.tts.model, 'qwen-audio-3.0-tts-plus')
  assert.equal(value.asr.model, 'qwen-audio-3.0-asr-flash')
  assert.equal(value.asr.provider, 'aliyun', '默认走千问原生识别口（实测可用）')
  assert.equal(value.tts.provider, 'aliyun', '默认走 SpeechSynthesizer（实测可用）')
  assert.equal(value.tts.voice, 'longanhuan_v3.6', 'Qwen-Audio-TTS 用 longan* 音色')
  assert.equal(value.tts.base, 'https://token-plan.maas.qianwenaiapi.com/api/v1', '合成走原生口 api/v1')
  assert.equal(value.asr.base, value.tts.base, '合成与识别共用同一个 host 的 api/v1')
  assert.equal(value.vision.base, 'https://token-plan.maas.qianwenaiapi.com/api/v1')
  assert.equal(value.vision.model, 'qwen3.8-flash', '这个网关没有 VL 专模，qwen3.8-flash 能收图')
  assert.equal(value.vision.provider, 'dsh')
  assert.equal(value.events.steer, true)
  assert.equal(value.camera.enabled, true)
})

await t('B2 越界数字被夹回范围并留 warning', () => {
  const { value, warnings } = configMod.normalizeConfig({ tts: { maxChars: 99999 }, live2d: { width: 1 } })
  assert.equal(value.tts.maxChars, 8000)
  assert.equal(value.live2d.width, 200)
  assert.ok(warnings.some((w) => w.includes('tts.maxChars')))
})

await t('B3 数字写成字符串会被转成数字', () => {
  const { value } = configMod.normalizeConfig({ live2d: { width: '640' }, mic: { sampleRate: '48000' } })
  assert.equal(value.live2d.width, 640)
  assert.equal(value.mic.sampleRate, 48000)
})

await t('B4 布尔写成字符串回落默认并点名', () => {
  const { value, warnings } = configMod.normalizeConfig({ camera: { enabled: 'false' } })
  assert.equal(value.camera.enabled, true)
  assert.ok(warnings.some((w) => w.includes('camera.enabled')))
})

await t('B5 空值数字回落到默认', () => {
  const { value, warnings } = configMod.normalizeConfig({ events: { maxPerMin: '' } })
  assert.equal(value.events.maxPerMin, 6)
  assert.ok(warnings.some((w) => w.includes('events.maxPerMin')))
})

await t('B6 未知字段原样保留（前向兼容）', () => {
  const { value } = configMod.normalizeConfig({ futureThing: { a: 1 } })
  assert.deepEqual(value.futureThing, { a: 1 })
})

await t('B7 ~ 与相对路径被展开成绝对路径', () => {
  const expanded = configMod.expandPath('~/x')
  assert.ok(expanded.endsWith('x') && !expanded.startsWith('~'), expanded)
  assert.equal(configMod.expandPath(''), '')
})

await t('B8 publicConfig 不含路径与凭据', () => {
  const { value } = configMod.normalizeConfig({})
  value.configFile = 'C:/x/config.json'
  const pub = configMod.publicConfig(value)
  assert.equal(pub.configFile, undefined)
  assert.equal(pub.live2d.modelsDir, undefined)
  assert.equal(pub.vision.provider, 'dsh')
  assert.equal(JSON.stringify(pub).includes('dashscope'), false)
})

await t('B9 模型目录解析顺序：手填 > 自己的默认 > mira_live2d 的默认', () => {
  const miraRoot = join(SANDBOX, 'mira_config')
  const explicit = configMod.resolveModelsDir({ live2d: { modelsDir: 'D:/models' } }, miraRoot, { exists: () => true })
  assert.equal(explicit.source, 'config')
  const none = configMod.resolveModelsDir({ live2d: { modelsDir: '' } }, miraRoot, { exists: () => false })
  assert.equal(none.source, 'own-default-missing')
  const shared = configMod.resolveModelsDir({ live2d: { modelsDir: '' } }, miraRoot, {
    exists: (dir) => String(dir).includes('mira_live2d'),
  })
  assert.equal(shared.source, 'mira_live2d-default')
  const own = configMod.resolveModelsDir({ live2d: { modelsDir: '' } }, miraRoot, {
    exists: (dir) => String(dir).includes('muse_vtuber'),
  })
  assert.equal(own.source, 'own-default')
})

await t('B10 vision.provider 只认 dsh / aliyun，其它值回落并点名', () => {
  const { value, warnings } = configMod.normalizeConfig({ vision: { provider: 'openai' } })
  assert.equal(value.vision.provider, 'dsh')
  assert.ok(warnings.some((w) => w.includes('vision.provider')))
})

/* ══════════════════════════════════════════════════════════
 * C. 配置仓库
 * ══════════════════════════════════════════════════════════ */

await t('C1 首次 load 按 patch 创建 config.json（含 schemaVersion）', () => {
  const store = new configMod.ConfigStore({ baseDir: BASE, patch: { tts: { voice: 'Serena' } } })
  const loaded = store.load()
  assert.equal(loaded.created, true)
  assert.ok(existsSync(store.file))
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.tts.voice, 'Serena')
  assert.equal(store.current().tts.voice, 'Serena')
})

await t('C2 已有文件不被 patch 覆盖（文件才是权威）', () => {
  const store = new configMod.ConfigStore({ baseDir: BASE, patch: { tts: { voice: '别的地方' } } })
  store.load()
  assert.equal(store.current().tts.voice, 'Serena')
})

await t('C3 save 深合并并原子写回，未知字段保留', () => {
  const store = new configMod.ConfigStore({ baseDir: BASE, patch: {} })
  store.load()
  const before = JSON.parse(readFileSync(store.file, 'utf8'))
  before.futureThing = 'keep-me'
  writeFileSync(store.file, JSON.stringify(before, null, 2))
  store.save({ tts: { model: 'qwen-tts-v2' } })
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.tts.model, 'qwen-tts-v2')
  assert.equal(raw.tts.voice, 'Serena')
  assert.equal(raw.futureThing, 'keep-me')
  assert.equal(store.current().tts.model, 'qwen-tts-v2')
})

await t('C4 schemaVersion 不匹配：拒绝使用且不改原文件', () => {
  const dir = join(SANDBOX, 'mira_config', 'muse_vtuber_schema')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')
  const text = JSON.stringify({ schemaVersion: 99, tts: { voice: 'x' } }, null, 2)
  writeFileSync(file, text)
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {} })
  store.file = file
  const loaded = store.load()
  assert.equal(loaded.error.code, 'config/schema')
  assert.throws(() => store.current(), /schemaVersion|版本/)
  assert.equal(readFileSync(file, 'utf8'), text, '原文件必须一字不变')
})

await t('C5 坏 JSON：给 config/corrupt 且不改文件', () => {
  const dir = join(SANDBOX, 'mira_config', 'muse_vtuber_bad')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')
  writeFileSync(file, '{ not json')
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {} })
  store.file = file
  const loaded = store.load()
  assert.equal(loaded.error.code, 'config/corrupt')
  assert.equal(readFileSync(file, 'utf8'), '{ not json')
})

await t('C6 手改文件（内容变）后 current() 热生效', () => {
  const dir = join(SANDBOX, 'mira_config', 'muse_vtuber_hot')
  mkdirSync(dir, { recursive: true })
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {} })
  store.load()
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  raw.tts = { ...raw.tts, voice: '手改的音色' }
  writeFileSync(store.file, JSON.stringify(raw, null, 2) + '\n')
  assert.equal(store.current().tts.voice, '手改的音色')
})

/* ══════════════════════════════════════════════════════════
 * D. 状态仓库
 * ══════════════════════════════════════════════════════════ */

await t('D1 默认状态：摄像头/麦克风关、可见、无动作', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-1') })
  store.load()
  const state = store.get()
  assert.equal(state.cameraOn, false)
  assert.equal(state.micOn, false)
  assert.equal(state.visible, true)
  assert.equal(state.motion, '')
})

await t('D2 set 合并、落盘、返回 changed', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-2') })
  store.load()
  const result = store.set({ cameraOn: true, model: 'SylviaMuse', motion: 'Idle#1' }, { by: 'client' })
  assert.deepEqual(result.changed.sort(), ['cameraOn', 'model', 'motion'])
  assert.equal(result.state.by, 'client')
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.cameraOn, true)
  assert.equal(raw.model, 'SylviaMuse')
  assert.equal(raw.motion, 'Idle#1')
})

await t('D3 值没变时 changed 为空且不落盘', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-3') })
  store.load()
  store.set({ cameraOn: true })
  const stamp = readFileSync(store.file, 'utf8')
  const again = store.set({ cameraOn: true })
  assert.deepEqual(again.changed, [])
  assert.equal(readFileSync(store.file, 'utf8'), stamp)
})

await t('D4 控制字符被清掉、toggles 去脏', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-4') })
  store.load()
  const result = store.set({ model: 'a\u0000b\nc', toggles: ['开关-帽子', '', null, 3] })
  assert.equal(result.state.model, 'abc')
  assert.deepEqual(result.state.toggles, ['开关-帽子', '3'])
})

await t('D5 state.json schemaVersion 不对：get() 抛、不静默清空', () => {
  const dir = join(SANDBOX, 'state-5')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 9 }))
  const store = new stateMod.StateStore({ baseDir: dir })
  const loaded = store.load()
  assert.equal(loaded.error.code, 'config/schema')
  assert.throws(() => store.get())
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 9)
})

/* ══════════════════════════════════════════════════════════
 * E. 模型与资源诊断
 * ══════════════════════════════════════════════════════════ */

const MODELS_DIR = join(SANDBOX, 'models')

function makeModel(name, { withTexture = true, dir = MODELS_DIR } = {}) {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  if (withTexture) writeFileSync(join(target, 'tex.png'), Buffer.alloc(8))
  writeFileSync(join(target, name + '.moc3'), Buffer.alloc(8))
  writeFileSync(join(target, '开关-帽子.exp3.json'), '{}')
  writeFileSync(join(target, '表情-惊喜.exp3.json'), '{}')
  const model3 = {
    Version: 3,
    FileReferences: {
      Moc: name + '.moc3',
      Textures: ['tex.png'],
      Physics: '',
      Expressions: [
        { Name: '开关-帽子', File: '开关-帽子.exp3.json' },
        { Name: '表情-惊喜', File: '表情-惊喜.exp3.json' },
      ],
      Motions: { Idle: [{ File: 'idle.motion3.json' }] },
    },
  }
  writeFileSync(join(target, name + '.model3.json'), JSON.stringify(model3, null, 2))
}

await t('E1 scanModels 找到目录式模型', () => {
  makeModel('SylviaMuse')
  const scanned = modelsMod.scanModels(MODELS_DIR)
  assert.equal(scanned.models.length, 1)
  assert.equal(scanned.models[0].name, 'SylviaMuse')
  assert.equal(scanned.models[0].entry, 'SylviaMuse/SylviaMuse.model3.json')
})

await t('E2 空目录：findModel 报 config/missing 并说清去哪放', () => {
  const empty = join(SANDBOX, 'models-empty')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => modelsMod.findModel(empty, ''), (error) => {
    assert.equal(error.code, 'config/missing')
    assert.ok(String(error.hint).includes(empty) || String(error.message).includes(empty))
    return true
  })
})

await t('E3 找不存在的模型：报错里列出可用清单', () => {
  assert.throws(() => modelsMod.findModel(MODELS_DIR, '不存在'), (error) => {
    assert.equal(error.code, 'config/missing')
    assert.ok(String(error.hint).includes('SylviaMuse'))
    return true
  })
})

await t('E4 capabilities：表情分类（开关类可叠加）+ 动作组 + 缺资源诊断', () => {
  const caps = modelsMod.capabilities(MODELS_DIR, 'SylviaMuse')
  assert.equal(caps.model, 'SylviaMuse')
  const toggles = caps.expressions.filter((e) => e.additive).map((e) => e.name)
  const singles = caps.expressions.filter((e) => !e.additive).map((e) => e.name)
  assert.deepEqual(toggles, ['开关-帽子'])
  assert.deepEqual(singles, ['表情-惊喜'])
  assert.deepEqual(caps.motions, ['Idle'])
  assert.ok(caps.missing.map((m) => m.file).includes('idle.motion3.json'))
})

await t('E5 贴图缺失会被点名', () => {
  makeModel('缺贴图', { withTexture: false })
  const caps = modelsMod.capabilities(MODELS_DIR, '缺贴图')
  assert.ok(caps.missing.some((m) => m.file === 'tex.png' && m.why === '贴图'))
})

await t('E6 坏 model3.json：报 config/corrupt', () => {
  const dir = join(SANDBOX, 'models-bad', '坏模型')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '坏模型.model3.json'), '{ nope')
  assert.throws(() => modelsMod.readModel3(join(dir, '坏模型.model3.json')), /JSON/)
})

/* ══════════════════════════════════════════════════════════
 * F. 阿里云（假 fetch）
 * ══════════════════════════════════════════════════════════ */

const CREDS_BASE = join(SANDBOX, 'creds-base')
const CFG = configMod.normalizeConfig({}).value

function makeAliyun(routes, overrides = {}) {
  const fetchImpl = makeFetch(routes)
  const service = new aliyunMod.AliyunService({
    config: { ...CFG, ...overrides },
    baseDir: CREDS_BASE,
    configFile: join(BASE, 'config.json'),
    fetchImpl,
  })
  return { service, fetchImpl }
}

await t('F1 没 key：synthesize 报 creds/missing 并指到具体文件', async () => {
  const { service } = makeAliyun([])
  await assert.rejects(() => service.synthesize('你好'), (error) => {
    assert.equal(error.code, 'creds/missing')
    assert.ok(String(error.hint).includes('creds'), error.hint)
    return true
  })
})

await t('F2 writeCreds 落盘、status 只报 configured 不泄 key', () => {
  const { service } = makeAliyun([])
  service.writeCreds({ apiKey: 'sk-secret-123' })
  const raw = JSON.parse(readFileSync(service.credsFile, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.apiKey, 'sk-secret-123')
  const status = service.status()
  assert.equal(status.configured, true)
  assert.equal(JSON.stringify(status).includes('sk-secret-123'), false)
})

await t('F3 TTS（默认 aliyun 原生口）：POST SpeechSynthesizer → 下载 audio.url', async () => {
  const service = new aliyunMod.AliyunService({
    config: CFG,
    baseDir: CREDS_BASE,
    configFile: 'x',
    fetchImpl: makeSpeakFetch(256),
  })
  service.writeCreds({ apiKey: 'sk-secret-123' })
  const out = await service.synthesize('你好呀', { voice: 'longanhuan_v3.6' })
  assert.equal(out.mime, 'audio/wav')
  assert.equal(out.bytes, 256)
  assert.equal(out.voice, 'longanhuan_v3.6')
  assert.equal(out.truncated, false)
  const call = service.fetchImpl.calls[0]
  assert.ok(call.url.endsWith('/services/audio/tts/SpeechSynthesizer'), call.url)
  assert.equal(call.options.headers.Authorization, 'Bearer sk-secret-123')
  assert.equal(call.body.model, CFG.tts.model)
  assert.equal(call.body.input.text, '你好呀')
  assert.equal(call.body.input.voice, 'longanhuan_v3.6')
  assert.equal(call.body.input.format, 'wav')
  assert.equal(call.body.input.sample_rate, 24000)
  // 第二步必须真的去下载（URL 24h 有效，不下载就没有音频）
  assert.ok(service.fetchImpl.calls[1].url.includes('fake-audio.invalid'), '要下载 audio.url')
})

await t('F3b TTS（openai 兼容口）：POST /audio/speech 直接拿字节', async () => {
  const service = new aliyunMod.AliyunService({
    config: { ...CFG, tts: { ...CFG.tts, provider: 'openai', base: 'https://gateway.example/compatible-mode/v1' } },
    baseDir: CREDS_BASE,
    configFile: 'x',
    fetchImpl: makeFetch([['/audio/speech', () => audioResponse(64)]]),
  })
  service.writeCreds({ apiKey: 'k' })
  const out = await service.synthesize('你好', {})
  assert.equal(out.mime, 'audio/mpeg')
  assert.equal(out.bytes, 64)
  assert.ok(service.fetchImpl.calls[0].url.endsWith('/audio/speech'))
  assert.equal(service.fetchImpl.calls[0].body.voice, CFG.tts.voice)
})

await t('F4 TTS 超长按码点截断并回报 truncated（不劈 emoji）', async () => {
  const service = new aliyunMod.AliyunService({
    config: { ...CFG, tts: { ...CFG.tts, maxChars: 4 } },
    baseDir: CREDS_BASE,
    configFile: 'x',
    fetchImpl: makeSpeakFetch(8),
  })
  service.writeCreds({ apiKey: 'k' })
  const out = await service.synthesize('😀'.repeat(10), {})
  assert.equal(out.truncated, true)
  assert.equal(out.requestedChars, 10)
  assert.equal(out.chars, 4)
})

await t('F5 TTS 未启用：config/missing 说清改哪一项', async () => {
  const { service } = makeAliyun([], { tts: { ...CFG.tts, enabled: false } })
  await assert.rejects(() => service.synthesize('x'), (error) => {
    assert.equal(error.code, 'config/missing')
    assert.ok(String(error.hint).includes('tts.enabled'))
    return true
  })
})

await t('F6 TTS 接口 401：错误被 redact（key 不出现在文案里）', async () => {
  const { service } = makeAliyun([['/services/audio/tts/SpeechSynthesizer', () => ({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    async text() {
      return 'invalid key sk-secret-123 / Bearer sk-secret-123'
    },
  })]])
  service.writeCreds({ apiKey: 'sk-secret-123' })
  await assert.rejects(() => service.synthesize('x'), (error) => {
    assert.equal(error.code, 'tts/failed')
    assert.equal(String(error.message).includes('sk-secret-123'), false)
    assert.ok(String(error.message).includes('***'))
    return true
  })
})

await t('F7 ASR（默认 aliyun 原生口）：input_audio + format/sample_rate + SSE:disable', async () => {
  const { service, fetchImpl } = makeAliyun([['multimodal-generation', () => jsonResponse({ output: { text: '你好，我是测试助手' } })]])
  service.writeCreds({ apiKey: 'k' })
  const out = await service.transcribe({ base64: 'AAAA', mime: 'audio/wav', sampleRate: 16000 })
  assert.equal(out.text, '你好，我是测试助手')
  assert.equal(out.provider, 'aliyun')
  const call = fetchImpl.calls[0]
  assert.ok(call.url.includes('/services/aigc/multimodal-generation/generation'), call.url)
  // 官方形状：{type:'input_audio', input_audio:{data}}，缺 type/format 时上游只回一个空 400
  const content = call.body.input.messages[0].content[0]
  assert.equal(content.type, 'input_audio')
  assert.equal(content.input_audio.data, 'data:audio/wav;base64,AAAA')
  assert.equal(call.body.parameters.format, 'wav')
  assert.equal(call.body.parameters.sample_rate, '16000')
  assert.deepEqual(call.body.parameters.language_hints, ['zh'])
  assert.equal(call.options.headers['X-DashScope-SSE'], 'disable')
})

await t('F7b ASR（openai 兼容口）：POST /audio/transcriptions，multipart 带 WAV', async () => {
  const { service, fetchImpl } = makeAliyun([['/audio/transcriptions', () => jsonResponse({ text: '你好，我是测试助手' })]], {
    asr: { ...CFG.asr, provider: 'openai', base: 'https://gateway.example/compatible-mode/v1' },
  })
  service.writeCreds({ apiKey: 'k' })
  const out = await service.transcribe({ base64: 'AAAA', mime: 'audio/wav' })
  assert.equal(out.text, '你好，我是测试助手')
  assert.equal(out.provider, 'openai')
  const call = fetchImpl.calls[0]
  assert.ok(call.url.endsWith('/audio/transcriptions'), call.url)
  assert.equal(call.options.headers['Content-Type'], undefined, 'FormData 自己带 boundary，不能手动设 Content-Type')
  assert.ok(call.body instanceof FormData, 'body 必须是 FormData')
  assert.equal(call.body.get('model'), CFG.asr.model)
  assert.equal(call.body.get('language'), 'zh')
  assert.ok(call.body.get('file') instanceof Blob, 'file 必须是 Blob')
})

await t('F7c ASR 顶层 {text} 与 output.sentence.text 两种形状都认', async () => {
  const top = await (async () => {
    const { service } = makeAliyun([['multimodal-generation', () => jsonResponse({ text: '顶层形状' })]])
    service.writeCreds({ apiKey: 'k' })
    return service.transcribe({ base64: 'AAAA' })
  })()
  assert.equal(top.text, '顶层形状')
  const sentence = await (async () => {
    const { service } = makeAliyun([['multimodal-generation', () => jsonResponse({ output: { sentence: { text: '句子形状' } } })]])
    service.writeCreds({ apiKey: 'k' })
    return service.transcribe({ base64: 'AAAA' })
  })()
  assert.equal(sentence.text, '句子形状')
})

await t('F8 ASR 空音频：asr/failed', async () => {
  const { service } = makeAliyun([['multimodal-generation', () => jsonResponse({})]])
  service.writeCreds({ apiKey: 'k' })
  await assert.rejects(() => service.transcribe({ base64: '  ' }), /音频为空/)
})

await t('F9 图像识别：content 是 [{text}] 也能抠出文本', async () => {
  const payload = { output: { choices: [{ message: { content: [{ text: '画面里有一个人。' }] } }] } }
  const { service, fetchImpl } = makeAliyun([['multimodal-generation', () => jsonResponse(payload)]])
  service.writeCreds({ apiKey: 'k' })
  const out = await service.describeImage({ dataUrl: 'data:image/jpeg;base64,AAAA' })
  assert.equal(out.text, '画面里有一个人。')
  assert.equal(fetchImpl.calls[0].body.input.messages[0].content[0].image, 'data:image/jpeg;base64,AAAA')
})

await t('F10 图像不是 data URL：vision/failed', async () => {
  const { service } = makeAliyun([['multimodal-generation', () => jsonResponse({})]])
  service.writeCreds({ apiKey: 'k' })
  await assert.rejects(() => service.describeImage({ dataUrl: 'C:/x.jpg' }), /data:image/)
})

await t('F11 extractText 兼容三种形状', () => {
  assert.equal(aliyunMod.extractText({ output: { choices: [{ message: { content: 'a' } }] } }), 'a')
  assert.equal(aliyunMod.extractText({ output: { choices: [{ message: { content: [{ text: 'b' }, { text: 'c' }] } }] } }), 'bc')
  assert.equal(aliyunMod.extractText({ output: { text: 'd' } }), 'd')
  assert.equal(aliyunMod.extractText(null), '')
})

await t('F12 识图：原生口不通（Model not exist）时自动切兼容聊天口，并记住不再白试', async () => {
  let nativeCalls = 0
  let compatCalls = 0
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    if (target.includes('/services/aigc/multimodal-generation/generation')) {
      nativeCalls += 1
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'application/json' },
        async text() {
          return '{"code":"NotFound","message":"Model not exist."}'
        },
      }
    }
    if (target.endsWith('/chat/completions')) {
      compatCalls += 1
      const body = JSON.parse(options.body)
      assert.equal(body.messages[0].content[1].type, 'image_url')
      assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAAA')
      const payload = { choices: [{ message: { content: '画面里有一张桌子。' } }] }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async json() {
          return payload
        },
        async text() {
          return JSON.stringify(payload)
        },
      }
    }
    throw new Error('没预料到的地址：' + target)
  }
  const service = new aliyunMod.AliyunService({
    config: {
      ...CFG,
      vision: {
        ...CFG.vision,
        provider: 'aliyun',
        base: 'https://gateway.example/api/v1',
        model: 'qwen3.8-flash',
      },
    },
    baseDir: join(SANDBOX, 'creds-f12'),
    configFile: 'x',
    fetchImpl,
  })
  service.writeCreds({ apiKey: 'k' })
  const first = await service.describeImage({ dataUrl: 'data:image/jpeg;base64,AAAA' })
  assert.equal(first.text, '画面里有一张桌子。')
  assert.equal(nativeCalls, 1)
  assert.equal(compatCalls, 1)
  assert.equal(service.visionPath, 'compatible')
  // 第二次直接走兼容口（只多 1 次 compatible，native 不再被调）
  const second = await service.describeImage({ dataUrl: 'data:image/jpeg;base64,AAAA' })
  assert.equal(second.text, '画面里有一张桌子。')
  assert.equal(nativeCalls, 1, '记住之后不该再试原生口')
  assert.equal(compatCalls, 2)
})

/* ══════════════════════════════════════════════════════════
 * G. 事件总线 / 插话投递
 * ══════════════════════════════════════════════════════════ */

function makeHub({ config = CFG, agent = fakeAgent(), now = () => Date.now() } = {}) {
  const counters = kit.makeCounters()
  const hub = new eventsMod.EventHub({
    config,
    resolveAgent: async (sessionId) => (sessionId === 'sess-1' || sessionId === 'sess-2' ? agent : null),
    sessions: { async flush() {} },
    counters,
    now,
  })
  return { hub, counters, agent }
}

await t('G1 SSE：attach 立刻收到 hello，broadcast 逐帧带 seq', () => {
  const { hub } = makeHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  assert.equal(hub.clientCount, 1)
  assert.ok(res.text.includes('"type":"hello"'))
  hub.broadcast('state', { state: { micOn: true } })
  const parsed = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  assert.equal(parsed[0].type, 'hello')
  assert.equal(parsed[1].type, 'state')
  assert.ok(parsed[1].seq > parsed[0].seq)
  hub.dispose()
})

await t('G2 没有页面时 request 立刻失败并说明怎么办', async () => {
  const { hub } = makeHub()
  await assert.rejects(() => hub.request('look', {}, { timeoutMs: 500 }), (error) => {
    assert.equal(error.code, 'delivery/failed')
    assert.ok(String(error.hint).includes('形象') || String(error.hint).includes('页面'))
    return true
  })
  hub.dispose()
})

await t('G3 request ↔ result 配对', async () => {
  const { hub } = makeHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const pending = hub.request('listen', { seconds: 1 }, { timeoutMs: 2000 })
  const frame = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((f) => f.type === 'command')
  assert.equal(frame.kind, 'listen')
  hub.resolveResult({ requestId: frame.requestId, ok: true, value: { base64: 'AAAA' } })
  assert.equal((await pending).base64, 'AAAA')
  hub.dispose()
})

await t('G4 result 报错 → request 被 reject', async () => {
  const { hub } = makeHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const pending = hub.request('look', {}, { timeoutMs: 2000 })
  const frame = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((f) => f.type === 'command')
  hub.resolveResult({ requestId: frame.requestId, ok: false, error: { code: 'camera/closed', message: '没画面' } })
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.code, 'camera/closed')
    return true
  })
  hub.dispose()
})

await t('G5 超时：request 报 delivery/failed，pending 清干净', async () => {
  const { hub } = makeHub()
  hub.attach(new FakeReq({ headers: {} }), new FakeRes())
  await assert.rejects(() => hub.request('look', {}, { timeoutMs: 1000 }), /没有回应/)
  assert.equal(hub.pending.size, 0)
  hub.dispose()
})

await t('G6 perceive：steer 收到带 source.kind=muse_vtuber 的用户消息', async () => {
  const { hub, agent } = makeHub()
  const result = await hub.perceive({ kind: 'voice', text: '你吃饭了吗', sessionId: 'sess-1', auto: true })
  assert.equal(result.delivered, true)
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'muse_vtuber')
  assert.equal(message.content[0].text, '[感知·语音] 你吃饭了吗')
  assert.equal(message.meta.percept, 'voice')
  hub.dispose()
})

await t('G7 perceive：没有 sessionId 就报 config/missing', async () => {
  const { hub } = makeHub()
  const result = await hub.perceive({ kind: 'voice', text: 'x', sessionId: '', auto: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'config/missing')
  hub.dispose()
})

await t('G8 perceive：events.enabled=false 时自动事件不投递（工具路径仍可）', async () => {
  const config = configMod.normalizeConfig({ events: { enabled: false } }).value
  const { hub, agent } = makeHub({ config })
  const auto = await hub.perceive({ kind: 'voice', text: 'x', sessionId: 'sess-1', auto: true })
  assert.equal(auto.reason, 'events-disabled')
  assert.equal(agent.steered.length, 0)
  const manual = await hub.perceive({ kind: 'voice', text: 'x', sessionId: 'sess-1', auto: false })
  assert.equal(manual.delivered, true)
  hub.dispose()
})

await t('G9 perceive：events.steer=false 只记不投', async () => {
  const config = configMod.normalizeConfig({ events: { steer: false } }).value
  const { hub, agent } = makeHub({ config })
  const result = await hub.perceive({ kind: 'voice', text: 'x', sessionId: 'sess-1', auto: true })
  assert.equal(result.reason, 'steer-off')
  assert.equal(agent.steered.length, 0)
  hub.dispose()
})

await t('G10 限流：minIntervalMs 命中就跳过并计数', async () => {
  let clock = 100000
  const config = configMod.normalizeConfig({ events: { minIntervalMs: 5000 } }).value
  const { hub, agent, counters } = makeHub({ config, now: () => clock })
  const first = await hub.perceive({ kind: 'voice', text: '第一句', sessionId: 'sess-1', auto: true })
  assert.equal(first.delivered, true)
  clock += 100
  const second = await hub.perceive({ kind: 'voice', text: '第二句', sessionId: 'sess-1', auto: true })
  assert.equal(second.reason, 'min-interval')
  assert.equal(agent.steered.length, 1)
  assert.equal(counters.get('percept.min-interval'), 1)
  hub.dispose()
})

await t('G11 限流：同一句话冷却', async () => {
  let clock = 1000
  const config = configMod.normalizeConfig({ events: { minIntervalMs: 0, cooldownKeyMs: 30000, maxPerMin: 60 } }).value
  const { hub } = makeHub({ config, now: () => clock })
  await hub.perceive({ kind: 'voice', text: '同一句', sessionId: 'sess-1', auto: true })
  clock += 1000
  assert.equal((await hub.perceive({ kind: 'voice', text: '同一句', sessionId: 'sess-1', auto: true })).reason, 'cooldown')
  hub.dispose()
})

await t('G12 限流：每分钟上限', async () => {
  let clock = 1000
  const config = configMod.normalizeConfig({ events: { minIntervalMs: 0, cooldownKeyMs: 0, maxPerMin: 2 } }).value
  const { hub } = makeHub({ config, now: () => clock })
  await hub.perceive({ kind: 'voice', text: 'a', sessionId: 'sess-1', auto: true })
  clock += 10
  await hub.perceive({ kind: 'voice', text: 'b', sessionId: 'sess-1', auto: true })
  clock += 10
  assert.equal((await hub.perceive({ kind: 'voice', text: 'c', sessionId: 'sess-1', auto: true })).reason, 'max-per-minute')
  hub.dispose()
})

await t('G13 steer 抛错：perceive 回 delivery/failed', async () => {
  const { hub } = makeHub({ agent: fakeAgentThatThrows() })
  const result = await hub.perceive({ kind: 'voice', text: 'x', sessionId: 'sess-2', auto: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'delivery/failed')
  hub.dispose()
})

await t('G14 会话不存在：resolveAgent 拿不到 → delivery/failed', async () => {
  const { hub } = makeHub()
  const result = await hub.perceive({ kind: 'voice', text: 'x', sessionId: 'ghost', auto: true })
  assert.equal(result.error.code, 'delivery/failed')
  hub.dispose()
})

await t('G15 正文超 maxChars 先截断再填模板', async () => {
  const config = configMod.normalizeConfig({ events: { maxChars: 5, minIntervalMs: 0 } }).value
  const { hub, agent } = makeHub({ config })
  await hub.perceive({ kind: 'vision', text: '一二三四五六七八九十', sessionId: 'sess-1', auto: true })
  assert.ok(agent.steered[0].content[0].text.includes('一二三四五'))
  assert.equal(agent.steered[0].content[0].text.includes('六'), false)
  hub.dispose()
})

await t('G16 dispose 后 request 报 plugin/disabled', async () => {
  const { hub } = makeHub()
  hub.attach(new FakeReq({ headers: {} }), new FakeRes())
  hub.dispose()
  assert.equal(hub.clientCount, 0)
  await assert.rejects(() => hub.request('look', {}, { timeoutMs: 500 }), /卸载|disabled/)
})

/* ══════════════════════════════════════════════════════════
 * H. HTTP 面
 * ══════════════════════════════════════════════════════════ */

const HTTP_BASE = join(SANDBOX, 'http-base')

async function makeDeps({ modelsDir = MODELS_DIR, fetchRoutes = [], sessionAgent = fakeAgent() } = {}) {
  const configStore = new configMod.ConfigStore({ baseDir: HTTP_BASE, patch: { live2d: { modelsDir } } })
  configStore.load()
  const stateStore = new stateMod.StateStore({ baseDir: HTTP_BASE })
  stateStore.load()
  const counters = kit.makeCounters()
  const aliyunSvc = new aliyunMod.AliyunService({
    config: configStore.current(),
    baseDir: HTTP_BASE,
    configFile: configStore.file,
    fetchImpl: makeFetch(fetchRoutes),
  })
  aliyunSvc.writeCreds({ apiKey: 'sk-http-test' })
  const agents = new Map([['sess-1', sessionAgent]])
  const hub = new eventsMod.EventHub({
    config: configStore.current(),
    resolveAgent: async (sessionId) => agents.get(sessionId) || null,
    sessions: { async flush() {} },
    counters,
  })
  const audioStore = new routesMod.AudioStore()
  const catalog = {
    modelsDir: () => modelsDir,
    find: (name) => modelsMod.findModel(modelsDir, name),
    capabilities: (name) => modelsMod.capabilities(modelsDir, name),
    view: () => {
      const scanned = modelsMod.scanModels(modelsDir)
      // 与真实 catalog.view() 同口径：state.model > config.live2d.model > 空（空白 = 不显示模型）
      let wanted = String(stateStore.snapshot().model || '').trim()
      if (wanted === '') {
        try {
          wanted = String(configStore.current().live2d.model || '').trim()
        } catch { /* 忽略 */ }
      }
      const exists = scanned.models.some((m) => m.name === wanted || m.entry === wanted)
      const current = wanted !== '' && exists ? wanted : ''
      const caps = current ? modelsMod.capabilities(modelsDir, current) : null
      return {
        dir: modelsDir,
        dirSource: 'config',
        models: scanned.models.map((m) => ({ name: m.name, entry: m.entry })),
        current,
        expressions: caps ? caps.expressions : [],
        motions: caps ? caps.motions : [],
        missing: caps ? caps.missing : [],
        capsError: null,
      }
    },
  }
  const deps = {
    configStore,
    stateStore,
    aliyun: () => {
      aliyunSvc.setConfig(configStore.current())
      return aliyunSvc
    },
    hub,
    catalog,
    audioStore,
    assetsDir: join(ROOT, 'assets'),
    logger: { info() {}, warn() {}, debug() {} },
    counters,
    speak: (cfg, text, voice) => routesMod.speak(deps, cfg, text, voice),
  }
  const handler = routesMod.createHandler(deps)
  return { deps, handler, stateStore, configStore, hub, audioStore, agents }
}

async function call(handler, { method = 'GET', url = '/', headers = {}, body = null }) {
  const req = new FakeReq({ method, url, headers, body })
  const res = new FakeRes()
  const promise = handler(req, res)
  req.start()
  await promise
  return { res, json: res.json, text: res.text, status: res.status }
}

await t('H1 health / bootstrap 可读，bootstrap 带齐前端要的东西', async () => {
  const { handler, hub } = await makeDeps()
  const health = await call(handler, { url: '/vtuber/api/health' })
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  const boot = await call(handler, { url: '/vtuber/api/bootstrap' })
  assert.equal(boot.status, 200)
  assert.ok(boot.json)
  assert.ok(boot.json.endpoints.events)
  assert.ok(Array.isArray(boot.json.models.models))
  assert.equal(boot.json.config.live2d.modelsDir, undefined)
  assert.equal(boot.json.features.configured, true)
  assert.equal(JSON.stringify(boot.json).includes('sk-http-test'), false)
  hub.dispose()
})

await t('H2 跨站请求一律 403', async () => {
  const { handler, hub } = await makeDeps()
  const bad = await call(handler, { url: '/vtuber/api/bootstrap', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } })
  assert.equal(bad.status, 403)
  assert.equal(bad.json.error.code, 'http/forbidden')
  const bad2 = await call(handler, {
    url: '/vtuber/api/state',
    method: 'POST',
    body: { cameraOn: true },
    headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3080' },
  })
  assert.equal(bad2.status, 403)
  const ok = await call(handler, { url: '/vtuber/api/bootstrap', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } })
  assert.equal(ok.status, 200)
  hub.dispose()
})

await t('H3 POST /state 落盘并广播；带 clientId 时 by 记成 client:<id>', async () => {
  const { handler, stateStore, hub } = await makeDeps()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const out = await call(handler, { url: '/vtuber/api/state', method: 'POST', body: { cameraOn: true, clientId: 'c-1' } })
  assert.equal(out.status, 200)
  assert.deepEqual(out.json.changed, ['cameraOn'])
  assert.equal(out.json.by, 'client:c-1')
  assert.equal(stateStore.get().by, 'client:c-1')
  assert.ok(res.text.includes('"type":"state"'))
  assert.ok(res.text.includes('client:c-1'))
  hub.dispose()
})

await t('H4 settings GET/POST：key 不回显，能写回配置与凭据', async () => {
  const { handler, configStore, hub } = await makeDeps()
  const view = await call(handler, { url: '/vtuber/api/settings' })
  assert.equal(view.status, 200)
  assert.equal(view.json.keyConfigured, true)
  assert.equal(view.text.includes('sk-http-test'), false)
  assert.equal(view.json.values.vision.provider !== undefined, true)
  const saved = await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { tts: { voice: 'Serena' }, camera: { enabled: false }, mic: { deviceId: 'mic-abc' }, vision: { provider: 'aliyun' } }, apiKey: 'sk-new-key' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.keyWritten, true)
  assert.equal(configStore.current().tts.voice, 'Serena')
  assert.equal(configStore.current().camera.enabled, false)
  // 麦克风也要能钉设备（与 camera.deviceId 同口径）
  assert.equal(configStore.current().mic.deviceId, 'mic-abc', 'mic.deviceId 要能被设置页写进配置')
  assert.equal(configStore.current().vision.provider, 'aliyun')
  const creds = JSON.parse(readFileSync(join(HTTP_BASE, 'creds', 'dashscope.json'), 'utf8'))
  assert.equal(creds.apiKey, 'sk-new-key')
  hub.dispose()
})

await t('H5 settings POST 只收白名单字段', async () => {
  const { handler, configStore, hub } = await makeDeps()
  await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { runtime: { models: ['hack'] }, configFile: '/etc/passwd', live2d: { width: 512 } } },
  })
  const raw = JSON.parse(readFileSync(configStore.file, 'utf8'))
  assert.equal(raw.runtime, undefined)
  assert.equal(raw.configFile, undefined)
  assert.equal(raw.live2d.width, 512)
  hub.dispose()
})

await t('H5b 设置页选模型 = 立即切换（改状态 + 广播）；空白 = 不显示模型', async () => {
  const { handler, stateStore, hub } = await makeDeps()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const picked = await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { live2d: { model: 'SylviaMuse' } } },
  })
  assert.equal(picked.status, 200)
  assert.equal(picked.json.appliedModel, 'SylviaMuse', '保存后必须立刻生效，不能只写配置')
  assert.equal(stateStore.get().model, 'SylviaMuse')
  assert.ok(res.text.includes('"type":"state"'), '要广播给页面，前端才会真的换模型')
  const view = await call(handler, { url: '/vtuber/api/settings' })
  assert.equal(view.json.values.live2d.model, 'SylviaMuse', '下拉框要显示当前模型')
  // 空白选项 = 不显示模型
  const cleared = await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { live2d: { model: '' } } },
  })
  assert.equal(cleared.json.appliedModel, '')
  assert.equal(stateStore.get().model, '', '空白要真的把正在显示的模型清掉')
  const after = await call(handler, { url: '/vtuber/api/settings' })
  assert.equal(after.json.values.live2d.model, '')
  // 名字不对：配置照写，但要如实回报（不假装切成功）
  const bad = await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { live2d: { model: '不存在的模型' } } },
  })
  assert.equal(bad.status, 200)
  assert.equal(bad.json.appliedModel, null)
  assert.equal(bad.json.modelError.code, 'config/missing')
  hub.dispose()
})

await t('H6 POST /asr：识别到文字 → steer 收到（带模板）', async () => {
  const agent = fakeAgent()
  const { handler, hub } = await makeDeps({
    sessionAgent: agent,
    fetchRoutes: [['multimodal-generation', () => jsonResponse({ output: { text: '我回来了' } })]],
  })
  const out = await call(handler, {
    url: '/vtuber/api/asr',
    method: 'POST',
    body: { base64: 'AAAA', mime: 'audio/wav', sessionId: 'sess-1', auto: true },
  })
  assert.equal(out.status, 200)
  assert.equal(out.json.text, '我回来了')
  assert.equal(out.json.steered, true)
  assert.ok(agent.steered[0].content[0].text.includes('我回来了'))
  hub.dispose()
})

await t('H7 POST /vision：auto:true 走阿里云并进会话；auto:false 只回文本', async () => {
  const agent = fakeAgent()
  const { handler, hub } = await makeDeps({
    sessionAgent: agent,
    fetchRoutes: [['multimodal-generation', () => jsonResponse({ output: { choices: [{ message: { content: [{ text: '画面里有一台电脑。' }] } }] } })]],
  })
  const auto = await call(handler, {
    url: '/vtuber/api/vision',
    method: 'POST',
    body: { image: 'data:image/jpeg;base64,AAAA', sessionId: 'sess-1' },
  })
  assert.equal(auto.json.text, '画面里有一台电脑。')
  assert.equal(agent.steered.length, 1)
  assert.equal(agent.steered[0].meta.percept, 'vision')
  const manual = await call(handler, {
    url: '/vtuber/api/vision',
    method: 'POST',
    body: { image: 'data:image/jpeg;base64,AAAA', sessionId: 'sess-1', auto: false },
  })
  assert.equal(manual.json.steered, false, 'auto:false 不插话')
  assert.equal(agent.steered.length, 1)
  hub.dispose()
})

await t('H8 POST /say：合成（原生口）→ 广播 say → 音频可取回', async () => {
  const { handler, hub, audioStore } = await makeDeps({
    fetchRoutes: [
      ['/services/audio/tts/SpeechSynthesizer', () => jsonResponse({ output: { audio: { url: AUDIO_URL } } })],
      ['fake-audio.invalid', () => wavResponse(64)],
    ],
  })
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const out = await call(handler, { url: '/vtuber/api/say', method: 'POST', body: { text: '你好' } })
  assert.equal(out.json.ok, true)
  assert.ok(String(out.json.url).startsWith('/vtuber/api/audio/'))
  assert.ok(res.text.includes('"type":"say"'))
  const id = String(out.json.url).split('/').pop()
  const audio = await call(handler, { url: '/vtuber/api/audio/' + id })
  assert.equal(audio.status, 200)
  assert.equal(audio.res.headers['content-type'], 'audio/wav')
  assert.equal(audioStore.get(id).buffer.length, 64)
  hub.dispose()
})

await t('H9 未知音频 id：404', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/vtuber/api/audio/nope' })
  assert.equal(out.status, 404)
  assert.equal(out.json.error.code, 'audio/not-found')
  hub.dispose()
})

await t('H10 静态资源可读；编码过的越界路径 403', async () => {
  const { handler, hub } = await makeDeps()
  const asset = await call(handler, { url: '/vtuber/assets/lib/pixi.min.js' })
  assert.equal(asset.status, 200)
  assert.ok(String(asset.res.headers['content-type']).includes('javascript'))
  const escaped = await call(handler, { url: '/vtuber/assets/%2e%2e%2f%2e%2e%2flib%2findex.js' })
  assert.equal(escaped.status, 403)
  const model = await call(handler, { url: '/vtuber/models/SylviaMuse/SylviaMuse.model3.json' })
  assert.equal(model.status, 200)
  hub.dispose()
})

await t('H11 capabilities：表情分类与缺失资源', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/vtuber/api/capabilities?model=SylviaMuse' })
  assert.equal(out.status, 200)
  assert.ok(out.json.expressions.some((e) => e.additive))
  const missing = await call(handler, { url: '/vtuber/api/capabilities?model=没有这个' })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'config/missing')
  hub.dispose()
})

await t('H12 请求体不是 JSON：400 payload/invalid', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/vtuber/api/state', method: 'POST', body: '{ nope' })
  assert.equal(out.status, 400)
  assert.equal(out.json.error.code, 'payload/invalid')
  hub.dispose()
})

await t('H13 未知接口：404 并指到 bootstrap', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/vtuber/api/nope' })
  assert.equal(out.status, 404)
  assert.ok(String(out.json.error.hint).includes('bootstrap'))
  hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * I. 工具
 * ══════════════════════════════════════════════════════════ */

const TOOL_BASE_SEQ = { n: 0 }

async function makeToolEnv({ fetchRoutes = [], withClient = true, visionProvider = 'dsh', attachments = null, llm = null } = {}) {
  TOOL_BASE_SEQ.n += 1
  const base = join(SANDBOX, 'tools-base-' + TOOL_BASE_SEQ.n)
  const configStore = new configMod.ConfigStore({
    baseDir: base,
    patch: { live2d: { modelsDir: MODELS_DIR }, vision: { provider: visionProvider } },
  })
  configStore.load()
  const stateStore = new stateMod.StateStore({ baseDir: base })
  stateStore.load()
  const counters = kit.makeCounters()
  const aliyunSvc = new aliyunMod.AliyunService({
    config: configStore.current(),
    baseDir: base,
    configFile: configStore.file,
    fetchImpl: makeFetch(fetchRoutes),
  })
  aliyunSvc.writeCreds({ apiKey: 'sk-tool-test' })
  const agent = fakeAgent()
  const hub = new eventsMod.EventHub({
    config: configStore.current(),
    resolveAgent: async (id) => (id === 'sess-1' ? agent : null),
    sessions: { async flush() {} },
    counters,
  })
  let clientRes = null
  if (withClient) {
    clientRes = new FakeRes()
    hub.attach(new FakeReq({ headers: {} }), clientRes)
  }
  const catalog = {
    modelsDir: () => MODELS_DIR,
    scan: () => modelsMod.scanModels(MODELS_DIR),
    find: (name) => modelsMod.findModel(MODELS_DIR, name),
    capabilities: (name) => modelsMod.capabilities(MODELS_DIR, name),
    view: () => {
      const scanned = modelsMod.scanModels(MODELS_DIR)
      const first = scanned.models[0]
      const caps = first ? modelsMod.capabilities(MODELS_DIR, first.name) : null
      return {
        dir: MODELS_DIR,
        dirSource: 'config',
        models: scanned.models.map((m) => ({ name: m.name, entry: m.entry })),
        current: first ? first.name : '',
        expressions: caps ? caps.expressions : [],
        motions: caps ? caps.motions : [],
        missing: caps ? caps.missing : [],
      }
    },
  }
  const audioStore = new routesMod.AudioStore()
  const deps = {
    configStore,
    stateStore,
    aliyun: () => {
      aliyunSvc.setConfig(configStore.current())
      return aliyunSvc
    },
    hub,
    catalog,
    audioStore,
    assetsDir: join(ROOT, 'assets'),
    logger: { info() {}, warn() {}, debug() {} },
    counters,
    attachments,
    llm,
    speak: (cfg, text, voice) => routesMod.speak(deps, cfg, text, voice),
  }
  const ctx = makeCtx()
  const dispose = toolsMod.registerTools(ctx, deps)
  return { ctx, deps, dispose, hub, agent, stateStore, configStore, clientRes, counters, registered: ctx.registered }
}

const parseTool = (text) => JSON.parse(text)
const execFor = (sessionId = 'sess-1') => ({ agent: { session: { id: sessionId } } })
const toolOf = (env, name) => env.registered.get(name)

async function takeCommandFrame(env, kind) {
  await new Promise((r) => setTimeout(r, 40))
  return env.clientRes.text.split('\n\n')
    .filter((x) => x.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .find((f) => f.type === 'command' && f.kind === kind)
}

await t('I1 注册 10 个工具，名字与 README 一致', async () => {
  const env = await makeToolEnv()
  assert.deepEqual([...env.registered.keys()].sort(), [...toolsMod.TOOL_NAMES].sort())
  assert.equal(toolsMod.TOOL_NAMES.length, 10)
  env.dispose()
  env.hub.dispose()
})

await t('I2 vtuber_status：只读、带模型清单与凭据状态（无 key 明文）', async () => {
  const env = await makeToolEnv()
  const text = await toolOf(env, 'vtuber_status').execute({}, execFor())
  const json = parseTool(text)
  assert.equal(json.ok, true)
  assert.equal(json.plugin, 'muse_vtuber')
  assert.ok(Array.isArray(json.models.models))
  assert.equal(json.credentials.configured, true)
  assert.equal(text.includes('sk-tool-test'), false)
  assert.equal(json.events.clients, 1)
  assert.equal(json.vision.provider, 'dsh')
  assert.equal(json.vision.attachmentsReady, false)
  env.dispose()
  env.hub.dispose()
})

await t('I3 vtuber_say：没有页面 → delivery/failed', async () => {
  const env = await makeToolEnv({ withClient: false })
  const json = parseTool(await toolOf(env, 'vtuber_say').execute({ text: '你好' }, execFor()))
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'delivery/failed')
  env.dispose()
  env.hub.dispose()
})

await t('I4 vtuber_say：有页面 → 合成（原生口）+ 广播', async () => {
  const env = await makeToolEnv({
    fetchRoutes: [
      ['/services/audio/tts/SpeechSynthesizer', () => jsonResponse({ output: { audio: { url: AUDIO_URL } } })],
      ['fake-audio.invalid', () => wavResponse(48)],
    ],
  })
  const json = parseTool(await toolOf(env, 'vtuber_say').execute({ text: '你好呀' }, execFor()))
  assert.equal(json.ok, true)
  assert.equal(json.clients, 1)
  assert.ok(String(json.url).includes('/vtuber/api/audio/'))
  assert.ok(env.clientRes.text.includes('"type":"say"'))
  env.dispose()
  env.hub.dispose()
})

await t('I5 vtuber_say：空文本报 tts/failed', async () => {
  const env = await makeToolEnv()
  const json = parseTool(await toolOf(env, 'vtuber_say').execute({ text: '  ' }, execFor()))
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'tts/failed')
  env.dispose()
  env.hub.dispose()
})

await t('I6 vtuber_expression：落 state 并广播；未知表情直接拒绝且不改状态', async () => {
  const env = await makeToolEnv()
  const json = parseTool(await toolOf(env, 'vtuber_expression').execute({ name: '表情-惊喜' }, execFor()))
  assert.equal(json.ok, true)
  assert.deepEqual(json.changed, ['expression'])
  assert.equal(env.stateStore.get().expression, '表情-惊喜')
  const unknown = parseTool(await toolOf(env, 'vtuber_expression').execute({ name: '没有的表情' }, execFor()))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'expression/unknown')
  assert.ok(String(unknown.error.hint).includes('表情-惊喜'))
  assert.equal(env.stateStore.get().expression, '表情-惊喜', '状态必须原样不动')
  env.dispose()
  env.hub.dispose()
})

await t('I6b vtuber_expression：toggles 整体替换 / switch 单个开关 / 什么都不传只读', async () => {
  const env = await makeToolEnv()
  const toggled = parseTool(await toolOf(env, 'vtuber_expression').execute({ toggles: ['开关-帽子'] }, execFor()))
  assert.equal(toggled.ok, true)
  assert.deepEqual(env.stateStore.get().toggles, ['开关-帽子'])
  const added = parseTool(await toolOf(env, 'vtuber_expression').execute({ switch: '表情-惊喜', on: true }, execFor()))
  assert.equal(added.ok, true)
  assert.deepEqual(env.stateStore.get().toggles, ['开关-帽子', '表情-惊喜'])
  const removed = parseTool(await toolOf(env, 'vtuber_expression').execute({ switch: '开关-帽子', on: false }, execFor()))
  assert.deepEqual(removed.toggles, ['表情-惊喜'])
  const bad = parseTool(await toolOf(env, 'vtuber_expression').execute({ toggles: ['开关-没有'] }, execFor()))
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'expression/unknown')
  assert.deepEqual(env.stateStore.get().toggles, ['表情-惊喜'], '未知开关也不许写进去')
  const none = parseTool(await toolOf(env, 'vtuber_expression').execute({}, execFor()))
  assert.equal(none.ok, true)
  assert.deepEqual(none.changed, [])
  env.dispose()
  env.hub.dispose()
})

await t('I6c vtuber_visible / vtuber_motion：改状态、未知名字报错', async () => {
  const env = await makeToolEnv()
  const hide = parseTool(await toolOf(env, 'vtuber_visible').execute({ on: false }, execFor()))
  assert.equal(hide.visible, false)
  assert.equal(env.stateStore.get().visible, false)
  const show = parseTool(await toolOf(env, 'vtuber_visible').execute({}, execFor()))
  assert.equal(show.visible, true)
  const list = parseTool(await toolOf(env, 'vtuber_motion').execute({}, execFor()))
  assert.deepEqual(list.motions, ['Idle'])
  const played = parseTool(await toolOf(env, 'vtuber_motion').execute({ name: 'Idle' }, execFor()))
  assert.equal(played.ok, true)
  assert.ok(env.stateStore.get().motion.startsWith('Idle#'), '带序号才能重播同名动作')
  const bad = parseTool(await toolOf(env, 'vtuber_motion').execute({ name: '不存在' }, execFor()))
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'motion/unknown')
  env.dispose()
  env.hub.dispose()
})

await t('I7 vtuber_model：不传 = 列清单；传 = 切换并落 state', async () => {
  const env = await makeToolEnv()
  const list = parseTool(await toolOf(env, 'vtuber_model').execute({}, execFor()))
  assert.ok(list.models.length >= 1)
  const set = parseTool(await toolOf(env, 'vtuber_model').execute({ name: 'SylviaMuse' }, execFor()))
  assert.equal(set.ok, true)
  assert.equal(env.stateStore.get().model, 'SylviaMuse')
  const bad = parseTool(await toolOf(env, 'vtuber_model').execute({ name: '没这个' }, execFor()))
  assert.equal(bad.error.code, 'config/missing')
  env.dispose()
  env.hub.dispose()
})

await t('I8 vtuber_camera / vtuber_mic：省略参数 = 切换', async () => {
  const env = await makeToolEnv()
  const cam = parseTool(await toolOf(env, 'vtuber_camera').execute({}, execFor()))
  assert.equal(cam.cameraOn, true)
  const cam2 = parseTool(await toolOf(env, 'vtuber_camera').execute({}, execFor()))
  assert.equal(cam2.cameraOn, false)
  const mic = parseTool(await toolOf(env, 'vtuber_mic').execute({ on: true }, execFor()))
  assert.equal(mic.micOn, true)
  env.dispose()
  env.hub.dispose()
})

await t('I9 vtuber_look：摄像头没开 → camera/closed；没页面 → delivery/failed', async () => {
  const env = await makeToolEnv()
  const closed = await toolOf(env, 'vtuber_look').execute({}, execFor())
  assert.equal(closed.ok, false)
  assert.equal(closed.error.code, 'camera/closed')
  const noPage = await makeToolEnv({ withClient: false })
  await toolOf(noPage, 'vtuber_camera').execute({ on: true }, execFor())
  const json = await toolOf(noPage, 'vtuber_look').execute({}, execFor())
  assert.equal(json.error.code, 'delivery/failed')
  env.dispose()
  env.hub.dispose()
  noPage.dispose()
  noPage.hub.dispose()
})

await t('I10 vtuber_look（aliyun 模式）：页面回帧 → qwen-vl → 文本（steer 可选）', async () => {
  const env = await makeToolEnv({
    visionProvider: 'aliyun',
    fetchRoutes: [['multimodal-generation', () => jsonResponse({ output: { choices: [{ message: { content: '桌上有一杯茶。' } }] } })]],
  })
  await toolOf(env, 'vtuber_camera').execute({ on: true }, execFor())
  const pending = toolOf(env, 'vtuber_look').execute({ steer: true }, execFor())
  const frame = await takeCommandFrame(env, 'look')
  assert.ok(frame, '应当收到 look 指令帧')
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { image: 'data:image/jpeg;base64,AAAA' } })
  const json = await pending
  assert.equal(json.provider, 'aliyun')
  assert.equal(json.text, '桌上有一杯茶。')
  assert.equal(json.steered, true)
  assert.equal(env.agent.steered.length, 1)
  env.dispose()
  env.hub.dispose()
})

await t('I10b vtuber_look（dsh 模式，默认）：把帧存成附件交给模型，render 出图片块', async () => {
  const attachments = fakeAttachments()
  const env = await makeToolEnv({ attachments })
  await toolOf(env, 'vtuber_camera').execute({ on: true }, execFor())
  const pending = toolOf(env, 'vtuber_look').execute({ prompt: '我桌上有几个杯子？' }, execFor())
  const frame = await takeCommandFrame(env, 'look')
  assert.ok(frame)
  const jpeg = Buffer.from('fake-jpeg-bytes').toString('base64')
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { image: 'data:image/jpeg;base64,' + jpeg } })
  const value = await pending
  assert.equal(value.ok, true)
  assert.equal(value.provider, 'dsh')
  assert.equal(value.question, '我桌上有几个杯子？')
  assert.equal(value.image.mediaType, 'image/jpeg')
  assert.equal(attachments.saved.length, 1, '必须真的存进附件库')
  assert.equal(Buffer.from(attachments.saved[0].data).toString(), 'fake-jpeg-bytes')
  const blocks = toolOf(env, 'vtuber_look').output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('我桌上有几个杯子？'))
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-1')
  assert.equal(env.agent.steered.length, 0, 'dsh 模式不插话')
  env.dispose()
  env.hub.dispose()
})

await t('I10c vtuber_look（dsh 模式）：没有 attachments → platform/unsupported', async () => {
  const env = await makeToolEnv({ attachments: null })
  await toolOf(env, 'vtuber_camera').execute({ on: true }, execFor())
  const pending = toolOf(env, 'vtuber_look').execute({}, execFor())
  const frame = await takeCommandFrame(env, 'look')
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { image: 'data:image/jpeg;base64,AAAA' } })
  const value = await pending
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'platform/unsupported')
  assert.ok(String(value.error.hint).includes('aliyun'))
  env.dispose()
  env.hub.dispose()
})

await t('I10d vtuber_look（dsh 模式）：模型不收图片 → vision/unsupported（不白存图）', async () => {
  const attachments = fakeAttachments()
  const llm = { async resolveModelInfo() { return { inputModalities: ['text'] } } }
  const env = await makeToolEnv({ attachments, llm })
  await toolOf(env, 'vtuber_camera').execute({ on: true }, execFor())
  const pending = toolOf(env, 'vtuber_look').execute({}, {
    agent: { session: { id: 'sess-1' }, options: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  })
  const frame = await takeCommandFrame(env, 'look')
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { image: 'data:image/jpeg;base64,AAAA' } })
  const value = await pending
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'vision/unsupported')
  assert.equal(attachments.saved.length, 0)
  env.dispose()
  env.hub.dispose()
})

await t('I11 vtuber_listen：麦克风没开 → mic/closed', async () => {
  const env = await makeToolEnv()
  const json = parseTool(await toolOf(env, 'vtuber_listen').execute({}, execFor()))
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'mic/closed')
  env.dispose()
  env.hub.dispose()
})

await t('I12 vtuber_listen：页面回音频 → 识别文本（秒数被夹到 30）', async () => {
  const env = await makeToolEnv({
    fetchRoutes: [['multimodal-generation', () => jsonResponse({ output: { text: '今天天气不错' } })]],
  })
  await toolOf(env, 'vtuber_mic').execute({ on: true }, execFor())
  const pending = toolOf(env, 'vtuber_listen').execute({ seconds: 999 }, execFor())
  const frame = await takeCommandFrame(env, 'listen')
  assert.ok(frame)
  assert.equal(frame.payload.seconds, 30)
  env.hub.resolveResult({ requestId: frame.requestId, ok: true, value: { base64: 'AAAA', mime: 'audio/wav' } })
  const json = parseTool(await pending)
  assert.equal(json.ok, true)
  assert.equal(json.text, '今天天气不错')
  assert.equal(json.seconds, 30)
  env.dispose()
  env.hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * J. 入口装配 / 单实例 / 退场
 * ══════════════════════════════════════════════════════════ */

/** 前面的 C 组按「自己创建」的口径写过 $DSH_HOME 下的 config.json，这里把模型目录钉回配置。 */
function pinModelDir() {
  const store = new configMod.ConfigStore({ baseDir: BASE, patch: {} })
  store.load()
  store.save({ live2d: { modelsDir: MODELS_DIR } })
}

await t('J1 apply：注册 10 个工具 + /vtuber 路由，返回装配信息', async () => {
  pinModelDir()
  const ctx = makeCtx()
  try {
    const result = indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    assert.equal(result.ok, true)
    assert.equal(result.tools, 10)
    assert.equal(ctx.registered.size, 10)
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].path, '/vtuber')
    assert.equal(JSON.parse(readFileSync(result.configFile, 'utf8')).schemaVersion, 1)
    assert.ok(result.models >= 1, '装配时应扫到模型')
  } finally {
    ctx.dispose()
  }
})

await t('J2 第二个实例被拒（plugin/instance），不重复注册', async () => {
  pinModelDir()
  const ctx1 = makeCtx()
  const ctx2 = makeCtx()
  try {
    indexMod.apply(ctx1, { live2d: { modelsDir: MODELS_DIR } })
    const second = indexMod.apply(ctx2, {})
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'plugin/instance')
    assert.equal(ctx2.registered.size, 0)
    assert.equal(ctx2.routes.length, 0)
  } finally {
    ctx1.dispose()
    ctx2.dispose()
  }
})

await t('J3 退场后可以重新装配（认领被释放）', async () => {
  pinModelDir()
  const ctx = makeCtx()
  const again = makeCtx()
  try {
    indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    ctx.dispose()
    const result = indexMod.apply(again, { live2d: { modelsDir: MODELS_DIR } })
    assert.equal(result.ok, true)
  } finally {
    ctx.dispose()
    again.dispose()
  }
})

await t('J4 enabled=false：不注册任何东西并返回 plugin/disabled', async () => {
  const ctx = makeCtx()
  try {
    const result = indexMod.apply(ctx, { enabled: false })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'plugin/disabled')
    assert.equal(ctx.registered.size, 0)
  } finally {
    ctx.dispose()
  }
})

await t('J5 装配后工具可用（vtuber_status 走真 index 装配）', async () => {
  pinModelDir()
  const ctx = makeCtx()
  try {
    indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    const json = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor()))
    assert.equal(json.ok, true)
    assert.ok(json.models.models.length >= 1)
  } finally {
    ctx.dispose()
  }
})

await t('J6 配置带 schemaVersion 99：apply 不抛，status 报 config/schema', async () => {
  const file = join(BASE, 'config.json')
  const backup = readFileSync(file, 'utf8')
  const ctx = makeCtx()
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 99 }, null, 2))
    const result = indexMod.apply(ctx, {})
    assert.equal(result.ok, true)
    assert.equal(result.configError.code, 'config/schema')
    const json = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor()))
    assert.equal(json.configError.code, 'config/schema')
  } finally {
    ctx.dispose()
    writeFileSync(file, backup)
  }
})

await t('J7 默认空白：没选模型时 current 为空、表情工具报 model/none', async () => {
  pinModelDir()
  const ctx = makeCtx()
  try {
    indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    const status = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor()))
    assert.equal(status.models.current, '', '空白 = 默认不显示模型（只显示频谱环）')
    assert.deepEqual(status.models.missing, [], '没选模型就没有"当前模型的缺失资源"')
    assert.ok(status.models.models.length >= 1, '清单本身仍是可读的')
    // 表情/动作在没有显示模型时要说清楚，而不是拿清单第一个去校验
    const expr = parseTool(await ctx.registered.get('vtuber_expression').execute({ name: '表情-惊喜' }, execFor()))
    assert.equal(expr.ok, false)
    assert.equal(expr.error.code, 'model/none')
    const motion = parseTool(await ctx.registered.get('vtuber_motion').execute({ name: 'Idle' }, execFor()))
    assert.equal(motion.error.code, 'model/none')
  } finally {
    ctx.dispose()
  }
})

await t('J8 选了模型之后：资源缺失诊断有内容、vtuber_model clear 能清空', async () => {
  pinModelDir()
  const ctx = makeCtx()
  try {
    indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    const picked = parseTool(await ctx.registered.get('vtuber_model').execute({ name: 'SylviaMuse' }, execFor()))
    assert.equal(picked.ok, true)
    const status = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor()))
    assert.equal(status.models.current, 'SylviaMuse')
    assert.ok(status.models.missing.length >= 1)
    assert.ok(status.models.missing.every((m) => typeof m.file === 'string' && typeof m.why === 'string'))
    const cleared = parseTool(await ctx.registered.get('vtuber_model').execute({ clear: true }, execFor()))
    assert.equal(cleared.cleared, true)
    const after = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor()))
    assert.equal(after.models.current, '')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * K. 外部采集器（muse_galaxy 等）：虚拟摄像头 / 虚拟麦克风
 * ══════════════════════════════════════════════════════════ */

const JPEG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AKpJ/9k='

/** 采集器测试环境：真的 CaptureHub + 假识别/假事件总线 + 真 StateStore。 */
async function makeCaptureEnv({ config = {}, transcribe, describeImage } = {}) {
  const accounts = makeAccountBook()
  const dir = join(SANDBOX, 'capture-' + (TOOL_BASE_SEQ.n += 1))
  const configStore = new configMod.ConfigStore({ baseDir: dir, patch: config })
  configStore.load()
  const stateStore = new stateMod.StateStore({ baseDir: dir })
  stateStore.load()
  const perceived = []
  const broadcast = []
  const hub = {
    clientCount: 0,
    attach() {},
    broadcast(type, payload) { broadcast.push({ type, payload }) },
    async perceive(input) { perceived.push(input); return { ok: true, delivered: true } },
    dispose() {},
  }
  const service = {
    calls: { transcribe: 0, describeImage: 0 },
    async transcribe(input) {
      this.calls.transcribe += 1
      return { text: typeof transcribe === 'function' ? transcribe(input) : '听说有人在说话', model: 'fake' }
    },
    async describeImage(input) {
      this.calls.describeImage += 1
      return { text: typeof describeImage === 'function' ? describeImage(input) : '画面里有一个人', model: 'fake' }
    },
    status() { return { configured: true } },
  }
  const captureHub = new captureMod.CaptureHub({
    config: () => configStore.current(),
    aliyun: () => service,
    hub,
    stateStore,
    baseDir: dir,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  })
  const token = captureHub.token()
  return { dir, configStore, stateStore, captureHub, service, perceived, broadcast, token, hub, accounts }
}

function captureReq(env, { url = '/vtuber/api/capture/open', method = 'POST', body = {}, token, remote } = {}) {
  const headers = {}
  const useToken = token === undefined ? env.token.token : token
  if (useToken) headers.authorization = 'Bearer ' + useToken
  const req = new FakeReq({ method, url, headers, body })
  if (remote) req.socket = { remoteAddress: remote }
  return req
}

/** 走一次真实的 createHandler，但把 deps 换成带 captureHub 的那套。 */
async function callApi(env, sub, { method = 'POST', body = {}, token, remote, headers = {} } = {}) {
  const handler = routesMod.createHandler({
    configStore: env.configStore,
    stateStore: env.stateStore,
    aliyun: () => env.service,
    hub: env.hub,
    catalog: { modelsDir: () => MODELS_DIR, view: () => ({ dir: MODELS_DIR, dirSource: 'config', models: [], current: '', expressions: [], motions: [], missing: [] }) },
    audioStore: new routesMod.AudioStore(),
    captureHub: env.captureHub,
    assetsDir: join(ROOT, 'assets'),
    logger: { info() {}, warn() {}, debug() {} },
    counters: kit.makeCounters(),
  })
  const req = new FakeReq({ method, url: '/vtuber/api/' + sub, body, headers: { ...headers, ...(token === undefined && sub.startsWith('capture/') ? { authorization: 'Bearer ' + env.token.token } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) } })
  if (remote) req.socket = { remoteAddress: remote }
  const res = new FakeRes()
  const promise = handler(req, res)
  req.start()
  await promise
  return { res, json: res.json, status: res.status, text: res.text }
}

const sinePcm = (ms, rate = 16000, amp = 8000) => {
  const samples = Math.floor((ms / 1000) * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(amp * Math.sin((i / rate) * 2 * Math.PI * 220)), i * 2)
  return buf
}
const silencePcm = (ms, rate = 16000) => Buffer.alloc(Math.floor((ms / 1000) * rate) * 2)

await t('K1 采集口鉴权：无令牌 401、非回环 403、有令牌 200', async () => {
  const env = await makeCaptureEnv()
  try {
    const noToken = await callApi(env, 'capture/open', { token: '', body: { label: 'x' } })
    assert.equal(noToken.status, 401)
    assert.equal(noToken.json.error.code, 'capture/unauthorized')
    const offHost = await callApi(env, 'capture/open', { remote: '10.0.0.9', body: { label: 'x' } })
    assert.equal(offHost.status, 403)
    assert.equal(offHost.json.error.code, 'capture/forbidden')
    const ok = await callApi(env, 'capture/open', { body: { label: '测试直播间', source: 'test:1' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.ok(String(ok.json.captureId).startsWith('cap-'))
  } finally {
    env.captureHub.dispose()
  }
})

await t('K2 open：幂等同 source、按配置回 want、自动把来源切到 galaxy', async () => {
  const env = await makeCaptureEnv({ config: { capture: { fps: 5, width: 640 } } })
  try {
    const first = await callApi(env, 'capture/open', { body: { label: 'B站直播间 12345', source: 'bili:12345', sessionId: 'sess-1' } })
    assert.equal(first.json.want.fps, 5, 'fps 用配置里的设备口径')
    assert.equal(first.json.want.width, 640)
    assert.equal(first.json.want.audio, true)
    assert.equal(first.json.cameraUrl, '/vtuber/api/stream.mjpg?capture=' + first.json.captureId)
    const again = await callApi(env, 'capture/open', { body: { label: 'B站直播间 12345', source: 'bili:12345' } })
    assert.equal(again.json.captureId, first.json.captureId, '同一 source 幂等')
    assert.equal(again.json.reused, true)
    assert.equal(env.stateStore.get().cameraSource, 'galaxy', 'autoSwitch 默认把来源切到 galaxy')
    assert.equal(env.stateStore.get().micSource, 'galaxy')
    assert.equal(env.stateStore.get().cameraOn, true, '外部源接入 = 正在接收，开关该自动打开')
    assert.equal(env.stateStore.get().micOn, true)
  } finally {
    env.captureHub.dispose()
  }
})

await t('K3 frame：帧被缓存并推给 MJPEG 订阅者（multipart 头 + jpeg 字节）', async () => {
  const env = await makeCaptureEnv()
  try {
    const opened = await callApi(env, 'capture/open', { body: { label: '测试流', source: 'test:frame' } })
    const id = opened.json.captureId
    const sub = { res: new FakeRes(), captureId: id }
    env.captureHub.subscribers.add(sub)
    const pushed = await callApi(env, 'capture/frame', { body: { captureId: id, jpeg: JPEG_1PX } })
    assert.equal(pushed.status, 200)
    assert.equal(pushed.json.ok, true)
    assert.equal(pushed.json.selected, true)
    const out = sub.res.text
    assert.ok(out.includes('multipart/x-mixed-replace') || out.includes('mvframe'), '要写 MJPEG 边界')
    assert.ok(out.includes('Content-Type: image/jpeg'), '要有每帧头')
    const jpegBytes = Buffer.from(JPEG_1PX.split(',')[1], 'base64')
    // 二进制要按 Buffer 比（.text 会按 utf8 解码，jpeg 字节会变成替换符）
    const raw = Buffer.concat(sub.res.chunks)
    assert.ok(raw.includes(jpegBytes.subarray(0, 16)), '要把 jpeg 字节原样写出去')
    // 坏帧要明确拒绝
    const bad = await callApi(env, 'capture/frame', { body: { captureId: id, jpeg: 'not-a-data-url' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'capture/frame-invalid')
  } finally {
    env.captureHub.dispose()
  }
})

await t('K4 pcm：按 mic.vad 断句 → ASR → 插话（带来源标签）', async () => {
  const env = await makeCaptureEnv({
    config: { mic: { sampleRate: 16000, vad: { threshold: 0.02, silenceMs: 120, minSpeechMs: 100, maxMs: 5000 } } },
    transcribe: () => '大家好呀',
  })
  try {
    const opened = await callApi(env, 'capture/open', { body: { label: '电台', source: 'test:pcm', sessionId: 'sess-1' } })
    const id = opened.json.captureId
    await callApi(env, 'capture/pcm', { body: { captureId: id, pcm: sinePcm(300).toString('base64'), sampleRate: 16000 } })
    assert.equal(env.service.calls.transcribe, 0, '还没静音，不该断句')
    await callApi(env, 'capture/pcm', { body: { captureId: id, pcm: silencePcm(400).toString('base64'), sampleRate: 16000 } })
    // 断句是异步送 ASR 的，等一轮
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(env.service.calls.transcribe, 1, '静音够了应该断出一句')
    assert.equal(env.perceived.length, 1)
    assert.equal(env.perceived[0].kind, 'voice')
    assert.ok(String(env.perceived[0].text).includes('[电台]'), '插话要带来源标签：' + env.perceived[0].text)
    assert.ok(String(env.perceived[0].text).includes('大家好呀'))
  } finally {
    env.captureHub.dispose()
  }
})

await t('K5 pcm：纯静音不送 ASR；close 后状态回落且帧 404', async () => {
  const env = await makeCaptureEnv({
    config: { mic: { sampleRate: 16000, vad: { threshold: 0.02, silenceMs: 100, minSpeechMs: 100 } } },
  })
  try {
    const opened = await callApi(env, 'capture/open', { body: { label: '静音流', source: 'test:silence' } })
    const id = opened.json.captureId
    for (let i = 0; i < 5; i += 1) {
      await callApi(env, 'capture/pcm', { body: { captureId: id, pcm: silencePcm(200).toString('base64'), sampleRate: 16000 } })
    }
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(env.service.calls.transcribe, 0, '纯静音不能烧 ASR 额度')
    const closed = await callApi(env, 'capture/close', { body: { captureId: id, reason: 'stream-ended' } })
    assert.equal(closed.status, 200)
    assert.equal(env.stateStore.get().cameraSource, 'none', 'close 后不能还指着已消失的源')
    assert.equal(env.stateStore.get().cameraOn, false, '没得接收了，接收开关也该关掉')
    const after = await callApi(env, 'capture/frame', { body: { captureId: id, jpeg: JPEG_1PX } })
    assert.equal(after.status, 404)
    assert.equal(after.json.error.code, 'capture/not-found')
  } finally {
    env.captureHub.dispose()
  }
})

await t('K6 health / status 暴露采集能力与统计', async () => {
  const env = await makeCaptureEnv()
  try {
    const health = await callApi(env, 'health', { method: 'GET' })
    assert.equal(health.status, 200)
    assert.equal(health.json.features.capture.open, true)
    assert.equal(health.json.features.capture.stream, true)
    const opened = await callApi(env, 'capture/open', { body: { label: '带统计的流', source: 'test:stat' } })
    await callApi(env, 'capture/frame', { body: { captureId: opened.json.captureId, jpeg: JPEG_1PX } })
    const view = env.captureHub.status()
    assert.equal(view.sources.length, 1)
    assert.equal(view.sources[0].label, '带统计的流')
    assert.equal(view.sources[0].frames, 1)
    assert.equal(view.selected.camera, opened.json.captureId)
    assert.ok(String(view.tokenFile).endsWith('capture.json'))
  } finally {
    env.captureHub.dispose()
  }
})

await t('K7 vtuber_look 在 galaxy 源下用缓存帧（不需要页面在场）', async () => {
  const attachments = fakeAttachments()
  const env = await makeCaptureEnv()
  try {
    env.stateStore.set({ cameraOn: true, cameraSource: 'galaxy' }, { by: 'client' })
    const opened = await callApi(env, 'capture/open', { body: { label: '缓存源', source: 'test:look' } })
    await callApi(env, 'capture/frame', { body: { captureId: opened.json.captureId, jpeg: JPEG_1PX } })

    const registered = new Map()
    const ctx = makeCtx()
    const deps = {
      configStore: env.configStore,
      stateStore: env.stateStore,
      aliyun: () => env.service,
      hub: env.hub,
      catalog: { modelsDir: () => MODELS_DIR, view: () => ({ dir: MODELS_DIR, models: [], current: '', expressions: [], motions: [], missing: [] }), capabilities: () => ({ expressions: [], motions: [], missing: [] }) },
      audioStore: new routesMod.AudioStore(),
      captureHub: env.captureHub,
      assetsDir: join(ROOT, 'assets'),
      logger: { info() {}, warn() {}, debug() {} },
      counters: kit.makeCounters(),
      attachments,
      speak: async () => ({ ok: true }),
    }
    toolsMod.registerTools(ctx, deps)
    // hub.request 必须**不可用**：证明这次没走"让浏览器抓帧"那条路
    deps.hub.request = async () => { throw new Error('不该回到浏览器抓帧') }
    const result = await ctx.registered.get('vtuber_look').execute({ prompt: '看到什么' }, execFor())
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 200))
    assert.equal(result.provider, 'dsh')
    assert.equal(result.source.kind, 'capture')
    assert.equal(result.source.label, '缓存源')
    assert.equal(attachments.saved.length, 1, '缓存帧要能直接存成附件')
    ctx.dispose()
  } finally {
    env.captureHub.dispose()
  }
})

await t('K8 vtuber_listen 在 galaxy 源下明确回 mic/external（不假装能录音）', async () => {
  const env = await makeCaptureEnv()
  try {
    env.stateStore.set({ micOn: true, micSource: 'galaxy' }, { by: 'client' })
    const ctx = makeCtx()
    const deps = {
      configStore: env.configStore,
      stateStore: env.stateStore,
      aliyun: () => env.service,
      hub: env.hub,
      catalog: { modelsDir: () => MODELS_DIR, view: () => ({ dir: MODELS_DIR, models: [], current: '', expressions: [], motions: [], missing: [] }), capabilities: () => ({ expressions: [], motions: [], missing: [] }) },
      audioStore: new routesMod.AudioStore(),
      captureHub: env.captureHub,
      assetsDir: join(ROOT, 'assets'),
      logger: { info() {}, warn() {}, debug() {} },
      counters: kit.makeCounters(),
      speak: async () => ({ ok: true }),
    }
    toolsMod.registerTools(ctx, deps)
    const json = parseTool(await ctx.registered.get('vtuber_listen').execute({ seconds: 5 }, execFor()))
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'mic/external')
    assert.ok(String(json.error.hint).includes('capture') || String(json.error.hint).includes('波形'))
    ctx.dispose()
  } finally {
    env.captureHub.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * L. 「形象是一个账号」的权限：observer 能看、taker 能控
 * ══════════════════════════════════════════════════════════ */

/** 起一个只装配工具的环境（权限测试不用页面/采集）。
 *
 * 注意：cordis patch（apply 的第二个参数）**只在 config.json 不存在时**当基线写盘，
 * 之后每次都以文件为准。所以想改 mode 必须直接写配置文件，不能只传 patch。
 */
function authzEnv({ security, withAccount = true, bindings = [] } = {}) {
  const store = new configMod.ConfigStore({ baseDir: BASE, patch: {} })
  store.load()
  store.save({
    live2d: { modelsDir: MODELS_DIR },
    ...(security ? { security } : {}),
  })
  const ctx = makeCtx()
  if (!withAccount) ctx.get = () => undefined
  for (const [sessionId, mode] of bindings) {
    ctx.accounts.bind({ sessionId, accountId: 'vtuber-main', kind: 'avatar', peerId: 'main', mode })
  }
  const applied = indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
  return { ctx, applied }
}

await t('L1 没装 mira_account：默认全禁止，错误说清"装谁/怎么临时放开"', async () => {
  const { ctx, applied } = authzEnv({ security: { mode: 'enforce' }, withAccount: false })
  try {
    assert.equal(applied.ok, true, 'apply 不该因为没权限而失败')
    const json = parseTool(await ctx.registered.get('vtuber_say').execute({ text: '你好' }, execFor('sess-a')))
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'authz/unavailable')
    assert.ok(String(json.error.hint).includes('mira_account'))
    // 只读工具不受影响
    const status = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor('sess-a')))
    assert.equal(status.ok, true)
    assert.equal(status.security.mode, 'enforce')
    assert.equal(status.security.available, false)
    assert.equal(status.security.role, 'unavailable')
  } finally {
    ctx.dispose()
  }
})

await t('L2 首次控制自动认领 taker；别的会话被拒且给出 force 提示；force 抢占后旧的降为 observer', async () => {
  const { ctx } = authzEnv({ security: { mode: 'enforce' } })
  try {
    const first = parseTool(await ctx.registered.get('vtuber_visible').execute({ on: true }, execFor('sess-a')))
    assert.equal(first.ok, true, '第一个会话自动成为 taker')
    const view = ctx.accounts.resolve('vtuber-main', 'avatar', 'main')
    assert.equal(view.taker.sessionId, 'sess-a')

    const second = parseTool(await ctx.registered.get('vtuber_visible').execute({ on: false }, execFor('sess-b')))
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'authz/conflict')
    assert.ok(String(second.error.message).includes('sess-a'), '冲突要说清被谁占着：' + second.error.message)
    assert.ok(String(second.error.hint).includes('force'))

    const forced = parseTool(await ctx.registered.get('vtuber_visible').execute({ on: false, force: true }, execFor('sess-b')))
    assert.equal(forced.ok, true, 'force 能抢过来')
    const after = ctx.accounts.resolve('vtuber-main', 'avatar', 'main')
    assert.equal(after.taker.sessionId, 'sess-b')
    assert.equal(after.observers.some((o) => o.sessionId === 'sess-a'), true, '原 taker 降级 observer')
  } finally {
    ctx.dispose()
  }
})

await t('L3 接收类：observer 就能看/听；没绑定的会话自动登记 observer', async () => {
  const { ctx } = authzEnv({ security: { mode: 'enforce' }, bindings: [['sess-watcher', 'observer']] })
  try {
    // observer 调接收类工具（麦克风开关）会走到业务错误，说明权限闸门放行了
    //（vtuber_look 的输出是图片块对象，不是 JSON 文本，这里不拿它做断言）
    const mic = parseTool(await ctx.registered.get('vtuber_mic').execute({ on: false }, execFor('sess-watcher')))
    assert.equal(mic.ok, true, 'observer 应当能切麦克风（接收类）：' + JSON.stringify(mic).slice(0, 160))

    // 全新会话：自动登记 observer（autoObserve 默认开）
    const listen = parseTool(await ctx.registered.get('vtuber_mic').execute({ on: false }, execFor('sess-fresh')))
    assert.notEqual(listen.error && listen.error.code, 'authz/denied', 'autoObserve 应当放行')
    const view = ctx.accounts.resolve('vtuber-main', 'avatar', 'main')
    assert.equal(view.observers.some((o) => o.sessionId === 'sess-fresh'), true, '自动登记成 observer')
  } finally {
    ctx.dispose()
  }
})

await t('L4 security.mode=off：整体跳过（是谁都能控的兜底开关）', async () => {
  const { ctx } = authzEnv({ security: { mode: 'off' }, withAccount: false })
  try {
    const json = parseTool(await ctx.registered.get('vtuber_visible').execute({ on: true }, execFor('sess-x')))
    assert.equal(json.ok, true, 'off 时不该被权限挡住：' + JSON.stringify(json).slice(0, 200))
    const status = parseTool(await ctx.registered.get('vtuber_status').execute({}, execFor('sess-x')))
    assert.equal(status.security.mode, 'off')
    assert.equal(status.security.control, true)
  } finally {
    ctx.dispose()
  }
})

await t('L5 capture/open 也吃权限：没会话身份 → 403 authz/no-session；observer 才放行', async () => {
  const env = await makeCaptureEnv()
  try {
    const handler = routesMod.createHandler({
      configStore: env.configStore,
      stateStore: env.stateStore,
      aliyun: () => env.service,
      hub: env.hub,
      catalog: { modelsDir: () => MODELS_DIR, view: () => ({ dir: MODELS_DIR, dirSource: 'config', models: [], current: '', expressions: [], motions: [], missing: [] }) },
      audioStore: new routesMod.AudioStore(),
      captureHub: env.captureHub,
      authorizer: new authzMod.Authorizer({
        config: () => ({ security: { mode: 'enforce', accountId: 'vtuber-main', peerKind: 'avatar', peerId: 'main' } }),
        account: () => env.accounts,
      }),
      assetsDir: join(ROOT, 'assets'),
      logger: { info() {}, warn() {}, debug() {} },
      counters: kit.makeCounters(),
    })
    const post = async (body) => {
      const req = new FakeReq({
        method: 'POST',
        url: '/vtuber/api/capture/open',
        headers: { authorization: 'Bearer ' + env.token.token },
        body,
      })
      const res = new FakeRes()
      const promise = handler(req, res)
      req.start()
      await promise
      return res
    }

    const anonymous = await post({ label: '匿名', source: 'anon:1' })
    assert.equal(anonymous.status, 403, '没有会话身份应 403')
    assert.equal(anonymous.json.error.code, 'authz/no-session')

    const allowed = await post({ label: '有观众', source: 'anon:2', sessionId: 'sess-w' })
    assert.equal(allowed.status, 200, 'observer 放行：' + JSON.stringify(allowed.json).slice(0, 160))
  } finally {
    env.captureHub.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * 收尾
 * ══════════════════════════════════════════════════════════ */

try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch { /* 临时目录清理失败不算失败 */ }

if (failures.length) {
  console.log('\n---- 失败明细 ----')
  for (const failure of failures) console.log('· ' + failure)
  console.log('\n==== FAILED（' + pass + ' 过 / ' + failures.length + ' 败）====')
  process.exit(1)
}

console.log('\n==== ALL PASS（' + pass + ' 项断言）====')
