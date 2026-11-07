// Prints the event types (and request/context route) of a session log: node evs.mjs <DSH_HOME> <session id>
import { readLog } from '../../../plugin/dsh/test/live/zstd-log.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [home, sid] = process.argv.slice(2);
const root = join(home, 'sessions');
const f = readdirSync(root).map((d) => join(root, d, sid, 'session.v4.jsonl.zstd')).find(existsSync);
const ev = readLog(f);
console.log(ev.map((e) => e.type).join(' '));
for (const e of ev.filter((e) => ['request/context', 'model/selection', 'agent/created', 'error', 'agent/error'].includes(e.type))) console.log(e.type, JSON.stringify(e.data).slice(0, 300));
