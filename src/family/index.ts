/**
 * Public surface of the unwired CoNest family module.
 * Importing this from `src/index.ts` would pull it into the DSH plugin. Do not.
 */
export { emptyDirectory } from './domain.ts'
export type {
  AttentionTarget,
  ConversationScope,
  FamilyDirectory,
  IdentityBinding,
  Member,
  MemberId,
  MemberStatus,
  MemoryGrant,
  TaskAccess,
  TaskVisibility,
} from './domain.ts'
export { authorize } from './authorize.ts'
export type { Actor, AuthorizationDecision, AuthorizationRequest, ChannelActor, DenyReason, MemberActor } from './authorize.ts'
