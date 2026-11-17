# webhooks-outbox: answers to the design's open questions

- **Q1: accepted.** Limit Requirement 5.10 to valid rail histories (each payment has at most one capture and its
  refunds sum to no more than the capture). Duplicates, any interleaving across payments, refunds that arrive
  before their capture, `pending` events and unknown event types stay in the property's domain. Invalid histories
  keep the defined behavior of Requirements 5.4 and 5.8 and get example-based unit tests. Add one sentence to
  Requirement 5.10 restricting the domain.
- **Q2: accepted.** Count an outbox attempt when the message is claimed, in the claim transaction. A message claimed
  with attempts already at the maximum moves to `dead` instead of being sent. Update Requirements 9.5, 9.6 and 9.9
  to match.
- **Q3: accepted.** Headers `ossuary-timestamp` and `ossuary-signature`, case-insensitive lookup, 64 lowercase hex.

Please update requirements.md and design.md to reflect Q1 and Q2, then write tasks.md. Required property tests must
stay required, and each must be shown to fail against a deliberate break before its task is marked done.
Use at least 25 runs per property in the default run (not 8), and keep the full run under 120 seconds.
