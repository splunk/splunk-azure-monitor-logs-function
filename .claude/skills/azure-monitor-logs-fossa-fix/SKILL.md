---
name: azure-monitor-logs-fossa-fix
description: Use when FOSSA flags dependency findings in the azure-monitor-logs-azure-function repo. Accepts raw FOSSA finding text or structured input (package name, version, depth, fix version). Analyses the full transitive chain, classifies each finding by fixability and production risk, applies safe fixes to package.json manifests, and produces a dismissal message for findings blocked by upstream packages.
argument-hint: "<raw FOSSA findings text, or package list like: axios (1.15.0) Direct; uuid (3.4.0) Transitive>"
---

# Azure Monitor Logs Azure Function — FOSSA Fix

## Use This Skill For

- analysing new FOSSA findings pasted from the FOSSA UI or CI output
- determining which findings are fixable in-repo vs blocked upstream
- applying manifest-only fixes (package.json dependencies / overrides bumps)
- drafting dismissal messages for unfixable findings

## When Not to Use

- source code CVEs (not dependency findings)
- findings already fixed and merged

## Input Format

This skill accepts any of the following — paste as-is from the FOSSA UI:

```
axios (1.15.0)
NPM
Depth
Direct
Upgrade to 1.17.0Fixes 1
1
issue

uuid (3.4.0)
NPM
Depth
Transitive
Upgrade to 11.1.1Fixes 1
1
issue
```

Or a minimal list:
```
axios (1.15.0) Direct
uuid (3.4.0) Transitive
```

Or freeform prose describing the findings.

## Required Files to Read First

- `package.json` (root) — direct deps, overrides, scripts
- `package-lock.json` — resolved versions and transitive chain

This is a single-package repo with no workspaces. Read `package.json` fresh at the start of every session.

## Workflow

### Phase 1 — Parse findings

Extract from input for each finding:
- package name and flagged version
- depth: Direct or Transitive
- FOSSA-suggested fix version
- CVE ID and CVSS score if present

### Phase 1b — Validate parsed names before any shell use

Before substituting any parsed value into a shell snippet, validate every package name and version string against the npm allow-list patterns below. **If a value does not match, stop and report it as malformed input — do not proceed to Phase 2.**

**Allowed pattern for npm package names:**
```text
^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$
```
- Optional `@scope/` prefix (scoped packages)
- Lowercase letters, digits, hyphens, underscores, dots only
- No spaces, quotes, backticks, `$`, `(`, `)`, `;`, `&`, `|`, `>`, `<`, `\`, `/` (other than the single scope separator)

**Allowed pattern for version strings:**
```text
^[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9._-]+)?$
```
- Semver format: `MAJOR.MINOR.PATCH` with optional pre-release suffix
- No spaces or shell-special characters

**Check every extracted value before use:**
- Package name from the finding
- Fix version from the finding
- Consumer package name (discovered in Phase 2)

If any value fails validation, present it to the user as-is and ask them to confirm the correct package name before continuing.

### Phase 2 — Trace each dependency chain

For each finding run (substitute only names that passed Phase 1b validation):
```bash
# Find all package-lock.json entries for the package
node -e "
const lock = JSON.parse(require('fs').readFileSync('package-lock.json','utf8'));
const pkgs = lock.packages || {};
Object.entries(pkgs).filter(([k]) => k.endsWith('/<package>') || k === 'node_modules/<package>').forEach(([k,v]) => console.log(k, v.version));
" 2>/dev/null

# Find which packages require it (scan node_modules package.json files)
node -e "
const fs = require('fs'), path = require('path');
const nm = 'node_modules';
const pkgs = fs.readdirSync(nm).concat(
  fs.readdirSync(nm).filter(d => d.startsWith('@')).flatMap(s =>
    fs.readdirSync(path.join(nm,s)).map(p => path.join(s,p))
  )
);
for (const pkg of pkgs) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(nm,pkg,'package.json'),'utf8'));
    const deps = {...(pj.dependencies||{})};
    if (deps['<package>']) console.log(pj.name+'@'+pj.version+' -> <package>: '+deps['<package>']);
  } catch(e) {}
}
" 2>/dev/null
```

For each consumer, check its import style to detect whether bumping to the FOSSA fix version would break the consumer:
```bash
grep -rn "require.*<package>" node_modules/<consumer>/lib/*.js node_modules/<consumer>/index.js 2>/dev/null
```

Classify each import as:
- **safe** — named export e.g. `const { something } = require('<package>')` or `require('<package>').something` — survives most major bumps
- **breaking** — deep subpath import e.g. `require('<package>/subpath')` — breaks if the package removed that export in the fix version

### Phase 3 — Production vs dev classification

Check whether each consumer reaches the production bundle.

Production dependencies are those listed under `"dependencies"` in `package.json`:
- `axios`, `axios-retry`, `moment`, `node-gzip`

Dev/test-only dependencies are listed under `"devDependencies"`:
- `mocha`, `chai`, `sinon`, `nock`, `rewire`, `ts-node`, `typescript`, `@types/*`, `npm-run-all`

Classification rules:
1. Is the flagged package (or its consumer) in `dependencies`? → **production exposure**
2. Is it only reachable through `devDependencies`, test runners (`mocha`, `sinon`), or type packages? → **dev/test only**

### Phase 4 — Fixability decision tree

For each finding apply this logic:

```
Direct dep?
  YES → bump version in package.json dependencies (or devDependencies)
  NO (Transitive) →
    Is FOSSA fix version available in registry?
      NO → document as upstream blocked, draft dismissal
      YES →
        Does fix version break any consumer's import style?
          YES (e.g. deep subpath import removed in fix version) →
            Can the consumer package be upgraded to a version that uses the safe import style?
              YES → add override for consumer package
              NO → document as upstream blocked, draft dismissal
          NO →
            Would a global override break any other consumer?
              YES → document partial block, draft dismissal for remainder
              NO → add global override in package.json "overrides"
```

### Phase 5 — Pre-apply safety checks

Before writing any fix, run these targeted checks for known-dangerous override patterns.

**Test runner major version gate (e.g. Mocha):**

When a finding involves a package that is an internal dependency of a test runner, read the current installed version of that test runner first:

```bash
node -e "
const pj = JSON.parse(require('fs').readFileSync('package.json','utf8'));
['mocha','sinon','chai','nock'].forEach(t => {
  const v = (pj.devDependencies||{})[t];
  if (v) console.log(t, v);
});" 2>/dev/null
```

Then check the test runner's own declared version range for the internal package:
```bash
cat node_modules/<test-runner>/package.json | node -e "
const pj=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(JSON.stringify({...pj.dependencies,...pj.peerDependencies},null,2));" 2>/dev/null | grep <internal-package>
```

Apply the fix version only within the major range the current test runner declares. If the FOSSA suggestion requires a major the test runner does not support, the safe fix is the latest patch of the currently-declared major. Document this constraint in the MR description.

**ESM-only package gate:**

Some packages published a major version that dropped CommonJS (`require()`) support. Before adding a global override to such a version, verify that none of the consumers use `require()`:

```bash
node -e "
const fs=require('fs'),path=require('path');
const nm='node_modules';
const pkgs=fs.readdirSync(nm).concat(
  fs.readdirSync(nm).filter(d=>d.startsWith('@')).flatMap(s=>
    fs.readdirSync(path.join(nm,s)).map(p=>path.join(s,p))
  )
);
for(const pkg of pkgs){
  try{
    const pj=JSON.parse(fs.readFileSync(path.join(nm,pkg,'package.json'),'utf8'));
    if((pj.dependencies||{})['<package>'])console.log(pj.name,'type:',pj.type||'commonjs');
  }catch(e){}
}" 2>/dev/null
```

If any consumer has `type: commonjs` (or no `type` field) and the fix-version package is ESM-only (check its `package.json` for `"type": "module"` with no `main` CJS entry), a global override will break that consumer at `require()` time.

### Phase 6 — Apply fixes

Fixes are **manifest-only** — never modify source code.

**Direct dep bump** (in `dependencies` or `devDependencies`):
```json
"<package>": "^<fix-version>"
```

**Global override (npm overrides):**
```json
// package.json "overrides"
"<package>": "^<fix-version>"
```

**Consumer package override** (to pull in a consumer that has fixed its own dep):
```json
// package.json "overrides"
"<consumer-package>": "^<consumer-fix-version>"
```

**Test reporter / tooling dep as fix lever:**
When a transitive finding runs through a test tool (e.g. `mocha`, `nock`, `sinon`), check whether a newer version of that tool has already dropped the flagged dep version:
```bash
npm view <tool-package> versions --json | node -e "
const versions=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
versions.slice(-10).forEach(v => process.stdout.write(v+' '));" 2>/dev/null
# Then for the candidate version:
npm view <tool-package>@<candidate> dependencies 2>/dev/null | grep <flagged-package>
```
If a newer version dropped the flagged dep, bump the tool in `devDependencies`. This clears the FOSSA finding without touching production code.

After all edits, verify no conflict markers remain in any edited file.

### Phase 7 — Draft dismissal messages

For each blocked finding, produce a dismissal message with:

1. **Finding** — package name, version, CVE if present
2. **Why it cannot be fixed from this repo** — the full transitive chain and the specific technical blocker
3. **Actual risk assessment** — is this production or dev/test only? What is the real exposure?
4. **Unblocking path** — what upstream change is needed and which team owns it
5. **Request** — snooze duration (default 2 weeks) with justification

### Phase 8 — Branch workflow

FOSSA fixes in this repo target two branches:

1. **develop** — primary fix branch, e.g. `fix/fossa-<date>`
2. **active release branch** — if one exists, apply identical manifest changes there too

The MR description should include:
- a brief summary of each fix applied and why it is safe
- the full list of remaining blocked findings with the technical reason each cannot be fixed
- the unblocking condition for each blocker (what upstream change resolves it)

### Phase 9 — Output

Produce in order:

1. **Finding summary table**

| Package | Version | Depth | CVE | Production? | Action |
|---|---|---|---|---|---|
| axios | 1.15.0 | Direct | — | Yes | Bump to ^1.17.0 |
| uuid | 3.4.0 | Transitive | — | No (dev only) | Blocked — upstream |

2. **Changes made** — list each file edited and what changed

3. **Remaining findings** — for each blocked finding, the dismissal message ready to paste

## Key facts about this repo (do not re-derive)

- **npm** (not yarn) — uses `package-lock.json`; overrides are declared in `"overrides"` (not `"resolutions"`)
- **Single-package repo** — no workspaces; `package.json` is the only manifest
- **Production deps**: `axios`, `axios-retry`, `moment`, `node-gzip`
- **Dev/test deps**: `mocha`, `chai`, `sinon`, `nock`, `rewire`, `ts-node`, `typescript`, `@types/*`, `npm-run-all`, `@azure/functions`
- This is an Azure Function written in TypeScript — the compiled output goes to `dist/`
- The `"overrides"` field is already present in `package.json` (currently pinning `@babel/runtime`) — add new overrides alongside existing ones, do not replace the field
