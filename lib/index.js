/**
 * muse_vtuber —— DSH 的「形象」插件（三件套拆分后的第 3 件）
 *
 * 一句话：给 DSH GUI 加一个「形象」页签 —— 主位是 LIVE2D（说话时口型跟着音量动，没模型时
 * 频谱环兜底），右侧栏自上而下是**视频 / 音频 / 表情**；视频与音频的数据来自 mira_device，
 * 说话的声音来自 mira_media。本插件自己只管"画出来"和"形象长什么样"。
 *
 * 结构（每个模块一件事）：
 *   config.js   配置默认值 / 规整 / config.json 原子写 / 热生效（schemaVersion 1）—— 只剩 live2d/ui
 *   state.js    形象实况（可见性/模型/表情/开关/动作）落 state.json
 *   models.js   模型清单 + 表情/动作 + 资源缺失诊断
 *   hub.js      SSE（宿主 → 页面）：hello / state
 *   routes.js   /vtuber/api/* 与静态资源（assets / models）
 *   tools.js    5 个 JSON 工具（status / expression / motion / visible / model）
 *   client.js   （浏览器侧）形象页签 + 设置页「形象」
 *
 * 依赖方向（箭头 = "依赖"）：
 *   muse_vtuber（本插件）──→ mira_device ──→ mira_media
 *        │                      │              │
 *        │                  画面/声音输入    声音（TTS/ASR/VAD/凭据）
 *        └──────────────────────┴──────────────┘
 *   视频/音频面板从 mira_device 的页面全局对象与 /device/api/stream.mjpg 取数据；
 *   气泡与口型订阅 mira_media 的 `say` 帧（声音由它播放，形象不重复播一遍）。
 *
 * 旧版 2.0.1 是「外部 stella muse_vtuber 节点」的桥（MCP + /dsh 事件），不在任务书范围内。
 * 代码原样留在 lib/legacy/node-bridge.js，默认**不加载**（config.legacyNode.enabled）。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  claimInstance, fail, makeCounters, miraConfigDir, warnCount,
} from './kit.mjs'
import { ConfigStore, resolveModelsDir } from './config.js'
import { StateStore } from './state.js'
import { capabilities, findModel, scanModels } from './models.js'
import { EventHub } from './hub.js'
import { createHandler } from './routes.js'
import { registerTools, statusView, TOOL_NAMES } from './tools.js'

export const name = 'muse_vtuber'

/**
 * 硬依赖（缺了插件不加载，比「一半可用」好排查）：
 *   tools            注册 vtuber_* 工具
 *   webServer        /vtuber/api/* 与静态资源（形象页签、模型文件都靠它）
 *   miraMedia        说话（TTS）+ 断句/识别状态（形象订阅它的 say 帧做口型）
 *   miraDevice        画面与声音的输入（右侧栏的视频/音频面板由它供给）
 *
 * 注意：这里**不再**声明 sessionController/sessions —— 插话（steer）已经搬去 mira_device，
 * 形象只管显示，不认识会话。
 */
export const inject = ['tools', 'webServer', 'miraMedia', 'miraDevice']

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
      + '两个实例会让同一个状态被广播两次。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'muse_vtuber 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 muse_vtuber 挂了两遍；一个进程只允许一个实例')
  }

  const baseDir = miraConfigDir('muse_vtuber')
  const configStore = new ConfigStore({ baseDir, patch: config || {}, logger })
  const stateStore = new StateStore({ baseDir, logger })
  let hub = null
  let disposeTools = null
  let routeDisposer = null
  let legacyDisposer = null

  const releaseAll = () => {
    try { disposeTools?.() } catch { /* 退场不抛 */ }
    try { routeDisposer?.() } catch { /* noop */ }
    try { legacyDisposer?.() } catch { /* noop */ }
    try { hub?.dispose() } catch { /* noop */ }
    try { stateStore.flush() } catch { /* noop */ }
    try { claim.release() } catch { /* noop */ }
  }

  // 软取（没有也不能拦住整个插件）：mira_account = 「形象是一个账号」的绑定表。
  const softGet = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const audioOf = () => {
    try {
      return ctx.miraMedia || null
    } catch {
      return null
    }
  }
  const inputOf = () => {
    try {
      return ctx.miraDevice || null
    } catch {
      return null
    }
  }
  const mediaStatus = () => {
    try {
      const audio = audioOf()
      return audio && typeof audio.status === 'function' ? audio.status() : null
    } catch {
      return null
    }
  }
  const deviceStatus = () => {
    try {
      const input = inputOf()
      return input && typeof input.status === 'function' ? input.status() : null
    } catch {
      return null
    }
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

    hub = new EventHub({ logger, counters })

    const deps = {
      configStore,
      stateStore,
      hub,
      catalog,
      // 权限已搬到 mira_device：外观工具的校验通过它的 authz 服务
      deviceAuthz: () => {
        const device = softGet('miraDevice')
        return device && device.authz ? device.authz : null
      },
      assetsDir: ASSETS_DIR,
      logger,
      counters,
      mediaStatus,
      deviceStatus,
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
    const audio = mediaStatus()
    const input = deviceStatus()
    logger?.info?.('[muse_vtuber] 已加载：工具 ' + TOOL_NAMES.length + ' 个，模型目录 ' + view.dir
      + '（' + view.dirSource + '，' + view.models.length + ' 个模型），接口 /vtuber/api/'
      + '；依赖 mira_media ' + (audio ? (audio.configured ? '已就绪' : '已加载但未配 key') : '缺失')
      + '，mira_device ' + (input ? '已就绪' : '缺失'))
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
      deps: { audio: audio !== null, input: input !== null },
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
