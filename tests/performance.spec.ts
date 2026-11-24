import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { PerformanceMetrics } from '../src/app/performance.ts'
import { Store } from '../src/app/store.ts'

const DAY = 86_400_000, now = Date.UTC(2026, 10, 19)
const foreground = { role: 'foreground', model: 'hy4-flash' } as const
const worker = { role: 'worker', model: 'hy4' } as const
let directory: string | undefined, store: Store | undefined
afterEach(() => {
  store?.close(); store = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
})
function fixture(tick?: () => number) {
  const path = join(directory = mkdtempSync(join(tmpdir(), 'conest-performance-')), 'store.sqlite')
  store = new Store(path)
  const warn = vi.fn()
  return { path, warn, metrics: new PerformanceMetrics(store, warn, () => now, tick) }
}

it('persists numeric samples, separates model roles and windows, and excludes failed durations from exact percentiles', () => {
  const { metrics, warn, path } = fixture()
  metrics.record(foreground, Array.from({ length: 20 }, (_, index) => ({ metric: 'model_call', elapsed: index + 1, failed: false })))
  metrics.record(foreground, [{ metric: 'model_call', elapsed: 1_000, failed: true }])
  metrics.record(foreground, [{ metric: 'model_call', elapsed: 40, failed: false }], now - 2 * DAY)
  metrics.record(foreground, [{ metric: 'model_call', elapsed: 500, failed: false }], now - 8 * DAY)
  metrics.record(worker, [{ metric: 'model_call', elapsed: 2_000, failed: true }, { metric: 'reasoning', elapsed: null }])
  metrics.startRetention()()
  expect(store!.db.prepare('SELECT count(*) AS n FROM performance_sample').get()).toMatchObject({ n: 23 })
  store!.close(); store = new Store(path)
  const restored = new PerformanceMetrics(store, warn, () => now)
  expect(restored.view('24h').groups).toEqual([
    { ...foreground, metrics: [{ metric: 'model_call', samples: 21, timedSamples: 20, p50Ms: 10, p95Ms: 19, failures: 1, failureRate: 1 / 21 }] },
    { ...worker, metrics: [{ metric: 'model_call', samples: 1, timedSamples: 0, p50Ms: null, p95Ms: null, failures: 1, failureRate: 1 }] },
  ])
  expect(restored.view('7d').groups[0]?.metrics[0]).toMatchObject({ samples: 22, timedSamples: 21, p50Ms: 11, p95Ms: 20 })
  expect(warn).not.toHaveBeenCalled()
})

it('keeps the first successful Weixin answer per message and allows success to supersede an earlier drop', () => {
  const { metrics } = fixture()
  for (const [elapsed, failed] of [[20, true], [40, false], [60, false]] as const) {
    metrics.record(foreground, [{ metric: 'wechat_answer', elapsed, failed, dedup: 'one-direct-answer' }])
  }
  expect(metrics.view('24h').groups[0]?.metrics[0]).toEqual({
    metric: 'wechat_answer', samples: 1, timedSamples: 1, p50Ms: 40, p95Ms: 40, failures: 0, failureRate: 0,
  })
})

it('times streamed reasoning and counts an abandoned attempt without copying stream content', async () => {
  let time = 0
  const { metrics, warn } = fixture(() => time)
  const ctx = new Context()
  const agent = { ctx, session: { requestHeader: () => ({ config: { model: worker.model } }) } } as unknown as Agent
  const events = agentEvents(ctx, agent)
  const stop = metrics.watch(agent, 'worker')
  try {
    const attemptId = LlmAttemptId('session:1')
    events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 } })
    time = 30
    events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision: 2, index: 0, time: now,
      chunk: { type: 'reasoning-delta', index: 0, text: 'private stream content' } } })
    time = 45
    events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision: 3, index: 1, time: now,
      chunk: { type: 'reasoning-delta', index: 0, text: 'second private fragment' } } })
    time = 60
    events.emit('agent/assistant-stream', { frame: { type: 'chunk', attemptId, revision: 4, index: 2, time: now,
      chunk: { type: 'finish', reason: { kind: 'tool-calls' } } } })
    events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId, revision: 5, index: 3,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(1) } } })
    const failedId = LlmAttemptId('session:2')
    events.emit('agent/assistant-stream', { frame: { type: 'start', attemptId: failedId, revision: 6, turn: 1, step: 1 } })
    time = 100
    events.emit('agent/assistant-stream', { frame: { type: 'end', attemptId: failedId, revision: 7, index: 0, outcome: { kind: 'abandoned' } } })
    const view = metrics.view('24h').groups[0]
    expect(view).toMatchObject({ ...worker, metrics: [
      { metric: 'first_token', samples: 1, p50Ms: 30, failureRate: null },
      { metric: 'model_call', samples: 2, p50Ms: 60, failureRate: 0.5 },
      { metric: 'model_retry', samples: 1, p50Ms: null, failureRate: 1 },
      { metric: 'reasoning', samples: 1, p50Ms: 15, failureRate: null },
    ] })
    expect(JSON.stringify(store!.db.prepare('SELECT * FROM performance_sample').all())).not.toContain('private')
    expect(warn).not.toHaveBeenCalled()
  } finally { stop(); await ctx.fiber.dispose() }
})
