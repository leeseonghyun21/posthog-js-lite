import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import type { PostHogReactNative } from '../posthog'
import { usePostHog } from '../PostHogProvider'

export function useLifecycleTracker(client?: PostHogReactNative) {
  const openTrackedRef = useRef(false)
  const contextClient = usePostHog()
  const posthog = client || contextClient

  if (!posthog) return

  return useEffect(() => {
    if (!openTrackedRef.current) {
      openTrackedRef.current = true
      posthog.capture('Application Opened')
    }
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      switch (nextAppState) {
        case 'active':
          return posthog.capture('Application Became Active')
        case 'background':
          return posthog.capture('Application Backgrounded')
        default:
          return
      }
    })

    return () => subscription.remove()
  }, [posthog])
}