import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Hash } from 'lucide-react';
import ModalWrapper from './ModalWrapper';
import './UnifiedCalendar.css';

const slideVariants = {
  enter: (direction) => ({
    x: direction > 0 ? '100%' : '-100%',
    opacity: 0,
    position: 'relative'
  }),
  center: {
    x: 0,
    opacity: 1,
    position: 'relative'
  },
  exit: (direction) => ({
    x: direction > 0 ? '-100%' : '100%',
    opacity: 0,
    position: 'absolute',
    top: 0, left: 0, right: 0
  })
};

export default function UnifiedCalendar({ value, onChange, onClose, mode = 'single', zIndex }) {
  const getInitialDate = () => {
    if (mode === 'range') {
      return value?.start ? new Date(value.start) : new Date();
    }
    return value ? new Date(value) : new Date();
  };

  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = getInitialDate();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  
  const [selectedSingleDate, setSelectedSingleDate] = useState(() => mode === 'single' ? value : null);
  const [rangeStart, setRangeStart] = useState(() => mode === 'range' ? value?.start : null);
  const [rangeEnd, setRangeEnd] = useState(() => mode === 'range' ? value?.end : null);
  const [direction, setDirection] = useState(0);

  const today = new Date();
  const isNextMonthFuture = 
    currentMonth.getFullYear() > today.getFullYear() || 
    (currentMonth.getFullYear() === today.getFullYear() && currentMonth.getMonth() >= today.getMonth());

  const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
  const startDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();
  const totalCells = Math.ceil((daysInMonth + startDay) / 7) * 7;

  const handlePrevMonth = () => {
    setDirection(-1);
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    if (isNextMonthFuture) return;
    setDirection(1);
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  const handleSelectDate = (day) => {
    const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    if (mode === 'single') {
      setSelectedSingleDate(dateStr);
    } else {
      if (!rangeStart || (rangeStart && rangeEnd)) {
        setRangeStart(dateStr);
        setRangeEnd(null);
      } else {
        const startD = new Date(rangeStart);
        if (d < startD) {
          setRangeEnd(rangeStart);
          setRangeStart(dateStr);
        } else {
          setRangeEnd(dateStr);
        }
      }
    }
  };

  const handleApplyRange = () => {
    if (rangeStart && rangeEnd) {
      onChange({ start: rangeStart, end: rangeEnd });
      onClose();
    }
  };

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const formatDateForSidebar = (dateStr) => {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dd = String(d.getDate()).padStart(2, '0');
    return `${months[d.getMonth()]} ${dd}`;
  };

  return (
    <ModalWrapper onClose={onClose} zIndex={zIndex}>
      <div 
        className={`unified-calendar glass-panel ${mode === 'range' ? 'range-mode' : ''}`} 
        onClick={e => e.stopPropagation()} 
        style={{ 
          display: 'flex', 
          padding: 0, 
          overflow: 'hidden' 
        }}
      >
        {mode === 'range' && (
          <div className="calendar-sidebar">
            <div className="sidebar-group">
              <span className="sidebar-label">Start Date</span>
              <span className="sidebar-value">{formatDateForSidebar(rangeStart)}</span>
            </div>
            <div className="sidebar-group">
              <span className="sidebar-label">End Date</span>
              <span className="sidebar-value">{formatDateForSidebar(rangeEnd)}</span>
            </div>
          </div>
        )}

        <div className="calendar-main" style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="calendar-header">
            <button type="button" className="cal-nav-btn" onClick={handlePrevMonth}><ChevronLeft size={20} /></button>
            <h3>{monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}</h3>
            <button type="button" className={`cal-nav-btn ${isNextMonthFuture ? 'disabled' : ''}`} onClick={handleNextMonth} disabled={isNextMonthFuture}><ChevronRight size={20} /></button>
          </div>

          {(() => {
            return (
              <div style={{ position: 'relative', width: '100%' }}>
                <AnimatePresence initial={false} custom={direction} mode="popLayout">
                  <motion.div 
                    key={currentMonth.getTime()}
                    className="calendar-grid"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "tween", ease: "easeInOut", duration: 0.25 }}
                    style={{ width: '100%' }}
                  >
                    {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
                      <div key={day} className="cal-day-name">{day}</div>
                    ))}
                    
                    {Array.from({ length: startDay }).map((_, i) => (
                      <div key={`empty-start-${i}`} className="cal-day empty"></div>
                    ))}

                    {Array.from({ length: daysInMonth }).map((_, i) => {
                      const dayNum = i + 1;
                      const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), dayNum);
                      const dTime = d.getTime();
                      
                      let isSelected = false;
                      let inRange = false;
                      let isRangeStart = false;
                      let isRangeEnd = false;

                      if (mode === 'single') {
                        isSelected = selectedSingleDate && 
                          new Date(selectedSingleDate).getDate() === dayNum && 
                          new Date(selectedSingleDate).getMonth() === currentMonth.getMonth() &&
                          new Date(selectedSingleDate).getFullYear() === currentMonth.getFullYear();
                      } else {
                        const parseLocal = (dateStr) => {
                          if (!dateStr) return null;
                          const [y, m, day] = dateStr.split('-');
                          return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(day, 10)).getTime();
                        };
                        const startT = parseLocal(rangeStart);
                        const endT = parseLocal(rangeEnd);
                        
                        if (startT === dTime) isRangeStart = true;
                        if (endT === dTime) isRangeEnd = true;
                        if (startT && endT && dTime > startT && dTime < endT) inRange = true;
                        if (isRangeStart && !rangeEnd) isSelected = true;
                      }
                      
                      const isToday = 
                        today.getDate() === dayNum && 
                        today.getMonth() === currentMonth.getMonth() &&
                        today.getFullYear() === currentMonth.getFullYear();

                      const isFuture = 
                        currentMonth.getFullYear() > today.getFullYear() ||
                        (currentMonth.getFullYear() === today.getFullYear() && currentMonth.getMonth() > today.getMonth()) ||
                        (currentMonth.getFullYear() === today.getFullYear() && currentMonth.getMonth() === today.getMonth() && dayNum > today.getDate());

                      let classNames = 'cal-day';
                      if (isSelected) classNames += ' selected';
                      if (isToday && !isSelected && !inRange && !isRangeStart && !isRangeEnd) classNames += ' today';
                      if (isFuture) classNames += ' disabled';
                      if (isRangeStart) classNames += ' range-start selected';
                      if (isRangeEnd) classNames += ' range-end selected';
                      if (inRange) classNames += ' in-range';

                      return (
                        <button 
                          key={dayNum} 
                          type="button"
                          className={classNames}
                          onClick={() => !isFuture && handleSelectDate(dayNum)}
                          disabled={isFuture}
                        >
                          {dayNum}
                        </button>
                      );
                    })}

                    {Array.from({ length: totalCells - startDay - daysInMonth }).map((_, i) => (
                      <div key={`empty-end-${i}`} className="cal-day empty"></div>
                    ))}
                  </motion.div>
                </AnimatePresence>
              </div>
            );
          })()}

          <div className="calendar-actions" style={{ marginTop: 'auto', paddingTop: '24px' }}>
            <button className="cancel-btn" onClick={onClose}>Cancel</button>
            <button 
              className="apply-btn" 
              disabled={mode === 'range' ? (!rangeStart || !rangeEnd) : !selectedSingleDate}
              onClick={() => {
                if (mode === 'range') {
                  handleApplyRange();
                } else {
                  onChange(selectedSingleDate);
                  onClose();
                }
              }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
}
