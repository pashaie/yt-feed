package httpx

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/mattn/go-ieproxy"
)

// Mode selects how outbound HTTP traffic is proxied.
type Mode string

const (
	ModeOff    Mode = "off"
	ModeSystem Mode = "system"
	ModeCustom Mode = "custom"
)

// Config is persisted proxy settings.
// Resolved is runtime-only (detected active proxy for UI); never written to disk.
type Config struct {
	Mode     Mode   `json:"mode"`
	URL      string `json:"url"`
	Resolved string `json:"resolved,omitempty"`
}

// Manager owns a shared *http.Client rebuilt when proxy settings change.
type Manager struct {
	mu     sync.RWMutex
	cfg    Config
	client *http.Client
	path   string
}

func DefaultConfig() Config {
	return Config{Mode: ModeSystem}
}

func NewManager(settingsPath string) (*Manager, error) {
	m := &Manager{path: settingsPath, cfg: DefaultConfig()}
	if err := m.load(); err != nil {
		return nil, err
	}
	if err := m.rebuild(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manager) Get() Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	cfg := m.cfg
	cfg.Resolved = m.resolvedLocked(cfg)
	return cfg
}

func (m *Manager) Client() *http.Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.client
}

// ReloadSystemProxy re-reads OS proxy settings when mode is system, then rebuilds the client.
// Call this at the start of a feed refresh so a changed local proxy port is picked up.
func (m *Manager) ReloadSystemProxy() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg.Mode != ModeSystem {
		return nil
	}
	return m.rebuildLocked()
}

func (m *Manager) Set(cfg Config) error {
	if cfg.Mode == "" {
		cfg.Mode = ModeSystem
	}
	switch cfg.Mode {
	case ModeOff, ModeSystem, ModeCustom:
	default:
		return fmt.Errorf("invalid proxy mode %q", cfg.Mode)
	}
	if cfg.Mode == ModeCustom {
		if cfg.URL == "" {
			return fmt.Errorf("custom proxy URL is required")
		}
		if _, err := url.Parse(cfg.URL); err != nil {
			return fmt.Errorf("invalid proxy URL: %w", err)
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg = Config{Mode: cfg.Mode, URL: cfg.URL}
	if err := m.rebuildLocked(); err != nil {
		return err
	}
	return m.saveLocked()
}

func (m *Manager) load() error {
	data, err := os.ReadFile(m.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if cfg.Mode == "" {
		cfg.Mode = ModeSystem
	}
	// Never trust Resolved from disk.
	m.cfg = Config{Mode: cfg.Mode, URL: cfg.URL}
	return nil
}

func (m *Manager) saveLocked() error {
	data, err := json.MarshalIndent(Config{Mode: m.cfg.Mode, URL: m.cfg.URL}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.path, data, 0o644)
}

func (m *Manager) rebuild() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rebuildLocked()
}

func (m *Manager) rebuildLocked() error {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	switch m.cfg.Mode {
	case ModeOff:
		tr.Proxy = nil
	case ModeCustom:
		u, err := url.Parse(m.cfg.URL)
		if err != nil {
			return err
		}
		tr.Proxy = http.ProxyURL(u)
	case ModeSystem:
		fallthrough
	default:
		// ReloadConf busts ieproxy's sync.Once cache so a new local proxy port is seen.
		ieproxy.ReloadConf()
		tr.Proxy = ieproxy.GetProxyFunc()
	}
	m.client = &http.Client{
		Transport: tr,
		Timeout:   60 * time.Second,
	}
	return nil
}

func (m *Manager) resolvedLocked(cfg Config) string {
	switch cfg.Mode {
	case ModeOff:
		return ""
	case ModeCustom:
		return cfg.URL
	case ModeSystem:
		fallthrough
	default:
		ieproxy.ReloadConf()
		return resolveSystemProxyURL()
	}
}

func resolveSystemProxyURL() string {
	conf := ieproxy.GetConf()
	if conf.Static.Active {
		for _, key := range []string{"https", "http", ""} {
			if v := strings.TrimSpace(conf.Static.Protocols[key]); v != "" {
				return normalizeProxyURL(v)
			}
		}
	}
	if conf.Automatic.Active {
		if u := strings.TrimSpace(conf.Automatic.PreConfiguredURL); u != "" {
			return "pac:" + u
		}
		req, err := http.NewRequest(http.MethodGet, "https://www.youtube.com/", nil)
		if err == nil {
			if pu, err := ieproxy.GetProxyFunc()(req); err == nil && pu != nil {
				return pu.String()
			}
		}
		return "auto-detect"
	}
	return ""
}

func normalizeProxyURL(v string) string {
	if strings.Contains(v, "://") {
		return v
	}
	return "http://" + v
}
