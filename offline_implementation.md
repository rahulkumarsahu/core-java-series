# Offline Log Processing — Python Implementation Guide

## 1. Goal

This document turns the design in `offline.md` into a concrete Python implementation.

The service receives successful offline-learning events, downloads large logs, processes them safely without loading the whole file into memory, updates a shared Drain baseline, and publishes a new version.

The important implementation rules are:

- `event_id` is the idempotency key.
- eligibility is checked before downloading the log.
- the queue contains metadata, not the 200 MB log.
- each worker processes one log at a time.
- logs are streamed as complete logical events.
- normalization and security redaction happen before Drain.
- processed safe events are written to a staging file.
- only the shared `Drain + baseline publish` section is protected by a family lease.
- the lease key is based on `seal_id + project_id + repo_id + source_type`.
- different baseline families can update in parallel.
- the same baseline family is serialized.
- baseline versions are immutable.
- publishing uses compare-and-swap/version checking as a final safety guard.
- we do not manually split every log into parallel chunks.

---

# 2. Starting Assumptions

The first implementation can start with:

| Item | Starting value |
|---|---:|
| Traffic | ~100 requests/minute |
| Maximum expected log | ~200 MB initially |
| Worker CPU | 4 vCPU |
| Worker memory | 8 GB |
| Temporary disk | 20–50 GB |
| Concurrent log jobs | 4 |
| Python | 3.11 recommended for the example |
| Queue | Redis Stream |
| Status/idempotency DB | PostgreSQL |
| Family lease | Redis distributed lock |
| Temporary raw/staged files | Local worker disk |
| Shared baseline snapshots | Shared filesystem or object storage |
| Drain implementation | Drain3 |

These numbers are starting points. Real worker count, queue limits, and disk size should be chosen from load testing.

Also validate the size assumption against real data. If another part of the system talks about up to ~5 million lines, measure the actual high-percentile byte size of successful and failed runs.

---

# 3. Runtime Architecture

```mermaid
flowchart TD
    A[Completion Event] --> B[FastAPI]
    B --> C[request_id = event_id]
    C --> D{Already exists?}
    D -->|Yes| E[Return existing status]
    D -->|No| F{Eligible?}
    F -->|No| G[Record INELIGIBLE]
    F -->|Yes| H{Queue capacity available?}
    H -->|No| I[429 / retry later]
    H -->|Yes| J[Create job row]
    J --> K[Redis Stream: metadata only]

    K --> L[Worker Process]
    L --> M[Download to .downloading]
    M --> N[Atomic rename to .ready]
    N --> O[Stream complete log events]
    O --> P[Normalize]
    P --> Q[Redact / Mask]
    Q --> R[Write .staging JSONL]
    R --> S[Atomic rename to .ready.jsonl]

    S --> T[Acquire family lease]
    T --> U[Load latest committed baseline]
    U --> V[Drain learning from staged events]
    V --> W[Write immutable candidate snapshot]
    W --> X[CAS publish new baseline version]
    X --> Y[Release family lease]
    Y --> Z[Mark COMPLETED + cleanup]
```

The queue/worker shape is still the same as the design document. The implementation simply persists the job before heavy work so that the API can return quickly and the worker can recover after crashes.

---

# 4. Why the Queue Contains Only Metadata

Do not push the 200 MB file into Redis.

A queue message should look more like:

```json
{
  "event_id": "evt-123",
  "attempt": 0
}
```

The worker uses `event_id` to read the rest of the metadata from PostgreSQL.

Benefits:

- Redis does not become large-file storage.
- no large serialization/deserialization.
- retries are cheap.
- queue messages stay small.
- status is centralized in the DB.

---

# 5. Recommended Python Project Structure

```text
offline_service/
│
├── pyproject.toml
├── README.md
├── drain3.ini
│
├── app/
│   ├── __init__.py
│   ├── config.py
│   ├── main.py
│   ├── schemas.py
│   ├── models.py
│   │
│   ├── api/
│   │   ├── __init__.py
│   │   └── offline.py
│   │
│   ├── queue/
│   │   ├── __init__.py
│   │   └── redis_stream.py
│   │
│   ├── repositories/
│   │   ├── __init__.py
│   │   └── jobs.py
│   │
│   ├── storage/
│   │   ├── __init__.py
│   │   ├── paths.py
│   │   ├── temp_files.py
│   │   └── baseline_store.py
│   │
│   ├── processing/
│   │   ├── __init__.py
│   │   ├── eligibility.py
│   │   ├── downloader.py
│   │   ├── events.py
│   │   ├── normalize.py
│   │   ├── redact.py
│   │   ├── staging.py
│   │   ├── drain_engine.py
│   │   └── baseline_update.py
│   │
│   ├── locking/
│   │   ├── __init__.py
│   │   └── family_lease.py
│   │
│   └── workers/
│       ├── __init__.py
│       ├── worker.py
│       └── run_workers.py
│
└── tests/
    ├── test_eligibility.py
    ├── test_events.py
    ├── test_redaction.py
    ├── test_idempotency.py
    ├── test_family_lease.py
    └── test_baseline_publish.py
```

The modules are intentionally small. Each one has one clear responsibility.

---

# 6. Runtime File Storage Structure

Temporary files belong to the worker currently processing the event.

A useful local layout is:

```text
/data/logsift/
│
├── raw/
│   ├── evt-123/
│   │   ├── input.log.downloading
│   │   └── input.log.ready
│   └── evt-456/
│       └── input.log.ready
│
├── staged/
│   ├── evt-123/
│   │   ├── events.jsonl.staging
│   │   └── events.jsonl.ready
│   └── evt-456/
│       └── events.jsonl.ready
│
├── results/
│   └── evt-123/
│       └── result.json
│
└── baseline_blobs/
    └── 8d2b...family_hash.../
        ├── v00000001/
        │   └── evt-old/
        │       ├── drain_state.bin
        │       ├── templates.json
        │       └── metadata.json
        └── v00000002/
            └── evt-123/
                ├── drain_state.bin
                ├── templates.json
                └── metadata.json
```

## Important distinction

`raw/` and `staged/` can be local temporary disk.

`baseline_blobs/` must be **shared and durable** if there are multiple worker machines/pods.

In production, `baseline_blobs/` can map to object-storage keys such as:

```text
s3://logsift-baselines/
  baseline_blobs/
    <family_hash>/
      v00000042/
        <event_id>/
          drain_state.bin
          templates.json
          metadata.json
```

The DB, not a mutable `LATEST` file, should be the source of truth for the currently committed version.

---

# 7. File Lifecycle

For one event:

```text
input.log.downloading
        ↓ download finished
input.log.ready
        ↓ streaming preprocessing
events.jsonl.staging
        ↓ preprocessing finished
events.jsonl.ready
        ↓ baseline successfully committed
delete temporary raw/staged files
```

Never let another stage consume `.downloading` or `.staging`.

Use `os.replace()` when moving a completed local file to its ready name. On the same filesystem, this gives an atomic rename.

---

# 8. Python Dependencies

A simple dependency set is:

```toml
[project]
name = "logsift-offline"
version = "0.1.0"
requires-python = ">=3.11"

dependencies = [
    "fastapi",
    "uvicorn",
    "pydantic",
    "pydantic-settings",
    "sqlalchemy",
    "psycopg[binary]",
    "redis",
    "httpx",
    "drain3",
]
```

Pin exact versions in your real lock file after compatibility testing.

Optional production additions:

```text
boto3            # S3/object-storage implementation
prometheus-client
structlog
tenacity         # retry helper if desired
```

---

# 9. Configuration

`app/config.py`

```python
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LOGSIFT_",
        env_file=".env",
        extra="ignore",
    )

    postgres_url: str
    redis_url: str

    data_root: Path = Path("/data/logsift")

    queue_stream: str = "logsift:offline:jobs"
    queue_group: str = "logsift:offline:workers"
    queue_max_depth: int = 50

    worker_count: int = 4

    max_log_bytes: int = 200 * 1024 * 1024

    download_buffer_bytes: int = 1024 * 1024  # 1 MB

    family_lease_ttl_seconds: int = 300
    family_lease_wait_seconds: int = 60

    raw_retention_seconds: int = 3600
    failed_retention_seconds: int = 24 * 3600

    drain_config_path: Path = Path("drain3.ini")


settings = Settings()
```

Do not treat `max_log_bytes` as permanent truth. Set it from real production measurements.

---

# 10. Incoming Event Schema

`app/schemas.py`

```python
from datetime import datetime

from pydantic import BaseModel, Field, HttpUrl


class OfflineEvent(BaseModel):
    event_id: str = Field(min_length=1)

    seal_id: str
    project_id: str
    repo_id: str
    source_type: str

    branch: str
    commit_sha: str | None = None

    rule_version: str
    parser_version: str

    log_url: HttpUrl

    completed_at: datetime

    # Optional if same-family ordering later matters.
    pipeline_sequence: int | None = None
```

The service should never create a random independent identity for this work.

Use:

```python
request_id = event.event_id
```

---

# 11. Baseline Family Key

The shared baseline belongs to:

```text
seal_id + project_id + repo_id + source_type
```

Create one canonical function and use it everywhere.

`app/storage/paths.py`

```python
import hashlib


def family_key(
    seal_id: str,
    project_id: str,
    repo_id: str,
    source_type: str,
) -> str:
    return "|".join([
        seal_id,
        project_id,
        repo_id,
        source_type,
    ])


def family_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def lease_key(key: str) -> str:
    return f"logsift:baseline-lease:{family_hash(key)}"
```

Do not build the key differently in the API, worker, and storage layer.

One function prevents subtle mismatches.

---

# 12. Database Models

A practical DB model needs three important concepts:

1. one job row per `event_id`,
2. one current baseline pointer per family,
3. one record showing that an event has already been learned into a family.

`app/models.py`

```python
from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class JobStatus(StrEnum):
    RECEIVED = "RECEIVED"
    INELIGIBLE = "INELIGIBLE"
    QUEUED = "QUEUED"
    DOWNLOADING = "DOWNLOADING"
    READY = "READY"
    PREPROCESSING = "PREPROCESSING"
    STAGED = "STAGED"
    WAITING_FOR_LEASE = "WAITING_FOR_LEASE"
    LEARNING = "LEARNING"
    COMPLETED = "COMPLETED"
    RETRY = "RETRY"
    FAILED = "FAILED"


class OfflineJob(Base):
    __tablename__ = "offline_jobs"

    # Main idempotency key.
    event_id: Mapped[str] = mapped_column(String(200), primary_key=True)

    status: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        index=True,
    )

    family_key: Mapped[str] = mapped_column(
        String(1000),
        nullable=False,
        index=True,
    )

    event_payload: Mapped[dict] = mapped_column(JSON, nullable=False)

    raw_path: Mapped[str | None] = mapped_column(Text)
    stage_path: Mapped[str | None] = mapped_column(Text)

    retry_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )

    baseline_version_published: Mapped[int | None] = mapped_column(BigInteger)
    result_payload: Mapped[dict | None] = mapped_column(JSON)

    error_reason: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )


class BaselineFamily(Base):
    __tablename__ = "baseline_families"

    family_key: Mapped[str] = mapped_column(
        String(1000),
        primary_key=True,
    )

    current_version: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
    )

    snapshot_uri: Mapped[str | None] = mapped_column(Text)

    templates_uri: Mapped[str | None] = mapped_column(Text)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )


class AppliedBaselineEvent(Base):
    __tablename__ = "applied_baseline_events"

    id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        autoincrement=True,
    )

    family_key: Mapped[str] = mapped_column(
        String(1000),
        nullable=False,
        index=True,
    )

    event_id: Mapped[str] = mapped_column(
        String(200),
        nullable=False,
        index=True,
    )

    baseline_version: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
    )

    snapshot_uri: Mapped[str] = mapped_column(Text, nullable=False)

    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint(
            "family_key",
            "event_id",
            name="uq_family_event_once",
        ),
    )
```

The unique `(family_key, event_id)` constraint is important.

Even if the worker crashes and retries after a successful baseline publish, the same event must not teach the baseline twice.

---

# 13. Eligibility Before Download

`app/processing/eligibility.py`

```python
from dataclasses import dataclass

from app.schemas import OfflineEvent


TRUSTED_BRANCHES = {
    "main",
    "master",
}

SUPPORTED_RULE_VERSIONS = {
    "v1",
}

SUPPORTED_PARSER_VERSIONS = {
    "drain-v1",
}


@dataclass(frozen=True)
class EligibilityResult:
    eligible: bool
    reason: str | None = None


def check_eligibility(event: OfflineEvent) -> EligibilityResult:
    required = {
        "seal_id": event.seal_id,
        "project_id": event.project_id,
        "repo_id": event.repo_id,
        "source_type": event.source_type,
    }

    missing = [
        name
        for name, value in required.items()
        if not value
    ]

    if missing:
        return EligibilityResult(
            False,
            f"missing required ids: {','.join(missing)}",
        )

    if event.branch not in TRUSTED_BRANCHES:
        return EligibilityResult(
            False,
            f"untrusted branch: {event.branch}",
        )

    if event.rule_version not in SUPPORTED_RULE_VERSIONS:
        return EligibilityResult(
            False,
            f"unsupported rule version: {event.rule_version}",
        )

    if event.parser_version not in SUPPORTED_PARSER_VERSIONS:
        return EligibilityResult(
            False,
            f"unsupported parser version: {event.parser_version}",
        )

    return EligibilityResult(True)
```

If this returns `False`, do not download the 200 MB file.

Record the ineligible result and stop.

---

# 14. Idempotent API Flow

The API should:

```text
receive event
  ↓
look up event_id
  ↓
if exists → return existing status
  ↓
eligibility
  ↓
capacity check
  ↓
insert job with event_id as primary key
  ↓
enqueue event_id
  ↓
return 202
```

A duplicate request can race with another duplicate, so the database unique key is the final protection.

`app/api/offline.py`

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.processing.eligibility import check_eligibility
from app.schemas import OfflineEvent
from app.storage.paths import family_key


router = APIRouter(prefix="/offline", tags=["offline"])


@router.post("/events", status_code=status.HTTP_202_ACCEPTED)
def accept_offline_event(
    event: OfflineEvent,
    repo=Depends(get_job_repository),
    queue=Depends(get_job_queue),
):
    # Fast duplicate path.
    existing = repo.get_job(event.event_id)
    if existing is not None:
        return repo.to_response(existing)

    eligibility = check_eligibility(event)

    key = family_key(
        event.seal_id,
        event.project_id,
        event.repo_id,
        event.source_type,
    )

    if not eligibility.eligible:
        try:
            job = repo.create_ineligible(
                event=event,
                family_key=key,
                reason=eligibility.reason,
            )
        except IntegrityError:
            job = repo.get_job(event.event_id)

        return repo.to_response(job)

    if queue.depth() >= queue.max_depth:
        raise HTTPException(
            status_code=429,
            detail="offline processing queue is full; retry later",
            headers={"Retry-After": "30"},
        )

    try:
        repo.create_queued(
            event=event,
            family_key=key,
        )
    except IntegrityError:
        # Another copy of the same event won the race.
        existing = repo.get_job(event.event_id)
        return repo.to_response(existing)

    try:
        queue.enqueue(event.event_id)
    except Exception:
        # Keep the DB row. A repair/requeue task can recover QUEUED jobs
        # that were not successfully placed on Redis.
        repo.mark_retry(
            event.event_id,
            "queue enqueue failed",
        )
        raise

    return {
        "event_id": event.event_id,
        "status": "QUEUED",
    }
```

## Production note: DB + queue atomicity

PostgreSQL and Redis cannot share one normal transaction.

The simple implementation above is recoverable because a sweeper can re-enqueue old `QUEUED/RETRY` jobs.

For stronger guarantees, use the **transactional outbox pattern**:

```text
DB transaction:
  insert offline_job
  insert outbox row
commit

dispatcher:
  reads outbox
  XADD to Redis
  marks outbox delivered
```

That is a later reliability improvement, not a change to the processing architecture.

---

# 15. Redis Stream Queue

Redis Streams work well here because multiple worker processes can use a consumer group.

`app/queue/redis_stream.py`

```python
from __future__ import annotations

import os
import socket
import time
from dataclasses import dataclass

import redis


@dataclass(frozen=True)
class QueueMessage:
    message_id: str
    event_id: str


class RedisJobQueue:
    def __init__(
        self,
        client: redis.Redis,
        stream: str,
        group: str,
        max_depth: int,
    ):
        self.client = client
        self.stream = stream
        self.group = group
        self.max_depth = max_depth

        self.consumer = (
            f"{socket.gethostname()}-{os.getpid()}"
        )

        self._ensure_group()

    def _ensure_group(self) -> None:
        try:
            self.client.xgroup_create(
                name=self.stream,
                groupname=self.group,
                id="0",
                mkstream=True,
            )
        except redis.ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def depth(self) -> int:
        # Works because successful messages are ACKed and deleted.
        return int(self.client.xlen(self.stream))

    def enqueue(self, event_id: str) -> str:
        if self.depth() >= self.max_depth:
            raise RuntimeError("queue full")

        message_id = self.client.xadd(
            self.stream,
            {
                "event_id": event_id,
                "enqueued_at": str(time.time()),
            },
        )

        if isinstance(message_id, bytes):
            return message_id.decode()

        return str(message_id)

    def read_one(
        self,
        block_ms: int = 5000,
    ) -> QueueMessage | None:
        rows = self.client.xreadgroup(
            groupname=self.group,
            consumername=self.consumer,
            streams={self.stream: ">"},
            count=1,
            block=block_ms,
        )

        if not rows:
            return None

        _, messages = rows[0]
        message_id, fields = messages[0]

        if isinstance(message_id, bytes):
            message_id = message_id.decode()

        event_id = fields.get(b"event_id") or fields.get("event_id")

        if isinstance(event_id, bytes):
            event_id = event_id.decode()

        return QueueMessage(
            message_id=str(message_id),
            event_id=str(event_id),
        )

    def ack(self, message_id: str) -> None:
        self.client.xack(
            self.stream,
            self.group,
            message_id,
        )

        # Delete after ACK so XLEN represents active backlog better.
        self.client.xdel(
            self.stream,
            message_id,
        )
```

## Crashed workers

Consumer-group messages can remain pending if a worker crashes.

Add a small recovery loop using Redis `XAUTOCLAIM` for messages idle longer than your worker timeout.

The recovered message still contains only `event_id`, so the new worker can inspect the job status and resume safely.

---

# 16. Temporary Path Helper

`app/storage/temp_files.py`

```python
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class EventPaths:
    event_id: str
    root: Path

    @property
    def raw_dir(self) -> Path:
        return self.root / "raw" / self.event_id

    @property
    def raw_downloading(self) -> Path:
        return self.raw_dir / "input.log.downloading"

    @property
    def raw_ready(self) -> Path:
        return self.raw_dir / "input.log.ready"

    @property
    def stage_dir(self) -> Path:
        return self.root / "staged" / self.event_id

    @property
    def stage_writing(self) -> Path:
        return self.stage_dir / "events.jsonl.staging"

    @property
    def stage_ready(self) -> Path:
        return self.stage_dir / "events.jsonl.ready"

    @property
    def result_dir(self) -> Path:
        return self.root / "results" / self.event_id

    @property
    def result_file(self) -> Path:
        return self.result_dir / "result.json"

    def create_dirs(self) -> None:
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.stage_dir.mkdir(parents=True, exist_ok=True)
        self.result_dir.mkdir(parents=True, exist_ok=True)
```

If `event_id` can contain unsafe filesystem characters, do not use it directly as a directory name. Hash it first.

For example:

```python
import hashlib


def safe_event_dir(event_id: str) -> str:
    return hashlib.sha256(
        event_id.encode("utf-8")
    ).hexdigest()
```

---

# 17. Streaming Download to Disk

The worker downloads to `.downloading`.

It does not create a giant `bytes` object in RAM.

`app/processing/downloader.py`

```python
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

import httpx


class LogTooLargeError(RuntimeError):
    pass


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    size_bytes: int
    sha256: str


def download_log(
    url: str,
    downloading_path: Path,
    ready_path: Path,
    max_bytes: int,
    buffer_bytes: int = 1024 * 1024,
) -> DownloadResult:
    downloading_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    total = 0
    digest = hashlib.sha256()

    with httpx.stream(
        "GET",
        url,
        timeout=httpx.Timeout(
            connect=10.0,
            read=120.0,
            write=30.0,
            pool=30.0,
        ),
        follow_redirects=True,
    ) as response:
        response.raise_for_status()

        content_length = response.headers.get("content-length")
        if content_length is not None:
            if int(content_length) > max_bytes:
                raise LogTooLargeError(
                    f"log is larger than {max_bytes} bytes"
                )

        with downloading_path.open("wb") as out:
            for block in response.iter_bytes(
                chunk_size=buffer_bytes
            ):
                if not block:
                    continue

                total += len(block)

                if total > max_bytes:
                    raise LogTooLargeError(
                        f"log exceeded {max_bytes} bytes"
                    )

                digest.update(block)
                out.write(block)

            out.flush()
            os.fsync(out.fileno())

    # Same-filesystem atomic rename.
    os.replace(
        downloading_path,
        ready_path,
    )

    return DownloadResult(
        path=ready_path,
        size_bytes=total,
        sha256=digest.hexdigest(),
    )
```

The `1 MB` here is an **I/O buffer**, not parallel log chunking.

Only one download loop is processing this file.

---

# 18. Logical Log Event Streaming

Drain should receive one complete logical event at a time.

For normal one-line logs:

```text
physical line = logical event
```

For stack traces:

```text
timestamp line
  continuation
  continuation
=
one logical event
```

`app/processing/events.py`

```python
from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path


# Replace with the timestamp/prefix format used by your logs.
NEW_EVENT = re.compile(
    r"^\d{4}-\d{2}-\d{2}[ T]"
)


def iter_log_events(
    path: Path,
) -> Iterator[str]:
    buffer: list[str] = []

    with path.open(
        "r",
        encoding="utf-8",
        errors="replace",
        buffering=1024 * 1024,
    ) as file:
        for line in file:
            line = line.rstrip("\n")

            if NEW_EVENT.match(line):
                if buffer:
                    yield "\n".join(buffer)

                buffer = [line]
            else:
                if not buffer:
                    # Handles files with no timestamp on the first line.
                    buffer = [line]
                else:
                    buffer.append(line)

        if buffer:
            yield "\n".join(buffer)
```

If your source already gives structured JSON logs, use a JSON event parser instead. Do not force every source type through one regex.

A cleaner design is:

```python
def get_event_iterator(
    source_type: str,
    path: Path,
):
    if source_type == "plain":
        return iter_plain_events(path)

    if source_type == "jsonl":
        return iter_json_events(path)

    if source_type == "java":
        return iter_java_multiline_events(path)

    raise ValueError(
        f"unsupported source_type={source_type}"
    )
```

---

# 19. Normalization

Normalization should be deterministic.

`app/processing/normalize.py`

```python
import re


MULTI_SPACE = re.compile(r"[ \t]+")


def normalize_event(message: str) -> str:
    # Keep newlines so multiline stack traces remain meaningful.
    lines = []

    for line in message.splitlines():
        line = line.strip()
        line = MULTI_SPACE.sub(" ", line)

        if line:
            lines.append(line)

    return "\n".join(lines)
```

Do not normalize away useful tokens simply to reduce template count.

For example, removing all numbers before security masking may make unrelated events look identical.

---

# 20. Redaction and Security Masking

Redaction happens **before the staging file**.

That means the staging file is already safer than the raw source.

`app/processing/redact.py`

```python
import re


EMAIL = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)

BEARER = re.compile(
    r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+\b"
)

CARD_LIKE = re.compile(
    r"\b(?:\d[ -]*?){13,19}\b"
)

IPV4 = re.compile(
    r"\b(?:\d{1,3}\.){3}\d{1,3}\b"
)


def redact_event(message: str) -> str:
    message = EMAIL.sub("<EMAIL>", message)
    message = BEARER.sub("Bearer <TOKEN>", message)

    # Whether IP is sensitive or only a Drain parameter is a policy decision.
    message = IPV4.sub("<IP>", message)

    message = CARD_LIKE.sub(
        "<CARD>",
        message,
    )

    return message
```

In production, build redaction rules from your real data classification policy.

Do not rely only on Drain's template masking for security. Security redaction should happen before the event reaches the persistent staging file and before it reaches Drain.

Drain3 masking can still be used afterward for parser-specific generalization.

---

# 21. Staging Safe Events

The staging file exists so that expensive independent work happens before the family lease.

Format:

```json
{"message":"2026-09-11 ERROR user=<EMAIL> failed"}
{"message":"2026-09-11 INFO job 123 completed"}
```

`app/processing/staging.py`

```python
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from app.processing.events import iter_log_events
from app.processing.normalize import normalize_event
from app.processing.redact import redact_event


@dataclass(frozen=True)
class StageResult:
    path: Path
    event_count: int
    bytes_written: int


def build_stage_file(
    raw_path: Path,
    stage_writing: Path,
    stage_ready: Path,
) -> StageResult:
    stage_writing.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    count = 0

    with stage_writing.open(
        "w",
        encoding="utf-8",
        buffering=1024 * 1024,
    ) as out:
        for raw_event in iter_log_events(raw_path):
            normalized = normalize_event(raw_event)

            if not normalized:
                continue

            safe_message = redact_event(normalized)

            row = {
                "message": safe_message,
            }

            out.write(
                json.dumps(
                    row,
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
            )
            out.write("\n")

            count += 1

        out.flush()
        os.fsync(out.fileno())

    os.replace(
        stage_writing,
        stage_ready,
    )

    return StageResult(
        path=stage_ready,
        event_count=count,
        bytes_written=stage_ready.stat().st_size,
    )


def iter_staged_messages(
    stage_path: Path,
):
    with stage_path.open(
        "r",
        encoding="utf-8",
        buffering=1024 * 1024,
    ) as file:
        for line in file:
            row = json.loads(line)
            yield row["message"]
```

The stage file is still sequential.

We are not splitting it into five parallel Drain jobs.

---

# 22. Why Staging Is Before the Family Lease

Suppose the 200 MB log takes 45 seconds to:

- read,
- form multiline events,
- normalize,
- redact.

None of that modifies the shared baseline.

There is no reason to block another same-family run from doing its own preprocessing during those 45 seconds.

So:

```text
Run A                 Run B
-----                 -----
download              download
normalize             normalize
redact                redact
stage                  stage
   \                   /
    acquire family lease
              ↓
        one at a time
```

Only the baseline mutation is serialized.

---

# 23. Distributed Family Lease

For multiple worker processes or Kubernetes pods, an in-memory Python `Lock` is not enough.

Use a distributed lock keyed by the family.

`app/locking/family_lease.py`

```python
from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass

import redis
from redis.exceptions import LockNotOwnedError

from app.storage.paths import lease_key


class LeaseBusyError(RuntimeError):
    pass


class LeaseLostError(RuntimeError):
    pass


@dataclass
class LeaseHandle:
    lock: redis.lock.Lock
    lost: threading.Event

    def assert_owned(self) -> None:
        if self.lost.is_set():
            raise LeaseLostError(
                "family lease heartbeat failed"
            )

        if not self.lock.owned():
            raise LeaseLostError(
                "family lease is no longer owned"
            )


@contextmanager
def family_lease(
    redis_client: redis.Redis,
    family_key_value: str,
    ttl_seconds: int,
    wait_seconds: int,
):
    lock = redis_client.lock(
        name=lease_key(family_key_value),
        timeout=ttl_seconds,
        blocking_timeout=wait_seconds,
        thread_local=False,
    )

    acquired = lock.acquire()

    if not acquired:
        raise LeaseBusyError(
            f"baseline family is busy: {family_key_value}"
        )

    stop = threading.Event()
    lost = threading.Event()

    def heartbeat() -> None:
        interval = max(
            1.0,
            ttl_seconds / 3,
        )

        while not stop.wait(interval):
            try:
                # Reset the TTL back to the configured timeout.
                lock.reacquire()
            except Exception:
                lost.set()
                return

    thread = threading.Thread(
        target=heartbeat,
        daemon=True,
        name="family-lease-heartbeat",
    )

    thread.start()

    handle = LeaseHandle(
        lock=lock,
        lost=lost,
    )

    try:
        yield handle
    finally:
        stop.set()
        thread.join(timeout=2)

        try:
            if lock.owned():
                lock.release()
        except LockNotOwnedError:
            pass
```

## Why heartbeat?

The Drain step can take longer than a fixed lock TTL.

Without renewal:

```text
worker A gets 5 minute lock
Drain takes 6 minutes
lock expires at minute 5
worker B enters
A and B now overlap
```

The heartbeat reduces that risk.

The database version compare-and-swap below is still required as the final correctness guard.

---

# 24. Baseline Blob Storage

The baseline snapshot is immutable.

Do not overwrite:

```text
baseline/current/drain_state.bin
```

from multiple workers.

Instead write a unique candidate path.

`app/storage/baseline_store.py`

```python
from __future__ import annotations

import json
import os
from pathlib import Path

from app.storage.paths import family_hash


class LocalBaselineBlobStore:
    """
    Good for local development or a genuinely shared filesystem.

    In multi-node production, replace this adapter with S3/object storage
    or another shared durable blob store.
    """

    def __init__(self, root: Path):
        self.root = root

    def _version_dir(
        self,
        family_key: str,
        version: int,
        event_id: str,
    ) -> Path:
        return (
            self.root
            / "baseline_blobs"
            / family_hash(family_key)
            / f"v{version:08d}"
            / event_id
        )

    def write_candidate(
        self,
        family_key: str,
        version: int,
        event_id: str,
        drain_state: bytes,
        templates: list[dict],
        metadata: dict,
    ) -> tuple[str, str]:
        target = self._version_dir(
            family_key,
            version,
            event_id,
        )

        target.mkdir(
            parents=True,
            exist_ok=True,
        )

        state_tmp = target / "drain_state.bin.tmp"
        state_final = target / "drain_state.bin"

        state_tmp.write_bytes(drain_state)
        os.replace(state_tmp, state_final)

        templates_tmp = target / "templates.json.tmp"
        templates_final = target / "templates.json"

        templates_tmp.write_text(
            json.dumps(
                templates,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        os.replace(
            templates_tmp,
            templates_final,
        )

        metadata_tmp = target / "metadata.json.tmp"
        metadata_final = target / "metadata.json"

        metadata_tmp.write_text(
            json.dumps(
                metadata,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        os.replace(
            metadata_tmp,
            metadata_final,
        )

        return (
            str(state_final),
            str(templates_final),
        )

    def read_state(
        self,
        snapshot_uri: str | None,
    ) -> bytes | None:
        if snapshot_uri is None:
            return None

        return Path(snapshot_uri).read_bytes()
```

A stale worker writing an unused immutable candidate is safe.

It may leave an orphan blob, but it cannot corrupt the committed baseline.

An orphan cleanup task can remove candidates that are not referenced by the DB after a retention period.

---

# 25. Drain3 In-Memory Persistence Adapter

The worker needs to:

1. load the latest committed Drain state,
2. teach it from the staged events,
3. obtain the final state as bytes,
4. save that as a new immutable baseline version.

A small custom persistence adapter works well.

`app/processing/drain_engine.py`

```python
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from drain3 import TemplateMiner
from drain3.persistence_handler import PersistenceHandler
from drain3.template_miner_config import TemplateMinerConfig


class BytesPersistence(PersistenceHandler):
    def __init__(
        self,
        initial_state: bytes | None,
    ):
        self.state = initial_state

    def save_state(
        self,
        state: bytes,
    ) -> None:
        self.state = state

    def load_state(
        self,
    ) -> bytes | None:
        return self.state


@dataclass(frozen=True)
class DrainLearnResult:
    state: bytes
    templates: list[dict]
    processed_events: int
    cluster_count: int


def learn_baseline(
    initial_state: bytes | None,
    messages,
    config_path: Path,
) -> DrainLearnResult:
    persistence = BytesPersistence(
        initial_state=initial_state,
    )

    config = TemplateMinerConfig()
    config.load(str(config_path))

    # Security redaction already happened before staging.
    # Drain masking can still perform parser-level generalization.
    miner = TemplateMiner(
        persistence_handler=persistence,
        config=config,
    )

    processed = 0

    for message in messages:
        miner.add_log_message(message)
        processed += 1

    # Force one final snapshot so cluster sizes/state at end of run
    # are represented even if no normal snapshot trigger fired recently.
    miner.save_state("end_of_offline_run")

    if persistence.state is None:
        raise RuntimeError(
            "Drain did not produce a snapshot"
        )

    templates = [
        {
            "cluster_id": cluster.cluster_id,
            "template": cluster.get_template(),
            "size": cluster.size,
        }
        for cluster in miner.drain.clusters
    ]

    templates.sort(
        key=lambda item: item["cluster_id"]
    )

    return DrainLearnResult(
        state=persistence.state,
        templates=templates,
        processed_events=processed,
        cluster_count=len(templates),
    )
```

Drain3's training method is `add_log_message()`.

For inference-only behavior, Drain3 uses `match()`. This offline-learning path uses training because it is intentionally updating the shared baseline.

---

# 26. Baseline Repository Contract

Inside the family lease, the worker needs to read the currently committed baseline.

Conceptually:

```python
@dataclass(frozen=True)
class BaselineHead:
    family_key: str
    version: int
    snapshot_uri: str | None
    templates_uri: str | None
```

Repository methods:

```python
class BaselineRepository:
    def get_head(
        self,
        family_key: str,
    ) -> BaselineHead:
        ...

    def get_applied_event(
        self,
        family_key: str,
        event_id: str,
    ):
        ...

    def publish_if_current(
        self,
        *,
        family_key: str,
        event_id: str,
        expected_version: int,
        new_version: int,
        snapshot_uri: str,
        templates_uri: str,
        result_payload: dict,
    ) -> None:
        """
        In one DB transaction:

        1. verify event has not already been applied,
        2. update BaselineFamily only if current_version == expected_version,
        3. insert AppliedBaselineEvent,
        4. mark OfflineJob COMPLETED.

        Raise StaleBaselineVersion if the compare-and-swap fails.
        """
```

---

# 27. Compare-and-Swap Publish

This is the final protection against a stale lease holder.

Pseudo-SQL:

```text
UPDATE baseline_families
SET
    current_version = :new_version,
    snapshot_uri = :snapshot_uri,
    templates_uri = :templates_uri
WHERE
    family_key = :family_key
    AND current_version = :expected_version
```

If updated row count is zero:

```text
someone else published a newer version
```

The worker must **not** force overwrite.

It should discard/reap its candidate later and retry the learning step from the staging file after reacquiring the family lease.

## Why both lease and CAS?

Lease:

- prevents normal same-family overlap,
- avoids wasting CPU retraining from the same baseline.

CAS:

- protects correctness if a worker loses the lease,
- protects against lock/network edge cases,
- prevents an old baseline from overwriting a new baseline.

---

# 28. Full Baseline Update Function

`app/processing/baseline_update.py`

```python
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.locking.family_lease import family_lease
from app.processing.drain_engine import learn_baseline
from app.processing.staging import iter_staged_messages


class StaleBaselineVersion(RuntimeError):
    pass


@dataclass(frozen=True)
class BaselineUpdateResult:
    version: int
    processed_events: int
    cluster_count: int
    snapshot_uri: str
    templates_uri: str


def update_shared_baseline(
    *,
    event_id: str,
    family_key: str,
    stage_path: Path,
    redis_client,
    baseline_repo,
    blob_store,
    drain_config_path: Path,
    lease_ttl_seconds: int,
    lease_wait_seconds: int,
) -> BaselineUpdateResult:

    with family_lease(
        redis_client=redis_client,
        family_key_value=family_key,
        ttl_seconds=lease_ttl_seconds,
        wait_seconds=lease_wait_seconds,
    ) as lease:

        # Idempotency check must happen INSIDE the family lease too.
        already_applied = baseline_repo.get_applied_event(
            family_key,
            event_id,
        )

        if already_applied is not None:
            return BaselineUpdateResult(
                version=already_applied.baseline_version,
                processed_events=0,
                cluster_count=0,
                snapshot_uri=already_applied.snapshot_uri,
                templates_uri=already_applied.templates_uri,
            )

        # Important:
        # load latest baseline only AFTER acquiring the lease.
        head = baseline_repo.get_head(
            family_key,
        )

        expected_version = head.version
        new_version = expected_version + 1

        initial_state = blob_store.read_state(
            head.snapshot_uri
        )

        learn_result = learn_baseline(
            initial_state=initial_state,
            messages=iter_staged_messages(stage_path),
            config_path=drain_config_path,
        )

        # Make sure our lock heartbeat has not already failed.
        lease.assert_owned()

        # Write immutable candidate.
        snapshot_uri, templates_uri = (
            blob_store.write_candidate(
                family_key=family_key,
                version=new_version,
                event_id=event_id,
                drain_state=learn_result.state,
                templates=learn_result.templates,
                metadata={
                    "event_id": event_id,
                    "family_key": family_key,
                    "previous_version": expected_version,
                    "version": new_version,
                    "processed_events": learn_result.processed_events,
                    "cluster_count": learn_result.cluster_count,
                    "created_at": datetime.now(UTC).isoformat(),
                },
            )
        )

        # Check ownership immediately before commit as well.
        # CAS in the DB is still the final correctness barrier.
        lease.assert_owned()

        baseline_repo.publish_if_current(
            family_key=family_key,
            event_id=event_id,
            expected_version=expected_version,
            new_version=new_version,
            snapshot_uri=snapshot_uri,
            templates_uri=templates_uri,
            result_payload={
                "baseline_version": new_version,
                "processed_events": learn_result.processed_events,
                "cluster_count": learn_result.cluster_count,
            },
        )

        return BaselineUpdateResult(
            version=new_version,
            processed_events=learn_result.processed_events,
            cluster_count=learn_result.cluster_count,
            snapshot_uri=snapshot_uri,
            templates_uri=templates_uri,
        )
```

If `publish_if_current()` raises `StaleBaselineVersion`, do not repeat download/redaction.

The `.ready` staging file already exists.

Requeue the event so the next attempt can go directly to:

```text
STAGED
  ↓
Acquire lease again
  ↓
Load newest baseline
  ↓
Drain
  ↓
CAS publish
```

---

# 29. Worker Resume Logic

A worker should be state-aware.

Do not blindly restart from download after every crash.

A useful rule:

```text
QUEUED / RETRY
    if stage ready exists:
        resume from baseline update

    elif raw ready exists:
        resume preprocessing

    else:
        download
```

This reduces repeated work.

---

# 30. Full Worker Skeleton

`app/workers/worker.py`

```python
from __future__ import annotations

import os
import time
from pathlib import Path

from app.config import settings
from app.processing.baseline_update import (
    StaleBaselineVersion,
    update_shared_baseline,
)
from app.processing.downloader import (
    LogTooLargeError,
    download_log,
)
from app.processing.staging import build_stage_file
from app.storage.temp_files import EventPaths


RETRYABLE_EXCEPTIONS = (
    TimeoutError,
    ConnectionError,
)


def process_event(
    event_id: str,
    *,
    repo,
    redis_client,
    blob_store,
) -> None:
    job = repo.get_job(event_id)

    if job is None:
        raise RuntimeError(
            f"job not found: {event_id}"
        )

    if job.status in {
        "COMPLETED",
        "INELIGIBLE",
    }:
        return

    event = repo.event_from_job(job)

    paths = EventPaths(
        event_id=event_id,
        root=settings.data_root,
    )
    paths.create_dirs()

    try:
        # ----------------------------------------
        # STEP 1: Download only if raw file absent
        # ----------------------------------------
        if not paths.raw_ready.exists() and not paths.stage_ready.exists():
            repo.update_status(
                event_id,
                "DOWNLOADING",
            )

            result = download_log(
                url=str(event.log_url),
                downloading_path=paths.raw_downloading,
                ready_path=paths.raw_ready,
                max_bytes=settings.max_log_bytes,
                buffer_bytes=settings.download_buffer_bytes,
            )

            repo.mark_raw_ready(
                event_id=event_id,
                path=str(result.path),
                size_bytes=result.size_bytes,
                sha256=result.sha256,
            )

        # ----------------------------------------
        # STEP 2: Normalize/redact/stage
        # ----------------------------------------
        if not paths.stage_ready.exists():
            repo.update_status(
                event_id,
                "PREPROCESSING",
            )

            stage = build_stage_file(
                raw_path=paths.raw_ready,
                stage_writing=paths.stage_writing,
                stage_ready=paths.stage_ready,
            )

            repo.mark_staged(
                event_id=event_id,
                stage_path=str(stage.path),
                event_count=stage.event_count,
                stage_bytes=stage.bytes_written,
            )

        # Optional:
        # if policy allows, raw can now be deleted because
        # the safe staged input is complete.
        #
        # paths.raw_ready.unlink(missing_ok=True)

        # ----------------------------------------
        # STEP 3: Serialized shared-baseline update
        # ----------------------------------------
        repo.update_status(
            event_id,
            "WAITING_FOR_LEASE",
        )

        result = update_shared_baseline(
            event_id=event_id,
            family_key=job.family_key,
            stage_path=paths.stage_ready,
            redis_client=redis_client,
            baseline_repo=repo,
            blob_store=blob_store,
            drain_config_path=settings.drain_config_path,
            lease_ttl_seconds=settings.family_lease_ttl_seconds,
            lease_wait_seconds=settings.family_lease_wait_seconds,
        )

        # publish_if_current() should already mark the DB row COMPLETED.
        # Store a local result file only if useful operationally.
        repo.ensure_completed(
            event_id=event_id,
            baseline_version=result.version,
        )

        # ----------------------------------------
        # STEP 4: Cleanup temporary per-event files
        # ----------------------------------------
        cleanup_success_files(paths)

    except LogTooLargeError as exc:
        repo.mark_failed(
            event_id,
            reason=str(exc),
        )
        raise

    except StaleBaselineVersion:
        # Someone published a newer version.
        # Keep staged input and retry only the baseline step.
        repo.mark_retry(
            event_id,
            reason="baseline advanced; relearn from staged input",
        )
        raise

    except RETRYABLE_EXCEPTIONS as exc:
        repo.mark_retry(
            event_id,
            reason=str(exc),
        )
        raise

    except Exception as exc:
        # Policy decision:
        # unknown errors may become RETRY first and FAILED after max attempts.
        repo.mark_retry_or_failed(
            event_id,
            reason=repr(exc),
        )
        raise


def cleanup_success_files(
    paths: EventPaths,
) -> None:
    for path in (
        paths.raw_downloading,
        paths.raw_ready,
        paths.stage_writing,
        paths.stage_ready,
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # Cleanup failure should be monitored but should not undo
            # a successfully committed baseline.
            pass
```

---

# 31. Queue Consumer Loop

```python
import logging
import time


logger = logging.getLogger(__name__)


def run_worker(
    *,
    queue,
    repo,
    redis_client,
    blob_store,
):
    while True:
        message = queue.read_one()

        if message is None:
            continue

        try:
            process_event(
                message.event_id,
                repo=repo,
                redis_client=redis_client,
                blob_store=blob_store,
            )

        except Exception:
            logger.exception(
                "offline job failed event_id=%s",
                message.event_id,
            )

            # The DB status tells us whether retry is allowed.
            job = repo.get_job(message.event_id)

            if job and job.status == "RETRY":
                queue.ack(message.message_id)

                backoff = min(
                    60,
                    2 ** min(job.retry_count, 6),
                )

                time.sleep(backoff)
                queue.enqueue(message.event_id)
            else:
                # Permanent failure.
                queue.ack(message.message_id)

        else:
            queue.ack(message.message_id)
```

For larger scale, do not `sleep()` inside a worker for retry delays. Use a delayed-retry mechanism or retry scheduler.

At the starting scale, the simple version is understandable, but a production implementation should avoid tying up a worker during long backoff.

---

# 32. Running Four Worker Processes

Because normalization, regex and Drain can be CPU-heavy, use a small number of **processes**, not 50 nested threads/chunks.

`app/workers/run_workers.py`

```python
from multiprocessing import Process

from app.config import settings


def worker_entry() -> None:
    # Important:
    # create Redis/DB clients inside the child process.
    # Do not create connection pools before forking.
    repo = build_repository()
    redis_client = build_redis_client()
    queue = build_queue(redis_client)
    blob_store = build_blob_store()

    run_worker(
        queue=queue,
        repo=repo,
        redis_client=redis_client,
        blob_store=blob_store,
    )


def main() -> None:
    processes = []

    for _ in range(settings.worker_count):
        process = Process(
            target=worker_entry,
            daemon=False,
        )
        process.start()
        processes.append(process)

    for process in processes:
        process.join()


if __name__ == "__main__":
    main()
```

For Kubernetes, another clean option is one worker process per container and scale the worker Deployment to four replicas.

That gives process isolation without manually creating a `ProcessPoolExecutor`.

---

# 33. Why We Do Not Create a Thread per Log

Do not do:

```python
for request in requests:
    Thread(target=process_log).start()
```

At traffic spikes this creates uncontrolled concurrency.

Instead:

```text
Redis queue
   ↓
fixed worker processes
```

If there are four workers:

```text
4 jobs active
46 jobs waiting
```

That is predictable.

---

# 34. Why We Do Not Use Nested Parallel Chunking

Do not design:

```text
4 worker processes
×
5 chunks per log
=
20 inner tasks
```

or:

```text
10 logs
×
5 chunks
=
50 CPU tasks
```

on a four-core machine.

The implementation intentionally has:

```text
one worker process
    ↓
one log job
    ↓
one sequential event stream
```

The operating system and Python file object already buffer I/O.

That buffering is enough for memory efficiency.

Manual parallel chunks are not required.

---

# 35. CPU vs I/O in This Implementation

One worker performs both kinds of work.

## I/O work

- HTTP download,
- local disk read/write,
- object-store snapshot read/write,
- Redis,
- PostgreSQL.

## CPU work

- multiline event formation,
- regex normalization,
- redaction,
- Drain tree matching and updates.

At only four concurrent jobs, keeping one worker process per active log is simple and avoids an unnecessary ThreadPool + ProcessPool combination.

If measurement later shows download waits dominate, download concurrency can be separated from CPU learning. Do that only after profiling.

---

# 36. Same-Family Concurrency Example

Imagine these four jobs:

```text
Run A → family X
Run B → family Y
Run C → family X
Run D → family Z
```

All four can independently:

```text
download
stream
normalize
redact
stage
```

Then baseline learning becomes:

```mermaid
flowchart LR
    A[Run A staged - Family X] --> LX[Lease X]
    C[Run C staged - Family X] --> LX

    B[Run B staged - Family Y] --> LY[Lease Y]
    D[Run D staged - Family Z] --> LZ[Lease Z]

    LX --> X1[Only one X run at a time]
    LY --> Y1[Family Y runs in parallel]
    LZ --> Z1[Family Z runs in parallel]
```

This is the important concurrency boundary.

---

# 37. Same-Family Ordering

A lease guarantees:

```text
not at the same time
```

A lease does **not** automatically guarantee:

```text
Run A must happen before Run C
```

If learning order matters, add an explicit ordering field such as:

- pipeline sequence,
- commit ancestry,
- trusted completion timestamp plus a tie-breaker.

Then before publish:

```python
if not repo.is_next_allowed_family_event(
    family_key=family_key,
    event_id=event_id,
):
    raise FamilyOrderingWait()
```

If order does not have business meaning, normal lease acquisition order is enough.

Do not invent ordering complexity unless LogSift actually needs it.

---

# 38. Handling Duplicate Webhooks

Example:

```text
Webhook 1:
event_id = abc
→ job row created
→ queued

Webhook retry:
event_id = abc
→ same primary key
→ return existing job
→ do not queue a second learning job
```

Even if a duplicate reaches the worker:

```text
family X + event abc
```

the `AppliedBaselineEvent` unique constraint protects the learning side too.

This is defense in depth.

---

# 39. Crash Scenarios

## Crash while downloading

On disk:

```text
input.log.downloading
```

No `.ready` file exists.

Retry removes/replaces the partial `.downloading` file and downloads again.

---

## Crash after raw file is ready

On disk:

```text
input.log.ready
```

Retry skips the download and starts preprocessing.

---

## Crash during staging

On disk:

```text
events.jsonl.staging
```

No `.ready` stage exists.

Retry rebuilds the stage file.

---

## Crash after stage is ready

On disk:

```text
events.jsonl.ready
```

Retry skips download and preprocessing.

It starts from family lease acquisition.

---

## Crash during Drain before publish

The committed DB baseline still points to the old version.

Retry loads that committed version and learns again.

A partially written candidate is not current and can be cleaned later.

---

## Crash after baseline commit but before queue ACK

Redis may redeliver the message.

Worker sees:

```text
event_id already COMPLETED
```

or:

```text
(family_key, event_id) already applied
```

and returns without learning twice.

---

# 40. Cleanup Job

Do not rely only on the normal success path.

Create a periodic cleanup process.

Pseudo-code:

```python
def cleanup_old_temp_files(
    root: Path,
    older_than_seconds: int,
):
    now = time.time()

    for base in (
        root / "raw",
        root / "staged",
    ):
        if not base.exists():
            continue

        for path in base.rglob("*"):
            if not path.is_file():
                continue

            age = now - path.stat().st_mtime

            if age > older_than_seconds:
                path.unlink(missing_ok=True)
```

Production cleanup should check job state before deleting a retryable job's files.

For example:

```text
COMPLETED + old temp file → delete
FAILED + retention expired → delete
RETRY → keep
PROCESSING → do not delete
```

Also clean orphan baseline candidates not referenced by `baseline_families` or `applied_baseline_events`.

---

# 41. Disk Capacity Guard

Queue capacity alone is not enough.

Suppose:

```text
50 queued jobs × 200 MB
```

If all were downloaded before processing, that could be 10 GB raw input.

Our worker model downloads only when a worker starts the job, so only a small number of raw files should be active at once.

Still monitor disk.

A simple guard:

```python
import shutil


def enough_disk(
    path: str,
    required_free_bytes: int,
) -> bool:
    usage = shutil.disk_usage(path)

    return usage.free >= required_free_bytes
```

Before starting a new download, require safety headroom.

For example:

```text
max input file          = 200 MB
possible staged file    = 250 MB
working safety margin   = 500 MB+
```

Do not accept a job onto a worker if the disk is nearly full.

---

# 42. Memory Behavior

For one 200 MB log:

```text
200 MB on disk
```

does not mean:

```text
200 MB Python object
```

The implementation keeps small buffers:

- HTTP download block: ~1 MB,
- Python text-file buffer: ~1 MB,
- one current logical event,
- Drain tree/clusters,
- small output buffers.

The main variable memory cost is usually the learned Drain state and Python objects, not the complete raw file.

---

# 43. Resource Starting Point

For one combined worker service:

```text
CPU:        4 vCPU
RAM:        8 GB
Temp disk:  20–50 GB
Workers:    4
Queue cap:  20–50 initially
```

If API and workers are separate:

```text
API
  0.5–1 vCPU
  512 MB–1 GB RAM

Worker deployment
  total ~4 vCPU
  total ~8 GB RAM
  temp disk 20–50 GB
```

These are not guarantees.

Measure:

```text
CPU %
RSS memory
queue wait time
processing seconds/MB
Drain events/sec
disk usage
lease wait time
same-family contention
```

---

# 44. Metrics to Add

Useful Prometheus-style metrics:

```text
offline_requests_total
offline_ineligible_total
offline_duplicate_events_total

offline_queue_depth
offline_queue_wait_seconds

offline_active_jobs
offline_download_bytes_total
offline_download_seconds

offline_log_events_total
offline_preprocess_seconds
offline_stage_bytes

offline_family_lease_wait_seconds
offline_family_lease_contention_total
offline_family_lease_lost_total

offline_drain_events_total
offline_drain_seconds
offline_drain_cluster_count

offline_baseline_publish_total
offline_baseline_cas_conflict_total

offline_job_success_total
offline_job_failure_total
offline_job_retry_total

offline_temp_disk_bytes
```

The most useful ratio is often:

```text
processing time / input MB
```

because it helps estimate real capacity better than request count alone.

---

# 45. Logging

Every application log should include:

```text
event_id
family_hash
job_status
retry_count
baseline_version
worker_id
```

Example:

```python
logger.info(
    "baseline published",
    extra={
        "event_id": event_id,
        "family_hash": family_hash(family_key),
        "baseline_version": new_version,
    },
)
```

Avoid logging the raw message after redaction boundaries are defined.

---

# 46. Drain Configuration

Example `drain3.ini`:

```ini
[DRAIN]
engine = Drain
sim_th = 0.4
depth = 4
max_children = 100
max_clusters = 0
extra_delimiters = []

[SNAPSHOT]
snapshot_interval_minutes = 5
compress_state = true

[PROFILING]
enabled = false
report_sec = 60

[MASKING]
masking = []
mask_prefix = <
mask_suffix = >
parameter_extraction_cache_capacity = 3000
```

Treat this only as a starting configuration.

The correct similarity threshold and masks depend on LogSift's log distributions.

Version this configuration.

A baseline should know which parser/rule version created it.

If incompatible parser versions should not share state, either:

- make parser version part of the baseline-family identity, or
- explicitly migrate/reset the baseline.

Do not silently load incompatible Drain state.

---

# 47. Versioned Baseline Metadata

Each immutable version should record:

```json
{
  "family_key_hash": "8d2b...",
  "event_id": "evt-123",
  "version": 42,
  "previous_version": 41,
  "rule_version": "v1",
  "parser_version": "drain-v1",
  "input_event_count": 582312,
  "cluster_count": 419,
  "created_at": "2026-09-11T12:00:00Z"
}
```

This makes debugging much easier.

Never depend only on `templates.json` with no provenance.

---

# 48. Security Boundary

A useful rule is:

```text
Raw storage
    may contain sensitive values
        ↓
redaction boundary
        ↓
Staging + Drain + baseline
    should contain only approved/safe values
```

Therefore:

- restrict permissions on `raw/`,
- delete raw input as soon as policy allows,
- encrypt raw temporary disk if required,
- never write raw secrets into metrics,
- never write raw secrets into application logs,
- ensure baseline files inherit the sanitized form.

---

# 49. When to Delete the Raw File

Two reasonable policies exist.

## Policy A — Delete after staging

```text
raw ready
  ↓
safe staging complete
  ↓
delete raw
  ↓
Drain later
```

Advantage:

- lowest sensitive-data retention,
- less disk usage.

Disadvantage:

- if staging logic itself has a bug discovered later, raw input is unavailable for replay.

## Policy B — Delete after final success

```text
raw ready
  ↓
stage
  ↓
Drain + publish
  ↓
delete raw + stage
```

Advantage:

- easiest retry/recovery.

Disadvantage:

- more disk,
- sensitive raw file lives longer.

Choose based on security and replay requirements.

---

# 50. Repository Publish Example

A simplified SQLAlchemy-style transaction can look like:

```python
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError


def publish_if_current(
    session,
    *,
    family_key: str,
    event_id: str,
    expected_version: int,
    new_version: int,
    snapshot_uri: str,
    templates_uri: str,
    result_payload: dict,
):
    with session.begin():
        applied = session.scalar(
            select(AppliedBaselineEvent).where(
                AppliedBaselineEvent.family_key == family_key,
                AppliedBaselineEvent.event_id == event_id,
            )
        )

        if applied is not None:
            return applied.baseline_version

        result = session.execute(
            update(BaselineFamily)
            .where(
                BaselineFamily.family_key == family_key,
                BaselineFamily.current_version == expected_version,
            )
            .values(
                current_version=new_version,
                snapshot_uri=snapshot_uri,
                templates_uri=templates_uri,
                updated_at=datetime.now(UTC),
            )
        )

        if result.rowcount != 1:
            raise StaleBaselineVersion(
                f"expected baseline v{expected_version}"
            )

        session.add(
            AppliedBaselineEvent(
                family_key=family_key,
                event_id=event_id,
                baseline_version=new_version,
                snapshot_uri=snapshot_uri,
                applied_at=datetime.now(UTC),
            )
        )

        job = session.get(
            OfflineJob,
            event_id,
        )

        job.status = "COMPLETED"
        job.baseline_version_published = new_version
        job.result_payload = result_payload
        job.updated_at = datetime.now(UTC)

    return new_version
```

For the very first version, ensure a `BaselineFamily` row exists with:

```text
current_version = 0
snapshot_uri = NULL
```

before attempting the update.

---

# 51. Initial Family Creation

```python
def get_or_create_baseline_family(
    session,
    family_key: str,
):
    family = session.get(
        BaselineFamily,
        family_key,
    )

    if family is not None:
        return family

    family = BaselineFamily(
        family_key=family_key,
        current_version=0,
        snapshot_uri=None,
        templates_uri=None,
        updated_at=datetime.now(UTC),
    )

    session.add(family)

    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        family = session.get(
            BaselineFamily,
            family_key,
        )

    return family
```

This race can happen when the first two jobs for a new family arrive together.

The primary key makes creation safe.

---

# 52. API Application

`app/main.py`

```python
from fastapi import FastAPI

from app.api.offline import router as offline_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="LogSift Offline Learning",
        version="0.1.0",
    )

    app.include_router(
        offline_router,
    )

    @app.get("/health/live")
    def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    def ready():
        # Real implementation should check required dependencies.
        return {"status": "ready"}

    return app


app = create_app()
```

Run API:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Run workers separately:

```bash
python -m app.workers.run_workers
```

---

# 53. Retry Policy

A simple retry policy:

```text
network timeout              → retry
Redis temporary failure      → retry
DB temporary failure         → retry
lease busy                   → retry
baseline CAS conflict        → retry from staged input
log too large                → permanent failure
unsupported parser           → ineligible/permanent
malformed required metadata  → ineligible
redaction policy error       → fail safely; do not publish
corrupt baseline snapshot    → stop family updates and alert
```

Example max retries:

```text
download/network: 3–5
lease contention: many, with backoff
CAS conflict: few immediate relearn attempts
unknown exception: limited retries then FAILED
```

Do not infinitely retry corrupted data.

---

# 54. Backpressure

There are three separate capacities to protect.

## Queue capacity

```text
queue_max_depth = 50
```

## Worker capacity

```text
worker_count = 4
```

## Disk capacity

```text
minimum free-space threshold
```

Request acceptance should consider queue capacity.

Worker start should consider disk capacity.

This keeps overload controlled.

---

# 55. No Chunking — Concrete Meaning in Code

The code does use ordinary buffers:

```python
response.iter_bytes(chunk_size=1024 * 1024)
```

and:

```python
open(..., buffering=1024 * 1024)
```

This is **not** the chunking we decided against.

It is only I/O buffering.

We are avoiding this:

```python
chunks = split_200mb_file_into_5_parts()

with ProcessPoolExecutor(max_workers=5) as executor:
    executor.map(run_drain, chunks)
```

because that creates:

- multiple Drain states,
- baseline merge problems,
- nested parallelism,
- more CPU scheduling,
- ordering issues,
- more retry state.

---

# 56. Why One Worker per Log Is Still Correct

The actual concurrency model is:

```text
Worker 1 → Log A → sequential event stream
Worker 2 → Log B → sequential event stream
Worker 3 → Log C → sequential event stream
Worker 4 → Log D → sequential event stream
```

Then:

```text
if families differ:
    Drain sections can run at the same time

if families match:
    only one family lease holder runs Drain/publish
```

This gives both:

- parallel throughput,
- correct shared-baseline mutation.

---

# 57. When to Reconsider Chunking

Only revisit chunk-level parallelism if measurement proves:

```text
one single log's Drain phase is the bottleneck
AND
CPU cores are idle
AND
the state-merging problem has a correct design
AND
the speedup is larger than IPC/merge overhead
```

Until then, chunking adds complexity without a demonstrated benefit.

---

# 58. Tests That Matter Most

## Idempotency test

```text
send same event_id twice
expect one DB job
expect one applied baseline event
expect one baseline version increment
```

## Same-family concurrency test

```text
Run A family X
Run B family X

start together

expect:
A publishes v42
B loads v42
B publishes v43

never:
both publish from v41
```

## Different-family concurrency test

```text
Run A family X
Run B family Y

expect both Drain sections can overlap
```

## Crash-after-publish test

```text
publish baseline
simulate crash before queue ACK
redeliver queue message

expect:
no second baseline increment
```

## CAS conflict test

```text
worker loads v41
another worker commits v42
first worker tries expected_version=41

expect:
publish rejected
relearn from staged input
```

## Partial download test

```text
connection breaks at 100 MB

expect:
only .downloading exists
no .ready
retry starts safe download
```

## Partial staging test

```text
worker crashes during staging

expect:
.staging exists
.ready does not
retry rebuilds stage
```

## Multiline event test

```text
Java stack trace

expect:
one logical event reaches redaction/Drain
not one event per physical line
```

---

# 59. Load Test Plan

Test at least:

```text
small logs:
5–10 MB

medium logs:
50–100 MB

large logs:
~200 MB

verbose/failure logs:
real upper percentile
```

Traffic shapes:

```text
steady 100 requests/min
short burst above 100/min
many different families
many same-family events
mix of small + large files
```

Measure:

```text
p50/p95 queue wait
p50/p95 processing time
CPU
RSS
disk
Drain events/sec
family lease wait
CAS conflicts
retry count
```

The worker count should be changed only from these measurements.

---

# 60. Production Storage Recommendation

## Temporary input

Use worker-local disk:

```text
/data/logsift/raw
/data/logsift/staged
```

because the job is processed by that worker and can be recreated from the source if needed.

## Baseline snapshots

Use shared durable storage:

```text
S3 / GCS / Azure Blob / shared durable volume
```

because any worker may later need the current baseline.

## Metadata/status

Use PostgreSQL.

## Queue + family lease

Use Redis.

This gives a clear separation:

```mermaid
flowchart LR
    A[PostgreSQL] --> A1[Job state + baseline head + idempotency]
    B[Redis] --> B1[Queue + family lease]
    C[Local Disk] --> C1[Raw + staged temporary files]
    D[Object Storage] --> D1[Immutable Drain baseline blobs]
```

---

# 61. Minimal Single-Machine Version

For a local prototype, all durable blobs can be on one local filesystem:

```text
Postgres
Redis
/data/logsift/
```

That is enough to validate:

- streaming,
- CPU cost,
- Drain quality,
- same-family lease behavior,
- file lifecycle.

Before moving to multiple machines, move baseline blobs to shared durable storage.

Do not keep per-family baselines only on one worker's local ephemeral disk.

---

# 62. What Not to Do

Avoid these designs:

```text
❌ Put a 200 MB log in Redis queue

❌ Read the entire file with file.read()

❌ Start one unbounded thread per request

❌ Split every log into five Drain processes

❌ Let multiple workers overwrite the same templates.json

❌ Load baseline before waiting for the family lease

❌ Use a fresh random request_id for duplicate webhook retries

❌ Download before checking metadata-only eligibility

❌ Publish mutable baseline files in place

❌ Delete the only recoverable input before a safe stage exists

❌ Assume a lease alone is enough without version/CAS protection
```

---

# 63. Recommended Implementation Order

Build the service in this order.

## Phase 1 — Correct single-worker pipeline

Implement:

```text
event_id
eligibility
download
stream events
normalize
redact
stage
Drain
baseline snapshot
cleanup
```

Use one worker.

Verify correctness first.

## Phase 2 — Idempotency and persistence

Add:

```text
PostgreSQL job status
event_id unique key
applied event unique key
versioned baseline head
```

## Phase 3 — Queue

Add:

```text
Redis Stream
worker consumer
retry
pending-message recovery
```

## Phase 4 — Four parallel workers

Run four worker processes.

Measure CPU/RAM/disk.

## Phase 5 — Family lease

Add distributed family lock and heartbeat.

Test same-family concurrency aggressively.

## Phase 6 — CAS publish

Add immutable candidates and expected-version publish.

Test stale worker scenarios.

## Phase 7 — Production hardening

Add:

```text
object storage
metrics
structured logging
cleanup jobs
outbox
alerts
load tests
```

---

# 64. Final End-to-End Algorithm

```python
def handle_offline_event(event):
    # API
    if job_exists(event.event_id):
        return existing_result(event.event_id)

    eligibility = check_eligibility(event)

    if not eligibility.eligible:
        record_ineligible(event)
        return

    if queue_full():
        return retry_later()

    create_job(
        event_id=event.event_id,
        family_key=make_family_key(event),
        status="QUEUED",
    )

    enqueue(event.event_id)


def worker(event_id):
    job = load_job(event_id)

    if job.completed:
        return

    if not staged_file_exists(event_id):
        if not raw_ready_exists(event_id):
            stream_download_to_temp_file()
            atomic_mark_raw_ready()

        stream_log_events()
        normalize_each_event()
        redact_each_event()
        write_safe_staging_file()
        atomic_mark_stage_ready()

    with lease(job.family_key):
        if event_already_applied(
            job.family_key,
            event_id,
        ):
            return

        head = load_latest_baseline()

        new_state = run_drain(
            head.snapshot,
            staged_events,
        )

        candidate = write_immutable_candidate(
            version=head.version + 1,
            event_id=event_id,
            state=new_state,
        )

        compare_and_swap_publish(
            expected_version=head.version,
            candidate=candidate,
        )

    cleanup_temp_files()
```

That is the whole design in compact form.

---

# 65. Final Decision

The implementation should use:

```text
FastAPI
   ↓
event_id idempotency
   ↓
eligibility before download
   ↓
bounded Redis metadata queue
   ↓
4 controlled worker processes
   ↓
stream download to temporary disk
   ↓
stream complete logical log events
   ↓
normalize
   ↓
security redact/mask
   ↓
safe JSONL staging
   ↓
family-keyed distributed lease
   ↓
load latest committed baseline
   ↓
Drain3 incremental learning
   ↓
immutable candidate snapshot
   ↓
DB compare-and-swap publish
   ↓
mark event applied/completed
   ↓
cleanup
```

The main reason this architecture is preferred is that it keeps the expensive independent work parallel while serializing only the small part that modifies shared family state.

It also keeps memory stable, avoids nested chunk/process overhead, makes retries resumable, and prevents two successful runs from corrupting or losing updates to the same shared Drain baseline.

---

# 66. Library Notes

This implementation uses Drain3 in training mode through `TemplateMiner.add_log_message()`. Drain3 supports persistent state through a `PersistenceHandler`, which is why the `BytesPersistence` adapter can load the previous committed state and capture the newly learned state.

The Redis lease example uses redis-py's distributed lock with a timeout and periodic `reacquire()` heartbeat. The baseline DB compare-and-swap remains the final publication guard.

For large HTTP/file inputs, the implementation intentionally streams bytes and lines instead of materializing the complete file in Python memory.


---

# 67. Design Review Updates (Applied)

This section incorporates additional production-hardening requirements discovered during design review.

## 67.1 Stronger Redaction Policy

The original `redact_event()` examples are **illustrative only** and are **not sufficient for production**.

Production redaction must additionally detect and/or redact:

- `password=...`
- `passwd=...`
- `secret=...`
- `api_key=...`
- `access_key=...`
- `client_secret=...`
- `Authorization: Basic ...`
- credentials embedded in URLs
  (`https://user:pass@example.com`)
- AWS style access keys
- GitHub tokens
- JWTs
- PEM/private key blocks
- SSH private keys
- multiline certificates

The implementation should separate two concepts:

1. **Known sensitive patterns**
   → redact automatically.

2. **Known-dangerous but unsupported patterns**
   → raise a `RedactionPolicyViolation`
   → stop learning
   → do **not** publish the baseline.

Example:

```python
class RedactionPolicyViolation(Exception):
    pass
```

Pipeline:

```text
Normalize
    ↓
Redaction
    ↓
Policy validation
    ↓
Unknown secret?
      ↓
 YES → FAIL JOB
 NO
      ↓
Drain
```

A redaction failure must prevent baseline publication.

This is a hard correctness requirement.

PEM/private-key detection should work across multiline logical events.

---

## 67.2 Staging Format Must Support Future LogDiff

Current staging:

```json
{"message":"..."}
```

This is intentionally sufficient only for Drain learning.

For LogDiff, staged records should eventually become:

```json
{
  "message":"...",
  "segment_id":"build",
  "stage_or_node":"compile",
  "attempt":1,
  "timestamp":"...",
  "metadata":{}
}
```

Minimum recommended additions:

- stage_or_node
- segment_id
- attempt

This allows later statistics such as:

```text
normal during build
rare during test
```

without rebuilding historical baselines.

If v1 intentionally omits segmentation, document it explicitly.

---

## 67.3 Source-Type Dispatch

The implementation sketch already proposes parser dispatch.

`build_stage_file()` should actually call it instead of always using one timestamp parser.

Preferred flow:

```python
iterator = get_event_iterator(
    source_type=event.source_type,
    path=raw_path,
)

for event in iterator:
    ...
```

Every source type should own its parser.

---

## 67.4 Missing Job Handling

If a queue message references an unknown job,
the worker must not silently ACK and forget it.

Instead:

- log an ERROR
- emit a metric
- move message to a dead-letter queue (or quarantine table)
- ACK only after recording the failure

This prevents invisible data loss.

---

## 67.5 Safe Event Directories

`EventPaths` should not use raw `event_id`
as the filesystem directory.

Instead:

```python
safe_dir = safe_event_dir(event_id)
```

Directory names should use the hash.

The original event_id stays only inside metadata.

---

## 67.6 Branch Classification

Trusted branches should be configuration-driven.

Example:

```yaml
trusted:
  - main
  - master
  - release/*
```

During eligibility determine:

```text
branch_class

MAIN
RELEASE
HOTFIX
FEATURE
UNKNOWN
```

Persist `branch_class` with:

- OfflineJob
- staged metadata
- baseline metadata

This allows future statistics to distinguish
release behaviour from main behaviour.

---

## 67.7 Duplicate Publish Protection

`publish_if_current()` should catch duplicate
AppliedBaselineEvent insertions.

Pseudo-flow:

```python
try:
    insert AppliedBaselineEvent
except IntegrityError:
    raise DuplicateLearningAttempt()
```

The family lease should normally prevent this,
but explicit handling improves diagnostics and
makes retry behaviour clearer.

---

## 67.8 Updated Redaction Pipeline

```mermaid
flowchart TD
    A[Raw Event]
    -->B[Normalize]
    -->C[Known Secret Redaction]
    -->D[Policy Validation]

    D -->|Unhandled secret| E[FAIL JOB]

    D -->|Safe| F[Stage JSONL]
    F -->G[Drain]
```

---

## 67.9 Updated Staging Record

Recommended long-term schema:

```json
{
  "event_id":"evt-123",
  "message":"...",
  "segment_id":"build",
  "stage_or_node":"compile",
  "attempt":1,
  "branch_class":"MAIN",
  "timestamp":"2026-09-11T12:00:00Z"
}
```

This remains compatible with Drain while providing enough metadata for LogDiff.
