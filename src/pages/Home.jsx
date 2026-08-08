import { useState, useMemo } from 'react';
import { useData } from '../context/DataContext';
import { usePageSettings, useAppearanceSettings } from '../context/SettingsContext';
import { Filter, Settings, Plus, Briefcase, TrendingUp, PieChart, Activity, Trash2 } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import UnifiedDropdown from '../components/UnifiedDropdown';
import UnifiedCalendar from '../components/UnifiedCalendar';
import FilterModal from '../components/FilterModal';
import { formatCurrency, getCurrencySymbol } from '../utils/format';
import { parseISO, isAfter, isBefore, startOfMonth, subMonths, endOfMonth, subDays, startOfYear } from 'date-fns';
import './Home.css';

const PERIODS = ['All Time', 'This Month', 'Last Month', 'Last 3 Months', 'This Year', 'Custom Range'];

export default function Home() {
  const navigate = useNavigate();
  const { transactions, portfolios } = useData();
  const { baseCurrency } = useAppearanceSettings();

  const { 
    selectedPeriod, setSelectedPeriod, 
    customRange, setCustomRange, 
    filterState, setFilterState 
  } = usePageSettings('dashboard');

  const [showCustomRangeModal, setShowCustomRangeModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);

  // Filter transactions according to selected period and filter modal criteria
  const filteredTransactions = useMemo(() => {
    let result = transactions || [];

    // Filter by type exclusion
    if (filterState.excludedTypes && filterState.excludedTypes.size > 0) {
      result = result.filter(tx => !filterState.excludedTypes.has((tx.type || '').toUpperCase()));
    }

    // Filter by portfolio exclusion
    if (filterState.excludedPortfolios && filterState.excludedPortfolios.size > 0) {
      result = result.filter(tx => !filterState.excludedPortfolios.has(tx.portfolio));
    }

    // Filter by period
    const now = new Date();
    if (selectedPeriod !== 'All Time') {
      let start, end = now;
      if (selectedPeriod === 'This Month') start = startOfMonth(now);
      else if (selectedPeriod === 'Last Month') {
        start = startOfMonth(subMonths(now, 1));
        end = endOfMonth(subMonths(now, 1));
      }
      else if (selectedPeriod === 'Last 3 Months') start = subDays(now, 90);
      else if (selectedPeriod === 'This Year') start = startOfYear(now);
      else if (selectedPeriod === 'Custom Range' && customRange?.start && customRange?.end) {
        start = new Date(customRange.start);
        start.setHours(0, 0, 0, 0);
        end = new Date(customRange.end);
        end.setHours(23, 59, 59, 999);
      }

      if (start && end) {
        result = result.filter(tx => {
          if (!tx.date) return true;
          const d = parseISO(tx.date);
          return isAfter(d, start) && isBefore(d, end);
        });
      }
    }

    return result;
  }, [transactions, selectedPeriod, customRange, filterState]);

  // Compute portfolio values
  const portfolioBalances = useMemo(() => {
    const map = {};

    // Initialize with existing portfolio definitions
    if (portfolios && portfolios.length > 0) {
      portfolios.forEach(p => {
        map[p.name] = { name: p.name, currency: p.currency || baseCurrency || 'USD', value: 0, count: 0 };
      });
    }

    // Accumulate value from transactions
    filteredTransactions.forEach(tx => {
      const pName = tx.portfolio || 'Default Portfolio';
      if (!map[pName]) {
        map[pName] = { name: pName, currency: tx.currency || baseCurrency || 'USD', value: 0, count: 0 };
      }
      map[pName].count += 1;

      const amt = Number(tx.amount) || 0;
      const type = (tx.type || '').toLowerCase();

      if (type === 'buy' || type === 'deposit') {
        map[pName].value += amt;
      } else if (type === 'sell' || type === 'withdraw') {
        map[pName].value -= amt;
      } else if (type === 'dividend') {
        map[pName].value += amt;
      } else if (type === 'tax') {
        map[pName].value -= amt;
      } else {
        map[pName].value += amt;
      }
    });

    return Object.values(map);
  }, [portfolios, filteredTransactions, baseCurrency]);

  // Total balance across all portfolios
  const totalBalance = useMemo(() => {
    return portfolioBalances.reduce((sum, p) => sum + (p.value || 0), 0);
  }, [portfolioBalances]);

  // Widgets State
  const [activeWidgets, setActiveWidgets] = useState([
    { id: 'w1', type: 'allocation', title: 'Portfolio Allocation' },
    { id: 'w2', type: 'activity', title: 'Recent Activity' }
  ]);

  const handleRemoveWidget = (id) => {
    setActiveWidgets(activeWidgets.filter(w => w.id !== id));
  };

  const handleAddWidget = () => {
    const available = [
      { id: `w_${Date.now()}_1`, type: 'allocation', title: 'Portfolio Allocation' },
      { id: `w_${Date.now()}_2`, type: 'activity', title: 'Recent Activity' },
      { id: `w_${Date.now()}_3`, type: 'performance', title: 'Performance Overview' },
      { id: `w_${Date.now()}_4`, type: 'holdings', title: 'Top Holdings' }
    ];
    const unused = available.find(a => !activeWidgets.some(w => w.title === a.title));
    if (unused) {
      setActiveWidgets([...activeWidgets, unused]);
    } else {
      alert("All available widgets are already added to your dashboard.");
    }
  };

  const hasActiveFilters = (filterState.excludedTypes && filterState.excludedTypes.size > 0) ||
    (filterState.excludedPortfolios && filterState.excludedPortfolios.size > 0);

  return (
    <div className="page-container tx-page">
      <div className="home-dashboard">
        {/* Top Header */}
        <div className="dashboard-header">
          <div className="dashboard-title-group">
            <h1>Home</h1>
          </div>

          <div className="dashboard-controls">
            <div style={{ minWidth: '160px', maxWidth: '220px' }}>
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

            <NavLink to="/settings" className="mobile-only icon-btn" title="Settings" style={{ textDecoration: 'none' }}>
              <Settings size={20} />
            </NavLink>
          </div>
        </div>

        {/* Total Balance Hero Pill */}
        <div className="glass-panel total-balance-pill">
          <div className="balance-label">Total Balance</div>
          <div className="balance-amount">
            {getCurrencySymbol(baseCurrency)}{formatCurrency(totalBalance)}
          </div>
          <div className="balance-stats-row">
            <div className="stat-item">
              <span className="stat-label">Active Portfolios</span>
              <span className="stat-value">{portfolioBalances.length}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">Total Transactions</span>
              <span className="stat-value">{filteredTransactions.length}</span>
            </div>
          </div>
        </div>

        {/* Value per Portfolio Horizontal Scroller */}
        <div className="portfolios-section">
          <div className="section-header">
            <span className="section-title">Portfolios</span>
          </div>

          <div className="portfolios-scroller">
            {portfolioBalances.map(p => (
              <div key={p.name} className="portfolio-card">
                <div className="portfolio-card-header">
                  <span className="portfolio-name">{p.name}</span>
                  <div className="portfolio-actions">
                    <button className="action-icon-btn" onClick={() => navigate('/settings/portfolios')} title="Manage Portfolio">
                      <Briefcase size={14} />
                    </button>
                  </div>
                </div>
                <div className="portfolio-value">
                  {getCurrencySymbol(p.currency)}{formatCurrency(p.value)}
                </div>
                <div className="portfolio-subtext">
                  {p.count} transaction{p.count !== 1 ? 's' : ''}
                </div>
              </div>
            ))}

            <div className="add-portfolio-card" onClick={() => navigate('/settings/portfolios')}>
              <Plus size={20} />
              <span>Add Portfolio</span>
            </div>
          </div>
        </div>

        {/* Space for Adding Widgets */}
        <div className="widgets-section">
          <div className="section-header">
            <span className="section-title">Dashboard Widgets</span>
          </div>

          <div className="dashboard-widgets-grid">
            {activeWidgets.map(widget => (
              <div key={widget.id} className="widget-card">
                <div className="widget-card-header">
                  <span className="widget-card-title">{widget.title}</span>
                  <div className="widget-header-actions">
                    <button 
                      className="widget-remove-btn" 
                      onClick={() => handleRemoveWidget(widget.id)} 
                      title="Remove Widget"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="widget-card-content">
                  {widget.type === 'allocation' && (
                    <>
                      <PieChart size={32} style={{ marginBottom: '8px', opacity: 0.5, color: 'var(--accent-color)' }} />
                      <span>Portfolio Allocation Widget</span>
                    </>
                  )}
                  {widget.type === 'activity' && (
                    <>
                      <Activity size={32} style={{ marginBottom: '8px', opacity: 0.5, color: 'var(--accent-color)' }} />
                      <span>{filteredTransactions.length} transactions in selected period</span>
                    </>
                  )}
                  {widget.type === 'performance' && (
                    <>
                      <TrendingUp size={32} style={{ marginBottom: '8px', opacity: 0.5, color: 'var(--accent-color)' }} />
                      <span>Performance Overview Widget</span>
                    </>
                  )}
                  {widget.type === 'holdings' && (
                    <>
                      <Briefcase size={32} style={{ marginBottom: '8px', opacity: 0.5, color: 'var(--accent-color)' }} />
                      <span>{portfolioBalances.length} active portfolio holdings</span>
                    </>
                  )}
                </div>
              </div>
            ))}

            <div className="add-widget-card" onClick={handleAddWidget}>
              <div className="add-icon-circle">
                <Plus size={24} />
              </div>
              <span>Add Widget</span>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showCustomRangeModal && (
          <UnifiedCalendar
            value={customRange}
            onChange={(range) => { 
              setCustomRange(range); 
              setSelectedPeriod('Custom Range'); 
              setShowCustomRangeModal(false); 
            }}
            onClose={() => setShowCustomRangeModal(false)}
            mode="range"
          />
        )}
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
