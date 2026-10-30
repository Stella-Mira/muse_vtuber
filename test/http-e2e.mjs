/**
 * muse_vtuber / test/http-e2e.mjs —— 真起一个 HTTP 服务，端到端跑一遍宿主面
 *
 * 与 smoke.mjs 的分工：smoke 用假 req/res 逐分支断言（快、覆盖全），这里用真的 http 服务器 +
 * 真的 fetch（含 SSE 流），验证「装配 → 路由 → 静态 → 音频 → 事件流」这条链路真的通。
 * 阿里云接口不联网：只把 `https://dashscope.aliyuncs.com` 替换成假响应，本机地址仍走真 fetch。
 *
 * 跑法：node test/http-e2e.mjs        （退出码 0 = 全过）
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

/* ── 只替换第三方 MaaS（token-plan / dashscope），其它 fetch 保真 ───── */
const realFetch = globalThis.fetch
const AUDIO_BYTES = 96
const E2E_AUDIO_URL = 'https://fake-audio.invalid/e2e.wav'
const MAAS_HOST = /^https:\/\/(token-plan\.maas\.qianwenaiapi\.com|dashscope\.aliyuncs\.com)\//
const fakeAudio = (mime = 'audio/wav') => {
  const buffer = Buffer.alloc(AUDIO_BYTES, 9)
  return {
    ok: true,
    status: 200,
    headers: { get: () => mime },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => '',
    json: async () => ({}),
  }
}
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  // 合成出来的音频 URL（原生口要再 GET 一次）
  if (target.startsWith('https://fake-audio.invalid/')) return fakeAudio()
  if (MAAS_HOST.test(target)) {
    // 原生口合成：先回 audio.url
    if (target.endsWith('/services/audio/tts/SpeechSynthesizer')) {
      const payload = { output: { finish_reason: 'stop', audio: { data: '', url: E2E_AUDIO_URL, id: 'audio_e2e' } }, usage: { characters: 5 } }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }
    }
    if (target.endsWith('/audio/speech')) return fakeAudio('audio/mpeg')
    // OpenAI 兼容识别口（asr.provider=openai 时）
    if (target.endsWith('/audio/transcriptions')) {
      const payload = { text: '你好，我听到你了' }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }
    }
    if (target.includes('/multimodal-generation/generation')) {
      let isAudio = false
      try {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : (options.body || {})
        const s = JSON.stringify(body.input || {})
        isAudio = s.includes('input_audio') || s.includes('"audio"')
      } catch { /* multipart 之类的不在这里 */ }
      const text = isAudio ? '你好，我听到你了' : '画面里有一个人坐在书桌前。'
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ output: { text, choices: [{ message: { content: text } }] } }),
        text: async () => JSON.stringify({ output: { text, choices: [{ message: { content: text } }] } }),
      }
    }
  }
  return realFetch(url, options)
}

const kit = await import('../lib/kit.mjs')
const indexMod = await import('../lib/index.js')

const BASE = kit.miraConfigDir('muse_vtuber')
const steerReceived = []

function makeCtx() {
  const registered = new Map()
  const disposers = []
  let route = null
  const agent = {
    session: { id: 'sess-e2e' },
    steer(message) {
      steerReceived.push(message)
    },
  }
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
        return () => {
          route = null
        }
      },
      tapIndex() {
        return () => {}
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        return String(sessionId) === 'sess-e2e' ? { agent } : { error: { code: 'session/not-found', message: 'no' } }
      },
    },
    sessions: { async flush() {} },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    agents: new Map(),
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
const applied = indexMod.apply(ctx, { live2d: { modelsDir: join(SANDBOX, 'no-model-dir') } })
assert.equal(applied.ok, true, 'apply 应当成功')

// 写一个 key，让 TTS/ASR/识图都可用
const aliyun = applied && applied.configFile
  ? null
  : null
void aliyun
const { AliyunService } = await import('../lib/aliyun.js')
new AliyunService({ config: {}, baseDir: BASE, configFile: join(BASE, 'config.json') }).writeCreds({ apiKey: 'sk-e2e' })

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

console.log('服务已起：' + ORIGIN)

await t('E1 GET /vtuber/api/health → 200 且 ok:true', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/health')
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.plugin, 'muse_vtuber')
})

await t('E2 GET /vtuber/api/bootstrap → 带 config/state/models/features', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/bootstrap')
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.ok(json.config && json.config.live2d)
  assert.ok(json.state && json.state.cameraOn === false)
  assert.ok(json.features && json.features.configured === true)
  assert.ok(json.endpoints.events)
})

await t('E3 POST /vtuber/api/state → 落盘（真文件）', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ cameraOn: true, micOn: true }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(json.changed.sort(), ['cameraOn', 'micOn'])
  const stateFile = JSON.parse(readFileSync(join(BASE, 'state.json'), 'utf8'))
  assert.equal(stateFile.cameraOn, true)
  assert.equal(stateFile.micOn, true)
})

await t('E4 跨站 Origin → 403 http/forbidden', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ cameraOff: true }),
  })
  const json = await response.json()
  assert.equal(response.status, 403)
  assert.equal(json.error.code, 'http/forbidden')
})

await t('E5 SSE /events → 收到 hello，然后 POST /say 能收到 say 帧', async () => {
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
  const said = await realFetch(ORIGIN + '/vtuber/api/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ text: '端到端测试' }),
  })
  const sayJson = await said.json()
  assert.equal(sayJson.ok, true)
  const frame = await readFrame('say')
  assert.equal(frame.text, '端到端测试')
  assert.equal(frame.url, sayJson.url)
  controller.abort()
})

await t('E6 GET 音频 → 真二进字（与假供应商给的字节数一致）', async () => {
  const listed = await realFetch(ORIGIN + '/vtuber/api/bootstrap')
  const boot = await listed.json()
  assert.equal(boot.ok, true)
  const said = await realFetch(ORIGIN + '/vtuber/api/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ text: '再测一次' }),
  })
  const say = await said.json()
  assert.equal(say.ok, true)
  const audio = await realFetch(ORIGIN + say.url)
  assert.equal(audio.status, 200)
  assert.equal(audio.headers.get('content-type'), 'audio/wav', '原生口合成出来是 WAV')
  const bytes = Buffer.from(await audio.arrayBuffer())
  assert.equal(bytes.length, AUDIO_BYTES)
})

await t('E7 POST /asr → 识别文本 + steer 进会话（真 SSE 之外的整链路）', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/asr', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ base64: 'AAAA', mime: 'audio/wav', sessionId: 'sess-e2e', auto: true }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.text, '你好，我听到你了')
  assert.equal(json.steered, true)
  const message = steerReceived.at(-1)
  assert.equal(message.source.kind, 'muse_vtuber')
  assert.ok(message.content[0].text.includes('你好，我听到你了'))
})

await t('E8 POST /vision → 识图文本进会话', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/vision', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,AAAA', sessionId: 'sess-e2e' }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.text, '画面里有一个人坐在书桌前。')
  assert.equal(steerReceived.at(-1).meta.percept, 'vision')
})

await t('E9 GET /settings → keyConfigured=true 且响应里没有 key 明文', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/settings')
  const text = await response.text()
  assert.equal(response.status, 200)
  assert.ok(text.includes('"keyConfigured":true'))
  assert.equal(text.includes('sk-e2e'), false)
})

await t('E10 POST /settings → 写回 config.json（真文件）', async () => {
  const response = await realFetch(ORIGIN + '/vtuber/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ values: { tts: { voice: 'Serena' }, events: { maxPerMin: 9 } } }),
  })
  const json = await response.json()
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  const raw = JSON.parse(readFileSync(join(BASE, 'config.json'), 'utf8'))
  assert.equal(raw.tts.voice, 'Serena')
  assert.equal(raw.events.maxPerMin, 9)
})

await t('E11 静态资源：运行库与模型路由', async () => {
  const lib = await realFetch(ORIGIN + '/vtuber/assets/lib/pixi.min.js')
  assert.equal(lib.status, 200)
  assert.ok(String(lib.headers.get('content-type')).includes('javascript'))
  const body = await lib.text()
  assert.ok(body.length > 100000, 'pixi 应当是真的运行库（>100KB）')
  const missing = await realFetch(ORIGIN + '/vtuber/assets/lib/nope.js')
  assert.equal(missing.status, 404)
})

await t('E12 大请求体：8MB 音频不 413（上限 16MB）', async () => {
  const big = 'A'.repeat(8 * 1024 * 1024)
  const response = await realFetch(ORIGIN + '/vtuber/api/asr', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ base64: big, mime: 'audio/wav', sessionId: 'sess-e2e', auto: false }),
  })
  const json = await response.json()
  assert.equal(response.status, 200, JSON.stringify(json))
  assert.equal(json.steered, false, 'auto:false 不该插话')
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
