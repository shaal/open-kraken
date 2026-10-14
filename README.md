# open-kraken

Desktop git client with an interactive commit graph. Built with Tauri 2, React and TypeScript; git access goes through the `git` command-line tool.

Status: early development. The app opens a window with a placeholder page. The plan is in [ROADMAP.md](ROADMAP.md); the target behavior is in [docs/graph-behavior-spec.md](docs/graph-behavior-spec.md).

## Prerequisites

- Node.js 22 or newer, and pnpm 10 (`corepack enable` picks the version from `package.json`).
- Rust stable, 1.90 or newer (`rust-version` in `Cargo.toml`).
- git 2.32 or newer.
- The Tauri system packages for your platform: <https://tauri.app/start/prerequisites/> (on macOS: the Xcode Command Line Tools).

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install the JavaScript dependencies. |
| `pnpm tauri dev` | Run the desktop app with hot reload. |
| `pnpm dev` | Run only the web frontend in a browser (port 1420). |
| `pnpm tauri build` | Build the release app and installers. |
| `pnpm test` | Run the frontend tests (Vitest). |
| `pnpm typecheck` | Type-check the frontend (TypeScript, strict). |
| `pnpm lint` | Lint (ESLint) and check formatting (Prettier). `pnpm format` fixes formatting. |
| `cargo test -p git-data` | Run the git-data crate tests (no Tauri or webkit needed). |
| `cargo fmt --all --check` | Check Rust formatting. |
| `cargo clippy --workspace --all-targets -- -D warnings` | Lint the Rust code. |
| `docs/fixtures/verify-demo-repo.sh` | Check the demo repo fixture builds the same SHAs everywhere. |

CI (`.github/workflows/ci.yml`) runs the frontend checks, the git-data checks (also on Rust 1.90), the fixture check and actionlint on every pull request and on `main`.

## Layout

- `src/`: React frontend.
- `src-tauri/`: Tauri app crate.
- `crates/git-data/`: git access through the `git` CLI. No Tauri dependency, so it builds and tests anywhere.
- `docs/`: the behavior spec and the demo repo fixture (`docs/fixtures/make-demo-repo.sh`).

## Clean room

open-kraken models GitKraken Desktop's behavior from public documentation and normal use of the app only. No GitKraken code is read or copied. See [CLAUDE.md](CLAUDE.md) for the rules.

## License

[MIT](LICENSE)
