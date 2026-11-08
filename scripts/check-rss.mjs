const id = 'UCHnyfMqiRRG1u-2MsSQLbXA'
const rss = await (await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id)).text()
const entry = (rss.match(/<entry>[\s\S]*?<\/entry>/) || [])[0] || ''
console.log(entry)
