package db

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type ChannelRow struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Handle    *string `json:"handle"`
	Thumbnail *string `json:"thumbnail"`
	Color     *string `json:"color"`
	AddedAt   int64   `json:"added_at"`
}

type VideoStateRow struct {
	VideoID     string  `json:"video_id"`
	ChannelID   string  `json:"channel_id"`
	Title       string  `json:"title"`
	Thumbnail   *string `json:"thumbnail"`
	URL         string  `json:"url"`
	PublishedMs int64   `json:"published_ms"`
	IsLive      int     `json:"is_live"`
	IsRead      int     `json:"is_read"`
	IsLiked     int     `json:"is_liked"`
	IsLater     int     `json:"is_later"`
	IsArchived  int     `json:"is_archived"`
	IsHidden    int     `json:"is_hidden"`
	UpdatedAt   int64   `json:"updated_at"`
}

type FeedCacheRow struct {
	VideoID        string  `json:"video_id"`
	ChannelID      string  `json:"channel_id"`
	Title          string  `json:"title"`
	Thumbnail      *string `json:"thumbnail"`
	ThumbnailLocal *string `json:"thumbnail_local"`
	URL            string  `json:"url"`
	PublishedAt    *string `json:"published_at"`
	PublishedMs    int64   `json:"published_ms"`
	IsLive         int     `json:"is_live"`
	IsStream       int     `json:"is_stream"`
	ViewCount      int64   `json:"view_count"`
	LikeCount      int64   `json:"like_count"`
	FetchedAt      int64   `json:"fetched_at"`
}

type VideoFlags struct {
	IsRead     bool `json:"isRead"`
	IsLiked    bool `json:"isLiked"`
	IsLater    bool `json:"isLater"`
	IsArchived bool `json:"isArchived"`
	IsHidden   bool `json:"isHidden"`
}

var ChannelColors = []string{
	"#e25548", "#0f6e8c", "#2f9e71", "#c47a1a", "#6b5ce7",
	"#c23d8b", "#3aa0c0", "#7a8b3a", "#d97706", "#2563eb",
}

type DB struct {
	sql *sql.DB
	mu  sync.Mutex
}

func Open(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	d := &DB{sql: sqlDB}
	if err := d.migrate(); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) Close() error {
	return d.sql.Close()
}

func (d *DB) migrate() error {
	_, err := d.sql.Exec(`
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
  `)
	if err != nil {
		return err
	}
	_ = d.ensureColumn("channels", "color", "TEXT")
	for _, col := range []string{
		"is_stream INTEGER NOT NULL DEFAULT 0",
		"view_count INTEGER NOT NULL DEFAULT 0",
		"like_count INTEGER NOT NULL DEFAULT 0",
		"thumbnail_local TEXT",
	} {
		name := strings.Fields(col)[0]
		_ = d.ensureColumn("feed_cache", name, col)
	}
	return nil
}

func (d *DB) ensureColumn(table, name, def string) error {
	rows, err := d.sql.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var colName, colType string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &colName, &colType, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if colName == name {
			return nil
		}
	}
	_, err = d.sql.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s", table, def))
	return err
}

func ColorForChannel(id string, explicit *string) string {
	if explicit != nil && *explicit != "" {
		return *explicit
	}
	var hash uint32
	for i := 0; i < len(id); i++ {
		hash = hash*31 + uint32(id[i])
	}
	return ChannelColors[hash%uint32(len(ChannelColors))]
}

func ListPalette() []string {
	out := make([]string, len(ChannelColors))
	copy(out, ChannelColors)
	return out
}

func FlagsFromRow(row *VideoStateRow) VideoFlags {
	if row == nil {
		return VideoFlags{}
	}
	return VideoFlags{
		IsRead:     row.IsRead != 0,
		IsLiked:    row.IsLiked != 0,
		IsLater:    row.IsLater != 0,
		IsArchived: row.IsArchived != 0,
		IsHidden:   row.IsHidden != 0,
	}
}

func (d *DB) FeedCacheAgeMs() *int64 {
	var maxAt sql.NullInt64
	err := d.sql.QueryRow(`SELECT MAX(fetched_at) FROM feed_cache`).Scan(&maxAt)
	if err != nil || !maxAt.Valid || maxAt.Int64 == 0 {
		return nil
	}
	age := time.Now().UnixMilli() - maxAt.Int64
	return &age
}

func (d *DB) ListFeedCache() ([]FeedCacheRow, error) {
	rows, err := d.sql.Query(`
		SELECT video_id, channel_id, title, thumbnail, thumbnail_local, url, published_at, published_ms,
		       is_live, is_stream, view_count, like_count, fetched_at
		FROM feed_cache ORDER BY published_ms DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FeedCacheRow
	for rows.Next() {
		var r FeedCacheRow
		if err := rows.Scan(
			&r.VideoID, &r.ChannelID, &r.Title, &r.Thumbnail, &r.ThumbnailLocal, &r.URL,
			&r.PublishedAt, &r.PublishedMs, &r.IsLive, &r.IsStream, &r.ViewCount, &r.LikeCount, &r.FetchedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type FeedCacheItem struct {
	VideoID        string
	ChannelID      string
	Title          string
	Thumbnail      *string
	ThumbnailLocal *string
	URL            string
	PublishedAt    *string
	PublishedMs    int64
	IsLive         bool
	IsStream       bool
	ViewCount      int64
	LikeCount      int64
}

func (d *DB) ReplaceFeedCache(items []FeedCacheItem) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM feed_cache`); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`
		INSERT INTO feed_cache (
			video_id, channel_id, title, thumbnail, thumbnail_local, url, published_at, published_ms,
			is_live, is_stream, view_count, like_count, fetched_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	fetchedAt := time.Now().UnixMilli()
	for _, item := range items {
		isLive, isStream := 0, 0
		if item.IsLive {
			isLive = 1
		}
		if item.IsStream {
			isStream = 1
		}
		if _, err := stmt.Exec(
			item.VideoID, item.ChannelID, item.Title, item.Thumbnail, item.ThumbnailLocal, item.URL,
			item.PublishedAt, item.PublishedMs, isLive, isStream, item.ViewCount, item.LikeCount, fetchedAt,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) ListChannels() ([]ChannelRow, error) {
	rows, err := d.sql.Query(`
		SELECT id, title, handle, thumbnail, color, added_at
		FROM channels ORDER BY title COLLATE NOCASE ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChannelRow
	for rows.Next() {
		var r ChannelRow
		if err := rows.Scan(&r.ID, &r.Title, &r.Handle, &r.Thumbnail, &r.Color, &r.AddedAt); err != nil {
			return nil, err
		}
		c := ColorForChannel(r.ID, r.Color)
		r.Color = &c
		out = append(out, r)
	}
	return out, rows.Err()
}

func (d *DB) GetChannel(id string) (*ChannelRow, error) {
	var r ChannelRow
	err := d.sql.QueryRow(`
		SELECT id, title, handle, thumbnail, color, added_at FROM channels WHERE id = ?`, id).
		Scan(&r.ID, &r.Title, &r.Handle, &r.Thumbnail, &r.Color, &r.AddedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c := ColorForChannel(r.ID, r.Color)
	r.Color = &c
	return &r, nil
}

func (d *DB) UpsertChannel(ch ChannelRow) error {
	color := ColorForChannel(ch.ID, ch.Color)
	_, err := d.sql.Exec(`
		INSERT INTO channels (id, title, handle, thumbnail, color, added_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			handle = COALESCE(excluded.handle, channels.handle),
			thumbnail = COALESCE(excluded.thumbnail, channels.thumbnail),
			color = COALESCE(excluded.color, channels.color)`,
		ch.ID, ch.Title, ch.Handle, ch.Thumbnail, color, time.Now().UnixMilli(),
	)
	return err
}

func (d *DB) SetChannelColor(id, color string) (bool, error) {
	ch, err := d.GetChannel(id)
	if err != nil || ch == nil {
		return false, err
	}
	_, err = d.sql.Exec(`UPDATE channels SET color = ? WHERE id = ?`, color, id)
	return err == nil, err
}

func (d *DB) RemoveChannel(id string) (bool, error) {
	ch, err := d.GetChannel(id)
	if err != nil || ch == nil {
		return false, err
	}
	_, err = d.sql.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err == nil, err
}

func (d *DB) GetVideoState(videoID string) (*VideoStateRow, error) {
	var r VideoStateRow
	err := d.sql.QueryRow(`SELECT * FROM video_state WHERE video_id = ?`, videoID).Scan(
		&r.VideoID, &r.ChannelID, &r.Title, &r.Thumbnail, &r.URL, &r.PublishedMs, &r.IsLive,
		&r.IsRead, &r.IsLiked, &r.IsLater, &r.IsArchived, &r.IsHidden, &r.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (d *DB) ListVideoStates() ([]VideoStateRow, error) {
	rows, err := d.sql.Query(`SELECT * FROM video_state ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VideoStateRow
	for rows.Next() {
		var r VideoStateRow
		if err := rows.Scan(
			&r.VideoID, &r.ChannelID, &r.Title, &r.Thumbnail, &r.URL, &r.PublishedMs, &r.IsLive,
			&r.IsRead, &r.IsLiked, &r.IsLater, &r.IsArchived, &r.IsHidden, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type VideoMeta struct {
	VideoID     string
	ChannelID   string
	Title       string
	Thumbnail   *string
	URL         string
	PublishedMs int64
	IsLive      bool
}

func (d *DB) UpsertVideoMeta(meta VideoMeta, patch map[string]*bool) (*VideoStateRow, error) {
	existing, err := d.GetVideoState(meta.VideoID)
	if err != nil {
		return nil, err
	}
	next := map[string]int{
		"is_read":     0,
		"is_liked":    0,
		"is_later":    0,
		"is_archived": 0,
		"is_hidden":   0,
	}
	if existing != nil {
		next["is_read"] = existing.IsRead
		next["is_liked"] = existing.IsLiked
		next["is_later"] = existing.IsLater
		next["is_archived"] = existing.IsArchived
		next["is_hidden"] = existing.IsHidden
	}
	apply := func(key string, jsonKey string) {
		if v, ok := patch[jsonKey]; ok && v != nil {
			if *v {
				next[key] = 1
			} else {
				next[key] = 0
			}
		}
	}
	apply("is_read", "isRead")
	apply("is_liked", "isLiked")
	apply("is_later", "isLater")
	apply("is_archived", "isArchived")
	apply("is_hidden", "isHidden")

	publishedMs := meta.PublishedMs
	if publishedMs == 0 && existing != nil {
		publishedMs = existing.PublishedMs
	}
	isLive := 0
	if meta.IsLive {
		isLive = 1
	} else if existing != nil {
		isLive = existing.IsLive
	}

	_, err = d.sql.Exec(`
		INSERT INTO video_state (
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
		meta.VideoID, meta.ChannelID, meta.Title, meta.Thumbnail, meta.URL, publishedMs, isLive,
		next["is_read"], next["is_liked"], next["is_later"], next["is_archived"], next["is_hidden"],
		time.Now().UnixMilli(),
	)
	if err != nil {
		return nil, err
	}
	return d.GetVideoState(meta.VideoID)
}

func (d *DB) ReplaceAllData(channels []ChannelRow, states []VideoStateRow) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM video_state; DELETE FROM channels;`); err != nil {
		return err
	}
	for _, ch := range channels {
		color := ColorForChannel(ch.ID, ch.Color)
		if _, err := tx.Exec(`
			INSERT INTO channels (id, title, handle, thumbnail, color, added_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			ch.ID, ch.Title, ch.Handle, ch.Thumbnail, color, time.Now().UnixMilli(),
		); err != nil {
			return err
		}
	}
	for _, v := range states {
		updated := v.UpdatedAt
		if updated == 0 {
			updated = time.Now().UnixMilli()
		}
		if _, err := tx.Exec(`
			INSERT INTO video_state (
				video_id, channel_id, title, thumbnail, url, published_ms, is_live,
				is_read, is_liked, is_later, is_archived, is_hidden, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			v.VideoID, v.ChannelID, v.Title, v.Thumbnail, v.URL, v.PublishedMs, v.IsLive,
			v.IsRead, v.IsLiked, v.IsLater, v.IsArchived, v.IsHidden, updated,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}
