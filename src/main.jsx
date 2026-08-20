import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// These previously POSTed every error to http://localhost:3005/log, which does
// not exist on a phone - and a failed fetch inside the unhandledrejection
// handler can trigger another rejection. Log locally instead.
window.addEventListener('error', (e) => {
  console.error('[uncaught]', e.message || e.error?.message || e);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason?.message || e.reason);
});

import ErrorBoundary from './components/ErrorBoundary.jsx'
import { SettingsProvider } from './context/SettingsContext'
import { AuthProvider } from './context/AuthContext'
import { DataProvider } from './context/DataContext'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <SettingsProvider>
          <DataProvider>
            <App />
          </DataProvider>
        </SettingsProvider>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)

// Register the service worker so the app launches from the home screen and
// survives a cold start without a network. Dev is left alone: a cached shell
// during development just hides changes.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // Take a waiting update immediately rather than after two restarts.
        if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', () => {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              next.postMessage('SKIP_WAITING');
            }
          });
        });
      })
      .catch((err) => console.warn('Service worker registration failed:', err));
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
