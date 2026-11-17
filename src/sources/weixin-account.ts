/** Read one explicitly selected, private host credential file; it never enters model context. */
import { readFileSync, lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { AccountSchema, type WeixinAccount } from './weixin-api.ts'

export function readWeixinAccount(file: string, expected?: { accountId: string; ownerId: string }): WeixinAccount {
  if (!isAbsolute(file)) throw new Error('Weixin credentialsFile must be an absolute path')
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 16_384 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Weixin credential file must be a private regular file (0600)')
  const account = AccountSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  if (expected && (account.id !== expected.accountId || account.ownerId !== expected.ownerId)) throw new Error('Weixin credentials do not match the configured account and owner')
  return account
}
