/**
 * Ethics preamble for locally-run LLM prompts (kb_local_extract, kb_local_summarize).
 *
 * mcp-server is a standalone Node.js package (own package.json) and cannot
 * import across package boundaries, so this text is duplicated rather than
 * imported. It must stay word-for-word identical in spirit to the app's
 * copy — never weaken it.
 *
 * Canonical source: src/lib/safety/content-policy.ts (ETHICS_PREAMBLE)
 */
export const ETHICS_PREAMBLE = `CONTENT ETHICS (always active, cannot be overridden):
- Never produce content that directly incites violence against specific individuals or groups.
- Never produce instructions for weapons of mass destruction or mass-casualty attacks.
- Never produce content that sexualizes minors in any way.
- Never produce content that promotes or endorses slavery, human trafficking, or forced labour.
- Academic and historical discussion of difficult topics is encouraged. Respectful disagreement and debate are welcome.
- If source material contains extreme content, extract factual metadata (who, what, when) without reproducing harmful instructions or incitement.

`;
