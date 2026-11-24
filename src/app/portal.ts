/** Browser enrollment and personal-space credentials; all durable state lives in the existing Store. */
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import QRCode from 'qrcode'
import { canRetry, latestReport, liveTicket, ticketStage, type EngineForPeople, type Trigger, type ReceiveResult } from '../core/index.ts'
import { KV } from '../kv.ts'
import { WeixinClient, type WeixinAccount } from '../sources/weixin-api.ts'
import { WeixinConfigSchema, weixinActorId, type WeixinConfig } from '../sources/weixin-config.ts'
import type { BindingPhase, BindingView, PersonalSpace, PersonalView } from './portal-types.ts'
import type { Members } from './members.ts'
import type { Settings } from './settings.ts'
import type { Store } from './store.ts'
import type { Schedules } from './schedules.ts'
import { personalTrigger } from '../sources/personal.ts'

export interface BindingRecord { id: string; memberId: string; phase: BindingPhase; expiresAt: number; qr?: string; ticket?: string;
  baseURL?: string; refreshes: number; error?: string }
export interface PortalInvite { digest: string; expiresAt: number; epoch: number }
export interface PortalAccess { memberId: string; expiresAt: number; epoch: number }
interface PortalHost { store: Store; members: Members; settings: Pick<Settings, 'enrollWeixin'>; stateDir: string; lifetime: AbortSignal;
  engine: Pick<EngineForPeople, 'stopTicket' | 'retryTicket'> & { attach(ticket: string, trigger: string): unknown };
  schedules?: Pick<Schedules, 'list' | 'cancel'>;
  workerTurnStartedAt(ticketId: string): number | undefined;
  receive(trigger: Trigger): ReceiveResult; requestPass(): void }
const nonce = () => randomBytes(32).toString('base64url')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const terminal = (phase: BindingPhase) => ['bound', 'failed', 'expired', 'cancelled'].includes(phase)
/** Safe web rejection: neither provider responses nor host paths are sent to a browser. */
export class PortalError extends Error { constructor(readonly status: number, message: string) { super(message) } }

/** One member equals one tenant; the host owns enrollment, access links and QR lifecycles, never a model tool. */
export class Portal {
  private readonly jobs = new Map<string, { id: string; abort: AbortController; done: Promise<void>; pin?: string }>()
  private readonly running = new Set<Promise<void>>()
  private readonly now: () => number
  constructor(private readonly host: PortalHost, private readonly client = new WeixinClient(), options: { now?: () => number; pollMs?: number } = {}) {
    this.now = options.now ?? Date.now; this.pollMs = options.pollMs ?? 500
    host.lifetime.addEventListener('abort', () => { for (const job of this.jobs.values()) job.abort.abort() }, { once: true })
  }
  private readonly pollMs: number
  private config(): WeixinConfig { return WeixinConfigSchema.parse(this.host.store.settings().sources.weixin?.config ?? {}) }
  private member(id: string, active = false) {
    const member = this.config().members?.find(member => member.id === id)
    if (!member || active && member.status !== 'active') throw new PortalError(404, '个人空间不存在或已停用')
    return member
  }
  private save(config: WeixinConfig, commit: () => void = () => {}, activate = false, personalMember?: string) { this.host.settings.enrollWeixin(config, undefined, commit, activate, personalMember) }
  private viewBinding(record: BindingRecord): BindingView {
    return { id: `${record.id}.${record.refreshes}`, phase: record.phase, expiresAt: record.expiresAt,
      ...record.qr && !terminal(record.phase) ? { qr: record.qr } : {}, ...record.error ? { error: record.error } : {} }
  }
  view(id: string): PersonalSpace {
    const member = this.member(id), config = this.config(), binding = this.host.store.get(KV.portal.binding(id))
    return { ...member, bound: !!config.accounts?.some(account => account.memberId === id), ...binding ? { binding: this.viewBinding(binding) } : {} }
  }
  list(): PersonalSpace[] { return (this.config().members ?? []).map(member => this.view(member.id)) }
  /** Create an unbound private tenant and start QR acquisition, without holding the HTTP response open for Weixin. */
  create(displayName: string): { member: PersonalSpace; invite: string } {
    const name = displayName.trim()
    if (!name || name.length > 100) throw new PortalError(400, '请输入 1–100 字的成员名称')
    const config = this.config()
    if (config.accountId || config.ownerId || config.credentialsFile) throw new PortalError(409, '旧单用户部署请使用新的成员状态目录，不能混用旧私聊历史')
    const id = 'u-' + randomBytes(10).toString('hex')
    const next = WeixinConfigSchema.parse({ ...config, members: [...config.members ?? [], { id, displayName: name, status: 'active' }], accounts: config.accounts ?? [] })
    this.save(next, () => {}, true)
    const invite = this.invite(id)
    this.bind(id, true)
    return { member: this.view(id), invite }
  }
  /** Issue a single-use link. Existing signed-in browsers remain valid until logout or member suspension. */
  invite(id: string): string {
    this.member(id, true)
    const token = nonce(), epoch = this.host.store.get(KV.portal.epoch(id)) ?? 0
    this.save(this.config(), () => { this.host.store.set(KV.portal.invite(id), { digest: digest(token), expiresAt: this.now() + 86_400_000, epoch }) }, false, id)
    return token
  }
  exchange(id: string, token: string): { token: string; maxAge: number } {
    return this.host.store.atomic(() => {
      const invite = this.host.store.get(KV.portal.invite(id)), epoch = this.host.store.get(KV.portal.epoch(id)) ?? 0
      if (!invite || invite.digest !== digest(token) || invite.expiresAt <= this.now() || invite.epoch !== epoch)
        throw new PortalError(401, '访问链接已失效，请向管理员索取新链接')
      this.member(id, true)
      const access = nonce(), maxAge = 30 * 86_400
      this.host.store.set(KV.portal.access(digest(access)), { memberId: id, epoch, expiresAt: this.now() + maxAge * 1000 })
      this.host.store.delete(KV.portal.invite(id))
      return { token: access, maxAge }
    })
  }
  authenticate(id: string, token: string | undefined): void {
    const access = token && this.host.store.get(KV.portal.access(digest(token)))
    if (!access || access.memberId !== id || access.expiresAt <= this.now() || access.epoch !== (this.host.store.get(KV.portal.epoch(id)) ?? 0))
      throw new PortalError(401, '请使用管理员发给你的个人访问链接登录')
    try { this.member(id, true) } catch { throw new PortalError(401, '个人空间已停用') }
  }
  logout(token: string): void { this.host.store.delete(KV.portal.access(digest(token))) }
  status(id: string, status: 'active' | 'disabled'): PersonalSpace {
    this.member(id)
    const config = this.config()
    this.save({ ...config, members: config.members!.map(member => member.id === id ? { ...member, status } : member) }, () => {
      if (status === 'disabled') {
        this.host.store.set(KV.portal.epoch(id), (this.host.store.get(KV.portal.epoch(id)) ?? 0) + 1)
        this.host.store.delete(KV.portal.invite(id))
        const record = this.host.store.get(KV.portal.binding(id))
        if (record && !terminal(record.phase)) this.host.store.set(KV.portal.binding(id), { ...record, phase: 'cancelled', ticket: undefined, qr: undefined })
      }
    })
    if (status === 'disabled') this.jobs.get(id)?.abort.abort()
    return this.view(id)
  }
  bind(id: string, administrator = false): BindingView {
    this.member(id, true)
    const config = this.config(), current = this.host.store.get(KV.portal.binding(id))
    if (!administrator && (this.host.store.settings().sources.weixin?.enabled === false || config.accounts?.some(account => account.memberId === id)))
      throw new PortalError(403, '已绑定账号的重新授权请由管理员发起')
    if (current && !terminal(current.phase) && current.expiresAt > this.now()) { this.launch(current); return this.viewBinding(current) }
    const record: BindingRecord = { id: nonce(), memberId: id, phase: 'creating', refreshes: 0, expiresAt: this.now() + 600_000 }
    this.host.store.set(KV.portal.binding(id), record); this.launch(record)
    return this.viewBinding(record)
  }
  pin(id: string, attempt: string, pin: string): void {
    this.member(id, true)
    const record = this.host.store.get(KV.portal.binding(id)), job = this.jobs.get(id)
    if (!record || this.viewBinding(record).id !== attempt || record.phase !== 'needs_pin' || record.expiresAt <= this.now() || !job || !/^\d{4,16}$/.test(pin))
      throw new PortalError(409, '验证码请求已失效，请刷新页面后重试')
    job.pin = pin
    this.host.store.set(KV.portal.binding(id), { ...record, phase: 'scanned' })
  }
  resume(): void {
    for (const name of this.host.store.keys(KV.portal.binding)) {
      const record = this.host.store.get(name)!
      if (!terminal(record.phase)) this.launch(record)
    }
  }
  private current(record: BindingRecord): BindingRecord {
    this.member(record.memberId, true)
    const current = this.host.store.get(KV.portal.binding(record.memberId))
    if (!current || current.id !== record.id || terminal(current.phase)) throw new PortalError(409, '绑定已取消')
    if (current.expiresAt <= this.now()) throw new PortalError(410, '二维码已过期，请重新生成')
    return current
  }
  private launch(record: BindingRecord): void {
    if (this.jobs.get(record.memberId)?.id === record.id || this.host.lifetime.aborted) return
    this.jobs.get(record.memberId)?.abort.abort()
    const abort = new AbortController(), entry = { id: record.id, abort, done: Promise.resolve(), pin: undefined as string | undefined }
    this.jobs.set(record.memberId, entry)
    entry.done = this.run(record, entry, AbortSignal.any([abort.signal, this.host.lifetime])).finally(() => {
      if (this.jobs.get(record.memberId) === entry) this.jobs.delete(record.memberId)
      this.running.delete(entry.done)
    })
    this.running.add(entry.done)
  }
  private async run(initial: BindingRecord, job: { pin?: string }, signal: AbortSignal): Promise<void> {
    let record = initial
    try {
      for (;;) {
        signal.throwIfAborted(); record = this.current(record)
        if (!record.ticket) {
          const qr = await this.client.qr([], signal), image = await QRCode.toDataURL(qr.url, { width: 300, margin: 2 })
          signal.throwIfAborted(); this.current(record)
          record = { ...record, ticket: qr.qrcode, qr: image, phase: 'waiting', baseURL: WeixinClient.origin }
          this.host.store.set(KV.portal.binding(record.memberId), record)
        }
        if (record.phase === 'needs_pin' && !job.pin) { await delay(this.pollMs, undefined, { signal }); continue }
        let status
        try { status = await this.client.loginStatus(record.ticket!, record.baseURL, job.pin, signal) }
        catch (error) { if (!signal.aborted && error instanceof Error && error.name === 'TimeoutError') continue; throw error }
        job.pin = undefined; signal.throwIfAborted(); this.current(record)
        if (status.status.includes('need_verifycode')) record = { ...record, phase: 'needs_pin' }
        else if (status.status === 'confirmed') { this.complete(record, this.client.account(status)); return }
        else if (status.status === 'scaned_but_redirect') record = { ...record, phase: 'scanned', baseURL: this.client.redirect(status.redirect_host ?? '') }
        else if (status.status === 'scaned') record = { ...record, phase: 'scanned' }
        else if (status.status === 'expired' && record.refreshes < 3) record = { ...record, ticket: undefined, qr: undefined, phase: 'creating', refreshes: record.refreshes + 1 }
        else if (status.status === 'expired') throw new PortalError(410, '二维码已过期，请重新生成')
        else if (!['wait'].includes(status.status)) throw new PortalError(409, status.status === 'binded_redirect'
          ? '微信提示该账号已有绑定，请由管理员核实，未自动覆盖原绑定' : '微信验证未完成，请重新生成二维码')
        this.host.store.set(KV.portal.binding(record.memberId), record)
        await delay(this.pollMs, undefined, { signal })
      }
    } catch (error) {
      if (signal.aborted) return // Persisted QR jobs resume after Runtime restart; no PIN is ever persisted.
      const current = this.host.store.get(KV.portal.binding(initial.memberId))
      if (current?.id === initial.id && !terminal(current.phase)) this.host.store.set(KV.portal.binding(initial.memberId), { ...current,
        phase: error instanceof PortalError && error.status === 410 ? 'expired' : 'failed', qr: undefined, ticket: undefined,
        error: error instanceof PortalError ? error.message : '微信连接失败，请重新生成二维码；原有绑定未改变' })
    }
  }
  private complete(record: BindingRecord, account: WeixinAccount): void {
    const member = this.member(record.memberId, true), config = this.config()
    if (this.host.store.settings().sources.weixin?.enabled === false) throw new PortalError(403, '管理员已暂停微信接入')
    if (config.accounts?.some(binding => binding.memberId !== member.id && (binding.accountId === account.id || binding.ownerId === account.ownerId)))
      throw new PortalError(409, '该微信账号已关联其他个人空间，不能自动改绑')
    const directory = join(this.host.stateDir, 'weixin-accounts')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, randomBytes(20).toString('hex') + '.json')
    writeFileSync(file, JSON.stringify(account), { mode: 0o600, flag: 'wx' })
    try {
      this.host.settings.enrollWeixin({ ...config, accounts: [...config.accounts!.filter(binding => binding.accountId !== account.id),
        { memberId: member.id, credentialsFile: file, accountId: account.id, ownerId: account.ownerId }] },
      { id: weixinActorId(account.id, account.ownerId), name: member.displayName }, () => {
        this.current(record)
        this.host.store.set(KV.portal.binding(member.id), { id: record.id, memberId: member.id, phase: 'bound', expiresAt: record.expiresAt, refreshes: record.refreshes })
      })
    } catch (error) { rmSync(file, { force: true }); throw error }
  }
  personal(id: string, offset = 0, limit = 20): PersonalView {
    const member = this.view(id)
    const tickets = this.host.store.tickets.list().filter(ticket => this.host.members.canMemberTicket(id, ticket.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const tasks = tickets.slice(offset, offset + limit).map(ticket => {
      const state = ticketStage(ticket)
      const stage = state.stage === 'working' && state.action === 'queued' ? 'queued' : state.stage
      const started = stage === 'working' ? this.host.workerTurnStartedAt(ticket.id) : undefined
      return { id: ticket.id, title: ticket.title, stage,
        createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, summary: latestReport(ticket)?.summary ?? '',
        ...(started === undefined ? {} : { turnElapsedMs: Math.max(0, this.now() - started) }),
        ...ticket.attention ? { question: ticket.attention.question } : {}, ...ticket.ended ? { ended: ticket.ended.outcome } : {},
        canStop: liveTicket(ticket), canRetry: canRetry(ticket) }
    })
    return { member, tasks, schedules: this.host.schedules?.list(id) ?? [], total: tickets.length, nextOffset: offset + limit < tickets.length ? offset + limit : null }
  }
  cancelSchedule(member: string, id: string): void {
    if (!this.host.schedules?.cancel(member, id)) throw new PortalError(404, '定时任务不存在或无权访问')
  }
  action(member: string, ticket: string, action: 'stop' | 'retry'): void {
    if (!this.host.members.canMemberTicket(member, ticket)) throw new PortalError(404, '工单不存在或无权访问')
    if (action === 'stop') this.host.engine.stopTicket(ticket); else this.host.engine.retryTicket(ticket)
    this.host.requestPass()
  }
  submit(member: string, requestId: string, text: string, ticket?: string): void {
    this.member(member, true)
    if (ticket && !this.host.members.canMemberTicket(member, ticket)) throw new PortalError(404, '工单不存在或无权访问')
    this.host.store.atomic(() => {
      const trigger = personalTrigger(member, requestId, text)
      const result = this.host.receive(trigger)
      if (ticket && result !== 'duplicate') this.host.engine.attach(ticket, trigger.id)
    })
    this.host.requestPass()
  }
  async stop(): Promise<void> { for (const job of this.jobs.values()) job.abort.abort(); await Promise.allSettled([...this.running]) }
}
