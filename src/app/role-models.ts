/** Selects model routes on managed Sessions without changing the DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(model.reasoningEffort && value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Refresh the private router's choice before it can start preparing a model step. */
export async function selectRouterModel(ctx: Context, agent: Pick<Agent, 'model' | 'options'>, model: RoleModel | null): Promise<void> {
  if (model) {
    agent.model.select(await resolveRoleModel(ctx, model))
  } else {
    const { provider, model: fallback, reasoningEffort } = agent.options
    if (provider && fallback) agent.model.select({ provider, model: fallback, ...(reasoningEffort ? { reasoningEffort } : {}) })
  }
}

/** Seed a role's configured model on a new Session and preserve existing choices on resume. */
export async function initializeRoleModel(ctx: Context, agent: Pick<Agent, 'model' | 'session'>, model: RoleModel | null): Promise<void> {
  const hasSelection = () => agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')
  if (!model || hasSelection()) return
  const selected = await resolveRoleModel(ctx, model)
  if (hasSelection()) return
  agent.model.select(selected)
  await ctx.sessionPersistence.flush()
}
