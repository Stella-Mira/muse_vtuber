/**
 * muse_vtuber / hub.js —— SSE 事件总线（宿主 → 所有浏览器页签）
 *
 * 拆分之后只剩**下行广播**，而且只有两类帧：
 *   hello  连接建立（带 seq 起点，便于前端重连后判断是否断档）
 *   state  形象状态变更（模型 / 表情 / 动作 / 可见性）
 *
 * 谁不再在这里：
 *   · `say`（朗读）→ mira_audio 的 `/audio/api/events`（形象客户端订阅它来画气泡/对口型）
 *   · `command`（让页面抓帧/录音）→ mira_input 的 `/input/api/events`
 *   · 感知事件投递（steer）→ mira_input（它才是感知的生产者）
 * 这样三个插件各有一条自己的事件流，谁不装都不影响别人。
 */

import { randomUUID } from 'node:crypto'

export class EventHub {
  /**
   * @param {object} [options]
   * @param {object} [options.logger]
   * @param {object} [options.counters]
   * @param {() => number} [options.now] 注入时钟（自检用）
   */
  constructor({ logger = null, counters = null, now = Date.now } = {}) {
    this.logger = logger
    this.counters = counters || { bump() {}, get() { return 0 }, snapshot() { return {} } }
    this.now = now
    this.clients = new Set()
    this.seq = 0
    this.pingTimer = null
    this.disposed = false
  }

  /** 挂一个 SSE 客户端；返回关闭函数。 */
  attach(req, res) {
    if (this.disposed) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('plugin disposed')
      return () => {}
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      // 反向代理（mira_proxy）后面必须关掉缓冲，否则事件要攒满一屏才到
      'x-accel-buffering': 'no',
    })
    const client = { res, id: randomUUID(), at: this.now() }
    this.clients.add(client)
    this.send(client, 'hello', { seq: this.seq, clientId: client.id, at: new Date(this.now()).toISOString() })
    this.ensurePing()
    const drop = () => {
      this.clients.delete(client)
    }
    try {
      req.on?.('close', drop)
      req.on?.('error', drop)
      res.on?.('close', drop)
      res.on?.('error', drop)
    } catch {
      drop()
    }
    this.counters.bump('sse.connect')
    return drop
  }

  get clientCount() {
    return this.clients.size
  }

  ensurePing() {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(': ping ' + this.now() + '\n\n')
        } catch {
          this.clients.delete(client)
        }
      }
    }, 15000)
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref()
  }

  send(client, type, payload) {
    this.seq += 1
    const frame = { seq: this.seq, type, at: new Date(this.now()).toISOString(), ...(payload || {}) }
    try {
      client.res.write('data: ' + JSON.stringify(frame) + '\n\n')
      return true
    } catch {
      this.clients.delete(client)
      return false
    }
  }

  /** 广播一帧给所有浏览器页签。返回送达的客户端数。 */
  broadcast(type, payload) {
    let sent = 0
    for (const client of [...this.clients]) {
      if (this.send(client, type, payload)) sent += 1
    }
    return sent
  }

  status() {
    return {
      clients: this.clients.size,
      seq: this.seq,
      counters: this.counters.snapshot(),
    }
  }

  dispose() {
    this.disposed = true
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const client of [...this.clients]) {
      try {
        client.res.end('data: {"type":"bye"}\n\n')
      } catch { /* 忽略 */ }
    }
    this.clients.clear()
  }
}
