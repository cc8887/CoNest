/** Real Runtime/Engine/Store integration; only DSH model driving and external HTTP are test adapters. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRuntime, type Host } from './fixtures/host.ts'
import { createWeixinKind, pollWeixin, sendWeixin, weixinActorId, weixinTrigger, type WeixinConfig } from '../src/sources/weixin.ts'
import { WeixinClient, type WeixinAccount } from '../src/sources/weixin-api.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { Commands } from '../src/infra/commands.ts'
import { workerGitConfig } from '../src/infra/environment.ts'
import { initializeWeixin } from '../src/app/weixin-setup.ts'
import { Store } from '../src/app/store.ts'

let h: Host | undefined, credentialsDir: string | undefined
afterEach(async () => { if (h) await h.stop(); h = undefined; if (credentialsDir) rmSync(credentialsDir,{recursive:true,force:true}); credentialsDir=undefined })
const account: WeixinAccount = { id:'bot-a', ownerId:'owner-a', token:'private-bot-token', baseURL:'https://ilinkai.weixin.qq.com/' }
const msg = (id='1', text='整理资料清单', sender=account.ownerId) => ({ message_id:id, from_user_id:sender, message_type:1, message_state:2,
  context_token:'private-context-token', item_list:[{type:1,text_item:{text}}] })
async function host() {
  credentialsDir=mkdtempSync(join(tmpdir(),'weixin-runtime-'))
  const file=join(credentialsDir,'account.json');writeFileSync(file,JSON.stringify(account),{mode:0o600})
  const config:WeixinConfig={credentialsFile:file,accountId:account.id,ownerId:account.ownerId}
  h=await startRuntime(store=>{
    const settings=store.settings()
    store.saveSettings({...settings,sources:{github:{enabled:false,config:{}},feishu:{enabled:false,config:{}},weixin:{enabled:true,config}},
      policy:{...settings.policy,sources:{weixin:{allowed:[{id:weixinActorId(account.id,account.ownerId)}]}}}})
  })
  let source:SourceContext
  const sent:Record<string,unknown>[]=[]
  let messages=[msg()]
  const fetcher=vi.fn<typeof fetch>(async(url,options)=>{
    if (String(url).endsWith('/getupdates')) return new Response(JSON.stringify({ret:0,get_updates_buf:'cursor-next',msgs:messages}))
    sent.push(JSON.parse(String(options?.body)));return new Response('{"ret":0}')
  })
  const client=new WeixinClient(fetcher),kind=createWeixinKind(()=>source,client)
  h.runtime.sources.register(kind);source=h.runtime.context(kind)
  return {h,config,source,client,sent,fetcher,setMessages:(next:typeof messages)=>{messages=next}}
}

it('starts the main Runtime with GitHub disabled and does not probe or borrow any GitHub account',async()=>{
  const {h}=await host()
  expect(h.runtime.configured()).toBe(true)
  expect(h.runtime.deployment.github).toBeUndefined()
  expect(h.runtime.deployment.repository).toBe('')
  expect(h.subprocess.spawn.mock.calls.flatMap(([call])=>call.argv).join(' ')).not.toMatch(/api user|repos\//)
  expect(readFileSync(workerGitConfig(h.directory),'utf8')).not.toContain('github.com')
  const commands=new Commands(()=>h.runtime.deployment,h.runtime.setup.commandEnvironment,h.runtime.lifetime)
  await expect(commands.api('issues/1')).rejects.toThrow('GitHub Source is disabled')
})

it('creates an actual Ticket from Weixin, delivers a worker question, resumes on a DM and replies through the outbox',async()=>{
  const {h,config,source,client,sent,setMessages}=await host()
  expect(await pollWeixin(source,client,config)).toBe(1)
  await h.runtime.idle()
  const trigger=weixinTrigger(account,msg())!
  const routed=await h.route({kind:'accept',trigger_id:trigger.id,title:'整理资料',worktree_name:'organize-notes',acknowledgement:'已接单'})
  await h.runtime.idle()
  const ticketId=(routed.ticket as {ticket_id:string}).ticket_id,sessionId=`worker-${ticketId}`
  expect(h.runtime.store.tickets.get(ticketId)?.origin.triggerId).toBe(trigger.id)
  expect(sent[0]).toMatchObject({msg:{to_user_id:account.ownerId,item_list:[{type:1,text_item:{text:'已接单'}}]}})
  await h.runTool(sessionId,'orchestrator_report',{state:'progress',summary:'需要确认',human_action:'资料整理成哪种格式？'})
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticketId)?.attention).toBeDefined()
  await h.runTool(h.runtime.masterId,'orchestrator_reply',{purpose:'attention',ticket_id:ticketId,human_action:'资料整理成哪种格式？',text:'资料整理成哪种格式？'})
  expect(JSON.stringify(sent)).toContain('资料整理成哪种格式')
  setMessages([msg('2','请整理为列表')]);await pollWeixin(source,client,config);await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticketId)?.inputs.some(input=>input.kind==='trigger'&&input.triggerId===weixinTrigger(account,msg('2','请整理为列表'))!.id)).toBe(true)
  await h.runTool(sessionId,'orchestrator_report',{state:'ready',summary:'资料清单已整理完成',human_action:null})
  await h.runtime.idle()
  await h.runTool(h.runtime.masterId,'orchestrator_reply',{purpose:'result',ticket_id:ticketId,text:'资料清单已整理完成'})
  expect(h.runtime.store.tickets.get(ticketId)?.ended?.outcome).toBe('completed')
  expect(JSON.stringify(sent)).toContain('资料清单已整理完成')
  expect(JSON.stringify(h.runtime.store.triggers.get(trigger.id))).not.toMatch(/private-context-token|private-bot-token/)
  expect(h.runtime.store.get(KV.weixin.cursor(account.id))).toBe('cursor-next')
})

it('refuses strangers and group messages and deduplicates an accepted poll replay',async()=>{
  const {h,config,source,client,setMessages}=await host()
  setMessages([msg('1','冒用身份','stranger'),{...msg('2'),group_id:'room'}] as never)
  expect(await pollWeixin(source,client,config)).toBe(0)
  expect(h.runtime.store.tickets.list()).toHaveLength(0)
  setMessages([msg('3')]);expect(await pollWeixin(source,client,config)).toBe(1)
  expect(await pollWeixin(source,client,config)).toBe(0)
  expect(h.runtime.store.read.triggers({},0,50).items).toHaveLength(1)
})

it('rolls back both ingested messages and the checkpoint if a poll batch cannot be committed',async()=>{
  const {h,config,source,client,setMessages}=await host()
  setMessages([msg('1'),msg('2')])
  const receive=source.receive
  vi.spyOn(source,'receive').mockImplementationOnce(receive).mockImplementationOnce(()=>{throw new Error('interrupted batch')})
  await expect(pollWeixin(source,client,config)).rejects.toThrow('interrupted batch')
  expect(h.runtime.store.read.triggers({},0,50).items).toHaveLength(0)
  expect(h.runtime.store.get(KV.weixin.cursor(account.id))).toBeUndefined()
  expect(h.runtime.store.get(KV.weixin.context(account.id,account.ownerId))).toBeUndefined()
})

it('never regresses a saved reply context when the transport replays an older message',async()=>{
  const {h,config,source,client,setMessages}=await host()
  await pollWeixin(source,client,config)
  setMessages([{...msg('2'),context_token:'newer-context'}]);await pollWeixin(source,client,config)
  setMessages([msg('1')]);await pollWeixin(source,client,config)
  expect(h.runtime.store.get(KV.weixin.context(account.id,account.ownerId))).toBe('newer-context')
})

it('initializes a fresh main Store and refuses to overwrite it on a repeated setup',async()=>{
  const {config}=await host()
  const stateDir=join(credentialsDir!,'fresh-runtime')
  const input={stateDir,credentialsFile:config.credentialsFile,provider:'conest',model:'hy4'}
  initializeWeixin(input)
  const store=new Store(join(stateDir,'orchestrator.sqlite'))
  try {
    expect(store.settings().sources.github?.enabled).toBe(false)
    expect(store.settings().sources.weixin?.config.ownerId).toBe(account.ownerId)
    expect(store.settings().executor.maxWorkers).toBe(1)
    expect(store.settings().eval.timeoutSeconds).toBe(600)
  } finally {store.close()}
  expect(()=>initializeWeixin(input)).toThrow('Existing Runtime database')
})

it('refuses model changes to Weixin authority and refuses to reuse private history for another owner',async()=>{
  const {h,config}=await host()
  const revision=h.runtime.store.blockRevision('source:weixin')
  await expect(h.runtime.settings.save('source:weixin',{enabled:true,config:{...config,credentialsFile:'/tmp/other.json'}},revision,'tool'))
    .rejects.toMatchObject({code:'panelOnlyAccounts'})
  await expect(h.runtime.settings.save('source:weixin',{enabled:true,config:{...config,ownerId:'other-owner'}},revision,'panel'))
    .rejects.toThrow('fresh state directory')
})

it('keeps successful chunks and blocks blind retries after an uncertain send',async()=>{
  const {h,source,client,fetcher,sent}=await host()
  h.runtime.store.set(KV.weixin.context(account.id,account.ownerId),'private-context-token')
  const channel=weixinTrigger(account,msg())!.channel!
  const message={id:'long-result',channel,text:'甲'.repeat(1801),kind:'reply' as const}
  fetcher.mockImplementationOnce(async(_url,options)=>{
    sent.push(JSON.parse(String(options?.body)));return new Response('{"ret":0}')
  }).mockRejectedValueOnce(new Error('connection lost after sending'))
  await expect(sendWeixin(source,client,message)).rejects.toThrow('uncertain')
  expect(sent).toHaveLength(1)
  const attempts=fetcher.mock.calls.length
  await expect(sendWeixin(source,client,message)).rejects.toThrow('uncertain')
  expect(fetcher).toHaveBeenCalledTimes(attempts)
  expect(JSON.stringify(sent)).toContain('conest-')
})
