Yes—the offline learning flow should run only for trusted successful branches. Failure analysis can still run for feature, pull-request, and temporary branches, but those runs must never update the shared baseline.

## 1. Trusted branches

A run should update the learning baseline only when all these checks pass:

- The branch is trusted, such as `main`, `master`, or an approved `release/*` branch.
- The pipeline finished successfully.
- The log is complete.
- Jules or Lattice was identified confidently.
- Required IDs are present.
- The preprocessing and parser versions are known.

Feature, pull-request, and temporary branches may still use Logsift for failure analysis. They simply cannot teach the authoritative baseline.

One important detail: because branch is not in your four-part baseline key, main and release statistics should not be blindly mixed. My recommendation is:

- Keep one repo-level template catalog.
- Record `branch_class` in the baseline manifest.
- Keep frequency, sequence, and scope statistics separated by branch class.
- Select the compatible branch-class statistics during LogDiff.

The exact trusted-branch list was not originally defined by the repository, so this should be configurable.

## 2. Where segmentation happens

Conceptually, the order should be:

1. Detect Jules or Lattice.
2. Parse the source envelope.
3. Capture stage/node identity and original line provenance.
4. Normalize.
5. Redact secrets.
6. Apply typed masking.
7. Build source-aware logical segments.
8. Run Drain on those segments.

Some stage or node information must be captured before normalization because it may come from the source envelope. However, the normalized and masked text is grouped into logical segments immediately before Drain.

For Jules:

```text
Build segment
Test segment
Package segment
```

For Lattice:

```text
Node A, attempt 1
Node B, attempt 1
Node B, attempt 2
```

Node identity should preferably use a stable node ID. If only the node name exists, use the node name together with the attempt.

## 3. Is segmentation preserved?

Yes. Segmentation must remain available throughout LogDiff and content expansion.

It should not be implemented by copying the log into several new files. Each parsed occurrence should retain metadata similar to:

```text
source_type
stage_id or node_id
attempt
physical_line
byte_start
byte_end
logical_sequence
template_fingerprint
raw_log_reference
```

LogDiff uses that information to answer questions such as:

- Is this template new in the Test stage?
- Is it normal globally but unusual in this Lattice node?
- Did its frequency change only in one stage?
- Did its order change within the stage?
- Did it appear in a different scope than usual?

Content expansion uses the same metadata to find surrounding evidence:

- Jules: expand within the same contiguous stage.
- Lattice: collect the same node and attempt, even when its physical lines are interleaved with other nodes.
- Both: preserve the original physical lines and byte ranges.

So segmentation is not temporary preprocessing. It is persistent scope and provenance.

## 4. What is a template fingerprint?

A fingerprint is a stable hash of the canonical template text.

For example:

```text
Canonical template:
Connection to <HOST> timed out after <DURATION>

Fingerprint:
sha256(canonical template + fingerprint version)
```

The actual stored fingerprint may be shortened for display, such as:

```text
fp-a91c72
```

It replaces Drain’s local numeric cluster ID for cross-run comparison. Numeric Drain IDs can change when a parser is rebuilt or when another parser instance processes the same logs. A stable fingerprint remains comparable as long as the canonical template and fingerprint rules are compatible.

## 5. Should stage be part of the template key?

No. If Logsift uses a repo-level template catalog, stage or node should not be part of the template identity.

The clean separation is:

```text
Baseline family key
= seal_id + project_id + repo_id + source_type
```

```text
Template identity
= baseline family key + template_fingerprint
```

```text
Occurrence identity
= template_fingerprint + branch_class + stage_or_node + attempt + location
```

The stage or node belongs to the occurrence record and statistics—not the fingerprint.

## 6. “Should one template contain every stage?”

The repo-level baseline should cover every trusted stage or node, but an individual template represents one message pattern—not the whole pipeline.

For example, one template can appear in multiple stages:

```text
Template fingerprint: fp-a91c72
Template: Downloading package <PACKAGE>

Build stage:   12 occurrences
Test stage:     2 occurrences
Package stage:  7 occurrences
```

This requires:

- One catalog entry for `fp-a91c72`.
- Three scoped occurrence records or counters.
- No duplicate template definition for each stage.

The complete baseline therefore contains:

```text
Repo-level template catalog
├── Template A
├── Template B
└── Template C

Scoped occurrence data
├── Build
├── Test
├── Package
└── Lattice nodes and attempts
```

That gives you both benefits:

- Templates are learned once at repository/source level.
- LogDiff still understands where each template normally appears.

So your intended model is sound: one repo-level Drain model and template catalog for each four-part key, with stage/node information preserved separately for comparison and expansion.