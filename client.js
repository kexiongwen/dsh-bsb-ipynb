window.__ModuleLoader__.load({
  id: 'dsh-bsb-ipynb',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const STYLE_ID = 'dsh-bsb-ipynb-styles'
    const AUTOSAVE_MS = 1500
    // The compatibility floor is the dsh-better-sidebar line this build is
    // tested against. The service exposes both fields, so a stale installation
    // fails here with an actionable message instead of on a missing method.
    const MIN_BETTER_SIDEBAR_VERSION = '0.32.0'
    const REQUIRED_BETTER_SIDEBAR_FEATURES = ['hostRouteUrl', 'fileActions', 'tabActions']
    const SAVE_BANNER_REASONS = new Set(['write-blocked', 'write-conflict', 'save-failed', 'capacity', 'metadata-too-complex', 'json-too-complex', 'empty-file'])
    const STATUS_POLL_MS = 10000
    const MAX_MARKDOWN_QUOTE_DEPTH = 64
    const METADATA_DEPTH_LIMIT = 100
    const METADATA_NODE_LIMIT = 10_000
    const JSON_DEPTH_LIMIT = 100
    const JSON_NODE_LIMIT = 250_000
    const NOTEBOOK_DEPTH_LIMIT = 128
    const NOTEBOOK_NODE_LIMIT = 1_000_000
    const JSON_MIME_PATTERN = /^application\/(.*\+)?json$/

    const STRINGS = {
      en: {
        runAll: 'Run all',
        run: 'Run',
        interrupt: 'Interrupt',
        restart: 'Restart',
        save: 'Save',
        reload: 'Reload',
        reloadConfirm: 'Reload this notebook from disk? Unsaved changes and unsaved execution results will be discarded.',
        shutdown: 'Shut down kernel',
        shutdownFailed: 'The kernel could not be shut down. Check its status and try again.',
        kernel: 'Kernel',
        python: 'Python',
        busy: 'busy',
        idle: 'idle',
        off: 'off',
        stopping: 'stopping',
        addCode: '+ Code',
        addMarkdown: '+ Markdown',
        codeCell: 'Code',
        markdownCell: 'Markdown',
        rawCell: 'Raw',
        moveUp: 'Move up',
        moveDown: 'Move down',
        deleteCell: 'Delete cell',
        deleteCellConfirm: 'Delete this cell? Its contents will be lost.',
        runCell: 'Run cell',
        editCell: 'Edit cell',
        doneEditing: 'Done editing',
        changeTypeConfirm: 'Changing the cell type will discard its outputs or attachments. Continue?',
        emptyHint: 'This notebook is empty. Add a code cell and start typing.',
        invalid: 'This file could not be read as a Jupyter notebook.',
        unsupported: 'Only nbformat 4 notebooks are supported.',
        loadError: 'Could not load the notebook.',
        openAsEmpty: 'Open as empty notebook',
        conflict: 'The file changed on disk. Reload it before saving again.',
        saved: 'Saved',
        saveFailed: 'Save failed',
        saveBlockedReadonly: 'The notebook file is read-only. Clear the read-only attribute and save again.',
        saveBlockedLocked: 'The notebook file is in use by another program. Close it and save again.',
        capacityTooLarge: 'Notebook is {size} MiB; the save limit is 32 MiB. Clear outputs and save again.',
        metadataTooComplex: 'Notebook metadata is too complex to save. Reduce its nesting or number of entries.',
        jsonTooComplex: 'Notebook JSON is too complex to save. Reduce its nesting or number of entries.',
        clearCellOutputs: 'Clear outputs',
        clearAllOutputs: 'Clear all outputs',
        clearAllOutputsConfirm: 'Clear the outputs of every cell? They can only be restored by running the cells again.',
        kernelDied: 'The kernel stopped unexpectedly.',
        kernelRestarted: 'Interrupt timed out, so the kernel was restarted. All variables and kernel state have been cleared.',
        streamIncomplete: 'Execution ended before the cell finished.',
        outputTruncated: 'Output was truncated because it exceeded the display limit.',
        kernelUnavailable: 'No Python interpreter with jupyter_client and ipykernel was found.',
        installHint: 'Install them with: python -m pip install jupyter_client ipykernel',
        restartConfirm: 'Restart the kernel to switch interpreter?',
        shortcuts: 'Ctrl+Enter run, Shift+Enter run and advance, Alt+Enter add cell below, Ctrl+S save',
        shortcutsMac: 'Cmd+Enter run, Shift+Enter run and advance, Alt+Enter add cell below, Cmd+S save',
        emptyFile: 'Empty file — a new notebook will be created on save.',
        outputImage: 'Notebook output image',
        viewerTitle: 'Jupyter Notebook',
        invalidResponse: 'Invalid server response',
        streamUnsupported: 'Streaming is not supported by this browser.',
        capacityNoOutputs: 'Notebook is {size} MiB; the save limit is 32 MiB. There are no outputs to clear — remove cells or shorten the content.',
        cellType: 'Cell type',
        settingsTitle: 'Notebook settings',
        settingsAutosave: 'Autosave delay',
        settingsAutosaveHint: 'Seconds after the last edit; 0.3–30 s.',
        settingsDefaultPython: 'Default interpreter',
        settingsServerDefault: 'Server default',
        settingsIdle: 'Kernel idle timeout',
        settingsIdleHint: 'Minutes without use before the kernel is shut down; 0 keeps it running.',
        settingsInterpreters: 'Discovered interpreters',
        settingsAvailable: 'available',
        settingsUnavailable: 'unavailable',
        settingsLoading: 'Loading…',
        settingsSaved: 'Saved',
        settingsSave: 'Save',
        settingsClose: 'Close',
        settingsError: 'Could not load the notebook settings.',
        newNotebook: 'New notebook',
        createNotebookFailed: 'Could not create the notebook.',
        notebookNotOpen: 'Open the notebook in the editor first.',
        notebookActionFailed: 'The notebook action failed.',
      },
      zh: {
        runAll: '全部运行',
        run: '运行',
        interrupt: '中断',
        restart: '重启',
        save: '保存',
        reload: '重新加载',
        reloadConfirm: '从磁盘重新加载此 notebook？未保存的修改和执行结果将被丢弃。',
        shutdown: '关闭内核',
        shutdownFailed: '内核未能关闭，请查看状态后重试。',
        kernel: '内核',
        python: 'Python',
        busy: '运行中',
        idle: '空闲',
        off: '未启动',
        stopping: '关闭中',
        addCode: '+ 代码',
        addMarkdown: '+ Markdown',
        codeCell: '代码',
        markdownCell: 'Markdown',
        rawCell: '原始',
        moveUp: '上移',
        moveDown: '下移',
        deleteCell: '删除单元格',
        deleteCellConfirm: '删除此单元格？其内容将丢失。',
        runCell: '运行单元格',
        editCell: '编辑单元格',
        doneEditing: '完成编辑',
        changeTypeConfirm: '切换单元格类型将丢弃其输出或附件，是否继续？',
        emptyHint: '这个 notebook 是空的。添加一个代码单元格开始使用。',
        invalid: '无法将该文件解析为 Jupyter notebook。',
        unsupported: '仅支持 nbformat 4 的 notebook。',
        loadError: '无法加载 notebook。',
        openAsEmpty: '作为空 notebook 打开',
        conflict: '文件已在磁盘上发生变化，请重新加载后再保存。',
        saved: '已保存',
        saveFailed: '保存失败',
        saveBlockedReadonly: '文件为只读，请清除只读属性后再保存。',
        saveBlockedLocked: '文件正被其它程序占用，请关闭后重试。',
        capacityTooLarge: 'notebook 内容约 {size} MiB，保存上限为 32 MiB。请清空输出后再保存。',
        metadataTooComplex: 'notebook 的 metadata 过于复杂，无法保存。请减少嵌套层级或条目数量。',
        jsonTooComplex: 'notebook 的 JSON 数据过于复杂，无法保存。请减少嵌套层级或条目数量。',
        clearCellOutputs: '清空输出',
        clearAllOutputs: '清空全部输出',
        clearAllOutputsConfirm: '清空所有单元格的输出？只有重新运行才能恢复。',
        kernelDied: '内核意外退出。',
        kernelRestarted: '中断超时，内核已强制重启；所有变量和内核状态均已清空。',
        streamIncomplete: '执行流在单元格完成前中断。',
        outputTruncated: '输出超过显示上限，已截断。',
        kernelUnavailable: '未找到安装了 jupyter_client 和 ipykernel 的 Python 解释器。',
        installHint: '可使用以下命令安装：python -m pip install jupyter_client ipykernel',
        restartConfirm: '切换解释器需要重启内核，是否继续？',
        shortcuts: 'Ctrl+Enter 运行，Shift+Enter 运行并跳到下一个，Alt+Enter 在下方插入，Ctrl+S 保存',
        shortcutsMac: 'Cmd+Enter 运行，Shift+Enter 运行并跳到下一个，Alt+Enter 在下方插入，Cmd+S 保存',
        emptyFile: '空文件 — 保存时将创建新的 notebook。',
        outputImage: 'notebook 输出图片',
        viewerTitle: 'Jupyter 笔记本',
        invalidResponse: '服务器响应无效',
        streamUnsupported: '当前浏览器不支持流式执行。',
        capacityNoOutputs: 'notebook 约 {size} MiB，超过 32 MiB 上限；当前没有可清空的输出，请删除单元格或精简内容。',
        cellType: '单元格类型',
        settingsTitle: 'Notebook 设置',
        settingsAutosave: '自动保存延迟',
        settingsAutosaveHint: '最后一次编辑后的秒数；0.3–30 秒。',
        settingsDefaultPython: '默认解释器',
        settingsServerDefault: '服务器默认',
        settingsIdle: '内核空闲超时',
        settingsIdleHint: '无操作多少分钟后关闭内核；0 表示不自动关闭。',
        settingsInterpreters: '已发现的解释器',
        settingsAvailable: '可用',
        settingsUnavailable: '不可用',
        settingsLoading: '加载中…',
        settingsSaved: '已保存',
        settingsSave: '保存',
        settingsClose: '关闭',
        settingsError: '无法加载 Notebook 设置。',
        newNotebook: '新建 Notebook',
        createNotebookFailed: '无法创建 Notebook。',
        notebookNotOpen: '请先在编辑器中打开该 Notebook。',
        notebookActionFailed: 'Notebook 操作失败。',
      },
    }

    const LOCALE_NS = 'dsh-bsb-ipynb'
    const browserLocale = (typeof navigator !== 'undefined' && navigator.language) || 'en'
    const browserDict = /^zh/i.test(browserLocale) ? STRINGS.zh : STRINGS.en
    const browserT = (key) => browserDict[key] ?? STRINGS.en[key] ?? key
    // Host-backed translate once the optional DSH locale service is bound (see
    // bindHostLocale); the browser language is only the standalone fallback.
    let t = browserT

    const VIEWER_ID = 'dsh-bsb-ipynb:notebook'
    const AUTOSAVE_MIN_MS = 300
    const AUTOSAVE_MAX_MS = 30_000
    const IDLE_MAX_MINUTES = 1440
    const SETTINGS_DEFAULTS = Object.freeze({
      autosaveMs: AUTOSAVE_MS,
      defaultPython: '',
      // `null` means "not set by the user": the settings panel seeds this from
      // the host's current timeout and only an explicit value is pushed back.
      idleMinutes: null,
    })

    function numberInRange(value, minimum, maximum, fallback) {
      const numeric = typeof value === 'number' ? value : NaN
      if (!Number.isFinite(numeric)) return fallback
      return Math.min(Math.max(numeric, minimum), maximum)
    }

    /** Normalize one persisted plugin-settings blob; unknown/corrupt values fall back. */
    function normalizePluginSettings(raw) {
      const value = raw && typeof raw === 'object' ? raw : {}
      const idle = value.idleMinutes
      return {
        autosaveMs: Math.round(numberInRange(value.autosaveMs, AUTOSAVE_MIN_MS, AUTOSAVE_MAX_MS, SETTINGS_DEFAULTS.autosaveMs)),
        defaultPython: typeof value.defaultPython === 'string' ? value.defaultPython : SETTINGS_DEFAULTS.defaultPython,
        idleMinutes: typeof idle === 'number' && Number.isInteger(idle) && idle >= 0 && idle <= IDLE_MAX_MINUTES ? idle : SETTINGS_DEFAULTS.idleMinutes,
      }
    }

    function readPluginSettings(store) {
      try {
        const prefs = store && typeof store.getPrefs === 'function' ? store.getPrefs() : undefined
        const all = prefs && prefs.pluginSettings
        return normalizePluginSettings(all && all[VIEWER_ID])
      } catch {
        return { ...SETTINGS_DEFAULTS }
      }
    }

    function samePluginSettings(left, right) {
      return left.autosaveMs === right.autosaveMs &&
        left.defaultPython === right.defaultPython &&
        left.idleMinutes === right.idleMinutes
    }

    // The viewer and the settings panel share BSB's persisted plugin settings.
    // Subscribe to the sidebar store so a save applies to already-open notebooks.
    function usePluginSettings(store) {
      const [settings, setSettings] = useState(() => readPluginSettings(store))
      useEffect(() => {
        if (!store || typeof store.subscribe !== 'function') return undefined
        const sync = () => {
          const next = readPluginSettings(store)
          setSettings((current) => (samePluginSettings(current, next) ? current : next))
        }
        sync()
        return store.subscribe(sync)
      }, [store])
      return settings
    }

    function isMacPlatform(nav = (typeof navigator !== 'undefined' ? navigator : null)) {
      const platform = nav && (nav.userAgentData?.platform || nav.platform || nav.userAgent) || ''
      return /mac/i.test(platform)
    }

    function shortcutText() {
      return t(isMacPlatform() ? 'shortcutsMac' : 'shortcuts')
    }

    const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    const UNESCAPE = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE[char])
    }

    function decodeEscapedHtml(value) {
      return String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (entity) => UNESCAPE[entity])
    }

    const WINDOWS_LOCAL_PATH = /^[A-Za-z]:[\\/]/
    // A real UNC path starts with two backslashes. Two forward slashes are a
    // protocol-relative URL and must keep the cross-origin image refusal.
    const UNC_LOCAL_PATH = /^\\\\[^\\/]/

    // Markdown/HTML destinations may be local files. On Windows those are
    // drive-letter (C:\... / C:/...) or UNC (\\server\share) paths; they must
    // reach the local image resolver instead of being rejected as unknown URL
    // schemes.
    function isAbsoluteLocalPath(value) {
      if (typeof value !== 'string' || value === '') return false
      return value.startsWith('/') || WINDOWS_LOCAL_PATH.test(value) || UNC_LOCAL_PATH.test(value)
    }

    function sanitizeUrl(value, options) {
      if (typeof value !== 'string') return null
      // Browsers normalize ASCII control characters out of URLs, so remove them
      // before the allowlist check or `java\nscript:` becomes `javascript:`.
      const url = value.replace(/[\u0000-\u001F\u007F]/g, '').trim()
      if (!url) return null
      if (WINDOWS_LOCAL_PATH.test(url) || UNC_LOCAL_PATH.test(url)) {
        // Images are resolved to file URLs by makeImageResolver; links to local
        // paths are not supported.
        return options && options.image ? url : null
      }
      if (/^(javascript|vbscript|file):/i.test(url)) return null
      if (url.startsWith('attachment:')) return url
      if (/^data:/i.test(url)) {
        return options && options.image && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(url) ? url : null
      }
      if (/^(https?:|mailto:|tel:)/i.test(url)) return url
      // Protocol-relative URLs inherit the page scheme. Keep them for ordinary
      // links, but refuse them for image sources: opening an untrusted notebook
      // must not fire cross-origin image requests to an arbitrary host.
      if (url.startsWith('//')) return options && options.image ? null : url
      if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
      return null
    }

    const ALLOWED_TAGS = new Set([
      'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
      'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
      'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
      'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
    ])
    const DROP_TAGS = new Set([
      'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button',
      'textarea', 'select', 'option', 'video', 'audio', 'source', 'template', 'svg', 'math', 'canvas',
    ])
    const ALLOWED_ATTRS = new Set([
      'href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'align', 'valign', 'width', 'height',
      'target', 'rel', 'start', 'type',
    ])

    function elementAttribute(element, name) {
      for (const attribute of Array.from(element.attributes || [])) {
        if (String(attribute.name).toLowerCase() === name) return attribute.value
      }
      return ''
    }

    function cleanNode(node, resolveImage) {
      for (const child of Array.from(node.childNodes || [])) {
        if (child.nodeType === 3) continue
        if (child.nodeType !== 1) {
          child.remove()
          continue
        }
        const tag = child.tagName.toLowerCase()
        if (DROP_TAGS.has(tag)) {
          child.remove()
          continue
        }
        if (!ALLOWED_TAGS.has(tag)) {
          const fragment = node.ownerDocument.createDocumentFragment()
          while (child.firstChild) fragment.appendChild(child.firstChild)
          child.replaceWith(fragment)
          cleanNode(node, resolveImage)
          continue
        }
        let imageSrc = null
        for (const attribute of Array.from(child.attributes)) {
          const name = attribute.name.toLowerCase()
          if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
            child.removeAttribute(attribute.name)
            continue
          }
          if (name === 'href' || name === 'src') {
            const safe = sanitizeUrl(attribute.value, { image: name === 'src' })
            if (safe) {
              child.setAttribute(name, safe)
              if (name === 'src' && tag === 'img') imageSrc = safe
            } else child.removeAttribute(name)
          }
        }
        if (tag === 'img' && imageSrc !== null && typeof resolveImage === 'function') {
          // sanitizeUrl keeps attachment:/relative image sources (and Windows
          // drive/UNC paths) because a notebook-local image is legitimate.
          // They only become renderable after the local image resolver maps
          // them to the host file route, exactly like markdown images. A
          // resolver failure degrades that one image instead of escaping the
          // whole HTML output.
          let resolved = null
          try {
            resolved = resolveImage(imageSrc)
          } catch {
            resolved = null
          }
          if (resolved) {
            child.setAttribute('src', resolved)
          } else {
            // Unresolvable references (e.g. a missing attachment) degrade to
            // the same marker the markdown renderer uses instead of a broken
            // image every time the output renders.
            const document = node.ownerDocument
            const marker = document.createElement('span')
            marker.setAttribute('class', 'dsh-bsb-ipynb-missing-image')
            marker.textContent = elementAttribute(child, 'alt')
            child.replaceWith(marker)
            continue
          }
        }
        if (tag === 'a') {
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noreferrer noopener')
        }
        cleanNode(child, resolveImage)
      }
    }

    function sanitizeHtml(html, options) {
      // Without DOMParser the whole fragment is shown as escaped text; there is
      // no element to rewrite, so the image resolver cannot apply.
      if (typeof DOMParser === 'undefined') return escapeHtml(html)
      try {
        const document = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
        cleanNode(document.body, options && options.resolveImage)
        return document.body.innerHTML
      } catch {
        // Pathological markup (deeply nested or very wide tag soup) must never
        // abort rendering: show it as escaped text instead of throwing.
        return escapeHtml(html)
      }
    }

    function isTableStart(lines, index) {
      if (index + 1 >= lines.length) return false
      if (!lines[index].includes('|')) return false
      return /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]) && lines[index + 1].includes('-')
    }

    function isBlockStart(line) {
      return (
        /^\s*(```+|~~~+)/.test(line) ||
        /^(#{1,6})\s+/.test(line) ||
        /^\s*>/.test(line) ||
        /^\s*([-+*]|\d+[.)])\s+/.test(line) ||
        /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
      )
    }

    // Inline link/image destinations may contain one level of balanced
    // parentheses, so wiki-style URLs such as Foo_(bar) stay intact.
    const INLINE_DESTINATION = '((?:[^()\\s]|\\([^()\\s]*\\))+)'
    const INLINE_IMAGE_PATTERN = new RegExp('!\\[([^\\]]*)\\]\\(' + INLINE_DESTINATION + '\\)', 'g')
    const INLINE_LINK_PATTERN = new RegExp('\\[([^\\]]+)\\]\\(' + INLINE_DESTINATION + '\\)', 'g')

    function renderInline(value) {
      // Control characters carry no Markdown meaning, so one of them can mark
      // already-rendered fragments. Stripping it from the input keeps user
      // text from ever colliding with a placeholder.
      const token = '\u0001'
      let text = String(value ?? '').replace(/[\u0000\u0001]/g, '')
      const parts = []
      const tokenPattern = /\u0001(\d+)\u0001/g
      const placeholder = (html) => {
        parts.push(html)
        return token + (parts.length - 1) + token
      }

      // Emphasis applies to plain text only; callers pass already-escaped
      // text. Link labels are inline content, so they get the same treatment.
      const emphasis = (escapedText) => escapedText
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/(^|[^_])_([^_\s][^_]*)_/g, '$1<em>$2</em>')

      // Code spans first: their contents must not take part in any later link
      // or emphasis parsing.
      text = text.replace(/`([^`]+)`/g, (match, code) => placeholder('<code>' + escapeHtml(code) + '</code>'))

      // Links and images are captured before escaping so their attributes are
      // escaped exactly once and emphasis can never rewrite them.
      text = text.replace(INLINE_IMAGE_PATTERN, (match, alt, src) => {
        const url = sanitizeUrl(src, { image: true })
        if (!url) return alt
        return placeholder('<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '" loading="lazy">')
      })
      text = text.replace(INLINE_LINK_PATTERN, (match, label, href) => {
        const url = sanitizeUrl(href)
        if (!url) return label
        return placeholder('<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">' + emphasis(escapeHtml(label)) + '</a>')
      })

      // Bare URLs become links before emphasis can split them at `_` or `*`.
      text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, prefix, url) => {
        const safe = sanitizeUrl(url)
        if (!safe) return match
        return prefix + placeholder('<a href="' + escapeHtml(safe) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(url) + '</a>')
      })

      // Only plain text remains: escape it once, then apply emphasis.
      text = emphasis(escapeHtml(text))

      // Restore fragments; loop so a code span inside a link label resolves too.
      let restored = text
      for (let depth = 0; depth < 8 && restored.includes(token); depth += 1) {
        const next = restored.replace(tokenPattern, (match, index) => {
          const part = parts[Number(index)]
          return part === undefined ? '' : part
        })
        if (next === restored) break
        restored = next
      }
      return restored
    }

    function renderMarkdown(source, options) {
      const settings = options || {}
      const depth = typeof settings.depth === 'number' ? settings.depth : 0
      const resolveImage = typeof settings.resolveImage === 'function' ? settings.resolveImage : null
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      let index = 0
      let html = ''
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*$/.test(line)) {
          index += 1
          continue
        }
        const fence = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/)
        // A backtick fence's info string may not contain a backtick.
        if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
          const char = fence[1][0]
          const length = fence[1].length
          const info = fence[2].trim()
          const language = (info.split(/\s+/)[0] || '').replace(/[^\w+#.-]/g, '')
          // CommonMark: a closing fence uses the same character and at least
          // as many of them, and may only be followed by spaces.
          const closing = new RegExp('^\\s*' + char + '{' + length + ',}\\s*$')
          const body = []
          index += 1
          while (index < lines.length && !closing.test(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          index += 1
          html +=
            '<pre class="dsh-bsb-ipynb-md-code"><code' +
            (language ? ' class="language-' + escapeHtml(language) + '"' : '') +
            '>' +
            escapeHtml(body.join('\n')) +
            '</code></pre>'
          continue
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          const level = heading[1].length
          html += '<h' + level + '>' + renderInline(heading[2].trim()) + '</h' + level + '>'
          index += 1
          continue
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
          html += '<hr>'
          index += 1
          continue
        }
        if (/^\s*>/.test(line)) {
          const quote = []
          while (index < lines.length && /^\s*>/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          if (depth >= MAX_MARKDOWN_QUOTE_DEPTH) {
            // Deeper nesting becomes plain text instead of growing the call
            // stack without bound on crafted documents.
            html += '<blockquote>' + escapeHtml(quote.join('\n')) + '</blockquote>'
            continue
          }
          html += '<blockquote>' + renderMarkdown(quote.join('\n'), { ...settings, depth: depth + 1 }) + '</blockquote>'
          continue
        }
        if (/^\s*([-+*]|\d+[.)])\s+/.test(line)) {
          const ordered = /^\s*\d+[.)]\s+/.test(line)
          const items = []
          while (index < lines.length && /^\s*([-+*]|\d+[.)])\s+/.test(lines[index])) {
            items.push(lines[index].replace(/^\s*([-+*]|\d+[.)])\s+/, ''))
            index += 1
            while (index < lines.length && /^\s{2,}\S/.test(lines[index])) {
              items[items.length - 1] += ' ' + lines[index].trim()
              index += 1
            }
          }
          html += ordered ? '<ol>' : '<ul>'
          for (const item of items) html += '<li>' + renderInline(item) + '</li>'
          html += ordered ? '</ol>' : '</ul>'
          continue
        }
        if (isTableStart(lines, index)) {
          const cells = (row) =>
            row
              .trim()
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map((cell) => cell.trim())
          const header = cells(lines[index])
          index += 2
          const rows = []
          while (index < lines.length && lines[index].includes('|') && !/^\s*$/.test(lines[index])) {
            rows.push(cells(lines[index]))
            index += 1
          }
          html += '<table><thead><tr>'
          for (const cell of header) html += '<th>' + renderInline(cell) + '</th>'
          html += '</tr></thead><tbody>'
          for (const row of rows) {
            html += '<tr>'
            for (const cell of row) html += '<td>' + renderInline(cell) + '</td>'
            html += '</tr>'
          }
          html += '</tbody></table>'
          continue
        }
        const paragraph = []
        while (index < lines.length && !/^\s*$/.test(lines[index]) && !isBlockStart(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        if (!paragraph.length) {
          paragraph.push(lines[index])
          index += 1
        }
        html += '<p>' + paragraph.map(renderInline).join('<br>') + '</p>'
      }
      return html
    }

    function renderMarkdownWithImages(source, resolveImage) {
      let html = renderMarkdown(source)
      if (typeof resolveImage !== 'function') return html
      return html.replace(/<img src="([^"]*)" alt="([^"]*)" loading="lazy">/g, (match, src, alt) => {
        // The resolver needs the original URL; only its final URL is escaped
        // when it is inserted back into an HTML attribute.
        const resolved = resolveImage(decodeEscapedHtml(src))
        if (!resolved) return '<span class="dsh-bsb-ipynb-missing-image">' + alt + '</span>'
        return '<img src="' + escapeHtml(resolved) + '" alt="' + alt + '" loading="lazy">'
      })
    }

    const ANSI_BASE = [
      '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ]

    function ansi256(index) {
      if (index < 16) return ANSI_BASE[index] || '#ffffff'
      if (index < 232) {
        const value = index - 16
        const r = Math.floor(value / 36)
        const g = Math.floor((value % 36) / 6)
        const b = value % 6
        const channel = (part) => (part === 0 ? 0 : 55 + part * 40)
        return 'rgb(' + channel(r) + ',' + channel(g) + ',' + channel(b) + ')'
      }
      const gray = 8 + (index - 232) * 10
      return 'rgb(' + gray + ',' + gray + ',' + gray + ')'
    }

    function ansiToHtml(input) {
      // Progress bars rewrite a line with '\r' and terminal windows/hyperlinks
      // use OSC sequences; browsers would otherwise render both as literal
      // text. Keep the final carriage-return segment of each line.
      const source = String(input ?? '')
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
        .split('\n')
        .map((line) => {
          const carriage = line.lastIndexOf('\r')
          return carriage === -1 ? line : line.slice(carriage + 1)
        })
        .join('\n')
      const state = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false }
      let open = false
      let html = ''
      const css = () => {
        const parts = []
        let fg = state.fg
        let bg = state.bg
        if (state.reverse) {
          const swapped = fg
          fg = bg || '#ffffff'
          bg = swapped || '#000000'
        }
        if (fg) parts.push('color:' + fg)
        if (bg) parts.push('background-color:' + bg)
        if (state.bold) parts.push('font-weight:700')
        if (state.dim) parts.push('opacity:.7')
        if (state.italic) parts.push('font-style:italic')
        if (state.underline) parts.push('text-decoration:underline')
        return parts.join(';')
      }
      const applySgr = (codeText) => {
        const codes = codeText === '' ? [0] : codeText.split(';').map((part) => Number.parseInt(part || '0', 10))
        for (let index = 0; index < codes.length; index += 1) {
          const code = codes[index]
          if (code === 0) {
            state.fg = null
            state.bg = null
            state.bold = false
            state.dim = false
            state.italic = false
            state.underline = false
            state.reverse = false
          } else if (code === 1) state.bold = true
          else if (code === 2) state.dim = true
          else if (code === 3) state.italic = true
          else if (code === 4) state.underline = true
          else if (code === 7) state.reverse = true
          else if (code === 22) {
            state.bold = false
            state.dim = false
          } else if (code === 23) state.italic = false
          else if (code === 24) state.underline = false
          else if (code === 27) state.reverse = false
          else if (code >= 30 && code <= 37) state.fg = ANSI_BASE[code - 30]
          else if (code >= 90 && code <= 97) state.fg = ANSI_BASE[code - 90 + 8]
          else if (code >= 40 && code <= 47) state.bg = ANSI_BASE[code - 40]
          else if (code >= 100 && code <= 107) state.bg = ANSI_BASE[code - 100 + 8]
          else if (code === 39) state.fg = null
          else if (code === 49) state.bg = null
          else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
            const color = ansi256(codes[index + 2] || 0)
            if (code === 38) state.fg = color
            else state.bg = color
            index += 2
          }
        }
      }
      const openSpan = () => {
        const style = css()
        if (style) {
          html += '<span style="' + style + '">'
          open = true
        }
      }
      const closeSpan = () => {
        if (open) {
          html += '</span>'
          open = false
        }
      }
      const pattern = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[A-Za-z]/g
      let last = 0
      let match
      while ((match = pattern.exec(source))) {
        html += escapeHtml(source.slice(last, match.index))
        closeSpan()
        if (match[1] !== undefined) {
          applySgr(match[1])
          openSpan()
        }
        last = match.index + match[0].length
      }
      html += escapeHtml(source.slice(last))
      closeSpan()
      return html
    }

    const PY_KEYWORDS = new Set([
      'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
      'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
      'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'True', 'False', 'None',
    ])
    const PY_BUILTINS = new Set([
      'abs', 'all', 'any', 'bool', 'bytes', 'callable', 'chr', 'classmethod', 'dict', 'dir', 'enumerate', 'eval',
      'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex',
      'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'min',
      'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round',
      'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip',
    ])

    function highlightPython(code) {
      // Notebook sources can arrive with CRLF (hand-written files, Windows
      // tooling); normalize first so a token span never keeps the carriage
      // return and renders an extra blank line.
      const source = String(code ?? '').replace(/\r\n?/g, '\n')
      const pattern = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*|\b\d+\.?\d*(?:[eE][+-]?\d+)?j?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
      let html = ''
      let last = 0
      let match
      while ((match = pattern.exec(source))) {
        html += escapeHtml(source.slice(last, match.index))
        const token = match[0]
        let kind = ''
        if (token.startsWith('#')) kind = 'comment'
        else if (token.startsWith('"') || token.startsWith("'")) kind = 'string'
        else if (/^\d/.test(token)) kind = 'number'
        else if (PY_KEYWORDS.has(token)) kind = 'keyword'
        else if (PY_BUILTINS.has(token)) kind = 'builtin'
        else if (/^[A-Z]/.test(token)) kind = 'class'
        html += kind
          ? '<span class="dsh-bsb-ipynb-tok-' + kind + '">' + escapeHtml(token) + '</span>'
          : escapeHtml(token)
        last = match.index + token.length
      }
      html += escapeHtml(source.slice(last))
      return html
    }

    function normalizePosix(value) {
      const normalized = String(value ?? '').replace(/\\/g, '/')
      const parts = normalized.split('/')
      const output = []
      const absolute = parts[0] === ''
      const unc = normalized.startsWith('//') && !normalized.startsWith('///')
      for (const part of parts) {
        if (!part || part === '.') continue
        if (part === '..') {
          if (output.length && output[output.length - 1] !== '..') output.pop()
          else if (!absolute) output.push('..')
          continue
        }
        output.push(part)
      }
      return (unc ? '//' : absolute ? '/' : '') + output.join('/')
    }

    function dirnamePosix(value) {
      const normalized = normalizePosix(value)
      const index = normalized.lastIndexOf('/')
      return index <= 0 ? '/' : normalized.slice(0, index)
    }

    function routeUrl(ctx, method) {
      return ctx.betterSidebar.hostRouteUrl('ipynb/' + method)
    }

    async function readResponse(response) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const error = new Error((payload && payload.error && payload.error.message) || 'HTTP ' + response.status)
        error.code = (payload && payload.error && payload.error.code) || 'http-error'
        error.details = payload && payload.error && payload.error.details
        error.status = response.status
        throw error
      }
      return payload.value
    }

    // A host refresh unmounts the viewer before calling its loader again. Keep
    // accepted saves outside component refs so that replacement viewers and
    // other open views of this document still wait for their result.
    const notebookRequests = new Map()
    // Live notebook controls keyed by session + path. The tab-header actions
    // use this registry because their context carries no component instance.
    const notebookControls = new Map()
    // One host-wide kernel manager backs every open notebook, so the idle
    // setting needs only one successful push per value.
    let lastSyncedIdleMinutes = null

    function notebookControlKey(sessionId, notebookPath) {
      return JSON.stringify([String(sessionId || ''), String(notebookPath || '')])
    }

    function findNotebookControls(sessionId, notebookPath) {
      const direct = notebookControls.get(notebookControlKey(sessionId, notebookPath))
      if (direct) return direct
      // The file tree can address a relative path while the active viewer holds
      // the absolute one; try the normalized spellings before giving up.
      const normalized = normalizePosix(String(notebookPath || ''))
      for (const [key, controls] of notebookControls) {
        if (String(controls.sessionId || '') !== String(sessionId || '')) continue
        if (normalizePosix(controls.path) === normalized) return controls
      }
      return undefined
    }

    function notebookRequestState(ctx, path, sessionId) {
      const key = JSON.stringify([routeUrl(ctx, 'save'), sessionId, path])
      let state = notebookRequests.get(key)
      if (!state) {
        state = { key, pending: new Set(), readers: 0, generation: 0 }
        notebookRequests.set(key, state)
      }
      return state
    }

    function releaseNotebookRequestState(state) {
      if (state.pending.size === 0 && state.readers === 0) notebookRequests.delete(state.key)
    }

    function readAborted() {
      const error = new Error('Notebook read was aborted')
      error.name = 'AbortError'
      return error
    }

    async function waitForNotebookSaves(state, signal) {
      for (;;) {
        if (signal?.aborted) throw readAborted()
        if (state.pending.size === 0) return
        const settled = Promise.all([...state.pending])
        if (!signal) {
          await settled
          continue
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => { cleanup(); reject(readAborted()) }
          const cleanup = () => signal.removeEventListener('abort', onAbort)
          signal.addEventListener('abort', onAbort, { once: true })
          settled.then(() => { cleanup(); resolve() })
          if (signal.aborted) onAbort()
        })
      }
    }

    async function postJson(ctx, method, body, signal) {
      const state = method === 'save' ? notebookRequestState(ctx, body.path, body.sessionId) : null
      let settleSave, pending
      if (state) {
        pending = new Promise((resolve) => { settleSave = resolve })
        state.pending.add(pending)
        state.generation += 1
      }
      try {
        const response = await fetch(routeUrl(ctx, method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        return await readResponse(response)
      } finally {
        if (state) {
          state.pending.delete(pending)
          releaseNotebookRequestState(state)
          settleSave()
        }
      }
    }

    async function getJson(ctx, method, query, signal) {
      const params = new URLSearchParams(query || {})
      const suffix = params.toString() ? '?' + params.toString() : ''
      const response = await fetch(routeUrl(ctx, method) + suffix, { method: 'GET', signal })
      return readResponse(response)
    }

    async function readNotebook(ctx, path, scope, signal) {
      const state = notebookRequestState(ctx, path, scope && scope.sessionId)
      state.readers += 1
      try {
        for (;;) {
          if (signal?.aborted) throw readAborted()
          if (state.pending.size) await waitForNotebookSaves(state, signal)
          const generation = state.generation
          try {
            const value = await postJson(ctx, 'read', { sessionId: scope && scope.sessionId, path }, signal)
            if (signal?.aborted) throw readAborted()
            // The old viewer can start a save just after a host read was sent.
            // Its response cannot be adopted even if that save already settled.
            if (state.generation !== generation) continue
            return value
          } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw readAborted()
            if (state.generation !== generation) continue
            throw error
          }
        }
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        return {
          status: 'error',
          code: (error && error.code) || 'network',
          message: (error && error.message) || String(error),
        }
      } finally {
        state.readers -= 1
        releaseNotebookRequestState(state)
      }
    }

    async function streamExecute(ctx, body, onEvent, signal) {
      const response = await fetch(routeUrl(ctx, 'execute'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) {
        await readResponse(response)
        return
      }
      if (!response.body) throw new Error(t('streamUnsupported'))
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          try {
            onEvent(JSON.parse(line))
          } catch {
            /* ignore malformed keepalive lines */
          }
        }
      }
      buffer += decoder.decode()
      const tail = buffer.trim()
      if (tail) {
        try {
          onEvent(JSON.parse(tail))
        } catch {
          /* ignore */
        }
      }
    }

    const CELL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
    let cellCounter = 0

    function newCellId() {
      cellCounter += 1
      return 'cell-' + Date.now().toString(36) + cellCounter.toString(36)
    }

    function emptyNotebook() {
      return {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        },
        cells: [{ cell_type: 'code', execution_count: null, id: newCellId(), metadata: {}, outputs: [], source: '' }],
      }
    }

    // nbformat output objects are strict (additionalProperties: false): only
    // execute_result may carry execution_count, and display_id is a transient
    // Jupyter message field that must never reach a .ipynb file.
    function stripIllegalOutputFields(output) {
      if (!output || typeof output !== 'object') return output
      const clean = { ...output }
      delete clean.display_id
      if (clean.output_type !== 'execute_result') delete clean.execution_count
      return clean
    }

    // Chinese IMEs deliver composition keystrokes with keyCode 229 (React also
    // exposes isComposing); they must never trigger cell shortcuts such as
    // running a cell or leaving edit mode.
    function isImeKeyEvent(event) {
      if (!event) return false
      return Boolean(event.isComposing || event.keyCode === 229 ||
        (event.nativeEvent && event.nativeEvent.isComposing))
    }

    // Ctrl/Cmd+S regardless of CapsLock: with the lock on (or Shift held) the
    // browser reports event.key === 'S', so match the physical key as well.
    function isSaveShortcut(event) {
      if (!event || isImeKeyEvent(event) || !(event.metaKey || event.ctrlKey)) return false
      if (event.code === 'KeyS') return true
      return typeof event.key === 'string' && event.key.toLowerCase() === 's'
    }

    // The cell editor owns its keydown handler (and prevents the browser
    // default itself); the window-level listener must not act a second time.
    function isEditingKeyTarget(target) {
      if (!target || typeof target !== 'object') return false
      const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'textarea' || tag === 'input') return true
      return target.isContentEditable === true
    }

    // Walk the DOM ancestors of a keydown target to the nearest cell container
    // (every rendered cell carries data-cell-id). Walking the tree instead of
    // tracking hover keeps "the cell I am looking at" honest even when focus
    // sits on a cell action button or one of its outputs.
    function cellIdFromEventTarget(target) {
      let node = target
      for (let depth = 0; node && depth < 64; depth += 1) {
        if (typeof node.getAttribute === 'function') {
          const cellId = node.getAttribute('data-cell-id')
          if (typeof cellId === 'string' && cellId) return cellId
        }
        node = node.parentNode || null
      }
      return null
    }

    // Pure resolver for the window-level keydown listener. Moving the decision
    // out of the component makes the IME/CapsLock/modifier semantics testable
    // without a DOM: the caller only resolves the target cell and performs the
    // returned action (and always calls preventDefault for a handled shortcut,
    // so Ctrl/Cmd+S cannot open the browser's "save page" dialog in reading
    // mode). Events already handled by the cell editor are refused, which is
    // what keeps Ctrl+Enter/Ctrl+S from firing twice while editing.
    function resolveReadingShortcut(event, context) {
      if (!event || typeof event !== 'object') return null
      if (event.defaultPrevented) return null
      // Auto-repeat from a held key must not queue repeated saves/runs.
      if (event.repeat === true) return null
      if (isImeKeyEvent(event)) return null
      if (isEditingKeyTarget(event.target)) return null
      if (!(event.metaKey || event.ctrlKey)) return null
      if (isSaveShortcut(event)) return { action: 'save', cellId: null }
      if (event.key !== 'Enter') return null
      const options = context || {}
      // Never guess a cell: without a focused cell or a recent edit/run the
      // shortcut is a no-op instead of running the first cell by accident.
      const cellId = options.targetCellId || options.activeCellId || null
      if (!cellId) return null
      return { action: 'run', cellId }
    }

    // A blocked save (read-only or locked file) must not retry every autosave
    // tick while the user keeps typing: back off up to 30 seconds.
    function blockedAutosaveDelay(current, base = AUTOSAVE_MS) {
      return Math.min(Math.max(current, base) * 4, 30_000)
    }

    // Ordinary failures wait for another edit; retryable write-blocked failures
    // instead retry the unchanged snapshot with the backoff above.
    function shouldScheduleAutosave(state) {
      if (state.loadStatus !== 'ok' || !state.dirty) return false
      if (state.conflict || state.autosaveBlocked || state.capacityBlocked || state.runningCell) return false
      if (state.saveState === 'saving') return false
      if (state.saveState === 'failed' && !state.notebookChangedSinceFailure) return false
      return true
    }

    // Toolbar click handlers are invoked with a DOM/Synthetic event; only a
    // real interpreter path string may be forwarded to the restart route.
    function resolveRestartPython(nextPython, currentPython) {
      if (typeof nextPython === 'string' && nextPython) return nextPython
      return currentPython || undefined
    }

    function executeReplyFailed(event) {
      return Boolean(event && event.type === 'execute_reply' && event.ok === false)
    }

    function kernelRestartedReply(event) {
      return Boolean(event && event.type === 'execute_reply' && event.kernel_restarted === true)
    }

    function shouldHandleCellEvent(cellId, event) {
      return !event.cell_id || event.cell_id === cellId
    }

    function cellTypeChangeLosesData(cell, type) {
      const losesOutputs = type !== 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0
      const losesAttachments = type !== 'markdown' && cell.attachments && typeof cell.attachments === 'object' && Object.keys(cell.attachments).length > 0
      return Boolean(losesOutputs || losesAttachments)
    }

    function saveButtonDisabled({ dirty, saveState, conflict, running }) {
      return Boolean(conflict) || Boolean(running) || !dirty || saveState === 'saving'
    }

    function isStaleSaveResponse(currentSeq, responseSeq) {
      return currentSeq !== responseSeq
    }

    // A run that ends without an execute_reply did not produce a real terminal
    // state (fatal / kernel_died / truncated stream / abort); keep the pre-run
    // outputs instead of leaving the cell wiped.
    function shouldRestoreOutputsAfterRun(replySeen) {
      return !replySeen
    }

    function normalizeNotebook(value) {
      if (!value || typeof value !== 'object' || !Array.isArray(value.cells)) return emptyNotebook()
      const cellIds = new Set()
      return {
        ...value,
        nbformat: 4,
        nbformat_minor: typeof value.nbformat_minor === 'number' ? value.nbformat_minor : 5,
        cells: value.cells.map((cell) => {
          let id = typeof cell.id === 'string' && CELL_ID_PATTERN.test(cell.id) ? cell.id : ''
          if (!id || cellIds.has(id)) {
            do {
              id = newCellId()
            } while (cellIds.has(id))
          }
          cellIds.add(id)
          const output = {
            ...cell,
            id,
            source: Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? ''),
          }
          if (output.cell_type === 'code') {
            output.outputs = Array.isArray(output.outputs)
              ? output.outputs.map(stripIllegalOutputFields)
              : []
            output.execution_count = typeof output.execution_count === 'number' ? output.execution_count : null
          }
          return output
        }),
      }
    }

    // Keep identical to lib/json-budget.js; parity is covered by regression tests.
    function measureJsonBytes(value, {
      limit = Infinity,
      space = 2,
      nodeLimit = 1_000_000,
      depthLimit = 100,
    } = {}) {
      if (typeof limit !== 'number' || Number.isNaN(limit) || limit < 0
        || typeof nodeLimit !== 'number' || Number.isNaN(nodeLimit) || nodeLimit < 0
        || typeof depthLimit !== 'number' || Number.isNaN(depthLimit) || depthLimit < 0
        || typeof space !== 'number' || Number.isNaN(space)) {
        throw new TypeError('JSON budgets and indentation must be non-negative numbers')
      }
      const indent = Math.min(10, Math.max(0, Math.trunc(space)))
      const active = new Set()
      const stack = []
      let bytes = 0
      let nodes = 0

      function fail(reason) {
        const error = new Error(reason === 'bytes'
          ? 'JSON exceeds its byte limit'
          : `JSON exceeds its ${reason} limit`)
        error.code = reason === 'bytes' ? 'json-too-large' : 'json-too-complex'
        error.reason = reason
        // A lower bound is sufficient after early termination.
        error.bytes = bytes
        throw error
      }

      function add(count) {
        bytes += count
        if (bytes > limit) fail('bytes')
      }

      function stringBytes(text) {
        add(2)
        for (let index = 0; index < text.length; index += 1) {
          const code = text.charCodeAt(index)
          if (code === 0x22 || code === 0x5c
            || code === 0x08 || code === 0x09 || code === 0x0a
            || code === 0x0c || code === 0x0d) {
            add(2)
          } else if (code < 0x20) {
            add(6)
          } else if (code < 0x80) {
            add(1)
          } else if (code < 0x800) {
            add(2)
          } else if (code >= 0xd800 && code <= 0xdbff) {
            const next = text.charCodeAt(index + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
              add(4)
              index += 1
            } else {
              add(6)
            }
          } else {
            add(code >= 0xdc00 && code <= 0xdfff ? 6 : 3)
          }
        }
      }

      function descriptorValue(object, key, inherited = false) {
        let owner = object
        while (owner !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, key)
          if (descriptor) {
            if (!Object.hasOwn(descriptor, 'value')) {
              throw new TypeError('JSON accessors are not supported')
            }
            return descriptor.value
          }
          if (!inherited) break
          owner = Object.getPrototypeOf(owner)
        }
        return undefined
      }

      function omitted(item) {
        return item === undefined || typeof item === 'function' || typeof item === 'symbol'
      }

      function visit(item, depth) {
        nodes += 1
        if (nodes > nodeLimit) fail('nodes')
        if (depth > depthLimit) fail('depth')
        if (item === null || omitted(item)) {
          add(4)
        } else if (typeof item === 'string') {
          stringBytes(item)
        } else if (typeof item === 'number') {
          add(Number.isFinite(item) ? String(item).length : 4)
        } else if (typeof item === 'boolean') {
          add(item ? 4 : 5)
        } else if (typeof item !== 'object') {
          throw new TypeError('Value cannot be represented as JSON')
        } else {
          const array = Array.isArray(item)
          const prototype = Object.getPrototypeOf(item)
          // Checking the prototype's parent also accepts objects from another realm.
          if (!array && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
            throw new TypeError('Only plain JSON data objects are supported')
          }
          if (typeof descriptorValue(item, 'toJSON', true) === 'function') {
            throw new TypeError('JSON toJSON hooks are not supported')
          }
          if (active.has(item)) throw new TypeError('Converting circular structure to JSON')
          add(2)
          active.add(item)
          stack.push({ item, depth, array, keys: array ? null : Object.keys(item), index: 0, written: 0 })
        }
      }

      if (omitted(value)) throw new TypeError('Value cannot be represented as JSON')
      visit(value, 0)
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        const length = frame.array ? frame.item.length : frame.keys.length
        if (frame.index >= length) {
          if (indent && frame.written > 0) add(1 + frame.depth * indent)
          active.delete(frame.item)
          stack.pop()
          continue
        }
        const key = frame.array ? String(frame.index) : frame.keys[frame.index]
        frame.index += 1
        const item = descriptorValue(frame.item, key, frame.array)
        if (!frame.array && omitted(item)) continue
        if (frame.written > 0) add(1)
        if (indent) add(1 + (frame.depth + 1) * indent)
        if (!frame.array) {
          stringBytes(key)
          add(indent ? 2 : 1)
        }
        frame.written += 1
        visit(item, frame.depth + 1)
      }
      return bytes
    }

    function assertJsonWithinLimits(value, label, metadata = false) {
      try {
        measureJsonBytes(value ?? null, {
          limit: NOTEBOOK_CAP_BYTES,
          space: 0,
          nodeLimit: metadata ? METADATA_NODE_LIMIT : JSON_NODE_LIMIT,
          depthLimit: metadata ? METADATA_DEPTH_LIMIT : JSON_DEPTH_LIMIT,
        })
      } catch (error) {
        if (error.code === 'json-too-complex') {
          const depth = error.reason === 'depth'
          const depthLimit = metadata ? METADATA_DEPTH_LIMIT : JSON_DEPTH_LIMIT
          const nodeLimit = metadata ? METADATA_NODE_LIMIT : JSON_NODE_LIMIT
          error.message = `${label} exceeds the maximum ${depth ? 'depth of ' + depthLimit : 'node count of ' + nodeLimit}`
          if (metadata) error.code = 'metadata-too-complex'
        }
        throw error
      }
    }

    function assertMetadataWithinLimits(metadata, label) {
      assertJsonWithinLimits(metadata, label, true)
    }

    function assertMimeBundleWithinLimits(bundle, label) {
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return
      for (const mime in bundle) {
        if (Object.hasOwn(bundle, mime) && JSON_MIME_PATTERN.test(mime)) {
          assertJsonWithinLimits(bundle[mime], label + ' JSON')
        }
      }
    }

    function notebookSaveSnapshot(notebook) {
      // Remove transient fields before charging the disk budget. Bound these
      // shallow copies too, before joining source arrays or formatting JSON.
      let nodes = 0
      function charge(value, isOutput = false) {
        nodes += 1
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue
          if (isOutput && (key === 'display_id' || (key === 'execution_count' && value.output_type !== 'execute_result'))) continue
          nodes += 1
          if (nodes > NOTEBOOK_NODE_LIMIT) {
            const error = new Error('Notebook exceeds its maximum node count')
            error.code = 'json-too-complex'
            throw error
          }
        }
        if (nodes > NOTEBOOK_NODE_LIMIT) {
          const error = new Error('Notebook exceeds its maximum node count')
          error.code = 'json-too-complex'
          throw error
        }
      }
      charge(notebook)
      const cells = []
      for (const cell of notebook.cells) {
        charge(cell)
        if (cell.cell_type !== 'code' || !Array.isArray(cell.outputs)) {
          cells.push(cell)
          continue
        }
        const outputs = []
        for (const output of cell.outputs) {
          charge(output, true)
          outputs.push(stripIllegalOutputFields(output))
        }
        cells.push({ ...cell, outputs })
      }
      return { ...notebook, cells }
    }

    function assertNotebookStructureWithinLimits(notebook) {
      // Bound the complete input before normalization clones cells or joins
      // source arrays. The final disk projection is measured separately.
      measureJsonBytes(notebook, {
        limit: NOTEBOOK_CAP_BYTES, space: 0,
        nodeLimit: NOTEBOOK_NODE_LIMIT, depthLimit: NOTEBOOK_DEPTH_LIMIT,
      })
      assertMetadataWithinLimits(notebook.metadata, 'Notebook metadata')
      for (const cell of notebook.cells) {
        assertMetadataWithinLimits(cell.metadata, 'Cell metadata')
        if (cell.attachments && typeof cell.attachments === 'object') {
          for (const name in cell.attachments) {
            if (Object.hasOwn(cell.attachments, name)) {
              assertMimeBundleWithinLimits(cell.attachments[name], 'Attachment')
            }
          }
        }
        if (!Array.isArray(cell.outputs)) continue
        for (const output of cell.outputs) {
          assertMetadataWithinLimits(output?.metadata, 'Output metadata')
          assertMimeBundleWithinLimits(output?.data, 'Output')
        }
      }
    }

    function metadataRecoveryAction(notebook) {
      // Offer clearing only when it actually removes every structural problem,
      // including JSON attachments and a budget shared across many cells.
      if (notebook.cells.length > NOTEBOOK_NODE_LIMIT) return 'reload'
      const cleared = {
        ...notebook,
        cells: notebook.cells.map((cell) => cell.cell_type === 'code' ? { ...cell, outputs: [] } : cell),
      }
      return notebookCapacity(cleared).ok ? 'clear-outputs' : 'reload'
    }

    // Older Safari (<16.4) cannot parse lookbehind; each line keeps its newline.
    function splitSourceLines(source, budget = { lines: 0 }) {
      const lines = []
      let start = 0
      while (start < source.length) {
        if (++budget.lines > NOTEBOOK_NODE_LIMIT) {
          const error = new Error('Notebook exceeds its maximum node count')
          error.code = 'json-too-complex'
          throw error
        }
        const newline = source.indexOf('\n', start)
        const end = newline === -1 ? source.length : newline + 1
        lines.push(source.slice(start, end))
        start = end
      }
      return lines
    }

    function notebookDiskValue(notebook) {
      const snapshot = notebookSaveSnapshot(notebook)
      assertNotebookStructureWithinLimits(snapshot)
      const value = normalizeNotebook(snapshot)
      value.nbformat = 4
      value.nbformat_minor = 5
      const budget = { lines: 0 }
      value.cells = value.cells.map((cell) => ({
        ...cell,
        source: splitSourceLines(String(cell.source ?? ''), budget),
      }))
      return value
    }

    function notebookBytes(value, limit) {
      return measureJsonBytes(value, {
        limit: Math.max(0, limit - 1), space: 2,
        nodeLimit: NOTEBOOK_NODE_LIMIT, depthLimit: NOTEBOOK_DEPTH_LIMIT,
      }) + 1
    }

    function serializeNotebook(notebook) {
      const value = notebookDiskValue(notebook)
      notebookBytes(value, NOTEBOOK_CAP_BYTES)
      return JSON.stringify(value, null, 2) + '\n'
    }

    // Match the server's pretty-printed UTF-8 disk budget, including its newline,
    // before allocating either the JSON string or an encoded copy.
    const NOTEBOOK_CAP_BYTES = 32 * 1024 * 1024
    const notebookCapacities = new WeakMap()

    function notebookCapacity(notebook, limit = NOTEBOOK_CAP_BYTES) {
      if (!notebook || !Array.isArray(notebook.cells)) return { ok: true, bytes: 0 }
      const cacheable = limit === NOTEBOOK_CAP_BYTES
      if (cacheable && notebookCapacities.has(notebook)) return notebookCapacities.get(notebook)
      let result
      try {
        const bytes = notebookBytes(notebookDiskValue(notebook), limit)
        result = { ok: bytes <= limit, bytes }
      } catch (error) {
        if (error && (error.code === 'metadata-too-complex' || error.code === 'json-too-complex')) {
          result = { ok: false, reason: error.code, bytes: 0 }
        } else if (error && error.code === 'json-too-large') {
          // The early-exit count is a lower bound, not an exact oversized size.
          result = { ok: false, bytes: error.bytes + 1 }
        } else if (error instanceof RangeError) {
          result = { ok: false, reason: 'capacity', bytes: NOTEBOOK_CAP_BYTES }
        } else {
          throw error
        }
      }
      if (cacheable) notebookCapacities.set(notebook, result)
      return result
    }

    function interpolateText(text, params) {
      return String(text).replace(/\{([^{}]+)\}/g, (match, key) => (
        params && Object.hasOwn(params, key) ? String(params[key]) : match
      ))
    }

    function capacityText(bytes) {
      return interpolateText(t('capacityTooLarge'), { size: (bytes / 1048576).toFixed(1) })
    }

    function capacityNoOutputsText(bytes) {
      return interpolateText(t('capacityNoOutputs'), { size: (bytes / 1048576).toFixed(1) })
    }

    // Banner state keeps translatable copy as keys and params. `text` is only
    // for untranslatable server details (or a standalone dynamic message), and
    // `textKey` covers a second translated phrase such as the install hint.
    function bannerText(banner) {
      if (!banner) return ''
      if (!banner.key) return String(banner.text ?? '')
      let text = interpolateText(t(banner.key), banner.params)
      const suffix = banner.textKey ? t(banner.textKey) : banner.text
      if (suffix) text += (banner.separator ?? ': ') + String(suffix)
      return text
    }

    function cellTypeLabel(type) {
      if (type === 'markdown') return t('markdownCell')
      if (type === 'raw') return t('rawCell')
      return t('codeCell')
    }

    function toBase64(value) {
      if (typeof btoa !== 'function') return ''
      try {
        const bytes = new TextEncoder().encode(value)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary)
      } catch {
        return ''
      }
    }

    function imageSource(data, mime) {
      if (typeof mime !== 'string' || !/^image\//i.test(mime)) return ''
      const value = Array.isArray(data) ? data.join('') : String(data ?? '')
      if (!value) return ''
      // image/jpg is a common alias; nbformat/Jupyter expect image/jpeg.
      const normalized = mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime
      return 'data:' + normalized + ';base64,' + (normalized === 'image/svg+xml' ? toBase64(value) : value)
    }

    function makeImageResolver(ctx, scope, notebookPath, cell) {
      const attachments = (cell && cell.attachments) || {}
      let base = null
      if (notebookPath && isAbsoluteLocalPath(notebookPath)) base = dirnamePosix(notebookPath)
      else if (scope && scope.cwd) base = dirnamePosix(normalizePosix(String(scope.cwd).replace(/\/$/, '') + '/' + notebookPath))
      const fileUrl = (target) => {
        const params = new URLSearchParams()
        if (scope && scope.sessionId) params.set('sessionId', scope.sessionId)
        params.set('path', target)
        if (scope && scope.cwd) params.set('cwd', scope.cwd)
        return ctx.betterSidebar.hostRouteUrl('sidebar/file?' + params.toString())
      }
      return (source) => {
        if (!source) return null
        if (source.startsWith('attachment:')) {
          let name
          try {
            name = decodeURIComponent(source.slice('attachment:'.length))
          } catch {
            // A malformed percent escape must not throw during render: degrade
            // to the missing-image marker instead.
            return null
          }
          const attachment = attachments[name]
          if (!attachment) return null
          const mime = Object.keys(attachment).find((candidate) => /^image\//i.test(candidate))
          if (!mime) return null
          return imageSource(attachment[mime], mime)
        }
        if (/^data:image\//i.test(source)) return source
        if (/^https?:\/\//i.test(source)) return source
        if (isAbsoluteLocalPath(source)) return fileUrl(normalizePosix(source))
        if (!base) return null
        return fileUrl(normalizePosix(base + '/' + source))
      }
    }

    function updateCell(notebook, cellId, updater) {
      if (!notebook) return notebook
      let changed = false
      const cells = notebook.cells.map((cell) => {
        if (cell.id !== cellId) return cell
        const next = updater(cell)
        if (next !== cell) changed = true
        return next
      })
      return changed ? { ...notebook, cells } : notebook
    }

    const MAX_CELL_OUTPUT_BYTES = 32 * 1024 * 1024
    const OUTPUT_EVENTS = new Set(['stream', 'display_data', 'execute_result', 'error', 'update_display_data', 'clear_output'])
    const outputSizes = new WeakMap()
    const outputBudgets = new WeakMap()

    function jsonBytes(value) {
      return measureJsonBytes(value ?? null, {
        space: 0,
        limit: MAX_CELL_OUTPUT_BYTES,
        nodeLimit: NOTEBOOK_NODE_LIMIT,
        depthLimit: NOTEBOOK_DEPTH_LIMIT,
      })
    }

    function outputSize(output) {
      if (!output || typeof output !== 'object') return jsonBytes(output)
      if (!outputSizes.has(output)) outputSizes.set(output, jsonBytes(output))
      return outputSizes.get(output)
    }

    // Arrays and their output objects are immutable snapshots. These caches
    // retain no discarded snapshots and never mutate an earlier budget, so
    // React can defer or replay an updater without consuming the budget twice.
    // Internal state is not attached to notebook data or written to disk.
    function outputBudget(outputs) {
      if (!outputBudgets.has(outputs)) {
        const bytes = 2 + Math.max(0, outputs.length - 1) + outputs.reduce((sum, output) => sum + outputSize(output), 0)
        outputBudgets.set(outputs, { bytes, pendingClear: false, truncation: null })
      }
      return outputBudgets.get(outputs)
    }

    function outputsSize(outputs) {
      return outputBudget(Array.isArray(outputs) ? outputs : []).bytes
    }

    function rememberOutputs(outputs, bytes) {
      outputBudgets.set(outputs, { bytes, pendingClear: false, truncation: null })
      return outputs
    }

    function limitedOutputs() {
      const outputs = [{ output_type: 'stream', name: 'stderr', text: '…[output limit reached, remaining output dropped]' }]
      outputBudgets.set(outputs, { bytes: 2 + outputSize(outputs[0]), pendingClear: false, truncation: {} })
      return outputs
    }

    function reduceOutputs(previous, event) {
      try {
        return reduceOutputsWithinLimits(previous, event)
      } catch (error) {
        if (error?.code === 'json-too-large' || error?.code === 'json-too-complex'
          || error?.code === 'metadata-too-complex'
          || (error instanceof TypeError && /JSON|circular/i.test(error.message))) {
          return limitedOutputs()
        }
        throw error
      }
    }

    function reduceOutputsWithinLimits(previous, event) {
      let outputs = Array.isArray(previous) ? previous : []
      if (!event || !OUTPUT_EVENTS.has(event.type)) return outputs
      // Even invalid retained output must remain clearable.
      if (event.type === 'clear_output' && !event.wait) return []
      let budget = outputBudget(outputs)
      if (event.type === 'clear_output') {
        if (budget.pendingClear) return outputs
        const next = outputs.slice()
        outputBudgets.set(next, { ...budget, pendingClear: true })
        return next
      }
      if (event.type === 'update_display_data' && !event.display_id) return outputs
      // Consume deferred clears in the same update queue as output events,
      // before consulting the truncation lock or old display IDs.
      if (budget.pendingClear) {
        outputs = []
        budget = outputBudget(outputs)
      }
      if (budget.truncation) return outputs

      if (event.type === 'update_display_data') {
        const matches = []
        for (let index = 0; index < outputs.length; index += 1) {
          if (outputs[index].display_id === event.display_id) matches.push(index)
        }
        if (!matches.length) return outputs
        const data = event.data || {}
        const metadata = event.metadata || {}
        assertMimeBundleWithinLimits(data, 'Output JSON')
        assertMetadataWithinLimits(metadata, 'Output metadata')
        const payloadBytes = jsonBytes(data) + jsonBytes(metadata)
        const replacements = []
        let bytes = budget.bytes
        for (const index of matches) {
          const old = outputs[index]
          // Measure the shared payload once, including all nested values and
          // keys. Each matching display slot still consumes its full size.
          const size = jsonBytes({ ...old, data: null, metadata: null }) - 8 + payloadBytes
          bytes += size - outputSize(old)
          const replacement = { ...old, data, metadata }
          outputSizes.set(replacement, size)
          replacements.push(replacement)
        }
        if (bytes > MAX_CELL_OUTPUT_BYTES) return limitedOutputs()
        const next = outputs.slice()
        matches.forEach((index, offset) => { next[index] = replacements[offset] })
        return rememberOutputs(next, bytes)
      }

      let output
      if (event.type === 'stream') {
        output = { output_type: 'stream', name: event.name || 'stdout', text: String(event.text || '') }
      } else if (event.type === 'error') {
        output = {
          output_type: 'error', ename: event.ename || 'Error', evalue: event.evalue || '',
          traceback: Array.isArray(event.traceback) ? event.traceback : [],
        }
      } else {
        output = { output_type: event.type, data: event.data || {}, metadata: event.metadata || {} }
        assertMimeBundleWithinLimits(output.data, 'Output JSON')
        assertMetadataWithinLimits(output.metadata, 'Output metadata')
        if (event.type === 'execute_result' && Number.isInteger(event.execution_count)) output.execution_count = event.execution_count
        if (event.display_id) output.display_id = event.display_id
      }
      const last = outputs[outputs.length - 1]
      if (output.output_type === 'stream' && last?.output_type === 'stream' && last.name === output.name) {
        let merged, size
        if (typeof last.text === 'string') {
          let delta = jsonBytes(output.text) - 2 // exclude the JSON string quotes
          // A surrogate pair split across chunks replaces two six-byte JSON
          // escapes with one four-byte UTF-8 code point when concatenated.
          const tail = last.text.charCodeAt(last.text.length - 1)
          const head = output.text.charCodeAt(0)
          if (tail >= 0xd800 && tail <= 0xdbff && head >= 0xdc00 && head <= 0xdfff) delta -= 8
          size = outputSize(last) + delta
          if (budget.bytes + delta > MAX_CELL_OUTPUT_BYTES) return limitedOutputs()
          merged = { ...last, text: last.text + output.text }
        } else {
          merged = { ...last, text: mimeText(last.text) + output.text }
          size = outputSize(merged)
          if (budget.bytes - outputSize(last) + size > MAX_CELL_OUTPUT_BYTES) return limitedOutputs()
        }
        outputSizes.set(merged, size)
        return rememberOutputs([...outputs.slice(0, -1), merged], budget.bytes - outputSize(last) + size)
      }
      const bytes = budget.bytes + outputSize(output) + (outputs.length ? 1 : 0)
      if (bytes > MAX_CELL_OUTPUT_BYTES) return limitedOutputs()
      return rememberOutputs([...outputs, output], bytes)
    }

    // Text MIME values in nbformat may be a string or an array of lines.
    // Joining with '' is correct; String(array) would insert commas.
    function mimeText(value) {
      if (Array.isArray(value)) return value.join('')
      return value == null ? '' : String(value)
    }

    function renderJsonOutput(value, nodeLimit = JSON_NODE_LIMIT, depthLimit = JSON_DEPTH_LIMIT) {
      try {
        measureJsonBytes(value, { limit: MAX_CELL_OUTPUT_BYTES, nodeLimit, depthLimit })
        // A top-level string is JSON (show it quoted), objects get pretty print.
        return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value, null, 2)
      } catch {
        return '[unserializable JSON output]'
      }
    }

    function renderMimeBundle(bundle) {
      try {
        assertMimeBundleWithinLimits(bundle, 'Output JSON')
        return renderJsonOutput(bundle, NOTEBOOK_NODE_LIMIT, NOTEBOOK_DEPTH_LIMIT)
      } catch {
        return '[unserializable JSON output]'
      }
    }

    function OutputView({ output, resolveImage }) {
      if (!output || typeof output !== 'object') return null
      if (output.output_type === 'stream') {
        return h('pre', {
          className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-stream dsh-bsb-ipynb-stream-' + (output.name || 'stdout'),
          tabIndex: 0,
          dangerouslySetInnerHTML: { __html: ansiToHtml(mimeText(output.text)) },
        })
      }
      if (output.output_type === 'error') {
        const text = Array.isArray(output.traceback) && output.traceback.length
          ? output.traceback.join('\n')
          : String(output.ename || 'Error') + ': ' + String(output.evalue || '')
        return h('pre', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-error', tabIndex: 0, dangerouslySetInnerHTML: { __html: ansiToHtml(text) } })
      }
      const data = output.data || {}
      const htmlText = data['text/html'] != null ? mimeText(data['text/html']) : null
      // An empty text/html must not hide a usable text/plain fallback.
      const html = htmlText !== null && htmlText.trim() !== '' ? htmlText : null
      if (html !== null) {
        return h('div', {
          className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-html',
          // HTML outputs can embed the same attachment:/relative image sources
          // as markdown; route them through the local image resolver after
          // sanitizing so the whitelist and URL policy stay in force.
          dangerouslySetInnerHTML: { __html: sanitizeHtml(html, { resolveImage }) },
        })
      }
      if (data['image/svg+xml'] != null) {
        const src = imageSource(data['image/svg+xml'], 'image/svg+xml')
        if (src) return h('img', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-image', src, alt: t('outputImage') })
      }
      const png = data['image/png'] != null ? imageSource(data['image/png'], 'image/png') : null
      if (png) return h('img', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-image', src: png, alt: t('outputImage') })
      const jpegValue = data['image/jpeg'] != null ? data['image/jpeg'] : data['image/jpg']
      const jpeg = jpegValue != null ? imageSource(jpegValue, 'image/jpeg') : null
      if (jpeg) return h('img', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-image', src: jpeg, alt: t('outputImage') })
      if (data['text/markdown'] != null) {
        return h('div', {
          className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-markdown',
          // Output markdown can reference attachment:/relative images just like
          // markdown cells, so use the image-aware renderer here too.
          dangerouslySetInnerHTML: { __html: renderMarkdownWithImages(mimeText(data['text/markdown']), resolveImage) },
        })
      }
      if (typeof data['application/json'] !== 'undefined') {
        return h('pre', { className: 'dsh-bsb-ipynb-output', tabIndex: 0 }, renderJsonOutput(data['application/json']))
      }
      if (data['text/latex'] != null) {
        return h('pre', { className: 'dsh-bsb-ipynb-output', tabIndex: 0 }, mimeText(data['text/latex']))
      }
      if (data['text/plain'] != null) {
        return h('pre', { className: 'dsh-bsb-ipynb-output', tabIndex: 0 }, mimeText(data['text/plain']))
      }
      return h('pre', { className: 'dsh-bsb-ipynb-output', tabIndex: 0 }, renderMimeBundle(data))
    }

    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-bsb-ipynb-button' + (props.className ? ' ' + props.className : ''),
          title: props.title,
          'aria-label': props.title,
          disabled: props.disabled,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    // Remove up to one indent unit (four spaces or one tab) from the line that
    // contains the caret; used by Shift+Tab in the cell editor.
    function dedentSourceLine(source, caret) {
      const lineStart = source.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
      let remove = 0
      while (remove < 4 && source[lineStart + remove] === ' ') remove += 1
      if (remove === 0 && source[lineStart] === '\t') remove = 1
      if (remove === 0) return { source, caret }
      return {
        source: source.slice(0, lineStart) + source.slice(lineStart + remove),
        caret: Math.max(lineStart, caret - remove),
      }
    }

    function CellView(props) {
      const { cell, index, count, ctx, scope, notebookPath, editing, running, busy, onEdit, onDone, onSource, onRun, onMove, onDelete, onType, onInsertBelow, onSave, onClearOutputs } = props
      const textareaRef = useRef(null)
      const source = cell.source ?? ''
      const resolveImage = useMemo(
        () => makeImageResolver(ctx, scope, notebookPath, cell),
        [ctx, scope, notebookPath, cell.attachments],
      )
      useEffect(() => {
        const element = textareaRef.current
        if (!element) return
        element.style.height = 'auto'
        element.style.height = Math.max(48, element.scrollHeight) + 'px'
      }, [source, editing])
      const onKeyDown = (event) => {
        if (isImeKeyEvent(event)) return
        if (event.key === 'Escape') {
          event.preventDefault()
          onDone()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          onRun(cell.id)
        } else if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault()
          onRun(cell.id)
          props.onRunAndNext(cell.id)
        } else if (event.key === 'Enter' && event.altKey) {
          event.preventDefault()
          onInsertBelow(cell.id)
        } else if (isSaveShortcut(event)) {
          event.preventDefault()
          onSave()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          const element = event.currentTarget
          const start = element.selectionStart
          const end = element.selectionEnd
          if (event.shiftKey) {
            const dedented = dedentSourceLine(source, start)
            if (dedented.source !== source) {
              onSource(cell.id, dedented.source)
              requestAnimationFrame(() => {
                element.selectionStart = element.selectionEnd = dedented.caret
              })
            }
          } else {
            const next = source.slice(0, start) + '    ' + source.slice(end)
            onSource(cell.id, next)
            requestAnimationFrame(() => {
              element.selectionStart = element.selectionEnd = start + 4
            })
          }
        }
      }
      const code = cell.cell_type === 'code'
      const markdown = cell.cell_type === 'markdown'
      return h(
        'div',
        {
          className: 'dsh-bsb-ipynb-cell dsh-bsb-ipynb-cell-' + cell.cell_type + (running ? ' dsh-bsb-ipynb-cell-running' : ''),
          // Reading-mode keyboard shortcuts resolve their target cell by walking
          // up from the event target to this container.
          'data-cell-id': cell.id,
        },
        h(
          'div',
          { className: 'dsh-bsb-ipynb-cell-head' },
          h('span', { className: 'dsh-bsb-ipynb-prompt' }, code ? (cell.execution_count == null ? '[ ]' : '[' + cell.execution_count + ']') : markdown ? 'M' : 'R'),
          h('span', { className: 'dsh-bsb-ipynb-cell-label' }, cellTypeLabel(cell.cell_type)),
          h(
            'div',
            { className: 'dsh-bsb-ipynb-cell-actions' },
            code
              ? h(IconButton, { title: t('runCell'), disabled: busy, onClick: () => onRun(cell.id) }, running ? '…' : t('run'))
              : null,
            code && Array.isArray(cell.outputs) && cell.outputs.length
              ? h(IconButton, { title: t('clearCellOutputs'), onClick: () => onClearOutputs(cell.id) }, '⌫')
              : null,
            h(IconButton, { title: editing ? t('doneEditing') : t('editCell'), onClick: () => (editing ? onDone() : onEdit(cell.id)) }, editing ? t('doneEditing') : t('editCell')),
            h(IconButton, { title: t('moveUp'), disabled: index === 0, onClick: () => onMove(cell.id, -1) }, '↑'),
            h(IconButton, { title: t('moveDown'), disabled: index === count - 1, onClick: () => onMove(cell.id, 1) }, '↓'),
            h(IconButton, { title: t('deleteCell'), onClick: () => onDelete(cell.id) }, '×'),
            h(
              'select',
              {
                className: 'dsh-bsb-ipynb-cell-type',
                value: cell.cell_type,
                title: t('codeCell') + ' / ' + t('markdownCell'),
                'aria-label': t('cellType'),
                onChange: (event) => onType(cell.id, event.target.value),
              },
              h('option', { value: 'code' }, t('codeCell')),
              h('option', { value: 'markdown' }, t('markdownCell')),
              h('option', { value: 'raw' }, t('rawCell')),
            ),
          ),
        ),
        code
          ? editing
            ? h('textarea', {
                ref: textareaRef,
                className: 'dsh-bsb-ipynb-source-editor',
                'aria-label': cellTypeLabel(cell.cell_type),
                value: source,
                spellCheck: false,
                autoFocus: true,
                onChange: (event) => onSource(cell.id, event.target.value),
                onKeyDown,
              })
            : h('pre', {
                className: 'dsh-bsb-ipynb-source',
                tabIndex: 0,
                onClick: () => onEdit(cell.id),
                onKeyDown: (event) => {
                  if (!isImeKeyEvent(event) && event.key === 'Enter') onEdit(cell.id)
                },
                dangerouslySetInnerHTML: { __html: source ? highlightPython(source) : '<span class="dsh-bsb-ipynb-empty-source"> </span>' },
              })
          : markdown
            ? editing
              ? h('textarea', {
                  ref: textareaRef,
                  className: 'dsh-bsb-ipynb-source-editor',
                  'aria-label': cellTypeLabel(cell.cell_type),
                  value: source,
                  spellCheck: false,
                  autoFocus: true,
                  onChange: (event) => onSource(cell.id, event.target.value),
                  onKeyDown,
                })
              : h('div', {
                  className: 'dsh-bsb-ipynb-markdown',
                  dangerouslySetInnerHTML: { __html: renderMarkdownWithImages(source, resolveImage) },
                })
            : editing
              ? h('textarea', {
                  ref: textareaRef,
                  className: 'dsh-bsb-ipynb-source-editor',
                  'aria-label': cellTypeLabel(cell.cell_type),
                  value: source,
                  spellCheck: false,
                  autoFocus: true,
                  onChange: (event) => onSource(cell.id, event.target.value),
                  onKeyDown,
                })
              : h('pre', {
                  className: 'dsh-bsb-ipynb-raw',
                  tabIndex: 0,
                  onClick: () => onEdit(cell.id),
                  onKeyDown: (event) => {
                    if (!isImeKeyEvent(event) && event.key === 'Enter') onEdit(cell.id)
                  },
                }, source),
        code && Array.isArray(cell.outputs) && cell.outputs.length
          ? h('div', { className: 'dsh-bsb-ipynb-outputs', role: 'log', 'aria-live': 'polite' }, cell.outputs.map((output, outputIndex) => h(OutputView, { key: outputIndex, output, resolveImage })))
          : null,
      )
    }

    function Toolbar(props) {
      const { kernel, python, interpreters, running, runAllRunning, onRunAll, onInterrupt, onRestart, onShutdown, onSave, onReload, onPython, saveState, dirty, conflict } = props
      const state = kernel.executionState === 'stopping' ? t('stopping') : kernel.busy ? t('busy') : !kernel.running ? t('off') : t('idle')
      return h(
        'div',
        { className: 'dsh-bsb-ipynb-toolbar' },
        h(
          'div',
          { className: 'dsh-bsb-ipynb-toolbar-group' },
          h('span', {
            className:
              'dsh-bsb-ipynb-kernel-dot' +
              (kernel.busy ? ' is-busy' : kernel.running ? ' is-ready' : ''),
            title: t('kernel') + ': ' + state,
          }),
          h('span', { className: 'dsh-bsb-ipynb-kernel-label', 'aria-live': 'polite' }, state),
          h(
            'select',
            {
              className: 'dsh-bsb-ipynb-python-select',
              title: t('python'),
              'aria-label': t('python'),
              value: python || '',
              disabled: running,
              onChange: (event) => onPython(event.target.value),
            },
            interpreters.length
              ? interpreters.map((entry) =>
                  h('option', { key: entry.path, value: entry.path }, (entry.label || entry.path) + (entry.ok ? '' : ' — unavailable')),
                )
              : h('option', { value: '' }, t('kernelUnavailable')),
          ),
        ),
        h(
          'div',
          { className: 'dsh-bsb-ipynb-toolbar-group' },
          h(IconButton, { title: t('runAll'), disabled: running || runAllRunning, onClick: onRunAll }, '▶▶'),
          h(IconButton, { title: t('interrupt'), disabled: !kernel.running, onClick: onInterrupt }, '■'),
          h(IconButton, { title: t('restart'), disabled: !kernel.running || running, onClick: () => onRestart() }, '↻'),
          h(IconButton, { title: t('save'), disabled: saveButtonDisabled({ dirty, saveState, conflict, running }), onClick: onSave }, saveState === 'saving' ? '…' : t('save')),
          h(IconButton, { title: t('reload'), onClick: onReload }, t('reload')),
          h(IconButton, { title: t('shutdown'), disabled: !kernel.running, onClick: onShutdown }, '⏻'),
        ),
        saveState === 'saved'
          ? h('span', { className: 'dsh-bsb-ipynb-save-state' }, t('saved'))
          : saveState === 'failed'
            ? h('span', { className: 'dsh-bsb-ipynb-save-state is-error' }, t('saveFailed'))
            : null,
      )
    }

    function Banner({ banner, onReload, onClearOutputs }) {
      if (!banner) return null
      const kind = banner.kind || 'info'
      return h(
        'div',
        {
          className: 'dsh-bsb-ipynb-banner dsh-bsb-ipynb-banner-' + kind,
          role: kind === 'error' ? 'alert' : 'status',
        },
        h('span', { className: 'dsh-bsb-ipynb-banner-text' }, bannerText(banner)),
        banner.action === 'reload'
          ? h(IconButton, { title: t('reload'), onClick: onReload }, t('reload'))
          : banner.action === 'clear-outputs'
            ? h(IconButton, { title: t('clearAllOutputs'), onClick: onClearOutputs }, t('clearAllOutputs'))
            : null,
      )
    }

    function NotebookView(props) {
      const { ctx, scope, path, customData, onToolbarState, visible } = props
      const pluginSettings = usePluginSettings(props.store)
      const autosaveMs = pluginSettings.autosaveMs
      const defaultPython = pluginSettings.defaultPython
      // Re-render when the host locale preference (or a late dictionary
      // registration) changes, so the bound translate yields the new strings.
      // The locale service is optional: without it the browser fallback stands
      // and the subscription is a no-op.
      const localeFace = localeFaceOf(ctx)
      const subscribeLocale = useCallback(
        (notify) => (localeFace ? localeFace.subscribe(notify) : () => {}),
        [localeFace],
      )
      const readLocaleRevision = useCallback(
        () => (localeFace ? localeFace.getSnapshot().revision : 0),
        [localeFace],
      )
      useSyncExternalStore(subscribeLocale, readLocaleRevision, readLocaleRevision)
      const initial = customData && typeof customData === 'object' ? customData : { status: 'loading' }
      const [loadStatus, setLoadStatus] = useState(initial.status || 'loading')
      const [loadError, setLoadError] = useState(initial.error || null)
      const [loadMessage, setLoadMessage] = useState(initial.message || null)
      const [notebook, setNotebook] = useState(initial.status === 'ok' && initial.notebook ? normalizeNotebook(initial.notebook) : null)
      const [version, setVersion] = useState(initial.version || '')
      const [emptyFile, setEmptyFile] = useState(Boolean(initial.emptyFile))
      const [dirty, setDirty] = useState(false)
      const [saveState, setSaveState] = useState('idle')
      const [conflict, setConflict] = useState(null)
      const [banner, setBanner] = useState(null)
      const [autosaveBlocked, setAutosaveBlocked] = useState(false)
      const [autosaveDelay, setAutosaveDelay] = useState(autosaveMs)
      const [capacityBlocked, setCapacityBlocked] = useState(false)
      const [reloading, setReloading] = useState(false)
      const [editingCell, setEditingCell] = useState(null)
      const [runningCell, setRunningCell] = useState(null)
      const [runAllRunning, setRunAllRunning] = useState(false)
      const [kernel, setKernel] = useState({ running: false, ready: false, busy: false, python: null, executionState: 'none', lastError: null })
      const [interpreters, setInterpreters] = useState([])
      const [python, setPython] = useState('')
      // A settings save applies to already-open notebooks without a remount.
      useEffect(() => {
        setAutosaveDelay(autosaveMs)
      }, [autosaveMs])
      // The host owns the idle sweep; push an explicitly configured value once
      // (the settings panel does the same) so a reloaded host recovers it.
      useEffect(() => {
        const idle = pluginSettings.idleMinutes
        if (!Number.isInteger(idle) || idle < 0 || idle > IDLE_MAX_MINUTES) return undefined
        if (lastSyncedIdleMinutes === idle) return undefined
        const previous = lastSyncedIdleMinutes
        lastSyncedIdleMinutes = idle
        postJson(ctx, 'config', { idleMinutes: idle }).catch(() => {
          if (lastSyncedIdleMinutes === idle) lastSyncedIdleMinutes = previous
        })
        return undefined
      }, [ctx, pluginSettings.idleMinutes])
      const customRef = useRef(customData)
      const dirtyRef = useRef(false)
      const notebookRef = useRef(notebook)
      const versionRef = useRef(version)
      const runningRef = useRef(null)
      const activeRunRef = useRef(null)
      const savingRef = useRef(null)
      const saveRef = useRef(null)
      const pythonRef = useRef('')
      const reloadRequestRef = useRef(0)
      const reloadWaitingRef = useRef(null)
      const saveTimerRef = useRef(null)
      const stopRef = useRef(false)
      const runAllRef = useRef(null)
      const abortRef = useRef(null)
      const pollRef = useRef(null)
      const failedSnapshotRef = useRef(null)
      const documentSeqRef = useRef(0)
      const notebookRevisionRef = useRef(0)
      const notebookEditRevisionRef = useRef(0)
      const notifiedTruncationsRef = useRef(new WeakSet())
      // Reading-mode shortcuts: the focused cell wins, then the most recently
      // edited or run cell. These refs let the single window listener commit to
      // an action without re-subscribing on every render.
      const activeCellRef = useRef(null)
      const runCellRef = useRef(null)
      const loadStatusRef = useRef(loadStatus)
      // The host may keep an inactive viewer mounted. Window shortcuts belong
      // to the visible instance only; `false` gates them, `undefined` (older
      // hosts that do not pass the prop) keeps the pre-gating behavior.
      const visibleRef = useRef(visible)
      // Kernel generation: every authoritative transition (run start/end,
      // kernel_died/fatal, restart/shutdown, reload/adopt) advances the epoch so
      // a /status response captured before it can never overwrite the newer
      // state. The request id orders concurrent GETs: only the latest commits.
      const kernelEpochRef = useRef(0)
      // User actions own control responses. Stream events advance the status
      // epoch, but an old run finishing must not invalidate its own shutdown.
      const kernelActionRef = useRef(0)
      const kernelRequestRef = useRef(0)
      const kernelAbortRef = useRef(null)

      dirtyRef.current = dirty
      notebookRef.current = notebook
      versionRef.current = version
      pythonRef.current = python
      loadStatusRef.current = loadStatus
      visibleRef.current = visible

      const markDirty = useCallback((fromExecution = false) => {
        if (!fromExecution) {
          notebookEditRevisionRef.current += 1
          // New user edits supersede a pending reload. Kernel results do not:
          // the user already confirmed that those unsaved results may be lost.
          reloadRequestRef.current += 1
          if (reloadWaitingRef.current) {
            reloadWaitingRef.current.controller?.abort()
            reloadWaitingRef.current = null
            setReloading(false)
          }
        }
        notebookRevisionRef.current += 1
        dirtyRef.current = true
        setDirty(true)
      }, [])

      // The generation of the kernel state only moves forward. Aborting an
      // in-flight status GET is an optimization: the epoch/request checks in
      // refreshKernel still reject a transport that already completed.
      const bumpKernelEpoch = useCallback(() => {
        kernelEpochRef.current += 1
        if (kernelAbortRef.current) {
          kernelAbortRef.current.abort()
          kernelAbortRef.current = null
        }
      }, [])

      const invalidateDocumentWork = useCallback(() => {
        // Invalidate first: aborting the old stream can immediately reject it.
        // A different document also means a different kernel generation.
        bumpKernelEpoch()
        kernelActionRef.current += 1
        documentSeqRef.current += 1
        notebookRevisionRef.current += 1
        notebookEditRevisionRef.current += 1
        reloadRequestRef.current += 1
        reloadWaitingRef.current?.controller?.abort()
        reloadWaitingRef.current = null
        // A replaced document has no "recently edited cell" yet.
        activeCellRef.current = null
        savingRef.current = null
        activeRunRef.current = null
        runningRef.current = null
        runAllRef.current = null
        stopRef.current = true
        notifiedTruncationsRef.current = new WeakSet()
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        if (abortRef.current) abortRef.current.abort()
        abortRef.current = null
      }, [bumpKernelEpoch])

      const adopt = useCallback((data) => {
        // A confirmed reload replaces the document; a cancelled prompt never
        // reaches this point and must leave its execution and draft intact.
        invalidateDocumentWork()
        setRunningCell(null)
        setRunAllRunning(false)
        setSaveState('idle')
        setCapacityBlocked(false)
        setReloading(false)
        // Every adoption, including an invalid/error response, starts a new
        // document generation. Failure and conflict state belongs to the old one.
        dirtyRef.current = false
        setDirty(false)
        setConflict(null)
        setAutosaveBlocked(false)
        setAutosaveDelay(autosaveMs)
        failedSnapshotRef.current = null
        setEditingCell(null)
        setEmptyFile(false)
        setBanner(null)
        if (!data || typeof data !== 'object') {
          setLoadStatus('error')
          setLoadError(null)
          setLoadMessage(t('invalidResponse'))
          notebookRef.current = null
          setNotebook(null)
          return
        }
        if (data.status === 'ok' && data.notebook) {
          setLoadStatus('ok')
          setLoadError(null)
          setLoadMessage(null)
          const nextNotebook = normalizeNotebook(data.notebook)
          notebookRef.current = nextNotebook
          setNotebook(nextNotebook)
          setVersion(data.version || '')
          versionRef.current = data.version || ''
          setEmptyFile(Boolean(data.emptyFile))
          setBanner(data.emptyFile ? { kind: 'info', reason: 'empty-file', key: 'emptyFile' } : null)
          return
        }
        notebookRef.current = null
        setNotebook(null)
        setVersion(data.version || '')
        versionRef.current = data.version || ''
        setLoadStatus(data.status || 'error')
        setLoadError(data.error || null)
        setLoadMessage(data.message || null)
      }, [invalidateDocumentWork, autosaveMs])

      useEffect(() => {
        if (customData === customRef.current) return
        customRef.current = customData
        // Host refreshes use the module-wide read/write barrier. Unsolicited
        // snapshots cannot replace a draft or an in-flight local write.
        if (dirtyRef.current || savingRef.current || reloadWaitingRef.current) return
        adopt(customData)
      }, [customData, adopt])

      const reload = useCallback(async () => {
        reloadWaitingRef.current?.controller?.abort()
        const read = {
          id: ++reloadRequestRef.current,
          seq: documentSeqRef.current,
          revision: notebookEditRevisionRef.current,
          controller: typeof AbortController === 'function' ? new AbortController() : null,
        }
        const isCurrentReload = () => read.id === reloadRequestRef.current &&
          read.seq === documentSeqRef.current && read.revision === notebookEditRevisionRef.current
        // Keep this barrier until adoption/cancellation completes. The host
        // callback has no completion or cancellation signal, so the plugin
        // owns its confirmation and read. Unmounting cannot cancel a commit:
        // the module-wide barrier also protects the next viewer's initial read.
        reloadWaitingRef.current = read
        setReloading(true)
        try {
          while (savingRef.current) {
            await savingRef.current.settled
            if (!isCurrentReload()) return
          }
          if (!isCurrentReload()) return
          if ((dirtyRef.current || runningRef.current || conflict) &&
            (typeof window === 'undefined' || !window.confirm || !window.confirm(t('reloadConfirm')))) return
          const data = await readNotebook(ctx, path, scope, read.controller?.signal)
          if (isCurrentReload()) adopt(data)
        } catch (error) {
          if (error?.name !== 'AbortError' && isCurrentReload()) {
            setBanner({ kind: 'error', key: 'loadError', text: error && error.message })
          }
        } finally {
          if (reloadWaitingRef.current === read) {
            reloadWaitingRef.current = null
            setReloading(false)
          }
        }
      }, [ctx, path, scope, conflict, adopt])

      const openAsEmpty = useCallback(() => {
        invalidateDocumentWork()
        setRunningCell(null)
        setRunAllRunning(false)
        setSaveState('idle')
        setCapacityBlocked(false)
        setReloading(false)
        const nextNotebook = emptyNotebook()
        notebookRef.current = nextNotebook
        setNotebook(nextNotebook)
        setLoadStatus('ok')
        setLoadError(null)
        setLoadMessage(null)
        dirtyRef.current = false
        setDirty(false)
        setConflict(null)
        setAutosaveBlocked(true)
        setAutosaveDelay(autosaveMs)
        failedSnapshotRef.current = null
        setEditingCell(null)
        setEmptyFile(false)
        // Keep version/versionRef from the failed read: the first save must CAS
        // against the invalid/unsupported file that is still on disk.
        setBanner({ kind: 'info', reason: 'empty-file', key: 'emptyHint' })
      }, [invalidateDocumentWork, autosaveMs])

      const save = useCallback(async () => {
        // All entry points (including Ctrl+S and an already queued autosave)
        // must avoid persisting the transient, cleared outputs of a running cell.
        if (runningRef.current || runAllRef.current || savingRef.current || reloadWaitingRef.current || !notebookRef.current || loadStatus !== 'ok') return
        if (conflict) {
          // A 409 blocks saving until the user reloads; surface that instead of
          // silently ignoring the click or Ctrl+S.
          setSaveState('failed')
          setBanner({ kind: 'error', reason: 'write-conflict', key: 'conflict', action: 'reload' })
          return
        }
        const snapshot = notebookRef.current
        const capacity = notebookCapacity(snapshot)
        if (!capacity.ok) {
          // Refuse before serializing the upload: a 413 after the fact would
          // repeat on every autosave and cannot be fixed by editing the source.
          setSaveState('failed')
          setCapacityBlocked(true)
          if (capacity.reason === 'metadata-too-complex' || capacity.reason === 'json-too-complex') {
            setBanner({
              kind: 'error',
              reason: capacity.reason,
              key: capacity.reason === 'metadata-too-complex' ? 'metadataTooComplex' : 'jsonTooComplex',
              action: metadataRecoveryAction(snapshot),
            })
          } else {
            // Only offer the clear-outputs action when it can actually help:
            // a notebook sized by source/attachments has no outputs to clear.
            const hasOutputs = snapshot.cells.some((cell) => (
              cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0
            ))
            const params = { size: (capacity.bytes / 1048576).toFixed(1) }
            if (hasOutputs) {
              setBanner({ kind: 'error', reason: 'capacity', key: 'capacityTooLarge', params, action: 'clear-outputs' })
            } else {
              setBanner({ kind: 'error', reason: 'capacity', key: 'capacityNoOutputs', params })
            }
          }
          return
        }
        setCapacityBlocked(false)
        const seq = documentSeqRef.current
        const revision = notebookRevisionRef.current
        let settleSave
        const request = { seq, settled: new Promise((resolve) => { settleSave = resolve }) }
        savingRef.current = request
        // A read already in flight predates this write, even if the snapshot
        // was not edited again. Its eventual response must not be adopted.
        reloadRequestRef.current += 1
        const isCurrentSave = () => savingRef.current === request && !isStaleSaveResponse(documentSeqRef.current, seq)
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        setSaveState('saving')
        setAutosaveBlocked(false)
        try {
          const value = await postJson(ctx, 'save', {
            sessionId: scope && scope.sessionId,
            path,
            // Never send display_id / schema-illegal output fields to the
            // server; the in-memory notebook keeps display_id for live updates.
            notebook: normalizeNotebook(snapshot),
            baseVersion: versionRef.current,
          })
          if (!isCurrentSave()) return
          versionRef.current = value.version
          setVersion(value.version)
          failedSnapshotRef.current = null
          if (notebookRef.current === snapshot && notebookRevisionRef.current === revision) {
            dirtyRef.current = false
            setDirty(false)
          } else {
            // The user kept typing while the request was in flight. Keep the
            // newer draft dirty and let the autosave effect write it too.
            dirtyRef.current = true
            setDirty(true)
          }
          setSaveState('saved')
          setAutosaveDelay(autosaveMs)
          setEmptyFile(false)
          setConflict(null)
          setBanner((current) => (current && SAVE_BANNER_REASONS.has(current.reason) ? null : current))
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(() => {
            setSaveState((current) => (!isStaleSaveResponse(documentSeqRef.current, seq) && current === 'saved' ? 'idle' : current))
          }, 1000)
        } catch (error) {
          if (!isCurrentSave()) return
          // Write-blocked retries the unchanged snapshot with the backoff below;
          // every other failure still waits for another notebook edit.
          failedSnapshotRef.current = error && error.code === 'write-blocked' ? null : snapshot
          setSaveState('failed')
          if (error && error.code === 'write-conflict') {
            setConflict((error.details && error.details.version) || 'conflict')
            setBanner({ kind: 'error', reason: 'write-conflict', key: 'conflict', action: 'reload' })
          } else if (error && error.code === 'write-blocked') {
            const readOnly = Boolean(error.details && error.details.reason === 'readonly')
            setBanner({
              kind: 'error',
              reason: 'write-blocked',
              key: readOnly ? 'saveBlockedReadonly' : 'saveBlockedLocked',
            })
            // Retry with backoff instead of hitting the same filesystem error
            // on every autosave tick.
            setAutosaveDelay((current) => blockedAutosaveDelay(current, autosaveMs))
          } else {
            setBanner({ kind: 'error', reason: 'save-failed', key: 'saveFailed', text: error && error.message })
          }
        } finally {
          if (isCurrentSave()) savingRef.current = null
          settleSave()
        }
      }, [ctx, path, scope, loadStatus, conflict, autosaveMs])

      saveRef.current = save

      const refreshKernel = useCallback(async () => {
        // Capture the generation and request id before the request leaves.
        // A kernel death, restart, shutdown or reload can advance the epoch
        // while the GET is in flight; a newer GET (poll or visible resume)
        // supersedes this one. Only a response that still owns both may
        // commit, so a late `{running:true,busy:true}` can never resurrect a
        // terminal toolbar state.
        const epoch = kernelEpochRef.current
        const requestId = ++kernelRequestRef.current
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        if (kernelAbortRef.current) kernelAbortRef.current.abort()
        kernelAbortRef.current = controller
        try {
          const value = await getJson(ctx, 'status', { sessionId: scope && scope.sessionId, path }, controller ? controller.signal : undefined)
          if (epoch !== kernelEpochRef.current || requestId !== kernelRequestRef.current) return
          setKernel(value)
        } catch {
          /* ignore: aborted, superseded and failed refreshes keep the last state */
        } finally {
          if (kernelAbortRef.current === controller) kernelAbortRef.current = null
        }
      }, [ctx, path, scope])

      useEffect(() => {
        if (typeof onToolbarState === 'function') {
          onToolbarState({
            modes: false,
            mode: 'edit',
            dirty: dirty || Boolean(runningCell) || saveState === 'failed' || Boolean(conflict),
            editable: false,
            saveState,
          })
        }
      }, [dirty, runningCell, saveState, conflict, onToolbarState])

      useEffect(() => {
        let cancelled = false
        let retryTimer = null
        const load = (attempt) => {
          getJson(ctx, 'interpreters')
            .then((value) => {
              if (cancelled) return
              const usable = (value.interpreters || []).filter((entry) => entry.ok)
              setInterpreters(usable)
              let stored = ''
              try {
                stored = window.localStorage.getItem('dsh-bsb-ipynb:python:' + path) || ''
              } catch {
                stored = ''
              }
              const chosen = usable.some((entry) => entry.path === stored)
                ? stored
                : usable.some((entry) => entry.path === defaultPython)
                  ? defaultPython
                  : usable.some((entry) => entry.path === value.default)
                    ? value.default
                    : usable[0] && usable[0].path
              if (chosen) setPython(chosen)
            })
            .catch(() => {
              // A transient failure must not disable Run all forever: retry once
              // and otherwise fall back to the server's default interpreter.
              if (cancelled || attempt > 0) return
              retryTimer = setTimeout(() => load(1), 2000)
            })
        }
        load(0)
        return () => {
          cancelled = true
          if (retryTimer) clearTimeout(retryTimer)
        }
      }, [ctx, path, defaultPython])

      useEffect(() => {
        if (loadStatus !== 'ok') return undefined
        refreshKernel()
        if (visible === false) return undefined
        pollRef.current = setInterval(() => {
          if (!runningRef.current) refreshKernel()
        }, STATUS_POLL_MS)
        return () => {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, [refreshKernel, visible, loadStatus])

      useEffect(() => {
        if (reloading) return undefined
        const changedSinceFailure = failedSnapshotRef.current === null || notebook !== failedSnapshotRef.current
        if (!shouldScheduleAutosave({ loadStatus, dirty, conflict, autosaveBlocked, capacityBlocked, runningCell, saveState, notebookChangedSinceFailure: changedSinceFailure })) return undefined
        const timer = setTimeout(() => {
          void saveRef.current()
        }, autosaveDelay)
        return () => clearTimeout(timer)
      }, [dirty, notebook, conflict, autosaveBlocked, capacityBlocked, saveState, loadStatus, runningCell, autosaveDelay, reloading])

      // Only committed output snapshots can trigger a notice. Replayed or
      // discarded React updaters must not leave a stale truncation flag.
      useEffect(() => {
        let hasTruncation = false
        let newTruncation = false
        for (const cell of notebook?.cells || []) {
          const token = outputBudgets.get(cell.outputs)?.truncation
          if (!token) continue
          hasTruncation = true
          if (notifiedTruncationsRef.current.has(token)) continue
          notifiedTruncationsRef.current.add(token)
          newTruncation = true
        }
        if (newTruncation) {
          setBanner((current) => (current && current.kind === 'error' ? current : { kind: 'info', reason: 'output-limit', key: 'outputTruncated' }))
        } else if (!hasTruncation) {
          setBanner((current) => current?.reason === 'output-limit' ? null : current)
        }
      }, [notebook])

      useEffect(() => {
        return () => {
          if (pollRef.current) clearInterval(pollRef.current)
          invalidateDocumentWork()
        }
      }, [invalidateDocumentWork])

      const updateRunCell = useCallback((seq, cellId, updater) => {
        // React may apply this after the stream has completed. Keep normal
        // terminal updates, but never apply them to a replacement document.
        setNotebook((previous) => isStaleSaveResponse(documentSeqRef.current, seq)
          ? previous
          : updateCell(previous, cellId, (cell) => cell.cell_type === 'code' ? updater(cell) : cell))
      }, [])

      const updateRunOutputs = useCallback((run, event) => {
        const { seq, cellId } = run
        if (event.type === 'update_display_data' && event.display_id) {
          // A display handle belongs to the notebook, not to the cell that
          // happens to call update(). Keep this in one ordered React update so
          // displays created earlier in the same batch are also visible here.
          setNotebook((previous) => {
            if (!previous || isStaleSaveResponse(documentSeqRef.current, seq)) return previous
            let changed = false
            const cells = previous.cells.map((cell) => {
              if (cell.cell_type !== 'code') return cell
              // The active cell still consumes its deferred clear, even for
              // an unmatched ID. Other cells only receive matching updates;
              // unrelated deferred clears must remain pending.
              if (cell.id !== cellId && !cell.outputs?.some((output) => output.display_id === event.display_id)) return cell
              const outputs = reduceOutputs(cell.outputs, event)
              if (outputs === cell.outputs) return cell
              if (cell.id !== cellId) {
                // Cache rollback provenance on the immutable result, just like
                // output budgets. Replayed/discarded updaters cannot change the
                // provenance of the snapshot that React eventually commits.
                run.displayOrigins.set(outputs, run.displayOrigins.get(cell.outputs) || cell.outputs)
              }
              changed = true
              return { ...cell, outputs }
            })
            return changed ? { ...previous, cells } : previous
          })
          return
        }
        updateRunCell(seq, cellId, (cell) => {
          const outputs = reduceOutputs(cell.outputs, event)
          return outputs === cell.outputs ? cell : { ...cell, outputs }
        })
      }, [updateRunCell])

      const handleEvent = useCallback((run, event) => {
        if (activeRunRef.current !== run || isStaleSaveResponse(documentSeqRef.current, run.seq)) return
        const { seq, cellId } = run
        const ownsKernel = run.actionId === kernelActionRef.current
        if (!event || typeof event.type !== 'string') return
        if (!shouldHandleCellEvent(cellId, event)) return
        if (event.type === 'ping') return
        if (event.type === 'status') {
          if (!ownsKernel) return
          // Stream status is authoritative for the run: any /status GET issued
          // before it belongs to an older generation.
          bumpKernelEpoch()
          const state = event.execution_state || 'idle'
          setKernel((previous) => ({ ...previous, running: true, ready: true, executionState: state, busy: state === 'busy' }))
          return
        }
        if (OUTPUT_EVENTS.has(event.type)) {
          updateRunOutputs(run, event)
          if (event.type === 'execute_result' && Number.isInteger(event.execution_count)) {
            updateRunCell(seq, cellId, (cell) => ({ ...cell, execution_count: event.execution_count }))
          }
          return
        }
        if (event.type === 'execute_reply') {
          run.replySeen = true
          // A normal Python error is still a real terminal reply; mark the run
          // failed so run-all stops instead of racing through later cells.
          if (executeReplyFailed(event)) run.failed = true
          if (kernelRestartedReply(event)) {
            run.failed = true
            if (ownsKernel) setBanner({ kind: 'error', key: 'kernelRestarted' })
          }
          if (typeof event.execution_count === 'number') {
            updateRunCell(seq, cellId, (cell) => ({ ...cell, execution_count: event.execution_count }))
          }
          markDirty(true)
          // A newer control operation owns the toolbar, while this run still
          // owns its output/reply bookkeeping until the stream has settled.
          if (!ownsKernel) return
          // The terminal reply defines the post-run generation (a synthetic
          // reply after kernel_died keeps the kernel off).
          bumpKernelEpoch()
          setKernel((previous) => ({
            ...previous,
            running: !run.died,
            busy: false,
            executionState: run.died ? 'none' : 'idle',
          }))
          return
        }
        if (event.type === 'kernel_died') {
          run.died = true
          run.failed = true
          if (!ownsKernel) return
          bumpKernelEpoch()
          setBanner({ kind: 'error', ...(event.message ? { text: event.message } : { key: 'kernelDied' }) })
          setKernel((previous) => ({ ...previous, running: false, ready: false, busy: false, executionState: 'none' }))
          return
        }
        if (event.type === 'fatal') {
          run.failed = true
          if (!ownsKernel) return
          // A fatal stream error ends this execution generation even though
          // the final state is set by runCell's catch/handling below.
          bumpKernelEpoch()
          setBanner({ kind: 'error', ...(event.message ? { text: event.message } : { key: 'loadError' }) })
        }
      }, [updateRunOutputs, updateRunCell, markDirty, bumpKernelEpoch])

      const runCell = useCallback(async (cellId) => {
        if (runningRef.current || conflict || loadStatus !== 'ok') return false
        const current = notebookRef.current
        const cell = current && current.cells.find((entry) => entry.id === cellId)
        if (!cell || cell.cell_type !== 'code') return false
        if (reloadWaitingRef.current) {
          // Starting new work supersedes an earlier confirmed reload just as
          // a new edit does; its eventual read must not discard this run.
          reloadWaitingRef.current.controller?.abort()
          notebookEditRevisionRef.current += 1
          reloadRequestRef.current += 1
          reloadWaitingRef.current = null
          setReloading(false)
        }
        // Snapshot the displayed outputs so a run that never reaches an
        // execute_reply (fatal / kernel_died / truncated stream / abort) can
        // restore them instead of leaving the cell wiped.
        const previousOutputs = Array.isArray(cell.outputs) ? cell.outputs : []
        const previousExecutionCount = typeof cell.execution_count === 'number' ? cell.execution_count : null
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const run = { seq: documentSeqRef.current, actionId: ++kernelActionRef.current, cellId, replySeen: false, failed: false, displayOrigins: new WeakMap() }
        const isCurrentRun = () => activeRunRef.current === run && !isStaleSaveResponse(documentSeqRef.current, run.seq)
        const ownsKernel = () => isCurrentRun() && run.actionId === kernelActionRef.current
        activeRunRef.current = run
        abortRef.current = controller
        activeCellRef.current = cellId
        // A save started before execution must not clear dirty using a ref
        // that React has not yet updated with this run's queued changes.
        notebookRevisionRef.current += 1
        // Starting a run is an authoritative kernel transition: drop a
        // /status GET captured before the kernel became busy.
        bumpKernelEpoch()
        setEditingCell(null)
        setCapacityBlocked(false)
        runningRef.current = cellId
        setRunningCell(cellId)
        setKernel((previous) => ({ ...previous, busy: true, executionState: 'busy' }))
        updateRunCell(run.seq, cellId, (entry) => ({ ...entry, outputs: [], execution_count: null }))
        const restorePreRunOutputs = () => {
          if (!isCurrentRun()) return
          // No save can start during execution. Restore only the outputs and
          // preserve dirty/source edits (including a pre-run save completing).
          updateRunCell(run.seq, cellId, (entry) => ({ ...entry, outputs: previousOutputs, execution_count: previousExecutionCount }))
          setNotebook((previous) => {
            if (!previous || isStaleSaveResponse(documentSeqRef.current, run.seq)) return previous
            let changed = false
            const cells = previous.cells.map((entry) => {
              const outputs = entry.cell_type === 'code' && entry.id !== cellId
                ? run.displayOrigins.get(entry.outputs)
                : undefined
              if (!outputs) return entry
              changed = true
              return { ...entry, outputs }
            })
            return changed ? { ...previous, cells } : previous
          })
        }
        try {
          await streamExecute(
            ctx,
            {
              sessionId: scope && scope.sessionId,
              path,
              cellId,
              code: cell.source,
              python: pythonRef.current || undefined,
            },
            (event) => handleEvent(run, event),
            controller ? controller.signal : undefined,
          )
          if (!isCurrentRun()) return false
          // Missing terminal replies must not turn temporary output loss into
          // a saved result, nor restore a snapshot over a reloaded document.
          if (shouldRestoreOutputsAfterRun(run.replySeen)) {
            restorePreRunOutputs()
            if (!run.failed && ownsKernel()) setBanner({ kind: 'error', key: 'streamIncomplete' })
            run.failed = true
          }
          return !run.failed && ownsKernel()
        } catch (error) {
          if (!isCurrentRun()) return false
          if (error && error.name === 'AbortError') {
            if (shouldRestoreOutputsAfterRun(run.replySeen)) restorePreRunOutputs()
            return false
          }
          if (ownsKernel()) {
            const code = error && error.code
            if (code === 'kernel-unavailable' || code === 'interpreter-unknown') {
              setBanner({ kind: 'error', key: 'kernelUnavailable', textKey: 'installHint', separator: ' ' })
            } else {
              setBanner({ kind: 'error', ...(error && error.message ? { text: error.message } : { key: 'kernelDied' }) })
            }
            // A failed current transport supersedes earlier status reads, but
            // a superseded run cannot overwrite its newer control operation.
            bumpKernelEpoch()
            setKernel((previous) => ({ ...previous, busy: false, executionState: previous.running ? 'idle' : 'none' }))
          }
          if (shouldRestoreOutputsAfterRun(run.replySeen)) restorePreRunOutputs()
          return false
        } finally {
          if (isCurrentRun()) {
            activeRunRef.current = null
            abortRef.current = null
            runningRef.current = null
            setRunningCell(null)
          }
        }
      }, [ctx, path, scope, conflict, loadStatus, handleEvent, updateRunCell, bumpKernelEpoch])

      runCellRef.current = runCell

      const runAll = useCallback(async () => {
        if (runAllRef.current || conflict) return
        const batch = { seq: documentSeqRef.current }
        runAllRef.current = batch
        stopRef.current = false
        setRunAllRunning(true)
        try {
          for (const cell of notebookRef.current && notebookRef.current.cells ? [...notebookRef.current.cells] : []) {
            if (runAllRef.current !== batch || isStaleSaveResponse(documentSeqRef.current, batch.seq) || stopRef.current) break
            if (cell.cell_type !== 'code') continue
            const succeeded = await runCell(cell.id)
            if (!succeeded || runAllRef.current !== batch) break
          }
        } finally {
          if (runAllRef.current === batch) {
            runAllRef.current = null
            stopRef.current = false
            setRunAllRunning(false)
          }
        }
      }, [conflict, runCell])

      const interrupt = useCallback(async () => {
        stopRef.current = true
        try {
          await postJson(ctx, 'interrupt', { sessionId: scope && scope.sessionId, path })
        } catch (error) {
          if (error && error.code === 'kernel-unavailable') setBanner({ kind: 'info', key: 'kernel', textKey: 'off' })
        }
      }, [ctx, path, scope])

      const restart = useCallback(async (nextPython) => {
        // The kernel identity is about to change: GETs issued before the
        // restart cannot describe the replacement kernel.
        const seq = documentSeqRef.current
        const actionId = ++kernelActionRef.current
        const isCurrentRestart = () => documentSeqRef.current === seq && kernelActionRef.current === actionId
        bumpKernelEpoch()
        try {
          const value = await postJson(ctx, 'restart', {
            sessionId: scope && scope.sessionId,
            path,
            python: resolveRestartPython(nextPython, pythonRef.current),
          })
          if (!isCurrentRestart()) return
          // GETs issued while the restart was in flight may still carry the
          // old kernel's state; the completed restart supersedes them.
          bumpKernelEpoch()
          setBanner({ kind: 'info', key: 'kernel', text: value.python || pythonRef.current || '' })
          await refreshKernel()
        } catch (error) {
          if (!isCurrentRestart()) return
          setBanner({ kind: 'error', ...(error && error.message ? { text: error.message } : { key: 'kernelDied' }) })
        }
      }, [ctx, path, scope, refreshKernel, bumpKernelEpoch])

      // Publish this mounted viewer's controls for the tab-header actions.
      useEffect(() => {
        const sessionId = scope && scope.sessionId
        if (!sessionId) return undefined
        const controls = {
          sessionId,
          path,
          runAll: () => runAll(),
          interrupt: () => interrupt(),
          restart: () => restart(),
        }
        const keys = new Set([notebookControlKey(sessionId, path)])
        if (!isAbsoluteLocalPath(path) && scope && scope.cwd) {
          keys.add(notebookControlKey(sessionId, normalizePosix(scope.cwd + '/' + path)))
        }
        for (const key of keys) notebookControls.set(key, controls)
        return () => {
          for (const key of keys) {
            if (notebookControls.get(key) === controls) notebookControls.delete(key)
          }
        }
      }, [scope && scope.sessionId, scope && scope.cwd, path, runAll, interrupt, restart])

      const shutdown = useCallback(async () => {
        const seq = documentSeqRef.current
        const actionId = ++kernelActionRef.current
        bumpKernelEpoch()
        const isCurrentShutdown = () => documentSeqRef.current === seq && kernelActionRef.current === actionId
        try {
          await postJson(ctx, 'shutdown', { sessionId: scope && scope.sessionId, path })
          // Only a newer user action supersedes this response. The old run's
          // terminal messages belong to this shutdown and must not hide it.
          if (!isCurrentShutdown()) return
          bumpKernelEpoch()
          setKernel({ running: false, ready: false, busy: false, python: null, executionState: 'none', lastError: null })
          setBanner((current) => current?.reason === 'shutdown-failed' ? null : current)
        } catch (error) {
          if (!isCurrentShutdown()) return
          bumpKernelEpoch()
          setBanner({ kind: 'error', reason: 'shutdown-failed', key: 'shutdownFailed', text: error && error.message })
          if (error?.details?.state === 'stopping') {
            setKernel((previous) => ({ ...previous, running: true, ready: false, busy: false, executionState: 'stopping', lastError: error.message }))
          }
          // A 503 does not prove the process exited. Keep the last known state
          // until an authoritative status response confirms whether it is off.
          await refreshKernel()
        }
      }, [ctx, path, scope, bumpKernelEpoch, refreshKernel])

      const changePython = useCallback(async (next) => {
        if (!next || next === pythonRef.current) return
        if (kernel.running) {
          if (typeof window === 'undefined' || !window.confirm || !window.confirm(t('restartConfirm'))) return
          setPython(next)
          pythonRef.current = next
          try {
            window.localStorage.setItem('dsh-bsb-ipynb:python:' + path, next)
          } catch {
            /* ignore */
          }
          await restart(next)
          return
        }
        setPython(next)
        pythonRef.current = next
        try {
          window.localStorage.setItem('dsh-bsb-ipynb:python:' + path, next)
        } catch {
          /* ignore */
        }
      }, [kernel.running, path, restart])

      const setSource = useCallback((cellId, value) => {
        // Remember where the user last worked so reading-mode shortcuts have a
        // sensible target even after focus moved to the toolbar.
        activeCellRef.current = cellId
        setNotebook((previous) => updateCell(previous, cellId, (cell) => ({ ...cell, source: value })))
        // A new edit supersedes any pending confirmed read.
        markDirty()
      }, [markDirty])

      const clearOutputs = useCallback((cellId) => {
        const current = notebookRef.current
        const cell = current && current.cells.find((entry) => entry.id === cellId)
        if (!cell || cell.cell_type !== 'code' || !Array.isArray(cell.outputs) || cell.outputs.length === 0) return
        setNotebook((previous) => updateCell(previous, cellId, (entry) => (
          entry.cell_type === 'code' ? { ...entry, outputs: [] } : entry
        )))
        setBanner((currentBanner) => (currentBanner && currentBanner.reason === 'capacity' ? null : currentBanner))
        setCapacityBlocked(false)
        markDirty()
      }, [markDirty])

      const clearAllOutputs = useCallback(() => {
        const current = notebookRef.current
        if (!current) return
        const hasOutputs = current.cells.some((cell) => (
          cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0
        ))
        if (!hasOutputs) return
        if (typeof window === 'undefined' || !window.confirm || !window.confirm(t('clearAllOutputsConfirm'))) return
        setNotebook((previous) => (previous
          ? {
              ...previous,
              cells: previous.cells.map((cell) => (
                cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length
                  ? { ...cell, outputs: [] }
                  : cell
              )),
            }
          : previous))
        setBanner(null)
        setCapacityBlocked(false)
        markDirty()
      }, [markDirty])

      const moveCell = useCallback((cellId, delta) => {
        setNotebook((previous) => {
          if (!previous) return previous
          const index = previous.cells.findIndex((cell) => cell.id === cellId)
          const target = index + delta
          if (index === -1 || target < 0 || target >= previous.cells.length) return previous
          const cells = [...previous.cells]
          const [cell] = cells.splice(index, 1)
          cells.splice(target, 0, cell)
          return { ...previous, cells }
        })
        markDirty()
      }, [markDirty])

      const deleteCell = useCallback((cellId) => {
        if (typeof window === 'undefined' || !window.confirm || !window.confirm(t('deleteCellConfirm'))) return
        setNotebook((previous) => (previous ? { ...previous, cells: previous.cells.filter((cell) => cell.id !== cellId) } : previous))
        setEditingCell((current) => (current === cellId ? null : current))
        if (activeCellRef.current === cellId) activeCellRef.current = null
        markDirty()
      }, [markDirty])

      const changeType = useCallback((cellId, type) => {
        const current = notebookRef.current
        const cell = current && current.cells.find((entry) => entry.id === cellId)
        if (!cell) return
        if (cellTypeChangeLosesData(cell, type) && (typeof window === 'undefined' || !window.confirm || !window.confirm(t('changeTypeConfirm')))) return
        setNotebook((previous) =>
          updateCell(previous, cellId, (currentCell) => {
            const next = { ...currentCell, cell_type: type }
            if (type === 'code') {
              next.outputs = Array.isArray(currentCell.outputs) ? currentCell.outputs : []
              next.execution_count = currentCell.execution_count ?? null
            } else {
              delete next.outputs
              delete next.execution_count
            }
            if (type !== 'markdown') delete next.attachments
            return next
          }),
        )
        markDirty()
      }, [markDirty])

      const insertCell = useCallback((afterId, type) => {
        const cell = { cell_type: type, id: newCellId(), metadata: {}, source: '' }
        if (type === 'code') {
          cell.outputs = []
          cell.execution_count = null
        }
        setNotebook((previous) => {
          if (!previous) return previous
          const index = afterId ? previous.cells.findIndex((entry) => entry.id === afterId) : previous.cells.length - 1
          const cells = [...previous.cells]
          cells.splice(index + 1, 0, cell)
          return { ...previous, cells }
        })
        markDirty()
        activeCellRef.current = cell.id
        setEditingCell(cell.id)
        return cell.id
      }, [])

      const runAndAdvance = useCallback((cellId) => {
        const current = notebookRef.current
        if (!current) return
        const index = current.cells.findIndex((cell) => cell.id === cellId)
        const next = current.cells.slice(index + 1).find((cell) => cell.cell_type === 'code')
        if (next) {
          activeCellRef.current = next.id
          setEditingCell(next.id)
        }
      }, [])

      // Reading-mode shortcuts live on the window for as long as the viewer is
      // mounted; the cell editor keeps its own onKeyDown. defaultPrevented
      // (set by that handler) plus the editing-target guard keep the two from
      // both firing, and the cleanup removes the listener on unmount.
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onKeyDown = (event) => {
          // A mounted-but-hidden viewer must not steal host shortcuts: return
          // before preventDefault so the browser/host default stays intact.
          if (visibleRef.current === false) return
          const shortcut = resolveReadingShortcut(event, {
            targetCellId: cellIdFromEventTarget(event && event.target),
            activeCellId: activeCellRef.current,
          })
          if (!shortcut) return
          // Ctrl/Cmd+S is prevented even when there is nothing to save: the
          // browser's own "save page" dialog must never appear in reading mode.
          event.preventDefault()
          if (loadStatusRef.current !== 'ok') return
          if (shortcut.action === 'run') {
            if (typeof runCellRef.current === 'function') void runCellRef.current(shortcut.cellId)
            return
          }
          if (typeof saveRef.current === 'function') void saveRef.current()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('keydown', onKeyDown)
        }
      }, [])

      if (loadStatus !== 'ok' || !notebook) {
        const title = loadStatus === 'unsupported' ? t('unsupported') : loadStatus === 'error' ? t('loadError') : t('invalid')
        return h(
          'div',
          { className: 'dsh-bsb-ipynb-root' },
          h(
            'div',
            { className: 'dsh-bsb-ipynb-card' },
            h('div', { className: 'dsh-bsb-ipynb-card-title' }, title),
            loadError ? h('pre', { className: 'dsh-bsb-ipynb-card-detail' }, String(loadError)) : null,
            loadMessage ? h('pre', { className: 'dsh-bsb-ipynb-card-detail' }, String(loadMessage)) : null,
            h(
              'div',
              { className: 'dsh-bsb-ipynb-card-actions' },
              h(IconButton, { title: t('reload'), onClick: reload }, t('reload')),
              loadStatus === 'invalid' || loadStatus === 'unsupported'
                ? h(IconButton, { title: t('openAsEmpty'), onClick: openAsEmpty }, t('openAsEmpty'))
                : null,
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsh-bsb-ipynb-root' },
        h(Toolbar, {
          kernel,
          python,
          interpreters,
          running: Boolean(runningCell) || runAllRunning,
          runAllRunning,
          onRunAll: runAll,
          onInterrupt: interrupt,
          onRestart: restart,
          onShutdown: shutdown,
          onSave: () => void saveRef.current(),
          onReload: reload,
          onPython: changePython,
          saveState,
          dirty,
          conflict,
        }),
        h(Banner, { banner, onReload: reload, onClearOutputs: clearAllOutputs }),
        h(
          'div',
          { className: 'dsh-bsb-ipynb-cells' },
          notebook.cells.map((cell, index) =>
            h(CellView, {
              key: cell.id,
              cell,
              index,
              count: notebook.cells.length,
              ctx,
              scope,
              notebookPath: path,
              editing: editingCell === cell.id,
              running: runningCell === cell.id,
              busy: Boolean(runningCell) || runAllRunning,
              onEdit: (cellId) => {
                activeCellRef.current = cellId
                setEditingCell(cellId)
              },
              onDone: () => setEditingCell(null),
              onSource: setSource,
              onRun: (cellId) => void runCell(cellId),
              onRunAndNext: runAndAdvance,
              onMove: moveCell,
              onDelete: deleteCell,
              onType: changeType,
              onInsertBelow: (cellId) => insertCell(cellId, 'code'),
              onSave: () => void saveRef.current(),
              onClearOutputs: clearOutputs,
            }),
          ),
        ),
        notebook.cells.length === 0
          ? h('div', { className: 'dsh-bsb-ipynb-empty' }, t('emptyHint'))
          : null,
        h(
          'div',
          { className: 'dsh-bsb-ipynb-add' },
          h(IconButton, { title: t('addCode'), onClick: () => insertCell(notebook.cells.length ? notebook.cells[notebook.cells.length - 1].id : null, 'code') }, t('addCode')),
          h(IconButton, { title: t('addMarkdown'), onClick: () => insertCell(notebook.cells.length ? notebook.cells[notebook.cells.length - 1].id : null, 'markdown') }, t('addMarkdown')),
          emptyFile ? h('span', { className: 'dsh-bsb-ipynb-hint' }, t('emptyFile')) : null,
        ),
        h('div', { className: 'dsh-bsb-ipynb-shortcuts' }, shortcutText()),
      )
    }

    // The viewer's gear panel. It deliberately uses BSB's plugin settings as
    // the single source of truth: the same blob the open notebook watches.
    function SettingsPanel(props) {
      const { ctx, pluginSettings, updatePluginSetting, close } = props
      const [draft, setDraft] = useState(() => normalizePluginSettings(pluginSettings))
      const [interpreters, setInterpreters] = useState([])
      const [failed, setFailed] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [saved, setSaved] = useState(false)

      useEffect(() => {
        let cancelled = false
        Promise.all([
          getJson(ctx, 'interpreters'),
          getJson(ctx, 'config').catch(() => null),
        ]).then(([value, config]) => {
          if (cancelled) return
          const all = value && Array.isArray(value.interpreters) ? value.interpreters : []
          setInterpreters(all.filter((entry) => entry.ok))
          setFailed(all.filter((entry) => !entry.ok))
          setDraft((current) => ({
            ...current,
            idleMinutes: config && Number.isInteger(config.idleMinutes) ? config.idleMinutes : (current.idleMinutes ?? 30),
          }))
          setLoading(false)
        }).catch((loadError) => {
          if (cancelled) return
          setError(loadError && loadError.message ? loadError.message : t('settingsError'))
          setLoading(false)
        })
        return () => {
          cancelled = true
        }
      }, [ctx])

      const change = (key, value) => {
        setSaved(false)
        setError('')
        setDraft((current) => ({ ...current, [key]: value }))
      }

      const save = () => {
        const autosaveMs = Math.round(numberInRange(draft.autosaveMs, AUTOSAVE_MIN_MS, AUTOSAVE_MAX_MS, SETTINGS_DEFAULTS.autosaveMs))
        // Do not overwrite the host timeout with a guessed 30 when the config
        // read failed and the user never chose a value.
        const idleMinutes = Number.isInteger(draft.idleMinutes) ? draft.idleMinutes : null
        updatePluginSetting('autosaveMs', autosaveMs)
        updatePluginSetting('defaultPython', draft.defaultPython || '')
        if (idleMinutes === null) {
          setSaved(true)
          return
        }
        updatePluginSetting('idleMinutes', idleMinutes)
        postJson(ctx, 'config', { idleMinutes })
          .then(() => setSaved(true))
          .catch((saveError) => setError(saveError && saveError.message ? saveError.message : t('saveFailed')))
      }

      const idleValue = Number.isInteger(draft.idleMinutes) ? draft.idleMinutes : 30
      return h(
        'div',
        { className: 'dsh-bsb-ipynb-settings' },
        h('div', { className: 'dsh-bsb-ipynb-settings-title' }, t('settingsTitle')),
        h('label', { className: 'dsh-bsb-ipynb-settings-row' },
          h('span', { className: 'dsh-bsb-ipynb-settings-label' }, t('settingsAutosave')),
          h('input', {
            className: 'dsh-bsb-ipynb-settings-input',
            type: 'number',
            min: AUTOSAVE_MIN_MS / 1000,
            max: AUTOSAVE_MAX_MS / 1000,
            step: 0.5,
            value: draft.autosaveMs / 1000,
            onChange: (event) => change('autosaveMs', Number(event.target.value) * 1000),
          }),
          h('span', { className: 'dsh-bsb-ipynb-settings-hint' }, t('settingsAutosaveHint')),
        ),
        h('label', { className: 'dsh-bsb-ipynb-settings-row' },
          h('span', { className: 'dsh-bsb-ipynb-settings-label' }, t('settingsDefaultPython')),
          h('select', {
            className: 'dsh-bsb-ipynb-settings-input',
            value: draft.defaultPython,
            onChange: (event) => change('defaultPython', event.target.value),
          },
            h('option', { value: '' }, t('settingsServerDefault')),
            ...interpreters.map((entry) => h('option', { value: entry.path, key: entry.path }, entry.label || entry.path)),
          ),
        ),
        h('label', { className: 'dsh-bsb-ipynb-settings-row' },
          h('span', { className: 'dsh-bsb-ipynb-settings-label' }, t('settingsIdle')),
          h('input', {
            className: 'dsh-bsb-ipynb-settings-input',
            type: 'number',
            min: 0,
            max: IDLE_MAX_MINUTES,
            step: 1,
            value: idleValue,
            onChange: (event) => change('idleMinutes', Number(event.target.value)),
          }),
          h('span', { className: 'dsh-bsb-ipynb-settings-hint' }, t('settingsIdleHint')),
        ),
        h('div', { className: 'dsh-bsb-ipynb-settings-status' },
          h('span', { className: 'dsh-bsb-ipynb-settings-label' }, t('settingsInterpreters')),
          h('span', {}, loading
            ? t('settingsLoading')
            : interpreters.length + ' ' + t('settingsAvailable') + (failed.length ? ' · ' + failed.length + ' ' + t('settingsUnavailable') : '')),
          ...failed.slice(0, 5).map((entry) => h('span', {
            className: 'dsh-bsb-ipynb-settings-failure',
            key: entry.path,
            title: entry.detail || entry.path,
          }, entry.label || entry.path)),
        ),
        error ? h('div', { className: 'dsh-bsb-ipynb-settings-error', role: 'alert' }, error) : null,
        h('div', { className: 'dsh-bsb-ipynb-settings-actions' },
          saved ? h('span', { className: 'dsh-bsb-ipynb-settings-saved' }, t('settingsSaved')) : null,
          h('button', { type: 'button', className: 'dsh-bsb-ipynb-button', onClick: save }, t('settingsSave')),
          h('button', { type: 'button', className: 'dsh-bsb-ipynb-button', onClick: close }, t('settingsClose')),
        ),
      )
    }

    const STYLES = `
.dsh-bsb-ipynb-root {
  /* One theme layer: every colour and type size resolves from the host theme.
     The value after each comma applies only when the host token stylesheets
     are absent (unit tests, standalone rendering) and mirrors the pre-token
     appearance. The root never selects a colour scheme itself: the host's
     resolved palette (theme setting x OS scheme) is inherited through these
     custom properties, and third-party skins reach the notebook the same way. */
  --dsh-bsb-ipynb-border: var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28));
  --dsh-bsb-ipynb-cell-surface: var(--dsw-alias-bg-module-platform, rgba(127, 127, 127, 0.09));
  --dsh-bsb-ipynb-hover-surface: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
  --dsh-bsb-ipynb-code-surface: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.16));
  --dsh-bsb-ipynb-inline-code-surface: var(--dsw-alias-markdown-inline-code, rgba(127, 127, 127, 0.16));
  --dsh-bsb-ipynb-muted: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.95));
  --dsh-bsb-ipynb-text: var(--dsw-alias-label-primary, inherit);
  --dsh-bsb-ipynb-surface: var(--dsw-alias-bg-layer-1, Canvas);
  --dsh-bsb-ipynb-link: var(--dsw-alias-link, #4c8dff);
  --dsh-bsb-ipynb-running: var(--dsw-alias-state-business-primary, #4c8dff);
  --dsh-bsb-ipynb-focus: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff));
  --dsh-bsb-ipynb-idle: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.55));
  --dsh-bsb-ipynb-ready: var(--dsw-alias-state-success-primary, #2ea043);
  --dsh-bsb-ipynb-busy: var(--dsw-alias-state-warn-primary, #d29922);
  --dsh-bsb-ipynb-error: var(--dsw-alias-state-error-primary, #cf222e);
  --dsh-bsb-ipynb-info-surface: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4c8dff) 12%, transparent);
  --dsh-bsb-ipynb-error-surface: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 12%, transparent);
  /* Text and code follow the DSH font settings: the root size is the text
     size role, code contexts use the code size role (+1px, matching the host
     rule that inline code sits one step above a code block). Dense chrome
     (10-12px labels) keeps its default size and shifts by the text delta. */
  --dsh-bsb-ipynb-font-ui: var(--dsh-content-font-size-secondary, 13px);
  --dsh-bsb-ipynb-font-ui-delta: var(--dsh-content-font-delta-secondary, 0px);
  --dsh-bsb-ipynb-font-code: calc(var(--dsh-code-font-size, 11px) + 1px);
  --dsh-bsb-ipynb-font-code-delta: var(--dsh-code-font-delta, 0px);
  --dsh-bsb-ipynb-font-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  /* Shiki syntax colours: the host owns the syntax palette per scheme, so a
     skin that overrides --shiki-* re-colours the notebook's Python highlighting
     without the plugin knowing about the scheme. */
  --dsh-bsb-ipynb-tok-keyword: var(--shiki-token-keyword, #cf222e);
  --dsh-bsb-ipynb-tok-string: var(--shiki-token-string, #0a3069);
  --dsh-bsb-ipynb-tok-comment: var(--shiki-token-comment, #6e7781);
  --dsh-bsb-ipynb-tok-number: var(--shiki-token-constant, #0550ae);
  --dsh-bsb-ipynb-tok-builtin: var(--shiki-token-function, #8250df);
  --dsh-bsb-ipynb-tok-class: var(--shiki-token-parameter, #953800);
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  color: var(--dsh-bsb-ipynb-text);
  font-size: var(--dsh-bsb-ipynb-font-ui);
  line-height: 1.45;
}
.dsh-bsb-ipynb-root *,
.dsh-bsb-ipynb-root *::before,
.dsh-bsb-ipynb-root *::after { box-sizing: border-box; }
.dsh-bsb-ipynb-toolbar {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsh-bsb-ipynb-border);
  background: var(--dsh-bsb-ipynb-surface);
}
.dsh-bsb-ipynb-toolbar-group { display: flex; align-items: center; gap: 4px; }
.dsh-bsb-ipynb-kernel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsh-bsb-ipynb-idle);
  flex: none;
}
.dsh-bsb-ipynb-kernel-dot.is-ready { background: var(--dsh-bsb-ipynb-ready); }
.dsh-bsb-ipynb-kernel-dot.is-busy { background: var(--dsh-bsb-ipynb-busy); animation: dsh-bsb-ipynb-pulse 1.2s ease-in-out infinite; }
@keyframes dsh-bsb-ipynb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.dsh-bsb-ipynb-kernel-label { color: var(--dsh-bsb-ipynb-muted); font-size: calc(11px + var(--dsh-bsb-ipynb-font-ui-delta)); text-transform: uppercase; letter-spacing: 0.04em; }
.dsh-bsb-ipynb-python-select {
  max-width: 210px;
  font-size: calc(11px + var(--dsh-bsb-ipynb-font-ui-delta));
  padding: 2px 4px;
  border: 1px solid var(--dsh-bsb-ipynb-border);
  border-radius: 4px;
  background: transparent;
  color: inherit;
}
.dsh-bsb-ipynb-button {
  appearance: none;
  border: 1px solid var(--dsh-bsb-ipynb-border);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  padding: 2px 6px;
  font: inherit;
  font-size: calc(11px + var(--dsh-bsb-ipynb-font-ui-delta));
  line-height: 1.5;
  cursor: pointer;
}
.dsh-bsb-ipynb-button:hover:not(:disabled) { background: var(--dsh-bsb-ipynb-hover-surface); }
.dsh-bsb-ipynb-button:disabled { opacity: 0.4; cursor: default; }
.dsh-bsb-ipynb-save-state { color: var(--dsh-bsb-ipynb-muted); font-size: calc(11px + var(--dsh-bsb-ipynb-font-ui-delta)); }
.dsh-bsb-ipynb-save-state.is-error { color: var(--dsh-bsb-ipynb-error); }
.dsh-bsb-ipynb-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsh-bsb-ipynb-border);
  font-size: calc(12px + var(--dsh-bsb-ipynb-font-ui-delta));
}
.dsh-bsb-ipynb-banner-info { background: var(--dsh-bsb-ipynb-info-surface); }
.dsh-bsb-ipynb-banner-error { background: var(--dsh-bsb-ipynb-error-surface); }
.dsh-bsb-ipynb-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-bsb-ipynb-cells { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.dsh-bsb-ipynb-cell {
  border: 1px solid var(--dsh-bsb-ipynb-border);
  border-radius: 6px;
  margin-bottom: 8px;
  background: var(--dsh-bsb-ipynb-cell-surface);
  overflow: hidden;
}
.dsh-bsb-ipynb-cell-running { border-color: var(--dsh-bsb-ipynb-running); }
.dsh-bsb-ipynb-cell-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--dsh-bsb-ipynb-border);
  color: var(--dsh-bsb-ipynb-muted);
  font-size: calc(11px + var(--dsh-bsb-ipynb-font-ui-delta));
  min-height: 26px;
}
.dsh-bsb-ipynb-prompt {
  font-family: var(--dsh-bsb-ipynb-font-mono);
  font-size: calc(11px + var(--dsh-bsb-ipynb-font-code-delta));
  min-width: 24px;
  color: var(--dsh-bsb-ipynb-muted);
}
.dsh-bsb-ipynb-cell-label { text-transform: uppercase; letter-spacing: 0.04em; font-size: calc(10px + var(--dsh-bsb-ipynb-font-ui-delta)); }
.dsh-bsb-ipynb-cell-actions { margin-left: auto; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.dsh-bsb-ipynb-cell-actions .dsh-bsb-ipynb-button { padding: 1px 5px; font-size: calc(10px + var(--dsh-bsb-ipynb-font-ui-delta)); }
.dsh-bsb-ipynb-cell-type {
  font-size: calc(10px + var(--dsh-bsb-ipynb-font-ui-delta));
  border: 1px solid var(--dsh-bsb-ipynb-border);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  padding: 1px 2px;
}
.dsh-bsb-ipynb-source,
.dsh-bsb-ipynb-raw,
.dsh-bsb-ipynb-source-editor {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--dsh-bsb-ipynb-font-mono);
  font-size: var(--dsh-bsb-ipynb-font-code);
  line-height: 1.55;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: inherit;
  background: transparent;
  width: 100%;
  border: 0;
  outline: none;
  resize: none;
}
.dsh-bsb-ipynb-source { cursor: text; min-height: 32px; }
.dsh-bsb-ipynb-source:focus { outline: 1px solid var(--dsh-bsb-ipynb-focus); outline-offset: -1px; }
.dsh-bsb-ipynb-raw:focus-visible,
.dsh-bsb-ipynb-source-editor:focus-visible { outline: 2px solid var(--dsh-bsb-ipynb-focus); outline-offset: -2px; }
.dsh-bsb-ipynb-source-editor { display: block; min-height: 48px; }
.dsh-bsb-ipynb-empty-source { display: inline-block; min-height: 1em; }
.dsh-bsb-ipynb-markdown { padding: 8px 10px; overflow-wrap: anywhere; }
.dsh-bsb-ipynb-markdown > :first-child { margin-top: 0; }
.dsh-bsb-ipynb-markdown > :last-child { margin-bottom: 0; }
.dsh-bsb-ipynb-markdown h1,
.dsh-bsb-ipynb-markdown h2,
.dsh-bsb-ipynb-markdown h3,
.dsh-bsb-ipynb-markdown h4,
.dsh-bsb-ipynb-markdown h5,
.dsh-bsb-ipynb-markdown h6 { margin: 0.8em 0 0.4em; line-height: 1.3; }
.dsh-bsb-ipynb-markdown h1 { font-size: 1.5em; }
.dsh-bsb-ipynb-markdown h2 { font-size: 1.3em; }
.dsh-bsb-ipynb-markdown h3 { font-size: 1.15em; }
.dsh-bsb-ipynb-markdown p { margin: 0.5em 0; }
.dsh-bsb-ipynb-markdown ul,
.dsh-bsb-ipynb-markdown ol { margin: 0.4em 0; padding-left: 1.5em; }
.dsh-bsb-ipynb-markdown a,
.dsh-bsb-ipynb-html a { color: var(--dsh-bsb-ipynb-link); }
.dsh-bsb-ipynb-markdown code,
.dsh-bsb-ipynb-html code {
  font-family: var(--dsh-bsb-ipynb-font-mono);
  font-size: 0.92em;
  background: var(--dsh-bsb-ipynb-inline-code-surface);
  border-radius: 3px;
  padding: 0.1em 0.3em;
}
.dsh-bsb-ipynb-md-code {
  display: block;
  font-family: var(--dsh-bsb-ipynb-font-mono);
  font-size: var(--dsh-bsb-ipynb-font-code);
  background: var(--dsh-bsb-ipynb-code-surface);
  border-radius: 5px;
  padding: 8px 10px;
  overflow-x: auto;
  white-space: pre;
}
.dsh-bsb-ipynb-md-code code { background: transparent; border-radius: 0; font-size: inherit; padding: 0; }
.dsh-bsb-ipynb-html pre code { background: transparent; border-radius: 0; font-size: inherit; padding: 0; }
.dsh-bsb-ipynb-markdown pre,
.dsh-bsb-ipynb-html pre { background: var(--dsh-bsb-ipynb-code-surface); border-radius: 5px; padding: 8px 10px; overflow-x: auto; }
.dsh-bsb-ipynb-markdown blockquote {
  margin: 0.5em 0;
  padding: 0.1em 0.8em;
  border-left: 3px solid var(--dsh-bsb-ipynb-border);
  color: var(--dsh-bsb-ipynb-muted);
}
.dsh-bsb-ipynb-markdown table,
.dsh-bsb-ipynb-html table { border-collapse: collapse; margin: 0.5em 0; max-width: 100%; }
.dsh-bsb-ipynb-markdown th,
.dsh-bsb-ipynb-markdown td,
.dsh-bsb-ipynb-html th,
.dsh-bsb-ipynb-html td { border: 1px solid var(--dsh-bsb-ipynb-border); padding: 3px 8px; text-align: left; }
.dsh-bsb-ipynb-markdown img,
.dsh-bsb-ipynb-html img { max-width: 100%; }
.dsh-bsb-ipynb-missing-image { color: var(--dsh-bsb-ipynb-muted); font-style: italic; }
.dsh-bsb-ipynb-outputs { border-top: 1px solid var(--dsh-bsb-ipynb-border); }
.dsh-bsb-ipynb-output {
  margin: 0;
  padding: 6px 10px;
  font-family: var(--dsh-bsb-ipynb-font-mono);
  font-size: var(--dsh-bsb-ipynb-font-code);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: auto;
}
.dsh-bsb-ipynb-output + .dsh-bsb-ipynb-output { border-top: 1px dashed var(--dsh-bsb-ipynb-border); }
.dsh-bsb-ipynb-stream-stderr { color: var(--dsh-bsb-ipynb-error); }
.dsh-bsb-ipynb-error { color: var(--dsh-bsb-ipynb-error); }
.dsh-bsb-ipynb-html { font-family: inherit; white-space: normal; }
/* Notebook images keep a white surface so transparent PNG/SVG plots stay
   readable on dark themes; this is content fidelity, not theme chrome. */
.dsh-bsb-ipynb-image { display: block; max-width: 100%; background: white; }
.dsh-bsb-ipynb-raw { color: var(--dsh-bsb-ipynb-muted); cursor: text; }
.dsh-bsb-ipynb-card { margin: 16px; padding: 16px; border: 1px solid var(--dsh-bsb-ipynb-border); border-radius: 8px; background: var(--dsh-bsb-ipynb-cell-surface); }
.dsh-bsb-ipynb-card-title { font-size: calc(14px + var(--dsh-bsb-ipynb-font-ui-delta)); font-weight: 600; margin-bottom: 8px; }
.dsh-bsb-ipynb-card-detail { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--dsh-bsb-ipynb-code-surface); border-radius: 5px; padding: 8px 10px; font-size: calc(12px + var(--dsh-bsb-ipynb-font-ui-delta)); }
.dsh-bsb-ipynb-card-actions { display: flex; gap: 6px; margin-top: 12px; }
.dsh-bsb-ipynb-add { display: flex; align-items: center; gap: 6px; padding: 0 8px 8px; }
.dsh-bsb-ipynb-hint { color: var(--dsh-bsb-ipynb-muted); font-size: calc(11px + var(--dsh-bsb-ipynb-font-ui-delta)); }
.dsh-bsb-ipynb-empty { padding: 8px 10px; color: var(--dsh-bsb-ipynb-muted); }
.dsh-bsb-ipynb-shortcuts { padding: 0 8px 8px; color: var(--dsh-bsb-ipynb-muted); font-size: calc(10px + var(--dsh-bsb-ipynb-font-ui-delta)); }
.dsh-bsb-ipynb-tok-keyword { color: var(--dsh-bsb-ipynb-tok-keyword); }
.dsh-bsb-ipynb-tok-string { color: var(--dsh-bsb-ipynb-tok-string); }
.dsh-bsb-ipynb-tok-comment { color: var(--dsh-bsb-ipynb-tok-comment); font-style: italic; }
.dsh-bsb-ipynb-tok-number { color: var(--dsh-bsb-ipynb-tok-number); }
.dsh-bsb-ipynb-tok-builtin { color: var(--dsh-bsb-ipynb-tok-builtin); }
.dsh-bsb-ipynb-tok-class { color: var(--dsh-bsb-ipynb-tok-class); }
/* The settings panel renders in BSB's gear popup, outside the notebook root,
   so it resolves the host tokens directly instead of the root token layer. */
.dsh-bsb-ipynb-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 0;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
.dsh-bsb-ipynb-settings-title { font-weight: 600; }
.dsh-bsb-ipynb-settings-row {
  display: grid;
  grid-template-columns: minmax(96px, auto) minmax(120px, 1fr);
  align-items: center;
  gap: 4px 8px;
}
.dsh-bsb-ipynb-settings-label { color: var(--dsw-alias-label-secondary, inherit); }
.dsh-bsb-ipynb-settings-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28));
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: inherit;
  font: inherit;
}
.dsh-bsb-ipynb-settings-hint,
.dsh-bsb-ipynb-settings-status {
  grid-column: 1 / -1;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.55));
  font-size: calc(11px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-bsb-ipynb-settings-status { display: flex; flex-direction: column; gap: 2px; }
.dsh-bsb-ipynb-settings-failure { overflow-wrap: anywhere; color: var(--dsw-alias-state-warn-primary, #d29922); }
.dsh-bsb-ipynb-settings-error { color: var(--dsw-alias-state-error-primary, #cf222e); overflow-wrap: anywhere; }
.dsh-bsb-ipynb-settings-actions { display: flex; align-items: center; gap: 6px; }
.dsh-bsb-ipynb-settings-saved { color: var(--dsw-alias-state-success-primary, #2ea043); }
`

    /** Compare the stable `major.minor.patch` part of two service versions. */
    function versionAtLeast(actual, minimum) {
      const parse = (value) => String(value).trim().split('-')[0].split('.').map((part) => Number(part))
      const left = parse(actual)
      const right = parse(minimum)
      if (left.length < 3 || right.length < 3 || left.some(Number.isNaN) || right.some(Number.isNaN)) return false
      for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index]
      }
      return true
    }

    // Fail fast on a stale Better Sidebar. The service has reported its version
    // and feature list since long before 0.32, so a real older installation is
    // rejected here rather than throwing inside registerFileViewer.
    function assertBetterSidebar(ctx) {
      const service = ctx && ctx.betterSidebar
      if (!service) {
        throw new Error('[dsh-bsb-ipynb] dsh-better-sidebar is not mounted; this plugin requires it')
      }
      const version = typeof service.version === 'string' ? service.version : ''
      if (!versionAtLeast(version, MIN_BETTER_SIDEBAR_VERSION)) {
        throw new Error(
          '[dsh-bsb-ipynb] dsh-better-sidebar ' + (version || '(unknown version)') +
          ' is not supported; this build requires >= ' + MIN_BETTER_SIDEBAR_VERSION,
        )
      }
      const features = Array.isArray(service.features) ? service.features : []
      const missing = REQUIRED_BETTER_SIDEBAR_FEATURES.filter((feature) => !features.includes(feature))
      if (missing.length) {
        throw new Error(
          '[dsh-bsb-ipynb] dsh-better-sidebar ' + version +
          ' is missing required feature(s): ' + missing.join(', '),
        )
      }
    }

    /** The optional DSH locale face; a composition without it keeps the browser fallback. */
    function localeFaceOf(ctx) {
      if (!ctx) return undefined
      if (typeof ctx.get === 'function') return ctx.get('locale')
      return ctx.locale
    }

    // Follow the Host-backed language preference when the runtime provides the
    // optional `locale` service: register this plugin's dictionaries under its
    // own namespace and swap the module-level translate to the bound one. The
    // child fiber re-runs if the service restarts, and the browser language
    // stays the fallback when the service is absent (standalone compositions,
    // tests) or not yet active.
    function bindHostLocale(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => {
          const hostLocale = localeCtx.locale
          const offEn = hostLocale.register(LOCALE_NS, 'en', STRINGS.en)
          const offZh = hostLocale.register(LOCALE_NS, 'zh', STRINGS.zh)
          const previous = t
          t = hostLocale.bind(LOCALE_NS)
          return () => {
            t = previous
            offEn()
            offZh()
          }
        })
      })
    }

    // File-tree and tab-header contributions backed by the new BSB action
    // registries. The file action creates a notebook through the host; the tab
    // actions drive the live viewer through the module-level controls map.
    function registerNotebookActions(ctx) {
      const service = ctx.betterSidebar
      const disposers = []
      const disposeAll = () => {
        while (disposers.length) {
          try {
            disposers.pop()()
          } catch {
            /* a partially registered action must not mask the original error */
          }
        }
      }
      try {
        disposers.push(service.registerFileAction({
          id: 'dsh-bsb-ipynb:new-notebook',
          label: () => t('newNotebook'),
          order: 10,
          dirs: true,
          when: (row) => row.isDir && Boolean(row.sessionId),
          run: async (action) => {
            try {
              const value = await postJson(ctx, 'create', {
                sessionId: action.sessionId,
                path: action.path,
              })
              const scope = { sessionId: action.sessionId }
              if (action.root) scope.cwd = action.root
              service.openFile(scope, value.path, value.name)
            } catch (error) {
              action.fail(error && error.message ? error.message : t('createNotebookFailed'))
            }
          },
        }))

        const tabActions = [
          { id: 'dsh-bsb-ipynb:run-all', label: () => t('runAll'), order: 10, control: 'runAll' },
          { id: 'dsh-bsb-ipynb:interrupt', label: () => t('interrupt'), order: 20, control: 'interrupt' },
          { id: 'dsh-bsb-ipynb:restart', label: () => t('restart'), order: 30, control: 'restart' },
        ]
        for (const action of tabActions) {
          disposers.push(service.registerTabAction({
            id: action.id,
            label: action.label,
            order: action.order,
            when: (context) => context.tabType === 'editor' && !context.isDir && /\.ipynb$/i.test(context.path),
            run: async (context) => {
              const controls = findNotebookControls(context.sessionId, context.path)
              if (!controls) {
                context.fail(t('notebookNotOpen'))
                return
              }
              try {
                await controls[action.control]()
              } catch (error) {
                context.fail(error && error.message ? error.message : t('notebookActionFailed'))
              }
            },
          }))
        }
      } catch (error) {
        disposeAll()
        throw error
      }
      return disposeAll
    }

    function apply(ctx) {
      assertBetterSidebar(ctx)
      bindHostLocale(ctx)
      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const existing = document.getElementById(STYLE_ID)
        if (existing) existing.remove()
        const style = document.createElement('style')
        style.id = STYLE_ID
        if (style.dataset) style.dataset.plugin = 'dsh-bsb-ipynb'
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      })
      ctx.effect(() =>
        ctx.betterSidebar.registerFileViewer({
          id: VIEWER_ID,
          title: () => t('viewerTitle'),
          exts: ['ipynb'],
          priority: 10,
          fetchStrategy: 'custom',
          load: (path, scope, signal) => readNotebook(ctx, path, scope, signal),
          settings: {
            render: (props) => h(SettingsPanel, { ...props, ctx }),
          },
          component: NotebookView,
        }),
      )
      ctx.effect(() => registerNotebookActions(ctx))
    }

    const __test = {
      STRINGS,
      LOCALE_NS,
      translate: (key) => t(key),
      versionAtLeast,
      assertBetterSidebar,
      VIEWER_ID,
      SETTINGS_DEFAULTS,
      normalizePluginSettings,
      readPluginSettings,
      SettingsPanel,
      notebookControls,
      notebookControlKey,
      isMacPlatform,
      shortcutText,
      bannerText,
      escapeHtml,
      mimeText,
      imageSource,
      sanitizeUrl,
      sanitizeHtml,
      ALLOWED_ATTRS,
      isEditingKeyTarget,
      cellIdFromEventTarget,
      resolveReadingShortcut,
      renderMarkdown,
      renderMarkdownWithImages,
      renderInline,
      ansiToHtml,
      highlightPython,
      normalizeNotebook,
      serializeNotebook,
      stripIllegalOutputFields,
      reduceOutputs,
      outputsSize,
      MAX_CELL_OUTPUT_BYTES,
      NOTEBOOK_CAP_BYTES,
      METADATA_DEPTH_LIMIT,
      METADATA_NODE_LIMIT,
      JSON_DEPTH_LIMIT,
      JSON_NODE_LIMIT,
      NOTEBOOK_DEPTH_LIMIT,
      NOTEBOOK_NODE_LIMIT,
      measureJsonBytes,
      metadataRecoveryAction,
      notebookCapacity,
      capacityText,
      capacityNoOutputsText,
      shouldScheduleAutosave,
      resolveRestartPython,
      executeReplyFailed,
      kernelRestartedReply,
      shouldHandleCellEvent,
      cellTypeChangeLosesData,
      saveButtonDisabled,
      isStaleSaveResponse,
      shouldRestoreOutputsAfterRun,
      emptyNotebook,
      readNotebook,
      postJson,
      normalizePosix,
      dirnamePosix,
      isAbsoluteLocalPath,
      makeImageResolver,
      isImeKeyEvent,
      isSaveShortcut,
      blockedAutosaveDelay,
      dedentSourceLine,
      renderJsonOutput,
      splitSourceLines,
      apply,
      NotebookView,
      CellView,
      OutputView,
    }

    return { inject: ['betterSidebar'], apply, __test }
  },
})
