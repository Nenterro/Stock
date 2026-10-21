import { useEffect, useState } from 'react';
import { ExternalLink, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { fetchNews, fetchNewsBrief, fetchNewsRisks } from '../../utils/api';
import { Panel, Empty, Skeleton, Tag, Segmented } from './ResearchUI';

const SEVERITY_TONE = { 5: 'critical', 4: 'serious', 3: 'warning' };
const SEVERITY_LABEL = { 1: 'Minor', 2: 'Sector', 3: 'Market', 4: 'Major', 5: 'Systemic' };
const DIRECTION = {
  rising: { Icon: TrendingUp, label: 'Rising' },
  stable: { Icon: Minus, label: 'Stable' },
  easing: { Icon: TrendingDown, label: 'Easing' }
};

function ago(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (h < 1) return 'just now';
  if (h < 24) return `${Math.round(h)}h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const fmtDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function ArticleRow({ a }) {
  return (
    <a href={a.url} target="_blank" rel="noopener noreferrer" className="rs-link rs-row" style={{ fontSize: 13, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
      <ExternalLink size={13} style={{ flexShrink: 0, marginTop: 3, color: 'var(--text-muted)' }} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>
        <span className="rs-secondary">{a.title}</span>
        {a.note && <span className="rs-name" style={{ display: 'block', maxWidth: 'none', color: 'var(--text-secondary)' }}>{a.note}</span>}
        <span className="rs-name" style={{ display: 'block', maxWidth: 'none' }}>
          {a.source}
          {a.paywalled ? ' (paywalled)' : ''} · {ago(a.published)}
          {a.importance >= 3 ? ' · high importance' : ''}
        </span>
      </span>
    </a>
  );
}

export function RiskCard({ r }) {
  const d = DIRECTION[r.direction] || DIRECTION.stable;
  return (
    <div className="rs-panel" style={{ padding: '12px 14px', marginBottom: 8, background: 'rgba(255,255,255,0.025)' }}>
      <div className="rs-row" style={{ justifyContent: 'space-between' }}>
        <span className="rs-panel-title" style={{ fontSize: 14 }}>{r.title}</span>
        <span className="rs-row">
          <Tag tone={SEVERITY_TONE[r.severity] || 'info'} title="Potential damage if it plays out badly, 1 to 5">
            {r.severity} · {SEVERITY_LABEL[r.severity]}
          </Tag>
          <Tag>
            <d.Icon size={11} aria-hidden="true" /> {d.label}
          </Tag>
        </span>
      </div>
      <p className="rs-panel-sub" style={{ marginTop: 6, color: 'var(--text-secondary)' }}>{r.summary}</p>
      {r.watch && (
        <p className="rs-name" style={{ marginTop: 4, maxWidth: 'none' }}>
          <strong>Watch:</strong> {r.watch}
        </p>
      )}
      <p className="rs-name" style={{ marginTop: 4, maxWidth: 'none' }}>
        {[...(r.markets || []), ...(r.symbols || [])].join(' · ')} · since {r.firstSeen}
        {r.history?.length > 1 ? ` · last change ${r.history[r.history.length - 1].date}: ${r.history[r.history.length - 1].change}` : ''}
      </p>
    </div>
  );
}

/** Daily brief + risk register (Insights page). */
export function NewsBrief() {
  const [brief, setBrief] = useState(undefined);
  const [risks, setRisks] = useState(null);
  const [date, setDate] = useState(null);
  const [view, setView] = useState('brief');

  useEffect(() => {
    let live = true;
    fetchNewsBrief(date || undefined)
      .catch(() => null)
      .then((b) => live && setBrief(b));
    return () => {
      live = false;
    };
  }, [date]);
  useEffect(() => {
    fetchNewsRisks()
      .catch(() => null)
      .then(setRisks);
  }, []);

  if (brief === undefined) return <Panel><Skeleton lines={6} /></Panel>;
  if (!brief) {
    return (
      <Panel>
        <Empty title="No news brief yet">Claude writes one each night at 02:30 from the day's Pakistani and global news.</Empty>
      </Panel>
    );
  }
  const byId = Object.fromEntries((brief.articles || []).map((a) => [a.id, a]));
  const dates = brief.otherDates || [];

  return (
    <>
      <Panel
        title={brief.headline}
        subtitle={`${fmtDate(brief.date)} · from ${brief.articleCount} articles, ${brief.importantCount} important`}
        action={<Segmented label="View" options={[{ value: 'brief', label: 'Brief' }, { value: 'risks', label: `Risks${risks ? ` (${risks.count})` : ''}` }]} value={view} onChange={setView} />}
      >
        {view === 'brief' ? (
          <>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 14px' }}>{brief.summary}</p>
            {brief.portfolio && (
              <div className="rs-notice" role="note" style={{ marginBottom: 14 }}>
                <div>
                  <strong>For your portfolio:</strong> {brief.portfolio}
                </div>
              </div>
            )}
            {brief.sections.map((s) => (
              <section key={s.title} style={{ marginBottom: 14 }}>
                <h3 className="rs-panel-title" style={{ fontSize: 14, margin: '0 0 6px' }}>{s.title}</h3>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {s.points.map((p, i) => (
                    <li key={i} style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
                      {p.text}{' '}
                      {p.articles.map((id, k) =>
                        byId[id] ? (
                          <a key={id} href={byId[id].url} target="_blank" rel="noopener noreferrer" className="rs-link" title={`${byId[id].source}: ${byId[id].title}`} style={{ fontSize: 11 }}>
                            [{k + 1}]
                          </a>
                        ) : null
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {dates.length > 1 && (
              <div className="rs-row" style={{ marginTop: 6 }}>
                <label className="rs-name" htmlFor="brief-date">Earlier briefs</label>
                <select id="brief-date" className="rs-select" value={brief.date} onChange={(e) => setDate(e.target.value)}>
                  {dates.map((d) => (
                    <option key={d} value={d}>{fmtDate(d)}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        ) : risks?.risks?.length ? (
          risks.risks.map((r) => <RiskCard key={r.id} r={r} />)
        ) : (
          <Empty>No open risks.</Empty>
        )}
      </Panel>
    </>
  );
}

/** News tagged with one symbol, plus the open risks naming it (research page). */
export function SymbolNews({ symbol }) {
  const [news, setNews] = useState(null);
  const [risks, setRisks] = useState(null);

  useEffect(() => {
    let live = true;
    setNews(null);
    Promise.all([fetchNews({ symbol, days: 30, limit: 12 }).catch(() => null), fetchNewsRisks({ symbol }).catch(() => null)]).then(([n, r]) => {
      if (!live) return;
      setNews(n);
      setRisks(r);
    });
    return () => {
      live = false;
    };
  }, [symbol]);

  if (!news) return null;
  const articles = news.articles || [];
  const open = risks?.risks || [];
  if (!articles.length && !open.length) return null;
  return (
    <Panel title="In the news" subtitle="Last 30 days, tagged by Claude's nightly digest">
      {open.map((r) => <RiskCard key={r.id} r={r} />)}
      <div className="rs-bars">
        {articles.map((a) => <ArticleRow key={a.id} a={a} />)}
      </div>
    </Panel>
  );
}
