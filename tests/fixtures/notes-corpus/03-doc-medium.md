# Northwind Analytics — Digital Asset Tooling Review

**Prepared by:** Jordan Vale, Northwind Analytics, LLC
**Date:** 2 September 2026
**Status:** Draft for internal discussion

## Background

Northwind Analytics is a systems integrator and technology consultant based in
Kansas City. The firm advises mid-market clients on digital asset management,
enterprise content platforms, and the integration work that connects them.

Over the last two quarters three clients have asked the same question: which
digital asset management platform should replace an ageing on-premise system.
This document records what we currently believe, so the belief can be checked.

## The platforms under consideration

Lumenpath is an enterprise CAD and asset platform. It is privately held, founded
in 2014, and headquartered in Toronto. Its differentiator is interoperability —
it exposes a documented REST API and maintains connectors for most major
automation tools. Licensing is per-seat and, for a studio of our clients' size,
we assess the terms as unfavourable.

Vantage Suite is the incumbent at two of the three clients. It is faster on large
assemblies than Lumenpath, which matters for the engineering-led accounts, but
its file format is proprietary. That is a lock-in risk and should be weighed
against the performance advantage rather than treated as a footnote.

Aprimo, Bynder and OpenText are the established enterprise DAM vendors. All three
are plausible integration targets rather than competitors to Lumenpath; they
occupy the marketing-operations layer above the asset store.

## What we do not know

We have no pricing for Vantage Suite above the 50-seat tier. We have not tested
Lumenpath's connector for our clients' automation platform, only read its
documentation. Neither gap is blocking, but both should be closed before a
recommendation is issued rather than after.

## Recommendation

No recommendation yet. The performance-versus-lock-in trade-off is genuinely
open, and the two evidence gaps above bear directly on it. We propose a two-week
evaluation running both platforms against the same asset set.

## Next actions

Schedule the evaluation with the engineering-led account. Request tiered pricing
from both vendors. Build a connector test harness against the automation
platform.
