/** Container lifecycle and fresh-profile setup; all credentials and mutable state stay in /data or the environment. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnv } from 'node:util'

process.umask(0o077)
const app = resolve(process.env.CONEST_APP_DIR || '/opt/conest')
const data = resolve(process.env.CONEST_DATA_DIR || '/data')
const dsh = process.env.CONEST_DSH_BIN || '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const profile = join(data, 'dsh/profiles/conest')
const command = process.argv[2] || 'start', args = process.argv.slice(3)

async function child(file, values) {
  const running = spawn(file, values, { stdio: 'inherit', env: process.env })
  const forward = signal => running.kill(signal)
  const term = () => forward('SIGTERM'), interrupt = () => forward('SIGINT')
  process.on('SIGTERM', term); process.on('SIGINT', interrupt)
  try {
    const code = await new Promise((accept, reject) => {
      running.once('error', reject)
      running.once('exit', (code, signal) => accept(code ?? (signal ? 128 : 1)))
    })
    if (code !== 0) throw new Error('Child command failed; inspect the preceding sanitized output')
  } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt) }
}

function ensureProfile() {
  if (data === app || data.startsWith(app + sep) || data === '/') throw new Error('Container state must be outside the application directory')
  mkdirSync(join(data, 'home'), { recursive: true, mode: 0o700 })
  mkdirSync(join(profile, 'node_modules'), { recursive: true, mode: 0o700 })
  const manifest = { name: 'dsh-profile-conest', private: true, dependencies: { 'dsh-superagent': 'link:' + app },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent'] } } }
  const save = (file, text) => { if (!existsSync(file)) writeFileSync(file, text, { flag: 'wx', mode: 0o600 }) }
  save(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const template = readFileSync(join(app, 'examples/weixin.profile.cordis.patch.yml'), 'utf8')
  save(join(profile, 'cordis.patch.yml'), template.replace('host: 127.0.0.1', "host: !!js ctx.webStartup.host ?? '127.0.0.1'")
    .replace('<absolute private Runtime state directory>', JSON.stringify(join(data, 'runtime'))))
  const linked = join(profile, 'node_modules/dsh-superagent')
  if (!existsSync(linked)) symlinkSync(app, linked, 'dir')
  process.env.DSH_HOME = join(data, 'dsh')
  process.env.HOME = join(data, 'home')
}

function modelEnv() {
  const file = join(data, 'secrets/model-test.env')
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  for (const key of ['CONEST_TEST_API_KEY', 'CONEST_TEST_BASE_URL', 'CONEST_TEST_PROTOCOL', 'CONEST_TEST_MODEL'])
    if (!process.env[key] && saved[key]) process.env[key] = saved[key]
  const values = {
    CONEST_TEST_BASE_URL: process.env.CONEST_TEST_BASE_URL || 'https://copilot.tencent.com/v2/',
    CONEST_TEST_PROTOCOL: process.env.CONEST_TEST_PROTOCOL || 'openai-completions',
    CONEST_TEST_MODEL: process.env.CONEST_TEST_MODEL || 'hy4', CONEST_TEST_API_KEY: process.env.CONEST_TEST_API_KEY,
  }
  if (!values.CONEST_TEST_API_KEY || values.CONEST_TEST_PROTOCOL !== 'openai-completions'
    || values.CONEST_TEST_BASE_URL !== 'https://copilot.tencent.com/v2/' || values.CONEST_TEST_MODEL !== 'hy4')
    throw new Error('This release requires the configured Tencent hy4 route and CONEST_TEST_API_KEY')
  // The standalone M0 CLI accepts an env file; never persist this generated file into the image or data volume.
  const temporary = mkdtempSync(join(tmpdir(), 'conest-model-'))
  const envFile = join(temporary, 'model.env')
  if (Object.values(values).some(value => /[\r\n"\\]/.test(value))) throw new Error('Invalid model environment value')
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n', { mode: 0o600 })
  return { file: envFile, dispose: () => rmSync(temporary, { recursive: true, force: true }) }
}

try {
  if (command === 'help' || command === '--help') {
    console.log('CoNest container\n  m0 doctor|model|login|status\n  init [--account <bot-id>]\n  init-members [/data/members.json]\n  start [DSH options]\n  profile  Initialize configuration only\nState: /data. start opens web member enrollment automatically. DSH admin: loopback 3088; personal portal: loopback 3089. Remote personal access requires TLS; see the deployment guide.')
  } else if (command === 'm0') {
    const operation = args[0] || 'help'
    const env = ['model', 'weixin'].includes(operation) ? modelEnv() : undefined
    try {
      await child(process.execPath, [join(app, 'lib/m0.js'), ...args, '--state-dir', join(data, 'm0'),
        ...(env ? ['--env-file', env.file] : []), ...(operation === 'login' ? ['--listen-host', '127.0.0.1', '--listen-port', '3087'] : [])])
    } finally { env?.dispose() }
  } else if (command === 'profile') {
    ensureProfile(); console.log('Private container profile initialized; no account was bound and no polling started.')
  } else if (command === 'init-members') {
    ensureProfile()
    if (args.length > 1) throw new Error('Usage: init-members [/data/members.json]')
    await child(process.execPath, [join(app, 'lib/weixin-setup.js'), '--state-dir', join(data, 'runtime'),
      '--members-file', resolve(args[0] || join(data, 'members.json'))])
  } else if (command === 'init') {
    ensureProfile()
    const credentials = join(data, 'weixin-account.json')
    if (!existsSync(credentials)) await child(process.execPath, [join(app, 'lib/m0.js'), 'export-account', ...args,
      '--state-dir', join(data, 'm0'), '--output', credentials])
    await child(process.execPath, [join(app, 'lib/weixin-setup.js'), '--state-dir', join(data, 'runtime'), '--credentials-file', credentials])
  } else if (command === 'start') {
    ensureProfile()
    if (!existsSync(join(data, 'runtime/orchestrator.sqlite')))
      await child(process.execPath, [join(app, 'lib/weixin-setup.js'), '--state-dir', join(data, 'runtime'), '--web'])
    const env = modelEnv()
    const network = process.env.CONEST_CONTAINER === '1'
      ? ['--host', '127.0.0.1', '--port', '3088', '--public-url', 'http://127.0.0.1:3088',
        '--trusted-host', '127.0.0.1:3088', 'localhost:3088'] : []
    try { await child(process.execPath, [dsh, '--profile', 'conest', ...args, ...network, '--no-open']) } finally { env.dispose() }
  } else throw new Error('Unknown container command; use help')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Container command failed')
  process.exitCode = 1
}
