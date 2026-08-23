

# 6. JULES baseline organization

For JULES, the pipeline is sequential.

A baseline can look conceptually like:

```text
SEAL-101
Payments
payment-api
ci-build
JULES
        |
        ├── checkout
        │     ├── T1
        │     └── T2
        │
        ├── compile
        │     ├── T3
        │     └── T4
        │
        ├── test
        │     ├── T5
        │     └── T6
        │
        └── package
              ├── T7
              └── T8
```

Even though JULES is sequential, stage-aware storage is still useful.

---

# 7. Lattice baseline organization

For Lattice, I would go one level deeper.

You already have logical node identity like:

```text
//build_type: stage_name
```

So instead of treating the whole interleaved console as one bucket:

```text
Lattice baseline
    ↓
all templates mixed together
```

prefer:

```text
Lattice baseline
        |
        ├── //build: compile
        │       ├── T10
        │       └── T11
        │
        ├── //test: unit
        │       ├── T20
        │       └── T21
        │
        └── //test: integration
                ├── T30
                └── T31
```

This becomes very useful later.

If a failed line belongs to:

```text
//test: integration
```

we can compare it primarily against successful templates for:

```text
//test: integration
```

instead of templates from unrelated parallel stages.

---