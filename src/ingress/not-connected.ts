/**
 * Unwired stub for CoNest message-stream ingress.
 *
 * The contracts live in `tests/message-ingress.spec.ts`. This file exports the
 * types those tests name and nothing else: every operation throws
 * `IngressNotConnected`. It is not a Source plugin, does not persist Tickets
 * or bindings, and does not import a gateway package.
 *
 * Do not import this from `src/index.ts`, `src/sources/github.ts`,
 * `src/sources/feishu.ts`, or `src/client/index.tsx`. Do not register it in
 * `cordis.patch.yml`, `package.json` exports, or `tsdown.config.ts`.
 *
 * Copyright for this file is the repository's MIT license (see LICENSE).
 * The DeepSeek Harness Team copyright on the imported prototype is unchanged.
 */
import type { Trigger } from '../core/model.ts'
import type { FamilyDirectory } from '../family/domain.ts'

/** Raised because message ingress is not connected to the DSH runtime. */
export class IngressNotConnected extends Error {
  readonly code = 'ingress_not_connected' as const
  constructor(operation: string) {
    super(`message ingress is not connected: ${operation}`)
    this.name = 'IngressNotConnected'
  }
}

/** Codes a connected ingress uses when it refuses a delivery. The stub never throws these. */
export type IngressRejectCode = 'group_membership_unmodeled' | 'no_authorized_dm' | 'missing_sender_id'

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

function notConnected(operation: string): never {
  throw new IngressNotConnected(operation)
}

/** Map one unified inbound message to a DSH Trigger. Not connected. */
export function triggerFromInbound(message: IngressInboundMessage): Trigger {
  return notConnected(`triggerFromInbound:${message.messageId}`)
}

/** Reply to the conversation that produced `trigger`. Not connected. */
export function routeReply(request: IngressReplyRequest): IngressReply {
  return notConnected(`routeReply:${request.trigger.id}`)
}

/** The binding for this channel instance and stable sender id, or none. Not connected. */
export function bindingFor(bindings: readonly ChannelBinding[], channel: IngressChannel, senderId: string): ChannelBinding | undefined {
  return notConnected(`bindingFor:${channel.kind}:${channel.id}:${senderId}:${bindings.length}`)
}

/** Messages accepted on this channel instance only. Not connected. */
export function messagesFor(inbox: readonly IngressEnvelope[], channel: IngressChannel): readonly IngressInboundMessage[] {
  return notConnected(`messagesFor:${channel.kind}:${channel.id}:${inbox.length}`)
}

/** Send to one bound member's authorized DM. Not connected. */
export function pushToMember(request: IngressPushRequest): IngressReply {
  return notConnected(`pushToMember:${request.memberId}`)
}

/** Map a gateway-shaped inbound message onto a DSH Trigger. Not connected. */
export function triggerFromGateway(message: GatewayInboundMessage): Trigger {
  return notConnected(`triggerFromGateway:${message.channel_id}`)
}

/** Map a CoNest reply onto a gateway-shaped message event. Not connected. */
export function gatewayEventFromReply(reply: IngressReply): GatewayMessageEvent {
  return notConnected(`gatewayEventFromReply:${reply.channelId}`)
}
