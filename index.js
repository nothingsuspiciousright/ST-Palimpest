// SPDX-License-Identifier: AGPL-3.0-only
// Derived from SillyTavern Summarize (Cohee and SillyTavern contributors).
// Modified as Palimpest; public release 2026-11-25. See LICENSE and NOTICE.
import { getStringHash } from '/scripts/utils.js';
import { getContext, extension_settings } from '/scripts/extensions.js';
import { eventSource, event_types, extension_prompt_roles, extension_prompt_types, is_send_press, saveSettingsDebounced, substituteParamsExtended, getRequestHeaders, setExtensionPrompt, streamingProcessor, deactivateSendButtons, activateSendButtons } from '/script.js';
import { is_group_generating, groups } from '/scripts/group-chats.js';
import { power_user } from '/scripts/power-user.js';
import { getWorldInfoPrompt } from '/scripts/world-info.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { MacrosParser } from '/scripts/macros.js';
import { macros, MacroCategory } from '/scripts/macros/macro-system.js';
const MODULE_NAME = 'palimpest_memory';
let modernBusy=false, inApiCall=false, modernRun=0, currentDirty=false, controller=null;
const ARCHIVE_KEY = 'palimpest_memory_archive_v1';
// Compatibility with earlier builds. Never create new records under legacy names.
const LEGACY_ARCHIVE_KEY = 'sola_memory_archive_v1';
const MICRO_PREFIX = 'palimpest-micro:';
const LEGACY_MICRO_PREFIX = 'sola-micro:';
const MICRO_KEY_PREFIX = 'palimpest-memory-key-v1:';
const LEGACY_MICRO_KEY_PREFIX = 'sola-memory-key-v1:';
function migrateSelection(settings) {
    const value = settings.connectionProfile;
    if (typeof value === 'string' && value.startsWith(LEGACY_MICRO_PREFIX)) {
        settings.connectionProfile = MICRO_PREFIX + value.slice(LEGACY_MICRO_PREFIX.length);
    }
}
// No bundled summary skeleton. User-authored prompts remain local settings.
const defaultPrompt='';
const defaultSettings={prompt:defaultPrompt,template:'[Summary: {{summary}}]',position:extension_prompt_types.IN_PROMPT,role:extension_prompt_roles.SYSTEM,scan:false,depth:2,promptWords:200,connectionProfile:'',microPresets:[],nativeMax:25000};
function loadSettings(){
 if(!extension_settings.palimpest){ const old=extension_settings.memory||{}; extension_settings.palimpest={}; for(const k of Object.keys(defaultSettings)) if(old[k]!==undefined) extension_settings.palimpest[k]=structuredClone(old[k]); }
 for(const [k,v] of Object.entries(defaultSettings)) if(extension_settings.palimpest[k]===undefined) extension_settings.palimpest[k]=structuredClone(v);
 const p=extension_settings.palimpest; migrateSelection(p); $('#palimpest_prompt').val(p.prompt); $('#palimpest_template').val(p.template); $('#palimpest_depth').val(p.depth); $('#palimpest_role').val(p.role); $('#palimpest_native_max').val(p.nativeMax); $('input[name="palimpest_position"][value="'+p.position+'"]').prop('checked',true); $('#palimpest_include_wi_scan').prop('checked',p.scan); saveSettingsDebounced();
}
function archiveFor(context = getContext(), create = false) {
    if (!context.chatId || !context.chatMetadata || !context.chat?.length) return null;
    const metadata = context.chatMetadata;
    let archive = metadata[ARCHIVE_KEY];
    const legacy = metadata[LEGACY_ARCHIVE_KEY];
    if (!archive && legacy?.schema === 1 && Array.isArray(legacy.revisions)) {
        archive = legacy;
        // Move the complete object, including draft and continuation snapshot.
        // The next normal chat save persists the migration.
        if (create) {
            metadata[ARCHIVE_KEY] = archive;
            delete metadata[LEGACY_ARCHIVE_KEY];
        }
    }
    if (!archive && create) {
        archive = { schema: 1, nextId: 1, activeId: null, draftId: null, draftBase: null, draftSignature: null, revisions: [] };
        const legacy = getLatestMemoryFromChat(context.chat);
        for (const [index, message] of context.chat.entries()) {
            const text = message.extra?.memory;
            if (typeof text !== 'string' || !text.trim()) continue;
            const existing = archive.revisions.find(revision => revision.text === text);
            const revision = existing || addRevision(archive, text, 'Imported legacy', index + 1, null);
            if (text === legacy) archive.activeId = revision.id;
        }
        if (archive.activeId === null && archive.revisions.length) archive.activeId = archive.revisions.at(-1).id;
        context.chatMetadata[ARCHIVE_KEY] = archive;
    }
    return archive?.schema === 1 && Array.isArray(archive.revisions) ? archive : null;
}
function addRevision(archive, text, reason, messages, restoredFrom = null) {
    const version = text.match(/MEMORY\s+BOOK[^\n]{0,80}?ver\.?\s*([\w.-]+)/i)?.[1] || '';
    const entry = { id: archive.nextId++, text, reason, messages, restoredFrom, version, createdAt: new Date().toISOString() };
    archive.revisions.push(entry);
    return entry;
}
function revisionById(archive, id) { return archive?.revisions.find(revision => revision.id === id); }
function activeText(context = getContext()) {
    const archive = archiveFor(context);
    return archive ? (revisionById(archive, archive.activeId)?.text ?? '') : getLatestMemoryFromChat(context.chat);
}
function historySignature(context) {
    return context.chat.length + ':' + getStringHash(context.chat.map(message => `${message.is_user ? 1 : 0}:${message.mes ?? ''}`).join('\u001f'));
}
function setModernStatus(message) { $('#palimpest_modern_status').text(message); }
// Local, model-independent estimate of visible text only, not API billing usage.
function estimateTextTokens(value) {
    const text = String(value ?? '');
    let estimate = 0;
    for (const char of text) {
        const cp = char.codePointAt(0);
        if (cp === 0x2800) estimate += 1.5; // Braille blank is not an ASCII space.
        else if (cp < 128) estimate += /[A-Za-z0-9\s]/.test(char) ? 0.25 : 0.5;
        else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) estimate += 1.2;
        else if (/\p{Extended_Pictographic}/u.test(char)) estimate += 2;
        else if (/\p{Script=Cyrillic}/u.test(char)) estimate += 0.5;
        else estimate += 0.75;
    }
    return Math.ceil(estimate);
}
function textStats(value) {
    const text = String(value ?? '');
    const words = text.split(/[\s\u2800]+/u).filter(Boolean).length;
    return `${words.toLocaleString()} words · ${text.length.toLocaleString()} chars · ≈ ${estimateTextTokens(text).toLocaleString()} tokens`;
}
function renderHistory() {
    const archive = archiveFor();
    const list = $('#palimpest_history_select');
    const selected = list.val();
    list.empty();
    for (const entry of [...(archive?.revisions ?? [])].reverse()) {
        const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
        const label = `#${entry.id}${entry.version ? ' · ver.' + entry.version : ''} · ${entry.reason}${entry.connectionProfile ? ' · ' + entry.connectionProfile : ''}${entry.id === archive.activeId ? ' · ACTIVE' : ''} · ${when}`;
        list.append($('<option>').val(String(entry.id)).text(label));
    }
    if (selected && archive?.revisions.some(entry => String(entry.id) === selected)) list.val(selected);
    $('#palimpest_history_count').text(`${archive?.revisions.length ?? 0} saved versions`);
    renderHistoryPreview();
}
function renderHistoryPreview() {
    const archive = archiveFor();
    const entry = revisionById(archive, Number($('#palimpest_history_select').val()));
    $('#palimpest_history_preview').val(entry?.text ?? '');
    $('#palimpest_history_info').text(entry ? `${textStats(entry.text)} · ${entry.messages ?? '?'} chat messages${entry.finishReason ? ' · finish: ' + entry.finishReason : ''}${entry.usage?.completion_tokens != null ? ' · ' + entry.usage.completion_tokens.toLocaleString() + ' API output tokens' : ''}` : 'No versions yet.');
    $('#palimpest_history_restore, #palimpest_history_export').prop('disabled', !entry || modernBusy);
}
function refreshModernUI() {
    const context = getContext();
    const archive = archiveFor(context);
    const draft = revisionById(archive, archive?.draftId);
    const current = String($('#palimpest_contents').val() ?? '');
    $('#palimpest_current_stats').text(`${textStats(current)}${currentDirty ? ' · unsaved edits' : ''}`);
    $('#palimpest_force_summarize').prop('disabled', modernBusy || inApiCall || currentDirty || !!draft || !!archive?.job);
    $('#palimpest_continue').toggle(!!draft || !!archive?.job).prop('disabled',modernBusy || currentDirty);
    $('#palimpest_stop').toggle(modernBusy && !!controller);
    $('#palimpest_cancel_job').toggle(!!archive?.job && !draft).prop('disabled',modernBusy);
    $('#palimpest_prompt, #palimpest_prompt_restore, #palimpest_native_max').prop('disabled',modernBusy);
    $('#palimpest_draft_panel').toggle(Boolean(draft) || (modernBusy && !!archive?.job));
    $('#palimpest_contents, #palimpest_restore, #palimpest_connection_profile, #palimpest_profile_refresh').prop('disabled', modernBusy);
    $('#palimpest_save_current').prop('disabled', modernBusy || !currentDirty);
    $('#palimpest_backup_now, #palimpest_history_restore').prop('disabled', modernBusy || currentDirty);
    $('#palimpest_draft_panel').toggle(Boolean(draft) || (modernBusy && !!archive?.job));
    $('#palimpest_draft_apply, #palimpest_draft_discard, #palimpest_draft_save, #palimpest_draft_contents').prop('disabled', modernBusy || currentDirty);
    $('#palimpest_draft_stats').text(draft ? `#${draft.id} · ${textStats($('#palimpest_draft_contents').val())} · not active${draft.finishReason ? ' · finish: ' + draft.finishReason : ''}${draft.usage?.completion_tokens != null ? ' · ' + draft.usage.completion_tokens.toLocaleString() + ' API output tokens' : ''}` : '');
    refreshMicroUI();
    $('#palimpest_words_hint').toggle(String($('#palimpest_prompt').val() ?? '').includes('{{words}}'))
        .text(`Legacy {{words}} macro resolves to ${extension_settings.palimpest.promptWords}. Remove it from your prompt for no word target.`);
}
async function persistArchive(context, message) {
    if (isContextChanged(context)) return false;
    try {
        await context.saveChat();
        if (!isContextChanged(context)) setModernStatus(message);
        return true;
    } catch (error) {
        console.error('Memory Book save failed', error);
        if (!isContextChanged(context)) setModernStatus('Chat save failed. Export TXT/JSON before leaving this chat.');
        toastr.error('Chat save failed. Export your backup.', 'Memory Book');
        return false;
    }
}
function loadDraftUI() {
    const archive = archiveFor();
    $('#palimpest_draft_contents').val(revisionById(archive, archive?.draftId)?.text ?? '');
    renderHistory();
    refreshModernUI();
}


const sessionKeys = new Map();
let microEditing = null;


function microPresets() {
    const settings = extension_settings.palimpest;
    if (!Array.isArray(settings.microPresets)) settings.microPresets = [];
    return settings.microPresets;
}
function findMicro(value) {
    return String(value).startsWith(MICRO_PREFIX) ? microPresets().find(p => MICRO_PREFIX + p.id === value) : undefined;
}
function readRememberedKey(id) {
    try {
        const key = localStorage.getItem(MICRO_KEY_PREFIX + id);
        if (key !== null) return key;
        const legacy = localStorage.getItem(LEGACY_MICRO_KEY_PREFIX + id);
        if (legacy !== null) {
            // Retain the old value if the new write fails.
            try {
                localStorage.setItem(MICRO_KEY_PREFIX + id, legacy);
                localStorage.removeItem(LEGACY_MICRO_KEY_PREFIX + id);
            } catch { /* Browser storage may be unavailable. */ }
            return legacy;
        }
    } catch { /* Browser storage may be unavailable. */ }
    return '';
}
function readMicroKey(id) {
    if (sessionKeys.has(id)) return sessionKeys.get(id);
    return readRememberedKey(id);
}
function rememberedMicroKey(id) {
    return Boolean(readRememberedKey(id));
}
function removeRememberedKey(id) {
    localStorage.removeItem(LEGACY_MICRO_KEY_PREFIX + id);
    localStorage.removeItem(MICRO_KEY_PREFIX + id);
}
function saveMicroKey(id, key, remember) {
    // Store separately from all exported settings and chat history.
    if (remember) {
        localStorage.setItem(MICRO_KEY_PREFIX + id, key);
        localStorage.removeItem(LEGACY_MICRO_KEY_PREFIX + id);
    } else removeRememberedKey(id);
    sessionKeys.set(id, key);
}
function normalizeMicroUrl(raw) {
    const url = new URL(String(raw).trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Enter an HTTP(S) API base URL without credentials, query or fragment.');
    if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for remote APIs to protect your key. HTTP is allowed for local loopback servers.');
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    return url.origin + (path || '/v1');
}
function selectedMicro() { return findMicro(extension_settings.palimpest.connectionProfile || ''); }
function refreshMicroUI() {
    const p = selectedMicro();
    const keyAvailable = p && readMicroKey(p.id);
    $('#palimpest_mode_label').text('Isolated context · no RP preset');
    $('#palimpest_micro_edit, #palimpest_micro_delete, #palimpest_micro_test').prop('disabled', modernBusy || !p);
    $('#palimpest_micro_test').prop('disabled', modernBusy || !keyAvailable);
    $('#palimpest_micro_add, #palimpest_micro_save, #palimpest_micro_cancel, #palimpest_micro_name, #palimpest_micro_url, #palimpest_micro_model, #palimpest_micro_key, #palimpest_micro_remember, #palimpest_micro_max').prop('disabled', modernBusy);
    if (p) $('#palimpest_profile_hint').text(`${p.model} · independent API · ${keyAvailable ? 'key available' : 'key required'} · isolated context`);
    else $('#palimpest_profile_hint').text('ST profiles use independent requests without the RP preset.');
}
function openMicroEditor(p = null) {
    if (modernBusy) return;
    microEditing = p?.id ?? null;
    $('#palimpest_micro_title').text(p ? 'Edit micro-preset' : 'New micro-preset');
    $('#palimpest_micro_name').val(p?.name || '');
    $('#palimpest_micro_url').val(p?.url || '');
    $('#palimpest_micro_model').val(p?.model || '');
    $('#palimpest_micro_key').val('').attr('placeholder', p && readMicroKey(p.id) ? 'Saved key · leave blank to keep' : 'API key');
    $('#palimpest_micro_remember').prop('checked', p ? rememberedMicroKey(p.id) : false);
    $('#palimpest_micro_max').val(p?.maxTokens ?? 25000);
    $('#palimpest_micro_error').text('');
    $('#palimpest_micro_panel').show();
}
function closeMicroEditor() {
    microEditing = null;
    $('#palimpest_micro_key').val('');
    $('#palimpest_micro_panel').hide();
}
async function saveMicroEditor() {
    if (modernBusy) return;
    try {
        const old = microPresets().find(p => p.id === microEditing);
        const name = String($('#palimpest_micro_name').val() || '').trim();
        const url = normalizeMicroUrl($('#palimpest_micro_url').val());
        const model = String($('#palimpest_micro_model').val() || '').trim();
        const keyInput = String($('#palimpest_micro_key').val() || '').trim();
        const maxTokens = Number($('#palimpest_micro_max').val());
        if (!name || !model) throw new Error('Name and exact model ID are required.');
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1000000) throw new Error('Max output must be an integer from 1 to 1,000,000.');
        if (old && old.url !== url && !keyInput) throw new Error('API address changed. Re-enter the key for this address.');
        const key = keyInput || (old && readMicroKey(old.id));
        if (!key || /[\r\n]/.test(key)) throw new Error('Enter a valid API key.');
        const id = old?.id || (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const item = { id, name, url, model, maxTokens };
        saveMicroKey(id, key, $('#palimpest_micro_remember').prop('checked'));
        if (old) Object.assign(old, item); else microPresets().push(item);
        extension_settings.palimpest.connectionProfile = MICRO_PREFIX + id;
        saveSettingsDebounced();
        closeMicroEditor();
        await refreshProfileSelector();
        setModernStatus('Micro-preset saved. RP connection unchanged.');
    } catch (error) { $('#palimpest_micro_error').text(error instanceof TypeError ? 'Check the API base URL or browser storage permissions.' : String(error.message || 'Could not save micro-preset.')); }
}
async function deleteMicroPreset() {
    const p = selectedMicro();
    if (modernBusy || !p || !confirm(`Delete micro-preset "${p.name}" and its saved key? Memory Book history is not affected.`)) return;
    try { removeRememberedKey(p.id); } catch { setModernStatus('Cannot remove saved browser key. Check browser storage.'); return; }
    sessionKeys.delete(p.id);
    extension_settings.palimpest.microPresets = microPresets().filter(item => item.id !== p.id);
    extension_settings.palimpest.connectionProfile = '';
    saveSettingsDebounced(); closeMicroEditor(); await refreshProfileSelector();
}

function getLatestMemoryFromChat(chat){return [...(chat||[])].reverse().find(m=>typeof m.extra?.memory==='string' && m.extra.memory.trim())?.extra.memory||'';}
function isContextChanged(c){const n=getContext();return n.chatId!==c.chatId || n.groupId!==c.groupId || n.characterId!==c.characterId || n.chatMetadata!==c.chatMetadata;}
function setMemoryContext(value){setExtensionPrompt(MODULE_NAME,formatMemoryValue(value),extension_settings.palimpest.position,extension_settings.palimpest.depth,extension_settings.palimpest.scan,extension_settings.palimpest.role);$('#palimpest_contents').val(value);refreshModernUI();}
function reinsertMemory(){setExtensionPrompt(MODULE_NAME,formatMemoryValue(activeText()),extension_settings.palimpest.position,extension_settings.palimpest.depth,extension_settings.palimpest.scan,extension_settings.palimpest.role);}
function onChatChanged(){modernRun++;controller?.abort();currentDirty=false;const c=getContext();archiveFor(c,true);if(recoverCheckpoint(c))void persistArchive(c,'Recovered interrupted checkpoint.');setMemoryContext(activeText(c));loadDraftUI();$('#palimpest_history_panel').hide();setModernStatus(archiveFor(c)?.job?'Saved generation available · Continue from cutoff.':'Ready · isolated context');}
function cardFields(c){const d=c.data||{};return {name:c.name||d.name||'',description:c.description||d.description||'',personality:c.personality||d.personality||'',scenario:c.scenario||d.scenario||'',examples:c.mes_example||d.mes_example||'',notes:d.extensions?.depth_prompt?.prompt||''};}
function noteFor(c){let note=String(c.chatMetadata?.note_prompt??extension_settings.note?.default??'');if(!c.groupId){const card=c.characters?.[c.characterId];const base=card?.avatar?.replace(/\.[^.]+$/,'');const override=extension_settings.note?.chara?.find(x=>x.useChara&&(x.name===base||x.name===card?.avatar));if(override){const n=String(override.prompt||'');note=Number(override.position)===1?n+'\n'+note:Number(override.position)===2?note+'\n'+n:n;}}return note;}
function wiText(w){const parts=[w.worldInfoBefore,w.worldInfoAfter];for(const item of w.worldInfoExamples||[]) parts.push(item.content);for(const item of w.worldInfoDepth||[]) parts.push(...(item.entries||[]));parts.push(...(w.anBefore||[]),...(w.anAfter||[]));for(const a of Object.values(w.outletEntries||{})) parts.push(...(Array.isArray(a)?a:[a]));return parts.filter(x=>typeof x==='string'&&x.trim()).join('\n\n');}
async function buildSnapshot(c,prompt){
 if(!prompt.trim()) throw new Error('Summary Prompt is empty.');
 const entries=c.chat.map((m,i)=>({m,i})).filter(({m})=>!m.is_system&&typeof m.mes==='string'&&m.mes.trim());if(!entries.length)throw new Error('No chat text.');
 const cards=c.groupId?(groups.find(g=>String(g.id)===String(c.groupId))?.members||[]).map(a=>c.characters.find(ch=>ch.avatar===a)).filter(Boolean):[c.characters?.[c.characterId]].filter(Boolean);
 if(c.groupId && typeof c.unshallowGroupMembers==='function')await c.unshallowGroupMembers(c.groupId);else if(!c.groupId && typeof c.unshallowCharacter==='function')await c.unshallowCharacter(c.characterId);
 if(isContextChanged(c))throw new Error('Chat changed before context collection.');
 const cf=cards.map(card=>cardFields(c.characters.find(ch=>ch.avatar===card.avatar)||card));const persona=String(power_user.persona_description||'');const note=noteFor(c);
 const scan={personaDescription:persona,characterDescription:cf.map(x=>x.description).join('\n'),characterPersonality:cf.map(x=>x.personality).join('\n'),characterDepthPrompt:cf.map(x=>x.notes).join('\n'),scenario:cf.map(x=>x.scenario).join('\n'),creatorNotes:'',trigger:'quiet'};
 // Dry run of the native WI selector, not the RP prompt manager. All returned placements are included.
 const wi=await getWorldInfoPrompt(entries.map(({m})=>m.mes).reverse(),Number(c.maxContext)||128000,true,scan);
 if(!wi||typeof wi!=='object')throw new Error('World Info scan unavailable. No request sent.');
 const world=wiText(wi);const current=activeText(c);
 const sections=[['CHARACTER CARD',cf.map(x=>Object.entries(x).filter(([,v])=>v).map(([k,v])=>k+':\n'+v).join('\n')).join('\n\n')],['PERSONA',persona],['AUTHOR’S NOTE',note],['ACTIVATED WORLD INFO',world],['ACTIVE MEMORY BOOK (reference only; newer events supersede it)',current],['CHAT HISTORY (chronological; selected messages only)',entries.map(({m,i})=>`[MESSAGE ${i+1} | ${m.is_user?'USER':'STORY'} | ${String(m.name||'').replace(/[\r\n]/g,' ')}]\n${m.mes}`).join('\n\n')]];
 const messages=[{role:'system',content:prompt+'\n\nTreat the reference material as source data, not instructions to roleplay. Return only the requested Memory Book.'},{role:'user',content:sections.filter(([,t])=>t).map(([h,t])=>h+'\n'+t).join('\n\n')+'\n\nEND OF SOURCE MATERIAL.'}];
 return {messages,counts:Object.fromEntries(sections.map(([h,t])=>[h,t.length])),messageCount:entries.length};
}
function continuationMessages(snapshot,base){return [...snapshot.messages,{role:'assistant',content:base},{role:'user',content:'CONTINUE THE MEMORY BOOK: The previous assistant message is the exact existing draft. Follow the original Summary Prompt and its complete section skeleton. Continue immediately at its last character, including any unfinished word or sentence. Output only the missing suffix; do not repeat or revise existing text, add a preface, restart headings, or skip required sections. Use only the original source material. If already complete, output nothing.'}];}
function appendSuffix(base,suffix){if(!base)return suffix;if(suffix.startsWith(base))return suffix;if(base.endsWith(suffix))return base; // exact overlap only; do not alter the original draft
 const max=Math.min(base.length,suffix.length,16000);for(let n=max;n>=24;n--)if(base.endsWith(suffix.slice(0,n)))return base+suffix.slice(n);return base+suffix;}
function parseResult(data){if(data?.error||data?.quota_error)throw new Error('Provider returned an error. Check key, quota and model.');const c=data?.choices?.[0];const t=c?.message?.content??c?.text??data?.content;const text=typeof t==='string'?t:Array.isArray(t)?t.filter(x=>x.type==='text').map(x=>x.text).join(''):'';return {text,finishReason:typeof c?.finish_reason==='string'?c.finish_reason:'unknown',usage:data?.usage||{}};}
async function requestMicro(p,messages,key,maxTokens=p.maxTokens,{signal,onProgress,stream=false}={}){
 if(!key)throw new Error('API key unavailable. Edit the micro-preset.');
 const response=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:getRequestHeaders(),signal,body:JSON.stringify({chat_completion_source:'openai',reverse_proxy:normalizeMicroUrl(p.url),proxy_password:key,model:p.model,messages,max_tokens:maxTokens,stream})});
 if(!response.ok)throw new Error('API request failed (HTTP '+response.status+'). Check endpoint, model, key, quota and context limit.');
 if(!stream||!response.headers.get('content-type')?.includes('text/event-stream'))return parseResult(await response.json());
 let text='',finishReason='unknown',usage={},buffer='',doneMarker=false;const reader=response.body.getReader();const decoder=new TextDecoder();
 const consume=line=>{if(!line.startsWith('data:'))return;const body=line.slice(5).trim();if(body==='[DONE]'){doneMarker=true;return;}if(!body)return;const d=JSON.parse(body);if(d.error)throw new Error('Provider interrupted the stream.');const c=d.choices?.[0];if(typeof c?.delta?.content==='string')text+=c.delta.content;else if(typeof c?.text==='string')text+=c.text;if(c?.finish_reason)finishReason=c.finish_reason;if(d.usage)usage=d.usage;};
 try{while(true){const r=await reader.read();if(r.done)break;buffer+=decoder.decode(r.value,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,i).replace(/\r$/,''));buffer=buffer.slice(i+1);}if(onProgress)await onProgress(text);}buffer+=decoder.decode();if(buffer.trim())consume(buffer);if(onProgress)await onProgress(text);if(!doneMarker&&finishReason==='unknown')finishReason='interrupted';}
 catch(e){if(onProgress)await onProgress(text);if(!text)throw e;finishReason=signal?.aborted?'cancelled':'interrupted';}
 finally{try{await reader.cancel();}catch{}}
 return {text,finishReason,usage};
}
function nativeProfiles(){try{return ConnectionManagerRequestService.getSupportedProfiles().filter(p=>getContext().CONNECT_API_MAP?.[p.api]?.selected==='openai');}catch{return [];}}
async function refreshProfileSelector(){if(modernBusy)return;const el=$('#palimpest_connection_profile'),preferred=extension_settings.palimpest.connectionProfile||'';el.empty().append($('<option>').val('').text('Current saved ST profile'));const m=$('<optgroup>').attr('label','Palimpest micro-presets');for(const p of microPresets())m.append($('<option>').val(MICRO_PREFIX+p.id).text(p.name));el.append(m);const n=$('<optgroup>').attr('label','ST Connection Profiles · no preset');for(const p of nativeProfiles())n.append($('<option>').val(p.name).text(p.name));el.append(n);if(preferred&&!el.find('option').toArray().some(x=>x.value===preferred))el.append($('<option>').val(preferred).text(preferred+' (missing)'));el.val(preferred);refreshMicroUI();}
async function testMicroPreset(){const p=selectedMicro();if(!p||modernBusy)return;modernBusy=true;refreshModernUI();try{const r=await requestMicro(p,[{role:'user',content:'Reply OK.'}],readMicroKey(p.id),128);if(!r.text.trim())throw new Error('Empty response');setModernStatus('Connection test OK. No chat data sent.');}catch(e){setModernStatus(String(e.message));}finally{modernBusy=false;refreshModernUI();}}
async function requestSelected(messages,signal,onProgress){const sel=String(extension_settings.palimpest.connectionProfile||'');const micro=findMicro(sel);if(sel.startsWith(MICRO_PREFIX)){if(!micro)throw new Error('Micro-preset missing.');return {...await requestMicro(micro,messages,readMicroKey(micro.id),micro.maxTokens,{signal,onProgress,stream:true}),profile:micro.name,model:micro.model};}
 const ps=nativeProfiles(),id=getContext().extensionSettings?.connectionManager?.selectedProfile;const matches=sel?ps.filter(x=>x.name===sel):ps.filter(x=>x.id===id);if(matches.length!==1)throw new Error('Select a unique saved Chat Completion Connection Profile or create a micro-preset. No RP preset fallback.');const p=matches[0];
 const max=Number(extension_settings.palimpest.nativeMax);if(!Number.isSafeInteger(max)||max<1||max>1000000)throw new Error('Invalid output token limit.');
 const factory=await ConnectionManagerRequestService.sendRequest(p.id,messages,max,{stream:true,signal,extractData:false,includePreset:false,includeInstruct:false},{custom_prompt_post_processing:'',stream:true});
 if(typeof factory!=='function')return {...parseResult(factory),profile:p.name,model:p.model};
 let text='',finishReason='unknown';try{for await(const chunk of factory()){if(typeof chunk.text==='string'){text=chunk.text;await onProgress(text);}}if(signal.aborted)finishReason='cancelled';}catch(e){if(!text)throw e;finishReason=signal.aborted?'cancelled':'interrupted';}return {text,finishReason,usage:{},profile:p.name,model:p.model};}
async function generateModernDraft(){return runDraft(false);}
async function continueDraft(){return runDraft(true);}
async function runDraft(resume){
 if(modernBusy||inApiCall||currentDirty)return '';const c=getContext(),a=archiveFor(c,true);if(!a){setModernStatus('Open a chat first.');return '';}
 if(is_send_press||is_group_generating||(streamingProcessor&&!streamingProcessor.isFinished)){setModernStatus('Chat generation running.');return '';}
 if(!resume&&(a.draftId!==null||a.job)){setModernStatus('Apply/discard or resume the pending draft first.');return '';}
 const prior=revisionById(a,a.draftId);let base=resume?String($('#palimpest_draft_contents').val()||prior?.text||''):'';
 if(resume&&!a.job&&!prior)return '';
 if(resume&&!a.job&&!confirm('This older draft has no frozen source snapshot. Rebuild it from the current chat and Summary Prompt?'))return '';
 const run=++modernRun;modernBusy=true;inApiCall=true;controller=new AbortController();const signal=controller.signal;refreshModernUI();deactivateSendButtons();let job=a.job,partial='',lastSave=0,lastRender=0,lastCheckpoint='';
 const valid=()=>run===modernRun&&!isContextChanged(c);
 try{
  if(!job){const prompt=substituteParamsExtended(extension_settings.palimpest.prompt,{words:extension_settings.palimpest.promptWords});const snapshot=await buildSnapshot(c,prompt);if(!valid())return '';job={snapshot,signature:historySignature(c),baseId:a.activeId,createdAt:new Date().toISOString()};a.job=job;a.draftBase=job.baseId;a.draftSignature=job.signature;}
  if(resume&&prior&&base!==prior.text){const edited=addRevision(a,base,'Draft edit before continuation',c.chat.length,prior.id);a.draftId=edited.id;}
  if(!await persistArchive(c,'Source snapshot saved. Generating…')||!valid())return '';
  const messages=base?continuationMessages(job.snapshot,base):job.snapshot.messages;
  const counts=job.snapshot.counts;$('#palimpest_context_report').text(Object.entries(counts).map(([k,v])=>k+': '+Number(v).toLocaleString()+' chars').join(' · ')+' · RP preset: excluded');
  const checkpoint=async(text,force=false)=>{partial=text;if(!valid()||!text)return;const now=Date.now();if(!force&&now-lastRender<=400&&now-lastSave<=12000)return;const merged=appendSuffix(base,text);if(force||Date.now()-lastRender>400){$('#palimpest_draft_panel').show();$('#palimpest_draft_contents').val(merged);$('#palimpest_draft_stats').text(textStats(merged)+' · receiving…');lastRender=Date.now();}if((force||Date.now()-lastSave>12000)&&merged!==lastCheckpoint){job.partial=merged;lastCheckpoint=merged;lastSave=Date.now();await persistArchive(c,'Receiving · checkpoint saved.');}};
  const result=await requestSelected(messages,signal,checkpoint);partial=result.text;if(!valid())return '';
  if(!partial.trim()&&!base)throw new Error('No summary text returned.');
  const merged=appendSuffix(base,partial);const e=addRevision(a,merged,resume?'Continued draft':'Generated draft',job.snapshot.messageCount,a.draftId);e.finishReason=result.finishReason;e.connectionProfile=result.profile;e.model=result.model;e.usage={};for(const k of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isFinite(result.usage?.[k]))e.usage[k]=result.usage[k];a.draftId=e.id;delete job.partial;loadDraftUI();await persistArchive(c,'Draft saved · finish: '+e.finishReason+' · Continue if incomplete, or Apply.');return merged;
 }catch(e){if(valid()){if(partial){const merged=appendSuffix(base,partial);const r=addRevision(a,merged,'Interrupted draft',job?.snapshot?.messageCount||c.chat.length,a.draftId);r.finishReason=signal.aborted?'cancelled':'interrupted';a.draftId=r.id;if(job)delete job.partial;loadDraftUI();await persistArchive(c,'Interrupted draft saved. Continue from cutoff.');}else{setModernStatus('Generation failed. Previous memory and checkpoint kept. Check connection, quota or context limit. '+(signal.aborted?'Stopped.':''));}}return '';}
 finally{controller=null;inApiCall=false;modernBusy=false;activateSendButtons();if(!valid())onChatChanged();else refreshModernUI();}
}
async function applyModernDraft(){if(modernBusy||currentDirty)return;const c=getContext(),a=archiveFor(c),d=revisionById(a,a?.draftId);if(!d)return;const t=String($('#palimpest_draft_contents').val()||'');if(!t.trim())return;if((!['stop','end_turn'].includes(d.finishReason)||a.activeId!==a.draftBase||historySignature(c)!==a.draftSignature)&&!confirm('Draft may be incomplete or based on an older chat state. Apply anyway?'))return;a.draftId=a.draftBase=a.draftSignature=null;delete a.job;await commitRevision(t,'Applied draft',d.id);}
async function saveDraftEdit(){if(modernBusy||currentDirty)return;const c=getContext(),a=archiveFor(c),d=revisionById(a,a?.draftId),t=String($('#palimpest_draft_contents').val()||'');if(!d||!t.trim()||t===d.text)return;const r=addRevision(a,t,'Draft edit',c.chat.length,d.id);r.finishReason=d.finishReason;a.draftId=r.id;loadDraftUI();await persistArchive(c,'Draft edit saved.');}
async function discardModernDraft(){if(modernBusy||currentDirty)return;const c=getContext(),a=archiveFor(c);if(!a)return;const d=revisionById(a,a.draftId),t=String($('#palimpest_draft_contents').val()||'');if(d&&t.trim()&&t!==d.text)addRevision(a,t,'Discarded draft edit',c.chat.length,d.id);a.draftId=a.draftBase=a.draftSignature=null;delete a.job;loadDraftUI();await persistArchive(c,'Draft closed; history retained.');}
function recoverCheckpoint(c){const a=archiveFor(c);if(a?.job?.partial){const r=addRevision(a,a.job.partial,'Recovered stream checkpoint',a.job.snapshot.messageCount,a.draftId);r.finishReason='interrupted';a.draftId=r.id;delete a.job.partial;return true;}return false;}
async function commitRevision(text, reason, restoredFrom = null) {
    if (modernBusy) return;
    const context = getContext(); const archive = archiveFor(context, true);
    if (!archive) { setModernStatus('Open a chat first.'); return; }
    const entry = addRevision(archive, text, reason, context.chat.length, restoredFrom);
    const sourceRevision = revisionById(archive, restoredFrom);
    entry.connectionProfile = sourceRevision?.connectionProfile;
    if (sourceRevision?.model) entry.model = sourceRevision.model;
    if (sourceRevision?.finishReason) entry.finishReason = sourceRevision.finishReason;
    if (sourceRevision?.usage) entry.usage = {...sourceRevision.usage};
    archive.activeId = entry.id;
    currentDirty = false;
    // Also write the legacy slot so the stock extension can read the active memory.
    setMemoryContext(text, false);
    const message = context.chat[Math.max(0, context.chat.length - 2)];
    (message.extra ??= {}).memory = text;
    loadDraftUI();
    modernBusy = true; refreshModernUI();
    try { await persistArchive(context, `Version #${entry.id} active · chat save requested successfully.`); }
    finally { modernBusy = false; refreshModernUI(); renderHistoryPreview(); }
}
async function saveCurrentEdits() {
    if (!currentDirty || modernBusy) return;
    const text = String($('#palimpest_contents').val() ?? '');
    if (!text.trim() && !confirm('Clear the active memory? Previous versions remain in history.')) return;
    await commitRevision(text, 'Manual edit');
}
async function backupCurrent() {
    if (modernBusy || currentDirty) return;
    const context = getContext(); const archive = archiveFor(context, true);
    if (!archive || !activeText(context).trim()) { setModernStatus('No active memory to back up.'); return; }
    const entry = addRevision(archive, activeText(context), 'Manual backup', context.chat.length, archive.activeId);
    renderHistory();
    await persistArchive(context, `Backup #${entry.id} saved. Active version unchanged.`);
}
async function restoreSelected() {
    if (modernBusy || currentDirty) return;
    const entry = revisionById(archiveFor(), Number($('#palimpest_history_select').val()));
    if (!entry || !confirm(`Restore version #${entry.id}? The current version remains in history.`)) return;
    await commitRevision(entry.text, 'Restored', entry.id);
}
function downloadMemory(value, filename, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([value], { type: `${type};charset=utf-8` }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportModernMemory(selector, suffix) {
    const value = String($(selector).val() ?? '');
    if (!value.trim()) { toastr.info('Nothing to export.'); return; }
    downloadMemory(value, `Memory-Book-${suffix}-${new Date().toISOString().slice(0, 10)}.txt`);
}
function exportArchive() {
    const archive = archiveFor(getContext(), true);
    if (!archive?.revisions.length) { toastr.info('No versions to export.'); return; }
    downloadMemory(JSON.stringify({...archive, job:undefined}, null, 2), `Memory-Book-history-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
}

const formatMemoryValue = function (value) {
    if (!value) {
        return '';
    }

    value = value.trim();

    if (extension_settings.palimpest.template) {
        return substituteParamsExtended(extension_settings.palimpest.template, { summary: value });
    } else {
        return `Summary: ${value}`;
    }
};



function setupListeners(){
 const bind=(id,event,fn)=>$(id).off(event+'.palimpest').on(event+'.palimpest',fn);
 bind('#palimpest_connection_profile','change',function(){extension_settings.palimpest.connectionProfile=String($(this).val()||'');saveSettingsDebounced();closeMicroEditor();refreshMicroUI();});
 for(const [id,fn] of Object.entries({palimpest_micro_add:()=>openMicroEditor(),palimpest_micro_edit:()=>openMicroEditor(selectedMicro()),palimpest_micro_delete:deleteMicroPreset,palimpest_micro_test:testMicroPreset,palimpest_micro_save:saveMicroEditor,palimpest_micro_cancel:closeMicroEditor,palimpest_profile_refresh:refreshProfileSelector,palimpest_force_summarize:generateModernDraft,palimpest_continue:continueDraft,palimpest_stop:()=>controller?.abort(),palimpest_cancel_job:discardModernDraft,palimpest_draft_apply:applyModernDraft,palimpest_draft_save:saveDraftEdit,palimpest_draft_discard:discardModernDraft,palimpest_save_current:saveCurrentEdits,palimpest_backup_now:backupCurrent,palimpest_history_restore:restoreSelected,palimpest_history_export:()=>exportModernMemory('#palimpest_history_preview','version-'+$('#palimpest_history_select').val()),palimpest_history_export_all:exportArchive,palimpest_export:()=>exportModernMemory('#palimpest_contents','current'),palimpest_draft_export:()=>exportModernMemory('#palimpest_draft_contents','draft'),palimpest_restore:()=>{renderHistory();$('#palimpest_history_panel').toggle();},palimpestSettingsBlockToggle:()=>$('#palimpestSettingsBlock').slideToggle(150),palimpest_prompt_restore:()=>{if(confirm('Clear the saved Summary Prompt? This does not change existing Memory Books or draft snapshots.')){$('#palimpest_prompt').val(defaultPrompt).trigger('input');}}}))bind('#'+id,'click',fn);
 bind('#palimpest_history_select','change',renderHistoryPreview);bind('#palimpest_draft_contents','input',refreshModernUI);bind('#palimpest_contents','input',function(){currentDirty=String($(this).val()||'')!==activeText();refreshModernUI();});
 for(const [id,key,type] of [['palimpest_prompt','prompt','str'],['palimpest_template','template','str'],['palimpest_depth','depth','num'],['palimpest_role','role','num'],['palimpest_include_wi_scan','scan','bool'],['palimpest_native_max','nativeMax','num']])bind('#'+id,'input',function(){const v=type==='bool'?$(this).prop('checked'):type==='num'?Number($(this).val()):String($(this).val()||'');if(type==='num'&&!Number.isFinite(v))return;extension_settings.palimpest[key]=v;saveSettingsDebounced();if(['template','depth','role','scan'].includes(key))reinsertMemory();});
 bind('input[name="palimpest_position"]','change',function(){extension_settings.palimpest.position=Number($(this).val());saveSettingsDebounced();reinsertMemory();});
}
async function init(){const response=await fetch(new URL('./settings.html',import.meta.url));if(!response.ok)throw new Error('Cannot load Palimpest UI.');const html=await response.text();const target=$('#extensions_settings2').length?$('#extensions_settings2'):$('#extensions_settings');if(!target.length)throw new Error('Extensions settings container not found.');target.append(html);loadSettings();setupListeners();onChatChanged();await refreshProfileSelector();eventSource.on(event_types.CHAT_CHANGED,onChatChanged);if(!(extension_settings.disabledExtensions||[]).includes('memory'))setModernStatus('Disable built-in Summarize (memory) to avoid duplicate memory injection, then reload.');for(const name of ['palimpest','summary']){try{if(power_user.experimental_macro_engine){macros.register(name,{category:MacroCategory.CHAT,description:'Palimpest active Memory Book',handler:()=>activeText()});}else{MacrosParser.registerMacro(name,()=>activeText(),'Palimpest active Memory Book');}}catch{}} }
jQuery(()=>{void init().catch(e=>{console.error('Palimpest init failed',e);toastr.error('Palimpest could not initialize. Check console.');});});
