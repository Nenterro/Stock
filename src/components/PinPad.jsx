import React, { useEffect } from 'react';
import { Delete } from 'lucide-react';
import './PinPad.css';

export default function PinPad({ value = '', onChange, onSubmit, maxLength = 4, title, subtitle }) {
  const handleKeyPress = (numStr) => {
    if (value.length < maxLength) {
      const nextVal = value + numStr;
      onChange(nextVal);
      if (nextVal.length === maxLength && onSubmit) {
        onSubmit(nextVal);
      }
    }
  };

  const handleDelete = () => {
    if (value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is inside an input/textarea (though PinPad doesn't use input)
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key >= '0' && e.key <= '9') {
        handleKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        handleDelete();
      } else if (e.key === 'Enter') {
        if (value.length === maxLength && onSubmit) {
          onSubmit(value);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [value, maxLength, onSubmit]);

  return (
    <div className="pin-pad-container">
      {title && <h2 className="pin-pad-title">{title}</h2>}
      {subtitle && <p className="pin-pad-subtitle">{subtitle}</p>}

      {/* 4 Indicator Dots */}
      <div className="pin-dots">
        {Array.from({ length: maxLength }).map((_, idx) => (
          <div 
            key={idx} 
            className={`pin-dot ${idx < value.length ? 'filled' : ''}`}
          />
        ))}
      </div>

      {/* Onscreen Keypad */}
      <div className="pin-keypad-grid">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
          <button 
            key={num} 
            type="button" 
            className="keypad-btn" 
            onClick={() => handleKeyPress(num)}
          >
            {num}
          </button>
        ))}
        <div className="keypad-btn-placeholder" />
        <button 
          type="button" 
          className="keypad-btn" 
          onClick={() => handleKeyPress('0')}
        >
          0
        </button>
        <button 
          type="button" 
          className="keypad-btn action-btn" 
          onClick={handleDelete}
          aria-label="Delete"
        >
          <Delete size={22} />
        </button>
      </div>
    </div>
  );
}
