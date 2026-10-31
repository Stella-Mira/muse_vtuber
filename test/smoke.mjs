/**
 * muse_vtuber / test/smoke.mjs —— 离线自检（不需要 DSH、不联网、不碰真 ~/.dsh）
 *
 * 拆分之后本插件的自检只覆盖**形象自己**的东西：
 *   A kit 副本一致 / B 配置规整与模型目录 / C 配置仓库 / D 状态仓库 / E 模型与资源诊断
 *   F SSE 总线 / G HTTP 面（假 req/res）/ H 工具（5 个）/ I 「形象是一个账号」的权限
 *   J 入口装配（假 miraAudio / miraInput）、单实例、退场
 *
 * 声音（TTS/ASR/VAD）的自检在 mira_audio，输入（摄像头/麦克风/采集器）的在 mira_input。
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

/** 假 mira_account：vtuber 的权限判定只用 resolve/bind 两个方法。 */
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

/** 假 miraAudio：只需要 status()/vad()（形象只转述，不用它识别）。 */
const FAKE_AUDIO = {
  status() {
    return {
      configured: true,
      credsFile: '/tmp/dashscope.json',
      tts: { enabled: true, model: 'tts' },
      asr: { enabled: true, model: 'asr' },
      vad: { threshold: 0.02, silenceMs: 650 },
      clients: 1,
    }
  },
  vad() {
    return { threshold: 0.02, silenceMs: 650, minSpeechMs: 320, maxMs: 15000 }
  },
}

/** 假 miraInput：形象只转述它的状态。 */
const FAKE_INPUT = {
  status() {
    return {
      ok: true,
      plugin: 'mira_input',
      state: { cameraOn: true, micOn: false, cameraSource: 'galaxy', micSource: 'device' },
      vision: { enabled: true, provider: 'dsh', autoIntervalMs: 0 },
      capture: { enabled: true, sources: [{ captureId: 'cap-1' }], selected: { camera: 'cap-1', mic: '' } },
      events: { enabled: true, steer: true, clients: 1 },
      audio: { asr: { enabled: true } },
      vad: { silenceMs: 650 },
    }
  },
}

function makeCtx({ withAudio = true, withInput = true, withAccount = true } = {}) {
  const registered = new Map()
  const routes = []
  const disposers = []
  const accounts = makeAccountBook()
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
    },
    get(name) {
      return name === 'miraAccount' && withAccount ? accounts : undefined
    },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    registered,
    routes,
    accounts,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch { /* 忽略 */ }
      }
    },
  }
  if (withAudio) ctx.miraAudio = FAKE_AUDIO
  if (withInput) ctx.miraInput = FAKE_INPUT
  return ctx
}

const execFor = (sessionId = 'sess-1') => ({ agent: { session: { id: sessionId } } })
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value)

/* ── 载入被测模块（先钉 DSH_HOME） ───────────────────────── */

const kit = await import('../lib/kit.mjs')
const configMod = await import('../lib/config.js')
const stateMod = await import('../lib/state.js')
const modelsMod = await import('../lib/models.js')
const hubMod = await import('../lib/hub.js')
const routesMod = await import('../lib/routes.js')
const toolsMod = await import('../lib/tools.js')
const authzMod = await import('../lib/authz.js')
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
 * B. 配置规整 / 模型目录
 * ══════════════════════════════════════════════════════════ */

await t('B1 默认值只剩形象相关的几段', () => {
  const { value } = configMod.normalizeConfig({})
  assert.equal(value.enabled, true)
  assert.equal(value.live2d.width, 420)
  assert.equal(value.live2d.height, 560)
  assert.equal(value.live2d.model, '')
  assert.equal(value.security.mode, 'enforce')
  assert.equal(value.ui.showHint, true)
  // 旧版那些键不再是"本插件默认"，但旧配置里写了也会原样留着
  assert.equal(value.tts, undefined)
  assert.equal(value.camera, undefined)
})

await t('B2 越界/写错的项回落并留 warning；旧字段原样保留', () => {
  const { value, warnings } = configMod.normalizeConfig({
    live2d: { width: 1 },
    tts: { voice: 'old' },
    futureThing: { a: 1 },
  })
  assert.equal(value.live2d.width, 200)
  assert.deepEqual(value.tts, { voice: 'old' })
  assert.deepEqual(value.futureThing, { a: 1 })
  assert.ok(warnings.some((w) => w.includes('live2d.width')))
})

await t('B3 模型目录顺序：手填 > 自己的默认 > mira_live2d 的默认', () => {
  const miraRoot = join(SANDBOX, 'mira_config')
  const explicit = configMod.resolveModelsDir({ live2d: { modelsDir: '~/models' } }, miraRoot, { exists: () => true })
  assert.equal(explicit.source, 'config')
  assert.ok(explicit.dir.endsWith('models'))
  const none = configMod.resolveModelsDir({ live2d: { modelsDir: '' } }, miraRoot, { exists: () => false })
  assert.equal(none.source, 'own-default-missing')
  const shared = configMod.resolveModelsDir({ live2d: { modelsDir: '' } }, miraRoot, {
    exists: (dir) => String(dir).includes('mira_live2d'),
  })
  assert.equal(shared.source, 'mira_live2d-default')
})

await t('B4 publicConfig 不含路径', () => {
  const { value } = configMod.normalizeConfig({})
  value.configFile = '/x/config.json'
  const pub = configMod.publicConfig(value)
  assert.equal(pub.configFile, undefined)
  assert.equal(pub.live2d.modelsDir, undefined)
  assert.equal(pub.ui.showHint, true)
})

/* ══════════════════════════════════════════════════════════
 * C. 配置仓库
 * ══════════════════════════════════════════════════════════ */

await t('C1 首次 load 建文件；save 深合并并保留未知字段', () => {
  const dir = join(SANDBOX, 'cfg-1')
  const store = new configMod.ConfigStore({ baseDir: dir, patch: { live2d: { model: 'StellaMira' } } })
  const loaded = store.load()
  assert.equal(loaded.created, true)
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.live2d.model, 'StellaMira')
  raw.legacyThing = 'keep'
  writeFileSync(store.file, JSON.stringify(raw, null, 2))
  store.save({ live2d: { width: 512 } })
  const after = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(after.live2d.width, 512)
  assert.equal(after.legacyThing, 'keep')
  assert.equal(store.current().live2d.width, 512)
})

await t('C2 schemaVersion 不匹配：拒绝使用且不改原文件', () => {
  const dir = join(SANDBOX, 'cfg-2')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')
  const text = JSON.stringify({ schemaVersion: 99 }, null, 2)
  writeFileSync(file, text)
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {} })
  const loaded = store.load()
  assert.equal(loaded.error.code, 'config/schema')
  assert.throws(() => store.current(), /schemaVersion|版本/)
  assert.equal(readFileSync(file, 'utf8'), text)
})

/* ══════════════════════════════════════════════════════════
 * D. 状态仓库（只剩形象相关字段）
 * ══════════════════════════════════════════════════════════ */

await t('D1 默认状态：可见、无模型、无表情、无动作', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-1') })
  store.load()
  const state = store.get()
  assert.equal(state.visible, true)
  assert.equal(state.model, '')
  assert.equal(state.expression, '')
  assert.deepEqual(state.toggles, [])
  assert.equal(state.cameraOn, undefined, '摄像头开关属于 mira_input')
})

await t('D2 set 合并落盘、返回 changed；旧字段（cameraOn）被忽略', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-2') })
  store.load()
  const result = store.set({ model: 'SylviaMuse', motion: 'Idle#1', cameraOn: true }, { by: 'tool' })
  assert.deepEqual(result.changed.sort(), ['model', 'motion'])
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.model, 'SylviaMuse')
  assert.equal(raw.cameraOn, undefined)
})

await t('D3 旧 state.json 里的 camera/mic 字段被忽略、不报错', () => {
  const dir = join(SANDBOX, 'state-3')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    cameraOn: true,
    micOn: true,
    cameraSource: 'galaxy',
    visible: false,
    model: 'X',
  }))
  const store = new stateMod.StateStore({ baseDir: dir })
  const loaded = store.load()
  assert.equal(loaded.error, undefined)
  assert.equal(store.get().visible, false)
  assert.equal(store.get().model, 'X')
  assert.equal(store.get().cameraOn, undefined)
})

await t('D4 控制字符被清掉、toggles 去脏', () => {
  const store = new stateMod.StateStore({ baseDir: join(SANDBOX, 'state-4') })
  store.load()
  const result = store.set({ model: 'a\u0000b\nc', toggles: ['开关-帽子', '', null, 3] })
  assert.equal(result.state.model, 'abc')
  assert.deepEqual(result.state.toggles, ['开关-帽子', '3'])
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
  assert.equal(scanned.models[0].entry, 'SylviaMuse/SylviaMuse.model3.json')
})

await t('E2 capabilities：表情分类 + 动作组 + 缺资源诊断', () => {
  const caps = modelsMod.capabilities(MODELS_DIR, 'SylviaMuse')
  assert.deepEqual(caps.expressions.filter((e) => e.additive).map((e) => e.name), ['开关-帽子'])
  assert.deepEqual(caps.expressions.filter((e) => !e.additive).map((e) => e.name), ['表情-惊喜'])
  assert.deepEqual(caps.motions, ['Idle'])
  assert.ok(caps.missing.map((m) => m.file).includes('idle.motion3.json'))
})

await t('E3 找不到的模型 / 空目录：config/missing 并说清去哪配', () => {
  const empty = join(SANDBOX, 'models-empty')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => modelsMod.findModel(empty, ''), (error) => {
    assert.equal(error.code, 'config/missing')
    return true
  })
  assert.throws(() => modelsMod.findModel(MODELS_DIR, '不存在'), (error) => {
    assert.ok(String(error.hint).includes('SylviaMuse'))
    return true
  })
})

/* ══════════════════════════════════════════════════════════
 * F. SSE 总线
 * ══════════════════════════════════════════════════════════ */

await t('F1 attach 收 hello；broadcast 带 seq；dispose 后清空', () => {
  const hub = new hubMod.EventHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  assert.equal(hub.clientCount, 1)
  hub.broadcast('state', { state: { visible: false } })
  const frames = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  assert.equal(frames[0].type, 'hello')
  assert.equal(frames[1].type, 'state')
  assert.ok(frames[1].seq > frames[0].seq)
  hub.dispose()
  assert.equal(hub.clientCount, 0)
})

/* ══════════════════════════════════════════════════════════
 * G. HTTP 面
 * ══════════════════════════════════════════════════════════ */

async function makeDeps({ modelsDir = MODELS_DIR } = {}) {
  const base = join(SANDBOX, 'http-' + Math.random().toString(36).slice(2, 8))
  const configStore = new configMod.ConfigStore({ baseDir: base, patch: { live2d: { modelsDir } } })
  configStore.load()
  const stateStore = new stateMod.StateStore({ baseDir: base })
  stateStore.load()
  const counters = kit.makeCounters()
  const hub = new hubMod.EventHub({ counters })
  const catalog = {
    modelsDir: () => modelsDir,
    find: (name) => modelsMod.findModel(modelsDir, name),
    capabilities: (name) => modelsMod.capabilities(modelsDir, name),
    view: () => {
      const scanned = modelsMod.scanModels(modelsDir)
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
    hub,
    catalog,
    assetsDir: join(ROOT, 'assets'),
    logger: { info() {}, warn() {}, debug() {} },
    counters,
    audioStatus: () => FAKE_AUDIO.status(),
    inputStatus: () => FAKE_INPUT.status(),
  }
  deps.statusView = () => toolsMod.statusView(deps)
  const handler = routesMod.createHandler(deps)
  return { deps, handler, configStore, stateStore, hub, catalog }
}

async function call(handler, { method = 'GET', url = '/', headers = {}, body = null }) {
  const req = new FakeReq({ method, url, headers, body })
  const res = new FakeRes()
  const promise = handler(req, res)
  req.start()
  await promise
  return { res, json: res.json, text: res.text, status: res.status }
}

await t('G1 health / bootstrap：带模型清单、依赖就位、无采集口（采集口在输入侧）', async () => {
  const { handler, hub } = await makeDeps()
  const health = await call(handler, { url: '/vtuber/api/health' })
  assert.equal(health.status, 200)
  assert.equal(health.json.plugin, 'muse_vtuber')
  assert.equal(health.json.features.audio, true)
  assert.equal(health.json.features.input, true)
  assert.equal(health.json.features.capture, undefined, '采集口不该在形象侧')
  const boot = await call(handler, { url: '/vtuber/api/bootstrap' })
  assert.equal(boot.status, 200)
  assert.ok(boot.json.endpoints.events)
  assert.ok(Array.isArray(boot.json.models.models))
  assert.equal(boot.json.deps.audio, true)
  assert.equal(boot.json.config.live2d.modelsDir, undefined)
  hub.dispose()
})

await t('G2 跨站请求 403', async () => {
  const { handler, hub } = await makeDeps()
  const bad = await call(handler, { url: '/vtuber/api/bootstrap', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } })
  assert.equal(bad.status, 403)
  assert.equal(bad.json.error.code, 'http/forbidden')
  const ok = await call(handler, { url: '/vtuber/api/bootstrap', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } })
  assert.equal(ok.status, 200)
  hub.dispose()
})

await t('G3 POST /state：落盘 + 广播；clientId 记成 client:<id>', async () => {
  const { handler, stateStore, hub } = await makeDeps()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const out = await call(handler, { url: '/vtuber/api/state', method: 'POST', body: { visible: false, clientId: 'c-1' } })
  assert.equal(out.status, 200)
  assert.deepEqual(out.json.changed, ['visible'])
  assert.equal(out.json.by, 'client:c-1')
  assert.equal(stateStore.get().visible, false)
  assert.ok(res.text.includes('"type":"state"'))
  hub.dispose()
})

await t('G4 capabilities：表情分类与缺失资源', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/vtuber/api/capabilities?model=SylviaMuse' })
  assert.equal(out.status, 200)
  assert.ok(out.json.expressions.some((e) => e.additive))
  const missing = await call(handler, { url: '/vtuber/api/capabilities?model=没有这个' })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'config/missing')
  hub.dispose()
})

await t('G5 settings：只回 live2d；选模型 = 立即切换（改状态 + 广播）', async () => {
  const { handler, stateStore, hub } = await makeDeps()
  const view = await call(handler, { url: '/vtuber/api/settings' })
  assert.equal(view.status, 200)
  assert.equal(view.json.keyConfigured, true)
  assert.equal(view.text.includes('sk-'), false)
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const picked = await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { live2d: { model: 'SylviaMuse' } } },
  })
  assert.equal(picked.status, 200)
  assert.equal(picked.json.appliedModel, 'SylviaMuse')
  assert.equal(stateStore.get().model, 'SylviaMuse')
  assert.ok(res.text.includes('"type":"state"'))
  const cleared = await call(handler, {
    url: '/vtuber/api/settings',
    method: 'POST',
    body: { values: { live2d: { model: '' } } },
  })
  assert.equal(cleared.json.appliedModel, '')
  assert.equal(stateStore.get().model, '')
  hub.dispose()
})

await t('G6 静态资源可读；越界路径 403；模型文件可读', async () => {
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

await t('G7 未知接口：404 并指到 bootstrap', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/vtuber/api/nope' })
  assert.equal(out.status, 404)
  assert.ok(String(out.json.error.hint).includes('bootstrap'))
  hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * H. 工具
 * ══════════════════════════════════════════════════════════ */

async function makeToolEnv({ security = null, withAccount = true } = {}) {
  const base = join(SANDBOX, 'tools-' + Math.random().toString(36).slice(2, 8))
  const configStore = new configMod.ConfigStore({ baseDir: base, patch: { live2d: { modelsDir: MODELS_DIR } } })
  configStore.load()
  if (security) configStore.save({ security })
  const stateStore = new stateMod.StateStore({ baseDir: base })
  stateStore.load()
  const counters = kit.makeCounters()
  const hub = new hubMod.EventHub({ counters })
  const catalog = {
    modelsDir: () => MODELS_DIR,
    find: (name) => modelsMod.findModel(MODELS_DIR, name),
    capabilities: (name) => modelsMod.capabilities(MODELS_DIR, name),
    view: () => {
      const scanned = modelsMod.scanModels(MODELS_DIR)
      const local = stateStore.snapshot().model
      const current = local && scanned.models.some((m) => m.name === local) ? local : ''
      const caps = current ? modelsMod.capabilities(MODELS_DIR, current) : null
      return {
        dir: MODELS_DIR,
        dirSource: 'config',
        models: scanned.models.map((m) => ({ name: m.name, entry: m.entry })),
        current,
        expressions: caps ? caps.expressions : [],
        motions: caps ? caps.motions : [],
        missing: caps ? caps.missing : [],
      }
    },
  }
  const accounts = makeAccountBook()
  const authorizer = new authzMod.Authorizer({
    config: () => configStore.current(),
    account: () => (withAccount ? accounts : null),
  })
  const deps = {
    configStore,
    stateStore,
    hub,
    catalog,
    authorizer,
    assetsDir: join(ROOT, 'assets'),
    logger: { info() {}, warn() {}, debug() {} },
    counters,
    audioStatus: () => FAKE_AUDIO.status(),
    inputStatus: () => FAKE_INPUT.status(),
  }
  deps.statusView = () => toolsMod.statusView(deps)
  const ctx = makeCtx({ withAccount: false })
  const dispose = toolsMod.registerTools(ctx, deps)
  const clientRes = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), clientRes)
  return { ctx, deps, dispose, hub, registered: ctx.registered, stateStore, configStore, accounts, clientRes }
}

await t('H1 注册 5 个工具', async () => {
  const env = await makeToolEnv()
  assert.deepEqual([...env.registered.keys()].sort(), [...toolsMod.TOOL_NAMES].sort())
  assert.equal(toolsMod.TOOL_NAMES.length, 5)
  env.dispose()
  env.hub.dispose()
})

await t('H2 vtuber_status：只读、带模型清单/依赖状态/权限角色', async () => {
  const env = await makeToolEnv()
  const json = parse(await env.registered.get('vtuber_status').execute({}, execFor('sess-a')))
  assert.equal(json.ok, true)
  assert.equal(json.plugin, 'muse_vtuber')
  assert.ok(Array.isArray(json.models.models))
  assert.equal(json.audio.configured, true)
  assert.equal(json.input.state.cameraOn, true)
  assert.equal(json.security.role, 'none')
  assert.equal(JSON.stringify(json).includes('sk-'), false)
  env.dispose()
  env.hub.dispose()
})

await t('H3 vtuber_expression：未知表情先拦、状态不动；toggles/switch 工作', async () => {
  const env = await makeToolEnv()
  // 先选一个模型（没模型时表情工具会报 model/none）
  parse(await env.registered.get('vtuber_model').execute({ name: 'SylviaMuse' }, execFor()))
  const ok = parse(await env.registered.get('vtuber_expression').execute({ name: '表情-惊喜' }, execFor()))
  assert.equal(ok.ok, true)
  assert.equal(env.stateStore.get().expression, '表情-惊喜')
  const unknown = parse(await env.registered.get('vtuber_expression').execute({ name: '没有的表情' }, execFor()))
  assert.equal(unknown.error.code, 'expression/unknown')
  assert.ok(String(unknown.error.hint).includes('表情-惊喜'))
  assert.equal(env.stateStore.get().expression, '表情-惊喜', '状态必须原样不动')
  const toggled = parse(await env.registered.get('vtuber_expression').execute({ toggles: ['开关-帽子'] }, execFor()))
  assert.deepEqual(env.stateStore.get().toggles, ['开关-帽子'])
  const added = parse(await env.registered.get('vtuber_expression').execute({ switch: '开关-帽子', on: false }, execFor()))
  assert.deepEqual(added.toggles, [])
  void toggled
  env.dispose()
  env.hub.dispose()
})

await t('H4 vtuber_visible / vtuber_motion / vtuber_model：落状态并广播', async () => {
  const env = await makeToolEnv()
  const hide = parse(await env.registered.get('vtuber_visible').execute({ on: false }, execFor()))
  assert.equal(hide.visible, false)
  assert.equal(env.stateStore.get().visible, false)
  parse(await env.registered.get('vtuber_model').execute({ name: 'SylviaMuse' }, execFor()))
  const list = parse(await env.registered.get('vtuber_motion').execute({}, execFor()))
  assert.deepEqual(list.motions, ['Idle'])
  const played = parse(await env.registered.get('vtuber_motion').execute({ name: 'Idle' }, execFor()))
  assert.equal(played.ok, true)
  assert.ok(env.stateStore.get().motion.startsWith('Idle#'))
  const bad = parse(await env.registered.get('vtuber_motion').execute({ name: '不存在' }, execFor()))
  assert.equal(bad.error.code, 'motion/unknown')
  const cleared = parse(await env.registered.get('vtuber_model').execute({ clear: true }, execFor()))
  assert.equal(cleared.cleared, true)
  assert.equal(env.stateStore.get().model, '')
  assert.ok(env.clientRes.text.includes('"type":"state"'))
  env.dispose()
  env.hub.dispose()
})

await t('H5 没选模型时：表情/动作报 model/none，而不是拿清单第一个去校验', async () => {
  const env = await makeToolEnv()
  const expr = parse(await env.registered.get('vtuber_expression').execute({ name: '表情-惊喜' }, execFor()))
  assert.equal(expr.error.code, 'model/none')
  const motion = parse(await env.registered.get('vtuber_motion').execute({ name: 'Idle' }, execFor()))
  assert.equal(motion.error.code, 'model/none')
  env.dispose()
  env.hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * I. 「形象是一个账号」的权限
 * ══════════════════════════════════════════════════════════ */

await t('I1 没装 mira_account：控制类全禁止（authz/unavailable），status 不受影响', async () => {
  const env = await makeToolEnv({ withAccount: false })
  const json = parse(await env.registered.get('vtuber_visible').execute({ on: true }, execFor('sess-a')))
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'authz/unavailable')
  const status = parse(await env.registered.get('vtuber_status').execute({}, execFor('sess-a')))
  assert.equal(status.ok, true)
  assert.equal(status.security.available, false)
  env.dispose()
  env.hub.dispose()
})

await t('I2 首次控制自动认领 taker；别人占着报冲突；force 可抢', async () => {
  const env = await makeToolEnv({ security: { mode: 'enforce' } })
  const first = parse(await env.registered.get('vtuber_visible').execute({ on: true }, execFor('sess-a')))
  assert.equal(first.ok, true)
  assert.equal(env.accounts.resolve('vtuber-main', 'avatar', 'main').taker.sessionId, 'sess-a')
  const second = parse(await env.registered.get('vtuber_visible').execute({ on: false }, execFor('sess-b')))
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'authz/conflict')
  assert.ok(String(second.error.message).includes('sess-a'))
  const forced = parse(await env.registered.get('vtuber_visible').execute({ on: false, force: true }, execFor('sess-b')))
  assert.equal(forced.ok, true)
  assert.equal(env.accounts.resolve('vtuber-main', 'avatar', 'main').taker.sessionId, 'sess-b')
  env.dispose()
  env.hub.dispose()
})

await t('I3 security.mode=off：整体跳过（兜底开关）', async () => {
  const env = await makeToolEnv({ security: { mode: 'off' }, withAccount: false })
  const json = parse(await env.registered.get('vtuber_visible').execute({ on: true }, execFor('sess-x')))
  assert.equal(json.ok, true)
  const status = parse(await env.registered.get('vtuber_status').execute({}, execFor('sess-x')))
  assert.equal(status.security.mode, 'off')
  assert.equal(status.security.control, true)
  env.dispose()
  env.hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * J. 入口装配
 * ══════════════════════════════════════════════════════════ */

await t('J1 apply：注册 5 个工具 + /vtuber 路由，返回装配信息', () => {
  const ctx = makeCtx()
  try {
    const result = indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    assert.equal(result.ok, true)
    assert.equal(result.tools, 5)
    assert.equal(ctx.registered.size, 5)
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].path, '/vtuber')
    assert.equal(JSON.parse(readFileSync(result.configFile, 'utf8')).schemaVersion, 1)
    assert.ok(result.models >= 1)
    assert.equal(result.deps.audio, true)
    assert.equal(result.deps.input, true)
  } finally {
    ctx.dispose()
  }
})

await t('J2 第二个实例被拒；退场后可重新装配', () => {
  const ctx1 = makeCtx()
  const ctx2 = makeCtx()
  try {
    indexMod.apply(ctx1, { live2d: { modelsDir: MODELS_DIR } })
    const second = indexMod.apply(ctx2, {})
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'plugin/instance')
    assert.equal(ctx2.registered.size, 0)
  } finally {
    ctx1.dispose()
    ctx2.dispose()
  }
  const again = makeCtx()
  try {
    assert.equal(indexMod.apply(again, { live2d: { modelsDir: MODELS_DIR } }).ok, true)
  } finally {
    again.dispose()
  }
})

await t('J3 enabled=false：不注册任何东西并返回 plugin/disabled', () => {
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

await t('J4 依赖缺失（没有 miraAudio / miraInput 时 status 如实报，装配仍成功）', async () => {
  const ctx = makeCtx({ withAudio: false, withInput: false })
  try {
    const result = indexMod.apply(ctx, { live2d: { modelsDir: MODELS_DIR } })
    assert.equal(result.ok, true)
    assert.equal(result.deps.audio, false)
    assert.equal(result.deps.input, false)
    const status = parse(await ctx.registered.get('vtuber_status').execute({}, execFor('sess-z')))
    assert.equal(status.audio.available, false)
    assert.equal(status.input.available, false)
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * 收尾
 * ══════════════════════════════════════════════════════════ */

try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch { /* 临时目录清理失败不算失败 */ }

void BASE
if (failures.length) {
  console.log('\n---- 失败明细 ----')
  for (const failure of failures) console.log('· ' + failure)
  console.log('\n==== FAILED（' + pass + ' 过 / ' + failures.length + ' 败）====')
  process.exit(1)
}

console.log('\n==== ALL PASS（通过 ' + pass + ' 项断言）====')
