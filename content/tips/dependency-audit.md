---
title: "Dependency Audit Process"
slug: "dependency-audit"
order: 1004
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "Three free tools in use: npm audit (known CVEs in dependency tree), GitHub Dependabot (automated PRs for vulnerable deps — enable via Settings > Security > Dependabot), and GitHub Code Scanning via CodeQL (static analysis of source code)."
generated: "docs-kb"
---

# Dependency Audit Process

*Concept*

Three free tools in use: npm audit (known CVEs in dependency tree), GitHub Dependabot (automated PRs for vulnerable deps — enable via Settings &gt; Security &gt; Dependabot), and GitHub Code Scanning via CodeQL (static analysis of source code). CI gate: npm audit --audit-level=high blocks merges on high/critical findings.
