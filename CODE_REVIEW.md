# dsh-bsb-ipynb 代码审核报告（macOS 快照，仅未修复项）

> **审核快照**：2026-11-07，macOS APFS。**本文件只保留仍未修复或只修复了一部分的问题**；已经完全修复的条目已从本文件删除，修复记录与回归测试见 `git log`（2026-11-07 的系列提交）与 `test/`。
> **环境（快照时）**：macOS APFS；Node v24.13.1；Python 3.14.7（jupyter_client 8.10 / ipykernel 7.3 / nbformat 5.11）；DSH Desktop 0.2.2-rc.1；dsh-better-sidebar 0.30.1。
> **验证依据（快照时）**：`npm test` 292 pass / 0 fail / 0 skipped（约 23.5s）；行覆盖 gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%；client.js 24.7%（仅作风险信号）。修复后测试集扩到 317 tests，并由三平台 CI（ubuntu/windows/macos）覆盖。
> **证据等级**：【已验证】= 可重跑脚本或确定性路径复现；【契约核对】= 对照 DSH/better-sidebar/上游源码；【推测】= 仅代码推理。
> **行号说明**：`file:line` 为快照时的源码行号；多轮修复后行号已变化，按函数名/ID 检索更可靠。Windows 侧复核见 [CODE_REVIEW_WINDOWS.md](CODE_REVIEW_WINDOWS.md)。

**问题总览（仅未修复）**

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| Medium | 9 | 序列化放大、渲染 O(n²)、TOCTOU、worktree、rename 竞态、主题、坏帧、shutdown 宽限、迟到 status |
| Low | 11 | 保存 I/O、路径 oracle、硬链接别名、清洗器复杂度、探测超时、banner/HTML 输出/快捷键等 |
| Nit | 约 4 类 | 存储、内核/桥、宿主、客户端、测试/文档的低成本清理 |
| 测试缺口 | 5 项 | T-1（High 级测试可信度）、T-3、T-5、T-6、T-8 |

---

## 1. Medium（9 项，未修复）

| ID | 位置（快照时） | 问题与影响 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| **M-2**（P1） | `lib/notebook.js:38-73`（限制）、`107-120`（data/attachments 原样保留）、`253-268`（serialize）、`384-408`（先序列化后查 32MiB） | metadata 的 100 层/10,000 节点限制**只覆盖 metadata 对象**：`execute_result/display_data.data[application/*+json]`、`attachments[...]` 中同样会被 pretty-print 的 JSON 值完全不受限，且限制是「每对象」而非整本预算；32MiB 上限仍在 `JSON.stringify` 之后检查。小输入可造成显著内存/CPU 放大（DoS 面），多 cell 或并发保存可进一步放大；客户端保存预检也同步 pretty-stringify 整本 notebook（见 L-20）。RangeError→413 只改善错误分类，不构成分配上限。 | 【已验证】depth=4200 的合法 notebook：compact 42,351 B、read ok，pretty 35,435,973 B（约 **837×**），RSS +132MiB，随后才 413；另有 9,230 B → 4,549,895 B（约 493×）独立复现。 | ① 对 data/attachments 的 JSON 值同样应用 depth/node 限制，并设整本节点/字节预算；② 把 32MiB 做成**有界序列化预算**，超限即中止；③ 客户端预检按 revision 缓存测量结果（见 L-20）。 |
| **M-4**（P2） | `client.js:1135-1188`（`OutputView` 未 memo）、`1042-1126`（`reduceOutputs` 流合并）、`1339`（逐 output 渲染） | 大输出渲染 O(n²)：每次流事件产生新 outputs 数组 → 整 cell 重渲；`OutputView` 未按 output 对象缓存，`ansiToHtml`/`sanitizeHtml`/markdown 全文重算；流合并每次 `last.text + chunk` 全量复制；高频 NDJSON 事件无 rAF/短窗口合并。大日志可造成明显 UI 卡顿；真实浏览器布局成本未测量。 | 【已验证】16KiB/chunk reducer + ANSI 微基准 1/2/4/8MiB = **16/57/216/843ms**（≈4×/倍），不含真实 React/DOM。 | memo 未变化 output；高频事件按 rAF/短窗口合并；保留 ANSI 增量状态或分块渲染；保留现有精确字节预算测试。 |
| **M-6**（P2） | `lib/gate.js:64-85,152-185,273-279`；`lib/notebook.js:308-330`（读）、`410-447`（存） | 路径授权（realpath 检查）与真正的文件 I/O 是两次独立解析，无 fd/inode 绑定：授权后把目标替换为指向工作区外的 symlink → 越界读；把父目录替换为指向外部的 symlink 且外部内容匹配 baseVersion → 越界写。二次版本校验不缓解（两次 readFile 沿 symlink 读到同一外部内容）。前提是竞争者能并发修改工作区目录项，纯 HTTP 请求本身不能制造 symlink。Windows 上可用无需特权的 junction 复现（见 Windows 报告 W-B1）。 | 【已验证】按 route 相同调用顺序确定性替换：读得到外部内容、写成功写出局外文件。 | 读取将授权、打开、fstat 身份核验和有界读取绑定到同一 fd，并逐组件防跟随；写入绑定父目录身份并使用 dirfd/openat 等价能力，至少在 temp-write/rename 前重验 realpath/dev/ino。仅再做一次字符串 realpath 不能根治。 |
| **M-7**（P2） | `lib/gate.js:16-53` | 工作区根只认 `ctx.get('workingDirectory').get(session)` / `session.header.cwd`，**不跟随 better-sidebar 的活动根**：文件树根是 `activeWorktreeRootOf(...)`（会采纳 linked git worktree，可能在会话 cwd 之外）。会话活动根为 linked worktree 时，`/ipynb/read`、`/ipynb/save`、`/ipynb/execute`、`/ipynb/status` 全部 403，核心功能不可用。 | 【契约核对】better-sidebar 0.30.1：`src/index.ts:730-735`、`src/active-worktree.ts:466`；文件 viewer 收到绝对路径后本插件原样提交（`client.js:621,1586,1835`）。未在真实 worktree 会话端到端复现。 | 引入与 better-sidebar 对齐的「活动根集合」（主根 + 关联 worktree realpath，realpath 落在任一候选根内即允许）。 |
| **M-8**（P2） | `lib/notebook.js:364-382,432-447`；`README.md`（保存可靠性一节） | 保存的 CAS 只在 `readFile→sha256→比较` 时检测冲突；第二次 `assertNotebookVersion` 返回后到 rename 之间仍有窗口：外部写者在窗口内写入会被静默覆盖，API 仍返回成功。README 已声明该竞态，但声明不能避免数据丢失。 | 【已验证】在 rename 钩子注入外部写：save fulfilled、`externalEditLost=true`，最终只有 PLUGIN_SAVE。 | 若必须提供强一致，使用覆盖读取—写入—提交的跨进程锁或支持 CAS 的提交协议，并保留冲突副本；rename 前核对 dev/ino、mtime、size 只能收窄窗口，单纯再加 hash 不能根治。 |
| **M-9**（P2） | `client.js:2194-2412`（基础 token 与硬编码状态/语法色） | 只有 4 个基础色使用 `--dsw-alias-*` token，语法高亮、内核状态点、保存失败/错误、banner、stderr 仍硬编码，自定义皮肤无法完整覆盖这些颜色。 | 【契约核对】当前 Theme provider 暴露 `--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary` 等语义 token；【已验证】硬编码色未 token 化，未做真实浏览器视觉/对比度复验。 | 状态和语法色逐步消费宿主语义 token/Shiki 变量，并补 DSH dark/light × OS 相反组合的计算样式/对比度测试。 |
| **M-10**（P2） | `lib/kernel.js:363-375`（坏帧处理）、`304-311`（终态）、`441-499`（busy/run） | 非 JSON 帧只更新 lastError，合法 JSON 但缺 type 直接 return；两者都不 failRun/kill。若损坏的是唯一 execute_reply，currentRun 无执行 watchdog 将一直 pending，后续执行持续 kernel-busy。 | 【已验证】活动 run 收到 `NOT-JSON` 后为 `settled=false、busy=true、ready=true、kills=[]`，只有人为补正常 reply 才释放；`test/kernel-lifecycle.test.mjs` 只测重启期间保留旧错误。 | stdout 严格协议错误应 failRun 并杀死/重启 bridge；校验事件 shape 及执行事件 cell_id/exec_id；覆盖 starting/idle/running 的坏 JSON、非对象、缺 type/缺 ID。 |
| **M-11**（P2） | `lib/kernel.js:564-616`（shutdown/kill）、`738-743`（manager 删除）、`757-766`（dispose） | shutdown 2s 时才由 kill 发 SIGTERM，kill 再隔 2s 才 SIGKILL（总计约 4s），外层 grace 却在 2.5s 结束；随后 manager 无条件删条目，disposeAll 更提前 clear。若 SIGTERM 清理卡住，管理器已显示无内核并允许替代启动，旧 bridge 仍活。Windows 上 SIGTERM/SIGKILL 均为 TerminateProcess，二次升级无意义（代码已注明）。 | 【已验证】受控不退出 child：约 **2502ms** 返回时 `managerKnowsEntry=false、processAlive=true、kills=['SIGTERM']`。 | 等待 exit 覆盖完整 SIGKILL 升级；未确认退出前保留 stopping entry 并报告失败，不能当作已回收；测试忽略 SIGTERM、2.5s 不遗忘/不重复启动、SIGKILL+exit 后才删除。 |
| **M-12**（P2） | `client.js:1669-1676,1726-1736`（GET/轮询）、`1795-1833`（流式终态）、`1963-1970`（shutdown） | 初始或轮询 `/status` 在内核死亡/shutdown 前发出、之后到达时，refreshKernel 无 document generation、kernel epoch 或请求序号检查，直接 setKernel；旧 `{running:true,busy:true}` 可覆盖 death/reply 的终态。visible=false 停止后续轮询时错误状态可持续。影响 UI/按钮状态，不是服务器内核真的复活。 | 【已验证】生命周期 harness：先提交 kernel_died 和失败 reply（running:false），再交付旧 running/busy 响应，最终工具栏变回 running:true、busy:true。现有迟到 NDJSON 测试不覆盖 GET。 | 增加 kernel epoch/request id；run 开始、status/reply/death、restart/shutdown、adopt 时推进 epoch，只接受当前代次的最新响应，必要时 abort 旧 GET；补 death/shutdown/reload 后迟到响应用例。 |

---

## 2. Low（11 项，未修复）

### (a) 存储与路径（`lib/notebook.js`、`lib/gate.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-5 | `lib/notebook.js:364-382,410-444`（快照时；当前在 `assertNotebookVersion` 与 `writeNotebook`） | 每次保存仍执行 **2 次全量 `readFile` + 2 次 sha256**（32MiB notebook 每次读 64MiB）。两次读取现已加 32MiB 上限，不会再把 GB 级文件整体缓冲（原风险已消除），剩余为 2× I/O 与哈希成本。 | 复用首次读取的 Buffer 比较；或改 `open`+`fstat` 身份校验以省掉一次读取。 |
| L-9 | `lib/gate.js:64-85` | 工作区外路径的存在性/可访问性 oracle：存在→403、不存在→404、EACCES→404+reason，同用户 API 可据此探测任意路径。 | 统一为不可区分错误，或接受并文档化。 |
| L-10 | `lib/notebook.js:495`（`saveQueues`） | `saveQueues` 只按 canonical 路径字符串串行化：同一 inode 的硬链接别名并发保存**两个都成功**，违反 README 声明的「同一 notebook 并发保存只有第一个成功」。Windows 侧同（见 W-B5）。 | 按 dev/ino 串行化；或文档声明该边界。 |

### (b) 客户端（`client.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-12 | `client.js:183-220`（`cleanNode`，递归点 195-201）、`222-233`（`sanitizeHtml`） | HTML 清洗器仍为「unwrap 后递归重启父遍历」实现：O(n²)；规模再大时整段 HTML 输出降级为转义文本。try/catch 只防止异常逃逸，未降低复杂度；真实白名单分支无行为测试（T-1）。 | 改显式栈/游标，从替换位置继续，并设节点/深度预算；用最小 DOM 或 jsdom 补白名单及操作计数回归。 |
| L-15 | `client.js` 多处 `setBanner(...)`（快照 `1395-1409,1422-1432,2428-2444`） | 语言热切换不覆盖已存入 state 的 banner 文案：冲突/保存失败/容量/内核重启等 banner 在事件发生时翻译后保存，切换语言后不重译（渲染期 `t()` 的静态文案会更新）。 | banner 存 `{key, params, kind, action}`，渲染时再 `t(key)`；可保留 text fallback，先迁移 conflict，再覆盖 capacity/kernel。 |
| L-16 | `client.js:1151-1157`（当前 `OutputView` 的 `text/html` 分支） | HTML 输出中的图片处理残留：`<img src="attachment:x">`/相对路径经清洗保留但不经 `resolveImage` → 必然裂图（只有 Markdown 路径会解析）。 | HTML 输出也走 `resolveImage` 改写 `img[src]`；README 声明远程图片行为。 |
| L-18 | `client.js:1069,1594-1611` | `metadata-too-complex` 阻塞**没有可用的恢复入口**：preflight 失败后 `capacityBlocked=true`、自动保存暂停，banner 只有文字、无 action，文案让用户「减少嵌套/条目」但 UI 没有编辑 metadata 的入口。该状态可由内核输出 metadata 触发（`1024` 将 IOPub `event.metadata` 原样并入 output.metadata），之后所有编辑都无法落盘；唯一出路是逐 cell 的隐藏「清空输出」按钮或 reload 丢弃草稿。 | 按来源给 action：output metadata 超限给「清空全部输出」，否则给「重新加载」；或在合并 IOPub metadata 时丢弃超限项（服务端保存同样会 400）。 |
| L-19 | `client.js:745-751,1596,1740-1743` | 容量阻塞只在「成功 preflight / 清空输出 / 重跑 / reload」时解除；用户通过编辑把 notebook 缩回 32MiB 内（删 cell/删源码）后 **autosave 不会恢复**（编辑不重跑 preflight），必须手动保存；README 未说明该恢复路径，现有测试把「编辑不重启 autosave」固化为预期。 | 结构性编辑（删 cell/切类型/清输出/插入）时清 `capacityBlocked` 并允许一次 preflight 重试；或 README 明确「缩小后需手动保存一次」。 |
| L-20 | `client.js:901-914` | 保存预检成本：每次保存（含 1.5s autosave 触发的每次）同步执行 `normalizeNotebook` + pretty `JSON.stringify` + `TextEncoder.encode` 整本 notebook，随后请求再 compact stringify 一次。Node 实测 31MiB 单流 45ms、20MB/50 万行源码 148ms；浏览器通常再慢 2–4×；每次瞬时分配约 2–3× notebook。 | 按 revision/结构指纹缓存上次测量值，仅改动可能影响大小时重算；或 README 注明大文件保存开销。 |
| L-21 | `client.js:1218-1237` | 快捷键只在编辑 textarea 的 `onKeyDown` 生效（无全局监听，`window.addEventListener` 全文为 0）；阅读态按 Ctrl/Cmd+Enter、Ctrl/Cmd+S 无效（README 已注明快捷键仅在编辑态生效）。 | 加全局监听，编辑态复用现有逻辑；可接入 DSH shortcuts。 |

### (c) 解释器发现（`lib/env.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-13 | `lib/env.js:159-206,274-286,42-45` | 探测超时只发 SIGTERM、不升级 SIGKILL：忽略 SIGTERM 的候选（wrapper shell、`SIG_IGN` 的 sitecustomize）使 `execFile` 永不 settle → `discoverInterpreters()` 永久 pending、`inflight` 永不清空、`resetInterpreterCache()` 无效 → `/interpreters`、`/execute`、`/restart` 永久挂起。Windows 上不成立（kill=TerminateProcess），POSIX 仍成立。 | 自行 spawn，超时后 SIGTERM→短宽限→SIGKILL，并等待 close 后 settle；整轮 discovery 加总超时/watchdog。reset 可中止当前 probe，但不能只 `Promise.race` 返回而遗留子进程。 |

---

## 3. Nit（低成本，可批量清理；仅未修复）

- **存储**：metadata 循环引用抛 `TypeError` → 500（而超限是 400；HTTP JSON 不可达）；`DSH_IPYNB_KERNEL_IDLE_MS=0` 不能禁用回收。
- **内核/桥**：restart 窗口内 `is_alive()` 可能误报 kernel_died（宿主单飞提交不可达）；`exec_queue` 无上限（同上）；协议/文档漂移：`status`/`status_reply` 无调用方、`--kernel-name` 宿主从不传、ready 的 `language_info` 恒 `{}`、`emit()` 吞 stdout 写失败、成功 `execute_reply` 恒带 `error:null`、control `interrupt_reply` 从不消费。
- **宿主**：dispose 晚到清理重复调用一次 `shutdown()`（无害；真实流上二次写已 end 的 stdin 会 `ERR_STREAM_WRITE_AFTER_END`）；`index.js` 的 `disposeAll()` 未 await；fence 抛异常时每请求打印完整 stack（持续故障期刷屏）；`/interpreters` 冷启动仍同步探测（按设计，无总体超时）。
- **客户端**：`image/jpg` 未归一化为 `image/jpeg`；空 `text/html` 吞掉 `text/plain` 回退；`application/json` 顶层字符串显示裸文本；fence 语言串 `replace(/[^\w-]/g,'')` 丢 `c++`/`c#`；`source.split(/(?<=\n)/)` lookbehind（旧 Safari 解析风险）；`ALLOWED_TAGS` 放行任意 `class`（视觉伪装面）；`application/json` 输出 `JSON.stringify` 无深度保护；解释器获取失败时 select 仍显示误导文案；执行中编辑态快捷键 Ctrl+Enter/Ctrl+S 静默早退。
- **测试/文档**：`routes.test.mjs` 的 root 跳过条件未在 README 说明；少量弱断言/同义反复（注册 dict 与自身比 key；`/health` 只 `typeof`；未绑定 target；用默认值断言默认值）；真实内核测试用固定 `sleep`（有 `within()` 兜底）；`bridge_iopub.py` 的 26 个 unittest 在 node 计数中只显示 2 个（非假绿，计数失真）；locale meta `title` 直接用包名。

---

## 4. 测试缺口（5 项，未完成）

| ID | 位置 | 缺口 | 建议 |
| --- | --- | --- | --- |
| **T-1**（High，测试可信度） | `client.js` 的 `cleanNode`/`sanitizeHtml` vs `test/client.test.mjs` | DOMParser 白名单清洗器**零真实行为测试**：现有用例只覆盖无 DOMParser/抛错 fallback 和 ALLOWED_ATTRS 集合；`cleanNode` 的 DROP_TAGS、属性删除、`javascript:` 链接化、`target+rel` 覆写及 unwrap 主路径无覆盖。L-12 正藏于此。 | 最小 DOM 替身（或 devDependency jsdom）驱动 `sanitizeHtml` 真实分支，断言 DROP_TAGS/属性白名单/`sanitizeUrl`/`a[target][rel]`；以操作计数验证大量未知标签不再反复扫描。 |
| T-3 | `client.js` 的快捷键/工具栏/解释器切换/轮询/autosave | 客户端主交互缺测试：工具栏 interrupt/restart/shutdown、解释器切换（confirm + localStorage）、`visible` 轮询、1.5s autosave 正路径、`onToolbarState` 上报；IME/CapsLock 目前只有纯函数级测试，无真实键盘事件路径。 | 复用现有 mount harness（已 mock timer/localStorage/confirm）补齐；补 composition（`isComposing`/229）× 5 快捷键、CapsLock `KeyS`、CRLF 渲染的回归。 |
| T-5 | `test/routes.test.mjs`、`test/e2e.test.mjs`、`test/execute-disconnect.test.mjs` 等 | HTTP 层全部用手写 `req/res` 替身，无真实 socket：NDJSON 分块、真实 `res.write` 背压/drain、真实 `close`/`writableEnded` 语义、header 大小写等只有假设。 | 加一个 `node:http` + fetch 端到端测试（`/health`、`/read` 成功/404、`/execute` 流式读取与中途 abort），并覆盖慢读/永不 drain。 |
| T-6 | — | 剩余放大/保护/恢复类逻辑缺少回归测试：M-2 的 data 放大与整本预算、L-19 的容量阻塞自动恢复、L-20 的预检缓存。 | 随对应修复一起补测试。 |
| T-8 | `lib/kernel.js`、`client.js`、`test/bridge_iopub.py` | 剩余失败/竞态路径缺回归：M-10 活动 run 坏协议帧、M-11 忽略 SIGTERM 的 shutdown（真实内核）、M-12 迟到 GET `/status`。 | 注入坏帧、不退出 child 和 deferred GET，断言有界终态、进程回收及旧响应被忽略。 |

---

## 5. 修复优先级建议（仅未修复项）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P1** | M-2（+T-1） | 序列化放大（DoS 面），可用小输入放大数百倍；T-1 是安全关键测试可信度问题。 |
| **P2** | M-4、M-6、M-7、M-8、M-9、M-10、M-11、M-12 | 性能、失败终止、状态竞态与设计级加固；其中 M-6 建议与 Windows W-B1 一起做 fd/dirfd 级加固。 |
| **P3** | §2 的 Low（按组批量）、T-3/T-5/T-6/T-8、§3 Nit | 低成本、低风险，可合并处理。 |

---

## 6. 复现与验证索引（仅未修复项相关的历史证据）

| 实验 | 位置/命令 | 关键结果 |
| --- | --- | --- |
| 全量测试（快照） | `npm test` | 快照时 **292 pass / 0 fail / 0 skipped**（约 23.5s）；修复后测试集 317 tests，三平台 CI 持续覆盖（macOS 314 pass / 0 fail / 3 skip） |
| 覆盖率（快照） | `node --experimental-test-coverage --test …` | gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%；client.js 24.7%（vm 沙箱用例未计入） |
| M-2 | 本地受控深度 JSON 故障注入（脚本未随仓库提供） | 42,351 B → 35,435,973 B（837×），RSS +132MiB；独立小用例 9,230 B → 4,549,895 B |
| M-4 | 本地 ANSI/reducer 微基准（脚本未随仓库提供） | 1/2/4/8MiB = 16/57/216/843ms，二次增长 |
| M-6 | 本地按路由调用顺序注入（脚本未随仓库提供） | symlink 替换后读泄漏 / 写越界；Windows 侧 junction 形态见 Windows 报告 W-B1 |
| M-7 | better-sidebar 0.30.1 源码（`src/index.ts:730-735`、`src/active-worktree.ts:466`） | 文件树根用 `activeWorktreeRootOf` |
| M-8 | 本地 rename 钩子注入（脚本未随仓库提供） | save fulfilled、外部编辑丢失 |
| M-9 | 当前 Theme provider + `test/client.test.mjs` | 硬编码色未 token 化；未做视觉/对比度复验 |
| M-10～M-12 | 本地受控 child、不退出 child、deferred GET 注入（脚本未随仓库提供） | 活动 run 永久 busy；2502ms 返回时进程仍活且条目已遗忘；旧 status 覆盖 death |
| L-12 | 当前源码最小 DOM 替身微基准 | 500/1000/2000/4000 标签约 17.8/55.5/165.0/653.4ms |
| Low 复现 | 本地各领域复现脚本（未随仓库提供） | 见各条【已验证】标注 |

**未核实事项**：无真实浏览器 headless（L-12 的浏览器栈/渲染耗时、M-9 的视觉对比度、HTML 输出裂图/外联未做视觉复核）；linked worktree 未在真实 DSH 会话端到端复现；better-sidebar 0.28.x + DSH 0.2.1 组合未安装验证；DSH 宿主是否给插件 viewer 包 error boundary 未确认（影响 L-12 的影响范围）。Windows 侧复核见 [CODE_REVIEW_WINDOWS.md](CODE_REVIEW_WINDOWS.md)。
