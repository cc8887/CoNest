/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import { key, type OutboundMessage, type Outbox as OutboxPort, type ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { DropReason, Receipt, Store } from './store.ts'
import type { PerformanceLabel, PerformanceMetrics } from './performance.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  allowed?(message: OutboundMessage): boolean
  readonly performance?: {
    label(message: OutboundMessage): PerformanceLabel
    record: PerformanceMetrics['record']
  }
  paused(): boolean
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
  send(message: OutboundMessage): void {
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    const label = message.channel.source === 'weixin' ? this.host.performance?.label(message) : undefined
    const answer = message.answerTo && { received: Date.parse(message.answerTo.receivedAt), dedup: key('wechat-answer', message.answerTo.triggerId) }
    store.atomic(() => {
      if (store.receipts.add(message, label && { ...label, enqueued: Date.now(), ...(answer ? { answer } : {}) })) effects.enqueue('reply', message.id, {})
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private settle(receipt: Receipt, outcome: 'sent' | DropReason, triedMs?: number): void {
    const { timing } = receipt
    const { store, performance } = this.host
    store.atomic(() => {
      store.receipts.settle(receipt, outcome)
      if (!timing || !performance) return
      const at = Date.now(), failed = outcome !== 'sent'
      performance.record(timing, [
        { metric: 'wechat_delivery', elapsed: at - timing.enqueued, failed },
        ...(triedMs === undefined ? [] : [{ metric: 'wechat_send' as const, elapsed: triedMs, failed }]),
        ...(timing.answer ? [{ metric: 'wechat_answer' as const, elapsed: at - timing.answer.received, failed, dedup: timing.answer.dedup }] : []),
      ], at)
    })
  }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (this.host.allowed?.(receipt) === false) { this.settle(receipt, 'channelIgnored'); return }
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { this.settle(receipt, 'channelIgnored'); return }
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const start = performance.now()
    const result = await sources.send(receipt, commands).catch(error => {
      if (receipt.timing) this.host.performance?.record(receipt.timing, [{ metric: 'wechat_send', elapsed: performance.now() - start, failed: true }])
      throw error
    })
    if (result === 'waiting') throw new Later('The Source is not installed')
    this.settle(receipt, result === 'gone' ? 'channelGone' : 'sent', performance.now() - start)
  }
}
