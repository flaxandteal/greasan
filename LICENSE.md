# Licensing

This repository contains multiple components under different licenses.

## Code — AGPL-3.0-or-later

All original source code in this repository (pipeline, app, scripts, tests) is
licensed under the **GNU Affero General Public License v3.0 or later**.

> Copyright (C) 2026 Flax & Teal Limited
>
> This program is free software: you can redistribute it and/or modify it under
> the terms of the GNU Affero General Public License as published by the Free
> Software Foundation, either version 3 of the License, or (at your option) any
> later version.
>
> This program is distributed in the hope that it will be useful, but WITHOUT
> ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
> FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
> details.
>
> You should have received a copy of the GNU Affero General Public License along
> with this program. If not, see <https://www.gnu.org/licenses/>.

The full AGPL-3.0 text is available at:
<https://www.gnu.org/licenses/agpl-3.0.txt>

## Derived corpus — CC BY-SA 4.0

The dictionary data produced by the pipeline is derived from English Wiktionary
via [Kaikki.org](https://kaikki.org) (Wiktextract). The source material is
dual-licensed under **CC BY-SA 3.0 / 4.0** and **GFDL**. Our derived corpus is
released under **Creative Commons Attribution-ShareAlike 4.0 International**
(CC BY-SA 4.0).

> <https://creativecommons.org/licenses/by-sa/4.0/>

Attribution and provenance details (dump dates, revision links, Kaikki extract
metadata) are recorded per-entry in Source resources and in
`manifests/*.json`. See the `citation` pipeline stage and
[Wiktionary:Copyrights](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)
for full attribution requirements.

**Citation**: Ylonen, T. (2022). Wiktextract: Wiktionary as Machine-Readable
Structured Data. *Proceedings of LREC 2022*, Marseille, France.

## Ontology — local extensions

The local ontology (`ontology/ga-wiktionary.ttl`) imports from and extends:

| Ontology | License |
|---|---|
| [OntoLex-Lemon](http://www.w3.org/ns/lemon/ontolex#) | W3C Community Final Specification Agreement / CC0 |
| [Lexicog](http://www.w3.org/ns/lemon/lexicog#) | W3C Community Final Specification Agreement |
| [LexInfo 3.0](http://www.lexinfo.net/ontology/3.0/lexinfo#) | Apache-2.0 |
| [lemonEty](http://lari-datasets.ilc.cnr.it/lemonEty#) | CC-BY |

Local extensions in `ga-wiktionary.ttl` are licensed under AGPL-3.0-or-later
(as code) and CC BY-SA 4.0 (as a vocabulary), at the licensee's choice.

## Third-party dependencies

Key runtime and build dependencies and their licenses:

| Package | License |
|---|---|
| [alizarin](https://github.com/flaxandteal/alizarin) / @alizarin/clm | AGPL-3.0 |
| [ros-madair](https://github.com/flaxandteal/RosMadair) | AGPL-3.0 |
| [Svelte](https://svelte.dev) | MIT |
| [Vite](https://vite.dev) | MIT |
| [Tailwind CSS](https://tailwindcss.com) | MIT |
| [Konsta](https://konstaui.com) | MIT |
| [Pagefind](https://pagefind.app) | MIT |
| [orjson](https://github.com/ijl/orjson) | MIT / Apache-2.0 / MPL-2.0 |
| [httpx](https://www.python-httpx.org) | BSD-3-Clause |
| [Pydantic](https://docs.pydantic.dev) | MIT |
| [rdflib](https://rdflib.readthedocs.io) | BSD-3-Clause |
| [pySHACL](https://github.com/RDFLib/pySHACL) | Apache-2.0 |
| [pytest](https://pytest.org) | MIT |

All listed dependencies use licenses compatible with AGPL-3.0 distribution.
