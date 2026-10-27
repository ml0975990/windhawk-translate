'use strict';

// Windhawk Translate - companion extension.
//
// It runs inside the Windhawk (VSCodium) UI process, which means it starts with
// the application, survives application updates (it lives in the user data
// folder, not in the installation folder) and can re-apply the webview patch
// whenever the installation files have been replaced.
//
// Responsibilities:
//   * keep the webview injection in place (see lib/patcher.js)
//   * serve the persistent dictionary / settings API on 127.0.0.1
//   * reload the window once when a freshly patched UI is already open

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Patcher, resolvePaths } = require('./lib/patcher');
const { Store, ensureDir } = require('./lib/store');
const { ApiServer } = require('./lib/server');

const RELOAD_GUARD_MS = 3 * 60 * 1000;

let runtime = null;

function createLogger(logDir) {
  ensureDir(logDir);
  const file = path.join(logDir, 'extension.log');
  try {
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch (e) {}
  return function log(message) {
    const line = new Date().toISOString() + ' ' + message + '\n';
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch (e) {}
  };
}

function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeState(dataDir, value) {
  try {
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(value, null, 1), 'utf8');
  } catch (e) {}
}

function resolveDataDir() {
  const candidates = [];
  if (process.env.WINDHAWK_TRANSLATE_DATA) candidates.push(process.env.WINDHAWK_TRANSLATE_DATA);
  candidates.push(path.join(process.env.ProgramData || 'C:\\ProgramData', 'Windhawk', 'Translate'));
  candidates.push(path.join(os.homedir(), '.windhawk-translate'));
  for (const dir of candidates) {
    try {
      ensureDir(dir);
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (e) {}
  }
  return null;
}

function activate(context) {
  const log = createLogger(path.join(resolveDataDir() || os.tmpdir(), 'logs'));
  const dataDir = resolveDataDir() || path.join(os.tmpdir(), 'windhawk-translate');
  ensureDir(path.join(dataDir, 'logs'));

  const paths = resolvePaths(context.extensionPath);
  const patcher = new Patcher({
    paths,
    backupDir: path.join(dataDir, 'backup'),
    log,
    assetVersion: context.extension.packageJSON.version,
  });

  const state = readState(dataDir);
  const store = new Store(dataDir, log);

  let pageSeen = false;
  const api = new ApiServer({
    store,
    log,
    onPageHello: (info) => {
      pageSeen = true;
      if (info && info.version) log('page connected, script version ' + info.version);
    },
  });

  runtime = { log, dataDir, patcher, store, api, paths, state };
  log('activate: ui=' + (paths ? paths.root : 'not found') + ' data=' + dataDir);

  const heal = (reason) => {
    const result = patcher.heal();
    if (!result.changed && result.actions.length === 0) return false;
    log('heal(' + reason + '): ' + result.actions.join(', '));
    return result.changed;
  };

  const healed = heal('activate');

  api
    .start()
    .then((port) => {
      log('api ready on port ' + port);
    })
    .catch((e) => log('api failed to start: ' + e.message));

  // If the UI window was already built from unpatched files, reload it once so
  // the injected script gets loaded. The page script announces itself through
  // /hello, which normally arrives before the timer fires.
  if (healed) {
    const last = state.lastReloadAt || 0;
    if (Date.now() - last < RELOAD_GUARD_MS) {
      log('reload skipped (guard)');
    } else {
      setTimeout(() => {
        if (pageSeen) return;
        log('reloading window to load the translation script');
        state.lastReloadAt = Date.now();
        writeState(dataDir, state);
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 2500);
    }
  }

  // Re-apply the patch whenever the application files change underneath us
  // (this is what happens when Windhawk updates itself).
  if (paths) {
    const watch = (dir) => {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => {
          clearTimeout(watch._timer);
          watch._timer = setTimeout(() => {
            const changed = heal('file change');
            if (changed && !pageSeen) {
              log('window reload requested after file change');
              state.lastReloadAt = Date.now();
              writeState(dataDir, state);
              vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          }, 800);
        });
        context.subscriptions.push({ dispose: () => watcher.close() });
      } catch (e) {
        log('watch failed for ' + dir + ': ' + e.message);
      }
    };
    watch(paths.webviewDir);
    watch(path.dirname(paths.extensionJs));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('windhawkTranslate.status', () => {
      const status = patcher.status();
      const info = [
        'Windhawk Translate ' + context.extension.packageJSON.version,
        'UI: ' + (status.root || 'not found'),
        'index.html patched: ' + status.htmlPatched,
        'CSP patched: ' + status.cspPatched,
        'page script: ' + status.scriptVersion + ' (asset ' + status.assetVersion + ')',
        'API port: ' + (api.port || 'n/a'),
        'data: ' + dataDir,
      ].join('\n');
      log('status:\n' + info);
      vscode.window.showInformationMessage('Windhawk Translate: ' + (status.htmlPatched && status.cspPatched ? 'active' : 'needs repair'));
    }),
    vscode.commands.registerCommand('windhawkTranslate.repair', () => {
      const changed = heal('manual');
      vscode.window.showInformationMessage(
        changed ? 'Windhawk Translate: patch re-applied, reloading' : 'Windhawk Translate: patch is up to date'
      );
      if (changed) vscode.commands.executeCommand('workbench.action.reloadWindow');
    })
  );

  context.subscriptions.push({ dispose: () => api.stop() });
}

function deactivate() {
  if (runtime) {
    try {
      runtime.api.stop();
    } catch (e) {}
    runtime.store.flush();
    runtime = null;
  }
}

module.exports = { activate, deactivate };
