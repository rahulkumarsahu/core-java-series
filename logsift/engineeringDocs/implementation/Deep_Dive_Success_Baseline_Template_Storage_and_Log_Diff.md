# Success Baseline, Template Storage and Log Diffing - Deep Dive

## Purpose of this document

This document explains the **purpose of every file**, **who creates
it**, **who reads it**, and **how failed pipeline comparison actually
happens**.

The goal is not only to understand the flow, but to understand:

-   Why do we store each file?
-   What information is inside?
-   Which service/code uses it?
-   During failure analysis, which files are fetched?
-   What exactly is compared?

------------------------------------------------------------------------

# 1. Complete Mental Model

Think about the system as having two phases.

## Phase 1: Offline Learning

The system learns:

"What does a successful pipeline normally look like?"

    Successful Pipeline Logs

            |
            v

    Normalize + Mask + Redact

            |
            v

    Drain Parser

            |
            v

    Template Creation

            |
            v

    Success Baseline Storage

------------------------------------------------------------------------

## Phase 2: Online Failure Analysis

When a pipeline fails:

    Failed Pipeline Logs

            |
            v

    Same Preprocessing

            |
            v

    Drain Creates Failed Templates

            |
            v

    Fetch Success Baseline

            |
            v

    Template Comparison

            |
            v

    Find New/Suspicious Logs

------------------------------------------------------------------------

# 2. What is a Success Baseline?

A success baseline is the memory of normal pipeline behavior.

It answers:

"If this pipeline usually succeeds, what logs should normally appear?"

Example:

A successful build normally contains:

    Checkout repository

    Compile code

    Run tests

    Create artifact

    Deploy

The baseline does not store:

-   Every build log
-   Every timestamp
-   Every commit hash

It stores patterns.

Example:

Instead of:

    Compiling 450 files
    Compiling 520 files
    Compiling 600 files

Store:

    Compiling <*> files

------------------------------------------------------------------------

# 3. Files Generated During Offline Processing

Recommended structure:

    baseline/

        baseline.json

        templates.json

        drain3_state.json

        templates.md

        normalize_sample.txt

Each file has a different purpose.

------------------------------------------------------------------------

# 4. drain3_state.json

## What is this?

This is Drain's own internal memory.

Drain is a machine learning style parser.

While processing logs, it creates:

-   clusters
-   templates
-   counters

This file allows Drain to continue learning.

Without this file:

Every restart:

    Start from zero

With this file:

    Continue from previous knowledge

------------------------------------------------------------------------

## Who creates it?

Drain library creates this.

Our service does not manually create it.

Example:

    Drain Parser Service

            |
            v

    drain3_state.json

------------------------------------------------------------------------

## Who reads it?

Only Drain parser reads it.

Example:

New successful build:

    New Logs

       |
       v

    Load drain3_state.json

       |
       v

    Find existing template

       |
       v

    Update cluster

------------------------------------------------------------------------

## Example

``` json
{
 "clusters":[
   {
    "cluster_id":1,
    "template":"Compiling <*> files",
    "size":5000
   }
 ]
}
```

Meaning:

    cluster_id:
    Internal Drain ID


    template:
    Pattern learned


    size:
    How many times seen

------------------------------------------------------------------------

# 5. templates.json

## Why do we need this if Drain already has state?

Important question.

Drain state is for Drain.

It does not understand our CI/CD world.

Drain knows:

    Compiling <*> files

But our system needs:

    This belongs to:

    seal101

    payment-api

    JULES

    compile stage

Therefore we create our own file.

------------------------------------------------------------------------

## Who creates it?

Our Log Processing Service creates it after Drain.

Flow:

    Drain Output

            |
            v

    Add CI/CD Metadata

            |
            v

    templates.json

------------------------------------------------------------------------

## Example

``` json
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

------------------------------------------------------------------------

## Purpose of fields

### template_id

Unique identity.

Used during comparison.

Example:

    T001

------------------------------------------------------------------------

### pattern

The actual reusable log pattern.

Example:

    Compiling <*> files

------------------------------------------------------------------------

### execution_type

Important because JULES and Lattice behave differently.

Values:

    JULES

    LATTICE

------------------------------------------------------------------------

### stage

For sequential pipelines.

Example:

    compile

    test

    deploy

------------------------------------------------------------------------

### node_name

For Lattice.

Example:

    integration-test

------------------------------------------------------------------------

### frequency

How common this event is.

Example:

    5000 times

Used later for confidence.

------------------------------------------------------------------------

# 6. baseline.json

## What problem does it solve?

Suppose we have:

    seal101

    payment project

    payment-api repo

There can be thousands of templates.

How do we know which templates belong to this pipeline?

baseline.json provides the mapping.

------------------------------------------------------------------------

## Who creates it?

Our baseline manager service.

------------------------------------------------------------------------

## Who reads it?

During failure.

Example:

Failed build arrives:

    seal101

    payment-api

    JULES

The service finds:

    baseline.json

Then gets:

    Use templates:

    T001
    T002
    T003

------------------------------------------------------------------------

## Example

``` json
{
 "seal_id":"seal101",

 "project":"payments",

 "repo":"payment-api",

 "execution_type":"JULES",

 "baseline_version":"v10",

 "template_ids":[
    "T001",
    "T002",
    "T003"
 ]
}
```

------------------------------------------------------------------------

# 7. templates.md

## Purpose

Human readable documentation.

Used by:

-   Engineers
-   Debugging
-   Reviewing baseline changes

Not used by runtime comparison.

Example:

``` md
Compile Stage

Template:

Compiling <*> files

Frequency:

5000
```

------------------------------------------------------------------------

# 8. normalize_sample.txt

## Purpose

Debugging preprocessing.

Before:

    commit=a8292837

After:

    commit=<GIT_HASH>

Useful when engineers ask:

"Why did Drain create a wrong template?"

------------------------------------------------------------------------

# 9. What happens when a failed pipeline comes?

Important:

Failed logs go through the SAME preprocessing.

Why?

Because comparison is impossible if formats are different.

Flow:

    Failed Raw Logs

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

    Failed templates

------------------------------------------------------------------------

# 10. Example Failed Template

Successful baseline:

    T001:
    Checkout repository <*> commit=<GIT_HASH>

    T002:
    Compiling <*> files

    T003:
    Running unit tests

    T004:
    Tests completed successfully

------------------------------------------------------------------------

Failed run:

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

# 11. Which files are fetched during comparison?

When failure happens:

## Step 1

Find pipeline identity.

Example:

    seal101

    payment-api

    JULES

------------------------------------------------------------------------

## Step 2

Fetch:

    baseline.json

Purpose:

Find correct baseline.

------------------------------------------------------------------------

## Step 3

Fetch:

    templates.json

Purpose:

Get actual success templates.

Example:

    T001
    T002
    T003
    T004

------------------------------------------------------------------------

## Step 4

Load failed templates from current execution.

Example:

    FT001
    FT002
    FT003
    FT004
    FT005

------------------------------------------------------------------------

# 12. What exactly is compared?

NOT:

    Raw log line
    against
    Raw log line

NOT:

    Complete log file
    against
    Complete log file

Comparison:

    Failed Template

            VS

    Success Template

------------------------------------------------------------------------

Example:

Failed:

    Compiling <*> files

Search success templates:

Found:

    T002:
    Compiling <*> files

Result:

    NORMAL

------------------------------------------------------------------------

Failed:

    Database connection refused

Search success templates:

No match.

Result:

    NOVEL

    Potential failure evidence

------------------------------------------------------------------------

# 13. Real Production Log Diff Output

The output should look like:

``` json
{
 "matched_templates":[
   "T001",
   "T002",
   "T003"
 ],

 "new_templates":[
   {
    "template":
    "Database connection refused",

    "confidence":
    "HIGH"
   }
 ]
}
```

------------------------------------------------------------------------

# 14. Lattice Difference

For Lattice:

Do not compare the whole pipeline.

First separate:

    Node:
    build:compile

    Node:
    test:unit

    Node:
    integration-test

Then:

    Failed Node Template

            compare with

    Same Node Success Templates

Example:

    integration-test

    Success:

    Connecting database <HOST>


    Failure:

    Database connection refused

Only this node comparison matters.

------------------------------------------------------------------------

# Final Summary

## Offline

Creates:

    drain3_state.json

    +
    templates.json

    +
    baseline.json

Purpose:

Learn normal behavior.

------------------------------------------------------------------------

## Online Failure

Reads:

    baseline.json

            |
            v

    templates.json

            |
            v

    Compare with failed templates

Purpose:

Find:

"What changed from normal?"

------------------------------------------------------------------------

The output of Log Diff is not the final RCA.

It produces evidence for:

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
