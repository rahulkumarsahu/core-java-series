# LogSift --- Complete CI/CD Intelligent Log Reduction Design

## Purpose

This document consolidates the LogSift design discussions into one
complete engineering reference.

The goal is to explain:

-   Why LogSift exists
-   How offline learning works
-   How successful pipeline behavior is stored
-   How Normalize, Redaction, Masking, and Drain work together
-   How JULES and LATTICE pipelines are handled
-   How failed runs are compared against successful behavior
-   What decisions were made and why

The core idea:

> Learn what a healthy pipeline looks like from selected successful
> runs, then use that knowledge to reduce failed logs into high-value
> evidence for RCA.

------------------------------------------------------------------------

# 1. Problem Statement

CI/CD systems generate huge logs.

A failed pipeline may contain:

-   hundreds of thousands of lines
-   repeated information
-   timestamps
-   IDs
-   build numbers
-   infrastructure details
-   parallel execution noise

Sending complete logs directly to an LLM creates problems:

-   high token cost
-   slower analysis
-   irrelevant context
-   difficult RCA

LogSift introduces an intelligent reduction layer.

Instead of:

    Raw Logs
        |
        v
    LLM

we build:

    Raw Logs
        |
        v
    LogSift Processing
        |
        v
    Evidence Pack
        |
        v
    LLM RCA

------------------------------------------------------------------------

# 2. High Level Architecture

                     Offline Learning

    Successful Logs
           |
           v
    Metadata Extraction
    (JULES/LATTICE, stage, node)
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
    Drain Parser
           |
           v
    Reusable Templates
           |
           v
    Success Baseline


                     Online Failure Analysis

    Failed Logs
           |
           v
    Same Processing Pipeline
           |
           v
    Failed Templates
           |
           v
    Success Baseline Lookup
           |
           v
    Template Comparison
           |
           v
    Candidates
           |
           v
    Context Expansion
           |
           v
    Scoring + Ranking
           |
           v
    Evidence Pack
           |
           v
    LLM RCA

------------------------------------------------------------------------

# 3. Pipeline Type Detection

LogSift supports:

-   JULES
-   LATTICE

The decision:

Do not guess from log ordering.

The service should use stable signatures available in the first bounded
part of the log.

Flow:

    First N lines
          |
          v
    Find pipeline signature
          |
          +---- JULES
          |
          +---- LATTICE
          |
          +---- UNKNOWN

The system should not scan million-line logs only to identify the
pipeline type.

------------------------------------------------------------------------

# 4. Baseline Storage Decision

V1 storage hierarchy:

    seal_id
       |
       project
          |
          repo
              |
              JULES / LATTICE
                  |
                  baseline versions

Example:

    seal101
     |
     payments
     |
     payment-api
     |
     +-- JULES
     |     |
     |     +-- baseline-v1
     |
     +-- LATTICE
           |
           +-- baseline-v1

Reason:

-   matches CI ownership
-   simple initially
-   avoids unnecessary complexity

Future improvement:

Add pipeline fingerprint if multiple unrelated pipeline definitions
create baseline pollution.

------------------------------------------------------------------------

# 5. JULES vs LATTICE Baseline Organization

## JULES

JULES is sequential.

Example:

    JULES

    checkout
       |
    compile
       |
    test
       |
    package

Store templates by stage:

    JULES
     |
     checkout
        T1,T2

     compile
        T3,T4

     test
        T5,T6

------------------------------------------------------------------------

## LATTICE

LATTICE is DAG based.

Logs can be interleaved.

Never treat the complete console as one stream.

Wrong:

    All LATTICE logs
          |
          v
    Single Drain stream

Correct:

    LATTICE

    //build:compile
          |
          templates

    //test:unit
          |
          templates

    //test:integration
          |
          templates

Comparison should happen inside the same logical node.

------------------------------------------------------------------------

# 6. Offline Baseline Creation

Important decisions:

## Do not process every successful build

Reason:

Large companies may have lakhs of executions.

Instead:

    Successful Run
          |
          v
    Eligibility Check
          |
          v
    Selected?
          |
          +---- Yes --> Update baseline
          |
          +---- No  --> Ignore

------------------------------------------------------------------------

## Trusted branches only

Included:

-   main/master
-   release branches

Excluded:

-   feature branches
-   temporary branches

Reason:

Temporary changes should not pollute normal behavior.

------------------------------------------------------------------------

## Store templates, not complete successful logs

Do not store:

    Build #100 logs
    Build #101 logs
    Build #102 logs

Store:

    Compiling <*> files

    Running tests

    Deployment completed

The baseline represents behavior, not history.

------------------------------------------------------------------------

# 7. Stored Files

The baseline contains multiple files because each solves a different
problem.

    baseline/
     |
     +-- baseline.json
     +-- templates.json
     +-- drain3_state.json
     +-- templates.md
     +-- normalize_sample.txt

------------------------------------------------------------------------

# 8. drain3_state.json

Purpose:

Drain internal memory.

It stores:

-   clusters
-   tree structure
-   learned patterns
-   counters

Think:

    drain3_state.json

    "How does Drain continue learning?"

Used by:

    Drain parser

Not used directly for Log Diff comparison.

------------------------------------------------------------------------

# 9. templates.json

Purpose:

Application-level template knowledge.

Drain knows:

    Compiling <*> files

But LogSift needs:

    seal101
    payments
    payment-api
    JULES
    compile stage
    Template T001

Example:

``` json
{
 "template_id":"T001",
 "pattern":"Compiling <*> files",
 "execution_type":"JULES",
 "stage":"compile",
 "frequency":5000
}
```

Used by:

-   Log Diff
-   baseline manager
-   RCA pipeline

------------------------------------------------------------------------

# 10. baseline.json

Purpose:

Find which templates belong to a pipeline.

Example:

``` json
{
 "seal_id":"seal101",
 "project":"payments",
 "repo":"payment-api",
 "execution_type":"JULES",
 "baseline_version":"v1",
 "templates":[
    "T001",
    "T002"
 ]
}
```

During failure:

    Failed Build
          |
          v
    Find baseline.json
          |
          v
    Get template IDs
          |
          v
    Load templates.json

------------------------------------------------------------------------

# 11. Normalization

Normalization answers:

> Can different logs look identical for comparison?

Example:

Before:

    Compiling 452 files
    Compiling 600 files

After:

    Compiling <*> files

Common normalization:

-   timestamp
-   build ID
-   commit hash
-   UUID
-   duration
-   file path
-   IP
-   node identifiers

Important:

Do not remove meaning.

Bad:

    Database failure

becomes:

    <TEXT>

Good:

    Database failure for <SERVICE>

------------------------------------------------------------------------

# 12. Redaction vs Masking

## Redaction

Question:

Should this value disappear completely?

Examples:

    password
    API token
    private key
    cloud secret

Output:

    <REDACTED>

------------------------------------------------------------------------

## Masking

Question:

Can we hide the value but preserve debugging information?

Example:

    builder-node-182

becomes:

    <BUILDER_NODE>

------------------------------------------------------------------------

# 13. Drain Processing

Drain responsibility:

> Convert repeated log messages into reusable templates.

Drain does not know:

-   Jenkins
-   failure
-   stage
-   JULES
-   LATTICE

Metadata is provided by LogSift.

Flow:

    Clean Logs
          |
          v
    Drain
          |
          v
    Templates

Drain internally:

1.  Tokenizes logs
2.  Groups by length
3.  Traverses fixed depth tree
4.  Checks similarity
5.  Creates templates

Example:

Input:

    Compiling 500 files
    Compiling 700 files

Output:

    Compiling <*> files

------------------------------------------------------------------------

# 14. Failed Pipeline Comparison

Important:

Failed logs use the same preprocessing.

Why?

Because comparison requires the same representation.

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
    Failed Templates

------------------------------------------------------------------------

# 15. Which Files Are Used During Log Diff?

When failure happens:

## Step 1

Identify:

    seal_id
    project
    repo
    execution_type

## Step 2

Read:

    baseline.json

Purpose:

Find correct baseline.

## Step 3

Read:

    templates.json

Purpose:

Get successful templates.

## Step 4

Compare:

    Failed templates
            VS
    Success templates

------------------------------------------------------------------------

# 16. What Is Compared?

Not:

    Raw line vs raw line

Not:

    Complete log vs complete log

Instead:

    Failed canonical template

            VS

    Success canonical template

Example:

Success:

    Connecting to <HOST>:<PORT>

Failed:

    Connecting to <HOST>:<PORT>

Result:

    Known pattern

------------------------------------------------------------------------

Failed:

    Connection refused

Success:

    Not found

Result:

    Novel evidence

------------------------------------------------------------------------

# 17. Important Safety Rule

Do not do:

    Template exists in success
            |
            v
    Delete log

Correct:

    Template exists in success
            |
            v
    Lower novelty score

A known event can still become important due to:

-   frequency explosion
-   failure context
-   stage location
-   tail position

------------------------------------------------------------------------

# 18. Final Log Diff Output

Log Diff produces evidence.

Example:

``` json
{
 "candidate":"Connection refused",
 "reasons":[
   "NOVEL_VS_SUCCESS",
   "FAILED_STAGE"
 ]
}
```

It does not produce RCA.

Next stages:

    Candidates
         |
         v
    Dedup
         |
         v
    Context Expansion
         |
         v
    Scoring
         |
         v
    Evidence Pack
         |
         v
    LLM RCA

------------------------------------------------------------------------

# 19. Final Mental Model

    Offline:

    Successful Logs
          |
          v
    Learn Normal Behavior
          |
          v
    Store Templates


    Online:

    Failed Logs
          |
          v
    Find What Changed
          |
          v
    Send Only Important Evidence
          |
          v
    Generate RCA

The main principle:

> LogSift does not remove logs blindly. It learns normal behavior and
> highlights differences that deserve investigation.
