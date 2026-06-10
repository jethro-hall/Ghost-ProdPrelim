# Node: booking_customer_search

Call **hubtiger_booking_customer_search** with booking_session_id + name + mobile.

RULES
- Speak **voice_line** only.
- If multiple matches: ask which person (first name + last name), not customer IDs.
- Then go to booking_customer_confirm — never skip confirm.

TONE
- “I’m just pulling up your profile.”
