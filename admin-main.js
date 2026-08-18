import { app, db, auth } from './firebase-config.js';
import { escapeHtml, jsAttr, normalizeStageValue, printPage } from './admin-utils.js';
import { ensureAdminSharedState } from './admin-dashboard.js';
import { studentGender, chestKey, legacyChestKey } from './admin-students.js';
import { genderLabel } from './admin-events.js';
import { EVENT_IMPORT_COLUMNS, RESULT_METHODS, eventDuplicateKey, eventToFirestore, isEventHeadingRow, normalizeEventRow, parseCriteria, suggestEventColumn, validateEvent } from './event-utils.js';
import { collection, onSnapshot, doc, setDoc, addDoc, deleteDoc, deleteField, updateDoc, getDoc, getDocs, query, where, writeBatch } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { initAdminAuth } from './admin-auth.js';
import { DEFAULT_FEST_SETUP, FEST_PRESET_GUIDES, normalizeFestSetup, normalizeStudentFields, normalizeParticipantTypeDefinitions, normalizeCompetitionPolicies, incompleteCompetitionPolicies, eventFieldRulesForMode, readableTextColor, scheduleEnabled, judgingEnabled, setupForPreset, teamModeEnabled } from './fest-config.js';
import { deleteApp, initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { createUserWithEmailAndPassword, getAuth as getSecondaryAuth, signOut as signOutSecondary } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";
import { DEFAULT_BRANDING, normalizeBranding, brandingName, applyLogo, clearBrandingCache } from './branding-config.js';
import { initImageUploads, assertPayloadSize, normalizeGallerySlots } from './image-upload.js';
import { initPosterCertificateAdmin } from './poster-certificate-admin.js';
import { normalizeRegistrationConfig, capacityState, participationUsage, participationLimitDecision, eventCategoryEligible } from './registration-utils.js';
async function waitForAdminDependencies() {
    const dependencyCheck = window.ensureAdminDependencies?.(['tailwind', 'lucide', 'XLSX', 'jsPDF', 'jsPDFAutoTable', 'html2canvas', 'QRCode']) || Promise.resolve({});
    const timeout = new Promise(resolve => window.setTimeout(() => resolve({ timedOut: true }), 6000));
    const status = await Promise.race([dependencyCheck, timeout]).catch(error => {
        console.warn('Admin dependency check failed:', error);
        return { failed: true };
    });
    if(status?.timedOut) console.warn('Admin dependency check timed out; continuing with available libraries.');
    return status;
}
const adminDependencyStatusPromise = waitForAdminDependencies();
initImageUploads();
const completeFactoryReset = httpsCallable(getFunctions(app), 'completeFactoryReset');

let students = [], participants = [], events = [], registrations = [], categories = [], teams = [], teamDisplayNames = {}, categoryDisplayNames = {}, teamColors = {}, teamLogos = {}, teamIdCardHeaders = {}, chestConfig = [], results = [], judgeAssignments = [], judges = [], judgeScores = [];
let festSetup = normalizeFestSetup();
let homeConfig = {}, publicConfig = {}, tvConfig = {}, scoringRules = {}, scheduleConfig = {}, savedFestSetup = normalizeFestSetup(DEFAULT_FEST_SETUP);
let basicOrderDraft = [];
let accessUsers = [], teamLeaders = [], scheduleBreaks = [], registrationRequests = [], registrationApplications = [], registrationConfig = normalizeRegistrationConfig(), teamRegistrationPolicies = [];
let selectedAccessListFilter = 'teamLeader';
const selectedRegistrationApplicationKeys = new Set();
let visibleRegistrationApplicationKeys = [];
let expandedRegistrationEventId = "";
const alphaSequence = index => { let n = Number(index) + 1, out = ''; while(n > 0) { n--; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); } return out; };
const teamCodePattern = /^Team [A-Z]+$/;
const categoryCodePattern = /^Category \d+$/;
const teamLabel = value => String(teamDisplayNames?.[value] || value || '');
const categoryLabel = value => value === 'General' ? 'General' : String(categoryDisplayNames?.[value] || value || '');
const nextTeamCode = () => { let index = 0, code = `Team ${alphaSequence(index)}`; while(teams.includes(code)) code = `Team ${alphaSequence(++index)}`; return code; };
const nextCategoryCode = () => { let index = 1, code = `Category ${index}`; while(categories.includes(code)) code = `Category ${++index}`; return code; };
let masterIdentityUpgradeStarted = false;
async function syncPublicJudgingStatuses(items) {
    const submitted = items.filter(score => score.status === 'submitted' && score.assignmentId && score.eventId);
    for(let offset=0; offset<submitted.length; offset+=400) {
        const batch = writeBatch(db);
        submitted.slice(offset, offset+400).forEach(score => batch.set(doc(db, 'publicJudgingStatuses', score.assignmentId), {
            assignmentId: score.assignmentId,
            eventId: score.eventId,
            status: 'submitted',
            submittedAt: Number(score.submittedAt || score.updatedAt || Date.now())
        }));
        await batch.commit();
    }
}
let lastRenderHash = {};

const hasTextValue = value => String(value ?? '').trim().length > 0;
const hasPositiveNumber = value => Number.isFinite(Number(value)) && Number(value) > 0;
const hasArrayValue = value => Array.isArray(value) && value.filter(item => hasTextValue(item) || (item && typeof item === 'object')).length > 0;
const EVENT_OPTIONAL_FILTERS = [
    { key: 'rules', label: 'Rules', has: event => hasTextValue(event.rules || event.description || event.notes) },
    { key: 'code', label: 'Code', has: event => hasTextValue(event.code) },
    { key: 'section', label: 'Section', has: event => hasTextValue(event.section) },
    { key: 'eligibleClasses', label: 'Classes', has: event => hasArrayValue(event.eligibleClasses) },
    { key: 'participantTypes', label: 'Participants', has: event => hasArrayValue(event.allowedParticipantTypes) },
    { key: 'channels', label: 'Channels', has: event => hasArrayValue(event.allowedRegistrationChannels) },
    { key: 'criteria', label: 'Criteria', has: event => hasArrayValue(event.criteria) },
    { key: 'maximumMark', label: 'Max Mark', has: event => hasPositiveNumber(event.maximumMark) },
    { key: 'duration', label: 'Duration', has: event => hasPositiveNumber(event.duration) },
    { key: 'preparation', label: 'Prep', has: event => hasPositiveNumber(event.preparationTime) },
    { key: 'resultWorkflow', label: 'Workflow', has: event => hasTextValue(event.resultWorkflow) && event.resultWorkflow !== 'default' },
    { key: 'schedule', label: 'Schedule', has: event => hasTextValue(event.scheduleRequirement) && event.scheduleRequirement !== 'default' },
    { key: 'teamPolicy', label: 'Team Policy', has: event => hasTextValue(event.teamPolicy) && event.teamPolicy !== 'default' },
    { key: 'scoreContribution', label: 'Score', has: event => hasTextValue(event.scoreContribution) && event.scoreContribution !== 'default' },
    { key: 'scoringPolicy', label: 'Scoring', has: event => hasTextValue(event.scoringPolicy) && event.scoringPolicy !== 'default' }
];

const eventOptionalFilterValue = key => document.getElementById(`filter-ev-optional-${key}`)?.value || '';

window.renderEventOptionalFilters = () => {
    const host = document.getElementById('event-optional-filter-controls');
    if(!host || host.dataset.rendered === '1') return;
    host.innerHTML = EVENT_OPTIONAL_FILTERS.map(filter => `
        <label class="min-w-0 rounded-xl border border-slate-100 bg-slate-50 p-2">
            <span class="block truncate text-[9px] font-black uppercase tracking-wide text-slate-400">${escapeHtml(filter.label)}</span>
            <select id="filter-ev-optional-${escapeHtml(filter.key)}" data-admin-change="render-event-table" class="mt-1 w-full rounded-lg border border-white bg-white px-2 py-1.5 text-[11px] font-black text-slate-600 outline-none focus:ring-2 focus:ring-purple-500">
                <option value="">All</option>
                <option value="has">ഉണ്ട്</option>
                <option value="missing">ഇല്ല</option>
            </select>
        </label>`).join('');
    host.dataset.rendered = '1';
};

window.clearEventOptionalFilters = () => {
    EVENT_OPTIONAL_FILTERS.forEach(filter => {
        const select = document.getElementById(`filter-ev-optional-${filter.key}`);
        if(select) select.value = '';
    });
    window.renderEventTable(true);
};

const applyAdminLoaderBranding = (config = {}) => {
    config=normalizeBranding(config); const festName=brandingName(config);
    const name = document.getElementById('admin-loader-fest-name'); if(name) name.textContent = festName;
    const fallback = document.getElementById('admin-loader-fallback'); if(fallback) fallback.textContent = festName.charAt(0).toUpperCase() || 'F';
    const compactFallback = document.getElementById('admin-sidebar-logo-fallback'); if(compactFallback) compactFallback.textContent = festName.charAt(0).toUpperCase() || 'F';
    const brandedLogos = [
        { image: document.getElementById('admin-loader-logo'), fallback },
        { image: document.getElementById('admin-sidebar-logo'), fallback: compactFallback }
    ];
    brandedLogos.forEach(({ image, fallback: imageFallback }) => applyLogo(image,imageFallback,config));
    const brandTitle=document.getElementById('admin-sidebar-brand-name');if(brandTitle)brandTitle.textContent=config.configured?config.festName1:'Fest Management';
    const setupBanner=document.getElementById('admin-setup-required');setupBanner?.classList.toggle('hidden',config.configured);
};
try { applyAdminLoaderBranding(JSON.parse(localStorage.getItem('fest_home_config') || '{}')); } catch (_) { applyAdminLoaderBranding(); }

// Start auth immediately so direct /admin.html access redirects to login before optional tools finish loading.
let adminListenersStarted = false;
async function startAdminSession() {
    if (adminListenersStarted) return;
    adminListenersStarted = true;
    initPosterCertificateAdmin();
    try {
        const brandingSnapshot = await Promise.race([getDoc(doc(db, 'settings', 'home_config')), new Promise(resolve => window.setTimeout(() => resolve(null), 1800))]);
        if(brandingSnapshot?.exists()) { homeConfig = brandingSnapshot.data(); localStorage.setItem('fest_home_config', JSON.stringify(homeConfig)); applyAdminLoaderBranding(homeConfig); }
    } catch(error) { console.warn('Admin loader branding could not be refreshed', error); }
    document.getElementById('app-loader')?.classList.add('hide');
    document.getElementById('app-layout')?.classList.remove('opacity-0');

    window.adminUnsubscribers = window.adminUnsubscribers || [];
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "general"), (d) => { if (d.exists()) { const data = d.data(); categories = data.categories || []; teams = data.teams || []; teamDisplayNames = data.teamDisplayNames || {}; categoryDisplayNames = data.categoryDisplayNames || {}; teamColors = data.teamColors || {}; teamLogos = data.teamLogos || {}; teamIdCardHeaders = data.teamIdCardHeaders || {}; chestConfig = data.chestConfig || {}; festSetup = normalizeFestSetup(data.festSetup || {});savedFestSetup=normalizeFestSetup(festSetup); window.adminSharedState.update({ generalSettings: data, categories, teams, teamDisplayNames, categoryDisplayNames, teamColors, teamLogos, teamIdCardHeaders, chestConfig, festSetup }); window.renderDropdowns(); window.renderSetupLists?.(); window.renderChestGrid(); window.renderMasterSetup?.(); window.renderAdvancedRegistration?.(); window.applyFestCapabilities?.(); window.ensureStableMasterIdentities?.(data); } }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "students"), (snap) => { students = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.adminSharedState.update({ students }); window.renderStudentTable(); window.updateStats(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "participants"), (snap) => { participants = snap.docs.map(d => ({id:d.id,...d.data()})); window.renderParticipants?.(); window.renderParticipantFormOptions?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "events"), (snap) => { events = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.adminSharedState.update({ events }); window.renderEventTable(); window.renderRegistrationRequests?.(); const eventFilter = document.getElementById('reg-filter-event'); if(eventFilter?.options.length <= 1) window.populateRegEvents(); else window.renderRegList(true); window.updateStats(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "registrations"), (snap) => { registrations = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.updateStats(); window.renderRegList(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "registrationRequests"), (snap) => { registrationRequests = snap.docs.map(d => ({id:d.id,...d.data()})); window.renderRegistrationRequests?.(); window.updateStats(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "registrationApplications"), (snap) => { registrationApplications = snap.docs.map(d => ({id:d.id,...d.data()})); window.renderAdvancedRegistration?.(); }));
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "registration_config"), (d) => { registrationConfig = normalizeRegistrationConfig(d.exists()?d.data():{}); window.renderAdvancedRegistration?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "teamRegistrationPolicies"), (snap) => { teamRegistrationPolicies = snap.docs.map(d => ({id:d.id,...d.data()})); window.renderAdvancedRegistration?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "results"), (snap) => { results = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.adminSharedState.update({ results }); window.updateStats(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "judgeAssignments"), (snap) => { judgeAssignments = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.adminSharedState.update({ judgeAssignments }); window.renderJudgeAssignments?.(); window.renderJudgeAssignmentOptions?.(); window.renderJudgeStats?.(); window.updateStats(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "judges"), (snap) => { judges = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.renderJudgePanel?.(); window.renderJudgeAssignmentOptions?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "judgeScores"), (snap) => { judgeScores = snap.docs.map(d => ({ id: d.id, ...d.data() })); syncPublicJudgingStatuses(judgeScores).catch(error => console.error('Unable to sync public judging statuses', error)); window.renderJudgeReview?.(); window.renderJudgeAssignments?.(); window.renderJudgeStats?.(); window.updateStats(); }));
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "home_config"), (d) => { homeConfig = d.exists() ? d.data() : {}; applyAdminLoaderBranding(homeConfig); window.renderPublicContentForm?.(); }));
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "public_config"), (d) => { publicConfig = d.exists() ? d.data() : {}; window.renderPublicContentForm?.(); }));
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "tv_config"), (d) => { tvConfig = d.exists() ? d.data() : {}; window.renderPublicContentForm?.(); }));
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "scoring_rules"), (d) => { scoringRules = d.exists() ? d.data() : {}; window.renderScoringRules?.(); }));
    window.adminUnsubscribers.push(onSnapshot(doc(db, "settings", "schedule_config"), (d) => { scheduleConfig = d.exists() ? d.data() : {}; window.renderSchedule?.(); window.renderScheduleConfig?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "scheduleBreaks"), (snap) => { scheduleBreaks = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.renderSchedule?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "scheduleVersions"), (snap) => { scheduleVersions = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => Number(b.version || 0) - Number(a.version || 0)); window.renderScheduleReview?.(); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "accessUsers"), (snap) => { accessUsers = snap.docs.map(d => ({ docId: d.id, uid: d.data().authUid || d.id, ...d.data() })); window.renderAccessManagement?.(); window.renderRegList?.(true); }));
    window.adminUnsubscribers.push(onSnapshot(collection(db, "teamLeaders"), (snap) => { teamLeaders = snap.docs.map(d => ({ id: d.id, ...d.data() })); window.renderAccessManagement?.(); }));
    adminDependencyStatusPromise.then(() => window.lucide?.createIcons?.());
}
const generateHash = (data) => JSON.stringify(data).length;
window.escapeHtml = window.escapeHtml || escapeHtml;
window.jsAttr = window.jsAttr || jsAttr;
window.normalizeStageValue = window.normalizeStageValue || normalizeStageValue;
window.adminSharedState = window.adminSharedState || (() => {
    const state = {};
    return {
        update(patch) {
            Object.assign(state, patch);
            window.dispatchEvent(new CustomEvent('admin-shared-state', { detail: { ...state } }));
        },
        snapshot: () => ({ ...state })
    };
})();

window.addEventListener('admin-auth-logout', () => { adminListenersStarted = false; });
initAdminAuth({ onReady: startAdminSession });

const setLoading = (btnId, isLoading, text='Save') => {
    const btn = document.getElementById(btnId); if(!btn) return;
    if(isLoading) { btn.disabled = true; btn.classList.add('opacity-75', 'cursor-not-allowed', 'is-loading'); btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 mr-2"></i> Processing...`; }
    else { btn.disabled = false; btn.classList.remove('opacity-75', 'cursor-not-allowed', 'is-loading'); btn.innerHTML = `<i data-lucide="check" class="w-4 h-4 mr-2"></i> ${text}`; setTimeout(() => window.lucide?.createIcons?.(), 100); }
    window.lucide?.createIcons?.();
};

window.showToast = (msg, type='success') => {
    const c = document.getElementById('toast-container'); const d = document.createElement('div');
    d.className = `${type==='success'?'bg-slate-800':'bg-red-600'} text-white px-5 py-3 rounded-xl shadow-lg shadow-slate-300/50 flex items-center gap-3 animate-enter mx-auto w-full md:w-auto`;
    d.innerHTML = `<i data-lucide="${type==='success'?'check':'alert-circle'}" class="w-5 h-5 flex-shrink-0"></i>`;
    const text = document.createElement('span'); text.className = 'text-sm font-bold'; text.textContent = msg; d.appendChild(text);
    c.appendChild(d); setTimeout(()=>d.remove(),3000); window.lucide?.createIcons?.();
};

window.confirmAction = (msg, options = {}) => {
    return new Promise((res) => {
        const m = document.getElementById('confirm-modal'), ok = document.getElementById('confirm-ok'), cancel = document.getElementById('confirm-cancel');
        document.getElementById('confirm-msg').innerText = msg;
        const oldOk = ok.textContent, oldCancel = cancel.textContent;
        ok.textContent = options.okText || oldOk;
        cancel.textContent = options.cancelText || oldCancel;
        m.classList.remove('hidden');
        const y = () => { clean(); res(true); }; const n = () => { clean(); res(false); };
        const clean = () => { ok.removeEventListener('click', y); cancel.removeEventListener('click', n); ok.textContent = oldOk; cancel.textContent = oldCancel; m.classList.add('hidden'); };
        ok.addEventListener('click', y); cancel.addEventListener('click', n);
    });
};

window.promptAction = (title, defaultVal = '') => {
    return new Promise((res) => {
        const m = document.getElementById('prompt-modal'); const inp = document.getElementById('prompt-input');
        document.getElementById('prompt-title').innerText = title; inp.value = defaultVal; m.classList.remove('hidden'); inp.focus();
        const y = () => { clean(); res(inp.value.trim()); }; const n = () => { clean(); res(null); };
        const clean = () => { document.getElementById('prompt-ok').removeEventListener('click', y); document.getElementById('prompt-cancel').removeEventListener('click', n); m.classList.add('hidden'); };
        document.getElementById('prompt-ok').addEventListener('click', y); document.getElementById('prompt-cancel').addEventListener('click', n);
    });
};


const adminInputActions = {
    'render-registration-requests': () => window.renderRegistrationRequests(),
    'toggle-registration-application-selection': (target) => window.toggleRegistrationApplicationSelection(target),
    'render-registration-downloads': () => window.renderRegistrationDownloads(),
    'render-final-entries-download-preview': () => window.renderFinalEntriesDownloadPreview(),
    'populate-reg-events': () => window.populateRegEvents(),
    'render-reg-list': () => window.renderRegList(true),
    'preview-chest-no': () => window.previewChestNo(),
    'render-student-table': () => window.renderStudentTable(true),
    'render-participants': () => window.renderParticipants(),
    'filter-event-field-rules': () => window.filterEventFieldRules(),
    'toggle-event-config': (target) => window.toggleEventConfig(target),
    'update-event-method-fields': (target) => window.updateEventMethodFields(target),
    'render-event-table': () => window.renderEventTable(true),
    'schedule-filter': () => window.applyScheduleFilters(),
    'render-schedule-review': () => window.renderScheduleReview(),
    'select-schedule-version': (target) => window.selectScheduleVersion(target.value),
    'toggle-schedule-select-all': () => window.toggleScheduleSelectAll(),
    'render-scoring-config': () => window.renderScoringConfig(),
    'render-judge-assignment-options': () => window.renderJudgeAssignmentOptions(),
    'render-judge-review': () => window.renderJudgeReview(),
    'update-promo': () => window.updatePromo(),
    'render-id-cards': () => window.renderIDCards(),
    'apply-template': (target) => window.applyTemplate(target.dataset.templateTarget, target),
    'toggle-access-team': () => window.toggleAccessTeamField(),
    'save-team-color': (target) => window.saveTeamColor(target.dataset.team, target.value),
    'save-team-display-name': (target) => window.saveTeamDisplayName(target.dataset.team),
    'save-category-display-name': (target) => window.saveCategoryDisplayName(target.dataset.category),
    'apply-master-preset': (target) => window.applyMasterPreset(target.value),
    'apply-scoring-policy-pack': (target) => window.applyScoringPolicyPack(target.value),
    'open-native-picker': (target) => openNativePicker(target)
};

const routeAdminInputAction = (event, attr) => {
    const target = event.target.closest(`[${attr}]`);
    if(!target) return;
    const action = target.getAttribute(attr);
    adminInputActions[action]?.(target);
};
document.addEventListener('change', (event) => routeAdminInputAction(event, 'data-admin-change'));
document.addEventListener('input', (event) => routeAdminInputAction(event, 'data-admin-input'));
document.addEventListener('keyup', (event) => routeAdminInputAction(event, 'data-admin-keyup'));
document.addEventListener('focusin', (event) => routeAdminInputAction(event, 'data-admin-focus'));
document.addEventListener('click', (event) => routeAdminInputAction(event, 'data-admin-click'));

document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-admin-action]');
    if(!btn) return;
    event.preventDefault();
    const d = btn.dataset;
    const actions = {
        'close-sidebar': () => window.closeSidebar(),
        'open-sidebar': () => window.openSidebar(),
        'toggle-desktop-sidebar': () => window.toggleDesktopSidebar(),
        'switch-tab': () => window.switchTab(d.tab),
        'switch-master-section': () => window.switchMasterSection(d.section),
        'set-guide-language': () => window.setGuideLanguage(d.language),
        'copy-page-link': () => window.copyPageLink(d.url),
        'toggle-bulk': () => window.toggleBulkMode(),
        'download-student-template': () => window.openStudentTemplate(),
        'close-student-template': () => window.closeStudentTemplate(),
        'confirm-student-template': () => window.downloadStudentTemplate(),
        'open-student-import': () => window.openStudentImport(),
        'close-student-import': () => window.closeStudentImport(),
        'confirm-student-import': () => window.confirmStudentImport(),
        'add-student-field': () => window.addStudentField(),
        'edit-student-field': () => window.editStudentField(d.key),
        'remove-student-field': () => window.removeStudentField(d.key),
        'toggle-event-bulk': () => window.toggleEventBulkMode(),
        'open-event-template':()=>window.openEventTemplate(),
        'close-event-template':()=>window.closeEventTemplate(),
        'download-event-template':()=>window.downloadEventTemplate(),
        'open-event-import':()=>window.openEventImport(),
        'close-event-import':()=>window.closeEventImport(),
        'confirm-event-import':()=>window.confirmEventImport(),
        'download-event-errors':()=>window.downloadEventErrors(),
        'refresh-event-import-history':()=>window.renderEventImportHistory(),
        'clear-event-optional-filters':()=>window.clearEventOptionalFilters(),
        'open-event-criteria':()=>window.openEventCriteria(Number(d.index)),
        'close-event-criteria':()=>window.closeEventCriteria(),
        'add-event-criterion':()=>window.addEventCriterion(),
        'save-event-criteria':()=>window.saveEventCriteria(),
        'export-events':()=>window.exportEvents(),
        'clear-participant-form': () => window.clearParticipantForm(),
        'edit-participant': () => window.editParticipant(d.id),
        'delete-participant': () => window.deleteParticipant(d.id),
        'export-csv': () => window.exportToCSV(),
        'add-item': () => window.addItem(d.type, d.input),
        'create-team': () => window.createTeam(),
        'save-team-display-name': () => window.saveTeamDisplayName(d.team),
        'save-category-display-name': () => window.saveCategoryDisplayName(d.category),
        'save-chest-config': () => window.saveChestNoConfig(),
        'save-master-setup': () => window.saveMasterSetup(),
        'apply-event-profile': () => window.applyEventProfile(d.profile),
        'filter-event-rule-status': () => window.setEventFieldStatusFilter(d.status),
        'switch-public-view-panel': () => window.switchPublicViewPanel(d.panel),
        'move-public-view-item': () => window.movePublicViewItem(d.group, d.key, Number(d.direction)),
        'reset-public-view-order': () => window.resetPublicViewOrder(d.group),
        'add-participant-type': () => window.addMasterParticipantType(),
        'edit-participant-type': () => window.editMasterParticipantType(d.key),
        'remove-participant-type': () => window.removeMasterParticipantType(d.key),
        'show-master-info': () => window.showMasterInfo(d.info, btn),
        'close-master-info': () => window.closeMasterInfo(),
        'clear-master-info': () => window.clearMasterInfo(),
        'enable-chest-edit': () => window.enableChestNoEdit(),
        'clear-reset-scope': () => window.clearResetScope(d.scope),
        'delete-team-data': () => window.deleteTeamData(),
        'factory-reset': () => window.factoryReset(),
        'approve-registration-request': () => window.approveRegistrationRequest(d.id),
        'reject-registration-request': () => window.rejectRegistrationRequest(d.id),
        'approve-portal-application': () => window.approvePortalApplication(d.id),
        'reject-portal-application': () => window.rejectPortalApplication(d.id),
        'view-registration-application': () => window.viewRegistrationApplication(d.id, d.source),
        'close-application-detail': () => window.closeRegistrationApplicationDetail(),
        'decide-registration-application': () => window.decideRegistrationApplication(d.id, d.status),
        'delete-registration-application': () => window.deleteRegistrationApplication(d.id, d.source),
        'bulk-registration-application': () => window.bulkRegistrationApplicationAction(d.bulkAction),
        'clear-registration-application-selection': () => window.clearRegistrationApplicationSelection(),
        'toggle-final-entry-event': () => window.toggleFinalEntryEvent(d.id),
        'cancel-registration-event': () => window.cancelRegistrationEvent(d.id),
        'undo-registration-event-cancel': () => window.undoRegistrationEventCancel(d.id),
        'preview-registration-pdf': () => window.previewRegistrationPdf(),
        'download-registration-pdf': () => window.downloadRegistrationPdf(),
        'print-registration-pdf': () => window.printRegistrationPdf(),
        'close-registration-pdf': () => window.closeRegistrationPdf(),
        'export-registration-excel': () => window.exportRegistrationExcel(),
        'add-student': () => window.addStudent(),
        'publish-result': () => window.publishResult(),
        'render-schedule': () => window.renderSchedule(),
        'save-bulk-schedule': () => window.saveBulkSchedule(),
        'save-basic-program-order': () => window.saveBasicProgramOrder(),
        'move-basic-program': () => window.moveBasicProgram(d.id, Number(d.direction)),
        'discard-schedule-drafts': () => window.discardScheduleDrafts(),
        'clear-schedule-selection': () => window.clearScheduleSelection(),
        'auto-fill-schedule': () => window.autoFillSchedule(),
        'add-schedule-day': () => window.addScheduleDay(),
        'add-schedule-stage': () => window.addScheduleStage(),
        'add-schedule-duration': () => window.addScheduleDuration(),
        'remove-schedule-day': () => window.removeScheduleSetup('day', d.id),
        'remove-schedule-stage': () => window.removeScheduleSetup('stage', d.id),
        'remove-schedule-duration': () => window.removeScheduleSetup('duration', d.id),
        'save-schedule-master': () => window.saveScheduleMaster(),
        'add-inline-break': () => window.addInlineBreak(d.id),
        'clear-builder-row': () => window.clearBuilderRow(d.id),
        'save-schedule-row': () => window.saveScheduleRow(d.id),
        'edit-schedule-break-row': () => window.editScheduleBreakRow(d.id),
        'delete-schedule-break-row': () => window.deleteScheduleBreakRow(d.id),
        'export-schedule-excel': () => window.exportScheduleExcel(),
        'export-schedule-review-excel': () => window.exportScheduleReviewExcel(),
        'preview-schedule-pdf': () => window.previewSchedulePdf(d.exportMode || 'full'),
        'download-schedule-pdf': () => window.downloadSchedulePdf(),
        'print-schedule-preview': () => window.printSchedulePreview(),
        'close-schedule-pdf': () => window.closeSchedulePdf(),
        'save-registration-lock': () => window.saveRegistrationLock(),
        'open-final-entries-download': () => window.openFinalEntriesDownload(),
        'cleanup-duplicate-final-entries': () => window.cleanupDuplicateFinalEntries(),
        'close-final-entries-download': () => window.closeFinalEntriesDownload(),
        'download-final-entries-excel': () => window.downloadFinalEntriesExcel(),
        'download-final-entries-pdf': () => window.downloadFinalEntriesPdf(),
        'save-advanced-registration': () => window.saveAdvancedRegistration(),
        'switch-registration-admin-tab': () => window.switchRegistrationAdminTab(d.subtab),
        'save-schedule-config': () => window.saveScheduleConfig(),
        'save-scoring': () => window.saveScoringRules(),
        'save-judge-assignment': () => window.saveJudgeAssignment(),
        'switch-judge-subtab': () => window.switchJudgeSubtab(d.subtab),
        'save-tv': () => window.saveTVConfig(),
        'exit-tv': () => window.exitTV(),
        'download-poster': () => window.downloadPoster(),
        'print-window': () => printPage('id'),
        'generate-certificates': () => window.generateCertificates(),
        'export-data': () => window.exportData(d.export),
        'close-edit-student': () => window.closeEditStudentModal(),
        'close-edit-event': () => window.closeEditEventModal(),
        'reject-student': () => window.rejectStudent(d.regId, d.studentId, d.team, d.eventName, d.studentName, d.eventId),
        'reject-team': () => window.rejectTeam(d.regId, d.team, d.eventName, d.eventId),
        'edit-student': () => window.openEditStudent(d.id),
        'delete-student': () => window.deleteStudent(d.id),
        'edit-event': () => window.openEditEvent(d.id),
        'delete-event': () => window.deleteEvent(d.id),
        'edit-item': () => window.editItem(d.type, d.value),
        'remove-item': () => window.removeItem(d.type, d.value),
        'add-point-rule': () => window.addPointRuleRow(d.type),
        'add-grade-rule': () => window.addGradeRuleRow(d.type),
        'remove-score-row': () => window.removeScoreRow(btn),
        'deactivate-judge': () => window.deactivateJudge(d.id),
        'edit-judge-assignment': () => window.editJudgeAssignment(d.id),
        'remove-judge-assignment': () => window.removeJudgeAssignment(d.id),
        'reopen-judge-score': () => window.reopenJudgeScore(d.id),
        'save-public-content': () => window.savePublicContentConfig(),
        'save-tv-display': () => window.saveTVDisplaySettings(),
        'save-team-logo': () => window.saveTeamLogo(d.team),
        'save-team-id-header': () => window.saveTeamIdHeader(d.team),
        'open-team-id-cards': () => window.openTeamIdCards(d.team),
        'close-team-id-cards': () => window.closeTeamIdCards(),
        'download-team-id-cards': () => window.downloadTeamIdCards(),
        'add-custom-landing-link': () => window.addCustomLandingLink(),
        'remove-custom-landing-link': () => window.removeCustomLandingLink(d.index),
        'save-access-user': () => window.saveAccessUser(),
        'set-access-list-filter': () => window.setAccessListFilter(d.filter),
        'edit-access-user': () => window.editAccessUser(d.uid),
        'delete-access-user': () => window.deleteAccessUser(d.uid),
        'toggle-access-active': () => window.toggleAccessActive(d.uid)
    };
    actions[d.adminAction]?.();
});

window.copyPageLink = async (path) => {const url=new URL(path,window.location.href).href;try{await navigator.clipboard.writeText(url);}catch(_){const input=document.createElement('textarea');input.value=url;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();document.execCommand('copy');input.remove();}window.showToast?.('Page link copied');};

window.setGuideLanguage = (language = 'en') => {const selected=language==='ml'?'ml':'en';sessionStorage.setItem('adminGuideLanguage',selected);document.querySelectorAll('[data-guide-language]').forEach(section=>section.classList.toggle('hidden',section.dataset.guideLanguage!==selected));const en=document.getElementById('guide-language-en'),ml=document.getElementById('guide-language-ml');[[en,'en'],[ml,'ml']].forEach(([button,value])=>{if(!button)return;const active=value===selected;button.classList.toggle('bg-indigo-600',active);button.classList.toggle('text-white',active);button.classList.toggle('text-slate-600',!active);button.setAttribute('aria-pressed',String(active));});const title=document.querySelector('[data-guide-title]'),subtitle=document.querySelector('[data-guide-subtitle]');if(title)title.textContent=selected==='ml'?'ഉപയോഗ മാർഗ്ഗനിർദ്ദേശം':'User Guide';if(subtitle)subtitle.textContent=selected==='ml'?'ആപ്ലിക്കേഷന്റെ modes, roles, എല്ലാ ഭാഗങ്ങളും മനസ്സിലാക്കുക.':'Learn every mode, role and workspace in this application.';window.lucide?.createIcons?.();};

window.updateStats = () => {
    if(document.getElementById('stat-students')) document.getElementById('stat-students').innerText = students.length;
    if(document.getElementById('stat-events')) document.getElementById('stat-events').innerText = events.length;
    if(document.getElementById('stat-regs')) document.getElementById('stat-regs').innerText = registrations.length;
    if(document.getElementById('stat-results')) document.getElementById('stat-results').innerText = results.length;
    window.renderAdminReadiness?.();
};

window.renderAdminReadiness = () => {
    const grid = document.getElementById('admin-attention-grid');
    if(!grid) return;
    const activeEvents = events.filter(event => !['draft', 'archived'].includes(event.status));
    const scheduled = activeEvents.filter(event => event.scheduleDate && event.time).length;
    const assignedEventIds = new Set(judgeAssignments.filter(item => item.active !== false).map(item => item.eventId));
    const judgedEventIds = new Set(judgeScores.filter(item => item.status === 'submitted').map(item => item.eventId));
    const publishedEventIds = new Set(results.filter(item => item.status === 'published').map(item => item.eventId || item.id));
    const pendingRequests = registrationRequests.filter(item => (item.status || 'pending') === 'pending').length;
    const checks = [
        { label:'Pending requests', count:pendingRequests, tab:'participants', icon:'clipboard-list', ready:pendingRequests === 0 },
        { label:'Events not scheduled', count:Math.max(0, activeEvents.length - scheduled), tab:'schedule', icon:'calendar-clock', ready:activeEvents.length > 0 && scheduled === activeEvents.length },
        { label:'Events without judges', count:activeEvents.filter(item => !assignedEventIds.has(item.id) && item.resultWorkflow !== 'direct').length, tab:'judge', icon:'scale', ready:activeEvents.length > 0 && activeEvents.every(item => assignedEventIds.has(item.id) || item.resultWorkflow === 'direct') },
        { label:'Submitted to publish', count:[...judgedEventIds].filter(id => !publishedEventIds.has(id)).length, tab:'judge', icon:'send', ready:[...judgedEventIds].every(id => publishedEventIds.has(id)) }
    ];
    const foundation = [teams.length > 0, categories.length > 0, students.length > 0, activeEvents.length > 0];
    const score = [...foundation, ...checks.map(item => item.ready)].filter(Boolean).length;
    const percent = Math.round(score / (foundation.length + checks.length) * 100);
    document.getElementById('admin-readiness-percent').textContent = `${percent}%`;
    document.getElementById('admin-readiness-bar').style.width = `${percent}%`;
    document.getElementById('admin-readiness-summary').textContent = percent === 100 ? 'Festival configuration and operational queues are ready.' : `${foundation.filter(Boolean).length}/${foundation.length} setup foundations complete • ${checks.filter(item => !item.ready).length} queues need attention`;
    grid.innerHTML = checks.map(item => `<button data-admin-action="switch-tab" data-tab="${item.tab}" class="flex items-center gap-3 rounded-xl border ${item.ready?'border-emerald-100 bg-emerald-50':'border-amber-100 bg-white'} p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm"><span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg ${item.ready?'bg-emerald-100 text-emerald-700':'bg-amber-50 text-amber-700'}"><i data-lucide="${item.ready?'check':item.icon}" class="h-4 w-4"></i></span><span class="min-w-0"><strong class="block text-lg font-black text-slate-900">${item.count}</strong><span class="block truncate text-[11px] font-bold text-slate-500">${item.label}</span></span></button>`).join('');
    window.lucide?.createIcons?.();
};

window.openSidebar = () => { document.getElementById('sidebar').classList.remove('sidebar-closed'); document.getElementById('sidebar').classList.add('sidebar-open'); document.getElementById('sidebar-overlay').classList.remove('hidden'); document.body.classList.add('sidebar-open-btn'); };
window.closeSidebar = () => { document.getElementById('sidebar').classList.remove('sidebar-open'); document.getElementById('sidebar').classList.add('sidebar-closed'); document.getElementById('sidebar-overlay').classList.add('hidden'); document.body.classList.remove('sidebar-open-btn'); };

const applyDesktopSidebarState = (collapsed) => {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('desktop-sidebar-toggle');
    if(!sidebar || !toggle) return;
    sidebar.classList.toggle('desktop-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggle.innerHTML = `<i data-lucide="${collapsed ? 'panel-left-open' : 'panel-left-close'}" class="h-5 w-5"></i>`;
    window.lucide?.createIcons?.();
};

window.toggleDesktopSidebar = () => {
    if(!window.matchMedia('(min-width: 768px)').matches) return;
    const collapsed = !document.getElementById('sidebar')?.classList.contains('desktop-collapsed');
    applyDesktopSidebarState(collapsed);
    localStorage.setItem('adminSidebarCollapsed', String(collapsed));
};

document.querySelectorAll('#sidebar .nav-item, #sidebar > div:last-child a').forEach(item => {
    const label = item.querySelector('.sidebar-label')?.textContent?.trim();
    if(label) {
        item.title = label;
        item.setAttribute('aria-label', label);
    }
});
applyDesktopSidebarState(localStorage.getItem('adminSidebarCollapsed') === 'true');



const resetAdminContentScroll = () => {
    const run = () => {
        const content = document.getElementById('content-container');
        if(content) { content.scrollTop = 0; content.scrollLeft = 0; content.scrollTo?.({ top: 0, left: 0, behavior: 'auto' }); }
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        document.querySelectorAll('.admin-tool-shell').forEach(el => { el.scrollTop = 0; });
    };
    run();
    requestAnimationFrame(run);
    setTimeout(run, 80);
    setTimeout(run, 240);
    setTimeout(run, 700);
};
window.resetAdminContentScroll = resetAdminContentScroll;

const MASTER_SETUP_SECTIONS={
    overview:{title:'Overview & Preset',description:'Choose the festival operating model and quick preset.'},
    'people-registration':{title:'People & Registration',description:'Configure participant identity, gender divisions, student fields and registration channels.'},
    'public-view':{title:'Public View',description:'Choose the landing navigation, public sections and standalone visitor destinations that are published.'},
    'events-schedule':{title:'Events & Schedule',description:'Enable event-management capabilities and schedule requirements.'},
    'judging-scoring':{title:'Judging & Scoring',description:'Configure result workflow, competition policies, points and grades.'},
    'review-activate':{title:'Review & Activate',description:'Review configuration impact and validate the setup before saving.'}
};
let activeMasterSection=sessionStorage.getItem('adminMasterSection')||'overview';if(activeMasterSection==='people-registration-public')activeMasterSection='people-registration';
const masterDirtySections=new Set();
const setMasterSubnavExpanded=expanded=>{const menu=document.getElementById('master-setup-subnav'),button=document.getElementById('nav-master-setup'),chevron=document.getElementById('master-subnav-chevron');menu?.classList.toggle('hidden',!expanded);menu?.classList.toggle('master-subnav-expanded',expanded);button?.setAttribute('aria-expanded',String(expanded));chevron?.classList.toggle('rotate-180',expanded);};
const updateMasterSubnavStatus=()=>{const missing=typeof competitionPoliciesFromForm==='function'?incompleteCompetitionPolicies(competitionPoliciesFromForm()):[];document.querySelectorAll('.master-subnav-item').forEach(button=>{let badge=button.querySelector('[data-master-status]');if(!badge){badge=document.createElement('span');badge.dataset.masterStatus='true';badge.className='float-right ml-2';button.append(badge);}const invalid=(button.dataset.section==='judging-scoring'||button.dataset.section==='review-activate')&&missing.length;const dirty=masterDirtySections.has(button.dataset.section),state=invalid?'needs attention':dirty?'unsaved changes':'ready';badge.textContent=invalid?'!':dirty?'●':'✓';badge.className=`float-right ml-auto ${invalid?'text-red-500':dirty?'text-amber-500':'text-emerald-500'}`;button.setAttribute('aria-label',`${MASTER_SETUP_SECTIONS[button.dataset.section]?.title||button.dataset.section} — ${state}`);});const status=document.getElementById('page-status');if(status&&document.getElementById('view-master-setup')?.classList.contains('active')){const meta=MASTER_SETUP_SECTIONS[activeMasterSection],issueCount=missing.length;status.textContent=`${festSetup.eventManagementMode?.[0]?.toUpperCase()+festSetup.eventManagementMode?.slice(1)} profile • ${masterDirtySections.size} unsaved section${masterDirtySections.size===1?'':'s'}${issueCount?` • ${issueCount} policy issue${issueCount===1?'':'s'}`:''} • ${meta.description}`;}};
window.switchMasterSection=(section,{scroll=true}={})=>{if(!MASTER_SETUP_SECTIONS[section])section='overview';activeMasterSection=section;sessionStorage.setItem('adminMasterSection',section);setMasterSubnavExpanded(true);document.querySelectorAll('#view-master-setup [data-master-section]').forEach(element=>element.classList.toggle('hidden',element.dataset.masterSection!==section));document.querySelectorAll('#view-master-setup [data-master-section-container]').forEach(container=>{const children=[...container.querySelectorAll(':scope > [data-master-section], :scope > div > [data-master-section]')];container.classList.toggle('hidden',children.length>0&&!children.some(child=>child.dataset.masterSection===section));});document.querySelectorAll('.master-subnav-item').forEach(button=>{const active=button.dataset.section===section;button.classList.toggle('bg-indigo-50',active);button.classList.toggle('text-indigo-700',active);button.classList.toggle('text-slate-500',!active);button.setAttribute('aria-current',active?'page':'false');});const meta=MASTER_SETUP_SECTIONS[section];const context=document.getElementById('page-context'),status=document.getElementById('page-status');if(context){context.textContent=`/ ${meta.title}`;context.classList.remove('hidden');}if(status){status.textContent=`${festSetup.eventManagementMode?.[0]?.toUpperCase()+festSetup.eventManagementMode?.slice(1)} profile • ${masterDirtySections.size} unsaved section${masterDirtySections.size===1?'':'s'} • ${meta.description}`;status.classList.remove('hidden');}closeMasterInfo();const url=new URL(location.href);url.searchParams.set('tab','master-setup');url.searchParams.set('section',section);history.replaceState(null,'',url);updateMasterSubnavStatus();if(scroll)resetAdminContentScroll();window.lucide?.createIcons?.();};

window.switchTab = (tab) => {
    document.querySelectorAll('.tab-view').forEach(e => { e.classList.remove('active'); e.classList.add('hidden'); e.style.display = 'none'; });
    const target = document.getElementById('view-'+tab);
    if(target) { target.classList.remove('hidden'); target.classList.add('active'); target.style.display = 'block'; }
    document.querySelectorAll('#sidebar .nav-item').forEach(b => { b.classList.remove('bg-indigo-50', 'text-indigo-600'); b.classList.add('text-slate-600'); if(b.id === 'nav-danger') { b.classList.remove('bg-red-100', 'text-red-700'); b.classList.add('bg-red-50', 'text-red-600'); }});
    const btn = document.getElementById('nav-'+tab);
    if(btn) {
        if(tab === 'danger') { btn.classList.remove('bg-red-50', 'text-red-600'); btn.classList.add('bg-red-100', 'text-red-700'); }
        else { btn.classList.add('bg-indigo-50', 'text-indigo-600'); btn.classList.remove('text-slate-600'); }
    }
    setMasterSubnavExpanded(tab==='master-setup');
    if(tab==='master-setup')window.switchMasterSection(new URL(location.href).searchParams.get('section')||activeMasterSection,{scroll:false});
    if(window.innerWidth < 768) window.closeSidebar();

    const titles = { 'dashboard': 'Dashboard', 'registrations': 'Registrations', 'students': 'Students Directory', 'participants':'Participant Directory', 'events': 'Events Management', 'schedule': 'Time Schedule', 'config': 'Team Setup', 'master-setup': 'Master Setup', 'access': 'Access Management', 'scoring': 'Scoring Settings', 'judge': 'Judgement Desk', 'public-content': 'Public Page Control & Contents', 'poster-certificate':'Poster & Certificate', 'tv-display': 'TV Display Settings', 'danger': 'Data Reset', 'guide': 'User Guide' };
    document.getElementById('page-title').innerText = titles[tab] || 'Admin Panel';const masterActive=tab==='master-setup';document.getElementById('master-header-actions')?.classList.toggle('hidden',!masterActive);document.getElementById('master-header-actions')?.classList.toggle('flex',masterActive);if(!masterActive){document.getElementById('page-context')?.classList.add('hidden');document.getElementById('page-status')?.classList.add('hidden');}
    if(tab === 'students') renderStudentTable(); if(tab === 'participants') window.renderParticipants?.(); if(tab === 'events'){window.renderEventEligibilityCheckboxGroups?.();renderEventTable();window.renderEventImportHistory?.();} if(tab === 'schedule') window.renderSchedule(); if(tab === 'registrations') renderRegList(); if(tab === 'access') window.renderAccessManagement?.(); if(tab === 'scoring') window.renderScoringRules?.(); if(tab === 'judge') window.renderJudgePanel?.(); if(tab === 'master-setup') window.renderMasterSetup?.(); if(tab === 'public-content' || tab === 'tv-display') window.renderPublicContentForm?.(); if(tab === 'guide') window.setGuideLanguage(sessionStorage.getItem('adminGuideLanguage') || 'en');
    resetAdminContentScroll();
};

const bindStaticTabNavigation = () => {
    document.querySelectorAll('[data-admin-action="switch-tab"]').forEach(btn => {
        if(btn.dataset.tabBound === 'true') return;
        btn.dataset.tabBound = 'true';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.switchTab(btn.dataset.tab);
        }, { capture: true });
    });
};
bindStaticTabNavigation();

window.renderDropdowns = () => {
    const studentCategories = categories.filter(c => c !== 'General');
    const studentCatOpts = studentCategories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(categoryLabel(c))} (${escapeHtml(c)})</option>`).join('');
    const eventCatOpts = categories.filter(c => c !== 'General').map(c => `<option value="${escapeHtml(c)}">${escapeHtml(categoryLabel(c))} (${escapeHtml(c)})</option>`).join('');
    const teamOpts = teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(teamLabel(t))} (${escapeHtml(t)})</option>`).join('');
    const updateSelect = (selector, html) => { document.querySelectorAll(selector).forEach(s => { const old = s.value; s.innerHTML = html; if(old && Array.from(s.options).some(o => o.value === old)) s.value = old; }); };
    updateSelect('.select-cat', '<option value="">Select Category</option>' + studentCatOpts);
    updateSelect('.select-team', '<option value="">Select Team</option>' + teamOpts);
    updateSelect('.select-cat-filter', '<option value="">All Categories</option><option value="General" class="font-bold text-indigo-600">General</option>' + eventCatOpts);
    updateSelect('.select-cat-filter-directory', '<option value="">All Categories</option>' + studentCatOpts);
    updateSelect('.select-team-filter', '<option value="">All Teams</option>' + teamOpts);
    updateSelect('.select-cat-create', '<option value="General" class="font-bold text-indigo-600">General</option>' + eventCatOpts);
};


const normalizeScheduleStage = (stage = '') => String(stage || '').trim().replace(/^Stage\s*/i, '').toLowerCase() || 'all';
const isScheduledEvent = (event = {}) => !!(event.scheduleDate && event.time && (event.scheduleStage || event.stageNo || event.stageNumber || event.stage));
const timeToMinutes = (value = '') => {
    const raw = String(value || '').trim();
    const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if(ampm) {
        let hour = Number(ampm[1]);
        const minute = Number(ampm[2]);
        const meridian = ampm[3].toUpperCase();
        if(meridian === 'PM' && hour !== 12) hour += 12;
        if(meridian === 'AM' && hour === 12) hour = 0;
        return (hour * 60) + minute;
    }
    const twentyFour = raw.match(/^(\d{1,2}):(\d{2})$/);
    return twentyFour ? (Number(twentyFour[1]) * 60) + Number(twentyFour[2]) : 1439;
};
const scheduleTimeSort = (value = '11:59 PM') => String(timeToMinutes(value)).padStart(4, '0');
const toAmPm = (value = '') => {
    const raw = String(value || '').trim();
    if(!raw) return '';
    if(/\s(AM|PM)$/i.test(raw)) return raw.replace(/\s*(am|pm)$/i, (_, m) => ` ${m.toUpperCase()}`);
    const match = raw.match(/^(\d{1,2}):(\d{2})$/);
    if(!match) return raw;
    let hour = Number(match[1]);
    const minute = match[2];
    const meridian = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return `${hour}:${minute} ${meridian}`;
};
const datePartsFromIso = (date = '') => {
    const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? { year: match[1], month: match[2], day: match[3] } : null;
};
const dateDisplay = (date = '') => {
    const parts = datePartsFromIso(date);
    return parts ? `${parts.day}/${parts.month}/${parts.year}` : (date || 'No date');
};
const dateWeekday = (date = '') => {
    const parts = datePartsFromIso(date);
    if(!parts) return '';
    const parsed = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('en-IN', { weekday: 'long' }).format(parsed);
};
const scheduleDateText = (date) => [dateDisplay(date), dateWeekday(date)].filter(Boolean).join(' ');
const parseScheduleWhen = (value = '') => {
    const raw = String(value || '').trim();
    const nativeMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if(nativeMatch) {
        const [, yyyy, mm, dd, hh, min] = nativeMatch;
        return { date: `${yyyy}-${mm}-${dd}`, time: toAmPm(`${hh}:${min}`) };
    }
    const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if(!match) return null;
    const [, dd, mm, yyyy, hh, min, meridian] = match;
    return { date: `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`, time: toAmPm(`${hh}:${min} ${meridian.toUpperCase()}`) };
};
const time24FromAmPm = (value = '') => {
    const minutes = timeToMinutes(value);
    if(minutes < 0) return '';
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const formatScheduleWhen = (date = '', time = '') => date ? `${date}T${time24FromAmPm(time || '00:00') || '00:00'}` : '';
const formatTimeInput = (time = '') => time24FromAmPm(time);
const openNativePicker = (el) => { if(el?.showPicker) { try { el.showPicker(); } catch(_) {} } };

const defaultScheduleConfig = () => ({ title: 'TIME SCHEDULE', nbText: 'Participants must report before the program time.' });
window.renderBasicProgramOrder = () => {const box=document.getElementById('basic-program-order-list');if(!box)return;const schedulableEvents=events.filter(event=>event.cancelled!==true);if(!basicOrderDraft.length||basicOrderDraft.some(id=>!schedulableEvents.some(event=>event.id===id)))basicOrderDraft=schedulableEvents.slice().sort((a,b)=>Number(a.scheduleOrder||9999)-Number(b.scheduleOrder||9999)||a.name.localeCompare(b.name)).map(event=>event.id);box.innerHTML=basicOrderDraft.map((id,index)=>{const event=events.find(item=>item.id===id);return `<div class="flex items-center gap-3 rounded-xl border bg-slate-50 p-3"><span class="grid h-9 w-9 place-items-center rounded-lg bg-indigo-600 text-sm font-black text-white">${index+1}</span><div class="min-w-0 flex-1"><p class="truncate font-black">${escapeHtml(event?.name||'Program')}</p><p class="text-[10px] font-bold text-slate-400">${escapeHtml(event?.category||'')} • ${escapeHtml(genderLabel(event))}</p></div><button data-admin-action="move-basic-program" data-id="${id}" data-direction="-1" ${index===0?'disabled':''} class="rounded-lg border bg-white p-2 disabled:opacity-30"><i data-lucide="arrow-up" class="h-4 w-4"></i></button><button data-admin-action="move-basic-program" data-id="${id}" data-direction="1" ${index===basicOrderDraft.length-1?'disabled':''} class="rounded-lg border bg-white p-2 disabled:opacity-30"><i data-lucide="arrow-down" class="h-4 w-4"></i></button></div>`}).join('')||'<p class="py-8 text-center font-bold text-slate-400">Add events first.</p>';window.lucide?.createIcons?.();};
window.moveBasicProgram=(id,direction)=>{const index=basicOrderDraft.indexOf(id),next=index+direction;if(index<0||next<0||next>=basicOrderDraft.length)return;[basicOrderDraft[index],basicOrderDraft[next]]=[basicOrderDraft[next],basicOrderDraft[index]];window.renderBasicProgramOrder();};
window.saveBasicProgramOrder=async()=>{const batch=writeBatch(db);basicOrderDraft.forEach((id,index)=>batch.update(doc(db,'events',id),{scheduleOrder:index+1,scheduleStatus:'basic',updatedAt:Date.now()}));await batch.commit();window.showToast('Basic program order saved');};
const scheduleSettings = () => ({ ...defaultScheduleConfig(), ...(scheduleConfig || {}) });
const breakTimeText = (item = {}) => `${item.startTime || ''}${item.endTime ? ` - ${item.endTime}` : ''}`;
const scheduleGenderText = gender => String(gender || 'Both').toLowerCase() === 'boys' ? 'Boys' : String(gender || '').toLowerCase() === 'girls' ? 'Girls' : 'Boys and Girls';
const DEFAULT_COLUMNS = ['category','program','gender','date','time','end','duration','stage'];
const scheduleDrafts = new Map(), scheduleBreakDrafts = new Map(), deletedScheduleBreakIds = new Set(), selectedScheduleRows = new Set();
let scheduleVersions = [], selectedScheduleVersionId = 'latest', visibleScheduleRowIds = [], schedulePdfBlob = null, schedulePdfUrl = '';
const scheduleFilterState = { search:'', status:'', category:'', gender:'', stageType:'', day:'', stage:'' };
const setup = () => ({ days:Array.isArray(scheduleConfig.scheduleDays)?scheduleConfig.scheduleDays:[], stages:Array.isArray(scheduleConfig.scheduleStages)?scheduleConfig.scheduleStages:[], durations:Array.isArray(scheduleConfig.durationPresets)&&scheduleConfig.durationPresets.length?scheduleConfig.durationPresets:[5,10,20,30,60] });
const uid = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
const minutesToTime = value => { const n=((Number(value)||0)+1440)%1440; return toAmPm(`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`); };
const dayFor = id => setup().days.find(item=>item.id===id), stageFor = id => setup().stages.find(item=>item.id===id);
const inferDayId = event => event.scheduleDayId || setup().days.find(item=>item.date===event.scheduleDate)?.id || '';
const inferStageId = event => event.scheduleStageId || setup().stages.find(item=>normalizeScheduleStage(item.name)===normalizeScheduleStage(event.scheduleStage||event.stageNo||event.stageNumber))?.id || '';
const eventDraft = event => ({dayId:inferDayId(event),date:event.scheduleDate||'',stageId:inferStageId(event),stage:event.scheduleStage||event.stageNo||event.stageNumber||'',duration:Number(event.scheduleDuration||10),time:toAmPm(event.time||''),manualStart:false,order:Number(event.scheduleOrder||0),...(scheduleDrafts.get(event.id)||{})});
const breakDraft = item => { const savedIds=Array.isArray(item.stageIds)?item.stageIds:[], savedStages=Array.isArray(item.stages)?item.stages:[]; const inferred=savedIds.length?savedIds:savedStages.length?setup().stages.filter(stage=>savedStages.includes(stage.name)).map(stage=>stage.id):(normalizeScheduleStage(item.stage)==='all'?['__all']:[item.stageId||setup().stages.find(stage=>normalizeScheduleStage(stage.name)===normalizeScheduleStage(item.stage))?.id].filter(Boolean)); const stageIds=inferred.length?inferred:['__all']; const stages=stageIds.includes('__all')?['All Stages']:setup().stages.filter(stage=>stageIds.includes(stage.id)).map(stage=>stage.name); return {id:item.id,title:item.title||'Break',dayId:item.dayId||setup().days.find(day=>day.date===item.date)?.id||'',date:item.date||'',stageIds,stages,stageId:stageIds[0]||'__all',stage:stages.join(', ')||'All Stages',time:toAmPm(item.startTime||''),endTime:toAmPm(item.endTime||''),duration:Math.max(1,timeToMinutes(item.endTime)-timeToMinutes(item.startTime)),afterEventId:item.afterEventId||'',isBreak:true,...(scheduleBreakDrafts.get(item.id)||{})}; };
const rowEnd = row => row.isBreak && row.endTime ? row.endTime : row.time ? minutesToTime(timeToMinutes(row.time)+Number(row.duration||0)) : '';
function candidateRows(){
  const programs=events.filter(event=>event.scheduleRequirement!=='disabled'&&event.cancelled!==true).map((event,index)=>({id:event.id,name:event.name||'',category:event.category||'General',gender:genderLabel(event),stageType:event.stage||'Off-Stage',cancelled:event.cancelled===true,cancelReason:event.cancelReason||'',judgeId:judgeAssignments.find(a=>a.active!==false&&a.eventId===event.id)?.judgeId||'',participantIds:registrations.filter(r=>r.eventId===event.id).flatMap(r=>[...(r.studentIds||[]),...(r.participantIds||[])]),baseOrder:index,...eventDraft(event)}));
  const breaks=[...scheduleBreaks.filter(item=>item.active!==false&&!deletedScheduleBreakIds.has(item.id)).map(breakDraft),...[...scheduleBreakDrafts].filter(([id])=>id.startsWith('new_')).map(([id,item])=>({id,...item,isBreak:true}))];
  const anchored=new Map();breaks.forEach(row=>{const key=row.afterEventId||'__end';(anchored.get(key)||anchored.set(key,[]).get(key)).push(row);});
  const result=[];programs.forEach(row=>{result.push(row);result.push(...(anchored.get(row.id)||[]));});result.push(...(anchored.get('__end')||[]));return result;
}
const rangesOverlap=(a,b)=>a.date&&b.date&&a.date===b.date&&a.time&&b.time&&timeToMinutes(a.time)<timeToMinutes(rowEnd(b))&&timeToMinutes(b.time)<timeToMinutes(rowEnd(a));
function scheduleValidation(rows=candidateRows()){
  const map=new Map(rows.map(row=>[`${row.isBreak?'break:':'event:'}${row.id}`,[]]));
  rows.forEach(row=>{const list=map.get(`${row.isBreak?'break:':'event:'}${row.id}`);if(!row.dayId||!row.date||(!(row.isBreak?(row.stageIds||[]).length:row.stageId))||!row.stage||!row.duration)list.push('Missing day, stage or duration');if(row.time&&rowEnd(row)&&timeToMinutes(rowEnd(row))<=timeToMinutes(row.time))list.push('End time must be after start time');});
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){const a=rows[i],b=rows[j];if(!rangesOverlap(a,b))continue;const stageIds=row=>row.isBreak?(row.stageIds||[]):[row.stageId];const aStages=stageIds(a),bStages=stageIds(b),sameStage=aStages.includes('__all')||bStages.includes('__all')||aStages.some(id=>bStages.includes(id));if(sameStage){map.get(`${a.isBreak?'break:':'event:'}${a.id}`).push(`Stage overlap: ${b.name||b.title}`);map.get(`${b.isBreak?'break:':'event:'}${b.id}`).push(`Stage overlap: ${a.name||a.title}`);}if(!a.isBreak&&!b.isBreak&&a.judgeId&&a.judgeId===b.judgeId){map.get(`event:${a.id}`).push(`Judge overlap: ${b.name}`);map.get(`event:${b.id}`).push(`Judge overlap: ${a.name}`);}if(!a.isBreak&&!b.isBreak&&(a.participantIds||[]).some(id=>(b.participantIds||[]).includes(id))){map.get(`event:${a.id}`).push(`Participant overlap: ${b.name}`);map.get(`event:${b.id}`).push(`Participant overlap: ${a.name}`);}}
  return map;
}
const dirtyCount=()=>scheduleDrafts.size+scheduleBreakDrafts.size+deletedScheduleBreakIds.size;
window.hasUnsavedScheduleChanges=()=>dirtyCount()>0;
function syncFilterState(){scheduleFilterState.search=(document.getElementById('schedule-search')?.value||'').trim().toLowerCase();for(const key of ['status','category','gender','stageType','day','stage']){const ids={category:'schedule-filter-cat',stageType:'schedule-filter-stage-type'};scheduleFilterState[key]=document.getElementById(ids[key]||`schedule-filter-${key}`)?.value||'';}}

const isScheduleBuilderRowScheduled=row=>!!(row.dayId&&row.date&&(row.isBreak?(row.stageIds||[]).length:row.stageId)&&row.duration&&row.time);
const scheduleBuilderSort=(a,b)=>{const aScheduled=isScheduleBuilderRowScheduled(a),bScheduled=isScheduleBuilderRowScheduled(b);return (aScheduled===bScheduled?0:(aScheduled?-1:1))||(String(a.date||'9999-99-99').localeCompare(String(b.date||'9999-99-99')))||(timeToMinutes(a.time||'11:59 PM')-timeToMinutes(b.time||'11:59 PM'))||(String(a.stage||'').localeCompare(String(b.stage||'')))||(Number(a.baseOrder||a.order||0)-Number(b.baseOrder||b.order||0))||(String(a.name||a.title||'').localeCompare(String(b.name||b.title||'')));};
function matchesFilter(row,validation){const f=scheduleFilterState,key=`${row.isBreak?'break:':'event:'}${row.id}`,issues=validation.get(key)||[],scheduled=!!(row.dayId&&row.stageId&&row.duration&&row.time);if(f.search&&!`${row.name||row.title} ${row.category||''} ${row.gender||''} ${row.stage||''}`.toLowerCase().includes(f.search))return false;if(f.status==='scheduled'&&!scheduled)return false;if(f.status==='unscheduled'&&scheduled)return false;if(f.status==='conflict'&&!issues.some(x=>x.includes('overlap')))return false;if(f.status==='changed'&&!((row.isBreak?scheduleBreakDrafts:scheduleDrafts).has(row.id)||deletedScheduleBreakIds.has(row.id)))return false;if(f.category&&!row.isBreak&&row.category!==f.category)return false;if(f.gender&&!row.isBreak&&row.gender!==f.gender)return false;if(f.stageType&&!row.isBreak&&row.stageType!==f.stageType)return false;if(f.day&&row.dayId!==f.day)return false;if(f.stage&&row.stageId!==f.stage)return false;return true;}
const optionHtml=(list,value,label)=>`<option value="">${label}</option>`+list.map(item=>`<option value="${escapeHtml(item.id??item)}" ${String(item.id??item)===String(value)?'selected':''}>${escapeHtml(item.label||item.name||`${item} min`)}</option>`).join('');
const shortScheduleDate=value=>{if(!value)return'';const date=new Date(`${value}T00:00:00`);return Number.isNaN(date.getTime())?value:date.toLocaleDateString('en-IN',{day:'2-digit',month:'short'});};
const dayOptionHtml=(days,value,label='Select Day')=>`<option value="">${label}</option>`+days.map(day=>`<option value="${escapeHtml(day.id)}" ${String(day.id)===String(value)?'selected':''}>${escapeHtml(`${day.label} • ${shortScheduleDate(day.date)}`)}</option>`).join('');
function updateDraft(id,field,value,isBreak=false){const map=isBreak?scheduleBreakDrafts:scheduleDrafts,row=candidateRows().find(x=>x.id===id&&x.isBreak===isBreak),patch={...(map.get(id)||{}),[field]:value};if(field==='dayId'){const day=dayFor(value);patch.date=day?.date||'';}if(field==='stageId'){const stage=stageFor(value);patch.stage=stage?.name||'';}if(field==='stageIds'){const ids=Array.isArray(value)?value:[value];patch.stageIds=ids.includes('__all')?['__all']:ids;patch.stages=patch.stageIds.includes('__all')?['All Stages']:setup().stages.filter(stage=>patch.stageIds.includes(stage.id)).map(stage=>stage.name);patch.stageId=patch.stageIds[0]||'';patch.stage=patch.stages.join(', ');}if(field==='time'){patch.time=toAmPm(value);patch.manualStart=true;}if(field==='duration')patch.duration=Number(value||0);if(field==='endTime'&&row?.isBreak){patch.endTime=toAmPm(value);patch.duration=Math.max(1,timeToMinutes(patch.endTime)-timeToMinutes(patch.time||row.time));}if(row?.isBreak&&['time','duration'].includes(field))patch.endTime=minutesToTime(timeToMinutes(patch.time||row.time)+Number(patch.duration||row.duration));map.set(id,patch);renderScheduleBuilder();}
function actionButton(action,id,icon,title,color='slate'){return `<button data-admin-action="${action}" data-id="${escapeHtml(id)}" class="rounded-lg bg-${color}-50 p-2 text-${color}-700" title="${title}"><i data-lucide="${icon}" class="h-4 w-4"></i></button>`;}
function builderRow(row,validation){const key=`${row.isBreak?'break:':'event:'}${row.id}`,issues=validation.get(key)||[],scheduled=row.dayId&&(row.isBreak?(row.stageIds||[]).length:row.stageId)&&row.duration&&row.time,conflict=issues.some(x=>x.includes('overlap')||x.includes('End time')),status=row.cancelled?'Cancelled':conflict?'Conflict':scheduled?'Scheduled':'Unscheduled',days=setup().days,stages=setup().stages,durations=setup().durations,checked=selectedScheduleRows.has(key),title=row.isBreak?`<input data-schedule-id="${escapeHtml(row.id)}" data-schedule-break="1" data-schedule-field="title" class="text-input min-w-[170px] font-black" value="${escapeHtml(row.title)}"><small class="font-black text-amber-600">BREAK</small>`:`<b>${escapeHtml(row.name)}</b>${row.cancelled?`<span class="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[9px] font-black uppercase text-white">Cancelled</span>`:''}<small class="block text-slate-400">${escapeHtml(row.stageType)}${row.cancelReason?` • ${escapeHtml(row.cancelReason)}`:''}</small>`,actions=row.isBreak?`${actionButton('save-schedule-row',key,'save','Save break','emerald')}${actionButton('edit-schedule-break-row',row.id,'pencil','Edit break','blue')}${actionButton('delete-schedule-break-row',row.id,'trash-2','Delete break','red')}`:`${actionButton('save-schedule-row',key,'save','Save','emerald')}${actionButton('clear-builder-row',row.id,'eraser','Clear Schedule')}${actionButton('add-inline-break',row.id,'coffee','Insert Break','amber')}`;return `<tr class="${row.isBreak?'bg-amber-50/50':row.cancelled?'bg-red-50/70 border-l-4 border-red-500':'bg-white'}"><td class="p-3"><input class="schedule-row-select" data-key="${key}" type="checkbox" ${checked?'checked':''}></td><td class="p-3">${title}</td><td class="p-3 text-[10px] font-bold text-slate-500">${row.isBreak?'':`${escapeHtml(row.category)} • ${escapeHtml(row.gender)}`}</td><td class="p-2"><select data-schedule-id="${escapeHtml(row.id)}" data-schedule-break="${row.isBreak?'1':'0'}" data-schedule-field="dayId" class="text-input min-w-[135px]">${dayOptionHtml(days,row.dayId)}</select></td><td class="p-2">${row.isBreak?`<fieldset data-schedule-stage-group data-id="${escapeHtml(row.id)}" class="min-w-[170px] rounded-xl border bg-white p-2"><legend class="sr-only">Break Stages</legend><label class="mb-1 flex cursor-pointer items-center gap-2 border-b pb-1 text-[9px] font-black text-indigo-700"><input type="checkbox" data-schedule-stage-all ${((row.stageIds||[]).includes('__all')||(stages.length>0&&stages.every(stage=>(row.stageIds||[]).includes(stage.id))))?'checked':''}> All Stages</label>${stages.map(stage=>`<label class="flex min-h-8 cursor-pointer items-center gap-2 text-[10px] font-bold"><input type="checkbox" data-schedule-stage-option value="${escapeHtml(stage.id)}" ${((row.stageIds||[]).includes('__all')||(row.stageIds||[]).includes(stage.id))?'checked':''}> ${escapeHtml(stage.name)}</label>`).join('')}</fieldset>`:`<select data-schedule-id="${escapeHtml(row.id)}" data-schedule-break="0" data-schedule-field="stageId" class="text-input min-w-[135px]">${optionHtml(stages,row.stageId,'Select Stage')}</select>`}</td><td class="p-2"><select data-schedule-id="${escapeHtml(row.id)}" data-schedule-break="${row.isBreak?'1':'0'}" data-schedule-field="duration" class="text-input min-w-[100px]">${optionHtml(durations,row.duration,'Duration')}</select></td><td class="p-2"><input data-schedule-id="${escapeHtml(row.id)}" data-schedule-break="${row.isBreak?'1':'0'}" data-schedule-field="time" type="time" class="text-input min-w-[110px]" value="${escapeHtml(time24FromAmPm(row.time))}"></td><td class="p-2 font-black">${row.isBreak?`<input data-schedule-id="${escapeHtml(row.id)}" data-schedule-break="1" data-schedule-field="endTime" type="time" class="text-input min-w-[110px]" value="${escapeHtml(time24FromAmPm(rowEnd(row)))}">`:escapeHtml(rowEnd(row)||'—')}</td><td class="p-3"><span class="rounded-lg px-2 py-1 text-[9px] font-black ${row.cancelled?'bg-red-600 text-white':conflict?'bg-red-100 text-red-700':scheduled?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}">${status}</span>${issues.length?`<p class="mt-1 max-w-[180px] whitespace-normal text-[9px] font-bold ${conflict?'text-red-600':'text-amber-600'}">${escapeHtml(issues.join(' • '))}</p>`:''}</td><td class="p-2"><div class="flex gap-1">${actions}</div></td></tr>`;}
function renderMasterSetup(){const {days,stages,durations}=setup(),chip=(text,action,id)=>`<div class="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1 text-[10px] font-bold"><span>${escapeHtml(text)}</span><button data-admin-action="${action}" data-id="${escapeHtml(id)}" class="text-red-600">×</button></div>`;const dayBox=document.getElementById('schedule-days-list'),stageBox=document.getElementById('schedule-stages-list'),durationBox=document.getElementById('schedule-durations-list');if(dayBox)dayBox.innerHTML=days.map(x=>chip(`${x.label} • ${dateDisplay(x.date)} • ${toAmPm(x.startTime)}–${toAmPm(x.endTime)}`,'remove-schedule-day',x.id)).join('');if(stageBox)stageBox.innerHTML=stages.map(x=>chip(x.name,'remove-schedule-stage',x.id)).join('');if(durationBox)durationBox.innerHTML=durations.map(x=>`<span class="rounded-full bg-emerald-50 px-3 py-1 text-[10px] font-black text-emerald-700">${x} min <button data-admin-action="remove-schedule-duration" data-id="${x}" class="ml-1 text-red-500">×</button></span>`).join('');for(const [id,list,label] of [['schedule-filter-day',days,'All Days'],['schedule-filter-stage',stages,'All Stages']]){const select=document.getElementById(id);if(select){const old=select.value;select.innerHTML=id==='schedule-filter-day'?dayOptionHtml(list,old,label):optionHtml(list,old,label);select.value=old;}}}
function updateSelectionUi(){const visibleSelected=visibleScheduleRowIds.filter(id=>selectedScheduleRows.has(id)).length,master=document.getElementById('schedule-select-all');if(master){master.checked=visibleScheduleRowIds.length>0&&visibleSelected===visibleScheduleRowIds.length;master.indeterminate=visibleSelected>0&&visibleSelected<visibleScheduleRowIds.length;}const count=document.getElementById('schedule-selection-count');if(count)count.textContent=`${selectedScheduleRows.size} selected`;}
function syncScheduleStageGroups(){document.querySelectorAll('[data-schedule-stage-group]').forEach(root=>{const master=root.querySelector('[data-schedule-stage-all]'),options=[...root.querySelectorAll('[data-schedule-stage-option]')],count=options.filter(input=>input.checked).length;if(master){master.checked=options.length>0&&count===options.length;master.indeterminate=count>0&&count<options.length;master.setAttribute('aria-checked',master.indeterminate?'mixed':String(master.checked));}});}
function renderScheduleBuilder(){syncFilterState();renderMasterSetup();const rows=candidateRows(),validation=scheduleValidation(rows),visible=rows.filter(row=>matchesFilter(row,validation)).sort(scheduleBuilderSort);visibleScheduleRowIds=visible.map(row=>`${row.isBreak?'break:':'event:'}${row.id}`);const body=document.getElementById('schedule-builder-body');if(body)body.innerHTML=visible.length?visible.map(row=>builderRow(row,validation)).join(''):'<tr><td colspan="10" class="p-12 text-center font-bold text-slate-400">No rows match all selected filters.</td></tr>';const schedulableEvents=events.filter(e=>e.cancelled!==true),scheduled=schedulableEvents.filter(e=>{const row=rows.find(x=>!x.isBreak&&x.id===e.id);return row?.dayId&&row?.stageId&&row?.duration&&row?.time;}).length,set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val;};set('schedule-stat-total',schedulableEvents.length);set('schedule-stat-scheduled',scheduled);set('schedule-stat-unscheduled',schedulableEvents.length-scheduled);set('schedule-stat-breaks',rows.filter(x=>x.isBreak).length);set('schedule-stat-conflicts',[...validation.values()].filter(x=>x.some(y=>y.includes('overlap'))).length);set('schedule-dirty-count',`${dirtyCount()} changes`);updateSelectionUi();syncScheduleStageGroups();window.lucide?.createIcons?.();}
window.renderSchedule=renderScheduleBuilder;
window.applyScheduleFilters=()=>renderScheduleBuilder();
window.toggleScheduleSelectAll=()=>{const checked=!!document.getElementById('schedule-select-all')?.checked;visibleScheduleRowIds.forEach(id=>checked?selectedScheduleRows.add(id):selectedScheduleRows.delete(id));renderScheduleBuilder();};
window.clearScheduleSelection=()=>{selectedScheduleRows.clear();renderScheduleBuilder();};
window.addScheduleDay=async()=>{const label=document.getElementById('setup-day-label')?.value.trim(),date=document.getElementById('setup-day-date')?.value,startTime=document.getElementById('setup-day-start')?.value,endTime=document.getElementById('setup-day-end')?.value;if(!label||!date||!startTime||!endTime||timeToMinutes(endTime)<=timeToMinutes(startTime))return window.showToast('Enter valid day label, date, start and end time','error');scheduleConfig.scheduleDays=[...setup().days,{id:uid('day'),label,date,startTime:toAmPm(startTime),endTime:toAmPm(endTime)}];renderScheduleBuilder();await window.saveScheduleMaster({silent:true,message:'Day saved automatically'});['setup-day-label','setup-day-date','setup-day-start','setup-day-end'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});};
window.addScheduleStage=async()=>{const name=document.getElementById('setup-stage-name')?.value.trim();if(!name)return window.showToast('Enter stage name','error');if(setup().stages.some(stage=>stage.name.toLowerCase()===name.toLowerCase()))return window.showToast('This stage already exists','error');scheduleConfig.scheduleStages=[...setup().stages,{id:uid('stage'),name}];renderScheduleBuilder();await window.saveScheduleMaster({silent:true,message:'Stage saved automatically'});const input=document.getElementById('setup-stage-name');if(input)input.value='';};
window.addScheduleDuration=async()=>{const value=Number(document.getElementById('setup-duration-value')?.value||0);if(value<=0)return window.showToast('Enter a valid duration','error');scheduleConfig.durationPresets=[...new Set([...setup().durations,value])].sort((a,b)=>a-b);renderScheduleBuilder();await window.saveScheduleMaster({silent:true,message:'Duration preset saved automatically'});const input=document.getElementById('setup-duration-value');if(input)input.value='';};
window.removeScheduleSetup=(kind,id)=>{if(kind==='day')scheduleConfig.scheduleDays=setup().days.filter(x=>x.id!==id);if(kind==='stage')scheduleConfig.scheduleStages=setup().stages.filter(x=>x.id!==id);if(kind==='duration')scheduleConfig.durationPresets=setup().durations.filter(x=>Number(x)!==Number(id));renderScheduleBuilder();};
window.saveScheduleMaster=async(options={})=>{
  const payload={scheduleDays:setup().days,scheduleStages:setup().stages,durationPresets:setup().durations,updatedAt:Date.now()};
  try{
    await setDoc(doc(db,'settings','schedule_config'),payload,{merge:true});
    const saved=await getDoc(doc(db,'settings','schedule_config'));
    const data=saved.data()||{};
    if(JSON.stringify(data.scheduleDays||[])!==JSON.stringify(payload.scheduleDays)||JSON.stringify(data.scheduleStages||[])!==JSON.stringify(payload.scheduleStages)||JSON.stringify(data.durationPresets||[])!==JSON.stringify(payload.durationPresets))throw new Error('SCHEDULE_MASTER_VERIFY_FAILED');
    window.showToast(options.message||'Schedule master setup saved to database');
  }catch(error){console.error('Unable to save schedule master setup',error);window.showToast(error?.code==='permission-denied'?'Schedule master save denied. Deploy the latest Firestore rules.':'Schedule master setup was not saved. Please try again.','error');}
};
function rowHasBlockingAutoConflict(rowKey){return (scheduleValidation().get(rowKey)||[]).some(item=>item.includes('overlap')||item.includes('End time'));}
function placeAutoScheduleRow(row,days,stages,durations){
  const baseDraft={...(scheduleDrafts.get(row.id)||{})},duration=Number(row.duration||baseDraft.duration||durations[0]||10),preferredDay=dayFor(row.dayId),preferredStage=stageFor(row.stageId),candidateDays=[...new Map([preferredDay,...days].filter(Boolean).map(day=>[day.id,day])).values()],candidateStages=[...new Map([preferredStage,...stages].filter(Boolean).map(stage=>[stage.id,stage])).values()];
  for(const day of candidateDays){
    for(const stage of candidateStages){
      const dayStart=timeToMinutes(day.startTime||'9:00 AM'),dayEnd=timeToMinutes(day.endTime||'11:59 PM');
      for(let cursor=dayStart;cursor+duration<=dayEnd;cursor+=5){
        const draft={...baseDraft,dayId:day.id,date:day.date,stageId:stage.id,stage:stage.name,duration,time:minutesToTime(cursor),manualStart:false,scheduleAutoFilled:true};
        scheduleDrafts.set(row.id,draft);
        if(!rowHasBlockingAutoConflict(`event:${row.id}`))return true;
      }
    }
  }
  scheduleDrafts.set(row.id,baseDraft);
  return false;
}
window.autoFillSchedule=async()=>{const keys=selectedScheduleRows.size?[...selectedScheduleRows].filter(x=>x.startsWith('event:')):visibleScheduleRowIds.filter(x=>x.startsWith('event:'));if(!keys.length)return window.showToast('Show or select programs first','error');const rows=candidateRows(),days=setup().days,stages=setup().stages,durations=setup().durations;if(!days.length||!stages.length)return window.showToast('Add at least one day and one stage first','error');const targets=keys.map(k=>rows.find(x=>!x.isBreak&&x.id===k.slice(6))).filter(Boolean).sort((a,b)=>a.baseOrder-b.baseOrder);const missing={day:0,stage:0,duration:0,start:0};targets.forEach(row=>{if(!row.dayId)missing.day++;if(!row.stageId)missing.stage++;if(!row.duration)missing.duration++;if(!row.time)missing.start++;});const issueLines=Object.entries(missing).filter(([,count])=>count).map(([key,count])=>`${count} program(s) missing ${key}`);if(issueLines.length){const proceed=await window.confirmAction(`Auto Fill will fix these schedule gaps and avoid stage, judge and participant overlaps:

${issueLines.join('\n')}

Default choices are used only when they are conflict-free. Continue?`);if(!proceed)return;}const originals=new Map(targets.map(row=>[row.id,{...(scheduleDrafts.get(row.id)||{})}])),failed=[];targets.forEach(row=>{if(!placeAutoScheduleRow(row,days,stages,durations))failed.push(row.name||'Program');});const validation=scheduleValidation(),autoConflicts=targets.filter(row=>(validation.get(`event:${row.id}`)||[]).some(item=>item.includes('overlap')||item.includes('End time'))).map(row=>row.name||'Program');if(failed.length||autoConflicts.length){originals.forEach((draft,id)=>Object.keys(draft).length?scheduleDrafts.set(id,draft):scheduleDrafts.delete(id));renderScheduleBuilder();return window.showToast(`Some programs could not be safely placed: ${[...new Set([...failed,...autoConflicts])].slice(0,3).join(', ')}${failed.length+autoConflicts.length>3?'...':''}`,'error');}renderScheduleBuilder();window.showToast('Auto Fill completed as conflict-free private draft. Click Save Now when ready.');};
window.addInlineBreak=id=>{const row=candidateRows().find(x=>!x.isBreak&&x.id===id);if(!row)return;const key=uid('new_break');scheduleBreakDrafts.set(key,{title:'Break',afterEventId:id,dayId:row.dayId,date:row.date,stageIds:[row.stageId],stages:[row.stage],stageId:row.stageId,stage:row.stage,duration:15,time:rowEnd(row),endTime:minutesToTime(timeToMinutes(rowEnd(row))+15),isBreak:true});renderScheduleBuilder();};
window.clearBuilderRow=id=>{scheduleDrafts.set(id,{dayId:'',date:'',stageId:'',stage:'',duration:10,time:'',manualStart:false});renderScheduleBuilder();};
window.editScheduleBreakRow=id=>{document.querySelector(`[data-schedule-id="${CSS.escape(id)}"][data-schedule-field="title"]`)?.focus();};
window.deleteScheduleBreakRow=async id=>{if(!await window.confirmAction('Delete this break?'))return;if(id.startsWith('new_'))scheduleBreakDrafts.delete(id);else deletedScheduleBreakIds.add(id);selectedScheduleRows.delete(`break:${id}`);renderScheduleBuilder();};
window.discardScheduleDrafts=()=>{window.showToast('Draft kept on this admin screen. Use Save Now to publish it to schedule pages.');renderScheduleBuilder();};
function scheduleIssuesForKeys(keys){const validation=scheduleValidation(),set=new Set(keys),overrides=[],hard=[];validation.forEach((items,key)=>{if(!set.has(key))return;items.forEach(item=>{if(item.includes('End time')||item.includes('Missing day'))hard.push(`${key}: ${item}`);else if(item.includes('overlap'))overrides.push(`${key}: ${item}`);});});return {overrides,hard};}
async function confirmScheduleOverride(issues){if(!issues.length)return true;return window.confirmAction(`Schedule conflicts found:

${issues.map((x,i)=>`${i+1}. ${x}`).join('\n')}

Do you want to save anyway?`,{okText:'Save Update',cancelText:'Cancel'});}
async function saveScheduleKeys(keys,{version=true}={}){if(!keys.length)return window.showToast('No changed or selected rows to save','error');const issues=scheduleIssuesForKeys(keys);if(issues.hard.length)return window.showToast(issues.hard[0].replace(/^(event|break):[^:]+: /,''),'error');if(issues.overrides.length&&!await confirmScheduleOverride(issues.overrides))return;const batch=writeBatch(db),changed=[];for(const key of keys){const isBreak=key.startsWith('break:'),id=key.replace(/^(event|break):/,'');if(isBreak){if(deletedScheduleBreakIds.has(id)){batch.delete(doc(db,'scheduleBreaks',id));continue;}const row=candidateRows().find(x=>x.isBreak&&x.id===id);if(!row)continue;const ref=id.startsWith('new_')?doc(collection(db,'scheduleBreaks')):doc(db,'scheduleBreaks',id),payload={title:row.title||'Break',dayId:row.dayId,date:row.date,stageIds:row.stageIds||['__all'],stages:row.stages||['All Stages'],stageId:row.stageId||'__all',stage:row.stage||'All Stages',startTime:row.time,endTime:rowEnd(row),duration:Number(row.duration),afterEventId:row.afterEventId||'',category:'General',active:true,updatedAt:Date.now()};batch.set(ref,{...payload,...(id.startsWith('new_')?{createdAt:Date.now()}:{})},{merge:true});changed.push({type:'break',id:ref.id,...payload});}else{const row=candidateRows().find(x=>!x.isBreak&&x.id===id);if(!row)continue;const day=dayFor(row.dayId),scheduled=!!(row.dayId&&row.date&&row.stageId&&row.stage&&row.time);const partial=!!(row.dayId||row.date||row.stageId||row.stage||row.time);if(partial&&!scheduled){window.showToast(`${row.name}: complete Day, Stage and Start Time before saving`,'error');return;}const payload={scheduleDayId:scheduled?row.dayId:'',scheduleDay:scheduled?(day?.label||''):'',scheduleDate:scheduled?row.date:'',scheduleStageId:scheduled?row.stageId:'',scheduleStage:scheduled?row.stage:'',scheduleDuration:Number(row.duration||10),time:scheduled?row.time:'',scheduleEndTime:scheduled?rowEnd(row):'',scheduleStatus:scheduled?'scheduled':'unscheduled',scheduleOrder:Number(row.baseOrder||0),updatedAt:Date.now()};batch.update(doc(db,'events',id),payload);changed.push({type:'program',id,name:row.name,category:row.category,gender:row.gender,...payload});}}
  const nextVersion=Number(scheduleConfig.scheduleVersion||0)+1,allSnapshot=candidateRows().map(row=>({type:row.isBreak?'break':'program',id:row.id,name:row.name||row.title,category:row.category||'General',gender:row.gender||'—',dayId:row.dayId,date:row.date,stageId:row.stageId,stageIds:row.stageIds||[],stages:row.stages||[],stage:row.stage,duration:Number(row.duration||0),time:row.time,endTime:rowEnd(row),afterEventId:row.afterEventId||''}));if(version){batch.set(doc(collection(db,'scheduleVersions')),{version:nextVersion,status:'saved',snapshot:allSnapshot,changes:changed,createdAt:Date.now(),createdByUid:auth.currentUser?.uid||''});batch.set(doc(collection(db,'auditLogs')),{action:'schedule-save',version:nextVersion,changeCount:changed.length,timestamp:Date.now(),uid:auth.currentUser?.uid||''});batch.set(doc(db,'settings','schedule_config'),{scheduleVersion:nextVersion,updatedAt:Date.now()},{merge:true});}
  try{await batch.commit();keys.forEach(key=>{const id=key.replace(/^(event|break):/,'');(key.startsWith('break:')?scheduleBreakDrafts:scheduleDrafts).delete(id);deletedScheduleBreakIds.delete(id);selectedScheduleRows.delete(key);});window.showToast(`${changed.length} schedule row(s) saved to database`);renderScheduleBuilder();}catch(error){console.error('Unable to save schedule rows',error);window.showToast(error?.code==='permission-denied'?'Schedule save denied. Check Admin access and deploy the latest Firestore rules.':'Schedule rows were not saved. Please try again.','error');}}
window.saveScheduleRow=key=>saveScheduleKeys([key]);
window.saveBulkSchedule=()=>{const keys=[...new Set([[...selectedScheduleRows],[...scheduleDrafts.keys()].map(id=>`event:${id}`),[...scheduleBreakDrafts.keys()].map(id=>`break:${id}`),[...deletedScheduleBreakIds].map(id=>`break:${id}`)].flat())];return saveScheduleKeys(keys);};
const liveSavedRows=()=>candidateRows().filter(row=>row.isBreak?scheduleBreaks.some(b=>b.id===row.id&&!deletedScheduleBreakIds.has(row.id)):(row.cancelled!==true&&isScheduledEvent(events.find(e=>e.id===row.id)||{}))).map(row=>({type:row.isBreak?'break':'program',id:row.id,name:row.name||row.title,category:row.category||'General',gender:row.gender||'—',dayId:row.dayId,date:row.date,stageId:row.stageId,stageIds:row.stageIds||[],stages:row.stages||[],stage:row.stage,duration:Number(row.duration||0),time:row.time,endTime:rowEnd(row),afterEventId:row.afterEventId||''}));
function selectedVersion(){if(selectedScheduleVersionId==='latest')return{version:Number(scheduleConfig.scheduleVersion||0),snapshot:liveSavedRows(),createdAt:scheduleConfig.updatedAt||Date.now()};return scheduleVersions.find(v=>v.id===selectedScheduleVersionId)||{snapshot:[]};}
const columnSettings=()=>{const saved=scheduleConfig.printSettings||{},order=Array.isArray(saved.columnOrder)?saved.columnOrder.filter(x=>DEFAULT_COLUMNS.includes(x)):[...DEFAULT_COLUMNS],missing=DEFAULT_COLUMNS.filter(x=>!order.includes(x));return{order:[...order,...missing],hidden:new Set(saved.hiddenColumns||[])};};
const groupedColumn=mode=>({date:'date',stage:'stage',category:'category',gender:'gender'})[mode]||'';
const visibleColumns=mode=>{const {order,hidden}=columnSettings(),columns=order.filter(column=>!hidden.has(column));return columns.length?columns:['program'];};
function renderColumnManager(){const box=document.getElementById('schedule-column-manager');if(!box)return;const {order,hidden}=columnSettings(),labels={category:'Category',program:'Program',gender:'Gender',date:'Date',time:'Start Time',end:'End Time',duration:'Duration',stage:'Stage'};box.innerHTML=order.map(col=>`<div data-schedule-column="${col}" class="schedule-column-item flex items-center gap-3 rounded-lg border bg-white p-2 text-xs font-bold"><button type="button" draggable="true" data-schedule-drag-handle="${col}" class="cursor-grab rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing" title="Drag to reorder ${labels[col]}"><i data-lucide="grip-vertical" class="h-4 w-4 pointer-events-none"></i></button><span class="min-w-0 flex-1">${labels[col]}</span><input type="checkbox" data-column-visible="${col}" aria-label="Show ${labels[col]}" ${hidden.has(col)?'':'checked'}></div>`).join('');}
function versionRows(){const version=selectedVersion();if(Array.isArray(version.snapshot)&&version.snapshot.length)return version.snapshot;if(Array.isArray(version.changes))return version.changes.map(row=>({type:row.type||'program',id:row.id,name:row.name||row.eventName||row.title||row.id,category:row.category||'General',gender:row.gender||'—',dayId:row.scheduleDayId||row.dayId||'',date:row.scheduleDate||row.date||'',stageId:row.scheduleStageId||row.stageId||'',stageIds:row.stageIds||[],stages:row.stages||[],stage:row.scheduleStage||row.stage||'',duration:Number(row.scheduleDuration||row.duration||0),time:row.time||row.startTime||'',endTime:row.scheduleEndTime||row.endTime||'',afterEventId:row.afterEventId||''}));return[];}
const scheduleReviewEnd=row=>row?.type==='break'&&row?.endTime?row.endTime:(row?.time&&Number(row.duration||0)?minutesToTime(timeToMinutes(row.time)+Number(row.duration||0)):(row?.endTime||row?.scheduleEndTime||''));
const scheduleReviewSort=(a,b)=>(String(a.date||'9999-99-99').localeCompare(String(b.date||'9999-99-99')))||(timeToMinutes(a.time||'11:59 PM')-timeToMinutes(b.time||'11:59 PM'))||(String(a.stage||'').localeCompare(String(b.stage||'')))||(Number(a.order||a.scheduleOrder||0)-Number(b.order||b.scheduleOrder||0))||(String(a.name||'').localeCompare(String(b.name||'')));
function reviewRows(){const mode=document.getElementById('schedule-review-mode')?.value||'date',filter=document.getElementById('schedule-review-filter')?.value||'';return versionRows().filter(row=>!filter||String(mode==='date'?row.date:mode==='stage'?row.stage:mode==='category'?row.category:row.gender)===filter).sort(scheduleReviewSort);}
const scheduleMarginCm=()=>Math.min(2.5,Math.max(.1,Number(document.getElementById('schedule-margin')?.value||1)));
const scheduleNoteSettings=()=>({text:(document.getElementById('schedule-nb-text')?.value||'').trim(),align:['left','center','right'].includes(document.getElementById('schedule-nb-align')?.value)?document.getElementById('schedule-nb-align').value:'left',pages:['all','first','last'].includes(document.getElementById('schedule-nb-pages')?.value)?document.getElementById('schedule-nb-pages').value:'all'});
const notePageNumbers=(count,scope)=>scope==='first'?[1]:scope==='last'?[count]:Array.from({length:count},(_,index)=>index+1);
const scheduleBreakPrintText=row=>{const name=String(row.name||row.title||'Break').trim()||'Break',time=[row.time||row.startTime,scheduleReviewEnd(row)].filter(Boolean).join(' - '),allStages=(row.stageIds||[]).includes('__all')||/^all stages?$/i.test(String(row.stage||'')),stages=allStages?'':(Array.isArray(row.stages)&&row.stages.length?row.stages.filter(stage=>!/^all stages?$/i.test(String(stage))).join(', '):row.stage||'');return[name,time,stages].filter(Boolean).join(' • ');};
function renderSchedulePaper(rows=reviewRows(),forcedMode=''){const paper=document.getElementById('schedule-paper');if(!paper)return;const mode=forcedMode||document.getElementById('schedule-review-mode')?.value||'date',columns=visibleColumns(mode),labels={category:'Category',program:'Program',gender:'Gender',date:'Date',time:'Start Time',end:'End Time',duration:'Duration',stage:'Stage'},get=(r,c)=>c==='program'?r.name:c==='duration'?`${r.duration||0} min`:c==='date'?dateDisplay(r.date):c==='end'?scheduleReviewEnd(r):r[c]||'—',groups=rows.slice().sort(scheduleReviewSort).reduce((a,r)=>{const k=mode==='date'?r.date:mode==='stage'?r.stage:mode==='category'?r.category:r.gender;(a[k||'Other']||=[]).push(r);return a;},{}),margin=scheduleMarginCm(),colorMode=document.getElementById('schedule-color-mode')?.value==='mono'?'mono':'color',note=scheduleNoteSettings();paper.innerHTML=`<div class="schedule-paper-inner schedule-color-${colorMode}" style="box-sizing:border-box;padding:${margin}cm"><div class="schedule-print-header">${homeConfig.logoUrl?`<img src="${escapeHtml(homeConfig.logoUrl)}" class="schedule-print-logo">`:''}<div class="schedule-print-title-block"><div class="schedule-print-fest">${escapeHtml([homeConfig.festName1,homeConfig.festName2].filter(Boolean).join(' ')||'Fest')}</div><div class="schedule-print-title">${escapeHtml(document.getElementById('schedule-print-title')?.value||'TIME SCHEDULE')}</div></div></div>${Object.entries(groups).map(([group,list])=>`<table class="schedule-print-table"><thead><tr class="schedule-date-row"><th colspan="${Math.max(columns.length,1)}">${escapeHtml(mode==='date'?scheduleDateText(group):`${mode.toUpperCase()}: ${group}`)}</th></tr><tr>${columns.map(c=>`<th>${labels[c]}</th>`).join('')}</tr></thead><tbody>${list.map(row=>row.type==='break'?`<tr class="schedule-break-row"><td colspan="${Math.max(columns.length,1)}">${escapeHtml(scheduleBreakPrintText(row))}</td></tr>`:`<tr>${columns.map(c=>`<td data-column="${c}">${escapeHtml(get(row,c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('')||'<div class="p-10 text-center">No schedule in this version/filter.</div>'}${note.text?`<div class="schedule-print-nb schedule-note-${note.align}" data-html2canvas-ignore="true"><b>NB:</b><span>${escapeHtml(note.text)}</span></div>`:''}</div>`;}
window.renderScheduleReview=()=>{renderColumnManager();const versionSelect=document.getElementById('schedule-version-select');if(versionSelect){const old=selectedScheduleVersionId;versionSelect.innerHTML='<option value="latest">Latest Version</option>'+scheduleVersions.map(v=>`<option value="${v.id}">Version ${v.version} • ${new Date(v.createdAt||0).toLocaleString()}</option>`).join('');versionSelect.value=scheduleVersions.some(v=>v.id===old)?old:'latest';selectedScheduleVersionId=versionSelect.value;}const mode=document.getElementById('schedule-review-mode')?.value||'date',filter=document.getElementById('schedule-review-filter'),rows=versionRows(),values=[...new Set(rows.map(r=>mode==='date'?r.date:mode==='stage'?r.stage:mode==='category'?r.category:r.gender).filter(Boolean))].sort();if(filter){const old=filter.value;filter.innerHTML='<option value="">All</option>'+values.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(mode==='date'?scheduleDateText(v):v)}</option>`).join('');if(values.includes(old))filter.value=old;}const info=document.getElementById('schedule-version-list'),version=selectedVersion();if(info)info.innerHTML=`<div class="rounded-xl bg-slate-50 p-3 text-xs font-bold">Version ${version.version||0} • ${new Date(version.createdAt||0).toLocaleString()} • ${(version.snapshot||[]).length} rows</div>`;const validation=document.getElementById('schedule-validation-list');if(validation)validation.innerHTML='<div class="rounded-xl bg-emerald-50 p-3 text-xs font-bold text-emerald-700">Preview uses an immutable saved version snapshot.</div>';renderSchedulePaper();window.lucide?.createIcons?.();};
window.selectScheduleVersion=value=>{selectedScheduleVersionId=value||'latest';window.renderScheduleReview();};
window.saveScheduleConfig=async()=>{const manager=[...document.querySelectorAll('[data-schedule-column]')],columnOrder=manager.map(x=>x.dataset.scheduleColumn),hiddenColumns=manager.filter(x=>!x.querySelector('[data-column-visible]')?.checked).map(x=>x.dataset.scheduleColumn),printSettings={...(scheduleConfig.printSettings||{}),columnOrder,hiddenColumns,pageSize:document.getElementById('schedule-page-size')?.value||'A4',orientation:document.getElementById('schedule-orientation')?.value||'portrait',marginCm:scheduleMarginCm(),nbAlign:scheduleNoteSettings().align,nbPages:scheduleNoteSettings().pages,colorMode:document.getElementById('schedule-color-mode')?.value||'color',reviewMode:document.getElementById('schedule-review-mode')?.value||'date'};await setDoc(doc(db,'settings','schedule_config'),{title:document.getElementById('schedule-print-title')?.value||'TIME SCHEDULE',nbText:document.getElementById('schedule-nb-text')?.value||'',printSettings,updatedAt:Date.now()},{merge:true});window.showToast('Schedule review and PDF settings saved');};
window.renderScheduleConfig=()=>{const cfg=scheduleSettings(),set=(id,value)=>{const el=document.getElementById(id);if(el&&document.activeElement!==el&&value!==undefined)el.value=value;};set('schedule-print-title',cfg.title);set('schedule-nb-text',cfg.nbText);const lock=document.getElementById('schedule-registration-lock');if(lock&&document.activeElement!==lock){const d=cfg.registrationLockAt?new Date(cfg.registrationLockAt):null;lock.value=d?new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16):'';}if(cfg.printSettings){set('schedule-page-size',cfg.printSettings.pageSize);set('schedule-orientation',cfg.printSettings.orientation);set('schedule-margin',cfg.printSettings.marginCm??1);set('schedule-nb-align',cfg.printSettings.nbAlign||'left');set('schedule-nb-pages',cfg.printSettings.nbPages||'all');set('schedule-color-mode',cfg.printSettings.colorMode);set('schedule-review-mode',cfg.printSettings.reviewMode);}renderScheduleBuilder();window.renderScheduleReview?.();};
window.saveRegistrationLock=async()=>{const value=document.getElementById('schedule-registration-lock')?.value||'',registrationLockAt=value?new Date(value).getTime():null,updatedAt=Date.now();await setDoc(doc(db,'settings','schedule_config'),{registrationLockAt,updatedAt},{merge:true});await setDoc(doc(db,'settings','registration_config'),{finalizationLockAt:registrationLockAt||0,updatedAt,updatedByUid:auth.currentUser?.uid||''},{merge:true});window.showToast(registrationLockAt?'Registration lock saved':'Registration lock removed');};
async function createSchedulePdf(){
  const JsPDF=window.jspdf?.jsPDF;
  if(!JsPDF)throw new Error('jsPDF 2.5.1 is not loaded');
  const orientation=document.getElementById('schedule-orientation')?.value||'portrait';
  const format=(document.getElementById('schedule-page-size')?.value||'A4').toLowerCase();
  const docPdf=new JsPDF({orientation,unit:'mm',format});
  const rows=reviewRows(),mode=document.getElementById('schedule-review-mode')?.value||'date';
  const margin=scheduleMarginCm()*10,note=scheduleNoteSettings();
  const pdfText=[document.getElementById('schedule-print-title')?.value,note.text,...rows.flatMap(row=>[row.name,row.category,row.gender,row.stage])].join(' ');
  const hasMalayalam=/[\u0D00-\u0D7F]/.test(pdfText),customFont=scheduleConfig.printSettings?.malayalamFontBase64;
  if(customFont){
    docPdf.addFileToVFS('NotoSansMalayalam.ttf',customFont);
    docPdf.addFont('NotoSansMalayalam.ttf','NotoMalayalam','normal');
    docPdf.addFont('NotoSansMalayalam.ttf','NotoMalayalam','bold');
    docPdf.setFont('NotoMalayalam');
  }
  if(hasMalayalam&&!customFont){
    if(!window.html2canvas)throw new Error('Malayalam PDF renderer is not loaded');
    renderSchedulePaper(rows,mode);
    await document.fonts?.ready;
    const paper=document.getElementById('schedule-paper'),noteElement=paper.querySelector('.schedule-print-nb');
    let noteCanvas=null;
    if(noteElement){
      const clone=noteElement.cloneNode(true);
      clone.removeAttribute('data-html2canvas-ignore');
      Object.assign(clone.style,{position:'fixed',left:'-10000px',top:'0',width:`${paper.clientWidth}px`,margin:'0',padding:'8px',boxSizing:'border-box',background:'#fff'});
      document.body.appendChild(clone);
      noteCanvas=await window.html2canvas(clone,{scale:1.35,backgroundColor:'#fff',useCORS:true});
      clone.remove();
      noteElement.style.display='none';
    }
    const paperRect=paper.getBoundingClientRect();
    const canvas=await window.html2canvas(paper,{scale:1.35,backgroundColor:'#fff',useCORS:true});
    if(noteElement)noteElement.style.display='';
    const pageWidth=docPdf.internal.pageSize.getWidth(),pageHeight=docPdf.internal.pageSize.getHeight(),contentWidth=pageWidth-(margin*2);
    const noteHeight=noteCanvas?Math.min(22,noteCanvas.height*contentWidth/noteCanvas.width):0,noteReserve=noteHeight?noteHeight+3:0;
    const contentHeight=pageHeight-(margin*2)-noteReserve,scale=contentWidth/canvas.width,sourcePageHeight=Math.max(1,Math.floor(contentHeight/scale));
    const domScale=canvas.height/Math.max(paper.scrollHeight,1);
    const safeBreaks=[...paper.querySelectorAll('.schedule-print-table tr, .schedule-print-table')].map(node=>Math.round((node.getBoundingClientRect().bottom-paperRect.top)*domScale)).filter(point=>point>0&&point<canvas.height).sort((a,b)=>a-b);
    let sourceY=0,pageIndex=0;
    while(sourceY<canvas.height){
      const desiredEnd=Math.min(sourceY+sourcePageHeight,canvas.height),safeEnd=safeBreaks.filter(point=>point<=desiredEnd&&point>sourceY+40).pop(),sourceEnd=desiredEnd<canvas.height&&safeEnd?safeEnd:desiredEnd,sliceHeight=Math.max(1,sourceEnd-sourceY),slice=document.createElement('canvas');
      slice.width=canvas.width;slice.height=sliceHeight;
      slice.getContext('2d').drawImage(canvas,0,sourceY,canvas.width,sliceHeight,0,0,canvas.width,sliceHeight);
      if(pageIndex++)docPdf.addPage();
      docPdf.addImage(slice.toDataURL('image/jpeg',0.88),'JPEG',margin,margin,contentWidth,sliceHeight*scale,undefined,'FAST');
      sourceY=sourceEnd;
    }
    if(noteCanvas&&note.text){
      const noteImage=noteCanvas.toDataURL('image/png');
      notePageNumbers(docPdf.getNumberOfPages(),note.pages).forEach(page=>{docPdf.setPage(page);docPdf.addImage(noteImage,'PNG',margin,pageHeight-margin-noteHeight,contentWidth,noteHeight,undefined,'FAST');});
    }
    renderSchedulePaper();
    return docPdf;
  }
  const cols=visibleColumns(mode),labels={category:'Category',program:'Program',gender:'Gender',date:'Date',time:'Start',end:'End',duration:'Duration',stage:'Stage'};
  const value=(row,column)=>column==='program'?row.name:column==='duration'?`${row.duration||0} min`:column==='date'?dateDisplay(row.date):row[column]||'—';
  const groupKey=row=>mode==='date'?row.date:mode==='stage'?row.stage:mode==='category'?row.category:row.gender;
  const sorted=[...rows].sort((a,b)=>String(groupKey(a)).localeCompare(String(groupKey(b)))||timeToMinutes(a.time)-timeToMinutes(b.time));
  const mono=document.getElementById('schedule-color-mode')?.value==='mono',groupFill=mono?[229,231,235]:[51,65,85];
  const centerColumns=new Set(['date','gender','time','end','duration']),columnStyles=Object.fromEntries(cols.map((column,index)=>[index,{halign:centerColumns.has(column)?'center':'left'}])),body=[];
  let previousGroup='';
  sorted.forEach(row=>{const group=groupKey(row)||'Other';if(group!==previousGroup){body.push([{content:`${mode.toUpperCase()}: ${mode==='date'?scheduleDateText(group):group}`,colSpan:cols.length,styles:{fillColor:groupFill,textColor:mono?17:255,fontStyle:'bold',halign:'center',cellPadding:1.8}}]);previousGroup=group;}if(row.type==='break')body.push([{content:scheduleBreakPrintText(row),colSpan:cols.length,styles:{fillColor:mono?[226,232,240]:[226,232,240],textColor:15,fontStyle:'bold',halign:'center',cellPadding:2.2}}]);else body.push(cols.map(column=>String(value(row,column))));});
  docPdf.setFontSize(12);docPdf.setFont(customFont?'NotoMalayalam':'helvetica','bold');
  docPdf.text(document.getElementById('schedule-print-title')?.value||'TIME SCHEDULE',docPdf.internal.pageSize.getWidth()/2,margin+4,{align:'center'});
  docPdf.setFont(customFont?'NotoMalayalam':'helvetica','normal');
  docPdf.autoTable({startY:margin+9,margin:{top:margin,left:margin,right:margin,bottom:margin+(note.text?16:0)},head:[cols.map(column=>labels[column])],body,columnStyles,styles:{font:customFont?'NotoMalayalam':'helvetica',fontStyle:'normal',fontSize:8.5,cellPadding:1.8,lineWidth:.18,lineColor:[100,116,139],valign:'middle',overflow:'linebreak'},headStyles:{fillColor:mono?[241,245,249]:[226,232,240],textColor:[15,23,42],fontStyle:'bold',lineWidth:.22,lineColor:[71,85,105],halign:'center'}});
  if(note.text){
    docPdf.setFont(customFont?'NotoMalayalam':'helvetica','normal');docPdf.setFontSize(8.5);
    const pageWidth=docPdf.internal.pageSize.getWidth(),pageHeight=docPdf.internal.pageSize.getHeight(),lines=docPdf.splitTextToSize(`NB: ${note.text}`,pageWidth-(margin*2)),x=note.align==='left'?margin:note.align==='right'?pageWidth-margin:pageWidth/2,y=pageHeight-margin-Math.max(0,(lines.length-1)*3.7);
    notePageNumbers(docPdf.getNumberOfPages(),note.pages).forEach(page=>{docPdf.setPage(page);docPdf.text(lines,x,y,{align:note.align});});
  }
  return docPdf;
}
function revokeSchedulePdf(){if(schedulePdfUrl)URL.revokeObjectURL(schedulePdfUrl);schedulePdfUrl='';schedulePdfBlob=null;}
window.previewSchedulePdf=async()=>{const loading=document.getElementById('schedule-pdf-loading'),errorBox=document.getElementById('schedule-pdf-error'),frame=document.getElementById('schedule-pdf-frame');loading?.classList.remove('hidden');errorBox?.classList.add('hidden');frame?.classList.add('hidden');frame?.removeAttribute('src');try{revokeSchedulePdf();const started=performance.now(),pdf=await createSchedulePdf();schedulePdfBlob=pdf.output('blob');schedulePdfUrl=URL.createObjectURL(schedulePdfBlob);if(frame){frame.src=schedulePdfUrl;frame.classList.remove('hidden');}document.getElementById('schedule-preview-status').textContent=`Inline jsPDF 2.5.1 preview ready • ${Math.round(performance.now()-started)} ms`;}catch(error){console.error(error);if(errorBox){errorBox.textContent=error.message||'Unable to generate PDF';errorBox.classList.remove('hidden');}}finally{loading?.classList.add('hidden');}};
window.closeSchedulePdf=()=>{document.getElementById('schedule-pdf-frame')?.classList.add('hidden');document.getElementById('schedule-pdf-frame')?.removeAttribute('src');revokeSchedulePdf();};
window.downloadSchedulePdf=async()=>{if(!schedulePdfBlob){await window.previewSchedulePdf();if(!schedulePdfBlob)return;}const a=document.createElement('a');a.href=schedulePdfUrl;a.download='Fest_Time_Schedule.pdf';a.click();};
window.printSchedulePreview=async()=>{if(!schedulePdfBlob)await window.previewSchedulePdf();document.getElementById('schedule-pdf-frame')?.contentWindow?.print();};
window.exportScheduleExcel=()=>{if(!window.XLSX)return;const rows=candidateRows().filter(x=>!x.isBreak&&!x.cancelled).map(r=>({Program:r.name,Day:dayFor(r.dayId)?.label||'',Date:r.date,Stage:r.stage,Duration:r.duration,'Start Time':r.time,'End Time':rowEnd(r)})),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'Schedule');XLSX.writeFile(book,'Fest_Time_Schedule.xlsx');};
window.exportScheduleReviewExcel=()=>{if(!window.XLSX)return;const mode=document.getElementById('schedule-review-mode')?.value||'date',columns=visibleColumns(mode),labels={category:'Category',program:'Program',gender:'Gender',date:'Date',time:'Start Time',end:'End Time',duration:'Duration',stage:'Stage'},rows=reviewRows().map(row=>Object.fromEntries(columns.map(column=>[labels[column],column==='program'?row.name:column==='duration'?Number(row.duration||0):column==='end'?scheduleReviewEnd(row):row[column]||'']))),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'Filtered Schedule');XLSX.writeFile(book,'Fest_Filtered_Schedule.xlsx');};
window.importScheduleExcel=async file=>{if(!file||!window.XLSX)return;try{const book=XLSX.read(await file.arrayBuffer()),rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);let count=0;rows.forEach(data=>{const event=events.find(e=>String(e.name).trim().toLowerCase()===String(data.Program||'').trim().toLowerCase());if(!event)return;const day=setup().days.find(x=>x.label===data.Day||x.date===data.Date),stage=setup().stages.find(x=>x.name===data.Stage);scheduleDrafts.set(event.id,{dayId:day?.id||'',date:day?.date||data.Date||'',stageId:stage?.id||'',stage:stage?.name||data.Stage||'',duration:Number(data.Duration||10),time:toAmPm(data['Start Time']||''),manualStart:!!data['Start Time']});count++;});renderScheduleBuilder();window.showToast(`${count} programs imported for review`);}catch(error){window.showToast('Unable to import schedule file','error');}};
document.addEventListener('change',event=>{const stageGroup=event.target.closest('[data-schedule-stage-group]');if(stageGroup){const all=event.target.matches('[data-schedule-stage-all]'),options=[...stageGroup.querySelectorAll('[data-schedule-stage-option]')];if(all)options.forEach(input=>input.checked=event.target.checked);const selected=options.filter(input=>input.checked).map(input=>input.value),allChecked=options.length>0&&selected.length===options.length;updateDraft(stageGroup.dataset.id,'stageIds',allChecked?['__all']:selected,true);return;}const field=event.target.closest('[data-schedule-field]');if(field){updateDraft(field.dataset.scheduleId,field.dataset.scheduleField,field.value,field.dataset.scheduleBreak==='1');}const rowCheck=event.target.closest('.schedule-row-select');if(rowCheck){rowCheck.checked?selectedScheduleRows.add(rowCheck.dataset.key):selectedScheduleRows.delete(rowCheck.dataset.key);updateSelectionUi();}const visible=event.target.closest('[data-column-visible]');if(visible){const hidden=new Set(scheduleConfig.printSettings?.hiddenColumns||[]);visible.checked?hidden.delete(visible.dataset.columnVisible):hidden.add(visible.dataset.columnVisible);scheduleConfig.printSettings={...(scheduleConfig.printSettings||{}),hiddenColumns:[...hidden]};renderSchedulePaper();}});
let draggedColumn='';document.addEventListener('dragstart',event=>{const handle=event.target.closest('[data-schedule-drag-handle]');if(!handle)return event.preventDefault();draggedColumn=handle.dataset.scheduleDragHandle;event.dataTransfer.effectAllowed='move';});document.addEventListener('dragover',event=>{if(draggedColumn&&event.target.closest('[data-schedule-column]'))event.preventDefault();});document.addEventListener('drop',event=>{const target=event.target.closest('[data-schedule-column]');if(!target||!draggedColumn||target.dataset.scheduleColumn===draggedColumn)return;event.preventDefault();const {order}=columnSettings(),from=order.indexOf(draggedColumn),to=order.indexOf(target.dataset.scheduleColumn);order.splice(to,0,order.splice(from,1)[0]);scheduleConfig.printSettings={...(scheduleConfig.printSettings||{}),columnOrder:order};renderScheduleReview();draggedColumn='';});
document.getElementById('schedule-import-file')?.addEventListener('change',event=>window.importScheduleExcel(event.target.files?.[0]));window.addEventListener('beforeunload',event=>{if(dirtyCount()){event.preventDefault();event.returnValue='';}revokeSchedulePdf();});


// --- SCORING SETTINGS ---
const ordinalLabel = (index) => ['First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth','Tenth'][index] || `${index + 1}${[11,12,13].includes((index+1)%100)?'th':({1:'st',2:'nd',3:'rd'}[(index+1)%10]||'th')}`;
const gradeLabel = index => index < 26 ? `${String.fromCharCode(65 + index)} Grade` : `Grade ${index + 1}`;
const scoringKey = (prefix, index) => `${prefix}_${index + 1}`;
const SCORING_POLICY_PACKS={
    participation:{label:'Participation only',description:'No ranking, points or grades. Use for exhibitions and attendance-only activities.',enabled:{points:false,grades:false},teamMode:'disabled'},
    direct_rank:{label:'Direct rank',description:'Judges or publishers choose positions directly; position points are enabled and grades are disabled.',enabled:{points:true,grades:false},teamMode:'per_event'},
    standard_points:{label:'Standard points',description:'First, Second and Third position points for both Single and Group events; no automatic grades.',enabled:{points:true,grades:false},teamMode:'enabled'},
    points_grades:{label:'Points + automatic grades',description:'Combines configured position ranks with any number of named grade bands for championship scoring.',enabled:{points:true,grades:true},teamMode:'enabled'},
    advanced:{label:'Advanced / per event',description:'Keeps points and grades available while each event may choose its own result and scoring policy.',enabled:{points:true,grades:true},teamMode:'per_event'},
    custom:{label:'Custom',description:'One or more scoring options differ from a built-in policy pack.'}
};
const scoringOverrideForPack=pack=>({default:{},direct_rank:{enabled:{points:true,grades:false},policies:{directRankGradeMode:'disabled'}},standard_points:{enabled:{points:true,grades:false}},points_grades:{enabled:{points:true,grades:true}},display_only:{enabled:{points:false,grades:false}}})[pack]||{};
const defaultScoringRules = () => ({
    policyPack: 'custom',
    gradeThresholds:[{key:'grade_A',label:'A Grade',minimumPercentage:80,value:5},{key:'grade_B',label:'B Grade',minimumPercentage:70,value:3},{key:'grade_C',label:'C Grade',minimumPercentage:60,value:1}],
    policies:{},
    enabled: { points: true, grades: false },
    display: { showPointsPublicly: true, showGradesPublicly: true, showGradePointValuePublicly: false },
    tiePolicyDefault: 'full',
    configs: {
        Single: { points: [{ label: 'First', value: 5, tiePolicy: 'full' }, { label: 'Second', value: 3, tiePolicy: 'full' }, { label: 'Third', value: 1, tiePolicy: 'full' }], grades: [{ label: 'A Grade', minimumPercentage:80, value: 5 }, { label: 'B Grade', minimumPercentage:70, value: 3 }, { label: 'C Grade', minimumPercentage:60, value: 1 }] },
        Group: { points: [{ label: 'First', value: 10, tiePolicy: 'full' }, { label: 'Second', value: 7, tiePolicy: 'full' }, { label: 'Third', value: 5, tiePolicy: 'full' }], grades: [{ label: 'A Grade', minimumPercentage:80, value: 10 }, { label: 'B Grade', minimumPercentage:70, value: 7 }, { label: 'C Grade', minimumPercentage:60, value: 5 }] }
    }
});
const normalizeScoringRows = (rows, fallback, type = 'points') => (Array.isArray(rows) && rows.length ? rows : fallback).map((row, i) => ({
    key: String(row.key || fallback[i]?.key || scoringKey(type === 'grades' ? 'grade' : 'position', i)),
    label: String(row.label || fallback[i]?.label || (type === 'grades' ? gradeLabel(i) : ordinalLabel(i))),
    value: Number(row.value || 0),
    ...(type === 'grades' ? { minimumPercentage:Number(row.minimumPercentage ?? fallback[i]?.minimumPercentage ?? [80,70,60][i] ?? 0) } : {}),
    ...(type === 'points' ? { tiePolicy: row.tiePolicy === 'shared' ? 'shared' : (row.tiePolicy || 'full') } : {})
}));
function normalizeAdminScoringRules() {
    const defaults=defaultScoringRules(),saved=scoringRules||{},legacy=Array.isArray(saved.gradeThresholds)&&saved.gradeThresholds.length?saved.gradeThresholds:defaults.gradeThresholds;
    const normalizeGrades=(rows,fallback,type)=>(Array.isArray(rows)&&rows.length?rows:fallback).map((row,index)=>({key:String(row.key||`${type.toLowerCase()}_grade_${index+1}`),order:index+1,label:String(row.label||legacy[index]?.label||gradeLabel(index)),minimumPercentage:Number(row.minimumPercentage??legacy[index]?.minimumPercentage??fallback[index]?.minimumPercentage??[80,70,60][index]??0),value:Number(row.value||0)})).sort((a,b)=>b.minimumPercentage-a.minimumPercentage).map((row,index)=>({...row,order:index+1}));
    const configs={Single:{points:normalizeScoringRows(saved.configs?.Single?.points,defaults.configs.Single.points),grades:normalizeGrades(saved.configs?.Single?.grades,defaults.configs.Single.grades,'Single')},Group:{points:normalizeScoringRows(saved.configs?.Group?.points,defaults.configs.Group.points),grades:normalizeGrades(saved.configs?.Group?.grades,defaults.configs.Group.grades,'Group')}};
    return{policyPack:SCORING_POLICY_PACKS[saved.policyPack]?saved.policyPack:'custom',gradeThresholds:configs.Single.grades.map(grade=>({key:grade.key,label:grade.label,minimumPercentage:grade.minimumPercentage,value:grade.value})),policies:{gradeCalculationMaximumMark:100,...(saved.policies||{})},enabled:{...defaults.enabled,...(saved.enabled||{})},display:{...defaults.display,...(saved.display||{})},tiePolicyDefault:saved.tiePolicyDefault==='shared'?'shared':'full',configs};
}

function pointRuleRow(rule, index) {
    const tie = rule.tiePolicy === 'shared' ? 'shared' : 'full';
    return `<div data-point-row data-rank="${index+1}" data-rule-key="${escapeHtml(rule.key||scoringKey('position',index))}" class="grid grid-cols-1 md:grid-cols-[1fr_120px_180px_44px] gap-2"><input data-point-label class="text-input font-black text-slate-700" aria-label="Position label" value="${escapeHtml(rule.label||ordinalLabel(index))}"><input data-point-value type="number" min="0" step="0.01" class="text-input font-bold text-center" value="${Number(rule.value || 0)}"><select data-point-tie class="text-input font-bold"><option value="full" ${tie === 'full' ? 'selected' : ''}>Full points</option><option value="shared" ${tie === 'shared' ? 'selected' : ''}>Shared points</option></select><button data-admin-action="remove-score-row" ${index<3?'disabled title="First, Second and Third are required"':''} class="rounded-xl bg-red-50 text-red-500 font-bold min-h-[44px] disabled:cursor-not-allowed disabled:opacity-25">×</button></div>`;
}
function gradeRuleRow(rule,index,type){
    const maximum=Math.max(1,Number(document.getElementById('policy-grade-maximum')?.value||normalizeAdminScoringRules().policies.gradeCalculationMaximumMark||100)),minimum=Number(rule.minimumPercentage||0),minimumMark=Number((maximum*minimum/100).toFixed(2));
    return `<div data-grade-row data-grade-index="${index}" data-rule-key="${escapeHtml(rule.key||`${type.toLowerCase()}_grade_${index+1}`)}" class="grid grid-cols-1 md:grid-cols-[1fr_110px_130px_140px_44px] gap-2"><input data-grade-label class="text-input font-black text-slate-700" aria-label="Grade label" value="${escapeHtml(rule.label||gradeLabel(index))}"><input data-grade-value type="number" min="0" step="0.01" class="text-input font-bold text-center" aria-label="Point value" value="${Number(rule.value||0)}"><input data-grade-minimum type="number" min="0" max="100" step="0.01" class="text-input font-bold text-center" aria-label="Minimum percentage" value="${minimum}"><output data-grade-mark class="text-input flex items-center justify-center bg-slate-100 font-black text-slate-600" aria-label="Calculated minimum mark">${minimumMark} / ${maximum}</output><button data-admin-action="remove-score-row" ${index<3?'disabled title="The first three grades are required"':''} class="rounded-xl bg-red-50 text-red-500 font-bold min-h-[44px] disabled:cursor-not-allowed disabled:opacity-25">×</button></div>`;
}

function scoreConfigCard(type, cfg, enabled) {
    return `<div data-score-config="${type}" class="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-5"><div><h3 class="text-xl font-black text-slate-800">${type} Event Rules</h3><p class="text-xs text-slate-500 font-semibold">Configure ${type.toLowerCase()} event position points and grade values.</p></div>${enabled.points ? `<div><div class="flex justify-between items-center mb-3"><h4 class="font-bold text-blue-700">Position Points</h4><button data-admin-action="add-point-rule" data-type="${type}" class="px-3 py-2 rounded-lg bg-blue-50 text-blue-700 text-xs font-bold">+ Add Position</button></div><div class="grid grid-cols-1 md:grid-cols-[1fr_120px_180px_44px] gap-2 text-[10px] uppercase tracking-wider text-slate-400 font-black px-1"><span>Position Label</span><span>Point Value</span><span>Tie Policy</span><span></span></div><div data-point-list class="space-y-2">${cfg.points.map((r,i)=>pointRuleRow(r,i)).join('')}</div></div>` : ''}${enabled.grades ? `<div><div class="flex justify-between items-center mb-3"><h4 class="font-bold text-emerald-700">Grade Values</h4><button data-admin-action="add-grade-rule" data-type="${type}" class="px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-bold">+ Add Grade</button></div><div class="grid grid-cols-1 md:grid-cols-[1fr_110px_130px_140px_44px] gap-2 text-[10px] uppercase tracking-wider text-slate-400 font-black px-1"><span>Grade Label</span><span>Point Value</span><span>Minimum %</span><span>Minimum Mark</span><span></span></div><div data-grade-list class="space-y-2">${cfg.grades.map((r,i)=>gradeRuleRow(r,i,type)).join('')}</div></div>` : ''}${!enabled.points && !enabled.grades ? '<div class="bg-amber-50 border border-amber-100 rounded-xl p-4 text-amber-800 text-sm font-bold">Select Points, Grades, or both from the top.</div>' : ''}</div>`;
}
function readScoringConfigFromDom() {
    const normalized = normalizeAdminScoringRules();
    ['Single','Group'].forEach(type => {
        const card = document.querySelector(`[data-score-config="${type}"]`);
        if(!card) return;
        const pointList = card.querySelector('[data-point-list]');
        const gradeList = card.querySelector('[data-grade-list]');
        if(pointList) normalized.configs[type].points = Array.from(pointList.querySelectorAll('[data-point-row]')).map((row, i) => ({ key:row.dataset.ruleKey||scoringKey('position',i),rank:i+1,label:row.querySelector('[data-point-label]')?.value.trim()||ordinalLabel(i), value: Number(row.querySelector('[data-point-value]')?.value || 0), tiePolicy: row.querySelector('[data-point-tie]')?.value === 'shared' ? 'shared' : 'full' }));
        if(gradeList) normalized.configs[type].grades=Array.from(gradeList.querySelectorAll('[data-grade-row]')).map((row,i)=>({key:row.dataset.ruleKey||`${type.toLowerCase()}_grade_${i+1}`,order:i+1,label:row.querySelector('[data-grade-label]')?.value.trim()||gradeLabel(i),minimumPercentage:Number(row.querySelector('[data-grade-minimum]')?.value||0),value:Number(row.querySelector('[data-grade-value]')?.value||0)}));
    });
    normalized.enabled.points = !!document.getElementById('score-enable-points')?.checked;
    normalized.enabled.grades = !!document.getElementById('score-enable-grades')?.checked;
    normalized.display.showPointsPublicly = !!document.getElementById('score-show-points')?.checked;
    normalized.display.showGradesPublicly = !!document.getElementById('score-show-grades')?.checked;
    normalized.display.showGradePointValuePublicly = !!document.getElementById('score-show-grade-values')?.checked;
    normalized.tiePolicyDefault = document.querySelector('input[name="score-tie-default"]:checked')?.value === 'shared' ? 'shared' : 'full';
    normalized.policyPack = document.getElementById('score-policy-pack')?.value || 'custom';
    normalized.gradeThresholds=normalized.configs.Single.grades.map(grade=>({key:grade.key,label:grade.label,minimumPercentage:grade.minimumPercentage,value:grade.value}));
    normalized.policies.gradeCalculationMaximumMark=Math.max(1,Number(document.getElementById('policy-grade-maximum')?.value||100));
    return normalized;
}
window.updateGradeCalculatedMarks=()=>{const maximum=Math.max(1,Number(document.getElementById('policy-grade-maximum')?.value||100));document.querySelectorAll('[data-grade-row]').forEach(row=>{const minimum=Number(row.querySelector('[data-grade-minimum]')?.value||0),output=row.querySelector('[data-grade-mark]');if(output)output.textContent=`${Number((maximum*minimum/100).toFixed(2))} / ${maximum}`;});};
window.renderScoringRules = () => {
    const normalized = normalizeAdminScoringRules();
    const pack=document.getElementById('score-policy-pack');if(pack)pack.value=SCORING_POLICY_PACKS[normalized.policyPack]?normalized.policyPack:'custom';renderScoringPolicyPackGuide(pack?.value||'custom');
    setPublicField('score-enable-points', !!normalized.enabled.points, 'checked');
    setPublicField('score-enable-grades', !!normalized.enabled.grades, 'checked');
    setPublicField('score-show-points', !!normalized.display.showPointsPublicly, 'checked');
    setPublicField('score-show-grades', !!normalized.display.showGradesPublicly, 'checked');
    setPublicField('score-show-grade-values', !!normalized.display.showGradePointValuePublicly, 'checked');
    const tie = document.querySelector(`input[name="score-tie-default"][value="${normalized.tiePolicyDefault}"]`);
    if(tie) tie.checked = true;
    setPublicField('policy-grade-maximum',normalized.policies.gradeCalculationMaximumMark||100);
    const panel = document.getElementById('scoring-config-panel');
    if(panel) panel.innerHTML = ['Single','Group'].map(type => scoreConfigCard(type, normalized.configs[type], normalized.enabled)).join('');
    const groupSummary=document.getElementById('policy-group-position-summary');if(groupSummary)groupSummary.innerHTML=normalized.configs.Group.points.map(point=>`<span class="rounded-lg border bg-white px-3 py-2 text-xs font-bold">${escapeHtml(point.label)}: ${Number(point.value||0)}</span>`).join('');
    window.updateGradeCalculatedMarks();window.lucide?.createIcons?.();
};
document.addEventListener('input',event=>{if(event.target.matches('[data-grade-minimum],#policy-grade-maximum'))window.updateGradeCalculatedMarks?.();});

window.renderScoringConfig = () => { scoringRules = {...readScoringConfigFromDom(),policyPack:'custom'}; window.renderScoringRules(); };
window.addPointRuleRow = (type) => { const list = document.querySelector(`[data-score-config="${type}"] [data-point-list]`); if(list){list.insertAdjacentHTML('beforeend', pointRuleRow({value:0,tiePolicy:document.querySelector('input[name="score-tie-default"]:checked')?.value||'full'},list.children.length));const pack=document.getElementById('score-policy-pack');if(pack)pack.value='custom';renderScoringPolicyPackGuide('custom');} };
window.addGradeRuleRow=(type)=>{const rules=readScoringConfigFromDom(),grades=rules.configs[type].grades,index=grades.length,minimum=Math.max(0,Number(grades[index-1]?.minimumPercentage||10)-10);grades.push({key:`${type.toLowerCase()}_grade_${Date.now()}`,order:index+1,label:gradeLabel(index),minimumPercentage:minimum,value:0});scoringRules={...rules,policyPack:'custom'};window.renderScoringRules();};
window.removeScoreRow=button=>{const row=button.closest('[data-point-row],[data-grade-row]');if(!row||button.disabled)return;const list=row.parentElement;if(row!==list.lastElementChild)return window.showToast('Remove the last additional row first so award order stays stable','error');row.remove();scoringRules={...readScoringConfigFromDom(),policyPack:'custom'};window.renderScoringRules();};
function renderScoringPolicyPackGuide(key){const pack=SCORING_POLICY_PACKS[key]||SCORING_POLICY_PACKS.custom,box=document.getElementById('score-policy-pack-guide');if(box)box.innerHTML=`<b class="text-indigo-900">${escapeHtml(pack.label)}</b><p class="mt-1">${escapeHtml(pack.description)}</p>`;}
window.applyScoringPolicyPack=key=>{const pack=SCORING_POLICY_PACKS[key]||SCORING_POLICY_PACKS.custom;if(key==='custom'){scoringRules={...readScoringConfigFromDom(),policyPack:'custom'};return renderScoringPolicyPackGuide('custom');}const rules=readScoringConfigFromDom();rules.policyPack=key;rules.enabled={...pack.enabled};scoringRules=rules;const team=document.getElementById('master-team-scoring');if(team&&pack.teamMode)team.value=pack.teamMode;window.renderScoringRules();window.renderMasterImpactReview?.();};
document.addEventListener('input',event=>{if(!event.target.closest('#master-scoring-slot')||event.target.id==='score-policy-pack')return;const pack=document.getElementById('score-policy-pack');if(pack&&pack.value!=='custom'){pack.value='custom';renderScoringPolicyPackGuide('custom');}});
function scoringValidationIssue(rules){
    if(!rules.enabled.points&&!rules.enabled.grades)return 'Enable Points, Grades, or both';
    for(const type of ['Single','Group']){
        const positionLabels=rules.configs[type].points.map(row=>row.label.trim().toLowerCase());
        if(rules.enabled.points&&positionLabels.some(label=>!label))return `${type} position labels cannot be empty`;
        if(new Set(positionLabels).size!==positionLabels.length)return `${type} position labels must be unique`;
        if(rules.configs[type].points.some(row=>Number(row.value)<0))return `${type} position points cannot be negative`;
    }
    for(const type of ['Single','Group']){
        const grades=rules.configs[type].grades,gradeLabels=grades.map(row=>row.label.trim().toLowerCase()),thresholds=grades.map(row=>Number(row.minimumPercentage));
        if(rules.enabled.grades&&gradeLabels.some(label=>!label))return `${type} grade labels cannot be empty`;
        if(new Set(gradeLabels).size!==gradeLabels.length)return `${type} grade labels must be unique`;
        if(rules.enabled.grades&&thresholds.some((value,index)=>value<0||value>100||(index&&value>=thresholds[index-1])))return `${type} grade minimums must be between 0 and 100 in strictly descending order`;
        if(grades.some(row=>Number(row.value)<0))return `${type} grade points cannot be negative`;
    }
    return '';
}
window.saveScoringRules = async () => {
    const rules = readScoringConfigFromDom();
    const issue=scoringValidationIssue(rules);if(issue)return window.showToast(issue,'error');
    await setDoc(doc(db, 'settings', 'scoring_rules'), { ...rules, updatedAt: Date.now() }, { merge: false });
    scoringRules = rules;
    window.renderScoringRules();
    window.showToast('Scoring rules saved');
};



const normalizeAccessUsername = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
const normalizeAccessEmailKey = (value) => `email_${normalizeAccessUsername(value).replace(/[^a-z0-9_@.-]/g, '_')}`;
const accessValue = (id) => document.getElementById(id)?.value.trim() || '';
const accessDocIdFor = (profile) => profile.authUid || profile.docId || profile.uid || profile.username || normalizeAccessEmailKey(profile.email);
const accessLoginEmailFor = (identifier) => {
    const value = String(identifier || '').trim();
    if(value.includes('@')) return value.toLowerCase();
    const username = normalizeAccessUsername(value);
    return username ? `${username}@fest.local` : '';
};
const accessUsernameFor = (identifier) => {
    const value = String(identifier || '').trim();
    if(value.includes('@')) return normalizeAccessUsername(value.split('@')[0]);
    return normalizeAccessUsername(value);
};

const createAccessAuthUser = async (email, password) => {
    const secondaryApp = initializeApp(app.options, `access-user-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const secondaryAuth = getSecondaryAuth(secondaryApp);
    try {
        const credential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        await signOutSecondary(secondaryAuth).catch(() => {});
        return credential.user.uid;
    } finally {
        await deleteApp(secondaryApp).catch(() => {});
    }
};

window.toggleAccessTeamField = () => {
    const wrap = document.getElementById('access-team-wrap');
    const genderWrap = document.getElementById('access-gender-wrap');
    const role = accessValue('access-role') || 'teamLeader';
    const isTeamLeader = role === 'teamLeader';
    if(wrap) wrap.classList.toggle('hidden', !isTeamLeader);
    if(genderWrap) genderWrap.classList.toggle('hidden', !isTeamLeader);
    const teamSelect = document.getElementById('access-team');
    if(teamSelect) {
        teamSelect.required = isTeamLeader;
        teamSelect.disabled = !isTeamLeader;
    }
    const genderSelect = document.getElementById('access-gender');
    if(genderSelect) {
        genderSelect.required = isTeamLeader;
        genderSelect.disabled = !isTeamLeader;
    }
    const title = document.getElementById('access-title');
    if(title) title.required = isTeamLeader;
    document.getElementById('access-title-required')?.classList.toggle('hidden', !isTeamLeader);
};

function accessCard(user) {
    const docId = accessDocIdFor(user);
    const roleLabel = user.role === 'teamLeader' ? `${escapeHtml(user.team || '-')} • ${escapeHtml(user.genderScope || 'Both')} • ${escapeHtml(user.title || 'Leader')}` : escapeHtml(user.title || user.role || '-');
    const active = user.active !== false;
    return `<div class="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
        <div class="flex justify-between gap-3"><div class="flex gap-3 min-w-0">${user.photoUrl?`<img src="${escapeHtml(user.photoUrl)}" alt="" class="w-10 h-10 rounded-full object-cover border border-slate-200 bg-slate-50 shrink-0">`:`<span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-indigo-100 text-xs font-black text-indigo-700">${escapeHtml((user.displayName||user.username||'U').charAt(0).toUpperCase())}</span>`}<div class="min-w-0"><p class="font-black text-slate-800 truncate">${escapeHtml(user.displayName || user.username || user.email || docId)}</p><p class="text-xs font-bold text-slate-500">${roleLabel}</p><p class="text-[11px] text-slate-400">${escapeHtml(user.username || '')} • ${escapeHtml(user.email || '')}</p></div></div><span class="text-[10px] font-black px-2 py-1 rounded-full h-fit ${active ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}">${active ? 'Active' : 'Inactive'}</span></div>
        <div class="flex flex-wrap gap-2 mt-3"><button data-admin-action="edit-access-user" data-uid="${escapeHtml(docId)}" class="px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-bold">Edit</button><button data-admin-action="toggle-access-active" data-uid="${escapeHtml(docId)}" class="px-3 py-1.5 rounded-lg ${active ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'} text-xs font-bold">${active ? 'Deactivate' : 'Activate'}</button><button data-admin-action="delete-access-user" data-uid="${escapeHtml(docId)}" class="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-bold">Delete</button></div>
    </div>`;
}

const visibleAccessUsers = () => {
    const map = new Map();
    accessUsers.forEach(user => {
        const key = `${user.role || ''}:${user.email || user.username || accessDocIdFor(user)}`;
        const existing = map.get(key);
        if(!existing || user.authUid || accessDocIdFor(user) === user.authUid) map.set(key, user);
    });
    return Array.from(map.values());
};

const accessListFilterConfig = {
    teamLeader: { title: 'Team Leaders', help: 'Team leader accounts only.', empty: 'No team leaders added', roles: ['teamLeader'] },
    judge: { title: 'Judges', help: 'Judge login accounts only.', empty: 'No judges added', roles: ['judge'] },
    publisher: { title: 'Publish/Admin Access', help: 'Publisher, Admin and Super Admin accounts only.', empty: 'No publisher/admin access added', roles: ['publisher', 'admin', 'superAdmin'] }
};

window.setAccessListFilter = (filter = 'teamLeader') => {
    selectedAccessListFilter = accessListFilterConfig[filter] ? filter : 'teamLeader';
    window.renderAccessManagement?.();
};

window.renderAccessManagement = () => {
    const profiles = visibleAccessUsers();
    const config = accessListFilterConfig[selectedAccessListFilter] || accessListFilterConfig.teamLeader;
    const selectedRoles = new Set(config.roles);
    const items = profiles.filter(user => selectedRoles.has(user.role)).sort((a,b) => (a.order || 999) - (b.order || 999));
    const list = document.getElementById('access-filtered-list');
    const title = document.getElementById('access-existing-title');
    const help = document.getElementById('access-existing-help');
    if(title) title.textContent = config.title;
    if(help) help.textContent = config.help;
    if(list) list.innerHTML = items.length ? items.map(accessCard).join('') : `<p class="col-span-full rounded-xl bg-slate-50 p-4 text-xs font-bold italic text-slate-400">${config.empty}</p>`;
    document.querySelectorAll('.access-list-filter').forEach(button => {
        const active = button.dataset.filter === selectedAccessListFilter;
        button.classList.toggle('bg-indigo-600', active);
        button.classList.toggle('text-white', active);
        button.classList.toggle('bg-slate-100', !active);
        button.classList.toggle('text-slate-600', !active);
        button.setAttribute('aria-pressed', String(active));
    });
    window.toggleAccessTeamField();
    window.lucide?.createIcons?.();
};

function clearAccessForm() {
    ['access-edit-uid','access-uid','access-username','access-email','access-identifier','access-password','access-name','access-photo','access-phone','access-title'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
    const gender = document.getElementById('access-gender'); if(gender) gender.value = '';
    const order = document.getElementById('access-order'); if(order) order.value = '1';
    const active = document.getElementById('access-active'); if(active) active.checked = true;
    window.toggleAccessTeamField();
    window.refreshImageUploadPreviews?.();
}

window.editAccessUser = (uid) => {
    const user = accessUsers.find(u => accessDocIdFor(u) === uid || u.uid === uid || u.docId === uid);
    if(!user) return;
    setPublicField('access-edit-uid', accessDocIdFor(user));
    setPublicField('access-uid', user.authUid || '');
    setPublicField('access-username', user.username || '');
    setPublicField('access-email', user.email || '');
    setPublicField('access-identifier', user.email || user.username || '');
    setPublicField('access-name', user.displayName || user.name || '');
    setPublicField('access-photo', user.photoUrl || '');
    setPublicField('access-password', '');
    setPublicField('access-phone', user.phone || '');
    setPublicField('access-role', user.role || 'teamLeader');
    setPublicField('access-team', user.team || '');
    setPublicField('access-gender', user.genderScope || 'Both');
    setPublicField('access-title', user.title || '');
    setPublicField('access-order', user.order || 1);
    setPublicField('access-active', user.active !== false, 'checked');
    window.toggleAccessTeamField();
    window.refreshImageUploadPreviews?.();
    window.switchTab('access');
};

const writeAccessProfile = async (docId, profile, syncRoleMirror = true) => {
    await setDoc(doc(db, 'accessUsers', docId), profile, { merge: true });
    await setDoc(doc(db, 'accessUsernames', profile.username), { ...profile, accessDocId: docId }, { merge: true });
    await setDoc(doc(db, 'accessUsernames', normalizeAccessEmailKey(profile.email)), { ...profile, accessDocId: docId }, { merge: true });
    if(syncRoleMirror && profile.role === 'teamLeader') await setDoc(doc(db, 'teamLeaders', docId), { uid: docId, authUid: profile.authUid || '', username: profile.username, displayName: profile.displayName, photoUrl: profile.photoUrl || '', phone: profile.phone, team: profile.team, genderScope: profile.genderScope || 'Both', title: profile.title || 'Leader', order: profile.order, active: profile.active, updatedAt: Date.now() }, { merge: true });
    if(syncRoleMirror && profile.role === 'judge') await setDoc(doc(db, 'judges', docId), { uid: docId, authUid: profile.authUid || '', username: profile.username, name: profile.displayName, photoUrl: profile.photoUrl || '', phone: profile.phone, active: profile.active, updatedAt: Date.now() }, { merge: true });
    if(syncRoleMirror && ['admin', 'superAdmin'].includes(profile.role)) await setDoc(doc(db, 'adminUsers', profile.authUid || docId), { username: profile.username, email: profile.email, displayName: profile.displayName, role: profile.role, active: profile.active, updatedAt: Date.now() }, { merge: true });
};

window.saveAccessUser = async () => {
    const identifier = accessValue('access-identifier');
    const username = accessUsernameFor(identifier);
    const email = accessLoginEmailFor(identifier);
    const password = accessValue('access-password');
    const role = accessValue('access-role') || 'teamLeader';
    const displayName = accessValue('access-name');
    const displayRole = accessValue('access-title');
    if(!role || !displayName || !identifier || !username || !email) return window.showToast('Role, display name and username/email are required', 'error');
    if(role === 'teamLeader' && !accessValue('access-team')) return window.showToast('Team is required for team leaders', 'error');
    if(role === 'teamLeader' && !['Boys', 'Girls', 'Both'].includes(accessValue('access-gender'))) return window.showToast('Gender access is required for team leaders', 'error');
    if(role === 'teamLeader' && !displayRole) return window.showToast('Display role is required for team leaders', 'error');
    const existingId = accessValue('access-edit-uid');
    const existingAuthUid = accessValue('access-uid');
    const previousProfile = existingId ? accessUsers.find(user => accessDocIdFor(user) === existingId) : null;
    if(!existingId && password.length < 6) return window.showToast('Password must be at least 6 characters for new access', 'error');
    if(existingId && password) return window.showToast('Existing Firebase passwords cannot be changed here. Leave it blank and use Firebase password reset.', 'error');
    if(previousProfile?.email && email !== previousProfile.email) return window.showToast('The login username/email cannot be changed after Firebase access is created. Create a new access instead.', 'error');
    let authUid = existingAuthUid;
    try {
        if(!existingId) authUid = await createAccessAuthUser(email, password);
        const docId = existingId || authUid || username;
        const profile = {
            username, email, role, displayName,
            authUid,
            accessPassword: deleteField(),
            passwordHash: deleteField(),
            passwordSalt: deleteField(),
            photoUrl: accessValue('access-photo'),
            phone: accessValue('access-phone'),
            team: role === 'teamLeader' ? accessValue('access-team') : '',
            genderScope: role === 'teamLeader' ? accessValue('access-gender') : '',
            title: displayRole,
            order: Number(accessValue('access-order') || 1),
            active: !!document.getElementById('access-active')?.checked,
            updatedAt: Date.now()
        };
        await writeAccessProfile(docId, profile);
        if(previousProfile?.role === 'teamLeader' && role !== 'teamLeader') await deleteDoc(doc(db, 'teamLeaders', existingId));
        if(previousProfile?.role === 'judge' && role !== 'judge') await deleteDoc(doc(db, 'judges', existingId));
        if(['admin', 'superAdmin'].includes(previousProfile?.role) && !['admin', 'superAdmin'].includes(role) && previousProfile.authUid) await deleteDoc(doc(db, 'adminUsers', previousProfile.authUid));
        if(profile.authUid && profile.authUid !== docId) await writeAccessProfile(profile.authUid, { ...profile, accessDocId: docId, sourceAccessDocId: docId }, false);
        clearAccessForm();
        window.showToast('Access profile saved');
    } catch(error) {
        console.error(error);
        const msg = error.code === 'auth/email-already-in-use'
            ? 'This login email already exists in Firebase Auth. Edit the existing access profile or use another username/email.'
            : 'Unable to save access profile';
        window.showToast(msg, 'error');
    }
};

window.toggleAccessActive = async (uid) => {
    const user = accessUsers.find(u => accessDocIdFor(u) === uid || u.uid === uid || u.docId === uid);
    if(!user) return;
    const nextActive = user.active === false;
    const patch = { active: nextActive, updatedAt: Date.now() };
    await updateDoc(doc(db, 'accessUsers', accessDocIdFor(user)), patch);
    if(user.authUid && user.authUid !== accessDocIdFor(user)) await setDoc(doc(db, 'accessUsers', user.authUid), patch, { merge: true });
    if(user.username) await setDoc(doc(db, 'accessUsernames', user.username), patch, { merge: true });
    if(user.email) await setDoc(doc(db, 'accessUsernames', normalizeAccessEmailKey(user.email)), patch, { merge: true });
    if(user.role === 'teamLeader') await setDoc(doc(db, 'teamLeaders', accessDocIdFor(user)), patch, { merge: true });
    if(user.role === 'judge') {
        await setDoc(doc(db, 'judges', accessDocIdFor(user)), patch, { merge: true });
        if(user.authUid && user.authUid !== accessDocIdFor(user)) await setDoc(doc(db, 'judges', user.authUid), patch, { merge: true });
    }
    if(['admin', 'superAdmin'].includes(user.role) && user.authUid) await setDoc(doc(db, 'adminUsers', user.authUid), patch, { merge: true });
    window.showToast(nextActive ? 'Access activated' : 'Access deactivated');
};

window.deleteAccessUser = async (uid) => {
    const user = accessUsers.find(u => accessDocIdFor(u) === uid || u.uid === uid || u.docId === uid);
    if(!user || !await window.confirmAction(`Delete access for ${user.displayName || uid}?`)) return;
    const docId = accessDocIdFor(user);
    await deleteDoc(doc(db, 'accessUsers', docId));
    if(user.authUid && user.authUid !== docId) await deleteDoc(doc(db, 'accessUsers', user.authUid));
    if(user.username) await deleteDoc(doc(db, 'accessUsernames', user.username));
    if(user.email) await deleteDoc(doc(db, 'accessUsernames', normalizeAccessEmailKey(user.email)));
    if(user.role === 'teamLeader') await deleteDoc(doc(db, 'teamLeaders', docId));
    if(user.role === 'judge') {
        await deleteDoc(doc(db, 'judges', docId));
        if(user.authUid && user.authUid !== docId) await deleteDoc(doc(db, 'judges', user.authUid));
        await Promise.all(judgeAssignments.filter(a => a.active !== false && (a.judgeId === docId || a.judgeId === user.authUid)).map(a => updateDoc(doc(db, 'judgeAssignments', a.id), { active: false, updatedAt: Date.now() })));
    }
    if(['admin', 'superAdmin'].includes(user.role) && user.authUid) await deleteDoc(doc(db, 'adminUsers', user.authUid));
    window.showToast('Access deleted');
};

const setPublicField = (id, value, prop = 'value') => {
    const el = document.getElementById(id);
    if(!el) return;
    el[prop] = value ?? '';
};
const publicLines = (value) => Array.isArray(value) ? value.join('\n') : '';
const readPublicLines = (id) => (document.getElementById(id)?.value || '').split('\n').map(v => v.trim()).filter(Boolean);
const isUploadedImageSource = (value) => /^data:image\/(jpeg|png|webp|gif);base64,/i.test(String(value || '').trim());
const isRemoteMediaSource = (value) => /^https?:\/\//i.test(String(value || '').trim());
const splitMediaSources = (values = []) => {
    const rows = Array.isArray(values) ? values : [values];
    return { uploaded: rows.filter(isUploadedImageSource), links: rows.filter(isRemoteMediaSource) };
};
const uniqueMediaSources = (...groups) => {
    const seen = new Set(), rows = [];
    groups.flat().map(item => String(item || '').trim()).filter(Boolean).forEach(item => { if(!seen.has(item)){ seen.add(item); rows.push(item); } });
    return rows;
};

window.renderPublicContentForm = () => {
    setPublicField('public-home-name1', homeConfig.festName1 || '');
    setPublicField('public-home-name2', homeConfig.festName2 || '');
    const logoSources = splitMediaSources(homeConfig.logoUrl || '');
    setPublicField('public-home-logo', logoSources.uploaded[0] || '');
    setPublicField('public-home-logo-link', logoSources.links[0] || '');
    setPublicField('public-home-tagline', homeConfig.tagline || '');
    setPublicField('public-home-btn-color', homeConfig.btnColor || '#0f172a');
    setPublicField('public-home-about-sub', homeConfig.aboutSubtitle || '');
    setPublicField('public-home-about-text', homeConfig.aboutText || '');
    const gallerySources = splitMediaSources(normalizeGallerySlots(homeConfig.gallery));
    setPublicField('public-home-gallery', JSON.stringify(normalizeGallerySlots(gallerySources.uploaded)));
    setPublicField('public-home-gallery-links', publicLines(gallerySources.links));

    const resultsPage = publicConfig.resultsPage || {};
    const teamPortal = publicConfig.teamPortal || {};
    const nextProgramCard = publicConfig.nextProgramCard || {};
    const footer = publicConfig.footer || {};
    const social = publicConfig.social || homeConfig.social || {};
    setPublicField('public-results-title', resultsPage.title || 'Fest Results');
    setPublicField('public-results-tab-label', resultsPage.resultsLabel || 'Results');
    setPublicField('public-results-team-title', resultsPage.teamTitle || 'Teams');
    setPublicField('public-results-team-subtitle', resultsPage.teamSubtitle || 'Complete scoreboard with detailed breakdown by category');
    setPublicField('public-results-talent-title', resultsPage.talentTitle || 'Top Talents');
    setPublicField('public-footer-text', footer.text || 'media team. All Rights Reserved.');
    setPublicField('public-team-dashboard-label', teamPortal.dashboardLabel || 'Dashboard');
    setPublicField('public-team-events-label', teamPortal.eventsLabel || 'Events');
    setPublicField('public-team-myreg-label', teamPortal.myRegistrationsLabel || 'My Registrations');
    setPublicField('public-team-report-label', teamPortal.reportsLabel || 'Reports');
    window.refreshImageUploadPreviews?.();
    setPublicField('public-team-notif-title', teamPortal.notificationsTitle || 'Notifications');
    setPublicField('public-team-points-label', teamPortal.pointsLabel || 'Total Points');
    setPublicField('public-schedule-next-text-color', nextProgramCard.textColor || '#ffffff');
    const nextBackgroundSources = splitMediaSources(nextProgramCard.backgroundImages || [nextProgramCard.backgroundImageUrl]);
    setPublicField('public-schedule-next-bg-image', publicLines(nextBackgroundSources.uploaded));
    setPublicField('public-schedule-next-bg-image-links', publicLines(nextBackgroundSources.links));
    setPublicField('public-schedule-next-image-interval', String(nextProgramCard.imageIntervalSeconds || 2));
    setPublicField('public-schedule-next-bg-video', nextProgramCard.backgroundVideoUrl || '');
    ['wa','ig','fb','yt','tg'].forEach(k => setPublicField(`public-social-${k}`, social[k] || ''));

    const tvShow = tvConfig.show || {};
    const tvBackground = tvConfig.background || {};
    setPublicField('public-tv-title', tvConfig.title || 'FEST LIVE');
    setPublicField('public-tv-ticker', tvConfig.ticker || 'Welcome to Fest Live • Results • Updates');
    setPublicField('public-tv-announcements', publicLines(tvConfig.announcements));
    setPublicField('public-tv-result-seconds', String(tvConfig.timing?.resultSeconds || 8));
    setPublicField('public-tv-reveal-seconds', String(tvConfig.timing?.revealSeconds || 2));
    setPublicField('public-tv-leaderboard-seconds', String(tvConfig.timing?.leaderboardSeconds || 10));
    setPublicField('public-tv-slide-seconds', String(tvConfig.timing?.slideSeconds || 7));
    setPublicField('public-tv-interrupt-policy', tvConfig.interruptPolicy || 'after-current');
    setPublicField('public-tv-bg-color', tvBackground.color || '#020617');
    const tvBackgroundImageSources = splitMediaSources(tvBackground.imageUrl || '');
    setPublicField('public-tv-bg-image', tvBackgroundImageSources.uploaded[0] || '');
    setPublicField('public-tv-bg-image-link', tvBackgroundImageSources.links[0] || '');
    setPublicField('public-tv-bg-video', tvBackground.videoUrl || '');
    setPublicField('public-tv-videos', publicLines(tvBackground.videos));
    setPublicField('public-tv-show-results', tvShow.results !== false, 'checked');
    setPublicField('public-tv-show-leaderboard', tvShow.leaderboard !== false, 'checked');
    setPublicField('public-tv-show-announcements', tvShow.announcements !== false, 'checked');
    setPublicField('public-tv-show-media', tvShow.media !== false, 'checked');
    setPublicField('public-tv-play-videos', tvShow.videos !== false, 'checked');
    const tvSlideSources = splitMediaSources(tvBackground.slides || []);
    setPublicField('public-tv-slides', publicLines(tvSlideSources.uploaded));
    setPublicField('public-tv-slides-links', publicLines(tvSlideSources.links));
    window.refreshImageUploadPreviews?.();
};


const buildTVDisplayConfigFromForm = () => {
    const value = (id) => document.getElementById(id)?.value.trim() || '';
    const checked = (id) => !!document.getElementById(id)?.checked;
    return {
        title: value('public-tv-title') || 'FEST LIVE',
        ticker: value('public-tv-ticker'),
        announcements: readPublicLines('public-tv-announcements'),
        interruptPolicy: value('public-tv-interrupt-policy') || 'after-current',
        timing: { resultSeconds:Number(value('public-tv-result-seconds')||8), revealSeconds:Number(value('public-tv-reveal-seconds')||2), leaderboardSeconds:Number(value('public-tv-leaderboard-seconds')||10), slideSeconds:Number(value('public-tv-slide-seconds')||7) },
        show: {
            results: checked('public-tv-show-results'),
            leaderboard: checked('public-tv-show-leaderboard'),
            announcements: checked('public-tv-show-announcements'),
            media: checked('public-tv-show-media'),
            videos: checked('public-tv-play-videos')
        },
        background: {
            color: value('public-tv-bg-color') || '#020617',
            imageUrl: value('public-tv-bg-image-link') || value('public-tv-bg-image'),
            videoUrl: value('public-tv-bg-video'),
            videos: readPublicLines('public-tv-videos'),
            slides: uniqueMediaSources(readPublicLines('public-tv-slides'), readPublicLines('public-tv-slides-links'))
        },
        updatedAt: Date.now()
    };
};

window.savePublicContentConfig = async () => {
    const btn = document.getElementById('btn-save-public-content');
    btn?.classList.add('opacity-75', 'cursor-not-allowed');
    if(btn) btn.disabled = true;
    const value = (id) => document.getElementById(id)?.value.trim() || '';
    const checked = (id) => !!document.getElementById(id)?.checked;
    const social = { wa: value('public-social-wa'), ig: value('public-social-ig'), fb: value('public-social-fb'), yt: value('public-social-yt'), tg: value('public-social-tg') };
        const nextHome = {
        festName1: value('public-home-name1'),
        festName2: value('public-home-name2'),
        logoUrl: value('public-home-logo-link') || value('public-home-logo'),
        tagline: value('public-home-tagline'),
        btnColor: value('public-home-btn-color') || '#0f172a',
        aboutSubtitle: value('public-home-about-sub'),
        aboutText: value('public-home-about-text'),
        gallery: normalizeGallerySlots(uniqueMediaSources(normalizeGallerySlots(document.getElementById('public-home-gallery')?.value), readPublicLines('public-home-gallery-links'))),
        social,
        updatedAt: Date.now(),
        setupCompleted: Boolean(value('public-home-name1').trim())
        };
    const nextPublic = {
        resultsPage: {
            title: value('public-results-title'),
            resultsLabel: value('public-results-tab-label'),
            teamTitle: value('public-results-team-title'),
            teamSubtitle: value('public-results-team-subtitle'),
            talentTitle: value('public-results-talent-title')
        },
        teamPortal: {
            dashboardLabel: value('public-team-dashboard-label'),
            eventsLabel: value('public-team-events-label'),
            myRegistrationsLabel: value('public-team-myreg-label'),
            reportsLabel: value('public-team-report-label'),
            notificationsTitle: value('public-team-notif-title'),
            pointsLabel: value('public-team-points-label')
        },
        nextProgramCard: {
            textColor: value('public-schedule-next-text-color') || '#ffffff',
            backgroundImages: uniqueMediaSources(readPublicLines('public-schedule-next-bg-image'), readPublicLines('public-schedule-next-bg-image-links')),
            backgroundImageUrl: uniqueMediaSources(readPublicLines('public-schedule-next-bg-image'), readPublicLines('public-schedule-next-bg-image-links'))[0] || '',
            imageIntervalSeconds: Math.max(2, Number(value('public-schedule-next-image-interval') || 2)),
            backgroundVideoUrl: value('public-schedule-next-bg-video')
        },
        footer: { text: value('public-footer-text') },
        social,
        updatedAt: Date.now()
    };
    try {
        assertPayloadSize(nextHome,'Home page settings');assertPayloadSize(nextPublic,'Public page settings');
        await Promise.all([
            setDoc(doc(db, 'settings', 'home_config'), nextHome, { merge: true }),
            setDoc(doc(db, 'settings', 'public_config'), nextPublic, { merge: true })
        ]);
        homeConfig = { ...homeConfig, ...nextHome };
        publicConfig = { ...publicConfig, ...nextPublic };
        window.showToast('Public page content saved');
    } catch (error) {
        console.error(error);
        window.showToast('Unable to save public content', 'error');
    } finally {
        btn?.classList.remove('opacity-75', 'cursor-not-allowed');
        if(btn) btn.disabled = false;
        window.lucide?.createIcons?.();
    }
};

window.saveTVDisplaySettings = async () => {
    const btn = document.getElementById('btn-save-tv-display');
    btn?.classList.add('opacity-75', 'cursor-not-allowed');
    if(btn) btn.disabled = true;
    const nextTV = buildTVDisplayConfigFromForm();
    try {
        assertPayloadSize(nextTV,'TV display settings');await setDoc(doc(db, 'settings', 'tv_config'), nextTV, { merge: true });
        tvConfig = { ...tvConfig, ...nextTV };
        window.showToast('TV display settings saved');
    } catch (error) {
        console.error(error);
        window.showToast('Unable to save TV display settings', 'error');
    } finally {
        btn?.classList.remove('opacity-75', 'cursor-not-allowed');
        if(btn) btn.disabled = false;
        window.lucide?.createIcons?.();
    }
};

// --- DATA MANIPULATION LOGIC (Add/Edit/Delete/Clear) ---
const RESET_SCOPES = Object.freeze({
    students: { label: 'Students & Competition Data', icon: 'graduation-cap', description: 'All students, registrations, results and judge scores. Events and general participants stay intact.', collections: ['students', 'registrationApplications', 'registrations', 'results', 'resultRevisions', 'teamScoreLedgers', 'judgeScores', 'publicJudgingStatuses'] },
    participants: { label: 'Participants & Registrations', icon: 'contact-round', description: 'All parent, staff, alumni, public and guest records, plus every event registration.', collections: ['participants', 'registrations'] },
    requests: { label: 'Registration Requests', icon: 'inbox', description: 'Pending, approved and rejected public registration requests.', collections: ['registrationRequests', 'registrationApplications', 'registrationVerificationAttempts', 'studentRegistrationSessions'] },
    events: { label: 'Events & Linked Data', icon: 'calendar-x', description: 'Events, imports, entries, results, revisions, ledgers, judging, schedule history and notifications.', collections: ['events', 'eventImportSessions', 'registrations', 'results', 'resultRevisions', 'teamScoreLedgers', 'judgeAssignments', 'judgeScores', 'publicJudgingStatuses', 'scheduleBreaks', 'scheduleVersions', 'notifications'] },
    registrations: { label: 'Registrations Only', icon: 'clipboard-x', description: 'All student, participant and group event entries; directories stay intact.', collections: ['registrationApplications', 'registrations'] },
    results: { label: 'Results & Publication', icon: 'trophy', description: 'Published results, revision history, score ledgers and result notifications; judge sheets stay intact.', collections: ['results', 'resultRevisions', 'teamScoreLedgers', 'notifications'] },
    schedule: { label: 'Complete Schedule', icon: 'calendar-clock', description: 'Breaks, versions and every date/time/stage/order value stored on events.', collections: ['scheduleBreaks', 'scheduleVersions'], clearEventSchedule: true },
    scheduleHistory: { label: 'Schedule History', icon: 'history', description: 'Saved schedule versions only; the current event schedule stays intact.', collections: ['scheduleVersions'] },
    judging: { label: 'Complete Judging Data', icon: 'gavel', description: 'Judge directory, assignments, score sheets and public submission markers.', collections: ['judges', 'judgeAssignments', 'judgeScores', 'publicJudgingStatuses'] },
    judgeScores: { label: 'Judge Scores Only', icon: 'file-x-2', description: 'Score sheets and submission markers; judges and assignments stay intact.', collections: ['judgeScores', 'publicJudgingStatuses'] },
    notifications: { label: 'Notifications', icon: 'bell-off', description: 'All team and public notification messages.', collections: ['notifications'] },
    nonAdminAccess: { label: 'All Non-Admin Access', icon: 'user-x', description: 'Team leader, judge and publisher profiles/mappings; Admin identities are protected.', collections: ['teamLeaders', 'judges', 'judgeAssignments', 'judgeScores', 'publicJudgingStatuses'], clearNonAdminAccess: true },
    settings: { label: 'All Configuration', icon: 'settings-2', description: 'Master, team, scoring, schedule, branding, public page and TV settings.', collections: ['settings'] },
    posterCertificates: { label: 'Poster & Certificate Models', icon: 'badge-check', description: 'Published poster, certificate and ID-card layouts.', collections: ['posterCertificateModels'] },
    auditLogs: { label: 'Audit Logs', icon: 'scroll-text', description: 'Administrative and publishing history. This cannot be restored.', collections: ['auditLogs'], archive: false },
    deletedBackups: { label: 'Deleted Backups', icon: 'archive-x', description: 'All deletion archives. This permanently removes restore data.', collections: ['deletedBackups'], archive: false }
});

const FACTORY_RESET_COLLECTIONS = Object.freeze([
    'students', 'participants', 'registrationRequests', 'registrationApplications', 'registrationVerificationAttempts', 'studentRegistrationSessions', 'teamRegistrationPolicies', 'events', 'eventImportSessions', 'registrations', 'results', 'resultRevisions', 'teamScoreLedgers', 'notifications',
    'scheduleBreaks', 'scheduleVersions', 'judgeAssignments', 'judgeScores', 'publicJudgingStatuses', 'judges',
    'teamLeaders', 'settings', 'posterCertificateModels', 'posterCertificateSources', 'auditLogs', 'deletedBackups'
]);
const ADMIN_ROLES = Object.freeze(['admin', 'superAdmin']);
const resetProgressState = { total: 0, completed: 0 };
const resetPercent = (completed, total) => total ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
const setResetProgress = ({ message = '', detail = '', completed = resetProgressState.completed, total = resetProgressState.total, percent = resetPercent(completed, total) } = {}) => {
    const el = document.getElementById('reset-progress'); if(!el) return;
    const visible = !!message;
    el.classList.toggle('hidden', !visible);
    if(!visible) return;
    const safeCompleted = Math.min(Number(completed) || 0, Number(total) || 0), safeTotal = Number(total) || 0, safePercent = Number.isFinite(Number(percent)) ? Math.min(100, Math.max(0, Number(percent))) : resetPercent(safeCompleted, safeTotal);
    document.getElementById('reset-progress-message').textContent = message;
    document.getElementById('reset-progress-percent').textContent = `${Math.round(safePercent)}%`;
    document.getElementById('reset-progress-bar').style.width = `${safePercent}%`;
    document.getElementById('reset-progress-detail').textContent = detail || `${safeCompleted} / ${safeTotal} records`;
};

window.renderResetScopes = () => {
    const grid = document.getElementById('specific-reset-grid');
    if(!grid) return;
    grid.innerHTML = Object.entries(RESET_SCOPES).map(([key, scope]) => `<article class="flex min-h-40 flex-col rounded-2xl border border-slate-200 bg-slate-50 p-4"><div class="flex items-center gap-2"><span class="grid h-9 w-9 place-items-center rounded-xl bg-white text-slate-600 shadow-sm"><i data-lucide="${scope.icon}" class="h-4 w-4"></i></span><h5 class="font-black text-slate-800">${scope.label}</h5></div><p class="mt-2 flex-1 text-xs font-semibold leading-relaxed text-slate-500">${scope.description}</p><button data-admin-action="clear-reset-scope" data-scope="${key}" class="mt-3 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-xs font-black text-red-600 hover:bg-red-600 hover:text-white">Review & Clear</button></article>`).join('');
    window.lucide?.createIcons?.();
};

async function archiveDeletedDocs(collectionName, snapshot, meta = {}) {
    if(snapshot.empty) return true;
    const archive = {
        collectionName,
        action: meta.action || 'delete',
        displayName: meta.displayName || collectionName,
        count: snapshot.size,
        createdAt: Date.now(),
        docs: snapshot.docs.map(d => ({ id: d.id, path: d.ref.path, data: d.data() }))
    };
    try {
        const backupRef = await addDoc(collection(db, "deletedBackups"), archive);
        await addDoc(collection(db, "auditLogs"), { ...meta, collectionName, count: snapshot.size, backupId: backupRef.id, createdAt: Date.now() });
        return true;
    } catch (e) {
        console.warn("Backup/audit write failed; continuing delete", e);
        return false;
    }
}

async function deleteSnapshotBatch(collectionName, snapshot, meta = {}) {
    if (snapshot.empty) return { count: 0, archived: true };
    const archived = meta.archive === false ? true : await archiveDeletedDocs(collectionName, snapshot, meta);
    let count = 0;
    for(let offset = 0; offset < snapshot.docs.length; offset += 100) {
        const chunk = snapshot.docs.slice(offset, offset + 100);
        await Promise.all(chunk.map(item => deleteDoc(item.ref)));
        count += chunk.length;
        if(typeof meta.onProgress === 'function') meta.onProgress({ collectionName, count, total: snapshot.size, chunk: chunk.length });
    }
    return { count: snapshot.size, archived };
}

async function deleteCollectionBatch(collectionName, queryRef = null, meta = {}) {
    const ref = queryRef || collection(db, collectionName);
    const snapshot = await getDocs(ref);
    return deleteSnapshotBatch(collectionName, snapshot, meta);
}

const loadCollectionSnapshots = names => Promise.all(names.map(name => getDocs(collection(db, name))));
const snapshotTotal = snapshots => snapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);
async function clearEventScheduleFields(onProgress = null) {
    const snapshot = await getDocs(collection(db, 'events'));
    let count = 0;
    for(let offset=0; offset<snapshot.docs.length; offset+=400) {
        const chunk = snapshot.docs.slice(offset,offset+400), batch=writeBatch(db);
        chunk.forEach(item => batch.update(item.ref, {
            scheduleDate: deleteField(), scheduleDay: deleteField(), scheduleDayId: deleteField(), scheduleStage: deleteField(),
            scheduleStageId: deleteField(), scheduleDuration: deleteField(), scheduleEndTime: deleteField(), scheduleNotes: deleteField(),
            scheduleOrder: deleteField(), scheduleStatus: deleteField(), time: deleteField(), updatedAt: Date.now()
        }));
        await batch.commit();
        count += chunk.length;
        onProgress?.({ collectionName: 'events schedule fields', count, total: snapshot.size, chunk: chunk.length });
    }
    return snapshot.size;
}
async function nonAdminAccessSnapshots() {
    const [profiles, mappings] = await Promise.all([getDocs(collection(db, 'accessUsers')), getDocs(collection(db, 'accessUsernames'))]);
    return [
        { docs: profiles.docs.filter(item => !ADMIN_ROLES.includes(item.data().role)), get size(){ return this.docs.length; }, get empty(){ return !this.docs.length; } },
        { docs: mappings.docs.filter(item => !ADMIN_ROLES.includes(item.data().role)), get size(){ return this.docs.length; }, get empty(){ return !this.docs.length; } }
    ];
}
async function clearNonAdminAccess(meta) {
    const [profiles, mappings] = await nonAdminAccessSnapshots();
    const first=await deleteSnapshotBatch('accessUsers', profiles, meta), second=await deleteSnapshotBatch('accessUsernames', mappings, meta);
    return first.count + second.count;
}

window.clearResetScope = async scopeKey => {
    const scope=RESET_SCOPES[scopeKey]; if(!scope) return;
    try {
        const snapshots=await loadCollectionSnapshots(scope.collections), accessSnapshots=scope.clearNonAdminAccess ? await nonAdminAccessSnapshots() : [];
        const scheduleCount=scope.clearEventSchedule ? (await getDocs(collection(db,'events'))).size : 0;
        const total=snapshotTotal(snapshots)+snapshotTotal(accessSnapshots)+scheduleCount;
        if(!total) return window.showToast(`No ${scope.label} data to clear`, 'error');
        const phrase=`DELETE ${scope.label}`;
        const confirmation=await window.promptAction(`Type '${phrase}' to permanently clear ${total} record${total===1?'':'s'}:`);
        if(confirmation!==phrase) { if(confirmation!==null) window.showToast('Verification failed. Delete cancelled.','error'); return; }
        document.getElementById('app-loader')?.classList.remove('hide');
        resetProgressState.total = total; resetProgressState.completed = 0;
        setResetProgress({ message: `Clearing ${scope.label}…`, completed: 0, total });
        let deleted=0;
        const onProgress = ({ collectionName, chunk }) => { resetProgressState.completed += chunk; setResetProgress({ message: `Clearing ${scope.label}: ${collectionName}`, completed: resetProgressState.completed, total }); };
        for(let index=0; index<scope.collections.length; index++) {
            setResetProgress({ message: `Clearing ${scope.label}: ${scope.collections[index]} (${index+1}/${scope.collections.length})…`, completed: resetProgressState.completed, total });
            deleted+=(await deleteSnapshotBatch(scope.collections[index],snapshots[index],{action:'clearResetScope',displayName:scope.label,archive:scope.archive,onProgress})).count;
        }
        if(scope.clearEventSchedule) deleted+=await clearEventScheduleFields(onProgress);
        if(scope.clearNonAdminAccess) deleted+=await clearNonAdminAccess({action:'clearNonAdminAccess',displayName:scope.label,onProgress});
        setResetProgress({ message: `${scope.label} cleared`, completed: total, total, percent: 100 }); window.showToast(`Cleared ${deleted} records from ${scope.label}`);
    } catch(error) { console.error(error); setResetProgress({ message: 'Reset stopped because an error occurred. No further records were deleted.', completed: resetProgressState.completed, total: resetProgressState.total }); window.showToast('Unable to complete this reset','error'); }
    finally { document.getElementById('app-loader')?.classList.add('hide'); }
};

window.deleteTeamData = async () => {
    const team = document.getElementById('reset-team-select').value;
    if (!team) return window.showToast("Select a team first", "error");
    const qStd = query(collection(db, "students"), where("team", "==", team));
    const qReg = query(collection(db, "registrations"), where("team", "==", team));
    const queries=[qStd, qReg, query(collection(db,"notifications"),where("team","==",team)), query(collection(db,"participants"),where("team","==",team)), query(collection(db,"registrationRequests"),where("team","==",team)), query(collection(db,"registrationApplications"),where("team","==",team)), query(collection(db,"teamRegistrationPolicies"),where("team","==",team)), query(collection(db,"teamLeaders"),where("team","==",team)), query(collection(db,"accessUsers"),where("team","==",team)), query(collection(db,"accessUsernames"),where("team","==",team))];
    const names=['students','registrations','notifications','participants','registrationRequests','registrationApplications','teamRegistrationPolicies','teamLeaders','accessUsers','accessUsernames'];
    const snapshots=await Promise.all(queries.map(item=>getDocs(item)));
    const total=snapshotTotal(snapshots);
    if(!total) return window.showToast(`No data found for ${team}`, "error");
    const confirmation = await window.promptAction(`Type '${team}' to delete ${total} records:`);
    if (confirmation !== team) return window.showToast("Incorrect team name. Action cancelled.", "error");
    document.getElementById('app-loader').classList.remove('hide');
    try {
        resetProgressState.total = total; resetProgressState.completed = 0;
        const onProgress = ({ collectionName, chunk }) => { resetProgressState.completed += chunk; setResetProgress({ message: `Clearing ${team}: ${collectionName}`, completed: resetProgressState.completed, total }); };
        setResetProgress({ message: `Clearing ${team} team data…`, completed: 0, total });
        const results = [];
        for(let index=0; index<names.length; index++) results.push(await deleteSnapshotBatch(names[index],snapshots[index],{action:'deleteTeamData',team,onProgress}));
        const deleted = results.reduce((sum, r) => sum + r.count, 0);
        const archived = results.every(r => r.archived);
        setResetProgress({ message: `${team} team data cleared`, completed: total, total, percent: 100 });
        window.showToast(`Cleared ${deleted} records for ${team}${archived ? '' : ' (backup not saved)'}`);
    } catch (e) { console.error(e); setResetProgress({ message: 'Team reset stopped because an error occurred.', completed: resetProgressState.completed, total: resetProgressState.total }); window.showToast("Error clearing team data", "error"); }
    document.getElementById('app-loader')?.classList.add('hide');
};

window.factoryReset = async () => {
    const snapshots=await loadCollectionSnapshots(FACTORY_RESET_COLLECTIONS);
    const accessSnapshots=await nonAdminAccessSnapshots();
    const total=snapshotTotal(snapshots)+snapshotTotal(accessSnapshots);
    if(!total) return window.showToast('Application is already in a clean state','error');
    const confirmation = await window.promptAction(`Type 'DELETE EVERYTHING' to delete ${total} records. Admin/Super Admin login identities will remain:`);
    if (confirmation !== 'DELETE EVERYTHING') return window.showToast("Verification failed. Reset cancelled.", "error");
    const adminConfirmation=await window.promptAction(`Type your current Admin email '${auth.currentUser?.email || ''}' to confirm:`);
    if(adminConfirmation!==(auth.currentUser?.email||'')) return window.showToast('Admin identity verification failed. Reset cancelled.','error');
    document.getElementById('app-loader').classList.remove('hide');
    try {
        resetProgressState.total = total; resetProgressState.completed = 0;
        setResetProgress({ message: 'Factory Reset: preparing known app collections…', completed: 0, total });
        let deleted=0, usedServerSweep=false;
        const onProgress = ({ collectionName, chunk }) => { resetProgressState.completed += chunk; setResetProgress({ message: `Factory Reset: clearing ${collectionName}`, completed: resetProgressState.completed, total }); };
        for(let index=0;index<FACTORY_RESET_COLLECTIONS.length;index++) {
            const name=FACTORY_RESET_COLLECTIONS[index];
            setResetProgress({ message: `Factory Reset: clearing ${name} (${index+1}/${FACTORY_RESET_COLLECTIONS.length})…`, completed: resetProgressState.completed, total });
            deleted+=(await deleteSnapshotBatch(name,snapshots[index],{action:'factoryReset',archive:false,onProgress})).count;
        }
        setResetProgress({ message: 'Factory Reset: clearing non-admin access…', completed: resetProgressState.completed, total });
        deleted+=await clearNonAdminAccess({action:'factoryReset',archive:false,onProgress});
        setResetProgress({ message: 'Factory Reset: final server sweep for unknown collections…', detail: `${deleted} known records cleared; checking for leftovers`, completed: total, total, percent: 100 });
        try {
            const response=await completeFactoryReset({confirmation:'DELETE EVERYTHING'});
            const swept=Number(response.data?.deleted||0);
            usedServerSweep=true;
            if(swept>0) deleted+=swept;
        } catch(serverError) {
            console.warn('Server factory reset sweep unavailable after client reset.',serverError);
        }
        setResetProgress({ message: 'Factory Reset complete', detail: `${deleted} records deleted. Admin/Super Admin login preserved.`, completed: total, total, percent: 100 });
        window.showToast(`Factory Reset complete. Deleted ${deleted} records; Admin login was preserved${usedServerSweep ? '' : ' (server sweep unavailable)'}.`);
        clearBrandingCache(); applyAdminLoaderBranding(DEFAULT_BRANDING);
    } catch (e) { console.error(e); setResetProgress({ message: 'Factory Reset stopped after an error. Run it again to clear any remaining records.', completed: resetProgressState.completed, total: resetProgressState.total }); window.showToast("Error performing reset", "error"); }
    document.getElementById('app-loader')?.classList.add('hide');
};

window.renderResetScopes();

// --- REGISTRATIONS LOGIC ---
window.populateRegEvents = () => {
    const cat = document.getElementById('reg-filter-cat')?.value || '';
    const stage = document.getElementById('reg-filter-stage')?.value || '';
    const gender = document.getElementById('reg-filter-gender')?.value || '';
    const participation = document.getElementById('reg-filter-participation')?.value || 'all';
    const evSelect = document.getElementById('reg-filter-event');
    const genderSelect = document.getElementById('reg-filter-gender');
    if(genderSelect && genderSelect.options.length <= 1) genderSelect.innerHTML = '<option value="">All Genders</option>' + [...new Set(events.map(e => genderLabel(e)).filter(Boolean))].map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    let filteredEvents = finalEntryFilteredEvents({ cat, stage, gender, participation });
    if(evSelect) {
        const old = evSelect.value;
        evSelect.innerHTML = '<option value="all">All Events</option>' + filteredEvents.map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('');
        evSelect.value = filteredEvents.some(e => e.id === old) ? old : 'all';
    }
    window.renderRegList(true);
};


const registrationPersonIds = registration => [...new Set([...(registration.studentIds || []), ...(registration.participantIds || [])].filter(Boolean).map(String))];
const registrationPersonEventKey = (eventId, personId) => `${eventId}__${personId}`;
const registrationDocSafe = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
const registrationDocumentId = (eventId, personId) => `reg_${registrationDocSafe(eventId)}_${registrationDocSafe(personId)}`;
const existingRegistrationForPersonEvent = (eventId, personId) => registrations.find(registration => registration.eventId === eventId && registrationPersonIds(registration).includes(String(personId)));
const registrationPayloadHasParticipant = payload => [...(payload.studentIds || []), ...(payload.participantIds || [])].filter(Boolean).length > 0;
const setUniqueRegistration = (batch, { eventId, primaryPersonId, payload }) => {
    const personId = String(primaryPersonId || registrationPersonIds(payload)[0] || '');
    if(!eventId || !personId || existingRegistrationForPersonEvent(eventId, personId)) return false;
    batch.set(doc(db, 'registrations', registrationDocumentId(eventId, personId)), payload, { merge: false });
    return true;
};
const uniqueRegistrationRows = () => {
    const seen = new Set();
    return registrations.map(registration => {
        const next = { ...registration };
        next.studentIds = (registration.studentIds || []).filter(id => { const key = registrationPersonEventKey(registration.eventId, id); if(seen.has(key)) return false; seen.add(key); return true; });
        next.participantIds = (registration.participantIds || []).filter(id => { const key = registrationPersonEventKey(registration.eventId, id); if(seen.has(key)) return false; seen.add(key); return true; });
        return next;
    }).filter(registrationPayloadHasParticipant);
};

const finalEntryEventTeams = eventId => [...new Set(uniqueRegistrationRows().filter(r => r.eventId === eventId && r.team).map(r => r.team))];
const finalEntryParticipationState = event => {
    const count = finalEntryEventTeams(event.id).length, total = teams.length;
    if(count === 0) return 'none';
    if(total > 0 && count >= total) return 'complete';
    return 'partial';
};
const finalEntryFilteredEvents = ({ cat = '', stage = '', gender = '', participation = 'all' } = {}) => {
    let filteredEvents = cat ? events.filter(e => e.category === cat || (cat !== 'General' && e.category === 'General')) : [...events];
    if(stage) filteredEvents = filteredEvents.filter(e => e.stage === stage);
    if(gender) filteredEvents = filteredEvents.filter(e => genderLabel(e) === gender);
    if(participation && participation !== 'all') filteredEvents = filteredEvents.filter(e => finalEntryParticipationState(e) === participation);
    return filteredEvents.sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
};

const registrationTimestamp = value => {
    const millis = typeof value?.toMillis === 'function' ? value.toMillis() : Number(value || 0);
    if(!millis) return 'Time not recorded';
    return new Date(millis).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};
const registrationIsFestCommittee = registration => registration?.adminOverride === true || String(registration?.registrationSource || '').startsWith('admin');
const registrationParticipantProvenance = (registration, studentId) => {
    const participant = registration.participantMeta?.[studentId] || {};
    if(registrationIsFestCommittee(registration) || participant.addedByRole === 'fest_committee') {
        return { name: 'Fest Committee', role: 'Admin override', username: '', time: registrationTimestamp(participant.addedAt || registration.createdAt || registration.lastUpdatedAt) };
    }
    const actorUid = participant.addedByUid || registration.createdByUid || registration.lastUpdatedByUid || '';
    const actorProfile = accessUsers.find(user => user.id === actorUid || user.uid === actorUid || user.authUid === actorUid || user.docId === actorUid);
    const displayRole = actorProfile?.title || actorProfile?.role || participant.addedByRole || registration.createdByRole || registration.lastUpdatedByRole || '';
    return {
        name: actorProfile?.displayName || actorProfile?.name || participant.addedByName || registration.createdByName || registration.lastUpdatedByName || 'Legacy / Not recorded',
        role: displayRole,
        username: actorProfile?.username || participant.addedByUsername || registration.createdByUsername || registration.lastUpdatedByUsername || '',
        time: registrationTimestamp(participant.addedAt || registration.createdAt || registration.lastUpdatedAt)
    };
};

window.renderRegList = (force = false) => {
    const evId = document.getElementById('reg-filter-event')?.value || 'all';
    const cat = document.getElementById('reg-filter-cat')?.value || '';
    const stage = document.getElementById('reg-filter-stage')?.value || '';
    const gender = document.getElementById('reg-filter-gender')?.value || '';
    const participation = document.getElementById('reg-filter-participation')?.value || 'all';
    const container = document.getElementById('registrations-container');
    if(!container) return;
    const visibleRegistrations = uniqueRegistrationRows();
    const currentHash = generateHash(visibleRegistrations) + generateHash(events) + evId + cat + stage + gender + participation + expandedRegistrationEventId + generateHash(students);
    if(!force && lastRenderHash.regs === currentHash) return;
    lastRenderHash.regs = currentHash;

    const sortedTeams = [...teams].sort();
    const renderTeamCard = (teamName, eventInfo, showEmpty = true) => {
        const teamRegs = visibleRegistrations.filter(r => r.eventId === eventInfo.id && r.team === teamName).sort((a,b)=>a.slotIndex-b.slotIndex);
        const isRegistered = teamRegs.length > 0;
        if(!isRegistered && !showEmpty) return '';
        let contentHtml = '';
        if (isRegistered) {
            contentHtml = teamRegs.map(r => {
                const studentList = [...(r.studentIds||[]), ...(r.participantIds||[])].map(sid => {
                    const application=registrationApplications.find(item=>(item.studentId===sid||item.participantId===sid)&&item.eventId===r.eventId),meta=r.participantMeta?.[sid]||{},s=students.find(std=>std.id===sid)||participants.find(item=>item.id===sid)||{id:sid,name:meta.name||application?.studentName||application?.participantName||'Participant',chestNo:meta.chestNo||application?.chestNo||'',team:r.team,category:application?.category||''};
                    const provenance = registrationParticipantProvenance(r, sid);
                    const actorDetail = [provenance.role, provenance.username && `@${provenance.username}`].filter(Boolean).join(' • ');
                    return `<div class="p-2 bg-slate-50 rounded-lg text-sm border border-slate-100 mb-1 group/std"><div class="flex items-center justify-between gap-2"><div class="flex min-w-0 items-center gap-2"><span class="font-mono text-indigo-600 font-bold text-xs bg-indigo-50 px-1.5 rounded">${escapeHtml(s.chestNo || '-')}</span><span class="text-slate-700 font-medium truncate max-w-[120px] sm:max-w-[150px]">${escapeHtml(s.name)}</span></div><button data-admin-action="reject-student" data-reg-id="${escapeHtml(r.id)}" data-student-id="${escapeHtml(s.id)}" data-team="${escapeHtml(teamName)}" data-event-name="${escapeHtml(eventInfo?.name)}" data-student-name="${escapeHtml(s.name)}" data-event-id="${escapeHtml(eventInfo?.id)}" class="p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition opacity-100" title="Remove Participant"><i data-lucide="x" class="w-4 h-4"></i></button></div><div class="mt-1.5 rounded-md border border-blue-100 bg-white px-2 py-1 text-[9px] font-bold leading-relaxed text-slate-500"><span class="text-blue-700">Added by ${escapeHtml(provenance.name)}</span>${actorDetail ? ` • ${escapeHtml(actorDetail)}` : ''}<br><span>${escapeHtml(provenance.time)}</span></div></div>`;
                }).join('');
                return `<div class="mt-3 border-l-2 border-indigo-200 pl-3"><div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-wider">Slot ${r.slotIndex}</span><button data-admin-action="reject-team" data-reg-id="${escapeHtml(r.id)}" data-team="${escapeHtml(teamName)}" data-event-name="${escapeHtml(eventInfo?.name)}" data-event-id="${escapeHtml(eventInfo?.id)}" class="text-[10px] font-bold text-red-500 hover:bg-red-50 px-2 py-1 rounded border border-red-100 transition">Reject Entry</button></div><div class="space-y-1">${studentList || '<p class="text-[10px] text-red-400 italic">No participants listed</p>'}</div></div>`;
            }).join('');
        } else { contentHtml = `<div class="py-6 text-center"><span class="text-xs font-bold text-slate-400 italic flex flex-col items-center gap-1"><i data-lucide="minus-circle" class="w-5 h-5 opacity-50"></i>Not Registered</span></div>`; }
        const cardBorder = isRegistered ? 'border-indigo-500 ring-1 ring-indigo-500/20' : 'border-slate-200';
        const cardBg = isRegistered ? 'bg-white' : 'bg-slate-50/50';
        const headerColor = isRegistered ? 'text-indigo-700' : 'text-slate-500';
        return `<div class="rounded-xl border ${cardBorder} ${cardBg} shadow-sm overflow-hidden break-inside-avoid transition hover:shadow-md animate-enter"><div class="px-4 py-3 bg-slate-100/50 border-b border-slate-100 flex justify-between items-center"><h4 class="font-bold ${headerColor} truncate max-w-[70%]">${escapeHtml(teamLabel(teamName))}</h4>${isRegistered ? `<span class="bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">Registered</span>` : ''}</div><div class="p-3">${contentHtml}</div></div>`;
    };

    const eventsToRender = evId && evId !== 'all' ? events.filter(e => e.id === evId) : finalEntryFilteredEvents({ cat, stage, gender, participation });
    if(evId && evId !== 'all' && !eventsToRender.length) { container.innerHTML = '<p class="py-10 text-center text-sm font-bold text-slate-400">Event not found.</p>'; return; }
    container.innerHTML = eventsToRender.length ? eventsToRender.map(eventInfo => {
        const registeredTeams = sortedTeams.filter(teamName => visibleRegistrations.some(r => r.eventId === eventInfo.id && r.team === teamName));
        const state = finalEntryParticipationState(eventInfo), expanded = (evId && evId !== 'all') || expandedRegistrationEventId === eventInfo.id;
        const cancelled = eventInfo.cancelled === true;
        const stateLabel = state === 'none' ? 'No team' : state === 'complete' ? 'All teams' : 'Partial teams';
        const cancelButton = cancelled ? `<button data-admin-action="cancel-registration-event" data-id="${escapeHtml(eventInfo.id)}" class="rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-black text-red-700">Edit Cancel</button><button data-admin-action="undo-registration-event-cancel" data-id="${escapeHtml(eventInfo.id)}" class="rounded-xl bg-slate-900 px-3 py-2 text-xs font-black text-white">Undo</button>` : `<button data-admin-action="cancel-registration-event" data-id="${escapeHtml(eventInfo.id)}" class="rounded-xl bg-red-600 px-3 py-2 text-xs font-black text-white">Cancel Event</button>`;
        return `<section class="mb-3 overflow-hidden rounded-2xl border ${cancelled?'border-red-300 bg-red-50':'border-slate-200 bg-white'} shadow-sm"><button type="button" data-admin-action="toggle-final-entry-event" data-id="${escapeHtml(eventInfo.id)}" class="flex w-full flex-col gap-3 p-4 text-left md:flex-row md:items-center md:justify-between"><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="font-black ${cancelled?'text-red-900':'text-slate-800'}">${escapeHtml(eventInfo.name)}</h3>${cancelled?'<span class="rounded-full bg-red-600 px-2 py-1 text-[9px] font-black uppercase text-white">Cancelled</span>':''}</div><p class="text-[11px] font-bold uppercase text-slate-400">${escapeHtml(categoryLabel(eventInfo.category || 'General'))} • ${escapeHtml(eventInfo.stage || 'Off-Stage')} • ${escapeHtml(genderLabel(eventInfo))}${cancelled&&eventInfo.cancelReason?` • Reason: ${escapeHtml(eventInfo.cancelReason)}`:''}</p></div><div class="flex flex-wrap items-center gap-2"><span class="rounded-full bg-indigo-50 px-3 py-1 text-[11px] font-black text-indigo-700">${registeredTeams.length}/${sortedTeams.length} teams</span><span class="rounded-full ${state==='none'?'bg-red-100 text-red-700':state==='complete'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'} px-3 py-1 text-[11px] font-black">${stateLabel}</span><i data-lucide="${expanded?'chevron-up':'chevron-down'}" class="h-5 w-5 text-slate-400"></i></div></button><div class="${expanded?'':'hidden'} border-t border-slate-100 p-4"><div class="mb-4 flex flex-wrap justify-end gap-2">${cancelButton}</div><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">${(evId && evId !== 'all' ? sortedTeams : registeredTeams).map(teamName => renderTeamCard(teamName, eventInfo, evId && evId !== 'all')).join('') || '<p class="col-span-full py-8 text-center text-sm font-bold text-slate-400">No team has registered for this program.</p>'}</div></div></section>`;
    }).join('') : '<div class="py-12 text-center text-sm font-bold text-slate-400">No events found for the selected filters.</div>';
    window.lucide?.createIcons?.();
};


const finalEntryDownloadValue=id=>document.getElementById(id)?.value||'';
const finalEntryExportEvents=(category='')=>finalEntryFilteredEvents({cat:category||finalEntryDownloadValue('final-entry-download-category'),stage:finalEntryDownloadValue('final-entry-download-stage'),gender:finalEntryDownloadValue('final-entry-download-gender'),participation:'all'}).filter(event=>event.cancelled!==true&&uniqueRegistrationRows().some(reg=>reg.eventId===event.id));
const finalEntryParticipantInfo=(registration,id)=>{const meta=registration.participantMeta?.[id]||{},application=registrationApplications.find(item=>(item.studentId===id||item.participantId===id)&&item.eventId===registration.eventId),person=students.find(item=>item.id===id)||participants.find(item=>item.id===id)||{};return{name:person.name||meta.name||application?.studentName||application?.participantName||'Participant',chestNo:person.chestNo||meta.chestNo||application?.chestNo||''};};
const finalEntryRowsForEvent=event=>[...teams].sort().map(team=>{const rows=uniqueRegistrationRows().filter(reg=>reg.eventId===event.id&&reg.team===team).sort((a,b)=>Number(a.slotIndex||0)-Number(b.slotIndex||0)).flatMap(reg=>[...(reg.studentIds||[]),...(reg.participantIds||[])].map(id=>finalEntryParticipantInfo(reg,id))).filter(row=>row.name);return{team,rows};}).filter(group=>group.rows.length);
const finalEntrySafe=value=>escapeHtml(String(value??''));
const finalEntryPrintHtml=()=>{const selectedCategory=finalEntryDownloadValue('final-entry-download-category'),stage=finalEntryDownloadValue('final-entry-download-stage'),gender=finalEntryDownloadValue('final-entry-download-gender'),categoryList=selectedCategory?[selectedCategory]:[...new Set(finalEntryExportEvents('').map(event=>event.category||'General'))].sort(),logo=homeConfig.logoUrl?`<img class="final-entry-logo" src="${finalEntrySafe(homeConfig.logoUrl)}" alt="Fest logo">`:'';const styles=`<style>.final-entry-book{background:#fff;color:#000;font-family:Arial,'Noto Sans Malayalam','Noto Sans',sans-serif}.final-entry-sheet{box-sizing:border-box;width:794px;min-height:1123px;margin:0 auto 18px;background:#fff;padding:20px;break-after:page;page-break-after:always}.final-entry-sheet:last-child{break-after:auto;page-break-after:auto}.final-entry-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px}.final-entry-title{font-size:20px;font-weight:700;line-height:1.1}.final-entry-sub{font-size:10px;font-weight:400;text-transform:uppercase}.final-entry-logo{max-width:112px;max-height:58px;object-fit:contain}.final-entry-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}.final-entry-event{break-inside:avoid;page-break-inside:avoid}.final-entry-event-title{font-size:12px;font-weight:700;line-height:1.15;margin:0 0 1px}.final-entry-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9px;line-height:1.08;font-weight:400}.final-entry-table th,.final-entry-table td{border:1px solid #111;padding:2px 3px;color:#000;vertical-align:middle;font-weight:400}.final-entry-table th{font-size:8px;font-weight:700;text-align:center}.final-entry-team-col,.final-entry-team{width:18px}.final-entry-no-col,.final-entry-no{width:20px}.final-entry-chest-col,.final-entry-chest{width:42px}.final-entry-remark-col,.final-entry-remark{width:42px}.final-entry-team{position:relative;padding:0;text-align:center;overflow:hidden}.final-entry-team span{position:absolute;left:50%;top:50%;display:block;white-space:nowrap;transform:translate(-50%,-50%) rotate(-90deg);transform-origin:center center;font-size:8px;font-weight:400;line-height:1}.final-entry-no,.final-entry-chest{text-align:center}.final-entry-name{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.final-entry-empty{grid-column:1/-1;padding:24px;text-align:center;font-weight:400}</style>`;const pages=categoryList.map(category=>{const eventsList=finalEntryExportEvents(category);return `<section class="final-entry-sheet"><div class="final-entry-head"><div><div class="final-entry-title">${finalEntrySafe(categoryLabel(category))}</div>${[stage,gender].filter(Boolean).length?`<div class="final-entry-sub">${finalEntrySafe([stage,gender].filter(Boolean).join(' • '))}</div>`:''}</div>${logo}</div><div class="final-entry-grid">${eventsList.map(event=>{const groups=finalEntryRowsForEvent(event);return `<section class="final-entry-event"><h4 class="final-entry-event-title">ITEM : ${finalEntrySafe(event.name||'Program')}</h4><table class="final-entry-table"><colgroup><col class="final-entry-team-col"><col class="final-entry-no-col"><col class="final-entry-chest-col"><col><col class="final-entry-remark-col"></colgroup><thead><tr><th></th><th>NO</th><th>CH.NO</th><th>NAME OF PARTICIPANTS</th><th></th></tr></thead><tbody>${groups.map(group=>group.rows.map((row,index)=>`<tr>${index===0?`<td class="final-entry-team" rowspan="${group.rows.length}"><span>${finalEntrySafe(teamLabel(group.team))}</span></td>`:''}<td class="final-entry-no">${index+1}</td><td class="final-entry-chest">${finalEntrySafe(row.chestNo)}</td><td class="final-entry-name">${finalEntrySafe(row.name)}</td><td class="final-entry-remark"></td></tr>`).join('')).join('')}</tbody></table></section>`}).join('')||'<div class="final-entry-empty">No final entries for selected filters.</div>'}</div></section>`}).join('');return `${styles}<div class="final-entry-book">${pages||'<section class="final-entry-sheet"><div class="final-entry-empty">No final entries for selected filters.</div></section>'}</div>`;};
const populateFinalEntryDownloadFilters=()=>{const setOptions=(id,values,label,display=value=>value)=>{const el=document.getElementById(id);if(!el)return;const old=el.value;el.innerHTML=`<option value="">All ${label}</option>`+values.map(value=>`<option value="${finalEntrySafe(value)}">${finalEntrySafe(display(value))}</option>`).join('');if(values.includes(old))el.value=old};setOptions('final-entry-download-category',[...new Set(events.map(event=>event.category).filter(Boolean))].sort(),'Categories',category=>categoryLabel(category));setOptions('final-entry-download-gender',[...new Set(events.map(event=>genderLabel(event)).filter(Boolean))].sort(),'Genders')};
window.renderFinalEntriesDownloadPreview=()=>{const host=document.getElementById('final-entries-download-preview'),summary=document.getElementById('final-entries-download-summary');if(!host)return;host.innerHTML=finalEntryPrintHtml();const count=finalEntryExportEvents().length;if(summary)summary.textContent=`${count} active programme table(s) match the selected filters. Cancelled events are hidden.`;};
window.openFinalEntriesDownload=()=>{populateFinalEntryDownloadFilters();const modal=document.getElementById('final-entries-download-modal');modal?.classList.remove('hidden');modal?.classList.add('flex');window.renderFinalEntriesDownloadPreview();};
window.closeFinalEntriesDownload=()=>{const modal=document.getElementById('final-entries-download-modal');modal?.classList.add('hidden');modal?.classList.remove('flex');};
window.downloadFinalEntriesPdf=async()=>{const html=finalEntryPrintHtml();if(!window.html2pdf)return window.showToast('Malayalam PDF renderer is not loaded','error');const host=document.createElement('div');host.style.cssText='position:fixed;left:-10000px;top:0;background:#fff;z-index:-1';host.innerHTML=html;document.body.appendChild(host);const page=host.querySelector('.final-entry-book');const blob=await window.html2pdf().from(page).set({margin:0,image:{type:'jpeg',quality:.98},html2canvas:{scale:2,backgroundColor:'#ffffff',useCORS:true},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}}).outputPdf('blob');host.remove();const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Final_Entries.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.downloadFinalEntriesExcel=()=>{const html=`<html><head><meta charset="utf-8"></head><body>${finalEntryPrintHtml()}</body></html>`,blob=new Blob([html],{type:'application/vnd.ms-excel;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Final_Entries.xls';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};


window.cleanupDuplicateFinalEntries = async () => {
    const seen = new Set(), updates = [], deletes = [];
    registrations.forEach(registration => {
        const nextStudentIds = [], nextParticipantIds = [];
        (registration.studentIds || []).forEach(id => { const key = registrationPersonEventKey(registration.eventId, id); if(!seen.has(key)) { seen.add(key); nextStudentIds.push(id); } });
        (registration.participantIds || []).forEach(id => { const key = registrationPersonEventKey(registration.eventId, id); if(!seen.has(key)) { seen.add(key); nextParticipantIds.push(id); } });
        if(!nextStudentIds.length && !nextParticipantIds.length) deletes.push(registration);
        else if(nextStudentIds.length !== (registration.studentIds || []).length || nextParticipantIds.length !== (registration.participantIds || []).length) updates.push({ registration, nextStudentIds, nextParticipantIds });
    });
    if(!updates.length && !deletes.length) return window.showToast('No duplicate final entries found');
    if(!await window.confirmAction(`Remove ${updates.length + deletes.length} duplicate final entr${updates.length + deletes.length === 1 ? 'y' : 'ies'} from the database?`)) return;
    const batch = writeBatch(db), now = Date.now();
    updates.forEach(({ registration, nextStudentIds, nextParticipantIds }) => batch.update(doc(db, 'registrations', registration.id), { studentIds: nextStudentIds, participantIds: nextParticipantIds, lastUpdatedAt: now, duplicateCleanedAt: now, duplicateCleanedByUid: auth.currentUser?.uid || '' }));
    deletes.forEach(registration => batch.delete(doc(db, 'registrations', registration.id)));
    await batch.commit();
    window.showToast(`Duplicate cleanup complete: ${updates.length + deletes.length} record(s) fixed`);
};

window.toggleFinalEntryEvent = id => { expandedRegistrationEventId = expandedRegistrationEventId === id ? '' : id; window.renderRegList(true); };
window.cancelRegistrationEvent = async id => {
    const eventInfo = events.find(event => event.id === id);
    if(!eventInfo) return window.showToast('Event not found', 'error');
    const reason = await window.promptAction(`Reason for cancelling ${eventInfo.name || 'this event'}:`, eventInfo.cancelReason || 'No team participated');
    if(!reason) return;
    try {
        await updateDoc(doc(db, 'events', id), { cancelled: true, cancelReason: String(reason).trim(), cancelledAt: Date.now(), cancelledByUid: auth.currentUser?.uid || '', updatedAt: Date.now() });
        window.showToast('Event marked as cancelled');
    } catch(error) {
        console.error('Unable to cancel event', error);
        window.showToast(error?.code === 'permission-denied' ? 'Event cancel was blocked. Update Firestore rules from this PR, then try again.' : 'Event cancel was not saved. Please try again.', 'error');
    }
};
window.undoRegistrationEventCancel = async id => {
    if(!await window.confirmAction('Remove cancellation from this event?')) return;
    try {
        await updateDoc(doc(db, 'events', id), { cancelled: false, cancelReason: deleteField(), cancelledAt: deleteField(), cancelledByUid: deleteField(), updatedAt: Date.now() });
        window.showToast('Event cancellation removed');
    } catch(error) {
        console.error('Unable to remove event cancellation', error);
        window.showToast(error?.code === 'permission-denied' ? 'Event cancel undo was blocked. Update Firestore rules from this PR, then try again.' : 'Event cancel undo was not saved. Please try again.', 'error');
    }
};

window.rejectTeam = async (regId, team, eventName, eventId) => {
    const reason = await window.promptAction("Reason for rejecting entire team?", "Disqualified / Incomplete");
    if(!reason) return;
    await deleteDoc(doc(db, "registrations", regId));
    await addDoc(collection(db, "notifications"), { team: team, title: `Entry Rejected: ${eventName}`, message: `Your entire team entry was removed. Reason: ${reason}`, eventId: eventId, timestamp: Date.now(), type: 'error', read: false });
    window.showToast("Team Entry Rejected");
};

window.rejectStudent = async (regId, studentId, team, eventName, studentName, eventId) => {
    const reason = await window.promptAction(`Reason for removing ${studentName}?`, "Disqualified / Not Eligible");
    if(!reason) return;
    const reg = registrations.find(r => r.id === regId); if(!reg) return;
    const newIds = reg.studentIds.filter(id => id !== studentId);
    const participantMeta = { ...(reg.participantMeta || {}) }; delete participantMeta[studentId];
    if(newIds.length === 0) { await deleteDoc(doc(db, "registrations", regId)); } else { await updateDoc(doc(db, "registrations", regId), { studentIds: newIds, participantMeta, lastUpdatedByName: 'Admin', lastUpdatedAt: Date.now() }); }
    await addDoc(collection(db, "notifications"), { team: team, title: `Participant Removed: ${eventName}`, message: `${studentName} was removed from this event. Reason: ${reason}`, eventId: eventId, timestamp: Date.now(), type: 'warning', read: false });
    window.showToast("Student Removed");
};

// --- STUDENTS TABLE ---
const studentAvatar = (student,size='h-10 w-10') => student.photoData ? `<img src="${escapeHtml(student.photoData)}" alt="" class="${size} shrink-0 rounded-full border border-slate-200 object-cover">` : `<span class="${size} grid shrink-0 place-items-center rounded-full bg-indigo-100 text-xs font-black text-indigo-700">${escapeHtml((student.name||'?').trim().charAt(0).toUpperCase())}</span>`;
const studentDisplayName = student => `${student.name || 'Student'}${student.details?.class || student.class ? ` (${student.details?.class || student.class})` : ''}`;
window.renderStudentTable = (force = false) => {
    const teamFilter = document.getElementById('filter-std-team').value;
    const catFilter = document.getElementById('filter-std-cat').value;
    const genderFilter = document.getElementById('filter-std-gender').value;
    const searchQuery = document.getElementById('inp-search-std').value.toLowerCase();
    const currentHash = generateHash(students) + teamFilter + catFilter + genderFilter + searchQuery;
    if(!force && lastRenderHash.students === currentHash) return;
    lastRenderHash.students = currentHash;

    const desktopBody = document.getElementById('table-students-desktop');
    const mobileList = document.getElementById('list-students-mobile');

    let filteredStudents = students;
    if (teamFilter) filteredStudents = filteredStudents.filter(s => s.team === teamFilter);
    if (catFilter) { if(catFilter !== 'General') filteredStudents = filteredStudents.filter(s => s.category === catFilter); }
    if (genderFilter) filteredStudents = filteredStudents.filter(s => studentGender(s) === genderFilter);
    if (searchQuery) filteredStudents = filteredStudents.filter(s => `${s.name} ${s.chestNo||''} ${Object.values(s.details||{}).join(' ')}`.toLowerCase().includes(searchQuery));
    const sorted = [...filteredStudents].sort((a,b) => String(a.chestNo ?? '').localeCompare(String(b.chestNo ?? ''), undefined, {numeric:true, sensitivity:'case'}));
    document.getElementById('count-students').innerText = sorted.length;

    if(sorted.length===0) { const emptyMsg = `<div class="p-8 text-center text-slate-400 italic">No students found</div>`; desktopBody.innerHTML = `<tr><td colspan="6">${emptyMsg}</td></tr>`; mobileList.innerHTML = emptyMsg; return; }

    desktopBody.innerHTML = sorted.map(s => `
        <tr class="hover:bg-slate-50 border-b border-slate-100 last:border-0 group animate-enter">
            <td class="px-6 py-4 font-mono text-indigo-600 font-bold">${escapeHtml(s.chestNo || '-')}</td><td class="px-6 py-4 font-medium text-slate-800"><div class="flex items-center gap-3">${studentAvatar(s)}<span>${escapeHtml(studentDisplayName(s))}</span></div></td><td class="px-6 py-4"><span class="bg-white border border-slate-200 px-2.5 py-1 rounded-md text-xs font-bold text-slate-600 shadow-sm">${escapeHtml(s.team)}</span></td><td class="px-6 py-4 text-xs uppercase font-bold text-slate-500">${escapeHtml(s.category)}</td><td class="px-6 py-4 text-xs uppercase font-bold text-slate-500">${escapeHtml(studentGender(s))}</td>
            <td class="px-6 py-4 text-right"><div class="flex justify-end gap-1 opacity-100 transition-opacity"><button data-admin-action="edit-student" data-id="${escapeHtml(s.id)}" class="text-indigo-600 hover:bg-indigo-50 p-2 rounded-lg transition"><i data-lucide="edit-3" class="w-4 h-4"></i></button><button data-admin-action="delete-student" data-id="${escapeHtml(s.id)}" class="text-red-400 hover:bg-red-50 p-2 rounded-lg transition"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></td>
        </tr>`).join('');

    mobileList.innerHTML = sorted.map(s => `
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex justify-between items-center animate-enter">
            <div class="flex min-w-0 items-center gap-3">${studentAvatar(s)}<div><div class="flex items-center gap-2 mb-1"><span class="font-mono text-indigo-600 font-bold text-xs bg-indigo-50 px-2 py-0.5 rounded">${escapeHtml(s.chestNo || '-')}</span><span class="font-bold text-slate-800 text-sm">${escapeHtml(studentDisplayName(s))}</span></div><div class="text-[10px] text-slate-500 font-bold uppercase tracking-wide flex gap-2"><span>${escapeHtml(s.team)}</span><span class="text-slate-300">•</span><span>${escapeHtml(s.category)}</span><span class="text-slate-300">•</span><span>${escapeHtml(studentGender(s))}</span></div></div></div>
            <div class="flex gap-2"><button data-admin-action="edit-student" data-id="${escapeHtml(s.id)}" class="p-2 bg-slate-50 border border-slate-100 rounded-lg text-indigo-600 active:bg-indigo-50"><i data-lucide="edit-3" class="w-4 h-4"></i></button><button data-admin-action="delete-student" data-id="${escapeHtml(s.id)}" class="p-2 bg-red-50 border border-red-100 rounded-lg text-red-500 active:bg-red-100"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div>
        </div>`).join('');
    window.lucide?.createIcons?.();
};

// --- EVENTS TABLE ---
window.renderEventTable = (force = false) => {
    window.renderEventOptionalFilters?.();
    const search = (document.getElementById('inp-search-ev')?.value || '').trim().toLowerCase();
    const catFilter = document.getElementById('filter-ev-cat')?.value || '';
    const genderFilter = document.getElementById('filter-ev-gender')?.value || '';
    const stageFilter = document.getElementById('filter-ev-stage')?.value || '';
    const typeFilter = document.getElementById('filter-ev-type')?.value || '';
    const optionalFilterHash = EVENT_OPTIONAL_FILTERS.map(filter => `${filter.key}:${eventOptionalFilterValue(filter.key)}`).join('|');
    const currentHash = generateHash(events) + [search, catFilter, genderFilter, stageFilter, typeFilter, optionalFilterHash].join('|');
    if(!force && lastRenderHash.events === currentHash) return;
    lastRenderHash.events = currentHash;

    const desktopBody = document.getElementById('table-events-desktop');
    const mobileList = document.getElementById('list-events-mobile');

    let filteredEvents = events;
    if(search) filteredEvents = filteredEvents.filter(e => [e.name, e.rules||e.notes||e.description, e.category, e.stage, e.type, genderLabel(e.gender)].some(v => String(v || '').toLowerCase().includes(search)));
    if(catFilter) filteredEvents = filteredEvents.filter(e => e.category === catFilter);
    if(genderFilter) filteredEvents = filteredEvents.filter(e => (e.gender || 'Both') === genderFilter);
    if(stageFilter) filteredEvents = filteredEvents.filter(e => e.stage === stageFilter);
    if(typeFilter) filteredEvents = filteredEvents.filter(e => e.type === typeFilter);
    EVENT_OPTIONAL_FILTERS.forEach(filter => {
        const value = eventOptionalFilterValue(filter.key);
        if(value === 'has') filteredEvents = filteredEvents.filter(event => filter.has(event));
        if(value === 'missing') filteredEvents = filteredEvents.filter(event => !filter.has(event));
    });

    if(filteredEvents.length===0) { const emptyMsg = `<div class="p-8 text-center text-slate-400 italic">No events found</div>`; desktopBody.innerHTML = `<tr><td colspan="7">${emptyMsg}</td></tr>`; mobileList.innerHTML = emptyMsg; return; }

    const eventMetaHtml = (e) => {
        const meta = [(e.rules||e.notes||e.description) && escapeHtml(e.rules||e.notes||e.description)].filter(Boolean).join(' • ');
        return meta ? `<div class="mt-1 text-xs text-slate-400 font-medium whitespace-normal max-w-md">${meta}</div>` : '';
    };
    const configHtml = (e) => e.type === 'Group' ? `Groups/team: ${escapeHtml(e.limit || 1)}<div class="mt-1 text-[11px] font-bold text-purple-500">Members/group: ${escapeHtml(e.groupSize || '-')}</div>` : `Participants/team: ${escapeHtml(e.limit || 1)}`;

    desktopBody.innerHTML = filteredEvents.map(e => `
        <tr class="hover:bg-slate-50 border-b border-slate-100 animate-enter">
            <td class="px-6 py-4 font-bold text-slate-700"><div>${escapeHtml(e.name)} <span class="ml-2 rounded bg-violet-50 px-2 py-0.5 text-[9px] uppercase text-violet-700">${escapeHtml(e.status||'validated')}</span></div>${eventMetaHtml(e)}</td><td class="px-6 py-4 text-xs font-bold uppercase text-slate-500">${escapeHtml(e.stage || 'Off-Stage')}</td><td class="px-6 py-4 text-xs font-bold ${e.type==='Group'?'text-purple-600':'text-blue-600'}">${escapeHtml(e.type)}</td><td class="px-6 py-4 text-sm"><span class="${e.category==='General'?'bg-orange-100 text-orange-700':'bg-slate-100 text-slate-600'} px-2 py-1 rounded text-xs font-bold">${escapeHtml(e.category)}</span></td><td class="px-6 py-4 text-xs font-bold uppercase text-slate-500">${escapeHtml(genderLabel(e.gender))}</td><td class="px-6 py-4 text-xs text-slate-500">${configHtml(e)}</td>
            <td class="px-6 py-4 text-right"><div class="flex justify-end gap-1"><button data-admin-action="edit-event" data-id="${escapeHtml(e.id)}" class="text-indigo-600 hover:bg-indigo-50 p-2 rounded-lg transition" title="Edit event"><i data-lucide="edit-3" class="w-4 h-4"></i></button><button data-admin-action="delete-event" data-id="${escapeHtml(e.id)}" class="text-red-400 hover:bg-red-50 p-2 rounded-lg transition" title="Delete event"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div></td>
        </tr>`).join('');

    mobileList.innerHTML = filteredEvents.map(e => {
        const stageColor = e.stage === 'On-Stage' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700';
        return `<div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm relative group animate-enter"><div class="flex justify-between items-start mb-2"><h4 class="font-bold text-slate-800 pr-2">${escapeHtml(e.name)}</h4><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded ${stageColor} whitespace-nowrap">${escapeHtml(e.stage || 'Off-Stage')}</span></div>${eventMetaHtml(e)}<div class="flex flex-wrap gap-2 text-[10px] font-bold text-slate-500 mb-3 mt-3"><span class="bg-slate-100 px-2 py-1 rounded border border-slate-200 uppercase">${escapeHtml(e.category)}</span><span class="bg-slate-100 px-2 py-1 rounded border border-slate-200 uppercase ${e.type==='Group'?'text-purple-600':'text-blue-600'}">${escapeHtml(e.type)}</span><span class="bg-blue-50 px-2 py-1 rounded border border-blue-100 text-blue-700 uppercase">${escapeHtml(genderLabel(e.gender))}</span><span class="bg-slate-100 px-2 py-1 rounded border border-slate-200">${e.type==='Group' ? `Groups/team: ${escapeHtml(e.limit || 1)}` : `Participants/team: ${escapeHtml(e.limit || 1)}`}</span>${e.type==='Group' ? `<span class="bg-purple-50 px-2 py-1 rounded border border-purple-100 text-purple-700">Members/group: ${escapeHtml(e.groupSize || '-')}</span>` : ''}</div><div class="flex justify-end gap-2 border-t border-slate-100 pt-2 mt-2"><button data-admin-action="edit-event" data-id="${escapeHtml(e.id)}" class="px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-bold flex items-center gap-1 active:bg-indigo-100"><i data-lucide="edit-3" class="w-3 h-3"></i> Edit</button><button data-admin-action="delete-event" data-id="${escapeHtml(e.id)}" class="px-3 py-1.5 bg-red-50 text-red-500 rounded-lg text-xs font-bold flex items-center gap-1 active:bg-red-100"><i data-lucide="trash-2" class="w-3 h-3"></i> Delete</button></div></div>`;
    }).join('');
    window.lucide?.createIcons?.();
};

// --- CHEST NO & MASTER SETUP ---
const teamSetupActionButton=(label,action,team,classes,extra='')=>`<button data-admin-action="${action}" data-team="${escapeHtml(team)}" ${extra} class="min-h-10 rounded-xl px-3 py-2 text-xs font-black transition active:scale-95 ${classes}">${label}</button>`;
const renderTeamMediaPanel=(team,teamIndex,type)=>{const isHeader=type==='header',stored=isHeader?teamIdCardHeaders[team]||'':teamLogos[team]||'',fieldId=`team-${isHeader?'id-header':'logo'}-edit-${teamIndex}`,previewId=`team-${isHeader?'id-header':'logo'}-preview-${teamIndex}`,errorId=`team-${isHeader?'id-header':'logo'}-error-${teamIndex}`,action=isHeader?'save-team-id-header':'save-team-logo',title=isHeader?'ID card header image':'Team image',tone=isHeader?'emerald':'indigo',panelClass=isHeader?'border-emerald-100 bg-emerald-50/40':'border-indigo-100 bg-indigo-50/40',titleClass=isHeader?'text-emerald-800':'text-indigo-800',inputClass=isHeader?'border-emerald-100':'border-indigo-100',saveClass=isHeader?'bg-emerald-600 text-white hover:bg-emerald-700':'bg-indigo-600 text-white hover:bg-indigo-700',preview=stored?`<img src="${escapeHtml(stored)}" class="${isHeader?'h-16 w-full rounded-2xl bg-black object-cover':'h-20 w-20 rounded-2xl bg-white object-cover'} border" alt="">`:'';
return `<section class="rounded-2xl border ${panelClass} p-4"><div class="flex items-start justify-between gap-3"><div><h5 class="text-xs font-black uppercase tracking-wide ${titleClass}">${title}</h5><p class="mt-1 text-[10px] font-bold text-slate-500">${isHeader?'Long image crops into the top black band. When present, the fest logo is hidden on ID cards.':'Shown in team lists and used as ID fallback when no header image exists.'}</p></div>${stored?'<span class="rounded-full bg-white px-2 py-1 text-[9px] font-black text-emerald-700">Saved</span>':''}</div><input id="${fieldId}" type="hidden" value="${escapeHtml(stored)}"><input data-image-file data-image-value="${fieldId}" data-image-preview="${previewId}" data-image-error="${errorId}" type="file" accept="image/jpeg,image/png,image/webp,image/gif" class="mt-3 w-full rounded-xl border ${inputClass} bg-white p-2 text-xs"><p id="${errorId}" class="mt-1 text-xs font-bold text-red-600"></p><div id="${previewId}" class="mt-3 flex flex-wrap gap-2">${preview}</div><div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">${teamSetupActionButton(isHeader?'Save ID Header':'Save Image',action,team,saveClass)}${stored?teamSetupActionButton('Remove',action,team,'border border-red-100 bg-white text-red-600 hover:bg-red-50',`onclick="document.getElementById('${fieldId}').value=''"`):''}</div></section>`};
const renderTeamChestRows=(team)=>categories.map(category=>{const boysKey=chestKey(team,category,'Boys'),girlsKey=chestKey(team,category,'Girls'),legacyVal=chestConfig[legacyChestKey(team,category)]||'',boysVal=chestConfig[boysKey]||legacyVal,girlsVal=chestConfig[girlsKey]||'';return `<div class="rounded-xl border border-slate-100 bg-slate-50 p-3"><div class="mb-2 flex items-center justify-between gap-2"><span class="truncate text-xs font-black uppercase tracking-wide text-slate-600">${escapeHtml(categoryLabel(category))}</span><span class="flex shrink-0 gap-1"><button data-admin-action="save-category-display-name" data-category="${escapeHtml(category)}" class="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-indigo-600" title="Save display name"><i data-lucide="save" class="h-3.5 w-3.5"></i></button><button data-admin-action="remove-item" data-type="categories" data-value="${escapeHtml(category)}" class="rounded-lg p-1 text-slate-300 hover:bg-white hover:text-red-500" title="Delete"><i data-lucide="trash-2" class="h-3.5 w-3.5"></i></button></span></div><div class="grid grid-cols-2 gap-2"><label class="text-[10px] font-black uppercase text-blue-600">Boys<input type="number" data-key="${boysKey}" value="${boysVal}" class="chest-start-input mt-1 w-full rounded-xl border border-slate-200 bg-slate-100 px-2 py-2 text-center text-sm font-black outline-none transition focus:ring-2 focus:ring-teal-500" placeholder="#" readonly></label><label class="text-[10px] font-black uppercase text-pink-600">Girls<input type="number" data-key="${girlsKey}" value="${girlsVal}" class="chest-start-input mt-1 w-full rounded-xl border border-slate-200 bg-slate-100 px-2 py-2 text-center text-sm font-black outline-none transition focus:ring-2 focus:ring-teal-500" placeholder="#" readonly></label></div></div>`}).join('');
window.renderChestGrid = () => {
    const container = document.getElementById('chest-config-container');
    if(!container) return;
    if(teams.length === 0 || categories.length === 0) { container.innerHTML = `<div class="col-span-full rounded-2xl border border-dashed border-slate-300 bg-slate-50 py-12 text-center italic text-slate-400">Add Teams and Categories first.</div>`; return; }
    container.className='p-5 grid grid-cols-1 xl:grid-cols-2 gap-6';
    container.innerHTML=teams.map((team,teamIndex)=>{const color=teamColors[team]||'#4f46e5',logo=teamLogos[team]||'',header=teamIdCardHeaders[team]||'';return `<article class="animate-enter overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm transition hover:shadow-lg"><header class="flex flex-col gap-4 border-b border-slate-100 bg-gradient-to-br from-slate-50 to-white p-5 sm:flex-row sm:items-center sm:justify-between"><div class="flex min-w-0 items-center gap-3"><div class="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border-2 bg-white shadow-sm" style="border-color:${color}">${logo?`<img src="${escapeHtml(logo)}" class="h-full w-full object-cover" alt="${escapeHtml(teamLabel(team))} logo">`:`<span class="text-xl font-black" style="color:${color}">${escapeHtml(teamLabel(team).charAt(0)||team.charAt(0))}</span>`}</div><div class="min-w-0"><h4 class="truncate text-xl font-black text-slate-800">${escapeHtml(teamLabel(team))}</h4><p class="font-mono text-[10px] font-black uppercase text-slate-400">${escapeHtml(team)} • locked code</p><label class="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase text-slate-400">Team colour <input type="color" value="${color}" data-admin-change="save-team-color" data-team="${escapeHtml(team)}" class="h-8 w-14 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5"><span class="font-mono" style="color:${color}">${color}</span></label></div></div><div class="grid grid-cols-3 gap-2 sm:flex"><button data-admin-action="open-team-id-cards" data-team="${escapeHtml(team)}" class="rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs font-black text-emerald-700 hover:bg-emerald-50">Preview ID</button><button data-admin-action="save-team-display-name" data-team="${escapeHtml(team)}" class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 hover:text-indigo-600">Save Name</button><button data-admin-action="remove-item" data-type="teams" data-value="${escapeHtml(team)}" class="rounded-xl border border-red-100 bg-white px-3 py-2 text-xs font-black text-red-600 hover:bg-red-50">Delete</button></div></header><div class="grid gap-4 p-5 lg:grid-cols-2"><section class="rounded-2xl border border-blue-100 bg-blue-50 p-4 lg:col-span-2"><label class="input-label">Display name for ${escapeHtml(team)}</label><input data-team-display-name="${escapeHtml(team)}" class="text-input" value="${escapeHtml(teamLabel(team))}" dir="auto"><p class="mt-1 text-[10px] font-bold text-blue-700">Internal code is locked; only this display name changes.</p></section>${renderTeamMediaPanel(team,teamIndex,'logo')}${renderTeamMediaPanel(team,teamIndex,'header')}<section class="rounded-2xl border border-slate-200 bg-white p-4 lg:col-span-2"><div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><h5 class="text-xs font-black uppercase tracking-wide text-slate-700">Chest number setup</h5><p class="text-[10px] font-bold text-slate-500">Read-only until Enable Edit is pressed. Saved with Save All.</p></div><div class="flex flex-wrap gap-2"><span class="rounded-full px-3 py-1 text-[9px] font-black uppercase" style="background:${color}22;color:${color}">${header?'Custom ID header':'Logo fallback'}</span><button data-admin-action="open-team-id-cards" data-team="${escapeHtml(team)}" class="rounded-full bg-slate-900 px-3 py-1 text-[9px] font-black uppercase text-white">Download ID Cards</button></div></div><div class="grid gap-3 sm:grid-cols-2">${renderTeamChestRows(team)}</div></section></div></article>`}).join('');
    initImageUploads(container);
    window.lucide?.createIcons?.();
};

window.exportToCSV = () => {
    const teamFilter = document.getElementById('filter-std-team').value;
    const catFilter = document.getElementById('filter-std-cat').value;
    const genderFilter = document.getElementById('filter-std-gender').value;
    const searchQuery = document.getElementById('inp-search-std').value.toLowerCase();
    let filteredStudents = students;
    if (teamFilter) filteredStudents = filteredStudents.filter(s => s.team === teamFilter);
    if (catFilter) { if(catFilter !== 'General') filteredStudents = filteredStudents.filter(s => s.category === catFilter); }
    if (genderFilter) filteredStudents = filteredStudents.filter(s => studentGender(s) === genderFilter);
    if (searchQuery) filteredStudents = filteredStudents.filter(s => s.name.toLowerCase().includes(searchQuery) || (s.chestNo && s.chestNo.toString().includes(searchQuery)));

    if(!filteredStudents.length) return window.showToast('No students to export', 'error');
    const sorted = [...filteredStudents].sort((a,b) => String(a.chestNo ?? '').localeCompare(String(b.chestNo ?? ''), undefined, {numeric:true, sensitivity:'case'}));
    const data = sorted.map(s => ({ "Chest No": s.chestNo || '', "Name": s.name, "Team": s.team, "Category": s.category, "Gender": studentGender(s), ...Object.fromEntries(enabledStudentFields().filter(field=>field.key!=='name').map(field=>[field.label,s.details?.[field.key]||s[field.key]||''])), "Has Photo": s.photoData ? 'Yes' : 'No' }));
    const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Filtered_Students");
    XLSX.writeFile(wb, "Student_List.xlsx");
    window.showToast('Downloading Filtered List...');
};

// --- ADMIN HELPERS ---
// --- HELPER FUNCTIONS ---
window.generateChestNo = (team, category, gender) => { const key = chestKey(team, category, gender); const legacyKey = legacyChestKey(team, category); const start = chestConfig[key] || (gender === 'Boys' ? chestConfig[legacyKey] : null); if (!start) return null; const startNum = parseInt(start); const existing = students.filter(s => s.team === team && s.category === category && studentGender(s) === gender); let max = startNum - 1; existing.forEach(s => { if(s.chestNo > max) max = s.chestNo; }); return max + 1; };
window.previewChestNo = () => { const t = document.getElementById('inp-std-team').value; const c = document.getElementById('inp-std-cat').value; const g = document.getElementById('inp-std-gender').value; const h = document.getElementById('chest-hint'); if (t && c && g) { const val = window.generateChestNo(t, c, g); if (val) { h.innerText = `Next ${g} Chest No: ${val}`; h.className = "text-right text-xs font-bold mt-2 h-4 text-indigo-600"; } else { h.innerText = "Chest No not set in Settings!"; h.className = "text-right text-xs font-bold mt-2 h-4 text-red-500"; } } else h.innerText = ""; };

const renameDeepValue = (value, oldVal, newVal) => {
    if(Array.isArray(value)) return value.map(item => renameDeepValue(item, oldVal, newVal));
    if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key === oldVal ? newVal : key, renameDeepValue(entry, oldVal, newVal)]));
    return value === oldVal ? newVal : value;
};
const addBatchSet = (ops, ref, data, options = { merge: true }) => ops.push({ type: 'set', ref, data, options });
const addBatchUpdate = (ops, ref, data) => ops.push({ type: 'update', ref, data });
const addBatchDelete = (ops, ref) => ops.push({ type: 'delete', ref });
const renamedDataPatch = (data, oldVal, newVal, extra = {}) => ({ ...renameDeepValue(data || {}, oldVal, newVal), ...extra });
const addDeepRenameDoc = (ops, item, oldVal, newVal, count, collectionLabel, extra = {}) => {
    const current = item.data();
    const next = renamedDataPatch(current, oldVal, newVal, extra);
    if(JSON.stringify(next) !== JSON.stringify(current)) { addBatchSet(ops, item.ref, next, { merge: false }); count(collectionLabel, 1); }
};
const updateAccessUsernameMirrors = (ops, profile, patch) => {
    if(profile.username) addBatchSet(ops, doc(db, 'accessUsernames', profile.username), patch, { merge: true });
    if(profile.email) addBatchSet(ops, doc(db, 'accessUsernames', normalizeAccessEmailKey(profile.email)), patch, { merge: true });
};
async function commitBatchedOperations(ops, size = 420) {
    for(let i = 0; i < ops.length; i += size) {
        const batch = writeBatch(db);
        ops.slice(i, i + size).forEach(op => {
            if(op.type === 'set') batch.set(op.ref, op.data, op.options || { merge: true });
            if(op.type === 'update') batch.update(op.ref, op.data);
            if(op.type === 'delete') batch.delete(op.ref);
        });
        await batch.commit();
    }
}
const countCollectionWhere = async (collectionName, field, value) => (await getDocs(query(collection(db, collectionName), where(field, '==', value)))).size;
const renameImpactPreview = async (type, oldVal) => {
    if(type === 'teams') {
        const direct = [
            ['Students', students.filter(item => item.team === oldVal).length],
            ['Participants', participants.filter(item => item.team === oldVal).length],
            ['Registrations', registrations.filter(item => item.team === oldVal).length],
            ['Registration applications', registrationApplications.filter(item => item.team === oldVal).length],
            ['Registration requests', registrationRequests.filter(item => item.team === oldVal).length],
            ['Access profiles / team leaders', accessUsers.filter(item => item.team === oldVal).length + teamLeaders.filter(item => item.team === oldVal).length],
            ['Team notifications', await countCollectionWhere('notifications', 'team', oldVal)]
        ];
        return `UPDATE PREVIEW — Team rename: ${oldVal}

Will update automatically:
${direct.map(([label,count]) => `✓ ${label}: ${count}`).join('\n')}
✓ Team list, chest number keys, team colour and team image mapping
✓ Team registration policy document, if one exists
✓ Public/home/TV/registration/schedule settings where this team name is stored
✓ Results, revisions, score ledgers, schedule history, judge assignments/scores and audit/import history where this exact team name is stored

Will NOT update:
✕ Firebase Auth email/password/login UID
✕ Other team names that only look similar but are not exactly “${oldVal}”
✕ Deleted backup documents and unrelated free-text notes that do not exactly match the team name

Click Update to apply everything above. Click Cancel to make no changes.`;
    }
    const direct = [
        ['Students', students.filter(item => item.category === oldVal).length],
        ['Participants', participants.filter(item => item.category === oldVal).length],
        ['Events', events.filter(item => item.category === oldVal).length],
        ['Registration applications', registrationApplications.filter(item => item.category === oldVal || item.eventSnapshot?.category === oldVal || item.profileSnapshot?.category === oldVal).length],
        ['Registration requests', registrationRequests.filter(item => item.category === oldVal).length],
        ['Judge assignments', judgeAssignments.filter(item => item.category === oldVal).length]
    ];
    return `UPDATE PREVIEW — Category rename: ${oldVal}

Will update automatically:
${direct.map(([label,count]) => `✓ ${label}: ${count}`).join('\n')}
✓ Category list and chest number keys
✓ Results, score ledgers, schedule versions and audit logs where this exact category is stored

Will NOT update:
✕ Other category names that only look similar but are not exactly “${oldVal}”
✕ Deleted backup documents and unrelated free-text notes that do not exactly match the category name

Click Update to apply everything above. Click Cancel to make no changes.`;
};

async function cascadeRenameEverywhere(type, oldVal, newVal, setupPatch) {
    const ops = [];
    const counts = {};
    const count = (name, amount) => { counts[name] = (counts[name] || 0) + amount; };
    addBatchSet(ops, doc(db, 'settings', 'general'), setupPatch);
    if(type === 'teams') {
        const directTeamCollections = [
            { name: 'students', label: 'students', extra: { team: newVal } },
            { name: 'participants', label: 'participants', extra: { team: newVal, updatedAt: Date.now() } },
            { name: 'registrations', label: 'registrations', extra: { team: newVal, lastUpdatedAt: Date.now() } },
            { name: 'registrationApplications', label: 'applications', extra: { team: newVal, updatedAt: Date.now() } },
            { name: 'registrationRequests', label: 'requests', extra: { team: newVal } },
            { name: 'teamLeaders', label: 'teamLeaders', extra: { team: newVal, updatedAt: Date.now() } },
            { name: 'notifications', label: 'notifications', extra: { team: newVal } }
        ];
        for(const itemConfig of directTeamCollections) {
            const snap = await getDocs(query(collection(db, itemConfig.name), where('team', '==', oldVal)));
            snap.forEach(item => addDeepRenameDoc(ops, item, oldVal, newVal, count, itemConfig.label, itemConfig.extra));
        }
        const accessSnap = await getDocs(query(collection(db, 'accessUsers'), where('team', '==', oldVal)));
        accessSnap.forEach(item => {
            const patch = { team: newVal, updatedAt: Date.now() };
            addDeepRenameDoc(ops, item, oldVal, newVal, count, 'accessUsers', patch);
            updateAccessUsernameMirrors(ops, item.data(), patch);
            if(item.data().role === 'teamLeader') addBatchSet(ops, doc(db, 'teamLeaders', accessDocIdFor({ docId: item.id, ...item.data() })), patch, { merge: true });
        });
        const oldPolicyRef = doc(db, 'teamRegistrationPolicies', oldVal), newPolicyRef = doc(db, 'teamRegistrationPolicies', newVal), policySnap = await getDoc(oldPolicyRef);
        if(policySnap.exists()) { addBatchSet(ops, newPolicyRef, renamedDataPatch(policySnap.data(), oldVal, newVal, { team: newVal, renamedFrom: oldVal, renamedAt: Date.now() }), { merge: true }); addBatchDelete(ops, oldPolicyRef); count('teamPolicies', 1); }
        for(const settingId of ['home_config', 'public_config', 'tv_config', 'registration_config', 'schedule_config']) {
            const settingSnap = await getDoc(doc(db, 'settings', settingId));
            if(settingSnap.exists()) addDeepRenameDoc(ops, settingSnap, oldVal, newVal, count, `settings/${settingId}`);
        }
        for(const collectionName of ['results', 'resultRevisions', 'teamScoreLedgers', 'auditLogs', 'scheduleVersions', 'judgeAssignments', 'judgeScores', 'scheduleBreaks', 'eventImportSessions']) {
            const snap = await getDocs(collection(db, collectionName));
            snap.forEach(item => addDeepRenameDoc(ops, item, oldVal, newVal, count, collectionName));
        }
    } else {
        let snap = await getDocs(query(collection(db, 'students'), where('category', '==', oldVal))); snap.forEach(item => addBatchUpdate(ops, item.ref, { category: newVal })); count('students', snap.size);
        snap = await getDocs(query(collection(db, 'participants'), where('category', '==', oldVal))); snap.forEach(item => addBatchUpdate(ops, item.ref, { category: newVal })); count('participants', snap.size);
        snap = await getDocs(query(collection(db, 'events'), where('category', '==', oldVal))); snap.forEach(item => addBatchUpdate(ops, item.ref, { category: newVal, updatedAt: Date.now() })); count('events', snap.size);
        snap = await getDocs(collection(db, 'registrationApplications')); snap.forEach(item => { const patch = renameDeepValue({ category: item.data().category, eventSnapshot: item.data().eventSnapshot || {}, profileSnapshot: item.data().profileSnapshot || {} }, oldVal, newVal); if(JSON.stringify(patch) !== JSON.stringify({ category: item.data().category, eventSnapshot: item.data().eventSnapshot || {}, profileSnapshot: item.data().profileSnapshot || {} })) { addBatchUpdate(ops, item.ref, patch); count('applications', 1); } });
        snap = await getDocs(query(collection(db, 'registrationRequests'), where('category', '==', oldVal))); snap.forEach(item => addBatchUpdate(ops, item.ref, { category: newVal })); count('requests', snap.size);
        snap = await getDocs(query(collection(db, 'judgeAssignments'), where('category', '==', oldVal))); snap.forEach(item => addBatchUpdate(ops, item.ref, { category: newVal, updatedAt: Date.now() })); count('judgeAssignments', snap.size);
        snap = await getDocs(query(collection(db, 'scheduleBreaks'), where('category', '==', oldVal))); snap.forEach(item => addBatchUpdate(ops, item.ref, { category: newVal, updatedAt: Date.now() })); count('scheduleBreaks', snap.size);
        for(const collectionName of ['results', 'teamScoreLedgers', 'scheduleVersions', 'auditLogs']) {
            snap = await getDocs(collection(db, collectionName));
            snap.forEach(item => { const next = renameDeepValue(item.data(), oldVal, newVal); if(JSON.stringify(next) !== JSON.stringify(item.data())) { addBatchSet(ops, item.ref, next, { merge: false }); count(collectionName, 1); } });
        }
    }
    addBatchSet(ops, doc(collection(db, 'auditLogs')), { action: type === 'teams' ? 'team_rename_cascade' : 'category_rename_cascade', oldValue: oldVal, newValue: newVal, counts, totalWrites: ops.length + 1, uid: auth.currentUser?.uid || '', createdAt: Date.now() }, { merge: false });
    await commitBatchedOperations(ops);
    return counts;
}
window.ensureStableMasterIdentities = async data => {
    if(masterIdentityUpgradeStarted) return;
    const rawTeams = data.teams || [], rawCategories = (data.categories || []).filter(value => value !== 'General');
    const needsTeamCodes = rawTeams.some(value => !teamCodePattern.test(value));
    const needsCategoryCodes = rawCategories.some(value => !categoryCodePattern.test(value));
    const seededTeamNames = {...(data.teamDisplayNames || {})}, seededCategoryNames = {...(data.categoryDisplayNames || {})};
    rawTeams.forEach(team => { if(!seededTeamNames[team]) seededTeamNames[team] = team; });
    rawCategories.forEach(category => { if(!seededCategoryNames[category]) seededCategoryNames[category] = category; });
    if(!needsTeamCodes && !needsCategoryCodes) {
        if(JSON.stringify(seededTeamNames) !== JSON.stringify(data.teamDisplayNames || {}) || JSON.stringify(seededCategoryNames) !== JSON.stringify(data.categoryDisplayNames || {})) await setDoc(doc(db,'settings','general'), { teamDisplayNames: seededTeamNames, categoryDisplayNames: seededCategoryNames }, {merge:true});
        return;
    }
    masterIdentityUpgradeStarted = true;
    document.getElementById('app-loader')?.classList.remove('hide');
    try {
        let workingTeams = [...rawTeams], workingCategories = [...rawCategories], nextTeamNames = {...seededTeamNames}, nextCategoryNames = {...seededCategoryNames}, nextColors = {...(data.teamColors || {})}, nextLogos = {...(data.teamLogos || {})}, nextHeaders = {...(data.teamIdCardHeaders || {})};
        for(const [index, oldValue] of rawTeams.entries()) {
            const code = teamCodePattern.test(oldValue) ? oldValue : `Team ${alphaSequence(index)}`;
            if(oldValue === code) continue;
            const setupPatch = { teams: workingTeams.map(value => value === oldValue ? code : value), teamDisplayNames: {...nextTeamNames, [code]: nextTeamNames[oldValue] || oldValue}, teamColors:{...nextColors,[code]:nextColors[oldValue]||'#4f46e5'}, teamLogos:{...nextLogos,[code]:nextLogos[oldValue]||''}, teamIdCardHeaders:{...nextHeaders,[code]:nextHeaders[oldValue]||''} };
            delete setupPatch.teamDisplayNames[oldValue]; delete setupPatch.teamColors[oldValue]; delete setupPatch.teamLogos[oldValue]; delete setupPatch.teamIdCardHeaders[oldValue];
            await cascadeRenameEverywhere('teams', oldValue, code, setupPatch);
            workingTeams = setupPatch.teams; nextTeamNames = setupPatch.teamDisplayNames; nextColors = setupPatch.teamColors; nextLogos = setupPatch.teamLogos; nextHeaders = setupPatch.teamIdCardHeaders;
        }
        for(const [index, oldValue] of rawCategories.entries()) {
            const code = categoryCodePattern.test(oldValue) ? oldValue : `Category ${index + 1}`;
            if(oldValue === code) continue;
            const setupPatch = { categories: workingCategories.map(value => value === oldValue ? code : value), categoryDisplayNames: {...nextCategoryNames, [code]: nextCategoryNames[oldValue] || oldValue} };
            delete setupPatch.categoryDisplayNames[oldValue];
            await cascadeRenameEverywhere('categories', oldValue, code, setupPatch);
            workingCategories = setupPatch.categories; nextCategoryNames = setupPatch.categoryDisplayNames;
        }
        await setDoc(doc(db,'settings','general'), { teamDisplayNames: nextTeamNames, categoryDisplayNames: nextCategoryNames }, {merge:true});
        window.showToast('Stable Team/Category codes upgraded without deleting data');
    } catch(error) { console.error(error); window.showToast(error.message || 'Stable identity upgrade failed', 'error'); }
    finally { document.getElementById('app-loader')?.classList.add('hide'); }
};
window.editItem = async (type, oldVal) => {
    if(type === 'teams') return window.saveTeamDisplayName(oldVal);
    if(type === 'categories') return window.saveCategoryDisplayName(oldVal);
    const newVal = (await window.promptAction(`Rename ${oldVal} to:`, oldVal))?.trim();
    if (!newVal || newVal === oldVal) return;
    const list = type === 'categories' ? [...categories] : [...teams];
    if(list.includes(newVal)) return window.showToast(`${newVal} already exists`, 'error');
    const impactPreview = await renameImpactPreview(type, oldVal);
    if(!await window.confirmAction(`${impactPreview}\n\nRename “${oldVal}” to “${newVal}”?`, { okText: 'Update', cancelText: 'Cancel' })) return;
    window.showToast(`Renaming ${oldVal} everywhere...`, 'info'); document.getElementById('app-loader').classList.remove('hide');
    try {
        let newChestConfig = { ...chestConfig };
        Object.keys(chestConfig).forEach(key => { const parts = key.split('-'); const gender = parts.length > 2 ? parts.pop() : null; const t = parts.shift(); const c = parts.join('-'); const nextKey = (nt, nc) => gender ? chestKey(nt, nc, gender) : legacyChestKey(nt, nc); if (type === 'teams' && t === oldVal) { newChestConfig[nextKey(newVal, c)] = chestConfig[key]; delete newChestConfig[key]; } else if (type === 'categories' && c === oldVal) { newChestConfig[nextKey(t, newVal)] = chestConfig[key]; delete newChestConfig[key]; } });
        const idx = list.indexOf(oldVal); if(idx !== -1) list[idx] = newVal;
        const setupPatch = { [type]: list, chestConfig: newChestConfig };
        if(type === 'teams') { const nextColors = {...teamColors}, nextLogos = {...teamLogos}, nextHeaders = {...teamIdCardHeaders}; nextColors[newVal] = nextColors[oldVal] || '#4f46e5'; nextLogos[newVal] = nextLogos[oldVal] || ''; nextHeaders[newVal] = nextHeaders[oldVal] || ''; delete nextColors[oldVal]; delete nextLogos[oldVal]; delete nextHeaders[oldVal]; setupPatch.teamColors = nextColors; setupPatch.teamLogos = nextLogos; setupPatch.teamIdCardHeaders = nextHeaders; }
        const counts = await cascadeRenameEverywhere(type, oldVal, newVal, setupPatch);
        window.showToast(`Rename complete: ${Object.entries(counts).map(([key,value])=>`${value} ${key}`).join(', ') || 'master list updated'}`);
    } catch(error) { console.error(error); window.showToast(error.message || 'Rename failed', 'error'); }
    finally { document.getElementById('app-loader')?.classList.add('hide'); }
};

window.renderSetupLists = () => {
    const teamBox=document.getElementById('created-teams-list'),categoryBox=document.getElementById('created-categories-list');
    document.getElementById('inp-new-team')?.setAttribute('placeholder', `${nextTeamCode()} display name`);
    document.getElementById('inp-new-cat')?.setAttribute('placeholder', `${nextCategoryCode()} display name`);
    if(teamBox) teamBox.innerHTML=teams.length?teams.map(team=>`<span class="inline-flex items-center gap-2 rounded-xl border bg-white px-2 py-1 text-xs font-black"><span class="h-5 w-5 overflow-hidden rounded-md" style="background:${escapeHtml(teamColors[team]||'#4f46e5')}">${teamLogos[team]?`<img src="${escapeHtml(teamLogos[team])}" class="h-full w-full object-cover" alt="">`:''}</span>${escapeHtml(teamLabel(team))}<small class="font-mono text-slate-400">${escapeHtml(team)}</small></span>`).join(''):'<span class="text-xs font-bold text-slate-400">No teams added.</span>';
    if(categoryBox) categoryBox.innerHTML=categories.length?categories.map(category=>`<span class="rounded-xl border bg-white px-3 py-1 text-xs font-black text-indigo-700">${escapeHtml(categoryLabel(category))}<small class="ml-2 font-mono text-slate-400">${escapeHtml(category)}</small></span>`).join(''):'<span class="text-xs font-bold text-slate-400">No categories added.</span>';
};
window.createTeam = async () => {
    const code=nextTeamCode(),displayName=document.getElementById('inp-new-team')?.value.trim()||code,color=document.getElementById('inp-new-team-color')?.value||'#4f46e5',logo=document.getElementById('inp-new-team-logo')?.value||'';
    await setDoc(doc(db,'settings','general'),{teams:[...teams,code],teamDisplayNames:{...teamDisplayNames,[code]:displayName},teamColors:{...teamColors,[code]:color},teamLogos:{...teamLogos,[code]:logo},teamIdCardHeaders:{...teamIdCardHeaders,[code]:''}},{merge:true});
    document.getElementById('inp-new-team').value='';document.getElementById('inp-new-team-logo').value='';document.getElementById('inp-new-team-color').value='#4f46e5';window.refreshImageUploadPreviews?.();window.showToast(`${code} added`);
};
window.addItem = async (type, id) => { const val = document.getElementById(id).value.trim(); if(!val) return; if(type==='categories') { const code=nextCategoryCode(); await setDoc(doc(db, "settings", "general"), { categories: [...categories, code], categoryDisplayNames: {...categoryDisplayNames, [code]: val} }, { merge: true }); } if(type==='teams') { const code=nextTeamCode(); await setDoc(doc(db, "settings", "general"), { teams: [...teams, code], teamDisplayNames:{...teamDisplayNames,[code]:val}, teamColors: {...teamColors, [code]:'#4f46e5'}, teamLogos:{...teamLogos,[code]:''}, teamIdCardHeaders:{...teamIdCardHeaders,[code]:''} }, { merge: true }); } document.getElementById(id).value = ''; window.showToast('Added'); };
window.saveTeamDisplayName = async team => { if(!teams.includes(team)) return; const input=document.querySelector(`[data-team-display-name="${CSS.escape(team)}"]`), prompted=input?input.value:(await window.promptAction(`Display name for ${team}:`, teamLabel(team))); const value=String(prompted || team).trim() || team; await setDoc(doc(db,'settings','general'), { teamDisplayNames:{...teamDisplayNames,[team]:value} }, {merge:true}); window.showToast(`${team} display name saved`); };
window.saveCategoryDisplayName = async category => { if(!categories.includes(category)) return; const value=String(await window.promptAction(`Display name for ${category}:`, categoryLabel(category)) || category).trim() || category; await setDoc(doc(db,'settings','general'), { categoryDisplayNames:{...categoryDisplayNames,[category]:value} }, {merge:true}); window.showToast(`${category} display name saved`); };
window.saveTeamColor = async (team, color) => { if(!teams.includes(team) || !/^#[0-9a-f]{6}$/i.test(color)) return; await setDoc(doc(db,'settings','general'), { teamColors: {...teamColors, [team]:color} }, {merge:true}); window.showToast(`${team} colour saved`); };
window.saveTeamLogo = async (team) => {
    if(!teams.includes(team)) return;
    const button = document.querySelector(`[data-admin-action="save-team-logo"][data-team="${CSS.escape(team)}"]`);
    const card = button?.closest('.animate-enter');
    const valueId = card?.querySelector('input[type="hidden"][id^="team-logo-edit-"]')?.id;
    const logo = valueId ? document.getElementById(valueId)?.value || '' : '';
    await setDoc(doc(db,'settings','general'), { teamLogos: {...teamLogos, [team]:logo} }, {merge:true});
    window.showToast(logo ? `${team} image saved` : `${team} image removed`);
};
window.saveTeamIdHeader = async (team) => {
    if(!teams.includes(team)) return;
    const button = document.querySelector(`[data-admin-action="save-team-id-header"][data-team="${CSS.escape(team)}"]`);
    const card = button?.closest('.animate-enter');
    const valueId = card?.querySelector('input[type="hidden"][id^="team-id-header-edit-"]')?.id;
    const header = valueId ? document.getElementById(valueId)?.value || '' : '';
    await setDoc(doc(db,'settings','general'), { teamIdCardHeaders: {...teamIdCardHeaders, [team]:header} }, {merge:true});
    window.showToast(header ? `${team} ID card header saved` : `${team} ID card header removed`);
};

const teamIdPageSizes={A4:{w:210,h:297},A3:{w:297,h:420}};
let teamIdCardTeam='';
const teamIdMembers=team=>[...students.filter(item=>item.team===team).map(item=>({...item,source:'Student',photo:item.photoData||''})),...participants.filter(item=>item.team===team&&!item.studentId).map(item=>({...item,source:item.participantType||'Participant',chestNo:item.chestNo||item.id?.slice(0,6)||'',photo:item.photo||item.photoData||''}))].sort((a,b)=>String(a.chestNo||'').localeCompare(String(b.chestNo||''),undefined,{numeric:true})||String(a.name||'').localeCompare(String(b.name||'')));
const teamIdOptions=()=>{const size=document.getElementById('team-id-page-size')?.value||'A4',orientation=document.getElementById('team-id-orientation')?.value||'portrait',base=teamIdPageSizes[size]||teamIdPageSizes.A4,page=orientation==='landscape'?{w:base.h,h:base.w}:{...base};return{size,orientation,page,cardW:Number(document.getElementById('team-id-card-width')?.value||60),cardH:Number(document.getElementById('team-id-card-height')?.value||80),gap:Number(document.getElementById('team-id-gap')?.value||0),margin:Number(document.getElementById('team-id-margin')?.value||0)}};
const TEAM_ID_DEFAULTS={size:'A4',orientation:'portrait',cardW:60,cardH:80,gap:0,margin:0};
const resetTeamIdControls=()=>{[['team-id-page-size',TEAM_ID_DEFAULTS.size],['team-id-orientation',TEAM_ID_DEFAULTS.orientation],['team-id-card-width',TEAM_ID_DEFAULTS.cardW],['team-id-card-height',TEAM_ID_DEFAULTS.cardH],['team-id-gap',TEAM_ID_DEFAULTS.gap],['team-id-margin',TEAM_ID_DEFAULTS.margin]].forEach(([id,value])=>{const el=document.getElementById(id);if(el)el.value=value;});};
const teamIdLayout=opts=>{const cols=Math.max(1,Math.floor((opts.page.w-opts.margin*2+opts.gap)/(opts.cardW+opts.gap))),rows=Math.max(1,Math.floor((opts.page.h-opts.margin*2+opts.gap)/(opts.cardH+opts.gap)));return{cols,rows,perPage:cols*rows}};
const teamIdDetails=m=>[['Team',m.team||teamIdCardTeam||'—'],['Category',m.category||'—'],['Class',m.details?.class||m.class||'—'],['Gender',studentGender(m)||m.gender||'—'],['Status','Verified']];
const xmlEscape=value=>String(value??'').replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const dataUrlForSvg=svg=>`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const splitSvgName=name=>{const words=String(name||'Member').trim().split(/\s+/),lines=[];let line='';words.forEach(word=>{const next=line?`${line} ${word}`:word;if(next.length>22&&line){lines.push(line);line=word}else line=next});if(line)lines.push(line);return(lines.length?lines:['Member']).slice(0,2)};
const teamIdSvg=(member,team,color,header,logo)=>{const details=teamIdDetails(member),nameLines=splitSvgName(member.name||'Member'),chest=xmlEscape(member.chestNo||''),photo=member.photo||'',fest=xmlEscape(brandingName(homeConfig)||'Fest'),teamText=xmlEscape(details[0][1]),category=xmlEscape(details[1][1]),classText=xmlEscape(details[2][1]),gender=xmlEscape(details[3][1]);return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><defs><clipPath id="cardClip"><rect width="600" height="800" rx="34" ry="34"/></clipPath><clipPath id="photoClip"><circle cx="300" cy="212" r="116"/></clipPath><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="${xmlEscape(color)}" flood-opacity=".32"/></filter></defs><g clip-path="url(#cardClip)"><rect width="600" height="232" fill="#000703"/>${header?`<image href="${xmlEscape(header)}" x="0" y="0" width="600" height="232" preserveAspectRatio="xMidYMid slice"/>`:''}<rect y="232" width="600" height="488" fill="#fff"/><rect y="720" width="600" height="80" fill="#000703"/><rect x="408" y="743" width="192" height="57" fill="${xmlEscape(color)}"/><path d="M520 720h52l28 80H548z" fill="#fff"/><text x="92" y="665" transform="rotate(-90 92 665)" font-family="Arial, sans-serif" font-size="188" font-weight="900" fill="${xmlEscape(color)}" opacity=".16" letter-spacing="-7">${chest}</text>${!header&&logo?`<rect x="36" y="34" width="84" height="84" rx="20" fill="#fff" opacity=".96"/><image href="${xmlEscape(logo)}" x="47" y="45" width="62" height="62" preserveAspectRatio="xMidYMid meet"/>`:''}<circle cx="300" cy="212" r="138" fill="${xmlEscape(color)}" filter="url(#shadow)"/><circle cx="300" cy="212" r="116" fill="#fff"/>${photo?`<image href="${xmlEscape(photo)}" x="184" y="96" width="232" height="232" preserveAspectRatio="xMidYMid slice" clip-path="url(#photoClip)"/>`:`<text x="300" y="247" text-anchor="middle" font-size="92" font-family="Arial, sans-serif" font-weight="900" fill="#111827">${xmlEscape(String(member.name||'?')[0])}</text>`}<g text-anchor="middle" font-family="Arial, sans-serif"><text x="300" y="420" font-size="34" font-weight="900" fill="#0f172a">${xmlEscape(nameLines[0])}</text>${nameLines[1]?`<text x="300" y="458" font-size="30" font-weight="900" fill="#0f172a">${xmlEscape(nameLines[1])}</text>`:''}<text x="300" y="518" font-size="58" font-weight="900" fill="${xmlEscape(color)}" letter-spacing="1">${xmlEscape(member.chestNo||'—')}</text><text x="125" y="582" font-size="11" font-weight="900" fill="#94a3b8" letter-spacing="2">TEAM</text><text x="125" y="612" font-size="18" font-weight="900" fill="${xmlEscape(color)}">${teamText}</text><text x="300" y="582" font-size="11" font-weight="900" fill="#94a3b8" letter-spacing="2">CATEGORY</text><text x="300" y="612" font-size="18" font-weight="900" fill="#1f2937">${category}</text><text x="475" y="582" font-size="11" font-weight="900" fill="#94a3b8" letter-spacing="2">CLASS</text><text x="475" y="612" font-size="18" font-weight="900" fill="#1f2937">${classText}</text><text x="214" y="676" font-size="11" font-weight="900" fill="#94a3b8" letter-spacing="2">GENDER</text><text x="214" y="705" font-size="18" font-weight="900" fill="#1f2937">${gender}</text><text x="386" y="676" font-size="11" font-weight="900" fill="#94a3b8" letter-spacing="2">STATUS</text><text x="386" y="705" font-size="18" font-weight="900" fill="#059669">Verified</text><rect x="150" y="748" width="300" height="29" rx="15" fill="#fff" opacity=".88"/><text x="300" y="768" font-size="13" font-weight="900" fill="#0f172a" letter-spacing="2">${fest.toUpperCase()}</text></g></g></svg>`};
const teamIdPreviewCard=(member,team,color,header,logo)=>`<img src="${dataUrlForSvg(teamIdSvg(member,team,color,header,logo))}" class="block shadow-sm" style="width:100%;height:100%" alt="${escapeHtml(member.name||'ID card')}">`;
const svgToPng=svg=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=1600;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/png'))};image.onerror=reject;image.src=dataUrlForSvg(svg)});
window.openTeamIdCards=team=>{teamIdCardTeam=team;resetTeamIdControls();const title=document.getElementById('team-id-card-title');if(title)title.textContent=`${team} ID Cards`;document.getElementById('team-id-card-modal')?.classList.remove('hidden');renderTeamIdPreview()};
window.closeTeamIdCards=()=>document.getElementById('team-id-card-modal')?.classList.add('hidden');
window.renderTeamIdPreview=()=>{const box=document.getElementById('team-id-preview');if(!box||!teamIdCardTeam)return;const opts=teamIdOptions(),layout=teamIdLayout(opts),members=teamIdMembers(teamIdCardTeam),pages=Math.max(1,Math.ceil(members.length/layout.perPage)),color=teamColors[teamIdCardTeam]||'#4f46e5',header=teamIdCardHeaders[teamIdCardTeam]||'',logo=teamLogos[teamIdCardTeam]||homeConfig.logoUrl||homeConfig.logo||homeConfig.festLogo||'',warnings=[!members.length&&'No members found for this team',members.filter(m=>!m.photo).length&&`${members.filter(m=>!m.photo).length} member(s) without photo`,members.filter(m=>!m.chestNo).length&&`${members.filter(m=>!m.chestNo).length} member(s) without chest number`,header?'Header image will crop into the black top band':'No long header image: logo fallback will be shown'].filter(Boolean);document.getElementById('team-id-preview-summary').innerHTML=`${opts.size.toUpperCase()} ${opts.orientation} • ${opts.cardW}×${opts.cardH}mm card • ${layout.cols}×${layout.rows} = ${layout.perPage} cards/page • ${members.length} members • ${pages} page(s) • margin ${opts.margin}mm • gap ${opts.gap}mm`;box.innerHTML=`<div class="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">${warnings.map(text=>`<div class="rounded-xl border ${String(text).startsWith('No members')?'border-red-200 bg-red-50 text-red-700':'border-amber-200 bg-amber-50 text-amber-800'} p-3 text-xs font-black">${escapeHtml(text)}</div>`).join('')}</div><div class="overflow-auto rounded-3xl border bg-slate-100 p-3">`+Array.from({length:pages},(_,pageIndex)=>{const pageMembers=members.slice(pageIndex*layout.perPage,(pageIndex+1)*layout.perPage);return `<section class="mb-5 inline-block align-top"><div class="mb-2 flex items-center justify-between px-1 text-xs font-black text-slate-600"><span>Page ${pageIndex+1} of ${pages}</span><span>${pageMembers.length} card(s)</span></div><div class="relative bg-white shadow" style="width:${opts.page.w}mm;height:${opts.page.h}mm;padding:${opts.margin}mm;box-sizing:border-box;display:grid;grid-template-columns:repeat(${layout.cols},${opts.cardW}mm);grid-auto-rows:${opts.cardH}mm;gap:${opts.gap}mm;align-content:start;justify-content:start">${pageMembers.map(member=>`<div style="width:${opts.cardW}mm;height:${opts.cardH}mm">${teamIdPreviewCard(member,teamIdCardTeam,color,header,logo)}</div>`).join('')}</div></section>`}).join('')+'</div>'};
async function addPdfImage(doc,img,x,y,w,h){const fmt=String(img).startsWith('data:image/png')?'PNG':String(img).startsWith('data:image/webp')?'WEBP':'JPEG';try{doc.addImage(img,fmt,x,y,w,h,undefined,'FAST')}catch{try{doc.addImage(img,x,y,w,h)}catch{}}}
window.downloadTeamIdCards=async()=>{if(!teamIdCardTeam)return;const { jsPDF }=window.jspdf||{};if(!jsPDF)return window.showToast('PDF library not ready','error');const opts=teamIdOptions(),layout=teamIdLayout(opts),members=teamIdMembers(teamIdCardTeam);if(!members.length)return window.showToast('No members found for this team','error');const docPdf=new jsPDF({unit:'mm',format:opts.size.toLowerCase(),orientation:opts.orientation}),color=teamColors[teamIdCardTeam]||'#4f46e5',header=teamIdCardHeaders[teamIdCardTeam]||'',logo=teamLogos[teamIdCardTeam]||homeConfig.logoUrl||homeConfig.logo||homeConfig.festLogo||'';for(let i=0;i<members.length;i++){if(i&&i%layout.perPage===0)docPdf.addPage();const pageIndex=i%layout.perPage,col=pageIndex%layout.cols,row=Math.floor(pageIndex/layout.cols),x=opts.margin+col*(opts.cardW+opts.gap),y=opts.margin+row*(opts.cardH+opts.gap),png=await svgToPng(teamIdSvg(members[i],teamIdCardTeam,color,header,logo));docPdf.addImage(png,'PNG',x,y,opts.cardW,opts.cardH,undefined,'FAST')}docPdf.save(`${teamIdCardTeam}-ID-Cards-${opts.size}-${opts.orientation}.pdf`)};

['team-id-page-size','team-id-orientation','team-id-card-width','team-id-card-height','team-id-gap','team-id-margin'].forEach(id=>document.getElementById(id)?.addEventListener('input',()=>window.renderTeamIdPreview()));

window.removeItem = async (type, val) => {
    const affectedStudents = students.filter(s => type === 'teams' ? s.team === val : s.category === val).length;
    const affectedEvents = type === 'categories' ? events.filter(e => e.category === val).length : 0;
    const affectedRegs = type === 'teams' ? registrations.filter(r => r.team === val).length : 0;
    const impact = [affectedStudents && `${affectedStudents} students`, affectedEvents && `${affectedEvents} events`, affectedRegs && `${affectedRegs} registrations`].filter(Boolean).join(', ') || 'no linked records';
    if(await window.confirmAction(`Delete ${val}? Impact: ${impact}. Existing linked records are not deleted automatically.`)) { const update = type==='categories' ? { categories: categories.filter(x => x !== val) } : { teams: teams.filter(x => x !== val), teamColors:Object.fromEntries(Object.entries(teamColors).filter(([name])=>name!==val)), teamLogos:Object.fromEntries(Object.entries(teamLogos).filter(([name])=>name!==val)), teamIdCardHeaders:Object.fromEntries(Object.entries(teamIdCardHeaders).filter(([name])=>name!==val)) }; await setDoc(doc(db, "settings", "general"), update, { merge: true }); window.showToast('Deleted'); }
};

window.enableChestNoEdit = () => { document.querySelectorAll('.chest-start-input').forEach(inp => { inp.readOnly = false; inp.classList.add('bg-white', 'border-indigo-500', 'ring-2', 'ring-indigo-100'); inp.classList.remove('bg-slate-50', 'border-slate-200'); }); document.getElementById('btnEditChest').style.display = 'none'; document.getElementById('btnSaveChest').disabled = false; document.getElementById('btnSaveChest').classList.remove('opacity-50', 'cursor-not-allowed'); };
window.saveChestNoConfig = async () => { let updatedConfig = {...chestConfig}; let hasChanges = false; document.querySelectorAll('.chest-start-input').forEach(inp => { if(inp.value) { updatedConfig[inp.getAttribute('data-key')] = parseInt(inp.value); hasChanges = true; } inp.readOnly = true; inp.classList.remove('bg-white', 'border-indigo-500', 'ring-2', 'ring-indigo-100'); inp.classList.add('bg-slate-50', 'border-slate-200'); }); if(hasChanges) { await setDoc(doc(db, "settings", "general"), { chestConfig: updatedConfig }, { merge: true }); window.showToast('Config Saved!'); } document.getElementById('btnEditChest').style.display = 'flex'; document.getElementById('btnSaveChest').disabled = true; document.getElementById('btnSaveChest').classList.add('opacity-50', 'cursor-not-allowed'); };

const masterValue = id => document.getElementById(id)?.value || '';
const checkedValues = name => [...document.querySelectorAll(`[name="${name}"]:checked`)].map(input => input.value);
const MASTER_INFO={excelImport:{title:'Excel Event Import',text:'Allows administrators to create or update many events from the reviewed Excel import workflow.',when:'Use when event details are prepared in a spreadsheet.',depends:'Event field requirements and valid Master Setup values.',pages:'Admin Events and Event Import.',impact:'Disabling hides the import workflow; existing events and import history remain stored.'},customCriteria:{title:'Custom Judging Criteria',text:'Allows each event to define named judging criteria and the maximum mark for each criterion.',when:'Use when judges must score separate qualities such as content, language or presentation.',depends:'Criteria-based result method and maximum mark.',pages:'Event Setup, Judge Desk and Publisher.',impact:'Existing criteria remain stored; future event forms no longer offer criteria overrides when disabled.'},objectiveScoring:{title:'Objective Scoring',text:'Enables correct-answer marks and optional wrong-answer penalties for quiz-style events.',when:'Use for quizzes, tests and other answer-based competitions.',depends:'Objective result method and maximum mark.',pages:'Event Setup, Judge Desk and Publisher.',impact:'Disabling removes objective controls from future event setup without deleting saved scores.'},timeResults:{title:'Time-based Results',text:'Ranks entries by recorded time, with lower-time or higher-time direction selected for the event.',when:'Use for races, timed tasks and duration-based competitions.',depends:'Time result method and tie-break policy.',pages:'Event Setup, Judge Desk, Results and Schedule.',impact:'Existing timed results remain available; new events cannot select this method when disabled.'},countResults:{title:'Count-based Results',text:'Ranks entries using a count or total and can apply a configured penalty for invalid attempts.',when:'Use when a measurable count determines the result.',depends:'Count result method and penalty rules.',pages:'Event Setup, Judge Desk and Publisher.',impact:'Saved count results remain; the method is hidden for future event configuration when disabled.'},directRank:{title:'Direct Rank',text:'Lets an authorised result workflow assign positions directly instead of calculating them from marks.',when:'Use when judges declare First, Second and Third without entering a numeric score.',depends:'Competition position policy and publisher review.',pages:'Event Setup, Judge Desk and Publisher.',impact:'Disabling does not change published positions; future events must use another result method.'},multipleJudges:{title:'Multiple Judges',text:'Allows more than one judge sheet per event and combines them using the selected average, trimming or weighting policy.',when:'Use for panel judging.',depends:'Judge assignments and Competition Policy Centre.',pages:'Event Setup, Judgement and Publisher.',impact:'Review active assignments before disabling; submitted judge sheets are retained.'},eventOverrides:{title:'Event Scoring Overrides',text:'Allows an individual event to use a scoring policy different from the festival default.',when:'Use only when some events should not follow the main points, grades or display policy.',depends:'Competition Scoring Rules and result method.',pages:'Event Setup, Publisher and standings.',impact:'Disabling keeps saved overrides but new events inherit Master Setup scoring.'},workflowStatuses:{title:'Event Workflow Statuses',text:'Tracks operational states such as draft, needs review and validated before an event is used downstream.',when:'Use when event preparation requires review and approval steps.',depends:'Event validation and result workflow.',pages:'Event Import, Events, Judgement and Publisher.',impact:'Disabling simplifies status controls but does not remove stored validation history.'},importHistory:{title:'Import History',text:'Keeps a reviewable record of event spreadsheet import sessions, errors and outcomes.',when:'Use when administrators need traceability for bulk imports.',depends:'Excel Event Import.',pages:'Admin Events and Event Import History.',impact:'Disabling hides history tools; previously stored sessions remain available in the database.'},teamLedger:{title:'Team Score Ledger',text:'Maintains auditable team-score entries derived from published position and grade awards.',when:'Use when team championship totals or standings are required.',depends:'Team scoring, Competition Scoring Rules and published results.',pages:'Publisher, Public Results, Team Portal and TV.',impact:'Disabling stops future team-total contribution; existing ledger records require review, not deletion.'},registration_channels:{title:'Registration Channels',text:'Controls who may create registrations: Admin, Team Leader, Self Registration or On-site staff.',when:'Choose channels before opening entries.',depends:'Organisation mode, access roles and Public Registration.',pages:'Admin, Team Portal and Public Registration.',impact:'Disabling a channel prevents new use but retains existing registrations.'},about:{title:'About',text:'Shows the About link and landing-page About section.',when:'Enable when visitors should see festival information.',depends:'About content in Public Page Control.',pages:'Landing menu, quick buttons and About section.',impact:'Disabled hides the link and section without deleting content.'},leaders:{title:'Leaders',text:'Shows the Leaders link and landing-page leadership section.',when:'Enable when leader profiles should be public.',depends:'Active leader data or configured legacy leader content.',pages:'Landing menu, quick buttons and Leaders section.',impact:'Disabled hides profiles without deleting them.'},gallery:{title:'Gallery',text:'Shows the Gallery link and landing-page image section.',when:'Enable when festival images should be public.',depends:'Gallery uploads in Public Page Control.',pages:'Landing menu, quick buttons and Gallery section.',impact:'Disabled hides images without deleting uploads.'},login:{title:'Login',text:'Shows a visitor shortcut to the shared role login page.',when:'Enable when administrators, judges, publishers or team leaders need a public entry point.',depends:'Role Access configuration.',pages:'Landing menu and quick buttons; destination is Login.',impact:'Disabling hides only the shortcut; direct authorised login remains available.'},festival_profile:{title:'Festival Complexity Profile',text:'Applies a safe Basic, Standard or Advanced draft across event, schedule, judging and scoring capabilities.',when:'Choose before operational data entry.',depends:'Existing data is retained and reviewed before activation.',pages:'All operational portals.',impact:'Profile changes visibility and defaults, never deletes records.'},gender_registration:{title:'Gender',text:'Controls the gender divisions available for students, participants, events and registrations.',when:'Configure before entering people or events.',depends:'Participant eligibility and competition policy.',pages:'Students, Participants, Events and Registration.',impact:'Existing records remain stored when a division is disabled.'},public_modules:{title:'Public Modules',text:'Controls which approved experiences visitors can open.',when:'Enable only when its dependency is configured.',depends:'Schedule, scoring, registration and publishing.',pages:'Public Home, Results, Registration and TV.',impact:'Disabling hides content without deleting it.'},event_fields:{title:'Event Form & Import Fields',text:'Uses safe profile defaults and optional custom visibility/requirement rules.',when:'Customize only when the selected profile is insufficient.',depends:'Result method, event type, schedule and judging capabilities.',pages:'Event Add/Edit and Excel model/import.',impact:'Hidden fields keep existing stored data.'},student_fields:{title:'Student Detail Fields',text:'Built-in identity fields are protected; custom fields can be edited or deleted.',when:'Configure before student entry or import.',depends:'Class Master supplies student and event eligibility choices.',pages:'Students, imports, Team Portal and registration.',impact:'Disabling preserves existing stored values.'},participant_types:{title:'Participant Types',text:'Defines who may enter events: Student, Parent, Staff, Alumni, Public or a custom type.',when:'Enable only the populations this fest accepts.',depends:'Event eligibility and registration channels.',pages:'Student Directory, Registration, Team Portal and event setup.',impact:'Removing a used type requires participant, request and event review.'},student:{title:'Student',text:'Directory-managed learners with class, category, gender and team eligibility.',when:'School and team festivals.',depends:'Student fields, categories and teams.',pages:'Admin Students, Team Portal and registration.',impact:'Disabling affects student-only events and existing entries.'},parent:{title:'Parent',text:'Parents or guardians, optionally linked to a student.',when:'Family and guardian events.',depends:'Participant registration and relationship fields.',pages:'Registration and participant directory.',impact:'Review inherited team and linked-student rules.'},staff:{title:'Staff',text:'Teaching and non-teaching staff participants.',when:'Staff events or community modes.',depends:'Staff-eligible events.',pages:'Participant directory and registration.',impact:'Current class rules do not apply unless configured.'},alumni:{title:'Alumni',text:'Former students identified independently of the current Student Directory.',when:'Alumni-eligible competitions.',depends:'Optional batch/year custom fields.',pages:'Participant directory and registration.',impact:'Review alumni-only event eligibility before disabling.'},public:{title:'Public',text:'Open participants without an existing student record.',when:'Community or open festivals.',depends:'Self or on-site registration and approval.',pages:'Public Registration and Admin requests.',impact:'Public applicants cannot register when both channels are disabled.'},Boys:{title:'Boys',text:'Allows Boys as participant and event eligibility.',when:'Enable when the fest has boys divisions.',depends:'Student data, events and registration rules.',pages:'Imports, event setup, registration and results.',impact:'Disabling never deletes records but requires an eligibility review.'},Girls:{title:'Girls',text:'Allows Girls as participant and event eligibility.',when:'Enable when the fest has girls divisions.',depends:'Student data, events and registration rules.',pages:'Imports, event setup, registration and results.',impact:'Disabling never deletes records but requires an eligibility review.'},admin:{title:'Admin Registration',text:'Administrators create, correct and manage entries on behalf of participants.',when:'Recommended as an operational fallback.',depends:'Admin access.',pages:'Admin registration desk.',impact:'Disabling removes on-behalf-of registration capability.'},teamLeader:{title:'Team Leader Registration',text:'Leaders register eligible participants only for their assigned team.',when:'Team-managed festivals.',depends:'Teams, leader access and event limits.',pages:'Team Portal.',impact:'Open organisation mode cannot use this channel.'},self:{title:'Self Registration',text:'Applicants submit requests through the public registration page.',when:'Open or hybrid festivals.',depends:'Public Registration module and eligible events.',pages:'Public Registration and Admin request review.',impact:'Requests should remain approval-controlled unless policy says otherwise.'},onSite:{title:'On-site Registration',text:'Venue/help-desk entry during the festival.',when:'Walk-in registration.',depends:'Capacity, duplicate and chest-number checks.',pages:'Admin registration desk.',impact:'Disable after the on-site window closes.'},results:{title:'Public Results',text:'Displays only published results; private judge sheets remain hidden.',when:'Enable when the public may see approved outcomes.',depends:'Result publication workflow.',pages:'Public Results and optionally TV.',impact:'Disabling hides results without deleting them.'},teamStandings:{title:'Team Standings',text:'Shows championship totals from the scoring ledger.',when:'Team scoring is enabled or per-event.',depends:'Position/grade points and team ledger.',pages:'Public standings and TV.',impact:'Meaningless when team scoring is disabled.'},talentRankings:{title:'Talent Rankings',text:'Shows participant-level achievements from published results.',when:'Individual achievement rankings are required.',depends:'Published participant results.',pages:'Public website.',impact:'Group points must not be multiplied into team totals.'},schedule:{title:'Public Schedule',text:'Publishes the approved programme order, date, time and stage.',when:'Basic or full scheduling is enabled.',depends:'Saved schedule data.',pages:'Public website.',impact:'Disabled scheduling automatically hides this module.'},registration:{title:'Open Registration',text:'Exposes the public application form.',when:'Self registration is enabled.',depends:'Eligible participant types, events and approval rules.',pages:'Public Registration.',impact:'The link is hidden when this module is disabled.'},tv:{title:'TV Display',text:'Shows published results, standings, announcements and controlled media.',when:'A venue display is required.',depends:'Published content and TV settings.',pages:'TV Display.',impact:'Unpublished judge data must never be exposed.'}};
const masterInfoOpen=new Set();
const masterInfoFor=key=>{const definition=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions).find(item=>item.key===key);return MASTER_INFO[key]||(definition?{title:definition.label,text:definition.description||'Custom participant type.',when:'Events explicitly allow this type.',depends:'Participant and event eligibility.',pages:'Participant directory and registration.',impact:`Currently referenced by ${participantTypeUsage(key)} participant/event/request records.`}:{title:key,text:'This option controls an application capability.',when:'Enable when required by the fest.',depends:'Review related setup.',pages:'Master Setup.',impact:'Review affected records before disabling it.'});};
const closeMasterInfo=()=>{document.getElementById('master-help-popover')?.remove();masterInfoOpen.clear();};
window.showMasterInfo=(key,trigger)=>{const same=masterInfoOpen.has(key);closeMasterInfo();if(same||!trigger)return;masterInfoOpen.add(key);const info=masterInfoFor(key),rect=trigger.getBoundingClientRect(),pop=document.createElement('aside');pop.id='master-help-popover';pop.className='fixed z-[500] max-h-[min(420px,calc(100vh-24px))] w-[min(320px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-indigo-200 bg-white p-4 shadow-2xl';pop.innerHTML=`<div class="flex justify-between gap-3"><b class="text-sm text-slate-900">${escapeHtml(info.title)}</b><button data-admin-action="close-master-info" aria-label="Close help"><i data-lucide="x" class="h-4 w-4"></i></button></div><p class="mt-2 text-xs font-semibold text-slate-600">${escapeHtml(info.text)}</p><dl class="mt-3 space-y-2 text-[10px]"><div><dt class="font-black text-indigo-700">WHEN</dt><dd>${escapeHtml(info.when)}</dd></div><div><dt class="font-black text-indigo-700">DEPENDENCIES / PAGES</dt><dd>${escapeHtml(info.depends)} ${escapeHtml(info.pages)}</dd></div><div class="rounded-lg bg-amber-50 p-2 text-amber-800"><dt class="font-black">CHANGE IMPACT</dt><dd>${escapeHtml(info.impact)}</dd></div></dl>`;document.body.append(pop);const mobile=innerWidth<640,left=mobile?12:Math.min(innerWidth-pop.offsetWidth-12,Math.max(12,rect.right+8)),top=mobile?innerHeight-pop.offsetHeight-12:Math.min(innerHeight-pop.offsetHeight-12,Math.max(12,rect.top));pop.style.left=`${left}px`;pop.style.top=`${top}px`;window.lucide?.createIcons?.();};
window.closeMasterInfo=closeMasterInfo;window.clearMasterInfo=closeMasterInfo;
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMasterInfo();});document.addEventListener('click',event=>{if(document.getElementById('master-help-popover')&&!event.target.closest('#master-help-popover,[data-admin-action="show-master-info"]'))closeMasterInfo();});
const participantTypeUsage=key=>participants.filter(item=>item.participantType===key).length+events.filter(item=>(item.allowedParticipantTypes||[]).includes(key)).length+registrationRequests.filter(item=>item.participantType===key).length;
window.addMasterParticipantType=()=>{const label=masterValue('master-new-participant-label').trim(),description=masterValue('master-new-participant-description').trim(),key=label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');if(!label||!key)return window.showToast('Enter an English participant type name','error');const definitions=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions);if(definitions.some(item=>item.key===key))return window.showToast('Participant type already exists','error');festSetup={...festSetup,preset:'custom',participantTypeDefinitions:[...definitions,{key,label,description,system:false}],participantTypes:[...new Set([...festSetup.participantTypes,key])]};document.getElementById('master-new-participant-label').value='';document.getElementById('master-new-participant-description').value='';window.renderMasterSetup();};
window.editMasterParticipantType=async key=>{const definitions=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions),item=definitions.find(value=>value.key===key);if(!item||item.system)return;const label=await window.promptAction('Participant type name',item.label);if(!label)return;const description=await window.promptAction('Short description',item.description||'');festSetup={...festSetup,preset:'custom',participantTypeDefinitions:definitions.map(value=>value.key===key?{...value,label,description:description??value.description}:value)};window.renderMasterSetup();};
window.removeMasterParticipantType=async key=>{const definitions=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions),item=definitions.find(value=>value.key===key);if(!item||item.system)return;const usage=participantTypeUsage(key);if(usage)return window.showToast(`${item.label} is used by ${usage} records; disable it instead of deleting`,'error');festSetup={...festSetup,preset:'custom',participantTypeDefinitions:definitions.filter(value=>value.key!==key),participantTypes:festSetup.participantTypes.filter(value=>value!==key)};window.renderMasterSetup();};
const MASTER_SCORING_PACK={school_team_fest:'points_grades',simple_direct_fest:'direct_rank',open_registration_fest:'standard_points',hybrid_community_fest:'advanced'};
window.applyMasterPreset=value=>{if(value==='custom'){festSetup={...festSetup,preset:'custom'};window.renderMasterSetup();return;}const currentPolicies=festSetup.competitionPolicies,currentFields=festSetup.studentFields,currentDefinitions=festSetup.participantTypeDefinitions;festSetup={...setupForPreset(value),competitionPolicies:currentPolicies,studentFields:currentFields,participantTypeDefinitions:currentDefinitions};window.renderMasterSetup();window.applyScoringPolicyPack?.(MASTER_SCORING_PACK[value]||'custom');};
const renderPresetGuide=setup=>{const guide=FEST_PRESET_GUIDES[setup.preset]||FEST_PRESET_GUIDES.custom,box=document.getElementById('master-preset-guide');if(!box)return;box.innerHTML=`<div class="flex flex-col gap-4 lg:flex-row lg:justify-between"><div><h4 class="text-lg font-black text-indigo-950">${escapeHtml(guide.label)}</h4><p class="mt-1 text-sm font-semibold text-indigo-800">${escapeHtml(guide.summary)}</p><p class="mt-3 text-xs font-black uppercase text-indigo-500">Workflow</p><p class="mt-1 text-xs font-bold text-indigo-800">${guide.workflow.map(escapeHtml).join(' → ')}</p></div><div class="lg:max-w-sm"><p class="text-xs font-black uppercase text-indigo-500">Available workspaces</p><div class="mt-2 flex flex-wrap gap-2">${guide.pages.map(page=>`<span class="rounded-full bg-white px-3 py-1 text-[10px] font-black text-indigo-700">${escapeHtml(page)}</span>`).join('')}</div></div></div>`;};
const renderMasterParticipantTypes=setup=>{const box=document.getElementById('master-participant-types');if(!box)return;box.innerHTML=normalizeParticipantTypeDefinitions(setup.participantTypeDefinitions).map(item=>`<div class="flex items-center justify-between rounded-xl bg-slate-50 p-3"><label class="min-w-0 flex-1 text-sm font-bold capitalize"><input type="checkbox" name="master-participants" value="${item.key}" data-master-list="participantTypes" ${setup.participantTypes.includes(item.key)?'checked':''} class="mr-2">${escapeHtml(item.label)}</label><div class="flex"><button data-admin-action="show-master-info" data-info="${item.key}" class="rounded-lg p-1 text-indigo-600" aria-label="${escapeHtml(item.label)} help"><i data-lucide="info" class="h-4 w-4"></i></button>${item.system?'':`<button data-admin-action="edit-participant-type" data-key="${item.key}" class="rounded-lg p-1 text-slate-500"><i data-lucide="pencil" class="h-4 w-4"></i></button><button data-admin-action="remove-participant-type" data-key="${item.key}" class="rounded-lg p-1 text-red-500"><i data-lucide="trash-2" class="h-4 w-4"></i></button>`}</div></div>`).join('')+'<p class="rounded-xl bg-indigo-50 p-3 text-[10px] font-bold text-indigo-700">At least one participant type must remain enabled. To disable Student, enable another type first. Use Registration Policy to turn the public portal off.</p>';};
const decorateMasterHelp=()=>{document.querySelectorAll('#view-master-setup [data-master-list],#view-master-setup [data-master-public],#view-master-setup [data-master-event-feature]').forEach(input=>{const label=input.closest('label');if(!label||label.closest('#master-participant-types')||label.querySelector('[data-auto-info]'))return;label.classList.add('flex','items-center','justify-between','gap-2');const button=document.createElement('button'),key=input.dataset.masterEventFeature||input.dataset.masterPublic||input.value;button.type='button';button.dataset.adminAction='show-master-info';button.dataset.info=key;button.dataset.autoInfo='true';button.className='master-info-trigger ml-auto';button.setAttribute('aria-label',`${masterInfoFor(key).title} information`);button.title='Show information';button.innerHTML='<i data-lucide="info" class="h-4 w-4"></i>';label.append(button);});document.querySelectorAll('#view-master-setup [data-admin-action="show-master-info"]').forEach(button=>{button.type='button';button.classList.add('master-info-trigger');});};
const mergeScoringIntoMasterSetup=()=>{const slot=document.getElementById('master-scoring-slot'),view=document.getElementById('view-scoring');if(!slot||!view||slot.children.length)return;const card=view.firstElementChild;if(card){card.querySelector('h3').textContent='Competition Scoring Rules';slot.append(card);}view.remove();};
window.renderMasterImpactReview=()=>{const box=document.getElementById('master-impact-review');if(!box)return;const changes=[],select=(id)=>masterValue(id);if(select('master-organisation')!==savedFestSetup.organisationMode)changes.push(['Organisation model',`${teams.length} teams • ${registrations.length} registrations • ${participants.length} participants`]);if(select('master-schedule')!==savedFestSetup.scheduleMode)changes.push(['Schedule mode',`${events.filter(event=>event.scheduleDate||event.scheduleDayId).length} scheduled events • schedule versions require review`]);if(select('master-judging')!==savedFestSetup.judgingMode)changes.push(['Judgement mode',`${judgeAssignments.length} assignments • ${judgeScores.filter(score=>score.status==='submitted').length} submitted score sheets`]);if(select('master-results')!==savedFestSetup.resultWorkflow)changes.push(['Result workflow',`${results.length} results • ${judgeScores.length} judge score sheets`]);if(select('master-team-scoring')!==savedFestSetup.teamScoringMode)changes.push(['Team scoring',`${results.length} published/working results • team standings require recalculation`]);const current=readScoringConfigFromDom();if(JSON.stringify(current.configs)!==JSON.stringify(normalizeAdminScoringRules().configs)||JSON.stringify(current.gradeThresholds)!==JSON.stringify(normalizeAdminScoringRules().gradeThresholds))changes.push(['Competition scoring rules',`${results.filter(result=>!result.status||result.status==='published').length} published results stay frozen • future results use the new snapshot • standings ledger requires review`]);const removed=savedFestSetup.participantTypes.filter(type=>!checkedValues('master-participants').includes(type));removed.forEach(type=>changes.push([`Participant type: ${type}`,`${participantTypeUsage(type)} linked records require review`]));const policyMissing=incompleteCompetitionPolicies(competitionPoliciesFromForm()),classValues=(document.querySelector('[data-student-field-options="class"]')?.value||'').split(',').map(v=>v.trim()).filter(Boolean),checks=[['Participant types',checkedValues('master-participants').length>0],['Gender divisions',checkedValues('master-genders').length>0],['Registration channels',checkedValues('master-registration').length>0],['Class Master',classValues.length>0],['Competition policies',policyMissing.length===0]];const readiness=checks.map(([title,ok])=>`<article class="rounded-xl border p-3 ${ok?'border-emerald-200 bg-emerald-50':'border-red-200 bg-red-50'}"><b class="text-sm ${ok?'text-emerald-900':'text-red-900'}">${ok?'✓':'✕'} ${title}</b><p class="mt-1 text-xs font-semibold ${ok?'text-emerald-700':'text-red-700'}">${ok?'Ready for activation':title==='Competition policies'?escapeHtml(policyMissing.join(' • ')):'Complete this section before activation'}</p></article>`).join('');const impacts=changes.map(([title,impact])=>`<article class="rounded-xl border border-amber-200 bg-amber-50 p-3"><div class="flex items-center gap-2"><i data-lucide="triangle-alert" class="h-4 w-4 text-amber-600"></i><b class="text-sm text-amber-950">${escapeHtml(title)}</b></div><p class="mt-1 text-xs font-semibold text-amber-800">${escapeHtml(impact)}</p><p class="mt-2 text-[10px] font-black uppercase text-amber-600">Data is retained; review affected records after saving.</p></article>`).join('');box.innerHTML=readiness+(impacts||'<div class="col-span-full rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">No operational mode changes detected.</div>');window.lucide?.createIcons?.();};
const publicViewGet=(obj,path)=>path.split('.').reduce((value,key)=>value?.[key],obj);
const publicViewControl=(path,label,value)=>`<label class="flex items-center justify-between gap-3 rounded-xl border bg-slate-50 p-3 text-xs font-bold"><span>${escapeHtml(label)}</span><input type="checkbox" data-public-view-path="${path}" ${value?'checked':''} class="h-5 w-5"></label>`;
const customLandingLinks=setup=>Array.isArray(setup.publicView?.landing?.customLinks)?setup.publicView.landing.customLinks:[];
const renderCustomLandingLinks=setup=>{const links=customLandingLinks(setup);return `<fieldset class="rounded-xl border border-cyan-100 bg-cyan-50/30 p-4 lg:col-span-3"><legend class="px-1 text-xs font-black text-cyan-900">CUSTOM LANDING BUTTONS</legend><p class="mb-3 text-[10px] font-bold text-cyan-800">Add external platform links. Uploaded icon images are shown; otherwise a link icon appears.</p><div id="custom-landing-links-list" class="grid gap-2">${links.map((link,index)=>`<div class="grid gap-2 rounded-xl border bg-white p-3 md:grid-cols-[1fr_1fr_1fr_auto]"><input data-custom-link-index="${index}" data-custom-link-field="label" value="${escapeHtml(link.label||'')}" class="text-input" placeholder="Button name"><input data-custom-link-index="${index}" data-custom-link-field="url" value="${escapeHtml(link.url||'')}" class="text-input" placeholder="https://example.com" dir="ltr"><div><input id="custom-link-icon-${index}" data-custom-link-index="${index}" data-custom-link-field="icon" type="hidden" value="${escapeHtml(link.icon||'')}"><input data-image-file data-image-value="custom-link-icon-${index}" data-image-preview="custom-link-icon-preview-${index}" data-image-error="custom-link-icon-error-${index}" type="file" accept="image/jpeg,image/png,image/webp,image/gif" class="text-input text-xs"><p id="custom-link-icon-error-${index}" class="text-xs font-bold text-red-600"></p><div id="custom-link-icon-preview-${index}" class="mt-1 flex gap-2">${link.icon?`<img src="${escapeHtml(link.icon)}" class="h-9 w-9 rounded-lg object-cover" alt="">`:''}</div></div><button type="button" data-admin-action="remove-custom-landing-link" data-index="${index}" class="rounded-xl bg-red-50 px-3 py-2 text-xs font-black text-red-600">Remove</button></div>`).join('')||'<p class="rounded-xl border border-dashed bg-white p-4 text-xs font-bold text-slate-400">No custom buttons added.</p>'}</div><button type="button" data-admin-action="add-custom-landing-link" class="mt-3 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-black text-white">+ Add Custom Button</button></fieldset>`;};
const customLandingLinksFromDom=()=>[...document.querySelectorAll('[data-custom-link-index][data-custom-link-field="label"]')].map(input=>{const index=input.dataset.customLinkIndex;return{label:input.value.trim(),url:document.querySelector(`[data-custom-link-index="${index}"][data-custom-link-field="url"]`)?.value.trim()||'',icon:document.querySelector(`[data-custom-link-index="${index}"][data-custom-link-field="icon"]`)?.value||''};}).filter(item=>item.label&&item.url);
window.addCustomLandingLink=()=>{const links=[...customLandingLinksFromDom(),{label:'New Link',url:'https://',icon:''}];festSetup={...festSetup,publicView:{...festSetup.publicView,landing:{...festSetup.publicView.landing,customLinks:links}}};window.renderPublicViewSettings(normalizeFestSetup(festSetup));masterDirtySections.add('public-view');updateMasterSubnavStatus();};
window.removeCustomLandingLink=index=>{const links=customLandingLinksFromDom().filter((_,i)=>i!==Number(index));festSetup={...festSetup,publicView:{...festSetup.publicView,landing:{...festSetup.publicView.landing,customLinks:links}}};window.renderPublicViewSettings(normalizeFestSetup(festSetup));masterDirtySections.add('public-view');updateMasterSubnavStatus();};
const PUBLIC_VIEW_LABELS={hero:'Hero',about:'About',leaders:'Leaders',gallery:'Gallery',schedule:'Schedule',nextProgram:'Next Program',teamStandings:'Team Standings',registration:'Register',social:'Social Links',footer:'Footer',results:'Results',login:'Login',talent:'Top Talent',result:'Results Tab',team:'Teams Tab',rank:'Rank',total:'Total Points',medals:'Position Counts',progress:'Progress',overall:'Overall',category:'Category',gender:'Gender',awards:'Awards',resultCard:'Result Card',certificate:'Certificate',poster:'Poster',chestNo:'Chest Number',position:'Position',grade:'Grade',positionPoints:'Position Points',gradePoints:'Grade Points',totalPoints:'Total Earned Value'};
const publicViewGroup=(obj,prefix,keys)=>keys.map(key=>publicViewControl(`${prefix}.${key}`,PUBLIC_VIEW_LABELS[key]||key,Boolean(obj?.[key]))).join('');
const PUBLIC_VIEW_PARENT={results:'results',about:'about',leaders:'leaders',gallery:'gallery',schedule:'schedule',registration:'registration',login:'login',teamStandings:'teamStandings',talent:'talentRankings'};
const PUBLIC_VIEW_ORDER_DEFAULTS={sections:['hero','about','leaders','schedule','gallery'],menu:['results','about','leaders','gallery','schedule','registration','login','teamStandings','talent'],quickButtons:['results','about','leaders','gallery','schedule','registration','login','teamStandings','talent']};
const activePublicModules=setup=>Object.fromEntries(Object.keys(setup.publicModules||{}).map(key=>[key,document.querySelector(`[data-master-public="${key}"]`)?.checked??setup.publicModules[key]]));
const publicViewDependentControl=(setup,path,key)=>{const parent=PUBLIC_VIEW_PARENT[key],locked=parent&&activePublicModules(setup)[parent]!==true;return `<label data-public-dependent-row data-parent="${parent||''}" class="flex items-center justify-between gap-3 rounded-xl border p-3 text-xs font-bold ${locked?'cursor-not-allowed bg-slate-100 opacity-60':'bg-slate-50'}"><span>${escapeHtml(PUBLIC_VIEW_LABELS[key]||key)}${locked?`<small class="block text-amber-700">Enable ${escapeHtml(PUBLIC_VIEW_LABELS[parent]||parent)} above first</small>`:''}</span><input type="checkbox" data-public-view-path="${path}" ${publicViewGet(setup.publicView,path)?'checked':''} ${locked?'disabled':''} class="h-5 w-5"></label>`;};
const publicViewSortable=(setup,group)=>{const values=setup.publicView.landing[group]||{},order=setup.publicView.landing.orders?.[group]||PUBLIC_VIEW_ORDER_DEFAULTS[group],modules=activePublicModules(setup),sections=setup.publicView.landing.sections||{},rows=order.filter(key=>key in values).map(key=>{const parent=PUBLIC_VIEW_PARENT[key],moduleLocked=parent&&modules[parent]!==true,sectionLocked=group!=='sections'&&key in sections&&sections[key]!==true,locked=moduleLocked||sectionLocked,lockReason=moduleLocked?`Enable ${PUBLIC_VIEW_LABELS[parent]||parent} in Public Modules above first`:`Enable ${PUBLIC_VIEW_LABELS[key]||key} in Landing Sections first`;return `<div data-public-sort-row data-group="${group}" data-key="${key}" data-locked="${locked?'true':'false'}" data-parent="${parent||''}" data-lock-reason="${escapeHtml(lockReason)}" class="flex items-center gap-2 rounded-xl border p-2 ${locked?'cursor-not-allowed border-slate-200 bg-slate-100 opacity-60':'bg-white'}"><span class="min-w-0 flex-1 text-xs font-black">${escapeHtml(PUBLIC_VIEW_LABELS[key]||key)}${locked?`<small class="mt-0.5 block font-semibold text-amber-700">${escapeHtml(lockReason)}</small>`:''}</span><button type="button" data-admin-action="move-public-view-item" data-group="${group}" data-key="${key}" data-direction="-1" ${locked?'disabled':''} class="rounded p-1 hover:bg-slate-100 disabled:opacity-30" aria-label="Move up"><i data-lucide="chevron-up" class="h-4 w-4"></i></button><button type="button" data-admin-action="move-public-view-item" data-group="${group}" data-key="${key}" data-direction="1" ${locked?'disabled':''} class="rounded p-1 hover:bg-slate-100 disabled:opacity-30" aria-label="Move down"><i data-lucide="chevron-down" class="h-4 w-4"></i></button><input type="checkbox" data-public-view-path="landing.${group}.${key}" data-parent-module="${parent||''}" ${values[key]?'checked':''} ${locked?'disabled':''} class="h-5 w-5"></div>`;}).join('');return `<div data-public-sort-list="${group}" class="grid gap-2">${rows}</div><button type="button" data-admin-action="reset-public-view-order" data-group="${group}" class="mt-3 text-[10px] font-black text-indigo-600">Reset default order</button>`;};
const publicViewOrderFromDom=group=>[...document.querySelectorAll(`[data-public-sort-row][data-group="${group}"]`)].map(row=>row.dataset.key);
window.movePublicViewItem=(group,key,direction)=>{const row=document.querySelector(`[data-public-sort-row][data-group="${group}"][data-key="${key}"]`);if(!row)return;const sibling=direction<0?row.previousElementSibling:row.nextElementSibling;if(sibling)(direction<0?row.parentElement.insertBefore(row,sibling):row.parentElement.insertBefore(sibling,row));};
window.resetPublicViewOrder=group=>{const list=document.querySelector(`[data-public-sort-list="${group}"]`);if(!list)return;PUBLIC_VIEW_ORDER_DEFAULTS[group].forEach(key=>{const row=list.querySelector(`[data-key="${key}"]`);if(row)list.append(row);});};
const bindPublicViewDependencies=()=>{const notify=row=>{window.showToast(`${row.dataset.lockReason||`Enable ${PUBLIC_VIEW_LABELS[row.dataset.parent]||row.dataset.parent} in Public Modules above first`}.`);const target=row.dataset.lockReason?.includes('Landing Sections')?document.querySelector(`[data-public-sort-row][data-group="sections"][data-key="${row.dataset.key}"]`):document.querySelector(`[data-master-public="${row.dataset.parent}"]`)?.closest('label');target?.scrollIntoView({behavior:'smooth',block:'center'});};document.querySelectorAll('[data-public-dependent-row]').forEach(row=>row.addEventListener('click',event=>{if(row.querySelector('input:disabled')){event.preventDefault();notify(row);}}));document.querySelectorAll('[data-public-sort-row][data-locked="true"]').forEach(row=>row.addEventListener('click',event=>{event.preventDefault();notify(row);}));};

let activePublicViewPanel='landing';
window.switchPublicViewPanel=panel=>{activePublicViewPanel=panel||'landing';document.querySelectorAll('[data-public-view-panel]').forEach(section=>section.classList.toggle('hidden',section.dataset.publicViewPanel!==activePublicViewPanel));document.querySelectorAll('[data-public-view-panel-button]').forEach(button=>{const active=button.dataset.publicViewPanelButton===activePublicViewPanel;button.classList.toggle('bg-indigo-600',active);button.classList.toggle('text-white',active);button.classList.toggle('bg-slate-100',!active);button.classList.toggle('text-slate-600',!active);});};
window.renderPublicViewSettings=setup=>{const host=document.getElementById('master-public-view-settings');if(!host)return;const view=setup.publicView,r=view.resultsPage,participants=normalizeParticipantTypeDefinitions(setup.participantTypeDefinitions).filter(item=>setup.participantTypes.includes(item.key));host.innerHTML=`<div class="mb-4 flex flex-wrap gap-2">${[['landing','Landing Page'],['results','Results Tab'],['teams','Teams Tab'],['talent','Top Talent']].map(([key,label])=>`<button type="button" data-admin-action="switch-public-view-panel" data-panel="${key}" data-public-view-panel-button="${key}" class="rounded-full px-4 py-2 text-xs font-black">${label}</button>`).join('')}</div><div data-public-view-panel="landing" class="grid gap-4 lg:grid-cols-3"><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">LANDING SECTIONS</legend><div class="grid gap-2">${publicViewSortable(setup,'sections')}<p class="mt-4 text-[10px] font-black uppercase text-slate-400">Additional visibility</p><div class="mt-2 grid gap-2">${publicViewDependentControl(setup,'landing.sections.teamStandings','teamStandings')}${publicViewGroup(view.landing.sections,'landing.sections',['social','footer'])}</div></div></fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">HAMBURGER MENU</legend><div class="grid gap-2">${publicViewSortable(setup,'menu')}</div></fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">HERO QUICK BUTTONS</legend><div class="grid gap-2">${publicViewSortable(setup,'quickButtons')}</div></fieldset>${renderCustomLandingLinks(setup)}</div><div data-public-view-panel="results" class="grid gap-4 lg:grid-cols-3"><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">MAIN TABS & RESULT PARTICIPANTS</legend><div class="grid gap-2">${publicViewGroup(r.tabs,'resultsPage.tabs',['result','team','talent'])}${participants.map(item=>publicViewControl(`resultsPage.audience.${item.key}`,item.label,r.audiences.enabled.includes(item.key))).join('')}${publicViewControl('resultsPage.audiences.showAll','Combined All Results',r.audiences.showAll!==false)}<label class="input-group"><span class="input-label">Default result participant</span><select data-public-view-value="resultsPage.audiences.default" class="text-input">${participants.filter(item=>r.audiences.enabled.includes(item.key)).map(item=>`<option value="${item.key}" ${r.audiences.default===item.key?'selected':''}>${escapeHtml(item.label)}</option>`).join('')}</select></label><label class="input-group"><span class="input-label">Default main tab</span><select data-public-view-value="resultsPage.defaultTab" class="text-input"><option value="result" ${r.defaultTab==='result'?'selected':''}>Results</option><option value="team" ${r.defaultTab==='team'?'selected':''}>Teams</option><option value="talent" ${r.defaultTab==='talent'?'selected':''}>Top Talent</option></select></label></div></fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">FILTERS & LAYOUT</legend><div class="grid gap-2">${publicViewControl('resultsPage.resultsTab.showCategories','Category Filters',r.resultsTab.showCategories)}${publicViewControl('resultsPage.resultsTab.includeGeneral','Include General',r.resultsTab.includeGeneral)}${publicViewControl('resultsPage.resultsTab.hideEmpty','Hide Empty Categories',r.resultsTab.hideEmpty)}<label class="input-group"><span class="input-label">Score display</span><select data-public-view-value="resultsPage.resultsTab.scoreDisplay" class="text-input"><option value="total" ${r.resultsTab.scoreDisplay==='total'?'selected':''}>Total only</option><option value="compact" ${r.resultsTab.scoreDisplay==='compact'?'selected':''}>Compact breakdown</option><option value="detailed" ${r.resultsTab.scoreDisplay==='detailed'?'selected':''}>Detailed</option><option value="award" ${r.resultsTab.scoreDisplay==='award'?'selected':''}>Award only</option></select></label></div></fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">CARD & DOWNLOADS</legend><div class="grid gap-2">${publicViewGroup(r.resultsTab.cardFields,'resultsPage.resultsTab.cardFields',Object.keys(r.resultsTab.cardFields))}<p class="mt-2 text-[10px] font-black text-indigo-600">DOWNLOAD MENU</p>${publicViewGroup(r.resultsTab.downloads,'resultsPage.resultsTab.downloads',Object.keys(r.resultsTab.downloads))}</div></fieldset></div><div data-public-view-panel="teams" class="grid gap-4 lg:grid-cols-3"><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">CHAMPIONSHIP CARDS</legend><p class="mb-3 text-[10px] font-bold text-slate-500">Fixed width: 80% on desktop and 100% on mobile.</p>${publicViewGroup(r.teamsTab.cardFields,'resultsPage.teamsTab.cardFields',Object.keys(r.teamsTab.cardFields))}</fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">BREAKDOWNS</legend><div class="grid gap-2">${publicViewGroup(r.teamsTab.breakdowns,'resultsPage.teamsTab.breakdowns',Object.keys(r.teamsTab.breakdowns))}</div></fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">TIMELINE</legend><div class="grid gap-2">${publicViewControl('resultsPage.teamsTab.showTimeline','Show Team Score Timeline',r.teamsTab.showTimeline!==false)}</div></fieldset></div><div data-public-view-panel="talent" class="grid gap-4 lg:grid-cols-2"><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">RANKING</legend><label class="input-group"><span class="input-label">Ranking mode</span><select data-public-view-value="resultsPage.talentTab.rankingMode" class="text-input"><option value="overall" ${r.talentTab.rankingMode==='overall'?'selected':''}>Overall</option><option value="category" ${r.talentTab.rankingMode==='category'?'selected':''}>Category</option><option value="gender" ${r.talentTab.rankingMode==='gender'?'selected':''}>Gender</option><option value="category_gender" ${r.talentTab.rankingMode==='category_gender'?'selected':''}>Category + Gender</option></select></label><label class="input-group"><span class="input-label">Top count</span><input type="number" min="1" max="50" data-public-view-value="resultsPage.talentTab.topCount" value="${r.talentTab.topCount}" class="text-input"></label>${publicViewControl('resultsPage.talentTab.showViewAll','View All option',r.talentTab.showViewAll!==false)}${publicViewControl('resultsPage.talentTab.showGenderFilter','Gender Filter',r.talentTab.showGenderFilter)}${publicViewControl('resultsPage.talentTab.showParticipantSelector','Participant Type Selector',r.talentTab.showParticipantSelector!==false)}<label class="input-group"><span class="input-label">Default Top Talent participant</span><select data-public-view-value="resultsPage.talentTab.defaultParticipantType" class="text-input">${participants.filter(item=>r.talentTab.audiences?.[item.key]?.enabled!==false).map(item=>`<option value="${item.key}" ${r.talentTab.defaultParticipantType===item.key?'selected':''}>${escapeHtml(item.label)}</option>`).join('')}</select></label><p class="mt-4 text-[10px] font-black uppercase text-indigo-600">Audience grouping</p><div class="mt-2 grid gap-2">${participants.map(item=>{const cfg=r.talentTab.audiences?.[item.key]||{};return `<div class="rounded-xl border bg-slate-50 p-3"><b class="text-xs">${escapeHtml(item.label)}</b><div class="mt-2 grid grid-cols-3 gap-2 text-[10px] font-bold"><label><input type="checkbox" data-public-view-path="resultsPage.talentTab.audiences.${item.key}.enabled" ${cfg.enabled!==false?'checked':''}> Show</label><label><input type="checkbox" data-public-view-path="resultsPage.talentTab.audiences.${item.key}.groupByCategory" ${cfg.groupByCategory?'checked':''}> Category</label><label><input type="checkbox" data-public-view-path="resultsPage.talentTab.audiences.${item.key}.groupByGender" ${cfg.groupByGender?'checked':''}> Gender</label></div></div>`;}).join('')}</div></fieldset><fieldset class="rounded-xl border p-4"><legend class="px-1 text-xs font-black">TALENT CARD</legend><div class="grid gap-2">${publicViewGroup(r.talentTab.cardFields,'resultsPage.talentTab.cardFields',Object.keys(r.talentTab.cardFields))}</div></fieldset></div>`;bindPublicViewDependencies();initImageUploads(host);window.switchPublicViewPanel(activePublicViewPanel);};
const publicViewFromDom=()=>{const next=structuredClone(normalizeFestSetup(festSetup).publicView),set=(path,value)=>{const keys=path.split('.');let target=next;keys.slice(0,-1).forEach(key=>target=target[key]??={});target[keys.at(-1)]=value;};document.querySelectorAll('[data-public-view-path]').forEach(input=>{if(input.dataset.publicViewPath.includes('.audience.'))return;set(input.dataset.publicViewPath,input.checked);});next.landing.orders={sections:publicViewOrderFromDom('sections'),menu:publicViewOrderFromDom('menu'),quickButtons:publicViewOrderFromDom('quickButtons')};next.landing.customLinks=customLandingLinksFromDom();next.resultsPage.audiences.enabled=[...document.querySelectorAll('[data-public-view-path^="resultsPage.audience."]:checked')].map(input=>input.dataset.publicViewPath.split('.').at(-1));document.querySelectorAll('[data-public-view-value]').forEach(input=>set(input.dataset.publicViewValue,input.type==='number'||/^\d+$/.test(input.value)?Number(input.value):input.value));return next;};

window.renderMasterSetup = () => {
    const setup = normalizeFestSetup(festSetup);
    const setValue = (id, value) => { const el=document.getElementById(id); if(el) el.value=value; };
    setValue('master-preset', setup.preset); setValue('master-organisation', setup.organisationMode); setValue('master-schedule', setup.scheduleMode); setValue('master-judging', setup.judgingMode); setValue('master-results', setup.resultWorkflow); setValue('master-team-scoring', setup.teamScoringMode);setValue('master-event-management',setup.eventManagementMode);document.querySelectorAll('[data-master-event-feature]').forEach(input=>input.checked=setup.eventFeatures[input.dataset.masterEventFeature]!==false);
    const policy=normalizeCompetitionPolicies(setup.competitionPolicies);setValue('policy-group-first',policy.groupPositionPoints.first??'');setValue('policy-group-second',policy.groupPositionPoints.second??'');setValue('policy-group-third',policy.groupPositionPoints.third??'');setValue('policy-direct-grade',policy.directRankGradeMode);setValue('policy-min-position',policy.minimumPositionPolicy);setValue('policy-min-position-value',policy.minimumPositionPercentage??'');setValue('policy-grade-maximum',normalizeAdminScoringRules().policies.gradeCalculationMaximumMark||100);setValue('policy-joint-position',policy.jointPositionMethod);setValue('policy-multi-judge',policy.multipleJudgeMethod);setValue('policy-trim-judges',policy.trimMinimumJudges??'');setValue('policy-general-gender',policy.generalGenderMode);setValue('policy-result-correction',policy.publishedCorrectionMode);
    document.querySelectorAll('[data-master-list]').forEach(input => { const values=setup[input.dataset.masterList]||[]; input.checked=values.includes(input.value); });
    document.querySelectorAll('[data-master-public]').forEach(input => { input.checked=setup.publicModules[input.dataset.masterPublic] !== false; });
    renderPresetGuide(setup);renderMasterParticipantTypes(setup);window.renderPublicViewSettings(setup);window.renderEventFieldRules?.();mergeScoringIntoMasterSetup();decorateMasterHelp();window.renderMasterImpactReview();
    const summary=document.getElementById('master-setup-summary'); if(summary) summary.innerHTML=`<b>Active model:</b> ${setup.organisationMode} organisation • ${setup.scheduleMode} schedule • ${setup.judgingMode} judging • ${setup.resultWorkflow} results`;
    window.renderStudentFieldSettings?.();
    window.renderStudentCustomFields?.();applyEventFieldRules();
    window.updateCompetitionPolicyStatus?.();
    window.renderScoringRules?.();window.lucide?.createIcons?.();
};
document.getElementById('view-master-setup')?.addEventListener('change',event=>{if(event.target.matches('[name="master-participants"]')&&!event.target.checked&&!checkedValues('master-participants').length){event.target.checked=true;window.showToast('At least one participant type is required. Enable another type before disabling this one.','error');return}if(event.target.matches('[name="master-participants"],[name="master-registration"]'))window.applyFestCapabilities();const landingSectionChanged=event.target.matches('[data-public-view-path^="landing.sections."]');if(event.target.matches('[data-master-public]')||landingSectionChanged){const draft=publicViewFromDom();festSetup={...festSetup,publicView:draft};window.renderPublicViewSettings(normalizeFestSetup(festSetup));if(event.target.matches('[data-master-public]'))window.showToast(`${event.target.closest('label')?.innerText.trim()||'Module'} ${event.target.checked?'enabled':'disabled'}; dependent landing controls updated.`);else window.showToast(`${PUBLIC_VIEW_LABELS[event.target.dataset.publicViewPath.split('.').at(-1)]||'Landing section'} ${event.target.checked?'enabled':'disabled'}; menu and quick-button controls updated.`);}const section=event.target.closest('[data-master-section]')?.dataset.masterSection||activeMasterSection;masterDirtySections.add(section);updateMasterSubnavStatus();if(event.target.id==='master-preset')return;const preset=document.getElementById('master-preset');if(preset&&preset.value!=='custom'){preset.value='custom';festSetup={...festSetup,preset:'custom'};renderPresetGuide(festSetup);}window.renderMasterImpactReview?.();});
const checkboxGroupValues=id=>[...document.querySelectorAll(`#${id} [data-checkbox-option]:checked`)].map(input=>input.value);
const syncCheckboxGroup=id=>{const root=document.getElementById(id),master=root?.querySelector('[data-checkbox-all]'),options=[...(root?.querySelectorAll('[data-checkbox-option]:not(:disabled)')||[])],count=options.filter(input=>input.checked).length;if(master){master.checked=options.length>0&&count===options.length;master.indeterminate=count>0&&count<options.length;master.setAttribute('aria-checked',master.indeterminate?'mixed':String(master.checked));}const output=root?.querySelector('[data-checkbox-count]');if(output)output.textContent=`${count} selected`;};
const setCheckboxGroupValues=(id,values=[])=>{const root=document.getElementById(id);if(root)root.dataset.checkboxDirty='true';root?.querySelectorAll('[data-checkbox-option]').forEach(input=>input.checked=values.includes(input.value));syncCheckboxGroup(id);};
const renderCheckboxGroup=(id,label,values,selected=values)=>{const root=document.getElementById(id);if(!root)return;const options=values.map(item=>typeof item==='string'?{value:item,label:item}:item),defaults=selected.map?.(item=>typeof item==='string'?item:item.value)||[],current=checkboxGroupValues(id),chosen=root.dataset.checkboxDirty==='true'?current.filter(value=>options.some(option=>option.value===value)):defaults;root.dataset.checkboxInitialized='true';root.classList.add('min-w-0','w-full','max-w-full','overflow-hidden','self-start');root.innerHTML=`<legend class="sr-only">${escapeHtml(label)}</legend><div class="mb-2 flex min-w-0 items-center justify-between gap-3 border-b pb-2"><b class="min-w-0 text-xs leading-tight text-slate-700">${escapeHtml(label)}</b><label class="flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[10px] font-black text-indigo-700"><input type="checkbox" data-checkbox-all aria-label="Select all ${escapeHtml(label)}"> Select All</label></div><div class="grid min-w-0 grid-cols-1 gap-2">${options.map(option=>`<label class="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-bold"><input class="shrink-0" type="checkbox" data-checkbox-option value="${escapeHtml(option.value)}" ${chosen.includes(option.value)?'checked':''}> <span class="min-w-0 break-words leading-tight">${escapeHtml(option.label||option.value)}</span></label>`).join('')}</div><small data-checkbox-count class="mt-2 block text-[9px] font-bold text-slate-400"></small>`;syncCheckboxGroup(id);};
window.renderEventEligibilityCheckboxGroups=()=>{const draftParticipantTypes=checkedValues('master-participants'),activeParticipantTypes=draftParticipantTypes.length?draftParticipantTypes:[...festSetup.participantTypes],participantOptions=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions).filter(item=>activeParticipantTypes.includes(item.key)).map(item=>({value:item.key,label:item.label})),draftRegistrationChannels=checkedValues('master-registration'),activeRegistrationChannels=draftRegistrationChannels.length?draftRegistrationChannels:[...festSetup.registrationChannels],registrationLabels={admin:'Admin',teamLeader:'Team Leader',self:'Self Registration',onSite:'On-site Registration'},registrationOptions=activeRegistrationChannels.map(value=>({value,label:registrationLabels[value]||value}));renderCheckboxGroup('inp-ev-participant-types','Participant Types',participantOptions,activeParticipantTypes);renderCheckboxGroup('edit-ev-participant-types','Participant Types',participantOptions,activeParticipantTypes);renderCheckboxGroup('inp-ev-registration-channels','Registration Channels',registrationOptions,activeRegistrationChannels);renderCheckboxGroup('edit-ev-registration-channels','Registration Channels',registrationOptions,activeRegistrationChannels);};

document.addEventListener('change',event=>{const root=event.target.closest('[data-checkbox-group]');if(!root)return;root.dataset.checkboxDirty='true';if(event.target.matches('[data-checkbox-all]'))root.querySelectorAll('[data-checkbox-option]:not(:disabled)').forEach(input=>input.checked=event.target.checked);syncCheckboxGroup(root.id);});

window.applyFestCapabilities = () => {
    window.renderEventEligibilityCheckboxGroups();
    const toggle = (id, show) => document.getElementById(id)?.classList.toggle('hidden', !show);
    toggle('nav-schedule', scheduleEnabled(festSetup)); toggle('nav-schedule-review', scheduleEnabled(festSetup)); toggle('nav-judge', judgingEnabled(festSetup));
    toggle('nav-config', teamModeEnabled(festSetup));
    const scheduleView=document.getElementById('view-schedule'),basic=festSetup.scheduleMode==='basic';if(scheduleView){[...scheduleView.children].forEach(child=>{if(child.id!=='basic-schedule-editor')child.classList.toggle('hidden',basic);});}toggle('basic-schedule-editor',basic);toggle('nav-schedule-review',festSetup.scheduleMode==='full');if(basic)window.renderBasicProgramOrder?.();
    toggle('registration-requests-panel', festSetup.registrationChannels.includes('self'));
    const judgeRole = document.querySelector('#access-role option[value="judge"]'); if(judgeRole) judgeRole.disabled=!judgingEnabled(festSetup);
    const genderOptions = festSetup.allowedGenders.map(gender=>`<option value="${gender}">${gender}</option>`).join('');
    ['inp-std-gender','edit-std-gender'].forEach(id=>{const select=document.getElementById(id);if(select){const old=select.value;select.innerHTML=genderOptions;if(festSetup.allowedGenders.includes(old))select.value=old;}});
    const eventGenderOptions = `${festSetup.allowedGenders.length>1?'<option value="Both">Both</option>':''}${genderOptions}`;
    ['inp-ev-gender','edit-ev-gender'].forEach(id=>{const select=document.getElementById(id);if(select){const old=select.value;select.innerHTML=eventGenderOptions;if([...festSetup.allowedGenders,'Both'].includes(old))select.value=old;}});
    const leaderGenderOptions = `${festSetup.allowedGenders.map(gender=>`<option value="${gender}">${gender}</option>`).join('')}${festSetup.allowedGenders.length>1?'<option value="Both">Both</option>':''}`;
    const leaderGender=document.getElementById('access-gender'); if(leaderGender){const old=leaderGender.value;leaderGender.innerHTML='<option value="">Select Gender</option>'+leaderGenderOptions;if([...festSetup.allowedGenders,'Both'].includes(old))leaderGender.value=old;}
    const setGenderFilter=(id,includeBoth=false)=>{const el=document.getElementById(id);if(!el)return;const old=el.value;el.innerHTML='<option value="">All Gender</option>'+((includeBoth&&festSetup.allowedGenders.length>1)?'<option value="Both">Both</option>':'')+genderOptions;if([...festSetup.allowedGenders,'Both',''].includes(old))el.value=old;};
    setGenderFilter('filter-std-gender');['filter-ev-gender','schedule-filter-gender','judge-review-gender'].forEach(id=>setGenderFilter(id,true));
    const eligibleInput=document.getElementById('inp-ev-eligible-classes');if(eligibleInput&&!eligibleInput.value)eligibleInput.value=(festSetup.eligibleClasses||[]).join(', ');
    const methodFeatures={criteria:'customCriteria',objective:'objectiveScoring',direct_rank:'directRank',elimination:'directRank',time:'timeResults',count:'countResults'};['inp-ev-result-method','edit-ev-result-method'].forEach(id=>{const select=document.getElementById(id);if(!select)return;[...select.options].forEach(option=>{const feature=methodFeatures[option.value];option.disabled=!!feature&&festSetup.eventFeatures?.[feature]===false;});if(select.selectedOptions[0]?.disabled)select.value='manual';});
    ['inp-ev-multiple-judge','edit-ev-multiple-judge'].forEach(id=>{const select=document.getElementById(id);if(select)select.disabled=festSetup.eventFeatures?.multipleJudges===false;});
    ['inp-ev-schedule-required','edit-ev-schedule-required'].forEach(id=>{const select=document.getElementById(id);if(select)select.disabled=!scheduleEnabled(festSetup);});
    ['inp-ev-scoring-policy','edit-ev-scoring-policy'].forEach(id=>{const select=document.getElementById(id);if(select)select.disabled=festSetup.eventFeatures?.eventOverrides===false;});
    const advanced=festSetup.eventManagementMode==='advanced';toggle('btn-event-import',advanced&&festSetup.eventFeatures.excelImport);toggle('btn-event-template',advanced&&festSetup.eventFeatures.excelImport);document.querySelectorAll('[data-master-event-feature]').forEach(input=>input.disabled=masterValue('master-event-management')!=='advanced');
    if(!scheduleEnabled(festSetup) && ['schedule','schedule-review'].includes(document.querySelector('.tab-view.active')?.id?.replace('view-',''))) window.switchTab('dashboard');
    if(!judgingEnabled(festSetup) && document.getElementById('view-judge')?.classList.contains('active')) window.switchTab('dashboard');
};

window.switchRegistrationAdminTab = name => {document.querySelectorAll('[data-registration-admin-panel]').forEach(el=>el.classList.toggle('hidden',el.dataset.registrationAdminPanel!==name));document.querySelectorAll('[data-registration-admin-tab]').forEach(el=>el.className=`rounded-xl px-4 py-2 text-xs font-black ${el.dataset.registrationAdminTab===name?'bg-indigo-600 text-white':'text-slate-600'}`);if(name==='applications')window.renderRegistrationRequests();if(name==='downloads')window.renderRegistrationDownloads();if(name==='entries')window.renderRegList(true);if(['overview','finalization'].includes(name))window.renderAdvancedRegistration();};
const resolveRegistrationApplicationPerson=item=>{const student=students.find(value=>value.id===(item.studentId||item.relatedStudentId||item.participantId));return{student,name:item.participantName||item.studentName||item.name||student?.name||'Applicant',chestNo:item.chestNo||student?.chestNo||item.profileSnapshot?.chestNo||''};};
window.registrationApplicationRows=()=>[...registrationApplications.map(item=>({...item,name:item.participantName||item.studentName,submittedAt:item.appliedAt,recordSource:'application'})),...registrationRequests.map(item=>({...item,eventName:(item.eventIds||[]).map(id=>events.find(event=>event.id===id)?.name||id).join(' • '),recordSource:'request'}))];
const adminRegistrationStatusVisual=status=>{if(['selected','finalized','approved'].includes(status))return{label:'Approved',icon:'badge-check',className:'border-emerald-200 bg-emerald-50 text-emerald-700'};if(['not_selected','rejected','removed'].includes(status))return{label:'Rejected',icon:'x-circle',className:'border-red-200 bg-red-50 text-red-700'};if(['applied','pending','under_review','pending_admin_approval','waitlisted'].includes(status||'pending'))return{label:'Pending',icon:'clock-3',className:'border-orange-200 bg-orange-50 text-orange-700'};return{label:String(status||'pending').replaceAll('_',' '),icon:'circle-help',className:'border-slate-200 bg-slate-50 text-slate-700'}};
const registrationApplicationKey=item=>`${item.recordSource||'application'}:${item.id}`;
const registrationApplicationHas=(item,key)=>{const value=key==='note'?item.note:key==='youtube'?(item.links?.youtube||item.youtubeUrl):key==='reference'?(item.links?.reference||item.referenceUrl):key==='image'?(Array.isArray(item.images)&&item.images.length):'';return key==='image'?!!value:!!String(value||'').trim()};
const registrationPresenceMatches=(filter,hasValue)=>!filter||(filter==='has'?hasValue:filter==='missing'?!hasValue:true);
window.renderRegistrationBulkBar=()=>{const bar=document.getElementById('registration-application-bulk-bar'),count=document.getElementById('registration-application-selected-count'),selectAll=document.getElementById('registration-application-select-all');if(!bar||!count)return;const selected=[...selectedRegistrationApplicationKeys],visibleSelected=visibleRegistrationApplicationKeys.filter(key=>selectedRegistrationApplicationKeys.has(key)).length;bar.classList.toggle('hidden',!selected.length);bar.classList.toggle('flex',!!selected.length);count.textContent=`${selected.length} selected${visibleSelected!==selected.length?` • ${visibleSelected} visible`:''}`;if(selectAll){selectAll.checked=visibleRegistrationApplicationKeys.length>0&&visibleSelected===visibleRegistrationApplicationKeys.length;selectAll.indeterminate=visibleSelected>0&&visibleSelected<visibleRegistrationApplicationKeys.length;}};
window.toggleRegistrationApplicationSelection=target=>{if(target.id==='registration-application-select-all'){visibleRegistrationApplicationKeys.forEach(key=>target.checked?selectedRegistrationApplicationKeys.add(key):selectedRegistrationApplicationKeys.delete(key));document.querySelectorAll('[data-registration-application-select]').forEach(input=>{input.checked=selectedRegistrationApplicationKeys.has(input.dataset.selectionKey)});}else if(target.dataset.registrationApplicationSelect!==undefined){target.checked?selectedRegistrationApplicationKeys.add(target.dataset.selectionKey):selectedRegistrationApplicationKeys.delete(target.dataset.selectionKey);}window.renderRegistrationBulkBar();};
window.clearRegistrationApplicationSelection=()=>{selectedRegistrationApplicationKeys.clear();document.querySelectorAll('[data-registration-application-select]').forEach(input=>input.checked=false);window.renderRegistrationBulkBar();};
window.renderRegistrationRequests = () => {const box=document.getElementById('registration-requests-list');if(!box)return;const rowsAll=window.registrationApplicationRows(),typeFilter=document.getElementById('application-filter-type'),teamFilter=document.getElementById('application-filter-team'),categoryFilter=document.getElementById('application-filter-category'),definitions=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions);if(typeFilter&&typeFilter.options.length<=1)typeFilter.innerHTML='<option value="">All participant types</option>'+festSetup.participantTypes.map(key=>`<option value="${key}">${escapeHtml(definitions.find(item=>item.key===key)?.label||key)}</option>`).join('');if(teamFilter&&teamFilter.options.length<=1)teamFilter.innerHTML='<option value="">All teams</option>'+teams.map(team=>`<option>${escapeHtml(team)}</option>`).join('');if(categoryFilter&&categoryFilter.options.length<=1)categoryFilter.innerHTML='<option value="">All event categories</option>'+[...new Set(events.map(item=>item.category).filter(Boolean))].map(value=>`<option>${escapeHtml(value)}</option>`).join('');const search=(document.getElementById('application-filter-search')?.value||'').toLowerCase(),type=typeFilter?.value||'',team=teamFilter?.value||'',category=categoryFilter?.value||'',status=document.getElementById('application-filter-status')?.value||'',noteFilter=document.getElementById('application-filter-note')?.value||'',youtubeFilter=document.getElementById('application-filter-youtube')?.value||'',referenceFilter=document.getElementById('application-filter-reference')?.value||'',imageFilter=document.getElementById('application-filter-image')?.value||'',rows=rowsAll.filter(item=>{const event=events.find(row=>row.id===(item.eventId||(item.eventIds||[])[0]))||item.eventSnapshot||{};return(!search||`${item.name||''} ${item.eventName||''} ${item.team||''}`.toLowerCase().includes(search))&&(!type||item.participantType===type)&&(!team||item.team===team)&&(!category||event.category===category)&&(!status||item.status===status)&&registrationPresenceMatches(noteFilter,registrationApplicationHas(item,'note'))&&registrationPresenceMatches(youtubeFilter,registrationApplicationHas(item,'youtube'))&&registrationPresenceMatches(referenceFilter,registrationApplicationHas(item,'reference'))&&registrationPresenceMatches(imageFilter,registrationApplicationHas(item,'image'))}).sort((a,b)=>(b.submittedAt||0)-(a.submittedAt||0));visibleRegistrationApplicationKeys=rows.map(registrationApplicationKey);box.innerHTML=`<table class="min-w-[1250px] w-full text-left text-xs"><thead class="bg-slate-50 text-[10px] font-black uppercase text-slate-500"><tr><th class="p-3"><input id="registration-application-select-all" data-admin-change="toggle-registration-application-selection" type="checkbox" class="h-4 w-4"></th>${['Student','Chest','Event','Team','Category','Stage / Type','Status','Description','YouTube','Reference','Image','Applied','Actions'].map(value=>`<th class="p-3">${value}</th>`).join('')}</tr></thead><tbody class="divide-y">${rows.map(item=>{const event=events.find(row=>row.id===(item.eventId||(item.eventIds||[])[0]))||item.eventSnapshot||{},image=(item.images||[])[0],youtube=item.links?.youtube||item.youtubeUrl,reference=item.links?.reference||item.referenceUrl;return`<tr><td class="p-3"><input data-admin-change="toggle-registration-application-selection" data-registration-application-select data-selection-key="${escapeHtml(registrationApplicationKey(item))}" type="checkbox" class="h-4 w-4" ${selectedRegistrationApplicationKeys.has(registrationApplicationKey(item))?'checked':''}></td>${(()=>{const person=resolveRegistrationApplicationPerson(item);return `<td class="p-3 font-black">${escapeHtml(person.name)}</td><td class="p-3 font-mono">${escapeHtml(person.chestNo||'—')}</td>`})()}<td class="p-3 font-bold">${escapeHtml(item.eventName||event.name||'Event')}</td><td class="p-3">${escapeHtml(item.team||'—')}</td><td class="p-3">${escapeHtml(event.category||item.category||'General')}</td><td class="p-3">${escapeHtml(event.stage||'Off-Stage')}<br>${escapeHtml(event.type||'Single')}</td><td class="p-3">${(()=>{const visual=adminRegistrationStatusVisual(item.status);return `<span class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-black uppercase ${visual.className}"><i data-lucide="${visual.icon}" class="h-3 w-3"></i>${escapeHtml(visual.label)}</span>`})()}</td><td class="max-w-36 p-3"><button data-admin-action="view-registration-application" data-id="${item.id}" data-source="${item.recordSource}" class="block max-w-32 truncate text-indigo-600">${escapeHtml(item.note||'—')}</button></td><td class="p-3">${youtube?`<a href="${escapeHtml(youtube)}" target="_blank" rel="noopener" class="font-black text-red-600">▶</a>`:'—'}</td><td class="p-3">${reference?`<a href="${escapeHtml(reference)}" target="_blank" rel="noopener" class="font-black text-indigo-600">↗</a>`:'—'}</td><td class="p-3">${image?`<button data-admin-action="view-registration-application" data-id="${item.id}" data-source="${item.recordSource}"><img src="${image.data}" class="h-10 w-10 rounded object-cover" alt=""></button>`:'—'}</td><td class="p-3 whitespace-nowrap">${item.submittedAt?new Date(item.submittedAt).toLocaleString():'—'}</td><td class="p-3"><div class="flex gap-1"><button data-admin-action="view-registration-application" data-id="${item.id}" data-source="${item.recordSource}" class="rounded-lg bg-indigo-50 p-2 text-indigo-700" aria-label="View"><i data-lucide="eye" class="h-4 w-4"></i></button><button data-admin-action="decide-registration-application" data-id="${item.id}" data-status="selected" class="rounded-lg bg-emerald-50 p-2 text-emerald-700" aria-label="Select"><i data-lucide="check" class="h-4 w-4"></i></button><button data-admin-action="decide-registration-application" data-id="${item.id}" data-status="not_selected" class="rounded-lg bg-red-50 p-2 text-red-700" aria-label="Reject"><i data-lucide="x" class="h-4 w-4"></i></button><button data-admin-action="delete-registration-application" data-id="${item.id}" data-source="${item.recordSource}" class="rounded-lg bg-rose-100 p-2 text-rose-700" aria-label="Delete application"><i data-lucide="trash-2" class="h-4 w-4"></i></button></div></td></tr>`}).join('')}</tbody></table>`;window.lucide?.createIcons?.();window.renderRegistrationBulkBar?.()};
window.viewRegistrationApplication=(id,source)=>{const item=window.registrationApplicationRows().find(row=>row.id===id&&(!source||row.recordSource===source));if(!item)return;const event=events.find(row=>row.id===(item.eventId||(item.eventIds||[])[0]))||item.eventSnapshot||{},image=(item.images||[])[0],youtube=item.links?.youtube||item.youtubeUrl,reference=item.links?.reference||item.referenceUrl;document.getElementById('admin-application-detail-body').innerHTML=`<div class="space-y-3"><div class="grid grid-cols-2 gap-2 text-xs">${[['Student',resolveRegistrationApplicationPerson(item).name],['Chest',resolveRegistrationApplicationPerson(item).chestNo],['Team',item.team],['Event',item.eventName||event.name],['Category',event.category||item.category],['Status',item.status]].map(([a,b])=>`<div class="rounded-xl bg-slate-50 p-3"><small class="font-black uppercase text-slate-400">${a}</small><b class="block">${escapeHtml(b||'—')}</b></div>`).join('')}</div>${item.note?`<section><b class="text-xs">Description</b><p class="mt-1 whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm">${escapeHtml(item.note)}</p></section>`:''}${youtube?`<a href="${escapeHtml(youtube)}" target="_blank" rel="noopener" class="block rounded-xl bg-red-50 p-3 text-xs font-black text-red-700">Open YouTube ↗</a>`:''}${reference?`<a href="${escapeHtml(reference)}" target="_blank" rel="noopener" class="block rounded-xl bg-indigo-50 p-3 text-xs font-black text-indigo-700">Open Reference ↗</a>`:''}${image?`<img src="${image.data}" class="max-h-96 w-full rounded-xl object-contain" alt="Application image">`:''}</div>`;const dialog=document.getElementById('admin-application-detail-dialog');dialog.classList.remove('hidden');dialog.classList.add('grid')};window.closeRegistrationApplicationDetail=()=>{const dialog=document.getElementById('admin-application-detail-dialog');dialog.classList.add('hidden');dialog.classList.remove('grid')};
window.decideRegistrationApplication=async(id,status,options={})=>{const app=registrationApplications.find(item=>item.id===id),request=registrationRequests.find(item=>item.id===id);if(app){await updateDoc(doc(db,'registrationApplications',id),{status,decisionByUid:auth.currentUser?.uid||'',decisionAt:Date.now(),updatedAt:Date.now()})}else if(request){if(status==='selected')return window.approveRegistrationRequest(id);await updateDoc(doc(db,'registrationRequests',id),{status:'rejected',reviewedAt:Date.now(),reviewedByUid:auth.currentUser?.uid||''})}if(!options.silent)window.showToast(status==='selected'?'Application selected':'Application rejected')};window.deleteRegistrationApplication=async(id,source='application',options={})=>{const collectionName=source==='request'?'registrationRequests':'registrationApplications',rows=source==='request'?registrationRequests:registrationApplications,item=rows.find(row=>row.id===id);if(!item)return options.silent?false:window.showToast('Application was not found','error');const label=item.eventName||((item.eventIds||[]).map(eventId=>events.find(event=>event.id===eventId)?.name||eventId).join(' • '))||'this application';if(!options.skipConfirm&&!window.confirm(`Delete ${label}? This permanently removes the submitted entry.`))return false;await deleteDoc(doc(db,collectionName,id));if(!options.silent){window.showToast('Application deleted');window.renderRegistrationRequests?.();window.renderAdvancedRegistration?.();}return true;};window.selectedRegistrationApplicationRows=()=>window.registrationApplicationRows().filter(item=>selectedRegistrationApplicationKeys.has(registrationApplicationKey(item)));window.bulkRegistrationApplicationAction=async(action)=>{const rows=window.selectedRegistrationApplicationRows();if(!rows.length)return window.showToast('Select at least one application','error');const labels={approve:'approve',reject:'reject',delete:'delete'},danger=action==='delete'?' This cannot be undone.':'';if(!window.confirm(`${labels[action]||'Update'} ${rows.length} selected application(s)?${danger}`))return;let done=0;for(const item of rows){if(action==='approve'){await window.decideRegistrationApplication(item.id,'selected',{silent:true});done++;}else if(action==='reject'){await window.decideRegistrationApplication(item.id,'not_selected',{silent:true});done++;}else if(action==='delete'){if(await window.deleteRegistrationApplication(item.id,item.recordSource,{silent:true,skipConfirm:true}))done++;}}selectedRegistrationApplicationKeys.clear();window.renderRegistrationRequests?.();window.renderAdvancedRegistration?.();window.showToast(`${done} application(s) ${action==='approve'?'approved':action==='reject'?'rejected':'deleted'}`);};


let registrationPdfBlob=null,registrationPdfUrl='';
const registrationExportValue=id=>document.getElementById(id)?.value||'';
window.registrationExportRows=()=>window.registrationApplicationRows().flatMap(item=>{const ids=item.eventId?[item.eventId]:(item.eventIds||[]);return(ids.length?ids:['']).map(eventId=>{const event=events.find(value=>value.id===eventId)||item.eventSnapshot||{},student=students.find(value=>value.id===(item.studentId||item.relatedStudentId))||{},links=item.links||{};return{...item,eventId,eventName:event.name||item.eventName||'Event',eventCategory:event.category||item.category||'General',stage:event.stage||'Off-Stage',eventType:event.type||'Single',gender:item.gender||student.gender||event.gender||'',studentName:item.name||item.studentName||student.name||'Applicant',chestNo:item.chestNo||student.chestNo||'',className:student.details?.class||student.class||item.profileSnapshot?.details?.class||'',team:item.team||student.team||'',youtubeUrl:links.youtube||item.youtubeUrl||'',referenceUrl:links.reference||item.referenceUrl||'',appliedTime:Number(item.appliedAt||item.submittedAt||0)}})});
window.filteredRegistrationExportRows=()=>{const cls=registrationExportValue('registration-export-class'),team=registrationExportValue('registration-export-team'),category=registrationExportValue('registration-export-category'),gender=registrationExportValue('registration-export-gender'),from=registrationExportValue('registration-export-from'),to=registrationExportValue('registration-export-to'),order=registrationExportValue('registration-export-order')||'name';let rows=window.registrationExportRows().filter(item=>(!cls||item.className===cls)&&(!team||item.team===team)&&(!category||item.eventCategory===category)&&(!gender||item.gender===gender||events.find(event=>event.id===item.eventId)?.gender===gender)&&(!from||item.appliedTime>=new Date(from).getTime())&&(!to||item.appliedTime<=new Date(to).getTime()));const genderRank=value=>value==='Boys'?0:value==='Girls'?1:2;rows.sort((a,b)=>{const genderOrder=genderRank(a.gender)-genderRank(b.gender);if(genderOrder)return genderOrder;if(order==='chest')return String(a.chestNo).localeCompare(String(b.chestNo),undefined,{numeric:true});if(order==='time')return a.appliedTime-b.appliedTime;if(order==='student'){const studentOrder=String(a.studentName).localeCompare(String(b.studentName),undefined,{numeric:true});if(studentOrder)return studentOrder;const chestOrder=String(a.chestNo).localeCompare(String(b.chestNo),undefined,{numeric:true});if(chestOrder)return chestOrder;return String(a.eventName).localeCompare(String(b.eventName),undefined,{numeric:true})}return String(a.studentName).localeCompare(String(b.studentName))});return rows};
window.renderRegistrationDownloads=()=>{renderRegistrationColumnChooser();const setOptions=(id,values,label,display=value=>value)=>{const el=document.getElementById(id);if(!el)return;const old=el.value;el.innerHTML=`<option value="">All ${label}</option>`+values.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(display(value))}</option>`).join('');if(values.includes(old))el.value=old};setOptions('registration-export-class',[...new Set(students.map(item=>item.details?.class||item.class).filter(Boolean))].sort(),'Classes');setOptions('registration-export-team',[...teams].sort(),'Teams',team=>`${teamLabel(team)} (${team})`);setOptions('registration-export-category',[...new Set(events.map(item=>item.category).filter(Boolean))].sort(),'Categories',category=>`${categoryLabel(category)} (${category})`);const rows=window.filteredRegistrationExportRows(),summary=document.getElementById('registration-export-summary');if(summary)summary.textContent=`${rows.length} filtered application-event row(s) • Fast black & white PDF • ${selectedRegistrationExportColumns().length} column(s) • SheetJS 0.18.5`};
// Registration download centre keeps jsPDF 2.5.1 / AutoTable 3.8.4 compatibility markers while using html2pdf/html2canvas for Malayalam-safe rendering.
const REGISTRATION_EXPORT_COLUMNS=[
  ['no','No'],['student','Student'],['chest','Chest No'],['class','Class'],['team','Team'],['event','Event'],['eventCategory','Event Category'],['gender','Gender'],['stage','Stage'],['type','Type'],['status','Status'],['description','Description'],['youtube','YouTube'],['reference','Reference'],['applied','Applied At']
];
const defaultRegistrationExportColumns=()=>['no','student','chest','class','team','event','eventCategory','gender','stage','type','status','applied'];
const selectedRegistrationExportColumns=()=>{const checked=[...document.querySelectorAll('[data-registration-export-column]:checked')].map(input=>input.value);return checked.length?checked:defaultRegistrationExportColumns()};
const registrationColumnValue=(item,key,index)=>({no:index+1,student:item.studentName,chest:item.chestNo||'—',class:item.className||'—',team:item.team?teamLabel(item.team):'—',event:item.eventName,eventCategory:categoryLabel(item.eventCategory),gender:item.gender||'—',stage:item.stage,type:item.eventType,status:item.status||'pending',description:item.note||'',youtube:item.youtubeUrl||'',reference:item.referenceUrl||'',applied:item.appliedTime?new Date(item.appliedTime).toLocaleString():''}[key]??'');
const registrationColumnLabel=key=>REGISTRATION_EXPORT_COLUMNS.find(item=>item[0]===key)?.[1]||key;
const registrationTextDirection=value=>/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(String(value||''))?'rtl':'auto';
const registrationEscape=escapeHtml;
const renderRegistrationColumnChooser=()=>{const host=document.getElementById('registration-export-columns');if(!host||host.dataset.ready==='1')return;const defaults=new Set(defaultRegistrationExportColumns());host.innerHTML=REGISTRATION_EXPORT_COLUMNS.map(([key,label])=>`<label class="flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs font-bold text-slate-700"><input type="checkbox" value="${key}" data-registration-export-column ${defaults.has(key)?'checked':''} class="h-4 w-4 rounded border-slate-300 text-indigo-600"><span>${registrationEscape(label)}</span></label>`).join('');host.dataset.ready='1';host.querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>window.renderRegistrationDownloads()));};
const registrationGroupedRows=rows=>[...rows.reduce((map,item)=>{const key=item.studentId||item.relatedStudentId||`${item.studentName}|${item.chestNo}|${item.team}`;if(!map.has(key))map.set(key,{student:item,rows:[]});map.get(key).rows.push(item);return map},new Map()).values()];
const registrationPdfModel=()=>registrationExportValue('registration-export-model')==='student'?'student':'table';
const registrationFilterSummary=()=>[
  ['Class',registrationExportValue('registration-export-class')||'All'],
  ['Team',registrationExportValue('registration-export-team')?`${teamLabel(registrationExportValue('registration-export-team'))} (${registrationExportValue('registration-export-team')})`:'All'],
  ['Category',registrationExportValue('registration-export-category')?`${categoryLabel(registrationExportValue('registration-export-category'))} (${registrationExportValue('registration-export-category')})`:'All'],
  ['Gender',registrationExportValue('registration-export-gender')||'All'],
  ['Order',registrationExportValue('registration-export-order')||'name']
].map(([label,value])=>`${label}: ${value}`).join('   |   ');
const registrationPdfStyles=()=>`<style>*{box-sizing:border-box}body{margin:0}.registration-pdf-page{width:1120px;min-height:790px;padding:16px;background:#fff;color:#000;font-family:'Noto Sans Malayalam','Noto Sans','Noto Naskh Arabic','Arial',sans-serif}.registration-pdf-page.portrait{width:794px;min-height:1123px}.registration-pdf-header{text-align:center;border-bottom:2px solid #111;margin-bottom:8px;padding-bottom:6px}.registration-pdf-fest{font-size:22px;font-weight:900;line-height:1.15}.registration-pdf-title{margin-top:4px;font-size:14px;font-weight:900;letter-spacing:.05em}.registration-pdf-meta{margin-top:4px;font-size:10px;font-weight:700}.registration-pdf-table{width:100%;border-collapse:collapse;table-layout:auto;font-size:10px;color:#000}.registration-pdf-table th,.registration-pdf-table td{border:1px solid #111;padding:4px;text-align:center;vertical-align:top;line-height:1.35;overflow-wrap:anywhere;word-break:break-word}.registration-pdf-table th{font-size:9px;font-weight:900;text-transform:uppercase}.registration-pdf-table td.text-left,.registration-pdf-table th.text-left{text-align:left}.registration-student-section{break-inside:avoid;page-break-inside:avoid;margin-bottom:12px}.registration-student-section:not(:first-of-type){break-before:auto}.registration-student-head{border:1px solid #111;border-bottom:0;padding:6px;font-size:12px;font-weight:900}.registration-student-page-break{break-before:page;page-break-before:always}</style>`;
const registrationPdfColumnClass=key=>['student','event','description'].includes(key)?'text-left':'';
const registrationPdfColgroup=(cols,rows)=>{const widths=cols.map(key=>registrationColumnWidth(key,rows)),total=widths.reduce((sum,value)=>sum+value,0)||1;return `<colgroup>${cols.map((key,index)=>`<col style="width:${Math.max(4, widths[index]/total*100).toFixed(2)}%">`).join('')}</colgroup>`};
const registrationPdfHeaderHtml=(title,portrait=false)=>{const fest=registrationEscape([homeConfig.festName1,homeConfig.festName2].filter(Boolean).join(' ')||'FEST');return `<div class="registration-pdf-page${portrait?' portrait':''}"><div class="registration-pdf-header"><div class="registration-pdf-fest">${fest}</div><div class="registration-pdf-title">${registrationEscape(title)}</div><div class="registration-pdf-meta">${registrationEscape(registrationFilterSummary())}<br>Generated: ${registrationEscape(new Date().toLocaleString())}</div></div>`};
const registrationTableHtml=(rows,cols)=>`${registrationPdfColgroup(cols,rows)}<thead><tr>${cols.map(key=>`<th class="${registrationPdfColumnClass(key)}">${registrationEscape(registrationColumnLabel(key))}</th>`).join('')}</tr></thead><tbody>${rows.map((item,index)=>`<tr>${cols.map(key=>`<td class="${registrationPdfColumnClass(key)}" dir="${registrationTextDirection(registrationColumnValue(item,key,index))}">${registrationEscape(registrationColumnValue(item,key,index))}</td>`).join('')}</tr>`).join('')}</tbody>`;
const registrationPdfHtml=(rows,model)=>{if(model==='student'){const groups=registrationGroupedRows(rows),cols=['no','event','eventCategory','stage','type','status','applied'];return `${registrationPdfStyles()}${registrationPdfHeaderHtml('STUDENT EVENT SHEETS',true)}${groups.map((group,index)=>`<section class="registration-student-section ${index?'registration-student-page-break':''}"><div class="registration-student-head" dir="${registrationTextDirection(group.student.studentName)}">${registrationEscape(group.student.studentName||'Applicant')} &nbsp; | &nbsp; Chest: ${registrationEscape(group.student.chestNo||'—')} &nbsp; | &nbsp; Team: ${registrationEscape(group.student.team?teamLabel(group.student.team):'—')} &nbsp; | &nbsp; Class: ${registrationEscape(group.student.className||'—')}</div><table class="registration-pdf-table">${registrationTableHtml(group.rows,cols)}</table></section>`).join('')}</div>`}const cols=selectedRegistrationExportColumns();return `${registrationPdfStyles()}${registrationPdfHeaderHtml('REGISTRATION APPLICATIONS')}<table class="registration-pdf-table">${registrationTableHtml(rows,cols)}</table></div>`};
const createRegistrationPdfFromHtml=async html=>{if(!window.html2pdf)throw new Error('Malayalam PDF renderer is not loaded');const host=document.createElement('div');host.style.cssText='position:fixed;left:-10000px;top:0;background:#fff;z-index:-1';host.innerHTML=html;document.body.appendChild(host);try{const page=host.querySelector('.registration-pdf-page'),portrait=page.classList.contains('portrait'),blob=await window.html2pdf().from(page).set({margin:0,pagebreak:{mode:['css','legacy'],before:['.registration-student-page-break'],avoid:['tr','.registration-pdf-header','.registration-student-head']},image:{type:'jpeg',quality:.98},html2canvas:{scale:2,backgroundColor:'#ffffff',useCORS:true},jsPDF:{unit:'mm',format:'a4',orientation:portrait?'portrait':'landscape'}}).outputPdf('blob');return{output:type=>type==='blob'?blob:blob}}finally{host.remove()}};
async function createRegistrationTablePdf(rows){return createRegistrationPdfFromHtml(registrationPdfHtml(rows,'table'))}
async function createRegistrationStudentPdf(rows){return createRegistrationPdfFromHtml(registrationPdfHtml(rows,'student'))}
window.createRegistrationPdf=()=>{const rows=window.filteredRegistrationExportRows();if(!rows.length)throw new Error('No applications match the selected filters');return registrationPdfModel()==='student'?createRegistrationStudentPdf(rows):createRegistrationTablePdf(rows)};
const revokeRegistrationPdf=()=>{if(registrationPdfUrl)URL.revokeObjectURL(registrationPdfUrl);registrationPdfUrl='';registrationPdfBlob=null};
window.previewRegistrationPdf=async()=>{const modal=document.getElementById('registration-pdf-modal'),loading=document.getElementById('registration-pdf-loading'),errorBox=document.getElementById('registration-pdf-error'),frame=document.getElementById('registration-pdf-frame');modal.classList.remove('hidden');modal.classList.add('flex');loading.classList.remove('hidden');errorBox.classList.add('hidden');frame.removeAttribute('src');try{revokeRegistrationPdf();const pdf=await window.createRegistrationPdf();registrationPdfBlob=pdf.output('blob');registrationPdfUrl=URL.createObjectURL(registrationPdfBlob);frame.src=registrationPdfUrl;document.getElementById('registration-pdf-meta').textContent=`${registrationPdfModel()==='student'?'Student Event Sheets':'Applications Table'} • Fast B/W AutoTable PDF`;}catch(error){errorBox.textContent=error.message||'Unable to generate PDF';errorBox.classList.remove('hidden')}finally{loading.classList.add('hidden')}};
window.closeRegistrationPdf=()=>{const modal=document.getElementById('registration-pdf-modal');modal.classList.add('hidden');modal.classList.remove('flex');document.getElementById('registration-pdf-frame').removeAttribute('src');revokeRegistrationPdf()};window.downloadRegistrationPdf=()=>{if(!registrationPdfBlob)return window.showToast('Generate a PDF preview first','error');const a=document.createElement('a');a.href=registrationPdfUrl;a.download=registrationPdfModel()==='student'?'Registration_Student_Event_Sheets.pdf':'Registration_Applications_Table.pdf';a.click()};window.printRegistrationPdf=()=>document.getElementById('registration-pdf-frame')?.contentWindow?.print();
window.exportRegistrationExcel=()=>{if(!window.XLSX)return window.showToast('SheetJS 0.18.5 is not loaded','error');const rows=window.filteredRegistrationExportRows();if(!rows.length)return window.showToast('No applications match the selected filters','error');const cols=selectedRegistrationExportColumns(),data=rows.map((item,index)=>Object.fromEntries(cols.map(key=>[registrationColumnLabel(key),registrationColumnValue(item,key,index)]))),studentsData=registrationGroupedRows(rows).map(group=>({Student:group.student.studentName,'Chest No':group.student.chestNo,Class:group.student.className,Team:group.student.team,Category:group.student.category||'',Events:group.rows.map(item=>`${item.stage}: ${item.eventName}`).join('\n')})),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(data),'Applications');XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(studentsData),'Student Event Sheets');XLSX.writeFile(book,'Registration_Applications.xlsx')};

window.renderAdvancedRegistration = () => {
    const set=(id,value,check=false)=>{const el=document.getElementById(id);if(!el||document.activeElement===el)return;check?el.checked=!!value:el.value=value;};
    const generalHost=document.getElementById('advanced-general-event-categories');
    if(generalHost){
        const studentCategories=categories.filter(category=>category&&category!=='General'),saved=Array.isArray(registrationConfig.generalEventEligibleCategories)?registrationConfig.generalEventEligibleCategories:null,selected=new Set(saved===null?studentCategories:saved);
        generalHost.innerHTML=studentCategories.map(category=>`<label class="flex items-center gap-3 rounded-xl border bg-white/80 p-3 text-xs font-black text-indigo-950"><input type="checkbox" name="advanced-general-event-category" value="${escapeHtml(category)}" class="h-5 w-5" ${selected.has(category)?'checked':''}>${escapeHtml(category)}</label>`).join('')||'<p class="rounded-xl bg-white p-3 text-xs font-bold text-slate-500">Create student categories first; General events will remain open to everyone until this policy is saved.</p>';
    }
    const dateValue=value=>value?new Date(value-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';set('advanced-registration-status',registrationConfig.globalStatus);set('advanced-registration-open-at',dateValue(registrationConfig.openAt));set('advanced-registration-close-at',dateValue(registrationConfig.closeAt));set('advanced-registration-selection-at',dateValue(registrationConfig.selectionDeadlineAt));set('advanced-registration-final-lock-at',dateValue(registrationConfig.finalizationLockAt));set('advanced-registration-note-limit',registrationConfig.applicationNoteMaxLength);set('advanced-registration-waitlist',registrationConfig.waitingListEnabled,true);set('advanced-full-event-visibility',registrationConfig.fullEventVisibility);set('advanced-registration-leader-finalize',registrationConfig.allowTeamLeaderFinalize,true);set('advanced-registration-enabled',registrationConfig.registrationPortalEnabled,true);set('advanced-registration-links',registrationConfig.applicationLinksEnabled,true);set('advanced-profile-edit-enabled',registrationConfig.profileEditEnabled,true);set('advanced-application-update-missing',registrationConfig.allowApplicationMediaAddMissing,true);set('advanced-application-update-replace',registrationConfig.allowApplicationMediaReplace,true);Object.entries(registrationConfig.applicationFields||{}).forEach(([key,value])=>set(`advanced-field-${key}`,value));set('advanced-show-rules',registrationConfig.showEventRules,true);set('advanced-show-criteria',registrationConfig.showJudgingCriteria,true);const generalCounting=registrationConfig.participationLimits?.generalCounting||{};set('advanced-general-count-stage',generalCounting.stage,true);set('advanced-general-count-type',generalCounting.type,true);set('advanced-general-count-independent',generalCounting.independent,true);set('advanced-limit-notice-heading',registrationConfig.participationLimits?.noticeHeading||'');set('advanced-limit-notice-content',registrationConfig.participationLimits?.noticeContent||'');Object.entries(registrationConfig.participationLimits||{}).forEach(([key,value])=>{if(key==='excludeGeneralFromTotal')return set('advanced-limit-exclude-general',value,true);if(['generalCounting','noticeHeading','noticeContent'].includes(key))return;set(`advanced-limit-${key}-enabled`,value.enabled!==false,true);set(`advanced-limit-${key}-mode`,value.mode);set(`advanced-limit-${key}`,value.limit)});
    const host=document.getElementById('advanced-registration-summary'),overview=document.getElementById('registration-overview-cards'),monitor=document.getElementById('registration-finalization-grid'),selectedStatuses=new Set(['selected','finalized']),selected=registrationApplications.filter(item=>selectedStatuses.has(item.status)),overloaded=events.reduce((count,event)=>count+teams.filter(team=>capacityState(event,selected.filter(item=>item.eventId===event.id&&item.team===team).length).state==='overloaded').length,0),cards=[['Applications',registrationApplications.length],['Awaiting review',registrationApplications.filter(item=>['applied','waitlisted','under_review'].includes(item.status)).length],['Selected / finalized',selected.length],['Overloaded team-events',overloaded]];const cardHtml=cards.map(([label,value])=>`<article class="rounded-xl border ${label.startsWith('Overloaded')&&value?'border-red-200 bg-red-50':'bg-white'} p-3"><strong class="block text-2xl font-black">${value}</strong><span class="text-[10px] font-black uppercase text-slate-500">${label}</span></article>`).join('');if(host)host.innerHTML=cardHtml;if(overview)overview.innerHTML=cardHtml;if(monitor){const grouped=Object.values(registrationApplications.reduce((map,item)=>{const key=`${item.team||'No team'}__${item.eventId}`;(map[key]||={team:item.team||'No team',eventId:item.eventId,eventName:item.eventName||'Event',applications:0,selected:0});map[key].applications++;if(selectedStatuses.has(item.status))map[key].selected++;return map},{}));monitor.innerHTML=grouped.map(row=>{const state=capacityState(events.find(item=>item.id===row.eventId)||{limit:1},row.selected);return `<article class="rounded-xl border ${state.state==='overloaded'?'border-red-300 bg-red-50':'bg-slate-50'} p-4"><b>${escapeHtml(row.team)} • ${escapeHtml(row.eventName)}</b><p class="mt-1 text-xs font-bold">${row.applications} applications • ${row.selected}/${state.capacity} selected</p><span class="mt-2 inline-block rounded-full px-2 py-1 text-[9px] font-black uppercase ${state.state==='overloaded'?'bg-red-600 text-white':'bg-white'}">${state.state}${state.excess?` +${state.excess}`:''}</span></article>`}).join('')||'<p class="text-sm font-bold text-slate-400">No applications.</p>';}
};
window.saveAdvancedRegistration = async () => {
    const status=document.getElementById('advanced-registration-status').value,date=id=>{const value=document.getElementById(id)?.value;return value?new Date(value).getTime():0},enabled=document.getElementById('advanced-registration-enabled').checked,payload={registrationPortalEnabled:enabled,studentApplicationsEnabled:enabled,openAt:date('advanced-registration-open-at'),closeAt:date('advanced-registration-close-at'),selectionDeadlineAt:date('advanced-registration-selection-at'),finalizationLockAt:date('advanced-registration-final-lock-at'),globalStatus:status,unfilledEventsOnly:status==='unfilled_only',acceptWhenFull:status!=='unfilled_only',waitingListEnabled:document.getElementById('advanced-registration-waitlist').checked,fullEventVisibility:document.getElementById('advanced-full-event-visibility').value,allowTeamLeaderFinalize:document.getElementById('advanced-registration-leader-finalize').checked,profileEditEnabled:document.getElementById('advanced-profile-edit-enabled').checked,allowApplicationMediaAddMissing:document.getElementById('advanced-application-update-missing').checked,allowApplicationMediaReplace:document.getElementById('advanced-application-update-replace').checked,applicationLinksEnabled:['youtube','reference'].some(key=>document.getElementById(`advanced-field-${key}`).value!=='off'),applicationFields:Object.fromEntries(['description','youtube','reference','images'].map(key=>[key,document.getElementById(`advanced-field-${key}`).value])),showEventRules:document.getElementById('advanced-show-rules').checked,showJudgingCriteria:document.getElementById('advanced-show-criteria').checked,generalEventEligibleCategories:(()=>{const selected=[...document.querySelectorAll('input[name="advanced-general-event-category"]:checked')].map(input=>input.value);return selected.length?selected:null})(),applicationImageMaxCount:1,applicationImageMaxSizeKb:300,participationLimits:{...Object.fromEntries(['offStage','onStage','single','group','general','total'].map(key=>[key,{enabled:document.getElementById(`advanced-limit-${key}-enabled`).checked,mode:document.getElementById(`advanced-limit-${key}-mode`).value,limit:Math.max(0,Math.min(100,Number(document.getElementById(`advanced-limit-${key}`).value||0)))}])),excludeGeneralFromTotal:document.getElementById('advanced-limit-exclude-general').checked,generalCounting:{stage:document.getElementById('advanced-general-count-stage').checked,type:document.getElementById('advanced-general-count-type').checked,independent:document.getElementById('advanced-general-count-independent').checked},noticeHeading:document.getElementById('advanced-limit-notice-heading')?.value.trim()||'',noticeContent:document.getElementById('advanced-limit-notice-content')?.value.trim()||''},applicationNoteMaxLength:Math.max(25,Math.min(500,Number(document.getElementById('advanced-registration-note-limit').value||250))),updatedAt:Date.now(),updatedByUid:auth.currentUser?.uid||''};
    await setDoc(doc(db,'settings','registration_config'),payload,{merge:true});await setDoc(doc(db,'settings','schedule_config'),{registrationLockAt:payload.finalizationLockAt||null,updatedAt:payload.updatedAt},{merge:true});await addDoc(collection(db,'auditLogs'),{action:'registration-policy-update',...payload,timestamp:Date.now()});window.showToast('Advanced registration policy saved');
};
window.approvePortalApplication=async id=>{const item=registrationApplications.find(row=>row.id===id);if(!item||item.status!=='pending_admin_approval')return;const profile=item.profileSnapshot||{},ref=doc(collection(db,'participants')),now=Date.now();const batch=writeBatch(db);batch.set(ref,{name:item.participantName,participantType:item.participantType,gender:item.gender||'',team:item.team||'',category:item.category||'Open',phone:profile.details?.phone||'',email:profile.details?.email||'',relationship:profile.details?.relationship||'',approvalStatus:'approved',registrationSource:'registration_portal',createdAt:now,updatedAt:now});batch.update(doc(db,'registrationApplications',id),{participantId:ref.id,status:'applied',reviewedAt:now,reviewedByUid:auth.currentUser?.uid||'',updatedAt:now});await batch.commit();window.showToast('Participant identity approved')};
window.rejectPortalApplication=async id=>{await updateDoc(doc(db,'registrationApplications',id),{status:'not_selected',reviewedAt:Date.now(),reviewedByUid:auth.currentUser?.uid||'',updatedAt:Date.now()});window.showToast('Application rejected')};
window.approveRegistrationRequest = async id => {
    const request=registrationRequests.find(item=>item.id===id); if(!request||!await window.confirmAction(`Approve ${request.name}?`))return;
    const batch=writeBatch(db),participantRef=doc(collection(db,'participants')),now=Date.now(),related=students.find(student=>student.id===request.relatedStudentId),isStudent=request.participantType==='student'&&!!related,resolvedTeam=related?.team||request.team||'';if(isStudent){const existingIds=registrations.filter(item=>(item.studentIds||[]).includes(related.id)).map(item=>item.eventId),requestIds=registrationRequests.filter(item=>item.id!==request.id&&item.relatedStudentId===related.id&&!['rejected'].includes(item.status)).flatMap(item=>item.eventIds||[]),usage=participationUsage([...existingIds,...requestIds],events,registrationConfig);for(const eventId of request.eventIds||[]){const target=events.find(item=>item.id===eventId),decision=participationLimitDecision(registrationConfig,target,usage);if(!decision.allowed)return window.showToast(`Participation limit reached: ${decision.exceeded.map(item=>`${item.key} ${item.count}/${item.limit}`).join(', ')}`,'error');for(const key of decision.buckets)usage[key]=(usage[key]||0)+1}}
    if(!isStudent)batch.set(participantRef,{name:request.name,participantType:request.participantType||'public',gender:request.gender||'',phone:request.phone||'',email:request.email||'',team:resolvedTeam,category:request.category||'Open',relatedStudentId:request.relatedStudentId||'',relationship:request.relationship||'',approvalStatus:'approved',registrationSource:'self',createdAt:now,updatedAt:now});
    const memberRefs=isStudent?[]:(request.groupMembers||[]).map(name=>{const ref=doc(collection(db,'participants'));batch.set(ref,{name,participantType:request.participantType||'public',gender:request.gender||'',team:resolvedTeam,category:request.category||'Open',approvalStatus:'approved',registrationSource:'self-group',createdAt:now,updatedAt:now});return ref;});
    let createdRegistrations=0;
    (request.eventIds||[]).forEach((eventId,index)=>{const event=events.find(item=>item.id===eventId),ids=isStudent?[related.id]:(event?.type==='Group'?[participantRef.id,...memberRefs.map(ref=>ref.id)]:[participantRef.id]),payload={eventId,team:resolvedTeam,slotIndex:index+1,participantIds:isStudent?[]:ids,studentIds:isStudent?[related.id]:[],registrationSource:'self',createdByUid:'public-request',createdAt:now,lastUpdatedAt:now};if(setUniqueRegistration(batch,{eventId,primaryPersonId:ids[0],payload}))createdRegistrations++;});
    batch.update(doc(db,'registrationRequests',id),{status:'approved',participantId:isStudent?'':participantRef.id,studentId:isStudent?related.id:'',reviewedAt:now}); await batch.commit(); window.showToast('Registration approved');
};
window.rejectRegistrationRequest = async id => { const request=registrationRequests.find(item=>item.id===id); if(!request||!await window.confirmAction(`Reject ${request.name}?`))return; await updateDoc(doc(db,'registrationRequests',id),{status:'rejected',reviewedAt:Date.now()}); window.showToast('Registration rejected'); };

window.renderParticipantFormOptions = () => {
    const type=document.getElementById('participant-type-admin'),filter=document.getElementById('participant-filter-type');
    const types=festSetup.participantTypes; const definitions=normalizeParticipantTypeDefinitions(festSetup.participantTypeDefinitions),options=types.map(value=>`<option value="${value}">${escapeHtml(definitions.find(item=>item.key===value)?.label||value[0].toUpperCase()+value.slice(1))}</option>`).join('');
    if(type){const old=type.value;type.innerHTML=options;if(types.includes(old))type.value=old;}
    if(filter){const old=filter.value;filter.innerHTML='<option value="">All Types</option>'+options;filter.value=old;}
    const genders=festSetup.allowedGenders.map(value=>`<option value="${value}">${value}</option>`).join(''),gender=document.getElementById('participant-gender-admin');if(gender){const old=gender.value;gender.innerHTML=genders;if(festSetup.allowedGenders.includes(old))gender.value=old;}
    const related=document.getElementById('participant-related-student');if(related){const old=related.value;related.innerHTML='<option value="">No linked student</option>'+students.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(student=>`<option value="${student.id}">${escapeHtml(student.name)} • ${escapeHtml(student.team)} • #${student.chestNo||'-'}</option>`).join('');related.value=old;}const form=document.getElementById('participant-form'),order=['participant-type-admin','participant-team-admin','participant-gender-admin','participant-name-admin','participant-phone-admin','participant-email-admin','participant-category-admin','participant-organisation','participant-designation','participant-duty','participant-valid-until','participant-photo','participant-related-student','participant-relationship'];order.forEach((id,index)=>{const wrap=document.getElementById(id)?.closest('label');if(wrap)wrap.style.order=String(index+1);});form?.querySelector('.flex.items-end')?.style.setProperty('order','20');window.updateParticipantStudentPicker?.();
};
const participantPersonCount = registration => [...(registration?.studentIds||[]), ...(registration?.participantIds||[])].filter(Boolean).length;
const participantFormProfile=()=>{const studentId=document.getElementById('participant-student-id')?.value||'',student=students.find(item=>item.id===studentId),participantType=masterValue('participant-type-admin');return student?{id:student.id,participantType:'student',name:student.name,team:student.team||'',gender:student.gender||'',category:student.category||student.class||'',details:student.details||{},class:student.class||student.details?.class||'',chestNo:student.chestNo||'',student}:{id:document.getElementById('participant-edit-id')?.value||'new_admin_participant',participantType,name:masterValue('participant-name-admin').trim(),team:masterValue('participant-team-admin'),gender:masterValue('participant-gender-admin'),category:masterValue('participant-category-admin')||'Open',details:{}}};
const participantEventEligible=(profile,event)=>{if(!profile?.participantType||!event?.id||event.status==='draft')return false;const types=event.allowedParticipantTypes||festSetup.participantTypes||['student'];if(types.length&&!types.includes(profile.participantType))return false;const genders=[event.gender,event.genderScope].filter(Boolean);if(genders.length&&!genders.includes('Both')&&!genders.includes(profile.gender||'Boys'))return false;if(!eventCategoryEligible(profile,event,registrationConfig))return false;if(profile.participantType==='student'&&Array.isArray(event.eligibleClasses)&&event.eligibleClasses.length&&!event.eligibleClasses.map(String).includes(String(profile.details?.class||profile.class||'')))return false;return true;};
const participantEventLimitState=(event,team)=>{const teamRegs=registrations.filter(reg=>reg.eventId===event.id&&reg.team===team),limit=Math.max(1,Number(event.limit||1)),current=event.type==='Group'?teamRegs.length:teamRegs.reduce((sum,reg)=>sum+participantPersonCount(reg),0);return{current,limit,reached:current>=limit,label:`${current}/${limit}`};};
const renderParticipantEligibleEvents=()=>{const box=document.getElementById('participant-eligible-events');if(!box)return;const profile=participantFormProfile(),studentId=document.getElementById('participant-student-id')?.value,participantId=document.getElementById('participant-edit-id')?.value,eligible=events.filter(event=>participantEventEligible(profile,event));box.innerHTML=eligible.map(event=>{const personId=studentId||participantId,registered=personId?registrations.some(reg=>reg.eventId===event.id&&registrationPersonIds(reg).includes(String(personId))):false,limit=participantEventLimitState(event,profile.team||''),warning=limit.reached&&!registered?`<span class="mt-1 block rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-700">Limit reached ${escapeHtml(limit.label)} • confirm override on save</span>`:'';return`<label class="rounded-xl border ${registered?'border-emerald-200 bg-emerald-50':'bg-white'} p-3 text-xs font-bold"><span class="flex items-start gap-2"><input type="checkbox" name="participant-events" value="${event.id}" class="mt-0.5" ${registered?'checked disabled':''}><span class="min-w-0"><span class="block font-black text-slate-800">${escapeHtml(event.name)}</span><span class="mt-1 block text-[10px] uppercase text-slate-500">${escapeHtml(event.category||'General')} • ${escapeHtml(event.gender||'Both')} • ${escapeHtml(event.stage||'Off-Stage')} • Limit ${escapeHtml(limit.label)}</span>${registered?'<span class="mt-1 block text-[10px] font-black text-emerald-700">Already in final entries</span>':warning}</span></span></label>`;}).join('')||'<p class="col-span-full py-3 text-center text-xs font-bold text-slate-400">No eligible events for the selected student/participant.</p>';};
const participantStudentMatches=()=>{const team=masterValue('participant-team-admin'),gender=masterValue('participant-gender-admin');return students.filter(student=>(!team||student.team===team)&&(!gender||student.gender===gender||student.gender===genderLabel({gender:student.gender}))).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));};
window.updateParticipantStudentPicker=()=>{const isStudent=masterValue('participant-type-admin')==='student',name=document.getElementById('participant-name-admin'),list=document.getElementById('participant-student-suggestions'),hint=document.getElementById('participant-student-hint'),selected=document.getElementById('participant-student-id');if(name)name.setAttribute('list',isStudent?'participant-student-suggestions':'');hint?.classList.toggle('hidden',!isStudent);if(list)list.innerHTML=isStudent?participantStudentMatches().map(student=>`<option value="${escapeHtml(student.name)}">${escapeHtml(student.team||'No Team')} • ${escapeHtml(student.gender||'')} • ${escapeHtml(student.class||student.category||'')} • #${student.chestNo||'-'}</option>`).join(''):'';if(!isStudent&&selected)selected.value='';renderParticipantEligibleEvents();};
window.clearParticipantForm = () => { document.getElementById('participant-form')?.reset();document.getElementById('participant-edit-id').value='';document.getElementById('participant-student-id').value='';window.renderParticipantFormOptions();window.updateParticipantStudentPicker(); };
window.renderParticipants = () => { const box=document.getElementById('participant-directory');if(!box)return;window.renderParticipantFormOptions();const query=(document.getElementById('participant-search')?.value||'').toLowerCase(),type=document.getElementById('participant-filter-type')?.value||'',team=document.getElementById('participant-filter-team')?.value||'';const rows=participants.filter(item=>(!type||item.participantType===type)&&(!team||item.team===team)&&(!query||`${item.name} ${item.phone} ${item.email}`.toLowerCase().includes(query)));box.innerHTML=rows.map(item=>`<article class="rounded-xl border p-4"><div class="flex justify-between gap-2"><div><h4 class="font-black">${escapeHtml(item.name)}</h4><p class="text-xs font-bold text-slate-500">${escapeHtml(item.participantType)} • ${escapeHtml(item.gender||'')} ${item.team?`• ${escapeHtml(item.team)}`:''}</p><p class="mt-1 text-[10px] text-slate-400">${escapeHtml(item.phone||item.email||'')}</p>${item.relatedStudentId?`<p class="mt-2 text-[10px] font-bold text-violet-600">Related: ${escapeHtml(students.find(s=>s.id===item.relatedStudentId)?.name||'Student')}</p>`:''}</div><span class="h-3 w-3 rounded-full bg-emerald-500"></span></div><div class="mt-3 flex gap-2"><button data-admin-action="edit-participant" data-id="${item.id}" class="flex-1 rounded-lg bg-indigo-50 py-2 text-xs font-black text-indigo-600">Edit</button><button data-admin-action="delete-participant" data-id="${item.id}" class="flex-1 rounded-lg bg-red-50 py-2 text-xs font-black text-red-600">Delete</button></div></article>`).join('')||'<p class="col-span-full py-10 text-center font-bold text-slate-400">No participants found.</p>';window.lucide?.createIcons?.();};
window.editParticipant = id => {const item=participants.find(value=>value.id===id);if(!item)return;document.getElementById('participant-edit-id').value=id;['type','name','gender','phone','email','team','category'].forEach(key=>{const el=document.getElementById(`participant-${key}-admin`);if(el)el.value=item[key==='type'?'participantType':key]||'';});document.getElementById('participant-related-student').value=item.relatedStudentId||'';document.getElementById('participant-student-id').value=item.studentId||'';document.getElementById('participant-relationship').value=item.relationship||'';[['participant-organisation','organisation'],['participant-designation','designation'],['participant-duty','duty'],['participant-valid-until','validUntil'],['participant-photo','photo']].forEach(([id,key])=>{const input=document.getElementById(id);if(input)input.value=item[key]||'';});window.switchTab('participants');};
window.deleteParticipant = async id => {const item=participants.find(value=>value.id===id);if(!item||!await window.confirmAction(`Delete ${item.name} and remove their registrations?`))return;const batch=writeBatch(db);registrations.filter(reg=>(reg.participantIds||[]).includes(id)).forEach(reg=>{const next=(reg.participantIds||[]).filter(value=>value!==id);if(!next.length&&!(reg.studentIds||[]).length)batch.delete(doc(db,'registrations',reg.id));else batch.update(doc(db,'registrations',reg.id),{participantIds:next,lastUpdatedAt:Date.now()});});results.forEach(result=>{const remove=value=>(Array.isArray(value)?value:[value].filter(Boolean)).filter(winner=>winner!==id),places=(result.places||[]).map(place=>({...place,winners:remove(place.winners)})).filter(place=>place.winners.length),gradeAwards=(result.gradeAwards||[]).map(grade=>({...grade,winners:remove(grade.winners)})).filter(grade=>grade.winners.length),winners=Object.fromEntries(Object.entries(result.winners||{}).map(([key,value])=>[key,remove(value)])),grades=Object.fromEntries(Object.entries(result.grades||{}).map(([key,value])=>[key,remove(value)]));batch.update(doc(db,'results',result.id),{places,gradeAwards,winners,grades,updatedAt:Date.now()});});judgeScores.filter(score=>(score.marks||[]).some(mark=>mark.participantId===id)).forEach(score=>batch.update(doc(db,'judgeScores',score.id),{marks:(score.marks||[]).filter(mark=>mark.participantId!==id),updatedAt:Date.now()}));batch.delete(doc(db,'participants',id));await batch.commit();window.showToast('Participant deleted');};
['participant-type-admin','participant-team-admin','participant-gender-admin','participant-category-admin'].forEach(id=>document.getElementById(id)?.addEventListener('change',()=>{document.getElementById('participant-student-id').value='';window.updateParticipantStudentPicker();}));
document.getElementById('participant-name-admin')?.addEventListener('input',event=>{if(masterValue('participant-type-admin')!=='student')return;const match=participantStudentMatches().find(student=>String(student.name||'').trim().toLowerCase()===event.target.value.trim().toLowerCase());document.getElementById('participant-student-id').value=match?.id||'';if(match){document.getElementById('participant-team-admin').value=match.team||'';document.getElementById('participant-gender-admin').value=match.gender||'';document.getElementById('participant-category-admin').value=match.category||match.class||'Open';renderParticipantEligibleEvents();}});
document.getElementById('participant-related-student')?.addEventListener('change',event=>{const student=students.find(item=>item.id===event.target.value);if(student)document.getElementById('participant-team-admin').value=student.team||'';});
document.getElementById('participant-form')?.addEventListener('submit',async event=>{event.preventDefault();const id=document.getElementById('participant-edit-id').value,relatedStudentId=document.getElementById('participant-related-student').value,related=students.find(item=>item.id===relatedStudentId),studentId=document.getElementById('participant-student-id').value,student=students.find(item=>item.id===studentId),participantType=masterValue('participant-type-admin');if(participantType==='student'&&!student)return window.showToast('Select an existing Student Directory suggestion','error');if(student&&participants.some(item=>item.id!==id&&item.studentId===student.id))return window.showToast('This student is already linked in Participants','error');const data={participantType,name:student?.name||masterValue('participant-name-admin').trim(),gender:student?.gender||masterValue('participant-gender-admin'),phone:student?.phone||masterValue('participant-phone-admin').trim(),email:student?.email||masterValue('participant-email-admin').trim(),team:student?.team||related?.team||masterValue('participant-team-admin'),category:student?.category||student?.class||masterValue('participant-category-admin')||'Open',studentId:student?.id||'',sourceType:student?'student_directory':'participant_directory',relatedStudentId,relationship:masterValue('participant-relationship').trim(),organisation:masterValue('participant-organisation').trim(),designation:masterValue('participant-designation').trim(),validUntil:masterValue('participant-valid-until'),photo:masterValue('participant-photo').trim(),approvalStatus:'approved',registrationSource:'admin',updatedAt:Date.now()};if(!data.name||!data.participantType)return window.showToast('Name and participant type are required','error');const participantRef=id?doc(db,'participants',id):doc(collection(db,'participants'));const selectedEventIds=[...document.querySelectorAll('[name="participant-events"]:checked:not(:disabled)')].map(input=>input.value),personId=student?.id||participantRef.id,duplicates=[],limitReached=[];for(const eventId of selectedEventIds){const eventItem=events.find(item=>item.id===eventId);if(existingRegistrationForPersonEvent(eventId,personId)){duplicates.push(eventItem?.name||'Event');continue;}const state=eventItem?participantEventLimitState(eventItem,data.team||''):{reached:false};if(state.reached)limitReached.push({event:eventItem,state});}if(limitReached.length){const text=limitReached.map(({event,state})=>`• ${event?.name||'Event'} (${state.current}/${state.limit})`).join('\n');const ok=await window.confirmAction(`Team limit reached for:
${text}

Add anyway as Admin override?`);if(!ok)return window.showToast('Over-limit registration cancelled','info');}await setDoc(participantRef,{...data,...(!id?{createdAt:Date.now()}:{})},{merge:true});let saved=0;for(const eventId of selectedEventIds){const eventItem=events.find(item=>item.id===eventId);if(duplicates.includes(eventItem?.name||'Event')){window.showToast(`${eventItem?.name||'Event'}: participant already registered; duplicate skipped`,'error');continue;}const state=eventItem?participantEventLimitState(eventItem,data.team||''):{current:0},slotIndex=eventItem?.type==='Group'?state.current+1:state.current+1,now=Date.now();await setDoc(doc(db,'registrations',registrationDocumentId(eventId,personId)),{eventId,eventName:eventItem?.name||'',team:data.team||'',slotIndex,studentIds:student?[student.id]:[],participantIds:student?[]:[participantRef.id],participantMeta:{[personId]:{name:data.name,participantType:data.participantType,team:data.team,gender:data.gender,category:data.category,chestNo:student?.chestNo||'',addedByUid:auth.currentUser?.uid||'',addedByName:'Fest Committee',addedByRole:'fest_committee',addedAt:now}},registrationSource:'admin-participant-directory',adminOverride:true,createdByUid:auth.currentUser?.uid||'',createdByName:'Fest Committee',createdByRole:'fest_committee',createdAt:now,lastUpdatedByUid:auth.currentUser?.uid||'',lastUpdatedByName:'Fest Committee',lastUpdatedByRole:'fest_committee',lastUpdatedAt:now});saved++;}window.renderRegList?.(true);window.clearParticipantForm();window.showToast(saved?`Participant saved and ${saved} final entr${saved===1?'y':'ies'} updated`:'Participant saved');});
const enabledStudentFields = () => normalizeStudentFields(festSetup.studentFields).filter(field => field.enabled);
const studentDetails = (prefix = 'inp') => Object.fromEntries(enabledStudentFields().filter(field => field.key !== 'name').map(field => [field.key, document.getElementById(`${prefix}-std-custom-${field.key}`)?.value?.trim?.() || '']));
const fieldInput = (field, prefix, value = '') => `<label class="input-group"><span class="input-label">${escapeHtml(field.label)}${field.required?' <span class="text-red-500">*</span>':''}</span>${field.type==='select'?`<select id="${prefix}-std-custom-${field.key}" ${field.required?'required':''} class="text-input"><option value="">Select ${escapeHtml(field.label)}</option>${(field.options||[]).map(option=>`<option value="${escapeHtml(option)}" ${option===value?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select>`:`<input id="${prefix}-std-custom-${field.key}" type="${field.type}" value="${escapeHtml(value)}" ${field.required?'required':''} class="text-input" dir="auto">`}</label>`;
window.renderStudentCustomFields = () => {
    const add=document.getElementById('student-custom-fields');if(add)add.innerHTML=enabledStudentFields().filter(field=>field.key!=='name').map(field=>fieldInput(field,'inp')).join('');
};
window.applyEventProfile=profile=>{const profiles={basic:{scheduleMode:'basic',judgingMode:'disabled',resultWorkflow:'direct',teamScoringMode:'disabled',features:{excelImport:false,customCriteria:false,objectiveScoring:false,timeResults:false,countResults:false,multipleJudges:false,eventOverrides:false,teamLedger:false}},standard:{scheduleMode:'full',judgingMode:'enabled',resultWorkflow:'judged',teamScoringMode:'enabled',features:{excelImport:true,customCriteria:true,objectiveScoring:false,timeResults:false,countResults:false,multipleJudges:false,eventOverrides:false,teamLedger:true}},advanced:{scheduleMode:'full',judgingMode:'optional',resultWorkflow:'hybrid',teamScoringMode:'per_event',features:{excelImport:true,customCriteria:true,objectiveScoring:true,timeResults:true,countResults:true,multipleJudges:true,eventOverrides:true,teamLedger:true}}},chosen=profiles[profile];if(!chosen)return;festSetup=normalizeFestSetup({...festSetup,preset:'custom',eventManagementMode:profile,eventFieldProfile:profile,eventFieldRules:eventFieldRulesForMode(profile),scheduleMode:chosen.scheduleMode,judgingMode:chosen.judgingMode,resultWorkflow:chosen.resultWorkflow,teamScoringMode:chosen.teamScoringMode,eventFeatures:{...festSetup.eventFeatures,...chosen.features}});window.renderMasterSetup();window.showToast(`${profile[0].toUpperCase()+profile.slice(1)} profile applied to draft`);};
const CORE_EVENT_FIELDS=[
    {key:'name',label:'Event Name',suffix:'ev-name'},{key:'category',label:'Category',suffix:'ev-cat'},{key:'gender',label:'Gender',suffix:'ev-gender'},{key:'type',label:'Event Type',suffix:'ev-type'},{key:'stage',label:'Stage Type',suffix:'ev-stage'},{key:'entriesPerTeam',label:'Team Entry Limit',suffix:'ev-limit'},{key:'resultMethod',label:'Result Method',suffix:'ev-result-method'}
];
const EVENT_FORM_FIELD_IDS={code:'ev-code',section:'ev-section',eligibleClasses:'ev-eligible-classes',participantTypes:'ev-participant-types',registrationChannels:'ev-registration-channels',minimumMembers:'ev-min-members',maximumMembers:'ev-max-members',maximumMark:'ev-maximum-mark',criteriaText:'ev-criteria',multipleJudgeMethod:'ev-multiple-judge',tieBreakMethod:'ev-tie-break',gradeMode:'ev-grade-mode',duration:'ev-duration',preparationTime:'ev-preparation',rules:'ev-rules',resultWorkflow:'ev-result-workflow',scheduleRequirement:'ev-schedule-required',teamPolicy:'ev-team-policy',correctMark:'ev-correct-mark',wrongPenalty:'ev-wrong-penalty',countPenalty:'ev-count-penalty',timeDirection:'ev-time-direction',scoreContribution:'ev-score-contribution',scoringPolicy:'ev-scoring-policy'};
const EVENT_REQUIREMENT_META={required:{title:'Required Event Details',description:'These fields must be completed before the event can be saved.',classes:'border-red-200 bg-red-50/50',badge:'bg-red-100 text-red-700'},optional:{title:'Optional Event Details',description:'Complete these fields only when this event needs them.',classes:'border-blue-200 bg-blue-50/40',badge:'bg-blue-100 text-blue-700'},conditional:{title:'Applicable Event Details',description:'These fields appear automatically for the selected event type and result method.',classes:'border-amber-200 bg-amber-50/50',badge:'bg-amber-100 text-amber-700'}};
let eventFieldStatusFilter='all';
const eventFieldRulesFromDom=()=>eventFieldRulesForMode(masterValue('master-event-management')||festSetup.eventManagementMode).map(field=>({...field,requirement:document.querySelector(`[data-event-field-rule="${field.key}"]`)?.value||field.requirement}));
window.setEventFieldStatusFilter=status=>{eventFieldStatusFilter=status||'all';document.querySelectorAll('[data-event-status-filter]').forEach(button=>{const active=button.dataset.eventStatusFilter===eventFieldStatusFilter;button.classList.toggle('bg-indigo-600',active);button.classList.toggle('text-white',active);button.classList.toggle('bg-slate-100',!active);});window.filterEventFieldRules();};
window.filterEventFieldRules=()=>{const query=String(document.getElementById('master-event-field-search')?.value||'').trim().toLowerCase(),cards=[...document.querySelectorAll('[data-event-field-card]')];let visible=0;cards.forEach(card=>{const matchesText=!query||card.dataset.search.includes(query),matchesStatus=eventFieldStatusFilter==='all'||card.querySelector('[data-event-field-rule]')?.value===eventFieldStatusFilter||card.dataset.lockedStatus===eventFieldStatusFilter,show=matchesText&&matchesStatus;card.classList.toggle('hidden',!show);if(show)visible++;});const count=document.getElementById('master-event-field-count'),empty=document.getElementById('master-event-field-empty');if(count)count.textContent=`Showing ${visible} of ${cards.length} fields`;empty?.classList.toggle('hidden',visible!==0);};
window.renderEventFieldRules=()=>{const box=document.getElementById('master-event-field-rules');if(!box)return;document.querySelectorAll('[data-profile-card]').forEach(card=>{const active=card.dataset.profileCard===festSetup.eventManagementMode;card.classList.toggle('ring-2',active);card.classList.toggle('ring-indigo-500',active);card.setAttribute('aria-pressed',String(active));});const styleEventFieldCard=(card,status)=>{if(!card)return;card.dataset.requirement=status;for(const cls of ['border-slate-200','bg-slate-50','border-blue-200','bg-blue-50/40','border-red-200','bg-red-50/40','border-amber-200','bg-amber-50/40'])card.classList.remove(cls);const classes={hidden:['border-slate-200','bg-slate-50'],optional:['border-blue-200','bg-blue-50/40'],required:['border-red-200','bg-red-50/40'],conditional:['border-amber-200','bg-amber-50/40']}[status]||[];card.classList.add(...classes);};const rules=eventFieldRulesForMode(festSetup.eventFieldProfile==='custom'?festSetup.eventManagementMode:festSetup.eventFieldProfile,festSetup.eventFieldRules),core=CORE_EVENT_FIELDS.map(field=>`<article data-event-field-card data-locked-status="required" data-search="${escapeHtml(`${field.label} ${field.key} required core`.toLowerCase())}" class="grid grid-cols-[1fr_150px] items-center gap-3 rounded-xl border border-red-100 bg-red-50/40 p-3"><span><b class="block text-xs">${escapeHtml(field.label)}</b><small class="text-[9px] font-bold uppercase text-red-500">core field</small></span><span class="rounded-lg bg-red-100 p-2 text-center text-xs font-black text-red-700">Always required · Locked</span></article>`).join('')+`<article data-event-field-card data-locked-status="conditional" data-search="group size members applicable core" class="grid grid-cols-[1fr_150px] items-center gap-3 rounded-xl border border-amber-100 bg-amber-50/40 p-3"><span><b class="block text-xs">Members per Group</b><small class="text-[9px] font-bold uppercase text-amber-600">group events</small></span><span class="rounded-lg bg-amber-100 p-2 text-center text-xs font-black text-amber-700">When applicable · Locked</span></article>`;box.innerHTML=core+rules.map(field=>`<label data-event-field-card data-search="${escapeHtml(`${field.label} ${field.key} ${field.minimumMode} ${field.requirement}`.toLowerCase())}" class="grid grid-cols-[1fr_150px] items-center gap-3 rounded-xl border bg-white p-3"><span><b class="block text-xs">${escapeHtml(field.label)}</b><small class="text-[9px] font-bold uppercase text-slate-400">${field.minimumMode}</small></span><select data-event-field-rule="${field.key}" class="rounded-lg border p-2 text-xs font-bold"><option value="hidden" ${field.requirement==='hidden'?'selected':''}>Hidden</option><option value="optional" ${field.requirement==='optional'?'selected':''}>Optional</option><option value="required" ${field.requirement==='required'?'selected':''}>Always required</option><option value="conditional" ${field.requirement==='conditional'?'selected':''}>When applicable</option></select></label>`).join('');box.querySelectorAll('[data-event-field-rule]').forEach(select=>styleEventFieldCard(select.closest('[data-event-field-card]'),select.value));box.querySelectorAll('[data-event-field-rule]').forEach(select=>select.addEventListener('change',()=>{const card=select.closest('[data-event-field-card]');styleEventFieldCard(card,select.value);card.dataset.search=`${card.textContent} ${select.value}`.toLowerCase();window.filterEventFieldRules();}));window.filterEventFieldRules();};
const eventFieldApplicable=(key,prefix)=>{const type=masterValue(`${prefix}-ev-type`)||'Single',method=masterValue(`${prefix}-ev-result-method`)||'manual';return({minimumMembers:type==='Group',maximumMembers:type==='Group',criteriaText:method==='criteria',correctMark:method==='objective',wrongPenalty:method==='objective',countPenalty:method==='count',timeDirection:method==='time',maximumMark:['manual','criteria','objective','count'].includes(method),tieBreakMethod:['criteria','time','count','elimination'].includes(method),gradeMode:method!=='display_only',scoreContribution:method!=='display_only',scoringPolicy:method!=='display_only',multipleJudgeMethod:festSetup.eventFeatures?.multipleJudges!==false,duration:festSetup.scheduleMode==='full',preparationTime:festSetup.scheduleMode==='full',scheduleRequirement:festSetup.scheduleMode!=='disabled',teamPolicy:festSetup.organisationMode!=='open',resultWorkflow:festSetup.resultWorkflow==='hybrid'})[key]??true;};
const eventFieldWrapper=(input,prefix,key)=>{if(!input)return null;if(input.matches?.('[data-checkbox-group]'))return input;if(key==='stage')return input.closest('fieldset')||input.closest('.space-y-1\\.5');if(key==='name'&&prefix==='inp')return input.closest('.space-y-1\\.5')||input.parentElement;if(key==='type'||key==='entriesPerTeam'||key==='category'||key==='gender'||key==='name')return input.closest('.space-y-1')||input.closest('.space-y-1\\.5')||input.parentElement;return input.closest('label,.input-group')||input.parentElement;};
function ensureEventRequirementLayout(prefix){const form=document.getElementById(prefix==='inp'?'form-event':'edit-event-form');if(!form)return null;let layout=document.getElementById(`${prefix}-event-requirement-layout`);if(layout)return layout;layout=document.createElement('div');layout.id=`${prefix}-event-requirement-layout`;layout.className=prefix==='edit'?'grid gap-4 md:col-span-2':'space-y-4';layout.innerHTML=Object.entries(EVENT_REQUIREMENT_META).map(([status,meta])=>`<section data-event-requirement-section="${status}" class="rounded-2xl border p-4 ${meta.classes}"><header class="mb-3 flex items-start justify-between gap-3"><div><h4 class="font-black text-slate-900">${meta.title}</h4><p class="text-[11px] font-semibold text-slate-500">${meta.description}</p></div><span data-event-requirement-count class="rounded-full px-2 py-1 text-[9px] font-black uppercase ${meta.badge}"></span></header><div data-event-requirement-grid class="grid gap-3 md:grid-cols-2 lg:grid-cols-3"></div></section>`).join('')+`<div data-event-hidden-storage class="hidden"></div>`;if(prefix==='inp'){const host=document.getElementById('event-single-fields');host?.append(layout);}else document.querySelector('#edit-event-form .overflow-y-auto .grid')?.append(layout);return layout;}
const syncEventGroupFields=prefix=>{const type=masterValue(`${prefix}-ev-type`)||'Single',groupVisible=type==='Group',groupInput=document.getElementById(prefix==='inp'?'inp-ev-grpsize':'edit-ev-grp'),groupWrap=document.getElementById(prefix==='inp'?'event-config-panel':'edit-event-config-panel');if(!groupWrap||!groupInput)return;groupWrap.classList.toggle('hidden',!groupVisible);groupWrap.setAttribute('aria-hidden',String(!groupVisible));groupInput.disabled=!groupVisible;groupInput.required=groupVisible;if(groupVisible&&Number(groupInput.value)<2)groupInput.value=2;};
window.renderEventFormRequirements=prefix=>{const layout=ensureEventRequirementLayout(prefix);if(!layout)return;const rules=new Map((festSetup.eventFieldRules||[]).map(field=>[field.key,field.requirement])),place=(key,input,status)=>{const wrap=eventFieldWrapper(input,prefix,key);if(!wrap)return;wrap.dataset.eventLayoutField=key;wrap.classList.remove('hidden');wrap.classList.add('min-w-0','max-w-full');if(status==='hidden'||(status==='conditional'&&!eventFieldApplicable(key,prefix))){layout.querySelector('[data-event-hidden-storage]')?.append(wrap);wrap.classList.add('hidden');input.required=false;return;}layout.querySelector(`[data-event-requirement-section="${status}"] [data-event-requirement-grid]`)?.append(wrap);input.required=status==='required'||status==='conditional';const label=wrap.querySelector('.input-label,label,legend');let mark=wrap.querySelector('[data-event-required-mark]');if(input.required&&!mark&&label){mark=document.createElement('span');mark.dataset.eventRequiredMark='true';mark.className='ml-1 text-red-500';mark.textContent='*';label.append(mark);}else if(!input.required)mark?.remove();};for(const field of CORE_EVENT_FIELDS){const input=field.key==='stage'?document.querySelector(`input[name="${prefix==='inp'?'ev-stage':'edit-ev-stage'}"]`):document.getElementById(`${prefix}-${field.suffix}`);place(field.key,input,'required');}for(const[key,suffix]of Object.entries(EVENT_FORM_FIELD_IDS))place(key,document.getElementById(`${prefix}-${suffix}`),rules.get(key)||'hidden');const groupWrap=document.getElementById(prefix==='inp'?'event-config-panel':'edit-event-config-panel');if(groupWrap){groupWrap.dataset.eventLayoutField='groupSize';layout.querySelector('[data-event-requirement-section="required"] [data-event-requirement-grid]')?.append(groupWrap);}syncEventGroupFields(prefix);layout.querySelectorAll('[data-event-requirement-section]').forEach(section=>{const visible=[...section.querySelectorAll('[data-event-layout-field]')].filter(item=>!item.classList.contains('hidden')).length;section.classList.toggle('hidden',visible===0);const count=section.querySelector('[data-event-requirement-count]');if(count)count.textContent=`${visible} field${visible===1?'':'s'}`;});if(prefix==='inp'){const bulk=document.getElementById('inp-ev-bulk-names'),single=document.getElementById('inp-ev-name'),bulkEnabled=bulk&&!bulk.classList.contains('hidden');if(single)single.required=!bulkEnabled;if(bulk)bulk.required=!!bulkEnabled;}const legacy=document.getElementById(prefix==='inp'?'create-event-legacy-layout':'edit-event-legacy-layout');legacy?.classList.add('hidden');};
const applyEventFieldRules=()=>{for(const prefix of ['inp','edit'])window.renderEventFormRequirements(prefix);};
window.renderStudentFieldSettings = () => {
    const box=document.getElementById('student-field-settings');if(!box)return;
    box.innerHTML=normalizeStudentFields(festSetup.studentFields).map(field=>`<div class="grid items-center gap-2 rounded-xl border bg-slate-50 p-3 sm:grid-cols-[1fr_auto_auto_auto]"><div><b class="text-sm text-slate-800">${escapeHtml(field.label)}</b><p class="text-[10px] font-bold uppercase text-slate-400">${field.key} • ${field.type}</p>${field.type==='select'?`<input data-student-field-options="${field.key}" value="${escapeHtml((field.options||[]).join(', '))}" placeholder="Choices, comma separated" class="mt-2 w-full rounded-lg border bg-white px-2 py-1.5 text-xs">`:''}</div><label class="text-xs font-bold"><input data-student-field-enabled="${field.key}" type="checkbox" ${field.enabled?'checked':''} ${field.key==='name'?'disabled':''}> Enabled</label><label class="text-xs font-bold"><input data-student-field-required="${field.key}" type="checkbox" ${field.required?'checked':''} ${field.key==='name'?'disabled':''}> Required</label>${field.system?'<span class="text-[10px] font-black text-slate-400">BUILT IN</span>':`<span class="flex gap-2"><button data-admin-action="edit-student-field" data-key="${field.key}" class="text-xs font-black text-indigo-600">Edit</button><button data-admin-action="remove-student-field" data-key="${field.key}" class="text-xs font-black text-red-600">Delete</button></span>`}</div>`).join('');
};
window.addStudentField = () => {const input=document.getElementById('new-student-field-label'),label=input?.value.trim(),type=document.getElementById('new-student-field-type')?.value||'text',options=(document.getElementById('new-student-field-options')?.value||'').split(',').map(value=>value.trim()).filter(Boolean);if(!label)return window.showToast('Enter a field label','error');if(type==='select'&&!options.length)return window.showToast('Add at least one dropdown choice','error');const key=label.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');if(!key)return window.showToast('Use an English field key/label','error');if(normalizeStudentFields(festSetup.studentFields).some(field=>field.key===key))return window.showToast('That field already exists','error');festSetup={...festSetup,studentFields:[...normalizeStudentFields(festSetup.studentFields),{key,label,type,options,enabled:true,required:false}]};input.value='';document.getElementById('new-student-field-options').value='';window.renderStudentFieldSettings();};
window.editStudentField=async key=>{const fields=normalizeStudentFields(festSetup.studentFields),field=fields.find(item=>item.key===key);if(!field||field.system)return;const label=(await window.promptAction('Field label',field.label))?.trim();if(!label)return;festSetup={...festSetup,studentFields:fields.map(item=>item.key===key?{...item,label}:item)};window.renderStudentFieldSettings();};
window.removeStudentField = key => {festSetup={...festSetup,studentFields:normalizeStudentFields(festSetup.studentFields).filter(field=>field.key!==key)};window.renderStudentFieldSettings();};

let studentImportRows=[];
let studentImportHeaders=[];
let studentImportMatrix=[];
let studentImportMapping=[];
const normalizeCell=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const lookupCanonical=(value,choices)=>choices.find(choice=>choice.toLocaleLowerCase()===normalizeCell(value).toLocaleLowerCase())||normalizeCell(value);
const studentImportColumns=()=>[{key:'name',label:'Student Name',required:true},{key:'team',label:'Team',required:true},{key:'category',label:'Category',required:true},{key:'gender',label:'Gender',required:true},{key:'chestNo',label:'Chest No',required:false},...enabledStudentFields().filter(field=>field.key!=='name').map(field=>({key:field.key,label:field.label,required:field.required}))];
window.openStudentTemplate=()=>{const box=document.getElementById('student-template-fields');box.innerHTML=studentImportColumns().map(column=>`<label class="rounded-xl border bg-slate-50 p-3 text-sm font-bold"><input type="checkbox" data-template-field="${column.key}" ${column.required||column.key==='chestNo'?'checked':''} ${column.required?'disabled':''} class="mr-2">${escapeHtml(column.label)}${column.required?' <span class="text-red-500">*</span>':''}</label>`).join('');document.getElementById('student-template-modal').classList.remove('hidden');};
window.closeStudentTemplate=()=>document.getElementById('student-template-modal').classList.add('hidden');
window.downloadStudentTemplate=()=>{if(!window.XLSX)return window.showToast('Excel tools are still loading','error');const selected=[...document.querySelectorAll('[data-template-field]:checked')].map(input=>input.dataset.templateField),columns=studentImportColumns().filter(column=>selected.includes(column.key)),headers=columns.map(column=>column.label),book=XLSX.utils.book_new(),studentSheet=XLSX.utils.aoa_to_sheet([headers]);studentSheet['!cols']=columns.map(column=>({wch:Math.max(14,column.label.length+3)}));const exampleNames=['Amina Fathima','Muhammed Adil','Nandana Krishnan'],examples=exampleNames.map((name,index)=>Object.fromEntries(columns.map(column=>[column.label,column.key==='name'?name:column.key==='team'?(teams[index%Math.max(teams.length,1)]||'Configure Team'):column.key==='category'?(categories.filter(value=>value!=='General')[index%Math.max(categories.filter(value=>value!=='General').length,1)]||'Configure Category'):column.key==='gender'?(festSetup.allowedGenders[index%festSetup.allowedGenders.length]||'Boys'):column.key==='chestNo'?(index===0?101:''):column.key==='class'?((enabledStudentFields().find(field=>field.key==='class')?.options||[])[index]||'Configure Class'):column.key==='guardianName'?['Abdul Rahman','Shameer','Rajesh'][index]:column.key==='phone'?`98765432${10+index}`:(enabledStudentFields().find(field=>field.key===column.key)?.options||[])[0]||'Example']))),exampleSheet=XLSX.utils.json_to_sheet(examples,{header:headers}),studentCategories=categories.filter(value=>value!=='General'),max=Math.max(teams.length,studentCategories.length,festSetup.allowedGenders.length,1),validRows=Array.from({length:max},(_,index)=>({Teams:teams[index]||'',Categories:studentCategories[index]||'',Genders:festSetup.allowedGenders[index]||'',Classes:(enabledStudentFields().find(field=>field.key==='class')?.options||[])[index]||''})),validSheet=XLSX.utils.json_to_sheet(validRows);XLSX.utils.book_append_sheet(book,studentSheet,'Students');XLSX.utils.book_append_sheet(book,exampleSheet,'Examples - Do Not Import');XLSX.utils.book_append_sheet(book,validSheet,'Valid Values');XLSX.writeFile(book,'Student_Import_Model.xlsx');window.closeStudentTemplate();};
window.openStudentImport=()=>{studentImportRows=[];studentImportHeaders=[];studentImportMatrix=[];studentImportMapping=[];document.getElementById('student-import-file').value='';['student-import-summary','student-import-errors','student-import-table-wrap'].forEach(id=>document.getElementById(id).classList.add('hidden'));document.getElementById('confirm-student-import').disabled=true;document.getElementById('student-import-modal').classList.remove('hidden');window.lucide?.createIcons?.();};
window.closeStudentImport=()=>{studentImportRows=[];studentImportMatrix=[];document.getElementById('student-import-modal').classList.add('hidden');};
const suggestedImportKey=heading=>{const clean=normalizeCell(heading).toLocaleLowerCase().replace(/[^a-z0-9]+/g,'');return studentImportColumns().find(column=>[column.key,column.label].some(value=>value.toLocaleLowerCase().replace(/[^a-z0-9]+/g,'')===clean))?.key||'';};
const rebuildImportRows=()=>{studentImportRows=studentImportMatrix.slice(1).map(values=>{const row={skip:false};studentImportMapping.forEach((key,index)=>{if(key)row[key]=normalizeCell(values[index]);});row.name=normalizeCell(row.name);row.team=lookupCanonical(row.team,teams);row.category=lookupCanonical(row.category,categories);row.gender=lookupCanonical(row.gender,festSetup.allowedGenders);return row;}).filter(row=>Object.entries(row).some(([key,value])=>key!=='skip'&&normalizeCell(value)));window.renderStudentImport();};
const normalizeChestCode=value=>String(value??'').trim();
const validChestCode=value=>/^[A-Za-z0-9_-]{1,32}$/.test(normalizeChestCode(value));
const allocateImportChestNumbers=()=>{const groups=new Map();const state=row=>{const key=`${row.team}|${row.category}|${row.gender}`;if(!groups.has(key)){groups.set(key,{used:new Set(students.filter(student=>student.team===row.team&&student.category===row.category&&studentGender(student)===row.gender).map(student=>normalizeChestCode(student.chestNo)).filter(Boolean)),next:Number(window.generateChestNo(row.team,row.category,row.gender)||0)});}return groups.get(key);};studentImportRows.forEach(row=>{row.chestError='';row.assignedChestNo=null;if(row.skip||!row.team||!row.category||!row.gender)return;const group=state(row),provided=normalizeChestCode(row.chestNo);if(provided){if(!validChestCode(provided))row.chestError='Chest No may contain only English letters, numbers, hyphens or underscores';else if(group.used.has(provided))row.chestError=`Chest No ${provided} is already used`;else{row.assignedChestNo=provided;row.chestSource='Excel';group.used.add(provided);}}});studentImportRows.forEach(row=>{if(row.skip||row.assignedChestNo||row.chestError||!row.team||!row.category||!row.gender)return;const group=state(row);if(!group.next){row.chestError='Chest number setup missing';return;}while(group.used.has(String(group.next)))group.next++;row.assignedChestNo=group.next;row.chestSource='Auto';group.used.add(String(group.next++));});};
const validateImportRow=(row,index)=>{const errors=[];enabledStudentFields().filter(field=>field.required).forEach(field=>{if(!normalizeCell(row[field.key]))errors.push(`${field.label} is required`);});enabledStudentFields().filter(field=>field.type==='select'&&normalizeCell(row[field.key])).forEach(field=>{if(!(field.options||[]).includes(row[field.key]))errors.push(`Unknown ${field.label}`);});if(!teams.includes(row.team))errors.push('Unknown team');if(!categories.includes(row.category)||row.category==='General')errors.push('Unknown category');if(!festSetup.allowedGenders.includes(row.gender))errors.push('Unknown gender');if(row.chestError)errors.push(row.chestError);const duplicate=students.some(student=>normalizeCell(student.name).toLocaleLowerCase()===row.name.toLocaleLowerCase()&&student.team===row.team&&student.category===row.category);if(duplicate)errors.push('Already exists');const repeated=studentImportRows.findIndex((other,i)=>i<index&&!other.skip&&other.name.toLocaleLowerCase()===row.name.toLocaleLowerCase()&&other.team===row.team&&other.category===row.category);if(repeated>=0)errors.push(`Duplicate of row ${repeated+2}`);return errors;};
const importSelect=(index,key,value,choices,label)=>{const valid=choices.includes(value),options=choices.map(choice=>`<option value="${escapeHtml(choice)}" ${choice===value?'selected':''}>${escapeHtml(choice)}</option>`).join('');return `<select data-import-row="${index}" data-import-key="${key}" class="min-w-32 rounded-lg border ${valid?'bg-white':'border-red-300 bg-red-50'} px-2 py-1.5"><option value="">Select ${escapeHtml(label)}</option>${!valid&&value?`<option value="${escapeHtml(value)}" selected>⚠ ${escapeHtml(value)}</option>`:''}${options}</select>`;};
const importCellControl=(row,index,column)=>{const value=row[column.key]||'';if(column.key==='team')return importSelect(index,'team',value,teams,'Team');if(column.key==='category')return importSelect(index,'category',value,categories.filter(item=>item!=='General'),'Category');if(column.key==='gender')return importSelect(index,'gender',value,festSetup.allowedGenders,'Gender');if(column.key==='chestNo')return `<input type="text" maxlength="32" autocomplete="off" autocapitalize="off" data-import-row="${index}" data-import-key="chestNo" value="${escapeHtml(value)}" placeholder="Auto: ${row.assignedChestNo||'-'}" class="w-24 rounded-lg border bg-white px-2 py-1.5"><span class="ml-1 text-[9px] font-black ${row.chestSource==='Auto'?'text-blue-600':'text-emerald-600'}">${row.assignedChestNo||'-'} ${row.chestSource||''}</span>`;const field=enabledStudentFields().find(item=>item.key===column.key);if(field?.type==='select')return importSelect(index,column.key,value,field.options||[],field.label);return `<input type="${field?.type||'text'}" data-import-row="${index}" data-import-key="${column.key}" value="${escapeHtml(value)}" class="min-w-32 rounded-lg border bg-white px-2 py-1.5">`;};
window.renderStudentImport=()=>{allocateImportChestNumbers();studentImportRows.forEach((row,index)=>row.errors=validateImportRow(row,index));const valid=studentImportRows.filter(row=>!row.skip&&!row.errors.length),invalid=studentImportRows.filter(row=>!row.skip&&row.errors.length),skipped=studentImportRows.filter(row=>row.skip),teamCount=new Set(valid.map(row=>row.team)).size,categoryCount=new Set(valid.map(row=>row.category)).size;const summary=document.getElementById('student-import-summary');summary.classList.remove('hidden');summary.innerHTML=[[studentImportRows.length,'Rows'],[valid.length,'Ready'],[invalid.length,'Errors'],[skipped.length,'Skipped'],[teamCount,'Teams'],[categoryCount,'Categories']].map(([value,label])=>`<div class="rounded-xl border bg-slate-50 p-3"><b class="block text-xl text-slate-900">${value}</b><span class="text-[10px] font-black uppercase text-slate-500">${label}</span></div>`).join('');const columns=studentImportColumns(),mappingOptions=studentImportHeaders.map((heading,index)=>`<option value="${index}">${escapeHtml(heading||`Column ${index+1}`)}</option>`).join('');document.getElementById('student-import-head').innerHTML=`<tr><th class="p-3">Skip</th><th class="p-3">Status</th>${columns.map(column=>{const sourceIndex=studentImportMapping.indexOf(column.key);return `<th class="min-w-40 p-2"><span class="mb-1 block text-[10px] font-black uppercase text-slate-500">${escapeHtml(column.label)}</span><select data-import-target="${column.key}" class="w-full rounded-lg border bg-white px-2 py-1.5 font-semibold"><option value="">Not mapped</option>${mappingOptions.replace(`value="${sourceIndex}"`,`value="${sourceIndex}" selected`)}</select></th>`;}).join('')}</tr>`;document.getElementById('student-import-body').innerHTML=studentImportRows.map((row,index)=>`<tr class="${row.errors.length?'bg-red-50':row.skip?'bg-slate-100 opacity-60':'bg-white'}"><td class="p-2"><input data-import-skip="${index}" type="checkbox" ${row.skip?'checked':''}></td><td class="max-w-48 p-2 font-bold ${row.errors.length?'text-red-600':'text-emerald-600'}">${row.skip?'Skipped':row.errors.join('; ')||'Ready'}</td>${columns.map(column=>`<td class="p-2">${importCellControl(row,index,column)}</td>`).join('')}</tr>`).join('');document.getElementById('student-import-table-wrap').classList.remove('hidden');const errors=document.getElementById('student-import-errors');errors.classList.toggle('hidden',!invalid.length);errors.textContent=invalid.length?`${invalid.length} row(s) need correction. Select valid database values or skip the row. The heading row is never imported.`:'';document.getElementById('confirm-student-import').disabled=!valid.length||invalid.length>0;};
document.getElementById('student-import-file')?.addEventListener('change',async event=>{const file=event.target.files[0];if(!file||!window.XLSX)return;try{const book=XLSX.read(await file.arrayBuffer(),{type:'array'}),sheet=book.Sheets[book.SheetNames[0]];studentImportMatrix=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',blankrows:false});if(studentImportMatrix.length<2)throw new Error('The file has a heading row but no student rows');studentImportHeaders=studentImportMatrix[0].map(normalizeCell);studentImportMapping=studentImportHeaders.map(suggestedImportKey);rebuildImportRows();}catch(error){console.error(error);window.showToast(error.message||'Unable to read this spreadsheet','error');}});
document.getElementById('student-import-head')?.addEventListener('change',event=>{const key=event.target.dataset.importTarget;if(!key)return;studentImportMapping=studentImportMapping.map(value=>value===key?'':value);if(event.target.value!=='')studentImportMapping[Number(event.target.value)]=key;rebuildImportRows();});
document.getElementById('student-import-body')?.addEventListener('change',event=>{const index=Number(event.target.dataset.importRow);if(!Number.isInteger(index))return;const key=event.target.dataset.importKey;let value=normalizeCell(event.target.value);if(key==='team')value=lookupCanonical(value,teams);if(key==='category')value=lookupCanonical(value,categories);if(key==='gender')value=lookupCanonical(value,festSetup.allowedGenders);studentImportRows[index][key]=value;window.renderStudentImport();});
document.getElementById('student-import-body')?.addEventListener('change',event=>{if(event.target.dataset.importSkip===undefined)return;studentImportRows[Number(event.target.dataset.importSkip)].skip=event.target.checked;window.renderStudentImport();});
window.confirmStudentImport=async()=>{allocateImportChestNumbers();const ready=studentImportRows.filter(row=>!row.skip&&!validateImportRow(row,studentImportRows.indexOf(row)).length);if(!ready.length)return;const button=document.getElementById('confirm-student-import');button.disabled=true;button.textContent='Importing…';try{let completed=0;for(let offset=0;offset<ready.length;offset+=400){const batch=writeBatch(db),chunk=ready.slice(offset,offset+400);chunk.forEach(row=>{const details=Object.fromEntries(enabledStudentFields().filter(field=>field.key!=='name').map(field=>[field.key,row[field.key]||'']));batch.set(doc(collection(db,'students')),{name:row.name,team:row.team,category:row.category,gender:row.gender,chestNo:row.assignedChestNo,details,importedAt:Date.now()});});await batch.commit();completed+=chunk.length;button.textContent=`Imported ${completed}/${ready.length}`;}await addDoc(collection(db,'auditLogs'),{action:'student_excel_import',count:ready.length,createdAt:Date.now(),uid:auth.currentUser?.uid||''});window.showToast(`${ready.length} students imported`);window.closeStudentImport();}catch(error){console.error(error);window.showToast(error.message||'Import failed','error');button.disabled=false;button.textContent='Import Students';}};

let eventImportRows=[],eventImportHeaders=[],eventImportMatrix=[],eventImportMapping=[],eventImportFileName='',eventImportBook=null,eventCriteriaEditIndex=-1;
const eventValidValues=()=>({Categories:categories,Genders:[...festSetup.allowedGenders,'Both','Mixed'],Stages:['On-Stage','Off-Stage'],Types:['Single','Group'],'Result Methods':RESULT_METHODS,'Participant Types':festSetup.participantTypes,'Registration Channels':festSetup.registrationChannels});
const eventFieldRuleMap=()=>new Map((festSetup.eventFieldRules||[]).map(rule=>[rule.key,rule.requirement]));
const visibleEventImportColumns=()=>{const rules=eventFieldRuleMap();return EVENT_IMPORT_COLUMNS.filter(column=>column.required||rules.get(column.key)!=='hidden');};
const visibleEventImportColumnKeys=()=>new Set(visibleEventImportColumns().map(column=>column.key));
window.openEventTemplate=()=>{const box=document.getElementById('event-template-fields'),rules=eventFieldRuleMap(),columns=visibleEventImportColumns();box.innerHTML=columns.map(column=>{const required=column.required||rules.get(column.key)==='required';return `<label class="rounded-xl border bg-slate-50 p-3 text-sm font-bold"><input type="checkbox" data-event-template-field="${column.key}" ${required?'checked disabled':'checked'} class="mr-2">${escapeHtml(column.label)}${required?' <span class="text-red-500">*</span>':''}</label>`}).join('');document.getElementById('event-template-modal').classList.remove('hidden');};
window.closeEventTemplate=()=>document.getElementById('event-template-modal').classList.add('hidden');
window.downloadEventTemplate=()=>{if(!window.XLSX)return window.showToast('Excel tools are still loading','error');const selected=[...document.querySelectorAll('[data-event-template-field]:checked')].map(input=>input.dataset.eventTemplateField),visibleKeys=visibleEventImportColumnKeys(),columns=EVENT_IMPORT_COLUMNS.filter(column=>visibleKeys.has(column.key)&&selected.includes(column.key)),headers=columns.map(column=>column.label),book=XLSX.utils.book_new(),eventsSheet=XLSX.utils.aoa_to_sheet([headers]);eventsSheet['!cols']=columns.map(column=>({wch:Math.max(16,column.label.length+3)}));const examples=[{name:'Malayalam Speech',category:categories[0]||'Junior',gender:'Boys',stage:'On-Stage',type:'Single',entriesPerTeam:2,resultMethod:'criteria',maximumMark:100,criteriaText:'Language - 20\nContent - 40\nPresentation - 40'},{name:'Group Song',category:categories[1]||categories[0]||'Senior',gender:'Both',stage:'On-Stage',type:'Group',entriesPerTeam:'6x1',resultMethod:'criteria',maximumMark:100,criteriaText:'Music - 40\nLanguage - 20\nPresentation - 40'},{name:'Digital Quiz',category:'General',gender:'Both',stage:'Off-Stage',type:'Group',entriesPerTeam:'3x1',resultMethod:'objective',maximumMark:100},{name:'Slow Cycling',category:'General',gender:'Both',stage:'On-Stage',type:'Single',entriesPerTeam:2,resultMethod:'time',maximumMark:100}].map(row=>Object.fromEntries(columns.map(column=>[column.label,row[column.key]??'']))),exampleSheet=XLSX.utils.json_to_sheet(examples,{header:headers}),values=eventValidValues(),length=Math.max(...Object.values(values).map(list=>list.length),1),validSheet=XLSX.utils.json_to_sheet(Array.from({length},(_,index)=>Object.fromEntries(Object.entries(values).map(([name,list])=>[name,list[index]||''])))),instructions=XLSX.utils.json_to_sheet(columns.map(column=>({Field:column.label,Required:(column.required||(festSetup.eventFieldRules||[]).some(rule=>rule.key===column.key&&rule.requirement==='required'))?'Yes':'No',Usage:column.key==='criteriaText'?'One criterion per line: Name - Mark':column.key==='entriesPerTeam'?'Individual: 3; Group: 5x1 or 2x2':'Use Valid Values where applicable'})));XLSX.utils.book_append_sheet(book,eventsSheet,'Events');XLSX.utils.book_append_sheet(book,exampleSheet,'Examples - Do Not Import');XLSX.utils.book_append_sheet(book,validSheet,'Valid Values');XLSX.utils.book_append_sheet(book,instructions,'Instructions');XLSX.writeFile(book,'Event_Import_Model.xlsx');window.closeEventTemplate();};
window.exportEvents=()=>{if(!window.XLSX)return;const rows=events.map(event=>Object.fromEntries(visibleEventImportColumns().map(column=>[column.label,column.key==='criteriaText'?(event.criteria||[]).map(item=>`${item.name} - ${item.maximumMark}`).join('\n'):Array.isArray(event[column.key])?event[column.key].join(', '):event[column.key]??''])));const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'Events');XLSX.writeFile(book,'Existing_Events.xlsx');};
window.openEventImport=()=>{eventImportRows=[];eventImportHeaders=[];eventImportMatrix=[];eventImportMapping=[];eventImportFileName='';eventImportBook=null;document.getElementById('event-import-file').value='';document.getElementById('event-import-sheet').classList.add('hidden');['event-import-summary','event-import-errors','event-import-wrap'].forEach(id=>document.getElementById(id).classList.add('hidden'));document.getElementById('confirm-event-import').disabled=true;document.getElementById('event-import-modal').classList.remove('hidden');};
window.closeEventImport=()=>{eventImportRows=[];eventImportMatrix=[];document.getElementById('event-import-modal').classList.add('hidden');};
const rebuildEventImportRows=()=>{let context={};eventImportRows=[];eventImportMatrix.slice(1).forEach((values,rowIndex)=>{const raw={},visibleKeys=visibleEventImportColumnKeys();eventImportMapping.forEach((field,index)=>{if(field&&visibleKeys.has(field))raw[field]=values[index];});const hasRawData=Object.values(raw).some(value=>normalizeCell(value)),hasEventIdentity=normalizeCell(raw.name)||normalizeCell(raw.code);if(!hasEventIdentity){const heading=isEventHeadingRow(values);if(heading.isHeading){context={...context,...Object.fromEntries(Object.entries(heading.contexts).filter(([,value])=>value))};return;}}if(!hasRawData)return;const row=normalizeEventRow(raw,context);row.sourceRow=rowIndex+2;row.skip=false;eventImportRows.push(row);});window.renderEventImport();};
const eventImportValidation=(row,index)=>{const prior=eventImportRows.slice(0,index).filter(item=>!item.skip),duplicate=events.find(item=>(row.code&&item.code===row.code)||eventDuplicateKey(item)===eventDuplicateKey(row));row.duplicateExistingId=duplicate?.id||'';const existing=row.duplicateAction&&row.duplicateAction!=='unresolved'?prior:[...events,...prior],validation=validateEvent(row,{...festSetup,categories},existing);if(duplicate&&(!row.duplicateAction||row.duplicateAction==='unresolved'))validation.errors.unshift('Duplicate: choose Skip, Update or Merge');return validation;};
const eventSelect=(value,values,index,keyName)=>`<select data-event-row="${index}" data-event-key="${keyName}" class="min-w-32 rounded-lg border bg-white p-2 font-bold"><option value="">Select</option>${values.map(option=>`<option value="${escapeHtml(option)}" ${option===value?'selected':''}>${escapeHtml(option)}</option>`).join('')}</select>`;
window.renderEventImport=()=>{eventImportRows.forEach((row,index)=>row.validation=eventImportValidation(row,index));const ready=eventImportRows.filter(row=>!row.skip&&row.validation.status==='ready'),review=eventImportRows.filter(row=>!row.skip&&row.validation.status==='needs_review'),errors=eventImportRows.filter(row=>!row.skip&&row.validation.status==='error'),skipped=eventImportRows.filter(row=>row.skip),summary=document.getElementById('event-import-summary');summary.classList.remove('hidden');summary.innerHTML=[[eventImportRows.length,'Events'],[ready.length,'Ready'],[review.length,'Needs Review'],[errors.length,'Errors'],[skipped.length,'Skipped'],[new Set(eventImportRows.map(row=>row.category)).size,'Categories'],[new Set(eventImportRows.map(row=>row.resultMethod)).size,'Methods']].map(([value,label])=>`<div class="rounded-xl border bg-slate-50 p-3"><b class="block text-xl">${value}</b><span class="text-[10px] font-black uppercase text-slate-500">${label}</span></div>`).join('');const mappingOptions=eventImportHeaders.map((heading,index)=>`<option value="${index}">${escapeHtml(heading||`Column ${index+1}`)}</option>`).join('');document.getElementById('event-import-head').innerHTML=`<tr><th class="p-2">Skip</th><th class="p-2">Status</th>${visibleEventImportColumns().map(column=>{const sourceIndex=eventImportMapping.indexOf(column.key);return`<th class="min-w-44 p-2"><span class="block text-[10px] font-black uppercase">${escapeHtml(column.label)}</span><select data-event-import-target="${column.key}" class="w-full rounded border p-1"><option value="">Not mapped</option>${mappingOptions.replace(`value="${sourceIndex}"`,`value="${sourceIndex}" selected`)}</select></th>`}).join('')}</tr>`;document.getElementById('event-import-body').innerHTML=eventImportRows.map((row,index)=>`<tr class="${row.validation.status==='error'?'bg-red-50':row.validation.status==='needs_review'?'bg-amber-50':row.skip?'bg-slate-100 opacity-60':'bg-white'}"><td class="p-2"><input data-event-skip="${index}" type="checkbox" ${row.skip?'checked':''}></td><td class="max-w-64 p-2 font-bold"><div>${row.skip?'Skipped':[...row.validation.errors,...row.validation.warnings].join('; ')||'Ready'}</div>${row.duplicateExistingId?`<select data-event-row="${index}" data-event-key="duplicateAction" class="mt-2 w-full rounded border p-1 text-[10px]"><option value="unresolved">Resolve duplicate</option><option value="skip" ${row.duplicateAction==='skip'?'selected':''}>Skip</option><option value="update" ${row.duplicateAction==='update'?'selected':''}>Update existing Draft</option><option value="merge" ${row.duplicateAction==='merge'?'selected':''}>Merge missing fields</option><option value="separate" ${row.duplicateAction==='separate'?'selected':''}>Create separate copy</option></select>`:''}<button data-admin-action="open-event-criteria" data-index="${index}" class="mt-2 rounded bg-violet-50 px-2 py-1 text-[10px] text-violet-700">Edit Criteria (${(row.criteria||[]).length})</button></td>${visibleEventImportColumns().map(column=>{let control;if(column.key==='category')control=eventSelect(row.category,['General',...categories.filter(item=>item!=='General')],index,'category');else if(column.key==='gender')control=eventSelect(row.gender,[...festSetup.allowedGenders,'Both','Mixed'],index,'gender');else if(column.key==='stage')control=eventSelect(row.stage,['On-Stage','Off-Stage'],index,'stage');else if(column.key==='type')control=eventSelect(row.type,['Single','Group'],index,'type');else if(column.key==='resultMethod')control=eventSelect(row.resultMethod,RESULT_METHODS,index,'resultMethod');else control=`<input data-event-row="${index}" data-event-key="${column.key}" value="${escapeHtml(column.key==='criteriaText'?(row.criteria||[]).map(item=>`${item.name} - ${item.maximumMark}`).join('; '):Array.isArray(row[column.key])?row[column.key].join(', '):row[column.key]??'')}" class="min-w-36 rounded-lg border p-2">`;return`<td class="p-2">${control}</td>`}).join('')}</tr>`).join('');document.getElementById('event-import-wrap').classList.remove('hidden');const warning=document.getElementById('event-import-errors');warning.classList.toggle('hidden',!errors.length);warning.textContent=errors.length?`${errors.length} event row(s) contain errors. Correct or skip them. Heading/context rows are never imported.`:'';document.getElementById('confirm-event-import').disabled=!ready.length||errors.length>0;};
const loadEventImportSheet=name=>{const sheet=eventImportBook?.Sheets?.[name];if(!sheet)return;eventImportMatrix=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',blankrows:false});if(eventImportMatrix.length<2)throw new Error('The selected sheet has no event rows');eventImportHeaders=eventImportMatrix[0].map(normalizeCell);eventImportMapping=eventImportHeaders.map(heading=>{const field=suggestEventColumn(heading);return visibleEventImportColumnKeys().has(field)?field:'';});rebuildEventImportRows();};
document.getElementById('event-import-file')?.addEventListener('change',async event=>{const file=event.target.files[0];if(!file||!window.XLSX)return;try{eventImportBook=XLSX.read(await file.arrayBuffer(),{type:'array'});eventImportFileName=file.name;const select=document.getElementById('event-import-sheet');select.innerHTML=eventImportBook.SheetNames.map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');select.classList.toggle('hidden',eventImportBook.SheetNames.length<2);loadEventImportSheet(eventImportBook.SheetNames[0]);}catch(error){window.showToast(error.message||'Unable to read event spreadsheet','error');}});
document.getElementById('event-import-sheet')?.addEventListener('change',event=>{try{loadEventImportSheet(event.target.value);}catch(error){window.showToast(error.message,'error');}});
document.getElementById('event-import-head')?.addEventListener('change',event=>{const field=event.target.dataset.eventImportTarget;if(!field)return;eventImportMapping=eventImportMapping.map(value=>value===field?'':value);if(event.target.value!==''&&visibleEventImportColumnKeys().has(field))eventImportMapping[Number(event.target.value)]=field;rebuildEventImportRows();});
document.getElementById('event-import-body')?.addEventListener('change',event=>{if(event.target.dataset.eventSkip!==undefined){eventImportRows[Number(event.target.dataset.eventSkip)].skip=event.target.checked;return window.renderEventImport();}const index=Number(event.target.dataset.eventRow),field=event.target.dataset.eventKey;if(!Number.isInteger(index)||!field)return;if(field==='duplicateAction'){const row=eventImportRows[index];row.duplicateAction=event.target.value;if(row.duplicateAction==='skip')row.skip=true;if(row.duplicateAction==='separate'){row.code=eventCodeFor(row,index);row.name=`${row.name} (Copy)`;}return window.renderEventImport();}const raw={...eventImportRows[index],[field]:event.target.value};eventImportRows[index]=normalizeEventRow({...raw,criteriaText:field==='criteriaText'?event.target.value:(raw.criteria||[]).map(item=>`${item.name} - ${item.maximumMark}`).join('\n')});eventImportRows[index].sourceRow=raw.sourceRow;eventImportRows[index].skip=raw.skip;eventImportRows[index].duplicateAction=raw.duplicateAction;window.renderEventImport();});
const renderCriteriaEditor=()=>{const row=eventImportRows[eventCriteriaEditIndex];if(!row)return;document.getElementById('event-criteria-title').textContent=`${row.name} • Maximum ${row.maximumMark}`;document.getElementById('event-criteria-list').innerHTML=(row.criteria||[]).map((criterion,index)=>`<div data-criterion-editor-row class="grid grid-cols-[1fr_120px_44px] gap-2"><input data-criterion-name value="${escapeHtml(criterion.name)}" class="text-input"><input data-criterion-mark type="number" min="0" step="0.01" value="${Number(criterion.maximumMark||0)}" class="text-input"><button data-admin-click="remove-criterion-editor" data-index="${index}" class="rounded-xl bg-red-50 font-black text-red-600">×</button></div>`).join('');document.getElementById('event-criteria-total').textContent=`Criteria total: ${(row.criteria||[]).reduce((sum,item)=>sum+Number(item.maximumMark||0),0)} / ${row.maximumMark}`;};
window.openEventCriteria=index=>{eventCriteriaEditIndex=index;document.getElementById('event-criteria-modal').classList.remove('hidden');renderCriteriaEditor();};window.closeEventCriteria=()=>{eventCriteriaEditIndex=-1;document.getElementById('event-criteria-modal').classList.add('hidden');};window.addEventCriterion=()=>{eventImportRows[eventCriteriaEditIndex]?.criteria.push({key:`criterion_${eventImportRows[eventCriteriaEditIndex].criteria.length+1}`,name:'New Criterion',maximumMark:0,required:true});renderCriteriaEditor();};
document.getElementById('event-criteria-list')?.addEventListener('click',event=>{const button=event.target.closest('[data-admin-click="remove-criterion-editor"]');if(!button)return;eventImportRows[eventCriteriaEditIndex].criteria.splice(Number(button.dataset.index),1);renderCriteriaEditor();});
window.saveEventCriteria=()=>{const row=eventImportRows[eventCriteriaEditIndex],items=[...document.querySelectorAll('[data-criterion-editor-row]')];row.criteria=items.map((item,index)=>({key:`criterion_${index+1}`,name:item.querySelector('[data-criterion-name]').value.trim(),maximumMark:Number(item.querySelector('[data-criterion-mark]').value||0),required:true,order:index+1,tieBreakPriority:index+1})).filter(item=>item.name);row.criteriaUnparsed=[];window.closeEventCriteria();window.renderEventImport();};
window.downloadEventErrors=()=>{if(!window.XLSX)return;const rows=eventImportRows.filter(row=>!row.skip&&row.validation?.errors?.length).map(row=>({Row:row.sourceRow,Event:row.name,Errors:row.validation.errors.join('; '),Warnings:row.validation.warnings.join('; ')}));if(!rows.length)return window.showToast('No import errors to export','error');const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'Event Import Errors');XLSX.writeFile(book,'Event_Import_Errors.xlsx');};
window.renderEventImportHistory=async()=>{const box=document.getElementById('event-import-history');if(!box)return;try{const snap=await getDocs(collection(db,'eventImportSessions')),items=snap.docs.map(item=>({id:item.id,...item.data()})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,12);box.innerHTML=items.map(item=>`<article class="rounded-xl border bg-slate-50 p-3"><b class="text-sm">${escapeHtml(item.fileName||'Import')}</b><p class="text-[10px] font-bold text-slate-500">${new Date(item.createdAt||0).toLocaleString()} • ${item.ready||0} ready • ${item.needsReview||0} review</p></article>`).join('')||'<p class="text-xs font-bold text-slate-400">No event imports yet.</p>';}catch(error){box.innerHTML='<p class="text-xs font-bold text-red-500">Unable to load import history.</p>';}};
window.confirmEventImport=async()=>{const selected=eventImportRows.filter(row=>!row.skip&&row.validation.status!=='error');if(!selected.length)return;const button=document.getElementById('confirm-event-import');button.disabled=true;button.textContent='Importing…';try{const sessionRef=doc(collection(db,'eventImportSessions')),now=Date.now();await setDoc(sessionRef,{fileName:eventImportFileName,sheetName:document.getElementById('event-import-sheet').value||eventImportBook?.SheetNames?.[0]||'',totalRows:eventImportMatrix.length-1,eventRows:eventImportRows.length,ready:selected.filter(row=>row.validation.status==='ready').length,needsReview:selected.filter(row=>row.validation.status==='needs_review').length,mapping:eventImportMapping,createdAt:now,createdByUid:auth.currentUser?.uid||''});for(let offset=0;offset<selected.length;offset+=350){const batch=writeBatch(db),chunk=selected.slice(offset,offset+350);chunk.forEach((row,index)=>{row.code=row.code||eventCodeFor(row,offset+index);const data=eventToFirestore(row,{setup:festSetup,validation:row.validation,importMeta:{sessionId:sessionRef.id,fileName:eventImportFileName,sourceRow:row.sourceRow}}),existing=events.find(item=>item.id===row.duplicateExistingId);if(existing&&row.duplicateAction==='update'&&['draft','needs_review'].includes(existing.status||'draft'))batch.set(doc(db,'events',existing.id),data,{merge:false});else if(existing&&row.duplicateAction==='merge')batch.set(doc(db,'events',existing.id),Object.fromEntries(Object.entries(data).filter(([key,value])=>!existing[key]&&(value!==''&&value!==null))),{merge:true});else batch.set(doc(collection(db,'events')),data);});await batch.commit();button.textContent=`Imported ${Math.min(offset+350,selected.length)}/${selected.length}`;}await addDoc(collection(db,'auditLogs'),{action:'event_excel_import',sessionId:sessionRef.id,count:selected.length,createdAt:Date.now(),uid:auth.currentUser?.uid||''});window.showToast(`${selected.length} events imported`);window.closeEventImport();window.renderEventImportHistory();}catch(error){console.error(error);window.showToast(error.message||'Event import failed','error');button.disabled=false;button.textContent='Import Ready Events';}};

const optionalPolicyNumber=id=>{const value=document.getElementById(id)?.value;return value===''||value===undefined?null:Number(value);};
const competitionPoliciesFromForm=()=>{const group=readScoringConfigFromDom().configs.Group.points;return normalizeCompetitionPolicies({groupPositionPoints:{first:group[0]?.value??null,second:group[1]?.value??null,third:group[2]?.value??null},directRankGradeMode:masterValue('policy-direct-grade'),minimumPositionPolicy:masterValue('policy-min-position'),minimumPositionPercentage:optionalPolicyNumber('policy-min-position-value'),jointPositionMethod:masterValue('policy-joint-position'),multipleJudgeMethod:masterValue('policy-multi-judge'),trimMinimumJudges:optionalPolicyNumber('policy-trim-judges'),generalGenderMode:masterValue('policy-general-gender'),publishedCorrectionMode:masterValue('policy-result-correction')});};
window.updateCompetitionPolicyStatus=()=>{const policy=competitionPoliciesFromForm(),missing=incompleteCompetitionPolicies(policy),box=document.getElementById('competition-policy-status'),percentage=document.getElementById('policy-min-position-value'),trim=document.getElementById('policy-trim-judges');if(percentage)percentage.disabled=policy.minimumPositionPolicy!=='percentage';if(trim)trim.disabled=policy.multipleJudgeMethod!=='trim_extremes';if(box){box.className=`border-t px-5 py-3 text-xs font-bold ${missing.length?'border-amber-200 bg-amber-50 text-amber-800':'border-emerald-200 bg-emerald-50 text-emerald-800'}`;box.textContent=missing.length?`Policy setup incomplete: ${missing.join(' • ')}`:'Competition policies are fully configured.';}};
['policy-group-first','policy-group-second','policy-group-third','policy-direct-grade','policy-min-position','policy-min-position-value','policy-joint-position','policy-multi-judge','policy-trim-judges','policy-general-gender','policy-result-correction'].forEach(id=>document.getElementById(id)?.addEventListener('change',window.updateCompetitionPolicyStatus));

window.saveMasterSetup = async () => {
    if(activeMasterSection!=='review-activate'){
        window.switchMasterSection('review-activate');
        window.showToast('Review the complete setup before Save & Activate','error');
        return;
    }
    const selectedParticipantTypes=checkedValues('master-participants'),selectedGenders=checkedValues('master-genders'),selectedRegistrationChannels=checkedValues('master-registration');if(!selectedParticipantTypes.length)return window.showToast('At least one participant type is required. Enable another type before disabling Student.','error');
    const next = normalizeFestSetup({
        ...festSetup, preset:masterValue('master-preset'), organisationMode:masterValue('master-organisation'), scheduleMode:masterValue('master-schedule'), judgingMode:masterValue('master-judging'), resultWorkflow:masterValue('master-results'), teamScoringMode:masterValue('master-team-scoring'),eventManagementMode:masterValue('master-event-management'),eventFieldProfile:JSON.stringify(eventFieldRulesFromDom().map(({key,requirement})=>({key,requirement})))===JSON.stringify(eventFieldRulesForMode(masterValue('master-event-management')).map(({key,requirement})=>({key,requirement})))?masterValue('master-event-management'):'custom',eventFieldRules:eventFieldRulesFromDom(),eventFeatures:Object.fromEntries([...document.querySelectorAll('[data-master-event-feature]')].map(input=>[input.dataset.masterEventFeature,input.checked])),eligibleClasses:(document.querySelector('[data-student-field-options="class"]')?.value||'').split(',').map(value=>value.trim()).filter(Boolean),
        participantTypes:selectedParticipantTypes, allowedGenders:selectedGenders, registrationChannels:selectedRegistrationChannels,
        publicModules:Object.fromEntries([...document.querySelectorAll('[data-master-public]')].map(input=>[input.dataset.masterPublic,input.checked])),publicView:publicViewFromDom(),
        studentFields:normalizeStudentFields(festSetup.studentFields).map(field=>({...field,options:field.type==='select'?(document.querySelector(`[data-student-field-options="${field.key}"]`)?.value||'').split(',').map(value=>value.trim()).filter(Boolean):[],enabled:field.key==='name'||document.querySelector(`[data-student-field-enabled="${field.key}"]`)?.checked===true,required:field.key==='name'||document.querySelector(`[data-student-field-required="${field.key}"]`)?.checked===true})),
        competitionPolicies:competitionPoliciesFromForm()
    });
    if(!next.participantTypes.length || !next.allowedGenders.length || !next.registrationChannels.length) return window.showToast('Select at least one participant type, gender and registration channel','error');
    if(next.eventManagementMode==='advanced'&&(next.eventFeatures.customCriteria||next.eventFeatures.multipleJudges)&&next.judgingMode==='disabled')return window.showToast('Enable Judgement before enabling criteria or multiple judges','error');if(next.eventFeatures.teamLedger&&next.teamScoringMode==='disabled')return window.showToast('Enable Team Scoring before enabling Team Score Ledger','error');
    const emptyDropdown=next.studentFields.find(field=>field.enabled&&field.type==='select'&&!field.options.length);if(emptyDropdown)return window.showToast(`Add dropdown choices for ${emptyDropdown.label}`,'error');
    const missingPolicies=incompleteCompetitionPolicies(next.competitionPolicies);if(missingPolicies.length)return window.showToast(`Complete Competition Policy Centre: ${missingPolicies[0]}`,'error');
    const changedKeys=['organisationMode','scheduleMode','judgingMode','resultWorkflow','teamScoringMode'].filter(key=>next[key]!==savedFestSetup[key]),removedTypes=savedFestSetup.participantTypes.filter(type=>!next.participantTypes.includes(type)),operationalCount=students.length+participants.length+events.length+registrations.length+judgeAssignments.length+judgeScores.length+results.length;if((changedKeys.length||removedTypes.length)&&operationalCount){const proceed=await window.confirmAction(`Apply configuration changes to an active fest?\n\nChanged modes: ${changedKeys.join(', ')||'none'}\nRemoved participant types: ${removedTypes.join(', ')||'none'}\nAffected operational records to review: ${operationalCount}\n\nNo records will be deleted, but hidden/locked modules and eligibility must be reviewed.`);if(!proceed)return;}
    const currentScoring=readScoringConfigFromDom();
    currentScoring.policies={gradeCalculationMaximumMark:Math.max(1,Number(document.getElementById('policy-grade-maximum')?.value||100)),directRankGradeMode:next.competitionPolicies.directRankGradeMode,minimumPositionPolicy:next.competitionPolicies.minimumPositionPolicy,minimumPositionPercentage:next.competitionPolicies.minimumPositionPercentage,jointPositionMethod:next.competitionPolicies.jointPositionMethod,multipleJudgeMethod:next.competitionPolicies.multipleJudgeMethod,trimMinimumJudges:next.competitionPolicies.trimMinimumJudges,generalGenderMode:next.competitionPolicies.generalGenderMode,publishedCorrectionMode:next.competitionPolicies.publishedCorrectionMode};
    const scoringIssue=scoringValidationIssue(currentScoring);if(scoringIssue)return window.showToast(scoringIssue,'error');
    festSetup=next;savedFestSetup=normalizeFestSetup(next);await Promise.all([setDoc(doc(db,'settings','general'),{festSetup:next},{merge:true}),setDoc(doc(db,'settings','scoring_rules'),{...currentScoring,updatedAt:Date.now()},{merge:false}),addDoc(collection(db,'auditLogs'),{action:'master_setup_updated',preset:next.preset,changedKeys,removedParticipantTypes:removedTypes,operationalRecordCount:operationalCount,uid:auth.currentUser?.uid||'',createdAt:Date.now()})]);scoringRules=currentScoring;window.applyFestCapabilities();window.renderMasterSetup();window.renderStudentCustomFields();window.renderScoringRules();masterDirtySections.clear();updateMasterSubnavStatus();window.showToast('Master Setup and competition policies saved');
};

document.getElementById('form-student')?.addEventListener('submit', async (e) => {
    e.preventDefault(); setLoading('btn-save-std', true);
    const team = document.getElementById('inp-std-team').value; const cat = document.getElementById('inp-std-cat').value; const gender = document.getElementById('inp-std-gender').value; const isBulk = !document.getElementById('inp-std-name-bulk').classList.contains('hidden');
    if(!team || !cat || !gender) { setLoading('btn-save-std', false, 'Save'); return window.showToast('Fill team, category and gender', 'error'); }
    if(cat === 'General') { setLoading('btn-save-std', false, 'Save'); return window.showToast('General is for events only. Choose a student category.', 'error'); }
    let nextChest = window.generateChestNo(team, cat, gender);
    if(!nextChest) { setLoading('btn-save-std', false, 'Save'); return window.showToast('Chest No Config Missing', 'error'); }
    try {
        if(isBulk) {
            if(enabledStudentFields().some(field=>field.key!=='name'&&field.required)) { setLoading('btn-save-std', false, 'Save'); return window.showToast('Use Excel import when required custom fields are enabled', 'error'); }
            const names = document.getElementById('inp-std-name-bulk').value.split('\n').map(n => n.trim()).filter(Boolean);
            if(!names.length) { setLoading('btn-save-std', false, 'Save'); return window.showToast('Enter at least one student name', 'error'); }
            const plannedChestNos = names.map((_, i) => nextChest + i);
            const duplicateChest = students.find(s => plannedChestNos.includes(Number(s.chestNo)) && s.team === team && s.category === cat && studentGender(s) === gender);
            if(duplicateChest) { setLoading('btn-save-std', false, 'Save'); return window.showToast(`Duplicate chest number ${duplicateChest.chestNo} for this team/category/gender`, 'error'); }
            const batch = names.map(async name => addDoc(collection(db, "students"), { name, team, category: cat, gender, chestNo: nextChest++ }));
            await Promise.all(batch); document.getElementById('inp-std-name-bulk').value = ''; window.showToast(`${names.length} Students Added`);
        } else {
            const name = document.getElementById('inp-std-name').value.trim();
            if(!name) { setLoading('btn-save-std', false, 'Save'); return window.showToast('Enter student name', 'error'); }
            const details=studentDetails('inp'),missing=enabledStudentFields().find(field=>field.key!=='name'&&field.required&&!details[field.key]);
            if(missing) { setLoading('btn-save-std', false, 'Save'); return window.showToast(`${missing.label} is required`, 'error'); }
            if(students.some(s => Number(s.chestNo) === Number(nextChest) && s.team === team && s.category === cat && studentGender(s) === gender)) { setLoading('btn-save-std', false, 'Save'); return window.showToast('Duplicate chest number for this team/category/gender', 'error'); }
            await addDoc(collection(db, "students"), { name, team, category: cat, gender, chestNo: nextChest, details, photoData:document.getElementById('inp-std-photo')?.value||'' }); document.getElementById('inp-std-name').value = '';document.getElementById('inp-std-photo').value='';window.renderStudentCustomFields();window.refreshImageUploadPreviews?.(); window.showToast('Student Added');
        }
        window.previewChestNo();
    } catch(e) { console.error(e); window.showToast('Save Failed', 'error'); }
    setLoading('btn-save-std', false, 'Save');
});

const commitCascadeOperations = async (operations) => {
    if(operations.length > 450) throw new Error('Cascade exceeds the safe atomic deletion limit (450 records).');
    const batch = writeBatch(db);
    operations.forEach(operation => { if(operation.type === 'delete') batch.delete(operation.ref); else batch.update(operation.ref, operation.data); });
    await batch.commit();
};
const withoutStudent = (value, studentId) => (Array.isArray(value) ? value : [value].filter(Boolean)).filter(item => item !== studentId);
const containsExactReference = (value, target) => {
    if(value === target) return true;
    if(Array.isArray(value)) return value.some(item => containsExactReference(item, target));
    if(value && typeof value === 'object') return Object.values(value).some(item => containsExactReference(item, target));
    return false;
};

window.deleteStudent = async (id) => {
    const student = students.find(item => item.id === id); if(!student) return;
    const linkedRegistrations = registrations.filter(registration => (registration.studentIds || []).includes(id));
    const participantIdsToRemove = new Set([id, ...linkedRegistrations.filter(registration => (registration.studentIds || []).every(studentId => studentId === id)).map(registration => registration.id)]);
    const hasDeletedParticipant = value => withoutStudent(value, '').some(participantId => participantIdsToRemove.has(participantId));
    const linkedScores = judgeScores.filter(score => (score.marks || []).some(mark => participantIdsToRemove.has(mark.participantId)));
    const linkedResults = results.filter(result => (result.places || []).some(place => hasDeletedParticipant(place.winners)) || (result.gradeAwards || []).some(grade => hasDeletedParticipant(grade.winners)) || Object.values(result.winners || {}).some(hasDeletedParticipant) || Object.values(result.grades || {}).some(hasDeletedParticipant));
    const warning = `PERMANENTLY DELETE ${student.name || 'this student'}?\n\nThis removes the student and all linked participation data:\n• ${linkedRegistrations.length} event registrations\n• ${linkedScores.length} judge score entries\n• ${linkedResults.length} published/ready result references\n\nThe student will also disappear from team schedules and participation reports. This cannot be undone.`;
    if(!await window.confirmAction(warning)) return;
    document.getElementById('app-loader')?.classList.remove('hide');
    try {
        const operations = [{ type: 'delete', ref: doc(db, 'students', id) }];
        linkedRegistrations.forEach(registration => { const studentIds = (registration.studentIds || []).filter(studentId => studentId !== id); const participantMeta = { ...(registration.participantMeta || {}) }; delete participantMeta[id]; operations.push(studentIds.length ? { type: 'update', ref: doc(db, 'registrations', registration.id), data: { studentIds, participantMeta, updatedAt: Date.now() } } : { type: 'delete', ref: doc(db, 'registrations', registration.id) }); });
        const scoreUpdates = new Map(linkedScores.map(score => [score.id, { marks: (score.marks || []).filter(mark => !participantIdsToRemove.has(mark.participantId)), updatedAt: Date.now(), cascadeUpdatedAt: Date.now() }]));
        linkedResults.forEach(result => {
            const removeParticipants = value => withoutStudent(value, '').filter(participantId => !participantIdsToRemove.has(participantId));
            const places = (result.places || []).map(place => ({ ...place, winners: removeParticipants(place.winners) })).filter(place => place.winners.length);
            const gradeAwards = (result.gradeAwards || []).map(grade => ({ ...grade, winners: removeParticipants(grade.winners) })).filter(grade => grade.winners.length);
            const winners = Object.fromEntries(Object.entries(result.winners || {}).map(([key,value]) => [key, removeParticipants(value)]));
            const grades = Object.fromEntries(Object.entries(result.grades || {}).map(([key,value]) => [key, removeParticipants(value)]));
            const hasAwards = places.length || gradeAwards.length || Object.values(winners).some(value => value.length) || Object.values(grades).some(value => value.length);
            if(!hasAwards && result.judgeScoreId && judgeScores.some(score => score.id === result.judgeScoreId)) scoreUpdates.set(result.judgeScoreId, { ...(scoreUpdates.get(result.judgeScoreId) || {}), publishStatus: 'unpublished', publishedResultId: '', publishedAt: 0, cascadeUpdatedAt: Date.now() });
            operations.push(hasAwards ? { type: 'update', ref: doc(db, 'results', result.id), data: { places, gradeAwards, winners, grades, cascadeUpdatedAt: Date.now() } } : { type: 'delete', ref: doc(db, 'results', result.id) });
        });
        scoreUpdates.forEach((data, scoreId) => operations.push({ type: 'update', ref: doc(db, 'judgeScores', scoreId), data }));
        const [notificationSnap, auditSnap] = await Promise.all([getDocs(collection(db, 'notifications')), getDocs(collection(db, 'auditLogs'))]);
        notificationSnap.docs.filter(item => containsExactReference(item.data(), id)).forEach(item => operations.push({ type: 'delete', ref: item.ref }));
        auditSnap.docs.filter(item => containsExactReference(item.data(), id)).forEach(item => operations.push({ type: 'delete', ref: item.ref }));
        await commitCascadeOperations(operations);
        window.showToast(`${student.name} and all linked data were deleted`);
    } catch(error) { console.error('Student cascade deletion failed', error); window.showToast('Student deletion failed. No further action should be taken until checked.', 'error'); }
    finally { document.getElementById('app-loader')?.classList.add('hide'); }
};
window.openEditStudent = (id) => { const s = students.find(x => x.id === id); if(!s) return; document.getElementById('edit-std-id').value = s.id; document.getElementById('edit-std-name').value = s.name; document.getElementById('edit-std-team').value = s.team; document.getElementById('edit-std-cat').value = s.category; document.getElementById('edit-std-gender').value = studentGender(s); document.getElementById('edit-std-chest').value = s.chestNo; document.getElementById('edit-std-photo').value=s.photoData||'';const custom=document.getElementById('edit-student-custom-fields');if(custom)custom.innerHTML=enabledStudentFields().filter(field=>field.key!=='name').map(field=>fieldInput(field,'edit',s.details?.[field.key]||s[field.key]||'')).join('');window.refreshImageUploadPreviews?.(); document.getElementById('edit-student-modal').classList.remove('hidden'); };
window.closeEditStudentModal = () => document.getElementById('edit-student-modal').classList.add('hidden');
document.getElementById('edit-student-form')?.addEventListener('submit', async (e) => { e.preventDefault(); const id = document.getElementById('edit-std-id').value,details=studentDetails('edit'); const d = { name: document.getElementById('edit-std-name').value.trim(), team: document.getElementById('edit-std-team').value, category: document.getElementById('edit-std-cat').value, gender: document.getElementById('edit-std-gender').value, chestNo: normalizeChestCode(document.getElementById('edit-std-chest').value), details, photoData:document.getElementById('edit-std-photo').value||'' }; if(!d.name || !d.team || !d.category || !d.gender || !d.chestNo) return window.showToast('Fill all student fields', 'error');if(!validChestCode(d.chestNo))return window.showToast('Chest No may contain only English letters, numbers, hyphens or underscores', 'error');const missing=enabledStudentFields().find(field=>field.key!=='name'&&field.required&&!details[field.key]);if(missing)return window.showToast(`${missing.label} is required`,'error'); if(d.category === 'General') return window.showToast('General is for events only. Choose a student category.', 'error'); if(students.some(s => s.id !== id && normalizeChestCode(s.chestNo) === d.chestNo && s.team === d.team && s.category === d.category && studentGender(s) === d.gender)) return window.showToast('Duplicate chest number for this team/category/gender', 'error'); await updateDoc(doc(db, "students", id), d); window.closeEditStudentModal(); window.showToast('Updated'); });

const normalizeEventStage = (value) => {
    const v = String(value || '').trim().toLowerCase();
    if(['on', 'on-stage', 'on stage', 'stage'].includes(v)) return 'On-Stage';
    return 'Off-Stage';
};
const normalizeEventType = (value) => String(value || '').trim().toLowerCase() === 'group' ? 'Group' : 'Single';
const normalizeEventGender = (value) => {
    const v = String(value || '').trim().toLowerCase();
    if(v === 'boys' || v === 'boy') return 'Boys';
    if(v === 'girls' || v === 'girl') return 'Girls';
    return 'Both';
};
const eventCodeFor=(event,index=0)=>{if(event.code)return event.code;const token=value=>String(value||'GEN').replace(/[^a-z0-9]/gi,'').slice(0,3).toUpperCase()||'GEN',prefix=`${token(event.section||'EVT')}-${token(event.category)}-${token(event.gender)}`,used=events.map(item=>item.code||'');let number=used.filter(code=>code.startsWith(prefix)).length+1+index,code='';do{code=`${prefix}-${String(number++).padStart(3,'0')}`;}while(used.includes(code));return code;};
const validateEventPayload = (d) => {
    if(!(d.allowedParticipantTypes||[]).length)return 'Select at least one participant type';if(!(d.allowedRegistrationChannels||[]).length)return 'Select at least one registration channel';const normalized={...d,entriesPerTeam:d.limit,membersPerEntry:d.groupSize,participantTypes:d.allowedParticipantTypes,registrationChannels:d.allowedRegistrationChannels};const result=validateEvent(normalized,{...festSetup,categories},events);return result.errors[0]||'';
};
const eventPayloadFromForm = (nameOverride = null) => {
    const type = document.getElementById('inp-ev-type').value;
    return {
        code:masterValue('inp-ev-code').trim()||eventCodeFor({section:masterValue('inp-ev-section')||'EVT',category:document.getElementById('inp-ev-cat').value,gender:document.getElementById('inp-ev-gender').value}),
        name: (nameOverride ?? document.getElementById('inp-ev-name').value).trim(),
        section:masterValue('inp-ev-section').trim()||'General',
        category: document.getElementById('inp-ev-cat').value,
        gender: document.getElementById('inp-ev-gender').value,
        type,
        limit: parseInt(document.getElementById('inp-ev-limit').value),
        groupSize: type === 'Group' ? parseInt(document.getElementById('inp-ev-grpsize').value) : 1,
        stage: document.querySelector('input[name="ev-stage"]:checked')?.value,
        allowedParticipantTypes:checkboxGroupValues('inp-ev-participant-types'),
        allowedRegistrationChannels:checkboxGroupValues('inp-ev-registration-channels'),
        eligibleClasses:masterValue('inp-ev-eligible-classes').split(',').map(value=>value.trim()).filter(Boolean),minimumMembers:Number(masterValue('inp-ev-min-members')||1),maximumMembers:Number(masterValue('inp-ev-max-members')||1),multipleJudgeMethod:masterValue('inp-ev-multiple-judge'),tieBreakMethod:masterValue('inp-ev-tie-break'),gradeMode:masterValue('inp-ev-grade-mode'),duration:Number(masterValue('inp-ev-duration')||0),preparationTime:Number(masterValue('inp-ev-preparation')||0),rules:masterValue('inp-ev-rules').trim(),resultWorkflow:masterValue('inp-ev-result-workflow'),resultMethod:masterValue('inp-ev-result-method'),criteria:parseCriteria(masterValue('inp-ev-criteria')).criteria,objectiveRule:{correctMark:Number(masterValue('inp-ev-correct-mark')||1),wrongPenalty:Number(masterValue('inp-ev-wrong-penalty')||0)},countRule:{wrongPenalty:Number(masterValue('inp-ev-count-penalty')||0)},timeRule:{direction:masterValue('inp-ev-time-direction')||'lower'}, scheduleRequirement:masterValue('inp-ev-schedule-required'), teamPolicy:masterValue('inp-ev-team-policy'), scoreContribution:masterValue('inp-ev-score-contribution'),maximumMark:Number(masterValue('inp-ev-maximum-mark')||100),scoringPolicy:masterValue('inp-ev-scoring-policy'),scoringOverride:scoringOverrideForPack(masterValue('inp-ev-scoring-policy')),
        updatedAt: Date.now()
    };
};
const collectBulkEventNames = () => (document.getElementById('inp-ev-bulk-names')?.value || '')
    .split('\n')
    .map(name => name.trim())
    .filter(Boolean);
const buildBulkEventPayloads = () => {const names=collectBulkEventNames(),manualCode=masterValue('inp-ev-code').trim();return names.map((name,index)=>{const payload=eventPayloadFromForm(name);payload.code=manualCode?(names.length===1?manualCode:`${manualCode}-${String(index+1).padStart(3,'0')}`):eventCodeFor({...payload,code:''},index);return payload;});};
const addEventPayload = async (payload) => addDoc(collection(db, "events"), {...payload,status:'validated',validation:{errors:[],warnings:[],validatedAt:Date.now(),validatedByUid:auth.currentUser?.uid||''}});

document.getElementById('form-event')?.addEventListener('submit', async (e) => {
    e.preventDefault(); setLoading('btn-save-event', true, 'Add Event');
    const isBulk = !document.getElementById('inp-ev-bulk-names')?.classList.contains('hidden');
    try {
        if(isBulk) {
            const parsed = buildBulkEventPayloads();
            if(!parsed.length) { setLoading('btn-save-event', false, 'Add Event'); return window.showToast('Enter at least one event name', 'error'); }
            const seen = new Set();
            for(const item of parsed) {
                const err = validateEventPayload(item);
                if(err) { setLoading('btn-save-event', false, 'Add Event'); return window.showToast(err, 'error'); }
                const key = [item.name.trim().toLowerCase(), item.category, item.gender, item.stage].join('|');
                if(seen.has(key)) { setLoading('btn-save-event', false, 'Add Event'); return window.showToast(`Duplicate event in bulk list: ${item.name}`, 'error'); }
                seen.add(key);
            }
            await Promise.all(parsed.map(addEventPayload));
            document.getElementById('inp-ev-bulk-names').value = '';
            window.showToast(`${parsed.length} Events Added`);
        } else {
            const d = eventPayloadFromForm();
            const err = validateEventPayload(d);
            if(err) { setLoading('btn-save-event', false, 'Add Event'); return window.showToast(err, 'error'); }
            await addEventPayload(d);
            e.target.reset();
            document.getElementById('inp-ev-rules').value = '';
            window.toggleEventConfig();
            window.showToast('Event Added');
        }
    } catch(error) { console.error(error); window.showToast(error.message || 'Save Failed', 'error'); }
    setLoading('btn-save-event', false, 'Add Event');
});

window.deleteEvent = async (id) => {
    const event = events.find(item => item.id === id); if(!event) return;
    document.getElementById('app-loader')?.classList.remove('hide');
    try {
        const collectionNames = ['registrations', 'results', 'resultRevisions', 'teamScoreLedgers', 'judgeAssignments', 'judgeScores', 'publicJudgingStatuses', 'notifications', 'auditLogs', 'scheduleBreaks'];
        const snapshots = await Promise.all(collectionNames.map(name => getDocs(query(collection(db, name), where('eventId', '==', id)))));
        const linked = Object.fromEntries(collectionNames.map((name,index) => [name, snapshots[index].docs]));
        const legacyResult = results.find(result => result.id === id);
        if(legacyResult && !linked.results.some(item => item.id === legacyResult.id)) linked.results.push({ id: legacyResult.id, ref: doc(db, 'results', legacyResult.id) });
        const totalLinked = Object.values(linked).reduce((total, docs) => total + docs.length, 0);
        const warning = `PERMANENTLY DELETE ${event.name || 'this event'}?\n\nALL linked data will be deleted together:\n• Schedule/date/time/stage details\n• ${linked.registrations.length} team registrations and participants\n• ${linked.judgeAssignments.length} judge assignments\n• ${linked.judgeScores.length} judgement sheets/drafts/submissions\n• ${linked.results.length} ready/published results\n• ${linked.notifications.length} notifications\n• ${linked.auditLogs.length} event audit records\n\n${totalLinked + 1} records will be removed. This cannot be undone.`;
        if(!await window.confirmAction(warning)) return;
        const operationMap = new Map();
        operationMap.set(`events/${id}`, { type: 'delete', ref: doc(db, 'events', id) });
        Object.values(linked).flat().forEach(item => operationMap.set(item.ref.path, { type: 'delete', ref: item.ref }));
        await commitCascadeOperations(Array.from(operationMap.values()));
        window.showToast(`${event.name} and all linked data were permanently deleted`);
    } catch(error) { console.error('Event cascade deletion failed', error); window.showToast(error.message || 'Event deletion failed', 'error'); }
    finally { document.getElementById('app-loader')?.classList.add('hide'); }
};

window.openEditEvent = (id) => {
    const e = events.find(x => x.id === id); if(!e) return;
    document.getElementById('edit-ev-id').value = e.id;
    document.getElementById('edit-ev-name').value = e.name;
    document.getElementById('edit-ev-code').value=e.code||'';document.getElementById('edit-ev-section').value=e.section||'General';document.getElementById('edit-ev-eligible-classes').value=(e.eligibleClasses||[]).join(', ');document.getElementById('edit-ev-min-members').value=Number(e.minimumMembers||1);document.getElementById('edit-ev-max-members').value=Number(e.maximumMembers||e.groupSize||1);document.getElementById('edit-ev-multiple-judge').value=e.multipleJudgeMethod||'default';document.getElementById('edit-ev-tie-break').value=e.tieBreakMethod||'default';document.getElementById('edit-ev-grade-mode').value=e.gradeMode||'default';document.getElementById('edit-ev-duration').value=Number(e.duration||0);document.getElementById('edit-ev-preparation').value=Number(e.preparationTime||0);document.getElementById('edit-ev-rules').value=e.rules||e.description||e.notes||'';
    document.getElementById('edit-ev-cat').value = e.category;
    document.getElementById('edit-ev-gender').value = e.gender || 'Both';
    document.getElementById('edit-ev-type').value = e.type;
    document.getElementById('edit-ev-limit').value = e.limit;
    document.getElementById('edit-ev-grp').value = e.groupSize || 1;
    window.applyFestCapabilities();setCheckboxGroupValues('edit-ev-participant-types',e.allowedParticipantTypes||festSetup.participantTypes);setCheckboxGroupValues('edit-ev-registration-channels',e.allowedRegistrationChannels||festSetup.registrationChannels);
    document.getElementById('edit-ev-result-workflow').value=e.resultWorkflow||(['direct','judged'].includes(e.resultMethod)?e.resultMethod:'default');document.getElementById('edit-ev-result-method').value=RESULT_METHODS.includes(e.resultMethod)?e.resultMethod:'manual';document.getElementById('edit-ev-criteria').value=(e.criteria||[]).map(item=>`${item.name} - ${item.maximumMark}`).join('\n');document.getElementById('edit-ev-correct-mark').value=Number(e.objectiveRule?.correctMark??1);document.getElementById('edit-ev-wrong-penalty').value=Number(e.objectiveRule?.wrongPenalty??0);document.getElementById('edit-ev-count-penalty').value=Number(e.countRule?.wrongPenalty??0);document.getElementById('edit-ev-time-direction').value=e.timeRule?.direction||'lower';document.getElementById('edit-ev-schedule-required').value=e.scheduleRequirement||'default';document.getElementById('edit-ev-team-policy').value=e.teamPolicy||'default';document.getElementById('edit-ev-score-contribution').value=e.scoreContribution||'default';document.getElementById('edit-ev-maximum-mark').value=Number(e.maximumMark||100);document.getElementById('edit-ev-scoring-policy').value=e.scoringPolicy||'default';
    window.updateEventMethodFields(document.getElementById('edit-ev-result-method'));window.toggleEventConfig(document.getElementById('edit-ev-type'));
    const stage = e.stage || 'Off-Stage'; const radio = document.querySelector(`input[name="edit-ev-stage"][value="${stage}"]`); if(radio) radio.checked = true;
    document.getElementById('edit-event-modal').classList.remove('hidden');
};
window.closeEditEventModal = () => document.getElementById('edit-event-modal').classList.add('hidden');
document.getElementById('edit-event-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-ev-id').value;
    const d = {
        code:masterValue('edit-ev-code').trim(),section:masterValue('edit-ev-section').trim()||'General',eligibleClasses:masterValue('edit-ev-eligible-classes').split(',').map(value=>value.trim()).filter(Boolean),minimumMembers:Number(masterValue('edit-ev-min-members')||1),maximumMembers:Number(masterValue('edit-ev-max-members')||1),multipleJudgeMethod:masterValue('edit-ev-multiple-judge'),tieBreakMethod:masterValue('edit-ev-tie-break'),gradeMode:masterValue('edit-ev-grade-mode'),duration:Number(masterValue('edit-ev-duration')||0),preparationTime:Number(masterValue('edit-ev-preparation')||0),rules:masterValue('edit-ev-rules').trim(),
        name: document.getElementById('edit-ev-name').value.trim(),
        category: document.getElementById('edit-ev-cat').value,
        gender: document.getElementById('edit-ev-gender').value,
        type: document.getElementById('edit-ev-type').value,
        limit: parseInt(document.getElementById('edit-ev-limit').value),
        groupSize: document.getElementById('edit-ev-type').value === 'Group' ? parseInt(document.getElementById('edit-ev-grp').value) : 1,
        allowedParticipantTypes:checkboxGroupValues('edit-ev-participant-types'),allowedRegistrationChannels:checkboxGroupValues('edit-ev-registration-channels'),resultWorkflow:masterValue('edit-ev-result-workflow'),resultMethod:masterValue('edit-ev-result-method'),criteria:parseCriteria(masterValue('edit-ev-criteria')).criteria,objectiveRule:{correctMark:Number(masterValue('edit-ev-correct-mark')||1),wrongPenalty:Number(masterValue('edit-ev-wrong-penalty')||0)},countRule:{wrongPenalty:Number(masterValue('edit-ev-count-penalty')||0)},timeRule:{direction:masterValue('edit-ev-time-direction')||'lower'},scheduleRequirement:masterValue('edit-ev-schedule-required'),teamPolicy:masterValue('edit-ev-team-policy'),scoreContribution:masterValue('edit-ev-score-contribution'),maximumMark:Number(masterValue('edit-ev-maximum-mark')||100),scoringPolicy:masterValue('edit-ev-scoring-policy'),scoringOverride:scoringOverrideForPack(masterValue('edit-ev-scoring-policy')),
        stage: document.querySelector('input[name="edit-ev-stage"]:checked')?.value,
        updatedAt: Date.now()
    };
    const existing = events;
    const current = events.find(ev => ev.id === id);
    const duplicate = existing.some(ev => ev.id !== id && (ev.name || '').trim().toLowerCase() === d.name.trim().toLowerCase() && ev.category === d.category && (ev.gender || 'Both') === d.gender && (ev.stage || 'Off-Stage') === d.stage);
    if(duplicate) return window.showToast(`Duplicate event: ${d.name}`, 'error');
    const err = (() => {
        const validCategories = ['General', ...categories.filter(c => c !== 'General')];
        if(!d.name || !d.category || !d.gender || !d.type || !d.stage || !d.limit || d.limit < 1) return 'Fill all event fields';
        if(!d.allowedParticipantTypes.length) return 'Select at least one participant type';
        if(!d.allowedRegistrationChannels.length) return 'Select at least one registration channel';
        if(!validCategories.includes(d.category)) return `Unknown category: ${d.category}`;
        if(d.type === 'Group' && (!d.groupSize || d.groupSize < 2)) return 'Enter a valid group size';
        return '';
    })();
    if(err) return window.showToast(err, 'error');
    const fullValidation=validateEvent({...d,entriesPerTeam:d.limit,membersPerEntry:d.groupSize,participantTypes:d.allowedParticipantTypes,registrationChannels:d.allowedRegistrationChannels},{...festSetup,categories},events.filter(event=>event.id!==id));if(fullValidation.errors.length)return window.showToast(fullValidation.errors[0],'error');const protectedFields=['resultMethod','maximumMark','criteria','scoringPolicy','type'],hasJudging=judgeScores.some(score=>score.eventId===id),hasPublished=results.some(result=>(result.eventId||result.id)===id&&(result.status==='published'||!result.status));if((hasJudging||hasPublished)&&protectedFields.some(field=>JSON.stringify(current?.[field]??null)!==JSON.stringify(d[field]??null)))return window.showToast('Scoring fields are locked after judging starts. Reopen through a result revision instead.','error');
    d.status=fullValidation.status==='ready'?(current?.status==='draft'||current?.status==='needs_review'?'validated':current?.status||'validated'):'needs_review';d.validation={errors:fullValidation.errors,warnings:fullValidation.warnings,validatedAt:fullValidation.status==='ready'?Date.now():0,validatedByUid:auth.currentUser?.uid||''};
    await updateDoc(doc(db, "events", id), d);
    window.closeEditEventModal();
    window.showToast(current ? 'Updated' : 'Event updated');
});

window.updateEventMethodFields=target=>{const prefix=target?.id?.startsWith('edit-')?'edit':'inp';window.renderEventFormRequirements(prefix);};
window.toggleEventConfig=target=>{const prefix=target?.id?.startsWith('edit-')?'edit':'inp',type=masterValue(`${prefix}-ev-type`)||'Single',limitLabel=document.querySelector(`[data-team-limit-label="${prefix}"]`),limitHelp=document.querySelector(`[data-team-limit-help="${prefix}"]`),groupInput=document.getElementById(prefix==='edit'?'edit-ev-grp':'inp-ev-grpsize'),groupSize=Number(groupInput?.value||2),minimum=document.getElementById(`${prefix}-ev-min-members`),maximum=document.getElementById(`${prefix}-ev-max-members`);if(limitLabel)limitLabel.textContent=type==='Group'?'Groups Allowed per Team':'Participants Allowed per Team';if(limitHelp)limitHelp.textContent=type==='Group'?'Maximum separate group entries one team may register.':'Maximum individual participants one team may register.';if(type==='Group'){if(minimum&&Number(minimum.value)<=1)minimum.value=groupSize;if(maximum&&Number(maximum.value)<=1)maximum.value=groupSize;}else{if(minimum)minimum.value=1;if(maximum)maximum.value=1;}syncEventGroupFields(prefix);window.renderEventFormRequirements(prefix);};
const setBulkToggleState=(button,enabled)=>{if(!button)return;button.setAttribute('aria-checked',String(enabled));button.querySelector('[data-bulk-track]')?.classList.toggle('bg-indigo-600',enabled);button.querySelector('[data-bulk-track]')?.classList.toggle('bg-slate-300',!enabled);button.querySelector('[data-bulk-knob]')?.classList.toggle('translate-x-4',enabled);button.title=enabled?'Switch to single mode':'Switch to bulk mode';};
window.toggleEventBulkMode=()=>{const button=document.getElementById('btn-event-bulk'),single=document.getElementById('inp-ev-name'),bulk=document.getElementById('inp-ev-bulk-names'),hint=document.getElementById('event-bulk-hint');if(!bulk||!button)return;const enabled=bulk.classList.contains('hidden');bulk.classList.toggle('hidden',!enabled);hint?.classList.toggle('hidden',!enabled);single?.classList.toggle('hidden',enabled);if(single)single.required=!enabled;bulk.required=enabled;setBulkToggleState(button,enabled);};

window.toggleBulkMode=()=>{const button=document.getElementById('btn-bulk'),single=document.getElementById('inp-std-name'),bulk=document.getElementById('inp-std-name-bulk'),photo=document.getElementById('student-photo-upload');if(!bulk)return;const enabled=bulk.classList.contains('hidden');bulk.classList.toggle('hidden',!enabled);single.classList.toggle('hidden',enabled);photo?.classList.toggle('hidden',enabled);if(enabled){document.getElementById('inp-std-photo').value='';window.refreshImageUploadPreviews?.();}setBulkToggleState(button,enabled);};

// --- JUDGEMENT CONTROL ---
const eventScheduleDate = (event = {}) => event.scheduleDate || event.date || '';
const eventScheduleStage = (event = {}) => event.scheduleStage || event.stageNo || event.stageNumber || event.stage || '';
const eventScheduleTime = (event = {}) => event.time || '';
const scheduledEventsForJudges = () => events.filter(event=>isScheduledEvent(event)&&!['draft','needs_review'].includes(event.status)).sort((a,b) => `${eventScheduleDate(a)} ${scheduleTimeSort(eventScheduleTime(a))} ${a.name || ''}`.localeCompare(`${eventScheduleDate(b)} ${scheduleTimeSort(eventScheduleTime(b))} ${b.name || ''}`));
const judgeScoreForAssignment = (assignmentId) => judgeScores.find(s => s.assignmentId === assignmentId);

window.switchJudgeSubtab = (tab = 'assign') => {
    document.querySelectorAll('.judge-subtab-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== `judge-subtab-${tab}`));
    document.querySelectorAll('.judge-subtab').forEach(btn => {
        const active = btn.dataset.subtab === tab;
        btn.classList.toggle('bg-indigo-600', active); btn.classList.toggle('text-white', active);
        btn.classList.toggle('bg-slate-100', !active); btn.classList.toggle('text-slate-600', !active);
    });
    window.renderJudgePanel?.();
};

window.renderJudgeStats = () => {
    const box = document.getElementById('judge-stat-cards');
    if(!box) return;
    const activeAssignments = judgeAssignments.filter(a => a.active !== false);
    const submitted = judgeScores.filter(s => s.status === 'submitted').length;
    const pending = activeAssignments.filter(a => !judgeScoreForAssignment(a.id)).length;
    box.innerHTML = [
        ['Active Judges', judges.filter(j => j.active !== false).length, 'text-indigo-600'],
        ['Scheduled Programs', scheduledEventsForJudges().length, 'text-emerald-600'],
        ['Assignments', activeAssignments.length, 'text-violet-600'],
        ['Pending / Submitted', `${pending}/${submitted}`, 'text-amber-600']
    ].map(([label, value, color]) => `<div class="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p class="text-[10px] font-black uppercase text-slate-400 tracking-wider">${label}</p><h4 class="text-2xl font-black ${color}">${value}</h4></div>`).join('');
};

window.renderJudgePanel = () => {
    window.renderJudgeStats();
    window.renderJudgeAssignmentOptions();
    window.renderJudgeAssignments();
    window.renderJudgeReview();
    window.lucide?.createIcons?.();
};


const eventStageType = (event = {}) => event.stage || event.stageType || (eventScheduleStage(event) ? 'On-Stage' : 'Off-Stage');
const assignmentForEvent = (eventId) => judgeAssignments.find(a => a.active !== false && a.eventId === eventId);
const judgeAuthId = judge => judge?.authUid || judge?.uid || judge?.id || '';
const judgeForAssignmentId = id => judges.find(j => [j.id,j.uid,j.authUid].filter(Boolean).includes(id));
const judgeOptionsForAssignment = (selected = '') => '<option value="">Select Judge...</option>' + judges.filter(j => j.active !== false).filter((judge,index,list)=>list.findIndex(item=>judgeAuthId(item)===judgeAuthId(judge))===index).sort((a,b)=>(a.name || '').localeCompare(b.name || '')).map(j => {const id=judgeAuthId(j);return `<option value="${escapeHtml(id)}" ${[j.id,j.uid,j.authUid].includes(selected) ? 'selected' : ''}>${escapeHtml(j.name || '')}</option>`;}).join('');

window.renderJudgeAssignmentOptions = () => {
    const table = document.getElementById('judge-assignment-table');
    if(!table) return;
    const cat = document.getElementById('assign-category-filter')?.value || '';
    const stageType = document.getElementById('assign-stage-type-filter')?.value || '';
    const date = document.getElementById('assign-date-filter')?.value || '';
    const stage = normalizeStageValue(document.getElementById('assign-stage-filter')?.value || '');
    let list = scheduledEventsForJudges();
    if(cat) list = list.filter(e => e.category === cat);
    if(stageType) list = list.filter(e => eventStageType(e) === stageType);
    if(date) list = list.filter(e => eventScheduleDate(e) === date);
    if(stage) list = list.filter(e => normalizeStageValue(eventScheduleStage(e)).includes(stage));
    table.innerHTML = `<table class="w-full min-w-[900px] text-left text-sm"><thead class="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-500"><tr><th class="px-4 py-3">Date & Day</th><th class="px-4 py-3">Time</th><th class="px-4 py-3">Program</th><th class="px-4 py-3">Gender</th><th class="px-4 py-3">Stage</th><th class="px-4 py-3">Assigned Judge</th></tr></thead><tbody class="divide-y divide-slate-100">${list.map(e => { const a = assignmentForEvent(e.id), cancelled=e.cancelled===true; return `<tr class="${cancelled?'bg-red-50 text-red-950':''}"><td class="px-4 py-3 font-bold">${escapeHtml(scheduleDateText(eventScheduleDate(e)))}</td><td class="px-4 py-3 font-black text-indigo-700">${escapeHtml(toAmPm(eventScheduleTime(e) || ''))}</td><td class="px-4 py-3"><div class="font-black">${escapeHtml(e.name || '')}${cancelled?'<span class="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[9px] font-black uppercase text-white">Cancelled</span>':''}</div><div class="text-xs ${cancelled?'text-red-600':'text-slate-400'} font-bold">${escapeHtml(e.category || '')} • ${escapeHtml(eventStageType(e))}${cancelled&&e.cancelReason?` • ${escapeHtml(e.cancelReason)}`:''}</div></td><td class="px-4 py-3 font-bold">${escapeHtml(genderLabel(e))}</td><td class="px-4 py-3 font-bold">${escapeHtml(eventScheduleStage(e) || '-')}</td><td class="px-4 py-3"><select data-assign-event-id="${escapeHtml(e.id)}" class="text-input min-w-[220px]">${judgeOptionsForAssignment(a?.judgeId || '')}</select></td></tr>`; }).join('') || '<tr><td colspan="6" class="px-4 py-10 text-center text-slate-400 font-bold">No scheduled programs.</td></tr>'}</tbody></table>`;
};

window.saveJudgeAssignment = async () => {
    const selects = Array.from(document.querySelectorAll('[data-assign-event-id]'));
    const rows = selects.map(select => ({ select, event: events.find(e => e.id === select.dataset.assignEventId), judge: judgeForAssignmentId(select.value), judgeId: select.value })).filter(r => r.judgeId);
    const issues = [];
    const seen = new Set();
    const slots = new Map();
    rows.forEach(({ event, judge, judgeId }) => {
        if(!event || !isScheduledEvent(event)) issues.push(`Unscheduled program assigned to ${judge?.name || judgeId}`);
        const duplicateKey = `${event?.id}|${judgeId}`;
        if(seen.has(duplicateKey)) issues.push(`Duplicate judge assignment for ${event?.name || 'program'}`);
        seen.add(duplicateKey);
        const slotKey = `${eventScheduleDate(event)}|${eventScheduleTime(event)}|${judgeId}`;
        const slot = slots.get(slotKey) || [];
        slot.push({ event, judge }); slots.set(slotKey, slot);
    });
    slots.forEach(slot => { if(slot.length > 1) issues.push(`${slot[0].judge?.name || 'Judge'} has same-time programs: ${slot.map(x => x.event?.name).join(', ')}`); });
    if(issues.length && !await window.confirmAction(`Assignment conflicts found:\n\n${issues.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\nDo you want to save anyway?`, { okText: 'Save Update', cancelText: 'Cancel' })) return;
    await Promise.all(selects.map(async select => {
        const event = events.find(e => e.id === select.dataset.assignEventId);
        const existing = assignmentForEvent(select.dataset.assignEventId);
        if(!event) return;
        if(!select.value) { if(existing) await updateDoc(doc(db, 'judgeAssignments', existing.id), { active: false, updatedAt: Date.now() }); return; }
        const judge = judgeForAssignmentId(select.value); if(!judge) return;
        const canonicalJudgeId=judgeAuthId(judge);
        await setDoc(doc(db, 'judgeAssignments', existing?.id || `event_${event.id}`), { judgeId: canonicalJudgeId, judgeAccessDocId: judge.id || '', judgeName: judge.name, eventId: event.id, eventName: event.name, category: event.category || '', gender: genderLabel(event), date: eventScheduleDate(event), time: eventScheduleTime(event), stage: eventScheduleStage(event), stageType: eventStageType(event), active: true, updatedAt: Date.now(), createdAt: existing?.createdAt || Date.now() }, { merge: true });
    }));
    window.showToast('Assignments saved');
};

window.renderJudgeAssignments = () => {
    const list = document.getElementById('judge-assignments-list');
    if(!list) return;
    const active = judgeAssignments.filter(a => a.active !== false).sort((a,b) => `${a.date || ''} ${scheduleTimeSort(a.time)} ${a.eventName || ''}`.localeCompare(`${b.date || ''} ${scheduleTimeSort(b.time)} ${b.eventName || ''}`));
    list.innerHTML = active.length ? `<h4 class="font-black text-slate-800">Current Assignments</h4>` + active.map(a => { const eventInfo=events.find(event=>event.id===a.eventId)||{}, cancelled=eventInfo.cancelled===true, score = judgeScoreForAssignment(a.id); const status = score?.status || 'pending'; const badge = status === 'submitted' ? 'bg-green-100 text-green-700' : status === 'draft' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'; return `<div class="rounded-2xl border ${cancelled?'border-red-300 bg-red-50':'border-slate-200 bg-white'} p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"><div><h4 class="font-black ${cancelled?'text-red-900':'text-slate-800'}">${escapeHtml(a.eventName || '')}${cancelled?'<span class="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[9px] font-black uppercase text-white">Cancelled</span>':''}</h4><p class="text-xs font-bold text-slate-500">${escapeHtml(scheduleDateText(a.date))} • ${escapeHtml(toAmPm(a.time || ''))} • Stage ${escapeHtml(a.stage || '-')} • Judge: ${escapeHtml(a.judgeName || '')}${cancelled&&eventInfo.cancelReason?` • ${escapeHtml(eventInfo.cancelReason)}`:''}</p></div><div class="flex flex-wrap items-center gap-2"><span class="rounded-full px-3 py-1 text-[10px] font-black uppercase ${badge}">${status}</span><button data-admin-action="edit-judge-assignment" data-id="${escapeHtml(a.id)}" class="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-700 hover:bg-indigo-100"><i data-lucide="pencil" class="inline-block w-3 h-3 mr-1"></i>Edit</button><button data-admin-action="remove-judge-assignment" data-id="${escapeHtml(a.id)}" class="rounded-lg bg-red-50 px-3 py-2 text-xs font-black text-red-600 hover:bg-red-100"><i data-lucide="trash-2" class="inline-block w-3 h-3 mr-1"></i>Delete</button></div></div>`; }).join('') : '<p class="text-sm text-slate-400 italic">No assignments yet.</p>';
};


window.editJudgeAssignment = (id) => {
    const assignment = judgeAssignments.find(a => a.id === id);
    if(!assignment) return window.showToast('Assignment not found', 'error');
    window.switchJudgeSubtab('assign');
    const filters = [
        ['assign-category-filter', assignment.category || ''],
        ['assign-stage-type-filter', assignment.stageType || ''],
        ['assign-date-filter', assignment.date || ''],
        ['assign-stage-filter', assignment.stage || '']
    ];
    filters.forEach(([elementId, value]) => { const el = document.getElementById(elementId); if(el) el.value = value; });
    window.renderJudgeAssignmentOptions();
    requestAnimationFrame(() => {
        const select = document.querySelector(`[data-assign-event-id="${CSS.escape(assignment.eventId || '')}"]`);
        if(select) {
            select.value = assignment.judgeId || '';
            select.scrollIntoView({ behavior: 'smooth', block: 'center' });
            select.classList.add('ring-4', 'ring-indigo-200');
            setTimeout(() => select.classList.remove('ring-4', 'ring-indigo-200'), 2200);
        }
    });
    window.showToast('Choose a different judge, then save assignments');
};

window.removeJudgeAssignment = async (id) => {
    if(window.confirmAction && !await window.confirmAction('Remove this assignment?')) return;
    await updateDoc(doc(db, 'judgeAssignments', id), { active: false, updatedAt: Date.now() });
    window.showToast('Assignment removed');
};

window.renderJudgeReview = () => {
    const list = document.getElementById('judge-score-review');
    if(!list) return;
    const search = (document.getElementById('judge-review-search')?.value || '').trim().toLowerCase();
    const category = document.getElementById('judge-review-category')?.value || '';
    const stageType = document.getElementById('judge-review-stage')?.value || '';
    const gender = document.getElementById('judge-review-gender')?.value || '';
    const submitted = judgeScores.filter(score => score.status === 'submitted').map(score => {
        const event = events.find(item => item.id === score.eventId) || {};
        const assignment = judgeAssignments.find(item => item.id === score.assignmentId || item.eventId === score.eventId) || {};
        return { score, event, assignment };
    }).filter(({ score, event }) => (!search || `${score.eventName || event.name || ''} ${score.judgeName || ''}`.toLowerCase().includes(search)) && (!category || event.category === category) && (!stageType || eventStageType(event) === stageType) && (!gender || genderLabel(event) === gender)).sort((a,b) => (b.score.submittedAt || 0) - (a.score.submittedAt || 0));
    list.innerHTML = submitted.length ? submitted.map(({ score, event, assignment }) => {
        const marks = Array.isArray(score.marks) ? score.marks : [];
        const pointRules = score.scoringSnapshot?.config?.points || [];
        const positionOrder = new Map(pointRules.map((rule, index) => [rule.label, index]));
        const placed = marks.filter(mark => mark.position).sort((a,b) => (positionOrder.get(a.position) ?? 999) - (positionOrder.get(b.position) ?? 999) || Number(b.mark || 0) - Number(a.mark || 0));
        const published = score.publishStatus === 'published';
        const when = [assignment.date && scheduleDateText(assignment.date), assignment.time && toAmPm(assignment.time)].filter(Boolean).join(' • ') || 'Schedule not set';
        return `<details class="rounded-2xl border ${published ? 'border-blue-200 bg-blue-50/40' : 'border-emerald-100 bg-emerald-50/50'} p-4 shadow-sm"><summary class="cursor-pointer list-none"><div class="space-y-3"><div class="flex items-start justify-between gap-2"><div class="min-w-0"><h4 class="truncate font-black text-slate-900">${escapeHtml(score.eventName || event.name || '')}</h4><p class="mt-1 text-xs font-bold text-slate-500">Judge: ${escapeHtml(score.judgeName || '')}</p></div><span class="shrink-0 rounded-full ${published ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'} px-2.5 py-1 text-[9px] font-black uppercase">${published ? 'Published' : 'Not Published'}</span></div><div class="grid grid-cols-2 gap-2 text-[10px] font-bold text-slate-600"><span class="rounded-lg bg-white px-2 py-1.5">${marks.length} entries</span><span class="rounded-lg bg-white px-2 py-1.5">${escapeHtml(when)}</span><span class="rounded-lg bg-fuchsia-100 px-2 py-1.5 text-fuchsia-700">Stage ${escapeHtml(eventScheduleStage(event) || assignment.stage || '-')}</span><span class="rounded-lg bg-white px-2 py-1.5">${escapeHtml(event.category || assignment.category || '')} • ${escapeHtml(genderLabel(event))}</span></div></div></summary><div class="mt-4 space-y-2 border-t border-emerald-100 pt-4">${placed.map(mark => `<div class="rounded-xl bg-white p-3"><div class="flex items-center justify-between gap-3"><div><span class="rounded-lg bg-indigo-100 px-2 py-1 text-[10px] font-black uppercase text-indigo-700">${escapeHtml(mark.position)}</span><p class="mt-2 text-sm font-black text-slate-900">${escapeHtml(mark.label || mark.participantId || '')}</p></div><span class="text-lg font-black text-emerald-700">${Number(mark.mark || 0)} pts</span></div>${mark.notes ? `<p class="mt-2 rounded-lg bg-slate-50 p-2 text-xs font-semibold text-slate-600">${escapeHtml(mark.notes)}</p>` : ''}</div>`).join('') || '<p class="py-3 text-center text-xs font-bold text-slate-400">No positions awarded.</p>'}<div class="grid grid-cols-2 gap-2 pt-2"><a href="publish.html?event=${encodeURIComponent(score.eventId || '')}&score=${encodeURIComponent(score.id || '')}" class="rounded-xl bg-emerald-600 px-3 py-2.5 text-center text-xs font-black text-white">Open Publishing</a><button data-admin-action="reopen-judge-score" data-id="${escapeHtml(score.id)}" class="rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-xs font-black text-amber-700">Reopen</button></div></div></details>`;
    }).join('') : '<p class="col-span-full py-10 text-center text-sm font-bold text-slate-400">No submitted score sheets match these filters.</p>';
};

window.reopenJudgeScore = async (id) => {
    if(window.confirmAction && !await window.confirmAction('Allow judge to edit this score sheet again?')) return;
    const score = judgeScores.find(item => item.id === id);
    if(!score || score.status !== 'submitted') return window.showToast('Only a submitted sheet can be reopened');
    const reopenReason = prompt('Enter the correction or review reason for the judge:')?.trim();
    if(!reopenReason) return window.showToast('A reopen reason is required');
    const batch = writeBatch(db);
    batch.update(doc(db, 'judgeScores', id), { status: 'draft', publishStatus: 'unpublished', reopenedAt: Date.now(), reopenReason, reopenedByUid: auth.currentUser?.uid || '', reopenCount: Number(score.reopenCount || 0) + 1 });
    batch.delete(doc(db, 'publicJudgingStatuses', score.assignmentId || id));
    await batch.commit();
    window.showToast('Score sheet reopened');
};
