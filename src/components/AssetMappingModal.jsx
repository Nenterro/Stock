import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, AlertTriangle, ArrowRight, X } from 'lucide-react';
import AssetSelect from './AssetSelect';
import './AddTransactionModal.css'; // Reuse modal styles

export default function AssetMappingModal({ isOpen, unmappedTickers, onComplete, onCancel }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [mappings, setMappings] = useState({});
  const [showSearch, setShowSearch] = useState(false);

  if (!isOpen || !unmappedTickers || unmappedTickers.length === 0) return null;

  const currentTicker = unmappedTickers[currentIndex];

  const handleSelect = (selectedAsset) => {
    const newMappings = {
      ...mappings,
      [currentTicker.toUpperCase()]: {
        symbol: selectedAsset.symbol,
        name: selectedAsset.name,
        exchange: selectedAsset.exchange || ''
      }
    };
    
    setMappings(newMappings);
    setShowSearch(false);

    if (currentIndex < unmappedTickers.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      onComplete(newMappings);
    }
  };

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 3000 }}>
      <motion.div 
        className="modal-content"
        initial={{ y: 50, opacity: 0, scale: 0.95 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        style={{ maxWidth: '450px', width: '100%' }}
      >
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={20} color="#eab308" />
            Unknown Assets Found
          </h2>
          <button className="close-btn" type="button" onClick={onCancel}><X size={20} /></button>
        </div>

        <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>
          <p style={{ marginBottom: '16px' }}>
            Your import contains assets that aren't mapped in your database. 
            Please search for them to establish a link.
          </p>
          
          <div style={{ background: 'var(--bg-secondary)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginBottom: '24px' }}>
            <div style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
              Asset {currentIndex + 1} of {unmappedTickers.length}
            </div>
            <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
              {currentTicker}
            </div>
          </div>

          <button 
            className="submit-btn bg-primary" 
            style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
            onClick={() => setShowSearch(true)}
          >
            <Search size={18} />
            Search for {currentTicker}
          </button>
        </div>
      </motion.div>

      {showSearch && (
        <AssetSelect 
          initialQuery={currentTicker}
          onClose={() => setShowSearch(false)}
          onSelect={handleSelect}
        />
      )}
    </div>,
    document.body
  );
}
