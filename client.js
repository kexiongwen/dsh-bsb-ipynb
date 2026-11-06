window.__ModuleLoader__.load({
  id: 'dsh-bsb-ipynb',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const STYLE_ID = 'dsh-bsb-ipynb-styles'
    const AUTOSAVE_MS = 1500
    const STATUS_POLL_MS = 10000

    const STRINGS = {
      en: {
        runAll: 'Run all',
        run: 'Run',
        interrupt: 'Interrupt',
        restart: 'Restart',
        save: 'Save',
        reload: 'Reload',
        shutdown: 'Shut down kernel',
        kernel: 'Kernel',
        python: 'Python',
        busy: 'busy',
        idle: 'idle',
        off: 'off',
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
        capacityTooLarge: 'Notebook is {size} MiB; the save limit is 32 MiB. Clear outputs and save again.',
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
        shortcuts: 'Ctrl/Cmd+Enter run, Shift+Enter run and advance, Alt+Enter add cell below, Ctrl/Cmd+S save',
        emptyFile: 'Empty file — a new notebook will be created on save.',
      },
      zh: {
        runAll: '全部运行',
        run: '运行',
        interrupt: '中断',
        restart: '重启',
        save: '保存',
        reload: '重新加载',
        shutdown: '关闭内核',
        kernel: '内核',
        python: 'Python',
        busy: '运行中',
        idle: '空闲',
        off: '未启动',
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
        capacityTooLarge: 'notebook 内容约 {size} MiB，保存上限为 32 MiB。请清空输出后再保存。',
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
        shortcuts: 'Ctrl/Cmd+Enter 运行，Shift+Enter 运行并跳到下一个，Alt+Enter 在下方插入，Ctrl/Cmd+S 保存',
        emptyFile: '空文件 — 保存时将创建新的 notebook。',
      },
    }

    const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en'
    const dict = /^zh/i.test(locale) ? STRINGS.zh : STRINGS.en
    const t = (key) => dict[key] ?? STRINGS.en[key] ?? key

    const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPE[char])
    }

    function sanitizeUrl(value, options) {
      if (typeof value !== 'string') return null
      // Browsers normalize ASCII control characters out of URLs, so remove them
      // before the allowlist check or `java\nscript:` becomes `javascript:`.
      const url = value.replace(/[\u0000-\u001F\u007F]/g, '').trim()
      if (!url) return null
      if (/^(javascript|vbscript|file):/i.test(url)) return null
      if (url.startsWith('attachment:')) return url
      if (/^data:/i.test(url)) {
        return options && options.image && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(url) ? url : null
      }
      if (/^(https?:|mailto:|tel:)/i.test(url)) return url
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

    function cleanNode(node) {
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
          cleanNode(node)
          continue
        }
        for (const attribute of Array.from(child.attributes)) {
          const name = attribute.name.toLowerCase()
          if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
            child.removeAttribute(attribute.name)
            continue
          }
          if (name === 'href' || name === 'src') {
            const safe = sanitizeUrl(attribute.value, { image: name === 'src' })
            if (safe) child.setAttribute(name, safe)
            else child.removeAttribute(name)
          }
        }
        if (tag === 'a') {
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noreferrer noopener')
        }
        cleanNode(child)
      }
    }

    function sanitizeHtml(html) {
      if (typeof DOMParser === 'undefined') return escapeHtml(html)
      const document = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
      cleanNode(document.body)
      return document.body.innerHTML
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

    function renderInline(value) {
      let text = escapeHtml(value)
      const codes = []
      text = text.replace(/`([^`]+)`/g, (match, code) => {
        codes.push(code)
        return '\u0000CODE' + (codes.length - 1) + '\u0000'
      })
      text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, src) => {
        const url = sanitizeUrl(src, { image: true })
        if (!url) return alt
        return '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '" loading="lazy">'
      })
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
        const url = sanitizeUrl(href)
        if (!url) return label
        return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">' + label + '</a>'
      })
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
      text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
      text = text.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      text = text.replace(/(^|[^_])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
      text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, prefix, url) => {
        return prefix + '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(url) + '</a>'
      })
      text = text.replace(/\u0000CODE(\d+)\u0000/g, (match, index) => '<code>' + escapeHtml(codes[Number(index)]) + '</code>')
      return text
    }

    function renderMarkdown(source, options) {
      const settings = options || {}
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
        const fence = line.match(/^\s*(```+|~~~+)\s*([\w-]*)\s*$/)
        if (fence) {
          const marker = fence[1][0] === '`' ? '```' : '~~~'
          const language = fence[2]
          const body = []
          index += 1
          while (index < lines.length && !new RegExp('^\\s*' + marker + '\\s*$').test(lines[index])) {
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
          html += '<blockquote>' + renderMarkdown(quote.join('\n'), settings) + '</blockquote>'
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
      return html.replace(/<img src="([^"]*)" alt="([^"]*)"/g, (match, src, alt) => {
        const resolved = resolveImage(src)
        if (!resolved) return '<span class="dsh-bsb-ipynb-missing-image">' + alt + '</span>'
        return '<img src="' + escapeHtml(resolved) + '" alt="' + alt + '" loading="lazy"'
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
      const source = String(input ?? '')
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
      const source = String(code ?? '')
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
      const parts = String(value ?? '').replace(/\\/g, '/').split('/')
      const output = []
      const absolute = parts[0] === ''
      for (const part of parts) {
        if (!part || part === '.') continue
        if (part === '..') {
          if (output.length && output[output.length - 1] !== '..') output.pop()
          else if (!absolute) output.push('..')
          continue
        }
        output.push(part)
      }
      return (absolute ? '/' : '') + output.join('/')
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

    async function postJson(ctx, method, body, signal) {
      const response = await fetch(routeUrl(ctx, method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      return readResponse(response)
    }

    async function getJson(ctx, method, query) {
      const params = new URLSearchParams(query || {})
      const suffix = params.toString() ? '?' + params.toString() : ''
      const response = await fetch(routeUrl(ctx, method) + suffix, { method: 'GET' })
      return readResponse(response)
    }

    async function readNotebook(ctx, path, scope, signal) {
      try {
        return await postJson(ctx, 'read', { sessionId: scope && scope.sessionId, path }, signal)
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        return {
          status: 'error',
          code: (error && error.code) || 'network',
          message: (error && error.message) || String(error),
        }
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
      if (!response.body) throw new Error('Streaming is not supported by this browser.')
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

    // Autosave must recover after a failed save once the user edits again,
    // but must not retry the same failing snapshot in a loop.
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

    function serializeNotebook(notebook) {
      const value = normalizeNotebook(notebook)
      value.nbformat = 4
      value.nbformat_minor = 5
      value.cells = value.cells.map((cell) => {
        const copy = { ...cell, id: cell.id || newCellId() }
        if (copy.cell_type === 'code') {
          copy.outputs = Array.isArray(copy.outputs)
            ? copy.outputs.map(stripIllegalOutputFields)
            : []
          copy.execution_count = typeof copy.execution_count === 'number' ? copy.execution_count : null
        }
        const source = String(copy.source ?? '')
        copy.source = source === '' ? [] : source.split(/(?<=\n)/)
        return copy
      })
      return JSON.stringify(value, null, 2) + '\n'
    }

    // Keep in sync with NOTEBOOK_CAP_BYTES in lib/notebook.js. The server
    // writes pretty-printed nbformat JSON and rejects anything above this cap
    // with 413, so measuring the same serialization is the strictest check.
    const NOTEBOOK_CAP_BYTES = 32 * 1024 * 1024
    const capacityEncoder = new TextEncoder()

    function notebookCapacity(notebook, limit = NOTEBOOK_CAP_BYTES) {
      if (!notebook || !Array.isArray(notebook.cells)) return { ok: true, bytes: 0 }
      const bytes = capacityEncoder.encode(serializeNotebook(notebook)).byteLength
      return { ok: bytes <= limit, bytes }
    }

    function capacityText(bytes) {
      return t('capacityTooLarge').replace('{size}', (bytes / 1048576).toFixed(1))
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
      const value = Array.isArray(data) ? data.join('') : String(data ?? '')
      if (!value) return ''
      return 'data:' + mime + ';base64,' + (mime === 'image/svg+xml' ? toBase64(value) : value)
    }

    function makeImageResolver(ctx, scope, notebookPath, cell) {
      const attachments = (cell && cell.attachments) || {}
      let base = null
      if (notebookPath && notebookPath.startsWith('/')) base = dirnamePosix(notebookPath)
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
          const name = decodeURIComponent(source.slice('attachment:'.length))
          const attachment = attachments[name]
          if (!attachment) return null
          const mime = Object.keys(attachment)[0]
          if (!mime) return null
          return imageSource(attachment[mime], mime)
        }
        if (/^data:image\//i.test(source)) return source
        if (/^https?:\/\//i.test(source)) return source
        if (source.startsWith('/')) return fileUrl(normalizePosix(source))
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
    const outputEncoder = new TextEncoder()
    const outputSizes = new WeakMap()
    const outputBudgets = new WeakMap()

    function jsonBytes(value) {
      return outputEncoder.encode(JSON.stringify(value) ?? 'null').byteLength
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
      let outputs = Array.isArray(previous) ? previous : []
      if (!event || !OUTPUT_EVENTS.has(event.type)) return outputs
      let budget = outputBudget(outputs)
      if (event.type === 'clear_output') {
        if (!event.wait) return []
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
        const payloadBytes = jsonBytes(data) + jsonBytes(metadata)
        const replacements = []
        let bytes = budget.bytes
        for (const index of matches) {
          const old = outputs[index]
          // Encode the shared payload once, including all nested values and
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

    function OutputView({ output, resolveImage }) {
      if (!output || typeof output !== 'object') return null
      if (output.output_type === 'stream') {
        return h('pre', {
          className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-stream dsh-bsb-ipynb-stream-' + (output.name || 'stdout'),
          dangerouslySetInnerHTML: { __html: ansiToHtml(output.text || '') },
        })
      }
      if (output.output_type === 'error') {
        const text = Array.isArray(output.traceback) && output.traceback.length
          ? output.traceback.join('\n')
          : String(output.ename || 'Error') + ': ' + String(output.evalue || '')
        return h('pre', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-error', dangerouslySetInnerHTML: { __html: ansiToHtml(text) } })
      }
      const data = output.data || {}
      const html = data['text/html'] != null ? mimeText(data['text/html']) : null
      if (html !== null) {
        return h('div', {
          className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-html',
          dangerouslySetInnerHTML: { __html: sanitizeHtml(html) },
        })
      }
      if (data['image/svg+xml'] != null) {
        const src = imageSource(data['image/svg+xml'], 'image/svg+xml')
        if (src) return h('img', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-image', src, alt: 'output' })
      }
      const png = data['image/png'] != null ? imageSource(data['image/png'], 'image/png') : null
      if (png) return h('img', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-image', src: png, alt: 'output' })
      const jpeg = data['image/jpeg'] != null ? imageSource(data['image/jpeg'], 'image/jpeg') : null
      if (jpeg) return h('img', { className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-image', src: jpeg, alt: 'output' })
      if (data['text/markdown'] != null) {
        return h('div', {
          className: 'dsh-bsb-ipynb-output dsh-bsb-ipynb-markdown',
          // Output markdown can reference attachment:/relative images just like
          // markdown cells, so use the image-aware renderer here too.
          dangerouslySetInnerHTML: { __html: renderMarkdownWithImages(mimeText(data['text/markdown']), resolveImage) },
        })
      }
      if (typeof data['application/json'] !== 'undefined') {
        const value = typeof data['application/json'] === 'string'
          ? data['application/json']
          : JSON.stringify(data['application/json'], null, 2)
        return h('pre', { className: 'dsh-bsb-ipynb-output' }, value)
      }
      if (data['text/latex'] != null) {
        return h('pre', { className: 'dsh-bsb-ipynb-output' }, mimeText(data['text/latex']))
      }
      if (data['text/plain'] != null) {
        return h('pre', { className: 'dsh-bsb-ipynb-output' }, mimeText(data['text/plain']))
      }
      return h('pre', { className: 'dsh-bsb-ipynb-output' }, JSON.stringify(data, null, 2))
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
        } else if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          onSave()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          const element = event.currentTarget
          const start = element.selectionStart
          const end = element.selectionEnd
          const next = source.slice(0, start) + '    ' + source.slice(end)
          onSource(cell.id, next)
          requestAnimationFrame(() => {
            element.selectionStart = element.selectionEnd = start + 4
          })
        }
      }
      const code = cell.cell_type === 'code'
      const markdown = cell.cell_type === 'markdown'
      return h(
        'div',
        { className: 'dsh-bsb-ipynb-cell dsh-bsb-ipynb-cell-' + cell.cell_type + (running ? ' dsh-bsb-ipynb-cell-running' : '') },
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
                  if (event.key === 'Enter') onEdit(cell.id)
                },
                dangerouslySetInnerHTML: { __html: source ? highlightPython(source) : '<span class="dsh-bsb-ipynb-empty-source"> </span>' },
              })
          : markdown
            ? editing
              ? h('textarea', {
                  ref: textareaRef,
                  className: 'dsh-bsb-ipynb-source-editor',
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
                    if (event.key === 'Enter') onEdit(cell.id)
                  },
                }, source),
        code && Array.isArray(cell.outputs) && cell.outputs.length
          ? h('div', { className: 'dsh-bsb-ipynb-outputs' }, cell.outputs.map((output, outputIndex) => h(OutputView, { key: outputIndex, output, resolveImage })))
          : null,
      )
    }

    function Toolbar(props) {
      const { kernel, python, interpreters, running, runAllRunning, onRunAll, onInterrupt, onRestart, onShutdown, onSave, onReload, onPython, saveState, dirty, conflict } = props
      const state = !kernel.running ? t('off') : kernel.busy ? t('busy') : t('idle')
      return h(
        'div',
        { className: 'dsh-bsb-ipynb-toolbar' },
        h(
          'div',
          { className: 'dsh-bsb-ipynb-toolbar-group' },
          h('span', {
            className:
              'dsh-bsb-ipynb-kernel-dot' +
              (kernel.running ? (kernel.busy ? ' is-busy' : ' is-ready') : ''),
            title: t('kernel') + ': ' + state,
          }),
          h('span', { className: 'dsh-bsb-ipynb-kernel-label' }, state),
          h(
            'select',
            {
              className: 'dsh-bsb-ipynb-python-select',
              title: t('python'),
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
          h(IconButton, { title: t('runAll'), disabled: !python || running || runAllRunning, onClick: onRunAll }, '▶▶'),
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
      return h(
        'div',
        { className: 'dsh-bsb-ipynb-banner dsh-bsb-ipynb-banner-' + (banner.kind || 'info') },
        h('span', { className: 'dsh-bsb-ipynb-banner-text' }, banner.text),
        banner.action === 'reload'
          ? h(IconButton, { title: t('reload'), onClick: onReload }, t('reload'))
          : banner.action === 'clear-outputs'
            ? h(IconButton, { title: t('clearAllOutputs'), onClick: onClearOutputs }, t('clearAllOutputs'))
            : null,
      )
    }

    function NotebookView(props) {
      const { ctx, scope, path, customData, onToolbarState, onReload, visible } = props
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
      const [capacityBlocked, setCapacityBlocked] = useState(false)
      const [editingCell, setEditingCell] = useState(null)
      const [runningCell, setRunningCell] = useState(null)
      const [runAllRunning, setRunAllRunning] = useState(false)
      const [kernel, setKernel] = useState({ running: false, ready: false, busy: false, python: null, executionState: 'none', lastError: null })
      const [interpreters, setInterpreters] = useState([])
      const [python, setPython] = useState('')
      const customRef = useRef(customData)
      const dirtyRef = useRef(false)
      const notebookRef = useRef(notebook)
      const versionRef = useRef(version)
      const runningRef = useRef(null)
      const activeRunRef = useRef(null)
      const savingRef = useRef(null)
      const saveRef = useRef(null)
      const pythonRef = useRef('')
      const forceReloadRef = useRef(false)
      const saveTimerRef = useRef(null)
      const stopRef = useRef(false)
      const runAllRef = useRef(null)
      const abortRef = useRef(null)
      const pollRef = useRef(null)
      const failedSnapshotRef = useRef(null)
      const documentSeqRef = useRef(0)
      const notebookRevisionRef = useRef(0)
      const notifiedTruncationsRef = useRef(new WeakSet())

      dirtyRef.current = dirty
      notebookRef.current = notebook
      versionRef.current = version
      pythonRef.current = python

      const markDirty = useCallback(() => {
        forceReloadRef.current = false
        notebookRevisionRef.current += 1
        dirtyRef.current = true
        setDirty(true)
      }, [])

      const invalidateDocumentWork = useCallback(() => {
        // Invalidate first: aborting the old stream can immediately reject it.
        documentSeqRef.current += 1
        notebookRevisionRef.current += 1
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
      }, [])

      const adopt = useCallback((data) => {
        // A confirmed reload replaces the document; a cancelled prompt never
        // reaches this point and must leave its execution and draft intact.
        invalidateDocumentWork()
        setRunningCell(null)
        setRunAllRunning(false)
        setSaveState('idle')
        setCapacityBlocked(false)
        if (!data || typeof data !== 'object') {
          setLoadStatus('error')
          setLoadMessage('Invalid server response')
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
          dirtyRef.current = false
          setDirty(false)
          setConflict(null)
          setAutosaveBlocked(false)
          failedSnapshotRef.current = null
          setBanner(data.emptyFile ? { kind: 'info', text: t('emptyFile') } : null)
          return
        }
        notebookRef.current = null
        setNotebook(null)
        setVersion(data.version || '')
        versionRef.current = data.version || ''
        setLoadStatus(data.status || 'error')
        setLoadError(data.error || null)
        setLoadMessage(data.message || null)
        setBanner(null)
      }, [invalidateDocumentWork])

      useEffect(() => {
        if (customData === customRef.current) return
        customRef.current = customData
        if (dirtyRef.current && !forceReloadRef.current) return
        forceReloadRef.current = false
        adopt(customData)
      }, [customData, adopt])

      const reload = useCallback(() => {
        forceReloadRef.current = true
        // The host owns the unsaved-changes confirmation and the reload itself.
        // Delegating avoids overwriting the draft when the user cancels the
        // host's "discard changes?" prompt. Conflict/banner state is only
        // cleared by a successful adopt(), so a cancelled prompt keeps the
        // conflict explanation and keeps saving blocked.
        if (typeof onReload === 'function') {
          onReload()
          return
        }
        readNotebook(ctx, path, scope).then((data) => adopt(data)).catch(() => {})
      }, [ctx, path, scope, onReload, adopt])

      const openAsEmpty = useCallback(() => {
        invalidateDocumentWork()
        setRunningCell(null)
        setRunAllRunning(false)
        setSaveState('idle')
        setCapacityBlocked(false)
        const nextNotebook = emptyNotebook()
        notebookRef.current = nextNotebook
        setNotebook(nextNotebook)
        setLoadStatus('ok')
        setLoadError(null)
        setLoadMessage(null)
        dirtyRef.current = false
        setDirty(false)
        setAutosaveBlocked(true)
        setBanner({ kind: 'info', text: t('emptyHint') })
      }, [invalidateDocumentWork])

      const save = useCallback(async () => {
        // All entry points (including Ctrl+S and an already queued autosave)
        // must avoid persisting the transient, cleared outputs of a running cell.
        if (runningRef.current || runAllRef.current || savingRef.current || !notebookRef.current || loadStatus !== 'ok') return
        if (conflict) {
          // A 409 blocks saving until the user reloads; surface that instead of
          // silently ignoring the click or Ctrl+S.
          setSaveState('failed')
          setBanner({ kind: 'error', text: t('conflict'), action: 'reload' })
          return
        }
        const snapshot = notebookRef.current
        const capacity = notebookCapacity(snapshot)
        if (!capacity.ok) {
          // Refuse before serializing the upload: a 413 after the fact would
          // repeat on every autosave and cannot be fixed by editing the source.
          setSaveState('failed')
          setCapacityBlocked(true)
          setBanner({ kind: 'error', reason: 'capacity', text: capacityText(capacity.bytes), action: 'clear-outputs' })
          return
        }
        setCapacityBlocked(false)
        const seq = documentSeqRef.current
        const revision = notebookRevisionRef.current
        const request = { seq }
        savingRef.current = request
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
          setEmptyFile(false)
          setConflict(null)
          setBanner(null)
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(() => {
            setSaveState((current) => (!isStaleSaveResponse(documentSeqRef.current, seq) && current === 'saved' ? 'idle' : current))
          }, 1000)
        } catch (error) {
          if (!isCurrentSave()) return
          failedSnapshotRef.current = snapshot
          setSaveState('failed')
          if (error && error.code === 'write-conflict') {
            setConflict((error.details && error.details.version) || 'conflict')
            setBanner({ kind: 'error', text: t('conflict'), action: 'reload' })
          } else {
            setBanner({ kind: 'error', text: t('saveFailed') + (error && error.message ? ': ' + error.message : '') })
          }
        } finally {
          if (isCurrentSave()) savingRef.current = null
        }
      }, [ctx, path, scope, loadStatus, conflict])

      saveRef.current = save

      const refreshKernel = useCallback(async () => {
        try {
          const value = await getJson(ctx, 'status', { sessionId: scope && scope.sessionId, path })
          setKernel(value)
        } catch {
          /* ignore */
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
              : usable.some((entry) => entry.path === value.default)
                ? value.default
                : usable[0] && usable[0].path
            if (chosen) setPython(chosen)
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [ctx, path])

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
        const changedSinceFailure = failedSnapshotRef.current === null || notebook !== failedSnapshotRef.current
        if (!shouldScheduleAutosave({ loadStatus, dirty, conflict, autosaveBlocked, capacityBlocked, runningCell, saveState, notebookChangedSinceFailure: changedSinceFailure })) return undefined
        const timer = setTimeout(() => {
          void saveRef.current()
        }, AUTOSAVE_MS)
        return () => clearTimeout(timer)
      }, [dirty, notebook, conflict, autosaveBlocked, capacityBlocked, saveState, loadStatus, runningCell])

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
          setBanner((current) => (current && current.kind === 'error' ? current : { kind: 'info', reason: 'output-limit', text: t('outputTruncated') }))
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

      const updateRunOutputs = useCallback((seq, cellId, event) => {
        updateRunCell(seq, cellId, (cell) => {
          const outputs = reduceOutputs(cell.outputs, event)
          return outputs === cell.outputs ? cell : { ...cell, outputs }
        })
      }, [updateRunCell])

      const handleEvent = useCallback((run, event) => {
        if (activeRunRef.current !== run || isStaleSaveResponse(documentSeqRef.current, run.seq)) return
        const { seq, cellId } = run
        if (!event || typeof event.type !== 'string') return
        if (!shouldHandleCellEvent(cellId, event)) return
        if (event.type === 'ping') return
        if (event.type === 'status') {
          const state = event.execution_state || 'idle'
          setKernel((previous) => ({ ...previous, running: true, ready: true, executionState: state, busy: state === 'busy' }))
          return
        }
        if (OUTPUT_EVENTS.has(event.type)) {
          updateRunOutputs(seq, cellId, event)
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
            setBanner({ kind: 'error', text: t('kernelRestarted') })
          }
          if (typeof event.execution_count === 'number') {
            updateRunCell(seq, cellId, (cell) => ({ ...cell, execution_count: event.execution_count }))
          }
          markDirty()
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
          setBanner({ kind: 'error', text: event.message || t('kernelDied') })
          setKernel((previous) => ({ ...previous, running: false, ready: false, busy: false, executionState: 'none' }))
          return
        }
        if (event.type === 'fatal') {
          run.failed = true
          setBanner({ kind: 'error', text: event.message || t('loadError') })
        }
      }, [updateRunOutputs, updateRunCell, markDirty])

      const runCell = useCallback(async (cellId) => {
        if (runningRef.current || conflict || loadStatus !== 'ok') return false
        const current = notebookRef.current
        const cell = current && current.cells.find((entry) => entry.id === cellId)
        if (!cell || cell.cell_type !== 'code') return false
        // Snapshot the displayed outputs so a run that never reaches an
        // execute_reply (fatal / kernel_died / truncated stream / abort) can
        // restore them instead of leaving the cell wiped.
        const previousOutputs = Array.isArray(cell.outputs) ? cell.outputs : []
        const previousExecutionCount = typeof cell.execution_count === 'number' ? cell.execution_count : null
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const run = { seq: documentSeqRef.current, cellId, replySeen: false, failed: false }
        const isCurrentRun = () => activeRunRef.current === run && !isStaleSaveResponse(documentSeqRef.current, run.seq)
        activeRunRef.current = run
        abortRef.current = controller
        // A save started before execution must not clear dirty using a ref
        // that React has not yet updated with this run's queued changes.
        notebookRevisionRef.current += 1
        setEditingCell(null)
        setCapacityBlocked(false)
        runningRef.current = cellId
        setRunningCell(cellId)
        setKernel((previous) => ({ ...previous, running: true, busy: true, executionState: 'busy' }))
        updateRunCell(run.seq, cellId, (entry) => ({ ...entry, outputs: [], execution_count: null }))
        const restorePreRunOutputs = () => {
          if (!isCurrentRun()) return
          // No save can start during execution. Restore only the outputs and
          // preserve dirty/source edits (including a pre-run save completing).
          updateRunCell(run.seq, cellId, (entry) => ({ ...entry, outputs: previousOutputs, execution_count: previousExecutionCount }))
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
            if (!run.failed) setBanner({ kind: 'error', text: t('streamIncomplete') })
            run.failed = true
          }
          return !run.failed
        } catch (error) {
          if (!isCurrentRun()) return false
          if (error && error.name === 'AbortError') {
            if (shouldRestoreOutputsAfterRun(run.replySeen)) restorePreRunOutputs()
            return false
          }
          const code = error && error.code
          if (code === 'kernel-unavailable' || code === 'interpreter-unknown') {
            setBanner({ kind: 'error', text: t('kernelUnavailable') + ' ' + t('installHint') })
          } else {
            setBanner({ kind: 'error', text: (error && error.message) || t('kernelDied') })
          }
          setKernel((previous) => ({ ...previous, busy: false, executionState: 'idle' }))
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
      }, [ctx, path, scope, conflict, loadStatus, handleEvent, updateRunCell])

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
          if (error && error.code === 'kernel-unavailable') setBanner({ kind: 'info', text: t('kernel') + ': ' + t('off') })
        }
      }, [ctx, path, scope])

      const restart = useCallback(async (nextPython) => {
        try {
          const value = await postJson(ctx, 'restart', {
            sessionId: scope && scope.sessionId,
            path,
            python: resolveRestartPython(nextPython, pythonRef.current),
          })
          setBanner({ kind: 'info', text: t('kernel') + ': ' + (value.python || pythonRef.current || '') })
          await refreshKernel()
        } catch (error) {
          setBanner({ kind: 'error', text: (error && error.message) || t('kernelDied') })
        }
      }, [ctx, path, scope, refreshKernel])

      const shutdown = useCallback(async () => {
        try {
          await postJson(ctx, 'shutdown', { sessionId: scope && scope.sessionId, path })
          setKernel({ running: false, ready: false, busy: false, python: null, executionState: 'none', lastError: null })
        } catch (error) {
          if (error && error.code === 'kernel-unavailable') setKernel({ running: false, ready: false, busy: false, python: null, executionState: 'none', lastError: null })
        }
      }, [ctx, path, scope])

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
        setNotebook((previous) => updateCell(previous, cellId, (cell) => ({ ...cell, source: value })))
        // A cancelled host reload leaves forceReloadRef set; new edits must not
        // be replaced by a later customData adoption.
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
        setEditingCell(cell.id)
        return cell.id
      }, [])

      const runAndAdvance = useCallback((cellId) => {
        const current = notebookRef.current
        if (!current) return
        const index = current.cells.findIndex((cell) => cell.id === cellId)
        const next = current.cells.slice(index + 1).find((cell) => cell.cell_type === 'code')
        if (next) setEditingCell(next.id)
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
              onEdit: (cellId) => setEditingCell(cellId),
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
        h('div', { className: 'dsh-bsb-ipynb-shortcuts' }, t('shortcuts')),
      )
    }

    const STYLES = `
.dsh-bsb-ipynb-root {
  --dsh-bsb-ipynb-border: var(--dsw-border-default, rgba(127, 127, 127, 0.28));
  --dsh-bsb-ipynb-soft: rgba(127, 127, 127, 0.09);
  --dsh-bsb-ipynb-soft-strong: rgba(127, 127, 127, 0.16);
  --dsh-bsb-ipynb-muted: var(--dsw-text-muted, rgba(127, 127, 127, 0.95));
  --dsh-bsb-ipynb-accent: var(--dsw-accent-default, #4c8dff);
  --dsh-bsb-ipynb-surface: var(--dsw-surface-default, Canvas);
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  color: inherit;
  font-size: 13px;
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
  background: rgba(127, 127, 127, 0.55);
  flex: none;
}
.dsh-bsb-ipynb-kernel-dot.is-ready { background: #2ea043; }
.dsh-bsb-ipynb-kernel-dot.is-busy { background: #d29922; animation: dsh-bsb-ipynb-pulse 1.2s ease-in-out infinite; }
@keyframes dsh-bsb-ipynb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.dsh-bsb-ipynb-kernel-label { color: var(--dsh-bsb-ipynb-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.dsh-bsb-ipynb-python-select {
  max-width: 210px;
  font-size: 11px;
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
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}
.dsh-bsb-ipynb-button:hover:not(:disabled) { background: var(--dsh-bsb-ipynb-soft-strong); }
.dsh-bsb-ipynb-button:disabled { opacity: 0.4; cursor: default; }
.dsh-bsb-ipynb-save-state { color: var(--dsh-bsb-ipynb-muted); font-size: 11px; }
.dsh-bsb-ipynb-save-state.is-error { color: #cf222e; }
.dsh-bsb-ipynb-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsh-bsb-ipynb-border);
  font-size: 12px;
}
.dsh-bsb-ipynb-banner-info { background: rgba(76, 141, 255, 0.12); }
.dsh-bsb-ipynb-banner-error { background: rgba(207, 34, 46, 0.12); }
.dsh-bsb-ipynb-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-bsb-ipynb-cells { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.dsh-bsb-ipynb-cell {
  border: 1px solid var(--dsh-bsb-ipynb-border);
  border-radius: 6px;
  margin-bottom: 8px;
  background: var(--dsh-bsb-ipynb-soft);
  overflow: hidden;
}
.dsh-bsb-ipynb-cell-running { border-color: var(--dsh-bsb-ipynb-accent); }
.dsh-bsb-ipynb-cell-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--dsh-bsb-ipynb-border);
  color: var(--dsh-bsb-ipynb-muted);
  font-size: 11px;
  min-height: 26px;
}
.dsh-bsb-ipynb-prompt {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  min-width: 24px;
  color: var(--dsh-bsb-ipynb-muted);
}
.dsh-bsb-ipynb-cell-label { text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; }
.dsh-bsb-ipynb-cell-actions { margin-left: auto; display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.dsh-bsb-ipynb-cell-actions .dsh-bsb-ipynb-button { padding: 1px 5px; font-size: 10px; }
.dsh-bsb-ipynb-cell-type {
  font-size: 10px;
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
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
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
.dsh-bsb-ipynb-source:focus { outline: 1px solid var(--dsh-bsb-ipynb-accent); outline-offset: -1px; }
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
.dsh-bsb-ipynb-markdown code,
.dsh-bsb-ipynb-html code,
.dsh-bsb-ipynb-md-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  background: var(--dsh-bsb-ipynb-soft-strong);
  border-radius: 3px;
  padding: 0.1em 0.3em;
}
.dsh-bsb-ipynb-md-code { display: block; padding: 8px 10px; overflow-x: auto; border-radius: 5px; white-space: pre; }
.dsh-bsb-ipynb-md-code code { background: transparent; padding: 0; }
.dsh-bsb-ipynb-markdown pre,
.dsh-bsb-ipynb-html pre { background: var(--dsh-bsb-ipynb-soft-strong); border-radius: 5px; padding: 8px 10px; overflow-x: auto; }
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
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: auto;
}
.dsh-bsb-ipynb-output + .dsh-bsb-ipynb-output { border-top: 1px dashed var(--dsh-bsb-ipynb-border); }
.dsh-bsb-ipynb-stream-stderr { color: #cf222e; }
.dsh-bsb-ipynb-error { color: #cf222e; }
.dsh-bsb-ipynb-html { font-family: inherit; white-space: normal; }
.dsh-bsb-ipynb-image { display: block; max-width: 100%; background: white; }
.dsh-bsb-ipynb-raw { color: var(--dsh-bsb-ipynb-muted); cursor: text; }
.dsh-bsb-ipynb-card { margin: 16px; padding: 16px; border: 1px solid var(--dsh-bsb-ipynb-border); border-radius: 8px; background: var(--dsh-bsb-ipynb-soft); }
.dsh-bsb-ipynb-card-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.dsh-bsb-ipynb-card-detail { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--dsh-bsb-ipynb-soft-strong); border-radius: 5px; padding: 8px 10px; font-size: 12px; }
.dsh-bsb-ipynb-card-actions { display: flex; gap: 6px; margin-top: 12px; }
.dsh-bsb-ipynb-add { display: flex; align-items: center; gap: 6px; padding: 0 8px 8px; }
.dsh-bsb-ipynb-hint { color: var(--dsh-bsb-ipynb-muted); font-size: 11px; }
.dsh-bsb-ipynb-empty { padding: 8px 10px; color: var(--dsh-bsb-ipynb-muted); }
.dsh-bsb-ipynb-shortcuts { padding: 0 8px 8px; color: var(--dsh-bsb-ipynb-muted); font-size: 10px; }
.dsh-bsb-ipynb-tok-keyword { color: #cf222e; }
.dsh-bsb-ipynb-tok-string { color: #0a3069; }
.dsh-bsb-ipynb-tok-comment { color: #6e7781; font-style: italic; }
.dsh-bsb-ipynb-tok-number { color: #0550ae; }
.dsh-bsb-ipynb-tok-builtin { color: #8250df; }
.dsh-bsb-ipynb-tok-class { color: #953800; }
@media (prefers-color-scheme: dark) {
  .dsh-bsb-ipynb-tok-keyword { color: #ff7b72; }
  .dsh-bsb-ipynb-tok-string { color: #a5d6ff; }
  .dsh-bsb-ipynb-tok-comment { color: #8b949e; }
  .dsh-bsb-ipynb-tok-number { color: #79c0ff; }
  .dsh-bsb-ipynb-tok-builtin { color: #d2a8ff; }
  .dsh-bsb-ipynb-tok-class { color: #ffa657; }
  .dsh-bsb-ipynb-stream-stderr,
  .dsh-bsb-ipynb-error { color: #ff7b72; }
  .dsh-bsb-ipynb-save-state.is-error { color: #ff7b72; }
}
`

    function apply(ctx) {
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
          id: 'dsh-bsb-ipynb:notebook',
          title: 'Jupyter Notebook',
          exts: ['ipynb'],
          priority: 10,
          fetchStrategy: 'custom',
          load: (path, scope, signal) => readNotebook(ctx, path, scope, signal),
          component: NotebookView,
        }),
      )
    }

    const __test = {
      STRINGS,
      escapeHtml,
      mimeText,
      sanitizeUrl,
      sanitizeHtml,
      ALLOWED_ATTRS,
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
      notebookCapacity,
      capacityText,
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
      normalizePosix,
      dirnamePosix,
      apply,
      NotebookView,
      CellView,
    }

    return { inject: ['betterSidebar'], apply, __test }
  },
})
