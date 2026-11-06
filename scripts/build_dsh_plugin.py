#!/usr/bin/env python3
"""Assemble the installable DSH plugin: `plugin/dsh/` with the core package beside it.

    python scripts/build_dsh_plugin.py [--out dist/dsh]

`plugin/dsh/` alone is not installable: a package installed from a subdirectory of a repository
(`#path:/plugin/dsh`) gets only that subdirectory (docs/dsh/spike-phase-b.md, B5), and the plugin
needs the Python core. This copies the plugin, the core's launcher (`plugin/scripts/`, whose
`te_bootstrap.py` the plugin starts for every hook) and the core package (`tokeneconomizer/`,
into `lib/` where the launcher looks first) into one flat package root. CI publishes that root
as the `dist` branch (docs/dsh/adr/0002). The core is stdlib-only, so the copy is the whole
dependency story. Nothing under the upstream paths is edited; this file only reads them.
"""
import argparse
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_plugin import IGNORE, REPO  # noqa: E402  the upstream bundle's own ignore list

PLUGIN = os.path.join(REPO, "plugin", "dsh")


def build(out):
    out = os.path.abspath(out)
    if os.path.exists(out):
        shutil.rmtree(out)
    shutil.copytree(PLUGIN, out, ignore=shutil.ignore_patterns("__pycache__", "node_modules", "test"))
    shutil.copytree(os.path.join(REPO, "plugin", "scripts"), os.path.join(out, "scripts"),
                    ignore=IGNORE)
    shutil.copytree(os.path.join(REPO, "tokeneconomizer"),
                    os.path.join(out, "lib", "tokeneconomizer"), ignore=IGNORE)
    for name in ("LICENSE",):
        shutil.copy2(os.path.join(REPO, name), os.path.join(out, name))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(REPO, "dist", "dsh"))
    args = ap.parse_args(argv)
    print(f"DSH plugin package root: {build(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
