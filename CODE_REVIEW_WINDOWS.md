# dsh-bsb-ipynb Windows 侧代码审核报告（仅未修复项）

> **审核快照**：2026-11-07，Windows 11 实机。**本文件只保留仍未修复或只修复了一部分的问题**；已经完全修复的条目（P0 解释器发现、Windows 保存错误语义、Windows 绝对路径图片、Ctrl+S/IME、连接文件与子进程回收、restart 自愈、BOM/CRLF/ANSI、文档与 CI 等，共五批）已从本文件删除，修复记录见 `git log`（2026-11-07 的 `ee1851c`…`68e412b` 系列提交）与 `test/` 下的回归测试。
> **环境**：Windows 11 build `10.0.26300`（NTFS，大小写不敏感）、Node v24.19.0、Python 3.14.7（jupyter_client 8.10 / ipykernel 7.4 / nbformat 5.11）、控制台 cp936、DSH Desktop 0.2.2-rc.1、dsh-better-sidebar 0.30.1。
> **证据等级**：【已验证】= 可重跑脚本/确定性路径复现；【契约核对】= 对照 DSH/better-sidebar/上游库源码；【推测】= 仅代码推理。
> **行号说明**：下列行号为本次快照（修复后工作树）中的大致位置；已修复批次的改动使部分文件行号与旧报告不同，按函数名检索更可靠。macOS 侧完整快照见 [CODE_REVIEW.md](CODE_REVIEW.md)。

## 0. 未修复问题总览

| 级别 | 数量 | 条目 |
| --- | --- | --- |
| Medium | 8 | W-B1、M-2、M-7、M-8、M-9、M-10、M-11、M-12 |
| Low | 15 | W-B5、W-B6、W-B7、W-C3、L-5、L-9、L-10、L-12、L-13、L-15、L-16、L-18、L-19、L-20、L-21 |
| Nit | 若干 | W-C6、N-02、N-03 及 macOS 快照 §3 的客户端/文档类 |
| 测试缺口 | 5 | T-1、T-3、T-5、T-6、T-8 |

> 平台无关的 macOS 审查遗留项（M-2/M-4/M-8/M-10/M-11/M-12、L-5/L-9/L-12/L-13/L-18/L-19/L-20）在 Windows 上同样成立，完整描述见 [CODE_REVIEW.md](CODE_REVIEW.md)；本文件 §2.3 只列 Windows 侧复核结论有差异或 Windows 特有的部分。

## 1. 路径与存储（Windows 特有/形态差异）

| ID | 级别 | 位置（快照） | 问题 | 证据与影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **W-B1** | Medium（安全） | `lib/gate.js:64-85,152-185,91-150`（授权与 I/O 两次解析、`walkTarget`）；`lib/notebook.js:readNotebookFile/writeNotebook` | **授权后 TOCTOU 越界（M-6 的 Windows 形态）**：预置的越界 junction 会被 403 正确拒绝；但授权后把目标**父目录**替换为指向外部目录的 junction，读可泄漏外部内容、写可覆盖外部文件。Windows 上创建 junction **不需要管理员/开发者模式**，门槛低于 macOS symlink。 | 【已验证】**授权后替换 = 可绕过**（外部 metadata 被读出、外部文件被写入且无残留）；**预置越界 = 被正确拒绝**。注意：junction 在 Node 的 `lstat/readlink` 中是否可见取决于运行环境（见 §6 未核实 1），不能把安全判断建立在“能否看到 reparse point”上。 | 读路径把授权、打开、`fstat` 身份核验与有界读取绑定到同一 fd；写路径绑定父目录身份（openat/dirfd 等价）并在 temp 写入/rename 前复核 realpath/dev/ino；逐组件解析时显式处理 reparse point。 |
| **W-B5** | Low（= L-10） | `lib/notebook.js:495`（`saveQueues`）、`511`、`590` | `saveQueues` 只按 canonical **路径字符串**串行化：同一 inode 的**硬链接改名**并发保存**两个都成功**，保存后内容分叉、不再是同一 inode，违反 README「同一 notebook 并发保存只有第一个成功」。大小写/8.3/junction 别名会被 realpath 归一化，能正确串行（第二个 409）；问题只剩硬链接类别名。 | 【已验证】`[ok, ok]`、`contentsEqual:false`、`stillSameInode:false`。 | 按 `dev/ino` 串行化，或 README 明确该边界。 |
| **W-B6** | Low | `lib/gate.js:91-150`（`walkTarget`）、`214-233`（`KernelPaths`） | 通过 junction 访问 notebook，先删除其目标目录（junction 悬空后 Node 视为 ENOENT）再调用控制端点：控制路径退化为「请求拼写路径」，与内核 canonical 键不一致 → 活内核不可达（`/status` running:false、interrupt 503）。属于**安全失败方向**，不会控制错内核。 | 【已验证】删目标后 `resolveControlTarget('dangling/missing.ipynb')` 返回请求拼写而非原 canonical target。 | 可不改；若要修，需要显式处理悬空 reparse point 并保留授权时观察到的 identity。 |
| **W-B7** | Low | `lib/gate.js:194-233`（`samePathIdentity`、alias key） | NTFS 大小写不敏感：文件删除后，若某大小写拼写从未在文件存在时被观察过，经该拼写调用控制端点无法匹配按 canonical 路径登记的活内核（`/status` running:false、interrupt 503）。 | 【已验证】`nb.ipynb` 可匹配，`NB.IPYNB` 不能；文件存在时三种拼写都归一化到同一 canonical target。 | 安全方向安全；可对 win32 的未存在段做 `toLowerCase()` 作为 alias key，或文档说明拼写需一致。 |

## 2. 客户端（Windows 浏览器/中文输入法）

| ID | 级别 | 位置（快照） | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| **W-C3** | Low | `client.js:64,121`（`shortcuts` 文案）及底部常驻快捷键提示 | 快捷键提示硬编码 `Ctrl/Cmd`，无平台检测（全文无 `navigator.platform/userAgent`）→ Windows 用户始终看到 "Cmd"；DSH 0.2.2-rc.1 自带 `@deepseek-ai/dsh-client-shortcuts`（平台化 keycap、可改键、冲突检测）可接入。 | 按平台选文案；目标态接入 DSH shortcuts（同时解决 L-21）。 |
| **W-C6** | Nit | `client.js:1295`（编辑态 `onKeyDown` 的 Tab 分支） | Tab 恒被拦截插入 4 空格、无 Shift+Tab 反缩进、无法用 Tab 离开 textarea（键盘导航/高对比度场景）。 | 文档说明，或 Shift+Tab 反缩进、Ctrl+Tab 放行焦点。 |
| **L-16** | Low | `client.js:1210`（`OutputView` 的 `text/html` 分支） | `text/html` 输出清洗后图片不经过 `resolveImage`：`<img src="attachment:...">`/相对路径在 HTML 输出中裂图（Markdown 单元格/输出已支持）。 | 在清洗后的 DOM 上对 `img[src]` 调用 resolver 再序列化；补 DOMParser 行为测试（T-1）。 |
| **L-21** | Low | `client.js` 的 `CellView` `onKeyDown`（仅编辑态 textarea 触发；无全局监听） | 快捷键只在编辑单元格时生效；浏览器版在非编辑态按 Ctrl+S 会触发「保存网页」而非插件保存。 | 加全局监听（编辑态复用现有逻辑），或接入 DSH shortcuts。 |
| **L-15** | Low | `client.js` 多处 `setBanner({ kind, text: t(...) })`（约 `1648-1723` 起） | banner 在事件发生时把文案翻译后存入 state：切换语言后冲突/保存失败/容量/内核重启等 banner 不重译（渲染期 `t()` 的静态文案会更新）。 | banner 存 `{key,params,kind,action}`，渲染时再 `t(key)`；先迁移 conflict，再覆盖 capacity/kernel。 |

## 3. 跨平台遗留项在 Windows 的复核（未修复）

| 条目 | Windows 结论 |
| --- | --- |
| **M-2**（metadata 限制只覆盖 metadata，data/attachments JSON 可放大；32MiB 在 stringify 后检查） | 成立，平台无关。 |
| **M-4**（`OutputView` 未 memo，stream 合并 O(n²)） | 成立，Windows 浏览器同样受影响。 |
| **M-7**（工作区根不跟随 better-sidebar 活动 worktree） | 成立：Windows 下 linked worktree 同样 403；跨盘 worktree 走 `path.relative` 返回绝对路径 → fail-closed（行为正确但仍是 403）。 |
| **M-8**（rename 窗口内外部写被静默覆盖） | 成立，Windows 同 Mac；README 已声明该竞态，但声明不能避免数据丢失。 |
| **M-9**（硬编码颜色未 token 化） | 成立；Windows 侧补充：DSH 字号 token（`--dsh-content-font-size`/`--dsh-code-font-size`）未消费，`fontSize:18` 与 125%/150% 缩放不影响 notebook。 |
| **M-10**（非 JSON/缺 type 帧不 failRun，活动 run 可永久阻塞） | 成立；Windows 上同样会出现 kernel-busy 挂起。 |
| **M-11**（shutdown 宽限与提前遗忘） | 成立；Windows 上 SIGTERM/SIGKILL 均为 TerminateProcess，二次 kill 无意义，清理只能依赖显式 shutdown 协议（代码已加注释）。 |
| **M-12**（迟到的 GET `/status` 覆盖内核终态） | 成立；Windows 浏览器同。 |
| **T-1 / T-3 / T-5 / T-6 / T-8** | 见 §4。 |

## 4. 测试缺口（Windows 侧剩余）

| ID | 缺口 | 建议 |
| --- | --- | --- |
| **T-1** | DOMParser 白名单清洗器仍无真实行为测试（现有用例只覆盖无 DOMParser/抛错 fallback），L-12/L-16 藏于此。 | 最小 DOM 替身或 jsdom 驱动真实分支，断言 DROP_TAGS/属性白名单/`javascript:`/`target+rel`；Windows 路径 `<img src="C:\…">`/UNC 一并覆盖。 |
| **T-3** | 客户端主交互仍缺真实行为测试：工具栏 interrupt/restart/shutdown、解释器切换（confirm+localStorage）、`visible` 轮询、1.5s autosave 正路径、`onToolbarState`；IME/CapsLock 目前只有纯函数级测试。 | 复用现有 vm harness 补齐；补 composition（`isComposing`/229）× 5 快捷键、CapsLock `KeyS`、CRLF 渲染的回归。 |
| **T-5** | HTTP 层仍全部用手写 `req/res` 替身，无真实 socket：NDJSON 分块、真实 `res.write` 背压/drain、真实 `close/writableEnded`、header 大小写只有假设。 | 加 `node:http` + fetch 端到端测试（`/read` 成功/404、`/execute` 流式读取与中途 abort、慢读）。 |
| **T-6** | 剩余放大/保护/恢复类回归：M-2 的 data 放大与整本预算、M-10 坏帧、M-12 迟到 GET；窗口/drain 类已补。 | 随对应修复一起补（多数可复用现有测试改造）。 |
| **T-8** | 剩余失败/竞态路径缺回归：M-10 活动 run 坏协议帧、M-11 忽略 SIGTERM 的 shutdown（真实内核）。 | 注入坏帧、不退出 child，断言有界终态与进程回收。 |

## 5. Nit / 环境注意（Windows）

| ID | 说明 |
| --- | --- |
| **N-02** | 内核启动失败时 `lastError` 含 Windows 本地化 `WinError` 文本（如 `[WinError 267] 目录名称无效。`），跨语言界面下文案混杂（功能无影响）。 |
| **N-03** | Node v24 在 Windows 上对尾点/尾空格/保留设备名采用**字面语义**（与 cmd/Python 的 Win32 归一化不同），长路径可用（实测 369/405 字符）。升级 Node/Windows 后需复验；`.ipynb` 判断继续以 realpath 为准（当前实现正确）。 |
| macOS 快照 §3 的其余 Nit（metadata 循环引用 TypeError→500、idle TTL=0 不可禁用、协议漂移、disposeAll 未 await、fence 刷屏、客户端 MIME/JSON/fence 等） | 平台无关，见 [CODE_REVIEW.md](CODE_REVIEW.md) §3。 |

## 6. 修复优先级（仅未修复项）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P1** | W-B1（M-6 TOCTOU）、M-10、M-12 | 安全加固与状态机挂起/竞态；W-B1 需要 fd/dirfd 级设计，建议先写威胁模型。 |
| **P2** | M-2、M-4、M-7、M-8、M-9、M-11、L-15、L-16、L-21 | 性能放大、数据竞态、主题/客户端体验与设计级加固。 |
| **P3** | W-B5、W-B6、W-B7、W-C3、W-C6、L-5、L-9、L-10、L-12、L-13、L-18、L-19、L-20、T-1/T-3/T-5/T-6/T-8、Nit | 边界、性能、测试补强，可按批清理。 |

## 7. 验证与复现说明

- 已修复项不再保留在本文件；它们的回归测试已进入 `test/`，并由三平台 CI（ubuntu-latest / windows-latest / macos-latest，均为 required）持续覆盖。修复后的 Windows 本地基线为 **317 tests / 273 pass / 0 fail / 44 skip**；三平台 CI 为 317 tests / windows 315 pass、macOS 314 pass、ubuntu 286 pass，均 0 fail。
- 未修复项的证据以各条【已验证】为准；快照中的复现脚本为本地临时文件，未随仓库提供。
- 历史审查快照（含已删除的修复过程与证据）可通过 `git log -p` 查看。

## 8. 未核实事项

1. **junction 的 Node 可见性存在环境差异**：完整访问权限下实测 `lstat(junction).isSymbolicLink()===true`、`readlink` 返回目标绝对路径（无 `\\?\` 前缀）；Low IL 沙箱会话中实测 `isSymbolicLink:false`、`readlink→EINVAL`。安全结论不依赖该差异（预置 junction 被 realpath 拒绝、TOCTOU 可绕过均已独立复现），但 W-B1 的修复不建议依赖 `lstat/readlink` 识别 reparse point。
2. **真实浏览器 UI/中文 IME 敲字**：无真实浏览器实测；W-C3/L-15/L-16/L-21 的浏览器表现均为静态/契约/Node 驱动结论。
3. **回环端到端**：未在真实 DSH 会话 UI 里打开 notebook 验证（路由受 admission fence 保护）；内核链路通过直接驱动 `lib/kernel.js` + route 层验证。
4. UNC 作为 workspace、icacls 拒绝、AV/索引器锁导致的 `.tmp` 残留、64MiB 读峰值等未逐项实测。
5. DSH host 日志缺失，无法确认插件 boot 后的运行期错误。
