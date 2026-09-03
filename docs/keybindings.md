# 快捷键参考

> 配套文档:[架构设计](./architecture.md) · [API 参考](./api.md) · [安装与部署](./installation.md)

应用内按 `/hotkeys` 可查看当前生效的绑定表。默认绑定定义在
`src/shared/keys.js` 的 `defaultBindings(platform)`,兼容 pi
`keybindings.json` 的组合键格式(`ctrl+shift+x`、`super` 别名)。

## 会话控制

| 动作 | Windows | macOS / Linux |
|---|---|---|
| 中断当前轮(`app.interrupt`) | Esc | Esc |
| 清空编辑器(`app.clear`) | Ctrl+C | Ctrl+C |
| 退出应用(编辑器为空时,`app.exit`) | Ctrl+D | Ctrl+D |
| 双击 Esc | fork 会话(或按设置 `doubleEscapeAction`:tree/none) | 同左(仅在编辑器外生效) |

## 输入

| 动作 | 组合键 | 说明 |
|---|---|---|
| 发送(`app.input.submit`) | Enter | 流式中发送 = 转 steering 排队 |
| 换行(`app.input.newLine`) | Shift+Enter / Ctrl+J | 编辑器内原生行为,全局层不拦截 |
| Tab 缩进/移动焦点 | Tab | 编辑器内不拦截 |
| 排队 follow-up(`app.message.followUp`) | Ctrl+Q | Alt+Enter |
| 取回排队消息(`app.message.dequeue`) | Alt+Q | Alt+↑ |
| 上/下历史(`app.history.*`) | ↑ / ↓ | 仅在单行且光标位于行首/行尾时 |
| 粘贴图片(`app.clipboard.pasteImage`) | **Alt+V**(全平台) | Ctrl+V 保留给原生文本粘贴 |
| 屏幕截图(`app.editor.screenshot`) | **Ctrl+Shift+S**(全平台) | 区域截图:隐藏主窗口 → 每个显示器开全屏选择层,鼠标拖出矩形(Enter 确认/Esc 取消,框外变暗,右上角显示像素尺寸)→ 弹出预览框(Enter/按钮附加到输入框,Retake 重截,Esc 取消);输入框右侧悬浮相机按钮同样触发 |
| 外部编辑器(`app.editor.external`) | Ctrl+G | 桌面端打开设置(占位) |

> 设计说明:编辑器聚焦时,`Enter / Shift+Enter / Tab / ↑ / ↓` 由编辑器与
> 文本域原生处理,window 级键位分发**不拦截**,避免吞掉换行等默认行为。
> 编辑器或正文有选区时,Ctrl+C / Ctrl+X 优先执行系统复制/剪切。

## 模型与思考

| 动作 | Windows | macOS / Linux |
|---|---|---|
| 模型选择器(`app.model.select`) | Ctrl+L | Ctrl+L |
| 正向切换模型(`app.model.cycleForward`) | Ctrl+P | Ctrl+P |
| 反向切换模型(`app.model.cycleBackward`) | Alt+P | Shift+Ctrl+P |
| 切换思考级别(`app.thinking.cycle`) | Shift+Tab | Shift+Tab |
| 折叠/展开 thinking 块(`app.thinking.toggle`) | Ctrl+T | Ctrl+T |

## 会话管理

| 动作 | 组合键 |
|---|---|
| 新会话(`app.session.new`) | Ctrl+N |
| 会话树(`app.session.tree`) | Ctrl+Shift+T |
| fork(`app.session.fork`) | Ctrl+Shift+F2 |
| 恢复会话(`app.session.resume`) | Ctrl+Shift+R |
| 重命名当前会话(`app.session.rename`) | Ctrl+R |
| 删除会话(`app.session.delete`) | Ctrl+Backspace(提示在恢复选择器中 Ctrl+D 删除) |

## 转录区

| 动作 | Windows | macOS / Linux |
|---|---|---|
| 搜索转录(`app.transcript.search`) | Ctrl+F | Ctrl+Shift+F |
| 跳到顶部(`app.transcript.top`) | Ctrl+Home | Ctrl+Home |
| 跳到底部(`app.transcript.bottom`) | Ctrl+End | Ctrl+End |
| 上一条用户消息(`app.transcript.previousPrompt`) | Ctrl+Shift+↑ | Ctrl+Shift+↑ |
| 下一条用户消息(`app.transcript.nextPrompt`) | Ctrl+Shift+↓ | Ctrl+Shift+↓ |
| 展开全部/收起工具块(`app.tools.expand`) | Ctrl+O | Ctrl+O |
| 复制最近 assistant 消息(`app.message.copy`) | Ctrl+X | Ctrl+X |

## 模态框内(通用)

| 键 | 行为 |
|---|---|
| ↑ / ↓ / PageUp / PageDown / Home / End | 列表导航 |
| Enter | 选择当前项 |
| Esc | 关闭(搜索框聚焦时先失焦) |
| `/` | 聚焦搜索框(可搜索列表) |
| 会话恢复选择器:Ctrl+R / Ctrl+D / Ctrl+F | 重命名 / 删除 / fork 当前项 |
| 工作区选择器:←/→ 切栏,↑/↓ 导航,Enter 打开/加载,N 新建,Ctrl+D 两步删除,Esc 取消删除/关闭 | 见架构 §4.9 |
| 会话树:Enter / Ctrl+Enter / Ctrl+C / Shift+L | 导航 / fork / clone / 打标签 |
| 用户消息 fork 选择器:Enter / Ctrl+Enter / Ctrl+C | 于该消息前 fork / fork / clone |
| scoped-models:Enter / Ctrl+S | 勾选切换 / 保存 |

## 组合键格式

- 修饰键:`ctrl` `shift` `alt` `meta`(或 `super`/`cmd` 别名);
- 键名:`esc` → `escape`,`return` → `enter`,` ` → `space`;
- 归一化:修饰键排序后拼接,匹配与 `keybindings.json` 一致
  (`normalizeKeyCombo`)。

> 现状说明:`buildComboIndex(bindings, overrides)` 支持用户覆盖,
> 但应用尚未加载 pi 的 `keybindings.json`(见架构 §7),
> 当前 `/hotkeys` 展示的即默认表。
