import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import VirtualMessageList from '../src/renderer/src/components/ui/VirtualMessageList/VirtualMessageList'
const ipc = (window as unknown as { require: (id:string)=>{ipcRenderer:{send:(event:string,data:unknown)=>void}} }).require('electron').ipcRenderer
const initial = Array.from({length:300},(_,i)=>({id:`m${i}`,height:40+(i%5)*15,mine:i%2===0}))
function Harness(){
 const [items,setItems]=useState(initial)
 const scroll = useRef<HTMLDivElement>(null); const reference=useRef<HTMLDivElement>(null); const pinned=useRef(true)
 const row=(item:typeof initial[number])=><div key={item.id} data-id={item.id} className={`msgr-msg ${item.mine?'msgr-msg--mine':''}`} style={{height:item.height,flexShrink:0,background:'#333',color:'white'}}>{item.id}</div>
 useEffect(()=>{
  const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
  const compare=()=>{
   const actual=scroll.current!;const expected=reference.current!;const a=actual.getBoundingClientRect();const e=expected.getBoundingClientRect()
   const visible=Array.from(expected.querySelectorAll<HTMLElement>('[data-id]')).filter(x=>{const b=x.getBoundingClientRect();return b.bottom>e.top+50&&b.top<e.bottom-50})
   for(const target of visible){const match=actual.querySelector<HTMLElement>(`[data-id="${target.dataset.id}"]`);if(!match)throw new Error(`missing visible ${target.dataset.id}; mounted ${Array.from(actual.querySelectorAll<HTMLElement>('[data-id]')).map(x=>x.dataset.id).join(',')}; scroll ${actual.scrollTop}; height ${actual.scrollHeight}; reference ${expected.scrollTop}/${expected.scrollHeight}`);const x=match.getBoundingClientRect();const y=target.getBoundingClientRect();if(Math.abs((x.top-a.top)-(y.top-e.top))>2||Math.abs((x.left-a.left)-(y.left-e.left))>2||Math.abs(x.width-y.width)>2)throw new Error(`layout mismatch ${target.dataset.id}: top ${x.top-a.top}/${y.top-e.top}, width ${x.width}/${y.width}`)}
   return visible.length
  }
  ;(async()=>{
   await sleep(200)
   for(let i=0;i<12;i++){scroll.current!.scrollTop=scroll.current!.scrollHeight;reference.current!.scrollTop=reference.current!.scrollHeight;await sleep(60)}
   const bottom=compare();pinned.current=false
   scroll.current!.scrollTop=0;reference.current!.scrollTop=0;await sleep(300);const top=compare()
   scroll.current!.scrollTop=4000;reference.current!.scrollTop=4000;await sleep(300);
   // Unknown offscreen row sizes are estimates. Compare visible geometry at
   // the same message anchor, not an arbitrary absolute scroll offset.
   const anchor=scroll.current!.querySelector<HTMLElement>('[data-id="m52"]')!;
   if(!anchor)throw new Error('middle anchor missing');
   const refAnchor=reference.current!.querySelector<HTMLElement>('[data-id="m52"]')!;
   reference.current!.scrollTop += (refAnchor.getBoundingClientRect().top-reference.current!.getBoundingClientRect().top)-(anchor.getBoundingClientRect().top-scroll.current!.getBoundingClientRect().top);
   await sleep(100);const middle=compare()
   pinned.current=true;setItems(prev=>[...prev,{id:'new',height:130,mine:true}]);await sleep(200)
   for(let i=0;i<8;i++){scroll.current!.scrollTop=scroll.current!.scrollHeight;reference.current!.scrollTop=reference.current!.scrollHeight;await sleep(50)}
   compare()
   ipc.send('test-result',{pass:true,bottom,top,middle,mounted:scroll.current!.querySelectorAll('[data-id]').length,total:items.length})
  })().catch(e=>ipc.send('test-result',{pass:false,error:String(e)}))
 },[])
 return <div style={{display:'flex',gap:30}}><div ref={reference} className="msgr-msg-list" style={{width:500,height:400,flex:'none'}}>{items.map(row)}</div><div ref={scroll} className="msgr-msg-list" style={{width:500,height:400,flex:'none'}}><VirtualMessageList items={items} scope="test" scrollRef={scroll} pinnedRef={pinned} gap={8} estimatedSize={80} renderItem={row}/></div></div>
}
createRoot(document.getElementById('root')!).render(<Harness/> )
