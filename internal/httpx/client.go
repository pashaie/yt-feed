package httpx

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
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
type Config struct {
	Mode Mode   `json:"mode"`
	URL  string `json:"url"`
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
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg
}

func (m *Manager) Client() *http.Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.client
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
	m.cfg = cfg
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
	m.cfg = cfg
	return nil
}

func (m *Manager) saveLocked() error {
	data, err := json.MarshalIndent(m.cfg, "", "  ")
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
		// Prefer Windows WinINET / system proxy; also honor env vars.
		ieproxy.OverrideEnvWithStaticProxy()
		tr.Proxy = ieproxy.GetProxyFunc()
	}
	m.client = &http.Client{
		Transport: tr,
		Timeout:   60 * time.Second,
	}
	return nil
}
