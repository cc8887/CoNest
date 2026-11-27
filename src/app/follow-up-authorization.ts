import { randomUUID } from 'node:crypto'
import { KV } from '../kv.ts'
import type { Members } from './members.ts'
import type { Store } from './store.ts'

const requestLifetime = 24 * 60 * 60 * 1000
const statuses = { grant: 'granted', deny: 'denied', revoke: 'revoked' } as const

export type FollowUpAuthorizationDecision = 'grant' | 'deny' | 'revoke'
export interface FollowUpAuthorizationRecord {
  requestId: string
  status: 'pending' | 'granted' | 'denied' | 'revoked' | 'expired'
  expiresAt: number
  epoch: number
}
export type FollowUpAuthorizationView = { status: 'not_requested' | 'not_required' } | Omit<FollowUpAuthorizationRecord, 'epoch'>

/** Persists a per-ticket authorization decision; never starts a listener or runs work. */
export class FollowUpAuthorization {
  constructor(private readonly store: Store, private readonly members: Pick<Members, 'canMemberTicket'>,
    private readonly requireApproval = false,
    private readonly now: () => number = Date.now) {}

  request(memberId: string, ticketId: string): FollowUpAuthorizationView | undefined {
    return this.store.atomic(() => {
      const view = this.read(memberId, ticketId)
      if (!view || view.status !== 'not_requested') return view
      if (this.store.tickets.get(ticketId)?.ended) return undefined
      const next: FollowUpAuthorizationRecord = { requestId: randomUUID(), status: 'pending',
        expiresAt: this.now() + requestLifetime, epoch: this.epoch(memberId) }
      this.store.set(KV.followUpAuthorization(ticketId), next)
      return this.view(next)
    })
  }

  read(memberId: string, ticketId: string): FollowUpAuthorizationView | undefined {
    if (!this.members.canMemberTicket(memberId, ticketId)) return undefined
    const current = this.store.get(KV.followUpAuthorization(ticketId))
    const record = current?.epoch === this.epoch(memberId) ? current : undefined
    const ended = !!this.store.tickets.get(ticketId)?.ended
    if (record?.status === 'denied' || record?.status === 'revoked') return this.view(record)
    if (!ended && !this.requireApproval) return { status: 'not_required' }
    return record ? this.view(record, ended) : { status: 'not_requested' }
  }

  allows(memberId: string, ticketId: string): boolean {
    const status = this.read(memberId, ticketId)?.status
    return status === 'not_required' || status === 'granted'
  }

  decide(memberId: string, ticketId: string, requestId: string, decision: FollowUpAuthorizationDecision):
    FollowUpAuthorizationView | undefined {
    return this.store.atomic(() => {
      const current = this.read(memberId, ticketId)
      if (!current || !('requestId' in current) || current.requestId !== requestId) return undefined
      const status = statuses[decision]
      if (current.status === status) return current
      if (current.status !== (decision === 'revoke' ? 'granted' : 'pending') || !status) return undefined
      const next: FollowUpAuthorizationRecord = { ...current, status, epoch: this.epoch(memberId) }
      this.store.set(KV.followUpAuthorization(ticketId), next)
      return this.view(next)
    })
  }

  close(ticketId: string): void {
    const name = KV.followUpAuthorization(ticketId), current = this.store.get(name)
    if (current?.status === 'pending' || current?.status === 'granted') this.store.set(name, { ...current, status: 'expired' })
  }

  private epoch(memberId: string): number { return this.store.get(KV.portal.epoch(memberId)) ?? 0 }

  private view({ requestId, expiresAt, status }: FollowUpAuthorizationRecord, ended = false): FollowUpAuthorizationView {
    const expired = (status === 'pending' || status === 'granted') && (ended || expiresAt <= this.now())
    return { requestId, expiresAt, status: expired ? 'expired' : status }
  }
}
