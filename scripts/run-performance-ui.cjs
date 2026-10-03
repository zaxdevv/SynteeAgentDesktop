const fs=require('node:fs'); const path=require('node:path');const os=require('node:os');const cp=require('node:child_process');const esbuild=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'syntee-perf-ui-'));
const result=esbuild.buildSync({entryPoints:['scripts/performance-ui-smoke.tsx'],bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false});
fs.writeFileSync(path.join(temp,'renderer.js'),result.outputFiles[0].contents);
fs.writeFileSync(path.join(temp,'index.html'),`<!doctype html><style>*{box-sizing:border-box}body{margin:0}${fs.readFileSync('src/renderer/src/components/ui/Messenger/MessengerConversation.css','utf8')}</style><div id="root"></div><script src="renderer.js"></script>`);
fs.writeFileSync(path.join(temp,'main.cjs'),`const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temp,'userdata'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:true,x:-12000,y:-12000,skipTaskbar:true,width:1100,height:600,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});ipcMain.once('test-result',(_,data)=>{console.log(JSON.stringify(data));app.exit(data.pass?0:1)});win.webContents.on('console-message',(_,level,message)=>console.log('console:',message));win.loadFile(${JSON.stringify(path.join(temp,'index.html'))});setTimeout(()=>app.exit(2),20000)});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
// The tiny harness has no project application import, network, user profile,
// or singleton lock; it only renders the virtual list beside a reference.
const electron=require('electron');
const out=cp.spawnSync(electron,[path.join(temp,'main.cjs')],{env,encoding:'utf8',timeout:30000});
console.log(out.stdout);if(out.stderr)console.log(out.stderr.slice(-2000));
fs.rmSync(temp,{recursive:true,force:true});process.exitCode=out.status??1;
