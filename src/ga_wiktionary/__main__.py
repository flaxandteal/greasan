"""Entry point for python -m ga_wiktionary."""

import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  python -m ga_wiktionary.fetch --output data/raw/", file=sys.stderr)
        print("  python -m ga_wiktionary.run --config config.toml", file=sys.stderr)
        print("  python -m ga_wiktionary.run --config config.toml --fixture", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
