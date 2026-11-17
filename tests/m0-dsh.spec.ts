/** Offline integration at the actual DSH loop/OpenAI transport seam; no live credentials or provider. */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { DshProbe } from '../src/m0/dsh.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })

async function fixture(reply: (response: ServerResponse, turn: number) => void) {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  let started!: () => void
  const received = new Promise<void>(resolve => { started = resolve })
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    requests.push({ url: req.url!, body: JSON.parse(raw) })
    started(); reply(res, requests.length)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test address')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const root = mkdtempSync(join(tmpdir(), 'conest-dsh-'))
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }) })
  const keyRef = `CONEST_OFFLINE_${address.port}`
  process.env[keyRef] = 'offline-test-key'
  cleanups.push(async () => { delete process.env[keyRef] })
  const runtime = await DshProbe.start({ baseURL: `http://127.0.0.1:${address.port}/v2/`, model: 'hy4', apiKeyEnv: keyRef }, root)
  cleanups.push(() => runtime.close())
  return { runtime, requests, received }
}

function stream(response: ServerResponse, turn: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (choice: object) => response.write(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', model: 'hy4',
    created: 1, choices: [{ index: 0, ...choice }] })}\n\n`)
  if (turn % 2 === 1) {
    send({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'conest_probe', arguments: '{"value":' } }] }, finish_reason: null })
    send({ delta: { tool_calls: [{ index: 0, function: { arguments: '"OK"}' } }] }, finish_reason: null })
    send({ delta: {}, finish_reason: 'tool_calls' })
  } else {
    send({ delta: { role: 'assistant', content: 'OK' }, finish_reason: null })
    send({ delta: {}, finish_reason: 'stop' })
  }
  response.end('data: [DONE]\n\n')
}

it('runs a real DSH tool turn, forwards its result and isolates the next inbound Session', async () => {
  const h = await fixture(stream)
  const first = await h.runtime.run('first-private-message')
  const second = await h.runtime.run('second-private-message')
  expect(first).toMatchObject({ text: 'OK', modelCalls: 2, toolCalls: 1 })
  expect(second.sessionId).not.toBe(first.sessionId)
  expect(h.requests.map(request => request.url)).toEqual(Array(4).fill('/v2/chat/completions'))
  expect(h.requests[0]!.body).toMatchObject({ model: 'hy4', stream: true, max_tokens: 2048 })
  expect(h.requests[1]!.body.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: '{"value":"OK"}' }),
  ]))
  expect(JSON.stringify(h.requests[2]!.body)).toContain('second-private-message')
  expect(JSON.stringify(h.requests[2]!.body)).not.toContain('first-private-message')
}, 15_000)

it('terminates an actual DSH request when the caller cancels a stalled stream', async () => {
  const h = await fixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders() })
  const controller = new AbortController()
  const turn = h.runtime.run('cancel test', controller.signal)
  const rejected = expect(turn).rejects.toMatchObject({ name: 'AbortError' })
  await h.received
  controller.abort()
  await rejected
  expect(h.requests).toHaveLength(1)
}, 15_000)

it('reports a provider rejection as failure rather than a successful empty answer', async () => {
  const h = await fixture(response => { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":{"message":"rejected","type":"authentication_error"}}') })
  await expect(h.runtime.run('error test')).rejects.toThrow('DSH turn did not complete')
  expect(h.requests).toHaveLength(1)
}, 15_000)
