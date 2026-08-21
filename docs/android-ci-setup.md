# Android CI setup

The GitHub Actions workflows (`app-smoke.yml`, `app-release.yml`) compile the
Tauri app, which depends on **five out-of-tree sibling repos** by relative path.
Locally those siblings live next to this repo under `../magic/`, `../svg/`,
`../Gramadan`. In CI they are vendored as **git submodules under `.deps/`** and
`scripts/ci/link-siblings.sh` symlinks each to the path the manifests expect.

Until this is done, every CI run fails at the checkout/link step. This doc gets
you from nothing to green. It is a one-time setup (plus re-pins when a sandbox
advances).

> Why submodules and not published crates? The RosMadair + alizarin work is
> active sandbox development on feature branches. Submodules pin an exact commit
> per app revision, which is what "reproducible release" needs. Revisit if these
> stabilise into published crates.

## The dependencies

Derived from `app/src-tauri/Cargo.toml` (path deps that climb above the repo) and
`app/package.json` (`file:` deps). Verify with:

```bash
grep -E 'path *= *"\.\.' app/src-tauri/Cargo.toml
grep -E 'file:' app/package.json
```

| `.deps/` submodule | Local path | GitHub home | Provides | Branch (at time of writing) |
|---|---|---|---|---|
| `Gramadan` | `../Gramadan` | `philtweir/Gramadan` (exists) | `gramadan-rs` | `python-implementation-v2` |
| `RosMadair` | `../magic/RosMadair` | `flaxandteal/ros-madair` (exists) | `ros-madair-core`, `pkg-alizarin` | `bench/killgate-range-instrumentation` |
| `alizarin-sandbox` | `../magic/alizarin-sandbox` | **none - must create** | `alizarin-core`, `alizarin` npm | `m1-emitter` |
| `RosMadair-sandbox-parquet` | `../magic/RosMadair-sandbox-parquet` | **none - must create** | `ros-madair-{read,format,handlers,query,emit,duck}` | `prune/duckdb-substrate` |
| `malazan-experiment` | `../svg/malazan-experiment` | **none - not even a git repo** | patched `pagefind` fork | (init first) |

The submodule directory names MUST match the keys in
`scripts/ci/link-siblings.sh` (`LINKS`). If you rename, update both.

## Part 1 - host the un-hosted siblings

Two sandboxes are local-only (their "remote" is a local path); one is not a git
repo yet. They must be on GitHub for CI to fetch them. Create them **private**
(the sandboxes are WIP; you can open them later). Adjust org/branch as needed.

```bash
cd ~/Cód/Oscailte

# alizarin-sandbox (branch m1-emitter)
gh repo create flaxandteal/alizarin-sandbox --private --source magic/alizarin-sandbox --remote gh --push
#   or, if a local-path 'origin' is in the way:
#   git -C magic/alizarin-sandbox remote add gh git@github.com:flaxandteal/alizarin-sandbox.git
#   git -C magic/alizarin-sandbox push -u gh m1-emitter

# RosMadair-sandbox-parquet (branch prune/duckdb-substrate)
gh repo create flaxandteal/ros-madair-sandbox-parquet --private --source magic/RosMadair-sandbox-parquet --remote gh --push

# malazan-experiment - NOT a git repo yet; init, commit, then create + push
cd svg/malazan-experiment
git init -b main && git add -A && git commit -m "vendor: patched pagefind fork for Gréasán CI"
gh repo create flaxandteal/malazan-experiment --private --source . --remote origin --push
cd ~/Cód/Oscailte
```

Also make sure the **branches the app pins are pushed** for the two repos that
already exist on GitHub (they are currently on local feature branches):

```bash
git -C magic/RosMadair push origin bench/killgate-range-instrumentation
git -C Gramadan       push origin python-implementation-v2
```

> A submodule pins a commit; that commit must be reachable on the remote. Push
> the exact branch/commit the app currently builds against before adding it.

## Part 2 - vendor as submodules under `.deps/`

From this repo (on a working branch, not detached). `git submodule add` fetches
the remote, so Part 1 must be done first.

```bash
cd ~/Cód/Oscailte/Gréasán

git submodule add -b python-implementation-v2            git@github.com:philtweir/Gramadan.git                       .deps/Gramadan
git submodule add -b bench/killgate-range-instrumentation git@github.com:flaxandteal/ros-madair.git                  .deps/RosMadair
git submodule add -b m1-emitter                          git@github.com:flaxandteal/alizarin-sandbox.git             .deps/alizarin-sandbox
git submodule add -b prune/duckdb-substrate              git@github.com:flaxandteal/ros-madair-sandbox-parquet.git   .deps/RosMadair-sandbox-parquet
git submodule add -b main                                git@github.com:flaxandteal/malazan-experiment.git           .deps/malazan-experiment

git commit -m "ci: vendor sibling deps as .deps submodules"
git push
```

`.deps/` sits inside the checkout; `link-siblings.sh` symlinks each submodule
out to `$PARENT/<local path>` so the `../../../magic/...` manifest paths resolve.
`.deps/` should be gitignored for the working tree only via the submodule
mechanism - do not also list it in `.gitignore` or submodule status breaks.

## Part 3 - repo secrets

Set on `flaxandteal/greasan`:

```bash
# DEPS_PAT: a PAT with READ (contents) on every dep repo AND greasan-data.
#   Fine-grained token -> Repository access -> select:
#     philtweir/Gramadan, flaxandteal/ros-madair, flaxandteal/alizarin-sandbox,
#     flaxandteal/ros-madair-sandbox-parquet, flaxandteal/malazan-experiment,
#     flaxandteal/greasan-data
#   Permissions -> Contents: Read-only
gh secret set DEPS_PAT --repo flaxandteal/greasan            # paste the token

# ANDROID_ALPHA_KEYSTORE_B64: the alpha signing keystore, base64.
base64 -w0 ~/.android/greasan-alpha.jks | gh secret set ANDROID_ALPHA_KEYSTORE_B64 --repo flaxandteal/greasan
```

The alpha keystore password is the committed alpha pass in `build-apk.sh`
(`greasan-alpha-2026`) - alpha identity only, regenerate before any Play upload.
No separate password secret is needed.

`DATA_BUNDLE_URL` from the old workflow is **gone** - app-release now fetches the
pinned bundle from greasan-data via `bundle-pin.json`.

## Part 4 - verify

- **Smoke**: push any commit to a branch. `app-smoke.yml` builds a base-only APK
  (no data), uploads it as an artifact. Green = the toolchain + deps compile.
- **Release**: push a tag `vX.Y.Z-alpha`. `app-release.yml` fetches the pinned
  bundle, builds the full signed APK, and creates a **draft** release. Review,
  then publish.

```bash
gh run watch --repo flaxandteal/greasan
```

## Keeping submodules in sync

When you advance a sandbox (e.g. new alizarin work), CI still builds the OLD
pinned commit until you bump the submodule:

```bash
git -C .deps/alizarin-sandbox fetch && git -C .deps/alizarin-sandbox checkout <new-commit>
git add .deps/alizarin-sandbox && git commit -m "ci: bump alizarin-sandbox to <new-commit>"
```

This is deliberate: the pin is what makes an app build reproducible. A release
records exactly which sandbox commits it shipped.

## Notes

- `ros-madair-alizarin` (the `pkg-alizarin` npm dep) is a BUILT artifact, not
  source. CI builds it in `.deps/RosMadair` via `npm run build:combined` before
  the app build. Do not commit `pkg-alizarin`.
- Base-only (`app-smoke`) needs **no** data bundle and **no** signing secret - it
  builds a debug-signed, core-only APK. Only `app-release` needs the keystore +
  the pinned bundle.
- Téarma is never in CI (local-only, licensing); it is built on-device.
