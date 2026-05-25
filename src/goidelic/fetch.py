"""Fetch Goidelic JSONL from Kaikki.org and record provenance.

Downloads the per-language postprocessed JSONL for any configured
Goidelic language. Records dump metadata and file hash in a manifest
under manifests/.
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

CHUNK_SIZE = 256 * 1024  # 256 KiB


def kaikki_urls(kaikki_name: str) -> tuple[str, str]:
    """Return (index_url, jsonl_url) for a given Kaikki language name."""
    # Kaikki directory uses the original name (spaces percent-encoded by httpx).
    # The JSONL filename strips spaces (e.g. "Scottish Gaelic" → "ScottishGaelic").
    file_name = kaikki_name.replace(" ", "")
    base = f"https://kaikki.org/dictionary/{kaikki_name}"
    return (
        f"{base}/index.html",
        f"{base}/kaikki.org-dictionary-{file_name}.jsonl",
    )


class KaikkiMetadata(BaseModel):
    """Metadata scraped from a Kaikki language index page."""

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
    """Extract dump metadata from a Kaikki language index page HTML."""
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


def fetch_metadata_from_url(client: httpx.Client, index_url: str) -> KaikkiMetadata:
    """Fetch and parse metadata from a Kaikki language index page."""
    resp = client.get(index_url)
    resp.raise_for_status()
    return scrape_metadata(resp.text)


def download_jsonl(client: httpx.Client, jsonl_url: str, output_path: Path) -> str:
    """Stream-download a JSONL file. Returns SHA-256 hex digest."""
    h = hashlib.sha256()
    with client.stream("GET", jsonl_url) as resp:
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
    kaikki_name: str = "Irish",
) -> FetchManifest:
    """Run the full fetch: scrape metadata, download JSONL, write manifest.

    If the file already exists with a matching size, skips the download.
    """
    index_url, jsonl_url = kaikki_urls(kaikki_name)
    url_name = kaikki_name.replace(" ", "_")

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"kaikki.org-dictionary-{url_name}.jsonl"

    with httpx.Client(follow_redirects=True, timeout=300) as client:
        metadata = fetch_metadata_from_url(client, index_url)

        # Check if we already have this exact file
        if output_path.exists():
            existing_hash = sha256_file(output_path)
            # Do a HEAD request to check content-length as a quick staleness check
            head_resp = client.head(jsonl_url)
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
                file_hash = download_jsonl(client, jsonl_url, output_path)
        else:
            print(f"Downloading {jsonl_url}...", file=sys.stderr)
            file_hash = download_jsonl(client, jsonl_url, output_path)

    file_size = output_path.stat().st_size
    now = datetime.now(timezone.utc).isoformat()

    manifest = FetchManifest(
        source_url=jsonl_url,
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
        description="Fetch Goidelic JSONL from Kaikki.org"
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
    parser.add_argument(
        "--language",
        type=str,
        default="Irish",
        help="Kaikki language name (default: Irish). E.g. 'Irish', 'Scottish Gaelic'",
    )
    args = parser.parse_args()
    fetch(args.output, args.manifests, kaikki_name=args.language)


if __name__ == "__main__":
    main()
