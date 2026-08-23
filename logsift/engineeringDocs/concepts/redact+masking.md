Good. Since you already understand **Normalization**, let's separate the three concepts clearly.

The easiest way to remember:

| Concept           | Main Question                                                                       |
|-------------------|-------------------------------------------------------------------------------------|
| **Normalization** | "Can I make different logs look the same for comparison?"                           |
| **Redaction**     | "Should this information be completely removed because it should never be exposed?" |
| **Masking**       | "Can I hide the sensitive value but keep some information for debugging?"           |

In our architecture:

```text
Raw CI/CD Logs
        |
        ↓
Normalization
        |
        ↓
Redaction + Masking
        |
        ↓
Drain
        |
        ↓
Templates
```

---

# 1. Normalization (already understood)

Purpose:

Make changing values consistent.

Example:

Before:

```
Build started at 10:20:31
Build started at 10:25:45
```

After:

```
Build started at <TIMESTAMP>
```

The information is not sensitive.

We just make it reusable.

---

# 2. Redaction

## Simple meaning

Redaction means:

> Remove the information completely because we don't want it to exist downstream.

Think:

```
Secret comes in
        |
        ↓
Delete it
        |
        ↓
Never reaches Drain or LLM
```

---

## Examples from CI/CD logs

### Example 1: Password

Raw:

```
Connecting database:

username=payment-service
password=MySecretPassword123
```

Redacted:

```
Connecting database:

username=payment-service
password=<REDACTED>
```

Why?

Because nobody needs the actual password for debugging.

---

### Example 2: API Token

Raw:

```
Authorization:
Bearer eyJhbGciOiJIUzI1NiIs...
```

Redacted:

```
Authorization:
Bearer <REDACTED>
```

---

### Example 3: Private Key

Raw:

```
-----BEGIN PRIVATE KEY-----
ABCXYZ123
-----END PRIVATE KEY-----
```

Redacted:

```
<PRIVATE_KEY_REMOVED>
```

---

## What should usually be redacted?

In CI/CD:

### Credentials

```
password
passwd
pwd
secret
token
apikey
api_key
```

---

### Authentication headers

Examples:

```
Authorization
Bearer token
Basic auth
```

---

### Certificates and keys

Examples:

```
private key
.pem content
.ssh key
```

---

### Cloud credentials

Examples:

```
AWS_SECRET_ACCESS_KEY

Azure client secret

GCP service account key
```

---

### Database connection strings

Example:

Before:

```
jdbc:mysql://db:3306/payment?user=root&password=abc123
```

After:

```
jdbc:mysql://db:3306/payment?user=root&password=<REDACTED>
```

---

# 3. Masking

## Simple meaning

Masking means:

> Hide the value but keep enough information to understand the log.

The value is replaced, but we preserve the structure.

---

Example:

Raw:

```
User email:
rahul.kumar@company.com
```

Mask:

```
User email:
r****r@company.com
```

Why?

Maybe we need to know:

- Is it an email?
- Is it same user?
- Is format correct?

---

## CI/CD examples

### Commit hash

Raw:

```
Deploying commit:

a82f9238ab12983ff923
```

Mask:

```
Deploying commit:

<a82f****923>
```

or:

```
<GIT_HASH>
```

---

### Container ID

Raw:

```
Starting container:

8f93a83bc992821
```

Mask:

```
Starting container:

<CONTAINER_ID>
```

---

### Hostname

Raw:

```
Running on:

builder-node-182
```

Mask:

```
Running on:

<BUILDER_NODE>
```

---

# Difference between Redaction and Masking

Example:

## Password

Raw:

```
password=hello123
```

Redaction:

```
password=<REDACTED>
```

We don't care about the password.

---

## Username

Raw:

```
user=rahul
```

Masking:

```
user=r****
```

Maybe the identity is useful.

---

# How this applies before Drain

Drain's job:

> Find repeating patterns.

If we send secrets directly:

Example:

Run 1:

```
Connecting with token abc123
```

Run 2:

```
Connecting with token xyz789
```

Drain may create:

```
Connecting with token abc123

Connecting with token xyz789
```

Two different templates.

Bad.

---

After masking/redaction:

```
Connecting with token <REDACTED>
```

Drain creates:

```
Connecting with token <REDACTED>
```

One reusable template.

---

# Important for your JULES/Lattice logs

From your logs, I would categorize:

## Normalize

Keep but replace:

```
build number
timestamp
commit hash
UUID
duration
file count
```

Example:

```
Build #12345
```

becomes:

```
Build #<BUILD_ID>
```

---

## Mask

Hide but keep meaning:

```
builder-node-123
```

becomes:

```
<BUILDER_NODE>
```

because node identity is not important for template creation.

---

## Redact

Remove completely:

```
password
token
private key
secret value
```

---

# Rule file design idea

Your earlier YAML rule idea fits here very well.

I would separate rules:

```
log-processing-rules/

    normalization-rules.yaml

    masking-rules.yaml

    redaction-rules.yaml
```

Example:

```
normalization-rules.yaml

timestamp:
    pattern:
    replacement:
        <TIMESTAMP>
```

---

```
masking-rules.yaml

container_id:
    pattern:
    replacement:
        <CONTAINER_ID>
```

---

```
redaction-rules.yaml

password:
    pattern:
    replacement:
        <REDACTED>
```

---

# Final processing order

I would recommend:

```
Raw Log
   |
   ↓
Extract Metadata
   |
   ↓
Redaction
(remove dangerous information)
   |
   ↓
Masking
(hide sensitive dynamic values)
   |
   ↓
Normalization
(make patterns consistent)
   |
   ↓
Drain
(create templates)
```

Small note: some teams do normalization before masking. Both can work. For our design, I prefer **redaction first** because we never want secrets flowing into later processors accidentally.

---

# One important rule for Lattice

Never redact or normalize away:

```
 //build_type:stage_name
 node_name
 DAG relationship information
```

because that is required to reconstruct logical logs.

Example:

Keep:

```
 //test:integration
Database connection failed
```

Do not convert it to:

```
<STAGE>
Database connection failed
```

because later we won't know where the failure happened.

---

Next topic I would suggest after this:

**"How exactly Drain works after Normalize + Mask + Redact and how it creates reusable templates from JULES and Lattice logs."**

Because now the input to Drain is clean enough to understand.