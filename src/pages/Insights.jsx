import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Trash2, Sparkles } from 'lucide-react';
import { useData } from '../context/DataContext';
import { displayTicker } from '../utils/format';
import { Panel, Empty, Tag, Markdown, Segmented } from '../components/research/ResearchUI';
import './Research.css';

const KIND_LABEL = {
  'portfolio-review': 'Portfolio review',
  'stock-analysis': 'Stock analysis',
  'rebalance-plan': 'Rebalance plan',
  'contribution-plan': 'Contribution plan',
  screen: 'Screen',
  market: 'Market',
  note: 'Note'
};

const VERDICT_TONE = { buy: 'good', add: 'good', hold: 'info', watch: 'info', trim: 'warning', sell: 'serious', avoid: 'critical' };

function when(i) {
  const d = i.meta?.savedAt || i.updatedAt;
  return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

export function InsightCard({ insight, defaultOpen = false, onDelete }) {
  const [open, setOpen] = useState(defaultOpen);
  const m = insight.meta || {};
  return (
    <article className="rs-panel" style={{ padding: '14px 16px', marginBottom: 10, background: 'rgba(255,255,255,0.025)' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 10, width: '100%', alignItems: 'flex-start' }}
      >
        {open ? <ChevronDown size={16} style={{ marginTop: 3, flexShrink: 0 }} /> : <ChevronRight size={16} style={{ marginTop: 3, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rs-row">
            <span className="rs-panel-title">{insight.title}</span>
            {m.verdict && m.verdict !== 'n/a' && <Tag tone={VERDICT_TONE[m.verdict]}>{m.verdict}</Tag>}
            {m.confidence && <Tag>{m.confidence} confidence</Tag>}
          </div>
          {m.summary && <p className="rs-panel-sub" style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{m.summary}</p>}
          <p className="rs-name" style={{ marginTop: 4, maxWidth: 'none' }}>
            {KIND_LABEL[insight.kind] || insight.kind} · {when(insight)}
            {m.dataAsOf ? ` · data as of ${m.dataAsOf}` : ''} · {insight.author || 'Claude'}
          </p>
        </div>
      </button>
      {open && (
        <div style={{ marginTop: 12, paddingLeft: 26 }}>
          {insight.symbols?.length > 0 && (
            <div className="rs-row" style={{ marginBottom: 10 }}>
              {insight.symbols.map((s) => (
                <Link key={s} to={`/research/${encodeURIComponent(s)}`} className="rs-tag" style={{ textDecoration: 'none' }}>
                  {displayTicker(s)}
                </Link>
              ))}
            </div>
          )}
          <Markdown>{insight.body}</Markdown>
          {onDelete && (
            <button type="button" className="rs-btn danger" style={{ marginTop: 8 }} onClick={() => window.confirm(`Delete "${insight.title}"?`) && onDelete(insight.id)}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function Insights() {
  const { insights, deleteInsight } = useData();
  const [kind, setKind] = useState('all');
  const kinds = ['all', ...new Set(insights.map((i) => i.kind))];
  const shown = kind === 'all' ? insights : insights.filter((i) => i.kind === kind);

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Insights</h1>
          <p className="rs-subtitle">Analyses Claude has written about your portfolio and the stocks you follow</p>
        </div>
        {kinds.length > 2 && (
          <Segmented label="Filter by kind" options={kinds.map((k) => ({ value: k, label: k === 'all' ? 'All' : KIND_LABEL[k] || k }))} value={kind} onChange={setKind} />
        )}
      </div>

      {shown.length === 0 ? (
        <Panel>
          <Empty title="No insights yet">
            <Sparkles size={22} style={{ color: 'var(--accent-color)', margin: '8px 0' }} />
            <br />
            Open Claude Code in this project and ask, for example, <em>“review my portfolio”</em> or <em>“do a deep-dive on LUCK”</em>.
            <br />
            Claude reads your data through the stock-tracker tools and saves its analysis here.
          </Empty>
        </Panel>
      ) : (
        shown.map((i, idx) => <InsightCard key={i.id} insight={i} defaultOpen={idx === 0} onDelete={deleteInsight} />)
      )}
    </div>
  );
}
