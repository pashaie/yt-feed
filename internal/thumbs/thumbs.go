package thumbs

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

const thumbUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

type Item struct {
	VideoID   string
	Thumbnail string
}

func Cache(client *http.Client, cacheRoot string, items []Item, concurrency int) (map[string]string, error) {
	if concurrency <= 0 {
		concurrency = 8
	}
	dir := filepath.Join(cacheRoot, "thumbs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	out := make(map[string]string)
	var mu sync.Mutex
	var wg sync.WaitGroup
	ch := make(chan Item)

	worker := func() {
		defer wg.Done()
		for item := range ch {
			local, err := downloadOne(client, dir, item.VideoID, item.Thumbnail)
			if err != nil || local == "" {
				continue
			}
			mu.Lock()
			out[item.VideoID] = local
			mu.Unlock()
		}
	}

	n := concurrency
	if len(items) < n {
		n = len(items)
	}
	if n < 1 {
		n = 1
	}
	wg.Add(n)
	for i := 0; i < n; i++ {
		go worker()
	}
	for _, item := range items {
		ch <- item
	}
	close(ch)
	wg.Wait()

	keep := map[string]bool{}
	for _, item := range items {
		keep[item.VideoID+".jpg"] = true
	}
	entries, err := os.ReadDir(dir)
	if err == nil {
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || filepath.Ext(name) != ".jpg" {
				continue
			}
			if !keep[name] {
				_ = os.Remove(filepath.Join(dir, name))
			}
		}
	}
	return out, nil
}

func downloadOne(client *http.Client, dir, videoID, remoteURL string) (string, error) {
	path := filepath.Join(dir, videoID+".jpg")
	if st, err := os.Stat(path); err == nil && !st.IsDir() {
		return path, nil
	}
	candidates := []string{
		remoteURL,
		fmt.Sprintf("https://i.ytimg.com/vi/%s/hqdefault.jpg", videoID),
		fmt.Sprintf("https://i.ytimg.com/vi/%s/mqdefault.jpg", videoID),
	}
	for _, u := range candidates {
		if u == "" {
			continue
		}
		req, err := http.NewRequest(http.MethodGet, u, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", thumbUA)
		req.Header.Set("Accept", "image/*,*/*")
		res, err := client.Do(req)
		if err != nil {
			continue
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || res.StatusCode < 200 || res.StatusCode >= 300 || len(body) < 200 {
			continue
		}
		if err := os.WriteFile(path, body, 0o644); err != nil {
			return "", err
		}
		return path, nil
	}
	return "", nil
}
