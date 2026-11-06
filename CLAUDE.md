# NYC 311 Calls

## Branches and releases

- `dev` is the default branch; `main` is production and deploys to GitHub Pages
  on every push. Branch feature work from `dev` and open PRs into `dev`.
  Releases are a `dev` → `main` PR. Never commit or push straight to `main`.
- Commit, push and open PRs only when the user asks.
- When the user asks for a release, do all of it:
  1. Open a `dev` → `main` PR listing the PRs going live, and merge it with a
     merge commit, without deleting `dev`.
  2. Wait for the "Deploy to GitHub Pages" workflow run to finish, then check
     the live site (new code served, data loads, filters and timeline work).
  3. Sync the release merge commit back with a `main` → `dev` PR, merged
     without deleting `main` (so no `--delete-branch`), then pull `dev`
     locally. This keeps the next release PR showing only new work.
- Everything in `public/` goes live on release, so don't put local-only tools
  or secrets there.
