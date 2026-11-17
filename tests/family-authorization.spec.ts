/**
 * Proves `authorize` defaults to deny. These cases do not boot DSH, do not
 * open the Store, and do not show that a running Session enforces the helper.
 */
import { describe, expect, it } from 'vitest'
import { authorize, emptyDirectory, type AuthorizationRequest, type FamilyDirectory, type Member } from '../src/family/index.ts'

const ada: Member = { id: 'member-ada', displayName: 'Ada', status: 'active' }
const bo: Member = { id: 'member-bo', displayName: 'Bo', status: 'active' }
const cy: Member = { id: 'member-cy', displayName: 'Cy', status: 'disabled' }

function directory(overrides: Partial<FamilyDirectory> = {}): FamilyDirectory {
  return {
    ...emptyDirectory(),
    members: [ada, bo, cy],
    bindings: [
      { id: 'bind-ada-feishu', memberId: ada.id, source: 'feishu', externalId: 'ou_ada' },
      { id: 'bind-bo-github', memberId: bo.id, source: 'github', externalId: 'bo' },
      { id: 'bind-cy-feishu', memberId: cy.id, source: 'feishu', externalId: 'ou_cy' },
    ],
    ...overrides,
  }
}

const allow = { allow: true } as const

describe('family authorize', () => {
  it('denies every action on an empty directory', () => {
    const actor = { memberId: ada.id }
    const requests: AuthorizationRequest[] = [
      { action: 'read_memory', actor, ownerMemberId: ada.id },
      { action: 'read_task', actor, ticketId: 'ticket-1' },
      { action: 'receive_attention', actor, ticketId: 'ticket-1', attentionId: 'attention-1' },
      { action: 'speak_in', actor, conversation: { kind: 'dm', source: 'feishu', externalConversationId: 'oc_ada', memberId: ada.id } },
    ]
    expect(requests.map(request => authorize(emptyDirectory(), request))).toEqual([
      { allow: false, reason: 'unknown_member' },
      { allow: false, reason: 'unknown_member' },
      { allow: false, reason: 'unknown_member' },
      { allow: false, reason: 'unknown_member' },
    ])
  })

  it('denies an unbound, ambiguous, unknown, or disabled actor before looking at the resource', () => {
    const base = directory({
      bindings: [
        { id: 'bind-ada-1', memberId: ada.id, source: 'feishu', externalId: 'ou_shared' },
        { id: 'bind-bo-1', memberId: bo.id, source: 'feishu', externalId: 'ou_shared' },
        { id: 'bind-missing', memberId: 'member-missing', source: 'feishu', externalId: 'ou_missing' },
        { id: 'bind-cy', memberId: cy.id, source: 'feishu', externalId: 'ou_cy' },
      ],
    })
    const memory = (actor: AuthorizationRequest['actor']) => authorize(base, { action: 'read_memory', actor, ownerMemberId: ada.id })
    expect(memory({ source: 'feishu', externalId: 'ou_nobody' })).toEqual({ allow: false, reason: 'unbound' })
    expect(memory({ source: 'feishu', externalId: 'ou_shared' })).toEqual({ allow: false, reason: 'ambiguous_binding' })
    expect(memory({ source: 'feishu', externalId: 'ou_missing' })).toEqual({ allow: false, reason: 'unknown_member' })
    expect(memory({ memberId: 'member-missing' })).toEqual({ allow: false, reason: 'unknown_member' })
    expect(memory({ source: 'feishu', externalId: 'ou_cy' })).toEqual({ allow: false, reason: 'disabled_member' })
    expect(memory({ memberId: cy.id })).toEqual({ allow: false, reason: 'disabled_member' })
  })

  it('keeps memory private until an explicit member or household grant', () => {
    const ownerOnly = directory()
    expect(authorize(ownerOnly, { action: 'read_memory', actor: { memberId: ada.id }, ownerMemberId: ada.id })).toEqual(allow)
    expect(authorize(ownerOnly, { action: 'read_memory', actor: { source: 'feishu', externalId: 'ou_ada' }, ownerMemberId: ada.id })).toEqual(allow)
    expect(authorize(ownerOnly, { action: 'read_memory', actor: { memberId: bo.id }, ownerMemberId: ada.id })).toEqual({ allow: false, reason: 'no_memory_grant' })

    const memberGrant = directory({
      memoryGrants: [{ id: 'grant-bo', ownerMemberId: ada.id, scope: 'member', granteeMemberId: bo.id }],
    })
    expect(authorize(memberGrant, { action: 'read_memory', actor: { memberId: bo.id }, ownerMemberId: ada.id })).toEqual(allow)
    expect(authorize(memberGrant, { action: 'read_memory', actor: { memberId: ada.id }, ownerMemberId: bo.id })).toEqual({ allow: false, reason: 'no_memory_grant' })

    const household = directory({ memoryGrants: [{ id: 'grant-home', ownerMemberId: ada.id, scope: 'household' }] })
    expect(authorize(household, { action: 'read_memory', actor: { memberId: bo.id }, ownerMemberId: ada.id })).toEqual(allow)
    expect(authorize(household, { action: 'read_memory', actor: { memberId: cy.id }, ownerMemberId: ada.id })).toEqual({ allow: false, reason: 'disabled_member' })
  })

  it('refuses memory whose owner record is missing or inactive', () => {
    const granted = directory({
      memoryGrants: [{ id: 'grant-home', ownerMemberId: 'member-gone', scope: 'household' }, { id: 'grant-cy', ownerMemberId: cy.id, scope: 'household' }],
    })
    expect(authorize(granted, { action: 'read_memory', actor: { memberId: bo.id }, ownerMemberId: 'member-gone' })).toEqual({ allow: false, reason: 'unknown_owner' })
    expect(authorize(granted, { action: 'read_memory', actor: { memberId: bo.id }, ownerMemberId: cy.id })).toEqual({ allow: false, reason: 'owner_inactive' })
    expect(authorize(granted, { action: 'read_memory', actor: { memberId: cy.id }, ownerMemberId: cy.id })).toEqual({ allow: false, reason: 'disabled_member' })
  })

  it('shows a private task to its owner and participants, and a household task to any active member', () => {
    const tasks = directory({
      tasks: [
        { ticketId: 'ticket-private', ownerMemberId: ada.id, participantMemberIds: [bo.id], visibility: 'private' },
        { ticketId: 'ticket-home', ownerMemberId: ada.id, participantMemberIds: [], visibility: 'household' },
      ],
    })
    expect(authorize(tasks, { action: 'read_task', actor: { memberId: ada.id }, ticketId: 'ticket-private' })).toEqual(allow)
    expect(authorize(tasks, { action: 'read_task', actor: { source: 'github', externalId: 'bo' }, ticketId: 'ticket-private' })).toEqual(allow)
    expect(authorize(tasks, { action: 'read_task', actor: { memberId: bo.id }, ticketId: 'ticket-home' })).toEqual(allow)
    const stranger: Member = { id: 'member-dee', displayName: 'Dee', status: 'active' }
    const withStranger = directory({
      members: [...tasks.members, stranger],
      tasks: tasks.tasks,
    })
    expect(authorize(withStranger, { action: 'read_task', actor: { memberId: stranger.id }, ticketId: 'ticket-private' })).toEqual({ allow: false, reason: 'task_not_visible' })
    expect(authorize(withStranger, { action: 'read_task', actor: { memberId: stranger.id }, ticketId: 'ticket-home' })).toEqual(allow)
    expect(authorize(tasks, { action: 'read_task', actor: { memberId: ada.id }, ticketId: 'ticket-missing' })).toEqual({ allow: false, reason: 'unknown_task' })
  })

  it('delivers Attention only to the named member who can also read the task', () => {
    const routed = directory({
      tasks: [{ ticketId: 'ticket-1', ownerMemberId: ada.id, participantMemberIds: [], visibility: 'private' }],
      attentionTargets: [{
        ticketId: 'ticket-1',
        attentionId: 'attention-1',
        memberId: ada.id,
        conversation: { kind: 'dm', source: 'feishu', externalConversationId: 'oc_ada', memberId: ada.id },
      }],
    })
    expect(authorize(routed, { action: 'receive_attention', actor: { memberId: ada.id }, ticketId: 'ticket-1', attentionId: 'attention-1' })).toEqual(allow)
    expect(authorize(routed, { action: 'receive_attention', actor: { memberId: bo.id }, ticketId: 'ticket-1', attentionId: 'attention-1' })).toEqual({ allow: false, reason: 'attention_not_for_actor' })
    expect(authorize(routed, { action: 'receive_attention', actor: { memberId: ada.id }, ticketId: 'ticket-1', attentionId: 'attention-missing' })).toEqual({ allow: false, reason: 'unknown_attention' })

    const conflicting = directory({
      attentionTargets: [
        { ticketId: 'ticket-1', attentionId: 'attention-1', memberId: ada.id, conversation: { kind: 'dm', source: 'feishu', externalConversationId: 'oc_ada', memberId: ada.id } },
        { ticketId: 'ticket-1', attentionId: 'attention-1', memberId: bo.id, conversation: { kind: 'dm', source: 'feishu', externalConversationId: 'oc_bo', memberId: bo.id } },
      ],
    })
    expect(authorize(conflicting, { action: 'receive_attention', actor: { memberId: ada.id }, ticketId: 'ticket-1', attentionId: 'attention-1' })).toEqual({ allow: false, reason: 'ambiguous_attention' })

    const hidden = directory({
      tasks: [{ ticketId: 'ticket-1', ownerMemberId: ada.id, participantMemberIds: [], visibility: 'private' }],
      attentionTargets: [{
        ticketId: 'ticket-1',
        attentionId: 'attention-1',
        memberId: bo.id,
        conversation: { kind: 'dm', source: 'feishu', externalConversationId: 'oc_bo', memberId: bo.id },
      }],
    })
    expect(authorize(hidden, { action: 'receive_attention', actor: { memberId: bo.id }, ticketId: 'ticket-1', attentionId: 'attention-1' })).toEqual({ allow: false, reason: 'task_not_visible' })
  })

  it('allows a DM only for that member on the same source, and denies every group', () => {
    const home = directory()
    const adaDm = { kind: 'dm' as const, source: 'feishu', externalConversationId: 'oc_ada', memberId: ada.id }
    const room = { kind: 'group' as const, source: 'feishu', externalConversationId: 'oc_room', groupId: 'group-1' }
    expect(authorize(home, { action: 'speak_in', actor: { source: 'feishu', externalId: 'ou_ada' }, conversation: adaDm })).toEqual(allow)
    expect(authorize(home, { action: 'speak_in', actor: { memberId: bo.id }, conversation: adaDm })).toEqual({ allow: false, reason: 'not_dm_member' })
    expect(authorize(home, { action: 'speak_in', actor: { source: 'github', externalId: 'bo' }, conversation: adaDm })).toEqual({ allow: false, reason: 'source_mismatch' })
    expect(authorize(home, { action: 'speak_in', actor: { memberId: ada.id }, conversation: room })).toEqual({ allow: false, reason: 'group_membership_unmodeled' })
    expect(authorize(home, { action: 'speak_in', actor: { source: 'feishu', externalId: 'ou_ada' }, conversation: room })).toEqual({ allow: false, reason: 'group_membership_unmodeled' })
  })
})
