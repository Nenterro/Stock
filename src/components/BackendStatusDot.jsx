import { useData } from '../context/DataContext';

export default function BackendStatusDot() {
  const { backendStatus } = useData();
  const isOnline = backendStatus?.connected;
  const tooltipText = isOnline 
    ? `Backend Connected (${backendStatus.activeUrl})` 
    : 'Backend Disconnected (Offline)';

  return (
    <div className="backend-status-badge" title={tooltipText}>
      <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
      <span className="status-text desktop-only" style={{ fontSize: '11px', fontWeight: 600 }}>
        {isOnline ? 'Connected' : 'Offline'}
      </span>
    </div>
  );
}
