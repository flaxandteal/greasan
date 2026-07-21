"""Pipeline orchestrator: runs filter → normalise → ontolex → arches → examples."""

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

from goidelic.filter import filter_entries
from goidelic.normalise import normalise_file
from goidelic.ontolex import shape_file
from goidelic.arches import emit_csv
from goidelic.examples import run as run_examples
from goidelic.tbx import parse_tbx_to_jsonl


def load_config(config_path: Path, fixture: bool = False) -> dict:
    """Load config.toml and return full config with resolved paths."""
    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    base = config_path.parent

    if fixture:
        paths = config.get("fixture", config["paths"])
    else:
        paths = config["paths"]

    # Resolve path values relative to config file location
    resolved_paths = {k: base / v for k, v in paths.items() if isinstance(v, str)}

    # Build language configs
    lang_section = config.get("languages", {})
    lang_codes = lang_section.get("codes", ["ga"])
    lang_configs: dict[str, dict] = {}
    for code in lang_codes:
        lang_conf = lang_section.get(code, {})
        lang_configs[code] = {
            "raw_input": base / lang_conf["raw_input"] if "raw_input" in lang_conf else None,
            "kaikki_name": lang_conf.get("kaikki_name", ""),
            "default_dialect": lang_conf.get("default_dialect", ""),
        }

    return {
        "paths": resolved_paths,
        "lang_codes": lang_codes,
        "lang_configs": lang_configs,
        "graphs": config.get("graphs", {}),
        "fixture": fixture,
        # For fixture mode, use a single raw_input
        "fixture_raw_input": base / config["fixture"]["raw_input"] if fixture and "fixture" in config else None,
    }


def run_tbx_pipeline(config_path: Path, tbx_path: Path, layer_code: str = "") -> None:
    """Run the TBX-specific pipeline: tbx → ontolex → arches."""
    cfg = load_config(config_path)
    paths = cfg["paths"]
    manifests: list[dict] = []
    start = time.time()

    # Resolve TBX output paths (parallel to main pipeline, prefixed with tearma_)
    base = config_path.parent
    tbx_normalised = base / "data" / "interim" / "tearma_normalised.jsonl"
    tbx_shaped = base / "data" / "interim" / "tearma_shaped.jsonl"
    tbx_csv = base / "data" / "processed" / "tearma_lexical_entry_data.csv"

    print(f"[pipeline] Starting TBX pipeline: {tbx_path}", file=sys.stderr)
    if layer_code:
        print(f"[pipeline] Layer code: {layer_code}", file=sys.stderr)

    # Stage 1: Parse TBX → normalised JSONL
    print("[pipeline] Stage 1/3: tbx parse", file=sys.stderr)
    m = parse_tbx_to_jsonl(tbx_path, tbx_normalised, source_label=layer_code)
    manifests.append(m)
    print(f"  → {m['total_entries']} entries parsed, {len(m['domains_seen'])} domains", file=sys.stderr)

    # Stage 2: OntoLex shaping
    print("[pipeline] Stage 2/3: ontolex", file=sys.stderr)
    m = shape_file(tbx_normalised, tbx_shaped)
    manifests.append(m)
    print(f"  → {m['resources']} resources from {m['total_entries']} entries, {m['merged_resources']} dialect-merged", file=sys.stderr)

    # Stage 3: Arches CSV
    print("[pipeline] Stage 3/3: arches", file=sys.stderr)
    m = emit_csv(tbx_shaped, tbx_csv)
    manifests.append(m)
    print(f"  → {m['total_entries']} entries → {m['total_rows']} CSV rows", file=sys.stderr)

    elapsed = time.time() - start
    print(f"[pipeline] Done in {elapsed:.1f}s. Output: {tbx_csv}", file=sys.stderr)

    # Write manifest
    manifest_dir = config_path.parent / "manifests"
    manifest_dir.mkdir(exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat().replace(":", "-")
    manifest_path = manifest_dir / f"tbx-pipeline-{ts}.json"
    manifest_data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "tearma",
        "tbx_path": str(tbx_path),
        "elapsed_seconds": round(elapsed, 2),
        "stages": manifests,
    }
    manifest_path.write_bytes(orjson.dumps(manifest_data, option=orjson.OPT_INDENT_2))
    print(f"[pipeline] Manifest: {manifest_path}", file=sys.stderr)


def run_pipeline(config_path: Path, fixture: bool = False) -> None:
    """Run the full pipeline."""
    cfg = load_config(config_path, fixture=fixture)
    paths = cfg["paths"]
    lang_configs = cfg["lang_configs"]
    manifests: list[dict] = []
    start = time.time()

    print(f"[pipeline] Starting {'fixture' if fixture else 'full'} run", file=sys.stderr)
    print(f"[pipeline] Languages: {cfg['lang_codes']}", file=sys.stderr)

    # Determine input files
    if fixture and cfg.get("fixture_raw_input"):
        # Fixture mode: single file containing all languages
        input_paths = [cfg["fixture_raw_input"]]
        lang_code_set = set(cfg["lang_codes"])
    else:
        # Full mode: one raw file per language
        input_paths = []
        for code in cfg["lang_codes"]:
            raw = lang_configs[code].get("raw_input")
            if raw:
                input_paths.append(raw)
        lang_code_set = set(cfg["lang_codes"])

    # Stage 1: Filter
    print("[pipeline] Stage 1/5: filter", file=sys.stderr)
    m = filter_entries(input_paths, paths["filtered"], lang_codes=lang_code_set)
    manifests.append(m)
    print(f"  → {m['kept']} lemmas kept, {m['dropped_form_of']} form-of dropped", file=sys.stderr)

    # Stage 2: Normalise
    print("[pipeline] Stage 2/5: normalise", file=sys.stderr)
    dialect_defaults = {code: lc["default_dialect"] for code, lc in lang_configs.items() if lc.get("default_dialect")}
    m = normalise_file(paths["filtered"], paths["normalised"], dialect_defaults=dialect_defaults, source_label="WK")
    manifests.append(m)
    print(f"  → {m['total']} entries normalised, {m['unmapped_tag_count']} unmapped tags", file=sys.stderr)

    # Stage 3: OntoLex shaping
    print("[pipeline] Stage 3/5: ontolex", file=sys.stderr)
    m = shape_file(paths["normalised"], paths["shaped"])
    manifests.append(m)
    print(f"  → {m['resources']} resources from {m['total_entries']} entries, {m['merged_resources']} dialect-merged", file=sys.stderr)

    # Stage 4: Arches CSV
    print("[pipeline] Stage 4/5: arches", file=sys.stderr)
    m = emit_csv(paths["shaped"], paths["business_data"])
    manifests.append(m)
    print(f"  → {m['total_entries']} entries → {m['total_rows']} CSV rows", file=sys.stderr)

    # Stage 5: External examples (fetch, match, augment entry CSV)
    example_graph_id = cfg["graphs"].get("external_example", "")
    if example_graph_id and paths.get("example_data"):
        print("[pipeline] Stage 5/5: examples", file=sys.stderr)
        run_examples(
            example_csv_path=paths["example_data"],
            entry_csv_path=paths["business_data"],
            example_graph_id=example_graph_id,
            cache_dir=config_path.parent / "data" / "raw" / "examples",
        )
    else:
        print("[pipeline] Stage 5/5: examples (skipped — no graph ID or path)", file=sys.stderr)

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
        "languages": cfg["lang_codes"],
        "elapsed_seconds": round(elapsed, 2),
        "stages": manifests,
    }
    manifest_path.write_bytes(orjson.dumps(manifest_data, option=orjson.OPT_INDENT_2))
    print(f"[pipeline] Manifest: {manifest_path}", file=sys.stderr)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run the goidelic pipeline")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--fixture", action="store_true", help="Use fixture paths (small test slice)")
    parser.add_argument("--tbx", type=Path, help="Run TBX pipeline instead (path to .tbx file)")
    parser.add_argument("--layer-code", type=str, default="", help="Two-letter source label stamped on every sense (e.g. TE)")
    args = parser.parse_args()

    if args.tbx:
        run_tbx_pipeline(args.config, args.tbx, layer_code=args.layer_code)
    else:
        run_pipeline(args.config, fixture=args.fixture)


if __name__ == "__main__":
    main()
