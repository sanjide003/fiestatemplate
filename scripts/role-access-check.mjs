import { readFileSync } from 'node:fs';

const source = (file) => readFileSync(file, 'utf8');
const login = source('login.js');
const adminAuth = source('admin-auth.js');
const admin = source('admin-main.js');
const team = source('team.html');
const judge = source('judge.js');
const publish = source('publish.html');
const rules = source('firestore.rules');

const contracts = {
  'role redirects': [
    "admin: 'admin.html'", "superAdmin: 'admin.html'", "teamLeader: 'team.html'",
    "judge: 'judge.html'", "publisher: 'publish.html'"
  ].every(value => login.includes(value)),
  'admin profile gate': adminAuth.includes("doc(db, 'adminUsers', user.uid)")
    && adminAuth.includes("ADMIN_ROLES.has(profile.role)"),
  'access creation uses Firebase Auth': admin.includes('createUserWithEmailAndPassword')
    && admin.includes("setDoc(doc(db, 'accessUsers'")
    && admin.includes("setDoc(doc(db, 'adminUsers'"),
  'team profile and team scope': team.includes("profile.role !== 'teamLeader'")
    && team.includes('profile.team !== storedTeam')
    && team.includes('currentTeam = storedTeam')
    && rules.includes("hasAccessRole('teamLeader')")
    && rules.includes('data.team == profile.team'),
  'team registration CRUD and lock': team.includes('addDoc(collection(db, "registrations")')
    && team.includes('updateDoc(doc(db, "registrations"')
    && team.includes('deleteDoc(doc(db, "registrations"')
    && rules.includes('registrationsOpen()'),
  'judge profile and scoped assignments': judge.includes("access.role!=='judge'")
    && judge.includes("where('judgeId','in',ids.slice(0,30))")
    && judge.includes('currentJudgeIds')
    && rules.includes('judgeOwnsAssignment'),
  'judge draft submit transaction': judge.includes("persistScores(id,status)")
    && judge.includes('runTransaction')
    && judge.includes("status==='submitted'")
    && rules.includes("resource.data.status == 'draft'")
    && rules.includes('exists(assignmentDoc(scoreId))')
    && rules.includes('judgeOwnsAssignment(scoreId')
    && admin.includes('judgeAuthId')
    && judge.includes('currentJudgeIds'),
  'publisher profile gate': publish.includes("accessSnap.data().role === 'publisher'")
    && publish.includes("['admin', 'superAdmin'].includes(adminSnap.data().role)"),
  'publisher atomic result workflow': publish.includes("batch.set(doc(db, 'results'")
    && publish.includes("batch.update(doc(db, 'judgeScores'")
    && publish.includes("batch.set(doc(collection(db, 'auditLogs'))")
    && rules.includes("hasAccessRole('publisher')"),
  'notification writes restricted': rules.includes("allow create: if isAdmin() || hasAccessRole('publisher');"),
  'notification reads team scoped': rules.includes("resource.data.team in ['All', get(accessDoc()).data.team]")
    && team.includes('where("team", "in", ["All", currentTeam])'),
  'public results published only': rules.includes("resource.data.status == 'published'")
    && ['index.html', 'results.html', 'team.html'].every(file => source(file).includes('where("status", "==", "published")'))
    && source('tv.html').includes("where('status', '==', 'published')"),
  'poster and certificate permissions': rules.includes('match /posterCertificateModels/{modelId}')
    && rules.includes("resource.data.status == 'published'"),
  'default deny': rules.includes('match /{document=**}')
    && rules.includes('allow read, write: if false;')
};

let failed = false;
for (const [name, passed] of Object.entries(contracts)) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  failed ||= !passed;
}
if (failed) throw new Error('Role access contract check failed');
console.log('Role access contracts passed');
