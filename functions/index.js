const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');

initializeApp();

const ADMIN_ROLES = new Set(['admin', 'superAdmin']);
const PROTECTED_COLLECTIONS = new Set(['adminUsers', 'adminUsernames']);

exports.completeFactoryReset = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Admin authentication is required.');
  if (request.data?.confirmation !== 'DELETE EVERYTHING') throw new HttpsError('invalid-argument', 'Factory reset confirmation is invalid.');

  const db = getFirestore();
  const admin = await db.doc(`adminUsers/${request.auth.uid}`).get();
  if (!admin.exists || admin.data().active !== true || !ADMIN_ROLES.has(admin.data().role)) {
    throw new HttpsError('permission-denied', 'An active Admin or Super Admin account is required.');
  }

  const collections = await db.listCollections();
  let deleted = 0;
  for (const collection of collections) {
    if (PROTECTED_COLLECTIONS.has(collection.id)) continue;
    if (collection.id === 'accessUsers' || collection.id === 'accessUsernames') {
      const snapshot = await collection.get();
      for (const item of snapshot.docs) {
        if (ADMIN_ROLES.has(item.data().role)) continue;
        await db.recursiveDelete(item.ref);
        deleted += 1;
      }
      continue;
    }
    const snapshot = await collection.get();
    deleted += snapshot.size;
    await db.recursiveDelete(collection);
  }
  return { deleted, preserved: ['adminUsers', 'adminUsernames', 'admin/superAdmin access profiles'] };
});

const normalizeText = value => String(value || '').trim();
const chestCode = value => String(value ?? '').trim();
const tokenHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const applicationId = (studentId, eventId) => `${studentId}_${eventId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
const profilePhotoPayload = (data, remove = false) => {
  if (remove) return '';
  const dataUrl = normalizeText(data?.photoData), match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new HttpsError('invalid-argument', 'Profile photo must be a JPG, PNG or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 200 * 1024) throw new HttpsError('invalid-argument', 'Profile photo must be 200 KB or less.');
  return dataUrl;
};
const generalEventEligibleCategories = config => { const items = Array.isArray(config?.generalEventEligibleCategories) ? config.generalEventEligibleCategories.map(item => normalizeText(item)).filter(Boolean) : []; return items.length ? items : null; };
const eventCategoryEligible = (participant, event, config = {}) => {
  if (!event?.category || event.category === 'All') return true;
  if (event.category === 'General') {
    const allowed = generalEventEligibleCategories(config);
    return allowed === null || allowed.includes(normalizeText(participant?.category || 'General'));
  }
  return event.category === participant?.category;
};
const applicationPayload = (data, config) => {
  const fields = config.applicationFields || {}, note = normalizeText(data?.note), youtubeUrl = normalizeText(data?.youtubeUrl), referenceUrl = normalizeText(data?.referenceUrl), images = Array.isArray(data?.images) ? data.images : [];
  const valueFor = key => fields[key] || ((key === 'youtube' || key === 'reference') && config.applicationLinksEnabled === false ? 'off' : 'optional');
  if (valueFor('description') === 'off' && note || valueFor('youtube') === 'off' && youtubeUrl || valueFor('reference') === 'off' && referenceUrl || valueFor('images') === 'off' && images.length) throw new HttpsError('failed-precondition', 'One or more application fields are disabled by Registration Policy.');
  if (valueFor('description') === 'required' && !note || valueFor('youtube') === 'required' && !youtubeUrl || valueFor('reference') === 'required' && !referenceUrl || valueFor('images') === 'required' && !images.length) throw new HttpsError('invalid-argument', 'Complete every required application field.');
  if (note.length > Math.max(25, Math.min(500, Number(config.applicationNoteMaxLength || 250)))) throw new HttpsError('invalid-argument', 'Application note is too long.');
  if (images.length > 1) throw new HttpsError('invalid-argument', 'Maximum 1 image is allowed.');
  const cleanImages = images.map((image, index) => { const type = normalizeText(image?.type), dataUrl = normalizeText(image?.data), match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);if (!match || match[1] !== type) throw new HttpsError('invalid-argument', `Image ${index + 1} is invalid.`);const bytes = Buffer.from(match[2], 'base64');if (!bytes.length || bytes.length > 300 * 1024) throw new HttpsError('invalid-argument', `Image ${index + 1} must be 300 KB or less.`);return { name: normalizeText(image.name).slice(0, 120), type, size: bytes.length, data: dataUrl }; });
  for (const url of [youtubeUrl, referenceUrl].filter(Boolean)) { try { if (new URL(url).protocol !== 'https:') throw new Error(); } catch { throw new HttpsError('invalid-argument', 'Links must be valid HTTPS URLs.'); } }
  return { note, youtubeUrl, referenceUrl, images: cleanImages };
};

const mediaUpdatePayload = (data, config, existing = {}) => {
  if (config.allowApplicationMediaAddMissing !== true && config.allowApplicationMediaReplace !== true) throw new HttpsError('failed-precondition', 'Application detail updates are disabled by Registration Policy.');
  const safeConfig = { ...config, applicationFields: { description: 'optional', youtube: 'optional', reference: 'optional', images: 'optional' } };
  const next = applicationPayload(data, safeConfig), current = { note: normalizeText(existing.note), youtubeUrl: normalizeText(existing.links?.youtube || existing.youtubeUrl), referenceUrl: normalizeText(existing.links?.reference || existing.referenceUrl), images: Array.isArray(existing.images) ? existing.images : [] };
  ['description','youtube','reference','images'].forEach(key => { const currentValue = key === 'description' ? current.note : key === 'youtube' ? current.youtubeUrl : key === 'reference' ? current.referenceUrl : JSON.stringify(current.images), nextValue = key === 'description' ? next.note : key === 'youtube' ? next.youtubeUrl : key === 'reference' ? next.referenceUrl : JSON.stringify(next.images); if(config.applicationFields?.[key] === 'off' && nextValue !== currentValue) throw new HttpsError('failed-precondition', 'One or more application fields are disabled by Registration Policy.'); });
  const replacing = config.allowApplicationMediaReplace === true;
  if (!replacing) {
    if (current.note && next.note !== current.note) throw new HttpsError('failed-precondition', 'Description is already submitted and cannot be changed.');
    if (current.youtubeUrl && next.youtubeUrl !== current.youtubeUrl) throw new HttpsError('failed-precondition', 'YouTube link is already submitted and cannot be changed.');
    if (current.referenceUrl && next.referenceUrl !== current.referenceUrl) throw new HttpsError('failed-precondition', 'Reference link is already submitted and cannot be changed.');
    if (current.images.length && JSON.stringify(next.images) !== JSON.stringify(current.images)) throw new HttpsError('failed-precondition', 'Image is already submitted and cannot be changed.');
  }
  return { note: next.note, links: { youtube: next.youtubeUrl, reference: next.referenceUrl }, images: next.images };
};
const enforceParticipationLimits = async (db, config, targetEvent, participantId, idField, registrationIdField) => {
  const limits=config.participationLimits||{},active=new Set(['applied','under_review','waitlisted','selected','finalized','pending']),[apps,finalEntries]=await Promise.all([db.collection('registrationApplications').where(idField,'==',participantId).get(),db.collection('registrations').where(registrationIdField,'array-contains',participantId).get()]),ids=new Set([...apps.docs.filter(doc=>active.has(doc.data().status||'applied')).map(doc=>doc.data().eventId),...finalEntries.docs.map(doc=>doc.data().eventId)].filter(Boolean));
  ids.add(targetEvent.id);const events=await Promise.all([...ids].map(id=>db.doc(`events/${id}`).get())),usage={offStage:0,onStage:0,single:0,group:0,general:0,total:0},exclude=limits.excludeGeneralFromTotal===true,counting={stage:limits.generalCounting?.stage!==false,type:limits.generalCounting?.type!==false,independent:limits.generalCounting?.independent!==false};
  events.forEach(snap=>{if(!snap.exists)return;const event=snap.data(),general=event.category==='General',keys=[];if(!general||counting.stage)keys.push(event.stage==='On-Stage'?'onStage':'offStage');if(!general||counting.type)keys.push(event.type==='Group'?'group':'single');if(general&&counting.independent)keys.push('general');keys.forEach(key=>usage[key]++);if(event.category!=='General'||!exclude)usage.total++});
  const exceeded=Object.entries(usage).filter(([key,count])=>limits[key]?.enabled!==false&&limits[key]?.mode==='custom'&&count>Number(limits[key].limit||0));if(exceeded.length)throw new HttpsError('failed-precondition',`Participation limit reached: ${exceeded.map(([key,count])=>`${key} ${count-1}/${limits[key].limit}`).join(', ')}`);
};
const writeVerificationSession = async (ref, data) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { await ref.set(data);return; }
    catch (error) {
      lastError = error;
      console.error('registration-session-write-failed', { attempt, sessionId: ref.id, code: error?.code, message: error?.message });
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 150));
    }
  }
  throw new HttpsError('unavailable', 'The verification session could not be saved. Check the Cloud Function service account Firestore permissions and logs.', { stage: 'session-write', code: lastError?.code || 'unknown' });
};
const registrationOpen = (config, policy, now = Date.now()) => config.registrationPortalEnabled !== false
  && config.studentApplicationsEnabled !== false
  && (config.globalStatus || 'open') !== 'closed' && (!config.openAt || now >= config.openAt)
  && (!config.closeAt || now < config.closeAt) && policy.studentApplicationsEnabled !== false
  && (policy.mode || 'open') !== 'closed';

exports.searchStudentCandidates = onCall(async request => {
  const { team, gender, query } = request.data || {}, text = normalizeText(query).toLowerCase();
  if (!normalizeText(team) || text.length < 3) throw new HttpsError('invalid-argument', 'Choose a team and enter at least three letters.');
  const db = getFirestore(), config = (await db.doc('settings/registration_config').get()).data() || {};
  if (config.studentApplicationsEnabled === false || (config.globalStatus || 'open') === 'closed') throw new HttpsError('failed-precondition', 'Student applications are closed.');
  const snapshot = await db.collection('students').where('team', '==', normalizeText(team)).limit(250).get();
  return { candidates: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(student => (!gender || (student.gender || 'Boys') === gender) && normalizeText(student.name).toLowerCase().includes(text))
    .slice(0, 8).map(student => ({ id: student.id, name: student.name })) };
});

exports.verifyStudentRegistration = onCall(async request => {
  const studentId = normalizeText(request.data?.studentId), chestNo = normalizeText(request.data?.chestNo);
  if (!studentId || !chestNo) throw new HttpsError('invalid-argument', 'Student and chest number are required.');
  const db = getFirestore(), studentRef = db.doc(`students/${studentId}`), attemptsRef = db.doc(`registrationVerificationAttempts/${studentId}`);
  const [studentSnap, configSnap, attemptsSnap] = await Promise.all([studentRef.get(), db.doc('settings/registration_config').get(), attemptsRef.get()]);
  if (!studentSnap.exists) throw new HttpsError('not-found', 'Student was not found.');
  const config = configSnap.data() || {}, max = Math.max(3, Number(config.maxVerificationAttempts || 5)), attempts = attemptsSnap.data() || {}, now = Date.now();
  if (Number(attempts.blockedUntil || 0) > now) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again later.');
  const student = studentSnap.data();
  if (chestCode(student.chestNo) !== chestCode(chestNo)) {
    const count = Number(attempts.count || 0) + 1, blockedUntil = count >= max ? now + 15 * 60 * 1000 : 0;
    await attemptsRef.set({ count: blockedUntil ? 0 : count, blockedUntil, updatedAt: now }, { merge: true });
    throw new HttpsError('permission-denied', blockedUntil ? 'Too many attempts. Try again after 15 minutes.' : 'Chest number does not match.');
  }
  if (!student.team) throw new HttpsError('failed-precondition', 'This student is not assigned to a team.');
  await attemptsRef.delete().catch(() => {});
  const token = crypto.randomBytes(24).toString('hex'), sessionRef = db.collection('studentRegistrationSessions').doc();
  const expiresAt = now + Math.max(5, Math.min(120, Number(config.verificationSessionMinutes || 30))) * 60000;
  await writeVerificationSession(sessionRef, { studentId, team: student.team, tokenHash: tokenHash(token), createdAt: now, expiresAt });
  return { sessionId: sessionRef.id, token, expiresAt, student: { id: studentId, name: student.name, team: student.team, category: student.category || 'General', gender: student.gender || 'Boys', chestNo: student.chestNo, photoData: student.photoData || '', details: student.details || {} } };
});

async function verifiedSession(db, data) {
  const ref = db.doc(`studentRegistrationSessions/${normalizeText(data.sessionId)}`), snap = await ref.get(), session = snap.data();
  if (!snap.exists || Number(session.expiresAt || 0) <= Date.now() || session.tokenHash !== tokenHash(data.token || '')) throw new HttpsError('unauthenticated', 'Student verification has expired. Verify again.');
  return { ref, session };
}

exports.studentRegistrationPortal = onCall(async request => {
  const db = getFirestore(), action = normalizeText(request.data?.action), verified = await verifiedSession(db, request.data || {}), studentSnap = await db.doc(`students/${verified.session.studentId}`).get(), student = { id: studentSnap.id, ...studentSnap.data() };
  if (action === 'updatePhoto' || action === 'removePhoto') { const config = (await db.doc('settings/registration_config').get()).data() || {}; if (config.profileEditEnabled !== true) throw new HttpsError('failed-precondition', 'Profile editing is disabled by the administrator.'); const photoData = profilePhotoPayload(request.data, action === 'removePhoto'); await db.doc(`students/${student.id}`).set({ photoData, photoUpdatedAt: Date.now(), photoUpdatedBy: 'registration_portal' }, { merge: true }); return { photoData }; }
  if (action === 'updateApplicationMedia') { const [configSnap, appSnap] = await Promise.all([db.doc('settings/registration_config').get(), db.doc(`registrationApplications/${normalizeText(request.data?.applicationId)}`).get()]); if(!appSnap.exists || appSnap.data().studentId !== student.id) throw new HttpsError('not-found', 'Application was not found.'); const update = mediaUpdatePayload(request.data, configSnap.data() || {}, appSnap.data()); await appSnap.ref.update({ ...update, mediaUpdatedAt: Date.now(), mediaUpdatedBy: 'registration_portal', updatedAt: Date.now() }); return { id: appSnap.id, ...update }; }
  if (action === 'list') {
    const [eventsSnap, applicationsSnap, configSnap, policySnap, registrationsSnap] = await Promise.all([db.collection('events').get(), db.collection('registrationApplications').where('studentId', '==', student.id).get(), db.doc('settings/registration_config').get(), db.doc(`teamRegistrationPolicies/${student.team}`).get(), db.collection('registrations').where('team', '==', student.team).get()]);
    const selectedCounts = {};
    registrationsSnap.docs.forEach(doc => { const item = doc.data(); selectedCounts[item.eventId] = (selectedCounts[item.eventId] || 0) + [...(item.studentIds || []), ...(item.participantIds || [])].length; });const teamApps=await db.collection('registrationApplications').where('team','==',student.team).get(),teamEventCounts={};teamApps.docs.forEach(doc=>{const item=doc.data(),row=teamEventCounts[item.eventId]||={applications:0,selected:0,finalizedParticipants:selectedCounts[item.eventId]||0};row.applications++;if(['selected','finalized'].includes(item.status))row.selected++});const eventRows=eventsSnap.docs.map(doc=>({id:doc.id,...doc.data()})),eventMap=Object.fromEntries(eventRows.map(event=>[event.id,event])),directRegistrations=registrationsSnap.docs.filter(doc=>(doc.data().studentIds||[]).includes(student.id)).map(doc=>{const item=doc.data(),event=eventMap[item.eventId]||{};return{id:`registration_${doc.id}`,eventId:item.eventId,eventName:event.name||item.eventName||'Event',eventSnapshot:event,status:'approved',registrationSource:item.registrationSource||'team_leader',adminOverride:item.adminOverride===true,registeredBy:(item.adminOverride===true||String(item.registrationSource||'').startsWith('admin'))?'Fest Committee':(item.lastUpdatedByName||item.createdByName||'Team Leader'),studentId:student.id,team:item.team,createdAt:item.createdAt||item.lastUpdatedAt}});
    return { student: { id: student.id, name: student.name, chestNo: student.chestNo, team: student.team, category: student.category || 'General', gender: student.gender || 'Boys', photoData: student.photoData || '', details: student.details || {} }, config: configSnap.data() || {}, teamPolicy: policySnap.data() || {}, applications: [...applicationsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })), ...directRegistrations], selectedCounts, teamEventCounts, events: eventRows.filter(event => event.status !== 'draft') };
  }
  if (action !== 'apply') throw new HttpsError('invalid-argument', 'Unsupported portal action.');
  const eventId = normalizeText(request.data?.eventId), now = Date.now();
  const [eventSnap, configSnap, policySnap, registrationsSnap] = await Promise.all([db.doc(`events/${eventId}`).get(), db.doc('settings/registration_config').get(), db.doc(`teamRegistrationPolicies/${student.team}`).get(), db.collection('registrations').where('team', '==', student.team).get()]);
  if (!eventSnap.exists) throw new HttpsError('not-found', 'Event was not found.');
  const event = { id: eventId, ...eventSnap.data() }, config = configSnap.data() || {}, policy = policySnap.data() || {};
  if (!registrationOpen(config, policy, now)) throw new HttpsError('failed-precondition', 'Applications are closed for this team.');
  const types = event.allowedParticipantTypes || ['student'], gender = student.gender || 'Boys';
  if (!types.includes('student') || (event.gender && !['Both', gender].includes(event.gender)) || !eventCategoryEligible(student, event, config)) throw new HttpsError('permission-denied', 'This event is not eligible for the verified student.');
  const selected = registrationsSnap.docs.filter(doc => doc.data().eventId === eventId).reduce((sum, doc) => sum + (doc.data().studentIds || []).length, 0), capacity = Math.max(1, Number(event.limit || 1)) * (event.type === 'Group' ? Math.max(1, Number(event.maximumMembers || event.groupSize || 1)) : 1), full = selected >= capacity;
  if (full && ((config.fullEventVisibility||'waitlist')!=='waitlist' || config.unfilledEventsOnly || policy.mode === 'unfilled_only' || config.acceptWhenFull === false)) throw new HttpsError('failed-precondition', 'This event is full.');
  const { note, youtubeUrl, referenceUrl, images } = applicationPayload(request.data, config);
  await enforceParticipationLimits(db, config, event, student.id, 'studentId', 'studentIds');
  const ref = db.doc(`registrationApplications/${applicationId(student.id, eventId)}`), existing = await ref.get();
  if (existing.exists && !['not_selected', 'removed'].includes(existing.data().status)) throw new HttpsError('already-exists', 'You have already applied for this event.');
  const status = full && config.waitingListEnabled !== false && (config.fullEventVisibility||'waitlist')==='waitlist' ? 'waitlisted' : 'applied';
  await ref.set({ studentId: student.id, studentName: student.name, chestNo: student.chestNo, team: student.team, category: student.category || 'General', gender, participantType: 'student', eventId, eventName: event.name || '', status, note, links: { youtube: youtubeUrl, reference: referenceUrl }, images, eventSnapshot: { name:event.name||'', rules:event.rules||'', criteria:event.criteria||[], maximumMark:event.maximumMark||0, category:event.category||'', stage:event.stage||'Off-Stage', type:event.type||'Single' }, appliedAt: now, updatedAt: now, source: 'student_portal' });
  await db.collection('auditLogs').add({ action: 'student-event-application', studentId: student.id, eventId, team: student.team, status, timestamp: now });
  return { id: ref.id, status };
});

const enabledRegistrationTypes = general => {
  const setup = general.festSetup || {}, enabled = Array.isArray(setup.participantTypes) ? setup.participantTypes : ['student'];
  const definitions = Array.isArray(setup.participantTypeDefinitions) ? setup.participantTypeDefinitions : [];
  return enabled.map(key => ({ key, label: definitions.find(item => item.key === key)?.label || key.replace(/_/g, ' ') }));
};

const selfRegistrationEnabled = general => {
  const channels = general.festSetup?.registrationChannels;
  return !Array.isArray(channels) || channels.includes('self');
};

exports.searchRegistrationCandidates = onCall(async request => {
  const db = getFirestore(), type = normalizeText(request.data?.participantType), team = normalizeText(request.data?.team), gender = normalizeText(request.data?.gender), text = normalizeText(request.data?.query).toLowerCase();
  if (text.length < 3) throw new HttpsError('invalid-argument', 'Enter at least three letters.');
  const general = (await db.doc('settings/general').get()).data() || {}, enabled = enabledRegistrationTypes(general);
  if (!selfRegistrationEnabled(general)) throw new HttpsError('failed-precondition', 'Self registration is disabled in Master Setup.');
  if (!enabled.some(item => item.key === type)) throw new HttpsError('permission-denied', 'This participant type is not enabled.');
  const source = type === 'student' ? 'students' : 'participants';
  if (type === 'student' && !team) throw new HttpsError('invalid-argument', 'Choose a team before searching.');
  let query = db.collection(source).limit(250);if (team) query = query.where('team', '==', team);
  const snapshot = await query.get();
  return { candidates: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(item => (type === 'student' || item.participantType === type) && (!gender || (item.gender || 'Boys') === gender) && normalizeText(item.name).toLowerCase().includes(text)).slice(0, 8).map(item => ({ id: item.id, name: item.name })) };
});

exports.verifyRegistrationIdentity = onCall(async request => {
  const db = getFirestore(), participantType = normalizeText(request.data?.participantType), candidateId = normalizeText(request.data?.candidateId), name = normalizeText(request.data?.name), team = normalizeText(request.data?.team), gender = normalizeText(request.data?.gender), verificationValue = normalizeText(request.data?.verificationValue), now = Date.now();
  const [generalSnap, configSnap] = await Promise.all([db.doc('settings/general').get(), db.doc('settings/registration_config').get()]), general = generalSnap.data() || {}, config = configSnap.data() || {}, enabled = enabledRegistrationTypes(general);
  if (!selfRegistrationEnabled(general)) throw new HttpsError('failed-precondition', 'Self registration is disabled in Master Setup.');
  if (!registrationOpen(config, {})) throw new HttpsError('failed-precondition', 'Self registration is currently closed.');
  if (!enabled.some(item => item.key === participantType)) throw new HttpsError('permission-denied', 'This participant type is not enabled for registration.');
  let profile;
  if (participantType === 'student') {
    const snap = await db.doc(`students/${candidateId}`).get();if (!snap.exists) throw new HttpsError('not-found', 'Student was not found.');const item = snap.data();
    const attemptsRef = db.doc(`registrationVerificationAttempts/${candidateId}`), attemptsSnap = await attemptsRef.get(), attempts = attemptsSnap.data() || {}, max = Math.max(3, Number(config.maxVerificationAttempts || 5));
    if (Number(attempts.blockedUntil || 0) > now) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again later.');
    if (chestCode(item.chestNo) !== chestCode(verificationValue)) {
      const count = Number(attempts.count || 0) + 1, blockedUntil = count >= max ? now + 15 * 60 * 1000 : 0;
      await attemptsRef.set({ count: blockedUntil ? 0 : count, blockedUntil, updatedAt: now }, { merge: true });
      throw new HttpsError('permission-denied', blockedUntil ? 'Too many attempts. Try again after 15 minutes.' : 'Chest number does not match.');
    }
    if (!item.team || item.team !== team || (gender && (item.gender || 'Boys') !== gender) || item.name !== name) throw new HttpsError('permission-denied', 'Selected student details do not match.');
    await attemptsRef.delete().catch(() => {});
    profile = { id: snap.id, participantType, name: item.name, team: item.team, category: item.category || 'General', gender: item.gender || 'Boys', chestNo: item.chestNo, photoData: item.photoData || '', details: item.details || {}, verified: true };
  } else {
    if (name.length < 2) throw new HttpsError('invalid-argument', 'Enter the participant full name.');
    const existing = candidateId ? await db.doc(`participants/${candidateId}`).get() : null, item = existing?.exists ? existing.data() : {};
    profile = { id: existing?.exists ? existing.id : `applicant_${crypto.randomBytes(8).toString('hex')}`, participantType, name, team: item.team || team, category: item.category || normalizeText(request.data?.category) || 'Open', gender: item.gender || gender, photoData: item.photoData || item.photo || '', details: { ...(item.details || {}), phone: normalizeText(request.data?.phone), email: normalizeText(request.data?.email), relationship: normalizeText(request.data?.relationship), relatedStudentId: normalizeText(request.data?.relatedStudentId) }, verified: existing?.exists || false };
  }
  const token = crypto.randomBytes(24).toString('hex'), ref = db.collection('studentRegistrationSessions').doc(), expiresAt = now + Math.max(5, Math.min(120, Number(config.verificationSessionMinutes || 30))) * 60000;
  await writeVerificationSession(ref, { participantId: profile.id, participantType, profile, tokenHash: tokenHash(token), createdAt: now, expiresAt });return { sessionId: ref.id, token, expiresAt, participant: profile };
});

exports.registrationPortal = onCall(async request => {
  const db = getFirestore(), verified = await verifiedSession(db, request.data || {}), session = verified.session, participant = session.profile;
  if (!participant) throw new HttpsError('failed-precondition', 'Use the current registration verification flow.');
  const action = normalizeText(request.data?.action), appQuery = db.collection('registrationApplications').where('participantKey', '==', participant.id);
  if (action === 'updatePhoto' || action === 'removePhoto') { const config = (await db.doc('settings/registration_config').get()).data() || {}; if (config.profileEditEnabled !== true) throw new HttpsError('failed-precondition', 'Profile editing is disabled by the administrator.'); const photoData = profilePhotoPayload(request.data, action === 'removePhoto'), source = participant.participantType === 'student' ? 'students' : 'participants'; if (!String(participant.id || '').startsWith('applicant_')) await db.doc(`${source}/${participant.id}`).set({ [participant.participantType === 'student' ? 'photoData' : 'photo']: photoData, photoData, photoUpdatedAt: Date.now(), photoUpdatedBy: 'registration_portal' }, { merge: true }); await verified.ref.update({ 'profile.photoData': photoData }); return { photoData }; }
  if (action === 'updateApplicationMedia') { const [configSnap, appSnap] = await Promise.all([db.doc('settings/registration_config').get(), db.doc(`registrationApplications/${normalizeText(request.data?.applicationId)}`).get()]); if(!appSnap.exists || appSnap.data().participantKey !== participant.id) throw new HttpsError('not-found', 'Application was not found.'); const update = mediaUpdatePayload(request.data, configSnap.data() || {}, appSnap.data()); await appSnap.ref.update({ ...update, mediaUpdatedAt: Date.now(), mediaUpdatedBy: 'registration_portal', updatedAt: Date.now() }); return { id: appSnap.id, ...update }; }
  if (action === 'list') {
    const [eventsSnap, applicationsSnap, configSnap, policySnap, registrationsSnap] = await Promise.all([db.collection('events').get(), appQuery.get(), db.doc('settings/registration_config').get(), participant.team ? db.doc(`teamRegistrationPolicies/${participant.team}`).get() : Promise.resolve({ data: () => ({}) }), participant.team ? db.collection('registrations').where('team', '==', participant.team).get() : Promise.resolve({ docs: [] })]);
    const selectedCounts = {};registrationsSnap.docs.forEach(doc => { const item = doc.data();selectedCounts[item.eventId] = (selectedCounts[item.eventId] || 0) + [...(item.studentIds || []), ...(item.participantIds || [])].length; });const teamApps=participant.team?await db.collection('registrationApplications').where('team','==',participant.team).get():{docs:[]},teamEventCounts={};teamApps.docs.forEach(doc=>{const item=doc.data(),row=teamEventCounts[item.eventId]||={applications:0,selected:0,finalizedParticipants:selectedCounts[item.eventId]||0};row.applications++;if(['selected','finalized'].includes(item.status))row.selected++});const eventRows=eventsSnap.docs.map(doc=>({id:doc.id,...doc.data()})),eventMap=Object.fromEntries(eventRows.map(event=>[event.id,event])),directRegistrations=registrationsSnap.docs.filter(doc=>[...(doc.data().studentIds||[]),...(doc.data().participantIds||[])].includes(participant.id)).map(doc=>{const item=doc.data(),event=eventMap[item.eventId]||{};return{id:`registration_${doc.id}`,eventId:item.eventId,eventName:event.name||item.eventName||'Event',eventSnapshot:event,status:'approved',registrationSource:item.registrationSource||'team_leader',adminOverride:item.adminOverride===true,registeredBy:(item.adminOverride===true||String(item.registrationSource||'').startsWith('admin'))?'Fest Committee':(item.lastUpdatedByName||item.createdByName||'Team Leader'),participantKey:participant.id,team:item.team,createdAt:item.createdAt||item.lastUpdatedAt}});
    return { participant, config: configSnap.data() || {}, teamPolicy: policySnap.data() || {}, applications: [...applicationsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })), ...directRegistrations], selectedCounts, teamEventCounts, events: eventRows.filter(item => item.status !== 'draft') };
  }
  if (action !== 'apply') throw new HttpsError('invalid-argument', 'Unsupported portal action.');
  const eventId = normalizeText(request.data?.eventId), [eventSnap,configSnap,policySnap,registrationsSnap]=await Promise.all([db.doc(`events/${eventId}`).get(),db.doc('settings/registration_config').get(),participant.team?db.doc(`teamRegistrationPolicies/${participant.team}`).get():Promise.resolve({data:()=>({})}),participant.team?db.collection('registrations').where('team','==',participant.team).get():Promise.resolve({docs:[]})]);if (!eventSnap.exists) throw new HttpsError('not-found', 'Event was not found.');const event = { id: eventId, ...eventSnap.data() },config=configSnap.data()||{},policy=policySnap.data()||{},allowed = event.allowedParticipantTypes || ['student'];if(!registrationOpen(config,policy))throw new HttpsError('failed-precondition','Registration applications are closed.');const selected=registrationsSnap.docs.filter(doc=>doc.data().eventId===eventId).reduce((sum,doc)=>sum+(doc.data().studentIds||doc.data().participantIds||[]).length,0),capacity=Math.max(1,Number(event.limit||1))*(event.type==='Group'?Math.max(1,Number(event.maximumMembers||event.groupSize||1)):1),full=selected>=capacity;if(full&&((config.fullEventVisibility||'waitlist')!=='waitlist'||config.unfilledEventsOnly||policy.mode==='unfilled_only'||config.acceptWhenFull===false))throw new HttpsError('failed-precondition','This event is full.');
  if (!allowed.includes(participant.participantType) || (event.gender && !['Both', participant.gender].includes(event.gender)) || !eventCategoryEligible(participant, event, config)) throw new HttpsError('permission-denied', 'This event is not eligible for this participant type.');
  const now = Date.now(),{note,youtubeUrl,referenceUrl,images}=applicationPayload(request.data,config);await enforceParticipationLimits(db,config,event,participant.id,'participantKey',participant.participantType==='student'?'studentIds':'participantIds');const key = applicationId(`${participant.participantType}_${participant.id}`, eventId), ref = db.doc(`registrationApplications/${key}`), existing = await ref.get();if (existing.exists && !['not_selected', 'removed'].includes(existing.data().status)) throw new HttpsError('already-exists', 'An application already exists for this event.');
  const applicationStatus=!participant.verified?'pending_admin_approval':full&&config.waitingListEnabled!==false&&(config.fullEventVisibility||'waitlist')==='waitlist'?'waitlisted':'applied';await ref.set({ participantKey: participant.id, participantId: participant.participantType === 'student' ? '' : participant.id, studentId: participant.participantType === 'student' ? participant.id : '', participantType: participant.participantType, participantName: participant.name, studentName: participant.name, chestNo: participant.chestNo || '', team: participant.team || '', category: participant.category || 'Open', gender: participant.gender || '', eventId, eventName: event.name || '', status: applicationStatus, note: note.slice(0, 500), links: { youtube: youtubeUrl, reference: referenceUrl }, images, eventSnapshot: { name:event.name||'', rules:event.rules||'', criteria:event.criteria||[], maximumMark:event.maximumMark||0, category:event.category||'', stage:event.stage||'Off-Stage', type:event.type||'Single' }, profileSnapshot: participant, appliedAt: now, updatedAt: now, source: 'registration_portal' });return { id: ref.id, status: applicationStatus };
});
