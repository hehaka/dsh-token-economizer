"""Per-repository tool catalogs (docs/dsh/adr/0004).

The host-wide `hosts/dsh/catalog.json` is the tool list of the LAST session of ANY repository, so
folding a repository against it proposes denying tools that its own sessions never had (the mcp
tools of another repository's session). The DSH plugin therefore also writes, per repository,
`hosts/dsh/catalogs/<sha1(repository root)[:16]>.json`, and the fold reads that file in preference
to the host-wide one. The root is the nearest checkout (`paths.find_repo_root`), which the plugin
finds the same way (`plugin/dsh/src/tools.mjs` `repoRoot`)."""
import hashlib
import os


def repo_catalog_path(state_root, host, repo_root):
    key = hashlib.sha1(repo_root.encode("utf-8")).hexdigest()[:16]
    return os.path.join(state_root, "hosts", host, "catalogs", key + ".json")


def own_catalog_path(state_root, host, repo_root):
    """The repository's own catalog file if there is one, else None (use the host-wide one)."""
    if not repo_root:
        return None
    path = repo_catalog_path(state_root, host, repo_root)
    return path if os.path.isfile(path) else None
