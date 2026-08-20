import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as db from '../store/db';
import { syncAll } from '../store/sync';

const SettingsContext = createContext(null);

const DEFAULT_FILTER_STATE = {
  excludedPortfolios: new Set(),
  excludedTickers: new Set(),
  excludedTypes: new Set(),
};

const DEFAULT_SETTINGS = {
  dashboard: { period: 'All Time', customRange: { start: null, end: null }, filters: { ...DEFAULT_FILTER_STATE } },
  transactions: { period: 'All Time', customRange: { start: null, end: null }, filters: { ...DEFAULT_FILTER_STATE } },
  graph: { period: 'All Time', customRange: { start: null, end: null }, filters: { ...DEFAULT_FILTER_STATE } },
  appearance: { theme: 'purple', customHex: '#10b981', baseCurrency: 'USD' },
  security: { e2eeEnabled: false, hasPromptedE2ee: false }
};

const serializeFilters = (filters) => ({
  ...filters,
  excludedPortfolios: Array.from(filters?.excludedPortfolios || []),
  excludedTickers: Array.from(filters?.excludedTickers || []),
  excludedTypes: Array.from(filters?.excludedTypes || [])
});

const deserializeFilters = (saved) => ({
  ...DEFAULT_FILTER_STATE,
  ...saved,
  excludedPortfolios: new Set(saved?.excludedPortfolios || []),
  excludedTickers: new Set(saved?.excludedTickers || []),
  excludedTypes: new Set(saved?.excludedTypes || [])
});

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  const reloadSettings = useCallback(async () => {
    try {
      const record = await db.settingsStore.getItem('stocksettings123');
      if (record && record.config) {
        const config = record.config;
        setSettings({
          dashboard: { ...DEFAULT_SETTINGS.dashboard, ...config.dashboard, filters: deserializeFilters(config.dashboard?.filters) },
          transactions: { ...DEFAULT_SETTINGS.transactions, ...config.transactions, filters: deserializeFilters(config.transactions?.filters) },
          graph: { ...DEFAULT_SETTINGS.graph, ...config.graph, filters: deserializeFilters(config.graph?.filters) },
          appearance: { ...DEFAULT_SETTINGS.appearance, ...config.appearance },
          security: { ...DEFAULT_SETTINGS.security, ...config.security }
        });
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  }, []);

  useEffect(() => {
    reloadSettings().then(() => setIsLoaded(true));
  }, [reloadSettings]);

  const updateSettings = useCallback(async (newSettings) => {
    setSettings(newSettings);
    try {
      const configToSave = {
        dashboard: { ...newSettings.dashboard, filters: serializeFilters(newSettings.dashboard?.filters) },
        transactions: { ...newSettings.transactions, filters: serializeFilters(newSettings.transactions?.filters) },
        graph: { ...newSettings.graph, filters: serializeFilters(newSettings.graph?.filters) },
        appearance: { ...newSettings.appearance },
        security: { ...newSettings.security }
      };

      const updatedRecord = {
        id: 'stocksettings123',
        config: configToSave,
        updated_at: new Date().toISOString()
      };
      
      await db.settingsStore.setItem('stocksettings123', updatedRecord);
      syncAll().catch(err => console.warn('Background sync failed after settings update:', err));
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }, []);

  const getPageSettings = useCallback((page) => {
    return settings[page] || DEFAULT_SETTINGS[page] || { period: 'All Time', customRange: { start: null, end: null }, filters: { ...DEFAULT_FILTER_STATE } };
  }, [settings]);

  const setPageSettings = useCallback((page, newPageSettings) => {
    return updateSettings({
      ...settings,
      [page]: newPageSettings
    });
  }, [settings, updateSettings]);

  if (!isLoaded) return null;

  return (
    <SettingsContext.Provider value={{
      getPageSettings,
      setPageSettings,
      settings,
      updateSettings,
      reloadSettings
    }}>
      {children}
    </SettingsContext.Provider>
  );
}

export const usePageSettings = (pageName) => {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("usePageSettings must be used within SettingsProvider");

  const { getPageSettings, setPageSettings } = context;
  const pageSettings = getPageSettings(pageName) || { period: 'All Time', customRange: { start: null, end: null }, filters: { ...DEFAULT_FILTER_STATE } };

  const setSelectedPeriod = (period) => setPageSettings(pageName, { ...pageSettings, period });
  const setCustomRange = (range) => setPageSettings(pageName, { ...pageSettings, customRange: range });
  const setFilterState = (filters) => setPageSettings(pageName, { ...pageSettings, filters });
  
  return {
    selectedPeriod: pageSettings?.period || 'All Time',
    setSelectedPeriod,
    customRange: pageSettings?.customRange || { start: null, end: null },
    setCustomRange,
    filterState: pageSettings?.filters || { ...DEFAULT_FILTER_STATE },
    setFilterState,
  };
};

export const useAppearanceSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useAppearanceSettings must be used within SettingsProvider");
  
  const { getPageSettings, setPageSettings } = context;
  const appearance = getPageSettings('appearance');
  
  const setTheme = (themeId, hex = appearance.customHex) => {
    setPageSettings('appearance', { ...appearance, theme: themeId, customHex: hex });
  };
  
  const setBaseCurrency = (code) => {
    setPageSettings('appearance', { ...appearance, baseCurrency: code });
  };
  
  return {
    activeTheme: appearance.theme,
    customHex: appearance.customHex,
    setTheme,
    baseCurrency: appearance.baseCurrency || 'USD',
    setBaseCurrency,
  };
};

export const useSecuritySettings = () => {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSecuritySettings must be used within SettingsProvider");
  
  const { getPageSettings, setPageSettings, reloadSettings } = context;
  const security = getPageSettings('security');
  
  const setE2EE = async (enabled) => {
    return await setPageSettings('security', { ...security, e2eeEnabled: enabled, hasPromptedE2ee: true });
  };

  const dismissE2EEPrompt = async () => {
    return await setPageSettings('security', { ...security, hasPromptedE2ee: true });
  };
  
  return {
    isE2eeEnabled: security.e2eeEnabled,
    hasPromptedE2ee: security.hasPromptedE2ee || false,
    setE2EE,
    dismissE2EEPrompt,
    reloadSettings
  };
};
