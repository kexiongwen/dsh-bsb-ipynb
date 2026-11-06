# dsh-bsb-ipynb

在 [DSH Better Sidebar](https://github.com/dong-victor/dsh-better-sidebar) 的侧边栏里直接预览、编辑并执行 Jupyter Notebook（`.ipynb`）。

插件通过 `ctx.betterSidebar.registerFileViewer` 注册一个 `.ipynb` 文件查看器（`priority: 10`，高于内置代码查看器的 `-100`），因此点击右侧文件树里的 notebook 就会进入笔记本界面；执行能力由宿主进程里的 Python 内核提供，使用 `jupyter_client` + `ipykernel` 与 `python/bridge.py` 通信。

## 功能

- Notebook 渲染：Markdown、代码、raw cell，执行计数，流式 stdout/stderr、`text/html`、`image/png|jpeg|svg`、`text/markdown`、JSON、ANSI 彩色 traceback。
- 编辑：点击 cell 进入编辑（语法高亮预览 → 文本编辑），支持增删、上移/下移、切换 cell 类型、Markdown 预览。
- 执行：每个 notebook 一个持久 Python 内核（按文件路径共享），变量跨 cell 保留；Run all、中断、重启、关闭。
- 保存：写回 nbformat 4.5，保存前用 sha256 版本号做乐观并发控制；外部修改时返回 409 冲突而不覆盖；编辑后 1.5 秒自动保存。
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

## 安装

在 DSH 的插件管理里把这个目录作为本地 bundle 安装：

```text
dsh-bsb-ipynb
```

安装后刷新页面（桌面端 `Cmd+R`），在右侧文件树中打开任意 `.ipynb` 即可。`examples/demo.ipynb` 是一个可直接运行的示例。

## 使用

| 操作 | 快捷键 |
| --- | --- |
| 运行当前 cell | `Cmd/Ctrl + Enter` |
| 运行并跳到下一个 cell | `Shift + Enter` |
| 在下方插入代码 cell | `Alt + Enter` |
| 保存 | `Cmd/Ctrl + S` |
| 退出编辑 | `Esc` |

工具栏提供解释器选择、Run all、中断、重启、保存、重新加载和关闭内核。切换解释器会重启内核（运行中会先确认）；API 返回的 409 冲突会在顶部显示，只允许重新加载，不会静默覆盖磁盘内容。

## 结构

```text
dsh-bsb-ipynb/
├── index.js              # 宿主插件入口（inject webServer/sessions/connection）
├── client.js             # 浏览器端单文件构建产物（window.__ModuleLoader__）
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
| GET | `/ipynb/health` | 版本、内核数、解释器统计 |
| GET | `/ipynb/interpreters` | 解释器列表与默认项 |
| GET | `/ipynb/status?sessionId=&path=` | 某个 notebook 的内核状态 |
| POST | `/ipynb/read` | 读取并解析 notebook（`{status:'ok'|'invalid'|'unsupported', notebook?, version, size}`） |
| POST | `/ipynb/save` | `{notebook, baseVersion}` 保存；版本过期返回 409 |
| POST | `/ipynb/execute` | `{cellId, code, python?}`，NDJSON 流式返回执行事件 |
| POST | `/ipynb/interrupt` | 中断当前执行 |
| POST | `/ipynb/restart` | 重启内核，可同时切换 `python` |
| POST | `/ipynb/shutdown` | 关闭内核 |

错误码：`bad-request`、`workspace-unknown`、`path-outside-root`、`not-found`、`not-notebook`、`too-large`、`write-conflict`、`write-failed`、`kernel-busy`、`kernel-unavailable`、`interpreter-unknown`、`method-not-allowed`、`internal`。

## 开发与测试

无需构建步骤，`client.js` 直接由 DSH 的模块加载器加载。

> 注意：宿主会缓存已注册的浏览器 bundle。修改 `client.js` 后，单纯刷新页面不会重新读取文件；需要重载 `dsh-bsb-ipynb` 插件或重启 DSH。宿主侧（`index.js`、`lib/`）修改同理。

```bash
node --check index.js lib/*.js client.js
python3 -m py_compile python/bridge.py
node --test --test-timeout=180000 test/*.test.mjs   # 或 npm test
```

`test/bridge.test.mjs` 会在解释器缺少 `jupyter_client`/`ipykernel` 时自动跳过；可用 `DSH_IPYNB_TEST_PYTHON` 指定测试解释器。

## 可靠性

- 同一 notebook 的保存按路径串行化：并发保存只有第一个成功，其余返回 `write-conflict`（409），不会静默覆盖。
- 某个 cell 执行期间收到 restart、shutdown、内核崩溃或 `os._exit()` 时，NDJSON 流会收到一个失败终态并结束，不会永久挂起。
- 每个请求最多缓冲 64 MiB 的 NDJSON；客户端每个 cell 最多保留 32 MiB 输出，超出后显示截断提示。
- 内核 stdin 写失败（EPIPE）会被捕获并清理当前执行，不会冒泡成宿主进程的 `uncaughtException`。

## 已知限制

- 仅支持 Python 内核（`nbformat` 4.x）。
- 不渲染需要 JavaScript 的交互输出（ipywidgets、plotly、bokeh 等）；HTML 输出会按白名单清洗成静态内容。
- 不支持 `%%` cell magic 和 `input()`（与所用的 bridge 一致）；`!cmd`、`%pip`、`%cd`、`%pwd` 可用。
- 执行结果由客户端写回并在保存时落盘；服务端不会在后台追加输出。
- 当前没有“新建 notebook”向导，请在文件树里新建 `.ipynb` 空文件，或直接打开已有文件。

## 许可

MIT。`python/bridge.py` 与部分渲染算法改写自 MIT 许可的 [dong-victor/dsh-better-sidebar-jupyter](https://github.com/dong-victor/dsh-better-sidebar-jupyter)，设计参考 [kikulmj/dsh-jupyter](https://github.com/kikulmj/dsh-jupyter)（Apache-2.0）。详见 `NOTICE`。
