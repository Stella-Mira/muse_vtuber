/**
 * muse_vtuber / aliyun.js —— 阿里云百炼（DashScope）三件事：语音合成 / 语音识别 / 图像识别
 *
 * 只用 Node 内置 fetch，不引 SDK，不引第三方依赖。
 *
 *   合成  POST {tts.base}/audio/speech                          （OpenAI 兼容口，默认 qwen-tts）
 *   识别  POST {asr.base}/services/aigc/multimodal-generation/generation （qwen3-asr-flash，吃 base64 音频）
 *   识图  POST {vision.base}/services/aigc/multimodal-generation/generation （qwen-vl，吃 data: URL）
 *
 * 凭据纪律（任务书约定8）：
 *   · key 只从 `$DSH_HOME/mira_config/muse_vtuber/creds/dashscope.json`（权限 600）读；
 *   · 永不回显、不进日志、不进工具返回值；status 只报「配没配」；
 *   · 供应商把请求头回显进报错时，错误文案统一过 redact()。
 */

import { join } from 'node:path'

import {
  MiraError, checkSchema, fileMode, readJsonStrict, writeJsonSecure,
} from './kit.mjs'

export const CREDS_SCHEMA = 1

export const CREDS_FILE = (baseDir) => join(baseDir, 'creds', 'dashscope.json')

/** 抹掉可能回显出来的 key / Bearer。 */
function redact(text, secret) {
  let out = String(text ?? '')
  if (secret) out = out.split(secret).join('***')
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
  return out.slice(0, 400)
}

function trimBase(base) {
  return String(base || '').replace(/\/+$/, '')
}

/**
 * 把供应商响应里「文本」抠出来。四种形状都见过：
 *   choices[0].message.content = "…"                   （OpenAI 兼容聊天口，顶层就有 choices）
 *   output.choices[0].message.content = "…"            （原生口 ASR 常见）
 *   output.choices[0].message.content = [{text:"…"}]   （原生口 VL 常见）
 *   output.text / output.result                        （老版本）
 */
export function extractText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  // 兼容聊天口：顶层直接给 choices
  const out = payload.output && typeof payload.output === 'object' ? payload.output : payload
  if (!out) return ''
  // ASR 原生口：output.text / 顶层 text，另外还有 output.sentence.text
  if (typeof out.text === 'string' && out.text.trim() !== '') return out.text.trim()
  if (out.sentence && typeof out.sentence.text === 'string') return out.sentence.text.trim()
  const choice = Array.isArray(out.choices) && out.choices.length ? out.choices[0] : null
  const message = choice && choice.message ? choice.message : null
  const content = message ? message.content : undefined
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
    return parts.join('').trim()
  }
  if (typeof out.text === 'string') return out.text.trim()
  if (typeof out.result === 'string') return out.result.trim()
  return ''
}

export class AliyunService {
  /**
   * @param {object} options
   * @param {object} options.config    规整后的 cfg
   * @param {string} options.baseDir   `$DSH_HOME/mira_config/muse_vtuber`
   * @param {string} options.configFile config.json 绝对路径（hint 用）
   * @param {object} [options.logger]
   * @param {object} [options.counters]
   * @param {Function} [options.fetchImpl] 自检注入假 fetch
   */
  constructor({ config, baseDir, configFile, logger = null, counters = null, fetchImpl = null }) {
    this.setConfig(config)
    this.baseDir = baseDir
    this.configFile = configFile
    this.logger = logger
    this.counters = counters
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args))
    this.credsFile = CREDS_FILE(baseDir)
    // 识图走哪条上游：null=还不知道，'native'=原生多模态口，'compatible'=兼容聊天口
    this.visionPath = null
  }

  setConfig(config) {
    this.config = config && typeof config === 'object' ? config : {}
  }

  /* ── 凭据 ─────────────────────────────────────────────── */

  readCreds() {
    const strict = readJsonStrict(this.credsFile)
    if (strict.reason === 'missing') return { ok: true, value: null, mode: -1 }
    if (!strict.ok) {
      return {
        ok: false,
        error: {
          code: 'creds/missing',
          message: '凭据文件不可读或不是 JSON 对象：' + this.credsFile
            + (strict.reason === 'corrupt' && strict.detail ? '（' + strict.detail + '）' : ''),
          hint: '修好 ' + this.credsFile + '（{"schemaVersion":1,"apiKey":"sk-..."}，chmod 600），或删掉后按 README 重建',
        },
      }
    }
    const checked = checkSchema(strict.value, CREDS_SCHEMA, this.credsFile)
    if (!checked.ok) return { ok: false, error: checked.error?.error || checked.error }
    return { ok: true, value: strict.value, mode: fileMode(this.credsFile) }
  }

  /** 写凭据（只写不回显；只有设置页会调）。返回 { ok, mode }。 */
  writeCreds({ apiKey }) {
    const key = String(apiKey ?? '').trim()
    if (key === '') {
      throw new MiraError('creds/missing', 'API key 为空，未写入', '在设置页「阿里云 API key」里填写后保存')
    }
    const written = writeJsonSecure(this.credsFile, { schemaVersion: CREDS_SCHEMA, apiKey: key })
    if (!written) {
      throw new MiraError('creds/write-failed', '凭据写盘失败：' + this.credsFile,
        '检查目录权限；凭据文件必须是 600，写不进去时不会退回明文配置项')
    }
    return { ok: true, mode: fileMode(this.credsFile) }
  }

  /** 内部：拿到 key，否则抛 creds/missing（说清缺什么、去哪里填）。 */
  requireKey() {
    const creds = this.readCreds()
    if (!creds.ok) throw new MiraError(creds.error.code, creds.error.message, creds.error.hint)
    const key = typeof creds.value?.apiKey === 'string' ? creds.value.apiKey.trim() : ''
    if (!key) {
      throw new MiraError('creds/missing',
        '未配置阿里云 API key：' + this.credsFile + ' 不存在或 apiKey 为空',
        '在形象界面的「设置 · 形象」里填 key（会以 600 权限写进 ' + this.credsFile + '），或手写这个文件')
    }
    if (creds.mode !== -1 && creds.mode !== 0o600) {
      this.logger?.warn?.('[muse_vtuber] ' + this.credsFile + ' 权限是 ' + creds.mode.toString(8)
        + '，凭据文件应为 600（chmod 600）')
    }
    return key
  }

  /** 只读状态：配没配、用什么模型/音色。**不含 key**。 */
  status() {
    const creds = this.readCreds()
    const configured = creds.ok && typeof creds.value?.apiKey === 'string' && creds.value.apiKey.trim() !== ''
    const tts = this.config.tts || {}
    const asr = this.config.asr || {}
    const vision = this.config.vision || {}
    const status = {
      ok: true,
      configured,
      credsFile: this.credsFile,
      credsMode: creds.ok ? (creds.mode === -1 ? null : '0o' + creds.mode.toString(8)) : null,
      tts: { enabled: tts.enabled === true, provider: tts.provider, model: tts.model, voice: tts.voice, base: tts.base },
      asr: { enabled: asr.enabled === true, model: asr.model, language: asr.language, base: asr.base },
      vision: { enabled: vision.enabled === true, model: vision.model, base: vision.base },
      configFile: this.configFile,
    }
    if (!creds.ok) status.credsError = creds.error
    if (!configured) status.hint = '在「设置 · 形象」里填阿里云 API key（写进 ' + this.credsFile + '，权限 600）'
    return status
  }

  /* ── 请求helper ─────────────────────────────────────────── */

  /** JSON 请求（合成、原生识别/识图都走它）。额外头（如 X-DashScope-SSE）可以透传。 */
  async request(url, { body, timeoutMs, what, headers = {} }) {
    return this.send(url, {
      what,
      timeoutMs,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  /** multipart 请求（兼容口的 /audio/transcriptions）。Content-Type 交给 FormData 自己带 boundary。 */
  async requestMultipart(url, { form, timeoutMs, what }) {
    return this.send(url, { what, timeoutMs, headers: {}, body: form })
  }

  async send(url, { body, headers = {}, timeoutMs, what }) {
    if (typeof this.fetchImpl !== 'function') {
      throw new MiraError(what + '/failed', '当前 Node 没有可用的 fetch，无法调用' + what, '升级到 Node 18+')
    }
    const controller = new AbortController()
    const ms = Math.max(1000, Number(timeoutMs) || 20000)
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), ms)
    if (typeof timer.unref === 'function') timer.unref()
    const key = this.requireKey()
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, ...headers },
        body,
        signal: controller.signal,
      })
      if (!response || response.ok !== true) {
        const status = response?.status ?? 0
        let detail = ''
        try {
          detail = response && typeof response.text === 'function' ? await response.text() : ''
        } catch {
          detail = ''
        }
        this.counters?.bump?.(what + '.fail')
        throw new MiraError(what + '/failed',
          what + ' 接口返回 ' + status + '：' + redact(detail.trim() || '(无响应体)', key),
          '检查 key 是否有效、' + this.configFile + ' 里的 base/model 是否对（兼容口用 compatible-mode/v1，原生口用 api/v1）；额度与权限在控制台看')
      }
      return response
    } catch (error) {
      if (error instanceof MiraError) throw error
      this.counters?.bump?.(what + '.fail')
      // undici 的 "fetch failed" 本身没信息，真正的原因在 cause 里（ECONNRESET / ETIMEDOUT / ENOTFOUND…）
      const cause = error && error.cause
        ? '（' + (error.cause.code || error.cause.message || String(error.cause)) + '）'
        : ''
      throw new MiraError(what + '/failed',
        what + ' 请求失败：' + redact(error?.message || error, key) + cause,
        '检查网络与 ' + this.configFile + ' 的 base（本机到该 host 偶发连不上，重试一次通常就好）；离线时可在设置页把对应能力关掉')
    } finally {
      clearTimeout(timer)
    }
  }

  /* ── 语音合成 ─────────────────────────────────────────── */

  /**
   * 合成语音。返回 { mime, base64, bytes, chars, requestedChars, truncated, model, voice }。
   * 文本超长按 **code point** 截断（slice 会把 emoji 的代理对劈开），并如实回报 truncated。
   */
  async synthesize(text, { voice = '' } = {}) {
    const cfg = this.config.tts || {}
    if (cfg.enabled !== true) {
      throw new MiraError('config/missing', 'TTS 未启用：tts.enabled=false，模型不会说话',
        '在 ' + this.configFile + ' 把 tts.enabled 改成 true（或在设置页打开）')
    }
    const maxChars = Number(cfg.maxChars) || 600
    const raw = String(text ?? '')
    const points = Array.from(raw)
    const truncated = points.length > maxChars
    const input = (truncated ? points.slice(0, maxChars).join('') : raw).trim()
    if (input === '') throw new MiraError('tts/failed', '朗读文本为空', '传 text（1–' + maxChars + ' 字符）')

    const voiceName = voice || cfg.voice
    const provider = String(cfg.provider || 'aliyun').toLowerCase()

    let buf
    let mime = 'audio/mpeg'
    if (provider === 'openai') {
      // OpenAI 兼容口：直接回音频字节
      const response = await this.request(trimBase(cfg.base) + '/audio/speech', {
        what: 'tts',
        timeoutMs: cfg.timeoutMs,
        body: { model: cfg.model, input, voice: voiceName, response_format: 'mp3' },
      })
      try {
        buf = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        throw new MiraError('tts/failed', 'TTS 响应读取失败：' + redact(error?.message || error),
          '重试；持续失败检查供应商状态')
      }
      const type = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : ''
      if (type && type.startsWith('audio/')) mime = type.split(';')[0]
    } else {
      // 千问原生 HTTP 口：一次提交整段文本，拿 audio.url 再下载（URL 有效期 24h）
      const response = await this.request(trimBase(cfg.base) + '/services/audio/tts/SpeechSynthesizer', {
        what: 'tts',
        timeoutMs: cfg.timeoutMs,
        body: {
          model: cfg.model,
          input: { text: input, voice: voiceName, format: 'wav', sample_rate: 24000 },
        },
      })
      let payload
      try {
        payload = await response.json()
      } catch (error) {
        throw new MiraError('tts/failed', 'TTS 响应不是 JSON：' + redact(error?.message || error), '重试或换 tts.model')
      }
      // 网关有时把 output 层剥掉，两种都认
      const audio = (payload?.output && payload.output.audio) || payload?.audio || null
      const url = audio && typeof audio.url === 'string' ? audio.url : ''
      if (url === '') {
        throw new MiraError('tts/failed', 'TTS 没返回 audio.url：' + redact(JSON.stringify(payload).slice(0, 200)),
          '检查 tts.model / tts.voice 是否是供应商支持的组合（音色要 longan* 系列）')
      }
      let audioRes
      try {
        audioRes = await this.fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(Math.max(5000, Number(cfg.timeoutMs) || 30000)) })
      } catch (error) {
        throw new MiraError('tts/failed', '下载合成音频失败：' + redact(error?.message || error), '重试；URL 24 小时有效，过期请重新合成')
      }
      if (!audioRes || audioRes.ok !== true) {
        throw new MiraError('tts/failed', '下载合成音频失败：HTTP ' + (audioRes?.status ?? 0), '重试；URL 24 小时有效')
      }
      buf = Buffer.from(await audioRes.arrayBuffer())
      const type = typeof audioRes.headers?.get === 'function' ? audioRes.headers.get('content-type') : ''
      mime = type && type.startsWith('audio/') ? type.split(';')[0] : 'audio/wav'
    }

    if (buf.length === 0) {
      throw new MiraError('tts/failed', 'TTS 返回了 0 字节音频', '检查 tts.model / tts.voice 是否是供应商支持的组合')
    }
    this.counters?.bump?.('tts.ok')
    return {
      mime,
      base64: buf.toString('base64'),
      bytes: buf.length,
      chars: truncated ? maxChars : points.length,
      requestedChars: points.length,
      truncated,
      model: cfg.model,
      voice: voiceName,
    }
  }

  /* ── 语音识别 ─────────────────────────────────────────── */

  /**
   * 识别一段音频。两条路（`asr.provider`）：
   *   openai（默认）→ POST {base}/audio/transcriptions，multipart 上传 WAV（OpenAI 兼容口，
   *     token-plan 那种只开兼容模式的 key 也能用）
   *   aliyun        → POST {base}/services/aigc/multimodal-generation/generation，base64 音频（原生口）
   * @param {object} input
   * @param {string} input.base64   音频 base64（浏览器里编码好的 WAV）
   * @param {string} [input.mime]   'audio/wav'
   */
  async transcribe({ base64, mime = 'audio/wav', sampleRate = 0 }) {
    const cfg = this.config.asr || {}
    if (cfg.enabled !== true) {
      throw new MiraError('config/missing', 'ASR 未启用：asr.enabled=false，说话不会被识别',
        '在 ' + this.configFile + ' 把 asr.enabled 改成 true（或在设置页打开）')
    }
    const data = String(base64 ?? '').trim()
    if (data === '') throw new MiraError('asr/failed', '音频为空', '浏览器侧没有录到有效音频；检查麦克风权限')
    const provider = String(cfg.provider || 'aliyun').toLowerCase()
    if (provider === 'aliyun') return this.transcribeNative(cfg, data, mime, sampleRate)
    return this.transcribeCompatible(cfg, data, mime)
  }

  /** OpenAI 兼容口：multipart 上传，返回 { text } / { output: { text } } 都认。 */
  async transcribeCompatible(cfg, data, mime) {
    const bytes = Buffer.from(data, 'base64')
    if (typeof FormData !== 'function' || typeof Blob !== 'function') {
      throw new MiraError('asr/failed', '当前 Node 没有 FormData/Blob，无法走兼容识别口',
        '升级到 Node 18+；或把 asr.provider 改成 aliyun（原生口用 base64 JSON）')
    }
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), mime === 'audio/wav' ? 'audio.wav' : 'audio')
    form.append('model', cfg.model)
    if (cfg.language) form.append('language', cfg.language)
    const response = await this.requestMultipart(trimBase(cfg.base) + '/audio/transcriptions', {
      what: 'asr',
      timeoutMs: cfg.timeoutMs,
      form,
    })
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new MiraError('asr/failed', 'ASR 响应不是 JSON：' + redact(error?.message || error), '重试或换模型')
    }
    const text = String(payload?.text ?? '').trim() || extractText(payload)
    if (text === '') this.counters?.bump?.('asr.empty')
    else this.counters?.bump?.('asr.ok')
    return { text, model: cfg.model, provider: 'openai', raw: payload?.request_id ? { requestId: payload.request_id } : undefined }
  }

  /**
   * 千问原生 HTTP 口（实测可用的那条）。形状跟老的 `{audio: dataUrl}` 完全不同：
   *   content: [{ type:'input_audio', input_audio: { data: 'data:audio/wav;base64,…' } }]
   *   parameters: { format:'wav', sample_rate:'16000', language_hints:['zh'] }   ← format 必填
   *   X-DashScope-SSE: disable                                                   ← 只要最终结果
   * 传错形状（少 type/format）时上游只回一个空的 400，很难排查，所以这里写死清楚。
   */
  async transcribeNative(cfg, data, mime, sampleRate = 0) {
    const format = mime === 'audio/mpeg' ? 'mp3'
      : (mime === 'audio/opus' ? 'opus' : 'wav')
    const rate = String(sampleRate || 16000)
    const languageHints = String(cfg.language || '').trim()
    const response = await this.request(trimBase(cfg.base) + '/services/aigc/multimodal-generation/generation', {
      what: 'asr',
      timeoutMs: cfg.timeoutMs,
      headers: { 'X-DashScope-SSE': 'disable' },
      body: {
        model: cfg.model,
        input: {
          messages: [{
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: 'data:' + mime + ';base64,' + data } }],
          }],
        },
        parameters: {
          format,
          sample_rate: rate,
          ...(languageHints !== '' ? { language_hints: [languageHints] } : {}),
        },
      },
    })
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new MiraError('asr/failed', 'ASR 响应不是 JSON：' + redact(error?.message || error), '重试或换模型')
    }
    const text = extractText(payload)
    if (text === '') this.counters?.bump?.('asr.empty')
    else this.counters?.bump?.('asr.ok')
    return { text, model: cfg.model, provider: 'aliyun', raw: payload?.request_id ? { requestId: payload.request_id } : undefined }
  }

  /* ── 图像识别 ─────────────────────────────────────────── */

  /**
   * 识别一张图。@param {object} input @param {string} input.dataUrl `data:image/jpeg;base64,...`
   */
  async describeImage({ dataUrl = '', prompt = '' }) {
    const cfg = this.config.vision || {}
    if (cfg.enabled !== true) {
      throw new MiraError('config/missing', '图像识别未启用：vision.enabled=false',
        '在 ' + this.configFile + ' 把 vision.enabled 改成 true（或在设置页打开）')
    }
    const image = String(dataUrl ?? '').trim()
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) {
      throw new MiraError('vision/failed', '图像格式不支持：需要 data:image/{png,jpeg,webp};base64,...',
        '浏览器侧应当传 canvas.toDataURL("image/jpeg") 的结果')
    }
    const question = String(prompt || cfg.prompt || '').trim()
    /**
     * 同一份配置兼容两种上游形状（按 base 推导，失败自动换另一条并记住，只付一次代价）：
     *   /api/v1            → 阿里云原生多模态口（官方 DashScope）
     *   /compatible-mode/v1→ OpenAI 兼容聊天口 + image_url（token-plan 这类聚合网关只有这条能收图）
     * 官方两者都通；聚合网关的原生口对任何模型都回 "Model not exist"，所以要能自动切。
     */
    const base = trimBase(cfg.base)
    const compatBase = /compatible-mode/i.test(base)
      ? base
      : (/\/api\/v1$/i.test(base) ? base.replace(/\/api\/v1$/i, '/compatible-mode/v1') : '')
    const requestNative = () => this.request(base + '/services/aigc/multimodal-generation/generation', {
      what: 'vision',
      timeoutMs: cfg.timeoutMs,
      body: {
        model: cfg.model,
        input: {
          messages: [
            { role: 'user', content: [{ image }, { text: question }] },
          ],
        },
        parameters: { result_format: 'message' },
      },
    })
    const requestCompatible = () => this.request(compatBase + '/chat/completions', {
      what: 'vision',
      timeoutMs: cfg.timeoutMs,
      body: {
        model: cfg.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question || '用一句中文说清画面里有什么。' },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
        max_tokens: 400,
      },
    })

    let response
    if (this.visionPath === 'compatible' && compatBase !== '') {
      response = await requestCompatible()
    } else if (this.visionPath === 'native') {
      response = await requestNative()
    } else {
      try {
        response = await requestNative()
        this.visionPath = 'native'
      } catch (error) {
        const retryable = compatBase !== '' && compatBase !== base
          && /Model not exist|Api not found|url error|404/i.test(String(error?.message || error))
        if (!retryable) throw error
        // 原生口在这个上游没有：切到兼容口，并记住，后续不再白试
        response = await requestCompatible()
        this.visionPath = 'compatible'
        this.counters?.bump?.('vision.compat-fallback')
      }
    }
    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new MiraError('vision/failed', '图像识别响应不是 JSON：' + redact(error?.message || error), '重试或换模型')
    }
    const text = extractText(payload)
    if (text === '') this.counters?.bump?.('vision.empty')
    else this.counters?.bump?.('vision.ok')
    return { text, model: cfg.model }
  }
}
