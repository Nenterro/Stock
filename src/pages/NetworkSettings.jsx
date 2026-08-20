import React, { useState, useEffect } from 'react';
import { ArrowLeft, Server, Activity, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../context/DataContext';
import { getBackendUrls } from '../utils/api';
import { pb } from '../store/sync';
import './ManageData.css';

export default function NetworkSettings() {
  const navigate = useNavigate();
  const { backendStatus } = useData();
  const [urls, setUrls] = useState([]);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState({});

  useEffect(() => {
    setUrls(getBackendUrls());
  }, []);

  const handleTestConnections = async () => {
    setTesting(true);
    setResults({});
    const newResults = {};
    for (const url of urls) {
      try {
        const start = Date.now();
        const res = await fetch(`${url}/api/rates`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          newResults[url] = { ok: true, ms: Date.now() - start };
        } else {
          newResults[url] = { ok: false, error: `HTTP ${res.status}` };
        }
      } catch (err) {
        newResults[url] = { ok: false, error: err.name === 'AbortError' || err.name === 'TimeoutError' ? 'Timeout' : 'Network Error' };
      }
      setResults({ ...newResults }); // Update UI progressively
    }
    setTesting(false);
  };

  return (
    <div className="page-container manage-data-page">
      <div className="manage-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="Go back">
          <ArrowLeft size={24} />
        </button>
        <h1>Network Settings</h1>
      </div>

      <div className="manage-content" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* Active Connection Summary */}
        <div className="glass-panel" style={{ padding: '24px', borderRadius: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
            <div style={{ padding: '12px', borderRadius: '12px', background: backendStatus?.connected ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: backendStatus?.connected ? '#10b981' : '#ef4444' }}>
              <Activity size={24} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '18px' }}>Backend Status</h2>
              <div style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {backendStatus?.connected ? 'Connected and operational' : 'Offline or unreachable'}
              </div>
            </div>
          </div>
          
          <div style={{ background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)' }}>Active Node:</span>
              <span style={{ fontWeight: '500', color: backendStatus?.connected ? 'white' : '#ef4444' }}>
                {backendStatus?.activeUrl || 'None'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
              <span style={{ color: 'var(--text-secondary)' }}>PocketBase Base URL:</span>
              <span style={{ fontWeight: '500' }}>{pb?.baseUrl || 'Not Initialized'}</span>
            </div>
          </div>
        </div>

        {/* Node Testing */}
        <div className="glass-panel" style={{ padding: '24px', borderRadius: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <h2 style={{ margin: 0, fontSize: '18px' }}>Node Diagnostic Test</h2>
            <button 
              onClick={handleTestConnections}
              disabled={testing}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', 
                background: 'rgba(16,185,129,0.15)', color: '#10b981', 
                border: 'none', padding: '8px 16px', borderRadius: '8px',
                cursor: testing ? 'not-allowed' : 'pointer', fontWeight: '500', fontSize: '14px'
              }}
            >
              <RefreshCw size={16} style={{ animation: testing ? 'spin 1s linear infinite' : 'none' }} />
              {testing ? 'Testing...' : 'Test All Nodes'}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {urls.map(url => (
              <div key={url} style={{ 
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '16px', borderRadius: '12px', background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.05)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Server size={18} style={{ color: 'var(--text-secondary)' }} />
                  <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>{url}</span>
                </div>
                <div>
                  {!results[url] && <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Pending</span>}
                  {results[url] && results[url].ok && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#10b981', fontSize: '13px', fontWeight: '500' }}>
                      <CheckCircle size={16} />
                      {results[url].ms}ms
                    </div>
                  )}
                  {results[url] && !results[url].ok && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ef4444', fontSize: '13px', fontWeight: '500' }}>
                      <XCircle size={16} />
                      {results[url].error}
                    </div>
                  )}
                </div>
              </div>
            ))}
            
            {urls.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '16px' }}>
                No backend URLs configured.
              </div>
            )}
          </div>
          
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>

      </div>
    </div>
  );
}
