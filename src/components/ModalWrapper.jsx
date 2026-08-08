import { motion } from 'framer-motion';
import { createPortal } from 'react-dom';

/**
 * ModalWrapper — unified open/close animation for all modals.
 * 
 * Usage:
 *   <ModalWrapper onClose={handleClose} zIndex={2000}>
 *     <div className="my-modal" onClick={e => e.stopPropagation()}>
 *       ...content...
 *     </div>
 *   </ModalWrapper>
 *
 * The wrapper handles:
 *  - Overlay fade in/out
 *  - Content scale + fade + slide up animation
 *  - Click-outside-to-close on the overlay
 *  - Portal to document.body
 *
 * Must be rendered inside <AnimatePresence> at the parent for exit animations to work.
 */

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 }
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: 20 }
};

const transition = {
  type: 'tween',
  ease: 'easeOut',
  duration: 0.2
};

export default function ModalWrapper({ children, onClose, zIndex = 1000, className = '' }) {
  return createPortal(
    <motion.div
      className={`modal-overlay ${className}`}
      onClick={onClose}
      variants={overlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={transition}
      style={{
        zIndex,
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px'
      }}
    >
      <motion.div
        variants={panelVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        transition={transition}
        style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body
  );
}
