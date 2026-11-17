/** Pinned Weixin accounts feed the shared Engine/outbox; member authority remains in the host. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { triggerFromInbound } from '../ingress/messages.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext, type Health } from './host.ts'
import type { SourceKind } from './kind.ts'
import { readWeixinAccount } from './weixin-account.ts'
import { WeixinClient, WeixinError, type WeixinAccount, type WeixinMessage } from './weixin-api.ts'
import { WeixinConfigSchema, weixinAccounts, weixinActorId, type WeixinBinding, type WeixinConfig } from './weixin-config.ts'
export { WeixinConfigSchema, weixinAccounts, weixinActorId, type WeixinConfig } from './weixin-config.ts'
export { WeixinClient } from './weixin-api.ts'

export const WEIXIN = 'weixin'
const bound = (config: WeixinConfig | undefined, account: unknown, owner: unknown) => weixinAccounts(config)
  .find(binding => binding.accountId === account && binding.ownerId === owner)
const sameConfig = (ctx: SourceContext, config: WeixinConfig): boolean => {
  const current = ctx.config<WeixinConfig>(WEIXIN)
  return !!current && JSON.stringify(WeixinConfigSchema.parse(current)) === JSON.stringify(WeixinConfigSchema.parse(config))
}

/** Only the configured owner may originate text work; neither a bot echo nor a group becomes a task. */
export function weixinTrigger(account: Pick<WeixinAccount, 'id' | 'ownerId'>, message: WeixinMessage, privateRouting = false): Trigger | undefined {
  if (message.from_user_id !== account.ownerId || message.group_id || message.message_type !== 1 || message.message_state === 1
    || !message.context_token || !message.item_list.length || message.item_list.some(part => part.type !== 1)) return
  const text = message.item_list.map(part => part.text_item?.text ?? '').join('\n').trim()
  if (!text || text.length > 8000) return
  const trigger = triggerFromInbound({ channelKind: WEIXIN, channelId: account.id, senderId: account.ownerId, senderKind: 'user',
    conversation: { scope: 'dm', externalConversationId: account.ownerId, memberExternalId: account.ownerId },
    messageId: message.message_id, at: new Date().toISOString(), parts: [{ type: 'text', text }] })
  const thread = privateRouting ? { source: WEIXIN, id: key(account.id, account.ownerId, message.message_id) } : trigger.threads[0]!
  return { ...trigger, threads: [thread], channel: { ...trigger.channel!, thread: `${WEIXIN}:${thread.id}` },
    actor: { source: WEIXIN, id: weixinActorId(account.id, account.ownerId) } }
}

/** Build a Source with a lazily resolved, host-only context; permits independent instances in tests/profiles. */
export function createWeixinKind(context: () => SourceContext, client = new WeixinClient()): SourceKind<WeixinConfig> {
  return { kind: WEIXIN, title: { zh: '微信', en: 'Weixin' },
    description: { zh: '明确绑定的账号 owner 文本私聊；多成员使用独立绑定和私有路由，共享工单队列。', en: 'Pinned owner DMs with member bindings, private routers and a shared task queue.' },
    schema: WeixinConfigSchema,
    fields: [
      { key: 'credentialsFile', type: 'text', label: { zh: '宿主凭证文件绝对路径', en: 'Private host credential file' } },
      { key: 'accountId', type: 'text', label: { zh: '机器人账号 id', en: 'Bot account id' } },
      { key: 'ownerId', type: 'text', label: { zh: '已绑定用户 id', en: 'Bound owner id' } },
      { key: 'members', type: 'rows', label: { zh: '成员（多用户模式）', en: 'Members (private mode)' }, columns: [
        { key: 'id', type: 'text', label: { zh: '成员 id', en: 'Member id' } },
        { key: 'displayName', type: 'text', label: { zh: '名称', en: 'Name' } },
        { key: 'status', type: 'select', label: { zh: '状态', en: 'Status' }, options: [{ value: 'active', label: { zh: '启用', en: 'Active' } }, { value: 'disabled', label: { zh: '停用', en: 'Disabled' } }] },
      ] },
      { key: 'accounts', type: 'rows', label: { zh: '成员账号绑定', en: 'Member account bindings' }, columns: [
        { key: 'memberId', type: 'text', label: { zh: '成员 id', en: 'Member id' } },
        { key: 'credentialsFile', type: 'text', label: { zh: '凭证文件绝对路径', en: 'Credential file' } },
        { key: 'accountId', type: 'text', label: { zh: '机器人 id', en: 'Bot id' } },
        { key: 'ownerId', type: 'text', label: { zh: '绑定 owner', en: 'Bound owner' } },
      ] },
    ], health: [WEIXIN],
    scope: ({ meta }, config) => meta.scope === 'dm' && bound(config, meta.channelId, meta.senderId)
      ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'weixin_private_owner_required' },
    channel: {
      allowed: (address, config) => address.scope === 'dm' && !!bound(config, address.channelId, address.conversationId),
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
  const counts = await Promise.all(weixinAccounts(config).map(binding => pollAccount(ctx, client, config, binding, signal)))
  return counts.reduce((sum, count) => sum + count, 0)
}
async function pollAccount(ctx: SourceContext, client: WeixinClient, config: WeixinConfig, binding: WeixinBinding, signal?: AbortSignal): Promise<number> {
  const account = readWeixinAccount(binding.credentialsFile, binding)
  const cursorKey = KV.weixin.cursor(account.id)
  const batch = await client.updates(account, ctx.state.get(cursorKey) ?? '', signal)
  signal?.throwIfAborted()
  if (!sameConfig(ctx, config)) return 0
  let count = 0
  ctx.atomic(() => {
    for (const message of batch.msgs) {
      const trigger = weixinTrigger(account, message, config.accounts !== undefined)
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
  const binding = bound(config, message.channel.address.channelId, message.channel.address.conversationId)
  if (!binding || message.channel.source !== WEIXIN || message.channel.address.scope !== 'dm') return 'gone'
  const account = readWeixinAccount(binding.credentialsFile, binding)
  const token = ctx.state.get(KV.weixin.context(account.id, account.ownerId))
  if (!token) throw new Error('Weixin reply context is unavailable; wait for a new authorized DM')
  const chars = Array.from(message.text)
  for (let offset = 0; offset < chars.length; offset += 1800) {
    if (!bound(ctx.config<WeixinConfig>(WEIXIN), account.id, account.ownerId)) return 'gone'
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

/** Poll accounts independently with one credential-file lease each; one failed account does not stop other members. */
export async function runWeixin(ctx: SourceContext, client: WeixinClient, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(WEIXIN, { state: 'paused', detail: 'Waiting for deployment setup' }); return }
  while (!signal.aborted) {
    let config: WeixinConfig | undefined
    try { config = ctx.config<WeixinConfig>(WEIXIN) } catch { return }
    const bindings = weixinAccounts(config)
    if (!config || !bindings.length) {
      ctx.report(WEIXIN, { state: 'paused', detail: 'Weixin is disabled or its bound account is not configured' })
      await delay(1000,undefined,{signal}).catch(() => {}); continue
    }
    const states = new Map<string, Health>(), changed = new AbortController()
    const watch = setInterval(() => { try { if (!sameConfig(ctx, config)) changed.abort() } catch { changed.abort() } }, 250)
    try { await Promise.all(bindings.map(binding => runAccount(ctx, client, config, binding, AbortSignal.any([signal, changed.signal]), health => {
      states.set(binding.accountId, health)
      const failed = [...states.values()].some(item => item.state === 'error')
      ctx.report(WEIXIN, { state: failed ? 'error' : states.size === bindings.length ? 'ready' : 'starting',
        detail: failed ? 'A bound account failed polling; other accounts continue independently' : `Receiving ${states.size}/${bindings.length} bound accounts` })
    }))) } finally { clearInterval(watch) }
  }
}
async function runAccount(ctx: SourceContext, client: WeixinClient, config: WeixinConfig, binding: WeixinBinding, signal: AbortSignal, report: (value: Health) => void): Promise<void> {
  while (!signal.aborted && sameConfig(ctx, config)) {
    let release: (() => Promise<void>) | undefined
    const lease = new AbortController(), lifetime = AbortSignal.any([signal, lease.signal])
    try {
      readWeixinAccount(binding.credentialsFile, binding)
      release = await lockfile.lock(binding.credentialsFile, { stale: 30_000, retries: 0, onCompromised: () => lease.abort() })
      while (!lifetime.aborted && sameConfig(ctx, config)) {
        await pollAccount(ctx, client, config, binding, lifetime)
        report({ state: 'ready', detail: 'Receiving bound-owner private messages' })
        await delay(250,undefined,{signal:lifetime})
      }
    } catch {
      if (!signal.aborted) report({ state: 'error', detail: 'Weixin polling failed; check private credentials, process lease and network' })
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
