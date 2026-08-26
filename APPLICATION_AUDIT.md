# FEST-ADDING-003 — സമഗ്ര ആപ്ലിക്കേഷൻ ഓഡിറ്റ്

> **ഓഡിറ്റ് തീയതി:** 2026-07-28
> **ഓഡിറ്റിന്റെ പരിധി:** repository-യിലെ tracked source files, HTML entry points, JavaScript modules, Firebase configuration, Firestore security rules, deployment configuration, static checks എന്നിവയുടെ source-level വിലയിരുത്തൽ. Live Firebase data/Authentication users അല്ലെങ്കിൽ production deployment ഇതിൽ നേരിട്ട് പരിശോധിച്ചിട്ടില്ല.

## 1. എക്സിക്യൂട്ടീവ് സംഗ്രഹം

ഇത് build framework ഇല്ലാത്ത, Firebase backend ഉപയോഗിക്കുന്ന ഒരു **multi-role festival management web application** ആണ്. UI പ്രധാനമായും HTML + Tailwind CDN + vanilla JavaScript ഉപയോഗിക്കുന്നു; authentication Firebase Authentication-ലും operational data Cloud Firestore-ലും സൂക്ഷിക്കുന്നു.

- Repository-യിൽ ഇപ്പോൾ **9 യഥാർത്ഥ HTML പേജുകൾ** ഉണ്ട്; poster/certificate editor Admin Console-ൽ സംയോജിപ്പിച്ചിരിക്കുന്നു.
- ആ 9 പേജുകൾക്കുള്ളിൽ tab/section അടിസ്ഥാനത്തിൽ നിരവധി logical screens ഉണ്ട്. അവയെ വേറെ URL/page ആയി എണ്ണരുത്.
- പ്രധാന workflow: **Admin setup → Team registration → Schedule/Judge assignment → Judge scoring → Publisher review/publish → Public/TV result display**.
- Firestore `onSnapshot` listeners കാരണം ഭൂരിഭാഗം screens-ലും മാറ്റങ്ങൾ real time ആയി പ്രതിഫലിക്കുന്നു.
- Source പരിശോധനയിൽ runtime-ൽ ഉപയോഗമില്ലെന്ന് സ്ഥിരീകരിച്ച **7 legacy/orphan files ഈ cleanup-ൽ നീക്കം ചെയ്തു**; active import graph-ഉം check scripts-ഉം അതനുസരിച്ച് പുതുക്കി.
- നിലവിലെ application ഒരു static SPA അല്ല; ഓരോ role/experience-നും പ്രത്യേകം HTML entry point ഉള്ള **multi-page application (MPA)** ആണ്. എന്നാൽ പല HTML ഫയലുകളിലും വലിയ inline JavaScript/CSS ഉള്ളതിനാൽ maintainability കുറവാണ്.

## 2. പേജുകളുടെ കൃത്യമായ എണ്ണം

### 2.1 Physical pages: 10

| # | URL / file | Access | പ്രധാന ഉദ്ദേശം |
|---|---|---|---|
| 1 | `index.html` | Public | Fest landing page, branding, about, team leaders, schedule, gallery, result links |
| 2 | `results.html` | Public | Published results, team standings |
| 3 | `login.html` | Public entry / authenticated redirect | Admin, judge, team leader, publisher എന്നിവർക്കുള്ള shared username/email-password login |
| 4 | `admin.html` | Admin / Super Admin | മുഴുവൻ fest configuration, masters, schedule, access, judging oversight, reset operations |
| 5 | `team.html` | Team Leader | സ്വന്തം team students/events/registrations/schedule/reports കൈകാര്യം ചെയ്യൽ |
| 6 | `judge.html` | Judge | Assigned events വിലയിരുത്തൽ, draft save, final score-sheet submission |
| 7 | `publish.html` | Publisher/Admin | Submitted judge sheet പരിശോധിച്ച് result ready/publish/archive/correct ചെയ്യൽ |
| 8 | `tv.html` | Public display | വലിയ screen/TV-യിൽ configured result slides കാണിക്കൽ |
| 9 | `register.html` | Public registration | Parent/public/self-registration request സമർപ്പിക്കൽ |

**അതിനാൽ “എത്ര pages?” എന്ന ചോദ്യത്തിന് canonical ഉത്തരം: 10 HTML pages.** URL മാറാതെ കാണുന്ന tabs, modals, forms എന്നിവ pages അല്ല; അവ logical views ആണ്.

### 2.2 ഓരോ പേജിനുള്ളിലെ logical views

#### `index.html` — Public Home

1. Hero/branding and result call-to-action.
2. About + live counts (programs, contestants, categories, teams).
3. Team leaders + team-score link.
4. Public schedule: date/category/search filters, upcoming/previous status, pagination.
5. Gallery, social links, footer.

ഈ page `settings/home_config`, `settings/public_config`, `settings/general`, `students`, `events`, `registrations`, `results`, `teamLeaders`, `scheduleBreaks`, `publicJudgingStatuses` എന്നിവ കേട്ട് public presentation നിർമ്മിക്കുന്നു.

#### `results.html` — Public Results Portal

1. **Results** — event-wise published result cards/search/filter.
2. **Team** — team standings/total score.
Public UI-യിൽ `status === published` ആയ result data ആണ് പ്രധാനമായും പ്രത്യക്ഷപ്പെടേണ്ടത്. Students, events, registrations എന്നിവ ചേർത്താണ് winner identity, team, category മുതലായ display data resolve ചെയ്യുന്നത്.

#### `login.html` — Shared Role Login

1. Username അല്ലെങ്കിൽ email സ്വീകരിക്കുന്നു.
2. `accessUsernames` / `adminUsernames` mapping വഴി Firebase Auth email resolve ചെയ്യുന്നു.
3. Firebase email-password sign-in നടത്തുന്നു.
4. `accessUsers` അല്ലെങ്കിൽ `adminUsers` profile പരിശോധിക്കുന്നു.
5. role അനുസരിച്ച് redirect ചെയ്യുന്നു:
   - admin/superAdmin → `admin.html`
   - judge → `judge.html`
   - teamLeader → `team.html`
   - publisher → `publish.html`
6. `next` query parameter അനുവദിച്ച safe pages-ലേക്ക് മാത്രം redirect ചെയ്യുന്നു.

#### `admin.html` — Admin Console

| Tab | ഉദ്ദേശം |
|---|---|
| Dashboard | Students/events/entries/results totals, പ്രധാന shortcuts |
| Registrations | എല്ലാ team registrations filter/view ചെയ്യൽ; registration lock time |
| Students | Single/bulk student creation, edit/delete, chest-number management |
| Events | Single/bulk event creation, category/gender/type/stage metadata, edit/delete |
| Time Schedule | Days/stages/duration setup, events schedule ചെയ്യൽ, breaks, conflict checks |
| Schedule Print | Saved version/filter/column configuration, PDF preview, Excel export |
| Judgement | Judge assignments, submitted sheets review/reopen/publishing hand-off |
| Access Management | Admin/judge/team leader/publisher accounts and role/team/profile data |
| Scoring Settings | Position points, grades, tie policy, single/group scoring config |
| Public Page Control | Home/results text, media, public schedule card/content settings |
| TV Display Settings | TV rotation, visibility and appearance settings |
| Master Setup | Fest-level teams, categories, chest config and master settings |
| Data Reset | Team-specific delete/factory reset പോലുള്ള destructive operations |

Admin startup Firebase Auth session പരിശോധിച്ച് active `adminUsers/{uid}` role ഉറപ്പാക്കിയശേഷമാണ് realtime listeners തുടങ്ങുന്നത്.

#### `team.html` — Team Leader Portal (5 tabs)

| Tab | ഉദ്ദേശം |
|---|---|
| Dashboard | Team points, student/participation totals, category progress, notifications |
| Events | Team-ന് ലഭ്യമായ events filter/search ചെയ്ത് participants register ചെയ്യൽ |
| My Registrations | നിലവിലെ team entries പരിശോധിക്കുകയും lock-നു മുമ്പ് edit/delete ചെയ്യുകയും ചെയ്യൽ |
| My Schedule | Team participants ഉൾപ്പെട്ട schedule മാത്രം കാണൽ; participant/student drill-down |
| Reports | Participation report; PDF/CSV export |

`accessUsers` profile-ലെ active `teamLeader` role-ഉം assigned team-ഉം അടിസ്ഥാനമാക്കി portal scope നിശ്ചയിക്കുന്നു. `settings/schedule_config.registrationLockAt` കഴിഞ്ഞാൽ registration read-only ആകുന്നു. Firestore rules server-side team scope enforce ചെയ്യേണ്ട അവസാന സുരക്ഷാ പാളിയാണ്.

#### `judge.html` — Judge Desk

Navigation views: Dashboard, Assignments, Drafts, Submitted. Assignment തുറന്നാൽ അഞ്ചാമത്തെ logical view ആയ scoring Workspace ലഭിക്കുന്നു.

1. Active judge profile validate ചെയ്യുന്നു.
2. ആ judge-നുള്ള `judgeAssignments` മാത്രം query ചെയ്യുന്നു.
3. Assigned events/registrations/students scoped ആയി load ചെയ്യുന്നു.
4. ഓരോ entry-ക്കും evaluation, marks/position, notes നൽകുന്നു.
5. Draft `judgeScores`-ൽ save ചെയ്യാം.
6. Review & Submit ചെയ്താൽ sheet lock ചെയ്യുകയും `publicJudgingStatuses` update ചെയ്യുകയും ചെയ്യുന്നു.
7. Admin reopen ചെയ്താൽ correction reason സഹിതം judge-ന് വീണ്ടും edit ചെയ്യാം.

Participant signature, stale version, transaction, permission checks എന്നിവ concurrent/changed sheet തെറ്റായി overwrite ചെയ്യുന്നത് കുറയ്ക്കുന്നു.

#### `publish.html` — Publishing Desk (4 navigation states)

| View/state | ഉദ്ദേശം |
|---|---|
| Dashboard | Publishing queue statistics/recent attention items |
| Judge Sheets | Submitted `judgeScores` പരിശോധിച്ച് result data import/review ചെയ്യൽ |
| Published | Published results list, corrections/status transitions |
| Ready / Bulk Publish | Ready results archive-state list reuse ചെയ്ത് bulk publish ചെയ്യൽ |

Publisher judge snapshot-നും current sheet version-നും consistency check ചെയ്യുന്നു. Firestore batch ഉപയോഗിച്ച് `results`, `judgeScores`, `auditLogs`, `notifications` ഒരുമിച്ച് update ചെയ്യുന്നു. ഇതാണ് public result പുറത്തുവരുന്ന gate.

#### `tv.html` — TV Display

`settings/tv_config` പ്രകാരം visibility/rotation നിയന്ത്രിച്ച് `results`, `events`, `students`, teams എന്നിവ ചേർത്ത് full-screen slides render ചെയ്യുന്നു. Anonymous sign-in കാത്തിരിക്കാതെ Firestore public-readable configuration/data listeners ഉപയോഗിക്കുന്ന display endpoint ആണ്.

## 3. End-to-end system flow

```text
Firebase Console bootstrap
  └─ first Auth user + adminUsers/{uid} + deploy firestore.rules
       ↓
login.html ── role/profile validation ──→ role portal
       ↓
Admin: teams/categories/scoring/public config
       ↓
Admin: students + events + access users
       ↓
Team leader: event registrations ──(registration lock)──→ frozen entries
       ↓
Admin: schedule + breaks + versions + judge assignments
       ↓
Judge: draft score → review → submitted/locked judgeScore
       ↓
Admin review/reopen (ആവശ്യപ്പെട്ടാൽ judge correction loop)
       ↓
Publisher: import → verify → ready/published result
       ├─→ notifications → Team portal
       ├─→ results → Public Home/Results portal
       └─→ results → TV display
```

### 3.1 Setup and access flow

ആദ്യ admin app-ൽ നിന്ന് bootstrap ചെയ്യാനാവില്ല; Firebase Console/Admin SDK വഴി Auth user, `adminUsers/{uid}` സൃഷ്ടിച്ച് rules deploy ചെയ്യണം. തുടർന്ന് admin Access Management secondary Firebase Auth instance ഉപയോഗിച്ച് പുതിയ role users സൃഷ്ടിക്കുന്നു; അതുവഴി നിലവിലെ admin session logout ആവാതെ user provisioning നടത്താം. Username mappings login identifier-നെ Auth email-ലേക്ക് മാറ്റുന്നു.

### 3.2 Master-data flow

`settings/general` teams/categories/chest configuration-ന്റെ കേന്ദ്രമാണ്. `students` team/category/chest identity സൂക്ഷിക്കുന്നു. `events` category, gender, single/group type, stage/schedule metadata സൂക്ഷിക്കുന്നു. Admin forms ഇതെല്ലാം create/update/delete ചെയ്യുന്നു; destructive cascade-നു backup/audit support ഉണ്ട്.

### 3.3 Registration flow

Team leader സ്വന്തം team-ലുള്ള eligible students-നെ event-ലേക്ക് ചേർത്ത് `registrations` document create/update/delete ചെയ്യുന്നു. Event type അനുസരിച്ച് single participant അല്ലെങ്കിൽ member list ഉപയോഗിക്കുന്നു. UI lock time പരിശോധിക്കുന്നു; Firestore rules authenticated role/team ownership പരിശോധിക്കുന്നു. Admin എല്ലാ registrations-നും oversight നൽകുന്നു.

### 3.4 Schedule flow

Admin days, stages, event duration, breaks ക്രമീകരിച്ച് event schedule fields update ചെയ്യുന്നു. Participant overlap/conflict സൂചനകൾ നൽകുന്നു. Review tab saved `scheduleVersions` ഉപയോഗിച്ച് filterable PDF/Excel output സൃഷ്ടിക്കുന്നു. Public home, team portal എന്നിവ schedule/breaks realtime ആയി വായിക്കുന്നു.

### 3.5 Judging-to-publication flow

Admin `judgeAssignments` സൃഷ്ടിക്കുന്നു. Judge draft/final values `judgeScores`-ൽ transaction വഴി എഴുതുന്നു. Submit ചെയ്ത sheet lock ആകുകയും public schedule-നുള്ള completion marker എഴുതുകയും ചെയ്യുന്നു. Publisher submitted sheet import ചെയ്ത് scoring snapshot/position/grade values ഉപയോഗിച്ച് result നിർമിക്കുന്നു. Publish batch result, score publish status, audit log, notification എന്നിവ synchronize ചെയ്യുന്നു.

### 3.6 Public presentation flow

Public pages Firebase collections-ൽ `onSnapshot` listeners സ്ഥാപിക്കുന്നു. Admin content/scoring/result മാറ്റങ്ങൾ refresh ഇല്ലാതെ render ചെയ്യാം. Home summary, result rankings, team totals, TV slides എല്ലാം ഒരേ Firestore source-of-truth-ന്റെ വ്യത്യസ്ത projections ആണ്.

## 4. Architecture and important files

### 4.1 Runtime layers

| Layer | Files | ഉത്തരവാദിത്വം |
|---|---|---|
| Entry/UI | 9 `*.html` files | ഓരോ public/role portal-ന്റെയും markup; പല pages-ലും inline module logic |
| Active shared JS | `firebase-config.js`, `login.js`, `judge.js`, `admin-main.js`, `admin-auth.js`, `admin-utils.js`, `admin-dashboard.js`, `admin-students.js`, `admin-events.js`, `score-utils.js`, `dependency-loader.js` | Firebase bootstrap, auth, admin/judge behavior, shared normalization/scoring/dependency handling |
| Database authorization | `firestore.rules` | Role checks, field validation, team/judge scope, public reads, default deny |
| Hosting/security | `firebase.json`, `vercel.json`, `_headers` | Hosting ignore/cache/security header policy |
| Checks | `scripts/build-check.mjs`, `scripts/smoke-check.mjs`, `package.json` | HTML/module/static feature checks |
| Operator docs | `ADMIN_SETUP.md`, `SECURITY_AND_FIREBASE_RULES.md` | Bootstrap and deployment/security notes |

### 4.2 Firestore data map

| Collection/document | പ്രധാന producer | പ്രധാന consumer |
|---|---|---|
| `adminUsers`, `adminUsernames` | Console/Admin | Login, Admin auth |
| `accessUsers`, `accessUsernames` | Admin / first-login linking | Login, Team, Judge, Publisher |
| `settings/general` | Admin | എല്ലാ portals |
| `settings/home_config`, `public_config` | Admin | Login/Public/Team/Judge branding and public UI |
| `settings/scoring_rules` | Admin | Judge, Publisher |
| `settings/schedule_config` | Admin | Team registration lock/schedule behavior |
| `settings/tv_config` | Admin | TV |
| `students` | Admin | Admin, Team, Judge, Publisher, Public, TV |
| `events` | Admin | എല്ലാ operational/public portals |
| `registrations` | Team/Admin | Admin, Team, Judge, Publisher, Public |
| `scheduleBreaks`, `scheduleVersions` | Admin | Schedule/Public/Team/exports |
| `judgeAssignments` | Admin | Judge/Admin |
| `judgeScores` | Judge; Admin reopen metadata | Admin/Publisher |
| `publicJudgingStatuses` | Judge/Admin sync | Public schedule completion state |
| `results` | Publisher/Admin | Public, Team, TV, Admin |
| `notifications` | Publisher/authenticated flows/Admin | Team portal |
| `teamLeaders` | Admin | Public home |
| `deletedBackups`, `auditLogs` | Admin/Publisher | Administrative recovery/audit |

### 4.3 Security model

- Firebase Auth provides identity; Firestore profile documents provide application role and active status.
- UI redirects are convenience only; actual write protection `firestore.rules`-ൽ നിർബന്ധമായും നിലനിൽക്കണം.
- Rules explicit collection matches ഉപയോഗിച്ച് access അനുവദിച്ച് അവസാനം catch-all deny ചെയ്യുന്നു.
- Hosting configs CSP, nosniff, referrer policy, permissions policy എന്നിവ നൽകുന്നു.
- Firebase web API key source-ൽ കാണുന്നത് Firebase web apps-ൽ സാധാരണമാണ്; അതിനെ secret ആയി കരുതരുത്. യഥാർത്ഥ സംരക്ഷണം Auth, Rules, allowed domains/App Check എന്നിവയിലാണ്.

## 5. അനാവശ്യ/legacy file cleanup

Static import/reference graph പരിശോധിച്ച് runtime entry point-ുകളിൽ നിന്ന് എത്താനാകാത്ത files നീക്കം ചെയ്തു. Cleanup കഴിഞ്ഞ് active module syntax, build-load check, feature smoke suite എന്നിവ വീണ്ടും പ്രവർത്തിപ്പിക്കണം.

### 5.1 ഈ cleanup-ൽ നീക്കം ചെയ്ത files

| File | നീക്കം ചെയ്തതിന്റെ കാരണം |
|---|---|
| `style.css` | ഒരു HTML file-ലും `<link>` ഇല്ലായിരുന്നു; JavaScript import-ഉം ഉണ്ടായിരുന്നില്ല |
| `admin-tabs.js` | Runtime reference ഇല്ല; current tab behavior `admin-main.js` കൈകാര്യം ചെയ്യുന്നു |
| `home-manager.js` | `index.html` import ചെയ്തിരുന്നില്ല; active home implementation inline module-ലാണ് |
| `fest-manager.js` | ഒരു HTML entry point-ും import ചെയ്തിരുന്നില്ല; പഴയ alternative manager ആയിരുന്നു |
| `admin-schedule.js` | `fest-manager.js` മാത്രമാണ് import ചെയ്തിരുന്നത്; active schedule logic `admin-main.js`-ലാണ് |
| `admin-tv.js` | `fest-manager.js` മാത്രമാണ് import ചെയ്തിരുന്നത്; active TV settings `admin-main.js`-ലാണ് |
| `admin-judge.js` | Legacy manager നീക്കിയശേഷം ശേഷിച്ച imports ഉപയോഗിക്കപ്പെട്ടിരുന്നില്ല; active judge access Firebase Auth/access profiles ആണ് |

`package.json`-ലെയും `scripts/build-check.mjs`-ലെയും stale file lists നീക്കി. അതിനാൽ checks ഇല്ലാതായ files വായിക്കാൻ ശ്രമിക്കില്ല; active entry modules മുഴുവൻ തുടർന്നും syntax/load validation-ൽ ഉൾപ്പെടുന്നു.

### 5.2 Security/deployment cleanup

- Admin schedule PDF preview `<iframe>`-ൽ blob URL ഉപയോഗിക്കുന്നു. അതിനാൽ `admin.html`, Firebase, Vercel, `_headers` CSP-കളിൽ `frame-src 'self' blob:` ഒരേ രീതിയിൽ അനുവദിച്ചു.
- Executable/plugin object ആവശ്യമില്ലാത്തതിനാൽ എല്ലായിടത്തും `object-src 'none'` ആയി ഏകീകരിച്ചു.
- `_headers`-ലെ `/*` എന്നത് comment അല്ല; Netlify-style “all paths” rule ആണ്. അതിനാൽ file നിലനിർത്തി header policy മാത്രം ഏകീകരിച്ചു.

### 5.3 Judge model clarification

`judges` collection പൂർണ്ണമായി legacy അല്ല. Current admin `accessUsers` judge profile-ന്റെ public/assignment mirror ആയി password ഇല്ലാത്ത judge document sync ചെയ്യുന്നു; assignment UI അതിൽ നിന്നാണ് judge list വായിക്കുന്നത്. നീക്കം ചെയ്തത് പഴയ local password hashing utilities മാത്രം. Canonical authentication Firebase Auth + `accessUsers/{uid}` ആണ്.

### 5.4 ഇപ്പോൾ ഒഴിവാക്കരുതാത്ത files

- `admin-dashboard.js`, `admin-students.js`, `admin-events.js` active imports ഉള്ള shared helpers ആണ്.
- `dependency-loader.js` admin/judge pages runtime dependency readiness-ക്ക് ഉപയോഗിക്കുന്നു.
- `score-utils.js` Judge/Publisher ഒരേ scoring semantics ഉപയോഗിക്കാൻ ആവശ്യമാണ്.
- `ADMIN_SETUP.md`, `SECURITY_AND_FIREBASE_RULES.md` deployment/operator documentation ആണ്.
- `firebase.json`, `vercel.json`, `_headers` supported hosting targets-നുള്ള configuration ആണ്; deployment target തീരുമാനിക്കാതെ consolidate ചെയ്യരുത്.

## 6. പ്രധാന technical risks / improvement priorities

### P0 — production-നു മുമ്പ് പരിശോധിക്കേണ്ടത്

1. **Firestore rules deployment:** repository rules production project-ൽ deploy ചെയ്ത version തന്നെയാണെന്ന് ഉറപ്പാക്കുക.
2. **Role matrix end-to-end test:** admin, teamLeader, judge, publisher role ഓരോന്നും allowed/denied operations ഉൾപ്പെടെ test ചെയ്യുക.
3. **CSP/PDF mismatch:** Firebase/Vercel deployment-ൽ admin schedule PDF preview യഥാർത്ഥത്തിൽ പ്രവർത്തിക്കുന്നുണ്ടോ പരിശോധിച്ച് header ഏകീകരിക്കുക.
4. **Destructive operations:** factory reset/team delete backup, cascade completeness, audit logs എന്നിവ staging data-യിൽ test ചെയ്യുക.

### P1 — maintainability

1. `admin-main.js` (വളരെ വലിയ file), കൂടാതെ `index.html`, `team.html`, `results.html`, `publish.html` inline modules domain modules ആയി വിഭജിക്കുക.
2. Completed dead-code cleanup-ന്റെ browser regression baseline നിലനിർത്തുകയും വീണ്ടും orphan imports വരാതിരിക്കാൻ dependency check ചേർക്കുകയും ചെയ്യുക.
3. Inline event handlers (`onclick`, `onchange`) event delegation/modules-ലേക്ക് മാറ്റുക; CSP-ൽ `'unsafe-inline'` കുറയ്ക്കാൻ ഇത് സഹായിക്കും.
4. CDN-only dependencies versions pin ചെയ്ത് integrity/availability strategy ആസൂത്രണം ചെയ്യുക.
5. Static string smoke tests-നൊപ്പം Firebase Emulator integration tests, browser E2E tests ചേർക്കുക.

### P2 — performance and consistency

1. Public/Admin pages മുഴുവൻ collections realtime ആയി load ചെയ്യുന്നു; വലിയ fest data-യിൽ query/pagination/scoped listeners വേണം.
2. Page-specific CSS/JS duplication shared modules/components ആക്കുക.
3. `enableIndexedDbPersistence` deprecated/compatibility behavior Firebase current API പ്രകാരം വിലയിരുത്തുക; multi-tab strategy വ്യക്തമാക്കുക.
4. `home_config`, `public_config`, `general` config naming/schema document ചെയ്ത് defaults/version migration നൽകുക.

## 7. നിർദേശിക്കുന്ന update roadmap

1. **Baseline freeze:** നിലവിലെ 9 pages-നും screenshots/manual flow checklist; emulator seed data; role test accounts.
2. **Cleanup verification:** നീക്കം ചെയ്ത legacy files-ന് ശേഷം എല്ലാ role pages-ലും browser regression test പൂർത്തിയാക്കുക.
3. **Docs/security alignment:** access model, `judges` legacy collection, CSP, `_headers`, deployment targets ശരിയാക്കുക.
4. **Automated integration tests:** login redirects, team ownership/lock, judge submit lock/reopen, publisher batch, public visibility.
5. **Modularization:** ആദ്യം publish/team inline JS; തുടർന്ന് public results/home; അവസാനം domain-based admin split.
6. **Performance pass:** collection-wide listeners query/pagination ആക്കുക, indexes രേഖപ്പെടുത്തുക.
7. **Feature updates:** ഈ സ്ഥിരമായ baseline-ന് ശേഷം ഓരോ requested UI/business change ചെറിയ independently testable PR ആയി നടപ്പാക്കുക.

## 8. Validation boundary

ഈ റിപ്പോർട്ട് source truth വിശദീകരിക്കുന്നു; live system truth പൂർണമാക്കാൻ താഴെയുള്ളവ വേറെയും ആവശ്യമാണ്:

- Firebase Authentication-ലുള്ള actual users/roles.
- Production Firestore documents, indexes, deployed rule version.
- Firebase/Vercel/മറ്റേതെങ്കിലും actual hosting target and headers.
- Real-device browser, PDF/Excel export, offline/multi-tab behavior.
- External integrations ഏതെങ്കിലും നീക്കം ചെയ്ത legacy JS API നേരിട്ട് ഉപയോഗിച്ചിരുന്നോ എന്ന deployment analytics.

Source import graph-ൽ അവ unreachable ആയതിനാലാണ് legacy files നീക്കം ചെയ്തത്; production release-ന് മുമ്പ് real-browser role-flow validation ഇനിയും ആവശ്യമാണ്.

## Admin dashboard page directory

The Admin Dashboard is the single application-page launcher. It lists all nine physical HTML surfaces—Admin Console, Public Website, Public Results, Public Registration, Team Portal, Judge Page, Result Publishing, TV Display, and Login/Role Access—as responsive cards with the exact file name, an Open action, and a Copy action that resolves and copies the full deployment URL. External page links were removed from the Admin sidebar; the sidebar now contains only Admin workspace navigation.

## Admin navigation information architecture

The obsolete Manage Students and Publishing Desk dashboard shortcuts were removed because the same destinations already exist in the task navigation and page directory. The sidebar is ordered by an administrator’s working sequence: **Overview**; **People & Registration**; **Programme & Judging**; **Festival Configuration**; **Public & Display**; and **System**. This separates daily operational work from occasional configuration and isolates destructive reset actions at the end.

## Admin blank-tab incident

The page-directory edit removed the Dashboard tab's closing `</div>` and also left the content container, main region and app layout unclosed. Consequently every later `.tab-view` became a descendant of `#view-dashboard`; switching tabs hid that ancestor, so the selected child tab remained invisible despite having data. The missing boundaries were restored, and the build check now validates balanced markup on external-script pages to prevent recurrence.

## Bilingual in-app user guide

A User Guide tab now appears directly below Data Reset in the System navigation group. It is the only bilingual Admin surface: its sticky header provides English and Malayalam buttons, stores the selection for the browser session, and switches only the guide content/title without changing the rest of the Admin UI. Both versions cover first-time setup, Basic and Advanced operating modes, every task-oriented Admin group, application roles, the end-to-end publishing flow, Poster & Certificate, TV and reset safety.

## Master Setup profiles and safety restoration (2026-08-01)

Master Setup preserves the legacy class list and operational behavior while adding draft-only Basic, Standard and Advanced profiles. Basic selects direct results and a compact optional-field set; Standard selects team scheduling/judging and the standard field set; Advanced enables hybrid/per-event capabilities. Applying a profile never deletes existing records and final persistence still requires Review & Activate.

Class Master remains backward compatible with legacy `eligibleClasses` and is displayed with Student Detail Fields. It supplies both Student Class choices and the allowed values for per-event Eligible Classes. Student Name, Class, Guardian Name and Phone are protected built-ins; custom fields retain Edit/Delete plus Enabled/Required controls.

Event fields use four explicit requirements: Hidden, Optional, Always required and When applicable. Conditional validation is method/type aware for criteria, objective/count/time methods, group member rules, multiple judges, full scheduling, hybrid workflow and scoring overrides. Hidden fields are removed from new Excel model choices but existing Firestore values are retained.

Every major new Master Setup heading has contextual help rendered in a fixed viewport overlay. Only one help card opens at a time; it closes on Escape, outside click, section changes or its close action, and never expands the underlying card/grid.

Review & Activate distinguishes green readiness, red blocking omissions and amber existing-data impact. Automated checks cover the profile UI contract, configuration normalization, conditional event validation, full static build/smoke coverage and role-access contracts.

### Master Setup profile regression correction (2026-08-01)

A follow-up source audit found that the profile buttons were present but their delegated `apply-event-profile` action was not registered, and `eventFieldRulesForMode` was referenced without being imported into the Admin module. As a result, clicking a profile could not apply the draft and would raise a browser runtime error despite syntax/static checks passing. The action/import are now explicit smoke contracts. Preset normalization also now derives its field profile from the preset's event-management mode instead of inheriting the default Advanced profile. Active profile cards expose `aria-pressed`, custom field-rule changes save as the Custom profile, and Excel instructions use active Master Setup required rules.

### Master Setup navigation, class, grade and header completion (2026-08-01)

Collapsed desktop navigation now retains a five-icon Master Setup rail with section-specific icons, active state, accessible labels and readiness/dirty/error badges. The duplicated internal sticky Master Setup header was removed; the global Admin header now carries the active section, profile, unsaved/error status, Review shortcut and Save & Activate action.

The separate Class Master control was removed. The built-in Class field's options input is now the only editable class source; activation copies that one list to both the Class field and the legacy-compatible `eligibleClasses` property, fixing additions/removals being overwritten by the former second input.

Automatic grades remain independently switchable from position eligibility. Grade outcomes always normalize obtained marks against each event's maximum mark. The scoring card now previews A/B/C mark ranges for any sample maximum and summarizes the selected minimum-position policy without silently rewriting grade thresholds. Disabling Grades suppresses automatic awards while leaving positions/position points available.
