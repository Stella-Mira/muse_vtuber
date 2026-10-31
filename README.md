# muse_vtuber — DSH 界面交互（形象）

任务书 §muse_vtuber 的实现。**4.0.0 起它只负责"画"（4.1.0 起连账号模型也去掉）**：给 DSH GUI 加一个**「形象」页签**
（对话 / 轨迹之后）——主位是 LIVE2D（说话时口型跟着音量动；没模型时频谱环兜底），
右侧栏自上而下是**视频 / 音频 / LIVE2D 表情**；设置页叫**「形象」**。

声音与输入已经拆成两个可复用插件（2026-11-01）：

```
muse_vtuber（本插件）──→ mira_device ──→ mira_media
   画 LIVE2D、右侧栏、    摄像头/麦克风/       TTS/ASR/VAD/凭据
   表情/动作/模型/权限    采集器/自动推帧       （唯一一份阿里云 key）
```

- 版本：**4.1.0**（4.0.0 拆分出三件套并删除账号权限；3.1.0 是拆分前的单体；更早的 2.0.1 是「外部 stella 节点」桥，见 §10）
- 位置：`PluginDSH/muse_vtuber`
- 依赖：**零第三方依赖**；`assets/lib/` 是 LIVE2D 运行库（见 `THIRD-PARTY-NOTICES`）
- 宿主依赖（`inject`）：`tools`、`webServer`、**`miraMedia`**、**`miraDevice`**

---

## 1. 界面结构（对照任务书功能点）

| 功能点 | 落地 |
|---|---|
| 1 新界面「形象」在「对话」「轨迹」之后 | 注册 `conversation.view`，`id:"muse-avatar"`、`order:20` |
| 2 形象主体 + 侧边栏 | 左侧 `.mv-main`（LIVE2D 舞台 + 气泡），右侧 `.mv-side` |
| 3 主位 LIVE2D；侧边栏自上而下 视频 / 音频 / 表情菜单 | `VideoPanel` → `AudioPanel` → `ExpressionPanel`（数据来自 `mira_device`） |
| 5 摄像头关 → 视频黑屏；开 → 显示捕获画面 | 面板读 `window.__miraDevice__` 的流/来源；采集器源走 `/device/api/stream.mjpg` |
| 6 麦克风关 → 音频直线；开 → 显示波形 | 波形用 `mira_device` 的 AnalyserNode；采集器源用宿主推的 RMS |
| 7 识别结果插话 / TTS 说话 | **插话在 `mira_device`**；**说话在 `mira_media`**（`device_say`），形象订阅 `say` 做气泡 + 口型 |
| 9 背景「频谱环」 | `SpectrumRing`：麦克风开着用麦克风频谱、说话时用播放器频谱、都不是就呼吸波形 |
| 8 设置界面 | 注册 `settings.section`（`@deepseek-ai/dsh-client-ui-settings`）→ **「形象」**：模型/目录/画布 |

**两条稳定性约定（踩过坑才写下的）**

- 舞台的 DOM 节点**恒定存在**（隐藏只切 `opacity`）。早期版本用「有/没有模型就换一个节点」的方式
  渲染，任何一次上层重渲染都可能把挂 canvas 的那个节点换掉 → 表现就是「形象忽然不见了」。
- 表情/动作**先校验再落状态**：模型里没有的名字不会写进 `state.json`，也不会喂给
  pixi-live2d-display（喂了会把表情管理器写坏，表现是「模型忽然不渲染」）。
- **布局**：`.mv-view` 的高度按「最近可滚动祖先」实测钉死，右侧栏自己滚 —— 早期版本靠
  `height:100%`，在宿主那个高度是 auto 的槽位里解析不出来，模型只显示下半身。

## 2. 落盘（约定1 / 约定3 / 约定7）

```
$DSH_HOME/mira_config/muse_vtuber/
  config.json             配置（schemaVersion 1）。唯一会自动创建的文件
  state.json              形象实况（可见性/模型/表情/开关/动作，schemaVersion 1）
  model/                  可选：自己的模型目录（留空 modelsDir 时优先用它）
```

**不再在这里**：`creds/dashscope.json`（→ `mira_config/mira_media/creds/`）、
`capture.json`（→ `mira_config/mira_device/capture.json`）。

热生效：`config.json` 内容变了，下一次读取就重新加载（约定9）；换代码仍需重启宿主（§11 的坑）。

## 3. 配置表

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不注册工具与路由 |
| `live2d.modelsDir` | `""` | 留空 = 依次找 `mira_config/muse_vtuber/model` → `mira_config/mira_live2d/model`。手填绝对路径优先 |
| `live2d.model` | `""` | 要显示的模型（目录名或 `*.model3.json`）。**留空 = 不显示模型**（只剩频谱环）；设置页选完保存会**立即切换** |
| `live2d.width` / `height` | `420` / `560` | 初始画布尺寸（CSS 像素），实际随容器缩放 |
| `legacyNode.enabled` | `false` | 旧的外部节点桥（见 §10），默认不加载 |
| `ui.showHint` | `true` | 首次进入给操作提示 |

> 旧版（≤3.1.0）的 `camera` / `mic` / `tts` / `asr` / `vision` / `capture` / `events` 键
> **不再被读取**，但会原样留在 `config.json` 里（前向兼容）；对应能力分别搬到了
> `mira_device` / `mira_media`（见 §9）。

## 4. 工具（5 个）

**没有权限模型**（4.1.0 起）：形象是纯展示面，任何会话都能调这 5 个工具，不再需要
`mira_account`、不再有 taker/observer/`force`。旧版那套「形象是一个账号」的绑定模型已整个删除
（真要防多会话打架，等需要时再加一个内存认领，不必把账号池拉进来）。

| 工具 | 干什么 |
|---|---|
| `vtuber_status` | 只读：形象状态（可见性/模型/表情/开关/动作）、模型清单与**缺失资源**、连着的页面数，并转述 `audio`（TTS/ASR/key）与 `input`（开关/采集器/识图）状态 |
| `vtuber_expression` | 表情三件套：`name`（互斥）/ `toggles`（整体替换叠加开关）/ `switch`+`on`。未知名字 → `expression/unknown` + 清单，**状态原样不动** |
| `vtuber_motion` | 播放动作组；不传 = 列清单 |
| `vtuber_visible` | 显示/隐藏形象主体（频谱环仍在） |
| `vtuber_model` | 切模型；不传 = 列清单；`clear:true` = 只留频谱环 |

## 5. 宿主 HTTP 面（`/vtuber/api/*`，全部同源校验）

| 方法与路径 | 作用 |
|---|---|
| `GET /vtuber/api/bootstrap` | 一次拿全：配置（脱敏）、状态、模型清单、`deps`（声音/输入是否就位）、endpoints |
| `GET /vtuber/api/capabilities?model=` | 表情/动作清单 + 缺失资源 |
| `GET /vtuber/api/events` | **SSE**：`hello` / `state`（模型/表情/动作/可见性） |
| `GET/POST /vtuber/api/state` | 形象状态 → `state.json` → 广播（`clientId` 记成 `by: client:<id>`） |
| `GET/POST /vtuber/api/settings` | 设置页读写（只有 `live2d.*`）；GET 回 `keyConfigured`（转述声音插件）与 `deps` |
| `GET /vtuber/api/health` | 存活探针（客户端数、依赖是否就位、`features.live2d`） |
| `GET /vtuber/assets/*`、`/vtuber/models/*` | 运行库与模型静态文件 |

**已经不在这里**（拆分后的入口）：

| 旧 | 新 |
|---|---|
| `POST /vtuber/api/say`、`GET /vtuber/api/audio/<id>` | `POST /media/api/say`、`GET /media/api/audio/<id>` |
| `POST /vtuber/api/asr`、`POST /vtuber/api/vision` | `POST /device/api/asr`、`POST /device/api/vision` |
| `POST /vtuber/api/capture/*`、`GET /vtuber/api/stream.mjpg` | `/device/api/capture/*`、`/device/api/stream.mjpg` |

## 6. 页面全局契约（形象读别的插件）

```js
window.__miraDevice__ = { state(), subscribe(fn), level(), analyser(), play(url), ready(), version }
window.__miraDevice__ = { state(), subscribe(fn), videoStream(), analyser(), level(),
                         setCamera(on), setMic(on), setSource(kind, source), heard(), seen(), captureUrl() }
```

- 形象**不自己播音频**：声音由 `mira_media` 的全局播放器播，这里只读 `state().level` 驱动口型
  （两边都播会变成双重声音）。
- 形象**不碰硬件**：视频/音频面板只消费 `mira_device` 的流、电平与日志。
- 两个全局对象都可能比本模块**晚出现**（模块加载顺序不定），所以都做了短轮询 + 订阅。

## 7. 模型与资源缺失

`models.js` 解析 `model3.json` 的 `FileReferences`，逐个检查 `Moc` / `Textures` / `Physics` /
`Pose` / `Expressions[].File` / `Motions[].File`，缺什么就说清是哪个文件、属于什么类型：

```
vtuber_status → models.missing: [{ file: "SylviaMuse.4096/texture_02.png", why: "贴图" }]
侧边栏表情菜单 → 缺资源：…（放进 <模型目录>/<模型名>/）
```

表情分两类（与 mira_live2d 同一套约定）：`开关-*` / `动作-*` 可**同时打开**（叠加层），
其余（`表情-*`）互斥。叠加是把"当前互斥表情 + 所有打开的开关"合成一个 `ExpressionMotion`，
经 `expressionManager` 的官方队列应用。

## 8. 迁移：3.1.0（单体）→ 4.0.0（三件套）→ 4.1.0（去掉账号）

| 旧位置 | 新位置 |
|---|---|
| `muse_vtuber/config.json` 的 `tts` / `asr` / `mic.vad` | `mira_media/config.json`（首次创建时自动迁移） |
| `muse_vtuber/creds/dashscope.json` | `mira_media/creds/dashscope.json`（首次加载时自动复制，600；旧文件保留） |
| `muse_vtuber/config.json` 的 `camera` / `mic` / `capture` / `vision` / `events` | `mira_device/config.json`（首次创建时自动迁移） |
| `muse_vtuber/capture.json` | `mira_device/capture.json`（`mira_device` 重新生成；`muse_galaxy` 已改读这里） |
| `muse_vtuber/state.json` 的 `cameraOn/micOn/cameraSource/micSource` | `mira_device/state.json`（不迁移，重新点一次开关即可） |
| 工具 `vtuber_say` | → `device_say`（工具名变了，提示词/预设里如果写了要改） |
| 工具 `vtuber_camera` / `vtuber_mic` / `vtuber_look` / `vtuber_listen` | → `device_camera` / `device_mic` / `device_look` / `device_listen` |
| 设置页「形象」里的 TTS/ASR/识图/设备 | → 「声音」/「输入」两个设置页；「形象」只剩 LIVE2D |

迁移是**只读旧文件**、不删不改；回滚就停用三个新插件、重新启用旧 `muse_vtuber` 3.1.0。

## 9. 已知取舍

1. **说话工具改了名字**：`vtuber_say` → `device_say`。用户口径是"各自的能力归各自的插件"：
   发声属于声音插件，形象只管口型。预设/技能里提到旧名字的要一起改。
2. **插话不再由形象负责**：`events.*` 配置、限流、模板都搬到了 `mira_device`；形象不再需要
   `sessionController`。
3. **自动识图默认关**（`mira_device` 的 `vision.autoIntervalMs: 0`）：定时抓帧会持续消耗额度。
4. **模型目录默认复用 mira_live2d 的那套**（存在才用）。
5. LIVE2D 运行库是**复制**进来的，不是跨插件 import（`link:` 安装下跨包相对 import 不可靠）。
6. 表情叠加用 `expressionManager._setExpression()`（下划线接口）：mira_live2d 已在生产用，
   上游改名就会失效 —— 表现是"开关点了没反应"，不会崩。

## 10. 旧的外部节点桥（2.0.1，默认关）

旧版是「DSH ↔ stella muse_vtuber 节点」的桥：MCP 拿工具、`/dsh` 出口拿事件，工具名 `muse_*`。
3.0.0 按任务书重写成纯 GUI 插件，桥不是任务书范围。代码原样留在 `lib/legacy/node-bridge.js`，
默认**不加载**；要恢复就把旧配置整体搬进 `config.legacyNode.config` 并把 `legacyNode.enabled`
设为 `true`（失败只 warn，不影响形象页签）。

## 11. 验收

```
node --check lib/client.js      # 浏览器模块只做语法自检
node test/smoke.mjs             # → ALL PASS（通过 34 项断言）
node test/http-e2e.mjs          # → ALL PASS（10 项端到端断言，真起 http + 真 SSE）
node ..\tool_shared\tools\check-zero-dep.mjs muse_vtuber
node ..\tool_shared\tools\check-kit.mjs
```

手工（三件套一起装好之后）：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 打开会议话界面 | 顶部页签：对话、轨迹、**形象** |
| 2 | 点「形象」 | 主位出现 LIVE2D（或频谱环）；右侧 视频 / 音频 / LIVE2D 表情 |
| 3 | 点输入框里的「摄像头」 | 侧边栏视频出现画面；再点一次黑屏（按钮属于 `mira_device`） |
| 4 | 点「麦克风」说一句话 | 波形动；停顿后「听到：…（已插话）」；会话里多一条 `[感知·语音]`（插话由 `mira_device` 投递） |
| 5 | 让模型说话（`device_say` / 「设置 · 声音」的试听） | 形象出声、口型跟音量动、气泡显示文字 |
| 6 | 设置 · 形象 → 选模型 → 保存 | 立即切换；空白 = 只显示频谱环 |
| 7 | 把 `config.json` 的 `schemaVersion` 改成 99 再重载 | 工具报 `config/schema`，不静默清空 |

### 两个「改代码不生效」的坑（都实测过）

1. **宿主半**：Loader 把模块缓存在「解析后的真实路径」上，`plugin_manager set_plugin` 关开只会
   重放缓存里的旧模块（实测：改代码后关开，`/vtuber/api/health` 仍是旧响应）。**换宿主代码必须
   重启 `dsh web`**。新插件（首次 import）不受影响，可以热加载。
2. **前端半**：`dsh-client-modules` 解析 `dsh.client` 时，从模块真实路径往上找 package.json，
   且要求 **`name` 严格等于 loader 条目的 specifier**。所以安装名必须与包名一致
   （`muse_vtuber`），别用别名装。

`lib/client.js` 末尾仍同时注册 `muse_vtuber` / `muse_vtuber_ui` 两个 id：只有宿主清单里那个会被
真正 import，另一个只是躺着的工厂（历史原因：曾用别名装过）。

## 12. 开发约定

- 只依赖 `node:` 内置与浏览器 API；`lib/kit.mjs` 是 `tool_shared/kit/kit.mjs` 的**逐字节副本**。
- 所有工具返回 `{ ok:true, … }` 或 `{ ok:false, error:{ code, message, hint } }`。
- 单实例保护：`apply` 里 `claimInstance('muse_vtuber')`，第二个实例报 `plugin/instance`。
- 退场顺序：摘工具 → 卸路由 → 停 SSE → 落状态 → 放认领（`ctx.effect` 与装配失败走同一条路径）。
- **依赖方向不允许反向**：形象可以读 `miraMedia` / `miraDevice`，它们不反过来依赖形象。
