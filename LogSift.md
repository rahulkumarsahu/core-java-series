# Logsift: problem and architecture

## 1. Introduction

### In short

When a CI/CD run fails, the log can contain thousands of normal lines and only a few lines that explain the failure. Finding those lines manually is slow, and the last error in the log is not always the real cause.

Logsift learns normal patterns from selected successful runs. When a run fails, it compares the failed log with a compatible success baseline, finds unusual lines, and expands the surrounding context. It then removes repeated evidence, ranks what remains, and creates a small evidence pack that a language model can analyze.

Logsift can also retrieve relevant runbooks, previous confirmed incidents, configuration, and code from the same repository version. This helps it explain what probably failed and show the evidence behind the explanation. It may recommend a fix, but automatically changing code or rerunning a pipeline requires a separate approved workflow.

### The problem

When a pipeline fails, an engineer usually has to:

1. Open a large and noisy log.
2. Find the lines that may be related to the failure.
3. Separate the real cause from later follow-on errors.
4. Decide what to fix and where to start.

Sending the complete log to a language model is not a good solution. It costs more, may expose secrets, and fills the context with repeated or unrelated text. Important evidence can get lost in the noise.

Jules and Lattice also need different handling:

- **Jules** writes stages in sequence, such as build, test, and package. Nearby lines usually belong to the same stage, but Logsift must still keep the stage boundary.
- **Lattice** runs DAG nodes in parallel. Lines from different nodes can be interleaved, so two nearby physical lines may be unrelated. Logsift must keep the node, attempt, and node-local order.

A simple way to picture the problem is a mechanic receiving hundreds of pages of sensor readings when only a few readings explain why the engine stopped. Logsift reduces the full record to the small set of readings that deserve attention, while keeping links back to their exact source.

### Who this helps

- Developers can spend less time searching logs and more time fixing the failure.
- On-call and platform engineers get a small evidence pack even when they do not know the pipeline well.
- Jules and Lattice platform teams receive clearer failure reports with exact provenance.
- Automation systems receive bounded, structured input instead of an unrestricted raw log.
- Delivery teams get a more consistent failure-triage process.

---

## 2. The solution — Logsift

Logsift covers the full path from a raw pipeline log to a small, evidence-based diagnosis. It does this in three stages. The first stage learns normal behaviour, the second finds useful failure evidence, and the third searches for information that can explain the failure and guide the fix.

![Logsift three-stage flow](images/02-three-stage-overview.png)

> **Design status:** The project defines the three-stage direction, the difference between Jules and Lattice, Drain-based templates, and comparison with successful runs. The streaming sidecar index, isolated candidate pool, and retrieval stores below are the recommended design where implementation details are not defined yet.

### Stage 1 — Offline learning

This stage runs for selected successful pipeline runs. Its purpose is to learn what normal output looks like for one repository and source type. Failed, cancelled, incomplete, or untrusted runs never update the baseline.

![Logsift offline learning overview](images/02-offline-learning-overview.png)

| Block | Purpose |
|---|---|
| Terminal event | Starts processing only after the pipeline reaches a final state and the log is complete. |
| Eligibility decision | Allows only a successful run from a configured trusted branch to update the baseline. Other runs are rejected or sent to failure analysis. |
| Detect source | Reads configured signatures near the top of the log and returns `JULES`, `LATTICE`, or `UNKNOWN`. Logsift does not guess from line order. |
| Jules or Lattice adapter | Converts source events into one common event shape while keeping the Jules stage or Lattice node and attempt. |
| Canonical events | Give later blocks one consistent event format without making Jules and Lattice behave as if they are the same. |
| Normalize | Cleans safe presentation differences, such as timestamp formatting and control characters. |
| Redact | Permanently removes secrets from all derived data. |
| Typed mask | Replaces changing values with placeholders such as `<BUILD_ID>` or `<DURATION>`. |
| Segment and group | Keeps Jules statistics inside their stage. For Lattice, it keeps statistics and order inside each node and attempt. This is required for a correct baseline. |
| Streaming occurrence tracking | Records the scope and order of each template while the successful log is read. Logsift uses these records to build the baseline statistics. |
| Optional success-run index | A successful run may keep a short-lived segment map and sidecar for validation, audit, or replay. LogDiff does not need these files to expand a future failed log. |
| Successful raw log | Keeping the original successful log is a separate audit or source-retention choice. It is not required for future failed-log expansion. |
| Drain | Turns similar masked messages into reusable canonical templates. |
| Versioned success baseline | Stores templates, fingerprints, counts, and stage-or-node occurrence data under `seal_id + project_id + repo_id + source_type`. |

### Stage 2 — Failure analysis

This stage runs after a pipeline fails. Its purpose is to find what changed, recover the useful surrounding context, and create a small evidence pack. It uses the success baseline but never changes it.

![Logsift failure-analysis overview](images/02-failure-analysis-overview.png)

| Block | Purpose |
|---|---|
| Failed terminal run | Provides the complete failed log and required run metadata. |
| Same frozen preprocessing | Uses compatible normalization, redaction, masking, segmentation, indexing, and Drain versions so the failed run can be compared fairly. |
| LogDiff | Compares stable template fingerprints, counts, and stage-or-node occurrence data with a compatible success baseline. |
| Candidate discovery | Joins three independent sources: LogDiff results, configured failure keywords, and the source-aware end of the failed scope. One line selected by several sources remains one candidate with several reasons. |
| Candidate pool | Stores small suspicious-occurrence references under a unique `analysis_id`. It does not copy the complete log. |
| Raw logs and sidecar index | Provide the original text and exact line, byte, stage-or-node, and attempt locations. |
| Indexed content expansion | Uses candidate pointers to read only the required raw-log ranges. |
| Jules or Lattice expansion | Expands inside the same Jules stage, or collects the same Lattice node and attempt even when physical lines are interleaved. |
| Evidence blocks | Combine related expanded lines into small readable failure stories while keeping exact provenance. |
| Deduplicate | Collapses repeated blocks while retaining occurrence counts and representative locations. |
| Score and rank | Puts unusual, severe, nearby, and well-supported evidence ahead of repeated noise. |
| Token selection | Chooses a useful and varied set of blocks that fits the model's evidence budget. |
| Evidence pack | Contains the failure summary, template diff, selected blocks, counts, and links to exact source locations. |

### Stage 3 — Solution finding

This stage starts with the evidence pack. Its purpose is to find trusted knowledge and code that can explain the evidence and suggest a practical next step. The log evidence remains authoritative.

![Logsift solution-finding overview](images/02-solution-finding-overview.png)

| Block | Purpose |
|---|---|
| Evidence pack | Supplies the error signals, template fingerprints, pipeline scope, repository, and failed commit. |
| Build search signals | Creates exact-text, meaning-based, and code-relationship queries from the evidence. |
| Permission, repository, and commit filter | Stops unauthorized information and code from the wrong repository version from entering the result. |
| Exact search | Finds exact error strings, names, configuration keys, and template text. |
| Vector search | Finds related documents and incidents even when they use different wording. |
| Code graph | Finds connected functions, tests, configuration, pipeline steps, dependencies, and owners. |
| Merge and rerank | Combines search results and prefers relevant, trusted, fresh, and compatible information. |
| Commit-matched context | Keeps code and configuration that match the failed run's repository and commit. |
| Grounded diagnosis | Explains the likely cause using both the current log evidence and retrieved context. |
| Suggested fix and citations | Gives a recommended next step with links to the supporting log, document, configuration, or code. Automatic execution is a separate approved workflow. |

### Complete overview

The following diagram joins the three stages. It is intentionally short; later sections explain each stage in detail.

![Logsift complete solution overview](images/02-end-to-end-overview.png)

---

## 3. Components

This section explains each block in more detail. It starts with offline learning because every later comparison depends on the baseline, files, and records created here.

### 3.1 Offline learning flow

Offline learning uses trusted successful runs to learn what normal pipeline output looks like. It stores that learning as a versioned baseline that failed runs can use later.

```text
Successful final event
  -> check whether the run can teach the baseline
  -> detect Jules or Lattice
  -> stream the log
  -> normalize
  -> redact
  -> mask
  -> segment by stage or node attempt
  -> collect segment-aware template occurrences
  -> create Drain templates and fingerprints
  -> aggregate counts and order by branch class and stage or node
  -> publish the success baseline
```

The main flow is already clear in Logsift. A few implementation details are still open, including the final event fields, rule-file format, index format, and branch fallback rules. The examples below give us a simple design to start implementing. We can adjust them when the real Jules and Lattice contracts are available.

#### 3.1.1 Trusted branches

A successful run does not automatically become learning data. It can update the baseline only when all of these checks pass:

1. The branch is trusted, such as `main`, `master`, or an approved `release/*` branch.
2. The pipeline finished successfully. It was not cancelled, skipped, unstable, or left incomplete.
3. The log upload is complete.
4. Jules or Lattice was identified confidently.
5. `seal_id`, `project_id`, `repo_id`, `run_id`, `event_id`, and `log_ref` are present.
6. The Jules or Lattice format version and the versions of the processing rules, segmentation, Drain, and fingerprint are known.

Feature, pull-request, developer, and temporary branches can still use Logsift when they fail. They simply cannot teach the shared success baseline.

The project does not yet provide the final trusted-branch list. Keep the list in configuration so each repository can choose its trusted branches without changing code.

```yaml
trusted_branches:
  exact: [main, master]
  patterns: ["release/*"]
untrusted_branches:
  patterns: ["feature/*", "pull/*", "pr/*", "tmp/*"]
```

The branch is not part of the four-part baseline key. Even so, Logsift should not mix the behaviour of `main` and `release/*` as if they were always the same.

- Keep one template catalog for the repository and source type.
- Record a simple `branch_class`, such as `main` or `release`.
- Keep template counts and ordering information separate for each branch class.
- During LogDiff, first use statistics from the matching branch class.
- If those statistics are missing, allow a configured fallback to `main` or `master` only when the processing versions match.

In this document, `main` and `master` mean the repository's primary trusted branch. Each repository should configure the name it actually uses.

#### 3.1.2 Detect Jules or Lattice

Logsift must know whether the run came from Jules or Lattice before it can group the lines correctly.

The easiest option is for the final pipeline event to send `source_type: JULES` or `source_type: LATTICE`. If that field is missing, Logsift checks only the top part of the log for known source markers. A useful starting limit is the first 200 lines or 256 KiB, whichever comes first.

The result is `JULES`, `LATTICE`, or `UNKNOWN`. If the event and the log header disagree, the result is also `UNKNOWN`. An unknown run must not update the baseline. Logsift must not guess the source only because the lines look sequential or interleaved. The exact Jules and Lattice header markers still need to be provided by their integrations.

#### 3.1.3 Basic successful-pipeline event

After a pipeline finishes and its log upload is complete, the pipeline platform should send one final event. This event tells Logsift which run finished, where its log is stored, and whether the run is allowed to enter offline learning.

```json
{
  "schema_version": "pipeline-event/v1",
  "event_id": "evt-7312-complete",
  "event_type": "pipeline.run.completed",
  "pipeline_id": "payments-ci",
  "run_id": "run-7312",
  "outcome": "SUCCESS",
  "log_complete": true,
  "source_type": "JULES",
  "log_ref": "restricted://logs/run-7312",
  "metadata": {
    "seal_id": "seal101",
    "project_id": "payments",
    "repo_id": "payment-api",
    "branch": "main",
    "branch_class": "main",
    "commit_sha": "2f14a77",
    "environment": "ci",
    "other": "..."
  },
  "versions": {
    "source_schema": "jules/v2",
    "preprocessing": "preprocess/v1",
    "segmentation": "segment/v1",
    "parser": "drain/v1",
    "fingerprint": "fingerprint/v1"
  },
  "emitted_at": "2026-08-25T08:10:00Z"
}
```

The complete sample is in [Jules event.json](examples/offline-flow/jules/event.json). A corresponding DAG example is in [Lattice event.json](examples/offline-flow/lattice/event.json).

`event_id` prevents duplicate work. If Logsift receives the same event twice, it should return the first result instead of creating another baseline. `run_id` identifies this run, `pipeline_id` identifies the pipeline, and `log_ref` points to the raw log. `commit_sha` is kept as protected metadata so later code search can use the correct code version.

#### 3.1.4 Process every line in a fixed order

Every log line goes through the same steps in the same order:

```text
record its original line and byte location
  -> read the Jules stage or Lattice node details
  -> normalize
  -> redact
  -> mask
  -> assign the segment
  -> send the protected template text to Drain
```

The order matters. For example, secrets must be removed before masked text is stored or sent to Drain. Every baseline records the versions of these rules so a failed run can use the same processing later.

##### Normalize

Normalization cleans differences in how a line is displayed. It makes the text easier to process without changing what the line means. Normalization does not remove secrets and does not replace changing values such as build IDs.

Possible normalization work includes: converting text to UTF-8, removing byte-order marks, making Windows and Linux line endings consistent, removing terminal colour codes, removing unsafe control characters, handling progress lines that repeatedly overwrite the same terminal line, standardizing Unicode text, converting recognized timestamps to one time zone, standardizing severity labels, cleaning safe extra whitespace, removing a Jules or Lattice prefix after its metadata has been saved, detecting multiline records, and keeping the original line number and byte location.

Example:

```text
Raw:
2026-08-25T08:00:01+00:00 [stage=build attempt=1] \u001b[32mINFO\u001b[0m Building payment-api build=7312

Normalized message:
INFO Building payment-api build=7312

Extracted metadata:
timestamp=2026-08-25T08:00:01Z, stage=build, attempt=1
```

Normalization must be careful. It should not change the case of file paths, reorder words, remove exception names, lose original line locations, or throw away stage and node information. An overly broad rule can make two different errors look the same.

The proposed file shape is [normalize_rule.yaml](examples/offline-flow/normalize_rule.yaml). It includes rule order, matching, actions, safety limits, and a small input/output test.

##### Redact

Redaction removes secret or private values. Once a value is redacted, it must not appear in a template, index, audit record, or evidence block.

Possible redaction targets include: access tokens, API keys, bearer tokens, passwords, client secrets, authorization headers, session cookies, credentials inside URLs, private keys, signing keys, database passwords, cloud credentials, webhook secrets, personal email addresses when required by policy, and source-specific secret formats.

Example:

```text
Before redaction:
Downloading https://demo-user:demo-pass@packages.example.test/payment-api/a81fd9.jar access_token=sample-token-not-real

After redaction:
Downloading https://<REDACTED_CREDENTIAL>@packages.example.test/payment-api/a81fd9.jar <REDACTED_TOKEN>
```

The values in this example are fake. The audit record may store the rule name and number of matches, but never the matched secret. If redaction fails, Logsift must stop and must not publish the baseline. Secrets that span several lines, such as private keys, must be removed as one protected block.

The proposed structure is [redaction_rule.yaml](examples/offline-flow/redaction_rule.yaml).

##### Mask

Masking replaces safe values that normally change from run to run. The original value may not be secret, but keeping it would make similar lines look different. A typed placeholder explains what kind of value was replaced.

Possible masking targets include: timestamps left in the message, request IDs, correlation IDs, UUIDs, build IDs, run IDs, attempt IDs, commit hashes, artifact hashes, generated versions, temporary paths, workspace paths, safe URL query values, IP addresses, temporary ports, durations, memory sizes, byte counts, process IDs, worker IDs, container IDs, pod names, hostnames, and usernames when policy allows it.

Example:

```text
Before masking:
INFO Build 7312 downloaded payment-api-a81fd9.jar from 10.4.8.2 in 812ms

After masking:
INFO Build <BUILD_ID> downloaded payment-api-<ARTIFACT_HASH>.jar from <IP_ADDRESS> in <DURATION>
```

Do not mask a value when it changes the meaning of the failure. Keep exception types, failed test names, stage or node names, exit codes, signal names, source-file locations, and the difference between `failed=0` and a nonzero failure count. A duration or memory value can be replaced in template text while its number is kept separately for later checks.

The proposed structure is [masking_rule.yaml](examples/offline-flow/masking_rule.yaml).

#### 3.1.5 Segmentation

After preprocessing, Logsift knows which stage or node produced each line. Segmentation groups those line references into the logical parts of the pipeline. This step is required for successful runs because the baseline must remember where a template normally appears, not only that the template exists.

- In Jules, one segment represents one `stage + attempt`, such as `test + attempt 1`.
- In Lattice, one segment represents one `DAG node + attempt`, such as `test:integration + attempt 2`.

Segmentation does not copy the log text and does not create templates. It records how lines are grouped and ordered. Drain then creates templates from those lines, and Logsift stores the resulting counts and order under the correct stage or node.

##### What `segment-groups.json` stores

During processing, every run has a segment map. `segment-groups.json` is an easy-to-read form of that map. It records:

- all stage or node-attempt segments found in the run;
- a unique `segment_id` for each segment;
- whether the segment is a Jules stage or a Lattice DAG node;
- the stage or node name and attempt number;
- how many logical lines belong to the segment;
- which physical line and byte ranges belong to it;
- the logical order of Lattice fragments when its output is interleaved.

The file does not contain the complete log and does not need to stay in memory. For a failed run, Logsift keeps this map through failure analysis because content expansion needs it. For a successful run, Logsift may keep the file for a short time for validation or replay. It does not have to keep it permanently after the segment-aware statistics have been written to the baseline.

##### Jules segment example

```json
{
  "segment_id": "seg-run-7312-test-1",
  "scope": {"kind": "stage", "name": "test", "attempt": 1},
  "logical_line_count": 2,
  "physical_ranges": [
    {"line_start": 6, "line_end": 7, "byte_start": 473, "byte_end": 692}
  ]
}
```

The complete example is [Jules segment-groups.json](examples/offline-flow/jules/segment-groups.json). Jules stages normally appear as one continuous area of the raw log. The `test` segment above therefore needs only one range: lines 6 to 7.

##### Lattice segment example

```json
{
  "segment_id": "seg-run-8821-integration-2",
  "scope": {"kind": "dag_node", "name": "test:integration", "attempt": 2},
  "logical_line_count": 5,
  "physical_ranges": [
    {"line_start": 3, "line_end": 3},
    {"line_start": 5, "line_end": 5},
    {"line_start": 7, "line_end": 7},
    {"line_start": 9, "line_end": 9},
    {"line_start": 11, "line_end": 11}
  ]
}
```

The complete example is [Lattice segment-groups.json](examples/offline-flow/lattice/segment-groups.json). Lattice output can be interleaved. The same node may own lines 3, 5, 7, 9, and 11 while other nodes own the lines between them. That is why a Lattice segment may need several ranges instead of one start and end line.

##### How segmentation is used later

Segmentation has two different uses.

For a successful run, it builds the normal scope statistics used by LogDiff. For example, `Downloaded <ARTIFACT>` may be normal in `build` but unusual in `test`. Lattice also needs node-local order because physical lines from several nodes may be interleaved.

For a failed run, the saved segment file gives content expansion a safe boundary. It answers questions such as:

- Which stage or node owns this suspicious line?
- Which attempt does it belong to?
- Which other line ranges belong to the same logical work?
- Where must expansion stop so output from another stage or node is not mixed in?

For Jules, expansion stays inside the same stage and attempt. For Lattice, expansion follows the same node and attempt even when those lines are not next to each other in the raw log.

The failed run's segment file alone is not enough to find a particular suspicious line. It is a high-level map of the segments. The failed run's sidecar index provides the detailed line-by-line lookup.


#### 3.1.6 Streaming occurrence tracking and the sidecar index

Logsift tracks each line while it streams the log. It records the line's position, stage or node, logical order, and later its template fingerprint. This tracking is needed for both successful and failed runs, but the two flows do not need to keep the same files.

- For a successful run, Logsift uses the line records to calculate template counts and order for each stage or node. After those statistics are safely published in `templates.json`, the full line-by-line records may be deleted. A saved success sidecar is optional and can be kept for a short time for validation, audit, or replay.
- For a failed run, Logsift must keep the sidecar through failure analysis. LogDiff uses it to locate suspicious occurrences, and content expansion uses it to fetch the exact failed-log bytes.

It is called a sidecar because it is a small companion to the much larger raw log. The raw log contains the text. The sidecar contains pointers to that text. A permanent success sidecar is not part of the baseline contract.

Drain does not create this index. The index builder starts earlier:

```text
read one raw line
  -> record its physical line and byte location
  -> find its Jules stage or Lattice node
  -> assign its segment and logical position
  -> normalize, redact, and mask the message
  -> send the protected message to Drain
  -> add Drain's template fingerprint to the index record
  -> update success statistics or store the failed-run index record
```

When Logsift writes a full sidecar, each indexed log line records:

- `run_id` and `log_object_id`;
- one-based physical line number;
- its byte range in the raw log;
- segment ID, stage or node, and attempt;
- logical sequence inside the segment;
- timestamp when available;
- a protected correlation value when available, so related requests can be joined without storing the original ID;
- multiline or stack-trace group when available;
- template fingerprint after Drain returns it.

The example output is a run-specific `sidecar-index.json`. Each object represents one indexed line. The index does not copy the line text or any secret value. The successful-run example is useful for showing the structure, but Logsift does not have to keep that file after publishing the baseline.

In the example below, the record says that physical line 7 belongs to the Jules `test` segment. It is the second logical line in that segment, its raw bytes are stored from offset 589 up to but not including 692, and Drain matched it to the shown fingerprint.

```json
{
  "run_id":"run-7312",
  "log_object_id":"log-run-7312",
  "segment_id":"seg-run-7312-test-1",
  "physical_line":7,
  "logical_sequence":2,
  "byte_start":589,
  "byte_end":692,
  "template_fingerprint":"sha256:v1:c670..."
}
```

See [Jules sidecar-index.json](examples/offline-flow/jules/sidecar-index.json) and [Lattice sidecar-index.json](examples/offline-flow/lattice/sidecar-index.json).

The JSON files make the structure easy to read. A production system does not have to search one large JSON file. It can store the same records in run-based partitions and keep searchable fields such as `run_id`, `segment_id`, and `template_fingerprint` in an indexed database.

##### Three files with three different jobs during failure analysis

| File | Simple purpose |
|---|---|
| `segment-groups.json` | Shows the logical stages or node attempts and the raw-log ranges that belong to each one. |
| `sidecar-index.json` | Finds an individual indexed line by fingerprint, segment, physical line, logical position, or byte range. |
| Raw log | Contains the actual original text. |

The segment file is the map of the neighbourhood. The sidecar is the address book for individual lines. The raw log is the content itself. These three are required together when Logsift expands evidence from a failed run. They are not three permanent baseline files.

##### How the builder avoids loading the full log

The builder reads a small chunk, finishes the lines in that chunk, writes a batch of segment and sidecar records, and then releases the chunk. It keeps only a small unfinished-line buffer when a line crosses a chunk boundary.

The complete log and complete segments are never kept in worker memory. A 20 GiB log is handled as many small reads, not as one 20 GiB object.

##### How LogDiff and content expansion use the index

The important rule is that failure analysis uses the failed run's segment file and sidecar index. It does not use the successful run's index to expand a failed log.

```text
LogDiff finds a suspicious template fingerprint
  -> search the failed run's sidecar for that fingerprint
  -> create candidate references for its exact occurrences
  -> read the candidate's segment from segment-groups.json
  -> choose nearby logical lines inside that segment
  -> use the sidecar to get their raw byte ranges
  -> range-read only those bytes from the failed raw log
  -> redact the retrieved text and build an evidence block
```

Here is what happens step by step:

1. LogDiff compares the failed run's template summary with the compatible success baseline.
2. Suppose fingerprint `fp-timeout` is new or appears too often.
3. Logsift searches the failed run's sidecar for `fp-timeout`.
4. The sidecar returns one or more exact matching lines. Each result includes the segment, physical line, logical position, and byte range.
5. Logsift writes small candidate references. It does not copy the log text into the candidate pool.
6. Expansion loads the matching segment and chooses nearby logical positions without crossing its boundary.
7. The sidecar converts those positions into raw byte ranges, and Logsift reads only those parts of the failed log.

A candidate-pool record is only a pointer. A simple record looks like this:

```json
{
  "analysis_id": "analysis-44",
  "run_id": "run-failed-9001",
  "log_object_id": "log-run-failed-9001",
  "segment_id": "seg-test-1",
  "template_fingerprint": "fp-timeout",
  "physical_line": 405,
  "logical_sequence": 18,
  "byte_start": 32480,
  "byte_end": 32552
}
```

This record is small. It tells the expansion worker which failed log, segment, and raw byte area to use. It does not contain the log text.

For a Jules candidate on line 7, the sidecar may return `segment=test` and `logical_sequence=2`. The segment file says that the `test` stage contains lines 6 and 7. Expansion can read those lines but cannot move into `build` or `package`.

For a Lattice candidate on physical line 9, the sidecar may return `segment=test:integration`, `attempt=2`, and `logical_sequence=4`. The segment file says that the same node owns physical lines 3, 5, 7, 9, and 11. Expansion can collect the useful node-local lines without including interleaved output from `security-scan` or `package`.

Successful runs may also keep segment and sidecar files for validation, audit, and replay. Those files should have a short, configurable retention period. LogDiff normally compares the stored success templates and statistics. It does not use a successful run's sidecar or raw log to expand a failed run.

##### Keeping runs and analyses separate

When a run keeps segment and sidecar files, it stores them under its own path:

```text
runs/{seal_id}/{project_id}/{repo_id}/{source_type}/{run_id}/{log_object_id}/
  segment-groups.json
  sidecar-index.json
```

A candidate carries `run_id`, `log_object_id`, `segment_id`, and a line or byte pointer. These fields locate the failed run and its exact log area. `analysis_id` keeps the work of two simultaneous failure analyses separate, but it is not enough by itself to locate a log.

This run folder is required while a failed run is being analysed. For a successful run, the folder is optional after the baseline is published.

The examples use one-based line numbers and zero-based byte offsets. `byte_start` is included and `byte_end` is excluded. The implementation must use this rule everywhere. It must also define how UTF-8 bytes are counted, how chunks overlap, how compressed logs support partial reads, what happens when a log upload is incomplete, how records are versioned, how retries avoid duplicates, how long indexes are kept, and which service may read raw ranges.

#### 3.1.7 Drain templates and fingerprints

Drain groups log lines that have the same basic message shape. Logsift gives Drain one protected, masked message at a time, so Drain does not need the complete log in memory.

Suppose masking produces:

```text
Downloaded payment-api-<ARTIFACT_HASH>.jar in <DURATION>
Downloaded payment-api-<ARTIFACT_HASH>.jar in <DURATION>
```

Drain handles a line in four simple steps:

1. Count the words or tokens in the line.
2. Use the first stable words to route the line through a small fixed-depth tree.
3. Compare the line with the small group of templates found at the end of that path.
4. Reuse the closest template or create a new template when nothing matches well enough.

The similarity setting decides how close two lines must be. If it is too strict, one message family becomes many templates. If it is too loose, different messages are incorrectly merged.

Drain may give a template a local number such as `42`. That number is useful only inside that one Drain state. Another Drain worker may also use `42` for completely different text.

Logsift therefore creates a template fingerprint. A fingerprint is a stable identifier calculated from the final template text and the fingerprint version:

```text
fingerprint = SHA-256(fingerprint_version + "\n" + canonical_template_text)
```

SHA-256 is the hash method used to turn the template text into a repeatable fixed-length identifier.

The same template text produces the same fingerprint when the fingerprint version is the same. Logsift compares this fingerprint instead of comparing Drain's local number.

Stage, node, attempt, and branch class are not part of the fingerprint. They are stored with each occurrence and its statistics. This allows one template to be used in several stages while still keeping different counts for each stage.

Example:

```text
Canonical template: Downloaded <ARTIFACT> in <DURATION>
Fingerprint:        sha256:v1:52b7...

Main/build statistics:    usually 1 occurrence
Main/test statistics:     usually 0 occurrences
Release/build statistics: usually 2 occurrences
```

The failed run uses the same saved rules and Drain settings as the baseline. It may find known templates or create temporary failed-run templates, but it never changes the successful baseline or its Drain state.

#### 3.1.8 Files produced and their purpose

A published baseline version has three main files: `baseline.json`, `templates.json`, and `state.json`. A small `current.json` file points to the latest complete version.

| File | Stored where | What it contains | Used later by |
|---|---|---|---|
| `baseline.json` | Baseline version folder | Says which repository and source the baseline belongs to, which successful events built it, and which processing versions were used | Finds a compatible baseline and checks that it is complete |
| `templates.json` | Baseline version folder | Stores template text, fingerprints, counts, branch class, stage or node statistics, order information, and small event references | LogDiff |
| `state.json` | Baseline version folder | Stores the saved Drain settings and parsing tree, including the mapping from local Drain IDs to fingerprints | Parses later runs with the same Drain setup |
| `current.json` | Baseline key folder | Points to the newest complete baseline version | Baseline lookup |
| `segment-groups.json` | Failed-run folder; optional short-lived success-run folder | Maps stages or node attempts to their logical order and raw-log ranges | Sets safe boundaries for failed-run expansion; helps validate successful-run grouping |
| `sidecar-index.json` | Failed-run folder; optional short-lived success-run folder | Maps individual indexed lines to segments, logical positions, byte ranges, and fingerprints | Finds failed-run candidate occurrences and raw ranges; may support success-run audit or replay |
| Restricted raw log | Protected source-log storage | Stores the original uploaded log text when retention policy allows it | Supplies failed-log ranges selected for expansion; a successful raw log is not required by LogDiff |

The example `normalized.json`, `redacted.json`, and `masked.json` files make each processing step easy to see. They do not all need to be stored permanently. Normalized text can still contain secrets, so it should remain only in small, limited worker memory or a tightly restricted temporary area. It must never be copied into the baseline.

The recommended storage layout is shown below. The baseline folder is required. A successful run's `runs/` folder is optional after publication. A failed run keeps its run folder and restricted raw log until analysis and the configured retention period finish.

```text
baselines/
└── {seal_id}/{project_id}/{repo_id}/{source_type}/
    ├── current.json
    └── versions/{baseline_version}/
        ├── baseline.json
        ├── templates.json
        └── state.json

runs/
└── {seal_id}/{project_id}/{repo_id}/{source_type}/{run_id}/{log_object_id}/
    ├── event.json
    ├── segment-groups.json
    └── sidecar-index.json

restricted-logs/
└── {seal_id}/{run_id}/{log_object_id}
```

The final `templates.json` also keeps small event references such as `event_id`, `run_id`, `pipeline_id`, `branch_class`, `commit_sha`, and observation time. It must not copy the complete event into every template.

#### 3.1.9 Baseline key and main/master fallback

The baseline family key is exactly:

```text
seal_id + project_id + repo_id + source_type
```

Example:

```text
seal101/payments/payment-api/JULES
```

Stage, node, branch, run, and pipeline details are stored inside this baseline family. They are not added to the key.

Logsift must never fall back to a global template from another repository. The safe fallback stays inside the same four-part key.

There is already one shared template catalog for that repository and source type. Branch fallback therefore applies only to counts and ordering statistics. It does not switch to a different template catalog.

Lookup order for LogDiff is:

1. Use the failed run's `seal_id + project_id + repo_id + source_type`.
2. Find the newest complete baseline whose rules and Drain versions match the failed run.
3. Use statistics from the same branch class when they are available.
4. If configured, use `main` or `master` statistics when the matching branch-class statistics are missing.
5. If the fingerprint is not in the shared catalog, mark it as a new template. Do not search another repository or source type.

If a new fingerprint appears in a trusted successful run, Logsift can add it in a new baseline version after validation. If it appears in a failed run, LogDiff records it as one candidate reason. Candidate discovery then combines that reason with keyword and log-tail results. A failed run never updates the baseline.

If the processing versions do not match, or the baseline does not have enough trusted successful runs, Logsift should stop the normal comparison and report that no compatible baseline was found.

#### 3.1.10 Worked Jules example

All credentials and identifiers in these files are synthetic test data.

The Jules example is a successful sequential run with `build`, `test`, and `package` stages:

- [raw.log](examples/offline-flow/jules/raw.log) contains the original sample, including synthetic URL credentials and a synthetic access token.
- [normalized.json](examples/offline-flow/jules/normalized.json) removes presentation noise and extracts the Jules envelope.
- [redacted.json](examples/offline-flow/jules/redacted.json) removes the synthetic credentials and token.
- [masked.json](examples/offline-flow/jules/masked.json) replaces changing build, UUID, IP, duration, hash, count, and temporary-path values.
- [segment-groups.json](examples/offline-flow/jules/segment-groups.json) shows how the successful events were grouped by sequential stage and attempt. This educational file may be short-lived in production.
- [sidecar-index.json](examples/offline-flow/jules/sidecar-index.json) shows how each template occurrence can be mapped to the exact Jules line, byte range, and stage-local sequence. Keeping this success-run file permanently is optional.
- [templates.json](examples/offline-flow/jules/templates.json) contains the repository-level template catalog and main-branch scope statistics.
- [baseline.json](examples/offline-flow/jules/baseline.json) describes the published version and its compatibility contract.
- [state.json](examples/offline-flow/jules/state.json) contains simplified Drain state.

One line changes as follows:

```text
Raw
[stage=build] Downloading https://demo-user:demo-pass@packages.example.test/payment-api/a81fd9.jar in 812ms

Normalized
Downloading https://demo-user:demo-pass@packages.example.test/payment-api/a81fd9.jar in 812ms

Redacted
Downloading https://<REDACTED_CREDENTIAL>@packages.example.test/payment-api/a81fd9.jar in 812ms

Masked
Downloading https://<REDACTED_CREDENTIAL>@packages.example.test/payment-api/<ARTIFACT_HASH>.jar in <DURATION>

Drain template
Downloading https://<REDACTED_CREDENTIAL>@packages.example.test/payment-api/<ARTIFACT_HASH>.jar in <DURATION>
```

The example index record retains the raw-log pointer while the file exists. The secret does not appear in the index or baseline. The segment-aware counts remain in `templates.json` even if the temporary success sidecar is later removed.

#### 3.1.11 Worked Lattice example

The Lattice example is a successful DAG run. Output from `test:integration`, `security-scan`, and `package` is physically interleaved:

- [raw.log](examples/offline-flow/lattice/raw.log) contains the interleaved source lines and a synthetic bearer token.
- [normalized.json](examples/offline-flow/lattice/normalized.json) extracts node, attempt, and node-local sequence.
- [redacted.json](examples/offline-flow/lattice/redacted.json) removes the bearer token.
- [masked.json](examples/offline-flow/lattice/masked.json) replaces changing values while keeping node identity.
- [segment-groups.json](examples/offline-flow/lattice/segment-groups.json) shows how noncontiguous physical fragments are joined for each node attempt. This educational file may be short-lived in production.
- [sidecar-index.json](examples/offline-flow/lattice/sidecar-index.json) shows how physical line order and node-local logical order can both be recorded. Keeping this success-run file permanently is optional.
- [templates.json](examples/offline-flow/lattice/templates.json), [baseline.json](examples/offline-flow/lattice/baseline.json), and [state.json](examples/offline-flow/lattice/state.json) show the three core baseline artifacts.

For example, physical lines 3, 5, 7, 9, and 11 belong to the same `test:integration` node attempt. During success processing, that relationship produces node-local counts and order statistics in `templates.json`. A future failed run creates its own segment map and sidecar, which let a candidate on line 9 expand inside the same node without pulling in nearby `security-scan` or `package` output.

#### 3.1.12 End-to-end result

After offline learning publishes a baseline, Logsift must keep:

- `baseline.json` to describe the baseline and its processing versions;
- `templates.json` to store normal templates, fingerprints, counts, and ordering information;
- `state.json` to store the compatible Drain setup.

Logsift may also keep the successful run's `segment-groups.json`, `sidecar-index.json`, and protected raw-log reference for a short time when audit, validation, or replay needs them. They are not required for normal LogDiff or for expanding a different failed run.

When a future run fails, it creates its own segment file and sidecar index using the same processing rules. LogDiff compares the failed template summary with `templates.json`. Candidate discovery then merges LogDiff results with configured failure-keyword and source-aware log-tail results. Logsift uses the failed sidecar to turn the merged occurrence IDs into candidate references, reads the correct failed-run segment, and retrieves only the required raw-log ranges.

In short:

```text
baseline templates = what is normally expected
failed sidecar      = where the suspicious lines are
failed segments     = which nearby lines belong together
failed raw log      = the actual text to retrieve
```

### 3.2 Failure analysis flow

Failure analysis starts when a pipeline reaches a failed final state and its log upload is complete. The failed log goes through the same source detection, normalization, redaction, masking, segmentation, and Drain processing used by offline learning.

Using the same process is important because LogDiff can make a fair comparison only when the successful baseline and the failed run use compatible rules and parser versions. A failed run can use the saved Drain state to recognize known templates, but it never changes that state and never updates the success baseline.

```text
Failed final event
  -> detect Jules or Lattice
  -> normalize
  -> redact
  -> mask
  -> segment by Jules stage or Lattice node and attempt
  -> create templates and stable fingerprints
  -> keep the failed segment map, sidecar index, and raw-log reference
  -> compare the failed summary with the compatible success baseline
  -> merge LogDiff, failure-keyword, and source-aware log-tail results
  -> locate the merged suspicious occurrences in the failed sidecar
  -> expand and build evidence blocks
```

#### 3.2.1 What must be processed and what must be kept

The main difference between the two flows is not how they read a log. The difference is what they keep after processing.

| Item | Successful run | Failed run | Reason |
|---|---|---|---|
| Source detection | Required | Required | Jules stages and Lattice nodes must be handled differently. |
| Normalize, redact, and mask | Required | Required | Template fingerprints are comparable only when both sides use the same rules. |
| Segmentation | Required | Required | The baseline needs normal stage-or-node statistics, and the failed run needs safe expansion boundaries. |
| Drain and fingerprints | Required | Required | LogDiff compares stable fingerprints and their statistics. |
| Full `segment-groups.json` after processing | Optional and usually short-lived | Required during analysis | A success baseline keeps the result of segmentation in its scope statistics. A failed run needs the detailed map for expansion. |
| Full `sidecar-index.json` after processing | Optional and usually short-lived | Required during analysis | A successful sidecar may help audit or replay. A failed sidecar locates suspicious lines and their exact byte ranges. |
| Raw log after processing | Not required by the baseline; follow source or audit retention | Required while evidence can be expanded | Evidence text comes from the failed log, not from an earlier successful log. |
| Published baseline | Created or updated only by an eligible success | Read-only | Failures compare with it but never teach it. |

##### Why segmentation is required for successful runs

The template catalog is stored at repository level, but normal behaviour is not always the same in every part of a pipeline.

Suppose this template is present in the catalog:

```text
Downloaded <ARTIFACT> in <DURATION>
```

It may normally appear once in the Jules `build` stage and never in `test`. If a failed run produces it twenty times in `test`, a repository-wide count alone hides useful information. Segmentation lets the success baseline store both facts:

```text
build: usually 1
test:  usually 0
```

The fingerprint remains the same because the message is the same. Stage or node is not added to the fingerprint. Instead, `templates.json` stores separate counts and order information for each scope.

Lattice needs the same idea for a different reason. Lines from several DAG nodes may be mixed together in the physical log. Segmentation rebuilds the logical order inside each `node + attempt`. That gives LogDiff a useful normal sequence instead of one misleading physical sequence.

So the rule is simple:

```text
success segmentation is required
permanent success segment file is optional
```

##### Why a successful-run sidecar is optional

Logsift still tracks line number, byte position, segment, logical order, and fingerprint while reading a successful log. It needs this information long enough to calculate the correct counts and order statistics.

However, future failure analysis does not expand the successful log. It expands the current failed log. Once `templates.json` has been published safely, Logsift may remove the successful run's detailed line records.

A team may keep the success sidecar for a short time when it wants to:

- check why a template entered the baseline;
- test a new normalization or masking rule;
- replay a baseline build after a processing error;
- audit an incorrect or poisoned baseline.

These are useful operational choices, but they are not required for normal LogDiff. A simple first version can stream the successful log, aggregate small stage-or-node statistics, publish the baseline, and delete the temporary occurrence records.

##### Why the failed-run sidecar is required

LogDiff first works with summaries. It may decide that fingerprint `fp-timeout` is new in the failed run or appears too often in one stage. A summary can tell us that something is unusual, but it cannot provide the surrounding lines.

The failed sidecar connects that summary back to the failed raw log:

```text
LogDiff selects fp-timeout in test
  -> failed sidecar finds lines 405 and 622
  -> candidate pool stores small references to those lines
  -> failed segment map keeps expansion inside test
  -> byte pointers read only the required failed-log ranges
  -> expanded lines become evidence blocks
```

This is why the failed sidecar and failed segment map must remain available until the analysis and its retention period finish.

##### Final design decision

The offline flow keeps segmentation because the baseline needs scope-aware counts and order. It does not require a permanent raw-log store or full sidecar for every successful run.

The failure flow creates and keeps its own segment map, sidecar index, and raw-log reference. Those failed-run artifacts—not the successful-run artifacts—are used by the candidate pool and content expansion.

The solution diagrams should follow the same rule:

- keep **Segmentation** in the offline learning lane;
- show the successful-run sidecar as **optional and short-lived**, if it is shown at all;
- keep the durable raw-log and sidecar lookup beside the failure-analysis lane;
- connect baseline template statistics to LogDiff;
- connect the failed raw log and failed sidecar to content expansion.

#### 3.2.2 LogDiff: find what changed

LogDiff compares the failed run with a compatible success baseline. It does not compare two complete raw logs line by line.

Its main inputs are:

- the success template catalog and normal counts for the matching branch class and stage or node;
- the failed run's templates, fingerprints, counts, order, and safe numeric features;
- the failed sidecar records that map a fingerprint back to exact failed-log locations.

The raw failed log is not read during the main comparison. It is read later, after candidate discovery has selected suspicious occurrences.

##### Check compatibility first

Logsift resolves the baseline with:

```text
seal_id + project_id + repo_id + source_type
```

It then checks the source schema, normalization, redaction, masking, segmentation, Drain, and fingerprint versions. If these do not match, Logsift should stop the normal template comparison. Otherwise, a rule change could make thousands of normal templates look new.

##### Compare template to template

LogDiff performs these steps:

1. Read one failed fingerprint.
2. Look for the same stable fingerprint in the compatible repository template catalog.
3. If it exists, compare its count, normal position, severity, and safe numeric features inside the same stage or node.
4. If it exists in the catalog but not in this stage or node, mark it as an unusual scope.
5. If it does not exist in the catalog, mark it as a new template.
6. Check which normally expected templates are missing.
7. Copy strong results back to the failed occurrence IDs stored in the sidecar.

Drain's local numeric template ID is never used for comparison. The stable fingerprint identifies the message. Stage, node, branch class, and attempt remain separate fields used for counts and order.

LogDiff can produce these results:

| Result | Simple meaning |
|---|---|
| Match | The same message is normally seen in this scope. It is less surprising, but it is not automatically removed. |
| New template | The fingerprint is not in the compatible repository catalog. |
| Missing template | A normal success message did not appear. It may be missing because the run stopped early. |
| Frequency shift | A known message appeared more or less often than its normal range. |
| Wrong scope | A known message appeared in an unusual stage or node. |
| Order change | Messages appeared in an unusual stage-local or node-local order. |
| Severity change | A preserved status or exit changed from normal to failure behaviour. |
| Parameter shift | A safe value such as duration, memory, or count moved outside its normal range. |

##### Realistic Jules comparison

The worked example uses a successful `test` baseline and a failed Jules run with two test attempts. The complete inputs are [baseline-template-summary.json](examples/failure-analysis/jules/baseline-template-summary.json) and [failed-template-summary.json](examples/failure-analysis/jules/failed-template-summary.json).

The normal `test` stage contains:

| Template | Normal count per attempt |
|---|---:|
| `Starting test request <REQUEST_ID>` | 1 |
| `Connecting to payments-db` | 1 |
| `Connection attempt <COUNT> failed` | 0 to 1 |
| `PaymentServiceTest ... failed=0` | 1 |
| `Worker exited code=0` | 1 |

The failed run produces two test attempts. Each attempt contains two connection failures, a timeout, 37 failed tests, and exit code 1.

| Failed template | Baseline | Failed run | LogDiff result |
|---|---:|---:|---|
| `Starting test request <REQUEST_ID>` | 1 per attempt | 1 per attempt | Match |
| `Connecting to payments-db` | 1 per attempt | 1 per attempt | Match |
| `Connection attempt <COUNT> failed` | At most 1 | 2 per attempt | Frequency shift |
| `TimeoutError after <DURATION> request=<REQUEST_ID>` | 0 | 1 per attempt | New error template |
| `PaymentServiceTest ... failed=<NONZERO_COUNT>` | 0 | 1 per attempt | New failure state |
| `Worker exited code=1` | 0 | 1 per attempt | New terminal failure |
| `PaymentServiceTest ... failed=0` | 1 per attempt | 0 | Missing success state |
| `Worker exited code=0` | 1 per attempt | 0 | Missing success end |

The full output is [logdiff-output.json](examples/failure-analysis/jules/logdiff-output.json).

The missing success messages support the failure story, but they do not point to a failed-log line because no such line exists. The timeout, failed-test summary, nonzero exit, and unusual retry count do have failed-run occurrences, so LogDiff contributes those occurrences to candidate discovery. The keyword and log-tail routes are then merged with them before the candidate pool is written.

#### 3.2.3 Candidates, candidate regions, and the candidate pool

These three terms describe different things.

| Term | What it means | Contains log text? |
|---|---|---|
| Candidate | One suspicious occurrence, or a small group of repeated occurrences, with exact source pointers and reasons | No |
| Candidate region | A planned source area around one or more nearby candidates; normally logical, but physical in fallback mode | No |
| Candidate pool | The isolated storage area holding all candidate records for one analysis | No |

##### Candidate discovery uses three routes

LogDiff is only one way to find a useful line. Logsift uses three routes and then joins their results:

| Route | What it finds | Why it is needed |
|---|---|---|
| LogDiff | New templates, frequency changes, wrong scope, order changes, failure states, and important parameter changes | Finds behaviour that is different from compatible successful runs |
| Failure keywords | Protected lines containing configured terms such as `error`, `fatal`, `panic`, `exception`, `timeout`, `failed`, or a nonzero exit | Keeps an obvious failure even when its template was also seen in a successful run |
| Log tail | The final configured lines of the failed or terminal stage or node | Provides a fallback route to the final status when a tool stops without producing a new template or clear keyword |

The keyword rules run on redacted and masked text. They use complete words or configured phrases, not broad substring matches. For example, a rule for `fail` must not accidentally match an unrelated word. The keyword list, tail size, and source-specific rules belong in [candidate-expansion-policy.yaml](examples/failure-analysis/candidate-expansion-policy.yaml).

The tail is source-aware:

- For Jules, it means the final logical lines of the failed stage attempt.
- For Lattice, it means the final logical lines of a failed or terminal node attempt. It does not use nearby physical lines from another parallel node.

While the failed log is streamed, the index builder records keyword rule IDs and keeps a small tail buffer for each active scope. It writes only flags and pointers to the sidecar; it does not copy the full line into the index. LogDiff runs after the failed template summary is ready. Candidate discovery then joins all three routes by `occurrence_id`.

If two or three routes select the same occurrence, Logsift creates one candidate and keeps every reason:

```text
occ-f-7
  selected by LogDiff: new template
  selected by keyword rule: timeout
  result: one candidate with both reasons
```

A matching template is less surprising, but it is not automatically deleted. A keyword or tail rule may still keep one of its occurrences.

For example, imagine that a successful baseline already contains `ERROR optional report upload failed`. If the same template appears in a failed run, LogDiff may mark it as a normal match. The keyword route can still select that occurrence because it contains the configured word `error`. In the same way, a final line such as `Process finished status=1` can be selected by the log-tail route even when no new template was created. Later scoring decides whether either line is actually useful.

The complete union for the Jules example is [candidate-discovery-output.json](examples/failure-analysis/jules/candidate-discovery-output.json).

| Detector | Selected occurrences |
|---|---:|
| LogDiff | 10 |
| Failure keywords | 6 |
| Two-line tail of each failed attempt | 4 |
| Unique occurrences after merging | 10 |

The counts overlap. They must not be added together. This particular worked run does not gain an extra unique occurrence from the keyword or tail routes because all six keyword matches and all four tail lines were also selected by LogDiff. The separate routes still keep their reason codes and protect other runs where LogDiff alone would miss a useful line.

The raw example has one source-envelope line followed by 15 pipeline log lines. The envelope is parsed separately, so `processed_log_line_count` is `15` in the candidate-discovery output.

##### Adaptive candidate line weights

Candidate discovery may return ten useful lines or thousands of noisy lines. Logsift uses a small adaptive weight to tell those cases apart before content expansion.

Let:

- `C` be the number of unique candidate occurrences;
- `L` be the number of processed log lines;
- `r = C / L` be the candidate ratio.

The recommended starting rule is:

```text
focused mode: C <= 500 and r <= 0.70  -> base candidate weight 3
broad mode:   otherwise               -> base candidate weight 1
normal line:                           -> weight 0
```

These limits are configuration, not hard-coded behaviour. Strong signals can increase the weight:

- a configured failure keyword adds `2`;
- a strong terminal marker such as a nonzero exit, fatal error, or panic receives weight `10`;
- the final weight is always between `0` and `10`.

In focused mode, Logsift expands every candidate. In broad mode, it normally expands candidates with weight `3` or more, plus required terminal evidence. Lower-weight candidates remain in the candidate pool for audit and later policy decisions; they are not silently lost.

The Jules example has 10 unique candidate occurrences among 15 processed log lines:

```text
r = 10 / 15 = 0.667
```

It therefore uses focused mode. Retry lines have weight `3`, timeout and failed-test lines have weight `5`, and nonzero exits have weight `10`. These weights later help form candidate regions and calculate evidence-block density. They are not the final evidence score.

##### What a candidate stores

A candidate does not copy the timeout line. It stores enough information to find that line again:

```json
{
  "analysis_id": "analysis-01HX",
  "candidate_id": "cand-a1-timeout",
  "run_id": "run-f-9001",
  "log_object_id": "log-f-9001-v1",
  "segment_id": "seg-f-test-1",
  "scope": {"kind": "stage", "name": "test", "attempt": 1},
  "template_fingerprint": "sha256:v1:c3daa806...",
  "selected_by": ["logdiff", "failure_keyword"],
  "reasons": ["new_template", "failure_keyword:timeout"],
  "line_weight": 5,
  "selected_for_expansion": true,
  "physical_line": 7,
  "logical_sequence": 5,
  "byte_start": 415,
  "byte_end": 500
}
```

Each pointer has one job:

| Pointer | What it identifies |
|---|---|
| `run_id` | The failed pipeline run |
| `log_object_id` | The exact stored version of that run's log |
| `segment_id` | The Jules stage attempt or Lattice node attempt |
| `physical_line` | The line's position in the uploaded log |
| `logical_sequence` | The line's order inside its stage or node |
| `byte_start` and `byte_end` | The exact half-open byte range to read from the raw-log object |
| `template_fingerprint` | The protected template for this occurrence; it may be selected by LogDiff, a keyword, or the tail |

`analysis_id` does not locate the log. It keeps the state of one analysis separate from every other analysis.

For example, two analyses can inspect the same immutable failed log:

```text
analysis-01HX -> candidates, regions, blocks, and dedup results for request A
analysis-02KY -> candidates, regions, blocks, and dedup results for request B
```

Both may read `log-f-9001-v1`, but their mutable records never mix because every candidate, lease, region, block, and result includes its own `analysis_id`.

The complete example is [candidate-pool.json](examples/failure-analysis/jules/candidate-pool.json). It contains eight candidate records. There are ten unique suspicious occurrences because the two retry pairs are stored as two small occurrence groups instead of four separate expansion jobs.

##### What a candidate region is

Several candidates are often close to each other. Expanding each one separately would read the same bytes many times.

In test attempt 1, the retry, timeout, failed-test summary, and exit candidates have overlapping windows. Logsift merges those planned windows into one candidate region:

```text
segment:       seg-f-test-1
logical range: 1 to 7
physical lines: 3 to 9
byte range:    [127, 663)
```

This region is still only a read plan. It does not contain log text. It says which protected raw-log area should be fetched and where expansion must stop.

The two test attempts become two regions in [candidate-regions.json](examples/failure-analysis/jules/candidate-regions.json). They are not merged at this stage because they belong to different attempts.

The candidate-pool JSON shape and its storage service are recommended starting designs. Their final implementation contract is not defined yet.

#### 3.2.4 Indexed content expansion

Content expansion turns a small candidate pointer into useful surrounding text. It uses three failed-run artifacts:

| Artifact | Question it answers |
|---|---|
| `sidecar-index.json` | Where is this exact occurrence, and what is its logical position? |
| `segment-groups.json` | Which lines belong to the same stage or node attempt, and where must expansion stop? |
| Failed raw log | What is the actual text in the selected byte ranges? |

The recommended starting window is four logical lines before a candidate and six logical lines after it. More lines are kept after the candidate because exception details, failed-test summaries, and terminal exits often follow the first error. The values are configurable in [candidate-expansion-policy.yaml](examples/failure-analysis/candidate-expansion-policy.yaml).

The expansion flow is:

1. Load a candidate using its `analysis_id` and `candidate_id`.
2. Check that its seal, repository, run, and exact log object belong to the analysis. If a segment is present, validate that too.
3. Use the failed sidecar to confirm the occurrence, physical line, and byte range. Confirm the logical sequence when one is available.
4. Choose the expansion mode. Use segment-aware expansion only when the segment is trusted; otherwise use the marked physical fallback.
5. In normal mode, add up to four logical lines before and six logical lines after, then stop at the current Jules stage attempt or Lattice node attempt.
6. In fallback mode, add up to four physical lines before and six after, stop at any boundary that can be proved, and mark the fragment as lower confidence.
7. Extend beyond the basic window only when needed to finish a stack trace, failed test, retry chain, or correlated request and when the chosen mode can do so safely.
8. Merge overlapping windows only when they use the same expansion mode and belong to the same trusted segment or proven physical scope.
9. Convert the planned region into one or more physical byte ranges and range-read only those bytes from the failed raw log.
10. Reapply redaction before writing derived text.
11. Store the retrieved pieces as expanded fragments with exact provenance and the expansion mode used.

The complete raw log and complete segments are never loaded into the worker's memory.

##### Normal expansion and safe fallback

Logsift uses two expansion modes:

| Mode | When it is used | How it reads |
|---|---|---|
| Segment-aware logical window | The Jules stage or Lattice node was identified confidently | Selects four logical lines before and six after, stays inside the same attempt, and follows node-local order for Lattice |
| Physical-window fallback | A candidate has an exact raw pointer but its logical segment is missing or has low confidence | Reads four physical lines before and six after, stops at any boundary it can prove, and marks the result as lower confidence |

The fallback is a safety net, not the preferred Lattice path. It must never pretend that interleaved physical lines belong to one node. A fallback fragment records `expansion_mode: physical_window_fallback`, the reason for the fallback, and every physical range used.

[fallback-expanded-fragment.json](examples/failure-analysis/jules/fallback-expanded-fragment.json) shows the fallback shape. It reuses an exact failed-log pointer, reads four physical lines before and six after, clips the read at a boundary proven by the source envelope, and marks the result as lower confidence. It is a separate illustration; the main Jules worked run uses normal segment-aware expansion.

If a stack trace or multiline error reaches the edge of the normal window, Logsift may extend to the complete structure while respecting the maximum block size. If the end of the stage or node is reached first, the window is clipped. Fewer than four lines before or six lines after is therefore normal near a boundary.

In the Jules example, the candidate windows overlap. After clipping them to each test-attempt boundary, they become two seven-line regions in [candidate-regions.json](examples/failure-analysis/jules/candidate-regions.json). This avoids reading the same bytes once for the timeout, again for the failed-test summary, and again for the exit.

##### What an expanded fragment is

A fragment is the protected result of one selected raw-log range. It is an intermediate object, not the final evidence block. It keeps the retrieved lines together with their physical and logical positions.

For Jules, a stage attempt is normally physically continuous. Test attempt 1 therefore needs one range read:

```text
bytes [127, 663) -> physical lines 3 to 9 -> logical lines 1 to 7
```

The result is `fragment-test-attempt-1` in [Jules expanded-fragments.json](examples/failure-analysis/jules/expanded-fragments.json).

For Lattice, useful node lines can be separated by lines from other nodes. The failed `test:integration` node owns physical lines 2, 4, 6, 8, and 10. Lines 3, 5, 7, and 9 belong to `security-scan` or `package`.

Logsift therefore performs several small reads and creates a fragment group:

```text
physical: 2, 4, 6, 8, 10
logical:  1, 2, 3, 4, 5
```

It assembles the five pieces in node-local order without claiming that they were physically next to each other. See [Lattice segment-groups.json](examples/failure-analysis/lattice/segment-groups.json), [Lattice sidecar-index.json](examples/failure-analysis/lattice/sidecar-index.json), and [Lattice expanded-fragments.json](examples/failure-analysis/lattice/expanded-fragments.json).

This is the main source difference:

- Jules expansion normally returns one continuous stage fragment.
- Lattice expansion may return several physical fragments that form one logical node story.

#### 3.2.5 From fragments to evidence blocks

An evidence block is a small, readable failure story created from one or more expanded fragments. It is the unit that later stages deduplicate, score, rank, select, and cite.

A block should:

- stay inside the correct stage or node attempt unless an explicit dependency rule allows more context;
- merge overlapping fragments from nearby candidates;
- keep a stack trace, exception chain, failed-test result, or retry chain together;
- preserve both logical order and original physical ranges;
- stop at a clear boundary or configured size limit;
- say when content is truncated, incomplete, or unavailable.

In the Jules example, four nearby candidate records in attempt 1 become one block:

```text
Starting test request <REQUEST_ID>
Connecting to payments-db
Connection attempt 1 failed
Connection attempt 2 failed
TimeoutError after 40.0s request=<REQUEST_ID>
PaymentServiceTest passed=87 failed=37 duration=41.8s
Worker exited code=1
```

Attempt 2 produces the same story in a second block. The two records before deduplication are in [log-blocks-before-dedup.json](examples/failure-analysis/jules/log-blocks-before-dedup.json).

##### Deduplicate without losing provenance

Deduplication removes repeated evidence, not history. It runs in simple levels:

1. **Same occurrence:** one source line selected by several rules becomes one candidate with several reason codes.
2. **Overlapping regions:** nearby candidate windows in the same segment become one region and one read plan.
3. **Exact block:** identical protected blocks become one representative block.
4. **Canonical block:** blocks that differ only in masked values can be grouped while keeping useful parameter examples.
5. **Template sequence:** repeated retry attempts with the same ordered template pattern can be compressed.
6. **Near duplicate:** very similar blocks may be grouped only when a safe threshold and the same logical scope allow it.

Do not blindly merge the same text across different Jules stages or Lattice nodes. The same message can have a different meaning in a different scope.

When blocks are collapsed, Logsift must keep:

- total occurrence count;
- first and last occurrence;
- every affected stage, node, and attempt;
- all raw-log line and byte ranges;
- one or more representative examples;
- the method that caused the blocks to be grouped.

In this example, the two test attempts have the same protected content and template sequence. Deduplication keeps one representative story but records `occurrence_count: 2`, both attempts, and both raw ranges. The result is [log-blocks-after-dedup.json](examples/failure-analysis/jules/log-blocks-after-dedup.json).

Before and after:

| Before deduplication | After deduplication |
|---|---|
| 2 similar evidence blocks | 1 representative evidence block |
| Attempt 1 stored separately | `occurrence_count: 2` |
| Attempt 2 stored separately | Both attempts retained in `affected_scopes` |
| One raw range on each block | Both raw ranges retained in `all_source_ranges` |
| Repeated story shown twice | Story shown once with representative examples |

#### 3.2.6 End-to-end example and stage outputs

The full Jules example follows this path:

```text
failed-raw.log
  -> failed-template-summary.json
  -> LogDiff result
  -> LogDiff + keyword + log-tail candidate discovery
  -> candidate pool
  -> merged candidate regions
  -> indexed raw-log range reads
  -> expanded fragments
  -> evidence blocks
  -> deduplicated evidence blocks
```

The number of objects changes as the flow becomes more useful:

```text
10 suspicious physical occurrences
  -> 8 candidate records
  -> 2 candidate regions
  -> 2 expanded Jules fragments
  -> 2 evidence blocks
  -> 1 deduplicated block with occurrence_count=2
```

Each stage adds something new:

| Stage | What existed before | What this stage adds | Output example |
|---|---|---|---|
| LogDiff | Baseline and failed template summaries | Difference reasons and selected occurrence IDs | [logdiff-output.json](examples/failure-analysis/jules/logdiff-output.json) |
| Candidate discovery | LogDiff results, keyword flags, and tail pointers | One merged occurrence set with adaptive line weights | [candidate-discovery-output.json](examples/failure-analysis/jules/candidate-discovery-output.json) |
| Candidate pool | Suspicious occurrence IDs | Isolated immutable references, reasons, and exact pointers | [candidate-pool.json](examples/failure-analysis/jules/candidate-pool.json) |
| Candidate regions | Separate candidate windows | Merged four-before/six-after read plans; normal plans stop at a segment boundary and fallback plans stop at a proven physical boundary | [candidate-regions.json](examples/failure-analysis/jules/candidate-regions.json) |
| Content expansion | Pointer-only regions | Protected log text retrieved from exact raw ranges | [expanded-fragments.json](examples/failure-analysis/jules/expanded-fragments.json) |
| Log-block building | Individual fragments | Complete, ordered failure stories with provenance | [log-blocks-before-dedup.json](examples/failure-analysis/jules/log-blocks-before-dedup.json) |
| Deduplication | Repeated failure stories | One representative story plus counts and every original location | [log-blocks-after-dedup.json](examples/failure-analysis/jules/log-blocks-after-dedup.json) |

The example file structure is:

```text
examples/failure-analysis/
├── jules/
│   ├── failed-raw.log
│   ├── baseline-template-summary.json
│   ├── failed-template-summary.json
│   ├── segment-groups.json
│   ├── sidecar-index.json
│   ├── logdiff-output.json
│   ├── candidate-discovery-output.json
│   ├── candidate-pool.json
│   ├── candidate-regions.json
│   ├── expanded-fragments.json
│   ├── fallback-expanded-fragment.json
│   ├── log-blocks-before-dedup.json
│   └── log-blocks-after-dedup.json
└── lattice/
    ├── failed-raw.log
    ├── segment-groups.json
    ├── sidecar-index.json
    └── expanded-fragments.json
```

##### Important notes

- Candidates come from the union of LogDiff, configured failure keywords, and the source-aware log tail. One occurrence selected by several routes remains one candidate with several reasons.
- LogDiff candidates are not only unmatched templates. Frequency shifts, nonzero exits, wrong scope, unusual order, and important parameter changes can also create them.
- Adaptive line weights control which candidates are expanded when candidate discovery is very noisy. They do not replace the later evidence-block score.
- A segment and a fragment are different. A segment defines a Jules stage-attempt or Lattice node-attempt boundary. A fragment is the actual protected content fetched from one selected raw-log range.
- The normal expansion seed is four logical lines before and six after. A marked physical-window fallback is used only when reliable logical segmentation is unavailable.
- Content expansion uses the failed run's sidecar index and segment map. It does not use a successful run's index to expand failed-log evidence.
- Deduplication does not simply delete repeated evidence. It keeps the occurrence count, first and last occurrence, affected stages or nodes, representative examples, and every original raw-log location.

#### 3.2.7 Score and rank evidence blocks

After deduplication, Logsift may still have many useful evidence blocks. Scoring answers one question:

```text
How useful is this block for explaining the current failure?
```

Scoring starts from the deduplicated block, all of its candidate-discovery reasons, its scope, its provenance, and the failed-run metadata. It does not change the block text.

The exact scoring policy is not implemented yet. The following formula and configuration are a recommended starting point that can be measured and adjusted with real failures.

##### Line weight, block density, and final score

These are three different values:

| Value | Created when | Purpose |
|---|---|---|
| Candidate line weight | After the three candidate routes are merged | Controls early expansion when candidate discovery is noisy |
| Diagnostic block density | After expansion has built a block | Shows how much of the expanded block is made of candidate lines |
| Final evidence score | After deduplication | Ranks the block's overall value for explaining the failure |

Block density uses the candidate line weights already stored in the candidate pool:

```text
diagnostic density =
    sum of distinct candidate line weights in the block
    / number of expanded lines in the block
```

For normal segment-aware expansion, the denominator is the number of logical lines in the representative block. For a marked physical fallback, it is the number of physical lines that were read. An occurrence selected by two detectors is counted once using its final line weight.

Density is measured on the representative expanded block before retry compression, summaries, or token trimming. Duplicate copies do not increase it; their occurrence count is stored separately. Because line weights are between `0` and `10`, density is also between `0` and `10`.

In the Jules example, one expanded attempt contains seven logical lines. Its candidate lines have weights `3`, `3`, `5`, `5`, and `10`:

```text
diagnostic density = (3 + 3 + 5 + 5 + 10) / 7
                   = 26 / 7
                   = 3.71
```

Density is useful, but it does not prove that a block explains the failure. A repeated cache warning can have high density and still be unrelated. Logsift therefore uses density as a secondary ranking signal:

- required evidence always stays first;
- final evidence score remains the main ranking value;
- when two blocks have similar scores, the denser block is preferred;
- token selection may compact a very large, low-density block before a short, focused block.

The scoring record stores the line-weight sum, expanded line count, expansion order, and calculated density. This makes the ranking repeatable without changing the immutable evidence block.

##### Scoring factors

Each factor is converted to a number from `0.0` to `1.0`.

| Variable | Factor | What a high value means |
|---|---|---|
| `N` | Novelty | The template or failure state is new compared with compatible successful runs. |
| `S` | Severity | The block contains an error, failed test, exception, crash, or serious exit. |
| `F` | Frequency shift | The message count is far outside its normal successful range. |
| `P` | Failure proximity | The block is close to the first confirmed failure in logical order or time. |
| `G` | Scope relevance | The block belongs to the failed stage or node, or a directly related upstream scope. |
| `K` | Structured diagnostic | The block contains a complete stack trace, exception chain, compiler error, or failed-test diagnostic. |
| `C` | Correlation | The block refers to the same protected request, process, container, test, or dependency as the failure. |
| `Q` | Source confidence | Source detection, segmentation, provenance, and log completeness are reliable. |
| `R` | Repetition penalty | The block mainly repeats information already represented. |
| `D` | Duplicate-overlap penalty | Much of the block overlaps another stronger block. |

The recommended first formula is:

```text
score = 100 × clamp(
  0.22N + 0.22S + 0.12F + 0.12P
  + 0.10G + 0.08K + 0.08C + 0.06Q
  - 0.10R - 0.10D,
  0, 1)
```

`clamp` means that a result below `0` becomes `0`, and a result above `1` becomes `1`. The final score is therefore always between `0` and `100`.

The positive weights add to `1.0`. Repetition and duplicate overlap are penalties. A versioned rule may also add a small boost or mark a block as required.

##### Worked score calculation

For the primary timeout block, the weighted positive terms add to `0.917`:

```text
0.22(0.95) + 0.22(1.00) + 0.12(0.60) + 0.12(0.90)
+ 0.10(1.00) + 0.08(0.85) + 0.08(1.00) + 0.06(1.00)
= 0.917
```

Its penalties add to `0.015`:

```text
0.10(0.10) + 0.10(0.05) = 0.015
```

The base score is:

```text
100 × (0.917 - 0.015) = 90.2
```

The rule `boost-first-correlated-timeout` adds `5.0`, giving a final score of `95.2`.

##### Realistic scoring example

The scoring example begins with six already-deduplicated blocks in [unscored-log-blocks.json](examples/failure-analysis/scoring/unscored-log-blocks.json).

| Block | Density | Main reason | Final score |
|---|---:|---|---:|
| Primary database timeout and exception chain | 1.43 | New, severe, close, structured, and correlated | 95.2 |
| Failed-test summary | 2.00 | Definitive failure count, but overlaps the main story | 76.6 |
| Earlier database configuration | 0.60 | Adds upstream configuration evidence | 69.1 |
| Terminal exit code 1 | 6.50 | Definitive outcome, but partly a consequence | 61.3 |
| Repeated connection loop | 1.52 | Strong frequency shift with large repetition penalty | 46.6 |
| Repeated build-cache warning | 3.00 | Build succeeded and the warning is unrelated | 14.4 |

The highest-frequency or highest-density message is not automatically the highest-scoring evidence. The cache warning occurred 30 times and has density `3.00`, but it did not explain the database test failure. One correlated timeout is more useful.

##### Where scores are stored

Evidence blocks should remain immutable. Logsift stores scoring as a separate versioned record with this key:

```text
analysis_id + block_id + scoring_policy_version
```

The score record stores:

- all normalized factor values;
- the weights and penalties used;
- the candidate line-weight sum, expanded line count, expansion order, and diagnostic density;
- the base score;
- rule boosts, penalties, or required-inclusion decisions;
- the final score;
- a short explanation;
- full, compact, and summary token estimates.

Keeping scores separate means Logsift can test a new scoring policy without rewriting the original evidence block. [scored-log-blocks.json](examples/failure-analysis/scoring/scored-log-blocks.json) is a readable combined view of the blocks and their score records.

For Jules, scope relevance is calculated against the failed stage and attempt. For Lattice, it is calculated against the failed DAG node, attempt, and directly related parent or child nodes. The formula stays the same; the source adapter provides the correct scope relationship.

#### 3.2.8 Token optimization

Scoring ranks evidence. Token optimization decides what can actually fit into the model request.

A model context is shared by several sections. Logsift must reserve their space before selecting log evidence:

```text
log evidence budget = total model context
                    - instructions
                    - failure metadata and LogDiff
                    - retrieved knowledge and code
                    - model response
                    - safety margin
```

The recommended production starting profile is:

| Context user | Reserved tokens |
|---|---:|
| Total context | 32,000 |
| Instructions | 3,000 |
| Failure metadata and LogDiff | 2,000 |
| Retrieved knowledge and code | 6,000 |
| Model response | 5,000 |
| Safety margin | 2,000 |
| **Available log evidence** | **14,000** |

These values belong in a versioned configuration file, not in application code. The example is [scoring-token-policy.yaml](examples/failure-analysis/scoring/scoring-token-policy.yaml).

Logsift must count tokens with the tokenizer used by the target model. Character counts, file size, or `characters / 4` may be used for rough planning, but not for the final selection. The final assembly stores the tokenizer and policy versions so the choice can be reproduced.

##### Score does not directly decide token quantity

Logsift should not use a rule such as:

```text
block tokens = block score percentage × evidence budget
```

That would give large repeated blocks too much space and could cut small required blocks.

Instead, each block has several possible representations:

| Representation | Meaning |
|---|---|
| Full | Keep the complete selected evidence block. |
| Compact | Remove repeated envelopes or low-value middle content while keeping the important structure. |
| Summary | Keep the important facts, occurrence count, and exact source reference. |
| Omit | Do not place the block text in this request; keep its record and source reference. |

The selector considers score, required rules, token cost, evidence type, stage or node coverage, causal value, and overlap with already selected evidence.

This means a lower-scoring block can receive more tokens than a higher-scoring block when it adds a missing stage or a different kind of evidence. A lower-scoring terminal exit can also be required even when it mainly confirms an earlier error.

##### Selection steps

1. Calculate the log-evidence budget from the configured reservations.
2. Render every block in full, compact, and summary forms.
3. Count each form with the target model tokenizer, including its header and provenance.
4. Reserve the smallest safe form of required evidence first.
5. Prefer high-scoring causal and structured evidence.
6. Use diagnostic density and score per token as secondary checks so one large block does not consume the budget without adding enough value.
7. Add stage, node, and evidence-type diversity.
8. Reject near-duplicates already represented by a stronger block.
9. Upgrade important blocks from summary to compact or full while space remains.
10. Put the selected blocks into causal and chronological order for the final input.
11. Count the complete assembled request again. If it is too large, repeat safe compaction.

Selection order and presentation order are different. Logsift may select the timeout first because it scores highest, but present the earlier configuration block before it so the model reads the failure story in causal order.

##### Worked token-selection example

The worked profile deliberately leaves only `420` tokens for log evidence so the choices are easy to see.

| Block | Score | Full | Compact | Summary | Final choice |
|---|---:|---:|---:|---:|---|
| Primary timeout | 95.2 | 170 | 125 | 45 | Full: 170 |
| Failed-test summary | 76.6 | 75 | 55 | 30 | Summary: 30 |
| Upstream configuration | 69.1 | 130 | 90 | 40 | Compact: 90 |
| Terminal exit | 61.3 | 45 | 35 | 20 | Full: 45, required by policy |
| Retry loop | 46.6 | 190 | 65 | 28 | Summary: 28 |
| Cache warning | 14.4 | 260 | 70 | 25 | Omitted |

The selected evidence uses:

```text
170 + 30 + 90 + 45 + 28 = 363 tokens
```

This leaves `57` tokens of evidence headroom for final tokenizer differences or small provenance changes. The complete machine-readable decision is [token-selection.json](examples/failure-analysis/scoring/token-selection.json).

The failed-test block scores higher than the upstream configuration block but receives fewer tokens. Its outcome is already partly represented by the timeout chain, so a short summary is enough. The configuration block adds earlier and different evidence, so it receives the compact representation.

##### What happens when a block is too large

Yes, derived evidence may be shortened when the budget is too small. The restricted raw log is never trimmed or changed.

Safe compaction runs in this order:

1. Remove exact repeated blocks already handled by deduplication.
2. Compress retry loops while keeping the total count, first occurrence, last occurrence, and unusual attempts.
3. Remove repeated timestamps or source envelopes when the same information is already kept in provenance.
4. Keep the primary error, exception header, useful application frames, `caused by` chain, failed-test summary, and terminal state.
5. Split an oversized block only at a safe boundary such as an exception-chain boundary, retry iteration, subprocess transition, or complete log line.
6. If the useful structure still cannot fit, create a short summary and keep a pointer to the full block and raw-log ranges.
7. Add a clear notice describing what was compacted, summarized, or omitted.

Logsift must not cut in the middle of a UTF-8 character, log line, stack frame, JSON object, or exception message. It should never hide truncation.

If even the minimum required evidence cannot fit, Logsift should not silently remove it. It should remove optional blocks, use the smallest safe summaries, request a larger configured profile when available, or stop and report that the evidence budget is too small for a reliable analysis.

#### 3.2.9 Final LLM input

After token optimization, Logsift assembles the selected evidence with:

- the analysis task;
- pipeline and baseline metadata;
- the LogDiff summary;
- selected blocks in causal or chronological order;
- each block's score and selection reason;
- exact provenance;
- compaction and omission notices;
- the required response structure.

The complete worked request is [llm_input.md](examples/failure-analysis/scoring/llm_input.md). It shows the actual shape of the text passed to the model for this example.

The input includes full text for the primary timeout and terminal exit, compact configuration evidence, summaries for the retry loop and failed-test result, and a notice explaining why the unrelated cache warning was omitted. Every shortened or omitted block remains available through its stored block record and raw-log references.

In short:

```text
score          = how useful the evidence is
block density  = how concentrated its candidate signals are
token cost     = how much context its representation needs
selection      = which representation fits while preserving value and diversity
safe trimming  = shorten derived evidence without changing raw logs or losing provenance
LLM input      = selected evidence plus metadata, reasons, and exact references
```

### 3.3 Phase 3 — Solution finding

> **Status: TODO**

Phase 3 will start with the evidence pack created by failure analysis. Its purpose will be to find trusted documents, previous confirmed incidents, configuration, ownership, and code that can help explain the failure and guide a fix.

The recommended detailed design is now in [Logsift Phase 3: RAG knowledge and code context](logsift_phase3.md). It explains the knowledge-learning mode, failure-retrieval mode, validated-feedback mode, hybrid search, commit-matched code, permissions, token limits, citations, evaluation, and implementation steps.

Before implementation, the team still needs to review and approve:

- how the evidence pack becomes exact-text, meaning-based, and code-relationship searches;
- how permissions, `seal_id`, repository, service, branch, and commit filters are applied before retrieval;
- what belongs in the exact-text index, vector index, code index, dependency graph, and secure content store;
- how results are combined, deduplicated, ranked, and fitted into a separate retrieval token budget;
- how every retrieved item keeps its source, trust level, freshness, and exact file or document location;
- how root-cause analysis remains separate from suggested remediation;
- how a confirmed root cause and fix can become validated knowledge without teaching the success-log baseline;
- how any automated action requires a separate approval and execution workflow.

The Stage 3 overview and the detailed Phase 3 document describe the intended direction. They remain TODO and must not be treated as implemented Logsift contracts until the open decisions are reviewed and approved.

## 4. Design trade-offs

A trade-off means that a design choice gives Logsift one benefit but also adds a cost, limitation, or risk. The table below makes those choices visible so they can be tested instead of being mistaken for perfect solutions.

| Design choice | What it gives us | Cost or risk | How Logsift limits the risk |
|---|---|---|---|
| Repository-level template catalog | Templates can be reused across pipelines in the same repository without creating many separate catalogs. | A template that is normal in one pipeline could hide a problem in another. | Keep pipeline, branch class, stage or node, attempt, and environment statistics separate inside the baseline. LogDiff uses only compatible statistics. |
| Three candidate routes | LogDiff finds changed behaviour, keywords keep obvious failures, and the log tail keeps useful terminal output. This improves recall. | More routes can produce more noise and duplicate candidates. | Merge by `occurrence_id`, keep all reasons, use adaptive line weights, and let later scoring reject unrelated evidence. |
| Adaptive candidate weights | Focused failures can expand broadly, while very noisy failures can be reduced early. | A useful low-weight line could be delayed when the candidate set is large. | Keep every candidate reference for audit, always expand required terminal evidence, and make the limits configurable and measurable. |
| Four lines before and six after | Provides a simple and repeatable starting window that works for many errors. | A fixed window may be too small for a long stack trace or too large for a short message. | Extend to complete known structures, stop at safe boundaries, enforce size limits, and keep the window configurable. |
| Segment-aware expansion | Jules context stays in its stage attempt, while Lattice context stays in its node attempt even when physical lines are interleaved. | Source adapters and segmentation rules become more complex. Incorrect segmentation can select the wrong context. | Store segmentation confidence, validate source metadata, and use a marked lower-confidence physical fallback instead of guessing. |
| Streaming sidecar index | Finds exact lines and byte ranges quickly without loading the complete log into memory. | The index adds ingestion work, storage, versioning, and retention responsibilities. | Store pointers instead of copied log text, write records in batches, keep the failed index only for the required retention period, and make a successful-run sidecar optional. |
| Pointer-only candidate pool | Keeps memory and storage small and isolates concurrent analyses with `analysis_id`. | Expansion depends on the referenced raw log still being available and unchanged. | Use immutable log object IDs, keep raw-log retention longer than analysis retention, validate the object version, and fail clearly when content is unavailable. |
| Stable template fingerprints | Workers can compare templates without trusting parser-local numeric IDs. | A change to normalization, masking, Drain settings, or fingerprint rules can change many fingerprints. | Version every processing step and refuse normal comparison when versions are incompatible. |
| Rich LogDiff checks | Frequency, scope, order, severity, and safe parameter changes can find failures that simple template membership misses. | More checks add tuning work and may create false positives. | Start with conservative thresholds, store the reason for every result, and validate rules with real successful and failed runs. |
| Deduplication | Removes repeated evidence and saves model tokens. | Similar-looking events from different attempts or nodes may have different meaning. | Deduplicate only with compatible scope rules and retain counts, every affected scope, first and last occurrence, examples, and all raw locations. |
| Diagnostic density and evidence score | Density prefers focused blocks, while the final score considers severity, novelty, correlation, scope, and repetition. | Scores can look precise even when their weights are only starting recommendations. A dense block can still be irrelevant. | Keep density secondary, store every factor and rule adjustment, show a score explanation, and tune the policy using labelled failures. |
| Token optimization | Keeps model requests within a predictable cost and context limit. | Compacting, summarizing, or omitting evidence can remove useful detail. | Keep required structures intact, shorten only derived evidence at safe boundaries, record every omission, and retain pointers to the full raw evidence. |
| Redaction and masking | Protects secrets and reduces dynamic noise before templates or derived evidence are stored. | An overly broad rule can remove useful diagnostic values or merge different messages. | Test and version the rules, use typed placeholders, allow safe exceptions, record rule matches without secret values, and stop processing when redaction cannot be trusted. |

These controls reduce the risks, but they do not remove the need for testing. Values such as candidate limits, window sizes, scoring weights, similarity thresholds, and token reservations remain recommended starting points until Logsift is evaluated on representative Jules and Lattice failures.

## 5. Conclusion

The design now gives Logsift a clear path from trusted successful runs to a versioned baseline, and from a failed run to a small evidence pack with exact provenance.

The important boundaries are explicit:

- only eligible successful runs can update the baseline;
- Jules stages and Lattice nodes keep their own scope and order;
- failed runs use compatible frozen processing but never teach the baseline;
- candidate discovery combines LogDiff, configured failure keywords, and the source-aware log tail;
- large logs are streamed and retrieved through pointers instead of being loaded completely into memory;
- expansion uses the failed run's segment map, sidecar index, and raw log;
- deduplication reduces repeated evidence without losing its history;
- density, scoring, and token selection are separate decisions with stored explanations;
- every shortened or selected block remains connected to its exact source.

Some structures in this document are recommended starting contracts because the final integrations and storage implementations do not define them yet. They should become implementation contracts only after validation, testing, and review.

## 6. Future work

> **Status: TODO**

The following work is intentionally left open:

- [ ] Complete the Phase 3 retrieval, code-context, root-cause, and remediation component design.
- [ ] Confirm the real Jules and Lattice source markers, event fields, stage or node boundaries, attempts, terminal states, and ordering guarantees.
- [ ] Finalize the canonical event, rule-file, segment, sidecar-index, candidate-pool, and storage contracts.
- [ ] Select the persistent stores for baselines, failed-run indexes, candidate state, evidence blocks, and restricted raw logs.
- [ ] Implement and test streaming reads, compressed-log handling, byte-range lookup, cancellation, retries, leases, cleanup, and concurrent `analysis_id` isolation.
- [ ] Build a representative evaluation set containing successful and failed Jules and Lattice runs.
- [ ] Measure candidate recall, false positives, expansion accuracy, memory use, processing time, storage cost, and model-token cost.
- [ ] Tune failure keywords, log-tail size, adaptive candidate limits, the four-before/six-after window, block-size limits, density use, scoring weights, and token reservations using the evaluation set.
- [ ] Test missing segments, low-confidence segmentation, truncated logs, unavailable raw-log objects, incompatible baselines, multiline errors, and heavily interleaved Lattice output.
- [ ] Add monitoring for redaction failures, incompatible versions, index corruption, missing provenance, excessive fallback use, and evidence-budget failures.
- [ ] Define retention, deletion, encryption, access-control, and audit requirements for raw logs and derived artifacts.
- [ ] Review every recommended structure with the implementation owners and replace recommendation labels only when the contract is approved.
