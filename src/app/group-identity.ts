/** Matches live Feishu group senders to registered CoNest members using verified, app-scoped bindings. */
import { createHash, randomBytes } from 'node:crypto'
import type { ChannelRef, Trigger } from '../core/index.ts'
import type { FeishuBot } from '../deployment.ts'
import { KV } from '../kv.ts'
import type { FeishuConfig } from '../sources/feishu.ts'
import type { Members } from './members.ts'
import { PortalError } from './portal.ts'
import type { Store } from './store.ts'

export interface FeishuMemberBinding { app: string; senderId: string; boundAt: number }
export interface FeishuPairing { app: string; session: string; code: string; createdAt: number; expiresAt: number; senderId?: string }
export interface GroupMatch { chatId: string; messageId: string; at: string }
export interface GroupScheduleOrigin extends FeishuMemberBinding { memberId: string; channel: ChannelRef }
type Connection = { bot: FeishuBot; config: FeishuConfig }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const appKey = ({ brand, appId }: FeishuBot) => `${brand}:${appId}`
const pairCommand = /^conest-bind ([A-Za-z0-9_-]{43})$/

export const isFeishuPairingMessage = (trigger: Trigger): boolean => trigger.source === 'feishu'
  && trigger.meta.direct === true && pairCommand.test(trigger.text.trim())

/** Owns session-bound Feishu pairing and stores each member's latest verified group match. */
export class GroupIdentity {
  constructor(private readonly store: Store, private readonly members: Pick<Members, 'isActiveMember'>,
    private readonly connection: () => Connection | undefined, private readonly now = Date.now) {}

  /** The returned command is shown once to the authenticated personal session. */
  start(memberId: string, session: string) {
    const { bot, config } = this.requireConnection(memberId)
    if (!config.directMessages) throw new PortalError(409, '飞书机器人未开放私聊配对')
    const app = appKey(bot), token = randomBytes(32).toString('base64url'), code = digest(token)
    const createdAt = this.now(), expiresAt = createdAt + 5 * 60_000
    return this.store.atomic(() => {
      if (this.store.get(KV.members.feishuBinding(memberId))?.app === app) throw new PortalError(409, '此个人空间已绑定当前飞书应用')
      this.clearPairing(memberId)
      this.store.set(KV.portal.feishuPairing(memberId), { app, session: digest(session), code, createdAt, expiresAt })
      this.store.set(KV.portal.feishuCode(code), memberId)
      return { status: 'waiting', command: `conest-bind ${token}`, expiresAt }
    })
  }

  status(memberId: string, session: string) {
    const connection = this.connection()
    if (!connection) return { status: 'unavailable' }
    const app = appKey(connection.bot)
    const bound = this.store.get(KV.members.feishuBinding(memberId))
    if (bound?.app === app) return { status: 'bound', senderId: bound.senderId, lastMatch: this.store.get(KV.members.groupMatch(memberId)) }
    const pair = this.pairing(memberId, app, session)
    if (!pair) return { status: 'unbound' }
    return { status: pair.senderId ? 'confirm' : 'waiting', senderId: pair.senderId, expiresAt: pair.expiresAt }
  }

  confirm(memberId: string, session: string) {
    const { bot } = this.requireConnection(memberId), app = appKey(bot)
    return this.store.atomic(() => {
      const senderId = this.pairing(memberId, app, session)?.senderId
      if (!senderId) throw new PortalError(409, '请先用飞书私聊发送有效的配对指令')
      const pin = KV.members.feishuOwner(app, senderId), owner = this.store.get(pin)
      if (owner && owner !== memberId) throw new PortalError(409, '此飞书账号已归属其他个人空间')
      this.store.set(pin, memberId)
      this.store.set(KV.members.feishuBinding(memberId), { app, senderId, boundAt: this.now() })
      this.store.delete(KV.members.groupMatch(memberId))
      this.clearPairing(memberId)
      return { status: 'bound', senderId }
    })
  }

  revoke(memberId: string): void {
    this.store.atomic(() => {
      this.clearPairing(memberId)
      this.store.delete(KV.members.feishuBinding(memberId))
      this.store.delete(KV.members.groupMatch(memberId))
    })
  }

  /** Called only for events from the live bot connection. Group identity uses sender metadata exclusively. */
  observe(trigger: Trigger): string | undefined {
    const connection = this.connection()
    if (!connection || trigger.source !== 'feishu' || trigger.actor.source !== 'feishu' || !trigger.human) return
    const { bot, config } = connection, app = appKey(bot), senderId = trigger.actor.id
    const { direct, chatId, messageId } = trigger.meta, at = Date.parse(trigger.at)
    if (!/^ou_[A-Za-z0-9]+$/.test(senderId) || senderId === bot.botId || typeof chatId !== 'string' || !/^oc_[A-Za-z0-9]+$/.test(chatId)
      || typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(messageId) || !Number.isFinite(at)) return
    return this.store.atomic(() => {
      if (direct === true) {
        if (config.directMessages) this.capturePairing(app, senderId, trigger.text, at)
        return
      }
      if (trigger.addressed !== 'mention' && trigger.addressed !== 'group') return
      const memberId = this.groupMember(trigger)
      if (!memberId) return
      const latest = KV.members.groupMatch(memberId), previous = this.store.get(latest)
      if (!previous || previous.messageId !== messageId && (previous.at < trigger.at || previous.at === trigger.at && previous.messageId < messageId)) {
        this.store.set(latest, { chatId, messageId, at: trigger.at })
      }
      return memberId
    })
  }

  /** Checks the current group sender before any group context is sent to a model. */
  groupMember(trigger: Trigger): string | undefined {
    const connection = this.connection(), { chatId, direct, messageId } = trigger.meta, senderId = trigger.actor.id
    if (!connection || trigger.source !== 'feishu' || trigger.actor.source !== 'feishu' || !trigger.human || direct !== false
      || !/^ou_[A-Za-z0-9]+$/.test(senderId) || typeof messageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(messageId)
      || !connection.config.chats.some(chat => chat.chatId === chatId)) return
    const app = appKey(connection.bot), memberId = this.store.get(KV.members.feishuOwner(app, senderId))
    if (!memberId || !this.members.isActiveMember(memberId)) return
    const binding = this.store.get(KV.members.feishuBinding(memberId))
    if (binding?.app === app && binding.senderId === senderId && Date.parse(trigger.at) >= binding.boundAt) return memberId
  }

  scheduleOrigin(memberId: string, trigger: Trigger): GroupScheduleOrigin | undefined {
    const binding = this.store.get(KV.members.feishuBinding(memberId))
    if (!binding || !trigger.channel || trigger.channel.source !== 'feishu' || trigger.channel.address.chatId !== trigger.meta.chatId
      || trigger.channel.address.messageId !== trigger.meta.messageId || trigger.actor.id !== binding.senderId) return
    const origin = { ...binding, memberId, channel: trigger.channel }
    return this.scheduleAllowed(origin) ? origin : undefined
  }

  scheduleAllowed(origin: GroupScheduleOrigin): boolean {
    const connection = this.connection(), binding = this.store.get(KV.members.feishuBinding(origin.memberId))
    return !!connection?.config.groupSchedules && origin.app === appKey(connection.bot)
      && connection.config.chats.some(chat => chat.chatId === origin.channel.address.chatId)
      && this.members.isActiveMember(origin.memberId) && binding?.app === origin.app
      && binding.senderId === origin.senderId && binding.boundAt === origin.boundAt
  }

  private requireConnection(memberId: string): Connection {
    if (!this.members.isActiveMember(memberId)) throw new PortalError(404, '个人空间不存在或已停用')
    const connection = this.connection()
    if (!connection) throw new PortalError(409, '飞书群聊身份识别未启用或机器人未就绪')
    return connection
  }

  private pairing(memberId: string, app: string, session: string): FeishuPairing | undefined {
    const pair = this.store.get(KV.portal.feishuPairing(memberId))
    return pair?.app === app && pair.session === digest(session) && pair.expiresAt > this.now() ? pair : undefined
  }

  private clearPairing(memberId: string): void {
    const name = KV.portal.feishuPairing(memberId), pair = this.store.get(name)
    if (!pair) return
    this.store.delete(KV.portal.feishuCode(pair.code))
    this.store.delete(name)
  }

  private capturePairing(app: string, senderId: string, text: string, at: number): void {
    const token = pairCommand.exec(text.trim())?.[1]
    if (!token) return
    const code = digest(token), lookup = KV.portal.feishuCode(code), memberId = this.store.get(lookup)
    if (!memberId || !this.members.isActiveMember(memberId)) return
    const name = KV.portal.feishuPairing(memberId), pair = this.store.get(name)
    if (!pair || pair.code !== code || pair.app !== app || pair.senderId || pair.expiresAt <= this.now() || at < pair.createdAt || at >= pair.expiresAt) return
    this.store.set(name, { ...pair, senderId })
    this.store.delete(lookup)
  }
}
