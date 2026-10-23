import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Download, Check } from 'lucide-react';
import { useData } from '../context/DataContext';
import { fetchBudgetTransactions } from '../store/sync';
import { fetchHistoricalFxRate } from '../utils/api';
import { buildFingerprintIndex, isExactDuplicate } from '../utils/transactions';
import { DEFAULT_CATEGORY, DEFAULT_WITHHOLDING, dividendEntries, matchPayee, grossUp, toTrackerTransactions } from '../utils/budgetDividends';
import { Panel, Empty, Notice, Tag, fmtMoney } from '../components/research/ResearchUI';
import * as db from '../store/db';
import './Research.css';

const SETTINGS_ID = 'stocksettings123';
const payeeKey = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export default function BudgetDividendImport() {
  const navigate = useNavigate();
  const { transactions, addTransaction } = useData();

  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [withholdingPct, setWithholdingPct] = useState(String(DEFAULT_WITHHOLDING * 100));
  const [mappings, setMappings] = useState({});
  const [entries, setEntries] = useState(null);
  const [picks, setPicks] = useState({}); // budgetId -> ticker
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState(null);

  // Saved choices live in the synced settings, like the IBKR credentials.
  useEffect(() => {
    db.settingsStore.getItem(SETTINGS_ID).then((s) => {
      const saved = s?.config?.budgetDividends;
      if (!saved) return;
      if (saved.category) setCategory(saved.category);
      if (saved.withholding != null) setWithholdingPct(String(saved.withholding * 100));
      if (saved.mappings) setMappings(saved.mappings);
    }).catch(() => {});
  }, []);

  const withholding = Math.min(Math.max(Number(withholdingPct) / 100 || 0, 0), 0.9);
  const fingerprints = useMemo(() => buildFingerprintIndex(transactions), [transactions]);

  const pkrTickers = useMemo(() => {
    const names = new Map();
    for (const t of transactions) {
      const type = String(t.type || '').toUpperCase();
      if ((type === 'BUY' || type === 'SELL') && String(t.currency).toUpperCase() === 'PKR' && t.ticker) names.set(t.ticker.toUpperCase(), t.assetName || t.ticker);
    }
    return [...names.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [transactions]);

  const isRecorded = (entry, ticker) => ticker && isExactDuplicate({ ticker, type: 'DIVIDEND', date: entry.date, shares: 0, price: 0 }, fingerprints);

  const load = async () => {
    setLoading(true);
    setError('');
    setImported(null);
    try {
      const rows = dividendEntries(await fetchBudgetTransactions(), category);
      const nextPicks = {};
      const nextSelected = new Set();
      for (const e of rows) {
        const ticker = matchPayee(e.payee, e.date, transactions, { currency: e.currency, mappings });
        nextPicks[e.budgetId] = ticker || '';
        if (ticker && !isRecorded(e, ticker)) nextSelected.add(e.budgetId);
      }
      setEntries(rows);
      setPicks(nextPicks);
      setSelected(nextSelected);
    } catch (err) {
      setError(err.message || 'Could not read the budget app.');
    } finally {
      setLoading(false);
    }
  };

  const setPick = (entry, ticker) => {
    setPicks((p) => ({ ...p, [entry.budgetId]: ticker }));
    setSelected((s) => {
      const next = new Set(s);
      if (ticker && !isRecorded(entry, ticker)) next.add(entry.budgetId);
      else next.delete(entry.budgetId);
      return next;
    });
  };

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const commit = async () => {
    const chosen = (entries || []).filter((e) => selected.has(e.budgetId) && picks[e.budgetId]);
    if (!chosen.length) return;
    setLoading(true);
    try {
      const out = [];
      const learned = { ...mappings };
      for (const e of chosen) {
        const ticker = picks[e.budgetId];
        const lastTrade = transactions
          .filter((t) => String(t.ticker || '').toUpperCase() === ticker && ['BUY', 'SELL'].includes(String(t.type || '').toUpperCase()))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
        const fxRateOnDate = await fetchHistoricalFxRate(e.date).catch(() => null);
        out.push(...toTrackerTransactions(e, ticker, {
          withholding,
          assetName: lastTrade?.assetName,
          portfolio: lastTrade?.portfolio,
          fxRateOnDate: fxRateOnDate || undefined
        }));
        learned[payeeKey(e.payee)] = ticker;
      }
      await addTransaction(out);

      const settings = (await db.settingsStore.getItem(SETTINGS_ID)) || { id: SETTINGS_ID };
      settings.config = { ...(settings.config || {}), budgetDividends: { category, withholding, mappings: learned } };
      settings.pendingSync = true;
      await db.settingsStore.setItem(SETTINGS_ID, settings);
      setMappings(learned);

      setImported(chosen.length);
      setSelected(new Set());
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setLoading(false);
    }
  };

  const ready = (entries || []).filter((e) => selected.has(e.budgetId) && picks[e.budgetId]);

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div className="rs-row">
          <button type="button" onClick={() => navigate('/settings')} className="glass-icon-btn" aria-label="Back" style={{ width: 38, height: 38, borderRadius: 12 }}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="rs-title">Dividends from Budget</h1>
            <p className="rs-subtitle">PSX dividends you logged in the budget app, recorded here as dividend and withholding tax</p>
          </div>
        </div>
      </div>

      <Panel title="Source" subtitle="Income entries in this budget category. Their amounts are what reached the bank, so the dividend is grossed up by the withholding rate.">
        <div className="rs-filters">
          <div className="rs-field">
            <label htmlFor="bd-cat">Budget category</label>
            <input id="bd-cat" className="rs-input" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 180 }} />
          </div>
          <div className="rs-field">
            <label htmlFor="bd-wht">Withholding %</label>
            <input id="bd-wht" className="rs-input" type="number" min="0" max="90" step="0.5" value={withholdingPct} onChange={(e) => setWithholdingPct(e.target.value)} style={{ width: 110 }} />
          </div>
          <button type="button" className="rs-btn primary" onClick={load} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} /> {entries ? 'Reload' : 'Load from Budget'}
          </button>
        </div>
        <p className="rs-panel-sub" style={{ marginTop: 12 }}>15% is the rate for filers on the Active Taxpayer List; non-filers pay 30%.</p>
      </Panel>

      {error && <Notice>{error}</Notice>}
      {imported != null && (
        <Notice>
          Imported {imported} dividend{imported === 1 ? '' : 's'} with their withholding tax. Performance and income now include them.
        </Notice>
      )}

      {entries && (
        <Panel
          title="Review"
          subtitle={`${entries.length} budget entr${entries.length === 1 ? 'y' : 'ies'} in “${category}”. Pick the stock where it couldn't be matched; the choice is remembered for that payee.`}
          action={
            <button type="button" className="rs-btn primary" onClick={commit} disabled={loading || !ready.length}>
              <Download size={15} /> Import {ready.length || ''}
            </button>
          }
        >
          {entries.length === 0 ? (
            <Empty title="Nothing found">No income entries in “{category}”. Check the category name matches the budget app's.</Empty>
          ) : (
            <div className="rs-table-wrap">
              <table className="rs-table">
                <thead>
                  <tr>
                    <th />
                    <th>Paid</th>
                    <th>Budget payee</th>
                    <th>Stock</th>
                    <th className="num">Received</th>
                    <th className="num">Dividend (gross)</th>
                    <th className="num">Tax</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const ticker = picks[e.budgetId];
                    const recorded = isRecorded(e, ticker);
                    const { gross, tax } = grossUp(e.net, withholding);
                    return (
                      <tr key={e.budgetId}>
                        <td>
                          <input type="checkbox" checked={selected.has(e.budgetId)} disabled={!ticker} onChange={() => toggle(e.budgetId)} aria-label={`Import ${e.payee} ${e.date}`} style={{ accentColor: 'var(--accent-color)' }} />
                        </td>
                        <td>{e.date}</td>
                        <td>{e.payee}</td>
                        <td>
                          <select className="rs-select" value={ticker || ''} onChange={(ev) => setPick(e, ev.target.value)} aria-label={`Stock for ${e.payee}`}>
                            <option value="">Choose…</option>
                            {pkrTickers.map(([t, name]) => (
                              <option key={t} value={t}>{t} · {name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="num">{fmtMoney(e.net, e.currency, { decimals: 2 })}</td>
                        <td className="num">{fmtMoney(gross, e.currency, { decimals: 2 })}</td>
                        <td className="num rs-secondary">{tax > 0 ? fmtMoney(-tax, e.currency, { decimals: 2 }) : '—'}</td>
                        <td>
                          {!ticker ? <Tag tone="warning">Needs a stock</Tag> : recorded ? <Tag tone="info">Already recorded</Tag> : <Tag tone="good">New</Tag>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {ready.length > 0 && (
            <p className="rs-panel-sub" style={{ marginTop: 12 }}>
              <Check size={13} style={{ verticalAlign: '-2px' }} /> Each import adds a dividend and a tax entry to the stock's portfolio.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
