import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OctopTransport, type OctopDelivery, type OctopMessage } from '../src/sources/octop-transport.ts'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllEnvs() })
const accountId = '100200300'
const request = { id: 'receipt', accountId, scope: 'group' as const, conversationId: 'group-1',
  messageId: 'msg-1', text: '收到', sequence: 1 }
const message: OctopMessage = { type: 'message', accountId, scope: 'group', eventType: 'GROUP_MESSAGE_CREATE',
  conversationId: 'group-1', senderId: 'member-1', senderKind: 'user', messageId: 'msg-1',
  at: '2026-11-21T00:00:00Z', text: '继续整理', mentioned: false, mentions: [] }

function transportFor(script: string): OctopTransport {
  const directory = mkdtempSync(join(tmpdir(), 'conest-octop-ipc-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const stub = join(directory, 'interpreter.cjs')
  writeFileSync(stub, '#!' + process.execPath + '\n' + script, { mode: 0o700 })
  return new OctopTransport({ python: stub, script: join(directory, 'bridge.py'),
    credentialsFile: join(directory, 'credentials.json'), accountId })
}
const readyLine = "console.log(JSON.stringify({ type: 'ready', accountId: process.env.CONEST_QQ_APP_ID }))"

it('keeps UTF-8 native QQ frames intact and settles deliveries while the inbound callback waits', async () => {
  vi.stubEnv('CONEST_OCTOP_FIXTURE_MODEL_SECRET', 'model-only')
  const transport = transportFor(`
    if (process.env.CONEST_OCTOP_FIXTURE_MODEL_SECRET) process.exit(1)
    if (!process.env.CONEST_QQ_CREDENTIALS_FILE.endsWith('credentials.json')) process.exit(1)
    ${readyLine}
    const frame = Buffer.from(${JSON.stringify(JSON.stringify(message) + '\n')})
    const split = frame.indexOf(Buffer.from('继')) + 1
    process.stdout.write(frame.subarray(0, split))
    setTimeout(() => process.stdout.write(frame.subarray(split)), 20)
    const incoming = require('node:readline').createInterface({ input: process.stdin })
    incoming.on('line', line => {
      const msg = JSON.parse(line)
      if (msg.type !== 'send' || msg.sequence !== 1 || msg.text !== '收到') process.exit(1)
      console.log(JSON.stringify({type: 'sent', id: msg.id, replyIndex: 'QQ-reference-1'}))
    })
  `)
  expect(await transport.send(request)).toEqual({ status: 'retry', dispatched: false })
  const handled = Promise.withResolvers<{ received: OctopMessage; delivery: OctopDelivery; dedup: boolean }>()
  const stopped = new AbortController()
  const running = transport.run(AbortSignal.any([stopped.signal, AbortSignal.timeout(3000)]), async received => {
    const first = transport.send(request)
    const second = transport.send(request)
    handled.resolve({ received, delivery: await first, dedup: first === second })
  })
  try {
    await expect(Promise.race([handled.promise, running])).resolves.toEqual({ received: message, dedup: true,
      delivery: { status: 'sent', replyIndex: 'QQ-reference-1' } })
  } finally {
    stopped.abort()
    await running
  }
})

it('classifies definitive rejects and never reports an unresolved write as safe to retry', async () => {
  const transport = transportFor(`
    ${readyLine}
    const incoming = require('node:readline').createInterface({ input: process.stdin })
    incoming.on('line', line => {
      const msg = JSON.parse(line)
      if (msg.id === 'exit') process.exit(1)
      console.log(JSON.stringify({type: 'failed', id: msg.id, retryable: msg.id === 'retry',
        uncertain: msg.id === 'uncertain' }))
    })
  `)
  const stopped = new AbortController()
  const ready = Promise.withResolvers<void>()
  const running = transport.run(AbortSignal.any([stopped.signal, AbortSignal.timeout(3000)]), () => {}, ready.resolve)
  const exited = running.then(() => undefined, error => error)
  try {
    await Promise.race([ready.promise, running])
    expect(await transport.send({ ...request, accountId: 'other' })).toEqual({ status: 'gone' })
    expect(await transport.send({ ...request, id: 'retry' })).toEqual({ status: 'retry', dispatched: true })
    expect(await transport.send({ ...request, id: 'gone' })).toEqual({ status: 'gone' })
    expect(await transport.send({ ...request, id: 'uncertain' })).toEqual({ status: 'uncertain' })
    expect(await transport.send({ ...request, id: 'exit' })).toEqual({ status: 'uncertain' })
    expect(await exited).toMatchObject({ message: 'Octop bridge exited' })
    expect(await transport.send(request)).toEqual({ status: 'retry', dispatched: false })
  } finally {
    stopped.abort()
    await exited
  }
})

it.each([
  "console.log(JSON.stringify({ type: 'ready', accountId: 'wrong' }))",
  readyLine + "\nprocess.stdout.write('x'.repeat(129 * 1024))",
])('rejects the bridge on a malformed or oversized frame', async script => {
  const transport = transportFor(script + '\nprocess.stdin.resume()')
  const stopped = new AbortController()
  const received = vi.fn()
  try {
    await expect(transport.run(AbortSignal.any([stopped.signal, AbortSignal.timeout(3000)]), received))
      .rejects.toThrow('invalid protocol frame')
    expect(received).not.toHaveBeenCalled()
  } finally { stopped.abort() }
})
