Yes, we should use both a **candidate pool** and an **index**. They solve different problems:

- The candidate pool records **what looks suspicious**.
- The index records **where the original evidence is located**.

A candidate pool cannot replace the index. If a candidate only says “line 50,000 is suspicious,” Logsift may need to scan from the beginning of a large text file to locate that line. If the candidate contains a byte pointer produced by the index, Logsift can read the relevant region directly.

## Recommended overall design

The index should not be a separate full pass before failure preprocessing. It should be created **while the log is being ingested and preprocessed**.

```text
Failed log arrives
    ↓
Streaming source detection and ingestion
    ├── Store immutable raw-log chunks
    ├── Build sidecar index
    └── Run the shared preprocessing pipeline
            Normalize
            Redact
            Mask
            Segment
            Drain
    ↓
Commit run manifest: preprocessing complete
    ↓
LogDiff
    ↓
Candidate pool
    ↓
Indexed content expansion
    ↓
Log blocks
    ↓
Deduplicate → score → token selection
```

This avoids reading the complete log twice.

## Separate the common pipeline from offline learning

The terms “offline flow” and “online flow” can be confusing. I recommend separating them conceptually into three parts.

### 1. Common ingestion and preprocessing

This runs for both successful and failed logs:

```text
Detect source
→ Parse envelope
→ Store raw log
→ Normalize
→ Redact
→ Mask
→ Segment
→ Drain
→ Build indexes and occurrence records
```

It creates run-level artifacts but does not decide whether the baseline should change.

### 2. Successful-run learning

This runs only when the run is:

- Complete
- Successful
- From a trusted branch
- Detected as Jules or Lattice
- Processed with compatible rule and parser versions

It publishes or updates the success baseline.

### 3. Failed-run analysis

This uses the same preprocessing versions but:

- Uses the frozen Drain configuration
- Does not train or update the baseline
- Compares failed-run occurrences with the baseline
- Creates candidates
- Expands and ranks evidence

So “same offline preprocessing” should mean **the same deterministic preprocessing pipeline**, not “update the success baseline.”

## When should the index be built?

Build it while the log is being read for the first time.

For each chunk, Logsift can do this:

```text
Read bounded chunk
    ↓
Capture line and byte positions
    ↓
Identify Jules stage or Lattice node
    ↓
Normalize, mask and parse lines
    ↓
Write index and occurrence records
    ↓
Release chunk from memory
```

When the terminal pipeline event arrives, much of the indexing may already be complete. Logsift only needs to finalize the run manifest and start LogDiff.

If an older log has no index, Logsift can perform a one-time index-building scan before analysis. It should not rescan the log separately for every candidate.

## What should the sidecar index contain?

We do not necessarily need a large database row for every character or token. A practical index can combine chunk-level and occurrence-level records.

### Chunk index

One record for every reasonably sized log chunk:

```yaml
seal_id: seal-12
project_id: project-84
repo_id: repo-31
source_type: LATTICE
run_id: run-7842
log_object_id: log-991

chunk_id: chunk-17
line_start: 16001
line_end: 17000
byte_start: 1384200
byte_end: 1478100

first_timestamp: "10:07:10"
last_timestamp: "10:07:51"
```

This lets Logsift find the right general region quickly.

### Segment index

This records where each Jules stage or Lattice node appears.

For Jules:

```yaml
segment_type: stage
segment_id: test
attempt: 1
line_start: 1200
line_end: 8900
byte_start: 104200
byte_end: 781400
```

For Lattice:

```yaml
segment_type: node
segment_id: integration-tests
attempt: 2
physical_ranges:
  - byte_start: 184200
    byte_end: 184900
  - byte_start: 186400
    byte_end: 187100
  - byte_start: 192200
    byte_end: 193800
```

A Lattice node may have several physical ranges because output from parallel nodes can be interleaved.

### Template-occurrence index

This connects Drain results to exact locations:

```yaml
template_fingerprint: fp-a91c72
segment_id: integration-tests
attempt: 2
physical_line: 16428
logical_sequence: 219
byte_start: 1418920
byte_end: 1419018
timestamp: "10:07:42"
correlation_id: request-17
```

These can be stored as compact, append-only records rather than large mutable objects.

## Candidate pool structure

The candidate pool should contain references, not copied raw-log blocks.

```yaml
analysis_id: analysis-a17
candidate_id: candidate-108

seal_id: seal-12
project_id: project-84
repo_id: repo-31
source_type: LATTICE
run_id: run-7842
log_object_id: log-991

reason:
  type: new_template
  template_fingerprint: fp-a91c72

scope:
  node_id: integration-tests
  attempt: 2

location:
  physical_line: 16428
  logical_sequence: 219
  byte_start: 1418920
  byte_end: 1419018

status: waiting_for_expansion
```

A candidate record is small. Even thousands of candidates use much less memory than copied log blocks.

## How content expansion works

Suppose LogDiff produces this candidate:

```text
run: run-7842
node: integration-tests
attempt: 2
line: 16428
bytes: 1418920–1419018
```

The expansion worker:

1. Loads the candidate reference.
2. Queries the sidecar index using the same run, node and attempt.
3. Finds nearby logical records.
4. Extends the range to include a complete stack trace or request flow.
5. Reads only the required raw-log chunks.
6. Creates an evidence block.
7. Releases the raw chunk from memory.

For Jules, it normally expands within the same contiguous stage.

For Lattice, it collects the same node and attempt, even if those lines are physically separated by other nodes’ output.

## How simultaneous analyses remain isolated

Use two levels of identity.

### Shared baseline identity

```text
seal_id + project_id + repo_id + source_type
```

This selects the repo-level baseline family.

### Analysis identity

```text
seal_id
+ project_id
+ repo_id
+ source_type
+ run_id
+ analysis_id
```

Every temporary operation must include `run_id` and `analysis_id`.

For example:

```text
run-7842 / analysis-a17 / candidates
run-7842 / analysis-b29 / candidates
run-9210 / analysis-c41 / candidates
```

Two analyses may share these immutable, read-only artifacts:

- Raw log
- Sidecar index
- Failed-run template occurrences
- Compatible success baseline

But they must not share mutable analysis state:

- Candidate status
- Expanded blocks
- Scores
- Selected evidence
- Token-budget calculations
- Cancellation state

No worker should keep a global candidate list in process memory.

## Recommended processing state

Store the analysis state durably:

```text
CREATED
→ WAITING_FOR_INDEX
→ READY_FOR_DIFF
→ DIFF_COMPLETE
→ EXPANDING
→ RANKING
→ EVIDENCE_READY
```

Workers claim small pieces of work using short leases.

For example:

```yaml
candidate_id: candidate-108
status: expanding
lease_owner: worker-7
lease_expires_at: "10:09:30"
version: 4
```

If the worker crashes, the lease expires and another worker retries. The output uses an idempotency key, so the retry does not create a second evidence block.

## Memory-efficient worker design

Each worker should have hard limits:

```yaml
input_chunk_size: 4 MiB
maximum_chunks_in_memory: 2
maximum_expansion_per_candidate: 256 KiB
maximum_evidence_block: 32 KiB
maximum_candidates_per_batch: 100
```

A worker might therefore use approximately:

```text
2 × 4 MiB input chunks
+ small candidate metadata
+ bounded output buffer
```

Its memory usage remains bounded even if the source log is 50 GB.

Also use:

- Backpressure when the queue is full
- Per-tenant concurrency limits
- Fair scheduling between large and small runs
- Cancellation checks between reads
- Candidate and analysis expiration
- Maximum expanded bytes per analysis

## Handling a new unmatched template

Suppose Drain produces:

```text
Canonical template:
Connection to <HOST> timed out after <DURATION>

Fingerprint:
fp-a91c72
```

If the compatible baseline does not contain that fingerprint:

```text
classification = new_template
```

Logsift should then:

1. Group occurrences by fingerprint and scope.
2. Count all occurrences.
3. Keep the first, last and a few representative pointers.
4. Create one candidate group.
5. Expand only representative occurrences.
6. Score the resulting evidence blocks.
7. Never update the baseline from this failed run.

For example:

```yaml
template_fingerprint: fp-a91c72
scope:
  node_id: integration-tests
  attempt: 2

occurrence_count: 5000
first_occurrence:
  line: 16428
  byte_start: 1418920

last_occurrence:
  line: 48210
  byte_start: 4219030

representatives:
  - line: 16428
  - line: 29711
  - line: 48210
```

This prevents 5,000 repeated failures from becoming 5,000 expansion jobs.

## Failure protection

If nearly every template appears new, Logsift should first check:

- Baseline key
- Source type
- Source-schema version
- Normalization-rule version
- Masking-rule version
- Drain configuration and version
- Fingerprint version

If versions differ incompatibly, it should stop normal LogDiff:

```text
Analysis stopped:
failed run and baseline were produced by incompatible preprocessing versions
```

It should not generate thousands of misleading candidates.

## Recommended decision

The strongest design is:

- Build indexes during common ingestion, not in a separate repeated flow.
- Persist raw logs and index records; do not persist complete segments in memory.
- Use a candidate pool containing exact references.
- Partition mutable state by `run_id + analysis_id`.
- Share only immutable raw logs, indexes and baselines.
- Process candidates using bounded workers and short leases.
- Group repeated unmatched templates before expansion.
- Read only indexed raw-log ranges.
- Never update the baseline from failed-run candidates.

This keeps the LogSage filtering-and-expansion idea while adding the missing distributed-system behavior required for speed, isolation, and predictable memory usage.