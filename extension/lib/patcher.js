'use strict';

// Installs and repairs the tiny injection into the Windhawk (VSCodium) webview:
//   1. copies assets/wh-translate.js next to the webview index.html
//   2. adds <script src="wh-translate.js"> to index.html
//   3. allows the translation endpoints in the webview CSP (extension.js)
// Every step is idempotent, so it can run after every application update.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_NAME = 'wh-translate.js';
const CSP_MARKER = '127.0.0.1';

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeText(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

/** Locate the Windhawk installation from the running VSCodium executable. */
function resolvePaths(extensionDir) {
  const candidates = [];
  const exeDir = path.dirname(process.execPath);
  if (path.basename(exeDir).toLowerCase() === 'ui') candidates.push(path.dirname(exeDir));
  if (process.env.WINDHAWK_UI_PATH) candidates.push(path.dirname(process.env.WINDHAWK_UI_PATH));
  candidates.push('C:\\Program Files\\Windhawk');
  candidates.push('G:\\Windhawk');

  for (const root of candidates) {
    const webviewDir = path.join(root, 'UI', 'resources', 'app', 'extensions', 'windhawk', 'webview');
    const extensionJs = path.join(root, 'UI', 'resources', 'app', 'extensions', 'windhawk', 'dist', 'extension.js');
    if (fs.existsSync(webviewDir) && fs.existsSync(extensionJs)) {
      return {
        root,
        webviewDir,
        extensionJs,
        indexHtml: path.join(webviewDir, 'index.html'),
        targetScript: path.join(webviewDir, SCRIPT_NAME),
        assetScript: path.join(extensionDir, 'assets', SCRIPT_NAME),
      };
    }
  }
  return null;
}

// The webview is served through a service worker which caches resources by
// URL, so the script URL carries a content hash: a new script version gets a
// new URL and the old cache entry can never be used.
function scriptTag(asset) {
  const hash = sha1(asset).slice(0, 12);
  return '<script src="' + SCRIPT_NAME + '?v=' + hash + '"></script>';
}

function patchHtml(html, asset) {
  const tag = scriptTag(asset);
  const existing = html.match(/<script[^>]*src="wh-translate\.js[^"]*"[^>]*><\/script>/);
  if (existing) {
    if (existing[0] === tag) return { html, changed: false };
    return { html: html.replace(existing[0], tag), changed: true };
  }
  let out;
  if (html.indexOf('</body>') !== -1) {
    out = html.replace('</body>', tag + '</body>');
  } else {
    out = html + tag;
  }
  return { html: out, changed: true };
}

function patchCsp(source) {
  if (source.indexOf(CSP_MARKER) !== -1) return { source, changed: false };
  const inject = 'connect-src https: http://127.0.0.1:* http://localhost:* ';
  const out = source.split('connect-src ').join(inject);
  return { source: out, changed: out !== source };
}

class Patcher {
  constructor(options) {
    this.paths = options.paths;
    this.backupDir = options.backupDir;
    this.log = options.log || (() => {});
    this.assetVersion = options.assetVersion || '';
    this._ensureBackupDir();
  }

  _ensureBackupDir() {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
    } catch (e) {}
  }

  _backup(file, name) {
    const target = path.join(this.backupDir, name + '.orig');
    const current = readText(file);
    if (current === null) return;
    const manifestPath = path.join(this.backupDir, 'manifest.json');
    let manifest = {};
    try {
      manifest = JSON.parse(readText(manifestPath) || '{}') || {};
    } catch (e) {}
    // Keep the newest pristine copy: only overwrite when the on-disk file is
    // not ours (i.e. a fresh file shipped by an application update).
    const isOurs = current.indexOf(CSP_MARKER) !== -1 || current.indexOf(SCRIPT_NAME) !== -1;
    if (!isOurs) {
      writeText(target, current);
      manifest[name] = { path: file, sha1: sha1(current), savedAt: new Date().toISOString() };
      writeText(manifestPath, JSON.stringify(manifest, null, 1));
    }
  }

  /** Returns { changed, actions[] } */
  heal() {
    const actions = [];
    const paths = this.paths;
    if (!paths) return { changed: false, actions: ['no installation found'] };

    // 1. Page script.
    let asset = readText(paths.assetScript);
    if (asset === null) return { changed: false, actions: ['asset missing: ' + paths.assetScript] };
    const current = readText(paths.targetScript);
    if (current !== asset) {
      try {
        writeText(paths.targetScript, asset);
        actions.push('wrote ' + SCRIPT_NAME);
      } catch (e) {
        actions.push('cannot write ' + SCRIPT_NAME + ': ' + e.message);
      }
    }

    // 2. Script tag in index.html.
    const html = readText(paths.indexHtml);
    if (html === null) {
      actions.push('index.html not found');
    } else {
      const patched = patchHtml(html, asset);
      if (patched.changed) {
        this._backup(paths.indexHtml, 'index.html');
        try {
          writeText(paths.indexHtml, patched.html);
          actions.push('patched index.html');
        } catch (e) {
          actions.push('cannot patch index.html: ' + e.message);
        }
      }
    }

    // 3. CSP hosts in the extension host bundle.
    const ext = readText(paths.extensionJs);
    if (ext === null) {
      actions.push('extension.js not found');
    } else {
      const patched = patchCsp(ext);
      if (patched.changed) {
        this._backup(paths.extensionJs, 'extension.js');
        try {
          writeText(paths.extensionJs, patched.source);
          actions.push('patched CSP');
        } catch (e) {
          actions.push('cannot patch CSP: ' + e.message);
        }
      }
    }

    const changed = actions.some(
      (a) => a.startsWith('wrote ') || a.startsWith('patched ')
    );
    return { changed, actions };
  }

  status() {
    const paths = this.paths;
    if (!paths) return { installed: false };
    const html = readText(paths.indexHtml) || '';
    const ext = readText(paths.extensionJs) || '';
    const script = readText(paths.targetScript);
    return {
      installed: true,
      root: paths.root,
      htmlPatched: html.indexOf(SCRIPT_NAME) !== -1,
      cspPatched: ext.indexOf(CSP_MARKER) !== -1,
      scriptPresent: script !== null,
      scriptVersion: (script || '').match(/var VERSION = '([^']+)'/)?.[1] || null,
      assetVersion: this.assetVersion,
    };
  }
}

module.exports = { Patcher, resolvePaths, SCRIPT_NAME };
