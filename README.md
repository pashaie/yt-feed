# YT Feed

Desktop YouTube subscriptions feed for Windows — a [Wails v3](https://v3.wails.io) app (Go + WebView2) with a React UI.

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
- **Proxy:** Off / System (Windows) / Custom URL — all YouTube HTTP runs in Go

## Download

Grab the latest Windows build from [Releases](https://github.com/pashaie/yt-feed/releases/latest):

1. Download `yt-feed-*-win.zip`
2. Extract the archive
3. Run `yt-feed.exe`

Requires **Windows 10/11** with the [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) runtime (preinstalled on Windows 11).

Data lives under `%LOCALAPPDATA%\YT Feed\` (`data\channels.db`, `cache\thumbs\`, `data\settings.json`).

## Develop

```bash
# Go 1.26+ and wails3 CLI
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0

# Frontend deps
cd frontend && bun install && cd ..

wails3 dev      # hot reload in the native window
wails3 build    # bin/yt-feed.exe
```

If `proxy.golang.org` is blocked, use a mirror:

```bash
set GOPROXY=https://goproxy.io,https://goproxy.cn,direct
set GOSUMDB=off
```

Project layout:

| Path | Role |
|------|------|
| `main.go` | Wails app entry, asset + thumbs server |
| `internal/` | SQLite, YouTube client, proxy HTTP, services |
| `frontend/` | React UI + generated bindings |
| `build/` | Wails packaging assets / Taskfile |
| `.github/workflows/release.yml` | Tag → GitHub Release (Windows zip) |

## Proxy

In the sidebar open **Proxy**:

| Mode | Behavior |
|------|----------|
| Off | Direct connection |
| System | Windows system / WinINET proxy (+ env vars) |
| Custom | Explicit URL, e.g. `http://127.0.0.1:7890` or `socks5://…` |

Default is **System**. Settings persist in `%LOCALAPPDATA%\YT Feed\data\settings.json`.

## Release

1. Bump `version` in `build/config.yml` and `frontend/package.json`
2. Commit, then tag and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or run **Actions → Release → Run workflow**.

## Stack

- Wails v3 / Go backend + WebView2
- React 19 + TypeScript + Vite + Bun
- SQLite (`modernc.org/sqlite`) for channels, feed cache, and video flags
- YouTube public RSS + Innertube browse (no API key)
- Proxy via `net/http` + `go-ieproxy` (system) / custom URL

## License

Private / personal use unless otherwise stated.
