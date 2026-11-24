import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { groupAddress, type GroupBot } from '../src/ingress/group-address.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { CHAT, MEMBER, startRuntime, type Host } from './fixtures/host.ts'

const bots: GroupBot[] = [
  { id: 'cli_bot', addresses: ['cli_bot', 'ou_bot'], names: ['CoNest', '小窝'], role: '整理任务' },
  { id: 'cli_peer', addresses: ['cli_peer', 'ou_peer'], names: ['Mika'], role: '营销' },
]
const yes = { respond: true, confidence: 0.97, reason: '延续机器人的回复', targetBotId: 'cli_bot' }

it('picks one bot across concurrent connections and follows structured address priority', async () => {
  const parent = vi.fn(async () => ({ senderIds: ['cli_peer'], bot: true, mentions: [] }))
  const waiting = vi.fn(() => true)
  const classify = vi.fn(async () => yes)
  const recipients = async (text: string, mentions: string[] = [], hasParent = false, root?: typeof parent) => {
    const results = await Promise.all(bots.map(local => groupAddress({ senderId: MEMBER, text, mentions, hasParent }, {
      bots, localBotId: local.id, autonomousBotId: 'cli_bot', parent, root, waiting, classify, history: false,
    }).then(result => result?.botId === local.id ? result : undefined)))
    return results.filter(result => result !== undefined)
  }
  expect(await recipients('Mika, 帮我看看', ['ou_bot', 'ou_peer'], true)).toEqual([{ botId: 'cli_bot', via: 'mention' }])
  expect(parent).not.toHaveBeenCalled()
  expect(await recipients('小窝，帮我看看', [], true)).toEqual([{ botId: 'cli_peer', via: 'reply' }])
  expect(await recipients('找这位同事', ['ou_human'], true)).toEqual([{ botId: 'cli_peer', via: 'reply' }])
  expect(waiting).not.toHaveBeenCalled()
  expect(await recipients('小窝，可以了')).toEqual([{ botId: 'cli_bot', via: 'waiting' }])
  expect(await recipients('Mika, please take a look')).toEqual([{ botId: 'cli_peer', via: 'name' }])
  expect(await recipients('请问小林几点到？', ['ou_human'])).toEqual([])
  expect(classify).not.toHaveBeenCalled()
  waiting.mockReturnValue(false)
  expect(await recipients('小窝帮我检查一下')).toEqual([{ botId: 'cli_bot', via: 'name' }])
  expect(await recipients('那就按第二种做吧')).toEqual([{ botId: 'cli_bot', via: 'semantic', confidence: 0.97 }])
  expect(classify).toHaveBeenCalledTimes(1)
  classify.mockResolvedValue({ ...yes, targetBotId: 'cli_peer' })
  expect(await recipients('这样写发布宣传怎样？')).toEqual([])
  expect(await recipients('那就按第二种做吧', [], false, parent)).toEqual([{ botId: 'cli_peer', via: 'semantic', confidence: 0.97 }])
})

let host: Host | undefined
let listener: Promise<unknown> | undefined
afterEach(async () => { await host?.stop(); await listener; host = undefined; listener = undefined })

const textChunk = (text: string): StreamChunk => ({ type: 'text-delta', index: 0, text })
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const event = (id: string, content: string, overrides: Record<string, unknown> = {}) => feishuTrigger({
  message_id: `om_${id}`, chat_type: 'group', chat_id: CHAT, sender_id: MEMBER, sender_type: 'user',
  create_time: String(Date.now()), content, message_app_link: 'https://example.test/message', ...overrides,
}, 'ou_bot', 'cli_bot')!

async function fixture(stream?: (options: GenerateOptions) => AsyncGenerator<StreamChunk>) {
  const h = host = await startRuntime(undefined, { members: [MEMBER, 'ou_bob'], llmStream: stream })
  const { runtime } = h, { store } = runtime, settings = store.settings()
  await runtime.settings.save('source:feishu', { enabled: true, config: { ...settings.sources.feishu!.config,
    chats: [{ chatId: CHAT, listen: 'smart' }], groupModelProvider: 'test-provider', groupModel: 'small' } }, store.blockRevision('source:feishu'), 'panel')
  const receive = (trigger: ReturnType<typeof event>) => runtime.context(feishuKind).receive(trigger, 'live')
  return { h, runtime, store, receive }
}

it('uses preceding same-chat context, filters ordinary chatter and stores a successful semantic route once', async () => {
  const pending = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let result: unknown = { ...yes, respond: false, targetBotId: null, reason: '群友在聊天' }
  const stream = vi.fn(async function* (options: GenerateOptions) {
    const output = JSON.stringify(result)
    if (JSON.stringify(options.messages).includes('第二个')) { started.resolve(); await pending.promise }
    yield textChunk(output.slice(0, 20)); yield textChunk(output.slice(20)); yield finish
  })
  const { h, store, receive, runtime } = await fixture(stream)
  const history = (id: string, text: string, delta: number, chat = CHAT) => ({ message_id: id, chat_id: chat,
    sender: { id: 'cli_bot', sender_type: 'app' }, body: { content: JSON.stringify({ text }) }, create_time: String(Date.now() + delta) })
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ items: [history('om_prior', '有两个方案，简版还是长版？', -1000),
    history('om_future', '未来消息', 60_000), history('om_other', '别的群', -500, 'oc_other')] })
  const chatter = event('chat', '我午饭想吃面')
  expect(await receive(chatter)).toBe('filtered')
  expect(await receive(chatter)).toBe('filtered')
  expect(store.triggers.get(chatter.id)).toBeUndefined()
  expect(h.candidates()).toEqual([])
  expect(stream).toHaveBeenCalledTimes(1)
  const call = stream.mock.calls[0]![0]
  expect(call).toMatchObject({ provider: 'test-provider', model: 'small', maxTokens: 512 })
  expect(call.tools).toBeUndefined()
  const payload = JSON.stringify(call.messages)
  expect(payload).toContain('有两个方案')
  expect(payload).toContain(MEMBER)
  expect(payload).not.toMatch(/未来消息|别的群/)

  result = yes
  const continuation = event('cont', '第二个吧，再给一个例子')
  const first = receive(continuation)
  await started.promise
  const again = receive(continuation)
  expect(await runtime.context(feishuKind).receive(continuation)).toBe('filtered')
  pending.resolve()
  expect(await Promise.all([first, again])).toEqual(['stored', 'duplicate'])
  expect(await receive(continuation)).toBe('duplicate')
  await runtime.idle()
  expect(h.candidates()).toEqual([continuation.id])
  expect(store.triggers.get(continuation.id)).toMatchObject({ actor: continuation.actor, channel: continuation.channel,
    addressed: 'group', meta: { groupAddress: { via: 'semantic', botId: 'cli_bot', confidence: 0.97 } } })
  expect(store.tickets.list()).toEqual([])
  expect(stream).toHaveBeenCalledTimes(2)
  const answer = { purpose: 'answer', trigger_id: continuation.id, text: '可以，第二个方案。' }
  expect(await h.runTool(runtime.masterId, 'orchestrator_reply', answer)).toEqual({ status: 'sent' })
  expect(await h.runTool(runtime.masterId, 'orchestrator_reply', { ...answer, text: '重复答案' })).toEqual({ status: 'sent' })
  expect(runtime.engine.candidate(continuation.id)).toBeUndefined()
  expect(store.tickets.list()).toEqual([])
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args).filter(args => args.includes('+messages-reply'))
  expect(replies).toEqual([expect.arrayContaining(['--message-id', 'om_cont', '--markdown', answer.text, '--reply-in-thread'])])
})

it('requires a complete, high-confidence, correctly targeted judgment from the model', async () => {
  const results: string[] = ['not JSON', JSON.stringify({ ...yes, confidence: 'high' }), JSON.stringify({ ...yes, confidence: 0.84 }),
    JSON.stringify({ ...yes, targetBotId: 'cli_invented' }), JSON.stringify(yes)]
  const stream = vi.fn(async function* () {
    yield textChunk(results.shift()!)
    yield results.length ? finish : { type: 'finish', reason: { kind: 'max-tokens' } } as StreamChunk
  })
  const { receive, store, h } = await fixture(stream)
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ items: [] })
  for (let index = 0; index < 5; index++) expect(await receive(event(`reject${index}`, '你怎么看？'))).toBe('filtered')
  expect(store.read.recentTriggers(0, 10)).toEqual([])
  expect(h.candidates()).toEqual([])
  expect(stream).toHaveBeenCalledTimes(5)
})

it('rechecks the sender before applying a judgment when membership changes during the model call', async () => {
  const release = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  const { receive, store, h } = await fixture(async function* () {
    started.resolve(); await release.promise
    yield textChunk(JSON.stringify(yes)); yield finish
  })
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ items: [] })
  const trigger = event('revoked', '第二个吧')
  const received = receive(trigger)
  await started.promise
  const settings = store.settings()
  store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources,
    feishu: { ...settings.policy.sources.feishu!, allowed: [] } } } })
  release.resolve()
  expect(await received).toBe('filtered')
  expect(store.triggers.get(trigger.id)).toBeUndefined()
  expect(h.candidates()).toEqual([])
})

it('routes live unmentioned CLI events through the classifier and ignores group chatter', async () => {
  const stream = vi.fn(async function* ({ messages }: GenerateOptions) {
    const react = JSON.stringify(messages).includes('第二个方案')
    yield textChunk(JSON.stringify(react ? yes : { ...yes, respond: false, targetBotId: null })); yield finish
  })
  const { runtime, h } = await fixture(stream)
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ items: [] })
  const file = join(h.directory, 'group-events.ndjson')
  writeFileSync(file, '')
  writeFileSync(runtime.deployment.feishu!.cli, `#!/bin/sh\nprintf '[event] ready\\n' >&2\nexec tail -n +1 -f "${file}"\n`, { mode: 0o755 })
  listener = runFeishu(runtime.context(feishuKind), runtime.lifetime)
  const message = (id: string, content: string) => ({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group',
    sender_id: MEMBER, sender_type: 'user', content, create_time: String(Date.now()), message_app_link: 'https://example.test/message' })
  const live = [message('lunch', '我今天中午想吃面'), message('choice', '按你刚才说的第二个方案来')]
  appendFileSync(file, [...live, live[1]].map(item => JSON.stringify(item)).join('\n') + '\n')
  const id = event('choice', '').id
  await vi.waitFor(() => expect(h.candidates()).toEqual([id]), { timeout: 8000 })
  expect(stream).toHaveBeenCalledTimes(2)
  expect(runtime.store.read.recentTriggers(0, 10).map(trigger => trigger.id)).toEqual([id])
}, 10_000)

it('resolves the CLI reply_to against the original chat and keeps unauthorized events away from the classifier', async () => {
  const stream = vi.fn(async function* () { yield textChunk(JSON.stringify(yes)); yield finish })
  const { receive, store } = await fixture(stream)
  const parent = 'om_prior'
  let parentChat = CHAT, parentType = 'app'
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
    if (args.includes('+messages-mget')) return { messages: [{ message_id: parent, chat_id: parentChat,
      msg_type: 'text', content: '请问要哪个？', sender: { id: 'cli_bot', sender_type: parentType }, create_time: String(Date.now() - 1000) }] }
    const params = JSON.parse(args[args.indexOf('--params') + 1]!)
    return { items: [{ message_id: params.message_ids[0], chat_id: CHAT, parent_id: parent }] }
  })
  const reply = event('reply', '第二个', { reply_to: parent })
  expect(reply.meta.parentId).toBe(parent)
  expect(await receive(reply)).toBe('stored')
  expect(store.triggers.get(reply.id)?.meta.groupAddress).toEqual({ botId: 'cli_bot', via: 'reply' })
  parentChat = 'oc_other'
  expect(await receive(event('otherchat', '第二个', { reply_to: parent }))).toBe('filtered')
  parentChat = CHAT; parentType = 'user'
  expect(await receive(event('person', '第二个', { reply_to: parent }))).toBe('filtered')
  for (const override of [{ sender_id: 'ou_unknown' }, { sender_id: 'ou_peer', sender_type: 'bot' },
    { mentions: [{ id: 'ou_bob' }] }, { create_time: String(Date.now() - 180_000) }]) {
    expect(await receive(event(`skip${JSON.stringify(override).length}`, '第二个', override))).toBe('filtered')
  }
  expect(stream).not.toHaveBeenCalled()
})

it('consumes an outstanding group question only for its sender and topic', async () => {
  const { receive, store, h, runtime } = await fixture()
  const request = event('ask', '给这份清单改下标题', { mentions: [{ id: 'ou_bot' }] })
  expect(await receive(request)).toBe('stored')
  await vi.waitFor(() => expect(h.candidates()).toEqual([request.id]))
  const result = await h.route({ kind: 'accept', trigger_id: request.id, title: '改标题', acknowledgement: '收到', worktree_name: 'test-title' })
  await runtime.idle()
  const ticketId = (result.ticket as { ticket_id: string }).ticket_id
  const question = '用哪个标题？'
  await h.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'progress', summary: '等待标题', human_action: question })
  await h.runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticketId, purpose: 'attention', human_action: question, text: question })
  const topic = { root_id: 'om_ask' }
  expect(await receive(event('wrong_user', '用例会纪要', { ...topic, sender_id: 'ou_bob' }))).toBe('filtered')
  expect(await receive(event('wrong_topic', '用例会纪要'))).toBe('filtered')
  const answer = event('answer', '用例会纪要', topic)
  expect(await receive(answer)).toBe('stored')
  expect(store.triggers.get(answer.id)?.meta.groupAddress).toEqual({ botId: 'cli_bot', via: 'waiting' })
  expect(store.triggers.disposition(answer.id)?.fanout).toEqual([ticketId])
  expect(await receive(event('done', '谢谢', topic))).toBe('filtered')
})
