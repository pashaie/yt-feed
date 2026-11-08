const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  Cookie:
    'CONSENT=YES+cb.20210328-17-p0.en+FX+123; SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgJn5pwY',
}

const page = await fetch('https://www.youtube.com/watch?v=rL0qEmTRI-I', { headers })
const html = await page.text()
const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1]

const next = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${apiKey}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
    videoId: 'rL0qEmTRI-I',
  }),
})
const json = await next.json()
const panel = (json.engagementPanels || []).find(
  (p) => p.engagementPanelSectionListRenderer?.panelIdentifier === 'engagement-panel-comments-section',
)?.engagementPanelSectionListRenderer

function findToken(node) {
  if (!node || typeof node !== 'object') return null
  if (node.continuationCommand?.token) return node.continuationCommand.token
  if (typeof node.continuation === 'string' && node.continuation.length > 20) return node.continuation
  for (const v of Object.values(node)) {
    const t = findToken(v)
    if (t) return t
  }
  return null
}

const token = findToken(panel?.content)
console.log('token len', token?.length, token?.slice(0, 40))

const cont = await fetch(`https://www.youtube.com/youtubei/v1/next?prettyPrint=false&key=${apiKey}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
    continuation: token,
  }),
})
const raw = await cont.text()
console.log('cont status', cont.status, 'starts', raw.slice(0, 40))
const cjson = JSON.parse(raw)
const ctext = JSON.stringify(cjson)
console.log(
  'markers',
  Object.fromEntries(
    ['commentRenderer', 'commentEntityPayload', 'commentViewModel', 'contentText'].map((k) => [
      k,
      (ctext.match(new RegExp(k, 'g')) || []).length,
    ]),
  ),
)

const out = []
function walk(node) {
  if (!node || typeof node !== 'object') return
  if (node.commentRenderer) {
    const c = node.commentRenderer
    out.push({
      author: c.authorText?.simpleText,
      text: (c.contentText?.runs || []).map((r) => r.text).join(''),
      likes: c.voteCount?.simpleText || String(c.likeCount ?? ''),
      published: c.publishedTimeText?.simpleText,
    })
  }
  if (node.commentEntityPayload) {
    const c = node.commentEntityPayload
    out.push({
      author: c.author?.displayName,
      text: c.properties?.content?.content,
      likes: c.toolbar?.likeCountNotliked || c.toolbar?.likeCountLiked || '',
      published: c.properties?.publishedTime,
    })
  }
  if (Array.isArray(node)) node.forEach(walk)
  else Object.values(node).forEach(walk)
}
walk(cjson)
console.log('parsed', out.length)
console.log(out.slice(0, 5))
