import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { Dialogs } from '@wailsio/runtime'
import * as AppService from '../bindings/github.com/pashaie/yt-feed/internal/services/appservice'
import type {
  Channel,
  CommentItem,
  FeedFilter,
  FeedItem,
  ImportResult,
  ProxyConfig,
  ProxyMode,
  VideoFlags,
} from './types'
import {
  IconArchive,
  IconChat,
  IconClock,
  IconEye,
  IconEyeOff,
  IconHeart,
  IconPanel,
  IconPanelClose,
  IconPlay,
  IconTrash,
} from './icons'
import './App.css'

const FILTERS: Array<{ id: FeedFilter; label: string }> = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'streams', label: 'Streams' },
  { id: 'videos', label: 'Videos' },
  { id: 'later', label: 'Watch later' },
  { id: 'liked', label: 'Liked' },
  { id: 'archived', label: 'Archive' },
]

const AUTO_REFRESH_MS = 30_000

function formatWhen(ms: number, label: string): string {
  if (label && /ago|Streamed|Live/i.test(label)) {
    return label.replace(/^Streamed\s+/i, '')
  }
  if (!ms && !label) return ''
  const d = ms ? new Date(ms) : new Date(label)
  if (Number.isNaN(d.getTime())) return label
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${Math.max(mins, 0)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  if (days < 730) return `${Math.floor(days / 30)}mo ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCount(n: number | null | undefined): string {
  if (!n || n <= 0) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const v = n / 1000
    return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '')}K`
  }
  const v = n / 1_000_000
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.0$/, '')}M`
}

function applyFlags(item: FeedItem, flags: VideoFlags): FeedItem {
  return { ...item, ...flags }
}

function thumbSrc(item: Pick<FeedItem, 'videoId' | 'thumbnail' | 'thumbnailLocal'>): string {
  if (item.thumbnailLocal) {
    return `/thumbs/${item.videoId}.jpg`
  }
  return item.thumbnail
}

function asFeed(items: Awaited<ReturnType<typeof AppService.ListFeed>>): FeedItem[] {
  return items as unknown as FeedItem[]
}

function asChannels(list: Awaited<ReturnType<typeof AppService.ListChannels>>): Channel[] {
  return list as unknown as Channel[]
}

function filterItems(
  items: FeedItem[],
  filter: FeedFilter,
  channelId: string | null,
): FeedItem[] {
  let list = channelId ? items.filter((i) => i.channelId === channelId) : items

  switch (filter) {
    case 'unwatched':
      return list.filter((i) => !i.isRead && !i.isArchived && !i.isHidden)
    case 'liked':
      return list.filter((i) => i.isLiked)
    case 'later':
      return list.filter((i) => i.isLater && !i.isHidden)
    case 'archived':
      return list.filter((i) => i.isArchived)
    case 'streams':
      return list.filter((i) => (i.isStream || i.isLive) && !i.isArchived && !i.isHidden)
    case 'videos':
      return list.filter((i) => !i.isStream && !i.isLive && !i.isArchived && !i.isHidden)
    case 'subscriptions':
    default:
      return list.filter((i) => !i.isArchived && !i.isHidden)
  }
}

function App() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [palette, setPalette] = useState<string[]>([])
  const [items, setItems] = useState<FeedItem[]>([])
  const [filter, setFilter] = useState<FeedFilter>('subscriptions')
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [channelInput, setChannelInput] = useState('')
  const [bulkText, setBulkText] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [autoProgress, setAutoProgress] = useState(0)
  const [autoEnabled, setAutoEnabled] = useState(true)
  const [commentsFor, setCommentsFor] = useState<FeedItem | null>(null)
  const [comments, setComments] = useState<CommentItem[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showProxy, setShowProxy] = useState(false)
  const [proxy, setProxy] = useState<ProxyConfig>({ mode: 'system', url: '' })
  const [proxyDraftUrl, setProxyDraftUrl] = useState('')

  const refreshInFlight = useRef(false)
  const cycleStartedAt = useRef(Date.now())

  const loadChannels = useCallback(async () => {
    const [list, colors] = await Promise.all([
      AppService.ListChannels(),
      AppService.ListPalette(),
    ])
    setChannels(asChannels(list))
    setPalette(colors)
  }, [])

  const loadFeedCached = useCallback(async () => {
    const feed = asFeed(await AppService.ListFeed())
    setItems(feed)
    if (feed.length) setLastUpdatedAt(Date.now())
    return feed
  }, [])

  const loadProxy = useCallback(async () => {
    const cfg = await AppService.GetProxyConfig()
    const next: ProxyConfig = {
      mode: (cfg.mode || 'system') as ProxyMode,
      url: cfg.url || '',
    }
    setProxy(next)
    setProxyDraftUrl(next.url)
  }, [])

  const refreshFeed = useCallback(async (showBusy = false) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    if (showBusy) setBusy(true)
    else setRefreshing(true)
    setError(null)
    try {
      const feed = asFeed(await AppService.RefreshFeed())
      setItems(feed)
      setLastUpdatedAt(Date.now())
      cycleStartedAt.current = Date.now()
      setAutoProgress(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setRefreshing(false)
      refreshInFlight.current = false
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        await loadProxy()
        await loadChannels()
        const cached = await loadFeedCached()
        await refreshFeed(cached.length === 0)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [loadChannels, loadFeedCached, loadProxy, refreshFeed])

  // Auto-refresh countdown + soft poll every 30s while focused.
  useEffect(() => {
    if (!autoEnabled) {
      setAutoProgress(0)
      return
    }

    const tick = window.setInterval(() => {
      if (document.hidden) return
      const elapsed = Date.now() - cycleStartedAt.current
      const progress = Math.min(1, elapsed / AUTO_REFRESH_MS)
      setAutoProgress(progress)
      if (elapsed >= AUTO_REFRESH_MS) {
        cycleStartedAt.current = Date.now()
        setAutoProgress(0)
        void refreshFeed(false)
      }
    }, 200)

    const onVisibility = () => {
      if (!document.hidden) {
        // Resume cleanly after returning to the window.
        cycleStartedAt.current = Date.now()
        setAutoProgress(0)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [autoEnabled, refreshFeed])

  const visibleItems = useMemo(
    () => filterItems(items, filter, selectedChannelId),
    [items, filter, selectedChannelId],
  )

  const updatedLabel = useMemo(() => {
    if (refreshing) return 'Updating feed…'
    if (!lastUpdatedAt) return 'Waiting for first update'
    const sec = Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000))
    if (sec < 5) return 'Updated just now'
    if (sec < 60) return `Updated ${sec}s ago`
    return `Updated ${Math.floor(sec / 60)}m ago`
  }, [lastUpdatedAt, refreshing, autoProgress])

  async function onAddChannel(e: FormEvent) {
    e.preventDefault()
    if (!channelInput.trim()) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await AppService.AddChannel(channelInput.trim())
      setChannelInput('')
      setStatus('Channel added')
      await loadChannels()
      await refreshFeed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onImportLines() {
    if (!bulkText.trim()) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const result = (await AppService.ImportChannels(bulkText)) as unknown as ImportResult
      setStatus(
        `Imported ${result.added}/${result.total}` +
          (result.failed ? ` (${result.failed} failed)` : ''),
      )
      if (result.failed) {
        setError(
          result.results
            .filter((r) => !r.ok)
            .map((r) => `${r.input}: ${r.error}`)
            .join('\n'),
        )
      }
      setBulkText('')
      setShowImport(false)
      await loadChannels()
      await refreshFeed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRemoveChannel(ch: Channel) {
    const choice = await Dialogs.Question({
      Title: 'Remove channel?',
      Message: `Remove “${ch.title}”? This channel will be removed from your feed list.`,
      Buttons: [{ Label: 'Remove' }, { Label: 'Cancel', IsCancel: true }],
    })
    if (choice !== 'Remove') return

    setBusy(true)
    setError(null)
    try {
      await AppService.RemoveChannel(ch.id)
      if (selectedChannelId === ch.id) setSelectedChannelId(null)
      await loadChannels()
      await refreshFeed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onColor(id: string, color: string) {
    await AppService.SetChannelColor(id, color)
    await loadChannels()
    setItems((prev) =>
      prev.map((item) => (item.channelId === id ? { ...item, channelColor: color } : item)),
    )
  }

  async function onOpen(item: FeedItem) {
    try {
      await AppService.OpenVideo({
        url: item.url,
        videoId: item.videoId,
        channelId: item.channelId,
        title: item.title,
        thumbnail: item.thumbnail,
        publishedMs: item.publishedMs,
        isLive: item.isLive,
        markRead: true,
      })
      setItems((prev) =>
        prev.map((v) => (v.videoId === item.videoId ? { ...v, isRead: true } : v)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function toggleFlag(item: FeedItem, key: keyof VideoFlags, ev?: MouseEvent) {
    ev?.stopPropagation()
    ev?.preventDefault()
    const next = !item[key]
    try {
      const payload = {
        videoId: item.videoId,
        channelId: item.channelId,
        title: item.title,
        thumbnail: item.thumbnail,
        url: item.url,
        publishedMs: item.publishedMs,
        isLive: item.isLive,
        isRead: undefined as boolean | undefined,
        isLiked: undefined as boolean | undefined,
        isLater: undefined as boolean | undefined,
        isArchived: undefined as boolean | undefined,
        isHidden: undefined as boolean | undefined,
      }
      payload[key] = next
      const flags = (await AppService.SetVideoFlags(payload)) as VideoFlags

      setItems((prev) =>
        prev.map((v) => (v.videoId === item.videoId ? applyFlags(v, flags) : v)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openComments(item: FeedItem, ev?: MouseEvent) {
    ev?.stopPropagation()
    ev?.preventDefault()
    setCommentsFor(item)
    setComments([])
    setCommentsError(null)
    setCommentsLoading(true)
    try {
      const list = (await AppService.GetComments({
        videoId: item.videoId,
        limit: 30,
      })) as CommentItem[]
      setComments(list)
    } catch (err) {
      setCommentsError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommentsLoading(false)
    }
  }

  async function onExportData() {
    setStatus(null)
    setError(null)
    try {
      const path = await Dialogs.SaveFile({
        Title: 'Export data',
        Filename: 'yt-feed-export.json',
        Filters: [{ DisplayName: 'JSON', Pattern: '*.json' }],
      })
      if (!path) return
      const res = await AppService.WriteExportData(String(path))
      if (res.ok) setStatus(`Exported to ${res.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onExportChannels() {
    setStatus(null)
    setError(null)
    try {
      const path = await Dialogs.SaveFile({
        Title: 'Export channels',
        Filename: 'yt-feed-channels.txt',
        Filters: [{ DisplayName: 'Text', Pattern: '*.txt' }],
      })
      if (!path) return
      const res = await AppService.WriteExportChannelsText(String(path))
      if (res.ok) setStatus(`Exported ${res.count} channels to ${res.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onImportData() {
    setStatus(null)
    setError(null)
    setBusy(true)
    try {
      const path = await Dialogs.OpenFile({
        Title: 'Import data',
        Filters: [{ DisplayName: 'JSON', Pattern: '*.json' }],
      })
      if (!path) return
      const filePath = Array.isArray(path) ? path[0] : path
      if (!filePath) return
      const res = await AppService.ImportDataFromPath(String(filePath))
      if (res.ok) {
        setStatus(`Imported ${res.channels} channels, ${res.videoStates} video states`)
        await loadChannels()
        await refreshFeed(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveProxy(mode: ProxyMode, url = proxyDraftUrl) {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await AppService.SetProxyConfig({ mode: mode as never, url: url.trim() })
      const next = { mode, url: url.trim() }
      setProxy(next)
      setProxyDraftUrl(next.url)
      setStatus(
        mode === 'off'
          ? 'Proxy disabled'
          : mode === 'system'
            ? 'Using system proxy'
            : `Custom proxy: ${next.url}`,
      )
      await refreshFeed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`app ${commentsFor ? 'with-comments' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
    >
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="sidebar-title">
            <h1>YT Feed</h1>
            <p>Subscriptions-style local feed</p>
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            {sidebarCollapsed ? <IconPanel size={18} /> : <IconPanelClose size={18} />}
          </button>
        </header>

        <form className="add-form" onSubmit={onAddChannel}>
          <input
            value={channelInput}
            onChange={(e) => setChannelInput(e.target.value)}
            placeholder="@handle, URL, or UC…"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !channelInput.trim()}>
            Add
          </button>
        </form>

        <div className="sidebar-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => setShowImport((v) => !v)}
            disabled={busy}
          >
            {showImport ? 'Hide import' : 'Bulk import'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void refreshFeed(items.length === 0)}
            disabled={busy || refreshing}
          >
            {refreshing ? 'Updating…' : 'Refresh'}
          </button>
        </div>

        <div className="sidebar-actions wrap">
          <button type="button" className="ghost" onClick={() => void onExportData()} disabled={busy}>
            Export data
          </button>
          <button type="button" className="ghost" onClick={() => void onExportChannels()} disabled={busy}>
            Export channels
          </button>
          <button type="button" className="ghost" onClick={() => void onImportData()} disabled={busy}>
            Import data
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setShowProxy((v) => !v)}
            disabled={busy}
          >
            {showProxy ? 'Hide proxy' : `Proxy (${proxy.mode})`}
          </button>
        </div>

        {showProxy && (
          <div className="proxy-panel">
            <div className="proxy-modes" role="radiogroup" aria-label="Proxy mode">
              {(
                [
                  ['off', 'Off'],
                  ['system', 'System'],
                  ['custom', 'Custom'],
                ] as Array<[ProxyMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`ghost ${proxy.mode === mode ? 'active' : ''}`}
                  onClick={() => {
                    if (mode === 'custom') {
                      setProxy((p) => ({ ...p, mode }))
                      return
                    }
                    void onSaveProxy(mode)
                  }}
                  disabled={busy}
                >
                  {label}
                </button>
              ))}
            </div>
            {proxy.mode === 'custom' && (
              <div className="proxy-custom">
                <input
                  value={proxyDraftUrl}
                  onChange={(e) => setProxyDraftUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  disabled={busy}
                />
                <button
                  type="button"
                  onClick={() => void onSaveProxy('custom', proxyDraftUrl)}
                  disabled={busy || !proxyDraftUrl.trim()}
                >
                  Apply
                </button>
              </div>
            )}
          </div>
        )}

        {showImport && (
          <div className="bulk">
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'One channel per line\n@veritasium\nhttps://www.youtube.com/@mkbhd'}
              rows={5}
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => void onImportLines()}
              disabled={busy || !bulkText.trim()}
            >
              Import lines
            </button>
          </div>
        )}

        <button
          type="button"
          className={`channel-row all ${selectedChannelId ? '' : 'selected'}`}
          onClick={() => setSelectedChannelId(null)}
        >
          <span className="avatar placeholder all" />
          <div className="channel-meta">
            <strong>All subscriptions</strong>
            <span>{channels.length} channels</span>
          </div>
        </button>

        <ul className="channel-list">
          {channels.length === 0 && <li className="empty">No channels yet</li>}
          {channels.map((ch) => (
            <li key={ch.id}>
              <button
                type="button"
                className={`channel-row ${selectedChannelId === ch.id ? 'selected' : ''}`}
                onClick={() => setSelectedChannelId(ch.id)}
                style={{ ['--ch' as string]: ch.color || '#888' }}
              >
                {ch.thumbnail ? (
                  <img
                    src={ch.thumbnail}
                    alt=""
                    className="avatar"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="avatar placeholder" />
                )}
                <div className="channel-meta">
                  <strong>{ch.title}</strong>
                  <span>{ch.handle || ch.id}</span>
                </div>
              </button>
              <div className="channel-tools">
                <div className="swatches" title="Channel color">
                  {palette.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`swatch ${ch.color === c ? 'on' : ''}`}
                      style={{ background: c }}
                      onClick={() => void onColor(ch.id, c)}
                      aria-label={`Set color ${c}`}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void onRemoveChannel(ch)}
                  disabled={busy}
                  title="Remove channel"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <div
          className={`auto-bar ${refreshing ? 'pulse' : ''}`}
          style={{ ['--p' as string]: String(autoEnabled ? autoProgress : 0) }}
        >
          <div className="auto-fill" />
        </div>

        <header className="main-head">
          <div>
            <h2>Latest from your channels</h2>
            <p className="sub">
              {selectedChannelId
                ? channels.find((c) => c.id === selectedChannelId)?.title || 'Channel'
                : 'All subscriptions'}
              {' · '}
              {updatedLabel}
            </p>
          </div>
          <div className="head-right">
            <label className="auto-toggle" title="Refresh feed every 30 seconds">
              <input
                type="checkbox"
                checked={autoEnabled}
                onChange={(e) => {
                  setAutoEnabled(e.target.checked)
                  cycleStartedAt.current = Date.now()
                  setAutoProgress(0)
                }}
              />
              Auto 30s
            </label>
            <span className="count">
              {busy ? 'Loading…' : `${visibleItems.length} item${visibleItems.length === 1 ? '' : 's'}`}
            </span>
          </div>
        </header>

        <div className="filters" role="tablist">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={filter === id ? 'active' : ''}
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {status && <div className="banner ok">{status}</div>}
        {error && <div className="banner err">{error}</div>}

        <div className="feed">
          {visibleItems.length === 0 && !busy && (
            <div className="feed-empty">
              {channels.length === 0
                ? 'Add YouTube channels to build your subscriptions feed.'
                : 'Nothing here for this filter.'}
            </div>
          )}

          {visibleItems.map((item) => (
            <article
              key={item.videoId}
              className={`feed-card ${item.isRead ? 'watched' : 'unwatched'}`}
              style={{ ['--ch' as string]: item.channelColor }}
            >
              <button type="button" className="card-hit" onClick={() => void onOpen(item)}>
                <div className="thumb-wrap">
                  <img src={thumbSrc(item)} alt="" referrerPolicy="no-referrer" />
                  {item.isLive && <span className="live-badge">LIVE</span>}
                  {!item.isLive && item.isStream && <span className="stream-badge">STREAM</span>}
                  {!item.isRead && <span className="unwatched-dot" />}
                </div>
                <div className="feed-meta">
                  <strong>{item.title}</strong>
                  <span className="channel-name">
                    <i className="ch-dot" />
                    {item.channelTitle}
                  </span>
                  <span className="stats-row">
                    <span className="when">
                      {item.isLive ? 'Streaming now' : formatWhen(item.publishedMs, item.publishedAt)}
                    </span>
                    {item.viewCount > 0 && (
                      <span className="stat" title="Views">
                        <IconPlay size={12} /> {formatCount(item.viewCount)}
                      </span>
                    )}
                    {item.likeCount > 0 && (
                      <span className="stat" title="Likes">
                        <IconHeart size={12} /> {formatCount(item.likeCount)}
                      </span>
                    )}
                  </span>
                </div>
              </button>

              <div className="actions">
                <button
                  type="button"
                  className={`icon-action ${item.isRead ? 'on' : ''}`}
                  title={item.isRead ? 'Mark unwatched' : 'Mark watched'}
                  onClick={(e) => void toggleFlag(item, 'isRead', e)}
                >
                  {item.isRead ? <IconEye size={15} /> : <IconEyeOff size={15} />}
                </button>
                <button
                  type="button"
                  className={`icon-action ${item.isLiked ? 'on' : ''}`}
                  title={item.isLiked ? 'Unlike' : 'Like'}
                  onClick={(e) => void toggleFlag(item, 'isLiked', e)}
                >
                  <IconHeart size={15} />
                </button>
                <button
                  type="button"
                  className={`icon-action ${item.isLater ? 'on' : ''}`}
                  title={item.isLater ? 'Remove from watch later' : 'Watch later'}
                  onClick={(e) => void toggleFlag(item, 'isLater', e)}
                >
                  <IconClock size={15} />
                </button>
                <button
                  type="button"
                  className="icon-action"
                  title="Comments"
                  onClick={(e) => void openComments(item, e)}
                >
                  <IconChat size={15} />
                </button>
                <button
                  type="button"
                  className={`icon-action ${item.isArchived ? 'on' : ''}`}
                  title={item.isArchived ? 'Unarchive' : 'Archive'}
                  onClick={(e) => void toggleFlag(item, 'isArchived', e)}
                >
                  <IconArchive size={15} />
                </button>
                <button
                  type="button"
                  className="icon-action danger"
                  title="Remove from feed"
                  onClick={(e) => void toggleFlag(item, 'isHidden', e)}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </main>

      {commentsFor && (
        <aside className="comments-panel" aria-label="Comments">
          <header className="comments-head">
            <div>
              <h3>Comments</h3>
              <p>{commentsFor.title}</p>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setCommentsFor(null)
                setComments([])
                setCommentsError(null)
              }}
            >
              Close
            </button>
          </header>

          {commentsLoading && <div className="comments-status">Loading comments…</div>}
          {commentsError && <div className="banner err">{commentsError}</div>}
          {!commentsLoading && !commentsError && comments.length === 0 && (
            <div className="comments-status">No comments loaded.</div>
          )}

          <ul className="comments-list">
            {comments.map((c) => (
              <li key={c.id} className="comment">
                <strong>{c.author}</strong>
                <p>{c.text}</p>
                <span className="comment-meta">
                  {c.published}
                  {c.likes ? ` · ♥ ${c.likes}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  )
}

export default App
