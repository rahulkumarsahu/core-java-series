
## what is the problem statement?
## what it brings into the plat how it is better from others?
##

---

## How log sift should decide weather it is Jules pipeline or Lattice pipeline? <br>
**Answer:** JULES and Lattice must have unique, stable log signatures guaranteed to appear within the first 
1,000 lines. The central service reads only this bounded prefix, stops immediately after finding a valid 
signature, and classifies the run as JULES, LATTICE, or UNKNOWN. It should never scan a million-line log 
solely for pipeline-type detection and should never infer the type from whether the logs look sequential 
or interleaved.

---

## Decision — Baseline Storage Key

For V1, use this hierarchy:

```text
seal_id
  → project
    → repo
      → JULES / LATTICE
          → baseline files
```

Example:

```text
seal101
  → payments
    → payment-api
      → JULES
          → baseline-v1
          → baseline-v2
```

This is a good starting point because it is simple and matches how the CI environment is organized.

The baseline file can contain all successful-run templates for that repo and execution type.

For Lattice, the baseline should internally keep DAG/stage information, for example:

```text
LATTICE baseline
  ├── build:compile
  ├── test:unit
  └── test:integration
```

For JULES, stage information can also be preserved even though execution is sequential.

The main risk is:

> If the same repo contains two very different build/pipeline definitions under the same JULES or Lattice type, their templates could get mixed and pollute the baseline.

This is expected to be a rare case for now, so we can accept it in V1 and handle it later by adding an extra pipeline identifier or fingerprint only if needed.

So the current decision is:

> **Keep the key simple as `seal_id → project → repo → JULES/LATTICE`, version the baseline files, preserve stage/node metadata inside the baseline, and revisit pipeline-level separation only if baseline pollution actually appears in practice.**

---

# Decision: Offline Baseline Creation, Triggering, Storage, and Cleanup Strategy

## 1. Baseline should not be created from every successful pipeline

Decision:

- We will **not process every successful pipeline run** for template generation.
- Since the company runs lakhs of pipelines daily, processing every success log will create unnecessary compute and storage overhead.
- The goal is to learn pipeline behavior, not store every execution.

Flow:

```text
Successful Pipeline Run
        |
        ↓
Eligibility Check
        |
        ↓
Selected for Baseline Update?
        |
   Yes       No
    |         |
    ↓         ↓
Process     Ignore
```

---

# 2. Which branches will update the baseline?

Decision:

Only trusted/stable branches will contribute to the baseline.

Initial scope:

```text
Included:
- master/main branch
- release branches
```

Excluded:

```text
- feature branches
- developer branches
- temporary testing branches
```

Reason:

Feature branches can introduce temporary pipeline changes and create noise in the baseline.

Example:

```text
main

Compile
Test
Package


feature/new-security-scan

Compile
Test
Security Scan
Package
```

We do not want this temporary change to modify the standard pipeline behavior.

---

# 3. Should every successful build update the baseline?

Decision:

No.

We should use a controlled update strategy.

Options:

- Periodic sampling
- Time-based refresh
- Selected successful runs

Example:

Instead of:

```text
1000 successful builds
        ↓
1000 baseline updates
```

Use:

```text
1000 successful builds
        ↓
Select representative runs
        ↓
Update baseline
```

The exact sampling frequency can be tuned after observing pipeline behavior.

---

# 4. What will be stored?

Decision:

We will not store complete successful logs.

We will store only learned templates.

Example:

Instead of:

```text
Build #100 logs
Build #101 logs
Build #102 logs
```

Store:

```text
Template:
Compiling <*> files

Template:
Running <test>

Template:
Tests passed
```

The baseline stores pipeline behavior, not raw execution history.

---

# 5. Baseline storage key

Decision:

For V1, use:

```text
seal_id
    |
    project
        |
        repo
            |
            JULES / LATTICE
                |
                baseline
```

Example:

```text
seal101
 |
 payments
 |
 payment-api
 |
 JULES
 |
 baseline-v1
```

Reason:

- Matches current CI ownership model.
- Keeps the design simple.
- Avoids unnecessary complexity initially.

---

# 6. JULES and Lattice baseline separation

Decision:

Maintain separate baselines.

Example:

```text
payment-api

    |
    +-- JULES baseline
    |
    +-- LATTICE baseline
```

Reason:

Execution behavior is different.

JULES:

```text
Sequential execution
```

Lattice:

```text
Parallel execution
Interleaved logs
DAG stages
```

Mixing them can create incorrect comparisons.

---

# 7. How branches will use the baseline?

Decision:

Branches will not have separate baselines initially.

Example:

```text
main
release/*
feature/*
```

can consume the existing repository baseline.

However:

- Only trusted branches update the baseline.
- Other branches only use the baseline for comparison.

Example:

```text
feature/payment-update FAILED

        ↓

Find:
seal101/project/repo/JULES baseline

        ↓

Compare failed logs
```

---

# 8. How will a new successful run update templates?

Example existing baseline:

```text
Compile <*>
Test Passed
Package Image
```

New successful run:

```text
Compile <*>
Test Passed
Security Scan
Package Image
```

Drain creates:

```text
Compile <*>
Test Passed
Security Scan
Package Image
```

Update:

```text
Existing templates:
keep

New template:
add with frequency tracking
```

We do not replace the whole baseline.

---

# 9. Template cleanup strategy

Decision:

Templates will have lifecycle management.

Each template stores metadata:

```text
template_id

pattern

stage/node

first_seen

last_seen

frequency
```

Cleanup rules:

Remove:

- old unused templates
- low-frequency templates
- templates not seen for a long period

Keep:

- frequently occurring templates
- important lifecycle templates

Examples:

Always keep:

```text
BUILD SUCCESS
Tests Passed
Deployment Completed
```

---

# 10. Baseline versioning

Decision:

Baseline should be versioned.

Example:

```text
payment-api
 |
 JULES
 |
 baseline-v1
 baseline-v2
 baseline-v3
```

Reason:

- Pipeline changes can introduce incorrect templates.
- We need rollback capability.
- We can track why baseline changed.

---

# 11. Pipeline skip builds should be ignored

Decision:

Skip builds should not participate in baseline creation.

Examples:

```text
Pipeline skipped
No execution happened
No meaningful logs generated
```

Therefore:

```text
SKIPPED
    ↓
Do not create templates
Do not update baseline
```

Reason:

A skipped build does not represent successful pipeline behavior.

---

# Final Decision Summary

```text
Successful Pipeline Completion
            |
            ↓
Check Build Status
            |
    -----------------
    |               |
 SUCCESS         SKIPPED
    |               |
    ↓               ↓
Eligibility       Ignore
Check
    |
    ↓
Trusted Branch?
(main/release)
    |
    ↓
Selected for Sampling?
    |
    ↓
Normalize
    |
    ↓
Drain
    |
    ↓
Update Baseline
```

Final baseline model:

```text
seal_id
   |
 project
   |
 repo
   |
 JULES/LATTICE
   |
 Versioned Baseline
   |
 Templates + Metadata
```

**Key principle:**

> We should not store every successful build. We should continuously learn and maintain a compact representation of normal pipeline behavior using selected successful runs only. Skipped builds, temporary branches, and irrelevant executions should not influence the baseline.

---

# Offline Baseline Storage and Template Management

## 1. What do we store?

We do not store complete successful pipeline logs.

The goal of offline processing is to learn normal pipeline behavior and
store a compact representation.

Flow:

    Successful Pipeline Logs
            |
            v
    Normalize + Redact + Mask
            |
            v
    Drain Log Parsing
            |
            v
    Reusable Templates
            |
            v
    Success Baseline

Example:

Raw log:

    Compiling 452 files

Drain template:

    Compiling <*> files

Stored:

    Template ID:
    T001

    Pattern:
    Compiling <*> files

------------------------------------------------------------------------

## 2. Template Metadata

Each template stores:

    Template ID
    Template Pattern
    Execution Type (JULES/LATTICE)
    Stage or DAG Node
    Frequency
    First Seen
    Last Seen

Example:

    Template ID:
    T001

    Pattern:
    Compiling <*> files

    Execution Type:
    JULES

    Stage:
    compile

    Frequency:
    5000

For Lattice:

    Template ID:
    T101

    Pattern:
    Connecting to <HOST>:<PORT>

    Execution Type:
    LATTICE

    DAG Node:
    integration_test:payment-db

------------------------------------------------------------------------

## 3. Baseline Storage Structure

For V1:

    seal_id
     |
     project
       |
       repo
         |
         JULES / LATTICE
           |
           Versioned Baseline
             |
             Templates

Example:

    seal101/payments/payment-api/JULES/baseline-v1

------------------------------------------------------------------------

## 4. Why separate JULES and Lattice baselines?

JULES: - Sequential execution - Logs follow execution order

Lattice: - Parallel execution - Logs can be interleaved - Requires
DAG/stage awareness

Therefore:

    payment-api

     +-- JULES Baseline
     |
     +-- LATTICE Baseline

Templates should not be mixed.

------------------------------------------------------------------------

## 5. Baseline Creation

Successful build:

    Build #100 SUCCESS

Drain creates:

    T1 Checkout code
    T2 Compiling <*> files
    T3 Running <*>
    T4 Tests Passed
    T5 Build Success

Stored as:

    Baseline v1
    Templates:
    T1,T2,T3,T4,T5

------------------------------------------------------------------------

## 6. Template Update

New successful build arrives.

If templates already exist:

    Existing:
    T1,T2,T3,T4,T5

    New:
    T1,T2,T3,T4,T5

No new template is created.

Only metadata updates:

    Frequency:
    5000 -> 5001

------------------------------------------------------------------------

## 7. New Template Addition

Existing baseline:

    Compile
    Test
    Package

New successful build:

    Compile
    Security Scan
    Test
    Package

Security Scan is new.

Baseline becomes:

    Baseline v11

    Compile
    Security Scan
    Test
    Package

------------------------------------------------------------------------

## 8. Baseline Versioning

Do not delete old baseline immediately.

Use:

    Baseline v10
          |
          v
    Baseline v11
          |
          v
    Baseline v12

Benefits:

-   Rollback
-   Debug changes
-   Track evolution

Cleanup:

-   Keep latest N versions
-   Keep last N days

------------------------------------------------------------------------

## 9. Failed Build Baseline Lookup

Failed build provides:

    seal_id
    project
    repo
    execution type

Lookup:

    seal101/payments/payment-api/JULES

Fetch:

    Latest compatible baseline

Then:

    Failed Logs
        |
        v
    Drain
        |
        v
    Failed Templates
        |
        v
    Compare with Success Baseline

------------------------------------------------------------------------

## 10. Template Comparison

Success:

    Compile <*> files
    Running <*>
    Tests Passed

Failed:

    Compile 500 files
    Running PaymentTest
    Database Connection Failed

Drain:

    Compile <*> files
    Running <*>
    Database Connection Failed

Comparison:

    Compile <*> files
    Known

    Running <*>
    Known

    Database Connection Failed
    New

New templates become suspicious evidence.

------------------------------------------------------------------------

## 11. Branch Strategy

Baseline update branches:

    main/master
    release/*

Do not update baseline:

    feature branches
    temporary branches
    debug branches

Reason:

They can introduce temporary behavior and pollute the baseline.

------------------------------------------------------------------------

## 12. Skip Build Handling

Skipped builds are ignored.

    SKIPPED

Action:

    No Drain processing
    No template creation
    No baseline update

Reason:

Skipped builds do not represent successful pipeline behavior.

------------------------------------------------------------------------

## Final Decision

Storage:

    seal_id
     |
     project
       |
       repo
         |
         JULES/LATTICE
           |
           Versioned Baseline
             |
             Templates + Metadata

Stored knowledge:

    Templates
    +
    Frequency
    +
    Stage/DAG Metadata
    +
    Version History

Core principle:

We are not storing millions of successful logs.

We are storing a compact memory of normal pipeline behavior.




