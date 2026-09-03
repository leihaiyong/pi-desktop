# Pi Desktop 架构设计

> 配套文档:[API 参考](./api.md) · [安装与部署](./installation.md) · [快捷键](./keybindings.md)

## 1. 定位与技术栈

Pi Desktop 是 [pi coding agent](https://pi.dev) 的跨平台桌面客户端,目标是把
`pi` 交互式 TUI 的全部能力移植到 Electron 窗口中,而不是重新实现 agent 逻辑:

| 层 | 技术 | 说明 |
|---|---|---|
| Agent 运行时 | `@earendil-works/pi-coding-agent`(pi SDK) | npm registry 发布包(main 进程内运行);pi 开发者可改 `file:` 链接本地 monorepo |
| 桌面壳 | Electron 37 | 三进程模型 + contextBridge |
| UI | 原生 HTML/CSS/JS(ESM,无框架、无构建步骤) | 渲染器直接加载 `src/renderer/` |
| Markdown | marked 15(转义原始 HTML)+ highlight.js 10(esbuild 预打包 IIFE) | |
| 测试 | vitest(104 单测)+ 无头 SDK 冒烟测试 | |
| 打包 | electron-builder + 自研 asar 重打包脚本 | |

设计原则:

1. **Agent 能力全部来自 SDK**。会话、模型、工具、扩展、技能、主题、会话树
   都是 SDK 对象;桌面端只做"宿主 + 视图"。
2. **渲染器零 Node 权限**。`contextIsolation: true`、`nodeIntegration: false`、
   严格 CSP(`script-src 'self'`,无 `unsafe-inline`),renderer 与系统之间只隔着
   一个受控的 IPC 面。
3. **`src/shared/` 纯函数化**。解析/格式化逻辑不依赖 DOM 或 Electron,
   渲染器与单测共用同一份实现。

## 2. 进程模型

```
┌────────────────────────── Electron main ──────────────────────────┐
│ index.js        窗口 / 菜单 / CLI 参数 / 单实例锁                  │
│ host.js         AgentHost —— 持有 SDK 运行时,实现全部 IPC 频道     │
│ platform.js     按平台选择 shell(Windows: powershell,其余: bash) │
│                                                         ┌─────────┐ │
│  pi SDK(同进程)                                        │ renderer │ │
│  ModelRuntime ─► AgentSessionServices ─► AgentSession   │(网页)    │ │
│  (模型/认证)      (扩展/技能/提示词/主题)   (会话/工具)  └────┬─────┘ │
└──────────────────────────────────────────────────────────┼────────┘
                     preload/index.js(contextBridge)      │
                     window.pi.invoke / window.pi.on ◄────┘
```

- **main 进程**:`AgentHost` 是唯一的"大脑"。它创建并持有
  `ModelRuntime`、`AgentSessionServices`、`AgentSessionRuntime`,
  把 SDK 会话事件订阅后转发给 renderer,并把所有 UI 动作收敛到一个
  `pi:invoke` IPC 通道上的 `dispatch()` 方法。
- **preload**:只做两件事——把 `ipcRenderer.invoke` 包成
  `window.pi.invoke(channel, params)`(统一 `{ok, result|error}` 信封),
  以及 `window.pi.on(event, cb)` 订阅 main 的推送事件。
- **renderer**:纯 Web 应用。`main.js` 持有 UI 状态(最近一次快照、键位绑定),
  `editor.js`/`transcript.js`/`modals.js` 各自独立,`markdown.js` 负责
  Markdown 渲染。

### 2.1 安全模型

| 措施 | 位置 |
|---|---|
| `contextIsolation: true`,`nodeIntegration: false` | `index.js` |
| CSP:`default-src/script-src 'self'`,`connect-src/img-src` 限 self/data/blob/file | `index.html` |
| 单通道 IPC + 频道名白名单 `IPC_CHANNELS`(main 侧显式校验) | `host.js` |
| 文件系统操作校验:`sessions.delete` 只接受 `<agentDir>/sessions/**.jsonl` 且非当前会话文件;`system.readFileBase64` 限 10 MB;`system.openPath/revealPath` 要求路径存在 | `host.js` |
| 外链仅 `http(s)` 放行(`system.openExternal` + `setWindowOpenHandler`) | `host.js`/`index.js` |
| 模型输出 Markdown 中的原始 HTML 一律转义(marked renderer 钩子) | `markdown.js` |
| 其余动态内容统一走 `textContent` / `escapeHtml` | renderer 各模块 |

威胁模型:renderer 被视为"可信但可被模型输出污染"。即使 XSS 落地,
CSP 阻止脚本与外部回传,IPC 白名单 + 路径校验阻止任意文件读写/删除。

## 3. 模块结构

```
pi-desktop/
  src/
    main/
      index.js      应用入口:窗口、菜单、CLI(--cwd/--session/--smoke/--dev)
      host.js       AgentHost:SDK 生命周期 + 全部 IPC 频道 + 主题解析 + 登录桥
      platform.js   shell 配置(powershell/bash)
    preload/
      index.js      contextBridge → window.pi
      snip.js       区域截图选择层的 contextBridge → window.snip
    renderer/
      index.html    页面骨架 + CSP
      snip.html     区域截图选择层(每显示器一个透明全屏窗,拖拽矩形)
      css/main.css  CSS 变量主题系统(data-theme + 内联覆盖)
      js/main.js    状态、快照应用、斜杠命令分发、全局键位、搜索
      js/editor.js  多行输入:历史、自动补全(/ 命令 @文件)、!bash、图片粘贴/截图
      js/transcript.js  消息流渲染:流式、工具块、diff、增量更新
      js/modals.js  模态框框架 + 模型/会话/树/设置/主题/登录等对话框
      js/workspaces.js  工作区选择器(双栏:工作区 ↔ 会话;启动/标题栏⌂/菜单//workspaces)
      js/markdown.js    marked + hljs 配置、原始 HTML 转义、流式围栏平衡
      js/skill.js   skill 消息块解析
      js/snip.js    选择层交互:拖拽/框选、Enter 确认、Esc 取消,上报图像像素矩形
      vendor/highlight.js  esbuild IIFE 产物(`npm run vendor:hljs` 再生)
    shared/         纯函数,渲染器与单测共用
      slash.js      命令解析 / bash 检测 / 补全上下文
      keys.js       键位归一化、匹配、默认绑定表、combo 索引
      theme.js      pi 主题 JSON → CSS 变量
      diff.js       unified diff / edit patch → 结构化 hunk → HTML
      format.js     token/成本/时长/时间戳/字节/上下文占用格式化
      tree.js       会话树展平与分支统计
      workspaces.js 工作区分组(会话按 cwd 聚合为工作区列表)
      snip.js       截图几何:css→图像像素缩放、裁剪矩形夹取(单测覆盖)
  test/             vitest 单测 + smoke-host.mjs(无头 SDK 冒烟)
  scripts/
    repack-asar.mjs asar 重打包(依赖闭包 + Windows 路径修复)
    make-icons.mjs  图标生成
    cdp-eval.mjs / cdp-shot.mjs  CDP 调试辅助
  electron-builder.yml
  package.json
```

## 4. 核心流程

### 4.1 启动

```
app.whenReady
  └─ AgentHost.start({cwd, sessionPath, explicitCwd})
       ├─ registerIpc()                 # 注册 pi:invoke(白名单 + ready 门控)
       ├─ ModelRuntime.create()         # 模型目录 + 认证状态
       ├─ createAgentSessionServices()  # 扩展/技能/提示词/主题/设置
       ├─ createAgentSessionRuntime()   # 会话运行时(工厂支持换目录/换会话)
       ├─ bindCurrentSession()          # 订阅事件 → agent:event;绑定扩展 uiContext
       ├─ send("host:ready", snapshot)  # 一次性推送
       └─ readyResolve()                # 放行早期 IPC
renderer
  └─ init() → window.pi.invoke("host.snapshot")   # 拉取式快照
           └─ 若 !snapshot.explicitCwd && !snapshot.smoke
              → 打开工作区选择器(见 4.9)
```

`host:ready` 是**一次性推送**,渲染器从 asar 加载较慢时会错过它;
因此 `host.snapshot` 提供**拉取式**补偿(频道在 main 侧门控于 ready,
renderer 任何时候调用都安全)。这是打包版曾出现"窗口空白"问题的根因修复。

### 4.2 数据流:快照 + 事件

两种互补的同步机制:

1. **推送事件**(`agent:event`):SDK 会话事件实时转发——
   `message_start/update/end`、`tool_execution_start/update/end`、
   `bash_execution_update`、`queue_update`、`entry_appended`、
   `compaction_*`、`auto_retry_*` 等。渲染器据此做**流式增量渲染**。
2. **快照**(`host.snapshot` / `host:ready` / `host:session-replaced`):
   会话的完整一致状态(消息列表、模型、设置、统计、队列、资源)。
   在 `agent_settled`(每轮结束)、会话切换、扩展 reload 后拉取,
   作为"对账"基准。

渲染器侧的**防陈旧快照**:`agent_settled` 拉快照前记录当前消息数,
若响应消息数反而变少(请求在新 prompt 入列前发出),150 ms 间隔重试
(最多 5 次),避免用旧快照覆盖新消息。

### 4.3 流式渲染与增量更新

`transcript.js` 维护 `#messages` 与等长的**指纹数组**
(role + toolCallId/text 前缀/stopReason 的内容指纹):

- `setMessages(snapshot)`:若新列表是已渲染列表的**前缀扩展**(常见情形:
  一轮结束),只追加尾部新增消息的 DOM 节点,不整屏重渲;否则全量 rebuild。
- `addMessage`(非流式 `message_end`):按指纹对**尾部 3 条**去重后追加单节点。
  去重必须是内容指纹而非对象相等——事件载荷与快照消息是两次结构化克隆,
  对象恒不相等;只查尾部是为了不误吞用户重复发送的相同文本。
- 流式中的 assistant 消息走独立的 live 块(`[data-live]`),
  text/thinking delta 原地更新,toolcall 变化时重建 live 块;
  `commitAssistant` 时清 live 块并入 `#messages`,随后 rebuild 对账。

### 4.4 命令系统

```
编辑器 onSubmit(text)
  ├─ parseSlashCommand(text) 命中
  │    └─ runCommand():内置 26 条(/help /new /model /tree /scoped-models ...)
  │         └─ 各命令 = 一次或多次 window.pi.invoke(...) + 模态框
  │    └─ 未识别命令 → 作为普通 prompt 发送(扩展命令 / 提示词模板)
  ├─ isBashCommand(text)  → session.bash.run
  └─ 普通文本            → session.prompt(流式中自动转 steering 排队)
```

`BUILTIN_COMMANDS` 与 TUI 的 26 条斜杠命令一一对应(含两个彩蛋与
`/quit`)+ 桌面端补充 `/theme`、`/debug`,共 28 条。命令的 UI 侧实现全部在
`main.js runCommand()` 中,主进程只提供原子操作频道。

### 4.5 扩展桥(uiContext)

pi 扩展通过 SDK 的 `uiContext` 与 UI 交互。`AgentHost.#makeUiContext()`
把 TUI 组件契约映射为 IPC:

| 扩展 API | 桌面实现 |
|---|---|
| `ui.select/confirm/input/editor` | `ext.ui.request` → renderer 模态框 → `ext.ui.respond` 回包 |
| `ui.setWidget` | `ext.widget` 推送到编辑器上/下方容器 |
| `ui.setStatus` / `setWorking*` | `ext.status` / `ext.working` 状态行 |
| `ui.setEditorText` / `pasteToEditor` | `ext.editor.setText` / `ext.editor.paste` |
| `ui.getEditorText` | main 缓存(renderer 每次输入 `ext.editor.cache` 上报) |
| `ui.setTitle` | 窗口标题 |
| `ui.custom` / `setEditorComponent` | 不支持(抛错,桌面无法渲染 TUI 焦点组件) |

扩展命令执行、`newSession/fork/navigateTree/sendToSession` 等
`commandContextActions` 由 main 直接调用 SDK 实现,不经过 renderer。

### 4.6 登录流程

`models.login` 在 main 侧构造 SDK 的 `interaction` 对象:

```
models.login ─► SDK login(provider, method, interaction)
                 ├─ interaction.prompt(选择/输入) ─► auth.prompt 推给 renderer
                 │     └─ 用户提交 ─► auth.respond ─► 解除 Promise
                 └─ interaction.notify(auth_url/device_code/…) ─► auth.notify
                    └─ auth_url 自动 shell.openExternal
```

### 4.7 主题系统

- pi 主题是 JSON 调色板(见 SDK `theme-schema.json`)。`theme.js`
  纯函数 `resolveThemeToCssVars()` 把调色板解析为 CSS 自定义属性
  (含亮度计算自动派生前景色、透明度变体)。
- 内置主题位于 SDK 包 `dist/modes/interactive/theme/*.json`;
  自定义主题在 `~/.pi/agent/themes/*.json`,由 resource loader 发现。
- 渲染:`light/dark` 直接切 `documentElement.dataset.theme`;
  自定义主题以 dark 为基底,把解析出的变量逐个 `setProperty`
  到 `:root`(切换前清空内联变量,防止旧主题残留)。
- `/theme a/b` 语法支持"浅色名/深色名"按系统配色自动选择。

### 4.9 工作区

**工作区 = 目录**(agent 的 cwd)。没有独立的工作区注册表:历史工作区由磁盘上的
会话文件按 `cwd` 分组派生(`SessionManager.listAll()` → `groupWorkspaces()`,
`src/shared/workspaces.js`),最近使用优先、当前工作区置顶。

- **打开**:`system.reconfigure({cwd})` 重建运行时(与 `--cwd` 启动同一路径)。
- **加载历史会话**:同一工作区走 `session.resume`;跨工作区走
  `system.reconfigure({cwd, sessionPath})`(会话头部的 cwd 与当前不同时)。
- **新建**:`system.pickDirectory` 选目录 → `system.reconfigure({cwd})`。
- **删除**:`workspaces.delete({cwd})` 删除 `<agentDir>/sessions/--<编码目录>--/` 下的
  `.jsonl`(编码复刻 SDK `getDefaultSessionDirPath`);**当前工作区拒绝删除**;
  渲染端用两步确认(“再次点击确认”,5 秒失效)而非模态确认框,避免嵌套模态互相销毁。
- **入口**:启动(无 `--cwd`/`--session` 时)、标题栏 ⌂、File 菜单 Workspaces…、`/workspaces`。

### 4.10 区域截图(snip)

`system.screenshot.start`(相机按钮/Ctrl+Shift+S):

```
hide 主窗口(150 ms 等待合成器) 
  → desktopCapturer 截全部显示器(请求最大物理尺寸;源序与 getAllDisplays 一致)
  → 每显示器一个透明无边框全屏 BrowserWindow(snip.html + preload/snip.js)
  → 用户在叠加层拖拽矩形(框外 55% 变暗,标签显示图像像素尺寸)
  → Enter:snip.select(图像像素矩形) / Esc 或单击:snip:cancel
main 侧:校验 event.sender 属于活动叠加层 → clampCrop 夹取到图像边界
  → nativeImage.crop → 销毁叠加层、恢复主窗口
  → webContents.send("screenshot:preview", {data, mime, width, height})
渲染端:预览模态(附加/重截/取消;Enter 附加)→ editor.attachImage 入附件托盘
```

- **Windows 窗口钳制**:默认窗口尺寸被钳到主屏 workArea(SM_*MAXTRACK);
  需先 `setMaximumSize(最大屏+64)` 再 show,show 后重发 `setBounds` 才能铺满
  任意显示器(含主屏任务栏区域)。叠加层用**实际** `window.innerWidth/Height`
  做 css→图像像素换算,±1 px 的 DPI 舍入误差自校正。
- 同一时刻只允许一个 snip 会话(状态机 `#snipState` + 120 s 看门狗);
  裁剪矩形经 `src/shared/snip.js` 的 `scaleRect/clampCrop` 校验(单测覆盖),
  并验证 CDP E2E 中“裁剪图与全截图像素一致”(fnv 哈希比对)。

### 4.8 键位系统

- `keys.js` 提供 pi `keybindings.json` 兼容的组合键模型:
  归一化(`super/cmd/meta` → `meta`,`esc` → `escape`,修饰键排序)、
  事件匹配、展示标签。
- 默认绑定 `defaultBindings(platform)` 镜像 TUI,带平台差异
  (如 Windows `Ctrl+Q` 排队 follow-up / macOS `Alt+Enter`;
  图片粘贴全平台 `Alt+V` 以免占用原生 `Ctrl+V` 文本粘贴)。
- `buildComboIndex()` 生成 combo→action 索引,供 window 级 keydown 分发;
  编辑器本地键(Enter/Shift+Enter/Tab/上下方向)在编辑器聚焦时
  **不拦截**,保证原生换行与焦点行为。

## 5. 打包架构

```
electron-builder.yml
  win: nsis + portable    mac: dmg + zip    linux: AppImage + deb + rpm
  files: src/**, package.json, node_modules/**(排除 test/docs/md)
```

- **asar 布局**:`app.asar` 内同时含 `src/`(应用源码)、`package.json`、
  `node_modules/`(运行时依赖闭包)。
- **依赖闭包**:从 pi-desktop 的 runtime dependencies 出发 BFS 计算
  `dependencies` 图(约 140 个包)。registry 安装为单棵 node_modules 树;
  若 pi 包以 `file:` 链接本地 monorepo,其自身依赖留在 `pi/node_modules`
  (npm 不提升 `file:` 链接包的依赖),repack 脚本会合并两棵树计算闭包,
  并用 `createPackageFromStreams` 逐文件打包。
- **Windows 路径问题**:`@electron/asar` 的 `path.normalize` 在 Windows
  上把 asar 头内路径变成反斜杠,Electron 加载器只认正斜杠;
  repack 脚本在打包后对 asar 头 JSON 做原地重写(`normalizeAsarPaths`)。
- **winCodeSign 限制**(Windows 非管理员、未开开发者模式):electron-builder 最后一步需要
  符号链接权限。解法:`npm run package:dir` 产出 `release/win-unpacked`
  后执行 `npm run repack:asar` 重建 asar,得到完整可运行目录。
- **highlight.js**:npm 包只带 CJS lib,浏览器不可用;
  `npm run vendor:hljs` 用 esbuild 生成 IIFE 到
  `src/renderer/vendor/highlight.js`,随 `src/**` 进入 asar。

## 6. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 纯函数 | vitest(104 用例) | slash 解析、键位、diff、主题、树、工作区分组、格式化、Markdown 转义、IPC 白名单与 dispatch 一致性(源码级) |
| SDK 接线 | `node test/smoke-host.mjs` | 无头运行真实 SDK:模型运行时、会话、工具切换、bash、fork、命名、队列、设置 |
| 端到端 | CDP 脚本(`scripts/cdp-eval.mjs`)+ `--smoke` 模式 | 启动→快照→prompt→工具调用→渲染,dev 与打包版各验证一遍 |
| 打包 | electron-builder / repack:asar | 三平台产物;本机以 win-unpacked 为准 |

## 7. 已知限制与取舍

| 项 | 现状 | 说明 |
|---|---|---|
| 快照载荷 | `agent_settled` 每次传输全量消息列表 | 渲染端已增量化;协议端改 diff 需要 host/renderer 契约变更 |
| 用户键位覆盖 | 支持 `buildComboIndex(overrides)` 但未从 `keybindings.json` 加载 | 目前 `/hotkeys` 展示默认绑定 |
| 扩展自定义组件 | 不支持 | `ui.custom` 抛错;TUI 焦点组件无 Web 对应物 |
| `/share` | 导出 HTML 并在文件管理器显示 | TUI 原为 GitHub gist;桌面端不内置 gist 凭据 |
| scoped-models 弹窗 | toggle 重开会重置滚动/搜索位置 | 可接受的小瑕疵 |
| 自动更新 | 无(`publish: null`) | 手动分发安装包 |
