'use strict';

/**
 * Nuvio Mega Bridge — Local Edition
 *
 * Providers are bundled locally (downloaded at build time by build.js).
 * No GitHub dependency at runtime — fast startup, always reliable.
 *
 * 82 providers from 6 repos:
 *   All-in-One-Nuvio (D3adlyRocket) · Asura Synthesis (PirateZoro9)
 *   Yoru's Repo (yoruix) · Phisher's Repo (phisher98)
 *   Michat88 Repo (michat88) · Ray's Plugins (hihihihihiiray)
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const vm    = require('vm');

const PORT           = process.env.PORT || 3000;
const PROVIDERS_DIR  = path.join(__dirname, 'providers');

const PROVIDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // reload provider JS every 6h
const STREAM_CACHE_TTL_MS   = 24 * 60 * 60 * 1000;  // cache stream results 24h
const STREAM_CACHE_MAX      = 500;

// ─── Remote Stremio addons ────────────────────────────────────────────────────
// These are fully-built Stremio addons running on external servers.
// We proxy stream requests to them and merge results with our local providers.
// Add more by appending { name, base } entries.
const REMOTE_ADDONS = [
  {
    name : 'HdHub',
    base : 'https://hdhub.thevolecitor.qzz.io/eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjIxNjBwLDEwODBwLDcyMHAiLCJzb3J0IjoiZGVzYyJ9',
    types: ['movie', 'series'],
  },
];

// ─── State ────────────────────────────────────────────────────────────────────
let providers    = null;
let stremioMeta  = null;
let lastLoad     = 0;

// ─── Stream result cache ──────────────────────────────────────────────────────
const streamCache = new Map();
let cacheStats = { hits: 0, misses: 0, evictions: 0 };

function makeCacheKey(type, id) { return `${type}::${id}`; }

function cacheGet(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (entry.promise) return entry.promise;
  if (Date.now() > entry.expiresAt) { streamCache.delete(key); return null; }
  entry.hits++;
  cacheStats.hits++;
  return entry.streams;
}

function cacheSetInflight(key, promise) { streamCache.set(key, { promise }); }

function cacheSetResult(key, streams) {
  if (streamCache.size >= STREAM_CACHE_MAX) {
    const toEvict = [...streamCache.entries()]
      .filter(([, v]) => !v.promise)
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, Math.ceil(STREAM_CACHE_MAX * 0.1));
    for (const [k] of toEvict) { streamCache.delete(k); cacheStats.evictions++; }
  }
  streamCache.set(key, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL_MS, hits: 0 });
  cacheStats.misses++;
}

function cacheClearInflight(key) {
  const e = streamCache.get(key);
  if (e?.promise) streamCache.delete(key);
}

setInterval(() => {
  const now = Date.now(); let removed = 0;
  for (const [k, v] of streamCache) {
    if (!v.promise && now > v.expiresAt) { streamCache.delete(k); removed++; }
  }
  if (removed) console.log(`🧹  Cache sweep: removed ${removed} expired, ${streamCache.size} active`);
}, 10 * 60 * 1000);

// ─── HTTP helper (used by providers at runtime) ───────────────────────────────
function httpGet(url, headers = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers, timeout: timeoutMs }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
        return httpGet(res.headers.location, headers, timeoutMs).then(resolve, reject);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      }
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end',  () => resolve(Buffer.concat(buf).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout — ${url}`)); });
    req.on('error', reject);
  });
}

function safeJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }

// ─── Module shims ─────────────────────────────────────────────────────────────
const CHEERIO_SHIM = (() => {
  const empty = () => {
    const n = () => n;
    return Object.assign(n, {
      text:()=>'', html:()=>'', attr:()=>null, val:()=>null,
      find:()=>n, first:()=>n, last:()=>n, eq:()=>n,
      filter:()=>n, children:()=>n, parent:()=>n, parents:()=>n,
      closest:()=>n, next:()=>n, prev:()=>n, siblings:()=>n,
      each:()=>n, map:()=>({get:()=>[]}), toArray:()=>[],
      is:()=>false, hasClass:()=>false, length:0, toString:()=>'',
    });
  };
  const load = () => { const $=()=>empty(); $.load=load; return $; };
  return { load };
})();

const CRYPTOJS_SHIM = (() => {
  const nc = require('crypto');
  function toBuffer(v) {
    if (!v) return Buffer.alloc(16);
    if (Buffer.isBuffer(v)) return v;
    if (typeof v === 'string') return Buffer.from(v, 'utf8');
    if (v.words) {
      const b = Buffer.alloc(v.sigBytes ?? v.words.length * 4);
      for (let i = 0; i < b.length; i++) b[i] = (v.words[i>>2] >>> (24-(i%4)*8)) & 0xff;
      return b;
    }
    return Buffer.from(String(v));
  }
  const wordResult = (buf) => {
    const words = [];
    for (let i = 0; i < buf.length; i += 4) words.push(buf.readUInt32BE(i));
    const wa = { words, sigBytes: buf.length };
    wa.toString = (e) => (e||enc.Hex).stringify(wa);
    return wa;
  };
  const enc = {
    Utf8  :{ stringify:(w)=>toBuffer(w).toString('utf8'),   parse:(s)=>wordResult(Buffer.from(s,'utf8'))   },
    Base64:{ stringify:(w)=>toBuffer(w).toString('base64'), parse:(s)=>wordResult(Buffer.from(s,'base64')) },
    Hex   :{ stringify:(w)=>toBuffer(w).toString('hex'),    parse:(s)=>wordResult(Buffer.from(s,'hex'))    },
    Latin1:{ stringify:(w)=>toBuffer(w).toString('latin1'), parse:(s)=>wordResult(Buffer.from(s,'latin1')) },
  };
  return {
    enc,
    lib:{ WordArray:{ create:(a,s)=>wordResult(Buffer.from(a??[])) } },
    AES:{
      decrypt:(cipher,key,opts={})=>{
        try {
          const k  = Buffer.concat([toBuffer(key),Buffer.alloc(32)]).slice(0,32);
          const iv = opts.iv ? toBuffer(opts.iv).slice(0,16) : Buffer.alloc(16);
          const d  = typeof cipher==='string' ? Buffer.from(cipher,'base64') : toBuffer(cipher.ciphertext??cipher);
          const dec = nc.createDecipheriv('aes-256-cbc',k,iv);
          dec.setAutoPadding(true);
          return wordResult(Buffer.concat([dec.update(d),dec.final()]));
        } catch(_){ return wordResult(Buffer.alloc(0)); }
      },
      encrypt:(msg,key,opts={})=>{ return { toString:()=>'' }; },
    },
    MD5    :(s)=>wordResult(nc.createHash('md5').update(toBuffer(s)).digest()),
    SHA256 :(s)=>wordResult(nc.createHash('sha256').update(toBuffer(s)).digest()),
    SHA1   :(s)=>wordResult(nc.createHash('sha1').update(toBuffer(s)).digest()),
    SHA512 :(s)=>wordResult(nc.createHash('sha512').update(toBuffer(s)).digest()),
    HmacMD5   :(m,k)=>wordResult(nc.createHmac('md5',   toBuffer(k)).update(toBuffer(m)).digest()),
    HmacSHA256:(m,k)=>wordResult(nc.createHmac('sha256',toBuffer(k)).update(toBuffer(m)).digest()),
    HmacSHA512:(m,k)=>wordResult(nc.createHmac('sha512',toBuffer(k)).update(toBuffer(m)).digest()),
    pad:{ Pkcs7:{}, NoPadding:{} }, mode:{ CBC:{}, ECB:{}, CTR:{} },
    RC4:{ encrypt:()=>({toString:()=>''}), decrypt:()=>wordResult(Buffer.alloc(0)) },
  };
})();

const AXIOS_SHIM = (() => {
  const request = async (config) => {
    const url    = typeof config==='string' ? config : (config?.url||'');
    const method = (config?.method||'GET').toUpperCase();
    const hdrs   = config?.headers||{};
    const tout   = config?.timeout||25000;
    if (method==='GET') {
      const text = await httpGet(url, hdrs, tout);
      return { data: safeJson(text)??text, status:200, headers:{}, statusText:'OK' };
    }
    const body = config?.data ? (typeof config.data==='string' ? config.data : JSON.stringify(config.data)) : '';
    const text = await new Promise((resolve,reject) => {
      const u = new URL(url);
      const lib = u.protocol==='https:' ? https : http;
      const req = lib.request({
        hostname:u.hostname, port:u.port||(u.protocol==='https:'?443:80),
        path:u.pathname+u.search, method,
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...hdrs},
        timeout:tout,
      }, (res) => {
        const buf=[];
        res.on('data',c=>buf.push(c));
        res.on('end',()=>resolve(Buffer.concat(buf).toString('utf-8')));
        res.on('error',reject);
      });
      req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
      req.on('error',reject);
      if (body) req.write(body);
      req.end();
    });
    return { data: safeJson(text)??text, status:200, headers:{}, statusText:'OK' };
  };
  const ax = (c)=>request(c);
  ax.get    = (url,c)=>request({url,method:'GET',...(c||{})});
  ax.post   = (url,d,c)=>request({url,method:'POST',data:d,...(c||{})});
  ax.put    = (url,d,c)=>request({url,method:'PUT',data:d,...(c||{})});
  ax.delete = (url,c)=>request({url,method:'DELETE',...(c||{})});
  ax.patch  = (url,d,c)=>request({url,method:'PATCH',data:d,...(c||{})});
  ax.create = (def)=>{
    const inst=(c)=>request({...def,...c,url:(def?.baseURL||'')+(c?.url||'')});
    return Object.assign(inst,ax,{defaults:{...ax.defaults,...def}});
  };
  ax.defaults={baseURL:'',headers:{common:{}}};
  ax.interceptors={request:{use:()=>{}},response:{use:()=>{}}};
  ax.isAxiosError=()=>false;
  ax.all=Promise.all.bind(Promise);
  ax.spread=(fn)=>(arr)=>fn(...arr);
  return ax;
})();

// ─── Load a provider from local disk into a sandboxed vm ─────────────────────
function loadProvider(filename, id) {
  const filePath = path.join(PROVIDERS_DIR, filename);
  const code     = fs.readFileSync(filePath, 'utf-8');

  const fakeRequire = (mod) => {
    const map = {
      'cheerio-without-node-native': CHEERIO_SHIM,
      'react-native-cheerio':        CHEERIO_SHIM,
      'cheerio':                     CHEERIO_SHIM,
      'crypto-js':                   CRYPTOJS_SHIM,
      'axios':                       AXIOS_SHIM,
    };
    if (map[mod]) return map[mod];
    try { return require(mod); } catch (_) {}
    return {};
  };

  const exports = {};
  const module_ = { exports };

  vm.runInContext(code, vm.createContext({
    require: fakeRequire, module: module_, exports,
    console, fetch, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer, process, URL, URLSearchParams, TextEncoder, TextDecoder,
    atob: (s)=>Buffer.from(s,'base64').toString('binary'),
    btoa: (s)=>Buffer.from(s,'binary').toString('base64'),
    global: {},
  }), { filename: `${id}.js`, timeout: 8000 });

  return module_.exports;
}

// ─── Load all providers from disk ────────────────────────────────────────────
function loadAllProviders() {
  const manifestPath = path.join(PROVIDERS_DIR, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error('❌  providers/manifest.json not found!');
    console.error('   Run:  node build.js   first');
    process.exit(1);
  }

  const list = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`\n📂  Loading ${list.length} providers from disk...\n`);

  const loaded = [];

  for (const entry of list) {
    const filename = path.basename(entry.filename);
    const filePath = path.join(PROVIDERS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️  ${entry.name}: file missing (${filename}), skipping`);
      continue;
    }

    try {
      const mod = loadProvider(filename, entry.id);
      if (typeof mod.getStreams !== 'function') {
        console.warn(`  ⚠️  ${entry.name}: no getStreams() export`);
        continue;
      }
      loaded.push({ meta: entry, getStreams: mod.getStreams });
      console.log(`  ✅  ${entry.name.padEnd(26)} [${entry._repo}]`);
    } catch (e) {
      console.error(`  ❌  ${entry.name}: ${e.message}`);
    }
  }

  console.log(`\n🎬  ${loaded.length} / ${list.length} providers loaded\n`);

  const types = [...new Set(
    loaded.flatMap(p => (p.meta.supportedTypes||['movie','tv'])
      .map(t => t==='tv'||t==='anime' ? 'series' : t)
      .filter(t => ['movie','series'].includes(t))
    )
  )];

  const meta = {
    id          : 'community.nuvio.mega.bridge',
    version     : '2.0.0',
    name        : 'Nuvio Mega Bridge',
    description : `${loaded.length} local providers + ${REMOTE_ADDONS.length} remote addon(s) — 6 repos bundled locally`,
    logo        : 'https://raw.githubusercontent.com/yoruix/nuvio-providers/main/Assets/Logo-2.png',
    resources   : ['stream'],
    types       : types.length ? types : ['movie','series'],
    idPrefixes  : ['tt','tmdb:'],
    catalogs    : [],
    behaviorHints: { configurable:false, configurationRequired:false },
  };

  return { loaded, meta };
}

// ─── Ensure providers loaded (hot-reload every 6h without restart) ────────────
function ensureProviders() {
  if (providers && (Date.now() - lastLoad) < PROVIDER_CACHE_TTL_MS) return;
  console.log('🔄  (Re)loading provider modules from disk...');
  const { loaded, meta } = loadAllProviders();
  providers   = loaded;
  stremioMeta = meta;
  lastLoad    = Date.now();
}

// ─── Parse Stremio ID ─────────────────────────────────────────────────────────
function parseId(type, id) {
  const parts = id.split(':');
  let tmdbId, season=null, episode=null;
  if (type==='series') {
    if (parts[0]==='tmdb') { tmdbId=parts[1]; season=+parts[2]; episode=+parts[3]; }
    else { tmdbId=parts[0]; season=+parts[1]; episode=+parts[2]; }
  } else {
    tmdbId = parts[0]==='tmdb' ? parts[1] : parts[0];
  }
  return { tmdbId, mediaType: type==='series'?'tv':'movie', season, episode };
}

// ─── Fetch streams from remote Stremio addons ─────────────────────────────────
async function fetchRemoteStreams(type, rawId) {
  if (!REMOTE_ADDONS.length) return [];

  const results = await Promise.allSettled(
    REMOTE_ADDONS
      .filter(a => a.types.includes(type))
      .map(async (addon) => {
        const url = `${addon.base}/stream/${type}/${encodeURIComponent(rawId)}.json`;
        try {
          const text = await httpGet(url, {}, 20000);
          const data = safeJson(text);
          const streams = (data?.streams || []).map(s => ({
            name  : s.name  || addon.name,
            title : s.title || s.description || '',
            url   : s.url,
            ...(s.behaviorHints ? { behaviorHints: s.behaviorHints } : {}),
          })).filter(s => s.url);
          console.log(`  🌐  ${addon.name}: ${streams.length} stream(s)`);
          return streams;
        } catch (e) {
          console.warn(`  ⚠️  ${addon.name}: ${e.message}`);
          return [];
        }
      })
  );

  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ─── Query providers (cached + in-flight dedup) ───────────────────────────────
async function getStreams(type, id) {
  const key    = makeCacheKey(type, id);
  const cached = cacheGet(key);

  if (cached !== null) {
    if (cached instanceof Promise) {
      console.log(`⏳  ${type}/${id} — joining in-flight scrape`);
      return cached;
    }
    console.log(`⚡  ${type}/${id} — cache hit (${streamCache.get(key)?.hits} hits)`);
    return cached;
  }

  const { tmdbId, mediaType, season, episode } = parseId(type, id);
  console.log(`🔍  ${mediaType} | ${tmdbId} | S${season??'-'}E${episode??'-'} | ${providers.length} providers`);

  const scrapePromise = (async () => {
    // Query local providers AND remote addons in parallel
    const [localResults, remoteStreams] = await Promise.all([
      Promise.allSettled(
        providers.map(p =>
          Promise.race([
            p.getStreams(tmdbId, mediaType, season, episode),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('timeout')), 25000)),
          ])
        )
      ),
      fetchRemoteStreams(type, id),
    ]);

    const streams = [];

    // Collect local provider results
    for (let i = 0; i < localResults.length; i++) {
      const r = localResults[i];
      if (r.status==='rejected') continue;
      for (const s of (r.value||[])) {
        if (!s?.url) continue;
        const stream = {
          name  : s.name  || providers[i].meta.name,
          title : [s.title, s.quality, s.size].filter(Boolean).join(' · ') || '',
          url   : s.url,
        };
        if (s.headers && Object.keys(s.headers).length) {
          stream.behaviorHints = { notWebReady:true, proxyHeaders:{ request:s.headers } };
        }
        streams.push(stream);
      }
    }

    // Append remote addon results
    streams.push(...remoteStreams);

    cacheSetResult(key, streams);
    const total   = cacheStats.hits + cacheStats.misses;
    const hitRate = total ? ((cacheStats.hits/total)*100).toFixed(1)+'%' : '0%';
    console.log(`  → ${streams.length} stream(s) | cache ${streamCache.size} entries, hit rate ${hitRate}\n`);
    return streams;
  })().catch(e => { cacheClearInflight(key); throw e; });

  cacheSetInflight(key, scrapePromise);
  return scrapePromise;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type'                :'application/json; charset=utf-8',
    'Access-Control-Allow-Origin' :'*',
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS'});
    res.end(); return;
  }

  const url = req.url.split('?')[0];

  if (url==='/') {
    res.writeHead(200,{'Content-Type':'text/plain'});
    res.end(`Nuvio Mega Bridge v2 — ${providers?.length??0} local providers + ${REMOTE_ADDONS.length} remote addon(s)\nAdd to Stremio: /manifest.json`);
    return;
  }

  if (url==='/manifest.json') {
    ensureProviders();
    json(res, 200, stremioMeta);
    return;
  }

  if (url==='/cache') {
    const now = Date.now();
    const entries = [...streamCache.entries()]
      .filter(([,v])=>!v.promise)
      .map(([k,v])=>({ key:k, hits:v.hits, expiresIn:Math.round((v.expiresAt-now)/1000)+'s' }))
      .sort((a,b)=>b.hits-a.hits);
    const total = cacheStats.hits + cacheStats.misses;
    json(res, 200, {
      summary:{
        totalEntries:streamCache.size, cacheHits:cacheStats.hits,
        cacheMisses:cacheStats.misses, evictions:cacheStats.evictions,
        hitRate: total ? ((cacheStats.hits/total)*100).toFixed(1)+'%' : '0%',
        ttlHours: STREAM_CACHE_TTL_MS/3600000, maxEntries:STREAM_CACHE_MAX,
        providersLoaded: providers?.length??0,
      },
      topEntries: entries.slice(0,20),
    });
    return;
  }

  const m = url.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
  if (m) {
    ensureProviders();
    try {
      json(res, 200, { streams: await getStreams(m[1], decodeURIComponent(m[2])) });
    } catch(e) {
      console.error('Stream error:', e.message);
      json(res, 200, { streams:[] });
    }
    return;
  }

  json(res, 404, { error:'Not found' });
});

server.listen(PORT, () => {
  ensureProviders();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅  Add to Stremio:');
  console.log('  https://<your-railway-app>.up.railway.app/manifest.json');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

server.on('error', e => {
  if (e.code==='EADDRINUSE') console.error(`❌  Port ${PORT} in use`);
  else console.error('Server error:', e);
  process.exit(1);
});
