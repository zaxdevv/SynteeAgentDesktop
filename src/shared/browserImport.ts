export interface BrowserImportSource {
  id: string
  browser: 'chrome' | 'edge'
  name: string
  bookmarks: boolean
  history: boolean
}

export interface BrowserImportOptions {
  sourceId: string
  name: string
  bookmarks: boolean
  history: boolean
}

export interface BrowserImportResult {
  ok: boolean
  profile?: { id: string; name: string }
  bookmarks: number
  history: number
  warnings: string[]
  error?: string
}

export interface BrowserDataPage {
  items: Array<{ title: string; url: string; folder?: string; lastVisited?: number }>
  total: number
}
