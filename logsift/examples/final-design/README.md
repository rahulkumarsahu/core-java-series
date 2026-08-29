# Logsift final-design examples

This folder is the example set for the design described in `LogSift.md`. It uses the normal frozen-replay strategy. Direct keyword and terminal candidates expand during Pass 1; LogDiff-only candidates are found by read-only replay. It does not require a permanent line-by-line index.

All names, credentials, identifiers, logs, measurements, and hashes are synthetic test data.

## Jules example

The example starts with [a trusted successful log](jules/success.log). Offline learning reads it once and creates [the success baseline](jules/success-baseline.json).

The failed run then uses these files in order:

| File | Purpose |
|---|---|
| [failed.log](jules/failed.log) | Immutable source log for the failed run |
| [analysis-manifest.json](jules/analysis-manifest.json) | Pinned raw-log version, processing versions, baseline, limits, and occurrence strategy |
| [failed-template-summary.json](jules/failed-template-summary.json) | Pass 1 final cluster-to-fingerprint state, counts, safe parameters, segment-local order, multiline relationships, and terminal state |
| [failed-parser-state.json](jules/failed-parser-state.json) | Final read-only run-local cluster, canonical-template, and fingerprint catalog used by replay |
| [logdiff-result.json](jules/logdiff-result.json) | Compatible baseline comparison and the selector set for Pass 2 |
| [candidate-occurrences.jsonl](jules/candidate-occurrences.jsonl) | Exact pointers for selected failed-log occurrences only |
| [expanded-fragments.jsonl](jules/expanded-fragments.jsonl) | Before-and-after context collected by the Test-stage ring buffer |
| [log-blocks.jsonl](jules/log-blocks.jsonl) | Readable evidence blocks with error category, confidence score, priority, evidence score, and provenance |
| [evidence-pack.json](jules/evidence-pack.json) | Final structured evidence selection, classifications, priorities, scores, and provenance |
| [llm-input.md](jules/llm-input.md) | Human-readable bounded model input including each block's classification, priority, score, reasons, and source pointers |

One protected line changes as follows:

```text
Raw
INFO Authorization: Bearer another-sample-token

Normalized
INFO Authorization: Bearer another-sample-token

Redacted
INFO Authorization: <REDACTED_TOKEN>

Masked
INFO Authorization: <REDACTED_TOKEN>

Drain template
INFO Authorization: <REDACTED_TOKEN>
```

The token never enters the baseline, failed summary, candidate pool, fragment, evidence block, or model input.

A diagnostic line follows a different path:

```text
Raw protected message
INFO payment-api returned status=503 duration=3000ms

Drain template
INFO payment-api returned status=<STATUS_CODE> duration=<DURATION>

Stable fingerprint
sha256:v1:75726801022a99d10773558483ecb28e9b50c555e855c04eb154d74105469d0c

Safe parameter record
status_code=503, duration_ms=3000
```

The template fingerprint matches the success baseline, but the safe values do not. LogDiff therefore creates a `parameter_shift` selector. Pass 2 finds the exact failed occurrence at physical line 6 and bytes 348 to 430.

The retry, assertion, failed-test summary, and nonzero exit are direct candidates expanded during Pass 1. The status parameter shift becomes a selector only after LogDiff and is found by frozen read-only replay. Their windows overlap inside the same Test segment, so expansion produces one fragment rather than five copied regions. Block construction then separates the likely cause from the required terminal consequence. The provisional three-factor score gives the first block `94` and the terminal block `77`.

## Lattice example

[The Lattice failed log](lattice/failed.log) interleaves `test:integration` with `compile`, `security-scan`, and `package` nodes. The selected occurrences are in [candidate-occurrences.jsonl](lattice/candidate-occurrences.jsonl).

The `test:integration` ring buffer sees node-local logical positions 1 to 5 at physical lines 2, 4, 6, 8, and 10. [The expanded fragment](lattice/expanded-fragments.jsonl) therefore stores five noncontiguous byte ranges. Physical lines 3, 5, 7, and 9 are excluded because they belong to other nodes.

This is the key reason Logsift keeps one ring buffer per Lattice node attempt. A global physical-line window would mix unrelated parallel work into the evidence.

## What the example proves

- Successful learning stores repository-level templates and scope statistics, not one record per successful log line.
- One manifest pins the exact processing contract before Pass 1.
- Pass 1 uses run-local cluster IDs and fingerprints only the final frozen templates.
- Pass 1 can identify and expand direct candidates without keeping the failed log in memory.
- LogDiff uses stable fingerprints, scope, sequence, severity, and safe parameter statistics.
- Frozen read-only replay finds candidates that become known only after LogDiff.
- Per-segment ring buffers provide bounded context for sequential and interleaved sources.
- Expanded content retains exact lines and byte ranges.
- Deduplication and block construction keep provenance.
- Every block carries error classification, confidence, priority, and separate evidence-ranking score.
- Scoring and token selection produce a small model input containing those fields and their explanations.
- No permanent full line-level sidecar is needed for the default flow; the temporary thin-index strategy is reserved for measured large-log or repeated-analysis cases.
