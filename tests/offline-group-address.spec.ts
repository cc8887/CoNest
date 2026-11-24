/** Shared group addressing through synthetic events and a scripted model stream. */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { classifyGroupAddress } from '../src/app/group-address-model.ts'
import { groupAddress, type GroupBot, type GroupReference } from '../src/ingress/group-address.ts'
import { triggerFromInbound } from '../src/ingress/messages.ts'
import type { ContextMessage } from '../src/sources/kind.ts'

const bots: GroupBot[] = [
  { id: 'planner', addresses: ['planner-account'], names: ['计划助手'], role: '安排任务' },
  { id: 'recorder', addresses: ['recorder-account'], names: ['记录助手'], role: '记录讨论' },
]
const sender = 'member-alice'
const previous: ContextMessage[] = [{ id: 'prior-question', from: 'planner-account', at: '2026-11-21T04:00:00Z',
  text: '清单可以发简版或者详细版，你选哪个？', bot: true }]
const references = new Map<string, GroupReference>([
  ['recorder-reply', { senderIds: ['recorder-account'], bot: true, mentions: [] }],
  ['member-reply', { senderIds: ['member-bob'], bot: false, mentions: [] }],
])

function scriptedModel(body = '') {
  return { stream: vi.fn(async function* (_request: GenerateOptions): AsyncGenerator<StreamChunk> {
    const split = Math.floor(body.length / 2)
    yield { type: 'text-delta', index: 0, text: body.slice(0, split) }
    yield { type: 'text-delta', index: 0, text: body.slice(split) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }) }
}

async function recipients(event: { text: string; mentions?: string[]; replyTo?: string }, llm: ReturnType<typeof scriptedModel>) {
  const { text, mentions = [], replyTo } = event
  const trigger = triggerFromInbound({ channelKind: 'synthetic', channelId: 'local-account', senderId: sender, senderKind: 'user',
    messageId: 'current-message', at: '2026-11-21T04:00:01Z', conversation: { scope: 'group', groupId: 'local-group', externalConversationId: 'local-group' },
    parts: [{ type: 'text', text }] })
  const signal = new AbortController().signal
  const results = await Promise.all(bots.map(async bot => {
    const selected = await groupAddress({ senderId: sender, text, mentions, hasParent: replyTo !== undefined }, {
      bots, localBotId: bot.id, autonomousBotId: 'planner', history: false,
      parent: async () => replyTo ? references.get(replyTo) : undefined,
      waiting: () => false,
      classify: () => classifyGroupAddress(llm, { provider: 'offline', model: 'scripted' }, trigger, bots, previous, signal).catch(() => undefined),
    })
    return selected?.botId === bot.id ? selected : undefined
  }))
  return results.filter(result => result !== undefined)
}

it('delivers a structured @ to one bot ahead of the reply target', async () => {
  const llm = scriptedModel()
  expect(await recipients({ text: '把清单整理一下', mentions: ['planner-account', 'recorder-account'], replyTo: 'recorder-reply' }, llm))
    .toEqual([{ botId: 'planner', via: 'mention' }])
  expect(llm.stream).not.toHaveBeenCalled()
})

it('delivers a reply without @ to the bot whose message was quoted', async () => {
  const llm = scriptedModel()
  expect(await recipients({ text: '再加一条', replyTo: 'recorder-reply' }, llm)).toEqual([{ botId: 'recorder', via: 'reply' }])
  expect(llm.stream).not.toHaveBeenCalled()
})

it.each(['member-reply', 'unavailable-message'])('stays silent for the reference %s', async replyTo => {
  const llm = scriptedModel()
  expect(await recipients({ text: '选详细版', replyTo }, llm)).toEqual([])
  expect(llm.stream).not.toHaveBeenCalled()
})

it('stays silent when the message is addressed to another member', async () => {
  const llm = scriptedModel()
  expect(await recipients({ text: '选详细版', mentions: ['member-bob'] }, llm)).toEqual([])
  expect(llm.stream).not.toHaveBeenCalled()
})

const yes = { respond: true, confidence: 0.96, reason: '成员在回答刚才的问题', targetBotId: 'planner' }

it('routes a no-@ continuation with one tool-free model call across two bots', async () => {
  const llm = scriptedModel(JSON.stringify(yes))
  expect(await recipients({ text: '详细版就可以，发我一份' }, llm)).toEqual([{ botId: 'planner', via: 'semantic', confidence: 0.96 }])
  expect(llm.stream).toHaveBeenCalledTimes(1)
  const [request] = llm.stream.mock.calls[0]!
  expect(request.tools).toBeUndefined()
  const payload = JSON.stringify(request.messages)
  expect(payload).toContain('清单可以发简版或者详细版，你选哪个？')
  expect(payload).toContain('详细版就可以，发我一份')
})

it.each([
  { name: 'ordinary chatter', body: JSON.stringify({ ...yes, respond: false, targetBotId: null }) },
  { name: 'low confidence', body: JSON.stringify({ ...yes, confidence: 0.84 }) },
  { name: 'unknown target', body: JSON.stringify({ ...yes, targetBotId: 'unknown' }) },
  { name: 'invalid response shape', body: JSON.stringify({ ...yes, confidence: 'likely' }) },
  { name: 'malformed JSON', body: '{"respond":true' },
])('stays silent after a semantic response for $name', async ({ body }) => {
  const llm = scriptedModel(body)
  expect(await recipients({ text: '大家中午去哪吃？' }, llm)).toEqual([])
  expect(llm.stream).toHaveBeenCalledTimes(1)
})
