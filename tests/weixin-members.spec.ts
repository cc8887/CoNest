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
  try { expect(store.settings().sources.weixin?.config.members).toHaveLength(10); expect(store.settings().executor.maxWorkers).toBe(1) } finally { store.close() }
  f.incoming.set(f.accounts[0]!.id, [message(f.accounts[0]!, 'before-disable')]); await f.poll()
  const trigger = weixinTrigger(f.accounts[0]!, message(f.accounts[0]!, 'before-disable'), true)!
  const ticket = await f.route(0, trigger.id), deliveries = f.sent.length
  const gate = deferred()
  h!.controller.inspect.mockImplementationOnce(async () => { await gate.promise; return { events: [] } })
  const pendingRead = h!.runTool(f.routers[0]!, 'orchestrator_read', { resource: `ticket/${ticket}/transcript`, offset: 0 })
  const revokedRead = expect(pendingRead).rejects.toThrow('inaccessible')
  const disabled = { ...f.config, members: f.config.members!.map((member, index) => index ? member : { ...member, status: 'disabled' as const }) }
  const settings = h!.runtime.store.settings()
  h!.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, weixin: { enabled: true, config: disabled } } })
  gate.resolve(); await revokedRead
  f.incoming.set(f.accounts[0]!.id, [message(f.accounts[0]!, 'disabled')])
  expect(await pollWeixin(f.source, f.client, disabled)).toBe(0)
  await h!.runtime.sessions.ensure(f.routers[0]!, h!.directory, 'disabled router', 'orchestrator')
  await expect(h!.runTool(f.routers[0]!, 'orchestrator_read', { resource: 'tickets', offset: 0 })).rejects.toThrow('inaccessible')
  await expect(h!.runTool(`worker-${ticket}`, 'orchestrator_report', { state: 'ready', summary: 'revoked result', human_action: null })).rejects.toThrow('inaccessible')
  expect(await sendWeixin(f.source, f.client, { id: 'revoked-send', channel: trigger.channel!, text: 'revoked result', kind: 'reply' })).toBe('gone')
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
