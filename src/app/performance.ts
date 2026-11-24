/** Numeric observations from managed DSH sessions, the Weixin outbox, and assignment dispatch. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isTokenDelta } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { key, latestAssignment, type Ticket } from '../core/index.ts'
import type { PerformanceMetric, PerformanceRole, PerformanceSummary, PerformanceView, PerformanceWindow } from './performance-types.ts'
import type { Store } from './store.ts'

const DAY = 24 * 60 * 60 * 1000
export interface PerformanceLabel { role: PerformanceRole; model: string }
interface Sample {
  metric: PerformanceMetric
  elapsed: number | null
  failed?: boolean
  dedup?: string
}
interface Attempt {
  id: string
  model: string
  start: number
  retry: boolean
  interrupted?: true
  first?: number
  reasoningStart?: number
  reasoningEnd?: number
  finish?: string
}
interface Observation {
  waiting: Map<string, { start: number; admitted: number }>
  attempt?: Attempt
  assignmentId?: string
  lastStep?: string
}

/** Observes managed model streams and aggregates recent timings without persisting model or message content. */
export class PerformanceMetrics {
  private readonly observed = new WeakMap<Agent, Observation>()
  constructor(private readonly store: Pick<Store, 'db' | 'atomic' | 'triggers'>,
    private readonly warn: () => void, private readonly wallTime = Date.now, private readonly monotonic = () => performance.now()) {}

  startRetention(): () => void {
    const prune = () => {
      try { this.store.db.prepare('DELETE FROM performance_sample WHERE at < ?').run(this.wallTime() - 7 * DAY) }
      catch { this.warn() }
    }
    prune()
    const timer = setInterval(prune, 60 * 60 * 1000)
    timer.unref()
    return () => clearInterval(timer)
  }

  record(label: PerformanceLabel, samples: readonly Sample[], at = this.wallTime()): void {
    if (!samples.length) return
    try {
      const insert = this.store.db.prepare(`INSERT INTO performance_sample
        (at, role, model, metric, elapsed, failed, dedup) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup) DO UPDATE SET at = excluded.at, model = excluded.model, elapsed = excluded.elapsed, failed = excluded.failed
        WHERE performance_sample.failed = 1 AND excluded.failed = 0`)
      this.store.atomic(() => {
        for (const sample of samples) {
          const elapsed = sample.elapsed !== null && Number.isFinite(sample.elapsed) && sample.elapsed >= 0 ? sample.elapsed : null
          if (elapsed === null && sample.failed === undefined) continue
          insert.run(at, label.role, label.model, sample.metric, elapsed, sample.failed === undefined ? null : Number(sample.failed), sample.dedup ?? null)
        }
      })
    } catch { this.warn() }
  }

  /** The loop appends the candidate here when it takes it out of the inbox for a model step. */
  admit(agent: Agent, event: SessionEvent): void {
    const observation = this.observed.get(agent)
    if (!observation) return
    if (event.type === 'turn/end') { observation.waiting.clear(); return }
    if (event.type === 'assistant/message' && event.data.interrupted && observation.attempt) {
      observation.attempt.interrupted = true
      return
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-superagent' || event.data.source.form !== 'relay') return
    const block = event.data.content[0]
    if (block?.type !== 'text') return
    let card: { kind?: unknown; trigger_id?: unknown } | null
    try { card = JSON.parse(block.text) } catch { return }
    if (card?.kind !== 'candidate' || typeof card.trigger_id !== 'string') return
    const trigger = this.store.triggers.get(card.trigger_id)
    if (trigger?.source === 'weixin') observation.waiting.set(trigger.id, { start: Date.parse(trigger.at), admitted: event.time })
  }

  watch(agent: Agent, role: PerformanceRole, ticket?: () => Ticket | undefined): () => void {
    const observation: Observation = { waiting: new Map() }
    this.observed.set(agent, observation)
    const off = agent.ctx.on('agent/assistant-stream', ({ frame }) => {
      const now = this.monotonic()
      if (frame.type === 'start') {
        // DSH commits the resolved request header before emitting the stream's start.
        const model = agent.session.requestHeader()?.config.model || 'unknown'
        const position = `${frame.turn}:${frame.step}`
        observation.attempt = { id: frame.attemptId, model, start: now, retry: observation.lastStep === position }
        observation.lastStep = position
        const queues: Sample[] = []
        for (const [id, time] of observation.waiting) {
          queues.push({ metric: 'foreground_queue', elapsed: time.admitted - time.start, dedup: key('foreground-queue', id) })
        }
        observation.waiting.clear()
        const work = ticket?.()
        const assignment = work && latestAssignment(work)
        if (assignment?.startedAt && observation.assignmentId !== assignment.id) {
          observation.assignmentId = assignment.id
          queues.push({ metric: 'worker_queue', elapsed: Date.parse(assignment.startedAt) - Date.parse(assignment.createdAt),
            dedup: key('worker-queue', assignment.id) })
        }
        this.record({ role, model }, queues)
        return
      }
      const attempt = observation.attempt
      if (attempt?.id !== frame.attemptId) return
      if (frame.type === 'chunk') {
        const chunk = frame.chunk
        if (isTokenDelta(chunk)) attempt.first ??= now
        if (chunk.type === 'reasoning-delta' && chunk.text.length) {
          attempt.reasoningStart ??= now
          attempt.reasoningEnd = now
        }
        if (chunk.type === 'finish') attempt.finish = chunk.reason.kind
        return
      }
      observation.attempt = undefined
      const failed = !!attempt.interrupted || frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message'
        || attempt.finish !== 'stop' && attempt.finish !== 'tool-calls'
      const elapsed = now - attempt.start
      this.record({ role, model: attempt.model }, [
        { metric: 'model_call', elapsed, failed },
        ...(attempt.retry ? [{ metric: 'model_retry' as const, elapsed, failed }] : []),
        { metric: 'first_token', elapsed: attempt.first === undefined ? null : attempt.first - attempt.start },
        { metric: 'reasoning', elapsed: attempt.reasoningStart === undefined ? null : attempt.reasoningEnd! - attempt.reasoningStart },
      ])
    })
    return () => { off(); this.observed.delete(agent) }
  }

  view(window: PerformanceWindow): PerformanceView {
    const now = this.wallTime()
    const rows = this.store.db.prepare(`
      WITH scoped AS (SELECT role, model, metric, elapsed, failed FROM performance_sample WHERE at BETWEEN ? AND ?),
      totals AS (
        SELECT role, model, metric, count(*) AS samples, sum(failed) AS failures
        FROM scoped GROUP BY role, model, metric
      ),
      ranked AS (
        SELECT role, model, metric, elapsed,
          row_number() OVER (PARTITION BY role, model, metric ORDER BY elapsed) AS position,
          count(*) OVER (PARTITION BY role, model, metric) AS timedSamples
        FROM scoped WHERE elapsed IS NOT NULL AND failed IS NOT 1
      ),
      percentiles AS (
        SELECT role, model, metric, max(timedSamples) AS timedSamples,
          max(CASE WHEN position = (timedSamples * 50 + 99) / 100 THEN elapsed END) AS p50Ms,
          max(CASE WHEN position = (timedSamples * 95 + 99) / 100 THEN elapsed END) AS p95Ms
        FROM ranked GROUP BY role, model, metric
      )
      SELECT totals.*, coalesce(timedSamples, 0) AS timedSamples, p50Ms, p95Ms
      FROM totals LEFT JOIN percentiles USING (role, model, metric)
      ORDER BY role, model, metric
    `).all(now - (window === '24h' ? DAY : 7 * DAY), now) as unknown as
      (PerformanceLabel & Omit<PerformanceSummary, 'failureRate'>)[]
    const groups = new Map<string, PerformanceView['groups'][number]>()
    for (const { role, model, ...row } of rows) {
      const id = `${role}:${model}`
      const group = groups.get(id) ?? { role, model, metrics: [] }
      group.metrics.push({ ...row, failureRate: row.failures === null ? null : row.failures / row.samples })
      groups.set(id, group)
    }
    return { window, groups: [...groups.values()] }
  }
}
