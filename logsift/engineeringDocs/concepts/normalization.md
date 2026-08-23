your JULES and Lattice logs. Before Drain creates templates, **normalization is the cleaning intelligence layer**.

The simple idea:

> Raw CI/CD logs contain many values that change in every run but do not change the meaning. Normalization converts those changing values into a common format so Drain can recognize the same pattern.

Without normalization:

Run 1:

```
Compiling 452 files
```

Run 2:

```
Compiling 623 files
```

Drain may think:

```
Template 1:
Compiling 452 files

Template 2:
Compiling 623 files
```

But actually both mean:

```
Compiling <*> files
```

Normalization helps Drain understand they are the same.

---

# Where normalization fits in our architecture

From our diagram:

```
Successful / Failed Logs
          |
          ↓
Normalize + Mask
          |
          ↓
Drain
          |
          ↓
Templates
```

Normalization happens before Drain.

---

# What normalization will do in our CI/CD logs?

Based on your logs, I see these categories.

---

# 1. Timestamp normalization

Problem:

Every log run has different timestamps.

Example:

Run 1:

```
2026-08-22 10:15:23 Starting build
```

Run 2:

```
2026-08-22 11:42:56 Starting build
```

These are the same event.

Normalize:

```
<TIMESTAMP> Starting build
```

---

# 2. Build number normalization

Jenkins creates different build numbers.

Example:

```
Building project payment-api #1023
```

Next run:

```
Building project payment-api #1024
```

Normalize:

```
Building project payment-api #<BUILD_ID>
```

---

# 3. Commit hash normalization

Your logs contain Git information.

Example:

```
Checking out commit:
a8f93d82ab73d92
```

Another run:

```
Checking out commit:
bc9238ef92133
```

Normalize:

```
Checking out commit:
<GIT_COMMIT>
```

---

# 4. Repository URL normalization

Example:

```
Fetching repository ssh://git.company.com/payment-api.git
```

Different repositories:

```
Fetching repository ssh://git.company.com/order-api.git
```

Normalize:

```
Fetching repository <REPOSITORY>
```

---

# 5. UUID normalization

Your pipeline logs have identifiers like:

```
pipelineUUID=8f93d92a-1234-4567
```

Every execution changes.

Normalize:

```
pipelineUUID=<UUID>
```

---

# 6. User / ID normalization

Example:

```
Connecting user 12345
```

Next run:

```
Connecting user 67891
```

Normalize:

```
Connecting user <ID>
```

---

# 7. File path normalization

Very common in build logs.

Example:

```
/home/jenkins/workspace/payment/build/output.jar
```

Another machine:

```
/builder/node22/workspace/payment/build/output.jar
```

Normalize:

```
<WORKSPACE>/payment/build/output.jar
```

---

# 8. IP Address normalization

Example:

```
Connecting to 10.20.30.40
```

Normalize:

```
Connecting to <IP>
```

---

# 9. Container / Node identifiers

Because you have multiple builder nodes.

Example:

```
Running on builder-node-182
```

Next run:

```
Running on builder-node-223
```

Normalize:

```
Running on <BUILDER_NODE>
```

---

# 10. Duration normalization

Example:

```
Build completed in 123 seconds
```

Next:

```
Build completed in 145 seconds
```

Normalize:

```
Build completed in <DURATION> seconds
```

---

# Now your idea: Rule file driven normalization

I think this is the correct approach.

Do not hardcode normalization rules inside Python.

Create a configuration-driven system.

Example:

```
normalization-rules.yaml
```

Example:

```yaml
rules:

  - name: timestamp
    pattern: "\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"
    replace: "<TIMESTAMP>"

  - name: uuid
    pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F-]{36}"
    replace: "<UUID>"

  - name: git_commit
    pattern: "[a-f0-9]{40}"
    replace: "<GIT_COMMIT>"

  - name: ip_address
    pattern: "\d+\.\d+\.\d+\.\d+"
    replace: "<IP>"
```

Python service:

```
Read rules.yaml

      |
      ↓

Read log line

      |
      ↓

Apply matching rules

      |
      ↓

Return normalized log
```

---

# Why rule-based normalization is good for your company?

Because CI/CD logs evolve.

Today:

```
Jenkins
JULES
Lattice
```

Tomorrow:

```
New build tool
New cloud provider
New logging format
```

You don't need code changes.

You only add:

```
new-rule.yaml
```

---

# Important: Do not over-normalize

This is very important.

Wrong:

Before:

```
Database connection failed for user payment-service
```

After:

```
<ALL_TEXT>
```

You destroyed useful information.

Drain cannot learn.

---

Correct:

```
Database connection failed for user <SERVICE>
```

Keep the meaning.

---

# For Lattice specifically

Normalization should NOT remove:

```
 //build_type:stage_name
```

Example:

Keep:

```
 //test:integration
Database connection failed
```

Because later:

```
Template
+
DAG node
```

is needed.

So rule:

```
Normalize dynamic values

Do not normalize execution identity
```

---

# Recommended design

```
Raw Logs
    |
    ↓
Pipeline Metadata Extraction
    |
    ↓
Normalization Engine
    |
    |
    +---- Reads normalization-rules.yaml
    |
    ↓
Masked + Normalized Logs
    |
    ↓
Drain Parser
    |
    ↓
Templates
```

---
