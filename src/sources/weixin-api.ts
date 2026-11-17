/** Shared text-only iLink transport. Protocol reference and Tencent MIT notice: docs/conest/m0.md. */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

const text = z.string().min(1)
const serviceUrl = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (/^ilinkai\d*\.weixin\.qq\.com$/.test(url.hostname) || url.hostname.endsWith('.ilinkai.weixin.qq.com'))
    && url.pathname === '/' && !url.search && !url.hash
}, 'Untrusted iLink service URL')
export const AccountSchema = z.object({ id: text, ownerId: text, token: text, baseURL: serviceUrl })
export type WeixinAccount = z.infer<typeof AccountSchema>
const statusSchema = z.object({ status: text, bot_token: z.string().optional(), ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().optional(), baseurl: z.string().optional(), redirect_host: z.string().optional() })
export type LoginStatus = z.infer<typeof statusSchema>
const id = z.union([z.string().min(1), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)])
const messageSchema = z.object({ message_id: id, from_user_id: text, to_user_id: z.string().optional(),
  message_type: z.number(), message_state: z.number().optional(), group_id: z.string().optional(),
  context_token: z.string().optional(), item_list: z.array(z.object({ type: z.number(), text_item: z.object({ text: z.string() }).optional() })).default([]) })
export type WeixinMessage = z.infer<typeof messageSchema>
const updatesSchema = z.object({ msgs: z.array(messageSchema).default([]), get_updates_buf: z.string().optional(), longpolling_timeout_ms: z.number().optional() })

/** Sanitized transport/business failure: never retains server bodies, tokens, PINs or private messages. */
export class WeixinError extends Error {
  constructor(readonly operation: string, readonly code: number | string) { super(`Weixin ${operation} failed (${code})`); this.name = 'WeixinError' }
}

/** JSON number ids are preserved from their wire spelling before IEEE-754 conversion can destroy them. */
function parseResponse(raw: string): unknown {
  return JSON.parse(raw, (key: string, value: unknown, context?: { source: string }) => {
    if (key === 'message_id' && typeof value === 'number') {
      if (context?.source && /^\d+$/.test(context.source)) return context.source
      if (!Number.isSafeInteger(value)) throw new WeixinError('decode', 'unsafe_message_id')
      return String(value)
    }
    return value
  })
}

/** Bound iLink account transport with fixed-origin login, validated redirects and cancellable HTTP requests. */
export class WeixinClient {
  static readonly origin = 'https://ilinkai.weixin.qq.com'
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(baseURL: string, path: string, body: object | undefined, token: string | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = new URL(path, serviceUrl.parse(baseURL))
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '196608' }
    if (body) {
      headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token'
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const timeout = AbortSignal.timeout(40_000)
    const response = await this.fetcher(url, { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
    // Do not log bodies or URLs: they can contain bot tokens, QR tickets and PINs.
    if (!response.ok) throw new WeixinError(path.split('?')[0]!, response.status)
    const raw = await response.text()
    if (raw.length > 2_000_000) throw new WeixinError('decode', 'response_too_large')
    const result = z.record(z.string(), z.unknown()).parse(parseResponse(raw))
    for (const field of ['ret', 'errcode']) if (typeof result[field] === 'number' && result[field] !== 0) throw new WeixinError(path.split('?')[0]!, result[field])
    return result
  }

  async qr(tokens: readonly string[] = [], signal?: AbortSignal): Promise<{ qrcode: string; url: string }> {
    const result = await this.request(WeixinClient.origin, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: tokens.slice(-10) }, undefined, signal)
    const parsed = z.object({ qrcode: text, qrcode_img_content: text }).parse(result)
    const url = new URL(parsed.qrcode_img_content)
    if (url.protocol !== 'https:' || url.username || url.password) throw new WeixinError('login', 'invalid_qr_url')
    return { qrcode: parsed.qrcode, url: url.href }
  }

  async loginStatus(qrcode: string, baseURL = WeixinClient.origin, pin?: string, signal?: AbortSignal): Promise<LoginStatus> {
    const query = new URLSearchParams({ qrcode, ...(pin ? { verify_code: pin } : {}) })
    return statusSchema.parse(await this.request(baseURL, `/ilink/bot/get_qrcode_status?${query}`, undefined, undefined, signal))
  }

  redirect(host: string): string { return serviceUrl.parse(`https://${host}/`) }
  account(status: LoginStatus): WeixinAccount {
    return AccountSchema.parse({ id: status.ilink_bot_id, ownerId: status.ilink_user_id, token: status.bot_token,
      baseURL: new URL(status.baseurl || WeixinClient.origin).href })
  }

  async updates(account: WeixinAccount, cursor: string, signal?: AbortSignal): Promise<{ msgs: WeixinMessage[]; get_updates_buf: string }> {
    const result = updatesSchema.parse(await this.request(account.baseURL, '/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: this.baseInfo() }, account.token, signal))
    return { ...result, get_updates_buf: result.get_updates_buf || cursor }
  }

  async send(account: WeixinAccount, peer: string, contextToken: string, clientId: string, content: string, signal?: AbortSignal): Promise<void> {
    if (peer !== account.ownerId || !contextToken) throw new WeixinError('send', 'unauthorized_peer_or_missing_context')
    await this.request(account.baseURL, '/ilink/bot/sendmessage', { base_info: this.baseInfo(), msg: {
      from_user_id: '', to_user_id: peer, client_id: clientId, message_type: 2, message_state: 2,
      context_token: contextToken, item_list: [{ type: 1, text_item: { text: content } }],
    } }, account.token, signal)
  }

  private baseInfo() { return { channel_version: '3.0.0/conest-0.1.0', bot_agent: 'CoNest/0.1.0 (iLink-3.0.0)' } }
}
