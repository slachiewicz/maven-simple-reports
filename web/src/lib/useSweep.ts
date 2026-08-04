/*
 * Copyright 2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useRef, useState } from 'react'
import { GhRateLimitError, clearQueueBackoff } from './githubFetch'

const RATE_LIMIT_PAUSE_BUFFER_MS = 5_000

export interface CycleState {
  startedAt: number | null
  completedAt: number | null
  inFlight: string | null
  nextCycleAt: number | null
  pausedUntil: number | null
}

const initialCycle: CycleState = {
  startedAt: null,
  completedAt: null,
  inFlight: null,
  nextCycleAt: null,
  pausedUntil: null,
}

export interface SweepOptions<T> {
  /** Keys to fetch. Changing this re-queues only keys not already in results. */
  items: readonly string[]
  fetchOne: (item: string, token: string | undefined) => Promise<T>
  getToken: () => Promise<string | undefined>
  intervalMs: number
  /** When false the loop parks without unmounting; flipping to true starts it. */
  enabled: boolean
  initialResults?: Record<string, T>
  onResult?: (item: string, value: T) => void
}

export interface SweepResult<T> {
  results: Record<string, T>
  cycle: CycleState
  pending: string[]
  refreshNow: () => void
  wake: () => void
}

export function useSweep<T>(opts: SweepOptions<T>): SweepResult<T> {
  const [results, setResults] = useState<Record<string, T>>(() => opts.initialResults ?? {})
  const [pending, setPending] = useState<string[]>([])
  const [cycle, setCycle] = useState<CycleState>(initialCycle)

  const pendingRef = useRef<string[]>([])
  const itemsRef = useRef<readonly string[]>(opts.items)
  const resultsRef = useRef<Record<string, T>>(results)
  const restartTokenRef = useRef(0)

  // Latest-value refs so the loop below can keep empty deps. The loop must be
  // started exactly once; re-running the effect would abandon an in-flight
  // rate-limit pause.
  const fetchOneRef = useRef(opts.fetchOne)
  const getTokenRef = useRef(opts.getToken)
  const intervalRef = useRef(opts.intervalMs)
  const enabledRef = useRef(opts.enabled)
  const onResultRef = useRef(opts.onResult)

  fetchOneRef.current = opts.fetchOne
  getTokenRef.current = opts.getToken
  intervalRef.current = opts.intervalMs
  onResultRef.current = opts.onResult

  useEffect(() => {
    resultsRef.current = results
  }, [results])

  const syncPending = () => setPending([...pendingRef.current])

  const wake = () => {
    clearQueueBackoff()
    restartTokenRef.current += 1
  }

  const refreshNow = () => {
    clearQueueBackoff()
    pendingRef.current = [...itemsRef.current]
    restartTokenRef.current += 1
    syncPending()
    setCycle((c) => ({
      ...c,
      startedAt: Date.now(),
      completedAt: null,
      nextCycleAt: null,
      pausedUntil: null,
    }))
  }

  // Item-set changes queue only what is not already fetched, matching the
  // filter-change behaviour the previous App.tsx had at lines 200-217.
  const itemsKey = opts.items.join('\n')
  useEffect(() => {
    itemsRef.current = opts.items
    const fetched = new Set(Object.keys(resultsRef.current))
    pendingRef.current = opts.items.filter((i) => !fetched.has(i))
    restartTokenRef.current += 1
    syncPending()
    setCycle((c) => ({
      ...c,
      startedAt: c.startedAt ?? Date.now(),
      completedAt: pendingRef.current.length === 0 ? c.completedAt : null,
      nextCycleAt: pendingRef.current.length === 0 ? c.nextCycleAt : null,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on itemsKey
  }, [itemsKey])

  useEffect(() => {
    const wasEnabled = enabledRef.current
    enabledRef.current = opts.enabled
    if (opts.enabled && !wasEnabled) {
      clearQueueBackoff()
      restartTokenRef.current += 1
    }
  }, [opts.enabled])

  useEffect(() => {
    let cancelled = false

    const interruptibleSleep = async (ms: number, token: number): Promise<'done' | 'restart'> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (cancelled) return 'done'
        if (restartTokenRef.current !== token) return 'restart'
        await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())))
      }
      return 'done'
    }

    const loop = async () => {
      while (!cancelled) {
        if (!enabledRef.current) {
          const tok = restartTokenRef.current
          await interruptibleSleep(500, tok)
          continue
        }

        // Functional update only: this effect has empty deps, so any `cycle`
        // read here would be frozen at first render.
        setCycle((c) => (c.startedAt === null ? { ...c, startedAt: Date.now() } : c))

        while (pendingRef.current.length > 0 && !cancelled && enabledRef.current) {
          const item = pendingRef.current[0]
          setCycle((c) => ({ ...c, inFlight: item }))
          try {
            const value = await fetchOneRef.current(item, await getTokenRef.current())
            if (cancelled) return
            setResults((prev) => ({ ...prev, [item]: value }))
            onResultRef.current?.(item, value)
            pendingRef.current = pendingRef.current.filter((r) => r !== item)
            syncPending()
          } catch (err) {
            if (err instanceof GhRateLimitError) {
              const until = err.until + RATE_LIMIT_PAUSE_BUFFER_MS
              setCycle((c) => ({ ...c, inFlight: null, pausedUntil: until }))
              const tok = restartTokenRef.current
              const wait = until - Date.now()
              if (wait > 0) {
                const outcome = await interruptibleSleep(wait, tok)
                if (outcome === 'restart') {
                  setCycle((c) => ({ ...c, pausedUntil: null }))
                  continue
                }
              }
              if (cancelled) return
              setCycle((c) => ({ ...c, pausedUntil: null }))
              // Sleep expired naturally — retry the same item, still at the head.
              continue
            }
            // Unrecognized error — the caller's fetchOne is responsible for
            // encoding it into T. Reaching here means it threw instead; drop the
            // item so the sweep cannot wedge.
            pendingRef.current = pendingRef.current.filter((r) => r !== item)
            syncPending()
          }
        }
        if (cancelled) return

        const interval = intervalRef.current
        const completed = Date.now()
        setCycle((c) => ({
          ...c,
          completedAt: completed,
          inFlight: null,
          nextCycleAt: completed + interval,
          pausedUntil: null,
        }))
        const tok = restartTokenRef.current
        const outcome = await interruptibleSleep(interval, tok)
        if (cancelled) return
        if (outcome === 'restart') continue
        pendingRef.current = [...itemsRef.current]
        syncPending()
        setCycle((c) => ({ ...c, startedAt: Date.now(), completedAt: null, nextCycleAt: null }))
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once, drive via refs
  }, [])

  return { results, cycle, pending, refreshNow, wake }
}
