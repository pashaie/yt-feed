package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/pashaie/yt-feed/internal/appdata"
	"github.com/pashaie/yt-feed/internal/db"
	"github.com/pashaie/yt-feed/internal/httpx"
	"github.com/pashaie/yt-feed/internal/services"
	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	paths, err := appdata.Resolve()
	if err != nil {
		log.Fatal(err)
	}

	database, err := db.Open(paths.DBPath())
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()

	httpMgr, err := httpx.NewManager(paths.SettingsPath())
	if err != nil {
		log.Fatal(err)
	}

	appSvc := services.NewAppService(paths, database, httpMgr)

	assetFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	fileServer := http.FileServerFS(assetFS)
	thumbsDir := paths.ThumbsDir()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/thumbs/") {
			name := filepath.Base(r.URL.Path)
			if name == "." || name == "/" || !strings.HasSuffix(strings.ToLower(name), ".jpg") {
				http.NotFound(w, r)
				return
			}
			path := filepath.Join(thumbsDir, name)
			if st, err := os.Stat(path); err != nil || st.IsDir() {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, path)
			return
		}
		fileServer.ServeHTTP(w, r)
	})

	app := application.New(application.Options{
		Name:        "YT Feed",
		Description: "Desktop YouTube subscriptions feed",
		Services: []application.Service{
			application.NewService(appSvc),
		},
		Assets: application.AssetOptions{
			Handler: handler,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "YT Feed",
		Width:  1100,
		Height: 720,
		URL:    "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
