# LogSift Preprocessing Pipeline

# Normalization, Redaction and Masking Design Notes

## 1. Overview

Before LogSift creates reusable templates using Drain, raw CI/CD logs
must go through a preprocessing layer.

The purpose of this layer is:

-   Remove unwanted sensitive information
-   Hide changing values that create unnecessary template variations
-   Preserve important debugging context
-   Make logs consistent so Drain can identify repeating patterns

The preprocessing pipeline is:

    Raw CI/CD Logs
            |
            v
    Pipeline Metadata Extraction
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

The output should be logs that are:

-   Safe
-   Comparable
-   Useful for template generation
-   Suitable for later RCA

------------------------------------------------------------------------

# 2. Why Preprocessing Is Required

CI/CD logs contain many values that change every execution but do not
change the actual meaning.

Example:

Run 1:

    Compiling 452 files

Run 2:

    Compiling 623 files

Without preprocessing, Drain may consider them different:

    Template 1:
    Compiling 452 files

    Template 2:
    Compiling 623 files

But logically they represent the same behavior:

    Compiling <*> files

Preprocessing helps Drain learn reusable patterns.

------------------------------------------------------------------------

# 3. Three Different Concepts

Normalization, Masking, and Redaction solve different problems.

  Concept         Main Question
  --------------- -----------------------------------------------------------
  Normalization   Can different logs look the same for comparison?
  Masking         Can we hide the value but preserve debugging information?
  Redaction       Should this information completely disappear?

------------------------------------------------------------------------

# 4. Redaction

## Purpose

Redaction removes information completely because it should never flow to
downstream systems.

The principle:

    Secret comes in

          |

    Remove it

          |

    Never reaches Drain or LLM

------------------------------------------------------------------------

## Examples

### Password

Before:

    username=payment-service
    password=MySecretPassword123

After:

    username=payment-service
    password=<REDACTED>

The actual password provides no debugging value.

------------------------------------------------------------------------

### API Token

Before:

    Authorization:
    Bearer eyJhbGciOiJIUzI1NiIs...

After:

    Authorization:
    Bearer <REDACTED>

------------------------------------------------------------------------

### Private Key

Before:

    -----BEGIN PRIVATE KEY-----
    ABCXYZ123
    -----END PRIVATE KEY-----

After:

    <PRIVATE_KEY_REMOVED>

------------------------------------------------------------------------

## Values That Should Usually Be Redacted

CI/CD examples:

    password
    passwd
    pwd
    secret
    token
    apikey
    api_key

Authentication:

    Authorization headers
    Bearer tokens
    Basic authentication

Certificates:

    private keys
    .pem content
    SSH keys

Cloud secrets:

    AWS_SECRET_ACCESS_KEY
    Azure client secrets
    GCP service account keys

Database credentials:

Before:

    jdbc:mysql://db:3306/payment?user=root&password=abc123

After:

    jdbc:mysql://db:3306/payment?user=root&password=<REDACTED>

------------------------------------------------------------------------

# 5. Masking

## Purpose

Masking hides dynamic or sensitive values while keeping enough
information for debugging.

The value changes, but the structure remains.

------------------------------------------------------------------------

## Examples

### User Information

Before:

    User email:
    rahul.kumar@company.com

After:

    User email:
    r****r@company.com

Why?

Because sometimes the format or identity relationship matters.

------------------------------------------------------------------------

### Container ID

Before:

    Starting container:
    8f93a83bc992821

After:

    Starting container:
    <CONTAINER_ID>

------------------------------------------------------------------------

### Builder Node

Before:

    Running on builder-node-182

After:

    Running on <BUILDER_NODE>

------------------------------------------------------------------------

# 6. Difference Between Redaction and Masking

## Password

Input:

    password=hello123

Redaction:

    password=<REDACTED>

Reason:

The value itself has no debugging value.

------------------------------------------------------------------------

## Username

Input:

    user=rahul

Masking:

    user=r****

Reason:

Some identity information may still be useful.

------------------------------------------------------------------------

# 7. Normalization

## Purpose

Normalization makes changing values consistent so Drain can identify the
same pattern.

Example:

Before:

    Build started at 10:20:31

    Build started at 10:25:45

After:

    Build started at <TIMESTAMP>

The information is not sensitive.

It is simply converted into a reusable pattern.

------------------------------------------------------------------------

# 8. Normalization Examples in CI/CD

## Timestamp

Before:

    2026-08-22 10:15:23 Starting build

    2026-08-22 11:42:56 Starting build

After:

    <TIMESTAMP> Starting build

------------------------------------------------------------------------

## Build Number

Before:

    Building project payment-api #1023

    Building project payment-api #1024

After:

    Building project payment-api #<BUILD_ID>

------------------------------------------------------------------------

## Git Commit

Before:

    Checking out commit:
    a8f93d82ab73d92

After:

    Checking out commit:
    <GIT_COMMIT>

------------------------------------------------------------------------

## UUID

Before:

    pipelineUUID=8f93d92a-1234-4567

After:

    pipelineUUID=<UUID>

------------------------------------------------------------------------

## File Path

Before:

    /home/jenkins/workspace/payment/build/output.jar

After:

    <WORKSPACE>/payment/build/output.jar

------------------------------------------------------------------------

## IP Address

Before:

    Connecting to 10.20.30.40

After:

    Connecting to <IP>

------------------------------------------------------------------------

## Duration

Before:

    Build completed in 123 seconds

After:

    Build completed in <DURATION> seconds

------------------------------------------------------------------------

# 9. Rule Driven Processing

Normalization, masking, and redaction should not be hardcoded.

Use configuration files.

Recommended structure:

    log-processing-rules/

        normalization-rules.yaml

        masking-rules.yaml

        redaction-rules.yaml

Example:

    timestamp:
        pattern: timestamp regex
        replacement: <TIMESTAMP>

Benefits:

-   New log formats can be supported without code changes
-   Rules can evolve with CI/CD systems
-   Easier maintenance

------------------------------------------------------------------------

# 10. Important Design Rule: Do Not Over-Process Logs

Bad:

Before:

    Database connection failed for user payment-service

After:

    <ALL_TEXT>

Problem:

The important meaning is destroyed.

Drain cannot learn useful templates.

------------------------------------------------------------------------

Correct:

    Database connection failed for user <SERVICE>

The dynamic value changes, but the failure meaning remains.

------------------------------------------------------------------------

# 11. Important Rule for LATTICE Pipelines

LATTICE logs contain DAG execution identity.

Example:

     //test:integration
     Database connection failed

Never remove:

    build_type:stage_name
    node_name
    DAG relationship information

Wrong:

    <STAGE>
    Database connection failed

Because later LogSift cannot know where the failure happened.

Correct principle:

> Normalize dynamic values, but preserve execution identity.

------------------------------------------------------------------------

# 12. Final Processing Flow

    Raw Logs

        |

    Extract Pipeline Metadata

        |

    Redaction
    (remove secrets)

        |

    Masking
    (hide dynamic values while preserving meaning)

        |

    Normalization
    (convert changing values into common patterns)

        |

    Drain Parser

        |

    Reusable Templates

------------------------------------------------------------------------

# 13. How This Helps Drain

Drain's responsibility is template creation.

The preprocessing layer ensures:

Before:

    Connecting with token abc123

    Connecting with token xyz789

Drain may create:

    Connecting with token abc123

    Connecting with token xyz789

After preprocessing:

    Connecting with token <REDACTED>

Drain creates:

    Connecting with token <REDACTED>

One reusable template is created.

------------------------------------------------------------------------

# 14. Final Design Principle

The preprocessing layer should balance two goals:

## Remove noise

Examples:

-   timestamps
-   build IDs
-   secrets
-   tokens
-   UUIDs

## Preserve meaning

Examples:

-   failure messages
-   stage identity
-   DAG node information
-   exception types
-   important error context

The objective is:

> Create clean, safe, and meaningful logs that allow Drain and LogSift
> to learn normal CI/CD behavior accurately.
