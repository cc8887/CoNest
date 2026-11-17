/** Real DSH kernel for M0 transport/model verification; deliberately registers no host work tools. */
import { Context } from '@deepseek-ai/cordis'
import Llm, { MessageId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Pi from '@deepseek-ai/dsh-llm-pi-ai'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

export interface ModelConfig { baseURL: string; model: string; apiKeyEnv: string }
export interface ModelEvidence {
  sessionId: string
  text: string
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
}

/** One kernel, fresh isolated Session per inbound message; no SuperAgent Ticket state is created by this probe. */
export class DshProbe {
  private readonly ctx = new Context()
  private constructor(private readonly config: ModelConfig, private readonly root: string) {}

  static async start(config: ModelConfig, root: string): Promise<DshProbe> {
    const runtime = new DshProbe(config, root)
    const ctx = runtime.ctx
    try {
      await Promise.all([
        ctx.plugin(Llm), ctx.plugin(Sessions), ctx.plugin(Agents), ctx.plugin(Projections),
        ctx.plugin(Prompt, { includeHarnessIdentity: false, includeRuntimeContext: false }), ctx.plugin(Tools),
        ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' }),
        ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 }),
        ctx.plugin(Pi, { providers: { 'conest-m0': {
          api: 'openai-completions', baseURL: config.baseURL, apiKeyEnv: config.apiKeyEnv,
          models: [{ id: config.model, input: ['text'], maxTokens: 2048 }],
          compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
          retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 45_000, streamIdleTimeoutMs: 30_000,
        } } }),
      ])
      return runtime
    } catch (error) { await ctx.fiber.dispose(); throw error }
  }

  async run(text: string, signal?: AbortSignal): Promise<ModelEvidence> {
    signal?.throwIfAborted()
    const sessionId = SessionId(`conest-m0-${randomUUID()}`)
    let toolCalls = 0
    const argsSchema = z.object({ value: z.literal('OK') }).strict()
    const handle = await this.ctx.agents.create({ sessionId,
      meta: { cwd: this.root }, agentOptions: { provider: 'conest-m0', model: this.config.model, maxTokens: 2048 },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: 'conest-m0', order: 0, complete: true,
          text: 'You are CoNest M0, a connectivity test. For every request, first call conest_probe once with value OK. '
            + 'After the tool result, reply briefly in the user\'s language. If the request is a probe, reply exactly OK. '
            + 'You have no file, shell, external-action or member-data tools.' })
        agentCtx.tools.register({ name: 'conest_probe', description: 'Verify the DSH tool round trip. No side effects.',
          parameters: z.toJSONSchema(argsSchema),
          async execute(args) { argsSchema.parse(args); if (++toolCalls > 2) throw new Error('M0 tool limit reached'); return { value: 'OK' } },
          output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        })
      },
    })
    const agent = handle.agent
    const timeout = AbortSignal.timeout(60_000)
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
    const cancel = () => agent.cancel({ kind: 'hook', reason: 'M0 request cancelled or timed out' })
    abort.addEventListener('abort', cancel, { once: true })
    try {
      abort.throwIfAborted()
      agent.followup({ id: MessageId(randomUUID()), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      await agent.whenIdle()
      abort.throwIfAborted()
      const events = agent.session.snapshotEvents()
      const last = events.findLast(event => event.type === 'turn/end')
      if (last?.type !== 'turn/end' || last.data.reason.kind !== 'completed') throw new Error('DSH turn did not complete; inspect its local Session')
      const replies = events.filter(event => event.type === 'assistant/message')
      const result: ModelEvidence = { sessionId, text: '', modelCalls: replies.length, toolCalls, inputTokens: 0, outputTokens: 0 }
      for (const event of replies) {
        result.text += event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        result.inputTokens += event.data.usage?.inputTokens ?? 0
        result.outputTokens += event.data.usage?.outputTokens ?? 0
      }
      if (!result.text.trim() || toolCalls === 0) throw new Error('DSH probe needs a tool result and a nonempty final answer')
      await this.ctx.sessionPersistence.flush()
      return result
    } finally {
      abort.removeEventListener('abort', cancel)
      await handle.dispose()
    }
  }

  async close(): Promise<void> { await this.ctx.fiber.dispose() }
}
