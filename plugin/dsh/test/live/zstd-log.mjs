import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
export function readLog(file) {
  const b = readFileSync(file), magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = []; for (let i = b.indexOf(magic); i >= 0; i = b.indexOf(magic, i + 1)) starts.push(i);
  let out = '', i = 0;
  while (i < starts.length) {                       // merge frames until a slice decodes
    for (let j = i + 1; j <= starts.length; j++) {
      try { out += zstdDecompressSync(b.subarray(starts[i], starts[j] ?? b.length)).toString(); i = j; break; }
      catch { if (j === starts.length) { i = j; } }
    }
  }
  return out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
