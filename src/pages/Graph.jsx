import { useState, useMemo, useEffect } from 'react';
import { useData } from '../context/DataContext';
import { useAppearanceSettings, usePageSettings } from '../context/SettingsContext';
import { NavLink } from 'react-router-dom';
import { Home, TrendingUp, TrendingDown, RefreshCcw, DollarSign, Percent, Filter, GitCompare, ChevronDown, Maximize2, Minimize2, Smartphone, RotateCcw } from 'lucide-react';
import { formatCurrency, getCurrencySymbol } from '../utils/format';
import { generatePortfolioTimeSeries, calculateAllTimeMWR } from '../utils/portfolio_math';
import BackendStatusDot from '../components/BackendStatusDot';
import FilterModal from '../components/FilterModal';
import CompareModal from '../components/CompareModal';
import UnifiedDropdown from '../components/UnifiedDropdown';
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid 
} from 'recharts';
import './Graph.css';

const PERIODS = ['1M', '3M', 'YTD', '1Y', 'All Time'];

export default function Graph() {
  const { transactions, livePrices, exchangeRates } = useData();
  const { baseCurrency } = useAppearanceSettings();

  const [displayCurrency, setDisplayCurrency] = useState(baseCurrency || 'USD');
  const [period, setPeriod] = useState('All Time');
  const [chartMode, setChartMode] = useState('value'); // 'value' | 'gain'
  const [metricSelector, setMetricSelector] = useState('mwr'); // 'mwr' | 'twr'
  const [isExpanded, setIsExpanded] = useState(false);
  const [isPortrait, setIsPortrait] = useState(() => window.innerHeight > window.innerWidth);

  useEffect(() => {
    const handleOrientation = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    window.addEventListener('resize', handleOrientation);
    window.addEventListener('orientationchange', handleOrientation);
    return () => {
      window.removeEventListener('resize', handleOrientation);
      window.removeEventListener('orientationchange', handleOrientation);
    };
  }, []);

  const { filterState, setFilterState } = usePageSettings('graph');
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [selectedBenchmarks, setSelectedBenchmarks] = useState([]);

  useEffect(() => {
    if (baseCurrency) setDisplayCurrency(baseCurrency);
  }, [baseCurrency]);

  // Lock body scrolling ONLY when fullscreen chart is active
  useEffect(() => {
    if (isExpanded) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isExpanded]);

  // Listen to native browser fullscreen exit (ESC / swipe gesture)
  useEffect(() => {
    const handleFsChange = () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        setIsExpanded(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!isExpanded) {
      setIsExpanded(true);
      const elem = document.documentElement;
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      } else if (elem.webkitRequestFullscreen) {
        elem.webkitRequestFullscreen();
      }
    } else {
      setIsExpanded(false);
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    }
  };

  const currentFxRate = exchangeRates?.PKR || 278.0;

  // Filter transactions based on selected tickers and portfolios
  const filteredTransactions = useMemo(() => {
    let result = transactions || [];
    if (filterState?.excludedTickers && filterState.excludedTickers.size > 0) {
      result = result.filter(tx => !filterState.excludedTickers.has((tx.asset || tx.ticker || '').toUpperCase()));
    }
    if (filterState?.excludedPortfolios && filterState.excludedPortfolios.size > 0) {
      result = result.filter(tx => !filterState.excludedPortfolios.has(tx.portfolio));
    }
    return result;
  }, [transactions, filterState]);

  const hasActiveFilters = (filterState?.excludedTickers && filterState.excludedTickers.size > 0) || 
    (filterState?.excludedPortfolios && filterState.excludedPortfolios.size > 0);

  // Generate full daily time-series data using filtered transactions
  const rawTimeSeries = useMemo(() => {
    return generatePortfolioTimeSeries(filteredTransactions, livePrices, displayCurrency, currentFxRate);
  }, [filteredTransactions, livePrices, displayCurrency, currentFxRate]);

  // Filter time series based on selected period tab (1M, 3M, YTD, 1Y, All Time)
  const filteredTimeSeries = useMemo(() => {
    if (!rawTimeSeries || rawTimeSeries.length === 0) return [];
    if (period === 'All Time') return rawTimeSeries;

    const lastPointDate = new Date(rawTimeSeries[rawTimeSeries.length - 1].date);
    let cutoff = new Date(lastPointDate);

    if (period === '1M') cutoff.setMonth(cutoff.getMonth() - 1);
    else if (period === '3M') cutoff.setMonth(cutoff.getMonth() - 3);
    else if (period === 'YTD') cutoff = new Date(lastPointDate.getFullYear(), 0, 1);
    else if (period === '1Y') cutoff.setFullYear(cutoff.getFullYear() - 1);

    const filtered = rawTimeSeries.filter(pt => new Date(pt.date) >= cutoff);
    return filtered.length > 0 ? filtered : rawTimeSeries;
  }, [rawTimeSeries, period]);

  // Calculate reactive period summary metrics
  const periodSummary = useMemo(() => {
    if (!filteredTimeSeries || filteredTimeSeries.length === 0) {
      return { currentValue: 0, costBasis: 0, periodGain: 0, periodReturnPct: 0 };
    }

    const startPt = filteredTimeSeries[0];
    const endPt = filteredTimeSeries[filteredTimeSeries.length - 1];

    const currentValue = endPt.value;
    const costBasis = endPt.costBasis;

    let periodGain = 0;
    let periodReturnPct = 0;

    if (chartMode === 'value') {
      periodGain = endPt.value - startPt.value;
      const startVal = startPt.value > 0 ? startPt.value : (startPt.costBasis || 1);
      periodReturnPct = (periodGain / startVal) * 100.0;
    } else if (chartMode === 'twr') {
      const startTwr = startPt.twrFactor || 1.0;
      const endTwr = endPt.twrFactor || 1.0;
      periodReturnPct = startTwr > 0 ? ((endTwr / startTwr) - 1.0) * 100.0 : 0.0;
      periodGain = (currentValue * (periodReturnPct / 100.0));
    } else if (chartMode === 'mwr') {
      const mwrVal = calculateAllTimeMWR(transactions, currentValue, displayCurrency, currentFxRate);
      periodReturnPct = mwrVal.cumulative;
      periodGain = endPt.pnl;
    }

    return {
      currentValue,
      costBasis,
      periodGain,
      periodReturnPct
    };
  }, [filteredTimeSeries, chartMode, transactions, displayCurrency, currentFxRate]);

  // Currency Toggle Pill
  const renderCurrencyTogglePill = () => (
    <div className="segmented-control">
      <button 
        type="button" 
        className={`segmented-btn ${displayCurrency === 'USD' ? 'active' : ''}`}
        onClick={() => setDisplayCurrency('USD')}
      >
        USD
      </button>
      <button 
        type="button" 
        className={`segmented-btn ${displayCurrency === 'PKR' ? 'active' : ''}`}
        onClick={() => setDisplayCurrency('PKR')}
      >
        PKR
      </button>
    </div>
  );

  // Custom Glassmorphism Chart Tooltip
  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="custom-chart-tooltip">
          <div className="tooltip-date">{data.dateFormatted}</div>
          <div className="tooltip-row">
            <span className="tooltip-label">Portfolio Value:</span>
            <span className="tooltip-val">{getCurrencySymbol(displayCurrency)}{formatCurrency(data.value)}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Cost Basis:</span>
            <span className="tooltip-val">{getCurrencySymbol(displayCurrency)}{formatCurrency(data.costBasis)}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">TWR:</span>
            <span className="tooltip-val" style={{ color: data.twrPct >= 0 ? '#10b981' : '#ef4444' }}>
              {data.twrPct >= 0 ? '+' : ''}{data.twrPct?.toFixed(2)}%
            </span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Cum. MWR:</span>
            <span className="tooltip-val" style={{ color: data.mwrPct >= 0 ? '#10b981' : '#ef4444' }}>
              {data.mwrPct >= 0 ? '+' : ''}{data.mwrPct?.toFixed(2)}%
            </span>
          </div>
        </div>
      );
    }
    return null;
  };

  // Filter Button Component
  const renderFilterBtn = () => (
    <button 
      className={`icon-btn relative ${hasActiveFilters ? 'active-filter' : ''}`}
      title="Filter Graph" 
      onClick={() => setShowFilterModal(true)}
    >
      <Filter size={20} />
      {hasActiveFilters && <span className="filter-badge"></span>}
    </button>
  );

  // Compare Button Component (ONLY SHOWN IN Gain (%) Mode)
  const renderCompareBtn = () => {
    if (chartMode !== 'gain') return null;
    return (
      <button 
        className={`icon-btn relative ${selectedBenchmarks.length > 0 ? 'active-filter' : ''}`}
        title="Compare Benchmarks" 
        onClick={() => setShowCompareModal(true)}
      >
        <GitCompare size={20} />
        {selectedBenchmarks.length > 0 && <span className="filter-badge"></span>}
      </button>
    );
  };

  // Mode Toggle Pill (Value ($) vs Gain (%))
  const renderModeTogglePills = () => (
    <div className="segmented-control">
      <button 
        type="button" 
        className={`segmented-btn ${chartMode === 'value' ? 'active' : ''}`}
        onClick={() => setChartMode('value')}
      >
        Value ($)
      </button>
      <button 
        type="button" 
        className={`segmented-btn ${chartMode === 'gain' ? 'active' : ''}`}
        onClick={() => setChartMode('gain')}
      >
        Gain (%)
      </button>
    </div>
  );

  // Compute All-Time metrics for the top hero card
  const endPoint = rawTimeSeries.length > 0 ? rawTimeSeries[rawTimeSeries.length - 1] : null;
  const totalPortfolioValue = endPoint ? endPoint.value : 0;
  const totalGainDollars = endPoint ? endPoint.pnl : 0;
  const allTimeTwr = endPoint ? endPoint.twrPct : 0;
  
  const allTimeMwr = useMemo(() => {
    const res = calculateAllTimeMWR(filteredTransactions, totalPortfolioValue, displayCurrency, currentFxRate);
    return res.cumulative;
  }, [filteredTransactions, totalPortfolioValue, displayCurrency, currentFxRate]);

  const activeReturnPct = chartMode === 'value' 
    ? periodSummary.periodReturnPct 
    : (metricSelector === 'mwr' ? allTimeMwr : allTimeTwr);

  const isPositiveReturn = activeReturnPct >= 0;
  const chartColor = isPositiveReturn ? '#10b981' : '#ef4444';

  return (
    <div className="page-container graph-page">
      {/* Desktop Header */}
      <div className="graph-header glass-panel desktop-only">
        <div className="graph-top-row">
          <div className="portfolio-top-left" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h1 className="page-title" style={{ fontSize: '20px', margin: 0 }}>Graph</h1>
            <BackendStatusDot />
          </div>

          <div className="control-pills-row">
            {renderCurrencyTogglePill()}
            {renderCompareBtn()}
            {renderFilterBtn()}
          </div>
        </div>
      </div>

      {/* Mobile Floating Top Controls */}
      <div className="graph-mobile-top-row mobile-only">
        <div className="portfolio-top-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <NavLink to="/" className="icon-btn" title="Home" style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
            <Home size={20} />
          </NavLink>
          <BackendStatusDot />
        </div>

        <div className="control-pills-row">
          {renderCurrencyTogglePill()}
          {renderCompareBtn()}
          {renderFilterBtn()}
        </div>
      </div>

      {/* 1. Standalone Top Portfolio Value Pill / Card */}
      <div className="glass-panel graph-value-card">
        <div className="graph-value-info">
          <span className="graph-hero-label">Portfolio Value</span>
          <div className="graph-hero-value">
            {getCurrencySymbol(displayCurrency)}{formatCurrency(totalPortfolioValue)}
          </div>
          
          <div className="graph-hero-badge-row">
            <div className={`graph-change-badge ${totalGainDollars >= 0 ? 'positive' : 'negative'}`}>
              {totalGainDollars >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              <span>
                {totalGainDollars >= 0 ? '+' : ''}{getCurrencySymbol(displayCurrency)}{formatCurrency(totalGainDollars)} Total Gain
              </span>
            </div>
          </div>
        </div>

        {/* MWR & TWR Performance Pill Selectors */}
        <div className="graph-perf-pills">
          <button 
            type="button"
            className={`perf-pill ${allTimeMwr >= 0 ? 'positive' : 'negative'} ${chartMode === 'gain' && metricSelector === 'mwr' ? 'active-selector' : ''}`}
            onClick={() => {
              setMetricSelector('mwr');
              setChartMode('gain');
            }}
            title="Graph MWR Gain (%)"
          >
            <span className="perf-label">MWR</span>
            <span className="perf-value">
              {allTimeMwr >= 0 ? '+' : ''}{allTimeMwr.toFixed(2)}%
            </span>
          </button>

          <button 
            type="button"
            className={`perf-pill ${allTimeTwr >= 0 ? 'positive' : 'negative'} ${chartMode === 'gain' && metricSelector === 'twr' ? 'active-selector' : ''}`}
            onClick={() => {
              setMetricSelector('twr');
              setChartMode('gain');
            }}
            title="Graph TWR Gain (%)"
          >
            <span className="perf-label">TWR</span>
            <span className="perf-value">
              {allTimeTwr >= 0 ? '+' : ''}{allTimeTwr.toFixed(2)}%
            </span>
          </button>
        </div>
      </div>

      {/* 2. Graph Chart Card */}
      <div className={`glass-panel graph-chart-card ${isExpanded ? 'fullscreen' : ''}`}>
        {/* Rotate Screen Prompt (shown when expanded in portrait mode) */}
        {isExpanded && isPortrait && (
          <div className="rotate-prompt-overlay">
            <div className="rotate-prompt-card">
              <div className="rotate-icon-wrapper">
                <Smartphone size={48} className="phone-rotate-icon" />
                <RotateCcw size={22} className="rotate-arrow-badge" />
              </div>
              <h3 className="rotate-prompt-title">Rotate Your Device</h3>
              <p className="rotate-prompt-desc">
                Please turn your phone horizontally to landscape mode for the full-screen graph view.
              </p>
              <button 
                type="button" 
                className="rotate-close-btn"
                onClick={toggleFullscreen}
              >
                Close
              </button>
            </div>
          </div>
        )}

        <div className="graph-chart-controls">
          {/* Desktop Period Selector Pills */}
          <div className="period-pills desktop-only">
            {PERIODS.map(p => (
              <button 
                key={p}
                type="button"
                className={`period-pill ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Mobile Period Selector Dropdown (UnifiedDropdown) */}
          <div className="period-select-wrapper mobile-only">
            <UnifiedDropdown
              value={period}
              options={PERIODS.map(p => ({ value: p, label: p }))}
              onChange={(val) => setPeriod(val)}
            />
          </div>

          <div className="control-pills-row">
            {renderModeTogglePills()}
            <button 
              type="button" 
              className={`icon-btn mobile-only expand-chart-btn ${isExpanded ? 'active-filter' : ''}`}
              title={isExpanded ? "Collapse Chart" : "Expand Chart"}
              onClick={toggleFullscreen}
            >
              {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </div>

        {/* Recharts Canvas */}
        <div className={`chart-container ${isExpanded ? 'expanded' : ''}`}>
          {filteredTimeSeries.length === 0 ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
              No transaction history available for graphing.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredTimeSeries} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.05)" vertical={false} />
                <XAxis 
                  dataKey="dateFormatted" 
                  stroke="rgba(255, 255, 255, 0.3)" 
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(255, 255, 255, 0.1)' }}
                />
                <YAxis 
                  stroke="rgba(255, 255, 255, 0.3)"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => 
                    chartMode === 'value' 
                      ? `${formatCurrency(val, displayCurrency, 0)}` 
                      : `${val.toFixed(0)}%`
                  }
                  domain={['auto', 'auto']}
                />
                <Tooltip content={<CustomTooltip />} />
                <Area 
                  type="monotone" 
                  dataKey={chartMode === 'value' ? 'value' : (metricSelector === 'mwr' ? 'mwrPct' : 'twrPct')}
                  stroke={chartColor}
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#chartGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {showFilterModal && (
        <FilterModal 
          transactions={transactions}
          initialState={filterState}
          showOnlyTickerAndPortfolio={true}
          onApply={(newFilters) => {
            setFilterState(newFilters);
            setShowFilterModal(false);
          }}
          onClose={() => setShowFilterModal(false)}
        />
      )}

      {showCompareModal && (
        <CompareModal
          selectedBenchmarks={selectedBenchmarks}
          onApply={(benchmarks) => {
            setSelectedBenchmarks(benchmarks);
            setShowCompareModal(false);
          }}
          onClose={() => setShowCompareModal(false)}
        />
      )}
    </div>
  );
}
