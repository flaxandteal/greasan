"""Fetch Modern Irish JSONL from Kaikki.org and record provenance.

Downloads the (deprecated but still available) per-language postprocessed
Irish JSONL. Records dump metadata and file hash in a manifest under
manifests/.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
import orjson
from pydantic import BaseModel

KAIKKI_BASE = "https://kaikki.org/dictionary/Irish"
KAIKKI_INDEX = f"{KAIKKI_BASE}/index.html"
KAIKKI_JSONL = f"{KAIKKI_BASE}/kaikki.org-dictionary-Irish.jsonl"

CHUNK_SIZE = 256 * 1024  # 256 KiB


class KaikkiMetadata(BaseModel):
    """Metadata scraped from the Kaikki Irish index page."""

    dump_date: str
    extract_date: str
    wiktextract_commit: str
    wikitextprocessor_commit: str


class FetchManifest(BaseModel):
    """Provenance record for a single fetch run."""

    source_url: str
    dump_date: str
    extract_date: str
    wiktextract_commit: str
    wikitextprocessor_commit: str
    file_sha256: str
    output_path: str
    file_size_bytes: int
    fetch_timestamp: str


def scrape_metadata(html: str) -> KaikkiMetadata:
    """Extract dump metadata from the Kaikki Irish index page HTML."""
    dump_match = re.search(r"dump\s+dated\s+(\d{4}-\d{2}-\d{2})", html)
    extract_match = re.search(r"extracted on (\d{4}-\d{2}-\d{2})", html)
    wiktextract_match = re.search(r"wiktextract/commit/([0-9a-f]+)", html)
    wikitextprocessor_match = re.search(
        r"wikitextprocessor/commit/([0-9a-f]+)", html
    )

    if not all(
        [dump_match, extract_match, wiktextract_match, wikitextprocessor_match]
    ):
        missing = []
        if not dump_match:
            missing.append("dump_date")
        if not extract_match:
            missing.append("extract_date")
        if not wiktextract_match:
            missing.append("wiktextract_commit")
        if not wikitextprocessor_match:
            missing.append("wikitextprocessor_commit")
        raise ValueError(
            f"Could not scrape metadata from Kaikki page: missing {', '.join(missing)}. "
            "The page format may have changed."
        )

    return KaikkiMetadata(
        dump_date=dump_match.group(1),  # type: ignore[union-attr]
        extract_date=extract_match.group(1),  # type: ignore[union-attr]
        wiktextract_commit=wiktextract_match.group(1),  # type: ignore[union-attr]
        wikitextprocessor_commit=wikitextprocessor_match.group(1),  # type: ignore[union-attr]
    )


def sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK_SIZE):
            h.update(chunk)
    return h.hexdigest()


def fetch_metadata(client: httpx.Client) -> KaikkiMetadata:
    """Fetch and parse metadata from the Kaikki Irish index page."""
    resp = client.get(KAIKKI_INDEX)
    resp.raise_for_status()
    return scrape_metadata(resp.text)


def download_jsonl(client: httpx.Client, output_path: Path) -> str:
    """Stream-download the Irish JSONL file. Returns SHA-256 hex digest."""
    h = hashlib.sha256()
    with client.stream("GET", KAIKKI_JSONL) as resp:
        resp.raise_for_status()
        with open(output_path, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=CHUNK_SIZE):
                f.write(chunk)
                h.update(chunk)
    return h.hexdigest()


def write_manifest(manifest: FetchManifest, manifests_dir: Path) -> Path:
    """Write a manifest JSON file. Returns the path written."""
    manifests_dir.mkdir(parents=True, exist_ok=True)
    # Use a filesystem-safe timestamp
    safe_ts = manifest.fetch_timestamp.replace(":", "-")
    manifest_path = manifests_dir / f"{safe_ts}.json"
    manifest_path.write_bytes(
        orjson.dumps(manifest.model_dump(), option=orjson.OPT_INDENT_2)
    )
    return manifest_path


def fetch(
    output_dir: Path,
    manifests_dir: Path,
) -> FetchManifest:
    """Run the full fetch: scrape metadata, download JSONL, write manifest.

    If the file already exists with a matching SHA-256, skips the download.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "kaikki.org-dictionary-Irish.jsonl"

    with httpx.Client(follow_redirects=True, timeout=300) as client:
        metadata = fetch_metadata(client)

        # Check if we already have this exact file
        if output_path.exists():
            existing_hash = sha256_file(output_path)
            # Do a HEAD request to check content-length as a quick staleness check
            head_resp = client.head(KAIKKI_JSONL)
            head_resp.raise_for_status()
            remote_size = int(head_resp.headers.get("content-length", 0))
            local_size = output_path.stat().st_size

            if remote_size > 0 and remote_size == local_size:
                print(
                    f"File already exists with matching size ({local_size:,} bytes), "
                    f"skipping download.",
                    file=sys.stderr,
                )
                file_hash = existing_hash
            else:
                print(
                    f"File size mismatch (local={local_size:,}, remote={remote_size:,}), "
                    f"re-downloading.",
                    file=sys.stderr,
                )
                file_hash = download_jsonl(client, output_path)
        else:
            print(f"Downloading {KAIKKI_JSONL}...", file=sys.stderr)
            file_hash = download_jsonl(client, output_path)

    file_size = output_path.stat().st_size
    now = datetime.now(timezone.utc).isoformat()

    manifest = FetchManifest(
        source_url=KAIKKI_JSONL,
        dump_date=metadata.dump_date,
        extract_date=metadata.extract_date,
        wiktextract_commit=metadata.wiktextract_commit,
        wikitextprocessor_commit=metadata.wikitextprocessor_commit,
        file_sha256=file_hash,
        output_path=str(output_path),
        file_size_bytes=file_size,
        fetch_timestamp=now,
    )

    manifest_path = write_manifest(manifest, manifests_dir)
    print(f"Manifest written to {manifest_path}", file=sys.stderr)
    print(
        f"  dump_date={metadata.dump_date}  "
        f"extract_date={metadata.extract_date}  "
        f"sha256={file_hash[:16]}...",
        file=sys.stderr,
    )

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch Modern Irish JSONL from Kaikki.org"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/raw"),
        help="Output directory for the downloaded JSONL (default: data/raw)",
    )
    parser.add_argument(
        "--manifests",
        type=Path,
        default=Path("manifests"),
        help="Directory for manifest files (default: manifests)",
    )
    args = parser.parse_args()
    fetch(args.output, args.manifests)


if __name__ == "__main__":
    main()
