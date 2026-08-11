import assert from 'node:assert/strict';
import {aggregateJudgeScores,buildTeamScoreLedger,calculateEventOutcome,createResultRevision,gradeForMark,rankMarks,judgeScoreToResult,resolveEventScoring} from '../score-utils.js';

const rules={enabled:{points:true,grades:true},gradeThresholds:[{minimumPercentage:80,value:5},{minimumPercentage:70,value:3},{minimumPercentage:60,value:1}],policies:{minimumPositionPolicy:'percentage',minimumPositionPercentage:60,jointPositionMethod:'competition',multipleJudgeMethod:'average',trimMinimumJudges:5},configs:{Single:{points:[{value:5},{value:3},{value:1}],grades:[{value:5},{value:3},{value:1}]},Group:{points:[{value:10},{value:5},{value:3}],grades:[{value:5},{value:3},{value:1}]}}};
const sheets=[80,90,100].map((value,index)=>({status:'submitted',judgeId:`j${index+1}`,marks:[{participantId:'p1',rawMark:value,evaluation:'awarded'},{participantId:'p2',rawMark:70,evaluation:'awarded'}]}));
assert.equal(aggregateJudgeScores(sheets,'average')[0].mark,90,'average aggregation');
assert.equal(aggregateJudgeScores([...sheets,{...sheets[0],judgeId:'j4',marks:[{participantId:'p1',rawMark:0,evaluation:'awarded'}]},{...sheets[0],judgeId:'j5',marks:[{participantId:'p1',rawMark:100,evaluation:'awarded'}]}],'trim_extremes',{trimMinimumJudges:5})[0].mark,90,'trim extremes');
assert.equal(aggregateJudgeScores([{status:'submitted',judgeId:'a',judgeWeight:1,marks:[{participantId:'p',rawMark:50}]},{status:'submitted',judgeId:'b',judgeWeight:3,marks:[{participantId:'p',rawMark:100}]}],'weighted')[0].mark,87.5,'weighted aggregation');
assert.deepEqual(gradeForMark(80,100,rules),{key:'grade_1',label:'A Grade',value:5,percentage:80},'automatic grade boundary');
assert.equal(rankMarks([{participantId:'low',mark:59},{participantId:'ok',mark:60}],rules,{maximumMark:100})[0].participantId,'ok','minimum position policy');
const tied=rankMarks([{participantId:'a',mark:90},{participantId:'b',mark:90},{participantId:'c',mark:80}],{...rules,policies:{...rules.policies,minimumPositionPolicy:'none'}},{maximumMark:100});assert.deepEqual(tied.map(item=>item.rank),[1,1,3],'competition ranking uses 1,1,3');
assert.equal(rankMarks([{participantId:'slow',mark:80},{participantId:'fast',mark:60}],rules,{maximumMark:100,resultMethod:'time'})[0].participantId,'fast','time-based events rank lower values first');
assert.equal(rankMarks([{participantId:'third',mark:3},{participantId:'first',mark:1}],rules,{maximumMark:100,resultMethod:'elimination'})[0].participantId,'first','elimination order ranks lower values first');
assert.equal(resolveEventScoring(rules,{type:'Group',scoringOverride:{enabled:{grades:false}}}).enabled.grades,false,'per-event override');
const outcome=calculateEventOutcome({scoreSheets:sheets,event:{id:'e1',type:'Single',maximumMark:100},rules});assert.equal(outcome.places[0].winners[0],'p1');assert.equal(outcome.gradeAwards.find(item=>item.label==='A Grade').winners[0],'p1');


const extendedRules={...rules,gradeThresholds:[{key:'distinction',label:'Distinction',minimumPercentage:90,value:8},{key:'merit',label:'Merit',minimumPercentage:75,value:4},{key:'pass',label:'Pass',minimumPercentage:50,value:1},{key:'participation',label:'Participation',minimumPercentage:25,value:0}],policies:{...rules.policies,minimumPositionPolicy:'none'},configs:{Single:{points:[5,4,3,2,1].map((value,index)=>({key:`place_${index+1}`,label:['Champion','Runner-up','Third','Fourth','Fifth'][index],value,tiePolicy:'full'})),grades:[8,4,1,0].map((value,index)=>({value}))},Group:rules.configs.Group}};
assert.deepEqual(gradeForMark(76,100,extendedRules),{key:'merit',label:'Merit',value:4,percentage:76},'custom fourth-grade model uses its configured threshold and label');
const splitThresholdRules={...extendedRules,configs:{...extendedRules.configs,Group:{...extendedRules.configs.Group,grades:[{key:'group_a',label:'Group A',minimumPercentage:95,value:10},{key:'group_b',label:'Group B',minimumPercentage:80,value:6},{key:'group_c',label:'Group C',minimumPercentage:50,value:2}]}}};
assert.deepEqual(gradeForMark(85,100,splitThresholdRules,{type:'Group'}),{key:'group_b',label:'Group B',value:6,percentage:85},'Group events use their own grade percentages');
assert.equal(gradeForMark(85,100,splitThresholdRules,{type:'Single'}).label,'Merit','Single events keep independent grade percentages');
const extendedSheets=[100,90,80,70,60].map((mark,index)=>({status:'submitted',judgeId:`extended-${index}`,marks:[{participantId:`extended-${index}`,rawMark:mark,evaluation:'awarded'}]}));
const extendedOutcome=calculateEventOutcome({scoreSheets:extendedSheets,event:{id:'extended',type:'Single',maximumMark:100},rules:extendedRules});
assert.equal(extendedOutcome.places.length,5,'all configured positions are produced');
assert.equal(extendedOutcome.places[4].label,'Fifth','custom position labels survive calculation');
assert.equal(extendedOutcome.gradeAwards.find(grade=>grade.key==='merit').label,'Merit','custom grade identity survives publication output');

const explicitJudgeResult=judgeScoreToResult({status:'submitted',marks:[{participantId:'p1',position:'First',positionValue:5,grade:'A Grade',gradeValue:5,rawMark:0,evaluation:'awarded'},{participantId:'p2',rawMark:0,evaluation:'no-award'}]},{id:'manual',type:'Single',maximumMark:100},rules);assert.equal(explicitJudgeResult.places[0].winners[0],'p1','explicit judge positions are preserved even when raw marks are present');assert.equal(explicitJudgeResult.gradeAwards[0].winners[0],'p1','explicit judge grades are preserved even when raw marks are present');
const groupResult={eventId:'g',status:'published',type:'Group',places:[{rank:1,value:10,winners:['group1']}],gradeAwards:[{label:'A Grade',value:5,winners:['group1']}]};const ledger=buildTeamScoreLedger([groupResult],()=> 'Blue',[{id:'g',type:'Group'}]);assert.equal(ledger.reduce((sum,item)=>sum+item.points,0),15,'group points counted once');
const revision=createResultRevision({revision:1,status:'published',places:[]},{status:'published',places:[{rank:1}]},{actorUid:'admin',reason:'Correct winner'});assert.equal(revision.revision,2);assert.ok(revision.previousRevision,'revision retains reversal source');
assert.throws(()=>createResultRevision({}, {}, {reason:'bad'}),/at least 5/,'revision reason required');
console.log('Scoring engine runtime checks passed');
