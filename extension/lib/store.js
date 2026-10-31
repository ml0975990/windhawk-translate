'use strict';

// Persistent store for the translation dictionary and user settings.
// Everything is written atomically (write temp file + rename) so a crash or a
// concurrent read never sees a half-written JSON document.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES_PER_LANG = 40000;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* already exists or racing with another creator */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can refuse the rename while the target is briefly open; retry
    // once after removing the destination.
    try {
      fs.unlinkSync(file);
    } catch (_) {}
    fs.renameSync(tmp, file);
  }
}

function mergeSettings(base, patch) {
  const out = Object.assign({}, base);
  const source = patch && typeof patch === 'object' ? patch : {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeSettings(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

class Store {
  constructor(dataDir, log) {
    this.dataDir = dataDir;
    this.log = log || (() => {});
    this.dictPath = path.join(dataDir, 'dictionary.json');
    this.settingsPath = path.join(dataDir, 'settings.json');
    ensureDir(dataDir);

    this.dict = readJson(this.dictPath, null) || { version: 1, langs: {} };
    if (!this.dict || typeof this.dict !== 'object') this.dict = { version: 1, langs: {} };
    if (!this.dict.langs || typeof this.dict.langs !== 'object') this.dict.langs = {};

    const defaults = {
      enabled: true,
      mode: 'bilingual',
      target: 'zh-CN',
      provider: 'auto',
      concurrency: 4,
      collapsed: true,
      querySearch: true,
      style: {
        fontFamily: '',
        fontSize: 0.95,
        color: '#a9c7ff',
        lineHeight: 1.45,
        border: true,
      },
      providers: {
        azure: { key: '', region: '', endpoint: '' },
        baidu: { appid: '', key: '' },
        alibaba: { accessKeyId: '', accessKeySecret: '' },
        deepl: { key: '', free: true },
      },
    };
    this.settings = mergeSettings(defaults, readJson(this.settingsPath, null) || {});

    this._flushTimer = null;
    this._dirty = false;
    this._dirtySettings = false;
  }

  _lang(target) {
    if (!this.dict.langs[target]) this.dict.langs[target] = {};
    return this.dict.langs[target];
  }

  /** All cached translations for a target: { key: translation }. */
  exportTranslations(target) {
    const lang = this.dict.langs[target] || {};
    const out = {};
    for (const key of Object.keys(lang)) {
      out[key] = lang[key].t;
    }
    return out;
  }

  /** Store [{ key, s, t, p }] and return the number of new/changed entries. */
  storeTranslations(target, entries) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const lang = this._lang(target);
    const now = Date.now();
    let changed = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.t !== 'string') continue;
      const t = entry.t.trim();
      if (!t) continue;
      const existing = lang[entry.key];
      if (existing && existing.t === t) {
        existing.u = now;
        continue;
      }
      lang[entry.key] = {
        s: typeof entry.s === 'string' ? entry.s.slice(0, 4000) : '',
        t: t.slice(0, 8000),
        p: typeof entry.p === 'string' ? entry.p.slice(0, 40) : '',
        ts: existing && existing.ts ? existing.ts : now,
        u: now,
      };
      changed++;
    }

    if (changed) {
      this._evict(lang);
      this._markDirty();
    }
    return changed;
  }

  _evict(lang) {
    const keys = Object.keys(lang);
    if (keys.length <= MAX_ENTRIES_PER_LANG) return;
    keys.sort((a, b) => (lang[a].u || 0) - (lang[b].u || 0));
    const remove = keys.length - MAX_ENTRIES_PER_LANG;
    for (let i = 0; i < remove; i++) delete lang[keys[i]];
  }

  getSettings() {
    return Object.assign({}, this.settings);
  }

  updateSettings(patch) {
    const allowed = [
      'enabled',
      'mode',
      'target',
      'provider',
      'concurrency',
      'collapsed',
      'querySearch',
    ];
    let changed = false;
    for (const key of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
        this.settings[key] = patch[key];
        changed = true;
      }
    }
    for (const group of ['style', 'providers']) {
      if (patch && patch[group] && typeof patch[group] === 'object') {
        this.settings[group] = mergeSettings(this.settings[group] || {}, patch[group]);
        changed = true;
      }
    }
    if (changed) {
      this._dirtySettings = true;
      this._markDirty();
    }
    return this.getSettings();
  }

  _markDirty() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, 700);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  flush() {
    if (this._dirty) {
      try {
        this.dict.updated = new Date().toISOString();
        writeJsonAtomic(this.dictPath, this.dict);
        this._dirty = false;
      } catch (e) {
        this.log('failed to write dictionary: ' + e.message);
      }
    }
    if (this._dirtySettings) {
      try {
        writeJsonAtomic(this.settingsPath, this.settings);
        this._dirtySettings = false;
      } catch (e) {
        this.log('failed to write settings: ' + e.message);
      }
    }
  }
}

module.exports = { Store, mergeSettings, ensureDir, readJson, writeJsonAtomic };
