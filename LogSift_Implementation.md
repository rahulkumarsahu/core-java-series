# Logsift implementation plan

## 1. Purpose

This document turns the design in [LogSift.md](LogSift.md) into a **pre-implementation technical design**. It describes the proposed project structure, code modules, dependency boundaries, algorithms, component inputs and outputs, delivery order, and review gates.

It intentionally contains no production implementation. File names and module boundaries describe what the future code should be responsible for and what outcome it should produce. Engineering should create the code only after this document and its open decisions have been reviewed.

Where the project does not yet define a contract, the document marks it as **Developer clarification required**. Engineering should not silently invent those details during implementation.

> **Proposed language:** The detailed code structure below is Python-first because earlier design discussions referred to Python. This is a proposal, not an approved decision. If Logsift will use another language, keep the same boundaries and algorithms but translate the package and file names after review.

Phase 1 and Phase 2 produce the trusted success baseline and the failed-run evidence pack. Phase 3 adds permission-aware knowledge and commit-matched code retrieval. Phase 3 remains behind an approval gate until its detailed contracts are accepted.

## 2. Decisions already made

The following decisions come from `LogSift.md` and should remain stable unless the architecture is reviewed again:

1. Only complete, trusted, successful runs can update the success baseline.
2. Failed, incomplete, cancelled, skipped, unstable, unknown-source, and untrusted-branch runs never teach the baseline.
3. The baseline family key is:

   ```text
   seal_id + project_id + repo_id + source_type
   ```

4. Branch, pipeline, stage, node, attempt, and environment statistics live inside that baseline family. They are not added to the key.
5. Jules and Lattice use separate source adapters and segmentation rules.
6. Jules context is scoped by stage and attempt. Lattice context is scoped by node and attempt, including interleaved physical output.
7. The processing order is normalize, redact, extract approved safe parameters, mask, segment, and parse with Drain.
8. Derived artifacts must never contain unredacted secrets.
9. Drain-local numeric IDs are not compared between runs. Logsift compares stable fingerprints made from final canonical template text and a fingerprint version.
10. Pass 1 uses a private run-local Drain copy. It does not change the published success baseline.
11. Failed-run fingerprints are finalized only after Pass 1 has stopped updating its run-local parser.
12. Normal Pass 2 replay loads the exact finalized run-local catalog in read-only mode.
13. Obvious keyword, severity, exception, and terminal candidates may be expanded during Pass 1.
14. Candidates known only after LogDiff use frozen replay or an optional temporary thin index.
15. A permanent complete per-line sidecar is not part of the default design.
16. The thin index is compressed, temporary, local to one immutable failed log, and enabled only after a measured break-even decision.
17. Candidate state is isolated by `analysis_id` and contains references instead of complete copied logs.
18. Content expansion uses bounded segment-local context. The complete log is never loaded into application memory.
19. Classification confidence, operational priority, and evidence-ranking score are separate values.
20. The first scoring policy uses novelty, explicit severity, and failure proximity. More factors require evaluation and a new policy version.
21. Every final claim must point to log evidence and, when used, retrieved source IDs.

## 3. Clarification process

Questions are grouped by the point at which they block implementation:

- **Gate A — required before coding the integration:** real event fields, authentication, log access, and Jules/Lattice contracts.
- **Gate B — required before publishing the first baseline:** branch policy, rule approval, Drain settings, storage, retention, and baseline publication rules.
- **Gate C — required before analysing real failures:** LogDiff thresholds, candidate limits, error categories, priorities, token profile, and partial-result behaviour.
- **Gate D — required before production:** service-level targets, concurrency limits, security controls, monitoring, cost limits, and ownership.
- **Gate E — required before Phase 3:** knowledge sources, permissions, repository access, vector and exact-search stores, target model, and confirmation workflow.

Every clarification should be recorded as a versioned decision. The chosen value should then appear in configuration, schema documentation, tests, and the analysis manifest where relevant.

## 4. Target runtime flow

### 4.1 Successful run

```text
Terminal pipeline event
  -> validate event and log completeness
  -> apply trusted-branch policy
  -> identify Jules or Lattice
  -> pin the processing configuration
  -> stream canonical events
  -> normalize, redact, extract safe parameters, and mask
  -> segment by Jules stage or Lattice node attempt
  -> update Drain templates and segment-aware summaries
  -> finalize templates and fingerprints
  -> validate all baseline artifacts
  -> atomically publish a new baseline version
```

### 4.2 Failed run

```text
Terminal failed event
  -> create analysis_id and immutable analysis manifest
  -> choose replay or thin-index occurrence strategy
  -> Pass 1 streams the failed log
  -> expand direct keyword, severity, exception, and terminal candidates
  -> freeze the failed-run Drain catalog and finalize fingerprints
  -> LogDiff compares the failed summary with a compatible baseline
  -> frozen replay or thin-index lookup locates remaining candidates
  -> merge candidate reasons under analysis_id
  -> expand segment-local content
  -> create and deduplicate evidence blocks
  -> classify errors and assign operational priority
  -> score and rank evidence
  -> fit selected evidence into the token budget
  -> produce the evidence pack and bounded model input
```

### 4.3 Solution finding

```text
Evidence pack
  -> build exact, semantic, and code-relationship searches
  -> apply tenant, permission, repository, commit, service, and time filters
  -> search approved knowledge and commit-matched code
  -> merge, rerank, deduplicate, and budget retrieved context
  -> produce a grounded explanation with evidence-to-claim mapping
```

## 5. Proposed component boundaries

The implementation may run these components in one service initially, but their contracts should remain separate. This allows expensive workers, storage adapters, and Phase 3 retrieval to be split later without changing the data model.

| Component | Main input | Main output |
|---|---|---|
| Terminal-event receiver | Authenticated terminal pipeline event | Accepted event or clear rejection |
| Eligibility and branch-policy evaluator | Event, repository policy, completion status | `LEARN`, `ANALYSE_FAILURE`, or `IGNORE` decision |
| Processing-configuration registry | Repository/source identity and requested version | Immutable version bundle |
| Raw-log reader | Immutable log reference and cursor | Bounded chunks with line and byte provenance |
| Source detector | Event source field and bounded log prefix | `JULES`, `LATTICE`, or `UNKNOWN` with confidence and reasons |
| Jules adapter | Jules envelope or event stream | Canonical Logsift events with stage and attempt |
| Lattice adapter | Lattice envelope or event stream | Canonical Logsift events with node, attempt, and logical order |
| Preprocessing pipeline | Canonical event and pinned rules | Protected event, safe parameters, and redaction audit metadata |
| Segmentation engine | Protected canonical event and source lifecycle metadata | Segment assignment and compact segment summary |
| Drain parser and fingerprint finalizer | Masked protected events | Final template catalog, parser state, cluster mapping, and fingerprints |
| Baseline builder and publisher | Eligible successful-run summaries | Immutable baseline version and updated current pointer |
| Failure-analysis orchestrator | Failed event, raw manifest, baseline, policy bundle | Isolated analysis state and final evidence pack |
| Pass 1 summary builder | Failed canonical event stream | Final failed-template summary and direct candidates/fragments |
| Keyword matcher | Redacted message and keyword-policy version | Bounded literal rule hits |
| LogDiff | Compatible success baseline and failed summary | Diff records, selectors, and missing-template notices |
| Frozen replay matcher | Immutable failed log and finalized run-local catalog | Exact remaining candidate occurrences and replay counts |
| Thin-index writer/reader | Pass 1 event metadata or LogDiff selectors | Compressed temporary index or matching occurrence pointers |
| Candidate pool | Candidate references and reasons | Idempotent, analysis-scoped candidate records |
| Content expander | Candidate pointers plus streaming/index context | Bounded protected fragments with exact provenance |
| Block builder and deduplicator | Expanded fragments | Evidence blocks with duplicate history |
| Error classifier and priority policy | Evidence blocks and approved rules | Category, confidence, priority, reasons, and review flag |
| Evidence scorer | Classified blocks and scoring policy | Score, factor values, and explanation |
| Token selector | Ranked blocks and model token profile | Bounded evidence pack and omission notices |
| Model-input assembler | Evidence pack and optional retrieved context | Auditable model request |
| Knowledge and code retrieval | Evidence pack and caller permissions | Cited, permission-safe, commit-compatible context |

## 6. Component implementation details

### 6.1 Terminal-event receiver

**Purpose:** Accept one final notification after a pipeline reaches a terminal state and its log upload is complete.

**Input:** Authenticated pipeline event containing the event identity, run identity, outcome, log reference, source information when available, repository ownership metadata, branch and commit metadata, completion state, and source timestamps.

**Output:**

- accepted event with a deterministic idempotency key;
- rejection with a stable reason code;
- or an existing result when the same event was already processed.

**Implementation work:**

1. Define and validate `pipeline-event/v1`.
2. Authenticate the caller and resolve its `seal_id` permissions.
3. Validate required IDs, terminal outcome, timestamps, and log completeness.
4. Store the event before asynchronous work starts.
5. Use `event_id` as the delivery-idempotency key.
6. Record correlation IDs for tracing, but do not use untrusted values as storage paths.
7. Send invalid or repeatedly failing events to a visible dead-letter workflow.

**Acceptance criteria:** Duplicate delivery produces one logical run action; malformed events never start workers; every rejection has a reason and trace ID.

> **Developer clarification required — Gate A:** Provide the actual Jules and Lattice terminal-event payloads, delivery mechanism, authentication method, retry behaviour, maximum payload size, and guarantee for when the log becomes immutable.

### 6.2 Eligibility and branch-policy evaluator

**Purpose:** Decide whether the event may teach the baseline, should enter failure analysis, or should be ignored.

**Input:** Validated terminal event, trusted-branch configuration, source-detection result, log completion state, and required version availability.

**Output:** Decision record containing `LEARN`, `ANALYSE_FAILURE`, or `IGNORE`, plus reason codes and the resolved `branch_class`.

**Implementation work:**

1. Create a versioned repository policy with exact branches and patterns.
2. Require success, completeness, known source, required IDs, and available processing versions for `LEARN`.
3. Route eligible failed runs from any allowed branch to failure analysis.
4. Prevent unknown or incomplete runs from publishing a baseline.
5. Store the policy version with the event decision.

**Acceptance criteria:** No failed or untrusted run can reach baseline publication; policy replay produces the same decision; every decision is explainable.

> **Developer clarification required — Gate B:** Confirm the trusted branch list, release-branch patterns, branch-class names, whether pull-request failures should be analysed, and whether a repository can disable learning.

### 6.3 Processing-configuration registry

**Purpose:** Return one immutable version bundle so all workers use the same rules and algorithms.

**Input:** `seal_id`, `project_id`, `repo_id`, `source_type`, requested policy version, and analysis or learning purpose.

**Output:** `processing_config_version` resolving all adapter, source-schema, normalization, redaction, masking, safe-parameter, segmentation, Drain, fingerprint, keyword, expansion, block, deduplication, classification, scoring, and token-policy versions.

**Implementation work:**

1. Define the bundle schema and content checksum.
2. Make published versions immutable.
3. Validate all referenced rules before publishing the bundle.
4. Support retrieving old versions for replay and audit.
5. Refuse processing when any pinned dependency is missing.
6. Record who approved each rule version and when.

**Acceptance criteria:** Two workers loading one version receive byte-equivalent configuration; a changed rule requires a new version; deleted or unavailable dependencies cause a clear stop.

> **Developer clarification required — Gate B:** Choose the configuration store, approval process, rollback method, and required retention period for old processing versions.

### 6.4 Immutable raw-log storage and reader

**Purpose:** Stream very large logs with bounded memory while preserving exact source provenance.

**Input:** Authorized `log_ref`, immutable object version, compression metadata, starting cursor, cancellation signal, and maximum chunk size.

**Output:** Ordered chunks containing complete physical lines or logical records, one-based physical line numbers, byte ranges, chunk identity, completion state, and the next cursor.

**Implementation work:**

1. Define `raw-log-manifest/v1`.
2. Validate object identity, version, byte length, checksum, and completion state.
3. Support bounded sequential reads and cancellation.
4. Carry unfinished lines and UTF-8 characters across chunk boundaries.
5. Support independently compressed chunks or a documented seekable format.
6. Distinguish stored-object offsets from uncompressed logical offsets.
7. Enforce raw-log access permissions on every read and range read.
8. Produce the same line and byte provenance during replay.

**Acceptance criteria:** Reading with different chunk sizes produces identical logical events and provenance; the reader never loads the complete log; a changed or truncated object is detected.

> **Developer clarification required — Gate A:** Provide the real log-storage API, supported compression formats, range-read guarantees, maximum log size, checksum availability, retention policy, and whether an upload can change after the terminal event.

### 6.5 Source detection

**Purpose:** Choose the correct adapter without guessing from apparent line order.

**Input:** Optional event `source_type`, source-schema version, and at most the configured log prefix.

**Output:** `JULES`, `LATTICE`, or `UNKNOWN`, with confidence, matched signatures, conflict reasons, prefix bytes read, and detector version.

**Implementation work:**

1. Prefer a trusted source field supplied by the pipeline event.
2. Validate the supplied field against source-schema compatibility.
3. When absent, inspect only the configured prefix limit.
4. Compile source signatures from versioned rules.
5. Return `UNKNOWN` when signatures conflict or confidence is too low.
6. Prevent `UNKNOWN` runs from updating the baseline.

**Acceptance criteria:** Real Jules and Lattice samples are identified correctly; conflicting metadata returns `UNKNOWN`; detection never reads a complete multi-million-line log.

> **Developer clarification required — Gate A:** Provide real positive and negative source signatures, precedence rules when event metadata and headers disagree, and the acceptable `UNKNOWN` rate.

### 6.6 Jules and Lattice adapters

**Purpose:** Convert source-specific records into one canonical event shape while preserving source-specific behaviour.

**Input:** Raw logical record, physical provenance, source metadata, and adapter version.

**Output:** Canonical event containing at least:

- source type and source-schema version;
- run, pipeline, event, and analysis identity when applicable;
- timestamp and severity when available;
- Jules stage or Lattice node;
- attempt number and lifecycle state;
- physical line and byte ranges;
- logical position inside the stage or node attempt;
- raw-log object and chunk reference;
- protected correlation metadata fields;
- message body before preprocessing.

**Implementation work:**

1. Define `canonical-event/v1` and source-specific extension fields.
2. Implement Jules stage lifecycle and attempt tracking.
3. Implement Lattice node lifecycle, dependency identity, attempt tracking, and node-local ordering.
4. Define multiline and stack-trace event ownership.
5. Preserve physical order separately from logical segment order.
6. Emit confidence and reason fields when source metadata is incomplete.

**Acceptance criteria:** Canonicalization preserves all required source information; Jules stages do not mix; interleaved Lattice nodes retain correct node-local order; unsupported records fail visibly.

> **Developer clarification required — Gate A:** Provide the real Jules stage markers, Lattice node identifiers, lifecycle events, retry/attempt semantics, sequence guarantees, multiline rules, and examples of interleaved output. Segmentation implementation is blocked until these are confirmed.

### 6.7 Normalization, redaction, masking, and safe parameters

**Purpose:** Produce stable and safe text for parsing without removing useful diagnostic meaning.

**Input:** Canonical event and pinned rule versions.

**Output:** Protected event containing normalized text, redacted text, masked template text, approved safe parameters, matched rule IDs, and unchanged original provenance pointers.

**Implementation work:**

1. Implement deterministic priority-ordered rule execution.
2. Normalize encoding, terminal control sequences, line endings, approved timestamp formats, severity labels, safe whitespace, and source prefixes.
3. Redact tokens, passwords, credentials, private keys, secret query values, and approved sensitive identifiers before any derived storage.
4. Extract only approved safe parameters after redaction and before masking.
5. Apply typed masks for dynamic values such as build IDs, UUIDs, commit hashes, paths, IP addresses, durations, memory, ports, URLs, and counts.
6. Preserve exception types, failed test names, stage or node identity, exit codes, signal names, source locations, and meaningful zero/nonzero distinctions.
7. Validate rules against positive, negative, overlap, multiline, and performance tests.
8. Stop or quarantine processing when mandatory redaction cannot be guaranteed.

**Acceptance criteria:** Seeded secrets never reach templates or evidence; rule ordering is repeatable; masking improves grouping without merging different meanings; provenance does not change.

> **Developer clarification required — Gate B:** Confirm the secret classes, organization-specific patterns, approved safe-parameter allow-list, URL and path treatment, audit requirements, and who may approve rule changes.

### 6.8 Segmentation engine

**Purpose:** Keep normal statistics and failure context inside the correct Jules stage or Lattice node attempt.

**Input:** Protected canonical events and source lifecycle metadata.

**Output:** `segment_id`, scope, attempt, logical position, confidence, lifecycle state, and a compact `segment-groups.json` summary.

**Implementation work:**

1. Use a deterministic segment identity derived from run and source scope.
2. Maintain one active Jules stage-attempt state as defined by the Jules contract.
3. Maintain independent active Lattice node-attempt states.
4. Track logical order separately from physical line order.
5. Record summarized physical ranges without copying the full log.
6. Handle missing start/end events with a configured, visible low-confidence policy.
7. Close state only on a trusted lifecycle event, approved inactivity rule, cancellation, or terminal completion.

**Acceptance criteria:** Every event has at most one owning segment unless the source contract explicitly supports shared ownership; interleaved Lattice examples remain separate; incomplete segmentation is visible.

> **Developer clarification required — Gate A:** Confirm whether a log record can belong to more than one node, how nested stages are represented, and what should happen when lifecycle events are missing or arrive out of order.

### 6.9 Drain parser and fingerprint finalizer

**Purpose:** Group protected messages into reusable templates and create stable cross-run identities.

**Input:** Masked message, segment metadata, compatible Drain state, Drain settings, and fingerprint version.

**Output:** Run-local cluster assignment during streaming; after finalization, canonical templates, cluster-to-fingerprint mapping, and serialized parser state.

**Implementation work:**

1. Select and wrap one Drain implementation behind an internal parser interface.
2. Pin depth, similarity, tokenization, wildcard, child-limit, and tie-breaking settings.
3. During successful learning, update the new baseline parser state.
4. During failed Pass 1, update only a private run-local copy.
5. Count failed events by stable run-local cluster ID while templates can still evolve.
6. Freeze the parser after the final event.
7. Canonicalize final template text deterministically.
8. Compute `SHA-256(fingerprint_version + "\n" + canonical_template_text)`.
9. Store canonical text and verify that one fingerprint never maps to different text.
10. Make failed Pass 2 matching read-only with deterministic tie-breaking.

**Acceptance criteria:** Repeated parsing of the same immutable input gives the expected final catalog; local IDs never cross a state boundary; fingerprints change only with final text or fingerprint version; replay cannot mutate state.

> **Developer clarification required — Gate B:** Choose the Drain library and runtime language, approved settings, tokenizer behaviour, serialization format, tie-breaking rule, parser-state compatibility policy, and maximum template count per baseline family.

### 6.10 Baseline builder and publisher

**Purpose:** Create an immutable, compatible description of normal repository behaviour.

**Input:** Eligible successful-run event, final template catalog, segment-aware counts and sequences, safe parameter summaries, parser state, source versions, and branch class.

**Output:** `baseline.json`, `templates.json`, `state.json`, and an atomically updated `current.json` pointer.

**Implementation work:**

1. Partition by the four-part baseline family key.
2. Keep one repository/source template catalog with statistics separated by pipeline, branch class, stage or node, attempt class, and environment.
3. Aggregate only compatible trusted successes.
4. Define the rolling-window calculation and minimum sample requirement.
5. Write all version artifacts to a new immutable location.
6. Validate schemas, checksums, source references, parser state, and fingerprint-to-text integrity.
7. Publish `current.json` with compare-and-set only after all artifacts are complete.
8. Make duplicate successful events idempotent.
9. Retain the prior baseline pointer for rollback.

**Acceptance criteria:** Readers see either the old complete version or the new complete version, never a partial version; incompatible runs are not mixed; failed runs cannot write this path.

> **Developer clarification required — Gate B:** Confirm minimum successful runs, rolling-window size, main/release fallback, baseline retention, publication approval, rollback rules, and whether multiple pipelines in one repository share a catalog immediately or after validation.

### 6.11 Failure-analysis orchestrator

**Purpose:** Own one failed-run analysis from accepted event to final evidence pack.

**Input:** Validated failed event, immutable raw-log manifest, compatible baseline, processing bundle, tenant limits, and cancellation signal.

**Output:** `analysis_id`, `analysis-manifest.json`, status transitions, checkpoints, partial/failure reasons, cost record, and final evidence pack.

**Implementation work:**

1. Generate one unique `analysis_id` for each requested analysis.
2. Resolve and pin the raw object, baseline, configuration, limits, and occurrence strategy before Pass 1.
3. Use a state machine with idempotent transitions.
4. Acquire renewable worker leases and write bounded checkpoints.
5. Partition all mutable records by ownership key, run ID, and analysis ID.
6. Apply cancellation, timeout, retry, and cleanup policies.
7. Mark partial results explicitly when a limit or consistency check fails.
8. Emit cost and performance measurements at completion.

**Acceptance criteria:** Simultaneous analyses cannot mix state; retries produce the same logical outputs; expired leases can be recovered; cancelled work stops reading and cleans temporary artifacts.

> **Developer clarification required — Gate C:** Choose the workflow or queue technology, retry counts, lease duration, analysis deadline, cancellation source, partial-result contract, and whether one run may have several concurrent analysis IDs.

### 6.12 Pass 1 summary, Aho–Corasick, and direct expansion

**Purpose:** Summarize the complete failed run once and keep immediately useful evidence while the log is already being read.

**Input:** Failed canonical event stream, private compatible Drain copy, compiled keyword policy, segment states, and expansion limits.

**Output:** Run-local cluster counts, segment-aware sequences, safe parameter distributions, severity and terminal summaries, bounded keyword groups, direct candidate records, direct fragments, and final failed-template summary.

**Implementation work:**

1. Update counts and bounded run-length sequences by run-local cluster and compatible scope.
2. Run one shared immutable Aho–Corasick matcher over each redacted message.
3. Use only bounded precompiled expressions for patterns that cannot be literals.
4. Keep counts and representative pointers instead of one in-memory candidate per repeated hit.
5. Maintain bounded per-segment before-context ring buffers.
6. Open bounded after-context fragments for approved direct candidates.
7. Extend through approved multiline and stack boundaries.
8. Keep a bounded global/source-aware tail.
9. Store the run-local cluster ID on a direct candidate while Pass 1 is still mutable; do not persist an intermediate fingerprint.
10. Freeze the parser, finalize fingerprints, and rewrite summaries and direct candidates to final identities.
11. Merge later LogDiff reasons into existing occurrences instead of expanding them twice.

**Acceptance criteria:** Keyword count does not multiply full-log scans; memory remains bounded during a retry storm; direct candidates retain exact provenance; no intermediate fingerprint reaches LogDiff.

> **Developer clarification required — Gate C:** Provide the first literal keyword set, word-boundary and case rules, bounded expression list, hit-sampling limits, tail policy, before/after window, stack rules, and maximum direct-fragment size.

### 6.13 LogDiff

**Purpose:** Explain how the failed-run summary differs from a compatible successful baseline.

**Input:** Compatible baseline manifest, templates and statistics; finalized failed-template summary; LogDiff policy version.

**Output:** Compatibility decision, exact matches, new templates, missing templates, frequency/scope/sequence/severity/parameter changes, selector set, and measurable reasons.

**Implementation work:**

1. Reject incompatible ownership keys, source schemas, processing versions, parser versions, or fingerprint versions.
2. Compare stable fingerprints, never local numeric IDs.
3. Compare counts inside compatible pipeline, branch class, environment, stage/node, and attempt scopes.
4. Apply both relative and absolute frequency thresholds.
5. Compare bounded run-length-encoded segment sequences.
6. Compare only approved safe-parameter distributions.
7. Store missing templates as structural signals without pretending they have failed-run line pointers.
8. Create a small hash-set-friendly selector output.
9. Store every threshold, observed value, expected value, and rule version.

**Acceptance criteria:** Each diff reason is reproducible from its two summaries; incompatible inputs stop clearly; missing templates do not create fake occurrences; every selector has a compatible scope.

> **Developer clarification required — Gate C:** Approve minimum baseline sample size, frequency thresholds, branch fallback, sequence limits, safe-parameter tests, selector caps, and the policy for a failed run with no compatible baseline.

### 6.14 Occurrence location: frozen replay and thin index

**Purpose:** Locate exact failed-log occurrences for selectors that became known only after LogDiff.

**Strategy A input:** Immutable failed log, pinned preprocessing, finalized run-local catalog, selector hash set, and expansion policy.

**Strategy A output:** Candidate occurrences, expanded fragments, and replay counts for each selected fingerprint and scope.

**Strategy A work:**

1. Stream the immutable failed log again.
2. Recreate canonical and protected events with the exact pinned rules.
3. Match against the finalized catalog without creating or updating templates.
4. Use deterministic similarity and tie-breaking.
5. Expand matching occurrences with per-segment ring buffers.
6. Compare replayed selector counts with Pass 1 counts.
7. Mark the analysis `partial` and `needs_review` on unexplained mismatch.

**Strategy B input:** Pass 1 event metadata and the selected thin-index policy.

**Strategy B output:** Temporary compressed index, final cluster dictionary, selector postings, and targeted raw-log ranges.

**Strategy B work:**

1. Write compact entries containing run-local cluster dictionary ID, segment ID, logical position, physical line, chunk ID, byte start/length, and safe flags.
2. Use a binary version header, checksums, dictionary encoding, delta encoding, and bounded blocks.
3. Finalize the cluster-to-fingerprint dictionary after Pass 1.
4. Resolve selectors to cluster IDs and logical neighbours.
5. Merge nearby ranges before range reads.
6. Delete the index at retention expiry.

**Acceptance criteria:** Replay and thin-index paths produce equivalent candidate and fragment contracts; Lattice neighbours remain node-local; neither path loads the complete log; the selected strategy is pinned before Pass 1.

> **Developer clarification required — Gate C:** Define the measured strategy threshold, thin-index binary schema owner, block/checksum format, temporary storage location, maximum index size, retention, and behaviour when object storage does not support efficient range reads.

### 6.15 Candidate pool

**Purpose:** Store suspicious occurrence references safely while many analyses run concurrently.

**Input:** Occurrence identity, ownership/run/analysis keys, fingerprint, scope, line and byte provenance, discovery path, reasons, and expiry.

**Output:** Immutable or versioned candidate record with all merged reasons and a deterministic identity.

**Implementation work:**

1. Partition by tenant ownership and `analysis_id`.
2. Calculate occurrence identity from immutable raw-log identity, byte range, and segment.
3. Use idempotent insert and compare-and-set reason merging.
4. Store references, not full log text.
5. Cap candidates by reason, fingerprint, segment, category, bytes, and analysis.
6. Support leases, retries, cancellation, and expiry.
7. Keep first, last, near-failure, and representative samples when a group is capped.

**Acceptance criteria:** Repeated selection creates one logical occurrence; simultaneous analyses cannot read or write each other's candidates; caps are visible and do not silently claim completeness.

> **Developer clarification required — Gate C:** Choose the candidate-state store, consistency model, maximum record size, query patterns, TTL, expected candidate volume, and whether updates create new immutable versions or compare-and-set the grouped record.

### 6.16 Content expansion and fragment building

**Purpose:** Recover the smallest useful surrounding story for each candidate.

**Input:** Candidate pointers, segment state, ring buffers or thin-index neighbours, expansion policy, raw-log reader, and correlation metadata.

**Output:** Protected fragment with ordered logical events, exact physical lines and byte ranges, candidate IDs, boundary reasons, excluded interleaved lines when useful, and partial/truncation status.

**Implementation work:**

1. Use configurable before/after logical-event windows.
2. Stay inside the same Jules stage-attempt or Lattice node-attempt by default.
3. Extend to stack, multiline, retry, subprocess, correlation, and terminal boundaries only through approved rules.
4. Merge overlapping windows in the same segment.
5. Keep Lattice noncontiguous byte ranges in logical node order.
6. Enforce maximum events, bytes, duration, open fragments, and after-context wait.
7. Preserve exact source pointers for every retained event.

**Acceptance criteria:** Expansion includes labelled required context, excludes unrelated interleaved output, never crosses an unapproved boundary, and produces identical fragments through replay and thin-index paths.

> **Developer clarification required — Gate C:** Approve default window sizes, structural-boundary rules, correlation fields, cross-node dependency expansion, maximum block delay, and the fallback when segmentation confidence is low.

### 6.17 Evidence blocks and deduplication

**Purpose:** Turn fragments into readable failure stories and reduce repeated evidence without losing history.

**Input:** Expanded fragments, source/scope compatibility rules, deduplication policy, and block limits.

**Output:** Evidence blocks containing protected text, ordered provenance, candidate reasons, duplicate counts, representative examples, source locations, and parent-child links.

**Implementation work:**

1. Merge fragments that overlap or form one known structure.
2. Split unrelated causes and oversized blocks at safe boundaries.
3. Apply exact content hash, canonical hash, template-sequence similarity, retry compression, and approved near-duplicate rules in order.
4. Keep cross-stage or cross-node copies separate when scope changes meaning.
5. Retain first/last occurrence, total count, all affected scopes, representatives, and exact or compressed location lists.
6. Version every deduplication decision.

**Acceptance criteria:** No deduplication rule loses occurrence history; retries compress predictably; oversized stack traces remain structurally valid; every block resolves back to raw evidence.

> **Developer clarification required — Gate C:** Approve maximum block size, exact/canonical hash inputs, template-sequence threshold, near-duplicate method, location-list format, and which cross-scope blocks may be collapsed.

### 6.18 Error classification and priority

**Purpose:** Add a useful error category and operational importance without claiming that the category is the root cause.

**Input:** Deduplicated evidence block, source metadata, explicit severity/exit/status values, template and keyword reasons, and versioned rules.

**Output:** Primary category, secondary labels, confidence, `P0` to `P4` priority, reasons, matched rules, versions, and `needs_review`.

**Implementation work:**

1. Start with deterministic domain and structural rules.
2. Preserve `unknown` as a valid result.
3. Calibrate confidence separately from priority.
4. Require a deterministic approved rule for `P0`.
5. Keep an optional statistical or model fallback behind a feature flag.
6. Store classifier and priority-policy versions with every block.

**Acceptance criteria:** Category, confidence, and priority remain separate; uncertain blocks remain visible; no model-only result can produce `P0`; rules are explainable and reproducible.

> **Developer clarification required — Gate C:** Approve the initial taxonomy, category owners, confidence method, P0–P4 policy, review threshold, and whether a model fallback is allowed in the first release.

### 6.19 Scoring and ranking

**Purpose:** Order blocks by usefulness for explaining the current failure.

**Input:** Classified blocks, LogDiff reasons, failed transition location, provisional scoring policy, and required/diversity rules.

**Output:** Score from 0 to 100, `N`, `S`, and `P` calculations, unscored signals, required rules, policy version, explanation, and deterministic order.

**Implementation work:**

1. Calculate novelty from documented LogDiff reason mappings.
2. Calculate severity from the approved explicit-severity mapping.
3. Calculate proximity from logical distance inside the same segment.
4. Apply `100 × clamp(0,1,0.40N + 0.35S + 0.25P)` for the provisional policy.
5. Keep frequency, scope, structure, correlation, parameter, confidence, quality, repetition, and duplicate signals as visible unscored metadata.
6. Apply required inclusion and diversity rules separately from the score.
7. Use deterministic tie-breaking.

**Acceptance criteria:** Every score can be recalculated from stored values; the same input gives the same order; a high-frequency normal message does not win only because it repeats.

> **Developer clarification required — Gate C:** Approve exact novelty mappings, severity values, proximity window, required-evidence rules, tie-break order, and the labelled evaluation process for changing the policy.

### 6.20 Token selection and evidence-pack assembly

**Purpose:** Build the smallest complete evidence input that fits the target model safely.

**Input:** Ranked blocks, operational priorities, diversity requirements, target tokenizer, total context limit, reservations, and representation policy.

**Output:** `evidence-pack.json`, selected full/compact/summary representations, omission notices, exact token counts, provenance, and `llm-input.md` or the equivalent request payload.

**Implementation work:**

1. Reserve instruction, metadata/LogDiff, retrieval, response, and safety tokens.
2. Use the exact tokenizer for the selected model.
3. Reserve a safe representation for required blocks.
4. Select diverse causes, consequences, stages/nodes, and evidence types.
5. Keep stack traces and structured records intact.
6. Compact only derived evidence at safe boundaries.
7. Recount the complete assembled request.
8. Record every omission, summary, and truncation with full-source pointers.

**Acceptance criteria:** The request never exceeds the configured limit; required structures are not cut; omitted evidence remains accessible by reference; selection is reproducible.

> **Developer clarification required — Gate C:** Confirm the target model and tokenizer, context limit, response reservation, Phase 3 retrieval reservation, per-stage/category quotas, required priority rules, and maximum model cost per analysis.

### 6.21 Model invocation and response validation

**Purpose:** Ask for an evidence-based explanation without allowing unsupported claims or hidden actions.

**Input:** Bounded evidence pack, approved instructions, optional permission-safe retrieved sources, model configuration, and caller identity.

**Output:** Structured diagnosis containing claims, evidence-block IDs, retrieved source IDs, confidence, uncertainties, suggested next checks, usage, and validation status.

**Implementation work:**

1. Define a versioned request and response contract.
2. Require evidence-to-claim mapping for important statements.
3. Reject or mark unsupported source IDs.
4. Keep recommendations separate from execution.
5. Record model, prompt, tokenizer, policy, and retrieval versions.
6. Apply timeout, retry, token, and cost limits.
7. Store protected audit data according to retention policy.

**Acceptance criteria:** No response claims an action was executed; every important claim is supported or marked uncertain; model failures do not remove the evidence pack.

> **Developer clarification required — Gate C:** Confirm the model provider, model, invocation API, data-retention agreement, regional requirements, structured-output support, timeout/retry policy, and human-review workflow.

### 6.22 Phase 3 knowledge and code retrieval

**Purpose:** Add trusted knowledge and commit-matched code that can explain the selected log evidence.

**Input:** Approved knowledge sources or the current evidence pack, caller permissions, repository/commit identity, retrieval policy, and source trust/freshness metadata.

**Output:** Permission-safe knowledge/code records, exact search results, vector results, graph neighbours, reranked context, citations, and retrieval evaluation data.

**Implementation work:**

1. Approve knowledge-learning, failure-retrieval, and validated-feedback modes separately.
2. Define schemas for documents, incidents, confirmed fixes, code symbols, configuration, pipeline definitions, ownership, and repository snapshots.
3. Apply permission and secret checks before indexing.
4. Create exact-text, semantic-vector, and code/dependency indexes.
5. Store repository, branch, and commit SHA on every code record.
6. Filter before retrieval and block wrong-commit or unauthorized results.
7. Merge, rerank, deduplicate, diversify, and token-budget results.
8. Add confirmed RCAs and fixes only through an approved validation workflow.

**Acceptance criteria:** Unauthorized and wrong-commit results are blocked; every retrieved item has provenance, trust, freshness, and permission metadata; a suspected answer cannot become trusted knowledge automatically.

> **Developer clarification required — Gate E:** Approve enabled knowledge sources, source owners, permission model, embedding model, exact index, vector store, code parser/graph, repository access, commit fallback policy, freshness rules, validated-RCA workflow, and Phase 3 release scope.

### 6.23 Proposed Python project structure

This tree is the proposed code layout for design review. It shows future file ownership; it is not implementation code and these files should not be created until the language and repository location are approved.

```text
logsift/
├── pyproject.toml
├── README.md
├── src/
│   └── logsift/
│       ├── __init__.py
│       ├── bootstrap.py
│       ├── settings.py
│       ├── contracts/
│       │   ├── pipeline_event.py
│       │   ├── canonical_event.py
│       │   ├── manifests.py
│       │   ├── baseline_artifacts.py
│       │   ├── analysis_artifacts.py
│       │   ├── evidence_artifacts.py
│       │   └── retrieval_artifacts.py
│       ├── domain/
│       │   ├── identities.py
│       │   ├── provenance.py
│       │   ├── lifecycle.py
│       │   ├── templates.py
│       │   ├── candidates.py
│       │   ├── evidence.py
│       │   └── errors.py
│       ├── ports/
│       │   ├── raw_log_store.py
│       │   ├── artifact_store.py
│       │   ├── metadata_store.py
│       │   ├── candidate_store.py
│       │   ├── configuration_store.py
│       │   ├── baseline_repository.py
│       │   ├── model_gateway.py
│       │   └── retrieval_gateway.py
│       ├── configuration/
│       │   ├── registry.py
│       │   ├── bundle.py
│       │   └── validation.py
│       ├── ingestion/
│       │   ├── event_receiver.py
│       │   ├── event_validator.py
│       │   ├── raw_log_manifest.py
│       │   └── chunked_reader.py
│       ├── sources/
│       │   ├── detector.py
│       │   ├── jules/
│       │   │   ├── signatures.py
│       │   │   ├── adapter.py
│       │   │   └── lifecycle.py
│       │   └── lattice/
│       │       ├── signatures.py
│       │       ├── adapter.py
│       │       └── lifecycle.py
│       ├── preprocessing/
│       │   ├── pipeline.py
│       │   ├── normalization.py
│       │   ├── redaction.py
│       │   ├── safe_parameters.py
│       │   ├── masking.py
│       │   └── rules.py
│       ├── segmentation/
│       │   ├── engine.py
│       │   ├── jules_segments.py
│       │   ├── lattice_segments.py
│       │   └── segment_manifest.py
│       ├── parsing/
│       │   ├── drain_adapter.py
│       │   ├── tokenization.py
│       │   ├── finalization.py
│       │   ├── fingerprint.py
│       │   └── frozen_matcher.py
│       ├── baseline/
│       │   ├── eligibility.py
│       │   ├── statistics.py
│       │   ├── builder.py
│       │   ├── compatibility.py
│       │   ├── resolver.py
│       │   └── publisher.py
│       ├── analysis/
│       │   ├── orchestrator.py
│       │   ├── state_machine.py
│       │   ├── pass1.py
│       │   ├── summary.py
│       │   ├── keyword_matcher.py
│       │   ├── logdiff.py
│       │   ├── selectors.py
│       │   ├── replay.py
│       │   ├── thin_index.py
│       │   └── checkpoints.py
│       ├── candidate_pool/
│       │   ├── identities.py
│       │   ├── sampling.py
│       │   └── repository.py
│       ├── evidence/
│       │   ├── ring_buffers.py
│       │   ├── expansion.py
│       │   ├── fragments.py
│       │   ├── blocks.py
│       │   ├── deduplication.py
│       │   ├── classification.py
│       │   ├── priority.py
│       │   ├── scoring.py
│       │   ├── token_budget.py
│       │   └── evidence_pack.py
│       ├── model/
│       │   ├── request_builder.py
│       │   ├── gateway.py
│       │   └── response_validator.py
│       ├── retrieval/
│       │   ├── ingestion.py
│       │   ├── chunking.py
│       │   ├── exact_search.py
│       │   ├── vector_search.py
│       │   ├── code_graph.py
│       │   ├── fusion.py
│       │   ├── reranking.py
│       │   └── context_budget.py
│       ├── adapters/
│       │   ├── object_storage.py
│       │   ├── metadata_database.py
│       │   ├── candidate_database.py
│       │   ├── configuration_backend.py
│       │   └── retrieval_backends.py
│       ├── observability/
│       │   ├── metrics.py
│       │   ├── tracing.py
│       │   ├── audit.py
│       │   └── cost_usage.py
│       └── entrypoints/
│           ├── api.py
│           ├── worker.py
│           └── maintenance.py
├── config/
│   ├── schemas/
│   ├── processing/
│   ├── failure_analysis/
│   └── retrieval/
├── examples/
│   ├── jules/
│   └── lattice/
└── tests/
    ├── unit/
    ├── contracts/
    ├── golden/
    ├── security/
    ├── determinism/
    ├── concurrency/
    ├── performance/
    └── evaluation/
```

#### Top-level files

| File | Purpose | Expected outcome |
|---|---|---|
| `pyproject.toml` | Define the Python version, packages, dependencies, test tools, type checking, linting, and build metadata | One repeatable development and build environment |
| `README.md` | Explain local setup, supported commands, configuration, and links to architecture contracts | A new engineer can run validation and tests without reading source internals first |
| `bootstrap.py` | Build the dependency graph from configuration and selected adapters | Entrypoints receive fully constructed services without creating databases or clients inside business logic |
| `settings.py` | Read process-level runtime settings such as endpoints and worker limits | Environment settings stay separate from versioned diagnostic rules |

#### Contracts and domain files

| File | Purpose | Input | Outcome |
|---|---|---|---|
| `contracts/pipeline_event.py` | Validate versioned terminal-event payloads | Untrusted event payload | Typed accepted event or validation errors |
| `contracts/canonical_event.py` | Define the common Jules/Lattice event contract and source extensions | Adapter fields | Typed canonical event with exact provenance |
| `contracts/manifests.py` | Define raw-log, processing, segment, and analysis manifests | Component output fields | Validated immutable manifests |
| `contracts/baseline_artifacts.py` | Define baseline, template, state, and current-pointer schemas | Offline output | Compatible baseline artifacts |
| `contracts/analysis_artifacts.py` | Define failed summary, parser state, LogDiff, and candidate schemas | Failure-analysis output | Versioned analysis records |
| `contracts/evidence_artifacts.py` | Define fragment, block, score, token, and evidence-pack schemas | Evidence pipeline output | Bounded auditable evidence artifacts |
| `contracts/retrieval_artifacts.py` | Define knowledge, code, result, and citation schemas | Phase 3 data | Permission and commit-aware retrieval records |
| `domain/identities.py` | Centralize baseline, run, analysis, occurrence, fragment, and block identity rules | Ownership and provenance fields | Deterministic IDs without duplicated string-building logic |
| `domain/provenance.py` | Represent line, byte, chunk, object, segment, and logical-position references | Reader and adapter metadata | One consistent provenance model |
| `domain/lifecycle.py` | Represent learning and analysis states and allowed transitions | Current state and event | Valid next state or explicit transition error |
| `domain/templates.py` | Represent run-local clusters, final templates, fingerprints, and scoped statistics | Parser and summary data | Storage-independent template domain objects |
| `domain/candidates.py` | Represent occurrence reasons and candidate grouping | LogDiff and direct signals | One candidate identity with merged reasons |
| `domain/evidence.py` | Represent fragments, blocks, classifications, scores, and selections | Evidence stages | Clear immutable stage boundaries |
| `domain/errors.py` | Define stable error and partial-result reason codes | Component failures | Consistent API, metrics, retry, and audit behaviour |

#### Ports and adapters

The files in `ports/` define the behaviour needed by business logic. They must not contain a database-specific implementation. The files in `adapters/` implement those ports for approved infrastructure.

| Port | Required operations | Outcome |
|---|---|---|
| `raw_log_store.py` | Resolve immutable object, stream chunks, range-read, verify version, delete by policy | Business logic can read logs without knowing the storage vendor |
| `artifact_store.py` | Put/get immutable artifact, checksum, list version, delete by retention | Baselines and evidence use one versioned storage contract |
| `metadata_store.py` | Idempotent event insert, state transition, lease, checkpoint, compare-and-set pointer | Orchestration remains safe under retries |
| `candidate_store.py` | Insert occurrence, merge reasons, list by analysis, expire | Candidate isolation and bounded queries |
| `configuration_store.py` | Publish and resolve immutable bundles and old versions | Deterministic processing across workers |
| `baseline_repository.py` | Resolve compatible baseline, publish version, update/rollback pointer | Baseline logic stays storage-independent |
| `model_gateway.py` | Count tokens, invoke bounded request, return usage and structured result | Model provider is isolated behind one safe contract |
| `retrieval_gateway.py` | Permission-filtered exact/vector/graph queries and deletion | Phase 3 can change backend without changing evidence logic |

#### Processing and source files

| File | Purpose | Expected outcome |
|---|---|---|
| `ingestion/event_receiver.py` | Accept authenticated terminal events and apply idempotent receipt | One stored logical event per `event_id` |
| `ingestion/event_validator.py` | Apply required-field, terminal-state, and completeness checks | Accepted event or stable rejection reasons |
| `ingestion/raw_log_manifest.py` | Resolve object identity, compression, chunks, checksums, and offset spaces | Immutable input contract for readers and provenance |
| `ingestion/chunked_reader.py` | Stream bounded chunks while preserving complete records and positions | Memory independent of total log size |
| `sources/detector.py` | Combine trusted event source type with bounded prefix signatures | `JULES`, `LATTICE`, or `UNKNOWN` with reasons |
| `sources/jules/adapter.py` | Parse Jules envelopes into canonical events | Stage/attempt-aware ordered event stream |
| `sources/jules/lifecycle.py` | Enforce Jules stage and retry transition rules | Correct segment ownership and completion |
| `sources/lattice/adapter.py` | Parse Lattice envelopes into canonical events | Node/attempt-aware event stream with physical provenance |
| `sources/lattice/lifecycle.py` | Maintain concurrent DAG-node states and node-local sequence | Interleaved output remains logically separate |
| `preprocessing/pipeline.py` | Run preprocessing stages in one fixed order | One protected event contract for all later algorithms |
| `preprocessing/normalization.py` | Remove approved presentation differences | Stable text without losing meaning or provenance |
| `preprocessing/redaction.py` | Permanently remove configured secrets | No secret reaches derived storage or model input |
| `preprocessing/safe_parameters.py` | Extract only approved diagnostic values | Bounded typed values for LogDiff |
| `preprocessing/masking.py` | Replace changing values with typed placeholders | Stable text for Drain while useful safe values remain separate |
| `preprocessing/rules.py` | Load, order, validate, and explain rule matches | Deterministic versioned rule execution |
| `segmentation/engine.py` | Route protected events to the source-specific segment state machine | Segment ID and logical position on every supported event |
| `segmentation/jules_segments.py` | Maintain stage-attempt segments | Sequential Jules scope and boundaries |
| `segmentation/lattice_segments.py` | Maintain independent node-attempt segments | Correct noncontiguous Lattice scope and ordering |
| `segmentation/segment_manifest.py` | Summarize lifecycle, counts, confidence, and physical ranges | Compact segment artifact without complete log text |
| `parsing/drain_adapter.py` | Wrap the approved Drain library and hide library-local types | Stable internal parser interface |
| `parsing/tokenization.py` | Define exactly how protected messages become Drain tokens | Same tokens across learning and failure analysis |
| `parsing/finalization.py` | Stop mutation and map final clusters to canonical templates | Final catalog safe for LogDiff and replay |
| `parsing/fingerprint.py` | Compute and verify versioned template hashes | Stable cross-run template identity |
| `parsing/frozen_matcher.py` | Match replay events against the finalized catalog without mutation | Exact remaining occurrence discovery or visible mismatch |

#### Baseline and analysis files

| File | Purpose | Expected outcome |
|---|---|---|
| `baseline/eligibility.py` | Apply trusted-success learning policy | Explicit learning decision and reasons |
| `baseline/statistics.py` | Maintain mergeable counts, scope, sequence, severity, and safe-value summaries | Bounded normal-behaviour statistics |
| `baseline/builder.py` | Assemble all offline artifacts | Complete candidate baseline version |
| `baseline/compatibility.py` | Compare ownership and version contracts | Safe match or detailed incompatibility |
| `baseline/resolver.py` | Select exact branch-class statistics and approved fallback | One compatible baseline for LogDiff |
| `baseline/publisher.py` | Validate artifacts and atomically change `current.json` | Readers never observe partial baseline state |
| `analysis/orchestrator.py` | Coordinate the full failed-run workflow | One isolated evidence pack or explicit partial/failure result |
| `analysis/state_machine.py` | Enforce allowed analysis transitions | Safe retries and recovery |
| `analysis/pass1.py` | Stream the failed run through preprocessing, segmentation, parsing, and direct expansion | Complete run-local summary and direct evidence |
| `analysis/summary.py` | Accumulate bounded cluster, scope, sequence, severity, and parameter summaries | Final `failed-template-summary.json` |
| `analysis/keyword_matcher.py` | Compile and run multi-pattern literal rules | One linear keyword scan per message |
| `analysis/logdiff.py` | Compare compatible success and failed summaries | Measured differences and selectors |
| `analysis/selectors.py` | Normalize selectors into bounded hash-set lookup keys | Fast occurrence checks with compatible scope |
| `analysis/replay.py` | Locate remaining selectors using the frozen catalog | Candidate pointers and replay consistency counts |
| `analysis/thin_index.py` | Optionally encode and query temporary event postings | Targeted lookup for approved large/repeated cases |
| `analysis/checkpoints.py` | Capture safe resumable stage state | Retry without mixed or duplicated output |

#### Candidate, evidence, and model files

| File | Purpose | Expected outcome |
|---|---|---|
| `candidate_pool/identities.py` | Calculate deterministic occurrence and grouped candidate IDs | Retry-safe candidate identity |
| `candidate_pool/sampling.py` | Keep first, last, near-failure, and representative bounded hits | Candidate growth stays bounded without hiding counts |
| `candidate_pool/repository.py` | Apply analysis partitioning and reason merging through the candidate port | Durable isolated candidate state |
| `evidence/ring_buffers.py` | Keep bounded previous events per active segment | Constant-size before-context per segment |
| `evidence/expansion.py` | Open, extend, merge, and close candidate context | Relevant segment-local fragments |
| `evidence/fragments.py` | Validate fragment boundaries and provenance | Immutable `expanded-fragments` records |
| `evidence/blocks.py` | Join related fragments and split unrelated or oversized stories | Readable evidence blocks |
| `evidence/deduplication.py` | Apply exact, canonical, retry, sequence, and approved near-duplicate rules | Less repetition with occurrence history intact |
| `evidence/classification.py` | Apply the error-category policy | Category, confidence, matched reasons, and review state |
| `evidence/priority.py` | Apply deterministic operational rules | P0–P4 independent of classification confidence |
| `evidence/scoring.py` | Calculate provisional novelty, severity, and proximity score | Explainable 0–100 evidence ranking |
| `evidence/token_budget.py` | Count exact tokens and select safe diverse representations | Evidence fits the configured model context |
| `evidence/evidence_pack.py` | Assemble final metadata, diff, blocks, notices, and provenance | Versioned bounded model/retrieval input |
| `model/request_builder.py` | Build the approved structured prompt from the evidence pack | Stable request contract without unrestricted raw logs |
| `model/gateway.py` | Apply model timeout, retry, usage, and cost policy | Provider-independent bounded invocation |
| `model/response_validator.py` | Verify claim citations, IDs, uncertainty, and response schema | Supported diagnosis or visible validation errors |

#### Phase 3 files

| File | Purpose | Expected outcome |
|---|---|---|
| `retrieval/ingestion.py` | Authorize, redact, version, and route approved sources | Safe indexable records |
| `retrieval/chunking.py` | Create document and symbol-aware chunks with stable IDs | Readable retrievable units with parent links |
| `retrieval/exact_search.py` | Search exact errors, fingerprints, symbols, paths, and keys | High-precision lexical candidates |
| `retrieval/vector_search.py` | Search semantically related approved content | Meaning-based candidates with metadata filters |
| `retrieval/code_graph.py` | Traverse bounded symbol, call, test, config, pipeline, dependency, and ownership links | Structurally related code context |
| `retrieval/fusion.py` | Combine independently ranked exact, vector, and graph results | One candidate list without score-scale assumptions |
| `retrieval/reranking.py` | Apply relevance, trust, freshness, permissions, and compatibility | Ordered grounded context |
| `retrieval/context_budget.py` | Remove repetition and fit diverse sources into retrieval tokens | Bounded cited retrieval pack |

#### Entrypoints

| File | Purpose | Restriction |
|---|---|---|
| `entrypoints/api.py` | Expose event receipt, status, cancellation, and result retrieval | It validates and delegates; it does not perform log analysis inside request handling |
| `entrypoints/worker.py` | Start bounded background workers for learning and failure analysis | It obtains leases and invokes application services; it does not contain domain rules |
| `entrypoints/maintenance.py` | Run retention, orphan cleanup, baseline validation, and index deletion | Destructive actions require exact ownership paths, policy checks, and audit records |

#### Dependency rules

```text
entrypoints
    -> application components
        -> domain + contracts + ports

infrastructure adapters
    -> ports + external clients

domain and algorithms
    -> never import entrypoints, databases, object-storage clients, or model SDKs
```

Additional rules:

1. Source adapters produce canonical events; they never publish baselines.
2. Preprocessing never writes directly to a database.
3. Drain and LogDiff receive typed domain objects, not storage SDK responses.
4. Evidence algorithms never fetch unrestricted raw logs; they use the authorized raw-log port.
5. The model gateway receives only the bounded evidence/retrieval pack.
6. Phase 3 cannot write the success baseline.
7. Configuration versions are passed explicitly; algorithms do not read a mutable global “latest” value.
8. `analysis_id` is required at every mutable failure-analysis boundary.

#### Proposed service operations

These are conceptual code boundaries, not implemented method signatures. Their purpose is to make ownership, input, output, and side effects clear before code is written.

| Operation | Owner module | Input | Output | Allowed side effects |
|---|---|---|---|---|
| `accept_pipeline_event` | `ingestion/event_receiver.py` | Authenticated terminal-event payload | Accepted event ID or stable rejection | Idempotent event receipt and audit record |
| `decide_learning_eligibility` | `baseline/eligibility.py` | Validated event, source decision, completeness, policy | Eligible/rejected decision with reasons | None |
| `learn_successful_run` | `baseline/builder.py` | Eligible event, immutable log manifest, processing bundle, prior baseline | Complete unpublished baseline version | Immutable artifact writes only |
| `publish_baseline` | `baseline/publisher.py` | Validated baseline version and expected current pointer | Published version or compare-and-set conflict | Atomic `current.json` update and audit record |
| `analyze_failed_run` | `analysis/orchestrator.py` | Failed event, immutable log manifest, compatible baseline, limits | Evidence pack or explicit partial/failure result | Analysis state, leases, checkpoints, temporary artifacts |
| `detect_source` | `sources/detector.py` | Trusted event fields and bounded log prefix | Source decision with confidence and reasons | None |
| `adapt_event` | Source adapter | Source record plus provenance | Canonical event or source-contract error | None |
| `protect_event` | `preprocessing/pipeline.py` | Canonical event and immutable rule bundle | Protected event, safe parameters, rule audit | Redaction-audit counters only through a supplied sink |
| `assign_segment` | `segmentation/engine.py` | Protected event and source lifecycle state | Segment ID, logical position, lifecycle changes | Bounded in-memory state owned by the current run |
| `observe_template` | `parsing/drain_adapter.py` | Masked message and private mutable parser | Run-local cluster ID and current template | Mutates only the run-owned parser copy |
| `finalize_templates` | `parsing/finalization.py` | Completed private parser and run summary | Frozen catalog, fingerprints, finalized summary | Writes immutable failed or baseline parser artifacts |
| `resolve_baseline` | `baseline/resolver.py` | Four-part family key, branch class, versions, pipeline scope | Exact compatible baseline or refusal/fallback reason | Read-only |
| `compare_summaries` | `analysis/logdiff.py` | Compatible baseline and failed summaries, policy | Diff records, selectors, structural notices | Read-only |
| `locate_occurrences` | `analysis/replay.py` or `analysis/thin_index.py` | Selectors, failed log or temporary index, pinned manifest | Exact candidate pointers and consistency counts | Candidate inserts; temporary range reads |
| `merge_candidate_reason` | `candidate_pool/repository.py` | Analysis ID, occurrence identity, reason | Immutable/versioned grouped candidate | Idempotent candidate-state write |
| `expand_candidate` | `evidence/expansion.py` | Candidate pointer, segment-local context source, policy | Ordered protected fragment | Authorized bounded raw-log reads only |
| `build_blocks` | `evidence/blocks.py` | Compatible fragments and block policy | Evidence blocks with complete provenance | Immutable block artifact write |
| `deduplicate_blocks` | `evidence/deduplication.py` | Evidence blocks and scope rules | Representative blocks plus occurrence history | None |
| `classify_and_score` | Classification, priority, and scoring modules | Deduplicated block, LogDiff facts, failure position, policies | Category, priority, score, explanations | None |
| `select_evidence` | `evidence/token_budget.py` | Ranked blocks, tokenizer, reservations, quotas | Selected representations and omission notices | Token/cost counters only |
| `build_evidence_pack` | `evidence/evidence_pack.py` | Failure metadata, LogDiff, selected blocks, provenance | Versioned bounded evidence pack | Immutable artifact write |
| `request_diagnosis` | `model/gateway.py` | Approved model request and caller policy | Structured response plus usage | External model call and protected audit record |
| `retrieve_context` | Retrieval modules | Evidence query, permissions, repo and commit filters | Cited exact/vector/graph context | Read-only retrieval queries |

#### Error and retry contract

Each operation must return one of three result classes:

1. **Success:** the output is complete and validated.
2. **Partial:** safe output exists, but a named limit or consistency check prevented a complete result.
3. **Failure:** no downstream component may treat the output as complete.

Errors also need a stable reason code and a retry class:

- `RETRYABLE` for a temporary storage, queue, lease, or provider failure;
- `NON_RETRYABLE_INPUT` for an invalid event, unsupported source, or corrupt immutable object;
- `NON_RETRYABLE_COMPATIBILITY` for incompatible baseline or processing versions;
- `LIMIT_REACHED` for a visible bounded-resource stop that produces a partial result;
- `CANCELLED` for an explicit cancellation.

Retries must reuse the same logical event, run, baseline version, processing bundle, raw-object version, and analysis ID. A retry must not silently resolve a newer baseline or configuration.

> **Developer clarification required now:** Confirm Python or provide the selected language, current repository structure, packaging standard, dependency-injection style, schema library, and async/concurrency model before turning this proposal into directories or files.

## 7. Data contracts and artifact ownership

Every contract should have a schema version, owner, compatibility rule, example, validator, and retention class.

| Artifact | Producer | Main consumer | Required implementation decision |
|---|---|---|---|
| `pipeline-event.json` | Pipeline integration | Event receiver | Real fields, authentication, delivery, retries |
| `event-decision.json` | Eligibility evaluator | Learning/failure orchestrator | Decision and rejection reason taxonomy |
| `processing-config.json` | Configuration publisher | All workers | Bundle schema, approval, immutable retention |
| `raw-log-manifest.json` | Log ingestion | Reader and provenance validator | Compression, chunks, checksums, offset space |
| `canonical-event` stream | Source adapter | Preprocessing and segmentation | Common and source-extension fields |
| `redaction-audit` | Preprocessing | Security audit | Safe rule IDs and counts without secret values |
| `segment-groups.json` | Segmentation | Baseline, expansion, audit | Lifecycle, confidence, range summary |
| `baseline.json` | Baseline builder | Baseline resolver | Compatibility and completeness contract |
| `templates.json` | Baseline builder | LogDiff | Catalog and scoped statistics schema |
| `state.json` | Drain baseline builder | Later parsing | Parser serialization and compatibility |
| `current.json` | Baseline publisher | Baseline resolver | Atomic pointer and rollback data |
| `analysis-manifest.json` | Failure orchestrator | Every analysis worker | Pinned versions, limits, strategy, state |
| `failed-template-summary.json` | Pass 1 finalizer | LogDiff and replay validator | Cluster mapping, counts, sequences, parameters |
| `failed-parser-state.json` | Pass 1 finalizer | Frozen replay | Read-only final catalog format |
| `optional-thin-index.bin` | Pass 1 index writer | Thin-index occurrence locator | Binary layout, dictionary, checksum, TTL |
| `logdiff-result.json` | LogDiff | Locator and evidence pack | Diff reason and selector schema |
| `candidate-occurrences.jsonl` | Candidate pool | Expansion and audit | Identity, reason merge, pointer contract |
| `expanded-fragments.jsonl` | Content expander | Block builder | Logical order, byte ranges, limits, partial flags |
| `log-blocks.jsonl` | Block pipeline | Classifier, scorer, selector | Text, provenance, dedup, category, score fields |
| `evidence-pack.json` | Token selector | Model/retrieval | Final bounded evidence contract |
| `model-response.json` | Model gateway | UI/API and feedback | Claim mapping, uncertainty, validation status |
| `cost-usage.json` | Orchestrator and gateways | Cost reporting | Meter names, units, tenant-safe dimensions |

Schema changes are complete only when the schema, examples, validators, compatibility rules, tests, and documentation change together.

### 7.1 Algorithm design for review

This section specifies the proposed algorithms. “Selected” means the algorithm is the current recommended design. It does not mean the implementation exists.

#### Algorithm summary

| Problem | Selected algorithm | Why it fits | Main output |
|---|---|---|---|
| Read huge logs | Sequential chunked reader with carry-over buffer | Linear reading and bounded memory | Canonical records with line/byte provenance |
| Detect source | Trusted event field plus bounded prefix signature decision | Does not inspect the whole log or guess from line order | Source type, confidence, reasons |
| Preprocess text | Ordered deterministic rule pipeline | Repeatable and versionable | Protected masked event and safe parameters |
| Group pipeline work | Source-specific lifecycle state machines | Correct Jules sequence and Lattice interleaving | Segment ID and logical position |
| Parse message families | Drain fixed-depth parsing tree | Bounded online routing and small leaf comparisons | Run-local clusters and final templates |
| Identify templates | SHA-256 over fingerprint version and canonical text | Stable across parser instances | Template fingerprint |
| Match many failure literals | Aho–Corasick automaton | One message scan for all literal patterns | Keyword rule hits |
| Keep repeated hits bounded | Deterministic representative sampling | Stable memory and repeatable output | Counts plus selected pointers |
| Summarize values | Counters, online numeric moments, and mergeable quantile sketch | Bounded streaming statistics | Baseline and failed safe-parameter summaries |
| Compress sequences | Run-length encoding | Retry loops do not create huge sequences | Bounded segment-local sequence |
| Compare sequences | Anchors followed by bounded Myers diff | Understandable insert/delete/move neighbourhoods | Sequence-change records and selectors |
| Compare templates | Hash-map set and scope comparison | Linear in number of templates, not raw lines | LogDiff result |
| Expand stream context | Per-segment ring buffers and active windows | Constant memory per active segment | Candidate fragments |
| Expand indexed context | Dictionary postings plus logical-neighbour lookup | Handles Lattice interleaving without replay | Targeted byte ranges |
| Merge windows | Sort and merge compatible logical intervals | Removes repeated range reads and copied context | Non-overlapping fragments |
| Deduplicate blocks | Exact hash, canonical hash, retry compression, then guarded similarity | Cheap checks first and scope-safe reduction | Evidence blocks with history |
| Classify errors | Priority-ordered deterministic rule engine | Explainable first release | Category, confidence, priority reasons |
| Rank evidence | Provisional weighted normalized score | Simple and auditable before calibration | 0–100 score and factor record |
| Select model context | Required-first, quota-aware greedy selection with diversity penalty | Predictable cost without expensive exact optimization | Token-bounded evidence pack |
| Phase 3 retrieval | BM25, vector similarity, bounded graph traversal, rank fusion, reranking | Combines exact, semantic, and structural evidence | Cited retrieval context |

#### 7.1.1 Chunked reading and provenance

**Algorithm:** Read a configured byte chunk, prepend any unfinished bytes from the prior chunk, decode only complete characters, split complete records, and retain the unfinished final record for the next read. Maintain physical line, stored-object offset, uncompressed offset when needed, and chunk identity as monotonic counters.

**Complexity:** `O(B)` time for `B` bytes and approximately `O(chunk_size + maximum_record_size)` memory.

**Important design rules:**

- Chunk size may change performance but must not change output.
- One oversized physical record needs its own explicit limit and partial/error policy.
- Seekable compressed chunks must report both stored and uncompressed offset spaces.
- Range reads must verify the raw object version before returning content.

**Outcome:** A reproducible record stream with exact line and byte provenance, independent of complete log size.

#### 7.1.2 Source detection

**Algorithm:**

1. Validate a trusted `source_type` from the terminal event when present.
2. Inspect at most the configured prefix limit.
3. Apply versioned exact and anchored source signatures.
4. Calculate a decision from required positive signatures and disqualifying signatures.
5. Return `UNKNOWN` on conflict, insufficient evidence, or unsupported version.

The source-signature set is expected to remain small; a deterministic ordered matcher is simpler than a general classifier. Apparent sequential or interleaved order is never a signature by itself.

**Outcome:** One safe adapter decision before segmentation begins.

#### 7.1.3 Normalization, redaction, and masking

**Algorithm:** Apply immutable rules in priority order. Each rule has a source scope, field scope, matcher type, replacement, safety class, and test cases.

Recommended matcher order:

1. structured source-envelope parsing;
2. exact literals and anchored formats;
3. bounded compiled regular expressions;
4. typed value recognizers;
5. allow-list exceptions that were validated before publication.

Avoid expressions with catastrophic backtracking. A rule must have a maximum record length and execution-time test. Multiline secret detection uses a small bounded rolling record window; it does not hold an unbounded segment.

Redaction runs before derived persistence. Safe-parameter extraction runs only on approved fields after redaction. Masking then replaces dynamic values in template text.

**Outcome:** Deterministic protected text, typed safe parameters, matched rule IDs, and unchanged provenance.

#### 7.1.4 Jules and Lattice segmentation

**Jules algorithm:** Maintain a stage-attempt state machine. A trusted stage-start event opens or activates a segment. Each event increments that segment's logical position. A stage-end or terminal event closes it. Retry rules decide whether the next attempt reuses a stage name with a new attempt number.

**Lattice algorithm:** Maintain a dictionary keyed by `node_id + attempt`. Each node has its own lifecycle, logical counter, recent physical ranges, and completion state. Interleaved physical records update only their owning node state.

**Complexity:** `O(1)` expected lookup per event. Memory is `O(active_segments)` plus compact summarized ranges.

**Outcome:** Every supported event receives one segment ID and one logical position without losing its physical location.

#### 7.1.5 Drain parsing

**Algorithm:**

1. Tokenize the protected masked message deterministically.
2. Route first by token count.
3. Route through a configured fixed-depth prefix tree using stable tokens and wildcard branches.
4. Compare only the small leaf cluster set.
5. Reuse the best cluster above the configured similarity threshold or create a new run-local cluster.
6. Generalize changed token positions to wildcards according to the Drain policy.

**Complexity:** Approximately `O(tokens + leaf_candidates × tokens)` per message. Tree depth and leaf child limits keep the candidate set bounded.

**Successful flow:** The new baseline state may learn from an eligible run.

**Failed Pass 1:** A private state copy may create or generalize failed-run clusters. Counts use run-local cluster IDs while templates evolve.

**Finalization:** Stop mutation, normalize final canonical text, map each cluster ID to the final template, then calculate fingerprints.

**Frozen replay:** Use the final catalog only. Do not create clusters or update templates. Apply an approved deterministic tie-break when more than one final template can match.

**Outcome:** Stable final template catalog with no dependence on parser-local IDs across runs.

#### 7.1.6 Fingerprints

**Algorithm:**

```text
fingerprint = SHA-256(fingerprint_version + "\n" + canonical_template_text)
```

Store the canonical text beside the fingerprint. If one fingerprint is ever associated with different text, treat it as an integrity failure.

**Complexity:** Linear in final template text length. Fingerprints are calculated once per final cluster, not once per log occurrence.

**Outcome:** Stable cross-run identity used by LogDiff, selectors, and retrieval.

#### 7.1.7 Streaming counts and safe-value statistics

**Enumerated values:** Use a bounded hash map of approved values and an `OTHER` count. Reject or aggregate a field when its cardinality exceeds policy.

**Numeric values:** Maintain count, minimum, maximum, mean, and variance with Welford's online algorithm. Use an approved mergeable quantile sketch for median and percentile estimates. The proposed starting choice is DDSketch for positive duration and memory values because it has bounded relative error and merges across runs.

**Baseline window:** Keep per-run summaries for the approved rolling window. Derive expected count with a robust median and variation with median absolute deviation where enough samples exist. Do not calculate confidence from one run as if it were a distribution.

**Outcome:** Bounded mergeable normal and failed-run statistics without retaining every numeric value.

> **Developer clarification required — Gate B:** Approve DDSketch or choose another mergeable quantile structure, its error bound, maximum enum cardinality, and the minimum run count for robust statistics.

#### 7.1.8 Sequence compression and comparison

**Compression algorithm:** Store consecutive identical fingerprints as `(fingerprint, repeat_count)`. Keep bounded start, end, terminal, and changed-region anchors. Long retry loops remain one sequence item plus a count.

**Comparison algorithm:**

1. Align compatible segment start/end and known terminal anchors.
2. Run a bounded Myers diff on the run-length-encoded fingerprint sequences between anchors.
3. Emit insertions, deletions, replacements, and repeat-count changes.
4. Create selectors for failed fingerprints around the changed region.
5. Keep a missing success item only as a structural notice because it has no failed occurrence.

Myers diff is proposed because it produces understandable edit operations and works well when two bounded sequences are mostly similar. If a segment exceeds its configured sequence limit, compare bounded prefix, suffix, terminal anchors, and loop summaries and mark reduced confidence.

**Outcome:** Explainable stage/node order changes without storing every repeated occurrence.

#### 7.1.9 Aho–Corasick keyword matching

**Algorithm:** Compile all approved literal patterns for one rule version into one immutable trie with failure links. Stream each redacted message through the automaton once and emit all matching rule IDs.

**Complexity:** `O(message_length + number_of_hits)` and independent of the number of literal rules during matching.

**Rules:** Apply configured case normalization and word-boundary checks. Keep complex patterns in a separate small bounded-expression set. Share the compiled automaton between analyses only as read-only state.

**Outcome:** One safe literal scan per message rather than one full log or message scan per keyword.

#### 7.1.10 Bounded candidate sampling

**Algorithm:** For every `reason + run-local cluster + segment`, keep:

- total hit count;
- first and last hit;
- terminal-nearest hit when known;
- a configured number of deterministic representative hits chosen by the lowest stable hash of occurrence identity;
- any required security or terminal hit.

Stable-hash sampling is preferred over random reservoir sampling because retries must produce the same representatives. The candidate pool stores only pointers and reasons.

**Outcome:** Candidate memory and storage stay bounded while counts and representative evidence remain reproducible.

#### 7.1.11 Ring-buffer expansion

**Algorithm:** Maintain a fixed-capacity deque for each active segment. A direct or replay candidate copies references from that segment's deque, adds itself, and opens an after-context window keyed by segment. Later events update only the matching segment's open windows. Overlapping windows merge before they are written.

**Complexity:** `O(1)` expected work per ordinary event plus work proportional to bounded open fragments. Memory is `O(active_segments × before_window + open_fragment_limits)`.

**Lattice rule:** A Node-A event never enters Node-B's deque. Physical interleaving therefore does not contaminate logical context.

**Outcome:** Before-and-after context without complete segments or logs in memory.

#### 7.1.12 LogDiff

**Algorithm:** Load baseline and failed summaries into hash maps keyed by `fingerprint + compatible scope`.

1. Set difference finds new and missing fingerprints.
2. Shared keys are checked for frequency, scope, severity, and safe-parameter changes.
3. Segment sequences use the bounded sequence algorithm above.
4. Every rule checks minimum sample size, absolute change, relative change, and policy version.
5. Selectors are deduplicated into a hash set while all reasons remain attached.

**Complexity:** Approximately `O(T + S)` for `T` scoped templates and bounded sequence work `S`. It does not depend on raw log line count.

**Outcome:** Small measured selector set and structural missing-template notices.

#### 7.1.13 Frozen replay

**Algorithm:** Recreate protected events from the immutable log using the pinned configuration. Match each event against the frozen final catalog. Check the resulting `fingerprint + scope` in the selector hash set. Expand only selected occurrences and continue to the end for counts.

At completion, compare replay counts for every replayed selector with Pass 1 counts. Exact equality is the proposed correctness rule for immutable input and identical versions. Any mismatch makes the result partial and triggers diagnostics.

**Outcome:** Exact candidate pointers without a mandatory per-event stored index.

#### 7.1.14 Temporary thin index

**Proposed binary layout:**

- versioned header with raw object identity, configuration version, block size, and checksums;
- dictionary mapping small run-local cluster IDs and segment IDs to final metadata;
- blocks of event entries ordered by physical input;
- delta-varint encoded physical line, byte start, and logical position;
- byte length, chunk ID, cluster ID, segment ID, and safe flag bits;
- block checksum and sparse block directory;
- postings or block summaries that locate cluster/segment combinations.

Pass 1 writes run-local cluster IDs. Finalization updates only the small dictionary mapping to fingerprints; it does not rewrite every entry.

**Query algorithm:** Resolve selector fingerprint to cluster ID, locate matching postings, select logical neighbours from the same segment, merge byte ranges by chunk, and issue targeted range reads.

**Outcome:** No complete replay for approved large or repeatedly queried logs, while retaining correct Lattice logical neighbours.

> **Developer clarification required — Gate C:** The thin index remains an experiment until the binary layout, expected bytes per event, write amplification, query count, retention, and replay break-even are benchmarked.

#### 7.1.15 Interval merging

**Algorithm:** Group ranges by immutable raw object, chunk, segment, and compatible scope. Sort by logical start, then merge overlapping or directly adjacent windows when the block policy allows it. Keep the union of candidate IDs and reasons.

For Lattice, logical adjacency can map to several physical ranges. Preserve logical order and coalesce physical byte reads only inside a compatible chunk; do not insert intervening lines owned by another node.

**Outcome:** Fewer reads and fragments without mixing unrelated pipeline work.

#### 7.1.16 Deduplication

Apply the cheapest reliable checks first:

1. **Exact hash:** SHA-256 of ordered protected block text and compatible structural metadata.
2. **Canonical hash:** SHA-256 after approved envelope and masked-value normalization.
3. **Retry compression:** Run-length/group repeated template sequences while preserving first, last, unusual, and terminal-nearest examples.
4. **Template-sequence similarity:** Compare bounded template n-grams only inside compatible tenant, source, and scope rules.
5. **Near duplicate:** Optional after evaluation. Proposed candidate generation uses 64-bit SimHash of template/text features, followed by exact guarded similarity before collapse.

Do not collapse blocks only because their text is similar when their stage, node, attempt, or correlation context changes meaning. Every collapsed group retains count, all scopes, first/last positions, representatives, and source locations.

**Outcome:** Lower evidence and token volume without deleting the history of repeated failures.

> **Developer clarification required — Gate C:** Approve whether SimHash near-duplicate processing belongs in the first release. The recommended first release stops after exact hash, canonical hash, and retry compression unless labelled data proves extra benefit.

#### 7.1.17 Classification and priority

**Algorithm:** Evaluate versioned rules in priority order:

1. deterministic domain rules;
2. explicit source severity, exit, signal, and status fields;
3. stack, exception, assertion, and failed-test structures;
4. keyword and template rules;
5. optional fallback only when approved.

Each matched rule contributes a category claim, confidence rule, secondary labels, and reasons. Conflicts use explicit rule priority and can produce `unknown` with `needs_review`.

Operational priority is a separate deterministic decision table. `P0` requires an approved rule and cannot be produced by confidence alone or a model-only fallback.

**Outcome:** Explainable classification and urgency without claiming a root cause.

#### 7.1.18 Evidence scoring

**Algorithm:** Normalize and store:

- `N`: novelty from approved LogDiff-reason mapping;
- `S`: explicit severity from approved severity mapping;
- `P`: `max(0, 1 - logical_distance / proximity_window)` inside the failed segment.

Then calculate:

```text
score = 100 × clamp(0, 1, 0.40N + 0.35S + 0.25P)
```

Required inclusion, operational priority, deduplication, and diversity are not hidden inside this number. Store them separately. New score factors require a documented calculation, evaluation result, and new policy version.

**Outcome:** Reproducible initial ranking with no false precision from ten uncalibrated factors.

#### 7.1.19 Token-budget selection

The problem resembles a constrained knapsack, but an exact optimizer adds complexity and can behave unexpectedly when requirements change. The proposed first algorithm is deterministic multi-stage greedy selection:

1. Reserve instructions, metadata/LogDiff, retrieval, response, and safety tokens.
2. Select the smallest safe representation of required evidence.
3. Enforce minimum failed-stage/node and evidence-category quotas.
4. Order remaining options by evidence score and token efficiency.
5. Apply a diversity penalty to near-identical scopes, categories, and template sequences.
6. Add the best option that fits; upgrade summary to compact/full when value justifies cost.
7. Preserve complete stack/record boundaries.
8. Recount the complete request with the exact tokenizer.

The token-efficiency formula and diversity penalty are policy fields and must be evaluated. A lower-scoring block may be selected when it provides an otherwise missing stage, earlier cause, configuration signal, or evidence category.

**Outcome:** Predictable bounded input with required evidence, structural safety, and diversity.

#### 7.1.20 Phase 3 hybrid retrieval

**Exact retrieval:** BM25 or the approved exact-index equivalent for error strings, fingerprints, symbols, paths, and configuration keys.

**Semantic retrieval:** Cosine or backend-equivalent similarity over approved embeddings, always with tenant, permission, repository, service, and commit metadata filters.

**Structural retrieval:** Bounded graph traversal from matched code symbols to callers, callees, tests, configuration, pipeline steps, dependencies, and owners. Depth and node count are capped.

**Fusion:** Reciprocal rank fusion is proposed for combining exact, vector, and graph rankings because it does not assume that their raw scores share one scale.

**Reranking:** Apply compatibility, trust, freshness, exact-commit preference, and a bounded learned or rule-based relevance stage. Remove duplicates and apply maximum-marginal-relevance-style diversity before token budgeting.

**Outcome:** Cited, permission-safe, commit-aware context that complements rather than overrides current log evidence.

## 8. State machines and idempotency

### 8.1 Successful learning state

```text
RECEIVED
  -> VALIDATED
  -> ELIGIBLE
  -> PROCESSING
  -> ARTIFACTS_WRITTEN
  -> VALIDATED_FOR_PUBLISH
  -> PUBLISHED
```

Terminal alternatives are `REJECTED`, `FAILED`, and `CANCELLED`. Only `PUBLISHED` may change `current.json`.

### 8.2 Failure-analysis state

```text
RECEIVED
  -> MANIFEST_PINNED
  -> PASS1_RUNNING
  -> PARSER_FINALIZED
  -> LOGDIFF_COMPLETE
  -> OCCURRENCES_LOCATED
  -> FRAGMENTS_COMPLETE
  -> BLOCKS_COMPLETE
  -> CLASSIFIED_AND_SCORED
  -> EVIDENCE_PACK_COMPLETE
  -> MODEL_COMPLETE
```

Allowed terminal alternatives are `PARTIAL`, `FAILED`, `CANCELLED`, and `EXPIRED`. A partial result must record the last complete stage and every reason that caused incompleteness.

### 8.3 Idempotency identities

| Operation | Proposed identity |
|---|---|
| Event receipt | `event_id` |
| Run storage | ownership key + `run_id` + raw object ID/version |
| Baseline contribution | baseline family + successful `event_id` |
| Baseline version | family key + configuration version + deterministic version ID |
| Analysis | run key + `analysis_id` |
| Occurrence | seal + raw object ID/version + byte range + segment ID |
| Fragment | analysis + segment + logical interval + policy version |
| Block | analysis + ordered fragment IDs + block-policy version |
| Model request | evidence-pack content ID + model/prompt version |

> **Developer clarification required — Gates B/C:** Confirm whether IDs must be caller-supplied UUIDs, generated sortable IDs, content hashes, or a combination, and confirm the metadata store's compare-and-set capability.

## 9. Storage and security plan

### 9.1 Storage roles

| Storage role | Data | Required properties |
|---|---|---|
| Restricted object storage | Raw logs and chunks | Immutable versions, encryption, authorization, sequential and range reads, lifecycle deletion |
| Versioned artifact storage | Baselines, summaries, fragments, blocks, evidence packs | Immutable objects, checksums, content/version addressability |
| Transactional metadata store | Events, decisions, pointers, manifests, state, leases, checkpoints | Atomic updates, compare-and-set, indexed ownership keys |
| Candidate state store | Candidate references and scoring records | Analysis partitioning, idempotent writes, TTL, bounded queries |
| Configuration registry | Rule and policy bundles | Immutable versions, approval history, old-version retrieval |
| Phase 3 indexes | Exact text, vectors, symbols, graph | Permission filters, tenant isolation, version and deletion support |

The initial implementation may use one database for the two metadata roles, but raw logs and large evidence text should remain in object storage.

### 9.2 Security controls

1. Authenticate every event producer and user request.
2. Authorize every raw-log, artifact, and retrieval read by `seal_id` and repository access.
3. Encrypt data in transit and at rest.
4. Redact before derived persistence, metrics labels, tracing fields, or model input.
5. Keep raw logs in a restricted location with shorter access paths than general artifacts.
6. Never place raw log text, tokens, URLs with credentials, or private identifiers in metric labels.
7. Audit baseline publication, rule publication, raw-log access, model invocation, retrieval, and deletion.
8. Propagate deletion and retention rules to thin indexes, fragments, model inputs, and Phase 3 indexes.

> **Developer clarification required — Gate D:** Confirm data classification, encryption/key management, regional placement, audit retention, deletion SLA, model-provider data controls, and incident-response owner.

## 10. Concurrency, memory, and reliability plan

### 10.1 Isolation

- Share only immutable baselines, processing bundles, fingerprint definitions, and compiled keyword matchers.
- Keep parser state, selectors, buffers, fragments, counters, cancellation, and writer queues inside one analysis partition.
- Never use a global mutable candidate collection.
- Apply tenant and global worker limits.

### 10.2 Bounded memory

Each worker must have explicit limits for:

- input chunk bytes and unfinished-line bytes;
- active segment count;
- before-context slots per segment;
- open fragments and fragment bytes;
- selector count;
- keyword groups and representative pointers;
- candidate output queue;
- Drain clusters and parser memory;
- block count and block bytes;
- token-selection candidates.

When a limit is reached, the worker applies backpressure, safe sampling, spill-to-durable-state, or a visible partial result. It must never silently drop critical evidence or continue allocating without a bound.

### 10.3 Scheduling

1. Parallelize across independent analyses before splitting one log.
2. Use fair scheduling based on queued bytes and tenant limits.
3. Limit concurrent large-log readers so storage bandwidth remains predictable.
4. Make leases renewable and checkpoints idempotent.
5. On retry, resume from a validated checkpoint or replay a bounded overlap.
6. Prefer simple sequential reads before adding memory mapping, SIMD, or intra-log parallelism.

> **Developer clarification required — Gate D:** Provide expected concurrent analyses, tenant count, log-size distribution, latency target, available CPU/memory, storage throughput, deployment platform, and worker autoscaling constraints.

## 11. Delivery plan

Each milestone is independently testable. Dates should be assigned only after the technology stack, team size, source contracts, and production targets are known.

### Milestone 0 — Contract and sample approval

**Goal:** Remove Gate A blockers before source-specific code begins.

**Deliverables:**

- approved real event examples for Jules and Lattice;
- authenticated event-delivery contract;
- immutable log-access contract and representative logs;
- approved canonical-event schema;
- approved Jules stage and Lattice node/attempt lifecycle contracts;
- initial storage and retention decision;
- contract-test fixtures with expected line, byte, segment, and logical positions.

**Exit criteria:** Integration owners approve inputs and expected canonical outputs. Unknown and malformed cases are included.

### Milestone 1 — Foundation and safe streaming

**Goal:** Build the common control plane and deterministic log reader.

**Deliverables:**

- event receiver and idempotent event store;
- eligibility decision service;
- processing-configuration registry;
- raw-log manifest and bounded reader;
- ownership-key helpers and storage adapters;
- analysis state machine, leases, cancellation, checkpoints, and basic metrics;
- schema validation framework and test-data harness.

**Exit criteria:** A synthetic terminal event streams a large immutable log with stable line/byte provenance and bounded memory, but does not yet publish a baseline.

### Milestone 2 — Jules offline learning vertical slice

**Goal:** Publish the first valid success baseline for sequential Jules stages.

**Deliverables:**

- Jules source detection and adapter;
- normalization, redaction, masking, and safe-parameter engine;
- Jules segmentation;
- Drain wrapper and fingerprint finalizer;
- baseline aggregation, validation, atomic publication, and lookup;
- golden examples and redaction/security tests.

**Exit criteria:** Trusted Jules successes create reproducible baseline versions; untrusted or failed events cannot publish; schema and secret release gates pass.

> **Developer clarification required:** Confirm whether a Jules-only internal milestone is acceptable. Production release should not claim Lattice support until Milestone 3 passes.

### Milestone 3 — Lattice offline learning

**Goal:** Add correct DAG-node learning without merging interleaved output.

**Deliverables:**

- Lattice source detection and adapter;
- node/attempt lifecycle and logical-order tracking;
- noncontiguous segment ranges;
- Lattice-specific templates, counts, sequences, and test fixtures;
- heavily interleaved load and correctness tests.

**Exit criteria:** Lattice node-local statistics are reproducible and no unrelated node output contaminates a segment.

### Milestone 4 — Failed Pass 1 and LogDiff

**Goal:** Produce a correct failed-run summary and explain what changed.

**Deliverables:**

- analysis-manifest pinning;
- private run-local failed parser and final catalog;
- Aho–Corasick keyword path and safe bounded expressions;
- direct candidate expansion with per-segment ring buffers;
- source-aware tail handling;
- LogDiff compatibility, new/missing/frequency/scope/sequence/severity/parameter checks;
- selector and missing-template output.

**Exit criteria:** Labelled synthetic failures produce correct diff reasons; failed parsing never changes the baseline; no intermediate fingerprints are compared.

### Milestone 5 — Frozen replay, candidate pool, and expansion

**Goal:** Locate all remaining selected occurrences with bounded memory and exact provenance.

**Deliverables:**

- read-only finalized replay matcher;
- deterministic replay-count validation;
- analysis-isolated candidate pool;
- Jules and Lattice ring-buffer expansion;
- fragment overlap merging, stack/multiline boundaries, and partial handling;
- concurrency, retry, cancellation, and chunk-boundary tests.

**Exit criteria:** Replay matches Pass 1 counts for supported cases; labelled context is recovered; interleaved Lattice contamination stays within the approved target.

### Milestone 6 — Evidence pipeline and bounded model input

**Goal:** Convert candidate context into a compact, explainable model request.

**Deliverables:**

- block construction and deduplication;
- error classification, confidence, and P0–P4 priority;
- provisional novelty/severity/proximity score;
- diversity and required-evidence selection;
- tokenizer-based budgeting and safe compaction;
- evidence pack, model-input contract, model gateway, and claim validator;
- worked end-to-end Jules and Lattice examples.

**Exit criteria:** Evidence precision/recall gates pass on the initial evaluation set; every selected block has exact provenance; model requests fit their budget and unsupported claims are marked.

### Milestone 7 — Optional thin-index experiment

**Goal:** Decide whether the thin index improves very large or repeatedly analysed logs.

**Deliverables:**

- versioned binary thin-index prototype;
- cluster dictionary and segment/logical postings;
- targeted range-read expansion;
- replay-equivalence tests;
- cold/warm performance and cost benchmark;
- measured threshold policy or a documented decision not to ship it.

**Exit criteria:** The index is enabled only if it beats replay for an approved workload without reducing correctness. Otherwise, frozen replay remains the only production strategy.

### Milestone 8 — Production hardening and controlled rollout

**Goal:** Make Phase 1 and Phase 2 safe to operate at expected scale.

**Deliverables:**

- production stores and lifecycle policies;
- dashboards, alerts, runbooks, dead-letter handling, and support ownership;
- security review and deletion tests;
- load, chaos, fairness, and multi-tenant isolation tests;
- shadow mode, repository allow-list, limited rollout, and rollback;
- per-analysis cost records and budgets.

**Exit criteria:** All Gate D questions are approved, release gates pass, on-call owners accept runbooks, and rollback is tested.

### Milestone 9 — Phase 3 retrieval

**Goal:** Add permission-aware knowledge and commit-matched code context after the evidence pack is trusted.

**Deliverables:**

- approved Phase 3 contracts;
- knowledge and code ingestion;
- exact, vector, and graph retrieval;
- permission/repository/commit filters;
- merge, rerank, diversity, and retrieval budgeting;
- citations, freshness/trust handling, and validated-feedback workflow;
- retrieval and grounded-diagnosis evaluation.

**Exit criteria:** Wrong-tenant, unauthorized, and wrong-commit results are blocked; required sources meet retrieval targets; every diagnosis claim remains cited.

## 12. Testing plan

### 12.1 Contract tests

- Real Jules and Lattice events validate against the approved schemas.
- Each source record maps to the expected canonical event.
- Log object version, checksum, compression, range reads, and byte spaces are verified.
- Old processing configurations remain loadable for their retention period.

### 12.2 Unit and property tests

- Rule priority, overlap, determinism, and safety.
- Chunk-size independence and UTF-8 boundaries.
- Segment identity and logical position.
- Fingerprint input and collision-integrity handling.
- LogDiff calculations and thresholds.
- Occurrence, fragment, and block identities.
- Score calculations, token counts, and deterministic ordering.

### 12.3 Golden end-to-end tests

For each fixture, store:

```text
terminal event
raw log
canonical events
protected events
segments
templates and fingerprints
success baseline or failed summary
LogDiff
candidates
fragments
blocks
classifications and scores
evidence pack
expected supported claims
```

Golden outputs should be reviewed when a schema or rule version changes. They must not be updated automatically simply to make a failing test pass.

### 12.4 Security tests

- Seed secrets in headers, URLs, split lines, stack traces, JSON, environment output, and multiline values.
- Verify that secrets do not reach baselines, candidates, fragments, blocks, metrics, traces, model input, or Phase 3 indexes.
- Test tenant, repository, commit, and raw-log authorization failures.
- Test deletion and retention propagation.

### 12.5 Determinism and replay tests

- Reprocess one immutable log with different chunk sizes and worker restarts.
- Verify final templates, fingerprints, segment IDs, logical positions, and candidate pointers.
- Compare Pass 1 selector counts with frozen replay.
- Compare frozen replay output with thin-index output.
- Confirm that retries and checkpoint overlap do not duplicate logical outputs.

### 12.6 Accuracy evaluation

Measure at least:

- source-detection accuracy and `UNKNOWN` rate;
- segmentation accuracy;
- template grouping precision and recall;
- LogDiff recall by reason;
- candidate recall;
- expansion coverage and contamination;
- evidence precision and recall;
- deduplication preservation;
- classification precision, recall, and confidence calibration;
- priority agreement;
- top-block accuracy;
- claim support rate;
- later, retrieval recall and grounded diagnosis quality.

### 12.7 Performance and reliability tests

- Small, medium, and five-million-line logs.
- Sequential Jules and highly interleaved Lattice runs.
- Warm and cold storage caches.
- One huge analysis alongside many small analyses.
- Tenant and global concurrency limits.
- Slow storage, writer backpressure, worker loss, expired leases, cancellation, and partial uploads.
- Replay versus thin-index CPU, memory, bytes read/written, storage, and latency.

## 13. Observability and cost

### 13.1 Required metrics

- accepted, rejected, duplicate, and dead-letter events;
- learning and analysis state-transition counts;
- source-detection result and confidence;
- raw bytes read by pass and strategy;
- events, segments, clusters, fingerprints, selectors, candidates, fragments, and blocks;
- redaction failures and rule-hit counts without sensitive values;
- active segments, open fragments, queue depth, worker memory, and backpressure time;
- replay count mismatch and partial-result reasons;
- evidence tokens selected, omitted, and sent;
- model and retrieval latency, tokens, errors, and cost;
- thin-index bytes, retention, reads, and cleanup results;
- p50, p95, and p99 end-to-end latency and cost.

### 13.2 Tracing

Every trace should carry safe forms of `event_id`, `run_id`, `analysis_id`, ownership partition, source type, component stage, and configuration version. Raw log lines, secrets, URLs with credentials, and high-cardinality private values must not be trace attributes.

### 13.3 Cost records

Each analysis emits measured raw/compressed bytes, bytes per pass, index bytes, worker seconds, peak memory, derived bytes, token use, retrieval requests, retries, partial state, and retention class. Cost rates remain outside the architecture so provider prices can change without changing artifacts.

## 14. Rollout and migration

1. Start with synthetic and approved replay data.
2. Run offline learning in shadow mode without updating the authoritative baseline pointer.
3. Compare proposed baselines with engineer-reviewed outputs.
4. Enable learning for an allow-list of repositories.
5. Run failure analysis in shadow mode and compare its evidence with labelled investigations.
6. Expose the evidence pack before enabling model diagnosis.
7. Enable model diagnosis for an allow-list with required uncertainty and citations.
8. Keep automated code changes, pipeline reruns, and tool execution out of scope until a separate approval workflow exists.
9. Introduce Phase 3 only after Phase 2 evidence gates are stable.

Every rollout step must have a rollback that selects the previous configuration and baseline pointer without deleting current artifacts.

## 15. Team ownership

The exact team names are not defined. Before implementation, assign one accountable owner for each area:

| Area | Owner needed for |
|---|---|
| Jules integration | Event contract, source markers, stages, attempts, samples |
| Lattice integration | Event contract, nodes, dependencies, ordering, samples |
| Security | Redaction policy, raw-log access, audit, model data controls |
| Platform | Event receiver, queues, workers, metadata, object storage, lifecycle |
| Log intelligence | Drain, fingerprints, summaries, LogDiff, expansion, deduplication |
| Diagnostic policy | Error taxonomy, priority, scoring, evaluation labels |
| Model platform | Tokenizer, model gateway, structured response, usage and safety |
| Phase 3 knowledge | Documents, repositories, permissions, indexes, feedback validation |
| SRE/operations | SLOs, capacity, alerts, runbooks, incident response |

> **Developer clarification required — Gate D:** Provide the actual owner for each row and the approval path for cross-team contract changes.

## 16. Definition of done

Phase 1 and Phase 2 are complete only when:

1. Gate A through Gate D decisions are approved and versioned.
2. Jules and Lattice contract tests use representative real samples.
3. Only eligible trusted successes can publish an atomic baseline.
4. Failed analysis pins the complete configuration and immutable raw object.
5. Pass 1 finalizes fingerprints only after freezing its private parser.
6. Replay is read-only and consistency mismatches are visible.
7. Candidate state is isolated by `analysis_id`.
8. Large logs are processed with bounded memory.
9. Lattice expansion does not mix unrelated nodes.
10. Every evidence block has exact provenance, classification, priority, score, and explanations.
11. Token selection uses the exact target tokenizer and records omissions.
12. Every important model claim cites evidence or is marked uncertain.
13. Security, deletion, isolation, determinism, accuracy, performance, and cost gates pass.
14. Monitoring, alerts, runbooks, ownership, rollback, and retention are in place.
15. Examples and documentation match the implemented schema versions.

Phase 3 is complete only when Gate E is approved and permission, commit compatibility, provenance, retrieval quality, and validated-feedback gates also pass.

## 17. Clarification register

The implementation lead should keep this table current. A question is closed only when its decision has an owner, date, version, tests, and affected artifact updates.

| ID | Gate | Clarification needed | Blocks |
|---|---|---|---|
| CLR-001 | A | Actual terminal-event schema, authentication, delivery, retry, and completion guarantee | Event receiver |
| CLR-002 | A | Raw-log API, immutability, chunks, compression, offsets, checksums, range reads | Reader and provenance |
| CLR-003 | A | Jules source markers, stages, attempts, lifecycle, ordering, multiline behaviour | Jules adapter and segmentation |
| CLR-004 | A | Lattice source markers, nodes, dependencies, attempts, lifecycle, logical ordering, interleaving | Lattice adapter and segmentation |
| CLR-005 | A | Canonical event required/optional fields and source extensions | All processing |
| CLR-006 | B | Trusted branches, branch classes, fallback, learning disablement | Eligibility and baseline selection |
| CLR-007 | B | Configuration store, approval, rollback, and old-version retention | Deterministic processing |
| CLR-008 | B | Secret classes, safe parameters, masking exceptions, rule owners | Preprocessing and security |
| CLR-009 | B | Drain library, settings, tokenizer, serialization, tie-breaking, limits | Templates and replay |
| CLR-010 | B | Baseline minimum samples, rolling window, retention, publication and rollback | Baseline builder |
| CLR-011 | B | Object, artifact, metadata, candidate, and configuration stores | Persistence layer |
| CLR-012 | C | Workflow engine, queues, leases, retries, timeouts, cancellation, partial results | Failure orchestrator |
| CLR-013 | C | Keyword, expression, tail, sampling, and direct-expansion policies | Pass 1 |
| CLR-014 | C | LogDiff thresholds, sequence policy, parameter tests, selector limits | LogDiff |
| CLR-015 | C | Replay mismatch tolerance and response | Pass 2 correctness |
| CLR-016 | C | Thin-index threshold, binary schema, storage, size, retention | Optional index |
| CLR-017 | C | Candidate store, TTL, caps, consistency, and record update model | Candidate pool |
| CLR-018 | C | Expansion windows, boundaries, correlation, low-confidence fallback | Content expansion |
| CLR-019 | C | Block limits and deduplication thresholds | Evidence blocks |
| CLR-020 | C | Error taxonomy, confidence, priorities, review, fallback classifier | Classification |
| CLR-021 | C | Novelty/severity/proximity mappings, required evidence, tie-breaking | Scoring |
| CLR-022 | C | Target model, tokenizer, token reservations, request and response schemas | Model input |
| CLR-023 | D | Concurrency, log distribution, SLOs, resources, deployment, autoscaling | Capacity plan |
| CLR-024 | D | Encryption, regional controls, retention, deletion, audit, incident response | Production security |
| CLR-025 | D | Component owners, on-call, dashboards, alerts, runbooks, budgets | Operations |
| CLR-026 | D | Accuracy release targets and approved evaluation dataset | Production release |
| CLR-027 | E | Enabled knowledge sources, owners, permissions, trust, freshness | Phase 3 ingestion |
| CLR-028 | E | Exact index, vector store, embedding model, code graph, repository access | Phase 3 storage |
| CLR-029 | E | Commit fallback, retrieval weights, reranking, quotas, token budget | Phase 3 retrieval |
| CLR-030 | E | Confirmed-RCA and fix validation workflow | Phase 3 feedback |
| CLR-031 | A | Implementation language, repository path, package layout, schema library, dependency injection, async model | File-level design |
| CLR-032 | B | Mergeable numeric sketch, error bound, enum cardinality, minimum statistical samples | Safe-value statistics |
| CLR-033 | C | Sequence-diff algorithm and maximum sequence/anchor limits | Sequence comparison |
| CLR-034 | C | Whether near-duplicate detection is needed in release one and, if so, its guarded similarity method | Deduplication |
| CLR-035 | C | Token-efficiency calculation, diversity penalty, quotas, and required-block policy | Evidence selection |
| CLR-036 | C | Exact service inputs, outputs, error codes, retry classes, and artifact ownership approval | Public component contracts |

## 18. Immediate next actions

1. Send CLR-001 through CLR-005 to the Jules, Lattice, and log-storage integration owners.
2. Collect representative successful, failed, incomplete, retried, and interleaved logs with approved handling.
3. Hold a contract review and approve `pipeline-event/v1`, `canonical-event/v1`, and `raw-log-manifest/v1` before adapter implementation.
4. Choose the implementation language, repository/module location, schema tooling, and test framework.
5. Create Milestone 0 contract fixtures and make them mandatory in continuous integration.
6. Resolve Gate B decisions before allowing any baseline publication.
7. Convert the milestone deliverables into team-owned work items only after dependencies and owners are known.

### 18.1 Design-review approval checklist

Do not create the proposed production package until reviewers approve the following:

- the implementation language and real repository location;
- the Jules and Lattice terminal-event, envelope, lifecycle, attempt, and ordering contracts;
- the raw-log immutability, compression, range-read, checksum, and offset contract;
- the canonical event and provenance fields;
- the module boundaries and dependency rules in Section 6.23;
- every service operation's input, output, side effects, error, and retry behaviour;
- the Drain library, tokenizer, configuration, state serialization, finalization, and frozen-matching rules;
- the baseline key, branch-class statistics, compatibility checks, and fallback policy;
- the Pass 1, LogDiff, frozen replay, direct-expansion, and candidate-pool algorithms;
- whether the temporary thin index is enabled only by a measured policy;
- the deduplication, error classification, priority, scoring, and token-budget policies;
- storage, queue/workflow, lease, checkpoint, retention, deletion, and tenant-isolation choices;
- the accuracy, determinism, security, concurrency, performance, and cost test gates;
- Phase 3 scope, permissions, code-commit compatibility, and validated-feedback workflow.

Approval should be recorded as a short design-decision record containing the selected choice, alternatives considered, reason, owner, date, affected contracts, and rollback or migration impact. After approval, this plan can be converted into implementation work items in dependency order. Until then, all file names, thresholds, algorithms marked proposed, and infrastructure choices remain review material.

> **Developer clarification required now:** Which programming language and framework will implement Logsift, where will the production modules live, which stores and queue/workflow system are already available, and who owns the Jules and Lattice contracts? These answers are required before the plan can be converted into file-level engineering tasks and delivery dates.
