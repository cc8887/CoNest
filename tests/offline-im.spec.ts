/** Offline acceptance at the IM transport boundary. Source, Runtime and outbox are real. */
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import type { FeishuReply } from '../src/sources/feishu-channel.ts'
import type { FeishuEvents } from '../src/sources/feishu-live.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OctopMessage, QqTransport } from '../src/sources/octop-transport.ts'
import type { WeixinAccount, WeixinMessage } from '../src/sources/weixin-api.ts'
import { createWeixinKind, pollWeixin, weixinActorId, type WeixinTransport } from '../src/sources/weixin.ts'
import { deferred } from './fixtures/async.ts'
import { CHAT, startRuntime, type Host } from './fixtures/host.ts'

it('drives Feishu, Weixin and QQ through their interchangeable transports and one private Runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conest-offline-im-'))
  let host: Host | undefined, feishuRunning: Promise<unknown> | undefined
  const alice = 'offline-im-alice', bob = 'offline-im-bob', appId = '12345', qqSender = 'qq-bob', feishuSender = 'ou_aliceIm'
  const qqRoom = 'qq-room', qqGroupSender = 'qq-group-bob'
  const classify = vi.fn(async function* ({ messages }: GenerateOptions): AsyncGenerator<StreamChunk> {
    const input = JSON.stringify(messages)
    const respond = input.includes('再加一个示例') && input.includes('先整理 QQ 清单')
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ respond, confidence: 0.96, reason: 'scripted', targetBotId: respond ? appId : null }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const account: WeixinAccount = { id: 'wx-test', ownerId: 'wx-alice', token: 'fixture-only', baseURL: 'https://ilinkai.weixin.qq.com/' }
  const credentialsFile = join(dir, 'weixin.json')
  const feishuReplies = vi.fn<FeishuReply>().mockResolvedValue('sent')
  const qqSend = vi.fn<QqTransport['send']>().mockResolvedValue({ status: 'sent' })
  const wxSend = vi.fn<WeixinTransport['send']>().mockResolvedValue(undefined)
  const qqReceive = deferred<Parameters<QqTransport['run']>[1]>()
  const feishuReceive = deferred<Parameters<FeishuEvents>[1]>()
  const events: FeishuEvents = async (signal, receive, report) => {
    report({ state: 'ready', detail: 'Offline Feishu' })
    feishuReceive.resolve(receive)
    if (!signal.aborted) await once(signal, 'abort')
  }
  const qq: QqTransport = { send: qqSend, async run(signal, receive, ready) {
    ready?.()
    qqReceive.resolve(receive)
    if (!signal.aborted) await once(signal, 'abort')
  } }
  let wxBatch: WeixinMessage[] = [], cursor = 'first'
  const weixin: WeixinTransport = { send: wxSend, updates: async () => ({ msgs: wxBatch, get_updates_buf: cursor }) }
  try {
    writeFileSync(credentialsFile, JSON.stringify(account), { mode: 0o600 })
    const h = host = await startRuntime(store => {
      const settings = store.settings()
      store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: false, config: {} },
        personal: { enabled: true, config: {} },
        weixin: { enabled: true, config: {
          members: [alice, bob].map(id => ({ id, displayName: '同名成员', status: 'active' })),
          accounts: [{ memberId: alice, accountId: account.id, ownerId: account.ownerId, credentialsFile }],
        } },
        qq: { enabled: true, config: { appId, modelProvider: 'offline', model: 'scripted', groups: [{ conversationId: qqRoom, listen: 'smart' }],
          bindings: [{ scope: 'dm', conversationId: qqSender, senderId: qqSender, memberId: bob },
            { scope: 'group', conversationId: qqRoom, senderId: qqGroupSender, memberId: bob }] } },
      }, policy: { ...settings.policy, sources: { ...settings.policy.sources,
        personal: { allowed: [alice, bob].map(id => ({ id })) }, weixin: { allowed: [{ id: weixinActorId(account.id, account.ownerId) }] },
      } } })
    }, { portal: true, llmStream: classify, feishuReply: feishuReplies, qqTransport: id => { expect(id).toBe(appId); return qq } })
    const { runtime } = h, { store } = runtime
    const settings = store.settings().sources.feishu!
    await runtime.settings.save('source:feishu', { ...settings, config: { ...settings.config, identityOnly: true, groupSchedules: true } },
      store.blockRevision('source:feishu'), 'panel')
    const weixinKind = createWeixinKind((): SourceContext => runtime.context(weixinKind), weixin)
    runtime.sources.register(weixinKind)
    const weixinSource = runtime.context(weixinKind)
    const poll = () => pollWeixin(weixinSource, weixin, weixinSource.config(weixinKind.kind)!)
    feishuRunning = runFeishu(runtime.context(feishuKind), runtime.lifetime, events)
    await vi.waitFor(() => {
      expect(runtime.health.feishu?.state).toBe('ready')
      expect(runtime.health.qq?.state).toBe('ready')
    })
    const sendFeishu = await feishuReceive.promise
    const sendQQ = await qqReceive.promise

    const base = `${runtime.portalServer!.origin}/t/${alice}/api`
    const request = (path: string, cookie = '', body?: object) => fetch(`${base}/${path}`, {
      method: 'POST', headers: { 'x-conest-request': '1', 'content-type': 'application/json', cookie }, body: JSON.stringify(body ?? {}),
    })
    const access = await request('exchange', '', { invite: runtime.portal.invite(alice) })
    expect(access.status).toBe(200)
    const cookie = access.headers.get('set-cookie')!.split(';')[0]!
    const binding = await request('feishu-binding', cookie)
    expect(binding.status).toBe(201)
    const { command } = await binding.json() as { command: string }
    const feishuMessage = { message_id: 'om_schedule', chat_id: CHAT, chat_type: 'group', sender_type: 'user', sender_id: feishuSender,
      content: '明天提醒我整理清单', mentions: [{ id: 'ou_bot' }], root_id: 'om_topic' }
    await sendFeishu({ ...feishuMessage, message_id: 'om_bind', chat_id: 'oc_direct', chat_type: 'p2p', mentions: [], content: command,
      create_time: String(Date.now()) })
    expect((await request('feishu-binding/confirm', cookie)).status).toBe(200)
    const scheduleEvent = { ...feishuMessage, create_time: String(Date.now()) }

    const wxMessage: WeixinMessage = { message_id: 'wx-input', from_user_id: account.ownerId, message_type: 1, message_state: 2,
      context_token: 'wx-context', item_list: [{ type: 1, text_item: { text: 'Alice 微信提问' } }] }
    const qqMessage: OctopMessage = { type: 'message', accountId: appId, scope: 'dm', senderId: qqSender, senderKind: 'user',
      conversationId: qqSender, messageId: 'qq-input', eventType: 'C2C_MESSAGE_CREATE', at: new Date().toISOString(),
      text: 'Bob QQ 提问', mentioned: false, mentions: [] }
    wxBatch = [wxMessage, { ...wxMessage, message_id: 'wx-outsider', from_user_id: 'unbound' }]
    expect(await poll()).toBe(1)
    await sendFeishu(scheduleEvent)
    await sendQQ(qqMessage)
    await runtime.idle()

    const router = (member: string) => store.get(KV.members.session(member))!
    const candidate = (member: string, text: string) => {
      const card = h.relays(router(member)).find(row => row.kind === 'candidate' && String(row.text).includes(text))
      expect(card).toBeDefined()
      return String(card!.trigger_id)
    }
    const wxId = candidate(alice, wxMessage.item_list[0]!.text_item!.text)
    const feishuId = candidate(alice, feishuMessage.content)
    const qqId = candidate(bob, qqMessage.text)
    expect(h.relays(router(bob)).find(row => row.trigger_id === qqId)).toMatchObject({ qq_scope: 'dm' })
    expect(h.relays(router(alice)).filter(row => row.kind === 'candidate')).toHaveLength(2)
    expect(h.relays(router(bob)).filter(row => row.kind === 'candidate')).toHaveLength(1)
    await expect(h.runTool(router(bob), 'orchestrator_read', { resource: `trigger/${wxId}` })).rejects.toThrow(/inaccessible/)
    await h.runTool(router(alice), 'orchestrator_reply', { purpose: 'answer', trigger_id: wxId, text: '微信回复' })
    await h.runTool(router(bob), 'orchestrator_reply', { purpose: 'answer', trigger_id: qqId, text: 'QQ 回复' })
    await h.runTool(router(alice), 'orchestrator_schedule_create', { trigger_id: feishuId, title: '飞书私有任务',
      instructions: '整理清单', run_at: new Date(Date.now() + 86_400_000).toISOString(), repeat: 'once' })
    await runtime.idle()

    expect(wxSend).toHaveBeenCalledExactlyOnceWith(account, account.ownerId, 'wx-context', expect.any(String), '微信回复')
    expect(qqSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: appId, conversationId: qqSender,
      messageId: qqMessage.messageId, sequence: 1, text: 'QQ 回复' }))
    expect(feishuReplies).toHaveBeenCalledExactlyOnceWith({ messageId: feishuMessage.message_id, id: expect.any(String),
      text: '已创建定时任务。到期后的工单和结果请在发起人的 CoNest 个人空间查看。' })
    expect(runtime.portal.personal(alice).schedules).toHaveLength(1)
    expect(runtime.portal.personal(bob).schedules).toHaveLength(0)

    const group = { ...qqMessage, scope: 'group' as const, conversationId: qqRoom, senderId: qqGroupSender,
      messageId: 'qq-group-first', messageIndex: 'qq-index-first', text: '先整理 QQ 清单', eventType: 'GROUP_MESSAGE_CREATE' as const }
    qqSend.mockResolvedValueOnce({ status: 'sent', replyIndex: 'qq-bot-reference' })
    await sendQQ(group)
    await sendQQ({ ...group, eventType: 'GROUP_AT_MESSAGE_CREATE' })
    await runtime.idle()
    expect(store.triggers.get(candidate(bob, group.text))?.meta.groupAddress).toEqual({ botId: appId, via: 'mention' })
    const follow = { ...group, messageId: 'qq-group-followup', messageIndex: 'qq-index-followup', text: '再加一个示例' }
    const quote = { ...group, messageId: 'qq-group-quote', messageIndex: 'qq-index-quote', referenceId: 'qq-bot-reference', text: '另整理引用中的清单' }
    await sendQQ(follow)
    await sendQQ(quote)
    await runtime.idle()
    expect(store.triggers.get(candidate(bob, follow.text))?.meta.groupAddress).toMatchObject({ via: 'semantic' })
    expect(store.triggers.get(candidate(bob, quote.text))?.meta.groupAddress).toMatchObject({ via: 'reply' })
    expect(h.relays(router(bob)).find(card => card.trigger_id === candidate(bob, quote.text))).toMatchObject({
      qq_scope: 'group', replies_to: { trigger_id: candidate(bob, group.text), preview: group.text },
    })
    expect(classify).toHaveBeenCalledTimes(2)
    expect(qqSend.mock.calls.slice(1).map(([request]) => [request.messageId, request.messageIndex, request.text])).toEqual(
      [group, follow, quote].map(event => [event.messageId, event.messageIndex, '已收到。后续内容请在你自己的 CoNest 个人空间查看。']))
    expect(h.relays(router(alice)).some(row => row.kind === 'candidate' && String(row.text).includes('QQ 清单'))).toBe(false)

    const count = store.read.recentTriggers(0, 100).length
    cursor = 'replay'
    expect(await poll()).toBe(0)
    await sendFeishu(scheduleEvent)
    await sendQQ(qqMessage)
    runtime.portal.status(bob, 'disabled')
    await sendQQ({ ...qqMessage, messageId: 'qq-revoked', text: '停用后不得进入 Agent' })
    await runtime.idle()
    expect(store.read.recentTriggers(0, 100)).toHaveLength(count)
    for (const send of [wxSend, feishuReplies]) expect(send).toHaveBeenCalledTimes(1)
    expect(qqSend).toHaveBeenCalledTimes(4)
  } finally {
    try { await host?.stop(); await feishuRunning } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}, 15_000)
