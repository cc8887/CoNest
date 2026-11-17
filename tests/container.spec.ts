/** Container profile persistence and startup guards, without Docker or external services. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readlinkSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conest-container-')); roots.push(root)
  const app = join(root, 'app'), data = join(root, 'data')
  mkdirSync(join(app, 'examples'), { recursive: true })
  writeFileSync(join(app, 'examples/weixin.profile.cordis.patch.yml'), readFileSync(resolve('examples/weixin.profile.cordis.patch.yml')))
  const run = (command: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [resolve('containers/entrypoint.mjs'), command],
    { env: { ...process.env, CONEST_APP_DIR: app, CONEST_DATA_DIR: data, ...extra }, encoding: 'utf8' })
  return { app, data, run }
}

it('initializes a private text-only profile and retains operator edits on restart', () => {
  const { app, data, run } = fixture()
  expect(run('profile').status).toBe(0)
  const profile = join(data, 'dsh/profiles/conest'), file = join(profile, 'cordis.patch.yml')
  expect(readFileSync(file, 'utf8')).toContain('host: 0.0.0.0')
  expect(readFileSync(file, 'utf8')).toContain(JSON.stringify(join(data, 'runtime')))
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readlinkSync(join(profile, 'node_modules/dsh-superagent'))).toBe(app)
  expect(existsSync(join(data, 'runtime/orchestrator.sqlite'))).toBe(false)
  writeFileSync(file, '# operator settings retained\n')
  expect(run('profile').status).toBe(0)
  expect(readFileSync(file, 'utf8')).toBe('# operator settings retained\n')
})

it('refuses state inside the image application directory', () => {
  const { app, run } = fixture()
  const result = run('profile', { CONEST_DATA_DIR: join(app, 'state') })
  expect(result.status).toBe(1)
  expect(existsSync(join(app, 'state'))).toBe(false)
})

it('requires explicit binding and initialization before serving', () => {
  const { run } = fixture()
  const result = run('start')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('m0 login')
})

it('rejects model endpoint changes before launching DSH and never prints the API key', () => {
  const { run, data } = fixture()
  mkdirSync(join(data, 'runtime'), { recursive: true }); writeFileSync(join(data, 'runtime/orchestrator.sqlite'), '')
  const result = run('start', { CONEST_TEST_API_KEY: 'private-container-test-key', CONEST_TEST_BASE_URL: 'https://attacker.test/' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Tencent hy4 route')
  expect(result.stderr + result.stdout).not.toContain('private-container-test-key')
})
