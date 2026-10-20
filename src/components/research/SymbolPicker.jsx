import { createPortal } from 'react-dom';
import AssetSelect from '../AssetSelect';
import '../AddTransactionModal.css';

/**
 * The transaction modal's asset search, usable on its own. AssetSelect's
 * overlay is absolutely positioned inside its parent, so it gets a fixed,
 * full-screen parent here.
 */
export default function SymbolPicker({ onSelect, onClose }) {
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '8vh' }}>
      <div style={{ position: 'relative', width: 'min(560px, 100%)', height: 'min(620px, 84vh)' }}>
        <AssetSelect onSelect={(asset) => onSelect(asset)} onClose={onClose} />
      </div>
    </div>,
    document.body
  );
}
