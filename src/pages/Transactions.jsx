import React, { useState, useMemo, useEffect } from 'react';
import { useData } from '../context/DataContext';
import { usePageSettings } from '../context/SettingsContext';
import { Search, Edit2, Trash2, ArrowUpRight, ArrowDownRight, RefreshCcw, Plus, Home, Filter } from 'lucide-react';
import { format, parseISO, isToday, isYesterday, startOfMonth, subMonths, endOfMonth, subDays, startOfYear, isAfter, isBefore } from 'date-fns';
import { NavLink } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';

import AddTransactionModal from '../components/AddTransactionModal';
import UnifiedDropdown from '../components/UnifiedDropdown';
import UnifiedCalendar from '../components/UnifiedCalendar';
import FilterModal from '../components/FilterModal';
import { displayTicker, getCurrencySymbol } from '../utils/format';
import { transactionCurrency } from '../utils/transactions';
import './Transactions.css';

const PERIODS = ['All Time', 'This Month', 'Last Month', 'Last 3 Months', 'This Year', 'Custom Range'];

const getTypeDetails = (type) => {
  const t = (type || '').toLowerCase();
  switch(t) {
    case 'buy': return { icon: ArrowDownRight, color: '#3b82f6' }; 
    case 'sell': return { icon: ArrowUpRight, color: '#f59e0b' }; 
    case 'deposit': return { icon: Plus, color: '#10b981' }; 
    case 'withdrawal': return { icon: ArrowUpRight, color: '#ef4444' }; 
    case 'dividend': return { icon: RefreshCcw, color: '#10b981' }; 
    case 'tax': return { icon: ArrowDownRight, color: '#ef4444' }; 
    default: return { icon: ArrowDownRight, color: '#10b981' }; 
  }
};

export default function Transactions() {
  const { transactions, deleteTransaction, portfolios } = useData();
  const [searchQuery, setSearchQuery] = useState('');
  
  // Independent Page Filter state
  const { 
    selectedPeriod = 'All Time', 
    setSelectedPeriod, 
    customRange = {}, 
    setCustomRange, 
    filterState = { excludedTypes: new Set(), excludedTickers: new Set(), excludedPortfolios: new Set(), minAmount: '', maxAmount: '' }, 
    setFilterState
  } = usePageSettings('transactions');
  
  const [showCustomRangeModal, setShowCustomRangeModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  
  const [editingTx, setEditingTx] = useState(null);
  const [openTxId, setOpenTxId] = useState(null);

  // Click away to close action menu
  useEffect(() => {
    const handleGlobalClick = (e) => {
      if (!e.target.closest('.tx-row')) {
        setOpenTxId(null);
      }
    };
    if (openTxId) {
      document.addEventListener('click', handleGlobalClick);
    }
    return () => document.removeEventListener('click', handleGlobalClick);
  }, [openTxId]);

  const filteredTransactions = useMemo(() => {
    let result = transactions;
    const now = new Date();

    // 1. Period Filter
    if (selectedPeriod !== 'All Time') {
      let start, end = now;
      if (selectedPeriod === 'This Month') start = startOfMonth(now);
      else if (selectedPeriod === 'Last Month') {
        start = startOfMonth(subMonths(now, 1));
        end = endOfMonth(subMonths(now, 1));
      }
      else if (selectedPeriod === 'Last 3 Months') start = subDays(now, 90);
      else if (selectedPeriod === 'This Year') start = startOfYear(now);
      else if (selectedPeriod === 'Custom Range' && customRange.start && customRange.end) {
        start = new Date(customRange.start);
        start.setHours(0, 0, 0, 0);
        end = new Date(customRange.end);
        end.setHours(23, 59, 59, 999);
      }

      result = result.filter(tx => {
        if (!tx.date) return false;
        const d = parseISO(tx.date);
        return isAfter(d, start) && isBefore(d, end);
      });
    }

    // 2. Search Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(tx => 
        (tx.ticker && tx.ticker.toLowerCase().includes(q)) ||
        (tx.note && tx.note.toLowerCase().includes(q)) ||
        (tx.portfolio && tx.portfolio.toLowerCase().includes(q))
      );
    }

    // 3. Advanced Filters (from FilterModal)
    if (filterState.excludedTypes && filterState.excludedTypes.size > 0) {
      result = result.filter(tx => !filterState.excludedTypes.has((tx.type || '').toUpperCase()));
    }
    if (filterState.excludedTickers && filterState.excludedTickers.size > 0) {
      result = result.filter(tx => !filterState.excludedTickers.has((tx.ticker || '').toUpperCase()));
    }
    if (filterState.excludedPortfolios && filterState.excludedPortfolios.size > 0) {
      result = result.filter(tx => !filterState.excludedPortfolios.has(tx.portfolio));
    }
    if (filterState.minAmount !== '' && filterState.minAmount !== null && filterState.minAmount !== undefined) {
      const min = parseFloat(filterState.minAmount);
      result = result.filter(tx => {
        const val = tx.type?.toLowerCase() === 'buy' || tx.type?.toLowerCase() === 'sell' ? (tx.shares * tx.price) : tx.amount;
        return val >= min;
      });
    }
    if (filterState.maxAmount !== '' && filterState.maxAmount !== null && filterState.maxAmount !== undefined) {
      const max = parseFloat(filterState.maxAmount);
      result = result.filter(tx => {
        const val = tx.type?.toLowerCase() === 'buy' || tx.type?.toLowerCase() === 'sell' ? (tx.shares * tx.price) : tx.amount;
        return val <= max;
      });
    }

    return result;
  }, [transactions, selectedPeriod, customRange, searchQuery, filterState]);

  const groupedTransactions = useMemo(() => {
    const groups = {};
    filteredTransactions.forEach(tx => {
      if (!tx.date) return;
      const d = parseISO(tx.date);
      const key = format(d, 'yyyy-MM-dd');
      if (!groups[key]) groups[key] = [];
      groups[key].push(tx);
    });
    return Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(key => ({
      dateString: key,
      transactions: groups[key]
    }));
  }, [filteredTransactions]);

  const formatDateHeader = (dateStr) => {
    const d = parseISO(dateStr);
    if (isToday(d)) return "Today";
    if (isYesterday(d)) return "Yesterday";
    return format(d, 'EEEE, MMM d, yyyy');
  };

  const hasActiveFilters = (filterState.excludedTypes && filterState.excludedTypes.size > 0) || 
    (filterState.excludedTickers && filterState.excludedTickers.size > 0) || 
    (filterState.excludedPortfolios && filterState.excludedPortfolios.size > 0) || 
    filterState.minAmount || 
    filterState.maxAmount;

  return (
    <div className="page-container tx-page">
      {/* Desktop Header */}
      <div className="tx-header-desktop glass-panel desktop-only">
        <h1 className="page-title" style={{ margin: 0 }}>Transactions</h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="portfolio-search-bar" style={{ minWidth: '220px' }}>
            <Search size={16} className="search-icon" />
            <input 
              type="text" 
              placeholder="Search..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div style={{ minWidth: '150px' }}>
            <UnifiedDropdown 
              value={selectedPeriod} 
              onChange={(val) => {
                if (val === 'Custom Range') setShowCustomRangeModal(true);
                else setSelectedPeriod(val);
              }}
              options={PERIODS.map(p => ({ label: p, value: p }))}
            />
          </div>

          <button 
            className={`icon-btn relative ${hasActiveFilters ? 'active-filter' : ''}`}
            title="Filter" 
            onClick={() => setShowFilterModal(true)}
          >
            <Filter size={20} />
            {hasActiveFilters && <span className="filter-badge"></span>}
          </button>
        </div>
      </div>

      {/* Mobile Top Controls */}
      <div className="tx-header mobile-only">
        <div className="tx-header-actions">
          <div className="tx-controls">
            <NavLink to="/" className="icon-btn" title="Home" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 'auto' }}>
              <Home size={20} />
            </NavLink>

            <div style={{ flex: '1 1 auto', minWidth: '130px', maxWidth: '200px' }}>
              <UnifiedDropdown 
                value={selectedPeriod} 
                onChange={(val) => {
                  if (val === 'Custom Range') setShowCustomRangeModal(true);
                  else setSelectedPeriod(val);
                }}
                options={PERIODS.map(p => ({ label: p, value: p }))}
              />
            </div>

            <button 
              className={`icon-btn relative ${hasActiveFilters ? 'active-filter' : ''}`}
              title="Filter" 
              onClick={() => setShowFilterModal(true)}
            >
              <Filter size={20} />
              {hasActiveFilters && <span className="filter-badge"></span>}
            </button>
          </div>

          <div className="tx-search-bar">
            <Search size={18} className="search-icon" />
            <input 
              type="text" 
              placeholder="Search..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* List */}
      <div className="tx-list">
        {groupedTransactions.length === 0 ? (
          <div className="empty-state">
            <Search size={48} className="empty-icon" />
            <p>No transactions found</p>
          </div>
        ) : (
          groupedTransactions.map(group => (
            <div key={group.dateString} className="tx-group">
              <h3 className="tx-date-header">{formatDateHeader(group.dateString)}</h3>
              
              <div className="tx-group-items">
                {group.transactions.map(tx => {
                  const typeLower = (tx.type || '').toLowerCase();
                  const { icon: Icon, color } = getTypeDetails(tx.type);
                  
                  // Calculate display amount and if it's positive/negative
                  const isExpense = typeLower === 'buy' || typeLower === 'withdrawal' || typeLower === 'tax';
                  
                  let displayAmount = tx.amount;
                  if (typeLower === 'buy') {
                    displayAmount = (tx.shares * tx.price) + (tx.fees || 0);
                  } else if (typeLower === 'sell') {
                    displayAmount = (tx.shares * tx.price) - (tx.fees || 0);
                  }

                  return (
                    <div key={tx.id} style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '12px' }}>
                      <div 
                        className={`tx-row glass-panel ${openTxId === tx.id ? 'is-open' : ''}`}
                        onClick={() => setOpenTxId(openTxId === tx.id ? null : tx.id)}
                        style={{ marginBottom: 0 }}
                      >
                        <div className="tx-icon" style={{ backgroundColor: `${color}33`, color: color }}>
                          <Icon size={18} />
                        </div>
                        
                        <div className="tx-main">
                          <div className="tx-payee">
                            {tx.type.charAt(0).toUpperCase() + tx.type.slice(1).toLowerCase()} {tx.ticker ? `- ${displayTicker(tx.ticker)}` : ''}
                          </div>
                          <div className="tx-meta">
                            <span className="tx-category" style={{ color: color }}>{tx.portfolio}</span>
                            {tx.shares > 0 && (
                              <>
                                <span className="tx-dot">•</span>
                                <span className="tx-account">{tx.shares} @ {getCurrencySymbol(transactionCurrency(tx))}{tx.price?.toFixed(2)}</span>
                              </>
                            )}
                          </div>
                          {tx.note && <div className="tx-note">{tx.note}</div>}
                        </div>

                        <div className="tx-right">
                          <div className={`tx-amount ${isExpense ? 'expense' : 'income'}`}>
                            {getCurrencySymbol(transactionCurrency(tx))}{displayAmount?.toFixed(2) || '0.00'}
                          </div>
                          <div className="tx-actions">
                            <button 
                              className="action-btn edit" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                setEditingTx(tx); 
                              }} 
                              title="Edit"
                            ><Edit2 size={16} /></button>
                            <button 
                              className="action-btn delete" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                deleteTransaction(tx.id); 
                              }} 
                              title="Delete"
                            ><Trash2 size={16} /></button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {!!editingTx && (
        <AddTransactionModal 
          isOpen={true} 
          onClose={() => setEditingTx(null)} 
          initialData={editingTx} 
        />
      )}

      <AnimatePresence>
        {showCustomRangeModal && (
          <UnifiedCalendar 
            mode="range"
            value={customRange}
            onChange={(range) => {
              setCustomRange(range);
              setSelectedPeriod('Custom Range');
            }}
            onClose={() => setShowCustomRangeModal(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showFilterModal && (
          <FilterModal 
            transactions={transactions}
            initialState={filterState}
            onApply={(newState) => {
              setFilterState(newState);
              setShowFilterModal(false);
            }}
            onClose={() => setShowFilterModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
