import { useEffect } from 'react'

/**
 * While `active`, closing or reloading the tab asks for confirmation (the browser's own
 * prompt; it ignores custom text). In-app page changes need no guard: the Analyser stays mounted.
 */
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active])
}
