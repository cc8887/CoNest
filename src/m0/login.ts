/** Private QR/PIN handoff. Container listeners must publish the port on host loopback only. */
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import QRCode from 'qrcode'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { WeixinClient, type WeixinAccount } from './weixin.ts'

export async function login(client: WeixinClient, root: string, accounts: readonly WeixinAccount[], signal: AbortSignal,
  ready: (url: string, qrImage: string) => void,
  listen: { host: '127.0.0.1' | '0.0.0.0'; port: number } = { host: '127.0.0.1', port: 0 }): Promise<WeixinAccount> {
  const controller = new AbortController()
  const lifetime = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(10 * 60_000)])
  const path = `/${randomBytes(24).toString('hex')}/`
  let pin: string | undefined, needsPin = false, status = '等待微信扫码确认', finished = false
  const qrImage = join(root, `login-qr-${randomBytes(8).toString('hex')}.png`)
  let qr = await client.qr(accounts.map(account => account.token), lifetime)
  let dataUrl = await QRCode.toDataURL(qr.url, { width: 320, margin: 2 })
  await QRCode.toFile(qrImage, qr.url, { width: 512, margin: 2 }); chmodSync(qrImage, 0o600)
  let origin = ''
  const respond = (res: ServerResponse, code: number, type: string, data: string) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" })
    res.end(data)
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host || !req.url?.startsWith(path)) { respond(res, 404, 'text/plain', 'Not found'); return }
      const route = req.url.slice(path.length)
      if (req.method === 'GET' && route === '') {
        respond(res, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>CoNest 微信测试绑定</title>
          <style>body{font:18px system-ui;max-width:560px;margin:48px auto;padding:20px}img{max-width:100%}input,button{font:inherit;padding:10px}#pin{display:none}</style>
          <h1>CoNest 微信测试绑定</h1><p>请用需要参与测试的微信扫码，并在手机上确认。本入口只运行无副作用的连接测试工具。</p>
          <img id="qr" alt="微信绑定二维码"><p id="state"></p><form id="pin"><label>输入手机微信显示的绑定 PIN <input name="pin" autocomplete="off" required pattern="[0-9]{4,16}"></label><button>提交</button></form>
          <p>绑定后，在微信向机器人发送：M0 工具测试。</p><script>
          const form=document.querySelector('#pin');async function update(){try{const r=await fetch('status');const s=await r.json();document.querySelector('#state').textContent=s.status;document.querySelector('#qr').src=s.qr;form.style.display=s.needsPin?'block':'none';if(!s.finished)setTimeout(update,1500)}catch{document.querySelector('#state').textContent='绑定进程已关闭，请查看终端结果'}}
          form.onsubmit=async e=>{e.preventDefault();await fetch('pin',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(form))});form.reset()};update();</script></html>`)
      } else if (req.method === 'GET' && route === 'status') {
        respond(res, 200, 'application/json', JSON.stringify({ status, needsPin, finished, qr: dataUrl }))
      } else if (req.method === 'POST' && route === 'pin' && needsPin && req.headers.origin === origin) {
        let body = ''
        for await (const chunk of req) { body += String(chunk); if (body.length > 128) { respond(res, 413, 'text/plain', 'Too large'); return } }
        const value = new URLSearchParams(body).get('pin') ?? ''
        if (!/^\d{4,16}$/.test(value)) { respond(res, 400, 'text/plain', 'Invalid PIN'); return }
        pin = value; needsPin = false; status = '正在验证 PIN'; respond(res, 200, 'text/plain', 'OK')
      } else respond(res, 404, 'text/plain', 'Not found')
    } catch { respond(res, 500, 'text/plain', 'Local login request failed') }
  })
  server.requestTimeout = 10_000; server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(listen.port, listen.host, resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback login address')
  origin = `http://127.0.0.1:${address.port}`
  ready(origin + path, qrImage)
  let baseURL = WeixinClient.origin, refreshes = 0
  try {
    while (!lifetime.aborted) {
      if (needsPin) { await delay(300, undefined, { signal: lifetime }); continue }
      let result
      try { result = await client.loginStatus(qr.qrcode, baseURL, pin, lifetime) }
      catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError' && !lifetime.aborted) continue
        throw error
      }
      if (result.status.includes('need_verifycode')) { needsPin = true; status = '请在此页面输入手机微信显示的 PIN'; continue }
      pin = undefined
      switch (result.status) {
        case 'confirmed': {
          const account = client.account(result)
          status = '微信已确认，正在保存绑定。随后请发送 M0 工具测试。'; finished = true
          await delay(1700, undefined, { signal: lifetime })
          return account
        }
        case 'scaned_but_redirect': baseURL = client.redirect(result.redirect_host ?? ''); break
        case 'scaned': status = '已扫码，请在微信中确认'; break
        case 'expired':
          if (++refreshes > 3) throw new Error('QR expired repeatedly; restart login when ready')
          qr = await client.qr(accounts.map(account => account.token), lifetime); baseURL = WeixinClient.origin
          dataUrl = await QRCode.toDataURL(qr.url, { width: 320, margin: 2 })
          await QRCode.toFile(qrImage, qr.url, { width: 512, margin: 2 }); chmodSync(qrImage, 0o600)
          status = '二维码已刷新，请重新扫码'; break
        case 'verify_code_blocked': throw new Error('PIN verification blocked; retry login later')
        case 'binded_redirect': throw new Error('Weixin reports an existing binding; inspect saved accounts rather than replacing it automatically')
        case 'wait': break
        default: throw new Error('Unsupported Weixin login state; inspect the upstream protocol before continuing')
      }
      await delay(500, undefined, { signal: lifetime })
    }
    lifetime.throwIfAborted()
    throw new Error('Login stopped')
  } finally {
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
