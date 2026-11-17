/** Polls authenticated private conversations and serializes them through the real DSH probe. */
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import type { DshProbe } from './dsh.ts'
import { M0State } from './state.ts'
import { WeixinClient, WeixinError } from './weixin.ts'

export async function deliverNext(state: M0State, client: WeixinClient, model: Pick<DshProbe, 'run'>, signal: AbortSignal): Promise<boolean> {
  const message = state.pending()
  if (!message) return false
  const account = state.accounts().find(item => item.id === message.accountId)
  if (!account || account.ownerId !== message.peer) throw new Error('M0 message is no longer authorized')
  if (message.status === 'new') {
    state.transition(message.id, 'new', 'running')
    try {
      const result = await model.run(message.text, signal)
      state.transition(message.id, 'running', 'ready', { reply: result.text, sessionId: result.sessionId })
      message.reply = result.text
    } catch (error) {
      state.transition(message.id, 'running', 'interrupted', undefined, 'DSH model turn failed or was cancelled; inspect local Session')
      if (signal.aborted) throw error
      return true
    }
  }
  signal.throwIfAborted()
  const clientId = `conest-m0-${createHash('sha256').update(JSON.stringify([message.accountId, message.messageId])).digest('hex').slice(0,32)}`
  state.transition(message.id, 'ready', 'sending')
  try {
    await client.send(account, message.peer, message.contextToken, clientId, message.reply!, signal)
    state.transition(message.id, 'sending', 'sent')
  } catch (error) {
    state.transition(message.id, 'sending', 'uncertain', undefined, error instanceof WeixinError ? error.message : 'Send interrupted; check delivery before retry')
    if (signal.aborted) throw error
  }
  return true
}

export async function runBridge(state: M0State, client: WeixinClient, model: Pick<DshProbe, 'run'>, signal: AbortSignal,
  report: (event: string, details?: object) => void): Promise<void> {
  const accounts = state.accounts()
  if (!accounts.length) throw new Error('No Weixin account: run pnpm m0 login first')
  const controller = new AbortController()
  signal = AbortSignal.any([signal, controller.signal])
  const pollers = accounts.map(account => (async () => {
    let failures = 0
    while (!signal.aborted) {
      try {
        const batch = await client.updates(account, state.cursor(account.id), signal)
        const ingested = state.ingest(account, batch.get_updates_buf, batch.msgs)
        failures = 0
        if (batch.msgs.length) report('received', ingested)
        // Empty immediate polls must not turn into a busy loop.
        if (!batch.msgs.length) await delay(250, undefined, { signal })
      } catch (error) {
        if (signal.aborted) return
        report('poll-error', { code: error instanceof WeixinError ? error.code : 'network_or_decode', failures: ++failures })
        if (error instanceof WeixinError && [-14, 401, 403].includes(Number(error.code))) { report('reauthorization-required'); return }
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal }).catch(() => {})
      }
    }
  })())
  const worker = (async () => {
    while (!signal.aborted) {
      try {
        if (await deliverNext(state, client, model, signal)) report('delivery-settled')
        else await delay(300, undefined, { signal })
      }
      catch (error) { if (signal.aborted) return; throw error }
    }
  })()
  try { await Promise.all([...pollers, worker]) }
  finally { controller.abort(); await Promise.allSettled([...pollers, worker]) }
}
