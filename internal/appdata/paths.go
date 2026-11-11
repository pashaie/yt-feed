package appdata

import (
	"os"
	"path/filepath"
)

// Paths holds persistent data and cache directories for the app.
type Paths struct {
	Data  string
	Cache string
}

// Resolve returns %LOCALAPPDATA%/YT Feed/{data,cache} on Windows
// (or the OS user config dir elsewhere).
func Resolve() (Paths, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return Paths{}, err
	}
	// Prefer LocalAppData on Windows for cache-friendly storage.
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		base = local
	}
	root := filepath.Join(base, "YT Feed")
	p := Paths{
		Data:  filepath.Join(root, "data"),
		Cache: filepath.Join(root, "cache"),
	}
	if err := os.MkdirAll(p.Data, 0o755); err != nil {
		return Paths{}, err
	}
	if err := os.MkdirAll(p.Cache, 0o755); err != nil {
		return Paths{}, err
	}
	return p, nil
}

func (p Paths) DBPath() string {
	return filepath.Join(p.Data, "channels.db")
}

func (p Paths) SettingsPath() string {
	return filepath.Join(p.Data, "settings.json")
}

func (p Paths) ThumbsDir() string {
	return filepath.Join(p.Cache, "thumbs")
}
