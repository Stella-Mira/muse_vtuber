/**
 * muse_vtuber / tools.js —— 8 个 JSON 工具（返回结构按约定4）
 *
 * 设计口径（跟 mira_live2d 对齐）：
 *   · 工具**不直接碰 DOM**。要浏览器做事就广播 SSE 帧（或 command + 等回执）；
 *     没有页面在场时，明确报 delivery/failed 并说清怎么办，不假装成功。
 *   · 开关类工具（摄像头/麦克风/表情/模型）先落 state.json 再广播：刷新后能恢复。
 *   · 识别类工具（look / listen）默认**只回文本**给模型；要顺手插话进会话就传 steer:true。
 *     自动事件流（界面里的连续识别）走 config.events，不靠模型记得调工具。
 */

import { textTool, toError } from './kit.mjs'
import { CONTROL_TOOLS, RECEIVE_TOOLS } from './authz.js'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

export const TOOL_NAMES = [
  'vtuber_status',
  'vtuber_say',
  'vtuber_expression',
  'vtuber_motion',
  'vtuber_visible',
  'vtuber_model',
  'vtuber_camera',
  'vtuber_mic',
  'vtuber_look',
  'vtuber_listen',
]

/**
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {object} deps.stateStore
 * @param {() => object} deps.aliyun
 * @param {object} deps.hub
 * @param {object} deps.catalog
 * @param {(cfg:object, text:string, voice?:string)=>Promise<object>} deps.speak
 * @param {object} [deps.logger]
 */
export function registerTools(ctx, deps) {
  const disposers = []
  /**
   * 注册工具时统一加权限闸门（vtuber 是一个"有主人的账号"）：
   *   · 控制类（say / 表情 / 动作 / 显隐 / 模型）→ 必须 taker
   *   · 接收类（look / listen / 摄像头 / 麦克风开关）→ observer 或 taker
   *   · status 等只读工具不限
   * 判定走 lib/authz.js（借 mira_account 的绑定模型）；security.mode='off' 时整体跳过。
   */
  const register = (definition) => {
    const kind = CONTROL_TOOLS.includes(definition.name) ? 'control'
      : RECEIVE_TOOLS.includes(definition.name) ? 'receive'
        : null
    if (kind === null || !deps.authorizer) {
      disposers.push(ctx.tools.register(definition))
      return
    }
    const inner = definition.execute
    disposers.push(ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const guard = kind === 'control'
          ? deps.authorizer.requireControl(sessionId, { force: args?.force === true, tool: definition.name })
          : deps.authorizer.requireReceive(sessionId, { tool: definition.name })
        if (!guard.ok) {
          // 输出 schema 是 string：这里必须自己 stringify（textTool 的 runTool 在内层，回不去）
          return JSON.stringify({
            ok: false,
            error: { code: guard.error.code, message: guard.error.message, hint: guard.error.hint },
          }, null, 2)
        }
        return inner(args, exec)
      },
    }))
  }

  register(textTool(
    'vtuber_status',
    '只读：形象界面的当前状态（摄像头/麦克风开关、模型与表情、事件流、连着的页面数、TTS/ASR/图像识别是否就绪、模型目录与缺失资源）。排查「为什么它不说话/不看」先调这个。',
    obj({}),
    async (_args, exec) => statusView(deps, { sessionId: sessionIdOf(exec) }),
  ))

  register(textTool(
    'vtuber_say',
    '让形象（LIVE2D）说出这句话：服务端合成语音后推给浏览器播放，模型口型跟着音量动。没有页面连着时返回 delivery/failed（语音没地方播）。',
    obj({
      text: str('要说的话（受 tts.maxChars 限制，超长会截断并回报 truncated）'),
      force: bool('可选：true = 抢走控制权（原 taker 会降级成 observer）；已被别的会话控制时才需要'),
      voice: str('可选音色覆盖（默认用设置里的音色，如 Cherry / Serena / Ethan）'),
    }, ['text']),
    async (args) => {
      const text = String(args?.text ?? '')
      if (text.trim() === '') {
        return { ok: false, error: { code: 'tts/failed', message: 'text 为空', hint: '传要朗读的文字' } }
      }
      const cfg = deps.configStore.current()
      if (deps.hub.clientCount === 0) {
        return {
          ok: false,
          error: {
            code: 'delivery/failed',
            message: '没有浏览器页签连着，语音没有地方播',
            hint: '打开 DSH 界面并切到「形象」页签（或在设置里确认页面没被关掉）',
          },
        }
      }
      return deps.speak(cfg, text, String(args?.voice ?? ''))
    },
  ))

  register(textTool(
    'vtuber_expression',
    '设置形象的 LIVE2D 表情。三种玩法：name = 互斥表情（如「表情-惊喜」，空串 = 恢复默认）；toggles = 整体替换叠加开关集合（「开关-*」「动作-*」可多个同时开）；switch + on = 单个开关的开/关。名字必须来自 vtuber_status 的 models.expressions，传错会直接报错并列出可用清单（不会把模型弄没）。',
    obj({
      name: str('互斥表情名；传空串 = 恢复默认；省略 = 不改变当前表情'),
      toggles: { type: 'array', items: { type: 'string' }, description: '叠加开关的完整集合（替换，不是追加）；空数组 = 全关' },
      switch: str('单个叠加开关名（与 on 搭配）'),
      on: bool('配合 switch：true=打开，false=关闭（默认 true）'),
      force: bool('可选：true = 抢走控制权（原 taker 会降级成 observer）'),
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
    '显示或隐藏形象主体（隐藏后频谱环仍在，符合「没有模型可显示时也有东西可看」）。不传 on = 切换；传 "toggle" 走查询。',
    obj({
      on: bool('true=显示，false=隐藏；省略 = 切换'),
      force: bool('可选：true = 抢走控制权（原 taker 会降级成 observer）'),
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
      force: bool('可选：true = 抢走控制权（原 taker 会降级成 observer）'),
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
      force: bool('可选：true = 抢走控制权（原 taker 会降级成 observer）'),
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

  register(textTool(
    'vtuber_camera',
    '打开或关闭形象界面的摄像头。关闭时侧边栏「视频」显示黑屏；打开后显示摄像头画面（图像识别也用它）。',
    obj({ on: bool('true=打开，false=关闭；省略 = 切换') }),
    async (args) => {
      const current = deps.stateStore.snapshot().cameraOn
      const on = typeof args?.on === 'boolean' ? args.on : !current
      const result = deps.stateStore.set({ cameraOn: on }, { by: 'tool' })
      deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return { ok: true, cameraOn: on, clients: deps.hub.clientCount }
    },
  ))

  register(textTool(
    'vtuber_mic',
    '打开或关闭形象界面的麦克风。关闭时侧边栏「音频」显示直线；打开后显示波形，语音识别把说的话作为插话送进会话。',
    obj({ on: bool('true=打开，false=关闭；省略 = 切换') }),
    async (args) => {
      const current = deps.stateStore.snapshot().micOn
      const on = typeof args?.on === 'boolean' ? args.on : !current
      const result = deps.stateStore.set({ micOn: on }, { by: 'tool' })
      deps.hub.broadcast('state', { state: result.state, changed: result.changed, by: 'tool' })
      return { ok: true, micOn: on, clients: deps.hub.clientCount }
    },
  ))

  // ── vtuber_look：默认把这一帧**交给 DSH 自己的模型看**（走 attachments，同 read_image 的约定），
  //    不调第三方、不额外花钱；只有显式 vision.provider="aliyun" 才服务端调 qwen-vl 拿文字。
  register(lookTool(deps))

  register(textTool(
    'vtuber_listen',
    '让形象听一段：浏览器录 seconds 秒麦克风 → 阿里云 qwen3-asr 识别 → 返回文字。需要麦克风已打开且有页面连着。',
    obj({
      seconds: num('录多久（秒），默认 5，最多 30'),
      steer: bool('true = 同时把识别结果作为插话送进当前会话（默认 false）'),
    }),
    async (args, exec) => {
      const cfg = deps.configStore.current()
      if (cfg.mic.enabled !== true) {
        return { ok: false, error: { code: 'config/missing', message: '麦克风在配置里被禁用（mic.enabled=false）', hint: '在设置页打开麦克风' } }
      }
      const state = deps.stateStore.snapshot()
      if (!state.micOn) {
        return { ok: false, error: { code: 'mic/closed', message: '麦克风没打开', hint: '先点输入框里的「麦克风」按钮，或调 vtuber_mic on:true' } }
      }
      // 采集器源没有"回放最近 N 秒"的能力（音频由采集端持续推、由 mic.vad 实时断句）：
      // 明确回报，别让模型以为自己在按需录音。
      if (String(state.micSource || 'device') === 'galaxy') {
        return {
          ok: false,
          source: { kind: 'capture' },
          error: {
            code: 'mic/external',
            message: '麦克风来源是外部采集器（muse_galaxy 等），不支持按需回放录音',
            hint: '它会把整句实时送来并自动插话；要看波形/识别请用 vtuber_status 的 capture 段',
          },
        }
      }
      const seconds = Math.max(1, Math.min(30, Number(args?.seconds) || 5))
      const clip = await deps.hub.request('listen', { seconds }, { timeoutMs: (seconds + 20) * 1000 })
      const base64 = String(clip?.base64 ?? '')
      if (base64 === '') {
        return { ok: false, error: { code: 'asr/failed', message: '浏览器没有返回音频', hint: '确认页面上的麦克风波形在动（有声音输入）' } }
      }
      const outcome = await deps.aliyun().transcribe({
        base64,
        mime: String(clip?.mime || 'audio/wav'),
        sampleRate: Number(clip?.sampleRate) || 0,
      })
      let steer = null
      const sessionId = sessionIdOf(exec)
      if (args?.steer === true && outcome.text !== '') {
        steer = await deps.hub.perceive({ kind: 'voice', text: outcome.text, sessionId, auto: false })
      }
      return { ok: true, text: outcome.text, model: outcome.model, seconds, steered: steer ? steer.delivered === true : false }
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
 * `vtuber_look`：让形象用摄像头看一眼。
 *
 * 两条路（`vision.provider`）：
 *   dsh（默认）—— 把这一帧作为**图片内容块**放进工具结果，交给当前会话的模型自己看。
 *     完全照 `read_image` 的约定：`attachments.saveImage()` → `render` 返回
 *     `[{type:'text'…},{type:'image', attachment}]`。好处是不调第三方、不额外花钱，
 *     而且"看"的就是正在跟你对话的那个模型。
 *   aliyun —— 服务端调 qwen-vl 拿一段文字再回给模型（自动事件流 `vision.autoIntervalMs`
 *     必须走这条，因为那条路没有模型参与）。
 */
function lookTool(deps) {
  return {
    name: 'vtuber_look',
    description: '让形象用摄像头看一眼：浏览器抓当前一帧，默认把这一帧直接交给当前会话的模型看（和 read_image 一样是图片输入，不调阿里云）；vision.provider=aliyun 时才服务端调 qwen-vl 返回一段文字。需要摄像头已打开且有页面连着。',
    parameters: obj({
      prompt: str('可选：想问的问题（默认用设置里的提示词）'),
      steer: bool('仅 aliyun 模式有效：true = 把识别结果作为插话送进当前会话（默认 false）'),
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          provider: { type: 'string' },
          text: { type: 'string' },
          path: { type: 'string' },
          question: { type: 'string' },
          note: { type: 'string' },
          steered: { type: 'boolean' },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              hint: { type: 'string' },
            },
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => renderLook(value),
      presentationMeta: (_args, value) => ({
        provider: value && value.provider,
        path: value && value.path,
      }),
    },
    async execute(args, exec) {
      try {
        return await runLook(deps, args ?? {}, exec)
      } catch (error) {
        return { ok: false, provider: 'unknown', error: toError(error).error }
      }
    },
  }
}

async function runLook(deps, args, exec) {
  const cfg = deps.configStore.current()
  if (cfg.camera.enabled !== true) {
    return { ok: false, error: { code: 'config/missing', message: '摄像头在配置里被禁用（camera.enabled=false）', hint: '在设置页打开摄像头' } }
  }
  const state = deps.stateStore.snapshot()
  if (!state.cameraOn) {
    return { ok: false, error: { code: 'camera/closed', message: '摄像头没打开', hint: '先点输入框里的「摄像头」按钮，或调 vtuber_camera on:true' } }
  }
  const question = String(args?.prompt ?? '').trim()

  // 采集器源（muse_galaxy 等）：帧就在宿主内存里，直接用 —— 不需要页面在场，也不用再让浏览器抓一次
  let dataUrl = ''
  let fromCapture = null
  if (String(state.cameraSource || 'device') === 'galaxy' && deps.captureHub) {
    const capture = deps.captureHub.cameraCapture?.() || null
    if (capture && capture.jpeg) {
      dataUrl = capture.dataUrl
      fromCapture = { captureId: capture.id, label: capture.label, at: capture.jpegAt }
    }
  }
  if (dataUrl === '') {
    const shot = await deps.hub.request('look', { prompt: question }, { timeoutMs: 20000 })
    dataUrl = String(shot?.image ?? '')
  }
  if (dataUrl === '') {
    return { ok: false, error: { code: 'vision/failed', message: '浏览器没有返回图像帧', hint: '确认摄像头预览有画面（点一下「摄像头」按钮）' } }
  }

  if (cfg.vision.provider === 'aliyun') {
    const outcome = await deps.aliyun().describeImage({ dataUrl, prompt: question })
    let steer = null
    if (args?.steer === true && outcome.text !== '') {
      steer = await deps.hub.perceive({ kind: 'vision', text: outcome.text, sessionId: sessionIdOf(exec), auto: false })
    }
    return {
      ok: true,
      provider: 'aliyun',
      text: outcome.text,
      source: fromCapture ? { kind: 'capture', label: fromCapture.label, captureId: fromCapture.captureId } : { kind: 'device' },
      note: '（vision.provider=aliyun：这是服务端识别出的文字）',
      steered: steer ? steer.delivered === true : undefined,
    }
  }

  // ── dsh：把帧交给当前会话的模型 ──
  const attachments = deps.attachments
  if (!attachments || typeof attachments.saveImage !== 'function') {
    return {
      ok: false,
      provider: 'dsh',
      error: {
        code: 'platform/unsupported',
        message: 'DSH 没有挂载附件服务（attachments），没法把画面作为图片交给模型',
        hint: '确认宿主加载了 dsh-attachment-local；或在设置 · 形象里把「图像识别」改成 aliyun',
      },
    }
  }
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) {
    return { ok: false, provider: 'dsh', error: { code: 'vision/failed', message: '浏览器返回的帧不是 data:image/...;base64,...', hint: '刷新页面后重试' } }
  }
  // 能力检查（照 read_image 的做法）：当前会话模型必须声明 image 输入，否则让用户换模型/换 provider
  const model = exec && exec.agent && exec.agent.options ? String(exec.agent.options.model || '') : ''
  const providerId = exec && exec.agent && exec.agent.options ? String(exec.agent.options.provider || '') : ''
  const llm = deps.llm
  if (llm && typeof llm.resolveModelInfo === 'function' && providerId && model) {
    let modalities
    try {
      const info = await llm.resolveModelInfo(providerId, model, exec.signal)
      modalities = info && info.inputModalities
    } catch { /* 解析不到就别拦，让宿主自己报 */ }
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      return {
        ok: false,
        provider: 'dsh',
        error: {
          code: 'vision/unsupported',
          message: '当前模型 ' + model + ' 不接受图像输入（inputModalities 里没有 image）',
          hint: '换一个多模态模型，或在设置 · 形象里把「图像识别」改成 aliyun（服务端 qwen-vl）',
        },
      }
    }
  }
  let ref
  try {
    ref = await attachments.saveImage({
      data: parsed.data,
      mediaType: parsed.mediaType,
      name: 'vtuber-look-' + Date.now() + '.jpg',
    })
  } catch (error) {
    return {
      ok: false,
      provider: 'dsh',
      error: {
        code: 'vision/failed',
        message: '把画面存成附件失败：' + (error && error.message ? error.message : String(error)),
        hint: '图片可能超过宿主的尺寸/字节上限；在设置里调小摄像头分辨率后重试',
      },
    }
  }
  return {
    ok: true,
    provider: 'dsh',
    path: fromCapture ? 'vtuber://capture/' + fromCapture.captureId : 'vtuber://camera/current',
    question,
    source: fromCapture ? { kind: 'capture', label: fromCapture.label, captureId: fromCapture.captureId } : { kind: 'device' },
    image: {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType || parsed.mediaType),
      bytes: Number(ref.bytes) || parsed.data.length,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
    },
    note: '（vision.provider=dsh：画面已作为图片附在本次工具结果里，由你自己看）',
  }
}

/** `render`：带图片的值渲染成 [说明文字, image 块]；其余情况退回 JSON 文本。 */
function renderLook(value) {
  const image = value && value.image
  if (image && typeof image.attachmentId === 'string' && image.attachmentId !== '') {
    const lines = [
      '<source>muse_vtuber / 形象界面的摄像头，当前一帧</source>',
    ]
    if (value.question) lines.push('<question>' + value.question + '</question>')
    lines.push('<type>image</type>')
    lines.push('<content>' + image.mediaType + ' image, ' + image.width + 'x' + image.height + ' px, ' + image.bytes + ' bytes</content>')
    lines.push('（这是刚刚抓到的画面，按你真正看到的回答；看不见的细节不要编。）')
    return [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', attachment: image },
    ]
  }
  return [{ type: 'text', text: JSON.stringify(value ?? {}, null, 2) }]
}

/** `data:image/jpeg;base64,...` → { mediaType, data }（不是 data URL 返回 null）。 */
function parseDataUrl(dataUrl) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''))
  if (!match) return null
  return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64') }
}

/**
 * 取当前会话 id：`agent.session.id` 才是权威（Agent.id 与 Session.id 不同源，
 * 见 PROGRESS「bug 报告分诊 第1条」）。拿不到就返回空串 —— 不猜、不借「最后一个会话」。
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

/** vtuber_status 的返回体（只读、可自证）。 */
export function statusView(deps, { sessionId = '' } = {}) {
  const cfgStatus = deps.configStore.status()
  let cfg = null
  try {
    cfg = deps.configStore.current()
  } catch { /* 已经记在 cfgStatus.error 里 */ }
  const stateView = deps.stateStore.status()
  const feature = deps.aliyun().status()
  let modelsView = null
  let modelsError = null
  try {
    modelsView = deps.catalog.view()
  } catch (error) {
    modelsError = { code: error?.code || 'config/missing', message: error?.message || String(error), hint: error?.hint }
  }
  return {
    ok: true,
    plugin: 'muse_vtuber',
    configFile: cfgStatus.file,
    stateFile: stateView.file,
    configError: cfgStatus.error,
    configWarnings: cfgStatus.warnings,
    stateError: stateView.error,
    state: stateView.state,
    tts: feature.tts,
    asr: feature.asr,
    // vision.provider：dsh = 交给当前会话模型看（不花第三方额度）；aliyun = 服务端 qwen-vl
    vision: {
      ...feature.vision,
      provider: cfg ? cfg.vision.provider : null,
      autoIntervalMs: cfg ? cfg.vision.autoIntervalMs : 0,
      attachmentsReady: !!(deps.attachments && typeof deps.attachments.saveImage === 'function'),
      // 自动识图那条路不经过模型，所以即使 provider=dsh 也仍然需要阿里云 key
      autoNeedsCreds: !!(cfg && cfg.vision.autoIntervalMs > 0 && cfg.vision.provider === 'dsh'),
    },
    // 外部采集器（muse_galaxy 等）：虚拟摄像头/麦克风的来源与统计
    capture: deps.captureHub ? deps.captureHub.status() : null,
    // 「形象是一个账号」：这个会话是 taker / observer / 还是没权限
    security: deps.authorizer ? deps.authorizer.describe(sessionId) : null,
    credentials: {
      configured: feature.configured,
      file: feature.credsFile,
      mode: feature.credsMode,
      hint: feature.hint,
    },
    models: modelsView,
    modelsError,
    events: {
      enabled: cfg ? cfg.events.enabled === true : null,
      steer: cfg ? cfg.events.steer === true : null,
      clients: deps.hub.clientCount,
      lastPercept: deps.hub.status().lastPercept,
      pending: deps.hub.status().pending,
    },
    endpoints: {
      api: '/vtuber/api/',
      page: 'DSH 会话页签「形象」',
    },
    counters: deps.counters ? deps.counters.snapshot() : {},
  }
}
