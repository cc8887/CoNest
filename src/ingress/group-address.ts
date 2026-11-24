/** Chooses one recipient from trusted channel metadata before consulting a model. */
import { z } from 'zod'

export interface GroupBot { id: string; addresses: readonly string[]; names: readonly string[]; role: string }
export const GroupJudgmentSchema = z.object({
  respond: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().trim().min(1).max(300),
  targetBotId: z.string().nullable(),
}).strict()
export type GroupJudgment = z.infer<typeof GroupJudgmentSchema>
export type GroupAddress = { botId: string; via: 'mention' | 'reply' | 'waiting' | 'name' | 'semantic'; confidence?: number }

export interface GroupReference { senderIds: readonly string[]; bot: boolean; mentions: readonly string[] }
interface GroupMessage { senderId: string; text: string; mentions: readonly string[]; hasParent: boolean }
interface GroupRouting {
  bots: readonly GroupBot[]
  localBotId: string
  autonomousBotId: string
  /** `undefined` means the reference could not be verified. */
  parent(): Promise<GroupReference | undefined>
  root?(): Promise<GroupReference | undefined>
  waiting(): boolean
  classify(): Promise<GroupJudgment | undefined>
  history: boolean
}

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase()
const vocative = /^(?:\s*[,、:!?]|\s+(?:please\b|can you\b|could you\b|would you\b)|\s*(?:请|帮我|能否|可以))/u

/** Recognize a leading form of address while leaving incidental names to the classifier. */
function calledBots(text: string, bots: readonly GroupBot[]): GroupBot[] {
  const start = normalize(text).trimStart().replace(/^@\s*/, '')
  return bots.filter(bot => bot.names.some(name => {
    const alias = normalize(name).trim()
    return alias && start.startsWith(alias) && vocative.test(start.slice(alias.length))
  }))
}

export async function groupAddress(message: GroupMessage, routing: GroupRouting): Promise<GroupAddress | undefined> {
  const { bots, localBotId, autonomousBotId } = routing
  const byAddress = (id: string) => bots.find(bot => bot.addresses.includes(id))
  const firstBot = (ids: readonly string[]) => ids.map(byAddress).find(bot => bot !== undefined)
  const mentioned = firstBot(message.mentions)
  if (mentioned) return { botId: mentioned.id, via: 'mention' }
  // Recovery can replay explicit mentions. Unaddressed historical chatter cannot start work.
  if (routing.history) return
  if (message.hasParent) {
    const parent = await routing.parent()
    if (!parent) return
    if (parent.bot) {
      const bot = firstBot(parent.senderIds)
      return bot ? { botId: bot.id, via: 'reply' } : undefined
    }
    if (!parent.senderIds.includes(message.senderId)) return
  }
  if (message.mentions.length) return
  const called = calledBots(message.text, bots)
  if (called.length > 1) return
  // Different bot connections can read the same topic root without sharing any private session state.
  let owner: string | undefined = autonomousBotId
  if (routing.root) {
    const root = await routing.root()
    owner = root?.bot ? firstBot(root.senderIds)?.id : root && (firstBot(root.mentions)?.id ?? autonomousBotId)
  }
  if (localBotId === owner && (!called.length || called[0]!.id === localBotId) && routing.waiting()) {
    return { botId: localBotId, via: 'waiting' }
  }
  if (called[0]) return { botId: called[0].id, via: 'name' }
  if (localBotId !== owner || !message.text.trim()) return
  const result = await routing.classify()
  if (result?.respond && result.confidence >= 0.85 && result.targetBotId === localBotId) {
    return { botId: localBotId, via: 'semantic', confidence: result.confidence }
  }
}
