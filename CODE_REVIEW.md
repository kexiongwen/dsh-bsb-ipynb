# dsh-bsb-ipynb 代码审查：未解决项

> 更新：2026-11-15。适用于 DSH 0.2.2-rc.2+ / dsh-better-sidebar 0.32.x；当前验证组合为 DSH 0.2.2-rc.3 + Better Sidebar 0.32.1。
>
> 本报告只记录当前未解决项。编号按本版顺序排列，与旧报告不对应。位置以函数名为主，避免行号随改动失效。

## 总览

| 级别 | 数量 | 编号 |
| --- | --- | --- |
| Medium | 4 | M-1～M-4 |
| Low | 4 | L-1～L-4 |
| Nit | 6 | N-1～N-6 |
| 测试缺口 | 1 | T-1 |

**证据标记**：【已验证】表示确定性复现或可重跑测试；【契约核对】表示对照宿主或上游源码；【代码确认】表示代码路径明确，但未单独做运行期复现。

## 1. Medium

### M-1：大输出流式渲染存在二次增长

- **位置**：`client.js` 的 `reduceOutputs`、`OutputView`、`CellView`。
- **问题**：每个流事件都会创建新 outputs 数组并重渲整个 cell；未变化的 output 仍会重算 ANSI、HTML 清洗或 Markdown。流文本合并也会反复复制已有内容。
- **影响**：大日志或高频输出可能造成明显 UI 卡顿。
- **建议**：memo 未变化 output；按 rAF 或短窗口合并高频事件；保留 ANSI 增量状态或分块渲染，并保留精确字节预算测试。
- **证据**：【已验证】既有 reducer/ANSI 微基准在 1/2/4/8 MiB 时约为 16/57/216/843ms；不包含真实 React/DOM 布局成本。

### M-2：路径授权与文件 I/O 之间存在 symlink/junction 替换窗口

- **位置**：`lib/gate.js` 的路径解析；`lib/notebook.js` 的读取与保存。
- **问题**：`realpath` 授权和实际读写是两次独立解析，未绑定同一 fd 或父目录身份。授权后替换目标或父目录，可能越界读取或写入。
- **前提**：竞争者必须能并发修改工作区目录项；纯 HTTP 请求本身不能制造 symlink。Windows junction 的创建门槛低于 POSIX symlink。
- **建议**：读取绑定授权、打开、`fstat` 和有界读取；写入绑定父目录身份，并采用 dirfd/openat 等能力。仅增加一次字符串 `realpath` 或版本检查不能根治。
- **证据**：【已验证】macOS symlink 与 Windows junction 均可按路由调用顺序复现越界读写；外部写入需匹配 `baseVersion`。

### M-3：最终 rename 前仍存在外部编辑丢失窗口

- **位置**：`lib/notebook.js` 的 `assertNotebookVersion` 与 `writeNotebook`。
- **问题**：第二次版本检查返回到 rename 之间，外部写者仍可修改目标；插件随后覆盖该修改并返回成功。
- **建议**：若需要强一致，采用覆盖读取、写入、提交的跨进程锁或真正的 CAS 协议，并保留冲突副本。dev/ino、mtime、size 检查只能收窄窗口。
- **证据**：【已验证】在 rename 前注入外部写后，保存仍成功且最终只剩插件内容。

### M-4：保存/读取顺序确认仍是单实例、局部协议

- **位置**：`client.js` 的 `notebookRequests`、`readNotebook`、`reload`；`lib/notebook.js` 的同路径队列。
- **问题**：同一插件实例内已有读写屏障，但跨页面/插件实例不共享客户端顺序。网络失败无法证明保存是否已提交；尚未进入文件队列的请求也可能晚于后续读取。
- **建议**：若需要严格跨实例确认，引入操作 ID、服务端受理顺序及提交结果查询协议；继续保持当前 CAS 和明确边界。
- **证据**：【契约核对】现有客户端记录和服务端队列均有明确作用域；当前没有跨页面或失联请求的端到端确认保证。

## 2. Low

| ID | 平台 | 位置 | 未解决问题 | 建议 |
| --- | --- | --- | --- | --- |
| **L-1** | 全平台 | `lib/kernel.js` 的失败启动与同解释器重试 | 旧进程尚未退出时可能替换 `proc` 并启动新进程，形成短暂双进程窗口。旧事件隔离已存在，但不等于禁止进程重叠。【代码确认】 | 重试前等待旧进程退出，并在 await 后复核 entry/proc；补进程不得重叠的回归。 |
| **L-2** | 全平台 | `lib/notebook.js` 的版本检查与保存 | 每次保存执行两次有界全量读取和两次 sha256；32 MiB notebook 每次保存共读取 64 MiB，增加 I/O 与哈希成本。【代码确认】 | 可用打开句柄和 `fstat` 在身份未变化时减少第二次读取，但不得因此削弱 CAS。 |
| **L-3** | POSIX | `lib/env.js` 的解释器探测 | 探测超时只发送 SIGTERM；忽略该信号的候选可让 discovery 永久 pending，`resetInterpreterCache()` 也无法释放 inflight，相关路由会一直无法返回。【代码确认】 | 改用可控 spawn，按 SIGTERM→短宽限→SIGKILL 升级，并等待 close；整轮 discovery 增加总超时。Windows 的 TerminateProcess 不受此问题影响。 |
| **L-4** | Windows | `lib/gate.js` 的 `walkTarget` 与 `KernelPaths` | junction 目标被删除后，控制路径可能退化为请求拼写路径，导致活内核不可达。属于安全失败方向，不会控制错内核。【已验证】 | 可保持现状；若修复，需要显式处理悬空 reparse point，并保留授权时观察到的身份。 |

## 3. Nit

| ID | 范围 | 事项 |
| --- | --- | --- |
| **N-1** | 内核/桥 | restart 窗口内 `is_alive()` 可能误报 kernel_died；`exec_queue` 仍无上限。宿主正常单飞路径不易触达，但可在后续生命周期加固时一并处理。 |
| **N-2** | 宿主 | `/interpreters` 冷启动仍同步探测，且没有整轮总超时；与 L-3 的探测生命周期问题适合一起处理。 |
| **N-3** | 客户端 | 任意 `class` 有视觉伪装面，但移除会破坏 pandas 等输出，需产品决策；解释器获取失败时 select 文案仍有误导；执行中编辑态 Ctrl+Enter/Ctrl+S 静默早退；Tab 的焦点行为可补充文档说明。 |
| **N-4** | Windows 环境 | `lastError` 可能含本地化 WinError 文案；Node 对尾点、尾空格和保留设备名的字面语义与 Win32 工具不同，升级 Node/Windows 后应复验。 |
| **N-5** | 测试统计 | `test/bridge_iopub.py` 的 26 个 Python unittest 在 Node 汇总中只体现为 2 个测试，计数不代表真实 Python 用例数；这不是假绿。 |
| **N-6** | 客户端/宿主依赖 | 公式排版复用宿主页面的 KaTeX 样式表（以 `.katex` 字体探测是否可用，缺失时改用 MathML），并依赖 client module loader 的 package-local chunk 能力。升级 DSH 后应复验公式外观与 `client.katex.js` 加载；降级路径只显示公式源码，不会报错。 |

## 4. 测试缺口

### T-1：部分 HTTP 路径仍主要使用请求/响应替身

- **已有覆盖**：`/execute` 的慢读、永不 drain、输出超限和真实 socket 关闭，以及 `/image` 的真实 HTTP 图片响应。
- **仍缺少**：`/health`、`/read` 成功/404 等真实 HTTP 用例；NDJSON 分块、真实 close/writableEnded、header 大小写和中途 abort 的完整矩阵。
- **建议**：复用现有 `node:http` 与 TCP 夹具扩展这些场景，保留现有慢读和超限回归，避免仅依赖手写 `req/res`。

## 5. 建议处理顺序

1. **M-2、M-3**：越界访问与外部编辑丢失，优先做安全/数据一致性设计。
2. **M-1、M-4、L-3**：输出性能、跨实例确认协议和解释器探测中止。
3. **L-1、L-2、T-1**：进程重叠、保存成本与真实 HTTP 覆盖。
4. **L-4、N-1～N-5**：按平台需求或相关产品改动一并清理；L-4 可有意保持现状。

## 6. 当前验证

- 本地 macOS 全量测试：**437 tests / 431 pass / 6 skip / 0 fail**，约 11.6s（含新增的 6 个公式渲染用例）。
- 当前 CI 的三平台矩阵与 pinned 浏览器 E2E 均通过：[运行记录 43610459940](https://github.com/kexiongwen/dsh-bsb-ipynb/actions/runs/43610459940)。
- 本地 pinned E2E 覆盖普通根、宿主指定的备用根、受控图片与 KaTeX 公式（chunk 懒加载 + 宿主样式表）的真实浏览器加载；测试套件另含真实 Git worktree 与真实 Python/Jupyter 路径。

### 仍需注意的验证边界

- Windows junction 在不同权限环境中的 Node 可见性可能不同；M-2 的修复不应依赖 `lstat/readlink` 识别 reparse point。
- UNC 作为 workspace、杀毒软件/索引器导致的锁与临时文件残留，未逐项实测。
- 微基准不能替代真实浏览器布局与交互耗时测量。
- 备用根 E2E 使用宿主覆盖；真实 Git 身份由独立集成测试覆盖，二者是互补验证而非同一场景。
