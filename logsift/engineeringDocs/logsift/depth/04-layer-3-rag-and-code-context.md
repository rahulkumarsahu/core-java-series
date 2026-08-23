# Logsift Layer 3: RAG and code context

[Problem and architecture](01-problem-and-architecture.md) · [Offline learning](02-offline-learning-flow.md) · [Failure analysis](03-failure-analysis-flow.md)

The repository defines the direction of this layer—use reduced failure evidence to retrieve useful operational knowledge—but it does not define a production Layer 3 schema, index, code parser, permission model, or query service. Everything labelled **Recommended design** in this document fills that gap. It is not a claim about current Logsift behavior.

## Purpose

[The failure-analysis flow](03-failure-analysis-flow.md) produces an evidence pack that can support the statement, “This log message is suspicious.” Layer 3 tries to add the context needed to say, “This component probably failed for this reason, and these files, owners, runbooks, or previous fixes are relevant.”

RAG means retrieval-augmented generation. Before a language model writes an explanation, Logsift searches trusted knowledge and code for material related to the failure. The retrieved passages are attached to the evidence pack with provenance. The model reasons over that bounded context instead of relying only on general memory.

An **embedding** is a numeric vector representing aspects of meaning. Similar vectors can help find text that discusses the same concept using different words. A **vector database** indexes those vectors and their metadata. It is useful, but it is only one retrieval component: exact error strings, symbol names, repository versions, dependency relationships, permissions, and source trust often matter more than semantic similarity alone.

The evidence pack remains authoritative for what happened in the current run. Retrieved material can explain or connect that evidence; it cannot overwrite it.

## Recommended design: knowledge sources

Every ingested item records its origin, owner, freshness, permission scope, validation state, and content digest. Different source types deserve different trust defaults.

| Source | What it contributes | Trust and freshness | Permission and quality controls |
|---|---|---|---|
| Runbooks | Approved diagnostic and recovery steps | High when owned, reviewed, and within review date | Require section provenance, owner, approval status, and service scope |
| Service documentation | Interfaces, dependencies, limits, and operating assumptions | Medium to high; decay when deployments or ownership change | Index only accessible sections; retain last-reviewed time |
| Architecture documentation | Component boundaries and dependency intent | Medium; useful even when not code-current, but label age | Require repository or service association and status such as current, proposed, or retired |
| Previous incidents | Symptoms, timelines, evidence, and outcomes | Medium until root cause is confirmed | Separate initial hypotheses from confirmed findings |
| Confirmed root causes | Validated causal explanations | High within compatible component and version scope | Require reviewer, evidence links, affected versions, and validation state |
| Fixes and patches | Concrete changes known to address a failure | High only when linked to a confirmed fix and deployed outcome | Store repository, commit range, tests, rollout result, and rollback information |
| Deployment metadata | What version, configuration, and environment was active | High for compatibility filtering | Access controlled; immutable event history preferred |
| Ownership information | Responsible service, component, and escalation path | High if synchronized from the ownership authority | Freshness is critical; hide restricted contacts from unauthorized users |
| Pipeline definitions | Stages, DAG nodes, commands, inputs, and dependencies | High when taken from the same commit as the run | Store repository, path, branch, commit, and parsed structure |
| Configuration files | Limits, endpoints, feature switches, and runtime behavior | High when commit and environment match | Redact secrets before indexing; distinguish defaults from deployed values |
| Source code | Likely failing symbols and execution paths | High only at the run's repository and commit | Enforce repository permissions and exact file/line provenance |
| Test code | Assertions, fixtures, and expected behavior | High for named failed tests at the matching commit | Link test symbol to production symbols and pipeline scope |
| Commit history, when permitted | Recent changes, intent, and ownership clues | Variable; commit messages are claims, not proof | Respect history permissions and exclude sensitive author data unless required |
| Successful and failed run summaries | Similar symptoms, frequencies, and prior outcomes | Medium; success summaries establish behavior, failed summaries need labels | Index protected summaries, not unrestricted raw logs; confirmed outcomes rank above guesses |

Freshness is source-specific. A five-year-old architectural invariant may remain valid; a week-old ownership record can already be stale. The policy should combine age with review status, deployment compatibility, and source type rather than applying one universal time cutoff.

> **Image-generation prompt — Knowledge and code ingestion**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 ingestion diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, teal for upstream Logsift evidence and pipeline metadata, orange only for failed-run summaries, purple for retrieval and remediation, and yellow sticky notes only for key insights. On the left, group document icons into “Operational knowledge” with short labels “Runbooks,” “Service docs,” “Architecture,” “Incidents,” “Confirmed fixes,” “Deployments,” and “Ownership.” Below, group code icons into “Repository snapshot” with “Pipeline definitions,” “Configuration,” “Source,” “Tests,” and “Permitted history.” Draw both groups through purple boxes in this exact order: “Permission check,” “Secret scan + redact,” “Parse + chunk,” “Attach trust + freshness,” and “Version + content digest.” Fan out on the right to four distinct stores: a document cylinder “Secure content store,” a magnifying-glass index “Lexical index,” a vector-grid cylinder “Semantic index,” and a node-link cylinder “Symbol + dependency graph.” Show repository, branch, and commit tags attached to every code arrow. Add a teal document “Evidence-pack metadata” pointing only to metadata association, not into content rewriting. Add yellow sticky notes “Index only what the caller may retrieve” and “Confirmed is different from suspected.” Include a compact legend mapping teal to offline evidence, orange to failure analysis, purple to retrieval/remediation, solid arrows to content flow, and dotted arrows to metadata links. Use simple arrows, document icons, storage cylinders, filters, shields, and magnifying glasses. Keep labels short and legible and include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and every ingestion arrow direction.

## Recommended design: codebase representation

Code is not ordinary prose. A fixed window can split a function from its signature, join unrelated symbols, or omit the caller that explains why the function ran. Structural representations help, but no single representation answers every query.

| Representation | Strength | Limitation | Recommended role |
|---|---|---|---|
| Fixed-size text chunks | Works for any text and is simple to index | Splits symbols and mixes unrelated code | Safe fallback for unsupported languages and very large non-code files |
| Function- and class-aware chunks | Keeps meaningful units intact | Needs a reliable language parser | Primary unit for code retrieval |
| Abstract syntax tree metadata | Captures language constructs while omitting some surface syntax | Loses comments or formatting that may carry operational meaning | Extract symbol kind, calls, imports, literals, and control features |
| Concrete or lossless syntax tree | Preserves source structure and exact token spans | Large and awkward as a direct retrieval payload | Derive exact ranges and support incremental re-indexing |
| Symbol graph | Links definitions, references, overrides, and tests | Quality varies by language and build context | Expand from an error symbol to related code |
| Call graph | Connects callers and callees | Static calls can be incomplete in dynamic code | Bounded structural expansion and reranking signal |
| Import and dependency graph | Connects files, modules, packages, and services | An import does not prove runtime causality | Find configuration, adapters, and likely blast radius |
| Language-server-derived symbols | Provides editor-grade definitions and references | Requires language tooling and sometimes a successful project load | Enrich symbol identity and cross-file references when available |

The practical hybrid is:

- symbol-aware code chunks for functions, methods, classes, modules, tests, configuration sections, and pipeline steps;
- embeddings for symbol chunks and concise file or module summaries;
- an exact lexical index over source text, symbol names, error literals, configuration keys, and paths;
- AST or lossless-parser metadata for symbol type, source range, calls, imports, annotations, and literals;
- a repository graph containing definitions, references, calls, imports, tests, ownership, pipeline relationships, and dependency edges;
- commit-aware immutable snapshots with incremental indexing between commits; and
- exact links back to repository, branch, commit SHA, file path, and one-based line ranges.

Storing only a raw syntax tree in a vector database is not sufficient. Tree nodes are too small or too syntactic to be useful passages, exact strings are weakened by semantic embeddings, and graph relationships are cumbersome to recover from nearest-neighbor search. The tree should produce metadata and chunk boundaries; lexical, semantic, and graph indexes should each do the job they are best at.

Unsupported languages fall back safely to file-type-aware text chunks with line boundaries, nearby headings or delimiters, exact lexical indexing, and `parse_quality: fallback`. They do not receive fabricated symbols or graph edges.

Every code record stores tenant, repository, branch, and commit SHA. Repository prevents cross-project contamination. Commit SHA prevents a failed run at one revision from receiving a function body introduced later or deleted earlier. Branch helps explain intended lineage and allows an explicit fallback when an exact snapshot is unavailable. A fallback to another commit must be bounded, relationship-aware, and visibly labelled; security fixes and configuration changes make silent “nearest commit” behavior unsafe.

> **Image-generation prompt — Commit-aware code symbols and dependency graph**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 code-index diagram on a clean white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, purple for retrieval and remediation, teal for matching run metadata, orange only for one suspicious log signal, and yellow sticky notes only for key insights. At left, show a repository snapshot card tagged “repository,” “branch,” and “commit SHA,” containing short file strips for source, tests, configuration, and pipeline definition. Draw them through a “Language parser” box into symbol cards “Function,” “Class,” “Test,” “Config section,” and “Pipeline step,” each with exact file and line tags. In the center, draw a purple graph with clearly labelled edge types “calls,” “imports,” “tests,” “configured by,” “runs in,” and “owned by.” Beneath it, draw separate “Lexical index” and “Symbol embeddings” stores; do not put the entire graph inside the vector store. At right, show an orange suspicious error string locating one function through exact search, then bounded graph traversal to a caller, a test, and a configuration section. Above the result, place a teal run tag with the same repository and commit and a filter icon marked “must match.” Draw a second, different commit snapshot faded and blocked by a stop symbol. Add yellow sticky notes “Structure creates links; chunks carry context” and “Never mix code versions silently.” Include a compact legend for teal offline/run metadata, orange failure signals, purple retrieval/remediation, solid arrows for exact links, and dotted arrows for semantic similarity. Use simple arrows, code document icons, filters, magnifying glasses, and node-link shapes. Keep labels short and legible, and include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, commit filters, graph labels, and arrow direction.

## Chunking and indexing

### Documents

Semantic document chunking follows the author's structure: heading, paragraph group, numbered procedure, table, or incident-timeline segment. A chunk should be understandable without the entire file. It carries its heading path and a parent summary. Small overlap can repeat a few boundary sentences when a concept spans sections, but overlap is not a substitute for meaningful boundaries.

### Code

Code chunks follow symbols. A small function is one chunk. A large class has a parent summary and child method chunks. A long function splits at language-aware blocks while retaining the signature and parent symbol. Comments and docstrings stay with the symbol they describe. Imports and file-level declarations become a compact file-context parent rather than being copied into every child.

Stable chunk IDs derive from tenant, source identity, repository and commit where applicable, normalized path or document ID, symbol identity or heading path, chunk kind, and chunking version. Content digest is separate: the stable identity says what logical unit this is; the digest says whether its content changed.

Incremental indexing compares repository changes or document digests. Unchanged chunks reuse existing embeddings under the same embedding-model version. Changed chunks create new immutable records for the new snapshot. Deleted or inaccessible chunks receive tombstones and disappear from active indexes before old storage is reclaimed. An embedding-model change creates a parallel index generation; traffic moves only after coverage and quality validation.

Metadata filters always precede or constrain retrieval: tenant, permissions, repository, commit, service, pipeline, environment, source type, validation status, and time. Multi-tenant isolation exists in authorization and storage partitions, not merely as a post-search filter.

### Proposed knowledge-chunk schema

```json
{
  "chunk_schema": "knowledge-chunk/v1",
  "chunk_id": "stable-logical-id",
  "content_digest": "digest",
  "tenant_id": "tenant-example",
  "source_type": "runbook",
  "source_ref": "secure-document-reference",
  "heading_path": ["Payment service", "Timeout recovery"],
  "parent_chunk_id": "parent-id",
  "content_ref": "secure-content-reference",
  "embedding_ref": "embedding-record-reference",
  "services": ["payment-service"],
  "pipelines": ["verify-service"],
  "permission_labels": ["engineering"],
  "trust": {"weight": 0.95, "validation": "approved", "reviewed_at": "2026-07-10T00:00:00Z"},
  "valid_time": {"from": "2026-07-10T00:00:00Z", "to": null},
  "index_versions": {"chunker": "doc-v1", "embedding": "embed-v1"}
}
```

### Proposed code-symbol chunk schema

```json
{
  "chunk_schema": "code-symbol/v1",
  "chunk_id": "stable-symbol-at-snapshot-id",
  "tenant_id": "tenant-example",
  "repository_id": "repo-example",
  "branch": "main",
  "commit_sha": "8f13b7c...",
  "path": "src/payments/client.py",
  "language": "python",
  "symbol": {"id": "module.client/capture", "name": "capture", "kind": "function"},
  "range": {"line_start": 84, "line_end": 129, "byte_start": 2912, "byte_end": 4630},
  "parent_chunk_id": "file-summary-id",
  "content_ref": "secure-source-reference",
  "content_digest": "digest",
  "lexical_terms": ["TimeoutError", "payment_api", "retry_limit"],
  "graph_node_id": "symbol-node-id",
  "parse_quality": "language_parser",
  "permission_labels": ["repo-read"],
  "index_versions": {"parser": "python-v1", "chunker": "code-v1", "embedding": "embed-v1"}
}
```

### Proposed incident-record schema

```json
{
  "record_schema": "incident/v1",
  "incident_id": "incident-example-17",
  "tenant_id": "tenant-example",
  "services": ["payment-service"],
  "symptoms": ["payment_api timeout", "worker exit 1"],
  "template_fingerprints": ["fp-v1:9c14..."],
  "affected_versions": {"from": "commit-a", "to": "commit-c"},
  "hypotheses": [{"text_ref": "secure-reference", "status": "rejected"}],
  "confirmed_root_cause_ref": "secure-reference",
  "evidence_refs": ["evidence-pack-reference"],
  "validation": {"status": "confirmed", "reviewer_role": "incident-owner", "confirmed_at": "2026-06-12T00:00:00Z"},
  "permission_labels": ["engineering"]
}
```

### Proposed confirmed-fix schema

```json
{
  "record_schema": "confirmed-fix/v1",
  "fix_id": "fix-example-17",
  "tenant_id": "tenant-example",
  "incident_id": "incident-example-17",
  "repository_id": "repo-example",
  "change_commit": "commit-c",
  "affected_commit_range": {"from": "commit-a", "to": "commit-b"},
  "changed_symbols": ["module.client/capture"],
  "changed_config_keys": ["payment.retry_limit"],
  "patch_ref": "secure-patch-reference",
  "verification_refs": ["test-run-reference", "deployment-result-reference"],
  "validation": {"status": "confirmed_effective", "confirmed_at": "2026-06-13T00:00:00Z"},
  "permission_labels": ["repo-read", "engineering"]
}
```

## Retrieval flow

At query time, Logsift performs the following recommended sequence:

1. Extract exact error strings, exception types, failed test names, template fingerprints, preserved parameters, stages or DAG nodes, services, repository, branch, commit, and dependency signals from the evidence pack.
2. Build separate lexical, semantic, and structural queries. Do not flatten every signal into one prose question.
3. Apply tenant, permission, repository, commit, service, pipeline, stage, environment, validation, and time filters.
4. Run keyword retrieval over exact error text, symbol names, configuration keys, paths, and template fingerprints. BM25 is a term-ranking method that rewards distinctive matching words while controlling for document length and common terms.
5. Run vector retrieval for semantically similar runbook sections, incidents, and symbol summaries.
6. Traverse a bounded number of graph edges from matched symbols, tests, pipeline steps, configuration sections, owners, and dependencies.
7. Merge candidates from all channels using normalized ranks and source-specific weights.
8. Rerank the merged set with the full query, source trust, freshness, commit compatibility, and evidence relationships.
9. Remove redundant passages while preserving distinct sources and conflicting validated evidence.
10. Fit the results into a retrieval budget separate from the log-evidence budget, honoring per-source quotas and structural integrity.
11. Assemble content, confidence, compatibility notes, and exact provenance for the model.

Exact error strings and template fingerprints are high-precision anchors. BM25 or keyword search finds them even when an embedding treats punctuation or identifiers as unimportant. Vector similarity recovers conceptually related material phrased differently. Metadata filters prevent irrelevant or unauthorized matches. Graph traversal connects an error literal to its containing function, caller, test, configuration, pipeline step, and owner. Reranking considers all these signals together. Diversity-aware selection prevents ten near-identical incident summaries from crowding out current code and a runbook.

> **Image-generation prompt — Hybrid retrieval and reranking**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 retrieval-flow diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for the incoming failure evidence, purple for retrieval and remediation, teal only for trusted baseline metadata, and yellow sticky notes only for key insights. At left, draw an orange document “Evidence pack” with short extracted signals “exact error,” “template fingerprint,” “failed test,” “service,” “stage or node,” “repository,” and “commit.” Feed these into a purple “Query builder” that splits into three parallel lanes: “Lexical — exact strings + BM25” with a magnifying glass, “Semantic — embeddings” with a vector-grid icon, and “Structural — symbols + dependencies” with a node-link graph. Before all three lanes, draw one large filter gate labelled “Tenant + permissions + repository + commit + service + time.” Merge the three lanes into “Rank fusion,” then “Rerank by relevance + trust + freshness + compatibility,” then “Remove redundancy + add diversity,” then a purple document “Retrieved context with provenance.” Add small result cards for runbook, incident, code symbol, configuration, and owner. Draw a blocked candidate from the wrong commit and another blocked by permissions. Add yellow sticky notes “Exact and semantic search solve different problems” and “The vector index is one component.” Include a compact legend for teal offline metadata, orange failure analysis, purple retrieval/remediation, solid arrows for selected results, and crossed dotted arrows for rejected candidates. Use simple arrows, document icons, filters, storage cylinders, magnifying glasses, and node-link shapes. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, filter placement, merge order, and every arrow direction.

### Realistic end-to-end retrieval example

Suppose the selected failure block says:

```text
TimeoutError waiting for payment_api after <DURATION>
retry budget exhausted
worker exited code=1
```

The evidence pack identifies the failed Jules `test` stage, repository `repo-example`, commit `8f13b7c…`, the timeout fingerprint, a protected request correlation, and a preceding frequency shift in dependency retries.

Lexical retrieval searches the exact exception, `payment_api`, `retry budget`, the template fingerprint, and preserved configuration terms. Semantic retrieval asks for operational guidance about payment-service timeouts and exhausted retries. Structural retrieval starts from a code symbol containing the exception literal, then follows its configuration and test edges. Commit and permission filters apply before results can enter the merged set.

The reranked context could contain:

- a runbook section, “Payment dependency timeout,” with a step to verify upstream latency before increasing retry limits;
- a confirmed incident in which a pool-size reduction caused the same timeout and fingerprint sequence;
- `capture()` in `src/payments/client.py` at the exact failing commit, where retry exhaustion raises the exception;
- `config/payment.yaml`, whose `payment.retry_limit` and connection-pool settings feed that symbol;
- ownership metadata for the payment-service component, its owning team, and its current escalation path; and
- a confirmed fix showing that restoring the pool setting and adding a saturation test resolved the earlier incident.

A plausible remediation path is then: verify the deployed pool configuration against the commit-matched definition, inspect upstream latency using the runbook, and, only if the configuration regression is confirmed, restore the reviewed value and run the named saturation test. Logsift should present this as a ranked hypothesis with cited evidence, not as an automatic conclusion. If the earlier incident affected a different commit range or environment, it becomes a weaker analogy rather than a confirmed match.

## Vector database design

The vector database stores embedding vectors and the metadata required to filter, authorize, version, and trace them. Depending on the security model, it may also store redacted chunk content; otherwise it stores a secure content reference resolved only after authorization.

At minimum, each vector record includes chunk ID, embedding-model version, content digest, tenant and access-control fields, source type, parent-child relationships, service and pipeline identifiers, timestamps, trust and validation status, and a deletion or retention state. Code vectors also require repository, branch, commit SHA, path, symbol, language, and exact source range.

The vector database should not be the only copy of source truth, the permission authority, the repository graph, the exact lexical index, the raw-log store, or the incident workflow system. Deletes begin at the authority: revoke active retrieval, tombstone index records, remove vectors and cached content, then verify deletion across generations and backups according to policy.

## Retrieval token budget and context assembly

Layer 2 reserves a separate retrieval budget. Layer 3 divides it among operational knowledge, incidents and fixes, code, configuration or pipeline definitions, and provenance overhead. Per-source quotas keep code from displacing the runbook or ten incidents from displacing current configuration. Parent summaries can represent several child chunks cheaply; a selected child includes the minimum parent context needed to understand it.

Selection uses the target model's tokenizer. Code is cut only at symbol-aware boundaries, and a long runbook procedure remains ordered. If a critical record cannot fit, Logsift includes a compact deterministic abstract plus a secure reference and a truncation notice. The final model input distinguishes four namespaces: current-run log evidence, current-version code and configuration, historical or operational knowledge, and system instructions. Retrieved text is untrusted data, not executable instruction.

> **Image-generation prompt — Context assembly with provenance**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 context-assembly diagram on a clean white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for current failure evidence, purple for retrieval and remediation, teal for compatible run and baseline metadata, and yellow sticky notes only for key insights. On the left, show five ranked cards: “Current log evidence,” “Runbook,” “Confirmed incident,” “Commit-matched code,” and “Configuration + owner.” Give every card a small provenance tag with source, version or commit, exact location, permission, trust, and freshness. In the center, draw a segmented purple token-budget ruler with quotas “Knowledge,” “Incidents + fixes,” “Code,” “Configuration,” and “Provenance,” plus a safety margin. Show a redundancy filter, parent-child chunk selector, and safe-boundary scissors. On the right, draw one structured document “Model context” with four clearly separated sections in this order: “System instructions,” “Current-run evidence,” “Current-version code + config,” and “Historical + operational knowledge.” Then draw an arrow to “Grounded RCA + remediation,” with citation arrows back to the five source cards. Add a stop symbol showing that retrieved text cannot enter the system-instruction section. Add yellow sticky notes “Current logs remain authoritative” and “Every claim needs a source path.” Include a compact legend for teal offline/run metadata, orange failure analysis, purple retrieval/remediation, solid arrows for included context, and dotted arrows for citations. Use simple arrows, document icons, filters, magnifying glasses, and a token ruler. Keep labels short and legible with no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, section ordering, citation direction, and budget flow.

## Retrieval quality and safety

Permission checks apply at ingestion, candidate generation, content resolution, cache access, and final assembly. A metadata-only search result is still sensitive if it reveals a restricted repository or incident. Tenant isolation must be enforced by the serving identity and storage partition, not by asking the model to ignore unauthorized results.

Secrets are removed before documents, configuration, code comments, incident text, or summaries enter derived indexes. Exact source content is resolved from a secure store only for authorized callers. Raw logs remain outside the knowledge index; evidence packs contain redacted blocks and protected references.

Freshness and conflict are explicit. A stale runbook is not silently discarded if it is the only guidance, but it is labelled and downweighted. Conflicting historical fixes are both retained when each was validated for a different version or environment. Unconfirmed incident hypotheses cannot be promoted into confirmed root-cause or fix records.

Hallucination control relies on structure, not a prompt alone:

- require citations for claims about the current run, code, configuration, ownership, and earlier fixes;
- report repository and commit compatibility for code claims;
- separate observed facts, retrieved facts, and inferred hypotheses;
- report retrieval coverage and important missing sources;
- refuse unsupported exact claims and expose confidence per conclusion;
- keep deterministic template comparison and evidence scoring outside the model; and
- preserve links to exact log, document, incident, and source-code locations.

Evaluation needs a versioned set of failures with confirmed relevant evidence, root causes, code symbols, and acceptable remediation sources. **Recall** asks what fraction of relevant items were retrieved. **Precision** asks what fraction of retrieved items were relevant. Coverage records whether every required source category was available and queried. Ranking measures should also test whether relevant items appear early enough to fit the budget. Evaluation slices should include Jules and Lattice, large logs, missing baselines, different languages, permission boundaries, stale records, and commit changes.

Human feedback is useful only when its meaning is clear. “Helpful” is not the same as “caused the failure.” Engineers should separately confirm evidence relevance, root cause, effective fix, and source correctness. A confirmed RCA enters the knowledge layer only after review, links to its evidence pack and affected versions, records rejected hypotheses, passes secret and permission checks, and produces immutable incident and fix versions. It never updates the successful-log baseline directly.

> **Image-generation prompt — Confirmed RCA feedback loop**
>
> Maintain generous spacing and a clear left-to-right flow. Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses.
> Create a wide 16:9 feedback-loop diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy handwritten headings, orange for failure evidence, purple for retrieval and remediation, teal for the separate success baseline, and yellow sticky notes only for key insights. At left, draw an orange “Evidence pack” feeding a purple “Retrieved context,” then “Engineer review,” then a decision diamond “Root cause and fix confirmed?” Route “No” to “Keep as hypothesis with status.” Route “Yes” through exact purple boxes “Link evidence,” “Record affected versions,” “Secret + permission check,” “Reviewer approval,” and “Publish immutable incident + confirmed fix.” Draw those records into the purple knowledge indexes through “Re-index.” At the top, draw the next failure query retrieving the confirmed records. At the bottom, draw a separate teal storage cylinder “Success baseline” with a bold crossed-out arrow from the confirmed-fix flow and a label “No direct update.” Add yellow sticky notes “Helpful is not confirmed” and “Rejected hypotheses stay labelled.” Include a compact legend for teal offline learning, orange failure analysis, purple retrieval/remediation, solid arrows for approved state changes, and dotted arrows for hypotheses. Use simple arrows, document icons, storage cylinders, filters, shields, and magnifying glasses. Keep labels short and legible and include no tiny paragraphs. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling, approval flow, the crossed-out baseline arrow, and every feedback direction.

## Retrieval policy

[examples/retrieval-policy.yaml](examples/retrieval-policy.yaml) provides a valid, commented example for enabled sources, hybrid weights, commit compatibility, permission gates, freshness, source trust, quotas, and provenance. It is a recommended interface because the repository does not yet define one.

## Document set

Return to [01 — Problem and architecture](01-problem-and-architecture.md), review canonical preprocessing in [02 — Offline learning flow](02-offline-learning-flow.md), or trace evidence construction in [03 — Failure-analysis flow](03-failure-analysis-flow.md).
