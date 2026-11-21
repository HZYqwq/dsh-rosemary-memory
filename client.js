// dsh-memory — browser entry.
//
// One page, reachable from the left sidebar, in two halves:
//
//   * 记忆 — the compressed view: notes folded into weighted units, playbooks
//     first, each row expandable to the notes it was built from;
//   * 阈值 — the two thresholds that decide when this page grows a new playbook
//     (memory) and when billion-context starts folding the conversation.
//
// Everything is a same-origin fetch to /dsh-memory/*, so it keeps working when
// the UI is opened from a phone through the remote tunnel.
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-memory';
    const C = {
      text: 'var(--dsw-alias-label-primary, #18202c)',
      muted: 'var(--dsw-alias-label-secondary, #667085)',
      line: 'var(--dsw-alias-border-l2, #e7e9ef)',
      soft: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
      bg: 'var(--dsw-alias-bg-layer-1, #fff)',
      accent: 'var(--dsh-memory-accent, #4f6bdb)',
    };

    async function api(pathname, init) {
      const res = await fetch(`${ROUTE}${pathname}`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      return data;
    }

    function relTime(at) {
      if (!at) return '';
      const diff = Date.now() - at;
      const min = Math.round(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return `${min} 分钟前`;
      const hours = Math.round(min / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.round(hours / 24);
      return days < 30 ? `${days} 天前` : `${Math.round(days / 30)} 个月前`;
    }

    function Bar({ value }) {
      return h(
        'span',
        { style: { display: 'inline-block', width: 54, height: 6, borderRadius: 3, background: C.line, overflow: 'hidden', verticalAlign: 'middle' } },
        h('span', {
          style: { display: 'block', width: `${Math.round(Math.max(0.04, Math.min(1, value)) * 100)}%`, height: '100%', background: C.accent },
        }),
      );
    }

    function Badge({ kind }) {
      const label = kind === 'playbook' ? '加权压缩' : kind === 'fix' ? '修复' : kind === 'decision' ? '决策' : '记忆';
      return h(
        'span',
        {
          style: {
            fontSize: 11,
            padding: '1px 7px',
            borderRadius: 999,
            border: `1px solid ${kind === 'playbook' ? C.accent : C.line}`,
            color: kind === 'playbook' ? C.accent : C.muted,
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    function UnitRow({ unit, open, onToggle }) {
      return h(
        'div',
        { style: { borderTop: `1px solid ${C.line}`, padding: '14px 0' } },
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 600, color: C.text, fontSize: 14.5, lineHeight: 1.5 } }, unit.title)),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', color: C.muted, fontSize: 12, whiteSpace: 'nowrap' } },
            h(Bar, { value: unit.weight }),
            h('span', null, unit.weight.toFixed(2)),
            h(Badge, { kind: unit.kind }),
          ),
        ),
        h(
          'div',
          { style: { marginTop: 6, color: C.muted, fontSize: 12.5, display: 'flex', gap: 14, flexWrap: 'wrap' } },
          h('span', null, `出现 ${unit.timesSeen} 次`),
          h('span', null, `跨 ${unit.sessionsSeen} 个会话`),
          unit.members > 1 ? h('span', null, `合并 ${unit.members} 条`) : null,
          h('span', null, relTime(unit.lastSeenAt)),
          unit.folded.length
            ? h('a', { href: '#', onClick: (event) => { event.preventDefault(); onToggle(); }, style: { color: C.accent, textDecoration: 'none' } },
              open ? '收起原文' : `看被压缩的 ${unit.folded.length} 条`)
            : null,
        ),
        open
          ? h(
            'div',
            { style: { marginTop: 8, background: C.soft, borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: C.muted, lineHeight: 1.65 } },
            h('div', { style: { color: C.text, marginBottom: 6 } }, unit.text),
            unit.folded.map((line, index) => h('div', { key: index, style: { paddingTop: 4, borderTop: index ? `1px dashed ${C.line}` : 'none' } }, line)),
          )
          : null,
      );
    }

    function Field({ label, hint, value, onChange, suffix }) {
      return h(
        'label',
        { style: { display: 'block', marginBottom: 14 } },
        h('div', { style: { fontSize: 12.5, color: C.text, marginBottom: 4 } }, label),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            value,
            onChange: (event) => onChange(event.target.value),
            style: { flex: 1, padding: '6px 9px', borderRadius: 7, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: 'inherit' },
          }),
          suffix ? h('span', { style: { color: C.muted, fontSize: 12 } }, suffix) : null,
        ),
        hint ? h('div', { style: { marginTop: 4, color: C.muted, fontSize: 11.5, lineHeight: 1.5 } }, hint) : null,
      );
    }

    function MemoryPage() {
      const [tab, setTab] = React.useState('units');
      const [units, setUnits] = React.useState([]);
      const [stats, setStats] = React.useState({});
      const [q, setQ] = React.useState('');
      const [openId, setOpenId] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [memory, setMemory] = React.useState({ compactThreshold: 2, compactWeight: 0.4, similarity: 0.55 });
      const [context, setContext] = React.useState({ nudgeGrowthTokens: 50000, maxContextLimit: '75%' });

      const load = React.useCallback(async (needle) => {
        setError('');
        try {
          const data = await api(`/units?q=${encodeURIComponent(needle || '')}&limit=120`);
          setUnits(data.units || []);
          setStats(data.stats || {});
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      const loadSettings = React.useCallback(async () => {
        try {
          const data = await api('/settings');
          setMemory(data.memory || {});
          setContext(data.context || {});
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      React.useEffect(() => {
        load('');
        loadSettings();
      }, [load, loadSettings]);

      // Debounced search: the store is small, but typing should not fire a
      // request per keystroke.
      React.useEffect(() => {
        const timer = setTimeout(() => load(q), 180);
        return () => clearTimeout(timer);
      }, [q, load]);

      const recompress = async () => {
        setBusy('compress');
        setNotice('');
        try {
          const data = await api('/compress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          setNotice(`已重新压缩：${data.stats.units} 个单元，${data.stats.playbooks} 个加权压缩条目`);
          await load(q);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const digest = async () => {
        setBusy('digest');
        setNotice('');
        try {
          const data = await api('/digest', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dryRun: false, all: true }),
          });
          setNotice(`归纳完成：${data.sessions} 个会话，新增 ${data.runsAdded} run / ${data.notesAdded} note`);
          await load(q);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const save = async () => {
        setBusy('save');
        setNotice('');
        setError('');
        try {
          const data = await api('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              memory: {
                compactThreshold: Number(memory.compactThreshold),
                compactWeight: Number(memory.compactWeight),
                similarity: Number(memory.similarity),
              },
              context: {
                nudgeGrowthTokens: Number(context.nudgeGrowthTokens),
                maxContextLimit: String(context.maxContextLimit),
              },
            }),
          });
          setMemory(data.memory);
          setContext(data.context);
          setNotice('阈值已保存（长上下文阈值由 billion-context 逐请求读取，无需重启）');
          await load(q);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const tabStyle = (active) => ({
        padding: '7px 14px',
        borderRadius: 8,
        border: `1px solid ${active ? C.accent : C.line}`,
        background: active ? 'color-mix(in srgb, ' + C.accent + ' 8%, transparent)' : C.bg,
        color: active ? C.accent : C.text,
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: 'inherit',
      });

      return h(
        'div',
        {
          className: 'dshm',
          // The slot hands the page a fixed-height box: this element is the scroll
          // container, and the inner div keeps the reading column centered.
          style: {
            boxSizing: 'border-box',
            width: '100%',
            height: '100%',
            maxHeight: '100%',
            overflowY: 'auto',
            overflowX: 'hidden',
            WebkitOverflowScrolling: 'touch',
            padding: '28px 34px 60px',
            color: C.text,
            font: '14px/1.6 var(--dsh-font-family-content, system-ui)',
          },
        },
        h(
          'div',
          { style: { maxWidth: 1000, margin: '0 auto' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 } },
          h('h1', { style: { fontSize: 20, margin: 0, fontWeight: 700 } }, '跨会话记忆'),
          h('span', { style: { color: C.muted, fontSize: 12.5 } },
            `${stats.units || 0} 个单元 · ${stats.playbooks || 0} 个加权压缩 · ${stats.notes || 0} 条原始 note`),
        ),
        h('div', { style: { color: C.muted, fontSize: 12.5, marginBottom: 18 } },
          '把过去的回合归纳成 run / note，再把相似的 note 加权合并成一条：出现越多、跨会话越多，权重越高。'),

        h('div', { style: { display: 'flex', gap: 8, marginBottom: 18 } },
          h('button', { style: tabStyle(tab === 'units'), onClick: () => setTab('units') }, '记忆'),
          h('button', { style: tabStyle(tab === 'settings'), onClick: () => setTab('settings') }, '阈值'),
          h('div', { style: { flex: 1 } }),
          h('button', {
            onClick: digest,
            disabled: busy === 'digest',
            style: { padding: '7px 14px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: C.text, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
          }, busy === 'digest' ? '归纳中…' : '归纳新回合'),
          h('button', {
            onClick: recompress,
            disabled: busy === 'compress',
            style: { padding: '7px 14px', borderRadius: 8, border: `1px solid ${C.accent}`, background: C.accent, color: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
          }, busy === 'compress' ? '压缩中…' : '重新压缩'),
        ),

        notice ? h('div', { style: { marginBottom: 14, fontSize: 12.5, color: '#1a7f4b' } }, notice) : null,
        error ? h('div', { style: { marginBottom: 14, fontSize: 12.5, color: '#c0392b' } }, error) : null,

        tab === 'units'
          ? h(
            'div',
            null,
            h('input', {
              value: q,
              onChange: (event) => setQ(event.target.value),
              placeholder: '搜索记忆：报错、命令、文件名、结论…',
              style: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13.5, fontFamily: 'inherit', marginBottom: 8 },
            }),
            units.length === 0
              ? h('div', { style: { padding: '36px 0', color: C.muted, fontSize: 13 } }, '没有匹配的记忆。先点「归纳新回合」，或者换个关键词。')
              : units.map((unit) =>
                h(UnitRow, {
                  key: unit.id,
                  unit,
                  open: openId === unit.id,
                  onToggle: () => setOpenId(openId === unit.id ? '' : unit.id),
                })),
          )
          : h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 22 } },
            h(
              'section',
              { style: { border: `1px solid ${C.line}`, borderRadius: 12, padding: '18px 20px' } },
              h('div', { style: { fontWeight: 600, marginBottom: 12 } }, '再压缩阈值'),
              h(Field, {
                label: '合并多少条才升级为压缩条目',
                value: memory.compactThreshold,
                onChange: (v) => setMemory({ ...memory, compactThreshold: v }),
                suffix: '条',
                hint: '相似度达到下一条阈值的 note 数量；1 表示只要相近就合并。',
              }),
              h(Field, {
                label: '合并后权重下限',
                value: memory.compactWeight,
                onChange: (v) => setMemory({ ...memory, compactWeight: v }),
                suffix: '0–1',
                hint: '权重 = 频次×0.35 + 跨会话×0.25 + 人工×0.2 + 新鲜度×0.2。低于此值的组合仍按普通记忆显示。',
              }),
              h(Field, {
                label: '相似度阈值',
                value: memory.similarity,
                onChange: (v) => setMemory({ ...memory, similarity: v }),
                suffix: '0.2–0.9',
                hint: '两条 note 的 token 重叠占比（含于较短一方）。越高越保守，越低越爱合并。',
              }),
            ),
            h(
              'section',
              { style: { border: `1px solid ${C.line}`, borderRadius: 12, padding: '18px 20px' } },
              h('div', { style: { fontWeight: 600, marginBottom: 12 } }, '上下文压缩阈值（billion-context）'),
              h(Field, {
                label: '增长触发阈值',
                value: context.nudgeGrowthTokens,
                onChange: (v) => setContext({ ...context, nudgeGrowthTokens: v }),
                suffix: 'tokens',
                hint: '一次对话新增多少内容后开始考虑折叠。调小=更早折叠（更省、更早丢细节）。',
              }),
              h(Field, {
                label: '窗口压力阈值',
                value: context.maxContextLimit,
                onChange: (v) => setContext({ ...context, maxContextLimit: v }),
                suffix: '窗口占比',
                hint: '如 60%：上下文用到窗口的 60% 就每轮催促折叠，直到降下来。95% 是紧急层。',
              }),
              h('div', { style: { color: C.muted, fontSize: 11.5, marginTop: 4, wordBreak: 'break-all' } }, `写入 ${context.path || ''}`),
            ),
            h('div', { style: { gridColumn: '1 / -1' } },
              h('button', {
                onClick: save,
                disabled: busy === 'save',
                style: { padding: '9px 20px', borderRadius: 9, border: `1px solid ${C.accent}`, background: C.accent, color: '#fff', cursor: 'pointer', fontSize: 13.5, fontFamily: 'inherit' },
              }, busy === 'save' ? '保存中…' : '保存阈值')),
          ),
        ),
      );
    }

    function MemoryIcon({ size }) {
      return h('span', { style: { fontSize: (size || 18) - 2, lineHeight: 1, display: 'inline-block' } }, '🧠');
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The page itself: `main` + a `sidebar.panellist` entry keyed by the same
        // id is how a plugin owns a full screen instead of a decoration slot.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-memory', inject: () => ({}) }, MemoryPage));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-memory', order: 40, label: '记忆' }, MemoryIcon));
      },
    };
  },
});
