/** Opt-in QQ intake through a local Octop process. QQ group activity stays in the sender's private task space. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type ReceiveResult, type Trigger } from '../core/index.ts'
import { groupAddress } from '../ingress/group-address.ts'
import { KV } from '../kv.ts'
import { allowedSender } from '../policy.ts'
import type { Health } from '../sources/host.ts'
import type { ContextMessage, SourceKind } from '../sources/kind.ts'
import type { OctopMessage, OctopTransportOptions, QqTransport, QqTransportFactory } from '../sources/octop-transport.ts'
import { personalTrigger } from '../sources/personal.ts'
import { classifyGroupAddress } from './group-address-model.ts'
import { Later } from './effects.ts'
import type { Members } from './members.ts'
import type { Store } from './store.ts'

const QQ = 'qq'
const PUBLIC_RECEIPT = '已收到。后续内容请在你自己的 CoNest 个人空间查看。'
const RECENT_MS = 2 * 60_000
const REPLY_WINDOW_MS = 60 * 60_000
const id = z.string().trim().min(1).max(256)
const scopes = z.enum(['dm', 'group'])
const binding = z.object({ scope: scopes, conversationId: id, senderId: id, memberId: z.string().regex(/^[\w-]{1,80}$/) }).strict()
const scopeKey = ({ scope, conversationId, senderId }: z.infer<typeof binding>) => key(scope, conversationId, senderId)
const schema = z.object({ appId: z.string().regex(/^(\d{1,32})?$/).default(''), botName: z.string().trim().min(1).max(80).default('CoNest'),
  groups: z.array(z.object({ conversationId: id, listen: z.enum(['mention', 'smart']) }).strict()).max(20).default([]),
  bindings: z.array(binding).max(100).default([]), modelProvider: z.string().trim().max(200).default(''),
  model: z.string().trim().max(200).default(''),
}).strict().refine(({ groups, bindings }) => new Set(groups.map(row => row.conversationId)).size === groups.length
  && new Set(bindings.map(scopeKey)).size === bindings.length && bindings.every(row => row.scope === 'dm'
    ? row.conversationId === row.senderId : groups.some(group => group.conversationId === row.conversationId)), 'QQ bindings must name a unique sender in an enabled conversation')
  .refine(config => !!config.model === !!config.modelProvider, 'Set both the addressing model and its provider')

export type QqConfig = z.infer<typeof schema>
type QqLaunch = Omit<OctopTransportOptions, 'accountId'>
type Origin = Pick<OctopMessage, 'accountId' | 'scope' | 'conversationId' | 'senderId' | 'messageId' | 'at' | 'messageIndex'>
const originSchema = z.object({ accountId: id, scope: scopes, conversationId: id, senderId: id,
  messageId: z.string().min(1).max(512), at: z.iso.datetime({ offset: true }), messageIndex: z.string().min(1).max(1024).optional() })
const messageKey = (origin: Origin) => key(QQ, origin.accountId, origin.scope, origin.conversationId, origin.messageId)
const pinKey = (origin: Origin) => KV.qq.binding(key(origin.accountId, origin.scope, origin.conversationId, origin.senderId))
const replyReferences = (origin: Origin) => KV.qq.references(key(origin.accountId, origin.conversationId))
const groupReceiptId = (origin: Origin) => key('qq-receipt', messageKey(origin))
const qqChannel = (origin: Origin, memberId: string): ChannelRef => ({ source: QQ,
  thread: `qq:${key(origin.accountId, origin.scope, origin.conversationId, memberId)}`,
  address: { accountId: origin.accountId, scope: origin.scope, conversationId: origin.conversationId, senderId: origin.senderId,
    messageId: origin.messageId, at: origin.at, ...(origin.messageIndex ? { messageIndex: origin.messageIndex } : {}), memberId } })

/** Read launch settings only from the host. Source settings cannot choose an executable or expose credentials. */
export function qqLaunch(env = process.env): QqLaunch | undefined {
  const { CONEST_QQ_BRIDGE_PYTHON: python, CONEST_QQ_BRIDGE_SCRIPT: script, CONEST_QQ_CREDENTIALS_FILE: credentialsFile } = env
  if (python && script && credentialsFile) return { python, script, credentialsFile }
}

interface Host {
  store: Store
  members: Pick<Members, 'isActiveMember' | 'isolated'>
  llm: Pick<Context['llm'], 'stream'>
  config(): QqConfig | undefined
  personalEnabled(): boolean
  receive(trigger: Trigger): ReceiveResult
  send(message: OutboundMessage): void
}

/** Validates account-scoped events and translates selected ones to the existing private member entry point. */
export class QqIngress {
  private transport?: QqTransport
  private readonly recent = new Map<string, ContextMessage[]>()
  readonly kind: SourceKind<QqConfig> = {
    kind: QQ, schema, health: [QQ], title: { zh: 'QQ', en: 'QQ' },
    description: { zh: '已绑定成员的 QQ 私聊和指定群接入。', en: 'Bound member DMs and selected QQ groups.' },
    fields: [
      { key: 'appId', type: 'text', label: { zh: 'QQ 应用 ID', en: 'QQ app ID' } },
      { key: 'botName', type: 'text', label: { zh: 'Bot 名称', en: 'Bot name' } },
      { key: 'groups', type: 'rows', label: { zh: '接收的 QQ 群', en: 'QQ groups' }, columns: [
        { key: 'conversationId', type: 'text', label: { zh: '群 OpenID', en: 'Group OpenID' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mention', label: { zh: '仅 @', en: '@ only' } }, { value: 'smart', label: { zh: '智能寻址', en: 'Intelligent addressing' } },
        ] },
      ] },
      { key: 'bindings', type: 'rows', label: { zh: '已核验的成员绑定', en: 'Verified member bindings' }, columns: [
        { key: 'senderId', type: 'text', label: { zh: '发送者 OpenID', en: 'Sender OpenID' } },
        { key: 'scope', type: 'select', label: { zh: '会话类型', en: 'Conversation type' }, options: [
          { value: 'dm', label: { zh: '私聊', en: 'Direct message' } }, { value: 'group', label: { zh: '群聊', en: 'Group' } },
        ] },
        { key: 'conversationId', type: 'text', label: { zh: '会话 OpenID', en: 'Conversation OpenID' } },
        { key: 'memberId', type: 'text', label: { zh: '个人空间成员 ID', en: 'Personal space member ID' } },
      ] },
      { key: 'modelProvider', type: 'text', advanced: true, label: { zh: '寻址模型供应商', en: 'Addressing model provider' } },
      { key: 'model', type: 'text', advanced: true, label: { zh: '寻址模型', en: 'Addressing model' } },
    ],
    // Inbound QQ events pass through this host's private member entry. Only the independently checked reply channel is exposed.
    scope: () => ({ listened: false, reason: 'qq_private_intake_required' }),
    channel: { allowed: (address, config) => {
      const origin = originSchema.safeParse(address).data
      return !!origin && !!address.memberId && this.memberFor(config, origin) === address.memberId
    }, send: (_host, message) => this.deliver(message),
    link: address => ({ url: '', label: address.scope === 'dm' ? { zh: 'QQ 私聊', en: 'QQ direct message' } : { zh: 'QQ群', en: 'QQ group' } }) },
  }

  constructor(private readonly host: Host) {}

  async run(connect: QqTransportFactory, signal: AbortSignal, report: (health: Health) => void): Promise<void> {
    while (!signal.aborted) {
      const config = this.host.config()
      if (config?.appId && this.host.personalEnabled()) {
        const current = new AbortController(), session = AbortSignal.any([signal, current.signal])
        const check = setInterval(() => {
          if (this.host.config()?.appId !== config.appId || !this.host.personalEnabled()) current.abort()
        }, 500)
        try {
          const transport = this.transport = connect(config.appId)
          report({ state: 'starting', detail: 'Connecting to QQ via Octop Gateway' })
          await transport.run(session, async event => { await this.receive(event, session) },
            () => report({ state: 'ready', detail: 'QQ Gateway connected' }))
        } catch {
          if (!session.aborted) report({ state: 'error', detail: 'QQ transport stopped; check the local Octop process and bot credentials' })
        } finally { clearInterval(check); this.transport = undefined; this.recent.clear() }
      } else report({ state: 'paused', detail: 'QQ needs an enabled app and active personal spaces' })
      await delay(1000, undefined, { signal }).catch(() => {})
    }
  }

  private memberFor(config: QqConfig | undefined, origin: Origin): string | undefined {
    if (!config || config.appId !== origin.accountId || !this.host.personalEnabled() || !this.host.members.isolated()) return
    const member = config.bindings.find(row => row.scope === origin.scope && row.conversationId === origin.conversationId && row.senderId === origin.senderId)?.memberId
    if (!member || !this.host.members.isActiveMember(member) || !allowedSender(this.host.store.settings(), { source: 'personal', id: member })) return
    const pin = this.host.store.get(pinKey(origin))
    if (!pin || pin === member) return member
  }

  async receive(event: OctopMessage, signal: AbortSignal): Promise<ReceiveResult> {
    const { store } = this.host, config = this.host.config()
    const { accountId, scope, conversationId, senderId, messageId, at, messageIndex } = event
    const origin = { accountId, scope, conversationId, senderId, messageId, at, ...(messageIndex ? { messageIndex } : {}) }
    const text = event.text.trim(), reference = messageKey(origin)
    if (signal.aborted || !config || !originSchema.safeParse(origin).success || event.senderKind !== 'user' || !text || text.length > 8000
      || !(Math.abs(Date.now() - Date.parse(at)) <= RECENT_MS) || scope === 'dm' && (event.eventType !== 'C2C_MESSAGE_CREATE' || conversationId !== senderId)
      || scope === 'group' && event.eventType === 'C2C_MESSAGE_CREATE') return 'filtered'
    const member = this.memberFor(config, origin)
    if (!member) return 'filtered'
    if (store.get(KV.qq.inbound(reference))) return 'duplicate'
    const request = personalTrigger(member, reference, text)
    const channel = qqChannel(origin, member)
    const trigger: Trigger = { ...request, at, channel: scope === 'dm' ? channel : request.channel,
      meta: { ...request.meta, qq: { ...origin, eventType: event.eventType, mentioned: event.mentioned,
        mentions: event.mentions, ...(event.referenceId ? { referenceId: event.referenceId } : {}) } } }

    if (scope === 'group') {
      const group = config.groups.find(group => group.conversationId === conversationId)
      if (!group) return 'filtered'
      const referenced = event.referenceId && store.get(replyReferences(origin))
        ?.find(ref => ref.index === event.referenceId && ref.expiresAt > Date.now())
      const groupAddress = await this.addressGroup(event, trigger, config, group.listen, member, !!referenced || !!event.replyToBot, signal)
      if (!groupAddress) return 'filtered'
      trigger.meta.groupAddress = groupAddress
      if (referenced && store.get(KV.members.trigger(referenced.triggerId)) === member) trigger.meta.replyToTriggerId = referenced.triggerId
    }

    return store.atomic(() => {
      if (signal.aborted || JSON.stringify(this.host.config()) !== JSON.stringify(config) || this.memberFor(config, origin) !== member) return 'filtered'
      if (store.get(KV.qq.inbound(reference))) return 'duplicate'
      store.set(pinKey(origin), member)
      store.set(KV.members.trigger(trigger.id), member)
      const result = this.host.receive(trigger)
      if (result === 'stored') {
        store.set(KV.qq.inbound(reference), trigger.id)
        if (scope === 'group') this.host.send({ id: groupReceiptId(origin), channel, text: PUBLIC_RECEIPT, kind: 'acknowledgement' })
      }
      return result
    })
  }

  private async addressGroup(event: OctopMessage, trigger: Trigger, config: QqConfig, listen: 'mention' | 'smart', member: string,
    replyToBot: boolean, signal: AbortSignal) {
    const { accountId, conversationId, senderId, messageId, at } = event
    const name = key(accountId, conversationId, senderId, member)
    const preceding = (this.recent.get(name) ?? []).filter(item => Date.parse(at) - Date.parse(item.at) <= RECENT_MS)
    const mentioned = event.mentioned || event.eventType === 'GROUP_AT_MESSAGE_CREATE' || event.mentions.some(item => item.isSelf)
    // QQ can deliver its full and @ events separately. The later authoritative address can still be useful.
    if (!mentioned && !replyToBot && preceding.some(item => item.id === messageId)) return
    const bot = { id: accountId, addresses: [accountId], names: [config.botName], role: '个人工单和任务助手' }
    const model = config.model ? { provider: config.modelProvider, model: config.model } : this.host.store.settings().eval.model
    const address = await groupAddress({ senderId: member, text: trigger.text, hasParent: !!event.referenceId,
      mentions: mentioned ? [accountId] : event.mentions.map(item => item.id) }, {
      bots: [bot], localBotId: accountId, autonomousBotId: accountId, history: listen !== 'smart' || event.eventType !== 'GROUP_MESSAGE_CREATE',
      parent: async () => replyToBot ? { senderIds: [accountId], bot: true, mentions: [] } : undefined,
      waiting: () => false,
      classify: async () => model ? classifyGroupAddress(this.host.llm, model, trigger, [bot],
        preceding.filter(item => item.at <= at), AbortSignal.any([signal, AbortSignal.timeout(6000)])) : undefined,
    }).catch(() => undefined)
    if (!signal.aborted && listen === 'smart') {
      this.recent.delete(name)
      this.recent.set(name, [...preceding.filter(item => item.id !== messageId), { id: messageId, from: member, at, text: trigger.text.slice(0, 500) }].slice(-8))
      if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!)
    }
    return address
  }

  private async deliver(message: OutboundMessage): Promise<'sent' | 'gone'> {
    const { store } = this.host, { address } = message.channel, origin = originSchema.safeParse(address).data
    if (!origin || !address.memberId || this.memberFor(this.host.config(), origin) !== address.memberId
      || Date.now() - Date.parse(origin.at) >= REPLY_WINDOW_MS || (origin.scope === 'group' &&
        (message.id !== groupReceiptId(origin) || message.kind !== 'acknowledgement' || message.text !== PUBLIC_RECEIPT))) return 'gone'
    const triggerId = store.get(KV.qq.inbound(messageKey(origin)))
    if (!triggerId || store.get(KV.members.trigger(triggerId)) !== address.memberId) return 'gone'
    const original = originSchema.safeParse(store.triggers.get(triggerId)?.meta.qq).data
    if (!original || JSON.stringify(original) !== JSON.stringify(origin)) return 'gone'
    const transport = this.transport
    if (!transport) throw new Later('QQ connection is unavailable')
    const delivery = KV.qq.delivery(message.id), previous = store.get(delivery)
    if (previous?.state === 'sent') return 'sent'
    if (previous?.state === 'sending') throw new Error('QQ delivery is uncertain; reconcile the receipt before retrying')
    const sequenceKey = KV.qq.sequence(messageKey(origin)), sequence = previous?.sequence ?? (store.get(sequenceKey) ?? 0) + 1
    if (sequence > (origin.scope === 'dm' ? 4 : 5)) return 'gone'
    store.atomic(() => {
      if (!previous) store.set(sequenceKey, sequence)
      store.set(delivery, { sequence, state: 'sending' })
    })
    const result = await transport.send({ id: message.id, accountId: origin.accountId, scope: origin.scope,
      conversationId: origin.conversationId, messageId: origin.messageId, text: message.text, sequence,
      ...(origin.scope === 'group' && origin.messageIndex ? { messageIndex: origin.messageIndex } : {}) })
    if (result.status === 'uncertain') throw new Error('QQ delivery is uncertain; reconcile the receipt before retrying')
    store.atomic(() => {
      store.set(delivery, { sequence, state: result.status === 'sent' ? 'sent' : 'retry' })
      if (result.status === 'sent' && result.replyIndex && origin.scope === 'group') {
        const refs = replyReferences(origin), at = Date.now()
        const remaining = (store.get(refs) ?? []).filter(ref => ref.expiresAt > at && ref.index !== result.replyIndex)
        store.set(refs, [...remaining, { index: result.replyIndex, expiresAt: at + REPLY_WINDOW_MS, triggerId }].slice(-512))
      }
    })
    if (result.status === 'retry') throw new Later('QQ temporarily refused delivery')
    if (result.status === 'sent' && origin.scope === 'group') {
      const name = key(origin.accountId, origin.conversationId, origin.senderId, address.memberId)
      const history = this.recent.get(name)
      if (history) this.recent.set(name, [...history, { id: message.id, from: origin.accountId,
        at: new Date().toISOString(), text: PUBLIC_RECEIPT, bot: true as const }].slice(-8))
    }
    return result.status
  }
}
