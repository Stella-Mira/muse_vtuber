# muse_vtuber — DSH 界面交互（形象）

任务书 §muse_vtuber 的实现：在 DSH GUI 里加一个**「形象」页签**，主位是 LIVE2D 形象，侧边栏自上而下是
**视频 / 音频 / LIVE2D 表情菜单**；输入框里在「模型选择」与「发送」之间多两个按钮（**摄像头 / 麦克风**）；
语音识别与图像识别的**事件流直接把结果插话（steer）进当前会话**；模型能通过阿里云 TTS **说话**；
设置页配阿里云 key、TTS / ASR / 图像识别 / 音色与设备。

- 版本：**3.1.0**（3.0.0 是按任务书重写为纯 GUI 插件；3.1.0 接通语音链路并修掉表情误报；
  旧 2.0.1 是「外部 stella muse_vtuber 节点」的桥，见文末「迁移」）
- 位置：`PluginDSH/muse_vtuber`
- 依赖：**零第三方依赖**（只用 `node:` 内置 + 浏览器 API）；`assets/lib/` 里是 LIVE2D 运行库（见 `THIRD-PARTY-NOTICES`）

---

## 1. 界面结构（对照任务书功能点）

| 功能点 | 落地 |
|---|---|
| 1 新界面「形象」在「对话」「轨迹」之后 | 注册 `conversation.view`，`id:"muse-avatar"`、`order:20`（对话 0、轨迹 10，排在后面） |
| 2 形象主体 + 侧边栏 | 左侧 `.mv-main`（LIVE2D 舞台 + 气泡），右侧 `.mv-side` |
| 3 主位 LIVE2D；侧边栏自上而下 视频 / 音频 / 表情菜单 | `VideoPanel` → `AudioPanel` → `ExpressionPanel` |
| 4 输入框「发送」与「模型选择」之间加摄像头/麦克风按钮 | 注册 `conversation.input.right`（该槽位渲染在模型选择之后、提交按钮之前） |
| 5 摄像头关 → 视频黑屏；开 → 显示捕获画面 | `VideoPanel` 里 `<video>` + `MediaStream`；关闭时黑底一行「摄像头已关闭」 |
| 6 麦克风关 → 音频直线；开 → 显示波形 | `AudioPanel` 用 `AnalyserNode.getByteTimeDomainData` 画波形；关闭时画直线 |
| 7 语音识别 / 图像识别事件流直接激活会话（插话）；TTS 让模型说话 | 浏览器断句 → `POST /vtuber/api/asr` → 阿里云识别 → `agent.steer()`；识图同路。TTS 见 `vtuber_say` / `POST /say` |
| 8 设置界面（阿里云 TTS/ASR/图像识别/音色） | 注册 `settings.section`（`@deepseek-ai/dsh-client-ui-settings`），读写 `config.json`，key 写 600 凭据文件 |
| 9 背景是「频谱环」，隐藏或没模型时也有东西可看 | `SpectrumRing`：纯 2D canvas 背景层，环上 96 根竖条；麦克风开着用麦克风频谱、模型说话用 TTS 频谱、都没有就走缓慢呼吸波形。模型隐藏（`visible:false`）/ 没有可用模型 / 加载失败 / WebGL 上下文丢失时，环继续画，中间写清原因 —— 不再有白屏 |

浏览器侧（`lib/client.js`）三个注册点共用**模块级单例**：摄像头/麦克风流、事件流、LIVE2D 舞台。
所以页签切走再切回来不会重新申请权限、也不会掉流；输入框按钮在「对话」页签里点开摄像头，
切到「形象」就能看到画面。

**两条稳定性约定（都是踩过坑才写下的）**：

- 舞台的 DOM 节点**恒定存在**（隐藏只切 `opacity`）。早期版本用「有/没有模型就换一个节点」的方式渲染，
  任何一次上层重渲染都可能把挂 canvas 的那个节点换掉 → 表现就是「形象忽然不见了」。
- 摄像头/麦克风失败**只**回退开关，绝不碰舞台；失败原因按 `NotFoundError` / `NotAllowedError` /
  `NotReadableError` / `OverconstrainedError` 翻成人话（没设备、权限被拒、被别的程序占用、参数不支持）。
- **布局**：`.mv-view` 的高度按「视图顶部到窗口底部」**实测钉死**（`window.innerHeight - top`，`resize` 与
  `ResizeObserver` 时重算），主位因此永远等于可视高度、模型完整显示；可滚动的只有右侧栏
  （`.mv-side{overflow-y:auto;min-height:0}`），提示文字沉在侧边栏最底（`.mv-side-footer{margin-top:auto}`）。
  早期版本靠 `height:100%`，在宿主那个高度是 auto 的槽位里解析不出来 → 网格行被侧边栏内容撑高 →
  画布比可视区还高，而模型是底部对齐的，所以「只看到下半身、要往上滑」。

## 2. 落盘（约定1 / 约定3 / 约定7）

```
$DSH_HOME/mira_config/muse_vtuber/          # DSH_HOME 缺省 ~/.dsh；不写安装目录、不写 cwd
  config.json             配置（schemaVersion 1）。**唯一**会自动创建的文件：不存在时按 patch + 默认原子写一份
  state.json              界面实况（摄像头/麦克风/模型/表情/可见性，schemaVersion 1）
  creds/dashscope.json    阿里云 API key（schemaVersion 1，权限 600，永不回显、不进日志）
```

写盘一律「临时文件（pid+随机后缀）→ fsync → rename → fsync 目录」（`lib/kit.mjs` 的 `writeJsonAtomic`），
断电不会留下半截 JSON。**热生效**：`config.json` 的 mtime 变了，下一次读取就重新加载（约定9），
不需要重启；换代码仍然要重启宿主。

## 3. 配置表（默认值全部在此）

路径：`$DSH_HOME/mira_config/muse_vtuber/config.json`；设置页保存就写这里。**cordis patch 里那一行只是基线**。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不注册工具与路由 |
| `live2d.modelsDir` | `""` | 留空 = 依次找 `mira_config/muse_vtuber/model` → `mira_config/mira_live2d/model`（共用 mira_live2d 那套模型）。手填绝对路径优先 |
| `live2d.model` | `""` | 要显示的模型（目录名或 `*.model3.json`）。**留空 = 不显示模型**（只剩频谱环，这是默认）；设置页选完保存会**立即切换**，配置值只作"下次的默认" |
| `live2d.width` / `height` | `420` / `560` | 初始画布尺寸（CSS 像素），实际会随容器缩放 |
| `camera.enabled` | `true` | 关掉后「摄像头」按钮与 `vtuber_look` 明确报 `config/missing` |
| `camera.deviceId` | `""` | 留空 = 浏览器默认摄像头；要钉死某台设备就填它的 `deviceId` |
| `camera.width` / `height` | `640` / `480` | `getUserMedia` 的 `ideal` 请求值 |
| `mic.enabled` | `true` | 关掉后「麦克风」按钮、`vtuber_listen`、自动识别都不可用 |
| `mic.deviceId` | `""` | 留空 = 浏览器默认输入设备；要钉死某支麦克风就填它的 `deviceId`（与 `camera.deviceId` 同口径） |
| `mic.sampleRate` | `16000` | 送识别的目标采样率（浏览器侧线性重采样后编码 WAV） |
| `mic.vad.threshold` | `0.02` | 断句电平阈值（RMS），越大越不灵敏 |
| `mic.vad.silenceMs` | `650` | 停顿多久算一句说完 |
| `mic.vad.minSpeechMs` | `320` | 太短的杂音不送识别 |
| `mic.vad.maxMs` | `15000` | 一句最长时长，超了强制切段 |
| `tts.enabled` | `true` | 关掉后 `vtuber_say` 报 `config/missing` |
| `tts.provider` | `aliyun` | **`aliyun`（默认，实测可用）= `POST {base}/services/audio/tts/SpeechSynthesizer`**，body `{model, input:{text, voice, format:'wav', sample_rate}}` → 拿 `output.audio.url` 再下载；`openai` = `POST {base}/audio/speech` 直接回音频字节 |
| `tts.base` | `https://token-plan.maas.qianwenaiapi.com/api/v1` | 原生口用 `…/api/v1`；`provider=openai` 时改成 `…/compatible-mode/v1`（或 `https://dashscope.aliyuncs.com/…`） |
| `tts.model` | `qwen-audio-3.0-tts-plus` | 同族还有 `qwen-audio-3.1-tts-plus/-flash`、`qwen-audio-3.0-tts-flash` |
| `tts.voice` | `longanhuan_v3.6` | **Qwen-Audio-TTS 的音色是 `longan*` 系列**（不是 CosyVoice 的 Cherry/Serena），清单见官方「Qwen-Audio-TTS 音色列表」 |
| `tts.maxChars` | `600` | 单次最长字数（按**码点**截断，不劈 emoji），截断会回报 `truncated:true` |
| `tts.timeoutMs` | `30000` | 原生口含一次 URL 下载 |
| `asr.enabled` | `true` | |
| `asr.provider` | `aliyun` | **`aliyun`（默认，实测可用）= `POST {base}/services/aigc/multimodal-generation/generation`**，content 是 `[{type:'input_audio', input_audio:{data:'data:audio/wav;base64,…'}}]` + `parameters:{format, sample_rate, language_hints}`（**format 必填**）；`openai` = `POST {base}/audio/transcriptions`，multipart 传 WAV。**base 必须跟着 provider 选前缀** |
| `asr.base` | `https://token-plan.maas.qianwenaiapi.com/api/v1` | 与 `tts.base` 同一个 host 的 `api/v1`（`provider=openai` 时改成 `…/compatible-mode/v1`） |
| `asr.model` | `qwen-audio-3.0-asr-flash` | 原生口吃 `data:audio/wav;base64,...`；兼容口吃 multipart 的 WAV |
| `asr.language` | `zh` | 原生口作为 `language_hints:[lang]`、兼容口作为 multipart 字段 |
| `vision.enabled` | `true` | |
| `vision.provider` | `dsh` | **`dsh`（默认）= 把这一帧作为图片放进工具结果，交给当前会话的模型自己看**（走宿主附件库，和 `read_image` 同一条路；不调第三方、不额外花钱）；`aliyun` = 服务端调视觉模型返回一段文字。`autoIntervalMs > 0` 的自动识图**始终走 aliyun**（那条路不经过模型） |
| `vision.base` | `https://token-plan.maas.qianwenaiapi.com/api/v1` | 先试原生多模态口，遇 `Model not exist`/404 自动切到 `{host}/compatible-mode/v1/chat/completions`（+`image_url`），并记住结果 |
| `vision.model` | `qwen3.8-flash` | 这个网关没有 VL 专模，`qwen3.8-flash` 能收图（实测 200）；换官方 DashScope 用 `qwen-vl-max-latest` |
| `vision.prompt` | 一句中文描述 | 默认提示词（`vtuber_look` 可覆盖） |
| `vision.autoIntervalMs` | `0` | >0 = 摄像头开着时按这个间隔自动抓帧识别并（按 events）插话；0 = 只用工具/手动。**来源是采集器时同样生效**（宿主侧调度，不需要页面） |
| `capture.enabled` | `true` | 外部采集器（虚拟摄像头/麦克风）开关 |
| `capture.fps` / `capture.width` | `8` / `720` | 告诉采集器按什么"设备口径"出帧（面板显示用）。真机看 4fps/480 偏糊，默认抬到 8fps/720 |
| `capture.audio` | `true` | 是否要采集器推 PCM（关掉就只收画面） |
| `capture.autoSwitch` | `true` | 采集器接入时自动把 `cameraSource`/`micSource` 切到 `galaxy` |
| `capture.maxAudioMs` | `30000` | 单句音频上限（PCM 缓冲上限） |
| `capture.staleMs` / `capture.lostMs` | `3000` / `15000` | 多久没数据算 stalled / lost（lost 会 close 并把来源回落） |
| `events.enabled` | `true` | 识别结果自动进会话 |
| `events.steer` | `true` | `true` = 插话（steer）；`false` = 只显示在侧边栏 |
| `events.voiceTemplate` | `[感知·语音] {text}` | 支持 `{kind} {text} {time} {date} {sessionId}` |
| `events.visionTemplate` | `[感知·画面] {text}` | 同上 |
| `events.minIntervalMs` | `5000` | 两条之间最小间隔 |
| `events.maxPerMin` | `6` | 每分钟上限 |
| `events.cooldownKeyMs` | `30000` | 同一句话的冷却 |
| `events.maxChars` | `400` | 单条事件正文字数上限 |
| `ui.showHint` | `true` | 首次进入给操作提示 |
| `legacyNode.enabled` | `false` | 旧的外部节点桥（见「迁移」）；开的时候把旧配置整体放进 `legacyNode.config` |

> **约定2（显式优先）**：阿里云 API key 是唯一必填项，**没有默认、不自动探测**。没配时工具返回
> `{"ok":false,"error":{"code":"creds/missing","message":"…","hint":"在形象界面的「设置 · 形象」里填 key…"}}`，
> 而不是静默留白或改用别的供应商。

## 4. 工具（10 个，返回 JSON 文本；`vtuber_look` 例外，见下）

「权限」列说明这个工具需要什么身份（见 §4.1）：**taker** = 控制者，**observer** = 观众。

| 工具 | 权限 | 干什么 | 失败长什么样 |
|---|---|---|---|
| `vtuber_status` | 只读 | 只读：状态（含 `visible`/`expression`/`toggles`/`motion`）、模型清单与**缺失资源**、TTS/ASR/识图就绪（含 `provider`/`attachmentsReady`）、连着的页面数、事件流与计数，以及 `security`（你是谁/能不能控）。排障第一站 | 永不失败（配置坏了也会把 `configError` 报回来） |
| `vtuber_say` | **taker** | 合成并让形象说话（浏览器播音频 + 口型跟音量动） | 没页面连着 → `delivery/failed`；不是 taker → `authz/conflict`（加 `force:true` 可抢） |
| `vtuber_expression` | **taker** | 表情三件套：`name` = 互斥表情（空串恢复默认）；`toggles` = 整体替换叠加开关集合；`switch` + `on` = 单个开关。名字必须来自 `models.expressions` | 名字不在清单里 → `expression/unknown` + 可用清单，**且状态原样不动**；当前没显示模型 → `model/none` |
| `vtuber_motion` | **taker** | 播放模型动作组（`models.motions`，如 `Idle`）；不传 = 列清单 | 名字不在清单里 → `motion/unknown` + 清单；当前没显示模型 → `model/none` |
| `vtuber_visible` | **taker** | 显示/隐藏形象主体（隐藏后频谱环仍在；不传 `on` = 切换） | — |
| `vtuber_model` | **taker** | 切模型；不传 = 列清单；`clear:true` = 不显示模型（只留频谱环） | 找不到 → `config/missing` + 可用清单 |
| `vtuber_camera` / `vtuber_mic` | observer | 开/关摄像头、麦克风（不传 `on` = 切换）；来源是采集器时表示"要不要接收那路流"。归"接收"档：不让观众开设备就没法看/听了 | — |
| `vtuber_look` | observer | 取当前一帧 → **默认把这一帧交给当前会话的模型自己看**（`vision.provider=dsh`，走附件库，`render` 返回 `[说明文字, image 块]`，和 `read_image` 同一约定）；`provider=aliyun` 时改为服务端识别返回文字。`steer:true` 只在 aliyun 模式有意义。**来源是采集器时直接用宿主缓存的那一帧，不需要页面在场** | 摄像头没开 → `camera/closed`；“没页面” → `delivery/failed`（仅本机设备源）；宿主没有附件服务 → `platform/unsupported`；模型不吃图片 → `vision/unsupported` |
| `vtuber_listen` | observer | 让浏览器录 N 秒 → ASR 识别 → 返回文字；`steer:true` 顺手插话 | 麦克风没开 → `mic/closed`；来源是采集器 → `mic/external`（外部麦克风不支持按需回放，它自己会送整句） |

`vtuber_look` / `vtuber_listen` 在**本机设备**源下需要**有页面在场**（用的是用户自己的摄像头/麦克风），
没有页面时明确报 `delivery/failed` 并说清“打开形象页签”，不假装成功；
来源切成**外部采集器**（`cameraSource/micSource = galaxy`）后，画面来自宿主缓存（无页面也能看），
音频由采集器持续推、按 `mic.vad` 断句，`listen` 会明确回 `mic/external`。

### 4.1 权限：形象是一个「有主人的账号」

vtuber 在 [`mira_account`](../mira_account) 里是一个**本地虚拟账号**（`platform: 'vtuber'`，
不需要连接、登记后即 `online`）。peer 是**形象本身**（`kind: 'avatar'`，`peerId: 'main'`），
**会话**是绑定的主体 —— 一个 taker + 多个 observer：

| 角色 | 能做什么 |
|---|---|
| **taker**（控制者，唯一） | 说话、表情、动作、显隐、换模型 —— 以及所有 observer 能做的事 |
| **observer**（观众，可多个） | 看 / 听 / 开关摄像头麦克风 / 往它推采集流（`capture/open`） |

规则：

- **首次控制自动认领**：第一个调控制类工具的会话直接成为 taker（`security.autoClaim`）。
- **别人占着就报冲突**：`authz/conflict` 会说清"形象现在由会话 X 控制"，加 `force: true` 可抢，
  原 taker 自动降级成 observer（还能看，不能控）。
- **观众自动登记**：没绑定的会话第一次"看/听"时自动成为 observer（`security.autoObserve: false` 可关）。
- **mira_account 缺席 → 全禁止**（`authz/unavailable`，这是安全默认）。
  临时放开：`security.mode: 'off'`（等于谁都能控制，不建议长期这样）。

| 键 | 默认 | 说明 |
|---|---|---|
| `security.mode` | `enforce` | `enforce` = 按绑定判权；`off` = 全放开（兜底开关） |
| `security.accountId` | `vtuber-main` | 在 mira_account 里的账号 id |
| `security.peerKind` / `peerId` | `avatar` / `main` | peer 是形象本身，一般不用改 |
| `security.cacheMs` | `30000` | 判定缓存；0 = 每次都查（绑定改完立刻生效） |
| `security.autoClaim` | `true` | 首次控制自动认领 taker |
| `security.autoObserve` | `true` | 没绑定的会话第一次接收时自动登记 observer |

一次性准备（装好 mira_account 之后）：

```
mira_account_add { id: "vtuber-main", platform: "vtuber", label: "形象" }
```

之后谁先调 `vtuber_say` 谁就是 taker；想指定主人就让那个会话先调一次，
或者用 `mira_account_bind { sessionId, accountId: "vtuber-main", kind: "avatar", peerId: "main", mode: "taker" }`。

> `vtuber_expression` 的校验顺序是「先查清单、再落状态」：模型里没有的名字**不会**写进 `state.json`。
> 早期版本先写后查，未知名字会一直留在状态里，客户端每次应用都失败一次 —— 本地实测还会把
> pixi 的表达式管理器写坏，表现是「模型忽然不渲染了」。

## 5. 宿主 HTTP 面（`/vtuber/api/*`，全部同源校验）

浏览器侧只用这些接口；宿主侧不碰 DOM。

| 方法与路径 | 作用 |
|---|---|
| `GET /vtuber/api/bootstrap` | 一次拿全：配置（脱敏）、状态、模型清单、能力/凭据就绪 |
| `GET /vtuber/api/capabilities?model=` | 表情/动作清单 + 缺失资源 |
| `GET /vtuber/api/events` | **SSE**：`hello` / `state` / `say` / `command` |
| `POST /vtuber/api/state` | 界面状态（摄像头/麦克风/模型/表情）→ 落 `state.json` → 广播 |
| `POST /vtuber/api/asr` | `{ base64, mime, sessionId, auto }` → 识别 →（按配置）steer。`auto:true`（界面自动事件流）受 `events` 限流约束；`auto:false` 默认**只回文本**，要投递再加 `steer:true` |
| `POST /vtuber/api/vision` | `{ image: dataURL, prompt?, sessionId, auto }` → 识图 →（同上规则）steer |
| `POST /vtuber/api/say` | `{ text, voice? }` → 合成 → 广播 `say` |
| `GET /vtuber/api/audio/<id>` | TTS 音频（内存缓存 32 条 / 10 分钟） |
| `POST /vtuber/api/result` | 浏览器回执（`look` / `listen` 的结果，按 `requestId` 配对） |
| `GET/POST /vtuber/api/settings` | 设置页读写；GET **永不回 key**，只回 `keyConfigured` |
| `GET /vtuber/api/health` | 存活探针（客户端数、音频缓存、配置错误、`features.capture`） |
| `GET /vtuber/assets/*`、`/vtuber/models/*` | 运行库与模型静态文件 |

**外部采集器（虚拟摄像头/麦克风）**：`muse_galaxy` 这类采集器把画面和声音推进来，
vtuber 把它们当成"正在用的摄像头/麦克风"。这些端点**只接受本机回环 + 令牌**：

| 方法与路径 | 作用 |
|---|---|
| `POST /vtuber/api/capture/open` | `{label, source, kinds?, sessionId?, fps?, width?, audio?}` → `{captureId, want, cameraUrl}`；同一 `source` 幂等；`capture.autoSwitch` 时自动把来源切到 `galaxy` |
| `POST /vtuber/api/capture/frame` | `{captureId, jpeg}`（≤2MB）→ 存最近一帧并分发给面板 |
| `POST /vtuber/api/capture/pcm` | `{captureId, pcm(base64 s16le), sampleRate}` → 宿主按 `mic.vad` 断句 → ASR → 插话；回 `{level}` |
| `POST /vtuber/api/capture/ping` | 纯音频流维持心跳（否则被判 stalled/lost） |
| `POST /vtuber/api/capture/close` | `{captureId, reason}`；之后同 id 回 `410/404`，来源回落 |
| `GET /vtuber/api/stream.mjpg?capture=` | `multipart/x-mixed-replace`，面板 `<img>` 直接播 |

令牌文件 `$DSH_HOME/mira_config/muse_vtuber/capture.json`（600，首次自动生成），
请求带 `Authorization: Bearer <token>`。**取帧策略仍在本插件**（`vision.autoIntervalMs` 决定识别间隔、
`mic.vad` 决定断句），采集器只按 `open` 返回的 `want`（fps/宽度/是否要音频）出数据。

**同源守卫**：`Sec-Fetch-Site: cross-site` 或 `Origin` 与 `Host` 不同源一律 403 ——
这些接口能改状态、烧 TTS 额度、往会话里插话，不能让任意网页盲调。

## 6. 事件流怎么“直接激活会话”

**语音（默认开，只要麦克风打开）**

```
麦克风 → AudioContext(16k) → ①波形用的 AnalyserNode
                          → ②ScriptProcessor 取 PCM → 本地 VAD 断句
VAD：RMS > mic.vad.threshold(0.02) 判说话；保留最近 300ms 预录（不吞首字）；
     静音 mic.vad.silenceMs(650ms) 或累计 mic.vad.maxMs(15s) → 切一段；
     短于 mic.vad.minSpeechMs(320ms) → 不送（当杂音丢掉）
→ 重采样到 mic.sampleRate(16000) → 16bit 单声道 WAV → base64（一次一句，不是整段流）
→ POST /vtuber/api/asr { base64, mime:'audio/wav', sessionId, auto:true, durationMs, sampleRate }
→ 宿主调 asr（默认 aliyun 原生口：POST {asr.base}/services/aigc/multimodal-generation/generation，
   content [{type:'input_audio', input_audio:{data:'data:audio/wav;base64,…'}}] +
   parameters {format:'wav', sample_rate, language_hints:['zh']} + 头 X-DashScope-SSE:disable；
   `asr.provider=openai` 时改走 {asr.base}/audio/transcriptions，multipart 传 WAV）
→ 文本截到 events.maxChars(400) → 套 events.voiceTemplate → 限流 → agent.steer(...)
```

**图像**

```
vtuber_look（默认 vision.provider="dsh"）：
  抓帧 → dataURL → attachments.saveImage() → 工具结果里带 image 字段
       → render 返回 [<source>/<question>/<content> 说明文字, {type:'image', attachment}]
       → **当前会话的模型自己看这张图**（和内置 read_image 完全同一条路，不调第三方）
  前置检查：llm.resolveModelInfo(provider, model) 的 inputModalities 必须含 image，
       否则直接报 vision/unsupported（换多模态模型，或把 provider 改成 aliyun）

vtuber_look（vision.provider="aliyun"）：
  抓帧 → POST 服务端 → 阿里云 qwen-vl → 一段文字回来（steer:true 才插话）

自动识图（vision.autoIntervalMs > 0，默认 0=关）：
  每 N ms 抓一帧 → POST /vtuber/api/vision → 阿里云 qwen-vl → 套 events.visionTemplate → 限流 → steer
  （这条路不经过模型，所以即使 provider=dsh 也仍然需要阿里云 key）
```

**限流（语音和图像共用一套闸）**：`events.minIntervalMs`(5000) / `events.maxPerMin`(6) /
`events.cooldownKeyMs`(30000，同一句话冷却)。命中不是静默丢弃，侧边栏那行会写
`（min-interval，未插话）`，`vtuber_status.counters` 里有 `percept.*` 计数。

**其它要点**

- **为什么是 steer 不是 followup**：followup 要等这一整轮结束才轮到它 —— 那就不叫“它听到了”。
- `sessionId` 取当前页签的会话；**没有 sessionId 就不投递**并报 `config/missing`（不猜用哪个会话）。
- 消息 `source.kind` 必须是生产者自己的名字（会话格式 v4 的准入规则），这里是 `muse_vtuber`。
- **抓帧不依赖当前页签**：`Capture` 自己挂一个隐藏 `<video>` 抓帧，所以在「对话」页签里开着摄像头，
  自动识图 / `vtuber_look` 也照样能抓到（早期版本用页面里那个预览元素，切走页签就抓不到）。
- 断句全在浏览器本地做（不上传音频流），阿里云只收到「一句一段的 WAV」—— 省流量也省额度。
  两者都需要 API key，没配就报 `creds/missing`。

## 7. 凭据纪律（约定8）

- key **只**在 `creds/dashscope.json`（600）；配置里**没有** `apiKey` 这个键，也不接受从环境变量读。
- 设置页 POST 只回 `keyConfigured: true/false`，输入框留空保存 = 不改。
- 报错文案统一过 `redact()`：把 key 本体和 `Bearer xxx` 都抹成 `***`，再截断 400 字。
- 权限不是 600 时打一行 warn（只报路径与权限位，不碰内容）。

## 8. 模型与资源缺失（功能点9）

`models.js` 会解析 `model3.json` 的 `FileReferences`，逐个检查 `Moc` / `Textures` / `Physics` / `Pose` /
`Expressions[].File` / `Motions[].File`，缺什么就说清是哪个文件、属于什么类型：

```
vtuber_status → models.missing: [{ file: "SylviaMuse.4096/texture_02.png", why: "贴图" }]
侧边栏表情菜单 → 缺资源：…（放进 <模型目录>/<模型名>/）
宿主日志 → [muse_vtuber] 模型资源缺失 3 项（模型：SylviaMuse）：…
```

表情分两类（与 mira_live2d 同一套约定）：`开关-*` / `动作-*` 可**同时打开**（叠加层），
其余（`表情-*`）互斥。叠加是把“当前互斥表情 + 所有打开的开关”合成一个 `ExpressionMotion`，
经 `expressionManager` 的官方队列应用 —— 每帧从干净基线重算，不会逐帧累积漂移。

## 9. 迁移：旧 2.0.1（外部节点桥）→ 3.0.0 / 3.1.0

旧版是「DSH ↔ stella muse_vtuber 节点」的桥：MCP 拿工具、`/dsh` 出口拿事件，工具名 `muse_*`（14 个）。
3.0.0 按任务书重写成**纯 GUI 插件**，节点桥不是任务书范围。处理：

1. 旧实现原样保留在 `lib/legacy/node-bridge.js`，**默认不加载**；
2. 要恢复旧能力：把旧 `cordis.patch.yml` 那一行的 `node` / `mcp` / `perceive` / `speak` / `live` / `target` /
   `sourceShape` / `debug` **整体**搬进 `config.legacyNode.config`，再把 `legacyNode.enabled` 设为 `true`
   → 它会在形象页签照常加载的同时注册回 `muse_*` 工具（失败只 warn，不影响形象页签）；
3. 旧的 `_*.mjs` 探针脚本（`_probe_*` / `_tune_*` / `_watch_*` / `_test_*`）、
   `selftest-source-shape.mjs`（只测旧入口的来源形状探测）与 `locale/*.json`（旧工具展示名）
   随旧入口一起删除；旧实现的全部内容在 `lib/legacy/node-bridge.js` 里，SVN 历史可查。

**没有需要“删了重配”的项**：新配置里所有旧键都不再读取，插件按默认值起，设置页里点几下就配好。

## 10. 已知取舍（写在这里而不藏在代码里）

1. **断句在浏览器侧做**（RMS + 静音时长 + 300ms 预录），不引云端实时 ASR。好处是零依赖、延迟低；
   代价是嘈杂环境需要调 `mic.vad.threshold`。**外部采集器源例外**：PCM 由宿主接、宿主按同一套
   `mic.vad` 断句（见第 5 节的 `capture/*`）。
2. **TTS 音频只放内存**（32 条 / 10 分钟，超出丢最旧），不落盘 —— 避免在 `mira_config` 里堆音频文件。
3. **识别与识图都吃 base64**，单请求体上限 16 MiB；超长音频会被 VAD 切成多句。
4. **`vtuber_look` / `vtuber_listen` 在本机设备源下必须有页面在场**（要用户的摄像头/麦克风），
   没页面就明确失败；来源换成外部采集器后 `look` 用宿主缓存的那一帧（无页面可用），
   `listen` 明确回 `mic/external`。
5. **自动识图默认关**（`vision.autoIntervalMs: 0`）：定时抓帧会持续消耗额度，要开就显式开。
6. **模型目录默认复用 mira_live2d 的那套**（存在才用），因此本插件不需要再复制一份几个 GB 的模型。
7. LIVE2D 运行库（pixi / cubism4 / live2dcubismcore）是**复制**进来的，不是跨插件 import：
   插件以 `link:` 装入时跨包相对 import 会指向包外。版权见 `assets/lib/THIRD-PARTY-NOTICES.md`。
8. 表情叠加用 `expressionManager._setExpression()`（下划线接口）：这是 mira_live2d 已在生产用的路径，
   但上游改名就会失效 —— 失效时的表现是“开关点了没反应”，不会崩。

## 11. 验收

```powershell
node --check lib\client.js            # 浏览器模块只做语法自检
node test\smoke.mjs                   # → ==== ALL PASS（86 项断言）==== 退出 0
node test\http-e2e.mjs                # → ==== ALL PASS（12 项端到端断言）==== 退出 0（真起 http + 真 SSE）
node ..\tool_shared\tools\check-zero-dep.mjs
node ..\tool_shared\tools\check-kit.mjs
```

手工验收（装好后）：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 打开会议话界面 | 顶部页签顺序：对话、轨迹、**形象** |
| 2 | 点「形象」 | 主位出现 LIVE2D；右侧自上而下 视频（黑屏+「摄像头已关闭」）/ 音频（一条直线）/ 表情 |
| 3 | 点输入框里的「摄像头」 | 侧边栏视频区出现画面；再点一次回到黑屏 |
| 4 | 点「麦克风」，说一句话 | 音频区波形随声音动；停顿后侧边栏出现「听到：…（已插话）」；会话里多一条 `[感知·语音]` 用户消息（正在跑的话是插到最近一步） |
| 5 | 对模型说「你看看我现在什么样」 | 模型调 `vtuber_look` → 返回画面描述（摄像头要开着） |
| 6 | 设置 · 形象 → 填阿里云 key → 保存 | 提示「API key 已写入 600 凭据文件」；`vtuber_status` 的 `credentials.configured=true` |
| 7 | 让模型说句话（`vtuber_say`） | 形象出声，口型跟音量动，气泡显示文字 |
| 8 | 把 `config.json` 的 `schemaVersion` 改成 99 再重载 | 工具报 `config/schema`（含迁移提示），**不静默清空配置** |

## 12. 开发约定

- 只依赖 `node:` 内置与浏览器 API；`lib/kit.mjs` 是 `tool_shared/kit/kit.mjs` 的**逐字节副本**（`check-kit.mjs` 校验）。
- 所有工具返回 `{ ok:true, … }` 或 `{ ok:false, error:{ code, message, hint } }`。
- 单实例保护：`apply` 里 `claimInstance('muse_vtuber')`，第二个实例直接报 `plugin/instance`。
- 退场顺序：摘工具 → 卸路由 → 停 SSE 与等待中的请求 → 落状态 → 放认领（`ctx.effect` 与装配失败走同一条路径）。
- 关键状态变更打一行 info，错误打 warn 并计数（`vtuber_status.counters` 可见）。

## 13. 安装记录（示例：Windows，profile = `web`）

> 本节是**通用安装要点**，不含任何具体机器路径；下文路径一律用占位符替换：
> `<PLUGIN>` = 插件源码目录，`%DSH_HOME%` = 你的 DSH 数据目录（缺省 `C:\Users\<you>\.dsh`）。

| 项 | 值 |
|---|---|
| profile 依赖 | 包里 `name` 必须是 `muse_vtuber`，profile 里用 `"muse_vtuber": "link:<PLUGIN>/muse_vtuber"` |
| 实际入口 | `<PLUGIN>/muse_vtuber/lib/index.js` |
| patch 条目 | `include:muse_vtuber`（`id`/`name` 都是 `muse_vtuber`），config 里只有 `enabled` + `live2d.modelsDir` 等少量键 |
| 模型目录 | 建议放在 `%DSH_HOME%\mira_config\muse_vtuber\live2d`（也可复用一个已有的模型目录，如 mira_live2d 的 `model/`） |
| 配置/状态/凭据 | `%DSH_HOME%\mira_config\muse_vtuber\{config.json,state.json,creds\dashscope.json}` |

升级前建议先备份 `%DSH_HOME%\profiles\web\` 下的 `cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`；
回滚就是把这三份拷回去。

### 两个「改代码不生效」的坑（都实测过）

1. **宿主半**：Loader 把模块缓存在「解析后的真实路径」上，`plugin_manager set_plugin` 关开只会重放
   缓存里的旧模块；`dsh-hmr` 又明确跳过 `node_modules/` 下的路径。**换代码必须重启 `dsh web`**。
   （中途试过用别名 specifier 绕开缓存：宿主半确实能换新代码，但见下一条，前端半会直接消失。）
2. **前端半**：`dsh-client-modules` 解析 `dsh.client` 时，从模块真实路径往上找 package.json，
   且要求 **`name` 严格等于 loader 条目的 specifier**（`nearestPackage` → `name === expectedPackageName`）。
   别名装了 `muse_vtuber_ui`、包里 `name` 却是 `muse_vtuber` → 前端半被**静默跳过**
   （现象：页签没有、设置里也没有「形象」，控制台甚至不报错）。
   所以安装名必须与包名一致；这一版最终就是规范名 `muse_vtuber`。

### 已知缺口

1. **阿里云 API key 没配时**：`vtuber_status.credentials.configured=false`，`vtuber_say` /
   语音识别 / 图像识别都会报 `creds/missing`。到「设置 · 形象」里填一次即可（写 600 凭据文件）。
2. 卸载/回滚后要重启 `dsh web` 才生效（同「坑 1」）。

## 14. 多设备 / 多页签同时打开一个会话会怎样

**接入方式**：每个页面一条 SSE（`GET /vtuber/api/events`），宿主只维护一份状态和一个语义广播。
`vtuber_status.events.clients` 就是当前连着的页面数。

| 行为 | 现在的语义 | 备注 |
|---|---|---|
| 模型 / 表情 / 可见性 | **全局一份**，任何一端改，所有端同步 | 这是想要的：形象是"一个" |
| 摄像头 / 麦克风开关 | 也是全局一份（写 `state.json`），但**只有发起改动的那个页面会去开自己的硬件**（`POST /state` 带 `clientId`，宿主把 `by` 记成 `client:<id>`，其它页面只同步开关外观） | 这条需要宿主重启后才生效；在此之前旧逻辑是「谁看到广播谁就去开」，两台设备会互相抢同一颗摄像头 |
| 语音合成（`vtuber_say` / 模型说话） | **所有端同时出声**（音频 URL 广播给所有页面） | 只想一端出声就在那端静音或关掉页面 |
| 语音识别 / 自动识图 | 每个页面各自采集、各自带自己的 `sessionId` 往同一会话插话；**限流是全局的**（`minIntervalMs` / `maxPerMin` / 同句冷却） | 两台设备同时说话会互相压制，且会话里会出现两条独立事件 |
| `vtuber_look` / `vtuber_listen`（命令往返） | 广播给所有页面，**先回执的那一端**生效；后回执的 `requestId` 已失效（宿主返回 `command/unknown`，忽略即可） | 所以"从哪台设备抓画面"不确定 —— 要确定性就得按 `clientId` 定向，见下 |
| 状态文件 | 一份，最后写入者胜 | 关掉一个页面不会回滚另一端的状态 |

**想做到「每台设备独立摄像头/麦克风」**（可选下一步）：把 `state.devices` 做成
`{ [clientId]: { cameraOn, micOn } }`，`look`/`listen` 增加 `clientId` 参数只发给指定页面，
开关按钮按自己的 `clientId` 落自己的那一格。工作量约半天，`state.json` 要升 schemaVersion 2（带迁移）。
现在没做，因为默认语义（"一个形象、一份状态"）更符合看板娘的直觉。

