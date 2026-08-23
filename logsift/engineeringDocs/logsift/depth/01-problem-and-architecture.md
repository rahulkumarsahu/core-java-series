# Logsift: problem and architecture

Logsift helps engineers answer a practical question after a CI/CD run fails: which small part of a very large log best explains the failure, and what system context makes that evidence actionable? The intended reader and user is an engineer responding to a failed build, test, deployment, or infrastructure step. The expected result is not a generic log summary. It is a compact, traceable evidence pack and, when the necessary knowledge is available, a grounded explanation that points to relevant code, configuration, ownership, runbooks, or earlier confirmed fixes.

This document separates two kinds of statements. **Current Logsift behavior** means behavior explicitly described by the repository. **Recommended design** means a contract proposed where the repository does not yet define an implementation detail. The distinction is important because the repository is strongest on the learning and failure-reduction concepts, while several storage, concurrency, and retrieval interfaces remain open.

## The problem Logsift is solving

CI/CD logs are optimized for execution and debugging at the source, not for comparison across runs. A single run may contain timestamps, progress redraws, tool output, test results, compiler messages, subprocess logs, and several layers of infrastructure metadata. Much of this output repeats normal behavior. The few lines that distinguish a failed run can be separated by thousands or millions of routine lines.

Several properties make raw logs difficult to analyze directly:

- **Volume:** complete logs may be too large to read, transfer, or fit into a model context window.
- **Repetition:** retries, polling loops, dependency output, and successful setup steps can dominate the text without explaining the failure.
- **Inconsistent structure:** Jules exposes sequential stage-oriented execution, while Lattice can expose a dependency graph whose nodes run in parallel and whose physical output is interleaved.
- **Dynamic values:** timestamps, request identifiers, temporary paths, ports, durations, and build identifiers make equivalent messages look different.
- **Secret exposure:** access tokens, passwords, private keys, credentials embedded in URLs, and other sensitive values can appear in raw output.
- **Weak locality:** the line that reports termination is often not the line that caused it. The useful evidence may be a nearby stack trace, an earlier state transition, or a correlated request in another logical task.

Sending a complete log to a large language model is therefore a poor default. It increases transfer and inference cost, consumes the context window with repetitive material, raises the chance of secret disclosure, and makes important evidence compete with noise. A model may summarize the most common messages rather than identify the unusual event that changed the outcome. Logsift reduces the log first, preserves exact provenance for the retained evidence, and asks a model to reason only after that reduction is complete.

## Why successful runs matter

A selected successful run is evidence of normal behavior for a particular execution scope. Repeated successful runs reveal stable message templates, expected frequency ranges, normal stage placement, and common ordering relationships. A failed run can then be evaluated against a compatible success baseline rather than against generic ideas of what a build log should contain.

Compatibility is essential. A successful run from another repository, pipeline, logical stage, source type, or incompatible preprocessing version can create a misleading comparison. Logsift therefore treats a baseline as versioned, scoped data. It does not treat every success as trustworthy training input, and failed or unstable runs must never update the success model.

The repository currently describes learning from selected successful runs on trusted main or release branches and excluding feature or temporary branches. It does not define a complete policy for pull-request branches or every event-delivery detail. [The offline learning flow](02-offline-learning-flow.md) records the current rule and gives a configurable recommended policy for the missing cases.

## Goals

- Learn a versioned representation of healthy behavior from selected successful runs.
- Preserve the source-specific semantics of Jules and Lattice while exposing one canonical event contract.
- Normalize dynamic presentation, remove secrets, and extract stable log templates deterministically.
- Compare a failed run only with a compatible success baseline.
- Reduce a failure to diverse, high-value evidence without losing line, byte, stage, task, or source provenance.
- Read very large logs incrementally rather than loading the full object into memory.
- Make every comparison, score, omission, and truncation explainable.
- Retrieve permission-compatible operational and commit-matched code context when Layer 3 is enabled.

## Non-goals

- Replacing the CI/CD systems that execute pipelines.
- Treating a language model as the parser, secret scanner, baseline store, or comparison engine.
- Learning from failed, cancelled, skipped, or otherwise untrusted runs.
- Assuming that numeric template identifiers from separate parser instances have shared meaning.
- Producing an answer without links back to the evidence that supports it.
- Guaranteeing an automatic fix. Logsift may recommend a path, but an engineer remains responsible for validating and applying changes.
- Storing every raw log line in a vector index.

## Assumptions

- A run has a stable tenant, repository, logical pipeline, source, run identifier, outcome, and creation time.
- Source adapters can recover a logical stage or DAG-node identity with an explicit confidence value. If they cannot, Logsift records that limitation instead of inventing structure.
- Raw logs are retained in an access-controlled location long enough to expand selected evidence.
- A failed run can be processed with the same compatible source schema, normalization rules, redaction rules, masking rules, and parser configuration used by its baseline.
- Repository, branch, and commit metadata are available before commit-aware code retrieval is attempted.
- All retrieved material remains subject to tenant and source permissions.

## Important terminology

| Term | Meaning in this documentation |
|---|---|
| **Source envelope** | The source-specific event and metadata surrounding log content before Logsift interprets it. |
| **Canonical event** | A source-neutral Logsift record that retains source-specific identity and provenance. |
| **Normalization** | Deterministic cleanup of representation, such as line endings, progress redraws, and timestamp extraction. |
| **Redaction** | Permanent removal or irreversible replacement of secrets. |
| **Masking** | Replacement of non-secret dynamic values with typed placeholders while retaining useful value classes. |
| **Template** | A stable token pattern produced after preprocessing, with variable positions represented by wildcards. |
| **Template fingerprint** | A stable digest of canonical template text plus its comparison scope and compatibility contract. |
| **Success baseline** | A versioned set of trusted successful-run artifacts used for later comparisons. |
| **LogDiff** | The deterministic comparison between a failed run and a compatible success baseline. |
| **Candidate** | An immutable reference to a suspicious occurrence or region before content expansion. |
| **Evidence block** | A bounded, ordered, provenance-preserving group of expanded log fragments. |
| **Evidence pack** | The failure summary, template differences, ranked blocks, statistics, provenance, and omission notices passed to later reasoning. |
| **RAG** | Retrieval-augmented generation: retrieving relevant knowledge and code context before asking a model to explain or recommend. |

## Three layers

1. **Offline learning** accepts selected successful runs, converts Jules and Lattice events into a canonical contract, normalizes and protects the content, extracts templates, and publishes a versioned success baseline. This is the canonical preprocessing description in [02 — Offline learning flow](02-offline-learning-flow.md).
2. **Failure analysis and evidence reduction** applies the same frozen preprocessing contract to a failed run, performs LogDiff, expands suspicious occurrences from indexed log storage, builds and deduplicates evidence blocks, ranks them, and fits a diverse selection into a token budget. See [03 — Failure-analysis flow](03-failure-analysis-flow.md).
3. **RAG and code-context retrieval** turns the evidence pack into lexical, semantic, and structural queries, retrieves permission-compatible knowledge and commit-matched code, and assembles grounded context for explanation and remediation. The repository does not define this layer's implementation yet; [04 — Layer 3](04-layer-3-rag-and-code-context.md) presents it as a recommended design.

## Architecture

> **Image-generation prompt — End-to-end Logsift architecture**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 architecture diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical-diagram styling. Use dark navy handwritten headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. At far left, draw a grouped “Log sources” area with two distinct boxes: “Jules — sequential stages” and “Lattice — parallel DAG nodes”; do not merge them. From both boxes, draw arrows into a teal “Layer 1 — Offline learning” group containing, in order, “Selected successful run,” “Source adapter,” “Normalize,” “Redact,” “Typed mask,” “Drain templates,” and a storage cylinder labelled “Versioned success baseline.” Add small document icons for canonical events and a shield icon at redaction. Below it, draw an orange “Layer 2 — Failure analysis” group beginning with “Failed run,” passing through “Same frozen preprocessing,” “LogDiff,” “Scoped candidate pool,” “Indexed content expansion,” “Evidence blocks,” “Deduplicate + score,” “Token-budget selection,” and a document icon labelled “Evidence pack.” Connect the success-baseline cylinder down to LogDiff with an arrow labelled “compatible versions only.” Connect candidate expansion to a separate storage cylinder labelled “Restricted raw logs + sidecar index,” using a magnifying-glass icon and an arrow labelled “range read.” At right, draw a purple “Layer 3 — Retrieval + remediation” group containing “Build retrieval query,” three parallel small boxes labelled “Lexical index,” “Semantic index,” and “Code + dependency graph,” then “Merge + rerank,” “Commit-aware context,” and “Grounded RCA + remediation.” Feed the orange Evidence pack into the purple query box. Add a feedback arrow from “Confirmed RCA + fix” to a small purple document store labelled “Validated knowledge,” never directly to the success baseline. Add three yellow sticky notes: “Failures never train the baseline,” “Keep exact provenance,” and “Repository + commit must match.” Include a compact legend mapping teal to offline learning, orange to failure analysis, purple to retrieval/remediation, dashed outlines to recommended contracts, and solid outlines to repository-defined concepts. Use simple arrows, document icons, storage cylinders, filters, shields, and magnifying glasses. Use short, legible labels and no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify every spelling and verify that every arrow points in the intended processing direction.

## Document map

- [02 — Offline learning flow](02-offline-learning-flow.md) is the canonical account of ingestion, branch policy, preprocessing, Drain extraction, and baseline artifacts.
- [03 — Failure-analysis flow](03-failure-analysis-flow.md) starts at LogDiff and follows evidence through indexed expansion, block construction, ranking, and token selection.
- [04 — Layer 3: RAG and code context](04-layer-3-rag-and-code-context.md) explains the recommended knowledge and commit-aware code retrieval layer.
- The companion examples are [normalization rules](examples/normalization-rules.yaml), [failure-analysis rules](examples/failure-analysis-rules.yaml), and [retrieval policy](examples/retrieval-policy.yaml).
