import React, { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { searchAssetsBackend } from '../utils/api';
import './AssetSelect.css';

const DEFAULT_POPULAR_ASSETS = [
  { symbol: 'OGDC', name: 'Oil & Gas Development Co', exchange: 'PSX', type: 'PSX Stock' },
  { symbol: 'SYS', name: 'Systems Limited', exchange: 'PSX', type: 'PSX Stock' },
  { symbol: 'MEBL', name: 'Meezan Bank Limited', exchange: 'PSX', type: 'PSX Stock' },
  { symbol: 'MZF', name: 'Meezan Sovereign Fund', exchange: 'Mutual Fund', type: 'Pakistani Mutual Fund' },
  { symbol: 'MIIF', name: 'Meezan Islamic Fund', exchange: 'Mutual Fund', type: 'Pakistani Mutual Fund' },
  { symbol: 'ULPF', name: 'UBL Liquidity Plus Fund', exchange: 'Mutual Fund', type: 'Pakistani Mutual Fund' },
  { symbol: 'MCB-CMO', name: 'MCB Cash Management Optimizer', exchange: 'Mutual Fund', type: 'Pakistani Mutual Fund' },
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'Stock' },
  { symbol: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', type: 'Stock' },
  { symbol: 'SPUS', name: 'SP Funds S&P 500 Sharia Industry ETF', exchange: 'NYSE', type: 'ETF' }
];

export default function AssetSelect({ onSelect, onClose, ownedAssetsOnly = false, ownedAssets = [], initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim().toLowerCase();

    if (ownedAssetsOnly) {
      if (!q) {
        setResults(ownedAssets);
      } else {
        setResults(ownedAssets.filter(a => 
          (a.symbol || '').toLowerCase().includes(q) || 
          (a.name || '').toLowerCase().includes(q)
        ));
      }
      setLoading(false);
      return;
    }

    if (!q) {
      setResults(DEFAULT_POPULAR_ASSETS);
      setLoading(false);
      return;
    }

    const delayDebounceFn = setTimeout(async () => {
      setLoading(true);
      const remoteResults = await searchAssetsBackend(query);

      // Local match against popular assets by BOTH symbol and name
      const localMatches = DEFAULT_POPULAR_ASSETS.filter(a =>
        a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
      );

      // Combine remote and local results avoiding duplicates
      const combined = [...remoteResults];
      for (const loc of localMatches) {
        if (!combined.some(r => r.symbol.toUpperCase() === loc.symbol.toUpperCase())) {
          combined.push(loc);
        }
      }

      setResults(combined);
      setLoading(false);
    }, 250);

    return () => clearTimeout(delayDebounceFn);
  }, [query, ownedAssetsOnly, ownedAssets]);

  const handleSelect = (asset) => {
    onSelect(asset, query.trim());
  };

  const trimmedQuery = query.trim();
  const hasExactMatch = results.some(r => 
    (r.symbol || '').toUpperCase() === trimmedQuery.toUpperCase() ||
    (r.name || '').toLowerCase() === trimmedQuery.toLowerCase()
  );

  return (
    <div className="popped-overlay" onClick={onClose}>
      <div className="popped-container glass-panel" onClick={e => e.stopPropagation()}>
        <div className="popped-header">
          <input 
            className="popped-input"
            placeholder="Search symbol or name (e.g. MZF, Meezan, AAPL)..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        
        <div className="popped-list">
          {loading ? (
            <div className="popped-item" style={{ color: 'var(--text-secondary)' }}>Searching Sarmaaya & Global markets...</div>
          ) : (
            <>
              {results.map((asset) => (
                <button key={asset.symbol} className="popped-item" onClick={() => handleSelect(asset)} type="button">
                  <span className="popped-item-symbol">{asset.symbol}</span>
                  <span className="popped-item-name">
                    {asset.name} {typeof asset.shares === 'number' ? `• ${Number(asset.shares).toFixed(2)} shares owned` : asset.exchange ? `• ${asset.exchange}` : ''}
                  </span>
                </button>
              ))}

              {results.length === 0 && (
                <div className="popped-item" style={{ color: 'var(--text-secondary)' }}>No results found</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
