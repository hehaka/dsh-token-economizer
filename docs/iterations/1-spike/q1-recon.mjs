// Recon: start an isolated dsh web, load it in headless Chrome, log HTTP/WebSocket traffic (truncated), no prompt sent.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from '../../../plugin/dsh/client/test/browser/cdp.mjs';
import { freshWork, startWeb, sleep } from './lib.mjs';

const work = freshWork('te-spike1-recon');
const { server, url, home } = await startWeb(work);
console.log('url pattern:', url.replace(/\d+/, '<port>'));
const browser = await launch({ port: 9400 + Math.floor(Math.random() * 400) });
const net = [];
browser.send('Network.enable');
const orig = browser.send;
await browser.send('Network.enable');
await browser.goto(url);
await browser.waitFor("document.body.innerText.includes('Standard mode')", { label: 'app shell' });
await sleep(2500);
const txt = await browser.evaluate('document.body.innerText.slice(0,600)');
console.log('page text:', txt.replace(/\n+/g, ' | '));
// all buttons / aria-labels
console.log('buttons:', JSON.stringify(await browser.evaluate("[...document.querySelectorAll('button,[role=button],[role=combobox]')].map(e=>(e.getAttribute('aria-label')||e.innerText.trim()).slice(0,40)).filter(Boolean)")));
await browser.close();
server.kill();
await sleep(1000);
console.log('home sessions dir exists:', (await import('node:fs')).existsSync(join(home, 'sessions')));
