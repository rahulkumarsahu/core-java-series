This is the right place to stop and understand deeply because **Scoring + Ranking + Token Budgeting is the brain of LogSift**.

Everything before this stage was about:

> "Find possible interesting things."

This stage answers:

> "Among all interesting things, what is worth sending to the LLM when we have limited space?"

Let's build the mental model from the beginning.

---

# 1. Where are we in the pipeline?

Current state:

```
Failed Logs
     |
     v
Preprocessing
     |
     v
Drain Templates
     |
     v
Log Diff
     |
     v
Suspicious Candidates
     |
     v
Context Expansion
     |
     v
Deduplication
     |
     v
Log Blocks
```

Now we have:

```
Block 1: Database Failure
Block 2: Docker Build Failure
Block 3: Security Scan Warning
Block 4: Retry Storm
Block 5: Deployment Timeout
```

Question:

Which blocks should go to LLM?

Because maybe:

```
Total blocks = 50

Total size = 200,000 tokens
```

But LLM context budget:

```
20,000 tokens
```

We need:

```
Best 20,000 tokens worth of evidence
```

This is where scoring and token budgeting come.

---

# 2. First understand Score vs Token Budget

They are two different things.

## Scoring

Answers:

> "How important is this log block?"

Example:

```
Database Failure Block

Score = 95


Docker warning block

Score = 20
```

---

## Token Budgeting

Answers:

> "How much space can I give to these important blocks?"

Example:

LLM budget:

```
20,000 tokens
```

Selected:

```
Database Failure
8000 tokens

Docker Failure
4000 tokens

Deployment Failure
6000 tokens

Total:
18000 tokens
```

---

Simple:

```
Score decides WHAT to take

Token budget decides HOW MUCH to take
```

---

# 3. Where does the score come from?

This is the important question.

The score is not random.

It comes from multiple signals collected earlier.

Think:

```
Log Block
    |
    |
    +---- Novelty
    |
    +---- Error severity
    |
    +---- Failure proximity
    |
    +---- Frequency anomaly
    |
    +---- Stage importance
    |
    +---- Exception presence
    |
    +---- Historical importance
    |
    v

Final Score
```

---

# 4. Example Log Block

Suppose we have:

```
Block A:

Database Connection Failure


Lines:

1000 Connecting database

1001 Retry

1002 Retry

1003 Connection refused

1004 SQLException

1005 BUILD FAILURE
```

Now we calculate score.

---

# 5. Scoring Model

A simple production formula:

```
Final Score =

Novelty Score
+
Severity Score
+
Failure Signal Score
+
Position Score
+
Frequency Score
+
Stage Importance
```

Example:

```
Score =
0.25 * Novelty
+
0.25 * Severity
+
0.20 * Failure proximity
+
0.15 * Frequency
+
0.10 * Stage importance
+
0.05 * Historical signal
```

Weights are company-specific.

---

# 6. Signal 1: Novelty Score

Question:

> Did this happen in successful runs?

From Log Diff:

Example:

```
Connection refused

Seen in success?
NO
```

High score.

Example:

```
Starting PostgreSQL

Seen in success?
YES
```

Low score.

Example:

```
Novelty Score:

New template:
100

Rare template:
70

Common template:
10
```

---

# 7. Signal 2: Error Severity

Not all logs are equal.

Example:

Low:

```
Retrying request
```

Medium:

```
Timeout occurred
```

High:

```
Exception stack trace
```

Very high:

```
OutOfMemoryError
BUILD FAILURE
Process exited with code 137
```

Example:

```
Severity Score:

INFO:
5

WARN:
30

ERROR:
70

Exception:
90

Fatal:
100
```

---

# 8. Signal 3: Failure Proximity

This is very important.

Usually root cause is near failure.

Example:

```
Line 100

Connection refused


Line 10000

BUILD FAILURE
```

The line near:

```
BUILD FAILURE
```

gets higher score.

Example:

```
distance_from_failure = 5 lines

score = 100


distance = 10000 lines

score = 10
```

---

# 9. Signal 4: Frequency Anomaly

Example:

Successful runs:

```
Retry connection
usually appears 2 times
```

Failed:

```
Retry connection
5000 times
```

This is suspicious.

Score:

```
frequency_ratio = failed_count / normal_count

5000 / 2 = 2500x
```

High score.

---

# 10. Signal 5: Stage Importance

Not every stage has equal importance.

Example:

Pipeline:

```
Compile
Test
Security Scan
Deploy
```

Failure in:

```
Compile
```

might block everything.

Failure in:

```
Security warning
```

might not.

Company can define:

Example:

```
Production deployment:
100

Integration test:
90

Unit test:
80

Lint:
30
```

This is business knowledge.

---

# 11. Signal 6: Historical Data

Suppose:

Last 100 builds:

```
Database failure appeared 20 times
```

Maybe this is known recurring issue.

Or:

```
First time ever seen
```

Could be important.

You can include:

```
Historical frequency
Previous RCA success
Known issue mapping
```

---

# 12. Example Calculation

Block:

```
Database Failure
```

Signals:

```
Novelty:
100


Severity:
90


Failure proximity:
95


Frequency:
80


Stage importance:
90
```

Formula:

```
Score =

0.25*100
+
0.25*90
+
0.20*95
+
0.15*80
+
0.15*90
```

Calculate:

```
25
+
22.5
+
19
+
12
+
13.5

=92
```

Final:

```
Database Failure

Score:
92/100
```

---

# 13. Now Ranking

After scoring:

Input:

```
Block A:
Database failure
Score 92


Block B:
Docker warning
Score 40


Block C:
Timeout
Score 80


Block D:
Security warning
Score 20
```

Sort:

```
1. Database failure 92
2. Timeout 80
3. Docker warning 40
4. Security warning 20
```

Now we know priority.

---

# 14. Now Token Budgeting

This is where your question comes:

> Do we tell LLM use this much token or do we slice logs based on score?

Answer:

**We decide before calling LLM.**

The LLM does not decide.

LogSift prepares the evidence.

Flow:

```
Score + Ranking

        |

Select blocks

        |

Fit into token budget

        |

Send to LLM
```

---

# 15. Token Budget Example

Assume:

LLM context:

```
20,000 tokens
```

System prompt:

```
3000 tokens
```

User question:

```
1000 tokens
```

Available:

```
16000 tokens
```

Now blocks:

| Block | Score | Size |
|-|-|-|
| Database Failure | 92 | 8000 |
| Timeout | 80 | 6000 |
| Docker | 40 | 5000 |
| Warning | 20 | 3000 |

Selection:

Take highest score:

```
Database
8000
```

Remaining:

```
8000
```

Take:

```
Timeout
6000
```

Remaining:

```
2000
```

Docker requires:

```
5000
```

Cannot fit.

Stop.

Final:

```
Database
Timeout
```

Sent to LLM.

---

# 16. Important: We don't cut randomly

Wrong:

```
Take first 20,000 tokens of log
```

Because:

```
Beginning:
Environment setup

Middle:
Actual failure

End:
Error
```

You may miss the cause.

---

Correct:

```
Select important blocks
then trim inside blocks
```

---

# 17. What if one block itself is huge?

Example:

Database block:

```
50,000 tokens
```

Budget:

```
10,000 tokens
```

Then we compress internally.

Priority:

```
Failure lines
Exception
Caused by
Stack trace root
Near failure context
```

Remove:

```
Repeated retries
INFO logs
duplicate messages
```

---

# 18. Token Budget Algorithm

Simple version:

```
available_tokens = LLM_limit 
                    - prompt_tokens
                    - response_tokens


for block in ranked_blocks:

    if block.tokens <= remaining:

          include(block)

    else:

          compress(block)

          if compressed_size <= remaining:
                 include(block)

          else:
                 skip(block)
```

---

# 19. Final Evidence Pack

Before LLM:

Example:

```
Evidence Pack

Build:
payment-api-123


Primary Failure:

Block 1
Score:92

Database connection failure

Lines:
7900-8050


Secondary:

Block 2
Score:80

Deployment timeout

Lines:
9000-9100
```

Then:

```
LLM
 |
 v
Root Cause Analysis
```

---

# 20. How to Explain in Design Review

If someone asks:

## "How do you decide which logs go to LLM?"

Answer:

> We don't send logs directly. After candidate expansion, LogSift creates logical log blocks. Each block receives a deterministic score based on signals such as novelty against successful baselines, error severity, proximity to failure, frequency anomaly, and stage importance. Blocks are ranked by score, and a token budget manager selects the highest-value blocks that fit within the LLM context window. Large blocks are compressed before inclusion.

---

# 21. Final Mental Model

Remember:

```
Log Diff
---------
Finds suspicious patterns


Candidate Expansion
-------------------
Finds the story around them


Dedup + Log Blocks
------------------
Creates meaningful incidents


Scoring
--------
Ranks incidents by importance


Token Budgeting
---------------
Chooses what the LLM is allowed to see
```

The LLM should never receive "all logs".

LogSift's job is:

> Convert millions of lines → top few evidence blocks → within token budget → high-quality RCA.