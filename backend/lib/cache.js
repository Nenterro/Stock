'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* best effort - an unwritable data dir degrades to memory-only caching */
  }
}
ensureDir();

/**
 * TTL cache with an LRU bound, optional disk persistence and
 * stale-while-revalidate semantics.
 *
 * The old backend kept unbounded Maps that vanished on container restart, so
 * every deploy cost a full cold rebuild of every price and history series.
 */
class Cache {
  constructor({ name, ttlMs, maxEntries = 5000, persist = false, staleMs = 0 }) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.staleMs = staleMs;
    this.maxEntries = maxEntries;
    this.persist = persist;
    this.map = new Map();
    this.inflight = new Map();
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.dirty = false;
    this.hits = 0;
    this.misses = 0;

    if (persist) {
      this._load();
      this._timer = setInterval(() => this._flush(), 30000);
      if (this._timer.unref) this._timer.unref();
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      const horizon = this.ttlMs + this.staleMs;
      for (const [key, entry] of Object.entries(parsed)) {
        // Drop anything already past even its stale window.
        if (entry && typeof entry.t === 'number' && now - entry.t < horizon) {
          this.map.set(key, entry);
        }
      }
      console.log(`[cache:${this.name}] restored ${this.map.size} entries from disk`);
    } catch (err) {
      console.warn(`[cache:${this.name}] load failed: ${err.message}`);
    }
  }

  _flush() {
    if (!this.persist || !this.dirty) return;
    try {
      const out = {};
      for (const [key, entry] of this.map) out[key] = entry;
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
      fs.renameSync(`${this.file}.tmp`, this.file);
      this.dirty = false;
    } catch (err) {
      console.warn(`[cache:${this.name}] flush failed: ${err.message}`);
    }
  }

  _evict() {
    while (this.map.size > this.maxEntries) {
      // Map preserves insertion order and `set` re-inserts on write, so the
      // first key is the least recently written.
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  /** Returns { value, fresh } or null when absent/expired beyond the stale window. */
  peek(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.t;
    if (age < this.ttlMs) return { value: entry.v, fresh: true };
    if (this.staleMs && age < this.ttlMs + this.staleMs) return { value: entry.v, fresh: false };
    this.map.delete(key);
    return null;
  }

  get(key) {
    const hit = this.peek(key);
    if (hit && hit.fresh) {
      this.hits += 1;
      return hit.value;
    }
    this.misses += 1;
    return undefined;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { v: value, t: Date.now() });
    this.dirty = true;
    this._evict();
    return value;
  }

  delete(key) {
    this.map.delete(key);
    this.dirty = true;
  }

  /**
   * Fetch-through with in-flight de-duplication.
   *
   * When `stale` data exists and the loader fails, the stale value is served
   * rather than an error - a slightly old price beats a blank cell in the UI.
   */
  async wrap(key, loader) {
    const cached = this.peek(key);
    if (cached && cached.fresh) {
      this.hits += 1;
      return cached.value;
    }
    this.misses += 1;

    if (this.inflight.has(key)) return this.inflight.get(key);

    const task = (async () => {
      try {
        const value = await loader();
        if (value !== null && value !== undefined) return this.set(key, value);
        return cached ? cached.value : null;
      } catch (err) {
        console.warn(`[cache:${this.name}] loader failed for ${key}: ${err.message}`);
        return cached ? cached.value : null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0
    };
  }
}

/** Read/write a plain JSON document in the data dir (used for the universe snapshot). */
const store = {
  read(name) {
    try {
      const file = path.join(DATA_DIR, `${name}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn(`[store] read ${name} failed: ${err.message}`);
      return null;
    }
  },
  write(name, value) {
    try {
      const file = path.join(DATA_DIR, `${name}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
      fs.renameSync(`${file}.tmp`, file);
      return true;
    } catch (err) {
      console.warn(`[store] write ${name} failed: ${err.message}`);
      return false;
    }
  }
};

module.exports = { Cache, store, DATA_DIR };
