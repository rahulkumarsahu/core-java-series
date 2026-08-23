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
