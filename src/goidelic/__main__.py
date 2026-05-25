"""Entry point for python -m goidelic."""

import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  python -m goidelic.fetch --output data/raw/ --language ga", file=sys.stderr)
        print("  python -m goidelic.run --config config.toml", file=sys.stderr)
        print("  python -m goidelic.run --config config.toml --fixture", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
