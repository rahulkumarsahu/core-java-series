# Logsift: problem and architecture

## 1. Introduction

### In short

When a CI/CD run fails, the log can contain thousands of normal lines and only a few lines that explain the failure. Finding those lines manually is slow, and the last error in the log is not always the real cause.

Logsift learns normal patterns from selected successful runs. When a run fails, it compares the failed log with a compatible success baseline, finds unusual lines, and expands the surrounding context. It then removes repeated evidence, ranks what remains, and creates a small evidence pack that a language model can analyze.

Logsift can also retrieve relevant runbooks, previous confirmed incidents, configuration, and code from the same repository version. This helps it explain what probably failed and show the evidence behind the explanation. It may recommend a fix, but automatically changing code or rerunning a pipeline requires a separate approved workflow.

### Business problem

A failed pipeline delays a release and takes engineering time away from product work. The cost is not only the failed build. Several engineers may search the same long log, repeat the same investigation, and still disagree about the first useful failure signal. The delay becomes larger when the log has millions of lines or the person on call does not own the failing component.

Basic log access does not solve this problem. A tool can download the log, show its tail, or pass text to a model, but it still leaves the engineer or model to search a very large and repetitive file. Sending the whole file increases model cost, may cross context limits, and creates a larger secret-exposure surface. Looking only at the tail can miss the earlier event that caused the final error.

Logsift solves the evidence-selection problem between log storage and diagnosis. It learns normal behaviour from trusted successful runs, finds meaningful differences in a failed run, recovers only the required context, and keeps exact links to the source. The expected business impact is:

- shorter time from pipeline failure to a useful first diagnosis;
- less engineer time spent manually searching and comparing logs;
- lower model-token and processing cost than whole-log analysis;
- fewer unsupported explanations because every claim keeps evidence;
- safer handling of secrets and tenant data;
- reusable confirmed knowledge for later failures.

These benefits must be measured. Logsift is successful only when it improves evidence recall and diagnosis time without increasing secret risk, false leads, or cost beyond the agreed limits. The testing and cost sections later in this document define how to measure that.

### Technical problem

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

![Logsift three-stage flow](images/1_logsift.png)

> **Design status:** The project defines the three-stage direction, the difference between Jules and Lattice, Drain-based templates, and comparison with successful runs. The exact event, storage, rule, and worker contracts are not implemented yet. This document records the final recommended design so implementation decisions remain consistent.

### Stage 1 — Offline learning

This stage runs for selected successful pipeline runs. Its purpose is to learn what normal output looks like for one repository and source type. Failed, cancelled, incomplete, or untrusted runs never update the baseline.

![Logsift offline learning overview](images/2_offline_learning.png)

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
| Streaming statistics | Counts templates, records scope and order, and keeps safe parameter distributions while the successful log is read. These summaries become the comparison baseline. |
| Compact segment manifest | Records which Jules stages or Lattice node attempts existed and whether segmentation was complete. It does not create one stored record per line. |
| Successful raw log | Keeping the original successful log is a separate audit or source-retention choice. It is not required for future failed-log expansion. |
| Drain | Turns similar masked messages into reusable canonical templates. |
| Versioned success baseline | Stores templates, fingerprints, counts, and stage-or-node occurrence data under `seal_id + project_id + repo_id + source_type`. |

### Stage 2 — Failure analysis

This stage runs after a pipeline fails. Its purpose is to find what changed, recover the useful surrounding context, and create a small evidence pack. It uses the success baseline but never changes it.

![Logsift failure-analysis overview](images/3_failure_analysis.png)

The overview image shows the normal replay path at a high level. The detailed design below adds three important controls that are intentionally not crowded into the picture: direct candidate expansion during Pass 1, fingerprint finalization after Pass 1, and the optional thin-index path. In the picture, “Drain fingerprints” should be read as run-local clusters that receive their final fingerprints only after the parser is frozen.

| Block | Purpose |
|---|---|
| Failed terminal run | Provides the complete failed log and required run metadata. |
| Pass 1: failed-run summary | Pins one processing configuration, streams the failed log, and uses a private run-local copy of the compatible Drain state. It produces run-local template counts, order, safe parameter statistics, keyword-hit pointers, and terminal-state information. |
| Immediate candidate expansion | Expands obvious keyword, severity, stack, and terminal candidates while Pass 1 is already streaming. This avoids finding the same content again later. |
| Finalize failed templates | Freezes the run-local Drain parser after Pass 1, converts each final canonical template into a stable fingerprint, and records the mapping from run-local cluster ID to fingerprint. Intermediate fingerprints are never used for LogDiff. |
| LogDiff | Compares stable fingerprints, counts, scope, order, severity, and safe parameter distributions with a compatible success baseline. Its output is a small selector set. |
| Pass 2: occurrence discovery | Uses one of two strategies for candidates known only after LogDiff: frozen read-only replay for normal logs, or a temporary compressed thin index for very large or repeatedly analysed logs. |
| Candidate pool | Stores small suspicious-occurrence references under a unique `analysis_id`. It does not copy the complete log. |
| Per-segment ring buffers | Keep only a small number of recent events for each Jules stage attempt or Lattice node attempt during streaming. They provide before-context without loading a segment or complete log into memory. |
| Inline content expansion | When a candidate appears in Pass 1 or replay, Logsift takes buffered before-context and collects bounded after-context from the same logical segment. |
| Candidate-only pointers | Persist exact physical lines, logical positions, byte ranges, segment identity, and reasons only for selected occurrences. A permanent complete line-level sidecar is not created by default. |
| Optional thin index | For measured large-log or repeated-analysis cases, stores compact run-local cluster IDs, segment positions, line and byte pointers, and safe flags in temporary compressed binary form. |
| Evidence blocks | Combine related expanded lines into small readable failure stories while keeping exact provenance. |
| Deduplicate | Collapses repeated blocks while retaining occurrence counts and representative locations. |
| Error classification | Adds a category, confidence score, `P0` to `P4` priority, priority reasons, classifier version, and review flag to every retained block. |
| Score and rank | Puts unusual, severe, nearby, and well-supported evidence ahead of repeated noise. |
| Token selection | Chooses a useful and varied set of blocks that fits the model's evidence budget. |
| Evidence pack | Contains the failure summary, template diff, selected blocks, counts, and links to exact source locations. |

### Stage 3 — Solution finding

This stage starts with the evidence pack. Its purpose is to find trusted knowledge and code that can explain the evidence and suggest a practical next step. The log evidence remains authoritative.

![Logsift solution-finding overview](images/4_solution_finding.png)

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
| Grounded diagnosis | Explains the likely cause using both the current log evidence and retrieved context. Every important claim must point to evidence-block IDs or retrieved source references. |
| Suggested fix and citations | Gives a recommended next step with links to the supporting log, document, configuration, or code. Automatic execution is a separate approved workflow. |

### Complete overview

The following diagram joins the three stages. It is intentionally short; later sections explain each stage in detail.

![Logsift complete solution overview](images/5_end-to-end-design.png)

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
  -> collect segment-aware template statistics and safe parameter distributions
  -> create Drain templates and fingerprints
  -> aggregate counts and order by branch class and stage or node
  -> publish the success baseline
```

The main flow is already clear in Logsift. A few implementation details are still open, including the final event fields, rule-file format, storage-artifact format, and branch fallback rules. The examples below give us a simple design to start implementing. We can adjust them when the real Jules and Lattice contracts are available.

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
    "normalization_rules": "1.0.0",
    "redaction_rules": "1.0.0",
    "masking_rules": "1.0.0",
    "segmentation": "segment/v1",
    "parser": "drain/v1",
    "fingerprint": "fingerprint/v1",
    "safe_parameters": "safe-parameters/v1"
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

The segment manifest is intentionally compact. It describes the logical work that existed in the run; it is not a searchable record for every line. During failure analysis, Logsift identifies exact suspicious lines while it streams the failed log for the second time. That worker already knows the current segment, logical position, physical line, and byte position, so it persists exact pointers only for selected candidates.



#### 3.1.6 Streaming summaries without a full line index

Logsift does not need a permanent line-level index for a successful run. It reads one event at a time, updates small summaries, and then releases the event.

```text
read one event
  -> identify its stage or node attempt
  -> normalize, redact, and mask it
  -> parse it with Drain
  -> calculate the stable fingerprint
  -> update counts, order, severity, and safe parameter statistics
  -> release the event text
```

The worker keeps only:

- the current input chunk and an unfinished-line buffer;
- the active source-envelope and segmentation state;
- the Drain model required for this baseline version;
- counters keyed by fingerprint, branch class, pipeline, and scope;
- bounded sequence information for each segment;
- safe parameter summaries;
- a compact description of the segments found in the run.

Memory therefore depends on the chunk size and number of active segments, not on the total number of log lines.

##### What is stored from a successful run

The durable learning output is a summary:

```text
template catalog
+ stable fingerprints
+ counts by compatible scope
+ sequence and stage-or-node placement
+ severity statistics
+ safe parameter distributions
+ source and processing versions
```

Logsift does not need to store five million success-line pointers. Once the baseline version is safely published, temporary event objects are removed. A successful raw log may still be retained by a separate audit policy, but LogDiff does not need it.

##### Safe parameter statistics

Masking protects template stability, but some masked values can still be diagnostically important. These values are kept only as safe structured statistics.

For example:

```text
payment-api returned 200
payment-api returned 503
```

Both lines may produce this template:

```text
payment-api returned <STATUS_CODE>
```

The baseline can still remember:

```json
{
  "fingerprint": "fp-api-response",
  "safe_parameters": {
    "status_code": {
      "type": "ENUM",
      "counts": {"200": 980, "503": 20}
    }
  }
}
```

This lets LogDiff find a parameter shift even when the template fingerprint is unchanged.

Logsift classifies retained parameter slots using simple types:

| Type | Meaning | Example treatment |
|---|---|---|
| `CONST` | The value normally does not change | Keep the one safe value and its count. |
| `NUM` | The value is numeric | Keep bounded statistics such as count, minimum, maximum, median, and selected percentiles. |
| `ENUM` | A small safe set of values is expected | Keep value counts, such as HTTP status or exit-code counts. |
| `ID` | The value is high-cardinality and mainly identifies an occurrence | Do not keep the original values. Keep only count or uniqueness information when useful. |

Secrets, credentials, raw request IDs, private usernames, and other restricted values are never placed in parameter statistics. The redaction policy always takes priority.

##### Optional recent-template cache

Logs from one stage or node often repeat a small set of templates close together. Logsift may keep a small recent-template cache to avoid repeating the full Drain tree search for every common line.

Recommended cache scope:

```text
source_type + pipeline_id + stage_or_node + attempt_class
```

The cache is an optimization only. A cache hit and a normal Drain lookup must return the same canonical template and fingerprint. Cache size, hit rate, parser latency, and memory must be measured before enabling it in production. Changing the cache must not change the baseline contract.

##### Why a permanent full sidecar is not part of the default design

A complete sidecar would add a stored record for every log event. For a five-million-line log, that creates millions of records even when only a few lines become evidence.

For normal one-time analysis, Logsift makes this trade-off:

```text
one additional sequential failed-log pass
in exchange for
no mandatory full line-level index
```

The second pass is explained in [Failure analysis](#32-failure-analysis-flow). It uses the finalized run-local catalog in read-only mode, discovers only the remaining selected occurrences, and expands them while streaming. This keeps storage small and makes memory predictable.

For very large or repeatedly queried failed logs, Logsift may instead build the optional temporary compressed thin index described in the failure flow. That is an acceleration strategy, not a successful-baseline artifact and not a permanent requirement.

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

Drain is the selected parser because its fixed-depth tree gives predictable online routing and keeps candidate comparisons small. Spell uses longest-common-subsequence matching, which can work well when variable tokens appear in difficult positions, but its matching cost and behaviour are less predictable for the current high-volume streaming path.

Spell is not forbidden. It should be evaluated only as a separately versioned parser experiment. Logsift must never silently compare templates produced by Drain with templates produced by Spell.

Drain settings strongly affect the result. Before publishing a parser version, Logsift must test it on representative Jules and Lattice logs and measure:

- how often one real message family is split into several templates;
- how often different messages are incorrectly merged;
- parser throughput and peak memory;
- the number of new fingerprints created after a rule change;
- stability across repeated processing of the same log;
- cache hit rate when the optional recent-template cache is enabled.

A parser-setting change creates a new parser version and a new compatible baseline. It is not an in-place edit to an existing baseline.

Drain may give a template a local number such as `42`. That number is useful only inside that one Drain state. Another Drain worker may also use `42` for completely different text.

Logsift therefore creates a template fingerprint. A fingerprint is a stable identifier calculated from the final template text and the fingerprint version:

```text
fingerprint = SHA-256(fingerprint_version + "\n" + canonical_template_text)
```

SHA-256 is the hash method used to turn the template text into a repeatable fixed-length identifier.

The same template text produces the same fingerprint when the fingerprint version is the same. Logsift compares this fingerprint instead of comparing Drain's local number.

The fingerprint is an identity shortcut, not a secret and not the only stored data. `templates.json` also stores the canonical template text. If the same fingerprint is ever presented with different canonical text, Logsift treats it as a data-integrity error instead of merging the records.

Stage, node, attempt, and branch class are not part of the fingerprint. They are stored with each occurrence and its statistics. This allows one template to be used in several stages while still keeping different counts for each stage.

Example:

```text
Canonical template: Downloaded <ARTIFACT> in <DURATION>
Fingerprint:        sha256:v1:52b7...

Main/build statistics:    usually 1 occurrence
Main/test statistics:     usually 0 occurrences
Release/build statistics: usually 2 occurrences
```

The failed run uses the pinned compatible rules and starts from a private copy of the saved Drain state. It may find known templates or create temporary failed-run templates in that private copy, but it never changes the successful baseline or its Drain state. Final failed-run fingerprints are created only after the private parser is frozen.

#### 3.1.8 Files produced and their purpose

A published baseline version has three main files: `baseline.json`, `templates.json`, and `state.json`. A small `current.json` file points to the latest complete version.

The [examples index](examples/README.md) lists the two example sets that belong to this design. The example directory intentionally excludes retired exploratory inputs so engineers do not implement an older storage flow by mistake.

| File | Stored where | What it contains | Used later by |
|---|---|---|---|
| `baseline.json` | Baseline version folder | Says which repository and source the baseline belongs to, which successful events built it, and which processing versions were used | Finds a compatible baseline and checks that it is complete |
| `templates.json` | Baseline version folder | Stores template text, fingerprints, counts, branch class, pipeline and stage-or-node statistics, order information, safe parameter distributions, and small event references | LogDiff |
| `state.json` | Baseline version folder | Stores the saved Drain settings and parsing tree, including the mapping from local Drain IDs to fingerprints | Parses later runs with the same Drain setup |
| `current.json` | Baseline key folder | Points to the newest complete baseline version | Baseline lookup |
| `segment-groups.json` | Run folder | Describes stage or node attempts, logical counts, completion state, and summarized physical ranges; it is not a per-line index | Validates successful grouping and records the segments seen in a failed run |
| `raw-log-manifest.json` | Failed-run folder | Describes immutable raw-log chunks, compression, line-range checkpoints, checksums, and object versions | Supports restart, bounded reads, and provenance without indexing every line |
| `analysis-manifest.json` | Analysis folder | Pins the raw-log version, processing configuration, compatible baseline, occurrence-discovery strategy, limits, and status for one `analysis_id` | Keeps every worker and retry on the same contract |
| `failed-template-summary.json` | Failed-run folder | Stores the finalized run-local cluster-to-fingerprint mapping, failed fingerprints, scope counts, sequence information, severity, and safe parameter statistics from Pass 1 | LogDiff and Pass 2 consistency checks |
| `failed-parser-state.json` | Failed-run temporary folder | Stores the finalized read-only run-local Drain catalog and its compatible baseline-state reference | Normal-log Pass 2 replay; deleted according to failed-analysis retention |
| Temporary thin index | Failed-run temporary folder | Optionally stores compressed run-local cluster IDs, segment/logical positions, physical lines, chunk and byte pointers, and safe flags | Large-log or repeated-analysis candidate lookup and content expansion |
| `logdiff-result.json` | Analysis folder | Stores compatibility decisions, candidate selectors, missing-template notices, and measurable comparison reasons | Pass 2 candidate discovery and final evidence pack |
| `candidate-occurrences.jsonl` | Analysis folder | Stores exact pointers only for selected failed-log occurrences | Content expansion, audit, and evidence provenance |
| Restricted raw log | Protected source-log storage | Stores the original uploaded log text when retention policy allows it | Supplies failed-log ranges selected for expansion; a successful raw log is not required by LogDiff |

The example `normalized.json`, `redacted.json`, and `masked.json` files make each processing step easy to see. They do not all need to be stored permanently. Normalized text can still contain secrets, so it should remain only in small, limited worker memory or a tightly restricted temporary area. It must never be copied into the baseline.

The recommended storage layout is shown below. The baseline folder is required. A successful run's `runs/` folder is optional after publication. A failed run keeps its run folder and restricted raw log until analysis and the configured retention period finish. All paths include the four-part ownership key before the run or analysis ID, so two repositories cannot write into the same partition by accident.

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
    ├── raw-log-manifest.json
    ├── failed-template-summary.json
    ├── failed-parser-state.json
    └── optional-thin-index.bin

analyses/
└── {seal_id}/{project_id}/{repo_id}/{source_type}/{run_id}/{analysis_id}/
    ├── analysis-manifest.json
    ├── logdiff-result.json
    ├── candidate-occurrences.jsonl
    ├── expanded-fragments.jsonl
    ├── log-blocks.jsonl
    └── evidence-pack.json

restricted-logs/
└── {seal_id}/{project_id}/{repo_id}/{source_type}/{run_id}/{log_object_id}
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

The template catalog can live for many baseline versions, but its normal-behaviour statistics must stay fresh. Logsift should calculate counts and distributions from a configurable rolling window of recent compatible trusted successes. A small starting window may be useful, but the final size must be validated per pipeline because a stable main pipeline and an irregular release pipeline may need different history lengths.

#### 3.1.10 Worked Jules example

All credentials and identifiers in these files are synthetic test data.

The Jules example is a successful sequential run with `build`, `test`, and `package` stages:

- [raw.log](examples/offline-flow/jules/raw.log) contains the original sample, including synthetic URL credentials and a synthetic access token.
- [normalized.json](examples/offline-flow/jules/normalized.json) removes presentation noise and extracts the Jules envelope.
- [redacted.json](examples/offline-flow/jules/redacted.json) removes the synthetic credentials and token.
- [masked.json](examples/offline-flow/jules/masked.json) replaces changing build, UUID, IP, duration, hash, count, and temporary-path values.
- [segment-groups.json](examples/offline-flow/jules/segment-groups.json) shows how the successful events were grouped by sequential stage and attempt. This educational file may be short-lived in production.
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

The secret does not appear in the baseline. The segment-aware counts and safe parameter summaries remain in `templates.json`; the successful flow does not need a permanent occurrence record for every line.

#### 3.1.11 Worked Lattice example

The Lattice example is a successful DAG run. Output from `test:integration`, `security-scan`, and `package` is physically interleaved:

- [raw.log](examples/offline-flow/lattice/raw.log) contains the interleaved source lines and a synthetic bearer token.
- [normalized.json](examples/offline-flow/lattice/normalized.json) extracts node, attempt, and node-local sequence.
- [redacted.json](examples/offline-flow/lattice/redacted.json) removes the bearer token.
- [masked.json](examples/offline-flow/lattice/masked.json) replaces changing values while keeping node identity.
- [segment-groups.json](examples/offline-flow/lattice/segment-groups.json) shows how noncontiguous physical fragments are joined for each node attempt. This educational file may be short-lived in production.
- [templates.json](examples/offline-flow/lattice/templates.json), [baseline.json](examples/offline-flow/lattice/baseline.json), and [state.json](examples/offline-flow/lattice/state.json) show the three core baseline artifacts.

For example, physical lines 3, 5, 7, 9, and 11 belong to the same `test:integration` node attempt. During success processing, that relationship produces node-local counts and order statistics in `templates.json`. During a future failed run, the source adapter recreates the same node identity while streaming. Its per-node ring buffer expands a candidate inside `test:integration` without pulling in nearby `security-scan` or `package` output.

#### 3.1.12 End-to-end result

After offline learning publishes a baseline, Logsift must keep:

- `baseline.json` to describe the baseline and its processing versions;
- `templates.json` to store normal templates, fingerprints, counts, and ordering information;
- `state.json` to store the compatible Drain setup.

Logsift may also keep the successful run's `segment-groups.json` and protected raw-log reference for a short time when audit, validation, or replay needs them. They are not required for normal LogDiff or for expanding a different failed run.

When a future run fails, Pass 1 uses pinned processing rules and a private run-local Drain copy. It expands direct candidates, freezes the final run-local templates, and creates their stable fingerprints. LogDiff compares that final summary with `templates.json`. Remaining selectors use either frozen read-only replay or the temporary thin index. Both strategies store exact pointers only for candidates and evidence fragments.

In short:

```text
baseline templates = what is normally expected
LogDiff selectors   = what failed-run signals to find
segment context     = ring buffers or thin-index logical neighbours
candidate pointers  = exact locations kept for selected evidence
failed raw log      = the immutable source text
```


### 3.2 Failure analysis flow

Failure analysis starts only after the pipeline has reached a final failed state and the raw log is complete. It uses the successful baseline, but it never changes that baseline.

The selected design is adaptive. Pass 1 always streams the complete failed log and builds its summary. Obvious keyword, severity, stack, and terminal candidates can be expanded during that pass. After LogDiff, candidates that were not known earlier are located by either a read-only streaming replay or a temporary thin index:

```text
Pin one processing configuration
  -> Pass 1 builds the failed-run summary
  -> expand candidates already known while streaming
  -> freeze the run-local Drain parser and finalize fingerprints
  -> LogDiff decides what is suspicious
  -> normal log: read-only Pass 2 replay for remaining selectors
     or
  -> large/reused log: thin-index lookup and targeted range reads
  -> build, deduplicate, classify, score, and select evidence
```

This design supports every LogDiff signal without making a permanent per-line index mandatory. It also avoids replaying candidates that were already discovered and expanded safely during Pass 1.

#### 3.2.1 Why the normal strategy uses a second pass

A single-pass design is attractive because it reads the log only once. It works for signals that can be decided immediately, such as an `ERROR` keyword, an explicit exception, or a nonzero exit. A new template is not authoritative until the run-local Drain parser has been finalized and LogDiff has compared its final fingerprint with the baseline.

However, some important signals are known only after the complete failed run has been summarized:

- a template occurred 10,000 times instead of its normal count of 5;
- a normal success template is missing;
- a template appeared in the wrong stage or node;
- a sequence changed near the failure;
- a masked status code, duration, or failure count shifted from its normal distribution.

To support these signals in one pass, Logsift would have to save every occurrence before it knew which ones mattered. That recreates the large sidecar we are trying to avoid.

For a normal one-time analysis, the selected trade-off is:

```text
one additional sequential read
instead of
millions of permanent occurrence records
```

Sequential reads are predictable and can be limited by the worker scheduler. The second pass uses the exact pinned processing configuration and a frozen read-only parser catalog. It does not learn templates again.

The complexity is linear:

```text
Pass 1: O(N)
Pass 2: O(N)
Total:  O(N)
```

`N` is the number of bytes or events in the failed log. Two linear passes are still `O(N)`; the constant cost is approximately two sequential reads. Logsift never performs one complete scan per keyword or one complete scan per candidate.

For a very large log, or when the same immutable log is expected to be analysed repeatedly, Logsift may build a temporary compressed thin index during Pass 1. That changes the later work from a complete replay to small index lookups and targeted raw-log range reads. The index is enabled only when measurement shows that its write, storage, and cleanup cost is lower than replaying the log.

#### 3.2.2 Failed-run ownership and immutable storage

Before processing starts, Logsift creates an `analysis_id`. The run and analysis keys have different jobs:

```text
run key      = seal_id + project_id + repo_id + source_type + run_id
analysis key = seal_id + project_id + repo_id + source_type + run_id + analysis_id
```

The run key locates the immutable failed log. The analysis key isolates one diagnostic request from every other request.

The raw log must be immutable after the terminal event. The run manifest records:

- raw-log object ID and version;
- total bytes and completion state;
- checksum when available;
- source type and source-schema version;
- compression format;
- independently readable chunk references when the log is chunked;
- one-based physical line convention;
- zero-based, end-exclusive byte-offset convention.

Before Pass 1 starts, Logsift also writes `analysis-manifest.json`. It pins one `processing_config_version` that resolves to the exact versions of:

- the Jules or Lattice adapter and source schema;
- normalization, redaction, masking, and safe-parameter rules;
- segmentation rules;
- the compatible success-baseline Drain state and Drain settings;
- the fingerprint algorithm;
- Aho–Corasick keyword rules and bounded expression rules;
- expansion, block, deduplication, classification, scoring, and token policies.

The manifest also records the immutable raw-log object version, compatible baseline version, resource limits, and the selected occurrence-discovery strategy. Pass 1, LogDiff, replay, retries, and resumed workers must load this exact manifest. A worker that cannot load a pinned version must stop the analysis with a clear compatibility error. It must never silently use the newest deployed rules.

For compressed logs, Logsift should use independently compressed chunks or seekable compression. A single large compressed stream cannot reliably provide cheap random byte-range reads. The two streaming passes can still read it sequentially, but later provenance lookups would otherwise require decompression from the beginning.

A pointer must also say which byte space it uses. For an uncompressed object, `byte_start` and `byte_end` refer directly to that immutable object. For an independently compressed chunk, the pointer carries `chunk_id`, the object's stored byte range, and the uncompressed offset inside the chunk. Logsift must never treat a compressed-object offset as if it were a raw-log line offset.

##### Storage responsibilities

The first implementation should keep large and small data in different places:

| Data | Recommended storage role | Why |
|---|---|---|
| Restricted raw logs and independently compressed chunks | Immutable object storage | It is efficient for large sequential reads and keeps one authoritative source object. |
| Baseline files, fragments, log blocks, and evidence packs | Versioned object storage | These artifacts are immutable and can be addressed by version or content ID. |
| Baseline pointer, run status, analysis status, leases, and checkpoints | Small transactional metadata store | These records need atomic state changes, idempotency, and compare-and-set updates. |
| Candidate occurrences and score records | Durable partitioned records with an `analysis_id` key and expiry | Workers need fast isolated writes without retaining all candidates in process memory. |

The document does not require one database product. The important contract is that large text stays out of the candidate-state store, writes are idempotent, and every stored reference resolves to an immutable object version.

#### 3.2.3 Pass 1: build the failed-run summary

Pass 1 reads the complete failed log using the same versioned pipeline as offline learning:

```text
source adapter
  -> normalize
  -> redact
  -> extract safe keyword and parameter signals
  -> mask
  -> segment
  -> private run-local Drain parser
  -> stable run-local cluster ID
```

Pass 1 starts from a private copy of the compatible success-baseline Drain state. This copy may create or update temporary failed-run clusters while the log is being read. The published success baseline remains immutable.

Pass 1 counts by stable run-local `cluster_id`, not by an intermediate fingerprint. Drain can generalize a cluster template as it sees more matching messages, so a fingerprint calculated too early could change before the pass finishes.

Safe keyword matching branches from the redacted message before masking removes useful values. The same message then continues through masking and Drain. Both branches keep the raw line and byte pointer, so their reasons can be joined later without copying the original text.

For each event, Pass 1 updates:

- total run-local cluster count;
- count by pipeline, branch class, stage or node, and attempt class;
- first and last observation;
- segment-local template sequence;
- severity and terminal-state information;
- safe parameter distributions;
- keyword-hit counts and bounded occurrence pointers;
- source and segmentation confidence.

The output becomes `failed-template-summary.json` after the parser is finalized and each run-local cluster has been mapped to its final fingerprint. It contains summaries, not complete line text.

##### Aho–Corasick keyword matching

Logsift must not scan the log once for every keyword. Fourteen keywords and five million lines should not become fourteen full-log scans.

Aho–Corasick builds one search machine from all configured literal keywords. The machine reads each character once and reports every keyword that ends at that position.

```text
configured words
fatal, panic, error, failed, exception, no such file, permission denied
        ↓
one compiled matcher
        ↓
one scan of each normalized and redacted message
        ↓
zero, one, or several keyword-rule IDs
```

The matcher is compiled once per keyword-rule version and shared as read-only state across workers. Each analysis keeps only its own hit counters and bounded pointer groups.

Literal keywords belong in the Aho–Corasick matcher. More complex patterns must use a small set of precompiled, bounded regular expressions. Unbounded or catastrophic-backtracking expressions are not allowed in the hot path.

Keyword matching runs after redaction and before diagnostic values are fully removed from consideration. This prevents secrets from being persisted while still allowing safe values such as `503`, `exit=1`, or an exception type to affect classification.

Template matching alone is not enough. For example, both of these lines may share one template:

```text
payment-api returned 200
payment-api returned 503
```

Logsift therefore combines template text, safe parameters, explicit severity, and keyword rules.

##### Keyword-hit limits

A common warning may contain the word `error` millions of times. Pass 1 must not place millions of full candidate objects in memory.

For each `keyword_rule + fingerprint + segment`, Logsift keeps:

- total occurrence count;
- first and last occurrence;
- a bounded set of representative pointers;
- the occurrence nearest the segment failure or terminal state;
- a small sample across the run when configured.

The full raw log remains authoritative. Candidate limits reduce temporary diagnostic state; they do not change the source log.

##### Source-aware tail information

The end of a failed run often contains useful terminal information, but being near the end is only a candidate reason, not proof of root cause.

Pass 1 keeps a bounded global tail and the final events of completed stages or nodes. It does not keep a large tail for every possible Lattice node. Tail size is configurable by both event count and bytes.

Tail candidates receive a score boost only when they also contain useful terminal, severity, state-transition, or failure information. A normal cleanup line should not outrank an earlier exception simply because it is last.

##### Expand candidates that are already known

Pass 1 does not need to wait for LogDiff when a candidate is already clear from a safe literal rule, explicit severity, exception structure, nonzero terminal state, or an approved tail rule.

While it streams, Logsift keeps bounded ring buffers for the active Jules stage attempts and Lattice node attempts. When one of these direct candidates appears, Logsift takes the before-context from that segment's buffer and collects bounded after-context from the same segment. It stores the resulting fragment and candidate pointers under the current `analysis_id`.

This is an optimization, not a separate source of truth. After LogDiff, the same occurrence may receive additional reasons such as `new_template` or `frequency_shift`. Those reasons are merged into the existing occurrence by its deterministic identity. The content is not expanded twice.

##### Finalize and freeze the failed-run parser

After the last event has been processed, Logsift:

1. stops all updates to the run-local Drain parser;
2. takes the final canonical template text for every run-local cluster;
3. creates the stable fingerprint from the final template text and fingerprint version;
4. records `run-local cluster_id -> final template -> stable fingerprint`;
5. rewrites the accumulated cluster counts and scope statistics to their final fingerprints;
6. stores the finalized run-local catalog as read-only failed-analysis state.

Only these finalized fingerprints are sent to LogDiff. The final catalog is also the matcher used by a normal-log replay. Loading the same software version alone is not enough; replay must load this exact finalized catalog and the exact compatible baseline state recorded in the analysis manifest.

#### 3.2.4 LogDiff: decide what changed

LogDiff compares summaries. It does not search raw text and it does not load the complete log.

##### Compatibility check

Before comparison, Logsift verifies:

- the pinned `processing_config_version` and immutable raw-log object version;
- the four-part baseline key;
- pipeline and branch-class compatibility;
- Jules or Lattice source type and source-schema version;
- normalization, redaction, and masking versions;
- segmentation version;
- Drain model and configuration version;
- fingerprint version;
- finalized failed-run parser-catalog version;
- safe-parameter schema version.

If these versions are incompatible, Logsift stops normal LogDiff and reports why. It must not create thousands of false `new template` results caused by a processing-rule change.

##### What LogDiff compares

| Check | Meaning | Candidate behaviour |
|---|---|---|
| Exact fingerprint match | The canonical template exists in the baseline | Keep it as background unless another signal makes it unusual. |
| New fingerprint | The failed template is not in the compatible repository catalog | Create a selector for its failed-run occurrences. |
| Missing fingerprint | A normally expected success template did not appear | Add it to the diff report. It has no failed occurrence to expand. |
| Frequency shift | The failed count differs materially from the compatible successful distribution | Select representative occurrences and preserve the measured count change. |
| Wrong scope | A template appears in an unusual stage, node, or attempt class | Select occurrences only from the unusual scope. |
| Sequence change | Expected stage-local or node-local order changed | Select the surrounding transition or terminal area. |
| Severity change | The same message family now carries a stronger severity or nonzero exit | Select the stronger failed occurrences. |
| Parameter shift | Safe values hidden by masking changed materially | Select representative occurrences with safe parameter evidence. |

Drain's local numeric template IDs are never compared across runs. LogDiff uses the stable fingerprint created from canonical template text and its fingerprint version.

##### Frequency comparison

A simple starting comparison uses:

```text
frequency ratio = (failed count + epsilon) / (baseline expected count + epsilon)
```

- `failed count` is the number of occurrences in the compatible failed scope.
- `baseline expected count` is the mean or robust median from recent compatible trusted successes.
- `epsilon` is a small configured value that prevents division by zero.

The ratio alone is not enough. Logsift should also require a minimum absolute change so a shift from zero to one does not always become a high-severity anomaly.

Thresholds belong in versioned rules and must be tested separately for Jules and Lattice. They are not hard-coded universal truths.

##### Sequence and order comparison

Logsift does not keep every repeated fingerprint just to compare order. Each stage or node attempt stores a bounded, run-length-encoded sequence such as:

```text
start ×1 -> download ×1 -> retry ×5 -> assertion ×1 -> exit ×1
```

LogDiff compares this segment-local sequence with the compatible successful sequence. Stable start, end, and terminal fingerprints act as anchors. When a section is added, removed, repeated too many times, or moved, LogDiff creates selectors for the fingerprints around that changed section and records the expected and failed positions. A missing success item appears only in the diff report because there is no failed line to expand.

Long loops are stored as `fingerprint + repeat count`, and sequence length has a configured limit. This keeps order comparison bounded while still finding retry storms and changed terminal paths.

##### Safe parameter comparison

For an enumerated value such as HTTP status, Logsift compares its share in failed and successful runs:

```text
failed share  = failed occurrences of value / all failed occurrences of template
success share = success occurrences of value / all successful occurrences of template
```

A parameter becomes suspicious when its failed share, absolute count, and change from the success share all cross configured minimums.

For numeric values such as duration or memory, Logsift can compare the failed median or percentile with the baseline distribution. Raw high-cardinality IDs remain masked and are never treated as meaningful values.

##### Selector output

LogDiff produces a small selector set:

```json
{
  "seal_id": "seal101",
  "project_id": "payments",
  "repo_id": "payment-api",
  "source_type": "JULES",
  "pipeline_id": "payments-ci",
  "run_id": "run-601",
  "analysis_id": "analysis-9001",
  "selectors": [
    {
      "fingerprint": "fp-api-error",
      "scope": "test-attempt-1",
      "reasons": ["new_template", "severity_change"]
    },
    {
      "fingerprint": "fp-retry",
      "scope": "test-attempt-1",
      "reasons": ["frequency_shift"],
      "baseline_expected": 2,
      "failed_count": 47
    }
  ]
}
```

The selector set is stored in a hash set keyed by `fingerprint + compatible scope`. A lookup is constant time on average and does not grow with raw-log size.

#### 3.2.5 Pass 2: find exact occurrences

Pass 2 is needed only for selectors that became known after LogDiff and were not already expanded during Pass 1. The analysis manifest selects one of two strategies before Pass 1 starts.

##### Strategy A: frozen read-only replay

This is the default for a normal one-time analysis. Logsift streams the immutable failed log again and loads:

- the exact pinned source adapter, normalization, redaction, masking, and segmentation rules;
- the exact compatible success-baseline Drain state used to start Pass 1;
- the exact finalized run-local parser catalog created at the end of Pass 1;
- deterministic similarity and tie-breaking rules.

The replay matcher is read-only. It must not create a cluster, update a template, or change a fingerprint. Its job is only to map each protected event to the finalized run-local cluster and check whether its fingerprint and scope appear in the LogDiff selector hash set.

At the end of replay, Logsift compares the number of matches seen for every replayed selector fingerprint and scope with the count recorded in Pass 1. A mismatch means the replay was not deterministic, the log changed, or the pinned configuration was not followed. Logsift marks the result `partial` and `needs_review`; it does not return a confidently complete evidence pack.

##### Strategy B: temporary compressed thin index

For a very large log or a log expected to be investigated repeatedly, Pass 1 may write a compact index entry for each parsed event. The entry contains:

- run-local cluster dictionary ID;
- segment ID and logical position;
- one-based physical line;
- raw chunk ID;
- byte start and byte length;
- safe severity, keyword, and terminal flags.

The entry does not repeat template text or a full SHA-256 fingerprint. After Pass 1 freezes the parser, a small dictionary maps the run-local cluster ID to the final fingerprint. Numeric values and offsets should use a compressed binary layout, dictionary encoding, and delta encoding. This is not a JSON sidecar.

LogDiff uses the dictionary to resolve selected fingerprints to run-local cluster IDs. Pass 2 then reads only the matching index entries and their neighbouring logical positions. The raw log is fetched with targeted range reads. Because the index includes `segment_id + logical_position`, Lattice expansion can recover node-local context even when its physical byte ranges are interleaved.

The thin index is temporary. It is deleted after the analysis retention period unless repeated investigation has been requested. It is an optimization, not a required correctness artifact and not a permanent global log index.

##### Information available for either strategy

For every event, the worker already knows:

- physical line number;
- byte start and end;
- Jules stage or Lattice node;
- attempt;
- logical position inside the segment;
- stable fingerprint;
- safe severity and parameter values;
- protected correlation information when available.

It checks the fingerprint and scope against the small selector hash set. It also joins any exact keyword, severity, terminal, or tail reason recorded during Pass 1.

The replay strategy continues to the end of the stream. It does not stop after the first match because later occurrences may be more severe, closer to the failure, or part of a different stage or node. The index strategy retrieves every bounded or policy-selected posting for the chosen fingerprint and scope.

##### One occurrence, several reasons

The same physical event may be selected by LogDiff, a keyword, severity, and tail logic. Logsift stores one occurrence and combines the reasons.

A deterministic occurrence identity is calculated from:

```text
seal_id + raw_log_object_id + raw_log_object_version
+ byte_start + byte_end + segment_id
```

This makes retries idempotent. Reprocessing the same event does not create another logical candidate.

##### Candidate-pool record

The candidate pool stores references, not complete log blocks:

```json
{
  "seal_id": "seal101",
  "project_id": "payments",
  "repo_id": "payment-api",
  "source_type": "JULES",
  "pipeline_id": "payments-ci",
  "run_id": "run-601",
  "analysis_id": "analysis-9001",
  "candidate_id": "candidate-api-error",
  "occurrence_id": "occurrence-108",
  "raw_log_object_id": "failed-run-601.log",
  "raw_log_object_version": "v1",
  "fingerprint": "fp-api-error",
  "segment_id": "test-attempt-1",
  "scope": {"kind": "stage", "name": "Test", "attempt": 1},
  "physical_line": 108,
  "logical_position": 5,
  "byte_start": 8421,
  "byte_end": 8598,
  "discovery_path": "pass1_inline",
  "reasons": ["new_template", "keyword:error", "severity:high"]
}
```

Candidate records are immutable. Additional reasons are attached through an idempotent compare-and-set merge or a new version of the grouped candidate record. A retry using the same occurrence identity updates the same logical record instead of creating a duplicate.

#### 3.2.6 Content expansion with segment-local context

A ring buffer is a fixed-size circular list. When it becomes full, adding a new event replaces the oldest event. This gives Logsift a bounded memory structure for before-context.

![Logsift per-segment ring-buffer expansion](images/6_segment_ring_buffers.png)

During Pass 1 and frozen replay, Logsift keeps one small buffer for each active logical segment:

```text
Jules buffer key   = stage + attempt
Lattice buffer key = node + attempt
```

Each slot holds only the protected message needed for evidence, its template fingerprint, severity, safe correlation digest, physical line, logical position, byte range, and segment ID. It never holds a complete segment. With a four-event before-window, one active segment keeps at most four completed event slots plus any bounded open fragment.

Suppose the policy uses four events before and six after.

When a candidate arrives, Logsift:

1. copies references to the previous four events from that segment's ring buffer;
2. adds the candidate event;
3. opens a small fragment and collects the next six logical events from the same segment;
4. extends to a safe boundary for a stack trace or multiline exception when allowed;
5. closes the fragment at the segment boundary or configured byte and event limit.

If another candidate appears before the fragment closes, Logsift extends the same fragment instead of creating an overlapping copy.

When the temporary thin-index strategy is selected, the same policy is applied through index lookup rather than a complete replay. Logsift finds the candidate's `segment_id + logical_position`, selects the configured earlier and later logical positions from that segment, merges overlapping ranges, and range-reads only the required raw chunks. The resulting fragment contract is identical for both strategies.

A segment buffer is removed when its stage or node attempt reaches a terminal event and no fragment is still open. If the source does not provide reliable lifecycle events, an inactivity timeout may close it with a visible low-confidence marker. Logsift must not silently evict an active Lattice buffer merely to stay under a limit; it should apply backpressure or mark the analysis partial.

##### Jules expansion

Jules stages are normally sequential. A Test-stage fragment is usually one contiguous physical range. The buffer is reset or closed when the stage attempt ends.

##### Lattice expansion

Lattice output may be physically interleaved:

```text
Node-A line 1
Node-B line 1
Node-A ERROR
Node-B line 2
Node-A retry failed
```

The Node-A candidate uses the Node-A ring buffer and collects later Node-A events. Node-B lines are never inserted into that logical fragment.

The resulting Lattice fragment may therefore contain several byte ranges:

```json
{
  "segment_id": "node-a-attempt-1",
  "logical_start": 1,
  "logical_end": 3,
  "byte_ranges": [
    {"start": 1000, "end": 1090},
    {"start": 1210, "end": 1305},
    {"start": 1450, "end": 1540}
  ]
}
```

This is how Logsift handles interleaving. In the normal strategy, segment identity and separate node ring buffers preserve logical context while streaming. In the optional thin-index strategy, `segment_id + logical_position` retrieves the same node-local context through noncontiguous byte ranges.

##### Chunk boundaries

Chunk boundaries must not change the result.

- An incomplete physical line is carried into the next chunk.
- Segment ring buffers remain alive across chunk reads.
- An open fragment continues collecting after-context from later chunks.
- UTF-8 characters and multiline records are never split incorrectly.
- Cancellation stops new reads and safely closes or marks partial fragments.

##### Memory bound

The main memory use is:

```text
input chunk
+ selector hash set
+ keyword matcher state
+ active segments × before-window references
+ bounded open fragments
+ bounded output queue
```

It is not proportional to five million lines. Limits must exist for active segments, open fragments, fragment bytes, candidate groups, and queued writes. If a limit is reached, Logsift applies backpressure or records a visible partial-evidence notice; it does not silently consume unlimited memory.

#### 3.2.7 Why a permanent full sidecar is not required

The normal strategy obtains every required pointer during streaming:

```text
LogDiff selector is known
  -> current streamed event matches it
  -> current source adapter provides the segment
  -> current reader provides line and byte positions
  -> ring buffer provides earlier logical events
  -> open fragment collects later logical events
```

Direct keyword and terminal candidates can obtain the same pointers during Pass 1. The default persisted artifacts are:

| Artifact | Size behaviour | Purpose |
|---|---|---|
| Raw-log manifest | One record per stored chunk | Locates immutable raw content and supports restart. |
| Segment manifest | One record per stage or node attempt, plus summarized ranges | Describes the logical pipeline structure. |
| Failed-template summary | One record per fingerprint and compatible scope | Supplies LogDiff counts, order, severity, and safe parameters. |
| LogDiff result | One record per comparison result or selector | Explains what changed. |
| Candidate occurrences | One record per selected or representative occurrence | Keeps exact provenance for suspicious evidence. |
| Expanded fragments | One record per bounded candidate neighbourhood | Stores selected protected content and raw references. |
| Log blocks | One record per merged evidence story | Supplies deduplication, classification, scoring, and the LLM pack. |

An optional compressed thin index may be added for a very large log or when the same failed log will be searched repeatedly. It avoids a complete replay and removes the risk of replay assigning a line differently, but it writes a compact entry for every parsed event. It is therefore not free.

The decision must be benchmark-driven. Consider log size, parser cost, expected number of analyses, storage-write cost, range-read support, and retention time. The chosen strategy is written into `analysis-manifest.json` before Pass 1 so workers do not switch approaches halfway through an analysis.

The index has a short retention period and remains local to one immutable failed log. It must never become a cross-tenant global index. A permanent JSON record per line remains outside the selected design.

#### 3.2.8 Candidate-pool concurrency and isolation

Many failed runs can be analysed at the same time. Logsift shares only immutable objects:

- success baselines;
- versioned processing configurations;
- preprocessing and segmentation rules resolved by those configurations;
- fingerprint definitions;
- compiled keyword matcher.

Every analysis keeps separate mutable state:

- `analysis_id`;
- pinned analysis manifest and raw-log version;
- private mutable run-local Drain state during Pass 1;
- finalized read-only run-local catalog after Pass 1;
- replay or thin-index occurrence strategy;
- selector hash set;
- counters;
- per-segment ring buffers;
- open fragments;
- candidate groups;
- cancellation state;
- bounded writer queue.

Workers must never store candidate state in a global unpartitioned collection.

Production controls include:

- a bounded worker pool instead of one unrestricted thread per request;
- per-tenant and global concurrency limits;
- fair scheduling based on queued bytes so one huge run does not starve smaller runs;
- backpressure when storage, CPU, or the persistent writer is saturated;
- worker leases with expiry;
- idempotent occurrence and block identities;
- retry from a completed chunk checkpoint;
- cancellation and request deadlines;
- maximum candidates per fingerprint and category;
- expiration and cleanup after the analysis retention period.

A checkpoint must contain enough state to restart without changing the result: analysis-manifest version, raw-object version, pass number, completed chunk, source-adapter state, segment state, temporary failed-run Drain state, thin-index write position when enabled, counters, and the last committed output identity. For streaming replay, Logsift either checkpoints the small ring buffers and open fragments or replays a configured overlap before the checkpoint. Output writes remain idempotent, so replaying the overlap cannot create duplicate candidates or blocks.

Parallelism should first be used across independent analyses. Splitting one log across many workers adds ordering and boundary complexity and can reduce performance when storage bandwidth is already saturated.

#### 3.2.9 From fragments to evidence blocks

Three terms must remain separate:

| Term | Meaning |
|---|---|
| Segment | The complete logical Jules stage attempt or Lattice node attempt. |
| Fragment | Bounded before-and-after content around one or more nearby candidates. |
| Evidence block | One readable failure story created from related fragments. |

Fragments are merged when they overlap inside the same segment or form one known structure, such as:

- one multiline exception;
- one stack trace and its caused-by chain;
- one retry sequence;
- one subprocess failure;
- one correlated request transition;
- one stage or node terminal transition.

Different Lattice nodes are not merged merely because their physical lines are close. Cross-node relationships are represented as linked blocks when dependency metadata supports the relationship.

Each evidence block keeps:

- block ID and analysis ID;
- source type, run, pipeline, branch, and commit;
- segment or linked segments;
- ordered protected lines;
- one or more raw byte ranges;
- candidate IDs and reasons;
- occurrence counts;
- error classification, classification confidence, operational priority, and their reasons;
- evidence-ranking score and its factor breakdown;
- truncation or partial-upload notices;
- parent and child relationships when a summary represents several fragments.

##### Deduplication

Deduplication runs in levels:

1. **Exact content hash:** collapse byte-for-byte identical protected blocks.
2. **Canonical content hash:** collapse blocks that differ only in approved masked values.
3. **Template-sequence similarity:** group blocks that tell the same structural story.
4. **Retry-loop compression:** keep the first, last, unusual, and near-failure iterations plus the total count.
5. **Near-duplicate comparison:** collapse strongly similar blocks only when their source and scope rules allow it.

Cross-stage or cross-node copies may need to remain separate because their scope gives them different meaning.

When duplicates are collapsed, Logsift retains:

- total occurrence count;
- first and last occurrence;
- all affected stages, nodes, and attempts;
- representative examples;
- exact original locations or a compressed persistent location list;
- the rule and version that performed the collapse.

Deduplication reduces repeated presentation. It never pretends that only one occurrence existed.

#### 3.2.10 Error classification

Candidate reasons are useful hints, but a single candidate line often does not contain enough context for a final error category. Logsift therefore performs the final error classification after content expansion has created a log block. This allows the classifier to see the exception, stack trace, status change, failed stage or node, and terminal transition together.

Classification happens after exact duplicate collapse and before class-aware near-duplicate processing and evidence scoring. Every retained log block receives an `error_classification` record, including blocks classified as `unknown`.

Recommended decision order:

1. configured domain rules;
2. explicit source metadata, severity, exit code, signal, or status code;
3. known exception and failed-test structures;
4. keyword and template rules;
5. an optional bounded statistical or language-model fallback when earlier rules are inconclusive.

Example categories include:

```text
build.compilation
test.assertion
dependency.timeout
network.connection
authentication
configuration
resource.memory
runtime.exception
infrastructure
unknown
```

The classification record stores the primary category, secondary labels, confidence score, operational priority, matched reasons, classifier version, and evidence references.

```json
{
  "error_classification": {
    "category": "test.assertion",
    "secondary_labels": ["dependency.http_5xx"],
    "confidence_score": 0.96,
    "priority": "P1",
    "priority_reasons": [
      "primary failed Test-stage block",
      "nonzero test count",
      "complete assertion stack"
    ],
    "matched_rules": ["assertion-structure-v1", "http-5xx-parameter-v1"],
    "classifier_version": "error-classifier/v1",
    "priority_policy_version": "error-priority/v1",
    "needs_review": false
  }
}
```

Three values must not be confused:

| Value | Range | Question it answers |
|---|---|---|
| Classification confidence | `0.0` to `1.0` | How confident is Logsift that the category is correct? |
| Operational priority | `P0` to `P4` | How urgently or prominently should this type of failure be handled? |
| Evidence-ranking score | `0` to `100` | How useful is this block for explaining the current run within the evidence pack? |

A block can have high classification confidence and a low evidence-ranking score. For example, Logsift may be 99% confident that a final `exit_code=1` block is `pipeline.nonzero_exit`, while ranking it below the earlier assertion because the exit is a consequence.

The starting priority meanings are:

| Priority | Meaning |
|---|---|
| `P0` | Critical safety, security, data-loss, or explicitly configured stop condition; a deterministic rule is required |
| `P1` | Likely primary failure that blocks the run and needs immediate attention |
| `P2` | Important supporting failure or terminal consequence |
| `P3` | Low-impact warning or secondary symptom |
| `P4` | Informational background retained for completeness |

Priority is derived from versioned rules using category, explicit severity, failed scope, terminal impact, and known safety conditions. Classification confidence alone must never promote a block to `P0`. A model-only fallback may suggest a category, but it cannot assign `P0` without a deterministic rule.

When confidence is below the configured threshold, Logsift uses category `unknown` or keeps the best category with `needs_review: true`. It still preserves severity and candidate reasons, so an uncertain category does not hide potentially important evidence.

Code knowledge is not required for broad classification. A log can usually be classified as `test.assertion` or `dependency.timeout` from the evidence and metadata. Commit-matched code in Phase 3 may later refine the likely component or cause.

#### 3.2.11 Scoring and ranking

Scoring answers: “Which blocks are most useful for explaining this failure?” It does not replace classification confidence or operational priority, and it does not answer: “How many tokens does each block receive?” Token selection is a later step.

The first scoring version deliberately uses only three factors. A ten-factor formula can look accurate before the team has enough confirmed failures to justify its weights.

Every factor is normalized to a value from `0` to `1`:

| Factor | Meaning | Starting calculation | Weight |
|---|---|---|---:|
| `N` novelty | How different the block's template or transition is from the compatible baseline | `1.0` for a new fingerprint; lower documented values for a changed sequence, scope, frequency, or safe parameter; `0` for known normal behaviour | 0.40 |
| `S` severity | Strength of an explicit exception, assertion, error, nonzero exit, or failed terminal state | Versioned severity mapping; for example fatal `1.0`, error/assertion `0.8`, warning `0.4`, informational `0.1` | 0.35 |
| `P` failure proximity | How close the block is to the failed transition inside the same stage or node | `max(0, 1 - logical_distance / configured_window)` | 0.25 |

The provisional first-version formula is:

```text
base score = 100 × clamp(0, 1, 0.40N + 0.35S + 0.25P)
```

`logical_distance` counts events inside the same Jules stage attempt or Lattice node attempt. Proximity is useful supporting information, but it is not proof of causality.

Logsift should still record frequency shift, scope relevance, stack structure, correlation, parameter shift, source confidence, evidence quality, repetition, and duplicate information. These signals remain visible in the block and can guide required-inclusion and diversity rules, but they do not receive score weights until evaluation on confirmed failures shows that they improve ranking.

For the first version, deterministic rules may require a block, such as approved `P0` security evidence or the final nonzero exit. They should not add unexplained numeric boosts. A later scoring-policy version may add factors or bounded adjustments only after each signal has a documented `0` to `1` calculation and measured benefit.

##### Small scoring example

| Block | Classification and confidence | Priority | `N` | `S` | `P` | Evidence score |
|---|---|---|---:|---:|---:|---:|
| API timeout and assertion | `test.assertion`, 0.96 | `P1` | 1.0 | 0.9 | 0.9 | 94 |
| Terminal exit code 1 | `pipeline.nonzero_exit`, 0.99 | `P2` | 0.6 | 0.8 | 1.0 | 77 |
| Repeated cache warning | `infrastructure.warning`, 0.82 | `P3` | 0.0 | 0.4 | 0.2 | 19 |

The most frequent message is not automatically the best evidence. Frequency remains a LogDiff signal and selection constraint, while repeated copies are handled by deduplication and diversity rules rather than receiving an untested numeric weight.

##### Transparent score records

Every scored block stores:

- its classification category, confidence, operational priority, classifier version, and priority-policy version as separate fields;
- the three scored factors and their exact calculations;
- additional unscored signals retained for evaluation;
- baseline and failed counts or parameter shares;
- weights and policy version;
- required-inclusion or exclusion rules;
- final score;
- a short plain-language explanation.

This allows an engineer to verify why a block was selected instead of trusting an unexplained number.

Tie-breaking order is:

1. required evidence;
2. higher final score;
3. stronger provenance and segmentation confidence;
4. closer causal relationship to the failing stage or node;
5. earlier source position for deterministic output.

#### 3.2.12 Token optimization

The model context is shared by several sections:

```text
log evidence budget = total model context
                    - instructions
                    - pipeline metadata and LogDiff
                    - retrieved knowledge and code
                    - model response
                    - safety margin
```

A starting 32,000-token profile is:

| Use | Tokens |
|---|---:|
| Instructions | 3,000 |
| Pipeline metadata and LogDiff | 2,000 |
| Retrieved knowledge and code | 6,000 |
| Model response | 5,000 |
| Safety margin | 2,000 |
| **Available log evidence** | **14,000** |

These are configurable starting values. Logsift must use the target model's tokenizer for the final count.

Each block can have four representations:

| Form | Meaning |
|---|---|
| Full | Keep the complete selected block. |
| Compact | Remove repeated envelopes and low-value middle content while preserving structure. |
| Summary | Keep the important facts, counts, and exact source references. |
| Omit | Keep the stored block but do not place its text in this model request. |

Selection proceeds as follows:

1. reserve the smallest safe form of required evidence, including every `P0` block and configured `P1` categories;
2. choose high-scoring causal and structured evidence;
3. enforce minimum representation for critical failed scopes;
4. keep different evidence types and stages or nodes represented;
5. avoid selecting many near-identical blocks;
6. upgrade important blocks to compact or full form while budget remains;
7. count the completely assembled request again;
8. record every summary, truncation, and omission.

A lower-scoring block may be selected when it has higher operational priority or adds a missing stage, node, configuration event, or earlier causal step. Evidence score determines ranking preference, not a fixed token allocation and not the operational priority label.

Safe compaction never changes the restricted raw log. It works only on derived evidence and must not cut through a UTF-8 character, physical line, stack frame, JSON record, exception header, or caused-by chain.

#### 3.2.13 Final evidence pack and LLM contract

The final evidence pack contains:

1. failure summary;
2. pipeline, source, branch, repository, and commit metadata;
3. baseline compatibility result;
4. template and parameter diff;
5. ranked evidence blocks;
6. counts and statistical reasons;
7. exact provenance;
8. classification and score explanations;
9. compaction and omission notices;
10. references to the immutable full log.

The highest-signal evidence appears early in the model input so it is not buried inside a long context. Internal lines inside each block remain in logical order.

For every selected block, the model input includes:

- error category and secondary labels;
- classification confidence score;
- operational priority and priority reasons;
- evidence-ranking score and score explanation;
- classifier, priority-policy, and scoring-policy versions;
- exact provenance and protected block text.

The classification is a structured diagnostic signal, not proof of the root cause. The model may explain that a category is uncertain or inconsistent with the block, but it must cite the block and must not silently rewrite the stored classification.

The model must return an evidence-to-claim mapping. A recommended response shape is:

```json
{
  "claims": [
    {
      "claim": "The payment dependency was unavailable during the Test stage.",
      "evidence_block_ids": ["block-17", "block-21"],
      "retrieved_source_ids": ["runbook-9"],
      "confidence": 0.88,
      "uncertainties": ["Dependency health telemetry was unavailable."]
    }
  ]
}
```

An unsupported claim must be marked as uncertain or omitted. Current failed-run evidence remains authoritative when historical documents or previous incidents conflict with it.

#### 3.2.14 Five-million-line example

Assume a failed Jules log contains five million physical lines.

Pass 1 streams the log and produces:

```text
1,800 unique fingerprints
3 Jules stage attempts
47 occurrences of fp-api-error in Test
2 keyword-hit groups
1 nonzero terminal exit
```

Keyword, severity, and terminal rules expand their bounded candidates while Pass 1 is already reading the log. After the last line, Logsift freezes the run-local Drain parser, maps every run-local cluster ID to its final fingerprint, and then runs LogDiff.

The compatible baseline normally contains two `fp-api-error` occurrences in Test. LogDiff creates selectors for the frequency shift and any other changes that were not already sufficient direct candidates.

For a normal one-time analysis, frozen read-only Pass 2 streams the same raw log again. It does not hold five million lines. When it reaches line 1,842,991:

```text
fingerprint + scope matches a selector
  -> create candidate pointer
  -> copy four Test events from the Test ring buffer
  -> collect six following Test events
  -> extend through the complete assertion stack
  -> write one protected fragment
```

A repeated error at line 1,842,994 extends the open fragment. Later, deduplication records two occurrences instead of copying the same story twice.

If measurement selected the temporary thin-index strategy, Pass 1 wrote compact cluster, segment, logical-position, line, chunk, and byte references. LogDiff resolves `fp-api-error` to its run-local cluster dictionary ID, and Logsift range-reads only the matching and neighbouring regions instead of replaying five million lines.

For Lattice, the same process uses the matching node-attempt buffer. Physically interleaved output from other nodes is ignored, while the resulting fragment retains every noncontiguous raw byte range.

At no point are five million log lines loaded into application memory or written as five million JSON index records. A temporary binary entry per parsed event exists only when the measured thin-index strategy is enabled.

#### 3.2.15 End-to-end example using the final design

The [final-design example set](examples/final-design/README.md) is the authoritative worked example for this document. It contains synthetic data and follows the selected design without a permanent per-line index.

The Jules example moves through the complete flow:

| Step | Input | Output | What changed |
|---|---|---|---|
| Offline learning | [Trusted success log](examples/final-design/jules/success.log) | [Success baseline](examples/final-design/jules/success-baseline.json) | Dynamic values became templates; counts, safe values, and stage-local order became the normal baseline. |
| Analysis start | Terminal event and immutable failed log | [Analysis manifest](examples/final-design/jules/analysis-manifest.json) | One processing configuration, raw-log version, baseline, replay strategy, and limits were pinned before Pass 1. |
| Failed Pass 1 | [Failed log](examples/final-design/jules/failed.log) | [Failed summary](examples/final-design/jules/failed-template-summary.json) | Eleven physical lines became run-local cluster counts; the parser was then frozen and the final clusters were mapped to fingerprints. Direct keyword, severity, and terminal candidates were expanded inline. |
| LogDiff | Success baseline plus failed summary | [LogDiff result](examples/final-design/jules/logdiff-result.json) | Logsift found a new retry path, a status and duration shift, an assertion, a nonzero test count, a nonzero exit, and missing package output. |
| Failed occurrence lookup | Failed log plus LogDiff selectors | [Candidate occurrences](examples/final-design/jules/candidate-occurrences.jsonl) | Direct Pass 1 candidates and frozen-replay matches became five selected events with exact line, logical-position, byte, segment, fingerprint, reason, and discovery-path pointers. |
| Expansion | Candidate occurrences plus Test-stage ring buffer | [Expanded fragment](examples/final-design/jules/expanded-fragments.jsonl) | Overlapping before-and-after windows and the complete stack trace became one protected Test-stage fragment. |
| Block construction, deduplication, and classification | Expanded fragment | [Log blocks](examples/final-design/jules/log-blocks.jsonl) | The likely assertion cause and terminal exit became separate blocks. Each block received an error category, confidence score, priority, reasons, and exact provenance. |
| Scoring and token selection | Classified log blocks plus policy | [Evidence pack](examples/final-design/jules/evidence-pack.json) | The provisional three-factor policy gave the assertion block score 94 and the terminal consequence score 77. Both fit without unsafe trimming. |
| Model assembly | Evidence pack | [Final model input](examples/final-design/jules/llm-input.md) | The model receives classifications, priorities, scores, measurable differences, selected evidence, and exact references instead of the complete log. |

The same folder contains a [physically interleaved Lattice log](examples/final-design/lattice/failed.log). Its [candidate occurrences](examples/final-design/lattice/candidate-occurrences.jsonl) point to physical lines 6, 8, and 10. The [expanded Lattice fragment](examples/final-design/lattice/expanded-fragments.jsonl) correctly includes node-local lines 2, 4, 6, 8, and 10 while excluding physical lines owned by other DAG nodes.

This example set should be updated whenever a contract in this document changes. A schema change is complete only when the explanation, example artifacts, compatibility version, and tests all change together.

#### 3.2.16 Failure-analysis implementation checklist

Before implementation is considered complete, verify:

- the raw log becomes immutable before analysis;
- `analysis-manifest.json` pins one complete processing configuration, raw-log object version, baseline version, limits, and occurrence strategy before Pass 1;
- Pass 1 uses a private run-local Drain copy and never changes the published success baseline;
- run-local templates and fingerprints are finalized only after Pass 1 ends;
- Pass 2 loads the exact finalized catalog in read-only mode and cannot create or update templates;
- deterministic replay produces the expected fingerprint, segment, logical-position, and occurrence counts, or the analysis is marked `partial` and `needs_review`;
- failed parsing never updates the successful Drain baseline;
- selectors use stable fingerprints and compatible scope, never local template IDs;
- Aho–Corasick rules are versioned and literal-only;
- complex expressions are bounded and tested;
- Jules buffers are stage-attempt scoped;
- Lattice buffers are node-attempt scoped;
- chunk boundaries preserve lines, segments, buffers, and open fragments;
- candidate records carry `analysis_id` and exact provenance;
- repeated selection reasons merge into one occurrence;
- direct Pass 1 candidates are not expanded again during Pass 2;
- the optional thin index uses a compressed binary dictionary, includes segment and logical position for Lattice, and has a short retention period;
- worker pools, queues, candidate groups, fragments, and memory are bounded;
- cancellation, retry, leases, and cleanup are implemented;
- deduplication retains counts and locations;
- every log block has a versioned error category, confidence score, priority, priority reasons, and review flag;
- classification confidence, operational priority, and evidence-ranking score remain separate fields;
- the initial score uses only documented novelty, severity, and proximity calculations; additional factors require evaluation and a new policy version;
- token selection uses the target tokenizer;
- every final claim cites evidence;
- incompatible or partial evidence is reported clearly;
- a permanent full sidecar is not created; a temporary thin index, memory mapping, SIMD filtering, and other low-level optimizations remain benchmark-driven choices.

### 3.3 Phase 3 — Solution finding

> **Status: TODO**

Phase 3 will start with the evidence pack created by failure analysis. Its purpose will be to find trusted documents, previous confirmed incidents, configuration, ownership, and code that can help explain the failure and guide a fix.

The recommended detailed design is now in [Logsift Phase 3: RAG knowledge and code context](logsift_phase3.md). It explains the knowledge-learning mode, failure-retrieval mode, validated-feedback mode, hybrid search, commit-matched code, permissions, token limits, citations, evaluation, and implementation steps.

RAG means retrieval-augmented generation. Instead of asking the model to answer only from its general training, Logsift first searches approved company knowledge and the matching repository snapshot. It then gives the model a small set of relevant source material together with the current failure evidence.

A vector database is one search component. It stores numerical representations called embeddings so documents with similar meaning can be found even when they use different words. It is not the complete knowledge system. Exact-text indexes are still better for error strings, fingerprints, symbol names, configuration keys, and file paths. A code graph is better for relationships such as “function calls dependency,” “test covers function,” or “pipeline step uses configuration.”

The selected retrieval flow is:

```text
evidence pack
  -> extract exact errors, fingerprints, components, stages, repository, and commit
  -> apply seal, permission, repository, commit, service, and time filters
  -> run exact-text search
  -> run vector search
  -> traverse related code and dependency symbols
  -> merge and rerank by relevance, trust, freshness, and compatibility
  -> remove repeated context and preserve source diversity
  -> fit results into the retrieval token budget
  -> send cited context to the model
```

Knowledge ingestion and failure retrieval are separate modes:

- **Knowledge-learning mode** parses, redacts, chunks, versions, permission-tags, and indexes approved runbooks, documents, confirmed incidents, fixes, ownership data, pipeline definitions, configuration, source code, and tests.
- **Failure-retrieval mode** reads the current evidence pack and searches only material the caller may access.
- **Validated-feedback mode** adds a confirmed root cause and fix only after human or approved-system validation. A suspected model answer never becomes trusted knowledge automatically.

Every code record must carry `seal_id`, `project_id`, `repo_id`, branch, and commit SHA. Retrieval must reject code from another commit unless an explicit compatibility rule allows a clearly labelled fallback. The model must never receive wrong-version code silently.

Every retrieved item keeps:

- source type and stable record ID;
- exact document, file, symbol, or line location;
- repository, branch, commit, service, and pipeline metadata when relevant;
- permission fields;
- creation and last-validation time;
- trust and freshness values;
- content or a secure content reference;
- parent-child and graph relationships.

The evidence-to-claim contract from failure analysis continues in Phase 3. Each diagnosis or remediation statement must cite current evidence-block IDs and, when used, retrieved source IDs. Confidence must decrease when sources are stale, conflicting, incomplete, or from a compatible fallback rather than the exact commit.

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
| Adaptive failed-log occurrence lookup | Normal logs use one summary pass plus frozen read-only replay; large or repeatedly analysed logs may use a temporary thin index and targeted reads. | Replay adds CPU and read cost; the index adds write, storage, and cleanup cost. | Pin the choice before Pass 1, measure both paths, expand direct candidates in Pass 1, and use the index only past a measured break-even point. |
| Mutable Pass 1 and frozen Pass 2 | Pass 1 can discover failed-run templates, while Pass 2 can find their exact occurrences without changing them. | Drain templates evolve during Pass 1, so intermediate fingerprints or an independently rebuilt parser can disagree. | Count by run-local cluster ID, fingerprint only final templates, persist the final catalog, make replay read-only, and validate occurrence counts. |
| Three candidate routes | LogDiff finds changed behaviour, keywords keep obvious failures, and the log tail keeps useful terminal output. This improves recall. | More routes can produce more noise and duplicate candidates. | Merge by `occurrence_id`, keep all reasons, use bounded per-route sampling, and let later scoring reject unrelated evidence. |
| Aho–Corasick literal matching | Checks all configured literal failure words during one message scan. | It does not express every complex pattern and a broad keyword can still create noise. | Keep literals in the shared matcher, use only bounded tested expressions for complex cases, group repeated hits, and version the rules. |
| Four lines before and six after | Provides a simple and repeatable starting window that works for many errors. | A fixed window may be too small for a long stack trace or too large for a short message. | Extend to complete known structures, stop at safe boundaries, enforce size limits, and keep the window configurable. |
| Segment-aware expansion | Jules context stays in its stage attempt, while Lattice context stays in its node attempt even when physical lines are interleaved. | Source adapters and segmentation rules become more complex. Incorrect segmentation can select the wrong context. | Store segmentation confidence, validate source metadata, and use a marked lower-confidence physical fallback instead of guessing. |
| Per-segment ring buffers | Expand Jules and interleaved Lattice context with memory independent of total log size. | Memory grows with active segments and open fragments, not just window size. | Bound active segments, window size, fragment size, open fragments, and queued writes; apply backpressure when limits are reached. |
| No permanent full line-level sidecar | Avoids millions of durable JSON records and long-term cleanup cost. | Replay may be expensive for very large or repeatedly inspected logs. | Persist candidate-only pointers by default. When measured benefit is clear, use a short-lived compressed binary thin index with dictionary IDs, segment/logical positions, and delta-encoded offsets. |
| Pointer-only candidate pool | Keeps memory and storage small and isolates concurrent analyses with `analysis_id`. | Expansion depends on the referenced raw log still being available and unchanged. | Use immutable log object IDs, keep raw-log retention longer than analysis retention, validate the object version, and fail clearly when content is unavailable. |
| Stable template fingerprints | Workers can compare templates without trusting parser-local numeric IDs. | A change to normalization, masking, Drain settings, or fingerprint rules can change many fingerprints. | Version every processing step and refuse normal comparison when versions are incompatible. |
| Rich LogDiff checks | Frequency, scope, order, severity, and safe parameter changes can find failures that simple template membership misses. | More checks add tuning work and may create false positives. | Start with conservative thresholds, store the reason for every result, and validate rules with real successful and failed runs. |
| Safe parameter distributions | Finds important changes such as status-code or duration shifts that masking hides from template text. | Retaining too many values can increase storage or expose sensitive information. | Allow only typed safe fields, aggregate high-cardinality IDs, apply redaction first, cap enumerations, and version the parameter schema. |
| Recent-template cache | Can reduce repeated Drain routing for locally repeated templates. | Cache state adds memory and could create inconsistent parsing if implemented incorrectly. | Treat it as optional, bound it per compatible scope, require identical output with cache disabled, and enable it only after measurement. |
| Deduplication | Removes repeated evidence and saves model tokens. | Similar-looking events from different attempts or nodes may have different meaning. | Deduplicate only with compatible scope rules and retain counts, every affected scope, first and last occurrence, examples, and all raw locations. |
| Error classification and priority | Gives engineers and the model a consistent category, confidence, and handling priority for each block. | A wrong but confident label or inflated priority can bias ranking and diagnosis. | Keep reasons and versions, calibrate confidence, require deterministic rules for `P0`, preserve `unknown`, and keep classification separate from evidence scoring. |
| Simple first scoring policy | Novelty, explicit severity, and failure proximity are understandable and available before richer calibration exists. | It may miss useful correlation, scope, parameter, or structure signals. | Keep those signals as unscored metadata, use required/diversity rules where necessary, and add a factor only after its calculation and measured ranking benefit are documented in a new policy version. |
| Token optimization | Keeps model requests within a predictable cost and context limit. | Compacting, summarizing, or omitting evidence can remove useful detail. | Keep required structures intact, shorten only derived evidence at safe boundaries, record every omission, and retain pointers to the full raw evidence. |
| Evidence-to-claim mapping | Makes every important diagnosis and remediation statement auditable. | The response contract is stricter and can expose missing evidence instead of producing a confident answer. | Require evidence IDs, source IDs, confidence, and uncertainties; treat inability to support a claim as a correct limitation. |
| Redaction and masking | Protects secrets and reduces dynamic noise before templates or derived evidence are stored. | An overly broad rule can remove useful diagnostic values or merge different messages. | Test and version the rules, use typed placeholders, allow safe exceptions, record rule matches without secret values, and stop processing when redaction cannot be trusted. |

These controls reduce the risks, but they do not remove the need for testing. Values such as candidate limits, window sizes, scoring weights, similarity thresholds, and token reservations remain recommended starting points until Logsift is evaluated on representative Jules and Lattice failures.

## 5. Testing and accuracy

Logsift must be tested as an evidence system, not only as a collection of independent parsers. A component can look correct by itself and still produce a bad final diagnosis when its output is combined with later stages.

### 5.1 Build a representative evaluation set

The evaluation set should contain real but safely handled Jules and Lattice runs, plus synthetic cases for rare safety failures. It needs:

- trusted successful runs from main, master, and approved release branches;
- failed runs with confirmed causes and fixes;
- small, medium, and multi-million-line logs;
- sequential Jules stages and heavily interleaved Lattice nodes;
- retries, stack traces, multiline output, truncated uploads, missing metadata, and unknown source formats;
- repeated messages, parameter-only changes, missing templates, wrong-scope templates, and order changes;
- secrets split across fields and lines;
- simultaneous analyses from several repositories and tenants;
- failures where the last error is a consequence rather than the cause;
- failures for which the correct result is “insufficient evidence.”

Each labelled failure should identify the minimum evidence needed to understand the cause, the first causal signal, acceptable supporting context, known noise, and the confirmed diagnosis. Two engineers should review difficult labels, and disagreements should be resolved before the run becomes evaluation data.

Training or tuning examples must not also be used as the final test set. Hold out newer time periods and, where possible, entire repositories so the result measures general behaviour rather than memorization.

### 5.2 Test every component

| Component | What to test | Failure that the test should catch |
|---|---|---|
| Event eligibility | Branch, outcome, completeness, IDs, versions, retries, and duplicate events | An untrusted or incomplete run updates the baseline |
| Source detection | Correct Jules, correct Lattice, conflicting metadata, and unknown headers | Logsift guesses the source and applies the wrong segmentation |
| Normalization | Encoding, control characters, prefixes, timestamps, and line/byte provenance | Two equivalent lines stay different or original locations are lost |
| Redaction | Every configured secret type, multiline secrets, and adversarial formatting | A secret reaches a template, block, metric label, or model input |
| Masking | Dynamic values, allow-list exceptions, and safe parameter extraction | Different messages merge or an important diagnostic value disappears |
| Segmentation | Stage/node ownership, attempts, lifecycle events, and Lattice interleaving | Context from another stage or node enters the block |
| Drain and fingerprinting | Split/merge quality, run-local cluster stability, final fingerprinting, frozen read-only replay, deterministic tie-breaking, version changes, and text verification | Intermediate or replayed templates receive different fingerprints or occurrence counts |
| LogDiff | New, missing, frequency, parameter, scope, severity, and sequence changes | Important differences are missed or incompatible baselines are compared |
| Aho–Corasick rules | Case policy, word boundaries, overlapping terms, Unicode, and hit limits | One broad word floods the candidate pool or a critical literal is missed |
| Candidate pool | Idempotency, compare-and-set merging, leases, expiry, and partition keys | Two concurrent analyses mix state or retries duplicate candidates |
| Ring-buffer expansion | Chunk boundaries, before/after windows, stack extension, segment closure, and overlap merging | Before-context is lost or Lattice output is mixed physically |
| Optional thin index | Dictionary mapping, delta decoding, segment/logical lookup, noncontiguous Lattice ranges, expiry, and comparison with replay output | The index returns the wrong event, silently loses context, or remains stored longer than policy allows |
| Blocks and deduplication | Exact, canonical, retry-loop, and near-duplicate cases | Deduplication removes different causes or loses occurrence history |
| Classification and scoring | Category accuracy, confidence calibration, priority rules, factor values, explanations, and deterministic ties | An uncertain category becomes `P0`, or a repeated warning outranks the first causal error without explanation |
| Token selection | Exact tokenizer, quotas, safe boundaries, summaries, and final recount | A stack trace is cut incorrectly or the request exceeds the model limit |
| Retrieval and diagnosis | Permission, repository, commit, trust, freshness, citations, and uncertainty | Wrong-version code or an unsupported historical fix drives the answer |

Every bug fix should add a regression case at the lowest failing component and an end-to-end case when the final evidence pack was affected.

### 5.3 Measure evidence accuracy

The main evidence metrics are precision and recall:

```text
evidence recall = required labelled evidence selected / all required labelled evidence
evidence precision = useful selected evidence / all selected evidence
```

Recall answers, “Did Logsift keep the lines needed to understand the failure?” Precision answers, “How much of the selected pack was actually useful?” Both matter. Keeping the whole log would have high recall but unusably low precision.

Other required measurements are:

| Metric | Meaning |
|---|---|
| Source-detection accuracy and `UNKNOWN` rate | Whether the correct adapter was chosen without unsafe guessing |
| Segmentation accuracy | Percentage of logical events assigned to the correct stage or node attempt |
| Template grouping precision and recall | Whether Drain avoids merging different message families and splitting one family unnecessarily |
| LogDiff recall by reason | Whether each known new, missing, frequency, scope, order, severity, or parameter change was found |
| Expansion coverage | Percentage of labelled causal context included in the expanded fragments |
| Expansion contamination | Percentage of expanded events that belong to an unrelated scope or story |
| Deduplication preservation | Whether collapsed blocks retain correct counts, scopes, and locations |
| Classification precision and recall | Whether each error category is assigned correctly |
| Confidence calibration | Whether blocks labelled near 0.9 confidence are correct roughly 90% of the time on representative data |
| Priority agreement | Whether `P0` to `P4` assignments match approved operational rules and engineer review |
| Top-block accuracy | How often the first few ranked blocks contain the labelled cause |
| Retrieval recall at `k` | Whether a required runbook, incident, symbol, or configuration appears in the first `k` results |
| Claim support rate | Percentage of important diagnosis claims backed by valid evidence or source IDs |
| Human diagnosis quality | Engineer rating of correctness, usefulness, uncertainty, and suggested next checks |

Broad error classification can be measured separately with per-category precision and recall. A correct category does not prove a correct root cause, so classification results must not be used as a substitute for evidence or diagnosis testing.

### 5.4 Safety and isolation gates

The following are release gates, not averages:

- every seeded secret in the security test corpus is redacted before derived storage or model input;
- every selected block resolves to the expected immutable log object, version, line, byte range, and segment;
- incompatible processing versions are rejected;
- a worker cannot replace a pinned processing version with the newest deployed version;
- replay occurrence counts match Pass 1 for selected fingerprint scopes, or the result is marked `partial` and `needs_review`;
- wrong-tenant, wrong-repository, unauthorized, and wrong-commit retrieval results are blocked;
- concurrent `analysis_id` tests show no cross-request candidates, buffers, fragments, or blocks;
- retry and checkpoint tests produce the same logical result as an uninterrupted run;
- every `P0` assignment is backed by an approved deterministic priority rule and exact block evidence;
- memory, candidate, fragment, queue, and token limits are enforced without silent evidence loss;
- partial or truncated input is visibly marked and never presented as complete.

As a provisional product-quality target, the team can begin with at least 95% recall for labelled critical evidence, at least 70% precision in the final evidence pack, at least 95% expansion coverage, and no more than 5% unrelated-scope contamination. These are starting targets, not current Logsift results. They must be revised after the evaluation set represents real Jules and Lattice workloads.

### 5.5 Performance, concurrency, and reliability tests

Run load tests with realistic log-size and concurrency distributions, not only one five-million-line file on an idle machine. Measure:

- bytes processed per second for Pass 1, frozen replay, and targeted thin-index reads;
- direct-candidate percentage expanded during Pass 1;
- replay versus thin-index latency, CPU, bytes read, bytes written, and storage break-even;
- p50, p95, and p99 time from terminal event to evidence pack;
- peak memory per worker and per active analysis;
- active Lattice segment count and ring-buffer memory;
- candidate, fragment, and writer-queue depth;
- storage read throughput and throttling;
- checkpoint size and retry work;
- fairness between small and large runs;
- cancellation time and cleanup success;
- baseline and metadata-store contention.

Test with cold storage caches as well as warm caches. A design that is fast only after the operating system has cached the log is not a reliable capacity result.

### 5.6 Release process and production monitoring

Every rule, parser, fingerprint, scoring, token, and retrieval-policy version should have a saved evaluation report. A new version first runs in replay or shadow mode, where it produces results without changing the authoritative baseline or user-visible diagnosis. Compare it with the current version before a limited rollout.

Production monitoring should track evidence recall from confirmed feedback when available, candidate volume, unknown-source rate, redaction failures, incompatible-baseline rate, partial analyses, model-token use, unsupported claims, latency, memory, and cost. A sudden change after a rule or parser release should stop further rollout.

## 6. Cost analysis

Cost analysis answers two questions: how much Logsift costs to operate, and whether the cost is lower than the engineering time and delivery delay it saves. The calculation should use measured usage, not only a theoretical big-O estimate.

### 6.1 Main cost drivers

| Area | What creates cost | Important control |
|---|---|---|
| Successful learning | One sequential preprocessing and Drain pass over eligible successful logs | Learn only from trusted runs and publish compact summaries |
| Failed analysis | One required summary pass, direct expansion, LogDiff, and either frozen replay or temporary thin-index lookup | Bounded workers, candidate limits, pinned strategy, short index retention, and measured break-even rules |
| Raw-log storage | Log size, compression, replicas, and retention time | Independent compression, lifecycle deletion, and policy-based retention |
| Derived storage | Baselines, summaries, candidates, fragments, blocks, and evidence packs | Immutable compact artifacts, expiry, and deduplication |
| Model use | Input evidence, retrieved context, and output tokens | Token reservations, deduplication, compact forms, and request limits |
| Knowledge indexing | Changed document and code chunks, embeddings, exact index, and graph metadata | Incremental commit-aware indexing and stale-record deletion |
| Retrieval | Exact, vector, and graph queries plus reranking | Candidate caps, filters before retrieval, and caching only when safe |
| Operations | Monitoring, retries, dead-letter handling, encryption, and support | Automation, clear ownership, and capacity headroom |

### 6.2 Monthly cost model

Use these measured quantities:

- `S` = bytes from eligible successful logs processed during the month;
- `F` = bytes from failed logs analysed during the month;
- `F_replay` = failed-log bytes read again by the frozen replay strategy;
- `R_targeted` = raw-log bytes fetched by thin-index range reads;
- `I_written` = compressed thin-index bytes written;
- `W` = total worker seconds consumed by preprocessing, parsing, LogDiff, and expansion;
- `G_raw` = average raw-log gigabytes retained during the month;
- `G_derived` = average baseline, candidate, block, and evidence gigabytes retained;
- `T_in` = total model input tokens;
- `T_out` = total model output tokens;
- `T_embed` = tokens embedded for changed knowledge and code;
- `Q_store` and `Q_retrieval` = storage and retrieval request counts.

The expected internal raw-log read volume for the adaptive flow is approximately:

```text
raw-log bytes read = S + F + F_replay + R_targeted
```

The successful flow reads eligible logs once. Every failed log contributes its Pass 1 bytes to `F`. Only replayed logs contribute to `F_replay`; thin-index analyses contribute targeted raw reads instead. `I_written` is counted as derived-storage write volume. Upload traffic and checkpoint replay are counted separately so they do not disappear inside this estimate.

The total monthly operating cost is:

```text
compute cost
  = W × compute price per worker-second

storage cost
  = G_raw × raw-storage price per GB-month
  + G_derived × derived-storage price per GB-month
  + storage-request charges

model cost
  = T_in × input-token price
  + T_out × output-token price

knowledge cost
  = T_embed × embedding price
  + index storage
  + retrieval and reranking requests

total cost
  = compute + storage + model + knowledge + network + operational overhead
```

Use the price unit required by the provider, such as price per million tokens, rather than inserting a hard-coded price into the architecture. Keep the rate card and the usage measurements separate so the same model works when prices change.

### 6.3 Cost record for every analysis

Each `analysis_id` should emit a cost-usage record containing:

- raw bytes, compressed bytes, and bytes read in each pass;
- chosen occurrence strategy, direct candidates expanded during Pass 1, thin-index bytes written, targeted range-read bytes, and index retention time;
- worker seconds and peak memory;
- segment, template, keyword-hit, selector, and candidate counts;
- fragment bytes before and after overlap merging;
- block bytes before and after deduplication;
- tokens estimated, selected, sent, and returned;
- retrieval candidates, reranked results, and context tokens;
- derived bytes written and retention class;
- retries, checkpoint replay bytes, timeouts, and partial-result status.

These records allow cost to be grouped by tenant, repository, source type, pipeline, failure category, and month without putting raw log text into billing metrics.

### 6.4 Compare design choices with measured break-even points

The temporary thin-index decision is a good example. Let:

- `C_index` be the cost to build, store, query, and later delete the compressed thin index;
- `C_rescan` be the cost of one additional sequential Pass 2;
- `Q` be the number of analyses or interactive searches expected for the same immutable failed log.

Build the optional index only when:

```text
C_index < (Q - 1) × C_rescan
```

For the usual one-time analysis, `Q` is close to 1 and the index has no break-even benefit. For a repeatedly investigated incident, a compact index may become cheaper. The decision should use observed log size, query count, storage duration, and read cost.

Use the same approach for other options:

- enable a recent-template cache only when saved parser time is larger than its memory and complexity cost;
- use a larger expansion window only when added evidence recall is worth the extra block and token cost;
- use a more expensive model only when diagnosis quality improves enough on the evaluation set;
- retain raw logs longer only when audit, replay, or learning value justifies the storage and security cost.

### 6.5 Unit economics and business value

Report at least these unit costs:

- cost per eligible successful run learned;
- cost per failed run analysed;
- cost per million failed-log lines;
- cost per evidence pack;
- model and retrieval cost per grounded diagnosis;
- stored bytes per raw-log gigabyte;
- engineer minutes saved per confirmed diagnosis.

A simple value calculation is:

```text
monthly net value
  = value of engineer hours saved
  + value of reduced delivery delay
  - total monthly Logsift operating cost
```

The saved-time estimate should compare a control period or control group with Logsift-assisted investigations. Do not claim savings only because the evidence pack is smaller.

### 6.6 Cost guardrails

Configuration must set hard limits for bytes processed per analysis, concurrent workers per tenant, candidates per reason and fingerprint, open fragments, fragment bytes, retained artifacts, retrieval candidates, model input and output tokens, retries, and total analysis time. When a limit is reached, Logsift returns a visible partial result and the reason. It must not silently overspend or silently remove critical evidence.

Cost dashboards should show p50, p95, and p99 rather than only averages. One unusually large tenant, log, or retry storm can dominate the bill even when average cost looks acceptable.

## 7. Conclusion

The design now gives Logsift a clear path from trusted successful runs to a versioned baseline, and from a failed run to a small evidence pack with exact provenance.

The important boundaries are explicit:

- only eligible successful runs can update the baseline;
- Jules stages and Lattice nodes keep their own scope and order;
- failed analyses pin one complete processing configuration and never teach the successful baseline;
- candidate discovery combines LogDiff, configured failure keywords, and the source-aware log tail;
- Pass 1 uses a private run-local Drain copy, then freezes it and fingerprints only its final templates;
- obvious candidates expand during Pass 1; remaining LogDiff selectors use frozen read-only replay or a measured temporary thin index;
- Aho–Corasick checks all literal failure keywords during one message scan;
- large logs are streamed in bounded chunks instead of being loaded completely into memory;
- per-stage and per-node ring buffers expand context correctly, including interleaved Lattice output;
- only candidate and fragment pointers are persisted by default; a permanent full sidecar is not required;
- an optional thin index uses compressed dictionary IDs and segment-aware pointers, has short retention, and is enabled only when it beats replay;
- deduplication reduces repeated evidence without losing its history;
- safe parameter distributions preserve diagnostic changes that masking removes from template text;
- error classification, confidence, operational priority, evidence scoring, and token selection are separate decisions with stored explanations;
- every shortened or selected block remains connected to its exact source.
- every final diagnosis must map its claims to evidence and retrieved source IDs.
- accuracy is measured with labelled end-to-end failures, safety gates, and concurrent isolation tests;
- cost is measured per run and per analysis, with explicit limits and break-even checks for optional optimizations.

Some structures in this document are recommended starting contracts because the final integrations and storage implementations do not define them yet. They should become implementation contracts only after validation, testing, and review.

## 8. Future work

> **Status: TODO**

The following work is intentionally left open:

- [ ] Review and approve the Phase 3 retrieval, code-context, root-cause, and remediation contracts before implementation.
- [ ] Confirm the real Jules and Lattice source markers, event fields, stage or node boundaries, attempts, terminal states, and ordering guarantees.
- [ ] Finalize the canonical event, rule-file, segment manifest, raw-log manifest, candidate-pool, evidence-block, and storage contracts.
- [ ] Select the persistent stores for baselines, candidate state, evidence blocks, analysis manifests, and restricted raw logs.
- [ ] Implement the pinned analysis manifest, private Pass 1 parser, final cluster-to-fingerprint mapping, frozen replay matcher, occurrence-count validation, compressed-log handling, restart, cancellation, retries, leases, cleanup, and concurrent `analysis_id` isolation.
- [ ] Implement the versioned Aho–Corasick literal matcher and safety rules for bounded complex patterns.
- [ ] Implement per-stage and per-node ring buffers with hard memory, candidate, fragment, and output-queue limits.
- [ ] Build a representative evaluation set containing successful and failed Jules and Lattice runs.
- [ ] Review the provisional accuracy targets and approve release gates for evidence recall, precision, expansion coverage, contamination, provenance, redaction, and isolation.
- [ ] Measure candidate recall, evidence precision, expansion accuracy, parser quality, memory use, processing time, storage cost, compression ratio, and model-token cost at p50, p95, and p99.
- [ ] Tune failure keywords, log-tail size, adaptive candidate limits, the four-before/six-after window, block-size limits, provisional novelty/severity/proximity scoring, and token reservations using the evaluation set.
- [ ] Test missing segments, low-confidence segmentation, truncated logs, unavailable raw-log objects, incompatible baselines, multiline errors, and heavily interleaved Lattice output.
- [ ] Test safe parameter types and thresholds so status, exit, duration, memory, and count changes are useful without exposing restricted values.
- [ ] Finalize the error-category taxonomy, confidence calibration method, `P0` to `P4` priority rules, classifier versioning, and human-review thresholds.
- [ ] Benchmark the optional recent-template cache and prove that it never changes parsing output.
- [ ] Add monitoring for redaction failures, incompatible versions, missing provenance, excessive fallback use, memory-limit pressure, and evidence-budget failures.
- [ ] Emit per-analysis cost-usage records and build cost dashboards for compute, storage, model tokens, indexing, retrieval, retries, and retention.
- [ ] Set tenant and repository cost budgets, alert thresholds, and visible partial-result behaviour before production rollout.
- [ ] Add an evidence-to-claim validator for final RCA and remediation output.
- [ ] Benchmark frozen replay against the optional compressed thin index by log size, parser cost, expected query count, storage duration, Jules/Lattice interleaving, and cold-cache behaviour. Approve a threshold only after measurement.
- [ ] Define retention, deletion, encryption, access-control, and audit requirements for raw logs and derived artifacts.
- [ ] Review every recommended structure with the implementation owners and replace recommendation labels only when the contract is approved.
