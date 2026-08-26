export const EVENT_FIELD_DEFINITIONS = Object.freeze([
 ['code','Custom Event Code','advanced'],['section','Section Grouping','standard'],['eligibleClasses','Per-event Class Restriction','standard'],['participantTypes','Participant Type Override','advanced'],['registrationChannels','Registration Channel Override','advanced'],['minimumMembers','Flexible Group Minimum','advanced'],['maximumMembers','Flexible Group Maximum','advanced'],['maximumMark','Maximum Mark','standard'],['criteriaText','Judging Criteria','standard'],['multipleJudgeMethod','Multiple Judge Override','advanced'],['tieBreakMethod','Tie-break Override','advanced'],['gradeMode','Grade Override','standard'],['duration','Event Duration','standard'],['preparationTime','Preparation Time','advanced'],['rules','Event Rules','basic'],['resultWorkflow','Result Workflow Override','advanced'],['scheduleRequirement','Schedule Requirement Override','advanced'],['teamPolicy','Team Policy Override','advanced'],['correctMark','Correct Answer Mark','advanced'],['wrongPenalty','Wrong Answer Penalty','advanced'],['countPenalty','Wrong Count Penalty','advanced'],['timeDirection','Time Direction','advanced'],['scoreContribution','Team-score Contribution','standard'],['scoringPolicy','Scoring Policy Override','advanced']
].map(([key,label,minimumMode])=>({key,label,minimumMode})));
const MODE_LEVEL={basic:0,standard:1,advanced:2};
export function eventFieldRulesForMode(mode='advanced',saved=[]) {const custom=new Map((Array.isArray(saved)?saved:[]).map(item=>[item.key,item]));return EVENT_FIELD_DEFINITIONS.map(field=>{const fallback=MODE_LEVEL[mode]>=MODE_LEVEL[field.minimumMode]?'optional':'hidden',value=custom.get(field.key)?.requirement;return {...field,requirement:['hidden','optional','required','conditional'].includes(value)?value:fallback};});}

const LANDING_ORDER_DEFAULTS={sections:['hero','about','leaders','schedule','gallery'],menu:['results','about','leaders','gallery','schedule','registration','login','teamStandings'],quickButtons:['results','about','leaders','gallery','schedule','registration','login','teamStandings']};
export const DEFAULT_PUBLIC_VIEW = Object.freeze({landing:{sections:{hero:true,about:true,leaders:true,gallery:true,schedule:true,teamStandings:true,social:true,footer:true},orders:LANDING_ORDER_DEFAULTS,menu:{results:true,about:true,leaders:true,gallery:true,schedule:true,registration:true,login:true,teamStandings:false},quickButtons:{results:false,about:true,leaders:true,gallery:true,schedule:true,registration:true,login:true,teamStandings:false},customLinks:[]},resultsPage:{defaultTab:'result',tabs:{result:true,team:true},audiences:{enabled:['student','parent','staff','alumni','public'],default:'student',showAll:true},resultsTab:{showCategories:true,includeGeneral:true,hideEmpty:false,scoreDisplay:'total',cardFields:{category:true,gender:false,team:true,chestNo:true,position:true,grade:true,positionPoints:false,gradePoints:false,totalPoints:true},downloads:{enabled:true,resultCard:true,certificate:true,poster:true}},teamsTab:{cardFields:{rank:true,total:true,medals:true,progress:true},breakdowns:{overall:true,category:true,gender:true,awards:true},showTimeline:true}}});
const mergePublicView=raw=>{const v=raw||{},l=v.landing||{},r=v.resultsPage||{},rt=r.resultsTab||{},tt=r.teamsTab||{};const ordered=(name)=>{const valid=LANDING_ORDER_DEFAULTS[name],saved=Array.isArray(l.orders?.[name])?l.orders[name]:[];return[...new Set([...saved.filter(key=>valid.includes(key)),...valid])];};return{landing:{sections:{...DEFAULT_PUBLIC_VIEW.landing.sections,...(l.sections||{})},orders:{sections:ordered('sections'),menu:ordered('menu'),quickButtons:ordered('quickButtons')},menu:{...DEFAULT_PUBLIC_VIEW.landing.menu,...(l.menu||{})},quickButtons:{...DEFAULT_PUBLIC_VIEW.landing.quickButtons,...(l.quickButtons||{})},customLinks:Array.isArray(l.customLinks)?l.customLinks.filter(item=>String(item?.label||'').trim()&&String(item?.url||'').trim()).map(item=>({label:String(item.label||'').trim(),url:String(item.url||'').trim(),icon:String(item.icon||'')})):[]},resultsPage:{...DEFAULT_PUBLIC_VIEW.resultsPage,...r,tabs:{...DEFAULT_PUBLIC_VIEW.resultsPage.tabs,...(r.tabs||{})},audiences:{...DEFAULT_PUBLIC_VIEW.resultsPage.audiences,...(r.audiences||{})},resultsTab:{...DEFAULT_PUBLIC_VIEW.resultsPage.resultsTab,...rt,cardFields:{...DEFAULT_PUBLIC_VIEW.resultsPage.resultsTab.cardFields,...(rt.cardFields||{})},downloads:{...DEFAULT_PUBLIC_VIEW.resultsPage.resultsTab.downloads,...(rt.downloads||{})}},teamsTab:{...DEFAULT_PUBLIC_VIEW.resultsPage.teamsTab,...tt,cardFields:{...DEFAULT_PUBLIC_VIEW.resultsPage.teamsTab.cardFields,...(tt.cardFields||{})},breakdowns:{...DEFAULT_PUBLIC_VIEW.resultsPage.teamsTab.breakdowns,...(tt.breakdowns||{})}}}};};

export const DEFAULT_FEST_SETUP = Object.freeze({
  setupVersion: 2,
  preset: 'school_team_fest',
  organisationMode: 'team',
  participantTypes: ['student'],
  participantTypeDefinitions: [
    { key:'student', label:'Student', description:'Students managed in the Student Directory.', system:true },
    { key:'parent', label:'Parent', description:'Parents or guardians linked to a student.', system:true },
    { key:'staff', label:'Staff', description:'Teaching and non-teaching staff participants.', system:true },
    { key:'alumni', label:'Alumni', description:'Former students and alumni participants.', system:true },
    { key:'public', label:'Public', description:'Open participants without an existing student record.', system:true },
    { key:'guest', label:'Guest', description:'Chief guests, special guests, speakers and invitees.', system:true },
    { key:'volunteer', label:'Volunteer', description:'Festival volunteers with duty and validity details.', system:true }
  ],
  allowedGenders: ['Boys', 'Girls'],
  registrationChannels: ['admin', 'teamLeader'],
  scheduleMode: 'full',
  judgingMode: 'enabled',
  resultWorkflow: 'judged',
  teamScoringMode: 'enabled',
  eventManagementMode:'advanced',
  eventFeatures:{excelImport:true,customCriteria:true,objectiveScoring:true,timeResults:true,countResults:true,directRank:true,multipleJudges:true,eventOverrides:true,workflowStatuses:true,importHistory:true,teamLedger:true},
  eligibleClasses:['1','2','3','4','5','6','7','8','9','10','+1','+2'],
  eventFieldProfile:'advanced',
  eventFieldRules: eventFieldRulesForMode('advanced'),
  registrationApprovalRequired: true,
  publisherApprovalRequired: true,
  competitionPolicies: {
    groupPositionPoints: { first: null, second: null, third: null },
    directRankGradeMode: '',
    minimumPositionPolicy: '',
    minimumPositionPercentage: null,
    jointPositionMethod: '',
    multipleJudgeMethod: '',
    trimMinimumJudges: null,
    generalGenderMode: '',
    publishedCorrectionMode: ''
  },
  studentFields: [
    { key: 'name', label: 'Student Name', type: 'text', enabled: true, required: true, system: true },
    { key: 'class', label: 'Class', type: 'select', options: ['1','2','3','4','5','6','7','8','9','10','+1','+2'], enabled: true, required: true, system: true },
    { key: 'guardianName', label: 'Guardian Name', type: 'text', enabled: true, required: true, system: false },
    { key: 'phone', label: 'Phone Number', type: 'tel', enabled: true, required: true, system: false }
  ],
  publicModules: { home: true, results: true, about: true, leaders: true, gallery: true, schedule: true, registration: false, login: true, teamStandings: true, tv: true },
  publicView: DEFAULT_PUBLIC_VIEW
});

export const FEST_PRESETS = Object.freeze({
  school_team_fest: {},
  simple_direct_fest: { organisationMode:'open', participantTypes:['student','parent','public'], registrationChannels:['admin','self'], scheduleMode:'disabled', judgingMode:'disabled', resultWorkflow:'direct', teamScoringMode:'disabled',eventManagementMode:'basic',eventFeatures:{excelImport:false,customCriteria:false,objectiveScoring:false,timeResults:false,countResults:false,directRank:true,multipleJudges:false,eventOverrides:false,workflowStatuses:false,importHistory:false,teamLedger:false}, publicModules:{schedule:false,registration:true,teamStandings:false} },
  open_registration_fest: { organisationMode:'open', participantTypes:['public'], registrationChannels:['admin','self','onSite'], scheduleMode:'basic', judgingMode:'optional', resultWorkflow:'hybrid', teamScoringMode:'disabled',eventManagementMode:'standard', publicModules:{schedule:true,registration:true,teamStandings:false} },
  hybrid_community_fest: { organisationMode:'hybrid', participantTypes:['student','parent','staff','public'], registrationChannels:['admin','teamLeader','self','onSite'], scheduleMode:'full', judgingMode:'optional', resultWorkflow:'hybrid', teamScoringMode:'per_event', publicModules:{schedule:true,registration:true,teamStandings:true} }
});

export const FEST_PRESET_GUIDES = Object.freeze({
  school_team_fest:{label:'School Team Fest',summary:'Full team/house festival with students, judges, schedules and championship scoring.',workflow:['Students','Team registration','Full schedule','Judge scoring','Publisher review','Public results','Team championship'],pages:['Team Portal','Judge Page','Publishing Desk','Public Results','TV Display','Poster & Certificate']},
  simple_direct_fest:{label:'Simple Direct Result Fest',summary:'Small open fest without judge assignments or detailed scheduling.',workflow:['Open registration','Admin review','Direct result entry','Public results'],pages:['Public Registration','Publishing Desk','Public Results','Poster & Certificate']},
  open_registration_fest:{label:'Open Registration Fest',summary:'Public-first festival with self/on-site registration, basic programme order and optional judging.',workflow:['Public registration','Admin approval','Basic programme order','Optional judging','Result publishing'],pages:['Public Registration','Judge Page when needed','Publishing Desk','Public Results','TV Display']},
  hybrid_community_fest:{label:'Hybrid Community Fest',summary:'Team and open participants together, with per-event judging and scoring policies.',workflow:['Team + public registration','Full schedule','Per-event judging','Publisher review','Team/open results'],pages:['Team Portal','Public Registration','Judge Page','Publishing Desk','Public Results','TV Display','Poster & Certificate']},
  custom:{label:'Custom',summary:'A manually adjusted setup that no longer exactly matches a built-in preset.',workflow:['Defined by the selected modules and policies'],pages:['Calculated from the enabled capabilities']}
});

const allowed = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const list = (value, choices, fallback) => {
  const clean = Array.isArray(value) ? [...new Set(value.filter(item => choices.includes(item)))] : [];
  return clean.length ? clean : [...fallback];
};

export function normalizeFestSetup(raw = {}) {
  const base = DEFAULT_FEST_SETUP;
  const participantTypeDefinitions = normalizeParticipantTypeDefinitions(raw.participantTypeDefinitions);
  const participantKeys = participantTypeDefinitions.map(item => item.key);
  const setup = {
    ...base,
    ...raw,
    organisationMode: allowed(raw.organisationMode, ['team', 'open', 'hybrid'], base.organisationMode),
    participantTypeDefinitions,
    participantTypes: list(raw.participantTypes, participantKeys, base.participantTypes),
    allowedGenders: list(raw.allowedGenders, ['Boys', 'Girls'], base.allowedGenders),
    registrationChannels: list(raw.registrationChannels, ['admin', 'teamLeader', 'self', 'onSite'], base.registrationChannels),
    scheduleMode: allowed(raw.scheduleMode, ['disabled', 'basic', 'full'], base.scheduleMode),
    judgingMode: allowed(raw.judgingMode, ['disabled', 'enabled', 'optional'], base.judgingMode),
    resultWorkflow: allowed(raw.resultWorkflow, ['direct', 'judged', 'hybrid'], base.resultWorkflow),
    teamScoringMode: allowed(raw.teamScoringMode, ['disabled', 'enabled', 'per_event'], base.teamScoringMode),
    eventManagementMode:allowed(raw.eventManagementMode,['basic','standard','advanced'],base.eventManagementMode),
    eventFieldProfile:allowed(raw.eventFieldProfile,['basic','standard','advanced','custom'],raw.eventManagementMode||base.eventManagementMode),
    eventFeatures:{...base.eventFeatures,...(raw.eventFeatures||{})},
    eventFieldRules:eventFieldRulesForMode(allowed(raw.eventFieldProfile,['basic','standard','advanced','custom'],raw.eventManagementMode||base.eventManagementMode)==='custom'?(raw.eventManagementMode||'advanced'):allowed(raw.eventFieldProfile,['basic','standard','advanced'],raw.eventManagementMode||base.eventManagementMode),raw.eventFieldRules),
    eligibleClasses:Array.isArray(raw.eligibleClasses)?[...new Set(raw.eligibleClasses.map(value=>String(value).trim()).filter(Boolean))]:base.eligibleClasses,
    publicModules: { ...base.publicModules, ...(raw.publicModules || {}) },
    publicView: mergePublicView(raw.publicView),
    studentFields: normalizeStudentFields(raw.studentFields),
    competitionPolicies: normalizeCompetitionPolicies(raw.competitionPolicies)
  };
  const classField=setup.studentFields.find(field=>field.key==='class');if(classField){const legacy=setup.eligibleClasses||[];if(!classField.options.length)classField.options=[...legacy];setup.eligibleClasses=[...classField.options];}
  if(setup.judgingMode === 'disabled' && setup.resultWorkflow === 'judged') setup.resultWorkflow = 'direct';
  if(setup.scheduleMode === 'disabled') setup.publicModules.schedule = false;
  if(setup.organisationMode === 'open') setup.registrationChannels = setup.registrationChannels.filter(channel => channel !== 'teamLeader');
  return setup;
}

export function normalizeParticipantTypeDefinitions(value) {
  const source=Array.isArray(value)&&value.length?value:DEFAULT_FEST_SETUP.participantTypeDefinitions;
  const clean=source.map((item,index)=>{const key=String(item?.key||item?.label||`participant_${index+1}`).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');return {key,label:String(item?.label||key).trim().slice(0,50),description:String(item?.description||'').trim().slice(0,240),system:!!item?.system};}).filter(item=>item.key&&item.label);
  const merged=new Map(DEFAULT_FEST_SETUP.participantTypeDefinitions.map(item=>[item.key,{...item}]));clean.forEach(item=>merged.set(item.key,{...(merged.get(item.key)||{}),...item,system:merged.has(item.key)||item.system}));return [...merged.values()];
}

const optionalChoice = (value, choices) => choices.includes(value) ? value : '';
const optionalNumber = value => value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
export function normalizeCompetitionPolicies(value = {}) {
  return {
    groupPositionPoints: {
      first: optionalNumber(value?.groupPositionPoints?.first),
      second: optionalNumber(value?.groupPositionPoints?.second),
      third: optionalNumber(value?.groupPositionPoints?.third)
    },
    directRankGradeMode: optionalChoice(value.directRankGradeMode, ['disabled','manual','converted_score','per_event']),
    minimumPositionPolicy: optionalChoice(value.minimumPositionPolicy, ['none','percentage','per_event']),
    minimumPositionPercentage: optionalNumber(value.minimumPositionPercentage),
    jointPositionMethod: optionalChoice(value.jointPositionMethod, ['competition','dense','shared_points','admin_manual','per_event']),
    multipleJudgeMethod: optionalChoice(value.multipleJudgeMethod, ['average','trim_extremes','weighted','admin_manual','per_event']),
    trimMinimumJudges: optionalNumber(value.trimMinimumJudges),
    generalGenderMode: optionalChoice(value.generalGenderMode, ['both','mixed','separate','admin_decision','per_event']),
    publishedCorrectionMode: optionalChoice(value.publishedCorrectionMode, ['revision_reversal','locked','admin_overwrite'])
  };
}

export function incompleteCompetitionPolicies(value = {}) {
  const policy = normalizeCompetitionPolicies(value), missing = [];
  if(['first','second','third'].some(key => policy.groupPositionPoints[key] === null)) missing.push('Group position points');
  if(!policy.directRankGradeMode) missing.push('Direct Rank grade mode');
  if(!policy.minimumPositionPolicy) missing.push('Minimum mark for position');
  if(policy.minimumPositionPolicy === 'percentage' && (policy.minimumPositionPercentage === null || policy.minimumPositionPercentage < 0 || policy.minimumPositionPercentage > 100)) missing.push('Minimum position percentage');
  if(!policy.jointPositionMethod) missing.push('Joint position method');
  if(!policy.multipleJudgeMethod) missing.push('Multiple judge method');
  if(policy.multipleJudgeMethod === 'trim_extremes' && (!Number.isInteger(policy.trimMinimumJudges) || policy.trimMinimumJudges < 3)) missing.push('Trim-method minimum judges');
  if(!policy.generalGenderMode) missing.push('General/Common gender mode');
  if(!policy.publishedCorrectionMode) missing.push('Published correction mode');
  return missing;
}

export function normalizeStudentFields(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_FEST_SETUP.studentFields;
  const clean = source.map((field, index) => {
    const key = String(field?.key || field?.label || `field_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const type = key === 'class' ? 'select' : allowed(field?.type, ['text','tel','email','number','date','select'], 'text');
    const options = type === 'select' && Array.isArray(field?.options) ? [...new Set(field.options.map(item => String(item).trim()).filter(Boolean))].slice(0, 100) : [];
    return { key, label:String(field?.label || key).trim().slice(0, 60), type, options, enabled:field?.enabled !== false, required:!!field?.required, system:['name','class','guardianName','phone'].includes(key) || !!field?.system };
  }).filter(field => field.key && field.label);
  const unique = [...new Map(clean.map(field => [field.key, field])).values()];
  const name = unique.find(field => field.key === 'name') || { key:'name', label:'Student Name', type:'text', enabled:true, required:true, system:true };
  name.enabled = true; name.required = true; name.system = true;
  return [name, ...unique.filter(field => field.key !== 'name')];
}
export const setupForPreset = name => { const preset=FEST_PRESETS[name]||{},mode=preset.eventManagementMode||DEFAULT_FEST_SETUP.eventManagementMode;return normalizeFestSetup({ ...DEFAULT_FEST_SETUP, ...preset, eventFieldProfile:mode,eventFieldRules:eventFieldRulesForMode(mode),publicModules:{...DEFAULT_FEST_SETUP.publicModules,...(preset.publicModules||{})}, preset:name }); };

export const scheduleEnabled = setup => normalizeFestSetup(setup).scheduleMode !== 'disabled';
export const judgingEnabled = setup => normalizeFestSetup(setup).judgingMode !== 'disabled';
export const directPublishingEnabled = setup => ['direct', 'hybrid'].includes(normalizeFestSetup(setup).resultWorkflow);
export const teamModeEnabled = setup => normalizeFestSetup(setup).organisationMode !== 'open';
export const selfRegistrationEnabled = setup => normalizeFestSetup(setup).registrationChannels.includes('self');
export function eventContributesToTeamScore(event = {}, setup = DEFAULT_FEST_SETUP) {
  const mode=normalizeFestSetup(setup).teamScoringMode, policy=event.scoreContribution || 'default';
  if(policy==='display_only'||policy==='individual') return false;
  if(policy==='team') return true;
  return mode==='enabled';
}

export function readableTextColor(color = '#4f46e5') {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '4f46e5';
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return ((r * 299 + g * 587 + b * 114) / 1000) >= 150 ? '#111827' : '#ffffff';
}

export const teamColor = (name, colors = {}) => /^#[0-9a-f]{6}$/i.test(colors?.[name] || '') ? colors[name] : '#4f46e5';
