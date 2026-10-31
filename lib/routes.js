/**
 * muse_vtuber / routes.js —— 宿主侧的 HTTP 面（`/vtuber/api/*` + 静态资源）
 *
 * 拆分之后这里只剩**形象自己**的事：模型清单/资源诊断、可见性与表情动作状态、设置页、
 * 静态运行库与模型文件。声音（say/asr）在 `/media/api/*`，输入（state/asr/vision/capture）
 * 在 `/device/api/*`。
 *
 * 安全：所有 /vtuber/api/* 只接受同源请求（这些接口能改形象状态、换模型）。
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { fail, okObj, toError } from './kit.mjs'
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

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

export function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
}

/** 同源守卫：`Sec-Fetch-Site: cross-site` 一律拒；`Origin` 与 `Host` 不同源一律拒；无 Origin 放行。 */
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
            hint: '形象状态与设置都是小请求；大文件请走音频/输入插件',
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
 * @param {object} deps.hub
 * @param {object} deps.catalog       { scan, capabilities, modelsDir, view }
 * @param {string} deps.assetsDir
 * @param {object} [deps.mediaStatus] () => miraMedia 的状态（没有就 null）
 * @param {object} [deps.deviceStatus] () => miraDevice 的状态（没有就 null）
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
      return undefined
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
    return undefined
  }
}

async function handleApi(pathname, url, req, res, deps) {
  const sub = pathname.slice('/vtuber/api/'.length)
  const method = (req.method || 'GET').toUpperCase()

  if (!isSameOriginRequest(req)) {
    return sendJson(res, 403, fail('http/forbidden',
      '拒绝跨站请求：/vtuber/api/' + sub + ' 只接受同源请求',
      '这些接口能改形象状态、换模型；别的站点不能调用'))
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
    return sendJson(res, 200, okObj({
      plugin: 'muse_vtuber',
      clients: deps.hub.clientCount,
      configError: configError ? configError.error : null,
      configFile: deps.configStore.file,
      stateFile: deps.stateStore.file,
      // 采集口在 mira_device（muse_galaxy 探测的是 /device/api/health），这里只报依赖是否就位
      features: {
        audio: safeDep(deps.mediaStatus) !== null,
        input: safeDep(deps.deviceStatus) !== null,
        live2d: true,
      },
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
      deps: {
        audio: safeDep(deps.mediaStatus) !== null,
        input: safeDep(deps.deviceStatus) !== null,
      },
      configError: configError ? configError.error : null,
      configFile: deps.configStore.file,
      stateFile: deps.stateStore.file,
      endpoints: {
        events: '/vtuber/api/events',
        state: '/vtuber/api/state',
        settings: '/vtuber/api/settings',
        models: '/vtuber/models/',
        assets: '/vtuber/assets/',
        // 其余两件的入口（前端/别的插件照这个拼）
        audio: '/media/api/',
        input: '/device/api/',
      },
    }))
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
      // 记下是哪个页面改的（多设备时状态广播要靠它区分"谁去动本机硬件"）
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

  return sendJson(res, 404, fail('http/not-found', '未知接口：/vtuber/api/' + sub, '见 GET /vtuber/api/bootstrap 的 endpoints'))
}

function safeState(deps) {
  try {
    return { state: deps.stateStore.get(), error: null }
  } catch (error) {
    return { state: deps.stateStore.snapshot(), error: toError(error).error }
  }
}

function safeDep(fn) {
  if (typeof fn !== 'function') return null
  try {
    return fn() || null
  } catch {
    return null
  }
}

/** 设置页 GET：只回可编辑项 + 模型清单；凭据状态转述声音插件（形象自己不存 key）。 */
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
  const mediaStatus = safeDep(deps.mediaStatus)
  const view = {
    ok: true,
    configFile: deps.configStore.file,
    // 凭据不在这里：转述「声音」里那份 key 配没配，避免用户以为还要填一次
    keyConfigured: mediaStatus ? mediaStatus.configured === true : false,
    credsFile: mediaStatus ? mediaStatus.credsFile : '',
    deps: {
      audio: mediaStatus !== null,
      input: safeDep(deps.deviceStatus) !== null,
    },
    warnings: status.warnings.slice(),
    configError: configError || null,
  }
  if (effective) {
    // 下拉框要显示**正在显示的那个模型**（state.model 优先，其次 config.live2d.model）
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
    }
    try {
      view.runtime = { models: deps.catalog.view() }
    } catch (error) {
      view.runtime = { modelsError: toError(error).error }
    }
  }
  return view
}

/** 设置页 POST：白名单字段深合并写回 config.json。 */
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
  const view = buildSettingsView(deps)
  // 设置页里的「模型」= 运行期就要换：写进 config 只是"下次默认"，
  // 这里顺手改一次运行状态并广播，前端收到就切模型。
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
      return okObj({ ...buildSettingsView(deps), changed, appliedModel: null, modelError: toError(error).error })
    }
  }
  return okObj({ ...view, changed, appliedModel })
}

const SETTINGS_SHAPE = {
  live2d: ['modelsDir', 'model', 'width', 'height'],
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
    if (Object.keys(target).length) patch[group] = target
  }
  return patch
}
