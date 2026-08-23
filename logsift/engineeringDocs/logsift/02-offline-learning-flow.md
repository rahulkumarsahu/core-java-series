# Logsift offline learning flow

[Architecture](01-problem-and-architecture.md) · [Failure analysis](03-failure-analysis-flow.md) · [RAG and code context](04-layer-3-rag-and-code-context.md)

Offline learning turns a trusted successful run into a small, versioned success baseline.

The complete flow is:

```text
Successful run
  → detect Jules or Lattice
  → create a learning event
  → read the log as a stream
  → normalize, redact, and mask
  → split by Jules stage or Lattice DAG node
  → create Drain templates
  → store templates, counts, scope, versions, and parser state
  → publish a new baseline version
```

This document is the one canonical explanation of preprocessing. The failed-run flow uses the same rules and versions.

## 1. Detect Jules or Lattice

Logsift must know the source type before it groups or compares log lines.

Jules and Lattice must expose different, stable signatures near the top of the log. The repository does not define the exact text of those signatures yet. They must therefore be configuration, not hard-coded guesses in this document.

### Detection steps

1. Read only a bounded prefix, not the complete log.
2. Match configured Jules signatures.
3. Match configured Lattice signatures.
4. Return `JULES`, `LATTICE`, or `UNKNOWN`.
5. If both source types match, return `UNKNOWN` and report conflicting signatures.
6. Do not create a baseline when the result is `UNKNOWN`.

The exact prefix limit is not defined in the repository. A recommended starting limit is the first 200 lines or 256 KiB, whichever comes first. Keep this configurable because source headers may change.

```yaml
# Recommended shape only. Replace the placeholders with real source signatures.
detection_version: "v1"
max_lines: 200
max_bytes: 262144
jules_signatures:
  - "<configured stable Jules header pattern>"
lattice_signatures:
  - "<configured stable Lattice header pattern>"
on_no_match: "UNKNOWN"
on_conflict: "UNKNOWN"
```

Do not use these guesses:

- “The lines look ordered, so it must be Jules.”
- “The lines are interleaved, so it must be Lattice.”

Both guesses can be wrong. A stable source signature is the decision signal.

### Why the distinction matters

| Jules | Lattice |
|---|---|
| Stages run in sequence. | DAG nodes can run in parallel. |
| Stage order is meaningful. | Node dependency and node-local order are meaningful. |
| Nearby lines usually belong to the same stage. | Nearby physical lines may belong to different nodes. |
| Compare inside a stage. | Compare inside the same DAG node and attempt. |

> **Image-generation prompt — Detecting and preserving Jules and Lattice structure**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn styling. Use dark navy headings, teal for offline learning, orange only for a small “UNKNOWN — stop learning” path, purple only in the legend, and one yellow sticky note. At left, show a large-log document with only its top 200 lines or 256 KiB highlighted. Pass this prefix through two filters labelled “Configured Jules signatures” and “Configured Lattice signatures.” Show three results: “JULES,” “LATTICE,” and “UNKNOWN.” Route JULES to sequential stage boxes “Build → Test → Package.” Route LATTICE to four DAG nodes with two parallel nodes and interleaved physical lines. Route UNKNOWN to “Do not publish baseline.” Then show separate “Jules adapter” and “Lattice adapter” boxes feeding one document titled “Canonical event,” while retaining stage or node identity. Add the sticky note “Never guess from apparent line order.” Include a compact legend. Use simple arrows, document icons, filters, one storage cylinder, and magnifying glasses. Keep a clear left-to-right flow, short labels, and generous spacing. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 2. Create the pipeline event

A terminal CI/CD event starts processing. “Terminal” means the run has reached a final state such as success, failure, cancelled, or skipped.

### Minimum event information

| Field | Why it is needed |
|---|---|
| `seal_id` | Top-level baseline owner and isolation boundary. |
| `project_id` | Selects the project. |
| `repo_id` | Selects the repository. |
| `run_id` | Keeps all work for one run together. |
| `event_id` | Makes delivery idempotent. The same event is processed once. |
| `outcome` | Decides between learning and failure analysis. |
| `branch` | Applies the learning policy. |
| `log_ref` | Points to the restricted source log. |
| `log_complete` | Prevents learning from a partial upload. |
| `created_at` | Supports ordering and audit. |
| `correlation_id` | Connects event, processing attempt, artifacts, and logs. |
| `commit_sha` | Needed later for commit-aware code retrieval. |

`source_type` is added after the bounded-prefix check. Stage and DAG-node details are read by the source adapter while the log is streamed.

### Which event starts which flow

| Event | Action |
|---|---|
| Trusted successful run | Start offline learning. |
| Failed run | Start failure analysis. Never update the success baseline. |
| Cancelled, skipped, unstable, or incomplete run | Do not update the success baseline. |
| Unknown source type | Stop and report the detection failure. |

The repository currently allows trusted main or master and release branches to contribute successful learning runs. Feature, developer, and temporary branches do not update the shared baseline. Pull-request behavior is not defined.

**Recommended pull-request policy:** analyze a pull-request run against its target branch baseline, but do not publish its results into the shared baseline.

### Delivery safety

- Use `seal_id + event_id + learning_policy_version` as the idempotency key.
- A repeated delivery returns the earlier result.
- Retry temporary failures with a limit and backoff.
- Quarantine invalid schemas and redaction failures.
- Use isolated work state per `seal_id + run_id + processing_id`.
- Publish the baseline only after every required file is complete.

These event-delivery mechanics are a recommended design because the repository does not define the transport.

> **Image-generation prompt — Event trigger and baseline decision**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 decision flow on a clean warm off-white notebook page with a faint square grid and hand-drawn technical styling. Use teal for successful learning, orange for failure analysis or rejected learning, purple only in the legend, dark navy headings, and two yellow sticky notes. Start with “Terminal pipeline event.” Show checks in this order: “Required IDs present?” → “Log complete?” → “Detect source” → “Outcome?” → “Trusted branch?” For a trusted success, route to “Idempotent learning event” and then “Isolated processing state.” For failure, route to “Failure analysis only.” For cancelled, skipped, unstable, incomplete, or UNKNOWN, route to “Do not update baseline.” Show the four-part key “seal_id + project_id + repo_id + source_type.” Add sticky notes “A success is necessary but not enough” and “Repeated delivery must not create two baselines.” Use simple arrows, document icons, filters, a storage cylinder, and a magnifying glass. Keep a clear left-to-right flow and readable labels. Avoid tiny paragraphs, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 3. Use the four-part baseline key

The baseline key is exactly:

```text
seal_id + project_id + repo_id + source_type
```

Example:

```text
seal101/payments/payment-api/JULES
```

Another source type has a different baseline:

```text
seal101/payments/payment-api/LATTICE
```

Do not mix these baselines. Jules is sequential and Lattice is DAG-based.

The following values are stored inside the baseline, not added to the key:

- stage or DAG-node name;
- attempt number;
- branch and commit lineage;
- rule and parser versions;
- baseline version;
- template counts and sequence information.

The latest compatible version is resolved below the four-part key. For example:

```text
seal101/payments/payment-api/JULES/v17
```

Here, `v17` is a version, not a fifth key field.

## 4. Convert source data into canonical events

The source adapters produce one common event shape. Common shape does not mean that Jules and Lattice become identical.

```json
{
  "seal_id": "seal101",
  "project_id": "payments",
  "repo_id": "payment-api",
  "run_id": "run-7312",
  "source_type": "JULES",
  "event_id": "event-1842",
  "scope": {
    "kind": "stage",
    "name": "test",
    "attempt": 1
  },
  "physical_line": 1842,
  "byte_start": 93481,
  "byte_end": 93586,
  "logical_sequence": 417,
  "observed_at": "2026-08-23T09:31:04.812Z",
  "stream": "stderr",
  "log_ref": "restricted-log-reference",
  "message": "FAIL payment test request=req-73c2 duration=812ms"
}
```

For Jules, `scope.kind` is `stage`. For Lattice, it is `dag_node`, and the event also keeps parent nodes and node-local sequence when available.

Physical line numbers are one-based. They are captured before text cleanup changes the line. This allows failure analysis to return to the exact source area later.

The repository does not define the source wire formats, so the source names below describe adapter inputs rather than fixed JSON field names.

| Source information | Canonical field | Required? |
|---|---|---:|
| Jules run identifier | `run_id` | Yes |
| Jules stage name and order | `scope.name` and `logical_sequence` | Yes when supplied |
| Lattice execution identifier | `run_id` | Yes |
| Lattice build type, stage, and attempt | `scope.name` and `scope.attempt` | Yes when supplied |
| Lattice parent nodes | `scope.parents` | Optional |
| Original line and byte position | `physical_line`, `byte_start`, `byte_end` | Yes |
| Timestamp and stream | `observed_at`, `stream` | Optional |
| Original message | `message` | Yes |

Illustrative Jules line:

```text
[test] worker 10.4.8.2 completed build 7312 in 12.8s
```

Illustrative Lattice line:

```text
[service-test:integration attempt=2] worker exited code=137
```

The Lattice adapter keeps `service-test:integration` and attempt `2`. It does not flatten this line into one global stream.

## 5. Preprocess every line in one fixed order

The order is:

1. Capture raw log reference, line number, and byte range.
2. Parse the Jules or Lattice envelope and scope.
3. Normalize display differences.
4. Redact secrets.
5. Mask safe dynamic values.
6. Build the canonical event.
7. Send canonical text to Drain.

Older repository summaries show these operations in different orders. The detailed implementation notes require provenance first, followed by presentation cleanup, redaction, and masking. This document uses that order.

### What the operations mean

| Operation | Example |
|---|---|
| Normalize | Remove ANSI color codes and extract a timestamp from the message. |
| Redact | Replace a password or token with `<REDACTED_SECRET>`. |
| Mask | Replace `run-7312` with `<BUILD_ID>` or `812ms` with `<DURATION>`. |
| Preserve | Keep `exit code=137`, `failed=37`, an exception type, or a source file and line. |

### Common value rules

| Value | Handling |
|---|---|
| Timestamp | Move to metadata; use `<TIMESTAMP>` in template text if it remains. |
| Request or correlation ID | Use `<REQUEST_ID>` and keep a protected digest for joining related lines. |
| UUID, build ID, commit text, temporary path | Replace with a typed placeholder. Keep commit SHA in protected run metadata. |
| Duration and memory size | Mask in template text and keep a numeric feature for anomaly checks. |
| URL | Remove credentials and sensitive query values; preserve safe host and path information. |
| IP address and ephemeral port | Mask unless an allow-list says the value itself is meaningful. |
| Username | Redact or pseudonymize unless it is an approved service identity. |
| Token, password, private key | Remove permanently from every derived artifact. |
| Exit code, error class, failed test, exception, source file | Preserve because they change diagnostic meaning. |

Rules run by phase, then numeric priority, then stable rule ID. Every artifact stores the rule version. A rule update creates a new compatibility version. Broad rules need tests and a maximum match-rate guard so they cannot erase most of a log.

See [normalization-rules.yaml](examples/normalization-rules.yaml) for safe examples.

## 6. How Drain creates templates

Drain groups lines that have the same stable message shape.

Suppose preprocessing produces:

```text
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>
```

Drain creates one template instead of three separate messages.

### Drain in four steps

1. Group lines by token count.
2. Use leading tokens to route the line through a fixed-depth tree.
3. Compare the line only with a small set of templates at the reached leaf.
4. Update the best matching template or create a new template.

The similarity threshold controls matching. If it is too strict, one message family becomes many templates. If it is too loose, unrelated messages are merged.

Jules lines are parsed within their stage. Lattice lines are first separated into DAG-node and attempt streams, then parsed inside those scopes. Drain itself does not understand Jules or Lattice; the Logsift adapter supplies the scope.

Parser state belongs below the four-part baseline key. Stage and DAG-node clusters remain separate inside that state. Do not share one mutable parser model across different seals, projects, repositories, or source types.

The failed-run flow uses a frozen compatible parser configuration. A failed run never changes successful parser state.

### Never compare local template IDs

Two parser instances may both create template ID `42` for different text. Logsift compares:

```text
scope + canonical template text + stable fingerprint
```

The fingerprint algorithm and parser configuration are versioned.

## 7. Drain or Spell?

Both parsers can learn templates from a stream. They find similarity differently.

| Question | Drain | Spell |
|---|---|---|
| Main idea | Route by token count and prefixes in a fixed-depth tree. | Compare token sequences using longest common subsequence. |
| Search work | Usually compares with a small leaf candidate set. | May need more sequence-matching work as patterns grow. |
| Strong case | Large logs with fairly stable token positions and prefixes. | Logs where constant tokens remain in order but variable tokens are inserted or removed. |
| Main tuning risk | Tree depth and similarity threshold can split or merge too much. | LCS threshold can match too broadly or create too many pattern objects. |
| Output identity | Local template IDs are not portable. | Local pattern IDs are also not portable. |

**Logsift decision:** keep Drain as the main parser because the repository already defines its artifacts and comparison flow, and its fixed-depth routing is a good fit for large CI/CD streams. Spell may be useful in an evaluation for sources with unstable token positions. It should not be mixed into the same baseline without a new parser version and new fingerprints.

Drain is not always “more accurate,” and Spell is not always “more flexible.” The correct choice depends on real Jules and Lattice samples. Keep a labelled test set and compare template quality, processing time, and memory before changing parsers.

> **Image-generation prompt — Drain and Spell in simple terms**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 comparison diagram on a clean warm off-white notebook page with a faint square grid and hand-drawn technical styling. Use dark navy headings, teal for the chosen Logsift flow, orange for cautions, purple only in the legend, and two yellow sticky notes. At left, show one normalized log line. Split it into two lanes. In the Drain lane, show “Token count → Prefix tree → Small leaf candidates → Similarity match → Template.” In the Spell lane, show “Token sequence → Longest common subsequence → Pattern match → Template.” Add a small comparison table with “predictable routing,” “variable token positions,” “threshold tuning,” and “streaming.” Highlight Drain as “Current Logsift design” and Spell as “Evaluate only with a new parser version.” Add notes “Never compare local IDs” and “Measure on real source logs.” Use simple arrows, document icons, one storage cylinder, filters, and magnifying glasses. Keep generous spacing, short labels, and a left-to-right flow. Avoid external logos, tiny text, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 8. Files created by offline learning

The baseline is stored below the four-part key.

```text
baselines/
└── seal101/
    └── payments/
        └── payment-api/
            └── JULES/
                ├── current.json
                └── v17/
                    ├── baseline.json
                    ├── templates.json
                    ├── drain3_state.json
                    ├── template_stats.json
                    ├── versions.json
                    ├── templates.md
                    └── normalize_sample.txt
```

`current.json`, `template_stats.json`, and `versions.json` are recommended explicit files. The other baseline artifacts are already described in the repository.

| File | Purpose | Used by |
|---|---|---|
| `current.json` | Points to the latest complete compatible version. | Baseline resolver |
| `baseline.json` | Stores the four-part key, version, input success runs, scopes, and template references. | Failure analysis and audit |
| `templates.json` | Stores canonical text, stable fingerprint, stage or node, counts, and support. This is the main LogDiff input. | LogDiff |
| `drain3_state.json` | Stores Drain's parser memory. It helps parse compatible future logs but is not the comparison database. | Drain only |
| `template_stats.json` | Stores count ranges, support, stage or node occurrence, and simple sequence data. | LogDiff |
| `versions.json` | Stores source schema, detection, normalization, redaction, masking, parser, and fingerprint versions. | Compatibility check |
| `templates.md` | Human-readable template review. | Engineers, not runtime comparison |
| `normalize_sample.txt` | Small redacted sample for debugging preprocessing rules. | Engineers and tests |

Complete successful logs are not copied into the baseline. If the source system retains them, they stay in its restricted log storage under its own retention policy.

The processing run also produces short-lived records before publication:

| Temporary record | Purpose | Retention |
|---|---|---|
| Normalized event stream | Replayable input to Drain after protection rules | Keep through the audit or replay window |
| Redaction audit | Rule IDs, categories, positions, and counts; never secret values | Keep according to audit policy |
| Parsed occurrences | Connects each original line to scope, template, fingerprint, and numeric features | Keep long enough for baseline validation and replay |

### Example `baseline.json`

```json
{
  "seal_id": "seal101",
  "project_id": "payments",
  "repo_id": "payment-api",
  "source_type": "JULES",
  "baseline_version": "v17",
  "status": "complete",
  "template_file": "templates.json",
  "stats_file": "template_stats.json",
  "versions_file": "versions.json"
}
```

### Example template record

```json
{
  "fingerprint": "fp-v1:28be...",
  "canonical_template": "Compiling <COUNT> files",
  "scope": {"kind": "stage", "name": "build"},
  "success_support": 1.0,
  "typical_count": {"minimum": 1, "maximum": 1}
}
```

The actual failure comparison uses the fingerprint and canonical text, then checks count, support, scope, and sequence statistics. It does not compare only the local template ID.

## 9. Publish a baseline safely

Write all version files first. Validate their checksums and redaction status. Write `baseline.json` only when the version is complete. Finally, update `current.json` with compare-and-set so two concurrent successful runs cannot publish over each other.

Keep old versions for rollback and audit. A failed run selects the latest compatible complete version; it never reads a partially written version.

## Next step

[03 — Failure-analysis flow](03-failure-analysis-flow.md) starts at LogDiff and shows how a failed line becomes a candidate, an expanded log block, and finally a token-bounded evidence pack.
