import type { BrowserTab } from "./types"

export const OPEN_IN_BROWSER_LABEL = "Open in your browser"

export type BrowserLibraryItem = {
  id: string
  title: string
  url: string
  favicon?: string
  detail?: string
}

export function getWebsiteUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "https:" || url.protocol === "http:") return url.href
  } catch { }
}

export function isTabResponse(value: unknown): value is { tabs: BrowserTab[] } {
  if (typeof value !== "object" || value === null) return false
  const tabs = Reflect.get(value, "tabs")
  return Array.isArray(tabs) && tabs.every((tab) => {
    if (typeof tab !== "object" || tab === null) return false
    const loaded = Reflect.get(tab, "loaded")
    const favicon = Reflect.get(tab, "favicon")
    const lastAccessed = Reflect.get(tab, "lastAccessed")
    return typeof Reflect.get(tab, "targetId") === "string"
      && typeof Reflect.get(tab, "url") === "string"
      && typeof Reflect.get(tab, "title") === "string"
      && typeof Reflect.get(tab, "active") === "boolean"
      && (loaded === null || typeof loaded === "boolean")
      && (favicon == null || typeof favicon === "string")
      && (lastAccessed == null || typeof lastAccessed === "number" && Number.isFinite(lastAccessed))
  })
}

export function getBrowserStreamUrl(targetId: string, sessionId?: string, isShowingAll = false, fps = 2) {
  const query = new URLSearchParams({ fps: String(fps) })
  if (sessionId) query.set("session", sessionId)
  if (isShowingAll) query.set("all", "true")
  return `/api/native/browser/tabs/${encodeURIComponent(targetId)}/stream.mjpeg?${query}`
}

export function parseBrowserLibrary(value: unknown, kind: "history" | "bookmarks"): BrowserLibraryItem[] {
  if (typeof value !== "object" || value === null || !Array.isArray(Reflect.get(value, "items"))) {
    throw new Error("Invalid browser library response.")
  }
  return Reflect.get(value, "items").flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const url = Reflect.get(item, "url")
    if (typeof url !== "string" || !getWebsiteUrl(url)) return []
    const title = Reflect.get(item, "title")
    const id = Reflect.get(item, "id")
    const favicon = Reflect.get(item, "faviconUrl")
    const visitCount = Reflect.get(item, "visitCount")
    return [{
      id: typeof id === "string" ? id : `${kind}:${url}`,
      title: typeof title === "string" && title.trim() ? title : new URL(url).hostname,
      url,
      favicon: typeof favicon === "string" && favicon ? favicon : undefined,
      detail: kind === "history" && typeof visitCount === "number" && Number.isSafeInteger(visitCount) && visitCount >= 0 ? `${visitCount} visits` : undefined,
    }]
  })
}
