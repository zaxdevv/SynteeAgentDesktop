/* eslint-disable @typescript-eslint/no-require-imports -- Electron UI regression fixture */
/* global require, console, __dirname, process, setTimeout, clearTimeout */
// Run: .\node_modules\.bin\electron.cmd scripts/skills-tree-browser.test.cjs
const { app, BrowserWindow, ipcMain } = require('electron')
const { build } = require('esbuild')
const ts = require('typescript')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const project = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-skills-ui-'))
app.setPath('userData', path.join(temp, 'profile'))
const skillsDir = path.join(temp, 'profile', 'skills')
fs.mkdirSync(skillsDir, { recursive: true })
const userPack = 'C:/Users/cegor/AppData/Roaming/SynteeHelper/skills/remotion-best-practices'
if (fs.existsSync(userPack)) fs.cpSync(userPack, path.join(skillsDir, 'remotion-best-practices'), { recursive: true })
else {
  fs.mkdirSync(path.join(skillsDir, 'remotion-best-practices', 'child'), { recursive: true })
  fs.writeFileSync(path.join(skillsDir, 'remotion-best-practices', 'SKILL.md'), '---\nname: remotion-best-practices\ndescription: Router\n---\nRouter instructions')
  fs.writeFileSync(path.join(skillsDir, 'remotion-best-practices', 'child', 'REFERENCE.md'), '---\nname: child\ndescription: Child skill\n---\nChild instructions')
}
function load(relative, mocks = {}) {
  const js = ts.transpileModule(fs.readFileSync(path.join(project, relative), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports)
  return module.exports
}
class Store {
  constructor() { this.data = {} }
  get(key) { return structuredClone(this.data[key]) }
  set(key, value) { this.data[key] = structuredClone(value) }
}
const loader = load('src/core/skills/skillLoader.ts')
const tree = load('src/shared/skillsTree.ts')
const { SkillManager } = load('src/core/skills/skillManager.ts', { 'electron-store': Store, './skillLoader': loader, '../../shared/skillsTree': tree })
const manager = new SkillManager(new Store())
const { registerSkillsIPC } = load('src/main/ipc/skills.ipc.ts', {
  '../../core/skills/skillManager': { getSkillManager: () => manager },
  '../../core/skills/skillLoader': loader,
  '../../core/db': { getAllProjects: () => [{ id: 'test-project', workdir: temp }], getProjectById: () => ({ workdir: temp }), getChatWorkdirContext: () => ({ workdir: temp }) },
})
registerSkillsIPC(new Store())
ipcMain.handle('fixture:all', () => manager.getAllWithState())
fs.writeFileSync(path.join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('syntee', {
  skills:{getAll:()=>ipcRenderer.invoke('skills:getAll'),setState:p=>ipcRenderer.invoke('skills:setState',p),setFolderState:p=>ipcRenderer.invoke('skills:setFolderState',p),reload:()=>ipcRenderer.invoke('skills:reload')},
  fixture:{all:()=>ipcRenderer.invoke('fixture:all')},shell:{openPath:async()=>'',showItemInFolder:async()=>{},getExtensionsPaths:async()=>({skillsUserDir:''})}
});`)
const fixtureStore = `
  import {create} from 'zustand';
  export const useExtensionsStore=create((set,get)=>({skills:[],skillsLoading:false,
    loadSkills:async()=>{set({skills:await window.syntee.skills.getAll()})},
    setSkillState:async(skillId,state,source)=>{await window.syntee.skills.setState({skillId,state,source});await get().loadSkills()},
    setSkillFolderState:async(update)=>{await window.syntee.skills.setFolderState(update);await get().loadSkills()},
    reloadSkills:async()=>{await window.syntee.skills.reload();await get().loadSkills()}
  }));window.fixtureStore=useExtensionsStore;
`
async function prepare() {
const result = await build({
  stdin: { resolveDir: project, loader: 'tsx', sourcefile: 'skills-ui-fixture.tsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import Skills from './src/renderer/src/components/ui/ExtensionsPopover/SkillsInstalledList';
    import {useExtensionsStore} from './src/renderer/src/store/extensions.store';
    import './src/renderer/src/components/ui/ExtensionsPopover/ExtensionsPopover.css';
    let root;const render=()=>{root=createRoot(document.getElementById('root'));root.render(<Skills projects={[{id:'test-project',name:'Test project'}]} projectId="test-project" onBrowseCatalog={()=>{}}/>)};
    window.remount=()=>{root.unmount();render()};
    useExtensionsStore.getState().loadSkills().then(render);
  ` },
  bundle: true, write: false, outfile: path.join(temp, 'bundle.js'), platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': path.join(project, 'src/shared') },
  plugins: [{ name: 'fixture-store', setup(build) {
    build.onResolve({ filter: /extensions\.store$/ }, () => ({ path: 'skills-store', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixtureStore, loader: 'js', resolveDir: project }))
  } }],
})
fs.writeFileSync(path.join(temp, 'bundle.js'), result.outputFiles.find(f => !f.path.endsWith('.css')).text)
const style = fs.readFileSync(path.join(project, 'src/renderer/src/components/ui/AppIcon/AppIcon.css'), 'utf8') + fs.readFileSync(path.join(project, 'src/renderer/src/components/ui/ExtensionsPopover/ExtensionsPopover.css'), 'utf8') + fs.readFileSync(path.join(project, 'src/renderer/src/components/ui/ExtensionsPopover/SkillsInstalledList.css'), 'utf8')
fs.writeFileSync(path.join(temp, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8"><style>
:root{--accent:#a78bfa;--bg-primary:#14141d;--text-primary:#eeeef8;--text-secondary:#bcbccf;--text-muted:#83839e;--border:#303043;--ext-danger:#f87171;--ext-danger-bg:#43252d;}*{box-sizing:border-box;}body{margin:0;background:#101018;color:var(--text-primary);font:13px 'Segoe UI',sans-serif;}button,input{font:inherit;}#root{padding:24px;} ${style}
</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`)
}
async function main() {
  await prepare()
  const win = new BrowserWindow({ show: false, width: 1050, height: 830, webPreferences: { preload: path.join(temp, 'preload.cjs'), backgroundThrottling: false } })
  const js = code => win.webContents.executeJavaScript(code, true).catch(e => { console.error('Failed renderer script:', code); throw e })
  win.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer:', details.message) })
  const cleanup = () => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Chromium may hold profile locks until process exit. */ } }
  const wait = () => js(`new Promise(r=>setTimeout(r,250))`)
  const click = code => js(`${code}.click();true`).then(wait)
  const count = manager.getAllWithState().length
  const watchdog = setTimeout(() => { console.error('FAIL: skills UI fixture timed out'); app.exit(1) }, 30000)
  try {
    await win.loadFile(path.join(temp, 'index.html'))
    await wait()
    assert.equal(await js('document.querySelectorAll(".skill-tree-root").length'), 1)
    assert.ok(await js('document.body.textContent.includes("remotion-best-practices")'))
    await click('document.querySelector(".skill-tree-root > .skill-tree-row [role=checkbox]")')
    assert.equal(manager.getActiveSkillsForChat({}).length, count)
    // Toggle a visible leaf off: both its ancestors become mixed.
    await click('document.querySelector(".skill-tree-leaf [role=checkbox]")')
    assert.equal(manager.getActiveSkillsForChat({}).length, count - 1)
    assert.equal(await js('document.querySelector(".skill-tree-root > .skill-tree-row [role=checkbox]").getAttribute("aria-checked")'), 'mixed')
    // Wait for a painted mixed checkbox, not just the backend write.
    await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`)
    // Screenshot with mixed selection and compact nested folders.
    const image = await win.webContents.capturePage()
    const screenshot = path.join(project, 'logs', 'skills-tree-preview.png')
    fs.mkdirSync(path.dirname(screenshot), { recursive: true })
    fs.writeFileSync(screenshot, image.toPNG())
    // Search must unfold deep ancestors, while folder toggle affects hidden siblings too.
    await js(`const input=document.querySelector('.ext-installed-search-wrap input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'remotion-maps');input.dispatchEvent(new Event('input',{bubbles:true}));true`)
    await wait()
    if (fs.existsSync(userPack)) assert.ok(await js('document.body.textContent.includes("remotion-maps")'))
    await click('document.querySelector(".skill-tree-root > .skill-tree-row [role=checkbox]")')
    assert.equal(manager.getActiveSkillsForChat({}).length, count)
    await js(`(()=>{const input=document.querySelector('.ext-installed-search-wrap input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
    await wait()
    // Scope of the whole source: restrict to the selected project.
    await click('document.querySelector(".skill-tree-root > .skill-tree-row > button:last-child")')
    // Choose the projects radio explicitly.
    await click('document.querySelectorAll(".skill-tree-root > .skill-tree-details input[type=radio]")[1]')
    assert.equal(manager.getActiveSkillsForChat({}).length, 0)
    assert.equal(manager.getActiveSkillsForChat({ projectId: 'test-project' }).length, count)
    // Add another skill under an enabled source and refresh: inherits enabled + scope.
    const added = path.join(skillsDir, 'extra', 'nested')
    fs.mkdirSync(added, { recursive: true })
    fs.writeFileSync(path.join(added, 'SKILL.md'), '---\nname: extra-skill\ndescription: Newly added\n---\nNew instructions')
    await click('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Обновить"))')
    assert.equal(manager.getActiveSkillsForChat({ projectId: 'test-project' }).length, count + 1)
    assert.equal(await js('getComputedStyle(document.querySelector(".skill-tree-row")).display'), 'flex')
    assert.ok(await js('document.documentElement.scrollWidth <= window.innerWidth'))
    // Collapsed root state survives component unmount/remount.
    await click('document.querySelector(".skill-tree-root > .skill-tree-row > button:first-child")')
    assert.equal(await js('document.querySelectorAll(".skill-tree-root > .skill-tree-children").length'), 0)
    await js('window.remount();true')
    await wait()
    assert.equal(await js('document.querySelectorAll(".skill-tree-root > .skill-tree-children").length'), 0)
    console.log(`PASS: Chromium UI folder/leaf toggles, mixed selection, filtered folder toggle, scope, nested refresh (${count} Remotion skills). Screenshot: ${screenshot}`)
    clearTimeout(watchdog)
    win.destroy()
    cleanup()
    app.exit(0)
  } catch (e) { clearTimeout(watchdog); console.error(e); win.destroy(); cleanup(); app.exit(1) }
}
app.whenReady().then(main).catch(e => { console.error(e); app.exit(1) })
