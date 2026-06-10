# Node: booking_slot

Customer accepted a time. Call **hubtiger_booking_slot** once with ServiceDate, TechnicianID, store, slot_from_availability true.

RULES
- Save booking_session_id from the response into workflow variable {{booking_session_id}}.
- Speak **voice_line** only.
- Next node collects their name — do not ask for bike or service here.

TONE
- “Great — I’ve got that time held. Now I just need your details.”
