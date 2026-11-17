/** Normalizes channel events and constrains replies to their original private conversation. */
import type { Trigger } from '../core/model.ts'
import { key } from '../core/ids.ts'
import type { FamilyDirectory } from '../family/domain.ts'

/** Codes ingress uses when it refuses an invalid or unauthorized delivery. */
export type IngressRejectCode = 'group_membership_unmodeled' | 'no_authorized_dm' | 'missing_sender_id' | 'invalid_message' | 'reply_target_mismatch'

/**
 * Refusal the ingress contract uses once it is connected.
 * Group delivery uses `group_membership_unmodeled`, the same reason as `authorize`.
 */
export class IngressRejected extends Error {
  constructor(readonly code: IngressRejectCode) {
    super(code)
    this.name = 'IngressRejected'
  }
}

/** One channel instance. `kind` is a `SourceKind.kind`; `id` separates two instances of that kind. */
export interface IngressChannel {
  readonly kind: string
  readonly id: string
}

/** Platform content part. A nickname is never a part of identity. */
export type IngressContentPart =
  | { readonly type: 'text', readonly text: string }
  | { readonly type: 'image', readonly url?: string, readonly altText?: string }
  | { readonly type: 'file', readonly url?: string, readonly filename?: string }
  | { readonly type: 'audio', readonly url?: string }
  | { readonly type: 'video', readonly url?: string }

/**
 * Where the message was written, in platform ids.
 * A DM names the stable sender id. A group names a room and no roster.
 */
export type IngressConversation =
  | { readonly scope: 'dm', readonly externalConversationId: string, readonly memberExternalId: string }
  | { readonly scope: 'group', readonly externalConversationId: string, readonly groupId: string }

/**
 * Unified inbound message. `senderId` is the platform's stable user id.
 * `senderName` is a display nickname and must not become `Trigger.actor.id`.
 */
export interface IngressInboundMessage {
  readonly channelKind: string
  readonly channelId: string
  readonly senderId: string
  readonly senderName?: string
  readonly senderKind: 'user' | 'bot'
  readonly conversation: IngressConversation
  readonly messageId: string
  readonly at: string
  readonly parts: readonly IngressContentPart[]
  readonly mentioned?: boolean
}

/** A reply that stays on the conversation which produced the Trigger. */
export interface IngressReply {
  readonly channelKind: string
  readonly channelId: string
  readonly conversation: IngressConversation
  readonly text: string
  readonly inReplyToMessageId?: string
}

export interface IngressReplyRequest {
  readonly trigger: Trigger
  readonly text: string
  /** A caller trying to retarget the reply. A DM origin must not land on a group. */
  readonly requested?: IngressConversation
}

/** Binding of one stable sender id on one channel instance. Not keyed by nickname. */
export interface ChannelBinding {
  readonly channelKind: string
  readonly channelId: string
  readonly senderId: string
  readonly memberId: string
}

export interface IngressEnvelope {
  readonly channelKind: string
  readonly channelId: string
  readonly message: IngressInboundMessage
}

/** A DM this channel instance is allowed to use for one member. */
export interface IngressDirectConversation {
  readonly channelKind: string
  readonly channelId: string
  readonly memberId: string
  readonly externalUserId: string
  readonly externalConversationId: string
}

export interface IngressPushRequest {
  readonly directory: FamilyDirectory
  readonly memberId: string
  readonly channelKind: string
  readonly channelId: string
  readonly text: string
  readonly directMessages: readonly IngressDirectConversation[]
  readonly groups?: readonly { readonly externalConversationId: string, readonly groupId: string }[]
}

/**
 * Structural stand-in for a gateway sidecar's inbound message.
 * Field names follow that shape so a later adapter can map them.
 * This module does not depend on `octop-gateway`.
 */
export interface GatewayContentPart {
  readonly type: 'text' | 'image' | 'file' | 'audio' | 'video'
  readonly text?: string
  readonly url?: string
  readonly alt_text?: string
  readonly filename?: string
}

export interface GatewaySubject {
  readonly subject_id: string
  readonly chat_type: 'p2p' | 'group'
  readonly metadata?: {
    readonly sender_id?: string
    readonly sender_name?: string
    readonly conversation_id?: string
    readonly message_id?: string
    readonly in_reply_to?: string
  }
}

export interface GatewayInboundMessage {
  readonly channel_id: string
  readonly channel_type: string
  readonly channel_subject: GatewaySubject
  readonly content: readonly GatewayContentPart[]
}

/** Structural stand-in for a gateway sidecar's outbound event. */
export interface GatewayMessageEvent {
  readonly type: 'message' | 'typing' | 'completed' | 'error'
  readonly content: readonly GatewayContentPart[]
  readonly error?: string
  readonly channel_id: string
  readonly channel_type: string
  readonly channel_subject: GatewaySubject
}

/** Translate a transport message without treating a nickname, mention or group id as authority. */
export function triggerFromInbound(message: IngressInboundMessage): Trigger {
  const { channelKind: source, channelId, senderId, conversation, messageId } = message
  if (!senderId.trim()) throw new IngressRejected('missing_sender_id')
  if (!source || !channelId || !messageId || !conversation.externalConversationId || !Number.isFinite(Date.parse(message.at))) throw new IngressRejected('invalid_message')
  if (conversation.scope === 'dm' && conversation.memberExternalId !== senderId) throw new IngressRejected('invalid_message')
  const thread = `${channelId}:${conversation.externalConversationId}`
  return { id: key('ingress', source, channelId, messageId), source, threads: [{ source, id: thread }],
    actor: { source, id: senderId }, human: message.senderKind === 'user',
    ...(conversation.scope === 'dm' && message.senderKind === 'user' ? { addressed: 'direct' as const } : {}),
    at: new Date(message.at).toISOString(), text: message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'),
    channel: { source, thread: `${source}:${thread}`, address: { channelId, conversationId: conversation.externalConversationId, messageId, scope: conversation.scope } },
    meta: { channelId, scope: conversation.scope, externalConversationId: conversation.externalConversationId, senderId, messageId,
      parts: message.parts, ...(message.mentioned !== undefined ? { mentioned: message.mentioned } : {}),
      ...(conversation.scope === 'group' ? { groupId: conversation.groupId } : {}) },
  }
}

/** Only an exact private-conversation reply is allowed; a caller cannot retarget private output. */
export function routeReply(request: IngressReplyRequest): IngressReply {
  const { trigger, requested } = request
  if (!trigger.channel) throw new IngressRejected('reply_target_mismatch')
  const address = trigger.channel.address
  if (address.scope !== 'dm' || requested?.scope === 'group') throw new IngressRejected('group_membership_unmodeled')
  const conversation: IngressConversation = { scope: 'dm', externalConversationId: address.conversationId ?? '', memberExternalId: String(trigger.meta.senderId ?? trigger.actor.id) }
  if (!address.channelId || !conversation.externalConversationId || (requested && (requested.externalConversationId !== conversation.externalConversationId
    || requested.memberExternalId !== conversation.memberExternalId))) throw new IngressRejected('reply_target_mismatch')
  return { channelKind: trigger.source, channelId: address.channelId, conversation, text: request.text,
    ...(address.messageId ? { inReplyToMessageId: address.messageId } : {}) }
}

/** Resolve only a unique binding on the exact transport instance. */
export function bindingFor(bindings: readonly ChannelBinding[], channel: IngressChannel, senderId: string): ChannelBinding | undefined {
  const matches = bindings.filter(item => item.channelKind === channel.kind && item.channelId === channel.id && item.senderId === senderId)
  return matches.length === 1 ? matches[0] : undefined
}

/** Ignore mismatched envelopes as well as events addressed to another instance. */
export function messagesFor(inbox: readonly IngressEnvelope[], channel: IngressChannel): readonly IngressInboundMessage[] {
  return inbox.filter(item => item.channelKind === channel.kind && item.channelId === channel.id
    && item.message.channelKind === channel.kind && item.message.channelId === channel.id).map(item => item.message)
}

/** Resolve one authorized member DM; no fallback to another peer, account instance or group. */
export function pushToMember(request: IngressPushRequest): IngressReply {
  const member = request.directory.members.find(item => item.id === request.memberId && item.status === 'active')
  const matches = request.directMessages.filter(item => item.memberId === member?.id && item.channelKind === request.channelKind && item.channelId === request.channelId
    && (() => { const bindings = request.directory.bindings.filter(binding => binding.source === request.channelKind && binding.externalId === item.externalUserId)
      return bindings.length === 1 && bindings[0]!.memberId === member?.id })())
  if (!member || matches.length !== 1) throw new IngressRejected('no_authorized_dm')
  const target = matches[0]!
  return { channelKind: request.channelKind, channelId: request.channelId, text: request.text,
    conversation: { scope: 'dm', externalConversationId: target.externalConversationId, memberExternalId: target.externalUserId } }
}

/** Adapter for a gateway-shaped event; the gateway is not a runtime dependency. */
export function triggerFromGateway(message: GatewayInboundMessage): Trigger {
  const subject = message.channel_subject, meta = subject.metadata
  const senderId = meta?.sender_id || (subject.chat_type === 'p2p' ? subject.subject_id : '')
  if (!senderId) throw new IngressRejected('missing_sender_id')
  const conversationId = meta?.conversation_id || subject.subject_id
  return triggerFromInbound({ channelKind: message.channel_type, channelId: message.channel_id, senderId, senderName: meta?.sender_name,
    senderKind: 'user', messageId: meta?.message_id ?? '', at: new Date().toISOString(),
    conversation: subject.chat_type === 'group' ? { scope: 'group', externalConversationId: conversationId, groupId: subject.subject_id }
      : { scope: 'dm', externalConversationId: conversationId, memberExternalId: senderId },
    parts: message.content.map(part => part.type === 'text' ? { type: 'text', text: part.text ?? '' }
      : part.type === 'image' ? { type: 'image', ...part.url ? { url: part.url } : {}, ...part.alt_text ? { altText: part.alt_text } : {} }
        : part.type === 'file' ? { type: 'file', ...part.url ? { url: part.url } : {}, ...part.filename ? { filename: part.filename } : {} }
          : { type: part.type, ...part.url ? { url: part.url } : {} }),
  })
}

/** Serialize an already-authorized private reply without promoting it to a group. */
export function gatewayEventFromReply(reply: IngressReply): GatewayMessageEvent {
  if (reply.conversation.scope === 'group') throw new IngressRejected('group_membership_unmodeled')
  return { type: 'message', content: [{ type: 'text', text: reply.text }], channel_id: reply.channelId, channel_type: reply.channelKind,
    channel_subject: { subject_id: reply.conversation.memberExternalId, chat_type: 'p2p', metadata: {
      sender_id: reply.conversation.memberExternalId, conversation_id: reply.conversation.externalConversationId,
      ...reply.inReplyToMessageId ? { in_reply_to: reply.inReplyToMessageId } : {},
    } } }
}

