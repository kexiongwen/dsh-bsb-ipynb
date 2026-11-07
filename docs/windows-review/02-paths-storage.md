# 02 — Windows 侧审查：路径授权与存储（gate.js / notebook.js / json.js / routes.js）

- **子域**：Windows 侧代码审查 / 路径授权、越界防护与 notebook 存储（win-paths-storage）
- **审查对象**：`dsh-bsb-ipynb` @ **8c1ad8e**（审查结束后源码/测试零改动，工作树只有本文件等未跟踪交付物）
- **实机环境**：Windows 11（10.0.26300），NTFS（大小写不敏感，8.3 短名生成开启：`C:\PROGRA~1` 可解析），Node **v24.19.0**，Python **3.14.7**，控制台 cp936，仓库 `C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb`
- **会话沙箱**：workspace-write、审批禁用；`$env:TEMP = C:\Users\kexio\AppData\Local\Temp\dsh-MYjoOW`。文件 ACL 显示沙箱进程以 **Low Mandatory Level + `CodexSandboxUsers` 组**运行（这解释了本会话 `icacls /deny` 被拒绝，见 §7）。
- **对照基线**：Mac 审查 `CODE_REVIEW.md`（macOS APFS / Node v24.13.1，292 pass）。
- **证据说明**：【已验证】= 本机可重跑脚本/确定性路径实测（含真实 PowerShell/.NET/CPython 持锁进程、真实 junction/硬链接、真实 Windows 系统 ACL）；【契约核对】= 只读源码/README 逐行核对或依赖 OS 文档，未在本机跑到；【推测】= 代码推理。完整 `npm test` 由队友 win-tests 的 `04-tests-ci.md` 负责，本文不重复。
- **方法**：所有样本均在 `%TEMP%\dsh-win-review\win-paths\` 下自建假工作区，用伪造 `ctx`（`sessions.get()`/`get('workingDirectory')`）和伪造 `req/res`（同 `test/control-symlink.test.mjs` 形状）调用 `lib/gate.js`、`lib/notebook.js`、`lib/routes.js` 的导出函数与真实 `handleRequest` 路径；未读写仓库内任何源码/测试，未 `git add/commit`。实验脚本与样本属临时文件，审查结束后已删除（关键输出记录于本文）。

---

## 0. 结论摘要（TL;DR）

1. **安全结论（本次最重要）**：
   - **预置的越界 junction 被正确拒绝**：工作区内 junction 指向工作区外时，`resolveTarget`/`resolveExistingFile`/`resolveControlTarget`（含目标不存在、含 junction 链）一律 **403 `path-outside-root`**，`isInside(realpath)` 生效。
   - **但 M-6 的 TOCTOU 在 Windows 上同样成立，且可利用无需任何特权的 junction**：授权后把目标**父目录**换成指向外部的 junction → **越界读**（读到工作区外内容）与**越界写**（成功覆盖工作区外文件）均复现；Windows 上创建 junction 不需要管理员/开发者模式，攻击门槛不高于 Mac 的 symlink。
   - **junction 在 Node v24.19.0/本机对 `lstat`/`readlink` 完全不可见**：`lstat().isSymbolicLink() === false`、`readlink()` → `EINVAL`，只有 `realpath()` 会解析。因此 `gate.js:91-150 walkTarget` 依赖 `lstat`/`readlink` 的链接展开与链接身份逻辑对 junction **从不触发**（详见 W-PS-04/W-PS-05）。注：Lead 报告 junction 的 `fs.readlink` 返回普通绝对路径，与本会话实测不一致，见 §8 待对齐项。
2. **Windows 常见保存场景会以 `500 write-failed` 失败，但都不丢数据**：目标文件带**只读属性**时（Explorer/版本库/OneDrive 复制品常见）保存必定失败（`rename` 覆盖只读目标 → EPERM）；目标被其它进程以 Python/Jupyter 默认共享模式（`FILE_SHARE_READ|WRITE`，无 DELETE）打开时保存同样失败（`rename` EPERM）。两次版本校验、临时文件清理均正常，失败后目标内容不变、无 `.tmp` 残留（W-PS-01/W-PS-02）。
3. **独占共享模式（`FileShare.None`）下 `/read` 返回 `500 internal`**：`fs.readFile` 抛出的 `EBUSY` 未被 `readNotebookFile`/`handleRequest` 映射，最终变成 `internal`；同一状态下 `/save` 是 `500 write-failed`、`/status` 仍 200。README 的错误码/用户提示对 Windows 锁语义没有覆盖（W-PS-03）。
4. **Mac 条目复核**：M-6 **成立且更适合 Windows（junction 无特权）**；M-8 **成立**（rename 窗口注入外部写 → save 成功、外部编辑丢失）；L-5 **成立**（每次保存 2 次全量 `readFile`，实测 8.38MiB 文件共读 16,777,348 B；stat 窗口后文件被增长到 34.6MB 仍被整体读入后才 409）；L-6 **成立**（陈旧 `.dsh-bsb-ipynb-*.tmp` 在 read/save 后仍在；但“只读临时文件删不掉导致残留”的假设被实测否定）；L-8 **成立**（read 的 stat→readFile 窗口增长到 34.6MB 仍整体缓冲后才 413）；L-10 **成立且更糟**（硬链接别名并发保存**两个都成功**，且保存后两个名字内容分叉、不再是同一 inode，违反 README「只有第一个成功」）。（L-7/L-9/L-11 也做了 Windows 抽查，见 §5。）
5. **Windows 上路径形态基本没有绕过面**：大小写变体、正/反斜杠混合、8.3 短名、盘符相对 `C:foo`、尾点/尾空格、ADS（命名流/默认流）、保留设备名、`\\?\` 前缀、`\\.\` 设备命名空间、UNC 路径，均**不能**绕过 `.ipynb` 扩展名检查或工作区包含检查（结论逐项见 §4）。大小写变体在 NTFS 上被 `realpath` 归一化，所以**并发保存正确串行**（第二个 409），比硬链接别名安全。
6. **Windows 专属功能差异**：(a) 只读属性目标无法保存（W-PS-01）；(b) 被独占锁定的 notebook `/read` 报 `internal`（W-PS-03）；(c) 删除 junction 的目标目录后，经该 junction 的控制路径退化为「请求拼写路径」，活内核不可达（安全失败方向，W-PS-05）；(d) BOM notebook 读为 `status:"invalid"`（W-PS-07）。
7. **正常场景全部通过**：常规 read/save/原子替换、外部修改→409、并发同路径串行（首个成功其余 409）、Windows 长路径（369 字符文件 / 405 字符临时文件）、中文/emoji/空格/组合字符文件名、CRLF 输入、`\\?\` 前缀输入、junction 别名访问均正常；保存输出 UTF-8 无 BOM、LF。
8. **`BASE_VERSION`（sha256）与路径拼写无关**：大小写/8.3/junction 别名读到同一 version；同一 inode 的硬链接也是同一 version（因此两个别名并发都能通过版本校验——这是 L-10 的另一面）。

---

## 1. 环境事实（本机实测，影响全部结论）

| 事实 | 实测值/行为 | 证据 |
| --- | --- | --- |
| 文件系统 | NTFS，大小写不敏感；`path.win32.relative('C:\\WS','c:\\ws\\x') === 'x'`（`isInside` 的 `path.relative` 对大小写不敏感） | exp1：`[isInside] [upper-case, path] -> OK true` |
| 8.3 短名 | 开启：`a.ipynb`→`A539E~1.IPY`、`notes.ipynbx`→`NOTES~1.IPY`、超长目录→`VERYLO~1`、`C:\PROGRA~1` 可解析 | `cmd /c dir /x`、FSO `ShortPath` 输出 |
| 长路径 | `LongPathsEnabled=0`（注册表），但 Node v24 下 **>260 字符路径直接可用**：369 字符 `.ipynb` 读/写均成功（临时路径 405 字符）；`fsp.realpath` 返回**不带 `\\?\` 前缀**的常规路径 | exp6：`readNotebookFile long path -> status ok`、`saveNotebookFile long path -> ok, tempLeftovers []`、`realpath \\?\ long path -> hasNtPrefix:false` |
| symlink 权限 | 文件/目录 symlink 均 **EPERM**（当前用户非管理员、未开开发者模式）；`fsp.symlink(...,'junction')`、`New-Item -ItemType Junction`、`fsp.link`（硬链接）均**可用** | exp2-G：`dir symlink/file symlink -> EPERM`，`junction/file hardlink -> created` |
| **junction 的 Node 视图** | `lstat(junction).isSymbolicLink()===false, isDirectory()===true`；`readlink(junction)` → **EINVAL**；`realpath(junction)` → 目标目录；PowerShell `(Get-Item j).Target` = `Global\C:\...` | exp2-A/B/F、jprobe：`{"lstat":{"isSymbolicLink":false,"isDirectory":true},"readlink":"ERR EINVAL","realpath":"...\\A\\outside"}` |
| junction 目标可缺失 | 不能直接创建指向不存在目标的 junction（Node `ENOENT`）；但先建 junction 再删除目标目录后，该 junction 对 Node 变为 **ENOENT**（`lstat`/`stat`/`realpath` 全 ENOENT），重新指向不回来 | exp2-F：`{"lstat":"ERR ENOENT","stat":"ERR ENOENT","realpath":"ERR ENOENT"}` |
| Node v24 路径归一化与 Win32 不同 | **尾点/尾空格按字面处理**：`fs.realpath('...\\evil.txt.')` → ENOENT（文件 `evil.txt` 存在）；而 `cmd /c if exist "evil.txt."` = EXISTS、Python `os.path.exists('evil.txt.')` = True。保留设备名同理：通过 `\\?\` 创建的字面文件 `NUL.ipynb`/`CON.ipynb` 被 Node 当普通文件（`stat` 12B、`isFile:true`、`isCharacterDevice:false`），而不存在的 `NUL`/`CON` 报 ENOENT | exp3b/exp1d：`fs.realpath[raw trailing dot on evil.txt] -> ENOENT`；`cmd: evil.txt. EXISTS`；`py evil.txt.: True` |
| 只读属性语义 | `fsp.chmod(f, 0o444)` → `stat.mode=100444`；**`rename(normalSrc, readOnlyTarget)` → EPERM**；`rename(readOnlySrc, normalTarget)` → 成功；`unlink(readOnlyFile)` → **成功**（Node/libuv 会先清只读属性）；`writeFile` 截断只读文件 → EPERM；`copyFile` 覆盖只读目标 → EPERM | exp3b 全部 7 条探针输出 |
| 文件锁语义 | .NET `FileShare.ReadWrite`（= CPython `open()` 默认共享模式）下：`readFile` 成功、`rename` 覆盖 → **EPERM**；`FileShare.None` 下：`realpath`/`stat` 成功、`readFile` → **EBUSY**、`writeFile` 截断 → EBUSY；CPython 真实持锁进程结果与 .NET 模拟一致 | exp3、exp8-9b 输出 |
| 沙箱副作用 | 本会话进程为 Low IL，`icacls /deny` 一律 `Access is denied`；因此 ACL 专项实验改用真实系统受保护路径替代（见 W-PS/L-9） | `aclprobe` 输出、§7 |
| 控制台编码 | cp936，仅影响终端显示；实验输出一律写 UTF-8 JSON/日志后再读，中文/emoji 证据无乱码 | exp7 全部输出 |

> 机制说明（【推测】）：Node v24 在本机对尾点/设备名采用“扩展长度字面语义”，很可能是 `node.exe` 声明 longPathAware 后 Win32 归一化行为差异；未进一步验证机制，只记录**行为**。该行为与 Node 版本相关，升级后必须复验（见 W-PS-09）。

---

## 2. 问题表（Windows 专属发现）

> 位置均指 HEAD `8c1ad8e` 的行号。严重级沿用 CODE_REVIEW 口径（Medium/Low/Nit）。“安全类”一行给出明确可绕过/被拒绝结论。

| ID | 严重级 | 位置（file:line） | 触发条件 | 证据（命令 + 关键输出） | 建议 | 证据等级 |
| --- | --- | --- | --- | --- | --- | --- |
| **W-PS-01** | Medium | `lib/notebook.js:433`（`mode = stat.mode & 0o777`）、`:439-442`（`writeFile(...,{mode})`+`chmod`）、`:446-447`（版本复核后 `fsp.rename`）、`:448-456`（错误映射） | 目标 `.ipynb` 带 **只读属性**（Windows 的“只读”复选框；`attrib +R`、来自版本库/只读共享/OneDrive 副本都会出现）。`resolveTarget`/读/版本校验全部通过，直到 `rename(temp, target)` 时 Windows 拒绝覆盖只读目标 → EPERM | 复现脚本 `exp3-run.ps1`+`lib/notebook.js` 真实函数：① `readonly-save-1/2` → `{"code":"write-failed","status":500,"message":"Failed to write the notebook: EPERM: operation not permitted, rename '...\\.dsh-bsb-ipynb-20788-3d1a05004d7f.tmp' -> '...\\nb.ipynb'"}`；② `readonly-file-after.contentUnchanged=true`、`readonly-tmp-residue.count=0`；③ 去掉只读属性后 `readonly-cleared-save` → 200。HTTP 层 `exp9`：`/save` → `500 write-failed`（`modeAfter:"100444"`, `contentUnchanged:true`, `tempLeftovers:[]`） | ① 在 `fsp.rename` 前后把 Windows 的 `EPERM/EBUSY/EACCES` 至少区分出「目标只读」并返回可操作错误（建议 409/403 + 明确文案“文件为只读，清除只读属性后重试”），不要归类为内部写失败；② `fsp.chmod(temporary, mode)`（`:439-442`）在 Windows 只映射只读位，对“保留权限位”目标没有实际收益，可考虑 `process.platform==='win32'` 时跳过；③ README「保存可靠性」补 Windows 只读/锁定说明。**数据安全：无丢失**（旧内容保留、临时文件已清理）。 | 【已验证】 |
| **W-PS-02** | Medium | `lib/notebook.js:446-447`、`:448-456`；消费方 `lib/routes.js:202-218` | 另一进程以 **Python/Jupyter 默认共享模式**（CPython `open()`：`FILE_SHARE_READ|WRITE`，无 `FILE_SHARE_DELETE`）或任何不带 DELETE 共享的句柄打开目标 notebook。典型：同一 notebook 在 Jupyter/VSCode/编辑器里也开着。读和两次版本校验都成功，`rename` 覆盖被共享锁拒绝 → EPERM | `exp3-run.ps1`（.NET `FileShare.ReadWrite` 模拟）：`locked-rw-read` → 200 `status:"ok"`；`locked-rw-stale-save` → 409（版本校验先失败）；`locked-rw-save` → `500 write-failed ... EPERM ... rename '.tmp' -> 'nb.ipynb'`；`tempLeftovers:[]`；释放后 `after-release-save-same-version` → 200。**真实 CPython 持锁**（`exp3-pylock.py`，`open(path,'r+')`+sleep）：`python-lock-save` → `500 write-failed`，`python-lock-read` → 200 | ① 把共享冲突归类为可重试/可解释错误（例如 409 `write-conflict` 附「文件被其它程序占用」或 423），并在客户端提示关闭其它编辑器后重试；② autosave 1.5s 会持续重试失败的保存，建议对 EPERM/EBUSY 做退避并只提示一次；③ README 增加 Windows 行为说明。**数据安全：无丢失**（`rename` 失败即放弃，磁盘内容不变，临时文件清理成功）。 | 【已验证】 |
| **W-PS-03** | Low-Medium | `lib/notebook.js:308-331`（`readNotebookFile` 只包 `stat`，`readFile` 抛错直穿）、`lib/routes.js:148-155`+`lib/json.js:32-37`（非 ApiError → `internal` 500） | 目标被以**独占共享模式**（`FileShare.None`；部分 Office/杀软/索引/备份程序）打开：`realpath`/`stat` 成功，`fs.readFile` 抛 `EBUSY`。`/read` 未被映射 → `500 internal`；`/save` 因 `assertNotebookVersion` 的 `write-failed` 分支 → `500 write-failed: Failed to read the notebook: EBUSY` | `exp8-9b-run.ps1`（.NET `FileShare.None` 持锁）+ 真实路由：`read → {"status":500,"code":"internal","message":"Internal error"}`；`save → {"status":500,"code":"write-failed","message":"Failed to read the notebook: EBUSY: resource busy or locked, open '...\\nb.ipynb'"}`；同一时刻 `status → 200 {running:false,...}`；文件未损坏 | `readNotebookFile` 的 `readFile` 也应包一层错误映射（`EBUSY/EPERM/EACCES` → 与 gate 一致的 not-found+reason 或 409/423），`json.js` 对已知 fs 错误码给出可读 code；README 错误码表补 Windows 锁语义。 | 【已验证】 |
| **W-PS-04** | Medium（安全，= M-6 在 Windows 的形态） | `lib/gate.js:64-85`（授权）、`:152-185`（授权与 trace）、`:91-150`（`walkTarget` 依赖 `lstat`/`readlink`）、`lib/notebook.js:308-331,384-457`（授权与真实 I/O 两次解析） | ① **预置越界 junction**：工作区内 `jump` → 工作区外目录；② **TOCTOU**：先按正常路径授权/拿到 target，再把 target 的**父目录**改名为 `<dir>-original` 并创建同名 junction 指向外部目录（junction 无需管理员），随后 read/save 沿已授权的旧 target 路径落到外部 | `exp2-junction.mjs`：① `resolveTarget('jump/secret.ipynb')`、`resolveExistingFile`、`resolveControlTarget`（含 `jump/missing.ipynb`、`jump/sub/missing.ipynb`、junction 链 `a/b/x.ipynb`）→ 全部 `403 path-outside-root`（**被正确拒绝**）；② TOCTOU 读：`authorizedTarget=...\\ws\\sub\\nb.ipynb`，替换父目录后 `readNotebookFile` → `{readStatus:"ok", leakedMetadata:{"outside":"SECRET"}}`（**可绕过**）；③ TOCTOU 写：同法保存 → `{save:{"ok":true,...}, outsideFileWrotePluginData:true, outsideTempLeftovers:[]}`（**可绕过，越界覆盖成功**） | 与 M-6 建议相同：读路径把「授权、打开、fstat 身份核验、有界读取」绑定同一 fd；写路径绑定父目录身份（openat/dirfd 等价）并在 temp 写入/rename 前重验父目录 realpath/dev/ino。Windows 追加要求：(a) 不要依赖 `lstat().isSymbolicLink()`/`readlink()` 识别 junction（本机根本不显示），改用 `FILE_ATTRIBUTE_REPARSE_POINT` 能力或逐组件 `realpath` 比对；(b) 文档明确 Windows 上 junction 属无特权能力。**结论：预置越界=被正确拒绝；授权后替换=可绕过（与 M-6 同）**。 | 【已验证】 |
| **W-PS-05** | Low | `lib/gate.js:91-150`（`walkTarget` 对 junction 走 `realpath` 分支）、`:214-233`（`KernelPaths.resolve`） | 通过 junction 访问 notebook（如会话 cwd 下某目录是 junction），**先删 junction 的目标目录**（junction 变悬空，Node 视其 ENOENT），再走控制端点（`/status`/`interrupt`/`restart`/`shutdown`） | `exp2-junction.mjs`：`F.dangling junction shape` → `lstat/stat/realpath` 全 `ENOENT`；`resolveControlTarget('dangling/missing.ipynb')` → `"C:\\...\\ws\\dangling\\missing.ipynb"`（**保留请求拼写、非原 canonical target**），而内核键是删除前的真实目录路径 → 查不到内核（路由层将 `503 kernel-unavailable` / status `running:false`）。若只删**最终文件**而 junction 目标目录仍在，则目标被正确规范化（`sub2/nb.ipynb` → `...\\realdir\\nb.ipynb`，与内核键一致） | Mac 上用 symlink 时 `walkTarget` 会 `readlink` 展开并保留 canonical target；Windows junction 不可见导致这一意图失效。属**安全失败方向**（不会控制错内核），可不改；若要修，需在上述重验/解析逻辑中显式处理 reparse point。 | 【已验证】 |
| **W-PS-06** | Low | `lib/gate.js:214-233`（`key = JSON.stringify([sessionId, cwd, candidate])`）、`:191-201`（`samePathIdentity` 比较 `node.part` 字符串）、`:207-271` | NTFS 大小写不敏感，同一 notebook 可用 `nb.ipynb`/`NB.IPYNB`/`Nb.Ipynb` 访问。**若某拼写从未在文件存在时被观察过**，文件删除后经该拼写调用控制端点：`walkTarget` 返回**保留请求大小写**的路径，无法匹配按 canonical 路径登记的活内核 → `/status` 报 `running:false`、`interrupt` 报 `503 kernel-unavailable`，而内核其实还活在 canonical 键上 | `exp1e-case-alias.mjs`：只观察 `nb.ipynb` → 删除 → `controlTarget('nb.ipynb') = "...\\nb.ipynb"（matchesLiveKernel:true）`；`controlTarget('NB.IPYNB') = "...\\NB.IPYNB"（matchesLiveKernel:false）`；`KernelPaths:NB.IPYNB → {known:false,target:"...\\NB.IPYNB"}`。对比：文件存在时三种拼写 `resolveExistingFile` 均归一化为**同一 canonical target**，并发保存 `[ok, 409]`（正确串行） | 安全方向安全（不会控制到别的 inode）。若要求跨拼写一致，可在 `win32` 下把 alias key / kernel key 归一化（canonical 部分保持 realpath，未存在段 `toLowerCase()`），或文档说明“路径拼写需与打开时一致”。 | 【已验证】 |
| **W-PS-07** | Low | `lib/notebook.js:271-306`（`parseNotebookBytes`：`buffer.toString('utf8')` 后直接 `JSON.parse`） | notebook 文件带 **UTF-8 BOM**（Windows PowerShell 5.1 `Out-File -Encoding UTF8`/旧记事本的默认产物）或 UTF-16LE BOM | `exp7-unicode-bom.mjs`：UTF-8 BOM → `{"status":"invalid","error":"Invalid notebook JSON: Unexpected token '\\uFEFF', \\"\\uFEFF{\\"nbforma\\"... is not valid JSON"}`；UTF-16LE → 同样 `invalid`；HTTP `/read` → **200** `{ok:true,value:{status:"invalid",...}}`（客户端据此提示无效），无 500、无崩溃 | `parseNotebookBytes` 在解码后去除一个前导 `\uFEFF`（或按 BOM 选择 utf-16 解码）；README Known Limitations 加一行 Windows 编码说明。 | 【已验证】 |
| **W-PS-08** | Nit | `lib/notebook.js:374,419,455`（错误消息拼接 `error.message`）；`lib/json.js:32-37` | Windows 锁/只读场景下 `write-failed` 的 message 内含**完整绝对路径、临时文件名与进程 PID**，随 `{ok:false,error:{message}}` 返回浏览器 | `exp8-9b`：`"Failed to write the notebook: EPERM: ... rename 'C:\\Users\\...\\.dsh-bsb-ipynb-23612-27f5a03c8ce2.tmp' -> 'C:\\Users\\...\\nb.ipynb'"` | 服务端日志保留细节、响应 message 收敛为通用文案+error code；或至少去掉临时文件名/PID。 | 【已验证】 |
| **W-PS-09** | Nit | 环境事实（非代码缺陷） | Node 版本依赖：本机 Node v24 对尾点/尾空格/保留设备名采用字面语义（与 cmd/Python 的 Win32 归一化不同）；同时长路径可用（即便 `LongPathsEnabled=0`）。升级 Node 或换 Windows 版本后，**尾点/设备名路径的拒绝/归一化行为可能变化** | exp3b/exp1d/exp6（见 §1） | 测试不要写死“Win32 会剥离尾点/空格”；对 `.ipynb` 扩展名的最终判定必须继续以 `realpath` 结果为准（当前实现正确）。 | 【已验证】 |

---

## 3. 正路径回归（Windows 上确认正常，供修复时防回归）

脚本：`exp9-routes.mjs`（真实 `handleRequest` + 伪造 `req/res`）、`exp4-storage.mjs`、`exp6/exp7`。

| 场景 | 结果 |
| --- | --- |
| `/read` 相对路径 / `sub/inner.ipynb` / `sub\\inner.ipynb` / `sub/../nb.ipynb` | 200，`status:"ok"`，version 一致 |
| `/read` 大小写变体 `NB.IPYNB`、`Nb.Ipynb`；绝对路径全大写 | 200，同一 canonical target/version |
| `/read` 绝对 `C:\\...`、`C:/...` 混合分隔符、`\\?\C:\...` 扩展前缀 | 200（`\\?\` 被 `realpath` 归一化为无前缀路径） |
| `/read`/`/save` junction 别名 `jump/inner.ipynb` | 200（保存写入 junction 目标真实文件） |
| `/save` 正常/大小写/正斜杠绝对路径/junction 别名 | 200 + 新 version；外部修改后再保存 → 409 且 `details.version` 为当前版本；保存失败时目标内容不变、临时文件 0 残留 |
| 并发保存同一 canonical 路径（大小写变体、8.3、junction 别名） | 第一个成功、第二个 `409 write-conflict`（`enqueueSave` 按 canonical target 串行） |
| 外部文件修改在两次版本校验之间 | 409 或（M-8 注入的 rename 窗口内）静默覆盖——见 §5 M-8 |
| 长路径 369/405 字符、`\\?\` 长路径 | read/save 均成功，无残留 |
| 中文/emoji/日文/韩文/空格/`#`/`+`/组合字符文件名（含子目录） | read/save 往返成功，UTF-8 无 BOM、LF 输出；NFC/NFD 在 NTFS 上是两个不同文件，各自读写正常 |
| CRLF 格式的 notebook JSON | read `status:"ok"` |
| 保存失败后磁盘内容 | 只读/锁定两种场景均 `contentUnchanged:true`，**无数据丢失** |
| 临时文件 | 正常保存成功、锁失败、只读失败后目录内 `.dsh-bsb-ipynb-*.tmp` 均为 **0**（libuv `unlink` 会清只读属性） |

---

## 4. Windows 路径形态 × 安全结论矩阵（任务要求的“可绕过/被拒绝”明确判定）

样本：假工作区 `ws`（内含 `nb.ipynb`/`a.ipynb`/`notes.ipynbx`/`evil.txt`/长目录/junction），外部目录 `outside`（`secret.ipynb`）。判定基准：`.ipynb` 扩展名检查（`gate.js:282-286`）与工作区包含检查（`isInside`，`gate.js:11-14`，`realpath` 后判定）。

| 路径形态 | 实测行为 | 结论 |
| --- | --- | --- |
| 大小写变体 `A.IPYNB`/`a.Ipynb`（NTFS 同一文件） | `resolveTarget`/`resolveExistingFile` → 同一 canonical target（磁盘真实大小写）；`assertNotebookPath` 用 `toLowerCase()` 后接受 | **被接受（正确）**；不能借大小写指向不同文件（NTFS 不允许同目录仅大小写不同）；并发保存正确串行 |
| 混合分隔符 `sub/b.ipynb`、`sub\\b.ipynb`、`C:/ws/a.ipynb` | `path.isAbsolute`/`normalize`/`resolve` 统一为 `\\` 后 realpath | **正常接受**，无绕过 |
| 工作区根带/不带尾分隔符、`..` 穿越 | `resolveWorkspace` realpath 去尾分隔符；`..` 解析后 realpath 再 `isInside` | 工作区内接受；`../outside/...`、绝对外部 → **403 正确拒绝** |
| 8.3 短名（`A539E~1.IPY`、`VERYLO~1\\c.ipynb`、`C:\\PROGRA~1`） | realpath 展开为长名后判定：工作区内文件/目录 → 接受；工作区外（相对/绝对 8.3、`C:\\PROGRA~1\\Common Files`）→ **403**；`NOTES~1.IPY`（长名 `notes.ipynbx`）→ realpath 得长名 → **400 not-notebook** | **不能绕过**：扩展名与包含检查都作用在 realpath 长名上；8.3 只是拼写别名 |
| 盘符相对 `C:foo` | `path.isAbsolute('C:a.ipynb')===false` → `path.resolve(cwdReal,...)` 把盘符当相对段、相对**工作区**解析（实测 `C:a.ipynb` → `ws\\a.ipynb`） | **不能绕过**：结果仍落在工作区，后续 realpath+isInside 正常；`C:..\\..\\Windows` 等越界解析后若存在 → 403，不存在 → 404 |
| 尾点/尾空格 `a.ipynb.`、`a.ipynb `、`evil.txt.` | Node v24 字面语义：不存在这样字面名 → **404**（cmd/Python 会剥尾点，但当前进程不会）；若真用 `\\?\` 创建字面 `lit.ipynb.`，realpath 成功但 `extname= "."` → **400 not-notebook**，其去尾点拼写找不到该文件 → 404 | **不能绕过（被拒绝）**；副作用：以尾点/空格命名的 notebook 无法被插件打开（罕见） |
| ADS：默认流 `a.ipynb::$DATA` | realpath 归一化为 `a.ipynb`，读到默认数据流（同一文件） | **不构成绕过**（等价别名）；HTTP `/read` 200 |
| ADS：命名流 `a.ipynb:secretstream`（流存在）、`evil.txt:stream` | realpath 保留 `:stream`；`extname` ≠ `.ipynb` → **400 not-notebook**；工作区外文件命名流 → **403**；流不存在的名字 → 404 | **不能绕过**：命名流不能当 notebook 读，也不能越界 |
| 保留设备名 `NUL`/`CON`/`COM1`/`PRN`、`NUL.ipynb` | 未创建字面文件时 → **404**；通过 `\\?\` 创建的**字面文件**（本机可创建）被 Node 当普通文件（`isFile:true`，12B），`NUL.ipynb` 可被当作 `.ipynb` 读取→内容非 JSON → `status:"invalid"`，无越界；`\\.\NUL` → EINVAL/404；`\\.\PhysicalDrive0` → EISDIR/404；`\\.\C:\Windows\win.ini` → 403 | **不能绕过**；设备命名空间不产生越界文件访问 |
| `\\?\` / `\\.\` 前缀 | `\\?\C:\ws\a.ipynb` → 恒等归一化后 200；`\\?\C:\...\outside\secret.ipynb` → **403**；`\\?\` 前缀结果不带前缀返回 | **不能绕过**（前缀被 realpath 归一化）；可作为合法拼写被接受 |
| UNC `\\\\localhost\\C$\\Windows\\win.ini`、`\\\\?\\UNC\\...` | `realpath` → **EPERM**（无管理员共享访问）→ 404 + `details.reason`；无法建共享，UNC **工作区**行为未验证 | 外部 UNC 目标**被拒绝（404）**；UNC 作为 workspace 见 §7 未验证 |
| 根相对 `\\Windows\\win.ini`、`/Windows/win.ini` | `path.isAbsolute` true → `C:\\Windows\\win.ini` → **403** | **被正确拒绝** |
| NUL 字节 / 孤立代理项 路径 | `fsp.realpath` 抛 `ERR_INVALID_ARG_VALUE`/ENOENT → gate 包成 **404**（`File is not accessible` + reason），无 500/崩溃 | 安全失败，**被拒绝** |
| 工作区外的已存在文件（绝对/相对） | 读取/保存均 **403 `path-outside-root`**；`/save` 不会把 403 错映射成 409（`routes.js:202-213` 只重映射无 details 的 not-found） | **被正确拒绝** |

---

## 5. Mac 审查条目在 Windows 下的复核（任务指定条目）

| 条目 | Mac（CODE_REVIEW） | Windows 复核结论 | 证据等级 |
| --- | --- | --- | --- |
| **M-6** 路径授权与 I/O 两次解析、symlink 替换越界 | 【已验证】symlink 替换后读泄漏/写越界；前提是能并发修改目录项 | **成立，且 Windows 形态更值得关注**：① 预置越界 **junction** 被 403 拒绝（`isInside(realpath)` 生效）；② TOCTOU：授权后把**父目录**换成 junction（本机无需管理员）→ 读泄漏外部 `{"outside":"SECRET"}`、写成功覆盖外部文件（`outsideWrotePluginData:true`，无残留）；③ **junction 对 `lstat`/`readlink` 不可见**（`isSymbolicLink:false`、`readlink:EINVAL`），`walkTarget:91-150` 的链接展开/身份保留只对真正的 symlink 生效；本机 symlink EPERM，所以 Mac 的「文件目标 symlink 替换」不可用，但父目录 junction 替换等价且更易创建。**结论：预置越界=被正确拒绝；授权后替换=可绕过**。 | 【已验证】 |
| **M-8** rename 窗口内外部写被静默覆盖 | 【已验证】rename 钩子注入外部写：save fulfilled、外部编辑丢失 | **成立（与 Mac 相同）**：`fsp.rename` 钩子注入外部写 → `saveFulfilled:true`、`externalEditWasPresentBeforeRename:true`、最终内容 `finalHasPluginData:true`、`finalHasExternalData:false`。两次版本校验都发生在 rename 前，rename 本身无 CAS。 | 【已验证】 |
| **L-5** 每次保存 2 次全量 readFile + 2 次 sha256；读取无上限 | 【已验证】readFile 调用计数=2 | **成立**：一次 8.38MiB notebook 保存 → `calls=2, bytesRead=16777348`（≈2×文件）；在 stat 之后、版本读取之前把文件增长到 34.6MB（>32MiB 上限）→ 保存内部仍整体读入 `readBytesInsideSave=34603074`，随后才因版本不匹配返回 409。 | 【已验证】 |
| **L-6** 崩溃/异常残留 `.dsh-bsb-ipynb-*.tmp`，无清理器 | 【已验证】SIGKILL 后残留 | **成立（同 Mac）**：预置两个陈旧 `.dsh-bsb-ipynb-*.tmp` 后调用 `readNotebookFile` 与 `saveNotebookFile`，**两者都不清理**、文件仍在。Windows 补充：① 正常/锁失败/只读失败路径的临时文件均被清理（0 残留）；② 原先“只读临时文件删不掉导致累积”的假设被否定——`unlink` 对只读文件成功；③ 若临时文件被 AV/索引器加锁导致 `unlink` 失败，仍可能残留（**未验证**，见 §7）。 | 【已验证】/（AV 场景【推测】） |
| **L-8** read 的 stat→readFile 竞态绕过 32MiB 读入上限 | 【推测】代码路径 | **在 Windows 实测成立**：`readNotebookFile` 先 `stat`（58B）→ 在 `readFile` 窗口内把文件增长到 34,603,074B → 仍**整体缓冲** 34,603,074B，之后 `parseNotebookBytes` 才抛 `413 too-large`。即“上限检查在缓冲之后”，峰值内存按文件实际大小。 | 【已验证】 |
| **L-10** 同一 inode 硬链接别名并发保存两个都成功 | 【已验证】 | **成立且更明显**：`a.ipynb` 与硬链接 `b.ipynb` 并发保存（同一 baseVersion）→ **两个都 fulfilled**（`[{ok:true},{ok:true}]`），最终两文件内容不同（`contentsEqual:false`），且**保存后不再是硬链接**（`stillSameInode:false`）——两个名字各自替换，数据分叉。README「同一 notebook 并发保存只有第一个成功」在 Windows 亦不成立。**Windows 变体**：大小写/8.3/junction 别名因为 `realpath` 归一化到同一 canonical 字符串，**能够正确串行**（第二个 409），所以问题只剩硬链接（及可能的其它 inode 别名，如 MFT 双路径）。 | 【已验证】 |
| **L-7** `/read` 返回重复 cell id、minor<5 不升版 | 【已验证】真实 nbformat 5.11 | Windows 抽查（格式逻辑与平台无关）：`/read` 含两个 `id:"dup"` 的 notebook → HTTP 200，`value.notebook.cells[].id = ["dup","dup"]`，`nbformat_minor:5`；与 Mac 结论一致，**平台无关，未新增 Windows 影响**。 | 【已验证】 |
| **L-9** 工作区外路径 oracle | 【已验证】存在→403/不存在→404/EACCES→404+reason | **成立（Windows 实测）**：`C:\System Volume Information`（存在、EPERM）→ 404 `File is not accessible` + `details.reason:"EPERM: ... realpath ..."`；`C:\Windows\System32\config\SAM` 同；工作区外**已存在**普通文件 → 403；工作区内不存在 → 404（无 details）。`/save` 对“存在但不可访问”返回 404+details（不会被 `routes.js:202-213` 错映射成 409）。**平台无关，Windows 因系统受保护路径多、更易探测**。 | 【已验证】 |
| **L-11** save 接受 64MiB 请求体而 notebook 上限 32MiB | 【契约核对】 | Windows 无关，未重复实测：`json.js:88-111` 上限 64MiB 与 `notebook.js:402-408` 32MiB 预算的差值不变；仅确认 Windows 下失败路径与 Mac 相同。 | 【契约核对】 |
| **M-7 / L-14 等** | — | 不属本子域（worktree 活动根 / 解释器发现），见 03/04 队友文档。 | — |

**补充：与 README 声明一致性**
- README「Serialized saves — concurrent saves of the same notebook run in order; only the first succeeds」：对**同一路径/大小写/8.3/junction 别名**成立；对**硬链接别名**不成立（L-10）。
- README「atomic writes through a same-directory temp file and rename」：Windows 实测 temp 与目标同目录（错误消息可见），成功路径原子替换；失败路径无残留。只读/锁定目标会 `rename` 失败但**不会**写坏目标。
- README 错误码表：Windows 锁/只读场景会产生表外的 `internal`(W-PS-03) 与语义不精确的 `write-failed`(W-PS-01/02)；建议补充。

---

## 6. HTTP/JSON 层（`lib/json.js`、`lib/routes.js`）Windows 行为核对

均为真实 `registerIpynbRoutes`+`handleRequest` 路径（伪造 `ctx`/`req`/`res`，无真实 socket；T-5 项仍成立）：

| 输入 | 结果 | 结论 |
| --- | --- | --- |
| `path` 非字符串（42/null/数组/对象/true） | 400 `bad-request: path is required` | 正常 |
| `sessionId` 空/缺失 | 400 `bad-request: sessionId is required` | 正常 |
| Content-Type `text/plain`/缺失 | 400 `bad-request: Content-Type must be application/json` | 正常 |
| JSON body 语法错误 | 400 `bad-request: Invalid JSON body: ...` | 正常 |
| `baseVersion` 非字符串 | 400 `bad-request: baseVersion must be the sha256 version returned by /ipynb/read` | 正常 |
| GET 到 POST 路由 | 405 + `allow: POST` | 正常 |
| 尾部 `/`、`//` | 被 `replace(/\/+$/,'')` 归一化后匹配 | 正常 |
| 端点大小写 `/ipynb/READ`、百分号编码 `/ipynb/%72ead` | 404 `Unknown endpoint` | 不做大小写/解码宽松匹配（安全） |
| 路径含 NUL / 孤立代理项 | 读到 gate 后 404 + reason（无 500/崩溃） | 正常 |
| `/read` 不存在的 notebook / 非 `.ipynb` / 目录 | 404 / 400 `not-notebook` / 400 `Not a file` | 正常 |
| `/save` 不存在目标 | 409 `write-conflict` + `details.version:null`（`routes.js:202-213` 设计如此） | 与 README 一致 |
| `/save` 工作区外目标 | 403（不会被误映射为 409） | 正常 |
| `/status` 各类 Windows 路径（相对/大小写/绝对/8.3/junction/含 `+`） | 200 `{running:false,...}`（无内核时） | 正常；query 需标准百分号编码（未编码的 `+` 会解码为空格，客户端需用 `URLSearchParams`——属客户端契约） |
| Windows 只读目标 `/save` | 500 `write-failed`（见 W-PS-01） | **Windows 专属** |
| Windows 独占锁 `/read` | 500 `internal`（见 W-PS-03） | **Windows 专属** |
| Windows 只读/锁定失败后的响应体 | 含完整绝对路径/临时文件/PID（W-PS-08） | 建议收敛 |

**未发现**任何由 Windows 路径形态造成的路由层绕过（例如 `%5C`/大小写端点/`..%2f` 均不改变授权判定；真正的判定全部在 `gate.js` 的 realpath 上）。

---

## 7. 未能验证事项（明确标注，勿当作已验证）

1. **UNC 作为 session workspace**：本机无可用 SMB 共享（`\\localhost\C$` EPERM、无法建共享），`resolveWorkspace`/containment 在 UNC 根上的行为 **未验证**。外部 UNC 路径已被拒绝（404+reason）。
2. **ACL 拒绝（icacls）专项**：本会话沙箱为 Low IL + 受限组，`icacls /deny` 一律 `Access is denied`（`aclprobe` 输出），**无法**人工制造 EACCES 文件；已用真实系统受保护路径（`C:\System Volume Information`、`C:\Windows\System32\config\SAM`）覆盖同类错误映射（W-PS/L-9）。若需严格 ACL 用例，请 Lead 用全权限会话跑：`icacls <file> /deny "<user>:(R)"` 后调用 `lib/gate.js`/`/read`。
3. **AV/索引器锁导致临时文件 `unlink` 失败**：未能用真实杀软/索引器复现，残留行为为【推测】。同理“目标被 Windows Search/备份短暂打开”造成的 EPERM 时序抖动未量化。
4. **真实 DSH 宿主进程端到端**：全部实验使用伪造 `ctx`（与 `test/control-symlink.test.mjs` 相同形状）与仓库内真实 `lib/*.js`；未在真实 DSH Web 会话中打开真实 notebook 验证 better-sidebar 传入的路径拼写（绝对/相对、大小写来源），也未验证浏览器端 autosave 对 500 的展示/重试策略（客户端属 03 子域）。
5. **junction `readlink` 行为与 Lead 报告不一致，待对齐**：Lead 报告 junction 的 `fs.readlink` 返回普通绝对路径（无 `\\?\` 前缀）；本会话实测两种创建方式（`New-Item -ItemType Junction`、`fs.symlink(...,'junction')`）均为 `lstat.isSymbolicLink()===false` + `readlink` **EINVAL** + `realpath` 解析成功（`exp2-probe-link.mjs`/`jprobe` 输出），PowerShell `(Get-Item j).Target` 为 `Global\C:\...`。可能是权限/进程环境差异（本会话 Low IL 沙箱），建议在真实 DSH 宿主进程复验。**本报告所有安全结论不依赖 readlink 细节**（越界拒绝由 realpath+isInside 产生，TOCTOU 由两次解析产生）。
6. **尾点/空格命名的合法 notebook**：只能通过 `\\?\` 创建，插件按扩展名判定拒绝（400）；是否有真实用户/工具产生此类文件未调查。
7. **`NOTEBOOK_CAP_BYTES` 边界与 64MiB body 的实际内存峰值**：L-11 仅做契约核对，未在 Windows 重复 64MiB POST 的内存测量（win-tests 的 04 覆盖测试层）。
8. **完整 `npm test`**：由 win-tests 负责（04-tests-ci.md：292/238 pass/51 fail/3 skip 基线；gate.test.mjs 7 个失败均为 `fs.symlink` EPERM、notebook.test.mjs 32 tests 31 pass/1 skip），本文不重复；其 symlink 相关失败与本机 symlink EPERM 环境事实一致。

---

## 8. 修复优先级建议（本子域）

| 优先级 | 项 | 理由 |
| --- | --- | --- |
| P1（安全） | W-PS-04（M-6 的 fd/父目录身份绑定） | 越界读/写已验证；Windows junction 无特权，现实中比 Mac symlink 更易被利用（且 `lstat/readlink` 检测方案在 Windows 失效，必须用 realpath/重解析点能力） |
| P2（数据可靠性/体验） | W-PS-01、W-PS-02、W-PS-03 | Windows 上“文件只读/被 Jupyter 打开/被独占打开”是高频场景，当前一律 500 且 `/read` 报 internal；不丢数据，但用户无法自救且 README 未说明 |
| P3 | W-PS-05、W-PS-06、W-PS-07 | 安全失败方向的边角；BOM 兼容成本低收益直接（Windows 工具常见） |
| P4（顺带） | W-PS-08（消息收敛）、W-PS-09（测试/文档不绑定 Node 版本语义）、L-10 文档化（硬链接别名） | 低成本；L-10 若修复需按 dev/ino 串行化或 README 声明边界 |

---

## 9. 复现命令索引（临时脚本，审查后已从 `%TEMP%` 删除；输出记录于各节）

| 实验 | 命令（PowerShell，样本根 `$B=%TEMP%\dsh-win-review\win-paths`） | 关键输出 |
| --- | --- | --- |
| 路径形态/大小写/8.3/ADS/设备名/尾点 | `node $B\exp1-paths.mjs $B`、`node $B\exp1c-test.mjs $B`、`node $B\exp1d-test.mjs $B` | 见 §4 矩阵 |
| junction 包含/TOCTOU/悬空 | `node $B\exp2-junction.mjs $B` | A: 403；D: `leakedMetadata {"outside":"SECRET"}`；E: `outsideFileWrotePluginData:true`；F: 悬空 junction 全 ENOENT |
| 大小写别名（未观察拼写） | `node $B\exp1e-case-alias.mjs $B` | `NB.IPYNB -> matchesLiveKernel:false` |
| 锁/只读/原子保存 | `Invoke-Expression (Get-Content $B\exp3-run.ps1 -Raw)`（.NET FileStream + 真实 CPython 持锁） | 只读/共享读写 → 500 write-failed EPERM；独占 → read 500 internal；无残留 |
| L-5/L-6/L-8/L-10/M-8 | `node $B\exp4-storage.mjs $B` | `calls=2, bytesRead=16777348`；`readBytesInsideSave=34603074`；硬链接 `[ok,ok]`；M-8 `finalHasExternalData:false`；陈旧 tmp 未清理 |
| 长路径 | `node $B\exp6-longpath.mjs $B` | 369/405 字符 read/save 正常 |
| 中文/emoji/BOM/CRLF | `node $B\exp7-unicode-bom.mjs $B` | 全部 read/save 正常；BOM → `status:"invalid"` |
| 路由层 | `node $B\exp9-routes.mjs $B` | 正/负用例见 §3/§6 |
| 锁/受保护路径/8.3 并发保存 | `Invoke-Expression (Get-Content $B\exp8-9b-run.ps1 -Raw)` | `read 500 internal`（独占）；`/System Volume Information` → 404+EPERM reason；8.3 `canonicalSame:true, versionSame:true, concurrent:[ok,409]` |

---

*本文件只新增 `docs/windows-review/02-paths-storage.md`；未修改任何源码/测试，未 `git add/commit`。实验残留（TEMP 样本、junction、硬链接、只读属性、持锁进程）已清理。*
