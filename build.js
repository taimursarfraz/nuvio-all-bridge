#!/usr/bin/env node
'use strict';

/**
 * build.js — runs at deploy time (Railway build step)
 *
 * Downloads every provider JS file from its source GitHub repo
 * and saves it locally under providers/.
 * Also writes providers/manifest.json listing all loaded providers.
 *
 * After this runs, index.js reads everything from disk — no GitHub
 * dependency at runtime.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PROVIDERS_DIR = path.join(__dirname, 'providers');
const LIST_FILE     = path.join(__dirname, 'provider-list.json');

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
        return httpGet(res.headers.location, timeoutMs).then(resolve, reject);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end',  () => resolve(Buffer.concat(buf).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔨  Nuvio Mega Bridge — Build Step');
  console.log('  Downloading provider files from GitHub...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Load provider list
  const providerList = JSON.parse(fs.readFileSync(LIST_FILE, 'utf-8'));
  console.log(`  📋  ${providerList.length} providers to download\n`);

  // Ensure providers directory exists
  if (!fs.existsSync(PROVIDERS_DIR)) fs.mkdirSync(PROVIDERS_DIR, { recursive: true });

  const successful = [];
  const failed     = [];

  // Download in batches of 8
  for (let i = 0; i < providerList.length; i += 8) {
    const batch = providerList.slice(i, i + 8);
    await Promise.all(batch.map(async (entry) => {
      // Build the raw GitHub URL for this provider's JS file
      const url      = `${entry._base}/${entry.filename}`;
      // Use just the basename so all files sit flat in providers/
      const basename = path.basename(entry.filename);
      const dest     = path.join(PROVIDERS_DIR, basename);

      try {
        const code = await httpGet(url);
        fs.writeFileSync(dest, code, 'utf-8');
        successful.push({ ...entry, _localFile: basename });
        console.log(`  ✅  ${entry.name.padEnd(26)} ← ${entry._repo}`);
      } catch (e) {
        failed.push({ name: entry.name, error: e.message });
        console.error(`  ❌  ${entry.name.padEnd(26)} ${e.message}`);
      }
    }));
  }

  // Write the runtime manifest (only successfully downloaded providers)
  const runtimeManifest = successful.map(e => ({
    id            : e.id,
    name          : e.name,
    filename      : path.basename(e.filename), // just the basename, no subdir
    supportedTypes: e.supportedTypes || ['movie', 'tv'],
    enabled       : true,
    _repo         : e._repo,
  }));

  fs.writeFileSync(
    path.join(PROVIDERS_DIR, 'manifest.json'),
    JSON.stringify(runtimeManifest, null, 2),
    'utf-8'
  );

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅  ${successful.length} providers downloaded successfully`);
  if (failed.length > 0) {
    console.log(`  ⚠️   ${failed.length} failed: ${failed.map(f => f.name).join(', ')}`);
  }
  console.log('  📄  providers/manifest.json written');
  console.log('  🚀  Ready to start — run: node index.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Exit with error if nothing downloaded at all
  if (successful.length === 0) {
    console.error('❌  No providers downloaded — cannot start');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Build failed:', e.message);
  process.exit(1);
});
