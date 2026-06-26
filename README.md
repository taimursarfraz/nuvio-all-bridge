# Nuvio Mega Bridge v2 — Local Edition

82 providers from 6 repos, all bundled locally at deploy time. No GitHub dependency at runtime.

## What changed from v1

| | v1 (remote) | v2 (local) |
|---|---|---|
| Provider source | Fetched from GitHub on every startup | Downloaded once at build time |
| Startup time | 30–60 seconds | **~2 seconds** |
| Reliability | Breaks if any GitHub repo goes down | **Always works** |
| Updates | Auto (could break unexpectedly) | Manual (you control it) |
| Railway cold start | Very slow | **Fast** |

## Repos included

| Priority | Repo | Author |
|---|---|---|
| 1 | All-in-One-Nuvio | D3adlyRocket |
| 2 | Asura Synthesis | PirateZoro9 |
| 3 | Yoru's Repo | yoruix |
| 4 | Phisher's Repo | phisher98 |
| 5 | Michat88 Repo | michat88 |
| 6 | Ray's Plugins | hihihihihiiray |

## Deploy to Railway

### 1. Push to GitHub

Create a new repo and push these files:
```
index.js
build.js
package.json
provider-list.json
.gitignore
README.md
```

**Do not push the `providers/` folder** — it's in `.gitignore` and gets created by the build step.

### 2. Configure Railway build command

In Railway → your service → **Settings → Build**:
- **Build Command:** `npm run build`
- **Start Command:** `npm start`

Railway will run `node build.js` first (downloads all 82 provider files), then `node index.js`.

### 3. Add to Stremio

```
https://your-app.up.railway.app/manifest.json
```

## Updating providers

When upstream repos push fixes, to update:
1. Redeploy on Railway (triggers `npm run build` again → re-downloads all providers)
2. Or manually: `node build.js` locally, commit the updated `providers/*.js` files

## Cache stats

Visit `/cache` on your deployment to see live cache stats:
```
https://your-app.up.railway.app/cache
```

Shows hit rate, entries, TTL remaining per title.

## Cache settings

In `index.js`:
- `STREAM_CACHE_TTL_MS` — how long stream results are cached (default: 24h)
- `STREAM_CACHE_MAX` — max cached entries before eviction (default: 500)
