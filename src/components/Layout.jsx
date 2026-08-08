import { useState, useRef } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { LineChart, BarChart2, Eye, Pin, PinOff, Plus, Home, Menu, Briefcase, MoreHorizontal, Settings } from 'lucide-react';
import AddTransactionModal from './AddTransactionModal';
import MoreMenuModal from './MoreMenuModal';
import { useData } from '../context/DataContext';
import './Layout.css';

const NAV_ITEMS = [
  { path: '/', label: 'Home', icon: Home },
  { path: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { path: '/graph', label: 'Graph', icon: LineChart },
  { path: '/analytics', label: 'Analytics', icon: BarChart2 },
  { path: '/watchlist', label: 'Watchlist', icon: Eye },
  { path: '/transactions', label: 'Transactions', icon: Menu },
];

function GradientDef() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        <linearGradient id="icon-gradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent-color)" offset="0%" />
          <stop stopColor="var(--accent-color)" offset="100%" stopOpacity={0.6} />
        </linearGradient>
      </defs>
    </svg>
  );
}

function BackendStatusDot({ backendStatus }) {
  const isOnline = backendStatus?.connected;
  const tooltipText = isOnline 
    ? `Backend Connected (${backendStatus.activeUrl})` 
    : 'Backend Disconnected (Offline)';

  return (
    <div className="backend-status-badge" title={tooltipText}>
      <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
      <span style={{ fontSize: '11px' }}>{isOnline ? 'Connected' : 'Offline'}</span>
    </div>
  );
}

function Sidebar({ isPinned, togglePin, onOpenAdd, backendStatus }) {
  return (
    <div className={`sidebar-wrapper desktop-only ${isPinned ? 'pinned' : 'unpinned'}`}>
      <aside className={`sidebar glass-panel ${isPinned ? 'pinned' : 'unpinned'}`}>
        <div className="sidebar-header">
          <h1 className="gradient-text title">Stock Tracker</h1>
          <button className="pin-btn" onClick={togglePin} title={isPinned ? "Unpin Sidebar" : "Pin Sidebar"}>
            {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
        </div>
        <nav className="sidebar-nav">
          <button className="nav-item add-tx-btn" onClick={onOpenAdd} style={{ width: '100%', background: 'var(--accent-gradient)', color: '#fff', border: 'none', cursor: 'pointer', marginBottom: '16px' }}>
            <Plus size={20} className="nav-icon" />
            <span className="nav-label">Add Transaction</span>
          </button>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.path} to={item.path} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title={item.label}>
              <item.icon size={20} className="nav-icon" />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <NavLink to="/settings" className={({ isActive }) => `nav-item settings-item ${isActive ? 'active' : ''}`} title="Settings">
            <Settings size={20} className="nav-icon" />
            <span className="nav-label">Settings</span>
          </NavLink>
        </div>
      </aside>
    </div>
  );
}

function BottomNav({ onOpenAdd, onOpenMore }) {
  const [activeTooltip, setActiveTooltip] = useState(null);
  const timeoutRef = useRef(null);

  const handleNavClick = (label) => {
    setActiveTooltip(label);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setActiveTooltip(null);
    }, 1500);
  };

  return (
    <nav className="bottom-nav mobile-only">
      <NavLink to="/portfolio" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title="Portfolio" onClick={() => handleNavClick('Portfolio')}>
        <Briefcase size={24} />
      </NavLink>
      <NavLink to="/graph" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title="Graph" onClick={() => handleNavClick('Graph')}>
        <LineChart size={24} />
      </NavLink>
      
      <div className="fab-container">
        <button className="fab-btn" title="Add Transaction" onClick={() => { onOpenAdd(); handleNavClick('Add'); }}>
          <Plus size={28} color="#fff" />
        </button>
      </div>

      <NavLink to="/analytics" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title="Analytics" onClick={() => handleNavClick('Analytics')}>
        <BarChart2 size={24} />
      </NavLink>
      
      <button className="nav-item" onClick={onOpenMore} title="More">
        <MoreHorizontal size={24} />
      </button>
    </nav>
  );
}

export default function Layout() {
  const [isSidebarPinned, setIsSidebarPinned] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const { backendStatus } = useData();
  const location = useLocation();

  return (
    <div className="app-container">
      <GradientDef />
      <Sidebar isPinned={isSidebarPinned} togglePin={() => setIsSidebarPinned(!isSidebarPinned)} onOpenAdd={() => setIsAddOpen(true)} backendStatus={backendStatus} />
      
      <div className="main-wrapper">
        <main className="main-content">
          <div key={location.pathname} className="page-transition-wrapper">
            <Outlet />
          </div>
        </main>
        <BottomNav onOpenAdd={() => setIsAddOpen(true)} onOpenMore={() => setIsMoreOpen(true)} />
      </div>

      <AnimatePresence>
        {isAddOpen && <AddTransactionModal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} />}
      </AnimatePresence>
      <MoreMenuModal isOpen={isMoreOpen} onClose={() => setIsMoreOpen(false)} />
    </div>
  );
}
