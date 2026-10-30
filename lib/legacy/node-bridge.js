/**
 * muse_vtuber —— DSH 的「缪斯」桥接插件（v2，节点版）
 *
 * 与 v1（lib/index.js，保留留档）的根本区别：v1 桥的是**老独立 sprite** 的 MCP（:8383，launchd 常驻那套），
 * 本版桥的是 **stella 的 muse_vtuber 节点** —— 那个节点同时装着
 *   type_sense（感知）/ type_sprite（输出）/ type_astral（记忆）/ type_ketset（网关能力）
 *   / type_vtuber（编排）/ type_dsh（DSH 出口）/ type_mcpcpp（MCP 投影）。
 * 分工（见 stella/type/dsh/README.md 的决策）：
 *   · 工具面  → 节点 MCP（:11110/mcp，JSON-RPC over HTTP；11100 留给原有的 star_sprite）
 *   · 事件面  → 节点出口（:11102/dsh/events，NDJSON 流 + since 续传）
 *   · 感知事件 → 去重/节流 → agent.followup(...) 触发一轮 DSH 对话
 *
 * 只用 Node 内置能力（fetch/AbortController），无第三方依赖。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'muse_vtuber'
// ★ 服务必须**声明**才能访问：Cordis 的 ctx 代理对未声明的服务**访问即抛**
//   （实测：cannot get property "agents" without inject —— 插件激活成功，但一调 muse_status 就报这个）。
//   本插件用到：tools（注册工具）、agents（挑注入目标会话 / 新建直播会话）。
export const inject = ['tools', 'agents']

// ─────────────────────────────────────────── 配置

const DEFAULTS = {
  enabled: true,
  node: {
    base: 'http://127.0.0.1:11102/dsh',   // dsh 出口
    token: '',
    cmdTimeoutMs: 30000,
  },
  mcp: {
    url: 'http://127.0.0.1:11110/mcp',    // type_mcpcpp 投影（muse 节点专用端口：11100 留给原有的 star_sprite）
    timeoutMs: 30000,
  },
  perceive: {
    enabled: true,
    families: ['voice', 'vision', 'social'],   // system（总线公告）默认不触发
    excludeKinds: ['peer_join', 'peer_leave', 'clock', 'tick', 'gap'],
    minIntervalMs: 1500,        // 两条触发之间的最小间隔（直播：原 5000 太迟钝）
    maxPerMin: 20,             // 每分钟上限（原 6；直播里观众一直在说话）
    cooldownKeyMs: 8000,       // 同一 (family|kind|来源) 的冷却（原 30000）
    template: '[直播事件·{kind}] {text}',
    // 每轮追加的"怎么处理"提示（写进注入消息本身，模型一定会看到）。
    //   ★ 直播口径：**说不说由你判断**。这句必须在，因为事件会不停进来（观众说话、有人进房），
    //     不提示的话模型容易每条都回应 —— 直播里那就成了复读机。
    hint: '（这是直播中感知到的一件事。判断：值得对观众回应就调 muse_say 说出你的话；'
      + '不值得回应就什么都不做、继续听。不要念出这条提示本身。）',
    maxChars: 400,
    autoSay: false,            // 触发后是否顺手让精灵朗读（默认否：让模型自己决定 muse_say）
    autoSayVoice: '',
  },
  // DSH → 节点：助手消息的**自动**朗读中继。
  //
  // ★ 默认 **关**（2026-10-06 用户口径修正：直播场景）：
  //   "由 DSH 调用工具说，**他认为这个事件需要回应那就说**" ——
  //   也就是"说不说"必须由**模型判断**，而不是把每条助手消息自动念出来：
  //     · 自动念会把 DSH 的干活汇报、思考残留一起播出去，直播里非常吵；
  //     · 直播要的是"该接话才接话"，主动权在模型手里（它调 muse_say / muse_bubble）。
  //   打开它只在一种场景有意义：你希望 DSH 的每条回复都变成台词（单人解说、AFK 陪聊）。
  //   与模型自己的 muse_say 不会重复：模型调过的话，中继会按文本前缀跳过。
  speak: {
    enabled: false,             // 直播口径：说不说由模型判断（见上面的说明）
    voice: '',
    maxChars: 220,
    minIntervalMs: 1200,
  },
  target: { agentId: '' },     // 非空 = 钉死这个会话（优先级最高，压过下面的窗口逻辑）
  // ── 直播会话窗口（用户口径 2026-10-06）────────────────────────────────
  //   "记录直播开始/结束；新直播距上次结束小于一定时长就用上一次会话，否则开一个新会话。"
  //   做法照 mira_qqbot 的 autoReply（它已验证可行）：agents.resume/get 复用、agents.create 新建、
  //   chatId→sessionId 映射原子落盘 meta.json、重启后按映射恢复。
  //   为什么需要：直播时你不在对话，currentInitiator() 常常是空 ⇒ 会落到"最后一个会话"
  //   （可能是无关会话）。直播必须有一个**属于自己的**会话。
  live: {
    enabled: true,
    reuseWindowMs: 30 * 60 * 1000,   // 距上次直播结束 ≤ 这个时长 ⇒ 复用同一会话；超过 ⇒ 开新的
    agentCwd: '',                  // 会话工作目录（决定它出现在哪个工作区；数据存其下 data/）；留空 = 用宿主默认
    agentPreset: 'standard',         // 必须挂一个存在的预设，否则工具/提示词为空层且装配报错
    agentProvider: '',               // 留空用宿主默认（留空且宿主没有默认时，agent 会报 has no provider/model）
    agentModel: '',
    title: '缪斯直播',                // 直播会话标题（界面显示）
    idleEndMs: 10 * 60 * 1000,       // 超过这么久没有任何直播事件 ⇒ 视为"直播结束"（兜底，非权威）
  },
  sourceShape: 'auto',
  debug: false,
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(base) || typeof base !== 'object') return patch
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v)
  return out
}

const cap = (s, n) => String(s ?? '').slice(0, n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────── 注入消息的来源形状（v4 世代 / 更早世代）
//
// 会话格式 v4 起，消息来源不再有 catch-all 的 `kind:'plugin'`：`source.kind` 必须是「生产者
// 自己的」kind，写 `{kind:'plugin',plugin:'…'}` 会被会话准入直接拒 ——
//   SessionFormatError: format v4 message requires a producer-owned source kind
// v3→v4 迁移器给「它不认识的插件」选的目标形状就是 `plugin:<插件名>`，所以 v4 宿主用
// `{kind:'plugin:muse_vtuber'}`（同时不再有 plugin 字段；已用 DSH 自己的准入码实测通过）。
//
// 更早世代保守沿用老形状 `{kind:'plugin',plugin:'muse_vtuber'}`，理由（都实测过）：
//   · v2 时代来源 kind 是闭集（user/plugin/model/tool/…，见 dsh-session-format-v2-to-v3 的
//     SOURCE_KINDS），`plugin:<名>` 不在其中 = 会被当「未分类来源」拒；
//   · v3 时代 `system/message` 必须带 `{kind:'plugin',plugin:…}`（同一文件 "system message
//     requires plugin source"）；user/message 的 kind 已不再受闭集约束 —— 我拿发布的
//     releasedV3SessionFormatCodec.encodeEvent() 实测过：v3 两种形状都收。
//     既然老宿主上「老形状」是已知可用，就在老宿主上继续用它，不去赌。
//
// 所以策略是「宿主是 v4 世代吗？」：是 → 新形状；不是/认不出 → 老形状。

const SOURCE_BY_FORMAT = {
  4: { kind: 'plugin:muse_vtuber' },
  3: { kind: 'plugin', plugin: 'muse_vtuber' },   // 3 及更早世代统一用它
}
const DEFAULT_SOURCE_FORMAT = 4      // 探测不到时的兜底（当前世代都是 v4）
let sourceShapeMemo = null

const readDirSafe = (dir) => { try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] } }

/** 会话目录里 session.v<N>.* 的文件名 = 宿主写出的会话格式。 */
function formatOfSessionDir(dir) {
  for (const f of readDirSafe(dir)) {
    const m = /^session\.v(\d+)\./.exec(f.name)
    if (m) return { format: Number(m[1]), how: `session file ${f.name}` }
  }
  return null
}

/** 先按当前会话目录认（精确）；认不到就扫目录并取**最高**版本（老 v3 残留不会把 v4 宿主判成 v3）。 */
function formatFromSessionFiles(sessionId, home) {
  if (!home) return null
  const root = join(home, 'sessions')
  const wsDirs = readDirSafe(root).filter((e) => e.isDirectory()).map((e) => join(root, e.name))
  if (sessionId) {
    for (const ws of wsDirs) {
      const hit = formatOfSessionDir(join(ws, sessionId))
      if (hit) return hit
    }
  }
  let best = null
  let scanned = 0
  for (const ws of wsDirs.slice(0, 50)) {
    for (const e of readDirSafe(ws)) {
      if (!e.isDirectory()) continue
      if (++scanned > 400) break
      const hit = formatOfSessionDir(join(ws, e.name))
      if (hit && (!best || hit.format > best.format)) best = { ...hit, how: hit.how + ' (store max)' }
    }
    if (scanned > 400) break
  }
  return best
}

/** 宿主装没装 v3→v4 迁移包 = 这个宿主是不是 v4 世代（老世代只有 v2→v3）。 */
function formatFromHostPackages(argv1) {
  let dir = typeof argv1 === 'string' && argv1 ? dirname(argv1) : ''
  let root = null
  for (let i = 0; dir && i < 6; i++) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@deepseek-ai/dsh') { root = dir; break }
    } catch { /* 不是 dsh 的 package.json，继续往上 */ }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  if (!root) return null
  for (const r of [root, dirname(root)]) {
    const mods = join(r, 'node_modules', '@deepseek-ai')
    if (existsSync(join(mods, 'dsh-session-format-v3-to-v4', 'package.json'))) return { format: 4, how: 'host ships dsh-session-format-v3-to-v4' }
    if (existsSync(join(mods, 'dsh-session-format-v2-to-v3', 'package.json'))) return { format: 3, how: 'host ships only dsh-session-format-v2-to-v3' }
  }
  return null
}

/** 探测宿主世代：{format, how}；两路都不认就看不出（返回 null）。包探测优先（它是宿主的「能力」）。 */
export function detectSourceShape(opts = {}) {
  const home = opts.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  return formatFromHostPackages(opts.argv1 || process.argv[1])
    || formatFromSessionFiles(opts.sessionId || process.env.DSH_SESSION_ID, home)
    || null
}

/**
 * 交给 agent.followup 的 source（每次给一份新的、可直接被宿主冻结的对象）。
 * @param cfg 插件配置（只看 cfg.sourceShape）
 * @param log 调试日志（cfg.debug 时才真写）
 * @param sessionId 目标会话 id（agent.id），用来认这个宿主写出的会话格式
 */
export function pluginSource(cfg = {}, log = () => {}, sessionId = '') {
  const forced = cfg.sourceShape
  if (forced === 'v4' || forced === 'v3') return { ...SOURCE_BY_FORMAT[forced === 'v4' ? 4 : 3] }
  if (!sourceShapeMemo) {
    const hit = detectSourceShape({ sessionId })
    const format = hit && SOURCE_BY_FORMAT[hit.format] ? hit.format : DEFAULT_SOURCE_FORMAT
    log(`message source shape: v${format} (${hit ? hit.how : 'detection failed; assuming v4'})`)
    sourceShapeMemo = SOURCE_BY_FORMAT[format]
  }
  return { ...sourceShapeMemo }
}

/** 仅供离线自检：清掉探测缓存。 */
export function resetSourceShapeMemo() { sourceShapeMemo = null }

// ─────────────────────────────────────────── 节点客户端（出口 /dsh + MCP）

class NodeClient {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.mcpSession = null
    this.mcpNameMap = null      // 短名 → 限定名（见 mcpResolve；随会话失效）
    this.lastSeq = 0
  }

  headers(extra = {}) {
    const h = { ...extra }
    if (this.cfg.node.token) h['Authorization'] = 'Bearer ' + this.cfg.node.token
    return h
  }

  /** 出口命令：{op: ping|tools|list|call|subscribe|publish|astral} */
  async cmd(op, extra = {}) {
    const res = await fetch(new URL('cmd', this.cfg.node.base + '/'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ op, ...extra }),
      signal: AbortSignal.timeout(this.cfg.node.cmdTimeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`cmd ${op} http ${res.status}: ${cap(text, 200)}`)
    try { return JSON.parse(text) } catch { throw new Error(`cmd ${op} 非 JSON: ${cap(text, 200)}`) }
  }

  health() { return fetch(new URL('health', this.cfg.node.base + '/'), { headers: this.headers() }).then((r) => r.json()) }

  /** 就近调一个节点工具（走出口的 call；不需要 MCP 会话） */
  async call(tool, args = {}) {
    const r = await this.cmd('call', { tool, args })
    if (r && r.ok === false) throw new Error(`${tool} 失败: ${r.error || JSON.stringify(r)}`)
    return r
  }

  // ---- MCP（工具面）：initialize → notifications/initialized → tools/call ----
  async mcpEnsure() {
    if (this.mcpSession) return this.mcpSession
    const init = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'muse_vtuber', version: '2.0.0' } },
    }
    const res = await fetch(this.cfg.mcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(init),
      signal: AbortSignal.timeout(this.cfg.mcp.timeoutMs),
    })
    if (!res.ok) throw new Error(`mcp initialize http ${res.status}`)
    const sid = res.headers.get('mcp-session-id')
    await res.text().catch(() => '')
    if (!sid) throw new Error('mcp initialize 没有回 mcp-session-id')
    await fetch(this.cfg.mcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(this.cfg.mcp.timeoutMs),
    }).catch(() => {})
    this.mcpSession = sid
    return sid
  }

  async mcp(method, params, id = 2) {
    try {
      return await this.mcpOnce(method, params, id)
    } catch (e) {
      // ★ MCP 会话失效要能自愈（2026-10-06 补）：原来 sid 只缓存、永不作废 ⇒
      //   **节点重启后 MCP 侧永久失败**，只能重载插件才恢复（实测踩过）。
      //   判据：http 404/400 或会话相关错误 ⇒ 丢掉 sid 与名字缓存，重握手一次再试。
      const m = String(e && e.message)
      if (!/http (400|404)|session|not initialized/i.test(m)) throw e
      this.log(`mcp 会话失效，重握手一次（${cap(m, 120)}）`)
      this.mcpSession = null
      this.mcpNameMap = null
      return await this.mcpOnce(method, params, id)
    }
  }

  async mcpOnce(method, params, id = 2) {
    const sid = await this.mcpEnsure()
    const res = await fetch(this.cfg.mcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(this.cfg.mcp.timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`mcp ${method} http ${res.status}: ${cap(text, 200)}`)
    // 可能是 SSE（data: {...}）或裸 JSON
    const jsonText = text.startsWith('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : text
    const rp = JSON.parse(jsonText)
    if (rp.error) throw new Error(`mcp ${method} 错误 ${rp.error.code}: ${rp.error.message}`)
    return rp.result
  }

  async mcpListTools() {
    const r = await this.mcp('tools/list', {}, 11)
    return Array.isArray(r && r.tools) ? r.tools : []
  }

  /**
   * 工具名解析：**节点侧的 MCP 名字是限定名** `{star.uuid}.{star_name}.{kit.name}`
   * （type_mcpcpp 2026-10-06 改造后的口径），而本插件/对外门面用短名（`muse.say`）。
   * cppmcp 是**精确名查表**（vendor/cppmcp/src/mcp_server.cpp:596 `tools_.find(tool_name)`
   * → 未命中抛 `Tool not found`），所以短名直调必然失败。
   * 这里按**后缀**解析：先列出工具名，缓存一份 `短名 → 真名`；
   * 解析不到就原样返回（让节点去报它自己的错误，别在这里吞掉）。
   * 缓存随会话失效（节点重启会换 uuid）。
   */
  async mcpResolve(tool) {
    if (!tool) return tool
    if (!this.mcpNameMap) {
      try {
        const list = await this.mcpListTools()
        const map = new Map()
        for (const t of list) {
          const n = t && typeof t.name === 'string' ? t.name : ''
          if (!n) continue
          map.set(n, n)                              // 真名 → 真名（幂等）
          // ★ 限定名是**三段**：`{star.uuid}.{star_name}.{kit.name}`（type_mcpcpp 的 qualify），
          //   而 star_name 自己可能带下划线（`muse_vtuber`）⇒ **不能只切第一个点**。
          //   按"每个点的位置都试一遍"生成候选短名，先到先得：
          //     a3f1….muse_vtuber.muse.say
          //       → muse_vtuber.muse.say（切第 1 个点）
          //       → muse.say           （切第 2 个点）★ 这才是门面用的短名
          let at = -1
          while ((at = n.indexOf('.', at + 1)) >= 0) {
            const short = n.slice(at + 1)
            if (!short) continue
            if (!map.has(short)) map.set(short, n)
          }
        }
        this.mcpNameMap = map
        this.log(`mcp 工具名解析表：${map.size} 条（短名可直调）`)   // 排障用：这一行没了就说明 tools/list 没取到
      } catch (e) {
        // ★ 用 String(e) 而不是 e.message：抛出来的不一定是 Error（也可能是字符串/对象），
        //   那样 e.message 是 undefined ⇒ 这行日志变成"取不到（按原样调用）：undefined"，
        //   真正的原因被抹掉（本插件第一版就是这样把一次解析失败藏了整轮）。
        this.log(`mcp tools/list 取不到（按原样调用）：${String((e && e.message) || e)}`)
        this.mcpNameMap = new Map()
      }
    }
    return this.mcpNameMap.get(tool) || tool
  }

  /**
   * 调节点工具。两条腿，按可靠性排序：
   *   ① MCP（tools/call，名字是**限定名**，工具 schema 齐全）—— 主路径；
   *   ② 出口桥 `/dsh/cmd {op:call, tool:<短名>}` —— 回退路径。
   * 为什么要有 ②：MCP 这一层依赖"短名 → 限定名"的解析，而限定名里含**节点 uuid**
   * （节点重启/换配置就变）。实测两种失败都出现过：会话失效、以及解析表没建立起来时
   * 直接 `Tool not found: muse.say`。桥那边是按**短名**匹配的（type_dsh 里 `k.name()==tool`），
   * 不随 uuid 变、也不会有会话概念 ⇒ 作为兜底它稳得多。
   * 这样"让节点说话"这条**最关键的出口**不会因为 MCP 层的状态而整个哑掉。
   */
  async callTool(tool, args = {}) {
    try {
      return await this.mcpCall(tool, args)
    } catch (e) {
      this.log(`MCP 调用失败，回落出口桥：${tool}（${cap(String(e && e.message), 120)}）`)
      const r = await this.cmd('call', { tool, args })
      if (r && r.ok === false) throw new Error(`${tool}: ${cap(JSON.stringify(r), 300)}`)
      return typeof r === 'string' ? r : JSON.stringify(r)
    }
  }

  async mcpCall(tool, args = {}) {
    const name = await this.mcpResolve(tool)
    const r = await this.mcp('tools/call', { name, arguments: args }, 12)
    const content = Array.isArray(r && r.content) ? r.content : []
    const text = content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n')
    if (r && r.isError) throw new Error(`${tool}: ${cap(text, 300)}`)
    return text
  }

  /**
   * 事件流（NDJSON，带 since 续传）。onLine 收到一行解析后的对象；
   * 断线由调用方重连（本函数返回时说明流断开或被打断）。
   */
  async stream(onLine, signal) {
    const url = new URL('events', this.cfg.node.base + '/')
    url.searchParams.set('since', String(this.lastSeq || 0))
    const res = await fetch(url, { headers: this.headers({ Accept: 'application/x-ndjson' }), signal })
    if (!res.ok) throw new Error(`events http ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let obj = null
        try { obj = JSON.parse(line) } catch { continue }

        // ★ 断线重放去重（2026-10-06 实测修：同一条消息被反复灌进 DSH 的排队窗口）：
        //   节点在"客户端带的 since 太旧/不属于本进程"时会**发一条 gap 并从缓冲最旧重放**
        //   （type_dsh.cpp 的 since_from_previous_process 分支）。插件原来只一味把 lastSeq 往上推，
        //   于是重放回来的旧事件被当成新事件、**又注入一轮** —— 你看到的就是同一条
        //   `[直播事件·speech] 主播你好…` 反复进入排队窗口。
        //   正确语义：**已经交给 DSH 过的 seq 就不再交**（跨连接保持"已投递水位"）。
        //   gap 只是节点在说"我要跳/重放了"，我们用 delivered 水位判断要不要放过，
        //   绝不因为 gap 就把水位退回去（那样重放又会全部涌进来）。
        if (obj && obj.ev === 'gap') {
          this.gaps = (this.gaps || 0) + 1
          // 节点明说这个 since 属于"上一个进程" ⇒ 它的 seq 计数已经从头开始
          //   ⇒ 允许**一次性**把已投递水位重置（否则水位会挡住新节点的全部新事件）。
          //   注意只在见到那个原因时重置，别的一般 gap 不重置 —— 宁可漏一次也比重放洪泛好。
          if (obj.reason === 'since_from_previous_process') this.allowReset = true
          this.log(`出口 gap：节点要跳/重放（from=${obj.from} want=${obj.want} 原因=${obj.reason || '-'}）`)
          continue
        }
        if (obj && obj.ev) continue                      // tick 等控制行：不注入
        const seq = obj && typeof obj.seq === 'number' ? obj.seq : 0
        if (seq > 0) {
          if (this.allowReset && seq <= (this.delivered || 0)) {
            this.log(`节点 seq 从头开始（上一进程的 gap 已声明）⇒ 重置已投递水位到 0`)
            this.delivered = 0
            this.allowReset = false
          }
          if (seq <= (this.delivered || 0)) { this.dupSkipped = (this.dupSkipped || 0) + 1; continue }
          this.delivered = seq
          this.lastSeq = seq                            // 给下次连接带的 since
        }
        try { onLine(obj) } catch (e) { this.log('onLine threw (caught):', e && e.message) }
      }
    }
  }
}

// ─────────────────────────────────────────── 直播会话（窗口复用 / 新建）
//
// 用户口径（2026-10-06）："dsh 插件加一个配置记录直播开始结束时间，如果新开始的直播距离上次结束
//   小于一定时长，用上一次会话，否则开一个新会话。"
//
// 为什么要它：直播时你不在跟它对话，`currentInitiator()` 往往是空的 ⇒ 注入会落到"最后一个会话"
//   （可能是无关的会话）。直播必须有一个属于自己的会话，且"同一场直播始终同一会话"。
//
// 做法照 `mira_qqbot` 的 autoReply（那套已在本机验证可行）：
//   · 先 `agents.resume({resumeSessionId})` 恢复持久化会话；
//   · 报 "while it is live" ⇒ `agents.get()` 取现成实例复用（不新建、不丢绑定）；
//   · 都不行 ⇒ `agents.create({sessionId, meta:{cwd, agentPreset}, setup})`，并把映射原子落盘；
//   · setup 里 `ctx.get('agentPresets').mount(ctx, presetId)` —— 缺预设会报装配错误。
class LiveSession {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    this.state = null          // { active, sessionId, startedAt, endedAt, lastEventAt }
    this.agent = null
    this.busy = false
  }

  get dir() {
    const cwd = this.cfg.live.agentCwd
    return cwd ? join(cwd, 'data') : null
  }
  get metaPath() { const d = this.dir; return d ? join(d, 'meta.json') : null }

  load() {
    const p = this.metaPath
    if (!p) return {}
    try { return JSON.parse(readFileSync(p, 'utf8')) || {} } catch { return {} }
  }
  save(patch) {
    const p = this.metaPath
    if (!p) { this.log('live: 未配 agentCwd ⇒ 直播窗口不会持久化'); return }
    // 原子写：先写临时文件再 rename，避免进程中途退出留下半截 meta.json
    try {
      mkdirSync(this.dir, { recursive: true })
      const cur = this.load()
      const next = { ...cur, ...patch }
      const tmp = p + '.tmp'
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(tmp, p)
    } catch (e) { this.log('live: 保存 meta 失败：' + String((e && e.message) || e)) }
  }

  /** 新事件到达时更新窗口状态；返回 true 表示这次算"新的一场直播开始" */
  markEvent(now) {
    const s = this.state || (this.state = { active: false, sessionId: '', startedAt: 0, endedAt: 0, lastEventAt: 0 })
    const idle = now - (s.lastEventAt || 0)
    s.lastEventAt = now
    if (s.active && idle > this.cfg.live.idleEndMs) {
      // 长时间没事件 ⇒ 视为上一场已结束（兜底；权威信号是直播平台的 live_start/live_down）
      s.active = false
      s.endedAt = s.lastEventAt
      this.log(`live: 静默 ${(idle / 1000).toFixed(0)}s ⇒ 判定上一场直播已结束`)
      this.save({ liveEndedAt: s.endedAt })
    }
    if (!s.active) {
      s.active = true
      s.startedAt = now
      const gap = s.endedAt ? now - s.endedAt : Infinity
      s.reuse = gap <= this.cfg.live.reuseWindowMs
      this.save({ liveActive: true, liveStartedAt: now, liveEndedAt: s.endedAt || 0 })
      this.log(`live: 直播开始（距上次结束 ${s.endedAt ? (gap / 1000).toFixed(0) + 's' : '未知'} ⇒ ${s.reuse ? '复用上次会话' : '要开新会话'}）`)
      return true
    }
    return false
  }

  /** 直播结束（权威信号 voice/live_down / live_end 到达时调用） */
  markEnd(now) {
    const s = this.state
    if (!s || !s.active) return
    s.active = false
    s.endedAt = now
    this.save({ liveActive: false, liveEndedAt: now })
    this.log('live: 直播结束（已记录时间，下次在窗口内会复用本会话）')
  }

  /** agent 挂预设 + 标题（照 mira_qqbot 的 presetSetup / ensureSessionTitle） */
  setupFor(title) {
    return (agentCtx) => {
      const presets = agentCtx.get && agentCtx.get('agentPresets')
      const id = this.cfg.live.agentPreset || 'standard'
      const mount = presets ? Promise.resolve(presets.mount(agentCtx, id)) : Promise.resolve()
      return mount.then(() => {
        // 直播会话的"怎么说话"写进系统提示：这是它会话级的行为约定
        const sp = agentCtx.systemPrompt
        if (sp && typeof sp.section === 'function') {
          sp.section({
            name: 'muse_vtuber:live',
            order: -50,
            text: '【你现在在直播】你的观众在弹幕/语音里跟你说话，感知到的事件会作为消息进来。'
              + '判断值不值得回应：值得就用 muse_say 把你要说的话说出来（那才是"开口"）；'
              + '不值得就什么都不做、继续听。不要把内部汇报或思考过程用 muse_say 念出来。',
          })
        }
        return undefined
      })
    }
  }

  /** 确保有可用 agent（复用 or 新建）。失败返回 null（调用方回退到自动选择） */
  async ensure(now) {
    if (!this.cfg.live.enabled) return null
    const svc = this.svc
    if (!svc) return null
    if (this.busy) return this.agent
    this.busy = true
    try {
      // 1) 已有活实例
      if (this.agent && this.agent.status) return this.agent
      const meta = this.load()
      const wantId = this.state && this.state.sessionId ? this.state.sessionId : (meta.liveSessionId || '')
      // ★ 2026-10-06 修：`endedAt` 为空时**不要**一律当成"不可复用"。
      //   插件刚重启/重载时内存里没有 endedAt，旧逻辑 ⇒ gap = Infinity ⇒ 每重载一次就**新建**一个
      //   直播会话（本机实测：一次重载就多出一个"未命名"的直播会话，越积越多）。
      //   判据改成："这场直播还没结束（内存 active 或 meta.liveActive）⇒ 可复用（gap = 0）"。
      const wasActive = (this.state && this.state.active) || !!meta.liveActive
      const gap = this.state && this.state.endedAt && now ? now - this.state.endedAt
        : (wasActive ? 0 : Infinity)
      const mayReuse = wantId && gap <= this.cfg.live.reuseWindowMs
      const opts = {}
      if (this.cfg.live.agentProvider) opts.provider = this.cfg.live.agentProvider
      if (this.cfg.live.agentModel) opts.model = this.cfg.live.agentModel

      // 2) 复用持久化会话（resume → live 则 get）
      if (mayReuse) {
        try {
          const h = await svc.resume({
            resumeSessionId: wantId,
            ...(Object.keys(opts).length ? { agentOptions: opts } : {}),
            setup: this.setupFor(this.cfg.live.title),
          })
          if (h && h.agent) {
            this.agent = h.agent
            this.state.sessionId = wantId
            this.log(`live: 已恢复直播会话 ${wantId}`)
            return this.agent
          }
        } catch (e) {
          const msg = String((e && e.message) || e)
          if (/while it is live/i.test(msg) && typeof svc.get === 'function') {
            const live = svc.get(wantId)
            if (live) {
              this.agent = live
              this.state.sessionId = wantId
              this.log(`live: 复用正在运行的直播会话 ${wantId}`)
              return this.agent
            }
          }
          this.log(`live: 恢复失败（将新建）：${msg}`)
        }
      }

      // 3) 新建
      const newId = 'muse-live-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const h = await svc.create({
        sessionId: newId,
        ...(Object.keys(opts).length ? { agentOptions: opts } : {}),
        meta: {
          ...(this.cfg.live.agentCwd ? { cwd: this.cfg.live.agentCwd } : {}),
          agentPreset: this.cfg.live.agentPreset || 'standard',
        },
        setup: this.setupFor(this.cfg.live.title),
      })
      this.agent = h && h.agent
      this.state.sessionId = newId
      this.save({ liveSessionId: newId })
      this.log(`live: 已新建直播会话 ${newId}（预设 ${this.cfg.live.agentPreset}）`)
      return this.agent
    } catch (e) {
      this.log('live: 会话准备失败：' + String((e && e.message) || e))
      return null
    } finally {
      this.busy = false
    }
  }

  status() {
    const s = this.state || {}
    return {
      enabled: this.cfg.live.enabled,
      active: !!s.active,
      sessionId: s.sessionId || '',
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : '',
      endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : '',
      reuseWindowMs: this.cfg.live.reuseWindowMs,
      agentCwd: this.cfg.live.agentCwd,
      agentPreset: this.cfg.live.agentPreset,
      agent: this.agent && this.agent.id ? String(this.agent.id) : '',
      metaPath: this.metaPath || '',
    }
  }
}

// ─────────────────────────────────────────── 感知 → 轮次

class PerceptionLoop {
  constructor(ctx, client, cfg, log, live = null) {
    this.ctx = ctx
    this.client = client
    this.cfg = cfg
    this.log = log
    this.live = live          // LiveSession：直播窗口会话（可为空）
    this.running = false
    this.abort = null
    this.stats = { started: 0, received: 0, dropped: 0, fired: 0, lastFireAt: 0, lastError: '', lastText: '' }
    this.perKey = new Map()     // key -> 上次触发时间
    this.fireTimes = []         // 最近的触发时间戳（算每分钟上限）
  }

  keysOf(ev) {
    const f = ev.frame && typeof ev.frame === 'object' ? ev.frame : {}
    return {
      // ★ 「族」在 sense 的归一 message 里叫 **thread**，不叫 family：
      //   type/sense/type_sense.cpp:551 `data::make_message("sense", kind, family)`
      //   → type/data/message.h:99 的第三个形参落成字段 `thread`（那条 message 里没有 family 字段）。
      //   原先只读 f.family ⇒ 恒空 ⇒ families 白名单恒不命中 ⇒ **每条事件都被丢**
      //   （实测 received=339537 / dropped=339537 / fired=0，而且日志里一声不响）。
      //   family 仍读（别的推送方可能真带），thread 兜后面。
      family: String(f.family ?? f.thread ?? ev.family ?? ev.thread ?? ''),
      kind: String(f.kind ?? ev.kind ?? ev.ev ?? ''),
      from: String((f.from && (f.from.id || f.from.name)) ?? f.from ?? ''),
      text: this.textOf(ev),
    }
  }

  /** 事件 → 一句能给人看的话（拿不到就退化成截断 JSON，不编内容） */
  textOf(ev) {
    const f = ev.frame && typeof ev.frame === 'object' ? ev.frame : {}
    const cands = [
      f.text, f.summary, f.describe, f.say,
      f.content && f.content.text,
      f.data && f.data.text, f.asr && f.asr.text, f.result && f.result.text,
    ]
    for (const c of cands) if (typeof c === 'string' && c.trim()) return cap(c.trim(), this.cfg.perceive.maxChars)
    return cap(JSON.stringify(f), this.cfg.perceive.maxChars)
  }

  allow(ev, now) {
    const p = this.cfg.perceive
    const { family, kind, text } = this.keysOf(ev)
    if (!text) return 'no-text'
    if (p.families && p.families.length && !p.families.includes(family)) return 'family'
    if (p.excludeKinds && p.excludeKinds.some((k) => kind === k || kind.startsWith(k))) return 'kind'
    // 同一 (family|kind|来源) 冷却
    const key = `${family}|${kind}|${this.keysOf(ev).from}`
    const last = this.perKey.get(key) || 0
    if (now - last < p.cooldownKeyMs) return 'cooldown-key'
    // 全局最小间隔
    if (now - this.stats.lastFireAt < p.minIntervalMs) return 'min-interval'
    // 每分钟上限
    this.fireTimes = this.fireTimes.filter((t) => now - t < 60000)
    if (this.fireTimes.length >= p.maxPerMin) return 'rate-limit'
    this.perKey.set(key, now)
    this.fireTimes.push(now)
    if (this.perKey.size > 500) this.perKey.clear()
    return null
  }

  targetAgent() {
    // 优先级：① 配置指定的会话 ② **直播窗口会话**（见 LiveSession：同一场直播始终同一会话）
    //          ③ 当前正在调工具的那个 agent（"谁在跟我说话就注入谁"）
    //          ④ 正在跑的 ⑤ 最后一个。
    //   ⚠ ctx.agents 必须先在 inject 里声明，否则**访问即抛**（这条踩过）。
    let agents = null
    try { agents = this.ctx.agents } catch (e) { this.log('ctx.agents unavailable:', e && e.message); return null }
    if (!agents) return null
    const want = this.cfg.target.agentId
    try {
      if (want && typeof agents.get === 'function') {
        const a = agents.get(want)
        if (a) return a
      }
      // ② 直播窗口会话：正在直播（或处在复用窗口内）时，**只认它**
      if (!want && this.live && this.live.cfg.live.enabled) {
        const lv = this.live.agent
        if (lv) return lv
        const sid = this.live.state && this.live.state.sessionId
        if (sid && typeof agents.get === 'function') {
          const a = agents.get(sid)
          if (a) { this.live.agent = a; return a }
        }
        // ★ 2026-10-06 修（实测事故）：**直播窗口模式下不再往下回落到 ③④⑤**。
        //   旧行为会落到 ③ `agents.currentInitiator()`（"谁在跟我说话就注入谁"）⇒ 直播感知事件被
        //   注进**用户此刻正在聊的那个会话**。本机实测：编码会话里被注入 8 条 `plugin:muse_vtuber`，
        //   其中一条还触发了一轮把它当成用户提问的对话（"你不要念出这条提示本身"这类话进了别人的对话）。
        //   作者注释（旧 765-766 行）也承认"首场直播的第一条事件可能落到自动选择"。
        //   正确取舍：**宁可丢掉这条事件**（fire() 会记 `no injectable agent; event dropped`），
        //   也绝不污染无关会话。要恢复旧行为：把 `perceive.fallbackToActive` 设成 true。
        if (!(this.cfg.perceive && this.cfg.perceive.fallbackToActive)) {
          this.log('live window has no agent yet -> event dropped (not falling back to the active session)')
          return null
        }
      }
      if (!want && typeof agents.currentInitiator === 'function') {
        const cur = agents.currentInitiator()
        if (cur) return cur
      }
      const list = typeof agents.list === 'function' ? agents.list() : []
      if (Array.isArray(list) && list.length) {
        const running = list.find((a) => a && a.status === 'running')
        return running || list[list.length - 1]
      }
      if (typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots) && roots.length) return roots[roots.length - 1]
      }
    } catch (e) { this.log('target agent selection failed (caught):', e && e.message) }
    return null
  }

  async fire(ev) {
    const p = this.cfg.perceive
    const now = Date.now()
    const why = this.allow(ev, now)
    if (why) { this.stats.dropped++; return }
    const { kind } = this.keysOf(ev)
    const now2 = Date.now()
    // 直播窗口：每来一件事就更新"这一场直播"的状态（首件触发开新场/复用判定）
    if (this.live && this.live.cfg.live.enabled) {
      this.live.markEvent(now2)
      // 平台权威信号：直播开始/结束（bilibili 节点发的 voice/live_start、voice/live_down）
      if (kind === 'live_start') this.live.markEvent(now2)
      else if (kind === 'live_down' || kind === 'live_end') this.live.markEnd(now2)
      // 会话准备是异步的（可能 resume/create），这里不等它 —— targetAgent 会先用已有实例；
      //   首场直播的第一条事件可能落到自动选择，后续事件就归位了（下一轮优化：预建）
      if (!this.live.agent && !this.live.busy) void this.live.ensure(now2)
    }
    // 事件以"用户消息"的身份进 DSH 的一轮 —— 所以模板要写成**它能读懂该怎么处理**的形状。
    //   直播口径（用户 2026-10-06）：模型自己判断值不值得回应；要回应就调 muse_say。
    let text = p.template.replaceAll('{kind}', kind || '?').replaceAll('{text}', this.textOf(ev))
    if (p.hint) text += '\n' + p.hint
    const agent = this.targetAgent()
    if (!agent || typeof agent.followup !== 'function') {
      this.stats.lastError = '没有可注入的 agent'
      this.log('no injectable agent; event dropped')
      return
    }
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: pluginSource(this.cfg, this.log, agent && agent.id),
    }
    try {
      agent.followup(message)
      this.stats.fired++
      this.stats.lastFireAt = now
      this.stats.lastText = text
      this.log('perception -> DSH turn:', cap(text, 80))
      if (p.autoSay) {
        try { await this.client.call('muse.say', { text: cap(text, 200), voice: p.autoSayVoice || undefined }) }
        catch (e) { this.log('autoSay failed:', e && e.message) }
      }
    } catch (e) {
      this.stats.lastError = String(e && e.message)
      this.log('followup failed:', e && e.message)
    }
  }

  start() {
    if (this.running) return
    this.running = true
    this.stats.started++
    this.abort = new AbortController()
    const run = async () => {
      while (this.running) {
        try {
          await this.client.stream((ev) => {
            this.stats.received++
            if (ev && ev.ev === 'tick') return
            if (ev && ev.ev === 'gap') { this.log(`events gap: want=${ev.want} from=${ev.from}`); return }
            void this.fire(ev)
          }, this.abort.signal)
          if (this.running) { this.stats.lastError = '流断开，2s 后重连'; await sleep(2000) }
        } catch (e) {
          if (!this.running) break
          this.stats.lastError = String(e && e.message)
          this.log('events stream error, retrying in 2s:', e && e.message)
          await sleep(2000)
        }
      }
    }
    void run()
    this.log('perception loop started (families=%s exclude=%s minInterval=%dms maxPerMin=%d)',
      (this.cfg.perceive.families || []).join(','), (this.cfg.perceive.excludeKinds || []).join(','),
      this.cfg.perceive.minIntervalMs, this.cfg.perceive.maxPerMin)
  }

  stop() {
    this.running = false
    try { this.abort && this.abort.abort() } catch { /* ignore */ }
    this.abort = null
  }

  status() {
    return {
      running: this.running, ...this.stats, lastSeq: this.client.lastSeq,
      live: this.live ? this.live.status() : null,     // 直播窗口现场（会话 id / 起止时间）
    }
  }
}

// ─────────────────────────────────────────── 工具面（muse_*）

// 工具定义形状（2026-10-05 校准；v1 的 `output:{schema}` 是旧 API）：
//   当前 dsh-tools 要求 `output: { schema, render, presentationMeta? }`，
//   缺 render 会**拒绝注册**（实测报：tool "muse_status" must declare output { schema, render, presentationMeta? }）。
//   参考现成实现：@deepseek-ai/dsh-tool-pwsh 的 output.render 返回内容块数组。
function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2),
      }],
    },
    execute,
  }
}
const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })

function registerTools(ctx, client, loop, cfg, log, relay, live) {
  const defs = []
  const j = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

  defs.push(textTool('muse_status',
    '缪斯桥接状态：节点是否在线（dsh.ping）、感知回路统计、桌宠（sprite）状态、目标会话。排查问题的第一站。',
    obj({}), async () => {
      const out = { node: cfg.node.base, mcp: cfg.mcp.url, perceive: loop.status() }
      try { out.ping = await client.cmd('ping') } catch (e) { out.pingError = e.message }
      try { out.health = await client.health() } catch (e) { out.healthError = e.message }
      try { out.sprite = JSON.parse(await client.callTool('muse.status')) } catch (e) { out.spriteError = e.message }
      const a = loop.targetAgent()
      out.targetAgent = a ? { id: a.id, status: a.status } : null
      if (live) out.liveWindow = live.status()
      return j(out)
    }))

  // 直播会话窗口的控制/现场（用户口径：新直播距上次结束小于窗口就复用，否则开新的）
  if (live) {
    defs.push(textTool('muse_session',
      '直播会话窗口：status=看现场（会话 id、起止时间、是否复用）/ new=强制开新会话 / end=标记直播结束。'
      + '同一场直播的感知事件都会被注入到这个会话里。',
      obj({ action: str('status | new | end') }, ['action']),
      async (a) => {
        const now = Date.now()
        const act = String(a.action || 'status')
        if (act === 'new') {
          live.agent = null
          if (live.state) live.state.endedAt = 0        // 清掉窗口 ⇒ 下一次必然新建
          live.save({ liveSessionId: '' })
          const ag = await live.ensure(now)
          return j({ ok: !!ag, action: 'new', live: live.status() })
        }
        if (act === 'end') {
          live.markEnd(now)
          return j({ ok: true, action: 'end', live: live.status() })
        }
        return j(live.status())
      }))
  }

  defs.push(textTool('muse_help',
    '列出 muse_vtuber 节点当前对外提供的全部工具（名字 + 说明），用来确认能用哪些能力。',
    obj({}), async () => {
      const r = await client.cmd('tools')
      const tools = Array.isArray(r.tools) ? r.tools : []
      return tools.map((t) => `- ${t.name}：${cap(t.description || '', 90)}`).join('\n') || '(节点没有报工具)'
    }))

  defs.push(textTool('muse_nodes',
    '发现周边节点：列出本节点在总线上的邻居（uuid/度数）及其声明。用于「零号协议」层面的调度前侦察。',
    obj({}), async () => j(await client.cmd('list'))))

  defs.push(textTool('muse_subscribe',
    '订阅某个节点（或某个通道）的推送：owner=节点 uuid（channel 省略 = 先索取声明再自动订阅）。',
    obj({ owner: str('节点 uuid'), channel: str('通道 uuid（可省）') }, ['owner']),
    async (a) => j(await client.cmd('subscribe', { owner: a.owner, channel: a.channel }))))

  defs.push(textTool('muse_perceive',
    '感知回路控制：action=status|start|stop。start 后感知事件会直接触发 DSH 轮次（有去重与节流）。',
    obj({ action: str('status|start|stop') }), async (a) => {
      const act = String(a.action || 'status')
      if (act === 'start') loop.start()
      else if (act === 'stop') loop.stop()
      return j(loop.status())
    }))

  defs.push(textTool('muse_say',
    '【直播里的"开口说话"】让虚拟主播说出这句话：节点做 TTS + 口型/动作轨 + 窗口出画（真出声）。'
    + '你判断"这件事值得回应"时就调它 —— 例如观众说了话、有人进来、被叫到名字。'
    + '不调它，观众就什么都听不到（内部汇报、思考过程**不要**用它念出来）。voice 可选（如 rosy_fix）。',
    obj({ text: str('要说的台词（会被念出来，写口语）'), voice: str('音色（可省）') }, ['text']),
    async (a) => {
      // 登记一句"模型自己念过的话"：自动中继随后拿到同一条助手消息时就不再念一遍
      //   （否则同一句会被念两次 —— muse_say 一次 + 中继一次）。
      if (relay) relay.noteExplicit(a.text)
      return j(JSON.parse(await client.callTool('muse.say', { text: a.text, voice: a.voice || undefined })))
    }))

  defs.push(textTool('muse_bubble',
    '【只是显示一行字】让屏幕上出现气泡文字，**不朗读**（要出声请用 muse_say）。'
    + '适合：你想留个痕但不打断说话的节奏。', obj({ text: str('气泡文本') }, ['text']),
    async (a) => j(JSON.parse(await client.callTool('muse.bubble', { text: a.text })))))

  defs.push(textTool('muse_stop',
    '【打断】立刻停掉正在说的话、清空说话队列（观众打断、话题要换时说）。',
    obj({}), async () => j(JSON.parse(await client.callTool('muse.stop', {})))))

  defs.push(textTool('muse_listen',
    '开关桌宠的"听"（节点 sprite.listen）。', obj({ on: bool('true=开听') }, ['on']),
    async (a) => j(JSON.parse(await client.callTool('muse.listen', { on: a.on !== false })))))

  defs.push(textTool('muse_window',
    '显示/隐藏桌宠窗口（节点 sprite.window；隐藏后可用本工具唤回）。',
    obj({ on: bool('true=显示') }, ['on']),
    async (a) => j(JSON.parse(await client.callTool('muse.window', { on: a.on !== false })))))

  defs.push(textTool('muse_astral',
    '记忆服务（节点 astral 工具）：入参就是 astral 请求 JSON（op/form/info/id/...），例如 {"op":"select", ...}。',
    obj({ op: str('astral op（select/create/update/remove/…）') }),
    async (a) => j(await client.call('astral', a))))

  defs.push(textTool('muse_call',
    '逃生舱：直接调节点上的任意工具（先 muse_help 看名字）。args 就是该工具的参数 JSON。',
    obj({ tool: str('节点工具名，如 sense.recv'), args: { type: 'object', description: '该工具的参数' } }, ['tool']),
    async (a) => {
      try { return await client.callTool(a.tool, a.args || {}) }
      catch (e) { return j(await client.call(a.tool, a.args || {})) }
    }))

  const disposers = defs.map((d) => ctx.tools.register(d))
  ctx.effect(() => () => disposers.forEach((d) => { try { d() } catch { /* ignore */ } }))
  log(`registered ${defs.length} muse_* tools`)
}

// ─────────────────────────────────────────── DSH → 节点（自动语音中继）
//
// 目的（用户口径 2026-10-06）：**DSH 当脑子，节点当嘴/脸**。所以 DSH 每次生成完一条助手消息，
//   节点就应该把这句话说出来 —— 而不是"指望模型记得去调 muse_say"（模型忘了，它就哑了）。
//
// 钩子：`session/event`（post-commit 的持久事件流，见 DSH 的 Event 目录）。我们只认
//   `assistant/message` 且 `data.message.role === 'assistant'`，取其 content 里的 text 块。
//   · 只对该插件**目标会话**生效（多会话时不会把别的会话的话念出来）；
//   · 一轮里如果模型已经自己调了 muse_say，就跳过（避免同一句话念两遍）；
//   · 文本先过一遍 markdown 清理：念代码块/表格/ur 会很难听，也会把 TTS 拖长。
class SpeakerRelay {
  constructor(client, cfg, log) {
    this.client = client
    this.cfg = cfg
    this.log = log
    this.turnSaid = new Set()      // 本调度轮里已经念过的 turn
    this.lastExplicit = ''         // 模型自己调 muse_say 时说过的文本（用于去重，见 noteExplicit）
    this.lastAt = 0
    this.said = 0
    this.skipped = 0
    this.lastText = ''
    this.lastError = ''
  }

  /**
   * 登记"模型刚刚自己念过这句"：自动中继随后拿到同一条助手消息时就不再念一遍。
   * 用文本前缀比对而不是 turn 号 —— 工具回调里拿不到可靠的 turn，而"念的是不是同一段话"
   * 本来就是文本层面的问题（模型常把回复原样交给 muse_say，也可能只说摘要：两种都按前缀处理）。
   */
  noteExplicit(text) { this.lastExplicit = String(text || '').trim().slice(0, 60) }

  static clean(text) {
    let t = String(text || '')
    t = t.replace(/```[\s\S]*?```/g, '（代码略）')          // 代码块
    t = t.replace(/`([^`]*)`/g, '$1')                      // 行内代码
    t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')        // 链接/图片 → 文字
    t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '')               // 标题井号
    t = t.replace(/^\s{0,3}[-*+]\s+/gm, '')                // 列表符
    t = t.replace(/\*\*([^*]*)\*\*/g, '$1')                // 粗体
    t = t.replace(/[*_>|]/g, ' ')                          // 其余标记
    t = t.replace(/\s+/g, ' ').trim()
    return t
  }

  /** 助手消息 → 要念的文本（取 text 块，丢掉 reasoning / tool-call） */
  static assistantText(event) {
    const d = event && event.data
    const m = d && d.message
    if (!m || m.role !== 'assistant') return ''
    const parts = []
    for (const b of (m.content || [])) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return parts.join(' ')
  }

  async onSessionEvent(session, event) {
    try {
      if (!this.cfg.speak.enabled) return
      if (!event || event.type !== 'assistant/message') return
      // 只念目标会话（agentId 为空时 = 跟随感知回路的自动挑选）
      const want = this.cfg.target.agentId
      const sid = session && session.id ? String(session.id) : ''
      if (want && sid && sid !== String(want)) return
      const turn = event.data && event.data.turn
      const key = `${sid}#${turn}`
      if (this.turnSaid.has(key)) { this.skipped++; this.log(`说话中继：turn ${turn} 已由 muse_say 说过，跳过`); return }
      this.turnSaid.add(key)
      if (this.turnSaid.size > 500) this.turnSaid.clear()

      const now = Date.now()
      if (now - this.lastAt < this.cfg.speak.minIntervalMs) { this.skipped++; return }

      let text = SpeakerRelay.clean(SpeakerRelay.assistantText(event))
      if (!text) return
      // 模型刚刚自己念过同一段话 ⇒ 中继不再念（前缀比对，见 noteExplicit）
      if (this.lastExplicit && text.startsWith(this.lastExplicit)) {
        this.skipped++
        this.lastExplicit = ''
        this.log(`说话中继：与 muse_say 的内容相同，跳过（${this.cfg.speak.minIntervalMs}ms 内的同一句）`)
        return
      }
      this.lastExplicit = ''
      // 中文按**码点**截断（按字节截会把多字节字符切成半个，TTS 直接报错或念出乱码）
      const maxCp = this.cfg.speak.maxChars
      const cps = [...text]
      if (cps.length > maxCp) text = cps.slice(0, maxCp).join('') + '…'

      this.lastAt = now
      const r = await this.client.cmd('call', { tool: 'muse.say', args: { text, voice: this.cfg.speak.voice || undefined } })
      const ok = !(r && r.ok === false)
      if (ok) { this.said++; this.lastText = text }
      else { this.lastError = JSON.stringify(r).slice(0, 200) }
      this.log(`说话中继：${ok ? '已念' : '失败'}（turn ${turn}，${cps.length} 字）${text.slice(0, 40)}`)
    } catch (e) {
      this.lastError = String((e && e.message) || e)
      this.log('说话中继异常：', this.lastError)
    }
  }

  status() {
    return {
      enabled: this.cfg.speak.enabled, said: this.said, skipped: this.skipped,
      minIntervalMs: this.cfg.speak.minIntervalMs, maxChars: this.cfg.speak.maxChars,
      lastText: this.lastText, lastError: this.lastError,
    }
  }
}

// 供离线自检/复用（与 v1 一样把内部件导出，便于在 DSH 之外验证协议）
export { NodeClient, PerceptionLoop, SpeakerRelay, LiveSession, DEFAULTS, deepMerge }

export function apply(ctx, config) {
  const cfg = deepMerge(DEFAULTS, config || {})
  const log = (...a) => { if (cfg.debug) console.log('[muse_vtuber]', ...a) }

  if (!cfg.enabled) { log('plugin disabled (config.enabled=false)'); return }

  const client = new NodeClient(cfg, log)
  const live = new LiveSession(cfg, log)
  live.svc = (() => { try { return ctx.agents } catch { return null } })()   // 会话服务（inject 已声明）
  const loop = new PerceptionLoop(ctx, client, cfg, log, live)
  const relay = new SpeakerRelay(client, cfg, log)

  registerTools(ctx, client, loop, cfg, log, relay, live)

  if (cfg.perceive.enabled) {
    // 起回路 + 卸载时收摊（effect 拥有它）
    ctx.effect(() => { loop.start(); return () => loop.stop() })
  } else {
    log('perception loop is off by default (config.perceive.enabled=false; turn it on with muse_perceive start)')
  }

  // DSH → 节点：助手消息自动念出来（详见 SpeakerRelay 的说明）
  if (cfg.speak.enabled) {
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => { relay.onSessionEvent(session, event) })
      log('说话中继已挂上（session/event → muse.say）')
      return () => { try { off() } catch { /* already gone */ } }
    })
  } else {
    log('speak relay is off (config.speak.enabled=false)')
  }

  log(`ready: node=${cfg.node.base} mcp=${cfg.mcp.url}`)
}
