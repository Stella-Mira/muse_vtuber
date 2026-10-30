/**
 * muse_vtuber — 客户端模块（浏览器侧）
 *
 * 三个注册点（任务书功能点1 / 功能点4 / 功能点8）：
 *   conversation.view         → 「形象」页签（对话 / 轨迹之后）：主位 LIVE2D + 侧边栏（视频/音频/表情）
 *   conversation.input.right  → 输入框里「模型选择」与「发送」之间的两个按钮（摄像头 / 麦克风）
 *   settings.section          → 设置页「形象」：阿里云 key、TTS/ASR/图像识别、音色、设备
 *
 * 事实源：
 *   · 客户端模块只做浏览器侧的事（取流、画波形、渲染 LIVE2D、播放语音）；
 *     落盘、调阿里云、往会话里插话一律走宿主的 `/vtuber/api/*`（同源，宿主侧有 CSRF 守卫）。
 *   · 槽位契约：`conversation.view` / `conversation.input.right` 是 list 槽，注册需要 id/order/label；
 *     `settings.section` 需要 inject `@deepseek-ai/dsh-client-ui-settings`（package.json 里声明）。
 *   · 状态共享：两个槽位在同一个页面、同一个模块实例里，所以摄像头/麦克风用模块级单例
 *     （`capture`），页签切走再切回不会重新申请权限、也不会掉流。
 *   · 这个文件是**浏览器模块**，不是 Node 模块：只能用浏览器 API，`node --check` 只保语法。
 */

/**
 * 注册 id 必须等于宿主认的**包 specifier**（`dsh-client-modules` 取的是 loader 条目的
 * `fiber.entry?.options.name`，加载完还会校验「bundle 有没有用这个 id 注册」）。
 * 同一个包可能以不同 specifier 装进 profile（例如为了不重启宿主而用别名 `muse_vtuber_ui`
 * 替换旧实现），所以两个 id 都注册：只有宿主清单里那个会被真正 import，另一个只是躺着的工厂。
 */
function museVtuberClient(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/vtuber/api'
    const ASSET = '/vtuber/assets'
    const MODEL_BASE = '/vtuber/models/'

    /* ══════════════════════════════════════════════════════════
     * 0. 小工具
     * ══════════════════════════════════════════════════════════ */

    function errorText(error, status) {
      if (!error) return '请求失败（HTTP ' + status + '）'
      const code = error.code ? '[' + error.code + '] ' : ''
      const hint = error.hint ? '；' + error.hint : ''
      return code + (error.message || '未知错误') + hint
    }

    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json || json.ok !== true) {
        throw new Error(errorText(json && json.error, response.status))
      }
      return json
    }

    async function getJson(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' } })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json || json.ok !== true) {
        throw new Error(errorText(json && json.error, response.status))
      }
      return json
    }

    /* ══════════════════════════════════════════════════════════
     * 1. 共享状态（模块级单例：槽位之间共用）
     * ══════════════════════════════════════════════════════════ */

    const store = {
      ready: false,
      bootError: null,
      cameraOn: false,
      micOn: false,
      // 采集来源：device（本机设备）| galaxy（外部采集器）| none
      cameraSource: 'device',
      micSource: 'device',
      // 外部采集器推来的 PCM 电平（0..1），音频面板的波形用它
      captureLevel: 0,
      visible: true,
      model: '',
      expression: '',
      toggles: [],
      motion: '',
      models: [],
      expressions: [],
      current: '',
      missing: [],
      features: { tts: false, asr: false, vision: false },
      config: null,
      sessionId: '',
      // 舞台/模型状态：没有模型（或加载失败）时由「频谱环」兜底显示，不留白屏
      modelReady: false,
      stageError: '',
      // 界面上的临时信息
      notice: null, // { kind:'info'|'error'|'success', text }
      heard: [], // 最近识别到的语音 [{ text, at, steered }]
      seen: [], // 最近识别到的画面 [{ text, at, steered }]
      bubble: '',
      speaking: false,
    }

    const listeners = new Set()
    function emit(patch) {
      if (patch) Object.assign(store, patch)
      for (const fn of [...listeners]) {
        try {
          fn()
        } catch (error) {
          console.error('[muse_vtuber] listener 出错', error)
        }
      }
    }

    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      }, [])
      return store
    }

    function notice(kind, text) {
      emit({ notice: text ? { kind, text } : null })
      if (kind === 'error') console.warn('[muse_vtuber] ' + text)
    }

    /* ══════════════════════════════════════════════════════════
     * 2. Live2D 运行库（按需加载，幂等）
     * ══════════════════════════════════════════════════════════ */

    let libsPromise = null
    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-muse-vtuber="' + src + '"]')
        if (existing) {
          if (existing.dataset.loaded === '1') return resolve()
          existing.addEventListener('load', () => resolve())
          existing.addEventListener('error', () => reject(new Error('加载失败：' + src)))
          return undefined
        }
        const el = document.createElement('script')
        el.src = src
        el.async = false
        el.dataset.museVtuber = src
        el.addEventListener('load', () => {
          el.dataset.loaded = '1'
          resolve()
        })
        el.addEventListener('error', () => reject(new Error('加载失败：' + src)))
        document.head.appendChild(el)
        return undefined
      })
    }

    /** 顺序很重要：core → pixi → cubism4（cubism4 依赖前两个的全局）。 */
    function ensureLive2dLibs() {
      if (!libsPromise) {
        libsPromise = (async () => {
          await loadScript(ASSET + '/lib/live2dcubismcore.min.js')
          await loadScript(ASSET + '/lib/pixi.min.js')
          await loadScript(ASSET + '/lib/cubism4.min.js')
          if (!window.PIXI || !window.PIXI.live2d) {
            throw new Error('Live2D 运行库没就绪（PIXI.live2d 缺失）：检查 /vtuber/assets/lib/ 是否可访问')
          }
        })()
      }
      return libsPromise
    }

    /* ══════════════════════════════════════════════════════════
     * 3. 采集：摄像头 / 麦克风（模块级单例，跨页签保持）
     * ══════════════════════════════════════════════════════════ */

    /** Float32（-1..1）→ 16bit 单声道 WAV（阿里云识别吃 wav 最稳）。 */
    function encodeWav(float32, sampleRate) {
      const length = float32.length
      const buffer = new ArrayBuffer(44 + length * 2)
      const view = new DataView(buffer)
      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
      }
      writeString(0, 'RIFF')
      view.setUint32(4, 36 + length * 2, true)
      writeString(8, 'WAVE')
      writeString(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true) // PCM
      view.setUint16(22, 1, true) // 单声道
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeString(36, 'data')
      view.setUint32(40, length * 2, true)
      let offset = 44
      for (let i = 0; i < length; i++) {
        const sample = Math.max(-1, Math.min(1, float32[i]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Uint8Array(buffer)
    }

    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return window.btoa(binary)
    }

    /** 线性降到目标采样率（浏览器不一定按我们请求的 sampleRate 建 AudioContext）。 */
    function resample(input, from, to) {
      if (from === to || input.length === 0) return input
      const ratio = from / to
      const length = Math.max(1, Math.round(input.length / ratio))
      const out = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const pos = i * ratio
        const left = Math.floor(pos)
        const right = Math.min(input.length - 1, left + 1)
        const frac = pos - left
        out[i] = (input[left] || 0) * (1 - frac) + (input[right] || 0) * frac
      }
      return out
    }

    class Capture {
      constructor() {
        this.videoStream = null
        this.audioStream = null
        this.audioCtx = null
        this.sourceNode = null
        this.analyser = null
        this.processor = null
        this.levelBuf = null
        this.level = 0
        this.utterance = [] // 当前这句的 Float32 片段
        this.ring = [] // 预录（避免吞字）
        this.inSpeech = false
        this.silenceSince = 0
        this.startedAt = 0
        this.mode = 'idle' // idle | auto | manual
        this.manual = null
        this.lastError = null
        this.listening = false
      }

      get cameraLive() {
        return !!this.videoStream
      }

      get micLive() {
        return !!this.audioStream
      }

      /* ── 摄像头 ── */
      async startCamera(cfg) {
        if (this.videoStream) return this.videoStream
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('这个浏览器不支持 getUserMedia（需要 https 或 localhost）')
        }
        const video = {}
        if (cfg && cfg.width) video.width = { ideal: cfg.width }
        if (cfg && cfg.height) video.height = { ideal: cfg.height }
        if (cfg && cfg.deviceId) video.deviceId = { exact: cfg.deviceId }
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
        this.videoStream = stream
        this.attachFrameVideo()
        this.emit()
        return stream
      }

      stopCamera() {
        if (!this.videoStream) return
        for (const track of this.videoStream.getTracks()) {
          try {
            track.stop()
          } catch { /* 忽略 */ }
        }
        this.videoStream = null
        if (this.frameVideo) {
          try {
            this.frameVideo.srcObject = null
          } catch { /* 忽略 */ }
        }
        this.emit()
      }

      /**
       * 抓帧用的 `<video>`：**不依赖页面上那个预览元素**。
       * 之前用 `document.querySelector('video[data-muse-vtuber-camera]')` 抓帧，只有在「形象」
       * 页签时才有那个元素 —— 用户在「对话」页里开着摄像头，自动识图/`vtuber_look` 就永远抓不到帧。
       * 现在这里维护一个隐藏的 video（只用于 drawImage），预览元素只管显示。
       */
      attachFrameVideo() {
        if (!this.frameVideo) {
          const video = document.createElement('video')
          video.muted = true
          video.playsInline = true
          video.setAttribute('playsinline', '')
          video.autoplay = true
          this.frameVideo = video
        }
        if (this.videoStream && this.frameVideo.srcObject !== this.videoStream) {
          this.frameVideo.srcObject = this.videoStream
          const played = this.frameVideo.play?.()
          if (played && typeof played.catch === 'function') played.catch(() => {})
        }
        return this.frameVideo
      }

      /** 当前一帧 → data:image/jpeg；没有可用画面返回空串。 */
      frameImage(quality = 0.72) {
        if (!this.videoStream) return ''
        const video = this.attachFrameVideo()
        if (!video.videoWidth) return ''
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return ''
        ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', quality)
      }

      /** 兼容旧调用：传了元素就用元素，否则用挂好的隐藏 video。 */
      captureFrame(videoEl) {
        if (videoEl && videoEl.videoWidth) {
          const canvas = document.createElement('canvas')
          canvas.width = videoEl.videoWidth
          canvas.height = videoEl.videoHeight
          const ctx2d = canvas.getContext('2d')
          ctx2d.drawImage(videoEl, 0, 0, canvas.width, canvas.height)
          return canvas.toDataURL('image/jpeg', 0.72)
        }
        return this.frameImage()
      }

      /* ── 麦克风 ── */
      async startMic(cfg) {
        if (this.audioStream) return this.audioStream
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('这个浏览器不支持 getUserMedia（需要 https 或 localhost）')
        }
        // deviceId 与摄像头同口径：留空 = 默认设备；填了就精确匹配（填错会 NotFoundError）
        const deviceId = String((cfg && cfg.deviceId) || '').trim()
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId !== '' ? { deviceId: { exact: deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        this.audioStream = stream
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) throw new Error('这个浏览器没有 Web Audio')
        const target = Math.max(8000, Math.min(48000, Number(cfg && cfg.sampleRate) || 16000))
        this.targetRate = target
        try {
          this.audioCtx = new AC({ sampleRate: target })
        } catch {
          this.audioCtx = new AC()
        }
        if (this.audioCtx.state === 'suspended') {
          try {
            await this.audioCtx.resume()
          } catch { /* 用户还没点过页面，等一次手势 */ }
        }
        this.sourceNode = this.audioCtx.createMediaStreamSource(stream)
        this.analyser = this.audioCtx.createAnalyser()
        this.analyser.fftSize = 1024
        this.analyser.smoothingTimeConstant = 0.4
        this.sourceNode.connect(this.analyser)
        this.levelBuf = new Uint8Array(this.analyser.fftSize)

        // ScriptProcessor 取 PCM：只用来 VAD/编码 WAV（display 走 analyser，两者互不影响）
        const bufferSize = 2048
        this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1)
        this.processor.onaudioprocess = (event) => this.onAudio(event)
        this.sourceNode.connect(this.processor)
        // 必须接到 destination 才会被驱动（静音连接，不产生回声：输出零）
        const mute = this.audioCtx.createGain()
        mute.gain.value = 0
        this.processor.connect(mute)
        mute.connect(this.audioCtx.destination)

        this.vad = (cfg && cfg.vad) || {}
        this.mode = 'auto'
        this.startedAt = Date.now()
        this.emit()
        return stream
      }

      stopMic() {
        if (this.processor) {
          try {
            this.processor.disconnect()
          } catch { /* 忽略 */ }
          this.processor.onaudioprocess = null
          this.processor = null
        }
        if (this.sourceNode) {
          try {
            this.sourceNode.disconnect()
          } catch { /* 忽略 */ }
          this.sourceNode = null
        }
        if (this.audioStream) {
          for (const track of this.audioStream.getTracks()) {
            try {
              track.stop()
            } catch { /* 忽略 */ }
          }
        }
        this.audioStream = null
        this.analyser = null
        this.utterance = []
        this.ring = []
        this.inSpeech = false
        this.level = 0
        this.mode = 'idle'
        this.manual = null
        this.emit()
      }

      emit() {
        emit({ cameraOn: this.cameraLive, micOn: this.micLive })
      }

      /** 录一段固定时长（宿主 vtuber_listen 用）。 */
      recordFor(seconds) {
        if (!this.micLive) return Promise.reject(new Error('麦克风没打开'))
        return new Promise((resolve) => {
          const chunks = []
          this.manual = {
            until: Date.now() + Math.max(1, seconds) * 1000,
            chunks,
            resolve,
          }
          this.mode = 'manual'
          this.listening = true
          emit({ listening: true })
        })
      }

      onAudio(event) {
        const input = event.inputBuffer.getChannelData(0)
        const copy = new Float32Array(input.length)
        copy.set(input)

        // 电平（VAD 用）
        let sum = 0
        for (let i = 0; i < copy.length; i++) sum += copy[i] * copy[i]
        const rms = Math.sqrt(sum / copy.length)
        this.level = rms

        if (this.mode === 'manual' && this.manual) {
          this.manual.chunks.push(copy)
          if (Date.now() >= this.manual.until) {
            const merged = concat(this.manual.chunks)
            const seconds = merged.length / this.audioCtx.sampleRate
            const payload = this.pack(merged, seconds)
            const resolve = this.manual.resolve
            this.manual = null
            this.mode = 'auto'
            this.listening = false
            emit({ listening: false })
            resolve(payload)
          }
          return
        }

        if (this.mode !== 'auto') return
        const quiet = Number(this.vad.silenceMs) || 650
        const threshold = Number(this.vad.threshold) || 0.02
        const minSpeech = Number(this.vad.minSpeechMs) || 320
        const maxMs = Number(this.vad.maxMs) || 15000

        // 预录环：保留最近 ~300ms
        this.ring.push(copy)
        const ringMax = Math.max(2, Math.round(0.3 * this.audioCtx.sampleRate / copy.length))
        while (this.ring.length > ringMax) this.ring.shift()

        if (rms > threshold) {
          if (!this.inSpeech) {
            this.inSpeech = true
            this.utterance = this.ring.slice()
            this.silenceSince = 0
            this.listening = true
            emit({ listening: true })
          } else {
            this.silenceSince = 0
          }
          this.utterance.push(copy)
          return
        }

        if (!this.inSpeech) return
        this.utterance.push(copy)
        if (!this.silenceSince) this.silenceSince = Date.now()
        const speechMs = this.utterance.length * copy.length / this.audioCtx.sampleRate * 1000
        const silentFor = Date.now() - this.silenceSince
        if (silentFor >= quiet || speechMs >= maxMs) {
          const merged = concat(this.utterance)
          this.utterance = []
          this.inSpeech = false
          this.silenceSince = 0
          this.listening = false
          emit({ listening: false })
          if (speechMs < minSpeech) return
          const payload = this.pack(merged, speechMs / 1000)
          void onUtterance(payload)
        }
      }

      /** Float32（设备采样率）→ 目标采样率的 WAV。 */
      pack(float32, seconds) {
        const from = this.audioCtx ? this.audioCtx.sampleRate : this.targetRate
        const to = this.targetRate || from
        const data = resample(float32, from, to)
        const wav = encodeWav(data, to)
        return {
          base64: toBase64(wav),
          mime: 'audio/wav',
          sampleRate: to,
          durationMs: Math.round((seconds || data.length / to) * 1000),
          peak: this.peakOf(float32),
          bytes: wav.length,
        }
      }

      peakOf(float32) {
        let peak = 0
        for (let i = 0; i < float32.length; i += 8) {
          const value = Math.abs(float32[i])
          if (value > peak) peak = value
        }
        return peak
      }
    }

    function concat(chunks) {
      let total = 0
      for (const chunk of chunks) total += chunk.length
      const out = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }

    const capture = new Capture()

    /** 一段话识别完：交给宿主（它会识别 + 按配置可能直接 steer）。 */
    async function onUtterance(payload) {
      try {
        const result = await postJson('/asr', {
          base64: payload.base64,
          mime: payload.mime,
          sessionId: store.sessionId || '',
          auto: true,
          durationMs: payload.durationMs,
          // 原生识别口要用它填 parameters.sample_rate（浏览器按 mic.sampleRate 录的）
          sampleRate: payload.sampleRate || (store.config && store.config.mic ? store.config.mic.sampleRate : 0),
        })
        const text = String(result.text || '').trim()
        if (text === '') {
          emit({ heard: [{ text: '（没听清）', at: new Date().toISOString(), steered: false }, ...store.heard].slice(0, 5) })
          return
        }
        emit({
          heard: [{
            text,
            at: new Date().toISOString(),
            steered: result.steered === true,
            reason: result.steer && result.steer.reason ? result.steer.reason : '',
          }, ...store.heard].slice(0, 5),
        })
      } catch (error) {
        notice('error', '语音识别失败：' + (error && error.message ? error.message : error))
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 4. SSE：宿主 → 浏览器
     * ══════════════════════════════════════════════════════════ */

    let stream = null
    let streamHandlers = new Set()

    function ensureStream() {
      if (stream || typeof window.EventSource !== 'function') return stream
      stream = new window.EventSource(API + '/events')
      stream.addEventListener('message', (event) => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          return
        }
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'hello') {
          if (typeof frame.clientId === 'string') emit({ clientId: frame.clientId })
          return
        }
        if (frame.type === 'state' && frame.state) {
          applyHostState(frame.state, frame.by)
        } else if (frame.type === 'say') {
          emit({ bubble: String(frame.text || ''), speaking: true })
          stage?.playUrl(frame.url)
          for (const fn of [...streamHandlers]) {
            try {
              fn(frame)
            } catch { /* 忽略 */ }
          }
        } else if (frame.type === 'capture/level') {
          // 外部采集器推来的 PCM 电平（宿主侧算的 RMS），音频面板的波形用它
          const level = Number(frame.level)
          emit({ captureLevel: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0 })
        } else if (frame.type === 'capture/heard') {
          const text = String(frame.text || '').trim()
          if (text !== '') {
            emit({
              heard: [{
                text,
                at: new Date().toISOString(),
                steered: frame.steered === true,
                reason: frame.reason ? String(frame.reason) : '',
              }, ...store.heard].slice(0, 5),
            })
          }
        } else if (frame.type === 'command') {
          void handleCommand(frame)
        }
      })
      stream.addEventListener('error', () => {
        // EventSource 自己会重连；这里只提醒一次，别刷屏
        if (!streamWarned) {
          streamWarned = true
          notice('info', '与宿主的事件流断开，浏览器会自动重连…')
        }
      })
      stream.addEventListener('open', () => {
        streamWarned = false
      })
      return stream
    }
    let streamWarned = false

    /**
     * 应用宿主广播的状态。
     *
     * 多设备的关键点：`cameraOn/micOn` 是**会话级意图**，但摄像头/麦克风是**每台设备的本地硬件**。
     * 所以只有「自己改的」或「工具改的」才去真正开关本机硬件；别的设备改了，这里只同步开关外观，
     * 不会顺手把本机摄像头也打开（否则两台设备互相抢同一颗摄像头，还会互相报错）。
     * `by` 形如 `client:<clientId>` / `tool` / `init`。
     */
    function applyHostState(state, by) {
      const patch = {}
      if (typeof state.cameraOn === 'boolean') patch.cameraOn = state.cameraOn
      if (typeof state.micOn === 'boolean') patch.micOn = state.micOn
      if (typeof state.cameraSource === 'string') patch.cameraSource = state.cameraSource
      if (typeof state.micSource === 'string') patch.micSource = state.micSource
      if (typeof state.visible === 'boolean') patch.visible = state.visible
      if (typeof state.model === 'string') patch.model = state.model
      if (typeof state.expression === 'string') patch.expression = state.expression
      if (Array.isArray(state.toggles)) patch.toggles = state.toggles
      if (typeof state.motion === 'string') patch.motion = state.motion
      emit(patch)
      const mine = 'client:' + (store.clientId || '')
      const fromOtherDevice = typeof by === 'string' && by.startsWith('client:') && by !== mine
      // 别的设备动的开关：只同步外观，不动本机硬件
      if (!fromOtherDevice) void reconcileCapture()
      if (patch.model !== undefined && stage) void stage.setModel(patch.model)
      if (stage && patch.motion) stage.playMotion(patch.motion)
      if (stage && (patch.expression !== undefined || patch.toggles)) {
        void stage.applyExpressions(store.expression, store.toggles)
      }
    }

    /** 让硬件跟状态一致（按钮与工具都能改状态，渲染以状态为准）。 */
    async function reconcileCapture() {
      // 采集器源：画面/声音由 muse_galaxy 等推进来，本机不需要 getUserMedia
      const cameraExternal = String(store.cameraSource || 'device') === 'galaxy'
      const micExternal = String(store.micSource || 'device') === 'galaxy'
      try {
        if (cameraExternal) {
          if (capture.cameraLive) capture.stopCamera()
        } else if (store.cameraOn && !capture.cameraLive) {
          await capture.startCamera(store.config?.camera)
        }
        if (!store.cameraOn && capture.cameraLive) capture.stopCamera()
      } catch (error) {
        // 没有摄像头不是"故障"，是这台机器没有：提示一次并把来源切成「不用」，别每次重渲染都再试
        if (isMissingDevice(error)) {
          notice('info', '这台设备没有可用的摄像头：已把摄像头来源切成「不用」（外部采集器不受影响）')
          emit({ cameraOn: false, cameraSource: 'none' })
          void postJson('/state', { cameraOn: false, cameraSource: 'none', clientId: store.clientId || '' })
            .catch(() => { /* 宿主不在就算了，界面已经回退 */ })
        } else {
          notice('error', '摄像头：' + explainMediaError(error, 'camera'))
          emit({ cameraOn: false })
        }
      }
      try {
        if (micExternal) {
          if (capture.micLive) capture.stopMic()
        } else if (store.micOn && !capture.micLive) {
          await capture.startMic(store.config?.mic)
        }
        if (!store.micOn && capture.micLive) capture.stopMic()
      } catch (error) {
        if (isMissingDevice(error)) {
          notice('info', '这台设备没有可用的麦克风：已把麦克风来源切成「不用」（外部采集器不受影响）')
          emit({ micOn: false, micSource: 'none' })
          void postJson('/state', { micOn: false, micSource: 'none', clientId: store.clientId || '' })
            .catch(() => { /* 同上 */ })
        } else {
          notice('error', '麦克风：' + explainMediaError(error, 'mic'))
          emit({ micOn: false })
        }
      }
    }

    /** 宿主发来的 command：look（抓帧）/ listen（录一段）。 */
    async function handleCommand(frame) {
      const requestId = frame.requestId
      const payload = frame.payload || {}
      try {
        if (frame.kind === 'look') {
          // 抓帧走 Capture 自己的隐藏 video，不依赖「形象」页签是否在前台
          const image = capture.frameImage()
          if (!image) throw new Error('摄像头没有画面（未打开或还没出帧）')
          await postJson('/result', { requestId, ok: true, value: { image } })
          return
        }
        if (frame.kind === 'listen') {
          const seconds = Math.max(1, Math.min(30, Number(payload.seconds) || 5))
          const clip = await capture.recordFor(seconds)
          await postJson('/result', {
            requestId,
            ok: true,
            value: { base64: clip.base64, mime: clip.mime, durationMs: clip.durationMs },
          })
          return
        }
        await postJson('/result', {
          requestId,
          ok: false,
          error: { code: 'command/unsupported', message: '客户端不认识这个指令：' + frame.kind, hint: '升级插件版本' },
        })
      } catch (error) {
        try {
          await postJson('/result', {
            requestId,
            ok: false,
            error: { code: 'delivery/failed', message: error && error.message ? error.message : String(error), hint: '' },
          })
        } catch { /* 宿主可能已经超时 */ }
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 5. LIVE2D 舞台（PIXI + pixi-live2d-display）
     * ══════════════════════════════════════════════════════════ */

    let stage = null

    class Stage {
      constructor(container) {
        this.container = container
        this.app = null
        this.model = null
        this.canvas = null
        this.audio = null
        this.audioCtx = null
        this.analyser = null
        this.lipBuf = null
        this.lipLevel = 0
        this.mouthId = null
        this.lipDriving = false
        this.tickerAdded = false
        this.modelGen = 0
        this.stackActive = new Map()
        this.sizeW = 0
        this.sizeH = 0
        this.destroyed = false
        // null = 还没决定过显示什么；'' = 明确"不显示模型"。两者要分开，
        // 否则第一帧 setModel('') 会被"同名就跳过"的守卫吃掉，界面永远停在"正在加载…"。
        this.modelName = null
        // 上一次成功应用的表情指纹（expression + toggles）：状态广播每次都来，别重复重放
        this.lastAppliedExpression = ''
      }

      async init() {
        await ensureLive2dLibs()
        if (this.destroyed) return
        const rect = this.container.getBoundingClientRect()
        const width = Math.max(160, Math.round(rect.width || 360))
        const height = Math.max(220, Math.round(rect.height || 480))
        this.canvas = document.createElement('canvas')
        this.canvas.style.width = '100%'
        this.canvas.style.height = '100%'
        this.canvas.style.display = 'block'
        this.container.appendChild(this.canvas)
        try {
          this.app = new window.PIXI.Application({
            view: this.canvas,
            autoStart: true,
            transparent: true,
            width,
            height,
            resolution: Math.min(2, window.devicePixelRatio || 1),
            autoDensity: true,
            preserveDrawingBuffer: true,
          })
        } catch (error) {
          // 同一页面反复建/销 WebGL 上下文会把 Chrome 的上下文配额用光（Too many active WebGL
          // contexts），或者机器直接没有 WebGL。这时给一句能看懂的话，频谱环继续显示。
          try {
            this.canvas.remove()
          } catch { /* 忽略 */ }
          this.canvas = null
          throw new Error('建不出 WebGL 上下文（显卡/驱动或上下文数量限制）：'
            + (error && error.message ? error.message : error))
        }
        // 上下文丢失（切显卡、休眠唤醒、驱动重置）时不要把整块留白：报出来，恢复后重新挂模型。
        // ⚠️ 必须判 destroyed：视图卸载时 PIXI 销毁 WebGL 上下文会**主动触发** webglcontextlost，
        // 旧实例的监听器如果还往共享状态里写，就会在切页签后显示「WebGL 上下文丢失」这条假警报。
        this.onContextLost = (event) => {
          if (this.destroyed) return
          try {
            event.preventDefault()
          } catch { /* 忽略 */ }
          emit({ modelReady: false, stageError: 'WebGL 上下文丢失（切换显卡/休眠唤醒常见），正在等待恢复…' })
          // 环上不再叠文字，这条错误只能靠侧边栏 footer 传达
          notice('error', 'WebGL 上下文丢失（切显卡/休眠唤醒常见），正在等待恢复…')
        }
        this.onContextRestored = () => {
          if (this.destroyed) return
          emit({ stageError: '' })
          if (this.model) {
            const name = this.modelName === null ? '' : this.modelName
            this.modelName = null // 强制重挂
            void this.setModel(name)
          }
        }
        try {
          this.canvas.addEventListener('webglcontextlost', this.onContextLost, false)
          this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false)
        } catch { /* 忽略 */ }
        this.ensureLipTicker()
        this.resize()
        this.onResize = () => this.resize()
        window.addEventListener('resize', this.onResize)
        this.observer = typeof window.ResizeObserver === 'function'
          ? new window.ResizeObserver(() => this.resize())
          : null
        if (this.observer) this.observer.observe(this.container)
      }

      resize() {
        if (!this.app || !this.container) return
        const rect = this.container.getBoundingClientRect()
        const width = Math.max(160, Math.round(rect.width || 0))
        const height = Math.max(220, Math.round(rect.height || 0))
        if (width < 10 || height < 10) return
        // 自己记住逻辑尺寸（CSS 像素）。不要用 renderer.width：PIXI 6 里它是物理像素，
        // 除以 resolution 之后在 2x 屏上又会被 autoDensity 影响一次，缩放会差一倍。
        this.sizeW = width
        this.sizeH = height
        try {
          this.app.renderer.resize(width, height)
        } catch { /* 忽略 */ }
        if (this.model) this.fitModel()
      }

      fitModel() {
        if (!this.model || !this.app) return
        const width = this.sizeW || this.app.screen.width
        const height = this.sizeH || this.app.screen.height
        const scale = Math.min(width / this.model.width, height / this.model.height) * 0.96
        this.model.scale.set(scale)
        this.model.anchor.set(0.5, 1)
        this.model.x = width / 2
        this.model.y = height
      }

      /**
       * 切换模型。`name` 为空串 = **不显示模型**（设置页那个空白选项就是这个意思），
       * 只留频谱环；不是"用清单里第一个"。
       * 同名重复调用直接返回（状态广播里每次都带 model 字段，不判等会把模型反复重载）。
       */
      async setModel(name) {
        if (!this.app) return
        const target = String(name ?? '').trim()
        // 同名幂等：只有"已经决定过同一个目标"才跳过（modelName 初始为 null，所以首帧一定执行）
        if (this.modelName !== null && target === this.modelName) {
          if (target !== '' ? this.model !== null : true) return
        }
        const gen = ++this.modelGen

        if (target === '') {
          if (this.model) {
            try {
              this.app.stage.removeChild(this.model)
              this.model.destroy()
            } catch { /* 忽略 */ }
          }
          this.model = null
          this.modelName = ''
          this.mouthId = null
          this.stackActive.clear()
          const anyModel = (store.models || []).length > 0
          emit({
            modelReady: false,
            stageError: anyModel
              ? '没有选择模型（设置 · 形象 → 模型，留空 = 不显示）；频谱环会一直在'
              : '还没有可用模型：把 <Name>/<Name>.model3.json 放进设置里的「模型目录」',
          })
          return
        }

        const hit = (store.models || []).find((m) => m.name === target || m.entry === target)
        const entry = hit ? hit.entry : ''
        if (entry === '') {
          emit({ modelReady: false, stageError: '模型清单里没有 ' + target + '（可能被改名/删了）：vtuber_status 看 models' })
          return
        }
        let next
        try {
          // autoInteract: false —— 关掉"鼠标跟随"。
          // pixi-live2d-display 的 Live2DModel.init 默认 `autoInteract: true`，
          // 会注册 pointermove → focus(x,y)，于是模型的头和眼睛一直追着鼠标跑。
          // 这里的形象是"陪你看东西/说话"的，不需要跟着指针动。
          next = await window.PIXI.live2d.Live2DModel.from(MODEL_BASE + entry, { autoInteract: false })
        } catch (error) {
          if (gen === this.modelGen) {
            const text = '模型加载失败：' + (error && error.message ? error.message : error) + '（' + entry + '）'
            emit({ modelReady: false, stageError: text })
            notice('error', text)
          }
          return
        }
        if (gen !== this.modelGen || this.destroyed) {
          try {
            next.destroy()
          } catch { /* 忽略 */ }
          return
        }
        if (this.model) {
          try {
            this.app.stage.removeChild(this.model)
            this.model.destroy()
          } catch { /* 忽略 */ }
        }
        this.model = next
        this.modelName = hit.name
        this.mouthId = null
        this.stackActive.clear()
        // 换了模型就得重新应用一次（表情定义表变了）
        this.lastAppliedExpression = ''
        this.app.stage.addChild(next)
        this.fitModel()
        emit({ modelReady: true, stageError: '', current: hit.name })
        try {
          // 有 pending 的动作组就播它，否则默认 Idle
          const pending = String(store.motion || '').split('#')[0].trim()
          next.motion(pending !== '' ? pending : 'Idle')
        } catch { /* 没有 Idle 组就算了 */ }
        this.applyExpressions(store.expression, store.toggles)
      }

      getExpressionManager() {
        try {
          return this.model && this.model.internalModel && this.model.internalModel.motionManager
            ? this.model.internalModel.motionManager.expressionManager
            : null
        } catch {
          return null
        }
      }

      resetExpression() {
        const em = this.getExpressionManager()
        if (em && typeof em.resetExpression === 'function') {
          try {
            em.resetExpression()
            if (em.defaultExpression) em.currentExpression = em.defaultExpression
          } catch { /* 忽略 */ }
        }
        this.stackActive.clear()
      }

      async loadExpressionMotion(name) {
        const em = this.getExpressionManager()
        if (!em || typeof em.loadExpression !== 'function') return null
        const index = this.expressionIndexOf(name)
        if (index < 0) return null
        try {
          return await em.loadExpression(index)
        } catch {
          return null
        }
      }

      /**
       * 把一个表情名定位成**模型定义表里的索引**。
       *
       * 为什么不能直接把名字交给 `model.expression()`：那个方法内部按它自己的
       * `definitions[].Name` 做严格比较（可能带空格/大小写/取自文件名），我们手上的名字
       * 来自 model3.json。名字对不上时它返回 false —— 以前我就当"模型里没有这个表情"，
       * 然后又拿空参数集合去 rebuild 表情，把表情管理器写坏，模型直接不渲染（用户看到的
       * "疑惑在的，但模型丢了"）。
       *
       * 顺序：模型定义表（trim 比较）→ capabilities 清单的序号（同一份 model3.json 的顺序）
       *      → 最后才退回按名字。
       */
      expressionIndexOf(name) {
        const target = String(name || '').trim()
        if (target === '') return -1
        const em = this.getExpressionManager()
        const defs = em && Array.isArray(em.definitions) ? em.definitions : []
        const byName = defs.findIndex((d) => d && String(d.Name || '').trim() === target)
        if (byName >= 0) return byName
        const list = (store.expressions || []).map((e) => (typeof e === 'string' ? e : e && e.name))
        const byOrder = list.findIndex((n) => String(n || '').trim() === target)
        if (byOrder >= 0 && byOrder < defs.length) return byOrder
        return -1
      }

      /**
       * 这个表情是不是**已经是当前表情**了？
       *
       * 库里的 setExpression 有两处 `return false` **不代表失败**：
       *   ① `t === this.expressions.indexOf(this.currentExpression)` —— 已经是它了；
       *   ② 并发时被后一次调用把 `reserveExpressionIndex` 重置 —— 请求 3 被覆盖。
       * 我们每次状态广播都会重新 apply 一遍，所以这两条会稳定踩到，于是「切是切好了却报
       * 『这个表情应用不了』」。判断成功与否要看**当前的 currentExpression 是不是它**。
       */
      isCurrentExpression(name) {
        const em = this.getExpressionManager()
        if (!em) return false
        const index = this.expressionIndexOf(name)
        if (index < 0) return false
        const loaded = Array.isArray(em.expressions) ? em.expressions[index] : null
        if (!loaded || !em.currentExpression) return false
        return em.currentExpression === loaded
      }

      /** 把「选中的表情 + 所有打开的开关」合成一个 ExpressionMotion（同 mira_live2d 的做法）。 */
      rebuild() {
        const em = this.getExpressionManager()
        if (!em) return
        const merged = new Map()
        let any = false
        try {
          const active = em.currentExpression
          if (active && active !== em.defaultExpression && active._parameters) {
            any = true
            for (const param of active._parameters) {
              merged.set(String(param.parameterId), { blend: param.blendType, value: param.value })
            }
          }
        } catch { /* 忽略 */ }
        for (const item of this.stackActive.values()) {
          if (!item.active || !item.motion) continue
          any = true
          for (const param of item.motion._parameters || []) {
            merged.set(String(param.parameterId), { blend: param.blendType, value: param.value })
          }
        }
        if (!any) {
          try {
            em.resetExpression()
          } catch { /* 忽略 */ }
          return
        }
        const blendNames = ['Add', 'Multiply', 'Overwrite']
        const Parameters = []
        for (const entry of merged) {
          Parameters.push({ Id: entry[0], Value: entry[1].value, Blend: blendNames[entry[1].blend] || 'Add' })
        }
        // 空参数集合绝不能往下传：`createExpression` 会给出 undefined，接着 `_setExpression(undefined)`
        // 把 currentExpression 置空 → 表情管理器每帧 update 抛错 → 模型不再渲染（"模型丢失"）。
        if (Parameters.length === 0) {
          try {
            em.resetExpression()
            if (em.defaultExpression) em.currentExpression = em.defaultExpression
          } catch { /* 忽略 */ }
          return
        }
        try {
          const motion = em.createExpression({ Parameters })
          if (!motion) {
            console.warn('[muse_vtuber] createExpression 返回空，跳过本次表情合成')
            return
          }
          if (typeof motion.setFadeInTime === 'function') motion.setFadeInTime(0)
          em._setExpression(motion)
        } catch { /* 忽略 */ }
      }

      /**
       * 应用表情：expression 是互斥的那个，toggles 是叠加开关。
       *
       * 两条纪律（都是用户报过的「模型丢失」换来的）：
       *   1. **不认识的先拦掉**：名字不在 `store.expressions` 里就只提示，不去调
       *      `model.expression()`。以前未知名字会真的喂给 pixi-live2d-display，
       *      `setExpression` 找不到定义时会把表情管理器置成空状态，模型就渲染没了。
       *   2. **每一步都不许抛穿**：整体包 try/catch，出错只提示；最后再 self-heal 一次
       *      （确保模型还挂在 stage 上）。
       */
      async applyExpressions(expression, toggles) {
        if (!this.model) return
        // 状态广播每次都会调用这里；表情+开关没变就别重放（重放会踩库里的"已经是它/被并发覆盖"分支）
        const fingerprint = JSON.stringify([String(expression || ''), Array.isArray(toggles) ? toggles : []])
        if (fingerprint === this.lastAppliedExpression) {
          this.ensureAttached()
          return
        }
        this.lastAppliedExpression = fingerprint
        const known = new Set((store.expressions || []).map((e) => (typeof e === 'string' ? e : e.name)))
        const wanted = (Array.isArray(toggles) ? toggles : []).filter((name) => {
          if (known.size === 0 || known.has(name)) return true
          emit({ notice: { kind: 'error', text: '模型里没有这个开关：' + name } })
          return false
        })
        try {
          for (const name of wanted) {
            if (this.stackActive.get(name)?.active) continue
            const motion = await this.loadExpressionMotion(name)
            if (motion) this.stackActive.set(name, { motion, active: true })
            else emit({ notice: { kind: 'error', text: '这个开关加载不出来：' + name } })
          }
          for (const [name, item] of [...this.stackActive]) {
            if (!wanted.includes(name)) item.active = false
          }
          const single = String(expression || '')
          if (single && known.size > 0 && !known.has(single)) {
            // 未知互斥表情：保持现状，只提示（绝不把名字交给底层）
            emit({ notice: { kind: 'error', text: '模型里没有这个表情：' + single + '（当前表情保持不变）' } })
          } else if (single) {
            const ok = await this.applySingle(single)
            // 只在**确实没切成**的时候报错；库返回 false 但 currentExpression 已经是它，算成功
            if (!ok) {
              const applied = this.isCurrentExpression(single)
              if (!applied) emit({ notice: { kind: 'error', text: '这个表情应用不了：' + single + '（当前表情保持不变）' } })
            }
          } else {
            const em = this.getExpressionManager()
            if (em && typeof em.resetExpression === 'function') {
              try {
                em.resetExpression()
                if (em.defaultExpression) em.currentExpression = em.defaultExpression
              } catch { /* 忽略 */ }
            }
          }
          this.rebuild()
        } catch (error) {
          emit({ notice: { kind: 'error', text: '表情应用失败（已保持现状）：' + (error && error.message ? error.message : error) } })
        }
        this.ensureAttached()
      }

      /** 自愈：模型必须挂在 app.stage 上，否则重挂一次（切表情/切模型后都过一遍）。 */
      ensureAttached() {
        if (!this.model || !this.app || this.destroyed) return false
        try {
          if (this.model.parent !== this.app.stage) {
            this.app.stage.addChild(this.model)
            this.fitModel()
            console.warn('[muse_vtuber] 模型掉了，已重新挂回舞台')
          }
          return true
        } catch {
          return false
        }
      }

      /** 播放动作组（vtuber_motion）。名字来自能力清单的 motions。 */
      playMotion(name) {
        const group = String(name || '').split('#')[0].trim()
        if (!this.model || group === '') return false
        const known = (store.motions || []).map(String)
        if (known.length > 0 && !known.includes(group)) {
          emit({ notice: { kind: 'error', text: '模型里没有这个动作组：' + group } })
          return false
        }
        try {
          this.model.motion(group)
          emit({ notice: null })
          return true
        } catch (error) {
          emit({ notice: { kind: 'error', text: '动作播放失败：' + (error && error.message ? error.message : error) } })
          return false
        }
      }

      async applySingle(name) {
        if (!this.model || typeof this.model.expression !== 'function') return false
        const target = String(name || '').trim()
        if (target === '') return false
        // 已经是当前表情：库里这一刻会 return false（"无需重复设置"），别把它当失败
        if (this.isCurrentExpression(target)) return true
        const attempt = async (arg) => {
          try {
            const result = await this.model.expression(arg)
            // 库在"找不到定义"时明确返回 false；undefined/true 都当它开始应用了
            return result !== false
          } catch {
            return false
          }
        }
        const index = this.expressionIndexOf(target)
        if (index >= 0 && await attempt(index)) return true
        if (await attempt(target)) return true
        // 有些模型的表达式管理器要等第一帧之后才可用：延一帧再试一次（只试一次，不循环）
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
        if (await attempt(target)) return true
        // 兜底：库的两处 `return false`（已经是它 / 被并发覆盖）都不代表失败，
        // 最终以「当前表情到底是不是它」为准。
        return this.isCurrentExpression(target)
      }

      /* ── 语音播放 + 口型 ── */
      ensureAudioGraph() {
        if (!this.audio) return null
        try {
          const AC = window.AudioContext || window.webkitAudioContext
          if (!this.audioCtx) this.audioCtx = new AC()
          if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
          const source = this.audioCtx.createMediaElementSource(this.audio)
          this.analyser = this.audioCtx.createAnalyser()
          this.analyser.fftSize = 512
          this.analyser.smoothingTimeConstant = 0.5
          source.connect(this.analyser)
          this.analyser.connect(this.audioCtx.destination)
          this.lipBuf = new Uint8Array(this.analyser.fftSize)
          return this.analyser
        } catch {
          return null
        }
      }

      findMouthId(cm) {
        try {
          const ids = cm && cm._parameterIds
          if (Array.isArray(ids) && ids.length) {
            for (const id of ['ParamMouthOpen', 'ParamMouthOpenY']) {
              if (ids.includes(id)) return id
            }
            const hit = ids.find((x) => /MouthOpen/i.test(String(x)))
            if (hit) return hit
            return null
          }
        } catch { /* 忽略 */ }
        return 'ParamMouthOpen'
      }

      ensureLipTicker() {
        if (this.tickerAdded || !this.app) return
        this.tickerAdded = true
        this.app.ticker.add(() => {
          let cm = null
          try {
            cm = this.model && this.model.internalModel ? this.model.internalModel.coreModel : null
          } catch { /* 忽略 */ }
          if (!cm) return
          const el = this.audio
          if (el && this.analyser && !el.paused && !el.ended) {
            try {
              this.analyser.getByteTimeDomainData(this.lipBuf)
              let sum = 0
              for (let i = 0; i < this.lipBuf.length; i++) {
                const value = (this.lipBuf[i] - 128) / 128
                sum += value * value
              }
              const rms = Math.sqrt(sum / this.lipBuf.length)
              const target = Math.min(1, Math.max(0, (rms - 0.035) * 8))
              const k = target > this.lipLevel ? 0.55 : 0.22
              this.lipLevel += (target - this.lipLevel) * k
              if (!this.mouthId) this.mouthId = this.findMouthId(cm)
              if (this.mouthId) cm.setParameterValueById(this.mouthId, this.lipLevel, 1)
              this.lipDriving = true
            } catch { /* 忽略 */ }
          } else if (this.lipDriving) {
            this.lipDriving = false
            this.lipLevel = 0
            try {
              if (!this.mouthId) this.mouthId = this.findMouthId(cm)
              if (this.mouthId) cm.setParameterValueById(this.mouthId, 0, 1)
            } catch { /* 忽略 */ }
          }
        })
      }

      playUrl(url) {
        if (!url) return
        try {
          if (this.audio) {
            try {
              this.audio.pause()
            } catch { /* 忽略 */ }
          }
          this.audio = new window.Audio(url)
          this.ensureAudioGraph()
          this.audio.addEventListener('ended', () => {
            emit({ speaking: false, bubble: '' })
          })
          this.audio.addEventListener('error', () => {
            emit({ speaking: false })
            notice('error', '语音播放失败（浏览器可能拦截了自动播放：点一下页面再试）')
          })
          const played = this.audio.play()
          if (played && typeof played.catch === 'function') {
            played.catch(() => {
              emit({ speaking: false })
              notice('info', '浏览器拦截了自动播放：点一下页面，之后就能自动说话')
            })
          }
        } catch (error) {
          notice('error', '播放失败：' + (error && error.message ? error.message : error))
        }
      }

      destroy() {
        // 先立 destroyed 旗标：销毁 PIXI/WebGL 上下文会主动触发 webglcontextlost，
        // 监听器看到旗标就直接返回，不会把假警报写进共享状态。
        this.destroyed = true
        this.modelName = null
        if (this.audio) {
          try {
            this.audio.pause()
          } catch { /* 忽略 */ }
        }
        if (this.onResize) window.removeEventListener('resize', this.onResize)
        if (this.observer) {
          try {
            this.observer.disconnect()
          } catch { /* 忽略 */ }
        }
        try {
          this.canvas?.removeEventListener('webglcontextlost', this.onContextLost, false)
          this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored, false)
        } catch { /* 忽略 */ }
        try {
          this.model?.destroy()
        } catch { /* 忽略 */ }
        try {
          this.app?.destroy(true, { children: true })
        } catch { /* 忽略 */ }
        this.model = null
        this.app = null
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 6. 样式（只吃主题变量，没写死颜色）
     * ══════════════════════════════════════════════════════════ */

    const CSS = [
      '.mv-view{display:grid;grid-template-columns:minmax(0,1fr) 220px;grid-template-rows:minmax(0,1fr);gap:12px;height:100%;min-height:240px;padding:12px;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary, inherit);font:inherit;}',
      // 主位最小高度 320：即使高度测量被异常值干扰，舞台也不会缩成「跟右边栏一样大」
      '.mv-main{position:relative;min-height:320px;height:100%;min-width:0;border-radius:var(--dsw-radius-lg, 12px);overflow:hidden;background:var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08));display:flex;align-items:stretch;justify-content:center;}',
      '.mv-ring{position:absolute;inset:0;z-index:0;display:block;width:100%;height:100%;pointer-events:none;}',
      // 舞台**永远**挂在同一层（隐藏用透明度，不换 DOM）：之前用「有/无一个 ref node」切换，
      // 一旦切换过，PIXI 那个 canvas 就跟着旧 node 一起没了 —— 表现就是「形象不见了」。
      '.mv-stage{position:absolute;inset:0;z-index:1;min-height:0;min-width:0;transition:opacity .18s ease;}',
      '.mv-stage[data-hidden="1"]{opacity:0;pointer-events:none;}',
      // 环上不叠文字（用户口径）：没模型/隐藏时只留频谱环，提示放到右侧栏 footer
      '.mv-bubble{position:absolute;left:12px;right:12px;bottom:12px;z-index:3;padding:8px 12px;border-radius:var(--dsw-radius-md, 10px);background:var(--dsw-alias-bg-layer-2, rgba(0,0,0,.55));border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));font-size:13px;line-height:1.5;max-height:35%;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
      // 右侧栏是**唯一**可滚动的那一栏：主位永远等于可视高度，模型因此不会被裁
      '.mv-side{display:flex;flex-direction:column;gap:10px;min-height:0;max-height:100%;overflow-y:auto;overflow-x:hidden;padding-right:2px;}',
      // 提醒沉底：内容不够高时贴到侧边栏底部，内容多时跟着一起滚
      '.mv-side-footer{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:2px;}',
      '.mv-card{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:var(--dsw-radius-md, 10px);border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1, transparent);min-width:0;}',
      '.mv-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;}',
      // 来源选择器 + MJPEG 画面（外部采集器）：窄一点，跟卡片头一行放得下
      '.mv-card-tools{display:inline-flex;align-items:center;gap:6px;min-width:0;}',
      '.mv-src{font:inherit;font-size:11px;font-weight:400;padding:1px 4px;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));background:transparent;color:inherit;max-width:96px;}',
      '.mv-video-stream{width:100%;height:100%;object-fit:contain;display:block;background:#000;}',
      '.mv-card-body{position:relative;border-radius:var(--dsw-radius-sm, 8px);overflow:hidden;background:#000;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;}',
      '.mv-card-body video{width:100%;height:100%;object-fit:cover;display:block;}',
      '.mv-card-body canvas{width:100%;height:100%;display:block;}',
      '.mv-off{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:rgba(255,255,255,.55);background:#000;}',
      '.mv-tip{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary, inherit);word-break:break-word;}',
      '.mv-err{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary, #d25);word-break:break-word;}',
      '.mv-chips{display:flex;flex-wrap:wrap;gap:6px;}',
      '.mv-chip{font:inherit;font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2, currentColor);background:transparent;color:inherit;cursor:pointer;}',
      '.mv-chip[data-on="1"]{background:var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.28));border-color:var(--dsw-alias-label-secondary, currentColor);font-weight:600;}',
      '.mv-chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color, currentColor);outline-offset:1px;}',
      '.mv-log{display:flex;flex-direction:column;gap:4px;max-height:96px;overflow:auto;}',
      '.mv-log-item{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary, inherit);word-break:break-word;}',
      '.mv-log-item b{color:var(--dsw-alias-label-primary, inherit);font-weight:600;}',
      '.mv-btn{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:4px;width:28px;height:28px;padding:0;border-radius:var(--dsw-radius-sm, 8px);border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary, inherit);cursor:pointer;}',
      '.mv-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18));color:var(--dsw-alias-label-primary, inherit);}',
      '.mv-btn[data-on="1"]{color:var(--dsw-alias-state-success-primary, #2a2);background:var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.26));border-color:var(--dsw-alias-border-l2, currentColor);}',
      '.mv-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, currentColor);outline-offset:1px;}',
      '.mv-btn svg{width:16px;height:16px;display:block;}',
      '.mv-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.mv-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary, #d25);}',
      '.mv-notice[data-kind="success"]{color:var(--dsw-alias-state-success-primary, #2a2);}',
      '.mv-set{display:flex;flex-direction:column;gap:16px;font:inherit;color:inherit;max-width:760px;}',
      '.mv-set-title{margin:0;font-size:16px;font-weight:600;}',
      '.mv-set-sub{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.mv-set-group{margin:0;padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2, currentColor);border-radius:var(--dsw-radius-md, 8px);min-width:0;}',
      '.mv-set-legend{padding:0 4px;margin:0 0 2px;font-size:13px;font-weight:600;}',
      '.mv-set-row{display:grid;grid-template-columns:132px minmax(0, 1fr);gap:6px 12px;align-items:start;font-size:13px;min-width:0;}',
      '.mv-set-mid{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.mv-set-label{padding-top:6px;font-size:13px;}',
      '.mv-set-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary, inherit);}',
      '.mv-set-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;padding:5px 8px;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:inherit;}',
      '.mv-set-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding-top:5px;}',
      '.mv-set-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;}',
      '.mv-set-button{font:inherit;font-size:13px;padding:6px 16px;border-radius:var(--dsw-radius-md, 8px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:inherit;cursor:pointer;}',
      '.mv-set-button:disabled{opacity:.55;cursor:default;}',
      '@media (max-width: 720px){.mv-view{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(200px,1fr) auto;}.mv-side{flex-direction:row;overflow-x:auto;overflow-y:hidden;max-height:none;}.mv-card{min-width:180px;}.mv-side-footer{min-width:180px;margin-top:0;}}',
    ].join('\n')

    /* ══════════════════════════════════════════════════════════
     * 7. 形象页签（功能点1–3、5–7）
     * ══════════════════════════════════════════════════════════ */

    function CameraIcon(props) {
      // 显式给 width/height：输入框里的按钮天然拿不到「形象」页签那份 <style>，
      // 只靠 CSS 定尺寸时会被浏览器画成默认尺寸的空框（用户看到的就是两个空框框）。
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...props,
      },
      h('rect', { x: 2.5, y: 6.5, width: 13, height: 11, rx: 2.5 }),
      h('path', { d: 'M15.5 10.5l6-3v9l-6-3z' }))
    }

    function MicIcon(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        ...props,
      },
      h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
      h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5' }))
    }

    /** 侧边栏「视频」：摄像头预览（关着就是黑屏 + 一行字）。 */
    /** 摄像头/麦克风的来源选择（device = 本机设备；galaxy = 外部采集器；none = 不用）。 */
    function SourcePicker({ kind }) {
      const state = useStore()
      const value = String((kind === 'camera' ? state.cameraSource : state.micSource) || 'device')
      const change = async (next) => {
        const patch = kind === 'camera' ? { cameraSource: next } : { micSource: next }
        emit(patch)
        // 切到外部源：本机设备要释放；切回本机：按当前开关重新开
        await reconcileCapture()
        try {
          await postJson('/state', { ...patch, clientId: store.clientId || '' })
        } catch (error) {
          notice('error', '切换来源失败：' + (error && error.message ? error.message : error))
        }
      }
      return h('select', {
        className: 'mv-src',
        value,
        title: '来源：本机设备 / 外部采集器（muse_galaxy 等）/ 不用',
        onChange: (event) => { void change(event.target.value) },
      },
      h('option', { value: 'device' }, '本机'),
      h('option', { value: 'galaxy' }, '外部采集'),
      h('option', { value: 'none' }, '不用'))
    }

    function VideoPanel({ videoRef }) {
      const state = useStore()
      const galaxy = String(state.cameraSource || 'device') === 'galaxy'
      // MJPEG 的 <img> 要"连一次就一直读"：src 里带时间戳会让它每秒重连（看起来像不出画面）
      const [streamFailed, setStreamFailed] = React.useState(false)
      React.useEffect(() => { setStreamFailed(false) }, [galaxy, state.cameraOn])
      React.useEffect(() => {
        const el = videoRef.current
        if (!el) return
        if (galaxy) {
          // 采集器源：面板改成 MJPEG（<img> 原生就能播 multipart），本机的 <video> 该放开
          if (el.srcObject) el.srcObject = null
          return
        }
        if (capture.videoStream && el.srcObject !== capture.videoStream) {
          el.srcObject = capture.videoStream
          const played = el.play?.()
          if (played && played.catch) played.catch(() => {})
        }
        if (!state.cameraOn && el.srcObject) el.srcObject = null
      })
      const headState = galaxy
        ? (state.cameraOn ? (streamFailed ? '无信号' : '外部采集') : '已断开')
        : (state.cameraOn ? (state.listening ? '识别中…' : '摄像头开') : '摄像头关')
      return h('section', { className: 'mv-card' },
        h('header', { className: 'mv-card-head' },
          h('span', null, '视频'),
          h('span', { className: 'mv-card-tools' },
            h('span', { className: 'mv-tip' }, headState),
            h(SourcePicker, { kind: 'camera' }))),
        h('div', { className: 'mv-card-body' },
          // 采集器源：一个 <img> 就够（/vtuber/api/stream.mjpg 是 multipart JPEG）。
          // src 必须**稳定**（不带 ?t=）：multipart 靠长连接持续推帧，带缓存破坏符会每渲染一次重连一次。
          galaxy
            ? (state.cameraOn && !streamFailed
              ? h('img', {
                key: 'capture-stream',
                className: 'mv-video-stream',
                src: '/vtuber/api/stream.mjpg',
                alt: '外部采集画面',
                onError: () => setStreamFailed(true),
              })
              : h('div', { className: 'mv-off' },
                state.cameraOn ? '外部采集没有画面（采集器没在推帧？）' : '外部采集已断开'))
            : h('video', {
              ref: videoRef,
              'data-muse-vtuber-camera': '1',
              muted: true,
              playsInline: true,
              autoPlay: true,
              style: { display: state.cameraOn ? 'block' : 'none' },
            }),
          state.cameraOn || galaxy ? null : h('div', { className: 'mv-off' }, '摄像头已关闭')),
        state.seen.length
          ? h('div', { className: 'mv-log' }, state.seen.map((item, index) => h('div', { className: 'mv-log-item', key: index },
            h('b', null, '看到：'), item.text,
            item.steered ? h('span', { className: 'mv-tip' }, '（已插话）') : null,
            item.reason ? h('span', { className: 'mv-tip' }, '（' + item.reason + '，未插话）') : null)))
          : h('p', { className: 'mv-tip' }, galaxy
            ? '画面来自外部采集器（muse_galaxy 等）。识别间隔由「自动识图间隔」控制。'
            : (state.features.vision ? '打开摄像头后，画面识别结果会出现在这里。' : '图像识别未启用：在「设置 · 形象」里打开。')))
    }

    /** 侧边栏「音频」：波形（关着是一条直线）+ 最近识别到的句子。 */
    function AudioPanel() {
      const state = useStore()
      const galaxy = String(state.micSource || 'device') === 'galaxy'
      const canvasRef = React.useRef(null)
      const rafRef = React.useRef(0)
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return undefined
        const ctx2d = canvas.getContext('2d')
        const draw = () => {
          rafRef.current = window.requestAnimationFrame(draw)
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const width = Math.max(60, Math.round(canvas.clientWidth * dpr))
          const height = Math.max(40, Math.round(canvas.clientHeight * dpr))
          if (canvas.width !== width) canvas.width = width
          if (canvas.height !== height) canvas.height = height
          ctx2d.clearRect(0, 0, width, height)
          ctx2d.lineWidth = Math.max(1, dpr)
          ctx2d.strokeStyle = 'rgba(120,220,170,0.9)'
          ctx2d.beginPath()
          // 采集器源：波形由宿主按 PCM 算的 RMS 推过来（capture/level），本机没有 analyser
          if (galaxy) {
            // 读 store 上的实时值（不要放进 effect 依赖：那样每 200ms 就重建一次绘图循环）
            const level = state.micOn ? Math.max(0, Math.min(1, Number(store.captureLevel) || 0)) : 0
            if (level <= 0.001) {
              ctx2d.moveTo(0, height / 2)
              ctx2d.lineTo(width, height / 2)
              ctx2d.stroke()
              return
            }
            const amp = (height / 2) * 0.92 * Math.min(1, level * 4)
            for (let x = 0; x <= width; x += Math.max(1, dpr)) {
              const y = height / 2 + Math.sin((x / width) * Math.PI * 8) * amp
              if (x === 0) ctx2d.moveTo(x, y)
              else ctx2d.lineTo(x, y)
            }
            ctx2d.stroke()
            return
          }
          const analyser = capture.analyser
          if (!state.micOn || !analyser) {
            ctx2d.moveTo(0, height / 2)
            ctx2d.lineTo(width, height / 2)
            ctx2d.stroke()
            return
          }
          const buf = capture.levelBuf || new Uint8Array(analyser.fftSize)
          capture.levelBuf = buf
          try {
            analyser.getByteTimeDomainData(buf)
          } catch {
            return
          }
          for (let i = 0; i < buf.length; i++) {
            const x = (i / (buf.length - 1)) * width
            const y = height / 2 + ((buf[i] - 128) / 128) * (height / 2) * 0.92
            if (i === 0) ctx2d.moveTo(x, y)
            else ctx2d.lineTo(x, y)
          }
          ctx2d.stroke()
        }
        draw()
        return () => window.cancelAnimationFrame(rafRef.current)
      }, [state.micOn, galaxy])
      return h('section', { className: 'mv-card' },
        h('header', { className: 'mv-card-head' },
          h('span', null, '音频'),
          h('span', { className: 'mv-card-tools' },
            h('span', { className: 'mv-tip' }, state.micOn ? (galaxy ? '外部采集' : (state.listening ? '在听…' : '麦克风开')) : '麦克风关'),
            h(SourcePicker, { kind: 'mic' }))),
        h('div', { className: 'mv-card-body', style: { aspectRatio: '16/7' } }, h('canvas', { ref: canvasRef })),
        state.heard.length
          ? h('div', { className: 'mv-log' }, state.heard.map((item, index) => h('div', { className: 'mv-log-item', key: index },
            h('b', null, '听到：'), item.text,
            item.steered ? h('span', { className: 'mv-tip' }, '（已插话）') : null,
            item.reason ? h('span', { className: 'mv-tip' }, '（' + item.reason + '，未插话）') : null)))
          : h('p', { className: 'mv-tip' }, galaxy
            ? '人声来自外部采集器，由宿主按 mic.vad 断句后送识别。'
            : (state.features.asr ? '打开麦克风后，说的话会在这里显示，并自动插话进会话。' : '语音识别未启用：在「设置 · 形象」里打开。')))
    }

    /** 侧边栏「表情」：互斥表情单击切换；开关/动作类可多个同时打开。 */
    function ExpressionPanel() {
      const state = useStore()
      const expressions = state.expressions || []
      if (expressions.length === 0) {
        return h('section', { className: 'mv-card' },
          h('header', { className: 'mv-card-head' }, h('span', null, 'LIVE2D 表情')),
          h('p', { className: 'mv-tip' }, state.current
            ? '当前模型没有导出表情文件（.exp3.json）。'
            : '还没有可用的模型：在「设置 · 形象」里指定模型目录。'),
          state.missing.length
            ? h('p', { className: 'mv-err' }, '缺资源：' + state.missing.slice(0, 4).map((m) => m.file).join('、'))
            : null)
      }
      const single = expressions.filter((item) => !item.additive)
      const additive = expressions.filter((item) => item.additive)
      const toggle = async (name, kind) => {
        const nextExpression = kind === 'single' ? (state.expression === name ? '' : name) : state.expression
        let nextToggles = Array.isArray(state.toggles) ? state.toggles.slice() : []
        if (kind === 'additive') {
          nextToggles = nextToggles.includes(name) ? nextToggles.filter((x) => x !== name) : nextToggles.concat(name)
        }
        emit({ expression: nextExpression, toggles: nextToggles })
        if (stage) await stage.applyExpressions(nextExpression, nextToggles)
        try {
          await postJson('/state', { expression: nextExpression, toggles: nextToggles })
        } catch (error) {
          notice('error', '保存表情状态失败：' + (error && error.message ? error.message : error))
        }
      }
      return h('section', { className: 'mv-card' },
        h('header', { className: 'mv-card-head' },
          h('span', null, 'LIVE2D 表情'),
          h('button', {
            type: 'button',
            className: 'mv-chip',
            onClick: () => { void toggle('', 'single') },
            title: '恢复默认表情',
          }, '默认')),
        single.length
          ? h('div', { className: 'mv-chips' }, single.map((item) => h('button', {
            key: item.name,
            type: 'button',
            className: 'mv-chip',
            'data-on': state.expression === item.name ? '1' : '0',
            onClick: () => { void toggle(item.name, 'single') },
          }, item.name)))
          : null,
        additive.length
          ? h('div', { className: 'mv-chips' }, additive.map((item) => h('button', {
            key: item.name,
            type: 'button',
            className: 'mv-chip',
            'data-on': (state.toggles || []).includes(item.name) ? '1' : '0',
            onClick: () => { void toggle(item.name, 'additive') },
          }, item.name)))
          : null,
        h('p', { className: 'mv-tip' }, '「表情-*」一次只显示一个；「开关-*」「动作-*」可以一起打开。'))
    }

    /* ── 频谱环（任务书功能点9） ──────────────────────────────
     * 为什么要有它：形象区原来只有一块 WebGL canvas，只要模型没加载出来（没模型、模型坏、
     * WebGL 上下文丢了）或者被隐藏，那一块就是**空白**。频谱环是纯 2D canvas 的背景层，
     * 永远在画：
     *   · 麦克风开着 → 用麦克风的 AnalyserNode 画真实频谱；
     *   · 模型正在说话 → 用 TTS 播放的 AnalyserNode；
     *   · 都不是 → 一段缓慢的呼吸波形（不装假数据，只是"它还活着"的视觉）。
     * 颜色只吃主题变量（从 canvas 的 currentColor 取），不写死色值。
     */
    function SpectrumRing() {
      const ref = React.useRef(null)
      const state = useStore()
      const stateRef = React.useRef(state)
      stateRef.current = state

      React.useEffect(() => {
        const canvas = ref.current
        if (!canvas) return undefined
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return undefined
        let raf = 0
        let color = { r: 127, g: 127, b: 127 }
        try {
          const css = window.getComputedStyle(canvas).color || ''
          const match = /rgba?\(([^)]+)\)/.exec(css)
          if (match) {
            const parts = match[1].split(',').map((x) => parseFloat(x))
            if (parts.length >= 3 && parts.every((x) => Number.isFinite(x))) {
              color = { r: parts[0], g: parts[1], b: parts[2] }
            }
          }
        } catch { /* 主题变量取不到就用中性灰 */ }

        const BARS = 96
        let pick = null
        let bin = null
        const draw = (time) => {
          raf = window.requestAnimationFrame(draw)
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const width = Math.max(80, Math.round(canvas.clientWidth * dpr))
          const height = Math.max(80, Math.round(canvas.clientHeight * dpr))
          if (canvas.width !== width) canvas.width = width
          if (canvas.height !== height) canvas.height = height
          ctx2d.clearRect(0, 0, width, height)

          // 选一个"活的"音源：麦克风优先，其次 TTS 播放
          const analyser = (capture.micLive && capture.analyser)
            ? capture.analyser
            : (stage && stage.analyser && stage.audio && !stage.audio.paused ? stage.analyser : null)
          if (analyser && analyser !== pick) {
            pick = analyser
            bin = new Uint8Array(analyser.frequencyBinCount)
          }
          let data = null
          if (analyser && bin) {
            try {
              analyser.getByteFrequencyData(bin)
              data = bin
            } catch {
              data = null
            }
          }

          const cx = width / 2
          const cy = height / 2
          // 尺寸：用户要求「小到现在的一半」（原 0.30 / 0.22 → 0.15 / 0.11）
          const base = Math.min(width, height) * 0.15
          const span = Math.min(width, height) * 0.11
          const t = time / 1000
          // 彩色：色相随时间和角度转，亮度跟着音量抬一点（主题色只作为极淡的底光）
          const hueShift = (t * 14) % 360
          const hueOf = (i) => (hueShift + (i / BARS) * 340) % 360

          // 内圈柔光（两段色相，慢速对流）
          const glowHueA = (hueShift + 190) % 360
          const glowHueB = (hueShift + 320) % 360
          const glow = ctx2d.createRadialGradient(cx, cy, base * 0.3, cx, cy, base + span)
          glow.addColorStop(0, 'hsla(' + glowHueA.toFixed(1) + ',92%,62%,0.20)')
          glow.addColorStop(0.55, 'hsla(' + glowHueB.toFixed(1) + ',92%,60%,0.10)')
          glow.addColorStop(1, 'hsla(' + glowHueB.toFixed(1) + ',92%,60%,0)')
          ctx2d.fillStyle = glow
          ctx2d.beginPath()
          ctx2d.arc(cx, cy, base + span, 0, Math.PI * 2)
          ctx2d.fill()

          // 环上的频谱竖条（彩虹渐变，亮度跟着音量）
          ctx2d.lineWidth = Math.max(1.4 * dpr, width / 480)
          ctx2d.lineCap = 'round'
          for (let i = 0; i < BARS; i++) {
            const angle = (i / BARS) * Math.PI * 2 - Math.PI / 2
            let value
            if (data) {
              const index = Math.floor((i / BARS) * (data.length * 0.55))
              value = (data[index] || 0) / 255
            } else {
              // 空闲：两条不同频率的正弦叠加，慢慢呼吸
              value = 0.16 + 0.12 * (Math.sin(t * 0.9 + i * 0.28) * 0.5 + 0.5) * (Math.sin(t * 0.37) * 0.35 + 0.65)
            }
            const inner = base + span * 0.10
            const outer = inner + span * (0.12 + value * 0.88)
            const x1 = cx + Math.cos(angle) * inner
            const y1 = cy + Math.sin(angle) * inner
            const x2 = cx + Math.cos(angle) * outer
            const y2 = cy + Math.sin(angle) * outer
            const alpha = 0.22 + value * 0.68
            const lightness = 54 + value * 20
            ctx2d.strokeStyle = 'hsla(' + hueOf(i).toFixed(1) + ',90%,' + lightness.toFixed(1) + '%,' + alpha.toFixed(3) + ')'
            ctx2d.beginPath()
            ctx2d.moveTo(x1, y1)
            ctx2d.lineTo(x2, y2)
            ctx2d.stroke()
          }

          // 细环基线：能用 conic 渐变就用（彩虹环），否则退回单色
          ctx2d.lineWidth = Math.max(1, dpr * 0.9)
          const ringRadius = base + span * 0.10
          if (typeof ctx2d.createConicGradient === 'function') {
            const conic = ctx2d.createConicGradient(t * 0.3, cx, cy)
            for (let step = 0; step <= 12; step++) {
              conic.addColorStop(step / 12, 'hsla(' + ((hueShift + step * 30) % 360).toFixed(1) + ',92%,64%,0.55)')
            }
            ctx2d.strokeStyle = conic
          } else {
            ctx2d.strokeStyle = 'hsla(' + glowHueA.toFixed(1) + ',92%,64%,0.4)'
          }
          ctx2d.beginPath()
          ctx2d.arc(cx, cy, ringRadius, 0, Math.PI * 2)
          ctx2d.stroke()
        }
        raf = window.requestAnimationFrame(draw)
        return () => window.cancelAnimationFrame(raf)
      }, [])

      return h('canvas', {
        ref,
        className: 'mv-ring',
        style: { color: 'var(--dsw-alias-label-secondary, currentColor)' },
        'aria-hidden': 'true',
        'data-muse-vtuber': 'spectrum-ring',
        'data-active': state.micOn || state.speaking ? '1' : '0',
      })
    }

    /**
     * 「这台机器没有这个设备」——与权限被拒/被占用不同：不是故障，该提示一次就停手
     * （否则每次重渲染再调一次 getUserMedia，控制台和界面都会被同一条错误刷满）。
     */
    function isMissingDevice(error) {
      const name = error && error.name ? String(error.name) : ''
      const raw = error && error.message ? String(error.message) : String(error)
      return name === 'NotFoundError' || name === 'DevicesNotFoundError'
        || /Requested device not found/i.test(raw)
        || /no (audio|video) (input|source)/i.test(raw)
    }

    /** 把 getUserMedia 的 DOMException 翻成人话（不同名称对应完全不同的处置）。 */
    function explainMediaError(error, kind) {
      const name = error && error.name ? String(error.name) : ''
      const raw = error && error.message ? String(error.message) : String(error)
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || /Requested device not found/i.test(raw)) {
        return (kind === 'camera' ? '这台设备没有可用的摄像头' : '这台设备没有可用的麦克风')
          + '（插上设备后在设置里重新打开即可；形象和频谱环不受影响）'
      }
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return (kind === 'camera' ? '摄像头' : '麦克风') + '权限被拒绝：在浏览器地址栏的权限图标里允许一次'
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        return (kind === 'camera' ? '摄像头' : '麦克风') + '被别的程序占用（会议/直播软件常见）：关掉那个程序再试'
      }
      if (name === 'OverconstrainedError') {
        return '设置里的设备参数不被支持：把「设备 deviceId / 分辨率」清空后重试'
      }
      return (kind === 'camera' ? '摄像头' : '麦克风') + '打开失败：' + raw
    }

    /** 面板级错误边界：任何一个面板抛错都不许把整页渲染带没（React 无边界时会卸载整棵树）。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[muse_vtuber] ' + (this.props && this.props.name ? this.props.name : 'panel') + ' 渲染失败', error)
      }

      render() {
        if (this.state.error) {
          return h('p', { className: 'mv-err' },
            (this.props && this.props.name ? this.props.name : '面板') + '渲染失败：'
            + String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error))
        }
        return this.props.children
      }
    }

    function AvatarView(props) {
      const state = useStore()
      const viewRef = React.useRef(null)
      const stageBoxRef = React.useRef(null)
      const videoRef = React.useRef(null)
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''

      // 会话 id 记在共享状态里：语音识别要带上它，宿主才知道往哪个会话插话
      React.useEffect(() => {
        if (sessionId) emit({ sessionId })
      }, [sessionId])

      // 舞台生命周期：挂载 → 建 PIXI/LIVE2D；卸载 → 销毁（页签切回来再建）
      React.useEffect(() => {
        const box = stageBoxRef.current
        if (!box) return undefined
        const instance = new Stage(box)
        stage = instance
        let alive = true
        // 新挂载先清掉上一次留下的舞台错误，免得切回来还挂着旧提示
        emit({ modelReady: false, stageError: '' })
        instance.init()
          .then(async () => {
            // 先等 bootstrap 拿到模型清单：页签比 apply 先挂载时清单还是空的，
            // 直接 setModel 会白报一句「没有可用模型」。
            await ensureBoot()
            if (!alive) return
            await instance.setModel(store.model || store.current)
            await instance.applyExpressions(store.expression, store.toggles)
          })
          .catch((error) => {
            const text = 'LIVE2D 初始化失败：' + (error && error.message ? error.message : error)
            // 舞台挂了也不许把形象区变成空白：频谱环还在，这里只把原因写出来
            emit({ modelReady: false, stageError: text })
            notice('error', text)
          })
        return () => {
          alive = false
          if (stage === instance) stage = null
          instance.destroy()
        }
      }, [])

      /**
       * 把整块视图钉在「当前可视区」里（用户报过：进来时模型显示不全，要往上滑）。
       *
       * 原因：`.mv-view{height:100%}` 在宿主那个高度是 auto 的槽位里解析不出来，
       * 于是网格行被右侧栏内容撑高，主位那一格跟着变高、画布比可视区还高 —— 模型是底部对齐的，
       * 结果只看到下半身，得往上滑。
       * 做法：量一次视图顶部到窗口底部的距离，直接给 `.mv-view` 一个像素高度；右侧栏自己滚
       * （`.mv-side{overflow:auto;min-height:0}`），主位因此永远等于可视高度、模型完整显示。
       */
      React.useEffect(() => {
        /**
         * 关键教训：**不能拿 `window.innerHeight - el.getBoundingClientRect().top` 当可用高度**。
         * 切到「形象」时外层滚动容器还停在对话页的滚动位置，我们这块的 top 可能比视口还靠下 →
         * 相减得负 → 被下限夹成 240px 高的舞台 → 模型按高度缩放后宽度正好跟右边栏差不多
         * （用户看到的「模型只有右边栏那么大」）。
         * 正确做法：找最近的**可滚动祖先**，用它自己的 clientHeight（确定值）+ 我们相对它的偏移，
         * 并且顺手把它的 scrollTop 归零（切页签不该继承上一个视图的滚动位置）。
         */
        const scrollParentOf = (node) => {
          let cur = node && node.parentElement
          while (cur && cur !== document.body && cur !== document.documentElement) {
            let style = null
            try {
              style = window.getComputedStyle(cur)
            } catch { /* 忽略 */ }
            if (style && /(auto|scroll)/.test(String(style.overflowY)) && cur.clientHeight > 0) return cur
            cur = cur.parentElement
          }
          return null
        }

        const fit = () => {
          const el = viewRef.current
          if (!el) return
          const scroller = scrollParentOf(el)
          if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0
          let avail
          if (scroller && scroller.clientHeight > 200) {
            const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            avail = scroller.clientHeight - Math.max(0, offset) - 8
          } else {
            avail = window.innerHeight - Math.max(0, el.getBoundingClientRect().top) - 12
          }
          // 下限 320（足够看清模型），上限不超出窗口（免得顶到底部工具栏外面）
          const height = Math.max(320, Math.min(Math.round(avail), Math.round(window.innerHeight - 140)))
          if (Math.abs((el.offsetHeight || 0) - height) > 2) el.style.height = height + 'px'
        }
        fit()
        window.addEventListener('resize', fit)
        const observer = typeof window.ResizeObserver === 'function'
          ? new window.ResizeObserver(fit)
          : null
        // 观察 body 与父节点：页签切换、输入框长高、右侧栏内容变化都会改可用高度
        if (observer) {
          observer.observe(document.body)
          const parent = viewRef.current && viewRef.current.parentElement
          if (parent) observer.observe(parent)
        }
        // 首帧布局可能还在动（页签刚切过来），补量几次
        const timers = [120, 320, 700].map((ms) => window.setTimeout(fit, ms))
        return () => {
          window.removeEventListener('resize', fit)
          if (observer) {
            try {
              observer.disconnect()
            } catch { /* 忽略 */ }
          }
          for (const timer of timers) window.clearTimeout(timer)
        }
      }, [])

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'mv-view', ref: viewRef },
          h('div', { className: 'mv-main' },
            // 频谱环永远在最底层；没模型 / 模型隐藏时它就是画面本体，**不叠任何文字**
            // （用户口径：没有模型时环上不要有字；出错也只在侧边栏 footer 里说）
            h(SpectrumRing),
            // 舞台始终是同一个 DOM（只切透明度）：见 .mv-stage 注释，避免切换时丢 canvas
            h('div', {
              className: 'mv-stage',
              ref: stageBoxRef,
              'data-hidden': state.visible === false ? '1' : '0',
            }),
            state.bubble
              ? h('div', { className: 'mv-bubble' }, state.bubble)
              : null),
          h('aside', { className: 'mv-side' },
            h(PanelBoundary, { name: '「视频」面板' }, h(VideoPanel, { videoRef })),
            h(PanelBoundary, { name: '「音频」面板' }, h(AudioPanel)),
            h(PanelBoundary, { name: '「表情」面板' }, h(ExpressionPanel)),
            // 提醒沉到侧边栏最底（面板之后）：以前放在最上面，进来第一眼全是提示文字，
            // 而且把侧边栏撑高 → 主位被挤得比可视区还高（模型显示不全）
            h('div', { className: 'mv-side-footer' },
              state.notice
                ? h('p', { className: 'mv-notice', 'data-kind': state.notice.kind }, state.notice.text)
                : null,
              state.config && state.config.ui && state.config.ui.showHint
                ? h('p', { className: 'mv-tip' },
                  '点输入框里的「摄像头」「麦克风」开始。说话会自动断句识别并插话进本会话；模型说话时口型跟着音量动。')
                : null))))
    }

    /* ══════════════════════════════════════════════════════════
     * 8. 输入框按钮：摄像头 / 麦克风（功能点4–6）
     * ══════════════════════════════════════════════════════════ */

    function CameraButton() {
      const state = useStore()
      const busy = React.useRef(false)
      // 采集器源（muse_galaxy 等）：这个按钮只切"要不要接收那路流"，不去碰本机摄像头
      const external = String(state.cameraSource || 'device') === 'galaxy'
      const toggle = async () => {
        if (busy.current) return
        busy.current = true
        const next = !state.cameraOn
        try {
          if (!external) {
            if (next) await capture.startCamera(store.config?.camera)
            else capture.stopCamera()
          }
          emit({ cameraOn: next })
          await postJson('/state', { cameraOn: next, clientId: store.clientId || '' })
        } catch (error) {
          // 关键：失败**只**回退开关，不碰舞台。之前形象会消失，就是因为失败分支
          // 让上层重渲染时把挂 canvas 的节点换掉了。现在舞台节点恒定，环也在。
          notice('error', '摄像头：' + explainMediaError(error, 'camera'))
          emit({ cameraOn: capture.cameraLive })
        } finally {
          busy.current = false
        }
      }
      const label = external ? (state.cameraOn ? '停止接收外部采集' : '接收外部采集') : (state.cameraOn ? '关闭摄像头' : '打开摄像头')
      return h('button', {
        type: 'button',
        className: 'mv-btn',
        'data-on': state.cameraOn ? '1' : '0',
        title: label,
        'aria-label': label,
        'aria-pressed': state.cameraOn,
        onClick: () => { void toggle() },
      }, h(CameraIcon))
    }

    function MicButton() {
      const state = useStore()
      const busy = React.useRef(false)
      // 采集器源：只切"要不要接收那路音频"，不碰本机麦克风（断句在宿主侧按 mic.vad 做）
      const external = String(state.micSource || 'device') === 'galaxy'
      const toggle = async () => {
        if (busy.current) return
        busy.current = true
        const next = !state.micOn
        try {
          if (!external) {
            if (next) await capture.startMic(store.config?.mic)
            else capture.stopMic()
          }
          emit({ micOn: next })
          await postJson('/state', { micOn: next, clientId: store.clientId || '' })
        } catch (error) {
          notice('error', '麦克风：' + explainMediaError(error, 'mic'))
          emit({ micOn: capture.micLive })
        } finally {
          busy.current = false
        }
      }
      const label = external ? (state.micOn ? '停止接收外部音频' : '接收外部音频') : (state.micOn ? '关闭麦克风' : '打开麦克风')
      return h('button', {
        type: 'button',
        className: 'mv-btn',
        'data-on': state.micOn ? '1' : '0',
        title: label,
        'aria-label': label,
        'aria-pressed': state.micOn,
        onClick: () => { void toggle() },
      }, h(MicIcon))
    }

    /* ══════════════════════════════════════════════════════════
     * 9. 设置页（功能点8）
     * ══════════════════════════════════════════════════════════ */

    function toDraft(raw) {
      const v = raw && typeof raw === 'object' ? raw : {}
      const group = (name, keys) => {
        const source = v[name] && typeof v[name] === 'object' ? v[name] : {}
        const out = {}
        for (const key of keys) out[key] = source[key]
        return out
      }
      const draft = {
        live2d: group('live2d', ['modelsDir', 'model', 'width', 'height']),
        camera: group('camera', ['enabled', 'deviceId', 'width', 'height']),
        mic: group('mic', ['enabled', 'deviceId', 'sampleRate']),
        tts: group('tts', ['enabled', 'provider', 'base', 'model', 'voice', 'maxChars']),
        asr: group('asr', ['enabled', 'provider', 'base', 'model', 'language']),
        vision: group('vision', ['enabled', 'provider', 'base', 'model', 'prompt', 'autoIntervalMs']),
        events: group('events', ['enabled', 'steer', 'minIntervalMs', 'maxPerMin', 'cooldownKeyMs', 'voiceTemplate', 'visionTemplate']),
      }
      const micVad = v.mic && v.mic.vad && typeof v.mic.vad === 'object' ? v.mic.vad : {}
      draft.mic.vad = {
        threshold: micVad.threshold,
        silenceMs: micVad.silenceMs,
        minSpeechMs: micVad.minSpeechMs,
        maxMs: micVad.maxMs,
      }
      return draft
    }

    function SettingsSection() {
      const [values, setValues] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [apiKey, setApiKey] = React.useState('')
      const [keyConfigured, setKeyConfigured] = React.useState(false)
      const [configFile, setConfigFile] = React.useState('')
      const [credsFile, setCredsFile] = React.useState('')
      const [warnings, setWarnings] = React.useState([])
      const [runtime, setRuntime] = React.useState(null)
      const [notice, setNotice] = React.useState({ kind: 'loading', text: '正在读取形象配置…' })
      const [saving, setSaving] = React.useState(false)

      function readBack(json) {
        const draft = toDraft(json.values)
        setValues(draft)
        setBaseline(toDraft(json.values))
        setKeyConfigured(json.keyConfigured === true)
        if (typeof json.configFile === 'string') setConfigFile(json.configFile)
        if (typeof json.credsFile === 'string') setCredsFile(json.credsFile)
        setWarnings(Array.isArray(json.warnings) ? json.warnings.map(String) : [])
        if (json.runtime) setRuntime(json.runtime)
        if (json.configError && json.configError.message) {
          setNotice({ kind: 'error', text: '当前配置不可用：' + errorText(json.configError, 200) })
        }
      }

      React.useEffect(() => {
        let alive = true
        setNotice({ kind: 'loading', text: '正在读取形象配置…' })
        fetch(API + '/settings', { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((json) => ({ response, json })))
          .then(({ response, json }) => {
            if (!alive) return
            if (!response.ok || !json || json.ok !== true) {
              setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
              return
            }
            readBack(json)
            setNotice({ kind: 'info', text: '已读取当前配置；修改后点「保存」。TTS/ASR/识图改完立刻生效。' })
          })
          .catch((error) => {
            if (!alive) return
            setNotice({ kind: 'error', text: '读取失败：' + ((error && error.message) || String(error)) })
          })
        return () => {
          alive = false
        }
      }, [])

      const patch = (group, key, value) => setValues((prev) => (prev
        ? { ...prev, [group]: { ...prev[group], [key]: value } }
        : prev))

      async function save() {
        if (!values) return
        setSaving(true)
        setNotice({ kind: 'info', text: '正在保存…' })
        const body = { values }
        const trimmed = apiKey.trim()
        if (trimmed !== '') body.apiKey = trimmed
        try {
          const response = await fetch(API + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const json = await response.json().catch(() => ({}))
          if (!response.ok || !json || json.ok !== true) {
            setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
            return
          }
          setApiKey('')
          readBack(json)
          const changed = Array.isArray(json.changed) && json.changed.length ? json.changed.join('、') : '无改动'
          setNotice({ kind: 'success', text: '已保存：' + changed + (json.keyWritten ? '；API key 已写入 600 凭据文件' : '') })
          // 配置改了要重载页面上的模型清单（模型目录/模型名可能变了）
          try {
            const boot = await getJson('/bootstrap')
            emit({
              models: boot.models ? boot.models.models : [],
              current: boot.models ? boot.models.current : '',
              expressions: boot.models ? boot.models.expressions : [],
              missing: boot.models ? boot.models.missing : [],
            })
            if (stage && boot.models && boot.models.current) await stage.setModel(boot.models.current)
          } catch { /* 清单刷新失败不影响保存 */ }
        } catch (error) {
          setNotice({ kind: 'error', text: '保存失败：' + ((error && error.message) || String(error)) })
        } finally {
          setSaving(false)
        }
      }

      if (!values) {
        return h('section', { className: 'mv-set', 'aria-label': '形象设置' },
          h('style', null, CSS),
          h('header', null,
            h('h2', { className: 'mv-set-title' }, '形象'),
            h('p', { className: 'mv-set-sub' }, 'LIVE2D 形象、摄像头麦克风、阿里云语音与识图。')),
          h('p', { className: 'mv-notice', 'data-kind': notice.kind, role: 'status' }, notice.text))
      }

      const row = (label, control, hint) => h('div', { className: 'mv-set-row', key: label },
        h('span', { className: 'mv-set-label' }, label),
        h('div', { className: 'mv-set-mid' }, control, hint ? h('p', { className: 'mv-set-hint' }, hint) : null))

      const text = (group, key, hint, placeholder) => row(
        key,
        h('input', {
          className: 'mv-set-input',
          type: key === 'prompt' ? 'text' : 'text',
          value: values[group][key] === undefined || values[group][key] === null ? '' : values[group][key],
          placeholder: placeholder || '',
          spellCheck: false,
          onChange: (event) => patch(group, key, event.target.value),
        }),
        hint,
      )

      const number = (group, key, hint, min, max) => row(
        key,
        h('input', {
          className: 'mv-set-input',
          type: 'number',
          min,
          max,
          value: values[group][key] === undefined || values[group][key] === null ? '' : values[group][key],
          onChange: (event) => patch(group, key, event.target.value === '' ? '' : Number(event.target.value)),
        }),
        hint,
      )

      /** mic.vad.* 是嵌套一层，单独一个 helper（label 必须唯一，否则 React 会警告重复 key）。 */
      const numberVad = (key, label, hint, min, max) => row(
        label,
        h('input', {
          className: 'mv-set-input',
          type: 'number',
          min,
          max,
          value: values.mic.vad && values.mic.vad[key] !== undefined && values.mic.vad[key] !== null
            ? values.mic.vad[key]
            : '',
          onChange: (event) => setValues((prev) => (prev
            ? { ...prev, mic: { ...prev.mic, vad: { ...prev.mic.vad, [key]: event.target.value === '' ? '' : Number(event.target.value) } } }
            : prev)),
        }),
        hint,
      )

      const check = (group, key, label, hint) => row(
        label,
        h('label', { className: 'mv-set-check' },
          h('input', {
            type: 'checkbox',
            checked: values[group][key] === true,
            onChange: (event) => patch(group, key, event.target.checked),
          }),
          h('span', null, label)),
        hint,
      )

      const models = runtime && runtime.models ? runtime.models : null

      return h('section', { className: 'mv-set', 'aria-label': '形象设置' },
        h('style', null, CSS),
        h('header', null,
          h('h2', { className: 'mv-set-title' }, '形象'),
          h('p', { className: 'mv-set-sub' },
            '「形象」页签的 LIVE2D、摄像头/麦克风、阿里云语音合成、语音识别与图像识别。保存会原子写回 config.json；'
            + 'API key 单独写 600 凭据文件，永不回显。')),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, 'LIVE2D'),
          row('模型',
            h('select', {
              className: 'mv-set-input',
              value: values.live2d.model || '',
              onChange: (event) => patch('live2d', 'model', event.target.value),
            },
            h('option', { value: '' }, '（不显示模型，只显示频谱环）'),
            (models && models.models ? models.models : []).map((item) => h('option', { key: item.name, value: item.name }, item.name))),
            models
              ? '选完保存**立即切换**；空白 = 不显示模型（只显示频谱环）。目录：' + models.dir + '（来源：' + models.dirSource + '）'
              : '模型清单读不到，检查下面的「模型目录」。'),
          text('live2d', 'modelsDir', '留空 = 依次找 $DSH_HOME/mira_config/muse_vtuber/model、mira_config/mira_live2d/model', '绝对路径，可留空'),
          number('live2d', 'width', '初始画布宽度（像素）', 200, 4096),
          number('live2d', 'height', '初始画布高度（像素）', 200, 4096),
          models && models.missing && models.missing.length
            ? h('p', { className: 'mv-err' }, '缺资源：' + models.missing.map((m) => m.file).join('、') + '（放进 ' + models.dir + '/' + models.current + '/）')
            : null),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '摄像头 / 麦克风'),
          check('camera', 'enabled', '允许打开摄像头', '关掉后输入框的「摄像头」按钮会明确报错。'),
          text('camera', 'deviceId', '留空 = 浏览器默认设备；要钉死某台设备就填它的 deviceId', ''),
          number('camera', 'width', '请求分辨率：宽（浏览器会给最接近的档位）', 160, 4096),
          number('camera', 'height', '请求分辨率：高', 120, 4096),
          check('mic', 'enabled', '允许打开麦克风', '关掉后「麦克风」按钮与语音识别都不可用。'),
          text('mic', 'deviceId', '留空 = 浏览器默认输入设备；要钉死某支麦克风就填它的 deviceId', ''),
          number('mic', 'sampleRate', '送识别的采样率（默认 16000）', 8000, 48000),
          numberVad('threshold', '断句阈值', '0.001–0.5，越大越不灵敏；安静环境用默认 0.02。', 0.001, 0.5),
          numberVad('silenceMs', '静音多久算一句', '毫秒。默认 650：说完停顿这么久就断句送去识别。', 150, 5000),
          numberVad('minSpeechMs', '最短算说话的时长', '毫秒。默认 320：太短的杂音不会触发识别。', 100, 5000),
          numberVad('maxMs', '一句话最长时长', '毫秒。默认 15000：超了强制切段，避免一直不断句。', 1000, 120000)),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '语音合成（TTS）'),
          check('tts', 'enabled', '启用 TTS', '关掉后 vtuber_say 会明确报 config/missing。'),
          row('合成方式',
            h('select', {
              className: 'mv-set-input',
              value: values.tts.provider || 'aliyun',
              onChange: (event) => patch('tts', 'provider', event.target.value),
            },
            h('option', { value: 'aliyun' }, '千问原生口（/services/audio/tts/SpeechSynthesizer）'),
            h('option', { value: 'openai' }, 'OpenAI 兼容口（/audio/speech）')),
            '原生口用 api/v1（实测可用），兼容口用 compatible-mode/v1 —— base 要跟着这个选项写。'),
          text('tts', 'base', '地址（默认 token-plan 的 api/v1）', 'https://token-plan.maas.qianwenaiapi.com/api/v1'),
          text('tts', 'model', '模型名（默认 qwen-audio-3.0-tts-plus）', 'qwen-audio-3.0-tts-plus'),
          text('tts', 'voice', '音色（Qwen-Audio-TTS 是 longan* 系列，如 longanhuan_v3.6）', 'longanhuan_v3.6'),
          number('tts', 'maxChars', '单次最长字数，超了截断并回报 truncated', 1, 8000)),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '语音识别（ASR）'),
          check('asr', 'enabled', '启用语音识别', '关掉只显示波形，不识别、不插话。'),
          row('识别方式',
            h('select', {
              className: 'mv-set-input',
              value: values.asr.provider || 'aliyun',
              onChange: (event) => patch('asr', 'provider', event.target.value),
            },
            h('option', { value: 'aliyun' }, '千问原生口（多模态生成，实测可用）'),
            h('option', { value: 'openai' }, 'OpenAI 兼容口（/audio/transcriptions）')),
            '原生口用 api/v1，兼容口用 compatible-mode/v1 —— base 要跟着这个选项写。'),
          text('asr', 'base', '地址（默认 token-plan 的 api/v1）', 'https://token-plan.maas.qianwenaiapi.com/api/v1'),
          text('asr', 'model', '模型名（默认 qwen-audio-3.0-asr-flash）', 'qwen-audio-3.0-asr-flash'),
          text('asr', 'language', '语言（zh / en…）', 'zh')),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '图像识别'),
          check('vision', 'enabled', '启用图像识别', '关掉后 vtuber_look 会明确报 config/missing。'),
          row('识别方式',
            h('select', {
              className: 'mv-set-input',
              value: values.vision.provider || 'dsh',
              onChange: (event) => patch('vision', 'provider', event.target.value),
            },
            h('option', { value: 'dsh' }, 'dsh：交给当前会话模型看（默认，不花第三方额度）'),
            h('option', { value: 'aliyun' }, 'aliyun：服务端 qwen-vl 返回一段文字')),
            'dsh 走宿主的图片附件（和 read_image 同一条路），模型要能接收图片输入；'
            + '自动识图（下面的间隔）不经过模型，仍走 aliyun。'),
          text('vision', 'base', '原生口（默认 token-plan 的 api/v1）', 'https://token-plan.maas.qianwenaiapi.com/api/v1'),
          text('vision', 'model', '模型名（默认 qwen-vl-max-latest）', 'qwen-vl-max-latest'),
          text('vision', 'prompt', '默认提示词（问它画面里发生了什么）', ''),
          number('vision', 'autoIntervalMs', '自动识图间隔（毫秒，0 = 关；开了会定时抓帧识别并插话）', 0, 3600000)),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '事件流'),
          check('events', 'enabled', '识别结果自动进入会话', '关掉后识别结果只显示在侧边栏，不插话。'),
          check('events', 'steer', '用插话（steer）投递', '关掉 = 只记在侧边栏，不打扰会话。'),
          number('events', 'minIntervalMs', '两条之间最小间隔（毫秒）', 0, 3600000),
          number('events', 'maxPerMin', '每分钟最多几条', 1, 600),
          number('events', 'cooldownKeyMs', '同一句话的冷却（毫秒）', 0, 86400000),
          text('events', 'voiceTemplate', '语音事件的提示词模板（{text} 会被替换）', '[感知·语音] {text}'),
          text('events', 'visionTemplate', '画面事件的提示词模板', '[感知·画面] {text}')),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '阿里云 API key'),
          row('API key',
            h('input', {
              className: 'mv-set-input',
              type: 'password',
              value: apiKey,
              autoComplete: 'off',
              placeholder: keyConfigured ? '已配置，留空 = 不改' : '未配置，填入后保存',
              onChange: (event) => setApiKey(event.target.value),
            }),
            keyConfigured
              ? '当前已配置（只显示状态，永不回显）；留空保存不会覆盖。'
              : '未配置。保存后写进 ' + (credsFile || 'creds/dashscope.json') + '（权限 600）。')),
        h('div', { className: 'mv-set-actions' },
          h('button', {
            type: 'button',
            className: 'mv-set-button',
            disabled: saving,
            onClick: () => { void save() },
          }, saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'mv-set-button',
            disabled: saving || !baseline,
            onClick: () => {
              if (!baseline) return
              setValues(toDraft(baseline))
              setApiKey('')
              setNotice({ kind: 'info', text: '已撤销未保存的改动。' })
            },
          }, '撤销改动')),
        h('p', { className: 'mv-notice', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, notice.text),
        warnings.length
          ? h('ul', { className: 'mv-set-hint' }, warnings.map((warning, index) => h('li', { key: index }, warning)))
          : null,
        configFile ? h('p', { className: 'mv-set-hint' }, '配置文件：' + configFile) : null,
        credsFile ? h('p', { className: 'mv-set-hint' }, '凭据文件：' + credsFile + '（600，永不回显）') : null)
    }

    /* ══════════════════════════════════════════════════════════
     * 10. 启动：拉一次 bootstrap + 接事件流
     * ══════════════════════════════════════════════════════════ */

    let bootPromise = null
    function bootstrap() {
      if (bootPromise) return bootPromise
      bootPromise = (async () => {
        try {
          const boot = await getJson('/bootstrap')
          const models = boot.models || {}
          emit({
            ready: true,
            bootError: null,
            config: boot.config,
            features: boot.features ? {
              tts: !!(boot.features.tts && boot.features.tts.enabled),
              asr: !!(boot.features.asr && boot.features.asr.enabled),
              vision: !!(boot.features.vision && boot.features.vision.enabled),
            } : store.features,
            featuresConfigured: boot.features ? boot.features.configured : false,
            models: models.models || [],
            current: models.current || '',
            expressions: models.expressions || [],
            missing: models.missing || [],
            model: (boot.state && boot.state.model) || models.current || '',
            expression: (boot.state && boot.state.expression) || '',
            toggles: (boot.state && boot.state.toggles) || [],
            motion: (boot.state && boot.state.motion) || '',
            visible: !(boot.state && boot.state.visible === false),
            cameraOn: !!(boot.state && boot.state.cameraOn),
            micOn: !!(boot.state && boot.state.micOn),
          })
          if (!boot.features || boot.features.configured !== true) {
            notice('info', '还没配置阿里云 API key：语音合成/识别/识图会报 creds/missing。到「设置 · 形象」里填。')
          }
          ensureStream()
          await reconcileCapture()
        } catch (error) {
          emit({ ready: true, bootError: error && error.message ? error.message : String(error) })
          notice('error', '形象接口读不到：' + (error && error.message ? error.message : error))
        }
      })()
      return bootPromise
    }

    /** 所有注册点的公共初始化（谁先挂载谁触发，只跑一次）。 */
    function ensureBoot() {
      if (bootPromise) return bootPromise
      const promise = bootstrap()
      // 自动识图：宿主配置了 autoIntervalMs 就定时抓帧识别（0 = 关）
      return promise.then(() => {
        startAutoVision()
        return promise
      })
    }

    let autoVisionTimer = null
    /**
     * 自动识图调度：每轮**重新读**配置里的 `vision.autoIntervalMs`，所以
     * 设置页改完（哪怕改成 0 = 关）不用刷新页面，下一轮就按新值走。
     * 默认 0 = 关：定时抓帧会持续消耗 qwen-vl 额度，要开就显式开。
     */
    function startAutoVision() {
      if (autoVisionTimer) return
      const loop = () => {
        const interval = Number(store.config && store.config.vision && store.config.vision.autoIntervalMs) || 0
        // 关着的时候慢速轮询，只为发现「设置页把它打开了」
        const wait = interval > 0 ? Math.max(1500, interval) : 5000
        autoVisionTimer = window.setTimeout(async () => {
          if (interval > 0 && capture.cameraLive && store.sessionId) {
            try {
              await autoVisionTick()
            } catch { /* 单次失败不打断调度 */ }
          }
          loop()
        }, wait)
      }
      loop()
    }

    async function autoVisionTick() {
      // 采集器源时由宿主侧驱动识图（帧就在宿主内存里），浏览器别再抢着抓一次
      if (String(store.cameraSource || 'device') === 'galaxy') return
      // 同上：用隐藏 video 抓帧，页签在不在「形象」都能抓
      const image = capture.frameImage()
      if (!image) return
      try {
        const result = await postJson('/vision', { image, sessionId: store.sessionId, auto: true })
        const text = String(result.text || '').trim()
        if (text === '') return
        emit({
          seen: [{
            text,
            at: new Date().toISOString(),
            steered: result.steered === true,
            reason: result.steer && result.steer.reason ? result.steer.reason : '',
          }, ...store.seen].slice(0, 5),
        })
      } catch (error) {
        notice('error', '图像识别失败：' + (error && error.message ? error.message : error))
      }
    }

    /* ══════════════════════════════════════════════════════════
     * 11. 导出：三个槽位注册
     * ══════════════════════════════════════════════════════════ */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          void ensureBoot()
          return () => {
            if (autoVisionTimer) {
              window.clearTimeout(autoVisionTimer)
              autoVisionTimer = null
            }
            if (stream) {
              try {
                stream.close()
              } catch { /* 忽略 */ }
              stream = null
            }
            capture.stopCamera()
            capture.stopMic()
          }
        })

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'muse-avatar',
          order: 20,
          label: () => '形象',
        }, AvatarView))

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'muse-avatar-devices',
          order: 10,
          label: () => '摄像头/麦克风',
        }, function DeviceButtons(props) {
          const state = useStore()
          const sessionId = props && props.sessionId ? String(props.sessionId) : ''
          React.useEffect(() => {
            void ensureBoot()
          }, [])
          React.useEffect(() => {
            if (sessionId) emit({ sessionId })
          }, [sessionId])
          if (!state.ready) return h('span', { style: { display: 'none' } })
          return h(React.Fragment, null,
            // 输入框里的按钮也要有样式：这段 CSS 原来只在「形象」页签和设置页渲染，
            // 所以「对话」「轨迹」里的两个按钮拿到的是浏览器默认按钮外观（空框框）。
            h('style', null, CSS),
            h('span', {
              style: { display: 'inline-flex', alignItems: 'center', gap: '2px' },
              'data-muse-vtuber': 'device-buttons',
            }, [h(CameraButton, { key: 'camera' }), h(MicButton, { key: 'mic' })]))
        }))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'muse-avatar',
          order: 47,
          label: () => '形象',
        }, SettingsSection))
      },
    }
}

for (const id of ['muse_vtuber', 'muse_vtuber_ui']) {
  try {
    window.__ModuleLoader__.load({ id, factory: museVtuberClient })
  } catch (error) {
    console.error('[muse_vtuber] 注册 client 模块失败：' + id, error)
  }
}
