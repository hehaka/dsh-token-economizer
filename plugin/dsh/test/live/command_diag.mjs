import { appendFileSync } from 'node:fs';
const L = process.env.TE_DIAG_LOG;
const log = (m) => appendFileSync(L, `${m}\n`);
// Live-check helper (not part of the plugin): runs `/te ...` through DSH's own command executor,
// the path a chat surface uses, since `dsh headless` sends a slash line to the model instead.
export const name = 'te-cmd-diag';
export function apply(ctx) {
  log('diag loaded');
  ctx.inject(['commands'], (c) => {
    log('commands service present');
    c.on('agent/created', async ({ agent }) => {
      try {
        log(`commands for agent: ${c.commands.list(agent).map((d) => d.name).join(',')}`);
        for (const line of ['/te status --json', '/te toolprune show', '/te fold --session x']) {
          const ex = await c.commands.execute(agent, line, [], new AbortController().signal);
          log(JSON.stringify({ line, kind: ex ? ex.result.kind : 'undefined', text: ex?.result.text ?? '' }));
        }
      } catch (e) { log(`diag error: ${e?.stack ?? e}`); }
    });
  });
}
