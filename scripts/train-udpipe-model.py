#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Train the UD Irish UDPipe model used to POS-disambiguate example matches.

The example matcher (src/goidelic/examples.py) links a surface word like "fear" to
every goi-fear-<pos> entry. With this model present it instead tags the token in
context and links only the matching POS (fear-noun OR fear-verb). Without it, the
matcher degrades gracefully to the fan-out.

Trains a tokenizer + tagger (no parser) from the cached UD_Irish-IDT treebank
(data/raw/examples/ga_idt-ud-{train,dev}.conllu, fetched by the examples stage)
into data/models/irish.udpipe. Needs `ufal.udpipe` (pip install ufal.udpipe).

    uv run python scripts/train-udpipe-model.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from ufal.udpipe import InputFormat, ProcessingError, Sentence, Trainer

REPO = Path(__file__).resolve().parent.parent
CONLLU_DIR = REPO / "data" / "raw" / "examples"
OUT = REPO / "data" / "models" / "irish.udpipe"


def read_conllu(path: Path) -> list:
    reader = InputFormat.newConlluInputFormat()
    reader.setText(path.read_text(encoding="utf-8"))
    err = ProcessingError()
    s = Sentence()
    out = []
    while reader.nextSentence(s, err):
        out.append(s)
        s = Sentence()
    return out


def main() -> None:
    train_path = CONLLU_DIR / "ga_idt-ud-train.conllu"
    dev_path = CONLLU_DIR / "ga_idt-ud-dev.conllu"
    if not train_path.exists():
        sys.exit(f"[train-udpipe] missing {train_path} - run the examples stage first")

    train = read_conllu(train_path)
    dev = read_conllu(dev_path) if dev_path.exists() else []
    print(f"[train-udpipe] train {len(train)} dev {len(dev)} sentences", file=sys.stderr)

    err = ProcessingError()
    model = Trainer.train(
        "morphodita_parsito", train, dev,
        Trainer.DEFAULT, Trainer.DEFAULT, Trainer.NONE,  # tokenizer, tagger, NO parser
        err,
    )
    if err.occurred():
        sys.exit(f"[train-udpipe] {err.message}")

    data = model if isinstance(model, (bytes, bytearray)) else model.encode("latin-1")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(data)
    print(f"[train-udpipe] wrote {OUT} ({len(data)} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
