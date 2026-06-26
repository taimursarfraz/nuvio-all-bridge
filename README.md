# Nuvio Mega Bridge

One Stremio addon pulling from **6 Nuvio repos** — deduplicated automatically.

## Repos included

| Priority | Repo | Author | Providers |
|---|---|---|---|
| 1 | All-in-One-Nuvio | D3adlyRocket | 58 |
| 2 | Asura Synthesis | PirateZoro9 | 13 |
| 3 | Yoru's Repo | yoruix | ~26 |
| 4 | Phisher's Repo | phisher98 | 2 |
| 5 | Michat88 Repo | michat88 | 29 |
| 6 | Ray's Plugins | hihihihihiiray | 20 |

New unique providers from Ray's repo: **AniNeko, BollyFlix, Embed69, FaselHD, FilmModu, HindMoviez, Movix, TokyoInsider, VidFast**

When the same provider appears in multiple repos, the highest-priority repo wins (order above).

---

## Deploy to Railway (you already have an account)

### 1. Push to GitHub

Create a new repo (e.g. `nuvio-mega-bridge`), upload these 3 files:
- `index.js`
- `package.json`
- `README.md`

### 2. Deploy on Railway

- Go to your Railway dashboard → **New Project** → **Deploy from GitHub repo**
- Select `nuvio-mega-bridge`
- Railway auto-detects Node and runs `npm start`
- Go to **Settings → Networking → Generate Domain**

### 3. Add to Stremio

```
https://your-app.up.railway.app/manifest.json
```

Paste that in Stremio → Add-ons → URL bar → Install. Works on iOS, Android, desktop, TV — everything.

---

## How deduplication works

1. Manifests are fetched from all 5 repos in parallel on startup
2. Providers are added in priority order — first repo to claim an ID wins
3. Lower-priority repos only contribute providers with **new IDs** not seen yet
4. All unique providers load concurrently in batches of 6
5. Provider JS files are cached in memory for 6 hours, then refreshed

---

## Zero dependencies

Uses only Node.js built-ins (`http`, `https`, `vm`, `crypto`). No `npm install` needed.
