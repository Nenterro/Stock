import localforage from 'localforage';

// Configure stores
export const transactionsStore = localforage.createInstance({
  name: 'StockTracker',
  storeName: 'stock_transactions'
});

export const portfoliosStore = localforage.createInstance({
  name: 'StockTracker',
  storeName: 'stock_portfolios'
});

export const settingsStore = localforage.createInstance({
  name: 'StockTracker',
  storeName: 'stock_settings'
});

// Analyses written by Claude through the MCP server (mcp/), read-mostly here.
export const insightsStore = localforage.createInstance({
  name: 'StockTracker',
  storeName: 'stock_insights'
});

// Watchlist entries, target allocation, per-symbol notes and analysis
// settings - one record each, shared with the MCP server.
export const researchStore = localforage.createInstance({
  name: 'StockTracker',
  storeName: 'stock_research'
});

// --- Transactions API ---

export async function getTransactions() {
  const transactions = [];
  await transactionsStore.iterate((value) => {
    if (!value.deleted) {
      transactions.push(value);
    }
  });
  // Sort by date descending
  return transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function saveTransaction(tx) {
  if (!tx.id) tx.id = generateId();
  tx.pendingSync = true;
  tx.updatedAt = new Date().toISOString();
  await transactionsStore.setItem(tx.id, tx);
  return tx;
}

export async function deleteTransaction(id) {
  const tx = await transactionsStore.getItem(id);
  if (tx) {
    tx.deleted = true;
    tx.pendingSync = true;
    tx.updatedAt = new Date().toISOString();
    await transactionsStore.setItem(id, tx);
  }
}

export function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 15; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// --- Generic Data Items API (For Portfolios, Settings) ---
export async function getItems(store) {
  const items = [];
  await store.iterate((value) => {
    if (!value.deleted) items.push(value);
  });
  return items;
}

export async function saveItem(store, item) {
  if (!item.id) item.id = generateId();
  item.pendingSync = true;
  item.updatedAt = new Date().toISOString();
  await store.setItem(item.id, item);
  return item;
}

export async function deleteItem(store, id) {
  const item = await store.getItem(id);
  if (item) {
    item.deleted = true;
    item.pendingSync = true;
    item.updatedAt = new Date().toISOString();
    await store.setItem(id, item);
  }
}
