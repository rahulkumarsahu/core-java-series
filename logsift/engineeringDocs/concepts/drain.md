# Drain Processing After Normalize + Redact + Mask
## How Drain Creates Reusable CI/CD Log Templates (JULES + Lattice)
https://jiemingzhu.github.io/pub/pjhe_icws2017.pdf
## 1. Where Drain fits in our architecture

Our complete flow:

```text
Raw CI/CD Logs
        |
        ↓
Pipeline Metadata Extraction
        |
        ↓
Redaction
        |
        ↓
Masking
        |
        ↓
Normalization
        |
        ↓
Drain Log Parsing
        |
        ↓
Reusable Templates
        |
        ↓
Success Baseline
```

Drain is **not responsible for security cleaning**.

Drain's job is:

> Convert many similar log lines into one reusable pattern/template.

Drain is a log parsing algorithm that groups similar log messages and extracts the constant part (template) and changing part (parameters). It uses a fixed-depth tree structure to efficiently find similar logs.

---

# 2. Input given to Drain

Drain should not receive raw Jenkins logs.

Example raw log:

```
2026-08-23 10:20:15 Running build payment-api commit=a82f923
2026-08-23 10:21:10 Running build payment-api commit=b92a812
```

After:

- Redaction
- Masking
- Normalization

It becomes:

```
<TIMESTAMP> Running build payment-api commit=<GIT_HASH>

<TIMESTAMP> Running build payment-api commit=<GIT_HASH>
```

Now Drain can understand:

"These are the same type of event."

---

# 3. How Drain works internally (simple explanation)

Think of Drain as a smart filing system.

You give it:

```
Thousands of log lines
```

It creates folders:

```
Folder 1:
Compilation logs

Folder 2:
Testing logs

Folder 3:
Deployment logs
```

Inside each folder, it creates a template.

---

# 4. Drain algorithm steps

## Step 1: Tokenization

Drain breaks a log line into words/tokens.

Example:

Input:

```
Compiling 452 files for payment-service
```

Tokens:

```
[
Compiling,
452,
files,
for,
payment-service
]
```

---

## Step 2: Log length grouping

Drain first checks: 

"How many tokens does this log have?"

Example:

```
Compiling 452 files
```

Length:

```
3 tokens
```

Another:

```
Deploying image payment-service version 1.2.3
```

Length:

```
5 tokens
```

They go into different groups.

---

## Step 3: Tree traversal

Drain uses a fixed-depth tree.

Example:

```
              Root
                |
        Log Length = 4
                |
          First Token
                |
             Cluster
```

The purpose:

Avoid comparing every log with every other log.

Instead:

```
Incoming log

       |
       ↓

Find possible group quickly

       |
       ↓

Compare similarity
```

This is why Drain works efficiently for huge logs.

---

## Step 4: Similarity check

Drain asks:

"Does this log match an existing template?"

Example existing template:

```
Compiling <*> files
```

New log:

```
Compiling 500 files
```

Comparison:

```
Compiling      ✅
500            variable
files          ✅
```

Match.

Update:

```
Compiling <*> files
```

Frequency increases.

---

## Step 5: Create new template if no match

Example:

Existing:

```
Running tests <*>
```

New:

```
Database connection failed
```

No match.

Drain creates:

```
Template:
Database connection failed
```

---

# 5. Example from your JULES logs

Suppose successful JULES logs:

Run 1:

```
Checkout repository payment-api
Compiling 450 files
Running unit tests
Tests completed successfully
```

Run 2:

```
Checkout repository payment-api
Compiling 600 files
Running unit tests
Tests completed successfully
```

Drain output:

```
Template T001:

Checkout repository <REPO>


Template T002:

Compiling <*> files


Template T003:

Running unit tests


Template T004:

Tests completed successfully
```

---

# 6. Example from Lattice logs

Important difference:

For Lattice, Drain should not consume the complete interleaved stream blindly.

Wrong:

```
Line 100:
compile started

Line 101:
integration test started

Line 102:
compile finished
```

Drain sees:

```
random mixed logs
```

Problem.

---

Correct approach:

First separate logical nodes.

Example:

Original:

```
 //build:compile
Compiling source

 //test:unit
Running tests

 //build:compile
Compilation completed
```

Create logical streams:

```
Node:
build:compile

Logs:
Compiling source
Compilation completed
```

and:

```
Node:
test:unit

Logs:
Running tests
```

Then Drain runs separately.

---

# 7. Drain output for JULES

Example storage:

```
JULES Baseline

Stage:
compile

Templates:

T001:
Checking out repository <REPO>

T002:
Compiling <*> files

T003:
Compilation completed
```

---

# 8. Drain output for Lattice

Example:

```
LATTICE Baseline


Node:
build:compile

Templates:

T101:
Compiling <*> files


Node:
test:unit

Templates:

T102:
Running <*> tests


Node:
integration-test

Templates:

T103:
Connecting to database <HOST>
```

---

# 9. What files should we store?

You mentioned:

- baseline.json
- drain3_state.json
- templates.md
- normalize_sample.txt

Let's define their purpose.

---

# File 1: drain3_state.json

## Purpose

This is Drain's internal memory.

Think:

> "What does Drain already know?"

It contains:

- clusters
- tree structure
- template IDs
- learned patterns

Example:

```json
{
  "clusters": [
    {
      "cluster_id": 1,
      "template": "Compiling <*> files",
      "size": 5000
    }
  ]
}
```

Used when:

```
New log arrives
        |
        ↓
Continue learning existing templates
```

---

# File 2: baseline.json

## Purpose

This is our application-level baseline.

Drain does not know:

- seal_id
- project
- repo
- JULES/Lattice
- branch policy
- stage/node meaning

We add that.

Example:

```json
{
  "seal_id": "seal101",

  "project": "payments",

  "repo": "payment-api",

  "execution_type": "JULES",

  "version": "baseline-v1",

  "templates": [
      "T001",
      "T002"
  ]
}
```

---

# File 3: templates.md

## Purpose

Human-readable documentation.

Useful for:

- debugging
- reviewing baseline
- explaining RCA

Example:

```md
# Payment API Baseline

## Stage: Compile

Template:

Compiling <*> files

Frequency:

5000
```

This is not used by the service.

It is for engineers.

---

# File 4: normalize_sample.txt

## Purpose

Example input/output after preprocessing.

Useful for:

- debugging rules
- validating normalization

Example:

Before:

```
commit=a82f923
```

After:

```
commit=<GIT_HASH>
```

---

# 10. Can we add JULES/Lattice type?

Yes.

Actually, we should add it.

Drain itself does not understand pipeline type.

Our metadata layer should add:

```json
{
 "template_type": "JULES"
}
```

or:

```json
{
 "template_type": "LATTICE"
}
```

---

For Lattice:

Add:

```json
{
 "template_type": "LATTICE",

 "node_name":
 "integration-test",

 "build_type":
 "test"
}
```

---

For JULES:

Add:

```json
{
 "template_type": "JULES",

 "stage":
 "compile"
}
```

---

# 11. Recommended final storage model

I would not store only Drain output.

I would create:

```
baseline/
 |
 |-- baseline.json
 |
 |-- drain3_state.json
 |
 |-- templates.json
 |
 |-- templates.md
 |
 |-- normalize_sample.txt
```

---

# 12. templates.json (I would add this)

I would add one more file.

Reason:

`templates.md` is for humans.

`drain3_state.json` is for Drain.

We need a clean service format.

Example:

```json
{
 "template_id":"T001",

 "pattern":
 "Compiling <*> files",

 "execution_type":
 "JULES",

 "stage":
 "compile",

 "frequency":
 5000
}
```

This is what:

- Log Diff
- Baseline lookup
- RCA pipeline

will consume.

---

# 13. Final architecture after Drain

```text
Successful Logs
       |
       ↓
Normalize
       |
       ↓
Mask + Redact
       |
       ↓
Drain
       |
       ↓
Drain Templates
       |
       ↓
Add CI/CD Metadata
       |
       ↓
Baseline Storage
```

---

# Final Decision

For our implementation:

1. Drain runs after Normalize + Redact + Mask.
2. JULES logs can go directly to Drain after preprocessing.
3. Lattice logs must first be separated by DAG node/stage.
4. Drain should create templates per logical stream.
5. Store Drain internal state separately.
6. Store our CI/CD metadata separately.
7. Add `execution_type = JULES/LATTICE`.
8. Add stage for JULES.
9. Add DAG node/build_type for Lattice.
10. Do not use `templates.md` as machine storage; use JSON for service consumption.

The next logical deep dive after this is:

**"How do we create the Success Baseline from Drain templates? (template merging, frequency, versions, cleanup, and matching during failed pipeline log diff)"**.