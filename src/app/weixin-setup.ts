/** Fresh-profile initializer for the real Runtime. Refuses to overwrite an existing database or live process. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { lockSync } from 'proper-lockfile'
import { Store } from './store.ts'
import { readWeixinAccount } from '../sources/weixin-account.ts'
import { WeixinConfigSchema, weixinAccounts, weixinActorId, type WeixinConfig } from '../sources/weixin-config.ts'

interface WeixinSetup {
  stateDir: string
  provider: string
  model: string
  routerModel?: string
}

/** Initialize a new single-owner deployment, keeping all task state in the existing Store. */
export function initializeWeixin(input: WeixinSetup & { credentialsFile: string }): void {
  const credentialsFile=resolve(input.credentialsFile), account=readWeixinAccount(credentialsFile)
  initialize(input, WeixinConfigSchema.parse({credentialsFile,accountId:account.id,ownerId:account.ownerId}))
}
/** Initialize multiple explicitly bound members in one Store with one shared worker queue. */
export function initializeWeixinMembers(input: WeixinSetup & { membersFile: string }): void {
  const config=WeixinConfigSchema.parse(JSON.parse(readFileSync(resolve(input.membersFile),'utf8')))
  if (!config.members?.length || !config.accounts?.length) throw new Error('members-file requires members and accounts')
  initialize(input,config)
}
/** Empty member-mode deployment; the website performs every subsequent member/account enrollment. */
export function initializeWeixinWeb(input: WeixinSetup): void {
  initialize(input, WeixinConfigSchema.parse({ members: [], accounts: [] }))
}
function initialize(input: WeixinSetup, config: WeixinConfig): void {
  const stateDir=resolve(input.stateDir)
  const cwd=resolve('.')
  if (stateDir===cwd||stateDir.startsWith(cwd+'/')) throw new Error('State and credentials must be outside the checkout')
  for (const account of weixinAccounts(config,false)) {
    if (account.credentialsFile===cwd||account.credentialsFile.startsWith(cwd+'/')) throw new Error('State and credentials must be outside the checkout')
    readWeixinAccount(account.credentialsFile,account)
  }
  mkdirSync(stateDir,{recursive:true,mode:0o700})
  const release=lockSync(stateDir)
  let store:Store|undefined
  try {
    const path=join(stateDir,'orchestrator.sqlite')
    if (existsSync(path)) throw new Error('Existing Runtime database; use the management panel to change settings')
    store=new Store(path)
    const settings=store.settings(), model={provider:input.provider,model:input.model}
    const routerModel = input.routerModel ?? (config.accounts && input.model === 'hy4' ? 'hy4-flash' : input.model)
    store.saveSettings({...settings,sources:{github:{enabled:false,config:{}},feishu:{enabled:false,config:{}},
      weixin:{enabled:true,config}},
      policy:{...settings.policy,sources:{weixin:{allowed:weixinAccounts(config).map(account=>({id:weixinActorId(account.accountId,account.ownerId)}))}}},
      eval:{...settings.eval,model:{...model,model:routerModel},timeoutSeconds:600},executor:{...settings.executor,model,maxWorkers:1}})
  } finally { store?.close();release() }
}

export function main():void {
  process.umask(0o077)
  const {values}=parseArgs({options:{'state-dir':{type:'string'},'credentials-file':{type:'string'},'members-file':{type:'string'},web:{type:'boolean'},provider:{type:'string',default:'conest'},model:{type:'string',default:'hy4'},'router-model':{type:'string'}}})
  if (!values['state-dir']||[values['credentials-file'],values['members-file'],values.web].filter(Boolean).length!==1) throw new Error('Required: --state-dir and exactly one of --credentials-file, --members-file or --web')
  const input={stateDir:values['state-dir'],provider:values.provider!,model:values.model!,routerModel:values['router-model']}
  if (values.web) initializeWeixinWeb(input)
  else if (values['members-file']) initializeWeixinMembers({...input,membersFile:values['members-file']})
  else initializeWeixin({...input,credentialsFile:values['credentials-file']!})
  console.log('Initialized a fresh Weixin Runtime. Configure the same DSH provider, start DSH, and open the launch URL to enter the CoNest backend.')
}
