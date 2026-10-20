import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { useData } from '../context/DataContext';
import { fetchBatchPrices, fetchTechnicalsBatch } from '../utils/api';
import { Panel, Empty, Tag, SymbolLink, fmtMoney, fmtPct, fmtNum, toneOf } from '../components/research/ResearchUI';
import SymbolPicker from '../components/research/SymbolPicker';
import './Research.css';

const TREND_TONE = { uptrend: 'good', downtrend: 'serious', sideways: 'info' };

export default function Watchlist() {
  const { research, saveResearch, removeResearch } = useData();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [quotes, setQuotes] = useState({});
  const [tech, setTech] = useState({});

  const entries = useMemo(
    () => research.filter((r) => r.kind === 'watch').sort((a, b) => String(b.data?.addedAt || b.data?.updatedAt || '').localeCompare(String(a.data?.addedAt || a.data?.updatedAt || ''))),
    [research]
  );
  const key = entries.map((e) => e.symbol).sort().join(',');

  useEffect(() => {
    if (!key) return;
    let live = true;
    const symbols = key.split(',');
    fetchBatchPrices(symbols).then((q) => live && setQuotes(q));
    fetchTechnicalsBatch(symbols).then((t) => live && setTech(t));
    return () => {
      live = false;
    };
  }, [key]);

  const add = async (asset) => {
    setPicking(false);
    if (!asset?.symbol) return;
    await saveResearch('watch', asset.symbol, { name: asset.name, addedBy: 'me', addedAt: new Date().toISOString() });
  };

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Watchlist</h1>
          <p className="rs-subtitle">Stocks you are following but may not hold. Claude can add entries with a thesis and an entry price.</p>
        </div>
        <button type="button" className="rs-btn primary" onClick={() => setPicking(true)}>
          <Plus size={15} /> Add symbol
        </button>
      </div>

      <Panel>
        {entries.length === 0 ? (
          <Empty title="Nothing on the watchlist">Add a symbol, or ask Claude to screen for ideas and add the best ones here.</Empty>
        ) : (
          <div className="rs-table-wrap">
            <table className="rs-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Price</th>
                  <th className="num">Today</th>
                  <th className="num">1Y</th>
                  <th className="num">From 52w high</th>
                  <th className="num">RSI</th>
                  <th>Trend</th>
                  <th className="num">Entry price</th>
                  <th>Thesis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const q = quotes[e.symbol];
                  const t = tech[e.symbol];
                  const target = e.data?.targetPrice;
                  const gap = target && q?.price ? q.price / target - 1 : null;
                  return (
                    <tr key={e.id} className="clickable" onClick={() => navigate(`/research/${encodeURIComponent(e.symbol)}`)}>
                      <td>
                        <SymbolLink symbol={e.symbol} name={q?.name || e.data?.name} />
                      </td>
                      <td className="num">{fmtMoney(q?.price, q?.currency || 'USD')}</td>
                      <td className={`num ${toneOf(q?.changePercent)}`}>{q ? fmtPct(q.changePercent / 100, { signed: true, digits: 2 }) : '—'}</td>
                      <td className={`num ${toneOf(t?.returns?.['1y'])}`}>{fmtPct(t?.returns?.['1y'], { signed: true })}</td>
                      <td className="num">{fmtPct(t?.range52w?.fromHigh)}</td>
                      <td className="num">{fmtNum(t?.rsi14, 0)}</td>
                      <td>{t?.trend ? <Tag tone={TREND_TONE[t.trend]}>{t.trend}</Tag> : '—'}</td>
                      <td className="num" title={gap != null ? `${fmtPct(gap, { signed: true })} vs entry price` : undefined}>
                        {target ? fmtMoney(target, q?.currency || 'USD') : '—'}
                        {gap != null && <div className={`rs-name ${gap <= 0 ? 'rs-gain' : ''}`}>{gap <= 0 ? 'at or below' : `${fmtPct(gap)} above`}</div>}
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 180, maxWidth: 320 }}>
                        <span className="rs-secondary" style={{ fontSize: 12.5 }}>{e.data?.thesis || ''}</span>
                        {e.data?.addedBy === 'Claude' && <div className="rs-name">added by Claude</div>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="glass-icon-btn"
                          style={{ width: 30, height: 30, borderRadius: 10 }}
                          aria-label={`Remove ${e.symbol}`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            removeResearch(e.id);
                          }}
                        >
                          <X size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {picking && <SymbolPicker onSelect={add} onClose={() => setPicking(false)} />}
    </div>
  );
}
