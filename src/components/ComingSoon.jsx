import { Hammer } from 'lucide-react';
import './ComingSoon.css';

/**
 * Placeholder for pages that are routed but not built yet.
 *
 * Shared so the unfinished sections read the same rather than each inventing
 * its own empty state.
 */
export default function ComingSoon({ title, note }) {
  return (
    <div className="page-container">
      <div className="content-pad">
        <h1 className="page-title">{title}</h1>
        <div className="coming-soon">
          <div className="coming-soon-icon">
            <Hammer size={28} />
          </div>
          <p className="coming-soon-title">To be added</p>
          {note && <p className="coming-soon-note">{note}</p>}
        </div>
      </div>
    </div>
  );
}
