/**
 * muse_vtuber — 客户端模块（浏览器侧）：「形象」页签 + 设置页「形象」
 *
 * 两个注册点：
 *   conversation.view   → 「形象」页签（对话 / 轨迹之后）：主位 LIVE2D + 频谱环，右侧栏是
 *                          视频 / 音频 / 表情。视频与音频**的数据来自 mira_device**（页面全局
 *                          `window.__miraDevice__` 与 `/device/api/stream.mjpg`），
 *                          气泡与口型**订阅 mira_media 的播放状态**（`window.__miraDevice__`）。
 *   settings.section    → 设置页「形象」：模型目录、模型、画布尺寸（key 在「声音」，设备在「输入」）。
 *
 * 事实源：
 *   · 本模块只做"画"：模型清单/表情/动作来自宿主 `/vtuber/api/*`，声音与输入来自另外两个插件。
 *   · 面板不自己申请摄像头/麦克风 —— 那是 mira_device 的采集单例，这里只拿它的流/电平/日志。
 *   · 口型不自己播音频 —— 声音由 mira_media 的全局播放器播（两个插件都播会变成双重声音），
 *     这里只读它算好的 0..1 电平。
 *   · 这个文件是**浏览器模块**，不是 Node 模块：只能用浏览器 API，`node --check` 只保语法。
 */

/**
 * 注册 id 必须等于宿主认的**包 specifier**（`dsh-client-modules` 取的是 loader 条目的
 * `fiber.entry?.options.name`，加载完还会校验「bundle 有没有用这个 id 注册」）。
 * 同一个包可能以不同 specifier 装进 profile，所以两个 id 都注册：只有宿主清单里那个会被真正
 * import，另一个只是躺着的工厂。
 */
function museVtuberClient(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/vtuber/api'
    const ASSET = '/vtuber/assets'
    const MODEL_BASE = '/vtuber/models/'
    // 输入侧（mira_device）的采集口：外部采集器的 MJPEG 画面
    const INPUT_CAPTURE_URL = '/device/api/stream.mjpg'

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
     * 1. 共享状态（模块级单例：页签与设置页共用）
     * ══════════════════════════════════════════════════════════ */

    const store = {
      ready: false,
      bootError: null,
      // 形象自己的状态（模型/表情/动作/可见性）
      visible: true,
      model: '',
      expression: '',
      toggles: [],
      motion: '',
      // 模型清单与能力
      models: [],
      expressions: [],
      motions: [],
      current: '',
      missing: [],
      config: null,
      deps: { audio: false, input: false },
      sessionId: '',
      // 舞台状态：没有模型（或加载失败）时由「频谱环」兜底显示，不留白屏
      modelReady: false,
      stageError: '',
      // 说话（来自 mira_media）：气泡文字 + 还在说
      bubble: '',
      speaking: false,
      // 界面上的临时信息
      notice: null, // { kind:'info'|'error'|'success', text }
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

    function notice(kind, text) {
      emit({ notice: text ? { kind, text } : null })
      if (kind === 'error') console.warn('[muse_vtuber] ' + text)
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

    /* ══════════════════════════════════════════════════════════
     * 2. 两个依赖的页面全局契约（mira_media / mira_device）
     * ══════════════════════════════════════════════════════════ */

    /** mira_media 的播放器（没有就是 null：没装/还没加载）。 */
    function audioApi() {
      const api = window.__miraDevice__
      return api && api.player && typeof api.player === 'object' ? api.player : null
    }

    /** mira_device 的采集单例（没有就是 null）。 */
    function inputApi() {
      const api = window.__miraDevice__
      return api && typeof api === 'object' ? api : null
    }

    const EMPTY_INPUT = {
      ready: false,
      cameraOn: false,
      micOn: false,
      cameraSource: 'device',
      micSource: 'device',
      listening: false,
      level: 0,
      vad: null,
      features: {},
      notice: null,
      heard: [],
      seen: [],
    }

    function readInput() {
      const api = inputApi()
      if (!api || typeof api.state !== 'function') return { ...EMPTY_INPUT }
      try {
        return { ...EMPTY_INPUT, ...api.state() }
      } catch {
        return { ...EMPTY_INPUT }
      }
    }

    /**
     * 订阅输入侧状态。mira_device 的客户端可能比本模块晚加载（模块加载顺序不定），
     * 所以先短轮询等它出现，出现后再订阅；卸载时把定时器与订阅都清掉。
     */
    function useInput() {
      const [snapshot, setSnapshot] = React.useState(readInput)
      React.useEffect(() => {
        let alive = true
        let stop = null
        let timer = 0
        const sync = () => {
          if (!alive) return
          setSnapshot(readInput())
        }
        const attach = () => {
          if (!alive) return
          const api = inputApi()
          if (!api || typeof api.subscribe !== 'function') {
            timer = window.setTimeout(attach, 250)
            return
          }
          sync()
          stop = api.subscribe(sync)
        }
        attach()
        return () => {
          alive = false
          if (timer) window.clearTimeout(timer)
          if (stop) {
            try { stop() } catch { /* 忽略 */ }
          }
        }
      }, [])
      return snapshot
    }

    /** 订阅声音侧（气泡 + 口型）。同样容忍晚加载。 */
    function useAudio() {
      const [state, setState] = React.useState({ ready: false, speaking: false, level: 0, text: '' })
      React.useEffect(() => {
        let alive = true
        let stop = null
        let timer = 0
        const attach = () => {
          if (!alive) return
          const api = audioApi()
          if (!api || typeof api.subscribe !== 'function') {
            timer = window.setTimeout(attach, 250)
            return
          }
          const handle = (next) => {
            if (!alive) return
            const speaking = next && next.speaking === true
            setState({
              ready: true,
              speaking,
              level: next && Number.isFinite(next.level) ? next.level : 0,
              text: next && typeof next.text === 'string' ? next.text : '',
            })
            // 说完把气泡收掉（一句话的生命周期在这里收尾，不在 Stage 里）；
            // 开始说时把这句话写进气泡（文本来自 mira_media 的 say 帧）
            if (!speaking && store.speaking) emit({ speaking: false, bubble: '' })
            if (speaking) emit({ speaking: true, bubble: next && typeof next.text === 'string' && next.text !== '' ? next.text : store.bubble })
          }
          try { handle(api.state && api.state()) } catch { /* 忽略 */ }
          stop = api.subscribe(handle)
        }
        attach()
        return () => {
          alive = false
          if (timer) window.clearTimeout(timer)
          if (stop) {
            try { stop() } catch { /* 忽略 */ }
          }
        }
      }, [])
      return state
    }

    /** 说话时 0..1 的音量（口型/频谱环用）。 */
    function speechLevel() {
      const api = audioApi()
      if (!api) return 0
      try {
        const state = typeof api.state === 'function' ? api.state() : null
        if (state && state.speaking === true) {
          const level = Number(state.level)
          return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
        }
      } catch { /* 忽略 */ }
      return 0
    }

    /* ══════════════════════════════════════════════════════════
     * 3. Live2D 运行库（按需加载，幂等）
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
     * 4. SSE：宿主 → 浏览器（形象自己的状态）
     * ══════════════════════════════════════════════════════════ */

    let stream = null
    let streamWarned = false

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
        if (frame.type === 'hello') return
        if (frame.type === 'state' && frame.state) applyHostState(frame.state, frame.by)
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

    /** 应用宿主广播的形象状态（模型/表情/动作/可见性）。 */
    function applyHostState(state, by) {
      void by
      const patch = {}
      if (typeof state.visible === 'boolean') patch.visible = state.visible
      if (typeof state.model === 'string') patch.model = state.model
      if (typeof state.expression === 'string') patch.expression = state.expression
      if (Array.isArray(state.toggles)) patch.toggles = state.toggles
      if (typeof state.motion === 'string') patch.motion = state.motion
      emit(patch)
      if (patch.model !== undefined && stage) void stage.setModel(patch.model)
      if (stage && patch.motion) stage.playMotion(patch.motion)
      if (stage && (patch.expression !== undefined || patch.toggles)) {
        void stage.applyExpressions(store.expression, store.toggles)
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
          notice('error', 'WebGL 上下文丢失（切换显卡/休眠唤醒常见），正在等待恢复…')
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
       *   ① 已经是它了；② 并发时被后一次调用覆盖。
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

      /* ── 口型（音量来自 mira_media 的播放器，本插件不播音频） ── */
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
          const level = speechLevel()
          if (level > 0.001) {
            try {
              // 与旧实现同一条曲线：底噪以上开始张嘴，音量越大张得越大
              const target = Math.min(1, Math.max(0, (level - 0.035) * 8))
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

      destroy() {
        // 先立 destroyed 旗标：销毁 PIXI/WebGL 上下文会主动触发 webglcontextlost，
        // 监听器看到旗标就直接返回，不会把假警报写进共享状态。
        this.destroyed = true
        this.modelName = null
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
      '.mv-main{position:relative;min-height:320px;height:100%;min-width:0;border-radius:var(--dsw-radius-lg, 12px);overflow:hidden;background:var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08));display:flex;align-items:stretch;justify-content:center;}',
      '.mv-ring{position:absolute;inset:0;z-index:0;display:block;width:100%;height:100%;pointer-events:none;}',
      '.mv-stage{position:absolute;inset:0;z-index:1;min-height:0;min-width:0;transition:opacity .18s ease;}',
      '.mv-stage[data-hidden="1"]{opacity:0;pointer-events:none;}',
      '.mv-bubble{position:absolute;left:12px;right:12px;bottom:12px;z-index:3;padding:8px 12px;border-radius:var(--dsw-radius-md, 10px);background:var(--dsw-alias-bg-layer-2, rgba(0,0,0,.55));border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));font-size:13px;line-height:1.5;max-height:35%;overflow:auto;white-space:pre-wrap;word-break:break-word;}',
      '.mv-side{display:flex;flex-direction:column;gap:10px;min-height:0;max-height:100%;overflow-y:auto;overflow-x:hidden;padding-right:2px;}',
      '.mv-side-footer{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:2px;}',
      '.mv-card{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:var(--dsw-radius-md, 10px);border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1, transparent);min-width:0;}',
      '.mv-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;}',
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
     * 7. 形象页签
     * ══════════════════════════════════════════════════════════ */

    /**
     * 频谱环：没有模型（或隐藏、加载失败）时，背景也得有东西在动。
     *   · 麦克风开着 → 用 mira_device 的 AnalyserNode 画真实频谱；
     *   · 正在说话 → 用 mira_media 播放器的 AnalyserNode；
     *   · 都不是 → 一段缓慢的呼吸波形（不装假数据，只是"它还活着"的视觉）。
     */
    function SpectrumRing() {
      const ref = React.useRef(null)
      const input = useInput()
      const audio = useAudio()
      const stateRef = React.useRef({ input, audio })
      stateRef.current = { input, audio }

      React.useEffect(() => {
        const canvas = ref.current
        if (!canvas) return undefined
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return undefined
        let raf = 0

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

          // 选一个"活的"音源：麦克风优先，其次正在播放的语音
          // ⚠️ 变量名不能叫 inputApi / audioApi：那会把外层的同名函数遮住，
          //    初始化表达式里再调它就撞 TDZ（`Cannot access 'inputApi' before initialization`），
          //    整个 draw 第一帧就抛错 —— 表现就是「频谱环不显示」。
          const live = stateRef.current || {}
          const inputDep = inputApi()
          const audioDep = audioApi()
          let analyser = null
          try {
            if (live.input && live.input.micOn && inputDep && typeof inputDep.analyser === 'function') {
              analyser = inputDep.analyser()
            }
          } catch { /* 忽略 */ }
          if (!analyser && live.audio && live.audio.speaking && audioDep && typeof audioDep.analyser === 'function') {
            try {
              analyser = audioDep.analyser()
            } catch { /* 忽略 */ }
          }
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
        'data-active': (input.micOn || audio.speaking) ? '1' : '0',
      })
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

    /** 摄像头/麦克风的来源选择：本机设备 / 外部采集器 / 不用（写的是 mira_device 的状态）。 */
    function SourcePicker({ kind, input }) {
      const value = String((kind === 'camera' ? input.cameraSource : input.micSource) || 'device')
      const change = async (next) => {
        const api = inputApi()
        if (!api || typeof api.setSource !== 'function') {
          notice('error', '设备插件（mira_device）还没就绪：刷新页面后重试')
          return
        }
        try {
          await api.setSource(kind, next)
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

    /** 侧边栏「视频」：数据来自 mira_device（本机 MediaStream 或采集器 MJPEG）。 */
    function VideoPanel({ videoRef }) {
      const input = useInput()
      const galaxy = String(input.cameraSource || 'device') === 'galaxy'
      // MJPEG 的 <img> 要"连一次就一直读"：src 里带时间戳会让它每秒重连（看起来像不出画面）
      const [streamFailed, setStreamFailed] = React.useState(false)
      React.useEffect(() => { setStreamFailed(false) }, [galaxy, input.cameraOn])
      React.useEffect(() => {
        const el = videoRef.current
        if (!el) return
        if (galaxy) {
          // 采集器源：面板改成 MJPEG（<img> 原生就能播 multipart），本机的 <video> 该放开
          if (el.srcObject) el.srcObject = null
          return
        }
        const api = inputApi()
        const stream = api && typeof api.videoStream === 'function' ? api.videoStream() : null
        if (stream && el.srcObject !== stream) {
          el.srcObject = stream
          const played = el.play?.()
          if (played && played.catch) played.catch(() => {})
        }
        if (!input.cameraOn && el.srcObject) el.srcObject = null
      })
      const headState = galaxy
        ? (input.cameraOn ? (streamFailed ? '无信号' : '外部采集') : '已断开')
        : (input.cameraOn ? (input.listening ? '识别中…' : '摄像头开') : '摄像头关')
      return h('section', { className: 'mv-card' },
        h('header', { className: 'mv-card-head' },
          h('span', null, '视频'),
          h('span', { className: 'mv-card-tools' },
            h('span', { className: 'mv-tip' }, headState),
            h(SourcePicker, { kind: 'camera', input }))),
        h('div', { className: 'mv-card-body' },
          galaxy
            ? (input.cameraOn && !streamFailed
              ? h('img', {
                key: 'capture-stream',
                className: 'mv-video-stream',
                src: INPUT_CAPTURE_URL,
                alt: '外部采集画面',
                onError: () => setStreamFailed(true),
              })
              : h('div', { className: 'mv-off' },
                input.cameraOn ? '外部采集没有画面（采集器没在推帧？）' : '外部采集已断开'))
            : h('video', {
              ref: videoRef,
              'data-muse-vtuber-camera': '1',
              muted: true,
              playsInline: true,
              autoPlay: true,
              style: { display: input.cameraOn ? 'block' : 'none' },
            }),
          input.cameraOn || galaxy ? null : h('div', { className: 'mv-off' }, '摄像头已关闭')),
        input.seen.length
          ? h('div', { className: 'mv-log' }, input.seen.map((item, index) => h('div', { className: 'mv-log-item', key: index },
            h('b', null, '看到：'), item.text,
            item.steered ? h('span', { className: 'mv-tip' }, '（已插话）') : null,
            item.reason ? h('span', { className: 'mv-tip' }, '（' + item.reason + '，未插话）') : null)))
          : h('p', { className: 'mv-tip' }, galaxy
            ? '画面来自外部采集器（muse_galaxy 等）。自动推帧间隔在「设置 · 设备」里。'
            : '打开摄像头后，图像识别的结果会出现在这里（设置 · 输入）。'))
    }

    /** 侧边栏「音频」：波形（关着是一条直线）+ 最近识别到的句子（都来自 mira_device）。 */
    function AudioPanel() {
      const input = useInput()
      const galaxy = String(input.micSource || 'device') === 'galaxy'
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
          const api = inputApi()
          const state = api && typeof api.state === 'function' ? api.state() : null
          if (!state) {
            ctx2d.moveTo(0, height / 2)
            ctx2d.lineTo(width, height / 2)
            ctx2d.stroke()
            return
          }
          const micOn = state.micOn === true
          // 采集器源：波形由宿主按 PCM 算的 RMS 推过来，本机没有 analyser
          if (String(state.micSource || 'device') === 'galaxy') {
            const level = micOn ? Math.max(0, Math.min(1, Number(state.level) || 0)) : 0
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
          const analyser = typeof api.analyser === 'function' ? api.analyser() : null
          if (!micOn || !analyser) {
            ctx2d.moveTo(0, height / 2)
            ctx2d.lineTo(width, height / 2)
            ctx2d.stroke()
            return
          }
          if (!analyser.__mvBuf) analyser.__mvBuf = new Uint8Array(analyser.fftSize)
          const buf = analyser.__mvBuf
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
      }, [])
      return h('section', { className: 'mv-card' },
        h('header', { className: 'mv-card-head' },
          h('span', null, '音频'),
          h('span', { className: 'mv-card-tools' },
            h('span', { className: 'mv-tip' }, input.micOn ? (galaxy ? '外部采集' : (input.listening ? '在听…' : '麦克风开')) : '麦克风关'),
            h(SourcePicker, { kind: 'mic', input }))),
        h('div', { className: 'mv-card-body', style: { aspectRatio: '16/7' } }, h('canvas', { ref: canvasRef })),
        input.heard.length
          ? h('div', { className: 'mv-log' }, input.heard.map((item, index) => h('div', { className: 'mv-log-item', key: index },
            h('b', null, '听到：'), item.text,
            item.steered ? h('span', { className: 'mv-tip' }, '（已插话）') : null,
            item.reason ? h('span', { className: 'mv-tip' }, '（' + item.reason + '，未插话）') : null)))
          : h('p', { className: 'mv-tip' }, galaxy
            ? '人声来自外部采集器，由宿主按 VAD 断句后送识别（阈值在「设置 · 媒体」）。'
            : '打开麦克风后，说的话会在这里显示，并自动插话进会话。'))
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

    function AvatarView(props) {
      const state = useStore()
      const input = useInput()
      const viewRef = React.useRef(null)
      const stageBoxRef = React.useRef(null)
      const videoRef = React.useRef(null)
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''

      // 会话 id 记在共享状态里（以前是给语音识别插话用的；现在语音在输入侧，
      // 这里只保留给排障/提示用，不再往宿主传）
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
       * 关键教训：**不能拿 `window.innerHeight - el.getBoundingClientRect().top` 当可用高度**。
       * 切到「形象」时外层滚动容器还停在对话页的滚动位置，我们这块的 top 可能比视口还靠下 →
       * 相减得负 → 被下限夹成 240px 高的舞台 → 模型按高度缩放后宽度正好跟右边栏差不多。
       * 正确做法：找最近的**可滚动祖先**，用它自己的 clientHeight + 我们相对它的偏移。
       */
      React.useEffect(() => {
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
          /**
           * 输入框（composer）是**浮在视图上方**的：它不在滚动容器里、也不占文档流，
           * 只量滚动容器的话视图底边会伸到输入框底下 —— 表现就是说话时的气泡被输入框盖住
           * （实测：视图底 886，输入框顶 830，气泡正好藏在里面）。
           * 所以再拿输入框的 top 夹一次：视图底边必须留在它上面。
           */
          try {
            const editors = [...document.querySelectorAll('[contenteditable="true"]')]
            const composer = editors.find((node) => {
              const r = node.getBoundingClientRect()
              return r.width > 160 && r.height > 0 && r.top > window.innerHeight * 0.45
            })
            if (composer) {
              const limit = Math.round(composer.getBoundingClientRect().top - el.getBoundingClientRect().top - 10)
              if (limit > 200) avail = Math.min(avail, limit)
            }
          } catch { /* 没有输入框（或拿不到几何）就按原来的算法 */ }
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

      // 依赖状态：`deps` 缺失时（例如宿主侧还没重载到新版本）不要误报"依赖缺失"，
      // 只有宿主明确说 false 才提示。
      const deps = state.deps || null
      const missingDeps = []
      if (deps && deps.audio === false) missingDeps.push('mira_media（声音）')
      if (deps && deps.input === false) missingDeps.push('mira_device（输入）')

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('div', { className: 'mv-view', ref: viewRef },
          h('div', { className: 'mv-main' },
            // 频谱环永远在最底层；没模型 / 模型隐藏时它就是画面本体，**不叠任何文字**
            // （用户口径：没有模型时环上不要有字；出错也只在侧边栏 footer 里说）
            h(SpectrumRing),
            // 舞台始终是同一个 DOM（只切透明度）：避免切换时丢 canvas
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
            // 提醒沉到侧边栏最底（面板之后）
            h('div', { className: 'mv-side-footer' },
              state.stageError ? h('p', { className: 'mv-tip' }, state.stageError) : null,
              state.notice
                ? h('p', { className: 'mv-notice', 'data-kind': state.notice.kind }, state.notice.text)
                : null,
              missingDeps.length
                ? h('p', { className: 'mv-err' }, '缺少依赖插件：' + missingDeps.join('、') + '（形象只负责显示）')
                : null,
              state.config && state.config.ui && state.config.ui.showHint
                ? h('p', { className: 'mv-tip' },
                  '点输入框里的「摄像头」「麦克风」开始。说话会自动断句识别并插话进本会话（设备插件的设置里可调）；'
                  + '形象说话时口型跟着音量动（声音插件负责出声）。')
                : null))))
    }

    /* ══════════════════════════════════════════════════════════
     * 8. 设置页「形象」
     * ══════════════════════════════════════════════════════════ */

    /** 依赖状态文案：true/false 是宿主明确上报的，null = 没上报（宿主还没重载到新版本）。 */
    function depText(value, missingText) {
      if (value === true) return '已加载'
      if (value === false) return '缺失 —— ' + missingText
      return '未上报（宿主重启后才有依赖状态）'
    }

    function toDraft(raw) {
      const v = raw && typeof raw === 'object' ? raw : {}
      const source = v.live2d && typeof v.live2d === 'object' ? v.live2d : {}
      const live2d = {}
      for (const key of ['modelsDir', 'model', 'width', 'height']) live2d[key] = source[key]
      return { live2d }
    }

    function SettingsSection() {
      const [values, setValues] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [files, setFiles] = React.useState({ configFile: '', credsFile: '' })
      const [keyConfigured, setKeyConfigured] = React.useState(false)
      // null = 宿主没上报（例如宿主侧还没重载到新版本），别误报"缺失"
      const [depsReady, setDepsReady] = React.useState({ audio: null, input: null })
      const [runtime, setRuntime] = React.useState(null)
      const [warnings, setWarnings] = React.useState([])
      const [notice, setNotice] = React.useState({ kind: 'loading', text: '正在读取形象配置…' })
      const [saving, setSaving] = React.useState(false)

      function readBack(json) {
        setValues(toDraft(json.values))
        setBaseline(toDraft(json.values))
        setKeyConfigured(json.keyConfigured === true)
        setDepsReady(json.deps && typeof json.deps === 'object' ? json.deps : { audio: null, input: null })
        setFiles({
          configFile: typeof json.configFile === 'string' ? json.configFile : '',
          credsFile: typeof json.credsFile === 'string' ? json.credsFile : '',
        })
        if (json.runtime) setRuntime(json.runtime)
        setWarnings(Array.isArray(json.warnings) ? json.warnings.map(String) : [])
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
            setNotice({ kind: 'info', text: '已读取当前配置；修改后点「保存」。模型改完立刻切换。' })
          })
          .catch((error) => {
            if (!alive) return
            setNotice({ kind: 'error', text: '读取失败：' + ((error && error.message) || String(error)) })
          })
        return () => { alive = false }
      }, [])

      const patch = (group, key, value) => setValues((prev) => (prev
        ? { ...prev, [group]: { ...prev[group], [key]: value } }
        : prev))

      async function save() {
        if (!values) return
        setSaving(true)
        setNotice({ kind: 'info', text: '正在保存…' })
        try {
          const response = await fetch(API + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ values }),
          })
          const json = await response.json().catch(() => ({}))
          if (!response.ok || !json || json.ok !== true) {
            setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
            return
          }
          readBack(json)
          const changed = Array.isArray(json.changed) && json.changed.length ? json.changed.join('、') : '无改动'
          setNotice({ kind: 'success', text: '已保存：' + changed })
          // 配置改了要重载页面上的模型清单（模型目录/模型名可能变了）
          try {
            const boot = await getJson('/bootstrap')
            emit({
              models: boot.models ? boot.models.models : [],
              current: boot.models ? boot.models.current : '',
              expressions: boot.models ? boot.models.expressions : [],
              motions: boot.models ? boot.models.motions : [],
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
            h('p', { className: 'mv-set-sub' }, 'LIVE2D 模型与画布。')),
          h('p', { className: 'mv-notice', 'data-kind': notice.kind, role: 'status' }, notice.text))
      }

      const row = (label, control, hint) => h('div', { className: 'mv-set-row', key: label },
        h('span', { className: 'mv-set-label' }, label),
        h('div', { className: 'mv-set-mid' }, control, hint ? h('p', { className: 'mv-set-hint' }, hint) : null))

      const text = (key, hint, placeholder) => row(
        key,
        h('input', {
          className: 'mv-set-input',
          type: 'text',
          value: values.live2d[key] === undefined || values.live2d[key] === null ? '' : values.live2d[key],
          placeholder: placeholder || '',
          spellCheck: false,
          onChange: (event) => patch('live2d', key, event.target.value),
        }),
        hint,
      )

      const number = (key, hint, min, max) => row(
        key,
        h('input', {
          className: 'mv-set-input',
          type: 'number',
          min,
          max,
          value: values.live2d[key] === undefined || values.live2d[key] === null ? '' : values.live2d[key],
          onChange: (event) => patch('live2d', key, event.target.value === '' ? '' : Number(event.target.value)),
        }),
        hint,
      )

      const models = runtime && runtime.models ? runtime.models : null

      return h('section', { className: 'mv-set', 'aria-label': '形象设置' },
        h('style', null, CSS),
        h('header', null,
          h('h2', { className: 'mv-set-title' }, '形象'),
          h('p', { className: 'mv-set-sub' },
            '「形象」页签的 LIVE2D 模型。声音（TTS/ASR/断句/识图/阿里云 key）在「设置 · 媒体」，'
            + '摄像头/麦克风/采集器/自动推帧在「设置 · 设备」——三件套各管一段，形象只负责显示。')),
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
          text('modelsDir', '留空 = 依次找 $DSH_HOME/mira_config/muse_vtuber/model、mira_config/mira_live2d/model', '绝对路径，可留空'),
          number('width', '初始画布宽度（像素）', 200, 4096),
          number('height', '初始画布高度（像素）', 200, 4096),
          models && models.missing && models.missing.length
            ? h('p', { className: 'mv-err' }, '缺资源：' + models.missing.map((m) => m.file).join('、') + '（放进 ' + models.dir + '/' + models.current + '/）')
            : null),
        h('fieldset', { className: 'mv-set-group' },
          h('legend', { className: 'mv-set-legend' }, '依赖状态（只读）'),
          h('p', { className: 'mv-set-hint' },
            'mira_media（声音）：' + depText(depsReady.audio, '说话/识别/断句都用不了')
            + '；阿里云 key ' + (keyConfigured ? '已配置（' + (files.credsFile || 'creds/dashscope.json') + '）' : '未配置（到「设置 · 媒体」里填）')),
          h('p', { className: 'mv-set-hint' },
            'mira_device（输入）：' + depText(depsReady.input, '没有画面/声音输入，右侧栏会是空的'))),
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
              setNotice({ kind: 'info', text: '已撤销未保存的改动。' })
            },
          }, '撤销改动')),
        h('p', { className: 'mv-notice', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, notice.text),
        warnings.length
          ? h('ul', { className: 'mv-set-hint' }, warnings.map((warning, index) => h('li', { key: index }, warning)))
          : null,
        files.configFile ? h('p', { className: 'mv-set-hint' }, '配置文件：' + files.configFile) : null)
    }

    /* ══════════════════════════════════════════════════════════
     * 9. 启动：拉一次 bootstrap + 接事件流
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
            // 宿主没给 deps（例如宿主侧还没重载到新版本）时记 null = 未知，不要误报"依赖缺失"
            deps: boot.deps && typeof boot.deps === 'object' ? boot.deps : null,
            models: models.models || [],
            current: models.current || '',
            expressions: models.expressions || [],
            motions: models.motions || [],
            missing: models.missing || [],
            model: (boot.state && boot.state.model) || models.current || '',
            expression: (boot.state && boot.state.expression) || '',
            toggles: (boot.state && boot.state.toggles) || [],
            motion: (boot.state && boot.state.motion) || '',
            visible: !(boot.state && boot.state.visible === false),
          })
          ensureStream()
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
      return bootstrap()
    }

    /* ══════════════════════════════════════════════════════════
     * 10. 导出：两个槽位注册
     * ══════════════════════════════════════════════════════════ */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          void ensureBoot()
          return () => {
            if (stream) {
              try {
                stream.close()
              } catch { /* 忽略 */ }
              stream = null
            }
          }
        })

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'muse-avatar',
          order: 20,
          label: () => '形象',
        }, AvatarView))

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
