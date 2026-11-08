# YT Feed

Desktop YouTube subscriptions feed for Windows — a small [tinyjs](https://tinyjs.app) app (txiki.js + WebView2) with a React UI.

Follow channels, browse the latest uploads and streams offline-friendly from a local cache, mark watched / liked / watch-later, and open videos in your browser.

## Features

- Channel list with bulk import (URLs / `@handles` / channel IDs)
- Merged feed: uploads + livestreams / past streams
- Per-channel cache of the latest **100** videos (metadata + thumbnails)
- Filters: Subscriptions, Unwatched, Streams, Videos, Watch later, Liked, Archive
- Local state: watched, like, watch later, archive, hide
- Channel colors, collapsible sidebar
- Soft auto-refresh (~30s) plus manual refresh
- On-demand top comments
- Export / import channels + video state (JSON / TXT)
- Confirm before removing a channel

## Download

Grab the latest Windows build from [Releases](https://github.com/pashaie/yt-feed/releases/latest):

1. Download `yt-feed-*-win.zip`
2. Extract the archive
3. Run `yt-feed\yt-feed.exe`

Requires **Windows 10/11** with the [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) runtime (preinstalled on Windows 11).

## Develop

```bash
# install tinyjs CLI (Windows)
irm https://tinyjs.app/install.ps1 | iex

bun install
tinyjs dev      # hot reload in the native window
tinyjs build    # dist/yt-feed.exe
tinyjs publish  # dist/publish/yt-feed-<ver>-win.zip + manifest.json
```

Project layout:

| Path | Role |
|------|------|
| `tinyjs.json` | App id, version, frontend build |
| `backend/` | SQLite, YouTube RSS / Innertube, APIs |
| `src/` | React UI |
| `.github/workflows/release.yml` | Tag → GitHub Release (Windows zip) |

## Release

1. Bump `version` in `tinyjs.json` and `package.json`
2. Commit, then tag and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or run **Actions → Release → Run workflow**. The workflow builds with tinyjs, uploads `yt-feed-<ver>-win.zip` and `manifest.json`, and creates the GitHub Release.

In-app updates resolve `manifest.json` from:

`https://github.com/pashaie/yt-feed/releases/latest/download/manifest.json`

## Stack

- [tinyjs](https://tinyjs.app) / txiki.js backend + WebView2
- React 19 + TypeScript + Vite + Bun
- SQLite (`tjs:sqlite`) for channels, feed cache, and video flags
- YouTube public RSS + Innertube browse (no API key)

## License

Private / personal use unless otherwise stated.
