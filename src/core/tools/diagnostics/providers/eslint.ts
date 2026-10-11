import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { runDiagnosticCommand } from '../runner'
import { commandFailure, parseJsonStrict } from './_utils'
import type { DiagnosticProvider, DiagnosticEntry } from '../types'
type Msg = {line:number;column:number;severity:1|2;message:string;ruleId?:string|null}
type EslintFile = {filePath:string;messages:Msg[]}
function parse(text:string):{entries:DiagnosticEntry[];error?:string} {
 const parsed=parseJsonStrict<EslintFile[]>(text,'eslint'); if(!parsed.value)return {entries:[],error:parsed.error}
 if(!Array.isArray(parsed.value))return {entries:[],error:'eslint: unexpected JSON shape'}
 const entries:DiagnosticEntry[]=[]
 for(const f of parsed.value) for(const m of f.messages||[]) entries.push({file:f.filePath,line:m.line||0,col:m.column,severity:m.severity===2?'error':'warning',message:m.ruleId?`${m.ruleId}: ${m.message}`:m.message,source:'eslint'})
 return {entries}
}
export const eslintProvider:DiagnosticProvider={name:'eslint',extensions:['.ts','.tsx','.js','.jsx','.mjs','.cjs'],detect(dir){return ['eslint.config.js','eslint.config.mjs','eslint.config.cjs','eslint.config.ts','.eslintrc','.eslintrc.json','.eslintrc.js'].some(f=>existsSync(join(dir,f)))},async run(dir,files?){
 const args=files?.length?files.map(f=>`"${resolve(dir,f)}"`).join(' '):'.'
 const res=await runDiagnosticCommand(`npx --no-install eslint ${args} --format json`,dir)
 const output=res.stdout.trim(); const parsed=output?parse(output):{entries:[],error:undefined as string|undefined}
 const failure=commandFailure(res,'eslint',parsed.entries.length)
 return {entries:parsed.entries,failed:failure||parsed.error}
}}
