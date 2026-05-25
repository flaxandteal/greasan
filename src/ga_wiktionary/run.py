"""Pipeline orchestrator: runs filter → normalise → ontolex → arches."""

from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import orjson

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore[no-redef]

from ga_wiktionary.filter import filter_entries
from ga_wiktionary.normalise import normalise_file
from ga_wiktionary.ontolex import shape_file
from ga_wiktionary.arches import emit_csv


def load_config(config_path: Path, fixture: bool = False) -> dict:
    """Load config.toml and return paths dict."""
    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    if fixture:
        paths = config.get("fixture", config["paths"])
    else:
        paths = config["paths"]

    # Resolve relative to config file location (skip non-string values)
    base = config_path.parent
    return {k: base / v for k, v in paths.items() if isinstance(v, str)}


def run_pipeline(config_path: Path, fixture: bool = False) -> None:
    """Run the full pipeline."""
    paths = load_config(config_path, fixture=fixture)
    manifests: list[dict] = []
    start = time.time()

    print(f"[pipeline] Starting {'fixture' if fixture else 'full'} run", file=sys.stderr)
    print(f"[pipeline] Input: {paths['raw_input']}", file=sys.stderr)

    # Stage 1: Filter
    print("[pipeline] Stage 1/4: filter", file=sys.stderr)
    m = filter_entries(paths["raw_input"], paths["filtered"])
    manifests.append(m)
    print(f"  → {m['kept']} lemmas kept, {m['dropped_form_of']} form-of dropped", file=sys.stderr)

    # Stage 2: Normalise
    print("[pipeline] Stage 2/4: normalise", file=sys.stderr)
    m = normalise_file(paths["filtered"], paths["normalised"])
    manifests.append(m)
    print(f"  → {m['total']} entries normalised, {m['unmapped_tag_count']} unmapped tags", file=sys.stderr)

    # Stage 3: OntoLex shaping
    print("[pipeline] Stage 3/4: ontolex", file=sys.stderr)
    m = shape_file(paths["normalised"], paths["shaped"])
    manifests.append(m)
    print(f"  → {m['total']} resources shaped, {m['duplicate_ids_resolved']} ID collisions resolved", file=sys.stderr)

    # Stage 4: Arches CSV
    print("[pipeline] Stage 4/4: arches", file=sys.stderr)
    m = emit_csv(paths["shaped"], paths["business_data"])
    manifests.append(m)
    print(f"  → {m['total_entries']} entries → {m['total_rows']} CSV rows", file=sys.stderr)

    elapsed = time.time() - start
    print(f"[pipeline] Done in {elapsed:.1f}s. Output: {paths['business_data']}", file=sys.stderr)

    # Write manifest
    manifest_dir = config_path.parent / "manifests"
    manifest_dir.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat().replace(":", "-")
    manifest_path = manifest_dir / f"pipeline-{ts}.json"
    manifest_data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "fixture": fixture,
        "elapsed_seconds": round(elapsed, 2),
        "stages": manifests,
    }
    manifest_path.write_bytes(orjson.dumps(manifest_data, option=orjson.OPT_INDENT_2))
    print(f"[pipeline] Manifest: {manifest_path}", file=sys.stderr)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run the ga-wiktionary pipeline")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--fixture", action="store_true", help="Use fixture paths (small test slice)")
    args = parser.parse_args()

    run_pipeline(args.config, fixture=args.fixture)


if __name__ == "__main__":
    main()
