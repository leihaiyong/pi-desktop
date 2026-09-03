# Pi Desktop API 参考

> 配套文档:[架构设计](./architecture.md) · [安装与部署](./installation.md) · [快捷键](./keybindings.md)

本文档覆盖四个 API 面:

1. [window.pi — preload 桥](#1-windowpi--preload-桥)
2. [IPC 频道(renderer → main)](#2-ipc-频道renderer--main)
3. [推送事件(main → renderer)](#3-推送事件main--renderer)
4. [共享模块 API(src/shared)](#4-共享模块-apisrcshared)
5. [AgentHost 与 CLI](#5-agenthost-与-cli)

---

## 1. window.pi — preload 桥

renderer 唯一可见的 main 进程接口,由 `src/preload/index.js` 通过
`contextBridge` 暴露。

```js
window.pi.platform        // "win32" | "darwin" | "linux"
window.pi.versions        // { electron, chrome }

// 核心两件套
window.pi.invoke(channel, params)   // Promise<result>  —— 失败时 reject(Error)
window.pi.on(event, callback)       // 订阅 main 推送;返回取消订阅函数

// 常用便捷封装(等价于对应 invoke)
window.pi.prompt(text, options?)    // session.prompt
window.pi.steer(text)               // session.steer
window.pi.followUp(text)            // session.followUp
window.pi.abort()                   // session.abort
window.pi.compact(instructions?)    // session.compact
window.pi.abortCompaction()         // session.compact.abort
window.pi.setModel(provider, id)    // session.model.set
window.pi.cycleModel(backward?)     // session.model.cycle
window.pi.setThinking(level)        // session.thinking.set
window.pi.cycleThinking()           // session.thinking.cycle
window.pi.runBash(command, excluded?) // session.bash.run (!! = excluded from LLM context)
window.pi.abortBash()               // session.bash.abort
window.pi.listDisplays()            // system.displays
window.pi.captureScreenshot(index?) // system.screenshot
window.pi.startScreenshot()         // system.screenshot.start(区域截图,预览经 screenshot:preview 推送)
window.pi.notifyUiResponse(id, value, cancelled)  // ext.ui.respond
window.pi.respondAuth(id, value, cancelled)       // auth.respond
```

约定:

- 所有 `invoke` 走同一底层通道 `pi:invoke`,main 侧返回
  `{ok:true, result}` 或 `{ok:false, error}`;preload 把后者转为 reject。
- main 侧对频道名做白名单校验(`IPC_CHANNELS`),未知频道返回
  `Unknown channel: …` 错误。
- 所有调用门控于会话 ready:启动期的早期调用会排队等待,不会竞态。

---

## 2. IPC 频道(renderer → main)

调用方式:`window.pi.invoke(channel, params)`。下表 `params` 中 `?` 表示可选。

### 2.1 宿主状态

| 频道 | 参数 | 返回 |
|---|---|---|
| `host.snapshot` | — | 完整 [Snapshot](#快照对象)(拉取式,任意时刻可调) |

### 2.2 提示与交互

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.prompt` | `{ text, images?, streamingBehavior? }` | `{ok}`。`streamingBehavior: "steer"` 在流式中转为排队 |
| `session.steer` | `{ text, images? }` | `{ok}` |
| `session.followUp` | `{ text, images? }` | `{ok}` |
| `session.abort` | — | `{ok}`(中断当前轮) |
| `session.waitForIdle` | — | `{ok}` |
| `session.queue.clear` | — | `{ steering, followUp }`(被清空的内容) |
| `session.steeringMode` | `{ mode: "all" \| "one-at-a-time" }` | `{ok}` |
| `session.followUpMode` | `{ mode }` | `{ok}` |

`images` 格式(SDK `ImageContent`):`[{ type:"image", data, mimeType }]`,`data` 为 base64。

### 2.3 压缩与重试

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.compact` | `{ instructions? }` | SDK compact 结果 |
| `session.compact.abort` | — | `{ok}` |
| `session.compaction.setAuto` | `{ enabled }` | `{ok}` |
| `session.retry.setAuto` | `{ enabled }` | `{ok}` |
| `session.retry.abort` | — | `{ok}` |

### 2.4 模型与思考级别

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.model.set` | `{ provider, id }` | `{ok, model}`;未知模型抛错 |
| `session.model.cycle` | `{ backward? }` | SDK 结果(含新模型) |
| `session.thinking.set` | `{ level }` | `{ok, level}` |
| `session.thinking.cycle` | — | `{ok, level}` |
| `session.scope.set` | `{ patterns: string[] }` | `{ok, diagnostics, models}`。pattern 支持 `provider/id`、`provider/id:thinking`、glob(`anthropic/*sonnet*`) |

### 2.5 工具

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.tools.set` | `{ names: string[] }` | `{ok, active}` |
| `session.tools.list` | — | `[{ name, description }]` |

### 2.6 用户 bash(`!cmd`)

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.bash.run` | `{ command, excludeFromContext? }` | SDK executeBash 结果 |
| `session.bash.abort` | — | `{ok}` |
| `session.bash.record` | `{ command, result, excludeFromContext? }` | `{ok}` |

### 2.7 会话生命周期与分支

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.new` | — | SDK newSession 结果(随后推送 `host:session-replaced`) |
| `session.resume` | `{ path, cwdOverride? }` | SDK switchSession 结果 |
| `session.fork` | `{ entryId, position? }` | SDK fork 结果;`position: "before" \| "at"` |
| `session.forkMessages` | — | 可 fork 的用户消息列表 |
| `session.import` | `{ path, cwdOverride? }` | 从 JSONL 导入 |
| `session.navigateTree` | `{ targetId, summarize?, customInstructions?, replaceInstructions?, label? }` | SDK navigateTree 结果 |
| `session.name.set` | `{ name }` | `{ok, name}` |
| `session.reload` | — | `{ok}`(重载扩展/技能/提示词/主题) |
| `session.messages` | — | 消息数组 |
| `session.stats` | — | 会话统计 |
| `session.contextUsage` | — | 上下文占用 |
| `session.lastAssistantText` | — | 最近一条 assistant 文本 |
| `session.systemPrompt` | — | 系统提示词全文 |

### 2.8 导出/导入

| 频道 | 参数 | 返回 |
|---|---|---|
| `session.exportHtml` | `{ path?, themeName? }` | 写出的文件路径 |
| `session.exportJsonl` | `{ path? }` | 写出的文件路径 |

### 2.9 会话文件

| 频道 | 参数 | 返回 |
|---|---|---|
| `sessions.list` | `{ all?, cwd? }` | `[{ path, cwd, name, created, updated, title, messageCount, isCurrent }]`;`all: true` 列出所有项目的会话(无参 `listAll()`);`cwd` 列出指定工作区的会话(工作区选择器用) |
| `sessions.delete` | `{ path }` | `{ok}`。**仅接受** `<agentDir>/sessions/**.jsonl` 且非当前会话文件,否则抛错 |
| `sessions.tree` | — | `{ entries, leafId, path, labels }` |
| `sessions.setLabel` | `{ entryId, label? }` | `{ok}`(空 label 清除) |

### 2.9b 工作区

工作区 = 目录(即 agent 的 cwd)。历史工作区由磁盘上的会话按 `cwd` 分组派生,不单独持久化。

| 频道 | 参数 | 返回 |
|---|---|---|
| `workspaces.list` | — | `[{ cwd, name, sessionCount, lastModified, isCurrent }]`,最近使用优先,当前工作区置顶 |
| `workspaces.delete` | `{ cwd }` | `{ ok, deleted }`;删除该工作区的 `.jsonl` 会话文件(及空目录)。**拒绝删除当前工作区**;目标目录必须在 `<agentDir>/sessions/` 下(防误删) |

### 2.10 模型目录与认证

| 频道 | 参数 | 返回 |
|---|---|---|
| `models.list` | — | `[{ provider, id, name, contextWindow, cost, reasoning, available }]` |
| `models.refresh` | — | SDK refresh 结果(强制联网刷新) |
| `models.authStatus` | — | `{ providers:[{id,name,status}], credentials:[{providerId,type,source?}] }` |
| `models.login` | `{ providerId, method? }` | `{ok, credential}`;交互经 `auth.prompt` 完成 |
| `models.logout` | `{ providerId }` | `{ok}` |
| `models.apiKey.set` | `{ providerId, key }` | `{ok}`(运行时密钥,不落盘) |
| `models.apiKey.remove` | `{ providerId }` | `{ok}` |

### 2.11 主题与资源

| 频道 | 参数 | 返回 |
|---|---|---|
| `theme.list` | — | `[{ name, path, builtin }]`(内置 + `~/.pi/agent/themes`) |
| `theme.css` | `{ name }` | `{ name, builtin, vars: {--css-var: value} }` |
| `resources.changelog` | — | CHANGELOG 文本(可能为 undefined) |
| `resources.get` | — | `{ prompts, skills, extensions, extensionErrors, contextFiles }` |

### 2.12 设置

| 频道 | 参数 | 返回 |
|---|---|---|
| `settings.get` | — | 设置快照(见下) |
| `settings.set` | `{ key, value }` | `{ok}`;不支持的 key 抛错 |

`settings.set` 支持的 key:

| key | 值类型 |
|---|---|
| `theme` | string(内置/自定义主题名) |
| `defaultThinkingLevel` | `"" \| off \| minimal \| low \| medium \| high \| xhigh \| max` |
| `steeringMode` / `followUpMode` | `"all" \| "one-at-a-time"` |
| `compaction` / `retry` | `{ enabled }` |
| `hideThinkingBlock` / `showCacheMissNotices` / `quietStartup` / `collapseChangelog` / `showImages` / `blockImages` / `imageAutoResize` / `enableSkillCommands` | boolean |
| `doubleEscapeAction` | `"fork" \| "tree" \| "none"` |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` |
| `enabledModels` | string[](scoped-models patterns) |
| `externalEditorCommand` | string |
| `httpIdleTimeoutMs` | number |

只读(仅 `settings.get` 返回,不可 set):`shellPath`、`shellCommandPrefix` 等。

### 2.13 项目信任

| 频道 | 参数 | 返回 |
|---|---|---|
| `trust.get` | — | `{ trusted }` |
| `trust.set` | `{ trusted }` | `{ok, trusted}` |

### 2.14 系统

| 频道 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `system.platform` | — | `{ platform, shell, gitBranch, nativeTheme }` | |
| `system.pickDirectory` | — | 目录路径 \| undefined(取消) | 原生对话框 |
| `system.pickFile` | `{ filters? }` | 文件路径 \| undefined | 原生对话框 |
| `system.readFileBase64` | `{ path }` | `{ mime, data }` | **≤10 MB**;仅支持的图片类型 |
| `system.fs.list` | `{ prefix }` | string[](相对路径,前缀匹配,≤100 条) | `@` 补全用;跳过 dot 目录/node_modules/.git,深度 ≤3 |
| `system.clipboard.write` | `{ text }` | `{ok}` | |
| `system.clipboard.readImage` | — | `{ mime, data }` \| undefined | 剪贴板无图时 undefined |
| `system.displays` | — | `{ index, name, width, height, isPrimary }[]` | 屏幕列表 |
| `system.screenshot` | `{ index? }` | `{ data, mime, width, height, name }` | 按显示器物理分辨率整屏截图(`desktopCapturer`);`index` 缺省 0 |
| `system.screenshot.start` | — | `{ok, displays}` \| `{error}` | 区域截图:隐藏主窗口 → 截屏 → 每屏开透明全屏选择窗(用户拖拽矩形)→ 裁剪后推 `screenshot:preview`;同一次未结束时再次调用返回 `{error}` |
| `system.openExternal` | `{ url }` | `{ok}` | **仅 `http(s)://`** |
| `system.openPath` | `{ path }` | `{ok}` | 路径必须存在 |
| `system.revealPath` | `{ path }` | `{ok}` | 在文件管理器中显示(路径必须存在) |
| `system.reconfigure` | `{ cwd, sessionPath? }` | `{ok}` \| `{error}` | 切换工作目录,重建运行时 |
| `system.appInfo` | — | `{ version, node }` | |

### 2.15 扩展与认证回包

| 频道 | 参数 | 说明 |
|---|---|---|
| `ext.ui.respond` | `{ id, value, cancelled }` | 回复 `ext.ui.request` |
| `ext.editor.cache` | `{ text }` | 上报编辑器文本(供扩展同步 `getEditorText`) |
| `auth.respond` | `{ id, value, cancelled }` | 回复 `auth.prompt` |

---

## 3. 推送事件(main → renderer)

订阅方式:`window.pi.on(event, cb)`。

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `host:ready` | Snapshot | 初始会话绑定完成(一次性;错过后应调 `host.snapshot`) |
| `host:session-replaced` | Snapshot | 会话切换/新建/fork/import/reload 后 |
| `host:notify` | `{ message, type }` | 通知(toast);`type: info\|warning\|error\|success` |
| `host:auth-changed` | `{ok}` | 认证状态变化后 |
| `agent:event` | SDK 会话事件 | 见下表 |
| `ext.ui.request` | `{ id, kind, … }` | 扩展请求 UI;`kind: select\|confirm\|input\|editor`,须回 `ext.ui.respond` |
| `ext.widget` | `{ key, lines, options }` | 扩展小部件;`lines: null` 表示移除 |
| `ext.status` | `{ key, text }` | 扩展状态行;`text: null` 清除 |
| `ext.working` | `{ message? , visible?, indicator? }` | 扩展工作指示 |
| `ext.editor.setText` | `{ text }` | 扩展设置编辑器文本(处理后须 `ext.editor.cache` 回传) |
| `ext.editor.paste` | `{ text }` | 扩展向编辑器追加文本 |
| `screenshot:preview` | `{ data, mime, width, height }` | 区域截图完成:渲染端弹预览框(附加/重截/取消) |
| `auth.prompt` | `{ id, prompt }` | 登录交互;`prompt.type: select\|text\|secret`,须回 `auth.respond` |
| `auth.notify` | `{ event }` | 登录进度;`event.type: auth_url\|device_code\|info\|progress` |
| `menu:*` | — | 菜单项: `open-folder open-session new-session resume fork tree abort compact model thinking theme settings export-html export-jsonl save-jsonl hotkeys help` |

### agent:event 载荷(SDK 会话事件)

| type | 关键字段 |
|---|---|
| `agent_start` / `agent_end` | — |
| `agent_settled` | —(一轮彻底结束,应拉快照对账) |
| `message_start` / `message_update` / `message_end` | `message`(+`assistantMessageEvent`:`text_delta\|thinking_delta\|toolcall_*`) |
| `tool_execution_start` / `update` / `end` | `toolCallId, toolName, args, result?` |
| `bash_execution_update` | `delta` |
| `queue_update` | `steering, followUp` |
| `entry_appended` | `entry`(`compaction` / `branch_summary` / …) |
| `session_info_changed` | `name` |
| `thinking_level_changed` | `level` |
| `compaction_start` / `compaction_end` | `aborted?, errorMessage?` |
| `auto_retry_start` / `auto_retry_end` | `attempt, errorMessage / success, finalError?` |

### 快照对象

`host.snapshot` / `host:ready` / `host:session-replaced` 的载荷:

| 字段 | 类型 | 说明 |
|---|---|---|
| `cwd` / `agentDir` | string | 工作目录 / agent 目录 |
| `platform` / `shell` | string | 平台 / shell 名称 |
| `explicitCwd` | boolean | true 表示启动时通过 `--cwd`/`--session` 指定了工作区;渲染器据此跳过启动工作区选择器 |
| `smoke` | boolean | `--smoke` 启动标志(同样跳过选择器) |
| `sessionId` / `sessionFile` / `sessionName` | string? | 会话标识 |
| `model` | `{ provider, id, name }` \| null | 当前模型 |
| `thinkingLevel` / `thinkingLevels` | string / string[] | 当前/可用思考级别 |
| `isStreaming` / `isCompacting` / `isBashRunning` / `isRetrying` | boolean | 状态位 |
| `retryAttempt` | number | 重试次数 |
| `systemPrompt` | string | 系统提示词 |
| `messages` | array | 会话消息(含 toolResult 条目) |
| `activeTools` / `tools` | string[] / `[{name,description,isCustom}]` | 工具 |
| `scopedModels` | `[{ provider, id, thinkingLevel? }]` | 当前 scope |
| `stats` / `contextUsage` | object | 统计 / 上下文占用 |
| `queue` | `{ steering, followUp }` | 排队消息 |
| `autoCompaction` / `autoRetry` | boolean | 自动开关 |
| `gitBranch` | string? | 当前 git 分支(60s 缓存) |
| `models` | array | 全量模型目录(见 `models.list`) |
| `providers` | `[{ id, name, auth: string[] }]` | 提供商与可用认证方式 |
| `settings` | object | 设置快照 |
| `themes` | string[] | 可用主题名 |
| `resources` | `{ prompts, skills, extensions, extensionErrors, contextFiles }` | 加载资源 |
| `diagnostics` | `[{ type, message }]` | 诊断 |
| `modelFallbackMessage` | string? | 模型回退提示 |

---

## 4. 共享模块 API(src/shared)

纯函数模块,无 DOM/Electron 依赖,渲染器与单测共用。

### slash.js

```js
BUILTIN_COMMANDS              // [{ name, description }] × 29(26 条 TUI + /theme /debug /workspaces)
parseSlashCommand(line)       // { name, args, raw } | null(任意空白分隔)
isSlashCommand(line)          // boolean
isBashCommand(line)           // "!" 开头且非空
extractBashCommand(line)      // 去 "!" 前缀
completionContext(text, caret) // { kind:"slash"|"file", token, tokenStart, lineStartOffset } | null
```

### keys.js

```js
normalizeKeyCombo(combo)       // "ctrl+shift+x" → { mods:[…排序], key }(super/cmd/meta→meta)
eventToCombo(event)            // KeyboardEvent → { mods, key }
comboMatches(combo, event)     // boolean
comboLabel(combo, platform)    // 展示标签("Ctrl+Shift+F" / "⌘+…")
defaultBindings(platform)      // 默认绑定表(见 docs/keybindings.md)
buildComboIndex(bindings, overrides?)  // Map<comboKey, action>
```

### theme.js

```js
parseHex(hex)                  // "#rrggbb" → {r,g,b}
toHex(r, g, b)                 // → "#rrggbb"
blend(a, b, t)                 // 两色混合
withAlpha(hex, alpha)          // 带透明度
luminance(hex)                 // 相对亮度
resolveThemeToCssVars(theme)   // pi 主题 JSON → { "--fg": "#…", … } CSS 变量表
```

### diff.js

```js
parseUnifiedDiff(text)         // unified diff → 结构化 hunk 列表
parseEditDiff(patch)           // edit 工具 patch → 同构 hunk
renderDiffToHtml(diff)         // hunk → 安全 HTML(逐行转义)
diffStats(diff)                // 增删行统计
escapeHtml(text)
```

### format.js

```js
formatTokens(n)                // 12345 → "12.3k"
formatCost(n)                  // 0.0123 → "$0.0123"
formatDuration(ms)
formatTimestamp(ts)
formatBytes(n)
formatContextUsage(usage)      // "2.7k/200k ctx (1%)" | null
```

### workspaces.js

```js
workspaceName(cwd)                    // 目录名(最后一段路径)
groupWorkspaces(sessions, {
  currentCwd = "",
  limit = 50,
})                                     // 按 cwd 分组 → [{ cwd, name, sessionCount, lastModified, isCurrent }]
                                       // 最近使用优先;当前工作区置顶(即使无会话);忽略无 cwd 的旧会话
```

### tree.js

```js
flattenTree(entries, leafId)   // 会话树 → 展平行 [{ id, depth, role, text, isLeaf, label, timestamp, … }]
countBranches(entries)         // 分支统计
```

---

## 5. AgentHost 与 CLI

### 5.1 AgentHost(`src/main/host.js`,main 进程内部 API)

```js
const host = new AgentHost(getWindow);

host.start({ cwd, sessionPath? })  // 注册 IPC → 建运行时 → 绑定会话 → 推 host:ready
host.shutdown()                    // 幂等;释放运行时、清理 pending 请求、移除 IPC
host.reconfigure({ cwd, sessionPath? })  // 切换工作目录/会话,重建运行时

host.ready          // Promise,初始会话绑定完成后 resolve(IPC 门控)
host.session        // 当前 AgentSession(SDK 对象)
host.runtime        // 当前 AgentSessionRuntime
host.send(channel, payload)       // 向 renderer 推送
host.snapshot()                   // 构建快照对象
host.registerIpc()                // 注册 pi:invoke(白名单 + ready 门控)
host.dispatch(channel, params)    // 频道分发(内部)
```

### 5.2 CLI 参数

| 参数 | 说明 |
|---|---|
| `--cwd <dir>` | 工作目录(默认用户主目录) |
| `--session <file>` | 启动时恢复指定会话 JSONL |
| `--dev` | 开发模式(renderer console 全部转发到 main) |
| `--smoke` | 仅开发版:启动后自动截图并退出;`SMOKE_PROMPT="…"` 驱动真实 prompt(空行分段) |
| `--remote-debugging-port <n>` | Electron CDP 调试端口 |

### 5.3 环境变量

| 变量 | 说明 |
|---|---|
| `SMOKE_PROMPT` | `--smoke` 时注入的 prompt(多段以空行分隔) |
| `SMOKE_WAIT_MS` | 每段 prompt 后的等待毫秒数(默认 45000) |
| pi SDK 标准变量(`PI_*` agent 目录等) | 见 pi 文档;影响 `~/.pi` 布局 |
