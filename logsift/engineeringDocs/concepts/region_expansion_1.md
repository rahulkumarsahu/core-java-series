This is a very good question. This confusion is common because there are **two different worlds** involved:

1. **Template world** → Drain + Log Diff
2. **Raw log world** → Candidate Expansion

Let me explain slowly.

---

# First understand the key point

After Log Diff:

```
Failed Template
        |
        v
"Database connection refused"
```

Log Diff **does not have the actual log lines**.

It only knows:

```
This pattern is suspicious
```

Example:

```
Template:
Database connection refused

Reason:
NOVEL_VS_SUCCESS
```

Now Candidate Expansion has to answer:

> "Where did this happen in the actual failed log?"

For this, it needs a **bridge between template and raw log**.

---

# Think of Drain as creating an index

When Drain processes failed logs, it does two things.

## 1. Creates templates

Example:

Raw failed log:

```
Line 900:
Starting database

Line 901:
Connecting to DB payment-db

Line 902:
Retrying connection

Line 903:
Connection refused

Line 904:
PaymentService FAILED
```

Drain creates:

```
Template T1:
Starting database

Template T2:
Connecting to DB <HOST>

Template T3:
Retrying connection

Template T4:
Connection refused

Template T5:
PaymentService FAILED
```

---

## 2. Maintains occurrence mapping

This is the important part.

Drain processing also stores:

```
Template  ---> Where it appeared
```

Example:

```
T1
 |
 +--> line 900


T2
 |
 +--> line 901


T3
 |
 +--> line 902


T4
 |
 +--> line 903


T5
 |
 +--> line 904
```

This is called an **occurrence index**.

---

# Now Log Diff happens

Log Diff compares:

```
Failed Templates

        VS

Success templates.json
```

Example:

Success baseline:

```
T1 Starting database
T2 Connecting to DB <HOST>
T3 Retrying connection
```

Failed:

```
T1 Starting database
T2 Connecting to DB <HOST>
T3 Retrying connection
T4 Connection refused
T5 PaymentService FAILED
```

Comparison:

| Failed Template | Seen in success? |
|-|-|
| Starting database | Yes |
| Connecting DB | Yes |
| Retrying connection | Yes |
| Connection refused | No |
| PaymentService FAILED | No |

Result:

```
Suspicious templates:

T4
T5
```

---

# Now Candidate Expansion starts

It receives:

```
Suspicious Template:

T4 = Connection refused
```

Question:

> Where is T4 in the log?

It does NOT check:

```
templates.json ❌
baseline.json ❌
```

Those files only know:

```
What patterns are normal
```

They do not know:

```
Where in today's failed log this happened
```

---

# Candidate Expansion uses failed run metadata

It uses the data generated while processing the failed log.

Example:

A small index created during Drain processing:

```
failed_run_123_occurrences.json
```

Example:

```json
{
 "T4": {
    "template":"Connection refused",
    "locations":[
        {
          "line":903
        }
    ]
 },

 "T5": {
    "template":"PaymentService FAILED",
    "locations":[
        {
          "line":904
        }
    ]
 }
}
```

Now:

Candidate Expansion asks:

```
Give me location of T4
```

Answer:

```
Line 903
```

---

# Then expansion happens

Now it knows:

```
Center line = 903
```

Configuration:

```
before = 20 lines
after  = 10 lines
```

It calculates:

```
Start:

903 - 20

= 883


End:

903 + 10

= 913
```

Now it needs:

```
Lines 883-913
```

---

# Your next question:

> Does it load the complete log into memory?

Answer:

## No. Ideally it should not.

For large CI logs:

```
500 MB
1 GB
5 GB
```

You don't want:

```
Read entire file
        |
        v
Store in RAM
        |
        v
Find lines
```

That is expensive.

---

# How production systems do it

There are two approaches.

---

# Approach 1: Store line offsets (recommended)

While reading logs, create an index.

Example:

Raw file:

```
failed_build_123.log
```

Index:

```
Line number       File position

1                 0 bytes

100               5432 bytes

500               32121 bytes

903               88990 bytes
```

Now expansion says:

```
Need line 883-913
```

System:

```
Go directly to byte position

Read only that region
```

Example:

```
Open file

Jump to line 883 position

Read until line 913

Return block
```

Memory usage:

```
Only 30 lines loaded
```

---

# Approach 2: Store processed logs in chunks

Example:

During ingestion:

```
failed_run_123/

   chunk-001
   chunk-002
   chunk-003
   chunk-004
```

Each chunk:

```
1000 lines
```

Candidate expansion:

Needs:

```
883-913
```

Finds:

```
chunk-001
```

Loads only that chunk.

---

# Complete flow visually

```
                 Failed Log File

                       |
                       |
                       v

                Drain Processing

                       |
          +------------+------------+
          |                         |
          v                         v

   Failed Templates          Occurrence Index

          |                         |
          |                         |
          v                         |
                                     
             Log Diff

                  |
                  v

          Suspicious Template

                  |
                  v

          Ask Occurrence Index

                  |
                  v

             Line Number

                  |
                  v

          Context Expansion

                  |
                  v

          Read small log region

                  |
                  v

          Evidence Block
```

---

# What files are involved?

Let's map it clearly.

## Offline success files

Used by Log Diff:

```
baseline.json
templates.json
```

Purpose:

```
Is this normal or new?
```

---

## Failed run files

Created during current failure:

```
failed_templates.json

failed_occurrences.json

failed_run.log
```

Purpose:

```
Where did this suspicious thing happen?
```

---

# Simple analogy

Imagine a book.

Success baseline:

```
Dictionary of normal words
```

Log Diff:

```
Find unusual words
```

But after finding:

```
word = "earthquake"
```

You need:

```
Which page contains earthquake?
```

The dictionary cannot tell you.

You need an index:

```
earthquake -> page 45
```

Then:

```
Open page 45
Read surrounding pages
Understand story
```

That is exactly Candidate Expansion.

---

# Final mental model

Remember these 3 questions:

| Stage | Question answered |
|-|-|
| Drain | "What patterns exist in this log?" |
| Log Diff | "Which patterns are unusual compared to success?" |
| Candidate Expansion | "Where did this happen and what happened around it?" |

So the answer to your confusion:

> Log Diff does NOT fetch lines from baseline or template.json. Those files only tell what is normal. Candidate Expansion uses a mapping created while processing the failed log that links suspicious templates back to original line numbers, then it reads only that region from the failed log file.

This separation is actually a very important design decision for LogSift.