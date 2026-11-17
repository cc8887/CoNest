/**
 * Contracts for CoNest message-stream ingress, translated from the behavior of
 * a gateway's inbound message, reply, channel isolation, and proactive push.
 * They are not a port of that gateway and they do not import it.
 *
 * `current:` cases use the family helper that already exists. `unimplemented:`
 * cases lock the fact that ingress is not wired. `contract:` cases describe
 * the intended mapping. Those call `src/ingress/not-connected.ts` and fail
 * until a connected implementation replaces that stub. Nothing here boots the
 * Engine, opens the Store, or calls a model.
 *
 * Group collaboration is not asserted as supported. A group conversation stays
 * `group_membership_unmodeled`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { authorize, emptyDirectory, type FamilyDirectory, type Member } from '../src/family/index.ts'
import {
  bindingFor, gatewayEventFromReply, messagesFor, pushToMember, routeReply, triggerFromGateway, triggerFromInbound,
  IngressNotConnected, IngressRejected,
  type ChannelBinding, type GatewayInboundMessage, type IngressDirectConversation, type IngressEnvelope,
  type IngressInboundMessage, type IngressPushRequest, type IngressReply,
} from '../src/ingress/not-connected.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const AT = '2026-01-02T03:04:05.000Z'
const ada: Member = { id: 'member-ada', displayName: 'Ada Lovelace', status: 'active' }
const bo: Member = { id: 'member-bo', displayName: 'Bo', status: 'active' }
const cy: Member = { id: 'member-cy', displayName: 'Cy', status: 'disabled' }

function directory(): FamilyDirectory {
  return {
    ...emptyDirectory(),
    members: [ada, bo, cy],
    bindings: [
      { id: 'bind-ada', memberId: ada.id, source: 'feishu', externalId: 'ou_ada' },
      { id: 'bind-bo', memberId: bo.id, source: 'feishu', externalId: 'ou_bo' },
      { id: 'bind-bo-github', memberId: bo.id, source: 'github', externalId: 'bo' },
      { id: 'bind-cy', memberId: cy.id, source: 'feishu', externalId: 'ou_cy' },
    ],
  }
}

function dmMessage(overrides: Partial<IngressInboundMessage> = {}): IngressInboundMessage {
  return {
    channelKind: 'feishu',
    channelId: 'bot-home',
    senderId: 'ou_ada',
    senderName: 'Ada Lovelace',
    senderKind: 'user',
    conversation: { scope: 'dm', externalConversationId: 'oc_ada', memberExternalId: 'ou_ada' },
    messageId: 'om_1',
    at: AT,
    parts: [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
      { type: 'image', url: 'https://example.test/cat.png', altText: 'cat' },
      { type: 'file', url: 'https://example.test/note.txt', filename: 'note.txt' },
    ],
    ...overrides,
  }
}

function groupMessage(): IngressInboundMessage {
  return {
    ...dmMessage(),
    messageId: 'om_g',
    senderName: 'Ada',
    mentioned: true,
    parts: [{ type: 'text', text: 'hello room' }],
    conversation: { scope: 'group', externalConversationId: 'oc_room', groupId: 'oc_room' },
  }
}

/** The Trigger shape normalization must produce for `dmMessage()`. Built by hand so reply tests do not call it. */
function dmTrigger(): Trigger {
  return {
    id: key('ingress', 'feishu', 'bot-home', 'om_1'),
    source: 'feishu',
    threads: [{ source: 'feishu', id: 'bot-home:oc_ada' }],
    actor: { source: 'feishu', id: 'ou_ada' },
    human: true,
    addressed: 'direct',
    at: AT,
    text: 'line 1\nline 2',
    channel: {
      source: 'feishu',
      thread: 'feishu:bot-home:oc_ada',
      address: { channelId: 'bot-home', conversationId: 'oc_ada', messageId: 'om_1', scope: 'dm' },
    },
    meta: { channelId: 'bot-home', scope: 'dm', externalConversationId: 'oc_ada', senderId: 'ou_ada', messageId: 'om_1' },
  }
}

function raised(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the ingress contract to reject, but the call returned')
}

const homeDm: IngressDirectConversation = {
  channelKind: 'feishu', channelId: 'bot-home', memberId: ada.id, externalUserId: 'ou_ada', externalConversationId: 'oc_ada',
}
const boDm: IngressDirectConversation = {
  channelKind: 'feishu', channelId: 'bot-home', memberId: bo.id, externalUserId: 'ou_bo', externalConversationId: 'oc_bo',
}
const workDm: IngressDirectConversation = {
  channelKind: 'feishu', channelId: 'bot-work', memberId: ada.id, externalUserId: 'ou_ada', externalConversationId: 'oc_ada_work',
}

function push(overrides: Partial<IngressPushRequest> = {}): IngressPushRequest {
  return {
    directory: directory(),
    memberId: ada.id,
    channelKind: 'feishu',
    channelId: 'bot-home',
    text: 'dinner is ready',
    directMessages: [homeDm, boDm, workDm],
    groups: [{ externalConversationId: 'oc_room', groupId: 'oc_room' }],
    ...overrides,
  }
}

describe('message ingress contracts', () => {
  it('contract: inbound DM becomes a Trigger that keeps the channel instance, stable sender id, text, and parts', () => {
    const message = dmMessage()
    const trigger = triggerFromInbound(message)
    expect(trigger).toMatchObject({
      id: key('ingress', 'feishu', 'bot-home', 'om_1'),
      source: 'feishu',
      threads: [{ source: 'feishu', id: 'bot-home:oc_ada' }],
      actor: { source: 'feishu', id: 'ou_ada' },
      human: true,
      addressed: 'direct',
      at: AT,
      text: 'line 1\nline 2',
      channel: {
        source: 'feishu',
        thread: 'feishu:bot-home:oc_ada',
        address: { channelId: 'bot-home', conversationId: 'oc_ada', messageId: 'om_1', scope: 'dm' },
      },
    })
    expect(trigger.meta).toMatchObject({
      channelId: 'bot-home',
      scope: 'dm',
      externalConversationId: 'oc_ada',
      senderId: 'ou_ada',
      messageId: 'om_1',
      parts: message.parts,
    })
    expect(trigger.actor.id).not.toBe(message.senderName)
    expect(JSON.stringify({ actor: trigger.actor, threads: trigger.threads, channel: trigger.channel })).not.toContain('Ada Lovelace')
  })

  it('contract: inbound group keeps the sender id and group scope, and a mention is not membership', () => {
    const trigger = triggerFromInbound(groupMessage())
    expect(trigger).toMatchObject({
      id: key('ingress', 'feishu', 'bot-home', 'om_g'),
      source: 'feishu',
      threads: [{ source: 'feishu', id: 'bot-home:oc_room' }],
      actor: { source: 'feishu', id: 'ou_ada' },
      human: true,
      at: AT,
      text: 'hello room',
      channel: {
        source: 'feishu',
        thread: 'feishu:bot-home:oc_room',
        address: { channelId: 'bot-home', conversationId: 'oc_room', messageId: 'om_g', scope: 'group' },
      },
    })
    expect(trigger.addressed).toBeUndefined()
    expect(trigger.actor.id).not.toBe('Ada')
    expect(trigger.actor.id).not.toBe('oc_room')
    expect(trigger.meta).toMatchObject({ scope: 'group', groupId: 'oc_room', senderId: 'ou_ada', mentioned: true, channelId: 'bot-home' })
  })

  it('contract: a reply goes back to the conversation that produced the Trigger', () => {
    expect(routeReply({ trigger: dmTrigger(), text: 'done' })).toEqual({
      channelKind: 'feishu',
      channelId: 'bot-home',
      conversation: { scope: 'dm', externalConversationId: 'oc_ada', memberExternalId: 'ou_ada' },
      text: 'done',
      inReplyToMessageId: 'om_1',
    })
  })

  it('contract: a private result is not delivered to a group', () => {
    const error = raised(() => routeReply({
      trigger: dmTrigger(),
      text: 'secret',
      requested: { scope: 'group', externalConversationId: 'oc_room', groupId: 'oc_room' },
    }))
    expect(error).toBeInstanceOf(IngressRejected)
    expect(error).toMatchObject({ code: 'group_membership_unmodeled' })
  })

  it('contract: two channels of the same kind do not share messages', () => {
    const home = dmMessage({ messageId: 'om_home', parts: [{ type: 'text', text: 'home secret' }] })
    const work = dmMessage({ channelId: 'bot-work', messageId: 'om_work', parts: [{ type: 'text', text: 'work secret' }] })
    const inbox: IngressEnvelope[] = [
      { channelKind: 'feishu', channelId: 'bot-home', message: home },
      { channelKind: 'feishu', channelId: 'bot-work', message: work },
    ]
    expect(messagesFor(inbox, { kind: 'feishu', id: 'bot-home' })).toEqual([home])
    expect(messagesFor(inbox, { kind: 'feishu', id: 'bot-work' })).toEqual([work])
    expect(messagesFor(inbox, { kind: 'github', id: 'bot-home' })).toEqual([])
  })

  it('contract: two channels of the same kind do not share identity bindings', () => {
    const bindings: ChannelBinding[] = [
      { channelKind: 'feishu', channelId: 'bot-home', senderId: 'ou_ada', memberId: ada.id },
      { channelKind: 'feishu', channelId: 'bot-work', senderId: 'ou_ada', memberId: 'member-ada-work' },
      { channelKind: 'github', channelId: 'bot-home', senderId: 'ou_ada', memberId: 'member-other' },
    ]
    expect(bindingFor(bindings, { kind: 'feishu', id: 'bot-home' }, 'ou_ada')).toEqual(bindings[0])
    expect(bindingFor(bindings, { kind: 'feishu', id: 'bot-work' }, 'ou_ada')?.memberId).toBe('member-ada-work')
    expect(bindingFor(bindings, { kind: 'github', id: 'bot-home' }, 'ou_ada')?.memberId).toBe('member-other')
    expect(bindingFor(bindings, { kind: 'feishu', id: 'bot-home' }, 'Ada Lovelace')).toBeUndefined()
    expect(bindingFor(bindings, { kind: 'feishu', id: 'bot-other' }, 'ou_ada')).toBeUndefined()
  })

  it('contract: a proactive push targets that member\'s authorized DM on that channel instance', () => {
    const reply = pushToMember(push())
    expect(reply).toEqual({
      channelKind: 'feishu',
      channelId: 'bot-home',
      conversation: { scope: 'dm', externalConversationId: 'oc_ada', memberExternalId: 'ou_ada' },
      text: 'dinner is ready',
    })
    expect(reply.conversation.scope).toBe('dm')
    if (reply.conversation.scope === 'dm') {
      expect(authorize(directory(), {
        action: 'speak_in',
        actor: { memberId: ada.id },
        conversation: { kind: 'dm', source: 'feishu', externalConversationId: reply.conversation.externalConversationId, memberId: ada.id },
      })).toEqual({ allow: true })
    }
  })

  it('contract: a proactive push does not fall back to another member, another instance, or a group', () => {
    const error = raised(() => pushToMember(push({
      directMessages: [boDm, workDm],
    })))
    expect(error).toBeInstanceOf(IngressRejected)
    expect(error).toMatchObject({ code: 'no_authorized_dm' })
  })
})

describe('gateway sidecar shape', () => {
  it('contract: a gateway InboundMessage maps to a Trigger and does not use the nickname or the group id as the actor', () => {
    const direct = triggerFromGateway({
      channel_id: 'bot-home',
      channel_type: 'feishu',
      channel_subject: {
        subject_id: 'ou_ada',
        chat_type: 'p2p',
        metadata: { sender_id: 'ou_ada', sender_name: 'Ada Lovelace', conversation_id: 'oc_ada', message_id: 'om_1' },
      },
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', url: 'https://example.test/cat.png', alt_text: 'cat' },
      ],
    })
    expect(direct).toMatchObject({
      id: key('ingress', 'feishu', 'bot-home', 'om_1'),
      source: 'feishu',
      threads: [{ source: 'feishu', id: 'bot-home:oc_ada' }],
      actor: { source: 'feishu', id: 'ou_ada' },
      human: true,
      addressed: 'direct',
      text: 'see this',
      channel: {
        source: 'feishu',
        thread: 'feishu:bot-home:oc_ada',
        address: { channelId: 'bot-home', conversationId: 'oc_ada', messageId: 'om_1', scope: 'dm' },
      },
    })
    expect(direct.meta).toMatchObject({
      channelId: 'bot-home',
      scope: 'dm',
      externalConversationId: 'oc_ada',
      senderId: 'ou_ada',
      messageId: 'om_1',
      parts: [
        { type: 'text', text: 'see this' },
        { type: 'image', url: 'https://example.test/cat.png', altText: 'cat' },
      ],
    })
    expect(direct.actor.id).not.toBe('Ada Lovelace')

    const room = triggerFromGateway({
      channel_id: 'bot-home',
      channel_type: 'feishu',
      channel_subject: {
        subject_id: 'oc_room',
        chat_type: 'group',
        metadata: { sender_id: 'ou_ada', sender_name: 'Ada', conversation_id: 'oc_room', message_id: 'om_g' },
      },
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'team' }],
    })
    expect(room.id).toBe(key('ingress', 'feishu', 'bot-home', 'om_g'))
    expect(room.actor).toEqual({ source: 'feishu', id: 'ou_ada' })
    expect(room.actor.id).not.toBe('oc_room')
    expect(room.actor.id).not.toBe('Ada')
    expect(room.text).toBe('hello\nteam')
    expect(room.addressed).toBeUndefined()
    expect(room.meta).toMatchObject({ scope: 'group', groupId: 'oc_room', channelId: 'bot-home', senderId: 'ou_ada' })
    expect(room.threads).toEqual([{ source: 'feishu', id: 'bot-home:oc_room' }])
  })

  it('contract: a gateway group InboundMessage without a stable sender id is rejected', () => {
    const message: GatewayInboundMessage = {
      channel_id: 'bot-home',
      channel_type: 'feishu',
      channel_subject: {
        subject_id: 'oc_room',
        chat_type: 'group',
        metadata: { sender_name: 'Ada', conversation_id: 'oc_room', message_id: 'om_g' },
      },
      content: [{ type: 'text', text: 'hello' }],
    }
    const error = raised(() => triggerFromGateway(message))
    expect(error).toBeInstanceOf(IngressRejected)
    expect(error).toMatchObject({ code: 'missing_sender_id' })
  })

  it('contract: a DM reply maps to a gateway MessageEvent on that DM', () => {
    const reply: IngressReply = {
      channelKind: 'feishu',
      channelId: 'bot-home',
      conversation: { scope: 'dm', externalConversationId: 'oc_ada', memberExternalId: 'ou_ada' },
      text: 'done',
      inReplyToMessageId: 'om_1',
    }
    expect(gatewayEventFromReply(reply)).toEqual({
      type: 'message',
      content: [{ type: 'text', text: 'done' }],
      channel_id: 'bot-home',
      channel_type: 'feishu',
      channel_subject: {
        subject_id: 'ou_ada',
        chat_type: 'p2p',
        metadata: { sender_id: 'ou_ada', conversation_id: 'oc_ada', in_reply_to: 'om_1' },
      },
    })
  })

  it('contract: a gateway MessageEvent is not emitted for a group', () => {
    const error = raised(() => gatewayEventFromReply({
      channelKind: 'feishu',
      channelId: 'bot-home',
      conversation: { scope: 'group', externalConversationId: 'oc_room', groupId: 'oc_room' },
      text: 'secret',
    }))
    expect(error).toBeInstanceOf(IngressRejected)
    expect(error).toMatchObject({ code: 'group_membership_unmodeled' })
  })
})

describe('message ingress as it stands', () => {
  it('current: group membership stays unmodeled, including a mentioned sender', () => {
    const room = { kind: 'group' as const, source: 'feishu', externalConversationId: 'oc_room', groupId: 'oc_room' }
    const home = directory()
    expect(authorize(home, { action: 'speak_in', actor: { source: 'feishu', externalId: 'ou_ada' }, conversation: room }))
      .toEqual({ allow: false, reason: 'group_membership_unmodeled' })
    expect(authorize(home, { action: 'speak_in', actor: { memberId: ada.id }, conversation: room }))
      .toEqual({ allow: false, reason: 'group_membership_unmodeled' })
  })

  it('current: a nickname is not a channel identity', () => {
    const dm = { kind: 'dm' as const, source: 'feishu', externalConversationId: 'oc_ada', memberId: ada.id }
    const home = directory()
    expect(authorize(home, { action: 'speak_in', actor: { source: 'feishu', externalId: ada.displayName }, conversation: dm }))
      .toEqual({ allow: false, reason: 'unbound' })
    expect(authorize(home, { action: 'read_memory', actor: { source: 'feishu', externalId: ada.displayName }, ownerMemberId: ada.id }))
      .toEqual({ allow: false, reason: 'unbound' })
    expect(authorize(home, { action: 'speak_in', actor: { source: 'feishu', externalId: 'ou_ada' }, conversation: dm }))
      .toEqual({ allow: true })
  })

  it('current: speak_in allows only that member\'s own DM on the same source', () => {
    const adaDm = { kind: 'dm' as const, source: 'feishu', externalConversationId: 'oc_ada', memberId: ada.id }
    const boDmScope = { kind: 'dm' as const, source: 'feishu', externalConversationId: 'oc_bo', memberId: bo.id }
    const home = directory()
    expect(authorize(home, { action: 'speak_in', actor: { memberId: ada.id }, conversation: adaDm })).toEqual({ allow: true })
    expect(authorize(home, { action: 'speak_in', actor: { memberId: ada.id }, conversation: boDmScope }))
      .toEqual({ allow: false, reason: 'not_dm_member' })
    expect(authorize(home, { action: 'speak_in', actor: { source: 'github', externalId: 'bo' }, conversation: adaDm }))
      .toEqual({ allow: false, reason: 'source_mismatch' })
  })

  it('unimplemented: ingress operations throw IngressNotConnected', () => {
    const reply: IngressReply = {
      channelKind: 'feishu', channelId: 'bot-home', text: 'done',
      conversation: { scope: 'dm', externalConversationId: 'oc_ada', memberExternalId: 'ou_ada' },
    }
    expect(() => triggerFromInbound(dmMessage())).toThrow(IngressNotConnected)
    expect(() => routeReply({ trigger: dmTrigger(), text: 'done' })).toThrow(IngressNotConnected)
    expect(() => bindingFor([], { kind: 'feishu', id: 'bot-home' }, 'ou_ada')).toThrow(IngressNotConnected)
    expect(() => messagesFor([], { kind: 'feishu', id: 'bot-home' })).toThrow(IngressNotConnected)
    expect(() => pushToMember(push())).toThrow(IngressNotConnected)
    expect(() => triggerFromGateway({
      channel_id: 'bot-home', channel_type: 'feishu',
      channel_subject: { subject_id: 'ou_ada', chat_type: 'p2p' }, content: [{ type: 'text', text: 'hi' }],
    })).toThrow(IngressNotConnected)
    expect(() => gatewayEventFromReply(reply)).toThrow(IngressNotConnected)
  })

  it('unimplemented: the ingress stub is not wired into plugin entrypoints or package exports', () => {
    expect(readdirSync(join(ROOT, 'src/ingress'))).toEqual(['not-connected.ts'])
    const entrypoints = ['src/index.ts', 'src/app/runtime.ts', 'src/sources/github.ts', 'src/sources/feishu.ts', 'src/client/index.tsx']
    for (const file of entrypoints) {
      const text = read(file)
      expect(text, file).not.toMatch(/from ['"][^'"]*(?:\/family|\/ingress)/)
      expect(text, file).not.toContain('octop-gateway')
      expect(text, file).not.toContain('not-connected')
    }
    for (const file of ['cordis.patch.yml', 'tsdown.config.ts', 'package.json']) {
      const text = read(file)
      expect(text, file).not.toContain('ingress')
      expect(text, file).not.toContain('octop-gateway')
      expect(text, file).not.toMatch(/weixin|wechat|ilink/)
    }
    const pkg = JSON.parse(read('package.json')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './client', './feishu-watch', './github-watch', './locale/*.json', './package.json'])
  })

  it('unimplemented: no WeChat, WeChat Claw, or iLink Source is registered', () => {
    const registry = new SourceRegistry(() => SettingsSchema.parse({}))
    registry.register(githubKind)
    registry.register(feishuKind)
    for (const kind of ['weixin', 'wechat', 'wechat-claw', 'ilink']) expect(registry.kind(kind), kind).toBeUndefined()
    expect(registry.kind('github')).toBe(githubKind)
    expect(registry.kind('feishu')).toBe(feishuKind)
  })

  it('unimplemented: octop-gateway is not a runtime dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>, devDependencies?: Record<string, string>, peerDependencies?: Record<string, string> }
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]
    expect(names).not.toContain('octop-gateway')
  })
})
