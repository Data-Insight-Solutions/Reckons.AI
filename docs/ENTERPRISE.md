# Reckons.AI — Enterprise Roadmap

> Structure organisational knowledge around **People, Policy, and Procedure** —
> the three dimensions that determine how knowledge flows in any organisation.

## The 3 Ps Framework

```
People                    Policy                    Procedure
(who knows what)          (what governs it)         (how it gets done)

├─ Roles & teams          ├─ Legal constraints      ├─ SOPs
├─ Ownership              ├─ Cultural norms         ├─ Decision trees
├─ Delegation             ├─ Compliance rules       ├─ Process graphs
├─ Audit trails           ├─ Data classification    ├─ Checklists
└─ Trust scores           └─ Retention policies     └─ Runbooks
```

Each dimension maps naturally to RDF triples. A single fact can carry all three:

```turtle
:deploy-procedure :owned-by :sre-team .           # People
:deploy-procedure :governed-by :change-policy .    # Policy
:deploy-procedure :has-step :run-integration-tests . # Procedure
```

## Architecture

### Personal vs Enterprise

The personal Reckons.AI remains unchanged — local-first, no accounts, browser-only.
Enterprise features are an **opt-in layer** that adds:

```
Personal (existing)              Enterprise (new layer)
┌──────────────────┐            ┌──────────────────────────┐
│ IndexedDB / TTL  │            │ RBAC engine              │
│ MCP server       │  ── TTL ─> │ Auth gateway (BYOA)      │
│ Browser app      │            │ Team KB registry         │
│ n8n cloud sync   │            │ Audit log                │
└──────────────────┘            │ Policy graph overlay     │
                                └──────────────────────────┘
```

### Key Design Decisions

1. **File-based delivery**: Enterprise KBs are distributed as `.ttl` files.
   No proprietary format, no database dependency. Any RDF tool can read them.

2. **Bring Your Own Auth (BYOA)**: No built-in identity provider. Organisations
   plug in their existing SSO/LDAP/OIDC. Reckons.AI consumes identity tokens,
   never stores credentials.

3. **Self-hosted**: The n8n cloud sync layer runs on the organisation's
   infrastructure. Air-gapped operation is a first-class requirement.

4. **Graph-native RBAC**: Permissions are themselves triples in the graph.
   `alice :has-role :editor` is a fact like any other — queryable, auditable,
   time-bounded.

## RBAC Model

### Roles

| Role | Read | Write | Review | Admin |
|------|------|-------|--------|-------|
| Viewer | yes | — | — | — |
| Contributor | yes | yes (pending) | — | — |
| Reviewer | yes | yes | yes | — |
| Admin | yes | yes | yes | yes |

### Scoping

Permissions can be scoped at three levels:

1. **KB-level**: access to an entire knowledge base
2. **Graph-level**: access to a named graph (source) within a KB
3. **Entity-level**: access to statements about specific entities

```turtle
:alice :has-role :reviewer ;
       :scoped-to :project-alpha-kb .

:bob   :has-role :contributor ;
       :scoped-to :project-alpha-kb ;
       :restricted-from :hr-entities .
```

### Audit Trail

Every mutation logs:

```turtle
:audit-001 :actor :alice ;
           :action "confirm" ;
           :target :statement-xyz ;
           :timestamp "2026-06-23T12:00:00Z"^^xsd:dateTime .
```

## Authentication: BYOA

### Supported Protocols

| Protocol | Use Case |
|----------|----------|
| **OIDC** | Corporate SSO (Okta, Auth0, Entra ID) |
| **LDAP** | On-premise Active Directory |
| **SAML** | Legacy enterprise SSO |
| **API Key** | Machine-to-machine (MCP, n8n, CI/CD) |

### Flow

```
User → Auth Provider (org's SSO)
         ↓
       JWT / SAML assertion
         ↓
     Reckons Auth Gateway (validates token, extracts identity)
         ↓
     Maps identity → RBAC role (from graph)
         ↓
     Authorises request
```

The auth gateway is a thin middleware layer. It does not store users, passwords,
or sessions. It validates tokens from the organisation's identity provider and
maps them to RBAC roles defined in the knowledge graph.

## File-Based TTL Delivery

### Distribution Model

```
Admin authors KB → exports .ttl → distributes via:
  ├─ n8n sync hub (webhook upload/download)
  ├─ Git repository (version controlled)
  ├─ Shared drive / S3 bucket
  └─ Email attachment

Team member receives .ttl → imports into Reckons.AI → diff + review
```

### Advantages

- **Portable**: Standard W3C format — works with any RDF tool
- **Diffable**: `git diff` shows meaningful changes
- **Offline**: No network required to read or write
- **Auditable**: Every file is a complete snapshot with provenance

### Merge Workflow

When team members contribute changes:

1. Each member exports their KB as `.ttl`
2. Changes are submitted via n8n sync hub or git PR
3. Reviewer imports the diff, sees new/reinforcing/conflicting triples
4. Accepted changes merge into the canonical KB
5. Updated canonical `.ttl` is redistributed

## Policy as Graph Entities

Compliance constraints, legal requirements, and cultural norms are modelled
as first-class entities in the knowledge graph:

```turtle
:gdpr-data-retention a :Policy ;
    :applies-to :customer-data ;
    :requires "Delete personal data after 36 months" ;
    :source :legal-review-2026 ;
    :effective-date "2026-01-01"^^xsd:date .

:deploy-procedure :governed-by :gdpr-data-retention .
```

Benefits:
- Policies travel with the knowledge they govern
- Temporal bounds — policies expire and are superseded
- Provenance — every policy traces to its source (legal review, board decision)
- Queryable — "what policies apply to customer data?"

## Procedure Depth

Procedures are graphs of steps, decisions, and outcomes:

```turtle
:deploy-procedure a :Procedure ;
    :has-step :step-1-build ;
    :has-step :step-2-test ;
    :has-step :step-3-review ;
    :has-step :step-4-deploy .

:step-2-test :requires :step-1-build ;
    :has-decision :tests-pass ;
    :on-failure :rollback-procedure .

:step-3-review :requires :step-2-test ;
    :assigned-to :sre-team ;
    :sla "4 hours" .
```

This enables:
- **Process graphs** — visualise workflows in the 3D graph
- **Gap analysis** — "which procedures lack a review step?"
- **Compliance mapping** — link procedures to governing policies
- **Reckoning** — "given this situation, what procedure applies?"

## Implementation Phases

### Phase 1: Graph-Native RBAC
- Define role/permission vocabulary as RDF predicates
- RBAC evaluation engine (client-side, reads permission triples)
- Admin UI for role assignment
- Audit trail logging

### Phase 2: BYOA Auth Gateway
- OIDC token validation middleware
- Identity → role mapping from graph
- API key generation for machine access
- n8n sync hub auth integration

### Phase 3: Policy & Procedure Modelling
- Policy entity type with temporal bounds
- Procedure entity type with step ordering
- "Governed by" relationship support in diff/review
- Reckoning aware of policy constraints

### Phase 4: Team Workflows
- Shared KB registry (n8n data tables)
- Merge request workflow (propose → review → accept)
- Conflict resolution with multi-reviewer support
- Activity feed / notification via n8n webhooks

## Pricing Model

| Tier | Description |
|------|-------------|
| **Core** | Free forever. Personal use, all features, unlimited KBs |
| **Cloud Sync** | Self-hosted n8n — user provides infrastructure |
| **Enterprise** | RBAC, BYOA auth, policy/procedure modelling, team workflows, support |

Enterprise pricing is per-organisation, not per-seat. The `.ttl` file format
ensures no vendor lock-in — if you leave, your knowledge leaves with you.
