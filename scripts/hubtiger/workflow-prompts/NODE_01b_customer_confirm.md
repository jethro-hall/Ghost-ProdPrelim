# Node: booking_customer_confirm

Call **hubtiger_booking_customer_confirm** with customer_id OR create_new true.

RULES
- Wait until customer_confirmed is true in the response.
- Speak **voice_line** only.
- Do not discuss bikes until this succeeds.

TONE
- “Perfect — you’re on file. What bike or scooter is this for?”
