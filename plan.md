# EPIX Marketplace — Implementation Plan

## 1. Purpose

Build an internally hosted, line-of-business-scoped marketplace for EPIX-specific AI plugins. The marketplace will support the Claude Code plugin format while keeping skills portable through the open Agent Skills `SKILL.md` format.

The catalog will contain only net-new EPIX knowledge and workflows—services, APIs, runbooks, and data contracts that are not already available in the central firm-wide marketplace.

## 2. Target outcomes

- Contributors author one manifest, `plugin.yaml`, per plugin.
- The toolchain generates Claude plugin manifests, the marketplace catalog, and the website search index.
- Local validation and CI run the same composite command: `python -m epix check`.
- Pull requests receive deterministic validation, security, overlap, generation-drift, and evaluation checks with zero LLM calls.
- A separate nightly LLM-as-judge suite detects semantic regressions but never blocks a pull request.
- Plugin versions are computed from Conventional Commits and affected plugin paths; contributors never type versions manually.
- A generated, static, searchable catalog is deployed to S3 and CloudFront without a Node/npm toolchain.
- Quality, ownership, lifecycle, dependency, and privacy-preserving usage signals are visible for every plugin.

## 3. Scope

### In scope

- EPIX-specific skills, agents, hooks, MCP/LSP declarations, scripts, references, and assets.
- A Python CLI for scaffolding, validation, security scanning, overlap detection, generation, evaluation, scoring, local preview, and CI checks.
- Claude Code-compatible plugin and marketplace output.
- Agent Skills-compatible `SKILL.md` content.
- Deterministic pull-request gates and non-blocking nightly semantic evaluations.
- Bronze, Silver, and Gold quality indicators.
- Lifecycle, ownership, dependency, overlap, and telemetry governance.
- A static discovery website and an AWS deployment pipeline.

### Out of scope

- Republishing plugins already offered by the central marketplace.
- Prompt, response, source-code, or other user-content collection.
- A live application server, runtime database, or website CMS.
- Node/npm, a JavaScript bundler, or a JavaScript lockfile.
- Manual version entry or hand-editing generated manifests.
- Using the quality tier itself as an approval gate.

## 4. Architecture

```text
Contributor-authored content
  plugin.yaml + skills/ + agents/ + evals/ + optional components
                              |
                              v
                     python -m epix check
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
     Validation          Security/evals      Overlap check
          |                   |              against pinned
          |                   |              central catalog
          +-------------------+-------------------+
                              |
                              v
                      Deterministic generation
                              |
          +-------------------+--------------------+
          |                   |                    |
          v                   v                    v
   plugin.json         marketplace.json        catalog.json
   per plugin           marketplace root        website index
                              |
                              v
                    Jinja2 static-site build
                              |
                              v
                      S3 + CloudFront
```

The build must be reproducible: identical authored files, central-catalog snapshot, and Git history must produce byte-identical generated files.

## 5. Proposed repository and code structure

```text
epix-marketplace/
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODEOWNERS
├── pyproject.toml
├── uv.lock                         # Python dependency lock only
├── Jenkinsfile                     # Thin entry point using approved shared libraries
├── plugin.schema.json              # Schema for authored plugin.yaml files
├── eval-case.schema.json           # Schema for deterministic eval cases
│
├── .claude-plugin/
│   └── marketplace.json            # GENERATED: Claude marketplace catalog
│
├── config/
│   ├── marketplace.yaml            # Authored marketplace-level metadata
│   ├── quality-policy.yaml          # Bronze/Silver/Gold scoring policy
│   ├── security-policy.yaml         # Forbidden calls and secret patterns
│   └── central-catalog.lock.json    # Pinned source revision and content digest
│
├── reference/
│   └── central-catalog.json         # Reviewed snapshot used by overlap checks
│
├── plugins/
│   ├── example-epix-plugin/
│   │   ├── plugin.yaml              # ONLY authored plugin manifest
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json          # GENERATED: Claude plugin manifest
│   │   ├── skills/
│   │   │   └── example-skill/
│   │   │       ├── SKILL.md         # Agent Skills-compatible instructions
│   │   │       ├── evals/
│   │   │       │   ├── cases.yaml   # Positive, negative, and output cases
│   │   │       │   └── fixtures/    # Sanitized deterministic fixtures
│   │   │       ├── scripts/         # Optional self-contained helpers
│   │   │       ├── references/      # Optional progressive-disclosure docs
│   │   │       └── assets/          # Optional templates/static resources
│   │   ├── agents/                  # Optional Claude agent definitions
│   │   ├── hooks/                   # Optional hooks and hooks.json
│   │   ├── bin/                     # Optional packaged executables
│   │   ├── .mcp.json                # Optional MCP definitions
│   │   └── .lsp.json                # Optional LSP definitions
│   └── ...
│
├── src/
│   └── epix/
│       ├── __init__.py
│       ├── __main__.py              # Enables python -m epix
│       ├── cli.py                   # Command registration and exit codes
│       │
│       ├── commands/
│       │   ├── new.py
│       │   ├── validate.py
│       │   ├── security.py
│       │   ├── overlap.py
│       │   ├── eval.py
│       │   ├── version.py
│       │   ├── generate.py
│       │   ├── score.py
│       │   ├── site.py
│       │   ├── stats.py
│       │   └── check.py
│       │
│       ├── domain/
│       │   ├── models.py            # Typed internal models
│       │   ├── enums.py             # Lifecycle and quality enums
│       │   └── errors.py            # Stable user-facing diagnostics
│       │
│       ├── manifests/
│       │   ├── loader.py            # Safe YAML/frontmatter loading
│       │   ├── schema.py            # Schema and cross-field validation
│       │   └── normalize.py         # Canonical IDs, paths, and ordering
│       │
│       ├── generation/
│       │   ├── plugin_manifest.py   # plugin.yaml -> plugin.json
│       │   ├── marketplace.py       # all plugins -> marketplace.json
│       │   ├── catalog.py           # all plugins -> catalog.json
│       │   ├── provenance.py        # Generated header/digest metadata
│       │   └── drift.py             # Regenerate in memory + byte comparison
│       │
│       ├── validation/
│       │   ├── skills.py            # SKILL.md/frontmatter rules
│       │   ├── ownership.py
│       │   ├── lifecycle.py
│       │   ├── dependencies.py
│       │   └── paths.py
│       │
│       ├── security/
│       │   ├── python_ast.py        # eval/exec/pickle/input/shell/SQL checks
│       │   ├── secrets.py           # Key signatures and entropy checks
│       │   ├── filesystem.py        # Traversal and external-path checks
│       │   └── allowlist.py         # Expiring, owner-approved exceptions
│       │
│       ├── overlap/
│       │   ├── snapshot.py          # Central-catalog verification
│       │   ├── identifiers.py       # Exact normalized capability matching
│       │   └── similarity.py        # Warning-only fuzzy candidate matching
│       │
│       ├── evaluations/
│       │   ├── cases.py             # Parse evals/cases.yaml
│       │   ├── activation.py        # Deterministic routing assertions
│       │   ├── contracts.py         # JSON Schema/regex/file assertions
│       │   ├── sandbox.py           # Isolated fixture execution
│       │   ├── coverage.py
│       │   └── nightly.py           # LLM judge adapter, not used by PR checks
│       │
│       ├── versioning/
│       │   ├── commits.py           # Conventional Commit parsing
│       │   ├── history.py           # Plugin-path-scoped Git history
│       │   └── semver.py
│       │
│       ├── quality/
│       │   ├── scoring.py
│       │   ├── coverage.py
│       │   └── responsiveness.py
│       │
│       ├── telemetry/
│       │   ├── schema.py            # Count-only event contract
│       │   ├── aggregate.py         # Daily anonymous aggregation
│       │   └── export.py            # Static website usage snapshots
│       │
│       ├── website/
│       │   ├── builder.py
│       │   ├── search_index.py
│       │   └── dependency_graph.py
│       │
│       └── util/
│           ├── canonical_json.py
│           ├── hashing.py
│           └── clock.py
│
├── site/
│   ├── templates/
│   │   ├── base.html
│   │   ├── index.html
│   │   └── plugin.html
│   ├── static/
│   │   ├── css/blueprint.css
│   │   └── js/
│   │       ├── command-palette.js   # Small vanilla-JS Cmd/Ctrl+K UI
│   │       └── search.js            # Client search over catalog.json
│   └── dist/                        # GENERATED deployment artifact
│       ├── index.html
│       ├── plugins/
│       ├── assets/
│       └── catalog.json
│
├── data/
│   ├── usage-daily.json             # GENERATED aggregate counts only
│   └── owner-responsiveness.json    # GENERATED approved service metrics
│
├── tests/
│   ├── unit/                        # Mirrors src/epix modules
│   ├── integration/
│   │   ├── test_check_command.py
│   │   ├── test_generation_drift.py
│   │   └── test_site_snapshot.py
│   ├── compatibility/
│   │   ├── test_claude_plugin.py
│   │   └── test_agent_skills.py
│   ├── fixtures/
│   └── golden/                      # Expected generated output
│
├── deploy/
│   ├── buildspec.yml
│   ├── cloudformation/
│   │   ├── site.yaml                # S3, CloudFront, logs, security headers
│   │   └── pipeline.yaml            # Separate deployment pipeline
│   └── scripts/
│       └── smoke_test.py
│
└── docs/
    ├── architecture.md
    ├── authoring.md
    ├── evaluation.md
    ├── quality-tiers.md
    ├── telemetry-privacy.md
    └── decisions/                   # Lightweight architecture decisions
```

Claude Code component directories stay at each plugin root; only `plugin.json` belongs inside `.claude-plugin/`. All content needed at runtime must remain inside the plugin directory because installed plugins are copied into an isolated cache.

## 6. Authored manifest contract

`plugin.yaml` is the only authored source for plugin metadata. Content files such as `SKILL.md`, eval cases, scripts, references, and assets remain authored files; generated JSON files must never be edited.

Illustrative shape:

```yaml
schema_version: 1
name: epix-payments-runbook
display_name: EPIX Payments Runbook
description: Diagnose and remediate EPIX payment-processing incidents.

owner:
  team: epix-payments
  contacts:
    - type: support_group
      value: EPIX-PAYMENTS-SUPPORT
    - type: on_call
      value: EPIX-PAYMENTS-ONCALL

lifecycle:
  status: active
  sunset_date: 2027-09-30

epix:
  service_ids:
    - EPIX-PAYMENTS
  capability_ids:
    - payments-incident-triage
  uniqueness_statement: Covers EPIX-specific payment alerts and recovery steps.

components:
  skills:
    - path: skills/payment-triage
  agents:
    - path: agents/payment-investigator.md

dependencies:
  plugins:
    - epix-telemetry

telemetry:
  event_schema: epix.plugin.invocation.v1
  fields:
    - plugin_id
    - component_id
    - plugin_version
    - event_date
    - outcome

tags:
  - payments
  - incident-response
```

The following fields are forbidden in `plugin.yaml` because they are computed:

- `version`
- `quality_tier`
- `quality_score`
- `eval_status`
- `usage`
- Generated Claude component paths

### Cross-field rules

- `name` and component directory names must use canonical kebab-case.
- Every skill directory must contain `SKILL.md` and `evals/cases.yaml`.
- A `SKILL.md` must include valid Agent Skills frontmatter, including `name` and `description`; the skill name must match its parent directory.
- Every plugin must have a named team and at least one resolvable, non-personal support contact.
- Every plugin must declare `experimental`, `active`, `deprecated`, or `archived` plus a sunset date.
- Deprecated plugins must name a replacement or explicitly state that no replacement exists.
- Archived plugins remain visible in historical catalog output but cannot be newly installed.
- EPIX service and capability identifiers must not collide with the pinned central catalog.
- The telemetry dependency and count-only schema are mandatory.
- Telemetry configuration must reject prompt, response, source-code, filename, free-text, or user-identity fields.

## 7. Generated artifacts and drift protection

### Per-plugin output

`plugins/<plugin>/.claude-plugin/plugin.json` contains:

- Claude-compatible identity and metadata.
- Computed semantic version.
- Component paths derived from `plugin.yaml`.
- The standard telemetry dependency.

To avoid introducing non-standard fields, `plugin.json` contains only fields accepted by the Claude manifest schema. Source digests and generator-version provenance live in `catalog.json`, not in the Claude manifest.

### Marketplace output

`.claude-plugin/marketplace.json` is generated by sorting all eligible plugins by canonical name. It includes install sources, lifecycle state, and computed versions. Archived plugins are omitted from new-install entries but retained in the website history.

### Website output

`site/dist/catalog.json` is the prebuilt search and display index. It contains public internal metadata only: identifiers, summaries, owner support routes, tier, lifecycle, install command, token estimates, evaluation summaries, dependency edges, aggregated usage counts, source digests, and the generator version.

### Drift algorithm

1. Load authored sources.
2. Generate every managed artifact in memory using canonical key ordering and formatting.
3. Compare the expected bytes with checked-in generated files.
4. Fail with the exact files that differ and the remediation command.
5. Reject changes that modify a generated file without a corresponding authored-source or generator change.

`python -m epix generate` writes generated artifacts. `python -m epix generate --check` performs comparison only.

## 8. CLI contract

| Command | Responsibility |
|---|---|
| `python -m epix new plugin <name>` | Scaffold a plugin, owner/lifecycle fields, first skill, and eval examples. |
| `python -m epix new skill <plugin> <name>` | Add a valid `SKILL.md` and `evals/cases.yaml`. |
| `python -m epix validate [path]` | Validate schemas, frontmatter, ownership, lifecycle, dependencies, paths, and compatibility. |
| `python -m epix security [path]` | Run AST, secret, path, and unsafe-configuration checks. |
| `python -m epix overlap [path]` | Compare normalized IDs with the pinned central catalog; exact conflicts block and fuzzy matches warn. |
| `python -m epix eval [path]` | Run deterministic activation and output-contract tests with zero LLM calls. |
| `python -m epix eval --nightly` | Run the non-blocking LLM-as-judge regression suite. |
| `python -m epix version [plugin]` | Print the computed version and the commits responsible for the bump. |
| `python -m epix generate [path]` | Write canonical generated JSON and website metadata. |
| `python -m epix score [plugin]` | Compute the quality score/tier and explain every point. |
| `python -m epix site build` | Render the complete static website with Jinja2. |
| `python -m epix site serve` | Preview `site/dist` locally with a Python static-file server. |
| `python -m epix stats aggregate` | Convert approved invocation counters into anonymous daily totals. |
| `python -m epix check` | Run the exact ordered pull-request gate used by CI. |

All commands must support:

- Stable, documented exit codes.
- Human-readable diagnostics by default.
- `--format json` for CI annotations.
- Repository-root discovery from nested directories.
- Plugin-level selection for fast local feedback.
- Deterministic output with a fixed clock injected in tests.

### Composite check order

`python -m epix check` runs:

1. `validate`
2. `security`
3. `overlap`
4. `eval` in deterministic mode
5. `version`
6. `generate --check`
7. `score --check`
8. Compatibility and unit tests

It must not invoke an LLM, access production telemetry, or mutate the repository.

## 9. Versioning

Use independent versions per plugin and tags such as `epix/<plugin-name>/v1.4.2`.

For commits after the plugin's latest tag that touch its directory:

- `feat!:` or a breaking-change footer → major.
- `feat:` → minor.
- `fix:` → patch.
- Documentation, tests, refactors, and chores → no release unless explicitly marked as breaking.
- The highest applicable bump wins.

New plugins begin at `0.1.0` after their first accepted `feat:` change. The `version` command must show the base tag, relevant commits, selected bump, and result.

Repository policy must preserve the bump intent when merging. If squash merging is used, the pull-request title must be a valid Conventional Commit at least as significant as every included plugin change. Mixed-bump changes across plugins should be split into separate pull requests.

## 10. Evaluation model

Each skill owns `evals/cases.yaml` with three required suites:

```yaml
schema_version: 1

activation:
  positive:
    - id: payment-timeout
      prompt: Diagnose repeated EPIX payment timeout alerts.
      expected_skill: payment-triage
  negative:
    - id: unrelated-password-reset
      prompt: Reset my workstation password.
      must_not_activate: payment-triage

output_contracts:
  - id: incident-summary
    fixture: fixtures/payment-timeout.json
    runner: scripts/build_summary.py
    assertions:
      exit_code: 0
      json_schema: fixtures/incident-summary.schema.json
      forbidden_patterns:
        - "(?i)password|secret|token"
```

### Pull-request evaluation

- Validate that positive and negative activation cases exist.
- Use a versioned deterministic routing policy to check declared intent terms and exclusions.
- Execute scripts only against sanitized fixtures in an isolated temporary directory with time, memory, network, and filesystem limits.
- Check exit codes, JSON Schema, regular expressions, file lists, and normalized golden output.
- Report activation, negative-case, and output-contract coverage separately.

This deterministic suite protects structure, routing rules, and machine-checkable contracts; it does not claim to perfectly predict an LLM's behavior.

### Nightly semantic evaluation

- Run representative prompts through approved model configurations.
- Grade activation correctness, instruction adherence, safety, and output-contract quality.
- Compare results with the previous accepted baseline.
- Publish trends and open an issue/alert on material regression.
- Never block or retroactively fail a pull request.
- Store sanitized test inputs, model/version metadata, scores, and judge rationale; do not use production prompts.

## 11. Security controls

The blocking scanner will:

- Parse Python with the AST and reject `eval`, `exec`, `input`, `pickle`, unsafe deserialization, `shell=True`, and suspicious dynamic imports.
- Detect interpolated or concatenated SQL passed to known execution methods, including f-string SQL.
- Scan supported files for hard-coded credentials, private keys, tokens, and high-entropy secrets.
- Reject plugin paths that traverse outside the plugin root.
- Validate MCP/LSP/hook commands and require explicit executable paths and argument arrays.
- Deny unexpected network endpoints unless declared and approved.
- Require dependency declarations and an approved Python source.
- Produce file, line, rule, severity, and remediation in every finding.

Exceptions must be narrow, owned, justified, and time-limited in `security-policy.yaml`; broad inline suppression is not allowed.

## 12. Central-marketplace overlap control

The pull-request check must be deterministic and available offline:

1. A scheduled job retrieves the central marketplace and normalizes it into `reference/central-catalog.json`.
2. The source revision, retrieval timestamp, and SHA-256 digest are recorded in `config/central-catalog.lock.json`.
3. Changes to the snapshot receive the same review as code.
4. `epix overlap` blocks exact collisions in plugin names, skill names, aliases, service IDs, API IDs, data-contract IDs, and declared capability IDs.
5. Description similarity is warning-only and requires a reviewer decision because fuzzy matching can produce false positives.
6. An approved exception must reference a central catalog item and explain why the EPIX capability is materially different.

## 13. Quality system

Quality tiers are descriptive, computed, and visible; they do not replace blocking safety and correctness gates.

Suggested 100-point model:

| Dimension | Points | Evidence |
|---|---:|---|
| Structural and compatibility validation | 25 | Schema, paths, Claude, and Agent Skills checks |
| Deterministic evaluation coverage | 30 | Positive, negative, and output-contract coverage |
| Security posture | 15 | Clean scan and no overdue exceptions |
| Ownership and support | 15 | Resolvable contacts and measured response performance |
| Lifecycle hygiene | 10 | Current sunset date and deprecation/replacement data |
| Documentation quality | 5 | Install, usage, limitations, and examples |

Initial thresholds:

- Bronze: 60–74
- Silver: 75–89
- Gold: 90–100

Thresholds and weights live in `config/quality-policy.yaml`, are versioned, and are tested against golden examples. Tier changes are recomputed, never typed into a manifest.

Owner responsiveness should come from an approved, aggregated service metric—not individual email or chat content. Missing data scores neutrally during the pilot and becomes enforceable only after the metric is reliable.

## 14. Lifecycle policy

| Status | Meaning | Catalog/install behavior |
|---|---|---|
| `experimental` | Early validation with limited support expectations | Visible and installable with warning |
| `active` | Supported for normal use | Visible and installable |
| `deprecated` | Supported temporarily while users migrate | Visible, installable with warning and replacement |
| `archived` | Unsupported after sunset | Historical page only; omitted from new installs |

Automation should warn owners 90, 30, and 7 days before sunset. If the owner neither renews nor deprecates the plugin, the lifecycle job proposes archival. No automatic archival should occur without the configured review path.

## 15. Telemetry and privacy

Every plugin depends on the standard EPIX telemetry component. It records invocation counts only.

Allowed event data:

- Plugin identifier.
- Component/skill identifier.
- Computed plugin version.
- Coarse event date or approved time bucket.
- Coarse outcome category such as success, failure, or cancelled.

Prohibited event data:

- Prompts or responses.
- Source code, file contents, filenames, command arguments, or tool payloads.
- User identity, workstation identity, free text, or secrets.

Aggregation must happen before website publication. Low-volume buckets should be suppressed according to the firm's privacy threshold. The website consumes only daily aggregate counts and derived trends.

## 16. Static discovery website

### Experience

- Dark blueprint aesthetic with monospace identifiers.
- No marketing hero section; land directly on catalog discovery.
- Cmd/Ctrl+K command palette and fuzzy search over the prebuilt `catalog.json`.
- Plugin cards showing quality tier, lifecycle, owner, dependency summary, and usage sparkline.
- Per-plugin pages showing:
  - Install command.
  - Description and EPIX capability identifiers.
  - Skills and estimated token cost.
  - Deterministic and nightly evaluation status.
  - Dependency graph.
  - Owner support routes.
  - Lifecycle/sunset information.
  - Aggregate usage trend.

### Implementation

- Jinja2 templates render all pages in the same Python process used for catalog validation.
- Small, committed vanilla JavaScript files provide search and the command palette.
- Search data is generated at build time; no runtime API or database is required.
- The dependency graph is generated as accessible HTML/SVG without a front-end framework.
- The build produces hashed static assets, security headers, a manifest, and a smoke-testable `site/dist`.

## 17. CI/CD design

### Pull-request pipeline

Jules and Jenkins shared libraries should call one repository-owned command:

```text
python -m epix check
```

Pipeline stages:

1. Create the approved Python environment from the lock.
2. Run the composite check.
3. Publish JSON diagnostics and test reports.
4. Build the static site only as a preview artifact after the eight-plugin gate is met.
5. Never run production deployment from a pull request.

### Main-branch pipeline

1. Repeat `python -m epix check`.
2. Compute/tag changed plugin versions.
3. Generate and verify release artifacts.
4. Publish the immutable marketplace bundle.
5. Trigger the separate AWS site pipeline.

### AWS deployment pipeline

1. Build the site from a pinned commit.
2. Run link, HTML, accessibility, and content-leak checks.
3. Deploy to a non-production S3 bucket.
4. Invalidate the non-production CloudFront distribution.
5. Run smoke tests against the deployed origin.
6. Pause at a manual production approval gate.
7. Promote the identical artifact to production.
8. Invalidate production CloudFront and run final smoke tests.
9. Roll back by repointing to the previous immutable artifact.

## 18. Delivery phases

### Phase 0 — Foundations and decisions

Deliver:

- Confirm repository ownership, support model, central-catalog source, CI environment, AWS account, and production approvers.
- Record decisions for manifest governance, version tags, merge strategy, security exceptions, telemetry privacy, and site hosting.
- Approve success metrics and the definition of “genuinely EPIX-specific.”

Exit criteria:

- Named platform owner and security/privacy reviewers.
- Read access to the central catalog.
- Agreed plugin-owner responsibilities.
- Approved architecture and threat model.

### Phase 1 — Core toolchain

Deliver:

- Python package and CLI shell.
- `plugin.yaml` and eval schemas.
- `new`, `validate`, `security`, `version`, `generate`, and `check`.
- Canonical JSON generation and drift protection.
- Claude and Agent Skills compatibility tests.

Exit criteria:

- A sample plugin can be scaffolded, validated, generated, and locally installed.
- `python -m epix check` produces the same result locally and in CI.
- Generated-file edits are reliably rejected.

### Phase 2 — CI, overlap, and evaluation

Deliver:

- Jules/Jenkins integration.
- Pinned central-catalog refresh and blocking overlap check.
- Deterministic positive, negative, and output-contract harness.
- Nightly LLM-as-judge regression workflow.
- Security reporting and expiring exception workflow.

Exit criteria:

- Deliberate duplicate, unsafe-code, bad-eval, and drift examples all fail CI.
- Nightly results are published separately and cannot block a pull request.
- No pull-request check makes an LLM call.

### Phase 3 — First EPIX plugins and adoption gate

Deliver:

- Contributor documentation and templates.
- Onboard initial plugin owners.
- Create and validate the first production candidates.
- Capture installation feedback and remove authoring friction.

Hard go/no-go gate before website implementation:

- At least eight genuinely EPIX-specific plugins.
- Each plugin has a named owner and real support route.
- Each plugin passes validation, security, overlap, deterministic eval, and drift checks.
- Infrastructure-only helpers do not count toward the eight.
- The governance group signs off that the catalog has enough value to justify discovery-site work.

If the gate fails, continue improving the toolchain and plugin pipeline; do not build the website.

### Phase 4 — Static website

Deliver:

- Jinja2 templates and blueprint visual system.
- Search index, Cmd/Ctrl+K palette, plugin cards, sparklines, and plugin details.
- Dependency graph, token-cost display, accessibility checks, and preview artifacts.
- Non-production S3/CloudFront deployment.

Exit criteria:

- All eight or more plugins are searchable and have complete pages.
- Search works without a server.
- Website content exactly matches generated catalog data.
- Accessibility, security-header, link, and smoke checks pass.

### Phase 5 — Quality, telemetry, and production

Deliver:

- Versioned quality policy and explainable scoring.
- Count-only telemetry aggregation and privacy controls.
- Owner-responsiveness ingestion.
- Production AWS pipeline with manual gate and rollback.

Exit criteria:

- Every tier can be reproduced from stored evidence.
- Website telemetry contains no prohibited fields.
- Production promotion and rollback are demonstrated.
- Owners can see adoption without seeing user content.

### Phase 6 — Scale and lifecycle automation

Deliver:

- Sunset reminders and reviewed archival workflow.
- Catalog health dashboard.
- Contributor throughput and support-SLO reporting.
- Periodic dependency, security-policy, and central-overlap refresh.

Exit criteria:

- Stale plugins are renewed, deprecated, or archived on schedule.
- Median plugin onboarding time and CI failure causes are measured.
- Platform funding/adoption reporting uses aggregate invocation counts.

## 19. Definition of done

The marketplace is ready for production when:

- Eight or more qualifying EPIX plugins with named owners are available.
- All generated outputs are reproducible and drift-protected.
- The central-marketplace overlap gate is operational.
- The deterministic eval suite makes zero LLM calls and blocks invalid changes.
- The nightly LLM suite is isolated and non-blocking.
- Security controls reject the specified unsafe Python patterns and secrets.
- Versions are computed per plugin from path-scoped Conventional Commits.
- The static site includes search, quality, ownership, lifecycle, token, eval, usage, and dependency information.
- Telemetry has passed privacy/security review and records counts only.
- Jenkins/Jules and the separate AWS pipeline have passed end-to-end rehearsal.
- Production deployment requires manual approval and has a tested rollback.

## 20. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Deterministic routing tests do not perfectly represent model activation | Treat them as contract checks and use the nightly semantic suite for model behavior. |
| The central catalog becomes stale or unavailable | Use a reviewed, digest-pinned snapshot and a monitored refresh job. |
| Fuzzy duplicate detection creates false positives | Block exact normalized capability collisions; keep fuzzy similarity reviewer-facing. |
| Generated files create noisy changes | Canonical formatting, stable ordering, focused per-plugin generation, and clear provenance. |
| Version differs after squash merge | Enforce Conventional Commit PR titles and a merge policy preserving the highest bump. |
| Telemetry expands into content collection | Enforce an allowlisted schema, reject free-text fields, aggregate early, and audit payloads. |
| Quality tiers become political approval gates | Keep the formula transparent, evidence-based, and explicitly descriptive. |
| The website is built before the catalog has value | Enforce the eight-plugin, named-owner go/no-go gate in the delivery process. |
| Installed plugins reference shared files outside their package | Validate self-containment and package shared behavior as an explicit dependency. |

## 21. Initial implementation backlog

1. Approve the `plugin.yaml` data contract and sample.
2. Create `pyproject.toml`, `src/epix`, test layout, and CLI entry point.
3. Implement safe YAML/frontmatter loading and typed domain models.
4. Implement validation, deterministic diagnostics, and schemas.
5. Implement canonical generation for `plugin.json`, `marketplace.json`, and `catalog.json`.
6. Add source digests and generation-drift checking.
7. Implement path-scoped Conventional Commit versioning and release tags.
8. Implement the Python AST/security and secret scanners.
9. Create the central-catalog snapshot/lock flow and exact overlap rules.
10. Implement eval case parsing, isolated fixture execution, and coverage.
11. Wire the exact composite check into Jules/Jenkins.
12. Scaffold and onboard the first eight EPIX-specific plugins.
13. Conduct the hard go/no-go review.
14. Build the Jinja2 site and vanilla-JS search only after approval.
15. Add quality scoring, count-only telemetry, AWS promotion, and lifecycle automation.

## 22. Standards assumptions

This plan uses the current official conventions:

- Claude marketplace metadata at `.claude-plugin/marketplace.json`.
- Per-plugin metadata at `.claude-plugin/plugin.json`.
- Plugin component directories such as `skills/` and `agents/` at the plugin root.
- Agent Skills packaged as `<skill-name>/SKILL.md`, with optional `scripts/`, `references/`, and `assets/`.
- `SKILL.md` YAML frontmatter containing at least `name` and `description`.

References:

- [Claude Code: Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)

Revalidate these external formats during Phase 0 and pin compatibility fixtures so future upstream changes are detected deliberately.
