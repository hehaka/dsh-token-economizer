// node rawcalls.mjs <session-id> : tool names the model actually called, from DSH's own session log
import { readSessionEvents } from '../../../plugin/dsh/test/live/common.mjs';
const ev = readSessionEvents(process.argv[2]);
const types = {};
for (const e of ev) types[e.type] = (types[e.type] ?? 0) + 1;
console.log(JSON.stringify(types));
for (const e of ev) {
  const s = JSON.stringify(e);
  if (/tool-call|tool\/call|tool\/start|tool\/result/.test(e.type)) console.log(e.type, s.slice(0, 260));
}
