---
name: azure-monitor-logs-version-bump
description: Use when bumping the repository release version in the azure-monitor-logs-azure-function repo. Accepts an explicit target version, or defaults to a minor bump (e.g. 4.7.0 -> 4.8.0). Updates package.json and package-lock.json in lockstep via npm, verifies consistency, and reports the downstream CI/artifact impact — never commits or pushes.
argument-hint: "[new version, e.g. 4.9.0 or 5.0.0 — omit to bump the minor version by default]"
---

# Azure Monitor Logs Azure Function — Version Bump

## Use This Skill For

- bumping the release version ahead of a versioned build/deploy
- bumping to a specific target version (major, minor, or patch)
- the default case: no version given → bump the minor version, patch resets to `0`

## When Not to Use

- editing `host.json` `"version"` — that is the Azure Functions host schema version, unrelated to the release version
- bumping a dependency's version (e.g. FOSSA fixes) — use `azure-monitor-logs-fossa-fix` instead

## Required Files to Read First

- `package.json` (root, `"version"` field) — the single source of truth for the release version
- `package-lock.json` — mirrors the version in two places: the root `"version"` and `packages[""].version`

This is a single-package repo with no workspaces. Read `package.json` fresh at the start of every session — do not assume the version from memory or from a prior run.

## Workflow

### Phase 1 — Read current version

```bash
node -e "console.log(require('./package.json').version)"
```

### Phase 2 — Determine target version

- If the caller supplied a version, validate it against semver: `^[0-9]+\.[0-9]+\.[0-9]+$`. If it does not match, stop and ask for a corrected value — do not guess or coerce it.
- If the caller supplied no version, the target is a **minor bump**: `MAJOR.(MINOR+1).0`. E.g. current `4.7.0` → target `4.8.0`. Patch always resets to `0` on a minor bump — do not carry the old patch number forward.
- Sanity check: the target version must be strictly greater than the current version (semver order). If it is not, stop and confirm with the user before proceeding — a same-or-lower version usually means a mistake, not an intentional downgrade.

### Phase 3 — Apply the bump

Use `npm version` so `package.json` and `package-lock.json` stay in lockstep — do not hand-edit the version string with `sed`/`Edit`, since `package-lock.json` has two separate copies of it (`version` at the root and `packages[""].version`) that must match exactly or `npm ci` will complain.

```bash
npm version <target> --no-git-tag-version
```

`--no-git-tag-version` is required — it stops `npm version` from creating a commit and a git tag. This skill only edits the working tree; committing/tagging/pushing is a separate, user-initiated step (see Git Safety Protocol).

### Phase 4 — Verify consistency

```bash
npm run get-version
node -e "
const pkg = require('./package.json').version;
const lock = require('./package-lock.json');
console.log('package.json:', pkg);
console.log('package-lock.json root:', lock.version);
console.log('package-lock.json packages[\"\"]:', lock.packages[''].version);
"
```

All three must match the target version. If any diverge, do not proceed — re-run `npm version` rather than patching the mismatch by hand.

### Phase 5 — Report

Report, in order:

1. **Old version → new version**
2. **Files changed** — `package.json`, `package-lock.json` (both are the only files this skill touches)
3. **Downstream impact reminder** (from `AGENTS.md`): the version string flows directly into the CI-built artifact name (`azure-monitor-logs-azure-function-<version>.zip`, via `npm run package`) and the Artifactory path used by `deploy-prd`. Confirm with the user whether this bump is meant for an actual versioned release vs. a dev build — do not assume.
4. **Not done automatically** — no commit, tag, or push was made. Hand off to the user for review/commit.

## Key facts about this repo (do not re-derive)

- **npm** (not yarn) — `package-lock.json` is present and must be kept in sync; use `npm version`, never hand-edit the version fields
- **Single-package repo** — no workspaces; `package.json` is the only manifest with a release version
- `host.json`'s `"version": "2.0"` is the Azure Functions host schema version — unrelated, never touch it for a release bump
- The zip artifact name and Artifactory/blob path embed `$npm_package_version` (see `"package"` and `"get-version"` scripts in `package.json`, and `.gitlab-ci.yml`'s `.build-and-package` job)
- Default bump type is **minor** (`4.7.0` → `4.8.0`), per this repo's convention — patch bumps and major bumps must be requested explicitly
