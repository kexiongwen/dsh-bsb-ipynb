# 01 — Windows 侧审查：解释器发现与内核进程（`lib/env.js` / `lib/kernel.js` / `python/bridge.py`）

> 审查域：Windows 上解释器发现（`lib/env.js`）、bridge 进程 / JSONL 协议 / 真实 ipykernel 生命周期（`lib/kernel.js` + `python/bridge.py`），重点是 Mac 审查已有条目（L-13、L-14、M-3、M-5、M-11、L-1、L-4）在 Windows 上是否成立，以及 Windows 专属问题。
> 基线：仓库 `C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb` HEAD `8c1ad8e`，工作树干净（本报告是唯一新增文件）。
> 分工：完整 `npm test` 由队友 win-tests 负责（见 `04-tests-ci.md`）；本报告未跑全量测试。
>
> 证据等级：
> - 【已验证】本报告用真实命令 / 真实 ipykernel 实测得到的输出（脚本只读仓库，所有文件写入 `%TEMP%`，未入库）；
> - 【Lead 全权限实测】Lead（`lead`）在无沙箱限制下用真实 `lib/kernel.js` + DSH 宿主环境复核得到的证据（本会话内由 Lead 消息提供）；
> - 【契约核对】对照本机安装的库源码（jupyter_client 8.10.0 / ipykernel 7.4.0 / Python 3.14.7）与 README 契约；
> - 【推测】仅代码推理 / 未实测。

---

## 0. 方法与命中限制（为什么证据这样取）

DSH 会话的默认 `workspace-write` 沙箱（审批禁用，无法提权）下，**Node 的 `child_process.spawn` 用管道 stdio 一律 `EPERM`**（实测 `spawn('python.exe', ..., {stdio:'pipe'})`、`execFile`、`spawnSync` 均失败；`stdio:'ignore'/'inherit'` 正常）。因此无法在沙箱内直接跑 `KernelManager` / `execFileAsync`。

本报告的取证方式（均为真实执行）：

1. **Python 父进程直驱 `python/bridge.py`**：沙箱只限制 Node 的 libuv 管道创建，Python 的匿名管道 `subprocess.PIPE` 可用（已实测）。用 `C:\Python314\python.exe` 直接跑自建 harness，以**真实 JSONL 协议**驱动 `bridge.py` + **真实 ipykernel**，覆盖 execute/UTF-8/interrupt/restart/shutdown/kill/启动故障注入/cwd。
2. **Node 单进程 + `stdio:'ignore'` 探针**验证 `kernel.js` 依赖的 Node 原语在 Windows 的真实语义：`proc.kill('SIGTERM')` = `TerminateProcess`（Python 信号处理器不会执行）、`'exit'` 事件参数、spawn 失败时的 `error/ENOENT` 行为。
3. **Node 纯 fs/env 探针**验证 `env.js` 候选枚举逻辑（`PATH` 名字、conda 布局、bundled 布局、`X_OK` 语义、WindowsApps 别名）。
4. 与 **Lead 的全权限实测**交叉核对（下面标【Lead 全权限实测】：真实 `lib/kernel.js` + `KernelManager`、`/execute` route 层 e2e）。

已知的方法偏差（报告中逐条标注）：Python 直驱绕过了 `kernel.js` 的 Node 进程管理代码本身；sandbox 下 jupyter_core 的 `SetFileSecurity` 被拒绝（WinError 5），harness 用 `sitecustomize` 把 `win32_restrict_file_to_user` 置空属于**仅供本沙箱取证的 shim**（真实 DSH 宿主进程无沙箱，Lead 已验证链路可用；该 shim 不影响本报告任何结论）。

---

## 1. 环境事实（本机实测）

| 项 | 值 | 证据 |
| --- | --- | --- |
| OS | Windows 11，build **10.0.26300**，x64；系统 ACP **cp936**（`chcp` → 936） | `$PSVersionTable`/`cmd /c chcp` |
| Node | **v24.19.0**（`C:\Program Files\nodejs\node.exe`） | `node --version` |
| Python（实验解释器） | **3.14.7**，`C:\Python314\python.exe`；jupyter_client **8.10.0**、ipykernel **7.4.0**；`locale.getpreferredencoding(False)=cp936` | `python -c ...` |
| 其他 Python | miniconda3 `C:\Users\kexio\miniconda3\python.exe`（在 PATH，无 jupyter 证据未测）；`py -0p` → `-V:3.14 * C:\Python314\python.exe`、`-V:Astral/CPython3.14.3 …\uv\python\…` | `py -0p` |
| `python` / `python3` 命令 | `python` → `C:\Python314\python.exe`；`python3` → **WindowsApps 应用执行别名** `C:\Users\kexio\AppData\Local\Microsoft\WindowsApps\python3.exe`（0 字节 reparse point） | `Get-Command` |
| DSH_HOME | `C:\Users\kexio\.dsh`；`DSH_PRIMARY_RUNTIME` **未设置**（宿主/工具进程 env 均无） | `Get-ChildItem Env:DSH*`、Node `process.env` |
| DSH 运行时布局 | `C:\Users\kexio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\` → `node/`、`pnpm/`、`python/`；Python 实际在 **`dependencies\python\python.exe`**（`python312.dll`、`Lib/`、`Scripts/`），**没有 `bin/` 目录** | `Get-ChildItem` |
| DSH 内置 Python 能力 | `dependencies\python\python.exe -c "import jupyter_client"` → **`ModuleNotFoundError: No module named 'jupyter_client'`**（runtime.json 的 `pythonPackages` 也没有 jupyter/ipykernel） | 直接命令输出 |
| DSH 桌面版 | 0.2.2-rc.1（Lead 实测；`runtime.json` 的 `desktopVersion: 0.2.1-rc.3` 是旧缓存，见 `03-client-docs-integration.md`） | Lead 消息 + 兄弟报告 |
| jupyter 连接文件位置 | jupyter_client 8.10 在 `KernelManager` 未设置 `connection_file` 时用 **`tempfile.mkstemp('.json')`** 写入系统 TEMP，即内核 cmdline 为 `... -f C:\Users\kexio\AppData\Local\Temp\dsh-1OtCKz\tmpXXXXXX.json`；**不写** `%APPDATA%\jupyter\runtime` | 内核进程 cmdline + `jupyter_client/connect.py:119-122` |
| ipykernel Windows 父进程回收 | jupyter_client launcher 在 Windows 上 `DuplicateHandle` 父进程句柄并设 `JPY_PARENT_PID`（`launcher.py:119-132`），ipykernel `ParentPollerWindows` 等待该句柄，父进程退出即 `os._exit(1)`（`ipykernel/parentpoller.py:69-134`） | 源码 + 实测（见 §2-W04/W08） |

实验 harness（全部在 `%TEMP%`，未入库）：
`C:\Users\kexio\AppData\Local\Temp\dsh-1OtCKz\dsh-win-review\win-kernel-env\` 下 `lab.py`（管道驱动 bridge）、`scenarios.py`（8 组场景）、`wrapper.py`（故障注入）、`grandchild_probe.py`、`node_kill_probe.mjs`、`env_layout_probe.mjs`，证据 JSON 在 `logs\`。运行命令见 §5。

---

## 2. 问题表

> 严重级：High = Windows 用户核心功能不可用/明显数据或资源泄漏；Medium = 功能受损或有可靠规避但违反契约；Low = 边界/诊断/一致性；Nit = 低成本清理。
> 位置以 HEAD `8c1ad8e` 行号为准。

| ID | 严重级 | 位置（file:line） | 触发条件 | 建议 | 证据等级 |
| --- | --- | --- | --- | --- | --- |
| **W-01** | **High** | `lib/env.js:64-76, 78-99, 126-127, 129-147` | Windows 默认环境（本机 PATH/conda/bundled 布局）首次打开插件 | 解释器发现按 `process.platform` 平台化（`.exe`/PATHEXT、conda `<env>\python.exe`、bundled `<runtime>\dependencies\python\python.exe`），并跳过 WindowsApps 别名目录 | 【已验证】+【Lead 全权限实测】 |
| **W-02** | Medium | `lib/env.js:129-147`；`C:\...\dsh-primary-runtime\runtime.json` | Windows 上 bundled 候选按 `<deps>\python\bin\python3` 拼接；即使路径修对，内置 Python 也没有 jupyter 包 | bundled 分支按平台拼接，并把「bundled 不可用」作为明确的 ok:false 条目返回（而不是静默消失）；README 写明 Windows 需系统 Python | 【已验证】 |
| **W-03** | Medium | `python/bridge.py:148-151`；`lib/kernel.js:564-616`；`jupyter_client/connect.py:119-122` | bridge 被 `proc.kill()`（Windows=TerminateProcess）、启动失败、restart 失败后退出 | 维护自有连接文件路径并清理；host 侧 kill 后清 `%TEMP%\tmp*.json`；或给 `KernelManager` 显式 `connection_file` 到可控目录 | 【已验证】 |
| **W-04** | Medium | `lib/kernel.js:564-616`（只 kill bridge 单进程）、`python/bridge.py:185-198/539-561`（只 shutdown kernel 进程） | 用户 cell 内 `subprocess.Popen(...)` 起的长期子进程；bridge 正常 shutdown 或硬杀后 | Windows 用 Job Object（kill-on-close）或 `taskkill /PID <bridge> /T /F` 回收整棵进程树；README 说明该边界 | 【已验证】 |
| **W-05** | Medium（与 Mac P1 同源） | `python/bridge.py:617-654`（restart 失败路径）、`418-450`（iopub 忙等）、`657-692`；`lib/kernel.js:151-164` | restart 时新内核已起、新 client `start_channels()` 失败 | 同 Mac M-3 修复（失败即停新 client/关 km/清 kc/pending、发 `kernel_died`；IOPub 异常退避）；Windows 上忙等速率更高 | 【已验证】 |
| **W-06** | Medium（与 Mac P2 同源） | `python/bridge.py:657-692`（command_loop 同步 restart）、`617-654`（wait_for_ready 25s）；`lib/kernel.js:564-616` | restart 期间发送 status/execute/shutdown（真实场景：重启中用户关闭/切解释器） | 同 Mac M-5：restart 移出 command_loop；Windows 上宿主超时后只剩 TerminateProcess，清理路径更差（见 W-07） | 【已验证】 |
| **W-07** | Low | `lib/kernel.js:564-599, 601-616`；`python/bridge.py:200-224` | shutdown 2s 宽限内 bridge 未退出 | SIGTERM/SIGKILL 在 Windows 是同一个 `TerminateProcess`（第二次 kill 无意义）；graceful 清理只能依赖 bridge 2s 内自退；建议代码显式标注 Windows 语义，并把清理预算写进注释/常量 | 【已验证】 |
| **W-08** | Low（L-13 在 Windows 不成立） | `lib/env.js:159-206` | 候选解释器「忽略 SIGTERM」/ alias 探测 | 无法复现永久 pending：Windows 上 kill=SIGTERM=TerminateProcess，Python handler 不执行；WindowsApps alias 探测 ms 级失败。仍建议加**整轮 discovery 总超时/watchdog**（防保护进程等极端情况） | 【已验证】 |
| **W-09** | Low | `lib/env.js:53-62`（`fsp.access(..., X_OK)`） | Windows 上没有 POSIX 执行位 | `X_OK` 在 Windows 恒真（普通数据文件、目录都通过）；该函数实际只验证“存在且是文件”。未来加 `.exe` 候选时依赖 probe 兜底即可，但注释/实现应写清平台语义 | 【已验证】 |
| **W-10** | Low | `lib/env.js:101-110, 120-122, 164` -> `resolveInterpreter` | `DSH_IPYNB_PYTHON=python`（Windows 用户最常见写法）或指向目录 | 值被 `path.resolve` 按宿主 cwd 解析成 `<repo>\python`（目录）→ spawn ENOENT/EPERM，错误信息误导；建议文档要求绝对路径，或先做「文件存在 + isFile」校验并给专门错误 | 【已验证】+【Lead 全权限实测】 |
| **W-11** | Low | `lib/env.js:17, 294-299` | 默认发现 0 个解释器 | 503 提示只让 `pip install jupyter_client ipykernel`，无法指向 Windows 布局问题；建议 detail 区分「未发现候选 / 候选都不可用 / 候选不可执行」，并在 README 加 Windows 排障段 | 【已验证】 |
| **N-01** | Nit | `lib/env.js:127` | 若未来按平台找到 `C:\Python314\python.exe` | `path.basename(path.dirname(path.dirname(file)))` 在 Windows 得到盘根/空串，label 变成 `PATH: C:\` 或 `PATH: `；建议取 `path.dirname(file)` 作为 label | 【已验证】（按推断路径实测 basename 行为） |
| **N-02** | Nit | `lib/kernel.js:386-414`（lastError 含 `WinError` 本地化文本） | 内核启动失败（如 cwd 无效 → `[WinError 267] 目录名称无效。`） | 错误文本随 Windows 显示语言本地化；跨语言界面下文案混杂（功能无影响） | 【已验证】 |
| **正-01** | — | `python/bridge.py:64-70`；`lib/kernel.js:96-101` | cp936 控制台下中文/emoji | **编码链路实测全部正常**（wire 严格 UTF-8、中文/emoji 原样往返）；无需修复 | 【已验证】 |

### W-01（High）Windows 默认解释器发现为 0 —— L-14 的 Windows 落地

- 触发：Windows 11 + 本机常规安装（Python 3.14 装在 `C:\Python314`，miniconda3 base 在 PATH，DSH bundled runtime 存在）。
- 证据命令与关键输出：
  - `node env_layout_probe.mjs`（`env.js` 默认 env，未设 `DSH_IPYNB_PYTHON`）：
    - PATH 中字面名为 `python`/`python3` 的文件：`[]`（`env.js:64-76` 只拼无扩展名候选，Windows 磁盘上是 `python.exe`）；
    - 实际存在 `python.exe` 的位置：`C:\Python314\python.exe`、`C:\Users\kexio\miniconda3\python.exe`（均不会被当前代码枚举）；
    - `python3.exe` 字面文件：`[]`（`python3` 命令其实是 WindowsApps 别名 `python3.exe`，而 `fs.stat` 对别名的结果见 W-09）；
    - conda：`%USERPROFILE%\.conda\environments.txt` 只有 `C:\Users\kexio\miniconda3`；`env.js:90-91` 查 `<env>\bin\python3` → **MISSING:ENOENT**，真实布局是 `<env>\python.exe` → file；
    - bundled：`DSH_PRIMARY_RUNTIME` 未设置，回落 `DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\python\bin\python3` → **MISSING:ENOENT**；真实是 `...\dependencies\python\python.exe` → file。
  - `default_discovery: {"interpreters":[],"default":null}`（【已验证】；与【Lead 全权限实测】一致）。
  - 后果（【Lead 全权限实测】）：`/execute`、`/restart` 等返回 503；`test/e2e.test.mjs` 默认 503，设 `DSH_IPYNB_PYTHON=C:\Python314\python.exe` 后 2306ms 通过。
- 契约依据：README.md:36 / README_ZH.md:36 明确承诺「`DSH_IPYNB_PYTHON` → conda → PATH `python3`/`python` → DSH 内置 Python」的发现顺序，且未声明平台限制；package.json 无 `os` 限制、CI 见 `04-tests-ci.md`。因此这是**功能承诺在 Windows 上不成立**。
- 建议（P0）：按平台生成候选：
  - PATH：Windows 候选 `python.exe` → `python3.exe`（PATHEXT 语义），并跳过 `\AppData\Local\Microsoft\WindowsApps\`（应用执行别名不是解释器）；
  - conda：`<env>\python.exe`（Windows）而不是 `<env>\bin\python3`；
  - bundled：`<dependencies>\python\python.exe`（Windows），而非 `python\bin\python3`；
  - 每个候选仍走 probe（`jupyter_client`/`ipykernel` 导入）过滤，天然排除 Store 别名与非目标环境；
  - 给整轮 discovery 一个总超时（见 W-08）。

### W-02（Medium）bundled Python 路径 + 能力双重落空

- 证据：`dependencies\python\` 目录清单为 `DLLs, Lib, Scripts, include, libs, python.exe, python3.dll, python312.dll, pythonw.exe, ...`（无 `bin/`）；`env.js:129-147` 两种拼接都指向 `...\python\bin\python3`（MISSING）。
- 即使按 Windows 布局改成 `dependencies\python\python.exe`：该解释器 **没有 jupyter_client/ipykernel**（`ModuleNotFoundError`），probe 会得到 ok:false。当前行为是「静默消失」（`discoverUncached` 对非 `DSH_IPYNB_PYTHON` 的解析失败直接 `continue`，`env.js:212-238`），用户完全看不到原因。
- 建议：平台化路径 + 把 bundled 条目作为可见的 ok:false（detail: `ModuleNotFoundError: No module named 'jupyter_client'`），并提示「安装系统 Python 或设置 DSH_IPYNB_PYTHON」；README 增加 Windows 安装章节（`python -m pip install ...`）。

### W-03（Medium）连接文件（`%TEMP%\tmp*.json`）在非优雅退出路径泄漏

- 事实链：`bridge.py:148-151` 构造 `KernelManager(...)` 时**没有设置 `connection_file`** → jupyter_client 8.10 `connect.py:119-122` 用 `tempfile.mkstemp('.json')` 在系统 TEMP 建连接文件；正常 `shutdown` 时 `km.shutdown_kernel(now=True)` 会 `cleanup_connection_file()`（`manager.py:591-594`），文件被删；但 bridge 被 TerminateProcess / 启动失败路径不会执行清理。
- 实测（`scenario-basic.json` / `scenario-kill.json` / `scenario-l4.json` / `scenario-m5.json`）：
  - 正常 shutdown：`returncode 0, elapsed_s 0.174`；50ms 后内核 gone、`conn_file_exists=false`、无残留；
  - `proc.kill()`（TerminateProcess，等价 Node `SIGTERM`）：bridge exit code 1；内核 ≤100ms 消失；但 `conn_file_exists=true` 持续到 10s 采样结束（文件 `C:\...\Temp\dsh-1OtCKz\tmph2a0ca_u.json` 保留）；
  - 启动故障注入（`fail_client`/`fail_start_channels`）、慢 restart 中被杀（`m5b`，`tmprijk3gzk.json`）同样残留；
  - 本会话 `%TEMP%` 现有 16 个 `tmp*.json`（281B/个，本次实验产生），说明泄漏会累积；本机 `%APPDATA%\jupyter\runtime` 另有 766 个历史 `kernel-*.json`（非本插件证据，仅说明这类文件确实会堆积）。
- 建议：给 `KernelManager` 传显式 `connection_file` 到可控目录并在 bridge 退出/异常路径 `finally` 清理；kernel.js 在 kill 后按记录的路径清理；或至少在 `handleExit` 的 stderrTail/lastError 中提示。

### W-04（Medium）用户 cell 里 spawn 的子进程不会被回收（孤儿，Windows 专属严重化）

- 实测 `grandchild_probe.py`（cell 代码 `subprocess.Popen([sys.executable, '-c', 'time.sleep(120)'])`）：
  - 硬杀 bridge：内核 24028 在 ≤1s 内退出（ipykernel 父句柄回收），但 grandchild 13780 **5s 后仍 running**；
  - **正常 shutdown**：内核退出，grandchild 3036 **5s 后仍 running**（bridge 只 `km.shutdown_kernel(now=True)`，不杀内核的子进程；Windows 无进程组，jupyter_client 的 `CREATE_NEW_PROCESS_GROUP` 只在 `independent=True` 时设置，`launcher.py:120-121`）。
- 影响：notebook 里常见的 `subprocess.Popen`/长驻服务/测试服务器在关闭 notebook、切解释器、甚至正常 shutdown 后残留；`kernel.js` 的 `kill()` 只对 bridge 单 PID 发 TerminateProcess（`lib/kernel.js:601-616`），Windows 下无法波及子进程树。
- 建议（P1）：`disposeAll`/`shutdown`/`kill` 时用 Job Object（bridge 与 kernel 加入 kill-on-close job）或 `taskkill /PID <bridge-pid> /T /F` 回收整棵树；或让 bridge 在 `shutdown_kernel` 时按 `psutil`/`os.kill` 递归清理其子孙（跨平台同理，但 Windows 没有 SIGTERM 兜底，必须显式做）；README 记录该边界。

### W-05（Medium）M-3 在 Windows 复现：IOPub 忙等 20,215 次/秒

- 注入：第 2 次 `KernelManager.client()` 返回 `start_channels()` 抛错的 client（模拟新内核已起、新 client 初始化失败）。
- 实测（`scenario-m3.json`，`get_iopub_msg` 计数）：0.1s 间隔两次计数 `14,671 → 35,048`，即 **20,215 次/秒**（Mac 审查为 14,963 次/秒）；期间只有一条 `log`（`restart channels failed: injected start_channels failure`），**没有 `ready`（op_id=1）/`kernel_died`**；`status` 仍立即响应（`status_reply alive=true`），随后 `execute` 会得到 `AssertionError` + `execute_reply{ok:false}`（不挂起但必然失败）。
- 宿主后果（与 Mac 相同）：`/ipynb/restart` 只能等 30s ready 超时（`lib/kernel.js:151-167`），随后 `failReady` → `kill()` → bridge TerminateProcess，内核由 ipykernel 父句柄回收、连接文件泄漏（W-03）。
- 建议：沿用 Mac M-3 修复并在 Windows 复测；IOPub 忙等对笔记本续航/风扇影响明显。

### W-06（Medium）M-5 在 Windows 复现：同步 restart 阻塞控制面，清理路径更差

- 注入：`KernelManager.restart_kernel` 前先 sleep 3s（模拟慢重启）。
- 实测（`scenario-m5.json`）：restart 请求后 0.4s 发 `status`，**3.981s 后才收到 `status_reply`**；`ready{op_id:5}` 延迟 4.382s；期间 `execute`/`shutdown` 都排在 stdin 不被读取。
- Windows 严重化：宿主侧 `kernel.js:564-599` 在 shutdown 2s 宽限后 `kill('SIGTERM')` = TerminateProcess → bridge 无机会执行 `shutdown_kernel()`；实测「慢 restart 中硬杀」（8s 注入、+1.5s kill）：bridge exit 1，内核 ≤100ms 被 ipykernel poller 回收，连接文件残留。即 **M-5 的「控制面失去响应」在 Windows 上直接退化为「清理不可执行」**。
- 建议：同 Mac（restart 移出 command_loop，单 worker/异步任务；shutdown/interrupt/status 保持响应）；Windows 附加：若 restart 超过宿主 grace，至少让 bridge 的信号兜底可用（目前不可能，见 W-07），或由 host 侧 Job Object 兜底。

### W-07（Low）M-11 的 SIGTERM→SIGKILL 升级在 Windows 上是同一原语

- 实测 `node_kill_probe.mjs`（Node v24.19.0/win32）：
  - `child.kill('SIGTERM')` → 安装过 `signal.signal(SIGTERM, handler)` 的 Python 子进程 **14ms 内退出**（含前置 600ms 的观测窗口），`signal handler 标记文件未生成`→ handler 从未执行；`'exit'` 事件 `{code:null, signal:'SIGTERM'}`；
  - `child.kill('SIGKILL')` → 同样 `{code:null, signal:'SIGKILL'}`（对已死进程 kill 不抛错：`kill_after_exit: {threw:null, exitCode:0}`）。
- 因此 `kernel.js:601-616` 的 `SIGTERM` 2s 后 `SIGKILL` 在 Windows 上**没有升级语义**：第二次 kill 对已死进程是 no-op，对仍存活进程与第一次等价；`bridge.py:214-224` 的信号处理器在 Windows 上**永远不会被调用**（只有 CTRL_C_EVENT/CTRL_BREAK_EVENT 会触发 Python handler，Node kill 不用它们）。
- 建议：Windows 分支下把「2s 宽限后 TerminateProcess」写成显式语义（去掉误导性的 SIGKILL 计时器或注释说明），并接受「非优雅清理」为 Windows 现状；真正的清理兜底用 Job Object/taskkill /T（W-04）。正常路径不受影响：实测 bridge 正常 shutdown 仅 174ms（【Lead 全权限实测】kernel.js 层 1170ms 含 HTTP/等待）。

### W-08（Low）L-13 在 Windows 不成立，但仍缺总 watchdog

- Mac L-13 场景「候选忽略 SIGTERM → `execFile` 永不 settle → discovery 永久 pending」在 Windows 上不可构造：Node `execFile` 超时用 `kill('SIGTERM')`，而 Windows 上它等于 `TerminateProcess`，普通 Python 进程无法忽略（W-07 实测 handler 不执行、14ms 退出）。
- WindowsApps 别名（任务要求的实验 7）：直接执行 `...\WindowsApps\python3.exe -c "print(1)"` → **rc=9009、stdout/stderr 空**（本机；【Lead 全权限实测】Node 侧探测 9ms 返回 EACCES）→ 若未来把 `.exe` 加进候选，alias 会**快速失败**而不是挂死；但当前代码**根本枚举不到它**（名字没有 `.exe`，且 `fs.stat` 对该 reparse point 返回 `MISSING:EACCES`，见 W-09）。
- 残余风险【推测】：受保护进程/驱动挂起等极端情况下 TerminateProcess 也可能不生效；`discoverUncached`（`env.js:208-272`）没有整轮超时，`inflight` 期间 `/interpreters` 会一直 pending。建议加 15-20s 总 watchdog（与 Mac L-13 建议一致），代价低。

### W-09（Low）`existsExecutable` 的 `X_OK` 在 Windows 无意义

- 实测（`env_layout_probe.mjs`）：
  - `fsp.access(<普通数据文件>, X_OK)` → 通过；`fsp.access(<目录>, X_OK)` → 通过（Windows 无执行位，X_OK≈F_OK）；
  - WindowsApps 别名：`fs.stat` → `MISSING:EACCES`（沙箱内），`fs.access(..., X_OK)` → 通过；`fs.realpath` → EACCES（沙箱内可能更严格；宿主侧 stat 可能成功，但无论如何 probe 会拒绝它）。
- 影响：当前代码不会因此误选（候选都是显式路径且 probe 过滤），但**实现注释「Is executable」在 Windows 是误导**；若按 W-01 加 `.exe` 候选，需保证 `existsExecutable` + probe 双保险，并跳过 `WindowsApps`，避免 Store 弹窗/9009 噪声。建议在 `env.js` 中注释平台差异，probe 失败细节保留 `error.code`（如 EACCES/ENOENT）以便诊断。

### W-10（Low）`DSH_IPYNB_PYTHON` 的相对值/目录值被接受

- 实测（`env_layout_probe.mjs`）：`DSH_IPYNB_PYTHON=python` → 候选路径变成 `C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb\python`（**目录**，`path.resolve` 相对宿主 cwd），条目 `ok:false`；`DSH_IPYNB_PYTHON=C:\...\dsh-bsb-ipynb\python` 同样；`c:/python314/python.exe` 经 `realpath` 规范化为 `C:\Python314\python.exe`（与【Lead 全权限实测】一致）。
- 【Lead 全权限实测】：`DSH_IPYNB_PYTHON=python` 对应 spawn 错误 **ENOENT**（而非清晰提示）；`spawn` 一个目录在本机 Node 探针里同样是 `error ENOENT, pid undefined`（`node_kill_probe.mjs`）。
- 建议：`collectCandidates` 对 `DSH_IPYNB_PYTHON` 先 `stat` 校验 isFile，不是文件则返回专门错误（例如 `interpreter-unknown: DSH_IPYNB_PYTHON must be an absolute path to a python executable`）；README/安装文档给出 Windows 示例 `setx DSH_IPYNB_PYTHON C:\Python314\python.exe`。说明：`bridge.py` 的 spec 只在「选中解释器」时使用 `sys.executable`（`bridge.py:136`），配置错误目前只能靠 spawn 报错暴露。

### W-11（Low）默认 503 的错误提示无法定位 Windows 问题

- `env.js:17` 的 HINT 只覆盖「包没装」；而 Windows 默认故障是「候选枚举不到」→ 用户被引导去 `pip install`（可能已经装好），真正修复是设 `DSH_IPYNB_PYTHON`。`resolveInterpreter`（`env.js:288-319`）只在候选存在时给出 detail；候选为空时无法区分原因。
- 建议：Windows 下 503 文案追加「未发现候选解释器；可设置 `DSH_IPYNB_PYTHON` 指向已安装 jupyter 的 python.exe（Windows: `%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe` 或 `python -c "import sys; print(sys.executable)"`）」；README 增加 Windows 排障小节。

---

## 3. Mac 审查条目在 Windows 上的复核

| 条目 | Mac 结论（CODE_REVIEW.md） | Windows 实测结论 | 差异 / 严重度 | 证据 |
| --- | --- | --- | --- | --- |
| **L-14** | 【契约核对】解释器发现是 Unix 布局；Windows 默认 0 个 → 503；仅要求平台化 | **成立且更严重**（High，W-01）：实测 PATH 可枚举 `python.exe` 两处、conda `python.exe` 一处、bundled `dependencies\python\python.exe` 一处，但代码全部枚举不到；且 bundled 即使修路径也无 jupyter（W-02） | 从「契约核对」升级为【已验证】；修复必须同时改 3 处布局 + alias 过滤 | `env_layout_probe.mjs` 输出；`default_discovery:{"interpreters":[]}`；【Lead 全权限实测】同上 |
| **L-13** | 【已验证】探测超时只发 SIGTERM，忽略 SIGTERM 的候选使 discovery 永久 pending | **不成立（Windows 语义不同）**：`kill('SIGTERM')`=`TerminateProcess`，Python handler 不执行，无法被忽略（14ms 退出）；WindowsApps alias 探测快速失败（9009/EACCES），不会挂死 | Windows 上降为 Low：只需补整轮 watchdog 的健壮性建议（W-08） | `node_kill_probe.mjs`；alias `rc=9009`；【Lead 全权限实测】EACCES 9ms |
| **M-3** | 【已验证】restart 失败路径不回滚：IOPub 无退避忙等 14,963 次/秒、无 kernel_died/ready、宿主等 30s | **成立，且忙等速率更高**：实测 **20,215 次/秒**；`status` 可响应、`execute` 得到 AssertionError；无 ready/kernel_died；宿主 `/restart` 同样只能等 30s（W-05） | 同源同修；Windows 无额外差异（jupyter_client/ipykernel 版本相同） | `scenario-m3.json` |
| **M-5** | 【已验证】restart 在 command_loop 同步阻塞：ready 3.336s、shutdown 2s 后仍未处理、SIGTERM 才退出 | **成立**：3s 慢重启实测 status 被阻塞 **3.981s**、ready 4.382s；Windows 上宿主 shutdown 超时后 TerminateProcess，bridge 清理不可执行（W-06） | Windows 更差：POSIX 还有 SIGTERM handler 兜底，Windows 完全没有 | `scenario-m5.json` |
| **M-11** | 【已验证】shutdown 2s 时 SIGTERM、再 2s SIGKILL，外层 grace 2.5s；管理器无条件删除条目，旧 bridge 仍活也不报告 | **部分不同**：Windows 上两次 kill 是同一 TerminateProcess（无升级语义）；正常路径 bridge 174ms 退出（kernel.js 层 1170ms）→ 宽限极少触发；但一旦触发，bridge/内核清理都不执行，残留连接文件（W-03/W-07）。ipykernel 本身会被父句柄 poller 回收（≤1s），不会长期孤儿 | 「旧 bridge 仍活」在 Windows 不会被 SIGKILL 补救（第二次 kill 无效）；内核孤儿风险反而低（poller） | `node_kill_probe.mjs`；`scenario-kill/m5`；【Lead 全权限实测】硬杀后 ipykernel 退出 |
| **L-4** | 【已验证】start_kernel 成功后 `kc.start_channels()` 不在清理 try 内；启动失败/SIGTERM 时看不到资源，内核可能残留 | **成立但后果减轻**：故障注入 `fail_client`/`fail_start_channels` → bridge 退出（rc 1，`kernel_died` 事件正常发出），内核短暂残留（0.1/0.5s 采样仍 alive，≤1s 后被 ipykernel poller 回收）；`wait_for_ready` 失败路径有 `km.shutdown_kernel(now=True)` 清理；**但三类路径都泄漏连接文件**；启动中被硬杀（`stall_after_start` + kill）内核 ≤100ms 被回收、连接文件残留 | Windows 上僵尸内核风险低（父句柄 poller），连接文件泄漏是一致的额外成本 | `scenario-l4.json` |
| **L-1** | 【已验证】`/execute` 的 `end()` 遇背压只为 `res.once('drain')` 注册，无超时兜底，半开连接时响应永不结束 | **未在 Windows 复跑**：该路径是纯 Node `http.ServerResponse` 逻辑（`lib/routes.js:306-327`，无平台分支），Windows 与 Mac 行为应一致；macOS 侧结论按【契约核对】继承 | 无平台差异；本报告不重复验证 | 静态复核 `lib/routes.js:306-327`；Mac 审查脚本未随仓库 |

补充复核（Mac 审查未覆盖、但 Windows 实测已确认的正向结论）：
- 真实内核 e2e（bridge 层）：ready 1689ms；`print("中文😀 café Ω")`、`execute_result`、stderr、`ValueError("中文错误😀")` 的 evalue 全部原样返回；28 行 stdout 全部严格 UTF-8 可解码（`scenario-basic.json`）。
- interrupt：`time.sleep(60)` 执行中发 `{"op":"interrupt"}` → **4.395s** 后得到 `execute_reply{status:"interrupted", error:"interrupt timed out; kernel restarted", kernel_restarted:true}`，内核 PID 变化、新内核立即可用（46ms），同批队列中的第二格立即收到 `cancelled`（`dropped 1 queued execution(s)`）。机制与 ipykernel 源码一致：Windows 上 `interrupt_request` 是 no-op（`ipykernel/kernelbase.py:1097-1099` 打印 "Interrupt message not supported on Windows"），bridge 的 3s 宽限 fallback 生效。
- restart：1.388s ready（op_id 回显），内核 PID 变化，**连接文件复用同一个**（`conn_file_same=true`），重启后 execute 30ms 正常。
- cwd：包含空格 / 中文 / emoji 的目录作为 `--cwd` 启动内核并 `os.getcwd()` 原样返回；`--cwd` 目录不存在 → `kernel_died: kernel start failed: [WinError 267] 目录名称无效。`、bridge rc=1、没有内核启动；**bridge.py 自身放在含空格路径**下也正常（Python 直驱验证；Node spawn 用数组参数无语义差异）。
- `input()` 在 `allow_stdin=False` 下快速失败（88ms，`StdinNotImplementedError`），不会阻塞。

---

## 4. 关键数字汇总（便于回归对比）

| 场景 | Windows 实测 | 备注 |
| --- | --- | --- |
| bridge ready（首次） | 1689–1735ms | 真实 ipykernel |
| 正常 shutdown | 174ms；内核 50ms 内 gone；连接文件已删 | graceful 路径健康 |
| 硬杀 bridge（TerminateProcess） | bridge 5ms 退出；内核 ≤1s 被 ipykernel poller 回收；连接文件残留 | 无长命 ipykernel 孤儿 |
| 用户 cell 子进程（grandchild） | 硬杀/正常 shutdown 后均 5s+ 仍存活 | Windows 无进程树回收 |
| interrupt fallback | 4.395s 内 interrupted + kernel_restarted；队列立即 cancelled | ipykernel Windows no-op |
| restart（空闲） | 1.388s；PID 变；连接文件复用 | |
| restart 失败（注入） | IOPub 20,215 次/秒忙等；30s ready 超时 | M-3 |
| 慢 restart（3s 注入） | status 阻塞 3.981s；ready 4.382s | M-5 |
| cwd 空格/中文/emoji | 全部正常 | |
| 启动失败（注入 client/start_channels） | `kernel_died` + rc1；内核 ≤1s 回收；连接文件残留 | L-4 |
| UTF-8 wire | 28/28 行严格 UTF-8；中文/emoji 精确往返 | cp936 环境 |

【Lead 全权限实测】交叉对照（真实 `lib/kernel.js`）：首次 ready 1722ms；`print("中文😀")` 原样返回；interrupt 4886ms → interrupted/kernel_restarted，PID 2740→17156；restart 1378ms → PID 17532；shutdown 1170ms 且 bridge/ipykernel/manager 状态清空；`process.kill SIGTERM` → bridge exit code 1 **signal null**（TerminateProcess；与 Node 探针 `{code:null, signal:'SIGTERM'}` 的记录差异仅在于 kernel.js 拿到的 `signal` 参数，见下方注意事项）；4s 后 ipykernel 已退出（未孤儿）；cwd 含中文/空格/emoji 正常；WindowsApps `python3.exe` 探测 9ms EACCES；`DSH_IPYNB_PYTHON=python` → repo\python → spawn ENOENT。

> 注意（证据一致性）：Lead 记录 `exit code 1 signal null`，本报告 `node_kill_probe.mjs` 记录 `'exit'` 事件 `{code:null, signal:'SIGTERM'}`。两者都表明「非自然退出且 code 非 0」，但 `signal` 值来源不同：Lead 的观测可能来自 `child.on('exit')` 在真实 kernel.js 上下文（Node 对 Windows 被杀子进程通常给 `signal=null`），而本探针显式记录 Node 24.19 的 `signal:'SIGTERM'`。**结论不受影响**（都表示 TerminateProcess、Python handler 未执行，已由 handler 标记文件证明）；若后续要写 UI 文案，建议以 `exitCode/signalCode` 双读为准，不依赖 `signal` 字符串。

---

## 5. 复现命令（全部只读仓库；脚本与证据在 `%TEMP%`）

```powershell
# 工作目录（会话级 TEMP；脚本由 write 工具放在字面 %TEMP%\dsh-win-review 下，
# 因沙箱只允许往会话 TEMP 写，故复制到 $env:TEMP 后执行）
$w = "$env:TEMP\dsh-win-review\win-kernel-env"
$env:PYTHONIOENCODING='utf-8'; $env:WIN_REVIEW_WORK=$w

# 1) 真实 bridge + 真实 ipykernel 全场景（basic/kill/interrupt/restart/cwd/l4/m3/m5）
C:\Python314\python.exe "$w\scenarios.py"
C:\Python314\python.exe "$w\digest.py"        # 生成紧凑摘要

# 2) 用户子进程孤儿实验
C:\Python314\python.exe "$w\grandchild_probe.py"

# 3) Node 原语语义（kill/SIGTERM/ENOENT；只用 stdio:'ignore'，沙箱可跑）
node "$w\node_kill_probe.mjs"

# 4) env.js 布局与探测证据（纯 fs + import；不 spawn）
node "$w\env_layout_probe.mjs"

# 5) 辅助环境事实
cmd /c chcp; Get-Command python,python3; py -0p
C:\Users\kexio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe -c "import jupyter_client"
```

沙箱注意事项（复现者必读）：
- Node 管道 stdio 在 `workspace-write` 下 `EPERM`（本报告所有 bridge 驱动都走 Python 管道）；
- 沙箱内 jupyter_core `secure_write → win32_restrict_file_to_user → SetFileSecurity` 会 `WinError 5`，harness 用 `sandbox_compat/sitecustomize.py` 置空该函数（仅取证用，非产品问题；Lead 全权限运行无此问题）；
- 场景脚本的故障注入通过 `wrapper.py` 包装 `bridge.py`（`runpy.run_path`），`DSH_TEST_INJECT` 环境变量选择注入点（`fail_client`、`fail_start_channels_restart`、`fail_wait_ready`、`slow_restart`、`stall_after_start`、`count_iopub`、`devnull_log`）；
- 每个场景结束都会清理自己启动的 bridge/内核（`Get-Process python` 确认无残留；本报告结束时会话内无残留 python/node 进程；16 个 `%TEMP%\tmp*.json` 连接文件是本报告实验泄漏证据，保留在会话 TEMP 未删除）。

---

## 6. 未能验证 / 留给后续

1. **`lib/kernel.js` 本体在 Windows 上的完整生命周期**：沙箱禁止 Node 管道 spawn，未能在本会话用 `KernelManager` 直跑；仅用【Lead 全权限实测】（ready/interrupt/restart/shutdown/硬杀）与本报告的 bridge 层 + Node 原语证据交叉。结论可信度高，但 kernel.js 的 30s ready 超时、`disposeAll` 时序、`handleStdinError` 的 Windows 触发未逐条实测。
2. **`execFile` 在 Windows 宿主上的精确行为**（alias SPAWN EACCES vs Python `subprocess` rc9009 的差异）：沙箱无法跑 `execFile`；用 Node kill/spawn 原语 + Lead 全权限 alias 探测替代。
3. **venv 解释器在 Windows 的识别**：`resolveInterpreterIdentity`（`env.js:101-110`）用 `dirname(dirname(exe))\pyvenv.cfg`，Windows venv 的 `<venv>\Scripts\python.exe` 恰好满足，逻辑上应保留 venv 身份（测试 `test/interpreter.test.mjs` 第二段也有 win32 `Scripts` 分支）；但未实测 `DSH_IPYNB_PYTHON=<venv>\Scripts\python.exe` 的端到端发现+执行。
4. **UNC 路径 / >260 字符路径 / 8.3 短名 / 子盘符相对路径**：未测（仓库路径较短；CreateProcess 对 cwd 的长路径支持依赖 manifest 与注册表，风险【推测】）。
5. **ipykernel 内部 Windows no-op 警告的可观测性**：尝试把内核 stderr 从 `subprocess.DEVNULL` 重定向到文件后仍为 0 字节（ipykernel 的日志没有落到继承 stderr），因此只能以源码（`kernelbase.py:1097-1099`）+ 3s fallback 行为确认；bridge `stderrTail`（`lib/kernel.js:124-127`）在 Windows 上大概率拿不到该警告，宿主无法在 `/status` 里解释「为什么 interrupt 变成 restart」→ 建议 bridge 在 fallback 时已发出的事件 `error/message` 足够，但属 UX 可改进项。
6. **`taskkill /T /F` / Job Object 修复方案**未实测（W-04 建议）；`kernel-stderr.log` 捕获在 m3 场景也是 0 字节，原因同上。
7. **非 ipykernel 内核**（其他 kernelspec）与 `--kernel-name` 标签未测（bridge 固定 `ipykernel_launcher`，见 `bridge.py:136`；不在本任务重点）。
8. **L-1（routes 背压）** 未在 Windows 复跑（平台无关，按 Mac 已验证结论继承）。

---

## 7. 修复优先级（Windows 视角）

| 优先级 | 项 | 理由 |
| --- | --- | --- |
| **P0** | W-01（+W-02、N-01 一起）：`env.js` 解释器发现平台化；README Windows 安装/排障；503 文案（W-11） | 当前 Windows 开箱即用为 0 解释器，插件核心功能不可用；[README:36] 的承诺失效。Lead 已证明「设 `DSH_IPYNB_PYTHON` 即全部可用」，所以发现层是唯一堵点 |
| **P1** | W-04：进程树回收（Job Object / `taskkill /T /F` / bridge 递归清理）+ W-03 连接文件清理 | 正常 shutdown 也会泄漏用户子进程与 TEMP 连接文件；Windows 无 SIGTERM 兜底，必须显式回收 |
| **P2** | W-05（M-3）、W-06（M-5）随 Mac 修复一起做，并补 Windows 回归（IOPub 忙等速率、restart 期间 status/shutdown 响应） | 与 Mac 同源；Windows 忙等更快、清理路径更差 |
| **P3** | W-07（kill 语义注释/简化）、W-08（总 watchdog）、W-09/W-10（配置校验与平台语义注释）、L-4 启动失败清理 | 低成本、提高诊断质量与极端路径健壮性 |
| **回归测试** | `test/interpreter.test.mjs:48-49` 用 `<env>/bin/python3`（Unix 布局）构造候选，Windows 上该用例无法按原样通过（需 win32 分支，与 `04-tests-ci.md` 的 CI 矩阵建议合并） | 否则 W-01 修好后测试仍无法覆盖 Windows 发现逻辑 |

---

## 8. 与 Mac 审查的关系（一句话总结）

- **Windows 独有**：L-14 落地（High）、bundled 布局（W-02）、连接文件泄漏（W-03）、用户子进程孤儿（W-04）、Windows kill=TerminateProcess（W-07）、`X_OK` 语义（W-09）、`DSH_IPYNB_PYTHON` 目录/相对值陷阱（W-10）。
- **跨平台同源**：M-3（Windows 忙等更快）、M-5（Windows 清理更差）、M-11（升级语义退化）、L-4（残留副作用是连接文件）、L-13（Windows 不成立）、L-1（平台无关，未复跑）。
- **正向确认**：cp936 控制台下 UTF-8 全链路正常、中文/emoji 往返无损、interrupt fallback 与 restart 在 Windows 可用、cwd 含空格/中文/emoji 正常、ipykernel 父句柄 poller 让内核不会长期孤儿（这是 Windows 相比 Mac 的「意外保险」，但不能替代 plugin 自己的清理责任）。

---

*本报告新增文件：`docs/windows-review/01-interpreter-kernel.md`。未修改源码、测试、package.json，未 git add/commit。实验脚本见 §5 的 `%TEMP%` 路径（不入库）。*
