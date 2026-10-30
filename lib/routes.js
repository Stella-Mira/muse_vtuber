/**
 * muse_vtuber / routes.js —— 宿主侧的 HTTP 面（`/vtuber/api/*` + 静态资源）
 *
 * 为什么用 webServer 路由而不是 HTTP 之外的通道：前端两处（形象页签、输入框按钮、设置页）
 * 都在同一个浏览器页里，而宿主侧要落盘、要调阿里云、要 steer 会话 —— 走同源 HTTP 最直接，
 * 且能被自检用假 req/res 覆盖（mira_live2d 也是这套）。
 *
 * 安全：所有 /vtuber/api/* 只接受同源请求（这些接口能改状态、烧 TTS 额度、往会话里插话）。
 *
 * 数据流（一眼看懂）：
 *   浏览器 → 宿主：bootstrap / state / asr / vision / result / settings
 *   宿主 → 浏览器：events（SSE：state / say / command）
 *   音频：宿主合成完放 AudioStore（内存 + TTL），浏览器用 /vtuber/api/audio/<id> 播
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { MiraError, fail, okObj, toError } from './kit.mjs'
import { publicConfig } from './config.js'
import { publicCapabilities } from './models.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.exp3': 'application/json; charset=utf-8',
}

export const AUDIO_LIMIT = 32
export const AUDIO_TTL_MS = 10 * 60 * 1000

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

export function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
}

/**
 * 同源守卫：`Sec-Fetch-Site: cross-site` 一律拒；`Origin` 与 `Host` 不同源一律拒；
 * 没有 `Origin` 的本地客户端（curl / 自检）放行。
 */
export function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const rawOrigin = headers.origin
  if (rawOrigin === undefined || rawOrigin === null) return true
  const origin = String(rawOrigin).trim()
  if (origin === '') return true
  if (origin.toLowerCase() === 'null') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = String(headers.host || '').trim().toLowerCase()
  if (host === '') return false
  return parsed.host.toLowerCase() === host
}

export function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let finished = false
    const done = (value) => {
      if (finished) return
      finished = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        done({
          ok: false,
          status: 413,
          error: {
            code: 'payload/too-large',
            message: '请求体超过上限 ' + maxBytes + ' 字节',
            hint: '音频/图像请缩短或降分辨率；常规 API 请求应小于 64 KiB',
          },
        })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        done({ ok: true, value: {} })
        return
      }
      try {
        done({ ok: true, value: JSON.parse(raw) })
      } catch {
        done({
          ok: false,
          status: 400,
          error: { code: 'payload/invalid', message: '请求体不是合法 JSON', hint: '用 Content-Type: application/json 并检查拼写' },
        })
      }
    })
    req.on('error', (error) => {
      done({
        ok: false,
        status: 400,
        error: { code: 'payload/read-failed', message: '读取请求体失败：' + (error?.message || error), hint: '重试' },
      })
    })
  })
}

/** TTS 音频暂存（内存，带上限与 TTL）：浏览器用 <audio src> 播，避免把 base64 塞进 SSE 帧。 */
export class AudioStore {
  constructor({ limit = AUDIO_LIMIT, ttlMs = AUDIO_TTL_MS } = {}) {
    this.limit = limit
    this.ttlMs = ttlMs
    this.items = new Map()
    this.seq = 0
  }

  put(buffer, mime) {
    this.prune()
    this.seq += 1
    const id = Date.now().toString(36) + '-' + this.seq.toString(36)
    this.items.set(id, { buffer, mime, at: Date.now() })
    while (this.items.size > this.limit) {
      const oldest = this.items.keys().next().value
      this.items.delete(oldest)
    }
    return id
  }

  get(id) {
    this.prune()
    return this.items.get(String(id || '')) || null
  }

  prune() {
    const now = Date.now()
    for (const [id, item] of this.items) {
      if (now - item.at > this.ttlMs) this.items.delete(id)
    }
  }

  status() {
    return { size: this.items.size, limit: this.limit, ttlMs: this.ttlMs }
  }
}

const close = (fn) => {
  try {
    fn?.()
  } catch {
    /* 退场不抛 */
  }
}

/* ── 静态文件 ───────────────────────────────────────────── */

async function serveStaticFrom(root, relPath, res) {
  const rootAbs = resolve(root)
  const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => part === '..' || part.includes('\u0000'))) {
    send(res, 403, 'forbidden')
    return
  }
  const full = resolve(rootAbs, ...parts)
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    send(res, 403, 'forbidden')
    return
  }
  try {
    const buf = await readFile(full)
    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(buf)
  } catch {
    send(res, 404, 'not found')
  }
}

/* ── 主处理器 ───────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {object} deps.stateStore
 * @param {() => object} deps.aliyun  每次取新的（配置热加载后要跟着换）
 * @param {object} deps.hub
 * @param {object} deps.catalog       { scan, capabilities, modelsDir }
 * @param {object} deps.audioStore
 * @param {string} deps.assetsDir
 * @param {object} [deps.logger]
 * @param {object} [deps.counters]
 */
export function createHandler(deps) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://x')
    } catch {
      send(res, 400, 'bad url')
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      pathname = url.pathname
    }
    if (pathname.startsWith('/vtuber/api/')) return handleApi(pathname, url, req, res, deps)
    if (pathname.startsWith('/vtuber/assets/')) {
      return serveStaticFrom(deps.assetsDir, pathname.slice('/vtuber/assets/'.length), res)
    }
    if (pathname.startsWith('/vtuber/models/')) {
      return serveStaticFrom(deps.catalog.modelsDir(), pathname.slice('/vtuber/models/'.length), res)
    }
    send(res, 404, 'not found')
  }
}

async function handleApi(pathname, url, req, res, deps) {
  const sub = pathname.slice('/vtuber/api/'.length)
  const method = (req.method || 'GET').toUpperCase()

  if (!isSameOriginRequest(req)) {
    return sendJson(res, 403, fail('http/forbidden',
      '拒绝跨站请求：/vtuber/api/' + sub + ' 只接受同源请求',
      '这些接口能改状态、烧 TTS 额度、往会话里插话；别的站点不能调用'))
  }

  // 配置坏了：除了 settings（要能把「为什么不可用」显示出来）与 health，其余一律拒
  let cfg = null
  let configError = null
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error)
    if (sub !== 'settings' && sub !== 'health') return sendJson(res, 503, configError)
  }

  if (sub === 'health' && method === 'GET') {
    const capture = deps.captureHub ? deps.captureHub.status() : null
    return sendJson(res, 200, okObj({
      plugin: 'muse_vtuber',
      clients: deps.hub.clientCount,
      configError,
      configFile: deps.configStore.file,
      stateFile: deps.stateStore.file,
      audio: deps.audioStore.status(),
      // 采集器探测：muse_galaxy 用它判断 vtuber 侧是否实现了采集口
      features: {
        capture: capture
          ? { open: true, frame: true, pcm: true, close: true, ping: true, stream: true, enabled: capture.enabled }
          : null,
      },
      capture,
    }))
  }

  if (sub === 'bootstrap' && method === 'GET') {
    const stateView = safeState(deps)
    let models = null
    let modelsError = null
    try {
      models = deps.catalog.view()
    } catch (error) {
      modelsError = toError(error).error
    }
    return sendJson(res, 200, okObj({
      config: cfg ? publicConfig(cfg) : null,
      state: stateView.state,
      stateError: stateView.error,
      models,
      modelsError,
      features: deps.aliyun().status(),
      configError,
      configFile: deps.configStore.file,
      stateFile: deps.stateStore.file,
      endpoints: {
        events: '/vtuber/api/events',
        state: '/vtuber/api/state',
        asr: '/vtuber/api/asr',
        vision: '/vtuber/api/vision',
        say: '/vtuber/api/say',
        result: '/vtuber/api/result',
        settings: '/vtuber/api/settings',
        models: '/vtuber/models/',
        assets: '/vtuber/assets/',
        capture: '/vtuber/api/capture/open',
        stream: '/vtuber/api/stream.mjpg',
      },
    }))
  }

  /* ── 外部采集器（muse_galaxy 等）：虚拟摄像头 / 虚拟麦克风 ──────────────
   *
   * 分工见任务书 muse_galaxy 一节：采集端只负责"取到画面和声音"；
   * 取帧策略（vision.autoIntervalMs）、断句阈值（mic.vad）、识别、限流、插话全在本插件。
   * 这些接口能往形象里喂画面和声音（等于能"喂话"），所以**只接受本机回环 + capture 令牌**。
   */
  if (sub === 'capture/open' || sub === 'capture/frame' || sub === 'capture/pcm'
    || sub === 'capture/close' || sub === 'capture/ping') {
    if (method !== 'POST') {
      return sendJson(res, 405, fail('http/method', '采集口只接受 POST', '读取画面请用 GET /vtuber/api/stream.mjpg'))
    }
    if (!deps.captureHub) return sendJson(res, 503, fail('capture/absent', '采集器未装配', '升级插件或看启动日志'))
    const denied = deps.captureHub.authorize(req)
    if (denied) return sendJson(res, denied.status, { ok: false, error: denied.error })
    if (cfg && cfg.capture && cfg.capture.enabled === false) {
      return sendJson(res, 503, fail('config/missing', '采集器已关闭：capture.enabled=false',
        '在设置页打开，或把 config.json 的 capture.enabled 改成 true'))
    }
    const parsed = await readJsonBody(req, 8 * 1024 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const body = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
    try {
      if (sub === 'capture/open') {
        // 往形象里喂画面/声音 = 「接收」权限：observer 或 taker 都行
        //（security.mode='off' 时整体跳过；令牌只证明"能进这个口"，不证明"有资格用形象"）
        const gate = deps.authorizer
          ? deps.authorizer.requireReceive(String(body.sessionId || '').trim(), { tool: 'capture/open' })
          : { ok: true }
        if (!gate.ok) return sendJson(res, 403, { ok: false, error: gate.error })
        const opened = deps.captureHub.open(body)
        return sendJson(res, 200, okObj({
          captureId: opened.captureId,
          want: opened.want,
          reused: opened.reused,
          selected: opened.selected,
          cameraUrl: '/vtuber/api/stream.mjpg?capture=' + opened.captureId,
          events: '/vtuber/api/events',
        }))
      }
      if (sub === 'capture/frame') {
        const out = deps.captureHub.frame(body.captureId, body.jpeg ?? body.image ?? body.dataUrl)
        return sendJson(res, 200, okObj(out))
      }
      if (sub === 'capture/pcm') {
        const out = deps.captureHub.pcm(body.captureId, body.pcm ?? body.base64, body.sampleRate)
        return sendJson(res, 200, okObj(out))
      }
      if (sub === 'capture/close') {
        return sendJson(res, 200, okObj(deps.captureHub.close(body.captureId, String(body.reason || 'closed'))))
      }
      return sendJson(res, 200, okObj(deps.captureHub.ping(body.captureId)))
    } catch (error) {
      const normalized = toError(error)
      const code = normalized.error.code
      const status = code === 'capture/not-found' ? 404
        : code === 'capture/frame-too-big' ? 413
          : code === 'capture/forbidden' ? 403
            : 400
      return sendJson(res, status, normalized)
    }
  }

  // 面板显示：multipart JPEG（浏览器一个 <img> 就能播）。只读，走同源校验即可。
  if (sub === 'stream.mjpg' && method === 'GET') {
    if (!deps.captureHub) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no capture')
      return undefined
    }
    return deps.captureHub.attachMjpeg(req, res, url.searchParams.get('capture'))
  }

  if (sub === 'capabilities' && method === 'GET') {
    const model = String(url.searchParams.get('model') || '').trim()
    try {
      const caps = deps.catalog.capabilities(model)
      return sendJson(res, 200, okObj(publicCapabilities(caps)))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'events' && method === 'GET') {
    deps.hub.attach(req, res)
    return undefined
  }

  if (sub === 'state' && method === 'GET') {
    const view = safeState(deps)
    return sendJson(res, view.error ? 503 : 200, view.error ? { ok: false, error: view.error } : okObj({ state: view.state }))
  }

  if (sub === 'state' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    try {
      const body = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
      // 记下是哪个页面改的：多设备时只有发起方该去动本机摄像头/麦克风（见 lib/client.js applyHostState）
      const clientId = String(body.clientId ?? '').slice(0, 64)
      const by = clientId ? 'client:' + clientId : 'client'
      const result = deps.stateStore.set(body, { by })
      if (result.changed.length) {
        deps.hub.broadcast('state', { state: result.state, changed: result.changed, by })
      }
      return sendJson(res, 200, okObj({ state: result.state, changed: result.changed, by }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'result' && method === 'POST') {
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const outcome = deps.hub.resolveResult(parsed.value || {})
    return sendJson(res, outcome.ok ? 200 : 404, outcome)
  }

  if (sub === 'say' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const text = String(parsed.value?.text ?? '')
    const voice = String(parsed.value?.voice ?? '')
    try {
      return sendJson(res, 200, await speak(deps, cfg, text, voice))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'asr' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 16 * 1024 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const value = parsed.value || {}
    try {
      const service = deps.aliyun()
      const outcome = await service.transcribe({
        base64: String(value.base64 ?? value.audio ?? ''),
        mime: String(value.mime || 'audio/wav'),
        // 原生识别口要 sample_rate（浏览器是按 mic.sampleRate 录的）
        sampleRate: Number(value.sampleRate) || 0,
      })
      const auto = value.auto !== false
      const sessionId = String(value.sessionId ?? '')
      // 自动事件流（auto:true，界面里连续识别）→ 按 events 配置投递；
      // 显式调用（auto:false）默认**只回文本**，要投递必须再传 steer:true。
      const wantSteer = auto || value.steer === true
      let steer = null
      if (outcome.text !== '' && wantSteer) {
        steer = await deps.hub.perceive({ kind: 'voice', text: outcome.text, sessionId, auto })
      }
      return sendJson(res, 200, okObj({
        text: outcome.text,
        model: outcome.model,
        chars: Array.from(outcome.text).length,
        durationMs: Number(value.durationMs) || 0,
        steered: steer ? steer.delivered === true : false,
        steer: steer && steer.reason ? { reason: steer.reason } : undefined,
      }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'vision' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 16 * 1024 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const value = parsed.value || {}
    try {
      const service = deps.aliyun()
      const outcome = await service.describeImage({
        dataUrl: String(value.image ?? ''),
        prompt: String(value.prompt ?? ''),
      })
      const auto = value.auto !== false
      const sessionId = String(value.sessionId ?? '')
      const wantSteer = auto || value.steer === true
      let steer = null
      if (outcome.text !== '' && wantSteer) {
        steer = await deps.hub.perceive({ kind: 'vision', text: outcome.text, sessionId, auto })
      }
      return sendJson(res, 200, okObj({
        text: outcome.text,
        model: outcome.model,
        chars: Array.from(outcome.text).length,
        steered: steer ? steer.delivered === true : false,
        steer: steer && steer.reason ? { reason: steer.reason } : undefined,
      }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'settings' && method === 'GET') {
    return sendJson(res, 200, buildSettingsView(deps))
  }

  if (sub === 'settings' && method === 'POST') {
    if (configError) return sendJson(res, 503, configError)
    const parsed = await readJsonBody(req, 256 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    try {
      return sendJson(res, 200, writeSettings(deps, parsed.value || {}))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub.startsWith('audio/') && method === 'GET') {
    const id = sub.slice('audio/'.length)
    const item = deps.audioStore.get(id)
    if (!item) {
      return sendJson(res, 404, fail('audio/not-found', '音频不存在或已过期：' + id,
        'TTS 音频只在内存里保留 10 分钟；让模型重新说一次'))
    }
    res.writeHead(200, {
      'content-type': item.mime || 'audio/mpeg',
      'content-length': item.buffer.length,
      'cache-control': 'private, max-age=600',
    })
    res.end(item.buffer)
    return undefined
  }

  sendJson(res, 404, fail('http/not-found', '未知接口：/vtuber/api/' + sub, '见 GET /vtuber/api/bootstrap 的 endpoints'))
  return undefined
}

/** 合成 + 广播：工具与 HTTP 共用这一条路径（口型/气泡/播放都在浏览器侧）。 */
export async function speak(deps, cfg, text, voice = '') {
  const outcome = await deps.aliyun().synthesize(text, { voice })
  const id = deps.audioStore.put(Buffer.from(outcome.base64, 'base64'), outcome.mime)
  const url = '/vtuber/api/audio/' + id
  const clients = deps.hub.broadcast('say', {
    text: String(text ?? ''),
    url,
    id,
    mime: outcome.mime,
    chars: outcome.chars,
    truncated: outcome.truncated,
    voice: outcome.voice,
  })
  deps.logger?.info?.('[muse_vtuber] 朗读 ' + outcome.chars + ' 字（' + outcome.voice + '），送达 '
    + clients + ' 个页面' + (outcome.truncated ? '（已按 tts.maxChars 截断）' : ''))
  return okObj({
    text: String(text ?? ''),
    chars: outcome.chars,
    requestedChars: outcome.requestedChars,
    truncated: outcome.truncated,
    voice: outcome.voice,
    model: outcome.model,
    url,
    clients,
  })
}

function safeState(deps) {
  try {
    return { state: deps.stateStore.get(), error: null }
  } catch (error) {
    return { state: deps.stateStore.snapshot(), error: toError(error).error }
  }
}

/** 设置页 GET：只回可编辑项 + 「key 配没配」，永不回 key。 */
export function buildSettingsView(deps) {
  const status = deps.configStore.status()
  let cfg = null
  let configError = status.error
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error).error
  }
  const effective = cfg || deps.configStore.cache || null
  const aliyun = deps.aliyun()
  const creds = aliyun.readCreds()
  const view = {
    ok: true,
    configFile: deps.configStore.file,
    credsFile: aliyun.credsFile,
    keyConfigured: !!(creds.ok && typeof creds.value?.apiKey === 'string' && creds.value.apiKey.trim() !== ''),
    keyMode: creds.ok ? (creds.mode === -1 ? null : '0o' + creds.mode.toString(8)) : null,
    warnings: status.warnings.slice(),
    configError: configError || null,
  }
  if (!creds.ok) view.credsError = creds.error
  if (effective) {
    // 下拉框要显示**正在显示的那个模型**（state.model 优先，其次 config.live2d.model），
    // 否则设置页永远显示空/旧值，看起来像"选了没反应"。
    let shownModel = String(effective.live2d.model || '')
    try {
      shownModel = deps.catalog.view().current || shownModel
    } catch { /* 模型目录扫不出来就用配置值 */ }
    view.values = {
      live2d: {
        modelsDir: effective.live2d.modelsDir,
        model: shownModel,
        width: effective.live2d.width,
        height: effective.live2d.height,
      },
      camera: { ...effective.camera },
      mic: { ...effective.mic, vad: { ...effective.mic.vad } },
      tts: {
        enabled: effective.tts.enabled,
        provider: effective.tts.provider,
        base: effective.tts.base,
        model: effective.tts.model,
        voice: effective.tts.voice,
        maxChars: effective.tts.maxChars,
      },
      asr: {
        enabled: effective.asr.enabled,
        provider: effective.asr.provider,
        base: effective.asr.base,
        model: effective.asr.model,
        language: effective.asr.language,
      },
      vision: {
        enabled: effective.vision.enabled,
        provider: effective.vision.provider,
        base: effective.vision.base,
        model: effective.vision.model,
        prompt: effective.vision.prompt,
        autoIntervalMs: effective.vision.autoIntervalMs,
      },
      events: {
        enabled: effective.events.enabled,
        steer: effective.events.steer,
        minIntervalMs: effective.events.minIntervalMs,
        maxPerMin: effective.events.maxPerMin,
        cooldownKeyMs: effective.events.cooldownKeyMs,
        voiceTemplate: effective.events.voiceTemplate,
        visionTemplate: effective.events.visionTemplate,
      },
    }
    try {
      view.runtime = { models: deps.catalog.view() }
    } catch (error) {
      view.runtime = { modelsError: toError(error).error }
    }
  }
  return view
}

/** 设置页 POST：白名单字段深合并写回 config.json；apiKey 单独写 600 凭据文件。 */
export function writeSettings(deps, body) {
  const values = body && typeof body === 'object' && body.values && typeof body.values === 'object'
    ? body.values
    : body
  const patch = pickSettings(values)
  const changed = []
  const before = deps.configStore.current()
  const after = deps.configStore.save(patch)
  for (const key of Object.keys(patch)) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after.value?.[key])) changed.push(key)
  }
  let keyWritten = false
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey !== '') {
    deps.aliyun().writeCreds({ apiKey })
    keyWritten = true
    changed.push('tts/asr/vision key')
    deps.logger?.info?.('[muse_vtuber] 阿里云 API key 已更新（写 ' + deps.aliyun().credsFile + '，600）')
  }
  const view = buildSettingsView(deps)
  // 设置页里的「模型」= 运行期就要换：写进 config 只是"下次默认"，
  // 这里顺手改一次运行状态并广播，前端 applyHostState 收到就切模型。
  // 传空串是**显式不显示模型**（只留频谱环），所以空白值也要落状态。
  let appliedModel = null
  const modelTouched = !!(patch.live2d && typeof patch.live2d.model === 'string')
  if (modelTouched) {
    const wantedModel = String(patch.live2d.model || '').trim()
    try {
      const target = wantedModel === '' ? '' : deps.catalog.find(wantedModel).name
      if (String(deps.stateStore.snapshot().model || '') !== target) {
        const result = deps.stateStore.set({ model: target }, { by: 'tool' })
        if (result.changed.length) deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
        appliedModel = target
        deps.logger?.info?.('[muse_vtuber] 设置页切换模型 → ' + (target || '（不显示）'))
      }
    } catch (error) {
      // 名字不对：配置照写（下次默认），切换失败要如实回报，不假装成功
      return okObj({ ...buildSettingsView(deps), changed, keyWritten, appliedModel: null, modelError: toError(error).error })
    }
  }
  return okObj({ ...view, changed, keyWritten, appliedModel })
}

const SETTINGS_SHAPE = {
  live2d: ['modelsDir', 'model', 'width', 'height'],
  camera: ['enabled', 'deviceId', 'width', 'height'],
  mic: ['enabled', 'deviceId', 'sampleRate'],
  tts: ['enabled', 'provider', 'base', 'model', 'voice', 'maxChars', 'timeoutMs'],
  asr: ['enabled', 'provider', 'base', 'model', 'language', 'timeoutMs'],
  vision: ['enabled', 'provider', 'base', 'model', 'prompt', 'timeoutMs', 'autoIntervalMs'],
  events: ['enabled', 'steer', 'minIntervalMs', 'maxPerMin', 'cooldownKeyMs', 'voiceTemplate', 'visionTemplate', 'maxChars'],
}

/** 只收设置页认得的字段（其余一律忽略，避免前端把 runtime 字段写进配置）。 */
export function pickSettings(values) {
  const patch = {}
  if (!values || typeof values !== 'object') return patch
  for (const [group, keys] of Object.entries(SETTINGS_SHAPE)) {
    const source = values[group]
    if (!source || typeof source !== 'object') continue
    const target = {}
    for (const key of keys) {
      if (source[key] !== undefined) target[key] = source[key]
    }
    if (group === 'mic' && source.vad && typeof source.vad === 'object') {
      const vad = {}
      for (const key of ['threshold', 'silenceMs', 'minSpeechMs', 'maxMs']) {
        if (source.vad[key] !== undefined) vad[key] = source.vad[key]
      }
      if (Object.keys(vad).length) target.vad = vad
    }
    if (Object.keys(target).length) patch[group] = target
  }
  return patch
}

export { close, MiraError, publicConfig }
