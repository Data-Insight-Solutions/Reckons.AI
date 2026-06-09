# User Stories — Shared Knowledge & Collaborative Reckoning

These stories explore how Reckons.AI fits into group decision-making. Each follows the same pattern:

1. One person organizes a KB around a shared topic
2. They export and distribute a `.ttl` file
3. Others import it as a source in their own KB
4. Each person uses Shelly and the Reckoning to ask questions relevant to them
5. Decisions from a Reckoning are annotated with the sources that informed them
6. The organizer re-exports when things change; importers see the diff in Compare

---

## Story 1 — Float Trip (Recreational, Weather-Dependent)

### Context

Alice is organizing a float trip down the Meramec River for six friends. The trip is weather-sensitive: high water is dangerous, and afternoon thunderstorms are common in July. The group needs to agree on a launch date and time, then monitor the forecast together as the date approaches.

### Personas

| Person | Role | Concern |
|---|---|---|
| Alice | Organizer | Logistics — river access, shuttle, campsite |
| Bob | Participant | Work schedule — can only do Saturday |
| Carol | Participant | Weather anxiety — wants a clear window confirmed |
| David | Participant | Gear — will he need a dry bag? Rain chance? |
| Eve | Participant | Driving — different origin, needs departure time |

### KB Structure (Alice's `float-trip.ttl`)

Alice builds her KB by ingesting notes about the trip. After extraction and confirmation, she has statements like:

```turtle
<urn:trip:float/meramec-jul-2026>
  a <urn:kbase:type/Event> ;
  rdfs:label "Meramec Float — July 2026" ;
  <urn:trip:predicate/launch-site> <urn:trip:place/route-66-access> ;
  <urn:trip:predicate/shuttle-dropoff> <urn:trip:place/onondaga-cave-takeout> ;
  <urn:trip:predicate/estimated-distance-miles> "11" ;
  <urn:trip:predicate/typical-float-hours> "5-6" .

<urn:trip:place/route-66-access>
  rdfs:label "Route 66 Access Point" ;
  <urn:trip:predicate/parking-capacity> "12 cars" ;
  <urn:trip:predicate/shuttle-service-available> "yes — Old Canoe Outfitters" .
```

She also ingests the USGS river gauge page as a URL source, pulling current water level and forecast flow rate. Each ingestion creates a dated source record:

```turtle
# Source record added by Reckons.AI on ingest
<urn:source:usgs-gauge-20260710>
  a <urn:kbase:type/Source> ;
  rdfs:label "USGS Gauge #07018500 — Meramec at Eureka, 2026-07-10" ;
  <urn:source:predicate/url> "https://waterdata.usgs.gov/monitoring-location/07018500/" ;
  <urn:source:predicate/retrieved-at> "2026-07-10T08:30:00Z" ;
  <urn:source:predicate/trust-level> "trusted" .

<urn:trip:condition/water-level-20260710>
  a <urn:kbase:type/Observation> ;
  rdfs:label "River level July 10 — 4.2 ft (normal)" ;
  <urn:source:predicate/source> <urn:source:usgs-gauge-20260710> ;
  <urn:trip:predicate/gauge-feet> "4.2" ;
  <urn:trip:predicate/status> "normal — safe to float" .
```

### Workflow

**Day -7 (one week out):**

Alice runs a Reckoning:

> **Situation:** Float trip planned for Saturday July 19. River gauge is 4.2 ft (normal). Weather.gov shows a 70% rain chance Saturday morning with clearing by noon.
>
> **Target:** Choose the best launch time that avoids rain and gives the group a full float.

The Reckoning produces:

> **Overview:** Your KB shows the river is at a safe level and the rain pattern favors a late morning start. Most risk comes from the morning storm window, not the river conditions.
>
> **Option A: 10:30am Launch**
> Basis: Weather.gov forecast (trusted source) shows rain ending by 10am with 85% confidence — Source: Weather.gov 7-day, retrieved July 13
> Action: Notify group by Wednesday; arrange shuttle pickup for 10am at takeout
> Consideration: If rain runs long, the launch pushes to noon, cutting float time to 4 hours
>
> **Option B: 1:00pm Launch (same-day decision)**
> Basis: Weather.gov hourly shows clearing by noon with high confidence if morning radar confirms
> Action: Set a go/no-go decision point at 8am Saturday based on live radar
> Consideration: Requires everyone to be at the access point before the decision is final
>
> **Recommendation:** Start with Option A (10:30am) and communicate a contingency: if it's still raining at 9:30am, call an 8am-Saturday group check using Option B. The KB shows the rain window is short and the float time is well within daylight.
>
> **Confidence:** high — weather source is trusted, river level is normal

Alice accepts the KB actions. This adds to her KB:

```turtle
<urn:trip:decision/launch-time-20260713>
  a <urn:kbase:type/Decision> ;
  rdfs:label "Launch time decision — July 13, 2026" ;
  <urn:trip:predicate/chosen-option> "Option A: 10:30am Launch" ;
  <urn:trip:predicate/contingency> "8am Saturday go/no-go if raining" ;
  <urn:trip:predicate/based-on-source> <urn:source:weathergov-20260713> ;
  <urn:trip:predicate/based-on-source> <urn:source:usgs-gauge-20260710> ;
  <urn:trip:predicate/decided-by> <urn:kbase:person/alice> .
```

**Sharing:**

Alice exports `float-trip-jul19.ttl` and sends it to the group chat. Everyone imports it into their own Reckons.AI KB as an external source.

**Bob's KB (participant):**

Bob imports Alice's TTL. He asks Shelly:

> "Can I still make this if I leave work at 6am Saturday?"

Shelly reads Alice's statements:

> "The launch is at 10:30am at Route 66 Access — about 40 minutes from downtown St. Louis. Leaving at 6am gives you plenty of time, even with a gear stop. The contingency (decision may shift to noon) is noted in Alice's plan."

**Carol's KB (weather-anxious):**

Carol asks Shelly to check the current forecast against the decision. She has also subscribed to the Weather.gov URL as her own source.

> "The decision was made on July 13 based on a 70% rain chance. Today's forecast (July 16) shows the rain chance has dropped to 40% Saturday morning. The launch is looking more solid."

**David's KB (gear):**

David asks:

> "Do I need a dry bag?"

Shelly reads the water level and rain probability statements:

> "River is at 4.2 ft — calm conditions, no rapids above Class I on this stretch. Rain chance is 40% in the morning window but the decision accounts for it. A light dry bag for your phone and wallet is sensible; heavy waterproofing is optional."

**Day -1 (Friday):**

Alice re-ingests the Weather.gov forecast (now showing the storm moved up — clearing by 9am). She runs a brief Reckoning to confirm the 10:30am plan holds. It does. She re-exports and reshares the updated TTL. Everyone's imported source is now stale — they each see a "source updated" notification when they re-import.

### What This Demonstrates

- KB as living document: re-ingesting an updated URL source creates a new dated record; old forecasts stay in the KB as historical context
- Decisions are annotated with the sources that informed them — future participants can see WHY 10:30am was chosen
- Each person's KB is their own; they choose what to trust and which sources to subscribe to
- The organizer's TTL is the single source of truth for shared logistics, but each person can add their own context on top

---

## Story 2 — Residential Construction Project

### Context

Marcus is a general contractor managing a kitchen renovation. His team includes a plumber (Rosa), an electrician (Jerome), and a tile subcontractor (Pita). Each trade's schedule depends on the others completing their rough-in work first. Marcus maintains the project KB; subs import it to understand their dependencies and scope.

### Personas

| Person | Role | Concern |
|---|---|---|
| Marcus | GC | Schedule coordination, change orders, inspections |
| Rosa | Plumber | When can she start rough-in? Is the demo done? |
| Jerome | Electrician | Panel upgrade timing, permit status |
| Pita | Tile sub | When will the cement board be ready? |
| Homeowner (Linda) | Client | Budget, disruption, finish date |

### KB Structure

Marcus builds his KB from project notes, permit documents, and change orders. Key entities:

```turtle
<urn:project:renovation/kitchen-mueller-2026>
  a <urn:kbase:type/Project> ;
  rdfs:label "Mueller Kitchen Renovation" ;
  <urn:project:predicate/address> "1412 Oak St, Webster Groves" ;
  <urn:project:predicate/permit-number> "WG-2026-0441" ;
  <urn:project:predicate/permit-status> "approved" ;
  <urn:project:predicate/demo-complete-date> "2026-06-02" ;
  <urn:project:predicate/rough-in-window-start> "2026-06-03" .

<urn:project:scope/plumbing-rough-in>
  a <urn:kbase:type/Task> ;
  rdfs:label "Plumbing Rough-In" ;
  <urn:project:predicate/depends-on> <urn:project:milestone/demo-complete> ;
  <urn:project:predicate/assigned-to> <urn:kbase:person/rosa> ;
  <urn:project:predicate/estimated-days> "3" ;
  <urn:project:predicate/inspection-required> "yes — plumbing rough-in" .
```

### Workflow

**Change Order Event:**

Three weeks in, Linda decides to add a pot-filler above the range. Marcus creates a change order note and ingests it:

```
Change Order #3 — Add pot filler above range. Requires new 1/2" copper branch from existing hot water supply at north wall. Adds ~$340 materials, 4 hours labor. Pushes Rosa's finish by 1 day.
```

After ingestion, Marcus runs a Reckoning:

> **Situation:** Change order #3 adds a pot-filler. Rosa's rough-in extends by 1 day. Jerome's panel upgrade was scheduled to start the day after Rosa finishes.
>
> **Target:** Assess schedule impact and determine if Jerome needs to be notified to adjust.

The Reckoning:

> **Overview:** The pot-filler change adds one day to rough-in, which directly pushes Jerome's start. Your KB shows Jerome's panel work is time-sensitive because the inspection has a 10-day lead time for the city.
>
> **Recommendation:** Notify Jerome today. A 1-day shift now is manageable; if the inspection window is missed, it could delay tile work by 2+ weeks. The change order is the trigger.
>
> **Confidence:** high — dependency chain is clearly documented in the project KB

Marcus accepts the action. The KB now records the change order as the basis for the schedule notification:

```turtle
<urn:project:decision/notify-jerome-20260604>
  <urn:project:predicate/trigger> <urn:project:change-order/CO-003> ;
  <urn:project:predicate/action-taken> "Jerome notified June 4 — start shifted to June 9" ;
  <urn:project:predicate/decided-by> <urn:kbase:person/marcus> .
```

**Rosa's perspective:**

Rosa imports Marcus's project TTL. She asks Shelly:

> "What does the pot-filler add to my scope?"

Shelly reads Change Order #3:

> "CO-3 adds a 1/2 inch copper branch from the north wall hot water supply to the range location. Marcus's notes show 4 hours labor. Your rough-in window now ends June 8 instead of June 7."

**Jerome's perspective:**

Jerome imports the updated TTL. He asks Shelly:

> "Is the panel upgrade still on June 8?"

> "Marcus updated the project on June 4 — your start shifts to June 9 due to CO-3 extending Rosa's rough-in. The inspection lead time (10 days) means you'd want to submit by June 12 to hit the June 22 inspection window Marcus has noted."

### What This Demonstrates

- Change orders become first-class KB entities with traceable impacts
- Each trade's questions are answered by the shared KB without Marcus being the bottleneck
- Decisions are traceable: anyone importing the TTL can see that the June 9 date was set because of CO-3, not arbitrarily
- The organizer (Marcus) is the source of truth; trades add their own notes on top for their personal tracking

---

## Story 3 — Academic Research Group

### Context

Dr. Chen runs a computational neuroscience lab. She maintains a KB of literature reviews, experimental parameters, and findings. Three PhD students (Ana, Ben, Fatima) each work on related subproblems. They share a common base KB but have their own experiment results layered on top.

### Personas

| Person | Role | Concern |
|---|---|---|
| Dr. Chen | PI | Research direction, grant reporting, paper coherence |
| Ana | PhD student | Conflict between her results and Paper A |
| Ben | PhD student | Experiment design depends on shared parameter decisions |
| Fatima | PhD student | Writing — needs citations and confidence levels for claims |

### Workflow

**Shared Base KB:**

Dr. Chen maintains `lab-base.ttl` with literature notes, confirmed findings, and key parameter decisions. Students import it.

**Ana's conflict:**

Ana's experiment results show activation latency ~40ms shorter than Paper A predicts. She adds her results to her own KB, then imports the shared base. She runs a Reckoning:

> **Situation:** My results show 40ms shorter activation latency than Huang et al. (2022). Three other papers in the shared KB (imported from Dr. Chen) show similar deviations from Huang. Our experimental conditions use higher calcium concentration.
>
> **Target:** Should I frame this as a replication failure of Huang, or a novel finding about calcium's effect on latency?

The Reckoning cites four papers by their DOI URIs and the calcium concentration parameter from the shared KB:

> **Option A: Novel finding about calcium modulation**
> Basis: Chen Lab base KB — "calcium concentration above 1.8mM not tested in Huang 2022" (confirmed statement, trusted source Dr. Chen)
> Action: Run a dose-response experiment across 3 calcium levels; report the dependency directly
>
> **Option B: Replication with important caveat**
> Basis: Liu 2023 (doi:10.1016/...) shows similar deviation under identical conditions — Source: literature review, imported from Dr. Chen's KB
> Action: Frame as replication of Liu 2023, extending their calcium result
>
> **Recommendation:** Option A has stronger novelty; Option B is safer for publication timeline. The KB shows Dr. Chen noted "calcium effects underpublished" in her literature notes — this supports Option A.

Ana accepts the "novel finding" framing and adds a decision record to her KB. When she next shares her results TTL with the lab, Dr. Chen can see the decision is grounded in the shared literature base, not just Ana's instinct.

**Fatima's writing:**

Fatima imports both `lab-base.ttl` and Ana's `ana-results.ttl`. When writing her discussion section:

> "What's the confidence level on the claim that calcium modulates activation latency?"

Shelly reads the trust chain:

> "High confidence. Ana's result is from a primary experiment (trusted, 3 replications in her KB). It's supported by Liu 2023 (peer-reviewed, trusted source in Dr. Chen's base KB) and consistent with the underpublished-calcium note from the lab base. The Huang 2022 deviation is documented with a plausible mechanism."

### What This Demonstrates

- Layered knowledge: shared base + individual experiment layers are cleanly separated by source
- A Reckoning outcome (Option A vs B) becomes a citeable decision with the papers that informed it
- Confidence levels in claims are derivable from the trust chain of sources
- Students can work independently and merge their KBs by sharing TTL files — the Compare view shows what's new vs conflicting

---

## Story 4 — Emergency Preparedness (Neighborhood Group)

### Context

A neighborhood association prepares for severe weather season. The coordinator (Sam) maintains a KB with resource inventories, contact trees, and shelter locations. Neighbors import it to know what resources are available and where to go.

### Personas

| Person | Role | Concern |
|---|---|---|
| Sam | Coordinator | Resource tracking, communication tree |
| Maria | Neighbor | Elderly mother needs evacuation help |
| Kenji | Neighbor | Has a generator — wants to know who needs power |
| Darlene | Neighbor | Medical supplies — wants to coordinate with Sam |

### Workflow

Sam ingests neighborhood resource notes and a recurring weather alert URL. His KB tracks who has what resources and who has special needs.

**Before a storm:**

Sam re-ingests the NWS alert page. The forecast shows a severe thunderstorm watch turning to warning by 6pm. He runs a Reckoning:

> **Situation:** Severe thunderstorm warning effective 6pm. Two neighbors (Maria's mother, the Okafor family's newborn) have flagged power dependency in the shared KB. Generator owners: Kenji (5500W), Paul (3000W).
>
> **Target:** Coordinate power resources with those who need them before 6pm.

The Reckoning:

> **Option A: Kenji covers Maria's mother (medical devices), Paul covers Okafor family**
> Basis: Kenji's 5500W can run CPAP + refrigerator simultaneously — confirmed in neighborhood resource KB; Maria's mother's needs are 1800W peak
> Action: Sam texts Kenji and Maria now; confirm extension cord run by 5pm
>
> **Recommendation:** Make the Kenji-Maria match now. The KB shows Kenji offered availability in the last storm drill. Act before 6pm when conditions deteriorate.

Sam accepts the actions. The KB records the resource allocation decision with the NWS warning as the backing source. He re-exports and shares. Maria sees her mother is assigned to Kenji's generator. Kenji sees he's the primary resource for Maria's address.

---

## Implied Features (Roadmap Implications)

These stories suggest the following capabilities not yet fully implemented:

### Recurring source re-ingestion
> "Alice re-ingests the Weather.gov forecast"

Currently this requires manual action. A **source subscription** feature would let a user mark a URL source as "recurring" with a check interval (e.g., every 6 hours). On each check, the new content is ingested as a new dated source record. The old record is kept for historical comparison.

**Implementation sketch:**
- Add `subscribeInterval?: number` (minutes) to `Source` type
- Cron-like store (`auto-ingest.svelte.ts`) checks subscribed sources on interval
- Each re-ingest creates a new source with a timestamp suffix, linked to the original URL
- Compare view can show the diff between the old and new ingest

### Import-as-source with update detection
> "Everyone imports Alice's TTL"

Currently import replaces or merges. A cleaner flow would treat an imported TTL as a named source with a `sharedBy` field. When the original sharer re-exports, importers see a "source updated — review changes" notification using the existing Compare engine.

**Implementation sketch:**
- On import, capture `importedFrom` (file hash + optional label like "Alice's Float Trip KB")
- Store the hash; when the same file is re-imported, route through Compare instead of direct merge
- The importer can accept/reject individual changes from the updated TTL

### STP decision citations
> "The Reckoning produces a recommendation; accepted actions are annotated with sources"

Currently `generateTechnicalDetail()` is an explicit follow-up step. A tighter integration would automatically annotate accepted KB actions with:
- The source IRIs visible in the KB snapshot at the time of the Reckoning
- The Reckoning timestamp
- The confidence level

This makes the KB self-documenting: anyone reading the triple later can see it was added by a Reckoning on a specific date, informed by specific sources.

**Implementation sketch:**
- `TurtleChatResponse.actions` can carry a `reckoningId` field
- When accepted in the Review queue, statements get a `prov:wasInformedBy` triple pointing to the source IRIs that were cited
- The History timeline can show "decision made on date X informed by source Y"

### Multi-user TTL sharing UX
> "Alice exports and sends to the group chat"

Currently this is file export + manual send. A low-friction path:
- A **share link** that generates a URL pointing to a self-hosted or Drive-hosted TTL (already possible via Workspace + Google Drive sync from MCP roadmap)
- Others paste the URL into Reckons.AI to import directly
- No accounts required — the TTL is the protocol

### Recurring weather / external data check
> "Carol subscribed to Weather.gov as her own source"

The recurring source feature above covers this. The additional piece is a **condition trigger**:

> "If gauge height exceeds 8ft, notify me"

This would be a simple rule stored in the KB:
```turtle
<urn:alert:rule/river-gauge-high>
  a <urn:kbase:type/AlertRule> ;
  <urn:alert:predicate/source> <urn:source:usgs-gauge> ;
  <urn:alert:predicate/condition> "gauge-feet > 8" ;
  <urn:alert:predicate/action> "push-notification" .
```

The auto-ingest cron checks the rule after each re-ingest and pushes a browser notification if the condition is met.
