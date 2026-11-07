// Recon 3: how the UI picks a model (DOM) and which RPC it sends; NO prompt sent.
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
const click = (label) => browser.evaluate(`(()=>{const e=[...document.querySelectorAll('button,[role=button],[aria-label]')].find(x=>(x.getAttribute('aria-label')||x.innerText.trim()).startsWith(${JSON.stringify(label)}));if(!e)return false;e.click();return true})()`);
console.log('Continue clicked:', await click('Continue'));
await sleep(800);
console.log('picker clicked:', await click('Select model'));
await sleep(1000);
const dump = async (tag) => console.log(tag, JSON.stringify(await browser.evaluate(`[...document.querySelectorAll('[role=dialog] *,[role=menu] *,[role=listbox] *,[data-radix-popper-content-wrapper] *')].filter(e=>e.children.length===0&&e.innerText&&e.innerText.trim()).map(e=>e.tagName+':'+(e.getAttribute('role')||'')+':'+e.innerText.trim().slice(0,40)).slice(0,60)`)));
await dump('popover');
// click the "Model" row inside the popover
console.log('model row:', await browser.evaluate(`(()=>{const e=[...document.querySelectorAll('[data-radix-popper-content-wrapper] *')].find(x=>x.innerText&&x.innerText.trim().startsWith('Model')&&x.children.length<4&&x.tagName!=='DIV'||x.getAttribute&&x.getAttribute('role')==='combobox');if(!e)return 'none';e.click();return e.tagName+':'+(e.getAttribute('role')||'')})()`));
await sleep(1000);
await dump('after model row');
console.log('options:', JSON.stringify(await browser.evaluate("[...document.querySelectorAll('[role=option]')].map(e=>e.innerText.trim().slice(0,50))")));
console.log('catalog rpc:', (await browser.evaluate('window.__net')).filter((n) => /modelCatalog|selectModel/.test(n.d)).map((n) => n.d.slice(0, 200)).join('\n'));
await browser.screenshot(join0(work));
function join0(w) { return w + '/picker.png'; }
console.log('screenshot:', work + '/picker.png');
await browser.close(); server.kill();
