import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

window.addEventListener('error', e => {
  fetch('http://localhost:3005/log', { method: 'POST', body: e.message || e.error?.message });
});
window.addEventListener('unhandledrejection', e => {
  fetch('http://localhost:3005/log', { method: 'POST', body: e.reason?.message });
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
