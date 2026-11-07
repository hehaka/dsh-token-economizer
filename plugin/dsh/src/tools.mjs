// Tool pruning, DSH's side. The core decides which tools a repository's sessions never use and
// writes them into `.dsh/token-economizer.local.json` (`tokeneconomizer.deny`; the same writer as
// the other agents' settings files, docs/dsh/adr/0004). This module only
//   * records the tool list a session could call, so the core can see tools that were never used
//     (`<state>/hosts/dsh/catalog.json`, the format `te toolprune refresh-catalog` writes), and
//   * reads that file when an agent is created and hides the named tools from it.
// It never decides anything: a file it cannot read, or a name DSH does not know, changes nothing.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DENY_FILE = join('.dsh', 'token-economizer.local.json');
export const catalogPath = (stateRoot) => join(stateRoot, 'hosts', 'dsh', 'catalog.json');
// One repository's own list (`<state>/hosts/dsh/catalogs/<sha1(root)[:16]>.json`): the host-wide file is
// the last session's, of whichever repository, so the core folds against this one when it exists
// (`tokeneconomizer/plugin/dsh_catalog.py`; the root is the one `repoRoot` finds).
export const repoCatalogPath = (stateRoot, root) =>
  join(stateRoot, 'hosts', 'dsh', 'catalogs', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);

// Does `dir/.git` make `dir` a checkout, as the core takes it (`paths.is_git_entry`)? A directory
// with a HEAD, or a file (linked worktree, submodule) whose `gitdir:` names a directory that exists.
function isCheckout(dir) {
  try {
    const dot = join(dir, '.git');
    if (statSync(dot).isDirectory()) return existsSync(join(dot, 'HEAD'));
    const m = /^gitdir:\s*(.+)/.exec(readFileSync(dot, 'utf8'));
    return Boolean(m) && statSync(resolve(dir, m[1].trim())).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The repository root of a session started in `cwd`: the nearest directory at or above it that is a
 * checkout, as the core finds it (`paths.find_repo_root`: the person's home is a ceiling), else `cwd`
 * itself. The core writes the deny file there, whatever subdirectory a session starts in.
 */
export function repoRoot(cwd) {
  const start = resolve(cwd);
  let home = '';
  try {
    home = realpathSync(homedir());
  } catch {
    /* no home */
  }
  for (let cur = start; ; ) {
    if (isCheckout(cur)) return cur;
    const parent = dirname(cur);
    let real = parent;
    try {
      real = realpathSync(parent);
    } catch {
      /* a parent that cannot be resolved is only compared as written */
    }
    if (parent === cur || (home && real === home)) return start;
    cur = parent;
  }
}

/** Names in `tokeneconomizer.deny` of the repository's file; [] for a missing or unreadable one. */
export function readDeny(cwd, file = DENY_FILE) {
  try {
    const path = join(repoRoot(cwd), file);
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

// One catalog file, written atomically and only when its tool list changed; a file that cannot be
// read counts as changed, so a damaged one is repaired at the next session start.
function writeListIfChanged(path, names) {
  const body = `${JSON.stringify({ tools: names, host: 'dsh', updated: Math.floor(Date.now() / 1000) })}\n`;
  try {
    let prev;
    try {
      prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    } catch {
      prev = undefined;
    }
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
 * Write the tool list for the core (it is written at every session start): the host-wide file and,
 * given the session's repository root, that repository's own. True when either changed.
 */
export function writeCatalog(stateRoot, names, root) {
  if (!names.length) return false;
  const wide = writeListIfChanged(catalogPath(stateRoot), names);
  const own = root ? writeListIfChanged(repoCatalogPath(stateRoot, root), names) : false;
  return wide || own;
}

// Names DSH reserves or the agent cannot work without: `restrict` refuses `run_code` outright, and
// the two tool-loading proxies are how a pruned agent reaches everything it has not been denied.
const NEVER_RESTRICT = new Set(['run_code', 'tool_call', 'tool_search']);

/**
 * Hide `deny` from one agent. `restrict` is all-or-nothing: it throws, applying nothing, when any
 * name is unknown or reserved. So only names the registry knows are sent (never a reserved one);
 * the batch goes first, and if it throws each name is tried alone, so one bad name costs only
 * itself. Returns the names actually hidden; `log` gets one line naming the refused ones.
 */
export function applyDeny(agent, deny, known, log) {
  const known_ = new Set(known);
  const names = [...new Set(deny)].filter((n) => known_.has(n) && !NEVER_RESTRICT.has(n));
  if (!names.length) return [];
  const restrict = (list) => agent.ctx.tools.restrict({ deny: list });
  try {
    restrict(names);
    return names;
  } catch {
    /* one of them is refused: find which */
  }
  const hidden = [];
  const refused = [];
  for (const n of names) {
    try {
      restrict([n]);
      hidden.push(n);
    } catch {
      refused.push(n);
    }
  }
  try {
    log?.(`tool pruning: DSH refused ${refused.length} name(s): ${refused.join(', ')}`);
  } catch {
    /* logging never matters */
  }
  return hidden;
}
