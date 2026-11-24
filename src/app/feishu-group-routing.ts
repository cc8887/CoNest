/** Applies intelligent addressing at the Feishu intake boundary. */
import type { Context } from '@deepseek-ai/cordis'
import { key, latestAssignment, threadKey, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { FeishuBot } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { groupAddress, type GroupBot } from '../ingress/group-address.ts'
import type { RoleModel } from '../policy.ts'
import type { FeishuConfig } from '../sources/feishu.ts'
import { feishuAddressContext, feishuAddressReference } from '../sources/feishu-read.ts'
import { feishuRef, feishuTriggerId } from '../sources/feishu-trigger.ts'
import { classifyGroupAddress } from './group-address-model.ts'
import type { Store } from './store.ts'

type Chat = FeishuConfig['chats'][number]
const MAX_AGE = 2 * 60_000

function roster(bot: FeishuBot, config: FeishuConfig): GroupBot[] {
  if (!config.groupBots?.length) return [{ id: bot.appId, addresses: [bot.appId, bot.botId], names: [bot.name || 'CoNest'], role: '' }]
  return config.groupBots.map(entry => ({ id: entry.appId, addresses: [entry.appId, entry.openId],
    names: entry.names.split(/[,，]/).map(name => name.trim()).filter(Boolean), role: entry.role ?? '' }))
}

/** Coalesces repeated deliveries while a decision runs, then hands selected messages to existing intake. */
export class FeishuGroupRouting {
  private readonly pending = new Map<string, Promise<ReceiveResult>>()
  private readonly silent = new Map<string, number>()

  constructor(private readonly store: Store, private readonly commands: Commands, private readonly llm: Pick<Context['llm'], 'stream'>,
    private readonly lifetime: AbortSignal) {}

  receive(trigger: Trigger, live: boolean, config: FeishuConfig, chat: Chat, bot: FeishuBot, evalModel: RoleModel | null,
    authorized: () => boolean, accept: (trigger: Trigger) => ReceiveResult, storedId = trigger.id): ReceiveResult | Promise<ReceiveResult> {
    const ref = feishuRef(trigger)
    if (!trigger.human || trigger.actor.source !== 'feishu' || !trigger.actor.id || this.lifetime.aborted || !ref
      || !/^om_[A-Za-z0-9_-]+$/.test(ref.messageId) || feishuTriggerId(ref.messageId) !== trigger.id
      || trigger.channel?.source !== 'feishu' || trigger.channel.address.chatId !== ref.chatId
      || trigger.channel.address.messageId !== ref.messageId || !authorized()) return 'filtered'
    if (this.store.triggers.get(storedId)) return 'duplicate'
    if (!live && trigger.addressed !== 'mention') return 'filtered'
    if (live && (this.silent.get(trigger.id) ?? 0) > Date.now()) return 'filtered'
    const ongoing = this.pending.get(trigger.id)
    if (ongoing) return ongoing.then(result => result === 'stored' ? 'duplicate' : result)

    const bots = roster(bot, config)
    const autonomousBotId = chat.autonomousBotId || bot.appId
    if (!bots.some(entry => entry.id === bot.appId && entry.addresses.includes(bot.botId))
      || !bots.some(entry => entry.id === autonomousBotId)) return 'filtered'
    const mentions = Array.isArray(trigger.meta.mentionIds) ? trigger.meta.mentionIds as readonly string[] : []
    const fresh = Math.abs(Date.now() - Date.parse(trigger.at)) <= MAX_AGE
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(6000)])
    const commands = this.commands.withSignal(signal)
    const model = config.groupModel && config.groupModelProvider ? { provider: config.groupModelProvider, model: config.groupModel } : evalModel
    const hasTopic = bots.length > 1 && typeof trigger.meta.rootId === 'string' && trigger.meta.rootId !== ref.messageId
    const decision = groupAddress({ senderId: trigger.actor.id, text: trigger.text, mentions, hasParent: typeof trigger.meta.parentId === 'string' }, {
      bots, localBotId: bot.appId, autonomousBotId, history: !live || !fresh,
      parent: () => feishuAddressReference(commands, trigger, 'parent'),
      ...(hasTopic ? { root: () => feishuAddressReference(commands, trigger, 'root') } : {}), waiting: () => this.waiting(trigger),
      classify: async () => model ? classifyGroupAddress(this.llm, model, trigger, bots, await feishuAddressContext(commands, trigger), signal) : undefined,
    }).catch(() => undefined).then(address => {
      if (this.lifetime.aborted || !authorized()) return 'filtered' as const
      if (address?.botId === bot.appId && !signal.aborted) {
        return accept({ ...trigger, addressed: address.via === 'mention' ? 'mention' : 'group', meta: { ...trigger.meta, groupAddress: address } })
      }
      if (live) {
        this.silent.delete(trigger.id)
        this.silent.set(trigger.id, Date.now() + MAX_AGE)
        if (this.silent.size > 2048) this.silent.delete(this.silent.keys().next().value!)
      }
      return 'filtered' as const
    }).finally(() => this.pending.delete(trigger.id))
    this.pending.set(trigger.id, decision)
    return decision
  }

  /** An unquoted answer must be in the exact topic, from the person who was asked, after delivery of the question. */
  private waiting(trigger: Trigger): boolean {
    const thread = this.store.threads.get(threadKey(trigger.threads[0]!))
    return thread?.subscriptions.some(id => {
      const ticket = this.store.tickets.get(id)
      if (!ticket || ticket.ended || !ticket.attention || thread.context?.includes(id)) return false
      const report = latestAssignment(ticket)?.report
      if (!report || report.at >= trigger.at) return false
      const asked = this.store.triggers.get(ticket.attention.triggerId ?? ticket.origin.triggerId)
      if (asked?.actor.source !== trigger.actor.source || asked.actor.id !== trigger.actor.id || asked.meta.chatId !== trigger.meta.chatId
        || this.store.replyStatus(key('attention-reply', ticket.attention.id)) !== 'sent') return false
      return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && input.at > report.at && input.at <= trigger.at
        && this.store.triggers.get(input.triggerId)?.actor.id === trigger.actor.id)
    }) ?? false
  }
}
