import React, { useEffect, useState } from 'react';
import { ArrowLeft, Bell, BellOff, Send } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { pushSupport, pushStatus, enablePush, disablePush, savePushPrefs, sendTestPush } from '../utils/push';
import './ManageData.css';

// The thresholds the hub lets this app change, in the order shown.
const SETTINGS = [
  { id: 'bigMovePct', label: 'Big move in a holding', unit: '% in a day', min: 1, max: 50 },
  { id: 'portfolioMovePct', label: 'Portfolio day move', unit: '% in a day', min: 0.5, max: 50, step: 0.5 },
  { id: 'quietStart', label: 'Quiet hours start', unit: ':00', min: 0, max: 23 },
  { id: 'quietEnd', label: 'Quiet hours end', unit: ':00', min: 0, max: 23 }
];

const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '14px 16px' };
const divider = { borderTop: '1px solid rgba(255,255,255,0.05)' };

export default function NotificationSettings() {
  const navigate = useNavigate();
  const [support] = useState(pushSupport);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const run = async (work, done = '') => {
    setBusy(true);
    setMessage('');
    try {
      const next = await work();
      if (next?.types) setStatus(next);
      setMessage(done);
    } catch (err) {
      setMessage(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (support.supported && support.signedIn) run(pushStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const on = Boolean(status?.subscribed) && support.permission !== 'denied';
  const blocker = !support.signedIn
    ? 'Sign in to get notifications.'
    : support.needsInstall
      ? 'Add this app to your Home Screen first (Share, then Add to Home Screen). iPhone only allows notifications for Home Screen apps.'
      : !support.supported
        ? 'This browser does not support notifications.'
        : '';

  return (
    <div className="page-container manage-data-page">
      <div className="manage-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="Go back">
          <ArrowLeft size={24} />
        </button>
        <h1>Notifications</h1>
      </div>

      <div className="manage-content" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div className="glass-panel" style={{ padding: '20px', borderRadius: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ padding: '12px', borderRadius: '12px', background: on ? 'rgba(16,185,129,0.1)' : 'rgba(255,255,255,0.06)', color: on ? '#10b981' : 'var(--text-secondary)' }}>
              {on ? <Bell size={24} /> : <BellOff size={24} />}
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, fontSize: '18px' }}>{on ? 'On for this device' : 'Off for this device'}</h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {blocker || 'Alerts, price moves and new analyses, sent to this phone.'}
              </div>
            </div>
          </div>
          {!blocker && (
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button
                className="btn-primary"
                disabled={busy}
                style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', fontWeight: 600, cursor: 'pointer', background: on ? 'rgba(255,255,255,0.08)' : 'var(--accent-color)', color: 'white' }}
                onClick={() => (on ? run(async () => { await disablePush(); return pushStatus(); }, 'Notifications turned off.') : run(enablePush, 'Notifications turned on.'))}
              >
                {on ? 'Turn off' : 'Turn on'}
              </button>
              {on && (
                <button
                  disabled={busy}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderRadius: '12px', border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.08)', color: 'white' }}
                  onClick={() => run(sendTestPush, 'Test sent.')}
                >
                  <Send size={16} /> Send test
                </button>
              )}
            </div>
          )}
          {message && <div style={{ marginTop: '12px', fontSize: '14px', color: 'var(--text-secondary)' }}>{message}</div>}
        </div>

        {on && status && (
          <>
            <div className="glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
              {status.types.map((t, i) => (
                <label key={t.id} style={{ ...row, ...(i ? divider : {}), cursor: 'pointer' }}>
                  <span style={{ fontSize: '16px' }}>{t.label}</span>
                  <input
                    type="checkbox"
                    checked={t.on}
                    disabled={busy}
                    onChange={(e) => run(() => savePushPrefs({ types: { [t.id]: e.target.checked } }))}
                    style={{ width: '20px', height: '20px', accentColor: 'var(--accent-color)' }}
                  />
                </label>
              ))}
            </div>

            <div className="glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
              {SETTINGS.map((s, i) => (
                <div key={s.id} style={{ ...row, ...(i ? divider : {}) }}>
                  <span style={{ fontSize: '16px' }}>{s.label}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={s.min}
                      max={s.max}
                      step={s.step || 1}
                      defaultValue={status.settings[s.id]}
                      key={`${s.id}-${status.settings[s.id]}`}
                      disabled={busy}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (!Number.isFinite(value) || value < s.min || value > s.max || value === status.settings[s.id]) {
                          e.target.value = status.settings[s.id];
                          return;
                        }
                        run(() => savePushPrefs({ settings: { [s.id]: value } }));
                      }}
                      style={{ width: '64px', padding: '8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'white', textAlign: 'right', fontSize: '16px' }}
                    />
                    {s.unit}
                  </span>
                </div>
              ))}
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '0 12px' }}>
              During quiet hours, notifications wait and arrive together once they end. The switches are for this device; the numbers apply to all your devices.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
