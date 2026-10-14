# open-kraken

Desktop git client with an interactive commit graph. Tauri 2 + React + TypeScript; git access through the `git` CLI from Rust.

- Behavior reference: `docs/graph-behavior-spec.md`.
- Task file: `ROADMAP.md` (worked through by the `ship-next` loop, one task per PR).
- License: MIT.

## Commands

- Frontend: `pnpm test`, `pnpm typecheck`, `pnpm lint` (ESLint + Prettier check; `pnpm format` fixes).
- Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p git-data`.
- Fixture: `docs/fixtures/verify-demo-repo.sh`.
- CI: `.github/workflows/ci.yml` runs all of the above except the app on every PR (Ubuntu; git-data only, no Tauri build).
- App: `pnpm tauri dev` (window titled "open-kraken"); `pnpm dev` serves only the frontend on port 1420.

Layout: `src/` React frontend; `src-tauri/` Tauri app crate; `crates/git-data/` git CLI access with no Tauri dependency (keep it that way so CI can test it without webkit).

## Clean-room rules (hard rules)

This project models GitKraken Desktop's *behavior* only. GitKraken's code is licensed with a ban on reverse engineering and on building similar software from it.

- Never read, extract, decompile or analyze GitKraken files: `/Applications/GitKraken.app`, its `app.asar`, `~/.Trash/GitKraken-11.1.1.app`, the `@gitkraken/gitkraken-components` package, or the GitLens commit graph code (it uses the same package).
- Never run REA (or any reverse-engineering tool) against GitKraken.
- GPL sources (`pvigier/gitamine`, git `graph.c`, gitk) are reference prose only. Do not copy their code into this MIT project.
- Behavior questions are answered from the spec, public GitKraken help pages, or by using the app normally.

## Safety

- Destructive git actions (reset, rebase, merge, delete, stash drop) run in tests only against temporary copies of the fixture repo (`docs/fixtures/make-demo-repo.sh`). Never against this repo or any user repo.

## Conventions

- Conventional Commits. No AI-authorship trailers in commits or PR descriptions.
- `main` is protected: changes land through PRs (no approval required).
