import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { NavLink } from 'react-router-dom';
import { Settings, X, Calculator, Eye, Home, Filter, Sparkles, Target } from 'lucide-react';
import './MoreMenuModal.css';

export default function MoreMenuModal({ isOpen, onClose }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div 
          className="more-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div 
            className="more-modal-content"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="more-modal-header">
              <h3>More Options</h3>
              <button className="close-btn" onClick={onClose}><X size={20} /></button>
            </div>
            
            <div className="more-modal-body">
              <NavLink to="/" end className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Home size={20} /></div>
                <span>Overview</span>
              </NavLink>
              <NavLink to="/insights" className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Sparkles size={20} /></div>
                <span>Insights</span>
              </NavLink>
              <NavLink to="/screener" className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Filter size={20} /></div>
                <span>Screener</span>
              </NavLink>
              <NavLink to="/planner" className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Target size={20} /></div>
                <span>Planner</span>
              </NavLink>
              <NavLink to="/watchlist" className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Eye size={20} /></div>
                <span>Watchlist</span>
              </NavLink>
              <NavLink to="/transactions" className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Calculator size={20} /></div>
                <span>Transactions</span>
              </NavLink>
              <NavLink to="/settings" className="more-menu-item" onClick={onClose}>
                <div className="more-icon-circle"><Settings size={20} /></div>
                <span>General Settings</span>
              </NavLink>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
