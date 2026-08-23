# Logsift failure-analysis flow

[Problem and architecture](01-problem-and-architecture.md) · [Canonical offline preprocessing](02-offline-learning-flow.md) · [Layer 3](04-layer-3-rag-and-code-context.md)

A failed run uses the same versioned source adapter, normalization, redaction, masking, canonicalization, and Drain configuration described in [02 — Offline learning flow](02-offline-learning-flow.md). Those stages are not repeated here. The failed-run parser is read-only with respect to success state: a failure can produce temporary templates for comparison, but it cannot teach the baseline.

## LogDiff: where failure analysis begins

LogDiff receives two immutable inputs: the failed run's parsed occurrence records and a compatible success-baseline manifest. Its job is to produce explained differences, not a single Boolean “new or known” result.

### Compatible baseline selection

The repository requires version-compatible comparison and stage-local treatment for Jules and DAG-node-local treatment for Lattice. It currently identifies baselines by project or repository, source type, and baseline version. It does not define a complete resolver algorithm. The following resolver is the recommended contract.

Start with an exact key match on tenant, repository, logical pipeline, source type, logical scope, branch class, environment, and compatibility fingerprint. The compatibility fingerprint must include the source schema and adapter, scope segmenter, normalization rules, redaction rules, masking rules, Drain tokenizer and parameters, canonical-template format, and fingerprint algorithm.

If the exact branch class has no baseline, widen only through an explicit ordered policy. A safe default is: exact release branch → compatible release class → main-class baseline for the same pipeline and environment. A pull-request or feature run may use the trusted target-branch baseline for analysis, but it does not update it. Never fall back across tenants, repositories, source types, incompatible environments, or unrelated logical pipelines.

Version differences fall into three categories:

- **Exactly compatible:** all comparison-affecting versions match. Perform the full comparison.
- **Provably migratable:** a tested, deterministic migration can re-fingerprint canonical text or transform metadata without changing meaning. Migrate into a new derived comparison view and record the migration.
- **Incompatible or unknown:** parsing, masking, source schema, or scope semantics differ without a proven migration. Refuse template-level comparison.

When Logsift refuses a comparison, it should still use non-baseline signals such as explicit failure markers, nonzero termination, failed tests, stack traces, failure-stage location, and tail proximity. The evidence pack must say `baseline_status: incompatible` or `missing`, name the failed compatibility checks, and lower its comparison confidence. It must not pretend that an unrelated baseline is better than no baseline.

### Template-to-template comparison

Comparison proceeds within the same logical scope:

1. Match canonical template fingerprints exactly. Confirm canonical text when a digest collision or algorithm migration is possible.
2. Mark fingerprints present only in the failed run as **new templates**.
3. Mark baseline fingerprints absent from the failed run as **missing templates**, weighted by whether they were expected in this stage and run shape.
4. Compare normalized frequency distributions and support across successful runs, not only absolute counts.
5. Compare stage or DAG-node placement. A globally common template can still be unusual in `deploy` or in a particular Lattice node.
6. Compare bounded local order or transition data where the source provides reliable logical ordering.
7. Detect severity changes in preserved fields—for example, `warning` becoming `error` or exit code `0` becoming `137`.
8. Examine retained parameter features that were masked for template extraction. A duration changing from seconds to minutes or memory approaching a limit can matter even when the template fingerprint is unchanged.

Missing templates are not automatically errors; a run may terminate before later success-only messages appear. Likewise, a new template is not automatically causal; version banners and harmless warnings can be novel. LogDiff produces signals and explanations that later scoring combines.

Numeric Drain cluster IDs are never compared across independently generated models. The stable identity is the fingerprint of the canonical template text and comparison scope under a named fingerprint version.

> **Image-generation prompt — Scope-aware template diff**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 comparison diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, teal for the successful baseline, orange for the failed run and differences, purple only in the legend, and yellow sticky notes only for key insights. At left, draw a teal “Compatible success baseline” column with template cards showing “fingerprint,” “count range,” “stage or node,” and “expected order.” Beside it, draw an orange “Failed run” column with matching cards. In the center, place a magnifying-glass box “LogDiff” and draw exact pairing arrows by stable fingerprint, never by numeric ID. From LogDiff, fan out to six orange result cards labelled “New,” “Missing,” “Frequency shift,” “Wrong scope,” “Order change,” and “Parameter shift.” Above both inputs, show matching version tags for source schema, rules, parser, and fingerprint; route any mismatch to a small warning box “Refuse or tested migration.” Show Jules as a stage-local inset and Lattice as a DAG-node-local inset, with the Lattice physical lines visibly interleaved but grouped logically for comparison. Add yellow sticky notes “Common globally can be rare here” and “Local parser IDs are not comparable.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for exact matches, and dotted arrows for compatibility checks. Use simple arrows, document icons, filters, and magnifying glasses. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.

### Worked comparison

This compact Jules example uses abbreviated fingerprints for readability. The same algorithm includes the source and logical scope, so a template in another stage has a different comparison identity.

**1. Successful raw lines**

```text
2026-08-23T09:20:01Z [test] worker 10.4.8.2 started request req-117
2026-08-23T09:20:02Z [test] suite payment_api passed=124 failed=0 duration=8.1s
2026-08-23T09:20:03Z [test] worker 10.4.8.2 exited code=0
```

Across three trusted successful runs, the first and third templates occur once per run and the suite-result template occurs once with `failed=0`.

**2. Failed raw lines**

```text
2026-08-23T09:31:01Z [test] worker 10.4.9.7 started request req-991
2026-08-23T09:31:42Z [test] TimeoutError waiting for payment_api after 40.0s request=req-991
2026-08-23T09:31:43Z [test] suite payment_api passed=87 failed=37 duration=41.8s
2026-08-23T09:31:44Z [test] worker 10.4.9.7 exited code=1
```

**3. Normalized, redacted, and masked versions**

```text
worker <IP_ADDRESS> started request <REQUEST_ID>
TimeoutError waiting for payment_api after <DURATION> request=<REQUEST_ID>
suite payment_api passed=<COUNT> failed=<NONZERO_COUNT> duration=<DURATION>
worker <IP_ADDRESS> exited code=1
```

The suite line's numeric features retain `passed=87` and `failed=37`. The success line becomes `suite payment_api passed=<COUNT> failed=0 duration=<DURATION>`. Zero versus nonzero remains visible because it changes meaning; changing magnitudes are typed parameters. Exit codes remain visible.

**4–6. Templates, fingerprints, and counts**

| Scope | Canonical template | Abbreviated stable fingerprint | Success distribution | Failed count |
|---|---|---|---:|---:|
| `test` | `worker <IP_ADDRESS> started request <REQUEST_ID>` | `fp-v1:0a71…` | 1 per run | 1 |
| `test` | `suite payment_api passed=<COUNT> failed=0 duration=<DURATION>` | `fp-v1:28be…` | 1 per run | 0 |
| `test` | `worker <IP_ADDRESS> exited code=0` | `fp-v1:63fd…` | 1 per run | 0 |
| `test` | `TimeoutError waiting for payment_api after <DURATION> request=<REQUEST_ID>` | `fp-v1:9c14…` | 0 | 1 |
| `test` | `suite payment_api passed=<COUNT> failed=<NONZERO_COUNT> duration=<DURATION>` | `fp-v1:b781…` | 0 | 1 |
| `test` | `worker <IP_ADDRESS> exited code=1` | `fp-v1:e2d0…` | 0 | 1 |

**7. Resulting diff**

- Exact match: request start, with normal count and normal placement.
- New: `TimeoutError`, failed suite result, and nonzero worker termination.
- Missing: successful suite summary and zero exit. Their absence is consistent with the failure path, not an independent root cause.
- Parameter change: duration increased from the successful range around eight seconds to more than forty seconds.
- Sequence: timeout appears between request start and the failed suite summary, which makes it more informative than the final exit line.

**8. Suspicious templates selected for expansion**

Logsift selects the timeout occurrence, the failed suite summary, and the nonzero exit. Expansion begins with the timeout because it is new, close to the failure, correlated with the same protected request digest, and followed by explicit failure state. The final exit is retained as confirmation even though it is likely a consequence.

For Lattice, the same comparison is performed per DAG node and attempt. A timeout in `service-test:integration` is compared with that node's baseline, not with a physically adjacent line from `service-build:compile`. Dependency metadata can raise the relevance of a parent node that completed abnormally just before the failed child began.

## Candidate pool and concurrent analyses

The repository describes a candidate pool conceptually but does not define a concurrency-safe store. This section is a recommended design.

Every analysis receives an opaque `analysis_id`. All keys and queries include tenant, repository, pipeline, run, and analysis. Stage or DAG node narrows the candidate scope further. A candidate stores a pointer to source content and immutable detection facts, not a copied block of full log text. This keeps writes small, lets several detectors point to the same occurrence, and makes later expansion reproducible.

```json
{
  "candidate_schema": "candidate/v1",
  "candidate_id": "digest-of-analysis-detector-occurrence",
  "occurrence_id": "digest-of-source-generation-and-range",
  "analysis_id": "analysis-01HX",
  "tenant_id": "tenant-example",
  "repository_id": "repo-example",
  "pipeline_id": "verify-service",
  "run_id": "run-7312",
  "source_type": "lattice",
  "logical_scope": {"kind": "dag_node", "id": "service-test:integration", "attempt": 2},
  "template_fingerprint": "fp-v1:9c14...",
  "detector": {"rule_id": "template-novelty-v1", "reason": "template_novelty"},
  "raw_ref": "restricted-object-reference",
  "source_generation": "immutable-content-digest",
  "source_ranges": [{"coordinate_space": "decoded_source_v1", "byte_start": 89121, "byte_end": 89302, "line_start": 9921, "line_end": 9923}],
  "observed_at": "2026-08-23T09:31:42Z",
  "correlation_digest": "protected-digest",
  "event_metadata_ref": "metadata-record-reference",
  "detection_features": {"novelty": 1.0, "severity": 0.9},
  "record_version": 1,
  "created_at": "2026-08-23T09:32:10Z",
  "expires_at": "2026-08-30T09:32:10Z"
}
```

Candidate records are immutable. Repeated writes use a deterministic `candidate_id` and return the existing record. Mutable analysis progress lives in a small separate control record updated through optimistic version checks or compare-and-set. Workers acquire short leases for explicit partitions, renew them while making progress, and may be replaced after lease expiry. A retry resumes from completed immutable outputs rather than deleting and rebuilding the pool.

If several detectors flag the same occurrence, they write separate immutable observations with one shared `occurrence_id`. A deterministic aggregation view unites their reasons before expansion; no worker races to edit a shared detector list.

Partial failure is recorded per stage: detection, expansion, block construction, scoring, and selection. Cancellation marks the control record, stops new leases, and asks active workers to check a cancellation token between chunks. Expiration removes derived candidates and blocks after their retention window; it does not delete a source log governed by a separate policy.

Fair scheduling should use bounded chunks and weighted round-robin queues by tenant and analysis. Per-analysis concurrency, bytes-read, candidate-count, and CPU limits keep one huge run from starving smaller failures. Storage authorization and encryption keys are tenant scoped. Every lookup supplies `tenant_id`; a candidate reference that resolves outside that tenant is rejected. Two simultaneous runs cannot mix because neither candidate IDs, partitions, leases, nor progress records omit `analysis_id` and `run_id`.

> **Image-generation prompt — Concurrent candidate-pool isolation**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 concurrency diagram on a clean white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for failure analysis, teal only for a baseline input, purple only in the legend, and yellow sticky notes only for key insights. On the left, show three failed-run request cards labelled “Analysis A — small,” “Analysis B — very large,” and “Analysis C — small,” each with a tenant, run, and analysis ID. Feed them into an orange scheduler drawn as three fair round-robin lanes with bounded work chunks. In the center, show worker cards acquiring short lease tags and writing immutable candidate-reference cards into three visibly separated pool partitions. Each partition key must list “tenant + repository + pipeline + run + scope + analysis_id.” Show a separate small control record with “version” and a compare-and-set icon. On the right, show “Expansion,” “Blocks,” and “Selection” consuming only their matching partition. Draw retry arrows back to unfinished chunks, a cancellation stop sign, and a clock arrow to “TTL cleanup.” Add a crossed-out arrow between Analysis A and Analysis B partitions. Add yellow sticky notes “References, not copied full logs,” “Idempotent candidate IDs,” and “One huge run cannot starve the queue.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for work flow, and dotted arrows for retries or leases. Use simple arrows, document icons, filters, storage cylinders, and lease tags. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, partition separation, and arrow direction.

## Reading very large logs

Logsift does not need to load a complete log into memory. The repository recommends streaming failed-log processing and stable line provenance but does not specify the storage reader or index format, and it does not prove whether a current implementation already follows that memory discipline. The following is the recommended implementation.

During ingestion, a streaming wrapper reads bounded chunks, assigns each physical source line a one-based line number, and records its byte start and end before normalization. It also emits a sidecar index with sparse line checkpoints, timestamp buckets, stage or DAG-node ranges, template-occurrence postings, and protected correlation digests. A Lattice node can have several noncontiguous ranges. The index is immutable and versioned with the source object's content digest.

Every range declares its coordinate space. For an uncompressed object, `source_object_bytes_v1` can refer directly to immutable object bytes. For compressed input, `decoded_source_v1` refers to the deterministic decoded byte stream and the sidecar entry also records the seekable compressed chunk or access point needed to recover it. Mixing these coordinate systems would make expansion irreproducible, so readers reject an unknown index version.

For an uncompressed object, expansion uses byte-range reads to fetch only the indexed region plus a bounded overlap. For a compressed object whose format does not support useful random access, the ingestion path either creates seekable compressed chunks or produces an access-controlled decompressed spool and sidecar index. Logsift should not repeatedly decompress a multi-gigabyte object from the beginning for every candidate.

Chunk boundaries need overlap because a line, UTF-8 sequence, or multiline record can cross them. The reader carries an incomplete trailing fragment into the next chunk and deduplicates overlap by byte range. A multiline assembler recognizes stack traces, compiler diagnostics, test failures, shell continuations, and source-specific event boundaries while retaining every constituent physical range.

Backpressure propagates from the candidate writer to the reader: when downstream queues reach their byte or record limit, reads pause. Each worker has explicit limits for input buffer, decoded text, active multiline assemblies, candidate count, and expansion bytes. Cancellation is checked before every range request and between decoded chunks.

Truncated or partially uploaded logs are marked with `source_complete: false`, last confirmed byte, and last confirmed line. Index entries never point past that boundary. A partially uploaded object can be re-indexed as a new immutable source generation; existing evidence continues to identify the generation it used. The evidence pack reports truncation so absence is never misinterpreted as a missing template.

In the recommended contract, Logsift captures line and byte provenance at ingestion, before cleanup, then carries those fields through normalized occurrences, candidates, expansions, and evidence blocks. Content expansion seeks back to the source by those pointers and does not keep the whole log in memory. The repository requires original provenance conceptually but does not define a deployed line-number capture implementation, so that current detail remains unknown.

> **Image-generation prompt — Indexed large-log reading**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 storage-and-reading diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for failure analysis, teal for the ingestion-time index builder, purple only in the legend, and yellow sticky notes only for key insights. At left, draw a very tall rolled document labelled “Very large raw log” feeding through a teal “Streaming ingestion” box that assigns “1-based line + byte range.” Fan out into a locked storage cylinder “Immutable raw object” and a smaller cylinder “Sidecar indexes.” On the index cylinder, show short tabs: “sparse lines,” “timestamps,” “stage or node,” “template postings,” and “correlation digest.” In the center, show an orange candidate-reference card with exact line and byte ranges entering a magnifying-glass box “Seek relevant region.” Draw a range-read arrow to just one highlighted slice of the raw-object cylinder, not the whole object. Show two bounded chunks with a small overlap band and a multiline stack trace crossing the boundary. At right, draw “Bounded decoder,” “Backpressure queue,” and “Expanded fragments with provenance.” Add a compressed-log branch to “Seekable chunks or restricted spool,” and a partial-log warning flag “last confirmed byte.” Add yellow sticky notes “Never load the whole log,” “Overlap protects boundaries,” and “Cancellation between chunks.” Include a compact legend for teal offline indexing, orange failure analysis, purple retrieval/remediation, solid arrows for data flow, and dotted arrows for index lookup. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and all lookup and data-flow arrow directions.

## Content expansion

A template tells Logsift what kind of event occurred; expansion recovers enough surrounding structure to explain it. Starting from each suspicious occurrence, Logsift can combine several bounded expansion modes:

- a configurable before-and-after physical or logical line window;
- the containing stage, task, step, or DAG-node attempt;
- a timestamp window when source clocks are trustworthy;
- events sharing a protected request or correlation digest;
- complete stack-trace, exception, test-failure, compiler-diagnostic, or shell-continuation boundaries;
- the same process, worker, or container identity;
- nearby state transitions such as start, retry, timeout, cancel, and exit; and
- parent, child, or dependency relationships when the source supplies them.

The repository does not define final window sizes. A reasonable V1 starting point is four logical lines before and six after, extended to complete a recognized structured unit and capped by byte, line, and time limits. Rules should tune this per source and severity.

For Jules, physical neighbors usually agree with stage-local neighbors, but expansion stops at the stage boundary unless a rule explicitly asks for the transition into the next stage. For Lattice, primary expansion follows node-local sequence and attempt even when source byte ranges are noncontiguous. Physical neighbors can be included as separately labelled context when structure confidence is low, but they must not be presented as belonging to the same node. Dependency expansion adds only bounded parent or child summaries unless a causal signal justifies full fragments.

The candidate pool retains the exact raw-object generation, byte and line ranges, logical scope, event metadata reference, correlation digest, and rules version. Re-running expansion with the same source generation and rules therefore produces the same fragments.

## From expanded fragments to log blocks

An evidence block is the unit later deduplicated, scored, selected, and cited. Block construction begins at a suspicious occurrence, expands to recognized structural boundaries, and then merges overlapping windows in the same logical scope.

A block normally ends at a stage or node boundary, a completed stack trace, a completed test diagnostic, an explicit task transition, a time gap, or a configured size limit. Multiline exceptions and stack traces remain intact when possible. Repeated retry loops are represented by a summary block plus a small number of exact source fragments. Interleaved Lattice output is separated into node-local fragments; original physical ordering remains in provenance.

Oversized blocks split only at safe boundaries such as exception chains, retry iterations, subprocess transitions, or line boundaries as a last resort. Each child keeps a parent block ID and part number. A summary block can point to several source fragments without copying them. Ordering is represented both as the block's logical sequence and the original physical ranges.

```json
{
  "block_schema": "log-block/v1",
  "block_id": "block-9c14",
  "analysis_id": "analysis-01HX",
  "tenant_id": "tenant-example",
  "repository_id": "repo-example",
  "pipeline_id": "verify-service",
  "run_id": "run-7312",
  "source_type": "lattice",
  "logical_scope": {"kind": "dag_node", "id": "service-test:integration", "attempt": 2},
  "block_kind": "stack_trace",
  "parent_block_id": null,
  "part": {"number": 1, "total": 1},
  "source_fragments": [
    {"raw_ref": "restricted-object-reference", "source_generation": "immutable-content-digest", "coordinate_space": "decoded_source_v1", "line_start": 9921, "line_end": 9938, "byte_start": 89121, "byte_end": 90442}
  ],
  "logical_order": {"start": 417, "end": 434},
  "template_fingerprints": ["fp-v1:9c14..."],
  "protected_correlation_digests": ["protected-digest"],
  "content": "redacted expanded text",
  "content_hash": "exact-content-digest",
  "canonical_hash": "canonical-content-digest",
  "construction_rule_version": "blocks-v1",
  "truncation": {"truncated": false, "reason": null},
  "source_complete": true
}
```

> **Image-generation prompt — Content expansion and log-block construction**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 construction diagram on a clean white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for failure analysis, teal only for a small baseline fingerprint input, purple only in the legend, and yellow sticky notes only for key insights. On the left, draw an orange suspicious-template occurrence card containing “fingerprint,” “line + byte range,” “stage or node,” and “correlation digest.” Around it, draw six labelled expansion lenses: “before + after lines,” “stage or task,” “time window,” “same correlation,” “stack boundary,” and “process or dependency.” In the center, show two source examples: a Jules contiguous stage strip and a Lattice node whose three logical fragments come from noncontiguous physical ranges. Draw their selected fragments into a “Merge overlaps + preserve order” box. On the right, show three evidence-block cards: “Complete stack trace,” “Retry summary + examples,” and “Split oversized block,” with parent-child arrows and exact provenance tags. Add a hard boundary marker at stage or node edges and a maximum-size ruler. Add yellow sticky notes “Expand structure, not arbitrary volume” and “Logical order plus physical provenance.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for content, and dotted arrows for references. Use simple arrows, document icons, filters, magnifying glasses, and short rulers. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and every expansion, merge, and parent-child arrow direction.

## Deduplication

Deduplication reduces waste without erasing meaningful provenance. Logsift should apply it in levels:

1. **Exact content hash** collapses byte-equivalent redacted blocks.
2. **Canonicalized content hash** collapses blocks that differ only in approved dynamic values.
3. **Template-sequence similarity** identifies blocks containing nearly the same ordered template fingerprints.
4. **Retry-loop compression** replaces many structurally identical attempts with a summary and representative first, last, and anomalous iterations.
5. **Near-duplicate similarity** catches blocks with small nonsemantic textual differences after exact methods.
6. **Cross-stage check** prevents automatic collapse across stages or DAG nodes. The same text can have different meaning or provenance in two scopes and may need to remain as separate evidence.

When duplicates collapse, the representative retains occurrence count, first and last time, first and last physical range, all logical scopes, attempts, source-object generations, detector reasons, parameter ranges, and a bounded set of representative examples. The selection stage sees both the compressed content cost and the fact that the event repeated. Repetition can raise confidence up to a point, then receive a penalty so a loop does not consume the evidence budget.

## Scoring and ranking

The repository proposes deterministic, configurable scoring but does not define a deployed normalized formula. The model below is the recommended V1 contract. Every input variable is normalized to the closed interval `[0, 1]`, where `0` means no evidence for that factor and `1` means the strongest supported value. Let:

- `N` = template novelty within the compatible scope;
- `V` = severity, including explicit failure language and termination status;
- `F` = magnitude of the frequency shift from the success distribution;
- `P` = proximity to the first confirmed failure point in logical distance;
- `G` = relevance of the stage or DAG node to the failed outcome;
- `T` = temporal proximity when trustworthy timestamps exist;
- `B` = baseline rarity in this scope;
- `K` = stack-trace or structured-diagnostic presence;
- `C` = correlation with a known failing request, process, or dependency;
- `Q` = source and structure confidence;
- `R` = excessive repetition after useful occurrence evidence is captured; and
- `D` = near-duplicate overlap with already represented evidence.

The normalization is part of the rule version. A practical default maps the raw observations as follows:

| Factor | Recommended normalization to `[0, 1]` |
|---|---|
| `N` | `1` for a fingerprint absent from the compatible scope, `0` for an exact normally placed match, with intermediate values reserved for tested migrations or partially matching structure. |
| `V` | A configured severity map, with routine information near `0`, warnings below explicit failures, and fatal termination at `1`. |
| `F` | Let `f` be the failed-run count, `μ` the baseline mean count, `σ` its standard deviation, and `ε` a small smoothing count. Compute ratio `r=(f+ε)/(μ+ε)` and standardized distance `z=|f−μ|/max(σ,σ_min)`. Then `F=clamp(max(|ln r|/ln r_max, z/z_max),0,1)`. `r_max` and `z_max` are the ratio and standardized-distance thresholds that produce maximum shift; `σ_min` prevents a zero-variance baseline from causing division by zero. |
| `P` | For logical distance `d` from the first confirmed failure and half-value distance `d₅₀`, use `P=1/(1+d/d₅₀)`. |
| `G` | `1` in the confirmed failed scope, a configured fractional value for a directly relevant parent or prerequisite, and `0` for an unrelated scope. |
| `T` | For absolute time distance `Δt` and decay constant `τ`, use `T=exp(−Δt/τ)` when clocks are trusted; otherwise `0`. |
| `B` | `1−support`, where `support` is the fraction of compatible successful runs containing this fingerprint in this scope. |
| `K` | `1` for a complete recognized stack trace or structured diagnostic, a configured fraction for an incomplete one, otherwise `0`. |
| `C` | The strongest verified match confidence among protected request, process, container, and dependency relationships. |
| `Q` | The adapter's minimum confidence across source identity, scope segmentation, ordering, and source completeness. |
| `R` | The fraction of occurrences beyond the configured representative limit, capped at `1`. |
| `D` | Maximum near-duplicate similarity to evidence already represented in the selection, capped at `1`. |

`ε`, `σ_min`, `r_max`, `z_max`, `d₅₀`, and `τ` are versioned thresholds. They must be calibrated per source and scope; changing them changes the score-policy version.

The default normalized score is:

```text
S = 100 × clamp(
      0.20N + 0.20V + 0.10F + 0.08P + 0.12G +
      0.05T + 0.07B + 0.08K + 0.05C + 0.05Q −
      0.08R − 0.07D,
      0, 1)
```

The positive weights sum to `1.00`, so the pre-penalty score is naturally normalized. `clamp(x, 0, 1)` limits `x` to that range, and multiplication by 100 produces a readable score from 0 to 100. If a timestamp or correlation field is unavailable, its value is zero and `Q` reflects the missing structure; an implementation may renormalize only under an explicitly versioned policy, never silently.

Rules can force inclusion for safety-critical evidence, exclude known noise, or apply a bounded boost or penalty. A boost is added after the base formula but before clamping and must record its rule ID and reason. An override never removes provenance or the unmodified base score.

### Numeric example

| Candidate block | Positive weighted sum | Penalties | Final score |
|---|---:|---:|---:|
| A: new correlated timeout with stack trace | `0.887` | `0.000` | `88.7` |
| B: repeated retry message with large frequency shift | `0.550` | `0.080R + 0.070D = 0.136` | `41.4` |
| C: new nonzero terminal exit | `0.736` | `0.070D = 0.035` | `70.1` |

For A, the inputs are `N=1.0, V=0.9, F=0.3, P=0.9, G=1.0, T=0.9, B=1.0, K=1.0, C=0.8, Q=1.0, R=0, D=0`. For B they are `N=0.2, V=0.4, F=1.0, P=0.8, G=1.0, T=0.8, B=0.3, K=0, C=0.7, Q=1.0, R=1.0, D=0.8`; high frequency is offset by repetition and duplicate penalties. For C they are `N=0.8, V=1.0, F=0.1, P=1.0, G=1.0, T=1.0, B=0.8, K=0, C=0.2, Q=1.0, R=0, D=0.5`; explicit termination and failure proximity are strong, but duplicate overlap recognizes that it partly repeats the timeout's outcome.

This illustrates why the highest-frequency message is not necessarily the best evidence. A retry line can appear hundreds of times because the system is stuck; one earlier timeout or configuration rejection can explain the entire loop.

Ties resolve in this order: mandatory rule inclusion, stronger causal or structured-diagnostic evidence, higher source confidence, closer logical proximity, earlier physical occurrence, then lexicographically smaller `block_id` for deterministic output. Evidence diversity is applied during selection, not disguised as an intrinsic property of one block. Every block stores its variables, weights, penalties, overrides, base score, final score, and a short human-readable explanation.

## Token-budget selection

The repository describes bounded evidence selection but does not define a deployed optimizer or final capacity profile. The recommended design treats token selection as a constrained optimization problem. Let total context capacity be `L`. Reserve `I` for instructions, `M` for failure metadata and template diff, `R_c` for retrieved knowledge and code, `O` for the model response, and `S_f` for a safety margin. The available log-evidence budget is:

```text
E = L − I − M − R_c − O − S_f
```

All quantities are tokens estimated with the tokenizer of the target model. After content expansion and deduplication, each candidate block has a token cost, score, stage, category, and structural-integrity constraints. Selection maximizes evidence value subject to `E`, per-stage caps, per-category caps, mandatory minimum representation for critical stages, and a near-duplicate limit.

A useful greedy approximation first includes mandatory blocks, then repeatedly chooses the best marginal value per token after diversity and redundancy adjustments. It should not choose ten copies of the same timeout merely because each scored well. Stack traces and compiler or test diagnostics remain structurally intact. Truncation occurs only at recognized safe boundaries; when an indivisible block cannot fit, Logsift emits a short deterministic summary plus a reference to the full block.

### Worked budget

Assume:

| Capacity item | Tokens |
|---|---:|
| Total context `L` | 32,000 |
| Instructions `I` | 3,000 |
| Failure metadata and diff `M` | 2,000 |
| Retrieved knowledge and code `R_c` | 6,000 |
| Model response `O` | 5,000 |
| Safety margin `S_f` | 2,000 |
| **Available log evidence `E`** | **14,000** |

After deduplication and expansion, suppose the pool is:

| Block | Stage/category | Tokens | Score | Decision |
|---|---|---:|---:|---|
| A | Test timeout stack | 4,000 | 88.7 | Select intact. |
| A2 | Test timeout near-duplicate | 3,600 | 82.0 | Omit as redundant with A. |
| C | Test terminal exit | 350 | 70.1 | Select as mandatory outcome evidence. |
| D | Deploy configuration rejection | 1,600 | 65.0 | Select for category and stage diversity. |
| E | Build dependency warning | 1,400 | 58.0 | Select because it is the only earlier-stage dependency signal. |
| B | Test retry-loop summary | 2,000 | 41.4 | Select compressed, not all iterations. |
| F | Test routine cleanup | 2,500 | 32.0 | Omit; low value and test stage already represented. |

The selected set costs 9,350 tokens. A lower-scoring block such as E is included because it covers an earlier stage and a different evidence category; A2 is excluded despite its higher score because it adds almost no new information. The remaining headroom accommodates exact provenance, block explanations, and tokenizer estimation error. The budget is recalculated whenever expansion changes a block or deduplication collapses occurrences.

### Evidence-pack structure

The final evidence pack contains:

- a failure summary and confidence statement;
- tenant-safe pipeline metadata, source type, run, branch class, commit, stages or DAG nodes, and outcome;
- baseline ID, compatibility result, rule and parser versions, and warnings;
- template-diff entries with fingerprints, canonical text, counts, distributions, scopes, sequence signals, and parameter shifts;
- ranked evidence blocks with score explanations and exact source provenance;
- occurrence, deduplication, omission, and coverage statistics;
- truncation and partial-source notices; and
- access-controlled references to the full source logs and immutable source generations.

The pack treats log text as untrusted evidence, never as instructions. Selected blocks have stable citation IDs so a later explanation can point back to exact line and byte ranges.

> **Image-generation prompt — Ranking and token-budget evidence selection**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 selection diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for failure analysis, teal only for a small baseline-signal input, purple for a reserved retrieval-budget segment, and yellow sticky notes only for key insights. At left, show six orange evidence-block cards with short labels, token costs, scores, stages, and categories; include two near-duplicate timeout cards, one stack trace, one terminal exit, one configuration rejection, and one earlier dependency warning. Draw them through “Deduplicate” and a transparent scoring balance labelled “Novelty, severity, shift, proximity, scope, trace, correlation, confidence, repetition penalty.” In the center, draw a horizontal context-budget bar with exact labelled segments “Instructions,” “Metadata + diff,” “Log evidence,” “Retrieval context,” “Response,” and “Safety.” From candidates, draw arrows into a “Diversity-aware selector” with stage and category quota filters. On the right, show a document “Evidence pack” containing “Failure summary,” “Template diff,” “Ranked blocks,” “Counts,” “Exact provenance,” and “Truncation notices.” Show a high-scoring near-duplicate rejected and a lower-scoring earlier-stage block selected, with a yellow sticky note “Marginal information matters.” Add another yellow sticky note “Keep stack traces intact.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for selected content, and crossed dotted arrows for omitted redundancy. Use simple arrows, document icons, filters, magnifying glasses, and a ruler-like token bar. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, budget arithmetic labels, and every selection arrow direction.

## Failure-analysis rules

[examples/failure-analysis-rules.yaml](examples/failure-analysis-rules.yaml) provides a valid, commented example for comparison thresholds, source-specific expansion, block limits, normalized scoring, deduplication, concurrency controls, and token reservations. It is a proposed configuration contract because the repository does not currently define this schema.

## Next step

The evidence pack is complete without Layer 3; it can already support a grounded failure explanation. When knowledge and code retrieval are enabled, [04 — Layer 3](04-layer-3-rag-and-code-context.md) treats this pack as the retrieval query source and keeps a separate retrieval token budget.
