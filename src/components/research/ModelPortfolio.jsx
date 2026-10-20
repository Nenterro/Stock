import { useMemo, useState } from 'react';
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Play } from 'lucide-react';
import { useData } from '../../context/DataContext';
import { fetchHistoricalPricesBatch, fetchExpectedReturns, fetchScreenerRow } from '../../utils/api';
import { computePositions } from '../../utils/portfolio_analytics';
import { buildInputs, runModels } from '../../utils/models/pipeline';
import { displayTicker } from '../../utils/format';
import { Panel, Segmented, Empty, Notice, Skeleton, Tag, ChartTooltip, fmtMoney, fmtPct, fmtNum, toneOf } from './ResearchUI';

const SLEEVE_LABEL = { globalCore: 'Global funds', globalStocks: 'Global stocks', pakistan: 'Pakistan' };
const ALTS = [
  ['recommended', 'Recommended'],
  ['reference', 'Policy reference'],
  ['minimumVariance', 'Minimum variance'],
  ['maxSharpe', 'Max Sharpe'],
  ['riskParity', 'Risk parity']
];

/**
 * The portfolio models in the app: Black-Litterman construction within the
 * policy sleeves, a Monte Carlo projection of the monthly plan and stress
 * tests. Same pipeline (src/utils/models) Claude runs through the MCP server.
 */
export default function ModelPortfolio({ onUseAsTargets }) {
  const { transactions, livePrices, exchangeRates, fxSeries, research } = useData();
  const [monthly, setMonthly] = useState('2500');
  const [years, setYears] = useState('10');
  const [growth, setGrowth] = useState('5');
  const [maxStock, setMaxStock] = useState('10');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState('recommended');

  const fxRate = exchangeRates?.PKR || 278;
  const positions = useMemo(() => computePositions(transactions, livePrices, { displayCurrency: 'USD', fxRate, fxSeries }), [transactions, livePrices, fxRate, fxSeries]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const extra = [
        ...research.filter((r) => r.kind === 'watch').map((r) => r.symbol),
        ...Object.keys(research.find((r) => r.kind === 'targets')?.data?.targets || {})
      ];
      const inputs = await buildInputs({
        holdings: positions.holdings,
        extraSymbols: extra,
        fetchers: {
          histories: (syms, range = '10y') => fetchHistoricalPricesBatch(syms, range),
          expectedReturns: () => fetchExpectedReturns(),
          screenerRow: (s) => fetchScreenerRow(s)
        }
      });
      // Give the browser a frame to paint the loading state before the maths.
      await new Promise((r) => setTimeout(r, 30));
      const out = runModels({
        ...inputs,
        holdings: positions.holdings,
        fxSeries,
        monthly: Number(monthly) || 0,
        years: Number(years) || 10,
        contributionGrowth: (Number(growth) || 0) / 100,
        maxStockWeight: (Number(maxStock) || 10) / 100,
        paths: 3000
      });
      out.missingViews = inputs.assets.filter((a) => a.expected == null).map((a) => a.symbol);
      out.noModels = !inputs.expectedReturns;
      setResult(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const pf = result?.portfolios?.[view];
  const symbols = result ? result.assets.map((a) => a.symbol) : [];
  const proj = result?.projections?.[view] || result?.projections?.recommended;
  const fan = (proj?.byYear || []).map((y) => ({
    year: `Y${y.year}`,
    band95: [y.p5, y.p95],
    band50: [y.p25, y.p75],
    Median: y.median,
    Invested: y.invested
  }));

  return (
    <Panel
      title="Model portfolio"
      subtitle="Black-Litterman construction within your policy sleeves, a 10-year projection of the monthly plan and stress tests. Candidates: your holdings, planner targets and watchlist (plus core funds if you hold none)."
      action={
        <button type="button" className="rs-btn primary" onClick={run} disabled={running}>
          <Play size={14} /> {running ? 'Running…' : result ? 'Run again' : 'Run models'}
        </button>
      }
    >
      <div className="rs-filters" style={{ marginBottom: 14 }}>
        <div className="rs-field">
          <label htmlFor="mp-m">Monthly (USD)</label>
          <input id="mp-m" className="rs-input" type="number" value={monthly} onChange={(e) => setMonthly(e.target.value)} style={{ width: 110 }} />
        </div>
        <div className="rs-field">
          <label htmlFor="mp-g">Grows %/yr</label>
          <input id="mp-g" className="rs-input" type="number" value={growth} onChange={(e) => setGrowth(e.target.value)} style={{ width: 80 }} />
        </div>
        <div className="rs-field">
          <label htmlFor="mp-y">Years</label>
          <input id="mp-y" className="rs-input" type="number" value={years} onChange={(e) => setYears(e.target.value)} style={{ width: 70 }} />
        </div>
        <div className="rs-field">
          <label htmlFor="mp-x">Max per stock %</label>
          <input id="mp-x" className="rs-input" type="number" value={maxStock} onChange={(e) => setMaxStock(e.target.value)} style={{ width: 90 }} />
        </div>
      </div>

      {error && <Notice>{error}</Notice>}
      {running && <Skeleton lines={6} />}
      {!running && !result && !error && <Empty>Run the models to see a recommended mix, where the plan could take you, and how it holds up in a crisis.</Empty>}

      {!running && result && (
        <>
          {result.noModels && <Notice>Expected returns haven't been computed yet (they run with the nightly job), so the recommendation is the policy reference portfolio.</Notice>}
          {!result.noModels && result.missingViews.length > 0 && (
            <Notice>No model view for {result.missingViews.map(displayTicker).join(', ')}: they follow the reference portfolio's implied returns.</Notice>
          )}

          <div className="rs-row" style={{ marginBottom: 12 }}>
            <Segmented label="Portfolio" options={ALTS.map(([value, label]) => ({ value, label }))} value={view} onChange={setView} />
            <span className="rs-spacer" />
            {pf && view === 'recommended' && onUseAsTargets && (
              <button type="button" className="rs-btn" onClick={() => onUseAsTargets(pf.weights, result)}>
                Use as targets
              </button>
            )}
          </div>

          {pf && (
            <div className="rs-stats" style={{ marginBottom: 14 }}>
              <div className="rs-stat"><div className="rs-stat-label">Expected return</div><div className="rs-stat-value">{fmtPct(pf.expectedReturn)}</div><div className="rs-stat-sub">USD a year, model estimate</div></div>
              <div className="rs-stat"><div className="rs-stat-label">Volatility</div><div className="rs-stat-value">{fmtPct(pf.volatility)}</div><div className="rs-stat-sub">USD, annual</div></div>
              <div className="rs-stat"><div className="rs-stat-label">Sharpe</div><div className="rs-stat-value">{fmtNum(pf.sharpe)}</div><div className="rs-stat-sub">vs {fmtPct(result.riskFree)} cash</div></div>
              <div className="rs-stat"><div className="rs-stat-label">Diversification</div><div className="rs-stat-value">{fmtNum(pf.diversificationRatio)}×</div><div className="rs-stat-sub">avg risk ÷ portfolio risk</div></div>
            </div>
          )}

          {pf && (
            <div className="rs-table-wrap">
              <table className="rs-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Sleeve</th>
                    <th className="num">Now</th>
                    <th className="num">{ALTS.find(([k]) => k === view)[1]}</th>
                    <th className="num">Share of risk</th>
                    <th className="num">View</th>
                    <th className="num">Model return</th>
                    <th className="num">Volatility</th>
                  </tr>
                </thead>
                <tbody>
                  {result.assets
                    .slice()
                    .sort((a, b) => (pf.weights[b.symbol] || 0) - (pf.weights[a.symbol] || 0))
                    .map((a) => {
                      const now = result.current?.weights?.[a.symbol] || 0;
                      const w = pf.weights[a.symbol] || 0;
                      return (
                        <tr key={a.symbol}>
                          <td className="rs-sym">
                            {displayTicker(a.symbol)}
                            {a.filledMonths > 0 && <span className="rs-name" title={`${a.filledMonths} early months filled from its market index`}> · short history</span>}
                          </td>
                          <td><span className="rs-secondary">{SLEEVE_LABEL[a.sleeve] || a.sleeve}</span></td>
                          <td className="num">{fmtPct(now)}</td>
                          <td className={`num ${w - now > 0.01 ? 'rs-gain' : w - now < -0.01 ? 'rs-loss' : ''}`}>{fmtPct(w)}</td>
                          <td className="num">{fmtPct(pf.riskContributions[a.symbol])}</td>
                          <td className="num" title={a.viewSource || ''}>{a.view == null ? '—' : fmtPct(a.view)}</td>
                          <td className="num">{fmtPct(a.posterior)}</td>
                          <td className="num">{fmtPct(a.volatility)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              <p className="rs-panel-sub" style={{ marginTop: 8 }}>
                Sleeves: {Object.entries(pf.sleeves).map(([k, v]) => `${SLEEVE_LABEL[k] || k} ${fmtPct(v, { digits: 0 })}`).join(' · ')}. {result.months} months of USD returns to {result.asOf}; covariance shrunk {fmtPct(result.covariance.shrinkage, { digits: 0 })} toward constant correlation.
              </p>
            </div>
          )}

          {fan.length > 0 && (
            <>
              <h3 className="rs-panel-title" style={{ marginTop: 20 }}>Where the plan could go</h3>
              <p className="rs-panel-sub">
                {proj.paths.toLocaleString()} simulated paths, resampling real 6-month blocks of history re-centred on the model returns. Bands: middle 50% and 90% of outcomes.
              </p>
              <div className="rs-chart" style={{ height: 300 }} role="img" aria-label="Projected portfolio value by year">
                <ResponsiveContainer>
                  <ComposedChart data={fan} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => fmtMoney(v, 'USD', { compact: true })} width={64} />
                    <Tooltip
                      content={
                        <ChartTooltip
                          formatter={(v) => (Array.isArray(v) ? `${fmtMoney(v[0], 'USD', { compact: true })} – ${fmtMoney(v[1], 'USD', { compact: true })}` : fmtMoney(v, 'USD', { compact: true }))}
                        />
                      }
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
                    <Area dataKey="band95" name="90% of outcomes" stroke="none" fill="var(--series-1)" fillOpacity={0.14} isAnimationActive={false} />
                    <Area dataKey="band50" name="Middle 50%" stroke="none" fill="var(--series-1)" fillOpacity={0.3} isAnimationActive={false} />
                    <Line dataKey="Median" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line dataKey="Invested" name="Money put in" stroke="var(--series-4)" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="rs-kv" style={{ marginTop: 10 }}>
                {[proj.byYear[0], proj.byYear[Math.min(4, proj.byYear.length - 1)], proj.byYear[proj.byYear.length - 1]].filter((y, i, a) => a.indexOf(y) === i).map((y) => (
                  <div key={y.year}>
                    <dt>After {y.year} year{y.year > 1 ? 's' : ''}</dt>
                    <dd>
                      {fmtMoney(y.median, 'USD', { compact: true })} <span className="rs-muted">median</span>
                    </dd>
                    <dd className="rs-name" style={{ maxWidth: 'none' }}>
                      {fmtPct(y.probBelowInvested, { digits: 0 })} chance below the {fmtMoney(y.invested, 'USD', { compact: true })} put in
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Typical worst fall</dt>
                  <dd>{fmtPct(proj.maxDrawdown.median, { digits: 0 })}</dd>
                  <dd className="rs-name" style={{ maxWidth: 'none' }}>1 in 10: {fmtPct(proj.maxDrawdown.p10, { digits: 0 })}</dd>
                </div>
              </div>
            </>
          )}

          {result.stress && (
            <>
              <h3 className="rs-panel-title" style={{ marginTop: 20 }}>Stress tests</h3>
              <p className="rs-panel-sub">What each crisis would do to the portfolio, in USD. Assets without history for a window use their market index.</p>
              <div className="rs-table-wrap">
                <table className="rs-table">
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      {result.stress.current && <th className="num">Current portfolio</th>}
                      <th className="num">Recommended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stress.recommended.map((s, i) => {
                      const c = result.stress.current?.[i];
                      return (
                        <tr key={s.key}>
                          <td>
                            {s.name} {s.type === 'hypothetical' && <Tag>what-if</Tag>}
                            {s.type === 'historical' && <div className="rs-name">{s.from} → {s.to}</div>}
                          </td>
                          {result.stress.current && (
                            <td className={`num ${toneOf(c?.portfolioReturn)}`}>
                              {c?.portfolioReturn == null ? 'no data' : `${fmtPct(c.portfolioReturn)} (${fmtMoney(c.loss, 'USD', { compact: true })})`}
                            </td>
                          )}
                          <td className={`num ${toneOf(s.portfolioReturn)}`}>{s.portfolioReturn == null ? 'no data' : fmtPct(s.portfolioReturn)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
