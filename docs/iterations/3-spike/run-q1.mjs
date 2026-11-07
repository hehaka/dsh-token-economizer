// Spike runner: one tiny headless run with route_diag.mjs loaded via a --patch overlay.
//   node docs/iterations/3-spike/run-q1.mjs [--profile headless]
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { arg, loadProfileEnv } from '../../../plugin/dsh/test/live/common.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const profile = arg('--profile', 'headless');
loadProfileEnv(profile);
const work = join(tmpdir(), 'te-spike3');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'repo'), { recursive: true });
const diag = join(work, 'route_diag.mjs');
copyFileSync(join(here, 'route_diag.mjs'), diag);
const patch = join(work, 'diag.patch.yml');
writeFileSync(patch, `- insert:\n    - id: te-route-diag\n      name: ${JSON.stringify(pathToFileURL(diag).href)}\n`);
const log = join(here, 'q1.log.jsonl');
rmSync(log, { force: true });
const r = spawnSync('dsh', ['--profile', profile, '--patch', patch, 'Reply with the single word ok'], {
  encoding: 'utf8', timeout: 240_000, cwd: join(work, 'repo'), env: { ...process.env, TE_DIAG_LOG: log },
});
console.log(`exit ${r.status}; answer: ${(r.stdout || '').trim().slice(-80)}`);
if (r.status !== 0) console.log(String(r.stderr).split('\n').filter((l) => /dsh:|Error|error/.test(l)).slice(-5).join('\n'));
console.log(`log: ${log}`);
