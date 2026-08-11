# Role Access & Function Verification

> **പരിശോധിച്ച തീയതി:** 2026-07-28
> **പരിധി:** Access Management creation flow, login routing, page-level auth gates, UI write paths, `firestore.rules` permissions, static automated checks. Production Firebase Auth users, deployed rules, live documents എന്നിവ ഈ repository environment-ൽ ലഭ്യമല്ലാത്തതിനാൽ live login/save test നടത്തിയിട്ടില്ല.

## സംഗ്രഹം

Source/rules contract പ്രകാരം role തിരഞ്ഞെടുക്കുമ്പോൾ routing ഇങ്ങനെയാണ്:

| Access role | Login destination | Page gate | അനുവദിച്ച പ്രധാന പ്രവർത്തനങ്ങൾ |
|---|---|---|---|
| Team Leader | `team.html` | active `accessUsers/{uid}`, role `teamLeader`, assigned team | സ്വന്തം team/gender scope-ൽ registration create/edit/delete; schedule/results/report view |
| Judge | `judge.html` | active `accessUsers/{uid}`, role `judge` | സ്വന്തം assignments മാത്രം view; score draft save; review & submit |
| Publish Access | `publish.html` | active `accessUsers/{uid}`, role `publisher` | submitted judge sheets review; ready/publish/withdraw/correct; audit/notification atomic writes |
| Admin | `admin.html` | active `adminUsers/{uid}`, role `admin`/`superAdmin` | master data, students, events, schedule, access, scoring, judge control, public/TV config, reset; `publish.html`-ലും പ്രവേശനം |

`login.js` role-നെ canonical destination-ലേക്ക് map ചെയ്യുന്നു. ഓരോ protected page-ഉം destination ലഭിച്ചതുകൊണ്ട് മാത്രം തുറക്കുന്നില്ല; Firebase Auth user-ന്റെ active role document വീണ്ടും validate ചെയ്യുന്നു. Firestore rules ആണ് save/delete operations-ന്റെ അന്തിമ authorization layer.

## Role-wise verification

### 1. Team Leader

**Source-level result: PASS, താഴെയുള്ള intentional limits സഹിതം.**

- Team profile-ൽ assign ചെയ്ത team-ലെ students/events മാത്രമാണ് manage ചെയ്യുന്നത്.
- Registrations create, update, delete code paths ഉണ്ട്; rules team ownership, gender scope, creator/update provenance എന്നിവ പരിശോധിക്കുന്നു.
- Registration lock time കഴിഞ്ഞാൽ UI-യും rules-ഉം write തടയും.
- മറ്റൊരു gender leader ചേർത്ത protected participants UI preserve ചെയ്യുന്നു.
- Student master record edit/delete Team page-ൽ ഇല്ല; അത് Admin-only operation ആണ്.

### 2. Judge

**Source-level result: PASS, workflow lock സഹിതം.**

- Judge-ന്റെ UID/profile-ന് assign ചെയ്ത `judgeAssignments` മാത്രം query ചെയ്യുന്നു.
- Draft save, validation, transaction-based submit എന്നിവ നിലവിലുണ്ട്.
- Submit ചെയ്ത score sheet Judge-ന് edit/delete ചെയ്യാനാവില്ല. ഇത് defect അല്ല; Admin reason നൽകി reopen ചെയ്താൽ മാത്രമാണ് correction അനുവദിക്കുന്നത്.
- Judge-ന് result publish/delete permission ഇല്ല; Publisher/Admin workflow വഴിയാണ് publication.

### 3. Publish Access

**Source-level result: PASS.**

- Publisher active profile validate ചെയ്തശേഷമാണ് data listeners തുടങ്ങുന്നത്.
- Result save/publish action `results`, `judgeScores`, `auditLogs`, `notifications` എന്നിവ Firestore batch-ൽ atomic ആയി update ചെയ്യുന്നു.
- Ready result publish, published result withdraw, correction reason സഹിതം edit/re-publish, bulk publish എന്നിവയ്ക്കുള്ള code/rule paths ഉണ്ട്.
- Published history hard-delete ചെയ്യാൻ UI അനുവദിക്കുന്നില്ല; correction/withdraw ഉപയോഗിക്കണം. ഇത് audit integrity-ക്കായുള്ള intentional behavior ആണ്.

### 4. Admin

**Source-level result: PASS.**

- `adminUsers/{uid}` active admin/superAdmin gate കഴിഞ്ഞാണ് admin realtime listeners തുടങ്ങുന്നത്.
- Access Management പുതിയ Firebase Auth user secondary app വഴി സൃഷ്ടിക്കുന്നതിനാൽ current admin logout ആകുന്നില്ല.
- Selected role അനുസരിച്ച് canonical `accessUsers` profile-ഉം ആവശ്യമായ `adminUsers`, `judges`, `teamLeaders` mirror-ഉം സൃഷ്ടിക്കുന്നു.
- Existing access profile edit/activate/deactivate/delete paths ഉണ്ട്. Access delete ചെയ്താൽ app role documents നീങ്ങും; Firebase Authentication account സ്വയം delete ചെയ്യില്ല. അതിനാൽ account credentials Firebase Console-ൽ നിലനിൽക്കാം, പക്ഷേ role profile ഇല്ലാത്തതിനാൽ app login നിരസിക്കും.
- Existing Firebase Auth password Admin page-ൽ മാറ്റാൻ കഴിയില്ല; Firebase password-reset/Admin SDK ഉപയോഗിക്കണം. UI ഇത് വ്യക്തമായി തടയുന്നു.

## കണ്ടെത്തി പരിഹരിച്ച സുരക്ഷാ പ്രശ്നം

മുമ്പ് `notifications` collection-ൽ **ഏത് signed-in role-നും notification create ചെയ്യാൻ** rule അനുവദിച്ചിരുന്നു. Team Leader/Judge page-ൽ അതിനുള്ള function ഇല്ലെങ്കിലും നേരിട്ടുള്ള Firestore client call വഴി വ്യാജ notification സൃഷ്ടിക്കാനാകുമായിരുന്നു. Rule ഇപ്പോൾ notification creation **Admin അല്ലെങ്കിൽ Publisher**-ക്ക് മാത്രം അനുവദിക്കുന്നു. നിലവിലെ admin rejection alerts, publisher result announcements എന്നിവ തുടർന്നും പ്രവർത്തിക്കും.

## ഇപ്പോഴും live environment-ൽ നിർബന്ധമായി പരിശോധിക്കേണ്ടത്

Static/source verification “deployed Firebase project-ൽ എല്ലാം ഉറപ്പായും പ്രവർത്തിക്കുന്നു” എന്നതിന് പകരമല്ല. Release-ന് മുമ്പ് staging project-ൽ നാല് test users ഉണ്ടാക്കി താഴെയുള്ള matrix നടത്തണം:

1. Admin Access Management-ൽ ഓരോ role user-ഉം create ചെയ്യുക.
2. Username login, email login, wrong password, inactive access എന്നിവ പരിശോധിക്കുക.
3. Team: registration add/edit/delete, cross-team denial, gender denial, lock-time denial.
4. Judge: own assignment view, other judge denial, draft save, submit lock, Admin reopen, resubmit.
5. Publisher: judge sheet import, ready, publish, withdraw, correction, bulk publish; public result/notification update.
6. Admin: student/event CRUD, schedule save, access activate/deactivate/delete, scoring/public/TV config save, destructive actions staging data-യിൽ മാത്രം.
7. Browser console-ൽ `permission-denied`, missing-index, CSP/network errors ഇല്ലെന്ന് ഉറപ്പാക്കുക.
8. Repository-യിലെ `firestore.rules` production/staging project-ൽ deploy ചെയ്ത version തന്നെയാണെന്ന് ഉറപ്പാക്കുക.

## Automated regression check

`npm run role-check` routing, page gates, role-scoped CRUD paths, publisher atomic workflow, notification restriction, default-deny rule എന്നിവ source contract ആയി പരിശോധിക്കുന്നു. `npm run check` ഇപ്പോൾ ഈ role check-ഉം നിർബന്ധമായി run ചെയ്യുന്നു.
