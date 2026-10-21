import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  X, Calendar, ArrowDown, ArrowUp, Wallet, ArrowUpRight, 
  Tag, Briefcase, Search, DollarSign
} from 'lucide-react';
import AssetSelect from './AssetSelect';
import UnifiedDropdown from './UnifiedDropdown';
import UnifiedCalendar from './UnifiedCalendar';
import PoppedFieldOverlay from './PoppedFieldOverlay';
import { useData } from '../context/DataContext';
import { fetchHistoricalFxRate } from '../utils/api';
import * as db from '../store/db';
import './AddTransactionModal.css';
import { displayTicker } from '../utils/format';

// Trades only. Dividends and taxes were removed deliberately: the importers no
// longer bring cash events in either, so the tracker records buys and sells.
const TX_TYPES = [
  { id: 'BUY', label: 'Buy', icon: ArrowDown, color: '#EF5350', bg: 'rgba(239, 83, 80, 0.15)' },
  { id: 'SELL', label: 'Sell', icon: ArrowUp, color: '#81C784', bg: 'rgba(129, 199, 132, 0.15)' },
];

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

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 767);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 767);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

export default function AddTransactionModal({ isOpen, onClose, initialData = null }) {
  const { addTransaction, transactions } = useData();
  const isMobile = useIsMobile();
  
  const [type, setType] = useState('BUY');
  const [direction, setDirection] = useState(1);
  const [asset, setAsset] = useState(null);
  
  const [date, setDate] = useState(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });
  
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fees, setFees] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [portfolio, setPortfolio] = useState('Main');
  const [activeField, setActiveField] = useState(null); // For popped overlay

  useEffect(() => {
    if (initialData) {
      setType((initialData.type || 'BUY').toUpperCase());
      const ticker = initialData.ticker || initialData.asset || '';
      if (ticker && ticker !== 'CASH') {
        setAsset({ symbol: ticker, name: initialData.assetName || initialData.name || ticker });
      } else {
        setAsset(null);
      }
      setDate(initialData.date ? initialData.date.split('T')[0] : new Date().toISOString().split('T')[0]);
      setShares(initialData.shares !== undefined && initialData.shares !== null ? String(initialData.shares) : '');
      setPrice(initialData.price !== undefined && initialData.price !== null ? String(initialData.price) : '');
      setFees(initialData.fees !== undefined && initialData.fees !== null ? String(initialData.fees) : '');
      setAmount(initialData.amount !== undefined && initialData.amount !== null ? String(Math.abs(initialData.amount)) : '');
      setCurrency(initialData.currency || 'USD');
      setPortfolio(initialData.portfolio || 'Main');
    } else {
      setType('BUY');
      setAsset(null);
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      setDate(`${yyyy}-${mm}-${dd}`);
      setShares('');
      setPrice('');
      setFees('');
      setAmount('');
      setCurrency('USD');
      setPortfolio('Main');
    }
  }, [initialData, isOpen]);

  const isTradeType = type === 'BUY' || type === 'SELL';
  const needsAsset = type !== 'DEPOSIT' && type !== 'WITHDRAW';
  // A transaction saved before dividends/taxes were dropped can still be opened
  // for editing, so fall back to its stored type rather than rendering blank.
  const activeTypeMeta = TX_TYPES.find(t => t.id === type)
    || (type ? { id: type, label: type.charAt(0) + type.slice(1).toLowerCase() } : null);

  const handleTypeChange = (newType) => {
    const oldIndex = TX_TYPES.findIndex(t => t.id === type);
    const newIndex = TX_TYPES.findIndex(t => t.id === newType);
    setDirection(newIndex > oldIndex ? 1 : -1);
    setType(newType);
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    const txDate = date || new Date().toISOString().split('T')[0];
    const fxRateOnDate = await fetchHistoricalFxRate(txDate);

    const txData = {
      type,
      ticker: asset ? asset.symbol : 'CASH',
      assetName: asset ? asset.name : 'Cash',
      date: txDate,
      currency,
      portfolio,
      fxRateOnDate: fxRateOnDate || 278.0,
      notes: ''
    };

    if (initialData && initialData.id) {
      txData.id = initialData.id;
    }

    if (isTradeType) {
      txData.shares = parseFloat(shares) || 0;
      txData.price = parseFloat(price) || 0;
      txData.fees = parseFloat(fees) || 0;
    } else {
      let rawAmount = parseFloat(amount) || 0;
      if (type === 'WITHDRAW' || type === 'TAX') {
        rawAmount = -Math.abs(rawAmount);
      } else {
        rawAmount = Math.abs(rawAmount);
      }
      txData.amount = rawAmount;
    }

    addTransaction(txData);
    onClose();
  };

  const formatDateShort = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dd = String(d.getDate()).padStart(2, '0');
    return `${months[d.getMonth()]} ${dd}, ${d.getFullYear()}`;
  };

  let contentHeight = 0;
  if (type === 'BUY' || type === 'SELL') {
    contentHeight = 304; 
  } else if (type === 'DIVIDEND' || type === 'TAX') {
    contentHeight = 258; 
  }

  // Generate Portfolio options
  const existingPortfolios = ['Main', 'Trading', ...new Set(transactions.map(t => t.portfolio).filter(Boolean))];
  const portfolioOptions = [...new Set(existingPortfolios)].map(p => ({ label: p, value: p }));

  // Calculate owned assets up to selected transaction date for Sell filtering
  const ownedAssets = React.useMemo(() => {
    if (!transactions) return [];
    const holdings = {};
    const selectedTxDate = date ? new Date(date) : new Date();
    
    // Sort transactions chronologically up to selected date
    const sorted = [...transactions]
      .filter(t => {
        if (!t.date) return true;
        return new Date(t.date) <= selectedTxDate;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    sorted.forEach(t => {
      if (portfolio && t.portfolio !== portfolio) return;
      const sym = (t.ticker || t.asset || '').toUpperCase();
      if (!sym || sym === 'CASH') return;
      if (!holdings[sym]) {
        holdings[sym] = { symbol: sym, name: t.assetName || sym, shares: 0 };
      }
      const s = parseFloat(t.shares) || 0;
      const txType = (t.type || '').toUpperCase();
      if (txType === 'BUY') holdings[sym].shares += s;
      else if (txType === 'SELL') holdings[sym].shares -= s;
    });

    return Object.values(holdings).filter(h => h.shares > 0.0001);
  }, [transactions, date, portfolio]);

  const selectedOwnedShares = React.useMemo(() => {
    if (!asset || type !== 'SELL') return 0;
    const assetSym = typeof asset === 'string' ? asset : (asset.symbol || asset.ticker || '');
    if (!assetSym) return 0;
    const match = ownedAssets.find(a => (a.symbol || '').toUpperCase() === assetSym.toUpperCase());
    return match ? match.shares : 0;
  }, [asset, type, ownedAssets]);

  // After every hook: returning earlier would change the hook order between
  // renders when isOpen flips.
  if (!isOpen) return null;

  const renderMobileInput = (field, label, iconComponent, val, setVal, placeholder) => {
    const Icon = iconComponent;
    if (isMobile) {
      return (
        <div onClick={() => setActiveField(field)} style={{ cursor: 'pointer' }}>
          <div className="input-with-icon" style={{ pointerEvents: 'none', position: 'relative' }}>
            <Icon size={18} className="input-icon" />
            <input type="text" placeholder={placeholder} value={val} readOnly />
            {field === 'shares' && type === 'SELL' && selectedOwnedShares > 0 && (
              <button 
                type="button" 
                className="max-shares-btn"
                style={{ pointerEvents: 'auto' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setShares(String(selectedOwnedShares));
                }}
              >
                MAX
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="input-with-icon" style={{ position: 'relative' }}>
        <Icon size={18} className="input-icon" />
        <input 
          type="number" step="any" min="0" 
          value={val} 
          onChange={e => setVal(e.target.value)} 
          required={field !== 'fees'} 
          placeholder={placeholder} 
        />
        {field === 'shares' && type === 'SELL' && selectedOwnedShares > 0 && (
          <button 
            type="button" 
            className="max-shares-btn"
            onClick={() => setShares(String(selectedOwnedShares))}
          >
            MAX
          </button>
        )}
      </div>
    );
  };

  const renderCurrencyIcon = ({ size, className }) => (
    <span className={className} style={{ fontSize: size - 4, fontWeight: 700 }}>
      {currency === 'USD' ? '$' : 'Rs'}
    </span>
  );

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <motion.div 
        className="modal-content tx-form-modal" 
        onClick={e => e.stopPropagation()}
        initial={{ y: 50, opacity: 0, scale: 0.95 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 50, opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="modal-header">
          <h2>New Transaction</h2>
          <button className="close-btn" type="button" onClick={onClose}><X size={20} /></button>
        </div>

        <form className="tx-form" onSubmit={handleSubmit}>
          {/* Animated Type Selector */}
          <div className="tx-type-selector animated-selector">
            {TX_TYPES.map(t => {
              const isSelected = type === t.id;
              return (
                <button 
                  key={t.id}
                  type="button"
                  className={`type-btn ${isSelected ? 'active' : ''}`}
                  style={isSelected ? { color: t.color } : {}}
                  onClick={() => handleTypeChange(t.id)}
                >
                  {isSelected && (
                    <motion.div 
                      layoutId="typeSlider"
                      className="slider-bg"
                      initial={false}
                      transition={{ type: "spring", stiffness: 500, damping: 40 }}
                      style={{ background: t.bg }}
                    />
                  )}
                  <span className="btn-content" style={{ zIndex: 1, position: 'relative', display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <t.icon size={14} />
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>

          <motion.div 
            className="dynamic-fields-wrapper"
            animate={{ height: contentHeight }}
            transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
            style={{ position: 'relative', overflow: 'visible' }}
          >
            <AnimatePresence initial={false} custom={direction} mode="popLayout">
              <motion.div
                key={type}
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                className="dynamic-fields-content"
                style={{ width: '100%' }}
              >
                {needsAsset && (
                  <div className="form-row">
                    <div className="form-group flex-2">
                      <label>Asset</label>
                      <div className="input-with-icon" onClick={() => setActiveField('asset')} style={{ cursor: 'pointer' }}>
                        <Search size={18} className="input-icon" style={{ color: asset ? 'var(--text-primary)' : 'var(--text-secondary)' }} />
                        <input 
                          type="text" 
                          placeholder="Search ticker or name..."
                          value={asset ? `${displayTicker(asset.symbol)} - ${asset.name}` : ''} 
                          readOnly 
                          style={{ cursor: 'pointer' }} 
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="form-row">
                  <div className="form-group flex-2">
                    <label>Date</label>
                    <div className="input-with-icon" onClick={() => setIsCalendarOpen(true)} style={{ cursor: 'pointer' }}>
                      <Calendar size={18} className="input-icon" />
                      <input type="text" value={formatDateShort(date)} readOnly style={{ cursor: 'pointer' }} />
                    </div>
                  </div>
                  
                  <div className="form-group flex-1" style={{ position: 'relative' }}>
                    <label>Portfolio</label>
                    <UnifiedDropdown 
                      value={portfolio}
                      onChange={setPortfolio}
                      options={portfolioOptions}
                    />
                  </div>
                </div>

                <div className="form-row">
                   <div className="form-group flex-2">
                      <label>Currency</label>
                      <div className="currency-toggle animated-selector">
                        {['PKR', 'USD'].map(curr => {
                          const isSelected = currency === curr;
                          return (
                            <div 
                              key={curr}
                              className={`curr-btn ${isSelected ? 'active' : ''}`}
                              onClick={() => setCurrency(curr)}
                            >
                              {isSelected && (
                                <motion.div 
                                  layoutId="currencySlider"
                                  className="slider-bg"
                                  initial={false}
                                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                                />
                              )}
                              <span style={{ position: 'relative', zIndex: 1 }}>{curr}</span>
                            </div>
                          );
                        })}
                      </div>
                   </div>
                </div>

                {isTradeType ? (
                  <>
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label>Shares</label>
                        {renderMobileInput('shares', 'Shares', Tag, shares, setShares, '0.0')}
                      </div>
                      <div className="form-group flex-1">
                        <label>Price</label>
                        {renderMobileInput('price', 'Price', renderCurrencyIcon, price, setPrice, '0.0')}
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label>Fees (Optional)</label>
                        {renderMobileInput('fees', 'Fees', renderCurrencyIcon, fees, setFees, '0.0')}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="form-row">
                    <div className="form-group flex-1">
                      <label>Amount</label>
                      {renderMobileInput('amount', 'Amount', renderCurrencyIcon, amount, setAmount, '0.0')}
                      <span className="hint">
                        {(type === 'WITHDRAW' || type === 'TAX') 
                          ? "Enter absolute amount — recorded as a deduction."
                          : "Enter the amount received."}
                      </span>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </motion.div>

          <AnimatePresence>
            {isCalendarOpen && (
              <UnifiedCalendar value={date} onChange={setDate} onClose={() => setIsCalendarOpen(false)} zIndex={2100} />
            )}
          </AnimatePresence>

          <div className="modal-actions">
            {type === 'SELL' && asset && selectedOwnedShares > 0 && (
              <div className="remaining-shares-badge">
                Remaining: <strong>{Math.max(0, selectedOwnedShares - (parseFloat(shares) || 0)).toFixed(2)}</strong>
              </div>
            )}
            <button type="button" className="cancel-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="submit-btn bg-primary">
              Add {activeTypeMeta?.label}
            </button>
          </div>
        </form>

        {activeField === 'asset' && (
          <AssetSelect 
            ownedAssetsOnly={type === 'SELL'}
            ownedAssets={ownedAssets}
            onClose={() => setActiveField(null)}
            onSelect={(selectedAsset, query) => {
              setAsset(selectedAsset);
              setActiveField(null);
              if (query && typeof query === 'string' && query.trim()) {
                const upperQuery = query.trim().toUpperCase();
                if (upperQuery !== selectedAsset.symbol.toUpperCase()) {
                  db.settingsStore.getItem('stocksettings123').then(settings => {
                    const s = settings || { id: 'stocksettings123', config: {} };
                    s.config = s.config || {};
                    s.config.assetMappings = s.config.assetMappings || {};
                    s.config.assetMappings[upperQuery] = {
                      symbol: selectedAsset.symbol,
                      name: selectedAsset.name,
                      exchange: selectedAsset.exchange || ''
                    };
                    s.pendingSync = true;
                    db.settingsStore.setItem('stocksettings123', s);
                  }).catch(console.error);
                }
              }
            }}
          />
        )}

        {activeField === 'shares' && (
          <PoppedFieldOverlay 
            field="shares" label="Shares" initialValue={shares} 
            onSaveValue={(val) => setShares(val)} onClose={() => setActiveField(null)} 
          />
        )}
        {activeField === 'price' && (
          <PoppedFieldOverlay 
            field="price" label="Price" initialValue={price} 
            onSaveValue={(val) => setPrice(val)} onClose={() => setActiveField(null)} 
          />
        )}
        {activeField === 'fees' && (
          <PoppedFieldOverlay 
            field="fees" label="Fees" initialValue={fees} 
            onSaveValue={(val) => setFees(val)} onClose={() => setActiveField(null)} 
          />
        )}
        {activeField === 'amount' && (
          <PoppedFieldOverlay 
            field="amount" label="Amount" initialValue={amount} 
            onSaveValue={(val) => setAmount(val)} onClose={() => setActiveField(null)} 
          />
        )}
      </motion.div>
    </div>,
    document.body
  );
}
