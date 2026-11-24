/** Process adapter for the Feishu live event transport. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Health } from './host.ts'

export type FeishuEvents = (signal: AbortSignal, receive: (event: unknown) => Promise<void>,
  report: (health: Health) => void) => Promise<void>

export const feishuCliEvents = (cli: string): FeishuEvents => async (signal, receive, report) => {
  signal.throwIfAborted()
  const child = spawn(cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false; let broken = false
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'Feishu event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      // stdout and stderr are separate pipes, so this banner can arrive after a malformed event was already reported.
      if (!broken) report({ state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) report({ state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
      await receive(JSON.parse(line))
    }).catch(error => { broken = true; report({ state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}
