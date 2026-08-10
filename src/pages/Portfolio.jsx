import { useState, useMemo, useEffect } from 'react';
import { useData } from '../context/DataContext';
import { usePageSettings, useAppearanceSettings } from '../context/SettingsContext';
import { Search, Filter, Home, TrendingUp, TrendingDown, Briefcase, Layers, CheckCircle2 } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import FilterModal from '../components/FilterModal';
import BackendStatusDot from '../components/BackendStatusDot';
import { formatCurrency, getCurrencySymbol } from '../utils/format';
import { calculateAllTimeMWR, generatePortfolioTimeSeries } from '../utils/portfolio_math';
import './Portfolio.css';

export default function Portfolio() {
  const { transactions, livePrices, exchangeRates } = useData();
  const { baseCurrency, setBaseCurrency } = useAppearanceSettings();

  const [displayCurrency, setDisplayCurrency] = useState(baseCurrency || 'USD');
  const [tab, setTab] = useState('holdings'); // 'holdings' | 'closed'
  const [searchQuery, setSearchQuery] = useState('');

  const { filterState, setFilterState } = usePageSettings('dashboard');
  const [showFilterModal, setShowFilterModal] = useState(false);

  useEffect(() => {
    if (baseCurrency) {
      setDisplayCurrency(baseCurrency);
    }
  }, [baseCurrency]);

  const handleCurrencyChange = (newCurr) => {
    setDisplayCurrency(newCurr);
    if (typeof setBaseCurrency === 'function') {
      setBaseCurrency(newCurr);
    }
  };

  // Filter transactions by filter modal criteria (excluded tickers, portfolios, types)
  const filteredTransactions = useMemo(() => {
    let result = transactions || [];

    if (filterState.excludedTypes && filterState.excludedTypes.size > 0) {
      result = result.filter(t => !filterState.excludedTypes.has((t.type || '').toUpperCase()));
    }

    if (filterState.excludedPortfolios && filterState.excludedPortfolios.size > 0) {
      result = result.filter(t => !filterState.excludedPortfolios.has(t.portfolio || 'Default'));
    }

    if (filterState.excludedTickers && filterState.excludedTickers.size > 0) {
      result = result.filter(t => {
        const ticker = (t.asset || t.ticker || '').toUpperCase();
        return !filterState.excludedTickers.has(ticker);
      });
    }

    return result;
  }, [transactions, filterState]);

  // Aggregate positions (Holdings & Closed Positions) with historical FX conversion & amount filters
  const { holdingsList, closedList, totalMarketValue, totalUnrealizedPnL, totalRealizedPnL } = useMemo(() => {
    const positionMap = {};
    const currentFxRate = exchangeRates?.PKR || 278.0;

    filteredTransactions.forEach(tx => {
      const ticker = (tx.asset || tx.ticker || 'UNKNOWN').toUpperCase();
      if (!positionMap[ticker]) {
        positionMap[ticker] = {
          ticker,
          assetName: tx.assetName || tx.name || ticker,
          portfolio: tx.portfolio || 'Default',
          totalShares: 0,
          totalBuyShares: 0,
          totalSellShares: 0,
          dividendIncome: 0,
          lastPrice: Number(tx.price) || 0,
          currency: tx.currency || (ticker.endsWith('.KA') || ticker.endsWith('.PSX') ? 'PKR' : 'USD'),
          buyTransactions: [],
          sellTransactions: []
        };
      }

      const p = positionMap[ticker];
      const shares = Number(tx.shares) || Number(tx.quantity) || 0;
      const price = Number(tx.price) || 0;
      const type = (tx.type || '').toLowerCase();
      const fxDate = Number(tx.fxRateOnDate) || currentFxRate;

      if (price > 0) p.lastPrice = price;

      if (type === 'buy') {
        p.totalShares += shares;
        p.totalBuyShares += shares;
        p.buyTransactions.push({ shares, price, fxRateOnDate: fxDate, currency: tx.currency || p.currency });
      } else if (type === 'sell') {
        p.totalShares -= shares;
        p.totalSellShares += shares;
        p.sellTransactions.push({ shares, price, fxRateOnDate: fxDate, currency: tx.currency || p.currency });
      } else if (type === 'dividend') {
        p.dividendIncome += Number(tx.amount) || 0;
      }
    });

    const holdings = [];
    const closed = [];
    let totMarketVal = 0;
    let totUnrealized = 0;
    let totRealized = 0;

    const minVal = filterState.minAmount ? parseFloat(filterState.minAmount) : null;
    const maxVal = filterState.maxAmount ? parseFloat(filterState.maxAmount) : null;

    Object.values(positionMap).forEach(p => {
      const quote = livePrices[p.ticker];
      const currentPriceNative = (typeof quote === 'object' ? quote?.price : quote) || p.lastPrice || 0;
      const change24hPercent = typeof quote === 'object' ? (quote?.changePercent || 0) : 0;
      const assetCurrency = p.currency || 'USD';

      // Current live price converted to active displayCurrency
      let currentPriceDisplay = currentPriceNative;
      if (displayCurrency === 'USD' && assetCurrency === 'PKR') {
        currentPriceDisplay = currentPriceNative / currentFxRate;
      } else if (displayCurrency === 'PKR' && assetCurrency === 'USD') {
        currentPriceDisplay = currentPriceNative * currentFxRate;
      }

      // Convert cost basis of buy transactions into displayCurrency using historical fxRateOnDate
      let totalBuyCostDisplay = 0;
      p.buyTransactions.forEach(bt => {
        const btFx = bt.fxRateOnDate || currentFxRate;
        if (displayCurrency === 'USD') {
          if (bt.currency === 'PKR') {
            totalBuyCostDisplay += (bt.shares * bt.price) / btFx;
          } else {
            totalBuyCostDisplay += (bt.shares * bt.price);
          }
        } else if (displayCurrency === 'PKR') {
          if (bt.currency === 'USD') {
            totalBuyCostDisplay += (bt.shares * bt.price) * btFx;
          } else {
            totalBuyCostDisplay += (bt.shares * bt.price);
          }
        }
      });

      const avgBuyPriceDisplay = p.totalBuyShares > 0 ? (totalBuyCostDisplay / p.totalBuyShares) : 0;

      if (p.totalShares > 0.0001) {
        // Active Holding Position
        const marketValue = p.totalShares * currentPriceDisplay;
        const costBasis = p.totalShares * avgBuyPriceDisplay;
        const unrealizedPnL = marketValue - costBasis;
        const unrealizedPnLPercent = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;

        let passFilter = true;
        if (minVal !== null && !isNaN(minVal) && marketValue < minVal) passFilter = false;
        if (maxVal !== null && !isNaN(maxVal) && marketValue > maxVal) passFilter = false;

        if (passFilter) {
          totMarketVal += marketValue;
          totUnrealized += unrealizedPnL;

          holdings.push({
            ...p,
            currency: displayCurrency,
            avgBuyPrice: avgBuyPriceDisplay,
            currentPrice: currentPriceDisplay,
            marketValue,
            costBasis,
            unrealizedPnL,
            unrealizedPnLPercent,
            change24hPercent
          });
        }
      }
      
      if (p.totalSellShares > 0) {
        // Closed / Realized Position Portion
        let totalSellAmountDisplay = 0;
        p.sellTransactions.forEach(st => {
          const stFx = st.fxRateOnDate || currentFxRate;
          if (displayCurrency === 'USD') {
            if (st.currency === 'PKR') {
              totalSellAmountDisplay += (st.shares * st.price) / stFx;
            } else {
              totalSellAmountDisplay += (st.shares * st.price);
            }
          } else if (displayCurrency === 'PKR') {
            if (st.currency === 'USD') {
              totalSellAmountDisplay += (st.shares * st.price) * stFx;
            } else {
              totalSellAmountDisplay += (st.shares * st.price);
            }
          }
        });

        const avgSellPriceDisplay = p.totalSellShares > 0 ? (totalSellAmountDisplay / p.totalSellShares) : 0;
        const costBasisOfSold = p.totalSellShares * avgBuyPriceDisplay;
        const realizedPnL = totalSellAmountDisplay - costBasisOfSold;
        const realizedPnLPercent = costBasisOfSold > 0 ? (realizedPnL / costBasisOfSold) * 100 : 0;

        let passFilter = true;
        if (minVal !== null && !isNaN(minVal) && totalSellAmountDisplay < minVal) passFilter = false;
        if (maxVal !== null && !isNaN(maxVal) && totalSellAmountDisplay > maxVal) passFilter = false;

        if (passFilter) {
          totRealized += realizedPnL;

          closed.push({
            ...p,
            currency: displayCurrency,
            avgBuyPrice: avgBuyPriceDisplay,
            avgSellPrice: avgSellPriceDisplay,
            realizedPnL,
            realizedPnLPercent,
            totalRealizedValue: totalSellAmountDisplay,
            change24hPercent
          });
        }
      }
    });

    return {
      holdingsList: holdings,
      closedList: closed,
      totalMarketValue: totMarketVal,
      totalUnrealizedPnL: totUnrealized,
      totalRealizedPnL: totRealized
    };
  }, [filteredTransactions, livePrices, exchangeRates, displayCurrency, filterState]);

    const { mwrPercent, mwrCumulative, twrPercent } = useMemo(() => {
      const currentFxRate = exchangeRates?.PKR || 278.0;
      const mwr = calculateAllTimeMWR(filteredTransactions, totalMarketValue, displayCurrency, currentFxRate);
      const series = generatePortfolioTimeSeries(filteredTransactions, livePrices, displayCurrency, currentFxRate);
      const twr = series.length > 0 ? series[series.length - 1].twrPct : 0;
      return { mwrPercent: mwr.annualized, mwrCumulative: mwr.cumulative, twrPercent: twr };
    }, [filteredTransactions, totalMarketValue, displayCurrency, exchangeRates, livePrices]);

  // Search filter
  const displayedPositions = useMemo(() => {
    const list = tab === 'holdings' ? holdingsList : closedList;
    if (!searchQuery.trim()) return list;

    const q = searchQuery.toLowerCase().trim();
    return list.filter(p => 
      p.ticker.toLowerCase().includes(q) || 
      p.assetName.toLowerCase().includes(q) ||
      p.portfolio.toLowerCase().includes(q)
    );
  }, [tab, holdingsList, closedList, searchQuery]);

  const hasActiveFilters = 
    (filterState.excludedPortfolios && filterState.excludedPortfolios.size > 0) ||
    (filterState.excludedTickers && filterState.excludedTickers.size > 0) ||
    Boolean(filterState.minAmount) ||
    Boolean(filterState.maxAmount);

  const renderCurrencyTogglePill = () => (
    <div className="header-currency-toggle" style={{
      display: 'inline-flex',
      alignItems: 'center',
      height: '44px',
      background: 'rgba(255, 255, 255, 0.05)',
      borderRadius: '16px',
      padding: '4px',
      border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
      boxSizing: 'border-box'
    }}>
      <button
        type="button"
        onClick={() => handleCurrencyChange('USD')}
        style={{
          height: '100%',
          padding: '0 12px',
          borderRadius: '12px',
          border: 'none',
          fontSize: '12px',
          fontWeight: 700,
          cursor: 'pointer',
          background: displayCurrency === 'USD' ? 'var(--accent-color, #6366f1)' : 'transparent',
          color: displayCurrency === 'USD' ? '#fff' : 'var(--text-secondary)',
          transition: 'all 0.2s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        USD
      </button>
      <button
        type="button"
        onClick={() => handleCurrencyChange('PKR')}
        style={{
          height: '100%',
          padding: '0 12px',
          borderRadius: '12px',
          border: 'none',
          fontSize: '12px',
          fontWeight: 700,
          cursor: 'pointer',
          background: displayCurrency === 'PKR' ? 'var(--accent-color, #6366f1)' : 'transparent',
          color: displayCurrency === 'PKR' ? '#fff' : 'var(--text-secondary)',
          transition: 'all 0.2s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        PKR
      </button>
    </div>
  );

  return (
    <div className="page-container tx-page">
      <div className="portfolio-page">
        {/* Desktop Header */}
        <div className="portfolio-header glass-panel desktop-only">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h1 className="page-title" style={{ margin: 0 }}>Portfolio</h1>
            <BackendStatusDot />
          </div>
          
          <div className="portfolio-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div className="portfolio-search-bar" style={{ minWidth: '240px' }}>
              <Search size={16} className="search-icon" />
              <input 
                type="text" 
                placeholder="Search symbol or name..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            {renderCurrencyTogglePill()}

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

        {/* Mobile Header (Two Rows) */}
        <div className="portfolio-header-container mobile-only">
          {/* Top Row: Home Icon & Connection Dot (Left), Currency Toggle & Filter Icon (Right) */}
          <div className="portfolio-top-row">
            <div className="portfolio-top-left">
              <NavLink to="/" className="icon-btn" title="Home" style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
                <Home size={20} />
              </NavLink>
              <BackendStatusDot />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {renderCurrencyTogglePill()}

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

          {/* Second Row: Search Bar */}
          <div className="portfolio-search-row">
            <div className="portfolio-search-bar">
              <Search size={16} className="search-icon" />
              <input 
                type="text" 
                placeholder="Search symbol or name..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Total Balance Hero Pill */}
        <div className="glass-panel total-balance-pill">
          <div className="balance-label">Portfolio Value</div>
          <div className="balance-amount">
            {getCurrencySymbol(displayCurrency)}{formatCurrency(totalMarketValue)}
          </div>
          
          <div className="hero-metrics-row">
            <div className="hero-metrics">
              <div className="metric-col">
                <span className="metric-label">Unrealized P&L</span>
                <span className={`metric-value ${totalUnrealizedPnL >= 0 ? 'positive' : 'negative'}`}>
                  {totalUnrealizedPnL >= 0 ? '+' : ''}{getCurrencySymbol(displayCurrency)}{formatCurrency(totalUnrealizedPnL)}
                </span>
              </div>
              <div className="metric-col">
                <span className="metric-label">Realized P&L</span>
                <span className={`metric-value ${totalRealizedPnL >= 0 ? 'positive' : 'negative'}`}>
                  {totalRealizedPnL >= 0 ? '+' : ''}{getCurrencySymbol(displayCurrency)}{formatCurrency(totalRealizedPnL)}
                </span>
              </div>
            </div>
            
            {/* Desktop: Performance Pills inside main pill below balance-amount */}
            <div className="performance-pills desktop-only">
              <div className={`perf-pill ${mwrCumulative >= 0 ? 'positive' : 'negative'}`}>
                <span className="perf-label">Cum. MWR</span>
                <span className="perf-value">
                  {mwrCumulative >= 0 ? '+' : ''}{mwrCumulative.toFixed(2)}%
                </span>
              </div>
              <div className={`perf-pill ${mwrPercent >= 0 ? 'positive' : 'negative'}`}>
                <span className="perf-label">Ann. MWR</span>
                <span className="perf-value">
                  {mwrPercent >= 0 ? '+' : ''}{mwrPercent.toFixed(2)}%
                </span>
              </div>
              <div className={`perf-pill ${twrPercent >= 0 ? 'positive' : 'negative'}`}>
                <span className="perf-label">TWR</span>
                <span className="perf-value">
                  {twrPercent >= 0 ? '+' : ''}{twrPercent.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile: Performance Pills outside and below main hero pill */}
        <div className="performance-pills mobile-only">
          <div className={`perf-pill glass-panel ${mwrCumulative >= 0 ? 'positive' : 'negative'}`}>
            <span className="perf-label">Cum. MWR</span>
            <span className="perf-value">
              {mwrCumulative >= 0 ? '+' : ''}{mwrCumulative.toFixed(2)}%
            </span>
          </div>
          <div className={`perf-pill glass-panel ${mwrPercent >= 0 ? 'positive' : 'negative'}`}>
            <span className="perf-label">Ann. MWR</span>
            <span className="perf-value">
              {mwrPercent >= 0 ? '+' : ''}{mwrPercent.toFixed(2)}%
            </span>
          </div>
          <div className={`perf-pill glass-panel ${twrPercent >= 0 ? 'positive' : 'negative'}`}>
            <span className="perf-label">TWR</span>
            <span className="perf-value">
              {twrPercent >= 0 ? '+' : ''}{twrPercent.toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Animated Tab Toggle */}
        <div className="position-toggle-container">
          <button 
            type="button"
            className={`position-toggle-btn ${tab === 'holdings' ? 'active' : ''}`}
            onClick={() => setTab('holdings')}
          >
            <Layers size={16} />
            <span>Holdings ({holdingsList.length})</span>
            {tab === 'holdings' && (
              <motion.div className="toggle-slider" layoutId="portfolio-tab-slider" style={{ inset: 0 }} />
            )}
          </button>

          <button 
            type="button"
            className={`position-toggle-btn ${tab === 'closed' ? 'active' : ''}`}
            onClick={() => setTab('closed')}
          >
            <CheckCircle2 size={16} />
            <span>Closed Positions ({closedList.length})</span>
            {tab === 'closed' && (
              <motion.div className="toggle-slider" layoutId="portfolio-tab-slider" style={{ inset: 0 }} />
            )}
          </button>
        </div>

        {/* Positions List */}
        <div className="positions-list">
          {displayedPositions.length > 0 ? (
            displayedPositions.map(p => {
              const isHoldings = tab === 'holdings';
              const pnl = isHoldings ? p.unrealizedPnL : p.realizedPnL;
              const pnlPercent = isHoldings ? p.unrealizedPnLPercent : p.realizedPnLPercent;
              const isPositive = pnl >= 0;

              return (
                <div key={p.ticker} className="position-card">
                  <div className="position-info">
                    <div className="position-symbol-row">
                      <span className="position-symbol">{p.ticker}</span>
                      <span className="position-portfolio-tag">{p.portfolio}</span>
                    </div>
                    <span className="position-name">{p.assetName}</span>
                    {isHoldings && (
                      <span className="position-live-price">
                        {p.totalShares} shares @ {getCurrencySymbol(p.currency)}{formatCurrency(p.avgBuyPrice)}
                      </span>
                    )}
                  </div>

                  <div className="position-details">
                    {/* Total Sale Value or Market Value */}
                    <div className="position-value">
                      {getCurrencySymbol(p.currency)}{formatCurrency(isHoldings ? p.marketValue : p.totalRealizedValue)}
                    </div>

                    {/* Realized / Unrealized Gain Row */}
                    <div className={isHoldings ? `pnl-row ${isPositive ? 'positive' : 'negative'}` : `pnl-badge ${isPositive ? 'positive' : 'negative'}`}>
                      {isPositive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      <span>
                        {isPositive ? '+' : ''}{formatCurrency(pnl)} ({isPositive ? '+' : ''}{pnlPercent.toFixed(2)}%)
                      </span>
                    </div>

                    {/* Closed Positions shares @ price text (Right-aligned) */}
                    {!isHoldings && (
                      <span className="position-live-price" style={{ textAlign: 'right', marginTop: '2px' }}>
                        {p.totalSellShares} shares @ {getCurrencySymbol(p.currency)}{formatCurrency(p.avgSellPrice)}
                      </span>
                    )}

                    {/* 24h Change Badge (ONLY for Active Holdings) */}
                    {isHoldings && p.change24hPercent !== 0 && (
                      <div className={`change-24h-badge ${p.change24hPercent >= 0 ? 'positive' : 'negative'}`}>
                        <span>24h: {p.change24hPercent >= 0 ? '+' : ''}{p.change24hPercent.toFixed(2)}%</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-positions-state">
              <Briefcase size={36} style={{ opacity: 0.4 }} />
              <p>No {tab === 'holdings' ? 'active holdings' : 'closed positions'} found.</p>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showFilterModal && (
          <FilterModal
            transactions={transactions}
            initialState={filterState}
            hideTypeTab={true}
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
