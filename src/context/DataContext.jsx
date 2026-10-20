import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Shield, AlertTriangle } from 'lucide-react';
import * as db from '../store/db';
import { pb, syncAll, syncSettings, setupRealtimeSync, connectPocketBase } from '../store/sync';
import { isUnlocked, tryRestoreSession, deriveKey, verifyPinWithData, hasCachedPin } from '../utils/crypto';
import PinPad from '../components/PinPad';
import { useSecuritySettings } from './SettingsContext';
import { fetchExchangeRates, fetchBatchPrices, checkBackendHealth, fetchHistoricalFxRate, fetchHistoricalPricesBatch, fetchFxSeries } from '../utils/api';

const DataContext = createContext(null);

const HISTORY_CACHE_KEY = 'stock_tracker_price_history';
const FX_SERIES_CACHE_KEY = 'stock_tracker_fx_series';
const HISTORY_TTL = 6 * 60 * 60 * 1000; // 6 hours - daily closes only move once a day

export function DataProvider({ children }) {
  const [transactions, setTransactions] = useState([]);
  const [portfolios, setPortfolios] = useState([]);
  const [insights, setInsights] = useState([]);
  const [research, setResearch] = useState([]);
  const [exchangeRates, setExchangeRates] = useState({});
  const [livePrices, setLivePrices] = useState({});
  const [historicalPrices, setHistoricalPrices] = useState({});
  const [fxSeries, setFxSeries] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [backendStatus, setBackendStatus] = useState({ connected: false, activeUrl: null });
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const txs = await db.getTransactions();
      setTransactions(txs);
      
      let ports = await db.getItems(db.portfoliosStore);
      setPortfolios(ports);

      const ins = await db.getItems(db.insightsStore);
      setInsights(ins.sort((a, b) => String(b.meta?.savedAt || b.updatedAt || '').localeCompare(String(a.meta?.savedAt || a.updatedAt || ''))));
      setResearch(await db.getItems(db.researchStore));
    } catch (err) {
      console.error("Failed to load local database:", err);
    }
  }, []);

  const [unlocked, setUnlocked] = useState(false);
  const [needsPin, setNeedsPin] = useState(false);
  // True until init() has finished working out whether this account already
  // has encrypted data. Until then we cannot tell "no PIN set up yet" from
  // "PIN exists, we just have not read the settings yet".
  const [securityResolved, setSecurityResolved] = useState(false);

  // What the app is actually doing about syncing. The backend status dot
  // reports the *price* backend, which is a different service entirely - a
  // green dot there says nothing about whether transactions reach PocketBase.
  //   synced     - authenticated and pushing/pulling
  //   guest      - local-only session, sync deliberately off
  //   signed-out - no PocketBase session (a PWA can have its own storage,
  //                so a browser login does not always carry over)
  //   offline    - no PocketBase server reachable
  //   locked     - encrypted account waiting on its PIN
  const [syncStatus, setSyncStatus] = useState({ mode: 'pending', lastSyncAt: null, error: null });
  const [pinInput, setPinInput] = useState('');

  const { isE2eeEnabled, hasPromptedE2ee, setE2EE, dismissE2EEPrompt, reloadSettings } = useSecuritySettings();
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [onboardingPin, setOnboardingPin] = useState('');
  const [onboardingConfirmPin, setOnboardingConfirmPin] = useState('');
  const [isProcessingOnboarding, setIsProcessingOnboarding] = useState(false);

  // Offering "set up a PIN" before init() has resolved is what produced the
  // new-device double prompt: local settings still held defaults, so this fired
  // immediately, and moments later init() found remote encrypted data and
  // raised the unlock prompt on top of it.
  useEffect(() => {
    if (!securityResolved) return;
    if (pb.authStore.isValid && !isE2eeEnabled && !hasPromptedE2ee && !needsPin && !unlocked && onboardingStep === 0) {
      setOnboardingStep(1);
    }
  }, [securityResolved, pb.authStore.isValid, isE2eeEnabled, hasPromptedE2ee, needsPin, unlocked, onboardingStep]);

  // If an unlock prompt appears, any setup flow already on screen is wrong.
  useEffect(() => {
    if (needsPin && onboardingStep > 0) setOnboardingStep(0);
  }, [needsPin, onboardingStep]);

  const handleSkipOnboarding = async () => {
    await dismissE2EEPrompt();
    setOnboardingStep(0);
  };

  const handleOnboardingPinComplete = async (enteredPin) => {
    if (onboardingStep === 2) {
      setOnboardingPin(enteredPin);
      setOnboardingStep(3);
    } else if (onboardingStep === 3) {
      if (enteredPin !== onboardingPin) {
        alert("PINs do not match. Please try again.");
        setOnboardingPin('');
        setOnboardingConfirmPin('');
        setOnboardingStep(2);
        return;
      }

      setIsProcessingOnboarding(true);
      try {
        await deriveKey(enteredPin);
        await setE2EE(true);
        setUnlocked(true);

        const stores = [db.transactionsStore, db.portfoliosStore, db.settingsStore, db.insightsStore, db.researchStore];
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

        await syncAll();
        await loadData();
        setOnboardingStep(0);
      } catch (err) {
        console.error(err);
        alert("Failed to setup encryption.");
      } finally {
        setIsProcessingOnboarding(false);
      }
    }
  };

  useEffect(() => {
    let unsub = null;
    let isMounted = true;

    // Wrapper so every exit path - including the early return when there is no
    // server or no session - marks the security state as resolved exactly once.
    async function init() {
      try {
        await initInner();
      } finally {
        if (isMounted) setSecurityResolved(true);
      }
    }

    async function initInner() {
      await loadData();
      setIsLoading(false);

      const activeUrl = await connectPocketBase();
      if (!activeUrl) {
        if (isMounted) setSyncStatus({ mode: 'offline', lastSyncAt: null, error: 'No PocketBase server reachable' });
        return;
      }
      if (!pb.authStore.isValid) {
        // Guest sessions are local by design; anything else means the session
        // did not carry into this context and data will not leave the device.
        if (isMounted) {
          const guest = localStorage.getItem('STOCK_GUEST_SESSION') === '1';
          setSyncStatus({ mode: guest ? 'guest' : 'signed-out', lastSyncAt: null, error: null });
        }
        return;
      }

      await syncSettings();

      if (reloadSettings) {
        await reloadSettings();
      }

      const settingsRecord = await db.settingsStore.getItem('stocksettings123');
      const e2eeEnabled = settingsRecord?.config?.security?.e2eeEnabled || false;

      let remoteHasEncrypted = false;
      if (!e2eeEnabled) {
        try {
          const usersId = pb.authStore.model?.id;
          const collections = ['stock_transactions', 'stock_portfolios'];
          for (const coll of collections) {
            const items = await pb.collection(coll).getList(1, 1, {
              filter: usersId ? `users = "${usersId}" && encrypted_payload != ""` : `encrypted_payload != ""`
            });
            if (items.totalItems > 0) {
              remoteHasEncrypted = true;
              break;
            }
          }
        } catch (e) {
          // ignore
        }

        if (remoteHasEncrypted) {
          const updatedRecord = {
            ...(settingsRecord || { id: 'stocksettings123' }),
            config: {
              ...(settingsRecord?.config || {}),
              security: { ...(settingsRecord?.config?.security || {}), e2eeEnabled: true, hasPromptedE2ee: true }
            },
            pendingSync: true
          };
          await db.settingsStore.setItem('stocksettings123', updatedRecord);
          if (reloadSettings) await reloadSettings();
        }
      }

      const finalE2ee = e2eeEnabled || remoteHasEncrypted;

      if (finalE2ee) {
        const restored = await tryRestoreSession();
        if (restored && isMounted) {
          setUnlocked(true);
          await syncAll();
          await loadData();
          if (isMounted) setSyncStatus({ mode: 'synced', lastSyncAt: Date.now(), error: null });
          unsub = setupRealtimeSync((collection) => {
            loadData();
            if (collection === 'stock_settings' && reloadSettings) reloadSettings();
          });
        } else if (isMounted) {
          setNeedsPin(true);
          setSyncStatus({ mode: 'locked', lastSyncAt: null, error: null });
        }
      } else {
        await syncAll();
        await loadData();
        if (isMounted) setSyncStatus({ mode: 'synced', lastSyncAt: Date.now(), error: null });
        unsub = setupRealtimeSync((collection) => {
          loadData();
          if (collection === 'stock_settings' && reloadSettings) reloadSettings();
        });
      }
    }

    init();

    return () => {
      isMounted = false;
      if (unsub) unsub();
    };
  }, [loadData, reloadSettings]);


  // Local writes are already reflected in state optimistically, so a mutation
  // should not block the caller on a network round trip. Sync runs in the
  // background and reloads from the local store when it settles; realtime
  // updates from other devices arrive through setupRealtimeSync regardless.
  const syncInBackground = useCallback(() => {
    if (!pb.authStore.isValid) return; // guest / signed out: nothing to push
    syncAll()
      .then(() => loadData())
      .then(() => setSyncStatus((s) => ({ ...s, mode: 'synced', lastSyncAt: Date.now(), error: null })))
      .catch((err) => {
        console.warn('Background sync failed:', err);
        setSyncStatus((s) => ({ ...s, error: err.message }));
      });
  }, [loadData]);

  const addTransaction = async (tx) => {
    if (Array.isArray(tx)) {
      const savedTxs = await Promise.all(tx.map(t => db.saveTransaction(t)));
      setTransactions(prev => {
        const copy = [...prev];
        savedTxs.forEach(st => {
          const idx = copy.findIndex(p => p.id === st.id);
          if (idx !== -1) copy[idx] = st;
          else copy.push(st);
        });
        return copy.sort((a, b) => new Date(b.date) - new Date(a.date));
      });
    } else {
      const savedTx = await db.saveTransaction(tx);
      setTransactions(prev => {
        const copy = [...prev];
        const idx = copy.findIndex(p => p.id === savedTx.id);
        if (idx !== -1) copy[idx] = savedTx;
        else copy.push(savedTx);
        return copy.sort((a, b) => new Date(b.date) - new Date(a.date));
      });
    }
    syncInBackground();
  };

  const updateTransaction = async (tx) => {
    const savedTx = await db.saveTransaction(tx);
    setTransactions(prev => {
      let copy = [...prev];
      const idx = copy.findIndex(p => p.id === savedTx.id);
      if (idx !== -1) {
        copy[idx] = savedTx;
      } else {
        copy.push(savedTx);
      }
      return copy.sort((a, b) => new Date(b.date) - new Date(a.date));
    });
    syncInBackground();
  };

  const deleteTransaction = async (id) => {
    await db.deleteTransaction(id);
    setTransactions(prev => {
      let updated = prev.filter(t => t.id !== id);
      return updated.sort((a, b) => new Date(b.date) - new Date(a.date));
    });
    syncInBackground();
  };

  const updateDataItem = async (store, item, setType) => {
    const saved = await db.saveItem(store, item);
    setType(prev => {
      const idx = prev.findIndex(p => p.id === saved.id);
      if (idx !== -1) {
        const copy = [...prev];
        copy[idx] = saved;
        return copy;
      }
      return [...prev, saved];
    });
    syncInBackground();
  };

  const deleteDataItem = async (store, id, setType) => {
    await db.deleteItem(store, id);
    setType(prev => prev.filter(p => p.id !== id));
    syncInBackground();
  };

  // Research records are { kind, symbol, data } - the shape the MCP server
  // writes - so either side can edit the other's entries.
  const saveResearch = useCallback(async (kind, symbol, dataPatch, { replace = false } = {}) => {
    const key = String(symbol || '*').toUpperCase();
    const existing = research.find((r) => r.kind === kind && String(r.symbol || '').toUpperCase() === key);
    const item = {
      ...(existing || {}),
      kind,
      symbol: key,
      data: { ...(replace ? {} : existing?.data || {}), ...dataPatch, updatedAt: new Date().toISOString() }
    };
    await updateDataItem(db.researchStore, item, setResearch);
  }, [research]);

  const handlePinSubmit = async (enteredPin) => {
    if (enteredPin.length === 4) {
      const isValid = await verifyPinWithData(enteredPin);
      if (!isValid) {
        alert("Incorrect PIN. Access Denied.");
        setPinInput('');
        return;
      }

      setUnlocked(true);
      setNeedsPin(false);
      
      await syncAll();
      if (reloadSettings) await reloadSettings();
      await loadData();
      setupRealtimeSync((collection) => {
        loadData();
        if (collection === 'stock_settings' && reloadSettings) reloadSettings();
      });
    }
  };

  const saveTransactionsBatch = async (txsToSave = [], idsToDelete = []) => {
    if (idsToDelete.length > 0) {
      await Promise.all(idsToDelete.map(id => db.deleteTransaction(id)));
    }
    let savedList = [];
    if (txsToSave.length > 0) {
      savedList = await Promise.all(txsToSave.map(t => db.saveTransaction(t)));
    }
    setTransactions(prev => {
      let copy = prev.filter(t => !idsToDelete.includes(t.id));
      savedList.forEach(st => {
        const idx = copy.findIndex(p => p.id === st.id);
        if (idx !== -1) copy[idx] = st;
        else copy.push(st);
      });
      return copy.sort((a, b) => new Date(b.date) - new Date(a.date));
    });
    syncInBackground();
  };

  // Backend Health Check Loop
  useEffect(() => {
    let mounted = true;
    const verify = async () => {
      const status = await checkBackendHealth();
      if (mounted) setBackendStatus(status);
    };

    verify();
    const interval = setInterval(verify, 12000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Fetch Exchange Rates & Live Prices
  useEffect(() => {
    fetchExchangeRates().then(rates => {
      if (rates) setExchangeRates(rates);
    });
  }, []);

  // The set of tickers we need market data for. Derived as a stable string so
  // that unrelated edits to a transaction don't re-trigger network fetches.
  const tickerKey = useMemo(() => {
    if (!transactions || transactions.length === 0) return '';
    return [...new Set(
      transactions
        .map(t => String(t.ticker || t.asset || '').trim().toUpperCase())
        .filter(t => t && t !== 'CASH')
    )].sort().join(',');
  }, [transactions]);

  useEffect(() => {
    if (!tickerKey) return;
    fetchBatchPrices(tickerKey.split(',')).then(prices => {
      if (prices && Object.keys(prices).length > 0) {
        setLivePrices(prev => ({ ...prev, ...prices }));
      }
    });
  }, [tickerKey]);

  // Historical daily closes for every held ticker. Without these the graph has
  // no real price history to value past holdings against.
  useEffect(() => {
    if (!tickerKey) return;
    let mounted = true;

    // Serve the cached copy immediately so the chart renders on load, then
    // refresh in the background.
    try {
      const cached = localStorage.getItem(HISTORY_CACHE_KEY);
      if (cached) {
        const { key, data, timestamp } = JSON.parse(cached);
        if (key === tickerKey && Date.now() - timestamp < HISTORY_TTL && data) {
          setHistoricalPrices(data);
        }
      }
    } catch (e) {
      // Corrupt cache entry - ignore and refetch.
    }

    setHistoryLoading(true);
    fetchHistoricalPricesBatch(tickerKey.split(','), '5y')
      .then(data => {
        if (!mounted || !data || Object.keys(data).length === 0) return;
        setHistoricalPrices(data);
        try {
          localStorage.setItem(
            HISTORY_CACHE_KEY,
            JSON.stringify({ key: tickerKey, data, timestamp: Date.now() })
          );
        } catch (e) {
          // Over quota - the in-memory copy still works for this session.
        }
      })
      .finally(() => {
        if (mounted) setHistoryLoading(false);
      });

    return () => { mounted = false; };
  }, [tickerKey]);

  // Historical USD->PKR series, so past values convert at the rate that was
  // actually in effect rather than today's rate.
  useEffect(() => {
    let mounted = true;
    try {
      const cached = localStorage.getItem(FX_SERIES_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < HISTORY_TTL && data) setFxSeries(data);
      }
    } catch (e) {
      // ignore
    }

    fetchFxSeries().then(series => {
      if (!mounted || !series) return;
      setFxSeries(series);
      try {
        localStorage.setItem(FX_SERIES_CACHE_KEY, JSON.stringify({ data: series, timestamp: Date.now() }));
      } catch (e) {
        // ignore
      }
    });

    return () => { mounted = false; };
  }, []);

  // Backfill missing historical FX rates for transactions
  useEffect(() => {
    if (!transactions || transactions.length === 0) return;
    const missingTx = transactions.filter(t => t.date && !t.fxRateOnDate);
    if (missingTx.length === 0) return;

    let mounted = true;
    (async () => {
      let updated = false;
      const updatedList = await Promise.all(transactions.map(async (t) => {
        if (t.date && !t.fxRateOnDate) {
          const rate = await fetchHistoricalFxRate(t.date);
          updated = true;
          return { ...t, fxRateOnDate: rate };
        }
        return t;
      }));

      if (mounted && updated) {
        setTransactions(updatedList);
      }
    })();

    return () => { mounted = false; };
  }, [transactions]);

  return (
    <DataContext.Provider value={{ 
      transactions, portfolios, exchangeRates, setExchangeRates, livePrices, historicalPrices, fxSeries, historyLoading, backendStatus, syncStatus, isLoading, loadData,
      addTransaction, updateTransaction, deleteTransaction, saveTransactionsBatch,
      insights, research, saveResearch,
      removeResearch: (id) => deleteDataItem(db.researchStore, id, setResearch),
      deleteInsight: (id) => deleteDataItem(db.insightsStore, id, setInsights),
      savePortfolio: (item) => updateDataItem(db.portfoliosStore, item, setPortfolios),
      deletePortfolio: (id) => deleteDataItem(db.portfoliosStore, id, setPortfolios),
    }}>
      {children}
      {/* First Time Onboarding Modal */}
      {onboardingStep > 0 && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(20,20,25,0.95)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ padding: '32px', borderRadius: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: '340px', width: '90%', textAlign: 'center', gap: '16px', position: 'relative' }}>
            {onboardingStep === 1 ? (
              <>
                <div style={{ padding: '16px', background: 'rgba(16,185,129,0.15)', borderRadius: '50%', color: 'var(--accent-color)' }}>
                  <Shield size={36} />
                </div>
                <h2 style={{ margin: 0, fontSize: '20px' }}>Protect Your Privacy</h2>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                  End-to-End Encryption protects your financial data with a 4-digit PIN.
                </p>

                <div style={{ padding: '12px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start', textAlign: 'left' }}>
                  <AlertTriangle size={20} style={{ color: '#ef4444', flexShrink: 0, marginTop: '2px' }} />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                    <strong>Warning:</strong> Skipping encryption stores your data in plain text, allowing the server owner to view your records.
                  </span>
                </div>

                <button 
                  onClick={() => setOnboardingStep(2)} 
                  className="submit-btn bg-primary" 
                  style={{ width: '100%', marginTop: '8px' }}
                >
                  Set Up 4-Digit PIN
                </button>

                <button 
                  onClick={handleSkipOnboarding} 
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Skip for Now
                </button>
              </>
            ) : (
              <>
                <PinPad 
                  value={onboardingStep === 2 ? onboardingPin : onboardingConfirmPin}
                  onChange={onboardingStep === 2 ? setOnboardingPin : setOnboardingConfirmPin}
                  onSubmit={handleOnboardingPinComplete}
                  title={onboardingStep === 2 ? 'Set Encryption PIN' : 'Confirm PIN'}
                  subtitle={onboardingStep === 2 ? 'Enter a 4-digit PIN to encrypt your data.' : 'Re-enter your 4-digit PIN to confirm.'}
                />
                {isProcessingOnboarding && (
                  <p style={{ marginTop: '12px', color: 'var(--accent-color)', fontSize: '14px' }}>
                    Encrypting & Syncing...
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {needsPin && !unlocked && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(20,20,25,0.95)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ padding: '32px', borderRadius: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <PinPad 
              value={pinInput}
              onChange={setPinInput}
              onSubmit={handlePinSubmit}
              title="Enter E2EE PIN"
              subtitle="Your data is encrypted. Enter your 4-digit PIN to sync and unlock."
            />
          </div>
        </div>
      )}
    </DataContext.Provider>
  );
}

export function useData() {
  return useContext(DataContext);
}
