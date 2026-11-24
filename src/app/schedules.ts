import { key, liveTicket, type ChannelRef, type Engine, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family, KV } from '../kv.ts'
import { allowedSender } from '../policy.ts'
import type { GroupScheduleOrigin } from './group-identity.ts'
import type { Members } from './members.ts'
import type { Store } from './store.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export type ScheduleRepeat = 'once' | 'daily' | 'weekly'
export interface ScheduleView { id: string; title: string; repeat: ScheduleRepeat; nextAt: string }
interface Request { title: string; instructions: string; run_at: string; repeat: ScheduleRepeat }
export interface Schedule extends Request {
  id: string; memberId: string; triggerId: string; nextAt?: number; lastTicketId?: string
  status: 'scheduled' | 'dispatched' | 'cancelled'
}
interface Host {
  store: Store
  members: Members
  engine: Pick<Engine, 'candidate' | 'decide' | 'receive' | 'reply'>
  sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'scope'>
  groupAllowed(origin: GroupScheduleOrigin): boolean
  send(message: OutboundMessage): void
  report(error: unknown): void
}

const intervals = { once: 0, daily: 86_400_000, weekly: 604_800_000 } as const
const maxActive = 20
const unavailable = () => new Error('Unknown or inaccessible schedule request')
export const groupScheduleAck = (id: string) => key('group-schedule-ack', id)
const scheduleId = (triggerId: string) => key('schedule', triggerId)
const view = (schedule: Schedule): ScheduleView => ({ id: schedule.id, title: schedule.title,
  repeat: schedule.repeat, nextAt: new Date(schedule.nextAt!).toISOString() })

/** Persists member schedules and turns due occurrences into ordinary private tickets. */
export class Schedules {
  constructor(private readonly host: Host, private readonly now = () => Date.now()) {}

  create(session: string, triggerId: string, request: Request) {
    const { store, members, engine } = this.host
    return store.atomic(() => {
      const memberId = members.routerMember(session)
      if (!memberId || !members.canTrigger(session, triggerId)) throw unavailable()
      const id = scheduleId(triggerId), name = KV.schedules.record(memberId, id)
      const existing = store.get(name)
      if (existing) return { id, status: existing.status, ...(existing.nextAt === undefined ? {} : { nextAt: view(existing).nextAt }) }
      const trigger = this.request(session, triggerId, true)
      const nextAt = Date.parse(request.run_at)
      if (!Number.isFinite(nextAt) || nextAt <= this.now()) throw new Error('The first run must be in the future')
      if (this.list(memberId).length >= maxActive) throw new Error('This member already has 20 active schedules')
      const schedule: Schedule = { ...request, id, memberId, triggerId, status: 'scheduled', nextAt }
      const candidate = engine.candidate(triggerId)!
      const decision = engine.decide(triggerId, { kind: 'ignore', evalId: candidate.evalId, reason: 'Saved as a schedule, not an immediate ticket' })
      if (decision.kind !== 'ignore') throw unavailable()
      this.save(schedule)
      const group = store.get(KV.schedules.group(triggerId))
      if (group) this.host.send({ id: groupScheduleAck(triggerId), channel: { ...group.channel,
        address: { ...group.channel.address, scheduleRequest: triggerId } }, text: '已创建定时任务。到期后的工单和结果请在发起人的 CoNest 个人空间查看。', kind: 'notice' })
      else if (trigger.source === 'weixin') engine.reply({ purpose: 'answer', triggerId,
        text: `已创建定时任务「${schedule.title}」。首次执行：${request.run_at}；${{ once: '仅一次', daily: '每天', weekly: '每周' }[request.repeat]}。` })
      return { id, status: schedule.status, nextAt: view(schedule).nextAt }
    })
  }

  list(memberId: string): ScheduleView[] {
    if (!this.host.members.isActiveMember(memberId)) return []
    const active = family<number>(KV.schedules.active(memberId, ''))
    return this.host.store.keys(active).flatMap(name => {
      const schedule = this.host.store.get(KV.schedules.record(memberId, name.slice(active.prefix.length)))
      return schedule?.nextAt === undefined ? [] : [view(schedule)]
    }).sort((left, right) => left.nextAt.localeCompare(right.nextAt))
  }

  cancel(memberId: string, id: string): boolean {
    return this.host.store.atomic(() => {
      const schedule = this.host.store.get(KV.schedules.record(memberId, id))
      if (!schedule || !this.host.members.isActiveMember(memberId)) return false
      if (schedule.status === 'scheduled') this.finish(schedule, 'cancelled')
      return true
    })
  }

  blocksRouting(triggerId: string): boolean {
    const { store } = this.host, memberId = store.get(KV.members.trigger(triggerId))
    return !!store.get(KV.schedules.group(triggerId)) || !!memberId && !!store.get(KV.schedules.record(memberId, scheduleId(triggerId)))
  }

  manage(session: string, triggerId: string, cancelId?: string) {
    const { store, engine, members } = this.host
    return store.atomic(() => {
      const trigger = this.request(session, triggerId, false), memberId = members.routerMember(session)!
      if (cancelId === undefined) return { schedules: this.list(memberId) }
      const candidate = engine.candidate(triggerId)!
      if (!this.cancel(memberId, cancelId)) throw unavailable()
      if (engine.decide(triggerId, { kind: 'ignore', evalId: candidate.evalId, reason: 'Handled schedule management request' }).kind !== 'ignore') throw unavailable()
      if (trigger.source === 'weixin') engine.reply({ purpose: 'answer', triggerId, text: '已取消此定时任务的后续执行；已经生成的工单不受影响。' })
      return { id: cancelId, cancelled: true }
    })
  }

  due(): void {
    const { store } = this.host, now = this.now()
    for (const name of store.keys(KV.schedules.active)) {
      if ((store.get(name) ?? Infinity) > now) continue
      const [memberId, id] = name.slice(KV.schedules.active.prefix.length).split(':')
      if (!memberId || !id) continue
      try { store.atomic(() => this.dispatch(memberId, id, now)) }
      catch (error) { this.host.report(error) }
    }
  }

  private request(session: string, id: string, allowGroup: boolean): Trigger {
    const { members, store, engine, sources } = this.host
    const trigger = store.triggers.get(id), candidate = engine.candidate(id), group = store.get(KV.schedules.group(id))
    if (!members.routerMember(session) || !members.canTrigger(session, id) || !trigger?.human || !trigger.channel
      || !['personal', 'weixin'].includes(trigger.source) || candidate?.strength !== 'explicit' || candidate.triggers.length !== 1
      || trigger.meta.scheduleId || !sources.channelAllowed(trigger.channel) || !allowedSender(store.settings(), trigger.actor)
      || group && (!allowGroup || !this.host.groupAllowed(group))) throw unavailable()
    return trigger
  }

  private save(schedule: Schedule): void {
    const { store } = this.host
    store.set(KV.schedules.record(schedule.memberId, schedule.id), schedule)
    const active = KV.schedules.active(schedule.memberId, schedule.id)
    if (schedule.nextAt === undefined) store.delete(active)
    else store.set(active, schedule.nextAt)
  }

  private finish(schedule: Schedule, status: 'cancelled' | 'dispatched'): void {
    delete schedule.nextAt
    this.save({ ...schedule, status })
  }

  private dispatch(memberId: string, id: string, now: number): void {
    const { store, engine, members, sources } = this.host
    const schedule = store.get(KV.schedules.record(memberId, id)), next = schedule?.nextAt
    if (!schedule || next === undefined || next > now) return
    const origin = store.triggers.get(schedule.triggerId), group = store.get(KV.schedules.group(schedule.triggerId))
    if (!origin?.channel || !members.isActiveMember(memberId) || group && !this.host.groupAllowed(group)) return this.finish(schedule, 'cancelled')
    if (!sources.instance(origin.source)?.enabled) return
    if (!sources.channelAllowed(origin.channel) || !sources.scope(origin).listened || !allowedSender(store.settings(), origin.actor)) return this.finish(schedule, 'cancelled')
    const last = schedule.lastTicketId && store.tickets.get(schedule.lastTicketId)
    if (last && liveTicket(last)) return
    const occurrence = key('schedule-run', id, String(next)), thread = { source: origin.source, id: occurrence }
    const channel: ChannelRef = { ...origin.channel, thread: `${origin.source}:${occurrence}`, address: { ...origin.channel.address, messageId: occurrence } }
    const trigger: Trigger = { id: occurrence, source: origin.source, actor: origin.actor, human: true, addressed: 'direct',
      at: new Date(now).toISOString(), text: schedule.instructions, threads: [thread], channel, meta: { ...origin.meta, messageId: occurrence, scheduleId: id } }
    members.claim(trigger)
    if (store.get(KV.members.trigger(occurrence)) !== memberId || engine.receive(trigger) !== 'stored') throw unavailable()
    const decision = engine.decide(occurrence, { kind: 'accept', title: schedule.title, scope: schedule.instructions,
      name: 'scheduled-run', reason: 'Scheduled run authorized by the member' })
    if (!decision.ticketId) throw unavailable()
    schedule.lastTicketId = decision.ticketId
    const interval = intervals[schedule.repeat]
    if (!interval) this.finish(schedule, 'dispatched')
    else this.save({ ...schedule, nextAt: next + (Math.floor((now - next) / interval) + 1) * interval })
  }
}
