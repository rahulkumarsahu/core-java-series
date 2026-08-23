# Logsift RAG and code context

[Architecture](01-problem-and-architecture.md) · [Offline learning](02-offline-learning-flow.md) · [Failure analysis](03-failure-analysis-flow.md)

The repository defines the goal of Layer 3 but not its production implementation. The design below is recommended.

## 1. What RAG means

RAG means **retrieval-augmented generation**.

Without RAG, a model sees the failure evidence and tries to explain it from that evidence and its general knowledge.

With RAG, Logsift first searches trusted internal knowledge and matching code. The model then receives the failure evidence together with the most relevant results.

The change is:

```text
“A timeout is suspicious.”
```

to:

```text
“The timeout came from this function at the failed commit.
This configuration controls its retry limit.
This runbook explains the check.
A confirmed earlier incident had the same cause.”
```

RAG does not replace LogDiff. LogDiff explains what changed in the current run. RAG finds information that helps explain why it changed and what to check next.

## 2. What an embedding and vector database are

An embedding is a list of numbers that represents the meaning of a piece of text or code. Similar meanings usually produce nearby vectors.

For example, these sentences use different words but have similar meaning:

```text
payment request timed out
dependency call exceeded its deadline
```

A vector search may connect them even when exact keyword search does not.

A vector database stores:

- the embedding;
- the record ID;
- metadata used for filtering;
- either safe content or a secure reference to the content.

It is not the complete knowledge system. Exact text search, source documents, permissions, code graphs, version history, and deletion control remain separate parts.

## 3. What Logsift indexes

| Source | Why it helps | Main safety check |
|---|---|---|
| Runbooks | Approved diagnosis and recovery steps | Owner, review date, permissions |
| Service and architecture docs | Component behavior and dependencies | Current, proposed, or retired status |
| Previous incidents | Similar symptoms and investigation history | Separate guesses from confirmed causes |
| Confirmed root causes and fixes | Proven causes and effective changes | Reviewer, affected versions, verification |
| Deployment metadata | Shows what version and configuration ran | Environment and access controls |
| Ownership | Finds the responsible component and team | Freshness and restricted contacts |
| Pipeline definitions | Connects failure scope to commands and dependencies | Repository and commit match |
| Configuration | Explains limits, endpoints, retries, and switches | Secret removal and environment match |
| Source and test code | Finds likely symbols and expected behavior | Repository, commit, and permission match |
| Commit history, when allowed | Shows recent changes and intent | History permission and author-data policy |
| Run summaries | Finds similar successful and failed behavior | Confirmed outcomes rank above guesses |

Do not place unrestricted raw logs in the knowledge index. Layer 2 already provides small redacted blocks and protected source references.

## 4. Build the indexes

Logsift needs three retrieval views because each solves a different problem.

### Exact text index

This index finds exact error strings, exception names, template fingerprints, configuration keys, file paths, test names, and symbols. Keyword scoring such as BM25 gives more weight to rare and useful terms.

### Vector index

This index finds passages with similar meaning. It is useful for runbooks, incidents, documentation, and short summaries of code symbols.

### Relationship graph

This graph stores connections such as:

```text
pipeline step → runs file
test → calls function
function → calls dependency
function → reads configuration
file → owned by team
incident → fixed by commit
```

The graph helps Logsift move from one exact match to nearby useful context.

> **Image-generation prompt — Building the Logsift knowledge layer**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 technical diagram on a clean warm off-white notebook page with a faint square grid and hand-drawn styling. Use purple for retrieval, orange only for incoming failure summaries, teal only for run and repository metadata, dark navy headings, and two yellow sticky notes. At left, group simple document icons for “Runbooks,” “Docs,” “Incidents,” “Confirmed fixes,” “Deployments,” “Ownership,” “Pipeline,” “Configuration,” “Source,” and “Tests.” Pass all sources through “Permission check → Secret removal → Parse → Chunk → Add trust + freshness + version.” At right, fan out to three clearly separate stores: “Exact text index,” “Vector index,” and “Code + dependency graph,” plus one secure content cylinder. Attach “seal_id,” “repo_id,” “branch,” and “commit SHA” tags to code records. Add notes “Index only what the caller may read” and “Confirmed is not the same as suspected.” Use simple arrows, document icons, storage cylinders, filters, shields, and magnifying glasses. Keep generous spacing, short labels, and a clear left-to-right flow. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 5. Represent documents and code

### Documents

Split a document by useful boundaries such as heading, paragraph group, procedure, or incident timeline. Each chunk keeps its heading path and a link to the original document.

### Code

Fixed-size text chunks alone are not enough because they can cut a function in half or join unrelated functions.

| Representation | What it gives Logsift | How to use it |
|---|---|---|
| Fixed-size text | Works for every file type | Fallback for unsupported languages |
| Function or class chunk | Keeps one meaningful symbol together | Main code-retrieval unit |
| Abstract syntax tree metadata | Symbol kind, calls, imports, and literals | Add structure and graph edges |
| Lossless syntax tree metadata | Exact token and byte ranges | Accurate source links and incremental updates |
| Symbol and call graph | Definitions, references, callers, and tests | Bounded relationship traversal |
| Import and dependency graph | Module and package connections | Find related files and configuration |
| Language-server symbols | High-quality definitions and references | Use when language tooling is available |

The recommended design uses all of these in a small hybrid:

- symbol-aware code chunks;
- exact lexical search;
- embeddings for symbols and file summaries;
- parser-derived metadata;
- a repository dependency graph;
- exact file and line links;
- immutable commit snapshots.

Do not store only a raw syntax tree in the vector database. A tree is useful for finding boundaries and relationships, but it is not a readable evidence passage.

For an unsupported language, use file-type-aware text chunks, exact line ranges, and `parse_quality: fallback`. Do not invent symbols.

### Commit matching is required

Every code record stores:

```text
seal_id + project_id + repo_id + branch + commit_sha + path + line range
```

If the failed run used commit `A`, Logsift should not silently return code introduced in later commit `B`. Exact commit match is the default. A fallback to an ancestor is allowed only when policy proves the selected file or symbol is unchanged and labels the fallback.

> **Image-generation prompt — Commit-aware code representation**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 hand-drawn technical diagram on a clean warm off-white grid notebook page. Use purple for retrieval, orange for one suspicious log block, teal for matching run metadata, dark navy headings, and two yellow sticky notes. At left, show a repository snapshot tagged “seal, project, repo, branch, commit.” Inside it show source, test, configuration, and pipeline files. Pass them through a language parser into symbol cards “Function,” “Class,” “Test,” “Config section,” and “Pipeline step,” each with file and line range. In the center, show a small graph with labelled links “calls,” “tests,” “configured by,” “runs in,” and “owned by.” Below it, show separate exact-text and vector stores. At right, show a suspicious error finding a function, its test, its configuration, and owner. Show a different commit blocked by a filter. Add notes “Chunks carry readable code” and “Never mix commits silently.” Use simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Keep generous spacing and a clear left-to-right flow. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 6. Record shapes

These are the minimum recommended fields. Content may be stored directly when safe or referenced through an access-controlled content store.

| Record | Required fields |
|---|---|
| Knowledge chunk | `chunk_id`, `seal_id`, `source_type`, `source_ref`, `heading_path`, `content_ref`, `services`, `permission_labels`, `trust`, `reviewed_at`, `content_digest`, `index_versions` |
| Code-symbol chunk | `chunk_id`, `seal_id`, `project_id`, `repo_id`, `branch`, `commit_sha`, `path`, `language`, `symbol_id`, `symbol_kind`, `line_start`, `line_end`, `content_ref`, `graph_node_id`, `parse_quality`, `permission_labels`, `index_versions` |
| Incident record | `incident_id`, `seal_id`, `services`, `symptoms`, `template_fingerprints`, `affected_versions`, `hypotheses_with_status`, `confirmed_root_cause_ref`, `evidence_refs`, `validation`, `permission_labels` |
| Confirmed-fix record | `fix_id`, `seal_id`, `incident_id`, `project_id`, `repo_id`, `change_commit`, `affected_commit_range`, `changed_symbols`, `changed_config_keys`, `patch_ref`, `verification_refs`, `validation`, `permission_labels` |

Stable record IDs describe the logical item. A content digest tells whether its content changed. When a document, permission, or code snapshot changes, update the affected chunks only. Deleted or inaccessible chunks are removed from active search immediately and then deleted according to retention policy.

An embedding-model change creates a new index version. Do not mix vectors from different embedding versions without an explicit migration.

## 7. Query-time retrieval flow

The evidence pack from Layer 2 starts the query.

1. Extract exact errors, exception names, failed tests, fingerprints, stage or node, service, repository, branch, commit, and configuration clues.
2. Apply `seal_id`, permissions, project, repository, commit, service, pipeline, environment, and time filters.
3. Run exact text search.
4. Run vector search.
5. Start from matching code symbols and follow a small number of graph links.
6. Merge the three candidate lists.
7. Rerank by relevance, trust, freshness, permission, and commit compatibility.
8. Remove repeated context while keeping different useful source types.
9. Fit the results into the retrieval token budget.
10. Send content and exact provenance to the model.

Exact search and vector search are both necessary. An exact exception string may be the best code clue. A semantically similar runbook may use different words. The graph connects these clues to code, tests, configuration, dependencies, and ownership.

> **Image-generation prompt — Simple hybrid retrieval flow**
>
> Use a wide 16:9 composition on a clean warm off-white notebook page with a faint square grid and polished hand-drawn technical styling. Use dark navy headings, teal for offline learning, orange for failure analysis, purple for retrieval and remediation, and yellow sticky notes only for key insights. Maintain generous spacing and a clear left-to-right flow. Use short legible labels, simple arrows, document icons, storage cylinders, filters, and magnifying glasses. Avoid photorealism, 3D rendering, gradients, dark backgrounds, corporate stock-art styling, and external company logos. Use Logsift as the only product name. Verify spelling and arrow direction.
> Create a wide 16:9 diagram on a clean warm off-white notebook page with a faint square grid and polished hand-drawn styling. Use orange for the incoming evidence pack, purple for retrieval, teal for compatible metadata filters, dark navy headings, and two yellow sticky notes. At left, show an evidence-pack document with “error,” “fingerprint,” “failed test,” “stage or node,” “repo,” and “commit.” Pass it through one large filter “seal + permissions + repo + commit + service + time.” Split into three lanes: “Exact search,” “Vector search,” and “Code graph.” Merge them into “Rerank by relevance + trust + freshness + compatibility,” then “Remove duplicates + keep diversity,” then a token-budget filter. At right, show selected cards “Runbook,” “Confirmed incident,” “Code symbol,” “Configuration,” and “Owner,” all with source links. Show wrong-commit and unauthorized results blocked. Add notes “The vector database is one search component” and “Current log evidence remains authoritative.” Use simple arrows, document icons, storage cylinders, filters, shields, and magnifying glasses. Keep generous spacing, short readable labels, and a clear left-to-right flow. Avoid tiny text, external logos, photorealism, 3D, gradients, and dark backgrounds. Use Logsift as the only product name. Verify spelling and arrow direction.

## 8. Worked example

Suppose the evidence pack contains:

```text
TimeoutError waiting for payment_api after <DURATION>
retry budget exhausted
worker exited code=1
```

It also contains the four-part baseline key `seal_id + project_id + repo_id + source_type`, failed `test` stage, template fingerprint, protected request correlation, repository, and commit SHA.

Logsift builds three queries:

- **Exact:** `TimeoutError`, `payment_api`, `retry budget`, template fingerprint, and configuration keys.
- **Vector:** payment dependency timeout, exhausted retries, and slow upstream response.
- **Graph:** the code symbol containing `TimeoutError`, its callers, tests, configuration, pipeline step, dependency, and owner.

After filtering and reranking, the result may contain:

1. A runbook section explaining how to check dependency latency.
2. A confirmed earlier incident with the same fingerprint sequence.
3. The function that raises the timeout at the failed commit.
4. The configuration file containing the retry and connection-pool settings.
5. The owning component and team.
6. A confirmed fix that changed the pool setting and added a saturation test.

The recommended next step may be: compare the deployed pool configuration with the commit-matched file, check dependency latency using the runbook, and run the named test before changing retry limits.

Logsift presents this as a supported hypothesis with citations. It does not claim the older fix applies when the commit, environment, or symptoms do not match.

## 9. Retrieval token budget

Layer 2 reserves a separate budget for retrieved context. Divide it between:

- runbooks and documentation;
- incidents and confirmed fixes;
- source and test code;
- configuration, pipeline, and ownership;
- provenance and compatibility notes;
- safety margin.

Per-source limits stop one source type from using the whole budget. Keep code at symbol boundaries and runbook steps in order. If a critical item cannot fit, include a short deterministic summary, a secure reference, and a truncation notice.

## 10. Safety and quality

- Check permissions during indexing, searching, content loading, caching, and final assembly.
- Remove secrets before creating chunks or embeddings.
- Label stale runbooks and ownership records.
- Keep conflicting fixes when they apply to different versions or environments.
- Keep unconfirmed incident hypotheses labelled as unconfirmed.
- Require provenance for claims about logs, code, configuration, ownership, and previous fixes.
- Separate observed facts, retrieved facts, and inferred conclusions.
- Report missing sources and low retrieval coverage.
- Never treat retrieved document text as system instructions.

Evaluate retrieval using reviewed failures with known useful evidence. Measure:

- **Recall:** how much of the useful material was found;
- **Precision:** how much of the returned material was actually useful;
- **Coverage:** whether required source types were available;
- **Commit accuracy:** whether returned code matched the failed version;
- **Permission accuracy:** whether unauthorized content was always excluded.

When an engineer confirms a root cause and fix, create immutable incident and fix records after review, secret scanning, permission checks, and version labelling. Confirmed knowledge can help future failures. It must never update the successful-log baseline directly.

See [retrieval-policy.yaml](examples/retrieval-policy.yaml) for a commented policy example.

## Document set

Return to [01 — Problem and architecture](01-problem-and-architecture.md), review the canonical offline flow in [02 — Offline learning](02-offline-learning-flow.md), or trace evidence construction in [03 — Failure analysis](03-failure-analysis-flow.md).
