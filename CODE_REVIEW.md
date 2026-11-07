# dsh-bsb-ipynb 代码审核报告（快照）

> **审核快照**：本文件记录 2026-11-07 的代码审查结果。部分问题已在后续提交中修复；保留下来的条目为截至快照时仍存在或尚未验证的问题。正文中的 `file:line` 以快照时的源码为准。审查期的复现脚本是本地临时文件，未随仓库提供。

- **审核对象**：本仓库（`dsh-bsb-ipynb`），快照基线为 2026-11-07 的工作树（之后另有修复）。
- **环境**：macOS APFS；Node v24.13.1；Python 3.14.7（jupyter_client 8.10 / ipykernel 7.3 / nbformat 5.11）；DSH Desktop 0.2.2-rc.1；dsh-better-sidebar 0.30.1。
- **验证依据**：快照时本机实测 `npm test` **292 pass / 0 fail / 0 skipped**（约 23.5s）；行覆盖 gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%；client.js 24.7%（动态加载与 vm 沙箱用例未计入，仅作风险信号）；静态检查、`npm pack --dry-run`（18 文件，含 `examples/demo.ipynb`）、README 数字/错误码/路由核对均通过。
- **方式**：按 6 个领域（宿主 HTTP/内核、存储/路径/env、客户端渲染、客户端状态机、Python 桥、测试/文档）逐文件审查，关键结论均给出 `file:line`、触发条件与可重跑证据；本报告只列举截至快照时仍存在的问题或测试缺口。
- **证据等级**：【已验证】= 可重跑脚本或确定性路径复现；【契约核对】= 对照 DSH 0.2.2-rc.1 asar 运行时、dsh-better-sidebar 0.30.1 源码/类型、npm registry 或上游仓库；【推测】= 仅代码推理。

**问题总览**

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| Medium | 11 | 2 项建议 P1（小文件内存放大 / 无自愈挂起），其余为设计级加固 |
| Low | 21 | 边界、资源上限、恢复路径，可按领域批量处理 |
| Nit | 约 15 类 | 低成本清理 |
| 测试缺口 | 8 项 | 含 1 项 High 级测试可信度问题（安全关键的 HTML 清洗分支零行为测试） |

---

## 1. Medium（11 项）

| ID | 位置（快照时的源码） | 问题与影响 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| **M-2**（P1） | `lib/notebook.js:38-73`（限制）、`107-120`（data/attachments 原样保留）、`253-268`（serialize）、`384-408`（先序列化后查 32MiB） | metadata 的 100 层/10,000 节点限制**只覆盖 metadata 对象**：`execute_result/display_data.data[application/*+json]`、`attachments[...]` 中同样会被 pretty-print 的 JSON 值完全不受限，且限制是「每对象」而非整本预算；32MiB 上限仍在 `JSON.stringify` 之后检查。小输入可造成显著内存/CPU 放大（DoS 面），多 cell 或并发保存可进一步放大；客户端保存预检也同步 pretty-stringify 整本 notebook（见 L-20）。RangeError→413 只改善错误分类，不构成分配上限。 | 【已验证】depth=4200 的合法 notebook：compact 42,351 B、read ok，pretty 35,435,973 B（约 **837×**），RSS +132MiB，随后才 413；另有 9,230 B → 4,549,895 B（约 493×）独立复现。 | ① 对 data/attachments 的 JSON 值同样应用 depth/node 限制，并设整本节点/字节预算；② 把 32MiB 做成**有界序列化预算**，超限即中止；③ 客户端预检按 revision 缓存测量结果（见 L-20）。 |
| **M-3**（P1） | `python/bridge.py:617-654`（失败分支 625-650）、`418-450`（iopub 泵）、`303-314`（execute）、`lib/kernel.js:151-164` | `restart_once()` 重启前无条件 `stop_channels()` 旧 client，**失败路径不回滚、也不拆新内核**。若新内核已启动但 `start_channels`/`wait_for_ready(25)` 失败，`self.kc` 仍指向 socket=None 的旧 client；`iopub_loop` 因新 km 存活而持续 `AssertionError` → **无退避忙等**，后续 execute 失败，且**不发 `kernel_died`/ready**，宿主只能等 30s ready 超时。follower 静默 return、`command_loop` 忽略返回值也造成失败零回执。 | 【已验证】真实内核故障注入：旧 socket=None、新内核存活，IOPub 调用约 **14,963 次/秒**，事件只有 log、无 kernel_died。`test/bridge_iopub.py:336-343` 目前反而断言失败后保留旧 client。 | 失败路径统一停止新 client、关闭当前 km、清 `self.kc/pending`，立即发不带 exec_id 的 `kernel_died`；IOPub 连续异常加退避和有界失败；command_loop 检查 restart 返回值，并纠正上述测试预期。 |
| **M-4**（P2） | `client.js:1135-1188`（`OutputView` 未 memo）、`1042-1126`（`reduceOutputs` 流合并）、`1339`（逐 output 渲染） | 大输出渲染 O(n²)：每次流事件产生新 outputs 数组 → 整 cell 重渲；`OutputView` 未按 output 对象缓存，`ansiToHtml`/`sanitizeHtml`/markdown 全文重算；流合并每次 `last.text + chunk` 全量复制；高频 NDJSON 事件无 rAF/短窗口合并。大日志可造成明显 UI 卡顿；真实浏览器布局成本未测量。 | 【已验证】16KiB/chunk reducer + ANSI 微基准 1/2/4/8MiB = **16/57/216/843ms**（≈4×/倍），不含真实 React/DOM。 | memo 未变化 output；高频事件按 rAF/短窗口合并；保留 ANSI 增量状态或分块渲染，仅 memo 正在增长的 output 不足以消除渐近成本；保留现有精确字节预算测试。 |
| **M-5**（P2） | `python/bridge.py:657-692`（`command_loop` 同步调用 `restart`）、`617-654`（`wait_for_ready(25)`）；`lib/kernel.js:564-616`（宿主关闭宽限） | restart 在 **command_loop 线程内同步阻塞**（最长 25s）：期间 stdin 上的 execute/interrupt/shutdown 全部排队不读；宿主 shutdown 只能依赖信号升级，控制面失去响应。 | 【已验证】受控 3s 慢重启：ready 延迟 3.336s、后续 execute_reply 延迟 3.473s；shutdown 写入 2s 后仍未处理，SIGTERM 后才退出。 | restart 移出 command_loop（单控制 worker / 异步任务），保持 status/interrupt/shutdown 响应，并明确重启期间 execute 的拒绝或排队语义。 |
| **M-6**（P2） | `lib/gate.js:64-85,152-185,273-279`；`lib/notebook.js:308-330`（读）、`410-447`（存） | 路径授权（realpath 检查）与真正的文件 I/O 是两次独立解析，无 fd/inode 绑定：授权后把目标替换为指向工作区外的 symlink → 越界读；把父目录替换为指向外部的 symlink 且外部内容匹配 baseVersion → 越界写。二次版本校验不缓解（两次 readFile 沿 symlink 读到同一外部内容）。前提是竞争者能并发修改工作区目录项，纯 HTTP 请求本身不能制造 symlink。 | 【已验证】按 route 相同调用顺序确定性替换：读得到外部内容、写成功写出局外文件。 | 读取将授权、打开、fstat 身份核验和有界读取绑定到同一 fd，并逐组件防跟随；写入绑定父目录身份并使用 dirfd/openat 等价能力，至少在 temp-write/rename 前重验 realpath/dev/ino。仅再做一次字符串 realpath 不能根治。 |
| **M-7**（P2） | `lib/gate.js:16-53` | 工作区根只认 `ctx.get('workingDirectory').get(session)` / `session.header.cwd`，**不跟随 better-sidebar 的活动根**：文件树根是 `activeWorktreeRootOf(ctx, sessionId, sessionCwdOf(...))`（会采纳 linked git worktree，可能在会话 cwd 之外）。会话活动根为 linked worktree 时，`/ipynb/read`、`/ipynb/save`、`/ipynb/execute`、`/ipynb/status` 全部 403，核心功能不可用。 | 【契约核对】better-sidebar 0.30.1：`src/index.ts:730-735`、`src/active-worktree.ts:466`；文件 viewer 收到绝对路径后本插件原样提交（`client.js:621,1586,1835`）。未在真实 worktree 会话端到端复现。 | 引入与 better-sidebar 对齐的「活动根集合」（主根 + 关联 worktree realpath，realpath 落在任一候选根内即允许）。 |
| **M-8**（P2） | `lib/notebook.js:364-382,432-447`；`README.md`（保存可靠性一节） | 保存的 CAS 只在 `readFile→sha256→比较` 时检测冲突；第二次 `assertNotebookVersion` 返回后到 rename 之间仍有窗口：外部写者在窗口内写入会被静默覆盖，API 仍返回成功。README 已声明该竞态，但声明不能避免数据丢失。 | 【已验证】在 rename 钩子注入外部写：save fulfilled、`externalEditLost=true`，最终只有 PLUGIN_SAVE。 | 若必须提供强一致，使用覆盖读取—写入—提交的跨进程锁或支持 CAS 的提交协议，并保留冲突副本；rename 前核对 dev/ino、mtime、size 只能收窄窗口，单纯再加 hash 不能根治。 |
| **M-9**（P2） | `client.js:2194-2412`（基础 token 与硬编码状态/语法色） | 只有 4 个基础色使用 `--dsw-alias-*` token，语法高亮、内核状态点、保存失败/错误、banner、stderr 仍硬编码，自定义皮肤无法完整覆盖这些颜色。 | 【契约核对】当前 Theme provider 暴露 `--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary` 等语义 token；【已验证】硬编码色未 token 化，未做真实浏览器视觉/对比度复验。 | 状态和语法色逐步消费宿主语义 token/Shiki 变量，并补 DSH dark/light × OS 相反组合的计算样式/对比度测试。 |
| **M-10**（P2） | `lib/kernel.js:363-375`（坏帧处理）、`304-311`（终态）、`441-499`（busy/run） | 非 JSON 帧只更新 lastError，合法 JSON 但缺 type 直接 return；两者都不 failRun/kill。若损坏的是唯一 execute_reply，currentRun 无执行 watchdog 将一直 pending，后续执行持续 kernel-busy。 | 【已验证】活动 run 收到 `NOT-JSON` 后为 `settled=false、busy=true、ready=true、kills=[]`，只有人为补正常 reply 才释放；`test/kernel-lifecycle.test.mjs:743-753` 只测重启期间保留旧错误。 | stdout 严格协议错误应 failRun 并杀死/重启 bridge；校验事件 shape 及执行事件 cell_id/exec_id；覆盖 starting/idle/running 的坏 JSON、非对象、缺 type/缺 ID。 |
| **M-11**（P2） | `lib/kernel.js:564-616`（shutdown/kill）、`738-743`（manager 删除）、`757-766`（dispose） | shutdown 2s 时才由 kill 发 SIGTERM，kill 再隔 2s 才 SIGKILL（总计约 4s），外层 grace 却在 2.5s 结束；随后 manager 无条件删条目，disposeAll 更提前 clear。若 SIGTERM 清理卡住，管理器已显示无内核并允许替代启动，旧 bridge 仍活。 | 【已验证】受控不退出 child：约 **2502ms** 返回时 `managerKnowsEntry=false、processAlive=true、kills=['SIGTERM']`。 | 等待 exit 覆盖完整 SIGKILL 升级；未确认退出前保留 stopping entry 并报告失败，不能当作已回收；测试忽略 SIGTERM、2.5s 不遗忘/不重复启动、SIGKILL+exit 后才删除。 |
| **M-12**（P2） | `client.js:1669-1676,1726-1736`（GET/轮询）、`1795-1833`（流式终态）、`1963-1970`（shutdown） | 初始或轮询 `/status` 在内核死亡/shutdown 前发出、之后到达时，refreshKernel 无 document generation、kernel epoch 或请求序号检查，直接 setKernel；旧 `{running:true,busy:true}` 可覆盖 death/reply 的终态。visible=false 停止后续轮询时错误状态可持续。影响 UI/按钮状态，不是服务器内核真的复活。 | 【已验证】生命周期 harness：先提交 kernel_died 和失败 reply（running:false），再交付旧 running/busy 响应，最终工具栏变回 running:true、busy:true。现有迟到 NDJSON 测试不覆盖 GET。 | 增加 kernel epoch/request id；run 开始、status/reply/death、restart/shutdown、adopt 时推进 epoch，只接受当前代次的最新响应，必要时 abort 旧 GET；补 death/shutdown/reload 后迟到响应用例。 |

---

## 2. Low（21 项）

### (a) 内核与 HTTP（`lib/kernel.js`、`lib/routes.js`、`python/bridge.py`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-1 | `lib/routes.js:306-327` | `/execute` 的 `end()` 遇背压只注册 `res.once('drain', end)`、无超时兜底；客户端不读取（半开/冻结连接）时响应永不结束，socket 与闭包长期占用（内核已 idle）。【已验证】事件替身：永不 drain → 600ms 后未 end、无存活 Timeout。 | drain 等待加有界超时（如 10s），超时清队列并 destroy/end。 |
| L-2 | `lib/gate.js:152-185,214-233`；消费方 `lib/routes.js:193,222,374,389,411` | 控制/执行端点固定 `trace=true`：文件在 `resolveTarget` 与 `walkTarget` 两次解析之间被删除/改名 → 404「File changed while resolving」，即使内核仍在（与「已删除的 notebook 仍可控制」这一设计意图在该时序冲突，安全失败方向）。【已验证】fs 时序 mock。 | 该错误整体重试 1–2 次；或已有内核时返回首次授权的 canonical target。 |
| L-3 | `python/bridge.py:602-606,684`；`lib/kernel.js:151-168` | 重启失败对宿主零回执：follower 静默 `return False`，`command_loop` 忽略返回值；失败 `log` 在无 run 时被宿主丢弃（只 dispatch 给 currentRun）→ 宿主 `/ipynb/restart` 只能等 30s ready 超时；自动重启失败时宿主不知道内核已不可用。 | 失败时补 `kernel_died`（或 `ready{ok:false}`）并让 command_loop 记录返回值；与 M-3 一并修。 |
| L-4 | `python/bridge.py:148-175,185-212,701-716` | `kc.start_channels()` 不在清理 try 内，且 `self.km/self.kc` 到 ready 后才发布；启动失败或启动窗口内 SIGTERM 时，run/terminate 看不到资源，不能确定性回收 kernel/connection file，只能依赖 ipykernel parent-poller。【已验证】注入首次 start_channels 失败后 `km.is_alive=True`、`bridge.km/kc=None`，调用 terminate 后内核仍 alive。 | 启动开始即发布可清理引用，将 start/client/channels/ready 全部纳入统一 try/except；失败时 stop_channels+shutdown_kernel 并清引用，覆盖 ready 等待期间 SIGTERM。 |

### (b) 存储与路径（`lib/notebook.js`、`lib/gate.js`、`lib/json.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-5 | `lib/notebook.js:364-382,410-444` | 每次保存执行 **2 次全量 `readFile` + 2 次 sha256**（32MiB notebook 每次读 64MiB），且这两次读取**无大小上限**：外部写者在 stat 窗口后把文件增长到 GB 级会被整体缓冲，绕过「保存前 stat、超过 32MiB 不整体读入」的读入预期。【已验证】`readFile` 调用计数=2。 | 复用首次读取的 Buffer 比较；或改 `open`+`fstat` 身份校验；两处读取加 `NOTEBOOK_CAP_BYTES+1` 上限。 |
| L-6 | `lib/notebook.js:434-450` | 硬崩溃/断电发生在保存窗口内会残留 `.dsh-bsb-ipynb-*.tmp`；当前只有可捕获异常路径清理，无启动/读取时清理器。【已验证】子进程 SIGKILL 后残留。 | 启动或读取时清理过期 tmp；或文档化。 |
| L-7 | `lib/notebook.js:170-203,205-225` | `/read` 返回重复 cell id；`nbformat_minor<5` 输入注入 `id` 但不升 minor → 返回体对声明版本不合规（真实 nbformat 判 INVALID）；仅影响 read 响应（保存侧已去重/恒写 4.5）。【已验证】真实 nbformat 5.11。 | read 响应去重 id / 升 minor，或文档声明为已知限制。 |
| L-8 | `lib/notebook.js:308-330` | read 的 stat→readFile 竞态可绕过 32MiB 读入上限（文件在窗口内增长会先整体缓冲，再由 `parseNotebookBytes` 抛 413）；保存侧同类见 L-5。【推测】代码路径。 | 与 L-5 一并做 fd 身份/有界读取。 |
| L-9 | `lib/gate.js:64-85` | 工作区外路径的存在性/可访问性 oracle：存在→403、不存在→404、EACCES→404+reason，同用户 API 可据此探测任意路径。【已验证】 | 统一为不可区分错误，或接受并文档化。 |
| L-10 | `lib/notebook.js:332-346` | `saveQueues` 只按 canonical 路径字符串串行化：同一 inode 的硬链接别名并发保存**两个都成功**，违反 README 声明的「同一 notebook 并发保存只有第一个成功」。【已验证】 | 按 dev/ino 串行化；或文档声明该边界。 |
| L-11 | `lib/json.js:88-111`；`lib/notebook.js:384-408` | save 接受 64MiB 请求体而 notebook 上限 32MiB，峰值内存高；与 M-2 同源。 | 随 M-2 的序列化预算一并收口。 |
| L-12 | `client.js:183-220`（`cleanNode`，递归点 195-201）、`222-233`（`sanitizeHtml`） | HTML 清洗器仍为「unwrap 后递归重启父遍历」实现：O(n²)；规模再大时整段 HTML 输出降级为转义文本。HEAD 的 try/catch 只防止异常逃逸，未降低复杂度；真实白名单分支无行为测试（T-1）。【已验证】最小 DOM 替身中 500/1000/2000/4000 个未知兄弟标签约 **17.8/55.5/165.0/653.4ms**，符合二次增长（非浏览器耗时）。 | 改显式栈/游标，从替换位置继续，并设节点/深度预算；用最小 DOM 或 jsdom 补白名单及操作计数回归。 |

### (c) 解释器发现（`lib/env.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-13 | `lib/env.js:159-206,274-286,42-45` | 探测超时只发 SIGTERM、不升级 SIGKILL：忽略 SIGTERM 的候选（wrapper shell、`SIG_IGN` 的 sitecustomize）使 `execFile` 永不 settle → `discoverInterpreters()` 永久 pending、`inflight` 永不清空、`resetInterpreterCache()` 无效 → `/interpreters`、`/execute`、`/restart` 永久挂起。【已验证】假 python3 忽略 SIGTERM：12s 仍 pending，reset 无效。 | 自行 spawn，超时后 SIGTERM→短宽限→SIGKILL，并等待 close 后 settle；整轮 discovery 加总超时/watchdog。reset 可中止当前 probe，但不能只 `Promise.race` 返回而遗留子进程。 |
| L-14 | `lib/env.js:64-76,78-99,129-147` | 解释器发现是 Unix 布局：PATH 只找 `python3/python`（Windows 需 `.exe`/PATHEXT）、conda 只找 `<env>/bin/python3`（Windows 为 `<env>\python.exe`）、内置 Python 同理 → Windows 默认发现 0 个解释器 → 503。【契约核对】bridge/测试有 Windows 分支与 `Scripts/python.exe` 构造，未在 Windows 实测。 | 按 `process.platform` 选择候选名/venv 布局，或 README 明确平台支持范围。 |

### (d) 客户端（`client.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-15 | `client.js:1395-1409,1422-1432,2428-2444` | 语言热切换不覆盖已存入 state 的 banner 文案：冲突/保存失败/容量/内核重启等 banner 在事件发生时翻译后保存，切换语言后不重译（渲染期 `t()` 的静态文案会更新）。【已验证】英文 409 banner 在切中文后仍保持英文。 | banner 存 `{key, params, kind, action}`，渲染时再 `t(key)`；可保留 text fallback，先迁移 conflict，再覆盖 capacity/kernel。 |
| L-16 | `client.js:1151-1157` | HTML 输出中的图片处理残留：`<img src="attachment:x">`/相对路径经清洗保留但不经 `resolveImage` → 必然裂图（只有 Markdown 路径会解析）。【已验证】 | HTML 输出也走 `resolveImage` 改写 `img[src]`；README 声明远程图片行为。 |
| L-17 | `client.js:471-558` | ANSI 处理不完整：`\r`（进度条/tqdm）不处理 → 浏览器把 `\r` 归一化为换行，进度条变多行垃圾；OSC 序列（`\x1b]0;title\x07`、OSC 8 超链接）不被匹配 → 载荷作为普通文本显示。【已验证】 | `\r` 做行覆盖（保留最后一段）；扩展正则识别并丢弃 OSC。 |
| L-18 | `client.js:1069,1594-1611` | `metadata-too-complex` 阻塞**没有可用的恢复入口**：preflight 失败后 `capacityBlocked=true`、自动保存暂停，banner 只有文字、无 action，文案让用户「减少嵌套/条目」但 UI 没有编辑 metadata 的入口。该状态可由内核输出 metadata 触发（`1024` 将 IOPub `event.metadata` 原样并入 output.metadata），之后所有编辑都无法落盘；唯一出路是逐 cell 的隐藏「清空输出」按钮或 reload 丢弃草稿。【已验证】合成 101 层 display_data → 保存被拦截、0 次上传、banner 无按钮。 | 按来源给 action：output metadata 超限给「清空全部输出」，否则给「重新加载」；或在合并 IOPub metadata 时丢弃超限项（服务端保存同样会 400）。 |
| L-19 | `client.js:745-751,1596,1740-1743` | 容量阻塞只在「成功 preflight / 清空输出 / 重跑 / reload」时解除；用户通过编辑把 notebook 缩回 32MiB 内（删 cell/删源码）后 **autosave 不会恢复**（编辑不重跑 preflight），必须手动保存；README 未说明该恢复路径，现有测试把「编辑不重启 autosave」固化为预期。【已验证】 | 结构性编辑（删 cell/切类型/清输出/插入）时清 `capacityBlocked` 并允许一次 preflight 重试；或 README 明确「缩小后需手动保存一次」。 |
| L-20 | `client.js:901-914` | 保存预检成本：每次保存（含 1.5s autosave 触发的每次）同步执行 `normalizeNotebook` + pretty `JSON.stringify` + `TextEncoder.encode` 整本 notebook，随后请求再 compact stringify 一次。Node 实测 31MiB 单流 45ms、20MB/50 万行源码 148ms；浏览器通常再慢 2–4×；每次瞬时分配约 2–3× notebook。【已验证】 | 按 revision/结构指纹缓存上次测量值，仅改动可能影响大小时重算；或 README 注明大文件保存开销。 |
| L-21 | `client.js:1218-1237` | 快捷键只在编辑 textarea 的 `onKeyDown` 生效（无全局监听，`window.addEventListener` 全文为 0）；阅读态按 Ctrl/Cmd+Enter、Ctrl/Cmd+S 无效（README 已注明快捷键仅在编辑态生效）。【已验证】 | 加全局监听，编辑态复用现有逻辑。 |

---

## 3. Nit（低成本，可批量清理）

- **存储**：metadata 循环引用抛 `TypeError` → 500（而超限是 400；HTTP JSON 不可达）；`DSH_IPYNB_KERNEL_IDLE_MS=0` 不能禁用回收。
- **内核/桥**：restart 窗口内 `is_alive()` 可能误报 kernel_died（宿主单飞提交不可达）；`exec_queue` 无上限（同上）；死协议/文档漂移：`status`/`status_reply` 无调用方、`--kernel-name` 宿主从不传、ready 的 `language_info` 恒 `{}`、`emit()` 吞 stdout 写失败、成功 `execute_reply` 恒带 `error:null`、control `interrupt_reply` 从不消费。
- **宿主**：dispose 晚到清理重复调用一次 `shutdown()`（无害；真实流上二次写已 end 的 stdin 会 `ERR_STREAM_WRITE_AFTER_END`）；`index.js:17-19` 的 `disposeAll()` 未 await；fence 抛异常时每请求打印完整 stack（持续故障期刷屏）；`/interpreters` 冷启动仍同步探测（按设计，无总体超时）。
- **客户端**：`image/jpg` 未归一化为 `image/jpeg`；空 `text/html` 吞掉 `text/plain` 回退；`application/json` 顶层字符串显示裸文本；fence 语言串 `replace(/[^\w-]/g,'')` 丢 `c++`/`c#`；`source.split(/(?<=\n)/)` lookbehind（旧 Safari 解析风险）；`ALLOWED_TAGS` 放行任意 `class`（视觉伪装面）；`application/json` 输出 `JSON.stringify` 无深度保护；解释器获取失败时 select 仍显示误导文案（`client.js:1372`）；执行中编辑态快捷键 Ctrl+Enter/Ctrl+S 静默早退（`client.js:1841,1582`）。
- **测试/文档**：`routes.test.mjs` 的 root 跳过条件未在 README 说明；少量弱断言/同义反复（`client.test.mjs:149` 注册 dict 与自身比 key；`routes.test.mjs:132` `/health` 只 `typeof`；`:517-520` 未绑定 target；`e2e.test.mjs:120` 用默认值断言默认值）；真实内核测试用固定 `sleep`（有 `within()` 兜底）；`bridge_iopub.py` 的 22 个 unittest 在 node 计数中只显示 2 个（非假绿，计数失真）；locale meta `title` 直接用包名。

---

## 4. 测试缺口（8 项）

| ID | 位置 | 缺口 | 建议 |
| --- | --- | --- | --- |
| **T-1**（High，测试可信度） | `client.js:183-233` vs `test/client.test.mjs:440-446,524-527` | DOMParser 白名单清洗器**零真实行为测试**：现有用例只覆盖无 DOMParser/抛错 fallback 和 ALLOWED_ATTRS 集合；`cleanNode` 的 DROP_TAGS、属性删除、`javascript:` 链接化、`target+rel` 覆写及 unwrap 主路径无覆盖。L-12 正藏于此。 | 最小 DOM 替身（或 devDependency jsdom）驱动 `sanitizeHtml` 真实分支，断言 DROP_TAGS/属性白名单/`sanitizeUrl`/`a[target][rel]`；以操作计数验证大量未知标签不再反复扫描。 |
| T-2 | `client.js:1098-1150` | `OutputView` 的 `text/html`、svg/jpeg、`text/markdown`、JSON、latex、error、未知 MIME 回退及 MIME 优先级仍缺行为覆盖。 | 表驱动覆盖其余分支、MIME 优先级和未知 MIME 回退。 |
| T-3 | `client.js:1218-1237,1381-1385,1680-1688,1726-1745,1972-1994` | 客户端主交互缺测试：5 个快捷键、工具栏 interrupt/restart/shutdown、解释器切换（confirm + localStorage）、`visible` 轮询、1.5s autosave 正路径、`onToolbarState` 上报。 | 复用现有 mount harness（已 mock timer/localStorage/confirm）补齐。 |
| T-4 | `lib/routes.js:226,391-396` 等 | `/execute` 预流错误矩阵缺行为测试：`interpreter-unknown`、`code` 非字符串、route 级 `kernel-busy`、`write-failed`、真实默认 64MiB 请求体上限、`/health` 冷启动 `checked:false` 语义。 | 逐条补 route 级用例；`readJsonBody` 可直接用 64MiB+1 Buffer 测上限。 |
| T-5 | `test/routes.test.mjs`、`test/e2e.test.mjs`、`test/execute-disconnect.test.mjs` 等 | HTTP 层全部用手写 `req/res` 替身，无真实 socket：NDJSON 分块、真实 `res.write` 背压/drain、真实 `close`/`writableEnded` 语义、header 大小写等只有假设。 | 加一个 `node:http` + fetch 端到端测试（`/health`、`/read` 成功/404、`/execute` 流式读取与中途 abort），并覆盖慢读/永不 drain。 |
| T-6 | — | 放大/保护/恢复类逻辑缺少回归测试：M-2 的 data 放大与整本预算、M-3 的重启失败状态机、L-1 的 drain 超时、L-5 的保存读取次数、L-11 的 64MiB body 上限、L-19 的容量阻塞自动恢复、L-20 的预检缓存。 | 随对应修复一起补测试（多数可用仓库内测试改造）。 |
| T-7 | — | 跨层一致性/声明类仍缺自动化：metadata 限制的 **read 路径** `invalid` 行为、`examples/demo.ipynb` 的完整 `nbformat.validate` 宣称、客户端 `METADATA_*` 与服务端常量 parity。 | 各加一条用例或 parity 断言。 |
| T-8 | `lib/kernel.js`、`client.js`、`test/bridge_iopub.py` | 新增失败/竞态路径缺回归：M-10 活动 run 坏协议帧、M-11 忽略 SIGTERM 的 shutdown、M-12 迟到 GET `/status`；`test/bridge_iopub.py:336-343` 还将重启失败保留旧 client 固化为预期。 | 分别注入坏帧、不退出 child 和 deferred GET，断言有界终态、进程回收及旧响应被忽略；随 M-3 修复纠正旧 client 预期。 |

---

## 5. 修复优先级建议

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P1** | M-2、M-3（+T-1） | 序列化放大、重启失败无自愈 |
| **P2** | M-4～M-12；T-2、T-5、T-8 | 性能、失败终止、状态竞态与设计级加固 |
| **P3** | §2 的 Low（按组批量）、T-3/T-4/T-6/T-7、§3 Nit | 低成本、低风险，可合并处理 |

---

## 6. 复现与验证索引

| 实验 | 位置/命令 | 关键结果 |
| --- | --- | --- |
| 全量测试 | `npm test` | **292 pass / 0 fail / 0 skipped**，约 23.5s |
| 当前回归 | `node --test test/client.test.mjs test/notebook.test.mjs test/package.test.mjs`；`node --test test/routes.test.mjs test/execute-disconnect.test.mjs`；`node --test test/interpreter.test.mjs test/bridge.test.mjs`；`npm pack --dry-run --json` | `examples` 打入 18 文件产物；路由与专用断连 **41/41**；interpreter/bridge 入口 **9/9**；全量 292 |
| 覆盖率 | `node --experimental-test-coverage --test …` | 当前 292 测试实测：gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%；client.js 24.7%（动态加载与 vm 沙箱用例未计入） |
| M-2 | 本地受控深度 JSON 故障注入（脚本未随仓库提供） | 42,351 B → 35,435,973 B（837×），RSS +132MiB；独立小用例 9,230 B → 4,549,895 B |
| M-3 | 本地真实内核 start_channels 故障注入（脚本未随仓库提供） | 失败后约 14,963 次 IOPub 调用/秒、无 kernel_died、新内核存活 |
| M-4 | 本地 ANSI/reducer 微基准（脚本未随仓库提供） | 1/2/4/8MiB = 16/57/216/843ms，二次增长 |
| M-5 | 本地受控慢 restart 注入（脚本未随仓库提供） | ready 3.336s、execute_reply 3.473s；shutdown 写入 2s 后仍未处理 |
| M-6 | 本地按路由调用顺序注入（脚本未随仓库提供） | symlink 替换后读泄漏 / 写越界；前提是可并发修改目录项 |
| M-7 | better-sidebar 0.30.1 源码（`src/index.ts:730-735`、`src/active-worktree.ts:466`） | 文件树根用 `activeWorktreeRootOf` |
| M-8 | 本地 rename 钩子注入（脚本未随仓库提供） | save fulfilled、外部编辑丢失 |
| M-9 | 当前 Theme provider + `test/client.test.mjs:54-103` | 硬编码色未 token 化；未做视觉/对比度复验 |
| M-10～M-12 | 本地受控 child、不退出 child、deferred GET 注入（脚本未随仓库提供） | 活动 run 永久 busy；2502ms 返回时进程仍活且条目已遗忘；旧 status 覆盖 death |
| L-12 | 当前源码最小 DOM 替身微基准 | 500/1000/2000/4000 标签约 17.8/55.5/165.0/653.4ms |
| 保存字节/边界 | 本地 parity/benchmark 脚本（未随仓库提供） | 正常 notebook 字节一致；32MiB ±0；1/8/30MiB 保存 4/27/110ms |
| Low 复现 | 本地各领域复现脚本（未随仓库提供） | 见各条【已验证】标注 |

**未核实事项**：无真实浏览器 headless（L-12 的浏览器栈/渲染耗时、M-9 的视觉对比度、HTML 输出裂图/外联未做视觉复核）；linked worktree 未在真实 DSH 会话端到端复现；better-sidebar 0.28.x + DSH 0.2.1 组合未安装验证；Windows 行为未实测；DSH 宿主是否给插件 viewer 包 error boundary 未确认（影响 L-12 的影响范围）。
