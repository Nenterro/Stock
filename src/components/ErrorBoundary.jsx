import React from 'react';
import localforage from 'localforage';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Uncaught application error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleResetData = async () => {
    try {
      await localforage.clear();
      localStorage.clear();
      window.location.href = '/login';
    } catch (e) {
      console.error(e);
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#0a0a0f',
          color: '#f3f4f6',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          boxSizing: 'border-box'
        }}>
          <div style={{
            background: 'rgba(30, 30, 42, 0.95)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '24px',
            padding: '32px 24px',
            maxWidth: '520px',
            width: '100%',
            boxShadow: '0 20px 48px rgba(0,0,0,0.6)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            boxSizing: 'border-box'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: '#ef4444' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>Something went wrong</h2>
            </div>

            <p style={{ margin: 0, fontSize: '14px', color: '#9ca3af', lineHeight: 1.5 }}>
              An unexpected error occurred while rendering the app.
            </p>

            <div style={{
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '12px 14px',
              maxHeight: '160px',
              overflowY: 'auto',
              fontSize: '12px',
              fontFamily: 'monospace',
              color: '#f87171',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap'
            }}>
              {this.state.error?.toString()}
              {this.state.errorInfo?.componentStack}
            </div>

            <div style={{ display: 'flex', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
              <button 
                onClick={() => window.location.reload()} 
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: '12px',
                  border: 'none',
                  background: '#6366f1',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: 'pointer'
                }}
              >
                Reload App
              </button>
              <button 
                onClick={this.handleResetData} 
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: '#f3f4f6',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: 'pointer'
                }}
              >
                Clear Session & Login
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
