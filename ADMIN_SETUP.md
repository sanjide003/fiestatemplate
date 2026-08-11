# Admin Login & Firestore Setup

## 1. Create the Firebase Auth admin user

1. Open **Firebase Console → Authentication → Users**.
2. Click **Add user**.
3. Enter the admin **email** and **password**.
4. Copy the generated **UID** for that user.

> The admin login form accepts Firebase Auth email/password. If you want username login, also create the `adminUsernames/{username}` mapping below. All role logins, including admin login, start from `login.html`; protected pages redirect there when no valid role session exists.

## 2. Create the Firestore admin role document

Create this collection and document manually from **Firestore Database → Data**:

- Collection: `adminUsers`
- Document ID: the Firebase Auth UID copied above
- Fields:

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

Allowed admin roles:

- `admin`
- `superAdmin`

If `active` is not `true`, the user cannot enter `admin.html` even if the Firebase Auth password is correct.

## 3. Optional username login mapping

If admins should type a short username instead of the email address, create this extra document:

- Collection: `adminUsernames`
- Document ID: lowercase username, for example `admin`
- Fields:

```json
{
  "email": "admin@example.com",
  "uid": "firebase-auth-uid",
  "active": true
}
```

Without this mapping, admins can still login with the Firebase Auth email address.


Access Management note: the Admin tab creates Firebase Auth users for new access profiles; it does not store application password hashes. If an admin enters only a username in the single Username/Email box, the generated Firebase Auth email format is `username@fest.local`. If an email address is entered, that exact email is used for Firebase Auth and the username defaults to the email prefix. Profile image URLs are saved as `photoUrl` and synced to public team leader / judge records.

## 4. Required Firestore collections

The app creates most documents as needed, but production setup should include these collections/documents:

| Collection / document | Purpose | Who writes |
| --- | --- | --- |
| `adminUsers/{uid}` | Admin role gate for Firebase Auth users | Existing admin / Firebase Console |
| `adminUsernames/{username}` | Legacy admin-only username-to-email login mapping | Existing admin / Firebase Console |
| `accessUsers/{profileId}` then `accessUsers/{uid}` | Generic role profile for team leaders, judges, publishers and admins. The Admin tab creates a pending profile; `login.html` links the Firebase Auth UID automatically after first login. | Admin Access Management tab / first user login |
| `accessUsernames/{username}` and `accessUsernames/email_*` | Generic username/email-to-login mapping for `login.html` | Admin Access Management tab |
| `teamLeaders/{uid}` | Public team leader display records linked to teams | Admin Access Management tab |
| `settings/general` | Teams, categories, chest number config, passcodes | Admin only |
| `settings/home_config` | Public home page content | Admin only |
| `settings/scoring_rules` | Result and grade point rules | Admin only |
| `settings/tv_config` | TV display settings | Admin only |
| `students/{id}` | Student records | Admin only |
| `events/{id}` | Event records and schedule fields | Admin only |
| `registrations/{id}` | Team registrations | Signed-in team portal can create/update/delete; admin can manage |
| `results/{eventId}` | Published/archived results | Admin or publisher role |
| `notifications/{id}` | Team/public notifications | Signed-in app user can create, admin manages |
| `judges/{uid}` | Password-free judge directory/assignment mirror synchronized from the canonical `accessUsers/{uid}` profile | Admin only |
| `judgeAssignments/{id}` | Judge-event assignments | Admin only |
| `judgeScores/{id}` | Judge scoring sheets | Judge portal can create/update, admin can read/delete |
| `deletedBackups/{id}` | Backup archive before destructive deletes | Admin only |
| `auditLogs/{id}` | Delete/reset audit metadata | Admin only |

## 5. Deploy rules

After creating the first `adminUsers/{uid}` document, deploy `firestore.rules`.

Important bootstrap note: the first admin role document must be created from Firebase Console or an Admin SDK script because the app itself cannot create admin roles before an admin exists.
