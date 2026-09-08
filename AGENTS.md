# AGENTS.md

This file is the agent contract for the `azure-monitor-logs-azure-function` repository.
All agents working in this codebase should treat it as the tactical source of truth.

This repository is a small, single-package TypeScript Azure Function plus a set of ARM templates and PowerShell scripts. The function is triggered by Azure Event Hub messages, parses Azure Monitor logs (AAD, Activity, and Resource logs), and forwards them to Splunk via HEC (HTTP Event Collector). It is packaged and deployed into customer Azure tenants as part of Splunk Cloud Data Manager (SCDM). There is no frontend, no database, and no other services — just the Function, its deployment templates, and its tests.

## Start Here

Read these first before making non-trivial changes:

- `README.md` — dev environment setup, local settings, build/test/deploy commands, how the project was scaffolded
- `azure_monitor_logs_processor_func/index.ts` — the entire function implementation; read this fully before editing it, it is not large
- `azure_monitor_logs_processor_func/function.json` — trigger and output binding configuration (EventHub in, two blob outputs for failed events)
- `host.json` — runtime timeout, batching, and logging configuration; `FUNC_TIMEOUT` in `index.ts` must stay in sync with `functionTimeout` here
- `.gitlab-ci.yml` — pipeline stages, build/package/deploy flow, FOSSA/OSS/SAST scan wiring
- `.claude/skills/azure-monitor-logs-fossa-fix/SKILL.md` — use this skill (not ad hoc edits) whenever FOSSA flags a dependency finding
- `.claude/skills/azure-monitor-logs-version-bump/SKILL.md` — use this skill (not ad hoc `npm version`/manual edits) whenever the release version needs bumping
- `deploy/*/tests/Test-Deployment.Tests.ps1` — Pester tests for each ARM template stack; read the matching one before editing a template

Important: this repo has **no frontend, no Python code, no workspaces, and only one `package.json`**. Do not copy generic multi-package or React/Redux instructions from other repos — they do not apply here.

### Repo Map

- `azure_monitor_logs_processor_func/` — the function's TypeScript source (`index.ts`) and Azure Functions binding config (`function.json`). Compiles to `dist/`.
- `tests/` — Mocha/Chai/Sinon unit tests for the function, plus `common.ts` with shared test fixtures (`context`, `mockEnv`, `createEvents`).
- `deploy/` — one subfolder per log type, each self-contained:
  - `deploy/aad/` — AAD (Azure Active Directory) logs ARM template + Pester tests
  - `deploy/activity/` — Activity logs ARM template, `Update-SubscriptionDiagnosticSettings.ps1`, + Pester tests
  - `deploy/resource/` — **dead code, currently unused.** Resource logs ARM template, `Deploy-ResourceLogsIngestionStack.ps1`, `Setup-ResourceDiagnosticsSettings.ps1`, + Pester tests. Not wired into any active SCDM input flow at this time — do not build new features on top of it and do not assume it reflects current deployment practice. Confirm with the user before investing effort here; it may be resurrected or removed later.
- `Test-ARMTemplates.ps1` — shared Pester/ARM-TTK test runner used by all three `deploy/*` stacks and by CI's `arm-validate` job.
- `.service-manifests/` — Backstage component manifest (ownership, links, tags). Update when ownership, Slack channel, or Jira project changes.
- `.gitlab/CODEOWNERS` — okta-group ownership gate for compliance.
- `.claude/skills/azure-monitor-logs-fossa-fix/` — dedicated skill for FOSSA dependency-finding triage; see below.
- `.claude/skills/azure-monitor-logs-version-bump/` — dedicated skill for bumping the release version (`package.json` + `package-lock.json` in lockstep); defaults to a minor bump.
- `host.json`, `tsconfig.json`, `package.json` — runtime, compiler, and dependency/script configuration.

## Function Runtime Conventions

- The function entrypoint (`azureMonitorLogsProcessorFunc` in `index.ts`) must remain resilient: never let an unhandled error escape without either backing events up to blob storage (`handleGlobalError`) or logging and continuing (`handlePushErrors`). Events must never be silently dropped.
- Timeout math in `index.ts` (`FUNC_TIMEOUT`, `INIT_TIME`, `WRITE_TIME`, `BUFFER`, `MAX_RETRIES`) is a comment-documented mirror of `host.json`'s `functionTimeout`. If you change one, update the other and the matching test in `tests/azureFunction.test.ts` ("should calculate appropriate httpClient timeout").
- All configuration is read from `process.env` at call time (e.g. `getHecParams`, `enabledEventhubMetadata`, `getResourceTypeToIndexMapping`). Follow this pattern for new configuration — do not introduce a config file or module-level caching of env vars, since tests stub `process.env` directly per-test via `sandbox.stub(process, 'env').value(mockEnv)`.
- Never log secrets. `HecToken` must never appear in a log line; only `hecUrl` and non-secret params are logged in `createHecHttpClient`.
- Keep the retry policy centralized in `isRetryableError` / `getRetryDelay` — don't scatter ad hoc retry logic elsewhere.
- Batching (`batchSerializedEvents`) enforces `SPLUNK_BATCH_MAX_SIZE_BYTES` (default `DEFAULT_SPLUNK_BATCH_MAX_SIZE_BYTES` = 1,000,000 bytes). Preserve the "single oversized event still gets its own batch" behavior — do not add a hard cap that would drop events.
- `AZURE_LOG_LIMIT` (32000 chars) truncates error/response bodies before logging. Apply the same limit to any new log line that could include event/response payload content, to avoid Azure Monitor log truncation issues.
- Resource-log index routing (`ResourceTypeDestinationIndex` env var, parsed by `getResourceTypeToIndexMapping`) is a `;`-delimited, `=`-separated, case-insensitive-on-key map. Follow the same parsing conventions (`trim()`, `toLowerCase()` on keys) if extending it.

## TypeScript Conventions

- Target is `es6` / `commonjs`, `strict: true` (see `tsconfig.json`). Do not relax strict mode.
- `tests/` is excluded from the `tsc` build (`exclude` in `tsconfig.json`) and compiled on the fly via `ts-node/register` when running Mocha. Do not add test files under `azure_monitor_logs_processor_func/`.
- Keep exported types (`HecParams`, `SplunkEvent`, `SplunkContextBindings`, `SplunkContext`, `SplunkAzureFunction`) at the bottom of `index.ts` as the single source of truth for this function's shape; there is no separate `types.ts`.
- Every source file carries the Apache 2.0 license header (see the top of `index.ts`). Preserve it in any new `.ts` file under `azure_monitor_logs_processor_func/`.

## Testing Conventions

- Framework: Mocha + Chai + Sinon + `ts-node/register`, run via `npm test`. Test files live in `tests/*.test.ts` and are grouped by concern: `azureFunction.test.ts` (core push/timeout logic), `azureFunctionBatching.test.ts`, `azureFunctionFailure.test.ts`, `azureFunctionHecRetry.test.ts`, `azureFunctionTimestamp.test.ts`.
- Reuse `tests/common.ts` (`context`, `mockEnv`, `sandbox`, `createEvents`) instead of building new mocks. Stub `process.env` via `sandbox.stub(process, 'env').value(mockEnv)` in `beforeEach`, and always `sandbox.restore()` in `afterEach`.
- Stub `axios.create()` and the returned client's `post` method rather than hitting real HTTP — see the pattern at the top of `azureFunction.test.ts`.
- When changing timeout, batching, or retry math, update the corresponding hand-computed expected value in the test (tests intentionally re-derive the formula rather than importing the constants, so a formula change requires a matching test edit).
- ARM templates use a **separate** test framework: PowerShell Pester, driven by `Test-ARMTemplates.ps1` and per-stack `deploy/<stack>/tests/Test-Deployment.Tests.ps1`. These require an authenticated Azure context (`Connect-AzAccount`) and are not run by `npm test`.
- Every function change needs a matching unit test. Every ARM template change needs a matching or updated Pester test in the same `deploy/<stack>/tests/` folder.

## ARM Templates & Deployment Scripts

- One log type = one self-contained folder under `deploy/`: `aad/`, `activity/`, `resource/`. Each has its own ARM template (`splunk-<type>-logs-deploy-resources.json`) and its own `tests/Test-Deployment.Tests.ps1`. Do not cross-wire templates between folders.
- **`deploy/resource/` is dead code — not currently used in production.** `Deploy-ResourceLogsIngestionStack.ps1` and `Setup-ResourceDiagnosticsSettings.ps1` are not wired into any active SCDM input flow right now. Do not treat their parameter contracts as a live interface, and do not assume changes there have any customer impact today. Ask the user before spending effort on this stack — verify it's still meant to be dead before making non-trivial changes.
- `Update-SubscriptionDiagnosticSettings.ps1` (activity logs) is the operational entrypoint used outside CI (e.g. by SCDM's backend) to provision/tear down customer-side Azure resources per SCDM input. Treat its parameter contract (names, types, mandatory-ness) as a stable interface — a breaking change here breaks the SCDM edit/create/delete workflow for that input.
- All PowerShell scripts carry a `<#PSScriptInfo#>` block (version, GUID, author, license, project URI) and a `.SYNOPSIS`/`.PARAMETER`/`.EXAMPLE` comment-based help block. Preserve this structure and keep `.EXAMPLE` accurate when changing parameters.
- Resource groups and diagnostic settings are named deterministically from the SCDM input ID (e.g. `SplunkDMDataIngest-$SCDMInputId-$region`, `splunk-activity-logs-$SCDMInputId`). Never change this naming convention without accounting for existing customer deployments — it is how the scripts find and update/delete prior resources idempotently.
- `Test-ARMTemplates.ps1` downloads and uses `arm-ttk` (Azure Resource Manager Template Toolkit) for validation, with `apiVersions-Should-Be-Recent` and `apiVersions-Should-Be-Recent-In-Reference-Functions` explicitly skipped (documented reason: patch releases can't always bump 2-year-old API versions). Keep this skip list in mind — it is intentional, not a gap to "fix" opportunistically.
- Diagnostic settings API versions were recently bumped (`2021-05-01-preview`, see git history) — when touching diagnostic settings resources in ARM templates, check the current API version is still valid rather than assuming the existing value.

## FOSSA / Dependency Findings

- This repo has a **dedicated skill** for this: `.claude/skills/azure-monitor-logs-fossa-fix/SKILL.md`. Invoke it whenever triaging FOSSA findings instead of hand-rolling the analysis — it already encodes the full dependency-chain-tracing, fixability decision tree, and manifest-only fix workflow specific to this repo.
- Key facts (duplicated from the skill for quick reference): single-package repo, `npm` not `yarn`, fixes go in `package.json` `dependencies`/`devDependencies`/`overrides` only — never touch `node_modules` or source code to resolve a finding.
- Production deps: `axios`, `axios-retry`, `moment`, `node-gzip`. Everything else is dev/test-only.
- CI runs FOSSA/OSS scanning on MR and on a schedule (see `oss scan` job and `fossa` stage in `.gitlab-ci.yml`).

## CI/CD (`.gitlab-ci.yml`)

- Runs on `docker-hub.repo.splunkdev.net/node:22`. Node version must stay aligned with `.nvmrc` and the README's Node 22 requirement.
- Pipeline stages, in order: `test` → `oss-scan` → `deploy-test` → `deploy-dev` → `deploy-prd` → `fossa`.
- `test` job: `npm install && npm run build && npm test`. `arm-validate` job (also `test` stage) runs Pester/ARM-TTK validation against `deploy/` using PowerShell in a separate image.
- `deploy-dev` runs automatically on `develop` and `main` (not on scheduled pipelines). `deploy-test` and `deploy-prd` are `when: manual`.
- Packaging (`.build-and-package`) builds, prunes dev deps, zips the function (`npm run package`), and uploads to Azure blob storage (`deploy-test`/`deploy-dev`) or Artifactory (`deploy-prd`).
- The zip filename and blob path embed `$npm_package_version` — bump `version` in `package.json` for every release-bound change; CI derives the artifact name from it via `npm run get-version`. Use `.claude/skills/azure-monitor-logs-version-bump/SKILL.md` to do this so `package-lock.json` stays in sync.
- MR pipelines and branch-push pipelines are mutually exclusive (`workflow.rules` skips the branch pipeline when an MR is open) — don't "fix" this by force-triggering both.

## Working Agreements

- Every code change to `azure_monitor_logs_processor_func/` needs a matching unit test in `tests/`. Every ARM template change needs a matching Pester test in that stack's `tests/` folder.
- Keep `index.ts` as a single cohesive module unless a change clearly outgrows it — this is a small, intentionally flat codebase; don't introduce premature module splitting, DI frameworks, or config abstractions.
- Treat the deployment script parameter contracts and Azure resource naming conventions as customer-facing API surface, not internal implementation detail — breaking changes there affect already-deployed customer infrastructure.
- When you bump `package.json` `version`, confirm it matches the intended release (dev builds vs. an actual versioned release) — the version string flows straight into the CI artifact name and Artifactory path.
- Preserve the Apache 2.0 license header on new source and PowerShell files.

## Common Commands

See [`README.md`](README.md) for full setup and detail.

- `npm install` — install dependencies (required first time and after any `package.json` change)
- `npm run build` — compile TypeScript (`tsc`) to `dist/`
- `npm run watch` — `tsc -w`
- `npm start` — build + `func extensions install` + run the function locally alongside the watcher (`npm-run-all --parallel start:host watch`)
- `npm test` — run all Mocha unit tests (`tests/**/*.test.ts`)
- `npm run package` — zip the built function for deployment (used by CI; requires a prior `build` + `prune --production`)
- `npm run get-version` — print `package.json` version (used by CI to name artifacts)
- ARM template tests (PowerShell, requires `Connect-AzAccount` and the `Pester`/`Az` modules):
  ```powershell
  Import-Module ./Test-ARMTemplates.ps1
  Test-ARMTemplates -TemplateFolder ./deploy -UnitTest
  ```

## Change-Specific Guidance

### Function logic (`azure_monitor_logs_processor_func/index.ts`)

- Read the whole file first — it's ~430 lines and every helper function is small and single-purpose. Understand `buildHecPayloads` → `toSplunkEvents` → `toSplunkEvent` → `pushToHec` as the main data path before changing any one link.
- Add/extend unit tests in the matching `tests/azureFunction*.test.ts` file rather than creating a new test file, unless the change introduces a genuinely new concern (as batching, failure-handling, retry, and timestamp logic each already got their own file).
- Any new environment variable must be documented in `README.md`'s "Required arguments" section and reflected in `tests/common.ts`'s `mockEnv`.

### ARM templates / deployment scripts (`deploy/`)

- Identify which of the three stacks (`aad`, `activity`, `resource`) the change belongs to before editing — they are independent and should not be merged or cross-referenced.
- `resource` is dead code (see Repo Map above) — flag this to the user if a task seems to target it, rather than silently implementing changes there.
- Run `Test-ARMTemplates.ps1` locally against the affected stack before pushing; CI's `arm-validate` job will otherwise be the first signal.
- If a script's parameters change, update its `.PARAMETER`/`.EXAMPLE` comment-based help in the same change.

### CI / packaging (`.gitlab-ci.yml`)

- Changes to build/package/deploy stages affect real customer-facing artifact delivery (blob storage for dev/test, Artifactory for prod). Treat pipeline edits as high blast-radius; validate stage ordering and `rules`/`only`/`except` conditions carefully before merging.

### Dependency / FOSSA changes

- Always route through `.claude/skills/azure-monitor-logs-fossa-fix/SKILL.md` rather than ad hoc `npm install <pkg>@<version>` edits, so the fixability classification and dismissal-message drafting stay consistent.

## Default AI Loop

For Jira- or MR-driven work, prefer this order:

1. Pull context: Atlassian MCP for Jira issues/comments, `glab mr list`/`glab mr view`/`glab issue list` for GitLab context, and `git log` (commit messages here follow `DAT-<number>: <summary>` or `chore:`/`feat:`/`fix:` conventions) to infer current work.
2. Identify which area the change touches — function logic, a specific `deploy/<stack>`, or CI — and read the corresponding section above plus the actual files before proposing changes.
3. Plan and confirm with the user for anything that changes a deployment script's parameter contract, resource naming, timeout math, or CI stage ordering.
4. Implement with matching tests (Mocha for the function, Pester for ARM templates).
5. Run `npm run build && npm test` (and the relevant Pester suite for `deploy/` changes) before considering the change complete.

## Keep The Docs Fresh

When a change materially affects the function's runtime contract, deployment script parameters, ARM template structure, or CI/release process, update this `AGENTS.md` and `README.md` in the same change.
