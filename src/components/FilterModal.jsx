import { useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { DollarSign, Tag, Briefcase, Wallet, CheckSquare, Square, RefreshCw, Search } from 'lucide-react';
import ModalWrapper from './ModalWrapper';
import './FilterModal.css';

const slideVariants = {
  enter: (direction) => ({
    x: direction > 0 ? '100%' : '-100%',
    opacity: 0,
    position: 'relative'
  }),
  center: {
    x: 0,
    opacity: 1,
    position: 'relative'
  },
  exit: (direction) => ({
    x: direction > 0 ? '-100%' : '100%',
    opacity: 0,
    position: 'absolute',
    top: 0, left: 0, right: 0
  })
};

const TAB_ORDER = ['Amount', 'Type', 'Ticker', 'Portfolio'];
const AMOUNT_HEIGHT = 260;
const LIST_HEIGHT = 400;

function FilterListTab({ title, allItems, excludedSet, setExcludedSet }) {
  const [query, setQuery] = useState('');
  
  const filteredItems = useMemo(() => {
    return allItems.filter(item => item.toLowerCase().includes(query.toLowerCase()));
  }, [allItems, query]);

  const handleToggleAll = () => {
    setExcludedSet(new Set());
  };

  const handleToggleNone = () => {
    setExcludedSet(new Set(allItems));
  };

  const dragState = useRef({ isDragging: false, toggledItems: new Set() });

  useEffect(() => {
    const handleMouseUp = () => {
      dragState.current = { isDragging: false, toggledItems: new Set() };
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);

  const handleMouseDown = (item) => {
    dragState.current = { isDragging: true, toggledItems: new Set([item]) };
    
    setExcludedSet(prev => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  };

  const handleMouseEnter = (item) => {
    if (!dragState.current.isDragging) return;
    if (dragState.current.toggledItems.has(item)) return;
    
    dragState.current.toggledItems.add(item);
    
    setExcludedSet(prev => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  };

  const selectedCount = allItems.length - excludedSet.size;

  return (
    <div className="filter-tab-content filter-list-tab">
      <div className="filter-list-header">
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input 
            type="text" 
            placeholder={`Search ${title}...`} 
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      </div>
      
      <div className="filter-list-actions">
        <span className="count-label">{title} ({selectedCount}/{allItems.length})</span>
        <div className="action-buttons">
          <button type="button" onClick={handleToggleAll}><CheckSquare size={16} /> All</button>
          <button type="button" onClick={handleToggleNone}><Square size={16} /> None</button>
        </div>
      </div>

      <div className="filter-list-body">
        {filteredItems.length === 0 ? (
          <div className="empty-state">No items found</div>
        ) : (
          filteredItems.map(item => {
            const isSelected = !excludedSet.has(item);
            return (
              <button 
                key={item} 
                className={`filter-item ${isSelected ? 'selected' : ''}`}
                onMouseDown={() => handleMouseDown(item)}
                onMouseEnter={() => handleMouseEnter(item)}
                style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
              >
                <div className="checkbox">
                  {isSelected ? <CheckSquare size={18} /> : <Square size={18} />}
                </div>
                <span>{item}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function FilterModal({ transactions, initialState, hideTypeTab = false, showOnlyTickerAndPortfolio = false, onApply, onClose }) {
  const tabs = useMemo(() => {
    if (showOnlyTickerAndPortfolio) {
      return [
        { id: 'Ticker', icon: Briefcase },
        { id: 'Portfolio', icon: Wallet },
      ];
    }
    return [
      { id: 'Amount', icon: DollarSign },
      !hideTypeTab && { id: 'Type', icon: Tag },
      { id: 'Ticker', icon: Briefcase },
      { id: 'Portfolio', icon: Wallet },
    ].filter(Boolean);
  }, [hideTypeTab, showOnlyTickerAndPortfolio]);

  const tabOrder = useMemo(() => tabs.map(t => t.id), [tabs]);
  const [activeTab, setActiveTab] = useState(tabOrder[0] || 'Ticker');
  const [direction, setDirection] = useState(0);

  const handleTabChange = (tabId) => {
    const oldIndex = tabOrder.indexOf(activeTab);
    const newIndex = tabOrder.indexOf(tabId);
    setDirection(newIndex > oldIndex ? 1 : -1);
    setActiveTab(tabId);
  };
  
  const [excludedTypes, setExcludedTypes] = useState(new Set(initialState?.excludedTypes || []));
  const [excludedTickers, setExcludedTickers] = useState(new Set(initialState?.excludedTickers || []));
  const [excludedPortfolios, setExcludedPortfolios] = useState(new Set(initialState?.excludedPortfolios || []));
  const [minAmount, setMinAmount] = useState(initialState?.minAmount || '');
  const [maxAmount, setMaxAmount] = useState(initialState?.maxAmount || '');

  const allTypes = useMemo(() => [...new Set(transactions.map(t => (t.type || '').toUpperCase()).filter(Boolean))].sort(), [transactions]);
  const allTickers = useMemo(() => [...new Set(transactions.map(t => (t.asset || t.ticker || '').toUpperCase()).filter(Boolean))].sort(), [transactions]);
  const allPortfolios = useMemo(() => [...new Set(transactions.map(t => t.portfolio).filter(Boolean))].sort(), [transactions]);

  const handleResetAll = () => {
    setExcludedTypes(new Set());
    setExcludedTickers(new Set());
    setExcludedPortfolios(new Set());
    setMinAmount('');
    setMaxAmount('');
  };

  const handleApply = () => {
    onApply({
      excludedTypes,
      excludedTickers,
      excludedPortfolios,
      minAmount,
      maxAmount
    });
  };

  return (
    <ModalWrapper onClose={onClose} zIndex={2000}>
      <div 
        className="filter-modal" 
        onClick={e => e.stopPropagation()}
      >
        <div className="filter-header">
          <h2>{showOnlyTickerAndPortfolio ? 'Filter Graph' : (hideTypeTab ? 'Filter Portfolio' : 'Filter Transactions')}</h2>
          <button className="reset-btn" onClick={handleResetAll}>
            <RefreshCw size={16} /> Reset All
          </button>
        </div>

        <div className="filter-tabs">
          {tabs.map(tab => (
            <button 
              key={tab.id}
              className={`filter-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => handleTabChange(tab.id)}
            >
              <tab.icon size={18} />
              <span>{tab.id}</span>
            </button>
          ))}
        </div>

        <div 
          className="filter-body"
          style={{
            height: `${activeTab === 'Amount' ? AMOUNT_HEIGHT : LIST_HEIGHT}px`,
            transition: 'height 0.25s ease-in-out',
            overflow: 'hidden',
            position: 'relative'
          }}
        >
          <AnimatePresence initial={false} custom={direction} mode="popLayout">
            {activeTab === 'Amount' && (
              <motion.div
                key="amount"
                className="filter-tab-content amount-tab"
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                style={{ width: '100%' }}
              >
                <p className="tab-description">Filter by the total transaction value.</p>
                <div className="amount-inputs">
                  <div className="form-group">
                    <label>Min Amount</label>
                    <div className="input-with-icon">
                      <DollarSign size={18} className="input-icon" />
                      <input 
                        type="number" 
                        placeholder="0" 
                        value={minAmount} 
                        onChange={e => setMinAmount(e.target.value)} 
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Max Amount</label>
                    <div className="input-with-icon">
                      <DollarSign size={18} className="input-icon" />
                      <input 
                        type="number" 
                        placeholder="10000" 
                        value={maxAmount} 
                        onChange={e => setMaxAmount(e.target.value)} 
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'Type' && (
              <motion.div
                key="type"
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                style={{ width: '100%' }}
              >
                <FilterListTab 
                  title="Types" 
                  allItems={allTypes} 
                  excludedSet={excludedTypes} 
                  setExcludedSet={setExcludedTypes}
                />
              </motion.div>
            )}

            {activeTab === 'Ticker' && (
              <motion.div
                key="ticker"
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                style={{ width: '100%' }}
              >
                <FilterListTab 
                  title="Tickers" 
                  allItems={allTickers} 
                  excludedSet={excludedTickers} 
                  setExcludedSet={setExcludedTickers} 
                />
              </motion.div>
            )}

            {activeTab === 'Portfolio' && (
              <motion.div
                key="portfolio"
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                style={{ width: '100%' }}
              >
                <FilterListTab 
                  title="Portfolios" 
                  allItems={allPortfolios} 
                  excludedSet={excludedPortfolios} 
                  setExcludedSet={setExcludedPortfolios} 
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="filter-actions">
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
          <button className="apply-btn" onClick={handleApply}>Apply Filters</button>
        </div>
      </div>
    </ModalWrapper>
  );
}
