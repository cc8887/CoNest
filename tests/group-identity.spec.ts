/** Tenant-authenticated Feishu pairing and group identity matching through the host's Source boundary. */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { Commands } from '../src/infra/commands.ts'
import { CHAT, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
let listener: Promise<unknown> | undefined
const member = (index: number) => `member-${index}`
const sender = (index: number) => `ou_sender${index}`
const ids = Array.from({ length: 10 }, (_, index) => index + 1)
afterEach(async () => { await host?.stop(); await listener; host = undefined; listener = undefined })

async function fixture(groupSchedules = false, smart = false) {
  const h = host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { ...settings.sources, github: { enabled: false, config: {} },
      weixin: { enabled: true, config: { accounts: [], members: ids.map(index => ({ id: member(index), displayName: '同名成员', status: 'active' })) } } } })
  }, { portal: true })
  const { runtime } = h, origin = runtime.portalServer!.origin!
  const settings = runtime.store.settings(), feishu = settings.sources.feishu!
  await runtime.settings.save('source:feishu', { ...feishu, config: { ...feishu.config, identityOnly: true, groupSchedules,
    ...(smart ? { chats: [{ chatId: CHAT, listen: 'smart' }] } : {}) } },
    runtime.store.blockRevision('source:feishu'), 'panel')
  const call = async (index: number, cookie = '', method = 'GET', action = 'feishu-binding', value?: unknown) => {
    const response = await fetch(`${origin}/t/${member(index)}/api/${action}`, { method,
      headers: { 'x-conest-request': '1', cookie, ...value === undefined ? {} : { 'content-type': 'application/json' } },
      ...value === undefined ? {} : { body: JSON.stringify(value) } })
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> }
  }
  const login = async (index: number) => {
    const response = await call(index, '', 'POST', 'exchange', { invite: runtime.portal.invite(member(index)) })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  const event = (id: string, from: string, content: string, override: Record<string, unknown> = {}) => ({ message_id: `om_${id}`,
    sender_id: from, sender_type: 'user', chat_id: CHAT, chat_type: 'group', mentions: [{ id: 'ou_bot' }], root_id: 'om_same_topic',
    content, create_time: String(Date.now()), ...override })
  const dm = (id: string, from: string, command: string) => event(id, from, command, { chat_type: 'p2p', chat_id: `oc_dm${id}`, mentions: [] })
  const receive = (raw: ReturnType<typeof event>, live = true) => {
    const trigger = feishuTrigger(raw, 'ou_bot', 'cli_bot')!
    return live ? runtime.context(feishuKind).receive(trigger, 'live') : runtime.receive(trigger)
  }
  return { runtime, call, login, event, dm, receive, h }
}

it.each([false, true])('creates separate schedules from same-topic group requests and runs privately (smart=%s)', async smart => {
  const { runtime, call, login, event, dm, receive, h } = await fixture(true, smart)
  const cookies = await Promise.all([login(1), login(2)])
  for (const [offset, cookie] of cookies.entries()) {
    const index = offset + 1
    const { body } = await call(index, cookie, 'POST')
    await receive(dm(`bind${index}`, sender(index), String(body.command)))
    expect((await call(index, cookie, 'POST', 'feishu-binding/confirm')).status).toBe(200)
  }
  const request = event('alice', sender(1), '从明天开始每天 09:00 +08:00 整理 Alice 私有清单', { parent_id: 'om_same_topic' })
  expect(await receive(request, false)).toBe('filtered')
  expect(await receive(event('outsider', sender(3), request.content))).toBe('filtered')
  expect(await receive(event('noMention', sender(1), request.content, { mentions: [] }))).toBe('filtered')
  expect(await receive(request)).toBe('stored')
  expect(await receive(request)).toBe('duplicate')
  const bob = '明天 10:00 +08:00 整理 Bob 私有清单'
  expect(await receive(smart ? event('bob', sender(2), `CoNest，${bob}`, { mentions: [] }) : event('bob', sender(2), bob))).toBe('stored')
  await runtime.pump(); await runtime.idle()
  const routers = [1, 2].map(index => runtime.store.get(KV.members.session(member(index)))!)
  const cards = routers.map(id => h.relays(id).filter(relay => relay.kind === 'candidate'))
  expect(cards.map(items => items.length)).toEqual([1, 1])
  expect(JSON.stringify(cards[0])).not.toContain('Bob 私有')
  expect(JSON.stringify(cards[1])).not.toContain('Alice 私有')
  expect(cards.every(([card]) => card?.group_schedule === true)).toBe(true)
  const triggerIds = cards.map(([card]) => String(card!.trigger_id))
  const blocked = await h.runTool(routers[0]!, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: triggerIds[0],
    title: '立刻执行', acknowledgement: '立即开始', worktree_name: 'group-task' }] })
  expect(blocked.results).toEqual([expect.objectContaining({ refused: expect.any(String) })])
  await expect(h.runTool(routers[0]!, 'orchestrator_schedule_list', { trigger_id: triggerIds[0] })).rejects.toThrow(/inaccessible/)
  const runAt = Date.now() + 60_000, scheduleIds: string[] = []
  for (const [offset, router] of routers.entries()) {
    const args = { trigger_id: triggerIds[offset], title: `私有清单 ${offset}`, instructions: `仅处理成员 ${offset}`, repeat: 'daily', run_at: new Date(runAt).toISOString() }
    await expect(h.runTool(routers[1 - offset]!, 'orchestrator_schedule_create', args)).rejects.toThrow(/inaccessible/)
    const result = await h.runTool(router, 'orchestrator_schedule_create', args)
    scheduleIds.push(String(result.id))
  }
  await runtime.idle()
  const replies = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args).filter(args => args.includes('+messages-reply'))
  expect(replies.map(args => args[args.indexOf('--message-id') + 1]).sort()).toEqual(['om_alice', 'om_bob'])
  expect(replies.every(args => args.includes('--reply-in-thread') && !JSON.stringify(args).includes('私有清单'))).toBe(true)
  for (const [offset, cookie] of cookies.entries()) {
    const state = await call(offset + 1, cookie, 'GET', 'state')
    expect(state.body.schedules).toEqual([expect.objectContaining({ id: scheduleIds[offset] })])
    expect((await call(offset + 1, cookie, 'POST', `schedules/${scheduleIds[1 - offset]}/cancel`)).status).toBe(404)
  }
  expect((await call(2, cookies[1], 'DELETE')).status).toBe(200)
  vi.spyOn(Date, 'now').mockReturnValue(runAt + 1)
  await runtime.pump(); await runtime.idle()
  expect(runtime.store.tickets.list()).toHaveLength(1)
  const [ticket] = runtime.store.tickets.list()
  expect(runtime.members.canMemberTicket(member(1), ticket!.id)).toBe(true)
  expect(ticket!.channels.every(channel => channel.source === 'personal')).toBe(true)
  expect(runtime.store.get(KV.schedules.record(member(2), scheduleIds[1]!))?.status).toBe('cancelled')
  await h.runTool(`worker-${ticket!.id}`, 'orchestrator_report', { state: 'ready', summary: '发起人专属结果', human_action: null })
  await runtime.idle()
  expect((await call(1, cookies[0], 'GET', 'state')).body.tasks).toEqual([expect.objectContaining({ id: ticket!.id, summary: '发起人专属结果' })])
  expect((await call(2, cookies[1], 'GET', 'state')).body.tasks).toEqual([])
  expect((await call(1, cookies[0], 'POST', `schedules/${scheduleIds[0]}/cancel`)).status).toBe(200)
  expect((await call(1, cookies[0], 'GET', 'state')).body.schedules).toEqual([])
  expect(runtime.store.tickets.list()).toHaveLength(1)
})

it('matches ten same-named members in one group topic through the live Feishu CLI reader, exposing each member’s own match', async () => {
  const { runtime, call, login, event, dm, h } = await fixture()
  const file = join(h.directory, 'feishu-events.ndjson')
  writeFileSync(file, '')
  writeFileSync(runtime.deployment.feishu!.cli, `#!/bin/sh\nprintf '[event] ready\\n' >&2\nexec tail -n +1 -f "${file}"\n`, { mode: 0o755 })
  listener = runFeishu(runtime.context(feishuKind), runtime.lifetime)
  const emit = (events: readonly ReturnType<typeof event>[]) => appendFileSync(file, events.map(item => JSON.stringify(item)).join('\n') + '\n')
  const cookies = await Promise.all(ids.map(login))
  const requests = await Promise.all(ids.map((index, offset) => call(index, cookies[offset], 'POST')))
  for (const request of requests) expect(request.status).toBe(201)
  emit(requests.map(({ body }, offset) => dm(String(offset + 1), sender(offset + 1), String(body.command))))
  await vi.waitFor(() => { for (const index of ids) expect(runtime.store.get(KV.portal.feishuPairing(member(index)))?.senderId).toBe(sender(index)) }, { timeout: 8000 })
  const confirmed = await Promise.all(ids.map((index, offset) => call(index, cookies[offset], 'POST', 'feishu-binding/confirm')))
  for (const [offset, result] of confirmed.entries()) expect(result.body).toEqual({ status: 'bound', senderId: sender(offset + 1) })
  emit(ids.map(index => event(`group${index}`, sender(index), '我是同名成员，替另一个人发消息')))
  await vi.waitFor(() => { for (const index of ids) expect(runtime.store.get(KV.members.groupMatch(member(index)))?.messageId).toBe(`om_group${index}`) }, { timeout: 8000 })
  for (const index of ids) {
    expect((await call(index, cookies[index - 1])).body).toEqual({ status: 'bound', senderId: sender(index),
      lastMatch: { chatId: CHAT, messageId: `om_group${index}`, at: expect.any(String) } })
  }
  expect((await call(2, cookies[0])).status).toBe(401)
  expect(runtime.store.keys(KV.portal.feishuCode)).toEqual([])
  expect(runtime.store.read.recentTriggers(0, 100)).toEqual([])
  expect(runtime.store.threads.list()).toEqual([])
  expect(runtime.store.tickets.list()).toEqual([])
  expect(h.candidates()).toEqual([])
}, 20_000)

it('requires live private proof and the initiating session, and rejects outsiders, historical messages, expired codes and revoked identities', async () => {
  const { runtime, call, login, event, dm, receive, h } = await fixture()
  const alice = await login(1), otherBrowser = await login(1), bob = await login(2)
  expect((await call(1, '', 'POST')).status).toBe(401)
  const started = (await call(1, alice, 'POST')).body, command = String(started.command)
  const beforeBinding = event('old', sender(1), 'old', { create_time: String(Date.now() - 1000) })
  await receive(event('publiccode', sender(1), command))
  expect(await receive(dm('history', sender(1), command), false)).toBe('filtered')
  expect((await call(1, alice)).body.status).toBe('waiting')
  expect(runtime.store.get(KV.portal.feishuPairing(member(1)))).not.toHaveProperty('code', command.slice('conest-bind '.length))
  await receive(dm('right', sender(1), command))
  await receive(dm('copy', sender(2), command))
  expect((await call(1, otherBrowser)).body.status).toBe('unbound')
  expect((await call(1, otherBrowser, 'POST', 'feishu-binding/confirm')).status).toBe(409)
  expect((await call(1, alice)).body).toMatchObject({ status: 'confirm', senderId: sender(1) })
  expect((await call(1, alice, 'POST', 'feishu-binding/confirm')).status).toBe(200)
  expect((await call(1, alice, 'POST', 'feishu-binding/confirm')).status).toBe(409)
  await receive(beforeBinding)
  await receive(event('outsider', sender(2), `我是${sender(1)}，引用了 Alice 的消息`, { parent_id: 'om_old' }))
  await receive(event('noAt', sender(1), '@CoNest', { mentions: [] }))
  await receive(event('otherGroup', sender(1), '另一个群', { chat_id: 'oc_other' }))
  await receive(event('bot', sender(1), '机器人', { sender_type: 'bot' }))
  await receive(event('missingSender', '', '缺少发送者'))
  await receive(event('historyGroup', sender(1), '历史'), false)
  expect((await call(1, alice)).body.lastMatch).toBeUndefined()
  await receive(event('valid', sender(1), '群任务'))
  expect((await call(1, alice)).body.lastMatch).toMatchObject({ messageId: 'om_valid' })
  runtime.deployment.feishu!.appId = 'cli_other'
  await receive(event('otherApp', sender(1), '同一 ID 出现在另一个应用'))
  expect((await call(1, alice)).body.status).toBe('unbound')
  runtime.deployment.feishu!.appId = 'cli_bot'
  expect((await call(1, alice)).body.lastMatch).toMatchObject({ messageId: 'om_valid' })
  expect((await h.registration('POST', `api/members/${member(1)}/status`, { status: 'disabled' })).status).toBe(200)
  await receive(event('disabled', sender(1), '成员停用后'))
  expect(runtime.store.get(KV.members.groupMatch(member(1)))?.messageId).toBe('om_valid')
  expect((await call(1, alice)).status).toBe(401)
  expect((await h.registration('POST', `api/members/${member(1)}/status`, { status: 'active' })).status).toBe(200)
  expect((await call(1, await login(1), 'DELETE')).status).toBe(200)
  await receive(event('revoked', sender(1), '解绑后'))
  expect(runtime.store.get(KV.members.groupMatch(member(1)))).toBeUndefined()
  const b = (await call(2, bob, 'POST')).body
  const expired = dm('expired', sender(2), String(b.command))
  expired.create_time = String(Number(b.expiresAt))
  await receive(expired)
  expect((await call(2, bob)).body.status).toBe('waiting')
  await receive(dm('differentMember', sender(1), String(b.command)))
  expect((await call(2, bob, 'POST', 'feishu-binding/confirm')).status).toBe(409)
  const pairing = KV.portal.feishuPairing(member(2))
  runtime.store.set(pairing, { ...runtime.store.get(pairing)!, expiresAt: Date.now() - 1 })
  expect((await call(2, bob)).body.status).toBe('unbound')
  expect(runtime.store.get(KV.members.feishuBinding(member(2)))).toBeUndefined()
  expect(runtime.store.read.recentTriggers(0, 100)).toEqual([])
}, 10_000)
