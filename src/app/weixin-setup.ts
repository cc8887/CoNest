/** Fresh-profile initializer for the real Runtime. Refuses to overwrite an existing database or live process. */
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { lockSync } from 'proper-lockfile'
import { Store } from './store.ts'
import { readWeixinAccount } from '../sources/weixin-account.ts'
import { weixinActorId } from '../sources/weixin.ts'

/** Initialize a new single-owner deployment, keeping all task state in the existing Store. */
export function initializeWeixin(input: { stateDir: string; credentialsFile: string; provider: string; model: string }): void {
  const stateDir=resolve(input.stateDir), credentialsFile=resolve(input.credentialsFile)
  const cwd=resolve('.')
  if (stateDir===cwd||stateDir.startsWith(cwd+'/')||credentialsFile===cwd||credentialsFile.startsWith(cwd+'/')) throw new Error('State and credentials must be outside the checkout')
  const account=readWeixinAccount(credentialsFile)
  mkdirSync(stateDir,{recursive:true,mode:0o700})
  const release=lockSync(stateDir)
  let store:Store|undefined
  try {
    const path=join(stateDir,'orchestrator.sqlite')
    if (existsSync(path)) throw new Error('Existing Runtime database; use the management panel to change settings')
    store=new Store(path)
    const settings=store.settings(), model={provider:input.provider,model:input.model}
    store.saveSettings({...settings,sources:{github:{enabled:false,config:{}},feishu:{enabled:false,config:{}},
      weixin:{enabled:true,config:{credentialsFile,accountId:account.id,ownerId:account.ownerId}}},
      policy:{...settings.policy,sources:{weixin:{allowed:[{id:weixinActorId(account.id,account.ownerId)}]}}},
      eval:{...settings.eval,model,timeoutSeconds:600},executor:{...settings.executor,model,maxWorkers:1}})
  } finally { store?.close();release() }
}

export function main():void {
  process.umask(0o077)
  const {values}=parseArgs({options:{'state-dir':{type:'string'},'credentials-file':{type:'string'},provider:{type:'string',default:'conest'},model:{type:'string',default:'hy4'}}})
  if (!values['state-dir']||!values['credentials-file']) throw new Error('Required: --state-dir and --credentials-file')
  initializeWeixin({stateDir:values['state-dir'],credentialsFile:values['credentials-file'],provider:values.provider!,model:values.model!})
  console.log('Initialized a fresh single-owner Weixin Runtime. Configure the same DSH provider and enable the Weixin plugin before starting.')
}
