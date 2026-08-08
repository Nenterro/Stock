import React, { useState } from 'react';

export default function PoppedFieldOverlay({ field, label, onClose, initialValue, onSaveValue }) {
  const [query, setQuery] = useState(initialValue || '');

  const executeApply = () => {
    onSaveValue(query);
    onClose();
  };

  const handleBackdropClick = () => {
    executeApply();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeApply();
    }
  };

  return (
    <div className="popped-overlay" onClick={handleBackdropClick}>
      <div className="popped-container glass-panel" onClick={e => e.stopPropagation()}>
        <div className="popped-header">
          <input 
            className="popped-input"
            placeholder={`Enter ${label}...`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            type="text"
            inputMode="decimal"
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}