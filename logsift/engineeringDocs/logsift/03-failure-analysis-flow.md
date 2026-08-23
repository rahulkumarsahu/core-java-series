# Logsift failure-analysis flow

[Architecture](01-problem-and-architecture.md) · [Offline learning](02-offline-learning-flow.md) · [RAG and code context](04-layer-3-rag-and-code-context.md)

A failed run uses the same source detection, normalization, redaction, masking, and Drain versions described in [02 — Offline learning flow](02-offline-learning-flow.md). This document begins after failed templates have been created.

The flow is:

```text
Failed templates
  → LogDiff
  → candidate pool
  → indexed content expansion
  → log blocks
  → deduplication
  → scoring and ranking
  → token-budget selection
  → evidence pack
```

## 1. LogDiff

LogDiff answers a simple question:

> What is different between this failed run and normal successful runs from the same baseline?

### Find the baseline

The failed event supplies the same four values used during learning:

```text
seal_id + project_id + repo_id + source_type
```

Example:

```text
seal101/payments/payment-api/JULES
```

Logsift resolves the latest complete compatible version below that key.

Before comparing, it checks these versions:

- source detection and adapter;
- source event schema;
- normalization, redaction, and masking rules;
- Drain configuration;
- template fingerprint algorithm;
- stage or DAG-node segmentation.

If these versions match, comparison continues. If a tested migration exists, Logsift can create a temporary compatible view. Otherwise it refuses template comparison and uses only direct signals such as errors, failed tests, stack traces, nonzero exits, and the failed stage.

It must never fall back to another seal, project, repository, or source type.

### Compare inside the correct scope

For Jules, compare a failed stage with the same stage in the baseline.

For Lattice, compare a failed DAG node and attempt with the same DAG node in the baseline. Do not compare it with all physical lines from all nodes.

### What LogDiff checks

| Check | Meaning |
|---|---|
| Exact fingerprint match | The same canonical template exists in successful runs. |
| New template | The failed run contains a template not seen in the compatible baseline scope. |
| Missing template | A normally expected template did not occur. This may simply mean the run stopped early. |
| Frequency shift | A known template occurred much more or less often than normal. |
| Scope change | A common template appeared in an unusual stage or DAG node. |
| Order change | Templates appeared in an unusual local order. |
| Severity change | A preserved value changed from success to warning or error behavior. |
| Parameter shift | A masked value such as duration or memory moved far outside the normal range. |

A template match means “less surprising.” It does not mean “delete this line.” A known error can still be the cause of the current failure.

Numeric parser IDs are not compared across runs. LogDiff uses:

```text
scope + canonical template text + stable fingerprint
```

### Worked example

Successful `test` stage:

```text
09:20:01 worker 10.4.8.2 started request req-117
09:20:02 suite payment_api passed=124 failed=0 duration=8.1s
09:20:03 worker 10.4.8.2 exited code=0
```

Failed `test` stage:

```text
09:31:01 worker 10.4.9.7 started request req-991
09:31:42 TimeoutError waiting for payment_api after 40.0s request=req-991
09:31:43 suite payment_api passed=87 failed=37 duration=41.8s
09:31:44 worker 10.4.9.7 exited code=1
```

After preprocessing:

```text
worker <IP_ADDRESS> started request <REQUEST_ID>
TimeoutError waiting for payment_api after <DURATION> request=<REQUEST_ID>
suite payment_api passed=<COUNT> failed=<NONZERO_COUNT> duration=<DURATION>
worker <IP_ADDRESS> exited code=1
```

LogDiff result:

| Template | Baseline | Failed run | Result |
|---|---:|---:|---|
| `worker <IP_ADDRESS> started request <REQUEST_ID>` | 1 per run | 1 | Normal match |
| `TimeoutError waiting for payment_api after <DURATION>` | 0 | 1 | New and high severity |
| `suite payment_api ... failed=0` | 1 per run | 0 | Missing because the run failed |
| `suite payment_api ... failed=<NONZERO_COUNT>` | 0 | 1 | New failure state |
| `worker <IP_ADDRESS> exited code=0` | 1 per run | 0 | Expected success ending is missing |
| `worker <IP_ADDRESS> exited code=1` | 0 | 1 | New terminal failure |

The duration feature also changed from about eight seconds to more than forty seconds. Logsift selects the timeout, failed suite summary, and nonzero exit as candidate occurrences.

> **Image-generation prompt — LogDiff from baseline to candidates**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn styling. Use teal for the success baseline, orange for the failed run and candidates, purple only in the legend, dark navy headings, and two yellow sticky notes. At left, show the four-part key “seal_id + project_id + repo_id + source_type” resolving a compatible baseline. In the center, show a teal baseline template table and an orange failed template table. Connect matching rows by stable fingerprint, never by numeric ID. Pass them through a magnifying-glass box titled “LogDiff.” On the right, show simple result cards “New,” “Missing,” “Frequency shift,” “Wrong scope,” “Order change,” and “Parameter shift,” then three candidate line-reference cards. Include small insets: “Jules — compare stage” and “Lattice — compare DAG node + attempt.” Add notes “Match means less surprising, not delete” and “Refuse incompatible versions.” Use simple arrows, document icons, filters, storage cylinders, and magnifying glasses. Keep generous spacing, short labels, and a clear left-to-right flow. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 2. How suspicious lines enter the candidate pool

Every parsed occurrence keeps its original physical line number and byte range. LogDiff can compare unique templates first for speed, then copy the result back to every occurrence of that template.

A line becomes a candidate when at least one useful detector fires:

- new template;
- strong frequency shift;
- explicit error or failure text;
- failed test or exception;
- stack trace;
- nonzero exit or termination;
- unusual stage or DAG-node placement;
- close to the first confirmed failure;
- same protected request, process, or dependency as the failure;
- abnormal duration, memory, count, or status value.

The candidate pool should favor recall. It is acceptable to keep some extra candidates because later stages remove noise.

### Candidate record

```json
{
  "candidate_id": "candidate-9c14",
  "analysis_id": "analysis-01HX",
  "seal_id": "seal101",
  "project_id": "payments",
  "repo_id": "payment-api",
  "run_id": "run-7312",
  "source_type": "LATTICE",
  "scope": {"kind": "dag_node", "name": "test:integration", "attempt": 2},
  "template_fingerprint": "fp-v1:9c14...",
  "reason": "new_timeout_template",
  "log_ref": "restricted-log-reference",
  "line_start": 9921,
  "line_end": 9923,
  "byte_start": 89121,
  "byte_end": 89302,
  "correlation_digest": "protected-digest"
}
```

The record stores a reference, not a copy of the full log text.

### Keep concurrent analyses separate

Every candidate key includes `seal_id`, `run_id`, and `analysis_id`. Candidate records are immutable and have deterministic IDs. Repeated detector work writes the same record instead of creating copies.

Workers take short leases on small work partitions. A failed worker can retry from completed immutable records. Cancellation stops new leases. Expired analysis data is cleaned up after its retention time. Per-seal and per-analysis limits prevent one huge run from blocking smaller runs.

This candidate-store design is recommended; the repository does not define the implementation yet.

## 3. Read large logs without loading the whole file

The recommended design processes logs as bounded chunks.

During ingestion, Logsift records:

- one-based line numbers;
- byte start and end;
- timestamp when available;
- Jules stage or Lattice DAG node and attempt;
- template fingerprint;
- protected correlation digest;
- immutable log-object version.

It writes a sidecar index with sparse line checkpoints and lookup entries for stage, node, timestamp, template, and correlation.

Content expansion then performs a range read for only the needed region. For compressed logs, use seekable compressed chunks or a restricted decompressed spool with its own index. Do not decompress the whole object from the start for every candidate.

Chunk boundaries overlap slightly so a line or stack trace is not cut incorrectly. Backpressure pauses reading when downstream queues are full. Memory, candidate, and expanded-byte limits are explicit. Cancellation is checked between chunks.

If a log is truncated, every output records `source_complete: false` and the last confirmed line and byte. Missing content is never treated as proof that a template was absent.

The repository asks for streaming and original provenance but does not define a deployed index format. The sidecar design is recommended.

> **Image-generation prompt — Candidate pool and indexed large-log reading**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 technical diagram on a clean warm off-white notebook page with a faint square grid. Use orange for failure analysis, teal for ingestion-time indexing, purple only in the legend, dark navy headings, and two yellow sticky notes. At left, show a very large log entering “Chunked reader,” which assigns “1-based line + byte range.” Split into a locked raw-log cylinder and a smaller sidecar-index cylinder with labels “line,” “stage or node,” “timestamp,” “template,” and “correlation.” In the center, show three simultaneous analysis lanes with separate `analysis_id` values writing immutable candidate-reference cards into isolated partitions. Add short worker leases, retry arrows, cancellation, and fair scheduling. At right, show one candidate using a magnifying glass to perform an “indexed range read” of only one highlighted log region. Add notes “References, not copied logs” and “Never load the complete log.” Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Keep generous spacing, short readable labels, and a clear left-to-right flow. Avoid external logos, tiny paragraphs, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 4. Content expansion

A candidate line is often too small to explain a failure. Content expansion retrieves nearby and related lines.

Logsift can expand by:

- a small before-and-after line window;
- the current stage, task, or DAG node;
- a time window;
- matching request or correlation digest;
- complete stack-trace or exception boundaries;
- the same process, worker, or container;
- nearby state changes such as start, retry, timeout, cancel, and exit;
- parent or child dependency when Lattice provides the relationship.

The repository does not define final window sizes. A simple starting rule is four logical lines before and six after, then extend only to finish a stack trace or other known structure.

For Jules, expansion normally stays in the same stage and physical neighbors are usually useful.

For Lattice, expansion follows the same DAG node and attempt first. Its useful lines may come from several noncontiguous byte ranges. Physical neighbors from other nodes are included only as separately labelled context.

## 5. Build log blocks

A log block is a small group of lines that tells one failure story.

Example:

```text
request started
dependency call started
TimeoutError after 40s
retry budget exhausted
worker exited code=1
```

Block construction follows these rules:

- start from one or more overlapping candidates;
- keep lines in logical order;
- stop at a stage or DAG-node boundary unless a dependency rule says otherwise;
- keep a stack trace, exception chain, failed test, or compiler diagnostic together;
- compress a repeated retry loop but keep first, last, and unusual attempts;
- apply maximum line, byte, and token limits;
- split an oversized block only at a safe boundary;
- keep every original line and byte range;
- link split child blocks to their parent summary.

A compact block record looks like this:

```json
{
  "block_id": "block-9c14",
  "analysis_id": "analysis-01HX",
  "seal_id": "seal101",
  "run_id": "run-7312",
  "scope": {"kind": "dag_node", "name": "test:integration", "attempt": 2},
  "source_ranges": [
    {"log_ref": "restricted-log-reference", "line_start": 9921, "line_end": 9938, "byte_start": 89121, "byte_end": 90442}
  ],
  "template_fingerprints": ["fp-v1:9c14..."],
  "content": "redacted expanded text",
  "parent_block_id": null,
  "truncated": false
}
```

## 6. Deduplicate blocks

Deduplication runs from cheapest to more expensive checks.

| Check | What it removes | What must remain |
|---|---|---|
| Exact content hash | Identical blocks | Count and all source locations |
| Canonical content hash | Blocks that differ only in masked values | Parameter ranges and examples |
| Template-sequence match | Blocks with the same ordered message pattern | First and last occurrence |
| Retry-loop compression | Many repeated attempts | Total count and representative attempts |
| Near-duplicate match | Small wording differences | Best representative and similarity reason |

Do not automatically merge the same text across different Jules stages or Lattice nodes. The scope may change its meaning.

> **Image-generation prompt — From candidate lines to deduplicated log blocks**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 diagram on a clean warm off-white grid notebook page with polished hand-drawn styling. Use orange for failure analysis, teal only for a small baseline reference, purple only in the legend, dark navy headings, and two yellow sticky notes. At left, show three candidate cards with exact line and byte pointers. Around them, show small expansion lenses “line window,” “same stage or node,” “correlation,” and “stack boundary.” In the center, show a Jules contiguous region and a Lattice node built from noncontiguous physical fragments. Merge overlapping regions into log blocks. On the right, pass blocks through “Exact hash → Canonical hash → Template sequence → Retry compression → Near duplicate.” Show one final block with occurrence count, first and last location, stages or nodes, and representative examples. Add notes “Expand structure, not arbitrary volume” and “Keep provenance when collapsing copies.” Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Keep generous spacing and a clear left-to-right flow. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 7. Score and rank evidence

Scoring should be simple enough to explain. Every input is between `0` and `1`.

| Variable | Meaning |
|---|---|
| `N` | Template novelty |
| `S` | Failure severity |
| `F` | Frequency shift |
| `P` | Proximity to the first confirmed failure |
| `G` | Relevance of the stage or DAG node |
| `K` | Complete stack trace or structured diagnostic |
| `C` | Correlation with the failing request, process, or dependency |
| `Q` | Confidence in source, scope, and log completeness |
| `R` | Excessive repetition |
| `D` | Duplicate overlap with evidence already represented |

Recommended V1 score:

```text
score = 100 × clamp(
  0.22N + 0.22S + 0.12F + 0.12P +
  0.10G + 0.08K + 0.08C + 0.06Q −
  0.10R − 0.10D,
  0, 1)
```

`clamp` keeps the value between 0 and 1 before it is multiplied by 100. The positive weights add to 1. Rules can force important evidence, such as a terminal nonzero exit, or apply a small recorded boost or penalty.

Example scores:

| Block | Main signals | Score |
|---|---|---:|
| New correlated timeout with full stack trace | High novelty, severity, proximity, scope, stack, and correlation | 86.6 |
| Nonzero terminal exit | High severity and proximity, but partly duplicates the timeout outcome | 65.4 |
| Repeated retry line | High frequency, but strong repetition and duplicate penalties | 28.4 |

This is why the most frequent line is not always the best evidence. A retry may repeat hundreds of times, while one earlier timeout explains the loop.

Every selected block stores its factor values, weights, penalties, rule changes, final score, and a short explanation.

## 8. Fit evidence into the token budget

The model context has several users. Logsift must reserve space before selecting log blocks.

```text
log evidence budget = total context
                    − instructions
                    − failure metadata and diff
                    − retrieved knowledge and code
                    − model response
                    − safety margin
```

Example:

| Item | Tokens |
|---|---:|
| Total context | 32,000 |
| Instructions | 3,000 |
| Failure metadata and diff | 2,000 |
| Retrieved knowledge and code | 6,000 |
| Model response | 5,000 |
| Safety margin | 2,000 |
| **Available log evidence** | **14,000** |

After expansion and deduplication, estimate block cost with the target model tokenizer. Select high-value blocks while enforcing:

- minimum evidence from the failed scope;
- a limit per stage and evidence category;
- no large set of near-duplicates;
- complete stack traces when possible;
- safe truncation boundaries;
- a short summary plus source reference when an important block cannot fit.

A lower-scoring build or configuration block may be selected over another high-scoring test timeout if it adds a new stage or evidence type.

> **Image-generation prompt — Scoring, ranking, and token selection**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 diagram on a clean warm off-white grid notebook page with hand-drawn technical styling. Use orange for failure analysis, teal only for small baseline signals, purple for the retrieval-budget segment, dark navy headings, and two yellow sticky notes. At left, show six log-block cards with stage, category, score, and token cost. Pass them through a simple scoring balance labelled “novelty, severity, shift, proximity, scope, stack, correlation, confidence, repetition, duplicate.” In the center, show a segmented 32,000-token bar with “instructions 3,000,” “metadata + diff 2,000,” “retrieval 6,000,” “response 5,000,” “safety 2,000,” and “log evidence 14,000.” Then show a diversity filter selecting a full stack trace, a terminal exit, and a lower-scoring earlier-stage block while rejecting a near-duplicate. At right, show the final evidence-pack document. Add notes “Highest frequency is not highest value” and “Keep important structures intact.” Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Keep generous spacing and a clear left-to-right flow. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arithmetic labels.

## 9. Evidence pack

The evidence pack contains only what the next layer needs:

- failure summary;
- four-part baseline key and selected baseline version;
- pipeline metadata, branch, commit, source type, and failed scopes;
- template diff with fingerprints, counts, and parameter shifts;
- ranked log blocks with score explanations;
- exact source line and byte ranges;
- deduplication and occurrence counts;
- missing-baseline, incompatible-version, partial-log, and truncation warnings;
- restricted references to the full source logs.

Log text is treated as untrusted data, never as instructions. Every block has a citation ID so the final explanation can point back to exact evidence.

See [failure-analysis-rules.yaml](examples/failure-analysis-rules.yaml) for a commented configuration example.

## Next step

[04 — RAG and code context](04-layer-3-rag-and-code-context.md) explains how the evidence pack is used to find relevant runbooks, earlier incidents, configuration, ownership, and commit-matched code.
