# Approval And Truth Grounding Spec

## Source Hierarchy

1. explicit Odoo tool evidence
2. uploaded documents and indexed knowledge
3. approved web research from allowed sources
4. user-provided facts in the live conversation
5. LLM synthesis

Higher layers may summarize lower layers, but lower layers outrank upper layers when conflicts appear.

## Approval Rule

Strategist outputs do not enter the document frame until the user explicitly approves them.

## Document Promotion Rule

Only approved fragments may be promoted into the `document_frame`.

## Traceability Rule

Major document claims should remain explainable from:

- approved strategist outputs
- uploaded or indexed documents
- approved web research
- Odoo evidence

## Anti-Patterns

- smooth prose with no source discipline
- unapproved fragments entering the document
- documenter inventing certainty from tentative notes
- treating ERP output as decorative rather than authoritative