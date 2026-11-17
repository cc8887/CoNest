/** Authenticated personal-web input and durable browser mailbox, using the same Engine/outbox as Weixin. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

export function personalTrigger(memberId: string, requestId: string, text: string): Trigger {
  const id = key('personal', memberId, requestId), thread = { source: 'personal', id }
  return { id, source: 'personal', actor: { source: 'personal', id: memberId }, human: true, addressed: 'direct',
    at: new Date().toISOString(), text, threads: [thread], meta: { scope: 'dm', memberId },
    channel: { source: 'personal', thread: `personal:${id}`, address: { scope: 'dm', memberId, conversationId: memberId, messageId: id } } }
}

/** The HTTP adapter supplies identity after tenant-session verification; the Source never accepts a caller-supplied identity. */
export function personalKind(active: (id: string) => boolean): SourceKind {
  return { kind: 'personal', title: { zh: '个人网页', en: 'Personal web' }, description: { zh: '已登录成员的私有任务入口', en: 'Private tasks for authenticated members' },
    schema: z.object({}).strict(), fields: [], health: [],
    scope: ({ meta }) => meta.scope === 'dm' && typeof meta.memberId === 'string' && active(meta.memberId)
      ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'private_member_required' },
    channel: { allowed: address => address.scope === 'dm' && active(address.memberId ?? ''),
      link: () => ({ url: '', label: { zh: '个人空间', en: 'Personal space' } }), send: async () => 'sent' },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '已开通网页的成员', en: 'Members with web access' }, columns: [{ key: 'id', type: 'text', label: { zh: '成员', en: 'Member' } }] }],
      explicit: { zh: '成员在自己的网页中提交明确任务。', en: 'A member submits an explicit task from their own space.' },
      rows: () => [{ id: 'direct', label: { zh: '个人空间', en: 'Personal space' }, note: { zh: '只接收已验证的成员', en: 'Authenticated members only' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }] } }
}
