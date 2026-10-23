import { useState, useMemo, useEffect } from 'react';
import { useData } from '../context/DataContext';
import { useAppearanceSettings, usePageSettings } from '../context/SettingsContext';
import { NavLink } from 'react-router-dom';
import { Home, TrendingUp, TrendingDown, RefreshCcw, DollarSign, Percent, Filter, GitCompare, ChevronDown, Maximize2, Minimize2, Smartphone, RotateCcw } from 'lucide-react';
import { formatCurrency, getCurrencySymbol } from '../utils/format';
import { generatePortfolioTimeSeries, rebaseSeries } from '../utils/portfolio_math';
import BackendStatusDot from '../components/BackendStatusDot';
import FilterModal from '../components/FilterModal';
import CompareModal from '../components/CompareModal';
import UnifiedDropdown from '../components/UnifiedDropdown';
import { 
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid 
} from 'recharts';
import './Graph.css';

const PERIODS = ['1M', '3M', 'YTD', '1Y', 'All Time'];

export default function Graph() {
  const { transactions, livePrices, historicalPrices, fxSeries, historyLoading, exchangeRates } = useData();
  const { baseCurrency } = useAppearanceSettings();

  const [displayCurrency, setDisplayCurrency] = useState(baseCurrency || 'USD');
  const [period, setPeriod] = useState('All Time');
  const [chartMode, setChartMode] = useState('value'); // 'value' | 'gain'
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
    return generatePortfolioTimeSeries(filteredTransactions, livePrices, historicalPrices, displayCurrency, currentFxRate, fxSeries);
  }, [filteredTransactions, livePrices, historicalPrices, displayCurrency, currentFxRate, fxSeries]);

  // Slice to the selected period tab (1M, 3M, YTD, 1Y, All Time) and re-base the
  // return series so the window reports the return earned *within* that window.
  const filteredTimeSeries = useMemo(() => {
    if (!rawTimeSeries || rawTimeSeries.length === 0) return [];
    if (period === 'All Time') return rawTimeSeries;

    const [ly, lm, ld] = rawTimeSeries[rawTimeSeries.length - 1].date.split('-').map(Number);
    let cutoff;
    if (period === '1M') cutoff = new Date(Date.UTC(ly, lm - 2, ld));
    else if (period === '3M') cutoff = new Date(Date.UTC(ly, lm - 4, ld));
    else if (period === 'YTD') cutoff = new Date(Date.UTC(ly, 0, 1));
    else if (period === '1Y') cutoff = new Date(Date.UTC(ly - 1, lm - 1, ld));
    else return rawTimeSeries;

    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const sliced = rawTimeSeries.filter(pt => pt.date >= cutoffStr);
    return sliced.length > 1 ? rebaseSeries(sliced) : rawTimeSeries;
  }, [rawTimeSeries, period]);

  // Reactive summary for the selected period and metric
  const periodSummary = useMemo(() => {
    if (!filteredTimeSeries || filteredTimeSeries.length === 0) {
      return { currentValue: 0, costBasis: 0, periodGain: 0, periodReturnPct: 0 };
    }

    const startPt = filteredTimeSeries[0];
    const endPt = filteredTimeSeries[filteredTimeSeries.length - 1];
    const currentValue = endPt.value;

    let periodGain;
    let periodReturnPct;

    if (chartMode === 'value') {
      // Change in market value over the window, net of money added or removed.
      const netFlow = (endPt.costBasis - startPt.costBasis);
      periodGain = endPt.value - startPt.value - netFlow;
      const startVal = startPt.value > 0 ? startPt.value : (startPt.costBasis || 1);
      periodReturnPct = (periodGain / startVal) * 100.0;
    } else {
      // Already re-based to the window by rebaseSeries.
      periodReturnPct = endPt.mwrPct;
      periodGain = endPt.pnl - startPt.pnl;
    }

    return {
      currentValue,
      costBasis: endPt.costBasis,
      periodGain,
      periodReturnPct
    };
  }, [filteredTimeSeries, chartMode]);

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
            <span className="tooltip-label">Unrealized P&amp;L:</span>
            <span className="tooltip-val" style={{ color: data.unrealizedPnl >= 0 ? '#10b981' : '#ef4444' }}>
              {data.unrealizedPnl >= 0 ? '+' : '-'}{getCurrencySymbol(displayCurrency)}{formatCurrency(Math.abs(data.unrealizedPnl || 0))}
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

  // All-Time metrics for the top hero card. These come from the same series the
  // chart draws, so the header can never disagree with the graph.
  const endPoint = rawTimeSeries.length > 0 ? rawTimeSeries[rawTimeSeries.length - 1] : null;
  const totalPortfolioValue = endPoint ? endPoint.value : 0;
  const totalGainDollars = endPoint ? endPoint.pnl : 0;
  const allTimeMwr = endPoint ? endPoint.mwrPct : 0;


  const gradientOffset = () => {
    if (filteredTimeSeries.length === 0 || chartMode === 'value') return 0;
    const dataKey = 'mwrPct';
    const dataMax = Math.max(...filteredTimeSeries.map(i => i[dataKey] || 0));
    const dataMin = Math.min(...filteredTimeSeries.map(i => i[dataKey] || 0));
    
    if (dataMax <= 0) return 0;
    if (dataMin >= 0) return 1;
    return dataMax / (dataMax - dataMin);
  };
  
  
  // Hard-stop colour bands along the x axis: green where the portfolio is worth
  // at least what was put in, red where it is not. Used for both the line and
  // its fill so the two can never disagree.
  const getGradientStops = (data, opacity = 1) => {
    if (!data || data.length === 0) return null;
    const colorAt = (pt) => (pt.value >= pt.costBasis ? '#10b981' : '#ef4444');
    const stops = [];
    let lastColor = colorAt(data[0]);

    stops.push(<stop key={0} offset="0%" stopColor={lastColor} stopOpacity={opacity} />);

    for (let i = 1; i < data.length; i++) {
      const color = colorAt(data[i]);
      if (color !== lastColor) {
        const prevOffset = `${((i - 1) / (data.length - 1)) * 100}%`;
        const currOffset = `${(i / (data.length - 1)) * 100}%`;

        stops.push(<stop key={`${i}-1`} offset={prevOffset} stopColor={lastColor} stopOpacity={opacity} />);
        stops.push(<stop key={`${i}-2`} offset={currOffset} stopColor={color} stopOpacity={opacity} />);
        lastColor = color;
      }
    }

    stops.push(<stop key="end" offset="100%" stopColor={lastColor} stopOpacity={opacity} />);
    return stops;
  };

  const off = gradientOffset();
  const renderActiveDot = (props) => {
    const { cx, cy, payload } = props;
    if (!payload) return null;
    let isRed = false;
    if (chartMode === 'value') {
      isRed = payload.value < payload.costBasis;
    } else {
      isRed = payload.mwrPct < 0;
    }
    return <circle cx={cx} cy={cy} r={4} fill={isRed ? '#ef4444' : '#10b981'} stroke="#1f2937" strokeWidth={2} />;
  };



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

        {/* MWR pill: switches the chart to cumulative MWR % */}
        <div className="graph-perf-pills">
          <button 
            type="button"
            className={`perf-pill ${allTimeMwr >= 0 ? 'positive' : 'negative'} ${chartMode === 'gain' ? 'active-selector' : ''}`}
            onClick={() => setChartMode('gain')}
            title="Graph MWR Gain (%)"
          >
            <span className="perf-label">MWR</span>
            <span className="perf-value">
              {allTimeMwr >= 0 ? '+' : ''}{allTimeMwr.toFixed(2)}%
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
              {historyLoading ? 'Loading price history…' : 'No transaction history available for graphing.'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={filteredTimeSeries} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="valueSplitColor" x1="0" y1="0" x2="1" y2="0">
                    {getGradientStops(filteredTimeSeries)}
                  </linearGradient>

                  {/* The fill reuses the line's colour bands. A linearGradient
                      has a single axis, so the vertical fade is applied as a
                      mask instead of being baked into these stops - that keeps
                      the fill matching the line segment for segment. The stops
                      still carry a base opacity so the fill stays translucent
                      even if the mask is not applied. */}
                  <linearGradient id="valueSplitFill" x1="0" y1="0" x2="1" y2="0">
                    {getGradientStops(filteredTimeSeries, 0.35)}
                  </linearGradient>
                  <linearGradient id="valueFadeDown" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity={1} />
                    <stop offset="95%" stopColor="#ffffff" stopOpacity={0} />
                  </linearGradient>
                  <mask id="valueFillMask" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
                    <rect x="0" y="0" width="100%" height="100%" fill="url(#valueFadeDown)" />
                  </mask>
                  
                  {chartMode === 'gain' && (
                    <>
                      <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
                        <stop offset={off} stopColor="#10b981" stopOpacity={1} />
                        <stop offset={off} stopColor="#ef4444" stopOpacity={1} />
                      </linearGradient>
                      <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset={0} stopColor="#10b981" stopOpacity={0.4} />
                        <stop offset={off} stopColor="#10b981" stopOpacity={0.0} />
                        <stop offset={off} stopColor="#ef4444" stopOpacity={0.0} />
                        <stop offset={1} stopColor="#ef4444" stopOpacity={0.4} />
                      </linearGradient>
                    </>
                  )}
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
                {chartMode === 'value' ? (
                  /* Fill and line are drawn as two Areas on purpose. Recharts
                     hands an Area's props to both its fill path and its stroke
                     path, so masking a single Area would fade the line itself
                     down the y axis. Splitting them lets the vertical fade
                     apply to the fill alone while the line stays crisp - and
                     both read their colour from the same cost-basis bands. */
                  <>
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="none"
                      fillOpacity={1}
                      fill="url(#valueSplitFill)"
                      mask="url(#valueFillMask)"
                      activeDot={false}
                      isAnimationActive={false}
                      legendType="none"
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="url(#valueSplitColor)"
                      strokeWidth={2.5}
                      fill="none"
                      activeDot={renderActiveDot}
                      isAnimationActive={false}
                    />
                  </>
                ) : (
                  <Area
                    type="monotone"
                    dataKey="mwrPct"
                    stroke="url(#splitColor)"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#chartGradient)"
                    activeDot={renderActiveDot}
                  />
                )}
                {chartMode === 'value' && (
                  <Line 
                    type="stepAfter" 
                    dataKey="costBasis" 
                    stroke="rgba(255, 255, 255, 0.4)" 
                    strokeWidth={2} 
                    strokeDasharray="4 4" 
                    dot={false} 
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
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
