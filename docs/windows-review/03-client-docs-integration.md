# 03 — Windows 侧审查：浏览器客户端、文档与 DSH/better-sidebar 集成

> 审查域：`client.js` 在 Windows 浏览器 / 中文输入法下的行为；README / README_ZH / CONTRIBUTING / CI / package.json 的平台假设；本机真实 DSH 桌面 + dsh-better-sidebar 0.30.1 的 Windows 集成约定。
> 基线：仓库 `C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb` HEAD `8c1ad8e`，工作树干净（仅新增本报告）。
> 完整 `npm test` 由队友 win-tests 负责，本报告未运行全量测试。
>
> 证据等级（沿用 CODE_REVIEW.md 约定）：
> - 【已验证】**本报告用仓库自带 vm harness 或确定性脚本实际执行得到的结果**（脚本均只读仓库、写入 `%TEMP%`，未入库）；
> - 【契约核对】对照本机安装的 DSH 0.2.2-rc.1 `resources/app.asar` 与 dsh-better-sidebar 0.30.1 源码/安装版；
> - 【推测】仅代码推理，未在真实浏览器/输入法下实测。

---

## 1. 环境事实（本机实测）

| 项 | 值 | 证据 |
| --- | --- | --- |
| OS | Windows 11，DisplayVersion **26H2**，build **26300.9818**，x64（注册表 `ProductName` 仍写 "Windows 10 Home China"，是 Win11 的已知注册表怪癖） | `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion` |
| 用户语言 / 输入法 | `zh-Hans-CN` + `en-AU`；中文 IME `0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}`（微软拼音），英文键盘 `0C09:00000409` | `Get-WinUserLanguageList` |
| 浏览器 | Edge **156.0.4314.58**、Chrome **156.0.8078.80**（均为 Chromium 内核） | 安装目录 exe FileVersion |
| Node / npm | `v24.19.0` / `11.17.0`（tasks 描述与实机一致） | `node --version`、`npm --version` |
| 控制台代码页 | `chcp` → **936**（系统 ACP cp936）；pwsh `[Console]::OutputEncoding` → UTF-8(65001)，两者不一致。下文 W-I8 说明内核输出链路不受影响 | `chcp`、`[Console]::OutputEncoding` |
| Git 换行 | `core.autocrlf=true`，**无 `.gitattributes`**；`git ls-files --eol` → `i/lf w/crlf`（client.js / README.md / lib/env.js / examples/demo.ipynb 工作树全为 CRLF） | `git config core.autocrlf`、`git ls-files --eol`、逐字节计数 |
| 仓库 | HEAD `8c1ad8e Fix Node and DSH badge rendering`，`git status --porcelain` 空 | `git log`/`git status` |
| DSH 桌面版 | **0.2.2-rc.1**：`DeepSeek Harness.exe` FileVersion=0.2.2-rc.1；`app.asar/package.json` → `@deepseek-ai/dsh-desktop` 0.2.2-rc.1（`dshBuildCommit c59d10a…`）；`app.asar/dsh/desktop-runtime.json` → `release.version 0.2.2-rc.1`、`hostProtocolVersion 4`、`node 24.21.0`、`platform win32`、`sharedPackages` 中 `@deepseek-ai/dsh`=0.2.2-rc.1 | exe VersionInfo；只读解析 asar 头（脚本见 §9） |
| DSH 版本误报来源 | `C:\Users\kexio\.dsh\dsh-runtimes\dsh-primary-runtime\runtime.json` 的 `desktopVersion=0.2.1-rc.3` 是 **2026-10-23 的旧缓存副本**；安装目录 `resources\runtime\primary-runtime\runtime.json`（2026-11-04）为 0.2.2-rc.1，与 exe/asar 一致 → 以 0.2.2-rc.1 为准 | 两个 runtime.json 的 mtime + 内容 |
| npm 全局 dsh CLI | `0.1.0-rc.6`（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`），是 **CLI 产品线**，与桌面版不是同一版本号体系；`~/.dsh/profiles/node_modules/@deepseek-ai/*` 也是 0.1.0-rc.6 的旧残留（2026-10-18） | 文件读取；与 Lead 的更正一致 |
| better-sidebar | **0.30.1** 已安装且**带 `src/`**（可直接读 TS 源码），README 自述要求 DSH 0.2.2-rc.1+、Windows/Linux/macOS 支持（Windows 由 CI 覆盖）；自带 `scripts/install.ps1`、`test:windows` 脚本 | `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/{package.json,README.md,src}` |
| 本插件 live 安装 | profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-bsb-ipynb`，依赖 `link:C:/Users/kexio/Desktop/GitHub/dsh-bsb-ipynb`；`node_modules/dsh-bsb-ipynb` 是 **Junction** → 仓库；plugin-manager 日志（2026-11-07 16:07）`+ dsh-bsb-ipynb 0.1.0 <- ..\..\..\Desktop\GitHub\dsh-bsb-ipynb` | `~/.dsh/profiles/desktop/package.json`、`Get-Item … LinkType`、`.plugin-manager/logs/operation-1LvBfe/pnpm.log` |
| DSH Web GUI | `http://127.0.0.1:56606`，匿名访问 `/` 返回 **401**（无法从 HTTP 侧验证插件路由/界面）；netstat 可见监听进程 PID 10164 与 Electron 渲染进程的 ESTABLISHED 连接 | `Invoke-WebRequest`、`netstat -ano` |
| Python（Windows 实机） | PATH 上有 `C:\Python314\python.exe`、`C:\Users\kexio\miniconda3\python.exe`；`python3` 只有 `WindowsApps\python3.exe`（应用执行别名，指向商店）；DSH 内置 Python `~/.dsh/dsh-runtimes/…/dependencies/python/python.exe` = 3.12.14，其 `Lib\site-packages` **无** jupyter_client/ipykernel/nbformat | `where.exe`、目录检查（见 W-I3） |

---

## 2. Top 发现（严重级排序）

| # | 级别 | 结论 | 归属 |
| --- | --- | --- | --- |
| 1 | **P1 / Windows 功能不可用** | Windows 上 `lib/env.js` 的解释器发现按 Unix 布局构造候选：PATH 只查无扩展名 `python3`/`python`、conda 查 `<env>/bin/python`、内置 Python 查 `…/python/bin/python3`。在本机逐项检查**候选数 = 0**（真实文件全在 `.exe` / `<env>\python.exe` / `…\python\python.exe`），且内置 Python 未装 jupyter 包 → `/ipynb/interpreters` 为空、`/execute` 返回 503 `kernel-unavailable`，Windows 新用户开箱即用「运行」按钮不可用。 | L-14 复核（主责 win-host），本报告提供 Windows 实机证据 |
| 2 | P2 | **插件自身没有任何 IME composition 守卫**（全文 `isComposing`/`keyCode 229`/`compositionstart` 均 0 处），`onKeyDown` 的 Escape / Ctrl·Cmd+Enter / Shift+Enter / Alt+Enter / Ctrl·Cmd+S 直接分支；Node 驱动已证明 composition 状态下这些 handler 会照常触发（回车选词→运行、Esc 取消候选→退出编辑）。**但**真实 DSH + better-sidebar 0.30.1 组合下，宿主在 document 捕获阶段注册了 IME guard 并 `stopPropagation`，事件到不了插件的 React handler，实际误触发概率低；属"依赖宿主防线"的健壮性缺陷（换成未注册 guard 的宿主/版本时即复发；0.28.x 是否注册 guard 未验证）。 | 本域 |
| 3 | P2 | **Windows 绝对路径下的 Markdown 相对图片全部裂图**：`makeImageResolver` 用 `notebookPath.startsWith('/')` 判断绝对路径，`C:\…\x.ipynb` 落入 cwd 拼接分支，base 变成 `C:/repo/C:/repo/examples`；已用真实函数驱动复现（期望 `C:/repo/examples/images/plot.png`，实际 `C:/repo/C:/repo/examples/images/plot.png`）。better-sidebar 传给 viewer 的确实是原生反斜杠绝对路径（契约已核对）。 | 本域 |
| 4 | P2 | **`Ctrl+S` 大小写敏感**：`event.key === 's'` 在 CapsLock（`event.key === 'S'`）或 `Ctrl+Shift+S` 时既不保存也不 `preventDefault`；浏览器版 DSH（Chrome/Edge）会落到浏览器"保存网页"默认行为。Node 驱动已验证。 | 本域 |
| 5 | P3 | 快捷键提示硬编码 `Ctrl/Cmd`（STRINGS 62/117、底部常驻 2189），无任何平台检测（`navigator.platform/userAgent` 全文 0）；Windows 用户始终看到 "Cmd"。DSH 0.2.2-rc.1 自带 per-platform shortcut 服务与 `presentBinding`（Windows 用 "Ctrl+A" 形式、macOS 用 ⌘），可接入。 | 本域 |
| 6 | P3 | 文档/CI 只有 macOS 视角：`Cmd+R`、`python3 …` 命令、只跑 ubuntu-latest、无 `.gitattributes`、bug 模板版本示例写死 macOS、CONTRIBUTING 的大小写测试说明漏了 Windows NTFS + symlink 权限。具体行号与建议文案见 §4。 | 本域 |

---

## 3. 客户端问题表（`client.js`）

> 位置均为仓库 HEAD（8c1ad8e）行号。"触发条件"只列 Windows 相关差异或 Windows 下被放大的部分。

| ID | 严重级 | 位置（file:line） | 触发条件 | 证据 | 建议 | 证据等级 |
| --- | --- | --- | --- | --- | --- | --- |
| **W-C1** | P2（Medium） | `client.js:1218-1246`（唯一 `onKeyDown`，挂到三处 textarea：`1287-1295` 代码、`1307-1315` markdown、`1321-1329` raw；非编辑态 `pre` 的 `onKeyDown` 在 `1300-1304`/`1334-1337`，仅 Enter→编辑）；分支：`1219` Esc、`1222` Enter+Ctrl/Meta、`1225` Enter+Shift、`1229` Enter+Alt、`1232` `s`+Ctrl/Meta、`1235` Tab | 中文输入法（微软拼音/搜狗等）composition 进行中按 Enter 选词、Esc 取消候选。plugin 层无保护 | ① 静态：全文 `isComposing`、`compositionstart/end`、`keyCode 229`、`addEventListener` **0 处**（grep 仅命中 `navigator.language`@129）。② 动态（仓库 vm harness 真调 `CellView` 返回的 textarea `onKeyDown`，非真实浏览器）：`{key:'Enter',shiftKey:true,isComposing:true}` → `fired:['run','runAndNext']`、`prevented:true`；`{key:'Enter',shiftKey:true,keyCode:229}` 同上；`{key:'s',ctrlKey:true,isComposing:true}` → `fired:['save']`；`{key:'Escape',isComposing:true}` → `fired:['done']`。③ 缓解契约：better-sidebar 0.30.1 在 client `apply` 最早注册 document 捕获 IME guard（`src/client/index.tsx:446-464`；实现 `src/client/ime-guard.ts:76-117`，keydown/keyup 在 composition 活跃时 `stopPropagation`），且该 guard 已进入安装版 `lib/client.js`（含 `compositionstart` 监听）。React 18 委托监听在 root 容器，事件在 document 捕获阶段即被拦下，插件的 React handler 收不到 composition 键 → 真实组合下「回车选词误运行」预计不会发生（事件顺序未在真实浏览器验证）。 | 在 `onKeyDown` 第一行加守卫：`if (event.isComposing \|\| event.keyCode === 229) return`（React 合成事件类型未声明 `isComposing`，可用 `event.nativeEvent.isComposing` 或 keyCode 229 兜底，语义与 better-sidebar `isLikelyImeKey` 一致）；补 T-3 回归：composition 下 5 个快捷键均不触发、Esc 不退出编辑。**不要依赖宿主 guard**（本报告只确认 0.30.1 注册了 guard；0.28.x 等其他版本/其他宿主是否注册未验证，缺失时上述误触发会直接出现）。 | 【已验证（插件行为，Node 驱动）】+【契约核对（宿主 guard）】+【推测：真实浏览器事件顺序】 |
| **W-C2** | P2（Medium，浏览器）/ Low（Desktop） | `client.js:1232-1234`：`event.key === 's' && (event.metaKey \|\| event.ctrlKey)` | CapsLock 开启时按 Ctrl+S；或 Ctrl+Shift+S；中文 IME 处于英文/中文模式但无 composition 时 `event.key` 仍会区分大小写 | Node 驱动：`{key:'S',ctrlKey:true}` → `fired:[]`、`prevented:false`（不保存，也不阻止默认）。Windows Chrome/Edge 网页版因此弹出"保存网页"对话框（DSH Desktop 的 Electron 无此默认行为，风险低）。 | 改用 `event.code === 'KeyS'`，或 `event.key.toLowerCase() === 's'`；并补一条 CapsLock 回归用例。 | 【已验证（Node 驱动）】 |
| **W-C3** | P2（Medium，功能缺陷） | `client.js:950-985`（`makeImageResolver`）：`953` `notebookPath.startsWith('/')` 只认 POSIX 绝对路径；`954` 否则 `dirnamePosix(normalizePosix(scope.cwd + '/' + notebookPath))`；`981-983` 相对图片拼 `base + '/' + source` 后走 `fileUrl`（`955-961`） | Windows 上打开任意 notebook（better-sidebar 传入原生绝对路径 `C:\…\x.ipynb`），Markdown cell / `text/markdown` 输出里含相对图片（`![](images/plot.png)`、`![](./img/a.png)`） | ① 契约：viewer 的 `path` 是原生绝对路径——`FileViewerProps.path`（better-sidebar `src/client/service.ts:306-310`、`load?: (path,…)`@414）← `EditorHost` `action.viewer.load?.(path, scope, signal)`（`src/client/EditorHost.tsx:524-525`，path 来自 tab）← `openSidebarFile` 用 `resolveAddressPath` 把地址折成 base 的分隔符风格（`src/client/address-base.ts:72-77`，Windows base 有 `\` → `C:\repo\x.ipynb`）；host fs-tree 用 `node:path` 原生 `sep`（`src/fs-tree.ts:21,173,190`）。② 动态：用导出的真实函数 `__test.normalizePosix`/`__test.dirnamePosix` 按 954 行表达式计算：cwd=`C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb`、path=`C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb\examples\demo.ipynb` → `actualBase = C:/Users/kexio/Desktop/GitHub/dsh-bsb-ipynb/C:/Users/kexio/Desktop/GitHub/dsh-bsb-ipynb/examples`（期望 `…/dsh-bsb-ipynb/examples`）；相对图片最终 `path = C:/…/dsh-bsb-ipynb/C:/…/dsh-bsb-ipynb/examples/images/plot.png` → better-sidebar `/sidebar/file` 路由按绝对路径解析（`src/index.ts:1813-1842`，`ensureWorkspacePath` 后 stat）→ ENOENT/404。③ `attachment:`、`data:`、`http(s):` 图片不经该分支，不受影响；REPL 的 PNG/JPEG/SVG 输出是 data URL，也不受影响。 | 在 `client.js` 内实现与 better-sidebar 同语义的绝对路径判断（照 `src/client/paths.ts:23-28`：`/`、`^[A-Za-z]:[\\/]`、`^[\\\\/]{2}`、`~`），绝对路径直接 `dirnamePosix(normalizePosix(path))`，不要拼 `scope.cwd`；更彻底的做法是镜像 better-sidebar 自己的 `markdown-images.ts`（`normalizeLocalPath`@38-51 + `/sidebar/file` 三参数 @94-96），保证与宿主同一种规范拼写。 | 【已验证（纯函数驱动）】+【契约核对】 |
| **W-C4** | P3（Low） | `client.js:147-166`（`sanitizeUrl`），`164-165` 的 `^[a-z][a-z0-9+.-]*:` 判定 | Markdown/HTML 里出现绝对 Windows 路径图片或链接：`![](C:\pics\a.png)`、`<img src="C:/pics/a.png">` | `C:\…`/`C:/…` 以 `C:` 命中 scheme 正则 → 返回 `null`，图片/链接被静默丢弃。better-sidebar 的对照实现明确把盘符路径排除在 remote URL 之外（`src/client/markdown-images.ts:26-28` `isRemoteUrl` 用 `!/^[A-Za-z]:[\\/]/.test(dest)`）。 | `sanitizeUrl` 先判盘符/UNC → 交给本地图片 resolver，而不是当 URL scheme 拒绝；与 W-C3 一并修。 | 【已验证（静态+函数语义）】+【契约核对】 |
| **W-C5** | P3（Low） | `client.js:62`（en `shortcuts`）、`117`（zh）、渲染 `2189`（每个 notebook 底部常驻 `.dsh-bsb-ipynb-shortcuts`） | 所有 Windows 用户（尤其 DSH 中文界面） | 文案固定 `Ctrl/Cmd+Enter …`，Windows 上始终显示 Cmd；全文无 `navigator.platform`/`userAgent`/`dataset.platform`（grep 0 命中）。DSH 0.2.2-rc.1 的 `@deepseek-ai/dsh-client-shortcuts` 提供 profile 级默认绑定（`desktop:windows`/`web:windows`…）、`primary` 自动展开为设备控制键、`presentBinding` 在 macOS 用 ⌘ 符号、Windows 用 `Ctrl+A` 形式；DSH 主题 CSS 另有 `html[data-platform=darwin]` 钩子。 | 最小改动：按平台选择 `shortcuts` 文案（或拆 en/zh × mac/win 四条）；目标态：把 5 个快捷键注册到 DSH `ctx.shortcuts`（同时解决 L-21 与用户改键/冲突检测），见 §5 W-I6。 | 【已验证（静态）】+【契约核对（DSH shortcuts 包）】 |
| **W-C6** | P3（Low/Nit） | `client.js:1235-1245`（Tab 分支） | 编辑单元格时按 Tab | `preventDefault()` 并插入 4 空格，无 Shift+Tab 反缩进，也无 Tab 焦点逃逸；键盘用户无法用 Tab 离开 textarea（Windows 高对比度/键盘导航场景）。 | 文档说明；或 Shift+Tab 反缩进、Ctrl+Tab 放行焦点；非本次必须。 | 【已验证（静态+驱动）】 |
| **W-C7** | P3（Low） | `client.js:573-596`（`highlightPython`，正则 `575` 的 `#[^\n]*` 未归一化 CRLF）；对照 `323` `renderMarkdown` 有 `.replace(/\r\n?/g,'\n')`；保存 `888` `source.split(/(?<=\n)/)` | notebook 的 **source 字符串里含真实 `\r\n`**（JSON 中写作 `\\r\\n`）。正常 Jupyter/nbformat 产出不会（新行在 JSON 字符串里是 `\n`）；仅手写/脚本生成/部分 Windows 工具会产生。本仓库 `examples/demo.ipynb` 的 7 个 cell source 已核对无 `\r`（但工作树文件本身因 `core.autocrlf` 是 CRLF，不影响 JSON 字符串内容）。 | Node 驱动：LF 输入 `# note` → `<span class="…tok-comment"># note</span>\n`；CRLF 输入 → `<span class="…tok-comment"># note\r</span>\n`。`\r` 在 span 内、`\n` 在 span 外，HTML 解析的换行预处理把二者都归一为 LF → 注释行后多出一个空行（代码显示多空行）。保存侧 `split(/(?<=\n)/)` 会保留 `\r\n` 分片，而 textarea 编辑后浏览器把 value 归一为 LF → 同一 cell 混用行尾、整本文件 EOL 混合。 | 读入/渲染前对 source 做 `replace(/\r\n?/g,'\n')`；保存时按 cell 归一（避免混合 EOL）；补一条 CRLF fixture 的显示/保存回归。 | 【已验证（函数级）】+【契约核对（HTML 换行预处理）】 |
| **W-C8** | P3（Low，信息） | `client.js:471-558`（`ansiToHtml`，正则 `543` 只匹配 CSI SGR/其他 CSI；无 `\r`、无 OSC） | 见 §5 L-17 复核 | 与 Mac 审查一致；Windows 侧新增：Windows 下 tqdm/进度条同样用 `\r`，表现相同；ANSI 与平台无关；cp936 不影响输出链路（W-I8）。 | 同 L-17 建议：`\r` 行覆盖、丢弃 OSC（`\x1b]…\x07`/`\x1b]…\x1b\\`）。 | 【已验证（静态）】 |

---

## 4. 文档与平台声明问题（含具体行号与建议文案）

> 仓库行号以 HEAD 8c1ad8e 为准。凡是 Windows 上会误导用户/贡献者的地方都列了建议改法。

| ID | 严重级 | 位置 | 问题 | 建议（可直接采用） |
| --- | --- | --- | --- | --- |
| **W-D1** | P1（与 W-I3 联动） | `README.md:42-55`、`README_ZH.md:42-55`；同上 `README.md:36`/`README_ZH.md:36` 的解释器发现描述；`CONTRIBUTING.md:8-18`；`client.js:60/115` 的 `installHint` | Quick Start 给出的路径在 Windows 上不可用：`python3` 命令、`python3 -m pip install`，且未提示 Windows 当前解释器发现是 Unix 布局（见 W-I3）。用户照做会得到「未找到安装了 jupyter_client 和 ipykernel 的 Python 解释器」。 | ① 依赖表 Python 行改为 `python -c "import jupyter_client, ipykernel"`（macOS/Linux 用 `python3`，Windows 用 `py -3` 或 `python`）；② 安装命令拆两行：`python3 -m pip install jupyter_client ipykernel`（macOS/Linux）/ `py -3 -m pip install jupyter_client ipykernel`（Windows）；③ Quick Start 增加一条 Windows 注记：`Windows 目前需设置 DSH_IPYNB_PYTHON 指向装有 jupyter_client 与 ipykernel 的 python.exe（解释器发现的 Unix 布局问题修复前）`；④ `CONTRIBUTING.md:15,17` 同步拆 Windows 命令（`py -3 -m pip …`、`py -3 -m py_compile python/bridge.py`）。 |
| **W-D2** | P2 | `README.md:54`、`README_ZH.md:54` | 刷新页面写的是 `Cmd+R`（仅 macOS）；Windows 是 `Ctrl+R`/`F5`，且插件/宿主都提示改代码后应**硬刷新**。better-sidebar README 自己的写法是 `Cmd/Ctrl+Shift+R`（`README.md:45`）。 | `2. Refresh the page (\`Cmd+R\` on macOS; \`Ctrl+R\` or \`F5\` on Windows; hard-refresh with \`Ctrl/Cmd+Shift+R\` after client.js changes).` / 中文对应。 |
| **W-D3** | P2 | `README.md:123-131`、`README_ZH.md:123-131`（Known Limitations） | 完全没有 Windows 条目。Windows 用户会遇到：解释器发现为空（W-I3）、相对 Markdown 图片裂图（W-C3）、HTML 输出图片不解析（L-16/W-C4）、非编辑态 Ctrl+S 触发浏览器保存（L-21）。 | 新增 3–4 条，见下方"建议追加文案"。 |
| **W-D4** | P2 | `README.md:156`、`README_ZH.md:156`、`CONTRIBUTING.md:21-24`、`test/control-symlink.test.mjs:52,64,56,68` | "~28 个大小写用例只在大小写不敏感文件系统（如 macOS APFS）运行"：**Windows NTFS 默认也大小写不敏感**，这些用例在 Windows 上会进入运行分支；但用例要先 `symlink()`（`control-symlink.test.mjs:56,68`，无 try/catch），Windows 非管理员/未开开发者模式时直接 EPERM **失败**而不是跳过。 | 文档改为：`大小写回归用例在大小写不敏感文件系统（macOS APFS、Windows NTFS）上运行；Windows 需要开发者模式或管理员权限才能创建符号链接，否则这些用例会因 EPERM 跳过/失败`。测试侧建议：`symlink` 包 try/catch，EPERM/EINVAL 时 `t.skip('需要 symlink 权限（Windows 开发者模式/管理员）')`。 |
| **W-D5** | P2 | `.github/workflows/test.yml:18-19`（`runs-on: ubuntu-latest`）、`:41-44`（`node --check index.js lib/*.js client.js`） | 只在 Ubuntu 测过；`node --check index.js lib/*.js client.js` 依赖 shell 展开 glob，Windows 的 cmd.exe / PowerShell **都不会**为原生命令展开通配符 → 直接照搬到 Windows runner 会失败。better-sidebar 自己有 Windows CI 与 `test:windows` 脚本，本插件没有。 | 增加 `windows-latest` job（推荐 `defaults.run.shell: bash`，复用现有命令，Git Bash 会展开 glob；或用 pwsh 逐文件循环），片段见 §7。 |
| **W-D6** | P3 | `package.json:6-9`（`engines`）、无 `os` 字段 | `engines.dsh` 是自定义字段，npm/pnpm 不做校验（本机 plugin-manager 安装日志只有 peer 警告，没有 engines 拒绝）；没有 `os` 限制意味着插件在 Windows 上"名义可用"，但当前解释器发现不可用（L-14）。 | 不建议加 `os` 限制（会挡住 Windows 用户）；建议 README 增加"平台支持矩阵"：macOS 每日验证 / Windows best-effort + 已知限制 / Linux 未验证；把 W-I3 的 Windows 修复状态写清楚。 |
| **W-D7** | P3 | `.github/ISSUE_TEMPLATE/bug_report.yml`（`Versions` 的 placeholder 为 `macOS, Node 24, Python 3.14`） | 示例只写 macOS；IME/快捷键类 issue 需要输入法、浏览器、是否 DSH Desktop、Windows build 等信息。 | 占位符改成多平台示例（`Windows 11 24H2 / macOS 15, Node 24, Python 3.12`），模板增加一行"输入法 / 浏览器（如 微软拼音 + Edge 156；DSH Desktop 还是浏览器版）"。 |
| **W-D8** | P3 | 仓库根无 `.gitattributes`；本机 `core.autocrlf=true` 导致 `i/lf w/crlf` | Windows 工作树全为 CRLF（含 `client.js`、`examples/demo.ipynb`）。当前 JS/JSON 解析不受影响，但会污染 diff、让未来基于 fixture 的字节断言不稳定；本次审查的 CRLF 渲染缺陷（W-C7）也说明行尾值得固定。 | 新增 `.gitattributes`：`* text=auto eol=lf`、`*.ipynb text eol=lf`、`*.png binary`、`*.svg text`。 |
| **W-D9** | P3 | `README.md:148`、`README_ZH.md:148`（"DSH 会缓存已注册的 bundle…重载插件"） | 未说明"硬刷新"这一实际步骤（client.js 改动后仅重载插件仍可能是旧 bundle 缓存；better-sidebar 文档反复强调 hard refresh）。 | 补一句：`修改 client.js 后重载插件并硬刷新页面（Ctrl/Cmd+Shift+R）`。 |
| **W-D10** | Nit | `locale/en.json`、`locale/zh.json` 只有 `meta.title/description`；UI 词典实际内联在 `client.js:15-126` | README:37 的"UI strings 注册在 dsh-bsb-ipynb locale 命名空间"说法准确（`client.js:2428-2444` 用 `hostLocale.register(LOCALE_NS,'en',STRINGS.en)` 注册），但维护者可能误以为改 `locale/*.json` 就能改 UI。 | 在 CONTRIBUTING 注明"UI 词典在 client.js 的 STRINGS；locale/*.json 只提供插件市场元数据"。 |

**建议追加到 Known Limitations 的文案（README.md 英文版）**

```md
- **Windows**: interpreter discovery currently builds Unix-layout candidates (`python3`/`python` without `.exe`, `<conda-env>/bin/python`, DSH bundled `…/python/bin/python3`), so a default Windows install finds no interpreter. Until this is fixed, set `DSH_IPYNB_PYTHON` to a `python.exe` that has `jupyter_client` and `ipykernel`.
- Windows absolute notebook paths (`C:\…\x.ipynb`) are not recognized by the Markdown image resolver yet, so relative images in Markdown cells resolve to a doubled path and fail; `attachment:` and `data:`/`http(s)` images are unaffected.
- Images inside `text/html` output are not re-resolved through the attachment/relative resolver and render broken.
- Shortcuts only work while a cell is being edited. In a browser, `Ctrl+S` outside edit mode triggers the browser's Save Page dialog.
```

README_ZH 对应中文版：

```md
- **Windows**：解释器发现目前按 Unix 布局构造候选（无 `.exe` 的 `python3`/`python`、`<conda-env>/bin/python`、DSH 内置 `…/python/bin/python3`），默认 Windows 安装下发现不到解释器；修复前请把 `DSH_IPYNB_PYTHON` 指向装有 `jupyter_client` 与 `ipykernel` 的 `python.exe`。
- Windows 绝对路径 notebook（`C:\…\x.ipynb`）尚未被 Markdown 图片解析识别，Markdown 单元格里的相对图片会拼出重复路径而裂图；`attachment:` 与 `data:`/`http(s)` 图片不受影响。
- `text/html` 输出里的图片不会经过附件/相对路径解析，会裂图。
- 快捷键仅在编辑单元格时生效；浏览器版在非编辑态按 `Ctrl+S` 会触发浏览器"保存网页"。
```

---

## 5. Mac 审查条目在 Windows 下的复核

| 条目 | Windows 下结论 | 证据 / 差异 | 本域补充建议 | 证据等级 |
| --- | --- | --- | --- | --- |
| **M-7**（工作区根不跟随 better-sidebar 活动 worktree） | **成立，且 Windows 上同样 403**；Windows 不引入新的缓解。 | `lib/gate.js:16-53` 仍只认 `ctx.get('workingDirectory').get(session)`/`session.header.cwd`（DSH 0.2.2-rc.1 确实带 `@deepseek-ai/dsh-working-directory` 包，该 fallback 生效），而 better-sidebar 所有文件/Git 路由用 `activeWorktreeRootOf(ctx, sessionId, await sessionCwdOf(…))`（`src/index.ts:724-742`，以及 `/sidebar/upload`@1717、`/sidebar/write`@1754、`/sidebar/file`@1832），文件树根同理（`src/active-worktree.ts:466`）。Windows 额外事实：① `path.win32.relative` 大小写不敏感，`path.win32.relative('C:\\Repo','c:\\repo\\a.ipynb')==='a.ipynb'`（实测）→ 大小写差异不会造成误判 403；② 跨盘 worktree（如 `D:\wt`）时 `path.relative` 返回绝对路径 → `isInside` 拒绝（fail-closed，行为正确但同样是 403）；③ 本机 junction 的 `fs.readlink` 返回普通绝对路径（实测 `C:\Users\kexio\Desktop\GitHub\dsh-bsb-ipynb`），未见 `\\?\` 前缀，`walkTarget` 的 junction 分支本轮未被触发。 | 主修复按 M-7 原建议（活动根集合）；Windows 侧在 README 已知限制里补一句"Windows linked worktree 同样返回 403"。 | 【契约核对】+【已验证（win32 path 语义/本机 junction）】 |
| **M-9**（硬编码颜色未 token 化） | **成立**；Windows 侧新增两点：① DSH 0.2.2-rc.1 仍然注入 `body[data-ds-dark-theme]`（`dsh-client-ui-theme/lib/index.js` 内 `document.body.toggleAttribute('data-ds-dark-theme', dark)`），所以插件 `body[data-ds-dark-theme] …` 选择器在 Windows 上与 macOS 一样有效；② **字号 token 未消费**：DSH theme 在 `<body>` 上设置 `--dsh-content-font-size`、`--dsh-code-font-size` 等（theme README 明示），而插件把 13/12/11/10px 写死（`client.js:2206,2314,2374-2383,2397`），DSH 的字号设置（本机 profile `ui-theme` 配了 `fontSize:18`）与 Windows 125%/150% 缩放都不会作用于 notebook。 | 原建议不变（状态/语法色消费 `--dsw-alias-*`）；追加：代码/正文/工具栏字号改用 `var(--dsh-code-font-size, 12px)` / `var(--dsh-content-font-size, 13px)`。 | 除原建议外，加一条"字号 token 化"，并把 Windows 150% 缩放列入视觉复验矩阵。 | 【契约核对（theme 契约）】+【已验证（静态）】 |
| **L-15**（语言热切换 banner 不重译） | **成立，平台无关**；Windows 中文用户是主要受影响人群（DSH 语言跟随系统/浏览器；本机语言列表中文优先）。locale 绑定契约本身正确（`register(NS,'en',dict)`/`bind(NS)`/`getSnapshot().revision` 与 `dsh-client-locale` README 一致，见 W-I6），问题只在 banner 存了已翻译 `text`：`client.js:1395-1411` 只渲染 `banner.text`，写入点如 `1526,1576,1587,1598,1606,1608,1658,1660,1761,1814,1831,1837,1889,1901,1903,1945,1956,1959`。 | 按原建议 banner 存 `{key,params,kind,action}` 渲染时 `t()`；Windows 侧无需额外差异。 | 修 banner 存储结构；可用 Windows 中文界面切 en/zh 做人工回归（本机即可）。 | 【契约核对 + 静态】 |
| **L-16**（HTML 输出图片不经 resolveImage） | **成立**；Windows 上**叠加 W-C3/W-C4 更糟**：即使把 `resolveImage` 接到 HTML 分支，`<img src="C:\…">` 还会先被 `sanitizeUrl` 当 scheme 丢弃（`client.js:147-166`）。 | `client.js:1150-1157` HTML 分支直接 `sanitizeHtml(html)`；只有 `text/markdown` 分支用 `renderMarkdownWithImages(..., resolveImage)`（`1166-1173`）。 | 修 L-16 时先修 W-C3/W-C4，再对清洗后的 DOM 内 `img[src]` 做 resolveImage 改写。 | 【已验证（静态）】 |
| **L-17**（ANSI `\r`/OSC 不完整） | **成立**；Windows 表现一致（Windows 控制台程序/tqdm 同样用 `\r` 画进度条；ipykernel 输出经 JSON 字符串到达，cp936 不影响）。 | `client.js:471-558`，正则 `543` 不匹配 `\r` 与 OSC；`\r` 进入 `dangerouslySetInnerHTML` 后按 HTML 换行预处理变成 LF（进度条变多行垃圾）。 | 按原建议实现 `\r` 行覆盖 + OSC 丢弃；可顺带在 `ansiToHtml` 入口做 `\r\n`→`\n` 归一。 | 【已验证（静态）】 |
| **L-21**（快捷键只在编辑 textarea 生效） | **成立，且浏览器侧 Windows 后果更明显**：非编辑态在 Chrome/Edge 按 `Ctrl+S` 不再被插件 `preventDefault`，会打开浏览器"保存网页"对话框；`Ctrl+Enter`/`Shift+Enter` 无默认冲突但无效。DSH Desktop（Electron）无 save-page 默认行为，影响较小。 | 全文无 `window/document.addEventListener`（0 处）；handlers 只在 `client.js:1218-1246`，React 合成事件挂在 textarea；DSH 0.2.2-rc.1 自带 `@deepseek-ai/dsh-client-shortcuts`（per-profile 默认绑定 + 平台化 keycap + 冲突检测 + Desktop 原生键盘桥），注释模式见 W-C5。 | 加全局监听（编辑态复用现有逻辑）；目标态接入 DSH `ctx.shortcuts`，把 `Ctrl+Enter/Ctrl+S` 等注册为命令（可解决用户改键与 Alt/Ctrl 冲突）。 | 【已验证（静态）】+【契约核对】 |
| **T-1**（HTML 清洗器零真实行为测试） | **成立**；Windows 侧建议补充与路径相关的清洗用例，正好覆盖 W-C4/L-16 类缺陷。 | `client.js:183-233`；现测试只覆盖 fallback（见 CODE_REVIEW T-1）。 | 用最小 DOM（或 jsdom）驱动真实分支，追加：`<img src="C:\…">`、`file:///C:/…`、UNC `\\server\share`、`attachment:`、`javascript:`（大小写/控制字符）与 `target/rel` 覆写断言。 | 【已验证（静态）】 |
| **T-3**（客户端主交互缺测试） | **成立**；Windows 侧需补以下可离线回归（现有 vm harness 足够，本报告已用其驱动 `CellView`）： | 见 W-C1/W-C2 的驱动结果。 | 新增用例：① composition（`isComposing:true` / `keyCode:229`）× 5 快捷键不触发；② CapsLock `{key:'S'}` Ctrl+S；③ `makeImageResolver` 对 `C:\repo\x.ipynb` + 相对图片 → 期望 `C:/repo/images/...`；④ CRLF source 的 `highlightPython` 输出无 `\r`（或显示单换行）。 | 【已验证（驱动可行性）】 |

---

## 6. DSH / better-sidebar 集成核对

| ID | 核对项 | 结论 | 证据 |
| --- | --- | --- | --- |
| **W-I1** | 版本匹配（`package.json:8` `engines.dsh: >=0.2.2-rc.1`） | **匹配**：桌面版实际 0.2.2-rc.1（exe FileVersion、app.asar 内 `@deepseek-ai/dsh-desktop`、`/dsh/desktop-runtime.json` 的 `release.version` 与 `sharedPackages.@deepseek-ai/dsh` 全部 0.2.2-rc.1）。`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 的 `0.2.1-rc.3` 是 **2026-10-23 的旧缓存**，不是桌面应用版本，不能据此判定版本不满足；全局 npm dsh CLI 0.1.0-rc.6 是另一产品线。**结论：不存在版本不匹配导致的加载阻断。** | asar 头解析脚本（§9）；文件 mtime |
| **W-I2** | 插件是否被加载 | **live 安装成立、无安装期拒绝**：profile bundle 列表含 `dsh-bsb-ipynb`；依赖是 `link:` 指向仓库；`node_modules/dsh-bsb-ipynb` 为 Junction → 仓库（mtime 2026-11-07 16:07）；plugin-manager pnpm 日志记录 `+ dsh-bsb-ipynb 0.1.0 <- …\Desktop\GitHub\dsh-bsb-ipynb`（同日 16:07），无引擎/peer 致命错误（只有通用 peer 警告）；profile `cordis.patch.yml` 未禁用该插件。**未能**：找到 DSH 运行日志确认 boot 成功（`~/.dsh` 下只有插件管理 pnpm 日志与 skill 日志，无 host/runtime 日志）；GUI 401 且无法用浏览器 DevTools，故未能确认 UI 里实际渲染。 | 文件/日志读取；HTTP 401 |
| **W-I3** | 解释器发现在 Windows 失败（**跨域，主责 win-host / L-14**） | 在**本机真实环境**逐项构造 `lib/env.js` 候选并做文件系统检查：`findOnPath(['python3','python'])`（`lib/env.js:64-76,126`）只 `path.join(dir,'python3'/'python')`，不带 `.exe`/PATHEXT → **0 个存在**（真实存在的是 `C:\Python314\python.exe`、`C:\Users\kexio\miniconda3\python.exe`）；`condaEnvironments()`（`78-99`）查 `<env>/bin/python3` 或 `<env>/bin/python` → `C:\Users\kexio\miniconda3\bin\python*` 不存在（真实 `C:\Users\kexio\miniconda3\python.exe`）；内置 Python（`129-148`）查 `<runtime>/dependencies/python/bin/python3` → 不存在（真实布局 `<runtime>\dependencies\python\python.exe`，已确认 3.12.14）。因而 `collectCandidates()→[]`，`discoverUncached()` 得 `interpreters:[]、default:null` → `/execute` 走 `resolveInterpreter` 抛 503 `kernel-unavailable`（`lib/env.js:294-300`）；即使找到内置 Python，其 `site-packages` 也没有 jupyter 包。客户端表现：解释器 select 显示 `kernelUnavailable`（`client.js:1370-1375`），运行失败 banner 显示 `kernelUnavailable + installHint`（`client.js:1900-1901`，文案 `59/114`）。**临时可用路径**：设置 `DSH_IPYNB_PYTHON` 指向装有 jupyter_client/ipykernel 的 `python.exe`（`lib/env.js:120-122` 会保留该候选）。 | 【已验证（真实文件系统候选检查；未实际执行 spawn 探测——沙箱禁止 pipe spawn）】 |
| **W-I4** | better-sidebar → viewer 的 path/scope 契约 | `path` = **原生反斜杠绝对路径**（`C:\…\x.ipynb`），`scope = { sessionId, cwd }`（`SessionScope`，`cwd` 为 Windows 原生路径）。这是 W-C3 的根因。 | 见 W-C3 的契约链（`service.ts:306-310,414`；`EditorHost.tsx:524-525`；`address-base.ts:72-77`；`fs-tree.ts:21,173,190`；`session-scope.ts:27-34`）。 |
| **W-I5** | 宿主 `webServer` 契约（`index.js:11,13-16` + `lib/routes.js`） | 与本机 DSH 0.2.2-rc.1 + better-sidebar 0.30.1 一致：better-sidebar 自身也用 `ctx.webServer.register({ kind: 'exact' 或 'prefix', path, handler })`（`src/index.ts:1697-1729、1735-1772、1788-1810、1813-1869`）。插件 `inject: ['webServer','sessions','connection']`，路由挂 `/ipynb/*`，客户端 `hostRouteUrl('ipynb/'+method)`（`client.js:620-622`）拼成绝对 URL。**未发现 webServer 路由注册的平台差异**；路径处理在插件侧走 `node:path`（`lib/gate.js:11-14,55-62,92-93`），Windows 语义已核对（`path.win32.relative` 大小写不敏感、跨盘 fail-closed）。 | 【契约核对】 |
| **W-I6** | DSH locale / theme / shortcuts 三类客户端契约 | ① locale：`dsh-client-locale` README 的 `register(ns,{zh,en})`/`bind(ns)`/`LocaleRuntime getSnapshot/subscribe + revision` 与 `client.js:2415-2444` 的 `register(NS,'en'/'zh',dict)`、`bind(NS)`、`subscribe/getSnapshot().revision` 一致 → 中文界面跟随宿主语言，无契约问题。② theme：`body[data-ds-dark-theme]` 在 0.2.2-rc.1 仍由 `dsh-client-ui-theme` 注入（见 M-9 复核）；另有 `html[data-platform=…]`。③ shortcuts：`@deepseek-ai/dsh-client-shortcuts` 提供 feature plugin 的 `ctx.shortcuts` 注册、`desktop:windows`/`web:windows` 默认绑定、`primary`→设备控制键展开、`presentBinding` 平台化 keycap（macOS ⌘/Windows "Ctrl+A"），Desktop 在 Windows/macOS 由原生键盘桥派发可配置命令 → 推荐的键盘改造目标（见 W-C5/L-21）。 | 【契约核对（asar 内 README/lib）】 |
| **W-I7** | 中文 IME 与宿主 IME guard | better-sidebar 0.30.1 在 client `apply` 最早注册 document 捕获阶段 IME guard（`src/client/index.tsx:446-464`，`src/client/ime-guard.ts:76-117`），对 composition 中的 keydown/keyup `stopPropagation`；安装版 `lib/client.js` 也含 `compositionstart` 监听。插件只有 React textarea handler，事件到不了它 → 真实组合下误触发概率低（见 W-C1 的三点注意）。 | 【契约核对】 |
| **W-I8** | cp936 系统上的输出编码（正向核对） | 内核输出**不经过** GBK 解码：`lib/kernel.js:94-100` spawn bridge 时注入 `PYTHONIOENCODING='utf-8'`，`python/bridge.py:66-68` 把 stdin/stdout/stderr `reconfigure(encoding='utf-8')`；ipykernel 继承 bridge 的 env。因此 Windows 中文系统下 `print('中文')` 不会因 ACP=936 变乱码（本轮未实际执行内核，属代码路径核对；win-tests 的真实内核用例会覆盖）。 | 【契约核对（代码路径）】 |
| **W-I9** | 其它 Windows 集成观察 | ① `lib/kernel.js` 用 `spawn(...)` 启动 bridge，Windows 下 `.exe` 路径可工作；但 `SIGTERM`/`SIGKILL` 在 Windows 上是强制终止语义（bridge 无法拦截 SIGTERM 做优雅清理），且杀 bridge 不保证连带杀掉 ipykernel 子进程 → 可能留孤儿 `python.exe`（属 kernel 生命周期域，交 win-host/win-tests 复核，本域仅提示）。② `client.js` 的 `imageSource`/`attachment:` 走 data URL，Windows 正常。③ `examples/demo.ipynb` 的 7 个 cell source 无 `\r`（已核对），其 JSON 文件在工作树是 CRLF 但仅格式层面。 | 【推测/契约核对】 |

---

## 7. 建议的 Windows CI 片段

现状：`.github/workflows/test.yml` 只有一个 `test` job（`ubuntu-latest`，Node 22 / Python 3.12，安装 jupyter 依赖后跑 `npm test`）。建议增加（保留原 job 不变）：

```yaml
  test-windows:
    runs-on: windows-latest
    timeout-minutes: 20
    defaults:
      run:
        shell: bash   # Git Bash 会展开 lib/*.js 等 glob；cmd/pwsh 不会为原生命令展开
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install kernel dependencies
        run: |
          python -m pip install --upgrade pip
          python -m pip install jupyter_client ipykernel nbformat
          echo "DSH_IPYNB_TEST_PYTHON=$(python -c 'import sys; print(sys.executable)')" >> "$GITHUB_ENV"

      - name: Static checks
        run: |
          node --check index.js lib/*.js client.js
          python -m py_compile python/bridge.py

      - name: Run tests
        run: npm test

      - name: Check package contents
        run: npm pack --dry-run
```

注意事项（写进 PR 说明/注释）：

1. **`node --check index.js lib/*.js client.js` 不能照搬到 pwsh/cmd**：PowerShell 与 cmd 不向原生命令展开通配符。用 `shell: bash`（Git Bash），或 pwsh 下写成 `node --check index.js; Get-ChildItem lib -Filter *.js | ForEach-Object { node --check $_.FullName }; node --check client.js`。
2. **`npm test` 的 `test/*.test.mjs`**：Windows cmd 也不展开，但 Node 21+ 的 test runner 原生支持 glob，Node 22/24 应可用——由 win-tests 实测确认。
3. **symlink 权限**：`test/control-symlink.test.mjs` 会 `symlink()`；Windows 需要开发者模式或管理员。GitHub `windows-latest` runner 通常可以，但建议测试对 `EPERM`/`EINVAL` 做 `t.skip`（与"大小写测试只在大小写不敏感 FS 运行"的说明一起更新）。
4. **换行**：Windows runner 的 checkout 若受 `core.autocrlf` 影响，测试对字节/换行敏感的部分可能不稳；建议仓库加 `.gitattributes`（`* text=auto eol=lf`、`*.ipynb text eol=lf`），必要时 CI 显式 `git config core.autocrlf false`。
5. 建议在该 job 之后加一个**跳过检查**：解析 `node --test` 的 `# skipped` 行，Windows 上允许控制符号链接用例跳过，但不允许真实内核用例意外跳过（与 README:156 的 CI 建议一致）。

---

## 8. 未能验证事项（明确标注，勿当作已验证）

1. **真实浏览器 DOM/视觉**：未在 Chrome/Edge 中打开 DSH GUI（`/` 401 且无可用凭据/DevTools），未做截图、对比度、字体（`⏻`/`⌫`/`↻` 字形在 Windows 字体下的回退）验证。M-9 的视觉结论沿用 CODE_REVIEW 的"未复验"。
2. **真实中文 IME 敲字**：未用微软拼音/搜狗实际输入并观察事件序列；W-C1 中"宿主 guard 会拦下 composition 键"是**契约 + 推理**（better-sidebar 捕获阶段 `stopPropagation` + React 18 root 委托），未在 Windows 浏览器实测；W-C1 的"插件 handler 在 composition 事件下会触发"是 Node 驱动结论，不等价于浏览器事件序列。
3. **插件在 UI 中实际加载/可用**：401 阻断 HTTP 验证；未找到 DSH host/boot 日志；只能证明 live 安装与 profile 挂载（W-I2）。
4. **解释器发现未实际执行**：沙箱禁止 pipe 子进程，未跑 `discoverInterpreters()`；W-I3 是"按代码构造候选 + 对真实文件系统逐项检查"的结论（spawn 探测另需 win-tests/Lead 全权限代跑）。
5. **linked git worktree 端到端**：Windows 下未建真实 linked worktree 会话复现 M-7 的 403；结论来自契约核对。
6. **Windows 上 `npm test` / symlink / Node glob**：未运行（win-tests 负责）；Windows CI 片段未实际跑过。
7. **`ctx.shortcuts` 具体注册方法签名**：只核对到 DSH shortcuts 包的 README/lib 契约（`ctx.shortcuts`、per-profile defaults、`presentBinding`、`primary` 展开），未取到完整方法名/调用示例，接入前需按该包 README 再核对。
8. **内核 SIGTERM/孤儿进程**：Windows 上 `spawn` + 信号/子进程回收行为未实测（W-I9 标注为跨域提示）。
9. **DSH 是否校验 `engines.dsh`**：未取到加载器实现；本机版本恰好满足 `>=0.2.2-rc.1`，不影响结论。

---

## 9. 复现脚本索引（只读仓库，脚本在 `%TEMP%\dsh-win-review\win-client\`，未入库）

| 脚本 | 用途 / 关键命令 |
| --- | --- |
| `asar-read.mjs <asar> <entry> [maxLen]` | 读 `app.asar` 单条目：`node asar-read.mjs "C:\Users\kexio\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" /package.json` → `@deepseek-ai/dsh-desktop 0.2.2-rc.1`；`/dsh/desktop-runtime.json` → `release.version 0.2.2-rc.1`。asar 头：u32@0=4，u32@4=headerSize，JSON 从 offset 16 起，payloadOffset=8+headerSize。 |
| `asar-extract.mjs` / `asar-extract-dir.mjs` / `asar-grep.mjs` | 从 asar 只读提取/检索 DSH 包（theme `data-ds-dark-theme`、locale API、shortcuts README、util-workspace-path 等）。 |
| `client-probe.mjs` | 用仓库 `test/client.test.mjs` 同款 vm harness（stub React/DOM）加载 `client.js`，真调 `__test.CellView` 的 `onKeyDown`、`__test.highlightPython`、`__test.renderMarkdown`、`__test.normalizePosix/dirnamePosix`。命令：`node client-probe.mjs`。输出即 W-C1/W-C2/W-C3/W-C7 的证据。 |
| `env-candidates.mjs` | 按 `lib/env.js` 的候选构造逻辑对真实 Windows 文件系统逐项检查（PATH 无扩展名、conda `bin/`、bundled `…/bin/python3`），输出 W-I3 的 0 候选证据。命令：`node env-candidates.mjs`。 |
| 只读 shell 证据 | `where.exe python/python3/py`；`Get-WinUserLanguageList`；`git ls-files --eol`；`netstat -ano`（配合 `Select-String ':56606'`）；`Invoke-WebRequest http://127.0.0.1:56606/`（401）。 |

> 本轮未运行 `npm test`（win-tests 负责）；未修改仓库任何源码/测试/README。工作树中除本文件外，`docs/windows-review/` 其他文件与 `CODE_REVIEW_WINDOWS.md` 来自其他队友，不在本域写入范围。
