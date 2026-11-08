import { useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react'
import type { Channel, FeedFilter, FeedItem, ImportResult, VideoFlags } from './types'
import './App.css'

const FILTERS: Array<{ id: FeedFilter; label: string }> = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'unread', label: 'Unread' },
  { id: 'streams', label: 'Streams' },
  { id: 'videos', label: 'Videos' },
  { id: 'later', label: 'Watch later' },
  { id: 'liked', label: 'Liked' },
  { id: 'archived', label: 'Archive' },
]

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

function applyFlags(item: FeedItem, flags: VideoFlags): FeedItem {
  return { ...item, ...flags }
}

function filterItems(
  items: FeedItem[],
  filter: FeedFilter,
  channelId: string | null,
): FeedItem[] {
  let list = channelId ? items.filter((i) => i.channelId === channelId) : items

  switch (filter) {
    case 'unread':
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

  const loadChannels = useCallback(async () => {
    const [list, colors] = await Promise.all([
      tiny.api.call('listChannels') as Promise<Channel[]>,
      tiny.api.call('listPalette') as Promise<string[]>,
    ])
    setChannels(list)
    setPalette(colors)
  }, [])

  const loadFeedCached = useCallback(async () => {
    const feed = (await tiny.api.call('listFeed')) as FeedItem[]
    setItems(feed)
    return feed
  }, [])

  const refreshFeed = useCallback(async (showBusy = false) => {
    if (showBusy) setBusy(true)
    else setRefreshing(true)
    setError(null)
    try {
      const feed = (await tiny.api.call('refreshFeed')) as FeedItem[]
      setItems(feed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        await loadChannels()
        const cached = await loadFeedCached()
        // Soft network refresh in background; only block if nothing cached.
        await refreshFeed(cached.length === 0)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [loadChannels, loadFeedCached, refreshFeed])

  const visibleItems = useMemo(
    () => filterItems(items, filter, selectedChannelId),
    [items, filter, selectedChannelId],
  )

  async function onAddChannel(e: FormEvent) {
    e.preventDefault()
    if (!channelInput.trim()) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      await tiny.api.call('addChannel', { input: channelInput.trim() })
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
      const result = (await tiny.api.call('importChannels', {
        lines: bulkText,
      })) as ImportResult
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

  async function onRemoveChannel(id: string) {
    setBusy(true)
    setError(null)
    try {
      await tiny.api.call('removeChannel', { id })
      if (selectedChannelId === id) setSelectedChannelId(null)
      await loadChannels()
      await refreshFeed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onColor(id: string, color: string) {
    await tiny.api.call('setChannelColor', { id, color })
    await loadChannels()
    setItems((prev) =>
      prev.map((item) => (item.channelId === id ? { ...item, channelColor: color } : item)),
    )
  }

  async function onOpen(item: FeedItem) {
    try {
      await tiny.api.call('openVideo', {
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
      const flags = (await tiny.api.call('setVideoFlags', {
        videoId: item.videoId,
        channelId: item.channelId,
        title: item.title,
        thumbnail: item.thumbnail,
        url: item.url,
        publishedMs: item.publishedMs,
        isLive: item.isLive,
        [key]: next,
      })) as VideoFlags

      setItems((prev) =>
        prev.map((v) => (v.videoId === item.videoId ? applyFlags(v, flags) : v)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onExportData() {
    setStatus(null)
    setError(null)
    try {
      const path = await tiny.dialog.saveFile({ types: ['json'] })
      if (!path) return
      const res = (await tiny.api.call('writeExportData', { path })) as {
        ok: boolean
        path?: string
      }
      if (res.ok) setStatus(`Exported to ${res.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onExportChannels() {
    setStatus(null)
    setError(null)
    try {
      const path = await tiny.dialog.saveFile({ types: ['txt'] })
      if (!path) return
      const res = (await tiny.api.call('writeExportChannelsText', { path })) as {
        ok: boolean
        path?: string
        count?: number
      }
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
      const path = await tiny.dialog.openFile({ types: ['json'] })
      if (!path) return
      const res = (await tiny.api.call('importDataFromPath', { path })) as {
        ok: boolean
        channels?: number
        videoStates?: number
      }
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

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <h1>YT Feed</h1>
          <p>Subscriptions-style local feed</p>
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
        </div>

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
                  onClick={() => void onRemoveChannel(ch.id)}
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
        <header className="main-head">
          <div>
            <h2>Latest from your channels</h2>
            <p className="sub">
              {selectedChannelId
                ? channels.find((c) => c.id === selectedChannelId)?.title || 'Channel'
                : 'All subscriptions'}
              {refreshing ? ' · updating…' : ''}
            </p>
          </div>
          <span className="count">
            {busy ? 'Loading…' : `${visibleItems.length} item${visibleItems.length === 1 ? '' : 's'}`}
          </span>
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
              className={`feed-card ${item.isRead ? 'read' : 'unread'}`}
              style={{ ['--ch' as string]: item.channelColor }}
            >
              <button type="button" className="card-hit" onClick={() => void onOpen(item)}>
                <div className="thumb-wrap">
                  <img src={item.thumbnail} alt="" referrerPolicy="no-referrer" />
                  {item.isLive && <span className="live-badge">LIVE</span>}
                  {!item.isLive && item.isStream && <span className="stream-badge">STREAM</span>}
                  {!item.isRead && <span className="unread-dot" />}
                </div>
                <div className="feed-meta">
                  <strong>{item.title}</strong>
                  <span className="channel-name">
                    <i className="ch-dot" />
                    {item.channelTitle}
                  </span>
                  <span className="when">
                    {item.isLive ? 'Streaming now' : formatWhen(item.publishedMs, item.publishedAt)}
                  </span>
                </div>
              </button>

              <div className="actions">
                <button
                  type="button"
                  className={item.isRead ? 'on' : ''}
                  title={item.isRead ? 'Mark unread' : 'Mark read'}
                  onClick={(e) => void toggleFlag(item, 'isRead', e)}
                >
                  {item.isRead ? 'Read' : 'Unread'}
                </button>
                <button
                  type="button"
                  className={item.isLiked ? 'on' : ''}
                  title="Like"
                  onClick={(e) => void toggleFlag(item, 'isLiked', e)}
                >
                  ♥
                </button>
                <button
                  type="button"
                  className={item.isLater ? 'on' : ''}
                  title="Watch later"
                  onClick={(e) => void toggleFlag(item, 'isLater', e)}
                >
                  Later
                </button>
                <button
                  type="button"
                  className={item.isArchived ? 'on' : ''}
                  title="Archive"
                  onClick={(e) => void toggleFlag(item, 'isArchived', e)}
                >
                  Arch
                </button>
                <button
                  type="button"
                  title="Remove from feed"
                  onClick={(e) => void toggleFlag(item, 'isHidden', e)}
                >
                  ✕
                </button>
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  )
}

export default App
