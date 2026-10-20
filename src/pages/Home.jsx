import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart2, Filter, Target, Sparkles, Eye, ChevronRight } from 'lucide-react';
import { useData } from '../context/DataContext';
import { useAppearanceSettings } from '../context/SettingsContext';
import { fetchBatchPrices } from '../utils/api';
import { computePositions } from '../utils/portfolio_analytics';
import { displayTicker } from '../utils/format';
import { Panel, Stat, Empty, BarList, fmtMoney, fmtPct, toneOf } from '../components/research/ResearchUI';
import { InsightCard } from './Insights';
import './Research.css';

const SHORTCUTS = [
  { to: '/analytics', icon: BarChart2, label: 'X-ray', sub: 'What you really own' },
  { to: '/screener', icon: Filter, label: 'Screener', sub: 'Find candidates' },
  { to: '/planner', icon: Target, label: 'Planner', sub: "This month's buys" },
  { to: '/insights', icon: Sparkles, label: 'Insights', sub: "Claude's analyses" }
];

export default function Home() {
  const { transactions, livePrices, exchangeRates, fxSeries, insights, research } = useData();
  const { baseCurrency } = useAppearanceSettings();
  const currency = baseCurrency === 'PKR' ? 'PKR' : 'USD';
  const fxRate = exchangeRates?.PKR || 278;
  const p = useMemo(() => computePositions(transactions, livePrices, { displayCurrency: currency, fxRate, fxSeries }), [transactions, livePrices, currency, fxRate, fxSeries]);

  // Today's move: each holding's value times its daily change.
  const day = p.holdings.reduce((a, h) => (h.dayChangePct != null ? a + (h.marketValue - h.marketValue / (1 + h.dayChangePct)) : a), 0);
  const dayPct = p.totals.marketValue > 0 ? day / (p.totals.marketValue - day) : null;

  const watch = research.filter((r) => r.kind === 'watch');
  const watchKey = watch.map((w) => w.symbol).sort().join(',');
  const [watchQuotes, setWatchQuotes] = useState({});
  useEffect(() => {
    if (watchKey) fetchBatchPrices(watchKey.split(',')).then(setWatchQuotes);
  }, [watchKey]);
  const movers = watch
    .map((w) => ({ symbol: w.symbol, q: watchQuotes[w.symbol] }))
    .filter((m) => m.q)
    .sort((a, b) => Math.abs(b.q.changePercent) - Math.abs(a.q.changePercent))
    .slice(0, 5);

  const latest = insights[0];

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Overview</h1>
          <p className="rs-subtitle">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
      </div>

      {p.holdings.length === 0 ? (
        <Panel>
          <Empty title="No holdings yet">Add a transaction or import from KTrade, IBKR or CSV in Settings.</Empty>
        </Panel>
      ) : (
        <div className="rs-stats">
          <Stat label="Portfolio" value={fmtMoney(p.totals.marketValue, currency, { compact: true })} sub={`${p.holdings.length} positions`} />
          <Stat label="Today" value={fmtMoney(day, currency, { compact: true })} sub={fmtPct(dayPct, { signed: true, digits: 2 })} tone={toneOf(day)} />
          <Stat label="Unrealised" value={fmtMoney(p.totals.unrealized, currency, { compact: true })} sub={fmtPct(p.totals.unrealizedPct, { signed: true })} tone={toneOf(p.totals.unrealized)} />
          <Stat label="Income received" value={fmtMoney(p.totals.dividends - p.totals.taxes, currency, { compact: true })} sub="dividends, net of tax" />
        </div>
      )}

      <div className="rs-stats">
        {SHORTCUTS.map((s) => (
          <Link key={s.to} to={s.to} className="rs-stat rs-link" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <s.icon size={20} style={{ color: 'var(--accent-color)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="rs-sym" style={{ display: 'block' }}>{s.label}</span>
              <span className="rs-name">{s.sub}</span>
            </span>
            <ChevronRight size={16} className="rs-muted" />
          </Link>
        ))}
      </div>

      <div className="rs-grid-2">
        <Panel title="Largest holdings" action={<Link to="/analytics" className="rs-btn">Full X-ray</Link>}>
          {p.holdings.length ? (
            <BarList
              rows={p.holdings.map((h) => ({ key: h.ticker, label: `${displayTicker(h.ticker)} · ${h.name}`, weight: h.weight }))}
              limit={8}
            />
          ) : (
            <Empty>Nothing held yet.</Empty>
          )}
        </Panel>

        <Panel title="Watchlist movers" action={<Link to="/watchlist" className="rs-btn"><Eye size={14} /> Watchlist</Link>}>
          {movers.length ? (
            <div className="rs-bars">
              {movers.map((m) => (
                <Link key={m.symbol} to={`/research/${encodeURIComponent(m.symbol)}`} className="rs-bar-row rs-link" style={{ gridTemplateColumns: '1fr auto auto' }}>
                  <span>
                    <span className="rs-sym">{displayTicker(m.symbol)}</span> <span className="rs-name" style={{ display: 'inline' }}>{m.q.name}</span>
                  </span>
                  <span className="rs-bar-value">{fmtMoney(m.q.price, m.q.currency)}</span>
                  <span className={`rs-bar-value ${toneOf(m.q.changePercent)}`}>{fmtPct(m.q.changePercent / 100, { signed: true, digits: 2 })}</span>
                </Link>
              ))}
            </div>
          ) : (
            <Empty>{watch.length ? 'Loading prices…' : 'Nothing on the watchlist yet.'}</Empty>
          )}
        </Panel>
      </div>

      <Panel title="Latest from Claude" action={insights.length > 1 ? <Link to="/insights" className="rs-btn">All {insights.length}</Link> : null}>
        {latest ? (
          <InsightCard insight={latest} />
        ) : (
          <Empty>
            No analyses yet. In Claude Code, ask <em>“review my portfolio”</em> and the result lands here.
          </Empty>
        )}
      </Panel>
    </div>
  );
}
