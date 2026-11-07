// Recon 2: log the page's WebSocket frames / fetch calls (truncated), then open the model picker. No prompt is sent.
import { launch } from '../../../plugin/dsh/client/test/browser/cdp.mjs';
import { freshWork, startWeb, sleep } from './lib.mjs';

const work = freshWork('te-spike1-recon');
const { server, url } = await startWeb(work);
const browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{window.__net=[];const L=(k,d)=>window.__net.push({k,t:Date.now(),d:String(d).slice(0,400)});
const W=window.WebSocket;window.WebSocket=function(u,p){L('ws-open',String(u).replace(/token=[^&]+/,'token=<t>'));const s=p?new W(u,p):new W(u);const send=s.send.bind(s);s.send=(m)=>{L('ws-send',typeof m==='string'?m:'<bin '+(m.byteLength||m.size)+'>');return send(m)};s.addEventListener('message',e=>L('ws-recv',typeof e.data==='string'?e.data:'<bin>'));return s};window.WebSocket.prototype=W.prototype;
const F=window.fetch;window.fetch=function(u,o){L('fetch',(o&&o.method||'GET')+' '+String(u&&u.url||u).replace(/token=[^&]+/,'token=<t>')+' '+(o&&typeof o.body==='string'?o.body.slice(0,200):''));return F.apply(this,arguments)};})()` });
await browser.goto(url);
await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
await sleep(2500);
await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>/^Select model/.test(x.getAttribute('aria-label')||''));e&&e.click()})()`);
await sleep(1500);
console.log('after picker click text:', (await browser.evaluate("document.body.innerText.slice(0,1500)")).replace(/\n+/g, ' | '));
console.log('options:', JSON.stringify(await browser.evaluate("[...document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=listbox] *')].map(e=>(e.getAttribute('aria-label')||e.innerText||'').trim().slice(0,50)).filter(Boolean).slice(0,40)")));
const net = await browser.evaluate('window.__net');
for (const n of net.slice(0, 40)) console.log(n.k, n.d.slice(0, 300));
await browser.close(); server.kill();
