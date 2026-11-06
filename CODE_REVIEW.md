# dsh-bsb-ipynb 代码审核报告

- 审核对象（基线）：`dsh-bsb-ipynb`，git HEAD `1b15b56`
- 审核日期：2026-11-06
- **更新记录：2026-11-06 审核后修复已合入 5 个 commit（截至 HEAD `3896bf9`），本报告已同步更新每项发现的状态；当前全量测试 263 pass / 0 fail**
- 审核方式：4 名领域审查员并行深读 + Lead 独立复核与交叉验证；所有结论尽量给出 file:line、触发条件与可重跑证据
- 交付物：本报告（汇总与结论）+ 4 份领域报告（附录 A）
- 说明：审核阶段未修改产品代码；修复阶段的改动均在独立 commit 中。4 份领域报告已归档到 git 标签 `review-archive`（见附录 A），仍保留审核当时的原始描述

---

## 0. 修复进展（截至 `3896bf9`）

### 0.1 commit 索引

| commit | 内容 | 关联发现 |
| --- | --- | --- |
| `27d0659` | Serialize kernel restarts and match ready events by operation id | H-1、M-4、L-25（顺带） |
| `00cd576` | Handle termination signals with deterministic kernel cleanup | L-28（并缓解 M-6 的清理问题） |
| `e2f0bf9` | Add save preflight and clear-output actions for oversized notebooks | H-2（并缓解 L-8 的客户端一侧） |
| `09f5819` | Add docs, metadata fixes and client UX fixes | L-16、L-17、L-19、L-20、L-21；文档/元数据与 D 组弱断言 |
| `3896bf9` | Apply small-fix batch for kernel lifecycle and client robustness | M-5、M-7a、M-7b、L-2、L-3、L-9、L-10、L-14、L-18、L-22、L-24、L-26、L-29 |

### 0.2 状态统计

| 级别 | 审核发现 | 已修复 | 部分修复 | 未修 |
| --- | --- | --- | --- | --- |
| High | 2 | 2 | 0 | 0 |
| Medium | 9 | 2（M-4、M-5） | 2（M-6、M-7） | 5（M-1、M-2、M-3、M-8、M-9） |
| Low | 29 | 17 | 1（L-8） | 11 |
| 测试/文档轨道 | 2 High + 6 Medium + 弱断言等 | 弱断言 3 项、版本单源、locale parity、文档/元数据 | T-H1、T-M1/M2/M3/M5/M6 | T-H2、T-M4 |

> M-6 已通过 Phase 2-lite（SIGTERM/SIGINT 确定性清理）消除最严重的清理退化，但“restart 阻塞 command_loop”本身未改，故记为部分修复；M-7 的 `attachment:` 崩溃与 blockquote 递归已修，深层 HTML `cleanNode` 递归未动。

### 0.3 修复引入的行为变化（有意为之）

1. `/ipynb/save`：坏 notebook 即使 baseVersion 过期也先返回 400 `bad-request`（此前 409）；带 details 的权限错误回 404 而非 409；
2. `/ipynb/health`：不再同步探测解释器；未预热时返回 `interpreters.checked:false` 与 0 计数，探测在后台预热缓存；
3. `python` 字段非字符串/空白 → 400 `bad-request`（不再静默回退默认解释器）；
4. 会话 cwd 为相对路径 → `workspace-unknown`（此前按宿主进程 cwd 解析）；
5. 客户端保存前按落盘口径预检 32 MiB，超限不上传；容量阻塞期间暂停 autosave 重试，并可用“清空输出”恢复；
6. Run all 不再依赖 `/ipynb/interpreters` 成功（回退服务端默认解释器）；
7. Markdown fenced code block 按 CommonMark 闭合规则解析（更长的同字符 fence 可闭合、info string 只取首词作语言）。

### 0.4 仍有价值但未修的项

- **设计级 Medium**：M-1（路径 TOCTOU）、M-2（linked worktree 活动根）、M-3（保存 CAS 窗口）、M-6（restart 移出 command_loop）、M-8（大输出 O(n²) 渲染）、M-9（Markdown 占位符管线）；
- **Low**：L-1、L-4、L-5、L-6、L-7、L-11、L-12、L-13、L-15、L-23、L-27，以及 L-8 的服务端一侧；
- **测试轨道**：T-H1（测试解释器探测 helper）、T-H2（DOMParser 清洗器测试）、T-M1/M2/M3/M5/M6、临时目录清理、真实 socket HTTP 测试。

---

## 1. 结论摘要

**总体评价：这是一个完成度与工程质量都明显高于平均水平的插件。** 2180 行浏览器端 + 约 2400 行宿主端 + 659 行 Python 桥接，覆盖 notebook 渲染、编辑、内核执行、持久化、路径安全、乐观并发与大量可靠性边界；审核时 240 个测试全绿（20.5s；修复后 263），文档与实现的数字/接口/错误码一致性非常好（14 个错误码与 `STATUS_BY_CODE` 完全对应，32MiB/64MiB/1.5s/10s/3s 等数字全部正确）。

审核当时发现 **2 个 high、9 个 medium** 级产品代码缺陷，以及测试可信度层面的 2 个 high 级问题。**截至 `3896bf9`：2 个 High 已全部修复，Medium 中 2 项修复、2 项部分修复，Low 已修复 17 项**。原始最严重发现如下：

| # | 严重度 | 结论 | 位置 |
| --- | --- | --- | --- |
| H-1 | **High** | `bridge.py` 的 `restart()` 无互斥。cell 不可中断时「中断超时自动重启」与并发 `restart` 请求可能双线程重入，导致 `self.kc` 绑定到已死内核、**后续 execute 永久挂起**（违背 README「不会永久挂起」）。已用真实内核端到端复现（`local-scratch/kreview/host-race.mjs` → `HANG`），确定性并发实验亦复现双 `restart_kernel`/双 `ready`。 | `python/bridge.py:535-579`（触发点 `292`、`609-610`） |
| H-2 | **High** | 客户端「每 cell 输出 ≤ 32MiB 紧凑 JSON」预算与服务端「整文件 ≤ 32MiB pretty JSON / 请求体 ≤ 64MiB」上限口径不一致：存在「输出能正常显示、但保存必然 413」的区间，且 UI 没有清空输出入口，用户只能有损绕路。已用真实 `lib/notebook.js` 验证：单 cell 接近客户端上限（33,554,284B）→ 落盘超限 163B 必 413；2 个各 17MiB 的 cell → 35.65MB 必 413。 | `client.js:819` vs `lib/notebook.js:9,223,364-371`、`lib/json.js:89` |
| M-1 | Medium | 路径授权（realpath 检查）与真正的文件 I/O 是两次独立解析，无 inode/fd 绑定；授权后替换目标为 symlink 可越界读、替换父目录为 symlink 可越界写（均已实验复现）。README 的 workspace containment 在竞态下不成立。 | `lib/gate.js:59-80` + `lib/notebook.js:263-286,319-388` |
| M-2 | Medium | 工作区根未跟随 better-sidebar 0.28.2 的「活动根」（`activeWorktreeRootOf`，可采纳 linked git worktree）：worktree 会话中文件树里的 notebook 会被全部 403，插件核心功能不可用。 | `lib/gate.js:16-48` |

完整清单见 §3（每项含当前状态）；测试/文档层面的独立发现见 §4；修复 commit 与行为变化见 §0。

**当前结论**：H-1、H-2 及全部高性价比小修已合入；剩余重点是 §0.4 列出的设计级 Medium 与测试轨道缺口（尤其 T-H1：其他机器/CI 上真实内核测试仍会静默 skip）。

---

## 2. 审核范围与基线

### 2.1 范围

| 层 | 文件 | 行数 |
| --- | --- | --- |
| 浏览器端 | `client.js` | 2180 |
| 宿主入口/HTTP | `index.js`、`lib/routes.js`、`lib/json.js` | 20 / 406 / 111 |
| 路径/存储 | `lib/gate.js`、`lib/notebook.js` | 281 / 389 |
| 内核管理 | `lib/kernel.js`、`python/bridge.py` | 680 / 659 |
| 解释器发现 | `lib/env.js` | 294 |
| 测试 | `test/*.test.mjs`（14 个）+ `test/bridge_iopub.py` | 约 4600 + 555 |
| 文档/配置 | `README.md`、`package.json`、`locale/*`、`cordis.patch.yml`、`NOTICE`、`examples/demo.ipynb` | — |

### 2.2 环境与基线

- macOS（APFS 大小写不敏感）、Node v24.13.1、Python 3.14（`/opt/miniconda3/bin/python3`，含 `jupyter_client` 8.10.0 / `ipykernel` 7.3.0 / `nbformat` 5.11.1）
- 宿主：DSH Desktop runtime 0.2.2-rc.1；已安装 `dsh-better-sidebar@0.28.2`（供跨插件契约核对）
- **审核基线测试：`node --test --test-timeout=180000 test/*.test.mjs` → 240 pass / 0 fail / 0 skip，20.5s**（审核开始与结束各跑一次，结果一致）；**修复后当前：263 pass / 0 fail（见 §7.1）**
- 静态检查：`node --check index.js lib/*.js client.js`、`python -m py_compile python/bridge.py` 全部通过
- Node 覆盖率（`--experimental-test-coverage`）：`gate 96.4% / routes 94.3% / kernel 93.5% / notebook 87.9% / env 86.1% / json 85.6%`（行）；`client.js 27.7%` 是**低估**——最复杂的 `client-lifecycle.test.mjs` 在 `vm` 沙箱里执行 client.js，不计入 Node 覆盖率
- 说明：一次带覆盖率并行跑全量时出现过 1 次不可复现的 `client-lifecycle.test.mjs` 文件级失败（239/240，随后的两次全量与单文件均 240/240），疑似并行资源竞争导致的偶发，未作为发现计入

### 2.3 方法与证据等级

每位审查员独立完成「完整通读 → 交叉验证 → local-scratch 最小复现」；Lead 对全部 high 级结论和多数 medium 级结论做了独立复跑。报告中每条发现标注证据等级：

- **【已验证】**：有可重跑的实验或确定性代码路径复现
- **【契约核对】**：对照已安装的 `dsh-better-sidebar@0.28.2` / DSH asar 源码确认，未端到端复现
- **【推测】**：仅代码推理，未复现（明确标注）

---

## 3. 产品代码发现清单

### 3.0 总览

| 级别 | 数量 | 分布 | 当前状态（`3896bf9`） |
| --- | --- | --- | --- |
| **High** | 2 | 内核 1、客户端 1 | ✅ 全部修复 |
| **Medium** | 9 | 路径/存储 3、内核 3、客户端 3 | 2 修复 / 2 部分 / 5 未修 |
| **Low** | 29 | 见 §3.3 | 17 修复 / 1 部分 / 11 未修 |
| **Nit** | 约 15 类 | 见 §3.4（逐条明细见领域报告） | 部分随修复顺带处理 |

---

### 3.1 High

#### H-1【已验证】【已修复 · 27d0659】`bridge.py` 的 `restart()` 无互斥：并发重启可让 execute 永久挂起

- **位置**：`python/bridge.py:535-579`（`restart()` 全流程，`self.restarting` 只是布尔标记，`self.kc = kc` 在 `562-564` 无锁）；并发入口：`python/bridge.py:289-299`（**executor 线程**在中断超时后调用 `self.restart()`）与 `python/bridge.py:609-610`（**command_loop 线程**处理 `{"op":"restart"}` 时调用 `self.restart()`）。放大因素：`run_one()` 的 shell 等待循环（`278-315`）只看 `self.stop`，不检查 `kc is self.kc`/`self.restarting`；宿主侧 `lib/kernel.js:134-150,172-183,326-328` 不区分 `ready` 来源（同一根因的 M-4 症状）。
- **触发条件**（概率低、后果重）：① 用户执行一个无法被中断的 cell（`signal.signal(SIGINT, SIG_IGN)`、捕获 `KeyboardInterrupt`、C 扩展长计算；Windows 上 `interrupt_request` 本身是 ipykernel no-op）；② 用户点「中断」，bridge 在 3s 后由 executor 线程自动重启（约 1-3s）；③ 在这个窗口内另一个客户端/标签页（或 API 调用）发起 `POST /ipynb/restart`——注意重启按钮在第二个标签页里对 busy 内核仍可点击（`client.js:1181` 的 `running` 仅本地状态），且服务端对同解释器重启不检查 busy（`lib/routes.js:377-397`）。
- **后果**：两个线程各自 `stop_channels()`、`restart_kernel()`、创建新 client、覆盖 `self.kc`；若 `self.kc` 落在「已被另一次重启杀掉的内核」的 client 上，`execute` 的消息被 ZMQ 静默丢弃，`run_one()` 在 `get_shell_msg` 上无限等待，而 `kc.is_alive()` 委托 `km.is_alive()` 仍为 true，`iopub_loop` 也不会发 `kernel_died`——**没有自愈路径**。HTTP NDJSON 只剩 15s 一次的 ping，不结束；`entry.busy` 持续为 true，后续 execute 全部 409。这直接违反 README:113「不会永久挂起」。
- **证据**：
  - Lead 独立复跑真实内核脚本：`node local-scratch/kreview/host-race.mjs 4100 1` → `restart result: ok`、旧 run error 结算，随后 `after run: HANG(after-run-hang)`，`RESULT {... "outcome":"HANG"}`
  - 确定性并发实验（fake Manager）：`python local-scratch/kreview/restart-race.py` → `restart_kernel calls: 2`、clients `['old','client-1','client-2']`、只 stop 了 old、`ready` 事件 2 个、最终 `kc=client-2`
  - 审查员另用真实 bridge 观测到 >30s 无 reply、需再次 restart 才报 `shell reply lost: Socket operation on non-socket`
- **建议修复**：
  1. bridge 增加 `self.control_lock = threading.RLock()`，`restart()` 全程持锁；或让 executor 只投递「请重启」事件、由 command_loop 单线程执行；
  2. 兜底：`run_one()` shell 循环加入 `if kc is not self.kc or self.restarting: finish("interrupted", "kernel changed")`；
  3. 关联 M-4：给 restart 加 operation id，`ready` 回显 id，host 只接受匹配的 ready。
- **测试缺口**：没有任何测试覆盖「并发 restart」；建议 fake client 并发调用 `Bridge.restart()` 断言只重启一次 + 真实内核「中断超时自动重启 + 同时 host restart」回归。

#### H-2【已验证】【已修复 · e2f0bf9】客户端 32MiB 输出预算与保存端容量口径不一致：输出可显示但永远保存不了

- **位置（客户端）**：`client.js:819`（`MAX_CELL_OUTPUT_BYTES`）、`client.js:839-849`（按**每 cell outputs 数组的紧凑 JSON** 记账）、`client.js:862-946`（`reduceOutputs`）、`client.js:1376-1383`（save 上传整本 notebook）、`client.js:1404-1413`（失败分支）、`client.js:1479-1486`（autosave 重试条件）
- **位置（保存端）**：`lib/notebook.js:9`（整文件 `NOTEBOOK_CAP_BYTES = 32MiB`）、`lib/notebook.js:223`（落盘用 `JSON.stringify(..., null, 2)`，**pretty JSON**）、`lib/notebook.js:362-371`（序列化后 >32MiB → 413）、`lib/json.js:89`（POST 请求体默认上限 64MiB）；对应声明 `README.md:12,117,119`
- **问题**：三层度量互不一致，存在「客户端允许 → 显示正常 → 保存必然被拒」的状态：
  1. **单 cell 接近客户端上限即不可保存**：Lead 实测一个客户端预算 33,554,284B（上限 33,554,432）的 stream output，经 `serializeNotebook` 落盘为 **33,554,595B > 上限 33,554,432B，超 163B → 必 413**；
  2. **多 cell 累加**：两个各 17MiB stdout 的 cell（每个远低于单 cell 上限）→ 落盘 **35,651,380B > 32MiB → 413**；
  3. **pretty-print 放大**：单 cell `application/json` 约 11.5MB 紧凑 → 落盘约 35.2MB（≈3.06×）；
  4. **请求体上限**：4 个 17MiB cell 时 save 请求体约 71MB > 64MiB，在 `readJsonBody` 阶段即 413。
- **影响**：数据留存风险——输出无法落盘且 `CellView` 操作区没有「清空输出」入口（`client.js:1076-1100`），用户只能切类型/删 cell/重跑等有损绕路；超限后 `shouldScheduleAutosave`（`client.js:655-661`）在每次编辑后触发一次整本 notebook 的 `JSON.stringify` + 上传 + 413，大文件时卡顿且反复失败；关闭标签页可能丢失执行结果。README:117 的「每 cell 最多保留 32MiB」给了用户错误预期。
- **建议修复**：save 前按落盘口径预检（`JSON.stringify(notebook, null, 2)` 字节数），超限时给出明确 banner + 「清空全部/本 cell 输出」按钮，并停止 autosave 重试；把 `MAX_CELL_OUTPUT_BYTES` 下调到与保存上限兼容的值，或增加文档级总预算；服务端可在 413 `details` 中返回估算值供客户端提示。
- **证据缺口**：浏览器端真实保存流程没有端到端测试（现有测试只测预算记账边界与 `shouldScheduleAutosave` 纯谓词）。

---

### 3.2 Medium

#### M-1【已验证】【未修】路径授权与文件 I/O 分离：竞态下可越出工作区读、甚至越界写

- **位置**：`lib/gate.js:59-80`（授权只返回 `{target: realpath, stat}` 路径字符串）；消费方重新按路径 I/O：`lib/notebook.js:263-286`（read）、`lib/notebook.js:319-388`（save：stat→read→sha256→temp→rename）；入口 `lib/routes.js:174-178,209-212`。
- **问题**：授权与 I/O 之间没有 fd/inode 绑定。授权后把目标文件替换成指向工作区外的 symlink，`readNotebookFile` 会读到外部内容；把父目录替换成指向外部的 symlink，`writeFile(temp)`/`rename` 会写穿到工作区外（只替换最终文件为 symlink 时 rename 会替换链接本身，不写穿）。
- **证据**：Lead 复跑 `local-scratch/review-http/toctou-read.mjs` → `read status: ok | source: "SECRET = ..."`、`LEAK: true`；审查员的写越界实验同样成功。
- **触发条件**：同一用户下的其它进程/工具在 workspace 内写文件（构建脚本、外部编辑器、git checkout、agent 文件工具）；读窗口微秒级、写窗口可达数十毫秒；需要竞态 + 本地写权限，故定为 medium。
- **建议修复**：读用 `open(..., O_NOFOLLOW)` + `fstat` 比对 gate 记录的 `dev/ino/birthtimeMs` 后从 fd 读；写进入 `writeNotebook` 后对父目录 realpath + `lstat` 身份校验，rename 前再次校验，rename 后对新 inode 校验；至少在 README「已知限制」声明该竞态。（注：`O_NOFOLLOW` 语义随平台不同，实现时需实测。）

#### M-2【契约核对】【未修】工作区根不跟随 better-sidebar 的「活动根」：linked git worktree 中 notebook 全部 403

- **位置**：`lib/gate.js:16-48`（根只有 `ctx.get('workingDirectory').get(session)` 或 `session.header.cwd`）；下游所有路由用它做包含性检查。
- **契约事实**（已安装 `dsh-better-sidebar@0.28.2` 源码核对）：侧边栏文件树的根是 `activeWorktreeRootOf(ctx, sessionId, sessionCwdOf(...))`（`src/index.ts:713-721`、`src/active-worktree.ts:452-500`），会采纳 **linked git worktree**（可能在 `workingDirectory` 之外）；传给 viewer 的 `FileViewerProps.path` 是文件树的**绝对路径**，本插件原样传给 read/save/execute（`client.js:570,1377,1609`）。
- **影响**：当会话活动根是 linked worktree（典型：agent `git worktree add` 到工作区外并工作）时，`/ipynb/read|save|execute|status` 全部 `403 path-outside-root`，插件核心功能不可用；失败方向安全，但 README 未列为已知限制。
- **证据**：机制级已验证（mock 根 A、请求根 B 的绝对路径 → 403）；端到端未在真实 worktree 会话复现。
- **建议修复**：`resolveWorkspace` 引入「活动根集合」：主根 + 与 session 仓库关联的 linked worktree 根（规则对齐 better-sidebar），只接受 realpath 落在任一候选根内；或短期在 README 声明不支持 linked worktree。

#### M-3【已验证】【未修（README 已声明竞态）】保存的 CAS 不是 compare-and-swap：校验后、rename 前的外部写入会被静默覆盖

- **位置**：`lib/notebook.js:345-361`（readFile→sha256→与 baseVersion 比较，唯一冲突检测点）；`lib/notebook.js:362-379`（serialize→上限检查→writeFile(temp)→rename，窗口内外部写入被覆盖）；`lib/routes.js:193-207` 直接透传。
- **问题**：README:12「外部修改返回 409 冲突而不覆盖」只在外部修改发生在插件 `readFile` **之前**时成立；`lib/notebook.js:288-291` 代码注释已承认「not a compare-and-swap against processes we do not control」。实验验证：在 `writeFile(temp)` 时机注入外部保存，`saveNotebookFile` 仍返回成功，外部内容丢失。
- **影响**：外部编辑器（VS Code/JupyterLab）与 1.5s autosave 竞争时可能静默丢数据；API 返回 200。
- **建议修复**：rename 前再次 stat/read 比较身份与 sha；或引入 advisory lock；至少收紧 README 措辞，把窗口写入「已知限制」。

#### M-4【已验证】【已修复 · 27d0659】`ready` 事件无 operation id：bridge 自动重启的 ready 会提前完成 host 的 restart 等待

- **位置**：`lib/kernel.js:134-150`（`beginReadyWait`）、`lib/kernel.js:172-183`（`finishReady`）、`lib/kernel.js:326-328`（任何 `ready` 都调 `finishReady()`）；`python/bridge.py:567-571`（自动重启 emit 同样的 ready）。
- **问题**：host 等待的是「下一个 ready」而非自己那次 `{"op":"restart"}` 的回执。当 bridge 因中断超时正在自动重启时，host 再发起 restart：自动重启的 ready 先到 → `POST /ipynb/restart` 提前返回成功 → 随后的 execute 在 bridge 仍阻塞于自身 `wait_for_ready(25)` 时被提交，实测 **24.5s 延迟**或收到错误终态（`ok=false, error="kernel process exited"`）。
- **影响**：restart 完成语义不可信；用户点重启后立刻运行的 cell 长时间无输出或直接失败。与 H-1 同根，建议随 H-1 一起修。
- **建议修复**：`{"op":"restart","id":n}` → `{"type":"ready","op_id":n}`；host 只接受匹配 id 的 ready；run 进行中的无关 ready 只更新 `lastActivity`。

#### M-5【已验证】【已修复 · 3896bf9】`spawn` 失败的 `error` 路径不清 `proc`：条目永久显示 `running:true`、`forget()` 失效

- **位置**：`lib/kernel.js:122-128`（`proc.on('error')` 只 `failReady`）、`lib/kernel.js:336-358`（只有 `handleExit` 清 `this.proc`）、`lib/kernel.js:555-564`（`running: Boolean(this.proc)`）、`lib/kernel.js:633-635`（`forget` 要求 `!entry.proc`）。
- **问题**：Node 对「无法 spawn」（ENOENT/EACCES/EMFILE 等）只触 `error`、不派发 `exit`（`exitCode` 为 -2）；`this.proc` 永不为空 → `/ipynb/status` 恒返回 `running:true`、`kernelCount` 不降、`forget()` 无效，直到显式 shutdown 或 30min sweep。触发场景：`DSH_IPYNB_PYTHON` 指向的解释器被删除、探测与 spawn 之间失效、资源耗尽。
- **证据**：Lead 独立复现（见 §7）；mock harness 与真实 spawn 双重复现。
- **建议修复**：`proc.on('error')` 中清 `this.proc` 并 `manager.forget()`；或监听 `close` 作为 `exit` 兜底并把 `handleExit` 改为幂等。

#### M-6【部分验证】【部分修复 · 00cd576（SIGTERM 清理）；核心未修】`restart` 在 command_loop 线程内同步阻塞（最长 25s）：控制面失去响应，shutdown 退化为 SIGTERM

- **位置**：`python/bridge.py:609-610`（command_loop 直接调用同步 `restart()`）、`python/bridge.py:535-579`（`wait_for_ready(25)`）、`lib/kernel.js:507-536`（host shutdown 只等 2s 就 SIGTERM）。
- **问题**：restart 期间 stdin 上的 execute/interrupt/shutdown 全部排队不读；若此时 shutdown，`{"op":"shutdown"}` 排队、host 2s 后 SIGTERM，bridge 无 SIGTERM handler（L-28），内核清理依赖 ipykernel parent-poller 而非确定性 `km.shutdown_kernel(now=True)`。
- **建议修复**：restart 移出 command_loop（独立 control 线程/异步），command_loop 只在 restart 进行中排队新命令；配合 M-4 的 op id。

#### M-7【已验证】【部分修复 · 3896bf9（a/b）；深 HTML 递归未修】客户端 render 期未捕获异常：`attachment:` 名畸形百分号转义抛 `URIError`（另有深层嵌套 `RangeError`）

- **位置**：`client.js:789-798`（`makeImageResolver`，抛点 `792` 的 `decodeURIComponent`）；调用链 `CellView`（`client.js:1135`）→ `renderMarkdownWithImages`（`client.js:352-360`）→ `resolveImage`；`text/markdown` 输出同理（`client.js:985-991`）。无 error boundary。
- **触发**：打开包含 markdown `![x](attachment:%ZZ)`（或 `%E0%A4%A` 等畸形转义）的 notebook 即可让该 cell 的 render 抛 `URIError: URI malformed`。Lead 用 mock hooks 调用 `CellView` 复现 throw；若宿主没有包住插件视图的 error boundary，可能导致侧边栏整块卸载（未验证宿主兜底行为）。
- **相关**：嵌套 blockquote ≥约 6000 层可在 `renderMarkdown` 递归抛 `RangeError`（Lead 实测 8000 层抛错）；`cleanNode` 对超深 HTML 也可能递归溢出（jsdom 复现；真实浏览器解析深度上限可能阻止）。
- **建议修复**：`decodeURIComponent` 包 try/catch 失败返回 null；blockquote 改迭代/限深；`CellView`/`OutputView` 外层加轻量 error boundary。

#### M-8【已验证】【未修】大输出流式渲染 O(n²)：32MiB 级别输出可冻结 UI 数十秒

- **位置**：`client.js:955-1006`（`OutputView` 未 memo，每次父渲染全量重算）、重算点 `client.js:960,967`（`ansiToHtml` 全文）、`client.js:974`（`sanitizeHtml` 全文 DOMParser）、`client.js:990`（markdown 全文）；流合并每次产生新 outputs 数组（`client.js:922-945`），触发整 cell 重渲。
- **证据**（审查员微基准，16KiB/chunk）：1MiB=36ms、2MiB=128ms、4MiB=506ms、**8MiB=2,115ms**；按二次外推 32MiB ≈30s+（浏览器还要加 innerHTML 解析/布局）。真实场景：run-all 打印日志/训练进度到十几 MB 时 UI 明显卡死，用户可能强刷 → 丢失未保存输出（与 H-2 叠加）。
- **建议修复**：按 output 对象 `WeakMap` 缓存渲染结果；stream 合并只增量处理新 chunk；高频事件用 rAF/100ms 合并渲染；超长输出折叠/虚拟化。

#### M-9【已验证】【未修】Markdown 内联管线在已转义文本上多轮正则：URL 二次转义、强调标记注入生成标签，常见链接被破坏

- **位置**：`client.js:215-242`（`renderInline`：先整体 escape，再对已转义 URL 再 `escapeHtml`；强调/删除线正则作用在已生成的 HTML 串上）；`client.js:352-360`。
- **证据**（Lead 复跑 `renderMarkdown`）：
  - `[x](https://e.com/?a=1&b=2)` → `href="...?a=1&amp;amp;b=2"`（浏览器实际 href 含字面 `&amp;`，参数错误）；
  - `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))` → `<a href="...Foo<em>(bar" target="</em>blank" ...>`（强调标记被插进属性值，锚点 URL/target 损坏）；
  - `see https://e.com/a_b_c now` → 自动链接只包住 `https://e.com/a`，`b`/`c` 被 `<em>` 拆开。
- **影响**：查询串 `&` 或 `_`/`*` 很常见（维基条目、`user_id=1`、`my_image_v2.png`）。**无安全影响**：30,000 次随机 markdown 模糊测试在 jsdom 重解析未发现 XSS（用户文本已转义、注入标签固定为 `<em>/<strong>`）。
- **建议修复**：URL/图片与行内代码一致走占位符机制，最后统一还原；强调只作用于纯文本段。

---

### 3.3 Low（按领域合并，完整细节见附录 A 的归档领域报告；状态为 `3896bf9` 时）

| ID | 位置 | 问题 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| L-1 | `lib/gate.js:160-168` | `trace=true` 时强制二次解析；文件在 resolveTarget 与 walkTarget 之间被删除/换拼写 → 控制/执行端点偶发 404 | 已验证 | 未修 |
| L-2 | `lib/routes.js:193-207`、`lib/notebook.js:356-362` | save 参数校验顺序：坏 notebook + 旧 baseVersion 先返回 409（应为 400）；路径校验先于 notebook 校验 | 已验证 | ✅ 3896bf9 |
| L-3 | `lib/routes.js:196-202`、`lib/gate.js:66-73` | 所有 not-found 都映射 409；EACCES/ENOTDIR 被误报为「文件不存在，请重新加载」 | 已验证 | ✅ 3896bf9 |
| L-4 | `lib/notebook.js:372-379` | 保存经 umask 改变文件权限（0o664→0o644、0o777→0o755），并丢失 ACL/xattr/硬链接关系 | 已验证 | 未修 |
| L-5 | `lib/notebook.js:373-387` | 硬崩溃/断电在保存窗口内会在工作区残留 `.dsh-bsb-ipynb-*.tmp`（仅异常路径 catch 清理） | 已验证 | 未修 |
| L-6 | `lib/notebook.js:165-185,208-224` | `/ipynb/read` 返回重复 cell id；为 `nbformat_minor<5` 输入注入 `id` 但不升 minor，返回体对声明版本不合规（客户端自行修复，终端用户无感） | 真实 nbformat 校验 | 未修 |
| L-7 | `lib/notebook.js:263-286` | read 的 stat→readFile 竞态可绕过 32MiB 读入上限（`parseNotebookBytes` 上限在整块读入后） | 推测（代码路径） | 未修 |
| L-8 | `lib/json.js:89`、`lib/routes.js:135` | save 允许 64MiB body 而 notebook 上限 32MiB，峰值内存可达 >200MB；并发 save 可压垮宿主（与 H-2 同源） | 量级推断 | 部分 · e2f0bf9（客户端） |
| L-9 | `lib/env.js:252-264`、`lib/routes.js:154-172` | `/health`、`/interpreters` 冷缓存时同步执行解释器探测、无总体超时（挂起解释器可拖慢 GET 响应） | 代码路径 | ✅ 3896bf9 |
| L-10 | `lib/env.js:106-122,202-217,266-294` | `DSH_IPYNB_PYTHON` 指向不可用解释器时被静默丢弃、无提示；`python` 非字符串/空白静默回退默认而非 400 | 已验证（mock） | ✅ 3896bf9 |
| L-11 | `lib/routes.js:377-397` | restart 对不存在/已删除路径也会启动新内核；interrupt 无内核 503 而 shutdown 无内核 200 的语义不一致 | 代码+mock | 未修 |
| L-12 | `lib/routes.js:241-316` | drain 等待无超时：客户端冻结/半开连接时响应可能长期不结束（内核已空闲） | 推测 | 未修 |
| L-13 | `lib/gate.js:59-80` | 工作区外路径存在性/可访问性 oracle（存在→403、不存在→404、EACCES→404+reason） | 已验证 | 未修 |
| L-14 | `lib/gate.js:34-46` | 相对 cwd 被按宿主进程 cwd 解析（better-sidebar 已显式拒绝相对 cwd） | 已验证 | ✅ 3896bf9 |
| L-15 | `lib/notebook.js:292-306` | `saveQueues` 只按 canonical 路径串行化：硬链接别名/重复加载的模块实例可绕过「只有一个成功」 | 推测 | 未修 |
| L-16 | `client.js:1548-1562` | `execute_reply` 无条件把 `kernel.running` 置回 true：`kernel_died` 后 UI 最多 10s 显示「空闲」、按钮对死内核可用 | 代码路径 | ✅ 09f5819 |
| L-17 | `client.js:1066-1067,1082-1084,1102-1137` | raw cell 无 Edit 入口、内容区只读（README:10「点击 cell 进入编辑」隐含所有 cell） | 代码确定 | ✅ 09f5819 |
| L-18 | `client.js:1442-1466,1169-1179` | `/ipynb/interpreters` 一次失败即永久禁用 Run all（无重试），并显示误导性的「未找到解释器」 | 代码确定 | ✅ 3896bf9 |
| L-19 | `client.js:1214,1297,1355-1417,1884` | `emptyFile` 提示在保存成功后不消失 | 代码确定 | ✅ 09f5819 |
| L-20 | `client.js:1468-1477` | 加载失败/错误卡片状态下仍每 10s 轮询 `/ipynb/status` | 代码确定 | ✅ 09f5819 |
| L-21 | `client.js:1080,1576-1580` | 执行期间其它 cell 的 Run 按钮可点但静默 no-op（无反馈） | 代码确定 | ✅ 09f5819 |
| L-22 | `client.js:256-273` | Markdown fence 与 CommonMark 不一致：4+ 反引号围栏永不正确闭合；带 info string 属性（```` ```python title="x" ````）不识别 | Lead 已验证 | ✅ 3896bf9 |
| L-23 | `client.js:1037-1065,1113-1121` | 快捷键只在编辑 textarea 内生效（README:44-50 给人的印象是全局快捷键） | 代码确定 | 未修 |
| L-24 | `lib/kernel.js:172-183,287-304,317-323` | 成功重启不清 `lastError`；超大行重启后残留尾行把 `lastError` 覆盖成「Unreadable kernel event: …」 | 已验证 | ✅ 3896bf9 |
| L-25 | `lib/kernel.js:172-183` | `finishReady()` 在 run 进行中把 `executionState` 改成 idle，`status` 出现 busy↔idle 矛盾 | 已验证 | ✅ 27d0659 |
| L-26 | `lib/kernel.js:573,663-672` | `sweepIdle` 无异常捕获（async rejection 无人处理）；与在飞请求存在短暂 503 竞态 | 推测 | ✅ 3896bf9 |
| L-27 | `lib/kernel.js:674-679` | `disposeAll()` 无 disposed 标记，与在飞 `getOrStart` 竞态时可能新建无人关闭的内核 | 推测 | 未修 |
| L-28 | `python/bridge.py:645-659` | bridge 无 SIGTERM/SIGINT handler：内核清理依赖 ipykernel parent-poller（实测 ~1s 生效，但长 GIL 场景存在遗留窗口） | | 部分验证 ✅ 00cd576 |
| L-29 | `client.js:771-805,985-1006`（`imageSource`/`makeImageResolver`） | 附件选择 `Object.keys(attachment)[0]` 可能是非图片 MIME；`image/jpg` 未支持；HTML 输出里的 `attachment:`/相对图片不会解析 | 代码确定 | ✅ 3896bf9 |

### 3.4 Nit（节选，完整见领域报告）

> 部分 nit 已在 `09f5819`/`3896bf9` 顺带修复：version 单一来源、locale 死 key、`/health` 探测、NOTICE 许可文本、README 文档项、`client.js` 版本常量等；以下仍有效。

- 客户端：`serializeNotebook` 现被保存容量预检使用（不再算死代码），但仍含 lookbehind（旧 Safari 解析风险）；`outputsSize` 仅测试用；`streamExecute` 把 `onEvent` 异常一并吞掉；`interpreters` 的 `— unavailable` 分支不可达；`refreshKernel` 无时序/卸载保护；ANSI OSC/`\r`/非 SGR CSI 处理不完整；`ALLOWED_TAGS` 放行任意 `class` 造成视觉伪装面；可访问性（`role`/`aria-live`）不足；`sanitizeUrl` 放行 `//host` 协议相对 URL（已在 jsdom 验证非 XSS）。
- 宿主：fence 抛异常时每请求打印完整 stack（持续故障时刷屏）；`interpreterHint()` 死代码；`index.js:17-19` 的 `disposeAll` 不 await；`normalizeSource` 把对象静默 `String()` 成 `[object Object]`；`walkTarget` 的「Too many symbolic links」映射 404；`KernelPaths.aliases` 全局 1024 FIFO 可跨会话挤占；`readJsonBody` 对 string chunk 的 UTF-8 切分无保护（当前宿主传 Buffer）。（`/health` 版本硬编码已随 09f5819 改为 package.json 单一来源。）
- 内核：`status`/`status_reply` 无调用方（死协议）；`--kernel-name` 从不传入、`language_info` 恒 `{}`；`emit` 吞 stdout 写失败；control 通道 `interrupt_reply` 从不消费（长期大量中断微小积压）；成功 reply 总带 `error:null`；`DSH_IPYNB_KERNEL_IDLE_MS` 不能用 0 禁用回收。（`generation` 现用于 restart op id；`failReady` 详细原因被覆盖已随 3896bf9 修复。）

---

## 4. 测试与文档评估（独立轨道）

### 4.1 总体

- **审核基线**：240 tests / 240 pass / 0 skip（本机），20.5s；**修复后当前：263 pass / 0 fail（新增 23 个测试/用例）**。真实内核、真实 nbformat、真实 bridge 均有覆盖，且大量竞态（旧 save 响应、旧执行终结器、旧 ready timer、旧 exit 事件、sweep 竞态）有针对性测试，属于**很强的测试资产**。
- 文档与实现一致性很好：14 个错误码与 `STATUS_BY_CODE` 完全一致；32MiB/64MiB/1.5s/10s/3s/30s/2s/priority 10 等数字全部正确；`npm pack --dry-run` 实测 `python/bridge.py`、client.js、locale、icon、cordis.patch.yml 均被打包；`cordis.patch.yml` id/name、client module id、package name 三方一致；README:94 错误码表、README:105 命令与实现逐字一致。
- README「可靠性」实际 11 条（README:112-122）：**7 条有测试支撑、4 条部分、0 条无**——H-1 曾打破第 2 条（「不会永久挂起」），已随 `27d0659` 修复；H-2 与第 6/8 条的口径冲突已随 `e2f0bf9` 由客户端预检兜底。

### 4.2 测试轨道问题（按风险）

| ID | 风险 | 位置 | 问题 | 当前状态 |
| --- | --- | --- | --- | --- |
| T-H1 | **High（测试可信度）** | `test/bridge.test.mjs:11`、`kernel.test.mjs:11`、`e2e.test.mjs:13`、`env.test.mjs:11`、`kernel-interpreter.test.mjs:12`、`notebook.test.mjs:501` | 默认测试解释器硬编码 `/opt/miniconda3/bin/python3`，无 PATH 回退。缺失时 16+ 个真实内核/解释器/nbformat 测试**静默 skip 且 exit 0**（实测 `DSH_IPYNB_TEST_PYTHON=/usr/bin/python3` → 44 tests / 16 skipped / fail 0）。其他机器/CI 会假绿，恰好把最高风险路径的回归保护清零。 | 部分（README 已说明；代码未改） |
| T-H2 | **High（测试可信度）** | `client.js:192-197` vs `test/client.test.mjs:193-199` | 安全关键的 DOMParser 白名单清洗分支**零行为测试**：Node 无 DOMParser，现有测试只测「缺失→整体转义」的反向分支；`cleanNode`/DROP_TAGS/ALLOWED_ATTRS/sanitizeUrl 的浏览器行为无回归保护。本次改用 jsdom 才完成 43 个 mXSS payload + 20k tag-soup 验证（全部安全），但这不是自动化测试。 | 未修 |
| T-M1 | Medium | `client.js:955-1006` | `OutputView` 的 text/html、png/jpeg/svg、markdown、JSON、latex 等渲染分支零测试（README 主要卖点）。 | 部分（仅 imageSource 单测） |
| T-M2 | Medium | `client.js:1037-1065,1144-1190,1421-1477,1479-1486,1674-1720` | 客户端主交互零测试：5 个快捷键、工具栏 interrupt/restart/shutdown、解释器切换/confirm/localStorage、visible:true 轮询、1.5s autosave 计时器、onToolbarState。现有 mount harness 已 mock 好 timer/localStorage/confirm，改造成本低。 | 部分（Run/kernel_died/raw/emptyFile 已测） |
| T-M3 | Medium | `lib/routes.js:209-220,67-79`、`lib/json.js:89-111`、`lib/env.js:266-294` | `/execute` 预流错误矩阵（interpreter-unknown、bad code、缺参）、fence 401/抛异常、非法 JSON body、64MiB 请求体上限、route 级 kernel-busy、write-failed 等错误分支无行为测试。 | 部分（save 语义 / health 已测） |
| T-M4 | Medium | `test/routes.test.mjs` 等 | HTTP 层从未用真实 socket 验证（全部手写 req/res 替身），NDJSON 分块/背压/真实 `close`/`writableEnded` 语义只有假设。建议加一个 `node:http` + fetch 的端到端测试。 | 未修 |
| T-M5 | Medium | `test/routes.test.mjs`（+15）、`notebook.test.mjs`（+8）、`gate.test.mjs`（+8）、`kernel.test.mjs`（+9）、`bridge.test.mjs`（+4~5） | 每次全量测试泄漏约 **44-45 个临时目录**（实测 delta；系统 tmp 已累计 3641 个），属长期慢性泄漏；建议统一 `t.after` 清理。 | 部分（个别用例已清理） |
| T-M6 | Medium | `test/control-symlink.test.mjs:52-67` | 35 个测试中约 28 个依赖大小写不敏感文件系统，Linux 上静默 skip，README:108 未说明。 | 部分（README 已说明） |

**已随修复处理**（`09f5819`/`3896bf9`）：health 版本改为与 package.json 精确比对、e2e python 断言改为等值、interrupt/shutdown 测试改名并覆盖真实语义；`kernel_died` 后状态、`attachment:%ZZ` 容错、raw cell 渲染路径已有测试；版本号收敛到 `package.json` 单源（`client.js` 的重复常量已删除）；locale 死 key 已删除且新增 en/zh key parity 测试；README 补齐 `/read` 字段、`DSH_IPYNB_KERNEL_IDLE_MS`、64MiB 请求体上限、测试跳过条件（含 macOS-only 与硬编码默认解释器）、`client.js` 定位（已统一为手写单文件 bundle）、外部修改 CAS 边界；`package.json` 增加 `engines.node>=20`；NOTICE 附上游 MIT 许可全文。

**仍存在**：`kernel_died` 后工具栏状态的端到端浏览器验证、markdown 含 `&`/`_` 的渲染测试（对应 M-9）、客户端上限→保存 413 的 HTTP 端到端、viewer 卸载 abort 测试；客户端语言仍只跟随 `navigator.language`（未接 DSH locale service）；`better-sidebar` 最低版本仍无法在仓库内机器校验。

### 4.3 文档一致性核对结论（摘要）

| README 声明 | 判定 |
| --- | --- |
| 功能清单（:9-13）、快捷键（:44-50）、工具栏（:52） | 实现一致；测试覆盖不足（T-M1/M2） |
| HTTP 接口（:76-94）、错误码（:94） | **完全一致**（14 个错误码逐一对应）；/read 响应字段漏列（:83）→ ✅ 已补（09f5819） |
| 解释器优先级（:13,28-30）、kernelspec 隔离（:30） | 一致且测试强（`kernel-interpreter.test.mjs`） |
| 保存/规范化/并发（:12,117-119） | 数字与行为一致；H-2 跨层口径冲突 → ✅ 已由客户端预检兜底；外部写者 CAS 措辞 → ✅ 已收紧（09f5819） |
| 可靠性 11 条（:112-122） | 7 有 / 4 部分 / 0 无；第 2 条曾被 H-1 打破 → ✅ 已修复（27d0659） |
| 已知限制（:124-131） | 基本属实；仍需补 linked worktree（M-2）、read 路径重复 id（L-6）等说明 |

> 文档更新（`09f5819`/`3896bf9`）：README 已修正 `/read` 响应字段、测试 skip 说明、`client.js` 定位、外部写者 CAS 措辞，并新增「内部限制与环境变量」小节；NOTICE 补齐上游 MIT 许可全文；health 版本改为 `package.json` 单一来源；`/health` 的 `checked` 语义已记录。仍待：better-sidebar 最低版本（无法机器校验）、demo.ipynb 自动校验、`client.js` 语言行为说明。

---

## 5. 工程质量亮点（值得保留/借鉴）

1. **输出预算记账的不可变设计**：按 cell outputs 数组做 WeakMap 缓存 + 不可变快照 + `clear_output(wait)` 延迟清空语义；审查员做了 18,000 次随机事件序列模糊测试，Lead 独立复核了 3,000 次，与 `Buffer.byteLength(JSON.stringify(outputs))` **0 字节偏差**，React updater 重放不变性也成立。这是整个代码库最扎实的模块之一。
2. **过期响应隔离**：`documentSeqRef` + `notebookRevisionRef` + `savingRef`/`activeRunRef` 身份比较覆盖 save/execute/reload 交叉竞态，`invalidateDocumentWork`「先失效再 abort」的顺序正确；`client-lifecycle.test.mjs` 对旧 save/旧 run/旧 run-all 覆盖完备。
3. **KernelPaths 路径身份设计**：授权永远先于别名查询；恢复别名时重新检查 `isInside` + `samePathIdentity`（part/kind/dev/ino/birthtime/link 文本）；WeakRef 失效清理 + 1024 上限；`control-symlink.test.mjs` 35 项覆盖删除/重建/大小写/跨会话。本次审核**未发现绕过**。
4. **HTML 清洗器无 XSS 绕过**：审查员安装 jsdom（HTML 规范实现）后复测 43 个常见/历史 mXSS payload、20k 随机 tag-soup、30k 随机 Markdown 重解析，**全部安全**；`sanitizeUrl` 对控制字符/大小写/实体解码后的 `javascript:` 处理正确。（问题在该分支无自动化测试，T-H2。）
5. **NDJSON 流式路由**：断开检测（close/error/aborted/destroyed/writableEnded）、写队列/背压/drain、64MiB 待发上限、headers 前 JSON/headers 后 fatal 的分类，以及「超限先 abort+interrupt 再 end」的顺序都经过 `execute-disconnect.test.mjs` 12 个场景验证。
6. **Python 桥的协议边界处理**：`pending_lock` 内完成 execute+登记（早到输出无需缓存）、exec_id/cell_id 过滤、IOPub idle 10s 等待、`allow_stdin=False` 快速失败、内核 stdio 重定向 DEVNULL、restart 后新 client、`drain_queue` 批量取消 —— 设计成熟且有真实内核测试。
7. **文档纪律**：错误码表、限制、数字、命令与实现高度同步（罕见），`npm pack` 内容完整。
8. **修复过程的质量**：每项修复都配套回归测试（审核后新增 23 个测试/用例）；H-1 并发重启、SIGTERM 清理、保存容量预检、真实内核拒绝/恢复路径都用真实内核或真实序列化做过端到端验证（见 §7.1）。

---

## 6. 剩余修复优先级建议（更新于 `3896bf9`）

**已完成（保留供追溯）**

- Phase 1：H-1、M-4（并发重启互斥、`run_one` 身份兜底、ready op id）；
- Phase 2-lite：L-28（SIGTERM/SIGINT 确定性内核清理）；
- Phase 3-lite：H-2（保存容量预检、清空输出、autosave 抑制）；
- 文档/元数据/UI 批次：L-16/L-17/L-19/L-20/L-21、弱断言、版本单源、locale、NOTICE、engines；
- 小修批次：M-5、M-7a/b、L-2/L-3/L-9/L-10/L-14/L-18/L-22/L-24/L-26/L-29。

**仍值得做（按优先级）**

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| **P1** | M-9（Markdown 占位符管线） | 可见功能 bug（含 `&`/`_` 的链接被破坏），改动限于客户端渲染函数 + 测试 |
| **P1** | T-H1（测试解释器探测 helper） | 其他机器/CI 上真实内核测试静默 skip；README 已说明，但代码仍硬编码 |
| **P1** | M-6 完整版 | restart 移出 `command_loop` + shutdown 协调；Phase 2-lite 已消除最严重清理问题 |
| **P2** | M-1（路径 TOCTOU 加固） | 安全核心；建议先落 README 已知限制，再做 fd/inode 绑定与竞态回归 |
| **P2** | M-2（linked worktree 活动根） | 实现对齐 better-sidebar，或 README 声明不支持 |
| **P2** | M-3（save CAS 二次校验） | README 已声明竞态；可加 rename 前复核降低窗口 |
| **P2** | M-8（渲染节流/缓存） | 长输出性能（O(n²) → 增量/节流） |
| **P2** | T-H2（DOMParser 清洗器测试） | 需 jsdom devDependency 或最小 DOM 替身 |
| **P3** | 剩余 Low（L-1/L-4/L-5/L-6/L-7/L-11/L-12/L-13/L-15/L-23/L-27）、临时目录清理、真实 socket HTTP 测试 | 低成本/低风险，可批量处理 |

---

## 7. 验证实验与复现索引（Lead 复核）

| 实验 | 脚本 | 结果 |
| --- | --- | --- |
| 基线测试（开始） | `node --test test/*.test.mjs` | 240 pass / 0 fail / 20.2s |
| 基线测试（结束） | 同上 | 240 pass / 0 fail / 20.5s |
| 内核并发重启（确定性） | `local-scratch/kreview/restart-race.py` | 2×`restart_kernel`、2 个 client 仅 1 个被 stop、2 个 `ready` → 无互斥成立 |
| 内核并发重启（host 端到端） | `local-scratch/kreview/host-race.mjs 4100 1` | `restart result: ok` 后 `after run: HANG` → **H-1 复现** |
| spawn 失败生命周期 | `local-scratch/kernel-exp.mjs` | 失败后 `entries.size=1`、`proc` 非空、`status.running=true`、`forget` 无效 → M-5 复现 |
| 客户端容量口径 | `local-scratch/validate-client-h1b.mjs` | 单 cell 落盘超限 163B → 413；两 cell 35.65MB → 413 → H-2 复现 |
| 客户端 render 容错 | `local-scratch/review-exp.mjs`、`local-scratch/validate-client-h1b.mjs` | `attachment:%` 抛 URIError；缺失图片残留 ` loading="lazy">`；8000 层 blockquote `RangeError`；fence/URL 二次转义 → M-7/M-9/L-22 |
| 清洗器安全 | `local-scratch/cr/e10_xss.mjs`、`e14_markdown_fuzz.mjs`（jsdom） | 43 payload 0 dangerous；30k markdown fuzz 0 dangerous |
| 路径 TOCTOU 读 | `local-scratch/review-http/toctou-read.mjs` | 授权后换 symlink → 读到工作区外内容（`LEAK: true`）→ M-1 复现 |
| 文档/manifest | `local-scratch/check_locale.mjs`、`npm pack --dry-run` | locale meta key 一致；打包内容齐全 |

### 7.1 修复后新增验证（截至 `3896bf9`）

| 验证 | 结果 |
| --- | --- |
| 全量测试 | 审核基线 240 pass → 当前 **263 pass / 0 fail**（新增 23 个测试/用例） |
| 内核并发重启（真实内核 `host-race.mjs`，4 组不同时序） | 修复前：HANG / 24.5s 延迟 / 错误终态；修复后：**4/4 `ok=true`** |
| 确定性并发 restart（`restart-race.py`） | 修复前：2×`restart_kernel`、2 client、2 ready；修复后：**1/1/1** |
| SIGTERM/SIGINT（真实 bridge） | 修复前：被信号杀死、连接文件残留；修复后：**exit code 0、零残留、内核退出** |
| 慢 restart（5s）期间 SIGTERM | 修复后：信号后 ~117ms 内 **exit code 0、零残留** |
| 保存容量预检（真实 `lib/notebook.js`） | 4 个代表性 notebook 客户端与服务端字节 **4/4 完全一致**；33MiB/2×17MiB 场景上传前拦截，清空输出后可保存 |
| 小修批次回归 | 新增 13 个用例覆盖 M-5/M-7/L-2/L-3/L-9/L-10/L-14/L-22/L-24/L-26/L-29 等 |
| 静态检查 | `node --check`（JS）、`git diff --check` 全部通过 |

**未完全核实事项**（按任务要求标注）：① README:19 中 better-sidebar 最低版本 0.28.0（仓库内只有 0.28.2 可测）；② linked worktree 场景只在契约级 + mock 403 级验证，未在真实 DSH worktree 会话端到端复现；③ 真实浏览器（headless Chrome 被本会话沙箱阻断）下的清洗器 DOM 深度上限与 O(n²) 渲染绝对耗时未实测；④ `O_NOFOLLOW`/目录身份校验在 macOS APFS 上的实际语义需实现时实测（M-1 仍未修）；⑤ H-1 触发需要「第二客户端/API 并发 restart」，单标签页路径概率低（多标签页/脚本 API 可达）；⑥ 小修批次中 L-18 重试/回退、L-10 的 `DSH_IPYNB_PYTHON` 可见性、L-26 的 catch 分支仅代码核对，无专门测试。

---

## 附录 A：领域报告索引（已归档至 git 标签 `review-archive`）

审核阶段的 4 份领域报告（约 1300 行，含原始 file:line、触发步骤、实验脚本与修复草图）**不纳入当前工作树**，完整内容保存在仓库标签 `review-archive` 指向的 commit（审核基线 HEAD `1b15b56`）：

| 报告 | 内容 | 严重度统计 | 查看方式 |
| --- | --- | --- | --- |
| `review/client.md` | `client.js` 全量审查：渲染/XSS、预算、状态机、保存/执行竞态、i18n、性能 | 1H / 3M / 9L / 10N | `git show review-archive:review/client.md` |
| `review/kernel.md` | `lib/kernel.js` + `python/bridge.py`：进程生命周期、JSONL 协议、重启/中断、IOPub、清理 | 1H / 3M / 5L / 9N | `git show review-archive:review/kernel.md` |
| `review/http.md` | HTTP/存储/路径安全/nbformat/env：TOCTOU、worktree、CAS、权限、HTTP 语义、nbformat 合规 | 0H / 3M / 16L / 16N | `git show review-archive:review/http.md` |
| `review/tests.md` | 测试有效性、覆盖缺口、README/package/locale 一致性、临时资源泄漏 | 2H / 12M / 13L / 8N | `git show review-archive:review/tests.md` |

> 领域报告保留原始 file:line、触发步骤、实验脚本与修复草图；本汇总报告在合并时对重复项做了去重、对同一根因的发现做了合并（如 bridge restart 竞态与 ready op-id），并统一了严重度口径。
>
> **注意**：这 4 份报告是审核当时的原始描述（基线 HEAD `1b15b56`），其中列出的问题状态以本报告 §0 为准；修复后的代码与验证证据见 §7.1。
>
> 如需恢复文件到工作树：`git checkout review-archive -- review/`；查看归档 commit：`git show --stat review-archive`。

## 附录 B：审核过程说明

- 4 名审查员各自持独立共享任务（task-1~4）、各自只写一个领域报告文件（现存于 `review-archive` 标签），互不重叠；Lead 负责合并、复核 high/medium 结论并运行最终基线。
- 审查员在 `local-scratch` 的实验脚本未进入仓库；领域报告与本报告后经用户确认，只保留本汇总报告（领域报告归档为 `review-archive` 标签）。
- 修复阶段按用户请求分 5 个 commit 落地（`27d0659`、`00cd576`、`e2f0bf9`、`09f5819`、`3896bf9`），每个 commit 前均运行全量测试；修复记录、行为变化与状态映射见 §0。
- 审核期间一次全量测试出现偶发文件级失败（不可复现，后续三次均 240/240），疑似并行审查进程资源竞争，未计入缺陷。
