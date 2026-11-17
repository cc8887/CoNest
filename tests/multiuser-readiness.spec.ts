/** Readiness audit, not private multiuser acceptance: real Store/Engine/scheduler, simulated DSH agents and Feishu input. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { WeixinConfigSchema, weixinTrigger, weixinActorId } from '../src/sources/weixin.ts'
import { executorLoad } from '../src/app/views/tickets.ts'

let h: Host | undefined
const snapshots: string[] = []
afterEach(async () => {
  if (h) await h.stop()
  h = undefined
  for (const directory of snapshots.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const users = Array.from({ length: 10 }, (_, index) => `ou_mock${index}`)

it('retains the legacy pinned-owner gate and requires a member directory for multi-account configuration', async () => {
  const config = { credentialsFile: '/offline/account.json', accountId: 'mock-bot', ownerId: users[0]! }
  expect(WeixinConfigSchema.safeParse({ accounts: users.map((ownerId, index) => ({ ...config, accountId: `bot-${index}`, ownerId })) }).success).toBe(false)
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { github: { enabled: false, config: {} }, weixin: { enabled: true, config } },
      policy: { ...settings.policy, sources: { weixin: { allowed: users.map(owner => ({ id: weixinActorId(config.accountId, owner) })) } } } })
  })
  // The production mapper rejects strangers before Policy evaluation. Merely adding allowed ids cannot enable members.
  const mapped = users.map((owner, index) => weixinTrigger({ id: config.accountId, ownerId: config.ownerId },
    { message_id: String(index), from_user_id: owner, message_type: 1, message_state: 2,
      context_token: 'offline-context', item_list: [{ type: 1, text_item: { text: `private-${owner}` } }] }))
  expect(mapped.filter(Boolean)).toHaveLength(1)
  expect(mapped[0]?.actor.id).toBe(weixinActorId(config.accountId, users[0]!))
})

it('queues 100 real Tickets from ten simulated requesters behind one worker, preserves them on restart and drains every owner', async () => {
  const configure = () => {
    const settings = h!.runtime.store.settings()
    h!.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 },
      policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { allowed: users.map(id => ({ id })), syncChat: '' } } } })
  }
  h = await startRuntime(undefined, { members: users })
  configure()
  const owners = new Map<string, string>()
  for (let index = 0; index < 100; index++) {
    const owner = users[index % users.length]!
    // Distinct Feishu threads exercise the existing general scheduler without bypassing Weixin's owner guard.
    const trigger = feishu(String(index + 1), `PRIVATE_${owner}：请处理独立任务 ${index}。`, { sender_id: owner })
    const { ticket } = await h.acceptedTicket(trigger)
    owners.set(ticket.id, owner)
    expect(h.runtime.executor.activeCount()).toBe(1)
  }
  expect(h.runtime.store.tickets.open()).toHaveLength(100)
  expect(new Set(owners.values()).size).toBe(10)
  expect(executorLoad(h.runtime.store, h.runtime.executor.activeCount())).toEqual({ running: 1, queued: 99 })
  expect([...h.agents.keys()].filter(id => id.startsWith('worker-'))).toHaveLength(1)
  // This is the shared administrative router, not ten private member routers. All candidates reach its one Session.
  const candidates = h.deliveries.mock.calls.map(([call]) => ({ ...call, card: JSON.parse(call.text) as { kind: string; trigger_id: string } }))
    .filter(call => call.card.kind === 'candidate')
  expect(new Set(candidates.map(call => call.card.trigger_id)).size).toBe(100)
  expect(new Set(candidates.map(call => call.sessionId))).toEqual(new Set([h.runtime.masterId]))

  const directory = mkdtempSync(join(tmpdir(), 'conest-queue-snapshot-'))
  snapshots.push(directory)
  const database = join(directory, 'snapshot.sqlite')
  // SQLite creates a consistent snapshot including WAL commits; copying only the live .sqlite file would lose data.
  h.runtime.store.db.prepare('VACUUM INTO ?').run(database)
  await h.stop(); h = undefined
  h = await startRuntime(undefined, { database, members: users })
  configure()
  await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.store.tickets.open()).toHaveLength(100)
  expect(new Set(h.runtime.store.tickets.list().map(ticket => ticket.id))).toEqual(new Set(owners.keys()))
  expect(executorLoad(h.runtime.store, h.runtime.executor.activeCount())).toEqual({ running: 1, queued: 99 })

  const completed = new Map(users.map(user => [user, 0]))
  for (let index = 0; index < 100; index++) {
    const running = [...h.agents.values()].filter(agent => agent.id.startsWith('worker-') && agent.status === 'running')
    expect(running).toHaveLength(1)
    const agent = running[0]!, ticketId = agent.id.slice('worker-'.length)
    await h.runTool(agent.id, 'orchestrator_report', { state: 'ready', summary: `RESULT_${owners.get(ticketId)}`, human_action: null })
    agent.status = 'idle'; h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await h.runtime.idle()
    await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticketId, text: `RESULT_${owners.get(ticketId)}` })
    completed.set(owners.get(ticketId)!, completed.get(owners.get(ticketId)!)! + 1)
    await h.runtime.pump(); await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBeLessThanOrEqual(1)
  }
  expect(h.runtime.store.tickets.open()).toHaveLength(0)
  expect(h.runtime.store.tickets.list().every(ticket => ticket.ended?.outcome === 'completed')).toBe(true)
  expect([...completed.values()]).toEqual(Array(10).fill(10))
  expect(executorLoad(h.runtime.store, h.runtime.executor.activeCount())).toEqual({ running: 0, queued: 0 })
}, 30_000)
