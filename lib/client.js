/**
 * MCP Hub —— Client（浏览器）侧 UI。
 *
 * 在「设置」面板注册一个 MCP Hub 页：可视化列出所有 MCP server，支持
 * 启停、编辑、删除、连接测试，以及核心的**多格式导入**（Codex TOML /
 * 各类 JSON 变体 / VS Code mcp.json），并提示补填被占位符隐藏的密钥。
 *
 * 依赖：平台提供的 `react`、`ctx.slots`、`ctx.locale`、`ctx.connection`。
 * 不引入任何 Harness Client 包；样式仅使用主题 token。
 */

window.__ModuleLoader__.load({
  id: '@yyh/dsh-mcp-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useMemo = React.useMemo

    const RPC_CHANNEL = '/mcp-hub'
    const NS = 'mcpHub'

    // -----------------------------------------------------------------------
    // 文案
    // -----------------------------------------------------------------------

    const zh = {
      nav: 'MCP Hub',
      title: 'MCP 服务器',
      subtitle: '导入并管理 MCP 服务器（Codex / Claude / Cursor / VS Code 格式）',
      refresh: '刷新',
      loading: '正在加载…',
      empty: '还没有 MCP 服务器。',
      emptyHint: '用「导入」粘贴或选择一份 MCP 配置文件，或直接新增一台。',
      add: '新增',
      import: '导入',
      total: '共 {count} 台',
      enabledCount: '{count} 台已启用',
      connected: '{count} 台已连接',
      failed: '{count} 台失败',
      enable: '启用',
      disable: '停用',
      edit: '编辑',
      remove: '删除',
      test: '测试',
      save: '保存',
      cancel: '取消',
      saved: '已保存',
      disabledTag: '已停用',
      externalTag: '外部配置',
      pendingTag: '待重载',
      secretTag: '待补密钥',
      statusConnected: '已连接 · {count} 个工具',
      statusFailed: '连接失败',
      statusLoading: '加载中',
      statusPending: '等待中',
      statusUnloading: '卸载中',
      statusDisabled: '已停用',
      statusUnknown: '未加载',
      probeOk: '✓ 连接成功，{count} 个工具（{ms}ms）',
      probeFail: '✗ {error}（{ms}ms）',
      removeConfirm: '删除 MCP 服务器「{name}」？\n这会修改 {file} 并断开它的工具。',
      externalWriteHint: '该条目不在 MCP Hub 的配置文件中，无法在面板里修改。',
      fieldId: '条目 ID',
      fieldName: 'serverName',
      fieldTransport: '传输方式',
      fieldUrl: 'URL',
      fieldCommand: '命令',
      fieldArgs: '参数（每行一个）',
      fieldEnv: '环境变量（KEY=VALUE，每行一个）',
      fieldCwd: '工作目录',
      fieldHeaders: '请求头（Key: Value，每行一个）',
      fieldTimeout: '工具调用超时（毫秒）',
      formAdd: '新增 MCP 服务器',
      formEdit: '编辑 {name}',
      errId: '条目 ID 需匹配 [A-Za-z0-9_-]{1,64}',
      errName: 'serverName 需匹配 [A-Za-z0-9_-]{1,32}',
      errUrl: '远程传输需要合法的 http(s) URL',
      errCommand: 'stdio 传输需要命令',
      errDuplicateId: '条目 ID 已被占用',
      errDuplicateName: 'serverName 已被其他服务器使用',
      errInvalid: '配置无效',
      errNotManaged: '该条目不在 MCP Hub 的配置文件中',
      errHostNotLoaded: 'MCP Hub 的 Host 半还没加载（RPC 通道不存在）。插件刚安装或刚更新时需要重启 DSH 才会生效。',
      errUnknown: '操作失败：{message}',
      importTitle: '导入 MCP 配置',
      importPaste: '粘贴配置文本',
      importPasteHint: '支持 Codex config.toml、mcpServers JSON、VS Code servers JSON、顶层单对象 JSON',
      importFromFile: '从本地文件导入',
      readFileHint: '只解析文件里的 MCP 服务器，文件原文不会被读进文本框，也不会显示其中的密钥。',
      readFileFound: '已从 {path} 解析出 {count} 台服务器（{format}）',
      selectAll: '全选',
      selectNone: '全不选',
      importPickHint: '已勾选 {n} 台；取消勾选的不会导入（与已有服务器重名的默认不勾）。',
      expand: '展开详情',
      collapse: '收起详情',
      detailTarget: '连接目标',
      detailState: '状态',
      adopt: '接管',
      adoptConfirm: '把「{name}」搬进 MCP Hub 的配置文件？会先备份来源文件，原行随后从来源文件里移除。',
      adoptDone: '已接管 {count} 台，来源文件备份：{backup}',
      adoptTag: '可接管',
      restart: '重启',
      restarted: '已重启「{name}」，正在重新连接…',
      readFileFound: '已从 {path} 解析出 {count} 台服务器（{format}）',
      importScan: '扫描本机已知位置',
      importScanned: '已发现 {count} 处配置',
      importNoScan: '未发现已知的 MCP 配置文件',
      importServers: '{count} 台',
      importUnreadable: '读取失败',
      importPlaceholder: '在此粘贴 MCP 配置…',
      importFormat: '格式',
      importAuto: '自动识别',
      importPreview: '解析预览',
      importParse: '解析',
      importConfirm: '确认导入',
      importNothing: '没有可导入的服务器。',
      importMasked: '{count} 个密钥值已用占位符替代，导入后请补填。',
      imported: '已导入 {count} 台服务器。',
      importWarnings: '提示',
      importReloadWarning: '配置文件尚未挂载，重启 DSH 后生效。',
      filePlaceholder: '绝对路径，例如 ~/.codex/config.toml',
      readFile: '读取',
      dataFile: '配置文件',
      notMounted: '尚未挂载到 Loader',
      unmountHint: 'MCP Hub 的配置文件还没挂载到 Loader，导入的服务器要重启 DSH 才会生效。',
      mountsTitle: '装载状态',
    }

    const en = {
      nav: 'MCP Hub',
      title: 'MCP servers',
      subtitle: 'Import and manage MCP servers (Codex / Claude / Cursor / VS Code formats)',
      refresh: 'Refresh',
      loading: 'Loading…',
      empty: 'No MCP servers yet.',
      emptyHint: 'Use Import to paste or pick an MCP config file, or add one manually.',
      add: 'Add',
      import: 'Import',
      total: '{count} total',
      enabledCount: '{count} enabled',
      connected: '{count} connected',
      failed: '{count} failed',
      enable: 'Enable',
      disable: 'Disable',
      edit: 'Edit',
      remove: 'Remove',
      test: 'Test',
      save: 'Save',
      cancel: 'Cancel',
      saved: 'Saved',
      disabledTag: 'disabled',
      externalTag: 'external',
      pendingTag: 'pending reload',
      secretTag: 'needs secret',
      statusConnected: 'Connected · {count} tools',
      statusFailed: 'Failed',
      statusLoading: 'Loading',
      statusPending: 'Pending',
      statusUnloading: 'Unloading',
      statusDisabled: 'Disabled',
      statusUnknown: 'Not loaded',
      probeOk: '✓ Connected, {count} tools ({ms}ms)',
      probeFail: '✗ {error} ({ms}ms)',
      removeConfirm: 'Remove MCP server "{name}"?\nThis edits {file} and disconnects its tools.',
      externalWriteHint: 'This entry is not in the MCP Hub config file and cannot be edited here.',
      fieldId: 'Entry id',
      fieldName: 'serverName',
      fieldTransport: 'Transport',
      fieldUrl: 'URL',
      fieldCommand: 'Command',
      fieldArgs: 'Args (one per line)',
      fieldEnv: 'Env (KEY=VALUE, one per line)',
      fieldCwd: 'Working directory',
      fieldHeaders: 'Headers (Key: Value, one per line)',
      fieldTimeout: 'Tool call timeout (ms)',
      formAdd: 'Add MCP server',
      formEdit: 'Edit {name}',
      errId: 'Entry id must match [A-Za-z0-9_-]{1,64}',
      errName: 'serverName must match [A-Za-z0-9_-]{1,32}',
      errUrl: 'A valid http(s) URL is required',
      errCommand: 'A command is required for stdio',
      errDuplicateId: 'Entry id already in use',
      errDuplicateName: 'serverName already used by another server',
      errInvalid: 'Invalid configuration',
      errNotManaged: 'This entry is not in the MCP Hub config file',
      errHostNotLoaded: 'The MCP Hub Host half is not loaded yet (its RPC channel does not exist). Restart DSH after installing or updating the plugin.',
      errUnknown: 'Operation failed: {message}',
      importTitle: 'Import MCP config',
      importPaste: 'Paste config text',
      importPasteHint: 'Supports Codex config.toml, mcpServers JSON, VS Code servers JSON, and single-object JSON',
      importFromFile: 'Import from a local file',
      readFileHint: 'Only the MCP servers in the file are parsed. The raw file is never loaded into the text box, and its secrets are not displayed.',
      readFileFound: 'Parsed {count} server(s) from {path} ({format})',
      selectAll: 'Select all',
      selectNone: 'Select none',
      importPickHint: '{n} selected; unchecked entries are not imported (names clashing with existing servers start unchecked).',
      expand: 'Show details',
      collapse: 'Hide details',
      detailTarget: 'Target',
      detailState: 'State',
      adopt: 'Adopt',
      adoptConfirm: 'Move "{name}" into the MCP Hub config file? The source file is backed up first, then the row is removed from it.',
      adoptDone: 'Adopted {count} server(s). Source backup: {backup}',
      adoptTag: 'Adoptable',
      restart: 'Restart',
      restarted: 'Restarted "{name}"; reconnecting…',
      readFileFound: 'Parsed {count} server(s) from {path} ({format})',
      importScan: 'Scan known locations',
      importScanned: 'Found {count} config files',
      importNoScan: 'No known MCP config files found',
      importServers: '{count} servers',
      importUnreadable: 'unreadable',
      importPlaceholder: 'Paste MCP config here…',
      importFormat: 'Format',
      importAuto: 'Auto detect',
      importPreview: 'Preview',
      importParse: 'Parse',
      importConfirm: 'Import',
      importNothing: 'No servers to import.',
      importMasked: '{count} secret values were replaced by placeholders; fill them in after importing.',
      imported: 'Imported {count} servers.',
      importWarnings: 'Notes',
      importReloadWarning: 'The config file is not mounted yet; restart DSH to apply.',
      filePlaceholder: 'Absolute path, e.g. ~/.codex/config.toml',
      readFile: 'Read',
      dataFile: 'Config file',
      notMounted: 'not mounted to Loader yet',
      unmountHint: 'The MCP Hub config file is not mounted to the Loader yet; restart DSH to apply imports.',
      mountsTitle: 'Mount status',
    }

    // -----------------------------------------------------------------------
    // 样式（仅使用主题 token）
    // -----------------------------------------------------------------------

    const CSS = `
.mcp-hub{max-width:760px;width:100%;display:flex;flex-direction:column;gap:16px;
  color:var(--dsw-alias-label-primary);font:13px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}

/* 顶部：标题 + 统计 */
.mcp-hub-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.mcp-hub-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:7px}
.mcp-hub-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.mcp-hub-spacer{flex:1}

/* 统计条：一行小圆点 + 数字，替代原来的大卡片 */
.mcp-hub-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;
  color:var(--dsw-alias-label-secondary);padding:9px 12px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2)}
.mcp-hub-stat{display:inline-flex;align-items:center;gap:6px}
.mcp-hub-dot{width:7px;height:7px;border-radius:50%;flex:none}
.mcp-hub-dot-ok{background:var(--dsw-alias-state-success-primary)}
.mcp-hub-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.mcp-hub-dot-bad{background:var(--dsw-alias-state-error-primary)}
.mcp-hub-dot-idle{background:var(--dsw-alias-state-idle-primary)}

/* 工具条 */
.mcp-hub-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mcp-hub-btn{appearance:none;font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:7px;padding:4px 10px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.mcp-hub-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.mcp-hub-btn:disabled{opacity:.4;cursor:default}
.mcp-hub-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.mcp-hub-btn-danger{color:var(--dsw-alias-state-error-primary)}
.mcp-hub-btn-ghost{border-color:transparent;background:transparent;padding:3px 6px}
.mcp-hub-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}

/* 服务器列表：带分隔线的紧凑行，点标题展开详情 */
.mcp-hub-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.mcp-hub-srv{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1)}
.mcp-hub-srv:first-child{border-top:none}
.mcp-hub-srv-main{display:flex;align-items:center;gap:10px;padding:9px 12px}
.mcp-hub-srv-main:hover{background:var(--dsw-alias-bg-layer-2)}
.mcp-hub-caret{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;padding:0;width:16px;height:16px;display:inline-flex;align-items:center;
  justify-content:center;transition:transform .15s;flex:none}
.mcp-hub-caret-open{transform:rotate(90deg)}
.mcp-hub-srv-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;max-width:220px}
.mcp-hub-srv-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;
  font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;flex:1;min-width:0}
.mcp-hub-srv-actions{display:flex;align-items:center;gap:4px;flex:none}

/* 展开后的详情区 */
.mcp-hub-detail{padding:0 12px 12px 38px;display:flex;flex-direction:column;gap:8px}
.mcp-hub-kv{display:grid;grid-template-columns:64px 1fr;gap:4px 10px;font-size:12px}
.mcp-hub-kv-key{color:var(--dsw-alias-label-secondary)}
.mcp-hub-kv-val{font-family:ui-monospace,Consolas,monospace;word-break:break-all;
  color:var(--dsw-alias-label-primary)}
.mcp-hub-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}

/* 状态标记：小尺寸文字，不用胶囊 */
.mcp-hub-tag{font-size:11px;padding:0 6px;line-height:17px;border-radius:5px;white-space:nowrap;
  display:inline-flex;align-items:center;gap:4px}
.mcp-hub-tag-ok{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}
.mcp-hub-tag-warn{color:var(--dsw-alias-state-warn-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent)}
.mcp-hub-tag-bad{color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent)}
.mcp-hub-tag-off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}

/* 表单 */
.mcp-hub-form{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}
.mcp-hub-form-title{font-size:13px;font-weight:600}
.mcp-hub-field{display:flex;flex-direction:column;gap:4px}
.mcp-hub-row{display:flex;gap:8px;align-items:center}
.mcp-hub-row>.mcp-hub-field{flex:1}
.mcp-hub-row>.mcp-hub-input{flex:1;min-width:0}
.mcp-hub-row>.mcp-hub-btn{flex:none;white-space:nowrap}
.mcp-hub-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mcp-hub-input,.mcp-hub-select,.mcp-hub-textarea{font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  width:100%;box-sizing:border-box}
.mcp-hub-textarea{font-family:ui-monospace,Consolas,monospace;resize:vertical}
.mcp-hub-input:focus-visible,.mcp-hub-select:focus-visible,.mcp-hub-textarea:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.mcp-hub-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.mcp-hub-hint{margin:0;font-size:11.5px;color:var(--dsw-alias-state-error-primary)}
.mcp-hub-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}

/* 提示条 */
.mcp-hub-error,.mcp-hub-ok,.mcp-hub-warn{font-size:12px;padding:8px 11px;border-radius:8px}
.mcp-hub-error{color:var(--dsw-alias-state-error-primary);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.mcp-hub-ok{color:var(--dsw-alias-state-success-primary);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.mcp-hub-warn{color:var(--dsw-alias-state-warn-primary);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent)}
.mcp-hub-probe{font-size:12px;word-break:break-word}
.mcp-hub-probe-ok{color:var(--dsw-alias-state-success-primary)}
.mcp-hub-probe-bad{color:var(--dsw-alias-state-error-primary)}

/* 空态 */
.mcp-hub-empty{padding:36px 16px;display:flex;flex-direction:column;align-items:center;gap:8px;
  color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.mcp-hub-empty-title{font-size:13px;color:var(--dsw-alias-label-primary)}

/* 导入：可选清单 */
.mcp-hub-picks{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;max-height:320px;overflow-y:auto;background:var(--dsw-alias-bg-base)}
.mcp-hub-pick{display:flex;align-items:center;gap:9px;padding:7px 11px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;cursor:pointer}
.mcp-hub-pick:first-child{border-top:none}
.mcp-hub-pick:hover{background:var(--dsw-alias-bg-layer-2)}
.mcp-hub-pick-off{opacity:.5}
.mcp-hub-check{width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.mcp-hub-pick-name{font-weight:600}
.mcp-hub-pick-arrow{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace}
.mcp-hub-scan{display:flex;flex-direction:column;gap:2px}
.mcp-hub-scan-row{display:flex;align-items:center;gap:9px;font-size:12px;padding:5px 0}
.mcp-hub-spin{display:inline-block;width:11px;height:11px;border-radius:50%;
  border:2px solid var(--dsw-alias-label-secondary);border-top-color:transparent;
  animation:mcp-hub-spin .8s linear infinite}
@keyframes mcp-hub-spin{to{transform:rotate(360deg)}}
`

    // -----------------------------------------------------------------------
    // RPC
    // -----------------------------------------------------------------------

    function getRpc(ctx) {
      const connection = ctx.get('connection')
      if (connection === undefined || connection === null) {
        throw new Error('connection service unavailable')
      }
      return connection.rpc
    }

    class HubError extends Error {
      constructor(error) {
        super(`${error.code}: ${error.message}`)
        this.name = 'HubError'
        this.code = error.code
        this.fields = error.details && error.details.fields ? error.details.fields : undefined
      }
    }

    async function call(ctx, endpoint, payload) {
      const raw = await getRpc(ctx).call(RPC_CHANNEL, endpoint, payload === undefined ? null : payload)
      if (raw && raw.ok === true) return raw.value
      throw new HubError(raw && raw.error ? raw.error : { code: 'unknown', message: 'no result' })
    }

    // -----------------------------------------------------------------------
    // 表单工具
    // -----------------------------------------------------------------------

    function splitLines(text) {
      return String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }

    function stripQuotes(value) {
      const trimmed = value.trim()
      if (trimmed.length >= 2) {
        const first = trimmed[0]
        const last = trimmed[trimmed.length - 1]
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          return trimmed.slice(1, -1)
        }
      }
      return trimmed
    }

    function parsePairs(text) {
      const lines = splitLines(text)
      if (lines.length === 0) return undefined
      const out = {}
      for (const line of lines) {
        const eq = line.indexOf('=')
        const colon = line.indexOf(':')
        const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon)
        if (sep <= 0) continue
        out[stripQuotes(line.slice(0, sep))] = stripQuotes(line.slice(sep + 1))
      }
      return out
    }

    function pairsToText(record) {
      if (record === undefined || record === null) return ''
      return Object.entries(record)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    }

    function headersToText(record) {
      if (record === undefined || record === null) return ''
      return Object.entries(record)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')
    }

    function translate(t, key, params) {
      return t(key, params)
    }

    function describeError(error, t) {
      if (error instanceof HubError) {
        switch (error.code) {
          case 'duplicate-id':
            return t('errDuplicateId')
          case 'duplicate-server-name':
            return t('errDuplicateName')
          case 'invalid-config':
            return t('errInvalid')
          case 'not-managed':
            return t('errNotManaged')
          default:
            return t('errUnknown', { message: error.message.replace(/^[a-z-]+: /, '') })
        }
      }
      const raw = error instanceof Error ? error.message : String(error)
      // Host 半未注册时 RPC 通道不存在，服务端会对 POST 回 405。
      // 这几乎总是「插件刚装好/刚更新，但 Host 半还没加载」，直接说清楚怎么修。
      if (/\b405\b/.test(raw)) return t('errHostNotLoaded')
      return t('errUnknown', { message: raw })
    }

    // -----------------------------------------------------------------------
    // 图标
    // -----------------------------------------------------------------------

    function icon(children, size) {
      return h(
        'svg',
        {
          width: size || 14,
          height: size || 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        children
      )
    }

    const ServerIcon = (props) =>
      icon(
        [
          h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 7, rx: 2 }),
          h('rect', { key: 'b', x: 3, y: 13, width: 18, height: 7, rx: 2 }),
          h('path', { key: 'c', d: 'M7 7.5h.01M7 16.5h.01' }),
        ],
        props && props.size
      )

    const PowerIcon = (props) => icon(h('path', { d: 'M12 3v9M7.5 6.2a7.5 7.5 0 1 0 9 0' }), props && props.size)
    const PlugIcon = (props) => icon(h('path', { d: 'M12 21v-4M8 7V3M16 7V3M6 7h12v3a6 6 0 0 1-12 0z' }), props && props.size)
    const EditIcon = (props) => icon(h('path', { d: 'M17 3.5 20.5 7 8 19.5 3.5 20.5 4.5 16z' }), props && props.size)
    const TrashIcon = (props) => icon(h('path', { d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' }), props && props.size)
    const PlusIcon = (props) => icon(h('path', { d: 'M12 5v14M5 12h14' }), props && props.size)
    const ImportIcon = (props) => icon(h('path', { d: 'M12 3v12m0 0 4-4m-4 4-4-4M4 19h16' }), props && props.size)
    const RefreshIcon = (props) => icon(h('path', { d: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5' }), props && props.size)

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------

    /**
     * 条目是否「已启用但没连上」——也就是需要「重启」按钮来救的场景。
     *
     * 为什么不能只看 `fiberPhase === 'failed'`：`dsh-mcp-client` 连接失败时
     * **不会**让 fiber 进入 failed（它的 apply 正常返回，把连接留给后台重试），
     * 所以 fiberPhase 往往仍是 'active'。真实可观察的信号是**一个工具都没注册**
     * ——工具是服务器连上并 tools/list 成功后才会出现的。
     * 因此把「已启用 + fiber 未 failed + 无工具」一律视为没连上。
     */
    function isDisconnected(server) {
      if (!server.enabled) return false
      if (server.fiberPhase === 'failed') return true
      if (server.fiberPhase !== 'active') return false
      return !(server.toolCount > 0)
    }

    function statusOf(server, t) {
      if (!server.enabled) return { tone: 'off', text: t('statusDisabled') }
      switch (server.fiberPhase) {
        case 'active':
          return server.toolCount > 0
            ? { tone: 'ok', text: t('statusConnected', { count: String(server.toolCount) }) }
            : // 已启用却没有任何工具：通常是连不上（端口错、被控端没开、
              // 刚失败重试中）。这类状态不该看着像「正常」，否则用户会以为没事。
              { tone: 'bad', text: t('statusFailed') }
        case 'failed':
          return { tone: 'bad', text: t('statusFailed') }
        case 'loading':
          return { tone: 'warn', text: t('statusLoading') }
        case 'pending':
          return { tone: 'warn', text: t('statusPending') }
        case 'unloading':
          return { tone: 'warn', text: t('statusUnloading') }
        default:
          return { tone: 'off', text: t('statusUnknown') }
      }
    }

    function targetOf(server) {
      if (server.transport === 'stdio') {
        return [server.command].concat(server.args || []).filter(Boolean).join(' ')
      }
      return server.url || ''
    }

    // -----------------------------------------------------------------------
    // 服务器行（默认一行，点标题展开详情）
    // -----------------------------------------------------------------------

    const ChevronIcon = (props) =>
      icon(h('path', { d: 'M9 6l6 6-6 6' }), props && props.size)

    /** 详情里的一行「键 → 值」。 */
    function KV(props) {
      return h(
        'div',
        { className: 'mcp-hub-kv' },
        h('span', { className: 'mcp-hub-kv-key' }, props.label),
        h('span', { className: 'mcp-hub-kv-val' }, props.children)
      )
    }

    function ServerRow(props) {
      const { server, t, busy, actionsDisabled, probe, open, onToggleOpen, onToggle, onTest, onEdit, onRemove, onAdopt, onRestart } = props
      const status = statusOf(server, t)
      const target = targetOf(server)

      return h(
        'div',
        { className: 'mcp-hub-srv' },
        h(
          'div',
          { className: 'mcp-hub-srv-main' },
          h(
            'button',
            {
              type: 'button',
              className: `mcp-hub-caret${open ? ' mcp-hub-caret-open' : ''}`,
              title: open ? t('collapse') : t('expand'),
              onClick: () => onToggleOpen(server.id),
            },
            h(ChevronIcon, { size: 14 })
          ),
          h('span', { className: `mcp-hub-tag mcp-hub-tag-${status.tone}` }, status.text),
          h('span', { className: 'mcp-hub-srv-name' }, server.serverName || '—'),
          h('span', { className: 'mcp-hub-srv-sub' }, target || server.transport),
          h(
            'span',
            { className: 'mcp-hub-srv-actions' },
            server.needsSecret ? h('span', { className: 'mcp-hub-tag mcp-hub-tag-warn' }, t('secretTag')) : null,
            !server.managed ? h('span', { className: 'mcp-hub-tag mcp-hub-tag-off' }, t('externalTag')) : null
          )
        ),
        open
          ? h(
              'div',
              { className: 'mcp-hub-detail' },
              h(KV, { label: t('fieldId') }, server.id),
              h(KV, { label: t('fieldTransport') }, server.transport),
              h(KV, { label: t('detailTarget') }, target || '—'),
              server.pending ? h(KV, { label: t('detailState') }, t('pendingTag')) : null,
              !server.managed
                ? h('div', { className: 'mcp-hub-note' }, t('externalWriteHint'))
                : null,
              probe !== undefined
                ? h(
                    'div',
                    { className: `mcp-hub-probe ${probe.ok ? 'mcp-hub-probe-ok' : 'mcp-hub-probe-bad'}` },
                    probe.ok
                      ? t('probeOk', { count: String(probe.toolCount || 0), ms: String(probe.latencyMs) })
                      : t('probeFail', { error: probe.error || 'error', ms: String(probe.latencyMs) })
                  )
                : null,
              h(
                'div',
                { className: 'mcp-hub-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mcp-hub-btn',
                    disabled: actionsDisabled || !server.managed,
                    onClick: () => onToggle(server),
                  },
                  h(PowerIcon, { size: 12 }),
                  server.enabled ? t('disable') : t('enable')
                ),
                h(
                  'button',
                  { type: 'button', className: 'mcp-hub-btn', disabled: actionsDisabled, onClick: () => onTest(server) },
                  busy === `probe:${server.id}` ? h('span', { className: 'mcp-hub-spin' }) : h(PlugIcon, { size: 12 }),
                  t('test')
                ),
                // 重启：停用再启用，逼 Loader 重建 fiber。
                // 对「配置正确但没连上」（被控端重启过、端口变了、接管后未挂载）这种情况，
                // 这是唯一不用重启整个 dsh 的补救手段。只在确实没连上时才显示，
                // 免得给正常运行的条目增加噪音。
                server.managed && isDisconnected(server)
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'mcp-hub-btn mcp-hub-btn-primary',
                        disabled: actionsDisabled,
                        onClick: () => onRestart(server),
                      },
                      busy === `restart:${server.id}` ? h('span', { className: 'mcp-hub-spin' }) : h(RefreshIcon, { size: 12 }),
                      t('restart')
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mcp-hub-btn',
                    disabled: actionsDisabled || !server.managed,
                    onClick: () => onEdit(server),
                  },
                  h(EditIcon, { size: 12 }),
                  t('edit')
                ),
                // 外部条目提供「接管」：搬进本插件的配置文件并备份来源文件。
                !server.managed
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'mcp-hub-btn',
                        disabled: actionsDisabled,
                        onClick: () => onAdopt(server),
                      },
                      h(ImportIcon, { size: 12 }),
                      t('adopt')
                    )
                  : null,
                h('span', { className: 'mcp-hub-spacer' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mcp-hub-btn mcp-hub-btn-danger',
                    disabled: actionsDisabled || !server.managed,
                    onClick: () => onRemove(server),
                  },
                  h(TrashIcon, { size: 12 }),
                  t('remove')
                )
              )
            )
          : null
      )
    }

    // -----------------------------------------------------------------------
    // 编辑表单
    // -----------------------------------------------------------------------

    const EMPTY_FORM = {
      id: '',
      serverName: '',
      transport: 'streamable-http',
      url: '',
      command: '',
      argsText: '',
      envText: '',
      cwd: '',
      headersText: '',
      timeoutMs: '',
    }

    function toForm(server) {
      if (server === undefined) return Object.assign({}, EMPTY_FORM)
      return {
        id: server.id,
        serverName: server.serverName || '',
        transport: server.transport || 'streamable-http',
        url: server.url || '',
        command: server.command || '',
        argsText: (server.args || []).join('\n'),
        envText: pairsToText(server.env),
        cwd: server.cwd || '',
        headersText: headersToText(server.headers),
        timeoutMs: server.toolCallTimeoutMs === undefined ? '' : String(server.toolCallTimeoutMs),
      }
    }

    function toConfig(form) {
      const config = { serverName: form.serverName.trim(), transport: form.transport }
      if (form.transport === 'stdio') {
        config.command = form.command.trim()
        const args = splitLines(form.argsText)
        if (args.length > 0) config.args = args
        const env = parsePairs(form.envText)
        if (env !== undefined && Object.keys(env).length > 0) config.env = env
        if (form.cwd.trim() !== '') config.cwd = form.cwd.trim()
      } else {
        config.url = form.url.trim()
        const headers = parsePairs(form.headersText)
        if (headers !== undefined && Object.keys(headers).length > 0) config.headers = headers
      }
      if (form.timeoutMs.trim() !== '' && /^\d+$/.test(form.timeoutMs.trim())) {
        config.toolCallTimeoutMs = Number(form.timeoutMs.trim())
      }
      return config
    }

    function ServerForm(props) {
      const { ctx, t, initial, busy, onCancel, onSaved } = props
      const editing = initial !== undefined
      const [form, setForm] = useState(() => toForm(initial))
      const [fieldErrors, setFieldErrors] = useState({})
      const [submitError, setSubmitError] = useState(null)
      const [saving, setSaving] = useState(false)

      const set = (key, value) => setForm((prev) => Object.assign({}, prev, { [key]: value }))

      const validate = () => {
        const errors = {}
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(form.id.trim())) errors.id = t('errId')
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(form.serverName.trim())) errors.serverName = t('errName')
        if (form.transport === 'streamable-http' && !/^https?:\/\/.+/.test(form.url.trim())) {
          errors.url = t('errUrl')
        }
        if (form.transport === 'stdio' && form.command.trim() === '') errors.command = t('errCommand')
        return errors
      }

      const submit = async () => {
        const errors = validate()
        setFieldErrors(errors)
        if (Object.keys(errors).length > 0) return
        setSaving(true)
        setSubmitError(null)
        try {
          const payload = { id: form.id.trim(), config: toConfig(form) }
          if (editing) await call(ctx, 'update', payload)
          else await call(ctx, 'add', payload)
          onSaved()
        } catch (error) {
          if (error instanceof HubError && error.fields !== undefined) setFieldErrors(error.fields)
          setSubmitError(describeError(error, t))
        } finally {
          setSaving(false)
        }
      }

      const inputClass = (key) => `mcp-hub-input${fieldErrors[key] !== undefined ? ' mcp-hub-input-invalid' : ''}`
      const errorBelow = (key) => (fieldErrors[key] !== undefined ? h('p', { className: 'mcp-hub-hint' }, fieldErrors[key]) : null)

      return h(
        'div',
        { className: 'mcp-hub-form' },
        h('div', { className: 'mcp-hub-form-title' }, editing ? t('formEdit', { name: initial.serverName }) : t('formAdd')),
        h(
          'div',
          { className: 'mcp-hub-row' },
          h(
            'div',
            { className: 'mcp-hub-field' },
            h('label', { className: 'mcp-hub-label' }, t('fieldId')),
            h('input', {
              className: inputClass('id'),
              value: form.id,
              spellCheck: false,
              disabled: editing || saving || busy,
              placeholder: 'mcp-idea',
              onChange: (event) => set('id', event.target.value),
            }),
            errorBelow('id')
          ),
          h(
            'div',
            { className: 'mcp-hub-field' },
            h('label', { className: 'mcp-hub-label' }, t('fieldName')),
            h('input', {
              className: inputClass('serverName'),
              value: form.serverName,
              spellCheck: false,
              disabled: saving || busy,
              placeholder: 'idea',
              onChange: (event) => set('serverName', event.target.value),
            }),
            errorBelow('serverName')
          )
        ),
        h(
          'div',
          { className: 'mcp-hub-field' },
          h('label', { className: 'mcp-hub-label' }, t('fieldTransport')),
          h(
            'select',
            {
              className: 'mcp-hub-select',
              value: form.transport,
              disabled: saving || busy,
              onChange: (event) => set('transport', event.target.value),
            },
            h('option', { value: 'streamable-http' }, 'streamable-http'),
            h('option', { value: 'stdio' }, 'stdio')
          )
        ),
        form.transport === 'streamable-http'
          ? h(
              'div',
              { className: 'mcp-hub-field' },
              h('label', { className: 'mcp-hub-label' }, t('fieldUrl')),
              h('input', {
                className: inputClass('url'),
                value: form.url,
                spellCheck: false,
                disabled: saving || busy,
                placeholder: 'http://127.0.0.1:64342/stream',
                onChange: (event) => set('url', event.target.value),
              }),
              errorBelow('url')
            )
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'mcp-hub-field' },
                h('label', { className: 'mcp-hub-label' }, t('fieldCommand')),
                h('input', {
                  className: inputClass('command'),
                  value: form.command,
                  spellCheck: false,
                  disabled: saving || busy,
                  placeholder: 'npx',
                  onChange: (event) => set('command', event.target.value),
                }),
                errorBelow('command')
              ),
              h(
                'div',
                { className: 'mcp-hub-field' },
                h('label', { className: 'mcp-hub-label' }, t('fieldArgs')),
                h('textarea', {
                  className: 'mcp-hub-textarea',
                  rows: 3,
                  value: form.argsText,
                  spellCheck: false,
                  disabled: saving || busy,
                  onChange: (event) => set('argsText', event.target.value),
                })
              ),
              h(
                'div',
                { className: 'mcp-hub-field' },
                h('label', { className: 'mcp-hub-label' }, t('fieldEnv')),
                h('textarea', {
                  className: 'mcp-hub-textarea',
                  rows: 4,
                  value: form.envText,
                  spellCheck: false,
                  disabled: saving || busy,
                  onChange: (event) => set('envText', event.target.value),
                })
              ),
              h(
                'div',
                { className: 'mcp-hub-field' },
                h('label', { className: 'mcp-hub-label' }, t('fieldCwd')),
                h('input', {
                  className: 'mcp-hub-input',
                  value: form.cwd,
                  spellCheck: false,
                  disabled: saving || busy,
                  onChange: (event) => set('cwd', event.target.value),
                })
              )
            ),
        form.transport === 'streamable-http'
          ? h(
              'div',
              { className: 'mcp-hub-field' },
              h('label', { className: 'mcp-hub-label' }, t('fieldHeaders')),
              h('textarea', {
                className: 'mcp-hub-textarea',
                rows: 2,
                value: form.headersText,
                spellCheck: false,
                disabled: saving || busy,
                onChange: (event) => set('headersText', event.target.value),
              })
            )
          : null,
        h(
          'div',
          { className: 'mcp-hub-field' },
          h('label', { className: 'mcp-hub-label' }, t('fieldTimeout')),
          h('input', {
            className: 'mcp-hub-input',
            value: form.timeoutMs,
            inputMode: 'numeric',
            placeholder: '60000',
            disabled: saving || busy,
            onChange: (event) => set('timeoutMs', event.target.value.replace(/[^0-9]/g, '')),
          })
        ),
        submitError !== null ? h('div', { className: 'mcp-hub-error' }, submitError) : null,
        h(
          'div',
          { className: 'mcp-hub-actions' },
          h('span', { className: 'mcp-hub-spacer' }),
          h('button', { type: 'button', className: 'mcp-hub-btn', disabled: saving, onClick: onCancel }, t('cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'mcp-hub-btn mcp-hub-btn-primary',
              disabled: saving || busy,
              onClick: () => void submit(),
            },
            saving ? h('span', { className: 'mcp-hub-spin' }) : null,
            t('save')
          )
        )
      )
    }

    // -----------------------------------------------------------------------
    // 导入勾选辅助
    // -----------------------------------------------------------------------

    /**
     * 某条是否被勾中。
     *
     * 默认值：**没有与已有服务器重名的默认勾选**；重名的（`sourceName` 与
     * 最终 `serverName` 不同，说明被自动改名了）默认不勾 —— 用户看到 idea 已经
     * 有了，就不该在不知情的情况下多导一台 idea-2 进来。
     */
    function isPicked(picked, preview, item) {
      const explicit = picked[item.sourceName]
      if (explicit !== undefined) return explicit
      return item.sourceName === item.config.serverName
    }

    /** 把「当前实际生效的勾选状态」固化成显式 map，避免默认值在切换时跳变。 */
    function pickedState(picked, preview) {
      const next = {}
      for (const item of preview.imported) next[item.sourceName] = isPicked(picked, preview, item)
      return next
    }

    function pickAll(preview, value) {
      const next = {}
      for (const item of preview.imported) next[item.sourceName] = value
      return next
    }

    function pickedCount(picked, preview) {
      return preview.imported.filter((item) => isPicked(picked, preview, item)).length
    }

    // -----------------------------------------------------------------------
    // 导入对话框
    // -----------------------------------------------------------------------

    function ImportPanel(props) {
      const { ctx, t, busy, onClose, onImported } = props
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [scan, setScan] = useState(null)
      const [filePath, setFilePath] = useState('')
      const [working, setWorking] = useState(false)
      const [result, setResult] = useState(null)
      // 从文件读取时，预览直接来自 Host（只含解析出的服务器，不含文件原文）。
      const [fromFile, setFromFile] = useState(null)
      // 勾选状态：默认勾选未与已有重名的条目；冲突的默认不勾，避免误导入重复项。
      const [picked, setPicked] = useState({})

      const parse = useCallback(async () => {
        setError(null)
        setResult(null)
        setFromFile(null)
        setPicked({})
        setWorking(true)
        try {
          const parsed = await call(ctx, 'import', { text, format: 'auto', maskSecrets: true, dryRun: true })
          setPreview(parsed)
          if (parsed.imported.length === 0) setError(t('importNothing'))
        } catch (err) {
          setPreview(null)
          setError(describeError(err, t))
        } finally {
          setWorking(false)
        }
      }, [ctx, text, t])

      // 读取文件：Host 就地解析，只回传「找到了哪几台服务器」。
      // 不再把文件原文倒进文本框 —— 那些文件多数内容与 MCP 无关，且可能含密钥。
      const readPath = useCallback(
        async (path) => {
          setError(null)
          setResult(null)
          setPreview(null)
          setPicked({})
          setWorking(true)
          try {
            const parsed = await call(ctx, 'import', { path, format: 'auto', maskSecrets: true, dryRun: true })
            setFilePath(parsed.path ?? path)
            setPreview(parsed)
            setFromFile(parsed)
            if (parsed.imported.length === 0) setError(t('importNothing'))
          } catch (err) {
            setPreview(null)
            setFromFile(null)
            setError(describeError(err, t))
          } finally {
            setWorking(false)
          }
        },
        [ctx, t]
      )

      const readFile = useCallback(() => readPath(filePath), [readPath, filePath])

      const doScan = useCallback(async () => {
        setError(null)
        setWorking(true)
        try {
          const found = await call(ctx, 'scan', {})
          setScan(found.candidates)
          if (found.candidates.length === 0) setError(t('importNoScan'))
        } catch (err) {
          setError(describeError(err, t))
        } finally {
          setWorking(false)
        }
      }, [ctx, t])

      return h(
        'div',
        { className: 'mcp-hub-form' },
        h('div', { className: 'mcp-hub-form-title' }, t('importTitle')),
        h(
          'div',
          { className: 'mcp-hub-toolbar' },
          h('button', { type: 'button', className: 'mcp-hub-btn', disabled: working || busy, onClick: () => void doScan() }, t('importScan')),
          null
        ),
        scan !== null
          ? h(
              'div',
              { className: 'mcp-hub-scan' },
              h('div', { className: 'mcp-hub-note' }, t('importScanned', { count: String(scan.length) })),
              scan.map((candidate) =>
                h(
                  'div',
                  { className: 'mcp-hub-scan-row', key: candidate.path },
                  h('span', null, candidate.label),
                  h(
                    'span',
                    { className: 'mcp-hub-id' },
                    candidate.serverCount >= 0 ? t('importServers', { count: String(candidate.serverCount) }) : t('importUnreadable')
                  ),
                  h('span', { className: 'mcp-hub-spacer' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'mcp-hub-btn',
                      disabled: working || busy || candidate.serverCount <= 0,
                      onClick: () => void readPath(candidate.path),
                    },
                    t('readFile')
                  )
                )
              )
            )
          : null,
        h(
          'div',
          { className: 'mcp-hub-field' },
          h('label', { className: 'mcp-hub-label' }, t('importFromFile')),
          h(
            'div',
            { className: 'mcp-hub-row' },
            h('input', {
              className: 'mcp-hub-input',
              value: filePath,
              spellCheck: false,
              placeholder: t('filePlaceholder'),
              onChange: (event) => setFilePath(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && filePath.trim() !== '') void readFile()
              },
            }),
            h(
              'button',
              { type: 'button', className: 'mcp-hub-btn', disabled: working || busy || filePath.trim() === '', onClick: () => void readFile() },
              t('readFile')
            )
          ),
          h('div', { className: 'mcp-hub-note' }, t('readFileHint'))
        ),
        h(
          'div',
          { className: 'mcp-hub-field' },
          h('label', { className: 'mcp-hub-label' }, t('importPaste')),
          h('div', { className: 'mcp-hub-note' }, t('importPasteHint')),
          h('textarea', {
            className: 'mcp-hub-textarea',
            rows: 8,
            value: text,
            spellCheck: false,
            placeholder: t('importPlaceholder'),
            onChange: (event) => {
              setText(event.target.value)
              setPreview(null)
              setFromFile(null)
            },
          })
        ),
        result !== null && result.imported.length > 0
          ? h('div', { className: 'mcp-hub-ok' }, t('imported', { count: String(result.imported.length) }))
          : null,
        error !== null ? h('div', { className: 'mcp-hub-error' }, error) : null,
        fromFile !== null && preview !== null && preview.imported.length > 0
          ? h(
              'div',
              { className: 'mcp-hub-note' },
              t('readFileFound', {
                path: fromFile.path,
                count: String(preview.imported.length),
                format: String(preview.format ?? ''),
              })
            )
          : null,
        preview !== null && preview.imported.length > 0
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'mcp-hub-actions' },
                h('span', { className: 'mcp-hub-label' }, t('importPreview')),
                h('span', { className: 'mcp-hub-spacer' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mcp-hub-btn mcp-hub-btn-ghost',
                    onClick: () => setPicked(pickAll(preview, true)),
                  },
                  t('selectAll')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mcp-hub-btn mcp-hub-btn-ghost',
                    onClick: () => setPicked(pickAll(preview, false)),
                  },
                  t('selectNone')
                )
              ),
              h(
                'div',
                { className: 'mcp-hub-picks' },
                preview.imported.map((item) =>
                  h(
                    'label',
                    {
                      // 用 sourceName 作为勾选键：它与 ServerForm 的 id 无关，
                      // 且能唯一定位解析出来的这一条。
                      key: item.sourceName,
                      className: `mcp-hub-pick${isPicked(picked, preview, item) ? '' : ' mcp-hub-pick-off'}`,
                    },
                    h('input', {
                      type: 'checkbox',
                      className: 'mcp-hub-check',
                      checked: isPicked(picked, preview, item),
                      onChange: (event) =>
                        setPicked((prev) => Object.assign({}, pickedState(prev, preview), { [item.sourceName]: event.target.checked })),
                    }),
                    h('span', { className: `mcp-hub-tag mcp-hub-tag-off` }, item.config.transport),
                    h('span', { className: 'mcp-hub-pick-name' }, item.config.serverName),
                    item.config.serverName !== item.sourceName
                      ? h(
                          'span',
                          { className: 'mcp-hub-pick-arrow' },
                          `${item.sourceName} → ${item.config.serverName}`
                        )
                      : null,
                    h('span', { className: 'mcp-hub-spacer' }),
                    item.pendingSecrets > 0
                      ? h('span', { className: 'mcp-hub-tag mcp-hub-tag-warn' }, t('secretTag'))
                      : null,
                    h('span', { className: 'mcp-hub-note' }, item.id)
                  )
                )
              ),
              h(
                'div',
                { className: 'mcp-hub-note' },
                t('importPickHint', { n: String(pickedCount(picked, preview)) })
              )
            )
          : null,
        preview !== null && preview.warnings !== undefined && preview.warnings.length > 0
          ? h(
              'div',
              { className: 'mcp-hub-warn' },
              t('importWarnings') + '：' + preview.warnings.slice(0, 5).join('；')
            )
          : null,
        preview !== null && preview.imported.some((item) => item.pendingSecrets > 0)
          ? h(
              'div',
              { className: 'mcp-hub-warn' },
              t('importMasked', {
                count: String(preview.imported.reduce((sum, item) => sum + item.pendingSecrets, 0)),
              })
            )
          : null,
        preview !== null && preview.reloadWarning !== undefined
          ? h('div', { className: 'mcp-hub-warn' }, t('importReloadWarning'))
          : null,
        h(
          'div',
          { className: 'mcp-hub-actions' },
          h('span', { className: 'mcp-hub-spacer' }),
          h('button', { type: 'button', className: 'mcp-hub-btn', disabled: working, onClick: onClose }, t('cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'mcp-hub-btn mcp-hub-btn-primary',
              disabled: working || busy,
              onClick: () => {
                void (async () => {
                  setWorking(true)
                  setError(null)
                  try {
                    // 只导入被勾中的条目：把勾选后的 sourceName 列表交给 Host。
                    const chosen = preview === null ? [] : preview.imported.filter((item) => isPicked(picked, preview, item)).map((item) => item.sourceName)
                    const only = { only: chosen }
                    // 预览来自文件时按路径导入（Host 重新读一遍，避免依赖界面上的字符串）。
                    const payload =
                      fromFile !== null && text === ''
                        ? { path: fromFile.path, format: 'auto', maskSecrets: true, ...only }
                        : { text, format: 'auto', maskSecrets: true, ...only }
                    const imported = await call(ctx, 'import', payload)
                    setResult(imported)
                    setPreview(imported)
                    onImported(imported)
                  } catch (err) {
                    setError(describeError(err, t))
                  } finally {
                    setWorking(false)
                  }
                })()
              },
            },
            t('importConfirm')
          )
        )
      )
    }

    // -----------------------------------------------------------------------
    // 主面板
    // -----------------------------------------------------------------------

    function McpHubSection(props) {
      const ctx = props.ctx
      const t = ctx.locale.bind(NS)
      const [, bump] = React.useReducer((value) => value + 1, 0)

      useEffect(() => ctx.locale.subscribe(bump), [ctx])

      const [state, setState] = useState({ servers: [], info: null })
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [adding, setAdding] = useState(false)
      const [editingId, setEditingId] = useState(null)
      const [importing, setImporting] = useState(false)
      const [probes, setProbes] = useState({})
      const [notice, setNotice] = useState(null)
      const [open, setOpen] = useState({})

      const formOpen = adding || editingId !== null

      const refresh = useCallback(async () => {
        setLoading(true)
        try {
          const info = await call(ctx, 'info', {})
          const listed = await call(ctx, 'list', {})
          setState({ servers: listed.servers, info })
          setError(null)
        } catch (err) {
          setError(describeError(err, t))
        } finally {
          setLoading(false)
        }
      }, [ctx, t])

      useEffect(() => {
        void refresh()
      }, [refresh])

      const settled = useCallback(() => {
        void refresh()
        window.setTimeout(() => void refresh(), 900)
        window.setTimeout(() => void refresh(), 2600)
      }, [refresh])

      const run = useCallback(
        async (label, action) => {
          setBusy(label)
          setError(null)
          try {
            const value = await action()
            settled()
            return value
          } catch (err) {
            setError(describeError(err, t))
            return undefined
          } finally {
            setBusy(null)
          }
        },
        [settled, t]
      )

      const servers = state.servers
      const summary = useMemo(
        () => ({
          total: servers.length,
          enabled: servers.filter((server) => server.enabled).length,
          connected: servers.filter((server) => server.enabled && !isDisconnected(server)).length,
          failed: servers.filter((server) => isDisconnected(server)).length,
        }),
        [servers]
      )

      const toggle = (server) =>
        void run(`toggle:${server.id}`, () => call(ctx, 'setEnabled', { id: server.id, enabled: !server.enabled }))
      const remove = (server) => {
        if (!window.confirm(t('removeConfirm', { name: server.serverName, file: state.info ? state.info.dataFile : '' }))) return
        void run(`remove:${server.id}`, () => call(ctx, 'remove', { id: server.id }))
      }
      const test = (server) =>
        void run(`probe:${server.id}`, async () => {
          const probe = await call(ctx, 'probe', { id: server.id })
          setProbes((prev) => Object.assign({}, prev, { [server.id]: probe }))
        })
      const restart = (server) =>
        void run(`restart:${server.id}`, async () => {
          await call(ctx, 'restart', { id: server.id })
          setNotice(t('restarted', { name: server.serverName }))
        })
      const adopt = (server) => {
        if (!window.confirm(t('adoptConfirm', { name: server.serverName }))) return
        void run(`adopt:${server.id}`, async () => {
          const result = await call(ctx, 'adopt', { ids: [server.id] })
          setNotice(t('adoptDone', { count: String(result.adopted.length), backup: (result.backups || []).join('、') }))
        })
      }
      const toggleOpen = (id) =>
        setOpen((prev) => Object.assign({}, prev, { [id]: !prev[id] }))

      const actionsDisabled = busy !== null || formOpen || importing

      return h(
        'div',
        { className: 'mcp-hub' },
        h(
          'div',
          { className: 'mcp-hub-head' },
          h(
            'span',
            { className: 'mcp-hub-title' },
            h(ServerIcon, { size: 15 }),
            t('title')
          ),
          h('span', { className: 'mcp-hub-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'mcp-hub-btn mcp-hub-btn-ghost',
              disabled: actionsDisabled || loading,
              title: t('refresh'),
              onClick: () => void refresh(),
            },
            loading ? h('span', { className: 'mcp-hub-spin' }) : h(RefreshIcon, { size: 13 })
          )
        ),
        h('div', { className: 'mcp-hub-sub' }, t('subtitle')),
        // 统计条：一眼看到全局状态，替代原来散在每张卡片上的重复信息
        h(
          'div',
          { className: 'mcp-hub-stats' },
          h(
            'span',
            { className: 'mcp-hub-stat' },
            h('span', { className: 'mcp-hub-dot mcp-hub-dot-idle' }),
            t('total', { count: String(summary.total) })
          ),
          h(
            'span',
            { className: 'mcp-hub-stat' },
            h('span', { className: 'mcp-hub-dot mcp-hub-dot-ok' }),
            t('connected', { count: String(summary.connected) })
          ),
          summary.enabled > 0
            ? h(
                'span',
                { className: 'mcp-hub-stat' },
                h('span', { className: 'mcp-hub-dot mcp-hub-dot-idle' }),
                t('enabledCount', { count: String(summary.enabled) })
              )
            : null,
          summary.failed > 0
            ? h(
                'span',
                { className: 'mcp-hub-stat' },
                h('span', { className: 'mcp-hub-dot mcp-hub-dot-bad' }),
                t('failed', { count: String(summary.failed) })
              )
            : null
        ),
        h(
          'div',
          { className: 'mcp-hub-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'mcp-hub-btn mcp-hub-btn-primary',
              disabled: actionsDisabled,
              onClick: () => {
                setEditingId(null)
                setAdding(false)
                setImporting(true)
              },
            },
            h(ImportIcon, { size: 12 }),
            t('import')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mcp-hub-btn',
              disabled: actionsDisabled,
              onClick: () => {
                setImporting(false)
                setEditingId(null)
                setAdding(true)
              },
            },
            h(PlusIcon, { size: 12 }),
            t('add')
          )
        ),
        state.info !== null && !state.info.mounted
          ? h('div', { className: 'mcp-hub-warn' }, t('unmountHint'))
          : null,
        error !== null ? h('div', { className: 'mcp-hub-error' }, error) : null,
        notice !== null ? h('div', { className: 'mcp-hub-ok' }, notice) : null,
        importing
          ? h(ImportPanel, {
              ctx,
              t,
              busy: busy !== null,
              onClose: () => setImporting(false),
              onImported: (parsed) => {
                setNotice(t('imported', { count: String((parsed.selected ?? parsed.imported).length) }))
                settled()
              },
            })
          : null,
        adding
          ? h(ServerForm, {
              ctx,
              t,
              initial: undefined,
              busy: busy !== null,
              onCancel: () => setAdding(false),
              onSaved: () => {
                setAdding(false)
                settled()
              },
            })
          : null,
        loading && servers.length === 0 ? h('div', { className: 'mcp-hub-empty' }, t('loading')) : null,
        !loading && servers.length === 0
          ? h(
              'div',
              { className: 'mcp-hub-empty' },
              h('span', { className: 'mcp-hub-empty-title' }, t('empty')),
              h('span', null, t('emptyHint'))
            )
          : null,
        servers.length > 0
          ? h(
              'div',
              { className: 'mcp-hub-list' },
              servers.map((server) =>
                server.id === editingId
                  ? h(ServerForm, {
                      key: server.id,
                      ctx,
                      t,
                      initial: server,
                      busy: busy !== null,
                      onCancel: () => setEditingId(null),
                      onSaved: () => {
                        setEditingId(null)
                        settled()
                      },
                    })
                  : h(ServerRow, {
                      key: server.id,
                      server,
                      t,
                      busy,
                      actionsDisabled,
                      probe: probes[server.id],
                      open: open[server.id] === true,
                      onToggleOpen: toggleOpen,
                      onToggle: toggle,
                      onTest: test,
                      onEdit: (target) => {
                        setAdding(false)
                        setImporting(false)
                        setEditingId(target.id)
                      },
                      onRemove: remove,
                      onAdopt: adopt,
                      onRestart: restart,
                    })
              )
            )
          : null,
        state.info !== null
          ? h('div', { className: 'mcp-hub-note' }, `${t('dataFile')}: ${state.info.dataFile}`)
          : null
      )
    }

    // -----------------------------------------------------------------------
    // 插件入口
    // -----------------------------------------------------------------------

    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'mcp-hub: locale'
      )
      const style = h('style', { key: 'mcp-hub-style' }, CSS)
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => {
        const disposer = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-hub',
            order: 19,
            label: () => t('nav'),
            inject: () => ({ ctx }),
          },
          (props) => h(React.Fragment, null, style, h(McpHubSection, props))
        )
        return disposer
      })
    }

    return { inject, apply }
  },
})
