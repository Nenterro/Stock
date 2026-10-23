import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useData } from '../context/DataContext';
import { useAppearanceSettings } from '../context/SettingsContext';
import { useMarketResearch } from '../hooks/useMarketResearch';
import { buildXray, benchmarkInCurrency, contributionByHolding, currencySplit, BENCHMARKS } from '../utils/portfolio_analytics';
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

  // The performance window (1Y / All) drives the market chart, contribution
  // and the currency split alike.
  const since = useMemo(() => {
    if (range !== '1Y' || !series.length) return null;
    const end = series[series.length - 1].date;
    return new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  }, [series, range]);

  const contribution = useMemo(
    () => (transactions?.length ? contributionByHolding(transactions, livePrices, historicalPrices, { displayCurrency: currency, fxRate, fxSeries, since }) : null),
    [transactions, livePrices, historicalPrices, currency, fxRate, fxSeries, since]
  );

  const fxSplit = useMemo(
    () => (transactions?.length ? currencySplit(transactions, livePrices, historicalPrices, { fxRate, fxSeries, since }) : null),
    [transactions, livePrices, historicalPrices, fxRate, fxSeries, since]
  );

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
        <div className="rs-header">
          <h1 className="rs-title">Analysis</h1>
        </div>
        <Panel>
          <Empty title="No transactions yet">Add or import trades and this page will analyse your portfolio.</Empty>
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
  const lastPoint = series[series.length - 1];
  const vs = (symbol) => x?.benchmarks?.find((b) => b.symbol === symbol)?.oneYear || null;
  const spx = vs('^GSPC');
  const kse = vs('KSE100TR');
  const fundShare = lt?.total > 0 ? lt.funds.reduce((a, f) => a + f.value, 0) / lt.total : 0;

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Analysis</h1>
          <p className="rs-subtitle">
            What you own, how it has done and why, looking through every fund{x ? ` · as of ${x.asOf}` : ''}
            {(market.loading || historyLoading) && ' · refreshing…'}
          </p>
        </div>
        <Segmented label="Display currency" options={['USD', 'PKR']} value={currency} onChange={setCurrency} />
      </div>

      {ready && x?.warnings?.map((w) => <Notice key={w}>{w}</Notice>)}

      {x && (
        <div className="rs-stats rs-stats-6">
          <Stat
            label="Return a year"
            value={fmtPct((lastPoint?.mwrAnnualPct ?? 0) / 100, { signed: true })}
            tone={toneOf(lastPoint?.mwrAnnualPct)}
            sub={series.length ? `money-weighted, since ${series[0].date.slice(0, 7)}` : null}
          />
          {(spx || kse) && (
            <Stat
              label="Last year vs markets"
              value={fmtPct((spx || kse).portfolioReturn, { signed: true })}
              tone={toneOf((spx || kse).portfolioReturn)}
              sub={[spx && `S&P 500 ${fmtPct(spx.benchmarkReturn, { signed: true })}`, kse && `KSE-100 ${fmtPct(kse.benchmarkReturn, { signed: true })}`].filter(Boolean).join(' · ')}
            />
          )}
          <Stat label="Volatility (1Y)" value={fmtPct(r1?.volatility)} sub={r1 ? `max drawdown ${fmtPct(r1.maxDrawdown)}` : null} />
          <Stat
            label="Diversification"
            value={`${fmtNum(x.concentration.companies.effectiveN, 1)} cos.`}
            sub={`behaves like ${fmtNum(x.concentration.positions.effectiveN, 1)} equal positions`}
            title="Effective number of holdings = 1 / Herfindahl index of weights"
          />
          <Stat
            label="Fund fees"
            value={`${fmtMoney(x.fees.annualCost, currency)} / yr`}
            sub={`${fmtPct(x.fees.portfolioDrag, { digits: 2 })} drag on the portfolio`}
          />
          {ready && (
            <Stat
              label="Shariah-compliant"
              value={fmtPct(x.shariah.compliant, { digits: 0 })}
              sub={x.shariah.unknown + x.shariah.nonCompliant > 0.005 ? `${fmtPct(x.shariah.unknown + x.shariah.nonCompliant, { digits: 0 })} not flagged` : 'all flagged compliant'}
            />
          )}
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

      <div className="rs-grid-3">
        <Panel title="Sectors" subtitle="Look-through, all holdings and funds">
          {lt && ready ? <BarList rows={lt.sectors.map((s) => ({ key: s.key, label: s.key, weight: s.weight }))} limit={10} /> : <Skeleton />}
        </Panel>
        <Panel title="Countries" subtitle="Where the underlying companies are">
          {lt && ready ? <BarList rows={lt.countries.map((s) => ({ key: s.key, label: s.key, weight: s.weight }))} color="var(--series-3)" limit={10} /> : <Skeleton />}
        </Panel>
        <Panel title="Mix" subtitle="How the money is split">
          {lt && x && ready ? (
            <div className="rs-mix">
              <MixBar
                label="Listing currency"
                parts={x.currencyExposure.map((c, i) => ({ key: c.key, label: c.key, weight: c.weight, color: ['var(--series-4)', 'var(--series-1)', 'var(--series-7)'][i % 3] }))}
              />
              <MixBar
                label="How it's held"
                parts={[
                  { key: 'direct', label: 'Directly', weight: Math.max(0, 1 - fundShare), color: 'var(--series-1)' },
                  { key: 'funds', label: 'Through funds', weight: fundShare, color: 'var(--series-2)' }
                ]}
              />
              <MixBar
                label="Asset class"
                parts={lt.assetClasses.map((c, i) => ({ key: c.key, label: c.key, weight: c.weight, color: ['var(--series-3)', 'var(--series-4)', 'var(--series-7)', 'var(--series-5)'][i % 4] }))}
              />
            </div>
          ) : (
            <Skeleton />
          )}
        </Panel>
      </div>

      <Panel
        title="Performance against the market"
        subtitle={`Time-weighted so deposits don't count as returns, in ${currency} at historical exchange rates, indexed to 100`}
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

      <Panel
        title="Where the gains came from"
        subtitle={`Each holding's gain ${range === '1Y' ? 'over the last year' : 'since you started'}: price, realised and dividends net of tax, sold positions included`}
      >
        {contribution?.rows?.length ? (
          <ContributionSplit rows={contribution.rows} total={contribution.total} currency={currency} />
        ) : (
          <Skeleton />
        )}
      </Panel>

      <div className="rs-grid-2">
        <Panel
          title="Pakistan: shares vs the rupee"
          subtitle={`Your PSX gain in USD ${range === '1Y' ? 'over the last year' : 'since you started'}, split into what the share prices did and what the rupee did`}
        >
          {!fxSplit ? (
            <Empty>No Pakistan holdings yet.</Empty>
          ) : (
            <>
              <div className="rs-kv rs-kv-3" style={{ marginBottom: 14 }}>
                <div><dt>Gain in USD</dt><dd className={toneOf(fxSplit.usdGain)}>{fmtMoney(fxSplit.usdGain, 'USD')}</dd></div>
                <div><dt>From share prices</dt><dd className={toneOf(fxSplit.priceEffect)}>{fmtMoney(fxSplit.priceEffect, 'USD')}</dd></div>
                <div><dt>From the rupee</dt><dd className={toneOf(fxSplit.currencyEffect)}>{fmtMoney(fxSplit.currencyEffect, 'USD')}</dd></div>
              </div>
              <ContributionBars
                rows={[
                  { ticker: 'prices', name: 'Share prices and dividends', contribution: fxSplit.priceEffect, held: true, label: 'Share prices' },
                  { ticker: 'rupee', name: 'PKR against USD', contribution: fxSplit.currencyEffect, held: true, label: 'Rupee' }
                ]}
                total={fxSplit.usdGain}
                currency="USD"
              />
              <p className="rs-panel-sub" style={{ marginTop: 14 }}>
                In rupees the gain is {fmtMoney(fxSplit.pkrGain, 'PKR')}. The rupee went from {fmtNum(fxSplit.fxStart, 2)} to {fmtNum(fxSplit.fxEnd, 2)} per dollar
                {fxSplit.rupeeChange != null ? ` (${fmtPct(fxSplit.rupeeChange, { signed: true })} in dollar terms)` : ''} since {fxSplit.from}.
              </p>
            </>
          )}
        </Panel>

        <Panel title="Income" subtitle={x ? `Trailing 12 months, net of tax` : null}>
          {x ? (
            <>
              <div className="rs-kv rs-kv-3" style={{ marginBottom: 14 }}>
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

      <div className="rs-grid-2">
        <Panel title="Risk" subtitle={x?.risk?.oneYear ? `Trailing year to ${x.risk.oneYear.to}; risk-free rate ${fmtPct(x.risk.oneYear.riskFreeRate)}` : null}>
          {r1 ? (
            <div className="rs-kv rs-kv-3">
              <div><dt>Volatility</dt><dd>{fmtPct(r1.volatility)}</dd></div>
              <div><dt>Max drawdown</dt><dd>{fmtPct(r1.maxDrawdown)}</dd></div>
              <div><dt>Sharpe</dt><dd>{fmtNum(r1.sharpe)}</dd></div>
              <div><dt>Sortino</dt><dd>{fmtNum(r1.sortino)}</dd></div>
              <div><dt>Best day</dt><dd className="rs-gain">{fmtPct(r1.bestDay?.r, { signed: true })}</dd></div>
              <div><dt>Worst day</dt><dd className="rs-loss">{fmtPct(r1.worstDay?.r, { signed: true })}</dd></div>
            </div>
          ) : (
            <Empty>Not enough history yet for risk statistics.</Empty>
          )}
        </Panel>

        <Panel title="Funds" subtitle="How much of each fund can be seen through, and what it costs you">
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
                    <th className="num">Fee</th>
                    <th className="num">Cost / year</th>
                  </tr>
                </thead>
                <tbody>
                  {lt.funds.map((f) => (
                    <tr key={f.ticker} className="clickable" onClick={() => navigate(`/research/${encodeURIComponent(f.ticker)}`)}>
                      <td>
                        <SymbolLink symbol={f.ticker} name={f.name} />
                      </td>
                      <td className="num">{fmtMoney(f.value, currency, { compact: true })}</td>
                      <td className="num" title={f.override ? 'Manual composition' : f.countryBasis === 'fund' ? 'Full holdings list' : 'Top holdings only'}>
                        {fmtPct(f.coverage, { digits: 0 })}
                        {f.countryBasis !== 'fund' && !f.override && <span className="rs-muted"> · top {f.listed}</span>}
                      </td>
                      <td className="num">{fmtPct(f.expenseRatio, { digits: 2 })}</td>
                      <td className="num">{f.expenseRatio != null ? fmtMoney(f.value * f.expenseRatio, currency) : '—'}</td>
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
      </div>

      {x?.correlations?.tickers?.length > 1 && <CorrelationPanel c={x.correlations} />}

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
      {row.map((v, j) => {
        // A holding against itself is always 1.0 and says nothing: leave it blank.
        if (tickers[j] === a) {
          return <span key={tickers[j]} className="rs-heat-cell rs-heat-self" aria-hidden="true" />;
        }
        return (
          <span
            key={tickers[j]}
            className="rs-heat-cell"
            style={{ background: divergingColor(v) }}
            title={`${displayTicker(a)} vs ${displayTicker(tickers[j])}: ${v == null ? 'not enough shared trading days' : fmtNum(v)}`}
          >
            {v == null ? '' : tickers.length <= 12 ? fmtNum(v, 1) : ''}
          </span>
        );
      })}
    </>
  );
}

/**
 * Diverging bars around zero: gains to the right in green, losses to the left
 * in red, each labelled with its amount. Sold positions are marked.
 */
function ContributionBars({ rows, total = null, currency, max: maxIn, oneSided = false }) {
  const max = maxIn ?? Math.max(...rows.map((r) => Math.abs(r.contribution)), 0.0001);
  return (
    <div className="rs-bars">
      {rows.map((r) => {
        // One-sided lists (only gains, or only losses) use the full width.
        const w = (Math.abs(r.contribution) / max) * (oneSided ? 100 : 50);
        const up = r.contribution >= 0;
        return (
          <div
            key={r.ticker}
            className="rs-bar-row"
            title={`${r.name}: ${fmtMoney(r.contribution, currency)}${r.held ? '' : ' (sold)'}`}
          >
            <span className="rs-bar-label">
              {r.label || displayTicker(r.ticker)}
              {!r.held && <span className="rs-muted"> · sold</span>}
            </span>
            <span className="rs-bar-track" style={{ position: 'relative' }}>
              {!oneSided && <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.18)' }} />}
              <span
                className="rs-bar-fill"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: oneSided ? 0 : up ? '50%' : `${50 - w}%`,
                  width: `${Math.max(w, 0.4)}%`,
                  background: up ? 'var(--gain)' : 'var(--loss)',
                  borderRadius: oneSided ? '0 4px 4px 0' : up ? '0 4px 4px 0' : '4px 0 0 4px'
                }}
              />
            </span>
            <span className={`rs-bar-value ${toneOf(r.contribution)}`}>{fmtMoney(r.contribution, currency, { compact: true })}</span>
          </div>
        );
      })}
      {total != null && (
      <div className="rs-bar-row" style={{ borderTop: '1px solid var(--panel-border)', paddingTop: 8, marginTop: 2 }}>
        <span className="rs-bar-label" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Total</span>
        <span />
        <span className={`rs-bar-value ${toneOf(total)}`} style={{ fontWeight: 600 }}>{fmtMoney(total, currency, { compact: true })}</span>
      </div>
      )}
    </div>
  );
}

/** Gains on the left, losses on the right: the top eight of each, the rest summed. */
function ContributionSplit({ rows, total, currency }) {
  const LIMIT = 8;
  const side = (list, label) => {
    const shown = list.slice(0, LIMIT);
    const rest = list.slice(LIMIT);
    if (rest.length) {
      shown.push({
        ticker: `rest-${label}`,
        name: rest.map((r) => r.ticker).join(', '),
        label: `${rest.length} smaller`,
        contribution: rest.reduce((a, r) => a + r.contribution, 0),
        held: true
      });
    }
    return shown;
  };
  const gains = rows.filter((r) => r.contribution >= 0);
  const losses = rows.filter((r) => r.contribution < 0).sort((a, b) => a.contribution - b.contribution);
  const max = Math.max(...rows.map((r) => Math.abs(r.contribution)), 0.0001);
  const sum = (list) => list.reduce((a, r) => a + r.contribution, 0);
  return (
    <>
      <div className="rs-grid-2 rs-contrib">
        <div>
          <div className="rs-contrib-head">Added <span className="rs-gain">{fmtMoney(sum(gains), currency, { compact: true })}</span></div>
          {gains.length ? <ContributionBars rows={side(gains, 'gains')} max={max} currency={currency} oneSided /> : <Empty>Nothing gained in this period.</Empty>}
        </div>
        <div>
          <div className="rs-contrib-head">Took away <span className="rs-loss">{fmtMoney(sum(losses), currency, { compact: true })}</span></div>
          {losses.length ? <ContributionBars rows={side(losses, 'losses')} max={max} currency={currency} oneSided /> : <Empty>Nothing lost in this period.</Empty>}
        </div>
      </div>
      <p className="rs-panel-sub" style={{ marginTop: 12 }}>
        Net: <strong className={toneOf(total)}>{fmtMoney(total, currency)}</strong>
      </p>
    </>
  );
}

/** One horizontal bar split into parts, with a legend underneath. */
function MixBar({ label, parts }) {
  const shown = parts.filter((p) => p.weight > 0.0005);
  return (
    <div className="rs-mix-row">
      <div className="rs-mix-label">{label}</div>
      <div className="rs-mix-bar">
        {shown.map((p) => (
          <span key={p.key} style={{ width: `${p.weight * 100}%`, background: p.color }} title={`${p.label}: ${fmtPct(p.weight, { digits: 1 })}`} />
        ))}
      </div>
      <div className="rs-legend" style={{ margin: '8px 0 0' }}>
        {shown.map((p) => (
          <span key={p.key} className="rs-legend-item">
            <span className="rs-swatch" style={{ background: p.color }} />
            {p.label} {fmtPct(p.weight, { digits: p.weight < 0.01 ? 1 : 0 })}
          </span>
        ))}
      </div>
    </div>
  );
}
