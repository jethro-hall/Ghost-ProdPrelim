# CURSOR CHAT APP BUILD AGENT

## Purpose

Build a **browser-delivered chat application** for **desktop and handheld/mobile devices** using a modern, fast, maintainable stack and a serious commercial standard.

This file is intended to be dropped into a repo and used directly by a Cursor agent as the operating brief.

---

## Status

This is **not the application itself**.  
This is the **build brief and execution contract** for the agent that will build it.

The previously created ZIP files were **ChatGPT Skills**, not a runnable app and not a Cursor-native project setup.

This file is the practical version for Cursor.

---

## Primary Objective

Design and build a **rich interactive browser chat application** that is:

- sharp
- commercially credible
- fast
- modular
- easy to modify
- easy to extend
- clean on desktop
- clean on mobile/handheld browsers
- compatible with major LLM APIs
- compatible with ElevenLabs

The product should feel familiar to users of:

- ChatGPT
- Gemini
- OpenWebUI

Do **not** clone these products blindly. Use them as interaction and UX quality benchmarks.

---

## Primary Reference

Use this existing demo UI as the primary starting point and reference baseline:

`https://ghoststack.rideai.com.au/ghost_chatui`

Also use the following products as comparative references for interaction quality:

- ChatGPT
- Gemini
- OpenWebUI

---

## Mandatory Product Standard

This must be treated as a **serious commercial chat product**, not a toy chat interface.

A valid result is **not** just:

- a message list
- a textarea
- a send button

A valid result **must** behave like a rich modern chat application.

---

## What “Rich Interactive Chat Application” Means

The application should properly consider and support, where appropriate:

- streaming assistant responses
- robust message composer behavior
- responsive desktop/mobile layouts
- conversation/thread management
- loading states
- empty states
- error states
- retry/regenerate flows
- message actions
- scroll anchoring and long-thread behavior
- typing/generation states
- clean interaction transitions
- clean model/provider switching paths if included
- future extensibility without ripping apart the codebase

Anything materially below this standard is inadequate.

---

## Build + Review Requirement

This project must support both modes of work:

1. **Builder mode**
2. **Reviewer mode**

### Builder mode
The agent must be able to:

- turn demo URLs, screenshots, feature requests, and design references into implementation work
- propose and implement a suitable architecture
- define component boundaries
- build a lean modular chat engine
- align UI intent with real code structure
- optimize for maintainability and speed
- keep the system compatible with large LLM APIs and ElevenLabs

### Reviewer mode
The agent must be able to:

- review existing UI and implementation critically
- identify usability gaps
- identify functional gaps
- identify interaction/state gaps
- match UI claims to actual code
- flag weak architecture, misleading UI, missing states, and incomplete behavior
- enforce strict human validation before signoff

---

## Input Types the Agent Must Be Ready To Use

The build process may start from any mix of:

- demo URLs
- screenshots
- reference apps/sites
- feature requests
- partial code
- existing codebase
- refactor requests
- architecture requests
- design directions

If something is missing, state the assumption explicitly and proceed sensibly.

Do not stall on minor ambiguity.

---

## Default Technical Recommendation

Unless the repo already has a strong and justified alternative, prefer:

- **React**
- **TypeScript**
- **Next.js**
- **Tailwind CSS**
- clean modular component boundaries
- provider-agnostic service layer for LLM APIs and ElevenLabs
- architecture that remains easy to update and extend

Reasons:

- fast iteration
- good maintainability
- strong component reuse
- strong responsive UI development
- straightforward integration patterns
- good fit for modern browser chat apps

Avoid exotic or needlessly clever stack choices unless they are clearly superior for this job.

---

## Architecture Rules

The application should be structured as a **lean, fast, efficient modular chat engine** presented in a polished UI.

Prioritize:

- separation of UI, state, and provider integrations
- reusable components
- scalable conversation rendering
- minimal unnecessary re-renders
- explicit state flow
- clean provider abstraction
- maintainable feature boundaries
- future extensibility

Avoid:

- monolithic front-end files
- messy UI-state coupling
- hidden global side effects
- slow rendering patterns
- architecture that becomes painful to edit

---

## UI / UX Principles

The application must feel:

- smart
- sharp
- business-consumer oriented
- feature rich
- fast
- polished
- confident
- commercially deployable

The application must **not** feel:

- amateur
- gimmicky
- visually confused
- laggy
- bloated
- prototype-like

The visual and interaction model should make transition easy for users coming from ChatGPT and Gemini.

---

## Code-to-UI Alignment Rules

The build must match **UI to code reality**.

That means:

- do not propose UI patterns that are awkward or brittle to implement
- do not claim interaction quality without supporting code structure
- ensure component design aligns with actual behavior
- ensure architecture supports the UX being promised
- flag mismatches between visual intent and real implementation

If UI and code disagree, fix the code or change the UI expectation. Do not hand-wave it.

---

## Human Testing Is Mandatory

No feature is considered done unless it is **manually tested by a human**.

### Hard rule
Every function, button, feature, state, and meaningful interaction must be manually tested.

This includes, at minimum:

- every button
- every icon action
- every menu
- every modal
- every drawer
- every settings control
- every send path
- every retry/regenerate path
- every message action
- every loading state
- every empty state
- every error state
- every conversation/thread path
- every mobile-specific interaction
- every desktop-specific interaction
- every responsive breakpoint behavior
- every reconnect/recovery path

### Explicit testing rule
Screenshots, code inspection, assumptions, and “it looks fine” are **not** substitutes for real manual testing.

If something is untested, mark it **untested**.

Do not imply verification that did not happen.

---

## Review Standard

Reviews must be concrete and hard-nosed.

They must explicitly call out:

- what passes
- what fails
- what is incomplete
- what is missing
- what is visually weak
- what is functionally misleading
- what is bloated
- what is slow
- what is not validated by manual testing

Avoid vague praise.

---

## Build Standard

Build output must be practical and implementation-oriented.

It should produce useful artifacts such as:

- architecture plan
- directory structure
- component model
- responsive layout strategy
- provider integration approach
- interaction/state model
- performance considerations
- testing matrix
- implementation sequence
- known risks and assumptions

---

## Cursor Execution Rules

When working in Cursor, the agent must:

1. Inspect the current repo structure first.
2. Identify whether this is:
   - greenfield build
   - partial implementation
   - UI refactor
   - architecture cleanup
3. Propose the best-fit architecture if the current one is weak.
4. Prefer incremental, reviewable changes.
5. Keep files modular and readable.
6. Avoid giant all-in-one files when component/module separation is justified.
7. Preserve or improve performance with every major UI change.
8. Keep styling coherent and maintainable.
9. Build mobile and desktop intentionally, not as an afterthought.
10. Produce a clear manual testing checklist for each completed feature.

---

## Expected First-Pass Output From The Agent

For the first serious pass, the agent should return:

1. Executive summary
2. What the product is trying to be
3. Assessment of the current ghost_chatui direction
4. Desktop UX strategy
5. Mobile UX strategy
6. Recommended stack and rationale
7. Proposed architecture
8. Proposed module/component structure
9. UI-to-code alignment notes
10. Performance and maintainability considerations
11. Gaps and risks
12. A staged build plan
13. A mandatory manual testing matrix

---

## Suggested Project Shape

If starting from scratch, a sensible default shape is:

- `app/` or `src/app/` for routes/pages
- `components/chat/` for chat-specific UI
- `components/shared/` for shared controls
- `lib/providers/` for LLM and voice adapters
- `lib/state/` for state logic
- `lib/types/` for shared types
- `lib/utils/` for utilities
- `styles/` for global styling concerns
- `docs/` for architecture and testing notes

Use a structure in this class, not necessarily this exact one.

---

## Provider Compatibility Expectations

The architecture should not hard-wire itself to one provider.

It should support clean integration patterns for:

- OpenAI-compatible LLM APIs
- other major LLM APIs
- ElevenLabs

Provider integrations should be abstracted cleanly enough that changing backends is not painful.

---

## Non-Negotiables

- browser delivered
- desktop and handheld/mobile support
- rich interactive chat application standard
- fast and modular implementation
- easy to modify and update
- compatible with large LLM APIs
- compatible with ElevenLabs
- strong UI/code alignment
- strict human testing of every function, button, and feature
- benchmark quality against ChatGPT/Gemini-class interaction standards
- use `ghost_chatui` as a primary reference point

---

## Working Style To Follow

Operate with the following style:

- direct
- commercially realistic
- delivery-focused
- skeptical of untested claims
- critical when the UI or architecture is weak
- performance-aware
- maintainability-aware
- respectful of the existing design direction, but willing to improve it

---

## Final Instruction To The Agent

Treat this as a serious commercial chat product.

Do not confuse visual polish with product quality.  
Do not confuse code presence with working UX.  
Do not confuse partial testing with validation.  

Build toward a **beautiful, fast, modular, browser-based chat application** that feels credible beside modern market leaders and stands up under real human use.
