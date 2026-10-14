//! Writes the browser fixture (see `git_data::Fixture`) for a repository as JSON.
//!
//! Usage: dump <repo> [--name <name>] [--range <sha,sha,...>]...
//! `scripts/update-fixture.sh` runs it on the demo repo.

use std::collections::BTreeMap;
use std::process::ExitCode;

use git_data::{Fixture, GitError, Repo, RepoInfo, range_key};

fn main() -> ExitCode {
    match run() {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("dump: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, String> {
    let mut args = std::env::args().skip(1);
    let usage = "usage: dump <repo> [--name <name>] [--range <sha,sha,...>]...";
    let path = args.next().ok_or(usage)?;
    let mut name = None;
    let mut ranges = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--name" => name = Some(args.next().ok_or(usage)?),
            "--range" => ranges.push(args.next().ok_or(usage)?),
            _ => return Err(usage.to_owned()),
        }
    }
    let fixture = build(&path, name, &ranges).map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&fixture).map_err(|e| e.to_string())
}

fn build(path: &str, name: Option<String>, ranges: &[String]) -> Result<Fixture, GitError> {
    let repo = Repo::open(path)?;
    let graph = repo.graph_data()?;
    let mut commit_files = BTreeMap::new();
    for commit in &graph.log {
        commit_files.insert(commit.sha.clone(), repo.commit_files(&commit.sha)?);
    }
    let mut range_files = BTreeMap::new();
    for range in ranges {
        let shas: Vec<&str> = range.split(',').collect();
        range_files.insert(range_key(&shas), repo.range_files(&shas)?);
    }
    // The paths of the machine that ran the dump are not part of the fixture.
    let real = repo.info();
    let name = name.unwrap_or(real.name);
    let info = RepoInfo {
        root: name.clone(),
        git_dir: if real.bare {
            name.clone()
        } else {
            format!("{name}/.git")
        },
        bare: real.bare,
        name,
    };
    Ok(Fixture {
        info,
        graph,
        commit_files,
        range_files,
    })
}
