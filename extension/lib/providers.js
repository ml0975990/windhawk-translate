'use strict';

// Server-side translation providers. The page cannot call these directly:
// they either require an API key or do not send CORS headers, so the extension
// host performs the request and returns plain text.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const TIMEOUT_MS = 15000;

const LANG = {
  azure: { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko' },
  baidu: { 'zh-CN': 'zh', 'zh-TW': 'cht', en: 'en', ja: 'jp', ko: 'kor' },
  alibaba: { 'zh-CN': 'zh', 'zh-TW': 'zh-tw', en: 'en', ja: 'ja', ko: 'ko' },
  deepl: { 'zh-CN': 'ZH', 'zh-TW': 'ZH', en: 'EN-US', ja: 'JA', ko: 'KO' },
  google: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko' },
  mymemory: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko' },
};

function langOf(provider, target) {
  return (LANG[provider] && LANG[provider][target]) || target;
}

// The extension host runs on Electron 22 (Node 16), which has no global fetch,
// so requests go through the http/https modules directly.
function request(url, options, timeout) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = Object.assign({}, opts.headers || {});
    headers['Accept-Encoding'] = 'gzip, deflate, br';
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let buffer = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (encoding.indexOf('gzip') !== -1) buffer = zlib.gunzipSync(buffer);
            else if (encoding.indexOf('deflate') !== -1) buffer = zlib.inflateSync(buffer);
            else if (encoding.indexOf('br') !== -1) buffer = zlib.brotliDecompressSync(buffer);
          } catch (e) {}
          resolve({ status: res.statusCode, text: buffer.toString('utf8') });
        });
      }
    );
    req.setTimeout(timeout || TIMEOUT_MS, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function fetchJson(url, options, timeout) {
  const r = await request(url, options, timeout);
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch (e) {}
  return { status: r.status, text: r.text, json };
}

// --- Microsoft / Azure Translator (also powers Bing Translator) -------------
async function azure(text, target, cfg) {
  const endpoint = (cfg.endpoint || 'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': cfg.key || '',
  };
  if (cfg.region) headers['Ocp-Apim-Subscription-Region'] = cfg.region;
  const url = endpoint + '/translate?api-version=3.0&to=' + encodeURIComponent(langOf('azure', target));
  const r = await fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify([{ Text: text }]),
  });
  if (r.status !== 200) {
    const message = (r.json && r.json.error && r.json.error.message) || r.text.slice(0, 120);
    throw new Error('azure ' + r.status + ': ' + message);
  }
  const out = r.json && r.json[0] && r.json[0].translations && r.json[0].translations[0];
  if (!out || !out.text) throw new Error('azure empty response');
  return out.text;
}

// --- Baidu (fanyi-api) ------------------------------------------------------
async function baidu(text, target, cfg) {
  if (!cfg.appid || !cfg.key) throw new Error('百度翻译未配置 APPID/密钥');
  const salt = String(Date.now());
  const sign = crypto
    .createHash('md5')
    .update(cfg.appid + text + salt + cfg.key, 'utf8')
    .digest('hex');
  const url =
    'https://fanyi-api.baidu.com/api/trans/vip/translate?q=' +
    encodeURIComponent(text) +
    '&from=auto&to=' +
    encodeURIComponent(langOf('baidu', target)) +
    '&appid=' +
    encodeURIComponent(cfg.appid) +
    '&salt=' +
    salt +
    '&sign=' +
    sign;
  const r = await fetchJson(url, { method: 'GET' });
  if (r.json && r.json.error_code) {
    throw new Error('baidu ' + r.json.error_code + ': ' + (r.json.error_msg || ''));
  }
  const list = r.json && r.json.trans_result;
  if (!list || !list.length) throw new Error('baidu empty response');
  return list.map((item) => item.dst).join('\n');
}

// --- Alibaba Cloud machine translation (2018-10-12) -------------------------
function percentEncode(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '%20');
}

async function alibaba(text, target, cfg) {
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    throw new Error('阿里云翻译未配置 AccessKey ID/Secret');
  }
  const params = {
    Action: 'TranslateGeneral',
    Format: 'JSON',
    Version: '2018-10-12',
    AccessKeyId: cfg.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SourceLanguage: 'auto',
    TargetLanguage: langOf('alibaba', target),
    SourceText: text,
    Scene: 'general',
  };
  const canonical = Object.keys(params)
    .sort()
    .map((key) => percentEncode(key) + '=' + percentEncode(params[key]))
    .join('&');
  const stringToSign = 'GET&%2F&' + percentEncode(canonical);
  params.Signature = crypto
    .createHmac('sha1', cfg.accessKeySecret + '&')
    .update(stringToSign, 'utf8')
    .digest('base64');
  const query = Object.keys(params)
    .sort()
    .map((key) => percentEncode(key) + '=' + percentEncode(params[key]))
    .join('&');
  const r = await fetchJson('https://mt.cn-hangzhou.aliyuncs.com/?' + query, { method: 'GET' });
  const data = r.json && r.json.Data;
  if (!data || !data.Translated) {
    throw new Error('alibaba ' + r.status + ': ' + ((r.json && (r.json.Message || r.json.Code)) || r.text.slice(0, 100)));
  }
  return data.Translated;
}

// --- DeepL ------------------------------------------------------------------
async function deepl(text, target, cfg) {
  if (!cfg.key) throw new Error('DeepL 未配置密钥');
  const base = cfg.free === false ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  const r = await fetchJson(base + '/v2/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'DeepL-Auth-Key ' + cfg.key,
    },
    body: JSON.stringify({ text: [text], target_lang: langOf('deepl', target) }),
  });
  const out = r.json && r.json.translations && r.json.translations[0];
  if (!out || !out.text) {
    throw new Error('deepl ' + r.status + ': ' + r.text.slice(0, 100));
  }
  return out.text;
}

// --- key-less providers, used as fallbacks ----------------------------------
async function google(text, target) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(langOf('google', target)) +
    '&dt=t&q=' +
    encodeURIComponent(text);
  const r = await fetchJson(url);
  if (r.status !== 200) throw new Error('google ' + r.status);
  const json = r.json;
  if (!json || !json[0]) throw new Error('google empty');
  return json[0]
    .map((part) => (part && typeof part[0] === 'string' ? part[0] : ''))
    .join('')
    .trim();
}

async function mymemory(text, target) {
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) +
    '&langpair=en|' +
    encodeURIComponent(langOf('mymemory', target));
  const r = await fetchJson(url);
  const out = r.json && r.json.responseData && r.json.responseData.translatedText;
  if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error('mymemory failed');
  return out.trim();
}

const PROVIDERS = {
  azure: { fn: azure, label: '微软/必应' },
  baidu: { fn: baidu, label: '百度' },
  alibaba: { fn: alibaba, label: '阿里云' },
  deepl: { fn: deepl, label: 'DeepL' },
  google: { fn: google, label: 'Google' },
  mymemory: { fn: mymemory, label: 'MyMemory' },
};

/** Translate one text, trying the requested provider and then fallbacks. */
async function translate(provider, text, target, config) {
  const providers = config && config.providers ? config.providers : {};
  const order = [];
  if (provider && provider !== 'auto' && PROVIDERS[provider]) {
    // An explicitly selected provider is not silently replaced: a missing or
    // wrong key must surface as an error instead of a Google translation.
    order.push(provider);
  } else {
    if (providers.azure && providers.azure.key) order.push('azure');
    order.push('google', 'mymemory');
  }

  let lastError = null;
  for (const name of order) {
    const entry = PROVIDERS[name];
    if (!entry) continue;
    try {
      const out = await entry.fn(text, target, providers[name] || {});
      if (out && out.trim()) return { text: out.trim(), provider: name };
      lastError = new Error(name + ' empty');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('no provider available');
}

module.exports = { translate, PROVIDERS };
