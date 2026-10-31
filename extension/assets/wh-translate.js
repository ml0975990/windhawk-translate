/* Windhawk Translate - page script.
 *
 * Injected into the Windhawk webview by the companion extension. It translates
 * mod cards and mod details in real time and renders them in one of three
 * modes: original, translation only, or bilingual (translation on top, the
 * original underneath in a smaller font).
 *
 * Translations are cached in a persistent dictionary owned by the extension
 * (dictionary.json), so a text that was translated once is never translated
 * again, even across restarts and application updates.
 */
'use strict';

(function () {
  var VERSION = '1.1.1';

  if (window.__windhawkTranslate) return;
  window.__windhawkTranslate = { version: VERSION };

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  var PORT_START = 19733;
  var PORT_END = 19760;
  var MODES = ['original', 'translated', 'bilingual'];
  var MODE_LABELS = { original: '原文', translated: '译文', bilingual: '双语' };

  var LANGUAGES = [
    { id: 'zh-CN', label: '简体中文' },
    { id: 'zh-TW', label: '繁體中文' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' },
  ];

  // Providers that must run in the extension host (key handling / no CORS).
  var SERVER_PROVIDERS = { azure: 1, baidu: 1, alibaba: 1, deepl: 1 };

  var PROVIDERS = [
    { id: 'auto', label: '自动（推荐）' },
    { id: 'google', label: 'Google（免密钥）' },
    { id: 'mymemory', label: 'MyMemory（免密钥）' },
    { id: 'azure', label: '微软 / 必应（密钥）' },
    { id: 'baidu', label: '百度（密钥）' },
    { id: 'alibaba', label: '阿里云（密钥）' },
    { id: 'deepl', label: 'DeepL（密钥）' },
  ];

  var FONT_OPTIONS = [
    { id: '', label: '跟随界面' },
    { id: '"Microsoft YaHei", "微软雅黑", sans-serif', label: '微软雅黑' },
    { id: '"SimSun", "宋体", serif', label: '宋体' },
    { id: '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif', label: '思源黑体' },
    { id: '"DengXian", "等线", sans-serif', label: '等线' },
  ];
  var SIZE_OPTIONS = [
    { id: '0.85', label: '较小 85%' },
    { id: '0.95', label: '默认 95%' },
    { id: '1', label: '100%' },
    { id: '1.1', label: '较大 110%' },
    { id: '1.2', label: '大 120%' },
  ];
  var LINE_OPTIONS = [
    { id: '1.25', label: '紧凑' },
    { id: '1.45', label: '默认' },
    { id: '1.65', label: '宽松' },
    { id: '1.85', label: '很宽松' },
  ];
  var COLOR_PRESETS = ['#a9c7ff', '#8ee6c8', '#ffd28a', '#ff9f9f', '#d3b4ff', '#e6e6e6'];

  var MD_ROOT = '[class*="ReactMarkdownCustom__ReactMarkdownStyleWrapper"]';

  var state = {
    version: VERSION,
    mode: 'bilingual',
    target: 'zh-CN',
    provider: 'auto',
    enabled: true,
    collapsed: true,
    style: { fontFamily: '', fontSize: 0.95, color: '#a9c7ff', lineHeight: 1.45, border: true },
    providers: {},
    apiBase: null,
    dict: new Map(),
    units: new WeakMap(),
    registry: new Set(),
    queue: [],
    active: 0,
    concurrency: 4,
    applying: false,
    scanTimer: 0,
    storeBuffer: [],
    storeTimer: 0,
    translatedCount: 0,
    failedCount: 0,
    apiOnline: false,
    saveTimer: 0,
  };

  var doc = document;

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  function log() {
    var args = Array.prototype.slice.call(arguments);
    try {
      console.log.apply(console, ['[whtr]'].concat(args));
    } catch (e) {}
    if (state.apiBase) {
      try {
        fetch(state.apiBase + '/log', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: args.map(String).join(' ').slice(0, 3900),
        }).catch(function () {});
      } catch (e) {}
    }
  }

  function hash64(str) {
    var h1 = 0x811c9dc5;
    var h2 = 0x9e3779b1;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
      h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  function keyFor(text) {
    return hash64(state.target + '\u0000' + text);
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function hasLetter(text) {
    return /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(
      text
    );
  }

  function cjkRatio(text) {
    var letters = 0;
    var cjk = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code <= 32) continue;
      if (code >= 0x4e00 && code <= 0x9fff) {
        cjk++;
        letters++;
      } else if (
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        letters++;
      }
    }
    return letters ? cjk / letters : 0;
  }

  function isTargetLanguage(text) {
    if (state.target.indexOf('zh') === 0) return cjkRatio(text) > 0.35;
    if (state.target === 'ja') return /[\u3040-\u30ff]/.test(text) && cjkRatio(text) > 0.15;
    if (state.target === 'ko') return /[\uac00-\ud7af]/.test(text) && cjkRatio(text) > 0.2;
    if (state.target === 'en') return !/[\u4e00-\u9fff]/.test(text) && cjkRatio(text) === 0;
    return false;
  }

  function isSkippableText(text) {
    if (!text || text.length < 2) return true;
    if (text.length > 3000) return true;
    if (!hasLetter(text)) return true;
    if (/^[\d\s.,:;!?%+\-–—/\\|()[\]{}'"“”‘’<>@#$&*_=~`^]+$/.test(text)) return true;
    if (/^https?:\/\/\S+$/i.test(text)) return true;
    if (isTargetLanguage(text)) return true;
    return false;
  }

  function inExcludedContext(el) {
    for (var node = el; node && node !== doc.body; node = node.parentElement) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'pre' || tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'textarea') return true;
      if (node.isContentEditable) return true;
      if (node.hasAttribute && node.hasAttribute('data-whtr-tr')) return true;
    }
    return false;
  }

  function isOurNode(node) {
    if (!node) return false;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return false;
    return !!el.closest('.whtr-bar,.whtr-pop,.whtr-fab,.whtr-tr');
  }

  // ---------------------------------------------------------------------------
  // API (dictionary service)
  // ---------------------------------------------------------------------------

  function apiFetch(path, options) {
    if (!state.apiBase) return Promise.reject(new Error('api offline'));
    return fetch(state.apiBase + path, options);
  }

  function probeApi() {
    var ports = [];
    for (var p = PORT_START; p <= PORT_END; p++) ports.push(p);
    var index = 0;
    return new Promise(function (resolve) {
      function next() {
        if (index >= ports.length) return resolve(false);
        var port = ports[index++];
        var base = 'http://127.0.0.1:' + port;
        var timer = setTimeout(next, 700);
        fetch(base + '/health')
          .then(function (r) {
            return r.json();
          })
          .then(function (health) {
            clearTimeout(timer);
            if (health && health.app === 'windhawk-translate') {
              state.apiBase = base;
              state.apiOnline = true;
              resolve(true);
            } else {
              next();
            }
          })
          .catch(function () {
            clearTimeout(timer);
            next();
          });
      }
      next();
    });
  }

  function loadRemoteState() {
    return Promise.all([
      apiFetch('/settings').then(function (r) {
        return r.json();
      }),
      apiFetch('/dict?target=' + encodeURIComponent(state.target)).then(function (r) {
        return r.json();
      }),
    ])
      .then(function (results) {
        var settings = results[0] || {};
        var dict = results[1] || {};
        applyRemoteSettings(settings);
        if (dict.entries) {
          for (var key in dict.entries) {
            if (Object.prototype.hasOwnProperty.call(dict.entries, key)) {
              state.dict.set(key, dict.entries[key]);
            }
          }
        }
        applyStyleVars();
        applyCollapsed();
        log('loaded dictionary: ' + state.dict.size + ' entries');
      })
      .catch(function (e) {
        log('failed to load remote state: ' + e.message);
      });
  }

  function applyRemoteSettings(settings) {
    if (!settings) return;
    var localMode = readLocal('mode');
    var localTarget = readLocal('target');
    var localCollapsed = readLocal('collapsed');
    if (!localMode && MODES.indexOf(settings.mode) !== -1) state.mode = settings.mode;
    if (!localTarget && settings.target) state.target = settings.target;
    if (typeof settings.enabled === 'boolean') state.enabled = settings.enabled;
    if (settings.provider) state.provider = settings.provider;
    if (settings.concurrency) state.concurrency = Math.max(1, Math.min(8, settings.concurrency));
    if (typeof settings.collapsed === 'boolean') state.collapsed = settings.collapsed;
    if (localCollapsed !== null) state.collapsed = localCollapsed !== '0';
    if (settings.style) state.style = Object.assign({}, state.style, settings.style);
    if (settings.providers) state.providers = settings.providers;
  }

  function readLocal(name) {
    try {
      return window.localStorage.getItem('whtr:' + name);
    } catch (e) {
      return null;
    }
  }

  function writeLocal(name, value) {
    try {
      window.localStorage.setItem('whtr:' + name, value);
    } catch (e) {}
  }

  function scheduleSave(patch) {
    state.pendingPatch = Object.assign({}, state.pendingPatch || {}, patch);
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(function () {
      state.saveTimer = 0;
      var payload = state.pendingPatch;
      state.pendingPatch = null;
      if (!state.apiBase || !payload) return;
      apiFetch('/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {});
    }, 450);
  }

  function pushSettings() {
    writeLocal('mode', state.mode);
    writeLocal('target', state.target);
    writeLocal('collapsed', state.collapsed ? '1' : '0');
    scheduleSave({
      mode: state.mode,
      target: state.target,
      provider: state.provider,
      enabled: state.enabled,
      collapsed: state.collapsed,
      style: state.style,
      providers: state.providers,
    });
  }

  function queueStore(text, translation, provider) {
    state.storeBuffer.push({ key: keyFor(text), s: text, t: translation, p: provider });
    if (state.storeTimer) return;
    state.storeTimer = setTimeout(flushStore, 1200);
  }

  function flushStore() {
    state.storeTimer = 0;
    if (!state.storeBuffer.length || !state.apiBase) {
      state.storeBuffer = [];
      return;
    }
    var entries = state.storeBuffer.splice(0, 200);
    apiFetch('/dict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: state.target, entries: entries }),
    }).catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // Translation providers
  // ---------------------------------------------------------------------------

  function fetchWithTimeout(url, options, timeout) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeout || 12000);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).finally(function () {
      clearTimeout(timer);
    });
  }

  function googleTranslate(text) {
    var url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(state.target) +
      '&dt=t&q=' +
      encodeURIComponent(text);
    return fetchWithTimeout(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (r.status === 429) throw new Error('google 429');
      if (!r.ok) throw new Error('google http ' + r.status);
      return r.json().then(function (json) {
        if (!json || !json[0] || !json[0].length) throw new Error('google empty');
        var out = '';
        for (var i = 0; i < json[0].length; i++) {
          if (json[0][i] && typeof json[0][i][0] === 'string') out += json[0][i][0];
        }
        out = out.trim();
        if (!out) throw new Error('google empty');
        return out;
      });
    });
  }

  function myMemoryTranslate(text) {
    var url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(text) +
      '&langpair=' +
      encodeURIComponent('en') +
      '|' +
      encodeURIComponent(state.target);
    return fetchWithTimeout(url).then(function (r) {
      if (!r.ok) throw new Error('mymemory http ' + r.status);
      return r.json().then(function (json) {
        var out = json && json.responseData && json.responseData.translatedText;
        if (!out || /^\s*$/.test(out)) throw new Error('mymemory empty');
        if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('mymemory quota');
        return out.trim();
      });
    });
  }

  var PAGE_PROVIDERS = { google: googleTranslate, mymemory: myMemoryTranslate };

  function serverTranslate(text, provider) {
    return apiFetch('/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        texts: [text],
        keys: [keyFor(text)],
        target: state.target,
        provider: provider || state.provider,
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (json) {
        var result = json && json.results && json.results[0];
        if (!result || result.error) throw new Error((result && result.error) || 'server translate failed');
        // The server stores server-side translations in the dictionary itself.
        return { text: result.t, provider: result.p, fromServer: true };
      });
  }

  function providerChain() {
    if (state.provider === 'auto') return ['google', 'mymemory'];
    if (PAGE_PROVIDERS[state.provider]) return [state.provider];
    return [];
  }

  function translateText(text) {
    if (SERVER_PROVIDERS[state.provider]) {
      return serverTranslate(text, state.provider);
    }
    var chain = providerChain();
    var index = 0;
    function attempt() {
      if (index >= chain.length) {
        // Last resort: let the extension host try (it also has the key-based
        // providers configured by the user).
        if (state.apiBase) {
          return serverTranslate(text, 'auto').catch(function (e) {
            throw e || new Error('all providers failed');
          });
        }
        return Promise.reject(new Error('all providers failed'));
      }
      var name = chain[index++];
      return PAGE_PROVIDERS[name](text)
        .then(function (out) {
          return { text: out, provider: name };
        })
        .catch(function (e) {
          log('provider ' + name + ' failed: ' + e.message);
          return attempt();
        });
    }
    return attempt();
  }

  // ---------------------------------------------------------------------------
  // DOM: styles, toolbar
  // ---------------------------------------------------------------------------

  var STYLE_TEXT = [
    '.whtr-tr{display:block;margin:0 0 2px 0;font-family:var(--whtr-font,inherit);font-size:var(--whtr-size,.95em);color:var(--whtr-color,#a9c7ff);line-height:var(--whtr-lh,1.45);border-left:2px solid rgba(169,199,255,.45);padding-left:7px;text-align:start;white-space:normal;word-break:break-word;font-weight:normal;letter-spacing:normal;}',
    '.whtr-tr.whtr-no-border{border-left:0;padding-left:0}',
    '[data-whtr-mode="original"] .whtr-tr{display:none !important}',
    '[data-whtr-mode="translated"] [data-whtr-hide="1"]{display:none !important}',
    '[data-whtr-mode="translated"] .whtr-tr{border-left:0;padding-left:0;color:inherit;margin:0;display:block;font-family:inherit}',
    '.whtr-tr.whtr-li{display:list-item}',
    '[data-whtr-mode="translated"] .whtr-tr.whtr-li{display:list-item}',
    '[data-whtr-mode="bilingual"] [data-whtr-orig="1"]{font-size:.85em;opacity:.82}',
    '.whtr-fab{position:fixed;right:0;top:42%;z-index:2147483000;width:38px;height:46px;border-radius:10px 0 0 10px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#4c8dff,#8b5cf6);color:#fff;font:700 15px/1 "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;box-shadow:-2px 2px 14px rgba(0,0,0,.45);user-select:none;opacity:.9;transition:opacity .15s ease;}',
    '.whtr-fab:hover{opacity:1}',
    'body.whtr-open .whtr-fab{display:none}',
    '.whtr-bar{position:fixed;right:14px;bottom:64px;z-index:2147483000;display:none;align-items:center;gap:6px;padding:5px 6px;border-radius:12px;background:rgba(30,31,36,.95);border:1px solid rgba(255,255,255,.12);box-shadow:0 6px 24px rgba(0,0,0,.45);font:12px/1.2 "Segoe UI","Microsoft YaHei",sans-serif;color:#e9ecf3;user-select:none;backdrop-filter:blur(8px);}',
    'body.whtr-open .whtr-bar{display:flex}',
    '.whtr-bar *{box-sizing:border-box}',
    '.whtr-brand{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#4c8dff,#8b5cf6);color:#fff;font-weight:700;font-size:12px;flex:none;}',
    '.whtr-seg{display:flex;background:rgba(255,255,255,.06);border-radius:8px;padding:2px;gap:2px;}',
    '.whtr-seg button{appearance:none;border:0;background:transparent;color:#c8cede;font:inherit;padding:4px 9px;border-radius:6px;cursor:pointer;line-height:1.1;}',
    '.whtr-seg button:hover{background:rgba(255,255,255,.08);color:#fff}',
    '.whtr-seg button.whtr-on{background:#4c8dff;color:#fff}',
    '.whtr-status{display:flex;align-items:center;gap:4px;color:#8f98ab;padding:0 2px;min-width:0;font-size:11px;white-space:nowrap;}',
    '.whtr-dot{width:6px;height:6px;border-radius:50%;background:#3ecf8e;flex:none;}',
    '.whtr-dot.whtr-busy{background:#f5a524;animation:whtr-pulse 1s infinite}',
    '.whtr-dot.whtr-off{background:#ef4444}',
    '@keyframes whtr-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
    '.whtr-gear,.whtr-collapse{appearance:none;border:0;background:transparent;color:#c8cede;cursor:pointer;padding:4px 6px;border-radius:6px;font-size:13px;line-height:1;}',
    '.whtr-gear:hover,.whtr-collapse:hover{background:rgba(255,255,255,.08);color:#fff}',
    '.whtr-pop{position:fixed;right:14px;bottom:102px;z-index:2147483001;background:#1e1f24;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:10px;font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#e9ecf3;width:322px;max-height:min(72vh,620px);overflow:auto;display:none;}',
    '.whtr-pop.whtr-open{display:block}',
    '.whtr-group{color:#7f889b;font-size:11px;margin:10px 0 4px;letter-spacing:.04em;}',
    '.whtr-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0;}',
    '.whtr-row label{color:#aab2c5;flex:none}',
    '.whtr-pop select,.whtr-pop input[type="text"],.whtr-pop input[type="password"]{background:#23252c;color:#e9ecf3;border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:3px 6px;font:inherit;outline:none;min-width:0;max-width:196px;}',
    '.whtr-pop input[type="color"]{width:34px;height:22px;padding:0;border:1px solid rgba(255,255,255,.16);border-radius:6px;background:#23252c;}',
    '.whtr-swatches{display:flex;gap:4px}',
    '.whtr-swatch{width:16px;height:16px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.25)}',
    '.whtr-note{color:#7f889b;font-size:11px;margin-top:8px;border-top:1px solid rgba(255,255,255,.08);padding-top:6px;word-break:break-all;}',
    '.whtr-inline{display:flex;align-items:center;gap:6px}',
    '.whtr-cfg{display:none;margin:4px 0 2px;padding:6px 8px;background:rgba(255,255,255,.04);border-radius:8px}',
    '.whtr-cfg.whtr-cfg-on{display:block}',
  ].join('\n');

  var ui = { fab: null, bar: null, statusDot: null, statusText: null, pop: null, cfg: null };

  function installStyles() {
    if (doc.getElementById('whtr-style')) return;
    var style = doc.createElement('style');
    style.id = 'whtr-style';
    style.textContent = STYLE_TEXT;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function applyStyleVars() {
    var style = state.style || {};
    var root = doc.documentElement;
    root.style.setProperty('--whtr-font', style.fontFamily || 'inherit');
    root.style.setProperty('--whtr-size', (style.fontSize || 0.95) + 'em');
    root.style.setProperty('--whtr-color', style.color || '#a9c7ff');
    root.style.setProperty('--whtr-lh', style.lineHeight || 1.45);
  }

  function applyCollapsed() {
    if (state.collapsed) doc.body.classList.remove('whtr-open');
    else doc.body.classList.add('whtr-open');
  }

  function buildToolbar() {
    if (ui.bar) return;

    var fab = doc.createElement('div');
    fab.className = 'whtr-fab';
    fab.setAttribute('data-whtr-ui', '1');
    fab.title = 'Windhawk 翻译';
    fab.textContent = '译';
    fab.addEventListener('click', function () {
      state.collapsed = false;
      applyCollapsed();
      pushSettings();
    });

    var bar = doc.createElement('div');
    bar.className = 'whtr-bar';
    bar.setAttribute('data-whtr-ui', '1');
    bar.title = 'Windhawk Translate ' + VERSION;

    var brand = doc.createElement('div');
    brand.className = 'whtr-brand';
    brand.textContent = '译';
    bar.appendChild(brand);

    var seg = doc.createElement('div');
    seg.className = 'whtr-seg';
    MODES.forEach(function (mode) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.textContent = MODE_LABELS[mode];
      button.setAttribute('data-mode', mode);
      button.title = mode === 'original' ? '只显示原文' : mode === 'translated' ? '只显示译文' : '译文在上，原文在下';
      button.addEventListener('click', function () {
        setMode(mode);
      });
      seg.appendChild(button);
    });
    bar.appendChild(seg);

    var status = doc.createElement('div');
    status.className = 'whtr-status';
    var dot = doc.createElement('div');
    dot.className = 'whtr-dot';
    var text = doc.createElement('span');
    status.appendChild(dot);
    status.appendChild(text);
    bar.appendChild(status);

    var gear = doc.createElement('button');
    gear.type = 'button';
    gear.className = 'whtr-gear';
    gear.textContent = '\u2699';
    gear.title = '翻译设置';
    gear.addEventListener('click', function (event) {
      event.stopPropagation();
      togglePopover();
    });
    bar.appendChild(gear);

    var collapse = doc.createElement('button');
    collapse.type = 'button';
    collapse.className = 'whtr-collapse';
    collapse.textContent = '\u00bb';
    collapse.title = '收起';
    collapse.addEventListener('click', function (event) {
      event.stopPropagation();
      state.collapsed = true;
      closePopover();
      applyCollapsed();
      pushSettings();
    });
    bar.appendChild(collapse);

    var pop = doc.createElement('div');
    pop.className = 'whtr-pop';
    pop.setAttribute('data-whtr-ui', '1');
    pop.appendChild(buildPopover());

    (doc.body || doc.documentElement).appendChild(fab);
    (doc.body || doc.documentElement).appendChild(bar);
    (doc.body || doc.documentElement).appendChild(pop);

    doc.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('.whtr-bar,.whtr-pop,.whtr-fab')) return;
      closePopover();
    });

    ui.fab = fab;
    ui.bar = bar;
    ui.pop = pop;
    ui.statusDot = dot;
    ui.statusText = text;
    applyCollapsed();
  }

  function closePopover() {
    if (ui.pop) ui.pop.classList.remove('whtr-open');
  }

  function togglePopover() {
    if (!ui.pop) return;
    ui.pop.classList.toggle('whtr-open');
    if (ui.pop.classList.contains('whtr-open')) refreshProviderConfig();
  }

  function selectRow(labelText, options, current, onChange) {
    var row = doc.createElement('div');
    row.className = 'whtr-row';
    var label = doc.createElement('label');
    label.textContent = labelText;
    var select = doc.createElement('select');
    options.forEach(function (option) {
      var item = doc.createElement('option');
      item.value = option.id;
      item.textContent = option.label;
      if (option.id === current) item.selected = true;
      select.appendChild(item);
    });
    select.addEventListener('change', function () {
      onChange(select.value);
    });
    row.appendChild(label);
    row.appendChild(select);
    return { row: row, select: select };
  }

  function buildPopover() {
    var wrap = doc.createElement('div');

    var groupTrans = doc.createElement('div');
    groupTrans.className = 'whtr-group';
    groupTrans.textContent = '翻译';
    wrap.appendChild(groupTrans);

    wrap.appendChild(
      selectRow('目标语言', LANGUAGES, state.target, function (value) {
        setTarget(value);
      }).row
    );

    wrap.appendChild(
      selectRow('翻译服务', PROVIDERS, state.provider, function (value) {
        state.provider = value;
        pushSettings();
        refreshProviderConfig();
        updateStatus();
        log('provider changed to ' + value);
      }).row
    );

    var providerHint = doc.createElement('div');
    providerHint.className = 'whtr-note';
    providerHint.style.borderTop = '0';
    providerHint.style.marginTop = '0';
    providerHint.textContent = '自动：Google → MyMemory，配置微软密钥后优先微软';
    wrap.appendChild(providerHint);

    var cfg = doc.createElement('div');
    cfg.className = 'whtr-cfg';
    wrap.appendChild(cfg);
    ui.cfg = cfg;

    var groupStyle = doc.createElement('div');
    groupStyle.className = 'whtr-group';
    groupStyle.textContent = '译文样式';
    wrap.appendChild(groupStyle);

    wrap.appendChild(
      selectRow('字体', FONT_OPTIONS, state.style.fontFamily || '', function (value) {
        state.style.fontFamily = value;
        applyStyleVars();
        pushSettings();
      }).row
    );

    wrap.appendChild(
      selectRow('字号', SIZE_OPTIONS, String(state.style.fontSize || 0.95), function (value) {
        state.style.fontSize = parseFloat(value);
        applyStyleVars();
        pushSettings();
      }).row
    );

    wrap.appendChild(
      selectRow('行距', LINE_OPTIONS, String(state.style.lineHeight || 1.45), function (value) {
        state.style.lineHeight = parseFloat(value);
        applyStyleVars();
        pushSettings();
      }).row
    );

    var colorRow = doc.createElement('div');
    colorRow.className = 'whtr-row';
    var colorLabel = doc.createElement('label');
    colorLabel.textContent = '颜色';
    var colorWrap = doc.createElement('div');
    colorWrap.className = 'whtr-inline';
    var swatches = doc.createElement('div');
    swatches.className = 'whtr-swatches';
    COLOR_PRESETS.forEach(function (color) {
      var swatch = doc.createElement('div');
      swatch.className = 'whtr-swatch';
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', function () {
        state.style.color = color;
        colorInput.value = color;
        applyStyleVars();
        pushSettings();
      });
      swatches.appendChild(swatch);
    });
    var colorInput = doc.createElement('input');
    colorInput.type = 'color';
    colorInput.value = state.style.color || '#a9c7ff';
    colorInput.addEventListener('input', function () {
      state.style.color = colorInput.value;
      applyStyleVars();
      pushSettings();
    });
    colorWrap.appendChild(swatches);
    colorWrap.appendChild(colorInput);
    colorRow.appendChild(colorLabel);
    colorRow.appendChild(colorWrap);
    wrap.appendChild(colorRow);

    var borderRow = doc.createElement('div');
    borderRow.className = 'whtr-row';
    var borderLabel = doc.createElement('label');
    borderLabel.textContent = '左侧竖线';
    var borderInput = doc.createElement('input');
    borderInput.type = 'checkbox';
    borderInput.checked = state.style.border !== false;
    borderInput.addEventListener('change', function () {
      state.style.border = borderInput.checked;
      applyBorderClass();
      pushSettings();
    });
    borderRow.appendChild(borderLabel);
    borderRow.appendChild(borderInput);
    wrap.appendChild(borderRow);

    var note = doc.createElement('div');
    note.className = 'whtr-note';
    note.setAttribute('data-whtr-note', '1');
    note.textContent = '已缓存 0 条';
    wrap.appendChild(note);

    return wrap;
  }

  function applyBorderClass() {
    var hide = state.style && state.style.border === false;
    doc.querySelectorAll('.whtr-tr').forEach(function (node) {
      node.classList.toggle('whtr-no-border', !!hide);
    });
  }

  function refreshProviderConfig() {
    var box = ui.cfg;
    if (!box) return;
    box.innerHTML = '';
    var name = state.provider;
    var configs = state.providers || {};
    var fields = [];

    if (name === 'azure') {
      fields = [
        { key: 'key', label: '订阅密钥', type: 'password', placeholder: 'Azure Translator Key' },
        { key: 'region', label: '区域', type: 'text', placeholder: '如 eastasia，可留空' },
        { key: 'endpoint', label: '端点', type: 'text', placeholder: '默认 api.cognitive.microsofttranslator.com' },
      ];
    } else if (name === 'baidu') {
      fields = [
        { key: 'appid', label: 'APPID', type: 'text', placeholder: '百度翻译开放平台 APPID' },
        { key: 'key', label: '密钥', type: 'password', placeholder: '百度翻译密钥' },
      ];
    } else if (name === 'alibaba') {
      fields = [
        { key: 'accessKeyId', label: 'AccessKey ID', type: 'text', placeholder: '阿里云 AccessKey ID' },
        { key: 'accessKeySecret', label: 'Secret', type: 'password', placeholder: '阿里云 AccessKey Secret' },
      ];
    } else if (name === 'deepl') {
      fields = [
        { key: 'key', label: '密钥', type: 'password', placeholder: 'DeepL Auth Key' },
      ];
    }

    if (!fields.length) {
      box.classList.remove('whtr-cfg-on');
      return;
    }
    box.classList.add('whtr-cfg-on');
    var current = configs[name] || {};

    fields.forEach(function (field) {
      var row = doc.createElement('div');
      row.className = 'whtr-row';
      var label = doc.createElement('label');
      label.textContent = field.label;
      var input = doc.createElement('input');
      input.type = field.type;
      input.placeholder = field.placeholder;
      input.value = current[field.key] || '';
      input.addEventListener('input', function () {
        state.providers = state.providers || {};
        state.providers[name] = state.providers[name] || {};
        state.providers[name][field.key] = input.value;
        pushSettings();
      });
      row.appendChild(label);
      row.appendChild(input);
      box.appendChild(row);
    });

    if (name === 'deepl') {
      var freeRow = doc.createElement('div');
      freeRow.className = 'whtr-row';
      var freeLabel = doc.createElement('label');
      freeLabel.textContent = '免费版';
      var freeInput = doc.createElement('input');
      freeInput.type = 'checkbox';
      freeInput.checked = current.free !== false;
      freeInput.addEventListener('change', function () {
        state.providers.deepl = state.providers.deepl || {};
        state.providers.deepl.free = freeInput.checked;
        pushSettings();
      });
      freeRow.appendChild(freeLabel);
      freeRow.appendChild(freeInput);
      box.appendChild(freeRow);
    }

    var hint = doc.createElement('div');
    hint.className = 'whtr-note';
    hint.style.borderTop = '0';
    hint.style.marginTop = '2px';
    hint.textContent = '密钥仅保存在本机 settings.json';
    box.appendChild(hint);
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) === -1) return;
    state.mode = mode;
    writeLocal('mode', mode);
    pushSettings();
    applyMode();
    if (mode !== 'original') scheduleScan(0);
    updateStatus();
  }

  function applyMode() {
    doc.documentElement.setAttribute('data-whtr-mode', state.mode);
    if (ui.bar) {
      var buttons = ui.bar.querySelectorAll('.whtr-seg button');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('whtr-on', buttons[i].getAttribute('data-mode') === state.mode);
      }
    }
    var hide = state.mode === 'translated';
    state.registry.forEach(function (unit) {
      if (!unit.node || !unit.node.parentNode) return;
      // Only attributes and inline styles here: the source element itself is
      // never moved or wrapped, so React keeps working.
      if (hide && !unit.hasNestedList) unit.el.setAttribute('data-whtr-hide', '1');
      else unit.el.removeAttribute('data-whtr-hide');
      syncTypography(unit);
    });
  }

  // In "translated" mode the source block is hidden with display:none, so its
  // typography is copied onto the translation to keep headings and paragraph
  // spacing. Bilingual/original modes use the normal CSS.
  function syncTypography(unit) {
    if (!unit.node) return;
    var style = unit.node.style;
    style.fontSize = '';
    style.fontWeight = '';
    style.lineHeight = '';
    style.margin = '';
    if (state.mode !== 'translated' || !unit.isMarkdown) return;
    try {
      var cs = unit.el.ownerDocument.defaultView.getComputedStyle(unit.el);
      if (!cs) return;
      style.fontSize = cs.fontSize;
      style.fontWeight = cs.fontWeight;
      style.lineHeight = cs.lineHeight;
      style.margin = cs.margin;
    } catch (e) {}
  }

  function updateStatus() {
    if (!ui.bar) return;
    var busy = state.active > 0 || state.queue.length > 0;
    ui.statusDot.className = 'whtr-dot' + (busy ? ' whtr-busy' : state.apiOnline ? '' : ' whtr-off');
    var label = '';
    if (!state.enabled) label = '已关闭';
    else if (busy) label = '翻译中 ' + (state.active + state.queue.length);
    else if (state.failedCount) label = '部分失败';
    else if (state.translatedCount || state.dict.size) label = state.dict.size + ' 条';
    ui.statusText.textContent = label;
    ui.bar.title =
      'Windhawk Translate ' +
      VERSION +
      (state.apiBase ? ' · ' + state.apiBase : ' · 离线') +
      (state.lastError ? '\n最近错误：' + state.lastError : '');
    updateNote();
  }

  function updateNote() {
    var note = ui.pop && ui.pop.querySelector('[data-whtr-note]');
    if (!note) return;
    var providerLabel = '自动';
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].id === state.provider) providerLabel = PROVIDERS[i].label;
    }
    note.textContent =
      '已缓存 ' + state.dict.size + ' 条 · ' + providerLabel + (state.apiOnline ? '' : ' · 字典服务未连接');
  }

  // ---------------------------------------------------------------------------
  // DOM: unit discovery and rendering
  // ---------------------------------------------------------------------------

  function findAnchor(el, kind) {
    if (kind === 'cardTitle') {
      return el.closest('[class*="ModCardTitleContainer"]') || el;
    }
    if (kind === 'detailsTitle') {
      return el.parentElement || el;
    }
    return el;
  }

  // The title text and its wrapper share the "ModCard__ModCardTitle" prefix;
  // match only the leaf element, with a fallback for renamed builds.
  function cardTitleElements() {
    var exact = doc.querySelectorAll('[class*="ModCard__ModCardTitle-sc-"]');
    if (exact.length) return exact;
    var broad = Array.prototype.slice.call(doc.querySelectorAll('[class*="ModCard__ModCardTitle"]'));
    return broad.filter(function (el) {
      return !broad.some(function (other) {
        return other !== el && el.contains(other);
      });
    });
  }

  function collectCandidates() {
    var found = [];

    cardTitleElements().forEach(function (el) {
      found.push({ el: el, kind: 'cardTitle' });
    });
    doc.querySelectorAll('.ant-card-meta-description').forEach(function (el) {
      found.push({ el: el, kind: 'cardDesc' });
    });
    doc.querySelectorAll('[class*="ModDetailsHeader__CardTitleFirstLine"] > div:first-child').forEach(function (el) {
      found.push({ el: el, kind: 'detailsTitle' });
    });
    doc.querySelectorAll('[class*="ModDetailsHeader__CardTitleDescription"]').forEach(function (el) {
      found.push({ el: el, kind: 'detailsDesc' });
    });

    doc.querySelectorAll(MD_ROOT).forEach(function (root) {
      if (inExcludedContext(root)) return;
      var blocks = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,td,th');
      blocks.forEach(function (el) {
        if (el.closest('pre')) return;
        if (el.querySelector('pre')) return;
        // Table cells are skipped: their translation would have to live inside
        // the cell, and hiding the cell would hide the translation too.
        if (el.tagName === 'TD' || el.tagName === 'TH') return;
        if (el.tagName !== 'LI' && el.querySelector('img') && !normalize(el.textContent)) return;
        var kind = el.tagName === 'LI' ? 'mdItem' : 'mdBlock';
        found.push({ el: el, kind: kind });
      });
    });

    return found;
  }

  // Text of a unit, without our own translation nodes and without nested list
  // content (a parent <li> must not absorb the text of its sub-items).
  function elementText(el) {
    if (!el.querySelector('.whtr-tr,ul,ol')) return normalize(el.textContent);
    var clone = el.cloneNode(true);
    var junk = clone.querySelectorAll('.whtr-tr,ul,ol');
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
    return normalize(clone.textContent);
  }

  function registerUnit(el, kind) {
    var unit = state.units.get(el);
    var text = elementText(el);
    if (unit) {
      if (unit.text === text) return unit;
      if (unit.node && unit.node.parentNode) unit.node.parentNode.removeChild(unit.node);
      unit.el.removeAttribute('data-whtr-orig');
      state.registry.delete(unit);
    }
    unit = {
      el: el,
      kind: kind,
      text: text,
      key: keyFor(text),
      node: null,
      // A list item with sub-items is never hidden: hiding it would hide the
      // nested list as well (the sub-items are translated on their own).
      hasNestedList: kind === 'mdItem' && !!el.querySelector('ul,ol'),
    };
    state.units.set(el, unit);
    state.registry.add(unit);
    return unit;
  }

  function scheduleScan(delay) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scan, delay === undefined ? 180 : delay);
  }

  function scan() {
    if (!state.enabled) return;
    var candidates = collectCandidates();
    var changed = false;

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var el = candidate.el;
      if (!el.isConnected) continue;
      if (inExcludedContext(el)) continue;
      var unit = registerUnit(el, candidate.kind);
      if (!unit) continue;

      var cached = state.dict.get(unit.key);
      if (cached) {
        if (!unit.node) {
          renderUnit(unit, cached);
          changed = true;
        } else if (unit.node.textContent !== cached) {
          unit.node.textContent = cached;
        }
        continue;
      }
      if (isSkippableText(unit.text)) continue;
      if (state.mode !== 'original') enqueue(unit);
    }

    state.registry.forEach(function (unit) {
      if (!unit.el.isConnected) {
        if (unit.node && unit.node.parentNode) unit.node.parentNode.removeChild(unit.node);
        state.registry.delete(unit);
        state.units.delete(unit.el);
      }
    });

    if (changed) applyMode();
    updateStatus();
  }

  function removeStrayBefore(anchor, keep) {
    if (!anchor || !anchor.parentNode) return;
    var sibling = anchor.previousElementSibling;
    while (sibling && sibling.classList && sibling.classList.contains('whtr-tr')) {
      var previous = sibling.previousElementSibling;
      if (sibling !== keep) sibling.parentNode.removeChild(sibling);
      sibling = previous;
    }
  }

  function removeStrayChildren(el, keep) {
    var nodes = el.querySelectorAll(':scope > .whtr-tr');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== keep) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  function renderUnit(unit, translation) {
    state.applying = true;
    try {
      var isListItem = unit.kind === 'mdItem' && unit.el.tagName === 'LI';
      var node = unit.node;
      if (!node) {
        // The translation is always a NEW sibling element. Never wrap, move or
        // remove nodes that React owns: React keeps references to its own
        // children and calls insertBefore() with them, which fails with
        // "The node before which the new node is to be inserted is not a child
        // of this node" once a child has been moved into a wrapper.
        node = doc.createElement(isListItem ? 'li' : 'span');
        node.className =
          'whtr-tr' +
          (isListItem ? ' whtr-li' : '') +
          (state.style.border === false ? ' whtr-no-border' : '');
        node.setAttribute('data-whtr-tr', '1');
        node.setAttribute('data-whtr-key', unit.key);
        unit.node = node;
      }
      if (node.textContent !== translation) node.textContent = translation;

      unit.isMarkdown = unit.kind === 'mdBlock' || unit.kind === 'mdItem';
      unit.el.setAttribute('data-whtr-orig', '1');

      var target = findAnchor(unit.el, unit.kind);
      removeStrayBefore(target, node);
      if (!node.parentNode && target && target.parentNode) {
        target.parentNode.insertBefore(node, target);
      }
      syncTypography(unit);
    } catch (e) {
      log('render failed: ' + e.message);
    } finally {
      state.applying = false;
    }
  }

  function enqueue(unit) {
    if (!state.enabled) return;
    if (unit.queued) return;
    unit.queued = true;
    state.queue.push(unit);
    pump();
  }

  function pump() {
    while (state.active < state.concurrency && state.queue.length) {
      var unit = state.queue.shift();
      if (!unit || !unit.el.isConnected) {
        if (unit) unit.queued = false;
        continue;
      }
      state.active++;
      translateUnit(unit);
    }
    updateStatus();
  }

  function translateUnit(unit) {
    var text = unit.text;
    translateText(text)
      .then(function (result) {
        state.active--;
        unit.queued = false;
        state.translatedCount++;
        state.failedCount = 0;
        state.dict.set(unit.key, result.text);
        if (!result.fromServer) queueStore(text, result.text, result.provider);
        if (unit.el.isConnected) {
          renderUnit(unit, result.text);
          applyMode();
        }
        scheduleScan(400);
      })
      .catch(function (error) {
        state.active--;
        unit.queued = false;
        state.failedCount++;
        state.lastError = error.message;
        log('translate failed for "' + text.slice(0, 60) + '": ' + error.message);
        updateStatus();
      })
      .then(function () {
        pump();
        updateStatus();
      });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function startObserver() {
    var observer = new MutationObserver(function (mutations) {
      if (state.applying) return;
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (isOurNode(mutation.target)) continue;
        var added = mutation.addedNodes;
        var relevant = false;
        for (var j = 0; j < added.length; j++) {
          if (!isOurNode(added[j])) {
            relevant = true;
            break;
          }
        }
        if (relevant || mutation.type === 'characterData') {
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  }

  function setTarget(target) {
    if (!target || target === state.target) return;
    state.target = target;
    state.dict = new Map();
    state.registry.forEach(function (unit) {
      if (unit.node && unit.node.parentNode) unit.node.parentNode.removeChild(unit.node);
      unit.node = null;
      unit.queued = false;
      unit.el.removeAttribute('data-whtr-orig');
      unit.el.removeAttribute('data-whtr-hide');
    });
    state.registry = new Set();
    state.units = new WeakMap();
    pushSettings();
    if (state.apiBase) {
      loadRemoteState().then(function () {
        scheduleScan(0);
      });
    } else {
      scheduleScan(0);
    }
    updateStatus();
  }

  function boot() {
    var storedMode = readLocal('mode');
    var storedTarget = readLocal('target');
    var storedCollapsed = readLocal('collapsed');
    if (MODES.indexOf(storedMode) !== -1) state.mode = storedMode;
    if (storedTarget) state.target = storedTarget;
    if (storedCollapsed !== null) state.collapsed = storedCollapsed !== '0';

    installStyles();
    buildToolbar();
    applyStyleVars();
    applyMode();
    updateStatus();
    startObserver();

    probeApi().then(function (online) {
      log('api ' + (online ? 'online: ' + state.apiBase : 'offline'));
      if (online) {
        apiFetch('/hello', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: VERSION, mode: state.mode, target: state.target }),
        }).catch(function () {});
        return loadRemoteState().then(function () {
          applyMode();
          updateStatus();
          refreshProviderConfig();
          scheduleScan(0);
        });
      }
      scheduleScan(0);
    });

    scheduleScan(300);

    window.addEventListener('beforeunload', function () {
      flushStore();
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
