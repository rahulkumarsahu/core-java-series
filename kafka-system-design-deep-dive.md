# 🧠 Apache Kafka Explained: Follow One Order from First Principles to System Design

Your customer has just ordered lunch. The order is saved, the restaurant needs to see it, a notification should go out, and the analytics dashboard wants an update.

Now the notification provider stops responding. Should that stop the customer from placing an order? And if the restaurant service crashes for two minutes, where should those two minutes of orders wait?

These are the questions that make Kafka worth learning. We will build the answer together, then follow one event closely enough to understand what happens when something fails. 🍱

Our example is **MealRoute**, a fictional food-delivery platform. Its incidents and traffic numbers are illustrative. The customer-facing promise is deliberately precise: **“Your order has been recorded; restaurant confirmation is pending.”** Recording an order and getting a restaurant to accept it are separate outcomes.

**Your reading path:** [1. The problem](#1-the-problem) → [2. One lunch order, ten problems](#2-the-growing-example) → [3. Building blocks](#3-building-blocks) → [4. Partitioning and replication](#4-partitioning-and-replication) → [5. One complete journey](#5-one-complete-journey) → [6. Use cases](#6-use-cases). Then study [reliability](#7-reliability), [production design](#8-production-design), [hands-on practice](#9-practice), and [what remains to learn](#10-next-topics).

The explanations use Apache Kafka **4.3** as their version baseline, with documentation checked on **31 August 2026**. Explicit settings below are design choices unless identified as defaults. The local exercise uses the official `apache/kafka:4.3.1` image; it is a separate, single-broker learning setup.

**A note about the visuals:** Every 🖼️ block expands into a detailed image prompt, caption, and alt text. No images have been generated. The prompts are placed where the finished illustrations would help you, and the explanations work without them.

<a id="1-the-problem"></a>

---

## 1. 🤔 What problem does Kafka solve?

### 1.1 Start with the work that should not block the customer

Imagine the order service makes four calls before returning: save the order, notify the restaurant, send a message to the customer, and update analytics. Even if some calls happen in parallel, every required response adds a dependency. A slow analytics service can now become a checkout problem.

There is another difficulty. Orders might arrive faster than a downstream service can process them. If we keep all unfinished work in the order service's memory, a restart can erase it. If we simply retry everything, we may send duplicate messages or lose track of which steps succeeded.

Kafka gives applications a **durable, shared stream of events**. A producer records that something happened. Consumers read that history at their own pace. Several applications can read the same events independently, and a recovering application can resume from its saved progress while the history remains available.

The useful separation is between **recording an event** and **every interested application finishing its reaction**. That helps with different processing speeds, bursts, independent subscribers, and recovery. It also means accepting that some views will be temporarily behind the source of truth.

There is still a boundary to design. Saving an order in a database and separately sending an event can leave a gap if one succeeds and the other fails. We will close that gap with an outbox in the message journey. Kafka alone does not make those two writes atomic.

Kafka also does not decide whether a restaurant has capacity, whether a customer may place an order, or whether a payment should be refunded. Those remain application decisions. A synchronous request is still appropriate when the caller needs an immediate authoritative answer; a simple task queue may be enough for one background worker with no replay or independent subscribers. [Apache Kafka introduction](https://kafka.apache.org/43/getting-started/introduction/).

<details>
<summary>🖼️ Image prompt 01 — One order, several different promises</summary>

**Purpose:** Kafka separates recording an event from the independent work that follows it.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use two spacious horizontal panels. Top: Customer at left, Order service in the center, Orders database below, and Restaurant, Notifications, Analytics in a right-hand column. Show direct dependency arrows and an amber timeout beside Notifications. Bottom: Order service writes Orders + outbox inside one database boundary, a relay publishes to a retained Event log, and three independent reader lanes leave the log. Mark the API response separately from restaurant confirmation.

**Exact labels:** Customer; Order service; Orders database; Restaurant; Notifications; Analytics; Timeout; Orders + outbox; Relay; Event log; Recorded; Confirmation pending

**Accuracy guardrails:** The bottom panel must include the outbox/relay boundary. Do not imply the API waits for all consumers or that Kafka automatically validates or confirms an order. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Kafka separates recording an event from the independent work that follows it.

**Alt text:** A tightly coupled order request becomes a durable event flow with independent restaurant, notification, and analytics readers.

</details>

**🎯 Interview check:** Why introduce Kafka here instead of adding more HTTP retries?  
**How to answer:** Retries do not provide a shared retained history or independent progress for multiple applications. Choose Kafka when those capabilities justify its operating cost; retain direct calls for decisions that need an immediate answer.

**⚠️ Common misunderstanding:** “Asynchronous means the operation succeeded.” It means some work happens later. Name the exact milestone the API response confirms.

**💡 Easy-to-miss detail:** An event pipeline changes the user experience. Show pending states, timeouts, and recovery paths instead of displaying restaurant confirmation before it exists.

**⚖️ Trade-off:** You reduce timing dependencies, but add eventual consistency, duplicate handling, and infrastructure. A small application may be better served by a database-backed job queue.

<a id="2-the-growing-example"></a>

---

## 2. 🍱 One Lunch Order, Ten Problems to Solve

Let's make this something you can picture. **Asha orders a paneer wrap from Green Bowl through MealRoute.** Her order number is `order-8472`. In the kitchen, a tablet should show a new order card. As the order progresses, that card moves from **Placed** to **Accepted** to **Courier assigned**.

The tablet is our visible outcome, not a Kafka client. A backend worker reads events, updates the restaurant's saved order view, and a normal API or live gateway supplies the screen. We will call that worker the **restaurant-view worker**. Kafka moves the events behind the screen; it does not cook the meal or decide whether the restaurant accepts it.

For the first six scenes, follow the same pattern: a requirement changes, something breaks, and we make one design change. The last four scenes introduce independent applications and failures. **Every scene has a before-and-after image prompt**, so you can connect the design change to what the customer or restaurant notices.

The order ID, restaurant, customer, and traffic numbers are illustrative. When we say an order was saved “for publication,” assume the reliable database/outbox handoff explained in section 5.1; we are not assuming a database write and a Kafka send succeed atomically by themselves.

### 2.1 The kitchen screen should not depend on one request staying alive

**What happens?** Asha taps “Place order.” Her order is saved, but the worker updating Green Bowl's screen is restarting. If the API only makes a one-time call or leaves the update in its own memory, the saved order can fail to reach the kitchen.

**Why is that a problem?** Asha sees that the order was recorded, while the kitchen sees nothing to prepare. Retrying the entire checkout request is not the same as reliably delivering the already-created order.

**What do we change?** Keep the `OrderPlaced` event in a durable log. A **producer** writes that event; a **consumer**, our backend worker, reads it and updates the kitchen's view. The two processes no longer have to be running at the same instant.

**Why does it help?** When the worker returns, it reads the retained event and the order card appears. The API can keep its precise promise—recorded, confirmation pending—without pretending the restaurant has accepted the order.

Start with one log and one worker to understand the flow. Keeping a durable log on only one machine does not yet protect us from losing that machine; scene 2.9 adds the extra copies.

<details>
<summary>🖼️ Image prompt 02 — A saved order must eventually reach the kitchen</summary>

**Purpose:** A retained event lets the kitchen catch up even when its worker misses the original request.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show Asha’s phone marked Recorded, an Order API, and a one-time arrow to a restarting worker. Green Bowl’s tablet is empty and has an amber Missing order card note. Keep the saved order as a separate visible fact. Right panel — Show Order publisher writing an OrderPlaced card into a retained log, followed by the recovered restaurant-view worker updating the same tablet with one order-8472 card. Mark the event as retained after reading. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Asha; Recorded; Order API; Worker restarting; Missing order card; Order publisher; Retained log; OrderPlaced; order-8472; Green Bowl

**Accuracy guardrails:** The producer represents a reliable publication handoff; do not invent atomicity between database and Kafka. The tablet connects through a backend. RF redundancy has not yet been introduced. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** A retained event lets the kitchen catch up even when its worker misses the original request.

**Alt text:** Before, a restarting worker leaves a saved order absent from the kitchen screen; afterward, it reads a retained event and restores the order card.

</details>

**🎯 Interview check:** Why is a retained event better than retrying the whole checkout?  
**How to answer:** It retries delivery of an existing business fact without necessarily creating another order. The order API and event handler still need their own idempotency rules.

**⚠️ Common misunderstanding:** “Recorded” means “accepted by the restaurant.” These are different milestones; the screen must show pending confirmation honestly.

**💡 Easy-to-miss detail:** A stored database row does not automatically create a Kafka event. Use a durable publication mechanism such as the outbox shown later.

**⚖️ Trade-off:** You gain recovery across process restarts but introduce delayed views and event-processing responsibilities. A small durable job queue may be enough at this scale.

### 2.2 The lunch rush overwhelms one event server

**What changes?** MealRoute expands from a few restaurants to several neighborhoods. Many kitchens receive orders at the same time, and the platform keeps history for recovery. The one server holding the log now has too much storage or traffic for its resources.

**Why is that a problem?** New events wait longer to be stored or served. Kitchen screens become stale even if individual workers are healthy. Buying a larger machine can postpone the limit, but it cannot remove every capacity ceiling.

**What do we change?** Divide the stream into multiple ordered logs called **partitions** and place them across Kafka servers called **brokers**. Imagine three lanes, P0, P1, and P2, whose leaders are on B1, B2, and B3 respectively.

**Why does it help?** Different portions of the stream can use different machines' resources. We have increased the places that can store and serve work; we have not created unlimited capacity or automatically balanced all traffic.

A new question appears immediately: **which lane should receive each event?** Sending related updates to arbitrary lanes would create the next problem.

<details>
<summary>🖼️ Image prompt 03 — One crowded event lane becomes several lanes</summary>

**Purpose:** Partitions let different parts of the event stream use different brokers.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show many small order cards piling toward one broker and a kitchen tablet with a delayed-update clock. Highlight disk/traffic pressure on that broker, without a made-up hardware capacity number. Right panel — Show the same stream divided into P0 on B1, P1 on B2, and P2 on B3. Use three visibly smaller piles. Include a note Replicas omitted and a question beside routing: Which lane? Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Lunch rush; One broker; Growing backlog; Delayed screen; B1 / P0; B2 / P1; B3 / P2; Which lane?; Replicas omitted

**Accuracy guardrails:** Partitions contain different subsets. They are not copies of one another. Broker addition alone does not redistribute existing data; this depicts a planned placement. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Partitions let different parts of the event stream use different brokers.

**Alt text:** A busy single broker delays the restaurant screen; a planned three-partition layout spreads the stream across brokers.

</details>

**🎯 Interview check:** Are we solving storage scale or data redundancy here?  
**How to answer:** Storage and processing distribution. Replication is a separate choice that copies each partition for resilience.

**⚠️ Common misunderstanding:** “Adding brokers makes Kafka scale indefinitely.” Every deployment still has storage, network, coordination, and application limits.

**💡 Easy-to-miss detail:** Check the actual bottleneck and partition placement. More servers help only when useful work can move to them.

**⚖️ Trade-off:** More partitions and brokers add capacity options, but also metadata, operations, and recovery work.

### 2.3 The screen shows an order’s updates in the wrong sequence

**What goes wrong?** We send `OrderPlaced`, `RestaurantAccepted`, and `CourierAssigned` for `order-8472` to unrelated partitions. Our worker now reads several independent logs, with no single order across them. It can read the courier update from one partition before an earlier lifecycle event from another. The kitchen screen shows “Courier assigned” and then regresses to “Placed” when that older update is processed.

**Why is that a problem?** The events may all be present, yet the view is misleading. Staff cannot tell which state to trust. Merely storing every record is not enough; related work needs a useful ordering boundary.

**What do we change?** Use `order_id` as the **key**. Under the same partitioning configuration, that key routes one order's events to one partition. For our illustration, assume `order-8472` maps to P1. Process that partition's records in sequence.

**Why does it help?** If the producer publishes the lifecycle in the intended sequence, one partition preserves that append order. Another order can progress on another lane without needing to wait for Asha's order. Multiple order IDs can also share a partition; a partition is not reserved for one order.

**What still needs care?** Kafka cannot repair a producer that publishes version 3 before version 2, and asynchronous handlers can reorder effects after reading. Carry an entity version and reject or reconcile stale updates according to the business rule.

<details>
<summary>🖼️ Image prompt 04 — Stop the kitchen card from moving backward</summary>

**Purpose:** A stable order key and ordered handling keep one order’s visible updates coherent.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show three lifecycle cards for order-8472 split across different lanes. A small screen sequence reads Courier assigned, then Placed, with an amber Backward update marker. Make it clear the problem is processing order. Right panel — Keep the same three lifecycle cards together on P1 under Key: order_id. Show their append order as Placed, Accepted, Courier assigned, and a matching forward-only screen sequence. Add a small version-check badge outside the broker. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; order-8472; Placed; Accepted; Courier assigned; Backward update; Key: order_id; P1; Process in sequence; Version check

**Accuracy guardrails:** P1 is assumed, not a computed hash. There is no global ordering across partitions. Kafka does not fix publication order, business semantics, or concurrent handler reordering. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** A stable order key and ordered handling keep one order’s visible updates coherent.

**Alt text:** Before, separately processed updates make a kitchen card regress; afterward, one keyed partition and version-aware handling preserve its intended progression.

</details>

**🎯 Interview check:** Do we need all restaurants’ orders in one global order?  
**How to answer:** Usually not. We need a coherent lifecycle for each order. Choose that smaller ordering scope to preserve useful parallelism.

**⚠️ Common misunderstanding:** “Same key means one exclusive partition per order.” Many keys can map to the same partition.

**💡 Easy-to-miss detail:** Hashing is based on serialized key bytes and partitioning settings. Keep these consistent across producers and plan partition-count changes.

**⚖️ Trade-off:** Keeping related records together helps order, but a very busy key can become a bottleneck. Choose the key from the business requirement.

### 2.4 Storage keeps up, but one worker cannot update every screen

**What changes?** The brokers now accept events quickly, but one restaurant-view worker must validate them and update many kitchens' views. Suppose, purely for this example, 300 events arrive each second and the worker can complete 100. Its backlog grows by 200 events each second.

**Why is that a problem?** An event being safely stored does not mean the kitchen has seen it. After a minute at those rates, 12,000 more events are waiting. Kafka can hold the backlog, but cannot make the worker's database calls finish faster.

**What do we change?** Add worker capacity so different partitions can be processed in parallel. With three useful partition lanes, we can aim to distribute them among three workers—provided their shared database can support the load.

**Why does it help?** The work no longer has to pass through one process. However, three workers at 100 events/s only match the 300 events/s arrival rate; draining the existing backlog needs extra capacity or a quieter period.

We have proposed more workers, but **we still need a rule that says which worker owns which lane**. Simply starting copies of the program does not establish that rule. That is the next scene.

<details>
<summary>🖼️ Image prompt 05 — The slow reader needs more processing capacity</summary>

**Purpose:** More workers help only when work can be assigned and the whole processing path has capacity.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show P0/P1/P2 all feeding one worker, an incoming rate of 300/s, a processing rate of 100/s, and a growing 200/s backlog. Put a stale kitchen-screen clock beside the output. Right panel — Show a proposed three-worker layout beside the same lanes, with planned dashed assignment lines and an explicit Assignment needed next note. Add an inset: 3 × 100/s matches arrivals; spare capacity drains backlog. Do not imply the layout is configured merely by starting workers. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; P0; P1; P2; 300/s in; 100/s processed; +200/s backlog; Three workers; Assignment needed next; Spare capacity for catch-up

**Accuracy guardrails:** Rates are hypothetical. These are planned processing lanes, not a claim of automatic exclusive assignment. Matching arrivals does not drain old backlog; downstream capacity can limit scaling. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** More workers help only when work can be assigned and the whole processing path has capacity.

**Alt text:** A single worker falls behind three partitions; a proposed worker pool increases capacity but still needs assignment and catch-up headroom.

</details>

**🎯 Interview check:** Is accepting 300 events/s the same as processing 300 events/s?  
**How to answer:** No. Measure ingress and completed business effects separately. A stable broker can hide a growing application backlog.

**⚠️ Common misunderstanding:** “Once we add enough workers to match arrivals, the old backlog disappears.” Net catch-up throughput is processing minus arrivals.

**💡 Easy-to-miss detail:** A shared database may be the limit. Benchmark the end-to-end handler before multiplying workers.

**⚖️ Trade-off:** Worker concurrency can reduce delay, but adds coordination and can overload dependencies. The next step must define ownership.

### 2.5 Extra workers accidentally create duplicate kitchen tickets

**What goes wrong?** We start three copies of the restaurant-view program as independent readers, each configured to read the whole stream. All three receive `OrderPlaced` for `order-8472`. A naive handler inserts three kitchen tickets for Asha's single wrap.

**Why is that a problem?** We wanted to divide the work, not ask every worker to repeat it. The kitchen might prepare three meals because one order appeared three times.

**What do we change?** Put copies of this one application in the same regular **consumer group**, `restaurant-view`, using normal subscription-based assignment. Kafka coordinates partition ownership inside that group. In this three-worker illustration, C1 owns P0, C2 owns P1, and C3 owns P2. With fewer workers, one member could own several partitions.

**Why does it help?** Each partition has at most one assigned owner in this group at a time. Its records are not intentionally broadcast to all workers in the group. Separate workers can handle separate lanes.

This corrects an easy trap in introductory explanations: **consumer groups do not guarantee exactly-once business processing.** A crash after inserting a ticket but before saving progress can still cause replay. A unique event ID and safe database update protect the ticket from that repeated effect; section 5.4 shows the crash window.

<details>
<summary>🖼️ Image prompt 06 — Share the work instead of copying it</summary>

**Purpose:** Consumer groups divide one application’s work; idempotent effects handle repeated delivery after failures.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show one OrderPlaced card reaching C1, C2, and C3, each in a separate reader-group boundary. Their naive outputs create three identical order-8472 tickets on the same kitchen tablet. Label this independent full-stream reading. Right panel — Put C1, C2, and C3 inside one restaurant-view boundary. Assign P0 to C1, P1 to C2, and P2 to C3, with the order-8472 card on P1. Show one intended ticket. Add a clearly separate amber reminder Crash replay still needs deduplication. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Independent reader groups; C1; C2; C3; Three tickets; order-8472; restaurant-view; P0; P1; P2; One assigned owner; Deduplicate crash replay

**Accuracy guardrails:** One group coordinates ownership, not exactly-once effects. Keep a separate deduplication reminder; do not draw a universal no-duplicates badge. Ordinary subscription-based groups are assumed. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Consumer groups divide one application’s work; idempotent effects handle repeated delivery after failures.

**Alt text:** Three independent readers create three tickets in the naive design; one coordinated group shares partitions, with a separate warning about crash-related duplicates.

</details>

**🎯 Interview check:** Can a record still cause repeated work in one consumer group?  
**How to answer:** Yes. Assignment prevents intentional full-stream duplication within the group, but crashes and checkpoint timing can cause replay. Protect the business effect independently.

**⚠️ Common misunderstanding:** “One assigned owner means the event is processed exactly once.” Ownership is not an atomic transaction with your database or external API.

**💡 Easy-to-miss detail:** Use one group ID per logical application and the same ID for its replicas. Random per-instance IDs create independent readers instead of a shared worker pool.

**⚖️ Trade-off:** Groups simplify shared ownership, but regular-group parallelism remains bounded by partitions and ownership changes need safe handling.

### 2.6 Courier location pings do not belong on the kitchen’s order feed

**What changes?** Courier phones now send frequent location readings. The kitchen needs order lifecycle updates; the live delivery map needs courier positions. Putting both into one mixed feed makes each application filter unrelated events and share policies that may not suit it.

**Why is that a problem?** Location traffic can dominate the stream, the payloads differ, and location history may need different retention and access. A kitchen consumer should not need access to every courier's movements just to display a new lunch order.

**What do we change?** Use separate **topics**: `order-events`, keyed by order ID, and `courier-locations`, keyed by courier ID. Producers choose the appropriate topic; consumers subscribe to the streams they actually need.

**Why does it help?** Topic boundaries separate contracts, access, retention, and processing concerns. Each topic can still have several partitions and replicas. The kitchen reads order events, while a map processor reads location events and serves a map through a gateway.

Mixed event types are not inherently invalid in Kafka. We separate these because their consumers and policies differ—not because every event type or individual order requires a separate topic.

<details>
<summary>🖼️ Image prompt 07 — Give the kitchen and the delivery map their own feeds</summary>

**Purpose:** Separate topics keep streams with different purposes and policies manageable.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a single mixed feed containing order tickets and location-pin cards. Both Kitchen worker and Map worker must filter it; put a small Unrelated events pile beside each. Include one shared-policy badge. Right panel — Show order-events leading to a Kitchen worker and kitchen tablet, and courier-locations leading to a Map worker and map screen. Place separate Retention / Access badges on the two topics. Keep phone and screen icons outside Kafka. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Mixed feed; Unrelated events; Shared policy; order-events; Order ID; Kitchen worker; courier-locations; Courier ID; Map worker; Retention / Access

**Accuracy guardrails:** Topics are policy/contract boundaries and may contain multiple partitions. A topic is not one server. Do not suggest every event type or entity must get a topic, or connect end-user devices directly to brokers. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Separate topics keep streams with different purposes and policies manageable.

**Alt text:** A mixed feed forces two applications to filter unrelated records; separate order and location topics serve the appropriate kitchen and map readers.

</details>

**🎯 Interview check:** Why introduce topics if partitions already exist?  
**How to answer:** Topics identify streams and carry policies such as retention and access. Partitions divide each stream for storage, order, and parallelism.

**⚠️ Common misunderstanding:** “A topic is another name for a server.” Brokers host partition replicas, often from many topics.

**💡 Easy-to-miss detail:** Choose stream boundaries before assigning access. Separating sensitive data later can require migrations and consumer changes.

**⚖️ Trade-off:** Separate topics improve isolation, but too many tiny topics add operational overhead. Create them around meaningful contracts and policies.

### 2.7 Analytics needs every order without taking work from the kitchen

**What changes?** Analytics wants to measure how long restaurants take to accept orders. Notifications wants to update customers. These applications must see the same business events the restaurant view sees.

**What goes wrong if we reuse one group?** Adding analytics as another member of `restaurant-view` divides partitions between the kitchen and analytics programs. Each program can miss events it was meant to handle. A group is a team doing one job, not a broadcast list for unrelated jobs.

**What do we change?** Keep separate groups: `restaurant-view`, `notifications`, and `analytics`. Each group can have its own worker instances and its own saved position for each partition.

**Why does it help?** The restaurant group shares restaurant work internally, while analytics and notifications read independently. Analytics can pause or replay retained history without changing the kitchen's checkpoint.

Independent progress does not mean independent infrastructure cost. Every extra reader adds load, and every group's useful recovery window is still bounded by available history.

<details>
<summary>🖼️ Image prompt 08 — Different applications need independent bookmarks</summary>

**Purpose:** Share a group within one application; use different groups for different reactions.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show Kitchen worker and Analytics worker inside one incorrectly shared group, with P0/P2 assigned to Kitchen and P1 to Analytics. Put Missing kitchen update beside order-8472 on P1. Right panel — Show the same order-events log feeding three separate group boundaries: restaurant-view, notifications, analytics. Give each a bookmark and a distinct output: kitchen tablet, customer update, dashboard. Show analytics paused while the kitchen continues. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; One shared group; Kitchen worker; Analytics worker; P1; Missing kitchen update; order-events; restaurant-view; notifications; analytics; Separate bookmarks

**Accuracy guardrails:** Do not imply one group broadcasts every record to every member. Separate groups read independently but share cluster resources and retention constraints. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Share a group within one application; use different groups for different reactions.

**Alt text:** An analytics worker in the kitchen’s group steals part of the intended work; separate groups let both applications read all required events independently.

</details>

**🎯 Interview check:** Why should analytics not join the restaurant-view group?  
**How to answer:** It performs a different job and needs its own complete read of the stream. Shared group membership would divide work rather than broadcast it.

**⚠️ Common misunderstanding:** “Different group IDs only change names.” They establish independent progress and consumption behavior.

**💡 Easy-to-miss detail:** Document group IDs with topic contracts. A deployment naming mistake can silently route events to the wrong logical application.

**⚖️ Trade-off:** Independent groups allow replay and failure isolation, but increase read traffic and require separate operational ownership.

### 2.8 A worker crashes after it updates the kitchen screen

**What happens?** C2 reads P1 record 42 and commits the database update that creates Asha's kitchen ticket. It crashes before saving its next Kafka position. The group's saved position is still 42.

**Why is that a problem?** A replacement resumes at 42 and sees the same event again. If the handler blindly inserts another ticket, the kitchen gets a duplicate even though the consumer group was configured correctly.

**What do we change?** Give the event a stable ID, `evt-8472-1`. In the same database transaction as the view update, store a unique processed-event marker. After that transaction succeeds, commit next offset **43** to Kafka. A replacement that rereads 42 detects the completed marker and skips the repeated effect.

**Why does it help?** The checkpoint tells the group where to resume, while the event-ID transaction makes replay safe. If the crash happens before the database transaction commits, neither the marker nor the effect is committed and the replacement can do the work.

We are protecting a database effect. Sending an email outside that transaction needs the destination's own idempotency mechanism or another reliable handoff.

<details>
<summary>🖼️ Image prompt 09 — A replay should not create another meal ticket</summary>

**Purpose:** Save progress after safe work, and make the work safe to repeat across the remaining crash window.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Draw a short timeline: Read 42, DB ticket saved, Crash before checkpoint, Restart at 42. The naive second insert creates a duplicate order-8472 ticket. Show Committed: 42 separately from the successful database update. Right panel — Repeat the timeline with one database transaction containing Event marker + ticket. On replay, a unique evt-8472-1 marker leads to Skip duplicate effect, then Commit next: 43. Keep the kitchen showing one logical ticket. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Read 42; DB ticket saved; Crash; Committed: 42; Restart at 42; order-8472; Event marker + ticket; evt-8472-1; Skip duplicate effect; Commit next: 43

**Accuracy guardrails:** Commit 43 means resume at 43. Marker and protected effect must share one DB transaction. Kafka checkpointing is separate; no external exactly-once promise or deletion on consumption. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Save progress after safe work, and make the work safe to repeat across the remaining crash window.

**Alt text:** A crash after a database update causes record 42 to replay; an atomic event marker prevents a duplicate ticket before checkpoint 43 is saved.

</details>

**🎯 Interview check:** Does committing 43 say that record 43 is finished?  
**How to answer:** No. It says resume at 43. In this example, record 42 is the one safely handled before that checkpoint.

**⚠️ Common misunderstanding:** “Reading a record saves completion automatically.” Fetching, business processing, and checkpointing are separate steps.

**💡 Easy-to-miss detail:** Do not commit the marker separately before the effect. A crash between them could suppress work that never happened.

**⚖️ Trade-off:** Post-effect commits favor recovery without skipped work, but permit replay. Idempotency consumes storage and requires a deliberate retention policy.

### 2.9 The machine holding the order log disappears

**What happens?** B2, which leads P1, fails. If it held the only available copy, no new worker could read Asha's event from another broker. Adding consumers would not bring the missing log back.

**Why is that a problem?** We handled process failures, but our retained history itself now depends on one machine. The system needs another sufficiently current copy of the same partition.

**What do we change?** Choose replication factor 3 for the production illustration. P1 has a leader on B2 and follower replicas on B1 and B3. The followers fetch the leader's log, preserving the same offsets.

**Why does it help?** If B2 fails, Kafka can elect an eligible replacement and clients discover the new leader. We have a route to continue using the surviving history rather than reconstructing it from nowhere.

This does not mean every failure is harmless or every surviving copy is eligible. Acknowledgements, ISR, minimum ISR, election rules, and failure-domain placement determine what is safe and when writes may resume. Section 4 works through those decisions.

<details>
<summary>🖼️ Image prompt 10 — Protect the notebook itself with replica copies</summary>

**Purpose:** Replication protects a partition’s history; safe election rules determine recovery.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show B2 containing the only P1 log with record 42, crossed by an amber machine-failure symbol. A worker waits and the kitchen screen shows Updates paused. Leave B1/B3 absent to make the single-copy risk clear. Right panel — Show P1 copies on B1/B2/B3, B2 failed, and a caught-up eligible follower promoted. Give copies matching offset labels and reconnect the worker to the new leader after metadata refresh. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Only copy; B2; P1; 42; Updates paused; B1; B3; RF3; Eligible replacement; Metadata refresh

**Accuracy guardrails:** RF3 counts the leader plus two followers on distinct brokers. Promotion is conditional on eligibility and does not automatically satisfy write minimum ISR. Do not promise zero interruption or survival of every failure. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Replication protects a partition’s history; safe election rules determine recovery.

**Alt text:** Losing a sole log copy pauses updates, while an eligible surviving replica can lead the partition after a replicated deployment loses its leader.

</details>

**🎯 Interview check:** Why do more partitions not solve losing this partition’s only copy?  
**How to answer:** Different partitions contain different data. We need replicas of the affected partition, not unrelated logs.

**⚠️ Common misunderstanding:** “RF3 guarantees writes after any two failures.” Writability also depends on in-sync replicas and the acknowledgement/minimum-ISR policy.

**💡 Easy-to-miss detail:** Place replicas across planned failure domains. Copies sharing one failing machine, rack, or zone do not provide the intended independence.

**⚖️ Trade-off:** Replicas use extra storage and network capacity. Stronger write safety can deliberately reduce availability during failures.

### 2.10 The notification provider is down, but the kitchen must keep moving

**What happens?** The notification consumer reads an accepted-order event, but its external provider is unavailable. An immediate retry loop repeatedly hits the failing service and wastes resources without delivering anything.

**Why is that a problem?** Customers wait for updates, and uncontrolled retries can make recovery harder. We also must not let an optional notification failure stop restaurant processing or claim the message was delivered when it was not.

**What do we change?** Keep notifications in their own group, use bounded retries with backoff, and track the age of unresolved work. Depending on the ordering requirement, pause that lane or use an explicitly managed retry path. The restaurant group continues independently. When the provider recovers, notification workers need enough spare capacity to catch up.

**Why does it help?** The retained stream gives recovery time, separate groups contain the progress failure, and the retry policy avoids a tight failure loop. Kafka is the durable buffer; the application owns delay, expiry, retries, and delivery status.

Old notifications can become misleading. Before sending a delayed update, check whether it is still relevant, apply a destination-supported idempotency key where available, and escalate unresolved work before its recovery window closes.

<details>
<summary>🖼️ Image prompt 11 — An optional outage should not freeze the kitchen</summary>

**Purpose:** Independent readers and bounded retries keep useful work moving while a dependency recovers.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a Notification worker repeatedly calling an unavailable provider with a tight retry loop and an undelivered customer-status card. Keep order-events visible to establish that reading an event did not complete delivery. Right panel — Show two independent reader lanes from order-events: restaurant-view updates the kitchen, while notifications uses Backoff + bounded retry before the failed provider. Add a retained-backlog stack, an age clock, and a later catch-up arrow after recovery. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; order-events; Provider down; Retry loop; Undelivered; restaurant-view; Kitchen continues; notifications; Backoff + bounded retry; Event age; Catch up

**Accuracy guardrails:** Kafka does not schedule arbitrary delays or deliver external notifications automatically. Independent groups still share resources; backlog is bounded by policy and capacity. Do not show old messages as always valid to send. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Independent readers and bounded retries keep useful work moving while a dependency recovers.

**Alt text:** A failing notification provider causes wasteful retries; a separate group and controlled backlog allow restaurant updates to continue during recovery.

</details>

**🎯 Interview check:** Can we safely send every notification after a long outage?  
**How to answer:** Not necessarily. Some are obsolete or expired. Define relevance, idempotency, delivery deadlines, and how to record a deliberately skipped update.

**⚠️ Common misunderstanding:** “A retry topic automatically provides a delay and safe ordering.” A delay mechanism and ordering policy must be implemented.

**💡 Easy-to-miss detail:** Alert on oldest unresolved event age, not just queue length. Recovery must finish before history or business relevance expires.

**⚖️ Trade-off:** Buffering and retrying preserve useful work, but increase delivery delay. Some work should expire visibly rather than be retried indefinitely.

**Put the changes together:** The durable log lets a worker return later. Partitions spread storage and work. Keys keep related events on one lane. Groups divide one application's work; separate groups let other applications read independently. Topics separate streams with different purposes. Checkpoints and idempotent effects support safe recovery. Replication protects the logs themselves.

You have now seen a reason for each building block. Next, we will name its exact responsibilities and the limits hidden by the simple pictures.

<a id="3-building-blocks"></a>

---

## 3. 🧩 Core building blocks: give every piece a clear job

You have already met the pieces through the story. Let's make their responsibilities precise. Keep three questions in mind: **Where is the data? Who owns the work? Where is progress recorded?**

### 3.1 The event record: what are we actually sending?

An **event** describes something that happened: `OrderPlaced`. A **command** asks someone to do something: `AcceptOrder`. Both can travel through Kafka, but their meaning and ownership differ. A consumer must not mistake a request for proof of completion.

A Kafka record has a key and value, and can carry headers and a timestamp. The application supplies serialized bytes; Kafka does not understand an order's business fields. Here is our running example in a readable envelope:

```json
{
  "topic": "order-events",
  "key": "order-8472",
  "headers": {"schema_version": "1", "trace_id": "trace-8472"},
  "value": {
    "event_id": "evt-8472-1",
    "event_type": "OrderPlaced",
    "order_id": "order-8472",
    "restaurant_id": "restaurant-23",
    "entity_version": 1,
    "occurred_at": "2026-08-31T07:00:00Z"
  }
}
```

This envelope is explanatory JSON, not a mandatory Kafka wire format. The **key** influences routing and compaction. The **event ID** identifies one occurrence and helps business deduplication. The **entity version** helps detect stale updates. They solve different problems.

The record also has a Kafka timestamp. Depending on topic policy, that can represent producer creation time or broker append time; the payload's `occurred_at` preserves the business event time explicitly. Neither timestamp gives Kafka global order. [ProducerRecord API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/producer/ProducerRecord.html).

<details>
<summary>🖼️ Image prompt 12 — Open one order event</summary>

**Purpose:** A record carries routing information, business data, and metadata with different responsibilities.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw one large event card in the center with four tidy labeled compartments: Key, Value, Headers, Timestamp. In Value show only event_id, event_type, entity_version. Place a small order icon beside the card. Use three short callout arrows distinguishing routing key, occurrence identity, and business sequence.

**Exact labels:** Key: order-8472; Value; evt-8472-1; OrderPlaced; entity_version: 1; Headers; Timestamp; Routing; Identity; Business sequence

**Accuracy guardrails:** Do not portray event_id as Kafka offset or key as necessarily unique per record. Keep JSON paragraphs out of the illustration. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A record carries routing information, business data, and metadata with different responsibilities.

**Alt text:** An order-event envelope separates its routing key, event identity, version, headers, and timestamp.

</details>

**🎯 Interview check:** Why not use the event ID as the partition key?  
**How to answer:** A fresh event ID spreads one order’s lifecycle across partitions. Use order ID for per-order ordering, and retain event ID separately for duplicate detection.

**⚠️ Common misunderstanding:** “The key uniquely identifies each message.” Many records deliberately share a key.

**💡 Easy-to-miss detail:** A payload should carry enough context for independently deployed consumers without exposing unnecessary personal data. Document its contract and avoid requiring every consumer to call the producer synchronously.

### 3.2 The producer: a client that finds the right destination

A producer is usually a client library inside an application or connector. Your application chooses the topic and supplies a key/value; serializers convert them to bytes. The client obtains cluster metadata and sends records to partition leaders.

`bootstrap.servers` supplies initial contact addresses. After connecting, the client discovers the relevant brokers. The bootstrap address is not a permanent proxy through which all records pass.

A call to an asynchronous send method may return before the broker has accepted anything. Observe the completion result and handle failure. The producer has finite memory and delivery deadlines; during an outage, its buffer cannot grow forever.

For throughput, records accumulate into partition-specific batches. A network request can carry batches for several partitions led by the same broker. Compression normally operates on batches, so related records often compress better together. We will revisit the latency and memory cost of batching later.

<details>
<summary>🖼️ Image prompt 13 — The producer discovers, then sends</summary>

**Purpose:** The producer uses metadata to send batches to the correct partition leader.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use three main groups: Application with serializer, Producer client with a small metadata map, and broker row B1/B2/B3. Show a dashed metadata exchange with B1, followed by a solid P1 data arrow to B2. Put one small batch of event cards inside the producer and a return acknowledgement arrow from B2.

**Exact labels:** Application; Serializer; Producer client; Metadata; B1; B2: P1 leader; B3; Batch; Acknowledgement

**Accuracy guardrails:** Bootstrap contact does not forward all records. Metadata/control traffic is dashed; the data path goes directly to the selected partition leader. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** The producer uses metadata to send batches to the correct partition leader.

**Alt text:** A producer discovers broker metadata through an initial contact, then sends P1 data directly to its leader.

</details>

**🎯 Interview check:** Why can a client connect to the bootstrap address yet fail to produce?  
**How to answer:** Metadata may advertise broker addresses the client cannot reach, or the client may lack topic permissions. Check the discovered endpoints and authorization, not only the first connection.

**⚠️ Common misunderstanding:** “send() returned, so the order is safely in Kafka.” An asynchronous enqueue and a successful broker acknowledgement are separate milestones.

**💡 Easy-to-miss detail:** Serializers and key encodings must agree across producers. Different bytes for the same logical ID can produce different partition choices.

### 3.3 Topic, partition, and offset: three levels of identity

A **topic** names a stream, such as `order-events`. A **partition** is one ordered append-only log within that stream. An **offset** identifies a record's position inside a particular partition.

Suppose P0 contains offsets 40–42 and P1 also contains offsets 40–42. Those are six different positions. To identify one Kafka position, you need the topic, partition, and offset together. `order-events / P1 / 42` is meaningful; “offset 42” alone is incomplete.

Each partition has its own append order. Kafka does not define whether P0 offset 42 happened before P1 offset 42. A record can also have an older business timestamp than the record immediately before it.

Offsets are not guaranteed to be dense forever. Retention, compaction, and transaction-related records can create gaps in what an application sees. Do not calculate business event counts by blindly subtracting offsets.

<details>
<summary>🖼️ Image prompt 14 — Three logs, three independent number lines</summary>

**Purpose:** Offsets locate records inside one partition; they do not establish order across the whole topic.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw a large order-events topic boundary containing P0, P1, P2 as separated horizontal rows. Each row has its own numbered cards, with offset 42 highlighted in both P0 and P1. Add a magnified identity tag for order-events / P1 / 42. Include a gap between two cards in P2 to show that visible offsets need not be dense.

**Exact labels:** order-events; P0; P1; P2; 40; 41; 42; 44; Topic + partition + offset; Independent order

**Accuracy guardrails:** Do not connect the rows into one global number line. A gap must not imply that offsets are renumbered after deletion. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Offsets locate records inside one partition; they do not establish order across the whole topic.

**Alt text:** Three partition logs have separate offset sequences, including two distinct records at offset 42.

</details>

**🎯 Interview check:** Does a larger offset mean a later event?  
**How to answer:** Only a later append position within that same partition. It says nothing universal about business time or another partition.

**⚠️ Common misunderstanding:** “Offsets are global event IDs.” They are partition-local positions.

**💡 Easy-to-miss detail:** When diagnosing a missing record, capture topic, partition, offset, event ID, and group ID. A log line with only an offset is often insufficient.

### 3.4 Brokers, replicas, and replication factor: place the data

A **broker** stores partition replicas and serves Kafka requests. A **cluster** is the collection of cooperating brokers and its metadata control plane.

For each partition, one replica is the leader. Other replicas follow that leader's log. If `order-events` has 3 partitions and replication factor 3, it has **9 partition replicas**, not 9 brokers and not 3 copies of the topic on every broker.

For our worked journey, P1's leader is B2; its followers are B1 and B3. Another partition can have B1 as its leader. Leadership is per partition, so the cluster does not have one data leader for all topics.

The example chooses replication factor 3; this is not a claim that all Kafka installations default to three replicas. Replica placement and failure domains must be planned explicitly.

<details>
<summary>🖼️ Image prompt 15 — Partition copies inside broker boxes</summary>

**Purpose:** Partitions divide data; replicas copy each partition onto different brokers.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create a clean 3-by-3 placement matrix: broker columns B1, B2, B3; partition rows P0, P1, P2. P0 leader is B1, P1 leader B2, P2 leader B3; remaining cells are followers. Highlight the P1 row in teal and give its three copies identical small offset cards. Add a footer equation.

**Exact labels:** B1; B2; B3; P0; P1; P2; L; F; L = leader; F = follower; 3 partitions × RF3 = 9 replicas

**Accuracy guardrails:** Each partition must appear once on each distinct broker in this example. RF3 includes the leader. Do not imply this placement is automatically optimal for all deployments. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Partitions divide data; replicas copy each partition onto different brokers.

**Alt text:** Three brokers hold nine replicas across three partitions, with a different leader highlighted for each partition.

</details>

**🎯 Interview check:** Can a one-broker lab create a normal topic with replication factor 3?  
**How to answer:** No. Three replicas of one partition require three distinct brokers. Use RF1 for that lab and state that it has no broker redundancy.

**⚠️ Common misunderstanding:** “A follower has its own unrelated offsets.” Replicas copy the same partition log and preserve its offsets.

**💡 Easy-to-miss detail:** Balanced replica counts can still hide unbalanced traffic. Inspect leader traffic, storage, and hot partitions, not just how many replicas each broker holds.

### 3.5 Consumers and groups: who gets which work?

A **consumer** fetches records and hands them to application code. In a regular group that uses subscription and automatic assignment, Kafka coordinates partition ownership among its members. One member may own multiple partitions, but a partition has at most one owner in that group at a time.

With P0, P1, P2 and five members, at most three members can actively own partitions for this topic. The extra members do not split P1 into smaller ownership units. Adding threads also does not change Kafka's partition ordering rules.

A different group reads independently. That is how the restaurant view and analytics can both see an event while several restaurant-view workers share their own workload.

Modern Kafka also has **share groups**, which use record-level acquisition and acknowledgement and can share work within a partition. Their concurrency and ordering model differs from regular consumer groups; do not apply the regular-group partition limit to every Kafka consumption model. This article's worked flow uses regular groups. [KafkaShareConsumer API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/consumer/KafkaShareConsumer.html).

<details>
<summary>🖼️ Image prompt 16 — Ownership limits and independent readers</summary>

**Purpose:** Regular consumer-group parallelism is bounded by assigned partitions, while other groups read independently.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Two panels: left has P0/P1/P2 assigned to three of five restaurant-view members, with two clearly idle for assignment. Right has a separate analytics group reading all three partitions. Keep a small outlined note below the panels reading Regular consumer groups to scope the drawing.

**Exact labels:** P0; P1; P2; restaurant-view; C1; C2; C3; C4; C5; No partition assigned; analytics; Regular consumer groups

**Accuracy guardrails:** Do not imply idle members have failed. Do not portray share groups using this assignment model or create multiple regular owners for one partition. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Regular consumer-group parallelism is bounded by assigned partitions, while other groups read independently.

**Alt text:** Three partitions give work to three of five regular-group members, and an analytics group has its own independent read assignments.

</details>

**🎯 Interview check:** Why are two of five consumers idle on a three-partition topic?  
**How to answer:** Regular group assignment cannot give the same partition to two members simultaneously. More members than partitions do not create additional partition owners.

**⚠️ Common misunderstanding:** “All consumers in the cluster compete for each message.” Competition is scoped to a group and its assignment model.

**💡 Easy-to-miss detail:** Manual `assign()` bypasses normal subscription-based rebalancing. Do not assume the group coordinator protects ownership in a custom manual-assignment design.

### 3.6 Four positions that are easy to confuse

Let's slow down here, because many Kafka mistakes start with the word “offset.”

| Term | Who maintains it? | What it means |
|---|---|---|
| Record offset | Partition log | Where one record was appended |
| Consumer position | Consumer client | Where that client will read next; it can advance before business work finishes |
| Committed group offset | Application checkpoint stored by Kafka | Where this group should resume for this partition |
| High watermark / last stable offset | Broker replication / transaction state | Boundaries used to decide which log data a reader may see |

In our simple poll, P1 record 42 is returned, so the consumer position becomes 43. The group's committed offset can still be 42. The client has read further than the application has durably checkpointed.

After safely handling 42, the application commits 43: **start next time at 43**. With larger polls, position can be much farther ahead of completed work. The replication high watermark and transactional last stable offset are not this application checkpoint; we will explain their visibility role in the journey.

<details>
<summary>🖼️ Image prompt 17 — Read position is not a completion bookmark</summary>

**Purpose:** Fetching a record can advance position before its business work and checkpoint are complete.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw one P1 strip with records 41, 42, 43, 44. Under it put two clearly separated markers: committed 42 at record 42 and position 43 at record 43 after a single-record poll. Below draw a business worker processing 42. Add a separate small broker-visibility bracket above the strip without assigning it a numeric value.

**Exact labels:** P1; 41; 42; 43; 44; Committed: 42; Position: 43; Processing 42; Broker visibility boundary

**Accuracy guardrails:** The example poll returns only record 42. Do not equate local position, application completion, group commit, or replication visibility. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Fetching a record can advance position before its business work and checkpoint are complete.

**Alt text:** A consumer has read record 42 and moved its local position to 43 while its durable checkpoint still points to 42.

</details>

**🎯 Interview check:** You processed record 42 successfully. What offset do you commit?  
**How to answer:** In this contiguous single-record example, 43: the next position to consume. Never commit beyond unfinished work from the same partition.

**⚠️ Common misunderstanding:** “Committed 43 means record 43 is finished.” It means resume at 43.

**💡 Easy-to-miss detail:** For real batches, track safe next positions rather than assuming every visible offset is consecutive. Current Java APIs expose next-offset metadata that also preserves leader epochs.

### 3.7 Retention and replay: how long is the notebook available?

Kafka keeps records according to the topic's storage policy. With deletion-based retention, older log segments can be removed after time or size conditions make them eligible. A slow consumer does not keep those records alive merely by failing to read them.

That means replay has a budget. A service that is offline for longer than the available history may need a database snapshot or another archive to recover. Even a seven-day retention setting is not a promise that every event remains queryable for exactly seven days under every combination of size limits and storage policies.

Group checkpoints have their own retention rules too. If a group's saved offsets expire, a later restart may have no checkpoint even though topic data remains. Choose the missing-offset policy deliberately and monitor infrequently used groups. [Broker configuration](https://kafka.apache.org/43/configuration/broker-configs/).

Compaction is another cleanup policy: Kafka can eventually remove superseded records for the same key. That helps rebuild the latest state; it does not preserve every historical transition. We will compare both policies in the reliability chapter.

<details>
<summary>🖼️ Image prompt 18 — Retention is a moving recovery window</summary>

**Purpose:** Replay works only while the required history or a suitable recovery source still exists.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw a horizontal timeline with old segments at left, a retained window in the middle, and new records arriving at right. Put one consumer bookmark inside the retained window and another behind its left edge. Mark an alternative Snapshot + newer events path under the lagging bookmark.

**Exact labels:** Old segments; Retained window; New records; Reader A; Reader B too far behind; Snapshot + newer events

**Accuracy guardrails:** Deletion is policy/segment based, not triggered by reading. Do not show compaction as retaining complete history or guarantee a precise expiry instant. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Replay works only while the required history or a suitable recovery source still exists.

**Alt text:** A moving retention window contains one reader’s checkpoint but has already passed another reader’s required history.

</details>

**🎯 Interview check:** What happens if a consumer is offline longer than retention?  
**How to answer:** Its committed offset may no longer be available. Apply a deliberate reset or snapshot recovery policy; do not silently pretend processing was complete.

**⚠️ Common misunderstanding:** “Kafka retains unread messages until every consumer finishes.” Consumer progress and retention are independent.

**💡 Easy-to-miss detail:** Size-based retention can remove data sooner than a time-only mental model predicts. Set the recovery objective first, then size and monitor the retained window.

### 3.8 Controllers and coordinators: who manages what?

Kafka's modern metadata system is **KRaft**. A controller quorum maintains cluster metadata, including broker registrations and partition leadership. Three controller voters require a majority of two; the metadata quorum is separate from the replication factor of an application topic. Larger production deployments commonly separate controller and broker roles. [KRaft operations](https://kafka.apache.org/43/operations/kraft/).

A **group coordinator** manages group-related state and offset commits. A **transaction coordinator** manages Kafka transaction state. These coordinator roles are hosted by brokers and are not synonymous with the active controller.

Partition assignment also depends on the group protocol. In the classic protocol, a group leader client participates in assignment; the newer consumer protocol moves assignment logic to the broker side. The client setting `group.protocol=consumer` opts into that newer protocol in the 4.3 baseline. Do not explain all rebalances as a universal stop-everyone barrier. [Consumer rebalance protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/).

The producer still sends data directly to the partition leader. Controllers do not inspect an order and decide its key or forward each record to a consumer.

<details>
<summary>🖼️ Image prompt 19 — Separate control from the data path</summary>

**Purpose:** Metadata leadership, group progress, transactions, and record storage have different owners.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use two horizontal layers. Top: three small KRaft controller nodes linked as a quorum, with dashed metadata arrows down to a broker cluster. Bottom: Producer sends a solid data arrow to P1 leader B2, and Consumer fetches data from B2. To one side show Group coordinator with a dashed assignment/checkpoint link to Consumer; show a separate Transaction coordinator badge without routing data through it.

**Exact labels:** KRaft quorum; Metadata; Broker cluster; Producer; B2: P1 leader; Consumer; Group coordinator; Transaction coordinator

**Accuracy guardrails:** Do not draw controllers in the record data path. Do not equate three controller voters with three replicas of order-events. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Metadata leadership, group progress, transactions, and record storage have different owners.

**Alt text:** Controllers manage metadata above a direct producer-to-partition-leader data path, while separate coordinator roles manage group and transaction state.

</details>

**🎯 Interview check:** Who chooses the partition for each produced record?  
**How to answer:** Normally the producer client, using the application’s key or explicit choice and metadata. The controller manages partition leadership and placement, not business routing per event.

**⚠️ Common misunderstanding:** “Kafka has one leader that makes every decision.” Partition leaders, controller leadership, and group protocol roles are distinct.

**💡 Easy-to-miss detail:** Protocol and feature-version changes affect operational behavior. Record the client and broker versions when diagnosing rebalances or explaining an upgrade.

<a id="4-partitioning-and-replication"></a>

---

## 4. 🛡️ How partitioning and replication actually work

Partitioning answers “Which log gets this event?” Replication answers “Which copies must protect that log?” Those decisions meet on the broker that leads the selected partition.

### 4.1 Partition selection: follow the producer’s decision

The application first chooses the topic. Partition selection then follows the client configuration:

| Input | Typical decision |
|---|---|
| Explicit partition supplied | Use that partition if valid |
| Custom partitioner | Apply the configured routing policy |
| Key supplied with normal keyed routing | Hash the serialized key to a partition |
| No key and no explicit partition | Use the client’s unkeyed strategy |

For the default Java producer, an absent key normally uses sticky, batching-oriented selection, with adaptive behavior affected by configuration. It is not universally random or round-robin. Key ignoring and custom partitioners can change behavior, so identify the client before promising routing semantics. [Producer configuration](https://kafka.apache.org/43/configuration/producer-configs/).

For every worked example here, **assume `order-8472` maps to P1 with three partitions**. This is a stated demonstration choice, not a claimed result of a particular hash function. The producer's metadata says B2 leads P1, so it sends the batch to B2.

If B2 is no longer the leader, the client refreshes metadata and retries as appropriate. The partition is the logical destination; its leader can move without changing the record's key.

<details>
<summary>🖼️ Image prompt 20 — Who chooses the partition?</summary>

**Purpose:** The producer chooses a logical partition, then uses metadata to find its current leader.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Build a spacious decision tree with one start card Topic + serialized key, then short branches Explicit partition?, Custom policy?, Key available?, and Unkeyed strategy. Merge the chosen destination at P1, then use a metadata-map card to identify B2. A final solid data arrow reaches B2. Use no more than seven major groups.

**Exact labels:** Topic + serialized key; Explicit partition?; Custom policy?; Key available?; Unkeyed strategy; P1; Metadata: leader B2; B2

**Accuracy guardrails:** State in a tiny note that P1 is assumed for this example. Do not show a universal hash result, random default, or controller business-routing decision. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** The producer chooses a logical partition, then uses metadata to find its current leader.

**Alt text:** A producer selects P1 from routing inputs and uses its metadata map to send the record to B2.

</details>

**🎯 Interview check:** Would sending to a different bootstrap broker change where this key belongs?  
**How to answer:** No, not under the same partitioning policy and metadata. Bootstrap selection is discovery; partition selection uses the routing inputs.

**⚠️ Common misunderstanding:** “The broker load-balances every record randomly.” Producers normally choose partitions before sending.

**💡 Easy-to-miss detail:** Explicit routing gives control but creates responsibility. Your application must handle partition-count changes and avoid concentrating all traffic on a chosen partition.

### 4.2 Ordering, hot keys, and changing the partition count

A key is a promise about what needs to stay together. If every event uses `city_id`, one busy city may dominate a partition while other partitions remain quiet. Choosing `order_id` usually offers more useful parallelism when ordering is only required within one order.

A single hot key stays on one partition under ordinary keyed routing. More brokers do not split it. More regular-group consumers do not share its ownership. You may reduce the work per event, cache data, aggregate upstream, or change the key if the business can tolerate a different ordering boundary.

Salting a key, such as adding a shard suffix, can distribute traffic but relaxes the original ordering relationship. Different salted keys may also hash to the same partition; salting is not a guarantee of separate lanes. Some designs need a second aggregation stage to combine the pieces.

Increasing the partition count can remap existing keys. Kafka does not automatically redistribute the old records into new partitions. An order's older events may remain in the old partition while its newer events enter another, so a careless expansion can break the reader's assumed single-partition history. Plan migrations, stable routing, or version-aware consumers. Kafka does not support reducing a topic's partition count in place. [Basic Kafka operations](https://kafka.apache.org/43/operations/basic-kafka-operations/).

<details>
<summary>🖼️ Image prompt 21 — A hot key and a changing map</summary>

**Purpose:** Useful scaling depends on the ordering key, and partition expansion needs a migration plan.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Two panels. Left: P0/P1/P2 lanes with a very large city-7 stack on P1 and light stacks elsewhere; extra consumers below cannot subdivide that lane. Right: before/after routing maps for three and six partitions, with one order key pointing to an old partition for historical records and potentially a new partition for future records. Keep the before/after outcomes labeled illustrative.

**Exact labels:** Hot key: city-7; P0; P1; P2; More consumers; 3 partitions; 6 partitions; Old records stay; New routing may change

**Accuracy guardrails:** Do not claim every key changes, or that the selected before/after mapping is a computed hash. More partitions do not rearrange historical records automatically. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Useful scaling depends on the ordering key, and partition expansion needs a migration plan.

**Alt text:** One hot key overloads a single lane; a separate panel shows how adding partitions can change routing while old records remain in place.

</details>

**🎯 Interview check:** An interviewer says “add partitions” to fix a hot order. What do you say?  
**How to answer:** A single key still goes to one partition. Clarify whether the unit of ordering can change; otherwise optimize that key’s serial work or change the application design.

**⚠️ Common misunderstanding:** “More partitions preserve the exact same key mapping.” Many hash-based mappings change when the partition count changes.

**💡 Easy-to-miss detail:** Transition periods matter. Test readers against old and new partition layouts and entity versions before expanding a topic that depends on strict per-key history.

**⚖️ Trade-off:** More partitions offer parallelism but add metadata, replica work, files, assignment overhead, and recovery work. Select a measured starting point rather than the largest possible count.

### 4.3 Replication and ISR: follow one partition’s copies

Our P1 leader is B2. B1 and B3 maintain follower replicas by fetching from the leader. The leader's log assigns offsets, so offset 42 identifies the same logical record in each replica of P1.

The **in-sync replica set**, or ISR, tracks replicas that are sufficiently caught up under Kafka's rules. It includes the leader. A follower that falls too far behind can leave the ISR; it may still hold useful data, but it no longer participates as a current in-sync replica.

Replication is therefore a moving condition, not a static “three servers exist” fact. A broker can be running yet too slow to remain in sync. That changes write availability and acknowledgement behavior.

Consumers normally fetch from leaders in the basic setup. Kafka can support configured follower fetching for locality, so “consumers always read leaders in every deployment” is too strong. The worked journey uses leader reads. [Kafka design](https://kafka.apache.org/43/design/design/).

<details>
<summary>🖼️ Image prompt 22 — Replication factor stays three while ISR changes</summary>

**Purpose:** Replication factor counts configured copies; ISR describes the currently in-sync set.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use two side-by-side panels, each containing B1/B2/B3 with P1 replicas. In both mark B2 leader. Healthy panel encloses all three in a green ISR boundary. Lagging panel leaves B3 outside the ISR boundary and colors only its lag indicator amber. Show follower fetch control arrows toward B2 and data responses back toward followers, with a tiny legend.

**Exact labels:** P1; B1 follower; B2 leader; B3 follower; RF3; ISR: B1, B2, B3; B3 lagging; ISR: B1, B2

**Accuracy guardrails:** RF remains three even when ISR falls to two. Do not erase the lagging replica or show followers as unrelated partition data. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Replication factor counts configured copies; ISR describes the currently in-sync set.

**Alt text:** The same three replicas remain configured while a lagging follower leaves the in-sync replica set.

</details>

**🎯 Interview check:** Can an RF3 topic have an ISR of two?  
**How to answer:** Yes. One configured replica may be lagging or unavailable. Replication factor and current ISR describe different things.

**⚠️ Common misunderstanding:** “Broker up means replica in sync.” A live broker can still fail to keep up with a partition.

**💡 Easy-to-miss detail:** Monitor ISR changes and under-replicated partitions before the next failure removes the remaining safety margin.

### 4.4 Acknowledgements and minimum ISR: choose what success means

A producer acknowledgement answers a storage question: did this write meet the requested Kafka acknowledgement condition? It does not answer whether a restaurant processed the order.

| Producer setting | What a successful response represents | Main limitation |
|---|---|---|
| `acks=0` | No broker acknowledgement is requested | The client cannot confirm broker acceptance from an ack |
| `acks=1` | The leader accepted the write locally | A leader failure can lose data followers have not replicated |
| `acks=all` | The current in-sync set satisfies the acknowledgement condition | Availability also depends on ISR and topic policy |

Choose `acks=all` and `min.insync.replicas=2` for this RF3 example. In a **stable ISR**, the behavior is:

| Current ISR | Outcome for our write |
|---|---|
| B1, B2, B3 | Wait for all three in-sync replicas, not just two |
| B1, B2 | Two in-sync replicas can satisfy the write |
| B2 only | The minimum is not met, so writes using `acks=all` fail |

`min.insync.replicas` is a minimum safety condition, not a request to ignore additional current ISR members. It is intended to work with `acks=all`; it does not turn weak acknowledgement settings into strong ones. Membership changes during a request can produce errors or uncertain outcomes, including cases where data was appended before an error. [Topic configuration](https://kafka.apache.org/43/configuration/topic-configs/).

Acknowledgement also does not mean each broker performed a physical disk `fsync` for that individual record. Kafka's durability model includes replication and operating-system caching; state the failure model instead of promising survival of every simultaneous power/storage failure.

<details>
<summary>🖼️ Image prompt 23 — What acks=all waits for</summary>

**Purpose:** Minimum ISR sets the safety threshold; acks=all concerns the current in-sync set.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create three evenly spaced panels titled ISR3, ISR2, ISR1. Each shows B2 leader and configured replicas B1/B3; faded replicas are outside ISR. In ISR3 show three completion checks before producer success. In ISR2 show two checks before success. In ISR1 show an amber rejected-write marker. Put chosen settings in one header strip.

**Exact labels:** RF3; acks=all; min.insync.replicas=2; ISR3: wait for 3; ISR2: wait for 2; ISR1: reject; B1; B2; B3

**Accuracy guardrails:** These are stable-membership examples. Do not show success after only two acknowledgements while three replicas remain in ISR, or claim acknowledgement means consumers processed the record. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Minimum ISR sets the safety threshold; acks=all concerns the current in-sync set.

**Alt text:** With RF3 and minimum ISR2, writes can succeed with three or two in-sync replicas but fail when only one remains.

</details>

**🎯 Interview check:** With RF3, ISR3, minimum ISR2, and acks=all, does success wait for two or three replicas?  
**How to answer:** Three in the stable case: all current ISR members. The value two is the minimum ISR required to accept this policy’s writes.

**⚠️ Common misunderstanding:** “acks=all always means every configured replica.” A configured replica outside the ISR is not simply included in that phrase.

**💡 Easy-to-miss detail:** A timeout may mean “outcome unknown,” not “record absent.” Use producer idempotence and application event IDs so a safe retry does not create an unsafe business duplicate.

**⚖️ Trade-off:** Stronger acknowledgement requirements reduce the chance of losing acknowledged data, but may reject writes during replica trouble. Make that business choice explicit.

### 4.5 Leader failure: availability has a safety boundary

If B2 fails, Kafka needs another eligible replica to lead P1. Clients may see errors while leadership changes, then refresh metadata and retry. Reads and writes do not have to remain continuously available through that transition.

A simple explanation says “elect an in-sync follower.” Modern Kafka adds **eligible leader replicas (ELR)**, which can preserve safe election candidates outside the current ISR under defined conditions. ELR is available from Kafka 4.0 and enabled by default for newly created clusters from 4.1; upgrade and feature settings still matter. Do not treat every out-of-ISR election as unclean. [Eligible leader replicas](https://kafka.apache.org/43/operations/eligible-leader-replicas/).

An unclean election may choose a replica missing acknowledged records and can lose data. The right choice depends on whether the business prefers unavailability or possible data loss; do not casually enable it to make an alert disappear.

Even after a leader is available, an ISR below the configured minimum may prevent new strongly acknowledged writes. **Having a leader and being writable are different conditions.**

<details>
<summary>🖼️ Image prompt 24 — Elect safely, then check writability</summary>

**Purpose:** Recovery requires both a safe leader and enough replicas to satisfy the write policy.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw a simple decision sequence in four spacious cards: B2 fails, eligible replacement?, new leader, ISR meets minimum?. Branch to an amber Unavailable state if there is no safe candidate, and to Writes wait if minimum ISR is not met. Use dashed control arrows for elections. Place a small separate caution box for unclean election and possible loss.

**Exact labels:** B2 fails; Eligible replacement?; New leader; ISR meets minimum?; Unavailable; Writes wait; Unclean election: possible loss

**Accuracy guardrails:** Do not equate all non-ISR candidates with unclean election; include ELR in eligibility. Do not imply electing a leader guarantees writes can meet minimum ISR. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Recovery requires both a safe leader and enough replicas to satisfy the write policy.

**Alt text:** A failed leader triggers an eligibility decision, followed by a separate check that the new leader has enough in-sync replicas for writes.

</details>

**🎯 Interview check:** Would you trade acknowledged orders for faster recovery?  
**How to answer:** Clarify the business loss tolerance first. For durable order intent, temporary unavailability is usually preferable to silently losing accepted orders; design the API and recovery path accordingly.

**⚠️ Common misunderstanding:** “Replication guarantees uninterrupted availability.” Election delays and safety thresholds can intentionally stop work.

**💡 Easy-to-miss detail:** Test correlated failures and leader changes, not only clean consumer restarts. Verify that clients reach the newly advertised leader and that the application reports uncertain outcomes honestly.

<a id="5-one-complete-journey"></a>

---

## 5. 📨 Follow one message from the customer to the committed offset

Now we can follow the whole path without treating any box as magic.

Keep these values fixed: topic `order-events`, key `order-8472`, event `evt-8472-1`, three partitions, assumed destination **P1**, leader **B2**, followers **B1/B3**, replication factor **3**, `acks=all`, and `min.insync.replicas=2`. All three replicas start in sync. The regular consumer group is `restaurant-view`.

This is a worked example, not a capture from a running cluster. The initial event at offset 42 is `OrderPlaced`; a later `RestaurantAccepted` would be a separate event.

<details>
<summary>🖼️ Image prompt 25 — The complete journey of order-8472</summary>

**Purpose:** One event crosses several independent durability and progress boundaries before its consumer saves the next offset.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use four spacious numbered panels in a 2-by-2 grid, read left to right then top to bottom. Panel 1: Customer asks Order API, then Orders + outbox commit inside one database boundary; a Recorded response returns to Customer. Panel 2: Relay and Producer turn evt-8472-1 into a keyed record and route it to P1 using metadata. Panel 3: B2 leads P1, appends offset 42, and replicates to B1/B3; a return arrow acknowledges the producer after the stated condition. Panel 4: restaurant-view consumer fetches 42, commits its idempotent DB effect, then sends a dashed checkpoint arrow labeled 43 to the Group coordinator. Connect panels with numbered data-flow arrows; use a legend and short labels only.

**Exact labels:** 1 Save intent; Customer; Order API; Orders + outbox; Recorded; 2 Publish; Relay + producer; order-8472; P1; 3 Replicate; B2 leader; Offset 42; B1/B3 followers; Kafka ack; 4 Process; restaurant-view; DB effect; Commit next: 43; Group coordinator

**Accuracy guardrails:** P1 routing is assumed for this demonstration. RF3 includes B2, B1, B3; all start in ISR and acks=all uses minimum ISR2. Distinguish the database commit, producer acknowledgement, business effect, and group checkpoint. The controller is not a data-forwarding hop; consumption does not delete offset 42. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** One event crosses several independent durability and progress boundaries before its consumer saves the next offset.

**Alt text:** Four panels trace an order from atomic database intent through producer routing and replicated Kafka storage to an idempotent consumer effect and checkpoint 43.

</details>

### 5.1 From the request to durable publication intent

**Step 1 — The API validates the request.** It checks the request's format and business rules. An API idempotency key can prevent a retried customer request from creating a second order. That is different from Kafka producer idempotence.

**Step 2 — The database commits two rows together.** In one database transaction, save the order in a pending state and an outbox row representing `evt-8472-1`. Either both are committed or neither is. The API can now report “order recorded”; it does not report restaurant acceptance.

Why not just save the order and then call Kafka? Because the process can crash between the two writes. Reversing the order creates the opposite problem: an event may describe a database change that never committed. An outbox makes the **intent to publish** durable alongside the business state. [Transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).

**Step 3 — A relay publishes the outbox event.** This can be a polling relay or CDC-based integration. It chooses `order-events` and uses `order-8472` as the key. The relay must preserve the needed per-entity sequence and manage its own progress. A crash after publication but before recording relay progress can publish the same event again.

An outbox therefore closes the missing-publication gap; it does not remove the need for deduplication. CDC tooling can route outbox rows using event identity and aggregate keys, but its configuration and failure behavior still need testing. [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html).

<details>
<summary>🖼️ Image prompt 26 — Save the order and publication intent together</summary>

**Purpose:** An outbox commits the order and its publication intent together, then permits retryable publication.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use five main groups left to right: Customer request, Order API, one database transaction boundary containing Orders and Outbox, Relay or CDC, order-events. Show a green commit check around the two database writes together. Draw the Recorded response back to the customer only after that database commit. Put a small possible-duplicate loop around relay publication.

**Exact labels:** Customer request; Order API; One DB transaction; Orders; Outbox; Recorded, pending confirmation; Relay or CDC; order-events; Retry may duplicate

**Accuracy guardrails:** Do not draw a transaction boundary around both the database and Kafka. Do not label the outbox exactly-once delivery. Separate API acknowledgement from Kafka acknowledgement. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** An outbox commits the order and its publication intent together, then permits retryable publication.

**Alt text:** The API atomically saves an order and outbox entry before a relay publishes the event to Kafka.

</details>

**🎯 Interview check:** Why is “database commit, then Kafka send” unsafe?  
**How to answer:** A crash between them can leave an order with no event. Store publication intent in the same database transaction and relay it reliably afterward.

**⚠️ Common misunderstanding:** “Outbox makes delivery exactly once.” Relays can publish duplicates; stable event IDs and safe consumers are still required.

**💡 Easy-to-miss detail:** The outbox can become a backlog too. Monitor the oldest unpublished row, relay failures, cleanup, and per-entity publication order.

**⚖️ Trade-off:** The extra table and relay add work, but let you separate a reliable database commit from temporary Kafka availability. A database-native change feed may fit some integrations better than hand-written polling.

### 5.2 From producer decisions to broker acknowledgement

**Step 4 — Serialize and route.** The producer serializes the key and value. Its routing policy selects P1; metadata identifies B2 as leader. An invalid schema or serialization error must be handled before calling the event published.

**Step 5 — Batch and send.** The client places the record in a P1 batch and sends it to B2. Batching and compression reduce overhead; waiting for a batch or a slow network can add latency. A filled buffer or an expired delivery deadline produces a failure the relay must handle.

**Step 6 — Append and assign the offset.** B2 validates the request and appends the record. In this example it assigns offset **42**. Applications do not choose this offset, and the number does not identify the record's business version.

**Step 7 — Replicate and acknowledge.** B1 and B3 fetch the appended record. With all three replicas remaining in ISR, success under `acks=all` waits for that in-sync replication condition. If only two are in ISR, our minimum of two still permits a successful write. If only one remains, the policy rejects writes.

After successful completion, the producer receives metadata including the topic, partition, and offset. That proves the requested Kafka write condition was met, not that a consumer has seen the event.

If a response is lost, the producer may not know that the append succeeded. Producer idempotence handles duplicate writes caused by supported protocol retries; a relay publishing a fresh application-level duplicate still needs the event's business identity. [KafkaProducer API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/producer/KafkaProducer.html).

<details>
<summary>🖼️ Image prompt 27 — Follow record 42 into replicated storage</summary>

**Purpose:** Producer routing, broker append, replication, and acknowledgement are separate decisions.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use a wide two-row sequence with six cards: Serialize, Choose P1, Find leader B2, Append offset 42, Replicate to B1/B3, Acknowledge. In the replication card show B2 leader plus B1/B3 followers with identical 42 cards. Place the return acknowledgement only after the replication card. Add one amber response-lost branch returning to the producer retry path.

**Exact labels:** evt-8472-1; Serialize; P1; B2 leader; Offset 42; B1 follower; B3 follower; acks=all; Success; Response lost?

**Accuracy guardrails:** P1 is the stipulated mapping. Offset 42 is assigned by the log append, not the producer. A lost response is an uncertain outcome, not proof of absence. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Producer routing, broker append, replication, and acknowledgement are separate decisions.

**Alt text:** One event is routed to P1, assigned offset 42 by B2, replicated to followers, and acknowledged to the producer.

</details>

**🎯 Interview check:** Who decides the topic, partition, leader, and offset?  
**How to answer:** The application chooses the topic; producer routing chooses the partition; Kafka metadata/election identifies its leader; the leader append assigns the offset.

**⚠️ Common misunderstanding:** “Kafka acknowledgement means restaurant processing finished.” It confirms the requested storage acknowledgement condition only.

**💡 Easy-to-miss detail:** Record successful send metadata and stable event IDs for diagnosis. On failure, distinguish permanent validation errors from retryable or uncertain delivery outcomes.

### 5.3 From visible data to a safe business effect

**Step 8 — Respect the visibility boundary.** Broker replication establishes which data is committed for ordinary reads. The high watermark describes that replication boundary. `read_uncommitted` does not mean a consumer can read arbitrary leader-only bytes beyond it.

Kafka transactions add another boundary. A `read_committed` consumer sees committed transactional data and filters aborted transactions; an open transaction can hold its view behind the log end until the relevant stable boundary advances. This is why producer acknowledgement, Kafka transaction commit, and consumer visibility are not interchangeable. Our example event is nontransactional. [Consumer configuration](https://kafka.apache.org/43/configuration/consumer-configs/).

**Step 9 — Assign P1 and choose where to start.** Group coordination assigns P1 to C2 in `restaurant-view`. The group has previously committed **42**, so C2 resumes from 42. If no valid checkpoint exists, the reset policy determines whether to start at available history, at the current end, or fail. `auto.offset.reset` does not override a valid checkpoint on every restart.

**Step 10 — Fetch and process.** C2 requests records from its current position. In this simple poll it receives only record 42, so its local position becomes 43. It deserializes, validates the contract, checks the event ID, and updates the restaurant read model.

For safe replay, one database transaction records `(handler_name, event_id)` with a unique constraint and updates the view. On an already-recorded event, the handler skips the repeated effect. If a crash occurs before that transaction commits, it leaves neither the completed marker nor a partial committed update.

This transaction protects this database effect. Sending a notification or calling another service would require that destination's own idempotency or a separate durable handoff.

<details>
<summary>🖼️ Image prompt 28 — Visible does not mean processed</summary>

**Purpose:** A visible record still needs application validation and a replay-safe business effect.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use three spaced layers. Top: P1 log with a replication visibility bracket and a smaller transactional visibility bracket labeled conditional. Middle: C2 inside restaurant-view fetching record 42, with position 43 shown separately. Bottom: one database transaction enclosing Event-ID check and Read-model update. Put a small note Nontransactional example next to event 42.

**Exact labels:** P1; Replication boundary; Transaction boundary when applicable; restaurant-view; C2; Record 42; Position 43; Event-ID check; Read-model update; One DB transaction

**Accuracy guardrails:** Do not confuse visibility boundaries with group checkpoints. Do not imply a database transaction includes an external notification or Kafka transaction automatically. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A visible record still needs application validation and a replay-safe business effect.

**Alt text:** C2 fetches visible record 42 and updates a database view with an event-ID marker in one transaction.

</details>

**🎯 Interview check:** Why can the consumer position be ahead of completed work?  
**How to answer:** Fetching advances the client’s position. The application may still be validating or processing those records, especially after a large poll or asynchronous handoff.

**⚠️ Common misunderstanding:** “read_committed means every external business action is exactly once.” It controls Kafka transactional visibility, not external systems.

**💡 Easy-to-miss detail:** A unique marker inserted before the effect in a separate committed transaction is unsafe: a crash can leave “done” recorded with no effect. Commit the marker and protected database effect together.

### 5.4 Commit the next offset, then examine the crash windows

**Step 11 — Commit the safe next position.** Once the database transaction succeeds, the application asks its group coordinator to commit **43** for `restaurant-view / order-events / P1`. Kafka normally persists this checkpoint in the internal `__consumer_offsets` topic. This is group metadata, not a new `OrderPlaced` event in the application topic.

**Step 12 — Resume later from the checkpoint.** After the commit succeeds, a replacement consumer starts at 43. Other groups are unaffected; analytics might still be at 10. The commit also does not delete record 42.

| Moment in this one-record example | Local position | Committed offset | Meaning |
|---|---:|---:|---|
| Before the poll | 42 | 42 | Record 42 is next |
| After fetching 42 | 43 | 42 | Read, but not checkpointed |
| After the database effect | 43 | 42 | Effect is durable; replay remains possible |
| After commit succeeds | 43 | 43 | Resume from 43 |

Now place a crash between the steps:

| Crash point | What a replacement does | Design consequence |
|---|---|---|
| Before the business effect | Reads 42 again | The work can be retried |
| After the effect, before commit 43 | Reads 42 again | Deduplication must prevent repeating the effect |
| After commit 43 succeeds | Starts at 43 | The protected effect for 42 is already durable |
| Commit 43 happened before the effect, then crash | Starts at 43 | The intended effect can be skipped |

Kafka does not examine your database before accepting a checkpoint. It trusts the application to choose a safe position.

With concurrent work, do not commit past an unfinished earlier record. If 42 is still running and 43 has finished, committing 44 would skip 42 after a restart. Track the completed prefix per partition. For fully processed polls, current Java clients provide `ConsumerRecords.nextOffsets()`; those next positions and leader epochs are safer than assuming all visible offsets are consecutive. The surrounding ownership and failure handling still matter. [KafkaConsumer API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html).

<details>
<summary>🖼️ Image prompt 29 — The crash between effect and checkpoint</summary>

**Purpose:** A checkpoint saves the next position; its timing determines whether a crash causes replay or skipped work.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use three broad horizontal timelines. First: fetch 42, crash before effect, restart 42. Second: fetch 42, DB effect committed, crash before checkpoint, restart 42 and deduplicate. Third: fetch 42, DB effect committed, commit 43, restart 43. Add a separate small amber warning strip for commit 43 before effect leading to skipped work. Keep each row spacious and use numbered event cards.

**Exact labels:** Fetch 42; DB effect; Crash; Resume 42; Deduplicate; Commit 43; Resume 43; Commit too early; Skipped work

**Accuracy guardrails:** Commit 43 means next to read is 43. Distinguish the database commit from the Kafka offset commit. Do not show record deletion or a global group-independent checkpoint. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A checkpoint saves the next position; its timing determines whether a crash causes replay or skipped work.

**Alt text:** Crash timelines show replay before checkpointing, safe resumption after checkpointing, and the danger of committing before business work.

</details>

**🎯 Interview check:** Which is safer: commit before or after the effect?  
**How to answer:** After a durable, replay-safe effect for an at-least-once design. Before processing risks skipping work; after processing still requires duplicate handling across the crash window.

**⚠️ Common misunderstanding:** “A commit acknowledges each individual message.” In a regular consumer group it records a cumulative next position for a partition.

**💡 Easy-to-miss detail:** If a commit fails or times out, do not assume progress was saved or blindly retry a stale checkpoint after ownership changes. Keep effects safe to repeat and handle group membership correctly.

**Who decides what? Keep this table beside the journey.**

| Decision | Owner | Input or rule |
|---|---|---|
| Is the order valid, and what does the API promise? | Order application | Business rules and committed database state |
| Which topic and key? | Application/relay | Event contract and ordering requirement |
| Which partition? | Producer routing policy | Explicit choice, serialized key, custom policy, or unkeyed strategy |
| Which broker leads that partition? | Kafka metadata and leadership management | Replica placement and election state |
| Which offset? | Partition leader append | Current log position |
| When may the producer report Kafka success? | Broker and producer protocol | Acknowledgements, ISR, minimum ISR, response |
| Which member owns P1? | Group protocol and coordinator/assignor participants | Membership, subscriptions, assignment strategy |
| Where does that member start? | Client using committed group state/reset policy | Valid checkpoint or deliberate reset choice |
| Did the business action succeed? | Consumer application and its destination | Transaction result or external response |
| Which next offset is safe to commit? | Consumer application | Completed work under current ownership |

**Pause and explain it aloud:** “The database makes the order and publication intent durable. The producer routes an event to a partition leader. Kafka replicates and acknowledges it. An assigned consumer fetches it, performs a safe effect, and checkpoints where its group should resume.” If you can explain why every verb is separate, you understand the heart of Kafka.

<a id="6-use-cases"></a>

---

## 6. 🧭 When Kafka helps—and when a simpler choice is better

“Kafka handles lots of messages” is too broad to guide a design. Ask what needs durable buffering, replay, independent readers, or per-key ordering—and which system owns the business decision.

The following are major practical families, not a claim to enumerate every possible application. Each gets its own scenario, before-and-after visual prompt, and explicit “Use Kafka when” / “Choose differently when” guidance. Section 6.16 then walks through six cases where another primary mechanism fits better. Start with the cases closest to your work, then compare the others: the same durable stream can support very different applications, but their guarantees and trade-offs will differ.

### 6.1 🖼️ Asynchronous expensive jobs

A courier uploads a delivery photo. MealRoute must resize it, scan it, and prepare a support-friendly version. The phone should not wait for every transformation.

Store the original in object storage, then publish a small job event containing a durable object identifier, checksum, event ID, and processing version. Workers fetch the object and write derived outputs. Kafka becomes attractive when several processing applications need the same job history or when replay is useful.

An acknowledgement of the job means it was accepted for processing, not that the photo is ready. Show a pending status and record completion separately.

**Use Kafka when:** Several processing applications need the same durable job history, independent progress, or the ability to reprocess it.

**Choose differently when:** A simple job queue is usually easier for one worker pool with no replay or additional readers; object storage should still hold the photo.

<details>
<summary>🖼️ Image prompt 30 — Keep the photo outside the event log</summary>

**Purpose:** Move expensive photo work out of the upload request while keeping a durable path to completion.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a courier waiting on an upload screen while Resize, Scan, and Preview work are chained to the request. Put an amber Waiting for processing clock beside the phone. Right panel — Save the photo in Object storage, publish its stable object ID to photo-jobs, and show a backend worker fetching the photo and writing derived images. Add a Pending to Ready status card. Indicate that additional processing applications can use independent groups. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Courier upload; Waiting for processing; Object storage; photo-jobs; Stable object ID; Worker; Derived images; Pending; Ready

**Accuracy guardrails:** Kafka carries a reference rather than the photo bytes. A job acknowledgement is not completed processing. Keep a durable ID instead of relying only on an expiring URL. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Move expensive photo work out of the upload request while keeping a durable path to completion.

**Alt text:** A courier waits for synchronous photo processing; afterward, object storage holds the photo while a durable job event lets a worker process it and update readiness.

</details>

**🎯 Interview check:** Why not put the photo bytes directly in Kafka?  
**How to answer:** Large records increase memory, network, and retry cost. Object storage is usually a better payload store; keep durable identifiers and integrity metadata in the event.

**⚠️ Common misunderstanding:** “Kafka is a video or image storage service.” It is usually the event pipeline around that storage.

**💡 Easy-to-miss detail:** The object must remain accessible for the replay window. Store a stable ID and obtain fresh authorized access when processing.

**⚖️ Trade-off:** A simple task queue is often easier for one worker pool without history reuse. Kafka is more compelling when several pipelines or replay requirements share the event stream.

### 6.2 🌊 Burst absorption and independent scaling

A citywide lunch promotion creates a short arrival spike. Order intake can record intent quickly, but restaurant-view updates and enrichment can only process at a bounded rate.

Kafka holds the temporary backlog while workers drain it. The producer and consumer sides can scale at different speeds. This does not create unlimited capacity: sustained arrivals above processing capacity eventually exhaust the time or storage budget.

Define an acceptable event age and a maximum backlog. Apply admission control or degrade optional work before the user-visible delay becomes unacceptable.

**Use Kafka when:** A burst is temporary, completion can be delayed within a clear deadline, and post-burst capacity can drain the retained backlog.

**Choose differently when:** Use admission control and sufficient immediate capacity when work cannot wait; no buffer solves sustained overload without more capacity or less accepted work.

<details>
<summary>🖼️ Image prompt 31 — A burst becomes a bounded backlog</summary>

**Purpose:** A durable buffer buys recovery time for a temporary burst, not unlimited processing capacity.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a lunch-promotion banner causing more order cards to arrive than one worker can process. Put delayed kitchen updates beside the accumulating cards and a marked arrival-rate spike. Right panel — Place a retained backlog between intake and a bounded worker pool. Show a second time interval in which processing exceeds new arrivals and the backlog shrinks. Include an event-age deadline clock. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Lunch promotion; Arrival spike; Delayed updates; Retained backlog; Worker pool; Catch-up period; Processing > arrivals; Event-age limit

**Accuracy guardrails:** The burst is hypothetical. Do not show infinite buffering or backlog draining when processing merely equals arrival rate. A business delay limit still applies. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** A durable buffer buys recovery time for a temporary burst, not unlimited processing capacity.

**Alt text:** A lunch-promotion spike overwhelms immediate processing; a bounded retained backlog smooths the spike and later drains when worker capacity exceeds arrivals.

</details>

**🎯 Interview check:** How do you know buffering is enough?  
**How to answer:** Estimate backlog growth during the burst and catch-up time afterward. Check both retention and the business delay deadline.

**⚠️ Common misunderstanding:** “Kafka makes slow consumers harmless.” They still create delayed outcomes and can fall beyond retention.

**💡 Easy-to-miss detail:** An offset-lag count is not a customer delay measurement. Track event age and end-to-end completion latency too.

**⚖️ Trade-off:** Buffering smooths spikes but increases waiting time. If the work must finish immediately, use admission control and enough synchronous capacity instead of hiding the overload.

### 6.3 🎟️ Ordered admission or waiting rooms — with a separate authority

MealRoute opens a limited number of premium delivery slots. Thousands of customers request the same window. A keyed stream can provide a durable intake order for one slot pool, and an admission worker can process requests predictably.

But Kafka cannot decide which request deserves priority, prevent duplicate reservations by itself, expire a hold, or prove fairness across multiple partitions. A reservation service and authoritative database must enforce capacity and idempotent admission.

Even one partition orders broker appends, not necessarily the exact time every human clicked. A fairness policy needs a clearly defined ordering authority and rules for retries.

**Use Kafka when:** You need durable request intake for an admission pool and have a separate authority that enforces capacity, identity, expiry, and the chosen fairness policy.

**Choose differently when:** Choose a purpose-built admission service or a direct transactional reservation flow when those semantics are the main requirement and a shared replayable stream is unnecessary.

<details>
<summary>🖼️ Image prompt 32 — Ordered intake is not the reservation authority</summary>

**Purpose:** Order the intake when useful, but let an authoritative reservation system decide who receives a slot.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show many customers requesting the same limited delivery slot, a visibly overloaded reservation endpoint, and an uncertain request-status screen. Do not depict a numerical overbooking outcome as inevitable. Right panel — Put a Slot-pool intake log before an Admission worker. The worker consults a Capacity + reservations database before returning Hold granted or Waitlisted. Show a hold-expiry clock and a separate fairness-policy note. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Slot requests; Overloaded endpoint; Request status?; Slot-pool intake; Admission worker; Capacity + reservations; Hold granted; Waitlisted; Hold expiry; Fairness policy

**Accuracy guardrails:** Kafka alone does not prevent overbooking, define click-time fairness, or create one total order across partitions. The reservation database owns capacity decisions. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Order the intake when useful, but let an authoritative reservation system decide who receives a slot.

**Alt text:** Many requests overload a limited-slot endpoint; an intake log feeds an admission worker that consults an authoritative reservation store before granting a hold.

</details>

**🎯 Interview check:** Can a Kafka queue guarantee no overbooking?  
**How to answer:** No. The reservation authority must atomically check and allocate capacity. Kafka organizes intake and recovery around that decision.

**⚠️ Common misunderstanding:** “One partition makes the system globally fair.” Append order is only one ordering policy and may differ from user arrival time.

**💡 Easy-to-miss detail:** Retries must reuse a request identity or they can create multiple attempts in the waiting room. Expiry and cancellation also need explicit handling.

**⚖️ Trade-off:** Kafka can support a high-volume durable intake pipeline, but a purpose-built waiting-room or reservation system may provide the required fairness and admission features more directly.

### 6.4 📣 Service events and independent reactions

When a restaurant accepts an order, notifications send an update, loyalty records a qualifying purchase state, and analytics measures the wait. These are different applications with different progress and failure policies.

Publish the business fact once, using reliable publication, and let separate groups react independently. The producing service need not contain a growing list of every interested application.

Consumers still depend on a stable event contract. Event-driven communication reduces some timing dependencies; it does not erase semantic dependencies or deployment coordination.

**Use Kafka when:** Several independently deployed applications need the same business facts, and their outages or replay schedules should not share a checkpoint.

**Choose differently when:** A direct call or lighter messaging system may suffice for one simple reaction without retained history or independent subscriber needs.

<details>
<summary>🖼️ Image prompt 33 — One accepted order, independent reactions</summary>

**Purpose:** Publish one business fact and let each application complete its own reaction independently.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a Restaurant acceptance service calling Notifications, Loyalty, and Analytics directly, with an amber Analytics timeout delaying a required response. Keep one accepted-order fact central. Right panel — Publish RestaurantAccepted through a reliable publication handoff to order-events. Show separate Notifications, Loyalty, and Analytics group boundaries, each with its own bookmark and output. Pause analytics while the others continue. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; RestaurantAccepted; Direct dependencies; Analytics timeout; Reliable publication; order-events; Notifications; Loyalty; Analytics; Independent bookmarks

**Accuracy guardrails:** The publication handoff is not automatically atomic with a database write. Each application has its own group; one shared group would distribute work rather than broadcast it. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Publish one business fact and let each application complete its own reaction independently.

**Alt text:** A restaurant acceptance request waits on several downstream services; separate consumer groups let notifications, loyalty, and analytics react independently.

</details>

**🎯 Interview check:** How do you add a new subscriber without changing the producer?  
**How to answer:** Publish a documented event contract and give the new application its own group, permissions, starting position, and capacity plan.

**⚠️ Common misunderstanding:** “Decoupled services need no shared contracts.” They still agree on meaning, schema, and compatibility.

**💡 Easy-to-miss detail:** A fact should describe what occurred, not expose every internal database field. Design events for consumers’ stable needs.

**⚖️ Trade-off:** Kafka offers retained fan-out and replay, but a lightweight broker or direct call may suffice when there is one reader and no history requirement.

### 6.5 📱 Live order status and delivery gateways

Customers want to see “preparing,” “picked up,” and “arriving.” A backend status service consumes order and courier events, updates a current-status view, and forwards relevant updates through WebSocket or server-sent-event gateways.

Kafka connects backend services. Browsers and phones normally connect to an authenticated gateway, not directly to Kafka with a consumer group for every customer.

On reconnection, a client should fetch the current state and resume updates using an application-level version or cursor. Kafka retention alone is not a complete client reconnect protocol.

**Use Kafka when:** Backend status history needs replay or several readers, while an authenticated gateway manages client delivery and reconnect behavior.

**Choose differently when:** For a small live feature, a database change feed or simpler pub/sub service plus a gateway may meet the requirement with less infrastructure.

<details>
<summary>🖼️ Image prompt 34 — Backend stream to live customer updates</summary>

**Purpose:** Use the stream behind a gateway so live updates and reconnect recovery have clear owners.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a customer phone repeatedly refreshing a stale order page and a status service polling several backends. Add a brief connection-drop icon to expose the missed-update problem. Right panel — Send backend events through a Status processor to a Current-status store and a Live gateway. Connect the phone through WebSocket / SSE, and show its reconnect path fetching a current snapshot. Mark authorization at the gateway. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Stale order page; Repeated polling; Connection lost; Status processor; Current status; Live gateway; WebSocket / SSE; Reconnect snapshot; Authorized client

**Accuracy guardrails:** The phone is not a Kafka consumer. Kafka does not supply the whole live gateway or reconnect protocol, and event delivery is not guaranteed instantaneous. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Use the stream behind a gateway so live updates and reconnect recovery have clear owners.

**Alt text:** A customer sees a stale page and loses updates on disconnect; a status processor, current-state store, and live gateway support updates and snapshot recovery.

</details>

**🎯 Interview check:** Why can’t Kafka alone replace a WebSocket service?  
**How to answer:** It does not provide the full client connection, authorization, subscription, fan-out, and reconnect behavior. A gateway owns those responsibilities.

**⚠️ Common misunderstanding:** “Kafka pushes directly to every app screen.” Consumers fetch backend records; a separate delivery layer serves users.

**💡 Easy-to-miss detail:** Many users may watch the same order or event. Gateway fan-out capacity and per-user access checks can dominate the design.

**⚖️ Trade-off:** Use Kafka when backend history and multiple readers matter. For a small live feature, a database change feed plus gateway may be simpler.

### 6.6 🔄 CDC, database integration, and reliable publication

A restaurant changes its opening hours in the source database. Other systems need that change without repeatedly scanning every row. Change data capture, or CDC, reads the database's change stream and publishes changes for downstream integration.

Raw row-change events are useful for replicating data. A business event such as `RestaurantClosedForToday` may carry a different meaning and contract. An outbox can represent that deliberate business event, while CDC transports the outbox changes.

Initial snapshots and ongoing changes must join consistently. A connector name alone does not answer how deletes, schema changes, or source-log retention are handled.

**Use Kafka when:** Several downstream systems need a continuing database change feed or an explicit outbox event stream, with defined snapshot and recovery behavior.

**Choose differently when:** Periodic exports can be sufficient when freshness is relaxed; CDC adds source-log, connector, schema, and recovery responsibilities.

<details>
<summary>🖼️ Image prompt 35 — Choose row changes or business intent deliberately</summary>

**Purpose:** Capture database changes reliably, and choose deliberately whether consumers need row changes or business events.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a restaurant-hours database updated to Closed, while Search and Analytics copies still show Open after slow polling. Mark the change-propagation gap. Right panel — Show the database change log feeding a CDC connector and downstream Kafka topics. Use a small inset distinguishing raw Row changes from intentional Outbox business events; then show the downstream views receiving updates. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Restaurant hours; Closed; Stale: Open; Polling gap; Change log; CDC connector; Row changes; Outbox business events; Updated views

**Accuracy guardrails:** CDC captures changes; an outbox defines publication intent. Neither removes duplicates automatically. Initial snapshots and source-log retention require a plan. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Capture database changes reliably, and choose deliberately whether consumers need row changes or business events.

**Alt text:** Polling leaves restaurant hours inconsistent across systems; a CDC connector transports source changes, with row changes distinguished from deliberate outbox business events.

</details>

**🎯 Interview check:** Is CDC the same as an outbox?  
**How to answer:** No. CDC is a capture mechanism; an outbox is a reliable publication pattern. CDC can be used to transport outbox entries.

**⚠️ Common misunderstanding:** “Database replication events are automatically clean business events.” Their meaning may expose storage details rather than business intent.

**💡 Easy-to-miss detail:** A paused connector can lose access to required source logs. Monitor source retention and snapshot recovery alongside Kafka lag.

**⚖️ Trade-off:** CDC reduces polling and duplicate write logic but introduces connector and schema operations. A periodic export may be enough when freshness requirements are modest.

### 6.7 🔎 Search indexes, caches, and materialized views

Customers search restaurants by cuisine and availability. The operational database remains authoritative, while a consumer updates a search index optimized for queries.

Kafka allows the indexer to retry and rebuild without making the order or restaurant API wait for each indexing operation. The same pattern can maintain read models or propagate cache invalidations.

The view is eventually consistent. A search result may briefly be stale, so recheck authoritative constraints before accepting a critical action. Include entity versions so a delayed older update does not overwrite newer state.

**Use Kafka when:** A derived view should update independently and be rebuildable, and the product can tolerate a defined freshness delay.

**Choose differently when:** Query the authoritative database directly when its query and load capabilities suffice, especially for decisions that cannot trust stale state.

<details>
<summary>🖼️ Image prompt 36 — Build a query view from events</summary>

**Purpose:** Build search and read models asynchronously, with explicit freshness and version checks.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a restaurant update slowing down because the request also waits for a search index, and a customer search page with an outdated availability card. Right panel — Publish the source change reliably, let an Indexer group update a Search index, and show a version check before the write. Put a small Eventual consistency clock on the source-to-index path and an authoritative recheck for critical actions. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Restaurant update; Slow request; Stale search result; Change stream; Indexer; Version check; Search index; Eventual consistency; Recheck authority

**Accuracy guardrails:** The index is derived and may be stale. Kafka does not serve arbitrary search queries or make the index update atomic with the source transaction. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Build search and read models asynchronously, with explicit freshness and version checks.

**Alt text:** Updating a search index delays a source request; an independent indexer maintains a derived search view with version checks and an explicit freshness delay.

</details>

**🎯 Interview check:** How would you rebuild a corrupted search index?  
**How to answer:** Start a new version from a suitable snapshot and retained events, verify freshness and correctness, then switch reads. Avoid disrupting the live index.

**⚠️ Common misunderstanding:** “A cached or indexed value is as current as the source write.” There is a propagation delay.

**💡 Easy-to-miss detail:** Use idempotent upserts and version checks. A retry or replay should not let an old event replace a newer projection.

**⚖️ Trade-off:** Derived views speed reads and isolate workloads, but add lag and rebuild procedures. Query the source directly when scale and query shape allow it.

### 6.8 📊 Real-time aggregation and business dashboards

Operations wants the number of accepted orders per restaurant over the last five minutes. A stream-processing application groups events, maintains state, and emits updated aggregates.

Kafka stores and transports the input and output streams; the processing application performs the computation. Decide whether the window uses business event time or processing time, and how late events revise the result.

An order created at 12:01 but received at 12:04 should not silently move to a different business minute unless that is the chosen metric definition. Duplicate events also need a policy before counting them.

**Use Kafka when:** Operations needs continuously updated metrics, and a processing application can own time windows, state, duplicates, and late-event corrections.

**Choose differently when:** Use scheduled SQL or batch processing when a slower reporting interval meets the requirement and does not need a live stream.

<details>
<summary>🖼️ Image prompt 37 — From events to a five-minute metric</summary>

**Purpose:** Streaming metrics need a time policy and stateful computation, not just a faster message feed.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a restaurant manager looking at yesterday’s demand report while current order cards accumulate. Include a late-arriving event card that a naive arrival-time count would place in the wrong window. Right panel — Feed events into a Windowed processor with a five-minute event-time timeline. Show one late event revising its appropriate window and updated aggregates reaching a live dashboard. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Old report; Current orders; Late event; Event time; Five-minute window; Windowed processor; Revised count; Live dashboard

**Accuracy guardrails:** The processor performs aggregation, not the Kafka broker. Time and correction policies must be explicit; offsets are not event timestamps. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Streaming metrics need a time policy and stateful computation, not just a faster message feed.

**Alt text:** An old report misses current demand and late events; a windowed processor uses event time to revise counts on a live dashboard.

</details>

**🎯 Interview check:** What does “orders in the last five minutes” mean?  
**How to answer:** Define the time source, window type, lateness allowance, deduplication, and whether emitted results can be revised.

**⚠️ Common misunderstanding:** “Kafka automatically calculates aggregates.” A Streams, Flink, or other application owns the computation.

**💡 Easy-to-miss detail:** The same count can be correct under one time policy and misleading under another. Name the metric’s time semantics in its contract.

**⚖️ Trade-off:** Streaming improves freshness but adds state and late-data complexity. Batch SQL may be better when hourly results are sufficient.

### 6.9 🚨 Fraud detection, anomaly detection, and enrichment

MealRoute wants to flag unusual order patterns: many accounts ordering to the same address, a sudden change in courier behavior, or repeated promotion abuse. A processing application combines event streams with reference data and recent state.

Key selection and joins matter. Events joined by customer ID may need repartitioning even if the original order stream is keyed by order ID. State must be recoverable when a processing instance fails.

Decide whether the result is an asynchronous alert or part of an immediate accept/reject decision. A critical synchronous decision may require a serving service with fresh state and a strict deadline, rather than waiting for an unbounded event pipeline.

**Use Kafka when:** Patterns emerge across events and reference data, and the detection application has an explicit freshness and decision-latency budget.

**Choose differently when:** Use a synchronous decision service for an immediate allow/deny response; Kafka may feed its state but does not replace its serving deadline.

<details>
<summary>🖼️ Image prompt 38 — Enrich events before detecting a pattern</summary>

**Purpose:** Combine events with context to detect patterns, and separate detection freshness from immediate decision serving.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show separate order and customer-data cards with no combined view, while repeated suspicious activity reaches a review screen too late. Avoid naming real customers or asserting a real fraud incident. Right panel — Feed Order events and Customer reference data into a Stateful join, then a Detector producing Alerts and a Review queue. Show local state beneath the join and a separate optional Decision API for synchronous serving. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Disconnected evidence; Delayed review; Order events; Customer reference data; Stateful join; State store; Detector; Alerts; Review queue; Decision API

**Accuracy guardrails:** Kafka does not run the model or guarantee an immediate decision. Join keys, reference-data freshness, and state recovery are application concerns. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Combine events with context to detect patterns, and separate detection freshness from immediate decision serving.

**Alt text:** Disconnected order and customer data delay pattern detection; a stateful join feeds alerts while any synchronous decision API remains a separate serving component.

</details>

**🎯 Interview check:** What if the two input streams use different keys?  
**How to answer:** Repartition to a compatible join key or choose another lookup strategy. Account for network traffic, state size, and event-time alignment.

**⚠️ Common misunderstanding:** “Adding Kafka makes a fraud decision synchronous and immediate.” The pipeline has measurable processing and freshness delays.

**💡 Easy-to-miss detail:** Reference data can be stale too. Define versioning, update propagation, and what the detector does when enrichment is missing.

**⚖️ Trade-off:** Kafka supports continuous stateful detection and replay, but a low-latency request/response decision service may still be required at the user-facing boundary.

### 6.10 📡 Device telemetry, logs, and observability pipelines

Courier devices emit location and health readings. Backend services emit operational events. Kafka can buffer these streams and let alerting, storage, and analytics applications read independently.

Keying by device can preserve a device's append sequence, but devices may reconnect and send old readings. Keep event timestamps and sequence numbers, and define how to recognize duplicates and stale data.

Logs and location streams can contain sensitive information. Minimize payloads, separate access, and choose retention based on actual needs rather than keeping everything indefinitely.

**Use Kafka when:** High-volume telemetry has several destinations, needs a durable recovery buffer, or must be replayed for analysis.

**Choose differently when:** A direct collector or managed telemetry service can be simpler for one destination with no shared-stream requirement.

<details>
<summary>🖼️ Image prompt 39 — One telemetry stream, several destinations</summary>

**Purpose:** A shared telemetry stream supports independent destinations while readers handle late data and privacy boundaries.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a reconnecting courier device releasing a backlog of location readings while an alert service and a storage service each depend on direct delivery. Mark a late timestamp and a failed destination. Right panel — Use an authenticated Ingestion gateway feeding a telemetry stream. Let Alerting, Time-series storage, and Analytics read independently. Place a late-data check at processing and a restricted-access boundary around location data. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Device reconnects; Late reading; Destination unavailable; Ingestion gateway; telemetry; Alerting; Time-series storage; Analytics; Restricted access

**Accuracy guardrails:** Device event time can differ from arrival order. Kafka is not the time-series query engine, and location data requires appropriate access and retention. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** A shared telemetry stream supports independent destinations while readers handle late data and privacy boundaries.

**Alt text:** A reconnecting device and failed destination disrupt direct telemetry delivery; a shared stream lets alerting, storage, and analytics recover independently.

</details>

**🎯 Interview check:** Would you trust device arrival order as real-world time order?  
**How to answer:** No. Reconnects and clock skew can reorder observations. Use sequence numbers, event time, validation, and a defined late-data policy.

**⚠️ Common misunderstanding:** “Append order is the order events happened in the world.” It is the order they reached a partition.

**💡 Easy-to-miss detail:** Telemetry can dominate costs without helping the product. Apply sampling, aggregation, quotas, and privacy controls deliberately.

**⚖️ Trade-off:** Kafka fits shared, replayable high-volume ingestion. A managed telemetry service or direct collector may be simpler when only one destination is needed.

### 6.11 🗄️ Data lake and warehouse feeds

The data team wants order history in analytical storage without repeatedly querying the operational database. Sink applications or connectors consume events and write batches to a lake or warehouse.

Different destinations use different group progress and can run at different speeds. Design file sizes, partition layout, schema evolution, and retry behavior for the destination instead of treating every record as a tiny independent file.

A successful Kafka read is not proof that a warehouse load finished. The sink's checkpoint and destination write semantics determine recovery behavior.

**Use Kafka when:** Analytical destinations need continuous independent feeds without repeatedly querying the operational database.

**Choose differently when:** Use scheduled extracts when batch freshness is enough and the simpler source/destination workflow meets recovery needs.

<details>
<summary>🖼️ Image prompt 40 — Feed analytical stores independently</summary>

**Purpose:** Feed analytical systems independently, using destination-aware batches and recovery.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show several analytical jobs repeatedly scanning an operational order database, with a load gauge and a delayed warehouse report. Make this a workload example, not a benchmark claim. Right panel — Show a reliable event stream feeding independent Lake sink and Warehouse sink groups. Batch records into appropriately sized files or loads, with separate checkpoints and a shared schema-contract card. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Repeated source scans; Operational database; Delayed report; Event stream; Lake sink; Warehouse sink; Batch files; Load batch; Independent checkpoints; Schema contract

**Accuracy guardrails:** Connector guarantees vary by implementation and destination. Do not equate read completion with a durable warehouse load or recommend one file per record. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Feed analytical systems independently, using destination-aware batches and recovery.

**Alt text:** Repeated analytical scans burden an operational database; independent event sinks feed a lake and warehouse using destination-specific batches and checkpoints.

</details>

**🎯 Interview check:** What determines whether a sink duplicates data after a crash?  
**How to answer:** Its destination write operation, idempotency, transaction support, and checkpoint coordination. Inspect the specific connector’s guarantees.

**⚠️ Common misunderstanding:** “Using Kafka Connect guarantees exactly once in any database.” Guarantees depend on the connector, configuration, and destination.

**💡 Easy-to-miss detail:** Watch small-file and batch-size behavior. A pipeline can keep up with events yet create an expensive, slow analytical layout.

**⚖️ Trade-off:** Continuous feeds improve freshness and reduce repeated source scans. Scheduled extracts are often simpler when near-real-time data is unnecessary.

### 6.12 ⏪ Replay, backfills, migrations, and rebuilding state

The team fixes a bug in estimated preparation time and wants to rebuild the last few days of predictions. A new consumer group can reread retained events into a new output version while the live application continues.

Before replay, decide which effects are allowed. Recomputing an internal view is different from resending notifications or issuing refunds. Use isolated outputs, controlled rates, and a validation step before switching readers.

Historical events may use older schemas, and required reference data or objects may have expired. Replayability is a property of the whole processing path, not just Kafka's retained bytes.

**Use Kafka when:** Required history still exists and you can recompute into isolated outputs without repeating unsafe external effects.

**Choose differently when:** Use snapshots or archives when Kafka no longer contains the necessary history; do not reset a live group casually to rebuild a separate view.

<details>
<summary>🖼️ Image prompt 41 — Replay into a safe new output</summary>

**Purpose:** Recompute safely by isolating replay progress, outputs, load, and external effects.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a preparation-time calculation bug in View v1, with the live application still serving users and no safe way to redo history in place. Include a risky resend-notifications path marked as a warning. Right panel — Keep the live group writing View v1 while a rate-limited Replay group reads retained history into View v2. Put Validate before Switch reads and explicitly block external notifications during this recomputation. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Bug in View v1; Live users; Unsafe side effects; Retained history; Live group; Replay group; Rate limit; View v2; Validate; Switch reads; No notifications

**Accuracy guardrails:** Replay cannot recover deleted events or expired external objects. Output isolation, schema support, reference data, and side-effect policy remain necessary. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Recompute safely by isolating replay progress, outputs, load, and external effects.

**Alt text:** A faulty live view cannot safely be rebuilt in place; a separate replay group writes a new version, blocks external side effects, and validates it before switching reads.

</details>

**🎯 Interview check:** Why use a new group for a rebuild?  
**How to answer:** It isolates checkpoints and operational risk from the live consumer. Pair that with a separate output version and correctness checks.

**⚠️ Common misunderstanding:** “Resetting offsets is the entire replay plan.” Outputs, side effects, schemas, dependencies, and capacity also need a plan.

**💡 Easy-to-miss detail:** Replay traffic competes with live reads and writes. Set quotas or rate limits and validate business totals before switching views.

**⚖️ Trade-off:** Kafka can make recomputation practical, but long historical backfills may be cheaper or only possible from a lake/archive plus recent Kafka data.

### 6.13 🧾 Workflows and sagas — with explicit business state

An order may require restaurant acceptance, payment authorization, and courier assignment. If one step fails, the system may need to release a hold, cancel a dispatch request, or notify the customer.

Kafka can carry commands and outcome events between participants. It does not define the workflow's state machine, timeout rules, or compensation logic. Those belong in a saga coordinator, workflow engine, or carefully designed service choreography.

Every step needs an identity and safe retry behavior. A compensation is a new business action, not a distributed database rollback that erases the past.

**Use Kafka when:** A workflow already needs durable event exchange between participants and has explicit state, timeout, idempotency, and compensation rules.

**Choose differently when:** Use a workflow engine or orchestrator when that makes a complex long-running process easier to understand and operate; Kafka can still be its transport.

<details>
<summary>🖼️ Image prompt 42 — Events connect an explicit order workflow</summary>

**Purpose:** Use events to connect workflow steps, while explicit business state decides recovery and compensation.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show an order whose Restaurant step succeeded while Payment or Dispatch is unresolved, with a customer screen stuck on Pending. Mark the missing overall workflow state. Right panel — Put a durable Order workflow state card in charge of progress. Connect Restaurant, Payment, and Dispatch through command/outcome event paths, and show a timeout leading to a tracked Compensation action. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Partially completed order; Pending; Workflow state?; Order workflow; Restaurant; Payment; Dispatch; Commands; Outcomes; Timeout; Compensation

**Accuracy guardrails:** Kafka transports the messages; it does not define the state machine or roll back arbitrary external actions. Commands and completed outcomes must remain distinct. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Use events to connect workflow steps, while explicit business state decides recovery and compensation.

**Alt text:** A partially completed order lacks an overall recovery decision; durable workflow state tracks participant outcomes, timeouts, and compensation.

</details>

**🎯 Interview check:** Can Kafka transactions make the restaurant, payment, and dispatch steps one atomic transaction?  
**How to answer:** Not across arbitrary external systems. Use explicit workflow state, idempotent steps, and compensating actions where appropriate.

**⚠️ Common misunderstanding:** “Choreography means no one needs to track the overall order.” The business still needs a reliable way to know its current state and stalled steps.

**💡 Easy-to-miss detail:** A compensation can fail too. Track and retry it with ownership and an escalation path.

**⚖️ Trade-off:** Event choreography keeps services independent but can make flows hard to trace. A workflow engine or orchestrator may be clearer for complex, long-running processes.

### 6.14 📚 Audit trails and event sourcing — conditional uses

Support may need to understand how an order moved from pending to delivered. A retained event stream can contribute to that history. Event sourcing goes further: the application's authoritative state is reconstructed from its events.

Kafka can participate in either design, but ordinary retention, compaction, permissions, and operational deletion do not automatically create an immutable audit archive or a complete event store. Querying one order's history also needs an index or purpose-built serving layer.

If history is authoritative, define event completeness, ordering, schema evolution, snapshots, correction events, and recovery. Data retention and privacy requirements need an organization-specific policy; this article is not a compliance assessment.

**Use Kafka when:** You deliberately design the history, authority, indexing, access, and lifecycle policies; a retained stream is only one component of that design.

**Choose differently when:** Use a governed archive or suitable event store when its immutability, lookup, or history guarantees are the real requirement; ordinary Kafka settings alone do not establish them.

<details>
<summary>🖼️ Image prompt 43 — Operational stream and authoritative history need different policies</summary>

**Purpose:** Historical explanation and event-sourced authority require deliberate storage and governance beyond ordinary streaming.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a support agent asking why an order changed state while only the latest database row remains. Add a separate warning that an expiring operational stream is not a permanent archive. Right panel — Feed deliberate business events into a Support history index and a Governed archive. In a small optional inset, show Event-sourced state reconstructed from complete ordered history plus snapshots, labeled only if events are authoritative. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Why did this change?; Latest state only; Operational history expires; Business events; Support history index; Governed archive; Authoritative events?; Snapshot

**Accuracy guardrails:** Do not portray ordinary Kafka retention as permanent, tamper-proof, or automatically compliant. Event sourcing requires an explicit authoritative event model; privacy and deletion policy remain external requirements. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Historical explanation and event-sourced authority require deliberate storage and governance beyond ordinary streaming.

**Alt text:** Only current state or expiring history cannot explain an old order change; deliberate events feed a searchable history and governed archive with explicit authority and policy.

</details>

**🎯 Interview check:** Is every Kafka-based system event sourced?  
**How to answer:** No. Most keep a database as the source of truth and publish events about changes. Event sourcing makes the event history authoritative by design.

**⚠️ Common misunderstanding:** “Append-only implies legally immutable forever.” Storage configuration, access, deletion, and archival controls still matter.

**💡 Easy-to-miss detail:** Compaction may erase intermediate transitions. Do not apply it to a stream whose purpose requires every historical change.

**⚖️ Trade-off:** Kafka can supply transport and replay, but a dedicated event store, indexed audit database, or governed archive may better meet querying and retention requirements.

### 6.15 🌍 Cross-cluster mirroring and disaster recovery

MealRoute prepares for losing an entire region. A separate cluster receives mirrored events, and a recovery plan describes how applications restart there.

This is different from P1 having three replicas in one cluster. Cross-cluster mirroring usually has its own asynchronous lag, topic naming, configuration, and offset translation. A record's offset in the destination is not a universal identity that can be assumed equal to its source offset.

Define a recovery point objective—how much recent data may be unavailable—and a recovery time objective—how long service restoration may take. MirrorMaker 2 can replicate data and supporting metadata/checkpoints, but application failover and reconciliation still need a tested procedure. [Cross-cluster mirroring](https://kafka.apache.org/43/operations/geo-replication-cross-cluster-data-mirroring/).

**Use Kafka when:** Your recovery objectives justify another cluster and you can operate mirroring, writer ownership, checkpoint translation, and application recovery.

**Choose differently when:** Do not add a second cluster without a recovery requirement and tested operating plan; within-cluster replicas and cross-cluster recovery solve different scopes of failure.

<details>
<summary>🖼️ Image prompt 44 — A second cluster is a recovery system</summary>

**Purpose:** Regional resilience needs a second failure domain and a complete recovery procedure, not just extra local copies.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show one region containing all application-topic replicas, then an entire-region failure boundary that makes those copies unavailable together. Show the application unable to resume from that region. Right panel — Show separate Region A and Region B clusters linked by asynchronous MirrorMaker 2 with a lag clock. Under Region B place a compact recovery checklist: App restart, Offset translation, Writer ownership, Reconciliation. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; One region; Regional outage; Region A; Region B; Separate clusters; MirrorMaker 2; Async lag; App restart; Offset translation; Writer ownership; Reconciliation; RPO / RTO

**Accuracy guardrails:** Cross-cluster mirroring is not synchronous partition replication. Offsets need not match, and lag can create a recovery-point gap. Failover is not automatically instantaneous. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Regional resilience needs a second failure domain and a complete recovery procedure, not just extra local copies.

**Alt text:** A regional outage removes access to all locally placed replicas; a separate mirrored cluster supports a planned recovery with lag, checkpoint translation, and writer ownership.

</details>

**🎯 Interview check:** Does RF3 protect against losing the only region?  
**How to answer:** Not if all replicas are in that region. Regional recovery requires another failure domain and a complete plan for data, applications, and dependencies.

**⚠️ Common misunderstanding:** “Mirrored topic means instant failover with no loss.” Replication lag and recovery coordination still exist.

**💡 Easy-to-miss detail:** Prevent two regions from making conflicting authoritative decisions during failover. Define writer ownership and test failback as well as failover.

**⚖️ Trade-off:** A second cluster improves recovery options but increases cost and operational complexity. Match it to explicit business recovery objectives.

### 6.16 🚦 When not to choose Kafka as the main solution

Kafka earns its place when you need several of these together: durable streams, independent readers, replay, sustained event throughput, and per-key processing order. It is often excessive for a small application with one background job and no history reuse.

Use a database for authoritative state and queries. Use request/response communication when the caller needs an immediate decision. Consider a task queue when job scheduling, per-message visibility timeouts, priority, and simple worker delivery are the main requirements. Queue behavior varies by product; compare actual capabilities rather than assuming all brokers behave alike. [RabbitMQ queues](https://www.rabbitmq.com/docs/queues), [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).

Kafka can be part of a larger design that also needs these things. The mistake is expecting it to replace every specialized component.

<details>
<summary>🖼️ Image prompt 45 — Choose the tool from the requirement</summary>

**Purpose:** Choose Kafka for its stream capabilities, and use other components for decisions, queries, and specialized job handling.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw four large requirement cards arranged around a central Your workload card: Immediate decision, Query current state, Simple background jobs, Shared replayable events. Connect them respectively to Request/response, Database, Task queue, and Kafka candidates. Add a small overlapping-options note so the graphic is a guide rather than an absolute decision tree.

**Exact labels:** Your workload; Immediate decision; Request/response; Query current state; Database; Simple background jobs; Task queue; Shared replayable events; Kafka; Options can coexist

**Accuracy guardrails:** Do not claim Kafka cannot support jobs or that every workload needs only one tool. No unsupported vendor performance rankings. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Choose Kafka for its stream capabilities, and use other components for decisions, queries, and specialized job handling.

**Alt text:** A requirement-based guide maps immediate decisions, state queries, simple jobs, and replayable streams to suitable component types.

</details>

**🎯 Interview check:** How would you justify Kafka in an interview?  
**How to answer:** Start with requirements that need retained streams and independent progress, then explain the cost and the simpler alternatives you considered.

**⚠️ Common misunderstanding:** “High scale automatically means Kafka.” The access pattern, guarantees, and operating model matter as much as volume.

**💡 Easy-to-miss detail:** Team capacity is a design constraint. Include ownership, monitoring, upgrades, and recovery—not only broker price.

**⚖️ Trade-off:** Kafka adds valuable capabilities and a substantial operating surface. Prefer the least complex design that meets the actual guarantees.

**Six situations to picture before adding Kafka**

The point is not that Kafka can never appear in these systems. It is that the requirement below needs a different primary mechanism. Use Kafka only if a separate streaming requirement earns its place alongside that mechanism.

#### 6.16.1 One small background job does not need a streaming platform

A small cafe sends a daily preparation report to one manager. There is one producer, one job handler, low traffic, and no need for several applications to replay the history.

**Why Kafka may be unnecessary:** Broker operations, topic policies, group progress, and consumer recovery add responsibilities without solving a missing requirement here.

**What to use instead:** A scheduler plus a database-backed job table or suitable task queue can keep the job durable and retryable. Start there unless other readers, replay, or a larger shared event pipeline justify Kafka. A managed Kafka service can reduce broker work, but it does not remove application correctness responsibilities.

<details>
<summary>🖼️ Image prompt 46 — Do not build a streaming platform for one daily report</summary>

**Purpose:** A small durable job workflow can be enough when shared history and independent readers are unnecessary.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a small cafe’s one Daily report card surrounded by a large cluster, topic, checkpoint, and monitoring setup. Mark Operational overhead without suggesting Kafka is technically incapable of the job. Right panel — Show a Scheduler creating a durable job for one Worker, which sends the report and records completion. Include a small retry loop and completion marker. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Daily report; One reader; Operational overhead; Scheduler; Durable job; Worker; Retry; Completion

**Accuracy guardrails:** The simpler path must still persist intent and handle retries safely. This is a fit decision, not a universal traffic threshold or claim that Kafka cannot process jobs. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** A small durable job workflow can be enough when shared history and independent readers are unnecessary.

**Alt text:** One daily report has no demonstrated need for a Kafka cluster; a durable scheduled job and worker provide a simpler path.

</details>

**🎯 Interview check:** What requirement would make you reconsider Kafka?  
**How to answer:** Several independent consumers, useful historical replay, or integration into an existing shared event platform—not a vague desire to be scalable.

**⚠️ Common misunderstanding:** “Every asynchronous operation needs Kafka.” Asynchrony and event-streaming requirements are different.

**💡 Easy-to-miss detail:** Ask who will operate the system. A small feature can inherit a large maintenance burden from an unnecessary component.

**⚖️ Trade-off:** A simple queue gives up some stream reuse and replay capabilities, but may meet this job’s needs with less operating work.

#### 6.16.2 A capacity decision needs an authoritative answer now

Two customers request the last premium delivery slot. The API must decide whether each reservation succeeded before promising the slot.

**Why Kafka alone is insufficient:** Appending two requests records two attempts; it does not atomically allocate the last slot. Waiting for an eventual event is also not the same as an immediate successful reservation.

**What to use instead:** An authoritative reservation service makes an atomic capacity decision in its state store and returns the result. It can publish the resulting fact reliably afterward. A deliberate waiting-room design can use Kafka for intake, as in section 6.3, but must still distinguish “request queued” from “slot reserved.”

<details>
<summary>🖼️ Image prompt 47 — A queued request is not a reserved slot</summary>

**Purpose:** Use authoritative state to allocate capacity; publish the outcome after the decision is durable.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show two customer request cards entering an event log and a premature Reserved response next to both, highlighted as an incorrect promise. Put a Last slot question card beside the log. Right panel — Show a Reservation service consulting an authoritative Capacity store in one atomic decision path. Return Reserved to one request and Unavailable to the other, then publish the completed outcome through a reliable handoff. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Two requests; Last slot?; Queued; Premature promise; Reservation service; Capacity store; Atomic decision; Reserved; Unavailable; Outcome event

**Accuracy guardrails:** Kafka append is not a reservation. Do not imply the event log itself enforces capacity or that the resulting database change and publication are atomic without a reliable handoff. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Use authoritative state to allocate capacity; publish the outcome after the decision is durable.

**Alt text:** Two queued attempts do not reserve a last slot; an atomic reservation decision grants one request and rejects the other before emitting outcomes.

</details>

**🎯 Interview check:** Can a single partition replace the capacity database?  
**How to answer:** It can serialize intake, but the application still needs authoritative state, identity, expiry, and recovery for the reservation decision.

**⚠️ Common misunderstanding:** “The message was acknowledged, so the slot is mine.” The acknowledgement may only confirm that an attempt was stored.

**💡 Easy-to-miss detail:** Keep response vocabulary precise: queued, held, confirmed, and unavailable are different business states.

**⚖️ Trade-off:** An immediate authoritative path meets strict decision requirements. An asynchronous intake path can smooth load, but changes the user-facing promise.

#### 6.16.3 Looking up one order is a database or index problem

Asha opens the app and asks, “What is the current status of order-8472?” The API needs a quick lookup by order ID, not a scan of a partition's retained history on every request.

**Why Kafka is not the serving database here:** A record key is useful for routing and compaction, but it does not automatically create an arbitrary key-query API on the broker. Compaction does not turn the topic into an immediately updated searchable table.

**What to use instead:** Serve a database, cache, or indexed read model. Kafka can keep that model updated and help rebuild it. For a decision that cannot tolerate stale state, consult the authoritative service rather than assuming the projection is current.

<details>
<summary>🖼️ Image prompt 48 — Serve the current order from a query model</summary>

**Purpose:** Use an indexed serving store for current-state queries; let the stream maintain it when useful.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show Asha’s phone asking for order-8472 and a backend trying to scan a long log for the latest state. Add a slow-search clock and several historical versions. Right panel — Show the phone calling a Status API that performs a keyed lookup in a Current-status store. In the background, a Kafka consumer updates the store with version checks and a visible freshness boundary. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Status of order-8472?; Scan history; Slow lookup; Status API; Current-status store; Keyed lookup; Background updates; Freshness boundary

**Accuracy guardrails:** Kafka keys do not supply a general broker-side lookup API. A derived store can be stale, and compaction is not an instantaneous database update. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Use an indexed serving store for current-state queries; let the stream maintain it when useful.

**Alt text:** Scanning event history is replaced by a direct status lookup in a store that can be maintained by a background consumer.

</details>

**🎯 Interview check:** Why have a database if events already exist in Kafka?  
**How to answer:** The database serves the required query efficiently and may hold authoritative state. Kafka provides the history or change stream around it.

**⚠️ Common misunderstanding:** “A compacted topic is a drop-in key-value database.” It has different read, update, cleanup, and serving semantics.

**💡 Easy-to-miss detail:** Define how the view catches up after an outage and what freshness the API exposes to the user.

**⚖️ Trade-off:** Derived stores improve query performance but add synchronization and rebuild responsibilities. Direct source queries may be enough for smaller systems.

#### 6.16.4 Timers, priorities, and long-running jobs need their own semantics

A notification should run tomorrow at 9 a.m., a cancellation job should take priority now, and a media job may take several minutes with progress reporting.

**Why Kafka alone is awkward:** An ordinary ordered log does not automatically provide arbitrary per-record scheduling, priority overtaking, job leases, or workflow progress. Holding a partition while waiting can delay unrelated records; moving work elsewhere needs an explicit policy.

**What to use instead:** Evaluate a scheduler, task queue, or workflow system whose actual features fit the requirement. Kafka may still carry job-created and job-completed events. Do not assume every queue supports every feature: delayed delivery, priority, visibility timeouts, and workflow state vary by product. [RabbitMQ queue capabilities](https://www.rabbitmq.com/docs/queues), [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).

<details>
<summary>🖼️ Image prompt 49 — A log is not an automatic scheduler</summary>

**Purpose:** Choose explicit scheduling and job-management components when those are the primary requirements.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a Tomorrow 09:00 job at the head of one partition and an Urgent job waiting behind it. Add a long-running job with no progress state to make the required capabilities visible. Right panel — Show a Scheduler holding the future timer, a suitable Task queue assigning ready work, and a Worker or workflow system recording progress. Place optional job-created/completed Kafka events on a separate lower path. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Tomorrow 09:00; Urgent job; Waiting behind; Long-running job; Scheduler; Ready jobs; Task queue; Worker; Progress; Optional events

**Accuracy guardrails:** This is a conditional capability comparison, not a claim that every task queue supports priority or delays. Kafka can participate through additional scheduling/application components. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Choose explicit scheduling and job-management components when those are the primary requirements.

**Alt text:** A delayed job blocks an ordinary processing lane, while a scheduler and suitable job system manage time, readiness, and progress separately.

</details>

**🎯 Interview check:** Why not sleep in the consumer until the scheduled time?  
**How to answer:** That can hold a partition’s work and interfere with progress and group timing. Persist scheduling state and release ready work through a deliberate mechanism.

**⚠️ Common misunderstanding:** “A topic named retry-5m waits five minutes automatically.” The name does not implement a scheduler.

**💡 Easy-to-miss detail:** Long jobs need completion ownership and safe retry behavior even outside Kafka. Check what happens when a worker dies halfway through.

**⚖️ Trade-off:** A job system adds another component if you already operate Kafka, but can remove substantial custom scheduling and workflow logic.

#### 6.16.5 Large photos and videos belong in object storage

MealRoute stores delivery photos that may be large and may need to be downloaded several times by support or processing jobs.

**Why Kafka is usually the wrong primary file store:** Replicating and replaying large blobs can multiply network, memory, and storage pressure. Raising one message-size setting does not remove limits and costs elsewhere in the producer, replicas, and readers.

**What to use instead:** Save the content in object storage and publish a small event containing a stable object ID, checksum, and processing version. Authorize each retrieval appropriately. Keep the object available for the planned processing and replay window; a durable event pointing to a deleted file is not recoverable work.

<details>
<summary>🖼️ Image prompt 50 — Store the file once and stream its reference</summary>

**Purpose:** Use Kafka to describe file work, while object storage holds the durable payload.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show a large photo block squeezed through producer, broker replicas, and consumer buffers, with amber memory/network pressure marks. Right panel — Send the photo to Object storage. Put only a small Object ID + checksum card in Kafka, then let an authorized worker fetch the file when processing. Add a Retain for replay note on storage. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Large photo; Buffer pressure; Replication traffic; Object storage; Object ID + checksum; Kafka event; Authorized fetch; Retain for replay

**Accuracy guardrails:** Do not claim Kafka has one universal maximum message size or cannot ever carry binary payloads. The recommendation concerns large-file workload fit and total path cost. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Use Kafka to describe file work, while object storage holds the durable payload.

**Alt text:** A large photo burdens the event path; object storage keeps the file while a small Kafka event supplies an authorized processing reference.

</details>

**🎯 Interview check:** Why does a reference need a retention plan?  
**How to answer:** Replaying the event is useless if the referenced object or required access metadata has expired. Coordinate both lifecycles.

**⚠️ Common misunderstanding:** “Increasing the producer limit fixes large records everywhere.” Broker, replica, consumer, memory, and network behavior also matter.

**💡 Easy-to-miss detail:** Use a stable object identifier rather than only a short-lived signed download URL.

**⚖️ Trade-off:** References keep event traffic small, but add an object-store dependency and require coordinated permissions and lifetime.

#### 6.16.6 A permanent audit archive needs more than ordinary topic retention

Support or another internal team requires a complete historical explanation of order changes, searchable long after the operational stream's usual retention window. Some data also has explicit deletion or access requirements.

**Why ordinary Kafka topics are not enough by themselves:** Retention can remove records, compaction can remove earlier values, and broker permissions alone do not establish an immutable archive or a complete organization-wide deletion process.

**What to use instead:** Design an archive and query layer around the actual history, access, and data-lifecycle requirements. Kafka can feed that system, but do not claim that using Kafka automatically proves permanent retention, tamper resistance, or compliance. Those properties require separate assessment and controls.

<details>
<summary>🖼️ Image prompt 51 — Operational history is not automatically a permanent archive</summary>

**Purpose:** Treat long-term history and governance as explicit system requirements, even if Kafka transports the events.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create two clearly separated notebook panels labeled “Problem” and “What we change,” with a small numbered reading arrow between them. Use the same objects and camera angle in both so the change is obvious. Show the human-visible consequence with a tiny screen, ticket, or status card rather than only abstract server boxes. Left panel — Show an operational topic with a moving retention window and older order cards disappearing. A support search for an old transition returns History unavailable. Include a compacted-key card with earlier versions faded. Right panel — Show the event pipeline feeding a Governed archive and a Search index. Put explicit Retention, Access, Integrity, and Deletion policy cards around the archive, without certification badges. Use at most six major objects per panel; split any complex detail into a small inset. Make the changed part visually prominent without clutter.

**Exact labels:** Problem; What we change; Operational topic; Retention window; Old versions removed; History unavailable; Governed archive; Search index; Retention; Access; Integrity; Deletion policy

**Accuracy guardrails:** Do not promise legal compliance, automatic immutability, or infinite history. This is a technical separation of responsibilities; requirements and controls must be evaluated for the actual environment. Solid arrows show data movement; dashed arrows show metadata, coordination, or checkpoints. Include a small legend if both are used. Do not invent extra guarantees or put paragraphs inside the illustration.

**Caption:** Treat long-term history and governance as explicit system requirements, even if Kafka transports the events.

**Alt text:** An expiring or compacted operational log cannot answer every historical query; an archive and index need deliberate lifecycle and access controls.

</details>

**🎯 Interview check:** Why is append-only not the same as permanently immutable?  
**How to answer:** Append behavior does not prevent configured cleanup or all administrative changes, and it does not establish archival governance.

**⚠️ Common misunderstanding:** “If we use Kafka, every old event will always be available.” Availability depends on storage and cleanup policies plus the surrounding architecture.

**💡 Easy-to-miss detail:** Consider derived stores and archives when defining deletion and access rules; changing the Kafka topic alone does not update every copy.

**⚖️ Trade-off:** An archive and index add cost, but make long-term retention and querying deliberate instead of accidental.

<a id="7-reliability"></a>

---

## 7. 🔧 Reliability and data design: make the happy path survive failure

The message journey gives us a skeleton. These choices determine whether it behaves correctly when events repeat, schemas change, workers move, or dependencies stop responding.

### 7.1 Delivery guarantees, producer idempotence, and transactions

Start by naming the boundary. Are we discussing append attempts, records read by an application, Kafka output records, or an external business effect? “Exactly once” without that boundary is incomplete.

| Approach | Typical checkpoint/effect relationship | Failure behavior |
|---|---|---|
| At-most-once processing | Checkpoint before the effect, without a compensating recovery mechanism | Some work can be skipped after a crash |
| At-least-once processing | Durable effect before checkpoint, with retries | Work can repeat; make the effect idempotent |
| Kafka transactional processing | Kafka outputs and consumed offsets commit atomically | Committed Kafka results can avoid duplication under the supported model |

**Producer idempotence** protects against duplicate appends caused by supported producer retry behavior. Kafka uses producer identity and sequence tracking. In the current Java client, idempotence is enabled by default when configurations do not conflict. The required combination includes `acks=all`, retries greater than zero, and `max.in.flight.requests.per.connection` no greater than 5. Conflicting settings can disable implicit idempotence; explicitly enabling it with incompatible settings causes a configuration error. It does not deduplicate two fresh application sends with the same business payload, nor does it make an external side effect exactly once.

Retry settings also affect ordering. With idempotence disabled and multiple requests in flight, a later batch can succeed before an earlier failed batch is retried. Use a compatible idempotent configuration when relying on the producer's retry-order protection; it still cannot fix business events published in the wrong order. [Producer configuration](https://kafka.apache.org/43/configuration/producer-configs/).

**Business idempotence** means repeating an operation has the intended single logical effect. For the restaurant view, use the event-ID marker and update in the same database transaction. For an external API, use a stable idempotency key supported by that destination and understand its expiry and scope.

**Kafka transactions** can atomically publish records to Kafka partitions and commit consumed offsets. A typical read-process-write application begins a transaction, produces output, adds its consumed next offsets using group metadata, then commits. On failure it aborts; downstream readers use `read_committed` to avoid treating aborted output as committed work. Transactional identities and fencing prevent obsolete producers from continuing a conflicting transaction. [Transaction protocol](https://kafka.apache.org/43/operations/transaction-protocol/).

A database write, an email, or an arbitrary HTTP call is not automatically inside that Kafka transaction. For our database read model, the unique-event transaction plus post-effect checkpoint remains the relevant protection. Even a strong Kafka pipeline cannot promise that an external email provider sends exactly one email without cooperation from that provider.

<details>
<summary>🖼️ Image prompt 52 — Three different duplicate protections</summary>

**Purpose:** Retry deduplication, business idempotence, and Kafka transactions protect different boundaries.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use three side-by-side panels. First shows producer retry arrows converging on one Kafka append, labeled Producer idempotence. Second shows repeated evt-8472-1 reaching one database transaction with unique marker plus effect. Third shows a Kafka transaction boundary around Output records and Input offsets, with an external Email API clearly outside. Use green checks only inside each stated boundary.

**Exact labels:** Producer idempotence; Retry; One append; Business idempotence; evt-8472-1; Unique marker + effect; Kafka transaction; Output records; Input offsets; Email API outside

**Accuracy guardrails:** Do not show producer idempotence deduplicating every business resend. Do not include external email or database effects inside a Kafka transaction boundary. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Retry deduplication, business idempotence, and Kafka transactions protect different boundaries.

**Alt text:** Three panels distinguish duplicate-append protection, replay-safe database effects, and atomic Kafka outputs with offsets.

</details>

**🎯 Interview check:** An interviewer says Kafka guarantees exactly once. What do you clarify?  
**How to answer:** Ask “exactly once where?” Explain the transaction boundary, downstream isolation, and any external effect that requires its own coordination.

**⚠️ Common misunderstanding:** “An idempotent producer means no duplicate order can exist.” Customer retries, relay resends, and consumer side effects remain separate duplicate sources.

**💡 Easy-to-miss detail:** An idempotency key with a short expiry may not protect a week-old replay. Align the destination’s deduplication window with the replay and retry policy.

**⚖️ Trade-off:** Transactions give stronger Kafka-to-Kafka atomicity but add coordination and recovery concerns. For external database effects, a simpler idempotent consumer is often the clearer boundary.

### 7.2 Safe consumers, rebalances, and checkpoint discipline

A consumer can lose its partition assignment when it crashes, stops polling for too long, or the group changes. The next owner resumes using committed progress. An old worker's external call may still be running after ownership moves; reassignment does not cancel arbitrary work in another system.

For a simple synchronous handler, the shape is straightforward:

```text
Pseudocode — not a complete client program:
Disable automatic offset commits.
Subscribe using the application's group ID.
Poll a batch.
For every returned record, complete its replay-safe database effect.
If the whole batch succeeded and ownership is valid:
    commit the returned next-offset metadata for each partition.
If processing failed:
    do not advance past the failed work; retry or recover deliberately.
```

In current Java, `consumer.commitSync(records.nextOffsets())` expresses the checkpoint step **only after all records in that returned batch are safely handled**. This line alone is not a production consumer. You still need shutdown handling, rebalance callbacks, permanent-error policy, and commit-error handling. [ConsumerRecords API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/consumer/ConsumerRecords.html).

For asynchronous handlers, maintain completed work per partition and commit only a safe prefix. Pause fetching from a partition when its in-flight work exceeds a bound, while maintaining the required consumer polling/coordination behavior. The ordinary Java consumer is not generally thread-safe; do not casually share it among worker threads.

Automatic commits are particularly dangerous when polled records are handed to background threads and not finished before the client advances checkpoints. Manual commits make the intended boundary explicit, but only if you choose the right positions.

On revocation, finish or stop work safely and checkpoint only what is valid for the current ownership. On lost ownership, do not assume you can commit as the former owner. Static membership and cooperative/newer protocols can reduce some disruption, but they do not remove these correctness duties. [Consumer rebalance listener](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/consumer/ConsumerRebalanceListener.html).

<details>
<summary>🖼️ Image prompt 53 — Commit only the completed prefix</summary>

**Purpose:** Out-of-order completion must not advance a checkpoint past unfinished work.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw P1 records 42, 43, 44 as three tasks. Mark 42 running, 43 complete, and 44 queued. Place a committed bookmark at 42 and an amber blocked arrow to commit 44. In a second panel show 42 and 43 complete, allowing next-position 44. Add a small assignment handoff from C1 to C2 with a warning around old in-flight work.

**Exact labels:** P1; 42 running; 43 complete; 44 queued; Committed: 42; Do not commit 44 yet; Safe next: 44; C1; C2; Ownership changes

**Accuracy guardrails:** The second panel allows 44 only when all relevant earlier work is safe. Reassignment must not be depicted as cancelling an external side effect automatically. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Out-of-order completion must not advance a checkpoint past unfinished work.

**Alt text:** A consumer waits for record 42 before checkpointing past completed record 43, and handles old work carefully during reassignment.

</details>

**🎯 Interview check:** Why not commit the largest offset any worker has finished?  
**How to answer:** An earlier unfinished record in the same partition would be skipped after restart. Commit the safe completed prefix, not the maximum observed completion.

**⚠️ Common misunderstanding:** “Turning off auto-commit solves correctness.” The application can still commit early, race ownership changes, or mishandle repeated effects.

**💡 Easy-to-miss detail:** Tune poll sizes and processing bounds together. One huge batch can exceed the processing interval and trigger avoidable reassignment.

**⚖️ Trade-off:** Synchronous processing is easier to reason about. Asynchronous parallelism may increase throughput, but needs bounded queues, ordered checkpoint tracking, and safe revocation handling.

### 7.3 Retries, poison events, and dead-letter handling

A timeout from the notification provider is often temporary. An event with an impossible schema may fail on every attempt. Treating both as “retry forever” can freeze useful work or overload a recovering service.

Use bounded retries with backoff and jitter for transient failures. Observe a delivery deadline or business expiry. A retry after an order is cancelled may no longer be a valid action.

| Pattern | Benefit | Cost |
|---|---|---|
| Retry while holding the partition's work | Preserves its processing sequence | One bad record can delay unrelated keys on that partition |
| Move work to a retry topic | Lets later original records progress | Later records can overtake the failed one; ordering needs a policy |
| Dead-letter topic after a deliberate limit | Isolates an unresolved event for investigation | Requires ownership, alerts, and safe re-drive |

Kafka does not automatically provide a universal delayed-message scheduler or dead-letter queue policy. Applications and frameworks implement these patterns. A retry topic needs a mechanism that enforces the delay; its name alone does not do that. [Spring Kafka non-blocking retries](https://docs.spring.io/spring-kafka/reference/retrytopic.html).

Moving a record to a retry or dead-letter topic has the same publication/checkpoint gap we already studied. Publish then crash before checkpointing and the transfer can repeat; checkpoint then fail to publish and the record can be skipped. A Kafka transaction can combine the Kafka output and source offsets when appropriate, or you must make the transfer retry-safe another way.

Store the event ID, original topic/partition/offset, attempt count, error category, and timestamps. Avoid leaking secrets or unnecessary payload data. Assign an owner, monitor growth, fix the cause, and re-drive through a controlled path. A dead-letter topic is unfinished work with a name.

<details>
<summary>🖼️ Image prompt 54 — Choose a retry policy deliberately</summary>

**Purpose:** Retry strategy trades ordering, progress, and recovery effort; dead-letter records still need an owner.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Start with a Failed record card and branch into Transient failure and Invalid or exhausted. Under transient show Backoff with two options: Hold partition and Retry topic + delay handler. Under invalid/exhausted show Dead-letter topic leading to Owner, Fix, and Controlled re-drive. Draw a warning on the original-versus-retry paths showing possible overtaking.

**Exact labels:** Failed record; Transient; Backoff; Hold partition; Retry topic; Delay handler; Invalid or exhausted; Dead-letter topic; Owner; Fix; Re-drive; Ordering may change

**Accuracy guardrails:** Retry topics do not automatically delay records. Dead-letter transfer and source checkpoint are separate unless coordinated. Avoid implying every failure should be skipped. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Retry strategy trades ordering, progress, and recovery effort; dead-letter records still need an owner.

**Alt text:** Failures are classified into bounded retries or dead-letter investigation, with a warning that retry topics can change processing order.

</details>

**🎯 Interview check:** How would you retry a failed event without losing it?  
**How to answer:** Preserve its identity and coordinate transfer with source progress. Explain whether you hold the partition, use transactional Kafka transfer, or tolerate duplicates with deduplication.

**⚠️ Common misunderstanding:** “A DLQ solves the failure.” It only stores unresolved work until someone diagnoses and recovers it.

**💡 Easy-to-miss detail:** Moving one event aside may invalidate later events for the same order. Define whether to block that key, skip it visibly, or reconcile later.

**⚖️ Trade-off:** Blocking preserves sequence but hurts availability for the lane. Non-blocking retries improve progress but need explicit ordering and replay semantics.

### 7.4 Deletion retention, compaction, and tiered storage

Deletion retention removes eligible old log segments based on configured time and/or size rules. The size budget is per partition. In the Kafka 4.3 topic defaults, `retention.ms` is seven days, `retention.bytes=-1` leaves the size limit unbounded, and `segment.bytes` is 1 GiB. That segment size is **not** a 1 GiB topic-history limit. Verify inherited and overridden settings in the actual deployment. [Topic configuration](https://kafka.apache.org/43/configuration/topic-configs/).

**Compaction** eventually removes superseded values for a key. For a courier-status stream, newer values can replace older ones during cleanup, allowing a consumer to rebuild current state from the retained keyed history. Multiple versions can coexist until cleaning occurs; compaction is not an immediate “one row per key” database update.

A null value for a key is a **tombstone**, indicating deletion in a compacted log. The string `"null"` is not the same thing. Tombstones are retained for a limited interval, so a very stale stateful reader may miss the deletion and need a full rebuild. Remaining records keep their offsets; cleanup does not renumber them. [Log compaction](https://docs.confluent.io/kafka/design/log_compaction.html).

A topic can combine deletion and compaction, which means old keys can still disappear under deletion policy. Choose it only if that matches the reconstruction model.

**Tiered storage** moves eligible log segments to remote storage under a configured implementation. It can change local disk needs and historical-read cost, but does not provide infinite free history. Kafka needs an appropriate remote storage manager and configuration; this is not simply “turn on unlimited storage.” [Tiered storage](https://kafka.apache.org/43/operations/tiered-storage/).

<details>
<summary>🖼️ Image prompt 55 — Three storage policies, three different jobs</summary>

**Purpose:** Deletion bounds history, compaction preserves keyed state, and tiering changes storage placement.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use three columns. Deletion retention shows old segment blocks leaving a moving window. Compaction shows repeated courier-9 values with older versions faded, one latest value, and a distinct null tombstone example for courier-10. Tiered storage shows older segments moving from local disk to remote storage while remaining under policy. Use minimal record text.

**Exact labels:** Deletion retention; Old segments; Compaction; courier-9 v1; courier-9 v2; courier-10: null; Tombstone; Tiered storage; Local disk; Remote storage; Policy still applies

**Accuracy guardrails:** Do not show compaction as immediate or as retaining all changes. Do not renumber remaining offsets. Tiering does not remove retention, implementation, or cost constraints. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Deletion bounds history, compaction preserves keyed state, and tiering changes storage placement.

**Alt text:** Three panels distinguish expired segments, compacted key versions and tombstones, and movement of older logs to remote storage.

</details>

**🎯 Interview check:** Can you reconstruct every status change from a compacted topic?  
**How to answer:** Not reliably: old values may have been removed. Use a history-preserving stream or archive when every transition matters.

**⚠️ Common misunderstanding:** “Compaction runs immediately and keeps exactly one record per key.” Cleaning is asynchronous, so multiple versions can remain.

**💡 Easy-to-miss detail:** Tombstone retention is part of recovery design. Test readers that have been offline longer than the deletion-marker window.

**⚖️ Trade-off:** Longer history supports recovery but costs storage and increases replay/privacy obligations. Compaction saves state history differently and cannot substitute for an audit trail.

### 7.5 Schemas and event evolution: protect independent deployments

A producer adds `delivery_instructions`; an older notification consumer is still running. Whether this is safe depends on the format and compatibility rules, not whether the new field looks harmless.

A schema registry can store contracts and enforce configured compatibility checks. It is an ecosystem component, not an automatic property of every Kafka topic. Avro, Protobuf, and JSON Schema have different evolution rules.

**Backward compatibility** means a newer reader can handle older data. **Forward compatibility** means an older reader can handle newer data. Full compatibility combines both directions. A transitive policy checks against a wider history of schema versions, which matters for long replays. Field defaults, optionality, and deletion rules depend on the format. [Schema evolution](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html).

Serialization compatibility also does not guarantee semantic compatibility. Renaming “accepted” to mean “paid” can break readers even if the schema validator accepts the bytes. Document meaning, ownership, and sample events as well as field types.

<details>
<summary>🖼️ Image prompt 56 — Old and new readers must agree on the event contract</summary>

**Purpose:** Schema evolution must protect both deployment order and historical replay.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw Old data and New data cards on the left, Old reader and New reader on the right. Use labeled arrows for backward compatibility from old data to new reader and forward compatibility from new data to old reader. Place Schema registry + policy above them, and a small Meaning check note below.

**Exact labels:** Old data; New data; Old reader; New reader; Backward; Forward; Schema registry; Compatibility policy; Meaning matters

**Accuracy guardrails:** Arrow directions must match the definitions. Do not imply one schema format or default compatibility policy applies to every deployment. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Schema evolution must protect both deployment order and historical replay.

**Alt text:** Backward and forward compatibility are shown as different reader-data relationships governed by an explicit schema policy.

</details>

**🎯 Interview check:** Why might a schema change pass a check and still break the product?  
**How to answer:** The field’s meaning or business assumptions may have changed. Validate semantic contracts and real consumers, not just structural compatibility.

**⚠️ Common misunderstanding:** “Backward means old consumers read new events.” That describes forward compatibility; backward concerns new readers handling older data.

**💡 Easy-to-miss detail:** Test a new consumer against the oldest history it must replay. Adjacent-version checks alone may miss a long-range incompatibility.

**⚖️ Trade-off:** Strict contracts reduce accidental breakage but require coordinated evolution. Unstructured payloads move that coordination into runtime failures.

### 7.6 Kafka Connect: move data without rewriting every adapter

Kafka Connect is a framework for source and sink integrations. A source connector brings external data into Kafka; a sink connector moves Kafka data to another system. Workers run connector tasks and manage framework-level coordination and progress.

This saves repetitive adapter plumbing, but a connector still has a concrete implementation, supported configuration, scaling model, and destination semantics. Some source workloads cannot be parallelized beyond the source's own partitioning or log model.

Plan connector upgrades, permissions, dead-letter/error behavior, source snapshots, destination idempotency, and internal topic durability. A green connector process does not prove records are reaching their final destination correctly. [Kafka Connect overview](https://kafka.apache.org/43/kafka-connect/overview/).

<details>
<summary>🖼️ Image prompt 57 — Connect supplies the integration framework</summary>

**Purpose:** Connect standardizes integration work while each connector retains its source and destination constraints.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Three main regions: External source, Connect workers containing two Source tasks and one Sink task, and External destination. Place Kafka topics between source-task output and sink-task input. Under the workers show Configuration, Status, and Progress as a small internal-state band.

**Exact labels:** External source; Connect workers; Source tasks; Kafka topics; Sink task; External destination; Configuration; Status; Progress

**Accuracy guardrails:** Do not imply tasks can parallelize any source arbitrarily or that every sink provides the same delivery semantics. Keep application topics separate from internal framework state. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Connect standardizes integration work while each connector retains its source and destination constraints.

**Alt text:** Source tasks publish to Kafka and a sink task writes onward, supported by Connect worker configuration and progress state.

</details>

**🎯 Interview check:** When would you use Connect instead of a custom consumer?  
**How to answer:** Use a suitable maintained connector for standard data movement. Write application code when you need business decisions or behavior the connector does not support.

**⚠️ Common misunderstanding:** “Connect eliminates operational responsibility.” Connectors, tasks, internal state, and destinations still fail and need owners.

**💡 Easy-to-miss detail:** Task count is a requested maximum, not a promise that a source can use that many parallel tasks. Check the connector’s actual partitioning model.

**⚖️ Trade-off:** Connect reduces custom code but adds a framework and connector lifecycle. A small explicit adapter can be reasonable for a narrow integration.

### 7.7 Kafka Streams, state, joins, and time

Kafka Streams is a client library for building processing applications around Kafka. Brokers store and serve data; the Streams application runs filters, joins, aggregations, and other business logic.

A stateless filter can decide from one record. A five-minute count or join needs **state**. Streams can maintain local state stores and backing changelog topics so tasks can restore state after failure. Restoration takes time and consumes resources; standby state can reduce some recovery work at an additional cost. [Streams architecture](https://kafka.apache.org/43/streams/architecture/).

For a join, inputs need compatible keys and partitioning where required by that operation. A repartition topic changes how records are grouped for later processing. It adds writes, reads, and storage; it is not a free label change.

Time also becomes part of correctness. Tumbling windows divide time into non-overlapping intervals; hopping windows overlap; session windows group activity separated by inactivity gaps. Decide how late events are accepted, how long state remains, and when results are considered final enough for a downstream action. Exact behavior depends on the operator. [Streams core concepts](https://kafka.apache.org/43/streams/core-concepts/), [Streams DSL](https://kafka.apache.org/43/streams/developer-guide/dsl-api/).

For example, restaurant demand is keyed by restaurant, while the original order stream is keyed by order. Repartition before the aggregation if needed, then write results to a separate topic. Do not change the original stream's key merely to satisfy every downstream query.

<details>
<summary>🖼️ Image prompt 58 — A stateful processor has its own recovery path</summary>

**Purpose:** Stateful streaming needs a grouping key, time policy, and a recoverable state store.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Arrange Input topic, Repartition by restaurant, Stateful windowed processor, and Aggregate topic horizontally. Beneath the processor put Local state and a Changelog topic with recovery arrows. Add a small separate timeline inset showing event time and a late event within an allowed window.

**Exact labels:** Input topic; Repartition by restaurant; Windowed processor; Aggregate topic; Local state; Changelog; Restore; Event time; Late event

**Accuracy guardrails:** Stateful computation belongs to the application, not the broker. Repartitioning adds real data movement. Do not promise instant restoration or automatic external exactly-once effects. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Stateful streaming needs a grouping key, time policy, and a recoverable state store.

**Alt text:** A processor repartitions orders by restaurant, maintains window state, and can restore that state from a changelog.

</details>

**🎯 Interview check:** What is missing from “consume events and count them”?  
**How to answer:** The grouping key, window/time definition, duplicate policy, state storage, late-event handling, and recovery behavior.

**⚠️ Common misunderstanding:** “State stays safe because the process has an in-memory map.” Recovery needs durable backing state or a replay strategy.

**💡 Easy-to-miss detail:** State restoration can dominate recovery time. Size changelogs, local storage, standby capacity, and replay bandwidth against the service objective.

**⚖️ Trade-off:** Streams provides useful Kafka-native stateful processing. Simpler consumers suit simple handlers; other engines may fit broader state, connector, or operational requirements.

<a id="8-production-design"></a>

---

## 8. 📐 Production design: capacity, failures, and operating responsibility

A correct event flow can still miss its customer promise if it is undersized or unobservable. Turn “Kafka is fast” into explicit measurements and recovery targets.

### 8.1 Performance, batching, and large records

Kafka's log design benefits from sequential appends, batching, and efficient transfer of data. The operating system's page cache can serve recent reads without repeated storage access. Log segments and indexes organize the stored data; a topic is not one endlessly growing file. Exact I/O paths depend on features such as encryption, so avoid universal claims that all traffic uses zero-copy. [Log implementation](https://kafka.apache.org/43/implementation/log/), [Record-batch format](https://kafka.apache.org/43/implementation/message-format/).

Batching exchanges some waiting and memory for fewer requests. Compression exchanges CPU for fewer bytes. A low-latency interactive event and a bulk telemetry feed may need different settings. Measure end-to-end latency, not only broker request time.

Here are the controls worth understanding before tuning. These are explanations, not a universal production configuration:

| Setting | What you control | What to watch |
|---|---|---|
| Producer `batch.size` | Target capacity of a partition batch in bytes | Memory use and whether your traffic fills batches |
| Producer `linger.ms` | Intentional waiting opportunity to form a batch | Extra waiting at low load; it is not an end-to-end latency guarantee |
| Producer `compression.type` | Batch compression codec | CPU cost versus network/storage reduction |
| Producer `buffer.memory` and `max.block.ms` | Buffer budget and how long relevant calls can wait for metadata/buffer space | Application backpressure during an outage |
| Producer `delivery.timeout.ms` | Delivery time budget, including retries | Expired requests and uncertain outcomes |
| Consumer `max.poll.records` | Maximum records returned by a poll | Work per batch; it does not by itself cap all fetch memory |
| Consumer `max.poll.interval.ms` | Allowed delay between required polls under the group model | Processing stalls and reassignment risk |
| Consumer `enable.auto.commit` | Whether the client advances checkpoints automatically | Unsafe checkpoints when application work is unfinished |
| Consumer `auto.offset.reset` | Starting policy when no usable checkpoint exists | `earliest`, `latest`, or a deliberate failure policy such as `none` |

For example, `earliest` means the earliest **available** history, not records already deleted by retention. Choose recovery behavior explicitly instead of treating defaults as business policy.


Message size limits are coordinated across producer requests, broker/topic record batches, follower replication, and consumer fetch behavior. There is no one universal “Kafka maximum message size” that applies to every deployment. For example, the Java producer's `max.request.size` and the topic's `max.message.bytes` refer to different request/batch constraints, including compression distinctions.

Blindly increasing limits can create large allocations and expensive retries throughout the path. For large documents or images, publish a small durable reference, checksum, content type, and version; store the object where it can survive the intended replay window.

<details>
<summary>🖼️ Image prompt 59 — Tune the whole event path</summary>

**Purpose:** Performance comes from measured batching, data size, and I/O behavior across the whole path.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw a pipeline of Small event cards, Per-partition batch, Compression, Broker log segments, and Consumer batch. Put a small latency/memory dial beneath batching and a CPU/bytes dial beneath compression. Add a lower alternative path where a large image goes to object storage and only its reference enters Kafka.

**Exact labels:** Events; Partition batch; Compression; Log segments; Consumer batch; Latency ↔ memory; CPU ↔ bytes; Large object; Object storage; Reference only

**Accuracy guardrails:** Do not show batching as eliminating all latency, compression as free, or one fixed universal message-size limit. Avoid a claim that TLS traffic always uses zero-copy. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Performance comes from measured batching, data size, and I/O behavior across the whole path.

**Alt text:** Events are batched and compressed before log storage, with large objects kept outside Kafka and represented by references.

</details>

**🎯 Interview check:** How would you tune Kafka for low latency?  
**How to answer:** Measure the full path, then adjust batch waiting, batch size, compression, replication, and consumer processing against the latency budget. Verify throughput and memory effects.

**⚠️ Common misunderstanding:** “Larger batches are always better.” They can increase waiting, memory, and retry cost for your workload.

**💡 Easy-to-miss detail:** Large payloads affect replicas and every consumer group, not just the producer. Test realistic sizes and compression ratios.

**⚖️ Trade-off:** Throughput, latency, CPU, and memory compete. Choose settings from measurements under normal load and failures, not from copied benchmark numbers.

### 8.2 Capacity planning: calculate storage, parallelism, and catch-up

Use explicit assumptions. Suppose our **hypothetical** workload averages 5,000 events/s, peaks at 20,000 events/s, and averages 1,000 serialized bytes per event. We choose seven days of history, RF3, and three full-stream consumer groups. These are not Kafka capacity limits or measured production results.

| Estimate | Calculation | Result |
|---|---|---:|
| Average logical ingress | 5,000 × 1,000 bytes/s | 5 MB/s |
| Peak logical ingress | 20,000 × 1,000 bytes/s | 20 MB/s |
| Seven-day logical history | 5,000 × 1,000 × 604,800 | 3.024 TB |
| RF3 history | 3.024 × 3 | 9.072 TB |
| Peak follower-copy traffic | 20 MB/s × 2 followers | About 40 MB/s |
| Three groups reading at peak arrival rate | 20 MB/s × 3 | About 60 MB/s |

These use decimal MB/TB and ignore compression, protocol/index overhead, retries, remote storage, and uneven load. Broker count also depends on disk/network/CPU limits, failure headroom, placement, and recovery. Cross-zone traffic may change cost substantially.

For partition count, suppose a load test for **this workload** found 2,000 events/s of write capacity per partition and 800 events/s of consumer processing per serial lane. The write side suggests at least `ceil(20,000 / 2,000) = 10` partitions. The processing side suggests `ceil(20,000 / 800) = 25`. The slower requirement dominates.

If we target 70% utilization of that processing capacity, the starting estimate becomes `ceil(20,000 / (800 × 0.70)) = 36` partitions. That is a candidate to test, not a guarantee. It assumes balanced keys and enough worker capacity. RF3 gives 108 partition replicas, not 108 brokers. Benchmark failover and reassignments before accepting the design.

Now calculate recovery. If the backlog is 600,000 events, arrivals are 5,000/s, and consumers can sustain 8,000/s, net drain is 3,000/s. Catch-up takes about `600,000 / 3,000 = 200 seconds`. If processing only matches arrivals, the backlog never shrinks; if it is slower, the backlog grows.

<details>
<summary>🖼️ Image prompt 60 — Capacity includes time to recover</summary>

**Purpose:** A capacity plan must include replicated storage, useful processing lanes, and spare recovery throughput.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use three separated panels: Storage arithmetic with 5,000 events/s, 1,000 bytes, 7 days, RF3 leading to 9.072 TB; Parallelism with 20,000/s divided by 800/s and 70% target leading to 36 candidate partitions; Catch-up with backlog 600,000 divided by net drain 3,000/s leading to 200 seconds. Put Hypothetical workload and Excludes overhead prominently.

**Exact labels:** Hypothetical workload; 5,000/s; 1,000 bytes; 7 days; RF3; 9.072 TB; 20,000/s; 800/s; 70%; 36 candidate partitions; 600,000 backlog; 3,000/s net drain; 200 seconds; Excludes overhead

**Accuracy guardrails:** Use decimal units and exactly these calculations. Never label these figures as universal Kafka benchmarks or claim 36 partitions guarantees balance. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A capacity plan must include replicated storage, useful processing lanes, and spare recovery throughput.

**Alt text:** Three worked calculations estimate retained storage, a candidate partition count, and the time needed to drain a backlog.

</details>

**🎯 Interview check:** Why size for recovery rather than only the average traffic?  
**How to answer:** Failures and bursts create backlog. Without spare throughput, the system can run continuously yet never return to its freshness target.

**⚠️ Common misunderstanding:** “Replication factor multiplies consumer processing capacity.” Followers protect storage; they do not create more regular-group partition owners.

**💡 Easy-to-miss detail:** After losing a broker, surviving brokers inherit traffic and recovery work. Reserve headroom for that degraded state, not just the healthy benchmark.

**⚖️ Trade-off:** Extra capacity costs money but buys lower lag and faster recovery. Tie that budget to customer-visible deadlines and failure objectives.

### 8.3 Observe outcomes, not only healthy processes

A broker can be healthy while no customer receives a notification. Monitor the path from accepted request to durable publication to completed business effect.

| Layer | Useful signals | What they help distinguish |
|---|---|---|
| API/outbox | Oldest unpublished age, relay failures, pending order age | Publication stalled before Kafka |
| Producer | Send errors, latency, retries, buffer exhaustion | Routing, broker, or capacity trouble |
| Broker/replica | Offline partitions, ISR changes, disk pressure, request latency | Availability or storage risk |
| Consumer | Lag by partition, event age, handler time, commit failures, rebalances | Slow processing, hot keys, progress trouble |
| Business output | Completion latency, duplicate suppression, missing outcomes | Whether the product promise is being met |
| Recovery paths | Retry/DLQ age, replay throughput, mirror lag | Unresolved work and recovery exposure |

Offset lag is useful but not identical to a count of business events or elapsed time, especially with gaps and transactions. Compare it with event timestamps and business completion metrics. [Kafka monitoring](https://kafka.apache.org/43/operations/monitoring/).

Alert on trends that threaten a deadline, such as a growing oldest-event age, not only on a machine being down. Carry an event ID and trace context so you can connect a customer order to its publication and consumer effect.

<details>
<summary>🖼️ Image prompt 61 — See the whole order pipeline</summary>

**Purpose:** Observability must connect broker health with publication progress and customer-visible completion.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Create a horizontal service path from Order API to Outbox relay to Kafka to Consumer to Restaurant view. Under each stage place one small metric card: Pending age, Unpublished age, ISR + latency, Lag + handler time, Completion age. Add a shared trace ribbon labeled order-8472 / evt-8472-1 beneath the path and a side retry/DLQ age card.

**Exact labels:** Order API; Outbox relay; Kafka; Consumer; Restaurant view; Pending age; Unpublished age; ISR + latency; Lag + handler time; Completion age; Retry/DLQ age; order-8472; evt-8472-1

**Accuracy guardrails:** Do not portray low broker CPU or zero process errors as proof of completed business work. Keep offset lag and elapsed event age distinct. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Observability must connect broker health with publication progress and customer-visible completion.

**Alt text:** A traced order pipeline displays different freshness and failure metrics at each stage, including retry work.

</details>

**🎯 Interview check:** Lag is growing. What do you inspect first?  
**How to answer:** Find whether it is concentrated by partition and compare arrival rate, handler throughput, dependency latency, errors, and rebalances. Then fix the actual bottleneck.

**⚠️ Common misunderstanding:** “If lag is zero, the business action succeeded.” A consumer can commit too early or intentionally discard work.

**💡 Easy-to-miss detail:** Give every alarm a runbook and owner. Metrics without a recovery action do not shorten incidents.

### 8.4 Failure drills: predict, break, recover, verify

Before calling the design resilient, write down what should happen at each boundary and test it in an isolated environment.

| Failure | Expected response | Verification |
|---|---|---|
| Kafka temporarily unavailable | Outbox intent remains; relay retries within policy | No accepted order silently loses its publication intent |
| Producer response lost | Outcome may be uncertain; retry safely | No duplicate business effect from repeated event identity |
| P1 leader fails | Eligible election, metadata refresh, possible pause | Acknowledged history and write-policy behavior match expectations |
| Consumer crashes after database effect | Record may replay | Unique-event protection prevents a repeated effect |
| Consumer loses ownership mid-handler | New owner may resume; old work may still finish | No unsafe concurrent external effect or checkpoint |
| Provider remains unavailable | Bounded retries and visible backlog/escalation | Event age stays within the chosen policy or failure is reported |
| Consumer exceeds retained history | Deliberate reset or snapshot recovery | Missing history is detected rather than silently ignored |
| Entire region fails | Recovery procedure and reconciliation | Measured RPO/RTO, dependency readiness, controlled writer ownership |

For the RF3/minimum ISR2 illustration, lose one follower, then verify writes still succeed with two in-sync replicas. Lose another and verify strongly acknowledged writes fail. Restore replicas, wait for the required state, and verify recovery. Do not run this exercise on a shared production cluster as a casual tutorial.

A useful drill records expected behavior before the fault, observed behavior during it, and proof that business state is correct after recovery. “The process restarted” is not enough.

<details>
<summary>🖼️ Image prompt 62 — Test the failure boundary and the business result</summary>

**Purpose:** A resilience drill proves the intended recovery behavior and the resulting business state.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw a row of four experiment cards: Predict, Inject in isolated lab, Observe, Verify business state. Beneath place three small fault examples: Leader down, Crash after DB effect, Retention exceeded. Each example connects to an expected outcome card rather than a generic green tick.

**Exact labels:** Predict; Isolated lab; Observe; Verify business state; Leader down; Crash after DB effect; Retention exceeded; Expected outcome

**Accuracy guardrails:** Do not imply faults were executed for this article. Clearly label the illustration a drill plan and avoid production instructions or automatic success claims. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A resilience drill proves the intended recovery behavior and the resulting business state.

**Alt text:** An isolated fault-testing plan links leader, consumer, and retention failures to predicted recovery and business-state checks.

</details>

**🎯 Interview check:** How would you demonstrate that the design handles duplicates?  
**How to answer:** Force a crash after the protected effect but before the offset commit, then verify replay occurs and the effect remains logically single.

**⚠️ Common misunderstanding:** “A successful restart proves recovery.” You must also check lost work, duplicate effects, lag, and violated deadlines.

**💡 Easy-to-miss detail:** Fault tests need cleanup and recovery criteria. A half-finished drill can leave a cluster under-replicated or a consumer pointed at the wrong position.

### 8.5 Security, quotas, and managed-service responsibility

Kafka's security design includes authenticated identities, encrypted transport where required, and authorization for operations on topics, groups, and transactional identities. Listener configuration and advertised addresses also determine which network paths clients use. Keep public access and credentials out of casual examples. [Security overview](https://kafka.apache.org/43/security/security-overview/), [Listener configuration](https://kafka.apache.org/43/security/listener-configuration/).

Give each application only the permissions it needs. A notification service should not gain the ability to read all courier location history simply because both use the same cluster. Plan credential rotation, secret storage, topic ownership, and access reviews.

Quotas help contain noisy neighbors, including replay jobs. Payload minimization and bounded retention reduce unnecessary data exposure, but a multi-system deletion policy must consider derived stores, archives, and backups too.

Managed Kafka can reduce the burden of running brokers, but it does not pick a good ordering key, make consumer effects idempotent, ensure schema compatibility, or guarantee a particular recovery objective. Verify the provider's actual scaling, limits, networking, monitoring, and recovery features before depending on them.

Keep an ownership map: who operates brokers, who owns each topic contract, who handles connector failures, and who resolves dead-letter events. Reliability work falls between teams when those responsibilities are implicit.

<details>
<summary>🖼️ Image prompt 63 — Security and operations surround every component</summary>

**Purpose:** Secure operation requires scoped access, workload limits, and explicit ownership even with managed Kafka.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Show Producer, Kafka, Consumer, and Derived store as four groups inside a controlled network boundary. Put identity badges at client connections and small permission gates on Topic and Group access. Add quota meters for Live consumer and Replay job. Below draw an ownership strip separating Provider operations from Application responsibilities.

**Exact labels:** Producer identity; Kafka; Consumer identity; Derived store; Topic access; Group access; TLS; Quotas; Live consumer; Replay job; Provider operations; Application responsibilities

**Accuracy guardrails:** Do not label managed hosting as solving application correctness or depict encryption alone as complete access control. No real credentials or endpoints. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** Secure operation requires scoped access, workload limits, and explicit ownership even with managed Kafka.

**Alt text:** Authenticated clients access authorized Kafka resources under quotas, with provider and application responsibilities shown separately.

</details>

**🎯 Interview check:** What remains your responsibility with managed Kafka?  
**How to answer:** Event contracts, keys, consumer correctness, access choices, capacity expectations, observability, and end-to-end recovery. Check which infrastructure tasks the provider actually covers.

**⚠️ Common misunderstanding:** “Encryption means every authenticated client may read everything.” Authentication, encryption, and authorization solve different problems.

**💡 Easy-to-miss detail:** An application needs group permissions as well as topic access in typical secured setups. Diagnose authorization at the specific resource and operation.

**⚖️ Trade-off:** Managed hosting trades some infrastructure work for service cost and provider constraints. Compare total operating effort and guarantees, not only the price per broker.

<a id="9-practice"></a>

---

## 9. 🧪 Make the ideas stick: a small lab and an interview walkthrough

You do not need a production cluster to observe partition order, independent groups, and replay. Start with a disposable local broker, predict what should happen, then compare the result with the model.

### 9.1 Run the smallest useful experiment

This lab uses **one broker and replication factor 1**. It demonstrates reading and progress; it cannot demonstrate RF3 leader failover, minimum ISR2, or the three-broker placement used earlier. The partition selected by the actual client is not required to be the illustrative P1 from our story.

Use a disposable local environment with Docker running and port 9092 available. These commands target the official JVM image and keep the exposed port on localhost. This is a learning setup without production security or redundancy. The instructions are documentation-checked; the outputs described below are expected observations, not a recorded execution. [Official Kafka quickstart](https://kafka.apache.org/43/getting-started/quickstart/).

**Start Kafka and create a topic**

```bash
docker run -d --name mealroute-kafka \
  -p 127.0.0.1:9092:9092 \
  apache/kafka:4.3.1
```

Check readiness; retry after startup if the broker is not yet accepting requests:

```bash
docker exec mealroute-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --list
```

Create three partitions, with one replica each because this lab has one broker:

```bash
docker exec mealroute-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create --topic order-events \
  --partitions 3 --replication-factor 1
```

**Publish keyed events**

```bash
docker exec -it mealroute-kafka /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server localhost:9092 \
  --topic order-events \
  --property parse.key=true \
  --property key.separator='|'
```

Enter these lines, then stop the producer with Ctrl-C:

```text
order-8472|{"event_id":"e1","type":"OrderPlaced","version":1}
order-9120|{"event_id":"e2","type":"OrderPlaced","version":1}
order-8472|{"event_id":"e3","type":"RestaurantAccepted","version":2}
```

**Read with one consumer group**

```bash
docker exec -it mealroute-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic order-events \
  --group notifications-lab \
  --from-beginning \
  --property print.key=true \
  --property print.partition=true \
  --property print.offset=true
```

Observe that the two `order-8472` events use the same partition and have increasing offsets. Do not assume those offsets are adjacent or that the two different keys must use different partitions.

Start the same command in a second terminal. Publish more records and inspect assignment:

```bash
docker exec mealroute-kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group notifications-lab --members --verbose
```

The group shares partitions between members. With only a few keys, some assigned partitions may receive no new records; idle output alone does not prove a consumer has no assignment.

Stop one consumer with Ctrl-C. Watch the surviving member acquire its partitions after reassignment. Publish another event to observe continued processing.

**Prove that reading did not delete the records**

Run the consumer with a different group:

```bash
docker exec -it mealroute-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic order-events \
  --group analytics-lab \
  --from-beginning
```

On its first run, this group can read the retained history even though notifications already read it. On later runs, an existing committed position takes precedence over `--from-beginning`.

**Break progress tracking intentionally**

Before running this, predict whether printing a record will prevent it from appearing on restart:

```bash
docker exec -it mealroute-kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic order-events \
  --group no-commit-lab \
  --from-beginning \
  --consumer-property enable.auto.commit=false
```

Read some records, stop the consumer, and run the same command again. With a fresh group that never committed offsets, retained records should appear again.

This shows that reading and checkpointing differ. It does **not** prove application-level exactly-once behavior. To test that, add a real database effect and intentionally crash between its commit and the Kafka offset commit, following the timeline in section 5.4 and the idempotency boundary in section 7.1.

When finished, stop consumers and the lab broker:

```bash
docker stop mealroute-kafka
```

The container has no separately configured persistent volume. Removing it also removes the broker data stored in its writable layer. To resume the existing container instead of creating another with the same name, use `docker start mealroute-kafka`.

<details>
<summary>🖼️ Image prompt 64 — Predict what two groups and a restart will show</summary>

**Purpose:** A small lab can expose partition order, independent progress, and replay without pretending to test production redundancy.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Use a three-panel lab worksheet. Panel one: single local broker with three partition lanes and two same-key cards kept on one lane. Panel two: notifications-lab and analytics-lab with separate bookmarks. Panel three: no-commit-lab stops and rereads retained cards after restart. Place a clear RF1 / one broker badge and a small Not a replication test note.

**Exact labels:** Local broker; RF1; P0; P1; P2; Same key; notifications-lab; analytics-lab; no-commit-lab; Restart; Retained records; Not a replication test

**Accuracy guardrails:** Do not force the real console producer key into P1 or imply different keys must choose different partitions. These are expected observations, not recorded test results. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A small lab can expose partition order, independent progress, and replay without pretending to test production redundancy.

**Alt text:** A single-broker exercise compares keyed records, two consumer groups, and a consumer restart without committed progress.

</details>

**🎯 Interview check:** What does this experiment prove—and what does it not?  
**How to answer:** It can demonstrate stable keyed routing under this setup, independent group progress, and replay without commits. It does not establish external exactly-once effects or multi-broker durability.

**⚠️ Common misunderstanding:** “If the lab works with RF1, production redundancy is verified.” RF1 has no extra copy of a partition.

**💡 Easy-to-miss detail:** Keep group names and retained data in mind when repeating the experiment. Existing checkpoints can change what from-beginning appears to do; use a deliberate new group or controlled reset.

### 9.2 Explain the design as decisions, not a list of Kafka terms

Imagine an interviewer asks you to design MealRoute's order-event pipeline. A strong answer begins with the promise: “An accepted API request durably records the order; restaurant confirmation arrives later.” Then work through the decisions in a useful order.

1. **Clarify requirements.** Ask about peak traffic, allowed delay, ordering scope, replay duration, duplicate tolerance, and acceptable data loss.
2. **Keep one order coherent.** Choose `order_id` as the lifecycle key unless a broader ordering rule is required. Explain the hot-key and partition-count implications.
3. **Make publication reliable.** Store the order and outbox entry together. Publish with a stable event ID and a tested relay.
4. **Choose storage guarantees.** Explain RF3, `acks=all`, minimum ISR2, eligible leader recovery, and when the design becomes unavailable.
5. **Separate applications.** Use distinct restaurant, notification, and analytics groups. Scale each within the useful partition and dependency capacity.
6. **Protect effects and checkpoints.** Show the offset-42/commit-43 crash timeline. Use a database transaction or destination-supported idempotency for repeated effects.
7. **Design the unhappy paths.** Bound retries, own dead-letter records, monitor event age, and plan replay plus regional recovery if required.
8. **Check the numbers.** Estimate storage, throughput, useful parallelism, and catch-up time, then say which assumptions need a load test.

Try these follow-ups before reading their answers:

| Question | Reasoning to include |
|---|---|
| We have five consumers and three partitions. Why are two idle? | Regular-group ownership is partition-based; add useful partitions or change the processing model only if requirements allow it |
| Notifications ran twice. Did Kafka break its contract? | Examine business identity, the effect/checkpoint crash window, producer retry scope, and the destination's idempotency behavior |
| We doubled brokers but one partition is still behind. Why? | A hot key or slow handler remains serial; broker count does not split that key |
| We need to replay yesterday. What might go wrong? | Retention, old schemas, expired objects, repeated external effects, stale reference data, and live-workload contention |
| Can we acknowledge checkout during a Kafka outage? | Potentially, if the chosen API promise is satisfied by a committed order/outbox and publication delay is managed; restaurant confirmation remains pending |
| What happens when analytics falls behind? | Its checkpoint diverges independently, but retained history and shared broker capacity still bound recovery |

**The mental model to keep:** A topic names the stream. Partitions provide independent ordered logs. Replicas protect each log. Producers route and append. Groups organize readers. Applications make effects safe. Checkpoints say where a group should resume. Retention decides how much history remains available.

<details>
<summary>🖼️ Image prompt 65 — A system-design answer follows the decisions</summary>

**Purpose:** A convincing Kafka design connects each mechanism to a requirement and failure boundary.

**Image prompt:** Create a polished engineering notebook illustration on a pure white background (#FFFFFF), in 16:9 format. Use subtle hand-drawn dark navy outlines, crisp large print lettering, generous white space, and small simple icons. Use blue for producers/services, teal for Kafka data, purple for consumer groups, green for completed work, and amber for warnings. Keep the notebook character in the linework, not messy handwriting. No beige or ivory paper, colored background, heavy grid, paper texture, dark theme, 3D, glow, watermarks, or logos. Target a high-resolution canvas, ideally 3200 × 1800 for landscape if supported. Keep at least 6% outer margins and labels readable when shown at 900px article width. Keep labels short; no paragraphs inside the image. Split crowded panels instead of shrinking the lettering.

**Composition and arrows:** Draw a clean two-row notebook map of eight numbered cards: Promise, Ordering key, Reliable publication, Durability, Consumer groups, Effects + checkpoints, Failure recovery, Capacity. Use small concrete icons and one continuous reading sequence without detailed service wiring. In the checkpoint card show the tiny example 42 processed → next 43.

**Exact labels:** 1 Promise; 2 Ordering key; 3 Publication; 4 Durability; 5 Groups; 6 Effects + checkpoints; 7 Recovery; 8 Capacity; 42 processed; Next: 43

**Accuracy guardrails:** This is an interview reasoning map, not a network topology. Do not claim a universal architecture or collapse effect completion and checkpoint into one automatic operation. Use solid arrows for data, dashed arrows for metadata or checkpoints, and a small legend whenever both appear. Do not invent extra labels, numerical guarantees, or connections.

**Caption:** A convincing Kafka design connects each mechanism to a requirement and failure boundary.

**Alt text:** Eight decision cards guide an explanation from the API promise and ordering key through recovery and capacity.

</details>

**🎯 Interview check:** What makes this answer stronger than naming Kafka features?  
**How to answer:** Each choice follows from a requirement, names its limit, and predicts what happens under failure. That lets the interviewer evaluate your reasoning.

**⚠️ Common misunderstanding:** “More terminology means a stronger design.” Unexplained settings and guarantees often hide missing decisions.

**💡 Easy-to-miss detail:** Say what you would measure or verify when requirements are incomplete. Clearly stated assumptions are stronger than fabricated throughput or availability claims.

<a id="10-next-topics"></a>

---

## 10. 🧭 Missing topics and what to learn next

You now have the foundation for explaining Kafka and choosing it deliberately. There are still topics worth a dedicated article or lab. This list separates **what was added here**, **what was introduced but needs more practice**, and **what is not covered in depth**. No single blog can exhaust every Kafka version, connector, failure mode, and operating environment.

**Essentials added and explained in this article**

| Coverage | Where to revisit |
|---|---|
| Why Kafka helps, where it does not, and what the API actually promises | 1 and 6.16, including six illustrated alternatives |
| Every motivating scenario from the transcript, using an original food-delivery story | 2.1–2.6; extra reader and failure scenarios in 2.7–2.10 |
| Record fields, keys, event IDs, versions, topics, partitions, offsets, brokers, and replication factor | 3.1–3.4 |
| Consumer groups, position versus committed offset, retention, and control-plane roles | 3.5–3.8 |
| Partition selection, ordering boundaries, hot keys, remapping, ISR, acknowledgements, and leader recovery | 4.1–4.5 |
| Complete event journey, decision ownership, safe effects, commit 43, and crash windows | 5.1–5.4 |
| The transcript's async jobs, ordered admission, independent scaling, live delivery, and aggregation uses, plus broader families | 6.1–6.15 |
| Outbox reliability, duplicate boundaries, transactions, retries, schemas, compaction, Connect, and Streams | 5.1 and 7.1–7.7 |
| Performance trade-offs, sizing and catch-up math, observability, failures, security, and managed-service limits | 8.1–8.5 |
| A reproducible local exercise and interview reasoning practice | 9.1–9.2 |

**Introduced here, but a deeper tutorial or lab is still needed**

| Topic | Why it matters | Priority and next exercise |
|---|---|---|
| A complete producer/consumer application | Real error handling, shutdown, configuration, and observability exceed pseudocode | High: implement one idempotent database consumer and crash it between effect and checkpoint |
| Multi-broker replication, minimum ISR, and ELR | The single-broker lab cannot test leader safety or write availability | High: run an isolated three-broker cluster and verify the stable failure cases |
| Outbox relay and CDC recovery | Snapshot boundaries, duplicate publication, ordering, cleanup, and source-log retention need implementation work | High: stop a relay after publication and verify safe duplicate delivery |
| Retry and dead-letter re-drive | Delays, key ordering, transfer atomicity, and operator ownership can fail independently | High: exercise transient failure, poison data, and controlled re-drive |
| Consumer concurrency and rebalances | Safe checkpoint prefixes and stale in-flight effects are subtle | High: revoke partitions while background work is running and inspect results |
| Kafka transactional applications | Abort handling, fencing, transaction timeouts, identity, and read isolation need real tests | High when used: build a consume-transform-produce application and interrupt it mid-transaction |
| Schema evolution across retained history | Structural checks and semantic compatibility differ | High: deploy old/new readers in both orders, then replay older versions |
| Compaction and tombstone recovery | Asynchronous cleanup and deleted-key recovery are easy to misunderstand | High for state topics: observe cleaning and rebuild after missing tombstones |
| Stateful joins and windows | Co-partitioning, event time, grace periods, state size, and result finality need worked examples | Medium: join order and restaurant streams with deliberately late events |
| Connect source/sink guarantees | Behavior depends on the particular connector and destination | Medium: test a chosen connector across source and destination outages |
| Tiered storage | Plugin choice, remote reads, cache behavior, cost, and deletion require an operational setup | Medium when needed: benchmark a historical replay against local and remote segments |
| Regional recovery and mirroring | Offset translation, writer ownership, dependencies, failover, and failback need a coordinated runbook | High when required: measure a recovery drill against explicit RPO/RTO |
| Security and data lifecycle | Identities, ACLs, rotation, deletion across derived stores, and access reviews are environment-specific | High: build an application permission matrix and test denied operations |

**Relevant topics not covered in depth**

| Missing deep dive | Why learn it? | Suggested next step |
|---|---|---|
| Partition reassignment, rack awareness, and leadership balancing | Adding brokers does not safely rebalance all workloads by itself | Practice reassignment with throttling, failure headroom, and verification |
| Detailed classic/consumer group protocols, static membership, and assignors | Group changes affect latency, ownership, and upgrade behavior | Compare supported protocols under rolling deploys and failures |
| Share groups and record-level acknowledgement | Their concurrency and ordering model differs from the regular groups used here | Study acquisition, acknowledgement, delivery attempts, and failure recovery in a separate lab |
| Transaction and replication internals | Producer epochs, fencing, leader epochs, high-watermark/LSO transitions, and ELR rules explain edge cases | Trace protocol-level failures after mastering the observable behavior |
| Internal topics and coordinator recovery | Offset checkpoints and transaction state need their own replication, availability, and retention choices | Inspect internal-topic settings and test coordinator failover in an isolated cluster |
| KRaft quorum operations and metadata recovery | Controller replacement and quorum trouble require careful procedures | Rehearse supported recovery and voter-management operations in isolation |
| Broker/client upgrades and feature finalization | Compatibility and irreversible feature changes can affect rollback options | Build a version-specific upgrade/rollback plan from official guidance |
| Detailed log files, indexes, page cache, disk corruption, and recovery | Storage behavior matters during capacity and incident analysis | Inspect segment/index files in a disposable environment |
| Quotas, multi-tenancy, and noisy-neighbor load tests | Replay or one large tenant can degrade unrelated applications | Test isolated limits with realistic payloads and skewed keys |
| Partition-count migrations and historical key continuity | New partitions may split an entity's old and new history | Design a topic-version migration and prove reader continuity |
| Event sourcing, snapshots, audit archives, and governance | An authoritative event history has requirements beyond an ordinary stream | Compare a dedicated event store/archive against the stated query and retention needs |
| Large-scale disaster drills and dependency recovery | Kafka recovery alone may leave databases, keys, objects, or gateways unavailable | Exercise the entire service recovery chain, including reconciliation |
| Benchmark methodology and cost optimization | Vendor numbers rarely match a specific event size, key distribution, or failure state | Measure throughput, latency percentiles, storage, and recovery with a representative workload |

Start with the high-priority items that affect your chosen use case. You do not need to master every internal protocol before building a useful system, but you should be able to explain the guarantees you are relying on—and demonstrate the failures that could break them.
