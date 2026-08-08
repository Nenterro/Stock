import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import './AddTransactionModal.css';

export default function AddTransactionModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Transaction</h2>
          <button className="close-btn" onClick={onClose}><X size={24} /></button>
        </div>
        <div style={{ padding: '24px', color: 'var(--text-secondary)' }}>
          Transaction form placeholder.
        </div>
      </div>
    </div>
  );
}
