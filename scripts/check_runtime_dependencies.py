#!/usr/bin/env python3
"""Check that what each package's built code imports is among its dependencies (ADR-724).

A package that imports another only listed in its devDependencies works in the workspace, where
every package's devDependencies are installed, and fails in a container, where only dependencies
are. This reads each built package's dist/ (tests and test helpers aside), finds the packages its
code imports, statically or dynamically, and reports any that are neither dependencies nor peer
dependencies. Run it after a build; it exits 1 if anything is missing.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The admin is a browser bundle built by Vite, which carries its dependencies within it.
SKIPPED = {"@hatti/admin-web"}
# An import or export statement at the start of a line, across lines up to its quoted source, and
# a dynamic import().
STATIC = re.compile(
    r"^(?:import\s*|(?:import|export)\b[^'\";]*?\bfrom\s*)['\"]([^'\"]+)['\"]", re.M
)
DYNAMIC = re.compile(r"\bimport\(\s*['\"]([^'\"]+)['\"]\s*\)")


def package_of(source: str) -> str | None:
    """The package a bare specifier names, or None for a relative path or a Node built-in."""
    if source.startswith((".", "/", "node:")):
        return None
    parts = source.split("/")
    return "/".join(parts[:2]) if source.startswith("@") else parts[0]


def runtime_files(dist: pathlib.Path):
    for path in dist.rglob("*.js"):
        relative = path.relative_to(dist).as_posix()
        if ".test." in relative or ".e2e." in relative or relative.startswith("testing/"):
            continue
        yield path


def main() -> int:
    manifests = sorted(
        path
        for pattern in ("apps/*/package.json", "packages/*/*/package.json", "tools/*/package.json")
        for path in ROOT.glob(pattern)
    )
    missing = []
    checked = 0
    for manifest in manifests:
        package = json.loads(manifest.read_text(encoding="utf-8"))
        name = package["name"]
        dist = manifest.parent / "dist"
        if name in SKIPPED or not dist.is_dir():
            continue
        declared = {name, *package.get("dependencies", {}), *package.get("peerDependencies", {})}
        found: dict[str, str] = {}
        for path in runtime_files(dist):
            text = path.read_text(encoding="utf-8")
            for match in [*STATIC.finditer(text), *DYNAMIC.finditer(text)]:
                imported = package_of(match.group(1))
                if imported and imported not in declared:
                    found.setdefault(imported, path.relative_to(ROOT).as_posix())
        checked += 1
        missing.extend(f"{name} imports {each} in {where}" for each, where in sorted(found.items()))
    for line in missing:
        print(f"{line}, but does not depend on it", file=sys.stderr)
    if checked == 0:
        print("No built packages: run the build first", file=sys.stderr)
        return 1
    if not missing:
        print(f"{checked} packages import only what they depend on")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
