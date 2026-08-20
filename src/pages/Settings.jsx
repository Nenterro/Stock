import { useNavigate } from 'react-router-dom';
import { Shield, Briefcase, ChevronRight, LogOut, LogIn, RefreshCw, Upload, Download, Server, Mail } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  return (
    <div className="page-container">
      <div className="content-pad">
        <h1 className="page-title">Settings</h1>
        <p className="text-secondary mt-2">App configuration, integrations, and preferences.</p>

        {/* Section 1: Import & Integrations */}
        <div className="settings-section" style={{ marginTop: '32px' }}>
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginLeft: '12px' }}>
            Import & Integrations
          </h3>
          
          <div className="settings-list glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
            <div 
              className="settings-item" 
              onClick={() => navigate('/settings/import/ibkr')} 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'rgba(239, 68, 68, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444' }}>
                  <RefreshCw size={20} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '16px', fontWeight: '500' }}>Interactive Brokers (IBKR)</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Flex Web Service API & CSV Statement Import</span>
                </div>
              </div>
              <ChevronRight size={20} style={{ color: 'var(--text-secondary)' }} />
            </div>

            <div 
              className="settings-item" 
              onClick={() => navigate('/settings/import/ktrade')} 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderTop: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'rgba(16, 185, 129, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
                  <Mail size={20} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '16px', fontWeight: '500' }}>KTrade (KASB)</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Trade confirmations from email or PDF</span>
                </div>
              </div>
              <ChevronRight size={20} style={{ color: 'var(--text-secondary)' }} />
            </div>

            <div 
              className="settings-item" 
              onClick={() => navigate('/settings/import/csv')} 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderTop: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'rgba(59, 130, 246, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6' }}>
                  <Download size={20} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '16px', fontWeight: '500' }}>CSV Import</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Import stock trades from a CSV file</span>
                </div>
              </div>
              <ChevronRight size={20} style={{ color: 'var(--text-secondary)' }} />
            </div>
          </div>
        </div>

        {/* Section 2: Account & Data */}
        <div className="settings-section" style={{ marginTop: '32px' }}>
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginLeft: '12px' }}>
            Account & Data
          </h3>
          
          <div className="settings-list glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
            <div 
              className="settings-item" 
              onClick={() => navigate('/settings/portfolios')} 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'rgba(16, 185, 129, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
                  <Briefcase size={20} />
                </div>
                <span style={{ fontSize: '16px', fontWeight: '500' }}>Manage Portfolios</span>
              </div>
              <ChevronRight size={20} style={{ color: 'var(--text-secondary)' }} />
            </div>

            <div 
              className="settings-item" 
              onClick={() => navigate('/settings/security')} 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'rgba(16, 185, 129, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981' }}>
                  <Shield size={20} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '16px', fontWeight: '500' }}>Security & Encryption</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>E2EE PIN Settings</span>
                </div>
              </div>
              <ChevronRight size={20} style={{ color: 'var(--text-secondary)' }} />
            </div>
          </div>
        </div>

        {/* Section 3: System & Network */}
        <div className="settings-section" style={{ marginTop: '32px' }}>
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px', marginLeft: '12px' }}>
            System & Network
          </h3>
          
          <div className="settings-list glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
            <div 
              className="settings-item" 
              onClick={() => navigate('/settings/network')} 
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: 'rgba(245, 158, 11, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f59e0b' }}>
                  <Server size={20} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '16px', fontWeight: '500' }}>Backend Connection</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Troubleshoot Connectivity & APIs</span>
                </div>
              </div>
              <ChevronRight size={20} style={{ color: 'var(--text-secondary)' }} />
            </div>
          </div>
        </div>

        {/* Section 4: Session */}
        <div className="settings-section" style={{ marginTop: '32px' }}>
          <div className="settings-list glass-panel" style={{ borderRadius: '16px', overflow: 'hidden' }}>
            {user ? (
              <div 
                className="settings-item" 
                onClick={async () => { await logout(); navigate('/login'); }} 
                style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px', cursor: 'pointer', color: '#ef4444' }}
              >
                <LogOut size={20} />
                <span style={{ fontSize: '16px', fontWeight: '500' }}>Sign Out ({user.email || 'Guest'})</span>
              </div>
            ) : (
              <div 
                className="settings-item" 
                onClick={() => navigate('/login')} 
                style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px', cursor: 'pointer', color: 'var(--accent-color)' }}
              >
                <LogIn size={20} />
                <span style={{ fontSize: '16px', fontWeight: '500' }}>Sign In</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

