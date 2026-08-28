# Logsift examples

This directory contains only the example sets used by the current `LogSift.md` design.

- [`offline-flow/`](offline-flow/) shows source events, normalization, redaction, masking, segmentation, Drain templates, parser state, and successful baseline manifests for Jules and Lattice.
- [`final-design/`](final-design/) shows the complete selected failure-analysis design: failed summary, LogDiff, candidate-only pointers, per-segment expansion, classified log blocks, scoring, evidence pack, and model input.

All example logs, credentials, identifiers, measurements, and repository names are synthetic test data.

The default design does not create a permanent line-level sidecar. Failed logs use two streaming passes and persist exact pointers only for selected candidates and evidence fragments.
