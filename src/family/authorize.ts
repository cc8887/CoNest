/**
 * Default-deny authorization over a `FamilyDirectory`.
 *
 * Pure: no I/O, no clock, no Engine, no prompt text. A caller must pass the
 * records it wants judged. An empty directory denies every request.
 * Passing these tests does not mean the running agent enforces them.
 */
import type { ConversationScope, FamilyDirectory, Member, MemberId } from './domain.ts'

/** A channel account, judged only through `IdentityBinding` rows. */
export type ChannelActor = { readonly source: string, readonly externalId: string }
/** An already-resolved member id. Unknown and disabled members are denied. */
export type MemberActor = { readonly memberId: MemberId }
export type Actor = ChannelActor | MemberActor

export type DenyReason =
  | 'unbound'
  | 'ambiguous_binding'
  | 'unknown_member'
  | 'disabled_member'
  | 'unknown_owner'
  | 'owner_inactive'
  | 'no_memory_grant'
  | 'unknown_task'
  | 'task_not_visible'
  | 'unknown_attention'
  | 'ambiguous_attention'
  | 'attention_not_for_actor'
  | 'group_membership_unmodeled'
  | 'not_dm_member'
  | 'source_mismatch'

export type AuthorizationDecision =
  | { readonly allow: true }
  | { readonly allow: false, readonly reason: DenyReason }

export type AuthorizationRequest =
  | { readonly action: 'read_memory', readonly actor: Actor, readonly ownerMemberId: MemberId }
  | { readonly action: 'read_task', readonly actor: Actor, readonly ticketId: string }
  | { readonly action: 'receive_attention', readonly actor: Actor, readonly ticketId: string, readonly attentionId: string }
  | { readonly action: 'speak_in', readonly actor: Actor, readonly conversation: ConversationScope }

interface Resolved { readonly ok: true, readonly member: Member }
interface Rejected { readonly ok: false, readonly reason: DenyReason }

function deny(reason: DenyReason): AuthorizationDecision {
  return { allow: false, reason }
}

function resolveActor(directory: FamilyDirectory, actor: Actor): Resolved | Rejected {
  if ('memberId' in actor) {
    const member = directory.members.find(item => item.id === actor.memberId)
    if (!member) return { ok: false, reason: 'unknown_member' }
    if (member.status !== 'active') return { ok: false, reason: 'disabled_member' }
    return { ok: true, member }
  }
  const matches = directory.bindings.filter(binding => binding.source === actor.source && binding.externalId === actor.externalId)
  if (matches.length === 0) return { ok: false, reason: 'unbound' }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous_binding' }
  const binding = matches[0]
  if (!binding) return { ok: false, reason: 'unbound' }
  const member = directory.members.find(item => item.id === binding.memberId)
  if (!member) return { ok: false, reason: 'unknown_member' }
  if (member.status !== 'active') return { ok: false, reason: 'disabled_member' }
  return { ok: true, member }
}

function ownerState(directory: FamilyDirectory, ownerMemberId: string): Member | DenyReason {
  const owner = directory.members.find(item => item.id === ownerMemberId)
  if (!owner) return 'unknown_owner'
  if (owner.status !== 'active') return 'owner_inactive'
  return owner
}

/** Whether `actor` may read memory owned by `ownerMemberId`. The actor is already active. */
function memoryAllowed(directory: FamilyDirectory, actor: Member, ownerMemberId: string): AuthorizationDecision {
  const owner = ownerState(directory, ownerMemberId)
  if (typeof owner === 'string') return deny(owner)
  if (actor.id === owner.id) return { allow: true }
  const allowed = directory.memoryGrants.some(grant => grant.ownerMemberId === owner.id
    && (grant.scope === 'household' || grant.granteeMemberId === actor.id))
  return allowed ? { allow: true } : deny('no_memory_grant')
}

/** Whether `actor` may read the named Ticket. The actor is already active. */
function taskAllowed(directory: FamilyDirectory, actor: Member, ticketId: string): AuthorizationDecision {
  const task = directory.tasks.find(item => item.ticketId === ticketId)
  if (!task) return deny('unknown_task')
  if (task.ownerMemberId === actor.id || task.participantMemberIds.includes(actor.id)) return { allow: true }
  if (task.visibility === 'household') return { allow: true }
  return deny('task_not_visible')
}

/**
 * Judge one request. The first failing check wins.
 * Group conversations always fail after the actor resolves: this module has no group roster.
 */
export function authorize(directory: FamilyDirectory, request: AuthorizationRequest): AuthorizationDecision {
  const actor = resolveActor(directory, request.actor)
  if (!actor.ok) return deny(actor.reason)
  switch (request.action) {
    case 'read_memory':
      return memoryAllowed(directory, actor.member, request.ownerMemberId)
    case 'read_task':
      return taskAllowed(directory, actor.member, request.ticketId)
    case 'receive_attention': {
      const targets = directory.attentionTargets.filter(item => item.ticketId === request.ticketId && item.attentionId === request.attentionId)
      if (targets.length === 0) return deny('unknown_attention')
      if (targets.length > 1) return deny('ambiguous_attention')
      const target = targets[0]
      if (!target || target.memberId !== actor.member.id) return deny('attention_not_for_actor')
      return taskAllowed(directory, actor.member, request.ticketId)
    }
    case 'speak_in': {
      if (request.conversation.kind === 'group') return deny('group_membership_unmodeled')
      if ('source' in request.actor && request.actor.source !== request.conversation.source) return deny('source_mismatch')
      if (request.conversation.memberId !== actor.member.id) return deny('not_dm_member')
      return { allow: true }
    }
    default: {
      const unreachable: never = request
      return unreachable
    }
  }
}
