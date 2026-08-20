import { useData } from '../context/DataContext';
import { useAuth } from '../context/AuthContext';

/**
 * Reports two independent things that were previously conflated.
 *
 * `backendStatus` is the price backend - quotes, history, FX. `syncStatus` is
 * PocketBase, which is what actually carries transactions between devices.
 * The dot used to show only the former, so it read "Connected" while nothing
 * was syncing at all; that is exactly the state a guest or signed-out session
 * sits in.
 */
const SYNC_LABELS = {
  synced: { text: 'Synced', tone: 'online', detail: 'Transactions are syncing to your account.' },
  pending: { text: 'Sync…', tone: 'pending', detail: 'Working out sync state…' },
  guest: { text: 'Local only', tone: 'warn', detail: 'Guest session — nothing is synced or backed up. Sign in to sync.' },
  'signed-out': { text: 'Not syncing', tone: 'warn', detail: 'No account session here, so data stays on this device. Sign in to sync.' },
  offline: { text: 'Sync offline', tone: 'offline', detail: 'Sync server unreachable — changes are saved locally and will sync later.' },
  locked: { text: 'Locked', tone: 'warn', detail: 'Enter your PIN to unlock and sync encrypted data.' }
};

export default function BackendStatusDot() {
  const { backendStatus, syncStatus } = useData();
  // Read the session here rather than in DataContext: AuthProvider renders a
  // stable `children` element, so React skips re-rendering the provider tree
  // when auth changes and a value derived there would never update. This
  // component subscribes to AuthContext directly, so it does.
  const { user } = useAuth();

  const pricesOnline = Boolean(backendStatus?.connected);
  const mode =
    user?.isGuest && (syncStatus?.mode === 'signed-out' || syncStatus?.mode === 'pending')
      ? 'guest'
      : syncStatus?.mode;
  const sync = SYNC_LABELS[mode] || SYNC_LABELS.pending;

  const title = [
    pricesOnline ? `Prices: connected (${backendStatus.activeUrl})` : 'Prices: offline',
    `Sync: ${sync.text} — ${sync.detail}`,
    syncStatus?.lastSyncAt ? `Last sync: ${new Date(syncStatus.lastSyncAt).toLocaleTimeString()}` : null,
    syncStatus?.error ? `Error: ${syncStatus.error}` : null
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="backend-status-badge" title={title}>
      <span className={`status-dot ${pricesOnline ? 'online' : 'offline'}`} />
      <span className="status-text desktop-only" style={{ fontSize: '11px', fontWeight: 600 }}>
        {pricesOnline ? 'Prices' : 'Offline'}
      </span>

      <span className={`status-dot sync-${sync.tone}`} style={{ marginLeft: '6px' }} />
      <span className="status-text desktop-only" style={{ fontSize: '11px', fontWeight: 600 }}>
        {sync.text}
      </span>
    </div>
  );
}
