import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel, selectRouterModel } from '../src/app/role-models.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const defaultEffort = ReasoningEffortId('high')
  const resolve = vi.fn(async (value: ModelSelection) => ({ reasoningEffort: defaultEffort, ...value }))
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const options = { provider: 'host', model: 'default', reasoningEffort: defaultEffort }
  const model = new AgentModel(() => {
    const pending = session.snapshotEvents().findLast(event => event.type === 'model/selection')?.data ?? null
    return { pending, lastUsed: session.requestHeader()?.config ?? null }
  }, session, options)
  const agent = { session, model, options }
  return { ctx, agent, resolve, flush, options }
}

it('persists a new worker choice without pinning the adapter default effort or changing the host default', async () => {
  const { ctx, agent, flush, options } = fixture()
  const worker = { provider: 'worker-provider', model: 'worker-model' }
  await initializeRoleModel(ctx, agent, worker)
  expect(agent.model.current()).toEqual(worker)
  expect(agent.session.snapshotEvents()).toEqual([expect.objectContaining({ type: 'model/selection', data: worker })])
  expect(flush).toHaveBeenCalledOnce()
  expect(options).toMatchObject({ provider: 'host', model: 'default' })

  const manual = { provider: 'manual', model: 'other', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  await initializeRoleModel(ctx, agent, worker)
  expect(agent.model.current()).toEqual(manual)
})

it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.model.select(existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(agent.model.current()).toEqual(existing)
})

it('refreshes a private router before the next delivery and restores the host route when unset', async () => {
  const { ctx, agent, options } = fixture()
  const configured = { provider: 'conest', model: 'hy4-flash', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select({ provider: 'conest', model: 'hy4', reasoningEffort: ReasoningEffortId('high') })
  await selectRouterModel(ctx, agent, configured)
  await selectRouterModel(ctx, agent, configured)
  expect(agent.model.current()).toEqual(configured)
  expect(agent.session.snapshotEvents()).toHaveLength(2)

  await selectRouterModel(ctx, agent, null)
  expect(agent.model.current()).toEqual(options)
})

it('inherits the host for an unconfigured worker and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, options } = fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toEqual(options)
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents()).toHaveLength(0)
})
