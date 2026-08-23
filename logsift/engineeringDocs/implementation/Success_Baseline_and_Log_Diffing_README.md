# Success Baseline Creation and Log Diffing Design

## Overview

This document explains how successful CI/CD logs create a reusable
baseline and how failed pipelines are compared against that baseline.

Architecture:

    Successful Logs
          |
          v
    Redaction
          |
          v
    Masking
          |
          v
    Normalization
          |
          v
    Drain Parsing
          |
          v
    Templates
          |
          v
    Success Baseline


    Failed Logs
          |
          v
    Same Preprocessing
          |
          v
    Failed Templates
          |
          v
    Log Diff
          |
          v
    Suspicious Evidence

------------------------------------------------------------------------

# 1. Success Baseline Creation

The success baseline represents:

> What does a normal pipeline execution look like?

We do not store complete successful logs.

We store learned patterns.

Example successful log:

    2026-08-23 Checkout repository payment-api commit=a82f923

    Compiling 450 files

    Running unit tests

    Tests completed successfully

After preprocessing:

    <TIMESTAMP> Checkout repository payment-api commit=<GIT_HASH>

    Compiling <*> files

    Running unit tests

    Tests completed successfully

Drain creates:

    T001:
    Checkout repository <*> commit=<GIT_HASH>

    T002:
    Compiling <*> files

    T003:
    Running unit tests

    T004:
    Tests completed successfully

------------------------------------------------------------------------

# 2. Stored Files

Recommended baseline storage:

    baseline/
     |
     |-- baseline.json
     |
     |-- templates.json
     |
     |-- drain3_state.json
     |
     |-- templates.md
     |
     |-- normalize_sample.txt

------------------------------------------------------------------------

# 3. drain3_state.json

Purpose:

Drain internal learning state.

Example:

``` json
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

Fields:

-   cluster_id: Drain generated identifier
-   template: learned log pattern
-   size: number of occurrences

------------------------------------------------------------------------

# 4. templates.json

Purpose:

Machine-readable template information used by our service.

Example:

``` json
{
 "template_id":"T001",
 "pattern":"Compiling <*> files",
 "execution_type":"JULES",
 "stage":"compile",
 "frequency":5000,
 "first_seen":"2026-01-01",
 "last_seen":"2026-08-23"
}
```

Fields:

## template_id

Unique identifier used during comparison.

## pattern

Reusable log pattern.

## execution_type

Possible values:

    JULES
    LATTICE

## stage

Used for sequential pipelines.

Example:

    compile
    test
    deploy

## frequency

How often the pattern appears.

## first_seen / last_seen

Lifecycle tracking.

------------------------------------------------------------------------

# 5. baseline.json

Purpose:

Connect templates with pipeline identity.

Example:

``` json
{
 "seal_id":"seal101",
 "project":"payments",
 "repo":"payment-api",
 "branch":"main",
 "execution_type":"JULES",
 "baseline_version":"v10",
 "templates":[
    "T001",
    "T002",
    "T003"
 ]
}
```

Fields:

-   seal_id: Jenkins instance identity
-   project: project name
-   repo: repository
-   execution_type: JULES/LATTICE
-   baseline_version: version of learned behavior
-   templates: list of template IDs

------------------------------------------------------------------------

# 6. Failed Pipeline Processing

Failed logs follow the same preprocessing.

    Failed Logs
          |
          v
    Redaction
          |
          v
    Masking
          |
          v
    Normalization
          |
          v
    Drain
          |
          v
    Failed Templates

Example failed logs:

    Checkout repository payment-api commit=b92f812

    Compiling 470 files

    Running unit tests

    Database connection refused

    Retry exhausted

Drain creates:

    FT001:
    Checkout repository <*> commit=<GIT_HASH>

    FT002:
    Compiling <*> files

    FT003:
    Running unit tests

    FT004:
    Database connection refused

    FT005:
    Retry exhausted

------------------------------------------------------------------------

# 7. Log Diff

Log diff does not compare raw logs.

It compares templates.

Example success baseline:

    T001 Checkout repository <*> commit=<GIT_HASH>

    T002 Compiling <*> files

    T003 Running unit tests

    T004 Tests completed successfully

Failed templates:

    FT001 Checkout repository <*> commit=<GIT_HASH>

    FT002 Compiling <*> files

    FT003 Running unit tests

    FT004 Database connection refused

    FT005 Retry exhausted

Comparison:

    FT001 -> T001
    NORMAL

    FT002 -> T002
    NORMAL

    FT003 -> T003
    NORMAL

    FT004 -> No match
    NOVEL

    FT005 -> No match
    NOVEL

Output:

    Suspicious Evidence:

    Database connection refused

    Retry exhausted

------------------------------------------------------------------------

# 8. Lattice Comparison

Lattice logs are different because execution is parallel.

We first separate by DAG node.

Example:

    Raw Logs

            |
            v

    DAG Node Separation


    Node:
    build:compile

    Node:
    test:unit

    Node:
    integration:test

Then Drain runs separately.

Example:

    LATTICE

    build:compile
        |
        Templates


    test:unit
        |
        Templates

During failure:

    Failed Node Template

            compare with

    Same Node Success Baseline

We do not compare unrelated nodes.

------------------------------------------------------------------------

# 9. Final Flow

    Successful Pipeline

    Normalize
    Mask
    Redact
    Drain
    Templates
    Baseline


    Failed Pipeline

    Normalize
    Mask
    Redact
    Drain
    Failed Templates
    Log Diff
    Suspicious Templates

------------------------------------------------------------------------

# Final Understanding

Success baseline stores:

    Templates
    +
    Pipeline Identity
    +
    Stage/DAG Metadata
    +
    Frequency
    +
    Version

Log Diff answers:

> What changed compared with normal behavior?

It does not generate RCA directly.

The suspicious evidence goes to:

    Context Expansion
            |
            v
    Scoring
            |
            v
    Token Selection
            |
            v
    LLM RCA
