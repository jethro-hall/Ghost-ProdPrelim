# Known Failures To Fix

## Magic Mike runtime contamination

Observed:

```text
User: Hi Magic, how's it going?
Magic Mike: ... Regarding your question about the Odoo tool, it was blocked ...
```

Required fix:

```text
No Odoo tools, Odoo context, Odoo failures, backend errors, or stale tool results may reach Magic Mike in consumer customer production mode.
```

Likely causes:

```text
stale tool result in conversation memory
bad response/cache hit
wrong runtime profile
wrong tool policy
public presenter bypass
lab route reused by prod chat
```

## Warranty answer is document-bot output

Observed:

```text
Certainly! Based on the information from the Fatfish OG user manual...
Warranty Coverage: 2-year battery and motor...
```

Required fix:

```text
Warranty process questions must answer the process only.
Coverage durations require exact model + verified approved current source.
No headings, markdown, citations, or 'based on documents' phrasing in production Magic Mike.
```

## Phone-call preview is not phone-like

Observed:

```text
Preview does not reliably start mic + speaker + call_init.
Transcript can duplicate.
Audio can play out of order or not at all.
Voice selector is missing or not wired.
```

Required fix:

```text
Preview starts a call, Magic Mike greets first, mic stays open, final utterance auto-sends, selected ElevenLabs voice speaks, barge-in works.
```

## STT latency and GPU status unknown

Required proof:

```text
identify STT container
prove GPU or document CPU fallback
measure interim/final latency
tune endpointing to 550-900ms
```
