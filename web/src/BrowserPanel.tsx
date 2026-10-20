import * as stylex from "@stylexjs/stylex"
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CornerDownLeft,
  ExternalLink,
  Focus,
  Globe2,
  History,
  Maximize2,
  MousePointer2,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { AnimatePresence } from "motion/react"
import { formatRequestError } from "./errors"

import { tokens } from "./tokens.stylex"
import { focusDialogSurface, styles as ui } from "./ui"
import { useAutoRefresh } from "./useAutoRefresh"
import type { BrowserTab, UseChat } from "./types"
import { browserScrollDelta, getBrowserKey, getBrowserStreamUrl, getWebsiteUrl, isTabResponse, OPEN_IN_BROWSER_LABEL, parseBrowserLibrary, type BrowserControl, type BrowserLibraryItem } from "./browser"
import { ImagePreview } from "./ImagePreview"
import { Button } from "./Button"
import { Dialog, DialogActions, DialogDescription } from "./Dialog"

const TAB_REFRESH_INTERVAL_MS = 2_000
const PREVIEW_REFRESH_INTERVAL_MS = 1_000
const THUMBNAIL_REFRESH_INTERVAL_MS = 10_000
const BROWSER_REQUEST_TIMEOUT_MS = 60_000
const ICON_SIZE = 20
const ICON_STROKE = 1.8

type BrowserPanelProps = {
  request: UseChat['request']
  notify: (message: string, kind?: "error" | "success") => void
  onStart: (prompt: string) => void
  onClose: () => void
  sessionId?: string
  initialTargetId?: string
}

type PreviewStatus = "idle" | "loading" | "ready" | "asleep" | "missing" | "error"

export function BrowserPanel({ request, notify, onStart, onClose, sessionId, initialTargetId }: BrowserPanelProps) {
  const [isShowingAllTabs, setShowingAllTabs] = useState(false)
  const sessionQuery = sessionId ? `&session=${encodeURIComponent(sessionId)}${isShowingAllTabs ? '&all=true' : ''}` : ""
  const initialTargetRef = useRef(initialTargetId)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [selectedTab, setSelectedTab] = useState<BrowserTab>()
  const [query, setQuery] = useState("")
  const [isLoadingTabs, setIsLoadingTabs] = useState(true)
  const [listError, setListError] = useState<string>()
  const [instruction, setInstruction] = useState("")
  const [isOpenFormVisible, setIsOpenFormVisible] = useState(false)
  const [newTabUrl, setNewTabUrl] = useState("")
  const [openingTabs, setOpeningTabs] = useState<{ id: string; url: string }[]>([])
  const closingTabsRef = useRef(new Set<string>())
  const [previewFrame, setPreviewFrame] = useState<{ targetId: string; url: string }>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle")
  const [isPreviewExpanded, setPreviewExpanded] = useState(false)
  const [isDirectControl, setDirectControl] = useState(true)
  const [controlText, setControlText] = useState("")
  const [address, setAddress] = useState("")
  const [listMode, setListMode] = useState<"tabs" | "history" | "bookmarks">("tabs")
  const [libraryItems, setLibraryItems] = useState<BrowserLibraryItem[]>([])
  const [libraryError, setLibraryError] = useState<string>()
  const [isLoadingLibrary, setLoadingLibrary] = useState(false)
  const [busyAction, setBusyAction] = useState<string>()
  const [isConfirmingClose, setIsConfirmingClose] = useState(false)
  const listGenerationRef = useRef(0)
  const captureGenerationRef = useRef(0)
  const previewUrlRef = useRef<string | undefined>(undefined)
  const panelRef = useRef<HTMLElement>(null)
  const controlSurfaceRef = useRef<HTMLButtonElement>(null)
  const controlAbortRef = useRef<AbortController | undefined>(undefined)
  const controlTailRef = useRef<Promise<boolean | void>>(Promise.resolve())
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const cancelCloseRef = useRef<HTMLButtonElement>(null)
  const wasClosingRef = useRef(false)
  const selectedTargetRef = useRef<string | undefined>(undefined)
  const previewGestureRef = useRef<{ x: number; y: number; pointerId: number } | undefined>(undefined)
  const selectedTabId = selectedTab?.targetId
  const websiteUrl = selectedTab && getWebsiteUrl(selectedTab.url)
  const previewSource = previewFrame?.targetId === selectedTabId ? previewFrame?.url : undefined
  const isClosingTab = busyAction === "close"
  const isSelectedTabAsleep = selectedTab?.loaded === false
  const isSelectedTabMissing = !!selectedTabId && !tabs.some((tab) => tab.targetId === selectedTabId)
  const canControl = !!selectedTabId && !isSelectedTabAsleep && !isSelectedTabMissing

  useLayoutEffect(() => {
    const dialog = panelRef.current?.closest("dialog")
    if (dialog && document.activeElement === dialog) focusDialogSurface(dialog)
  }, [])

  useLayoutEffect(() => {
    if (selectedTab) {
      selectedTargetRef.current = selectedTab.targetId
      backButtonRef.current?.focus({ preventScroll: true })
    } else if (selectedTargetRef.current) {
      const buttons = [...panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-browser-tab]") ?? []]
      const target = buttons.find((button) => button.dataset.browserTab === selectedTargetRef.current) ?? buttons[0] ?? searchInputRef.current
      target?.focus({ preventScroll: true })
      selectedTargetRef.current = undefined
    }
  }, [selectedTab?.targetId])

  useLayoutEffect(() => {
    if (wasClosingRef.current && !isClosingTab) closeButtonRef.current?.focus({ preventScroll: true })
    wasClosingRef.current = isClosingTab
  }, [isClosingTab])

  const loadTabs = useCallback(async (signal?: AbortSignal) => {
    const generation = ++listGenerationRef.current
    setIsLoadingTabs(true)
    try {
      const response = await request(`/api/tabs?refresh=true${sessionQuery}`, { cache: "no-store", signal })
      const value: unknown = await response.json()
      if (signal?.aborted || generation !== listGenerationRef.current) return
      if (!isTabResponse(value)) throw new Error("Invalid tab list.")
      const sortedTabs = value.tabs.filter(tab => !closingTabsRef.current.has(tab.targetId))
      setTabs(sortedTabs)
      const initialTarget = initialTargetRef.current
      setSelectedTab((current) => sortedTabs.find((tab) => tab.targetId === (current?.targetId ?? initialTarget)))
      if (sortedTabs.some((tab) => tab.targetId === initialTarget)) initialTargetRef.current = undefined
      setListError(undefined)
    } catch (error) {
      if (!signal?.aborted && generation === listGenerationRef.current) setListError(getErrorMessage(error))
    } finally {
      if (generation === listGenerationRef.current) setIsLoadingTabs(false)
    }
  }, [request, sessionQuery])

  useAutoRefresh(loadTabs, TAB_REFRESH_INTERVAL_MS)

  useEffect(() => {
    return () => {
      listGenerationRef.current += 1
    }
  }, [])

  const capturePreview = useCallback(async (signal: AbortSignal) => {
    if (!selectedTabId || isSelectedTabAsleep || isSelectedTabMissing) return
    const generation = ++captureGenerationRef.current
    if (!previewUrlRef.current) setPreviewStatus("loading")
    let nextUrl: string | undefined
    try {
      const response = await request(
        `/api/tabs/${encodeURIComponent(selectedTabId)}/shot?fresh=true${sessionQuery}`,
        { cache: "no-store", signal },
      )
      const blob = await response.blob()
      if (!blob.type.startsWith("image/")) throw new Error("The preview was not an image.")
      nextUrl = URL.createObjectURL(blob)
      const image = new Image()
      image.src = nextUrl
      await image.decode()
      if (signal.aborted || generation !== captureGenerationRef.current) return
      const previousUrl = previewUrlRef.current
      previewUrlRef.current = nextUrl
      setPreviewFrame({ targetId: selectedTabId, url: nextUrl })
      nextUrl = undefined
      setPreviewStatus("ready")
      if (previousUrl) URL.revokeObjectURL(previousUrl)
    } catch (error) {
      if (signal.aborted || generation !== captureGenerationRef.current) return
      const status = getErrorStatus(error)
      setPreviewStatus(status === 409 ? "asleep" : status === 404 ? "missing" : "error")
    } finally {
      if (nextUrl) URL.revokeObjectURL(nextUrl)
    }
  }, [request, selectedTabId, isSelectedTabAsleep, isSelectedTabMissing, sessionQuery])

  useEffect(() => {
    captureGenerationRef.current += 1
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = undefined
    setPreviewFrame(undefined)
    setBusyAction(undefined)
    setPreviewExpanded(false)
    setDirectControl(true)
    setControlText("")
    setAddress(selectedTab?.url ?? "")
    setIsConfirmingClose(false)
    setPreviewStatus("idle")
    return () => { captureGenerationRef.current += 1 }
  }, [selectedTabId])

  useAutoRefresh(capturePreview, PREVIEW_REFRESH_INTERVAL_MS, !!selectedTabId && !isSelectedTabAsleep && !isSelectedTabMissing && !isClosingTab)

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (listMode === "tabs") return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoadingLibrary(true)
      const params = new URLSearchParams({ kind: listMode, query: query.trim() })
      if (sessionId) params.set("session", sessionId)
      void request(`/api/native/browser/library?${params}`, { cache: "no-store", signal: controller.signal })
        .then(response => response.json())
        .then((value: unknown) => {
          if (controller.signal.aborted) return
          setLibraryItems(parseBrowserLibrary(value, listMode))
          setLibraryError(undefined)
        })
        .catch(error => {
          if (!controller.signal.aborted) setLibraryError(getErrorMessage(error))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingLibrary(false)
        })
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [listMode, query, request, sessionId])

  const runTabAction = async (action: "focus" | "open" | "close") => {
    if (!selectedTab || busyAction || closingTabsRef.current.has(selectedTab.targetId)) return
    if (action !== "close") setBusyAction(action)
    const target = selectedTab
    if (action === "close") {
      closingTabsRef.current.add(target.targetId)
      listGenerationRef.current += 1
      setTabs(current => current.filter(tab => tab.targetId !== target.targetId))
      setSelectedTab(undefined)
      setIsConfirmingClose(false)
    }
    try {
      if (action === "focus") {
        await request(`/api/tabs/${encodeURIComponent(selectedTab.targetId)}/focus?${sessionQuery.slice(1)}`, { method: "POST" })
        notify("Focus request sent.", "success")
      } else if (action === "open") {
        await request(`/api/tabs?${sessionQuery.slice(1)}`, { method: "POST", body: JSON.stringify({ url: selectedTab.url }) })
        notify("Opened a new copy of the tab.", "success")
        await loadTabs()
      } else {
        try {
          await request(`/api/tabs/${encodeURIComponent(selectedTab.targetId)}?${sessionQuery.slice(1)}`, { method: "DELETE", signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS) })
        } catch (error) {
          if (getErrorStatus(error) !== 404) throw error
        }
        notify("Tab closed.", "success")
      }
    } catch (error) {
      if (action === "close") {
        setTabs(current => [...current.filter(tab => tab.targetId !== target.targetId), target])
        setSelectedTab(current => current ?? target)
      }
      const status = getErrorStatus(error)
      if (status === 404) setPreviewStatus("missing")
      else if (status === 409) setPreviewStatus("asleep")
      notify(getErrorMessage(error), "error")
    } finally {
      closingTabsRef.current.delete(target.targetId)
      if (action !== "close") setBusyAction(undefined)
      if (action === "close") void loadTabs()
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    controlAbortRef.current = controller
    controlTailRef.current = Promise.resolve()
    return () => controller.abort()
  }, [selectedTabId, sessionQuery])

  const sendControl = useCallback((payload: BrowserControl): Promise<boolean> => {
    const controller = controlAbortRef.current
    if (!selectedTabId || !canControl || !controller || controller.signal.aborted) return Promise.resolve(false)
    const send = async () => {
      if (controller.signal.aborted) return false
      setBusyAction(payload.action)
      try {
        const response = await request(
          `/api/native/browser/tabs/${encodeURIComponent(selectedTabId)}/control?${sessionQuery.slice(1)}`,
          { method: "POST", body: JSON.stringify(payload), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS)]) },
        )
        const value: unknown = await response.json()
        if (controller.signal.aborted) return false
        if (typeof value !== "object" || value === null) throw new Error("Invalid browser response.")
        const nextUrl = Reflect.get(value, "url")
        const nextTitle = Reflect.get(value, "title")
        if (typeof nextUrl === "string") setAddress(nextUrl)
        setSelectedTab(current => current?.targetId === selectedTabId ? {
          ...current,
          url: typeof nextUrl === "string" ? nextUrl : current.url,
          title: typeof nextTitle === "string" && nextTitle ? nextTitle : current.title,
        } : current)
        void capturePreview(controller.signal)
        return true
      } catch (error) {
        if (!controller.signal.aborted) notify(getErrorMessage(error), "error")
        return false
      } finally {
        if (!controller.signal.aborted) setBusyAction(undefined)
      }
    }
    const pending = controlTailRef.current.then(send)
    controlTailRef.current = pending
    return pending
  }, [request, selectedTabId, canControl, sessionQuery, capturePreview, notify])

  useEffect(() => {
    const surface = controlSurfaceRef.current
    if (!surface || !isDirectControl || !canControl) return
    const scroll = (event: WheelEvent) => {
      if (event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      const point = normalizedPreviewPoint(surface, event.clientX, event.clientY)
      if (point) void sendControl({ action: "scroll", ...point, deltaX: browserScrollDelta(event.deltaX), deltaY: browserScrollDelta(event.deltaY) })
    }
    surface.addEventListener("wheel", scroll, { passive: false })
    return () => surface.removeEventListener("wheel", scroll)
  }, [previewSource, isDirectControl, canControl, sendControl])

  function controlKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!isDirectControl || !canControl || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    const key = getBrowserKey(event.key)
    if (!key && event.key.length !== 1) return
    event.preventDefault()
    event.stopPropagation()
    void sendControl(key ? { action: "key", key } : { action: "type", text: event.key })
  }

  const openLibraryItem = async (item: BrowserLibraryItem) => {
    const id = crypto.randomUUID()
    setOpeningTabs(current => [...current, { id, url: item.url }])
    try {
      await request(`/api/tabs?${sessionQuery.slice(1)}`, { method: "POST", body: JSON.stringify({ url: item.url }) })
      setListMode("tabs")
      await loadTabs()
    } catch (error) {
      notify(getErrorMessage(error), "error")
    } finally {
      setOpeningTabs(current => current.filter(tab => tab.id !== id))
    }
  }

  const liveGridTabs = useMemo(() => tabs.filter(tab => tab.loaded !== false).slice(0, 4), [tabs])

  const openNewTab = async () => {
    const enteredUrl = newTabUrl
    const url = getWebsiteUrl(enteredUrl)
    if (!url) {
      notify("Enter a full http:// or https:// URL.", "error")
      return
    }
    const id = crypto.randomUUID()
    setOpeningTabs(current => [...current, { id, url }])
    setNewTabUrl("")
    setIsOpenFormVisible(false)
    try {
      await request(`/api/tabs?${sessionQuery.slice(1)}`, { method: "POST", body: JSON.stringify({ url }) })
      notify("Tab opened.", "success")
      await loadTabs()
    } catch (error) {
      setNewTabUrl(current => current || enteredUrl)
      setIsOpenFormVisible(true)
      notify(getErrorMessage(error), "error")
    } finally {
      setOpeningTabs(current => current.filter(tab => tab.id !== id))
    }
  }

  const availableTabs = tabs
  const filteredTabs = availableTabs.filter((tab) => {
    const needle = query.trim().toLocaleLowerCase()
    return (
      (!needle || tab.title.toLocaleLowerCase().includes(needle) || tab.url.toLocaleLowerCase().includes(needle))
    )
  })

  return (
    <section ref={panelRef} {...stylex.props(styles.panel)} aria-label="Browser tabs">
      <header {...stylex.props(styles.header)}>
        {selectedTab ? <button
          ref={backButtonRef}
          {...stylex.props(styles.iconButton)}
          type="button"
          aria-label="Back to tabs"
          disabled={!!busyAction}
          onClick={() => setSelectedTab(undefined)}
        >
          <ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        </button> : <span aria-hidden="true" />}
        <h2 {...stylex.props(styles.heading)}>Browser</h2>
        <button {...stylex.props(styles.iconButton)} type="button" aria-label="Close browser" onClick={onClose}>
          <X size={ICON_SIZE} strokeWidth={ICON_STROKE} />
        </button>
      </header>

      {selectedTab ? (
        <div {...stylex.props(styles.detail)}>
          <div {...stylex.props(styles.tabIdentity)}>
            <h3 {...stylex.props(styles.tabTitle)}>{selectedTab.title || "Untitled tab"}</h3>
            <form {...stylex.props(styles.addressBar)} onSubmit={event => {
              event.preventDefault()
              const url = getWebsiteUrl(address)
              if (!url) return notify("Enter a full http:// or https:// URL.", "error")
              void sendControl({ action: "navigate", url })
            }}>
              <input {...stylex.props(styles.addressInput)} aria-label="Website address" value={address} inputMode="url" autoCapitalize="none" autoCorrect="off" onChange={event => setAddress(event.target.value)} />
              <button type="submit" {...stylex.props(styles.smallIconButton)} aria-label="Go to address" disabled={!canControl || !!busyAction}><CornerDownLeft size={17} strokeWidth={ICON_STROKE} /></button>
            </form>
          </div>

          {websiteUrl && <Button nativeButton={false} render={<a href={websiteUrl} target="_blank" rel="noopener noreferrer external" />} {...stylex.props(styles.externalLink)}>
            <ExternalLink size={18} strokeWidth={ICON_STROKE} aria-hidden="true" /> {OPEN_IN_BROWSER_LABEL}
          </Button>}

          <div {...stylex.props(styles.navigationBar)}>
            <button type="button" {...stylex.props(styles.smallIconButton)} aria-label="Back" disabled={!canControl || !!busyAction} onClick={() => void sendControl({ action: "back" })}><ArrowLeft size={18} strokeWidth={ICON_STROKE} /></button>
            <button type="button" {...stylex.props(styles.smallIconButton)} aria-label="Forward" disabled={!canControl || !!busyAction} onClick={() => void sendControl({ action: "forward" })}><ArrowRight size={18} strokeWidth={ICON_STROKE} /></button>
            <Button size="compact" variant={isDirectControl ? "primary" : undefined} aria-pressed={isDirectControl} disabled={!canControl} onClick={() => setDirectControl(current => !current)}><MousePointer2 size={16} strokeWidth={ICON_STROKE} />Control</Button>
            {isDirectControl && <button type="button" aria-label="Expand browser view" disabled={!previewSource || !canControl} {...stylex.props(styles.smallIconButton)} onClick={() => setPreviewExpanded(true)}><Maximize2 size={18} strokeWidth={ICON_STROKE} /></button>}
          </div>

          <div {...stylex.props(styles.previewFrame)}>
            {previewSource && !isSelectedTabAsleep && !isSelectedTabMissing && <button
              ref={controlSurfaceRef}
              type="button"
              onKeyDown={controlKey}
              aria-label={isDirectControl ? "Control browser page" : "Expand browser view"}
              aria-haspopup={isDirectControl ? undefined : "dialog"}
              {...stylex.props(styles.expandPreview, isDirectControl && styles.controlPreview)}
              onPointerDown={event => beginPreviewGesture(event)}
              onPointerUp={event => endPreviewGesture(event)}
              onPointerCancel={() => { previewGestureRef.current = undefined }}
              onClick={() => { if (!isDirectControl) setPreviewExpanded(true) }}
            ><img {...stylex.props(styles.preview)} src={previewSource} alt={`Current view of ${selectedTab.title || "browser tab"}`} draggable={false} onLoad={() => setPreviewStatus("ready")} onError={() => { setPreviewStatus("error"); setPreviewFrame(undefined) }} /></button>}
            {(isSelectedTabAsleep || isSelectedTabMissing || previewStatus !== "ready") && <PreviewMessage status={isSelectedTabMissing ? "missing" : isSelectedTabAsleep ? "asleep" : previewStatus} />}
          </div>

          {isDirectControl && canControl && <form {...stylex.props(styles.typeBar)} onSubmit={event => {
            event.preventDefault()
            const text = controlText
            if (!text) return
            void sendControl({ action: "type", text }).then(isSent => { if (isSent) setControlText(current => current === text ? "" : current) })
          }}>
            <input {...stylex.props(styles.typeInput)} value={controlText} placeholder="Type into the focused field" aria-label="Text to type in browser" onChange={event => setControlText(event.target.value)} />
            <Button size="compact" type="submit" disabled={!controlText || !!busyAction}>Type</Button>
            <button type="button" {...stylex.props(styles.smallIconButton)} aria-label="Press Enter" disabled={!!busyAction} onClick={() => void sendControl({ action: "key", key: "Enter" })}><CornerDownLeft size={18} strokeWidth={ICON_STROKE} /></button>
          </form>}

          <textarea
            {...stylex.props(styles.textarea)}
            value={instruction}
            rows={3}
            aria-label="Instructions for this tab"
            placeholder="What should happen on this page?"
            onChange={(event) => setInstruction(event.target.value)}
          />
          <Button
            variant="primary"
            disabled={!!busyAction || !instruction.trim() || isSelectedTabAsleep || isSelectedTabMissing || previewStatus === "asleep" || previewStatus === "missing"}
            onClick={() => {
              const task = instruction.trim()
              if (!task) return
              onStart(`Use browser tab targetId=${selectedTab.targetId} (${selectedTab.title}, ${selectedTab.url}) and follow these instructions:\n\n${task}`)
            }}
          >
            <Send size={18} strokeWidth={ICON_STROKE} /> Start in chat
          </Button>

          <div {...stylex.props(styles.actionGrid)}>
            <Button disabled={!!busyAction || isSelectedTabAsleep || isSelectedTabMissing || previewStatus === "missing"} onClick={() => void runTabAction("focus")}>
              <Focus size={18} strokeWidth={ICON_STROKE} /> Focus
            </Button>
            <Button disabled={!!busyAction} onClick={() => void runTabAction("open")}>
              <ExternalLink size={18} strokeWidth={ICON_STROKE} /> Open copy
            </Button>
          </div>
          <div {...stylex.props(styles.confirmRow)}>
            <Button ref={closeButtonRef} disabled={!!busyAction} aria-haspopup="dialog" onClick={() => setIsConfirmingClose(true)}><Trash2 size={18} strokeWidth={ICON_STROKE} />Close tab</Button>
          </div>
        </div>
      ) : (
        <div {...stylex.props(styles.listView)}>
          <div {...stylex.props(styles.modeTabs)}>
            <Button size="compact" variant={listMode === "tabs" ? "primary" : undefined} onClick={() => setListMode("tabs")}><Globe2 size={16} />Tabs</Button>
            <Button size="compact" variant={listMode === "history" ? "primary" : undefined} onClick={() => setListMode("history")}><History size={16} />History</Button>
            <Button size="compact" variant={listMode === "bookmarks" ? "primary" : undefined} onClick={() => setListMode("bookmarks")}><Bookmark size={16} />Bookmarks</Button>
          </div>
          <div {...stylex.props(styles.searchRow)}>
            <label {...stylex.props(styles.searchBox)}>
              <Search size={18} strokeWidth={ICON_STROKE} />
              <span {...stylex.props(styles.srOnly)}>Search tabs</span>
              <input ref={searchInputRef} {...stylex.props(styles.searchInput)} value={query} placeholder={`Search ${listMode}`} onChange={(event) => setQuery(event.target.value)} />
            </label>
          </div>
          <div {...stylex.props(styles.listScope)}><div {...stylex.props(styles.meta)}>{listMode === "tabs" ? `${availableTabs.length + openingTabs.length} ${sessionId && !isShowingAllTabs ? 'chat tabs' : 'tabs'}` : `${libraryItems.length} ${listMode}`}</div>{listMode === "tabs" && <div {...stylex.props(styles.scopeActions)}>{sessionId && <Button size="compact" aria-expanded={isShowingAllTabs} onClick={() => { listGenerationRef.current += 1; setTabs([]); setShowingAllTabs(current => !current) }}>{isShowingAllTabs ? 'Chat tabs' : 'Show all'}</Button>}</div>}</div>
          <div {...stylex.props(styles.list)}>
            {listMode === "tabs" && liveGridTabs.length > 1 && <div {...stylex.props(styles.previewGrid)}>{liveGridTabs.map(tab => <PreviewCard key={tab.targetId} tab={tab} sessionId={sessionId} isShowingAll={isShowingAllTabs} onOpen={() => setSelectedTab(tab)} />)}</div>}
            {listMode === "tabs" && listError && <EmptyState title="Could not load tabs" detail={listError} />}
            {listMode === "tabs" && !listError && isLoadingTabs && tabs.length === 0 && <EmptyState title="Loading tabs…" detail="Chrome may take a moment to respond." />}
            {listMode === "tabs" && !listError && !isLoadingTabs && filteredTabs.length === 0 && openingTabs.length === 0 && <EmptyState title={availableTabs.length ? "No matching tabs" : "No browser tabs"} detail={availableTabs.length ? "Try a different search." : "Open a tab here or in Aside."} />}
            {listMode === "tabs" && openingTabs.map(tab => <div key={tab.id} role="status" {...stylex.props(styles.tabRow)}><Globe2 size={ICON_SIZE} aria-hidden="true" /><span {...stylex.props(styles.tabCopy)}><span {...stylex.props(styles.rowTitle)}>{new URL(tab.url).hostname}</span><span {...stylex.props(styles.rowMeta)}>Opening…</span></span></div>)}
            {listMode === "tabs" && filteredTabs.map((tab) => (
              <button key={tab.targetId} data-browser-tab={tab.targetId} title={tab.title || "Untitled tab"} {...stylex.props(styles.tabRow)} type="button" onClick={() => setSelectedTab(tab)}>
                <TabThumbnail tab={tab} request={request} sessionQuery={sessionQuery} />
                <span {...stylex.props(styles.tabCopy)}>
                  <span {...stylex.props(styles.rowTitle)}>{tab.title || "Untitled tab"}</span>
                  <span {...stylex.props(styles.rowMeta)}>{tab.loaded === false ? "Asleep" : tab.active ? "Active" : "Available"}</span>
                </span>
              </button>
            ))}
            {listMode !== "tabs" && libraryError && <EmptyState title="Could not load browser data" detail={libraryError} />}
            {listMode !== "tabs" && isLoadingLibrary && libraryItems.length === 0 && <EmptyState title={`Loading ${listMode}…`} detail="" />}
            {listMode !== "tabs" && !isLoadingLibrary && !libraryError && libraryItems.length === 0 && <EmptyState title={`No ${listMode}`} detail={query ? "Try a different search." : "Nothing is available yet."} />}
            {listMode !== "tabs" && libraryItems.map(item => <button key={item.id} type="button" {...stylex.props(styles.tabRow)} onClick={() => void openLibraryItem(item)}>{item.favicon ? <img src={item.favicon} alt="" {...stylex.props(styles.libraryIcon)} /> : listMode === "history" ? <History size={ICON_SIZE} /> : <Bookmark size={ICON_SIZE} />}<span {...stylex.props(styles.tabCopy)}><span {...stylex.props(styles.rowTitle)}>{item.title}</span><span {...stylex.props(styles.rowMeta)}>{item.detail ?? new URL(item.url).hostname}</span></span></button>)}
            {listMode === "tabs" && <Button {...stylex.props(styles.openDisclosure)} aria-haspopup="dialog" onClick={() => setIsOpenFormVisible(true)}><ExternalLink size={18} strokeWidth={ICON_STROKE} />Open a tab</Button>}
            <AnimatePresence>{isOpenFormVisible && <Dialog title="Open a tab" initialFocus={() => document.getElementById('new-browser-tab-url')} onClose={() => setIsOpenFormVisible(false)}>
              <form onSubmit={(event) => { event.preventDefault(); void openNewTab() }}>
                <DialogDescription>Enter the address of the website to open in Aside.</DialogDescription>
                  <input
                    id="new-browser-tab-url"
                    {...stylex.props(ui.field)}
                    type="url" inputMode="url" autoCapitalize="none" autoCorrect="off"
                    value={newTabUrl}
                    placeholder="https://example.com"
                    onChange={(event) => setNewTabUrl(event.target.value)}
                    aria-label="Website address"
                  />
                <DialogActions><Button onClick={() => setIsOpenFormVisible(false)}>Cancel</Button><Button variant="primary" type="submit" disabled={!newTabUrl.trim()}>Open</Button></DialogActions>
              </form>
            </Dialog>}</AnimatePresence>
          </div>
        </div>
      )}
      <AnimatePresence>{isConfirmingClose && selectedTab && <Dialog title="Close this tab?" initialFocus={cancelCloseRef} onClose={() => setIsConfirmingClose(false)}><DialogDescription>{selectedTab.title || "Untitled tab"}</DialogDescription><DialogActions><Button ref={cancelCloseRef} onClick={() => setIsConfirmingClose(false)}>Cancel</Button><Button variant="danger" disabled={!!busyAction} onClick={() => { void runTabAction("close") }}>Close tab</Button></DialogActions></Dialog>}</AnimatePresence>
      <AnimatePresence>{isPreviewExpanded && previewSource && selectedTab && !isSelectedTabAsleep && !isSelectedTabMissing && <ImagePreview kind="browser" key={selectedTab.targetId} src={previewSource} title={selectedTab.title || "Browser"} url={websiteUrl} onClose={() => setPreviewExpanded(false)} />}</AnimatePresence>
    </section>
  )

  function beginPreviewGesture(event: PointerEvent<HTMLButtonElement>) {
    if (!isDirectControl || !canControl || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    previewGestureRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function endPreviewGesture(event: PointerEvent<HTMLButtonElement>) {
    const start = previewGestureRef.current
    previewGestureRef.current = undefined
    if (!isDirectControl || !canControl || !start || start.pointerId !== event.pointerId) return
    event.stopPropagation()
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) > 10) {
      const point = normalizedPreviewPoint(event.currentTarget, start.x, start.y)
      if (point) void sendControl({ action: "scroll", ...point, deltaX: browserScrollDelta(-dx * 3), deltaY: browserScrollDelta(-dy * 3) })
      return
    }
    const point = normalizedPreviewPoint(event.currentTarget, event.clientX, event.clientY)
    if (point) void sendControl({ action: "click", ...point })
  }
}

function TabThumbnail({ tab, request, sessionQuery }: { tab: BrowserTab; request: BrowserPanelProps["request"]; sessionQuery: string }) {
  const [src, setSrc] = useState<string>()
  const [isVisible, setIsVisible] = useState(false)
  const thumbnailRef = useRef<HTMLSpanElement>(null)
  const objectUrlRef = useRef<string | undefined>(undefined)
  const isAsleep = tab.loaded === false

  useEffect(() => {
    const element = thumbnailRef.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const capture = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await request(`/api/tabs/${encodeURIComponent(tab.targetId)}/shot?fresh=true${sessionQuery}`, { cache: "no-store", signal })
      const blob = await response.blob()
      if (signal.aborted || !blob.type.startsWith("image/")) return
      const previousUrl = objectUrlRef.current
      objectUrlRef.current = URL.createObjectURL(blob)
      setSrc(objectUrlRef.current)
      if (previousUrl) URL.revokeObjectURL(previousUrl)
    } catch {
      // Keep the last thumbnail while the next automatic capture retries.
    }
  }, [request, tab.targetId, sessionQuery])

  useAutoRefresh(capture, THUMBNAIL_REFRESH_INTERVAL_MS, isVisible && !isAsleep)

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])
  return (
    <span ref={thumbnailRef} {...stylex.props(styles.thumbnail)}>
      {src && !isAsleep ? <img {...stylex.props(styles.thumbnailImage)} src={src} alt="" /> : tab.favicon ? <img {...stylex.props(styles.favicon)} src={tab.favicon} alt="" /> : <Globe2 size={20} strokeWidth={ICON_STROKE} />}
    </span>
  )
}

function PreviewCard({ tab, sessionId, isShowingAll, onOpen }: {
  tab: BrowserTab
  sessionId?: string
  isShowingAll: boolean
  onOpen: () => void
}) {
  const [hasError, setHasError] = useState(false)
  useEffect(() => {
    if (!hasError) return
    const retry = window.setTimeout(() => setHasError(false), THUMBNAIL_REFRESH_INTERVAL_MS)
    return () => window.clearTimeout(retry)
  }, [hasError])
  return <button type="button" {...stylex.props(styles.liveCard)} onClick={onOpen}>
    {!hasError ? <img src={getBrowserStreamUrl({ targetId: tab.targetId, sessionId, isShowingAll, fps: .5 })} alt="" {...stylex.props(styles.liveImage)} onError={() => setHasError(true)} /> : <Globe2 size={24} aria-hidden="true" />}
    <span {...stylex.props(styles.liveTitle)}>{tab.title || "Untitled tab"}</span>
  </button>
}

function PreviewMessage({ status }: { status: PreviewStatus }) {
  if (status === "asleep") return <div {...stylex.props(styles.previewMessage)}><strong>This tab is asleep</strong><span>Open a copy to load it again.</span></div>
  if (status === "missing") return <div {...stylex.props(styles.previewMessage)}><strong>This tab is no longer available</strong><span>The tab list updates automatically.</span></div>
  return <div role="status" aria-live="polite" {...stylex.props(styles.previewActivity)}>
    <span aria-hidden="true" {...stylex.props(styles.previewSpinner)} />
    <span {...stylex.props(styles.srOnly)}>{status === "error" ? "Restoring browser preview" : "Loading browser preview"}</span>
  </div>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div {...stylex.props(styles.empty)}><strong>{title}</strong><span>{detail}</span></div>
}


function getErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined
  const status = Reflect.get(error, "status")
  return typeof status === "number" ? status : undefined
}

function getErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") return formatRequestError({ status: 504 })
  if (getErrorStatus(error) === 404) return "This tab is no longer available."
  return formatRequestError({ message: error instanceof Error ? error.message : undefined })
}

function normalizedPreviewPoint(element: HTMLButtonElement, clientX: number, clientY: number) {
  const image = element.querySelector("img")
  if (!image?.naturalWidth || !image.naturalHeight) return
  const bounds = element.getBoundingClientRect()
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight)
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  const left = bounds.left + (bounds.width - width) / 2
  const top = bounds.top + (bounds.height - height) / 2
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return
  return { x: (clientX - left) / width, y: (clientY - top) / height }
}

const styles = stylex.create({
  panel: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, overflow: "hidden", backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font },
  header: { minHeight: 58, display: "grid", gridTemplateColumns: "44px 1fr 44px", alignItems: "center", padding: "7px 12px", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: tokens.border },
  heading: { margin: 0, textAlign: "center", fontSize: '1.0625rem', lineHeight: 1.2, fontWeight: 650 },
  iconButton: { width: 44, height: 44, padding: 0, borderWidth: 0, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", color: tokens.text, backgroundColor: { default: "transparent", ":hover": tokens.hover } },
  listView: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  searchRow: { display: "flex", gap: 8, padding: "14px 16px 8px" },
  modeTabs: { display: "flex", gap: 6, padding: "12px 16px 0", overflowX: "auto" },
  searchBox: { minWidth: 0, flex: 1, height: 44, display: "flex", alignItems: "center", gap: 9, padding: "0 13px", borderRadius: 14, backgroundColor: tokens.surface, color: tokens.muted },
  searchInput: { minWidth: 0, width: "100%", height: "100%", padding: 0, borderWidth: 0, outline: 0, backgroundColor: "transparent", color: tokens.text, fontFamily: tokens.font, fontSize: '1rem' },
  meta: { padding: "2px 18px 9px", color: tokens.muted, fontSize: '0.75rem' },
  list: { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "0 10px 18px" },
  tabRow: { width: "100%", minHeight: 76, display: "flex", alignItems: "center", gap: 12, padding: "9px 8px", borderWidth: 0, borderRadius: 14, textAlign: "left", backgroundColor: { default: "transparent", ":hover": tokens.surface }, color: tokens.text, fontFamily: tokens.font },
  thumbnail: { width: 84, height: 56, flexShrink: 0, display: "grid", placeItems: "center", overflow: "hidden", borderRadius: 10, borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, backgroundColor: tokens.surface, color: tokens.muted },
  thumbnailImage: { display: "block", width: "100%", height: "100%", objectFit: "cover" },
  favicon: { width: 22, height: 22, objectFit: "contain" },
  tabCopy: { minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  rowTitle: { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere", fontSize: '0.9375rem', lineHeight: 1.35, fontWeight: 560 },
  rowMeta: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tokens.muted, fontSize: '0.75rem' },
  detail: { minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: "16px", display: "flex", flexDirection: "column", gap: 12 },
  tabIdentity: { minWidth: 0, padding: "0 2px" },
  tabTitle: { margin: 0, overflowWrap: "anywhere", fontSize: '1.0625rem', lineHeight: 1.35, fontWeight: 650 },
  url: { marginTop: 3, overflowWrap: "anywhere", color: tokens.muted, fontSize: '0.75rem', lineHeight: 1.45, userSelect: "text" },
  previewFrame: { position: "relative", minHeight: 180, maxHeight: "min(46vh, 430px)", aspectRatio: "16 / 10", display: "grid", placeItems: "center", overflow: "hidden", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 16, backgroundColor: tokens.surface },
  preview: { display: "block", width: "100%", height: "100%", objectFit: "contain", backgroundColor: tokens.canvas },
  expandPreview: { width: "100%", height: "100%", minHeight: 0, padding: 0, borderWidth: 0, overflow: "hidden", backgroundColor: "transparent", cursor: "zoom-in" },
  controlPreview: { touchAction: "none", cursor: "crosshair" },
  previewMessage: { display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: 24, textAlign: "center", color: tokens.muted, fontSize: '0.8125rem' },
  previewActivity: { position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" },
  previewSpinner: { width: 22, height: 22, borderRadius: 999, borderWidth: 2, borderStyle: "solid", borderColor: tokens.border, borderTopColor: tokens.text, animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }), animationDuration: "800ms", animationTimingFunction: "linear", animationIterationCount: "infinite" },
  textarea: { width: "100%", minHeight: 88, resize: "vertical", padding: "13px 14px", borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 14, backgroundColor: tokens.canvas, color: tokens.text, fontFamily: tokens.font, fontSize: '1rem', lineHeight: 1.45 },
  actionGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  externalLink: { textDecoration: 'none' },
  listScope: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  scopeActions: { display: "flex", gap: 6, paddingRight: 10 },
  addressBar: { display: "flex", alignItems: "center", minWidth: 0, marginTop: 6, borderRadius: 12, backgroundColor: tokens.surface, padding: "0 4px 0 10px" },
  addressInput: { flex: 1, minWidth: 0, height: 40, padding: 0, borderWidth: 0, outline: 0, backgroundColor: "transparent", color: tokens.muted, fontFamily: tokens.font, fontSize: "0.75rem" },
  navigationBar: { display: "flex", alignItems: "center", gap: 4 },
  smallIconButton: { width: 40, height: 40, flexShrink: 0, display: "grid", placeItems: "center", padding: 0, borderWidth: 0, borderRadius: 12, backgroundColor: { default: "transparent", ":hover": tokens.hover }, color: tokens.text },
  typeBar: { display: "flex", alignItems: "center", gap: 6, padding: 6, borderRadius: 14, backgroundColor: tokens.surface },
  typeInput: { flex: 1, minWidth: 0, height: 38, padding: "0 8px", borderWidth: 0, outline: 0, backgroundColor: "transparent", color: tokens.text, fontFamily: tokens.font, fontSize: "0.875rem" },
  previewGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: "6px 0 12px" },
  liveCard: { minWidth: 0, display: "flex", flexDirection: "column", gap: 6, padding: 6, borderWidth: 1, borderStyle: "solid", borderColor: tokens.border, borderRadius: 12, backgroundColor: tokens.surface, color: tokens.text, textAlign: "left", overflow: "hidden" },
  liveImage: { display: "block", width: "100%", aspectRatio: "16 / 10", objectFit: "cover", objectPosition: "top", borderRadius: 8, backgroundColor: tokens.canvas },
  liveTitle: { width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.6875rem" },
  libraryIcon: { width: 24, height: 24, flexShrink: 0, objectFit: "contain" },
  confirmRow: { minHeight: 52, display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "4px 0" },
  empty: { minHeight: 220, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, padding: 28, textAlign: "center", color: tokens.muted, fontSize: '0.875rem' },
  openDisclosure: { width: '100%', marginTop: 8 },
  srOnly: { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", borderWidth: 0 },
})
