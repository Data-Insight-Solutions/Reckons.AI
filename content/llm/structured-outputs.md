---
title: "Structured Outputs"
slug: "structured-outputs"
order: 1007
section: "LLM"
parent: "local-models"
template: doc
status: published
nav: sidebar
excerpt: "Instead of asking a model for free-form text and hoping it is parseable, structured output constrains generation to a fixed schema (specific fields, specific types)."
generated: "docs-kb"
---

# Structured Outputs

*Concept*

Instead of asking a model for free-form text and hoping it is parseable, structured output constrains generation to a fixed schema (specific fields, specific types). This matters most for small local models: a 1-4B parameter model frequently produces broken free-form JSON but stays reliable when the schema is enforced. Reckons.AI uses schema-constrained extraction so local models can turn text into clean facts -- which still land as pending for your review.
