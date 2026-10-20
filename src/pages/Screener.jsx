import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { useData } from '../context/DataContext';
import { fetchScreener } from '../utils/api';
import { Panel, Empty, Skeleton, Tag, SymbolLink, Segmented, fmtMoney, fmtPct, fmtNum, fmtBig, toneOf } from '../components/research/ResearchUI';
import './Research.css';

const SECTORS = [
  'Technology',
  'Communication Services',
  'Consumer Cyclical',
  'Consumer Defensive',
  'Financial Services',
  'Healthcare',
  'Industrials',
  'Energy',
  'Basic Materials',
  'Utilities',
  'Real Estate'
];

const TREND_TONE = { uptrend: 'good', downtrend: 'serious', sideways: 'info' };

const DEFAULTS = { market: 'PSX', shariah: true, max_peTTM: '', min_epsGrowth: '', min_dividendYield: '', sector: '', trend: '', min_liquidity: '10', q: '' };

// Ratio inputs are entered as percentages and sent as fractions.
const PERCENT_FIELDS = ['min_epsGrowth', 'min_dividendYield'];

export default function Screener() {
  const { research, saveResearch } = useData();
  const navigate = useNavigate();
  const [f, setF] = useState(DEFAULTS);
  const [sort, setSort] = useState('peTTM');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const watched = new Set(research.filter((r) => r.kind === 'watch').map((r) => r.symbol));

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      const params = { sort, limit: 300 };
      if (f.market === 'PSX') params.market = 'PSX';
      if (f.market === 'International') params.currency = 'USD';
      if (f.shariah) params.shariah = true;
      if (f.max_peTTM) {
        params.max_peTTM = f.max_peTTM;
        params.min_peTTM = 0.01; // a negative P/E is a loss, not a bargain
      }
      for (const k of PERCENT_FIELDS) if (f[k] !== '') params[k] = Number(f[k]) / 100;
      if (f.sector) params.sector = f.sector;
      if (f.trend) params.trend = f.trend;
      // PSX liquidity in PKR millions a day; skip for international rows (no volume field).
      if (f.min_liquidity && f.market === 'PSX') params.min_avgValueTraded20d = Number(f.min_liquidity) * 1e6;
      if (f.q) params.q = f.q;
      fetchScreener(params)
        .then((d) => live && setData(d))
        .finally(() => live && setLoading(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [f, sort]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const sortBy = (key) => setSort(sort === key ? `-${key}` : sort === `-${key}` ? key : key);
  const th = (label, key, extra = '') => (
    <th className={`sortable ${extra}`} onClick={() => sortBy(key)} aria-sort={sort === key ? 'ascending' : sort === `-${key}` ? 'descending' : 'none'}>
      {label}
      {sort === key ? ' ↑' : sort === `-${key}` ? ' ↓' : ''}
    </th>
  );

  const rows = data?.rows || [];

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Screener</h1>
          <p className="rs-subtitle">
            Every PSX equity plus the international list, rebuilt nightly
            {data?.builtAt ? ` · last built ${new Date(data.builtAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
          </p>
        </div>
        <Segmented label="Market" options={['PSX', 'International', 'All']} value={f.market} onChange={(m) => setF({ ...f, market: m })} />
      </div>

      <Panel>
        <div className="rs-filters">
          <div className="rs-field">
            <label htmlFor="sc-q">Search</label>
            <input id="sc-q" className="rs-input" value={f.q} onChange={set('q')} placeholder="Symbol or name" style={{ width: 150 }} />
          </div>
          <div className="rs-field">
            <label htmlFor="sc-pe">Max P/E</label>
            <input id="sc-pe" className="rs-input" type="number" value={f.max_peTTM} onChange={set('max_peTTM')} style={{ width: 80 }} />
          </div>
          <div className="rs-field">
            <label htmlFor="sc-eg">Min EPS growth %</label>
            <input id="sc-eg" className="rs-input" type="number" value={f.min_epsGrowth} onChange={set('min_epsGrowth')} style={{ width: 90 }} />
          </div>
          {f.market !== 'PSX' && (
            <div className="rs-field">
              <label htmlFor="sc-dy">Min yield %</label>
              <input id="sc-dy" className="rs-input" type="number" value={f.min_dividendYield} onChange={set('min_dividendYield')} style={{ width: 80 }} />
            </div>
          )}
          {f.market === 'PSX' && (
            <>
              <div className="rs-field">
                <label htmlFor="sc-sec">Sector</label>
                <select id="sc-sec" className="rs-select" value={f.sector} onChange={set('sector')}>
                  <option value="">Any</option>
                  {SECTORS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="rs-field">
                <label htmlFor="sc-tr">Trend</label>
                <select id="sc-tr" className="rs-select" value={f.trend} onChange={set('trend')}>
                  <option value="">Any</option>
                  <option value="uptrend">Uptrend</option>
                  <option value="sideways">Sideways</option>
                  <option value="downtrend">Downtrend</option>
                </select>
              </div>
              <div className="rs-field">
                <label htmlFor="sc-liq">Min traded / day (PKR m)</label>
                <input id="sc-liq" className="rs-input" type="number" value={f.min_liquidity} onChange={set('min_liquidity')} style={{ width: 110 }} />
              </div>
            </>
          )}
          <label className="rs-row" style={{ fontSize: 13, color: 'var(--text-secondary)', paddingBottom: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={f.shariah} onChange={set('shariah')} /> Shariah-compliant only
          </label>
          <button type="button" className="rs-btn" style={{ marginBottom: 2 }} onClick={() => setF(DEFAULTS)}>Reset</button>
        </div>
      </Panel>

      <Panel title={data ? `${data.total ?? 0} matches` : 'Results'} subtitle={f.market !== 'PSX' ? 'International rows carry valuation and 52-week data; sector and trend are PSX-only.' : null}>
        {loading && !data ? (
          <Skeleton lines={8} />
        ) : !data?.builtAt ? (
          <Empty title="Screener not built yet">The backend builds it overnight; the first build takes several minutes after a deploy.</Empty>
        ) : rows.length === 0 ? (
          <Empty>No matches. Loosen a filter.</Empty>
        ) : (
          <div className="rs-table-wrap">
            <table className="rs-table">
              <thead>
                <tr>
                  {th('Symbol', 'symbol')}
                  {th('Price', 'price', 'num')}
                  {th('Mkt cap', 'marketCap', 'num')}
                  {th('P/E', 'peTTM', 'num')}
                  {f.market === 'PSX' ? th('EPS gr.', 'epsGrowth', 'num') : th('Yield', 'dividendYield', 'num')}
                  {f.market === 'PSX' && th('Net margin', 'netMargin', 'num')}
                  {th('1Y', 'return1y', 'num')}
                  {th('From high', 'fromHigh52', 'num')}
                  {f.market === 'PSX' && th('RSI', 'rsi14', 'num')}
                  <th>{f.market === 'PSX' ? 'Trend' : 'vs 200d'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} className="clickable" onClick={() => navigate(`/research/${encodeURIComponent(r.symbol)}`)}>
                    <td>
                      <SymbolLink symbol={r.symbol} name={r.name} />
                    </td>
                    <td className="num">{fmtMoney(r.price, r.currency)}</td>
                    <td className="num">{fmtBig(r.marketCap)}</td>
                    <td className="num">{fmtNum(r.peTTM, 1)}</td>
                    {f.market === 'PSX' ? (
                      <td className={`num ${toneOf(r.epsGrowth)}`}>{fmtPct(r.epsGrowth, { signed: true, digits: 0 })}</td>
                    ) : (
                      <td className="num">{fmtPct(r.dividendYield, { digits: 2 })}</td>
                    )}
                    {f.market === 'PSX' && <td className="num">{fmtPct(r.netMargin, { digits: 0 })}</td>}
                    <td className={`num ${toneOf(r.return1y)}`}>{fmtPct(r.return1y, { signed: true, digits: 0 })}</td>
                    <td className="num">{fmtPct(r.fromHigh52, { digits: 0 })}</td>
                    {f.market === 'PSX' && <td className="num">{fmtNum(r.rsi14, 0)}</td>}
                    <td>
                      {r.trend ? (
                        <Tag tone={TREND_TONE[r.trend]}>{r.trend}</Tag>
                      ) : r.aboveSma200 != null ? (
                        <Tag tone={r.aboveSma200 ? 'good' : 'serious'}>{r.aboveSma200 ? 'above' : 'below'}</Tag>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="glass-icon-btn"
                        style={{ width: 30, height: 30, borderRadius: 10, color: watched.has(r.symbol) ? 'var(--accent-color)' : undefined }}
                        aria-label={watched.has(r.symbol) ? `${r.symbol} is on the watchlist` : `Watch ${r.symbol}`}
                        title={watched.has(r.symbol) ? 'On watchlist' : 'Add to watchlist'}
                        disabled={watched.has(r.symbol)}
                        onClick={(e) => {
                          e.stopPropagation();
                          saveResearch('watch', r.symbol, { name: r.name, addedBy: 'me', addedAt: new Date().toISOString() });
                        }}
                      >
                        <Eye size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
