# Logsift: problem and architecture

Logsift helps an engineer understand why a CI/CD run failed without reading the whole log.

A large log may contain thousands of normal lines and only a few useful failure lines. It may also contain timestamps, build IDs, temporary paths, repeated retries, and secrets. These values make similar messages look different and make direct comparison difficult.

Sending the full log to a language model is not a good default. It costs more, can expose secrets, and fills the model context with repeated text. The important error can easily get lost.

Logsift solves this in three layers:

1. Learn normal log patterns from selected successful runs.
2. Compare a failed run with the correct success baseline and keep only useful evidence.
3. Retrieve matching runbooks, incidents, configuration, and code before generating an explanation.

## Current behavior and recommended design

The repository defines the main ideas: Jules and Lattice are different sources, successful runs create baselines, Drain creates templates, and failed runs are compared with those templates.

Some implementation details are not defined yet. These include the exact source signatures, event transport, concurrent candidate store, large-log index format, and Layer 3 storage. When this document set fills one of those gaps, it says **Recommended design**.

## The core idea

A successful run teaches Logsift what “normal” looks like.

For example, these lines have different values but the same meaning:

```text
Compiling 452 files
Compiling 510 files
Compiling 498 files
```

After preprocessing and parsing, they become one template:

```text
Compiling <COUNT> files
```

If a failed run contains a new template such as this, it is suspicious:

```text
Database connection refused
```

Logsift does not immediately call it the root cause. It finds the original line, expands nearby context, combines related lines into a log block, removes duplicates, scores the block, and keeps it only if it adds useful evidence.

## The two log sources

**Jules** is sequential. Stages normally run in order, such as build, test, and package. Stage order is useful during comparison and context expansion.

**Lattice** is a dependency graph. Multiple nodes may run at the same time, so physical log lines can be interleaved. Logsift must keep the DAG node identity and node-local order. A nearby physical line may belong to another node.

Logsift must not decide the source type just because a log looks sequential or interleaved. It checks configured source signatures in a small top section of the log. [The offline learning flow](02-offline-learning-flow.md#1-detect-jules-or-lattice) explains this rule.

## The baseline key

Every baseline is owned by exactly four values:

```text
seal_id + project_id + repo_id + source_type
```

`source_type` is either `JULES` or `LATTICE`.

Example:

```text
seal101/payments/payment-api/JULES
```

Stage and DAG-node information is stored inside the baseline. It is not part of the baseline key. A baseline version is also stored below this key, but it is not part of the ownership key.

## What each layer produces

| Layer | Input | Output | Used by |
|---|---|---|---|
| Offline learning | Selected successful run | Versioned success baseline | Failure analysis |
| Failure analysis | Failed run and compatible baseline | Small evidence pack | Root-cause reasoning and Layer 3 |
| RAG and code context | Evidence pack and indexed knowledge | Relevant knowledge and commit-matched code | Grounded explanation and remediation |

## Goals

- Compare failed logs with the correct successful behavior.
- Keep Jules and Lattice logic separate.
- Remove secrets before derived log data is stored or sent to a model.
- Keep original line and byte locations for every selected item.
- Process large logs in chunks instead of loading the full log into memory.
- Explain why every evidence block was selected.
- Retrieve only knowledge and code the caller is allowed to see.

## Non-goals

- Replacing the CI/CD system.
- Learning from failed, cancelled, skipped, or unstable runs.
- Treating a parser-local template number as a stable cross-run identity.
- Sending raw unrestricted logs to a language model or vector database.
- Applying a code change automatically.

## Important terms

| Term | Simple meaning |
|---|---|
| Canonical event | One common event shape used after reading a Jules or Lattice event. |
| Normalization | Cleaning presentation differences such as timestamps and display control characters. |
| Redaction | Removing secrets permanently from derived data. |
| Masking | Replacing changing values with typed placeholders such as `<BUILD_ID>`. |
| Template | A stable message pattern created by Drain. |
| Template fingerprint | A stable hash of canonical template text and its scope. |
| Success baseline | Versioned templates and statistics learned from trusted successful runs. |
| LogDiff | The comparison between failed templates and a compatible success baseline. |
| Candidate | A suspicious log occurrence with a pointer back to the source log. |
| Log block | Expanded, related lines that tell one small failure story. |
| Evidence pack | The final small set of blocks and statistics used for explanation. |
| RAG | Searching trusted knowledge before asking a model to explain the failure. |

## Architecture

> **Image-generation prompt — Simple end-to-end Logsift architecture**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 technical diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn styling. Use dark navy handwritten headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for three key insights. Keep generous spacing and a simple left-to-right flow. At left, show two separate source boxes: “Jules — sequential stages” and “Lattice — parallel DAG nodes.” In a teal group, show “Successful run → Detect source → Normalize → Redact → Mask → Drain → Versioned baseline.” Put the key “seal_id + project_id + repo_id + source_type” below the baseline cylinder. In an orange group, show “Failed run → Same preprocessing → LogDiff → Candidate pool → Content expansion → Log blocks → Deduplicate → Score + rank → Token selection → Evidence pack.” Connect the baseline to LogDiff with “compatible version only.” Add a raw-log cylinder connected to content expansion by “indexed range read.” In a purple group, show “Evidence pack → Exact search + Vector search + Code graph → Rerank → Commit-matched context → Grounded explanation.” Add yellow notes: “Failures never update the baseline,” “Keep exact line provenance,” and “Code must match the commit.” Include a compact legend for all colors, solid event flow, and dotted reference links. Use simple arrows, document icons, storage cylinders, filters, shields, and magnifying glasses. Use short readable labels, no tiny paragraphs, no external logos, and Logsift as the only product name. Avoid photorealism, 3D, gradients, dark backgrounds, and decorative clutter. Verify spelling and arrow direction.

## Read next

- [02 — Offline learning flow](02-offline-learning-flow.md) explains source detection, events, preprocessing, Drain, and stored files.
- [03 — Failure-analysis flow](03-failure-analysis-flow.md) explains LogDiff, candidate discovery, expansion, blocks, scoring, and token selection.
- [04 — RAG and code context](04-layer-3-rag-and-code-context.md) explains retrieval, embeddings, vector storage, and commit-aware code search.
- [Normalization rules](examples/normalization-rules.yaml) contains safe source, redaction, masking, priority, and test examples.
- [Failure-analysis rules](examples/failure-analysis-rules.yaml) contains comparison, expansion, block, scoring, deduplication, and token limits.
- [Retrieval policy](examples/retrieval-policy.yaml) contains source, permission, freshness, commit, ranking, and retrieval-budget rules.
