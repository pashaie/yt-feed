package services

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pashaie/yt-feed/internal/appdata"
	"github.com/pashaie/yt-feed/internal/db"
	"github.com/pashaie/yt-feed/internal/httpx"
	"github.com/pashaie/yt-feed/internal/thumbs"
	"github.com/pashaie/yt-feed/internal/youtube"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const cacheTTL = 10 * time.Minute

type EnrichFeedItem struct {
	youtube.FeedItem
	ChannelColor string `json:"channelColor"`
	IsRead       bool   `json:"isRead"`
	IsLiked      bool   `json:"isLiked"`
	IsLater      bool   `json:"isLater"`
	IsArchived   bool   `json:"isArchived"`
	IsHidden     bool   `json:"isHidden"`
}

type OkResult struct {
	OK bool `json:"ok"`
}

type PathResult struct {
	OK    bool   `json:"ok"`
	Path  string `json:"path,omitempty"`
	Count int    `json:"count,omitempty"`
}

type ImportDataResult struct {
	OK          bool `json:"ok"`
	Channels    int  `json:"channels"`
	VideoStates int  `json:"videoStates"`
}

type ImportChannelsResult struct {
	Total   int                    `json:"total"`
	Added   int                    `json:"added"`
	Failed  int                    `json:"failed"`
	Results []ImportChannelOutcome `json:"results"`
}

type ImportChannelOutcome struct {
	Input   string         `json:"input"`
	OK      bool           `json:"ok"`
	Error   string         `json:"error,omitempty"`
	Channel *db.ChannelRow `json:"channel,omitempty"`
}

type OpenVideoPayload struct {
	URL         string `json:"url"`
	VideoID     string `json:"videoId"`
	ChannelID   string `json:"channelId"`
	Title       string `json:"title"`
	Thumbnail   string `json:"thumbnail"`
	PublishedMs int64  `json:"publishedMs"`
	IsLive      bool   `json:"isLive"`
	MarkRead    *bool  `json:"markRead"`
}

type SetFlagsPayload struct {
	VideoID     string `json:"videoId"`
	ChannelID   string `json:"channelId"`
	Title       string `json:"title"`
	Thumbnail   string `json:"thumbnail"`
	URL         string `json:"url"`
	PublishedMs int64  `json:"publishedMs"`
	IsLive      bool   `json:"isLive"`
	IsRead      *bool  `json:"isRead"`
	IsLiked     *bool  `json:"isLiked"`
	IsLater     *bool  `json:"isLater"`
	IsArchived  *bool  `json:"isArchived"`
	IsHidden    *bool  `json:"isHidden"`
}

type GetCommentsPayload struct {
	VideoID string `json:"videoId"`
	Limit   int    `json:"limit"`
}

// AppService is the Wails-bound API surface (mirrors former tiny.api).
type AppService struct {
	paths   appdata.Paths
	db      *db.DB
	httpx   *httpx.Manager
	youtube *youtube.Client

	mu             sync.Mutex
	memoryCache    *memoryFeed
	refreshInFlight chan struct{}
	refreshResult  []EnrichFeedItem
	refreshErr     error
}

type memoryFeed struct {
	at    time.Time
	items []EnrichFeedItem
}

func NewAppService(paths appdata.Paths, database *db.DB, httpMgr *httpx.Manager) *AppService {
	yt := &youtube.Client{HTTP: httpMgr.Client()}
	return &AppService{
		paths:   paths,
		db:      database,
		httpx:   httpMgr,
		youtube: yt,
	}
}

func (a *AppService) refreshHTTP() {
	a.youtube.HTTP = a.httpx.Client()
}

func (a *AppService) invalidateCache() {
	a.mu.Lock()
	a.memoryCache = nil
	a.mu.Unlock()
}

func (a *AppService) ListChannels() ([]db.ChannelRow, error) {
	return a.db.ListChannels()
}

func (a *AppService) ListPalette() []string {
	return db.ListPalette()
}

func (a *AppService) SetChannelColor(id, color string) (OkResult, error) {
	ok, err := a.db.SetChannelColor(id, color)
	if err != nil {
		return OkResult{}, err
	}
	if ok {
		a.mu.Lock()
		if a.memoryCache != nil {
			for i := range a.memoryCache.items {
				if a.memoryCache.items[i].ChannelID == id {
					a.memoryCache.items[i].ChannelColor = color
				}
			}
		}
		a.mu.Unlock()
	}
	return OkResult{OK: ok}, nil
}

func (a *AppService) AddChannel(input string) (db.ChannelRow, error) {
	if strings.TrimSpace(input) == "" {
		return db.ChannelRow{}, fmt.Errorf("channel is required")
	}
	return a.addResolved(input)
}

func (a *AppService) addResolved(raw string) (db.ChannelRow, error) {
	a.refreshHTTP()
	resolved, err := a.youtube.ResolveChannel(raw)
	if err != nil {
		return db.ChannelRow{}, err
	}
	row := db.ChannelRow{
		ID:        resolved.ID,
		Title:     resolved.Title,
		Handle:    resolved.Handle,
		Thumbnail: resolved.Thumbnail,
	}
	if err := a.db.UpsertChannel(row); err != nil {
		return db.ChannelRow{}, err
	}
	a.invalidateCache()
	channels, err := a.db.ListChannels()
	if err != nil {
		return db.ChannelRow{}, err
	}
	for _, ch := range channels {
		if ch.ID == resolved.ID {
			return ch, nil
		}
	}
	return db.ChannelRow{}, fmt.Errorf("failed to save channel")
}

func (a *AppService) RemoveChannel(id string) (OkResult, error) {
	ok, err := a.db.RemoveChannel(id)
	if err != nil {
		return OkResult{}, err
	}
	if ok {
		a.invalidateCache()
	}
	return OkResult{OK: ok}, nil
}

func (a *AppService) ImportChannels(lines string) (ImportChannelsResult, error) {
	rawLines := []string{}
	for _, line := range strings.Split(lines, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line != "" {
			rawLines = append(rawLines, line)
		}
	}
	out := ImportChannelsResult{Total: len(rawLines)}
	for _, line := range rawLines {
		ch, err := a.addResolved(line)
		if err != nil {
			out.Failed++
			out.Results = append(out.Results, ImportChannelOutcome{Input: line, Error: err.Error()})
			continue
		}
		out.Added++
		cp := ch
		out.Results = append(out.Results, ImportChannelOutcome{Input: line, OK: true, Channel: &cp})
	}
	return out, nil
}

func (a *AppService) ListFeed() ([]EnrichFeedItem, error) {
	return a.getFeed(false)
}

func (a *AppService) RefreshFeed() ([]EnrichFeedItem, error) {
	return a.getFeed(true)
}

func (a *AppService) GetComments(payload GetCommentsPayload) ([]youtube.CommentItem, error) {
	a.refreshHTTP()
	return a.youtube.FetchTopComments(payload.VideoID, payload.Limit)
}

func (a *AppService) OpenVideo(payload OpenVideoPayload) (OkResult, error) {
	if payload.URL == "" || !regexp.MustCompile(`(?i)^https://(www\.)?youtube\.com/`).MatchString(payload.URL) {
		return OkResult{}, fmt.Errorf("only YouTube URLs are allowed")
	}
	app := application.Get()
	if app == nil {
		return OkResult{}, fmt.Errorf("app not initialized")
	}
	if err := app.Browser.OpenURL(payload.URL); err != nil {
		return OkResult{}, err
	}
	markRead := true
	if payload.MarkRead != nil {
		markRead = *payload.MarkRead
	}
	if markRead && payload.VideoID != "" && payload.ChannelID != "" && payload.Title != "" {
		read := true
		_, err := a.patchVideo(SetFlagsPayload{
			VideoID: payload.VideoID, ChannelID: payload.ChannelID, Title: payload.Title,
			Thumbnail: payload.Thumbnail, URL: payload.URL, PublishedMs: payload.PublishedMs,
			IsLive: payload.IsLive, IsRead: &read,
		})
		if err != nil {
			return OkResult{}, err
		}
	}
	return OkResult{OK: true}, nil
}

func (a *AppService) SetVideoFlags(payload SetFlagsPayload) (db.VideoFlags, error) {
	return a.patchVideo(payload)
}

func (a *AppService) patchVideo(payload SetFlagsPayload) (db.VideoFlags, error) {
	var thumb *string
	if payload.Thumbnail != "" {
		thumb = &payload.Thumbnail
	}
	patch := map[string]*bool{
		"isRead":     payload.IsRead,
		"isLiked":    payload.IsLiked,
		"isLater":    payload.IsLater,
		"isArchived": payload.IsArchived,
		"isHidden":   payload.IsHidden,
	}
	row, err := a.db.UpsertVideoMeta(db.VideoMeta{
		VideoID: payload.VideoID, ChannelID: payload.ChannelID, Title: payload.Title,
		Thumbnail: thumb, URL: payload.URL, PublishedMs: payload.PublishedMs, IsLive: payload.IsLive,
	}, patch)
	if err != nil {
		return db.VideoFlags{}, err
	}
	flags := db.FlagsFromRow(row)
	a.mu.Lock()
	if a.memoryCache != nil {
		for i := range a.memoryCache.items {
			if a.memoryCache.items[i].VideoID == payload.VideoID {
				a.memoryCache.items[i].IsRead = flags.IsRead
				a.memoryCache.items[i].IsLiked = flags.IsLiked
				a.memoryCache.items[i].IsLater = flags.IsLater
				a.memoryCache.items[i].IsArchived = flags.IsArchived
				a.memoryCache.items[i].IsHidden = flags.IsHidden
			}
		}
	}
	a.mu.Unlock()
	return flags, nil
}

func (a *AppService) WriteExportData(path string) (PathResult, error) {
	if path == "" {
		return PathResult{}, fmt.Errorf("path is required")
	}
	channels, err := a.db.ListChannels()
	if err != nil {
		return PathResult{}, err
	}
	states, err := a.db.ListVideoStates()
	if err != nil {
		return PathResult{}, err
	}
	payload := map[string]any{
		"version":     1,
		"exportedAt":  time.Now().UTC().Format(time.RFC3339),
		"channels":    channels,
		"videoStates": states,
	}
	out := path
	if !strings.HasSuffix(strings.ToLower(out), ".json") {
		out += ".json"
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return PathResult{}, err
	}
	if err := os.WriteFile(out, data, 0o644); err != nil {
		return PathResult{}, err
	}
	return PathResult{OK: true, Path: out}, nil
}

func (a *AppService) ImportDataFromPath(path string) (ImportDataResult, error) {
	if path == "" {
		return ImportDataResult{}, fmt.Errorf("path is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ImportDataResult{}, err
	}
	var parsed struct {
		Channels    []db.ChannelRow    `json:"channels"`
		VideoStates []db.VideoStateRow `json:"videoStates"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ImportDataResult{}, err
	}
	if parsed.Channels == nil {
		return ImportDataResult{}, fmt.Errorf("invalid export: missing channels")
	}
	if parsed.VideoStates == nil {
		parsed.VideoStates = []db.VideoStateRow{}
	}
	if err := a.db.ReplaceAllData(parsed.Channels, parsed.VideoStates); err != nil {
		return ImportDataResult{}, err
	}
	a.invalidateCache()
	return ImportDataResult{OK: true, Channels: len(parsed.Channels), VideoStates: len(parsed.VideoStates)}, nil
}

func (a *AppService) WriteExportChannelsText(path string) (PathResult, error) {
	if path == "" {
		return PathResult{}, fmt.Errorf("path is required")
	}
	channels, err := a.db.ListChannels()
	if err != nil {
		return PathResult{}, err
	}
	var lines []string
	for _, c := range channels {
		if c.Handle != nil && *c.Handle != "" {
			lines = append(lines, "https://www.youtube.com/"+*c.Handle)
		} else {
			lines = append(lines, "https://www.youtube.com/channel/"+c.ID)
		}
	}
	out := path
	if !strings.HasSuffix(strings.ToLower(out), ".txt") {
		out += ".txt"
	}
	if err := os.WriteFile(out, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return PathResult{}, err
	}
	return PathResult{OK: true, Path: out, Count: len(channels)}, nil
}

func (a *AppService) GetProxyConfig() httpx.Config {
	return a.httpx.Get()
}

func (a *AppService) SetProxyConfig(cfg httpx.Config) (OkResult, error) {
	if err := a.httpx.Set(cfg); err != nil {
		return OkResult{}, err
	}
	a.refreshHTTP()
	a.invalidateCache()
	return OkResult{OK: true}, nil
}

func (a *AppService) ThumbURL(videoID string) string {
	if videoID == "" {
		return ""
	}
	path := filepath.Join(a.paths.ThumbsDir(), videoID+".jpg")
	if st, err := os.Stat(path); err == nil && !st.IsDir() {
		return "/thumbs/" + videoID + ".jpg"
	}
	return ""
}

func (a *AppService) getFeed(force bool) ([]EnrichFeedItem, error) {
	a.mu.Lock()
	if !force && a.memoryCache != nil && time.Since(a.memoryCache.at) < cacheTTL {
		items := a.memoryCache.items
		a.mu.Unlock()
		return items, nil
	}
	a.mu.Unlock()

	if !force {
		if age := a.db.FeedCacheAgeMs(); age != nil && time.Duration(*age)*time.Millisecond < cacheTTL {
			cached, err := a.loadCachedFeed()
			if err != nil {
				return nil, err
			}
			a.mu.Lock()
			a.memoryCache = &memoryFeed{at: time.Now().Add(-time.Duration(*age) * time.Millisecond), items: cached}
			a.mu.Unlock()
			return cached, nil
		}
		disk, err := a.loadCachedFeed()
		if err != nil {
			return nil, err
		}
		if len(disk) > 0 {
			a.mu.Lock()
			a.memoryCache = &memoryFeed{at: time.Time{}, items: disk}
			a.mu.Unlock()
			return disk, nil
		}
	}

	a.mu.Lock()
	if a.refreshInFlight != nil {
		ch := a.refreshInFlight
		a.mu.Unlock()
		<-ch
		a.mu.Lock()
		items, err := a.refreshResult, a.refreshErr
		a.mu.Unlock()
		return items, err
	}
	done := make(chan struct{})
	a.refreshInFlight = done
	a.mu.Unlock()

	items, err := a.buildFeedFromNetwork()
	a.mu.Lock()
	if err == nil {
		a.memoryCache = &memoryFeed{at: time.Now(), items: items}
	}
	a.refreshResult = items
	a.refreshErr = err
	a.refreshInFlight = nil
	close(done)
	a.mu.Unlock()
	return items, err
}

func (a *AppService) enrich(item youtube.FeedItem, channels map[string]db.ChannelRow, state *db.VideoStateRow) EnrichFeedItem {
	ch := channels[item.ChannelID]
	flags := db.FlagsFromRow(state)
	color := db.ColorForChannel(item.ChannelID, ch.Color)
	title := item.ChannelTitle
	if ch.Title != "" {
		title = ch.Title
	}
	item.ChannelTitle = title
	return EnrichFeedItem{
		FeedItem: item, ChannelColor: color,
		IsRead: flags.IsRead, IsLiked: flags.IsLiked, IsLater: flags.IsLater,
		IsArchived: flags.IsArchived, IsHidden: flags.IsHidden,
	}
}

func (a *AppService) stateToItem(row db.VideoStateRow, channels map[string]db.ChannelRow) EnrichFeedItem {
	ch := channels[row.ChannelID]
	title := row.ChannelID
	if ch.Title != "" {
		title = ch.Title
	}
	thumb := ""
	if row.Thumbnail != nil {
		thumb = *row.Thumbnail
	}
	if thumb == "" {
		thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", row.VideoID)
	}
	var publishedAt string
	if row.PublishedMs > 0 {
		publishedAt = time.UnixMilli(row.PublishedMs).UTC().Format(time.RFC3339)
	}
	return a.enrich(youtube.FeedItem{
		VideoID: row.VideoID, Title: row.Title, PublishedAt: publishedAt, PublishedMs: row.PublishedMs,
		ChannelID: row.ChannelID, ChannelTitle: title, Thumbnail: thumb, URL: row.URL,
		IsLive: row.IsLive != 0, IsStream: row.IsLive != 0,
	}, channels, &row)
}

func sortFeed(items []EnrichFeedItem) []EnrichFeedItem {
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].IsLive != items[j].IsLive {
			return items[i].IsLive
		}
		return items[i].PublishedMs > items[j].PublishedMs
	})
	return items
}

func (a *AppService) loadCachedFeed() ([]EnrichFeedItem, error) {
	channels, err := a.db.ListChannels()
	if err != nil {
		return nil, err
	}
	byChannel := map[string]db.ChannelRow{}
	for _, ch := range channels {
		byChannel[ch.ID] = ch
	}
	states, err := a.db.ListVideoStates()
	if err != nil {
		return nil, err
	}
	stateByID := map[string]db.VideoStateRow{}
	for _, s := range states {
		stateByID[s.VideoID] = s
	}
	byID := map[string]EnrichFeedItem{}
	cache, err := a.db.ListFeedCache()
	if err != nil {
		return nil, err
	}
	for _, row := range cache {
		thumb := ""
		if row.Thumbnail != nil {
			thumb = *row.Thumbnail
		}
		if thumb == "" {
			thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", row.VideoID)
		}
		publishedAt := ""
		if row.PublishedAt != nil {
			publishedAt = *row.PublishedAt
		}
		st := stateByID[row.VideoID]
		var stPtr *db.VideoStateRow
		if _, ok := stateByID[row.VideoID]; ok {
			stPtr = &st
		}
		item := a.enrich(youtube.FeedItem{
			VideoID: row.VideoID, Title: row.Title, PublishedAt: publishedAt, PublishedMs: row.PublishedMs,
			ChannelID: row.ChannelID, ChannelTitle: row.ChannelID, Thumbnail: thumb,
			ThumbnailLocal: row.ThumbnailLocal, URL: row.URL, IsLive: row.IsLive != 0, IsStream: row.IsStream != 0,
			ViewCount: row.ViewCount, LikeCount: row.LikeCount,
		}, byChannel, stPtr)
		byID[row.VideoID] = item
	}
	for _, row := range states {
		if _, ok := byID[row.VideoID]; ok {
			continue
		}
		if row.IsLiked != 0 || row.IsLater != 0 || row.IsArchived != 0 || row.IsHidden != 0 || row.IsRead != 0 {
			byID[row.VideoID] = a.stateToItem(row, byChannel)
		}
	}
	items := make([]EnrichFeedItem, 0, len(byID))
	for _, v := range byID {
		items = append(items, v)
	}
	return sortFeed(items), nil
}

func trimLatestPerChannel(items []EnrichFeedItem, limit int) []EnrichFeedItem {
	byCh := map[string][]EnrichFeedItem{}
	for _, item := range items {
		byCh[item.ChannelID] = append(byCh[item.ChannelID], item)
	}
	var out []EnrichFeedItem
	for _, list := range byCh {
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].IsLive != list[j].IsLive {
				return list[i].IsLive
			}
			return list[i].PublishedMs > list[j].PublishedMs
		})
		if len(list) > limit {
			list = list[:limit]
		}
		out = append(out, list...)
	}
	return out
}

func (a *AppService) buildFeedFromNetwork() ([]EnrichFeedItem, error) {
	a.refreshHTTP()
	channels, err := a.db.ListChannels()
	if err != nil {
		return nil, err
	}
	byChannel := map[string]db.ChannelRow{}
	for _, ch := range channels {
		byChannel[ch.ID] = ch
	}
	states, err := a.db.ListVideoStates()
	if err != nil {
		return nil, err
	}
	stateByID := map[string]db.VideoStateRow{}
	for _, s := range states {
		stateByID[s.VideoID] = s
	}
	byID := map[string]EnrichFeedItem{}

	type result struct {
		videos  []youtube.FeedItem
		streams []youtube.FeedItem
	}
	results := make([]result, len(channels))
	var wg sync.WaitGroup
	for i, ch := range channels {
		wg.Add(1)
		go func(i int, ch db.ChannelRow) {
			defer wg.Done()
			videos, _ := a.youtube.FetchChannelVideos(ch.ID, ch.Title, ch.Handle, youtube.ChannelVideoCacheLimit)
			streams, _ := a.youtube.FetchChannelStreams(ch.ID, ch.Title, ch.Handle)
			results[i] = result{videos: videos, streams: streams}
		}(i, ch)
	}
	wg.Wait()

	for _, res := range results {
		streamIDs := map[string]youtube.FeedItem{}
		for _, s := range res.streams {
			streamIDs[s.VideoID] = s
		}
		for _, item := range res.videos {
			merged := item
			if s, ok := streamIDs[item.VideoID]; ok {
				merged.IsStream = true
				if s.IsLive {
					merged.IsLive = true
				}
				if s.ViewCount > merged.ViewCount {
					merged.ViewCount = s.ViewCount
				}
				if merged.Thumbnail == "" {
					merged.Thumbnail = s.Thumbnail
				}
			}
			st := stateByID[item.VideoID]
			var stPtr *db.VideoStateRow
			if _, ok := stateByID[item.VideoID]; ok {
				stPtr = &st
			}
			byID[item.VideoID] = a.enrich(merged, byChannel, stPtr)
		}
		for _, stream := range res.streams {
			if prev, ok := byID[stream.VideoID]; ok {
				prev.IsStream = true
				prev.IsLive = prev.IsLive || stream.IsLive
				if prev.Title == "" || prev.Title == "Stream" {
					prev.Title = stream.Title
				}
				if prev.PublishedMs == 0 {
					prev.PublishedMs = stream.PublishedMs
				}
				if prev.PublishedAt == "" {
					prev.PublishedAt = stream.PublishedAt
				}
				if stream.ViewCount > prev.ViewCount {
					prev.ViewCount = stream.ViewCount
				}
				if stream.LikeCount > prev.LikeCount {
					prev.LikeCount = stream.LikeCount
				}
				if prev.Thumbnail == "" {
					prev.Thumbnail = stream.Thumbnail
				}
				byID[stream.VideoID] = prev
				continue
			}
			st := stateByID[stream.VideoID]
			var stPtr *db.VideoStateRow
			if _, ok := stateByID[stream.VideoID]; ok {
				stPtr = &st
			}
			byID[stream.VideoID] = a.enrich(stream, byChannel, stPtr)
		}
	}

	trimmed := trimLatestPerChannel(func() []EnrichFeedItem {
		out := make([]EnrichFeedItem, 0, len(byID))
		for _, v := range byID {
			out = append(out, v)
		}
		return out
	}(), youtube.ChannelVideoCacheLimit)
	byID = map[string]EnrichFeedItem{}
	for _, item := range trimmed {
		byID[item.VideoID] = item
	}
	for _, row := range states {
		if _, ok := byID[row.VideoID]; ok {
			continue
		}
		if row.IsLiked != 0 || row.IsLater != 0 || row.IsArchived != 0 || row.IsHidden != 0 || row.IsRead != 0 {
			byID[row.VideoID] = a.stateToItem(row, byChannel)
		}
	}
	items := sortFeed(func() []EnrichFeedItem {
		out := make([]EnrichFeedItem, 0, len(byID))
		for _, v := range byID {
			out = append(out, v)
		}
		return out
	}())

	if len(items) > 0 {
		thumbItems := make([]thumbs.Item, len(items))
		for i, item := range items {
			thumbItems[i] = thumbs.Item{VideoID: item.VideoID, Thumbnail: item.Thumbnail}
		}
		if localMap, err := thumbs.Cache(a.httpx.Client(), a.paths.Cache, thumbItems, 8); err == nil {
			for i := range items {
				if local, ok := localMap[items[i].VideoID]; ok {
					items[i].ThumbnailLocal = &local
				}
			}
		}
	}

	cacheItems := make([]db.FeedCacheItem, len(items))
	for i, item := range items {
		var publishedAt *string
		if item.PublishedAt != "" {
			p := item.PublishedAt
			publishedAt = &p
		}
		var thumb *string
		if item.Thumbnail != "" {
			t := item.Thumbnail
			thumb = &t
		}
		cacheItems[i] = db.FeedCacheItem{
			VideoID: item.VideoID, ChannelID: item.ChannelID, Title: item.Title,
			Thumbnail: thumb, ThumbnailLocal: item.ThumbnailLocal, URL: item.URL,
			PublishedAt: publishedAt, PublishedMs: item.PublishedMs,
			IsLive: item.IsLive, IsStream: item.IsStream,
			ViewCount: item.ViewCount, LikeCount: item.LikeCount,
		}
	}
	_ = a.db.ReplaceFeedCache(cacheItems)
	return items, nil
}
