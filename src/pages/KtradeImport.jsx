import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Mail, Upload, RefreshCw, AlertTriangle, CheckCircle2, Layers, FileText
} from 'lucide-react';
import { useData } from '../context/DataContext';
import { fetchKtradeStatus, scanKtradeMail, parseKtradePdf } from '../utils/api';
import { displayTicker } from '../utils/format';
import { buildFingerprintIndex, isExactDuplicate } from '../utils/transactions';
import './IbkrImport.css';

/**
 * Import KTrade (KASB) trade confirmations.
 *
 * Two ways in, one parser behind both: scan the mailbox the backend is
 * authorised for, or drop a confirmation PDF in by hand. Nothing reaches a
 * portfolio until the trades below are reviewed and confirmed.
 *
 * Styling intentionally reuses the IBKR import sheet so both importers look
 * and behave the same.
 */
export default function KtradeImport() {
  const navigate = useNavigate();
  const { transactions, addTransaction, portfolios } = useData();

  const [tab, setTab] = useState('mail');
  const [connection, setConnection] = useState(null);
  const [parsedTxs, setParsedTxs] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [imported, setImported] = useState(0);
  const [since, setSince] = useState('');
  const [targetPortfolioId, setTargetPortfolioId] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  const addLog = useCallback((line) => {
    setLog((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${line}`]);
  }, []);

  const refreshStatus = useCallback(() => {
    fetchKtradeStatus()
      .then(setConnection)
      .catch(() => setConnection({ configured: false, connected: false }));
  }, []);

  useEffect(refreshStatus, [refreshStatus]);

  // Shared with every other importer: identity is security + side + day +
  // shares + price, so the same fill imports once no matter its source.
  const existingFingerprints = useMemo(
    () => buildFingerprintIndex(transactions),
    [transactions]
  );

  const isDuplicate = useCallback(
    (tx) => isExactDuplicate(tx, existingFingerprints),
    [existingFingerprints]
  );

  const receive = useCallback(
    (txs, warns) => {
      setParsedTxs(txs);
      setWarnings(warns || []);
      const fresh = new Set();
      txs.forEach((tx, i) => { if (!isDuplicate(tx)) fresh.add(i); });
      setSelectedIndices(fresh);
      setImported(0);
    },
    [isDuplicate]
  );

  const handleScan = async () => {
    setBusy(true);
    setLog([]);
    addLog(`Searching mail from ${connection?.sender || 'the broker'}...`);
    try {
      const result = await scanKtradeMail({ since: since || undefined });
      if (result?.error) {
        addLog(`Failed: ${result.error}`);
        if (result.hint) addLog(result.hint);
        setParsedTxs([]);
      } else {
        addLog(`Read ${result.scanned || 0} message(s).`);
        (result.messages || []).forEach((m) => {
          if (m.attachments?.length) addLog(`  ${m.subject || m.id}: ${m.attachments.length} confirmation PDF(s)`);
        });
        addLog(`Parsed ${(result.transactions || []).length} trade(s).`);
        receive(result.transactions || [], result.warnings || []);
      }
    } catch (err) {
      addLog(`Scan failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    setBusy(true);
    setLog([]);
    addLog(`Parsing ${file.name}...`);
    try {
      const result = await parseKtradePdf(file);
      if (result?.error) {
        addLog(`Failed: ${result.error}`);
        setParsedTxs([]);
      } else {
        const confs = result.confirmations || [];
        confs.forEach((c) => {
          const r = c.reconciliation || {};
          addLog(
            `  ${c.side} #${c.confirmation} on ${c.tradeDate} — ` +
            (r.ok === true ? 'totals reconcile' : r.ok === false ? 'TOTALS DO NOT RECONCILE' : 'no stated total')
          );
        });
        const bad = confs
          .filter((c) => c.reconciliation?.ok === false)
          .map((c) => ({
            confirmation: c.confirmation,
            issue: `computed ${c.reconciliation.computedTotal} vs stated ${c.reconciliation.statedTotal}`
          }));
        addLog(`Parsed ${confs.length} confirmation(s), ${(result.transactions || []).length} trade(s).`);
        receive(result.transactions || [], bad);
      }
    } catch (err) {
      addLog(`Could not parse that file: ${err.message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const stats = useMemo(() => {
    let dups = 0, buys = 0, sells = 0, fees = 0, value = 0;
    parsedTxs.forEach((t) => {
      if (isDuplicate(t)) dups += 1;
      if (t.type === 'BUY') buys += 1;
      if (t.type === 'SELL') sells += 1;
      fees += t.fees || 0;
      value += t.amount || 0;
    });
    return { total: parsedTxs.length, dups, buys, sells, fees, value, newItems: parsedTxs.length - dups };
  }, [parsedTxs, isDuplicate]);

  const toggleIndex = (idx) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleSelectAll = (onlyNew) => {
    setSelectedIndices((prev) => {
      if (!onlyNew && prev.size === parsedTxs.length) return new Set();
      const next = new Set();
      parsedTxs.forEach((tx, i) => { if (!onlyNew || !isDuplicate(tx)) next.add(i); });
      return next;
    });
  };

  const handleCommit = async () => {
    const target = (portfolios || []).find((p) => p.id === targetPortfolioId);
    const toImport = [];
    selectedIndices.forEach((idx) => {
      if (!parsedTxs[idx]) return;
      const item = { ...parsedTxs[idx] };
      if (target?.name) item.portfolio = target.name;
      toImport.push(item);
    });

    if (toImport.length === 0) return;

    setBusy(true);
    try {
      await addTransaction(toImport);
      setImported(toImport.length);
      addLog(`Imported ${toImport.length} trade(s).`);
    } catch (err) {
      addLog(`Error saving transactions: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const money = (n) =>
    `Rs ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statusColor = connection?.connected ? '#10b981' : connection?.configured ? '#eab308' : '#94a3b8';
  const statusText = !connection
    ? 'Checking backend...'
    : connection.connected
      ? `Connected to ${connection.mailbox}`
      : connection.configured
        ? `Configured, but Gmail is not reachable${connection.error ? ` — ${connection.error}` : ''}`
        : 'Gmail is not configured on the server';

  return (
    <div className="ibkr-page">
      <div className="ibkr-header">
        <button className="ibkr-back-btn" type="button" onClick={() => navigate('/settings')}>
          <ArrowLeft size={20} />
        </button>
        <div className="ibkr-title-group">
          <h1>Import from KTrade</h1>
          <p>Trade confirmations from KASB, by mailbox scan or PDF upload</p>
        </div>
      </div>

      <div className="ibkr-tabs">
        <button
          type="button"
          className={`ibkr-tab ${tab === 'mail' ? 'active' : ''}`}
          onClick={() => setTab('mail')}
        >
          <Mail size={16} /> Mailbox
        </button>
        <button
          type="button"
          className={`ibkr-tab ${tab === 'file' ? 'active' : ''}`}
          onClick={() => setTab('file')}
        >
          <Upload size={16} /> Upload PDF
        </button>
      </div>

      {tab === 'mail' && (
        <div className="ibkr-panel">
          <div className="sync-action-row" style={{ marginBottom: '16px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13.5px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
              <span style={{ color: 'var(--text-secondary)' }}>{statusText}</span>
            </span>
          </div>

          <div className="form-grid">
            <div className="input-field">
              <label htmlFor="ktrade-since">Only mail after</label>
              <div className="input-wrapper">
                <input
                  id="ktrade-since"
                  type="date"
                  value={since}
                  onChange={(e) => setSince(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="sync-action-row">
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !connection?.connected}
              onClick={handleScan}
            >
              <RefreshCw size={16} /> {busy ? 'Scanning...' : 'Scan mailbox'}
            </button>
            <button type="button" className="secondary-btn" onClick={refreshStatus} disabled={busy}>
              Recheck connection
            </button>
          </div>

          {connection && !connection.configured && (
            <div className="help-box" style={{ marginTop: '20px' }}>
              <div className="help-box-title">
                <AlertTriangle size={16} /> Gmail is not set up yet
              </div>
              <ul className="help-box-list">
                <li>Run <code>node backend/scripts/gmail_auth.cjs &lt;CLIENT_ID&gt; &lt;CLIENT_SECRET&gt;</code> on any machine with a browser &mdash; it prints a consent link.</li>
                <li>Approve it as the account that receives the confirmations. The consent screen shows whatever your Google OAuth client is named, which may not say &quot;Stock Tracker&quot;.</li>
                <li>Copy the printed <code>GMAIL_*</code> values into the backend&apos;s environment and restart it, then press Recheck connection.</li>
                <li>None of this is needed for the Upload PDF tab &mdash; that works right now.</li>
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === 'file' && (
        <div className="ibkr-panel">
          <div
            className={`drop-zone ${dragging ? 'dragging' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <FileText size={36} className="drop-icon" />
            <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>Drop a KTrade confirmation PDF here</p>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
              or click to choose a file — no Gmail setup needed
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      )}

      {log.length > 0 && (
        <div className="log-console">
          {log.map((line, i) => (
            <div className="log-line" key={i}>{line}</div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="help-box">
          <div className="help-box-title" style={{ color: '#eab308' }}>
            <AlertTriangle size={16} /> {warnings.length} item{warnings.length === 1 ? '' : 's'} need a look
          </div>
          <ul className="help-box-list">
            {warnings.map((w, i) => (
              <li key={i}>
                <strong>{[w.confirmation && `#${w.confirmation}`, w.ticker, w.file].filter(Boolean).join(' ')}</strong>
                {' '}{w.issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {parsedTxs.length > 0 && imported === 0 && (
        <div className="ibkr-panel">
          <div className="stats-grid">
            <div className="stat-pill">
              <span className="stat-pill-label">Trades Found</span>
              <span className="stat-pill-value">{stats.total}</span>
            </div>
            <div className="stat-pill">
              <span className="stat-pill-label">New to Import</span>
              <span className="stat-pill-value" style={{ color: '#10b981' }}>{stats.newItems}</span>
            </div>
            <div className="stat-pill">
              <span className="stat-pill-label">Buys</span>
              <span className="stat-pill-value" style={{ color: '#10b981' }}>{stats.buys}</span>
            </div>
            <div className="stat-pill">
              <span className="stat-pill-label">Sells</span>
              <span className="stat-pill-value" style={{ color: '#10b981' }}>{stats.sells}</span>
            </div>
            <div className="stat-pill">
              <span className="stat-pill-label">Total Fees</span>
              <span className="stat-pill-value" style={{ fontSize: '15px' }}>{money(stats.fees)}</span>
            </div>
            <div className="stat-pill">
              <span className="stat-pill-label">Already In App</span>
              <span className="stat-pill-value" style={{ color: stats.dups > 0 ? '#eab308' : 'var(--text-secondary)' }}>
                {stats.dups}
              </span>
            </div>
          </div>

          <div className="review-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <button type="button" className="secondary-btn" onClick={() => toggleSelectAll(false)}>
                {selectedIndices.size === parsedTxs.length ? 'Deselect All' : 'Select All'}
              </button>
              <button type="button" className="secondary-btn" onClick={() => toggleSelectAll(true)}>
                Select Only New ({stats.newItems})
              </button>

              {portfolios && portfolios.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Layers size={16} style={{ color: 'var(--text-secondary)' }} />
                  <select
                    value={targetPortfolioId}
                    onChange={(e) => setTargetPortfolioId(e.target.value)}
                    style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)', padding: '8px 12px', borderRadius: '10px', fontSize: '13px' }}
                  >
                    <option value="">Default Portfolio</option>
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="review-actions">
              <button
                type="button"
                className="primary-btn"
                disabled={busy || selectedIndices.size === 0}
                onClick={handleCommit}
              >
                Import {selectedIndices.size} trade{selectedIndices.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>

          <div className="tx-table-container">
            <table className="tx-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={selectedIndices.size === parsedTxs.length && parsedTxs.length > 0}
                      onChange={() => toggleSelectAll(false)}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                    />
                  </th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Symbol</th>
                  <th>Shares</th>
                  <th>Rate (PKR)</th>
                  <th>Fees</th>
                  <th>Amount (PKR)</th>
                  <th>Confirmation</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {parsedTxs.map((item, idx) => {
                  const isDup = isDuplicate(item);
                  return (
                    <tr
                      key={item.id || idx}
                      className={isDup ? 'duplicate-row' : ''}
                      onClick={() => toggleIndex(idx)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIndices.has(idx)}
                          onChange={() => toggleIndex(idx)}
                          style={{ cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                        />
                      </td>
                      <td>{item.date}</td>
                      <td><span className={`type-tag ${item.type}`}>{item.type}</span></td>
                      <td style={{ fontWeight: '700' }}>{displayTicker(item.ticker)}</td>
                      <td>{Number(item.shares).toLocaleString()}</td>
                      <td>{money(item.price)}</td>
                      <td>{money(item.fees)}</td>
                      <td style={{ fontWeight: '600' }}>{money(item.amount)}</td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {item.confirmation || '—'}
                      </td>
                      <td>
                        {isDup
                          ? <span className="badge-dup">Already In App</span>
                          : <span className="badge-new">New</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {imported > 0 && (
        <div className="ibkr-panel">
          <div className="sync-action-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={18} color="#10b981" />
              <strong>Imported {imported} trade{imported === 1 ? '' : 's'}.</strong>
            </span>
            <button type="button" className="primary-btn" onClick={() => navigate('/transactions')}>
              View Transactions
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
