/** Single-owner Weixin Source: real transport into the existing Engine and outbox, with no second task store. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isAbsolute } from 'node:path'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { triggerFromInbound } from '../ingress/messages.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { readWeixinAccount } from './weixin-account.ts'
import { WeixinClient, WeixinError, type WeixinAccount, type WeixinMessage } from './weixin-api.ts'

export const WEIXIN = 'weixin'
export const WeixinConfigSchema = z.object({
  credentialsFile: z.string().refine(value => !value || isAbsolute(value), 'Absolute path required').default(''),
  accountId: z.string().max(256).default(''), ownerId: z.string().max(256).default(''),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>
/** Transport account and case-sensitive peer id together form the Source actor identity. */
export const weixinActorId = (accountId: string, ownerId: string): string => JSON.stringify([accountId, ownerId])
const configured = (config: WeixinConfig | undefined): config is WeixinConfig => !!config?.credentialsFile && !!config.accountId && !!config.ownerId

/** Only the configured owner may originate text work; neither a bot echo nor a group becomes a task. */
export function weixinTrigger(account: Pick<WeixinAccount, 'id' | 'ownerId'>, message: WeixinMessage): Trigger | undefined {
  if (message.from_user_id !== account.ownerId || message.group_id || message.message_type !== 1 || message.message_state === 1
    || !message.context_token || !message.item_list.length || message.item_list.some(part => part.type !== 1)) return
  const text = message.item_list.map(part => part.text_item?.text ?? '').join('\n').trim()
  if (!text || text.length > 8000) return
  const trigger = triggerFromInbound({ channelKind: WEIXIN, channelId: account.id, senderId: account.ownerId, senderKind: 'user',
    conversation: { scope: 'dm', externalConversationId: account.ownerId, memberExternalId: account.ownerId },
    messageId: message.message_id, at: new Date().toISOString(), parts: [{ type: 'text', text }] })
  return { ...trigger, actor: { source: WEIXIN, id: weixinActorId(account.id, account.ownerId) } }
}

/** Build a Source with a lazily resolved, host-only context; permits independent instances in tests/profiles. */
export function createWeixinKind(context: () => SourceContext, client = new WeixinClient()): SourceKind<WeixinConfig> {
  return { kind: WEIXIN, title: { zh: '微信', en: 'Weixin' },
    description: { zh: '当前接入一个已绑定账号本人的文本私聊；多成员隔离尚在开发。', en: 'Text DMs from one explicitly bound owner; multi-member isolation is still in development.' },
    schema: WeixinConfigSchema,
    fields: [
      { key: 'credentialsFile', type: 'text', label: { zh: '宿主凭证文件绝对路径', en: 'Private host credential file' } },
      { key: 'accountId', type: 'text', label: { zh: '机器人账号 id', en: 'Bot account id' } },
      { key: 'ownerId', type: 'text', label: { zh: '已绑定用户 id', en: 'Bound owner id' } },
    ], health: [WEIXIN],
    scope: ({ meta }, config) => configured(config) && meta.scope === 'dm' && meta.channelId === config.accountId && meta.senderId === config.ownerId
      ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'weixin_private_owner_required' },
    channel: {
      allowed: (address, config) => configured(config) && address.scope === 'dm' && address.channelId === config.accountId && address.conversationId === config.ownerId,
      link: () => ({ url: '', label: { zh: '微信私聊', en: 'Weixin private chat' } }),
      send: (_host, message) => sendWeixin(context(), client, message),
    },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '可发起工单的绑定身份', en: 'Bound identities allowed to originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '绑定身份', en: 'Bound identity' } }] }],
      explicit: { zh: '已允许的绑定用户私聊机器人时发起明确请求。', en: 'A permitted bound owner may originate explicit requests in their DM.' },
      rows: () => [{ id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '仅绑定本人', en: 'Bound owner only' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
    },
  }
}

/** Persist messages and the cursor together; the application's receive path is synchronously transactional. */
export async function pollWeixin(ctx: SourceContext, client: WeixinClient, config: WeixinConfig, signal?: AbortSignal): Promise<number> {
  const account = readWeixinAccount(config.credentialsFile, config)
  const cursorKey = KV.weixin.cursor(account.id)
  const batch = await client.updates(account, ctx.state.get(cursorKey) ?? '', signal)
  signal?.throwIfAborted()
  if (JSON.stringify(ctx.config(WEIXIN)) !== JSON.stringify(config)) return 0
  let count = 0
  ctx.atomic(() => {
    for (const message of batch.msgs) {
      const trigger = weixinTrigger(account, message)
      if (!trigger) continue
      const result = ctx.receive(trigger)
      if (typeof result !== 'string') throw new Error('Weixin Source requires synchronous Runtime ingestion')
      if (result === 'stored' || !ctx.state.get(KV.weixin.context(account.id, account.ownerId)))
        ctx.state.set(KV.weixin.context(account.id, account.ownerId), message.context_token!)
      if (result === 'stored') count++
    }
    ctx.state.set(cursorKey, batch.get_updates_buf)
  })
  return count
}

/** Existing outbox retries cannot blindly repeat an externally uncertain send. Successful chunks remain durable. */
export async function sendWeixin(ctx: SourceContext, client: WeixinClient, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const config = ctx.config<WeixinConfig>(WEIXIN)
  if (!configured(config) || message.channel.source !== WEIXIN || message.channel.address.scope !== 'dm'
    || message.channel.address.channelId !== config.accountId || message.channel.address.conversationId !== config.ownerId) return 'gone'
  const account = readWeixinAccount(config.credentialsFile, config)
  const token = ctx.state.get(KV.weixin.context(account.id, account.ownerId))
  if (!token) throw new Error('Weixin reply context is unavailable; wait for a new authorized DM')
  const chars = Array.from(message.text)
  for (let offset = 0; offset < chars.length; offset += 1800) {
    const id = key(message.id, String(offset))
    const record = KV.weixin.delivery(id)
    const status = ctx.state.get(record)
    if (status === 'sent') continue
    if (status) throw new Error('Weixin delivery is uncertain; reconcile the phone receipt before retrying')
    ctx.state.set(record, 'sending')
    const clientId = 'conest-' + createHash('sha256').update(id).digest('hex').slice(0,32)
    try {
      await client.send(account, account.ownerId, token, clientId, chars.slice(offset,offset+1800).join(''))
      ctx.state.set(record, 'sent')
    } catch (error) {
      const rejected = error instanceof WeixinError && (Number(error.code) < 0 || [400,401,403,429].includes(Number(error.code)))
      ctx.state.set(record, rejected ? undefined : 'uncertain')
      throw new Error(rejected ? 'Weixin rejected delivery; check account authorization and reply context' : 'Weixin delivery is uncertain; check the phone before reconciliation')
    }
  }
  return 'sent'
}

/** Poll one configured account under an exclusive local credential-file lease; channel changes take effect between polls. */
export async function runWeixin(ctx: SourceContext, client: WeixinClient, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(WEIXIN, { state: 'paused', detail: 'Waiting for deployment setup' }); return }
  while (!signal.aborted) {
    const config = ctx.config<WeixinConfig>(WEIXIN)
    if (!configured(config)) {
      ctx.report(WEIXIN, { state: 'paused', detail: 'Weixin is disabled or its bound account is not configured' })
      await delay(1000,undefined,{signal}).catch(() => {}); continue
    }
    let release: (() => Promise<void>) | undefined
    const lease = new AbortController(), lifetime = AbortSignal.any([signal, lease.signal])
    try {
      readWeixinAccount(config.credentialsFile, config)
      release = await lockfile.lock(config.credentialsFile, { stale: 30_000, retries: 0, onCompromised: () => lease.abort() })
      while (!lifetime.aborted && JSON.stringify(ctx.config(WEIXIN)) === JSON.stringify(config)) {
        await pollWeixin(ctx, client, config, lifetime)
        ctx.report(WEIXIN, { state: 'ready', detail: 'Receiving bound-owner private messages' })
        await delay(250,undefined,{signal:lifetime})
      }
    } catch {
      if (!signal.aborted) ctx.report(WEIXIN, { state: 'error', detail: 'Weixin polling failed; check private credentials, process lease and network' })
    } finally { if (release) await release().catch(() => {}) }
    if (!signal.aborted) await delay(3000,undefined,{signal}).catch(() => {})
  }
}

export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let source: SourceContext
  const client = new WeixinClient(), kind = createWeixinKind(() => source, client)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'weixin: source kind')
  source = sourceContext(ctx.orchestrator, kind)
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runWeixin(source,client,controller.signal)
    return async () => { controller.abort(); await running }
  })
}
