import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeixinClient, WeixinError, type WeixinAccount, type WeixinMessage } from '../src/m0/weixin.ts'
import { M0State } from '../src/m0/state.ts'
import { deliverNext } from '../src/m0/bridge.ts'

const home: WeixinAccount = { id: 'bot-home', ownerId: 'peer-a', token: 'test-secret', baseURL: 'https://ilinkai.weixin.qq.com/' }
const other: WeixinAccount = { ...home, id: 'bot-work', ownerId: 'peer-b' }
const message = (overrides: Partial<WeixinMessage> = {}): WeixinMessage => ({ message_id: '1', from_user_id: home.ownerId,
  message_type: 1, message_state: 2, context_token: 'private-context', item_list: [{ type: 1, text_item: { text: 'test probe' } }], ...overrides })
const reply = { sessionId: 'dsh-session', text: 'OK', modelCalls: 2, toolCalls: 1, inputTokens: 10, outputTokens: 10 }
const opened: M0State[] = [], roots: string[] = []
function state() {
  const root = mkdtempSync(join(tmpdir(), 'conest-m0-')); roots.push(root)
  const store = new M0State(root); opened.push(store); store.saveAccount(home); return store
}
afterEach(() => { for (const store of opened.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('M0 Weixin transport', () => {
  it('preserves uint64 message ids from the wire and passes the account cursor through', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"from_user_id":"peer-a","message_type":1,"context_token":"ctx","item_list":[]}]}'))
    const client = new WeixinClient(fetcher)
    const batch = await client.updates(home, 'previous')
    expect(batch.msgs[0]!.message_id).toBe('18446744073709551615')
    expect(batch.get_updates_buf).toBe('next')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ get_updates_buf: 'previous' })
  })
  it('treats HTTP 200 with a nonzero business code as a send failure without exposing the body', async () => {
    const client = new WeixinClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":-2,"errmsg":"private-context test-secret"}')))
    await expect(client.send(home, home.ownerId, 'ctx', 'delivery-1', 'OK')).rejects.toThrow('Weixin /ilink/bot/sendmessage failed (-2)')
  })
  it('keeps the last durable cursor when an empty poll has no new cursor', async () => {
    const client = new WeixinClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":0,"msgs":[]}')))
    expect(await client.updates(home, 'last-cursor')).toMatchObject({ get_updates_buf: 'last-cursor', msgs: [] })
  })
  it('refuses a different recipient before transmitting credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(new WeixinClient(fetcher).send(home, other.ownerId, 'ctx', 'id', 'private reply')).rejects.toBeInstanceOf(WeixinError)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects an untrusted login redirect or confirmed account endpoint', () => {
    const client = new WeixinClient()
    expect(() => client.redirect('attacker.test')).toThrow()
    expect(() => client.account({ status: 'confirmed', ilink_bot_id: 'a', ilink_user_id: 'b', bot_token: 'secret', baseurl: 'https://attacker.test' })).toThrow()
  })
  it('passes shutdown cancellation into a hanging poll', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
    }))
    const controller = new AbortController()
    const polling = new WeixinClient(fetcher).updates(home, '', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(polling).rejects.toThrow('stopped')
  })
})

describe('M0 durable owner DM journal', () => {
  it('deduplicates replays, keeps account instances distinct and persists the cursor across reopen', () => {
    const store = state(); store.saveAccount(other)
    expect(store.ingest(home, 'cursor-1', [message(), message()])).toEqual({ added: 1, rejected: 0 })
    expect(store.ingest(other, 'work-cursor', [message({ from_user_id: other.ownerId })])).toEqual({ added: 1, rejected: 0 })
    store.close(); opened.splice(opened.indexOf(store), 1)
    const restored = new M0State(store.root); opened.push(restored)
    expect(restored.cursor(home.id)).toBe('cursor-1')
    expect(restored.cursor(other.id)).toBe('work-cursor')
    expect(restored.summary().messages).toHaveLength(2)
    expect(restored.ingest(home, 'cursor-2', [message()]).added).toBe(0)
    expect(statSync(join(store.root, 'transport.sqlite')).mode & 0o777).toBe(0o600)
  })
  it('rejects strangers, groups, partial messages and nontext content without queuing model input', () => {
    const store = state()
    expect(store.ingest(home, 'safe-cursor', [message({ from_user_id: 'stranger' }), message({ group_id: 'room' }),
      message({ message_state: 1 }), message({ item_list: [{ type: 2 }] }), message({ context_token: undefined })])).toEqual({ added: 0, rejected: 5 })
    expect(store.pending()).toBeUndefined()
    expect(store.cursor(home.id)).toBe('safe-cursor')
  })
  it('does not let reopening for status disrupt an active model turn', () => {
    const store = state(); store.ingest(home, 'cursor', [message()]); store.transition(store.pending()!.id, 'new', 'running')
    const reader = new M0State(store.root); opened.push(reader)
    expect(reader.summary().messages[0]!.status).toBe('running')
    reader.recover()
    expect(reader.summary().messages[0]!.status).toBe('interrupted')
    expect(reader.pending()).toBeUndefined()
  })
  it('refuses to reinterpret an existing bot as a different owner', () => {
    const store = state()
    expect(() => store.saveAccount({ ...home, ownerId: 'another-person' })).toThrow('Bot owner changed')
    expect(store.accounts()[0]!.ownerId).toBe(home.ownerId)
  })
})

describe('M0 message to DSH to original DM', () => {
  it('delivers one fresh input once and retains only its own context in the outgoing request', async () => {
    const store = state(); store.ingest(home, 'cursor', [message()])
    const model = { run: vi.fn().mockResolvedValue(reply) }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":0}'))
    const client = new WeixinClient(fetcher), signal = new AbortController().signal
    expect(await deliverNext(store, client, model, signal)).toBe(true)
    expect(model.run).toHaveBeenCalledWith('test probe', signal)
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1]!.body))
    expect(sent.msg).toMatchObject({ to_user_id: 'peer-a', context_token: 'private-context', item_list: [{ type: 1, text_item: { text: 'OK' } }] })
    expect(store.summary().messages[0]).toMatchObject({ status: 'sent', sessionId: reply.sessionId })
    store.ingest(home, 'new-cursor', [message()])
    expect(await deliverNext(store, client, model, signal)).toBe(false)
    expect(model.run).toHaveBeenCalledTimes(1)
  })
  it('resumes a saved reply after restart without another model call', async () => {
    const store = state(); store.ingest(home, 'cursor', [message()])
    const item = store.pending()!; store.transition(item.id, 'new', 'running')
    store.transition(item.id, 'running', 'ready', { reply: 'already generated', sessionId: 'durable-session' })
    store.close(); opened.splice(opened.indexOf(store), 1)
    const restored = new M0State(store.root); opened.push(restored); restored.recover()
    const model = { run: vi.fn() }
    const client = new WeixinClient(vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ret":0}')))
    await deliverNext(restored, client, model, new AbortController().signal)
    expect(model.run).not.toHaveBeenCalled()
    expect(restored.summary().messages[0]!.status).toBe('sent')
  })
  it('holds uncertain send results for inspection instead of replaying them', async () => {
    const store = state(); store.ingest(home, 'cursor', [message()])
    const model = { run: vi.fn().mockResolvedValue(reply) }
    const client = new WeixinClient(vi.fn<typeof fetch>().mockRejectedValue(new Error('socket reset')))
    await deliverNext(store, client, model, new AbortController().signal)
    expect(store.summary().messages[0]!.status).toBe('uncertain')
    expect(store.pending()).toBeUndefined()
  })
})
