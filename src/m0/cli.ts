/** Opt-in M0 commands. Normal tests/builds never read real credentials or contact a provider. */
import { parseArgs, parseEnv } from 'node:util'
import { homedir, platform, release, totalmem, cpus } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import lockfile from 'proper-lockfile'
import { DshProbe, type ModelConfig } from './dsh.ts'
import { WeixinClient } from './weixin.ts'
import { M0State } from './state.ts'
import { runBridge } from './bridge.ts'
import { login } from './login.ts'

async function main(): Promise<void> {
  process.umask(0o077)
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string', default: join(homedir(), '.local/state/conest/m0') },
    'env-file': { type: 'string', default: join(homedir(), '.config/conest/model-test.env') },
    account: { type: 'string' }, output: { type: 'string' },
    'listen-host': { type: 'string', default: '127.0.0.1' }, 'listen-port': { type: 'string', default: '0' },
  } })
  const command = positionals[0] ?? 'help'
  const root = resolve(values['state-dir']!)
  if (command === 'help') {
    console.log('CoNest M0\n  pnpm m0 model   Real DSH/hy4 tool round trip\n  pnpm m0 login   Bind Weixin in a loopback QR/PIN page\n  pnpm m0 weixin  Receive owner DMs, run DSH, send replies\n  pnpm m0 status  Show local delivery states, without tokens\n  pnpm m0 doctor  Report this machine (run on N100 WSL too)\n  pnpm m0 export-account --output <absolute private file> [--account <bot-id>]\nOptions: --env-file <outside-repo dotenv> --state-dir <outside-repo directory>')
    return
  }
  if (!['model','login','weixin','status','doctor','export-account'].includes(command)) throw new Error('Unknown M0 command; use pnpm m0 help')
  if (command === 'doctor') {
    console.log(JSON.stringify({ node: process.version, platform: platform(), kernel: release(), cpus: cpus().length,
      reportedMemoryGiB: Math.round(totalmem() / 2 ** 30 * 10) / 10, wsl: /microsoft/i.test(release()),
      note: 'WSL memory here is its visible allowance; collect Windows physical RAM separately' }, null, 2)); return
  }
  const cwd = resolve('.')
  if (root === cwd || root.startsWith(cwd + '/')) throw new Error('M0 state and credentials must be outside the checkout')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const shutdown = new AbortController()
  const stop = () => shutdown.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  const loadModel = (): ModelConfig => {
    const env = parseEnv(readFileSync(resolve(values['env-file']!), 'utf8'))
    const baseURL = env.CONEST_TEST_BASE_URL, model = env.CONEST_TEST_MODEL, key = env.CONEST_TEST_API_KEY
    if (!baseURL || !model || !key || env.CONEST_TEST_PROTOCOL !== 'openai-completions') throw new Error('Test env requires base URL, model, API key and openai-completions protocol')
    if (new URL(baseURL).protocol !== 'https:') throw new Error('Model endpoint must use HTTPS')
    process.env.CONEST_TEST_API_KEY = key
    return { baseURL, model, apiKeyEnv: 'CONEST_TEST_API_KEY' }
  }
  const state = new M0State(root)
  let unlock: (() => Promise<void>) | undefined
  let model: DshProbe | undefined
  try {
    if (command === 'status') { console.log(JSON.stringify(state.summary(), null, 2)); return }
    unlock = await lockfile.lock(root, { retries: 0, stale: 120_000, realpath: true })
    if (command === 'export-account') {
      const accounts = state.accounts().filter(account => !values.account || account.id === values.account)
      if (accounts.length !== 1 || !values.output || !isAbsolute(values.output)) throw new Error('Select exactly one bound account and an absolute --output path')
      const file = resolve(values.output)
      if (file === cwd || file.startsWith(cwd + '/')) throw new Error('Credential output must be outside the checkout')
      writeFileSync(file, JSON.stringify(accounts[0],null,2)+'\n', { mode:0o600, flag:'wx' })
      console.log(JSON.stringify({ event:'account-exported', credentialsFile:file, accountId:accounts[0]!.id, ownerId:accounts[0]!.ownerId }))
      return
    }
    if (command === 'login') {
      const host = values['listen-host'], port = Number(values['listen-port'])
      if ((host !== '127.0.0.1' && host !== '0.0.0.0') || !/^\d+$/.test(values['listen-port']!) || !Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid private login listener')
      const account = await login(new WeixinClient(), root, state.accounts(), shutdown.signal,
        (url, qrImage) => console.log(JSON.stringify({ event: 'scan-required', url, qrImage })), { host, port })
      state.saveAccount(account)
      console.log(JSON.stringify({ event: 'bound', accountId: account.id, ownerId: account.ownerId }))
      return
    }
    model = await DshProbe.start(loadModel(), root)
    if (command === 'model') {
      const evidence = { at: new Date().toISOString(), dsh: '0.2.1-alpha.2', ...(await model.run('Run the probe and reply exactly OK.', shutdown.signal)) }
      if (evidence.text.trim() !== 'OK' || evidence.toolCalls !== 1 || evidence.modelCalls < 2) throw new Error('Unexpected DSH smoke result')
      writeFileSync(join(root, 'model-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify(evidence, null, 2))
    } else {
      state.recover()
      console.log(JSON.stringify({ event: 'listening', accounts: state.accounts().length, note: 'M0 owner DMs, text only, no shell/file tools' }))
      await runBridge(state, new WeixinClient(), model, shutdown.signal, (event, details) => console.log(JSON.stringify({ event, ...details })))
    }
  } finally {
    shutdown.abort()
    if (model) await model.close()
    state.close()
    if (unlock) await unlock()
    delete process.env.CONEST_TEST_API_KEY
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  }
}

main().catch(error => {
  // Never echo provider response bodies, URLs with login tickets, credentials or inbound private text.
  console.error(error instanceof Error && ['WeixinError','AbortError','TimeoutError'].includes(error.name) ? error.message
    : 'M0 command failed. Check configuration, process lock, network and local Session evidence; no credentials were printed.')
  process.exitCode = 1
})
