import { resolve } from 'path'
import { readdirSync } from 'fs'
import { runDiagnosticCommand, isCommandAvailable } from '../runner'
import { hasFileMatching, parseColonFormat, commandFailure } from './_utils'
import type { DiagnosticProvider } from '../types'
export const yamlProvider:DiagnosticProvider={name:'yaml',extensions:['.yaml','.yml'],detect(dir){return hasFileMatching(dir,['.yamllint','.yamllint.yaml','.yamllint.yml'])||hasFileMatching(dir,['.yaml','.yml'])},async run(dir,files?){
 if(!await isCommandAvailable('yamllint --version',dir))return {entries:[],note:'yamllint not installed — YAML diagnostics skipped'}
 let targets=files?.length?files.map(f=>resolve(dir,f)):[]
 if(!targets.length)try{targets=readdirSync(dir).filter(f=>f.endsWith('.yaml')||f.endsWith('.yml')).map(f=>resolve(dir,f))}catch{}
 if(!targets.length)return {entries:[],note:'no YAML files found'}
 const res=await runDiagnosticCommand(`yamllint -f parsable ${targets.map(f=>`"${f}"`).join(' ')}`,dir,60000)
 const entries=parseColonFormat(res.stdout+'\n'+res.stderr,'yamllint',s=>s.toLowerCase().includes('warning')?'warning':'error')
 return {entries,failed:commandFailure(res,'yamllint',entries.length)}
}}
