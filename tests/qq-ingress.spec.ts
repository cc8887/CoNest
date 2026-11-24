import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const python = process.env.CONEST_QQ_TEST_PYTHON
const app = '100200300', room = 'qq-test-group', otherRoom = 'different-group'
const members = ['alice', 'bob']
const qqConfig = { appId: app, groups: [{ conversationId: room, listen: 'smart' }],
  modelProvider: 'test', model: 'addressing', bindings: members.flatMap(memberId => [
    { scope: 'dm', conversationId: `dm-${memberId}`, senderId: `dm-${memberId}`, memberId },
    { scope: 'group', conversationId: room, senderId: `group-${memberId}`, memberId },
  ]) }

const dm = (id: string, text: string) => ({ type: 'C2C_MESSAGE_CREATE', data: { id, content: text, timestamp: new Date().toISOString(),
  author: { id: 'dm-alice', user_openid: 'dm-alice', bot: false } } })
const group = (id: string, content: string, sender: string, options: { mention?: boolean; bot?: boolean; another?: boolean;
  room?: string; index?: string; reference?: string; elements?: unknown[] } = {}) => ({
  type: options.mention ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', data: { id, content, timestamp: new Date().toISOString(),
    group_openid: options.room ?? room, author: { id: sender, member_openid: sender, bot: options.bot ?? false },
    message_scene: { ext: [...(options.index ? [`msg_idx=${options.index}`] : []), ...(options.reference ? [`ref_msg_idx=${options.reference}`] : [])] },
    ...(options.elements ? { msg_elements: options.elements } : {}),
    ...(options.another ? { mentions: [{ id: 'group-bob', member_openid: 'group-bob', bot: false, is_you: false }] } : {}) },
})

it.skipIf(!python)('connects real Octop QQ transport to private CoNest task intake, smart group addressing, and replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'conest-qq-test-'))
  const credentialsFile = join(root, 'credentials.json')
  writeFileSync(credentialsFile, JSON.stringify({ appId: app, appSecret: 'octop-qq-fixture-only' }), { mode: 0o600 })
  const scripts = resolve('sidecars/octop-qq')
  const mock = spawn(python!, ['-u', join(scripts, 'mock_gateway.py')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const exited = once(mock, 'close')
  const lines = createInterface({ input: mock.stdout })
  let host: Host | undefined
  try {
    const [line] = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error('QQ fixture exited before ready') })])
    const { origin } = JSON.parse(line) as { origin: string }
    const stream = vi.fn(async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
      const input = JSON.stringify(options.messages)
      const respond = input.includes('把第三项也加进去') && input.includes('ALICE_GROUP_PRIVATE') && !input.includes('BOB_GROUP_PRIVATE')
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ respond, confidence: 0.97, reason: 'fixture', targetBotId: respond ? app : null }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const h = host = await startRuntime(store => {
      const settings = store.settings()
      store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: false, config: {} },
        weixin: { enabled: true, config: { accounts: [], members: members.map(id => ({ id, displayName: '同名成员', status: 'active' })) } },
        personal: { enabled: true, config: {} }, qq: { enabled: true, config: qqConfig } },
      policy: { ...settings.policy, sources: { ...settings.policy.sources,
        personal: { allowed: members.map(id => ({ id })), admission: {} } } }, executor: { ...settings.executor, maxWorkers: 1 } })
    }, { portal: true, llmStream: stream, qq: { python: python!, script: join(scripts, 'mock_bridge.py'), credentialsFile, env: { CONEST_QQ_TEST_ORIGIN: origin } } })
    const { runtime } = h, { store } = runtime
    const [alice, bob] = members.map(member => store.get(KV.members.session(member))!)
    const emit = async (...events: unknown[]) => {
      const response = await fetch(`${origin}/_fixture/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(events) })
      expect(response.ok).toBe(true)
    }
    const sent = async () => await (await fetch(`${origin}/_fixture/sent`)).json() as { path: string; body: { content: string; msg_id: string; msg_seq: number } }[]
    const candidate = (session: string, text: string) => h.relays(session).find(relay => relay.kind === 'candidate' && String(relay.text).includes(text))
    await vi.waitFor(() => expect(runtime.health.qq?.state).toBe('ready'), { timeout: 6000 })
    expect(runtime.sources.kind('feishu')).toBeDefined()
    expect(runtime.store.settings().sources.weixin?.enabled).toBe(true)

    await emit(dm('qq-private', 'ALICE_DM_ONLY'))
    await vi.waitFor(() => expect(candidate(alice!, 'ALICE_DM_ONLY')).toBeDefined())
    await h.runTool(alice!, 'orchestrator_reply', { purpose: 'answer', trigger_id: candidate(alice!, 'ALICE_DM_ONLY')!.trigger_id, text: 'QQ 私聊确认' })
    await vi.waitFor(async () => expect(await sent()).toEqual([{ path: '/v2/users/dm-alice/messages',
      body: expect.objectContaining({ msg_id: 'qq-private', msg_seq: 1, content: 'QQ 私聊确认' }) }]))

    const aliceGroup = group('qq-alice-at', '整理附件 ALICE_GROUP_PRIVATE', 'group-alice', { mention: true, index: 'user-index-1' })
    const bobGroup = group('qq-bob-at', '整理附件 BOB_GROUP_PRIVATE', 'group-bob', { mention: true })
    await emit(aliceGroup, bobGroup, aliceGroup, group('qq-bot', '机器人回声', 'group-alice', { mention: true, bot: true }),
      group('qq-outsider', '冒充 Alice', 'not-a-member', { mention: true }), group('qq-other-room', '换一个群', 'group-alice', { mention: true, room: otherRoom }))
    await vi.waitFor(async () => expect((await sent()).map(row => row.body.msg_id)).toEqual(['qq-private', 'qq-alice-at', 'qq-bob-at']))
    expect((await sent())[1]!.body).toMatchObject({ msg_seq: 1, message_reference: { message_id: 'user-index-1' } })
    expect(stream).not.toHaveBeenCalled()

    const continuation = group('qq-semantic', '把第三项也加进去', 'group-alice')
    await emit(group('qq-small-talk', '今天吃什么', 'group-bob'), group('qq-mention-person', '把第三项也加进去', 'group-alice', { another: true }), continuation, continuation)
    await vi.waitFor(async () => expect((await sent()).map(row => row.body.msg_id)).toEqual(['qq-private', 'qq-alice-at', 'qq-bob-at', 'qq-semantic']))
    expect(stream).toHaveBeenCalledTimes(2)
    const followInput = JSON.stringify(stream.mock.calls[1]![0].messages)
    expect(followInput).toContain('ALICE_GROUP_PRIVATE')
    expect(followInput).not.toMatch(/BOB_GROUP_PRIVATE|ALICE_DM_ONLY/)
    const triggers = store.read.recentTriggers(0, 30)
    expect(triggers).toHaveLength(4)
    const follow = triggers.find(trigger => trigger.text === '把第三项也加进去')!
    expect(follow).toMatchObject({ actor: { source: 'personal', id: 'alice' }, channel: { source: 'personal' },
      meta: { qq: { scope: 'group', eventType: 'GROUP_MESSAGE_CREATE', messageId: 'qq-semantic', mentioned: false }, groupAddress: { via: 'semantic' } } })
    expect(JSON.stringify(h.relays(alice!))).not.toContain('BOB_GROUP_PRIVATE')
    expect(JSON.stringify(h.relays(bob!))).not.toContain('ALICE_GROUP_PRIVATE')

    const a = triggers.find(trigger => trigger.text.includes('ALICE_GROUP_PRIVATE'))!, b = triggers.find(trigger => trigger.text.includes('BOB_GROUP_PRIVATE'))!
    await expect(h.runTool(bob!, 'orchestrator_read', { resource: `trigger/${a.id}` })).rejects.toThrow(/inaccessible/)
    const accept = async (session: string, trigger: string, title: string) => {
      await vi.waitFor(() => expect(h.relays(session).some(card => card.kind === 'candidate' && card.trigger_id === trigger)).toBe(true))
      const result = await h.runTool(session, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger, title,
        worktree_name: title, acknowledgement: title }] })
      return ((result.results as { ticket: { ticket_id: string } }[])[0]!).ticket.ticket_id
    }
    const aliceTicket = await accept(alice!, a.id, 'alice-private'), bobTicket = await accept(bob!, b.id, 'bob-private')
    await runtime.idle()
    expect(runtime.members.canMemberTicket('alice', aliceTicket)).toBe(true)
    expect(runtime.members.canMemberTicket('alice', bobTicket)).toBe(false)
    expect(runtime.members.canMemberTicket('bob', bobTicket)).toBe(true)
    await expect(h.runTool(bob!, 'orchestrator_read', { resource: `ticket/${aliceTicket}` })).rejects.toThrow(/inaccessible/)
    expect((await sent()).filter(row => row.path.includes('/groups/')).every(row => row.body.content === '已收到。后续内容请在你自己的 CoNest 个人空间查看。')).toBe(true)
    await h.runTool(`worker-${aliceTicket}`, 'orchestrator_report', { state: 'ready', summary: 'ALICE_RESULT_PRIVATE', human_action: null })
    expect(store.tickets.get(aliceTicket)?.ended?.outcome).toBe('completed')
    expect(JSON.stringify(await sent())).not.toContain('ALICE_RESULT_PRIVATE')
    const personalState = async (member: string) => {
      const base = `${runtime.portalServer!.origin}/t/${member}/api`
      const auth = await fetch(`${base}/exchange`, { method: 'POST', headers: { 'x-conest-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ invite: runtime.portal.invite(member) }) })
      expect(auth.ok).toBe(true)
      const state = await fetch(`${base}/state`, { headers: { 'x-conest-request': '1', cookie: auth.headers.get('set-cookie')!.split(';')[0]! } })
      expect(state.ok).toBe(true)
      return await state.json() as { tasks: unknown[] }
    }
    expect((await personalState('alice')).tasks).toEqual([expect.objectContaining({ id: aliceTicket, summary: 'ALICE_RESULT_PRIVATE' })])
    expect((await personalState('bob')).tasks).toEqual([expect.objectContaining({ id: bobTicket })])

    const configure = (enabled: boolean) => runtime.settings.save('source:qq', { enabled, config: qqConfig }, store.blockRevision('source:qq'), 'panel')
    await configure(false)
    await vi.waitFor(() => expect(runtime.health.qq?.state).toBe('paused'), { timeout: 5000 })
    await configure(true)
    await vi.waitFor(() => expect(runtime.health.qq?.state).toBe('ready'), { timeout: 5000 })
    // Octop's memory cache has been cleared. The host must still dedupe before the model call.
    await emit(continuation, dm('qq-barrier', 'ALICE_AFTER_RECONNECT'))
    await vi.waitFor(() => expect(candidate(alice!, 'ALICE_AFTER_RECONNECT')).toBeDefined())
    expect(stream).toHaveBeenCalledTimes(2)
    expect(await sent()).toHaveLength(4)

    // The bridge's in-memory quote history was cleared, but QQ's sent index is retained in the CoNest Store.
    await emit(group('qq-wrong-quote', '引用另一条消息', 'group-alice', { reference: 'unknown-index',
      elements: [{ msg_idx: 'mismatched-index', content: '此前的一条机器人回复', author: { id: app, bot: true } }] }),
    group('qq-quoted', '也整理一份备份', 'group-alice', { reference: 'fixture-reference-2', index: 'user-index-2' }))
    await vi.waitFor(() => expect(candidate(alice!, '也整理一份备份')).toBeDefined())
    expect(candidate(alice!, '引用另一条消息')).toBeUndefined()
    expect(store.triggers.get(String(candidate(alice!, '也整理一份备份')!.trigger_id))?.meta).toMatchObject({
      groupAddress: { via: 'reply' }, qq: { referenceId: 'fixture-reference-2', messageIndex: 'user-index-2' },
    })
    await vi.waitFor(async () => expect((await sent()).at(-1)?.body).toMatchObject({ msg_id: 'qq-quoted', message_reference: { message_id: 'user-index-2' } }))
    await emit(group('qq-quoted-by-bob', 'Bob 自己的请求', 'group-bob', { reference: 'fixture-reference-2' }))
    await vi.waitFor(() => expect(candidate(bob!, 'Bob 自己的请求')).toBeDefined())
    expect(candidate(bob!, 'Bob 自己的请求')).not.toHaveProperty('replies_to')
    expect(stream).toHaveBeenCalledTimes(2)
  } finally {
    await host?.stop()
    lines.close()
    mock.stdin.end()
    await exited
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
