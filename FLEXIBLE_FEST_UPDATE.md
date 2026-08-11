# Flexible Fest Update — Completion Status

## Completed flexible workflows

- Central Master Setup presets and capability engine.
- Dedicated Admin Participants tab with direct add/edit/delete/search/filter for parents, staff, alumni, public and guest participants.
- Parent-to-student linkage with automatic child-team inheritance in Admin and public registration.
- Advanced per-event controls for participant types, registration channels, result method, schedule requirement, team policy and score contribution.
- Global and per-event direct/judged result selection.
- Dedicated Basic Program Order editor with ordering controls, persistence and Public/Team rendering without date/time/stage.
- Master gender options propagated to core forms, Admin secondary filters, Team filters, Publisher filters and gender-specific chest setup.
- Public group registration builder with member validation and Admin approval into group participant entries.
- Per-event team-score contribution applied to Public Home, Results, Team Portal and TV totals.
- Generalized participant identity/team adapters in Publishing, Results, Public Home and TV.
- Team Setup colours and accessible public ranking badge colours.
- Schedule/judgement/public-registration feature gating.

## Still required outside repository-only implementation

1. Deploy the updated `firestore.rules` to the target Firebase project.
2. Run Firebase Emulator and real-browser E2E scenarios for every preset and denial path.
3. Enable Firebase App Check/CAPTCHA and server-side rate limiting before exposing anonymous open registration on an unrestricted public domain.
4. Configure production monitoring/backups and verify required Firestore indexes from real traffic.

No requested functional item from the eight-item completion list is intentionally left as a placeholder; the remaining work above is deployment, abuse protection and environment validation.

## Poster & Certificate control centre (2026-08-02)

The Admin Poster & Certificate workspace now uses an eight-part workflow: Overview, Templates, Design Editor, Availability, Public Downloads, Portal Downloads, Bulk Generate and Settings. Templates are selected through document-group and template dropdowns, so the editor only previews the chosen fixed background.

Models support draft, published and archived lifecycle states. Page availability is stored both in the structured `availability` map and the legacy-compatible `downloadAccess` map. Public and role portals only render published models allowed for that destination. Applicability can be limited by position, event, category and participant type, while output format, quality and file-name pattern are configurable per model.

Before production deployment, place the ten organisation-approved PNG backgrounds listed in `assets/templates/README.md` in that directory and deploy the updated Firestore rules together with the web application.

## Advanced student registration portal (2026-08-02)

Student registration is now a verified application workflow rather than direct final entry. Students search within a selected team and gender, verify the exact chest number through callable Cloud Functions, receive a short-lived portal session, see only eligible events, submit one immutable application per event with an optional short note and HTTPS references, and track application status without a self-withdraw action.

Admin controls the global open/unfilled/waitlist/closed policy. Team Leaders can independently pause their team, review applications, select within the current event limit, remove applicants and transactionally finalize selected students. Event cards expose available, full and red overloaded states; lowering an Admin limit never deletes existing selections, but disables additions/finalization until the leader removes the excess.

## Generalized registration portal and timeline (2026-08-02)

The public surface is now named Festival Registration. Its participant-type selector is generated from the participant types enabled in Master Setup, with student directory/chest verification and adaptive manual or directory-backed identity flows for parent, staff, alumni, public and custom types. Candidate search has explicit prerequisites, callable search and a public-readable directory fallback so suggestions remain usable while deployment errors are shown rather than silently producing an empty list. Event eligibility uses the selected participant type, gender, category, class, team policy and self-registration channel.

The hamburger is an accessible overlay popover consistent with the role portals. Admin Registrations is split into Overview, filterable Applications, Team Finalization, Final Entries and Registration Policy. The policy timeline separates application open/close, Team Leader selection deadline and final-registration lock; Team Leader selection and finalization actions enforce the corresponding deadlines.

## Registration verification transition (2026-08-02)

Chest verification now uses a dedicated Verify action. Incorrect values return a direct chest-number error without exposing Firebase/internal status text. Successful verification displays the configured festival logo and a short accessible Initializing → Verifying → Updating transition before opening the portal; the animation targets a 2.4-second minimum while never hiding real network latency.

## Chest-code compatibility and deployment fallback (2026-08-02)

Chest verification treats the saved chest value as an exact trimmed string, so `7`, `42`, `105`, `A7`, `ab12` and case-sensitive mixed codes are all valid. The browser uses a true text input rather than a numeric keypad restriction. If the generalized callable is not yet deployed but the preceding student verification callable exists, Student registration automatically uses that compatible endpoint and portal instead of surfacing an internal transport error.

## Registration diagnostics, participant selection and public schedule (2026-08-02)

The chest helper is reduced to “Enter it exactly as issued.” Student verification sends the password-style chest value directly to the secure callable, avoiding a browser-side Firestore permission dependency. Transport failures display a deployment-oriented reference instead of a generic details error, and the secure callable remains the sole verification authority.

## GitHub Pages registration deployment

GitHub Pages publishes only the static HTML and JavaScript. It does **not** deploy the callable backend in `functions/index.js`. Student verification and registration applications therefore require a separate Firebase Functions deployment whenever that file changes:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

An on-screen `functions/internal` result means that Firebase received the request but the deployed backend failed; it is not a chest-number mismatch. Inspect the server exception with `firebase functions:log --only verifyRegistrationIdentity,verifyStudentRegistration`. The current functions retry verification-session writes and return a specific `functions/unavailable` session-write error if the Cloud Functions service account cannot write Firestore, instead of collapsing that condition into a generic internal error.

For static GitHub Pages deployments where both the current and legacy callables are unavailable, Student verification now has a compatibility path using the already public student directory: it compares the selected record's exact chest value and identity in the browser, opens a short local portal session without storing the chest value, and submits event choices to the security-rule-validated `registrationRequests` queue. Admin approval links those requests back to the existing student ID and writes `studentIds` rather than creating a duplicate participant. The callable path remains preferred whenever Firebase Functions is healthy.

Master Setup now prevents silently leaving Participant Types empty, explains how to disable Student by enabling another type first, and validates the raw checkbox selection before normalization can restore a default. The public Registration page listens to `settings/registration_config` before verification, shows open/upcoming/closed timestamps, and disables new identity submissions outside the configured application window.

## Registration portal completion (2026-08-03)

The application note helper, placeholder, counter and server validation now share the Admin-configured character limit. The event popup uses a viewport-bounded scroll body and fixed action footer, renders Rules and criterion/mark rows, and accepts one Base64 image that is resized and iteratively WebP-compressed to at most 300 KB before the server validates its decoded size. My Applications provides a read-only full-detail viewer, Profile uses a branded verified ID card, portal identity chrome uses chest/category instead of the student name, and success feedback expires automatically.

Registration Policy now includes independent Unlimited/Custom maximums for Off-Stage, On-Stage, Single, Group, General and unique Total participation. General can be excluded from Total while continuing to count in its stage/type dimensions. The portal explains usage on entry and disables over-limit events; both callable submission and static-fallback Admin approval revalidate the limits against active applications and final entries.

Each participation dimension now has a Show & Enforce switch; disabled dimensions disappear from both the entry explanation and the new Registration Dashboard and are excluded from decisions. Dashboard summaries, recent applications and usage remain available after the initial “I Understand” dialog. Eligible Events no longer repeats a student identity banner, while My Applications uses a one/two/three-column responsive card grid with event metadata, team counts, read-only media detail, link previews and an image lightbox.

Admin Applications is a filterable detail table with event-category filtering, compact media/description cells, a full detail overlay and icon decisions. Team Portal now has a dedicated Self Registration workspace before Events; the former Events application panel was moved there, callable applications and team-scoped fallback requests are unified, and Team Leaders can make scoped decisions while Admin retains global access. Full-event behavior is explicit—waitlist, visible locked, or hidden—so Global Open no longer ambiguously depends on several unlabeled flags.

Registration Downloads is a separate Admin subtab with class, team, event category, gender, A–Z/chest/time ordering and applied-time range filters. It exports a full Excel workbook and two A4 PDF models using the same loaded stack as Schedule Print—jsPDF 2.5.1, AutoTable 3.8.4 and the configured Noto Malayalam font when available. The first model is a landscape applications table; the second packs student blocks into portrait pages with identity headings, Off-Stage/On-Stage columns and clickable YouTube/Website labels. Both models support iframe preview, download, print, page numbering and generated metadata. Final Entries also resolves chest numbers from the Student Directory, application snapshot or participant metadata so imported/legacy registrations no longer render a blank chest value.

Student chest identifiers now remain exact strings throughout admin editing, Excel import, duplicate detection, sorting, and Firestore validation. Short numeric values and case-sensitive alphanumeric values are accepted without integer coercion; automatic chest allocation remains numeric when no custom value is supplied.
