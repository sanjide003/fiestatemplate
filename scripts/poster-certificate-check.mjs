import assert from 'node:assert/strict';
import { normalizePosterCertificateModel, templateAvailableOn } from '../poster-certificate-engine.js';

const legacy = normalizePosterCertificateModel({ key:'certificate', status:'published', downloadAccess:{ publicResults:true, teamLeader:false } });
assert.equal(legacy.availability.publicResults.enabled, true);
assert.equal(legacy.availability.teamLeader.enabled, false);
assert.equal(templateAvailableOn(legacy, 'publicResults'), true);
assert.deepEqual(legacy.appliesTo.participantTypes, []);
assert.equal(legacy.output.format, 'pdf');

const structured = normalizePosterCertificateModel({ key:'judge_id', status:'published', availability:{ judge:{ enabled:true, scope:'ownProfile' } } });
assert.equal(structured.downloadAccess.judge, true);
assert.equal(structured.availability.judge.scope, 'ownProfile');
assert.equal(templateAvailableOn(structured, 'judge'), true);
assert.equal(templateAvailableOn({ ...structured, status:'draft' }, 'judge'), false);

const archived = normalizePosterCertificateModel({ key:'result_card', status:'archived', availability:{ publicResults:{ enabled:true } } });
assert.equal(archived.status, 'archived');
assert.equal(templateAvailableOn(archived, 'publicResults'), false);
console.log('Poster and certificate model checks passed');
