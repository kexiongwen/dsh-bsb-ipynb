# dsh-bsb-ipynb 代码审核报告（现存问题）

- **审核对象**：`dsh-bsb-ipynb`，git HEAD `eccfc5a`（工作树仅含审查/修复产物，无无关改动）
- **环境**：macOS APFS；Node v24.13.1；Python 3.14.7（jupyter_client 8.10 / ipykernel 7.3 / nbformat 5.11）；DSH Desktop 0.2.2-rc.1；dsh-better-sidebar 0.30.1
- **验证依据**：`npm test` **288 pass / 0 fail / 0 skipped**（19.5s）；行覆盖 gate 96.5% / routes 94.6% / kernel 93.0% / notebook 90.8% / env 82.8% / json 85.6%（client.js 24.9%，vm 沙箱用例未计入）；静态检查、`npm pack`（17 文件）、README 数字/错误码/路由核对均通过。**下列问题为当前仍存在的缺陷或测试缺口。**
- **方式**：按 6 个领域（宿主 HTTP/内核、存储/路径/env、客户端渲染、客户端状态机、Python 桥、测试/文档）逐文件审查，关键结论均给出 `file:line`、触发条件与可重跑证据。
- **证据等级**：【已验证】= 可重跑脚本或确定性路径复现；【契约核对】= 对照 DSH 0.2.2-rc.1 asar 运行时、dsh-better-sidebar 0.30.1 源码/类型、npm registry 或上游仓库；【推测】= 仅代码推理。

**问题总览**

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| Medium | 9 | 3 项建议 P1（用户可见 / 小文件内存放大 / 无自愈挂起），其余为设计级加固 |
| Low | 22 | 边界、资源上限、恢复路径，可按领域批量处理 |
| Nit | 约 15 类 | 低成本清理 |
| 测试缺口 | 7 项 | 含 1 项 High 级测试可信度问题（安全关键的 HTML 清洗分支零行为测试） |
| 文档/清单偏差 | 3 项 | README 主题措辞、examples 未打包、engines 未声明 |

---

## 1. Medium（9 项）

| ID | 位置（HEAD `eccfc5a`） | 问题与影响 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| **M-1**（P1） | `client.js:246-273`（`renderInline`）；图片路径 `client.js:396-404` | Markdown 内联渲染在**已转义文本/已生成 HTML** 上跑多轮正则：① URL 二次转义（`?a=1&b=2` → `&amp;amp;`）；② 强调标记插入属性值（`?user_id=1`、wiki `Foo_(bar)` 的 `href`/`target` 被 `<em>` 破坏）；③ 自动链接被 `_` 拆断（`https://e.com/a_b_c` 只链到 `a`）；④ 图片 src 以已转义形态交给解析器，文件名含 `&`/双 `_` 必裂图、`alt` 也被注入。常见链接/本地图片损坏；**无 XSS**（注入标签固定为 em/strong/del，用户文本已转义）。 | 【已验证】直接调用 `renderMarkdown` 复现上述 4 类。 | URL/图片/行内代码改占位符机制（先摘出、最后统一还原）；强调只作用于纯文本段；补 `&`/`_`/括号 URL/图片文件名/alt 回归用例。 |
| **M-2**（P1） | `lib/notebook.js:38-74`（限制）、`102-115`（data/attachments 原样保留）、`248-264`（serialize）、`379-393`（先序列化后查 32MiB） | metadata 的 100 层/10,000 节点限制**只覆盖 metadata 对象**：`execute_result/display_data.data[application/*+json]`、`attachments[...]` 中同样会被 pretty-print 的 JSON 值完全不受限，且限制是「每对象」而非整本预算；32MiB 上限仍在 `JSON.stringify` 之后检查。后果：① 18,224 B 合法 notebook `read` ok（1ms）但 `save` 先构建约 69MiB 字符串、rss +336MiB，才返回 413；② 300 个「每 metadata 恰合规」的 cell（5.98MiB）同样先分配数百 MB；③ 客户端保存预检同步 pretty-stringify 整本 notebook，大文件每次 autosave 都有可感知的分配与耗时（见 L-21）。影响：很小的文件即可造成显著内存/CPU 放大（DoS 面），且服务端没有整本字节预算。 | 【已验证】单 output data depth 4000 的 18,348 B compact → pretty 72,205,583 B（**3,935×**）；18,224 B 文件 save 413 且 rss +336MiB。 | ① 对 data/attachments 的 JSON 值同样应用 depth/node 限制，或设整本节点/字节预算；② 把 32MiB 做成**序列化预算**（有界估算或流式序列化，超限即中止）；③ 客户端预检按 revision 缓存测量结果（见 L-21）。 |
| **M-3**（P1） | `python/bridge.py:622-647`（失败分支 627-630/645-647）、`417-451`（iopub 泵）、`300-311`（execute）、`170-171` | `restart_once()` 重启前无条件 `stop_channels()` 旧 client，**失败路径不回滚、也不拆新内核**。若失败发生在「新内核已启动、新 client 未就绪」（`start_channels` 抛错 / `wait_for_ready(25)` 超时但内核存活）：`self.kc` 仍指向 socket=None 的旧 client；`iopub_loop` 因 `is_alive()` 委托 `km.is_alive()` 为 True 而不进死亡分支 → 持续 `AssertionError` → **无限忙等（实测 1.3–1.6 万次/秒）**；后续 execute 全部 `AssertionError`；**不发 `kernel_died`/ready**，宿主重启只能等 30s ready 超时后 SIGTERM，无自愈路径。另：重启失败对宿主零回执（follower 静默 return、`command_loop` 忽略返回值）。 | 【已验证】真实内核 + 真实 client 确定性复现（仅让重启时 `start_channels` 失败）：`restart→False`、旧 client socket=None、新内核 PID 存活、1.0s 内 iopub 调用 13,419 次，事件只有一条 log，无 kernel_died。 | 失败路径统一收尾：`km.shutdown_kernel(now=True)` → `self.kc=None` → `self.stop.set()`，并发一个**不带 exec_id 的 `kernel_died`** 让宿主 forget；补失败回执（`kernel_died` 或 `ready{ok:false}`）；`command_loop` 检查 restart 返回值。 |
| **M-4**（P2） | `client.js:1089-1146`（`OutputView` 未 memo）、`996-1086`（`reduceOutputs` 流合并） | 大输出渲染 O(n²)：每次流事件产生新 outputs 数组 → 整 cell 重渲；`OutputView` 未按 output 对象缓存，`ansiToHtml`/`sanitizeHtml`/markdown 全文重算；流合并每次 `last.text + chunk` 全量复制；无 rAF/节流（rAF 只用于编辑框光标）。16KiB/块实测 1/2/4/8MiB = 15/55/209/850ms（≈4×/倍），32MiB 外推数十秒；run-all 打印十几 MB 日志时 UI 明显卡死，用户强刷会丢失未保存输出。 | 【已验证】微基准。 | 按 output 对象 memo 渲染结果；流合并只增量处理新 chunk；高频事件用 rAF/100ms 合并；超长输出折叠/虚拟化。 |
| **M-5**（P2） | `python/bridge.py:654-688`（`command_loop` 同步调用 `restart`）、`614-650`（`wait_for_ready(25)`）；`lib/kernel.js:12-13,564-610`（宿主 2s 宽限） | restart 在 **command_loop 线程内同步阻塞**（最长 25s）：期间 stdin 上的 execute/interrupt/shutdown 全部排队不读；若此时收到 shutdown，宿主 2s 后 SIGTERM（现有 SIGTERM 确定性清理可兜底，但控制面在这段时间失去响应）。 | 【已验证】慢重启 3s → `execute_reply` 延迟 3.478s；restart 期间发 shutdown，2s 内命令未被读取。 | restart 移出 command_loop（独立控制线程 / 命令排队），配合 ready op_id 语义。 |
| **M-6**（P2） | `lib/gate.js:64-85,152-185`；`lib/notebook.js:303-326`（读）、`359-439`（存） | 路径授权（realpath 检查）与真正的文件 I/O 是两次独立解析，无 fd/inode 绑定：授权后把目标替换为指向工作区外的 symlink → 越界读；把父目录替换为指向外部的 symlink → 越界写。保存侧的二次版本校验不缓解（两次 `readFile` 沿 symlink 读到同一外部内容，sha 相同 → 照常 rename）。 | 【已验证】确定性注入：读泄漏得到外部内容、写成功写出局外文件。 | 读用 `open(..., O_NOFOLLOW)` + `fstat` 比对 gate 记录的 dev/ino/birthtime 后从 fd 读；写对父目录做 realpath + 身份校验、rename 前后复核；至少写入 README「已知限制」。 |
| **M-7**（P2） | `lib/gate.js:16-53` | 工作区根只认 `ctx.get('workingDirectory').get(session)` / `session.header.cwd`，**不跟随 better-sidebar 的活动根**：文件树根是 `activeWorktreeRootOf(ctx, sessionId, sessionCwdOf(...))`（会采纳 linked git worktree，可能在会话 cwd 之外）。会话活动根为 linked worktree 时，`/ipynb/read`、`/ipynb/save`、`/ipynb/execute`、`/ipynb/status` 全部 403，核心功能不可用；README 已知限制未声明。 | 【契约核对】better-sidebar 0.30.1：`src/index.ts:730-735`、`src/active-worktree.ts:466`；文件 viewer 收到绝对路径后本插件原样提交（`client.js:614,1578,1829`）。未在真实 worktree 会话端到端复现。 | 引入与 better-sidebar 对齐的「活动根集合」（主根 + 关联 worktree realpath，realpath 落在任一候选根内即允许）；或 README 声明不支持 linked worktree。 |
| **M-8**（P2） | `lib/notebook.js:359-377,416,427`；`README.md:12` | 保存的 CAS 只在 `readFile→sha256→比较` 时检测冲突；二次校验完成到 rename 之间仍有窗口：外部写者在窗口内写入会被静默覆盖，API 仍返回 200（失败方向是用户丢数据）。README:12 已声明该竞态，但接口语义仍为成功。 | 【已验证】在「二次校验完成、rename 之前」注入外部写：`saveNotebookFile` 返回成功、外部内容丢失。 | rename 前再次校验 stat/身份可收窄窗口；或引入 advisory lock；至少保持文档化并在返回体中不宣称强一致。 |
| **M-9**（P2） | `client.js:2149-2155`（4 个 token）、`2186-2187,2214,2223-2224,2339-2358`（硬编码色与媒体查询）；`README.md:14` | 主题跟随不完整：只有 4 个基础色使用 `--dsw-alias-*` token；语法高亮、内核状态点、保存失败/错误、banner、stderr 仍硬编码，且暗色只按 **OS 的** `prefers-color-scheme` 切换——DSH 显式 light/dark/system 主题由 `body[data-ds-dark-theme]` 表达（只有 system 才走媒体查询）。用户显式选 DSH dark/light 且与 OS 相反时用错调色板：light 的 `#0a3069` 落在暗底 **1.34:1**、dark 的 `#a5d6ff` 落在浅底 **1.54:1**（基本不可读）；README:14「随明/暗与自定义皮肤切换」表述过宽。 | 【契约核对】DSH theme 包 README:12/48 + token 表（dark 在 `body[data-ds-dark-theme]{}`）；【已验证】对比度数值计算。 | 暗色选择器改 `body[data-ds-dark-theme] .dsh-bsb-ipynb-root`；状态色改用 `--dsw-alias-state-*` 语义 token；语法高亮至少按 `data-ds-dark-theme` 切换；收紧 README；加「暗色规则必须是属性选择器」的测试。 |

---

## 2. Low（24 项）

### (a) 内核与 HTTP（`lib/kernel.js`、`lib/routes.js`、`python/bridge.py`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-1 | `lib/routes.js:306-327` | `/execute` 的 `end()` 遇背压只注册 `res.once('drain', end)`、无超时兜底；客户端不读取（半开/冻结连接）时响应永不结束，socket 与闭包长期占用（内核已 idle）。【已验证】事件替身：永不 drain → 600ms 后未 end、无存活 Timeout。 | drain 等待加有界超时（如 10s），超时清队列并 destroy/end。 |
| L-2 | `lib/gate.js:152-185,214-233`；消费方 `lib/routes.js:193,222,374,389,411` | 控制/执行端点固定 `trace=true`：文件在 `resolveTarget` 与 `walkTarget` 两次解析之间被删除/改名 → 404「File changed while resolving」，即使内核仍在（与 README:116「删除后仍可控制」在该时序冲突，安全失败方向）。【已验证】fs 时序 mock。 | 该错误整体重试 1–2 次；或已有内核时返回首次授权的 canonical target。 |
| L-3 | `python/bridge.py:599-603,681`；`lib/kernel.js:151-168` | 重启失败对宿主零回执：follower 静默 `return False`，`command_loop` 忽略返回值；失败 `log` 在无 run 时被宿主丢弃（只 dispatch 给 currentRun）→ 宿主 `/ipynb/restart` 只能等 30s ready 超时；自动重启失败时宿主不知道内核已不可用。 | 失败时补 `kernel_died`（或 `ready{ok:false}`）并让 command_loop 记录返回值；与 M-3 一并修。 |
| L-4 | `python/bridge.py:145-172` | `start_kernel()` 在 `wait_for_ready(25)` 之后才发布 `self.km/self.kc`，**启动窗口内 SIGTERM 无法确定性清理**（`terminate()` 看到 None 直接返回，内核靠 ipykernel parent-poller 收尸）。【已验证】bridge exit 0 后内核 +0.5s 仍存活、+3.5s 消失。 | 在 `wait_for_ready()` 之前发布 km/kc，失败时用局部引用显式 teardown。 |

### (b) 存储与路径（`lib/notebook.js`、`lib/gate.js`、`lib/json.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-5 | `lib/notebook.js:359-377,416,427` | 每次保存执行 **2 次全量 `readFile` + 2 次 sha256**（32MiB notebook 每次读 64MiB），且这两次读取**无大小上限**：外部写者在 stat 窗口后把文件增长到 GB 级会被整体缓冲，绕过 README:120「不会先整体读入内存」。【已验证】`readFile` 调用计数=2。 | 复用首次读取的 Buffer 比较；或改 `open`+`fstat` 身份校验；两处读取加 `NOTEBOOK_CAP_BYTES+1` 上限。 |
| L-6 | `lib/notebook.js:417,423,428` | 保存经 umask 改变文件权限（0664→0644）并丢失 ACL/xattr/硬链接关系（rename 换 inode）。【已验证】mode 与 nlink 实测。 | 显式 chmod 目标 mode，或文档化该行为。 |
| L-7 | `lib/notebook.js:418-437` | 硬崩溃/断电发生在保存窗口内会残留 `.dsh-bsb-ipynb-*.tmp`；当前只有可捕获异常路径清理，无启动/读取时清理器。【已验证】子进程 SIGKILL 后残留。 | 启动或读取时清理过期 tmp；或文档化。 |
| L-8 | `lib/notebook.js:170-203,205-225` | `/read` 返回重复 cell id；`nbformat_minor<5` 输入注入 `id` 但不升 minor → 返回体对声明版本不合规（真实 nbformat 判 INVALID）；仅影响 read 响应（保存侧已去重/恒写 4.5）。【已验证】真实 nbformat 5.11。 | read 响应去重 id / 升 minor，或文档声明为已知限制。 |
| L-9 | `lib/notebook.js:303-326` | read 的 stat→readFile 竞态可绕过 32MiB 读入上限（文件在窗口内增长会先整体缓冲，再由 `parseNotebookBytes` 抛 413）；保存侧同类见 L-5。【推测】代码路径。 | 与 L-5 一并做 fd 身份/有界读取。 |
| L-10 | `lib/gate.js:64-85` | 工作区外路径的存在性/可访问性 oracle：存在→403、不存在→404、EACCES→404+reason，同用户 API 可据此探测任意路径。【已验证】 | 统一为不可区分错误，或接受并文档化。 |
| L-11 | `lib/notebook.js:332-346` | `saveQueues` 只按 canonical 路径字符串串行化：同一 inode 的硬链接别名并发保存**两个都成功**，违反 README:113「只有第一个成功」。【已验证】 | 按 dev/ino 串行化；或文档声明该边界。 |
| L-12 | `lib/json.js:88-111`；`lib/notebook.js:379-393` | save 接受 64MiB 请求体而 notebook 上限 32MiB，峰值内存高；与 M-2 同源。 | 随 M-2 的序列化预算一并收口。 |
| L-13 | `client.js:178-214`（`cleanNode`，递归点 190-196）、`217-227`（`sanitizeHtml`） | HTML 清洗器仍为「unwrap 后递归重启父遍历」实现：O(n²)（500→4000 个非白名单标签 = 16→553ms，≈4×/倍）；规模再大时整段 HTML 输出降级为转义文本（可读性丢失）。该安全关键分支无任何行为测试（T-1）。 | 改迭代遍历（显式栈/游标）；用最小 DOM 替身补 DROP_TAGS/属性白名单/`sanitizeUrl`/大量未知标签线性回归。 |

### (c) 解释器发现（`lib/env.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-14 | `lib/env.js:159-206,274-286,42-45` | 探测超时只发 SIGTERM、不升级 SIGKILL：忽略 SIGTERM 的候选（wrapper shell、`SIG_IGN` 的 sitecustomize）使 `execFile` 永不 settle → `discoverInterpreters()` 永久 pending、`inflight` 永不清空、`resetInterpreterCache()` 无效 → `/interpreters`、`/execute`、`/restart` 永久挂起。【已验证】假 python3 忽略 SIGTERM：12s 仍 pending，reset 无效。 | 自行 spawn，超时后 SIGTERM→宽限→SIGKILL；整轮 discovery 加总超时/watchdog；reset 时 `Promise.race` 保证 settle。 |
| L-15 | `lib/env.js:64-76,78-99,129-147` | 解释器发现是 Unix 布局：PATH 只找 `python3/python`（Windows 需 `.exe`/PATHEXT）、conda 只找 `<env>/bin/python3`（Windows 为 `<env>\python.exe`）、内置 Python 同理 → Windows 默认发现 0 个解释器 → 503。【契约核对】bridge/测试有 Windows 分支与 `Scripts/python.exe` 构造，未在 Windows 实测。 | 按 `process.platform` 选择候选名/venv 布局，或 README 明确平台支持范围。 |

### (d) 客户端（`client.js`）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L-16 | `client.js:1376-1386,2384-2400` | 语言热切换不覆盖已存入 state 的 banner 文案：冲突/保存失败/容量/内核重启等 banner 在事件发生时翻译后保存，切换语言后不重译（渲染期 `t()` 的静态文案会更新）。【已验证】 | banner 存 `{key, params}`，渲染时再 `t()`；或切换语言时按 key 重算现有 banner。 |
| L-17 | `client.js:1114-1120` | HTML 输出中的图片处理残留：`<img src="attachment:x">`/相对路径经清洗保留但不经 `resolveImage` → 必然裂图（只有 Markdown 路径会解析）。【已验证】 | HTML 输出也走 `resolveImage` 改写 `img[src]`；README 声明远程图片行为。 |
| L-18 | `client.js:425-511` | ANSI 处理不完整：`\r`（进度条/tqdm）不处理 → 浏览器把 `\r` 归一化为换行，进度条变多行垃圾；OSC 序列（`\x1b]0;title\x07`、OSC 8 超链接）不被匹配 → 载荷作为普通文本显示。【已验证】 | `\r` 做行覆盖（保留最后一段）；扩展正则识别并丢弃 OSC。 |
| L-19 | `client.js:1023,1548-1565` | `metadata-too-complex` 阻塞**没有可用的恢复入口**：preflight 失败后 `capacityBlocked=true`、自动保存暂停，banner 只有文字、无 action，文案让用户「减少嵌套/条目」但 UI 没有编辑 metadata 的入口。该状态可由内核输出 metadata 触发（`1015` 将 IOPub `event.metadata` 原样并入 output.metadata），之后所有编辑都无法落盘；唯一出路是逐 cell 的隐藏「清空输出」按钮或 reload 丢弃草稿。【已验证】合成 101 层 display_data → 保存被拦截、0 次上传、banner 无按钮。 | 按来源给 action：output metadata 超限给「清空全部输出」，否则给「重新加载」；或在合并 IOPub metadata 时丢弃超限项（服务端保存同样会 400）。 |
| L-20 | `client.js:699-705,1550,1694-1697` | 容量阻塞只在「成功 preflight / 清空输出 / 重跑 / reload」时解除；用户通过编辑把 notebook 缩回 32MiB 内（删 cell/删源码）后 **autosave 不会恢复**（编辑不重跑 preflight），必须手动保存；README:118 未覆盖该修复方式，现有测试把「编辑不重启 autosave」固化为预期。【已验证】 | 结构性编辑（删 cell/切类型/清输出/插入）时清 `capacityBlocked` 并允许一次 preflight 重试；或 README 明确「缩小后需手动保存一次」。 |
| L-21 | `client.js:855-868` | 保存预检成本：每次保存（含 1.5s autosave 触发的每次）同步执行 `normalizeNotebook` + pretty `JSON.stringify` + `TextEncoder.encode` 整本 notebook，随后请求再 compact stringify 一次。Node 实测 31MiB 单流 45ms、20MB/50 万行源码 148ms；浏览器通常再慢 2–4×；每次瞬时分配约 2–3× notebook。【已验证】 | 按 revision/结构指纹缓存上次测量值，仅改动可能影响大小时重算；或 README 注明大文件保存开销。 |
| L-22 | `client.js:1173-1191` | 快捷键只在编辑 textarea 的 `onKeyDown` 生效（无全局监听，`window.addEventListener` 全文为 0）；阅读态按 Ctrl/Cmd+Enter、Ctrl/Cmd+S 无效，但 README:44-50 把快捷键列在「使用」表，给人的印象是全局快捷键。【已验证】 | 加全局监听（编辑态复用现有逻辑），或 README 明确「仅编辑单元格时生效」。 |

---

## 3. Nit（低成本，可批量清理）

- **存储**：metadata 循环引用抛 `TypeError` → 500（而超限是 400；HTTP JSON 不可达）；`DSH_IPYNB_KERNEL_IDLE_MS=0` 不能禁用回收。
- **内核/桥**：restart 窗口内 `is_alive()` 可能误报 kernel_died（宿主单飞提交不可达）；`exec_queue` 无上限（同上）；死协议/文档漂移：`status`/`status_reply` 无调用方、`--kernel-name` 宿主从不传、ready 的 `language_info` 恒 `{}`、`emit()` 吞 stdout 写失败、成功 `execute_reply` 恒带 `error:null`、control `interrupt_reply` 从不消费。
- **宿主**：dispose 晚到清理重复调用一次 `shutdown()`（无害；真实流上二次写已 end 的 stdin 会 `ERR_STREAM_WRITE_AFTER_END`）；`index.js:17-19` 的 `disposeAll()` 未 await；fence 抛异常时每请求打印完整 stack（持续故障期刷屏）；`/interpreters` 冷启动仍同步探测（按设计，无总体超时）。
- **客户端**：`image/jpg` 未归一化为 `image/jpeg`；空 `text/html` 吞掉 `text/plain` 回退；`application/json` 顶层字符串显示裸文本；fence 语言串 `replace(/[^\w-]/g,'')` 丢 `c++`/`c#`；`source.split(/(?<=\n)/)` lookbehind（旧 Safari 解析风险）；`ALLOWED_TAGS` 放行任意 `class`（视觉伪装面）；`application/json` 输出 `JSON.stringify` 无深度保护；解释器获取失败时 select 仍显示误导文案（`client.js:1326`）；执行中编辑态快捷键 Ctrl+Enter/Ctrl+S 静默早退（`client.js:1796,1536`）。
- **测试/文档**：`routes.test.mjs` 的 root 跳过条件未在 README 说明；少量弱断言/同义反复（`client.test.mjs:139` 注册 dict 与自身比 key；`routes.test.mjs:173` `/health` 只 `typeof`；`:551-554` 未绑定 target；`e2e.test.mjs:120` 用默认值断言默认值）；真实内核测试用固定 `sleep`（有 `within()` 兜底）；`bridge_iopub.py` 的 22 个 unittest 在 node 计数中只显示 2 个（非假绿，计数失真）；locale meta `title` 直接用包名。

---

## 4. 测试缺口（7 项）

| ID | 位置 | 缺口 | 建议 |
| --- | --- | --- | --- |
| **T-1**（High，测试可信度） | `client.js:178-214` vs `test/client.test.mjs:349-355` | DOMParser 白名单清洗器**零行为测试**：只有一条「无 DOMParser → 整体转义」的反向断言；`cleanNode` 的 DROP_TAGS/ALLOWED_ATTRS/属性删除/`javascript:` 链接化/`target+rel` 覆写全部无覆盖。该分支在 Node 不可达，安全关键路径回归保护为 0（L-13 正藏于此）。 | 最小 DOM 替身（或 devDependency jsdom）驱动 `sanitizeHtml` 真实分支，断言 DROP_TAGS/属性白名单/`sanitizeUrl`/`a[target][rel]`，并加「大量未知标签不抛错且线性」回归。 |
| T-2 | `client.js:1089-1146` | `OutputView` 各 MIME 渲染分支（`text/html`、png/jpeg/svg、`text/markdown`、JSON、latex、error、stream）**零测试**，README 首屏卖点无回归保护。 | 表驱动覆盖各分支与 MIME 优先级/未知 MIME 回退。 |
| T-3 | `client.js:1173-1191,1335-1339,1633-1642,1680-1698,1926-1948` | 客户端主交互缺测试：5 个快捷键、工具栏 interrupt/restart/shutdown、解释器切换（confirm + localStorage）、`visible` 轮询、1.5s autosave 正路径、`onToolbarState` 上报。 | 复用现有 mount harness（已 mock timer/localStorage/confirm）补齐。 |
| T-4 | `lib/routes.js:226,391-396` 等 | `/execute` 预流错误矩阵缺行为测试：`interpreter-unknown`、`code` 非字符串、route 级 `kernel-busy`、`write-failed`、真实默认 64MiB 请求体上限、`/health` 冷启动 `checked:false` 语义。 | 逐条补 route 级用例；`readJsonBody` 可直接用 64MiB+1 Buffer 测上限。 |
| T-5 | `test/routes.test.mjs`、`test/e2e.test.mjs`、`test/execute-disconnect.test.mjs` 等 | HTTP 层全部用手写 `req/res` 替身，无真实 socket：NDJSON 分块、真实 `res.write` 背压/drain、真实 `close`/`writableEnded` 语义、header 大小写等只有假设。 | 加一个 `node:http` + fetch 端到端测试（`/health`、`/read` 成功/404、`/execute` 流式读取与中途 abort）。 |
| T-6 | — | 放大/保护/恢复类逻辑缺少回归测试：M-2 的 data 放大与整本预算、M-3 的重启失败状态机、L-1 的 drain 超时、L-5 的保存读取次数、L-12 的 64MiB body 上限、L-20 的容量阻塞自动恢复、L-21 的预检缓存。 | 随对应修复一起补测试（多数已有 `local-scratch` 复现脚本可改造）。 |
| T-7 | — | 跨层一致性/声明类无自动化：metadata 限制的 **read 路径** `invalid` 行为、`examples/demo.ipynb` 的 `nbformat.validate` 宣称、客户端 `METADATA_*` 与服务端常量 parity、README:44-50 的快捷键作用域。 | 各加一条用例或 parity 断言。 |

---

## 5. 文档与清单偏差（3 项）

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| D-1 | `README.md:14` | 「界面颜色取自当前 DSH 主题的 `--dsw-alias-*` token（随明/暗与自定义皮肤切换）」只对 4 个基础色成立，语法/状态色硬编码且暗色跟随 OS（见 M-9）。 | 收紧措辞为「主要边框/弱文本/强调/表面色取自主题 token」；或完成 token 化。 |
| D-2 | `README.md:41` vs `package.json files` | README 让用户打开 `examples/demo.ipynb`，但 `files` 未包含 `examples/`，`npm pack` 产物（17 文件）中不存在该文件；对「仓库目录作本地 bundle」安装无影响，对按 tarball 安装的用户是失效引用。 | 把 `examples` 加入 `files`，或写明「仓库内」。 |
| D-3 | `package.json` | 只声明 `engines.node`，未声明 DSH manifest 支持的 `engines.dsh`（README:19 声称要求 DSH 0.2.2-rc.1 或更新；安装器当前不强制，属声明性缺口）。 | 建议加 `"engines": {"node": ">=20", "dsh": ">=0.2.2-rc.1"}`。 |

> 其余文档/清单项已核对通过，不需要修改：14 个错误码 ↔ `STATUS_BY_CODE`、9 条路由/响应字段、全部数字（32MiB/64MiB/1.5s/10s/15s/3s/2s/30s/30min/100/10000）、`package.json`/`cordis.patch.yml`/exports/locale 结构与 DSH 官方插件模板一致、locale en/zh 键与占位符对齐且命名空间/`register/bind/getSnapshot().revision/subscribe` 与 DSH 0.2.2-rc.1 运行时契约一致、NOTICE/LICENSE/icon 有效、demo 通过真实 `nbformat.validate`、better-sidebar 版本矩阵属实。

---

## 6. 修复优先级建议

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P1** | M-1、M-2、M-3（+T-1） | 用户可见渲染 bug / 小文件内存放大 / 重启失败无自愈；改动均局部到中等，建议同批修复并补回归 |
| **P2** | M-4、M-5、M-6、M-7、M-8、M-9；T-2、T-5 | 性能与设计级加固；M-6/M-7/M-8 至少先补 README「已知限制」 |
| **P3** | §2 的 Low（按组批量）、T-3/T-4/T-6/T-7、D-1/D-2/D-3、§3 Nit | 低成本、低风险，可合并处理 |

---

## 7. 复现与验证索引

| 实验 | 位置/命令 | 关键结果 |
| --- | --- | --- |
| 全量测试 | `npm test` | 288 pass / 0 fail / 0 skipped，19.5s |
| 覆盖率 | `node --experimental-test-coverage --test …` | 见文头 |
| M-1 | `local-scratch/ipynb-review-1107/lead/render.mjs` | `&` 双重转义、自动链接被 `<em>` 拆断、wiki URL 破坏 `target` |
| M-2 | `local-scratch/ipynb-review-1107/storage/exp2b-amplification.mjs`、`exp2d-metadata-aggregate.mjs`、`exp9-data-file.mjs` | 18KB→69MiB（3,935×）；18,224 B 文件 save 413 且 rss +336MiB；300 cell → 数百 MB |
| M-3 | `local-scratch/ipynb-review-1107/bridge/probe_restart_failure2.py` | 失败后 13,419 iopub 调用/秒、无 kernel_died、新内核存活 |
| M-4 | `local-scratch/ipynb-review-1107/client-render/repro.mjs` | 1/2/4/8MiB = 15/55/209/850ms |
| M-5 | `local-scratch/ipynb-review-1107/bridge/probe_m6.py`、`probe_sigterm_real.py` | 慢重启 3s → execute_reply 延迟 3.478s；SIGTERM 清理 exit 0 |
| M-6 | `local-scratch/ipynb-review-1107/storage/exp4-gate.mjs` | symlink 替换后读泄漏 / 写越界 |
| M-7 | better-sidebar 0.30.1 源码（`src/index.ts:730-735`、`src/active-worktree.ts:466`） | 文件树根用 `activeWorktreeRootOf` |
| M-8 | `local-scratch/ipynb-review-1107/storage/exp3-save-flow.mjs` | rename 前注入外部写仍返回成功 |
| M-9 | `local-scratch/ipynb-review-1107/client-state/asar/`（DSH theme 包） | `body[data-ds-dark-theme]` 契约；对比度数值 |
| L-13 | `local-scratch/ipynb-review-1107/client-render/sanitizer-cost.mjs` | 500→4000 标签 16→553ms；更大规模降级为转义文本 |
| 保存字节/边界 | `local-scratch/ipynb-review-1107/lead/parity*.mjs`、`save-bench.mjs` | 正常 notebook 字节一致；32MiB ±0；1/8/30MiB 保存 4/27/110ms |
| Low 复现 | `local-scratch/ipynb-review-1107/host-code/*.mjs`、`storage/exp1..9`、`client-state/repro/lifecycle-copy.mjs`、`bridge/probe_*.py` | 见各条【已验证】标注 |

**未核实事项**：无真实浏览器 headless（L-13 的浏览器栈/渲染耗时、M-9 的视觉对比度、HTML 输出裂图/外联未做视觉复核）；linked worktree 未在真实 DSH 会话端到端复现；better-sidebar 0.28.x + DSH 0.2.1 组合未安装验证；Windows 行为未实测；DSH 宿主是否给插件 viewer 包 error boundary 未确认（影响 L-13 的影响范围）。
