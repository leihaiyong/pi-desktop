# AGENTS.md — Pi Desktop 开发指引

面向 AI 编码助手（及新加入的开发者）的项目速查手册。

## 项目概览

Pi Desktop 是 pi coding agent 的跨平台桌面客户端：Electron 壳 + pi SDK（main 进程内），
渲染器为原生 HTML/CSS/JS（ESM，无框架、无构建步骤）。详细设计见 `docs/architecture.md`。

```
src/main/        Electron main：index.js(窗口/CLI)、host.js(AgentHost, 全部 IPC 频道)、platform.js
src/preload/     contextBridge：window.pi.invoke / window.pi.on
src/renderer/    纯 Web 应用：index.html、css/、js/(main/editor/transcript/modals/markdown/workspaces/skill/snip)
src/shared/      渲染器与单测共用的纯函数（diff/format/i18n/keys/slash/tree/theme/workspaces/snip）
test/            vitest 单测 + smoke-host.mjs(无头 SDK 冒烟测试)
scripts/         辅助脚本：repack-asar.mjs、make-icons.mjs、cdp-*.mjs
docs/            architecture.md / api.md / keybindings.md / installation.md
```

## 版本控制：git

- 本仓库使用**纯 git**（未初始化 jj；如需 jj 可运行 `jj git init --colocate`）。
- 提交信息遵循 conventional commits：`type(scope): desc`，如
  `fix(modals): only list auth-eligible models in /model selector`。
- 常用命令：

```sh
git status --short          # 查看改动
git diff                    # 查看差异
git add <file>              # 只添加目标文件，不要 git add -A
git commit -m "fix(x): ..." # 提交
git log --oneline -10       # 查看历史
```

- Windows 下行尾为 CRLF，git 会提示 "LF will be replaced by CRLF"，属正常现象，忽略即可。

## 开发常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 启动应用（electron .） |
| `npm run dev` | 带 `--dev` 标志启动（开发调试） |
| `npm test` | 运行 vitest 单测（`vitest --run`） |
| `node test/smoke-host.mjs` | 无头 SDK 冒烟测试 |
| `npm run build` / `build:win` / `build:mac` / `build:linux` | electron-builder 打包 |
| `npm run package:dir` | 打包为 --dir（免安装目录，调试打包产物用） |
| `npm run repack:asar` | 重打包 asar（`scripts/repack-asar.mjs`） |
| `npm run vendor:hljs` | 重新打包 highlight.js 到 `src/renderer/vendor/` |

- 环境要求：Node ≥ 22.19.0（`package.json` engines 约束）。
- 修改代码后**必须**跑 `npm test`（当前 104 个用例），全部通过再提交。

## 架构约定（改动前必读）

1. **Agent 能力全部来自 pi SDK**。会话/模型/工具/扩展/技能/主题都是 SDK 对象；
   桌面端只做宿主 + 视图，不要自行实现 agent 逻辑。
2. **渲染器零 Node 权限**。`contextIsolation: true`、`nodeIntegration: false`、
   严格 CSP。renderer 只能通过 `window.pi.invoke(channel, params)`（统一
   `{ok, result|error}` 信封）和 `window.pi.on(event, cb)` 与 main 通信。
3. **`src/shared/` 必须保持纯函数**：不依赖 DOM / Electron，渲染器和 vitest 单测共用。
4. **IPC 频道**全部收敛在 `host.js` 的 `dispatch()`；新增频道需同步更新
   `test/ipc-channels.test.js`（频道清单校验）。
5. **快捷键**定义在 `src/shared/keys.js`，渲染器与 main 菜单共用。

## 国际化

- 所有 UI 字符串走 `t("...")`，词条集中在 `src/shared/i18n.js`（`en` + `zh` 两套）。
- 新增文案时 **en 和 zh 必须同时添加**；`test/i18n.test.js` 会校验两套词条键一致。
- 不要用模板字符串拼 UI 文案。

## 测试约定

- 单测用 vitest（`test/*.test.js`，ESM，与 `vitest.config.js` 配套）。
- `src/shared/` 下每个模块都有对应单测；给 shared 新增/修改函数时同步补测试。
- 涉及 SDK 行为的改动可跑 `node test/smoke-host.mjs` 做无头冒烟验证。

## 提交前检查清单

- [ ] `npm test` 全部通过
- [ ] 新 UI 字符串已在 i18n.js 的 en/zh 双语补齐
- [ ] 新增 IPC 频道已更新 `test/ipc-channels.test.js`
- [ ] 提交信息为 `type(scope): desc` 格式，`git add` 只含目标文件
