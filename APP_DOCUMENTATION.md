# Fiesta Template — Complete Application Documentation

> This is the single maintained Markdown document for the application. Older scattered `.md` notes were consolidated here so setup, architecture, operations, security, public pages, role flows, reset behavior, media policy and deployment guidance live in one place.

## 1. Application overview

Fiesta Template is a Firebase-backed, multi-role festival management web application. It is a static multi-page web app built with HTML, Tailwind CDN and vanilla JavaScript modules, with Firebase Authentication, Cloud Firestore, Cloud Storage rules and Cloud Functions for selected server-side operations.

The application supports the full festival workflow:

```text
Admin bootstrap
  -> master setup: teams, categories, scoring, public settings
  -> student/participant/event setup
  -> team registration and public/self-registration
  -> schedule and judge assignment
  -> judge scoring
  -> publisher/admin result review and publication
  -> public results, team standings, top talents and live TV display
```

## 2. Runtime pages

| File | Audience | Purpose |
| --- | --- | --- |
| `index.html` | Public | Landing page, branding, about, live counts, leaders, gallery, schedule and result links. |
| `results.html` | Public | Published result cards, team standings and top-talent rankings. |
| `register.html` | Public | Student/public registration and application workflow. |
| `login.html` | Public/auth entry | Shared username/email login for Admin, Team Leader, Judge and Publisher roles. |
| `admin.html` | Admin/Super Admin | Full operations console for setup, students, events, schedule, access, judging, publishing support, public content, TV and reset. |
| `team.html` | Team Leader | Team dashboard, event registration, self-registration decisions, schedule and reports. |
| `judge.html` | Judge | Assigned event scoring, draft save and final score submission. |
| `publish.html` | Publisher/Admin | Judge-sheet review, ready/published queues, corrections and result publication. |
| `tv.html` | Public display | Full-screen live result and media display for TV/projector screens. |
| `tv-control.html` | Operator/control surface | TV control/companion page when enabled by deployment workflow. |

Logical tabs, modals and panels inside those HTML files are not separate physical pages.

## 3. Core JavaScript modules

| File | Responsibility |
| --- | --- |
| `firebase-config.js` | Firebase app initialization and exported `app`, `auth`, `db`, `storage`, `firebaseConfig`. |
| `fest-config.js` | Master setup defaults, normalization, public module visibility, team color helpers and event/team-score rules. |
| `branding-config.js` | Shared branding, cached logo/name handling and Base64 image application. |
| `dependency-loader.js` | Optional browser dependency checks/fallback loading for admin tools. |
| `image-upload.js` | Base64 image validation, compression/preview wiring and upload UI helpers. |
| `event-utils.js` | Event validation and normalization helpers. |
| `registration-utils.js` | Registration and capacity policy helpers. |
| `score-utils.js` | Scoring rules, grading, ranking, judge-score conversion and team ledger helpers. |
| `public-data-utils.js` | Lightweight public Firestore REST field selection and public media stripping. |
| `poster-certificate-engine.js` | Poster/certificate template normalization, sizing and rendering. |
| `poster-certificate-admin.js` | Admin editor interactions for poster/certificate templates. |
| `admin-*.js` | Admin authentication, dashboard, students, events, utilities and main console orchestration. |
| `judge.js` | Judge portal data loading, scoring workspace, draft/submit flow and validation. |
| `login.js` | Shared login routing, username/email resolution and role destination handling. |
| `functions/index.js` | Firebase callable/server operations including registration verification and factory reset support. |

## 4. Firebase collections and documents

The app creates many records from the UI, but production bootstrap and operations depend on these main paths:

| Path | Purpose | Main writers |
| --- | --- | --- |
| `adminUsers/{uid}` | Admin/Super Admin role gate. | Firebase Console/bootstrap, Admin. |
| `adminUsernames/{username}` | Optional admin username-to-email mapping. | Bootstrap/Admin. |
| `accessUsers/{uid}` | Canonical non-public role profiles for team leaders, judges, publishers and extra admins. | Admin Access Management. |
| `accessUsernames/{username}` | Username/email mapping for shared login. | Admin Access Management. |
| `teamLeaders/{uid}` | Public team leader display mirror. | Admin Access Management. |
| `judges/{uid}` | Judge profile mirror for assignments/legacy views. | Admin Access Management. |
| `settings/general` | Teams, categories, colors, display names, chest config and `festSetup`. | Admin. |
| `settings/home_config` | Public landing page content and branding. | Admin. |
| `settings/public_config` | Public results/content/footer controls. | Admin. |
| `settings/scoring_rules` | Position points, grades, tie policy and scoring options. | Admin. |
| `settings/tv_config` | Live TV title, ticker, media and timing settings. | Admin. |
| `settings/registration_config` | Public registration behavior and editing policy. | Admin. |
| `students/{id}` | Student directory records and optional photos. | Admin/approved registration flows. |
| `participants/{id}` | Non-student participant records. | Admin/approved registration flows. |
| `events/{id}` | Program/event records, eligibility, scoring, schedule fields and cancellation state. | Admin. |
| `registrations/{id}` | Team/final event entries. | Team Leader/Admin/approved application flow. |
| `registrationRequests/{id}` | Public/team scoped registration requests. | Public/Team/Admin. |
| `registrationApplications/{id}` | Advanced self/public registration applications. | Public/Team/Admin. |
| `judgeAssignments/{id}` | Judge-to-event assignments. | Admin. |
| `judgeScores/{id}` | Judge draft/submitted score sheets. | Judge/Admin. |
| `publicJudgingStatuses/{id}` | Public schedule completion markers. | Judge/Admin sync. |
| `results/{eventId}` | Ready/published/archived result documents. | Publisher/Admin. |
| `teamScoreLedgers/{eventId}` | Team score ledger snapshots. | Publisher/Admin. |
| `notifications/{id}` | Team/public notifications. | Admin/Publisher. |
| `posterCertificateModels/{id}` | Poster and certificate templates. | Admin. |
| `scheduleBreaks/{id}` / `scheduleVersions/{id}` | Schedule breaks and saved printable versions. | Admin. |
| `auditLogs/{id}` / `deletedBackups/{id}` | Destructive-operation metadata and best-effort backups. | Admin/reset flows. |

## 5. Role model and login routing

All role logins start from `login.html`.

1. The login form accepts username or email.
2. `accessUsernames` / `adminUsernames` resolves a username to a Firebase Auth email.
3. Firebase Auth signs in with email/password.
4. The app validates an active role document.
5. The user is redirected to the canonical page:
   - `admin` / `superAdmin` -> `admin.html`
   - `teamLeader` -> `team.html`
   - `judge` -> `judge.html`
   - `publisher` -> `publish.html`

Every protected page validates the Firebase Auth user and role document again. Firestore Rules are the final authorization boundary for writes.

## 6. Admin setup and bootstrap

### 6.1 First admin user

The first admin cannot be created by the app before an admin exists. Create it manually:

1. Open Firebase Console -> Authentication -> Users.
2. Add an email/password user.
3. Copy the generated UID.
4. Create `adminUsers/{uid}` in Firestore:

```json
{
  "email": "admin@example.com",
  "username": "admin",
  "displayName": "Fest Admin",
  "role": "admin",
  "active": true,
  "createdAt": "server timestamp"
}
```

Optional username login mapping:

```json
// adminUsernames/admin
{
  "email": "admin@example.com",
  "uid": "firebase-auth-uid",
  "active": true
}
```

Deploy Firestore rules after the bootstrap role document exists.

### 6.2 Access Management

Admin Access Management creates Firebase Auth users for team leaders, judges, publishers and additional admins. Password hashes are not stored in Firestore. If the admin enters only a username, the generated local Auth email format is usually `username@fest.local`; if an email is entered, that email is used directly.

Profile image URLs are stored as `photoUrl` and mirrored where needed for team leader/judge public or role displays.

## 7. Admin Console workspaces

| Workspace | Purpose |
| --- | --- |
| Dashboard | Totals, readiness checks and quick operational status. |
| Registrations | View/manage team registrations and registration lock state. |
| Students | Single/bulk student creation, edit/delete, chest identifiers and photos. |
| Participants | Non-student participant directory where enabled. |
| Events | Program creation/import/edit/delete, eligibility, type, stage, gender and scoring metadata. |
| Schedule | Time schedule, stages, breaks, conflicts and schedule versions/printing. |
| Judge / Judgement | Judge assignments, submitted sheets, review/reopen workflow. |
| Publishing support | Direct links and status support for result publication. |
| Access Management | Role users, activation, deactivation, team/gender/judge/publisher scope. |
| Scoring Settings | Single/group points, grade rules, tie policy and result method controls. |
| Public Page Control | Landing/results labels, gallery, social links, public modules and footer text. |
| Poster & Certificate | Template library, field geometry, publish/archive and download access. |
| TV Display Settings | Live TV title, ticker, background, media playlist and timing controls. |
| Master Setup | Festival-wide mode, participant types, registration channels and feature switches. |
| Data Reset | Scoped resets, team resets and factory reset. |

## 8. Public Home and Results behavior

### 8.1 Public Home (`index.html`)

The landing page renders branding, about text, optional gallery, leaders, schedule and quick links based on `settings/home_config`, `settings/public_config` and `settings/general`. It keeps public configuration, events, schedule status, registrations and published results live through Firestore listeners.

To reduce bandwidth, public people summaries are loaded through `public-data-utils.js` field-selected REST queries instead of downloading every full student/participant document with media.

### 8.2 Public Results (`results.html`)

The public results page has three main bottom-navigation tabs:

1. **Results** — published event result cards.
2. **Team** — team standings, breakdowns and timeline.
3. **Talent** — individual top performer rankings.

Result visibility is based on published result data; unpublished/archived/non-public results must not appear. The Results tab:

- renders the first 15 matching results by default;
- loads more as the visitor scrolls or presses the load-more button;
- resets pagination on search, category filter or audience changes;
- resolves winner names from public summary data, registration metadata and visible-result on-demand hydration;
- avoids rendering large Base64 person photos on public result cards;
- sorts by normalized timestamp/published time.

Category filters are generated from available result categories and use encoded values so special characters in category names do not break filtering.

## 9. Team Leader portal

Team leaders are scoped by their active `accessUsers/{uid}` profile. The portal provides:

- team dashboard and point summary;
- available event search/filter;
- registration add/edit/delete until lock time;
- self-registration/public application review where enabled;
- team-specific schedule and participant drill-down;
- participation reports and PDF/CSV export.

Rules and UI both enforce team scope, gender scope where configured, and lock-time behavior.

## 10. Judge workflow

Judges see only assignments for their active profile. The judge flow is:

1. Open assigned event.
2. Load scoped event registrations and participants.
3. Enter marks/evaluation/notes.
4. Save draft when needed.
5. Review and submit.
6. Submitted sheets are locked unless Admin reopens with a reason.

The judge code uses validation, participant signatures, transactions and stale-version detection to reduce accidental overwrites.

## 11. Publisher workflow

Publisher/Admin publication flow:

1. Review submitted judge sheets.
2. Import/verify outcome.
3. Save as ready or publish.
4. Write `results`, update judge score status, create audit metadata, generate team score ledger and notifications in a batch.
5. Reopen/correct/withdraw through explicit workflows rather than hard-deleting public history.

Public Home, Public Results and TV read published results only.

## 12. Scoring model

Scoring is controlled by `settings/scoring_rules` plus event-level overrides. Supported concepts include:

- single and group event configs;
- configurable position labels/points;
- grades and grade point values;
- tie policies and shared points;
- direct rank, criteria, objective, time, count and elimination-style judging modes;
- team contribution controls such as default, individual-only and display-only behavior.

`score-utils.js` contains the central contract for ranking marks, grade calculation, judge-score conversion and team ledger construction.

## 13. Registration system

The app supports admin-entered students, team-managed final registrations, public/self-registration requests and advanced applications. Important behaviors:

- chest identifiers are strings and should not be coerced to numbers;
- participation limits and overload state are controlled by registration policy helpers;
- application media is validated and size-limited;
- team leaders can make scoped decisions where the workflow allows;
- admin retains global review and import/export capabilities.

## 14. Media and upload policy

Image controls use local file selection and Base64 data URLs where the app stores images in Firestore. JPG, PNG, WebP and GIF are supported where configured. Image controls validate size/type before conversion and expose previews/remove actions.

Common image usage:

- fest logo;
- public gallery;
- Next Program backgrounds;
- TV background/slides;
- access profile photos;
- optional student photos;
- poster/certificate model assets where applicable.

Video fields are not converted to Base64. Direct video URLs, YouTube URLs, Shorts URLs, live URLs and supported Google Drive/direct sources are normalized by the relevant UI.

Public pages should not download large person image blobs for normal result browsing; public result avatars use lightweight placeholders unless a specific download/template workflow needs more detail.

## 15. Poster and certificate templates

The Admin Poster & Certificate editor stores template geometry and style metadata in Firestore. Fixed approved background assets belong under `assets/templates/` using these names when the deployment uses the built-in backgrounds:

```text
rslt.png, fst.png, scd.png, trd.png, cert.png,
lead-id.png, jdg-id.png, team-id.png, gst-id.png, vol-id.png
```

Template models can be saved as draft, published, unpublished or archived. Download access can be scoped for admin, judge, publisher, team/public result surfaces depending on template settings.

## 16. TV display

`tv.html` subscribes to TV configuration, published results and related display data. It supports:

- title and ticker;
- announcements;
- result queue and sequential reveal scenes;
- leaderboard/team score animation;
- photo/video playlist rotation;
- direct video and YouTube/Shorts embeds;
- toggles for results, leaderboard, announcements and media.

The current queue is local to each open TV browser. Multi-device durable queueing, remote pause/replay, heartbeat and per-display profiles would require additional authenticated device collections.

## 17. Security notes

The app should remain readable HTML/JS and should not ship obfuscated HTML blobs, hidden iframe loaders, `document.write` routers or encoded app shells. Firebase Hosting headers include no-cache, nosniff, strict referrer policy, CSP and a restrictive permissions policy.

Important security contracts:

- Admin pages require active `adminUsers/{uid}` with `admin` or `superAdmin`.
- Non-admin pages require active `accessUsers/{uid}` role profiles.
- Public result reads should expose published results only.
- Notification creation is restricted to Admin/Publisher workflows.
- Team/Judge writes are scoped by role ownership in Firestore Rules.
- Destructive operations require explicit confirmation and are logged/backed up where possible.

## 18. Data reset contract

### Clear Specific Data

Admin Data Reset exposes explicit scopes for people, programs, registration, results, schedules, judging, notifications, non-admin access, configuration, audit logs and deletion backups. Specific operational resets create best-effort `deletedBackups` and `auditLogs` entries.

### Team Reset

Team reset clears matching students, registrations, notifications, generalized participants, public registration requests, team leader mirrors, access profiles and username mappings. It requires the exact team name.

### Factory Reset

Factory Reset requires the exact phrase `DELETE EVERYTHING` and the authenticated admin email. The preferred path calls the deployed `completeFactoryReset` Cloud Function. The function validates Admin/Super Admin status, enumerates collections and recursively deletes application data while preserving protected admin identity collections and admin/superAdmin profiles.

Firebase Authentication accounts are not deleted by Firestore reset. Removed non-admin users can no longer pass app role authorization, but their Auth accounts may still exist in Firebase Console.

## 19. Deployment

Primary deployment files:

- `firebase.json` — Firebase Hosting, Functions source, Firestore rules and Storage rules.
- `firestore.rules` — Firestore authorization contract.
- `storage.rules` — Storage authorization contract.
- `vercel.json` — alternate static hosting headers/routes where used.
- `functions/index.js` — Cloud Functions source.

Before production release:

1. Create/verify first admin user and `adminUsers/{uid}`.
2. Deploy Firestore and Storage rules.
3. Deploy Functions if registration/factory-reset callable flows are required.
4. Deploy Hosting/static assets.
5. Confirm existing public results have `status: "published"` where they should be public.
6. Run the role matrix in a staging Firebase project.
7. Hard-refresh browser clients after deployment.

## 20. Local checks

The repository exposes one main check script:

```bash
npm run check
```

It performs JavaScript syntax checks, function syntax checks, event/scoring/poster/registration runtime checks, static build/load checks, smoke coverage checks and role-access contract checks.

## 21. Staging verification matrix

Static checks are not a substitute for deployed Firebase testing. Before release, verify these flows in staging:

1. Admin login with email and username.
2. Inactive admin/role login rejection.
3. Access Management creates Team Leader, Judge and Publisher users.
4. Team Leader adds/edits/deletes own team registration and is denied cross-team access.
5. Registration lock blocks team writes after lock time.
6. Judge opens own assignment, saves draft, submits and cannot edit locked sheet.
7. Admin reopens a judge sheet with a reason; judge resubmits.
8. Publisher imports, saves ready, publishes, withdraws and corrects results.
9. Public Results shows only published results, correct category filters, correct names and lazy loading.
10. Team standings and Top Talent update after publication.
11. TV display receives newly published result queue.
12. Data reset scopes are tested only on disposable staging data.
13. Browser console has no permission-denied, missing-index, CSP or network errors.

## 22. Maintenance rule for documentation

Keep this as the only application Markdown document. If new operational notes are needed, add them here instead of creating scattered extra `.md` files.
