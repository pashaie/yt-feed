import { Database } from 'tjs:sqlite';

export type ChannelRow = {
  id: string;
  title: string;
  handle: string | null;
  thumbnail: string | null;
  color: string | null;
  added_at: number;
};

export type VideoStateRow = {
  video_id: string;
  channel_id: string;
  title: string;
  thumbnail: string | null;
  url: string;
  published_ms: number;
  is_live: number;
  is_read: number;
  is_liked: number;
  is_later: number;
  is_archived: number;
  is_hidden: number;
  updated_at: number;
};

export type VideoFlags = {
  isRead: boolean;
  isLiked: boolean;
  isLater: boolean;
  isArchived: boolean;
  isHidden: boolean;
};

const CHANNEL_COLORS = [
  '#e25548',
  '#0f6e8c',
  '#2f9e71',
  '#c47a1a',
  '#6b5ce7',
  '#c23d8b',
  '#3aa0c0',
  '#7a8b3a',
  '#d97706',
  '#2563eb',
];

let db: Database | null = null;
let opening: Promise<Database> | null = null;

function hasColumn(database: Database, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function migrate(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      handle TEXT,
      thumbnail TEXT,
      color TEXT,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS video_state (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      thumbnail TEXT,
      url TEXT NOT NULL,
      published_ms INTEGER NOT NULL DEFAULT 0,
      is_live INTEGER NOT NULL DEFAULT 0,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_liked INTEGER NOT NULL DEFAULT 0,
      is_later INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_cache (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      thumbnail TEXT,
      thumbnail_local TEXT,
      url TEXT NOT NULL,
      published_at TEXT,
      published_ms INTEGER NOT NULL DEFAULT 0,
      is_live INTEGER NOT NULL DEFAULT 0,
      is_stream INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL
    );
  `);

  if (!hasColumn(database, 'channels', 'color')) {
    database.exec('ALTER TABLE channels ADD COLUMN color TEXT');
  }
  for (const col of [
    'is_stream INTEGER NOT NULL DEFAULT 0',
    'view_count INTEGER NOT NULL DEFAULT 0',
    'like_count INTEGER NOT NULL DEFAULT 0',
    'thumbnail_local TEXT',
  ]) {
    const name = col.split(' ')[0];
    if (!hasColumn(database, 'feed_cache', name)) {
      try {
        database.exec(`ALTER TABLE feed_cache ADD COLUMN ${col}`);
      } catch {
        /* ignore */
      }
    }
  }
}

export type FeedCacheRow = {
  video_id: string;
  channel_id: string;
  title: string;
  thumbnail: string | null;
  thumbnail_local: string | null;
  url: string;
  published_at: string | null;
  published_ms: number;
  is_live: number;
  is_stream: number;
  view_count: number;
  like_count: number;
  fetched_at: number;
};

export function feedCacheAgeMs(database: Database): number | null {
  const rows = database
    .prepare('SELECT MAX(fetched_at) AS max_at FROM feed_cache')
    .all() as Array<{ max_at: number | null }>;
  const maxAt = rows[0]?.max_at;
  if (!maxAt) return null;
  return Date.now() - maxAt;
}

export function listFeedCache(database: Database): FeedCacheRow[] {
  return database
    .prepare(
      `SELECT video_id, channel_id, title, thumbnail, thumbnail_local, url, published_at, published_ms,
              is_live, is_stream, view_count, like_count, fetched_at
       FROM feed_cache ORDER BY published_ms DESC`,
    )
    .all() as unknown as FeedCacheRow[];
}

export function replaceFeedCache(
  database: Database,
  items: Array<{
    videoId: string;
    channelId: string;
    title: string;
    thumbnail?: string | null;
    thumbnailLocal?: string | null;
    url: string;
    publishedAt?: string;
    publishedMs: number;
    isLive?: boolean;
    isStream?: boolean;
    viewCount?: number;
    likeCount?: number;
  }>,
): void {
  const fetchedAt = Date.now();
  database.exec('DELETE FROM feed_cache');
  const stmt = database.prepare(
    `INSERT INTO feed_cache (
       video_id, channel_id, title, thumbnail, thumbnail_local, url, published_at, published_ms,
       is_live, is_stream, view_count, like_count, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    stmt.run(
      item.videoId,
      item.channelId,
      item.title,
      item.thumbnail ?? null,
      item.thumbnailLocal ?? null,
      item.url,
      item.publishedAt ?? null,
      item.publishedMs || 0,
      item.isLive ? 1 : 0,
      item.isStream ? 1 : 0,
      item.viewCount || 0,
      item.likeCount || 0,
      fetchedAt,
    );
  }
}

export function colorForChannel(id: string, explicit?: string | null): string {
  if (explicit) return explicit;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return CHANNEL_COLORS[hash % CHANNEL_COLORS.length];
}

export function listPalette(): string[] {
  return CHANNEL_COLORS.slice();
}

/** Ensure the data directory exists, then open (or reuse) the SQLite file. */
export async function openDb(dataDir: string): Promise<Database> {
  if (db) return db;
  if (!opening) {
    opening = (async () => {
      await tjs.makeDir(dataDir, { recursive: true });
      const database = new Database(dataDir + '/channels.db');
      migrate(database);
      db = database;
      return database;
    })();
  }
  try {
    return await opening;
  } catch (err) {
    opening = null;
    db = null;
    throw err;
  }
}

export function listChannels(database: Database): ChannelRow[] {
  const rows = database
    .prepare(
      'SELECT id, title, handle, thumbnail, color, added_at FROM channels ORDER BY title COLLATE NOCASE ASC',
    )
    .all() as unknown as ChannelRow[];
  return rows.map((r) => ({ ...r, color: colorForChannel(r.id, r.color) }));
}

export function getChannel(database: Database, id: string): ChannelRow | null {
  const rows = database
    .prepare('SELECT id, title, handle, thumbnail, color, added_at FROM channels WHERE id = ?')
    .all(id) as unknown as ChannelRow[];
  const row = rows[0];
  if (!row) return null;
  return { ...row, color: colorForChannel(row.id, row.color) };
}

export function upsertChannel(
  database: Database,
  channel: {
    id: string;
    title: string;
    handle?: string | null;
    thumbnail?: string | null;
    color?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO channels (id, title, handle, thumbnail, color, added_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         handle = COALESCE(excluded.handle, channels.handle),
         thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail),
         color = COALESCE(excluded.color, channels.color)`,
    )
    .run(
      channel.id,
      channel.title,
      channel.handle ?? null,
      channel.thumbnail ?? null,
      channel.color ?? colorForChannel(channel.id),
      Date.now(),
    );
}

export function setChannelColor(database: Database, id: string, color: string): boolean {
  if (!getChannel(database, id)) return false;
  database.prepare('UPDATE channels SET color = ? WHERE id = ?').run(color, id);
  return true;
}

export function removeChannel(database: Database, id: string): boolean {
  const before = getChannel(database, id);
  if (!before) return false;
  database.prepare('DELETE FROM channels WHERE id = ?').run(id);
  return true;
}

export function getVideoState(database: Database, videoId: string): VideoStateRow | null {
  const rows = database
    .prepare('SELECT * FROM video_state WHERE video_id = ?')
    .all(videoId) as unknown as VideoStateRow[];
  return rows[0] ?? null;
}

export function listVideoStates(database: Database): VideoStateRow[] {
  return database
    .prepare('SELECT * FROM video_state ORDER BY updated_at DESC')
    .all() as unknown as VideoStateRow[];
}

export function flagsFromRow(row: VideoStateRow | null | undefined): VideoFlags {
  return {
    isRead: !!(row && row.is_read),
    isLiked: !!(row && row.is_liked),
    isLater: !!(row && row.is_later),
    isArchived: !!(row && row.is_archived),
    isHidden: !!(row && row.is_hidden),
  };
}

export function upsertVideoMeta(
  database: Database,
  meta: {
    videoId: string;
    channelId: string;
    title: string;
    thumbnail?: string | null;
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
  }> = {},
): VideoStateRow {
  const existing = getVideoState(database, meta.videoId);
  const next = {
    is_read: patch.isRead !== undefined ? (patch.isRead ? 1 : 0) : existing?.is_read ?? 0,
    is_liked: patch.isLiked !== undefined ? (patch.isLiked ? 1 : 0) : existing?.is_liked ?? 0,
    is_later: patch.isLater !== undefined ? (patch.isLater ? 1 : 0) : existing?.is_later ?? 0,
    is_archived:
      patch.isArchived !== undefined ? (patch.isArchived ? 1 : 0) : existing?.is_archived ?? 0,
    is_hidden: patch.isHidden !== undefined ? (patch.isHidden ? 1 : 0) : existing?.is_hidden ?? 0,
  };

  database
    .prepare(
      `INSERT INTO video_state (
         video_id, channel_id, title, thumbnail, url, published_ms, is_live,
         is_read, is_liked, is_later, is_archived, is_hidden, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         title = excluded.title,
         thumbnail = COALESCE(excluded.thumbnail, video_state.thumbnail),
         url = excluded.url,
         published_ms = CASE WHEN excluded.published_ms > 0 THEN excluded.published_ms ELSE video_state.published_ms END,
         is_live = excluded.is_live,
         is_read = excluded.is_read,
         is_liked = excluded.is_liked,
         is_later = excluded.is_later,
         is_archived = excluded.is_archived,
         is_hidden = excluded.is_hidden,
         updated_at = excluded.updated_at`,
    )
    .run(
      meta.videoId,
      meta.channelId,
      meta.title,
      meta.thumbnail ?? null,
      meta.url,
      meta.publishedMs ?? existing?.published_ms ?? 0,
      meta.isLive ? 1 : existing?.is_live ?? 0,
      next.is_read,
      next.is_liked,
      next.is_later,
      next.is_archived,
      next.is_hidden,
      Date.now(),
    );

  return getVideoState(database, meta.videoId)!;
}

export function replaceAllData(
  database: Database,
  data: { channels: ChannelRow[]; videoStates: VideoStateRow[] },
): void {
  database.exec('DELETE FROM video_state; DELETE FROM channels;');
  for (const ch of data.channels) {
    upsertChannel(database, {
      id: ch.id,
      title: ch.title,
      handle: ch.handle,
      thumbnail: ch.thumbnail,
      color: ch.color,
    });
  }
  for (const v of data.videoStates) {
    database
      .prepare(
        `INSERT INTO video_state (
           video_id, channel_id, title, thumbnail, url, published_ms, is_live,
           is_read, is_liked, is_later, is_archived, is_hidden, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.video_id,
        v.channel_id,
        v.title,
        v.thumbnail,
        v.url,
        v.published_ms ?? 0,
        v.is_live ?? 0,
        v.is_read ?? 0,
        v.is_liked ?? 0,
        v.is_later ?? 0,
        v.is_archived ?? 0,
        v.is_hidden ?? 0,
        v.updated_at ?? Date.now(),
      );
  }
}
