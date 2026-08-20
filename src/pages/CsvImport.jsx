import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import {
  ArrowLeft, FileText, Layers, Download, Upload, CheckCircle2, AlertTriangle
} from 'lucide-react';
import { useData } from '../context/DataContext';
import { displayTicker, getCurrencySymbol } from '../utils/format';
import { buildFingerprintIndex, isExactDuplicate, transactionCurrency } from '../utils/transactions';
import { sampleCsv, transactionsToCsv, downloadCsv, todayStamp, CSV_COLUMNS } from '../utils/csv';
import './IbkrImport.css';

/**
 * Import and export transactions as CSV.
 *
 * Styling reuses the IBKR import sheet, as the KTrade importer does, so all
 * three read the same. The previous version was written against class names
 * that did not exist in that stylesheet, which is why it rendered unstyled.
 */
export default function CsvImport() {
  const navigate = useNavigate();
  const { transactions, addTransaction, portfolios } = useData();

  const [tab, setTab] = useState('import');
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState('idle'); // idle | reviewing | importing | done
  const [logs, setLogs] = useState([]);
  const [parsedTxs, setParsedTxs] = useState([]);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [errorMsg, setErrorMsg] = useState('');
  const [dragging, setDragging] = useState(false);
  const [targetPortfolioId, setTargetPortfolioId] = useState('');
  const fileRef = useRef(null);

  const availablePortfolios = portfolios || [];

  useEffect(() => {
    if (availablePortfolios.length > 0 && !targetPortfolioId) {
      const def = availablePortfolios.find((p) => p.isDefault) || availablePortfolios[0];
      setTargetPortfolioId(def.id);
    }
  }, [availablePortfolios, targetPortfolioId]);

  const addLog = (msg) => setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`]);

  // Shared with every other importer: identity is security + side + day +
  // shares + price, so the same trade imports once whatever its source.
  const existingFingerprints = useMemo(() => buildFingerprintIndex(transactions), [transactions]);
  const isDuplicate = (tx) => isExactDuplicate(tx, existingFingerprints);

  /* ---------------------------------------------------------------- parse */

  const parseCsv = (csv) => {
    const results = Papa.parse(csv, { header: true, skipEmptyLines: true });
    if (results.errors.length > 0) {
      throw new Error(`CSV parsing error: ${results.errors[0].message}`);
    }

    const parseDdMmYyyy = (raw) => {
      if (!raw) return null;
      const parts = String(raw).split('/');
      if (parts.length === 3) {
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}T12:00:00Z`);
      }
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const txs = [];
    for (const row of results.data) {
      if (!row.Date || !row.Ticker) continue;

      // Trades only: dividends, taxes and cash transfers are not imported.
      const type = String(row.Type || 'buy').toLowerCase();
      if (type !== 'buy' && type !== 'sell') continue;

      const dateObj = parseDdMmYyyy(row.Date);
      if (!dateObj) continue;

      txs.push({
        id: `csv_${dateObj.getTime()}_${Math.random().toString(36).slice(2, 11)}`,
        source: 'CSV',
        ticker: String(row.Ticker).trim().toUpperCase(),
        type,
        shares: parseFloat(row.Shares) || 0,
        currency: (row.Currency || 'USD').toUpperCase(),
        price: parseFloat(row.Price) || 0,
        fees: parseFloat(row.Fees) || 0,
        amount: parseFloat(row.Amount) || 0,
        date: dateObj.toISOString(),
        note: row.Note || ''
      });
    }
    return txs;
  };

  const handlePreview = () => {
    if (!csvText.trim()) {
      setErrorMsg('Upload a CSV file first.');
      return;
    }
    setErrorMsg('');
    setLogs([]);
    try {
      addLog('Parsing CSV...');
      const parsed = parseCsv(csvText);
      if (parsed.length === 0) {
        throw new Error('No buy or sell rows found. Cash rows are ignored by design.');
      }
      setParsedTxs(parsed);
      const fresh = new Set();
      parsed.forEach((tx, i) => { if (!isDuplicate(tx)) fresh.add(i); });
      setSelectedIndices(fresh);
      addLog(`Ready for review: ${parsed.length} transaction(s).`);
      setStatus('reviewing');
    } catch (err) {
      setErrorMsg(err.message);
      addLog(`Error: ${err.message}`);
      setStatus('idle');
    }
  };

  const readFile = (file) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      setCsvText(e.target.result);
      addLog(`Loaded "${file.name}" (${file.size} bytes).`);
    };
    reader.readAsText(file);
  };

  /* --------------------------------------------------------------- commit */

  const handleCommit = async () => {
    const target = availablePortfolios.find((p) => p.id === targetPortfolioId);
    const targetName = target ? target.name : '';

    const toImport = [];
    for (const idx of selectedIndices) {
      const tx = parsedTxs[idx];
      if (!tx) continue;
      const item = { ...tx };
      if (targetName) item.portfolio = targetName;
      toImport.push(item);
    }

    if (toImport.length === 0) {
      setErrorMsg('No transactions selected.');
      return;
    }

    setStatus('importing');
    addLog(`Saving ${toImport.length} transaction(s)...`);
    try {
      await addTransaction(toImport);
      addLog('Import complete.');
      setStatus('done');
    } catch (err) {
      setErrorMsg(`Failed to save: ${err.message}`);
      addLog(`Save error: ${err.message}`);
      setStatus('reviewing');
    }
  };

  /* --------------------------------------------------------------- export */

  const handleExport = () => {
    if (!transactions || transactions.length === 0) {
      setErrorMsg('There are no transactions to export.');
      return;
    }
    downloadCsv(`stock-tracker-transactions-${todayStamp()}.csv`, transactionsToCsv(transactions));
  };

  const handleTemplate = () => downloadCsv('stock-tracker-template.csv', sampleCsv());

  /* ----------------------------------------------------------------- view */

  const stats = useMemo(() => {
    let dups = 0, buys = 0, sells = 0;
    parsedTxs.forEach((t) => {
      if (isDuplicate(t)) dups += 1;
      if (t.type === 'buy') buys += 1;
      if (t.type === 'sell') sells += 1;
    });
    return { total: parsedTxs.length, dups, buys, sells, newItems: parsedTxs.length - dups };
  }, [parsedTxs, existingFingerprints]);

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

  const money = (value, tx) =>
    `${getCurrencySymbol(transactionCurrency(tx))}${Number(value || 0).toFixed(2)}`;

  return (
    <div className="ibkr-page">
      <div className="ibkr-header">
        <button className="ibkr-back-btn" type="button" onClick={() => navigate('/settings')}>
          <ArrowLeft size={20} />
        </button>
        <div className="ibkr-title-group">
          <h1>CSV Import &amp; Export</h1>
          <p>Bring trades in from a spreadsheet, or take yours out</p>
        </div>
      </div>

      <div className="ibkr-tabs">
        <button type="button" className={`ibkr-tab ${tab === 'import' ? 'active' : ''}`} onClick={() => setTab('import')}>
          <Upload size={16} /> Import
        </button>
        <button type="button" className={`ibkr-tab ${tab === 'export' ? 'active' : ''}`} onClick={() => setTab('export')}>
          <Download size={16} /> Export
        </button>
      </div>

      {tab === 'import' && (
        <div className="ibkr-panel">
          <div
            className={`drop-zone ${dragging ? 'dragging' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files?.[0]); }}
          >
            <FileText size={36} className="drop-icon" />
            <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>
              {fileName || 'Drop a CSV file here'}
            </p>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
              or click to choose a file
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => readFile(e.target.files?.[0])}
          />

          <div className="sync-action-row" style={{ marginTop: '16px' }}>
            <button type="button" className="primary-btn" disabled={!csvText.trim()} onClick={handlePreview}>
              <Upload size={16} /> Preview transactions
            </button>
            <button type="button" className="secondary-btn" onClick={handleTemplate}>
              <Download size={16} /> Download template
            </button>
          </div>

          <div className="help-box" style={{ marginTop: '20px' }}>
            <div className="help-box-title">
              <FileText size={16} /> Expected columns
            </div>
            <ul className="help-box-list">
              <li><code>{CSV_COLUMNS.join(', ')}</code></li>
              <li><strong>Date</strong> is <code>DD/MM/YYYY</code>. <strong>Type</strong> is <code>buy</code> or <code>sell</code>.</li>
              <li>Only <strong>Date</strong>, <strong>Ticker</strong>, <strong>Type</strong>, <strong>Shares</strong> and <strong>Price</strong> are required; <strong>Currency</strong>, <strong>Fees</strong>, <strong>Amount</strong> and <strong>Note</strong> may be left blank.</li>
              <li>Everything imports into the portfolio you pick on the review screen.</li>
              <li>Files exported from the Export tab can be re-imported unchanged.</li>
            </ul>
          </div>
        </div>
      )}

      {tab === 'export' && (
        <div className="ibkr-panel">
          <div className="stats-grid">
            <div className="stat-pill">
              <span className="stat-pill-label">Transactions</span>
              <span className="stat-pill-value">{(transactions || []).length}</span>
            </div>
            <div className="stat-pill">
              <span className="stat-pill-label">Portfolios</span>
              <span className="stat-pill-value">{availablePortfolios.length}</span>
            </div>
          </div>

          <div className="sync-action-row">
            <button type="button" className="primary-btn" onClick={handleExport}>
              <Download size={16} /> Export all transactions
            </button>
            <button type="button" className="secondary-btn" onClick={handleTemplate}>
              <FileText size={16} /> Download blank template
            </button>
          </div>

          <div className="help-box" style={{ marginTop: '20px' }}>
            <div className="help-box-title">
              <CheckCircle2 size={16} /> About the export
            </div>
            <ul className="help-box-list">
              <li>Writes every transaction, oldest first, in the same format the importer reads &mdash; so it doubles as a backup.</li>
              <li>Prices and fees are in each trade&apos;s own currency, with a <code>Currency</code> column alongside.</li>
              <li>Opens cleanly in Excel, Numbers and Google Sheets.</li>
            </ul>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="help-box">
          <div className="help-box-title" style={{ color: '#ef4444' }}>
            <AlertTriangle size={16} /> {errorMsg}
          </div>
        </div>
      )}

      {logs.length > 0 && (
        <div className="log-console">
          {logs.map((line, i) => <div className="log-line" key={i}>{line}</div>)}
        </div>
      )}

      {parsedTxs.length > 0 && status !== 'done' && (
        <div className="ibkr-panel">
          <div className="stats-grid">
            <div className="stat-pill">
              <span className="stat-pill-label">Rows Found</span>
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

              {availablePortfolios.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Layers size={16} style={{ color: 'var(--text-secondary)' }} />
                  <select
                    value={targetPortfolioId}
                    onChange={(e) => setTargetPortfolioId(e.target.value)}
                    style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)', padding: '8px 12px', borderRadius: '10px', fontSize: '13px' }}
                  >
                    {availablePortfolios.map((p) => (
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
                disabled={status === 'importing' || selectedIndices.size === 0}
                onClick={handleCommit}
              >
                Import {selectedIndices.size} transaction{selectedIndices.size === 1 ? '' : 's'}
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
                  <th>Price</th>
                  <th>Fees</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {parsedTxs.map((item, idx) => {
                  const isDup = isDuplicate(item);
                  const amount = item.amount || item.shares * item.price;
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
                      <td>{String(item.date).slice(0, 10)}</td>
                      <td><span className={`type-tag ${item.type.toUpperCase()}`}>{item.type.toUpperCase()}</span></td>
                      <td style={{ fontWeight: '700' }}>{displayTicker(item.ticker)}</td>
                      <td>{item.shares}</td>
                      <td>{money(item.price, item)}</td>
                      <td>{money(item.fees, item)}</td>
                      <td style={{ fontWeight: '600' }}>{money(amount, item)}</td>
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

      {status === 'done' && (
        <div className="ibkr-panel">
          <div className="sync-action-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={18} color="#10b981" />
              <strong>Import complete.</strong>
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
