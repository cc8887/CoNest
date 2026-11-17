/** Actual QR web listener boundaries, with only the remote iLink API replaced. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { expect, it } from 'vitest'
import { login } from '../src/m0/login.ts'
import { WeixinClient } from '../src/m0/weixin.ts'

it.each(['127.0.0.1', '0.0.0.0'] as const)('keeps capability and Host validation with the %s login listener', async host => {
  const root = mkdtempSync(join(tmpdir(), 'conest-login-')), controller = new AbortController()
  const client = new WeixinClient(async url => new Response(JSON.stringify(String(url).includes('get_bot_qrcode')
    ? { ret: 0, qrcode: 'offline-ticket', qrcode_img_content: 'https://example.test/offline-qr' } : { ret: 0, status: 'wait' })))
  let ready!: (url: string) => void
  const address = new Promise<string>(resolve => { ready = resolve })
  const pending = login(client, root, [], controller.signal, url => ready(url), { host, port: 0 }).catch(error => error)
  try {
    const url = await address
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/)
    expect((await fetch(url)).status).toBe(200)
    expect((await fetch(new URL('/wrong-capability/', url))).status).toBe(404)
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      request(url, { headers: { host: 'attacker.test' } }, response => { response.resume(); resolve(response.statusCode) }).on('error', reject).end()
    })
    expect(wrongHost).toBe(404)
  } finally {
    controller.abort(); await pending; rmSync(root, { recursive: true, force: true })
  }
})
