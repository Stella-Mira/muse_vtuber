/**
 * muse_vtuber / test/http-e2e.mjs —— 真起一个 HTTP 服务，端到端跑一遍形象的宿主面
 *
 * 与 smoke.mjs 的分工：smoke 用假 req/res 逐分支断言（快、覆盖全），这里用真的 http 服务器 +
 * 真的 fetch（含 SSE 流），验证「装配 → 路由 → 静态 → 状态广播 → 设置页」这条链路真的通。
 * 不联网：形象侧已经没有第三方调用了（TTS/ASR/识图都在 mira_audio / mira_input 里）。
 *
 * 跑法：node test/http-e2e.mjs        （退出码 0 = 全过）
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'muse-vtuber-e2e-'))
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')

let pass = 0
const failures = []
async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok  ' + name)
  } catch (error) {
    failures.push(name + '：' + (error && error.message ? error.message : String(error)))
    console.log('[FAIL] ' + name + '：' + (error && error.message ? error.message : String(error)))
  }
}

const kit = await import('../lib/kit.mjs')
const indexMod = await import('../lib/index.js')
const modelsMod = await import('../lib/models.js')

const BASE = kit.miraConfigDir('muse_vtuber')
const MODELS = join(SANDBOX, 'models')

/** 造一个最小可用的模型（只要 model3.json 与 moc/贴图能 stat 到）。 */
function makeModel(name) {
  const dir = join(MODELS, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tex.png'), Buffer.alloc(8))
  writeFileSync(join(dir, name + '.moc3'), Buffer.alloc(8))
  writeFileSync(join(dir, '表情-惊喜.exp3.json'), '{}')
  writeFileSync(join(dir, name + '.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: name + '.moc3',
      Textures: ['tex.png'],
      Expressions: [{ Name: '表情-惊喜', File: '表情-惊喜.exp3.json' }],
      Motions: { Idle: [{ File: 'idle.motion3.json' }] },
    },
  }, null, 2))
}
makeModel('SylviaMuse')

const FAKE_AUDIO = {
  status: () => ({ configured: true, tts: { enabled: true }, asr: { enabled: true }, vad: { silenceMs: 650 } }),
  vad: () => ({ threshold: 0.02, silenceMs: 650, minSpeechMs: 320, maxMs: 15000 }),
}
const FAKE_INPUT = {
  status: () => ({ ok: true, state: { cameraOn: false, micOn: false }, capture: { enabled: true, sources: [] } }),
}

function makeCtx() {
  const registered = new Map()
  const disposers = []
  let route = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => { route = null }
      },
    },
    get() {
      return undefined
    },
    miraAudio: FAKE_AUDIO,
    miraInput: FAKE_INPUT,
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    registered,
    routeOf: () => route,
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

const ctx = makeCtx()
const applied = indexMod.apply(ctx, { live2d: { modelsDir: MODELS } })
assert.equal(applied.ok, true, 'apply 应当成功')

const route = ctx.routeOf()
assert.ok(route && typeof route.handler === 'function', '应当注册了 /vtuber 路由')

const server = createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('handler threw: ' + (error && error.message))
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const ORIGIN = 'http://127.0.0.1:' + port
const realFetch = globalThis.fetch

console.log('服务已起：' + ORIGIN)

await t('E1 GET /vtuber/api/health → 200 且 ok:true', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/health')
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.plugin, 'muse_vtuber')
  assert.equal(json.features.audio, true)
})

await t('E2 GET /vtuber/api/bootstrap → 带 config/state/models/models/deps', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/bootstrap')
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.ok(json.config && json.config.live2d)
  assert.ok(json.state && json.state.visible === true)
  assert.ok(Array.isArray(json.models.models))
  assert.ok(json.models.models.some((m) => m.name === 'SylviaMuse'))
  assert.ok(json.endpoints.events)
  assert.equal(json.deps.audio, true)
})

await t('E3 POST /vtuber/api/state → 落盘（真文件）', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ model: 'SylviaMuse', visible: false }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(json.changed.sort(), ['model', 'visible'])
  const stateFile = JSON.parse(readFileSync(join(BASE, 'state.json'), 'utf8'))
  assert.equal(stateFile.model, 'SylviaMuse')
  assert.equal(stateFile.visible, false)
})

await t('E4 跨站 Origin → 403 http/forbidden', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ visible: true }),
  })
  const json = await response.json()
  assert.equal(response.status, 403)
  assert.equal(json.error.code, 'http/forbidden')
})

await t('E5 SSE /events → hello；POST /state 后收到 state 帧', async () => {
  const controller = new AbortController()
  const response = await realFetch(ORIGIN + '/vtuber/api/events', { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.ok(String(response.headers.get('content-type')).includes('text/event-stream'))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const readFrame = async (wantType, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = buffer.indexOf('\n\n')
      if (index >= 0) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (chunk.startsWith('data: ')) {
          const frame = JSON.parse(chunk.slice(6))
          if (frame.type === wantType) return frame
        }
        continue
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('SSE 流提前结束')
      buffer += decoder.decode(value, { stream: true })
    }
    throw new Error('等不到 ' + wantType + ' 帧（3 秒）')
  }
  const hello = await readFrame('hello')
  assert.equal(hello.type, 'hello')
  const posted = await realFetch(ORIGIN + '/vtuber/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ visible: true }),
  })
  assert.equal((await posted.json()).ok, true)
  const frame = await readFrame('state')
  assert.equal(frame.state.visible, true)
  controller.abort()
})

await t('E6 GET /vtuber/api/capabilities → 表情/动作清单', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/capabilities?model=SylviaMuse')
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.ok(json.expressions.some((e) => e.name === '表情-惊喜'))
  assert.deepEqual(json.motions, ['Idle'])
})

await t('E7 GET/POST /vtuber/api/settings → 选模型立即生效（真文件 + 广播）', async () => {
  // 先把正在显示的模型清掉（E3 已经设过 SylviaMuse），这样下面这次"选它"是真的切换
  await realFetch(ORIGIN + '/vtuber/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ model: '' }),
  })
  const before = await realFetch(ORIGIN + '/vtuber/api/settings')
  const view = await before.json()
  assert.equal(view.status === undefined ? 200 : view.status, 200)
  assert.ok(view.values.live2d)
  const response = await realFetch(ORIGIN + '/vtuber/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ values: { live2d: { model: 'SylviaMuse', width: 512 } } }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.appliedModel, 'SylviaMuse')
  const raw = JSON.parse(readFileSync(join(BASE, 'config.json'), 'utf8'))
  assert.equal(raw.live2d.width, 512)
})

await t('E8 静态资源：运行库与模型路由（真文件）', async () => {
  const lib = await realFetch(ORIGIN + '/vtuber/assets/lib/pixi.min.js')
  assert.equal(lib.status, 200)
  assert.ok(String(lib.headers.get('content-type')).includes('javascript'))
  const body = await lib.text()
  assert.ok(body.length > 100000, 'pixi 应当是真的运行库（>100KB）')
  const missing = await realFetch(ORIGIN + '/vtuber/assets/lib/nope.js')
  assert.equal(missing.status, 404)
  const model = await realFetch(ORIGIN + '/vtuber/models/SylviaMuse/SylviaMuse.model3.json')
  assert.equal(model.status, 200)
})

await t('E9 404：未知接口给 bootstrap 提示；旧接口（say/asr/vision）已经不在了', async () => {
  const unknown = await realFetch(ORIGIN + '/vtuber/api/nope')
  assert.equal(unknown.status, 404)
  const json = await unknown.json()
  assert.ok(String(json.error.hint).includes('bootstrap'))
  const say = await realFetch(ORIGIN + '/vtuber/api/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ text: 'x' }),
  })
  assert.equal(say.status, 404, 'say 已经搬到 /audio/api/say')
})

await t('E10 工具清单与模型清单一致（5 个）', async () => {
  assert.deepEqual([...ctx.registered.keys()].sort(), [...indexMod.__testing.TOOL_NAMES].sort())
  assert.equal(ctx.registered.size, 5)
  const caps = modelsMod.capabilities(MODELS, 'SylviaMuse')
  assert.equal(caps.model, 'SylviaMuse')
})

/* ── 收尾 ─────────────────────────────────────────────── */

await new Promise((done) => server.close(done))
ctx.dispose()
try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch { /* 忽略 */ }

if (failures.length) {
  console.log('\n---- 失败明细 ----')
  for (const failure of failures) console.log('· ' + failure)
  console.log('\n==== FAILED（' + pass + ' 过 / ' + failures.length + ' 败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + pass + ' 项端到端断言）====')
