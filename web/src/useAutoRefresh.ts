import { useEffect } from "react"

const REQUEST_TIMEOUT_MS = 60_000

export function useAutoRefresh(refresh: (signal: AbortSignal) => Promise<void>, interval: number, isEnabled = true) {
  useEffect(() => {
    if (!isEnabled) return
    let isDisposed = false
    let isPending = false
    let shouldRefreshAgain = false
    let timer: number | undefined
    let controller: AbortController | undefined

    function wake() {
      window.clearTimeout(timer)
      if (isDisposed) return
      if (document.visibilityState === "hidden") {
        controller?.abort()
        return
      }
      if (navigator.onLine === false) return
      if (isPending) {
        shouldRefreshAgain = true
        return
      }
      void update()
    }

    async function update() {
      isPending = true
      shouldRefreshAgain = false
      controller = new AbortController()
      try {
        await refresh(AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]))
      } finally {
        isPending = false
        if (!isDisposed) timer = window.setTimeout(wake, shouldRefreshAgain ? 0 : interval)
      }
    }

    wake()
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    window.addEventListener("pageshow", wake)
    window.addEventListener("focus", wake)
    return () => {
      isDisposed = true
      controller?.abort()
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
      window.removeEventListener("pageshow", wake)
      window.removeEventListener("focus", wake)
    }
  }, [refresh, interval, isEnabled])
}
