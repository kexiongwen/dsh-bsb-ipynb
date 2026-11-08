# dsh-bsb-ipynb 代码审核报告（macOS + Windows 快照，仅未修复项）

> **审核快照**：2026-11-07，macOS APFS 与 Windows 11 实机各一轮。**本文件只保留仍未修复或只修复了一部分的问题**；已经完全修复的条目已删除，修复记录与回归测试见 `git log`（2026-11-07 的系列提交）与 `test/`。
> **2026-11-08 批次**：M-10、M-12、M-16、L-16、L-21 已修复并补齐回归测试；随后 M-15（有界版本读取，+5 回归）与 L-23（Windows 大小写 alias 回退，+3 回归）也已完成。以上条目按约定从本文件删除（修复细节见 `git log` 与 `test/`）。全量测试 **317 tests / 273 pass / 44 skip / 0 fail**（Windows 11，约 18.6s）。
> **本次修复**：M-13 已通过客户端等待保存、读取响应版本隔离，以及服务端同路径读写队列修复；跨单元格 `display_id` 更新也已修复。新增回归覆盖保存成功/冲突/失败、取消/编辑/卸载、旧响应隔离、跨 cell 更新与容量/失败回滚。本次完整测试 **352 tests / 308 pass / 44 skip / 0 fail**（Windows 11，约 19.8s）。网络失败时，尚未完成请求解析和路径解析、未进入文件队列的保存不在排队保证内；严格确认此类请求需要额外操作确认协议。
> **内核生命周期修复**：M-11、M-14 与 T-8 已完成。关闭等待实际退出，强杀后仍无退出事件则报告失败并保留条目；同一路径的启动/切换/重启按序执行，关闭可及时取消待完成操作，路径别名随实际替代内核迁移。回归覆盖并发 A→B/C、执行忙态、关闭打断启动/重启、超时保留条目、空闲回收/插件清理、计时器延迟与迟到退出。本轮完整测试 **373 tests / 329 pass / 44 skip / 0 fail**（Windows 11，约 19.9s）。
> **环境**：

| 平台 | 环境 |
| --- | --- |
| macOS（原始快照） | macOS APFS；Node v24.13.1；Python 3.14.7（jupyter_client 8.10 / ipykernel 7.3 / nbformat 5.11）；DSH Desktop 0.2.2-rc.1；dsh-better-sidebar 0.30.1 |
| Windows（复核与实测） | Windows 11 build `10.0.26300`（NTFS，大小写不敏感）；Node v24.19.0；Python 3.14.7（jupyter_client 8.10 / ipykernel 7.4 / nbformat 5.11）；控制台 cp936；同一 DSH/better-sidebar 版本 |

> **验证依据**：macOS 快照时 `npm test` 292 pass / 0 fail / 0 skipped（约 23.5s），行覆盖 gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%，client.js 24.7%（仅作风险信号）。历史修复后测试集扩到 325 tests，三平台 CI 当时全绿；当前 Windows 工作区全量测试为 **373 tests / 329 pass / 44 skip / 0 fail**（2026-11-08）。
> **增量复核**：独立审查新增问题编号为 **M-13～M-17**（其中 M-13～M-16 已修复）；此前及后续已经修复的问题按本文件约定不重复列入。
> **证据等级**：【已验证】= 可重跑脚本或确定性路径复现；【契约核对】= 对照 DSH、better-sidebar、上游库源码；【推测】= 仅代码推理。
> **平台标签**：【全平台】= macOS/Windows/Linux 均成立；【Windows 形态】= Windows 上表现/利用条件不同；【POSIX】= Windows 上不成立。
> **行号说明**：历史条目中的 `file:line` 为原快照行号；多轮修复后行号已变化，按函数名/ID 检索更可靠。M-17 的行号也属于对应审核快照，当前请按函数名检索。

**问题总览（仅未修复）**

| 级别 | 数量 | 条目 |
| --- | --- | --- |
| Medium | 6 | M-2、M-4、M-6、M-7、M-8、M-17 |
| Low | 4 | L-5、L-12、L-13、L-22 |
| Nit | 约 5 类 | 存储、内核/桥、宿主、客户端/环境、测试/文档 |
| 测试缺口 | 4 | T-1、T-3、T-5、T-6 |

> 原 Windows 报告中的独立条目已合并：W-B1 → M-6、W-B5 → L-10、W-B6 → L-22、W-B7 → L-23、W-C3 → L-24，W-C6/N-02/N-03 收入 §3；其余 Windows 条目已修复并从报告删除。

---

## 1. Medium（6 项，未修复）

| ID | 平台 | 位置（快照时） | 问题与影响 | 证据 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **M-2**（P1） | 全平台 | `lib/notebook.js:38-73`（限制）、`107-120`（data/attachments 原样保留）、`253-268`（serialize）、`384-408`（先序列化后查 32MiB） | metadata 的 100 层/10,000 节点限制**只覆盖 metadata 对象**：`execute_result/display_data.data[application/*+json]`、`attachments[...]` 中同样会被 pretty-print 的 JSON 值完全不受限，且限制是「每对象」而非整本预算；32MiB 上限仍在 `JSON.stringify` 之后检查。小输入可造成显著内存/CPU 放大（DoS 面），多 cell 或并发保存可进一步放大；客户端保存预检也需同步 pretty-stringify 整本 notebook；快照缓存只避免重复测量，不限制单次分配。RangeError→413 只改善错误分类，不构成分配上限。 | 【已验证】depth=4200 的合法 notebook：compact 42,351 B、read ok，pretty 35,435,973 B（约 **837×**），RSS +132MiB，随后才 413；另有 9,230 B → 4,549,895 B（约 493×）独立复现。 | ① 对 data/attachments 的 JSON 值同样应用 depth/node 限制，并设整本节点/字节预算；② 把 32MiB 做成**有界序列化预算**，超限即中止；③ 快照缓存只减少重复测量，仍需为有界序列化提供统一预算。 |
| **M-4**（P2） | 全平台 | `client.js:1135-1188`（`OutputView` 未 memo）、`1042-1126`（`reduceOutputs` 流合并）、`1339`（逐 output 渲染） | 大输出渲染 O(n²)：每次流事件产生新 outputs 数组 → 整 cell 重渲；`OutputView` 未按 output 对象缓存，`ansiToHtml`/`sanitizeHtml`/markdown 全文重算；流合并每次 `last.text + chunk` 全量复制；高频 NDJSON 事件无 rAF/短窗口合并。大日志可造成明显 UI 卡顿；真实浏览器布局成本未测量。 | 【已验证】16KiB/chunk reducer + ANSI 微基准 1/2/4/8MiB = **16/57/216/843ms**（≈4×/倍），不含真实 React/DOM。 | memo 未变化 output；高频事件按 rAF/短窗口合并；保留 ANSI 增量状态或分块渲染；保留现有精确字节预算测试。 |
| **M-6**（P2） | 全平台（Windows 形态） | `lib/gate.js:64-85,152-185,273-279`；`lib/notebook.js:308-330`（读）、`410-447`（存） | 路径授权（realpath 检查）与真正的文件 I/O 是两次独立解析，无 fd/inode 绑定：授权后把目标替换为指向工作区外的 symlink → 越界读；把父目录替换为指向外部的 symlink 且外部内容匹配 baseVersion → 越界写。二次版本校验不缓解（两次 readFile 沿 symlink 读到同一外部内容）。前提是竞争者能并发修改工作区目录项，纯 HTTP 请求本身不能制造 symlink。**Windows 形态（原 W-B1）**：预置的越界 junction 会被 403 正确拒绝，但授权后把父目录换成 junction 即可越界读/写；Windows 创建 junction **不需要管理员/开发者模式**，门槛低于 macOS symlink。 | 【已验证】按 route 相同调用顺序确定性替换：读得到外部内容、写成功写出局外文件（macOS symlink 与 Windows junction 均复现）。注意：junction 在 Node 的 `lstat/readlink` 中是否可见取决于运行环境（见 §8 未核实 1），不能把安全判断建立在「能否看到 reparse point」上。 | 读取将授权、打开、fstat 身份核验和有界读取绑定到同一 fd，并逐组件防跟随；写入绑定父目录身份并使用 dirfd/openat 等价能力，至少在 temp-write/rename 前重验 realpath/dev/ino。仅再做一次字符串 realpath 不能根治。 |
| **M-7**（P2） | 全平台 | `lib/gate.js:16-53` | 工作区根只认 `ctx.get('workingDirectory').get(session)` / `session.header.cwd`，**不跟随 better-sidebar 的活动根**：文件树根是 `activeWorktreeRootOf(...)`（会采纳 linked git worktree，可能在会话 cwd 之外）。会话活动根为 linked worktree 时，`/ipynb/read`、`/ipynb/save`、`/ipynb/execute`、`/ipynb/status` 全部 403，核心功能不可用。Windows 下同样 403；跨盘 worktree 走 `path.relative` 返回绝对路径 → fail-closed（行为正确但仍是 403）。 | 【契约核对】better-sidebar 0.30.1：`src/index.ts:730-735`、`src/active-worktree.ts:466`；文件 viewer 收到绝对路径后本插件原样提交（`client.js:621,1586,1835`）。未在真实 worktree 会话端到端复现。 | 引入与 better-sidebar 对齐的「活动根集合」（主根 + 关联 worktree realpath，realpath 落在任一候选根内即允许）。 |
| **M-8**（P2） | 全平台 | `lib/notebook.js:364-382,432-447`；`README.md`（保存可靠性一节） | 保存的 CAS 只在 `readFile→sha256→比较` 时检测冲突；第二次 `assertNotebookVersion` 返回后到 rename 之间仍有窗口：外部写者在窗口内写入会被静默覆盖，API 仍返回成功。README 已声明该竞态，但声明不能避免数据丢失；Windows 上同样成立。 | 【已验证】在 rename 钩子注入外部写：save fulfilled、`externalEditLost=true`，最终只有 PLUGIN_SAVE。 | 若必须提供强一致，使用覆盖读取—写入—提交的跨进程锁或支持 CAS 的提交协议，并保留冲突副本；rename 前核对 dev/ino、mtime、size 只能收窄窗口，单纯再加 hash 不能根治。 |
| **M-17**（P2） | 全平台 | `client.js:1187-1220`（`makeImageResolver`/`fileUrl`）；better-sidebar 0.30.1 `src/index.ts` `/sidebar/file`、`src/path-security.ts:1-14,65-76` | Markdown 与 `text/html` 图片不经过本插件 workspace gate，词法规范化后的相对 `..`、绝对盘符/UNC 直接交给上游 `/sidebar/file`；上游仅做 lexical resolve，明确无 realpath/containment。仅打开 notebook（无需执行 cell）即可请求并显示宿主工作区外可读图片，违背 README 的 contained access；当前证据仅覆盖图片读取/请求边界，未发现脚本执行或任意文本回读路径。 | 【已验证】Windows 示例 notebook `C:\workspace\nb\demo.ipynb` 中 `../../outside.png` 生成 `path=C:/outside.png` 的 `/sidebar/file` URL；【契约核对】上游 0.30.1 route 按解析路径流式返回文件。未做真实浏览器外联或任意文件内容 exfil 测试。 | 新增本插件受控图片路由：realpath + workspace 包含校验、流式图片响应、MIME/SVG CSP，并覆盖 `..`、绝对路径、UNC、symlink/junction；仅前端过滤 `..` 不足以封堵。 |

---

## 2. Low（4 项，未修复）

| ID | 平台 | 位置（快照时） | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| L-5 | 全平台 | `lib/notebook.js`（`assertNotebookVersion` 与 `writeNotebook`） | 每次保存仍执行 **2 次全量有界读取 + 2 次 sha256**（32MiB notebook 每次读 64MiB），产生额外 I/O 与哈希成本。M-15 修复后两次读取均已按 cap 有界，不再有无界内存风险。 | 可用 `open`+`fstat` 身份校验（dev/ino/mtime/size）在文件未变化时省掉第二次全量读，同时保持外部写入检测；单纯复用首次 Buffer 会削弱 CAS。 |
| L-12 | 全平台 | `client.js:183-220`（`cleanNode`，递归点 195-201）、`222-233`（`sanitizeHtml`） | HTML 清洗器仍为「unwrap 后递归重启父遍历」实现：O(n²)；规模再大时整段 HTML 输出降级为转义文本。try/catch 只防止异常逃逸，未降低复杂度；真实白名单分支无行为测试（T-1）。【已验证】最小 DOM 替身中 500/1000/2000/4000 个未知兄弟标签约 **17.8/55.5/165.0/653.4ms**，符合二次增长（非浏览器耗时）。 | 改显式栈/游标，从替换位置继续，并设节点/深度预算；用最小 DOM 或 jsdom 补白名单及操作计数回归。 |
| L-13 | POSIX（Windows 不成立） | `lib/env.js:159-206,274-286,42-45` | 探测超时只发 SIGTERM、不升级 SIGKILL：忽略 SIGTERM 的候选（wrapper shell、`SIG_IGN` 的 sitecustomize）使 `execFile` 永不 settle → `discoverInterpreters()` 永久 pending、`inflight` 永不清空、`resetInterpreterCache()` 无效 → `/interpreters`、`/execute`、`/restart` 永久挂起。Windows 上 kill=TerminateProcess，不成立。 | 自行 spawn，超时后 SIGTERM→短宽限→SIGKILL，并等待 close 后 settle；整轮 discovery 加总超时/watchdog。reset 可中止当前 probe，但不能只 `Promise.race` 返回而遗留子进程。 |
| **L-22** | Windows 形态 | `lib/gate.js:91-150`（`walkTarget`）、`214-233`（`KernelPaths`） | 通过 junction 访问 notebook，先删除其目标目录（junction 悬空后 Node 视为 ENOENT）再调用控制端点：控制路径退化为「请求拼写路径」，与内核 canonical 键不一致 → 活内核不可达（`/status` running:false、interrupt 503）。属于**安全失败方向**，不会控制错内核。 | 可不改；若要修，需要显式处理悬空 reparse point 并保留授权时观察到的 identity。 |

---

## 3. Nit（低成本，可批量清理；仅未修复）

- **内核/桥**：restart 窗口内 `is_alive()` 可能误报 kernel_died（宿主单飞提交不可达）；`exec_queue` 无上限（同上）。
- **宿主**：`/interpreters` 冷启动仍同步探测（按设计，无总体超时）。
- **客户端**：`ALLOWED_TAGS` 放行任意 `class`（视觉伪装面；去掉会破坏 pandas 等 HTML 输出样式，需产品决策）；解释器获取失败时 select 仍显示误导文案；执行中编辑态快捷键 Ctrl+Enter/Ctrl+S 静默早退。**Windows 补充**：编辑态 Tab 仍会插入缩进而非移动焦点（Shift+Tab 已支持反缩进；Tab 焦点逃逸属编辑器习惯，建议文档说明）。
- **Windows 环境注意**：内核启动失败时 `lastError` 含 Windows 本地化 `WinError` 文本（跨语言界面文案混杂）；Node v24 在 Windows 上对尾点/尾空格/保留设备名采用**字面语义**（与 cmd/Python 的 Win32 归一化不同），升级 Node/Windows 后需复验，`.ipynb` 判断继续以 realpath 为准。
- **测试/文档**：`bridge_iopub.py` 的 26 个 unittest 在 node 计数中只显示 2 个（计数失真，非假绿）。

---

## 4. 测试缺口（4 项，未完成）

| ID | 位置 | 缺口 | 建议 |
| --- | --- | --- | --- |
| **T-1**（High，测试可信度） | `client.js` 的 `cleanNode`/`sanitizeHtml` vs `test/client.test.mjs` | 白名单清洗器的真实行为测试仍不完整：2026-11-08 新增 `test/client-dom-stub.mjs` 后，`img[src]` 解析、`sanitizeUrl` 图片策略、缺失图片降级与无 DOMParser 降级已有真实 DOM 用例；`cleanNode` 的 DROP_TAGS、属性删除、`javascript:` 链接化、`target+rel` 覆写及 unwrap 主路径仍无覆盖。L-12 藏于此。 | 复用现有最小 DOM stub 补 DROP_TAGS/属性白名单/`a[target][rel]` 断言，以操作计数验证大量未知标签不再反复扫描。 |
| T-3 | `client.js` 的快捷键/工具栏/解释器切换/轮询/autosave | 客户端主交互缺测试：工具栏 interrupt/restart/shutdown、解释器切换（confirm + localStorage）、`visible` 轮询、1.5s autosave 正路径、`onToolbarState` 上报仍无直接覆盖；2026-11-08 已补阅读态窗口快捷键（目标解析/IME/preventDefault/双触发/unmount）。 | 复用现有 mount harness（已 mock timer/localStorage/confirm）补齐其余交互；补 composition（`isComposing`/229）× 5 快捷键、CapsLock `KeyS`、CRLF 渲染的回归。 |
| T-5 | `test/routes.test.mjs`、`test/e2e.test.mjs`、`test/execute-disconnect.test.mjs` 等 | `/execute` 的永不 drain 已有真实 `node:http` + TCP 回归，但其余 HTTP 路径仍主要使用手写 `req/res` 替身；NDJSON 分块、真实 `close`/`writableEnded`、header 大小写及中途 abort 的覆盖仍不完整。 | 扩展真实 socket 端到端测试（`/health`、`/read` 成功/404、`/execute` 流式读取与中途 abort），保留现有慢读/永不 drain 用例。 |
| T-6 | — | 剩余放大/保护/恢复类逻辑缺少回归测试：M-2 的 data 放大与整本预算。M-15 的 stat→read 增长窗口已随修复补齐（首次/第二次版本校验与 stale-stat 端到端均断言 413）。 | 随 M-2 修复补测试。 |

---

## 5. 修复优先级建议（仅未修复项）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P1** | M-2（+T-1） | M-2 序列化放大可造成内存/CPU 资源风险；T-1 仍是安全关键测试可信度问题。 |
| **P2** | M-4、M-6、M-7、M-8、M-17 | 性能、路径与存储加固；其中 M-6 建议按 fd/dirfd 级加固（Windows 上同时覆盖 junction 形态），M-17 需由本插件增加受控图片路由。 |
| **P3** | §2 的 Low（按组批量）、T-3/T-5/T-6、§3 Nit | 低成本、低风险，可合并处理。 |

---

## 6. 平台差异与验证补充

- **Windows 路径形态**：大小写变体、正/反斜杠混合、8.3 短名、盘符相对 `C:foo`、尾点/尾空格、ADS（默认/命名流）、保留设备名（`NUL`/`CON`/`COM1`）、`\\?\`/`\\.\` 前缀、根相对与 UNC 外部路径，实测均**不能**绕过 `.ipynb` 扩展名检查或工作区包含检查（403/404/400 或安全归一化）。长路径（实测 369/405 字符）、中文/emoji/空格文件名正常。这些结论支撑 L-22 的平台语境，不代表相应逻辑已加固。
- **Windows 进程/信号语义**：SIGTERM/SIGKILL 均为 TerminateProcess，二次 kill 升级无意义；当前关闭仍先尝试显式 shutdown 协议，依赖进程退出事件及进程树回收确认清理，不把已发送信号视为成功。
- **Windows 大小写回退边界（2026-11-08 修复 L-23 的已知范围）**：回退仅在 win32 启用、仅对已删除/missing 路径、仅匹配同 session + 同 realpath workspace，且多候选歧义一律 fail-closed；但 Windows per-directory case-sensitive NTFS 下缺失组件无法用 inode 校验，单 live 变体时 case 变体缺失拼写可能命中同 session/workspace 的该内核（无越权，默认 NTFS 不成立）。macOS APFS 默认大小写不敏感，但本回退未覆盖 macOS（原条目平台标注为 Windows 形态）。
- **三平台基线**：历史修复后的测试集为 325 tests，CI 三平台 required 当时全绿；当前 Windows 工作区为 **373 / 329 pass / 44 skip / 0 fail**（skip 为无 symlink 权限与 POSIX 权限位用例）。

---

## 7. 复现与验证索引（仅未修复项）

| 实验 | 位置/命令 | 关键结果 |
| --- | --- | --- |
| 全量测试（快照） | `npm test`（macOS） | 快照时 **292 pass / 0 fail / 0 skipped**（约 23.5s）；历史修复后测试集 325 tests，三平台 CI 当时持续覆盖 |
| 全量测试（当前工作区） | `npm test`（Windows） | **373 tests / 329 pass / 44 skip / 0 fail**（约 19.9s）；包含真实 Python/Jupyter 与真实 TCP 用例 |
| 覆盖率（快照） | `node --experimental-test-coverage --test …` | gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%；client.js 24.7%（vm 沙箱用例未计入） |
| M-2 | 本地受控深度 JSON 故障注入（脚本未随仓库提供） | 42,351 B → 35,435,973 B（837×），RSS +132MiB；独立小用例 9,230 B → 4,549,895 B |
| M-4 | 本地 ANSI/reducer 微基准（脚本未随仓库提供） | 1/2/4/8MiB = 16/57/216/843ms，二次增长 |
| M-6 | 本地按路由调用顺序注入（脚本未随仓库提供）；Windows junction 注入 | macOS：symlink 替换后读泄漏/写越界；Windows：预置 junction 被 403 拒绝，授权后父目录换 junction 可越界读/写 |
| M-7 | better-sidebar 0.30.1 源码（`src/index.ts:730-735`、`src/active-worktree.ts:466`） | 文件树根用 `activeWorktreeRootOf`；Windows 同样 403 |
| M-8 | 本地 rename 钩子注入（脚本未随仓库提供） | save fulfilled、外部编辑丢失 |
| M-17 | 当前 `makeImageResolver` 路径复现 + better-sidebar 0.30.1 源码契约 | `C:\workspace\nb\demo.ipynb` 中 `../../outside.png` 解析为 `C:/outside.png` 并生成 `/sidebar/file` URL；上游明确不做 workspace containment，未声称真实浏览器 exfil 复现 |
| L-12 | 当前源码最小 DOM 替身微基准 | 500/1000/2000/4000 标签约 17.8/55.5/165.0/653.4ms |
| L-22 | Windows 真实 junction 实验 | 悬空 junction 控制路径退化为请求拼写（L-23 大小写拼写回退已修复，2026-11-08） |
| Low 复现 | 本地各领域复现脚本（未随仓库提供） | 见各条【已验证】标注 |

**未核实事项**：① junction 的 Node 可见性存在环境差异（完整访问权限下 `lstat` 视为 symlink、`readlink` 返回目标绝对路径；Low IL 沙箱会话中不可见，`readlink→EINVAL`）——安全结论不依赖该差异，但 M-6 修复不建议依赖 `lstat/readlink` 识别 reparse point；② 无真实浏览器 headless（L-12 的浏览器栈/渲染耗时、L-16 修复后的真实浏览器图片加载与远程外联、L-15/L-24 的浏览器表现未做视觉复核）；③ linked worktree 未在真实 DSH 会话端到端复现；④ UNC 作为 workspace、icacls 拒绝、AV/索引器锁导致的 `.tmp` 残留、64MiB 读峰值未逐项实测；⑤ better-sidebar 0.28.x + DSH 0.2.1 组合未安装验证；⑥ DSH 宿主是否给插件 viewer 包 error boundary 未确认（影响 L-12 的影响范围）；⑦ DSH host 日志缺失，无法确认插件 boot 后的运行期错误。
