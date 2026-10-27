window.__ModuleLoader__.load({
  id: '@sldmn233/dsh-profile-share',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    // Theme-safe tokens: surfaces are neutral alpha, accents are translucent
    // tints, and all text inherits currentColor so both shell themes read.
    const BORDER = 'rgba(128,128,128,.35)';
    const SOFT_BORDER = 'rgba(128,128,128,.2)';
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

    const pageStyle = {
      width: '100%',
      maxWidth: 780,
      margin: '0 auto',
      padding: '2px 2px 24px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      minWidth: 0,
      color: 'inherit',
      fontSize: 14,
      lineHeight: 1.5,
    };
    const cardStyle = {
      border: '1px solid ' + BORDER,
      borderRadius: 10,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      background: 'rgba(128,128,128,.06)',
      boxSizing: 'border-box',
      minWidth: 0,
    };
    const mutedStyle = { opacity: 0.68, fontSize: 13 };
    const microStyle = { opacity: 0.6, fontSize: 12 };
    const headingStyle = { margin: 0, fontSize: 14, fontWeight: 600 };
    const subheadingStyle = { margin: '10px 0 0', fontSize: 13, fontWeight: 600 };
    const monoStyle = {
      fontFamily: MONO,
      fontSize: 12.5,
      lineHeight: 1.45,
      background: 'rgba(128,128,128,.12)',
      border: '1px solid ' + SOFT_BORDER,
      borderRadius: 4,
      padding: '0 5px',
      wordBreak: 'break-all',
    };
    const monoPlainStyle = { fontFamily: MONO, fontSize: 12.5, lineHeight: 1.45, wordBreak: 'break-all' };
    const buttonStyle = {
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(128,128,128,.1)',
      border: '1px solid ' + BORDER,
      borderRadius: 6,
      padding: '6px 12px',
      lineHeight: 1.35,
      cursor: 'pointer',
      flex: '0 0 auto',
    };
    const primaryButtonStyle = {
      ...buttonStyle,
      background: 'rgba(64,132,255,.16)',
      borderColor: 'rgba(64,132,255,.55)',
      fontWeight: 600,
    };
    const disabledButtonStyle = { opacity: 0.45, cursor: 'not-allowed' };
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(128,128,128,.06)',
      border: '1px solid ' + BORDER,
      borderRadius: 6,
      padding: '6px 8px',
      minWidth: 0,
    };
    const textareaStyle = {
      width: '100%',
      boxSizing: 'border-box',
      fontFamily: MONO,
      fontSize: 12.5,
      lineHeight: 1.5,
      color: 'inherit',
      background: 'rgba(128,128,128,.06)',
      border: '1px solid ' + BORDER,
      borderRadius: 6,
      padding: 8,
      resize: 'vertical',
      minHeight: 80,
      minWidth: 0,
    };
    const checkboxStyle = {
      flex: '0 0 auto',
      width: 16,
      height: 16,
      margin: 0,
      accentColor: 'rgb(64,132,255)',
      cursor: 'pointer',
    };
    const labelRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      userSelect: 'none',
      minWidth: 0,
    };
    const thStyle = {
      textAlign: 'left',
      padding: '6px 8px',
      borderBottom: '1px solid ' + BORDER,
      fontSize: 12,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      opacity: 0.8,
    };
    const tdStyle = {
      textAlign: 'left',
      padding: '6px 8px',
      borderBottom: '1px solid ' + SOFT_BORDER,
      verticalAlign: 'top',
      wordBreak: 'break-word',
      minWidth: 0,
    };

    const badgeTones = {
      ok: { background: 'rgba(63,185,80,.15)', borderColor: 'rgba(63,185,80,.5)' },
      bad: { background: 'rgba(229,83,75,.15)', borderColor: 'rgba(229,83,75,.5)' },
      info: { background: 'rgba(64,132,255,.15)', borderColor: 'rgba(64,132,255,.5)' },
      neutral: { background: 'rgba(128,128,128,.14)', borderColor: 'rgba(128,128,128,.38)' },
    };
    const alertTones = {
      error: { background: 'rgba(229,83,75,.12)', borderColor: 'rgba(229,83,75,.55)' },
      warning: { background: 'rgba(210,153,34,.12)', borderColor: 'rgba(210,153,34,.55)' },
      success: { background: 'rgba(63,185,80,.12)', borderColor: 'rgba(63,185,80,.55)' },
      info: { background: 'rgba(128,128,128,.08)', borderColor: 'rgba(128,128,128,.4)' },
    };

    const STEP_KIND_LABELS = {
      install: '安装',
      enable: '启用',
      disable: '禁用',
      config: '写入配置',
      skip: '跳过',
    };
    const STEP_STATUS_LABELS = { pending: '待执行', satisfied: '已满足' };
    const APPLY_STATUS_LABELS = { applied: '已应用', skipped: '已跳过', failed: '失败' };
    const REQUIREMENT_KIND_LABELS = { secret: '密钥', env: '环境变量', login: '登录态' };
    const REQUIREMENT_KIND_ORDER = ['secret', 'env', 'login'];

    /* ---------------------------------------------------------------- HTTP */

    function apiBase() {
      const d = globalThis.document;
      if (!d || typeof d.baseURI !== 'string' || d.baseURI === '') return undefined;
      try { const u = new URL(d.baseURI); if (!u.pathname.endsWith('/')) u.pathname += '/'; return u.href; } catch { return undefined; }
    }
    function apiUrl(path) {
      const base = apiBase();
      if (!base) return path;
      try { return new URL(path.slice(1), base).href; } catch { return path; }
    }

    async function readJson(response) {
      try { return await response.json(); }
      catch { return null; } // non-JSON bodies (proxies, HTML error pages) fall through to the status check
    }

    async function requestJson(path, options) {
      const response = await fetch(apiUrl(path), options);
      const payload = await readJson(response);
      if (response.ok !== true) {
        const detail = payload !== null && typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : 'HTTP ' + response.status;
        throw new Error(detail);
      }
      if (payload === null || payload.ok !== true) {
        const detail = payload !== null && typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : '服务器返回了无法识别的响应';
        throw new Error(detail);
      }
      return payload;
    }

    function postJson(path, body) {
      return requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    function errorMessage(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error || '未知错误');
    }

    async function copyToClipboard(text) {
      const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return false;
      try { await clipboard.writeText(text); return true; }
      catch { return false; } // permission denied or insecure context: callers fall back to manual copying
    }

    /* ------------------------------------------------------------- formats */

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知大小';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function formatStamp(value) {
      if (typeof value === 'string' && value !== '') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.toLocaleString();
        return value;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.toLocaleString();
        return String(value);
      }
      return '—';
    }

    function exportStatsText(stats) {
      const source = stats !== null && typeof stats === 'object' ? stats : {};
      const bundles = typeof source.bundles === 'number' ? source.bundles : 0;
      const rows = typeof source.rows === 'number' ? source.rows : 0;
      return bundles + ' 个插件 · ' + rows + ' 行配置 · ' + formatBytes(source.bytes);
    }

    function requirementKey(item) {
      const entry = item && item.entryId !== undefined && item.entryId !== null ? String(item.entryId) : '';
      const path = item && typeof item.path === 'string' ? item.path : '';
      return entry + '|' + path;
    }

    /* ----------------------------------------------------------- primitive */

    function Button(props) {
      const base = props.primary === true ? primaryButtonStyle : buttonStyle;
      const style = props.disabled === true ? { ...base, ...disabledButtonStyle } : base;
      return h('button', {
        type: 'button',
        style,
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.disabled === true ? undefined : props.onClick,
      }, props.children);
    }

    function Checkbox(props) {
      return h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled === true,
        'aria-label': props.label,
        title: props.label,
        onChange: (event) => { props.onChange(event.target.checked); },
        style: props.disabled === true ? { ...checkboxStyle, cursor: 'not-allowed' } : checkboxStyle,
      });
    }

    function Dot(props) {
      const on = props.on === true;
      return h('span', {
        'aria-hidden': 'true',
        title: on ? '已启用' : '已禁用',
        style: {
          display: 'inline-block',
          flex: '0 0 auto',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: on ? 'rgb(63,185,80)' : 'rgba(128,128,128,.55)',
        },
      });
    }

    function Badge(props) {
      const tone = badgeTones[props.tone] !== undefined ? badgeTones[props.tone] : badgeTones.neutral;
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          flex: '0 0 auto',
          border: '1px solid',
          borderColor: tone.borderColor,
          background: tone.background,
          borderRadius: 999,
          padding: '0 8px',
          fontSize: 12,
          lineHeight: '18px',
          whiteSpace: 'nowrap',
        },
      }, props.children);
    }

    function Alert(props) {
      const tone = alertTones[props.tone] !== undefined ? alertTones[props.tone] : alertTones.info;
      return h('div', {
        role: props.tone === 'error' ? 'alert' : 'status',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          border: '1px solid',
          borderColor: tone.borderColor,
          background: tone.background,
          borderRadius: 8,
          padding: '8px 10px',
          fontSize: 13,
          minWidth: 0,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
          h('span', { style: { flex: '1 1 220px', minWidth: 0, wordBreak: 'break-word' } }, props.message),
          props.action !== undefined
            ? h(Button, {
                onClick: props.action.onClick,
                disabled: props.action.disabled === true,
              }, props.action.label)
            : null),
        props.children === undefined ? null : props.children);
    }

    function Field(props) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('span', { style: microStyle }, props.label),
        h('span', { style: { wordBreak: 'break-word' } }, props.value));
    }

    function Card(props) {
      const hasHeader = props.title !== undefined || props.extra !== undefined;
      return h('section', { style: cardStyle },
        hasHeader
          ? h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
              props.title !== undefined ? h('h3', { style: headingStyle }, props.title) : null,
              props.subtitle !== undefined ? h('span', { style: mutedStyle }, props.subtitle) : null,
              props.extra !== undefined ? h('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 8 } }, props.extra) : null)
          : null,
        props.children);
    }

    function DataTable(props) {
      return h('div', { style: { width: '100%', overflowX: 'auto', minWidth: 0 } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13, lineHeight: 1.45 } },
          h('thead', null,
            h('tr', null,
              props.head.map((label) => h('th', { key: label, style: thStyle }, label)))),
          h('tbody', null,
            props.rows.map((cells, rowIndex) => h('tr', { key: rowIndex },
              cells.map((cell, cellIndex) => h('td', { key: cellIndex, style: tdStyle }, cell)))))));
    }

    /* -------------------------------------------------------------- 分享 */

    function ShareTab(props) {
      const snapshot = props.snapshot;
      const bundles = Array.isArray(snapshot.bundles) ? snapshot.bundles : [];

      const [selected, setSelected] = useState(() => {
        const initial = {};
        for (const bundle of bundles) {
          initial[bundle.name] = bundle.official !== true && bundle.availability !== 'installation';
        }
        return initial;
      });
      const [expanded, setExpanded] = useState({});
      const [includeSecrets, setIncludeSecrets] = useState(false);
      const [exporting, setExporting] = useState(false);
      const [exportError, setExportError] = useState('');
      const [exportResult, setExportResult] = useState(null);
      const [stale, setStale] = useState(false);
      const [copyNote, setCopyNote] = useState('');
      const codeRef = useRef(null);

      useEffect(() => {
        setSelected((previous) => {
          const names = new Set(bundles.map((bundle) => bundle.name));
          const previousNames = Object.keys(previous);
          if (previousNames.length === names.size && previousNames.every((name) => names.has(name))) return previous;
          const next = {};
          for (const bundle of bundles) next[bundle.name] = previous[bundle.name] === true;
          return next;
        });
      }, [bundles]);

      const selectedNames = [];
      for (const bundle of bundles) {
        if (selected[bundle.name] === true) selectedNames.push(bundle.name);
      }
      const selectedCount = selectedNames.length;
      const stats = exportResult !== null && exportResult.stats !== null && typeof exportResult.stats === 'object'
        ? exportResult.stats
        : {};
      const stripped = Array.isArray(stats.stripped) ? stats.stripped : [];
      const uninstalled = Array.isArray(stats.uninstalled) ? stats.uninstalled : [];

      const markStale = () => {
        if (exportResult !== null) setStale(true);
      };

      const toggleBundle = (name, checked) => {
        setSelected((previous) => ({ ...previous, [name]: checked }));
        markStale();
      };

      const setAll = (value) => {
        setSelected(() => {
          const next = {};
          for (const bundle of bundles) next[bundle.name] = value;
          return next;
        });
        markStale();
      };

      const invertSelection = () => {
        setSelected((previous) => {
          const next = {};
          for (const bundle of bundles) next[bundle.name] = previous[bundle.name] !== true;
          return next;
        });
        markStale();
      };

      const toggleExpanded = (name) => {
        setExpanded((previous) => ({ ...previous, [name]: previous[name] !== true }));
      };

      const handleIncludeSecrets = (checked) => {
        setIncludeSecrets(checked);
        setCopyNote('');
        if (exportResult !== null) setStale(true);
      };

      const handleExport = async () => {
        if (exporting || selectedNames.length === 0) return;
        setExporting(true);
        setExportError('');
        setCopyNote('');
        try {
          const payload = await postJson('/api/dsh-profile-sync/export', {
            bundles: selectedNames,
            includeSecrets,
          });
          setExportResult(payload);
          setStale(false);
        } catch (error) {
          setExportError(errorMessage(error));
        } finally {
          setExporting(false);
        }
      };

      const handleCopy = async () => {
        if (exportResult === null) return;
        const code = typeof exportResult.code === 'string' ? exportResult.code : '';
        if (code === '') return;
        const copied = await copyToClipboard(code);
        if (copied) {
          setCopyNote('已复制到剪贴板');
          return;
        }
        const element = codeRef.current;
        if (element && typeof element.select === 'function') {
          element.focus();
          element.select();
          setCopyNote('浏览器不允许写入剪贴板，文本已全选，请按 Ctrl+C（macOS 为 ⌘+C）手动复制');
        } else {
          setCopyNote('浏览器不允许写入剪贴板，请手动选中文本复制');
        }
      };

      const handleCopyBootstrap = async () => {
        if (exportResult === null) return;
        const code = typeof exportResult.code === 'string' ? exportResult.code : '';
        if (code === '') return;
        const text = [
          '帮我安装这个 DSH 插件：https://github.com/sldmn233/dsh-profile-share',
          '装好后用 profile_share_import 导入下面这条分享码，先给我看计划，我确认后再用 apply=true 执行：',
          code,
        ].join('\n');
        const copied = await copyToClipboard(text);
        setCopyNote(copied
          ? '已复制「引导语 + 分享码」，可直接整段发给对方'
          : '浏览器不允许写入剪贴板，请手动复制下方分享码并附上仓库地址');
      };

      const groups = useMemo(() => {
        const thirdParty = [];
        const official = [];
        const installation = [];
        for (const bundle of bundles) {
          if (bundle.availability === 'installation') installation.push(bundle);
          else if (bundle.official === true) official.push(bundle);
          else thirdParty.push(bundle);
        }
        return [
          { key: 'third-party', title: '第三方', hint: '自己安装的插件，对方需要安装。', bundles: thirdParty },
          { key: 'official', title: '官方', hint: 'DSH 官方插件。', bundles: official },
          { key: 'installation', title: '随 DSH 安装', hint: '随 DSH 一起安装，对方无需安装。', bundles: installation },
        ].filter((group) => group.bundles.length > 0);
      }, [bundles]);

      const renderRows = (bundle) => {
        const rows = Array.isArray(bundle.rows) ? bundle.rows : [];
        if (rows.length === 0) {
          return h('div', { style: { ...mutedStyle, paddingLeft: 26 } }, '这个插件没有可同步的配置行。');
        }
        return h('div', { style: { paddingLeft: 26, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          rows.map((row) => h('div', {
            key: String(row.rowId),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '4px 0',
              borderBottom: '1px solid ' + SOFT_BORDER,
              minWidth: 0,
            },
          },
            h('code', { style: monoStyle }, String(row.rowId)),
            h('code', { style: { ...monoPlainStyle, opacity: 0.75 } }, String(row.moduleName)),
            h(Dot, { on: row.enabled === true }),
            h('span', { style: mutedStyle }, row.enabled === true ? '已启用' : '已禁用'),
            row.hasOverride === true ? h(Badge, { tone: 'info' }, '已自定义') : null)));
      };

      const renderBundle = (bundle, dimmed) => {
        const name = String(bundle.name);
        const isOpen = expanded[name] === true;
        const checked = selected[name] === true;
        const title = typeof bundle.title === 'string' && bundle.title !== '' ? bundle.title : name;
        const availability = bundle.availability;
        const version = typeof bundle.version === 'string' || typeof bundle.version === 'number'
          ? 'v' + String(bundle.version)
          : '—';
        return h('div', {
          key: name,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 0',
            borderTop: '1px solid ' + SOFT_BORDER,
            opacity: dimmed === true && checked !== true ? 0.72 : 1,
            minWidth: 0,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
            h(Checkbox, {
              checked,
              disabled: exporting,
              onChange: (next) => { toggleBundle(name, next); },
              label: '选择 ' + title,
            }),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, flex: '1 1 200px', minWidth: 0 } },
              h('span', {
                title: typeof bundle.description === 'string' && bundle.description !== '' ? bundle.description : undefined,
                style: { fontWeight: 500, wordBreak: 'break-word' },
              }, title),
              title !== name ? h('span', { style: { ...monoPlainStyle, opacity: 0.6 } }, name) : null),
            h('span', { style: { ...mutedStyle, whiteSpace: 'nowrap' } }, version),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' } },
              h(Dot, { on: bundle.enabled === true }),
              h('span', { style: mutedStyle }, bundle.enabled === true ? '已启用' : '已禁用')),
            availability === 'missing' ? h(Badge, { tone: 'bad' }, '未安装') : null,
            availability === 'installation' ? h(Badge, { tone: 'neutral' }, '随安装') : null,
            h('button', {
              type: 'button',
              onClick: () => { toggleExpanded(name); },
              'aria-expanded': isOpen,
              'aria-label': (isOpen ? '收起 ' : '展开 ') + title,
              title: isOpen ? '收起配置行' : '展开配置行',
              style: {
                font: 'inherit',
                color: 'inherit',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                lineHeight: 1,
                opacity: 0.75,
                flex: '0 0 auto',
              },
            }, isOpen ? '▾' : '▸')),
          isOpen ? renderRows(bundle) : null);
      };

      const renderGroup = (group) => h('div', {
        key: group.key,
        style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
          h('h4', { style: subheadingStyle }, group.title),
          h('span', { style: microStyle }, group.hint),
          h('span', { style: { ...microStyle, marginLeft: 'auto' } }, group.bundles.length + ' 个')),
        group.bundles.map((bundle) => renderBundle(bundle, group.key === 'installation')));

      const renderExportResult = () => {
        const code = typeof exportResult.code === 'string' ? exportResult.code : '';
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
          h('textarea', {
            ref: codeRef,
            readOnly: true,
            value: code,
            spellCheck: false,
            wrap: 'off',
            'aria-label': '分享码',
            style: { ...textareaStyle, minHeight: 96 },
            onFocus: (event) => { event.currentTarget.select(); },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(Button, { onClick: handleCopy }, '复制'),
            h(Button, { onClick: handleCopyBootstrap }, '复制引导语（含码）'),
            h('span', { style: mutedStyle }, exportStatsText(stats)),
            copyNote !== '' ? h('span', { style: mutedStyle }, copyNote) : null),
          stale
            ? h(Alert, { tone: 'warning', message: '选择或选项已更改，请重新生成分享码后再复制。' })
            : null,
          includeSecrets && stale !== true
            ? h(Alert, { tone: 'warning', message: '这份分享码包含密钥字段，请只发给可信的人。' })
            : null,
          stripped.length > 0
            ? h(Alert, { tone: 'warning', message: '已剥离疑似密钥字段：' },
                h('ul', { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 } },
                  stripped.map((path, index) => h('li', { key: index, style: monoPlainStyle }, String(path)))))
            : null,
          uninstalled.length > 0
            ? h(Alert, { tone: 'warning', message: '这些插件你本机没装，没有写进分享码：' + uninstalled.join('、') })
            : null);
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Button, { onClick: () => { setAll(true); }, disabled: exporting || bundles.length === 0 }, '全选'),
          h(Button, { onClick: () => { setAll(false); }, disabled: exporting || selectedCount === 0 }, '全不选'),
          h(Button, { onClick: invertSelection, disabled: exporting || bundles.length === 0 }, '反选'),
          h('span', { style: { ...mutedStyle, marginLeft: 'auto' } }, '已选 ' + selectedCount + ' / ' + bundles.length)),
        h(Card, { title: '插件列表' },
          bundles.length === 0
            ? h('div', { style: mutedStyle }, '当前 profile 没有可用插件。')
            : groups.map((group) => renderGroup(group))),
        h(Card, { title: '生成分享码' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(Button, {
              onClick: handleExport,
              disabled: exporting || selectedCount === 0,
              primary: true,
            }, exporting ? '生成中…' : '生成分享码'),
            h('label', { style: labelRowStyle },
              h(Checkbox, {
                checked: includeSecrets,
                disabled: exporting,
                onChange: handleIncludeSecrets,
                label: '包含可能的密钥字段',
              }),
              h('span', null, '包含可能的密钥字段')),
            selectedCount === 0 ? h('span', { style: mutedStyle }, '至少选择一个插件。') : null),
          h('div', { style: microStyle }, '默认剥离 apiKey、token、secret、password 等疑似密钥字段；接收方在「首次配置」里填写自己的值。'),
          exportError !== '' ? h(Alert, { tone: 'error', message: '生成失败：' + exportError }) : null,
          exportResult !== null ? renderExportResult() : null),
        h(Card, { title: '对方怎么用' },
          h('ol', {
            style: {
              margin: 0,
              paddingLeft: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 13,
              lineHeight: 1.7,
              color: 'inherit',
            },
          },
            h('li', null, '点「复制引导语（含码）」，把整段发给对方：对方的 DSH 会先问你确认要不要装本插件，装好后给出导入计划，你确认才执行。'),
            h('li', null, '也可以手动：把 https://github.com/sldmn233/dsh-profile-share 发给对方，装好后在「同步」页粘贴 → 预览 → 应用。'),
            h('li', null, '对方切到「首次配置」，补齐自己的 API Key、环境变量与登录态。')),
          h('div', { style: microStyle }, '之后你这边新增或修改了插件，重新生成一条码发过去，对方再「预览 → 应用」即可增量同步；默认只新增/更新，不会禁用或删除对方已有、但码里没有的插件。')));
    }

    /* -------------------------------------------------------------- 同步 */

    function SyncTab(props) {
      const [code, setCode] = useState('');
      const [previewing, setPreviewing] = useState(false);
      const [previewError, setPreviewError] = useState('');
      const [preview, setPreview] = useState(null);
      const [fullAlign, setFullAlign] = useState(false);
      const [applying, setApplying] = useState(false);
      const [applyError, setApplyError] = useState('');
      const [applyResult, setApplyResult] = useState(null);
      const [confirming, setConfirming] = useState(false);

      useEffect(() => {
        if (confirming !== true) return undefined;
        const timer = setTimeout(() => { setConfirming(false); }, 3000);
        return () => { clearTimeout(timer); };
      }, [confirming]);

      const trimmedCode = code.trim();

      const handleCodeChange = (event) => {
        setCode(event.target.value);
        setPreview(null);
        setPreviewError('');
        setApplyResult(null);
        setApplyError('');
        setConfirming(false);
      };

      const handlePreview = async () => {
        if (previewing || trimmedCode === '') return;
        setPreviewing(true);
        setPreviewError('');
        setPreview(null);
        setApplyResult(null);
        setApplyError('');
        setConfirming(false);
        try {
          const payload = await postJson('/api/dsh-profile-sync/preview', { code: trimmedCode });
          setPreview(payload);
        } catch (error) {
          setPreviewError(errorMessage(error));
        } finally {
          setPreviewing(false);
        }
      };

      const applyNow = async () => {
        setApplying(true);
        setApplyError('');
        try {
          const payload = await postJson('/api/dsh-profile-sync/apply', { code: trimmedCode, fullAlign });
          setApplyResult(payload);
          setPreview(null);
          setConfirming(false);
          if (typeof props.onApplied === 'function') await props.onApplied();
        } catch (error) {
          setApplyError(errorMessage(error));
        } finally {
          setApplying(false);
        }
      };

      const handleApplyClick = () => {
        if (preview === null || applying) return;
        if (confirming !== true) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        void applyNow();
      };

      const manifest = preview !== null && preview.manifest !== null && typeof preview.manifest === 'object'
        ? preview.manifest
        : {};
      const source = manifest.source !== null && typeof manifest.source === 'object' ? manifest.source : {};
      const manifestBundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
      const steps = preview !== null && Array.isArray(preview.steps) ? preview.steps : [];
      const rowCount = typeof manifest.rowCount === 'number' ? manifest.rowCount : 0;
      const summary = preview !== null && preview.summary !== null && typeof preview.summary === 'object'
        ? preview.summary
        : {};
      const summaryInstall = typeof summary.install === 'number' ? summary.install : 0;
      const summaryToggle = typeof summary.bundleToggle === 'number' ? summary.bundleToggle : 0;
      const summaryConfig = typeof summary.config === 'number' ? summary.config : 0;
      const results = applyResult !== null && Array.isArray(applyResult.results) ? applyResult.results : [];
      const failedCount = results.filter((result) => result.status === 'failed').length;

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 } },
        h(Card, { title: '粘贴分享码' },
          h('textarea', {
            value: code,
            spellCheck: false,
            placeholder: '粘贴分享码（以 DSH-SHARE/1: 开头）',
            'aria-label': '分享码',
            style: { ...textareaStyle, minHeight: 96 },
            onChange: handleCodeChange,
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(Button, {
              onClick: () => { void handlePreview(); },
              disabled: previewing || applying || trimmedCode === '',
              primary: true,
            }, previewing ? '预览中…' : '预览'),
            h('span', { style: mutedStyle }, '分享码以 DSH-SHARE/1: 开头，由对方在「分享」页生成。'))),
        previewError !== ''
          ? h(Alert, {
              tone: 'error',
              message: '预览失败：' + previewError,
              action: { label: '重试', onClick: () => { void handlePreview(); }, disabled: previewing || trimmedCode === '' },
            })
          : null,
        preview !== null
          ? h(Card, { title: '预览' },
              h('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: '6px 12px',
                  minWidth: 0,
                },
              },
                h(Field, { label: '生成时间', value: formatStamp(manifest.createdAt) }),
                h(Field, {
                  label: '来源 profile',
                  value: typeof source.profile === 'string' && source.profile !== '' ? source.profile : '—',
                }),
                h(Field, {
                  label: 'DSH 版本',
                  value: typeof source.dshVersion === 'string' && source.dshVersion !== '' ? source.dshVersion : '—',
                }),
                h(Field, { label: '插件', value: manifestBundles.length + ' 个' }),
                h(Field, { label: '配置', value: rowCount + ' 条' })),
              steps.length === 0
                ? h('div', { style: mutedStyle }, '没有需要执行的步骤。')
                : h(DataTable, {
                    head: ['类型', '对象', '说明', '状态'],
                    rows: steps.map((step) => [
                      STEP_KIND_LABELS[step.kind] !== undefined ? STEP_KIND_LABELS[step.kind] : String(step.kind),
                      h('code', { style: monoStyle }, String(step.target)),
                      h('span', { style: { wordBreak: 'break-word' } }, step.detail === undefined ? '' : String(step.detail)),
                      h('span', { style: { whiteSpace: 'nowrap' } },
                        STEP_STATUS_LABELS[step.status] !== undefined ? STEP_STATUS_LABELS[step.status] : String(step.status)),
                    ]),
                  }),
              h('div', { style: mutedStyle },
                '待执行：安装 ' + summaryInstall + ' 个 · 插件开关 ' + summaryToggle + ' 项 · 写入配置 ' + summaryConfig + ' 项'),
              h('label', { style: labelRowStyle },
                h(Checkbox, {
                  checked: fullAlign,
                  disabled: applying,
                  onChange: setFullAlign,
                  label: '完整对齐',
                }),
                h('span', null, '完整对齐（禁用对方多出来、且不在码里的插件）')),
              h('div', { style: mutedStyle }, '默认只新增/更新：不会禁用或删除对方已有、但不在分享码里的插件。'),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(Button, {
                  onClick: handleApplyClick,
                  disabled: applying,
                  primary: true,
                }, applying ? '应用中…' : confirming ? '确认应用？再点一次' : '应用'),
                confirming ? h('span', { style: mutedStyle }, '3 秒内再点一次确认，超时会自动取消。') : null))
          : null,
        applyError !== '' ? h(Alert, { tone: 'error', message: '应用失败：' + applyError }) : null,
        applyResult !== null
          ? h(Card, {
              title: '应用结果',
              subtitle: applyResult.changed === true ? '已产生变更' : '无变更',
            },
              h('div', { style: mutedStyle }, '共 ' + results.length + ' 项，失败 ' + failedCount + ' 项。'),
              results.length === 0
                ? h('div', { style: mutedStyle }, '没有返回具体结果。')
                : h(DataTable, {
                    head: ['类型', '对象', '状态', '错误'],
                    rows: results.map((result) => [
                      STEP_KIND_LABELS[result.kind] !== undefined ? STEP_KIND_LABELS[result.kind] : String(result.kind),
                      h('code', { style: monoStyle }, String(result.target)),
                      h(Badge, {
                        tone: result.status === 'failed' ? 'bad' : result.status === 'applied' ? 'ok' : 'neutral',
                      }, APPLY_STATUS_LABELS[result.status] !== undefined ? APPLY_STATUS_LABELS[result.status] : String(result.status)),
                      result.error === undefined || result.error === null || result.error === ''
                        ? '—'
                        : h('span', { style: { wordBreak: 'break-word' } }, String(result.error)),
                    ]),
                  }),
              applyResult.restartRequired === true
                ? h(Alert, { tone: 'info', message: '部分插件需要重启 DSH 生效。' })
                : null,
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h(Button, { onClick: props.onGoRequirements, primary: true }, '去首次配置')))
          : null);
    }

    /* ---------------------------------------------------------- 首次配置 */

    function RequirementsTab(props) {
      const [items, setItems] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [drafts, setDrafts] = useState({});
      const [savingKey, setSavingKey] = useState('');
      const [itemErrors, setItemErrors] = useState({});
      const [copyNote, setCopyNote] = useState('');
      const [copyTone, setCopyTone] = useState('info');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const payload = await requestJson('/api/dsh-profile-sync/requirements');
          setItems(Array.isArray(payload.items) ? payload.items : []);
        } catch (loadError) {
          setError(errorMessage(loadError));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        if (props.active === true) void load();
      }, [props.active, load]);

      const setDraft = (key, value) => {
        setDrafts((previous) => ({ ...previous, [key]: value }));
      };

      const saveSecret = async (item) => {
        const key = requirementKey(item);
        const value = typeof drafts[key] === 'string' ? drafts[key] : '';
        if (value === '' || savingKey !== '') return;
        setSavingKey(key);
        setItemErrors((previous) => ({ ...previous, [key]: '' }));
        try {
          await postJson('/api/dsh-profile-sync/configure', {
            entryId: item.entryId,
            path: item.path,
            value,
          });
          setItems((previous) => {
            if (!Array.isArray(previous)) return previous;
            return previous.map((candidate) => requirementKey(candidate) === key
              ? { ...candidate, status: 'ready' }
              : candidate);
          });
          setDrafts((previous) => ({ ...previous, [key]: '' }));
        } catch (saveError) {
          setItemErrors((previous) => ({ ...previous, [key]: errorMessage(saveError) }));
        } finally {
          setSavingKey('');
        }
      };

      const copyEnvName = async (item) => {
        const envName = typeof item.envName === 'string' ? item.envName : '';
        if (envName === '') return;
        const copied = await copyToClipboard(envName);
        setCopyTone(copied ? 'success' : 'warning');
        setCopyNote(copied ? '已复制变量名：' + envName : '复制失败，请手动输入：' + envName);
      };

      const groups = useMemo(() => {
        const list = Array.isArray(items) ? items : [];
        const buckets = new Map();
        for (const item of list) {
          const kind = typeof item.kind === 'string' && item.kind !== '' ? item.kind : 'other';
          if (!buckets.has(kind)) buckets.set(kind, []);
          buckets.get(kind).push(item);
        }
        const kinds = REQUIREMENT_KIND_ORDER
          .filter((kind) => buckets.has(kind))
          .concat(Array.from(buckets.keys()).filter((kind) => REQUIREMENT_KIND_ORDER.indexOf(kind) < 0));
        return kinds.map((kind) => ({
          kind,
          label: REQUIREMENT_KIND_LABELS[kind] !== undefined ? REQUIREMENT_KIND_LABELS[kind] : kind,
          items: buckets.get(kind),
        }));
      }, [items]);

      const total = Array.isArray(items) ? items.length : 0;
      const readyCount = Array.isArray(items) ? items.filter((item) => item.status === 'ready').length : 0;
      const manualCount = Array.isArray(items) ? items.filter((item) => item.status === 'manual').length : 0;
      const pendingCount = total - readyCount;

      const renderSecretEditor = (item, key) => {
        const draft = typeof drafts[key] === 'string' ? drafts[key] : '';
        const saving = savingKey === key;
        const itemError = typeof itemErrors[key] === 'string' ? itemErrors[key] : '';
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
            h('input', {
              type: 'password',
              value: draft,
              disabled: saving,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: '输入' + (typeof item.label === 'string' && item.label !== '' ? item.label : '密钥') + '后保存',
              'aria-label': '配置 ' + (typeof item.label === 'string' && item.label !== '' ? item.label : String(item.path)),
              style: { ...inputStyle, flex: '1 1 200px', minWidth: 0 },
              onChange: (event) => { setDraft(key, event.target.value); },
            }),
            h(Button, {
              onClick: () => { void saveSecret(item); },
              disabled: savingKey !== '' || draft === '',
              primary: true,
            }, saving ? '保存中…' : '保存')),
          h('div', { style: microStyle }, '已保存的值不会回显，再次保存会覆盖。'),
          itemError !== '' ? h(Alert, { tone: 'error', message: itemError }) : null);
      };

      const renderEnvItem = (item) => {
        const envName = typeof item.envName === 'string' ? item.envName : '';
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
            h('code', { style: { ...monoStyle, background: 'transparent', borderStyle: 'dashed' } },
              envName !== '' ? envName : '（未提供变量名）'),
            h(Button, {
              onClick: () => { void copyEnvName(item); },
              disabled: envName === '',
            }, '复制变量名')),
          item.status === 'ready'
            ? h('div', { style: mutedStyle }, '环境变量已就绪。')
            : h('div', { style: mutedStyle }, '在启动 DSH 的环境里设置该变量后重启。'));
      };

      const renderRequirement = (item) => {
        const key = requirementKey(item);
        const status = typeof item.status === 'string' && item.status !== '' ? item.status : 'missing';
        const kind = typeof item.kind === 'string' ? item.kind : 'other';
        const bundleName = typeof item.bundle === 'string' && item.bundle !== '' ? item.bundle : '';
        const configPath = typeof item.path === 'string' && item.path !== '' ? item.path : '';
        const title = typeof item.title === 'string' && item.title !== ''
          ? item.title
          : (typeof item.label === 'string' && item.label !== ''
              ? item.label
              : (configPath !== '' ? configPath : key));
        return h('div', {
          key,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            border: '1px solid ' + BORDER,
            borderRadius: 8,
            padding: '10px 12px',
            background: 'rgba(128,128,128,.05)',
            minWidth: 0,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px', minWidth: 0 } },
              h('div', { style: { fontWeight: 600, wordBreak: 'break-word' } }, title),
              h('div', { style: { ...monoPlainStyle, opacity: 0.65 } },
                bundleName !== '' && configPath !== ''
                  ? bundleName + ' · ' + configPath
                  : (bundleName !== '' ? bundleName : configPath))),
            h(Badge, {
              tone: status === 'ready' ? 'ok' : status === 'missing' ? 'bad' : 'neutral',
            }, status === 'ready'
              ? '就绪'
              : status === 'missing'
                ? '缺配置'
                : status === 'manual' ? '需手动' : status)),
          kind === 'secret'
            ? renderSecretEditor(item, key)
            : kind === 'env'
              ? renderEnvItem(item)
              : kind === 'login'
                ? h('div', { style: mutedStyle }, status === 'ready'
                    ? '登录态已就绪。'
                    : '该插件需要登录/授权，请到它自己的设置页完成。')
                : h('div', { style: mutedStyle }, '无法识别的配置类型，请手动处理。'));
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
          h('span', { style: { fontWeight: 600 } },
            items === null
              ? '正在检查配置项…'
              : pendingCount + ' 项待配置 / ' + readyCount + ' 项就绪'
                + (manualCount > 0 ? ' · ' + manualCount + ' 项需手动' : '')),
          h(Button, {
            onClick: () => { void load(); },
            disabled: loading,
            title: '重新检查密钥、环境变量与登录态',
          }, loading ? '检查中…' : '重新检查')),
        error !== ''
          ? h(Alert, {
              tone: 'error',
              message: '检查失败：' + error,
              action: { label: '重试', onClick: () => { void load(); }, disabled: loading },
            })
          : null,
        copyNote !== '' ? h(Alert, { tone: copyTone, message: copyNote }) : null,
        items === null && loading ? h('div', { style: mutedStyle }, '正在读取配置项…') : null,
        items !== null && total > 0 && pendingCount === 0
          ? h(Alert, { tone: 'success', message: '全部就绪' })
          : null,
        items !== null && total === 0
          ? h('div', { style: mutedStyle }, '没有检测到需要补齐的密钥、环境变量或登录态。')
          : null,
        groups.map((group) => h('div', {
          key: group.kind,
          style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
        },
          h('h4', { style: subheadingStyle }, group.label + '（' + group.items.length + '）'),
          group.items.map((item) => renderRequirement(item)))));
    }

    /* ---------------------------------------------------------------- 页面 */

    function Page() {
      const [tab, setTab] = useState('share');
      const [snapshot, setSnapshot] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');

      const loadState = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const payload = await requestJson('/api/dsh-profile-sync/state');
          setSnapshot(payload);
        } catch (loadError) {
          setError(errorMessage(loadError));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => { void loadState(); }, [loadState]);

      const profile = snapshot !== null && snapshot.profile !== null && typeof snapshot.profile === 'object'
        ? snapshot.profile
        : {};
      const bundles = snapshot !== null && Array.isArray(snapshot.bundles) ? snapshot.bundles : [];
      const counts = snapshot !== null && snapshot.counts !== null && typeof snapshot.counts === 'object'
        ? snapshot.counts
        : {};
      const profileName = typeof profile.name === 'string' && profile.name !== '' ? profile.name : '未知 profile';
      const dshVersion = typeof profile.dshVersion === 'string' && profile.dshVersion !== ''
        ? profile.dshVersion
        : '未知版本';
      const bundleCount = typeof counts.bundles === 'number' ? counts.bundles : bundles.length;
      const rowCount = typeof counts.rows === 'number' ? counts.rows : 0;

      const tabs = [
        { id: 'share', label: '分享' },
        { id: 'sync', label: '同步' },
        { id: 'requirements', label: '首次配置' },
      ];

      const panelStyle = (id) => ({
        display: tab === id ? 'flex' : 'none',
        flexDirection: 'column',
        gap: 14,
        minWidth: 0,
      });

      return h('div', { style: pageStyle },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', minWidth: 0 } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 220px', minWidth: 0 } },
            h('div', { style: { fontSize: 16, fontWeight: 600 } }, '分享与同步'),
            h('div', { style: mutedStyle },
              snapshot === null
                ? (loading ? '正在读取 profile 与插件状态…' : '尚未读取 profile 信息')
                : profileName + ' · DSH ' + dshVersion + ' · ' + bundleCount + ' 个插件 / ' + rowCount + ' 行')),
          h(Button, {
            onClick: () => { void loadState(); },
            disabled: loading,
            title: '重新读取 profile 与插件状态',
          }, loading ? '刷新中…' : '刷新')),
        error !== ''
          ? h(Alert, {
              tone: 'error',
              message: '读取 profile 失败：' + error,
              action: { label: loading ? '重试中…' : '重试', onClick: () => { void loadState(); }, disabled: loading },
            })
          : null,
        h('div', {
          role: 'tablist',
          'aria-label': '分享与同步',
          style: { display: 'flex', gap: 4, borderBottom: '1px solid ' + BORDER, flexWrap: 'wrap' },
        },
          tabs.map((entry) => {
            const active = tab === entry.id;
            return h('button', {
              key: entry.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active,
              onClick: () => { setTab(entry.id); },
              style: {
                font: 'inherit',
                color: 'inherit',
                background: 'transparent',
                border: 'none',
                borderBottom: '2px solid ' + (active ? 'currentColor' : 'transparent'),
                padding: '8px 12px',
                marginBottom: -1,
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
                opacity: active ? 1 : 0.7,
                flex: '0 0 auto',
              },
            }, entry.label);
          })),
        snapshot === null
          ? h('div', { style: cardStyle },
              h('div', { style: mutedStyle },
                loading ? '正在读取 profile 与插件状态…' : '暂时无法读取 profile 信息，请点击「刷新」重试。'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 } },
              h('div', { style: panelStyle('share') }, h(ShareTab, { snapshot })),
              h('div', { style: panelStyle('sync') }, h(SyncTab, {
                onApplied: loadState,
                onGoRequirements: () => { setTab('requirements'); },
              })),
              h('div', { style: panelStyle('requirements') }, h(RequirementsTab, {
                active: tab === 'requirements',
              }))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'profile-sync',
          order: 45,
          label: '分享与同步',
          icon: 'share',
        }, Page));
      },
    };
  },
});
