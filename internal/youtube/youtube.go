package youtube

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const ChannelVideoCacheLimit = 100
const videosTabParams = "EgZ2aWRlb3PyBgQKAjoA"

var (
	channelIDRe = regexp.MustCompile(`^UC[\w-]{22}$`)
	videoIDRe   = regexp.MustCompile(`^[\w-]{11}$`)
)

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

func ytHeaders() http.Header {
	h := make(http.Header)
	h.Set("User-Agent", userAgent)
	h.Set("Accept-Language", "en-US,en;q=0.9")
	h.Set("Accept", "text/html,application/xhtml+xml")
	h.Set("Cookie", "CONSENT=YES+cb.20210328-17-p0.en+FX+123; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJn5pwY")
	return h
}

type Client struct {
	HTTP *http.Client
	mu   sync.Mutex
	it   *innertubeClient
}

type ResolvedChannel struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Handle    *string `json:"handle"`
	Thumbnail *string `json:"thumbnail"`
}

type FeedItem struct {
	VideoID        string  `json:"videoId"`
	Title          string  `json:"title"`
	PublishedAt    string  `json:"publishedAt"`
	PublishedMs    int64   `json:"publishedMs"`
	ChannelID      string  `json:"channelId"`
	ChannelTitle   string  `json:"channelTitle"`
	Thumbnail      string  `json:"thumbnail"`
	ThumbnailLocal *string `json:"thumbnailLocal,omitempty"`
	URL            string  `json:"url"`
	IsLive         bool    `json:"isLive"`
	IsStream       bool    `json:"isStream"`
	ViewCount      int64   `json:"viewCount"`
	LikeCount      int64   `json:"likeCount"`
}

type CommentItem struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Text      string `json:"text"`
	Likes     string `json:"likes"`
	Published string `json:"published"`
}

type innertubeClient struct {
	APIKey         string
	ClientVersion  string
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	if c.HTTP == nil {
		return nil, fmt.Errorf("http client not configured")
	}
	return c.HTTP.Do(req)
}

func (c *Client) getText(rawURL string, extra http.Header) (string, int, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header = ytHeaders()
	for k, vals := range extra {
		for _, v := range vals {
			req.Header.Set(k, v)
		}
	}
	res, err := c.do(req)
	if err != nil {
		return "", 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", res.StatusCode, err
	}
	return string(body), res.StatusCode, nil
}

func (c *Client) postJSON(rawURL string, payload any) (map[string]any, int, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(string(data)))
	if err != nil {
		return nil, 0, err
	}
	req.Header = ytHeaders()
	req.Header.Set("Content-Type", "application/json")
	res, err := c.do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, res.StatusCode, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, res.StatusCode, err
	}
	return out, res.StatusCode, nil
}

func decodeXML(text string) string {
	r := strings.NewReplacer(
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&apos;", "'",
		"&#39;", "'",
	)
	return r.Replace(text)
}

func extractTag(block, tag string) string {
	re := regexp.MustCompile(`(?i)<` + tag + `[^>]*>([\s\S]*?)</` + tag + `>`)
	m := re.FindStringSubmatch(block)
	if len(m) < 2 {
		return ""
	}
	return decodeXML(strings.TrimSpace(m[1]))
}

func extractAttr(block, tag, attr string) string {
	re := regexp.MustCompile(`(?i)<` + tag + `[^>]*\s` + attr + `="([^"]+)"[^>]*/?>`)
	m := re.FindStringSubmatch(block)
	if len(m) < 2 {
		return ""
	}
	return decodeXML(m[1])
}

func NormalizeInput(raw string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
}

func ParseCompactCount(text string) int64 {
	if text == "" {
		return 0
	}
	cleaned := strings.ReplaceAll(strings.TrimSpace(text), ",", "")
	re := regexp.MustCompile(`(?i)^([\d.]+)\s*([KMB])?$`)
	m := re.FindStringSubmatch(cleaned)
	if m == nil {
		digits := regexp.MustCompile(`[^\d]+`).ReplaceAllString(text, "")
		if digits == "" {
			return 0
		}
		n, _ := strconv.ParseInt(digits, 10, 64)
		return n
	}
	n, _ := strconv.ParseFloat(m[1], 64)
	switch strings.ToUpper(m[2]) {
	case "K":
		n *= 1e3
	case "M":
		n *= 1e6
	case "B":
		n *= 1e9
	}
	return int64(n + 0.5)
}

func extractChannelIDFromHTML(html string) string {
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)<link\s+rel="canonical"\s+href="[^"]*/channel/(UC[\w-]{22})"`),
		regexp.MustCompile(`(?i)<meta\s+property="og:url"\s+content="[^"]*/channel/(UC[\w-]{22})"`),
		regexp.MustCompile(`"externalId":"(UC[\w-]{22})"`),
		regexp.MustCompile(`"browseId":"(UC[\w-]{22})"`),
		regexp.MustCompile(`(?i)<meta\s+itemprop="channelId"\s+content="(UC[\w-]{22})"`),
		regexp.MustCompile(`/channel/(UC[\w-]{22})`),
	}
	for _, re := range patterns {
		if m := re.FindStringSubmatch(html); len(m) > 1 {
			return m[1]
		}
	}
	return ""
}

func extractTitleFromHTML(html string) string {
	if m := regexp.MustCompile(`(?i)<meta\s+property="og:title"\s+content="([^"]+)"`).FindStringSubmatch(html); len(m) > 1 {
		return strings.TrimSpace(regexp.MustCompile(`(?i)\s*-\s*YouTube\s*$`).ReplaceAllString(decodeXML(m[1]), ""))
	}
	if m := regexp.MustCompile(`(?i)<title>([^<]+)</title>`).FindStringSubmatch(html); len(m) > 1 {
		return strings.TrimSpace(regexp.MustCompile(`(?i)\s*-\s*YouTube\s*$`).ReplaceAllString(decodeXML(m[1]), ""))
	}
	return ""
}

func extractThumbnailFromHTML(html string) string {
	if m := regexp.MustCompile(`(?i)<meta\s+property="og:image"\s+content="([^"]+)"`).FindStringSubmatch(html); len(m) > 1 {
		return decodeXML(m[1])
	}
	return ""
}

func extractHandleFromHTML(html string) string {
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`"vanityChannelUrl":"http(?:s)?://www\.youtube\.com/(@[\w.-]+)"`),
		regexp.MustCompile(`"canonicalBaseUrl":"/(@[\w.-]+)"`),
		regexp.MustCompile(`href="https://www\.youtube\.com/(@[\w.-]+)"`),
	}
	for _, re := range patterns {
		if m := re.FindStringSubmatch(html); len(m) > 1 {
			return m[1]
		}
	}
	return ""
}

func guessURL(input string) (string, error) {
	if channelIDRe.MatchString(input) {
		return "https://www.youtube.com/channel/" + input, nil
	}
	if strings.HasPrefix(input, "@") {
		return "https://www.youtube.com/" + input, nil
	}
	if strings.HasPrefix(strings.ToLower(input), "http://") || strings.HasPrefix(strings.ToLower(input), "https://") {
		return input, nil
	}
	if regexp.MustCompile(`^[\w.-]+$`).MatchString(input) {
		return "https://www.youtube.com/@" + input, nil
	}
	return "", fmt.Errorf("unrecognized channel input")
}

func (c *Client) ResolveChannel(raw string) (ResolvedChannel, error) {
	input := NormalizeInput(raw)
	if input == "" {
		return ResolvedChannel{}, fmt.Errorf("empty channel")
	}
	var channelID string
	if channelIDRe.MatchString(input) {
		channelID = input
	} else if m := regexp.MustCompile(`/channel/(UC[\w-]{22})`).FindStringSubmatch(input); len(m) > 1 {
		channelID = m[1]
	}
	u, err := guessURL(input)
	if err != nil {
		return ResolvedChannel{}, err
	}
	html, status, err := c.getText(u, nil)
	if err != nil {
		return ResolvedChannel{}, err
	}
	if status < 200 || status >= 300 {
		return ResolvedChannel{}, fmt.Errorf("could not open channel (%d)", status)
	}
	if channelID == "" {
		channelID = extractChannelIDFromHTML(html)
	}
	if channelID == "" {
		return ResolvedChannel{}, fmt.Errorf("could not resolve channel id")
	}
	title := extractTitleFromHTML(html)
	if title == "" {
		title = channelID
	}
	thumb := extractThumbnailFromHTML(html)
	handle := extractHandleFromHTML(html)
	if handle == "" && strings.HasPrefix(input, "@") {
		handle = input
	}
	out := ResolvedChannel{ID: channelID, Title: title}
	if thumb != "" {
		out.Thumbnail = &thumb
	}
	if handle != "" {
		out.Handle = &handle
	}
	return out, nil
}

func (c *Client) FetchChannelRSS(channelID, channelTitle string) ([]FeedItem, error) {
	u := "https://www.youtube.com/feeds/videos.xml?channel_id=" + url.QueryEscape(channelID)
	extra := make(http.Header)
	extra.Set("Accept", "application/atom+xml,application/xml,text/xml")
	xml, status, err := c.getText(u, extra)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("RSS failed for %s (%d)", channelID, status)
	}
	entryRe := regexp.MustCompile(`(?s)<entry>.*?</entry>`)
	entries := entryRe.FindAllString(xml, -1)
	var items []FeedItem
	for _, entry := range entries {
		videoID := extractTag(entry, "yt:videoId")
		if videoID == "" {
			if m := regexp.MustCompile(`watch\?v=([\w-]{11})`).FindStringSubmatch(entry); len(m) > 1 {
				videoID = m[1]
			}
		}
		if videoID == "" {
			continue
		}
		title := extractTag(entry, "title")
		if title == "" {
			title = "Untitled"
		}
		publishedAt := extractTag(entry, "published")
		if publishedAt == "" {
			publishedAt = extractTag(entry, "updated")
		}
		var publishedMs int64
		if publishedAt != "" {
			if t, err := time.Parse(time.RFC3339, publishedAt); err == nil {
				publishedMs = t.UnixMilli()
			} else if t, err := time.Parse(time.RFC3339Nano, publishedAt); err == nil {
				publishedMs = t.UnixMilli()
			}
		}
		mediaTitle := extractTag(entry, "media:title")
		thumb := extractAttr(entry, "media:thumbnail", "url")
		if thumb == "" {
			thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", videoID)
		}
		views, _ := strconv.ParseInt(extractAttr(entry, "media:statistics", "views"), 10, 64)
		likes, _ := strconv.ParseInt(extractAttr(entry, "media:starRating", "count"), 10, 64)
		if mediaTitle != "" {
			title = mediaTitle
		}
		items = append(items, FeedItem{
			VideoID:      videoID,
			Title:        title,
			PublishedAt:  publishedAt,
			PublishedMs:  publishedMs,
			ChannelID:    channelID,
			ChannelTitle: channelTitle,
			Thumbnail:    thumb,
			URL:          "https://www.youtube.com/watch?v=" + videoID,
			ViewCount:    views,
			LikeCount:    likes,
		})
	}
	return items, nil
}

func ParseRelativePublished(text string) *int64 {
	if text == "" {
		return nil
	}
	cleaned := strings.TrimSpace(regexp.MustCompile(`(?i)^Streamed\s+`).ReplaceAllString(text, ""))
	re := regexp.MustCompile(`(?i)^(\d+)\s*(mo|months?|yr|years?|w|weeks?|d|days?|h|hours?|m|minutes?|s|seconds?)\s*ago$`)
	m := re.FindStringSubmatch(cleaned)
	if m == nil {
		return nil
	}
	n, _ := strconv.ParseInt(m[1], 10, 64)
	unit := strings.ToLower(m[2])
	day := int64(86400000)
	var mult int64
	switch {
	case unit == "mo" || strings.HasPrefix(unit, "month"):
		mult = 30 * day
	case unit == "yr" || strings.HasPrefix(unit, "year"):
		mult = 365 * day
	case unit == "w" || strings.HasPrefix(unit, "week"):
		mult = 7 * day
	case unit == "d" || strings.HasPrefix(unit, "day"):
		mult = day
	case unit == "h" || strings.HasPrefix(unit, "hour"):
		mult = 3600000
	case unit == "m" || strings.HasPrefix(unit, "min"):
		mult = 60000
	case unit == "s" || strings.HasPrefix(unit, "sec"):
		mult = 1000
	}
	if mult == 0 {
		return nil
	}
	v := time.Now().UnixMilli() - n*mult
	return &v
}

type lockupHit struct {
	ID             string
	Title          string
	IsLive         bool
	PublishedLabel string
	PublishedMs    int64
	ViewCount      int64
	Thumbnail      string
}

func walkLockups(node any, out *[]lockupHit) {
	if node == nil {
		return
	}
	switch v := node.(type) {
	case []any:
		for _, child := range v {
			walkLockups(child, out)
		}
	case map[string]any:
		if lockup, ok := v["lockupViewModel"].(map[string]any); ok {
			contentID, _ := lockup["contentId"].(string)
			if videoIDRe.MatchString(contentID) {
				hit := parseLockup(lockup, contentID)
				*out = append(*out, hit)
			}
		}
		for _, child := range v {
			walkLockups(child, out)
		}
	}
}

func parseLockup(lockup map[string]any, contentID string) lockupHit {
	title := "Stream"
	publishedLabel := ""
	var viewCount int64
	var metaParts []map[string]any

	if meta, ok := lockup["metadata"].(map[string]any); ok {
		if lmv, ok := meta["lockupMetadataViewModel"].(map[string]any); ok {
			if t, ok := lmv["title"].(map[string]any); ok {
				if c, ok := t["content"].(string); ok && c != "" {
					title = c
				}
			}
			if md, ok := lmv["metadata"].(map[string]any); ok {
				if cmv, ok := md["contentMetadataViewModel"].(map[string]any); ok {
					if rows, ok := cmv["metadataRows"].([]any); ok {
						for _, row := range rows {
							rm, _ := row.(map[string]any)
							if parts, ok := rm["metadataParts"].([]any); ok {
								for _, p := range parts {
									if pm, ok := p.(map[string]any); ok {
										metaParts = append(metaParts, pm)
									}
								}
							}
						}
					}
				}
			}
		}
	}
	for _, p := range metaParts {
		text := ""
		if t, ok := p["text"].(map[string]any); ok {
			text, _ = t["content"].(string)
		}
		a11y, _ := p["accessibilityLabel"].(string)
		label := text
		if label == "" {
			label = a11y
		}
		if regexp.MustCompile(`(?i)ago|Streamed|Live`).MatchString(label) && publishedLabel == "" {
			publishedLabel = label
		}
	}
	var publishedMs int64
	if ms := ParseRelativePublished(publishedLabel); ms != nil {
		publishedMs = *ms
	}
	for _, p := range metaParts {
		text := ""
		if t, ok := p["text"].(map[string]any); ok {
			text, _ = t["content"].(string)
		}
		a11y, _ := p["accessibilityLabel"].(string)
		if regexp.MustCompile(`(?i)view`).MatchString(a11y) || regexp.MustCompile(`(?i)^[\d.,]+\s*[KMB]?$`).MatchString(strings.TrimSpace(text)) {
			cleaned := regexp.MustCompile(`(?i)\s*views?`).ReplaceAllString(text, "")
			if cleaned == "" {
				if m := regexp.MustCompile(`(?i)([\d.,]+\s*[KMB]?)`).FindStringSubmatch(a11y); len(m) > 1 {
					cleaned = m[1]
				}
			}
			viewCount = ParseCompactCount(cleaned)
			break
		}
	}
	thumb := fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", contentID)
	var overlays []any
	if ci, ok := lockup["contentImage"].(map[string]any); ok {
		if tv, ok := ci["thumbnailViewModel"].(map[string]any); ok {
			if img, ok := tv["image"].(map[string]any); ok {
				if sources, ok := img["sources"].([]any); ok {
					bestW := -1
					for _, s := range sources {
						sm, _ := s.(map[string]any)
						w := 0
						if wv, ok := sm["width"].(float64); ok {
							w = int(wv)
						}
						if u, ok := sm["url"].(string); ok && w >= bestW {
							bestW = w
							thumb = u
						}
					}
				}
			}
			if o, ok := tv["overlays"].([]any); ok {
				overlays = o
			}
		}
	}
	badgeParts := []string{}
	for _, o := range overlays {
		om, _ := o.(map[string]any)
		if bottom, ok := om["thumbnailBottomOverlayViewModel"].(map[string]any); ok {
			if badges, ok := bottom["badges"].([]any); ok {
				for _, b := range badges {
					bm, _ := b.(map[string]any)
					if tb, ok := bm["thumbnailBadgeViewModel"].(map[string]any); ok {
						if t, ok := tb["text"].(string); ok {
							badgeParts = append(badgeParts, t)
						}
					}
				}
			}
		}
		if ts, ok := om["thumbnailOverlayTimeStatusViewModel"].(map[string]any); ok {
			if t, ok := ts["text"].(string); ok {
				badgeParts = append(badgeParts, t)
			}
			if s, ok := ts["style"].(string); ok {
				badgeParts = append(badgeParts, s)
			}
		}
	}
	badgeText := strings.Join(badgeParts, " ")
	isLive := regexp.MustCompile(`(?i)LIVE`).MatchString(badgeText) ||
		regexp.MustCompile(`(?i)^(Live now|LIVE)$`).MatchString(publishedLabel)
	return lockupHit{
		ID: contentID, Title: title, IsLive: isLive, PublishedLabel: publishedLabel,
		PublishedMs: publishedMs, ViewCount: viewCount, Thumbnail: thumb,
	}
}

func findContinuationToken(node any) string {
	if node == nil {
		return ""
	}
	switch v := node.(type) {
	case map[string]any:
		if cmd, ok := v["continuationCommand"].(map[string]any); ok {
			if token, ok := cmd["token"].(string); ok && token != "" {
				return token
			}
		}
		if cont, ok := v["continuation"].(string); ok && len(cont) > 20 {
			return cont
		}
		for _, child := range v {
			if t := findContinuationToken(child); t != "" {
				return t
			}
		}
	case []any:
		for _, child := range v {
			if t := findContinuationToken(child); t != "" {
				return t
			}
		}
	}
	return ""
}

func (c *Client) getInnertubeClient(seedURL string) (*innertubeClient, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.it != nil {
		return c.it, nil
	}
	seeds := []string{}
	if seedURL != "" {
		seeds = append(seeds, seedURL)
	}
	seeds = append(seeds, "https://www.youtube.com/")
	for _, u := range seeds {
		html, status, err := c.getText(u, nil)
		if err != nil || status < 200 || status >= 300 {
			continue
		}
		apiKey := ""
		clientVersion := ""
		if m := regexp.MustCompile(`"INNERTUBE_API_KEY":"([^"]+)"`).FindStringSubmatch(html); len(m) > 1 {
			apiKey = m[1]
		}
		if m := regexp.MustCompile(`"INNERTUBE_CLIENT_VERSION":"([^"]+)"`).FindStringSubmatch(html); len(m) > 1 {
			clientVersion = m[1]
		}
		if apiKey != "" && clientVersion != "" {
			c.it = &innertubeClient{APIKey: apiKey, ClientVersion: clientVersion}
			return c.it, nil
		}
	}
	c.it = &innertubeClient{
		APIKey:        "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
		ClientVersion: "2.20261105.05.01",
	}
	return c.it, nil
}

func (c *Client) innertubeBrowse(body map[string]any, seedURL string) (map[string]any, error) {
	client, err := c.getInnertubeClient(seedURL)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"context": map[string]any{
			"client": map[string]any{
				"clientName":    "WEB",
				"clientVersion": client.ClientVersion,
				"hl":            "en",
				"gl":            "US",
			},
		},
	}
	for k, v := range body {
		payload[k] = v
	}
	u := "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=" + url.QueryEscape(client.APIKey)
	out, status, err := c.postJSON(u, payload)
	if err != nil {
		return nil, fmt.Errorf("YouTube browse failed (%d): %w", status, err)
	}
	return out, nil
}

func lockupsToFeedItems(hits []lockupHit, channelID, channelTitle string, isStream bool) []FeedItem {
	seen := map[string]bool{}
	var items []FeedItem
	for _, hit := range hits {
		if seen[hit.ID] {
			continue
		}
		seen[hit.ID] = true
		thumb := hit.Thumbnail
		if thumb == "" {
			thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", hit.ID)
		}
		title := hit.Title
		if title == "" {
			title = "Video"
		}
		items = append(items, FeedItem{
			VideoID: hit.ID, Title: title, PublishedAt: hit.PublishedLabel, PublishedMs: hit.PublishedMs,
			ChannelID: channelID, ChannelTitle: channelTitle, Thumbnail: thumb,
			URL: "https://www.youtube.com/watch?v=" + hit.ID, IsLive: hit.IsLive,
			IsStream: isStream || hit.IsLive, ViewCount: hit.ViewCount,
		})
	}
	return items
}

func (c *Client) FetchChannelVideos(channelID, channelTitle string, handle *string, limit int) ([]FeedItem, error) {
	if limit <= 0 {
		limit = ChannelVideoCacheLimit
	}
	seed := fmt.Sprintf("https://www.youtube.com/channel/%s/videos", channelID)
	if handle != nil && *handle != "" {
		h := *handle
		if !strings.HasPrefix(h, "@") {
			h = "@" + h
		}
		seed = "https://www.youtube.com/" + h + "/videos"
	}
	var items []FeedItem
	seen := map[string]bool{}
	jsonBody, err := c.innertubeBrowse(map[string]any{
		"browseId": channelID,
		"params":   videosTabParams,
	}, seed)
	if err != nil {
		return nil, err
	}
	for page := 0; jsonBody != nil && page < 12 && len(items) < limit; page++ {
		var hits []lockupHit
		walkLockups(jsonBody, &hits)
		for _, item := range lockupsToFeedItems(hits, channelID, channelTitle, false) {
			if seen[item.VideoID] {
				continue
			}
			seen[item.VideoID] = true
			items = append(items, item)
			if len(items) >= limit {
				break
			}
		}
		if len(items) >= limit {
			break
		}
		token := findContinuationToken(jsonBody)
		if token == "" {
			break
		}
		jsonBody, err = c.innertubeBrowse(map[string]any{"continuation": token}, seed)
		if err != nil {
			break
		}
	}

	rss, err := c.FetchChannelRSS(channelID, channelTitle)
	if err == nil {
		if len(items) == 0 {
			if len(rss) > limit {
				rss = rss[:limit]
			}
			return rss, nil
		}
		byID := map[string]FeedItem{}
		for _, r := range rss {
			byID[r.VideoID] = r
		}
		for i := range items {
			r, ok := byID[items[i].VideoID]
			if !ok {
				continue
			}
			if r.PublishedAt != "" {
				items[i].PublishedAt = r.PublishedAt
			}
			if r.PublishedMs > 0 {
				items[i].PublishedMs = r.PublishedMs
			}
			if r.LikeCount > items[i].LikeCount {
				items[i].LikeCount = r.LikeCount
			}
			if r.ViewCount > items[i].ViewCount {
				items[i].ViewCount = r.ViewCount
			}
			if items[i].Thumbnail == "" {
				items[i].Thumbnail = r.Thumbnail
			}
		}
	}
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func parseStreamsHTML(html, channelID, channelTitle string) []FeedItem {
	var items []FeedItem
	seen := map[string]bool{}
	re := regexp.MustCompile(`(?s)var ytInitialData = (\{.+?\});</script>`)
	if m := re.FindStringSubmatch(html); len(m) > 1 {
		var data any
		if err := json.Unmarshal([]byte(m[1]), &data); err == nil {
			var hits []lockupHit
			walkLockups(data, &hits)
			for _, hit := range hits {
				if seen[hit.ID] {
					continue
				}
				seen[hit.ID] = true
				thumb := hit.Thumbnail
				if thumb == "" {
					thumb = fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", hit.ID)
				}
				items = append(items, FeedItem{
					VideoID: hit.ID, Title: hit.Title, PublishedAt: hit.PublishedLabel, PublishedMs: hit.PublishedMs,
					ChannelID: channelID, ChannelTitle: channelTitle, Thumbnail: thumb,
					URL: "https://www.youtube.com/watch?v=" + hit.ID, IsLive: hit.IsLive, IsStream: true, ViewCount: hit.ViewCount,
				})
			}
		}
	}
	if len(items) == 0 {
		fallback := regexp.MustCompile(`"contentId":"([\w-]{11})"[\s\S]{0,500}?"content":"((?:\\.|[^"\\])*)"`)
		for _, m := range fallback.FindAllStringSubmatch(html, -1) {
			if seen[m[1]] {
				continue
			}
			seen[m[1]] = true
			title := decodeXML(strings.ReplaceAll(strings.ReplaceAll(m[2], `\"`, `"`), `\u0026`, "&"))
			if title == "" {
				title = "Stream"
			}
			items = append(items, FeedItem{
				VideoID: m[1], Title: title, ChannelID: channelID, ChannelTitle: channelTitle,
				Thumbnail: fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", m[1]),
				URL:       "https://www.youtube.com/watch?v=" + m[1], IsStream: true,
			})
		}
	}
	return items
}

func (c *Client) FetchChannelStreams(channelID, channelTitle string, handle *string) ([]FeedItem, error) {
	var urls []string
	if handle != nil && *handle != "" {
		h := *handle
		if !strings.HasPrefix(h, "@") {
			urls = append(urls, "https://www.youtube.com/@"+h+"/streams")
		}
		urls = append(urls, "https://www.youtube.com/"+h+"/streams")
	}
	urls = append(urls, "https://www.youtube.com/channel/"+url.PathEscape(channelID)+"/streams")
	for _, u := range urls {
		html, status, err := c.getText(u, nil)
		if err != nil || status < 200 || status >= 300 {
			continue
		}
		items := parseStreamsHTML(html, channelID, channelTitle)
		if len(items) > 0 {
			return items, nil
		}
	}
	return nil, nil
}

func (c *Client) FetchTopComments(videoID string, limit int) ([]CommentItem, error) {
	if !videoIDRe.MatchString(videoID) {
		return nil, fmt.Errorf("invalid video id")
	}
	if limit <= 0 {
		limit = 30
	}
	html, status, err := c.getText("https://www.youtube.com/watch?v="+url.QueryEscape(videoID), nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("could not open video (%d)", status)
	}
	apiKey, clientVersion := "", ""
	if m := regexp.MustCompile(`"INNERTUBE_API_KEY":"([^"]+)"`).FindStringSubmatch(html); len(m) > 1 {
		apiKey = m[1]
	}
	if m := regexp.MustCompile(`"INNERTUBE_CLIENT_VERSION":"([^"]+)"`).FindStringSubmatch(html); len(m) > 1 {
		clientVersion = m[1]
	}
	if apiKey == "" || clientVersion == "" {
		return nil, fmt.Errorf("could not bootstrap YouTube client")
	}
	nextURL := "https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=" + url.QueryEscape(apiKey)
	ctx := map[string]any{
		"client": map[string]any{"clientName": "WEB", "clientVersion": clientVersion, "hl": "en", "gl": "US"},
	}
	nextJSON, _, err := c.postJSON(nextURL, map[string]any{"context": ctx, "videoId": videoID})
	if err != nil {
		return nil, fmt.Errorf("comments bootstrap failed: %w", err)
	}
	var panelContent any
	if panels, ok := nextJSON["engagementPanels"].([]any); ok {
		for _, p := range panels {
			pm, _ := p.(map[string]any)
			ep, _ := pm["engagementPanelSectionListRenderer"].(map[string]any)
			if id, _ := ep["panelIdentifier"].(string); id == "engagement-panel-comments-section" {
				panelContent = ep["content"]
				break
			}
		}
	}
	token := findContinuationToken(panelContent)
	if token == "" {
		return nil, nil
	}
	contJSON, _, err := c.postJSON(nextURL, map[string]any{"context": ctx, "continuation": token})
	if err != nil {
		return nil, fmt.Errorf("comments fetch failed: %w", err)
	}
	var out []CommentItem
	seen := map[string]bool{}
	var walk func(any)
	walk = func(node any) {
		if node == nil || len(out) >= limit {
			return
		}
		switch v := node.(type) {
		case map[string]any:
			if entity, ok := v["commentEntityPayload"].(map[string]any); ok {
				props, _ := entity["properties"].(map[string]any)
				content, _ := props["content"].(map[string]any)
				text, _ := content["content"].(string)
				if text != "" {
					id, _ := props["commentId"].(string)
					if id == "" {
						if len(text) > 24 {
							id = text[:24]
						} else {
							id = text
						}
					}
					if !seen[id] {
						seen[id] = true
						author := "User"
						if a, ok := entity["author"].(map[string]any); ok {
							if n, ok := a["displayName"].(string); ok && n != "" {
								author = n
							}
						}
						likes := ""
						if tb, ok := entity["toolbar"].(map[string]any); ok {
							if l, ok := tb["likeCountNotliked"].(string); ok {
								likes = l
							} else if l, ok := tb["likeCountLiked"].(string); ok {
								likes = l
							}
						}
						published, _ := props["publishedTime"].(string)
						out = append(out, CommentItem{ID: id, Author: author, Text: text, Likes: likes, Published: published})
					}
				}
			}
			for _, child := range v {
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(contJSON)
	return out, nil
}
