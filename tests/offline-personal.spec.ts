import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PersonalView } from '../src/app/portal-types.ts'
import { ticketOfSession, workerSessionId } from '../src/executor/dsh.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const alice = 'offline-alice', bob = 'offline-bob'
const aliceTask = '整理我的私有方案', bobTask = '生成我的独立清单'
const question = '要按日期还是按主题整理？', answer = '请按主题整理'
const aliceResult = '已按主题整理方案', bobResult = '独立清单已完成'

function workerIdle(host: Host, sessionId: string): void {
  const agent = host.agents.get(sessionId)!
  agent.status = 'idle'
  host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}

function startPersonal(members: string[], stateDir?: string) {
  return startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: {
      github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} }, qq: { enabled: false, config: {} },
      // The host stores its member directory here. No bot account or Weixin transport is configured.
      weixin: { enabled: false, config: { accounts: [], members: members.map(id => ({ id, displayName: '同名成员', status: 'active' })) } },
      personal: { enabled: true, config: {} },
    }, executor: { ...settings.executor, maxWorkers: 1 } })
  }, { portal: true, stateDir })
}

function personalHttp(host: Host) {
  const origin = host.runtime.portalServer!.origin!
  const http = (member: string, path: string, cookie = '', method = 'GET', body?: object) =>
    fetch(`${origin}/t/${member}/api/${path}`, { method, headers: { 'x-conest-request': '1', origin, cookie,
      ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const login = async (member: string) => {
    const link = await host.registration('POST', `api/members/${member}/invite`)
    expect(link.status).toBe(200)
    const invite = new URL(String(link.body.inviteUrl)).hash.slice('#invite='.length)
    const session = await http(member, 'exchange', '', 'POST', { invite })
    expect(session.status).toBe(200)
    return session.headers.get('set-cookie')!.split(';')[0]!
  }
  const state = async (member: string, cookie: string): Promise<PersonalView> => {
    const response = await http(member, 'state', cookie)
    expect(response.status, `state for ${member}`).toBe(200)
    return await response.json() as PersonalView
  }
  const openTicket = async (member: string, cookie: string, requestId: string, text: string) => {
    expect((await http(member, 'tasks', cookie, 'POST', { requestId, text })).status).toBe(202)
    await host.runtime.idle()
    const candidate = host.deliveries.mock.calls.findLast(([message]) => {
      const card = JSON.parse(message.text) as { kind: string; text?: string; trigger_id?: string }
      return card.kind === 'candidate' && card.text === text && !!card.trigger_id
    })?.[0]
    expect(candidate, `candidate for ${text}`).toBeDefined()
    const verdict = await host.runTool(candidate!.sessionId, 'orchestrator_route', { decisions: [
      { kind: 'accept', trigger_id: JSON.parse(candidate!.text).trigger_id, title: text, worktree_name: requestId, acknowledgement: '已接单' },
    ] })
    const [accepted] = verdict.results as { ticket?: { ticket_id: string }; refused?: string }[]
    expect(accepted).toMatchObject({ ticket: { ticket_id: expect.any(String) } })
    await host.runtime.idle()
    return accepted!.ticket!.ticket_id
  }
  return { http, login, state, openTicket }
}

it('runs two private tenants through HTTP intake, one-slot dispatch, a queued answer and private results', async () => {
  const host = await startPersonal([alice, bob])
  try {
    const { http, login, state, openTicket } = personalHttp(host)
    const aliceCookie = await login(alice), bobCookie = await login(bob)
    const aliceId = await openTicket(alice, aliceCookie, 'alice-request', aliceTask)
    const bobId = await openTicket(bob, bobCookie, 'bob-request', bobTask)
    const aliceWorker = workerSessionId(aliceId), bobWorker = workerSessionId(bobId)
    expect((await state(alice, aliceCookie)).tasks).toEqual([expect.objectContaining({ id: aliceId, title: aliceTask, stage: 'working' })])
    expect((await state(bob, bobCookie)).tasks).toEqual([expect.objectContaining({ id: bobId, title: bobTask, stage: 'queued' })])
    expect((await http(alice, 'state', bobCookie)).status).toBe(401)
    expect((await http(bob, `tasks/${aliceId}/stop`, bobCookie, 'POST')).status).toBe(404)

    await host.runTool(aliceWorker, 'orchestrator_report', { state: 'progress', summary: '等待整理方式', human_action: question })
    workerIdle(host, aliceWorker)
    await host.runtime.idle()
    expect((await state(alice, aliceCookie)).tasks[0]).toMatchObject({ id: aliceId, stage: 'person', question })
    expect((await state(bob, bobCookie)).tasks).toEqual([expect.objectContaining({ id: bobId, stage: 'working' })])
    expect(JSON.stringify(await state(bob, bobCookie))).not.toContain(question)
    expect((await http(bob, 'tasks', bobCookie, 'POST', { requestId: 'foreign-answer', text: '越权回复', ticketId: aliceId })).status).toBe(404)

    const followup = { requestId: 'alice-answer', text: answer, ticketId: aliceId }
    expect((await http(alice, 'tasks', aliceCookie, 'POST', followup)).status).toBe(202)
    await host.runtime.idle()
    // The one worker slot is still occupied by Bob. Alice's answer must wait for it.
    expect(host.relays(aliceWorker).some(relay => relay.text === answer)).toBe(false)
    await host.runTool(bobWorker, 'orchestrator_report', { state: 'ready', summary: bobResult, human_action: null })
    workerIdle(host, bobWorker)
    await vi.waitFor(() => expect(host.relays(aliceWorker)).toContainEqual(expect.objectContaining({ text: answer })), { timeout: 8000 })
    expect(host.relays(bobWorker).some(relay => relay.text === answer)).toBe(false)

    await host.runTool(aliceWorker, 'orchestrator_report', { state: 'ready', summary: aliceResult, human_action: null })
    const finalAlice = await state(alice, aliceCookie), finalBob = await state(bob, bobCookie)
    expect(finalAlice.tasks).toEqual([expect.objectContaining({ id: aliceId, stage: 'ended', ended: 'completed', summary: aliceResult })])
    expect(finalAlice.tasks[0]?.question).toBeUndefined()
    expect(finalBob.tasks).toEqual([expect.objectContaining({ id: bobId, stage: 'ended', ended: 'completed', summary: bobResult })])
    expect((await http(alice, 'tasks', aliceCookie, 'POST', followup)).status).toBe(202)
    await host.runtime.idle()
    expect(await state(alice, aliceCookie)).toEqual(finalAlice)
    expect(host.relays(aliceWorker).filter(relay => relay.text === answer)).toHaveLength(1)
  } finally {
    await host.stop()
  }
}, 20_000)

it('recovers 100 private HTTP tickets for ten tenants with one worker and deduplicates replay', async () => {
  const memberIds = Array.from({ length: 10 }, (_, index) => `offline-member-${index + 1}`)
  const stateDir = mkdtempSync(join(tmpdir(), 'conest-offline-'))
  let host: Host | undefined
  try {
    host = await startPersonal(memberIds, stateDir)
    let api = personalHttp(host)
    type AcceptedTask = { id: string; request: { requestId: string; text: string }; summary: string }
    const members = await Promise.all(memberIds.map(async id => ({ id, cookie: await api.login(id), tasks: [] as AcceptedTask[] })))
    // Each tenant deliberately reuses the same ten request IDs with its own private content.
    for (let round = 1; round <= 10; round++) {
      for (const member of members) {
        const request = { requestId: `request-${round}`, text: `${member.id} 的私有工单 ${round}` }
        const id = await api.openTicket(member.id, member.cookie, request.requestId, request.text)
        member.tasks.push({ id, request, summary: `已完成 ${request.text}` })
      }
    }
    const accepted = new Map(members.flatMap(member => member.tasks.map(task => [task.id, task] as const)))
    expect(accepted.size).toBe(100)

    const visibleTasks = async () => (await Promise.all(members.map(async member => {
      const view = await api.state(member.id, member.cookie)
      expect(view.member.id).toBe(member.id)
      expect(view.total, `total for ${member.id}`).toBe(10)
      expect(view.tasks.map(task => [task.id, task.title]).sort()).toEqual(member.tasks.map(task => [task.id, task.request.text]).sort())
      return view.tasks
    }))).flat()
    const fullQueue = async (runtime: Host['runtime']) => {
      const tasks = await visibleTasks()
      const working = tasks.filter(task => task.stage === 'working')
      expect(working).toHaveLength(1)
      expect(runtime.executor.activeCount()).toBe(1)
      expect(tasks.filter(task => task.stage === 'queued')).toHaveLength(99)
      return working[0]!.id
    }
    const interrupted = await fullQueue(host.runtime)
    await host.stop()
    host = undefined
    host = await startRuntime(undefined, { portal: true, stateDir })
    api = personalHttp(host)
    await host.runtime.pump()
    await host.runtime.idle()
    await fullQueue(host.runtime) // Use the cookies issued before shutdown.
    expect(host.runtime.store.tickets.get(interrupted)?.assignments).toMatchObject([{ endedReason: 'hostRestarted' }, {}])

    const deliveriesBeforeReplay = host.deliveries.mock.calls.length
    await Promise.all(members.map(async (member, index) => {
      const foreign = members[(index + 1) % members.length]!
      const foreignTicket = foreign.tasks[0]!.id
      const foreignToken = foreign.cookie.slice(foreign.cookie.indexOf('=') + 1)
      const forgedCookie = `${member.cookie.split('=')[0]}=${foreignToken}`
      expect((await api.http(member.id, 'state', forgedCookie)).status).toBe(401)
      expect((await api.http(member.id, `tasks/${foreignTicket}/stop`, member.cookie, 'POST')).status).toBe(404)
      expect((await api.http(member.id, 'tasks', member.cookie, 'POST', { ...member.tasks[0]!.request, ticketId: foreignTicket })).status).toBe(404)
      for (const { request } of member.tasks) {
        expect((await api.http(member.id, 'tasks', member.cookie, 'POST', request)).status).toBe(202)
      }
    }))
    await host.runtime.idle()
    const replayDeliveries = host.deliveries.mock.calls.slice(deliveriesBeforeReplay)
    expect(replayDeliveries.some(([message]) => message.text.startsWith('{') && JSON.parse(message.text).kind === 'candidate')).toBe(false)
    await fullQueue(host.runtime)

    const completed = new Set<string>()
    for (let index = 0; index < accepted.size; index++) {
      const running = [...host.agents.values()].filter(agent => ticketOfSession(agent.id) !== undefined && agent.status === 'running')
      expect(running, `worker slot after ${index} completions`).toHaveLength(1)
      const worker = running[0]!.id, id = ticketOfSession(worker)!
      const task = accepted.get(id)
      expect(task, `accepted ticket ${id}`).toBeDefined()
      expect(completed.has(id)).toBe(false)
      const launch = host.deliveries.mock.calls.findLast(([message]) => message.sessionId === worker && message.mode === 'queue')?.[0]
      expect(launch, `assignment for ${id}`).toBeDefined()
      expect(JSON.parse(launch!.text)).toMatchObject({ ticket_id: id, trigger: { text: task!.request.text } })
      await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: task!.summary, human_action: null })
      completed.add(id)
      workerIdle(host, worker)
      await host.runtime.idle()
    }
    expect(host.runtime.executor.activeCount()).toBe(0)
    const final = await visibleTasks()
    for (const task of final) {
      expect(task).toMatchObject({ stage: 'ended', ended: 'completed', summary: accepted.get(task.id)!.summary })
    }
  } finally {
    try { await host?.stop() } finally { rmSync(stateDir, { recursive: true, force: true }) }
  }
}, 30_000)
