# Architecture Brief: Fixing Semantic Drift in Finance MAS

## Bottom Line

The system must stop answering finance questions from ledger search and start answering them from semantic metrics.

## Old pattern
`request -> ledger search -> keyword matching -> row dump -> explanation`

## New pattern
`request -> semantic intent -> metric plan -> classified evidence -> metric pack -> optional ledger support -> explanation`

## Runtime Name
Use `finance-runtime` as the governed backend service.

## Runtime Responsibilities
- load registries
- validate declarative source plans
- classify accounts
- assemble metrics
- build evidence packs
- enforce finance-only MAS path
- provide response objects to the LLM

## What the LLM should not do
- classify accounts from names
- decide what counts as marketing or cogs
- compute totals from arbitrary row dumps
- invent finance definitions

## What the LLM should do
- interpret the question
- request the correct semantic pack
- explain the result
- present supporting evidence
