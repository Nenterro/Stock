import React, { useState, useEffect, useRef } from 'react';
import { searchAssetsBackend, fetchPopularAssets } from '../utils/api';
import { displayTicker } from '../utils/format';
import './AssetSelect.css';

// Only used if the backend is unreachable. Deliberately limited to real
// exchange tickers, which are stable; fund symbols are resolved server-side
// against the live universe so the picker can never offer one the pricing
// engine does not recognise.
const OFFLINE_FALLBACK = [
  { symbol: 'OGDC', name: 'Oil & Gas Development Company Limited', exchange: 'PSX', type: 'PSX Stock' },
  { symbol: 'MEBL', name: 'Meezan Bank Limited', exchange: 'PSX', type: 'PSX Stock' },
  { symbol: 'LUCK', name: 'Lucky Cement Limited', exchange: 'PSX', type: 'PSX Stock' },
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'Stock' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'NYSEArca', type: 'ETF' }
];

const TYPE_LABEL = {
  'PSX Stock': 'PSX',
  'Pakistani Mutual Fund': 'Fund',
  'Mutual Fund': 'Fund',
  Stock: 'Stock',
  ETF: 'ETF',
  Crypto: 'Crypto',
  Currency: 'FX',
  Index: 'Index',
  Bond: 'Bond'
};

export default function AssetSelect({
  onSelect,
  onClose,
  ownedAssetsOnly = false,
  ownedAssets = [],
  initialQuery = ''
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [popular, setPopular] = useState(OFFLINE_FALLBACK);
  const listRef = useRef(null);

  useEffect(() => {
    if (ownedAssetsOnly) return;
    let live = true;
    fetchPopularAssets()
      .then(list => {
        if (live && list.length > 0) setPopular(list);
      })
      .catch(() => { /* keep the offline fallback */ });
    return () => { live = false; };
  }, [ownedAssetsOnly]);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    setActiveIndex(0);

    if (ownedAssetsOnly) {
      setResults(
        !q
          ? ownedAssets
          : ownedAssets.filter(
              a =>
                (a.symbol || '').toLowerCase().includes(q) ||
                (a.name || '').toLowerCase().includes(q)
            )
      );
      setLoading(false);
      return;
    }

    if (!q) {
      setResults(popular);
      setLoading(false);
      return;
    }

    setLoading(true);
    // Abort in-flight lookups so a fast typist never sees an older query's
    // results land after a newer one.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const remote = await searchAssetsBackend(query, { limit: 30, signal: controller.signal });
        if (controller.signal.aborted) return;

        // Fall back to filtering the offline set only when the backend gave
        // us nothing at all, so the picker still does something useful when
        // the home server is unreachable.
        setResults(
          remote.length > 0
            ? remote
            : OFFLINE_FALLBACK.filter(
                a => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
              )
        );
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, ownedAssetsOnly, ownedAssets]);

  const handleSelect = (asset) => onSelect(asset, query.trim());

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      handleSelect(results[activeIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="popped-overlay" onClick={onClose}>
      <div className="popped-container glass-panel" onClick={e => e.stopPropagation()}>
        <div className="popped-header">
          <input
            className="popped-input"
            placeholder="Search any stock, ETF or fund (e.g. OGDC, Meezan, AAPL, VOO)..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        <div className="popped-list" ref={listRef}>
          {loading && results.length === 0 ? (
            <div className="popped-item" style={{ color: 'var(--text-secondary)' }}>
              Searching PSX, mutual funds and global markets...
            </div>
          ) : (
            <>
              {results.map((asset, idx) => (
                <button
                  key={`${asset.symbol}-${idx}`}
                  data-idx={idx}
                  className={`popped-item${idx === activeIndex ? ' is-active' : ''}`}
                  onClick={() => handleSelect(asset)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  type="button"
                >
                  <span className="popped-item-symbol">{displayTicker(asset.symbol)}</span>
                  <span className="popped-item-name">
                    {asset.name}
                    {typeof asset.shares === 'number'
                      ? ` • ${Number(asset.shares).toFixed(2)} shares owned`
                      : asset.exchange
                        ? ` • ${asset.exchange}`
                        : ''}
                  </span>
                  {asset.type && (
                    <span className="popped-item-badge">{TYPE_LABEL[asset.type] || asset.type}</span>
                  )}
                </button>
              ))}

              {results.length === 0 && !loading && (
                <div className="popped-item" style={{ color: 'var(--text-secondary)' }}>
                  No results found
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
