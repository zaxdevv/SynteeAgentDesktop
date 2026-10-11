import { randomUUID } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'
import type { BrowserOpPayload } from '../managers/BrowserManager'
export interface ElementPoint { x: number; y: number; width: number; height: number }
export function resolveFrame(wc: WebContents, id?: number): WebFrameMain {
  const frame = id === undefined ? wc.mainFrame : wc.mainFrame.framesInSubtree.find(f => f.routingId === id)
  if (!frame) throw new Error('Requested frame is unavailable.')
  return frame
}
export function isChildFrame(wc: WebContents, id?: number): boolean { return id !== undefined && id !== wc.mainFrame.routingId }
export function clampTimeout(n?: number, fallback = 10000): number { return typeof n === 'number' && Number.isFinite(n) ? Math.min(120000, Math.max(100, n)) : fallback }
function guard(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Browser operation aborted.') }
async function run(wc: WebContents, p: BrowserOpPayload, action: string, signal?: AbortSignal): Promise<any> {
  guard(signal)
  const args = { ...p.args, ...p, snapshotId: p.snapshotId, nonce: randomUUID() }
  const result = await resolveFrame(wc, p.frameId).executeJavaScript(`(${PAGE})(${JSON.stringify(args)},${JSON.stringify(action)})`, false)
  guard(signal)
  return result
}
export async function snapshot(wc: WebContents, p: BrowserOpPayload, signal?: AbortSignal): Promise<string> { return run(wc, p, 'snapshot', signal) }
export async function locate(wc: WebContents, p: BrowserOpPayload, signal?: AbortSignal): Promise<ElementPoint | null> {
  // Two consecutive samples guard against moving targets. Re-resolve each sample.
  for (let i = 0; i < 12; i++) {
    const a = await run(wc, p, 'locate', signal)
    if (!a) return null
    await new Promise(resolve => setTimeout(resolve, 50)); guard(signal)
    const b = await run(wc, p, 'locate', signal)
    if (b && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 1)) return b
  }
  return null
}
export async function refInfo(wc: WebContents, p: BrowserOpPayload, signal?: AbortSignal): Promise<{ submit: boolean; point: ElementPoint } | null> { return run(wc, p, 'info', signal) }
export async function inspect(wc: WebContents, p: BrowserOpPayload, signal?: AbortSignal): Promise<{ editable: boolean; value: string; password: boolean; checked: boolean; type: string; tag: string }> { return run(wc, p, 'inspect', signal) }
export async function domAction(wc: WebContents, p: BrowserOpPayload, action: string, signal?: AbortSignal): Promise<string> { return run(wc, { ...p, value: p.value ?? p.text }, action, signal) }
export async function condition(wc: WebContents, p: BrowserOpPayload, signal?: AbortSignal): Promise<boolean> { return run(wc, p, 'condition', signal) }
const PAGE = String.raw`(p, action) => {
  const norm = x => String(x || '').replace(/\s+/g,' ').trim();
  const name = e => {
    const ids=e.getAttribute('aria-labelledby');
    if(ids){const root=e.getRootNode();const text=ids.split(/\s+/).map(id=>root.getElementById?.(id)?.textContent||document.getElementById(id)?.textContent||'').join(' ');if(norm(text))return norm(text)}
    return norm(e.getAttribute('aria-label') || Array.from(e.labels||[]).map(l=>l.textContent).join(' ') || e.getAttribute('placeholder') || (e.tagName==='IMG'?e.getAttribute('alt'):'') || (e.tagName==='INPUT'&&['button','submit','reset'].includes(e.type)?e.value:'') || e.textContent)
  };
  const role=e=>e.getAttribute('role')||({BUTTON:'button',A:e.hasAttribute('href')?'link':'generic',INPUT:({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',range:'slider',number:'spinbutton'}[e.type]||'textbox'),TEXTAREA:'textbox',SELECT:e.multiple?'listbox':'combobox',OPTION:'option',IMG:'img',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',LI:'listitem',UL:'list',OL:'list',TABLE:'table',SUMMARY:'button'}[e.tagName]|| (e.isContentEditable?'textbox':null));
  const signature=e=>e.tagName+'|'+(e.id||'')+'|'+name(e)+'|'+(e.getAttribute('href')||'');
  const elements=[];const traverse=(root,depth=0)=>{if(depth>50||elements.length>=10000)return;for(const e of root.children||[]){if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))continue;elements.push(e);traverse(e,depth+1);if(e.shadowRoot)traverse(e.shadowRoot,depth+1)}};
  traverse(document);
  const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&Number(s.opacity)!==0&&r.width>0&&r.height>0};
  const disabled=e=>e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'||!!e.closest('[inert]');
  const sensitive=e=>e.type==='password'||/password|one-time-code|cc-number|cc-csc/.test(e.getAttribute('autocomplete')||'');
  const editable=e=>!disabled(e)&&!e.readOnly&&(e.tagName==='TEXTAREA'||(e.tagName==='INPUT'&&!['file','checkbox','radio','button','submit','reset','hidden','range','color'].includes(e.type))||e.isContentEditable);
  const value=e=>'value' in e?String(e.value):e.isContentEditable?e.textContent||'':'';
  const match=(a,b,exact)=>exact?norm(a)===norm(b):norm(a).toLowerCase().includes(norm(b).toLowerCase());
  const find=()=>{
    const s=window.__synteeAutomation;
    if(p.snapshotId&&s?.snapshot!==p.snapshotId)throw Error('Stale snapshot. Take a new snapshot.');
    if(p.ref){const entry=s?.refs.get(p.ref);if(!entry||!entry.el.isConnected||signature(entry.el)!==entry.signature)throw Error('Stale ref. Take a new snapshot.');return entry.el}
    const l=p.locator||(p.selector?{type:'css',value:p.selector}:null);if(!l)throw Error('Provide ref or locator.');
    let found=elements.filter(e=>{
      if(l.type==='css')return e.matches(l.value);
      if(l.type==='testid')return e.getAttribute('data-testid')===l.value;
      if(l.type==='role')return role(e)===l.value&&(!l.name||match(name(e),l.name,l.exact));
      if(l.type==='label')return Array.from(e.labels||[]).some(x=>match(x.textContent,l.value,l.exact));
      if(l.type==='placeholder')return e.hasAttribute('placeholder')&&match(e.getAttribute('placeholder'),l.value,l.exact);
      if(l.type==='text')return match(e.textContent,l.value,l.exact);return false
    });
    if(l.type==='text')found=found.filter(e=>!found.some(c=>c!==e&&e.contains(c)));
    if(found.length>1)throw Error('Ambiguous locator: '+found.length+' elements. Narrow the locator.');
    return found[0]||null
  };
  if(action==='snapshot'){
    const s=window.__synteeAutomation||(window.__synteeAutomation={refs:new Map(),next:0});s.refs.clear();s.snapshot='s-'+p.nonce;
    const lines=['Snapshot: '+s.snapshot];let count=0;
    const walk=(root,depth)=>{if(depth>12)return;for(const e of root.children||[]){if(count>=1200)return;if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))continue;
      const r=role(e);if(visible(e)){
        count++;let line='  '.repeat(depth)+'- '+(r||e.tagName.toLowerCase())+' '+JSON.stringify(name(e).slice(0,160));
        if(r&&['button','link','textbox','checkbox','radio','combobox','listbox','option','menuitem','tab','switch','slider','spinbutton'].includes(r)){const ref='r-'+p.nonce+'-'+(++s.next);s.refs.set(ref,{el:e,signature:signature(e)});line+=' [ref='+ref+']'}
        if(disabled(e))line+=' [disabled]';if('checked'in e)line+=' [checked='+e.checked+']';if('selected'in e)line+=' [selected='+e.selected+']';if(e.getAttribute('aria-expanded'))line+=' [expanded='+e.getAttribute('aria-expanded')+']';
        if(document.activeElement===e||e.getRootNode().activeElement===e)line+=' [focused]';if(!sensitive(e)&&value(e))line+=' [value='+JSON.stringify(value(e).slice(0,120))+']';lines.push(line)
      }
      walk(e,depth+1);if(e.shadowRoot){lines.push('  '.repeat(depth+1)+'- shadow-root');walk(e.shadowRoot,depth+1)}
    }};walk(document.body||document,0);if(count>=1200)lines.push('[truncated]');return lines.join('\n')
  }
  if(action==='condition'){
    const c=p.args?.condition||p.condition,v=String(p.args?.value??p.value??'');
    if(c==='text')return (document.body?.innerText||'').includes(v);
    if(c==='load')return v==='domcontentloaded'?document.readyState!=='loading':document.readyState==='complete';
    if(c==='selector'){const found=elements.filter(e=>e.matches(v)),state=p.args?.state||'visible';return state==='detached'?found.length===0:state==='attached'?found.length>0:state==='hidden'?found.every(e=>!visible(e)):found.some(visible)}
    throw Error('Unsupported condition')
  }
  if(action==='page_scroll'){
    const d=p.direction||'down',a=Math.min(Math.abs(p.amount??600),10000);
    window.scrollBy({left:d==='left'?-a:d==='right'?a:0,top:d==='up'?-a:d==='down'?a:0,behavior:'instant'});
    return 'ok'
  }
  const e=find();if(!e)return action==='inspect'?null:action==='info'||action==='locate'?null:'not-found';
  if(action==='inspect')return {editable:editable(e),value:sensitive(e)?'':value(e),password:sensitive(e),checked:!!e.checked,type:e.type||'',tag:e.tagName};
  if(action==='prepare_value'){
    const state=window.__synteeAutomation||(window.__synteeAutomation={refs:new Map(),next:0});
    state.expectedValues||(state.expectedValues=new WeakMap());
    state.expectedValues.set(e,p.action==='fill'?String(p.text??p.value??''):value(e)+String(p.text??p.value??''));
    return editable(e)?'ok':'not-editable'
  }
  if(action==='verify_value'){
    const expected=window.__synteeAutomation?.expectedValues?.get(e);
    window.__synteeAutomation?.expectedValues?.delete(e);
    return expected!==undefined&&value(e)===expected?'ok':'value-mismatch'
  }
  if(disabled(e))return action==='info'||action==='locate'?null:'disabled';
  if(!visible(e))return action==='info'||action==='locate'?null:'hidden';
  e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next}
  if(!hit||!(hit===e||e.contains(hit)))return action==='info'||action==='locate'?null:'obscured';
  const point={x:r.x,y:r.y,width:r.width,height:r.height};
  if(action==='locate')return point;
  if(action==='info')return {point,submit:e.tagName==='BUTTON'&&e.type==='submit'||e.tagName==='INPUT'&&['submit','image'].includes(e.type)};
  if(action==='scroll'){
    const d=p.direction||'down',a=Math.min(Math.abs(p.amount??600),10000);
    e.scrollBy({left:d==='left'?-a:d==='right'?a:0,top:d==='up'?-a:d==='down'?a:0,behavior:'instant'});
    return 'ok'
  }
  if(action==='focus'){e.focus();return e.getRootNode().activeElement===e?'ok':'focus-failed'}
  if(action==='select_option'){
    if(e.tagName!=='SELECT')return 'not-select';const values=p.args?.values||[String(p.value??p.args?.value??'')];if(values.length>1&&!e.multiple)return 'not-multiple';
    if(values.some(v=>!Array.from(e.options).some(o=>o.value===v&&!o.disabled)))return 'missing-option';
    for(const o of e.options)o.selected=values.includes(o.value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(Array.from(e.selectedOptions).map(o=>o.value).sort())===JSON.stringify([...values].sort())?'ok':'value-mismatch'
  }
  if(action==='fill'||action==='type'){
    if(!editable(e))return 'not-editable';e.focus();const text=String(p.text??'');const current=value(e),expected=action==='fill'?text:current+text;
    if(e.isContentEditable)e.textContent=expected;else{const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,expected)}
    e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));e.dispatchEvent(new Event('change',{bubbles:true}));return value(e)===expected?'ok':'value-mismatch'
  }
  throw Error('Unsupported DOM action: '+action)
}`
