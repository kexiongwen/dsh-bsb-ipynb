# 04 — Windows 测试套件实跑、失败三角定位与 CI 矩阵建议

- **子域**：Windows 侧代码审查 / 测试与 CI（win-tests）
- **审查对象**：`dsh-bsb-ipynb` @ `8c1ad8e`（审查结束后工作树仍干净）
- **实机环境**：Windows 11（10.0.26300）；Node v24.19.0；npm 11.17.0；Python 3.14.7（`C:\Python314\python.exe`；jupyter_client 8.10.0 / ipykernel 7.4.0 / nbformat 5.11.1）；控制台代码页 cp936（GBK）
- **对照基线**：macOS APFS、Node v24.13.1，`npm test` = **292 pass / 0 fail / 0 skip、约 23.5 s**（`CODE_REVIEW.md` §6、§4 测试缺口）
- **证据说明**：标记 **【实测】**（Windows 实跑/插桩实测）、**【日志】**（Lead 在 danger-full-access 下的全量运行日志）、**【静态核对】**（源码/文档逐行核对，不臆测）

---

## 0. 结论摘要（TL;DR）

1. **测试集合完整**：Windows 上同样收集到 **292 个用例**，与 Mac 一致；没有静默漏采集（13 个测试文件全部被 `node --test test/*.test.mjs` 拾取）。
2. **Windows 基线**（不设任何环境变量）：**292 tests / 238 pass / 51 fail / 3 skip / 30.4 s**（vs Mac 23.5 s，约 +29%）。
3. **51 个失败的四分类**：**c 环境权限 42**（symlink EPERM，占 82%）、**b 测试/宿主假设 6**、**a 代码真实 Windows 缺陷 3**、d 会话沙箱假象 0（全权限基线下）。
4. **3 个 skip 中有 2 个是“假 skip”**：1 个是设计内的 POSIX 权限位 skip；另外 2 个（`routes.test.mjs:350`、`:542`）是因为插件解释器发现返回空而静默跳过，**掩盖了真实缺陷**。
5. **唯一代码级真实 Windows 缺陷**：`lib/env.js` 的解释器发现只实现 Unix 布局（PATH 不带扩展名、conda/内置 Python 的 `bin/python3`），**Windows 默认发现 0 个解释器**。这不是“测试问题”而是产品问题：Windows 用户打开插件即无解释器，`/ipynb/execute`、`/ipynb/restart` 一律 **503**。它导致 e2e 1 个失败 + routes 2 个失败 + 2 个静默 skip。
6. **`DSH_IPYNB_TEST_PYTHON` 在 Windows 上修不了插件侧发现**：设与不设两次全量运行 **逐条完全相同**（292/238/51/3）。测试 helper 读 `DSH_IPYNB_TEST_PYTHON`，插件发现读 `DSH_IPYNB_PYTHON`；README/CI 只让设前者，是**测试与文档缺口**。Lead 实测设 `DSH_IPYNB_PYTHON` 后 **292/243 pass/48 fail/1 skip**（修掉 3 fail + 2 skip）。
7. **42 个 symlink 失败是宿主权限**：当前用户无 `SeCreateSymbolicLinkPrivilege`、未开启 Windows 开发者模式；file/dir symlink 均 `EPERM`，但 **junction 可用**（实测）。测试缺少“symlink 能力探测”，现有守卫只判断“大小写不敏感文件系统”，NTFS 判定为 true 后仍去创建 symlink 而失败。
8. **静态检查与打包在 Windows 通过**：`node --check` 逐文件 8/8、`python -m py_compile` exit 0、`npm pack --dry-run` **18 文件**与 Mac 基线一致。但 README 两条命令在 Windows 上有坑（`python3` 是 Store 别名、exit 9009；`node --check` 多文件只检查第一个文件 → 假绿）。
9. **CI 建议**：保留 ubuntu 主任务；新增 **macOS**（真正跑大小写不敏感 symlink 回归，Mac 基线 292/292）与 **Windows**（能力探测后 skip 42 个 symlink 用例；同时设置 `DSH_IPYNB_TEST_PYTHON` 与 `DSH_IPYNB_PYTHON`；加“解释器发现非空”与“skip 预算”断言，防止静默 skip 回归）。

---

## 1. 环境、方法与证据来源

### 1.1 环境

| 项 | 值 |
| --- | --- |
| OS | Windows 11（10.0.26300），NTFS（大小写不敏感），文件系统无 symlink 创建权限 |
| Node / npm | v24.19.0 / 11.17.0 |
| Python | 3.14.7，`C:\Python314\python.exe`；另有 `C:\Users\kexio\miniconda3\python.exe`（其目录在 PATH 上） |
| Python 包 | jupyter_client 8.10.0、ipykernel 7.4.0、nbformat 5.11.1 |
| Node 全局 locale | `navigator.language = "zh-CN"`、`Intl` locale `zh-CN`、`tz = Etc/GMT-8` |
| 控制台 | cp936（GBK）；日志按 UTF-8 读取，测试输出正常 |
| 测试命令 | `npm test` = `node --test --test-timeout=180000 test/*.test.mjs` |

### 1.2 会话沙箱限制与替代方法（为什么不能直接在本会话跑全量）

本子会话的权限在启动时固定为 **workspace-write**，审批被禁用、无法提权。实测在该沙箱下：

- Node 的 `child_process.spawn/execFile` 只要使用 pipe stdio 就直接 `EPERM`（`errno -4048`）。因此 `npm test` 无法在本会话全量运行——Node 测试运行器要为每个测试文件 spawn 子进程，**13 个文件全部以 `Error: spawn EPERM` 秒失败**（实测汇总：`tests 13 / pass 0 / fail 13`，见附录 A 命令 4）。
- `npm pack` 也会因 npm cache 位于工作区外而被拒绝（`EPERM ... npm-cache\_cacache\tmp`），可用 `--cache <会话 TEMP>` 绕开（§6）。

因此本报告的实跑证据由三层组成（互相独立、可复核）：

| 证据层 | 内容 | 用途 |
| --- | --- | --- |
| **E1【日志】Lead 全权限全量日志** | 3 份 `npm test` 全量日志（基线 / +TEST 变量 / +PLUGIN 变量） | 全量 counts、逐条失败清单、真实内核用例结果 |
| **E2【实测】本会话沙箱内逐文件复跑** | `node --test --test-isolation=none`（同进程运行，绕过被禁的 pipe spawn）跑 9 个不依赖真实 Python 子进程的文件 | 独立复现 symlink/客户端/路由等失败分布，验证 E1 的逐文件数字 |
| **E3【实测】受控插桩** | 用仓库自己测试采用的 `syncBuiltinESMExports()` 技巧 mock 掉 `execFile` 探测（保留真实候选枚举与 fs 解析），跑 `lib/env.js` 发现逻辑、routes 路由与 client 加载 | 三角定位根因，不依赖全权限 |

> 沙箱限制本身不进入 Windows 基线 counts；它只影响本报告的证据获取方式（详见 §6.3 与附录 A）。

### 1.3 证据文件

| 编号 | 路径 | 说明 |
| --- | --- | --- |
| E1a | `C:\Users\kexio\AppData\Local\Temp\dsh-ipynb-npm-test-fullaccess.log`（141,586 B） | 基线：**不设** `DSH_IPYNB_TEST_PYTHON`；292/238/51/3，duration 30,401 ms |
| E1b | `C:\Users\kexio\AppData\Local\Temp\dsh-ipynb-npm-test-envpy.log`（140,532 B） | 设置 `DSH_IPYNB_TEST_PYTHON=C:\Python314\python.exe`；292/238/51/3，约 29.8 s |
| E1c | `C:\Users\kexio\AppData\Local\Temp\dsh-ipynb-npm-test-pluginpy.log`（136,662 B） | 同时设置 `DSH_IPYNB_TEST_PYTHON` + `DSH_IPYNB_PYTHON=C:\Python314\python.exe`；292/243/48/1，29,749 ms |
| E2 | `%TEMP%\dsh-win-review\win-tests\sandbox-*.log`（本会话 TEMP = `C:\Users\kexio\AppData\Local\Temp\dsh-Q65Xb3\…`） | 9 个文件的同进程复跑原始输出 |
| E3 | 同上目录 `env-probe.mjs`、`routes-proof-preload.mjs`、`pin-en-locale.mjs`、`findpython-probe.mjs`、`parse-log2.mjs` | 插桩脚本与解析器（全部为临时文件，未入库） |

---

## 2. Windows 全量测试结果

### 2.1 三种配置总表

| 配置 | 环境变量 | tests | pass | fail | skipped | duration | 日志 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Windows 基线** | 不设 | 292 | **238** | **51** | **3** | **30.40 s** | E1a |
| B. + 测试变量 | `DSH_IPYNB_TEST_PYTHON=C:\Python314\python.exe` | 292 | 238 | 51 | 3 | 约 29.8 s | E1b |
| C. + 插件变量 | `DSH_IPYNB_TEST_PYTHON` + `DSH_IPYNB_PYTHON=C:\Python314\python.exe` | 292 | **243** | **48** | **1** | 29.75 s | E1c |
| D. macOS 基线（对照） | — | 292 | 292 | 0 | 0 | 约 23.5 s | `CODE_REVIEW.md` §6 |

- A → B：**逐条完全一致**（292 个用例的 mark 集合零差异，见 §4.1）。`DSH_IPYNB_TEST_PYTHON` 对 Windows 基线 counts **没有任何影响**。
- A → C：**+5 个用例由 fail/skip 转为 pass**（3 fail + 2 skip），skip 由 3 → 1；剩余 48 fail 见 §4.5。
- Windows 测试集合 292 与 Mac 相同；Windows 上多出的耗时主要来自真实内核用例（bridge 单条 5–9 s）与失败重试无关，属于同量级。

### 2.2 逐文件 pass/fail/skip（Windows 基线，A 配置）

> 复现方式：**C1** = Lead 全权限日志（E1a）；**C2** = 本会话沙箱内 `node --test --test-isolation=none` 逐文件复跑（E2）。C1/C2 的 pass/fail/skip 除注明处外完全一致。

| 测试文件 | tests | pass | fail | skip | 复现 | 备注 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `test/bridge.test.mjs` | 6 | 6 | 0 | 0 | C1 | 真实 Python bridge/kernel，Windows 上正常 |
| `test/client-lifecycle.test.mjs` | 34 | 34 | 0 | 0 | C1+C2 | 全通过 |
| `test/client.test.mjs` | 58 | 55 | **3** | 0 | C1+C2 | 宿主 locale 依赖（§5.4） |
| `test/control-symlink.test.mjs` | 35 | 0 | **35** | 0 | C1+C2 | 全部 symlink EPERM（§5.1） |
| `test/e2e.test.mjs` | 1 | 0 | **1** | 0 | C1 | 503，插件发现缺陷（§4） |
| `test/execute-disconnect.test.mjs` | 19 | 19 | 0 | 0 | C1+C2 | 全通过（该文件 mock 了 execFile 并设 `DSH_IPYNB_PYTHON`） |
| `test/gate.test.mjs` | 17 | 10 | **7** | 0 | C1+C2 | 全部 symlink EPERM（§5.1） |
| `test/interpreter.test.mjs` | 3 | 2 | **1** | 0 | C1 | venv `bin/python3` 布局（§5.5） |
| `test/kernel-lifecycle.test.mjs` | 54 | 54 | 0 | 0 | C1+C2 | 全通过 |
| `test/kernel.test.mjs` | 9 | 9 | 0 | 0 | C1 | 真实内核，Windows 上正常 |
| `test/notebook.test.mjs` | 32 | 31 | 0 | **1** | C1+C2 | skip 为 POSIX 权限位（设计内）。C2 中另有 1 个 `spawnSync EPERM` 失败，属沙箱假象，见 §6.3 |
| `test/package.test.mjs` | 2 | 2 | 0 | 0 | C1+C2 | 全通过 |
| `test/routes.test.mjs` | 22 | 16 | **4** | **2** | C1+C2 | 2 fail 由发现缺陷、2 fail 为 POSIX 假设、2 skip 掩盖缺陷（§4/§5） |
| **合计** | **292** | **238** | **51** | **3** | | 与 E1a 汇总一致 |

**逐条核实 Lead 给出的失败清单**：完全命中，且补全了精确分布——

| Lead 基线描述 | 核实结果 |
| --- | --- |
| control-symlink 约 35 个 `fs.symlink EPERM` | ✅ **精确 35/35** 全部 `EPERM`，失败点集中在 `setup()` 的 `symlink()` 调用（`control-symlink.test.mjs:56`/`:68`） |
| gate.test.mjs symlink EPERM | ✅ **7 个**，失败点 `gate.test.mjs:89/126/148/168/183/197/213` |
| client.test.mjs 3 个 | ✅ 3 个：`:79`/`:156`/`:501`，期望英文、实际中文（宿主 locale） |
| e2e execute 503 | ✅ 1 个：`e2e.test.mjs:99`，503≠200 |
| interpreter venv 布局（bin/python3） | ✅ 1 个：`interpreter.test.mjs:37`，`ENOENT … venv-a\bin\python3` |
| routes 4 个（404/403/409、drain、删除后 restart 503） | ✅ 精确 4 个：`:221`（404≠403）、`:337`（409≠404）、`:472`（drain 未发生）、`:515`（restart 503） |
| skip 3（POSIX 权限位 1 + 无解释器 2） | ✅ 精确 3 个：`notebook.test.mjs:170`（POSIX 权限位）+ `routes.test.mjs:353`、`:545`（无解释器，**缺陷被掩盖**） |

### 2.3 Mac ↔ Windows 对比

| 维度 | macOS APFS | Windows 11 | 结论 |
| --- | --- | --- | --- |
| 收集到的用例数 | 292 | 292 | 一致，无漏采集 |
| pass / fail / skip | 292 / 0 / 0 | 238 / 51 / 3 | 51 失败 + 2 假 skip |
| 全量耗时 | 约 23.5 s | 30.4 s | +29%，真实内核用例占主要部分 |
| 真实内核用例（bridge/bridge_iopub/kernel/e2e） | 通过 | bridge/kernel 通过；e2e 因**插件发现**失败 | Python bridge 本身跨平台可用，坏在发现层 |
| 大小写不敏感 symlink 回归（control-symlink 35） | 全部运行并通过 | 全部运行并因权限失败 | Windows NTFS 判定“大小写不敏感”为 true，但 symlink 权限不同 |
| 跨平台可移植测试能力 | 无该维度 | 暴露 5 类可移植性缺口 | 见 §5 |

---

## 3. Windows 51 个失败的根因分类

**分类口径**（沿用任务定义）：

- **a = 代码真实 Windows 缺陷**：产品/库代码在 Windows 上行为错误，换平台/修代码才能好；
- **b = 测试自身 POSIX 或宿主环境假设**：测试写法不可移植（路径、权限位、locale、venv 布局等），产品在 Windows 上未必错；
- **c = 环境权限**：代码与测试都合理，但当前 Windows 宿主缺权限（symlink）；
- **d = 会话沙箱假象**：只在 workspace-write 沙箱内出现，全权限/CI 下不出现（本基线为 0，另见 §6.3）。

### 3.1 分类汇总

| 分类 | 数量 | 文件分布 | 备注 |
| --- | ---: | --- | --- |
| **c 环境权限** | **42** | control-symlink 35 + gate 7 | 全部 `EPERM: operation not permitted, symlink`；无 `SeCreateSymbolicLinkPrivilege`、未开发者模式 |
| **b 测试/宿主假设** | **6** | client 3（locale）+ interpreter 1（venv 布局）+ routes 2（POSIX 路径 / chmod ACL） | 其中 interpreter 用例即使改测试，也要等 env.js 修复后才能绿 |
| **a 代码真实 Windows 缺陷** | **3** | e2e 1（503）+ routes 2（drain、restart 503） | 同一根因：`lib/env.js` 发现 0 解释器 |
| **d 沙箱假象** | **0** | — | 全权限基线无沙箱假象；沙箱内单独复现见 §6.3 |
| **合计** | **51** | | 42 + 6 + 3 = 51 |

### 3.2 a 类：代码真实 Windows 缺陷（3 个，同一根因）

根因链（详见 §4.3）：`lib/env.js:126` 在 PATH 上按 `path.join(dir, 'python3'|'python')` 找**无扩展名**文件 → Windows 实际是 `python.exe` → `collectCandidates()` 返回空 → `discoverInterpreters().default = null`（【实测】插桩输出 `{"interpreters":[],"default":null}`）→ `resolveInterpreter()` 抛 `kernel-unavailable` 503（`lib/env.js:292-300`）。

| # | 用例 | 文件:行 | 失败断言/错误 | 根因说明 | Windows 修复建议（不实际改） |
| --- | --- | --- | --- | --- | --- |
| a-1 | `execute route streams a real kernel run to completion` | `test/e2e.test.mjs:66`，失败于 `:99` | `AssertionError: 503 !== 200` | e2e 注册真实路由后调用 `/ipynb/execute`，路由在 `lib/routes.js:229` 先 `resolveInterpreter()`，插件发现为空 → 直接 503，请求根本没有进入流式执行 | 修 `lib/env.js` Windows 发现（§4.6）；在此之前 CI/本地设 `DSH_IPYNB_PYTHON`（Lead 实测单文件 2306 ms 通过、全量 C 配置下该用例 2754 ms 通过） |
| a-2 | `execute waits for drain instead of dropping the final reply` | `test/routes.test.mjs:429`，失败于 `:472` | `AssertionError: route should wait for drain`（drain 回调 0 个） | 该测试没有像 `:350`/`:542` 那样带解释器 skip 守卫，但同样依赖默认解释器；Windows 上路由在写任何 NDJSON 前就 503，因此不会触发 `res.write` 背压/`res.once('drain')`（`lib/routes.js:229` → `:257-278`、`:311-313`）。**这是“隐藏的宿主依赖”**：任何没有可用 Python 的机器（含 Linux 裸机）都会失败 | ① 修 env.js；② 路由单测应把“解释器选择”与“HTTP 背压行为”解耦：给请求传显式 python 或 mock `lib/env.js` 的 discovery，而不是依赖宿主机装了 jupyter；③ 至少补上与其他两个用例一致的 skip 守卫（但会再次掩盖缺陷，仅作过渡） |
| a-3 | `status, interrupt, restart and shutdown work after the notebook is deleted` | `test/routes.test.mjs:485`，失败于 `:515` | `AssertionError: /ipynb/restart`，`503 !== 200` | 文件被删除后仍可用现有内核控制（该用例的设计意图），但 restart 分支在 `lib/routes.js:398` 无条件 `resolveInterpreter()`，Windows 上 503；同一用例里 status/interrupt/shutdown 均通过 | 修 env.js；或让 restart 在内核已存在时复用 `entry.python`（不重新发现），从而与“删除后仍可控制”的设计意图一致（需评估与 `:542` 用例语义的兼容） |

### 3.3 c 类：环境权限（42 个，全部 symlink EPERM）

**环境证据（【实测】）**：

- `whoami /priv` **不含** `SeCreateSymbolicLinkPrivilege`；`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense` 不存在（未开开发者模式）。
- 能力探测：`fs.symlink(..., 'file')` → `EPERM`；`fs.symlink(..., 'dir')` → `EPERM`；`fs.symlink(..., 'junction')` → **OK**。
- 同一失败在 Lead 的 **danger-full-access** 全量日志（E1a）中逐条相同 → 证明是宿主权限，不是 DSH 会话沙箱。

#### 3.3.1 `test/control-symlink.test.mjs`（35 个，全部失败）

失败点：`setup()` 中的 `symlink()`——文件类 `:56`、目录类 `:68`；错误统一为
`Error: EPERM: operation not permitted, symlink '<target>' -> '<tmp>\workspace\linked(.ipynb|-directory)'`。

| # | 用例（按日志原名） | 声明行 | 失败点 |
| ---: | --- | --- | --- |
| 1 | controls preserve canonical spelling after a case-mismatched file symlink target is deleted | `:199` | `:56` |
| 2 | controls retain the original kernel identity after a file symlink target is deleted | `:228` | `:56` |
| 3 | a dangling file symlink outside the workspace cannot control another kernel | `:256` | `:56` |
| 4 | read, save and execute still require the missing target behind a file symlink | `:270` | `:56` |
| 5 | deleted file target spelling aliases are scoped to the session that observed them | `:286` | `:56` |
| 6 | deleted file target spelling aliases do not survive a session workspace change | `:300` | `:56` |
| 7 | a redirected file symlink cannot recover the former spelling alias | `:310` | `:56` |
| 8 | a removed file symlink cannot recover the former spelling alias | `:310` | `:56` |
| 9 | a removed and recreated file symlink cannot recover the former spelling alias | `:310` | `:56` |
| 10 | a reappearing file target uses its current canonical spelling instead of a cached alias | `:327` | `:56` |
| 11 | a remembered file symlink redirected outside the workspace is rejected before kernel access | `:342` | `:56` |
| 12 | interpreter replacement through a deleted file target preserves its authorized alias | `:358` | `:56` |
| 13 | a closed kernel entry cannot pass its deleted file target alias to another lifecycle | `:376` | `:56` |
| 14 | a replaced kernel entry cannot pass its deleted file target alias to another lifecycle | `:376` | `:56` |
| 15 | a direct case-mismatched file path retains its canonical key after deletion without a symlink | `:391` | `:56` |
| 16 | status can remember a live kernel's file alias before the target disappears | `:403` | `:56` |
| 17 | controls preserve canonical spelling after a case-mismatched directory symlink target is deleted | `:199` | `:68` |
| 18 | controls retain the original kernel identity after a directory symlink target is deleted | `:228` | `:68` |
| 19 | a dangling directory symlink outside the workspace cannot control another kernel | `:256` | `:68` |
| 20 | read, save and execute still require the missing target behind a directory symlink | `:270` | `:68` |
| 21 | deleted directory target spelling aliases are scoped to the session that observed them | `:286` | `:68` |
| 22 | deleted directory target spelling aliases do not survive a session workspace change | `:300` | `:68` |
| 23 | a redirected directory symlink cannot recover the former spelling alias | `:310` | `:68` |
| 24 | a removed directory symlink cannot recover the former spelling alias | `:310` | `:68` |
| 25 | a removed and recreated directory symlink cannot recover the former spelling alias | `:310` | `:68` |
| 26 | a reappearing directory target uses its current canonical spelling instead of a cached alias | `:327` | `:68` |
| 27 | a remembered directory symlink redirected outside the workspace is rejected before kernel access | `:342` | `:68` |
| 28 | interpreter replacement through a deleted directory target preserves its authorized alias | `:358` | `:68` |
| 29 | a closed kernel entry cannot pass its deleted directory target alias to another lifecycle | `:376` | `:68` |
| 30 | a replaced kernel entry cannot pass its deleted directory target alias to another lifecycle | `:376` | `:68` |
| 31 | a direct case-mismatched directory path retains its canonical key after deletion without a symlink | `:391` | `:68` |
| 32 | status can remember a live kernel's directory alias before the target disappears | `:403` | `:68` |
| 33 | case-sensitive files with distinct names remain distinct kernel keys, including after one is deleted | `:420` | `:56` |
| 34 | interpreter replacement through another alias preserves every previously observed alias | `:463` | `:56` |
| 35 | interpreter replacement through the canonical path preserves every previously observed alias | `:463` | `:56` |

**为什么守卫没拦住**：文件里唯一的守卫是“大小写不敏感文件系统”探测（`:52-55`、`:64-67` → `sameExistingPath()` `:178-185`，用 `realpath` 相等判断）。NTFS 大小写不敏感 → 探测返回 **true**（【实测】`realpath('Actual.ipynb') === realpath('actual.ipynb')`），于是 35 个用例全部进入执行，然后卡在 symlink 权限。**守卫的维度错了**：需要的是“能否创建 symlink”，不是“FS 是否大小写不敏感”。

#### 3.3.2 `test/gate.test.mjs`（7 个，全部失败）

`gate.test.mjs` **没有任何 symlink 能力/平台守卫**，直接 `symlink()`：

| # | 用例 | 文件:行 | 失败点 | 错误 |
| ---: | --- | --- | --- | --- |
| 1 | `resolveTarget rejects symlink escapes` | `:86` | `:89` | `EPERM … symlink '<tmp>/gate-…' -> '<tmp>/gate-…/project'` |
| 2 | `resolveControlTarget accepts a deleted notebook inside the workspace` | `:106` | `:126` | 同上 |
| 3 | `control paths retain the canonical target of dangling file and directory symlinks` | `:142` | `:148` | `EPERM … symlink 'notebooks\real.ipynb' -> …` |
| 4 | `dangling symlink targets are still checked against the workspace and notebook extension` | `:166` | `:168` | `EPERM … symlink '..\missing.ipynb' -> …` |
| 5 | `missing-target resolution expands symlinks before parent components` | `:179` | `:183` | `EPERM … symlink '<tmp>/outside/nested' -> …` |
| 6 | `control paths reject symlink cycles and non-directory ancestors` | `:195` | `:197` | `EPERM … symlink 'two.ipynb' -> …` |
| 7 | `missing-target resolution still rejects an existing directory named as a notebook` | `:210` | `:213` | `EPERM … symlink 'missing\..\folder.ipynb' -> …` |

**修复建议（不实际改）**：在测试模块顶层做一次能力探测，失败则在每个相关 `test()` 上带 skip reason；这是业界 Windows 测试常用做法（如能力探测后 skip 的实践：[elizaOS 的 Windows symlink 前置断言](https://github.com/elizaOS/eliza/commit/4ff1e8aa081c8d7e0e7ee4ab0c64db1f1bac355f)、[gemini-cli 关于 Windows 未守卫环境前置条件的故障报告](https://github.com/google-gemini/gemini-cli/issues/28830)）。示例见 §5.1。

### 3.4 b 类：测试/宿主假设（6 个）

| # | 用例 | 文件:行 | 失败断言/错误 | 根因（【实测】证据） | Windows 修复建议 |
| --- | --- | --- | --- | --- | --- |
| b-1 | `registers a custom ipynb file viewer through betterSidebar` | `test/client.test.mjs:54`，失败于 `:79` | 期望 `'Jupyter Notebook'`，实际 `'Jupyter 笔记本'` | 宿主 locale 泄漏进测试：`client.js:129-131` 用 `navigator.language` 作为无宿主 locale 服务时的 fallback。Node 21+ 提供全局 `navigator`；本机系统/ICU 为 `zh-CN` → 回退中文词典；用例硬编码英文 | 测试 harness 固定 locale：在 `loadClient()` 动态 import 之前 `Object.defineProperty(globalThis,'navigator',{value:{language:'en-US',languages:['en-US']},configurable:true})`；另外补一条显式 `zh-CN` 的用例覆盖中文分支。**实测**：加该 preload 后 `client.test.mjs` 58/58 通过（§5.4） |
| b-2 | `registers the en/zh dictionaries and follows the host locale preference` | `:105` → `:156` | 期望 `'Run'`，实际 `'运行'`（disposal 后回退语言） | 同 b-1 | 同 b-1 |
| b-3 | `image outputs carry localized alt text` | `:493` → `:501` | 期望 `'Notebook output image'`，实际 `'notebook 输出图片'` | 同 b-1 | 同 b-1 |
| b-4 | `discovery preserves two venvs that share one base Python` | `test/interpreter.test.mjs:19`，失败于 `:37` | `ENOENT: no such file or directory, realpath '…\venv-a\bin\python3'` | 用例假定 POSIX venv 布局：`:37`、`:41`、`:49` 用 `<venv>/bin/python3`、`:40` 设 `HOME`。Windows `venv` 实际布局是 `<venv>\Scripts\python.exe`（`C:\Python314\python.exe -m venv` 创建）。**同文件第二个用例 `:146-148` 已有 `process.platform === 'win32'` 分支，是正确写法** | 把第一个用例按 `:146-148` 的方式平台化（`Scripts/python.exe`、PATH 指向 `Scripts`、`pyvenv.cfg` 位于 venv 根）。注意：**只改测试在 Windows 上仍会失败**——`lib/env.js` 的 `findOnPath`/conda 布局本身不识别 Windows venv（§4.3），因此应与 a 类代码修复一起落地；在修复前建议整条用例 `skip`（避免继续挂在 `bin/python3` 上，把缺陷伪装成“布局问题”） |
| b-5 | `read rejects paths outside the session workspace` | `test/routes.test.mjs:213`，失败于 `:221` | 期望 403/`path-outside-root`，实际 404/`not-found` | 用例把 POSIX 绝对路径 `'/etc/hosts'` 当作“工作区外的绝对路径”。Windows 上 `path.isAbsolute('/etc/hosts') === true`，`path.resolve('/etc/hosts') === 'C:\etc\hosts'`（当前盘根），`realpath` 返回 `ENOENT` → `lib/gate.js:71-74` 先抛 404，走不到 `:79` 的“工作区外 → 403”。**不是安全缺陷**（若该路径存在则仍会 403），只是用例选了 POSIX 专属路径 | 用与临时目录同盘的“工作区外真实路径”：先在 `dir` 的父目录建兄弟目录（如 `mkdtemp` 后 `path.join(path.dirname(dir), 'outside-...')`），再把该绝对路径作为 `path` 传入；不要依赖 `/etc/hosts` 存在 |
| b-6 | `save distinguishes bad requests and inaccessible paths from write conflicts` | `test/routes.test.mjs:315`，失败于 `:337` | 期望 404，实际 409（`write-conflict`） | 用例用 `chmod(protectedDir, 0o000)` 制造“不可访问目录”（`:331`）。Windows 的 `chmod` 只影响只读属性，**不会收紧 ACL**；【实测】在 `chmod 0o000` 的目录里仍可读写 → 保存继续执行并因 baseVersion 不匹配返回 409。既有 skip 条件 `process.getuid?.() === 0`（`:315`）在 Windows 恒为 `undefined === 0`，拦不住 | 加平台/能力 skip：`{ skip: process.platform === 'win32' || process.getuid?.() === 0 }`；或用 `icacls` 构造真实拒绝目录（成本高，不建议跨平台测试依赖 ACL）；或在 Windows 上用“只读文件属性 + 打开失败”替代，但语义不同 |

### 3.5 skip 清单（3 个）

| # | 用例 | 文件:行 | skip reason | 评价 |
| ---: | --- | --- | --- | --- |
| 1 | `save preserves the original permission bits despite umask` | `test/notebook.test.mjs:170`（条件 `:171`） | `POSIX permission bits are not portable to Windows` | ✅ **正确**：显式平台守卫，属于设计内预期 skip（Windows 上应有 1 个合理 skip） |
| 2 | `execute streams NDJSON events` | `test/routes.test.mjs:350`（条件 `:351-355`） | `no Python interpreter with jupyter_client/ipykernel` | ❌ **假 skip**：本机装有 Python 3.14.7 + jupyter_client/ipykernel；跳过原因是插件发现返回空（a 类缺陷）。修复后自动转为运行（C 配置实测通过，11.7 ms） |
| 3 | `restart still starts a kernel for an existing notebook` | `test/routes.test.mjs:542`（条件 `:543-547`） | `no Python interpreter with jupyter_client/ipykernel` | ❌ **假 skip**：同上。修复后自动转为运行（C 配置实测通过，7.5 ms） |

> 结论：Windows 上“3 skip”里只有 1 个合理；**另 2 个是把真实产品缺陷掩盖成绿色**，比失败更危险。CI 必须加“跳过数预算/意外 skip 检查”。

---

## 4. `DSH_IPYNB_TEST_PYTHON` 专题：为什么默认会 skip/503

### 4.1 两次全量运行逐条对照：完全相同

| 比较项 | 基线（不设）E1a | 设 `DSH_IPYNB_TEST_PYTHON` E1b | 差异 |
| --- | --- | --- | --- |
| 用例集合（292 个 name+mark） | 292 | 292 | **仅差 0 条**（脚本比对 `onlyInBaseline=[]`、`onlyInEnvVar=[]`） |
| pass / fail / skip | 238 / 51 / 3 | 238 / 51 / 3 | 无差异 |
| 失败清单（51 条 name/位置/错误） | — | — | 逐条一致 |
| duration | 30.40 s | 约 29.8 s | 噪声范围 |

**【实测】结论**：`DSH_IPYNB_TEST_PYTHON` 在 Windows 上**不改变任何测试结果**。原因见下。

### 4.2 两个环境变量的语义（【静态核对】）

| 变量 | 谁读取 | 作用范围 | 在 Windows 上是否有效 |
| --- | --- | --- | --- |
| `DSH_IPYNB_TEST_PYTHON` | **仅** `test/python-helper.mjs:6-11`（`findPython()` 的候选列表首位） | 只影响测试 helper 找到的 Python；`bridge/kernel/e2e/interpreter/notebook schema` 等使用 `findPython()` 的用例 | 有效但非必需：本机 PATH 上的裸 `python` 已能被 `findPython()` 找到（见 4.3），所以设不设都一样 |
| `DSH_IPYNB_PYTHON` | **仅** `lib/env.js:120-122`（`collectCandidates()` 的首个候选，source=`DSH_IPYNB_PYTHON`） | 插件/路由/内核路径：`/ipynb/interpreters`、`/ipynb/execute`、`/ipynb/restart`、e2e 真实内核用例 | **有效**：设置后 Windows 发现 1 个解释器，5 个用例由 fail/skip 转 pass（§4.4） |

> 换言之：README 第 156 行与 `.github/workflows/test.yml:39` 教用户/CI 设 `DSH_IPYNB_TEST_PYTHON`，但**插件侧发现根本不读它**。在 Linux/macOS 上因为 `python3` 在 PATH 上能正常发现，这个缺口被掩盖；到 Windows 就暴露为 0 解释器。**这是文档 + CI 的测试缺口**：Windows CI/本地文档必须同时说明 `DSH_IPYNB_PYTHON`。

### 4.3 根因：`lib/env.js` 的解释器发现是 Unix 布局（真实缺陷）

Windows 上装有 **两个** 可用/可见的 Python（`where python` = `C:\Python314\python.exe`；`C:\Users\kexio\miniconda3\python.exe` 也在 PATH 上），但插件一个都发现不了：

| 发现来源 | 代码位置 | Unix 假设 | Windows 实际 | 结果 |
| --- | --- | --- | --- | --- |
| PATH | `lib/env.js:64-76`（`findOnPath`）+ `:126`（`findOnPath(['python3','python'])`） | 候选名是 `python3`/`python`，`path.join(dir, name)` 拼出**无扩展名**路径，再 `stat`+`access(X_OK)`（`:53-62`） | PATH 上只有 `python.exe`（`C:\Python314\python.exe`、`C:\Users\kexio\miniconda3\python.exe`）；没有名为 `python` 的文件 | **0 命中** |
| conda | `lib/env.js:78-99` | 读 `~/.conda/environments.txt` 后拼 `<env>/bin/python3` | 本机 `~/.conda/environments.txt` 存在且列出 `C:\Users\kexio\miniconda3`；该环境实际是 `<env>\python.exe`（无 `bin/`） | **0 命中** |
| DSH 内置 Python | `lib/env.js:129-147` | `.../dependencies/python/bin/python3` | Windows bundle 布局不同（未处理） | **0 命中**（本机 DSH_HOME 下无该路径） |
| `DSH_IPYNB_PYTHON` | `lib/env.js:120-122` | 无假设 | 显式绝对路径 | **唯一有效入口** |

**插桩实测（E3）**：保留 `lib/env.js` 真实的候选枚举与 `fs` 解析，只把被沙箱禁止的 Python 探测子进程替换为“返回 ok 的假探测”（使用仓库测试同款的 `syncBuiltinESMExports()` mock 技术），四种环境组合结果：

| 组合 | 被探测到的候选路径 | interpreters | default |
| --- | --- | --- | --- |
| 都不设 | `[]` | 0 | `null` |
| 只设 `DSH_IPYNB_TEST_PYTHON` | `[]` | 0 | **`null`** |
| 只设 `DSH_IPYNB_PYTHON` | `["C:\\Python314\\python.exe"]` | 1 | `C:\Python314\python.exe` |
| 两个都设 | `["C:\\Python314\\python.exe"]` | 1 | `C:\Python314\python.exe` |

同一插桩脚本里直接复刻 PATH 查找（等价 `existsExecutable`）的静态证据：`pathLookupFiles = ["C:\\Python314\\python.exe", "C:\\Users\\kexio\\miniconda3\\python.exe"]` —— 即**文件存在**，只是 `findOnPath` 拼的 `...\python` 不存在。

**失败/跳过传导链**（`resolveInterpreter` 位于 `lib/env.js:288-319`，无 default 时在 `:292-300` 抛 503）：

```
lib/env.js 发现 0 个解释器
  └─ resolveInterpreter() → ApiError('kernel-unavailable', 503)
       ├─ lib/routes.js:229  execute 路由 → 未开始流式即 503
       │    ├─ e2e.test.mjs:99           期望 200，实际 503            → fail（a-1）
       │    ├─ routes.test.mjs:472       drain 回调 0 个               → fail（a-2）
       │    └─ routes.test.mjs:350       测试自己调 discoverInterpreters() 后 skip（假 skip #2）
       ├─ lib/routes.js:398  restart 路由 → 503
       │    ├─ routes.test.mjs:515       restart 503≠200               → fail（a-3）
       │    └─ routes.test.mjs:542       skip（假 skip #3）
       └─ /ipynb/interpreters、/health 显示空解释器（产品侧 Windows 不可用）
```

**产品影响（比测试更重要）**：在 Windows 上按 README 装好 Python + jupyter_client/ipykernel 后，插件仍会认为“没有解释器”，`/ipynb/execute` 永远 503。这使 `CODE_REVIEW.md` 的 **L-14 从“Low/未实测”升级为 Windows 平台的阻断级缺陷**（不是测试缺口）。

### 4.4 设置 `DSH_IPYNB_PYTHON` 后转为 pass 的 5 个用例（E1c 实测）

| 用例 | 基线 | +PLUGIN | 耗时 |
| --- | --- | --- | ---: |
| `execute route streams a real kernel run to completion`（e2e:66） | ✖ 503 | **✔** | 2754.6 ms |
| `execute streams NDJSON events`（routes:350） | ﹣ skip | **✔** | 11.7 ms |
| `execute waits for drain instead of dropping the final reply`（routes:429） | ✖ drain 未触发 | **✔** | 10.5 ms |
| `status, interrupt, restart and shutdown work after the notebook is deleted`（routes:485） | ✖ restart 503 | **✔** | 18.0 ms |
| `restart still starts a kernel for an existing notebook`（routes:542） | ﹣ skip | **✔** | 7.5 ms |

同一次运行的剩余 48 fail / 1 skip（§4.5）证明：**这些用例的失败/跳过与 Python 安装无关，只与“插件发现能否拿到 default 解释器”有关**。

### 4.5 C 配置下剩余 48 fail / 1 skip 的构成（E1c）

| 类别 | 数量 | 明细 |
| --- | ---: | --- |
| c 环境权限（symlink EPERM） | 42 | control-symlink 35 + gate 7（§3.3） |
| b 宿主 locale | 3 | client.test.mjs `:79`/`:156`/`:501`（§3.4 b-1..3） |
| b venv `bin/python3` 布局 | 1 | interpreter.test.mjs `:37`（§3.4 b-4；需配合 env.js 修复） |
| b POSIX 路径 / ACL | 2 | routes.test.mjs `:221`（`/etc/hosts`）、`:337`（`chmod 0o000`）（§3.4 b-5..6） |
| 剩余 skip | 1 | notebook `:170` POSIX 权限位（设计内） |

### 4.6 修复建议（代码 + 文档，均未实际修改）

1. **`lib/env.js` 平台化候选枚举**（P0）：
   - PATH：Windows 下用 PATHEXT 组合命名（对 `python`/`python3` 再拼 `.exe`/`.cmd`/…），或直接枚举目录中 `python*.exe`；POSIX 保持现状。等价做法是先 `path.parse` 再按 `process.env.PATHEXT` 展开。
   - conda：Windows 用 `<env>\python.exe`（POSIX 用 `<env>/bin/python3`）。
   - DSH 内置 Python：按 `process.platform` 选择 `bin/python3` / `python.exe`。
   - 现有 `resolveInterpreterIdentity()`（`:101-110`）的 `dirname(dirname())` + `pyvenv.cfg` 逻辑对 `<venv>\Scripts\python.exe` 恰好成立，可保留。
   - 为上述布局补 **跨平台可跑的单元测试**（mock `fs`/`execFile` 或注入平台名），避免“Windows 只有真机才测得到”。
2. **文档/CI**：README:156 与 `.github/workflows/test.yml:39` 增加 `DSH_IPYNB_PYTHON` 的说明；或让 `lib/env.js` 在设置了 `DSH_IPYNB_TEST_PYTHON` 时把它作为附加候选（仅测试场景可行的话需显式说明）。
3. **测试侧**：routes 单测把“解释器选择”抽成可注入依赖，避免 drain/背压这类纯 HTTP 行为依赖宿主机 Python（§5.7）。

---

## 5. 测试代码中的平台假设清单（grep 证据 + 可落地改法）

> 以下均**只给建议，未修改任何测试/源码**。行号基于 `8c1ad8e`。

### 5.1 symlink 权限（42 个失败的直接原因）

| 证据 | 位置 |
| --- | --- |
| 导入 `symlink` | `test/control-symlink.test.mjs:5`；`test/gate.test.mjs:3` |
| 文件类 symlink 创建（无守卫） | `control-symlink.test.mjs:56`；`gate.test.mjs:89,126,148,168,183,197,213`（以及 `:316,320,321,347,467`） |
| 目录类 symlink 创建（无守卫） | `control-symlink.test.mjs:68` |
| 现有守卫只测“大小写不敏感 FS” | `control-symlink.test.mjs:52-55`、`:64-67`、`sameExistingPath()` `:178-185` |
| gate 完全没有守卫 | `gate.test.mjs` 全文无 `process.platform`/能力探测 |
| 宿主权限证据 | `whoami /priv` 无 `SeCreateSymbolicLinkPrivilege`；开发者模式注册表值不存在；`fs.symlink` file/dir → `EPERM`，`junction` → OK（§3.3） |

**建议改法**（能力探测 + 明确 skip reason，对 `gate.test.mjs` 与 `control-symlink.test.mjs` 通用）：

```js
// test helper: 只探测一次，结果缓存
async function symlinkCapability() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-symlink-probe-'))
  try {
    await symlink('target', path.join(dir, 'link'), 'file')
    return { ok: true }
  } catch (error) {
    return { ok: false, code: error.code }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const SYMLINK = await symlinkCapability() // 顶层 await，模块加载时执行
```

- 每个 `setup()`/相关 `test()` 开头：`if (!SYMLINK.ok) { t.skip('Requires symlink creation capability (SeCreateSymbolicLinkPrivilege / Developer Mode); got ' + SYMLINK.code); return }`。
- 目录类用例在 Windows 可考虑用 **junction** 兜底：`await symlink(path.resolve(workspace, target), linkPath, 'junction')`（实测可用），但 junction 目标必须绝对路径、不能悬空、语义与 symlink 不完全相同，只适合“目录链接存在性/身份”类用例，不可无差别替换。
- 不要用 `process.platform === 'win32'` 一律 skip：Windows 开发者模式/提权 runner 上是能创建 symlink 的，能力探测更精确（这是 CI 建议的通用模式：[pmd 的 Windows symlink 测试改进](https://github.com/pmd/pmd/pull/5918)、[mcp-utils 的“Windows 上目录链接用 junction”约定](https://raw.githubusercontent.com/GenvidTechnologies/mcp-utils/refs/heads/main/CLAUDE.md)）。
- 计数核对：`control-symlink.test.mjs` 共注册 **35** 个用例，其中 **28 个** 带 `caseMismatch: true`（依赖大小写不敏感 FS，与 `README.md:156` 的“约 28 个大小写回归用例”口径吻合），另外 7 个（`:228`/`:256`/`:270` 各 2 个 + `:420`）只依赖 symlink、不依赖大小写。Windows 上 **35 个全部** 因 symlink EPERM 失败；Linux ext4 预计 skip 那 28 个，其余 7 个可运行。

### 5.2 POSIX 绝对路径

| 证据 | 位置 | Windows 行为（【实测】） |
| --- | --- | --- |
| 用例用 `/etc/hosts` 表示“工作区外的绝对路径” | `test/routes.test.mjs:219` | `path.isAbsolute('/etc/hosts')=true`、`path.resolve('/etc/hosts')='C:\\etc\\hosts'`、`realpath='ENOENT'` → 404 而非 403 |
| `gate.test.mjs` 纯函数单测使用 `/tmp/...` | `gate.test.mjs:35-38,65,102-103` | 当前恰好通过（`path.relative` 对同盘根路径仍成立），但语义是 POSIX 的，建议改为 `path.join(os.tmpdir(), ...)` |
| README 示例路径 | `README.md`/`README_ZH.md` 的 `python3` 命令 | 见 §6 |

**建议改法**：用临时目录构造真实“工作区外绝对路径”（如 `mkdtemp` 后取 `path.join(base, 'outside.ipynb')` 或 `path.resolve(dir, '..', 'outside.ipynb')`）。

### 5.3 POSIX 权限位 / `chmod` / `getuid`

| 证据 | 位置 | Windows 行为 |
| --- | --- | --- |
| `chmod(protectedDir, 0o000)` 制造不可访问目录 | `test/routes.test.mjs:331`（清理 `:340`） | 【实测】`chmod 0o000` 后目录内仍可读写 → 保存走到 409 而非 404 |
| skip 守卫只排除 root | `test/routes.test.mjs:315` `skip: process.getuid?.() === 0` | Windows `process.getuid` 为 `undefined`，守卫失效 |
| 正确的平台 skip 范例 | `test/notebook.test.mjs:170-171` `skip: process.platform === 'win32' && '…'` | ✅ 建议复用该写法 |

**建议改法**：`routes.test.mjs:315` 的 skip 条件扩为 `process.platform === 'win32' || process.getuid?.() === 0`；或改用不依赖 ACL 的错误注入（mock `fs` 的 `EACCES`）来测试同一条错误分类逻辑。

### 5.4 宿主 locale（`navigator.language`）

| 证据 | 位置 |
| --- | --- |
| 客户端 fallback 语言 | `client.js:129-131`：`const browserLocale = (typeof navigator !== 'undefined' && navigator.language) || 'en'` |
| 测试 harness 未隔离 | `test/client.test.mjs:8-52` 的 `loadClient()` 只搭 `window`/`document`/`react`，没有 pin `navigator` |
| 硬编码英文断言 | `client.test.mjs:79`（`'Jupyter Notebook'`）、`:156`（`'Run'`）、`:501`（`'Notebook output image'`） |
| 宿主实际值 | 【实测】Node v24.19.0 全局 `navigator.language = 'zh-CN'`（来自系统 ICU 区域），`Intl` locale 同 |

**建议改法**：在 `loadClient()` 动态 import 之前固定：

```js
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US', languages: ['en-US'] },
  configurable: true,
})
```

并**额外**加一条“宿主语言为 zh-CN 时输出中文”的用例（显式设置后再恢复），这样既有确定性，又保留本地化覆盖。**实测**：加 pin 后 `client.test.mjs` **58/58 通过**；不加则 55/58（E3，`pin-en-locale.mjs`）。

> 这 3 个失败不是 Windows 独有：任何 zh-CN 区域的 macOS/Linux 开发机同样会挂，属于测试 hermeticity 问题（b 类）。

### 5.5 `python3` / PATH / HOME / venv 布局

| 证据 | 位置 | 说明 |
| --- | --- | --- |
| 测试 helper 候选列表 | `test/python-helper.mjs:6-11`：`DSH_IPYNB_TEST_PYTHON` → `/opt/miniconda3/bin/python3` → `python3` → `python` | 【实测】Windows 上 `findPython()` 返回裸 `'python'`（libuv 按 PATHEXT 解析到 `C:\Python314\python.exe`），所以真实内核测试能跑；`/opt/miniconda3/...` 是 POSIX 专属，属无害噪声；`python3` 在本机是 WindowsApps 别名（exit 9009），依赖 Store 别名的机器上可能慢 |
| interpreter 用例 1 使用 `bin/python3`/`HOME` | `test/interpreter.test.mjs:27,37,40,41,49` | Windows venv 是 `Scripts\python.exe`、无 `HOME` 语义 → `ENOENT`（b-4） |
| interpreter 用例 2 已平台化 | `test/interpreter.test.mjs:146-148` | ✅ 正确范例：`process.platform === 'win32' ? Scripts/python.exe : bin/python3` |
| 路由/内核类测试对 `python` 的隐式依赖 | `routes.test.mjs:350/542` 有 skip 守卫；`routes.test.mjs:429` **没有**；`e2e.test.mjs` 依赖 `discoverInterpreters()` | 见 §5.7 |

**建议改法**：
- `python-helper.mjs`：候选按平台裁剪（win32：`['python.exe','python','py']`；POSIX：`['python3','python']`），并保留 `DSH_IPYNB_TEST_PYTHON` 优先；去掉硬编码 `/opt/miniconda3/...` 或加平台条件。
- `interpreter.test.mjs` 用例 1：照 `:146-148` 平台化；并且**在 `lib/env.js` Windows 支持落地前对该用例 skip**（否则仍会因 `findOnPath` 不认 `Scripts\python.exe` 而失败）。

### 5.6 信号与进程（Windows 上未发现真实问题，记录核对结论）

| 证据 | 位置 | 结论 |
| --- | --- | --- |
| 子进程 `SIGTERM` | `test/bridge.test.mjs:85`、`python/bridge.py:215-216` | ✅ Windows 上 Node 的 `kill('SIGTERM')` 映射为 TerminateProcess，bridge/kernel 用例全绿 |
| 子进程内忽略 `SIGINT` | `test/bridge.test.mjs:206`（`signal.SIG_IGN`） | ✅ bridge 用例通过 |
| mock 的 kill 断言 | `test/kernel-lifecycle.test.mjs:189,200`（`proc.kills.includes('SIGTERM')`） | ✅ mock 对象，与平台无关 |
| `SIGKILL` 升级 | `lib/kernel.js:610` | Windows 上映射为强制终止；真实进程回收用例在 Windows 上通过（kernel 9/9、kernel-lifecycle 54/54） |
| `process.kill(pid, 0)` 存活探测 | 全仓 grep **未发现**（测试与 lib 都没有） | Windows 上 `kill(pid, 0)` 语义不可靠，未来新增存活探测时应改用进程句柄/错误码，不要用 signal 0 |

### 5.7 用例的隐藏宿主依赖（测试设计缺口）

| 证据 | 说明 | 建议 |
| --- | --- | --- |
| `routes.test.mjs:429`（drain）无 skip 守卫，但同样需要 default 解释器 | 与 `:350`/`:542` 的同类依赖不一致；在“无 Python 的机器”上它会以 fail 出现，而不是 skip | 路由单测 mock `lib/env.js` 的 discovery（或注入 `python`），保持 HTTP 行为用例 hermetic；修 env.js 后自然转绿 |
| `e2e.test.mjs:120` 用 `(await discoverInterpreters()).default` 断言 | 正确依赖真实环境，但失败时只报 503，定位成本高 | 在测试开头加 `assert.ok(default, 'requires a discovered interpreter (set DSH_IPYNB_PYTHON on Windows)')`，让失败原因直接可读 |
| `routes.test.mjs:351/543` 的 skip reason 文案 | 写“no Python interpreter …”，但实际是**发现缺陷**，容易误导 | 改为区分“系统无 Python”与“插件发现为空”；或修复后删除该 skip |
| `execute-disconnect.test.mjs:86-87` 与 `control-symlink.test.mjs:76-81` 的做法 | 它们用 `mock execFile` + `DSH_IPYNB_PYTHON=process.execPath` 把发现与真实 Python 解耦 → Windows 全绿（19/19、35 个用例里 symlink 之外的部分本会全绿） | ✅ 可作为其他路由/内核测试解耦的参考范式 |

### 5.8 测试改造清单（按优先级）

| 优先级 | 文件:行 | 改动 | 关联失败 |
| --- | --- | --- | --- |
| P0 | `lib/env.js:64-76,78-99,120-148` | Windows 发现（代码修复，非测试） | a-1..3 + 2 假 skip |
| P1 | `test/control-symlink.test.mjs:52-68,178-185` | symlink 能力探测 + skip reason（保留大小写守卫） | 35 个 c |
| P1 | `test/gate.test.mjs:86-213` | symlink 能力探测 + skip reason | 7 个 c |
| P1 | `test/routes.test.mjs:315` | skip 条件加 `process.platform === 'win32'`（或 mock EACCES） | b-6 |
| P1 | `test/routes.test.mjs:219` | 用临时目录构造工作区外绝对路径 | b-5 |
| P1 | `test/client.test.mjs:8-52` | pin `navigator.language='en-US'`；补 zh-CN 用例 | b-1..3 |
| P2 | `test/interpreter.test.mjs:37-49` | venv 布局平台化；env.js 修复前 skip | b-4 |
| P2 | `test/python-helper.mjs:6-11` | 候选列表按平台裁剪 | 环境健壮性 |
| P2 | `test/routes.test.mjs:429` | 解耦 discovery 依赖（mock/注入） | 隐藏依赖 |
| P3 | `README.md:156` / `.github/workflows/test.yml:39` | 文档与 CI 增加 `DSH_IPYNB_PYTHON` 说明 | §4.6 |

---

## 6. 静态检查与打包（Windows 实测 vs Mac 基线）

### 6.1 结果总表

| 检查 | Mac 基线（`CODE_REVIEW.md` §6） | Windows 实测（本会话） | 结论 |
| --- | --- | --- | --- |
| `node --check` | 通过 | **8/8 文件通过**（`index.js`、`client.js`、`lib/env.js`、`lib/gate.js`、`lib/json.js`、`lib/kernel.js`、`lib/notebook.js`、`lib/routes.js`） | ✅ 语法一致 |
| `python -m py_compile python/bridge.py` | 通过 | **exit 0**（`C:\Python314\python.exe`） | ✅；`__pycache__` 已在 `.gitignore` |
| `npm pack --dry-run` | **18 文件**（含 `examples/demo.ipynb`） | **18 文件**，清单与 Mac 基线逐项一致 | ✅ 打包内容一致 |

Windows 上 `npm pack --dry-run --json` 实测产物（18 个）：

`LICENSE`、`NOTICE`、`README.md`、`client.js`、`cordis.patch.yml`、`examples/demo.ipynb`、`icon.svg`、`index.js`、`lib/env.js`、`lib/gate.js`、`lib/json.js`、`lib/kernel.js`、`lib/notebook.js`、`lib/routes.js`、`locale/en.json`、`locale/zh.json`、`package.json`、`python/bridge.py`。

### 6.2 README/CI 命令在 Windows 上的两个坑（建议顺手修文档）

| 问题 | 证据（【实测】） | 建议 |
| --- | --- | --- |
| README:151/152 用 `node --check index.js lib/*.js client.js` | `node --check` **只检查第一个位置参数**：`node --check good.js bad.js` → exit 0（坏文件被忽略）；且 Windows 的 pwsh/cmd **不展开 glob**，`lib/*.js` 原样传给 Node。→ README 这条命令在 Windows 上实际只检查了 `index.js`，属**假绿**（bash 下虽然会展开，但 Node 仍只查第一个文件，Mac/Linux 同样是假绿） | 改为逐文件循环（CI 片段见 §7.2），或写一个 `scripts/check-syntax.mjs` 遍历文件 |
| README:152/README_ZH 用 `python3 -m py_compile` | Windows 上 `python3` 是 Microsoft Store 别名（`C:\Users\kexio\AppData\Local\Microsoft\WindowsApps\python3.exe`），实测 `python3 -m py_compile` → **exit 9009**；本机 CPython 只提供 `python.exe`/`pythonw.exe` | 文档改成 `python -m py_compile`（或 `py -3 -m py_compile`），CI 用 `actions/setup-python` 提供的 `python` |
| `.github/workflows/test.yml:39` 在 bash 里拼 `$GITHUB_ENV` | Ubuntu 上正常；若直接复制到 Windows pwsh 会失败（`$env:` 语法不同） | Windows job 用 pwsh 写法（§7.2） |

### 6.3 沙箱假象（d 类，仅记录，不进基线）

在**本会话 workspace-write 沙箱**下（非 Windows 全权限/CI 行为）：

| 现象 | 证据 | 归类 |
| --- | --- | --- |
| `npm test` 13 个文件全部 `Error: spawn EPERM`（`ℹ tests 13 / pass 0 / fail 13`） | `sandbox-npm-test.log`；根因是 Node 测试运行器 pipe-spawn 被沙箱拒绝 | d |
| `test/notebook.test.mjs:665` 的 `spawnSync(schemaPython, …)` 在沙箱内额外失败 1 个（`spawnSync python EPERM`）；全权限下该文件为 31 pass / 0 fail / 1 skip | E2 日志 vs E1a | d |
| `npm pack` 因 npm cache 在 `C:\Users\kexio\AppData\Local\npm-cache`（工作区外）被拒；加 `--cache %TEMP%\…` 后成功并输出 18 文件 | `npm-pack-raw-windows.log` | d（CI 无此问题） |

> 结论：d 类不影响 Windows 结论；但它解释了为什么本报告的实跑证据分三层（§1.2）。

---

## 7. Windows CI 矩阵建议

### 7.1 推荐矩阵

| OS / job | 作用 | 预期（修复后） |
| --- | --- | --- |
| `ubuntu-latest`（现有，保留） | 主回归；速度最快；POSIX 布局 | 292 collected；预计 28 个 `caseMismatch` 用例 skip（README 口径），其余 7 个 symlink 用例在 Linux 可运行；建议实测后写死 skip 预算 |
| `macos-latest`（新增） | **唯一能原生跑满 `control-symlink` 35 个大小写/symlink 回归的免费 runner**（APFS 大小写不敏感 + 允许 symlink）；对应当前 0 skip 的 Mac 基线 | 292 pass / 0 fail / 0 skip（与审查基线一致） |
| `windows-latest`（新增） | 解释器发现布局、PATH/PATHEXT、ACL/chmod、宿主 locale、打包与静态检查 | 修复 + 能力探测后：292 collected / **249 pass / 0 fail / 43 skip**（42 symlink 能力 skip + 1 POSIX 权限位 skip）；若 runner 启用开发者模式则可跑满（最多 291/292） |

### 7.2 Windows job 建议片段（`continue-on-error` 起步，修复后再设为 required）

> 说明：以下为**建议片段**，未在 GitHub Actions 上实测；Windows runner 上的 symlink 能力（是否默认开启开发者模式/提权）需先看首次运行结果，再决定 §7.4 的策略。

```yaml
  test-windows:
    runs-on: windows-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install Python kernel dependencies
        shell: pwsh
        run: |
          python -m pip install --upgrade pip
          python -m pip install jupyter_client ipykernel nbformat
          $python = (python -c "import sys; print(sys.executable)").Trim()
          # 测试 helper 读它
          "DSH_IPYNB_TEST_PYTHON=$python" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
          # 插件发现（lib/env.js）读它；在 Windows 发现缺陷修复前这是必需项
          "DSH_IPYNB_PYTHON=$python"     | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8

      - name: Static checks
        shell: pwsh
        run: |
          $files = @('index.js', 'client.js') + (Get-ChildItem lib/*.js | ForEach-Object { $_.FullName })
          foreach ($file in $files) {
            node --check $file
            if ($LASTEXITCODE -ne 0) { throw "node --check failed: $file" }
          }
          python -m py_compile python/bridge.py

      - name: Assert plugin interpreter discovery (prevents silent skips)
        shell: pwsh
        run: |
          node -e "import('./lib/env.js').then(async (m) => { const d = await m.discoverInterpreters({ fresh: true }); console.log(JSON.stringify(d)); if (!d.default) { console.error('plugin discovery found no interpreter'); process.exit(1) } })"

      - name: Run tests
        shell: pwsh
        run: |
          npm test 2>&1 | Tee-Object -FilePath npm-test-windows.log
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

      - name: Check package contents
        shell: pwsh
        run: npm pack --dry-run
```

### 7.3 macOS job 建议片段

```yaml
  test-macos:
    runs-on: macos-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install Python kernel dependencies
        run: |
          python -m pip install --upgrade pip
          python -m pip install jupyter_client ipykernel nbformat
          echo "DSH_IPYNB_TEST_PYTHON=$(python -c 'import sys; print(sys.executable)')" >> "$GITHUB_ENV"
      - name: Run tests
        run: npm test
      - name: Check package contents
        run: npm pack --dry-run
```

> macOS runner 原生允许 symlink 且 APFS 大小写不敏感，是跑满 `control-symlink.test.mjs` 35 个用例（当前 Linux 因大小写敏感性会 skip）的最稳方式。

### 7.4 symlink 覆盖与“防静默 skip”策略（建议顺序）

1. **先做能力探测 skip（测试侧改动，P1）**：Windows job 不依赖 runner 权限，42 个 symlink 用例显式 skip 并带 reason；`npm test` 变为全绿（249 pass / 43 skip）。这是最小风险路径。
2. **可选尝试在 runner 上打开 symlink 能力**（best effort，不能作为绿色前提）：

```yaml
      - name: Try to enable Windows Developer Mode for symlink tests
        shell: pwsh
        continue-on-error: true
        run: |
          reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v AllowDevelopmentWithoutDevLicense /d 1
          git config --global core.symlinks true
```

   - 该注册表项是开发者模式的已知开关，但**是否无需重启/是否需要提权取决于 runner 镜像**，本机无法验证；若首次 Windows CI 运行后 `control-symlink` 仍 EPERM，就退回策略 1。
   - 目录类用例可改用 **junction**（`fs.symlink(..., 'junction')`，本机实测可用），文件类用例只能依赖权限。
3. **加“skip 预算 + 意外 skip 检查”步骤**，防止再出现本次的“假 skip”：

```yaml
      - name: Fail on unexpected skips
        shell: pwsh
        run: |
          $log = Get-Content npm-test-windows.log -Raw
          $skipped = [int]([regex]::Match($log, 'ℹ skipped (\d+)').Groups[1].Value)
          $expected = 43   # 42 symlink 能力 skip + 1 POSIX 权限位；若启用开发者模式则允许更低
          if ($skipped -gt $expected) {
            Write-Error "unexpected skips: $skipped > $expected (a skip may be masking a discovery defect)"
            exit 1
          }
```

4. **解释器发现断言**（§7.2 的 `Assert plugin interpreter discovery` 步骤）在**修复 `lib/env.js` 前**依赖 `DSH_IPYNB_PYTHON` 才能通过——这正好把“Windows 发现缺陷”钉死在 CI 里，而不是被 skip 掩盖。

### 7.5 修复顺序建议

| 顺序 | 内容 | 收益 |
| --- | --- | --- |
| P0 | `lib/env.js` Windows 发现（代码）+ 对应单元测试 | 修掉 3 fail + 2 假 skip；Windows 产品可用 |
| P1 | 测试可移植性（symlink 能力探测、POSIX 路径/chmod、locale pin） | 51 fail 中 42+6 归零或转合理 skip |
| P2 | 文档/CI（`DSH_IPYNB_PYTHON`、`python` 而非 `python3`、逐文件 `node --check`、Windows/macOS job） | 防止回归与再次假绿 |
| P3 | 路由/内核测试与 discovery 解耦、interpreter venv 用例平台化 | 测试在任意机器上可判定，不依赖宿主状态 |

---

## 8. 附录

### A. 复现命令（本机实测所用，均为临时/只读操作，未修改仓库）

```powershell
# A1 全量基线（需 danger-full-access；本会话沙箱内会被 pipe EPERM 拦住）
npm test

# A2 本会话沙箱内逐文件复跑（同进程隔离，避免 pipe spawn）
node --test --test-isolation=none --test-timeout=180000 --test-reporter=spec test/<file>.test.mjs

# A3 lib/env.js 发现插桩（mock execFile，保留真实候选枚举；使用仓库测试同款 syncBuiltinESMExports）
node "$env:TEMP\dsh-win-review\win-tests\env-probe.mjs" "<variant>"

# A4 routes 根因隔离：mock 探测 + DSH_IPYNB_PYTHON，看 4 fail/2 skip 哪些转绿
node --import "file:///<TEMP>/dsh-win-review/win-tests/routes-proof-preload.mjs" `
  --test --test-isolation=none --test-timeout=180000 --test-reporter=spec test/routes.test.mjs
# => 22 tests / 20 pass / 2 fail / 0 skip（剩 2 个为 §3.4 的 POSIX 假设）

# A5 client locale 根因隔离：pin navigator 后 58/58
node --import "file:///<TEMP>/dsh-win-review/win-tests/pin-en-locale.mjs" `
  --test --test-isolation=none --test-reporter=spec test/client.test.mjs

# A6 findPython 对照（有/无 DSH_IPYNB_TEST_PYTHON）
node "$env:TEMP\dsh-win-review\win-tests\findpython-probe.mjs"

# A7 静态检查（逐文件，避免 node --check 只查第一个参数）
foreach ($f in @('index.js','client.js') + (Get-ChildItem lib/*.js)) { node --check $f.FullName }

# A8 Python 语法检查（Windows 用 python，不要 python3）
python -m py_compile python/bridge.py

# A9 打包（沙箱内需 --cache 指向会话 TEMP）
npm pack --dry-run --json --cache "$env:TEMP\dsh-win-review\win-tests\npm-cache"

# A10 symlink 能力探测
node -e "const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');(async()=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'probe-'));for(const t of ['file','dir','junction']){try{await fs.symlink('x',path.join(d,'l-'+t),t);console.log(t,'OK')}catch(e){console.log(t,e.code)}}await fs.rm(d,{recursive:true,force:true})})()"

# A11 宿主 locale
node -e "console.log(navigator.language, Intl.DateTimeFormat().resolvedOptions().locale)"
```

### B. 证据文件清单

| 文件 | 内容 |
| --- | --- |
| E1a `…\dsh-ipynb-npm-test-fullaccess.log` | Windows 基线全量日志（292/238/51/3，30.4 s） |
| E1b `…\dsh-ipynb-npm-test-envpy.log` | +`DSH_IPYNB_TEST_PYTHON` 全量日志（与基线逐条相同） |
| E1c `…\dsh-ipynb-npm-test-pluginpy.log` | +`DSH_IPYNB_PYTHON` 全量日志（292/243/48/1，29.75 s） |
| E2 `%TEMP%\dsh-win-review\win-tests\sandbox-*.log` | 9 个非 Python 文件的沙箱内同进程复跑日志 |
| E3 `%TEMP%\dsh-win-review\win-tests\` | `env-probe.mjs`、`routes-proof-preload.mjs`、`pin-en-locale.mjs`、`findpython-probe.mjs`、`parse-log2.mjs`、`npm-pack-raw-windows.log`、`npm-pack-windows.json`、`sandbox-npm-test.log` |

### C. 进程与工作树状态

- 本子域运行期间启动的 `python`/`node` 进程均已退出（本子域最后一次 python 调用约 16:32，早于下面这个进程的启动时间），**本子域无残留**。
- 结束后另观察到 **PID 3036 `C:\Python314\python.exe`（16:37:58 启动，CPU ~0.9 s）**：启动时间晚于本子域全部 python 调用，且沙箱拒绝读取 `Win32_Process.CommandLine`，无法确认归属（可能是其他队友/Lead 的验证进程或测试泄漏的内核/bridge）；**非本子域启动，故未清理**，建议 Lead 最终收尾时确认并清理。
- 仓库工作树：`git status --porcelain` 显示 `?? docs/windows-review/`（本文件）与 `?? CODE_REVIEW_WINDOWS.md`（其他队友的文件），HEAD 仍为 `8c1ad8e`；`python/__pycache__` 已清理（且被 `.gitignore` 覆盖）。
- 未修改任何测试/源码/CI 文件，未 `git add`/`commit`。

### D. 未核实事项

1. GitHub 托管 `windows-latest` 实际是否允许 `fs.symlink`（是否默认开发者模式/提权）未验证；§7.4 的策略 1（能力探测 skip）不依赖该结论。
2. GitHub `actions/setup-python` 在 Windows 上是否提供 `python3` 名称未验证；因此 CI 片段显式设置 `DSH_IPYNB_PYTHON`，不依赖该别名。
3. CI 使用 Node 22，本机实测 Node 24.19.0；两者测试框架行为（`node --test` glob、`navigator` 全局）在该范围内应当一致，但未在 Node 22 实跑。
4. e2e / bridge / kernel / interpreter 的真实内核用例未由本会话独立重跑（沙箱禁止 pipe spawn），其 Windows 结果来自 Lead 全权限日志（E1a/E1c）。
5. Mac 基线 292/292 为 `CODE_REVIEW.md` 记录值，未在本次 Windows 审查中重新运行 macOS。
