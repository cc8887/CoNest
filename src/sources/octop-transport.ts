/** Private child-process protocol between the QQ Source and the Octop Gateway adapter. */
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { Writable } from 'node:stream'
import { z } from 'zod'

const id = z.string().min(1).max(1024)
const scope = z.enum(['dm', 'group'])
const frames = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), accountId: id }),
  z.strictObject({ type: z.literal('message'), accountId: id, scope, senderId: id,
    senderKind: z.enum(['user', 'bot', 'unknown']), conversationId: id, messageId: id,
    eventType: z.enum(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']),
    at: z.iso.datetime({ offset: true }), text: z.string().max(16_000), mentioned: z.boolean(),
    mentions: z.array(z.strictObject({ id, isBot: z.boolean(), isSelf: z.boolean() })).max(128),
    messageIndex: id.optional(), referenceId: id.optional(), replyToBot: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('sent'), id, messageId: id.optional(), replyIndex: id.optional() }),
  z.strictObject({ type: z.literal('failed'), id, retryable: z.boolean(), uncertain: z.boolean().optional() }),
])
type Frame = z.infer<typeof frames>
export type OctopMessage = Extract<Frame, { type: 'message' }>
export interface OctopSend {
  type: 'send'
  id: string
  accountId: string
  scope: 'dm' | 'group'
  conversationId: string
  messageId: string
  messageIndex?: string
  text: string
  sequence: number
}
export type OctopDelivery =
  | { status: 'sent'; replyIndex?: string }
  | { status: 'retry'; dispatched: boolean }
  | { status: 'gone' }
  | { status: 'uncertain' }
export interface OctopTransportOptions {
  python: string
  script: string
  credentialsFile: string
  accountId: string
  /** Explicit additional transport environment. Other application credentials are not inherited. */
  env?: NodeJS.ProcessEnv
}
export type QqTransport = Pick<OctopTransport, 'run' | 'send'>
export type QqTransportFactory = (accountId: string) => QqTransport

const MAX_FRAME_BYTES = 128 * 1024
const MAX_INBOUND_QUEUE = 128
const MAX_PENDING_SENDS = 64
const READY_TIMEOUT = 30_000
// Let the Python bridge report its own result after its 18-second dispatch deadline.
const SEND_TIMEOUT = 22_000
const EXIT_GRACE = 2000
const decoder = new TextDecoder('utf-8', { fatal: true })
const childEnv = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SSL_CERT_FILE', 'SSL_CERT_DIR']

/** Owns one active Octop process and correlates outbound results independently of incoming message handling. */
export class OctopTransport {
  private running = false
  private writer: Writable | undefined
  private readonly pending = new Map<string, { frame: string; result: Promise<OctopDelivery>; finish: (value: OctopDelivery) => void }>()

  constructor(private readonly options: OctopTransportOptions) {
    if (![options.python, options.script, options.credentialsFile].every(isAbsolute)) {
      throw new Error('Octop interpreter, bridge script and credential file require absolute paths')
    }
  }

  /** Start one process. A stopped run can be restarted with a new signal by the caller. */
  async run(signal: AbortSignal, onMessage: (message: OctopMessage) => void | Promise<void>, onReady?: () => void): Promise<void> {
    if (this.running) throw new Error('Octop bridge is already running')
    if (signal.aborted) return
    const { python, script, credentialsFile, accountId, env } = this.options
    const child = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { ...Object.fromEntries(childEnv.map(name => [name, process.env[name]])), ...env,
        CONEST_QQ_APP_ID: accountId, CONEST_QQ_CREDENTIALS_FILE: credentialsFile },
    })
    this.running = true
    let stopped = false, closed = false, failure: Error | undefined
    let forceExit: ReturnType<typeof setTimeout> | undefined
    let buffer: Buffer = Buffer.alloc(0)
    let queued = 0, inbox = Promise.resolve()
    const stop = () => {
      if (stopped) return
      stopped = true
      this.writer = undefined
      for (const request of this.pending.values()) request.finish({ status: 'uncertain' })
      if (closed) return
      child.stdin.end()
      forceExit = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE)
    }
    const fail = (detail: string) => {
      if (stopped) return
      failure = new Error(detail)
      stop()
    }
    const handshake = setTimeout(() => fail('Octop bridge did not become ready'), READY_TIMEOUT)
    const accept = (frame: Frame) => {
      if (frame.type === 'ready') {
        if (frame.accountId !== accountId || this.writer) throw new Error('Unexpected Octop handshake')
        this.writer = child.stdin
        clearTimeout(handshake)
        onReady?.()
      } else if (!this.writer) {
        throw new Error('Octop frame before handshake')
      } else if (frame.type === 'message') {
        if (frame.accountId !== accountId || queued >= MAX_INBOUND_QUEUE) throw new Error('Invalid Octop input')
        queued++
        inbox = inbox.then(async () => { if (!stopped) await onMessage(frame) })
          .catch(() => fail('Octop message handling failed')).finally(() => { queued-- })
      } else {
        const request = this.pending.get(frame.id)
        if (!request) return
        if (frame.type === 'sent') request.finish({ status: 'sent', ...(frame.replyIndex ? { replyIndex: frame.replyIndex } : {}) })
        else if (frame.uncertain) request.finish({ status: 'uncertain' })
        else if (frame.retryable) request.finish({ status: 'retry', dispatched: true })
        else request.finish({ status: 'gone' })
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      try {
        const data = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        let start = 0, newline = data.indexOf(10)
        while (newline >= 0 && !stopped) {
          if (newline - start > MAX_FRAME_BYTES) throw new Error('Oversized Octop frame')
          const json: unknown = JSON.parse(decoder.decode(data.subarray(start, newline)))
          accept(frames.parse(json))
          start = newline + 1
          newline = data.indexOf(10, start)
        }
        if (data.length - start > MAX_FRAME_BYTES) throw new Error('Oversized Octop frame')
        buffer = data.subarray(start)
      } catch {
        fail('Octop bridge sent an invalid protocol frame')
      }
    })
    child.stdout.on('error', () => fail('Octop bridge output closed'))
    child.stdin.on('error', () => fail('Octop bridge input closed'))
    child.on('error', () => fail('Octop bridge process failed to start or stop'))
    signal.addEventListener('abort', stop, { once: true })
    try {
      await new Promise<void>(resolve => child.once('close', () => {
        closed = true
        if (!stopped) fail('Octop bridge exited')
        resolve()
      }))
      await inbox
      if (failure && !signal.aborted) throw failure
    } finally {
      clearTimeout(handshake)
      clearTimeout(forceExit)
      signal.removeEventListener('abort', stop)
      stop()
      this.running = false
    }
  }

  /** An unacknowledged write may have delivered. Only explicit provider rejection or no dispatch is safe to retry. */
  send(request: Omit<OctopSend, 'type'>): Promise<OctopDelivery> {
    const { writer } = this
    if (request.accountId !== this.options.accountId) return Promise.resolve({ status: 'gone' })
    if (!writer?.writable) return Promise.resolve({ status: 'retry', dispatched: false })
    const frame = JSON.stringify({ ...request, type: 'send' }) + '\n'
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) return Promise.resolve({ status: 'gone' })
    const previous = this.pending.get(request.id)
    if (previous) return previous.frame === frame ? previous.result : Promise.resolve({ status: 'uncertain' })
    if (this.pending.size >= MAX_PENDING_SENDS) return Promise.resolve({ status: 'retry', dispatched: false })
    const { promise, resolve } = Promise.withResolvers<OctopDelivery>()
    const finish = (value: OctopDelivery) => {
      if (this.pending.get(request.id)?.finish !== finish) return
      clearTimeout(timeout)
      this.pending.delete(request.id)
      resolve(value)
    }
    const timeout = setTimeout(() => finish({ status: 'uncertain' }), SEND_TIMEOUT)
    this.pending.set(request.id, { frame, result: promise, finish })
    try {
      writer.write(frame, error => { if (error) finish({ status: 'uncertain' }) })
    } catch {
      finish({ status: 'uncertain' })
    }
    return promise
  }
}
