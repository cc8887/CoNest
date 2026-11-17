/** Public, credential-free Weixin member directory and pinned transport bindings. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const accountFields = { credentialsFile: z.string().refine(value => !value || isAbsolute(value), 'Absolute path required').default(''),
  accountId: z.string().max(256).default(''), ownerId: z.string().max(256).default('') }
export const WeixinMemberSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  displayName: z.string().min(1).max(100), status: z.enum(['active', 'disabled']) }).strict()
const bindingSchema = z.object({ ...accountFields, memberId: z.string().min(1), enabled: z.boolean().optional() }).strict()
export const WeixinConfigSchema = z.object({ ...accountFields, members: z.array(WeixinMemberSchema).max(100).optional(),
  accounts: z.array(bindingSchema).max(100).optional() }).strict().superRefine((value, ctx) => {
  if (value.members === undefined && value.accounts === undefined) return
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (!value.members || !value.accounts || value.credentialsFile || value.accountId || value.ownerId) bad('Use members and accounts together, without legacy account fields')
  const members = value.members ?? [], accounts = value.accounts ?? []
  if (new Set(members.map(member => member.id)).size !== members.length) bad('Duplicate member id')
  if (new Set(accounts.map(account => account.accountId)).size !== accounts.length) bad('A bot account can have only one binding')
  if (new Set(accounts.map(account => account.credentialsFile)).size !== accounts.length) bad('Duplicate credential file')
  for (const account of accounts) if (!account.accountId || !account.ownerId || !account.credentialsFile || !members.some(member => member.id === account.memberId))
    bad('Each account needs pinned ids, a private credential file and a known member')
})
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>
export type WeixinBinding = z.infer<typeof bindingSchema>
export const weixinActorId = (accountId: string, ownerId: string): string => JSON.stringify([accountId, ownerId])
export function weixinAccounts(config: WeixinConfig | undefined, active = true): WeixinBinding[] {
  if (!config) return []
  if (config.accounts) return config.accounts.filter(account => !active || account.enabled !== false
    && config.members?.some(member => member.id === account.memberId && member.status === 'active'))
  return config.credentialsFile && config.accountId && config.ownerId ? [{ ...config, memberId: '' }] : []
}
