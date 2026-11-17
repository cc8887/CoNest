/** Test-only Source adapter: production Weixin mapping/polling/outbox, file-backed fake iLink transport. */
import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWeixinKind, runWeixin, WeixinClient } from '../../lib/weixin-watch.js'

export const name = 'conest-offline-weixin'
export const inject = ['orchestrator']
export function apply(ctx) {
  const root = process.env.CONEST_MOCK_ROOT
  if (!root) throw new Error('This test adapter requires a private CONEST_MOCK_ROOT')
  if (process.env.CONEST_MOCK_WEB_ENROLLMENT === '1') {
    let sequence = ctx.orchestrator.portal.list().length
    WeixinClient.prototype.qr = async () => { const index = sequence++; return { qrcode: `mock-qr-${index}`, url: `https://ilinkai.weixin.qq.com/mock/${index}` } }
    WeixinClient.prototype.loginStatus = async ticket => {
      const index = Number(ticket.replace('mock-qr-', ''))
      const approval = JSON.parse(readFileSync(join(root, 'binding-approvals.json'), 'utf8'))
      return approval.approved.includes(index) ? { status: 'confirmed', ilink_bot_id: `mock-bot-${index}`, ilink_user_id: `mock-user-${index}`,
        bot_token: `offline-token-${index}`, baseurl: 'https://ilinkai.weixin.qq.com/' } : { status: 'wait' }
    }
  }
  const client = {
    async updates(account, cursor) {
      const input = JSON.parse(readFileSync(join(root, 'incoming.json'), 'utf8'))
      const batch = input.accounts?.[account.id] ?? input
      if (!Array.isArray(batch.messages)) return { msgs: [], get_updates_buf: cursor }
      return { msgs: cursor === batch.cursor ? [] : batch.messages, get_updates_buf: batch.cursor }
    },
    async send(account, peer, context, clientId, text) {
      appendFileSync(join(root, 'sent.jsonl'), JSON.stringify({ account: account.id, peer, context, clientId, text }) + '\n', { mode: 0o600 })
    },
  }
  let source
  const kind = createWeixinKind(() => source, client)
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'offline: production Weixin kind')
  source = ctx.orchestrator.context(kind)
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runWeixin(source, client, controller.signal)
    return async () => { controller.abort(); await running }
  })
}
