// Dynamic Backend Server URLs with automatic local network & mobile host detection
export const getBackendUrls = () => {
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const candidateUrls = [
    'https://huz-stock.duckdns.org:8888',
    'http://192.168.18.49:3005',
    `http://${currentHost}:3005`,
    `http://${currentHost}:8888`,
    'http://localhost:3005'
  ];
  return [...new Set(candidateUrls.filter(Boolean))];
};

const FX_CACHE_KEY = 'stock_tracker_fx_rates';
const ONE_HOUR = 60 * 60 * 1000;

let lastSuccessfulBackend = null;

// Generic helper to fetch from Backend Home Server with automatic failover
export async function fetchFromBackend(path, options = {}) {
  const urls = getBackendUrls();
  
  // Try last successful backend URL first
  if (lastSuccessfulBackend && urls.includes(lastSuccessfulBackend)) {
    try {
      const url = `${lastSuccessfulBackend}${path.startsWith('/') ? '' : '/'}${path}`;
      const res = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(4000)
      });
      if (res.ok) return await res.json();
    } catch (e) {
      lastSuccessfulBackend = null;
    }
  }

  for (const baseUrl of urls) {
    try {
      const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
      const res = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(4000)
      });
      if (res.ok) {
        lastSuccessfulBackend = baseUrl;
        return await res.json();
      }
    } catch (err) {
      console.warn(`Backend request to ${baseUrl} failed:`, err.message);
    }
  }
  return null;
}

// Health Check to determine backend status & active server URL
export async function checkBackendHealth() {
  const urls = getBackendUrls();
  for (const baseUrl of urls) {
    try {
      const res = await fetch(`${baseUrl}/api/rates`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        lastSuccessfulBackend = baseUrl;
        return { connected: true, activeUrl: baseUrl };
      }
    } catch (e) {}
  }
  return { connected: false, activeUrl: null };
}

// Fetch Historical USD/PKR Exchange Rate for a specific date (YYYY-MM-DD)
export async function fetchHistoricalFxRate(dateStr) {
  if (!dateStr) return 278.0;
  const cleanDate = dateStr.split('T')[0];

  try {
    const data = await fetchFromBackend(`/api/historical-fx?date=${cleanDate}`);
    if (data && typeof data.rate === 'number' && data.rate > 0) {
      return data.rate;
    }
  } catch (err) {
    console.warn(`Historical FX fetch failed for ${cleanDate}:`, err.message);
  }

  return 278.0;
}

// Search Assets & Tickers via Home Server Backend
export async function searchAssetsBackend(query) {
  if (!query || !query.trim()) return [];
  const data = await fetchFromBackend(`/api/search?q=${encodeURIComponent(query)}`);
  return data || [];
}

// Fetch Live Exchange Rates via Home Server Backend
export async function fetchExchangeRates() {
  try {
    const cached = localStorage.getItem(FX_CACHE_KEY);
    if (cached) {
      const { rates, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < ONE_HOUR) {
        return rates;
      }
    }

    // Try backend rates endpoint
    const backendData = await fetchFromBackend('/api/rates');
    if (backendData && backendData.rates) {
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ rates: backendData.rates, timestamp: Date.now() }));
      return backendData.rates;
    }
  } catch (err) {
    console.warn('Backend FX fetch failed:', err);
  }

  // Default fallback rates
  return { USD: 1, PKR: 278.0, EUR: 0.92, GBP: 0.78, CAD: 1.36 };
}

// Fetch Live Market Price for a Single Symbol via Home Server Backend
export async function fetchLivePrice(symbol) {
  if (!symbol || symbol === 'CASH') return null;
  const cleanSymbol = symbol.trim().toUpperCase();

  try {
    // Primary: Backend quote endpoint
    const quoteData = await fetchFromBackend(`/api/quote?symbol=${encodeURIComponent(cleanSymbol)}`);
    if (quoteData && typeof quoteData.price === 'number') {
      const prevClose = quoteData.previousClose || quoteData.price;
      const change = typeof quoteData.change === 'number' ? quoteData.change : (quoteData.price - prevClose);
      const changePercent = typeof quoteData.changePercent === 'number' ? quoteData.changePercent : (prevClose > 0 ? (change / prevClose) * 100 : 0);

      return {
        price: quoteData.price,
        previousClose: prevClose,
        change,
        changePercent,
        currency: quoteData.currency || 'USD',
        symbol: cleanSymbol
      };
    }
  } catch (err) {
    console.warn(`Backend price fetch failed for ${cleanSymbol}:`, err);
  }

  return null;
}

// Fetch Live Prices in Batch for Multiple Symbols via Home Server Backend
export async function fetchBatchPrices(symbols = []) {
  const uniqueSymbols = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (uniqueSymbols.length === 0) return {};

  const results = {};
  await Promise.all(
    uniqueSymbols.map(async (sym) => {
      const data = await fetchLivePrice(sym);
      if (data) {
        results[sym] = data;
      }
    })
  );

  return results;
}

// Search ticker symbols across market via Home Server Backend
export async function searchSymbols(query) {
  if (!query || !query.trim()) return [];
  try {
    const data = await fetchFromBackend(`/api/search?q=${encodeURIComponent(query.trim())}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`Search failed for ${query}:`, err);
    return [];
  }
}
