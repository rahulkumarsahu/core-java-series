The main point is: **Logsift should not keep complete segments or complete logs in memory.** It should keep the raw log in persistent storage, build a small searchable index beside it, and load only the required part of the log when evidence needs expansion.

The repository does not fully define this mechanism yet, so the following is the recommended design.

## 1. What “indexed content expansion” means

Suppose LogDiff finds this new failed-run template:

```text
Connection to <HOST> timed out after <DURATION>
```

That template tells us what changed, but it may not explain why. Logsift now needs the surrounding lines:

```text
Starting database migration
Connecting to database-primary
Retry 1 of 3
Connection timed out after 30 seconds
Migration failed
```

Loading those nearby lines is **content expansion**.

Finding them using stored line, byte, stage, node, timestamp, and correlation information is **indexed content expansion**.

So the flow is:

```text
New template
    ↓
Find its exact occurrence pointer
    ↓
Look in the sidecar index
    ↓
Read only the required byte ranges
    ↓
Create an evidence block
```

## 2. Raw log and sidecar index

They are two separate stored artifacts.

### Raw log

The raw log contains the original text and is stored in restricted persistent storage, such as object storage.

```text
raw-logs/run-7842/build.log
```

Logsift does not normally load this whole file into memory.

### Sidecar index

The sidecar index is a much smaller searchable map created while Logsift reads the log during ingestion.

Example:

| Lines | Bytes | Scope | Template | Timestamp |
|---|---:|---|---|---|
| 1–58 | 0–4,920 | Build | multiple | 10:01–10:03 |
| 59–142 | 4,921–12,480 | Test | multiple | 10:03–10:08 |
| 143–180 | 12,481–15,300 | Package | multiple | 10:08–10:10 |

For individual template occurrences, the index may contain:

```yaml
run_id: run-7842
log_object_id: log-991
source_type: JULES
segment_type: stage
segment_id: test
attempt: 1

physical_line: 126
byte_start: 10840
byte_end: 10924

logical_sequence: 63
template_fingerprint: fp-a91c72
timestamp: "10:07:42"
correlation_id: request-17
```

This is called a “sidecar” because it is stored beside the raw log and describes where useful information can be found.

## 3. Are segments stored in memory?

Not permanently.

There are three different things that should not be confused:

1. **Segment definition**

   A small record saying which lines belong to a Jules stage or Lattice node.

2. **Template occurrences**

   Small records that say where each template appeared.

3. **Segment content**

   The actual log text.

Only the first two need to be persisted as compact metadata. The actual text remains in the raw-log file.

A worker may temporarily hold one chunk in memory:

```text
Read 4 MiB → process it → write index records → release memory → read next chunk
```

Memory usage therefore depends on configured chunk size and active workers, not total log size.

For example:

```text
4 MiB chunk × 10 active workers ≈ 40 MiB of raw chunk data
```

A 20 GB log still does not require 20 GB of memory.

## 4. How Logsift finds a segment for the current run

There are two separate identities.

The baseline family key remains:

```text
seal_id + project_id + repo_id + source_type
```

That key finds the appropriate repo-level success baseline.

But a log occurrence needs a run-specific address:

```text
seal_id
+ project_id
+ repo_id
+ source_type
+ pipeline_run_id
+ log_object_id
+ stage_or_node
+ attempt
+ line_or_byte_range
```

For failure analysis, Logsift also adds:

```text
analysis_id
```

For example:

```yaml
seal_id: seal-12
project_id: project-84
repo_id: repo-31
source_type: LATTICE

pipeline_run_id: run-7842
analysis_id: analysis-a17
log_object_id: log-991

node_id: integration-tests
attempt: 2
line_start: 2180
line_end: 2180
byte_start: 184200
byte_end: 184310
```

Logsift can now ask:

> For `analysis-a17`, expand the occurrence in `run-7842`, node `integration-tests`, attempt 2, around byte 184200.

It cannot accidentally read the same-looking segment from another run because the complete run-specific address is required.

## 5. Jules and Lattice expansion are different

For Jules, physical order usually follows stage order:

```text
Build → Test → Package
```

A Jules expansion can read a continuous range around the suspicious line, but it must stop at the stage boundary.

For Lattice, several nodes may write interleaved physical lines:

```text
Line 100: node-A
Line 101: node-B
Line 102: node-A
Line 103: node-C
Line 104: node-A
```

If the candidate belongs to `node-A`, blindly reading lines 95–110 would mix unrelated node output.

Instead, Logsift uses the sidecar index to collect entries belonging to:

```text
run_id = run-7842
node_id = node-A
attempt = 1
```

It may read several small physical ranges and then reconstruct the node’s logical order. The evidence block still retains every original physical line and byte location.

## 6. Isolation when many analyses run in parallel

Every analysis gets its own isolated partition:

```text
tenant
└── seal
    └── project
        └── repository
            └── run
                └── analysis_id
```

For example:

```text
analysis-a17 → run-7842
analysis-b29 → run-9210
analysis-c41 → run-7842
```

Even if two analyses inspect the same failed run, their candidates are stored separately:

```text
candidate-pool/run-7842/analysis-a17/
candidate-pool/run-7842/analysis-c41/
```

The shared artifacts are read-only:

- Raw log
- Sidecar index
- Compatible success baseline

Analysis-specific artifacts are isolated:

- LogDiff results
- Candidate references
- Expanded ranges
- Evidence blocks
- Scores
- Token selections

A worker must always receive `analysis_id` and `run_id`. It must never use a global in-memory candidate list.

A useful candidate identity is:

```text
analysis_id
+ run_id
+ scope
+ template_fingerprint
+ occurrence location
```

This prevents candidate records from two analyses from being mixed.

## 7. Controlling memory and worker load

Logsift should enforce limits at several levels:

- Fixed input chunk size
- Maximum active chunks per worker
- Maximum concurrent workers per tenant
- Maximum candidates per analysis
- Maximum expanded bytes per candidate
- Maximum evidence-block size
- Queue backpressure
- Fair scheduling between small and large runs
- Cancellation checks between reads
- Expiration of temporary analysis records

If the system is overloaded, it should queue work rather than increasing memory without a limit.

A worker lease also prevents two workers from unintentionally processing the same candidate. If a worker crashes, the lease expires and another worker can safely retry.

## 8. What happens when an unmatched template is found

Assume the failed run produces:

```text
Template: Connection to <HOST> timed out after <DURATION>
Fingerprint: fp-a91c72
```

LogDiff looks for `fp-a91c72` in the compatible success baseline.

If it is absent:

```text
classification = NEW_TEMPLATE
```

Logsift then creates a candidate reference:

```yaml
analysis_id: analysis-a17
candidate_id: candidate-108

classification: new_template
template_fingerprint: fp-a91c72

run_id: run-7842
log_object_id: log-991
source_type: JULES
stage_id: test
attempt: 1

line_start: 126
line_end: 126
byte_start: 10840
byte_end: 10924
```

The full text is not copied into the candidate pool.

Next, content expansion uses the pointer:

```text
Candidate line 126
    ↓
Sidecar lookup
    ↓
Same Test stage
    ↓
Lines 116–136
    ↓
Extend to include complete stack trace
    ↓
Range-read required bytes
    ↓
Evidence block
```

The evidence block is then deduplicated, scored, ranked, and considered for the token budget.

Most importantly, because the run failed:

```text
The new template does not update the success baseline.
```

It exists only in the failed-run analysis unless it later appears in an eligible trusted successful run.

## 9. Avoiding thousands of unmatched candidates

A parser or version problem could make nearly every line appear new. Logsift should not expand all of them.

First, it checks compatibility:

- Same source schema version
- Same normalization-rule version
- Same masking-rule version
- Same parser type and version
- Compatible baseline manifest

If these are incompatible, Logsift should refuse normal LogDiff rather than reporting thousands of false differences.

If versions are compatible but many genuine new occurrences exist, Logsift groups them by:

```text
template fingerprint + stage or node + attempt
```

For example, 5,000 identical timeout occurrences become one candidate group:

```yaml
template_fingerprint: fp-a91c72
occurrence_count: 5000
first_occurrence: line 126
last_occurrence: line 9120
representative_occurrences:
  - line 126
  - line 4800
  - line 9120
```

Only a few representative locations are expanded.

## Simplified complete picture

```text
Large failed log
    ↓ chunked ingestion
Restricted raw-log storage
    +
Small sidecar index
    ↓
Same frozen preprocessing
    ↓
Template occurrences with exact pointers
    ↓
LogDiff against compatible repo-level baseline
    ↓
New or suspicious fingerprint
    ↓
Candidate reference stored under run_id + analysis_id
    ↓
Sidecar index finds stage/node and nearby ranges
    ↓
Only those raw-log byte ranges are read
    ↓
Evidence block
    ↓
Deduplicate → score → token selection
```

So the design has three important protections:

- **Memory safety:** only bounded chunks and selected ranges enter memory.
- **Analysis isolation:** every request is scoped by `run_id` and `analysis_id`.
- **Correct expansion:** every candidate carries exact raw-log, byte, line, stage/node, and attempt provenance.