## 1. Ownership and terminology

1. What does **UDS** stand for in your company, and what role does it serve?
2. Which team will own the Log Intelligence Service?
3. Who owns Jenkins-controller onboarding and team-to-controller mappings?
4. Who owns baseline quality and pipeline-specific configuration?
5. Who operates the service and handles production incidents?
6. Who must approve the final architecture?
7. Is this design limited to RCA evidence generation, or must it eventually include solution retrieval or automated remediation?

## 2. Team-to-Jenkins-controller mapping

8. Does each team have exactly one Jenkins controller, or can a team use several?
9. Can one Jenkins controller host pipelines for multiple teams?
10. Can the same logical pipeline run on multiple controllers?
11. What stable identifier represents a team?
12. What stable identifier represents a Jenkins controller?
13. Where is the authoritative mapping stored: configuration, database, CMDB, service catalog, or request metadata?
14. Does the MCP request already contain the team and controller identity?
15. If not, what information can the service use to resolve the controller?
16. When a job moves to another controller, should its old baseline move with it or be rebuilt?
17. Should offline processing always use the controller that emitted the success event, even if the current team mapping later changes?
18. Must baselines and configuration be strictly isolated between teams?
19. Can any approved teams share baselines?
20. Please provide anonymized examples of:

```text
team_id → controller_id → folder/job path → representative build identifier
```

for one normal pipeline and one DAG pipeline.

## 3. Pipeline identity and compatibility

21. What makes two executions the “same logical pipeline”?
22. Which fields must be part of its canonical identity: team, controller, folder, job, repository, branch, Jenkinsfile, environment, or another field?
23. How are Jenkins folders, multibranch jobs, pull-request jobs, renamed jobs, and copied jobs represented?
24. Should baselines be separate by branch? If so, which branches?
25. Should pull-request runs use their own baseline, the target branch baseline, or another policy?
26. Should environment, region, platform, architecture, toolchain, or deployment target split baselines?
27. Which configuration changes invalidate compatibility: Jenkinsfile hash, dependency lockfile, build image, tool versions, pipeline DAG, or others?
28. Who produces the compatibility fingerprint?
29. What should happen after a job rename, repository transfer, or pipeline migration?
30. Are retries and rebuilds the same run family or independent runs?
31. What is the authoritative run ID across Jenkins, UDS, MCP, and the new service?

## 4. Normal versus DAG-based pipelines

32. Precisely what distinguishes a “normal Jenkins log” from a “DAG-based log” in your system?
33. Is pipeline type explicitly supplied, discoverable through an API, or inferred from log text?
34. Where does DAG metadata come from: Jenkins APIs, a plugin, UDS, embedded log markers, or another system?
35. Which metadata is available per node: node ID, name, parent IDs, stage, status, timestamps, attempt, agent, and log range?
36. Are per-stage or per-node logs available, or only one interleaved console log?
37. Are node identifiers stable across executions?
38. How should dynamic matrix cells, shards, fan-out nodes, retries, and nested parallel stages be matched across runs?
39. Can multiple nodes write interleaved lines without reliable node markers?
40. Are timestamps present and reliable enough to order parallel events?
41. What should happen when DAG metadata is missing, partial, delayed, or inconsistent with the console log?
42. If Jenkins and UDS provide different DAG metadata, which source is authoritative?
43. Should a missing-DAG-metadata run fall back to flat-log analysis, fail, or return degraded confidence?
44. Can you provide anonymized samples of normal and DAG logs plus their available metadata?

## 5. Successful-run eventing

45. Which system emits the successful-run event?
46. Which transport is available: Kafka, another message broker, webhook, polling, or something else?
47. What is the exact event schema?
48. Does the event carry team, controller, pipeline, run ID, status, repository, branch, commit, and DAG references?
49. Which Jenkins results qualify: `SUCCESS` only, or also `UNSTABLE` or approved warnings?
50. When is the console log guaranteed complete and retrievable?
51. Are events delivered at least once, at most once, or exactly once?
52. Can events arrive late or out of order?
53. What field should be used as the idempotency key?
54. What retry and dead-letter behavior is required?
55. Is scheduled reconciliation allowed? If so, how often?
56. Is historical backfill required during onboarding?
57. How soon after success must a baseline become available?
58. Should manual, replayed, parameterized, or administrator-triggered successes be eligible?
59. Are there known “false successes” that must be excluded?
60. How long do Jenkins and UDS retain successful logs?

## 6. Jenkins acquisition and authentication

61. Which Jenkins API or plugin endpoints are approved for console logs, build metadata, stages, and DAG nodes?
62. What authentication method is used per controller: service account, API token, OAuth, mTLS, proxy identity, or another method?
63. Will there be one service identity per controller, per team, or a shared identity?
64. Where will credential references be stored and rotated?
65. Are controllers reachable directly from the deployment environment?
66. Are proxies, private DNS, custom certificate authorities, or mTLS required?
67. What permission scope can the service receive?
68. What are the controller rate limits and connection limits?
69. How are folder/job names and build numbers converted into a lookup URL?
70. Are logs paginated, streamed, compressed, or exposed as a single response?
71. What maximum log sizes and download durations occur?
72. Can the service fetch only ranges or must it retrieve the whole log?
73. What Jenkins error conditions should trigger a UDS fallback?
74. Should authorization failures ever trigger fallback, or be treated as configuration/security errors?

## 7. UDS lookup and fallback

75. What UDS APIs and identifiers are available?
76. How is UDS authenticated and authorized?
77. Does UDS contain full logs, partial logs, archived logs, DAG metadata, or normalized records?
78. How are Jenkins run IDs mapped to UDS records?
79. What are its retention, latency, pagination, size, and rate-limit constraints?
80. Is UDS an exact copy of Jenkins output or a transformed source?
81. If Jenkins returns a partial log, should the service replace it with UDS, merge both, or keep Jenkins only?
82. How can the service detect truncation or partial content?
83. If both sources succeed but differ, which one is authoritative?
84. How should duplicate lines be identified when sources are merged?
85. Must the Evidence Pack disclose the source and fallback reason?
86. What should happen when neither source can provide sufficient evidence?

## 8. Baseline ownership, scope, and lifecycle

87. Confirm the intended baseline key. Which dimensions are mandatory?

```text
team
controller
repository
logical pipeline
branch
environment
DAG stage/node
compatibility fingerprint
```

88. Should controller identity remain part of the key even when a pipeline moves?
89. How many recent successful runs should build a baseline?
90. Is selection count-based, time-window-based, or both?
91. Should baseline generation rebuild from the selected runs or update incrementally?
92. Who can approve, reject, pin, rebuild, or delete a baseline?
93. Can a pipeline owner exclude an anomalous successful run?
94. How should the service detect and prevent a bad success from poisoning a baseline?
95. What is the minimum history required before diff-based analysis is trusted?
96. What should happen for new or rarely successful pipelines?
97. How long should baselines and older versions be retained?
98. When preprocessing rules change, should old baselines be migrated, rebuilt, or retained separately?
99. Should stage-level templates exist in addition to a pipeline-wide baseline?
100. Is cross-pipeline or cross-team fallback ever permitted?
101. Must raw successful logs be retained by this service, or only redacted templates and statistics?
102. What audit history is required for baseline changes?

## 9. Storage and infrastructure

103. Is PostgreSQL approved and already available?
104. If not, which database is approved?
105. Is object storage available for snapshots or larger artifacts?
106. Which message broker or job queue is available?
107. Is Redis available or permitted?
108. Must all stored data be encrypted with company-managed keys?
109. What tenant-isolation model is required?
110. What retention and deletion requirements apply to metadata, templates, Evidence Packs, feedback, and audit records?
111. What expected data volume should the design support?
112. What backup, recovery-point, and recovery-time objectives apply?
113. Are there regional or data-residency restrictions?
114. Is production data allowed in lower environments?
115. Which schema-migration tooling is approved?

## 10. Deployment and runtime constraints

116. Where will the service run: Kubernetes, OpenShift, VMs, serverless, or another platform?
117. Should it be one shared multi-tenant deployment or separate deployments per team/controller?
118. Is Python approved? Which Python version?
119. Are FastAPI and Drain3 approved third-party dependencies?
120. Are containers required, and is there an approved base image?
121. Must API and worker processes deploy and scale separately?
122. What CPU, memory, replica, and pod limits apply?
123. What are the expected daily runs, failure rate, concurrent requests, and maximum log size?
124. What latency target applies to online RCA evidence generation?
125. What availability target is required?
126. Are outbound network calls restricted?
127. Which secrets manager and configuration system must be used?
128. Which observability stack is required for logs, metrics, traces, dashboards, and alerts?
129. What health, readiness, graceful-shutdown, and disaster-recovery standards apply?
130. Which development, test, staging, and production environments exist?

## 11. MCP integration

131. Which Spring Boot and Java versions does the MCP server use?
132. Who owns the existing MCP server?
133. Will MCP call the Python service synchronously, asynchronously, or both?
134. What exact fields can MCP send in the initial reduction request?
135. Does MCP already know the team, controller, pipeline, build, repository, branch, and DAG identity?
136. What authentication method should MCP use for the Python service?
137. What timeout, retry, and circuit-breaker policies are required?
138. What idempotency and correlation identifiers already exist?
139. Should the service return an Evidence Pack directly or return a job ID for later retrieval?
140. What maximum response size can MCP accept?
141. Who invokes the RCA LLM: MCP or the Python service?
142. Which model/provider is used, and may company logs be sent to it?
143. What model context limit and log-evidence token budget apply?
144. Which tokenizer must the service use?
145. How many bounded-expansion requests may one RCA perform?
146. What expansion modes and maximum extra-token limits are acceptable?
147. How should `INSUFFICIENT_EVIDENCE`, source failure, no baseline, timeout, and partial results map into MCP responses?
148. Must MCP validate every block citation before returning an RCA?
149. Where should user and automatic feedback be submitted?
150. Are streaming responses or cancellation required?
151. What API-versioning and backward-compatibility policy is required?

## 12. Log handling and security policy

152. What data classification applies to CI logs?
153. Which secret, PII, credential, hostname, repository, and internal-URL patterns must be redacted?
154. Is there an existing corporate redaction library or policy?
155. May original unredacted lines ever be retained by the service?
156. May log content appear in service logs, traces, error reports, or metrics?
157. Are team-specific masking and redaction rules allowed?
158. Who reviews rule changes?
159. Which build tools and log formats must V1 support?
160. Are there pipeline-specific failure markers or known-noise patterns?
161. Which numeric values must remain semantically visible—HTTP statuses, exit codes, failure counts, versions, ports, or others?
162. What access-control and audit requirements apply to Evidence Packs?
163. Are penetration testing, threat modeling, or formal security review required?

## 13. Algorithm and product decisions

164. Which token-budget profiles should V1 support?
165. What evidence must always be retained regardless of score?
166. What default context window and maximum structural expansion are acceptable?
167. Which RCA outcomes are required: `DIAGNOSED`, `AMBIGUOUS`, and `INSUFFICIENT_EVIDENCE`, or different statuses?
168. Must normal and DAG pipelines produce the same Evidence Pack contract?
169. Should flat-log analysis attempt stage extraction from console markers?
170. What confidence levels or thresholds are meaningful to users?
171. Which configuration may teams override?
172. Must overrides be reviewed centrally or can teams self-serve?
173. What is the required behavior when no compatible baseline exists?
174. Should initial releases support only deterministic reduction, or include LLM-driven bounded expansion immediately?

## 14. Repository, delivery, and rollout

175. Should this be a new repository or part of an existing one?
176. What repository naming, packaging, dependency, linting, testing, and security-scanning standards apply?
177. Which CI/CD system will build and deploy this service?
178. Which team/controller/pipelines should be the pilot?
179. Is shadow-mode evaluation required before MCP consumes the result?
180. Is there an existing labeled failure dataset?
181. Who will label root-cause evidence when no dataset exists?
182. What acceptance metrics are required: evidence recall, precision, token reduction, RCA correctness, latency, availability, or cost?
183. What thresholds must be achieved before production rollout?
184. Is rollback to the current head/tail reduction required?
185. Who provides final sign-off?
