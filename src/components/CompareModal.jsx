import { useState, useMemo, useEffect } from 'react';
import { Search, Check, Plus, RefreshCw, X, TrendingUp } from 'lucide-react';
import ModalWrapper from './ModalWrapper';
import { searchSymbols } from '../utils/api';
import './CompareModal.css';

const DEFAULT_BENCHMARKS = [
  { symbol: '^GSPC', name: 'S&P 500', category: 'US Index' },
  { symbol: '^IXIC', name: 'NASDAQ', category: 'US Index' },
  { symbol: '^KSE', name: 'KSE 100', category: 'PKX Index' },
  { symbol: 'GC=F', name: 'Gold', category: 'Commodity' },
];

export default function CompareModal({ selectedBenchmarks = [], onApply, onClose }) {
  const [selectedMap, setSelectedMap] = useState(() => {
    const map = {};
    selectedBenchmarks.forEach(b => {
      map[b.symbol] = b;
    });
    return map;
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchSymbols(searchQuery.trim());
        setSearchResults(results || []);
      } catch (err) {
        console.warn('Compare symbol search failed:', err);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleToggle = (bench) => {
    setSelectedMap(prev => {
      const next = { ...prev };
      if (next[bench.symbol]) {
        delete next[bench.symbol];
      } else {
        next[bench.symbol] = bench;
      }
      return next;
    });
  };

  const handleApply = () => {
    onApply(Object.values(selectedMap));
    onClose();
  };

  return (
    <ModalWrapper onClose={onClose} zIndex={2000}>
      <div className="compare-modal" onClick={e => e.stopPropagation()}>
        <div className="compare-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <TrendingUp size={20} style={{ color: 'var(--accent-color, #6366f1)' }} />
            <h2>Compare Performance</h2>
          </div>
          <button className="icon-btn close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="compare-search-bar">
          <Search size={16} className="search-icon" />
          <input 
            type="text" 
            placeholder="Search index, ETF, or stock (e.g. AAPL, KMI30)..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="clear-search-btn" onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>

        {/* Modal Content List */}
        <div className="compare-body">
          {searchQuery.trim() ? (
            /* Search Results Section */
            <div className="compare-section">
              <span className="section-title">Search Results</span>
              {isSearching ? (
                <div className="loading-state">Searching market quotes...</div>
              ) : searchResults.length === 0 ? (
                <div className="empty-state">No matching assets found</div>
              ) : (
                <div className="bench-grid">
                  {searchResults.map(item => {
                    const isSelected = !!selectedMap[item.symbol];
                    return (
                      <div 
                        key={item.symbol} 
                        className={`bench-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleToggle(item)}
                      >
                        <div className="bench-info">
                          <span className="bench-symbol">{item.symbol}</span>
                          <span className="bench-name">{item.name}</span>
                        </div>
                        <div className={`checkbox-icon ${isSelected ? 'checked' : ''}`}>
                          {isSelected ? <Check size={14} /> : <Plus size={14} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Default Indexes Section */
            <div className="compare-section">
              <span className="section-title">Major Benchmarks</span>
              <div className="bench-grid">
                {DEFAULT_BENCHMARKS.map(item => {
                  const isSelected = !!selectedMap[item.symbol];
                  return (
                    <div 
                      key={item.symbol} 
                      className={`bench-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleToggle(item)}
                    >
                      <div className="bench-info">
                        <span className="bench-symbol">{item.name}</span>
                        <span className="bench-name">{item.symbol} • {item.category}</span>
                      </div>
                      <div className={`checkbox-icon ${isSelected ? 'checked' : ''}`}>
                        {isSelected ? <Check size={14} /> : <Plus size={14} />}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Selected Custom Tickers if any */}
              {Object.values(selectedMap).some(b => !DEFAULT_BENCHMARKS.some(d => d.symbol === b.symbol)) && (
                <div className="compare-section" style={{ marginTop: '16px' }}>
                  <span className="section-title">Custom Selected Assets</span>
                  <div className="bench-grid">
                    {Object.values(selectedMap)
                      .filter(b => !DEFAULT_BENCHMARKS.some(d => d.symbol === b.symbol))
                      .map(item => (
                        <div 
                          key={item.symbol} 
                          className="bench-card selected"
                          onClick={() => handleToggle(item)}
                        >
                          <div className="bench-info">
                            <span className="bench-symbol">{item.symbol}</span>
                            <span className="bench-name">{item.name}</span>
                          </div>
                          <div className="checkbox-icon checked">
                            <Check size={14} />
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="compare-footer">
          <button className="btn-secondary" onClick={() => setSelectedMap({})}>
            Clear All
          </button>
          <button className="btn-primary" onClick={handleApply}>
            Apply Benchmarks ({Object.keys(selectedMap).length})
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
