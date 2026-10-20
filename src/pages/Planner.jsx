import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useData } from '../context/DataContext';
import { useAppearanceSettings } from '../context/SettingsContext';
import { fetchBatchPrices } from '../utils/api';
import { computePositions, planContribution } from '../utils/portfolio_analytics';
import { displayTicker } from '../utils/format';
import { Panel, Segmented, Empty, Notice, SymbolLink, fmtMoney, fmtPct } from '../components/research/ResearchUI';
import SymbolPicker from '../components/research/SymbolPicker';
import ModelPortfolio from '../components/research/ModelPortfolio';
import './Research.css';

export default function Planner() {
  const { transactions, livePrices, exchangeRates, fxSeries, research, saveResearch } = useData();
  const { baseCurrency } = useAppearanceSettings();
  const targetsRec = research.find((r) => r.kind === 'targets');
  const settingsRec = research.find((r) => r.kind === 'settings');
  const settings = settingsRec?.data || {};

  const [currency, setCurrency] = useState(settings.monthlyContribution?.currency || (baseCurrency === 'PKR' ? 'PKR' : 'USD'));
  const [amount, setAmount] = useState(settings.monthlyContribution?.amount ? String(settings.monthlyContribution.amount) : '');
  const [wholeShares, setWholeShares] = useState(true);
  const [draft, setDraft] = useState(null); // { TICKER: percent string }
  const [picking, setPicking] = useState(false);
  const [extraPrices, setExtraPrices] = useState({});
  const [rf, setRf] = useState({ PKR: settings.riskFreeRate?.PKR != null ? String(settings.riskFreeRate.PKR * 100) : '', USD: settings.riskFreeRate?.USD != null ? String(settings.riskFreeRate.USD * 100) : '' });

  // Research records load after first render; fill the inputs once they do,
  // without overwriting anything already typed.
  useEffect(() => {
    if (!settingsRec) return;
    const d = settingsRec.data || {};
    setRf((cur) => ({
      PKR: cur.PKR !== '' ? cur.PKR : d.riskFreeRate?.PKR != null ? String(Math.round(d.riskFreeRate.PKR * 10000) / 100) : '',
      USD: cur.USD !== '' ? cur.USD : d.riskFreeRate?.USD != null ? String(Math.round(d.riskFreeRate.USD * 10000) / 100) : ''
    }));
    if (d.monthlyContribution?.amount) {
      setAmount((cur) => cur || String(d.monthlyContribution.amount));
      setCurrency(d.monthlyContribution.currency || currency);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRec?.id]);

  const fxRate = exchangeRates?.PKR || 278;
  const positions = useMemo(() => computePositions(transactions, livePrices, { displayCurrency: currency, fxRate, fxSeries }), [transactions, livePrices, currency, fxRate, fxSeries]);

  const saved = targetsRec?.data?.targets || {};
  const editing = draft !== null;
  const targetPct = editing ? draft : Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, String(Math.round(v * 1000) / 10)]));
  const tickers = [...new Set([...positions.holdings.map((h) => h.ticker), ...Object.keys(targetPct)])];
  const totalPct = Object.values(targetPct).reduce((a, v) => a + (Number(v) || 0), 0);

  // Prices for targeted tickers that are not held yet.
  const unheld = Object.keys(targetPct).filter((t) => !positions.holdings.some((h) => h.ticker === t)).sort().join(',');
  useEffect(() => {
    if (!unheld) return;
    fetchBatchPrices(unheld.split(',')).then(setExtraPrices);
  }, [unheld]);

  const plan = useMemo(() => {
    const amt = Number(amount);
    const t = Object.fromEntries(Object.entries(targetPct).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0));
    if (!(amt > 0) || !Object.keys(t).length) return null;
    const prices = {};
    for (const [s, q] of Object.entries(extraPrices)) {
      const native = String(q.currency || 'USD').toUpperCase();
      prices[s] = native === currency ? q.price : native === 'PKR' ? q.price / fxRate : q.price * fxRate;
    }
    return planContribution(positions.holdings, t, amt, { prices, wholeShares });
  }, [amount, targetPct, positions.holdings, extraPrices, currency, fxRate, wholeShares]);

  const saveTargets = async () => {
    const t = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, (Number(v) || 0) / 100]).filter(([, v]) => v > 0));
    const sum = Object.values(t).reduce((a, b) => a + b, 0) || 1;
    await saveResearch('targets', '*', { targets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v / sum])), setBy: 'me', rationale: null }, { replace: true });
    setDraft(null);
  };

  const saveSettings = async () => {
    const next = { riskFreeRate: {} };
    if (rf.PKR !== '') next.riskFreeRate.PKR = Number(rf.PKR) / 100;
    if (rf.USD !== '') next.riskFreeRate.USD = Number(rf.USD) / 100;
    if (Number(amount) > 0) next.monthlyContribution = { amount: Number(amount), currency };
    await saveResearch('settings', '*', next);
  };

  const current = Object.fromEntries(positions.holdings.map((h) => [h.ticker, h.weight]));

  return (
    <div className="rs-page">
      <div className="rs-header">
        <div>
          <h1 className="rs-title">Planner</h1>
          <p className="rs-subtitle">Set a target mix, then see where each month's money should go. New money only, nothing is sold.</p>
        </div>
        <Segmented label="Currency" options={['USD', 'PKR']} value={currency} onChange={setCurrency} />
      </div>

      <div className="rs-grid-2">
        <Panel
          title="Target allocation"
          subtitle={targetsRec ? `Set by ${targetsRec.data?.setBy === 'Claude' ? 'Claude' : targetsRec.data?.setBy === 'model' ? 'the model' : 'you'}${targetsRec.data?.updatedAt ? ` · ${String(targetsRec.data.updatedAt).slice(0, 10)}` : ''}` : 'No targets yet'}
          action={
            editing ? (
              <div className="rs-row">
                <button type="button" className="rs-btn" onClick={() => setDraft(null)}>Cancel</button>
                <button type="button" className="rs-btn primary" onClick={saveTargets} disabled={!(totalPct > 0)}>Save</button>
              </div>
            ) : (
              <button type="button" className="rs-btn" onClick={() => setDraft({ ...targetPct })}>Edit</button>
            )
          }
        >
          {targetsRec?.data?.rationale && !editing && <p className="rs-panel-sub" style={{ marginBottom: 12, color: 'var(--text-secondary)' }}>{targetsRec.data.rationale}</p>}
          {tickers.length === 0 ? (
            <Empty>No holdings yet. Add a ticker to start a target mix.</Empty>
          ) : (
            <div className="rs-table-wrap">
              <table className="rs-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num">Now</th>
                    <th className="num">Target</th>
                    <th className="num">Gap</th>
                    {editing && <th />}
                  </tr>
                </thead>
                <tbody>
                  {tickers.map((t) => {
                    const target = (Number(targetPct[t]) || 0) / (totalPct || 100);
                    const gap = targetPct[t] != null ? target - (current[t] || 0) : null;
                    return (
                      <tr key={t}>
                        <td><SymbolLink symbol={t} /></td>
                        <td className="num">{fmtPct(current[t] || 0)}</td>
                        <td className="num">
                          {editing ? (
                            <input
                              className="rs-input"
                              type="number"
                              min="0"
                              step="0.5"
                              aria-label={`Target % for ${t}`}
                              value={draft[t] ?? ''}
                              onChange={(e) => setDraft({ ...draft, [t]: e.target.value })}
                              style={{ width: 72, textAlign: 'right' }}
                            />
                          ) : targetPct[t] != null ? (
                            fmtPct(target)
                          ) : (
                            <span className="rs-muted">none</span>
                          )}
                        </td>
                        <td className={`num ${gap > 0.005 ? 'rs-gain' : gap < -0.005 ? 'rs-loss' : ''}`}>{gap == null ? '—' : fmtPct(gap, { signed: true })}</td>
                        {editing && (
                          <td>
                            <button type="button" className="glass-icon-btn" style={{ width: 28, height: 28, borderRadius: 9 }} aria-label={`Clear target for ${t}`} onClick={() => { const d = { ...draft }; delete d[t]; setDraft(d); }}>
                              <X size={13} />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {editing && (
            <div className="rs-row" style={{ marginTop: 12 }}>
              <button type="button" className="rs-btn" onClick={() => setPicking(true)}><Plus size={14} /> Add ticker</button>
              <span className="rs-spacer" />
              <span className={Math.abs(totalPct - 100) < 0.01 ? 'rs-secondary' : 'rs-muted'} style={{ fontSize: 12.5 }}>
                Total {totalPct.toFixed(1)}%{Math.abs(totalPct - 100) >= 0.01 ? ' (will be scaled to 100%)' : ''}
              </span>
            </div>
          )}
        </Panel>

        <Panel title="This month's contribution" subtitle="Buys the positions furthest below target first">
          <div className="rs-filters" style={{ marginBottom: 14 }}>
            <div className="rs-field">
              <label htmlFor="pl-amt">Amount ({currency})</label>
              <input id="pl-amt" className="rs-input" type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 140 }} />
            </div>
            <label className="rs-row" style={{ fontSize: 13, color: 'var(--text-secondary)', paddingBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={wholeShares} onChange={(e) => setWholeShares(e.target.checked)} /> Whole shares only
            </label>
          </div>
          {!plan ? (
            <Empty>{Object.keys(targetPct).length ? 'Enter an amount.' : 'Set targets first (or ask Claude to propose some).'}</Empty>
          ) : (
            <>
              <div className="rs-table-wrap">
                <table className="rs-table">
                  <thead>
                    <tr>
                      <th>Buy</th>
                      <th className="num">Shares</th>
                      <th className="num">At</th>
                      <th className="num">Amount</th>
                      <th className="num">Weight after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.buys.map((b) => {
                      const after = plan.after.find((r) => r.ticker === b.ticker);
                      return (
                        <tr key={b.ticker}>
                          <td className="rs-sym">{displayTicker(b.ticker)}</td>
                          <td className="num">{b.shares == null ? '—' : wholeShares ? b.shares : b.shares.toFixed(3)}</td>
                          <td className="num">{fmtMoney(b.price, currency)}</td>
                          <td className="num">{fmtMoney(b.amount, currency)}</td>
                          <td className="num">{fmtPct(after?.weight)} <span className="rs-muted">/ {fmtPct(after?.target)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {plan.leftover > 0.01 && <p className="rs-panel-sub" style={{ marginTop: 10 }}>Left over after whole shares: {fmtMoney(plan.leftover, currency)}</p>}
              {plan.warnings.map((w) => <Notice key={w}>{w}</Notice>)}
              <p className="rs-panel-sub" style={{ marginTop: 10 }}>
                Prices are converted at today's rate (1 USD = {fxRate.toFixed(2)} PKR). PSX buys settle in PKR, international ones in USD.
              </p>
            </>
          )}
        </Panel>
      </div>

      <ModelPortfolio
        onUseAsTargets={async (weights) => {
          const t = Object.fromEntries(Object.entries(weights).filter(([, w]) => w >= 0.005));
          const sum = Object.values(t).reduce((a, b) => a + b, 0) || 1;
          await saveResearch(
            'targets',
            '*',
            {
              targets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v / sum])),
              setBy: 'model',
              rationale: `Model portfolio (Black-Litterman within policy sleeves), ${new Date().toISOString().slice(0, 10)}.`
            },
            { replace: true }
          );
        }}
      />

      <Panel title="Analysis settings" subtitle="Used by the X-ray for Sharpe ratio and alpha, and as this page's default amount. Claude can set these too.">
        <div className="rs-filters">
          <div className="rs-field">
            <label htmlFor="rf-pkr">Risk-free rate PKR %</label>
            <input id="rf-pkr" className="rs-input" type="number" step="0.1" value={rf.PKR} onChange={(e) => setRf({ ...rf, PKR: e.target.value })} placeholder="e.g. T-bill yield" style={{ width: 130 }} />
          </div>
          <div className="rs-field">
            <label htmlFor="rf-usd">Risk-free rate USD %</label>
            <input id="rf-usd" className="rs-input" type="number" step="0.1" value={rf.USD} onChange={(e) => setRf({ ...rf, USD: e.target.value })} style={{ width: 130 }} />
          </div>
          <button type="button" className="rs-btn primary" onClick={saveSettings}>Save settings</button>
          {settings.riskFreeSource && <span className="rs-panel-sub">Rates source: {settings.riskFreeSource}</span>}
        </div>
      </Panel>

      {picking && (
        <SymbolPicker
          onClose={() => setPicking(false)}
          onSelect={(a) => {
            setPicking(false);
            if (a?.symbol) setDraft({ ...draft, [a.symbol.toUpperCase()]: draft[a.symbol.toUpperCase()] ?? '5' });
          }}
        />
      )}
    </div>
  );
}
