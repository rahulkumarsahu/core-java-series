Good question. This is the **next important stage after Log Diff**.

You already have:

```
Raw Failed Logs
        |
        v
Normalize + Redact + Mask
        |
        v
Drain
        |
        v
Failed Templates
        |
        v
Log Diff
        |
        v
Suspicious Templates
```

Now the question is:

> Log Diff only tells us **which templates look suspicious**. How do we go back to the original logs, find the exact lines, and collect meaningful context around them?

That is the job of:

1. **Candidate Region Identification**
2. **Candidate Expansion / Context Expansion**

Let's go step by step.

---

# 1. Why do we need Candidate Expansion?

Imagine Log Diff gives:

```json
{
 "template": "Connection refused",
 "reason": "NOVEL_VS_SUCCESS"
}
```

This is not enough for RCA.

The LLM sees:

```
Connection refused
```

But it needs:

```
What connection?
Which service?
Which host?
What happened before?
What happened after?
Why did it fail?
```

The real evidence is usually a sequence:

```
Starting database connection

Connecting to payment-db.internal

Retrying connection

Retrying connection

Connection refused

PaymentServiceTest FAILED
```

So we need to expand the suspicious line into a meaningful block.

---

# 2. The Important Design Decision

During Log Diff, you should **not throw away line information**.

Every parsed template occurrence must maintain a pointer back to the original log.

Example:

When Drain creates:

```
Template:
Connection refused
```

Store:

```json
{
 "template_key": "abc123",
 "pattern": "Connection refused",

 "occurrences": [
    {
       "line_number": 80200,
       "timestamp": "10:32:11",
       "stage": "test:integration",
       "raw_reference": "log://build944#line80200"
    }
 ]
}
```

This mapping is the bridge:

```
Template
   |
   |
   v
Original log lines
```

Without this, expansion is impossible.

---

# 3. Data Flow After Log Diff

Complete flow:

```
                 Failed Log File

                       |
                       |
                       v

              Drain Processing

                       |
                       |

        +--------------+--------------+
        |                             |
        v                             v

 Failed Templates              Line Mapping

        |
        |
        v

      Log Diff

        |
        |
        v

Suspicious Templates

        |
        |
        v

Candidate Region Builder

        |
        |
        v

Context Expansion

        |
        |
        v

Evidence Blocks
```

---

# 4. What is a Candidate?

A candidate is not yet a root cause.

A candidate means:

> "This area of the log deserves investigation."

Example:

Log Diff output:

```json
{
 "template":
 "Connection refused",

 "line_number":80200,

 "reason":[
    "NOVEL_VS_SUCCESS"
 ]
}
```

This becomes:

```
Candidate #1

Location:
test:integration

Line:
80200

Reason:
New failure pattern
```

---

# 5. Candidate Region Identification

Now we have:

```
Suspicious template
        |
        v
Find all occurrences
```

Example:

Suspicious template:

```
Connection refused
```

Occurrences:

```
line 80200
line 80250
line 80300
```

Now we have three candidate points.

---

# 6. How Does It Find Line Numbers?

This is the important implementation detail.

During Drain processing, maintain an occurrence index.

Example:

Input:

```
80095 Starting PostgreSQL

80096 Connecting database

80097 Retry connection

80098 Connection refused
```

While processing:

```python
template_occurrence_map = {

 "tpl_123": [
      80096
 ],

 "tpl_456": [
      80097
 ],

 "tpl_789": [
      80098
 ]

}
```

Later:

Log Diff says:

```
tpl_789 is suspicious
```

Lookup:

```python
template_occurrence_map["tpl_789"]
```

Result:

```
[80098]
```

Now we know where to expand.

---

# 7. Candidate Region vs Candidate Line

Important distinction.

A candidate is not only one line.

Example:

Suspicious line:

```
80200 Connection refused
```

But the actual failure started earlier:

```
80190 Loading database configuration

80191 Reading DB URL

80192 Connecting to database

80193 Retry 1

80194 Retry 2

80200 Connection refused
```

So:

```
Candidate line
        |
        v
Expand into candidate region
```

---

# 8. How Context Expansion Works

Now we have:

```
Center line = 80200
```

We expand around it.

Example configuration:

```yaml
context_expansion:
    before_lines: 50
    after_lines: 20
```

Then:

```
Start:
80200 - 50

= 80150


End:
80200 + 20

= 80220
```

Candidate region:

```
80150 - 80220
```

---

# 9. Simple Expansion Algorithm

Pseudo:

```python
def expand_candidate(
       log_file,
       line_number
):

    start = line_number - 50

    end = line_number + 20


    return log_file[start:end]
```

Very simple first version.

---

# 10. But Fixed Window Is Not Enough

Because logs can be huge.

Example:

```
line 1000
ERROR
line 1001
line 1002
...
line 5000
failure
```

A fixed window may include too much noise.

So production systems use smarter expansion.

---

# 11. Boundary Based Expansion

Stop expansion when you find boundaries.

Examples:

## Stage boundary

```
===== Starting test stage =====
```

or:

```
 //test:integration
```

---

## New execution block

Example:

```
[INFO] Starting Maven build
```

---

## Successful completion

Example:

```
BUILD SUCCESS
```

---

## Previous failure block

Example:

```
ERROR
Exception
Caused by
```

---

Algorithm:

```
Start from suspicious line

        |

Expand backward

        |

Stop when:

- stage changes
- unrelated block starts
- max limit reached


Expand forward

        |

Stop when:

- final failure
- next stage
- max limit reached
```

---

# 12. Example

Original log:

```
7990  Starting integration test

7991  Loading config

7992  Connecting DB

7993  Retry connection

7994  Retry connection

7995  Connection refused   <-- candidate

7996  org.postgresql.Exception

7997  PaymentServiceTest FAILED

7998  BUILD FAILURE
```

Candidate:

```
7995 Connection refused
```

Expansion:

Backward:

```
7992 Connecting DB
7993 Retry
7994 Retry
```

Forward:

```
7996 Exception
7997 Test failed
7998 Build failure
```

Final block:

```
7992-7998
```

This is what goes to RCA.

---

# 13. Multiple Candidates Problem

Suppose Log Diff finds:

```
Candidate 1:
Connection refused
line 7995


Candidate 2:
PostgreSQL Exception
line 7996


Candidate 3:
BUILD FAILURE
line 7998
```

If we expand individually:

```
Block 1:
7992-7998

Block 2:
7993-7998

Block 3:
7990-8000
```

Duplicate information.

So next step is:

# Candidate Deduplication / Block Merge

Merge overlapping regions:

Before:

```
7992-7998

7993-7998

7990-8000
```

After:

```
7990-8000
```

One evidence block.

---

# 14. Candidate Region Object

After expansion:

```json
{
 "candidate_id":"C101",

 "region": {
    "start_line":7990,
    "end_line":8000
 },

 "trigger_lines":[
    7995,
    7996,
    7998
 ],

 "reasons":[
    "NOVEL_TEMPLATE",
    "EXCEPTION",
    "FAILED_STAGE"
 ]
}
```

---

# 15. How Does It Work With LATTICE?

This is where DAG metadata is important.

Example:

```
line 8000
//test:integration
Connection refused
```

Expansion should stay inside:

```
test:integration
```

Do not accidentally include:

```
scan:security
```

Example:

Wrong:

```
7990 //scan:security

7995 //test:integration
Connection refused

8005 //build:image
```

Candidate block:

```
7990-8005
```

Bad.

---

Correct:

```
test:integration node

7992-8002
```

Because the failure belongs to that DAG node.

---

# 16. Production Candidate Expansion Architecture

Something like:

```
                Log Diff Result

                       |
                       v

              Candidate Generator

                       |
                       v

          Template Occurrence Store

                       |
                       v

              Line Numbers

                       |
                       v

             Context Expander

                       |
                       v

            Candidate Regions

                       |
                       v

          Dedup + Merge Regions

                       |
                       v

              Evidence Blocks
```

---

# 17. Storage Needed

You need to maintain:

## Template occurrence index

Example:

```
template_key
      |
      |
      +--- line numbers
```

Example:

```json
{
 "tpl_connection_refused":[
     80200,
     80220
 ]
}
```

---

## Log offset index

For huge logs:

Do not read the entire file every time.

Maintain:

```
line_number
      |
      byte offset
```

Example:

```
Line 80200

byte offset = 8349282
```

Then you can directly seek.

---

# 18. Final Mental Model

Remember:

```
Log Diff answers:

"What changed?"


Candidate Expansion answers:

"Where exactly did it happen and what context explains it?"
```

Flow:

```
Suspicious Template

        |

Find occurrences

        |

Get line numbers

        |

Expand surrounding context

        |

Merge duplicate regions

        |

Create evidence blocks

        |

Send to RCA
```

---

So in LogSift:

- **Log Diff finds suspicious templates**
- **Candidate Region finds suspicious locations**
- **Context Expansion collects the story around those locations**
- **Dedup merges overlapping stories**
- **Evidence Pack sends only useful blocks to the LLM**

This stage is where a "suspicious line" becomes a "debuggable failure story."