# Entity Structure

## Canonical entity keys

- `retail`
- `brisbane`
- `burleigh`

## Canonical business-unit labels

- `Ride Electric Retail`
- `Ride Electric Brisbane`
- `Ride Electric Burleigh`

Labels are canonicalized during normalization and assembly so case variants do not create duplicate rows.

Examples:

- `ride electric brisbane` -> `Ride Electric Brisbane`
- `Ride   Electric   Brisbane` -> `Ride Electric Brisbane`

## Centralized marketing behavior

- Marketing total source entity: `Ride Electric Retail`
- Non-retail requests return retail-based marketing total with explicit note.

## Known edge cases

- Accounts not explicitly mapped by `(entity, account_name)` are unclassified and excluded.
- If source data cannot produce required metric values, response is blocked with `metric_missing`.
