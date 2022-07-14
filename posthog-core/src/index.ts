import {
  PostHogFetchOptions,
  PostHogFetchResponse,
  PostHogQueueItem,
  PostHogAutocaptureElement,
  PostHogDecideResponse,
  PostHogStorage,
  PosthogCoreOptions,
} from './types'
import { assert, currentISOTime, currentTimestamp, removeTrailingSlash, retriable } from './utils'
export * as utils from './utils'
import { eventValidation } from './validation'
import { LZString } from './lz-string'
import { SimpleEventEmitter } from './eventemitter'

export abstract class PostHogCore {
  // options
  private apiKey: string
  private host: string
  private flushAt: number
  private flushInterval: number
  private captureMode: 'form' | 'json'
  private sendFeatureFlagEvent: boolean
  private flagCallReported: { [key: string]: boolean } = {}

  // internal
  private _events: SimpleEventEmitter
  private _queue: PostHogQueueItem[]
  private _flushed = false
  private _flushTimer?: any

  private _decideResponsePromise?: Promise<PostHogDecideResponse>
  private _decideResponse?: PostHogDecideResponse
  private _decideTimer?: any
  private _decidePollInterval = 10000

  // Abstract methods to be overridden by implementations
  abstract storage(): PostHogStorage
  abstract fetch(url: string, options: PostHogFetchOptions): Promise<PostHogFetchResponse>
  abstract getLibraryId(): string
  abstract getLibraryVersion(): string
  abstract getDistinctId(): string
  abstract onSetDistinctId(newDistinctId: string): string
  abstract getCustomUserAgent(): string | void
  abstract setImmediate(fn: () => void): void

  public enabled = true

  constructor(apiKey: string, options: PosthogCoreOptions = {}) {
    assert(apiKey, "You must pass your PostHog project's api key.")

    this._queue = []
    this.apiKey = apiKey
    this.host = removeTrailingSlash(options.host || 'https://app.posthog.com')
    this.flushAt = options.flushAt ? Math.max(options.flushAt, 1) : 20
    this.flushInterval = options.flushInterval ?? 10000
    this.captureMode = options.captureMode || 'form'
    this.sendFeatureFlagEvent = options.sendFeatureFlagEvent ?? true
    this._events = new SimpleEventEmitter()
  }

  protected getCommonEventProperties(): any {
    return {
      $lib: this.getLibraryId(),
      $lib_version: this.getLibraryVersion(),
    }
  }

  enable() {
    this.enabled = true
  }

  disable() {
    this.enabled = false
  }

  on(event: string, cb: (e: any) => void) {
    return this._events.on(event, cb)
  }

  // PRAGMA - tracking methods
  identify(distinctId?: string, properties?: any, callback?: () => void) {
    distinctId = distinctId || this.getDistinctId()

    const event = {
      distinctId: distinctId,
      properties: properties,
    }
    this.validate('identify', event)

    const payload = {
      distinct_id: distinctId,
      $set: properties || {},
      event: '$identify',
      properties: {
        ...this.getCommonEventProperties(),
        $anon_distinct_id: this.getDistinctId(),
      },
    }

    this.onSetDistinctId(distinctId)

    this.enqueue('identify', payload, callback)
    return this
  }

  capture(event: string, properties?: any, callback?: () => void) {
    const distinctId = this.getDistinctId()

    this.validate('capture', {
      event,
      distinctId,
      properties,
    })

    if (properties && properties['groups']) {
      properties.$groups = properties.groups
      delete properties.groups
    }

    const payload = {
      distinct_id: distinctId,
      event,
      properties: {
        ...properties,
        ...this.getCommonEventProperties(),
      },
    }

    this.enqueue('capture', payload, callback)
    return this
  }

  alias(alias: string, callback?: () => void) {
    const distinctId = this.getDistinctId()

    this.validate('alias', {
      distinctId,
      alias,
    })

    const payload = {
      distinct_id: distinctId,
      event: '$create_alias',
      properties: {
        distinct_id: distinctId,
        alias: alias,
        ...this.getCommonEventProperties(),
      },
    }

    this.enqueue('alias', payload, callback)
    return this
  }

  autocapture(eventType: string, elements: PostHogAutocaptureElement[], properties?: any, callback?: () => void) {
    const distinctId = this.getDistinctId()

    const payload = {
      distinct_id: distinctId,
      event: '$autocapture',
      properties: {
        ...properties,
        ...this.getCommonEventProperties(),
        $event_type: eventType,
        $elements: elements,
      },
    }

    this.enqueue('autocapture', payload, callback)
    return this
  }

  groupIdentify(group: { groupType: string; groupKey: string }, properties?: any, callback?: () => void) {
    this.validate('groupIdentify', group)

    const payload = {
      event: '$groupidentify',
      distinctId: `$${group.groupType}_${group.groupKey}`,
      properties: {
        $group_type: group.groupType,
        $group_key: group.groupKey,
        $group_set: properties || {},
      },
    }

    this.enqueue('capture', payload, callback)
    return this
  }

  // PRAGMA: Feature flags
  private decideAsync(): Promise<PostHogDecideResponse> {
    if (this._decideResponsePromise) {
      return this._decideResponsePromise
    }
    return this._decideAsync()
  }

  private async _decideAsync(): Promise<PostHogDecideResponse> {
    const url = `${this.host}/decide/?v=2`

    const distinctId = this.getDistinctId()
    const groups = {} // TODO

    const fetchOptions: PostHogFetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups, distinct_id: distinctId, token: this.apiKey }),
    }

    this._decideResponsePromise = this.fetchWithRetry(url, fetchOptions)
      .then((r) => r.json())
      .then((res) => {
        this._decideResponse = res
        this._events.emit('featureflags', res.featureFlags)
        return res
      })
    return this._decideResponsePromise
  }

  getFeatureFlag(key: string, defaultResult: string | boolean = false, groups = {}): boolean | string | undefined {
    const featureFlags = this._decideResponse?.featureFlags

    if (!featureFlags) {
      // If we haven't loaded flags yet we respond undefined to indicate this
      return undefined
    }

    if (this.sendFeatureFlagEvent && !this.flagCallReported[key]) {
      this.flagCallReported[key] = true
      this.capture('$feature_flag_called', {
        $feature_flag: key,
        $feature_flag_response: featureFlags[key],
      })
    }

    // If we have flags we either return the value (true or string) or the defaultResult
    return featureFlags[key] ?? defaultResult
  }

  getFeatureFlags() {
    return this._decideResponse?.featureFlags
  }

  isFeatureEnabled(key: string, defaultResult: boolean = false, groups = {}) {
    const flag = this.getFeatureFlag(key, defaultResult, groups)
    return !!flag
  }

  async reloadFeatureFlagsAsync() {
    clearTimeout(this._decideTimer)
    this._decideTimer = setTimeout(() => this.reloadFeatureFlagsAsync(), this._decidePollInterval)
    this._decideResponsePromise = undefined
    return (await this.decideAsync()).featureFlags
  }

  // When listening to feature flags polling is active
  onFeatureFlags(cb: (flags: PostHogDecideResponse['featureFlags']) => void) {
    if (!this._decideTimer) void this.reloadFeatureFlagsAsync()

    return this.on('featureflags', async () => {
      const flags = this.getFeatureFlags()
      if (flags) cb(flags)
    })
  }

  // TODO: Add listener to feature flags and polling if listeners exist
  /**
   * Add a `message` of type `type` to the queue and
   * check whether it should be flushed.
   *
   * @param {String} type
   * @param {Object} payload
   * @param {Function} [callback] (optional)
   * @api private
   */

  enqueue(type: string, _message: any, callback?: () => void) {
    if (!this.enabled) {
      return callback && this.setImmediate(callback)
    }
    const message = {
      ..._message,
      type: type,
      library: this.getLibraryId(),
      library_version: this.getLibraryVersion(),
      timestamp: _message.timestamp ? _message.timestamp : currentISOTime(),
    }

    if (message.distinctId) {
      message.distinct_id = message.distinctId
      delete message.distinctId
    }

    this._queue.push({ message, callback })
    this._events.emit(type, message)

    // Flush queued events if we meet the flushAt length
    if (this._queue.length >= this.flushAt) {
      this.flush()
    }

    if (this.flushInterval && !this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flush(), this.flushInterval)
    }
  }

  flush(callback?: (err?: any, data?: any) => void) {
    if (!this.enabled) {
      return callback && this.setImmediate(callback)
    }

    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }

    if (!this._queue.length) {
      return callback && this.setImmediate(callback)
    }

    const items = this._queue.splice(0, this.flushAt)
    const callbacks = items.map((item) => item.callback)
    const messages = items.map((item) => item.message)

    const data = {
      api_key: this.apiKey,
      batch: messages,
      sent_at: currentISOTime(),
    }

    const done = (err?: any) => {
      callbacks.forEach((cb) => cb?.(err))
      callback?.(err, data)
      this._events.emit('flush', messages)
    }

    // Don't set the user agent if we're not on a browser. The latest spec allows
    // the User-Agent header (see https://fetch.spec.whatwg.org/#terminology-headers
    // and https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/setRequestHeader),
    // but browsers such as Chrome and Safari have not caught up.
    const customUserAgent = this.getCustomUserAgent()
    const headers: { [key: string]: string } = {}
    if (customUserAgent) {
      headers['user-agent'] = customUserAgent
    }

    const payload = JSON.stringify(data)

    const url =
      this.captureMode === 'form'
        ? `${this.host}/e/?ip=1&_=${currentTimestamp()}&v=${this.getLibraryVersion()}`
        : `${this.host}/batch/`

    const fetchOptions: PostHogFetchOptions =
      this.captureMode === 'form'
        ? {
            method: 'POST',
            mode: 'no-cors',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(LZString.compressToBase64(payload))}&compression=lz64`,
          }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }

    this.fetchWithRetry(url, fetchOptions)
      .then(() => done())
      .catch((err) => {
        if (err.response) {
          const error = new Error(err.response.statusText)
          return done(error)
        }

        done(err)
      })
  }

  private async fetchWithRetry(url: string, options: PostHogFetchOptions): Promise<any> {
    return retriable(() => this.fetch(url, options))
  }

  private validate(type: string, message: any) {
    try {
      eventValidation(type, message)
    } catch (e) {
      if ((e as any).message === 'Your message must be < 32 kB.') {
        console.log('Your message must be < 32 kB.', JSON.stringify(message))
        return
      }
      throw e
    }
  }
}

export * from './types'
export { LZString }
