import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import './UnifiedDropdown.css';

export default function UnifiedDropdown({ value, options, onChange, placeholder = "Select..." }) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState({});
  const containerRef = useRef(null);
  const menuRef = useRef(null);

  const selectedOption = options.find(opt => opt.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder;

  useEffect(() => {
    function handleClickOutside(event) {
      if (
        containerRef.current && !containerRef.current.contains(event.target) &&
        menuRef.current && !menuRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const estimatedHeight = Math.min(options.length * 44 + 16, 250);

      const openUpwards = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

      setDropdownStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        ...(openUpwards 
          ? { bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(spaceAbove - 24, 150) } 
          : { top: rect.bottom + 8, maxHeight: Math.max(spaceBelow - 24, 150) }),
        zIndex: 3000,
        overflowY: 'auto'
      });
    }
  }, [isOpen, options.length]);

  const handleSelect = (val) => {
    onChange(val);
    setIsOpen(false);
  };

  return (
    <div className="unified-dropdown" ref={containerRef}>
      <div 
        className={`dropdown-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="dropdown-label">{displayLabel}</span>
        <ChevronDown size={18} className="dropdown-icon" />
      </div>

      {isOpen && createPortal(
        <div className="dropdown-menu glass-panel" style={{ ...dropdownStyle, margin: 0, transform: 'none', right: 'auto' }} ref={menuRef}>
          {options.map((opt) => (
            <div 
              key={opt.value}
              className={`dropdown-item ${opt.value === value ? 'selected' : ''}`}
              onClick={() => handleSelect(opt.value)}
            >
              {opt.label}
            </div>
          ))}
          {options.length === 0 && (
            <div className="dropdown-empty">No options available</div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
