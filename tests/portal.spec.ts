/** Registration, QR confirmation and tenant operations over actual HTTP; only the Weixin provider and model driving are mocked. */
import { afterEach, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime, type Host } from './fixtures/host.ts'
import { waitUntil } from './fixtures/async.ts'
import { WeixinClient } from '../src/sources/weixin-api.ts'
import { KV } from '../src/kv.ts'
import { personalTrigger } from '../src/sources/personal.ts'
import { PortalServer } from '../src/app/portal-http.ts'
import { Portal } from '../src/app/portal.ts'
import type { PersonalSpace } from '../src/app/portal-types.ts'

let h: Host | undefined
afterEach(async () => { if (h) await h.stop(); h = undefined })

async function fixture() {
  let qrCount = 0
  const states = new Map<number, string>(), override = new Map<number, number>(), pins: string[] = []
  const client = new WeixinClient(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/get_bot_qrcode')) {
      const number = ++qrCount; states.set(number, 'wait')
      return new Response(JSON.stringify({ qrcode: `private-qr-ticket-${number}`, qrcode_img_content: `https://ilinkai.weixin.qq.com/fixture/${number}` }))
    }
    if (url.pathname.endsWith('/get_qrcode_status')) {
      const number = Number(url.searchParams.get('qrcode')!.replace('private-qr-ticket-', '')), pin = url.searchParams.get('verify_code')
      if (pin) pins.push(pin)
      const state = states.get(number), owner = override.get(number) ?? number
      return new Response(JSON.stringify(state === 'confirmed' || state === 'need_verifycode' && pin === '765432'
        ? { status: 'confirmed', ilink_bot_id: `web-bot-${owner}`, ilink_user_id: `web-owner-${owner}`, bot_token: `private-bot-secret-${owner}`, baseurl: 'https://ilinkai.weixin.qq.com/' }
        : { status: state }))
    }
    throw new Error('Unexpected provider operation')
  })
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { github: { enabled: false, config: {} }, feishu: { enabled: false, config: {} },
      weixin: { enabled: true, config: { members: [], accounts: [] } } }, executor: { ...settings.executor, maxWorkers: 1 } })
  }, { portal: true, weixin: client })
  const origin = h.runtime.portalServer!.origin!
  const create = async (name: string) => {
    const response = await h!.registration('POST', 'api/members', { displayName: name })
    expect(response.status).toBe(201)
    const member = response.body.member as PersonalSpace
    await waitUntil(() => !!h!.runtime.portal.view(member.id).binding?.qr)
    return { member, invite: new URL(response.body.inviteUrl as string).hash.slice('#invite='.length), url: response.body.inviteUrl as string }
  }
  const call = async (id: string, path: string, method = 'GET', body?: unknown, cookie = '', extra: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/t/${id}/api/${path}`, { method, headers: { 'x-conest-request': '1', origin, cookie,
      ...body === undefined ? {} : { 'content-type': 'application/json' }, ...extra }, ...body === undefined ? {} : { body: JSON.stringify(body) } })
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> }
  }
  const login = async (id: string, invite: string) => {
    const response = await call(id, 'exchange', 'POST', { invite })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  const route = async (id: string, requestId: string, text: string) => {
    await h!.runtime.idle()
    const router = h!.runtime.store.get(KV.members.session(id))!
    const result = await h!.runTool(router, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: personalTrigger(id, requestId, text).id,
      title: text, worktree_name: 'private-web-task', acknowledgement: '已接单。' }] })
    await h!.runtime.idle()
    return (result.results as { ticket: { ticket_id: string } }[])[0]!.ticket.ticket_id
  }
  return { create, call, login, route, states, override, pins, origin, client }
}

it('creates a personal tenant, shows its QR and automatically commits credentials, identity binding and the allowlist on confirmation', async () => {
  const f = await fixture(), { member } = await f.create('小林')
  const before = await h!.registration('GET', `api/members/${member.id}`)
  expect(before.body.binding.qr).toMatch(/^data:image\/png;base64,/)
  expect(JSON.stringify(before.body)).not.toContain('private-qr-ticket')
  expect(h!.runtime.store.settings().policy.sources.weixin?.allowed ?? []).toHaveLength(0)
  f.states.set(1, 'confirmed')
  await waitUntil(() => h!.runtime.portal.view(member.id).bound)
  const config = h!.runtime.store.settings().sources.weixin!.config
  const account = (config.accounts as { memberId: string; accountId: string; ownerId: string; credentialsFile: string }[])[0]!
  expect(account).toMatchObject({ memberId: member.id, accountId: 'web-bot-1', ownerId: 'web-owner-1' })
  expect(account.credentialsFile.startsWith(join(h!.directory, 'weixin-accounts/'))).toBe(true)
  expect(statSync(account.credentialsFile).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(account.credentialsFile, 'utf8')).token).toBe('private-bot-secret-1')
  expect(h!.runtime.store.settings().policy.sources.weixin!.allowed).toContainEqual({ id: '["web-bot-1","web-owner-1"]', name: '小林' })
  const after = await h!.registration('GET', 'api/members')
  expect(JSON.stringify(after.body)).not.toMatch(/private-bot-secret|private-qr-ticket|credentialsFile|weixin-accounts/)
  expect(h!.runtime.store.get(KV.portal.binding(member.id))?.ticket).toBeUndefined()
})

it('uses one-time tenant login, denies cross-tenant cookies and operator routes, and stops sessions immediately on suspension', async () => {
  const f = await fixture(), a = await f.create('Alice'), b = await f.create('Bob')
  const cookieA = await f.login(a.member.id, a.invite), cookieB = await f.login(b.member.id, b.invite)
  expect((await f.call(a.member.id, 'state', 'GET', undefined, cookieA)).body.member.displayName).toBe('Alice')
  expect((await f.call(b.member.id, 'state', 'GET', undefined, cookieA)).status).toBe(401)
  expect((await f.call(a.member.id, 'exchange', 'POST', { invite: a.invite })).status).toBe(401)
  expect((await f.call(a.member.id, 'state', 'GET', undefined, cookieA, { origin: 'https://evil.example' })).status).toBe(403)
  expect((await h!.registration('GET', 'api/members', undefined, { authorization: '', cookie: cookieA })).status).toBe(401)
  expect((await h!.registration('POST', 'api/members', { displayName: 'unauthorized' }, { origin: f.origin })).status).toBe(403)
  expect((await fetch(`${f.origin}/orchestrator/api/settings`, { headers: { cookie: cookieA, 'x-orchestrator-request': '1' } })).status).toBe(404)
  await h!.registration('POST', `api/members/${a.member.id}/status`, { status: 'disabled' })
  expect((await f.call(a.member.id, 'state', 'GET', undefined, cookieA)).status).toBe(401)
  expect((await f.call(b.member.id, 'state', 'GET', undefined, cookieB)).status).toBe(200)
  await h!.registration('POST', `api/members/${a.member.id}/status`, { status: 'active' })
  expect((await f.call(a.member.id, 'state', 'GET', undefined, cookieA)).status).toBe(401)
})

it('handles PIN and QR refresh in the page, rejects stale PINs, and never assigns an already-owned Weixin account to another tenant', async () => {
  const f = await fixture(), a = await f.create('Alice')
  f.states.set(1, 'need_verifycode')
  await waitUntil(() => h!.runtime.portal.view(a.member.id).binding?.phase === 'needs_pin')
  const attempt = h!.runtime.portal.view(a.member.id).binding!.id
  expect((await h!.registration('POST', `api/members/${a.member.id}/pin`, { attempt: 'wrong-attempt', pin: '765432' })).status).toBe(409)
  expect((await h!.registration('POST', `api/members/${a.member.id}/pin`, { attempt, pin: '765432' })).status).toBe(200)
  await waitUntil(() => h!.runtime.portal.view(a.member.id).bound)
  expect(f.pins).toContain('765432')
  expect(JSON.stringify(h!.runtime.store.keys(KV.portal.binding).map(key => h!.runtime.store.get(key)))).not.toContain('765432')
  const b = await f.create('Bob'); f.override.set(2, 1); f.states.set(2, 'confirmed')
  await waitUntil(() => h!.runtime.portal.view(b.member.id).binding?.phase === 'failed')
  expect(h!.runtime.portal.view(b.member.id).bound).toBe(false)
  expect(h!.runtime.store.settings().policy.sources.weixin!.allowed).toHaveLength(1)
  await h!.registration('POST', `api/members/${b.member.id}/binding`)
  await waitUntil(() => !!h!.runtime.portal.view(b.member.id).binding?.qr)
  const previousQr = h!.runtime.portal.view(b.member.id).binding!.id
  f.states.set(3, 'expired')
  await waitUntil(() => h!.runtime.store.get(KV.portal.binding(b.member.id))?.refreshes === 1)
  await waitUntil(() => f.states.has(4)); f.states.set(4, 'need_verifycode')
  await waitUntil(() => h!.runtime.portal.view(b.member.id).binding?.phase === 'needs_pin')
  const refreshed = h!.runtime.portal.view(b.member.id).binding!.id
  expect(refreshed).not.toBe(previousQr)
  expect((await h!.registration('POST', `api/members/${b.member.id}/pin`, { attempt: previousQr, pin: '765432' })).status).toBe(409)
  expect((await h!.registration('POST', `api/members/${b.member.id}/pin`, { attempt: refreshed, pin: '765432' })).status).toBe(200)
  await waitUntil(() => h!.runtime.portal.view(b.member.id).bound)
})

it('keeps web-created work, reports, followups and task actions scoped to the authenticated personal space', async () => {
  const f = await fixture(), a = await f.create('Alice'), b = await f.create('Bob')
  const cookieA = await f.login(a.member.id, a.invite), cookieB = await f.login(b.member.id, b.invite)
  expect((await f.call(a.member.id, 'tasks', 'POST', { requestId: 'alice-first', text: 'ALICE_PRIVATE_TASK' }, cookieA)).status).toBe(202)
  const ticket = await f.route(a.member.id, 'alice-first', 'ALICE_PRIVATE_TASK')
  await h!.runTool(`worker-${ticket}`, 'orchestrator_report', { state: 'progress', summary: 'ALICE_PRIVATE_PROGRESS', human_action: 'ALICE_PRIVATE_QUESTION' })
  const own = await f.call(a.member.id, 'state', 'GET', undefined, cookieA), other = await f.call(b.member.id, 'state', 'GET', undefined, cookieB)
  expect(own.body.tasks[0]).toMatchObject({ id: ticket, question: 'ALICE_PRIVATE_QUESTION' })
  expect(other.body.tasks).toHaveLength(0)
  expect(JSON.stringify(other.body)).not.toContain('ALICE_PRIVATE')
  expect((await f.call(b.member.id, `tasks/${ticket}/stop`, 'POST', undefined, cookieB)).status).toBe(404)
  expect((await f.call(b.member.id, 'tasks', 'POST', { requestId: 'foreign-followup', text: 'leak', ticketId: ticket }, cookieB)).status).toBe(404)
  expect((await f.call(a.member.id, 'tasks', 'POST', { requestId: 'alice-followup', text: 'ALICE_PRIVATE_ANSWER', ticketId: ticket }, cookieA)).status).toBe(202)
  await h!.runtime.idle()
  expect(h!.runtime.store.tickets.get(ticket)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === personalTrigger(a.member.id, 'alice-followup', '').id)).toBe(true)
  await h!.runTool(`worker-${ticket}`, 'orchestrator_report', { state: 'ready', summary: 'ALICE_PRIVATE_RESULT', human_action: null })
  await h!.runtime.idle()
  await h!.runTool(h!.runtime.store.get(KV.members.session(a.member.id))!, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket, text: 'ALICE_PRIVATE_RESULT' })
  expect((await f.call(a.member.id, 'state', 'GET', undefined, cookieA)).body.tasks[0].summary).toBe('ALICE_PRIVATE_RESULT')
  expect(JSON.stringify((await f.call(b.member.id, 'state', 'GET', undefined, cookieB)).body)).not.toContain('ALICE_PRIVATE')
})

it('does not expose the tenant interface through wildcard or plaintext network listeners', async () => {
  await fixture()
  for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0']) {
    const server = new PortalServer(h!.runtime.portal, { host, port: 0 })
    await expect(server.start()).rejects.toThrow('concrete')
  }
  await expect(new PortalServer(h!.runtime.portal, { host: '192.0.2.1', port: 0 }).start()).rejects.toThrow('TLS')
})

it('resumes a pending QR from the Store and does not enroll a member suspended before confirmation', async () => {
  const f = await fixture(), a = await f.create('Alice'), b = await f.create('Bob'), runtime = h!.runtime
  const attempt = runtime.portal.view(a.member.id).binding!.id
  await runtime.portal.stop()
  const resumed = new Portal({ store: runtime.store, members: runtime.members, settings: runtime.settings, stateDir: h!.directory,
    lifetime: new AbortController().signal, engine: runtime.engine, receive: trigger => runtime.receive(trigger), requestPass: () => runtime.passes.request() }, f.client, { pollMs: 10 })
  try {
    resumed.resume()
    expect(resumed.view(a.member.id).binding!.id).toBe(attempt)
    resumed.status(b.member.id, 'disabled')
    f.states.set(1, 'confirmed'); f.states.set(2, 'confirmed')
    await waitUntil(() => resumed.view(a.member.id).bound)
    expect(resumed.view(b.member.id)).toMatchObject({ bound: false, status: 'disabled', binding: { phase: 'cancelled' } })
    expect(runtime.store.settings().policy.sources.weixin!.allowed).toHaveLength(1)
  } finally { await resumed.stop() }
})
