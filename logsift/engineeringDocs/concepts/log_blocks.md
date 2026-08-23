Good. Now you are entering the **most important compression stage before LLM RCA**.

Till now we have:

```
Raw Failed Logs
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
Candidate Expansion
        |
        v
?????
```

The next stage is:

```
Deduplication + Log Block Creation
```

The purpose is:

> Convert many suspicious individual lines into a few meaningful failure stories.

Because LLM does not need 1000 suspicious lines. It needs 5-10 meaningful blocks.

Let's understand step by step.

---

# 1. Why do we need Dedup + Log Blocks?

Imagine a failed pipeline.

Log Diff finds:

```
Candidate 1:
Connection refused
line 8000


Candidate 2:
Retrying database connection
line 7990


Candidate 3:
Retrying database connection
line 7991


Candidate 4:
Retrying database connection
line 7992


Candidate 5:
PostgreSQL Exception
line 8001


Candidate 6:
BUILD FAILURE
line 8005
```

Technically these are 6 candidates.

But from an engineer perspective:

Is this 6 problems?

No.

It is one failure story:

```
Database connection failed
        |
        |
        v
Retries happened
        |
        |
        v
Connection refused
        |
        |
        v
Test failed
```

So we need to merge them.

---

# 2. What is Deduplication?

Simple definition:

> Remove duplicate or overlapping evidence so we don't send the same failure information multiple times.

Dedup does not mean deleting important information.

It means:

```
Many signals
     |
     v
One meaningful representation
```

---

# 3. Types of duplicates

There are multiple types.

## Type 1: Exact duplicate

Example:

```
line 8000:
Retrying connection

line 8001:
Retrying connection

line 8002:
Retrying connection
```

These are identical.

Instead of:

```
Candidate 1
Candidate 2
Candidate 3
```

store:

```
Template:
Retrying connection

Count:
3

Range:
8000-8002
```

---

## Type 2: Same failure chain

Example:

```
7990 Connecting database

7991 Retry

7992 Retry

7993 Connection refused

7994 Exception
```

Candidates:

```
Retry
Connection refused
Exception
```

But they belong together.

Merge:

```
Database Connection Failure Block
7990-7994
```

---

## Type 3: Overlapping context

Suppose expansion creates:

Candidate A:

```
7900-8050
```

Candidate B:

```
8000-8100
```

They overlap.

Instead of:

```
Block A

Block B
```

Merge:

```
7900-8100
```

---

# 4. Where does Log Block come into picture?

A log block is:

> A meaningful chunk of logs that represents one event/failure story.

Example:

Not good:

```
Line 8000:
Connection refused
```

Good:

```
---------------------------
Database Connection Failure
---------------------------

7990 Starting database connection

7991 Loading configuration

7992 Connecting to payment-db

7993 Retry attempt 1

7994 Retry attempt 2

7995 Connection refused

7996 PostgreSQL Exception

7997 Test Failed
```

This is a log block.

---

# 5. How is a Log Block created?

Let's follow the flow.

---

## Step 1: Candidate generation

Log Diff output:

```json
[
 {
   "template":"Retrying connection",
   "line":7993
 },

 {
   "template":"Connection refused",
   "line":7995
 },

 {
   "template":"SQLException",
   "line":7996
 }
]
```

---

## Step 2: Context expansion

Each candidate gets context.

Example:

Configuration:

```yaml
before_lines: 50
after_lines: 20
```

Candidate:

```
line 7995
```

Expansion:

```
7945-8015
```

Now:

```
Candidate A:

7945-8015
```

---

Another candidate:

```
line 7996
```

Expansion:

```
7946-8016
```

Now:

```
Candidate B:

7946-8016
```

---

# 6. Dedup stage merges them

Input:

```
Block A

7945-8015


Block B

7946-8016
```

Overlap:

YES

Result:

```
Merged Block:

7945-8016
```

---

# 7. How does the system know two blocks belong together?

There are multiple signals.

---

# Signal 1: Line overlap

Example:

```
Block A:

100-200


Block B:

180-250
```

Overlap:

```
180-200
```

Merge.

---

# Signal 2: Same stage / DAG node

Very important for LATTICE.

Example:

Block A:

```
test:integration

line 8000-8100
```

Block B:

```
test:integration

line 8050-8200
```

Merge.

But:

```
test:integration

8000-8100
```

and

```
security-scan

8050-8200
```

Do not merge.

Because they are different parallel branches.

---

# Signal 3: Same failure reason

Example:

Block A:

```
Database connection refused
```

Block B:

```
Postgres timeout
```

Both indicate:

```
DATABASE_FAILURE
```

Can merge.

---

# Signal 4: Distance between candidates

Example:

Candidate 1:

```
line 100
```

Candidate 2:

```
line 110
```

Likely same incident.

But:

Candidate 1:

```
line 100
```

Candidate 2:

```
line 50000
```

Probably different.

---

# 8. Example End-to-End

Let's take a failed Jenkins run.

Raw log:

```
7000 Starting integration test

7010 Loading DB config

7015 Connecting database

7016 Retry connection

7017 Retry connection

7020 Connection refused

7021 SQLException

7022 PaymentServiceTest FAILED


9000 Docker image build failed
```

---

Log Diff finds:

```
Candidate 1:
Retry connection
line 7016


Candidate 2:
Connection refused
line 7020


Candidate 3:
SQLException
line 7021


Candidate 4:
Docker image build failed
line 9000
```

---

Expansion:

Candidate 1:

```
6966-7036
```

Candidate 2:

```
6970-7040
```

Candidate 3:

```
6971-7041
```

Candidate 4:

```
8950-9020
```

---

Dedup:

First three overlap:

```
6966-7041
```

Fourth is separate:

```
8950-9020
```

Final output:

```
BLOCK 1:

Database Failure
6966-7041


BLOCK 2:

Docker Build Failure
8950-9020
```

---

# 9. Final Log Block Object

Internally:

```json
{
 "block_id":"B001",

 "stage":"test:integration",

 "start_line":6966,

 "end_line":7041,

 "trigger_candidates":[
    {
      "template":"Connection refused",
      "line":7020
    },
    {
      "template":"SQLException",
      "line":7021
    }
 ],

 "reason":[
    "NOVEL_TEMPLATE",
    "EXCEPTION",
    "FAILED_STAGE"
 ]
}
```

---

# 10. Why not directly send candidates to LLM?

Without blocks:

LLM receives:

```
Connection refused

SQLException

Retry connection

FAILED

Retry connection

Retry connection
```

Problem:

- No relationship
- Duplicate information
- More tokens

---

With blocks:

LLM receives:

```
Database Failure Block:

Context:
Database connection retries failed.

Evidence:
Connection refused
SQLException
Test failure
```

Much better.

---

# 11. Relationship between stages

The whole pipeline now looks like:

```
Drain
 |
 |
 v
Templates

 |
 |
 v

Log Diff

Question:
"What changed?"


 |
 |
 v

Candidates

Question:
"Which lines look suspicious?"


 |
 |
 v

Context Expansion

Question:
"What happened around those lines?"


 |
 |
 v

Deduplication

Question:
"Which suspicious regions are actually the same incident?"


 |
 |
 v

Log Blocks

Question:
"What are the meaningful failure stories?"


 |
 |
 v

Scoring + Ranking

Question:
"Which blocks are most important?"


 |
 |
 v

LLM RCA
```

---

# 12. Very important architecture decision

Do not make Log Blocks too early.

Wrong:

```
Raw logs
 |
Create blocks
 |
LLM
```

Because you don't know what matters.

Correct:

```
Raw logs
 |
Drain
 |
Template comparison
 |
Find suspicious areas
 |
Expand
 |
Create blocks
```

The system first finds **where the anomaly is**, then creates the story around it.

---

# Simple one-line explanation for your review:

> "Log Diff identifies suspicious template occurrences. Candidate expansion retrieves the surrounding raw log context for those occurrences. Deduplication then merges overlapping or related regions into logical log blocks, which represent complete failure stories and are the final units sent for scoring and LLM-based RCA."

This is the correct mental model for LogSift.