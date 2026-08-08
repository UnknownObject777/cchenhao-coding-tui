# AGENTS.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `UnknownObject777/cchenhao-coding-tui` (use the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Implementation workflow

### Large specs go through `/implement`

When a spec or ticket set involves a large change (multi-file, spans modules, or architecturally significant), implement it through the `/implement` workflow (mattpocock/skills): TDD at pre-agreed seams, regular typechecking and single-file test runs, a full test suite pass at the end, then `/code-review` before committing. Small changes may be implemented directly.

### Review every remote commit

After every commit is pushed to the remote, run `/code-review` on that commit (fixed point: the commit's parent or the previous remote head) and resolve any findings before starting the next piece of work.

### Architecture review at milestones

After each milestone completes, run `/improve-codebase-architecture` to surface deepening opportunities before moving on to the next milestone.
