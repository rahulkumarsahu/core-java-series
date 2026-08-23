# LogSift Log Diff Stage — Production Walkthrough

**Date:** 2026-08-23  
**Scope:** Successful offline baseline → failed-run template extraction → template-to-template comparison → candidate evidence  
**Applies to:** JULES sequential pipelines and LATTICE DAG/parallel pipelines

---

# 1. Executive Answer

At the **Log Diff** stage, LogSift should not compare the failed raw log against a successful raw log.

The runtime flow is:

```text
Successful offline process
        |
        | creates
        v
baseline.json
templates.json
drain3_state.json
templates.md
normalize_sample.txt
        |
        |                    Failed run
        |                       |
        |                       v
        |              same normalize/redact/mask
        |                       |
        |                       v
        |              failed templates/events
        |                       |
        v                       v
baseline.json --------> select compatible baseline
templates.json --------> success template lookup
                                |
                                v
                   template-to-template comparison
                                |
                                v
                      novelty/support/frequency
                                |
                                v
                         candidate evidence
```

The most important answer is:

| Offline artifact | Used by Log Diff runtime? | Purpose |
|---|---:|---|
| `baseline.json` | **Yes** | Select the correct compatible success baseline and its version/scope |
| `templates.json` | **Yes** | Contains the actual reusable success templates and statistics used for comparison |
| `drain3_state.json` | **Not directly by Log Diff** | Drain parser internal learning state; may optionally be loaded **read-only** by the online parser/classifier |
| `templates.md` | No | Human-readable debugging/review only |
| `normalize_sample.txt` | No | Debugging preprocessing/masking only |

So the direct comparison path is:

```text
baseline.json
      |
      v
which baseline/templates should I use?
      |
      v
templates.json
      |
      v
compare against failed templates
```

`drain3_state.json` is **not** the success-vs-failure diff database.

It is the parser's internal memory.

A production-safe implementation must also ensure that **failed logs never update the successful Drain state**. Otherwise a failure-only pattern can become part of the learned definition of "normal."

---

# 2. What the Successful Offline Process Produces

Assume this baseline identity:

```text
seal_id        = seal101
project        = payments
repo           = payment-api
execution_type = LATTICE
primary_branch = main
baseline       = v17
```

A file-oriented representation could look like:

```text
seal101/
└── payments/
    └── payment-api/
        └── LATTICE/
            └── baseline-v17/
                ├── baseline.json
                ├── templates.json
                ├── drain3_state.json
                ├── templates.md
                └── normalize_sample.txt
```

In a large production service, the same information may be stored in Postgres/JSONB, Redis, or object storage instead of literal files. The logical responsibilities remain the same.

---

# 3. `baseline.json` — Baseline Resolver / Manifest

`baseline.json` answers:

> **Which successful knowledge is compatible with this failed run?**

Example:

```json
{
  "seal_id": "seal101",
  "project": "payments",
  "repo": "payment-api",
  "baseline_source_branch": "main",
  "execution_type": "LATTICE",
  "baseline_version": "v17",

  "success_runs": [
    "build-901",
    "build-908",
    "build-913"
  ],

  "pipeline_fingerprint": "sha256:a81f...",
  "normalizer_version": "v2",
  "masking_version": "v3",
  "drain_config_version": "v1",

  "nodes": {
    "build:compile": [
      "T001",
      "T002",
      "T003"
    ],
    "test:unit": [
      "T101",
      "T102",
      "T103"
    ],
    "test:integration-test": [
      "T201",
      "T202",
      "T203",
      "T204",
      "T205"
    ]
  }
}
```

The Log Diff stage first uses this metadata to answer:

```text
Is this the same repo?
Is this the same execution type?
Is this the correct stage / DAG node?
Is this baseline compatible with the current pipeline definition?
Were success and failure processed with compatible versions?
Which baseline version is current?
Which success template IDs belong to this comparison scope?
```

It should **not** simply pick the newest baseline globally.

It should pick the newest **compatible** baseline for the failed run.

---

# 4. `templates.json` — Actual Success Comparison Data

`templates.json` contains machine-readable reusable success patterns.

Example subset for the LATTICE node:

```text
test:integration-test
```

```json
[
  {
    "template_id": "T201",
    "template_key": "tpl_7c8a...",
    "pattern": "Starting PostgreSQL",
    "execution_type": "LATTICE",
    "node_name": "test:integration-test",
    "support_count": 3,
    "success_run_count": 3,
    "counts_per_run": [1, 1, 1],
    "median_count": 1
  },
  {
    "template_id": "T202",
    "template_key": "tpl_b11f...",
    "pattern": "Connecting to <HOST>:<PORT>",
    "execution_type": "LATTICE",
    "node_name": "test:integration-test",
    "support_count": 3,
    "success_run_count": 3,
    "counts_per_run": [1, 1, 1],
    "median_count": 1
  },
  {
    "template_id": "T203",
    "template_key": "tpl_2ef4...",
    "pattern": "Running <NUM> integration tests",
    "execution_type": "LATTICE",
    "node_name": "test:integration-test",
    "support_count": 3,
    "success_run_count": 3,
    "counts_per_run": [1, 1, 1],
    "median_count": 1
  },
  {
    "template_id": "T204",
    "template_key": "tpl_a922...",
    "pattern": "Tests run: <NUM>, Failures: 0",
    "execution_type": "LATTICE",
    "node_name": "test:integration-test",
    "support_count": 3,
    "success_run_count": 3,
    "counts_per_run": [1, 1, 1],
    "median_count": 1
  },
  {
    "template_id": "T205",
    "template_key": "tpl_c35a...",
    "pattern": "Stopping PostgreSQL",
    "execution_type": "LATTICE",
    "node_name": "test:integration-test",
    "support_count": 3,
    "success_run_count": 3,
    "counts_per_run": [1, 1, 1],
    "median_count": 1
  }
]
```

This is the core success knowledge used by Log Diff.

A useful production key is conceptually:

```text
template_key =
    hash(
        execution_type
        + stage_or_dag_node
        + canonical_template_pattern
        + preprocessing_version
        + drain_config_version
    )
```

Why create a stable key?

Because:

```text
T201
FT001
cluster_id=37
```

are implementation-local identifiers.

The failed run's `FT001` does **not** mean it should match success `T001`.

What matters is:

```text
same compatible scope
+
same canonical template structure
```

---

# 5. `drain3_state.json` — What It Is and What It Is Not

`drain3_state.json` contains Drain's internal clustering/parser state.

Conceptual example:

```json
{
  "clusters": [
    {
      "cluster_id": 37,
      "template": "Connecting to <*>:<*>",
      "size": 14812
    }
  ]
}
```

Its main purpose is:

```text
new successful log
      |
      v
load previous Drain state
      |
      v
continue learning existing clusters
      |
      v
persist updated success state
```

It is **not** normally queried by Log Diff like this:

```text
failed template
    VS
drain3_state.json
```

The diff engine should instead query the curated success template profile.

## Important production distinction

There are two separate concepts:

### A. Parser/classifier state

Drain may use `drain3_state.json` to understand known clusters.

### B. Log Diff data

Log Diff uses `baseline.json` + `templates.json` to decide whether an event is normal-looking, rare, novel, or frequency-abnormal.

If the online path loads `drain3_state.json`, it should be a **frozen/read-only snapshot**.

Never do this:

```text
failed log
   |
   v
load success drain state
   |
   v
update success clusters with failed events
   |
   v
save state
```

That can pollute the successful baseline.

Use:

```text
failed log
   |
   v
load frozen success parser state / compatible classifier
   |
   v
classify only
   |
   X
DO NOT persist failed-event learning into success state
```

An alternative is to use an ephemeral failed-run Drain instance with the same preprocessing/configuration, then compare its canonical patterns against `templates.json`.

---

# 6. Files That Are Not Used by Runtime Diff

## `templates.md`

Example:

```md
### Integration Test

Template:
Connecting to <HOST>:<PORT>

Seen:
3/3 successful runs
```

Purpose:

```text
engineer review
baseline inspection
debugging
change review
```

Do not use it for runtime comparison.

## `normalize_sample.txt`

Example:

```text
Before:
2026-08-23 10:18:12 connecting to payment-db-17.internal:5432

After:
connecting to <HOST>:<PORT>
```

Purpose:

```text
debug preprocessing
debug masking
answer "why did this become that template?"
```

Do not use it as a comparison database.

---

# 7. Realistic Production Scenario

Now assume a real failed Jenkins execution arrives.

## Run metadata

```text
seal_id        = seal101
project        = payments
repo           = payment-api
branch         = feature/settlement-v2
execution_type = LATTICE
build_id       = build-944
result         = FAILURE
```

The primary-branch baseline is:

```text
main
baseline-v17
successful runs = build-901, build-908, build-913
```

The LATTICE pipeline contains parallel DAG nodes:

```text
build:compile
test:unit
test:integration-test
scan:security
package:image
```

The failed node is:

```text
test:integration-test
```

The raw log is interleaved:

```text
80102 //test:unit: Running PaymentValidatorTest
80103 //scan:security: Scanning dependency jackson-databind
80104 //test:integration-test: Starting PostgreSQL
80105 //test:unit: Test passed
80106 //test:integration-test: Connecting to payment-db.internal:5432
80107 //scan:security: No critical findings
80108 //test:integration-test: Retrying connection to payment-db.internal
80109 //test:integration-test: Retrying connection to payment-db.internal
...
80200 //test:integration-test: Connection refused
80201 //test:integration-test: org.postgresql.util.PSQLException: connection refused
80202 //test:integration-test: PaymentServiceIT FAILED
80203 //test:integration-test: Tests run: 124, Failures: 1
80204 //test:integration-test: BUILD FAILURE
```

For LATTICE, LogSift must first preserve/separate the DAG node identity.

Do **not** compare the global interleaved line sequence with a successful global sequence.

Healthy parallel runs can have different line order simply because scheduling changes.

---

# 8. Step 1 — Resolve the Correct Success Baseline

Input identity:

```json
{
  "seal_id": "seal101",
  "project": "payments",
  "repo": "payment-api",
  "execution_type": "LATTICE",
  "failed_node": "test:integration-test"
}
```

LogSift looks up the current baseline manifest.

It loads:

```text
baseline-v17/baseline.json
```

Then validates:

```text
repo match?                    YES
execution type match?         YES
pipeline fingerprint?         YES
normalizer version?           YES
masking version?              YES
drain config version?         YES
node exists in baseline?      YES
recent support runs?          3
```

Result:

```json
{
  "baseline_status": "FOUND",
  "baseline_version": "v17",
  "comparison_scope": "test:integration-test",
  "diff_confidence": "HIGH"
}
```

If these versions/fingerprints are incompatible, do not silently compare.

A mismatched representation can make healthy messages look novel.

---

# 9. Step 2 — Load Only the Relevant Success Templates

From `baseline.json`:

```text
test:integration-test
    -> T201
    -> T202
    -> T203
    -> T204
    -> T205
```

The service fetches those records from `templates.json`.

It does **not** need all templates from every stage if the failed node is known.

Production optimization:

```text
bad:
load 100,000 templates for the whole repo

better:
load templates for
seal101/payments/payment-api/LATTICE/v17/test:integration-test
```

This also reduces false matches across unrelated stages.

---

# 10. Step 3 — Process the Failed Log With the Same Representation Rules

Every failed line goes through the same compatible preprocessing stack:

```text
raw failed line
      |
      v
normalize
      |
      v
redact
      |
      v
mask
      |
      v
template/classification
      |
      v
failed event/template
```

Example raw failed line:

```text
2026-08-23 10:22:31.881
//test:integration-test:
Connecting to payment-db.internal:5432
```

After metadata extraction:

```json
{
  "line_number": 80106,
  "execution_type": "LATTICE",
  "node": "test:integration-test",
  "message": "Connecting to payment-db.internal:5432"
}
```

After normalization/masking:

```text
Connecting to <HOST>:<PORT>
```

Failed template event:

```json
{
  "failed_template_id": "FT002",
  "node": "test:integration-test",
  "pattern": "Connecting to <HOST>:<PORT>"
}
```

Another raw line:

```text
Connection refused
```

becomes:

```json
{
  "failed_template_id": "FT004",
  "node": "test:integration-test",
  "pattern": "Connection refused"
}
```

because there is no dynamic value that needs masking.

---

# 11. Step 4 — Template-to-Template Comparison

The clean V1 rule is:

```text
For each failed template/event:

1. choose the correct stage/DAG-node success scope
2. canonicalize the failed template
3. lookup the same canonical template in the success profile
4. if found:
       membership = true
       calculate support strength
   else:
       membership = false
       mark high novelty
```

## Exact canonical comparison first

Success:

```text
Connecting to <HOST>:<PORT>
```

Failed:

```text
Connecting to <HOST>:<PORT>
```

Result:

```text
MATCH
membership = true
novelty = low
```

Success:

```text
Tests run: <NUM>, Failures: 0
```

Failed:

```text
Tests run: <NUM>, Failures: <NON_ZERO_NUM>
```

Result:

```text
NO MATCH
membership = false
novelty = high
```

This is why masking must preserve failure semantics.

A dangerous mask would be:

```text
Tests run: <NUM>, Failures: <NUM>
```

because then:

```text
Failures: 0
Failures: 9
```

can collapse into the same template.

## Production recommendation

For V1, prefer:

```text
exact canonical template equality
+
same stage/DAG scope
+
same parser/preprocessing compatibility
```

over broad fuzzy matching.

Fuzzy similarity can be added later as a secondary low-confidence signal, but it should not silently turn a truly new failure into a known-normal event.

---

# 12. Step 5 — Full Comparison Table

Assume the failed node produces these templates:

| Failed template | Success match? | Support | Failed count | Success typical | Initial result |
|---|---:|---:|---:|---:|---|
| `Starting PostgreSQL` | Yes | 3/3 | 1 | 1 | Low novelty |
| `Connecting to <HOST>:<PORT>` | Yes | 3/3 | 1 | 1 | Low novelty |
| `Running <NUM> integration tests` | Yes | 3/3 | 1 | 1 | Low novelty |
| `Retrying connection to <HOST>` | No | 0/3 | 77 | 0 | Novel + repetition anomaly |
| `Connection refused` | No | 0/3 | 1 | 0 | Novel |
| `org.postgresql.util.PSQLException <*>` | No | 0/3 | 1 | 0 | Novel + exception |
| `PaymentServiceIT FAILED` | No | 0/3 | 1 | 0 | Novel + failure signal |
| `Tests run: <NUM>, Failures: <NON_ZERO_NUM>` | No | 0/3 | 1 | 0 | Novel + failed test summary |
| `BUILD FAILURE` | No | 0/3 | 1 | 0 | Novel + terminal failure |

This table is the heart of the template-to-template diff.

---

# 13. Step 6 — Support Strength Is Better Than Boolean Membership

A template existing in the baseline is useful, but support matters.

Compare:

```text
Template A:
seen in build-901
seen in build-908
seen in build-913

support = 3/3
```

with:

```text
Template B:
not seen in build-901
seen in build-908
not seen in build-913

support = 1/3
```

Both technically exist in the success profile.

But:

```text
3/3 = strongly normal-looking
1/3 = weakly supported / rare
```

So a production profile should preserve:

```json
{
  "support_count": 1,
  "success_run_count": 3,
  "support_ratio": 0.333
}
```

Possible interpretation:

```text
3/3 -> very low novelty
2/3 -> low novelty
1/3 -> medium novelty / RARE_IN_SUCCESS
0/3 -> high novelty / NOVEL_VS_SUCCESS
```

The exact numerical thresholds should be calibrated later.

---

# 14. Step 7 — Frequency Comparison

Membership alone is insufficient.

Assume the success profile contains:

```json
{
  "pattern": "Retrying registry request",
  "support_count": 3,
  "success_run_count": 3,
  "counts_per_run": [1, 2, 1],
  "median_count": 1
}
```

A failed build contains the same template 500 times.

Basic membership says:

```text
seen in success = YES
```

Frequency says:

```text
success median = 1
failed count   = 500
ratio          = 500x
```

Result:

```text
NOVEL_VS_SUCCESS = false
FREQUENCY_ANOMALY = true
```

That event must still become a candidate.

This catches:

```text
retry loops
polling loops
reconnect storms
repeated authentication failures
dependency-download loops
repeated OOM precursor warnings
```

---

# 15. The Most Important Safety Rule

Do not implement:

```python
if template in success_baseline:
    discard(line)
```

Instead implement:

```python
if template in success_baseline:
    novelty_signal = lower
```

Why?

A line can appear in successful builds and still matter during a failed build.

Example successful run:

```text
ERROR cache lookup failed
Using local fallback
BUILD SUCCESS
```

Failed run:

```text
ERROR cache lookup failed
Using local fallback
fallback cache corrupted
BUILD FAILURE
```

The first error is known in success history.

But deleting it removes context from the failure chain.

Correct interpretation:

```text
seen in success
    !=
irrelevant

seen in success
    =
less surprising
```

---

# 16. Step 8 — Add Non-Diff Failure Signals

The diff produces novelty/support information.

Candidate selection should combine it with other deterministic signals:

```text
NOVEL_VS_SUCCESS
RARE_IN_SUCCESS
FREQUENCY_ANOMALY
FAILURE_KEYWORD
TERMINAL_FAILURE
FAILED_STAGE
NEAR_TAIL
EXCEPTION
NONZERO_EXIT
FAILED_TEST
COMPILER_ERROR
INFRASTRUCTURE_ERROR
STACK_TRACE
TIMEOUT
OOM
```

Example:

```text
Connection refused
```

could become:

```json
{
  "reasons": [
    "NOVEL_VS_SUCCESS",
    "FAILED_STAGE"
  ]
}
```

`PSQLException`:

```json
{
  "reasons": [
    "NOVEL_VS_SUCCESS",
    "EXCEPTION",
    "FAILED_STAGE",
    "NEAR_TAIL"
  ]
}
```

`BUILD FAILURE`:

```json
{
  "reasons": [
    "NOVEL_VS_SUCCESS",
    "FAILURE_KEYWORD",
    "TERMINAL_FAILURE",
    "NEAR_TAIL"
  ]
}
```

Candidate generation should favor recall.

If any meaningful detector fires, keep the event for the next stage.

---

# 17. Production Pseudocode

```python
def compare_failed_run(run, baseline_store):
    # 1. Resolve compatible baseline
    baseline = baseline_store.resolve(
        seal_id=run.seal_id,
        project=run.project,
        repo=run.repo,
        execution_type=run.execution_type,
        pipeline_fingerprint=run.pipeline_fingerprint,
        preprocessing_versions=run.preprocessing_versions,
    )

    if baseline is None:
        return compare_without_baseline(run)

    candidates = []
    stats = DiffStats()

    # 2. Process failed run with same compatible representation
    failed_events = extract_failed_events(
        run.log,
        execution_type=run.execution_type,
        normalizer_version=baseline.normalizer_version,
        masking_version=baseline.masking_version,
        drain_config_version=baseline.drain_config_version,
        read_only=True,
    )

    # 3. Aggregate failed counts by scope + canonical template
    failed_counts = count_templates(failed_events)

    for event in failed_events:
        reasons = []

        scope = resolve_scope(event)
        # JULES: stage
        # LATTICE: DAG node, e.g. test:integration-test

        success_profile = baseline.templates_for(scope)

        membership = success_profile.lookup(
            canonical_template=event.canonical_template
        )

        # 4. Success membership / support
        if membership is None:
            reasons.append("NOVEL_VS_SUCCESS")
            support_ratio = 0.0
        else:
            support_ratio = membership.support_ratio

            if support_ratio < 0.5:
                reasons.append("RARE_IN_SUCCESS")

        # 5. Frequency anomaly
        if frequency_is_abnormal(
            failed_count=failed_counts[(scope, event.canonical_template)],
            success_stats=membership
        ):
            reasons.append("FREQUENCY_ANOMALY")

        # 6. Other deterministic signals
        if contains_failure_keyword(event.text):
            reasons.append("FAILURE_KEYWORD")

        if event.scope == run.failed_scope:
            reasons.append("FAILED_STAGE")

        if event.is_near_tail:
            reasons.append("NEAR_TAIL")

        if event.is_exception:
            reasons.append("EXCEPTION")

        if event.nonzero_exit:
            reasons.append("NONZERO_EXIT")

        if event.failed_test:
            reasons.append("FAILED_TEST")

        if reasons:
            candidates.append(
                Candidate(
                    line_number=event.line_number,
                    scope=scope,
                    canonical_template=event.canonical_template,
                    success_support=support_ratio,
                    reasons=deduplicate(reasons),
                )
            )

    return LogDiffResult(
        baseline_version=baseline.version,
        diff_confidence=calculate_diff_confidence(run, baseline),
        candidates=candidates,
        statistics=stats,
    )
```

---

# 18. Recommended Runtime Data Structures

For fast production comparison, do not repeatedly scan a JSON array linearly.

Build an index.

Conceptually:

```python
success_index = {
    (
        "test:integration-test",
        "Starting PostgreSQL"
    ): SuccessTemplateProfile(...),

    (
        "test:integration-test",
        "Connecting to <HOST>:<PORT>"
    ): SuccessTemplateProfile(...),
}
```

Lookup becomes approximately:

```text
O(1)
```

per canonical template with a hash map / indexed key.

For a huge Jenkins log:

```text
raw failed events = 120,000
unique failed templates = 900
```

You can compare at the unique-template level first and propagate the result back to occurrences.

That is far cheaper than:

```text
120,000 failed lines
    x
50,000 success templates
```

A naive nested comparison should be avoided.

---

# 19. Better Comparison Shape for Very Large Logs

Recommended:

```text
120,000 failed log lines
        |
        v
normalize/redact/mask
        |
        v
canonical failed event keys
        |
        v
aggregate occurrences
        |
        v
900 unique failed templates
        |
        v
hash/index lookup in matching success scope
        |
        v
membership/support/frequency result
        |
        v
propagate reasons to original line numbers
```

This gives both:

```text
efficiency
+
full provenance
```

The original line number must be retained so later context expansion can return to the raw/redacted log region.

---

# 20. Example Detailed Comparison Internals

Consider:

```text
line 80106
Connecting to payment-db.internal:5432
```

## 20.1 Normalize/mask

```text
Connecting to <HOST>:<PORT>
```

## 20.2 Resolve scope

```text
execution_type = LATTICE
node           = test:integration-test
```

## 20.3 Create lookup key

Conceptually:

```text
(
  node = test:integration-test,
  pattern = Connecting to <HOST>:<PORT>,
  normalizer = v2,
  masking = v3,
  drain_config = v1
)
```

## 20.4 Lookup success profile

Found:

```json
{
  "template_id": "T202",
  "support_count": 3,
  "success_run_count": 3,
  "median_count": 1
}
```

## 20.5 Classification

```text
membership          = true
support             = 3/3
novelty             = low
frequency anomaly   = false
failure keyword     = false
```

No strong candidate reason fires.

The line remains part of the source log for possible context expansion, but it does not independently enter the candidate pool.

---

# 21. Example Novel Comparison Internals

Consider:

```text
line 80200
Connection refused
```

Canonical pattern:

```text
Connection refused
```

Lookup key:

```text
(
  test:integration-test,
  Connection refused
)
```

Success lookup:

```text
NOT FOUND
```

Classification:

```text
membership       = false
support          = 0/3
novelty          = high
failed node      = yes
```

Candidate:

```json
{
  "candidate_id": "c-80200",
  "line_number": 80200,
  "scope": "test:integration-test",
  "template": "Connection refused",
  "baseline": {
    "membership": false,
    "support_count": 0,
    "success_run_count": 3
  },
  "reasons": [
    "NOVEL_VS_SUCCESS",
    "FAILED_STAGE"
  ]
}
```

---

# 22. Example Frequency-Anomaly Internals

Suppose:

```text
Retrying connection to <HOST>
```

is actually present in the success baseline.

Success:

```text
build-901 -> 1
build-908 -> 0
build-913 -> 2

median = 1
```

Failed run:

```text
77 occurrences
```

Membership:

```text
true
```

Novelty:

```text
low
```

Frequency:

```text
77 / max(1, median=1)
= 77x
```

Candidate:

```json
{
  "template": "Retrying connection to <HOST>",
  "baseline": {
    "membership": true,
    "support_count": 2,
    "success_run_count": 3,
    "median_count": 1
  },
  "failed_count": 77,
  "reasons": [
    "FREQUENCY_ANOMALY",
    "FAILED_STAGE"
  ]
}
```

This demonstrates why:

```text
template match
```

does not automatically mean:

```text
safe / irrelevant
```

---

# 23. Final Log Diff Output

The **Log Diff stage** should return structured evidence metadata, not an RCA.

Example:

```json
{
  "run": {
    "seal_id": "seal101",
    "project": "payments",
    "repo": "payment-api",
    "build_id": "build-944",
    "execution_type": "LATTICE",
    "failed_scope": "test:integration-test"
  },

  "baseline": {
    "status": "FOUND",
    "version": "v17",
    "source_branch": "main",
    "success_runs": [
      "build-901",
      "build-908",
      "build-913"
    ],
    "normalizer_version": "v2",
    "masking_version": "v3",
    "drain_config_version": "v1"
  },

  "comparison": {
    "scope": "test:integration-test",
    "diff_confidence": "HIGH"
  },

  "statistics": {
    "failed_event_occurrences": 120000,
    "unique_failed_templates": 900,
    "templates_seen_in_success": 842,
    "novel_templates": 58,
    "frequency_anomalies": 3,
    "final_candidate_events": 126
  },

  "candidates": [
    {
      "candidate_id": "c-80200",
      "line_number": 80200,
      "template": "Connection refused",
      "success_membership": false,
      "success_support": "0/3",
      "reasons": [
        "NOVEL_VS_SUCCESS",
        "FAILED_STAGE"
      ]
    },
    {
      "candidate_id": "c-80201",
      "line_number": 80201,
      "template": "org.postgresql.util.PSQLException <*>",
      "success_membership": false,
      "success_support": "0/3",
      "reasons": [
        "NOVEL_VS_SUCCESS",
        "EXCEPTION",
        "FAILED_STAGE",
        "NEAR_TAIL"
      ]
    },
    {
      "candidate_id": "c-80202",
      "line_number": 80202,
      "template": "PaymentServiceIT FAILED",
      "success_membership": false,
      "success_support": "0/3",
      "reasons": [
        "NOVEL_VS_SUCCESS",
        "FAILURE_KEYWORD",
        "FAILED_TEST",
        "FAILED_STAGE",
        "NEAR_TAIL"
      ]
    },
    {
      "candidate_id": "c-80204",
      "line_number": 80204,
      "template": "BUILD FAILURE",
      "success_membership": false,
      "success_support": "0/3",
      "reasons": [
        "NOVEL_VS_SUCCESS",
        "FAILURE_KEYWORD",
        "TERMINAL_FAILURE",
        "NEAR_TAIL"
      ]
    }
  ]
}
```

This is the output of **Log Diff + Candidate Selection**.

It is not yet the final evidence pack.

---

# 24. What Happens Immediately After Log Diff

The next stages are:

```text
Candidate Events
      |
      v
Deduplication
      |
      v
Context Expansion
      |
      v
Merge into Log Blocks
      |
      v
Weighting / Scoring
      |
      v
Density / Ranking
      |
      v
Token Budget Selection
      |
      v
Evidence Pack
      |
      v
LLM RCA
```

Example:

Candidate:

```text
80200 Connection refused
```

is too isolated.

Context expansion may produce:

```text
80195 DB host payment-db.internal
80196 DB port 5432
80197 Opening JDBC connection
80198 Retrying connection
80199 Retrying connection
80200 Connection refused
80201 org.postgresql.util.PSQLException
80202 PaymentServiceIT FAILED
80203 Tests run: 124, Failures: 1
80204 BUILD FAILURE
```

That becomes a much better diagnostic block.

---

# 25. JULES Comparison

For JULES, execution is sequential.

Example:

```text
checkout
compile
unit-test
package
deploy
```

The scope can be:

```text
stage = compile
stage = unit-test
stage = deploy
```

If the failed stage is:

```text
unit-test
```

compare failed `unit-test` templates with:

```text
JULES / unit-test / compatible success baseline
```

Example:

```text
Failed:
Running test <*>

Success unit-test:
Running test <*>

=> matched / low novelty
```

```text
Failed:
java.lang.OutOfMemoryError

Success unit-test:
not found

=> novel + exception
```

Because the pipeline is sequential, local stage order can be a useful optional signal.

But template membership should still be the primary diff concept.

---

# 26. LATTICE Comparison

For LATTICE, logs from parallel DAG nodes can interleave.

Example:

```text
//test:unit
//test:integration-test
//scan:security
```

Correct comparison:

```text
failed template from test:integration-test
        |
        v
success templates from test:integration-test
```

Incorrect comparison:

```text
failed template from test:integration-test
        |
        v
all templates from all DAG nodes
```

Also incorrect:

```text
healthy global sequence A
vs
failed global sequence B
```

because concurrent scheduling changes global ordering.

For LATTICE:

```text
scope/node membership
```

is much stronger than:

```text
global line position
```

---

# 27. What If Stage / DAG Node Is Unknown?

If stage resolution fails:

```text
stage = UNKNOWN
```

fallback:

```text
run-level baseline
```

But lower confidence.

Example:

```json
{
  "comparison_scope": "RUN_LEVEL",
  "stage_resolution": "UNKNOWN",
  "diff_confidence": "MEDIUM"
}
```

Do not invent a node identity.

---

# 28. What If No Compatible Success Baseline Exists?

Cases:

```text
new repo
first run fails
pipeline definition changed
normalizer changed
masking rules changed
baseline worker unavailable
old baseline is incompatible
```

Do not stop reduction.

Instead:

```text
No baseline
    |
    v
skip success-template novelty signal
    |
    v
continue with:
failure keywords
tail
failed stage
non-zero exit
exceptions
failed tests
compiler errors
infrastructure patterns
repetition compression
```

Return:

```json
{
  "baseline_status": "MISSING",
  "diff_confidence": "UNAVAILABLE"
}
```

No baseline means:

```text
less comparison intelligence
```

not:

```text
no RCA
```

---

# 29. What If 90% of the Failed Log Becomes Novel?

That is usually a warning.

Possible causes:

```text
wrong baseline
pipeline changed
masking version mismatch
normalizer mismatch
toolchain changed
DAG parsing failed
baseline is stale
```

Return a warning such as:

```json
{
  "diff_confidence": "LOW",
  "warning": "NOVELTY_RATE_TOO_HIGH"
}
```

Then rely more heavily on:

```text
failure keywords
exception signals
failed stage
exit code
tail
failed tests
```

Do not trust novelty blindly.

---

# 30. What If Almost Nothing Is Novel?

That also does not prove there is no useful evidence.

Possible causes:

```text
frequency-based failure
over-masking
known warning became fatal in new context
only a semantic parameter changed
same template but HTTP status changed
same retry message repeated thousands of times
```

So all other detectors must still run.

---

# 31. Diff Confidence

Diff confidence describes:

> How trustworthy is the success-vs-failure comparison?

It is **not** RCA confidence.

Possible inputs:

```text
compatible baseline found?
baseline fresh?
3 supporting success runs or only 1?
same preprocessing versions?
same pipeline fingerprint?
exact stage/DAG node known?
source log complete or truncated?
novelty rate reasonable?
```

Example HIGH:

```json
{
  "diff_confidence": "HIGH",
  "reasons": [
    "BASELINE_FOUND",
    "3_RECENT_SUCCESS_RUNS",
    "PREPROCESSING_VERSION_MATCH",
    "EXACT_NODE_MATCH",
    "COMPLETE_SOURCE_LOG"
  ]
}
```

Example LOW:

```json
{
  "diff_confidence": "LOW",
  "reasons": [
    "STALE_BASELINE",
    "STAGE_UNKNOWN",
    "PARTIAL_SOURCE_LOG"
  ]
}
```

---

# 32. Important Production Decisions

## Decision 1 — Do not compare raw logs

Use:

```text
failed canonical template
VS
success canonical template
```

Raw values such as timestamps, hosts, build IDs, hashes, and workspace paths otherwise create false differences.

---

## Decision 2 — Compare inside the correct scope

JULES:

```text
stage
```

LATTICE:

```text
DAG node / build_type:stage_name
```

Do not compare unrelated stages.

---

## Decision 3 — Preserve semantic failure values

Do not over-mask:

```text
HTTP 200
HTTP 500
```

into one meaningless success/failure template if the status class is diagnostically important.

Prefer semantic masks or features such as:

```text
<HTTP_2XX>
<HTTP_5XX>
```

Similarly:

```text
Failures: 0
```

must remain distinguishable from:

```text
Failures: 9
```

---

## Decision 4 — Success membership lowers novelty; it does not delete evidence

This is the strongest safety rule.

---

## Decision 5 — Never learn from failed logs into the success baseline

Online failure classification must be read-only with respect to successful knowledge.

---

## Decision 6 — Compare stable patterns, not local template IDs

Do not assume:

```text
FT001 == T001
```

Use:

```text
canonical template key
+
scope
+
compatibility versions
```

---

## Decision 7 — Frequency is a first-class signal

A normal event happening 500 times can be more suspicious than a harmless brand-new log line.

---

## Decision 8 — Keep original provenance

Every candidate must preserve:

```text
build ID
original line number/range
stage/DAG node
canonical template
redacted source text
reason codes
baseline version
```

This is required for explainability and later context expansion.

---

# 33. Recommended Minimal V1 Storage Contract

## `baseline.json`

```json
{
  "seal_id": "seal101",
  "project": "payments",
  "repo": "payment-api",
  "execution_type": "LATTICE",
  "baseline_version": "v17",
  "source_branch": "main",
  "pipeline_fingerprint": "sha256:a81f...",
  "normalizer_version": "v2",
  "masking_version": "v3",
  "drain_config_version": "v1",
  "success_run_count": 3,
  "scopes": {
    "test:integration-test": [
      "T201",
      "T202",
      "T203",
      "T204",
      "T205"
    ]
  }
}
```

## `templates.json`

```json
[
  {
    "template_id": "T202",
    "scope": "test:integration-test",
    "canonical_pattern": "Connecting to <HOST>:<PORT>",
    "support_count": 3,
    "success_run_count": 3,
    "counts_per_run": [1, 1, 1],
    "median_count": 1
  }
]
```

## `drain3_state.json`

Persisted separately for parser continuity, not as the primary diff lookup table.

---

# 34. Recommended Minimal V1 Log Diff Algorithm

```text
1. Receive failed build identity + log
2. Detect JULES or LATTICE
3. Parse stage / DAG-node metadata
4. Resolve latest compatible success baseline
5. Load baseline.json
6. Validate pipeline/preprocessing compatibility
7. Load only required success templates from templates.json
8. Normalize/redact/mask failed logs with same compatible versions
9. Produce canonical failed templates/events
10. Aggregate failed template counts by stage/node
11. For each failed canonical template:
       a. exact scoped success lookup
       b. calculate support
       c. calculate novelty
       d. check frequency anomaly
12. Add keyword/failed-stage/tail/exception/exit/test signals
13. Create high-recall candidate pool
14. Return candidate objects + diff statistics + confidence
15. Pass candidates to dedup/context expansion
```

No LLM call is required in this stage.

It should be deterministic and explainable.

---

# 35. One-Screen Mental Model

```text
                    OFFLINE SUCCESS
                          |
                          v
                 normalize/redact/mask
                          |
                          v
                        Drain
                          |
                          v
        +-----------------+-----------------+
        |                                   |
        v                                   v
  drain3_state.json                  success templates
  parser memory                      templates.json
                                            |
                                      baseline.json
                                      selects scope/version
                                            |
                                            |
FAILED BUILD                                |
    |                                       |
    v                                       |
same preprocessing                          |
    |                                       |
    v                                       |
failed canonical templates -----------------+
                    |
                    v
        scoped template membership
                    |
        +-----------+------------+
        |                        |
        v                        v
   seen in success          not seen
   lower novelty            high novelty
        |                        |
        +-----------+------------+
                    |
             frequency check
                    |
             other detectors
                    |
                    v
             candidate pool
                    |
                    v
      dedup + context + scoring
                    |
                    v
              evidence pack
                    |
                    v
                 LLM RCA
```

---

# 36. Final Answer to the Original Question

When the failed run reaches **Log Diff**, the successful offline artifacts that matter are:

```text
1. baseline.json
   -> tells LogSift WHICH compatible baseline/version/scope to use

2. templates.json
   -> gives LogSift the ACTUAL success templates/statistics to compare

3. drain3_state.json
   -> parser memory, NOT the direct Log Diff comparison file
   -> optionally used read-only by the online parsing/classification step
```

The comparison is:

```text
Failed canonical template
        VS
Success canonical template
```

inside the same:

```text
seal/project/repo
+
execution type
+
stage or DAG node
+
compatible parser/preprocessing version
```

Then LogSift asks:

```text
Was this pattern seen in recent successful runs?
How strongly was it supported?
Is it in the correct stage/node?
Is its frequency abnormal?
Does it contain explicit failure evidence?
Is it in the failed stage?
Is it near termination?
Is it an exception/test failure/non-zero exit?
```

The result is **candidate evidence**, not an RCA.

The single most important rule is:

> **A success-template match means "less surprising"; it must not mean "delete this line."**

---

# 37. Source Basis Inside the LogSift Workspace

This walkthrough consolidates and operationalizes the existing LogSift design documented in:

- `Deep_Dive_Success_Baseline_Template_Storage_and_Log_Diff.md`
- `Log_Diffing_and_Candidate_Selection_Deep_Dive.md`
- `Success_Baseline_and_Log_Diffing_README.md`
- `Success_Log_Preprocessing_Deep_Dive.md`
- `Drain_Reusable_Success_Templates_Deep_Dive.md`
- `Dedup_Context_Expansion_Log_Blocks_Deep_Dive.md`
- `Weighting_Scoring_Density_Deep_Dive.md`

The read-only handling of successful Drain state, stable canonical template-key recommendation, and indexed runtime lookup are production-hardening recommendations that make the conceptual design safer and more scalable.
