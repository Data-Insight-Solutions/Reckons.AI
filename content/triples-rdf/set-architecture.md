---
title: "The Set"
slug: "set-architecture"
order: 25
section: "Triples & RDF"
template: doc
status: published
nav: sidebar
excerpt: "A set is a named group of things, and it is made of ordinary statements just like everything else here."
generated: "docs-kb"
related:
  - "triple-architecture"
---

# The Set

A set is a named group of things, and it is made of ordinary statements just like everything else here. Where a triple says something about ONE thing, a set says something about SEVERAL at once -- that these three vendors are the shortlist, that these five steps are the recipe. It has a name, a description and facts of its own, so you can say things about the group without saying them about each member.

<p class="derived">It has 5 parts below.</p>

## Why it is this way

**Note**

You may see the word Collection in exported files. It is the same thing under its standard name -- Reckons.AI writes sets as skos:Collection so other tools can read them.

## In this section

<details class="accordion"><summary>A set can keep your own word for membership</summary>

Most groupings already exist in your notes under a word you chose -- a project 'includes' these tasks, a menu 'offers' these dishes.

[Read more](../triples-rdf/set-membership-word)

</details>

<details class="accordion"><summary>How groups are found when you add something</summary>

When you add a note or a document, Reckons.AI looks for groups in what it just read, as a separate step after it has worked out the individual facts.

[Read more](../triples-rdf/set-in-extraction)

</details>

<details class="accordion"><summary>Membership overlaps -- it does not file things away</summary>

A thing can belong to as many sets as it really belongs to.

[Read more](../triples-rdf/set-overlap)

</details>

<details class="accordion"><summary>Order belongs to the membership, not to the member</summary>

Some sets are sequences -- the steps of a recipe, the stages of a process.

[Read more](../triples-rdf/set-order)

</details>

<details class="accordion"><summary>What a set says that triples cannot</summary>

Triples alone cannot tell the difference between a fact about a GROUP and the same fact about each of its members.

[Read more](../triples-rdf/set-vs-triple)

</details>

## Related

- [The Semantic Triple](../triples-rdf/triple-architecture)
