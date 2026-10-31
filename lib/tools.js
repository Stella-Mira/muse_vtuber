/**
 * muse_vtuber / tools.js —— 形象自己的能力：5 个 JSON 工具（返回结构按约定4）
 *
 * 设计口径（跟 mira_live2d 对齐）：
 *   · 工具**不直接碰 DOM**。要浏览器做事就广播 SSE 状态帧；没有页面在场时，工具照样成功
 *     （状态会落到 state.json，页面一开就按状态显示），但 `clients: 0` 会如实回报。
 *   · 开关类工具（表情/动作/显隐/模型）先落 state.json 再广播：刷新后能恢复。
 *   · 说话不在这里：`audio_say` 属于 mira_audio（形象只负责让口型跟着音量动）；
 *     摄像头/麦克风/取帧/录音不属于这里：那是 mira_input 的 `input_*`。
 *   · 权限：4.1.0 起形象不再挂账号 —— 任何会话都能调这些工具（纯外观控制）。
 */

import { textTool } from './kit.mjs'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })

export const TOOL_NAMES = [
  'vtuber_status',
  'vtuber_expression',
  'vtuber_motion',
  'vtuber_visible',
  'vtuber_model',
]

/**
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {object} deps.stateStore
 * @param {object} deps.hub
 * @param {object} deps.catalog
 * @param {() => object|null} [deps.audioStatus]  miraAudio.status()（声音侧状态，只读转述）
 * @param {() => object|null} [deps.inputStatus]  miraInput.status()（输入侧状态，只读转述）
 */
export function registerTools(ctx, deps) {
  const disposers = []
  /**
   * 4.1.0 起没有权限闸门：形象是纯展示面，任何会话都能改外观。
   * （旧版「形象是一个账号」的 taker/observer 已删除，也不再依赖 mira_account。）
   */
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  register(textTool(
    'vtuber_status',
    '只读：形象界面状态（可见性/模型/表情/动作、模型清单与缺失资源、表情与动作清单、连着的页面数、形象是否可见），并把声音（TTS/ASR/断句）与输入（摄像头/麦克风/采集器/识图）两件依赖的状态一并转述。排查「为什么它不说话/看不见/换不了模型」先调这个。',
    obj({}),
    async () => statusView(deps),
  ))

  register(textTool(
    'vtuber_expression',
    '设置形象的 LIVE2D 表情。三种玩法：name = 互斥表情（如「表情-惊喜」，空串 = 恢复默认）；toggles = 整体替换叠加开关集合（「开关-*」「动作-*」可多个同时开）；switch + on = 单个开关的开/关。名字必须来自 vtuber_status 的 models.expressions，传错会直接报错并列出可用清单（不会把模型弄没）。',
    obj({
      name: str('互斥表情名；传空串 = 恢复默认；省略 = 不改变当前表情'),
      toggles: { type: 'array', items: { type: 'string' }, description: '叠加开关的完整集合（替换，不是追加）；空数组 = 全关' },
      switch: str('单个叠加开关名（与 on 搭配）'),
      on: bool('配合 switch：true=打开，false=关闭（默认 true）'),
    }),
    async (args) => {
      const caps = safeCaps(deps)
      // 空白 = 不显示模型是合法状态：这时没有"当前模型的表情"可言，直接说清楚
      if (!caps) return noModelError(deps)
      const known = new Set(caps.expressions.map((e) => e.name))
      const current = deps.stateStore.snapshot()

      // 先校验、再落盘：以前是「先写 state 再发现不存在」，未知名字会一直留在状态里，
      // 而客户端每次应用都会失败一次 —— 现在未知名字直接拒绝，状态原样不动。
      const patch = {}
      const unknown = []
      if (typeof args?.name === 'string') {
        const name = args.name.trim()
        if (name !== '' && known && !known.has(name)) unknown.push(name)
        else patch.expression = name
      }
      let toggles = null
      if (Array.isArray(args?.toggles)) {
        toggles = args.toggles.map((x) => String(x ?? '').trim()).filter(Boolean)
      } else if (typeof args?.switch === 'string' && args.switch.trim() !== '') {
        const name = args.switch.trim()
        const on = typeof args?.on === 'boolean' ? args.on : true
        const base = new Set(Array.isArray(current.toggles) ? current.toggles : [])
        if (on) base.add(name)
        else base.delete(name)
        toggles = [...base]
      }
      if (toggles) {
        for (const name of toggles) if (known && !known.has(name)) unknown.push(name)
        patch.toggles = toggles
      }
      if (unknown.length) {
        return {
          ok: false,
          error: {
            code: 'expression/unknown',
            message: '模型里没有这些表情：' + [...new Set(unknown)].join('、'),
            hint: '可用表情：' + (caps ? caps.expressions.map((e) => e.name).join('、') || '（这个模型没导出表情）' : '（模型读不出来，先 vtuber_status 看 modelsError）'),
          },
          expressions: caps ? caps.expressions : undefined,
        }
      }
      if (Object.keys(patch).length === 0) {
        return {
          ok: true,
          changed: [],
          expression: current.expression,
          toggles: current.toggles,
          expressions: caps ? caps.expressions : undefined,
          note: '没有要改的：传 name / toggles / switch 之一',
        }
      }
      const result = deps.stateStore.set(patch, { by: 'tool' })
      if (result.changed.length) deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return {
        ok: true,
        changed: result.changed,
        expression: result.state.expression,
        toggles: result.state.toggles,
        expressions: caps ? caps.expressions : undefined,
        clients: deps.hub.clientCount,
      }
    },
  ))

  register(textTool(
    'vtuber_visible',
    '显示或隐藏形象主体（隐藏后频谱环仍在，符合「没有模型可显示时也有东西可看」）。不传 on = 切换。',
    obj({
      on: bool('true=显示，false=隐藏；省略 = 切换'),
    }),
    async (args) => {
      const current = deps.stateStore.snapshot().visible !== false
      const on = typeof args?.on === 'boolean' ? args.on : !current
      const result = deps.stateStore.set({ visible: on }, { by: 'tool' })
      if (result.changed.length) deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return { ok: true, visible: on, changed: result.changed, clients: deps.hub.clientCount }
    },
  ))

  register(textTool(
    'vtuber_motion',
    '播放模型的动作组（名字来自 vtuber_status 的 models.motions，例如 "Idle"）。不传 name = 列出可用动作组。',
    obj({
      name: str('动作组名；留空 = 列出清单'),
    }),
    async (args) => {
      const caps = safeCaps(deps)
      const motions = caps ? caps.motions : []
      const name = String(args?.name ?? '').trim()
      if (name === '') return { ok: true, motions, current: deps.stateStore.snapshot().motion || '' }
      if (!caps) return noModelError(deps)
      if (caps && !motions.includes(name)) {
        return {
          ok: false,
          error: {
            code: 'motion/unknown',
            message: '模型里没有这个动作组：' + name,
            hint: '可用动作组：' + (motions.join('、') || '（这个模型没导出动作）'),
          },
          motions,
        }
      }
      // 同一个动作组连点两次也要能重播：motion 字段带上序号，客户端按「值变了」触发
      const stamp = name + '#' + Date.now().toString(36)
      const result = deps.stateStore.set({ motion: stamp }, { by: 'tool' })
      if (result.changed.length) deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return { ok: true, motion: name, motions, clients: deps.hub.clientCount }
    },
  ))

  register(textTool(
    'vtuber_model',
    '切换形象展示的 LIVE2D 模型（目录名或 *.model3.json）；不传 name = 列出可用模型；clear:true = 不显示模型（只留频谱环）。',
    obj({
      name: str('模型目录名 / model3.json 文件名；留空 = 只列清单'),
      clear: bool('true = 清空选择，不显示模型（只显示频谱环）'),
    }),
    async (args) => {
      const name = String(args?.name ?? '').trim()
      if (args?.clear === true || name === '(none)') {
        const result = deps.stateStore.set({ model: '' }, { by: 'tool' })
        if (result.changed.length) deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
        return { ok: true, model: '', cleared: true, clients: deps.hub.clientCount }
      }
      if (name === '') {
        const view = deps.catalog.view()
        return { ok: true, models: view.models, current: view.current || '' }
      }
      const model = deps.catalog.find(name)
      const result = deps.stateStore.set({ model: model.name }, { by: 'tool' })
      deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return { ok: true, model: model.name, entry: model.entry, clients: deps.hub.clientCount }
    },
  ))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch { /* 退场不抛 */ }
    }
  }
}

/**
 * 取当前会话 id：`agent.session.id` 才是权威（Agent.id 与 Session.id 不同源）。
 * 拿不到就返回空串 —— 不猜、不借「最后一个会话」。
 */
function sessionIdOf(exec) {
  const agent = exec && exec.agent
  const id = agent && agent.session && agent.session.id ? String(agent.session.id) : ''
  return id
}

/**
 * 当前**正在显示**的模型的能力清单。
 * 没有显示模型时返回 null（空白 = 不显示模型是合法状态），
 * 这样表情/动作工具会明确报 `model/none`，而不是拿清单里第一个模型去校验。
 */
function safeCaps(deps) {
  try {
    const view = deps.catalog.view()
    if (!view || !view.current) return null
    return deps.catalog.capabilities(view.current)
  } catch {
    return null
  }
}

/** 表情/动作这类工具的「当前没有模型」统一回复。 */
function noModelError(deps) {
  let available = []
  try {
    available = deps.catalog.view().models.map((m) => m.name)
  } catch { /* 目录读不出来就只给提示 */ }
  return {
    ok: false,
    error: {
      code: 'model/none',
      message: '当前没有显示模型（空白 = 只显示频谱环）',
      hint: available.length
        ? '先用 vtuber_model 选一个：' + available.join('、')
        : '模型目录里还没有模型：把 <Name>/<Name>.model3.json 放进设置里的「模型目录」',
    },
  }
}

/** 把依赖插件的状态安全地取出来（没有/坏了都当 null，不把形象状态带崩）。 */
function safeDep(fn) {
  if (typeof fn !== 'function') return null
  try {
    return fn() || null
  } catch {
    return null
  }
}

/** vtuber_status 的返回体（只读、可自证）。 */
export function statusView(deps) {
  const cfgStatus = deps.configStore.status()
  let cfg = null
  try {
    cfg = deps.configStore.current()
  } catch { /* 已经记在 cfgStatus.error 里 */ }
  const stateView = deps.stateStore.status()
  let modelsView = null
  let modelsError = null
  try {
    modelsView = deps.catalog.view()
  } catch (error) {
    modelsError = { code: error?.code || 'config/missing', message: error?.message || String(error), hint: error?.hint }
  }
  const audio = safeDep(deps.audioStatus)
  const input = safeDep(deps.inputStatus)
  return {
    ok: true,
    plugin: 'muse_vtuber',
    configFile: cfgStatus.file,
    stateFile: stateView.file,
    configError: cfgStatus.error,
    configWarnings: cfgStatus.warnings,
    stateError: stateView.error,
    state: stateView.state,
    models: modelsView,
    modelsError,
    // 「各自的能力归各自的插件」：状态只转述，要看细节用 audio_status / input_status
    audio: audio
      ? { configured: audio.configured, tts: audio.tts, asr: audio.asr, vad: audio.vad, playerClients: audio.clients }
      : { available: false, note: 'mira_audio 没加载（说话/识别都用不了）' },
    input: input
      ? {
        state: input.state,
        features: { asr: input.audio ? input.audio.asr : null, vision: input.vision },
        capture: input.capture ? { enabled: input.capture.enabled, sources: input.capture.sources.length, selected: input.capture.selected } : null,
        clients: input.events ? input.events.clients : null,
      }
      : { available: false, note: 'mira_input 没加载（没有画面/声音输入）' },
    ui: { showHint: cfg ? cfg.ui.showHint !== false : true, clients: deps.hub.clientCount },
    endpoints: {
      api: '/vtuber/api/',
      page: 'DSH 会话页签「形象」',
      audio: '/audio/api/',
      input: '/input/api/',
    },
    counters: deps.counters ? deps.counters.snapshot() : {},
  }
}
