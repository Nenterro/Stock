import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import './IbkrImport.css';

import { ArrowLeft, UploadCloud, FileText, Check, AlertTriangle, Loader2 } from 'lucide-react';
import AssetMappingModal from '../components/AssetMappingModal';
import { generateId } from '../store/db';
import * as db from '../store/db';

const BudgetImport = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { transactions, addTransaction, portfolios, savePortfolio } = useData();
  
  const [csvText, setCsvText] = useState('');
  const [status, setStatus] = useState('idle'); // idle, mapping, reviewing, importing
  const [logs, setLogs] = useState([]);
  const [parsedTxs, setParsedTxs] = useState([]);
  const [selectedIndices, setSelectedIndices] = useState(new Set());
  const [errorMsg, setErrorMsg] = useState('');
  const [fileName, setFileName] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const [existingTxs, setExistingTxs] = useState([]);
  const [targetPortfolioId, setTargetPortfolioId] = useState('');
  const [availablePortfolios, setAvailablePortfolios] = useState([]);

  const [assetMappings, setAssetMappings] = useState({});
  const [unmappedTickers, setUnmappedTickers] = useState([]);
  const [pendingTxs, setPendingTxs] = useState([]);

  useEffect(() => {
    setExistingTxs(transactions);
    setAvailablePortfolios(portfolios);
    if (portfolios.length > 0) {
      const defaultPort = portfolios.find((p) => p.isDefault) || portfolios[0];
      setTargetPortfolioId(defaultPort.id);
    }
  }, [transactions, portfolios]);

  useEffect(() => {
    async function loadMappings() {
      try {
        const settings = await db.settingsStore.getItem('stocksettings123');
        if (settings?.config?.assetMappings) {
          setAssetMappings(settings.config.assetMappings);
        }
      } catch (err) {
        console.warn('Could not load mappings:', err);
      }
    }
    loadMappings();
  }, []);

  const addLog = (msg) => {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} - ${msg}`]);
  };

  const isDuplicate = (tx) => {
    const txTime = new Date(tx.date).getTime();
    return existingTxs.some((ex) => {
      if (ex.id === tx.id) return true;
      if (ex.ticker !== tx.ticker || ex.type !== tx.type) return false;
      
      const exTime = new Date(ex.date).getTime();
      const timeDiff = Math.abs(exTime - txTime);
      // within same day
      if (timeDiff > 24 * 60 * 60 * 1000) return false;
      
      const exShares = parseFloat(ex.shares) || 0;
      const txShares = parseFloat(tx.shares) || 0;
      if (Math.abs(exShares - txShares) > 0.01) return false;

      const exPrice = parseFloat(ex.price) || 0;
      const txPrice = parseFloat(tx.price) || 0;
      if (Math.abs(exPrice - txPrice) > 0.05) return false;

      const amtDiff = Math.abs((ex.amount || 0) - (tx.amount || 0));
      if (amtDiff > 1) return false;
      return true;
    });
  };

  const parseBudgetCsv = (csv) => {
    const results = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
    });
    
    if (results.errors.length > 0) {
      throw new Error(`CSV Parsing error: ${results.errors[0].message}`);
    }

    const txs = [];
    for (let row of results.data) {
      if (!row['Date'] || !row['Ticker']) continue;
      
      const type = (row['Type'] || 'buy').toLowerCase();
      if (type === 'deposit' || type === 'withdrawal' || type === 'withdraw') {
        continue;
      }

      const dateParts = row['Date'].split('/');
      let dateObj;
      if (dateParts.length === 3) {
        dateObj = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T12:00:00Z`);
      } else {
        dateObj = new Date(row['Date']);
      }

      let settlementDateObj = null;
      if (row['SettlementDate']) {
        const sParts = row['SettlementDate'].split('/');
        if (sParts.length === 3) {
          settlementDateObj = new Date(`${sParts[2]}-${sParts[1]}-${sParts[0]}T12:00:00Z`);
        } else {
          settlementDateObj = new Date(row['SettlementDate']);
        }
      }

      txs.push({
        id: `BUDGET_${dateObj.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
        ticker: row['Ticker'].trim().toUpperCase(),
        type: type,
        shares: parseFloat(row['Shares']) || 0,
        currency: row['Currency'] || 'USD',
        price: parseFloat(row['Price']) || 0,
        fees: parseFloat(row['Fees']) || 0,
        exchangeRate: parseFloat(row['ExchangeRate']) || 1.0,
        amount: parseFloat(row['Amount']) || 0,
        date: dateObj.toISOString(),
        settlementDate: settlementDateObj ? settlementDateObj.toISOString() : null,
        note: row['Note'] || '',
        _csvPortfolioName: row['Portfolio'] ? row['Portfolio'].trim() : '',
      });
    }

    return txs;
  };

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

    const initialSelected = new Set();
    mapped.forEach((tx, idx) => {
      if (!isDuplicate(tx)) {
        initialSelected.add(idx);
      }
    });
    setSelectedIndices(initialSelected);
    setStatus('reviewing');
    addLog(`✨ Ready for review: ${mapped.length} transaction(s).`);
  };

  const handleMappingComplete = async (newMappings) => {
    const updated = { ...assetMappings, ...newMappings };
    setAssetMappings(updated);
    
    try {
      const settings = (await db.settingsStore.getItem('stocksettings123')) || { id: 'stocksettings123', config: {} };
      settings.config = settings.config || {};
      settings.config.assetMappings = updated;
      settings.pendingSync = true;
      await db.settingsStore.setItem('stocksettings123', settings);
    } catch (e) {
      console.warn('Failed to save mappings', e);
    }

    applyMappingsAndReview(pendingTxs, updated);
  };

  const handlePreviewImport = () => {
    if (!csvText.trim()) {
      setErrorMsg('Please upload a budget CSV file or paste the content.');
      return;
    }

    setStatus('syncing');
    setLogs([]);
    setErrorMsg('');
    setParsedTxs([]);
    setSelectedIndices(new Set());

    try {
      addLog('Parsing Budget App CSV export...');
      const parsed = parseBudgetCsv(csvText);

      if (parsed.length === 0) {
        throw new Error('No valid stock transactions found in the provided CSV. (Deposits/Withdrawals are ignored).');
      }

      const uniqueTickers = [...new Set(parsed.map(t => t.ticker).filter(t => t && t.toUpperCase() !== 'CASH'))];
      const unmapped = uniqueTickers.filter(t => !assetMappings[t.toUpperCase()]);

      if (unmapped.length > 0) {
        setUnmappedTickers(unmapped);
        setPendingTxs(parsed);
        setStatus('mapping');
        return;
      }

      applyMappingsAndReview(parsed, assetMappings);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to parse CSV.');
      setStatus('idle');
      addLog(`❌ Error: ${err.message}`);
    }
  };

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
    const portMap = new Map();
    availablePortfolios.forEach(p => portMap.set(p.name.toLowerCase(), p.name));

    const targetPortfolio = availablePortfolios.find(p => p.id === targetPortfolioId);
    const targetPortfolioName = targetPortfolio ? targetPortfolio.name : '';

    const toImport = [];
    
    // We use a regular for...of loop so we can await savePortfolio safely
    for (const idx of selectedIndices) {
      if (parsedTxs[idx]) {
        const item = { ...parsedTxs[idx] };
        const csvPort = item._csvPortfolioName;
        
        if (csvPort) {
          const lowerName = csvPort.toLowerCase();
          if (portMap.has(lowerName)) {
            item.portfolio = portMap.get(lowerName);
          } else {
            // Create portfolio on the fly
            const newId = generateId();
            await savePortfolio({ id: newId, name: csvPort, isDefault: false, color: '#6366f1', icon: 'Briefcase' });
            portMap.set(lowerName, csvPort);
            item.portfolio = csvPort;
            addLog(`Created new portfolio: ${csvPort}`);
          }
        } else if (targetPortfolioName) {
          item.portfolio = targetPortfolioName;
        }
        
        delete item._csvPortfolioName;
        toImport.push(item);
      }
    }

    if (toImport.length === 0) {
      setErrorMsg('No transactions selected.');
      return;
    }

    setStatus('importing');
    addLog(`Committing ${toImport.length} transactions to local store...`);
    try {
      await addTransaction(toImport);
      addLog('✅ Import complete! Transactions saved locally.');
      
      setTimeout(() => {
        navigate('/portfolio');
      }, 1500);
    } catch (err) {
      setErrorMsg(`Failed to save: ${err.message}`);
      setStatus('reviewing');
      addLog(`❌ Save Error: ${err.message}`);
    }
  };

  const getRowClass = (tx, isSelected, isDup) => {
    let classes = ['tr-transaction'];
    if (!isSelected) classes.push('ignored');
    else if (isDup) classes.push('duplicate');
    return classes.join(' ');
  };

  return (
    <div className="ibkr-import-container fade-in">
      <div className="ibkr-header">
        <button className="back-btn" onClick={() => navigate('/settings')}>
          <ArrowLeft size={20} />
          <span>Back</span>
        </button>
        <div className="title-section">
          <div className="title-icon">
            <UploadCloud size={24} />
          </div>
          <div>
            <h1>Import Budget App CSV</h1>
            <p>Sync your old Flutter Budget app stock trades</p>
          </div>
        </div>
      </div>

      <div className="ibkr-content">
        <div className="ibkr-main-col">
          <div className="ibkr-panel">
            <h3>Provide CSV Data</h3>
            
            <div 
              className={`drop-zone ${isDragging ? 'dragging' : ''} ${fileName ? 'has-file' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleFileDrop}
            >
              <UploadCloud size={40} className="drop-icon" />
              <div className="drop-text">
                {fileName ? (
                  <><b>{fileName}</b> loaded successfully.</>
                ) : (
                  <>Drag and drop your <b>stock_transactions_export.csv</b> here</>
                )}
              </div>
              <div className="drop-or">- OR -</div>
              <label className="btn btn-secondary upload-btn">
                Browse File
                <input type="file" accept=".csv" onChange={handleFileSelect} hidden />
              </label>
            </div>

            <div style={{ marginTop: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>Or paste CSV content directly:</label>
              <textarea
                style={{ width: '100%', height: '120px', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                placeholder="Date,Ticker,Type,Shares,Currency,Price,Fees..."
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                disabled={status !== 'idle'}
              />
            </div>

            {status === 'idle' && (
              <button 
                className="btn btn-primary" 
                onClick={handlePreviewImport}
                disabled={!csvText.trim()}
                style={{ marginTop: '20px', width: '100%' }}
              >
                Parse & Preview
              </button>
            )}

            {errorMsg && (
              <div className="status-alert error" style={{ marginTop: '20px' }}>
                <AlertTriangle size={18} />
                <span>{errorMsg}</span>
              </div>
            )}
          </div>

          {(status === 'reviewing' || status === 'importing') && parsedTxs.length > 0 && (
            <div className="ibkr-panel review-panel">
              <div className="review-header">
                <h3>Review & Import</h3>
                <div className="review-actions">
                  <div className="portfolio-select" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '16px' }}>
                    <label style={{ fontSize: '14px' }} title="Used if the CSV row doesn't specify a portfolio">Fallback Portfolio:</label>
                    <select 
                      value={targetPortfolioId} 
                      onChange={(e) => setTargetPortfolioId(e.target.value)}
                      style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                    >
                      {availablePortfolios.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => toggleSelectAll(false)}>
                    Toggle All
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => toggleSelectAll(true)}>
                    Select Only New
                  </button>
                </div>
              </div>

              <div className="table-container" style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px', marginTop: '16px' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}>
                        <input 
                          type="checkbox" 
                          checked={selectedIndices.size === parsedTxs.length}
                          onChange={() => toggleSelectAll(false)}
                        />
                      </th>
                      <th>Status</th>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Ticker</th>
                      <th style={{ textAlign: 'right' }}>Shares</th>
                      <th style={{ textAlign: 'right' }}>Price</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedTxs.map((tx, idx) => {
                      const isDup = isDuplicate(tx);
                      const isSelected = selectedIndices.has(idx);
                      
                      return (
                        <tr key={idx} className={getRowClass(tx, isSelected, isDup)} onClick={() => toggleIndex(idx)}>
                          <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                            <input 
                              type="checkbox" 
                              checked={isSelected}
                              onChange={() => toggleIndex(idx)}
                            />
                          </td>
                          <td>
                            {isDup ? (
                              <span className="badge warning" title="Already exists in database">Duplicate</span>
                            ) : (
                              <span className="badge success">New</span>
                            )}
                          </td>
                          <td>{new Date(tx.date).toLocaleDateString()}</td>
                          <td>
                            <span className={`type-badge ${tx.type}`}>{tx.type.toUpperCase()}</span>
                          </td>
                          <td><strong>{tx.ticker}</strong></td>
                          <td style={{ textAlign: 'right' }}>{tx.shares > 0 ? tx.shares.toFixed(4) : '-'}</td>
                          <td style={{ textAlign: 'right' }}>{tx.price > 0 ? `${tx.currency} ${tx.price.toFixed(2)}` : '-'}</td>
                          <td style={{ textAlign: 'right' }}>{tx.amount > 0 ? `${tx.currency} ${tx.amount.toFixed(2)}` : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="import-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
                <div className="import-summary" style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                  Selected <b>{selectedIndices.size}</b> of <b>{parsedTxs.length}</b> transactions.
                </div>
                <button 
                  className="btn btn-primary"
                  onClick={handleCommitImport}
                  disabled={status === 'importing' || selectedIndices.size === 0}
                >
                  {status === 'importing' ? (
                    <><Loader2 size={16} className="spin" /> Saving...</>
                  ) : (
                    <><Check size={16} /> Import Selected</>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="ibkr-side-col">
          <div className="ibkr-panel logs-panel">
            <h3>Import Log</h3>
            <div className="logs-container">
              {logs.length === 0 && <div className="log-empty">No activity yet.</div>}
              {logs.map((l, i) => (
                <div key={i} className="log-line">{l}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <AssetMappingModal 
        isOpen={status === 'mapping'}
        unmappedTickers={unmappedTickers}
        onComplete={handleMappingComplete}
        onCancel={() => {
          setStatus('idle');
          setUnmappedTickers([]);
          setPendingTxs([]);
        }}
      />
    </div>
  );
};

export default BudgetImport;
