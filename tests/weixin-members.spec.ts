/** Ten private members share one Runtime/Store/Engine and queue; only iLink and DSH model driving are simulated. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRuntime, type Host } from './fixtures/host.ts'
import { createWeixinKind, pollWeixin, runWeixin, sendWeixin, weixinActorId, weixinTrigger, type WeixinConfig } from '../src/sources/weixin.ts'
import { WeixinClient, type WeixinAccount, type WeixinMessage } from '../src/sources/weixin-api.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { executorLoad } from '../src/app/views/tickets.ts'
import { initializeWeixinMembers } from '../src/app/weixin-setup.ts'
import { Store } from '../src/app/store.ts'
import { deferred, waitUntil } from './fixtures/async.ts'

let h: Host | undefined
const directories: string[] = []
afterEach(async () => { if (h) await h.stop(); h = undefined; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'conest-members-')); directories.push(dir); return dir }
const message = (account: WeixinAccount, id: string, text = `PRIVATE_${account.ownerId}`): WeixinMessage => ({ message_id: id,
  from_user_id: account.ownerId, message_type: 1, message_state: 2, context_token: `context-${account.id}-${id}`, item_list: [{ type: 1, text_item: { text } }] })

async function fixture(database?: string) {
  const directory = temporary()
  const accounts = Array.from({ length: 10 }, (_, index): WeixinAccount => ({ id: `bot-${index}`, ownerId: `user-${index}`,
    token: `offline-token-${index}`, baseURL: 'https://ilinkai.weixin.qq.com/' }))
  const config: WeixinConfig = { credentialsFile: '', accountId: '', ownerId: '',
    members: accounts.map((_, index) => ({ id: `member-${index}`, displayName: `Member ${index}`, status: 'active' })),
    accounts: accounts.map((account, index) => {
      const file = join(directory, `account-${index}.json`); writeFileSync(file, JSON.stringify(account), { mode: 0o600 })
      return { memberId: `member-${index}`, accountId: account.id, ownerId: account.ownerId, credentialsFile: file }
    }) }
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, weixin: { enabled: true, config } },
      executor: { ...settings.executor, maxWorkers: 1 }, policy: { ...settings.policy,
        sources: { weixin: { allowed: accounts.map(account => ({ id: weixinActorId(account.id, account.ownerId) })) } } } })
  }, { database })
  let source: SourceContext
  const incoming = new Map<string, WeixinMessage[]>(), sent: { bot: string; body: Record<string, any> }[] = []
  const client = new WeixinClient(async (url, options) => {
    const bearer = new Headers(options?.headers).get('Authorization')
    const account = accounts.find(account => `Bearer ${account.token}` === bearer)!
    if (!account) throw new Error('Unknown fixture account')
    const body = JSON.parse(String(options?.body))
    if (String(url).endsWith('/getupdates')) return new Response(JSON.stringify({ ret: 0,
      get_updates_buf: `cursor-${account.id}-${incoming.get(account.id)?.at(-1)?.message_id ?? ''}`, msgs: incoming.get(account.id) ?? [] }))
    sent.push({ bot: account.id, body }); return new Response('{"ret":0}')
  })
  const kind = createWeixinKind(() => source, client)
  h.runtime.sources.register(kind); source = h.runtime.context(kind)
  const routers = accounts.map((_, index) => h!.runtime.store.get(KV.members.session(`member-${index}`))!)
  const poll = async () => { const count = await pollWeixin(source, client, config); await h!.runtime.idle(); return count }
  const route = async (member: number, trigger: string, extra: Record<string, unknown> = {}) => {
    const result = await h!.runTool(routers[member]!, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger,
      title: `Private member ${member}`, worktree_name: 'member-task', acknowledgement: `ACK_user-${member}`, ...extra }] })
    await h!.runtime.idle()
    const item = (result.results as { refused?: string; ticket?: { ticket_id: string } }[])[0]!
    if (item.refused) throw new Error(item.refused)
    return item.ticket!.ticket_id
  }
  const idle = (id: string) => { const agent = h!.agents.get(id)!; agent.status = 'idle'; h!.ctx.emit('agent/status', { agent, status: 'idle' } as never) }
  return { accounts, config, incoming, sent, client, source, routers, poll, route, idle, directory }
}

it('lets a private router schedule future work instead of starting it immediately', async () => {
  const f = await fixture(), [account, other] = [f.accounts[0]!, f.accounts[1]!]
  const incoming = message(account, 'schedule', '请明天上午九点生成一份清单')
  f.incoming.set(account.id, [incoming]); f.incoming.set(other.id, [message(other, 'another-request')]); await f.poll()
  const trigger = weixinTrigger(account, incoming, true)!
  await waitUntil(() => f.routers.slice(0, 2).every(id => h!.tools.get(id)?.has('orchestrator_schedule_create')))
  const runAt = new Date(Date.now() + 86_400_000).toISOString()
  const args = { trigger_id: trigger.id, title: '生成清单', instructions: '生成一份清单', run_at: runAt, repeat: 'once' }
  await expect(h!.runTool(f.routers[1]!, 'orchestrator_schedule_create', args)).rejects.toThrow(/inaccessible/i)
  await expect(h!.runTool(f.routers[0]!, 'orchestrator_schedule_create', { ...args, run_at: '2026-12-01T09:00:00' })).rejects.toThrow()
  await expect(h!.runTool(f.routers[0]!, 'orchestrator_schedule_create', { ...args, run_at: '2020-01-01T00:00:00Z' })).rejects.toThrow(/future/)
  const scheduled = await h!.runTool(f.routers[0]!, 'orchestrator_schedule_create', args)
  expect(scheduled).toMatchObject({ status: 'scheduled', nextAt: runAt })
  expect(await h!.runTool(f.routers[0]!, 'orchestrator_schedule_create', args)).toEqual(scheduled)
  await h!.runtime.idle()
  expect(f.sent.map(item => item.bot)).toEqual([account.id])
  expect(h!.runtime.store.tickets.list()).toEqual([])
  const fresh = message(account, 'new-context')
  f.incoming.set(account.id, [fresh]); await f.poll()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(runAt) + 1)
  const { runtime } = h!
  await runtime.pump(); await runtime.idle()
  const [ticket] = runtime.store.tickets.list(), worker = `worker-${ticket!.id}`
  await h!.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '定时生成的私有清单', human_action: null })
  f.idle(worker); await runtime.idle()
  await h!.runTool(f.routers[0]!, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket!.id, text: '定时生成的私有清单' })
  await runtime.pump(); await runtime.idle()
  expect(f.sent).toHaveLength(2)
  expect(f.sent[1]).toMatchObject({ bot: account.id, body: { msg: { to_user_id: account.ownerId, context_token: fresh.context_token,
    item_list: [expect.objectContaining({ text_item: { text: '定时生成的私有清单' } })] } } })
})

it('restores due schedules after restart, coalesces missed runs, and shares one worker without overlapping a recurrence', async () => {
  let f = await fixture()
  const first = Date.now() + 60_000, day = 86_400_000
  for (const account of f.accounts.slice(0, 2)) f.incoming.set(account.id, [message(account, 'start', `计划 ${account.ownerId}`)])
  await f.poll()
  const ids: string[] = []
  for (const [index, account] of f.accounts.slice(0, 2).entries()) {
    const trigger = weixinTrigger(account, message(account, 'start'), true)!
    const result = await h!.runTool(f.routers[index]!, 'orchestrator_schedule_create', { trigger_id: trigger.id,
      title: `任务 ${index}`, instructions: `仅处理 ${account.ownerId}`, repeat: index === 0 ? 'daily' : 'once', run_at: new Date(first).toISOString() })
    ids.push(String(result.id))
  }
  await h!.runtime.idle()
  await h!.runtime.settings.pause(true, 'tool')
  const database = join(temporary(), 'scheduled.sqlite')
  h!.runtime.store.db.prepare('VACUUM INTO ?').run(database)
  await h!.stop(); h = undefined
  f = await fixture(database)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(first + 2 * day)
  await h!.runtime.pump(); await h!.runtime.idle()
  expect(h!.runtime.store.tickets.list()).toHaveLength(0)
  await h!.runtime.settings.pause(false, 'tool')
  await h!.runtime.idle()
  const { runtime } = h!, tickets = runtime.store.tickets.list()
  expect(tickets).toHaveLength(2)
  expect(executorLoad(runtime.store, runtime.executor.activeCount())).toEqual({ running: 1, queued: 1 })
  for (const [index, id] of ids.entries()) {
    const record = runtime.store.get(KV.schedules.record(`member-${index}`, id))!
    expect(record.status).toBe(index === 0 ? 'scheduled' : 'dispatched')
    expect(record.nextAt).toBe(index === 0 ? first + 3 * day : undefined)
    const ticket = runtime.store.tickets.get(record.lastTicketId!)!
    expect(runtime.members.canMemberTicket(`member-${index}`, ticket.id)).toBe(true)
    expect(runtime.members.canMemberTicket(`member-${1 - index}`, ticket.id)).toBe(false)
    const trigger = runtime.store.triggers.get(ticket.origin.triggerId)!
    expect(trigger.text).toBe(`仅处理 user-${index}`)
    expect(trigger.channel?.address.conversationId).toBe(`user-${index}`)
  }
  clock.mockReturnValue(first + 4 * day)
  await runtime.pump(); await runtime.idle(); await runtime.pump()
  expect(runtime.store.tickets.list()).toHaveLength(2)
})

it('separates ten bound identities, their private router inputs, reads, questions, followups and original-DM results', async () => {
  const f = await fixture()
  for (const account of f.accounts) f.incoming.set(account.id, [message(account, 'same-id')])
  expect(await f.poll()).toBe(10)
  expect(await f.poll()).toBe(0)
  expect(new Set(f.routers).size).toBe(10)
  const triggers = f.accounts.map(account => weixinTrigger(account, message(account, 'same-id'), true)!)
  const tickets: string[] = []
  for (let index = 0; index < 10; index++) tickets.push(await f.route(index, triggers[index]!.id))
  expect(executorLoad(h!.runtime.store, h!.runtime.executor.activeCount())).toEqual({ running: 1, queued: 9 })
  for (let index = 0; index < 10; index++) {
    const payloads = h!.relays(f.routers[index]!)
    expect(JSON.stringify(payloads)).toContain(`PRIVATE_user-${index}`)
    for (let other = 0; other < 10; other++) if (other !== index) expect(JSON.stringify(payloads)).not.toContain(`PRIVATE_user-${other}`)
    const read = await h!.runTool(f.routers[index]!, 'orchestrator_read', { resource: 'tickets', offset: 0 })
    expect((read.items as { ticket_id: string }[]).map(item => item.ticket_id)).toEqual([tickets[index]])
    for (const resource of ['triggers', 'decisions', 'threads']) {
      const listed = await h!.runTool(f.routers[index]!, 'orchestrator_read', { resource, offset: 0, limit: 1 })
      for (let other = 0; other < 10; other++) if (other !== index) expect(JSON.stringify(listed)).not.toContain(triggers[other]!.id)
    }
    expect(h!.tools.get(f.routers[index]!)!.has('orchestrator_settings_save')).toBe(false)
    expect(h!.tools.get(f.routers[index]!)!.has('orchestrator_prompts_save')).toBe(false)
  }
  expect(h!.relays(h!.runtime.masterId).filter(item => ['candidate', 'worker_report', 'worker_attention'].includes(String(item.kind)))).toHaveLength(0)
  // Let every initial worker ask its own member, yielding the sole shared slot to the next worker.
  for (let index = 0; index < 10; index++) {
    const worker = `worker-${tickets[index]}`
    expect(h!.agents.get(worker)?.status).toBe('running')
    await h!.runTool(worker, 'orchestrator_report', { state: 'progress', summary: `WAIT_user-${index}`, human_action: `QUESTION_user-${index}` })
    f.idle(worker); await h!.runtime.idle()
    await h!.runTool(f.routers[index]!, 'orchestrator_reply', { purpose: 'attention', ticket_id: tickets[index], human_action: `QUESTION_user-${index}`, text: `QUESTION_user-${index}` })
  }
  // Each followup now wakes only its own worker, through the same shared slot.
  for (let index = 0; index < 10; index++) {
    const worker = `worker-${tickets[index]}`
    const account = f.accounts[index]!, followup = message(account, 'followup', `FOLLOWUP_user-${index}`)
    f.incoming.set(account.id, [followup]); await f.poll()
    await f.route(index, weixinTrigger(account, followup, true)!.id, { kind: 'attach', ticket_id: tickets[index] })
    await h!.runtime.pump(); await h!.runtime.idle()
    expect(h!.runtime.store.tickets.get(tickets[index]!)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === weixinTrigger(account, followup, true)!.id)).toBe(true)
    await h!.runTool(worker, 'orchestrator_report', { state: 'ready', summary: `RESULT_user-${index}`, human_action: null })
    if (h!.agents.get(worker)!.status === 'running') f.idle(worker)
    await h!.runtime.idle()
    await h!.runTool(f.routers[index]!, 'orchestrator_reply', { purpose: 'result', ticket_id: tickets[index], text: `RESULT_user-${index}` })
    await h!.runtime.pump(); await h!.runtime.idle()
  }
  for (const delivery of f.sent) {
    const index = Number(delivery.bot.slice(4)), wire = delivery.body.msg
    expect(wire.to_user_id).toBe(`user-${index}`)
    expect(wire.context_token).toContain(`context-bot-${index}-`)
    const content = JSON.stringify(wire.item_list)
    for (let other = 0; other < 10; other++) if (other !== index) expect(content).not.toContain(`user-${other}`)
  }
  expect(f.sent.filter(item => JSON.stringify(item.body).includes('RESULT_'))).toHaveLength(10)
  expect(h!.runtime.store.tickets.list().every(ticket => ticket.ended?.outcome === 'completed')).toBe(true)
})

it('rejects guessed foreign ticket/trigger/thread ids, cross-member routing and reporting, shared-router reads and identity reassignment', async () => {
  const f = await fixture()
  f.accounts.forEach(account => f.incoming.set(account.id, [message(account, 'one')]))
  await f.poll()
  const a = weixinTrigger(f.accounts[0]!, message(f.accounts[0]!, 'one'), true)!, b = weixinTrigger(f.accounts[1]!, message(f.accounts[1]!, 'one'), true)!
  const ticketA = await f.route(0, a.id), ticketB = await f.route(1, b.id)
  for (const resource of [`ticket/${ticketB}`, `trigger/${b.id}`, `thread/weixin:${b.threads[0]!.id}`, 'settings', 'prompts', 'models'])
    await expect(h!.runTool(f.routers[0]!, 'orchestrator_read', { resource, offset: 0 })).rejects.toThrow('inaccessible')
  for (const tool of ['orchestrator_ticket_retry', 'orchestrator_ticket_request_status', 'orchestrator_ticket_note'])
    await expect(h!.runTool(f.routers[0]!, tool, { ticket_id: ticketB, ...(tool.endsWith('_note') ? { text: 'malicious note' } : {}) })).rejects.toThrow('inaccessible')
  await expect(f.route(0, b.id)).rejects.toThrow('inaccessible')
  await expect(f.route(0, a.id, { kind: 'attach', ticket_id: ticketB })).rejects.toThrow('inaccessible')
  await expect(f.route(0, a.id, { kind: 'stop', ticket_id: ticketB, reason: 'malicious stop' })).rejects.toThrow('inaccessible')
  await expect(h!.runTool(f.routers[0]!, 'orchestrator_reply', { purpose: 'result', ticket_id: ticketB, text: 'leak' })).rejects.toThrow('inaccessible')
  await expect(h!.runTool(`worker-${ticketA}`, 'orchestrator_report', { state: 'progress', summary: 'leak', human_action: 'question', question_for_trigger_id: b.id })).rejects.toThrow('inaccessible')
  await expect(h!.runTool(`worker-${ticketA}`, 'orchestrator_thread_follow', { thread: `weixin:${b.threads[0]!.id}`, reason: 'leak' })).rejects.toThrow('inaccessible')
  await expect(h!.runTool(h!.runtime.masterId, 'orchestrator_read', { resource: `ticket/${ticketA}`, offset: 0 })).rejects.toThrow('inaccessible')
  const revised = { ...f.config, accounts: f.config.accounts!.map((account, index) => index ? account : { ...account, memberId: 'member-1' }) }
  await expect(h!.runtime.settings.save('source:weixin', { enabled: true, config: revised }, h!.runtime.store.blockRevision('source:weixin'), 'panel')).rejects.toThrow('rebound')
  expect(h!.runtime.store.tickets.get(ticketB)?.ended).toBeUndefined()
})

it('settles a private Weixin chat candidate and deduplicates its reply without creating a Ticket', async () => {
  const f = await fixture(), account = f.accounts[0]!, chat = message(account, 'chat', '你喜欢西瓜吗？')
  f.incoming.set(account.id, [chat])
  const other = f.accounts[1]!
  f.incoming.set(other.id, [message(other, 'other-chat')])
  await f.poll()
  const trigger = weixinTrigger(account, chat, true)!
  expect(h!.runtime.engine.candidate(trigger.id)?.strength).toBe('explicit')
  const answer = { purpose: 'answer', trigger_id: trigger.id, text: '夏天我会选冰西瓜。' }
  await expect(h!.runTool(f.routers[1]!, 'orchestrator_reply', answer)).rejects.toThrow('inaccessible')
  await h!.runTool(f.routers[0]!, 'orchestrator_reply', answer)
  await h!.runTool(f.routers[0]!, 'orchestrator_reply', answer)
  expect(h!.runtime.engine.candidate(trigger.id)).toBeUndefined()
  expect(h!.runtime.store.tickets.list()).toHaveLength(0)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]?.bot).toBe(account.id)
  expect(f.sent[0]?.body.msg.item_list[0].text_item.text).toBe(answer.text)
})

it('keeps 100 member Tickets in one durable queue, restores router ownership and returns every result to its account', async () => {
  let f = await fixture()
  for (const account of f.accounts) f.incoming.set(account.id, Array.from({ length: 10 }, (_, index) => message(account, `task-${index}`)))
  expect(await f.poll()).toBe(100)
  const ownerByTicket = new Map<string, number>()
  for (let round = 0; round < 10; round++) for (let member = 0; member < 10; member++) {
    const account = f.accounts[member]!, trigger = weixinTrigger(account, message(account, `task-${round}`), true)!
    ownerByTicket.set(await f.route(member, trigger.id), member)
    expect(h!.runtime.executor.activeCount()).toBe(1)
  }
  expect(executorLoad(h!.runtime.store, h!.runtime.executor.activeCount())).toEqual({ running: 1, queued: 99 })
  const pages: string[][] = []
  for (const offset of [0, 4, 8]) {
    const page = await h!.runTool(f.routers[0]!, 'orchestrator_read', { resource: 'triggers', offset, limit: 4 })
    const items = page.items as { trigger_id: string; preview: string }[]
    expect(items.every(item => item.preview.includes('PRIVATE_user-0'))).toBe(true)
    pages.push(items.map(item => item.trigger_id))
    expect(page.next_offset).toBe(offset < 8 ? offset + 4 : null)
  }
  expect(pages.map(page => page.length)).toEqual([4, 4, 2])
  expect(new Set(pages.flat()).size).toBe(10)
  const ids = [...f.routers], database = join(temporary(), 'snapshot.sqlite')
  h!.runtime.store.db.prepare('VACUUM INTO ?').run(database)
  await h!.stop(); h = undefined
  f = await fixture(database)
  await h!.runtime.pump(); await h!.runtime.idle()
  expect(f.routers).toEqual(ids)
  expect(executorLoad(h!.runtime.store, h!.runtime.executor.activeCount())).toEqual({ running: 1, queued: 99 })
  for (let index = 0; index < 100; index++) {
    const running = [...h!.agents.values()].filter(agent => agent.id.startsWith('worker-') && agent.status === 'running')
    expect(running).toHaveLength(1)
    const worker = running[0]!.id, ticket = worker.slice(7), owner = ownerByTicket.get(ticket)!
    await h!.runTool(worker, 'orchestrator_report', { state: 'ready', summary: `RESULT_user-${owner}`, human_action: null })
    f.idle(worker); await h!.runtime.idle()
    await h!.runTool(f.routers[owner]!, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket, text: `RESULT_user-${owner}` })
    await h!.runtime.pump(); await h!.runtime.idle()
  }
  expect(h!.runtime.store.tickets.open()).toHaveLength(0)
  expect(executorLoad(h!.runtime.store, h!.runtime.executor.activeCount())).toEqual({ running: 0, queued: 0 })
  expect(f.sent).toHaveLength(100)
  for (let owner = 0; owner < 10; owner++) {
    const results = f.sent.filter(item => item.bot === `bot-${owner}`)
    expect(results).toHaveLength(10)
    expect(results.every(item => item.body.msg.to_user_id === `user-${owner}` && item.body.msg.item_list[0].text_item.text === `RESULT_user-${owner}`)).toBe(true)
  }
}, 30_000)

it('initializes a multi-member Store with pinned credentials and refuses disabled-member ingress, tools and delivery', async () => {
  const f = await fixture(), membersFile = join(f.directory, 'members.json'), stateDir = join(f.directory, 'initialized')
  writeFileSync(membersFile, JSON.stringify(f.config))
  initializeWeixinMembers({ stateDir, membersFile, provider: 'conest', model: 'hy4' })
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    const settings = store.settings()
    expect(settings.sources.weixin?.config.members).toHaveLength(10)
    expect(settings.eval.model).toMatchObject({ provider: 'conest', model: 'hy4-flash' })
    expect(settings.executor).toMatchObject({ maxWorkers: 1, model: { provider: 'conest', model: 'hy4' } })
  } finally { store.close() }
  f.incoming.set(f.accounts[0]!.id, [message(f.accounts[0]!, 'before-disable')]); await f.poll()
  const trigger = weixinTrigger(f.accounts[0]!, message(f.accounts[0]!, 'before-disable'), true)!
  const ticket = await f.route(0, trigger.id), deliveries = f.sent.length
  const gate = deferred()
  h!.sessionQuery.observeSession.mockImplementationOnce(async () => { await gate.promise; return { events: [], [Symbol.dispose]: () => {} } })
  const pendingRead = h!.runTool(f.routers[0]!, 'orchestrator_read', { resource: `ticket/${ticket}/transcript`, offset: 0 })
  const revokedRead = expect(pendingRead).rejects.toThrow('inaccessible')
  const disabled = { ...f.config, members: f.config.members!.map((member, index) => index ? member : { ...member, status: 'disabled' as const }) }
  const settings = h!.runtime.store.settings()
  h!.runtime.outbox.send({ id: 'queued-before-revocation', ticketId: ticket, channel: trigger.channel!, text: 'revoked result', kind: 'reply' })
  expect(h!.runtime.outbox.status('queued-before-revocation')).toBe('pending')
  h!.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, weixin: { enabled: true, config: disabled } } })
  gate.resolve(); await revokedRead
  f.incoming.set(f.accounts[0]!.id, [message(f.accounts[0]!, 'disabled')])
  expect(await pollWeixin(f.source, f.client, disabled)).toBe(0)
  await h!.runtime.sessions.ensure(f.routers[0]!, h!.directory, 'disabled router', 'orchestrator')
  await expect(h!.runTool(f.routers[0]!, 'orchestrator_read', { resource: 'tickets', offset: 0 })).rejects.toThrow('inaccessible')
  await expect(h!.runTool(`worker-${ticket}`, 'orchestrator_report', { state: 'ready', summary: 'revoked result', human_action: null })).rejects.toThrow('inaccessible')
  expect(await sendWeixin(f.source, f.client, { id: 'revoked-send', channel: trigger.channel!, text: 'revoked result', kind: 'reply' })).toBe('gone')
  await h!.runtime.pump()
  await h!.runtime.idle()
  expect(h!.runtime.store.receipts.get('queued-before-revocation')).toMatchObject({ status: 'dropped', dropped: { reason: 'channelIgnored' } })
  expect(f.sent).toHaveLength(deliveries)
})

it('keeps other member pollers live when one account fails and retains aggregate error health', async () => {
  const f = await fixture(), controller = new AbortController(), updates = f.client.updates.bind(f.client)
  f.incoming.set(f.accounts[1]!.id, [message(f.accounts[1]!, 'healthy')])
  vi.spyOn(f.client, 'updates').mockImplementation((account, cursor, signal) => account.id === 'bot-0' ? Promise.reject(new Error('offline transport failure')) : updates(account, cursor, signal))
  const running = runWeixin(f.source, f.client, controller.signal)
  try {
    await waitUntil(() => !!h!.runtime.store.get(KV.weixin.cursor('bot-1')) && h!.runtime.health.weixin?.state === 'error')
    expect(h!.runtime.store.get(KV.weixin.cursor('bot-0'))).toBeUndefined()
    expect(h!.runtime.store.read.recentTriggers()).toHaveLength(1)
  } finally { controller.abort(); await running }
})

it('queues a human followup behind another member instead of taking an extra worker slot', async () => {
  const f = await fixture()
  for (const account of f.accounts.slice(0, 2)) f.incoming.set(account.id, [message(account, 'initial')])
  await f.poll()
  const first = await f.route(0, weixinTrigger(f.accounts[0]!, message(f.accounts[0]!, 'initial'), true)!.id)
  const second = await f.route(1, weixinTrigger(f.accounts[1]!, message(f.accounts[1]!, 'initial'), true)!.id)
  await h!.runTool(`worker-${first}`, 'orchestrator_report', { state: 'progress', summary: 'waiting', human_action: 'Choose format' })
  f.idle(`worker-${first}`); await h!.runtime.idle()
  expect(h!.agents.get(`worker-${second}`)?.status).toBe('running')
  const followup = message(f.accounts[0]!, 'followup', 'Use a list')
  f.incoming.set('bot-0', [followup]); await f.poll()
  await f.route(0, weixinTrigger(f.accounts[0]!, followup, true)!.id, { kind: 'attach', ticket_id: first })
  expect(h!.runtime.executor.activeCount()).toBe(1)
  expect(h!.agents.get(`worker-${first}`)?.status).toBe('idle')
  await h!.runTool(`worker-${second}`, 'orchestrator_report', { state: 'ready', summary: 'done', human_action: null })
  f.idle(`worker-${second}`); await h!.runtime.idle()
  await h!.runTool(f.routers[1]!, 'orchestrator_reply', { purpose: 'result', ticket_id: second, text: 'done' })
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h!.runtime.pump(); await h!.runtime.idle() } finally { vi.useRealTimers() }
  expect(h!.runtime.executor.activeCount()).toBe(1)
  expect(h!.agents.get(`worker-${first}`)?.status).toBe('running')
})
