import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useData } from '../context/DataContext';
import { useAppearanceSettings } from '../context/SettingsContext';
import { useMarketResearch } from '../hooks/useMarketResearch';
import { buildXray, benchmarkInCurrency, BENCHMARKS } from '../utils/portfolio_analytics';
import { generatePortfolioTimeSeries } from '../utils/portfolio_math';
import { displayTicker } from '../utils/format';
import {
  Panel,
  Stat,
  Segmented,
  BarList,
  SplitBars,
  Notice,
  Empty,
  Skeleton,
  Tag,
  SymbolLink,
  ChartTooltip,
  divergingColor,
  fmtMoney,
  fmtPct,
  fmtNum,
  toneOf
} from '../components/research/ResearchUI';
import './Research.css';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-7)'];

export default function Analytics() {
  const { transactions, livePrices, historicalPrices, fxSeries, exchangeRates, research, historyLoading } = useData();
  const { baseCurrency } = useAppearanceSettings();
  const [currency, setCurrency] = useState(baseCurrency === 'PKR' ? 'PKR' : 'USD');
  const [range, setRange] = useState('1Y');
  const navigate = useNavigate();

  const tickers = useMemo(
    () => [...new Set((transactions || []).map((t) => String(t.ticker || t.asset || '').toUpperCase()).filter((t) => t && t !== 'CASH'))],
    [transactions]
  );
  const market = useMarketResearch(tickers);
  const settings = research.find((r) => r.kind === 'settings')?.data || {};
  const fxRate = exchangeRates?.PKR || 278;

  const series = useMemo(
    () => generatePortfolioTimeSeries(transactions, livePrices, historicalPrices, currency, fxRate, fxSeries),
    [transactions, livePrices, historicalPrices, currency, fxRate, fxSeries]
  );

  const x = useMemo(() => {
    if (!transactions?.length) return null;
    return buildXray({
      transactions,
      livePrices,
      historicalPrices,
      fxSeries,
      fxRate,
      displayCurrency: currency,
      fundHoldings: market.fundHoldings,
      fundamentals: market.fundamentals,
      benchmarkHistory: market.benchmarkHistory,
      riskFreeRate: typeof settings.riskFreeRate?.[currency] === 'number' ? settings.riskFreeRate[currency] : undefined,
      series
    });
  }, [transactions, livePrices, historicalPrices, fxSeries, fxRate, currency, market.fundHoldings, market.fundamentals, market.benchmarkHistory, settings.riskFreeRate, series]);

  // Portfolio TWR vs benchmarks, each rebased to 100 at the window start and
  // valued in the display currency at historical FX.
  const chart = useMemo(() => {
    if (!series.length) return [];
    const end = series[series.length - 1].date;
    const start = range === '1Y' ? new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10) : series[0].date;
    const pts = series.filter((p) => p.date >= start && p.twrFactor > 0);
    if (pts.length < 2) return [];
    const base = pts[0].twrFactor;
    const benches = BENCHMARKS.map((b) => {
      const h = market.benchmarkHistory[b.symbol];
      if (!h) return null;
      const conv = benchmarkInCurrency(h, b.currency, currency, fxSeries, fxRate).filter((p) => p.date >= start);
      return conv.length ? { ...b, map: new Map(conv.map((p) => [p.date, p.price])), first: conv[0].price } : null;
    }).filter(Boolean);
    const last = {};
    const step = Math.max(1, Math.floor(pts.length / 260));
    return pts
      .filter((_, i) => i % step === 0 || i === pts.length - 1)
      .map((p) => {
        const row = { date: p.date, Portfolio: (p.twrFactor / base) * 100 };
        for (const b of benches) {
          const v = b.map.get(p.date) ?? last[b.symbol];
          if (v != null) {
            last[b.symbol] = v;
            row[b.name] = (v / b.first) * 100;
          }
        }
        return row;
      });
  }, [series, range, market.benchmarkHistory, currency, fxSeries, fxRate]);

  if (!transactions?.length) {
    return (
      <div className="rs-page">
        <h1 className="rs-title">Portfolio X-ray</h1>
        <Panel>
          <Empty title="No transactions yet">Add or import trades and the X-ray will break your portfolio down here.</Empty>
        </Panel>
      </div>
    );
  }

  const lt = x?.lookThrough;
  const r1 = x?.risk?.oneYear;
  const rAll = x?.risk?.sinceInception;
  // Until fundamentals and fund compositions arrive, a look-through would
  // report every fund as a company and every sector as Unknown.
  const loadingResearch = market.loading && !Object.keys(market.fundamentals).length;
  const ready = !loadingResearch;
  const benchNames = BENCHMARKS.map((b) => b.name).filter((n) => chart.some((r) => r[n] != null));

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Portfolio X-ray</h1>
          <p className="rs-subtitle">
            Looks through every fund to what you actually own{x ? ` · as of ${x.asOf}` : ''}
            {(market.loading || historyLoading) && ' · refreshing…'}
          </p>
        </div>
        <Segmented label="Display currency" options={['USD', 'PKR']} value={currency} onChange={setCurrency} />
      </div>

      {ready && x?.warnings?.map((w) => <Notice key={w}>{w}</Notice>)}

      {x && (
        <div className="rs-stats">
          <Stat label="Market value" value={fmtMoney(x.positions.totals.marketValue, currency, { compact: true })} sub={`${x.positions.holdings.length} positions`} />
          <Stat
            label="Unrealised P&L"
            value={fmtMoney(x.positions.totals.unrealized, currency, { compact: true })}
            sub={fmtPct(x.positions.totals.unrealizedPct, { signed: true })}
            tone={toneOf(x.positions.totals.unrealized)}
          />
          <Stat label="Realised + income" value={fmtMoney(x.positions.totals.realized + x.positions.totals.dividends - x.positions.totals.taxes, currency, { compact: true })} sub="sales, dividends net of tax" />
          <Stat label="Return (1Y, TWR)" value={fmtPct(r1?.totalReturn, { signed: true })} tone={toneOf(r1?.totalReturn)} sub={rAll?.cagr != null ? `${fmtPct(rAll.cagr, { signed: true })} a year since start` : null} />
          <Stat label="Volatility (1Y)" value={fmtPct(r1?.volatility)} sub={r1 ? `max drawdown ${fmtPct(r1.maxDrawdown)}` : null} />
          <Stat
            label="Diversification"
            value={`${fmtNum(x.concentration.companies.effectiveN, 1)} cos.`}
            sub={`behaves like ${fmtNum(x.concentration.positions.effectiveN, 1)} equal positions`}
            title="Effective number of holdings = 1 / Herfindahl index of weights"
          />
        </div>
      )}

      <Panel
        title="What you really own"
        subtitle={
          lt && ready
            ? `Companies after unpacking funds. ${fmtPct(lt.disclosedShare, { digits: 0 })} of the portfolio is identifiable down to the company; the rest is fund holdings no source publishes.`
            : null
        }
      >
        {loadingResearch || !lt ? (
          <Skeleton lines={6} />
        ) : (
          <>
            <SplitBars
              total={lt.total}
              currency={currency}
              rows={lt.topCompanies.map((c) => ({
                key: c.key,
                label: c.tickers[0] ? `${displayTicker(c.tickers[0])} · ${c.name}` : c.name,
                value: c.value,
                direct: c.direct,
                indirect: c.indirect,
                sub: Object.keys(c.viaFunds).length ? `via ${Object.keys(c.viaFunds).map(displayTicker).join(', ')}` : null
              }))}
              segments={[
                { key: 'direct', label: 'Held directly', color: 'var(--series-1)' },
                { key: 'indirect', label: 'Through funds', color: 'var(--series-2)' }
              ]}
            />
            {lt.overlaps.length > 0 && (
              <p className="rs-panel-sub" style={{ marginTop: 14 }}>
                <strong style={{ color: 'var(--text-primary)' }}>Overlap:</strong>{' '}
                {lt.overlaps
                  .slice(0, 6)
                  .map((c) => `${displayTicker(c.tickers[0] || c.name)} (${fmtPct(c.direct / lt.total)} direct + ${fmtPct(c.indirect / lt.total)} via ${Object.keys(c.viaFunds).map(displayTicker).join(', ')})`)
                  .join(' · ')}
              </p>
            )}
          </>
        )}
      </Panel>

      <div className="rs-grid-2">
        <Panel title="Sectors" subtitle="Look-through, all holdings and funds">
          {lt && ready ? <BarList rows={lt.sectors.map((s) => ({ key: s.key, label: s.key, weight: s.weight }))} /> : <Skeleton />}
        </Panel>
        <Panel title="Countries" subtitle="Where the underlying companies are">
          {lt && ready ? <BarList rows={lt.countries.map((s) => ({ key: s.key, label: s.key, weight: s.weight }))} color="var(--series-3)" /> : <Skeleton />}
        </Panel>
        <Panel title="Currency of listing" subtitle="What moves with PKR/USD">
          {x ? <BarList rows={x.currencyExposure.map((s) => ({ key: s.key, label: s.key, weight: s.weight }))} color="var(--series-4)" /> : <Skeleton />}
        </Panel>
        <Panel title="Asset class" subtitle={x && ready ? `Shariah-flagged: ${fmtPct(x.shariah.compliant, { digits: 0 })} · not flagged: ${fmtPct(x.shariah.unknown + x.shariah.nonCompliant, { digits: 0 })}` : null}>
          {lt && ready ? <BarList rows={lt.assetClasses.map((s) => ({ key: s.key, label: s.key, weight: s.weight }))} color="var(--series-7)" /> : <Skeleton />}
        </Panel>
      </div>

      <Panel title="Funds" subtitle="How much of each fund the X-ray can see, and what it costs you">
        {!lt || !ready ? (
          <Skeleton />
        ) : lt.funds.length === 0 ? (
          <Empty>No funds or ETFs in the portfolio.</Empty>
        ) : (
          <div className="rs-table-wrap">
            <table className="rs-table">
              <thead>
                <tr>
                  <th>Fund</th>
                  <th className="num">Value</th>
                  <th className="num">Disclosed</th>
                  <th className="num">Holdings</th>
                  <th className="num">Expense ratio</th>
                  <th className="num">Cost / year</th>
                  <th>Breakdown basis</th>
                </tr>
              </thead>
              <tbody>
                {lt.funds.map((f) => (
                  <tr key={f.ticker} className="clickable" onClick={() => navigate(`/research/${encodeURIComponent(f.ticker)}`)}>
                    <td>
                      <SymbolLink symbol={f.ticker} name={f.name} />
                    </td>
                    <td className="num">{fmtMoney(f.value, currency, { compact: true })}</td>
                    <td className="num">{fmtPct(f.coverage, { digits: 0 })}</td>
                    <td className="num">{f.holdingsCount ?? <span className="rs-muted">{f.listed} listed</span>}</td>
                    <td className="num">{fmtPct(f.expenseRatio, { digits: 2 })}</td>
                    <td className="num">{f.expenseRatio != null ? fmtMoney(f.value * f.expenseRatio, currency) : '—'}</td>
                    <td>
                      {f.override ? <Tag tone="info">manual</Tag> : f.countryBasis === 'fund' ? <Tag tone="good">full fund</Tag> : <Tag tone="warning">top holdings</Tag>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {x.fees.annualCost > 0 && (
              <p className="rs-panel-sub" style={{ marginTop: 10 }}>
                Fund fees cost about {fmtMoney(x.fees.annualCost, currency)} a year, a {fmtPct(x.fees.portfolioDrag, { digits: 2 })} drag on the whole portfolio.
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Against the market"
        subtitle={`Time-weighted, in ${currency} at historical exchange rates, indexed to 100`}
        action={<Segmented label="Range" options={['1Y', 'All']} value={range} onChange={setRange} />}
      >
        {chart.length < 2 ? (
          <Skeleton lines={5} />
        ) : (
          <div className="rs-chart" role="img" aria-label={`Portfolio vs ${benchNames.join(', ')}, indexed to 100`}>
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={48} tickFormatter={(d) => d.slice(2, 7)} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} domain={['auto', 'auto']} width={44} />
                <Tooltip content={<ChartTooltip formatter={(v) => fmtNum(v, 1)} />} cursor={{ stroke: 'rgba(255,255,255,0.2)' }} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} iconType="plainline" />
                {['Portfolio', ...benchNames].map((n, i) => (
                  <Line key={n} type="monotone" dataKey={n} stroke={SERIES[i]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {x?.benchmarks?.length > 0 && (
          <div className="rs-table-wrap" style={{ marginTop: 12 }}>
            <table className="rs-table">
              <thead>
                <tr>
                  <th>Over the last year vs</th>
                  <th className="num">Index</th>
                  <th className="num">You</th>
                  <th className="num">Difference</th>
                  <th className="num">Beta</th>
                  <th className="num">Correlation</th>
                  <th className="num">Alpha</th>
                </tr>
              </thead>
              <tbody>
                {x.benchmarks.map((b) => {
                  const c = b.oneYear || b.sinceInception;
                  return (
                    <tr key={b.symbol}>
                      <td>{b.name}</td>
                      <td className="num">{fmtPct(c.benchmarkReturn, { signed: true })}</td>
                      <td className="num">{fmtPct(c.portfolioReturn, { signed: true })}</td>
                      <td className={`num ${toneOf(c.excessReturn)}`}>{fmtPct(c.excessReturn, { signed: true })}</td>
                      <td className="num">{fmtNum(c.beta)}</td>
                      <td className="num">{fmtNum(c.correlation)}</td>
                      <td className="num">{fmtPct(c.alpha, { signed: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="rs-grid-2">
        <Panel title="Risk" subtitle={x?.risk?.oneYear ? `Trailing year to ${x.risk.oneYear.to}; risk-free rate ${fmtPct(x.risk.oneYear.riskFreeRate)}` : null}>
          {r1 ? (
            <div className="rs-kv">
              <div><dt>Volatility</dt><dd>{fmtPct(r1.volatility)}</dd></div>
              <div><dt>Max drawdown</dt><dd>{fmtPct(r1.maxDrawdown)}</dd></div>
              <div><dt>Sharpe</dt><dd>{fmtNum(r1.sharpe)}</dd></div>
              <div><dt>Sortino</dt><dd>{fmtNum(r1.sortino)}</dd></div>
              <div><dt>Best day</dt><dd className="rs-gain">{fmtPct(r1.bestDay?.r, { signed: true })}</dd></div>
              <div><dt>Worst day</dt><dd className="rs-loss">{fmtPct(r1.worstDay?.r, { signed: true })}</dd></div>
              <div><dt>Up days</dt><dd>{fmtPct(r1.positiveDays, { digits: 0 })}</dd></div>
              <div><dt>Top 5 weight</dt><dd>{fmtPct(x.concentration.positions.top5, { digits: 0 })}</dd></div>
            </div>
          ) : (
            <Empty>Not enough history yet for risk statistics.</Empty>
          )}
        </Panel>

        <Panel title="Income" subtitle={x ? `Trailing 12 months, net of tax` : null}>
          {x ? (
            <>
              <div className="rs-kv" style={{ marginBottom: 14 }}>
                <div><dt>Dividends (12m)</dt><dd>{fmtMoney(x.income.trailing12m.net, currency)}</dd></div>
                <div><dt>Current yield</dt><dd>{fmtPct(x.income.currentYield, { digits: 2 })}</dd></div>
                <div><dt>Yield on cost</dt><dd>{fmtPct(x.income.yieldOnCost, { digits: 2 })}</dd></div>
              </div>
              {x.income.byYear.length > 0 ? (
                <BarList
                  rows={x.income.byYear.map((y) => ({ key: y.year, label: y.year, weight: y.gross - y.tax, value: y.gross - y.tax }))}
                  format={(r) => fmtMoney(r.value, currency, { compact: true })}
                  color="var(--series-3)"
                />
              ) : (
                <Empty>No dividends recorded yet.</Empty>
              )}
            </>
          ) : (
            <Skeleton />
          )}
        </Panel>
      </div>

      {x?.correlations?.tickers?.length > 1 && <CorrelationPanel c={x.correlations} />}

      {x && (
        <Panel title="Holdings" subtitle="Sorted by value">
          <div className="rs-table-wrap">
            <table className="rs-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Weight</th>
                  <th className="num">Value</th>
                  <th className="num">Avg cost</th>
                  <th className="num">Price</th>
                  <th className="num">P&L</th>
                  <th className="num">Today</th>
                </tr>
              </thead>
              <tbody>
                {x.positions.holdings.map((h) => (
                  <tr key={h.ticker} className="clickable" onClick={() => navigate(`/research/${encodeURIComponent(h.ticker)}`)}>
                    <td><SymbolLink symbol={h.ticker} name={h.name} /></td>
                    <td className="num">{fmtPct(h.weight)}</td>
                    <td className="num">{fmtMoney(h.marketValue, currency, { compact: true })}</td>
                    <td className="num">{fmtMoney(h.avgCost, currency)}</td>
                    <td className="num">{fmtMoney(h.price, currency)}</td>
                    <td className={`num ${toneOf(h.unrealized)}`}>{fmtPct(h.unrealizedPct, { signed: true })}</td>
                    <td className={`num ${toneOf(h.dayChangePct)}`}>{fmtPct(h.dayChangePct, { signed: true, digits: 2 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function CorrelationPanel({ c }) {
  const n = c.tickers.length;
  const cols = `72px repeat(${n}, minmax(26px, 1fr))`;
  return (
    <Panel
      title="How your holdings move together"
      subtitle={`Correlation of daily returns since ${c.since}. Blue moves together, red moves opposite; holdings that all move together diversify less than their count suggests.`}
    >
      <div className="rs-table-wrap">
        <div className="rs-heat" style={{ gridTemplateColumns: cols, minWidth: 72 + n * 30 }}>
          <span />
          {c.tickers.map((t) => (
            <span key={t} className="rs-heat-label rs-heat-col">{displayTicker(t)}</span>
          ))}
          {c.tickers.map((a, i) => (
            <FragmentRow key={a} a={a} row={c.matrix[i]} tickers={c.tickers} />
          ))}
        </div>
      </div>
      {c.mostCorrelated.length > 0 && (
        <p className="rs-panel-sub" style={{ marginTop: 12 }}>
          Most alike: {c.mostCorrelated.slice(0, 3).map((p) => `${displayTicker(p.a)}–${displayTicker(p.b)} ${fmtNum(p.correlation)}`).join(' · ')}
        </p>
      )}
    </Panel>
  );
}

function FragmentRow({ a, row, tickers }) {
  return (
    <>
      <span className="rs-heat-label">{displayTicker(a)}</span>
      {row.map((v, j) => (
        <span
          key={tickers[j]}
          className="rs-heat-cell"
          style={{ background: divergingColor(v) }}
          title={`${displayTicker(a)} vs ${displayTicker(tickers[j])}: ${v == null ? 'not enough shared trading days' : fmtNum(v)}`}
        >
          {v == null ? '' : tickers.length <= 12 ? fmtNum(v, 1) : ''}
        </span>
      ))}
    </>
  );
}
