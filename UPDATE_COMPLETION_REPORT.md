# Security and operations update — completion report

## Delivered in this update

- Public Home, Results, Team and TV now query only `published` result documents.
- Firestore permits anonymous result reads only when `status == 'published'`; Admin and Publisher retain full workflow access.
- Team notifications are queried for `All` and the signed-in leader's team only, and Firestore enforces the same scope.
- Admin Dashboard includes a realtime Festival Readiness panel for pending public requests, unscheduled events, events without judges and submitted results awaiting publication.
- Root JavaScript is explicitly configured as ES modules, eliminating Node's module-type ambiguity during checks.
- Smoke and role-contract checks protect all of these contracts from regression.

## Deployment requirements

These repository changes do not alter a live Firebase project until an operator:

1. Deploys `firestore.rules`.
2. Deploys Hosting assets.
3. Confirms every existing public result has `status: "published"`. Legacy results without that field are intentionally no longer public.
4. Runs the role matrix against staging/production accounts.

## Work that still requires a separate migration

The current public experiences resolve winner names, team totals and schedule counts from `students`, `participants` and `registrations`. Those collections remain public-readable for compatibility. Removing that access safely requires a data migration to public-safe projection collections plus backfilling existing records; simply restricting the rules would break Home, Results and TV.

Recommended migration:

- Add `publicPeople`, `publicRegistrationSummary` and `publicEventResults` projections containing no phone, email, guardian or private registration fields.
- Backfill the projections before changing any rule.
- Move public pages to the projections and then restrict the source collections to authenticated scoped roles.
- Add Firebase Emulator rule tests and browser E2E tests; the repository currently has static/runtime contract checks, not a live Firebase test environment.

This migration depends on the deployed dataset and therefore cannot be truthfully marked complete by a source-only change.
