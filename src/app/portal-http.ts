/** Independent personal-origin HTTP server and authenticated operator enrollment routes. */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Machine } from '../deployment.ts'
import { isLoopbackHost, isWildcardHost } from '@deepseek-ai/dsh-host-webserver'
import { Portal, PortalError } from './portal.ts'

export const PORTAL_ADMIN_PATH = '/orchestrator/registration'
const field = z.object({ displayName: z.string().trim().min(1).max(100) }).strict()
const pin = z.object({ attempt: z.string().min(1).max(100), pin: z.string().regex(/^\d{4,16}$/) }).strict()
const safeId = /^[A-Za-z0-9_-]{1,80}$/
const script = () => readFileSync(new URL('./lib/portal.js', import.meta.resolve('dsh-superagent/package.json')), 'utf8')
function html(mode: 'admin' | 'tenant', id?: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>CoNest · ${mode === 'admin' ? '成员与微信绑定' : '个人空间'}</title></head><body><div id="root"></div><script id="portal-boot" type="application/json">${JSON.stringify({ mode, id })}</script><script src="${mode === 'admin' ? PORTAL_ADMIN_PATH : ''}/assets/portal.js" defer></script></body></html>`
}
function respond(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...headers })
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : String(body))
}
async function body(req: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > maxBytes) throw new PortalError(400, '请求过大'); chunks.push(Buffer.from(chunk)) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PortalError(400, '请求格式错误') }
}
function failure(res: ServerResponse, error: unknown): void {
  const status = error instanceof PortalError ? error.status : error instanceof z.ZodError ? 400 : 500
  respond(res, status, { error: error instanceof PortalError ? error.message : status === 400 ? '请检查填写内容' : '操作未完成，请稍后重试' })
}
const idFrom = (value: string | undefined) => { if (!value || !safeId.test(value)) throw new PortalError(404, '页面不存在'); return value }
/** Render the operator shell after the caller has authenticated the DSH browser session. */
export function registrationPage(res: ServerResponse, head = false): void {
  respond(res, 200, head ? '' : html('admin'), 'text/html; charset=utf-8')
}
const cookieName = (id: string) => `conest_${id}`
function cookie(req: IncomingMessage, id: string): string | undefined {
  const matches = (req.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName(id) + '='))
  return matches.length === 1 ? matches[0]!.slice(cookieName(id).length + 1) : undefined
}
function cookieHeader(id: string, token: string, maxAge: number, secure: boolean): string {
  return `${cookieName(id)}=${token}; Path=/t/${id}/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

/** Platform route: requires the DSH operator session, not a tenant cookie or a guessed custom header. */
export async function registrationHttp(req: IncomingMessage, res: ServerResponse, portal: Portal, origin: string | undefined,
  authorized: () => number | undefined, expectedHost: string): Promise<void> {
  try {
    const rejected = authorized()
    if (rejected) throw new PortalError(rejected, rejected === 503 ? '请在 DSH 网页管理端使用成员注册功能' : '请先登录 DSH 管理端')
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname.slice(PORTAL_ADMIN_PATH.length)
    if (req.headers.host !== expectedHost || req.headers.origin && req.headers.origin !== `http://${expectedHost}`)
      throw new PortalError(403, '不允许跨站管理操作')
    if (req.method === 'GET' && (path === '' || path === '/')) { registrationPage(res); return }
    if (req.method === 'GET' && path === '/assets/portal.js') { respond(res, 200, script(), 'application/javascript; charset=utf-8'); return }
    if (req.headers['x-orchestrator-request'] !== '1') throw new PortalError(403, '请从管理页面发起操作')
    const pieces = path.split('/').filter(Boolean), method = req.method
    if (pieces[0] !== 'api' || pieces[1] !== 'members') throw new PortalError(404, '页面不存在')
    if (pieces.length === 2) {
      if (method === 'GET') { respond(res, 200, { members: portal.list(), portalOrigin: origin }); return }
      if (method === 'POST') {
        const value = field.parse(await body(req)), created = portal.create(value.displayName)
        respond(res, 201, { member: created.member, inviteUrl: origin && `${origin}/t/${created.member.id}/#invite=${created.invite}` }); return
      }
    }
    const id = idFrom(pieces[2])
    if (pieces.length === 3 && method === 'GET') { respond(res, 200, portal.view(id)); return }
    if (pieces.length === 4 && method === 'POST') {
      if (pieces[3] === 'invite') { const token = portal.invite(id); respond(res, 200, { inviteUrl: origin && `${origin}/t/${id}/#invite=${token}` }); return }
      if (pieces[3] === 'binding') { respond(res, 200, portal.bind(id, true)); return }
      if (pieces[3] === 'pin') { const value = pin.parse(await body(req)); portal.pin(id, value.attempt, value.pin); respond(res, 200, { ok: true }); return }
      if (pieces[3] === 'status') {
        const value = z.object({ status: z.enum(['active', 'disabled']) }).strict().parse(await body(req))
        respond(res, 200, portal.status(id, value.status)); return
      }
    }
    throw new PortalError(404, '页面不存在')
  } catch (error) { failure(res, error) }
}

/** The tenant surface exposes only its own authenticated operations, on a separate origin from DSH. */
export class PortalServer {
  private server?: Server
  private publicOrigin?: string
  constructor(private readonly portal: Portal, private readonly config: NonNullable<Machine['portal']>) {}
  get origin(): string | undefined { return this.publicOrigin }
  async start(): Promise<void> {
    const { host, port, origin, certFile, keyFile } = this.config
    if (!isIP(host) || isWildcardHost(host)) throw new Error('Personal portal requires a concrete listen IP')
    const loopback = isLoopbackHost(host)
    if (!!certFile !== !!keyFile || !loopback && !certFile) throw new Error('A network-facing personal portal requires TLS certificate and key')
    if (origin) {
      const url = new URL(origin)
      if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
        throw new Error('Personal portal origin must be a canonical HTTPS origin (HTTP is allowed only for local development)')
    }
    const listener = (req: IncomingMessage, res: ServerResponse) => { void this.handle(req, res).catch(error => failure(res, error)) }
    const server = this.server = certFile ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile!) }, listener) : createServer(listener)
    server.requestTimeout = 15_000; server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Personal portal did not acquire a port')
    this.publicOrigin = origin || `${certFile ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${address.port}`
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = this.publicOrigin!
    if (req.headers.host !== new URL(origin).host) throw new PortalError(403, '访问地址不匹配')
    const url = new URL(req.url ?? '/', origin), parts = url.pathname.split('/').filter(Boolean)
    if (req.method === 'GET' && url.pathname === '/assets/portal.js') { respond(res, 200, script(), 'application/javascript; charset=utf-8'); return }
    if (parts[0] !== 't') throw new PortalError(404, '页面不存在')
    const id = idFrom(parts[1])
    if (req.method === 'GET' && parts.length === 2) { respond(res, 200, html('tenant', id), 'text/html; charset=utf-8'); return }
    if (req.headers['x-conest-request'] !== '1' || req.headers.origin && req.headers.origin !== origin) throw new PortalError(403, '请从个人页面发起操作')
    if (parts[2] !== 'api') throw new PortalError(404, '页面不存在')
    const method = req.method, action = parts[3], token = cookie(req, id)
    if (method === 'POST' && action === 'exchange' && parts.length === 4) {
      const value = z.object({ invite: z.string().min(20).max(100) }).strict().parse(await body(req)), access = this.portal.exchange(id, value.invite)
      respond(res, 200, { ok: true }, undefined, { 'set-cookie': cookieHeader(id, access.token, access.maxAge, origin.startsWith('https:')) }); return
    }
    this.portal.authenticate(id, token)
    if (method === 'POST' && action === 'tasks' && parts.length === 4) {
      const value = z.object({ requestId: z.string().min(1).max(100), text: z.string().trim().min(1).max(8000), ticketId: z.string().optional() }).strict().parse(await body(req, 32768))
      this.portal.submit(id, value.requestId, value.text, value.ticketId); respond(res, 202, { queued: true }); return
    }
    if (method === 'GET' && action === 'state' && parts.length === 4) {
      const query = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(Object.fromEntries(url.searchParams))
      respond(res, 200, this.portal.personal(id, query.offset, query.limit)); return
    }
    if (method === 'POST' && parts.length === 4) {
      if (action === 'logout') { this.portal.logout(token!); respond(res, 200, { ok: true }, undefined, { 'set-cookie': cookieHeader(id, '', 0, origin.startsWith('https:')) }); return }
      if (action === 'binding') { respond(res, 200, this.portal.bind(id)); return }
      if (action === 'pin') { const value = pin.parse(await body(req)); this.portal.pin(id, value.attempt, value.pin); respond(res, 200, { ok: true }); return }
    }
    if (method === 'POST' && parts.length === 6 && action === 'tasks' && ['stop', 'retry'].includes(parts[5]!)) {
      this.portal.action(id, idFrom(parts[4]), parts[5] as 'stop' | 'retry'); respond(res, 200, { ok: true }); return
    }
    throw new PortalError(404, '页面不存在')
  }
  async stop(): Promise<void> {
    const server = this.server; if (!server) return
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    this.server = undefined
  }
}
