/**
 * CoNest family-domain records.
 *
 * These types name household facts that dsh-superagent deliberately does not
 * model. They are not Tickets, Attentions, Reports, or a memory store.
 * `src/core/engine.ts` remains the only writer of task and Attention state.
 * Nothing in `src/family` is imported by the plugin entry.
 *
 * Copyright for this file is the repository's MIT license (see LICENSE).
 * The DeepSeek Harness Team copyright on the imported prototype is unchanged.
 */

/** Stable id of a household member. Not a channel account id. */
export type MemberId = string

export type MemberStatus = 'active' | 'disabled'

/** A household member. Status is part of authorization, not a display hint. */
export interface Member {
  readonly id: MemberId
  readonly displayName: string
  readonly status: MemberStatus
}

/**
 * Binds one channel account to one member.
 * `source` is a `SourceKind.kind` id (`github`, `feishu`, or a future kind).
 * `externalId` is that Source's own sender id. Two Sources are never the same
 * identity unless a binding says so.
 */
export interface IdentityBinding {
  readonly id: string
  readonly memberId: MemberId
  readonly source: string
  readonly externalId: string
}

/**
 * Where a conversation lives.
 * A DM names exactly one member. A group names a room id and no roster:
 * group membership is not modeled, and the authorization helper denies it.
 */
export type ConversationScope =
  | {
    readonly kind: 'dm'
    readonly source: string
    readonly externalConversationId: string
    readonly memberId: MemberId
  }
  | {
    readonly kind: 'group'
    readonly source: string
    readonly externalConversationId: string
    readonly groupId: string
  }

/** Who may see one DSH Ticket. This record does not store the Ticket. */
export type TaskVisibility = 'private' | 'household'

export interface TaskAccess {
  readonly ticketId: string
  /** DSH Ticket id this grant refers to. The Ticket itself stays in the Engine. */
  readonly ownerMemberId: MemberId
  readonly participantMemberIds: readonly MemberId[]
  readonly visibility: TaskVisibility
}

/**
 * An explicit share of one member's private memory.
 * Absence of a grant means other members cannot read it.
 * `household` is still an explicit record: it is not implied by being in the household.
 */
export type MemoryGrant =
  | {
    readonly id: string
    readonly ownerMemberId: MemberId
    readonly scope: 'member'
    readonly granteeMemberId: MemberId
  }
  | {
    readonly id: string
    readonly ownerMemberId: MemberId
    readonly scope: 'household'
  }

/**
 * Proposed route for one DSH Attention question.
 * Not persisted in `orchestrator.sqlite` and not read by `Replies`.
 */
export interface AttentionTarget {
  readonly ticketId: string
  readonly attentionId: string
  readonly memberId: MemberId
  readonly conversation: ConversationScope
}

/** In-memory directory passed into the pure helper. Not a database. */
export interface FamilyDirectory {
  readonly members: readonly Member[]
  readonly bindings: readonly IdentityBinding[]
  readonly tasks: readonly TaskAccess[]
  readonly memoryGrants: readonly MemoryGrant[]
  readonly attentionTargets: readonly AttentionTarget[]
}

/** A directory with no members, bindings, grants, or targets. */
export function emptyDirectory(): FamilyDirectory {
  return { members: [], bindings: [], tasks: [], memoryGrants: [], attentionTargets: [] }
}
