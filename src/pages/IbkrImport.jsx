import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, RefreshCw, Upload, FileText, CheckCircle2, 
  AlertCircle, Eye, EyeOff, Shield, Database, HelpCircle,
  TrendingUp, TrendingDown, Coins, Receipt, ArrowDownLeft, 
  ArrowUpRight, Check, X, Search, Filter, Layers
} from 'lucide-react';
import { useData } from '../context/DataContext';
import { 
  parseIbkrCsv, 
  syncIbkrFlexService, 
  stampHistoricalRates 
} from '../utils/ibkr_service';
import { formatCurrency, displayTicker } from '../utils/format';
import { buildFingerprintIndex, isExactDuplicate } from '../utils/transactions';
import * as db from '../store/db';
import './IbkrImport.css';

export default function IbkrImport() {
  const navigate = useNavigate();
  const { transactions, addTransaction, portfolios } = useData();

  const [tab, setTab] = useState('flex'); // 'flex' | 'csv'
  const [token, setToken] = useState('');
  const [queryId, setQueryId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [rememberCreds, setRememberCreds] = useState(true);

  // CSV mode states
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Sync / Execution state
  const [status, setStatus] = useState('idle'); // 'idle' | 'syncing' | 'reviewing' | 'success'
  const [logs, setLogs] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [parsedTxs, setParsedTxs] = useState([]);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('ALL');
  const [targetPortfolioId, setTargetPortfolioId] = useState('');

  const logEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const [assetMappings, setAssetMappings] = useState({});

  // Load saved Flex query credentials and mappings
  useEffect(() => {
    async function loadSavedCreds() {
      try {
        const settings = await db.settingsStore.getItem('stocksettings123');
        const saved = settings?.config?.ibkrCredentials;
        if (saved) {
          if (saved.token) setToken(saved.token);
          if (saved.queryId) setQueryId(saved.queryId);
        } else {
          const lsToken = localStorage.getItem('ibkr_flex_token');
          const lsQuery = localStorage.getItem('ibkr_flex_query_id');
          if (lsToken) setToken(lsToken);
          if (lsQuery) setQueryId(lsQuery);
        }
        
        if (settings?.config?.assetMappings) {
          setAssetMappings(settings.config.assetMappings);
        }
      } catch (err) {
        console.warn('Could not load settings:', err);
      }
    }
    loadSavedCreds();
  }, []);

  const addLog = (msg) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    setTimeout(() => {
      if (logEndRef.current) {
        logEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    }, 50);
  };

  // One shared rule across every importer: a trade is the same trade if the
  // security, side, day, share count and price match - regardless of which
  // source it arrived from. See utils/transactions.js.
  const existingFingerprints = useMemo(
    () => buildFingerprintIndex(transactions),
    [transactions]
  );

  const isDuplicate = (tx) => isExactDuplicate(tx, existingFingerprints);

  const applyMappingsAndReview = (txs, currentMappings) => {
    const mapped = txs.map(t => {
      const u = (t.ticker || '').toUpperCase();
      if (u === 'CASH' || !u) return t;
      const m = currentMappings[u];
      if (m) {
        return { ...t, ticker: m.symbol, assetName: m.name };
      }
      return t;
    });
    
    setParsedTxs(mapped);

    // Pre-select non-duplicate records
    const initialSelected = new Set();
    mapped.forEach((tx, idx) => {
      if (!isDuplicate(tx)) {
        initialSelected.add(idx);
      }
    });
    setSelectedIndices(initialSelected);
    setStatus('reviewing');
    addLog(`✨ Successfully loaded ${mapped.length} total transaction(s) for review.`);
  };

  // 1. Action: Sync via Automated Flex Web Service
  const handleFlexSync = async () => {
    if (!token.trim() || !queryId.trim()) {
      setErrorMsg('Please enter both your IBKR Flex Token and Query ID.');
      return;
    }

    // Save credentials if checked
    if (rememberCreds) {
      try {
        localStorage.setItem('ibkr_flex_token', token.trim());
        localStorage.setItem('ibkr_flex_query_id', queryId.trim());
        const settings = await db.settingsStore.getItem('stocksettings123') || { id: 'stocksettings123' };
        settings.config = settings.config || {};
        settings.config.ibkrCredentials = { token: token.trim(), queryId: queryId.trim() };
        settings.pendingSync = true;
        await db.settingsStore.setItem('stocksettings123', settings);
      } catch (e) {}
    }

    setStatus('syncing');
    setLogs([]);
    setErrorMsg('');
    setParsedTxs([]);
    setSelectedIndices(new Set());

    try {
      addLog('Starting IBKR Flex Web Service Sync...');
      const results = await syncIbkrFlexService({ token, queryId }, addLog);

      if (!results || results.length === 0) {
        throw new Error('No transactions returned or query returned 0 rows.');
      }

      // IBKR reports real exchange symbols, which the pricing engine resolves
      // directly - no per-ticker confirmation step needed. Any saved mappings
      // are still applied for tickers the user has previously renamed.
      applyMappingsAndReview(results, assetMappings);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to sync with IBKR.');
      setStatus('idle');
      addLog(`❌ Error: ${err.message}`);
    }
  };

  // 2. Action: Parse Raw CSV or Uploaded File
  const handleCsvParse = async () => {
    if (!csvText.trim()) {
      setErrorMsg('Please upload an IBKR statement file or paste the CSV content.');
      return;
    }

    setStatus('syncing');
    setLogs([]);
    setErrorMsg('');
    setParsedTxs([]);
    setSelectedIndices(new Set());

    try {
      addLog('Parsing IBKR Activity / Flex Query CSV statement...');
      const parsed = parseIbkrCsv(csvText, addLog);

      if (parsed.length === 0) {
        throw new Error('No valid TRNT (Trades) or CTRN (Cash Transactions) found in the provided CSV.');
      }

      addLog(`Found ${parsed.length} raw transactions. Stamping historical USD/PKR rates...`);
      const stamped = await stampHistoricalRates(parsed, addLog);

      applyMappingsAndReview(stamped, assetMappings);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to parse CSV.');
      setStatus('idle');
      addLog(`❌ Error: ${err.message}`);
    }
  };

  // File Upload Handlers
  const handleFileDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) readFile(file);
  };

  const readFile = (file) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      setCsvText(event.target.result);
      addLog(`Loaded file "${file.name}" (${file.size} bytes).`);
    };
    reader.readAsText(file);
  };

  // Table Selection Toggles
  const toggleSelectAll = (onlyNew = false) => {
    if (selectedIndices.size === parsedTxs.length && !onlyNew) {
      setSelectedIndices(new Set());
    } else {
      const next = new Set();
      parsedTxs.forEach((tx, idx) => {
        if (!onlyNew || !isDuplicate(tx)) {
          next.add(idx);
        }
      });
      setSelectedIndices(next);
    }
  };

  const toggleIndex = (idx) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleCommitImport = async () => {
    const toImport = [];
    
    // Look up the name of the selected portfolio
    const targetPortfolio = availablePortfolios.find(p => p.id === targetPortfolioId);
    const targetPortfolioName = targetPortfolio ? targetPortfolio.name : '';

    selectedIndices.forEach((idx) => {
      if (parsedTxs[idx]) {
        const item = { ...parsedTxs[idx] };
        if (targetPortfolioName) {
          item.portfolio = targetPortfolioName;
        }
        toImport.push(item);
      }
    });

    if (toImport.length === 0) {
      alert('Please select at least one transaction to import.');
      return;
    }

    try {
      await addTransaction(toImport);
      setStatus('success');
    } catch (err) {
      alert(`Error saving transactions: ${err.message}`);
    }
  };

  // Stats calculation for review panel
  const stats = React.useMemo(() => {
    let trades = 0;
    let dividends = 0;
    let taxes = 0;
    let cashFlows = 0;
    let dups = 0;

    parsedTxs.forEach((t) => {
      if (t.type === 'BUY' || t.type === 'SELL') trades++;
      else if (t.type === 'DIVIDEND') dividends++;
      else if (t.type === 'TAX') taxes++;
      else if (t.type === 'DEPOSIT' || t.type === 'WITHDRAWAL') cashFlows++;

      if (isDuplicate(t)) dups++;
    });

    return {
      total: parsedTxs.length,
      trades,
      dividends,
      taxes,
      cashFlows,
      duplicates: dups,
      newItems: parsedTxs.length - dups
    };
  }, [parsedTxs]);

  // Filtered list for table view
  const filteredList = React.useMemo(() => {
    return parsedTxs
      .map((tx, originalIndex) => ({ ...tx, originalIndex }))
      .filter((item) => {
        if (filterType !== 'ALL' && item.type !== filterType) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchTicker = item.ticker?.toLowerCase().includes(q);
          const matchDate = item.date?.includes(q);
          const matchNote = item.note?.toLowerCase().includes(q);
          if (!matchTicker && !matchDate && !matchNote) return false;
        }
        return true;
      });
  }, [parsedTxs, filterType, searchQuery]);

  return (
    <div className="page-container">
      <div className="ibkr-page">
        {/* Header */}
        <div className="ibkr-header">
          <button className="ibkr-back-btn" onClick={() => navigate('/settings')} title="Back to Settings">
            <ArrowLeft size={20} />
          </button>
          <div className="ibkr-title-group">
            <h1>Interactive Brokers (IBKR) Sync</h1>
            <p>Import US stocks, ETFs, dividends, withholding taxes, and cash flows automatically or via CSV.</p>
          </div>
        </div>

        {/* Success State */}
        {status === 'success' ? (
          <div className="ibkr-panel" style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <Check size={36} />
            </div>
            <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '8px' }}>Import Successful!</h2>
            <p style={{ color: 'var(--text-secondary)', maxWidth: '480px', margin: '0 auto 24px', lineHeight: '1.5' }}>
              {selectedIndices.size} transaction(s) have been imported into your database and converted with historical USD/PKR exchange rates.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button className="secondary-btn" onClick={() => { setStatus('idle'); setParsedTxs([]); }}>
                Import Another Statement
              </button>
              <button className="primary-btn" onClick={() => navigate('/transactions')}>
                View Transactions
              </button>
              <button className="secondary-btn" onClick={() => navigate('/portfolio')}>
                View Portfolio
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Mode Tabs */}
            {(status === 'idle' || status === 'syncing') && (
              <div className="ibkr-tabs">
                <button 
                  className={`ibkr-tab ${tab === 'flex' ? 'active' : ''}`}
                  onClick={() => setTab('flex')}
                >
                  <RefreshCw size={16} />
                  <span>Flex Web Service (Automatic API)</span>
                </button>
                <button 
                  className={`ibkr-tab ${tab === 'csv' ? 'active' : ''}`}
                  onClick={() => setTab('csv')}
                >
                  <FileText size={16} />
                  <span>Activity Statement (CSV File / Paste)</span>
                </button>
              </div>
            )}

            {/* Panel 1: Flex Query Automated Sync */}
            {(status === 'idle' || status === 'syncing') && tab === 'flex' && (
              <div className="ibkr-panel">
                <div className="form-grid">
                  <div className="input-field">
                    <label>
                      <span>Flex Query Token</span>
                      <span style={{ fontSize: '11px', color: 'var(--accent-color)' }}>Keep confidential</span>
                    </label>
                    <div className="input-wrapper">
                      <input 
                        type={showToken ? 'text' : 'password'}
                        placeholder="e.g. 12345678901234567890"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                      />
                      <button 
                        type="button" 
                        className="toggle-eye-btn"
                        onClick={() => setShowToken(!showToken)}
                        title={showToken ? "Hide Token" : "Show Token"}
                      >
                        {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div className="input-field">
                    <label>
                      <span>Query ID</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>From Flex Query Report</span>
                    </label>
                    <div className="input-wrapper">
                      <input 
                        type="text" 
                        placeholder="e.g. 987654"
                        value={queryId}
                        onChange={(e) => setQueryId(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input 
                    type="checkbox" 
                    id="rememberCreds" 
                    checked={rememberCreds}
                    onChange={(e) => setRememberCreds(e.target.checked)}
                    style={{ cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                  />
                  <label htmlFor="rememberCreds" style={{ fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    Save credentials securely in encrypted settings for 1-click future syncs
                  </label>
                </div>

                {/* Guide Box */}
                <div className="help-box">
                  <div className="help-box-title">
                    <HelpCircle size={16} />
                    <span>How to set up IBKR Flex Query Web Service:</span>
                  </div>
                  <ol className="help-box-list">
                    <li>Log into <strong>Interactive Brokers Client Portal</strong> &rarr; <strong>Performance & Reports</strong> &rarr; <strong>Flex Queries</strong>.</li>
                    <li>Under <strong>Custom Flex Queries</strong>, create a new Trade & Cash Query with <strong>Trades (TRNT)</strong> and <strong>Cash Transactions (CTRN)</strong>.</li>
                    <li>Under <strong>Flex Web Service</strong>, check <em>Enable Flex Web Service</em> to generate your private <strong>Flex Token</strong>.</li>
                    <li>Copy your <strong>Token</strong> and <strong>Query ID</strong> and paste them above.</li>
                  </ol>
                </div>

                <div className="sync-action-row">
                  <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Shield size={14} color="#10b981" />
                    <span>Direct encrypted connection via IBKR XML gateway.</span>
                  </div>
                  <button 
                    className="primary-btn" 
                    onClick={handleFlexSync}
                    disabled={status === 'syncing'}
                  >
                    <RefreshCw size={16} className={status === 'syncing' ? 'spin' : ''} />
                    <span>{status === 'syncing' ? 'Connecting & Syncing...' : 'Sync from Interactive Brokers'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Panel 2: Direct CSV Statement Upload */}
            {(status === 'idle' || status === 'syncing') && tab === 'csv' && (
              <div className="ibkr-panel">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileSelect} 
                  accept=".csv,.txt" 
                  style={{ display: 'none' }} 
                />

                <div 
                  className={`drop-zone ${isDragging ? 'dragging' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleFileDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="drop-icon">
                    <Upload size={24} />
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '15px', color: 'var(--text-primary)' }}>
                      {fileName ? fileName : 'Choose or drop your IBKR CSV statement file here'}
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                      Supports Flex Query CSV, Custom Statement CSV, or Trade Activity Reports.
                    </p>
                  </div>
                </div>

                <div className="input-field">
                  <label>
                    <span>Or paste CSV text directly</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Includes TRNT / CTRN lines</span>
                  </label>
                  <div className="input-wrapper">
                    <textarea 
                      rows={5}
                      placeholder="Paste IBKR report CSV lines here (e.g. BOS,TRNT... or Symbol,TradeDate,Quantity...)"
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                    />
                  </div>
                </div>

                <div className="sync-action-row">
                  <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                    <span>All calculations are executed in memory client-side.</span>
                  </div>
                  <button 
                    className="primary-btn"
                    onClick={handleCsvParse}
                    disabled={status === 'syncing'}
                  >
                    <FileText size={16} />
                    <span>Parse Statement & Calculate FX</span>
                  </button>
                </div>
              </div>
            )}

            {/* Live Progress & Log Console */}
            {logs.length > 0 && (
              <div className="ibkr-panel" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: '600', color: 'var(--text-secondary)' }}>Sync & Parsing Console</span>
                  <span style={{ fontSize: '11px', color: status === 'syncing' ? '#eab308' : '#10b981' }}>
                    {status === 'syncing' ? '● Sync in progress' : '● Complete'}
                  </span>
                </div>
                <div className="log-console">
                  {logs.map((l, i) => (
                    <div key={i} className="log-line">{l}</div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}

            {/* Error Message Alert */}
            {errorMsg && (
              <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '12px', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#ef4444', fontSize: '13.5px' }}>
                <AlertCircle size={18} />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Review & Import Table */}
            {status === 'reviewing' && (
              <div className="ibkr-panel">
                {/* Stats Summary Bar */}
                <div className="stats-grid">
                  <div className="stat-pill">
                    <span className="stat-pill-label">Total Events</span>
                    <span className="stat-pill-value">{stats.total}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-pill-label">New to Import</span>
                    <span className="stat-pill-value" style={{ color: '#10b981' }}>{stats.newItems}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-pill-label">Trades</span>
                    <span className="stat-pill-value" style={{ color: '#10b981' }}>{stats.trades}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-pill-label">Dividends</span>
                    <span className="stat-pill-value" style={{ color: '#10b981' }}>{stats.dividends}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-pill-label">Taxes</span>
                    <span className="stat-pill-value" style={{ color: '#94a3b8' }}>{stats.taxes}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-pill-label">Already In App</span>
                    <span className="stat-pill-value" style={{ color: stats.duplicates > 0 ? '#eab308' : 'var(--text-secondary)' }}>
                      {stats.duplicates}
                    </span>
                  </div>
                </div>

                {/* Controls & Filter Header */}
                <div className="review-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <button className="secondary-btn" onClick={() => toggleSelectAll(false)}>
                      {selectedIndices.size === parsedTxs.length ? 'Deselect All' : 'Select All'}
                    </button>
                    <button className="secondary-btn" onClick={() => toggleSelectAll(true)}>
                      Select Only New ({stats.newItems})
                    </button>

                    {/* Optional Portfolio Destination Selector */}
                    {portfolios && portfolios.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Layers size={16} style={{ color: 'var(--text-secondary)' }} />
                        <select 
                          value={targetPortfolioId}
                          onChange={(e) => setTargetPortfolioId(e.target.value)}
                          style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)', padding: '8px 12px', borderRadius: '10px', fontSize: '13px' }}
                        >
                          <option value="">Default Portfolio</option>
                          {portfolios.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  <div className="review-actions">
                    <input 
                      type="text" 
                      placeholder="Search ticker, date..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '8px 12px', borderRadius: '10px', fontSize: '13px', width: '160px' }}
                    />
                    <select 
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '8px 12px', borderRadius: '10px', fontSize: '13px' }}
                    >
                      <option value="ALL">All Types</option>
                      <option value="BUY">Buys</option>
                      <option value="SELL">Sells</option>
                      <option value="DIVIDEND">Dividends</option>
                      <option value="TAX">Taxes</option>
                      <option value="DEPOSIT">Deposits</option>
                      <option value="WITHDRAWAL">Withdrawals</option>
                    </select>
                  </div>
                </div>

                {/* Transaction Table */}
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
                        <th>Price (USD)</th>
                        <th>Fee</th>
                        <th>Amount (USD)</th>
                        <th>Historical FX</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredList.map((item) => {
                        const isDup = isDuplicate(item);
                        const isSelected = selectedIndices.has(item.originalIndex);

                        return (
                          <tr 
                            key={item.originalIndex}
                            className={isDup ? 'duplicate-row' : ''}
                            onClick={() => toggleIndex(item.originalIndex)}
                            style={{ cursor: 'pointer' }}
                          >
                            <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                              <input 
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleIndex(item.originalIndex)}
                                style={{ cursor: 'pointer', accentColor: 'var(--accent-color)' }}
                              />
                            </td>
                            <td>{item.date}</td>
                            <td>
                              <span className={`type-tag ${item.type}`}>
                                {item.type}
                              </span>
                            </td>
                            <td style={{ fontWeight: '700' }}>{displayTicker(item.ticker)}</td>
                            <td>{item.shares > 0 ? item.shares.toFixed(2) : '—'}</td>
                            <td>{item.price > 0 ? `$${item.price.toFixed(2)}` : '—'}</td>
                            <td>{item.fees > 0 ? `$${item.fees.toFixed(2)}` : '$0.00'}</td>
                            <td style={{ fontWeight: '600' }}>
                              ${item.amount?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                              {item.exchangeRate ? `${item.exchangeRate.toFixed(2)} PKR` : '—'}
                            </td>
                            <td>
                              {isDup ? (
                                <span className="badge-dup">Already in app</span>
                              ) : (
                                <span className="badge-new">New</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Final Action Bar */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px', flexWrap: 'wrap', gap: '16px' }}>
                  <button className="secondary-btn" onClick={() => setStatus('idle')}>
                    Back / Reset
                  </button>
                  <button 
                    className="primary-btn"
                    onClick={handleCommitImport}
                    disabled={selectedIndices.size === 0}
                  >
                    <CheckCircle2 size={18} />
                    <span>Import {selectedIndices.size} Selected Transaction(s)</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

    </div>
  );
}
