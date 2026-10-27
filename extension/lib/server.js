'use strict';

// Local HTTP API used by the page script (wh-translate.js) for the persistent
// dictionary, settings and diagnostics. Bound to the loopback interface only.

const http = require('http');
const providers = require('./providers');

const PORT_RANGE_START = 19733;
const PORT_RANGE_END = 19760;
const MAX_BODY = 4 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(
    status,
    Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS)
  );
  res.end(body);
}

class ApiServer {
  constructor(options) {
    this.store = options.store;
    this.log = options.log || (() => {});
    this.onPageHello = options.onPageHello || (() => {});
    this.server = null;
    this.port = 0;
  }

  async start() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      const ok = await this._tryListen(port);
      if (ok) {
        this.port = port;
        this.log('api listening on 127.0.0.1:' + port);
        return port;
      }
    }
    throw new Error('no free port in ' + PORT_RANGE_START + '-' + PORT_RANGE_END);
  }

  _tryListen(port) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve(true);
      });
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {}
      this.server = null;
    }
    this.store.flush();
  }

  async _handle(req, res) {
    const started = Date.now();
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      if (url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          app: 'windhawk-translate',
          version: 1,
          port: this.port,
          uptime: Math.round(process.uptime()),
        });
        return;
      }

      if (url.pathname === '/hello' && req.method === 'POST') {
        let info = {};
        try {
          info = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {}
        this.onPageHello(info);
        sendJson(res, 200, this.store.getSettings());
        return;
      }

      if (url.pathname === '/settings') {
        if (req.method === 'GET') {
          sendJson(res, 200, this.store.getSettings());
          return;
        }
        if (req.method === 'POST') {
          const patch = JSON.parse((await readBody(req)) || '{}');
          const settings = this.store.updateSettings(patch);
          sendJson(res, 200, settings);
          return;
        }
      }

      if (url.pathname === '/dict') {
        if (req.method === 'GET') {
          const target = url.searchParams.get('target') || this.store.getSettings().target;
          sendJson(res, 200, {
            target,
            entries: this.store.exportTranslations(target),
          });
          return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const target = body.target || this.store.getSettings().target;
          const added = this.store.storeTranslations(target, body.entries);
          sendJson(res, 200, { target, added, total: Object.keys(this.store.exportTranslations(target)).length });
          return;
        }
      }

      // Key-based providers (Microsoft/Bing, Baidu, Alibaba, DeepL) cannot be
      // called from the webview: no CORS headers and the key must stay here.
      if (url.pathname === '/translate' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const settings = this.store.getSettings();
        const target = body.target || settings.target;
        const provider = body.provider || settings.provider;
        const texts = (Array.isArray(body.texts) ? body.texts : []).slice(0, 20);
        const results = [];
        const stored = [];
        for (let i = 0; i < texts.length; i++) {
          const text = String(texts[i] || '');
          if (!text.trim()) {
            results.push({ error: 'empty text' });
            continue;
          }
          try {
            const result = await providers.translate(provider, text, target, settings);
            results.push({ t: result.text, p: result.provider });
            stored.push({ key: body.keys && body.keys[i], s: text, t: result.text, p: result.provider });
          } catch (e) {
            results.push({ error: String((e && e.message) || e) });
          }
        }
        if (stored.length) this.store.storeTranslations(target, stored);
        sendJson(res, 200, { target, results });
        return;
      }

      if (url.pathname === '/log' && req.method === 'POST') {
        const body = await readBody(req);
        this.log('[page] ' + body.slice(0, 4000));
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      try {
        sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
      } catch (_) {}
      this.log('api error: ' + (e && e.message ? e.message : e));
    } finally {
      const ms = Date.now() - started;
      if (ms > 3000) this.log('slow request ' + req.method + ' ' + req.url + ' ' + ms + 'ms');
    }
  }
}

module.exports = { ApiServer };
