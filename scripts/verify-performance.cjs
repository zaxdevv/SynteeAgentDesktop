const ts = require('typescript');
const { ESLint } = require('eslint');
const esbuild = require('esbuild');
const fs = require('node:fs');
const cp = require('node:child_process');
const mode = process.argv[2] || 'all';
async function main() {
 if (mode === 'types' || mode === 'all') {
  for (const file of ['tsconfig.node.json', 'tsconfig.web.json']) {
   const config = ts.readConfigFile(file, ts.sys.readFile);
   const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
   const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
   const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
   console.log(`TYPECHECK ${file}: ${errors.length} diagnostics`);
   fs.writeFileSync(`.tmp-${file}-diagnostics.json`, JSON.stringify(errors.map(d=>({file:d.file?.fileName,line:d.file ? d.file.getLineAndCharacterOfPosition(d.start||0).line+1:0,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')})), null,2));
   const changed = cp.execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);
   const added = cp.execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);
   const root = process.cwd().replace(/\\/g,'/') + '/';
   const baselineFiles = new Map();
   for (const f of changed) { try { baselineFiles.set(root+f,cp.execFileSync('git',['show',`HEAD:${f}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']})); } catch {} }
   const opts = { ...parsed.options, noEmit:true };
   const host = ts.createCompilerHost(opts);
   const read = host.readFile.bind(host); const exists = host.fileExists.bind(host);
   host.readFile = f=>baselineFiles.get(f.replace(/\\/g,'/')) ?? (added.includes(f.replace(/\\/g,'/').replace(root,'')) ? undefined : read(f));
   host.fileExists = f=> !added.includes(f.replace(/\\/g,'/').replace(root,'')) && exists(f);
   const baselineProgram = ts.createProgram(parsed.fileNames.filter(f=>!added.includes(f.replace(/\\/g,'/').replace(root,''))), opts, host);
   const baseline = ts.getPreEmitDiagnostics(baselineProgram);
   const signature = d=>`${d.file?.fileName}|${d.code}|${ts.flattenDiagnosticMessageText(d.messageText,' ')}`;
   const counts = new Map(); for (const d of baseline) counts.set(signature(d),(counts.get(signature(d))||0)+1);
   const introduced = errors.filter(d=>{const s=signature(d);const n=counts.get(s)||0;if(n){counts.set(s,n-1);return false;}return true;});
   console.log(`Baseline ${baseline.length}; NEW ${introduced.length}`);
   console.log(ts.formatDiagnosticsWithColorAndContext(introduced, { getCanonicalFileName: f=>f, getCurrentDirectory: ()=>process.cwd(), getNewLine: ()=> '\n' }));
  }
 }
 if (mode === 'lint' || mode === 'all') {
  const changed = cp.execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).split(/\r?\n/).filter(f=>/\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
  const added = cp.execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).split(/\r?\n/).filter(f=>/\.(ts|tsx)$/.test(f));
  const eslint = new ESLint(); const results = await eslint.lintFiles([...changed, ...added]);
  let newCount=0;
  for (const r of results) {
   const relative = r.filePath.replace(/\\/g,'/').replace(process.cwd().replace(/\\/g,'/')+'/','');
   let baseline=[]; try { const text=cp.execFileSync('git',['show',`HEAD:${relative}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']}); baseline=(await eslint.lintText(text,{filePath:r.filePath}))[0].messages; }catch{}
   const counts=new Map(); for(const m of baseline){const s=m.ruleId+'|'+m.message.split('\n')[0];counts.set(s,(counts.get(s)||0)+1)}
   for(const m of r.messages){const s=m.ruleId+'|'+m.message.split('\n')[0];const n=counts.get(s)||0;if(n) counts.set(s,n-1);else {console.log(`${relative}:${m.line} ${m.severity===2?'ERROR':'WARN'} ${m.ruleId} ${m.message.split('\n')[0]}`);if(m.severity===2) newCount++}}
  }
  console.log(`LINT: ${results.reduce((s,r)=>s+r.errorCount,0)} total errors; ${newCount} NEW errors`);
 }
 if (mode === 'tests' || mode === 'all') {
  for (const name of ['terminal-flow', 'graphRendererCache', 'performance-regressions']) {
   const entry = `scripts/${name}.test.ts`; if (!fs.existsSync(entry)) continue;
   const result = esbuild.buildSync({ entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false });
   const filename = `${process.cwd()}/.tmp-${name}.cjs`;
   try { fs.writeFileSync(filename, result.outputFiles[0].contents); console.log(cp.execFileSync(process.execPath, [filename],{encoding:'utf8'})); }
   finally { fs.rmSync(filename,{force:true}); }
  }
 }
}
main().catch(e=>{ console.error(e); process.exitCode=1; });
