# dsh-bsb-ipynb

在 [DSH Better Sidebar](https://github.com/dong-victor/dsh-better-sidebar) 的侧边栏里直接预览、编辑并执行 Jupyter Notebook（`.ipynb`）。

插件通过 `ctx.betterSidebar.registerFileViewer` 注册一个 `.ipynb` 文件查看器（`priority: 10`，高于内置代码查看器的 `-100`），因此点击右侧文件树里的 notebook 就会进入笔记本界面；执行能力由宿主进程里的 Python 内核提供，使用 `jupyter_client` + `ipykernel` 与 `python/bridge.py` 通信。

## 功能

- Notebook 渲染：Markdown、代码、raw cell，执行计数，流式 stdout/stderr、`text/html`、`image/png|jpeg|svg`、`text/markdown`、JSON、ANSI 彩色 traceback。
- 编辑：点击 cell 进入编辑（语法高亮预览 → 文本编辑），支持增删、上移/下移、切换 cell 类型、Markdown 预览、清空单个或全部 cell 的输出。
- 执行：每个 notebook 一个持久 Python 内核（按文件路径共享），变量跨 cell 保留；Run all、中断、重启、关闭。
- 保存：写回 nbformat 4.5，保存前做基础字段规范化（例如移除 `display_data.execution_count`、过滤非法 MIME 数据和附件结构、修正非法执行计数），未进行完整 schema 校验；用 sha256 版本号做乐观并发控制，读取前检测到的外部修改返回 409 冲突而不覆盖（校验到原子 rename 之间的外部写入属已知竞态），磁盘文件超过 32 MiB 返回 413；保存前按落盘格式预检整本大小，超限时提示清空输出而不是上传后被拒；编辑后 1.5 秒自动保存。
- 解释器：自动发现 `DSH_IPYNB_PYTHON`、conda 环境、PATH 上的 `python3`/`python`、DSH 内置 Python；只有带 `jupyter_client` + `ipykernel` 的环境会被选中。
- 安全：所有文件访问都限制在会话工作区内（realpath + `path.relative` 检查）；HTTP 路由复用 DSH 的 admission fence（`ctx.connection.requestRejection`）；内核输出 HTML 经 DOMParser 白名单清洗后才渲染，不执行 `<script>`。

## 前置条件

- DSH Web GUI **0.2.2-rc.1** 或更新版本。
- **dsh-better-sidebar >= 0.28.0**（推荐当前 0.28.2）。
- 一个带 `jupyter_client` 与 `ipykernel` 的 Python：

  ```bash
  python3 -c "import jupyter_client, ipykernel"
  # 若失败：
  python3 -m pip install jupyter_client ipykernel
  ```

  插件会优先使用 `DSH_IPYNB_PYTHON` 指定的解释器；没有设置时按 conda 环境、PATH、DSH 内置 Python 的顺序探测，并跳过缺少依赖的环境。

  内核首次启动和重启都直接使用所选 Python。插件在进程内构造启动配置，系统注册的同名 kernelspec 不会改变所选解释器，也不会被插件改写。

## 安装

在 DSH 的插件管理里把这个目录作为本地 bundle 安装：

```text
/path/to/dsh-bsb-ipynb
```

安装后刷新页面（桌面端 `Cmd+R`），在右侧文件树中打开任意 `.ipynb` 即可。`examples/demo.ipynb` 是一个可直接运行、且通过 `nbformat.validate` 校验的示例。

## 使用

| 操作 | 快捷键 |
| --- | --- |
| 运行当前 cell | `Cmd/Ctrl + Enter` |
| 运行并跳到下一个 cell | `Shift + Enter` |
| 在下方插入代码 cell | `Alt + Enter` |
| 保存 | `Cmd/Ctrl + S` |
| 退出编辑 | `Esc` |

工具栏提供解释器选择、Run all、中断、重启、保存、重新加载和关闭内核。切换解释器会重启内核（运行中会先确认）；API 返回的 409 冲突会在顶部显示，只允许重新加载，不会静默覆盖磁盘内容。

单元格执行或 Run all 期间，自动保存、保存按钮和保存快捷键均暂停，避免将临时清空或尚未完整的输出写入磁盘。执行结束后恢复保存；确认重新加载并成功读取新内容后，旧执行会取消，迟到的执行结果和保存响应不会覆盖新内容。

## 结构

```text
dsh-bsb-ipynb/
├── index.js              # 宿主插件入口（inject webServer/sessions/connection）
├── client.js             # 浏览器端手写单文件 bundle（window.__ModuleLoader__，无构建步骤）
├── lib/
│   ├── json.js           # JSON envelope、请求体读取、ApiError
│   ├── gate.js           # 会话工作区解析与路径逃逸防护
│   ├── notebook.js       # nbformat 4 解析/规范化/序列化、sha256 版本、原子写入
│   ├── env.js            # Python 解释器发现与探测
│   ├── kernel.js         # 每个 notebook 一个 bridge 进程、事件队列、空闲回收
│   └── routes.js         # /ipynb/* 路由
├── python/bridge.py      # jupyter_client + ipykernel 的 JSONL 内核桥
├── locale/{en,zh}.json
└── test/                 # node:test 单元/集成测试
```

## HTTP 接口

所有接口挂在 `/ipynb` 前缀下，返回 `{ok:true,value}` 或 `{ok:false,error:{code,message,details?}}`。POST 请求必须是 `application/json`；`/execute` 返回 `application/x-ndjson`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ipynb/health` | 版本、内核数、解释器统计（不阻塞解释器探测；未预热时 `interpreters.checked` 为 `false`，探测在后台进行） |
| GET | `/ipynb/interpreters` | 解释器列表与默认项 |
| GET | `/ipynb/status?sessionId=&path=` | 某个 notebook 的内核状态 |
| POST | `/ipynb/read` | 读取并解析 notebook（`{status:'ok'|'invalid'|'unsupported', notebook?, version, size, emptyFile?, error?}`） |
| POST | `/ipynb/save` | `{notebook, baseVersion}` 保存；版本过期返回 409 |
| POST | `/ipynb/execute` | `{cellId, code, python?}`，NDJSON 流式返回执行事件 |
| POST | `/ipynb/interrupt` | 中断当前执行 |
| POST | `/ipynb/restart` | 重启内核，可同时切换 `python` |
| POST | `/ipynb/shutdown` | 关闭内核 |

除 `/health` 与 `/interpreters` 外，上述接口都必须提供非空 `sessionId` 和 `path`：`/status` 通过查询参数提供，其余通过 JSON 请求体提供；缺失时返回 `bad-request`（400）。请求被宿主 admission fence 拒绝时返回 `forbidden`，HTTP 状态码由宿主拒绝结果决定（未提供时为 403）。

`/execute` 在写入 NDJSON 响应头之前失败（例如请求体、路径或解释器解析失败）时，仍返回上述 JSON 错误 envelope 和对应 HTTP 状态码；响应头写入后，内核启动或执行失败会返回 NDJSON 事件 `{type:'fatal',code,message}` 并结束流，不再改写 HTTP 状态或返回 JSON envelope。

错误码：`bad-request`、`forbidden`、`workspace-unknown`、`path-outside-root`、`not-found`、`not-notebook`、`too-large`、`write-conflict`、`write-failed`、`kernel-busy`、`kernel-unavailable`、`interpreter-unknown`、`method-not-allowed`、`internal`。

## 开发与测试

无需构建步骤，`client.js` 直接由 DSH 的模块加载器加载。

> 注意：宿主会缓存已注册的浏览器 bundle。修改 `client.js` 后，单纯刷新页面不会重新读取文件；需要重载 `dsh-bsb-ipynb` 插件或重启 DSH。宿主侧（`index.js`、`lib/`）修改同理。

```bash
node --check index.js lib/*.js client.js
python3 -m py_compile python/bridge.py
node --test --test-timeout=180000 test/*.test.mjs   # 或 npm test
```

`test/bridge.test.mjs`、`test/kernel-interpreter.test.mjs` 等真实内核测试会在所有候选解释器都缺少 `jupyter_client`/`ipykernel` 时自动跳过；notebook 的真实 schema 验证测试需要 `nbformat`，缺少时同样跳过。测试按 `DSH_IPYNB_TEST_PYTHON`、`/opt/miniconda3/bin/python3`、PATH 上的 `python3`/`python` 顺序探测；CI 等环境建议显式设置 `DSH_IPYNB_TEST_PYTHON`、确保依赖可用，并检查是否出现非预期跳过。解释器回归测试使用临时虚拟环境和冲突 kernelspec，验证启动、重启及环境切换。`test/control-symlink.test.mjs` 中约 28 个大小写回归用例只在大小写不敏感的文件系统（如 macOS APFS）上运行，其他平台会跳过。

## 可靠性

- 同一 notebook 的保存按路径串行化：并发保存只有第一个成功，其余返回 `write-conflict`（409），不会静默覆盖。
- 某个 cell 执行期间收到 restart、shutdown、内核崩溃或 `os._exit()` 时，NDJSON 流会收到一个失败终态并结束，不会永久挂起。
- 内核回复执行结果后，还会等待对应的 IOPub idle 确认输出接收完成；等待超过 10 秒时返回失败并提示输出可能不完整。重启或关闭内核唤醒该等待时，同样不会报告成功。
- notebook 删除后仍可通过原路径查询和控制已有内核；插件记录当前会话已解析路径的真实拼写，因此在大小写不敏感的文件系统上，通过不同大小写的路径或符号链接执行后也能继续控制原内核。恢复该记录前会重新检查工作区边界和路径组件身份，已删除、改写或重建的符号链接不会继承旧记录；文件重新存在时以当前真实路径为准。
- 服务端的 NDJSON 待发队列超过 64 MiB 时，立即触发取消和内核中断，并返回 `output-too-large` 错误。
- 执行时，客户端每个 cell 的输出按完整 JSON 的 UTF-8 字节计量，最多保留 32 MiB，包含 MIME 数据、metadata、错误信息和 traceback。新增、流合并和显示更新共用预算；超限后以提示替换输出并丢弃后续输出，直到明确清空或重新运行。`clear_output(wait=true)` 在下一条输出到达时清空并重置预算。保存前客户端按服务端落盘格式预计算整本 notebook 的字节数，超过 32 MiB 时不再上传并显示容量提示，可直接清空单个/全部 cell 输出；容量阻塞期间暂停自动保存重试，直到输出被清空、重新运行或重新加载。
- 服务端在读取和保存时做基础字段规范化：按 cell/output 类型保留支持的字段，执行计数仅接受非负整数或 `null`；输出和附件共用 MIME 数据校验，非 JSON MIME 值仅保留字符串或字符串数组，`application/json` 和 `application/*+json` 保留合法 JSON 值。非法 MIME 项和非对象附件项会被丢弃。此流程未进行完整的 nbformat schema 校验（例如 metadata 内部约束），不保证任意输入经规范化后都能通过完整校验。
- 保存前先 `stat` 磁盘文件：文件超过 32 MiB 时返回 `too-large`（413），不会先整体读入内存；序列化后的内容同样受 32 MiB 上限约束。
- 单行内核输出超过 64 MiB 时，本次执行会收到失败终态并重启内核，避免桥进程内存无限增长。
- 执行请求的发送和编号登记同步完成，早到的输出无需额外缓存；已完成或未知请求的迟到输出会被丢弃，不会积累在桥进程中，也不会混入其他单元格。
- 内核 stdin 写失败（EPIPE）会被捕获并清理当前执行，不会冒泡成宿主进程的 `uncaughtException`。

## 已知限制

- 仅支持 Python 内核（`nbformat` 4.x）。
- 不渲染需要 JavaScript 的交互输出（ipywidgets、plotly、bokeh 等）；HTML 输出会按白名单清洗成静态内容。
- 不支持 `input()`：内核以 `allow_stdin=False` 启动，调用会立即报错而不是挂起；`%%` cell magic 由 IPython 内核支持；`!cmd`、`%pip`、`%cd`、`%pwd` 可用。
- 中断后内核约 3 秒仍无响应时会强制重启，所有变量和其他内核状态都会被清空。
- 执行结果由客户端写回并在保存时落盘；服务端不会在后台追加输出。
- 当前没有“新建 notebook”向导，请在文件树里新建 `.ipynb` 空文件，或直接打开已有文件。

## 内部限制与环境变量

- POST 请求体上限 64 MiB（`lib/json.js`，适用于所有 POST 路由；notebook 落盘上限为 32 MiB）。
- 内核空闲回收由 `DSH_IPYNB_KERNEL_IDLE_MS` 控制，默认 30 分钟。
- 客户端内核状态轮询间隔 10 秒；`/ipynb/execute` 的 NDJSON ping 间隔 15 秒。
- 内核 ready 超时 30 秒；shutdown 宽限 2 秒后发 SIGTERM，再 2 秒后 SIGKILL。

## 许可

MIT。`python/bridge.py` 与部分渲染算法改写自 MIT 许可的 [dong-victor/dsh-better-sidebar-jupyter](https://github.com/dong-victor/dsh-better-sidebar-jupyter)，设计参考 [kikulmj/dsh-jupyter](https://github.com/kikulmj/dsh-jupyter)（Apache-2.0）。详见 `NOTICE`。
