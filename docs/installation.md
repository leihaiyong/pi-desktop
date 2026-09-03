# 安装与部署

> 配套文档:[架构设计](./architecture.md) · [API 参考](./api.md) · [快捷键](./keybindings.md)

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.19(验证于 24.x) | `engines` 约束 |
| pi monorepo | 与 pi-desktop 同级目录 | 见下方目录布局 |
| npm registry | 任意(国内建议 npmmirror) | Electron 二进制下载受网络影响最大 |
| 操作系统 | Windows / macOS / Linux | 打包需在目标平台执行 |

### 目录布局(关键)

pi-desktop 通过 `file:` 链接依赖 pi monorepo 的 SDK 包,**两者必须保持
兄弟目录关系**:

```
<root>/
  pi/                  # pi monorepo(git clone)
    packages/
      ai/              # @earendil-works/pi-ai
      coding-agent/    # @earendil-works/pi-coding-agent
  pi-desktop/          # 本项目
```

`pi-desktop/package.json`:

```json
"dependencies": {
  "@earendil-works/pi-ai": "file:../pi/packages/ai",
  "@earendil-works/pi-coding-agent": "file:../pi/packages/coding-agent",
  "marked": "15.0.12"
}
```

> 注意:pi 包自身的依赖(install 时)留在 `pi/node_modules`,
> npm 不会提升到 pi-desktop 的 node_modules —— 打包闭包计算
> (见 §5)已处理这一点。

## 2. 开发安装

```sh
cd pi-desktop

# 国内网络可先配置镜像(可选)
npm config set registry https://registry.npmmirror.com
npm config set electron_mirror https://npmmirror.com/mirrors/electron/

npm install            # electron、esbuild、vitest + file: 链接 pi 包

# 若 highlight.js 依赖有变动,重新生成浏览器 bundle
npm run vendor:hljs    # esbuild → src/renderer/vendor/highlight.js
```

`npm install` 会创建两个 junction(Windows)/ symlink:
`pi-desktop/node_modules/@earendil-works/pi-ai` 与 `pi-coding-agent`
指向 monorepo 包目录。

## 3. 运行与测试

```sh
npm start              # 启动应用
npm run dev            # 同 start,renderer console 转发到终端
npm test               # vitest,81 个单测
node test/smoke-host.mjs   # 无头 SDK 冒烟(真实运行时,不启动 Electron)
```

### 开发标志

| 命令 | 说明 |
|---|---|
| `npm start -- --cwd <dir>` | 指定工作目录 |
| `npm start -- --session <file.jsonl>` | 恢复指定会话 |
| `npm start -- --smoke` | 开发版专用:加载后自动截图到临时目录并退出 |
| `SMOKE_PROMPT="你好" SMOKE_WAIT_MS=30000 npm start -- --smoke` | 驱动一次真实 prompt 并截图 |
| `npm start -- --remote-debugging-port=9222` | 开启 CDP,配合 `scripts/cdp-eval.mjs` 调试 |

### CDP 调试

```sh
# 终端 1:带调试端口启动
npm start -- --remote-debugging-port=9333

# 终端 2:在 renderer 里求值(表达式来自文件,避免 shell 引号问题)
node scripts/cdp-eval.mjs 9333 "@expr.js" [waitMs]
node scripts/cdp-shot.mjs 9333 out.png   # 截图
```

## 4. 打包(安装部署产物)

配置见 `electron-builder.yml`。打包必须在目标平台执行(代码签名、
图标格式等平台相关)。

| 平台 | 产物 | 命令 |
|---|---|---|
| Windows | NSIS 安装包 + portable exe | `npm run build:win` |
| macOS | dmg + zip | `npm run build:mac`(需 macOS + Xcode CLT) |
| Linux | AppImage + deb + rpm | `npm run build:linux`(需 gobject/gtk 工具链) |

通用:

```sh
npm run build          # 按当前平台默认目标打包
npm run package:dir    # 只产 release/win-unpacked(或 mac/linux-unpacked)目录,最快
```

产物输出在 `release/`,应用 id `dev.pi.desktop`,
不配置自动更新(`publish: null`)——手动分发安装包。

### 图标

`build/icon.png` 为源图,`npm run make-icons`(即 `scripts/make-icons.mjs`)
生成 `icon.ico`(Windows)/ `icon.icns`(macOS)/ `icon.png`(Linux)。

### 运行时依赖闭包

`node_modules` 整树打入 asar,但其中:

- **electron 运行时包本身**(200 MB+)是 devDependency,不在闭包内;
- 闭包 = 从 pi-desktop runtime dependencies 出发、跨
  `pi-desktop/node_modules` 与 `pi/node_modules` 两棵树 BFS 的
  `dependencies` 图(约 140 包);
- `highlight.js` 是 devDependency(仅 `vendor:hljs` 用),
  浏览器 bundle 在 `src/renderer/vendor/`,随 `src/**` 打包。

## 5. Windows 非管理员环境的替代打包流程

本机(Windows,非管理员、未开开发者模式)上,electron-builder 能完成
除最后签名步骤外的全部工作:`winCodeSign` 资源包内含符号链接,
解压需要 `SeCreateSymbolicLinkPrivilege`。绕过方式:

```sh
npm run package:dir    # 产出 release/win-unpacked(可运行,asar 为占位)
npm run repack:asar    # 重建 resources/app.asar(81 MB,~10.8k 文件)
```

`scripts/repack-asar.mjs` 做的事:

1. 按 electron-builder `files` 规则收集 `src/**`、`package.json`、
   node_modules 运行时闭包(两棵树 BFS);
2. 用 `createPackageFromStreams` 逐文件打包(路径跨两棵 node_modules,
   `createPackageFromFiles` 做不到);
3. `normalizeAsarPaths()`:@electron/asar 在 Windows 上把 asar 头内路径
   normalize 成反斜杠,Electron 只认正斜杠 —— 对 asar 头 JSON 原地重写。

产物 `release/win-unpacked/Pi Desktop.exe` 为完整可运行目录,
可直接 zip 分发。macOS/Linux 无此限制,直接 `npm run build:*`。

## 6. 部署形态

| 形态 | 做法 |
|---|---|
| 安装包 | `build:win` 的 NSIS(可选安装目录、桌面快捷方式)/ dmg / deb / rpm |
| 绿色版 | Windows `portable` exe;或直接分发 `release/win-unpacked` 目录 |
| AppImage | Linux 单文件,`--cwd` 等参数透传 |
| 容器 | 未提供;Electron 需 X/Wayland,如需要可基于 `jrottenberg/ffmpeg` 类基础镜像自行封装 |

首次启动后,应用数据位于 pi 标准目录:

```
~/.pi/agent/
  sessions/<项目哈希>/*.jsonl   # 会话(与 TUI 共享)
  themes/*.json                # 自定义主题
  …(模型配置、认证等,与 TUI 完全一致)
```

即 Pi Desktop 与 `pi` CLI 共享同一份 agent 数据,无需额外迁移。

## 7. 常见问题

| 症状 | 原因 / 处理 |
|---|---|
| `npm install` 卡在 electron 下载 | 配置 `electron_mirror`(§2),或代理 |
| 启动报找不到 `@earendil-works/*` | pi monorepo 不在兄弟目录,或 junction 失效 —— 重新 `npm install` |
| EBUSY(Windows 升级 electron 等) | 有 Electron 进程占用文件,先 `Stop-Process electron` 再装 |
| 打包最后一步 winCodeSign 报 symlink 权限 | 非管理员限制。用 §5 的 `package:dir` + `repack:asar` 流程;或开开发者模式/管理员 |
| 打包版窗口空白、状态不出现 | 渲染器错过一次性 `host:ready` 推送 —— 已在代码中以 `host.snapshot` 拉取修复;若复现,确认 asar 是 repack 脚本产物(头内路径为正斜杠) |
| 代码无语法高亮 | `src/renderer/vendor/highlight.js` 缺失/过期 —— `npm run vendor:hljs` 后重启(重新打包) |
| 本地 llama.cpp 模型不出现 | 与 TUI 相同:模型来自 pi 的模型发现;`models.refresh` 可强制刷新 |
| 扩展报 "Custom focused components are not supported" | 该扩展用了 TUI 焦点组件,桌面端不支持(见架构 §7) |
| 会话删除被拒 "Refusing to delete" | `sessions.delete` 只允许 `<agentDir>/sessions/**.jsonl` —— 属预期安全约束 |

## 8. 发布检查单

1. `npm test` 全绿(81 用例)+ `node test/smoke-host.mjs` 通过;
2. 目标平台 `npm run package:dir`,启动验证:快照状态、一次真实
   prompt(含工具调用)、模态框开关、主题切换;
3. Windows 非管理员环境执行 `npm run repack:asar` 后重复第 2 步;
4. 版本号:`package.json` `version` + `productName`(NSIS 元数据);
5. 分发:安装包 / portable / 目录 zip;附上"首次启动选择工作目录"说明。
