export type Channel = {
  id: string
  title: string
  handle: string | null
  thumbnail: string | null
  color: string | null
  added_at: number
}

export type FeedItem = {
  videoId: string
  title: string
  publishedAt: string
  publishedMs: number
  channelId: string
  channelTitle: string
  channelColor: string
  thumbnail: string
  url: string
  isLive: boolean
  isStream: boolean
  viewCount: number
  likeCount: number
  isRead: boolean
  isLiked: boolean
  isLater: boolean
  isArchived: boolean
  isHidden: boolean
}

export type CommentItem = {
  id: string
  author: string
  text: string
  likes: string
  published: string
}

export type FeedFilter =
  | 'subscriptions'
  | 'unread'
  | 'liked'
  | 'later'
  | 'archived'
  | 'streams'
  | 'videos'

export type ImportResult = {
  total: number
  added: number
  failed: number
  results: Array<{
    input: string
    ok: boolean
    error?: string
    channel?: Channel
  }>
}

export type VideoFlags = {
  isRead: boolean
  isLiked: boolean
  isLater: boolean
  isArchived: boolean
  isHidden: boolean
}
