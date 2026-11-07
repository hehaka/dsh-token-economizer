// Tool pruning, DSH's side. The core decides which tools a repository's sessions never use and
// writes them into `.dsh/token-economizer.local.json` (`tokeneconomizer.deny`; the same writer as
// the other agents' settings files, docs/dsh/adr/0004). This module only
//   * records the tool list a session could call, so the core can see tools that were never used
//     (`<state>/hosts/dsh/catalog.json`, the format `te toolprune refresh-catalog` writes), and
//   * reads that file when an agent is created and hides the named tools from it.
// It never decides anything: a file it cannot read, or a name DSH does not know, changes nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DENY_FILE = join('.dsh', 'token-economizer.local.json');
export const catalogPath = (stateRoot) => join(stateRoot, 'hosts', 'dsh', 'catalog.json');

/** Names in `tokeneconomizer.deny` of the repository's file; [] for a missing or unreadable one. */
export function readDeny(cwd, file = DENY_FILE) {
  try {
    const path = join(cwd, file);
    if (!existsSync(path)) return [];
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const list = doc?.tokeneconomizer?.deny;
    return Array.isArray(list) ? [...new Set(list.filter((n) => typeof n === 'string' && n.length > 0))] : [];
  } catch {
    return [];
  }
}

/**
 * The names of the tools DSH offers (a snapshot of its registry), sorted; [] without a registry.
 * `scope` is the viewing agent: DSH's web profile registers its model-facing tools on the agent plane,
 * so the global view (no scope) lists almost nothing there and `restrict` knows only the agent's view.
 */
export function toolNames(tools, scope) {
  try {
    const schemas = typeof tools?.schemas === 'function' ? tools.schemas(scope) : [];
    return [...new Set((Array.isArray(schemas) ? schemas : []).map((s) => s?.name).filter((n) => typeof n === 'string' && n))].sort();
  } catch {
    return [];
  }
}

/** Write the tool list for the core, only when it changed (it is written at every session start). */
export function writeCatalog(stateRoot, names) {
  if (!names.length) return false;
  const path = catalogPath(stateRoot);
  const body = `${JSON.stringify({ tools: names, host: 'dsh', updated: Math.floor(Date.now() / 1000) })}\n`;
  try {
    const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (Array.isArray(prev?.tools) && prev.tools.length === names.length && prev.tools.every((n, i) => n === names[i])) return false;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hide `deny` from one agent. `restrict` throws for a name DSH does not know (a tool whose plugin
 * was removed), so only known names are passed. Returns what was hidden.
 */
export function applyDeny(agent, deny, known) {
  const known_ = new Set(known);
  const names = deny.filter((n) => known_.has(n));
  if (!names.length) return [];
  agent.ctx.tools.restrict({ deny: names });
  return names;
}
