import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { ArrowLeft, Eye, EyeOff, FileText } from 'lucide-react';
import { useData } from '../context/DataContext';
import { fetchFundamentals, fetchTechnicals, fetchFundHoldings, fetchHistoricalPrices } from '../utils/api';
import { computePositions, computeLookThrough, companyKey } from '../utils/portfolio_analytics';
import { useMarketResearch } from '../hooks/useMarketResearch';
import { displayTicker } from '../utils/format';
import {
  Panel,
  Stat,
  Segmented,
  BarList,
  Notice,
  Empty,
  Skeleton,
  Tag,
  Sources,
  ChartTooltip,
  fmtMoney,
  fmtPct,
  fmtNum,
  fmtBig,
  toneOf
} from '../components/research/ResearchUI';
import { InsightCard } from './Insights';
import './Research.css';

const SIGNAL_TONE = {
  overbought: 'warning',
  oversold: 'warning',
  'golden-cross': 'good',
  'death-cross': 'critical',
  bullish: 'good',
  bearish: 'serious',
  'bullish-crossover': 'good',
  'bearish-crossover': 'serious',
  above: 'good',
  below: 'serious',
  'near-high': 'good',
  'near-low': 'serious',
  surging: 'info',
  'drying-up': 'info',
  neutral: 'info',
  'mid-range': 'info'
};

function sma(points, n) {
  const out = new Array(points.length).fill(null);
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i].price;
    if (i >= n) sum -= points[i - n].price;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export default function StockResearch() {
  const { symbol: raw } = useParams();
  const navigate = useNavigate();
  const symbol = decodeURIComponent(raw || '').toUpperCase();
  const { transactions, livePrices, exchangeRates, fxSeries, research, saveResearch, removeResearch, insights } = useData();
  const [fund, setFund] = useState(null);
  const [tech, setTech] = useState(null);
  const [holdings, setHoldings] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('1Y');
  const [noteDraft, setNoteDraft] = useState(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setFund(null);
    setTech(null);
    setHoldings(null);
    setHistory(null);
    Promise.all([
      fetchFundamentals(symbol).catch(() => null),
      fetchTechnicals(symbol).catch(() => null),
      fetchFundHoldings(symbol).catch(() => null),
      fetchHistoricalPrices(symbol, '5y').catch(() => null)
    ]).then(([f, t, h, hist]) => {
      if (!live) return;
      setFund(f);
      setTech(t);
      setHoldings(h);
      setHistory(hist);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [symbol]);

  const watch = research.find((r) => r.kind === 'watch' && r.symbol === symbol);
  const note = research.find((r) => r.kind === 'note' && r.symbol === symbol);
  const related = insights.filter((i) => (i.symbols || []).includes(symbol));

  // My exposure: the direct position plus whatever the held funds contain.
  // Same hook and arguments as the Analytics page, so its cache is shared.
  const heldTickers = useMemo(
    () => [...new Set((transactions || []).map((t) => String(t.ticker || t.asset || '').toUpperCase()).filter((t) => t && t !== 'CASH'))],
    [transactions]
  );
  const market = useMarketResearch(heldTickers);
  const position = useMemo(() => {
    const p = computePositions(transactions, livePrices, { displayCurrency: 'USD', fxRate: exchangeRates?.PKR || 278, fxSeries });
    const direct = p.holdings.find((h) => h.ticker === symbol);
    const lt = computeLookThrough(p.holdings, market.fundHoldings, market.fundamentals);
    const c = lt.companies.find((x) => x.key === companyKey(symbol));
    return { direct, viaFunds: c ? c.indirect : 0, viaFundsBy: c?.viaFunds || {}, total: lt.total || p.totals.marketValue };
  }, [transactions, livePrices, exchangeRates, fxSeries, symbol, market.fundHoldings, market.fundamentals]);

  const chart = useMemo(() => {
    const pts = history?.history || [];
    if (pts.length < 2) return [];
    const s50 = sma(pts, 50);
    const s200 = sma(pts, 200);
    const end = pts[pts.length - 1].date;
    const days = { '3M': 92, '1Y': 365, '5Y': 1830 }[range];
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
    const rows = pts.map((p, i) => ({ date: p.date, Price: p.price, 'SMA 50': s50[i], 'SMA 200': s200[i] })).filter((r) => r.date >= start);
    const step = Math.max(1, Math.floor(rows.length / 300));
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  }, [history, range]);

  const quote = livePrices[symbol];
  const ccy = fund?.currency || history?.currency || quote?.currency || 'USD';
  const price = fund?.valuation?.price ?? tech?.price ?? quote?.price;
  const isFund = fund?.kind === 'etf' || Boolean(holdings);
  const v = fund?.valuation || {};
  const pr = fund?.profitability || {};
  const g = fund?.growth || {};
  const hl = fund?.health || {};

  const toggleWatch = async () => {
    if (watch) await removeResearch(watch.id);
    else await saveResearch('watch', symbol, { addedBy: 'me', addedAt: new Date().toISOString() });
  };

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div className="rs-row">
          <button type="button" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/watchlist'))} className="glass-icon-btn" aria-label="Back" style={{ width: 38, height: 38, borderRadius: 12 }}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="rs-title">
              {displayTicker(symbol)}{' '}
              <span className="rs-secondary" style={{ fontSize: 15, fontWeight: 500 }}>
                {fund?.name || quote?.name || ''}
              </span>
            </h1>
            <p className="rs-subtitle">
              {[fund?.exchange, fund?.profile?.industry, fund?.profile?.country].filter(Boolean).join(' · ')}
              {fund?.profile?.isShariah === true && ' · '}
              {fund?.profile?.isShariah === true && <Tag tone="good">Shariah</Tag>}
            </p>
          </div>
        </div>
        <button type="button" className={`rs-btn ${watch ? '' : 'primary'}`} onClick={toggleWatch}>
          {watch ? <EyeOff size={15} /> : <Eye size={15} />}
          {watch ? 'Remove from watchlist' : 'Add to watchlist'}
        </button>
      </div>

      <div className="rs-stats">
        <Stat
          label="Price"
          value={fmtMoney(price, ccy)}
          sub={quote?.changePercent != null ? <span className={toneOf(quote.changePercent)}>{fmtPct(quote.changePercent / 100, { signed: true, digits: 2 })} today</span> : null}
        />
        <Stat label="1Y return" value={fmtPct(tech?.returns?.['1y'], { signed: true })} tone={toneOf(tech?.returns?.['1y'])} sub={tech ? `${fmtPct(tech.range52w.fromHigh)} from 52w high` : null} />
        {!isFund && <Stat label="P/E (TTM)" value={fmtNum(v.peTTM, 1)} sub={v.forwardPE ? `forward ${fmtNum(v.forwardPE, 1)}` : null} />}
        {isFund && <Stat label="Expense ratio" value={fmtPct(holdings?.expenseRatio ?? fund?.fund?.expenseRatio, { digits: 2 })} sub={holdings?.expenseRatioSource || fund?.fund?.expenseRatioSource} />}
        <Stat label="Trend" value={tech?.trend || '—'} sub={tech?.rsi14 != null ? `RSI ${fmtNum(tech.rsi14, 0)}` : null} />
        <Stat
          label="Your exposure"
          value={fmtPct(((position.direct?.marketValue || 0) + position.viaFunds) / (position.total || 1))}
          sub={
            position.direct
              ? `${fmtNum(position.direct.shares, 0)} shares, ${fmtPct(position.direct.unrealizedPct, { signed: true })}${position.viaFunds ? ' + via funds' : ''}`
              : position.viaFunds
                ? `via ${Object.keys(position.viaFundsBy).map(displayTicker).join(', ')}`
                : 'not held'
          }
        />
      </div>

      {loading && <Panel><Skeleton lines={6} /></Panel>}
      {!loading && !fund && !tech && <Notice>No data found for {symbol}. Check the ticker, or the backend may be unreachable.</Notice>}

      {chart.length > 1 && (
        <Panel title="Price" subtitle={`${ccy} closes with 50- and 200-day averages`} action={<Segmented label="Range" options={['3M', '1Y', '5Y']} value={range} onChange={setRange} />}>
          <div className="rs-chart" role="img" aria-label={`${symbol} price history`}>
            <ResponsiveContainer>
              <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={48} tickFormatter={(d) => (range === '3M' ? d.slice(5) : d.slice(2, 7))} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} domain={['auto', 'auto']} width={52} />
                <Tooltip content={<ChartTooltip formatter={(val) => fmtMoney(val, ccy)} />} cursor={{ stroke: 'rgba(255,255,255,0.2)' }} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} iconType="plainline" />
                <Line type="monotone" dataKey="Price" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="SMA 50" stroke="var(--series-2)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                <Line type="monotone" dataKey="SMA 200" stroke="var(--series-3)" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      <div className="rs-grid-2">
        {tech && (
          <Panel title="Technicals" subtitle={`As of ${tech.asOf}; beta and correlation vs ${tech.risk?.benchmark === '^GSPC' ? 'S&P 500' : tech.risk?.benchmark}`}>
            <div className="rs-row" style={{ marginBottom: 14 }}>
              {tech.signals.map((s) => (
                <Tag key={s.name} tone={SIGNAL_TONE[s.state] || 'info'} title={s.detail}>
                  {s.name}: {s.state.replace(/-/g, ' ')}
                </Tag>
              ))}
            </div>
            <div className="rs-kv">
              <div><dt>RSI (14)</dt><dd>{fmtNum(tech.rsi14, 1)}</dd></div>
              <div><dt>vs SMA 200</dt><dd>{tech.sma?.[200] ? fmtPct(tech.price / tech.sma[200] - 1, { signed: true }) : '—'}</dd></div>
              <div><dt>3M / 6M</dt><dd>{fmtPct(tech.returns['3m'], { signed: true })} / {fmtPct(tech.returns['6m'], { signed: true })}</dd></div>
              <div><dt>3Y a year</dt><dd>{fmtPct(tech.returns['3yAnnualised'], { signed: true })}</dd></div>
              <div><dt>Volatility</dt><dd>{fmtPct(tech.risk.volatility1y)}</dd></div>
              <div><dt>Max drawdown 1Y</dt><dd>{fmtPct(tech.risk.maxDrawdown1y)}</dd></div>
              <div><dt>Beta</dt><dd>{fmtNum(tech.risk.beta)}</dd></div>
              <div><dt>Correlation</dt><dd>{fmtNum(tech.risk.correlation)}</dd></div>
            </div>
          </Panel>
        )}

        {fund && !isFund && (
          <Panel title="Fundamentals" subtitle={fund.override ? `Includes manual figures (${fund.override.source})` : null}>
            <div className="rs-kv">
              <div><dt>Market cap</dt><dd>{fmtBig(v.marketCap)}</dd></div>
              <div><dt>P/B</dt><dd>{fmtNum(v.priceToBook, 1)}</dd></div>
              <div><dt>PEG</dt><dd>{fmtNum(v.peg)}</dd></div>
              <div><dt>Dividend yield</dt><dd>{fmtPct(v.dividendYield, { digits: 2 })}</dd></div>
              <div><dt>Net margin</dt><dd>{fmtPct(pr.netMargin)}</dd></div>
              <div><dt>Gross margin</dt><dd>{fmtPct(pr.grossMargin)}</dd></div>
              <div><dt>ROE</dt><dd>{fmtPct(pr.roe)}</dd></div>
              <div><dt>Revenue growth</dt><dd className={toneOf(g.revenueGrowthYoY)}>{fmtPct(g.revenueGrowthYoY, { signed: true })}</dd></div>
              <div><dt>EPS growth</dt><dd className={toneOf(g.epsGrowthYoY ?? g.earningsGrowthYoY)}>{fmtPct(g.epsGrowthYoY ?? g.earningsGrowthYoY, { signed: true })}</dd></div>
              <div><dt>Debt / equity</dt><dd>{fmtNum(hl.debtToEquity)}</dd></div>
              {fund.ownership?.freeFloat != null && <div><dt>Free float</dt><dd>{fmtPct(fund.ownership.freeFloat, { digits: 0 })}</dd></div>}
              {fund.analyst?.targetMean != null && (
                <div><dt>Analyst target</dt><dd>{fmtMoney(fund.analyst.targetMean, ccy)} ({fund.analyst.recommendation})</dd></div>
              )}
              {fund.events?.nextEarnings && <div><dt>Next earnings</dt><dd>{fund.events.nextEarnings}</dd></div>}
            </div>
            {fund.gaps?.map((gap) => (
              <p key={gap} className="rs-panel-sub" style={{ marginTop: 10 }}>{gap}</p>
            ))}
            <Sources sources={fund.sources} asOf={fund.asOf} />
          </Panel>
        )}

        {isFund && holdings && (
          <Panel title="Top holdings" subtitle={`${fmtPct(holdings.coverage, { digits: 0 })} of the fund listed${holdings.holdingsCount ? ` · ${holdings.holdingsCount} holdings in total` : ''}`}>
            <BarList rows={[...holdings.holdings].sort((a, b) => b.weight - a.weight).map((h) => ({ key: h.isin || h.ticker || h.name, label: `${h.ticker ? displayTicker(h.ticker) + ' · ' : ''}${h.name}`, weight: h.weight }))} limit={15} />
            {holdings.notes?.map((n) => (
              <p key={n} className="rs-panel-sub" style={{ marginTop: 10 }}>{n}</p>
            ))}
            <Sources sources={holdings.sources} asOf={holdings.asOf} />
          </Panel>
        )}
      </div>

      {isFund && holdings && (
        <div className="rs-grid-2">
          <Panel title="Sectors" subtitle={holdings.sectorBasis === 'fund' ? 'Whole fund' : 'From the listed holdings only'}>
            <BarList rows={holdings.sectors.map((s) => ({ key: s.sector || s.label, label: s.sector || s.label, weight: s.weight }))} />
          </Panel>
          <Panel title="Countries" subtitle={holdings.countryBasis === 'fund' ? 'Whole fund' : 'From the listed holdings only'}>
            <BarList rows={holdings.countries.map((s) => ({ key: s.country, label: s.country, weight: s.weight }))} color="var(--series-3)" />
          </Panel>
        </div>
      )}

      {fund?.annual?.length > 0 && <ResultsPanel fund={fund} ccy={ccy} />}

      <div className="rs-grid-2">
        <Panel title="Notes" subtitle={note?.data?.author === 'Claude' ? 'Written by Claude' : null}>
          {noteDraft == null ? (
            <>
              {note?.data?.text ? <p className="rs-md" style={{ whiteSpace: 'pre-wrap' }}>{note.data.text}</p> : <Empty>No note yet.</Empty>}
              {watch?.data?.thesis && <p className="rs-panel-sub" style={{ marginTop: 8 }}>Watchlist thesis: {watch.data.thesis}</p>}
              <button type="button" className="rs-btn" style={{ marginTop: 10 }} onClick={() => setNoteDraft(note?.data?.text || '')}>
                {note ? 'Edit note' : 'Add note'}
              </button>
            </>
          ) : (
            <>
              <textarea className="rs-input" style={{ width: '100%', minHeight: 120, resize: 'vertical' }} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} aria-label="Note" />
              <div className="rs-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="rs-btn primary"
                  onClick={async () => {
                    if (noteDraft.trim()) await saveResearch('note', symbol, { text: noteDraft, author: 'me' });
                    else if (note) await removeResearch(note.id);
                    setNoteDraft(null);
                  }}
                >
                  Save
                </button>
                <button type="button" className="rs-btn" onClick={() => setNoteDraft(null)}>Cancel</button>
              </div>
            </>
          )}
        </Panel>

        {fund?.announcements?.length > 0 && (
          <Panel title="Announcements" subtitle="From the exchange">
            <div className="rs-bars">
              {fund.announcements.slice(0, 8).map((a) => (
                <a key={a.url || a.title} href={a.url} target="_blank" rel="noopener noreferrer" className="rs-link rs-row" style={{ fontSize: 13, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <FileText size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--text-muted)' }} />
                  <span>
                    <span className="rs-secondary">{a.title}</span>
                    <span className="rs-name" style={{ display: 'block' }}>{a.date} · {a.category}</span>
                  </span>
                </a>
              ))}
            </div>
          </Panel>
        )}
      </div>

      <Panel title="Claude's analyses" subtitle={related.length ? null : 'Ask Claude for a deep-dive on this symbol and it will appear here.'}>
        {related.length ? related.map((i) => <InsightCard key={i.id} insight={i} />) : <Empty>No analyses yet.</Empty>}
      </Panel>

      {fund?.profile?.description && (
        <Panel title="About">
          <p className="rs-md">{fund.profile.description}</p>
          {fund.profile.website && (
            <p className="rs-sources">
              <a href={fund.profile.website} target="_blank" rel="noopener noreferrer">{fund.profile.website}</a>
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}

function ResultsPanel({ fund, ccy }) {
  const [view, setView] = useState('Annual');
  const rows = view === 'Annual' ? fund.annual : fund.quarterly;
  const has = (k) => rows.some((r) => r[k] != null);
  return (
    <Panel title="Results" subtitle={`${ccy}${fund.exchange === 'PSX' ? '' : ' · fiscal periods as reported'}`} action={fund.quarterly?.length ? <Segmented label="Period" options={['Annual', 'Quarterly']} value={view} onChange={setView} /> : null}>
      <div className="rs-table-wrap">
        <table className="rs-table">
          <thead>
            <tr>
              <th>Period</th>
              {has('revenue') && <th className="num">Revenue</th>}
              {has('netIncome') && <th className="num">Net income</th>}
              {has('eps') && <th className="num">EPS</th>}
              {has('grossMargin') && <th className="num">Gross margin</th>}
              {has('netMargin') && <th className="num">Net margin</th>}
              {has('epsGrowth') && <th className="num">EPS growth</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.period}>
                <td>{r.period}</td>
                {has('revenue') && <td className="num">{fmtBig(r.revenue)}</td>}
                {has('netIncome') && <td className={`num ${toneOf(r.netIncome)}`}>{fmtBig(r.netIncome)}</td>}
                {has('eps') && <td className="num">{fmtNum(r.eps)}</td>}
                {has('grossMargin') && <td className="num">{fmtPct(r.grossMargin)}</td>}
                {has('netMargin') && <td className="num">{fmtPct(r.netMargin)}</td>}
                {has('epsGrowth') && <td className={`num ${toneOf(r.epsGrowth)}`}>{fmtPct(r.epsGrowth, { signed: true })}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
