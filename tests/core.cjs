// SPDX-License-Identifier: AGPL-3.0-only
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const src=fs.readFileSync(require('node:path').join(__dirname,'..','index.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/import\.meta\.url/g,"'https://example.com/index.js'" ).replace(/jQuery\(\(\)=>\{void init\(\).*$/m,'');
const c={chatId:'chat',characterId:0,chatMetadata:{note_prompt:'AN-unique'},chat:[{mes:'first'},{mes:'last',is_user:true,extra:{memory:'Old memory'}}],characters:[{avatar:'card.png',description:'Card unique',data:{extensions:{depth_prompt:{prompt:'card note'}}}}],maxContext:10000};
const storage=new Map();
const sandbox={console,structuredClone,Date,Map,TextDecoder,URL,Math,Number,Array,Object,JSON,Error,getContext:()=>c,extension_settings:{palimpest:{connectionProfile:'palimpest-micro:a',microPresets:[{id:'a',name:'Test',url:'https://example.com/v1',model:'mock',maxTokens:500}]},note:{}},power_user:{persona_description:'Persona unique'},extension_prompt_types:{IN_PROMPT:0},extension_prompt_roles:{SYSTEM:0},getStringHash:x=>x.length,groups:[],getWorldInfoPrompt:async(h,max,dry)=>{assert.deepEqual(Array.from(h),['last','first']);assert.equal(dry,true);return{worldInfoBefore:'WI-before',worldInfoAfter:'WI-after',worldInfoDepth:[{entries:['WI-depth']}],anBefore:['WI-AN'],outletEntries:{a:['WI-outlet']}}},getRequestHeaders:()=>({}),localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},jQuery:()=>{},fetch:async()=>{throw Error('not set')}};
vm.createContext(sandbox);vm.runInContext(src+'\nglobalThis.api={archiveFor,addRevision,activeText,buildSnapshot,continuationMessages,appendSuffix,requestMicro,recoverCheckpoint,parseResult,migrateSelection,findMicro,readMicroKey,rememberedMicroKey,saveMicroKey,removeRememberedKey,loadSettings,defaultPrompt,estimateTextTokens,textStats,appliedSource,continueCurrent,continueDraft,applyModernDraft};',sandbox);const a=sandbox.api;
(async()=>{
assert.equal(a.estimateTextTokens(''),0);
assert.equal(a.estimateTextTokens('a'.repeat(4000)),1000);
assert(a.estimateTextTokens('а'.repeat(4000))>1000);
assert(a.estimateTextTokens('漢'.repeat(4000))>4000);
assert(a.estimateTextTokens('\u2800'.repeat(20))>a.estimateTextTokens(' '.repeat(20)));
assert(a.textStats('one\u2800two').startsWith('2 words'));
assert(a.textStats('').includes('≈ 0 tokens'));
console.log('PASS: local approximate token counts, multilingual and Braille blank handling.');
// Prompt defaults are empty; local settings and legacy imports are never overwritten.
assert.equal(a.defaultPrompt,'');
const settingsBefore=sandbox.extension_settings;
sandbox.$=()=>({val(){return this},prop(){return this}});
sandbox.saveSettingsDebounced=()=>{};
sandbox.extension_settings={};a.loadSettings();assert.equal(sandbox.extension_settings.palimpest.prompt,'');
sandbox.extension_settings={memory:{prompt:'Private local fixture'}};a.loadSettings();assert.equal(sandbox.extension_settings.palimpest.prompt,'Private local fixture');
sandbox.extension_settings={palimpest:{prompt:'Existing local fixture'},memory:{prompt:'Older fixture'}};a.loadSettings();assert.equal(sandbox.extension_settings.palimpest.prompt,'Existing local fixture');
sandbox.extension_settings={palimpest:{prompt:''},memory:{prompt:'Older fixture'}};a.loadSettings();assert.equal(sandbox.extension_settings.palimpest.prompt,'');
sandbox.extension_settings=settingsBefore;
await assert.rejects(a.buildSnapshot(c,''),/Summary Prompt is empty/);
console.log('PASS: blank fresh default, local prompt migration and preservation, empty prompt validation.');
// Regression coverage: migrate the full legacy archive, not just its active text.
const oldArchive={schema:1,nextId:3,activeId:1,draftId:2,draftBase:1,draftSignature:'sig',revisions:[{id:1,text:'Active'},{id:2,text:'Draft'}],job:{snapshot:{messages:[{role:'system',content:'Original skeleton'}],messageCount:2},partial:'Draft + received text'}};
const oldChat={chatId:'legacy',chatMetadata:{sola_memory_archive_v1:oldArchive},chat:[{mes:'example'}]};
assert.equal(a.archiveFor(oldChat),oldArchive); // read-only lookup
assert.equal(a.archiveFor(oldChat,true),oldArchive);
assert.equal(oldChat.chatMetadata.palimpest_memory_archive_v1,oldArchive);
assert.equal(oldChat.chatMetadata.sola_memory_archive_v1,undefined);
assert.equal(a.activeText(oldChat),'Active');
assert(a.recoverCheckpoint(oldChat));assert.equal(oldArchive.revisions.at(-1).text,'Draft + received text');assert.equal(oldArchive.job.snapshot.messages[0].content,'Original skeleton');assert.equal(a.activeText(oldChat),'Active');
assert.equal(a.archiveFor(oldChat,true),oldArchive);assert.equal(oldArchive.revisions.length,3);
const newChat={chatId:'new',chatMetadata:{},chat:[{mes:'example'}]};a.archiveFor(newChat,true);assert(newChat.chatMetadata.palimpest_memory_archive_v1);assert(!newChat.chatMetadata.sola_memory_archive_v1);
const settings=sandbox.extension_settings.palimpest;settings.connectionProfile='sola-micro:a';a.migrateSelection(settings);assert.equal(settings.connectionProfile,'palimpest-micro:a');assert.equal(a.findMicro(settings.connectionProfile).id,'a');a.migrateSelection(settings);assert.equal(settings.connectionProfile,'palimpest-micro:a');
const native={connectionProfile:'Saved profile'};a.migrateSelection(native);assert.equal(native.connectionProfile,'Saved profile');
storage.set('sola-memory-key-v1:a','fixture-key');assert.equal(a.readMicroKey('a'),'fixture-key');assert.equal(storage.get('palimpest-memory-key-v1:a'),'fixture-key');assert(!storage.has('sola-memory-key-v1:a'));assert(a.rememberedMicroKey('a'));
a.saveMicroKey('a','session-only',false);assert.equal(a.readMicroKey('a'),'session-only');assert(!a.rememberedMicroKey('a'));assert(!storage.has('palimpest-memory-key-v1:a'));
storage.set('sola-memory-key-v1:b','old');storage.set('palimpest-memory-key-v1:b','new');assert.equal(a.readMicroKey('b'),'new');a.removeRememberedKey('b');assert.equal(a.readMicroKey('b'),'');assert(!storage.has('sola-memory-key-v1:b'));assert(!storage.has('palimpest-memory-key-v1:b'));
console.log('PASS: archive and checkpoint namespace migration, new chat isolation, profile selection and remembered-key migration.');
const ar=a.archiveFor(c,true);assert.equal(a.activeText(c),'Old memory');const snap=await a.buildSnapshot(c,'Original skeleton [Events Chronicle]');assert.equal(snap.messageCount,2);for(const x of ['AN-unique','Card unique','Persona unique','WI-before','WI-after','WI-depth','WI-AN','WI-outlet','Old memory','first','last'])assert(snap.messages[1].content.includes(x));assert(!snap.messages[1].content.includes('RP preset test'));const m=a.continuationMessages(snap,'Part one. Incom');assert(m[0].content.includes('Original skeleton'));assert.equal(m[2].content,'Part one. Incom');assert.equal(a.appendSuffix('Part one. Incom','plete.'),'Part one. Incomplete.');assert.equal(a.appendSuffix('Long old text to preserve unchanged.','Long old text to preserve unchanged. New.'),'Long old text to preserve unchanged. New.');ar.job={snapshot:snap,partial:'Interrupted partial'};assert(a.recoverCheckpoint(c));assert.equal(ar.revisions.at(-1).text,'Interrupted partial');assert.equal(a.activeText(c),'Old memory');let progress=[];let payload;const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');sandbox.fetch=async(url,opts)=>{payload=JSON.parse(opts.body);return new Response(new ReadableStream({start(ctrl){ctrl.enqueue(bytes.slice(0,27));ctrl.enqueue(bytes.slice(27));ctrl.close()}}),{headers:{'content-type':'text/event-stream'}})};const r=await a.requestMicro({url:'https://example.com/v1',model:'test',maxTokens:500},snap.messages,'key',500,{stream:true,onProgress:async t=>progress.push(t)});assert.equal(r.text,'Hello world');assert.equal(r.finishReason,'length');assert.equal(payload.proxy_password,'key');assert.equal(payload.messages[0].content,snap.messages[0].content);assert(!JSON.stringify(ar).includes('proxy_password'));const p=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Saved"}}]}\n\n');sandbox.fetch=async()=>new Response(new ReadableStream({start(ctrl){ctrl.enqueue(p);ctrl.close()}}),{headers:{'content-type':'text/event-stream'}});const q=await a.requestMicro({url:'https://example.com/v1',model:'test',maxTokens:500},snap.messages,'key',500,{stream:true});assert.equal(q.text,'Saved');assert.equal(q.finishReason,'interrupted');console.log('PASS: migration, isolated source snapshot, original skeleton, continuation, overlap, recovery, request routing, SSE length, interrupted EOF.');
// Exercise the actual active-continuation and apply control flow, using mocked UI and transport.
const fields=new Map();
sandbox.$=selector=>({val(value){if(arguments.length){fields.set(selector,value);return this;}return fields.get(selector)||'';},text(){return this;},show(){return this;}});
Object.assign(sandbox,{AbortController,is_send_press:false,is_group_generating:false,streamingProcessor:null,deactivateSendButtons:()=>{},activateSendButtons:()=>{},substituteParamsExtended:x=>x,confirm:()=>true});
const requests=[];let fail=false;sandbox.captureRequest=async(messages,signal,onProgress)=>{requests.push(messages);if(fail)throw Error('mock quota');await onProgress('pleted.');return {text:'pleted.',finishReason:'stop',profile:'Mock',model:'mock',usage:{}};};
vm.runInContext(`refreshModernUI=()=>{};renderHistory=()=>{};renderHistoryPreview=()=>{};loadDraftUI=()=>$('#palimpest_draft_contents').val(revisionById(archiveFor(),archiveFor()?.draftId)?.text??'');persistArchive=async()=>true;setMemoryContext=()=>{};requestSelected=captureRequest;`,sandbox);
c.chatMetadata={note_prompt:'AN-unique'};c.chat=[{mes:'first'},{mes:'last',is_user:true,extra:{memory:'Incom'}}];
settings.prompt='Original section skeleton';const aa=a.archiveFor(c,true),oldId=aa.activeId;
assert.equal(await a.continueCurrent(),'Incompleted.');assert.equal(aa.activeId,oldId);assert.equal(a.activeText(c),'Incom');assert.equal(requests[0].at(-2).content,'Incom');assert(requests[0][0].content.includes('Original section skeleton'));
await a.applyModernDraft();assert.equal(a.activeText(c),'Incompleted.');assert.equal(aa.draftId,null);assert(!aa.job);assert.equal(a.appliedSource(aa).revisionId,aa.activeId);assert(a.appliedSource(aa).snapshot.messages[0].content.includes('Original section skeleton'));
settings.prompt='Changed skeleton';c.chat.push({mes:'New later event'});fail=true;const id=aa.activeId;
assert.equal(await a.continueCurrent(),'');assert.equal(aa.activeId,id);assert.equal(a.activeText(c),'Incompleted.');assert.equal(aa.revisions.find(x=>x.id===aa.draftId).text,'Incompleted.');assert(requests[1][0].content.includes('Original section skeleton'));assert(!requests[1][1].content.includes('New later event'));
assert.equal(await a.continueCurrent(),'');assert.equal(requests.length,2);fail=false;await a.continueDraft();assert.equal(requests.length,3);assert.equal(requests[2].at(-2).content,'Incompleted.');assert.equal(aa.activeId,id);
console.log('PASS: old active memory fallback, exact applied snapshot retention, failed continuation seed recovery, pending-run guard, unchanged active memory.');
})().catch(e=>{console.error(e);process.exitCode=1});
