import {
  colorForChannel,
  feedCacheAgeMs,
  flagsFromRow,
  listChannels,
  listFeedCache,
  listPalette,
  listVideoStates,
  openDb,
  removeChannel,
  replaceAllData,
  replaceFeedCache,
  setChannelColor,
  upsertChannel,
  upsertVideoMeta,
  type ChannelRow,
  type VideoStateRow,
} from './db';
import {
  fetchChannelRss,
  fetchChannelStreams,
  fetchTopComments,
  resolveChannel,
  type FeedItem as RssItem,
} from './youtube';

export type EnrichFeedItem = RssItem & {
  channelColor: string;
  isRead: boolean;
  isLiked: boolean;
  isLater: boolean;
  isArchived: boolean;
  isHidden: boolean;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
let memoryCache: { at: number; items: EnrichFeedItem[] } | null = null;
let refreshInFlight: Promise<EnrichFeedItem[]> | null = null;
let appRef: TinyApp | null = null;

async function database() {
  if (!appRef) throw new Error('App not initialized');
  return openDb(appRef.paths.data);
}

function invalidateCache() {
  memoryCache = null;
}

function channelMap(channels: ChannelRow[]) {
  const map = new Map<string, ChannelRow>();
  for (const ch of channels) map.set(ch.id, ch);
  return map;
}

function enrich(
  item: RssItem,
  channels: Map<string, ChannelRow>,
  state: VideoStateRow | null | undefined,
): EnrichFeedItem {
  const ch = channels.get(item.channelId);
  const flags = flagsFromRow(state);
  return {
    ...item,
    channelColor: colorForChannel(item.channelId, ch?.color),
    channelTitle: ch?.title || item.channelTitle,
    ...flags,
  };
}

function stateToItem(row: VideoStateRow, channels: Map<string, ChannelRow>): EnrichFeedItem {
  const ch = channels.get(row.channel_id);
  return enrich(
    {
      videoId: row.video_id,
      title: row.title,
      publishedAt: row.published_ms ? new Date(row.published_ms).toISOString() : '',
      publishedMs: row.published_ms,
      channelId: row.channel_id,
      channelTitle: ch?.title || row.channel_id,
      thumbnail: row.thumbnail || `https://i.ytimg.com/vi/${row.video_id}/hqdefault.jpg`,
      url: row.url,
      isLive: !!row.is_live,
      isStream: !!row.is_live,
      viewCount: 0,
      likeCount: 0,
    },
    channels,
    row,
  );
}

function sortFeed(items: EnrichFeedItem[]): EnrichFeedItem[] {
  return items.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return (b.publishedMs || 0) - (a.publishedMs || 0);
  });
}

function loadCachedFeed(db: Awaited<ReturnType<typeof openDb>>): EnrichFeedItem[] {
  const channels = listChannels(db);
  const byChannel = channelMap(channels);
  const states = listVideoStates(db);
  const stateById = new Map(states.map((s) => [s.video_id, s]));
  const byId = new Map<string, EnrichFeedItem>();

  for (const row of listFeedCache(db)) {
    byId.set(
      row.video_id,
      enrich(
        {
          videoId: row.video_id,
          title: row.title,
          publishedAt: row.published_at || '',
          publishedMs: row.published_ms,
          channelId: row.channel_id,
          channelTitle: byChannel.get(row.channel_id)?.title || row.channel_id,
          thumbnail: row.thumbnail || `https://i.ytimg.com/vi/${row.video_id}/hqdefault.jpg`,
          url: row.url,
          isLive: !!row.is_live,
          isStream: !!row.is_stream,
          viewCount: row.view_count || 0,
          likeCount: row.like_count || 0,
        },
        byChannel,
        stateById.get(row.video_id),
      ),
    );
  }

  for (const row of states) {
    if (byId.has(row.video_id)) continue;
    if (row.is_liked || row.is_later || row.is_archived || row.is_hidden || row.is_read) {
      byId.set(row.video_id, stateToItem(row, byChannel));
    }
  }

  return sortFeed(Array.from(byId.values()));
}

async function buildFeedFromNetwork(): Promise<EnrichFeedItem[]> {
  const db = await database();
  const channels = listChannels(db);
  const byChannel = channelMap(channels);
  const states = listVideoStates(db);
  const stateById = new Map(states.map((s) => [s.video_id, s]));
  const byId = new Map<string, EnrichFeedItem>();

  if (channels.length > 0) {
    const results = await Promise.allSettled(
      channels.map(async (ch) => {
        const [rss, streams] = await Promise.all([
          fetchChannelRss(ch.id, ch.title),
          fetchChannelStreams(ch.id, ch.title, ch.handle),
        ]);
        return { ch, rss, streams };
      }),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { rss, streams } = result.value;
      const streamIds = new Set(streams.map((s) => s.videoId));

      for (const item of rss) {
        const merged: RssItem = {
          ...item,
          isStream: streamIds.has(item.videoId),
        };
        const existingStream = streams.find((s) => s.videoId === item.videoId);
        if (existingStream?.isLive) merged.isLive = true;
        if (existingStream?.viewCount && existingStream.viewCount > (merged.viewCount || 0)) {
          merged.viewCount = existingStream.viewCount;
        }
        byId.set(item.videoId, enrich(merged, byChannel, stateById.get(item.videoId)));
      }

      for (const stream of streams) {
        const prev = byId.get(stream.videoId);
        if (prev) {
          byId.set(stream.videoId, {
            ...prev,
            isStream: true,
            isLive: prev.isLive || stream.isLive,
            title: prev.title && prev.title !== 'Stream' ? prev.title : stream.title,
            // Prefer real RSS timestamps; fall back to parsed stream label.
            publishedMs: prev.publishedMs || stream.publishedMs || 0,
            publishedAt: prev.publishedAt || stream.publishedAt || '',
            viewCount: Math.max(prev.viewCount || 0, stream.viewCount || 0),
            likeCount: Math.max(prev.likeCount || 0, stream.likeCount || 0),
          });
          continue;
        }
        byId.set(
          stream.videoId,
          enrich(stream, byChannel, stateById.get(stream.videoId)),
        );
      }
    }
  }

  for (const row of states) {
    if (byId.has(row.video_id)) continue;
    if (row.is_liked || row.is_later || row.is_archived || row.is_hidden || row.is_read) {
      byId.set(row.video_id, stateToItem(row, byChannel));
    }
  }

  const items = sortFeed(Array.from(byId.values()));
  replaceFeedCache(
    db,
    items.map((i) => ({
      videoId: i.videoId,
      channelId: i.channelId,
      title: i.title,
      thumbnail: i.thumbnail,
      url: i.url,
      publishedAt: i.publishedAt,
      publishedMs: i.publishedMs,
      isLive: i.isLive,
      isStream: i.isStream,
      viewCount: i.viewCount,
      likeCount: i.likeCount,
    })),
  );
  return items;
}

async function getFeed(force = false): Promise<EnrichFeedItem[]> {
  const db = await database();

  if (!force && memoryCache && Date.now() - memoryCache.at < CACHE_TTL_MS) {
    return memoryCache.items;
  }

  if (!force) {
    const age = feedCacheAgeMs(db);
    if (age !== null && age < CACHE_TTL_MS) {
      const cached = loadCachedFeed(db);
      memoryCache = { at: Date.now() - age, items: cached };
      return cached;
    }
    // Stale/empty disk cache: still return it instantly if present, refresh separately.
    const disk = loadCachedFeed(db);
    if (disk.length > 0) {
      memoryCache = { at: 0, items: disk };
      return disk;
    }
  }

  if (!refreshInFlight) {
    refreshInFlight = buildFeedFromNetwork()
      .then((items) => {
        memoryCache = { at: Date.now(), items };
        return items;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function addResolved(raw: string): Promise<ChannelRow> {
  const resolved = await resolveChannel(raw);
  const db = await database();
  upsertChannel(db, resolved);
  invalidateCache();
  const row = listChannels(db).find((c) => c.id === resolved.id);
  if (!row) throw new Error('Failed to save channel');
  return row;
}

async function patchVideo(
  payload: {
    videoId: string;
    channelId: string;
    title: string;
    thumbnail?: string;
    url: string;
    publishedMs?: number;
    isLive?: boolean;
  },
  patch: Partial<{
    isRead: boolean;
    isLiked: boolean;
    isLater: boolean;
    isArchived: boolean;
    isHidden: boolean;
  }>,
) {
  const db = await database();
  const row = upsertVideoMeta(
    db,
    {
      videoId: payload.videoId,
      channelId: payload.channelId,
      title: payload.title,
      thumbnail: payload.thumbnail,
      url: payload.url,
      publishedMs: payload.publishedMs,
      isLive: payload.isLive,
    },
    patch,
  );
  // Keep memory flags in sync without a network refetch.
  if (memoryCache) {
    memoryCache = {
      ...memoryCache,
      items: memoryCache.items.map((item) =>
        item.videoId === payload.videoId ? { ...item, ...flagsFromRow(row) } : item,
      ),
    };
  }
  return flagsFromRow(row);
}

function decodeBytes(data: Uint8Array | string): string {
  if (typeof data === 'string') return data;
  return new TextDecoder().decode(data);
}

export const api: Record<string, TinyApiHandler> = {
  listChannels: async () => listChannels(await database()),

  listPalette: async () => listPalette(),

  setChannelColor: async ({ id, color }: { id: string; color: string }) => {
    const ok = setChannelColor(await database(), id, color);
    if (ok && memoryCache) {
      memoryCache = {
        ...memoryCache,
        items: memoryCache.items.map((item) =>
          item.channelId === id ? { ...item, channelColor: color } : item,
        ),
      };
    }
    return { ok };
  },

  addChannel: async ({ input }: { input: string }) => {
    if (!input || !String(input).trim()) throw new Error('Channel is required');
    return addResolved(String(input));
  },

  removeChannel: async ({ id }: { id: string }) => {
    const ok = removeChannel(await database(), id);
    if (ok) invalidateCache();
    return { ok };
  },

  importChannels: async ({ lines }: { lines: string }) => {
    const rawLines = String(lines || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const results: Array<{ input: string; ok: boolean; error?: string; channel?: ChannelRow }> =
      [];

    for (const line of rawLines) {
      try {
        const channel = await addResolved(line);
        results.push({ input: line, ok: true, channel });
      } catch (err) {
        results.push({
          input: line,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      total: rawLines.length,
      added: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  },

  /** Full unfiltered feed (flags included). Filtering is done in the UI. */
  listFeed: async () => getFeed(false),

  refreshFeed: async () => getFeed(true),

  getComments: async ({ videoId, limit }: { videoId: string; limit?: number }) => {
    return fetchTopComments(videoId, limit || 30);
  },

  openVideo: async (payload: {
    url: string;
    videoId?: string;
    channelId?: string;
    title?: string;
    thumbnail?: string;
    publishedMs?: number;
    isLive?: boolean;
    markRead?: boolean;
  }) => {
    if (!payload.url || !/^https:\/\/(www\.)?youtube\.com\//i.test(payload.url)) {
      throw new Error('Only YouTube URLs are allowed');
    }
    if (!appRef) throw new Error('App not initialized');
    await appRef.shell.open(payload.url);

    if (payload.markRead !== false && payload.videoId && payload.channelId && payload.title) {
      await patchVideo(
        {
          videoId: payload.videoId,
          channelId: payload.channelId,
          title: payload.title,
          thumbnail: payload.thumbnail,
          url: payload.url,
          publishedMs: payload.publishedMs,
          isLive: payload.isLive,
        },
        { isRead: true },
      );
    }
    return { ok: true };
  },

  setVideoFlags: async (payload: {
    videoId: string;
    channelId: string;
    title: string;
    thumbnail?: string;
    url: string;
    publishedMs?: number;
    isLive?: boolean;
    isRead?: boolean;
    isLiked?: boolean;
    isLater?: boolean;
    isArchived?: boolean;
    isHidden?: boolean;
  }) => {
    return patchVideo(payload, {
      isRead: payload.isRead,
      isLiked: payload.isLiked,
      isLater: payload.isLater,
      isArchived: payload.isArchived,
      isHidden: payload.isHidden,
    });
  },

  /** Dialogs live on the page (`tiny.dialog`), not backend `app`. */
  writeExportData: async ({ path }: { path: string }) => {
    if (!path) throw new Error('Path is required');
    const db = await database();
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      channels: listChannels(db),
      videoStates: listVideoStates(db),
    };
    const out = path.toLowerCase().endsWith('.json') ? path : path + '.json';
    await tjs.writeFile(out, JSON.stringify(payload, null, 2));
    return { ok: true, path: out };
  },

  importDataFromPath: async ({ path }: { path: string }) => {
    if (!path) throw new Error('Path is required');
    const raw = decodeBytes(await tjs.readFile(path));
    const parsed = JSON.parse(raw) as {
      channels?: ChannelRow[];
      videoStates?: VideoStateRow[];
    };
    if (!Array.isArray(parsed.channels)) throw new Error('Invalid export: missing channels');
    const db = await database();
    replaceAllData(db, {
      channels: parsed.channels,
      videoStates: Array.isArray(parsed.videoStates) ? parsed.videoStates : [],
    });
    invalidateCache();
    return {
      ok: true,
      channels: parsed.channels.length,
      videoStates: Array.isArray(parsed.videoStates) ? parsed.videoStates.length : 0,
    };
  },

  writeExportChannelsText: async ({ path }: { path: string }) => {
    if (!path) throw new Error('Path is required');
    const channels = listChannels(await database());
    const text = channels
      .map((c) =>
        c.handle
          ? `https://www.youtube.com/${c.handle}`
          : `https://www.youtube.com/channel/${c.id}`,
      )
      .join('\n');
    const out = path.toLowerCase().endsWith('.txt') ? path : path + '.txt';
    await tjs.writeFile(out, text);
    return { ok: true, path: out, count: channels.length };
  },
};

export function init(app: TinyApp) {
  appRef = app;
  void openDb(app.paths.data).catch((err) => {
    console.error('Failed to open database:', err);
  });
}
