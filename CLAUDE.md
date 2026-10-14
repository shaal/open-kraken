# open-kraken

Desktop git client with an interactive commit graph. Tauri 2 + React + TypeScript; git access through the `git` CLI from Rust.

- Behavior reference: `docs/graph-behavior-spec.md`.
- Task file: `ROADMAP.md` (worked through by the `ship-next` loop, one task per PR).
- License: MIT.

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
