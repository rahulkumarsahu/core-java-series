# LogSift --- Intelligent CI/CD Log Reduction System

## Architecture Notes and Design Decisions

## 1. Overview

Modern CI/CD pipelines generate a massive amount of logs. In enterprise
environments, a single failed execution can produce thousands or
millions of log lines.

Sending complete logs directly to an LLM creates several challenges:

-   High token consumption
-   Increased latency
-   Difficulty identifying the real failure signal
-   Large amount of irrelevant context
-   Higher RCA cost

LogSift solves this problem by introducing an intelligent log analysis
layer before LLM-based RCA.

The objective is not to remove logs blindly.

The objective is:

> Learn what a healthy pipeline normally looks like and identify the
> meaningful differences when a pipeline fails.

------------------------------------------------------------------------

# 2. Core Concept

LogSift works in two phases.

## Phase 1: Offline Learning

The system learns normal pipeline behavior from successful executions.

    Successful Pipeline Logs

            |
            v

    Pipeline Metadata Extraction

    (JULES/LATTICE, stage, DAG node)

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

    Reusable Templates

            |
            v

    Success Baseline

The output of this phase is a compact representation of normal behavior.

The system does not store every successful log.

It stores patterns.

Example:

Instead of storing:

    Compiling 450 files
    Compiling 520 files
    Compiling 610 files

The baseline stores:

    Compiling <*> files

------------------------------------------------------------------------

## Phase 2: Online Failure Analysis

When a pipeline fails:

    Failed Pipeline Logs

            |
            v

    Same Preprocessing Pipeline

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

    Candidate Evidence

            |
            v

    Context Expansion

            |
            v

    Scoring and Ranking

            |
            v

    Evidence Pack

            |
            v

    LLM RCA

------------------------------------------------------------------------

# 3. Pipeline Types Supported

LogSift supports two execution models:

## JULES

JULES pipelines are sequential.

Example:

    Checkout
       |
    Compile
       |
    Test
       |
    Package

The log order usually follows execution order.

------------------------------------------------------------------------

## LATTICE

LATTICE pipelines are DAG-based.

Multiple nodes can execute in parallel.

Example:

              build:compile

                  |

           -----------------

           |               |

     test:unit       integration-test

The console output can be interleaved.

Example:

    Line 100:
    compile started

    Line 101:
    integration test started

    Line 102:
    compile completed

Because of this, LATTICE logs cannot be treated as one sequential
stream.

The system must preserve logical execution identity:

    build_type:stage_name

Example:

    build:compile

    test:unit

    test:integration

------------------------------------------------------------------------

# 4. Pipeline Type Detection Decision

LogSift should not guess pipeline type based on log appearance.

Incorrect approach:

    Logs look sequential
            |
            v
    Assume JULES

or:

    Logs are interleaved
            |
            v
    Assume LATTICE

The correct approach:

-   JULES and LATTICE should expose stable signatures.
-   The service checks a bounded beginning section of the log.
-   The result is:

```{=html}
<!-- -->
```
    JULES

    LATTICE

    UNKNOWN

The system should never scan a complete million-line log only to
determine pipeline type.

------------------------------------------------------------------------

# 5. Baseline Storage Design

## Decision

The initial baseline ownership model is:

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

    payments

    payment-api

        |
        +-- JULES
        |      |
        |      +-- baseline-v1
        |
        +-- LATTICE
               |
               +-- baseline-v1

## Why this design?

This matches the current CI ownership model.

It provides:

-   Simple lookup
-   Clear ownership
-   Separation between execution models

------------------------------------------------------------------------

# 6. Baseline Versioning

Baselines are versioned.

Example:

    payment-api

        baseline-v1

        baseline-v2

        baseline-v3

Reasons:

-   Pipeline behavior changes over time
-   Incorrect updates should be reversible
-   Changes need auditing
-   RCA should know which baseline was used

------------------------------------------------------------------------

# 7. Baseline Creation Strategy

## Important Decision

Every successful pipeline should not update the baseline.

Reason:

Large organizations may run thousands of successful builds daily.

Processing every success creates:

-   unnecessary compute cost
-   unnecessary storage
-   noisy templates

Instead:

    Successful Run

          |

    Eligibility Check

          |

    Selected?

          |

    Yes ----> Update baseline

    No  ----> Ignore

------------------------------------------------------------------------

# 8. Which Runs Can Update Baseline?

Only trusted branches should contribute.

Initially:

Included:

    main/master

    release branches

Excluded:

    feature branches

    temporary branches

    developer branches

Reason:

Feature branches may introduce temporary pipeline behavior.

Example:

Normal:

    Compile
    Test
    Package

Feature branch:

    Compile
    Test
    Security Scan
    Package

This temporary change should not redefine normal behavior.

------------------------------------------------------------------------

# 9. Stored Artifacts

The baseline contains multiple artifacts.

    baseline/

        baseline.json

        templates.json

        drain3_state.json

        templates.md

        normalize_sample.txt

Each file has a different responsibility.

------------------------------------------------------------------------

# 10. drain3_state.json

## Purpose

`drain3_state.json` is Drain's internal memory.

It stores:

-   clusters
-   template structure
-   learned patterns
-   counters

Think of it as:

> How does Drain continue understanding logs?

Example:

    Compiling <*> files

Drain remembers this pattern and continues updating it.

------------------------------------------------------------------------

## Usage

Used by:

    Drain Parser

It is not the primary comparison database for Log Diff.

------------------------------------------------------------------------

# 11. templates.json

## Purpose

`templates.json` is LogSift's application-level template store.

Drain understands patterns.

LogSift understands CI/CD meaning.

Example:

Drain knows:

    Compiling <*> files

LogSift stores:

    Template:

    Compiling <*> files

    Repository:
    payment-api

    Execution Type:
    JULES

    Stage:
    compile

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

This file is used during:

-   Log Diff
-   Baseline lookup
-   RCA preparation

------------------------------------------------------------------------

# 12. baseline.json

## Purpose

`baseline.json` answers:

> Which templates belong to this pipeline?

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

During failure analysis:

    Failed Build

          |

    Find baseline.json

          |

    Identify correct templates

          |

    Load templates.json

------------------------------------------------------------------------

# 13. templates.md and normalize_sample.txt

These are engineer-facing artifacts.

## templates.md

Purpose:

-   baseline review
-   debugging
-   documentation

Not used by runtime comparison.

------------------------------------------------------------------------

## normalize_sample.txt

Purpose:

Show preprocessing behavior.

Example:

Before:

    commit=a82f923

After:

    commit=<GIT_HASH>

Useful when debugging incorrect templates.

------------------------------------------------------------------------

# 14. Preprocessing Pipeline

Before Drain receives logs:

    Raw Logs

       |

    Metadata Extraction

       |

    Redaction

       |

    Masking

       |

    Normalization

       |

    Drain

------------------------------------------------------------------------

# 15. Normalization

Normalization makes different executions comparable.

Example:

Before:

    Compiling 452 files

    Compiling 623 files

After:

    Compiling <*> files

Common normalized values:

-   timestamp
-   build number
-   commit hash
-   UUID
-   duration
-   file path
-   IP address
-   container identifiers

Important:

Normalization should remove noise, not meaning.

------------------------------------------------------------------------

# 16. Redaction

Redaction removes information completely.

Used for:

-   passwords
-   API tokens
-   private keys
-   cloud secrets

Example:

Before:

    password=mySecret

After:

    password=<REDACTED>

The actual value should never reach downstream systems.

------------------------------------------------------------------------

# 17. Masking

Masking hides values while keeping useful structure.

Example:

Before:

    builder-node-182

After:

    <BUILDER_NODE>

The value changes, but the information type remains.

------------------------------------------------------------------------

# 18. Drain Processing

Drain's responsibility:

> Convert similar log messages into reusable templates.

Drain does not know:

-   pipeline type
-   stage
-   failure status
-   repository

Metadata is provided by LogSift.

Drain processing:

    Tokens

        |

    Length grouping

        |

    Tree traversal

        |

    Similarity matching

        |

    Template creation

Example:

Input:

    Compiling 500 files

    Compiling 700 files

Output:

    Compiling <*> files

------------------------------------------------------------------------

# 19. Log Diff Design

The Log Diff stage does not compare raw logs.

Incorrect:

    Failed raw log

    against

    Successful raw log

Correct:

    Failed canonical template

    against

    Successful canonical template

------------------------------------------------------------------------

# 20. Failure Analysis Flow

When a pipeline fails:

## Step 1

Identify execution:

    seal_id

    project

    repo

    JULES/LATTICE

## Step 2

Read:

    baseline.json

Find correct baseline.

## Step 3

Read:

    templates.json

Load success templates.

## Step 4

Generate failed templates using the same preprocessing.

## Step 5

Compare:

    Failed Templates

            VS

    Success Templates

------------------------------------------------------------------------

# 21. Template Comparison Example

Success baseline:

    Connecting to <HOST>:<PORT>

Failed run:

    Connecting to <HOST>:<PORT>

Result:

    Known behavior

------------------------------------------------------------------------

Success baseline:

    Tests completed successfully

Failed run:

    Database connection refused

Result:

    Novel evidence

------------------------------------------------------------------------

# 22. Critical Safety Rule

Never implement:

    Template exists in success

            |

    Delete the log

Correct behavior:

    Template exists in success

            |

    Reduce novelty score

A known event can still become important if:

-   frequency increases abnormally
-   it appears in failed stage
-   it occurs near failure
-   it is combined with exception signals

------------------------------------------------------------------------

# 23. Final Output of Log Diff

Log Diff should produce evidence.

Example:

``` json
{
 "template":"Connection refused",
 "reasons":[
    "NOVEL_VS_SUCCESS",
    "FAILED_STAGE"
 ]
}
```

It should not directly generate RCA.

------------------------------------------------------------------------

# 24. Complete System Flow

    Successful Runs

           |

    Learn Normal Behavior

           |

    Create Baseline


    Failed Run

           |

    Find Differences

           |

    Extract Evidence

           |

    Generate RCA

------------------------------------------------------------------------

# Final Principle

LogSift is not a log deletion system.

It is a pipeline intelligence system.

The goal is:

> Reduce millions of raw log lines into a small, explainable set of
> evidence that helps engineers and LLMs identify the real root cause
> faster.
