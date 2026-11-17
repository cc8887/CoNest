/** Host-owned membership, immutable identity pins, private routers and model reference authorization in the original Store. */
import { key, type Ticket, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import { WeixinConfigSchema, weixinAccounts, weixinActorId, type WeixinConfig } from '../sources/weixin-config.ts'
import type { Store } from './store.ts'

const SHARED = '@shared', DENIED = '@unbound'
const forbidden = () => new Error('Unknown or inaccessible member resource')
const ADMIN = new Set(['orchestrator_settings_save', 'orchestrator_policy_sync', 'orchestrator_prompts_save'])
const TASK_TOOLS = new Set(['orchestrator_read', 'orchestrator_route', 'orchestrator_ticket_retry', 'orchestrator_ticket_request_status',
  'orchestrator_ticket_note', 'orchestrator_trigger_requeue', 'orchestrator_eval', 'orchestrator_eval_read', 'orchestrator_eval_decide',
  'orchestrator_reply', 'orchestrator_thread_unsubscribe', 'orchestrator_ack', 'orchestrator_thread_unrelated',
  'orchestrator_thread_follow', 'orchestrator_trigger_handback', 'orchestrator_report'])

/** Owns member grants and router addressing; models supply resource ids, never their own identity or authority. */
export class Members {
  private readonly sessions = new Map<string, string>()
  constructor(private readonly store: Store, private readonly masterId: string) {
    for (const name of store.keys(KV.members.session)) this.sessions.set(store.get(name)!, name.slice(KV.members.session.prefix.length))
    this.sync(store.settings())
  }
  private config(settings = this.store.settings()): WeixinConfig { return WeixinConfigSchema.parse(settings.sources.weixin?.config ?? {}) }
  /** Once private identities exist, disabling a Source never restores unrestricted model tools. */
  isolated(): boolean { return this.sessions.size > 0 || this.config().accounts !== undefined }
  /** Validate before committing a settings change; identity reassignment and importing shared history fail closed. */
  validate(settings: Settings): void {
    const config = this.config(settings), accounts = weixinAccounts(config, false)
    if (config.accounts === undefined) {
      if (this.sessions.size && accounts.length) throw new Error('Private member state cannot be changed to legacy single-owner mode')
      return
    }
    if (!this.sessions.size && this.store.db.prepare("SELECT 1 FROM trigger WHERE value ->> '$.source' = 'weixin' LIMIT 1").get())
      throw new Error('Existing shared Weixin history requires a fresh member state directory')
    for (const account of accounts) {
      const old = this.store.get(KV.members.binding(account.accountId))
      if (old && (old.ownerId !== account.ownerId || old.memberId !== account.memberId))
        throw new Error('A pinned Weixin bot/owner cannot be rebound to another member in this state directory')
    }
  }
  /** Called in the same transaction as Source settings; both disabled and removed bindings retain their historical pins. */
  sync(settings: Settings): void {
    this.validate(settings)
    const config = this.config(settings)
    if (!config.accounts) return
    for (const member of config.members ?? []) {
      const name = KV.members.session(member.id)
      const id = this.store.get(name) ?? `member-${key(this.masterId, member.id)}`
      this.store.set(name, id); this.store.afterCommit(() => { this.sessions.set(id, member.id) })
    }
    for (const account of config.accounts) this.store.set(KV.members.binding(account.accountId), { ownerId: account.ownerId, memberId: account.memberId })
  }
  routers(): string[] { return [...this.sessions.keys()] }
  isRouter(id: string): boolean { return this.sessions.has(id) }
  private active(member: string): boolean {
    const settings = this.store.settings(), config = this.config(settings)
    return !!config.members?.some(item => item.id === member && item.status === 'active') && (settings.sources.personal?.enabled === true
      || settings.sources.weixin?.enabled !== false && weixinAccounts(config).some(account => account.memberId === member))
  }
  /** Persist trusted ownership before Engine intake, inside its transaction; Trigger bodies and model arguments grant nothing. */
  claim(trigger: Trigger): void {
    const config = this.config()
    if (trigger.source === 'personal') {
      const member = config.members?.find(member => member.id === trigger.actor.id && member.status === 'active')
      if (member && trigger.actor.source === 'personal' && trigger.meta.memberId === member.id && trigger.meta.scope === 'dm'
        && trigger.channel?.address.memberId === member.id && trigger.channel.source === 'personal') this.store.set(KV.members.trigger(trigger.id), member.id)
      return
    }
    if (trigger.source !== 'weixin' || !config.accounts) return
    const binding = weixinAccounts(config).find(account => trigger.actor.id === weixinActorId(account.accountId, account.ownerId)
      && trigger.actor.source === 'weixin' && trigger.meta.scope === 'dm' && trigger.meta.channelId === account.accountId && trigger.meta.senderId === account.ownerId
      && trigger.channel?.source === 'weixin' && trigger.channel.address.scope === 'dm'
      && trigger.channel.address.channelId === account.accountId && trigger.channel.address.conversationId === account.ownerId)
    if (!binding) return
    const name = KV.members.trigger(trigger.id), previous = this.store.get(name)
    if (previous && previous !== binding.memberId) throw forbidden()
    this.store.set(name, binding.memberId)
  }
  private triggerOwner(id: string): string {
    const grant = this.store.get(KV.members.trigger(id))
    if (grant) return grant
    const trigger = this.store.triggers.get(id)
    return !trigger ? DENIED : trigger.source === 'personal' || trigger.source === 'weixin' && this.isolated() ? DENIED : SHARED
  }
  private ticketOwner(id: string): string {
    const ticket = this.store.tickets.get(id)
    return ticket ? this.triggerOwner(ticket.origin.triggerId) : DENIED
  }
  private threadOwner(id: string): string {
    const thread = this.store.threads.get(id)
    if (!thread) return id.startsWith('weixin:') || id.startsWith('personal:') ? DENIED : SHARED
    if (!['weixin', 'personal'].includes(thread.ref.source)) return SHARED
    const trigger = this.store.read.threadPage(id, 0, 1)[0]
    return trigger ? this.triggerOwner(trigger.id) : DENIED
  }
  private sessionOwner(id: string): string {
    return id === this.masterId ? SHARED : this.sessions.get(id) ?? (id.startsWith('worker-') ? this.ticketOwner(id.slice(7)) : DENIED)
  }
  allowed(id: string): boolean {
    const owner = this.sessionOwner(id)
    return owner === SHARED || owner !== DENIED && this.active(owner)
  }
  private match(id: string, owner: string): boolean { return owner !== DENIED && this.allowed(id) && this.sessionOwner(id) === owner }
  canTrigger(session: string, id: string): boolean { return this.match(session, this.triggerOwner(id)) }
  canTicket(session: string, id: string): boolean { return this.match(session, this.ticketOwner(id)) }
  /** Browser identity comes from its own authenticated tenant session, never a request-supplied member id. */
  canMemberTicket(member: string, id: string): boolean {
    return !!this.config().members?.some(item => item.id === member && item.status === 'active') && this.ticketOwner(id) === member
  }
  canThread(session: string, id: string): boolean { return this.match(session, this.threadOwner(id)) }
  canDecision(session: string, id: string): boolean {
    const decision = this.store.decisions.get(id)
    return !!decision?.triggerIds.length && decision.triggerIds.every(trigger => this.canTrigger(session, trigger))
  }
  sameOwner(trigger: Trigger, ticket: Ticket): boolean { return this.triggerOwner(trigger.id) !== DENIED && this.triggerOwner(trigger.id) === this.ticketOwner(ticket.id) }
  private page<T>(offset: number, count: number, fetch: (offset: number, count: number) => T[], visible: (item: T) => boolean): T[] {
    const result: T[] = []
    let skipped = 0
    for (let position = 0; ; position += 128) {
      const batch = fetch(position, 128)
      for (const item of batch) if (visible(item)) {
        if (skipped++ >= offset) result.push(item)
        if (result.length === count) return result
      }
      if (batch.length < 128) return result
    }
  }
  triggers(session: string, offset: number, count: number): Trigger[] {
    return this.page(offset, count, this.store.read.recentTriggers, trigger => this.canTrigger(session, trigger.id))
  }
  decisions(session: string, offset: number, count: number) {
    return this.page(offset, count, this.store.read.recentDecisions, decision => this.canDecision(session, decision.id))
  }
  targetTrigger(id: string): string | undefined {
    const owner = this.triggerOwner(id)
    if (owner === SHARED) return this.masterId
    if (owner === DENIED || !this.active(owner)) return undefined
    return this.store.get(KV.members.session(owner))
  }
  /** Report/notice envelopes contain host-created references; all of them must resolve to one scope, without fallback. */
  target(value: unknown): string | undefined {
    const owners = new Set<string>()
    const walk = (input: unknown, field = ''): void => {
      if (typeof input === 'string') {
        if (['trigger_id', 'trigger_requeued'].includes(field)) owners.add(this.triggerOwner(input))
        if (['ticket_id', 'ticket_ended'].includes(field)) owners.add(this.ticketOwner(input))
        if (field === 'thread') owners.add(this.threadOwner(input))
      } else if (Array.isArray(input)) input.forEach(item => walk(item, field))
      else if (input && typeof input === 'object') for (const [name, item] of Object.entries(input)) walk(item, name)
    }
    walk(value)
    if (!owners.size) return this.masterId
    if (owners.size !== 1) return undefined
    const owner = [...owners][0]!
    return owner === SHARED ? this.masterId : owner === DENIED || !this.active(owner) ? undefined : this.store.get(KV.members.session(owner))
  }
  /** No private router or worker can use global settings/source readers, or an id from another member. */
  checkRead(session: string, resource: string): void {
    if (!this.isolated()) return
    if (!this.allowed(session)) throw forbidden()
    const name = resource.replace(/^event\//, 'trigger/').replace(/^task\//, 'ticket/').replace(/^observation\//, 'decision/')
    const [kind, id] = name.split('/')
    if (['tickets', 'triggers', 'threads', 'decisions'].includes(name)) return
    const allowed = kind === 'ticket' && id && this.canTicket(session, id) || kind === 'trigger' && id && this.canTrigger(session, id)
      || kind === 'thread' && this.canThread(session, name.slice(7)) || kind === 'decision' && id && this.canDecision(session, id)
    if (allowed) return
    // Existing public source tools remain available to shared workers; they never read private Weixin resources.
    if (this.sessionOwner(session) === SHARED && (name.startsWith('github/') || name.startsWith('feishu/'))) return
    throw forbidden()
  }
  tools(session: string, name: string): boolean {
    if (!this.isolated()) return true
    if (ADMIN.has(name) || !TASK_TOOLS.has(name)) return false
    if (this.sessionOwner(session) !== SHARED && ['orchestrator_eval', 'orchestrator_eval_read', 'orchestrator_eval_decide'].includes(name)) return false
    return true
  }
  checkTool(session: string, name: string, args: unknown): void {
    if (!this.isolated()) return
    if (!this.allowed(session) || !this.tools(session, name)) throw forbidden()
    const walk = (input: unknown): void => {
      if (Array.isArray(input)) { input.forEach(walk); return }
      if (!input || typeof input !== 'object') return
      for (const [field, value] of Object.entries(input)) {
        if (typeof value === 'string') {
          if (field === 'resource' && name === 'orchestrator_read') this.checkRead(session, value)
          if (['trigger_id', 'question_for_trigger_id', 'reply_to_trigger_id'].includes(field) && !this.canTrigger(session, value)) throw forbidden()
          if (field === 'ticket_id' && !this.canTicket(session, value)) throw forbidden()
          if (field === 'thread' && !this.canThread(session, value)) throw forbidden()
        }
        if (field === 'pr_number' && value != null && this.sessionOwner(session) !== SHARED) throw forbidden()
        walk(value)
      }
    }
    walk(args)
  }
  /** Policy prompts retain only this member's identities; host paths and other Source configurations are never composed. */
  settingsFor(session: string): Settings {
    const settings = this.store.settings(), owner = this.sessionOwner(session), config = this.config(settings)
    const allowed = weixinAccounts(config).filter(account => account.memberId === owner).map(account => ({ id: weixinActorId(account.accountId, account.ownerId) }))
    return { ...settings, sources: {}, policy: { ...settings.policy, sources: owner === SHARED
      ? Object.fromEntries(Object.entries(settings.policy.sources).filter(([source]) => !['weixin', 'personal'].includes(source)))
      : { weixin: { allowed, admission: {} }, personal: { allowed: [{ id: owner }], admission: {} } } } }
  }
}
