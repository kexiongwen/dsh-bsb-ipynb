# dsh-bsb-ipynb Windows 侧代码审核报告

> **审核性质**：本报告是 Windows 侧的实机代码审查，与 [CODE_REVIEW.md](CODE_REVIEW.md)（2026-11-07 macOS 快照）互补。行号以仓库 HEAD `8c1ad8e`（工作树干净）为准；本次审查未修改任何源码、测试、README 或 CI。
> **审核日期**：2026-11-07（Windows 11 实机）。
> **一句话结论**：Windows 上存在 **1 个 High 级阻断缺陷**——默认安装下解释器发现为 0，`/ipynb/execute` 返回 503，插件核心功能（运行 notebook）开箱不可用；设置 `DSH_IPYNB_PYTHON` 绝对路径后可绕过。另有 8 个 Medium 级问题（含 Windows 专属的连接文件泄漏、用户子进程孤儿、只读/锁定文件保存失败、Windows 绝对路径导致的 Markdown 图片裂图、M-6 TOCTOU、测试静默 skip 等）和一批 Low/Nit 级问题。核心内核链路本身在 Windows 上健壮：真实 ipykernel start/execute/interrupt/restart/shutdown 全部实测可用，UTF-8/中文/emoji 无损，含空格与中文的 cwd 正常。（**该 High 缺陷已在同会话修复并复测，Windows CI 也已加入，见 §9。**）
> **详细证据**：四个子域的完整报告见 `docs/windows-review/01-interpreter-kernel.md`（解释器/内核）、`02-paths-storage.md`（路径/存储）、`03-client-docs-integration.md`（客户端/文档/集成）、`04-tests-ci.md`（测试/CI）。

## 0. 审核环境（实测）

| 项 | 值 |
| --- | --- |
| OS | Windows 11，build `10.0.26300`（`Win32_OperatingSystem` 拒绝访问，按 `NT 10.0.26300` + 桌面版元数据）；NTFS，大小写不敏感，8.3 短名开启 |
| Node / npm | Node **v24.19.0** / npm 11.17.0 |
| Python | **3.14.7**（`C:\Python314\python.exe`）；PATH 上另有 miniconda3 base `python.exe`；`python3` 指向 Microsoft Store 的 `WindowsApps\python3.exe` 应用执行别名 |
| Kernel 依赖 | jupyter_client **8.10.0** / ipykernel **7.4.0** / nbformat **5.11.1** |
| 控制台 | ACP **cp936（GBK）**；pwsh `[Console]::OutputEncoding`=UTF-8，两者不一致（不影响内核输出链路，见 §3.1 正向） |
| DSH 桌面版 | **0.2.2-rc.1**（`DeepSeek Harness.exe` FileVersion 0.2.2-rc.1；asar 内 `@deepseek-ai/dsh-desktop`、`desktop-runtime.json` release.version、`sharedPackages.@deepseek-ai/dsh` 全部 0.2.2-rc.1），与 `engines.dsh >=0.2.2-rc.1` 精确匹配，**无版本阻断** |
| 版本误报来源 | `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\runtime.json` 的 `desktopVersion: 0.2.1-rc.3` 是 2026-10-23 的旧缓存副本；全局 npm `dsh` CLI 0.1.0-rc.6 属另一产品线 |
| DSH 运行时 | `...\dsh-primary-runtime\dependencies\{node,pnpm,python}\`；内置 Python 实际在 `dependencies\python\python.exe`（3.12.14），**无** `bin/` 目录，`Lib\site-packages` **无** jupyter_client/ipykernel |
| better-sidebar | **0.30.1**（安装于 profile `node_modules`，自带 Windows 支持与 `src/`） |
| 插件安装 | profile bundle 列表含 `dsh-bsb-ipynb`；依赖 `link:C:/Users/kexio/Desktop/GitHub/dsh-bsb-ipynb`；`node_modules/dsh-bsb-ipynb` 为 Junction→仓库；plugin-manager pnpm 日志（16:07）安装成功 |
| DSH Web GUI | `http://127.0.0.1:56606`，匿名访问返回 401（宿主 admission fence），无法从 HTTP 侧做真实浏览器 UI 验证 |

**方法限制**：DSH 会话默认沙箱下 Node 的 pipe stdio 子进程 spawn 会 `EPERM`（`npm test` 与真实内核测试无法在沙箱内跑）；本报告的全量子进程/内核实验均在完整访问权限下运行。真实浏览器 UI 因 401 未验证（相关结论标注【推测】/【契约核对】）。

## 1. 全量测试：Windows 实测对照（`npm test`）

命令：`node --test --test-timeout=180000 test/*.test.mjs`（Windows 实机，完整访问权限）。

| 运行配置 | tests | pass | fail | skip | 耗时 |
| --- | --- | --- | --- | --- | --- |
| Windows 基线（不设环境变量） | 292 | **238** | **51** | **3** | 30.40s |
| Windows **修复后**（不设环境变量） | 292 | **248** | **0** | **44** | 29.62s |
| Windows 修复后（同时设 `DSH_IPYNB_PYTHON` / `DSH_IPYNB_TEST_PYTHON`） | 292 | 248 | 0 | 44 | 29.36s |
| + `DSH_IPYNB_TEST_PYTHON=C:\Python314\python.exe` | 292 | 238 | 51 | 3 | ~29.8s（与基线**逐条零差异**） |
| + `DSH_IPYNB_PYTHON=C:\Python314\python.exe`（插件侧） | 292 | **243** | **48** | **1** | 29.75s |
| macOS 快照基线（CODE_REVIEW.md） | 292 | 292 | 0 | 0 | 23.5s |

**逐文件结果（Windows 基线）**

| 文件 | tests | pass | fail | skip | 文件 | tests | pass | fail | skip |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bridge.test.mjs | 6 | 6 | 0 | 0 | kernel-lifecycle.test.mjs | 54 | 54 | 0 | 0 |
| client-lifecycle.test.mjs | 34 | 34 | 0 | 0 | kernel.test.mjs | 9 | 9 | 0 | 0 |
| client.test.mjs | 58 | 55 | 3 | 0 | notebook.test.mjs | 32 | 31 | 0 | 1 |
| control-symlink.test.mjs | 35 | 0 | 35 | 0 | package.test.mjs | 2 | 2 | 0 | 0 |
| e2e.test.mjs | 1 | 0 | 1 | 0 | routes.test.mjs | 22 | 16 | 4 | 2 |
| execute-disconnect.test.mjs | 19 | 19 | 0 | 0 | gate.test.mjs | 17 | 10 | 7 | 0 |
| interpreter.test.mjs | 3 | 2 | 1 | 0 | **合计** | **292** | **238** | **51** | **3** |

**51 个失败的根因分类**

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| (c) 环境权限：Windows 默认不允许创建文件符号链接 | **42** | `control-symlink.test.mjs` 35 + `gate.test.mjs` 7，全部 `EPERM, symlink`。宿主无 `SeCreateSymbolicLinkPrivilege`、未开开发者模式；**junction 与硬链接可用**。control-symlink 的守卫只判断「大小写不敏感文件系统」（NTFS 判定 true）→ 进入执行后失败；gate 无守卫。 |
| (b) 测试/宿主假设 | **6** | ① 3 个客户端 locale 用例（见 W-C9）；② `interpreter.test.mjs:37` 用 POSIX venv 布局 `bin/python3`，Windows 是 `Scripts\python.exe`；③ `routes.test.mjs:219` 用 `/etc/hosts` 构造工作区外绝对路径，Windows 上得到 404 而非 403；④ `routes.test.mjs:315` 用 `chmod(0o000)` 模拟不可访问，Windows 不改 ACL → 得到 409 而非 404，且 `process.getuid?.()===0` 守卫失效。 |
| (a) 真实代码缺陷（Windows 阻断级） | **3 + 2 假 skip** | 同一根因 W-A1：`lib/env.js` 解释器发现是 Unix 布局 → 默认 0 解释器。表现为 `e2e.test.mjs:99` 的 `/execute` 503、`routes.test.mjs:472` drain 未触发、`routes.test.mjs:515` 删除后 restart 503；`routes.test.mjs:350/542` 两个用例静默 `t.skip('no Python interpreter …')`，**把缺陷掩盖成 skip**。设置 `DSH_IPYNB_PYTHON` 后 +5 pass / −3 fail / −2 skip 全部转绿（见上表）。 |
| (d) 沙箱假象 | 0 | 基线在完整访问权限下采集；沙箱内 `npm test` 13 文件全 `spawn EPERM` 的记录不计入基线。 |

**静态检查与打包（Windows）**：`node --check` 逐文件 8/8 通过；`python -m py_compile python/bridge.py` exit 0；`npm pack --dry-run` **18 文件**，与 Mac 基线一致。另发现 README/CI 命令两个坑：① `node --check index.js lib/*.js client.js` 实际**只检查第一个文件**（Node 的 `--check` 只接受一个脚本，其余参数被忽略；Windows 的 cmd/pwsh 还不展开 glob）→ 假绿，应改成逐文件循环；② README 的 `python3 -m py_compile` 在 Windows 上落到 Store 别名（实测 exit 9009），应写 `python`。

## 2. 问题总览

| 级别 | 数量 | 主要项 |
| --- | --- | --- |
| **High** | **1** | W-A1 解释器发现为 0（Windows 核心功能 503） |
| **Medium** | **11** | W-A2 内置 Python 静默不可用；W-A3 连接文件泄漏；W-A4 用户 cell 子进程孤儿；W-A5 M-3 restart 失败忙等（Windows 更快）；W-A6 M-5 restart 阻塞控制面；W-B1 M-6 TOCTOU（junction 无特权）；W-B2 只读/锁定目标保存 500；W-B3 Windows 相对图片裂图；W-C1 Ctrl+S 大小写敏感；W-C8 测试 locale 依赖；W-D1 测试假 skip + CI 无 Windows |
| **Low** | **约 20** | W-A7 信号语义退化、W-A8 `X_OK` 无意义、W-A9 `DSH_IPYNB_PYTHON` 非绝对路径陷阱、W-A10 503 提示无法定位、W-B4 独占锁下 `/read` 500 internal、W-B5 硬链接别名并发保存（L-10 成立）、W-B6 junction 悬空后控制路径退化、W-B7 删除后大小写变体拼写匹配不到活内核、W-B8 BOM notebook、W-C2 Markdown 盘符图片被当 URL scheme、W-C3 快捷键文案只有 Cmd/Ctrl、W-C4 CRLF source 高亮多空行、W-C5 IME 守卫缺失（宿主 0.30.1 缓解）、W-C6 Tab 困住焦点、W-D2 文档/CI 平台假设、W-D3 `.gitattributes` 缺失、W-D4 issue 模板、W-D5 硬刷新说明等 |
| **Nit** | **约 5** | W-B9 错误消息泄漏绝对路径/PID、N-01 label 拼法、N-02 Windows 本地化错误文本、N-03 尾点/设备名 Node 版本相关行为、N-04 `node --check` 多文件假绿、N-05 locale json vs 内联词典 |

> 与 macOS 快照的关系：**L-14 升级为 High/W-A1（Mac 仅契约核对，本报告已实机复现）**；**M-3、M-5、M-6、M-8、L-5、L-6、L-8、L-10、L-13、L-16、L-17、L-21、M-7、M-9 的 Windows 复核结论见 §4**。Windows 新增（Mac 无对应）项为 W-A3、W-A4、W-B2、W-B3、W-C1、W-C4、W-D 系列。

## 3. 问题详表（按领域）

### 3.1 解释器发现 / 内核 / bridge（`lib/env.js`、`lib/kernel.js`、`python/bridge.py`）

| ID | 级别 | 位置 | 问题 | 证据与影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **W-A1** | **High（阻断）** | `lib/env.js:64-76,78-99,126-127,129-147` | Windows 默认安装下解释器发现为 0：PATH 只拼无扩展名 `python3`/`python`（Windows 上是 `python.exe`）；conda 只查 `<env>/bin/python3`（Windows 是 `<env>\python.exe`）；DSH 内置 Python 只查 `dependencies/python/bin/python3`（实际是 `dependencies\python\python.exe`）。README:36 承诺的发现顺序在 Windows 上全部落空 → `/ipynb/interpreters` 空、`/execute` 与首启 `/restart` 一律 **503 kernel-unavailable**。 | 【已验证】`discoverInterpreters({fresh:true})` → `{"interpreters":[],"default":null}`；设置 `DSH_IPYNB_PYTHON=C:\Python314\python.exe` 后 → 1 项 `ok:true`、`jupyter_client 8.10.0 · ipykernel 7.4.0`；全量测试对照 +5 pass（见 §1）。 | P0：按 `process.platform` 平台化候选（Windows：PATH 按 PATHEXT 展开 `.exe` 并跳过 `WindowsApps\` 应用执行别名；conda `<env>\python.exe`；bundled `<dependencies>\python\python.exe`），保留 probe 过滤；并给整轮 discovery 总超时。 |
| **W-A2** | Medium（诊断） | `lib/env.js:129-147,212-238` | 即使按 Windows 布局修好 bundled 路径，内置 Python **也没有 jupyter_client/ipykernel**（`ModuleNotFoundError`），而当前 `discoverUncached` 对非 `DSH_IPYNB_PYTHON` 的解析失败直接 `continue` → 条目静默消失，用户看不到原因。 | 【已验证】`dependencies\python\python.exe -c "import jupyter_client"` → ModuleNotFoundError；`runtime.json.pythonPackages` 无 jupyter/ipykernel。 | bundled 分支平台化，并把该条作为可见的 `ok:false` 条目返回（detail 带 ModuleNotFoundError）+ 提示安装系统 Python 或设置 `DSH_IPYNB_PYTHON`。 |
| **W-A3** | Medium | `python/bridge.py:148-151`；`lib/kernel.js:564-616`；jupyter_client `connect.py:119-122` | **连接文件泄漏（Windows 路径）**：`KernelManager` 未设置 `connection_file` 时 jupyter_client 8.10 把连接文件写到**系统 `%TEMP%\tmp*.json`**；正常 shutdown 会清理，但 **bridge 被 TerminateProcess 硬杀、启动失败、restart 失败**路径不会执行清理 → 文件残留并累积。 | 【已验证】正常 shutdown：174ms、内核 50ms 消失、`conn_file_exists=false`；`proc.kill()` 后 bridge exit code 1、内核 ≤100ms 消失，但 `conn_file_exists=true` 持续到 10s 采样结束；启动失败/慢 restart 被杀同样残留；一个会话内实测累积 16 个 `tmp*.json`。 | bridge 显式指定 `connection_file` 到可控目录并在退出/异常路径 `finally` 清理；或 host 侧在 kill 后按记录路径清理。 |
| **W-A4** | Medium（Windows 更严重） | `lib/kernel.js:564-616`（只 kill bridge 单进程）、`python/bridge.py:185-198,539-561`（只关内核进程） | **用户 cell 内 spawn 的长寿子进程不会被回收**：Windows 上 `proc.kill()` 只终止 bridge；bridge 的 shutdown 只 `shutdown_kernel`，不回收内核的子进程树。实测 cell 里 `subprocess.Popen(...)` 起的子进程在**正常 shutdown 与硬杀后均 5s+ 存活**（≠内核本身：ipykernel 由父句柄 poller ≤1s 回收，无长命内核孤儿）。 | 【已验证】用户子进程在 shutdown/硬杀后 5s+ 仍存活；内核进程 ≤1s 被 ParentPollerWindows 回收。 | Windows 上用 **Job Object（kill-on-close）** 或 `taskkill /PID <bridge> /T /F` 回收整棵进程树；README 说明该边界。 |
| **W-A5** | Medium（与 Mac M-3 同源） | `python/bridge.py:617-654`（restart 失败路径）、`418-450`（IOPub 泵）、`lib/kernel.js:151-164` | restart 时新内核已起、新 client `start_channels()` 失败：旧 client 被停但失败不回滚，`iopub_loop` 因新内核存活持续忙等，无 `kernel_died`/ready，宿主只能等 30s。Windows 上忙等速率更高。 | 【已验证】真实内核故障注入：IOPub 忙等 **20,215 次/秒**（Mac 实测 14,963）；事件只有 log、无 kernel_died。 | 同 Mac M-3 修复：失败统一停新 client/关 km/清 `kc/pending`、立即发 `kernel_died`；IOPub 连续异常加退避与有界失败。 |
| **W-A6** | Medium（与 Mac M-5 同源） | `python/bridge.py:657-692`（command_loop 同步 restart）、`lib/kernel.js:564-616` | restart 在 command_loop 线程内同步阻塞（`wait_for_ready(25)`）：期间 status/execute/interrupt/shutdown 全部排队。Windows 上宿主超时后只剩 TerminateProcess，bridge 的优雅清理不可执行。 | 【已验证】受控慢 restart：status 被阻塞 **3.981s**、ready **4.382s**；shutdown 写入后未处理。 | restart 移出 command_loop（单控制 worker/异步任务），保持控制面响应并明确重启期间 execute 语义。 |
| W-A7 | Low | `lib/kernel.js:564-616`；`python/bridge.py:200-224` | Windows 上 `SIGTERM` 与 `SIGKILL` 都是 **TerminateProcess** 同一原语：bridge 的 SIGTERM 优雅清理 handler 不会执行，2s 后的第二次 kill 无意义；`exit` 事件参数因进程而异（实测 Node 侧为 `signal:'SIGTERM'/code:1` 组合）。正常 shutdown 很快（bridge 层 174ms，kernel.js 层约 1.17s），宽限很少触发。 | 【已验证】Node 原语探针：`kill('SIGTERM')` 后 14ms 强制退出，Python handler 标记未写。 | 代码/注释显式标注 Windows 语义（kill 即强杀、无优雅信号），把清理预算写进常量；清理依赖显式 shutdown 协议而非信号。 |
| W-A8 | Low | `lib/env.js:53-62` | `fsp.access(file, X_OK)` 在 Windows 上恒真（普通数据文件也通过）；`existsExecutable` 实际只验证「存在且是文件」。 | 【已验证】Windows 无 POSIX 执行位。 | 注释/实现写明平台语义；未来加 `.exe` 候选时靠 probe 兜底。 |
| W-A9 | Low | `lib/env.js:101-110,120-122,164` | `DSH_IPYNB_PYTHON=python`（Windows 最常见写法）被 `path.resolve` 当相对路径（本仓库里解析成 `...\dsh-bsb-ipynb\python` 目录）→ spawn ENOENT；指向 Store 别名（`WindowsApps\python3.exe`）→ `EACCES realpath`，都只表现为「找不到解释器/503」。 | 【已验证】`DSH_IPYNB_PYTHON=python` → `path: ...\dsh-bsb-ipynb\python, detail:"spawn ... ENOENT"`；Store 别名 → `detail:"Not executable: EACCES ... realpath"`，9ms 返回不挂起。 | 文档要求绝对路径；对非绝对路径/裸命令/别名给专门错误提示。 |
| W-A10 | Low | `lib/env.js:17,294-299` | 默认 0 解释器时的 503 提示只说 `pip install jupyter_client ipykernel`，无法指向 Windows 布局问题。 | 【已验证】真实 `/execute` 503 文案。 | detail 区分「未发现候选/候选都不可用/候选不可执行」，README 加 Windows 排障段。 |
| N-01 | Nit | `lib/env.js:127` | PATH label 用 `path.basename(path.dirname(path.dirname(file)))`，Windows 下得到盘根/空串 → label `PATH: C:\`。 | 【已验证】构造路径验证。 | label 改用 `path.dirname(file)`。 |
| N-02 | Nit | `lib/kernel.js:386-414` | 内核启动失败错误含本地化 `WinError` 文本（如 `[WinError 267] 目录名称无效。`），跨语言界面下文案混杂。 | 【已验证】无效 cwd 注入。 | 功能无影响，可保留。 |

**正向实测（Windows 上确认正常）**：① 编码链路 28/28 行严格 UTF-8，`print("中文😀")`、stdout/stderr/execute_result/evalue 无损（bridge `reconfigure(utf-8)` + `PYTHONIOENCODING=utf-8`，内核内 `sys.stdout.encoding=UTF-8`）；② 真实内核首次 ready 1722ms；③ Windows interrupt 语义：`interrupt` 后约 4.4–4.9s 返回 `status:"interrupted", kernel_restarted:true`，内核 PID 改变（ipykernel 不支持 Windows interrupt，bridge 3s 宽限后强制重启，README 已描述该设计）；④ restart 1.388s、正常 shutdown 后内核确定性退出；⑤ 含空格/中文/emoji 的 notebook 目录作内核 cwd 正常；⑥ 硬杀 bridge 后 ipykernel 由父句柄 poller ≤1s 回收（无长命内核孤儿，但见 W-A4 用户子进程）。

### 3.2 路径授权与存储（`lib/gate.js`、`lib/notebook.js`、`lib/json.js`、`lib/routes.js`）

| ID | 级别 | 位置 | 问题 | 证据与影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **W-B1** | Medium（安全，= M-6 的 Windows 形态） | `lib/gate.js:64-85,152-185`（授权与 I/O 两次解析）、`91-150`（`walkTarget`）；`lib/notebook.js:308-331,384-457` | ① **预置越界 junction 被正确拒绝**（403 path-outside-root）；② 但**授权后把目标父目录替换为指向外部的 junction** → 越界读（读到外部内容）与越界写（成功覆盖外部文件）均复现。Windows 上创建 junction **不需要管理员/开发者模式**，攻击门槛不高于 macOS symlink。 | 【已验证】TOCTOU 读：`readStatus:"ok"`、`leakedMetadata:{"outside":"SECRET"}`；写：`save ok:true`、`outsideFileWrotePluginData:true`、无残留。 | 同 M-6：读路径绑定 fd（授权/打开/fstat/有界读取）；写路径绑定父目录身份（dirfd/openat 等价）并在 temp 写入与 rename 前重验 realpath/dev/ino。 |
| **W-B2** | Medium | `lib/notebook.js:433`（`mode=stat.mode&0o777`）、`:439-442`（`writeFile+chmod`）、`:446-447`（`rename`）、`:448-456`（错误映射） | Windows 常见保存场景直接 500：① 目标带**只读属性**（`attrib +R`、版本库/OneDrive 副本常见）→ `rename` 覆盖只读目标 **EPERM** → `500 write-failed`；② 目标被其它进程以 **Python/Jupyter 默认共享模式**（`FILE_SHARE_READ|WRITE`，无 DELETE）打开 → `rename` **EPERM** → `500 write-failed`（autosave 每 1.5s 重试持续失败）。**数据安全：失败即放弃，旧内容保留、临时文件 0 残留，无数据丢失。** | 【已验证】真实 Python 持锁进程 + .NET `FileShare.ReadWrite` 模拟；HTTP `/save` → 500 write-failed，`contentUnchanged:true`、`tempLeftovers:[]`。 | 区分「只读/被占用」为可操作错误（409/403 + 文案「清除只读或关闭其它程序后重试」）；对 EPERM/EBUSY 做退避且只提示一次；README 补 Windows 说明。`chmod` 保留权限位在 Windows 无实际收益，可跳过。 |
| **W-B3** | Medium（客户端） | `client.js:950-985`（`makeImageResolver`，关键 `953-954,983`）；契约：better-sidebar `client.js:4064-4069,4281-4293` | **Windows 上 Markdown 相对图片必然裂图**：`notebookPath.startsWith('/')` 只认 POSIX 绝对路径，而 better-sidebar 在 Windows 传入的是**反斜杠绝对路径** `C:\…\x.ipynb` → 落入 `cwd-join` 分支，把 `scope.cwd` 与整条绝对路径再拼一次，base 变成 `C:/…/repo/C:/…/repo/examples`，相对图片解析到不存在的路径。 | 【已验证（算术 + 契约）】真实函数驱动（`__test.normalizePosix/dirnamePosix`）：base = `C:/Users/kexio/Desktop/GitHub/dsh-bsb-ipynb/C:/Users/kexio/Desktop/GitHub/dsh-bsb-ipynb/examples`（期望 `…/examples`）；POSIX 绝对路径行为正确。 | 绝对路径判断改为平台无关（`/^[A-Za-z]:[\\/]/`、`^[\\\\/]{2}`、`/`），Windows 绝对路径直接 `dirnamePosix(normalizePosix(path))`；与 W-C2 一起修。 |
| W-B4 | Low-Medium | `lib/notebook.js:308-331`（`readFile` 错误直穿）、`lib/routes.js:148-155`、`lib/json.js:32-37` | 目标被以**独占共享模式**（`FileShare.None`，部分 Office/杀软/索引程序）打开时：`/read` 的 `EBUSY` 未映射 → `500 internal`；同一时刻 `/save` → 500 write-failed、`/status` 仍 200。README 错误码表未覆盖 Windows 锁语义。 | 【已验证】.NET 持锁 + 真实路由。 | `readNotebookFile` 包一层错误映射（EBUSY/EPERM/EACCES → 可读 code），`json.js` 对已知 fs 错误码给出可读 code。 |
| W-B5 | Low（= L-10 在 Windows 成立且更糟） | `lib/notebook.js:337-351`（saveQueues 按 canonical 路径串行） | **硬链接别名**并发保存**两个都成功**，保存后两名字内容分叉、不再是同一 inode，违反 README「同一 notebook 并发保存只有第一个成功」。Windows 变体：大小写/8.3/junction 别名因 `realpath` 归一化为同一 canonical target，**能正确串行**（第二个 409），比 Mac 好。 | 【已验证】`[ok,ok]`、`contentsEqual:false`、`stillSameInode:false`；大小写/8.3/junction 别名 → 第二个 409。 | 按 dev/ino 串行化，或 README 明确该边界。 |
| W-B6 | Low | `lib/gate.js:91-150,214-233` | 通过 junction 访问 notebook，先删除 junction 的目标目录（junction 悬空，Node 视其 ENOENT）后再走控制端点：控制路径退化为「请求拼写路径」，与内核 canonical 键不一致 → 活内核不可达（`/status` running:false、interrupt 503）。**安全失败方向**，不会控制错内核。 | 【已验证】删目标后 `resolveControlTarget('dangling/missing.ipynb')` 返回请求拼写而非原 canonical target。 | 可不改；若要修，需显式处理 reparse point/悬空 junction。 |
| W-B7 | Low | `lib/gate.js:191-233`（alias key、`samePathIdentity` 的 `part` 字符串比较） | NTFS 大小写不敏感：文件删除后，若某大小写拼写从未在文件存在时被观察过，经该拼写调用控制端点无法匹配按 canonical 路径登记的活内核（`/status` running:false、interrupt 503）。 | 【已验证】`nb.ipynb` 可匹配，`NB.IPYNB` 不能；文件存在时三种拼写都归一化到同一 canonical target。 | 安全方向安全；可对 win32 的 alias key 做未存在段 `toLowerCase()`，或文档说明拼写需一致。 |
| W-B8 | Low | `lib/notebook.js:271-306` | UTF-8 BOM（Windows PowerShell 5.1 `Out-File -Encoding UTF8` / 旧记事本默认产物）notebook → `/read` 返回 **200 + `status:"invalid"`**（JSON.parse 报 `Unexpected token '\uFEFF'`）；无 500/崩溃。 | 【已验证】BOM/UTF-16LE 均 invalid。 | 解码后去除一个前导 `\uFEFF`（或按 BOM 选择 utf-16）；README 加 Windows 编码说明。 |
| W-B9 | Nit | `lib/notebook.js:374,419,455`；`lib/json.js:32-37` | Windows 锁/只读场景 `write-failed` 的 message 含完整绝对路径、临时文件名与 PID，随 HTTP 响应返回浏览器。 | 【已验证】`... rename 'C:\Users\...\dsh-bsb-ipynb-23612-....tmp' -> 'C:\Users\...\nb.ipynb'` | 响应收敛为通用文案 + code，细节只进服务端日志。 |
| N-03 | Nit | 环境事实 | Node v24 对尾点/尾空格/保留设备名采用**字面语义**（与 cmd/Python 的 Win32 归一化不同），长路径可用（>`260` 字符实测 369/405 字符成功）。升级 Node/Windows 后行为可能变化。 | 【已验证】`fs.realpath('evil.txt.')` ENOENT 而 cmd `if exist`=EXISTS。 | 测试不要写死 Win32 剥离行为；`.ipynb` 判断继续以 realpath 为准（当前实现正确）。 |

**Windows 路径安全矩阵（明确结论，全部不能绕过）**：大小写变体、正/反斜杠混合、工作区根带/不带尾分隔符、`..` 穿越、8.3 短名、盘符相对 `C:foo`、尾点/尾空格、ADS（默认流/命名流）、保留设备名（`NUL`/`CON`/`COM1`）、`\\?\`/`\\.\` 前缀、根相对、UNC 外部路径、NUL 字节/孤立代理项 —— 均被 403/404/400 拒绝或安全归一化，**不能**绕过 `.ipynb` 扩展名检查或工作区包含检查。**正向**：长路径（369/405 字符）、中文/emoji/日文/韩文/空格/`#`/`+`/组合字符文件名、CRLF、`\\?\` 前缀、junction 别名 read/save 全部正常；保存输出 UTF-8 无 BOM、LF。

### 3.3 客户端（`client.js`，Windows 浏览器/中文 IME）

| ID | 级别 | 位置 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- | --- | --- |
| W-C1 | Medium（浏览器）/ Low（Desktop） | `client.js:1232-1234` | **`Ctrl+S` 大小写敏感**：`event.key === 's'` 在 CapsLock 开启或 Ctrl+Shift+S 下既不保存也不 `preventDefault`；浏览器版 Chrome/Edge 会弹出「保存网页」。 | 【已验证（Node 驱动 harness）】`{key:'S',ctrlKey:true}` → 不触发、不 preventDefault。 | 用 `event.code === 'KeyS'` 或 `event.key.toLowerCase() === 's'`，补 CapsLock 回归。 |
| W-C2 | Low（功能） | `client.js:147-166`（`sanitizeUrl` 的 scheme 正则） | Markdown/HTML 中 Windows 盘符绝对路径图片/链接（`![](C:\pics\a.png)`、`C:/pics/a.png`）被 `^[a-z][a-z0-9+.-]*:` 当 URL scheme 丢弃（返回 null）。 | 【已验证（静态+函数语义）】；better-sidebar 对照实现明确排除盘符路径。 | `sanitizeUrl` 先判盘符/UNC → 交本地 resolver；与 W-B3 一并修。 |
| W-C3 | Low | `client.js:62,117,2189` | 快捷键提示硬编码 `Ctrl/Cmd`，无平台检测（全文无 `navigator.platform`）→ Windows 用户始终看到 "Cmd"；DSH 0.2.2-rc.1 自带 `@deepseek-ai/dsh-client-shortcuts`（平台化 keycap、可改键、冲突检测）可接入。 | 【已验证（静态）】+【契约核对】 | 按平台选文案；目标态接入 DSH shortcuts（同时解决 L-21）。 |
| W-C4 | Low | `client.js:573-596`（`highlightPython` 的 `#[^\n]*` 未归一化 CRLF）；对照 `323`（markdown 有 `replace(/\r\n?/g,'\n')`） | notebook source 含真实 `\r\n` 时注释高亮把 `\r` 留在 span 内 → 显示多一空行；保存侧 `split(/(?<=\n)/)` 会保留 `\r\n` → 同一 cell 混用行尾。正常 Jupyter 产出不会出现（罕见触发）。 | 【已验证（函数级）】 | 读入/渲染前 source 归一 CRLF；保存时归一；补 CRLF fixture 回归。 |
| W-C5 | Low | `client.js:1218-1246`（唯一 `onKeyDown`，挂三处 textarea；分支 1219/1222/1225/1229/1232/1235） | 插件**无 IME composition 守卫**（全文 `isComposing`/`compositionstart`/`keyCode 229` = 0 处）：Node 驱动证明 composition 状态下 Esc/Ctrl+Enter/Shift+Enter/Alt+Enter/Ctrl+S 会照常触发（回车选词→运行、Esc→退出编辑）。**但** better-sidebar 0.30.1 在 document 捕获阶段注册了 IME guard 并 `stopPropagation` → 真实组合下预计不触发（未在真实浏览器验证）。属「依赖宿主防线」的健壮性缺陷。 | 【已验证（插件行为）】+【契约核对（宿主 guard）】+【推测（真实浏览器事件顺序）】 | 在 `onKeyDown` 首行加 `if (event.isComposing \|\| event.keyCode === 229) return`；补 composition 回归用例。 |
| W-C6 | Nit | `client.js:1235-1245` | Tab 恒被拦截插入 4 空格、无 Shift+Tab 反缩进、无法用 Tab 离开 textarea（键盘导航）。 | 【已验证（静态+驱动）】 | 文档说明或 Shift+Tab 放行。 |
| W-C7 | Nit | `client.js:471-558`（ANSI，正则 543 无 `\r`/OSC） | 与 L-17 相同：`\r` 进度条变多行垃圾、OSC 标题/超链接载荷显示为文本；Windows 表现一致。 | 【已验证（静态）】 | `\r` 行覆盖 + 丢弃 OSC。 |
| W-C8 | Medium（测试/环境） | `client.js:129`；`test/client.test.mjs:79,156,501` | 3 个客户端用例在 zh-CN 宿主失败：`client.js:129` 回退 `navigator.language`，Node 24 全局 navigator 取系统区域（本机 zh-CN）→ 中文词典，而用例硬编码英文（`Jupyter Notebook` vs `Jupyter 笔记本`、`Run` vs `运行`、`Notebook output image` vs `notebook 输出图片`）。任何 zh-CN 宿主（Windows/macOS/Linux）都会挂。 | 【已验证】3 条断言 actual 均为中文；harness 加 `navigator.language='en-US'` pin 后 `client.test.mjs` 58/58 全绿。 | harness 固定 locale；另补一条 zh-CN 用例保留本地化覆盖。 |

**Windows 键盘正向**：快捷键同时接受 `ctrlKey`（`client.js:1222,1232`），Windows 的 Ctrl+Enter / Ctrl+S 可用；`Cmd/Ctrl` 文案问题仅显示层。

### 3.4 文档、CI 与平台声明

| ID | 级别 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| W-D1 | Medium（测试门禁） | `test/routes.test.mjs:350,542`；`.github/workflows/test.yml:19`；README.md:156 / README_ZH.md:156 | Windows 上真实内核用例**静默 skip** 掩盖 W-A1；CI 仅 `ubuntu-latest`，Windows 从未覆盖；`DSH_IPYNB_TEST_PYTHON` 只被 `test/python-helper.mjs` 读取（插件发现只读 `DSH_IPYNB_PYTHON`），设它两次全量**逐条零差异**——README 只让设前者，Windows 上无法让路由/内核测试真正跑起来。 | 加 Windows CI job；`routes.test.mjs` 的 skip 改成显式告警并在 CI 断言 `discoverInterpreters().default` 非空；Windows job 同时设 `DSH_IPYNB_PYTHON` 和 `DSH_IPYNB_TEST_PYTHON`；symlink 用例改能力探测 skip；加 skip 预算。 |
| W-D2 | Low | `README.md`/`README_ZH.md:54`、`:42-55`、`:123-131`、`:146-158`；`CONTRIBUTING.md:8-24`；`client.js:60/115` | Quick Start 用 `python3` 命令，未声明 Windows 发现缺陷；刷新页面写 `Cmd+R`（Windows 是 Ctrl+R/F5）；Known Limitations 无 Windows 条目（默认发现 0、相对图片裂图等）；CONTRIBUTING 的 `python3 -m py_compile` 在 Windows 落到 Store 别名（exit 9009）；大小写测试说明漏了 NTFS 也大小写不敏感、symlink 需开发者模式。 | Quick Start 拆 Windows 命令（`py -3`/`python -m pip`）；加 Windows 注记 `DSH_IPYNB_PYTHON` 绝对路径；补 Known Limitations 4 条 Windows 文案；CONTRIBUTING 同步。 |
| W-D3 | Low | 仓库根无 `.gitattributes`；本机 `core.autocrlf=true` → `i/lf w/crlf` | Windows 工作树全 CRLF（含 `client.js`、`examples/demo.ipynb`），污染 diff、影响未来字节断言（W-C4）。 | 新增 `.gitattributes`：`* text=auto eol=lf`、`*.ipynb text eol=lf`、`*.png binary`。 |
| W-D4 | Low | `.github/ISSUE_TEMPLATE/bug_report.yml` | 版本占位符只有 macOS；IME/快捷键类 issue 缺输入法、浏览器、Desktop/浏览器版、Windows build 字段。 | 改多平台占位符，模板加输入法/浏览器行。 |
| W-D5 | Low | README.md:148；README_ZH.md:148 | 未说明改 client.js 后需**硬刷新**；better-sidebar 文档强调 `Ctrl/Cmd+Shift+R`。 | 补一句硬刷新说明。 |
| N-04 | Nit | `README.md:156`、`.github/workflows/test.yml:41-44` | `node --check index.js lib/*.js client.js` 实际只检查第一个文件（Node `--check` 只接受一个脚本），Windows shell 还不展开 glob → 假绿；`npm pack` 沙箱内需 `--cache`（CI 无此问题）。 | 改成逐文件循环检查。 |
| N-05 | Nit | `locale/en.json`、`locale/zh.json` vs `client.js:15-126` | UI 词典实际内联在 client.js，`locale/*.json` 只提供市场元数据；维护者可能误以为改 json 即改 UI。 | CONTRIBUTING 注明。 |

### 3.5 DSH / better-sidebar 集成核对（均为正向结论）

| 核对项 | 结论 |
| --- | --- |
| 版本匹配（`engines.dsh >=0.2.2-rc.1`） | **精确匹配**：桌面版 0.2.2-rc.1（exe/asar/desktop-runtime 三重证据）；`runtime.json` 的 0.2.1-rc.3 是旧缓存；无加载阻断。 |
| 插件是否 live 安装 | **成立**：profile bundle 含 `dsh-bsb-ipynb`，`link:` 依赖 + Junction + pnpm 日志记录安装成功；无引擎/peer 致命错误；未找到 DSH host 运行日志（无法确认 boot/UI 渲染）。 |
| better-sidebar → viewer 契约 | `path` = **原生反斜杠绝对路径**（`C:\…\x.ipynb`），`scope={sessionId,cwd}`；`resolveAddressPath` 在 base 含 `\` 时把地址折叠成反斜杠（`src/client/address-base.ts:72-77`；`openSidebarFile` 用绝对路径开 tab）。这是 W-B3 的根因。 |
| 宿主 webServer 契约 | 一致：better-sidebar 自身也用 `ctx.webServer.register({kind:'exact'\|'prefix',path,handler})`；插件 `inject:['webServer','sessions','connection']`、挂 `/ipynb/*`、客户端 `hostRouteUrl('ipynb/'+method)`；未发现平台差异。 |
| locale / theme / shortcuts 契约 | locale：`register(NS,'en'/'zh',dict)`/`bind(NS)` 与宿主一致，中文界面跟随宿主语言；theme：`body[data-ds-dark-theme]` 在 0.2.2-rc.1 仍有效；shortcuts：宿主提供平台化 keycap/改键服务（建议接入，见 W-C3）。 |
| 中文 IME 宿主防线 | better-sidebar 0.30.1 在 client apply 最早注册 document 捕获 IME guard 并 `stopPropagation`（`src/client/index.tsx:446-464`、`ime-guard.ts:76-117`，安装版含），缓解 W-C5；其他宿主/版本未验证。 |
| cp936 输出链路 | 内核输出不经过 GBK：spawn 注入 `PYTHONIOENCODING=utf-8`、bridge reconfigure utf-8 → 实测中文/emoji 无损。 |

## 4. macOS 快照条目在 Windows 上的复核

| macOS 条目 | Windows 结论 |
| --- | --- |
| **L-14**（解释器发现 Unix 布局） | **确认并升级为 High / W-A1**：实机复现 0 解释器 + 503；README 的发现承诺在 Windows 不成立。 |
| **L-13**（探测超时只 SIGTERM、忽略 SIGTERM 的候选永久 pending） | **Windows 上不成立**：kill 映射 TerminateProcess，Python handler 不执行；WindowsApps 别名探测 9ms 返回。仍建议加整轮 discovery 总超时（W-A8 语境）。 |
| **M-3**（restart 失败无自愈/忙等） | **成立**：IOPub 忙等 20,215 次/秒（比 Mac 14,963 更快）、无 kernel_died（W-A5）。 |
| **M-5**（restart 同步阻塞控制面） | **成立**：status 阻塞 3.981s、ready 4.382s；Windows 宿主超时后只剩强杀（W-A6）。 |
| **M-6**（授权与 I/O 两次解析、symlink 替换越界） | **成立**：预置越界 junction 被 403 拒绝；授权后父目录换 junction → 越界读/写均复现，junction 无特权（W-B1）。 |
| **M-8**（rename 窗口内外部写被静默覆盖） | **成立**：rename 钩子注入外部写 → `saveFulfilled:true`、外部编辑丢失（Windows 同 Mac）。 |
| **M-11**（shutdown 宽限与提前遗忘） | **Windows 语义退化**：SIGTERM=SIGKILL=TerminateProcess，第二次 kill 无意义；但正常 shutdown 很快（约 1.17s），宽限很少触发（W-A7）。 |
| **L-5 / L-8**（每次保存 2 次全量 readFile、读入上限之前缓冲） | **成立**：8.38MiB notebook 保存读取 16,777,348B（≈2×）；stat 窗口内增长到 34.6MB 仍整体读入后才 409/413。 |
| **L-6**（崩溃残留 `.tmp` 无清理器） | **成立**：预置陈旧 `.tmp` 在 read/save 后仍在；但正常/锁失败/只读失败路径 0 残留，只读 tmp 可由 unlink 删除（Mac 假设被否定）。 |
| **L-10**（硬链接别名并发保存都成功） | **成立且更糟**：两个都成功、保存后内容分叉、不再是同一 inode；大小写/8.3/junction 别名则正确串行（W-B5）。 |
| **L-7 / L-9 / L-11** | Windows 抽查与 Mac 一致：重复 cell id 返回 200；工作区外路径 oracle 成立（受保护系统路径 404+reason、存在→403、不存在→404）；64MiB body 上限仅契约核对。 |
| **L-15**（banner 不重译） | 成立，平台无关；Windows 中文用户为主受影响人群。 |
| **L-16**（HTML 输出图片不 resolve） | 成立且 Windows 更糟：绝对盘符图片还会被 `sanitizeUrl` 当 scheme 丢弃（W-B3/W-C2 叠加）。 |
| **L-17**（ANSI `\r`/OSC） | 成立，Windows 表现一致（W-C7）。 |
| **L-21**（快捷键仅编辑态） | 成立；浏览器版 Windows 上非编辑态 Ctrl+S 会弹「保存网页」（Desktop 影响小）。 |
| **M-7**（linked worktree 403） | 成立，Windows 同样 403；`path.win32.relative` 大小写不敏感（不会误判）、跨盘 fail-closed；junction 的 `readlink` 行为存在环境差异（见 §7 未核实 1）。 |
| **M-9**（硬编码颜色） | 成立；Windows 侧补充：DSH 字号 token（`--dsh-content-font-size`/`--dsh-code-font-size`）未被消费，`fontSize:18` 与 125%/150% 缩放不影响 notebook。 |
| **T-1 / T-3**（清洗器无行为测试、客户端交互缺测试） | 成立；建议补 Windows 路径/IME/CapsLock/CRLF 用例（复用现有 vm harness 即可）。 |

## 5. 修复优先级（Windows 视角）

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P0** | **W-A1**（+ W-A2、W-A10 一起） | 平台化解释器发现。这是 Windows 用户唯一「开箱即不可用」的问题；修好后路由/内核测试在 Windows 上会由 skip/503 转绿。**✅ 已修复（见 §9）**。 |
| **P1** | W-D1（Windows CI + 防假 skip）、W-B2（只读/锁定保存错误语义）、W-B3（Windows 绝对路径图片）、W-C1（Ctrl+S CapsLock） | 影响可诊断性/数据工作流与 UI 正确性；改动小、收益直接。**W-D1 已完成**（CI 改为 ubuntu/windows/macos 三平台 required 矩阵，含发现断言与防假 skip）；**W-B2/W-B3/W-C1 已修复（见 §10）**；W-C5 IME 守卫也已一并修复。 |
| **P2** | W-A3（连接文件清理）、W-A4（子进程树回收）、W-A5/W-A6（M-3/M-5）、W-B1（M-6 加固）、W-B4（EBUSY 映射）、W-C8（测试 locale）、W-D2（文档） | 资源泄漏/失败终止/安全加固/测试可信度；部分与 Mac 修复同批完成。 |
| **P3** | W-A7～W-A10、W-B5～W-B9、W-C2～W-C7、W-D3～W-D5、全部 Nit | 低成本、可按批清理。 |

## 6. CI 建议与落地（三平台矩阵）

**已落地**（`.github/workflows/test.yml`）：单个 `test` job 使用 `matrix.os: [ubuntu-latest, windows-latest, macos-latest]`，全部为 **required**（无 `continue-on-error`），`defaults.run.shell: bash` 统一命令；每个平台都执行：setup Node 22 + Python 3.12、安装 jupyter 依赖、导出 `DSH_IPYNB_TEST_PYTHON`、逐文件 `node --check` + `python -m py_compile`、**解释器发现非空断言**（不设 `DSH_IPYNB_PYTHON`，真正验证各平台 PATH 布局）、`npm test`、`npm pack --dry-run`。平台差异由用例自身的能力探测处理：Linux 跳过 symlink/大小写回归；Windows（GitHub runner 有 symlink 权限）与 macOS 全量运行；2 个 POSIX 权限位用例在 Windows 跳过。

原建议要点（保留供参考）：① Windows job 必须用 bash 或逐文件检查规避 `node --check` 假绿；② 导出 `DSH_IPYNB_PYTHON` 可防止发现回归被静默 skip——当前改用「发现断言」达到同一目的且能真实验证 PATH 发现；③ symlink 用例能力探测 skip，不按平台猜测；④ 测试平台化清单见 `04-tests-ci.md` §5.8。

## 7. 复现与验证索引

| 实验 | 命令/位置 | 关键结果 |
| --- | --- | --- |
| 全量测试（基线） | `npm test`（日志 `%TEMP%\dsh-ipynb-npm-test-fullaccess.log`） | 292/238/51/3，30.40s |
| 全量测试（+TEST_PYTHON） | 同上（日志 `dsh-ipynb-npm-test-envpy.log`） | 292/238/51/3，逐条零差异 |
| 全量测试（+PLUGIN_PYTHON） | 同上（日志 `dsh-ipynb-npm-test-pluginpy.log`） | 292/243/48/1，29.75s |
| 解释器发现 | `node --input-type=module -e "import('./lib/env.js')…discoverInterpreters({fresh:true})"` | `{"interpreters":[],"default":null}`；设 `DSH_IPYNB_PYTHON` 后 1 项 ok |
| 真实内核探针 | `%TEMP%\dsh-win-review\lead\kernel-probe.mjs` | 启动 1722ms；UTF-8 中文/emoji 无损；interrupt→4.9s 重启；restart 1.378s；shutdown 1.17s 内核退出；硬杀→内核 ≤4s 回收；Unicode cwd 正常 |
| 内核/桥 8 场景 | `%TEMP%\dsh-1OtCKz\dsh-win-review\win-kernel-env\`（lab.py/scenarios.py + logs/） | M-3 忙等 20,215/s；M-5 status 3.981s；连接文件残留；用户子进程孤儿 5s+ |
| gate/存储实验 | `%TEMP%\dsh-win-review\win-paths\`（审查后已清理） | TOCTOU 读/写越界复现；只读/锁定保存 500；L-10 硬链接两成功；路径矩阵全部拒绝绕过 |
| 客户端 | `%TEMP%\dsh-win-review\win-client\`（client-probe.mjs 等） | 图片 base 重复；IME handler 照常触发；CapsLock Ctrl+S 不保存；CRLF 高亮多空行 |
| 版本/集成 | DSH install dir + asar 只读解析 | 桌面版 0.2.2-rc.1；插件 live junction 安装；better-sidebar 0.30.1 path 契约 |

各子域完整证据与行号见：`docs/windows-review/01-interpreter-kernel.md`、`02-paths-storage.md`、`03-client-docs-integration.md`、`04-tests-ci.md`。

## 8. 未核实事项

1. **junction 的 Node 可见性存在环境差异**：Lead 在完整访问权限下实测 `lstat(junction).isSymbolicLink()===true`、`readlink` 返回目标绝对路径（无 `\\?\` 前缀，Node v24.19.0，PowerShell 与 Node 创建的 junction 均如此）；而 `02-paths-storage.md` 在其 Low IL 沙箱会话中实测 `isSymbolicLink:false`、`readlink→EINVAL`。两次观察结论不一致，尚无论断；**安全结论不依赖该差异**（预置 junction 由 realpath 拒绝、TOCTOU 可绕过均已独立复现），但建议后续在正常（非沙箱）宿主进程下再复验 `gate.js:91-150 walkTarget` 对 junction 的分支行为。
2. **真实浏览器 UI/中文 IME 敲字**：本机 Web GUI 401，无法做浏览器实测；W-B3 裂图、W-C1/W-C5 的浏览器表现、`kernel_restarted` 中文提示均为算术/Node 驱动/契约结论。
3. **回环端到端**：未在真实 DSH 会话 UI 里打开 notebook 验证（路由受 admission fence 保护）；内核链路通过直接驱动 `lib/kernel.js` + route 层验证。
4. UNC 作为 workspace、icacls 拒绝、AV/索引器锁导致 `.tmp` 残留、64MiB body 内存峰值：未实测（见 02 §7）。
5. DSH host 日志缺失，无法确认插件 boot 后的运行期错误；插件 manager 日志无异常。

## 9. 本次修复落地（P0 解释器发现平台化 + Windows CI）

> 审查之后在同一会话内完成了用户指定的两项：P0 修复与 Windows CI。以下为实际改动与 Windows 实机复测结果。

**改动文件**

| 文件 | 改动 |
| --- | --- |
| `lib/env.js` | PATH 候选按平台生成：Windows 追加 `python.exe` / PATHEXT 中 `.exe`/`.com` 形式，跳过 `WindowsApps` 应用执行别名，PATH 去重并去掉引号；conda 候选改为 `<env>\python.exe`、`<env>\Scripts\python.exe`（POSIX 保留 `bin/python3`）；DSH bundled Python 改为 `<dependencies>\python\python.exe`（POSIX 保留 `bin/python3`）；PATH label 修正为解释器所在目录名。 |
| `.github/workflows/test.yml` | CI 重构为三平台矩阵：`test` job 使用 `matrix.os: [ubuntu-latest, windows-latest, macos-latest]`，required（无 `continue-on-error`），`shell: bash`；每平台 setup Node 22 + Python 3.12、安装 jupyter 依赖、逐文件 `node --check`、解释器发现非空断言、`npm test`、`npm pack --dry-run`。同时修复原 ubuntu 作业的 `node --check` 多文件假绿。 |
| `test/python-helper.mjs` | 新增 `canCreateSymlinks()`：在临时目录真实创建一次 symlink 探测能力。 |
| `test/control-symlink.test.mjs`、`test/gate.test.mjs` | 无法创建 symlink 时（Windows 未开开发者模式/非管理员，或其它受限环境）对需要 symlink 的用例 `skip` 并给出原因，而不是在 setup 中 EPERM 失败。gate 中仅 7 个 symlink 用例跳过，词法路径用例照常运行。 |
| `test/client.test.mjs` | 在加载 client.js 前固定 `navigator.language='en-US'`，消除测试对宿主区域（如 zh-CN Windows）的依赖。 |
| `test/interpreter.test.mjs` | venv 布局平台化（Windows `Scripts\python.exe`，POSIX `bin/python3`；Windows venv 复制解释器，因此改用存在性 + `sys.prefix` 断言）；隔离 `USERPROFILE`，避免开发者真实 `~/.conda/environments.txt` 泄漏进发现结果。 |
| `test/routes.test.mjs` | 工作区外路径用例改用临时目录（不再依赖 POSIX 的 `/etc/hosts`）；`chmod(0o000)` 权限位用例在 Windows 上 skip。 |

**修复后 Windows 实机验证**

- `discoverInterpreters({fresh:true})`（不设任何环境变量）→ 3 个候选：`C:\Users\kexio\miniconda3\python.exe`（conda，`ok:true`）、`C:\Python314\python.exe`（PATH，`ok:true`）、DSH 内置 Python 3.12.14（`ok:false`，`ModuleNotFoundError: No module named 'jupyter_client'`——现在是可见条目而非静默消失）；`default` 非空（修复前 `[]`/`null`）。
- 全量 `npm test`：292 tests / **248 pass / 0 fail / 44 skip** / 29.6s；44 skip = 42 个 symlink 权限用例 + 2 个 POSIX 权限位用例（本机未开开发者模式）。修复前为 238/51/3。
- 真实内核路径不再需要 `DSH_IPYNB_PYTHON` 才能跑：`e2e.test.mjs`、`routes.test.mjs` 的内核用例在默认环境即通过（CI Windows 作业仍然显式设置两个变量，防止发现回归被静默 skip）。
- 静态检查（逐文件）、`python -m py_compile`、`npm pack --dry-run`（18 文件）均通过；带 `DSH_IPYNB_PYTHON`/`DSH_IPYNB_TEST_PYTHON` 的全量结果同为 292/248/0/44。

**后续（本次未完成，建议按 §5 优先级推进）**

- CI 已转为 ubuntu / windows / macos **三平台 required 矩阵**（Windows 首次运行 297 pass / 0 fail / 2 skip 后移除 `continue-on-error` 并补 macOS job）；三平台首次结果见后续 CI 运行记录。
- §5 的 P2/P3 项仍未改动：W-A3（连接文件泄漏）、W-A4（用户子进程孤儿）、W-B1（M-6 TOCTOU）、W-A5/W-A6（M-3/M-5）等；其中 P1 的 W-B2/W-B3/W-C1 与 §3.3 的 W-C5 已在 §10 的第一批修复中完成。
- README / README_ZH 的 Windows Quick Start 与 Known Limitations 尚未更新（`python3` 命令、`Cmd+R` 等）；本次只更新了错误码表与保存可靠性说明。

## 10. 第一批修复（2026-11-07，后续）

按 §5 的 P1「Windows 日常可见缺陷」完成第一批修复：

| 项 | 状态 | 改动 |
| --- | --- | --- |
| **W-B2 / W-B9** | ✅ 已修复 | 新增 `write-blocked`（409）错误码：`lib/notebook.js` 把只读目标、被其它程序占用（EPERM/EACCES/EBUSY）和只读文件系统（EROFS）映射为可重试错误，`details.reason` 区分 `readonly` / `locked`；`fsp.stat`/`readFile`/`rename` 各失败路径统一映射，响应不再包含绝对路径、临时文件名或 PID（细节只进服务端日志）；Windows 跳过无意义的 chmod 权限位复制。`lib/json.js` 注册状态码，客户端新增中英文 banner，autosave 对 `write-blocked` 指数退避（1.5s→6s→24s→30s 封顶）；README / README_ZH 更新错误码表与「Blocked saves」说明。 |
| **W-C1** | ✅ 已修复 | Ctrl/Cmd+S 改用物理键 `event.code === 'KeyS'` 判断（同时保留 `key.toLowerCase()==='s'` 兜底），CapsLock 开启或 `Ctrl+Shift+S` 时不再落到浏览器「保存网页」。 |
| **W-C5** | ✅ 已修复 | `client.js` 的 `onKeyDown` 首行加 IME 守卫（`isComposing` / `keyCode === 229` / React `nativeEvent.isComposing`），三个编辑 textarea 与两个只读预览的 Enter 进入编辑共用；组合输入下 Esc / Ctrl+Enter / Shift+Enter / Alt+Enter / Ctrl+S 均不再误触发（宿主 guard 仅是额外防线，不再依赖）。 |
| **W-B3 / W-C2** | ✅ 已修复 | 客户端新增 `isAbsoluteLocalPath`（POSIX `/`、Windows 盘符 `C:\`/`C:/`、真正的 UNC `\\server\share`）；`makeImageResolver` 用它判断 notebookPath 与图片源，Windows 绝对路径不再与 `scope.cwd` 重复拼接；`sanitizeUrl` 放行盘符/UNC 图片给本地 resolver（protocol-relative `//host` 图片仍按跨源图片拒绝）。HTML 输出图片（L-16）仍未接 resolver。 |

**验证（Windows 实机）**：全量 `npm test` = **299 tests / 255 pass / 0 fail / 44 skip**（新增 7 个测试：`sanitizeUrl` Windows 路径、`makeImageResolver` Windows/POSIX/相对路径、IME + CapsLock Ctrl+S、autosave 退避纯函数、保存错误分类、Windows 只读保存的 notebook + route 集成用例）；`node --check` 全部通过；`git diff --check` 无空白错误。

**未做（留待后续）**：§5 的 P2/P3（W-A3 连接文件泄漏、W-A4 子进程孤儿、W-A5/W-A6、W-B1 TOCTOU、W-PS-03 读取 EBUSY 映射等）、L-16 HTML 输出图片、W-D2 的 Windows Quick Start/Known Limitations、W-D3 `.gitattributes`；CI 已为三平台 required 矩阵（见 §6）。
