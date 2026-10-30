/**
 * muse_vtuber — DSH 界面交互（任务书 §muse_vtuber 功能点1–8）
 *
 * 一句话：给 DSH GUI 加一个「形象」页签 —— 主位是 LIVE2D，侧边栏自上而下是视频 / 音频 /
 * 表情菜单；输入框在「模型选择」与「发送」之间多两个按钮（摄像头、麦克风）；语音识别与
 * 图像识别的事件流直接把结果**插话（steer）**进当前会话；设置页配阿里云（TTS / ASR /
 * 图像识别 / 音色）。
 *
 * 结构（每个模块一件事）：
 *   config.js  配置默认值 / 规整 / config.json 原子写 / 热生效（schemaVersion 1）
 *   state.js   界面实况（摄像头/麦克风/模型/表情）落 state.json
 *   aliyun.js  DashScope：语音合成、语音识别、图像识别（key 只在 creds/dashscope.json，600）
 *   models.js  模型清单 + 表情/动作 + 资源缺失诊断
 *   events.js  SSE 事件总线 + 感知结果 → steer 投递 + 限流
 *   routes.js  /vtuber/api/* 与静态资源
 *   tools.js   8 个 JSON 工具
 *   client.js  （浏览器侧）形象页签 + 输入框按钮 + 设置页
 *
 * 与旧版 2.0.1 的关系：旧版是「外部 stella muse_vtuber 节点」的桥（MCP + /dsh 事件），
 * 不在任务书范围内。代码原样留在 lib/legacy/node-bridge.js，默认**不加载**；
 * 要恢复就把旧配置整体搬进 config.legacyNode.config 并把 legacyNode.enabled 设为 true。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  claimInstance, fail, makeCounters, miraConfigDir, warnCount,
} from './kit.mjs'
import { ConfigStore, resolveModelsDir } from './config.js'
import { StateStore } from './state.js'
import { AliyunService } from './aliyun.js'
import { capabilities, findModel, scanModels } from './models.js'
import { EventHub } from './events.js'
import { AudioStore, createHandler, speak } from './routes.js'
import { CaptureHub } from './capture.js'
import { Authorizer } from './authz.js'
import { registerTools, statusView, TOOL_NAMES } from './tools.js'

export const name = 'muse_vtuber'

/**
 * 硬依赖（缺了插件不加载，比「一半可用」好排查）：
 *   tools            注册 vtuber_* 工具
 *   webServer        /vtuber/api/* 与静态资源（形象页签、ASR/识图上传都靠它）
 *   sessionController resolveAgent（把感知事件 steer 进会话）
 *   sessions          投递后 flush
 *   agents            旧的外部节点桥（legacyNode）要用它挑注入目标；核心服务，声明无副作用
 */
export const inject = ['tools', 'webServer', 'sessionController', 'sessions', 'agents']

const INSTANCE_ID = 'muse_vtuber'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT, 'assets')

export function apply(ctx, config) {
  const logger = ctx.logger || null
  const counters = makeCounters()
  counters.pluginName = 'muse_vtuber'

  if (config && config.enabled === false) {
    logger?.info?.('[muse_vtuber] 已禁用（config.enabled = false），不注册工具与路由')
    return fail('plugin/disabled', 'muse_vtuber 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // 约定6：两个实例 = 两套 SSE 客户端表 + 两份路由 = 事件重复投递
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[muse_vtuber] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '两个实例会让同一个感知事件被投递两次。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'muse_vtuber 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 muse_vtuber 挂了两遍；一个进程只允许一个实例')
  }

  const baseDir = miraConfigDir('muse_vtuber')
  const configStore = new ConfigStore({ baseDir, patch: config || {}, logger })
  const stateStore = new StateStore({ baseDir, logger })
  let hub = null
  let audioStore = null
  let aliyunSvc = null
  let captureHub = null
let authorizer = null
  let disposeTools = null
  let routeDisposer = null
  let legacyDisposer = null

  const releaseAll = () => {
    try { disposeTools?.() } catch { /* 退场不抛 */ }
    try { routeDisposer?.() } catch { /* noop */ }
    try { legacyDisposer?.() } catch { /* noop */ }
    try { captureHub?.dispose() } catch { /* noop */ }
    authorizer = null
    try { hub?.dispose() } catch { /* noop */ }
    try { stateStore.flush() } catch { /* noop */ }
    try { claim.release() } catch { /* noop */ }
  }

  let sessionControllerSvc = null
  let sessionsSvc = null
  try { sessionControllerSvc = ctx.sessionController || null } catch { sessionControllerSvc = null }
  try { sessionsSvc = ctx.sessions || null } catch { sessionsSvc = null }

  // 软取（没有也不能拦住整个插件）：vtuber_look 默认要把帧交给模型自己看，靠这两个服务。
  // attachments = 宿主附件库（saveImage，和 read_image 同一条路）；llm = 查当前模型吃不吃图片输入。
  const softGet = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const attachmentsSvc = softGet('attachments')
  const llmSvc = softGet('llm')

  async function resolveAgent(sessionId) {
    if (!sessionControllerSvc || typeof sessionControllerSvc.resolveAgent !== 'function') {
      throw new Error('sessionController.resolveAgent 不可用')
    }
    const result = await sessionControllerSvc.resolveAgent(sessionId)
    if (result && result.agent) return result.agent
    const err = result && result.error
    throw new Error('resolveAgent 失败：' + (err && (err.message || err.code) ? (err.message || err.code) : String(err)))
  }

  try {
    const loaded = configStore.load()
    if (loaded.error) {
      logger?.warn?.('[muse_vtuber] 配置不可用（' + loaded.error.code + '）：' + loaded.error.message
        + '；工具会拒绝使用，文件原样保留')
    }
    for (const warning of loaded.warnings || []) logger?.warn?.('[muse_vtuber] 配置：' + warning)
    const stateLoaded = stateStore.load()
    if (stateLoaded.error) {
      warnCount(logger, counters, stateLoaded.error.code,
        'state.json 不可用，界面状态按默认值展示（原文件保留）：' + stateLoaded.error.message)
    }

    // 模型目录：config 手填 > muse_vtuber/model > mira_live2d/model（README 里写明这个顺序）
    const miraRoot = miraConfigDir('') // <DSH_HOME>/mira_config
    const catalog = {
      modelsDir() {
        let cfg = null
        try {
          cfg = configStore.current()
        } catch {
          cfg = configStore.cache
        }
        return resolveModelsDir(cfg, miraRoot).dir
      },
      source() {
        let cfg = null
        try {
          cfg = configStore.current()
        } catch {
          cfg = configStore.cache
        }
        return resolveModelsDir(cfg, miraRoot).source
      },
      scan() {
        return scanModels(this.modelsDir())
      },
      find(modelName) {
        const dir = this.modelsDir()
        const state = stateStore.snapshot()
        const wanted = String(modelName ?? '').trim() || String(state.model || '').trim()
        return findModel(dir, wanted)
      },
      capabilities(modelName) {
        const dir = this.modelsDir()
        const state = stateStore.snapshot()
        const wanted = String(modelName ?? '').trim() || String(state.model || '').trim()
        return capabilities(dir, wanted)
      },
      /** 给前端/工具的状态视图：清单 + 当前模型 + 目录来源 + 缺失资源。 */
      view() {
        const dir = this.modelsDir()
        const scanned = scanModels(dir)
        const state = stateStore.snapshot()
        let cfgCurrent = ''
        try {
          cfgCurrent = String(configStore.current().live2d.model || '').trim()
        } catch { /* 配置坏了就用状态/第一个 */ }
        // 优先级：状态文件（界面最后一次真正切过的）> 配置里的 live2d.model。
        // **空 = 不显示模型（只剩频谱环）**，这是默认语义，不再回落到"清单第一个"。
        // 以前漏了配置那一档、又拿第一个模型兜底，所以设置页选完模型看起来完全没反应。
        let current = String(state.model || '').trim()
        if (current === '' && cfgCurrent !== '') current = cfgCurrent
        if (current !== '' && !scanned.models.some((m) => m.name === current || m.entry === current)) {
          // 记着的模型已经不在了（改名/删除）：清空而不是偷偷换成别的
          current = ''
        }
        let caps = null
        let capsError = null
        if (current !== '') {
          try {
            caps = capabilities(dir, current)
          } catch (error) {
            capsError = { code: error?.code || 'config/missing', message: error?.message || String(error), hint: error?.hint }
          }
        }
        return {
          dir,
          dirSource: this.source(),
          models: scanned.models.map((m) => ({ name: m.name, entry: m.entry })),
          current,
          expressions: caps ? caps.expressions : [],
          motions: caps ? caps.motions : [],
          missing: caps ? caps.missing : [],
          capsError,
        }
      },
    }

    aliyunSvc = new AliyunService({
      config: {},
      baseDir,
      configFile: configStore.file,
      logger,
      counters,
      fetchImpl: (...args) => globalThis.fetch(...args),
    })
    const aliyun = () => {
      try {
        aliyunSvc.setConfig(configStore.current())
      } catch { /* 配置坏了：服务层会自己报 creds/config 错误 */ }
      return aliyunSvc
    }

    hub = new EventHub({ config: null, resolveAgent, sessions: sessionsSvc, logger, counters })
    try {
      hub.setConfig(configStore.current())
    } catch { /* 配置坏了：hub 用默认值撑住，投递时会拿到明确错误 */ }

    audioStore = new AudioStore()

    // 外部采集器（muse_galaxy 等）：虚拟摄像头/麦克风。取帧策略仍在本插件（vision.autoIntervalMs / mic.vad）
    captureHub = new CaptureHub({
      config: () => configStore.current(),
      aliyun,
      hub,
      stateStore,
      baseDir,
      logger,
      counters,
    })

    // 「形象是一个账号」的权限判定（借 mira_account 的绑定：observer 能看、taker 能控）
    authorizer = new Authorizer({
      config: () => configStore.current(),
      account: () => softGet('miraAccount'),
      logger,
      bump: (name) => counters.bump(name),
    })

    const deps = {
      configStore,
      stateStore,
      aliyun,
      hub,
      catalog,
      audioStore,
      captureHub,
      authorizer,
      assetsDir: ASSETS_DIR,
      logger,
      counters,
      // vtuber_look 的 dsh 模式用；缺失时工具会报 platform/unsupported 并指去改 provider
      attachments: attachmentsSvc || null,
      llm: llmSvc || null,
      speak: (cfg, text, voice) => speak(deps, cfg, text, voice),
      statusView: () => statusView(deps),
    }

    disposeTools = registerTools(ctx, deps)

    routeDisposer = ctx.webServer.register({
      kind: 'prefix',
      path: '/vtuber',
      handler: createHandler(deps),
    })

    // 旧的外部节点桥：默认不加载；打开后旧代码自己注册 muse_* 工具
    if (config?.legacyNode?.enabled === true) {
      const legacyConfig = config.legacyNode.config && typeof config.legacyNode.config === 'object'
        ? config.legacyNode.config
        : {}
      void (async () => {
        try {
          const legacy = await import('./legacy/node-bridge.js')
          const dispose = await legacy.apply?.(ctx, legacyConfig)
          if (typeof dispose === 'function') legacyDisposer = dispose
          logger?.info?.('[muse_vtuber] 旧的外部节点桥已启用（legacyNode.enabled=true）')
        } catch (error) {
          warnCount(logger, counters, 'legacy/load-failed',
            '旧的外部节点桥加载失败：' + (error?.message || error) + '（形象页签不受影响）')
        }
      })()
    }

    ctx.effect(() => () => releaseAll())

    const status = configStore.status()
    const view = catalog.view()
    logger?.info?.('[muse_vtuber] 已加载：工具 ' + TOOL_NAMES.length + ' 个，模型目录 ' + view.dir
      + '（' + view.dirSource + '，' + view.models.length + ' 个模型），音频接口 /vtuber/api/audio，'
      + '阿里云 ' + (aliyun().status().configured ? '已配置 key' : '未配置 key（TTS/ASR/识图会报 creds/missing）'))
    if (view.missing.length) {
      logger?.warn?.('[muse_vtuber] 模型资源缺失 ' + view.missing.length + ' 项（模型：' + view.current + '）：'
        + view.missing.slice(0, 5).map((m) => m.file + '（' + m.why + '）').join('、')
        + '；这些文件放进 ' + view.dir + '/' + view.current + '/ 即恢复')
    }
    if (status.error) {
      logger?.warn?.('[muse_vtuber] config.json 处于错误状态（' + status.error.code + '）：' + status.error.message)
    }

    return {
      ok: true,
      configFile: configStore.file,
      stateFile: stateStore.file,
      modelsDir: view.dir,
      modelsDirSource: view.dirSource,
      models: view.models.length,
      tools: TOOL_NAMES.length,
      api: '/vtuber/api/',
      configError: status.error,
    }
  } catch (error) {
    // 装配失败必须回滚干净：路由/工具/单实例认领都要释放，否则只能重启进程
    releaseAll()
    logger?.warn?.('[muse_vtuber] 加载失败，已回滚工具/路由/单实例认领：' + (error?.message || error))
    throw error
  }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  TOOL_NAMES,
  ASSETS_DIR,
  statusView,
}
