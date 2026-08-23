# Logsift offline learning flow

[Problem and architecture](01-problem-and-architecture.md) · [Failure analysis](03-failure-analysis-flow.md) · [Layer 3](04-layer-3-rag-and-code-context.md)

This is the canonical description of Logsift preprocessing and template creation. The failure path uses this same versioned contract; it does not define a second normalizer or parser.

The repository defines the main behavior: learn from selected successful runs, keep Jules and Lattice semantics distinct, protect sensitive content before downstream use, extract templates with Drain, version the result, and never let a failed run modify a success baseline. Where event wire formats, storage APIs, or concurrency controls are absent, this document labels a recommended contract rather than presenting it as current behavior.

## Jules and Lattice ingestion

### Jules

**How Logsift handles this today.** Jules represents a sequential pipeline. Its logical stage order carries meaning: setup precedes build, build precedes test, and so on. The repository expects comparison and expansion to respect these stage boundaries. It does not define a concrete Jules wire schema, timestamp format, or transport envelope.

**Recommended adapter contract.** A Jules adapter should turn each source event into one or more canonical records while preserving the stage name, stage ordinal, task or step when available, physical line position, and the event's original metadata. A line that appears in the `test` stage must not become an unscoped line merely because the canonical schema is shared with Lattice.

A realistic Jules source event might look like this. The shape is illustrative because the repository does not define the wire format:

```json
{
  "run_id": "run-7312",
  "pipeline": "verify-service",
  "stage": "test",
  "stage_index": 3,
  "sequence": 1842,
  "time": "2026-08-23T09:31:04.812Z",
  "stream": "stderr",
  "message": "FAIL src/payment_test.py::test_capture request_id=req-73c2 duration=812ms"
}
```

### Lattice

**How Logsift handles this today.** Lattice represents a dependency graph whose nodes may run concurrently. Physical console order can interleave output from unrelated nodes. The repository therefore treats the logical `build_type:stage_name` or equivalent DAG-node identity as the important scope. It does not define a concrete Lattice wire schema, graph-event vocabulary, or transport envelope.

**Recommended adapter contract.** A Lattice adapter should preserve the node identity, node attempt, dependency parents, worker or process identity when present, node-local sequence, and physical log position. Logsift should reconstruct a node-local logical stream for comparison without claiming that unrelated physical lines have a causal order.

A realistic Lattice source event might look like this. Again, the shape is illustrative:

```json
{
  "execution_id": "exec-8841",
  "workflow": "release-graph",
  "node": {
    "build_type": "service-test",
    "stage_name": "integration",
    "attempt": 2,
    "parents": ["service-build:compile"]
  },
  "node_sequence": 417,
  "physical_sequence": 9921,
  "time": "2026-08-23T09:33:19.201Z",
  "message": "container worker-2 exited code=137 after 58.4s"
}
```

### Canonical Logsift event

The canonical record gives downstream stages one predictable interface without erasing the differences above. The exact schema is not present in the repository; the following is the recommended V1 contract:

```json
{
  "schema_version": "event/v1",
  "tenant_id": "tenant-example",
  "repository_id": "repo-example",
  "pipeline_id": "verify-service",
  "service_id": "payment-service",
  "environment": "test",
  "source_type": "jules",
  "run_id": "run-7312",
  "event_id": "source-event-or-derived-id",
  "correlation_id": "corr-92",
  "branch": "main",
  "commit_sha": "8f13b7c...",
  "outcome": "success",
  "logical_scope": {
    "kind": "stage",
    "id": "test",
    "ordinal": 3,
    "attempt": 1,
    "parents": []
  },
  "position": {
    "physical_line": 1842,
    "source_byte_coordinate_space": "source_object_bytes_v1",
    "source_byte_start": 93481,
    "source_byte_end": 93586,
    "source_sequence": 1842,
    "logical_sequence": 417
  },
  "observed_at": "2026-08-23T09:31:04.812Z",
  "stream": "stderr",
  "raw_ref": "restricted-object-reference",
  "message": "FAIL src/payment_test.py::test_capture request_id=req-73c2 duration=812ms",
  "source_metadata": {},
  "structure_confidence": 1.0
}
```

`physical_line` is one-based in this contract. The ingestion wrapper assigns physical line numbers and byte ranges before normalization changes line representation. `logical_sequence` orders events only within one stage or DAG node. The raw reference is access controlled and is never a public URL.

### Field mapping

Because concrete source schemas are not defined, the source-field names below are adapter contracts rather than claims about an existing wire payload.

| Jules source field | Canonical field | Required? | Notes |
|---|---|---:|---|
| run identifier | `run_id` | Required | Stable across all events in one run. |
| pipeline identifier | `pipeline_id` | Required | Must describe the logical pipeline, not a display-only label. |
| stage name | `logical_scope.id` | Required | `logical_scope.kind` is `stage`. |
| stage ordinal | `logical_scope.ordinal` | Recommended | Preserves sequential order; do not infer it from line order if explicit metadata exists. |
| stage attempt | `logical_scope.attempt` | Optional | Defaults to 1 only when the adapter can prove no retry occurred. |
| event sequence | `position.source_sequence` | Recommended | Used for idempotency and source ordering. |
| timestamp | `observed_at` | Optional | Preserve absence instead of fabricating a time. |
| stream | `stream` | Optional | Typical values are `stdout`, `stderr`, or `combined`. |
| message | `message` | Required | Exact source payload before textual preprocessing. |
| source metadata | `source_metadata` | Optional | Retains fields not promoted to the canonical contract. |

| Lattice source field | Canonical field | Required? | Notes |
|---|---|---:|---|
| execution identifier | `run_id` | Required | Correlates graph events and log fragments. |
| workflow identifier | `pipeline_id` | Required | Stable logical graph identity. |
| build type and stage name | `logical_scope.id` | Required | Preserve both components in a collision-safe representation. |
| node attempt | `logical_scope.attempt` | Recommended | Essential for separating retry loops. |
| parent nodes | `logical_scope.parents` | Optional | Enables dependency-aware expansion when supplied. |
| node-local sequence | `position.logical_sequence` | Recommended | Orders events inside a node. |
| physical sequence | `position.source_sequence` | Recommended | Preserves the original interleaved stream. |
| timestamp | `observed_at` | Optional | Supports time windows but does not replace node ordering. |
| message | `message` | Required | Exact source payload before textual preprocessing. |
| source metadata | `source_metadata` | Optional | May retain worker, process, container, and graph-event fields. |

Fields common to both adapters—tenant, repository, branch, commit, outcome, byte position, line position, raw reference, source type, schema version, event ID, and correlation ID—are required when the source exposes them. If a required field cannot be recovered, the event is quarantined or marked incomplete; it should not silently enter baseline learning.

### Differences canonicalization must preserve

- Jules has a meaningful sequential stage order; Lattice has dependency relationships and node-local order.
- A Jules stage commonly occupies a contiguous physical region. A Lattice node may map to many noncontiguous byte and line ranges.
- Lattice retry attempts and concurrent nodes need separate logical streams. A global console stream is retained as provenance, not treated as a single causal sequence.
- Stage or node structure confidence is recorded. Unknown structure is not coerced into either source model.

> **Image-generation prompt — Jules and Lattice canonicalization**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 technical diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn styling. Use dark navy handwritten headings, teal for offline learning, orange only for a small downstream failure-analysis reference, purple only in the legend, and yellow sticky notes only for key insights. On the left, show two separate source groups. The upper group is “Jules” with three sequential stage boxes “Build → Test → Package,” each with ordered line icons. The lower group is “Lattice” with four DAG-node boxes connected by dependency arrows, two nodes running in parallel, and interleaved physical line icons beneath them. Draw both through distinct teal adapter boxes into one center document labelled “Canonical Logsift event.” On that document, show short fields: “source type,” “run,” “stage or node,” “attempt,” “physical line + bytes,” “logical sequence,” “raw reference,” and “metadata.” From the document, draw two arrows to the right: one to “Stage-local stream” for Jules and one to “Node-local stream + physical provenance” for Lattice. Add a yellow sticky note reading “Canonical does not mean identical.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for event flow, and dotted arrows for retained provenance. Use simple arrows, document icons, filters, and one storage cylinder. Keep labels short and legible; include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and verify every arrow direction.

## Branch and event policy

### Current project behavior

The repository describes a conservative policy: learn from selected successful runs on trusted main or master and release branches; exclude feature, developer, and temporary branches. It also says not to treat every successful run as a learning event. Skipped, failed, cancelled, or unstable runs do not update a success baseline. Pull-request behavior, trust promotion, replay semantics, and exact event transport are not defined.

### Recommended configurable policy

| Branch class | Default learning action | Reason |
|---|---|---|
| Main (`main` or legacy default name) | Accept successful, complete, policy-approved runs | Best representation of integrated behavior. |
| Release | Accept successful, complete runs into a release-scoped baseline | Release configuration can differ materially from main. |
| Feature | Analyze if requested, but do not update shared baselines | Feature behavior is unstable and often short-lived. |
| Pull request | Build an ephemeral comparison candidate only; promote nothing automatically | Useful for pre-merge analysis without poisoning trusted history. |
| Temporary or experiment | Exclude by default; allow an isolated opt-in baseline with short retention | Names and behavior are not stable enough for shared learning. |

Branch class should be a rule result, not a hard-coded string comparison. Promotion should require a terminal `success` outcome, complete log upload, compatible source schema, passed redaction validation, minimum structural confidence, and no policy flag marking the run unstable. A recent window of trusted successes can smooth one-off variation; the repository treats the window size as a tunable starting point, not a universal constant.

### Baseline key

The repository currently names a baseline using a project or repository, source type, and versioned baseline identity. The recommended production lookup key is stricter:

```text
tenant_id + repository_id + pipeline_id + service_id + logical_scope.kind +
logical_scope.id + source_type + branch_class + environment +
compatibility_fingerprint
```

`service_id` is optional only for pipelines that cannot be divided by service, and `environment` is optional only when behavior is genuinely environment independent. The compatibility fingerprint covers source schema, adapter, normalization, redaction, masking, Drain configuration, segmentation rules, and fingerprint algorithm versions. Commit SHA belongs in the baseline manifest and selection policy but should not normally create one baseline per commit.

### Event creation and concurrent processing

The repository does not define the event bus or delivery contract. The recommended design is event-driven ingestion plus scheduled reconciliation:

1. A terminal pipeline event creates a learning request only after outcome and log-completeness checks pass.
2. `event_id` is the source event identifier when stable; otherwise it is a digest of tenant, source, run, event kind, logical scope, and source sequence.
3. The idempotency key is `tenant_id + event_id + learning_policy_version`. Re-delivery returns the existing result.
4. Deduplication uses the idempotency record rather than deleting repeated messages from the log. Two deliveries of one event produce one learning result, while two real identical log lines remain two occurrences.
5. `correlation_id` follows the terminal event through the learning request, artifacts, audit records, and publication attempt. It supports tracing; it does not replace the narrower idempotency key.
6. Retries use bounded exponential backoff. Permanent schema or redaction failures are quarantined, not retried forever.
7. Replay supplies an explicit `replay_id` and records the original event ID. The same policy version remains idempotent; a new policy version produces a new baseline candidate.
8. Ordering is enforced only where it has meaning: by source sequence for an envelope and by logical sequence within one stage or DAG node. Independent scopes can process concurrently.
9. Every run owns isolated working state keyed by `tenant_id + run_id + learning_attempt_id`. Parser state is never shared as mutable scratch space across concurrent runs.
10. Publication uses compare-and-set on the baseline generation. If another worker publishes first, the loser reloads the manifest and either merges deterministically or produces a new candidate version.
11. A reconciler finds terminal trusted runs for which no completed learning record exists and safely re-enqueues them.

> **Image-generation prompt — Branch learning decision**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Verify spelling and arrow direction.
> Create a wide 16:9 decision-flow diagram on a clean white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, teal for accepted offline-learning paths, orange for rejected or analysis-only paths, purple only in the legend, and yellow sticky notes only for key insights. Start at left with a document icon labelled “Terminal pipeline event.” Draw decision diamonds in this exact order: “Outcome = success?”, “Log complete?”, “Trusted branch class?”, “Rules + schema valid?”, and “Already processed?” Route failed, cancelled, skipped, incomplete, or invalid results to an orange box “Do not update baseline.” Route feature and pull-request branches to an orange box “Ephemeral analysis only.” Route main and release successes through a teal box “Idempotent learning request,” then “Isolated run state,” “Versioned preprocessing,” and a storage cylinder “Publish baseline with compare-and-set.” Add a dotted return arrow from “Already processed?” to “Return existing result.” Add a small clock icon and dotted arrow from “Scheduled reconciliation” to “Idempotent learning request.” Add yellow sticky notes “Success is necessary, not sufficient” and “Concurrent runs never share scratch state.” Include a compact legend mapping teal to offline learning, orange to failure analysis or exclusion, purple to retrieval/remediation, diamonds to policy decisions, and dotted arrows to replay or reconciliation. Use short, legible labels, simple arrows, document icons, filters, and a storage cylinder. Include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and verify all decision arrows point to the correct outcome.

## Normalization, redaction, masking, and canonicalization

These terms solve different problems and should not be collapsed into one “cleanup” step.

- **Parsing the source envelope** extracts run metadata, source type, logical scope, event identity, and exact physical provenance from the original source representation.
- **Normalization** makes presentation deterministic: encoding, line endings, ANSI and control sequences, progress redraws, and timestamp or prefix separation.
- **Redaction** irreversibly removes secrets before content is persisted outside the restricted raw-log boundary.
- **Masking** replaces dynamic but non-secret values with typed placeholders so equivalent messages can share a template.
- **Canonicalization** assembles the final stable representation—text plus source scope, provenance, and version fields—consumed by Drain and artifact writers.

### Required order

Some older project summaries list these operations at a coarser level and in a different order. The detailed implementation notes require provenance capture first and distinguish presentation normalization from secret removal. This document adopts that detailed contract as canonical. The repository does not state whether a deployed pipeline already follows it.

The canonical order is:

1. **Capture the raw reference and physical provenance.** Assign original one-based line numbers and byte ranges before text changes.
2. **Parse the source envelope.** Recover trusted metadata without treating untrusted message text as control data.
3. **Normalize presentation.** Decode text, standardize line endings, handle carriage-return redraws, strip display controls, and separate recognized prefixes.
4. **Redact secrets.** Replace sensitive values irreversibly and record non-sensitive audit metadata.
5. **Apply typed masking.** Generalize approved dynamic values while preserving diagnostically meaningful classes.
6. **Canonicalize and validate.** Emit deterministic text and metadata under explicit versions.
7. **Run Drain.** Template extraction receives only validated, redacted, masked canonical input.

The order matters. Physical line and byte positions cannot be reconstructed reliably after normalization. Redacting before masking prevents a general dynamic-value rule from partially transforming a secret and allowing it to escape detection. Masking before Drain reduces false template splits. Canonical validation before parsing prevents malformed or unprotected content from entering baseline state.

### Value-handling policy

| Value | Default handling | Diagnostic exception |
|---|---|---|
| Timestamp | Extract to metadata; mask in canonical text as `<TIMESTAMP>` | Preserve temporal ordering and original value only in restricted provenance metadata. |
| Request or correlation ID | Mask as `<REQUEST_ID>` in template text; retain a protected correlation digest | Use the digest for expansion without exposing the original identifier. |
| UUID | Mask as `<UUID>` | Preserve only if an allow-listed domain identifier is proven non-sensitive and diagnostically meaningful. |
| Build ID | Mask as `<BUILD_ID>` | Retain the original in protected run metadata, not template text. |
| Temporary file path | Normalize separators and mask dynamic segments | Preserve source-code file and line references because they guide diagnosis. |
| URL | Redact credentials and sensitive query values; preserve scheme, host class, path shape, and status context when safe | Store the exact URL only in restricted raw logs when policy permits. |
| IP address | Mask as `<IP_ADDRESS>` | A documented allow-list may preserve safe network classes or loopback addresses. |
| Duration | Mask magnitude as `<DURATION>` for templates; retain a normalized numeric feature | Duration shifts remain available for anomaly scoring. |
| Memory size | Mask magnitude as `<MEMORY_SIZE>`; retain normalized bytes as a feature | Preserve terms such as “limit” and “requested.” |
| Port number | Mask ephemeral ports; preserve allow-listed semantic ports or port classes | Never let a broad number rule decide this alone. |
| Commit hash | Mask in text as `<COMMIT_SHA>`; retain canonical SHA in run metadata | Commit compatibility depends on the protected metadata value. |
| Branch-dependent value | Replace with `<BRANCH>` when it is presentation noise | Preserve branch class and exact branch in access-controlled metadata. |
| Username | Redact or pseudonymize as `<USER>` | Preserve only an approved service identity category, never a personal identifier by default. |
| Access token or password | Permanently replace with `<REDACTED_SECRET>` | Exact value remains only in the original restricted source, subject to its retention policy. |
| Private key or key block | Remove the complete block and insert `<REDACTED_PRIVATE_KEY>` | Never persist key material in derived artifacts. |
| Exit code, HTTP status class, zero-versus-nonzero failure class | Preserve | These classes often change the meaning of a message; mask changing magnitudes separately and retain them as numeric features. |
| Exception type, test name, compiler diagnostic, source file and line | Preserve after secret scanning | These values are primary diagnostic signals. |

“Removed permanently” means absent from every derived artifact, audit event, model input, and index. The only possible surviving copy is the original restricted raw log, governed by its own access and deletion policy. Audit records contain the rule ID, category, count, and position—not the secret value.

### Rules and safety

Rules execute deterministically by numeric priority, then stable rule ID. Source-specific envelope rules run before shared textual rules; redaction always completes before masking regardless of a local numeric mistake. Each artifact records the complete rule-set version and digest. A rule change produces a new compatibility fingerprint rather than silently mutating an old baseline.

Validation should include schema checks, compiled-pattern checks, bounded execution time, representative positive and negative tests, and overlap analysis. Broad rules need an explicit allow-list and a maximum match-rate guard. A candidate rule that masks too much, changes line counts unexpectedly, or matches critical preserved fields is rejected or sent to shadow evaluation. Redaction failures are fail-closed: the event does not proceed to Drain.

The safe, commented example is [examples/normalization-rules.yaml](examples/normalization-rules.yaml).

> **Image-generation prompt — Preprocessing order and protection boundary**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 pipeline diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, teal for offline learning, orange for a small failure-path compatibility arrow, purple only in the legend, and yellow sticky notes only for key insights. Draw these exact teal boxes from left to right: “Raw log reference,” “Capture line + byte positions,” “Parse source envelope,” “Normalize presentation,” “Redact secrets,” “Typed masking,” “Canonical validation,” and “Drain.” Put a shield around “Redact secrets” and draw a vertical dashed boundary immediately after it labelled “No secrets beyond this point.” Beneath “Raw log reference,” add a locked storage cylinder “Restricted raw log.” Beneath the transformations, show a small audit document receiving arrows from normalization, redaction, and masking, labelled “Rule IDs + counts, never values.” Above each transformation place a small version tag: “source schema,” “normalizer,” “redaction rules,” “masking rules,” and “parser config.” At far right, connect the version tags into a document labelled “Compatibility fingerprint.” Add an orange arrow from that document down to “Failed run must use same contract.” Add yellow sticky notes “Positions first,” “Redact before mask,” and “Fail closed.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for content flow, and dashed lines for security or compatibility boundaries. Use simple arrows, document icons, a shield, filters, and storage cylinders. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and verify every arrow direction.

## Drain template extraction

Drain is a streaming log parser that groups similar canonical lines into templates. Consider these three normalized lines:

```text
worker <IP_ADDRESS> completed task <BUILD_ID> in <DURATION>
worker <IP_ADDRESS> completed task <BUILD_ID> in <DURATION>
worker <IP_ADDRESS> completed task <BUILD_ID> in <DURATION>
```

Before masking, every address, identifier, and duration could be different. A naive exact-string counter would call them unrelated. After typed masking, Drain can represent them with one stable pattern.

### How the parsing tree works

Drain uses a fixed-depth tree so it does not compare every incoming line with every known cluster.

1. **Token-count grouping:** the first route is commonly the number of tokens. Lines with very different shapes stop competing early.
2. **Prefix routing:** selected leading token positions route the line through a bounded-depth tree. Constant tokens create specific branches; variable or crowded positions use a wildcard branch.
3. **Leaf candidates:** the reached leaf contains a limited set of candidate clusters.
4. **Similarity matching:** the parser compares the incoming tokens with each candidate template. Similarity is the share of compatible constant positions, with wildcard positions treated as variables.
5. **Template creation or update:** if the best match meets the configured threshold, differing positions become wildcards and the cluster count increases. Otherwise, the parser creates a new cluster.

This makes parsing incremental and memory-bounded relative to the number of clusters rather than the number of raw lines. It does not mean the entire original log is stored in parser memory.

### Thresholds and model scope

- A **similarity threshold** that is too strict splits harmless variations into many templates. One that is too loose merges messages with different meanings.
- A **tree depth** that is too shallow creates crowded leaves and more ambiguous comparisons. Excessive depth overfits early tokens and can fragment templates.
- A **maximum child count** that is too low sends too many lines down wildcard routes. Too high increases memory and candidate comparisons.
- A **maximum cluster count or leaf size** prevents unbounded state but needs an explicit eviction or rejection policy.

The repository identifies these as configuration choices but does not publish final values. Logsift should train models at a scope where message grammar is coherent: at least source type, repository, logical pipeline, and stage or DAG node. Sharing one parser across unrelated Jules and Lattice streams would erase source structure and increase accidental merges. Closely related scopes may share a model only after measured compatibility; that is a policy decision, not an automatic optimization.

Every model version records the tokenizer, tree parameters, similarity threshold, wildcard token, normalization and masking versions, source schema, and logical-scope policy. The failure path loads a compatible frozen baseline model in read-only mode. It may create in-memory clusters to parse a failed run, but it never writes those clusters back to trusted success state.

Numeric cluster IDs are local bookkeeping. Cluster `42` from one parser instance need not mean the same thing as cluster `42` from another. Cross-run comparison therefore uses canonical template text and a stable template fingerprint, not a parser-local number.

### Line-by-line example

Input after envelope parsing:

```text
2026-08-23T09:10:01Z worker 10.4.8.2 completed build 7312 in 12.8s
2026-08-23T09:12:44Z worker 10.4.9.7 completed build 7313 in 11.9s
2026-08-23T09:15:20Z worker 10.4.8.4 completed build 7314 in 13.1s
```

After normalization, redaction, and typed masking:

```text
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
```

Drain cluster template:

```text
worker <*> completed build <*> in <*>
```

Logsift canonical template text retains typed meaning rather than discarding it:

```text
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
```

The stable fingerprint is a digest over a versioned serialization such as:

```text
fingerprint_version | source_type | logical_scope_kind |
logical_scope_id | canonical_template_text
```

> **Image-generation prompt — Drain fixed-depth parsing tree**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 explanatory diagram on a clean white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, teal for offline learning, orange only for threshold warnings, purple only in the legend, and yellow sticky notes only for key insights. On the left, show four short canonical log-line documents, three with the same six-token shape and one with a different token count. Draw arrows into a teal tree whose first level is labelled “Token count,” second and third levels are labelled “Prefix tokens,” and whose crowded branches use a node labelled “Wildcard route.” At two leaves, draw small cluster cards. Show one incoming line compared with two templates at a leaf using a magnifying glass and a gauge labelled “Similarity threshold.” From the gauge, split arrows to “Match → update wildcard positions + count” and “No match → create template.” On the right, show a template card with canonical text, a small local numeric ID crossed out as “not portable,” and a fingerprint card marked “stable comparison identity.” Add orange margin notes “Too strict → template explosion” and “Too loose → unrelated messages merge.” Add a yellow sticky note “Failed runs use a frozen model.” Include a compact legend for teal offline learning, orange failure analysis or warnings, and purple retrieval/remediation. Use simple arrows, document icons, filters, a magnifying glass, and a small storage cylinder for model state. Keep labels short and legible, and include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, tree routing, and arrow direction.

## Generated artifacts and baseline publication

The repository currently names a baseline manifest, template data, Drain state, a human-readable template view, and a normalized sample. The richer records below are the recommended explicit artifact contract. Rows marked “current concept” are directly represented in the repository; rows marked “recommended contract” make data ownership and later lookup precise.

| Artifact | Status and purpose | Producer | Consumer | Format | Partition or lookup key | Version and retention |
|---|---|---|---|---|---|---|
| Normalized event stream | Recommended contract; replayable protected input after canonical preprocessing | Source adapter and preprocessing pipeline | Drain, validators, audit tools | Line-oriented canonical records or columnar partitions | Tenant, run, source, logical scope | Event schema plus rule versions; retain through baseline audit window |
| Redaction audit metadata | Recommended contract; proves which rules ran without storing matched values | Redaction stage | Security audit and pipeline validator | Structured records | Tenant, run, rule ID | Redaction version; retain per audit policy |
| Parsed log-event records | Recommended contract; binds each occurrence to template and provenance | Drain wrapper | Baseline aggregators and later occurrence lookup | Structured records | Tenant, run, scope, physical line | Parser and fingerprint versions; baseline window plus replay period |
| Canonical template catalog | Current concept, explicit contract recommended; unique canonical templates per scope | Drain aggregator | LogDiff and human inspection | Structured template records | Baseline key plus fingerprint | Immutable within one baseline version; retain while referenced |
| Template fingerprints | Recommended stable identity across parser instances | Fingerprint stage | LogDiff, indexes, retrieval query builder | Fixed-length digest plus canonical preimage fields | Fingerprint version and digest | Retain with catalog; algorithm version is mandatory |
| Template counts and distributions | Current comparison concept; frequency and support statistics | Baseline aggregator | LogDiff frequency-shift analysis | Count and normalized distribution records | Baseline key, fingerprint, run window | Window definition and aggregation version; retain with baseline |
| Template sequence and stage occurrence data | Recommended; expected placement and local ordering | Scope-aware aggregator | LogDiff sequence and stage-local analysis | Ordered fingerprints, transitions, or bounded sketches | Baseline key and logical scope | Sequence model version; retain with baseline |
| Drain model state | Current artifact; parser memory for compatible future parsing, not the diff database | Drain | Offline continuation and read-only failed-run parser | Versioned parser state | Parser scope plus model version | Keep while a baseline depends on it; never compare by local IDs alone |
| Baseline manifest | Current artifact; atomic description of one publishable success baseline | Baseline publisher | Resolver, failure analysis, audit | Structured manifest | Baseline ID or strict baseline key | Immutable generation, compatibility fingerprint, source-run lineage; retain while referenced |
| Source and rule versions | Current compatibility requirement, explicit record recommended | Build and policy system | Every downstream stage | Manifest fields and immutable rule bundles | Version ID and content digest | Retain at least as long as any artifact references them |
| Human template view | Current artifact; readable inspection aid | Baseline publisher | Engineers | Markdown or text | Baseline ID | Convenience copy; not authoritative for comparison |
| Normalized sample | Current debugging artifact | Preprocessing pipeline | Engineers and rule tests | Protected text sample | Run and rules version | Short retention; never include unredacted secrets |

### What LogDiff actually compares

The authoritative comparison input is not “the templates” in the abstract, the parser-state artifact, or any parser-local cluster ID. It is a version-compatible bundle containing:

- canonical template text and its stable fingerprint;
- baseline support and frequency distributions over trusted successful runs;
- logical scope and stage or node occurrence data;
- bounded sequence or transition data when available; and
- retained parameter features that were masked for clustering but remain diagnostically safe, such as duration, memory magnitude, exit code, or status class.

Exact fingerprint membership establishes that a canonical template was seen in the compatible baseline. Frequency distributions detect large changes in a known template. Scope and sequence data detect a familiar message appearing in an unusual stage or position. Parameter features detect meaningful value shifts hidden by wildcard extraction. The [failure-analysis flow](03-failure-analysis-flow.md) defines how these signals combine.

### Publishing a versioned baseline

A baseline candidate is complete only when every required artifact is present, content digests validate, redaction has passed, and the manifest names its input runs and compatibility fingerprint. Publication writes immutable artifacts first and exposes the manifest last through an atomic pointer or compare-and-set update. A consumer either sees the previous complete generation or the new complete generation; it must never observe a half-written baseline.

> **Image-generation prompt — Offline artifacts and baseline publication**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 artifact-flow diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, teal for offline learning, orange for the later LogDiff consumer, purple only in the legend, and yellow sticky notes only for key insights. At left, draw a teal pipeline “Selected success → Canonical protected events → Drain.” From Drain, fan out into five clearly separated artifact cards: “Parsed occurrences,” “Canonical template catalog + fingerprints,” “Counts + distributions,” “Scope + sequence data,” and “Drain model state.” Add a separate audit card “Source + rule versions” receiving arrows from preprocessing. Draw all comparison artifacts into a teal storage cylinder “Immutable baseline generation,” then a document “Baseline manifest” and an atomic switch icon “Publish last.” On the right, draw an orange box “LogDiff” receiving solid arrows from the manifest, template fingerprints, distributions, and scope/sequence data. Draw a dotted arrow from Drain model state to a small box “Read-only compatible parser,” then to LogDiff; label the state “parser memory, not diff identity.” Add a crossed-out local numeric ID beside a checked stable fingerprint. Add yellow sticky notes “Manifest exposes only complete generations” and “Fingerprints + statistics drive comparison.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for authoritative inputs, and dotted arrows for parser support. Use simple arrows, document icons, storage cylinders, filters, and one checksum symbol. Keep labels short and legible and include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and verify every producer-to-consumer arrow direction.

## Next step

Once a baseline is published, [03 — Failure-analysis flow](03-failure-analysis-flow.md) applies this same frozen preprocessing contract to a failed run and begins its detailed work at LogDiff. Rules shown in [examples/normalization-rules.yaml](examples/normalization-rules.yaml) are safe examples, not evidence that the repository already implements that schema.
