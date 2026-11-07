// Recon 4: pick a model in the UI with real (CDP) mouse events; log the RPC it sends. NO prompt sent.
import { launch } from '../../../plugin/dsh/client/test/browser/cdp.mjs';
import { freshWork, startWeb, sleep } from './lib.mjs';

const work = freshWork('te-spike1-recon');
const { server, url } = await startWeb(work);
const browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{window.__net=[];const L=(k,d)=>window.__net.push({k,d:String(d).slice(0,500)});
const F=window.fetch;window.fetch=function(u,o){L('fetch',(o&&o.method||'GET')+' '+String(u&&u.url||u)+' '+(o&&typeof o.body==='string'?o.body:''));return F.apply(this,arguments)};})()` });
await browser.goto(url);
await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
await sleep(2000);
const realClickText = async (text, within = 'body') => {
  const pt = await browser.evaluate(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(within)}+' *')].filter(x=>x.children.length===0&&x.innerText&&x.innerText.trim()===${JSON.stringify(text)});const e=els[els.length-1];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!pt) return false;
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  return true;
};
const leaves = async () => (await browser.evaluate(`[...document.querySelectorAll('[data-radix-popper-content-wrapper] *,[role=menu] *,[role=menuitem],[role=option],[role=dialog] *,[data-state=open] *')].filter(e=>e.children.length===0&&e.innerText&&e.innerText.trim()).map(e=>e.innerText.trim().slice(0,40))`));
if (await browser.evaluate("!![...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Continue')")) { await realClickText('Continue'); await sleep(800); }
await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>/^Select model/.test(x.getAttribute('aria-label')||''));e&&e.click()})()`);
await sleep(800);
console.log('menu1:', JSON.stringify(await leaves()));
console.log('click Model:', await realClickText('Model'));
await sleep(1000);
console.log('menu2:', JSON.stringify(await leaves()));
await browser.screenshot(work + '/picker2.png');
console.log('screenshot:', work + '/picker2.png');
await browser.close(); server.kill();
