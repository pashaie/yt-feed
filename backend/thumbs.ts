const THUMB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await tjs.stat(path);
    return !!(st && !st.isDirectory);
  } catch {
    return false;
  }
}

async function downloadOne(dir: string, videoId: string, remoteUrl: string): Promise<string | null> {
  const path = `${dir}/${videoId}.jpg`;
  if (await fileExists(path)) return path;

  const candidates = [
    remoteUrl,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
  ].filter(Boolean);

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': THUMB_UA, Accept: 'image/*,*/*' },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 200) continue;
      await tjs.writeFile(path, buf);
      return path;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Download missing thumbs into cacheDir/thumbs; prune files not in keep set. */
export async function cacheThumbnails(
  cacheRoot: string,
  items: Array<{ videoId: string; thumbnail?: string | null }>,
  concurrency = 8,
): Promise<Map<string, string>> {
  const dir = `${cacheRoot.replace(/[/\\]+$/, '')}/thumbs`;
  await tjs.makeDir(dir, { recursive: true });

  const map = new Map<string, string>();
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      const local = await downloadOne(dir, item.videoId, item.thumbnail || '');
      if (local) map.set(item.videoId, local);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
    worker(),
  );
  await Promise.all(workers);

  // Drop orphaned thumb files from previous refreshes.
  const keep = new Set(items.map((i) => `${i.videoId}.jpg`));
  try {
    const entries = await tjs.readDir(dir);
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!name || !name.endsWith('.jpg')) continue;
      if (keep.has(name)) continue;
      try {
        await tjs.remove(`${dir}/${name}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* prune is best-effort */
  }

  return map;
}
