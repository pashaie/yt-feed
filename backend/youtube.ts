export type ResolvedChannel = {
  id: string;
  title: string;
  handle: string | null;
  thumbnail: string | null;
};

export type FeedItem = {
  videoId: string;
  title: string;
  publishedAt: string;
  publishedMs: number;
  channelId: string;
  channelTitle: string;
  thumbnail: string;
  url: string;
  /** Currently broadcasting */
  isLive: boolean;
  /** From channel /streams tab (past or present livestreams) */
  isStream: boolean;
  viewCount: number;
  likeCount: number;
};

export type CommentItem = {
  id: string;
  author: string;
  text: string;
  likes: string;
  published: string;
};

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const YT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
  // Avoid consent interstitial so ytInitialData includes the grid.
  Cookie:
    'CONSENT=YES+cb.20210328-17-p0.en+FX+123; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJn5pwY',
};

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function extractAttr(block: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"[^>]*/?>`, 'i');
  const m = block.match(re);
  return m ? decodeXml(m[1]) : null;
}

export function normalizeInput(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function parseCompactCount(text: string | null | undefined): number {
  if (!text) return 0;
  const m = String(text)
    .trim()
    .replace(/,/g, '')
    .match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) {
    const digits = String(text).replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }
  let n = Number(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (u === 'K') n *= 1e3;
  else if (u === 'M') n *= 1e6;
  else if (u === 'B') n *= 1e9;
  return Math.round(n) || 0;
}

function extractChannelIdFromHtml(html: string): string | null {
  // Prefer page identity fields — generic "channelId" appears for related channels too.
  const patterns = [
    /<link\s+rel="canonical"\s+href="[^"]*\/channel\/(UC[\w-]{22})"/i,
    /<meta\s+property="og:url"\s+content="[^"]*\/channel\/(UC[\w-]{22})"/i,
    /"externalId":"(UC[\w-]{22})"/,
    /"browseId":"(UC[\w-]{22})"/,
    /<meta\s+itemprop="channelId"\s+content="(UC[\w-]{22})"/i,
    /\/channel\/(UC[\w-]{22})/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractTitleFromHtml(html: string): string | null {
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (og) return decodeXml(og[1].replace(/\s*-\s*YouTube\s*$/i, '').trim());
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) return decodeXml(title[1].replace(/\s*-\s*YouTube\s*$/i, '').trim());
  return null;
}

function extractThumbnailFromHtml(html: string): string | null {
  const og = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return og ? decodeXml(og[1]) : null;
}

function extractHandleFromHtml(html: string): string | null {
  const m =
    html.match(/"vanityChannelUrl":"http(?:s)?:\/\/www\.youtube\.com\/(@[\w.-]+)"/) ||
    html.match(/"canonicalBaseUrl":"\/(@[\w.-]+)"/) ||
    html.match(/href="https:\/\/www\.youtube\.com\/(@[\w.-]+)"/);
  return m ? m[1] : null;
}

function guessUrl(input: string): string {
  if (CHANNEL_ID_RE.test(input)) {
    return `https://www.youtube.com/channel/${input}`;
  }
  if (input.startsWith('@')) {
    return `https://www.youtube.com/${input}`;
  }
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  if (/^[\w.-]+$/.test(input)) {
    return `https://www.youtube.com/@${input}`;
  }
  throw new Error('Unrecognized channel input');
}

export async function resolveChannel(raw: string): Promise<ResolvedChannel> {
  const input = normalizeInput(raw);
  if (!input) throw new Error('Empty channel');

  let channelId: string | null = null;
  if (CHANNEL_ID_RE.test(input)) {
    channelId = input;
  } else {
    const fromUrl = input.match(/\/channel\/(UC[\w-]{22})/);
    if (fromUrl) channelId = fromUrl[1];
  }

  const url = guessUrl(input);
  const res = await fetch(url, {
    headers: YT_HEADERS,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Could not open channel (${res.status})`);
  const html = await res.text();

  channelId = channelId || extractChannelIdFromHtml(html);
  if (!channelId) throw new Error('Could not resolve channel id');

  const title = extractTitleFromHtml(html) || channelId;
  const thumbnail = extractThumbnailFromHtml(html);
  const handle = extractHandleFromHtml(html) || (input.startsWith('@') ? input : null);

  return { id: channelId, title, handle, thumbnail };
}

export async function fetchChannelRss(
  channelId: string,
  channelTitle: string,
): Promise<FeedItem[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url, {
    headers: {
      ...YT_HEADERS,
      Accept: 'application/atom+xml,application/xml,text/xml',
    },
  });
  if (!res.ok) throw new Error(`RSS failed for ${channelId} (${res.status})`);
  const xml = await res.text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const items: FeedItem[] = [];

  for (const entry of entries) {
    const videoId =
      extractTag(entry, 'yt:videoId') ||
      extractAttr(entry, 'yt:videoId', 'id') ||
      (entry.match(/watch\?v=([\w-]{11})/) || [])[1];
    if (!videoId) continue;

    const title = extractTag(entry, 'title') || 'Untitled';
    const publishedAt = extractTag(entry, 'published') || extractTag(entry, 'updated') || '';
    const publishedMs = publishedAt ? Date.parse(publishedAt) : 0;
    const mediaTitle = extractTag(entry, 'media:title');
    const thumb =
      extractAttr(entry, 'media:thumbnail', 'url') ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const views = Number(extractAttr(entry, 'media:statistics', 'views') || 0);
    const likes = Number(extractAttr(entry, 'media:starRating', 'count') || 0);

    items.push({
      videoId,
      title: mediaTitle || title,
      publishedAt,
      publishedMs: Number.isFinite(publishedMs) ? publishedMs : 0,
      channelId,
      channelTitle,
      thumbnail: thumb,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      isLive: false,
      isStream: false,
      viewCount: Number.isFinite(views) ? views : 0,
      likeCount: Number.isFinite(likes) ? likes : 0,
    });
  }

  return items;
}

type LockupHit = {
  id: string;
  title: string;
  isLive: boolean;
  publishedLabel: string;
  publishedMs: number;
  viewCount: number;
};

/** Convert YouTube relative labels like "Streamed 8mo ago" / "3 days ago". */
export function parseRelativePublished(text: string): number | null {
  if (!text) return null;
  const cleaned = text.replace(/^Streamed\s+/i, '').trim();
  const m = cleaned.match(
    /^(\d+)\s*(mo|months?|yr|years?|w|weeks?|d|days?|h|hours?|m|minutes?|s|seconds?)\s*ago$/i,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const day = 86400000;
  let mult = 0;
  if (unit === 'mo' || unit.startsWith('month')) mult = 30 * day;
  else if (unit === 'yr' || unit.startsWith('year')) mult = 365 * day;
  else if (unit === 'w' || unit.startsWith('week')) mult = 7 * day;
  else if (unit === 'd' || unit.startsWith('day')) mult = day;
  else if (unit === 'h' || unit.startsWith('hour')) mult = 3600000;
  else if (unit === 'm' || unit.startsWith('min')) mult = 60000;
  else if (unit === 's' || unit.startsWith('sec')) mult = 1000;
  if (!mult || !Number.isFinite(n)) return null;
  return Date.now() - n * mult;
}

function walkLockups(node: unknown, out: LockupHit[] = []): LockupHit[] {
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  const lockup = obj.lockupViewModel as
    | {
        contentId?: string;
        metadata?: {
          lockupMetadataViewModel?: {
            title?: { content?: string };
            metadata?: {
              contentMetadataViewModel?: {
                metadataRows?: Array<{
                  metadataParts?: Array<{
                    text?: { content?: string };
                    accessibilityLabel?: string;
                  }>;
                }>;
              };
            };
          };
        };
        contentImage?: {
          thumbnailViewModel?: {
            overlays?: Array<{
              thumbnailBottomOverlayViewModel?: {
                badges?: Array<{ thumbnailBadgeViewModel?: { text?: string; badgeStyle?: string } }>;
              };
              thumbnailOverlayTimeStatusViewModel?: { text?: string; style?: string };
            }>;
          };
        };
      }
    | undefined;

  if (lockup?.contentId && /^[\w-]{11}$/.test(lockup.contentId)) {
    const meta = lockup.metadata?.lockupMetadataViewModel;
    const title = meta?.title?.content || 'Stream';
    const parts =
      meta?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(
        (row) => row.metadataParts || [],
      ) || [];
    const publishedLabel =
      parts
        .map((p) => p.text?.content || p.accessibilityLabel || '')
        .find((t) => /ago|Streamed|Live/i.test(t)) || '';
    const publishedMs = parseRelativePublished(publishedLabel) || 0;
    const viewPart = parts.find(
      (p) =>
        /view/i.test(p.accessibilityLabel || '') ||
        /^[\d.,]+\s*[KMB]?$/i.test((p.text?.content || '').trim()),
    );
    const viewCount = parseCompactCount(
      viewPart?.accessibilityLabel?.match(/([\d.,]+\s*[KMB]?)/i)?.[1] ||
        viewPart?.text?.content ||
        '',
    );
    const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];
    const badgeText = overlays
      .flatMap((o) => [
        ...(o.thumbnailBottomOverlayViewModel?.badges || []).map(
          (b) => b.thumbnailBadgeViewModel?.text || '',
        ),
        o.thumbnailOverlayTimeStatusViewModel?.text || '',
        o.thumbnailOverlayTimeStatusViewModel?.style || '',
      ])
      .join(' ');
    const isLive = /LIVE/i.test(badgeText) || /^(Live now|LIVE)$/i.test(publishedLabel);
    out.push({ id: lockup.contentId, title, isLive, publishedLabel, publishedMs, viewCount });
  }

  if (Array.isArray(node)) {
    for (const child of node) walkLockups(child, out);
  } else {
    for (const value of Object.values(obj)) walkLockups(value, out);
  }
  return out;
}

function parseStreamsHtml(
  html: string,
  channelId: string,
  channelTitle: string,
): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  const initial = html.match(/var ytInitialData = (\{.+?\});<\/script>/s);
  if (initial) {
    try {
      const data = JSON.parse(initial[1]);
      for (const hit of walkLockups(data)) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        items.push({
          videoId: hit.id,
          title: hit.title,
          publishedAt: hit.publishedLabel,
          publishedMs: hit.publishedMs,
          channelId,
          channelTitle,
          thumbnail: `https://i.ytimg.com/vi/${hit.id}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${hit.id}`,
          isLive: hit.isLive,
          isStream: true,
          viewCount: hit.viewCount,
          likeCount: 0,
        });
      }
    } catch {
      /* fall through */
    }
  }

  if (items.length === 0) {
    const re =
      /"contentId":"([\w-]{11})"[\s\S]{0,500}?"content":"((?:\\.|[^"\\])*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      items.push({
        videoId: m[1],
        title: decodeXml(m[2].replace(/\\"/g, '"').replace(/\\u0026/g, '&')) || 'Stream',
        publishedAt: '',
        publishedMs: 0,
        channelId,
        channelTitle,
        thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${m[1]}`,
        isLive: false,
        isStream: true,
        viewCount: 0,
        likeCount: 0,
      });
    }
  }

  return items;
}

function findContinuationToken(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const cmd = obj.continuationCommand as { token?: string } | undefined;
  if (cmd?.token) return cmd.token;
  if (typeof obj.continuation === 'string' && obj.continuation.length > 20) {
    return obj.continuation;
  }
  for (const value of Object.values(obj)) {
    const found = findContinuationToken(value);
    if (found) return found;
  }
  return null;
}

/** Top-level comments for a video (on demand — not part of feed refresh). */
export async function fetchTopComments(videoId: string, limit = 30): Promise<CommentItem[]> {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid video id');

  const page = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: YT_HEADERS,
    redirect: 'follow',
  });
  if (!page.ok) throw new Error(`Could not open video (${page.status})`);
  const html = await page.text();
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  if (!apiKey || !clientVersion) throw new Error('Could not bootstrap YouTube client');

  const nextHeaders = { ...YT_HEADERS, 'Content-Type': 'application/json' };
  const nextRes = await fetch(
    `https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=${apiKey}`,
    {
      method: 'POST',
      headers: nextHeaders,
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
        videoId,
      }),
    },
  );
  if (!nextRes.ok) throw new Error(`Comments bootstrap failed (${nextRes.status})`);
  const nextJson = (await nextRes.json()) as {
    engagementPanels?: Array<{
      engagementPanelSectionListRenderer?: {
        panelIdentifier?: string;
        content?: unknown;
      };
    }>;
  };

  const panel = (nextJson.engagementPanels || []).find(
    (p) =>
      p.engagementPanelSectionListRenderer?.panelIdentifier ===
      'engagement-panel-comments-section',
  )?.engagementPanelSectionListRenderer;

  const token = findContinuationToken(panel?.content);
  if (!token) return [];

  const contRes = await fetch(
    `https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=${apiKey}`,
    {
      method: 'POST',
      headers: nextHeaders,
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
        continuation: token,
      }),
    },
  );
  if (!contRes.ok) throw new Error(`Comments fetch failed (${contRes.status})`);
  const contJson = await contRes.json();

  const out: CommentItem[] = [];
  const seen = new Set<string>();
  function walk(node: unknown) {
    if (!node || typeof node !== 'object' || out.length >= limit) return;
    const obj = node as Record<string, unknown>;
    const entity = obj.commentEntityPayload as
      | {
          properties?: {
            commentId?: string;
            content?: { content?: string };
            publishedTime?: string;
          };
          author?: { displayName?: string };
          toolbar?: { likeCountNotliked?: string; likeCountLiked?: string };
        }
      | undefined;
    if (entity?.properties?.content?.content) {
      const id = entity.properties.commentId || entity.properties.content.content.slice(0, 24);
      if (!seen.has(id)) {
        seen.add(id);
        out.push({
          id,
          author: entity.author?.displayName || 'User',
          text: entity.properties.content.content,
          likes:
            entity.toolbar?.likeCountNotliked ||
            entity.toolbar?.likeCountLiked ||
            '',
          published: entity.properties.publishedTime || '',
        });
      }
    }
    if (Array.isArray(node)) for (const child of node) walk(child);
    else for (const value of Object.values(obj)) walk(value);
  }
  walk(contJson);
  return out;
}

/** Past + current livestreams from the channel Streams tab. */
export async function fetchChannelStreams(
  channelId: string,
  channelTitle: string,
  handle?: string | null,
): Promise<FeedItem[]> {
  const urls = [
    handle ? `https://www.youtube.com/${handle.replace(/^@/, '@')}/streams` : null,
    handle && !handle.startsWith('@') ? `https://www.youtube.com/@${handle}/streams` : null,
    `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/streams`,
  ].filter(Boolean) as string[];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: YT_HEADERS, redirect: 'follow' });
      if (!res.ok) continue;
      const html = await res.text();
      const items = parseStreamsHtml(html, channelId, channelTitle);
      if (items.length > 0) return items;
    } catch {
      /* try next */
    }
  }
  return [];
}
