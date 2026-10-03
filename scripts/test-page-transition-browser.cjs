/* eslint-disable @typescript-eslint/no-require-imports -- standalone Electron integration test */
/* global require, console, __dirname, setTimeout, clearTimeout */
// Run: .\node_modules\.bin\electron.cmd scripts/test-page-transition-browser.cjs
const { app, BrowserWindow } = require('electron')
const { buildSync } = require('esbuild')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const project = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'syntee-transition-'))
// Keep this fixture independent of the user's Electron session/profile.
app.setPath('userData', path.join(temp, 'profile'))
const css = fs.readFileSync(path.join(project, 'src/renderer/src/pages/Settings/SettingsPage.css'), 'utf8')
const bundle = buildSync({
  stdin: {
    resolveDir: project, loader: 'tsx', sourcefile: 'transition-fixture.tsx',
    contents: `
      import React, {useLayoutEffect, useRef} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync, createPortal} from 'react-dom';
      import Host from './src/renderer/src/components/ui/PageTransitionHost/PageTransitionHost';
      import {useNavStore} from './src/renderer/src/store/nav.store';
      window.store = useNavStore;
      window.transitions = [];
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = update => {
        const t = start(update); window.transitions.push(t); return t;
      };
      function Page({page}) {
        const canvas = useRef(null);
        const scroll = useRef(null);
        useLayoutEffect(() => {
          const c = canvas.current.getContext('2d');
          c.fillStyle = '#00ff00'; c.fillRect(0, 0, 120, 60);
          scroll.current.scrollTop = 150;
        }, []);
        return <div className="fixture-page" data-page={page}>
          <canvas ref={canvas} width="120" height="60" />
          <div ref={scroll} className="fixture-scroll"><div style={{height:600,
            background:'linear-gradient(#f00 0 150px,#00f 150px 600px)'}} /></div>
          <input id="dot-input" defaultValue="Dot draft" />
          {createPortal(<div id="dot-portal">Portal</div>, document.body)}
        </div>;
      }
      function App() {
        const page = useNavStore(s => s.mainPage);
        return <><button id="dock" onClick={() => useNavStore.getState().toggleMainPage('dots')}>Dots</button>
          <div className="rp-chat-area">
            <Host page={page} chat={<div className="fixture-chat"><input id="chat-input" /></div>}>
              {page !== 'chat' && <Page key={page} page={page} />}
            </Host>
          </div><div id="right-panel">Right panel</div></>;
      }
      flushSync(() => createRoot(document.getElementById('root')).render(<App/>));
    `,
  },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text
fs.writeFileSync(path.join(temp, 'fixture.js'), bundle)
fs.writeFileSync(path.join(temp, 'index.html'), `<!doctype html><html><head><style>
${css}
html,body { margin:0; background:#000; }
#root { height:400px; }
#dock { position:absolute; left:0; top:0; width:80px; height:40px; }
.rp-chat-area { position:absolute; left:0; top:40px; width:500px; height:360px; overflow:hidden; display:flex; }
.page-host { flex:1; display:flex; }
.page-host--hidden { position:absolute; inset:0; visibility:hidden; pointer-events:none; opacity:0; }
.fixture-page { flex:1; background:#ff0000; }
.fixture-chat { flex:1; background:#0000ff; }
canvas { position:absolute; left:10px; top:10px; }
.fixture-scroll { position:absolute; left:150px; top:10px; width:60px; height:80px; overflow:auto; }
#dot-input,#chat-input { position:absolute; left:10px; top:200px; width:150px; }
#right-panel { position:absolute; left:500px; top:40px; width:100px; height:360px; background:#fff; }
#dot-portal { position:absolute; left:0; top:420px; }
</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)

async function run() {
  const win = new BrowserWindow({ width:620, height:460, show:false,
    title:'Syntee — transition regression test',
    webPreferences: { backgroundThrottling:false } })
  win.showInactive()
  win.webContents.on('console-message', details => {
    if (details.level === 'error') console.error(details.message)
  })
  const js = code => win.webContents.executeJavaScript(code, true)
  const watchdog = setTimeout(() => { console.error('FAIL: browser fixture timed out'); app.exit(1) }, 20000)
  try {
    await win.loadFile(path.join(temp, 'index.html'))
    const runtime = await js('({native: typeof document.startViewTransition, chromium: navigator.userAgent})')
    assert.equal(runtime.native, 'function')
    await js(`store.getState().setMainPage('dots'); true`)
    await js(`transitions.at(-1).finished.then(() => true)`)
    assert.deepEqual(await js(`Array.from(document.querySelector('canvas').getContext('2d').getImageData(10,10,1,1).data)`),
      [0,255,0,255], 'canvas is painted')
    assert.equal(await js(`document.querySelector('.fixture-scroll').scrollTop`), 150)
    const state = await js(`(async () => {
      document.getElementById('dot-input').focus();
      store.getState().setMainPage('chat');
      await transitions.at(-1).ready;
      const input = document.getElementById('chat-input');
      const rect = input.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x+20, rect.y+10);
      return { portalGone: !document.getElementById('dot-portal'),
        dotGone: !document.getElementById('dot-input'),
        chatInert: input.closest('.page-host').inert, hit:hit?.id,
        x: Math.round(rect.x+20), y: Math.round(rect.y+10),
        oldOpacity:getComputedStyle(document.documentElement,'::view-transition-old(syntee-page)').opacity,
        backdrop:getComputedStyle(document.documentElement,'::view-transition').pointerEvents };
    })()`)
    win.webContents.sendInputEvent({type:'mouseDown', x:state.x, y:state.y, button:'left', clickCount:1})
    win.webContents.sendInputEvent({type:'mouseUp', x:state.x, y:state.y, button:'left', clickCount:1})
    assert.equal(await js('document.activeElement?.id'), 'chat-input', 'real click focuses chat during exit')
    assert.equal(state.portalGone, true)
    assert.equal(state.dotGone, true)
    assert.equal(state.chatInert, false)
    assert.equal(state.hit, 'chat-input', 'native snapshot never intercepts input clicks')
    assert.equal(state.backdrop, 'none')
    assert.ok(Number(state.oldOpacity) > 0, 'old native raster is still visible during exit')
    await js('transitions.at(-1).finished.then(() => true)')
    await js(`(async () => {
      for (let i=0;i<30;i++) {
        store.getState().toggleMainPage('dots');
        store.getState().toggleMainPage('dots');
      }
      await transitions.at(-1).finished;
      return true;
    })()`)
    assert.equal(await js('store.getState().mainPage'), 'chat')
    assert.equal(await js('document.querySelectorAll(".page-motion-host").length'), 0)
    assert.equal(await js('document.documentElement.hasAttribute("data-syntee-page-transition")'), false)
    for (const page of ['settings', 'memory', 'messenger', 'dots']) {
      await js(`store.getState().setMainPage('${page}'); true`)
      await js('transitions.at(-1).finished.then(() => true)')
      assert.equal(await js('document.querySelector(".fixture-scroll").scrollTop'), 150)
      await js(`store.getState().setMainPage('chat'); true`)
      await js('transitions.at(-1).finished.then(() => true)')
      assert.equal(await js('document.querySelectorAll("#dot-portal").length'), 0)
    }
    console.log('PASS Chromium: canvas/scroll fixture, native exit, portals unmount, real chat click during exit, 60 rapid toggles, four page routes, clean top-layer')
    console.log(runtime.chromium)
  } finally { clearTimeout(watchdog) }
}
app.whenReady().then(run).then(() => app.exit(0)).catch(error => {
  console.error(error); app.exit(1)
})
