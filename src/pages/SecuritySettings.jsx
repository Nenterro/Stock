import React, { useState } from 'react';
import { ArrowLeft, Lock, Unlock, Key, AlertTriangle, Edit2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSecuritySettings } from '../context/SettingsContext';
import { useData } from '../context/DataContext';
import { deriveKey, lockSession, isUnlocked, verifyPinWithData } from '../utils/crypto';
import * as db from '../store/db';
import { syncAll, pb } from '../store/sync';
import PinPad from '../components/PinPad';
import './ManageData.css';

export default function SecuritySettings() {
  const navigate = useNavigate();
  const { isE2eeEnabled, setE2EE } = useSecuritySettings();
  const { loadData } = useData();
  
  const [modalMode, setModalMode] = useState(null); // 'enable', 'disable', 'change_pin'
  const [pinStep, setPinStep] = useState(1);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const markAllPending = async () => {
    const stores = [db.transactionsStore, db.portfoliosStore, db.settingsStore];
    for (const store of stores) {
      const keys = await store.keys();
      for (const key of keys) {
        const item = await store.getItem(key);
        if (item) {
          item.pendingSync = true;
          await store.setItem(key, item);
        }
      }
    }
  };

  const openModal = (mode) => {
    setModalMode(mode);
    setPinStep(1);
    setCurrentPin('');
    setNewPin('');
    setConfirmPin('');
  };

  const verifyCurrentPin = async (inputPin) => {
    return await verifyPinWithData(inputPin);
  };

  const handlePinComplete = async (enteredPin) => {
    if (modalMode === 'disable') {
      const isValid = await verifyCurrentPin(enteredPin);
      if (!isValid) {
        alert("Incorrect current PIN. Access denied.");
        setCurrentPin('');
        return;
      }

      setIsProcessing(true);
      try {
        await setE2EE(false);
        lockSession();
        await markAllPending();
        await syncAll();
        await loadData();
        setModalMode(null);
        alert("End-to-End Encryption Disabled!");
      } catch (err) {
        console.error(err);
        alert("Failed to disable E2EE.");
      } finally {
        setIsProcessing(false);
      }
    } else if (modalMode === 'change_pin') {
      if (pinStep === 1) {
        const isValid = await verifyCurrentPin(enteredPin);
        if (!isValid) {
          alert("Incorrect current PIN. Access denied.");
          setCurrentPin('');
          return;
        }
        setCurrentPin(enteredPin);
        setPinStep(2);
      } else if (pinStep === 2) {
        setNewPin(enteredPin);
        setPinStep(3);
      } else if (pinStep === 3) {
        if (enteredPin !== newPin) {
          alert("New PINs do not match. Please try again.");
          setNewPin('');
          setConfirmPin('');
          setPinStep(2);
          return;
        }

        setIsProcessing(true);
        try {
          await deriveKey(enteredPin);
          await markAllPending();
          await syncAll();
          await loadData();
          setModalMode(null);
          alert("PIN Changed Successfully!");
        } catch (err) {
          console.error(err);
          alert("Failed to change PIN.");
        } finally {
          setIsProcessing(false);
        }
      }
    } else if (modalMode === 'enable') {
      if (pinStep === 1) {
        setNewPin(enteredPin);
        setPinStep(2);
      } else if (pinStep === 2) {
        if (enteredPin !== newPin) {
          alert("PINs do not match. Please try again.");
          setNewPin('');
          setConfirmPin('');
          setPinStep(1);
          return;
        }

        setIsProcessing(true);
        try {
          await deriveKey(enteredPin);
          await setE2EE(true);
          await markAllPending();
          await syncAll();
          await loadData();
          setModalMode(null);
          alert("End-to-End Encryption Enabled!");
        } catch (err) {
          console.error(err);
          alert("Failed to enable E2EE.");
        } finally {
          setIsProcessing(false);
        }
      }
    }
  };

  const getPinPadProps = () => {
    if (modalMode === 'disable') {
      return {
        value: currentPin,
        onChange: setCurrentPin,
        title: 'Enter Current PIN',
        subtitle: 'Enter your current 4-digit PIN to disable encryption.'
      };
    }
    if (modalMode === 'change_pin') {
      if (pinStep === 1) {
        return {
          value: currentPin,
          onChange: setCurrentPin,
          title: 'Enter Current PIN',
          subtitle: 'Enter your current 4-digit PIN to authorize changing PIN.'
        };
      }
      if (pinStep === 2) {
        return {
          value: newPin,
          onChange: setNewPin,
          title: 'Enter New PIN',
          subtitle: 'Enter a new 4-digit PIN.'
        };
      }
      return {
        value: confirmPin,
        onChange: setConfirmPin,
        title: 'Confirm New PIN',
        subtitle: 'Re-enter your new 4-digit PIN to confirm.'
      };
    }
    if (modalMode === 'enable') {
      if (pinStep === 1) {
        return {
          value: newPin,
          onChange: setNewPin,
          title: 'Set Encryption PIN',
          subtitle: 'Enter a 4-digit PIN to encrypt your data.'
        };
      }
      return {
        value: confirmPin,
        onChange: setConfirmPin,
        title: 'Confirm PIN',
        subtitle: 'Re-enter your 4-digit PIN to confirm.'
      };
    }
    return {};
  };

  return (
    <div className="page-container manage-data-page">
      <div className="manage-header">
        <button className="back-btn" onClick={() => navigate('/settings')} aria-label="Go back">
          <ArrowLeft size={24} />
        </button>
        <h1>Security & Encryption</h1>
      </div>

      <div className="manage-content">
        {pb.authStore.isValid ? (
          <button className="add-item-btn" onClick={() => openModal(isE2eeEnabled ? 'disable' : 'enable')} style={{ color: isE2eeEnabled ? '#ef4444' : 'var(--accent-color)' }}>
            {isE2eeEnabled ? <Unlock size={20} /> : <Lock size={20} />} {isE2eeEnabled ? 'Disable Encryption' : 'Enable Encryption'}
          </button>
        ) : (
          <div className="empty-state" style={{ marginTop: '0', background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '16px' }}>
            Login Required to Toggle Encryption
          </div>
        )}

        <div className="data-item-list">
          <div className="data-item-card" style={{ cursor: 'default' }}>
            <div className="item-info">
              <div className="item-icon-wrap" style={{ backgroundColor: 'rgba(255,255,255,0.05)', color: isE2eeEnabled ? '#10b981' : 'var(--text-secondary)' }}>
                {isE2eeEnabled ? <Lock size={20} /> : <Unlock size={20} />}
              </div>
              <div className="item-details">
                <span className="item-name">End-to-End Encryption</span>
                <span className="item-currency">{isE2eeEnabled ? 'Your data is securely encrypted before leaving your device.' : 'Your data is currently synced to the server in plain text.'}</span>
              </div>
            </div>
          </div>

          {isE2eeEnabled && pb.authStore.isValid && (
            <div className="data-item-card" onClick={() => openModal('change_pin')} style={{ cursor: 'pointer' }}>
              <div className="item-info">
                <div className="item-icon-wrap" style={{ backgroundColor: 'rgba(255,255,255,0.05)', color: 'white' }}>
                  <Key size={20} />
                </div>
                <div className="item-details">
                  <span className="item-name">Change PIN</span>
                  <span className="item-currency">Update your encryption PIN.</span>
                </div>
              </div>
              <div className="item-actions">
                <button className="action-btn edit"><Edit2 size={18} /></button>
              </div>
            </div>
          )}
        </div>

        {!isE2eeEnabled && (
          <div style={{ marginTop: '16px', padding: '16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '16px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <AlertTriangle size={22} style={{ color: '#ef4444', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', color: '#ef4444', fontWeight: '600' }}>Privacy Warning</h4>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                With End-to-End Encryption disabled, your transactions and accounts are stored in plain text on the server. The server owner can view your financial data.
              </p>
            </div>
          </div>
        )}
      </div>

      {modalMode && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(20,20,25,0.95)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ padding: '32px', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '90%', maxWidth: '340px', borderRadius: '24px', position: 'relative' }}>
            <button 
              type="button" 
              onClick={() => setModalMode(null)} 
              disabled={isProcessing} 
              style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              <X size={20} />
            </button>
            
            <PinPad 
              {...getPinPadProps()}
              onSubmit={handlePinComplete}
            />

            {isProcessing && (
              <p style={{ marginTop: '16px', color: 'var(--accent-color)', fontSize: '14px' }}>
                Processing & Syncing...
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

