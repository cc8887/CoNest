/** Private, standalone M0 transport journal. It contains no SuperAgent Tickets. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { AccountSchema, type WeixinAccount, type WeixinMessage } from './weixin.ts'

export interface Inbound {
  id: number; accountId: string; messageId: string; peer: string; contextToken: string; text: string
  status: string; reply: string | null; sessionId: string | null; error: string | null
}

/** Durable account/cursor and owner-DM journal used only by the opt-in M0 commands. */
export class M0State {
  private readonly db: DatabaseSync
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    const file = join(root, 'transport.sqlite')
    closeSync(openSync(file, 'a', 0o600)); chmodSync(file, 0o600)
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, value TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, accountId TEXT NOT NULL, messageId TEXT NOT NULL,
        peer TEXT NOT NULL, contextToken TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        reply TEXT, sessionId TEXT, error TEXT, UNIQUE(accountId, messageId));`)
  }
  /** Called only by the bridge after taking the process lock, never by status/login readers. */
  recover(): void {
    this.db.prepare("UPDATE inbox SET status='interrupted', error='Stopped during model execution; explicit retry required' WHERE status='running'").run()
    this.db.prepare("UPDATE inbox SET status='uncertain', error='Stopped during send; delivery must be checked before retry' WHERE status='sending'").run()
  }
  accounts(): WeixinAccount[] { return this.db.prepare('SELECT value FROM account ORDER BY id').all().map(row => AccountSchema.parse(JSON.parse(String(row.value)))) }
  saveAccount(account: WeixinAccount): void {
    AccountSchema.parse(account)
    const old = this.accounts().find(item => item.id === account.id)
    if (old && old.ownerId !== account.ownerId) throw new Error('Bot owner changed; use a new M0 state directory to avoid misdelivery')
    this.db.prepare('INSERT INTO account(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(account.id, JSON.stringify(account))
  }
  cursor(accountId: string): string {
    const row = this.db.prepare('SELECT cursor FROM account WHERE id=?').get(accountId)
    if (!row) throw new Error('Unknown M0 account')
    return String(row.cursor)
  }
  ingest(account: WeixinAccount, cursor: string, messages: readonly WeixinMessage[]): { added: number; rejected: number } {
    if (!this.accounts().some(item => item.id === account.id && item.ownerId === account.ownerId)) throw new Error('Unknown M0 account')
    let added = 0, rejected = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const message of messages) {
        const content = message.item_list.filter(item => item.type === 1).map(item => item.text_item?.text ?? '').join('\n').trim()
        if (message.message_type !== 1 || message.message_state === 1 || message.group_id || message.from_user_id !== account.ownerId
          || !message.context_token || !content || content.length > 8000 || message.item_list.some(item => item.type !== 1)) { rejected++; continue }
        const changed = this.db.prepare('INSERT OR IGNORE INTO inbox(accountId,messageId,peer,contextToken,text) VALUES(?,?,?,?,?)')
          .run(account.id, message.message_id, message.from_user_id, message.context_token, content).changes
        added += Number(changed)
      }
      this.db.prepare('UPDATE account SET cursor=? WHERE id=?').run(cursor, account.id)
      this.db.exec('COMMIT')
      return { added, rejected }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  pending(): Inbound | undefined {
    return this.db.prepare("SELECT * FROM inbox WHERE status IN ('new','ready') ORDER BY id LIMIT 1").get() as unknown as Inbound | undefined
  }
  transition(id: number, from: string, to: string, result?: { reply: string; sessionId: string }, error?: string): void {
    const changed = this.db.prepare('UPDATE inbox SET status=?,reply=COALESCE(?,reply),sessionId=COALESCE(?,sessionId),error=? WHERE id=? AND status=?')
      .run(to, result?.reply ?? null, result?.sessionId ?? null, error ?? null, id, from).changes
    if (changed !== 1) throw new Error('M0 delivery state changed unexpectedly')
  }
  summary() {
    return { accounts: this.accounts().map(item => ({ id: item.id, ownerId: item.ownerId })),
      messages: this.db.prepare('SELECT id,accountId,status,sessionId,error FROM inbox ORDER BY id DESC LIMIT 50').all() }
  }
  close(): void { this.db.close() }
}
