'use strict';

const fs = require('fs');
const path = require('path');
const psx = require('./providers/psx');
const sarmaaya = require('./providers/sarmaaya');
const { store } = require('./cache');
const { validateSymbols } = require('./validate');

const REFRESH_MS = 12 * 3600 * 1000;

// Bump whenever asset identity changes shape (how a symbol is built, which
// sources are merged). A snapshot written under a different scheme is
// discarded rather than restored, so a deploy can never resurrect symbols
// that no longer mean what they used to.
// 3: seed rows carry `yahooSymbol` so LSE listings resolve as e.g. ISDU.L.
// 4: seed rows are validated against Yahoo and carry an `unpriceable` flag.
const SCHEMA_VERSION = 4;

/**
 * The searchable asset universe, merged from every source we can enumerate:
 *
 *   - PSX official listing        ~1000 Pakistani equities, ETFs and bonds
 *   - Sarmaaya fund mapping        ~480 Pakistani mutual funds
 *   - Curated international seed   ~270 global stocks, ETFs, crypto, FX, indices
 *
 * Anything outside this set is still reachable: search falls through to Yahoo,
 * which covers effectively every listed instrument worldwide.
 */
class Universe {
  constructor() {
    this.assets = [];
    this.bySymbol = new Map();
    this.byTag = new Map();
    this.loadedAt = 0;
    this.sources = {};
    this.refreshing = null;
  }

  get size() {
    return this.assets.length;
  }

  get(symbol) {
    if (!symbol) return null;
    const key = String(symbol).trim().toUpperCase();
    const direct = this.bySymbol.get(key);
    if (direct) return direct;

    // A fund symbol is "<ACRONYM>.<UUID-TAG>". The tag is the durable half, so
    // a fund stays resolvable under its stored symbol even after a rename
    // changes the acronym.
    const tag = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : null;
    if (tag) return this.byTag.get(tag) || null;

    return null;
  }

  _index(assets) {
    const bySymbol = new Map();
    // Later sources must not clobber earlier, higher-trust ones.
    for (const asset of assets) {
      const key = asset.symbol.toUpperCase();
      if (!bySymbol.has(key)) bySymbol.set(key, asset);
    }
    this.assets = [...bySymbol.values()];
    this.bySymbol = bySymbol;

    this.byTag = new Map();
    for (const asset of this.assets) {
      if (asset.tag && !this.byTag.has(asset.tag)) this.byTag.set(asset.tag, asset);
    }
  }

  loadSeedOnly() {
    const assets = [...this._internationalSeed(), ...this._funds()];
    this._index(assets);
    this.sources = { international: this._internationalSeed().length, funds: this._funds().length, psx: 0 };
    // Deliberately left at 0: the seed carries no PSX listings, so the next
    // refresh() must actually run rather than treat this as freshly loaded.
    this.loadedAt = 0;
  }

  _internationalSeed() {
    if (this._intlCache) return this._intlCache;
    try {
      const file = path.join(__dirname, '..', 'seed', 'international.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this._intlCache = raw.map((a) => ({ ...a, source: 'seed', priority: 1 }));
    } catch (err) {
      console.warn(`[universe] international seed load failed: ${err.message}`);
      this._intlCache = [];
    }
    return this._intlCache;
  }

  _funds() {
    if (this._fundCache) return this._fundCache;
    this._fundCache = sarmaaya.listFunds().map((f) => ({ ...f, priority: 2 }));
    return this._fundCache;
  }

  /** Restore the last good snapshot so a cold start is never empty. */
  bootstrap() {
    const snapshot = store.read('universe');
    if (snapshot && snapshot.schema !== SCHEMA_VERSION) {
      console.log(
        `[universe] discarding snapshot from schema ${snapshot.schema ?? 'unversioned'} ` +
          `(current ${SCHEMA_VERSION})`
      );
    } else if (snapshot && Array.isArray(snapshot.assets) && snapshot.assets.length > 0) {
      this._index(snapshot.assets);
      this.loadedAt = snapshot.loadedAt || 0;
      this.sources = snapshot.sources || {};
      console.log(`[universe] bootstrapped ${this.size} assets from snapshot`);
      return;
    }

    this.loadSeedOnly();
    console.log(`[universe] bootstrapped ${this.size} assets from seed`);
  }

  async refresh({ force = false } = {}) {
    if (!force && Date.now() - this.loadedAt < REFRESH_MS && this.size > 0) return this.size;
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const started = Date.now();
      const international = this._internationalSeed();
      const funds = this._funds();

      let psxAssets = [];
      try {
        const listed = await psx.listSymbols();
        if (listed && listed.length > 0) {
          psxAssets = listed.map((a) => ({ ...a, priority: a.isDebt ? 4 : 0 }));
        }
      } catch (err) {
        console.warn(`[universe] PSX listing refresh failed: ${err.message}`);
      }

      if (psxAssets.length === 0) {
        // Keep whatever PSX rows the previous snapshot had rather than losing them.
        psxAssets = this.assets.filter((a) => a.source === 'psx');
        if (psxAssets.length > 0) {
          console.warn(`[universe] reusing ${psxAssets.length} cached PSX rows`);
        }
      }

      // Hold the search engine to its promise: anything it offers must be
      // priceable. PSX and funds have their own providers; the hand-written
      // international seed is the part that can drift, so it is checked
      // against Yahoo and either repaired or flagged.
      let checkedInternational = international;
      try {
        const resolution = await validateSymbols(international);
        checkedInternational = international.map((a) => {
          const resolved = resolution[a.symbol];
          if (resolved === undefined) return a;
          return resolved
            ? { ...a, yahooSymbol: resolved, unpriceable: false }
            : { ...a, unpriceable: true };
        });
      } catch (err) {
        console.warn(`[universe] seed validation skipped: ${err.message}`);
      }

      // Order matters: PSX equities outrank the seed for symbol collisions
      // (e.g. PSX "POWER" vs a US ticker), funds last.
      this._index([...psxAssets, ...checkedInternational, ...funds]);
      this.loadedAt = Date.now();
      this.sources = {
        psx: psxAssets.length,
        international: international.length,
        funds: funds.length
      };

      store.write('universe', {
        schema: SCHEMA_VERSION,
        assets: this.assets,
        loadedAt: this.loadedAt,
        sources: this.sources
      });

      console.log(
        `[universe] refreshed ${this.size} assets in ${Date.now() - started}ms ` +
          `(psx=${this.sources.psx} intl=${this.sources.international} funds=${this.sources.funds})`
      );
      this.refreshing = null;
      return this.size;
    })();

    return this.refreshing;
  }

  startAutoRefresh() {
    const timer = setInterval(() => {
      this.refresh({ force: true }).catch(() => {});
    }, REFRESH_MS);
    if (timer.unref) timer.unref();
  }

  stats() {
    const byType = {};
    for (const a of this.assets) byType[a.type] = (byType[a.type] || 0) + 1;
    const unpriceable = this.assets.filter((a) => a.unpriceable).map((a) => a.symbol);
    return {
      total: this.size,
      unpriceable,
      loadedAt: new Date(this.loadedAt).toISOString(),
      sources: this.sources,
      byType
    };
  }
}

module.exports = new Universe();
