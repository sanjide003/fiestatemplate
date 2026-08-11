# Data Reset Contract

## Clear Specific Data

The Admin **Data Reset** tab exposes explicit reset scopes for people, programs, registration, results, schedules, judging, notifications, non-admin access, configuration, audit logs and deletion backups. Before a scope runs, the UI loads the affected collections, reports the record count and requires the exact scope phrase. Specific operational resets create a best-effort `deletedBackups` archive and `auditLogs` entry; clearing audit logs or backups does not create another archive.

The schedule reset also removes schedule fields embedded in event documents. The non-admin access reset removes Team Leader, Judge and Publisher profiles and username mappings while preserving `admin` and `superAdmin` profiles.

## Team Reset

Team reset clears matching students, registrations, notifications, generalized participants, public registration requests, Team Leader mirrors, access profiles and username mappings. It requires the exact team name before deletion.

## Factory Reset

Factory Reset requires two confirmations: the exact phrase `DELETE EVERYTHING` and the currently authenticated Admin email. The preferred path calls the deployed `completeFactoryReset` Cloud Function. The function:

1. verifies Firebase Authentication and an active `adminUsers/{uid}` Admin/Super Admin document;
2. enumerates every top-level Firestore collection;
3. recursively deletes every operational collection and subcollection;
4. preserves the complete `adminUsers` and `adminUsernames` collections;
5. preserves `admin` and `superAdmin` documents in `accessUsers` and `accessUsernames`; and
6. deletes every non-admin access profile and all other application data, settings, logs and backups.

If the Cloud Function is not deployed or temporarily unavailable, the browser falls back to the exhaustive repository collection manifest. That fallback clears every collection currently used by this application, but only the server function can discover future/unknown collections and recursively delete arbitrary subcollections.

Firebase Authentication accounts are outside Firestore. Factory Reset intentionally does not delete Firebase Auth users; removed non-admin profiles can no longer pass application role authorization. The primary Admin Firebase Auth account remains available for login and fresh setup.

## Deployment

Deploy both Firestore rules and Functions before relying on the server-grade reset:

```bash
cd functions && npm install
firebase deploy --only functions,firestore:rules
```
