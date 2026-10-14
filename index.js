// Irodori TTS — SillyTavern 拡張
//
// 配置: data/default-user/extensions/SillyTavern-IrodoriTTS/
// 動作:
//  - 参照音声リスト: クリックで追加、❌で削除(セッション中のみ保持)
//  - コマンド: ["TTS:<音声名>", "<セリフ>"] を解釈 → 参照音声リストと照合 → TTS → 再生
//  - 送信ボタン横のアイコンボタン: 上記コマンドを実行
//     - 停止中: fa-comment クリックで TTS 実行
//     - AI応答待ち中: fa-circle-stop クリックでポップアップなし即キャンセル
//     - 再生中: fa-comment-dots クリックでキャンセル確認ポップアップ
//  - 音声テスト: 旧実装(参照音声/セリフ/送信して再生)をそのまま残す
//
// AIリクエストは ConnectionManagerRequestService.sendRequest で指定プロファイルへ
// 直接送信する(グローバルの接続切替は発生しない)。
//
// フロー: ST(ブラウザ) --fetch--> Irodori-TTS コンテナ


import { extension_settings, loadExtensionSettings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';
import { Popup, POPUP_RESULT } from '../../../popup.js';

const EXT = 'SillyTavern-IrodoriTTS';
const FOLDER = 'scripts/extensions/third-party/SillyTavern-IrodoriTTS';

// 再生中の Audio オブジェクト(再送で前のを止めるため保持)
let currentAudio = null;

// 送信ボタン横の TTS アイコンボタン
const SPEAK_BTN_ID = 'irodori_tts_speak_btn';
let isSpeaking = false;   // TTS 実行中か(全体。AI生成〜再生完了まで)
let isWaitingAi = false;  // AI 応答待ち中か(この間は circle-stop アイコンで即キャンセル可)
let isPaused = false;     // 再生一時停止中か(この間は circle-play アイコン)

// 再生中クリックのダブルクリック判定窓 (ms): この間隔内の連続クリックでキャンセル確認
const SPEAK_DBLCLICK_MS = 400;
let lastSpeakClickAt = 0; // 前回クリック時刻 (ダブルクリック判定用)

// 実行中 TTS の AI リクエスト中断用 AbortController
let currentAbortController = null;

// 参照音声リスト: name -> { type: 'file'|'folder', files: File[] }
// 単ファイル: { type:'file', files:[File] }
// フォルダ: { type:'folder', files:[File...] } (フォルダ内の .wav を名前順で保持)
// セッション中のみ。リロードで消える。
const refAudioMap = new Map();

// ── 設定 ────────────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
    enabled: true, // 送信ボタン横の TTS アイコンボタンを表示するか
    volume: 80,     // 音量 (0〜100)
    interval: 2,    // 再生間隔 (秒, 0〜10, 0.1秒刻み)
    endpoint: 'http://localhost:9040',
    text: 'こんにちは、はじめまして！',
    role: 'user',
    history: 10,  // 送信するチャット履歴件数 (0 = 全件)
    profile: '', // '' = 現在のプロファイルをそのまま使用
    prompts: null, // [{name, text}, ...]  後方互換: null なら下の sysprompt から初期1件生成
    selectedPrompt: 0, // 現在選択中のインデックス
    sysprompt: `You are a TTS director. From the last chat message, extract ONLY the character's spoken dialogue and convert it into TTS commands.

Output format (one or more commands):
["TTS", "voice_name", "dialogue text"]

Examples:
["TTS", "Alice.wav", "Hello!"],
["TTS", "Bob_happy.wav", "How are you?"],
["TTS", "Charlie", "I'm fine, thank you."]

Rules:
- Extract ALL dialogue lines, from the first to the last, without skipping any.
- Output the commands in the same order as the dialogue appears.
- Do not include narration, thoughts, or any text outside the commands.
- Keep each line of dialogue exactly as written; do not translate or paraphrase.
- Use ONLY the voice names listed under "Available voices". Never create, guess, or imagine a voice name.`,
});

function settings() {
    return extension_settings[EXT];
}

export async function loadSettings() {
    loadExtensionSettings(EXT);
    extension_settings[EXT] = extension_settings[EXT] || {};
    if (Object.keys(extension_settings[EXT]).length === 0) {
        Object.assign(extension_settings[EXT], DEFAULTS);
    }
    // 既存設定に欠けているキーを補完(バージョンアップ耐性)
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!(k in extension_settings[EXT])) extension_settings[EXT][k] = v;
    }

    // プロンプトリストの初期化(後方互換): prompts が無ければ sysprompt から1件生成
    const s = settings();
    if (!Array.isArray(s.prompts) || s.prompts.length === 0) {
        s.prompts = [{ name: 'Default', text: s.sysprompt || DEFAULTS.sysprompt }];
        s.selectedPrompt = 0;
    }
    if (typeof s.selectedPrompt !== 'number' || s.selectedPrompt < 0 || s.selectedPrompt >= s.prompts.length) {
        s.selectedPrompt = 0;
    }

    $('#irodori_tts_endpoint').val(s.endpoint);
    $('#irodori_tts_text').val(s.text);
    $('#irodori_tts_role').val(s.role || 'user');
    $('#irodori_tts_history').val(historyFromSettings());
    refreshProfileSelect(s.profile || '');

    // Enable チェックボックス + 送信ボタン横アイコンの表示制御
    $('#irodori_tts_enable').prop('checked', !!s.enabled);
    $('#irodori_tts_volume').val(getVolume());
    $('#irodori_tts_volume_val').text(`${getVolume()}%`);
    $('#irodori_tts_interval').val(getInterval());
    $('#irodori_tts_interval_val').text(`${getInterval().toFixed(1)}s`);
    refreshSpeakButton();

    // プロンプトセレクト構築 + 現在選択の本文を textarea へ
    refreshPromptSelect();
    $('#irodori_tts_sysprompt').val(getCurrentPromptText());
}

function persist() {
    const s = settings();
    s.endpoint = ($('#irodori_tts_endpoint').val() || '').trim();
    s.text = $('#irodori_tts_text').val() || '';
    // 現在選択中プロンプトの本文を更新(textarea 編集反映用)
    const cur = getCurrentPrompt();
    if (cur) cur.text = $('#irodori_tts_sysprompt').val() || '';
    s.role = $('#irodori_tts_role').val() || 'user';
    s.history = getHistoryLimit();
    s.profile = $('#irodori_tts_profile').val() || '';
    s.enabled = $('#irodori_tts_enable').is(':checked');
    // volume は有効な値のときだけ保存(DOM 未構築/空のときに 0 で上書きしないため)
    const $vol = $('#irodori_tts_volume');
    if ($vol.length > 0) {
        const v = Number($vol.val());
        if (Number.isFinite(v) && v >= 0 && v <= 100) s.volume = v;
    }
    // interval も同様 (0〜10秒, 0.1秒刻み)
    const $ivl = $('#irodori_tts_interval');
    if ($ivl.length > 0) {
        const iv = Number($ivl.val());
        if (Number.isFinite(iv) && iv >= 0 && iv <= 10) s.interval = Math.round(iv * 10) / 10;
    }
    refreshSpeakButton();
    saveSettingsDebounced();
}

// ── 送信ボタン横の TTS アイコンボタン ───────────────────────────────
// #send_but のすぐ左に挿入。Enable 時のみ表示。
// 停止中: fa-comment / AI応答待ち: fa-circle-stop / 再生中: fa-comment-dots
// 一時停止中: fa-circle-play
function speakBtnIcon() {
    if (isWaitingAi) return { cls: 'fa-solid fa-circle-stop', title: 'Cancel TTS' };
    if (isPaused) return { cls: 'fa-solid fa-circle-play', title: 'Resume' };
    if (isSpeaking) return { cls: 'fa-solid fa-comment-dots', title: 'Speaking…' };
    return { cls: 'fa-solid fa-comment', title: 'Run TTS' };
}

// 再生を一時停止 / 再開する。再生中のクリック 1回で呼ばれる。
function togglePausePlayback() {
    const a = currentAudio;
    if (!a) {
        // セリフの合間(間隔待機/生成待ち)では対象オーディオが無い。
        // フラグのみ切替えて、再生側ループのゲートで「次のセリフの開始」を止める。
        // (生成側には影響しない: 停止中も音声化は続き、キューへ蓄積される)
        isPaused = !isPaused;
        refreshSpeakButton();
        return;
    }
    if (a.paused) {
        // 再開
        isPaused = false;
        refreshSpeakButton();
        a.play().catch((e) => {
            // 再開失敗(稀)は止めておく
            console.warn(`[${EXT}] Resume failed:`, e);
            isPaused = false;
            refreshSpeakButton();
        });
    } else {
        // 一時停止
        a.pause();
        isPaused = true;
        refreshSpeakButton();
    }
}

// 一時停止フラグを解除 + アイコンを更新
function resetPauseState() {
    if (!isPaused) return;
    isPaused = false;
    refreshSpeakButton();
}

// 再生中クリック:
// - 再生中 (isPaused=false): 1回目は即一時停止、400ms以内の2回目でキャンセル確認
// - 一時停止中 (isPaused=true): 1回目は即再開、400ms以内の2回目でキャンセル確認
let speakClickTimer = null;
function onSpeakingClick() {
    const now = Date.now();
    const isDouble = (now - lastSpeakClickAt) <= SPEAK_DBLCLICK_MS;
    lastSpeakClickAt = now;

    if (isDouble) {
        // 2回目(速いクリック): 保留中のタイマーをクリアしてキャンセル確認
        if (speakClickTimer) { clearTimeout(speakClickTimer); speakClickTimer = null; }
        lastSpeakClickAt = 0;
        void (async () => {
            const ok = await Popup.show.confirm(
                'Cancel TTS?',
                '',
                { okButton: 'YES', cancelButton: 'NO' },
            );
            if (ok === POPUP_RESULT.AFFIRMATIVE) {
                cancelCurrentTts();
            }
        })();
        return;
    }

    // 1回目: 即トグル。タイマーはダブルクリック判定のためだけに仕掛ける
    togglePausePlayback();
    if (speakClickTimer) clearTimeout(speakClickTimer);
    speakClickTimer = setTimeout(() => {
        speakClickTimer = null;
        lastSpeakClickAt = 0;
        // 既にトグル済みなので何もしない
    }, SPEAK_DBLCLICK_MS);
}

function buildSpeakButton() {
    // 既存があれば削除
    $(`#${SPEAK_BTN_ID}`).remove();
    const { cls, title } = speakBtnIcon();
    const $btn = $(`<div id="${SPEAK_BTN_ID}" class="${cls} interactable" title="${title}" tabindex="0"></div>`);
    $btn.on('click', () => {
        // AI応答待ち中: ポップアップなしで即キャンセル
        if (isWaitingAi) {
            cancelCurrentTts();
            return;
        }
        if (!isSpeaking) {
            // 停止中: TTS 実行
            void ttsLastMessage();
            return;
        }
        // 再生中(一時停止中含む): 単発=一時停止/再開、速い2回押し=キャンセル確認
        onSpeakingClick();
    });
    return $btn;
}

// Enable / 喋り状態 に応じてアイコンボタンを表示・非表示・状態更新
function refreshSpeakButton() {
    const enabled = !!settings().enabled;
    const $btn = $(`#${SPEAK_BTN_ID}`);
    if (!enabled) {
        $btn.remove();
        return;
    }
    if ($btn.length === 0) {
        // #send_but のすぐ左に挿入
        const $send = $('#send_but');
        if ($send.length === 0) return; // DOM 未構築なら待つ(起動順で後から構築される)
        const $newBtn = buildSpeakButton();
        $newBtn.insertBefore($send);
    } else {
        // 既存ボタンの状態を更新(アイコン・タイトル・クラス)
        const { cls, title } = speakBtnIcon();
        $btn.attr('class', `${cls} interactable`).attr('title', title);
    }
}

// 実行状態フラグをセット + アイコン状態を更新
function setSpeaking(v) {
    isSpeaking = !!v;
    if (!v) {
        isWaitingAi = false;
        resetPauseState();
    }
    if (settings().enabled) refreshSpeakButton();
}

// AI 応答待ち状態をセット + アイコン状態を更新
function setWaitingAi(v) {
    isWaitingAi = !!v;
    if (v) isSpeaking = true;
    if (settings().enabled) refreshSpeakButton();
}

// 音量設定 (0〜100) → 0〜100 にクランプして返す (audio.volume は 0〜1 なので使う側で /100)
// 未設定/不正値ならデフォルト (80) を返す
function getVolume() {
    const raw = settings().volume;
    let v = (raw == null) ? NaN : Number(raw);
    if (!Number.isFinite(v)) v = DEFAULTS.volume;
    v = Math.min(100, Math.max(0, v));
    return v;
}

// 保存値から履歴件数を得る (0 = 全件)。未設定/不正値はデフォルト (0) を返す
function historyFromSettings() {
    const raw = settings().history;
    const v = (raw == null) ? NaN : Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULTS.history;
}

// 送信するチャット履歴件数を返す (0 = 全件)。DOM の入力値を優先し、未構築/不正なら保存値
function getHistoryLimit() {
    const $h = $('#irodori_tts_history');
    if ($h.length > 0) {
        const v = Number($h.val());
        if (Number.isFinite(v) && v >= 0) return Math.floor(v);
    }
    return historyFromSettings();
}

// 再生間隔 (秒) → 0〜10 にクランプして返す。未設定/不正値ならデフォルト (2) を返す
function getInterval() {
    const raw = settings().interval;
    let v = (raw == null) ? NaN : Number(raw);
    if (!Number.isFinite(v)) v = DEFAULTS.interval;
    v = Math.min(10, Math.max(0, v));
    return v;
}

// ── ヘルパ ──────────────────────────────────────────────────────────────────
function endpointUrl() {
    let base = (settings().endpoint || '').trim();
    if (!base) {
        throw new Error('Server URL is not set');
    }
    base = base.replace(/\/+$/, '');
    return base;
}

// ── プロンプトリスト管理 ───────────────────────────────────────────────
// extension_settings[EXT].prompts: [{name, text}, ...]
// extension_settings[EXT].selectedPrompt: number (index)
function getCurrentPrompt() {
    const s = settings();
    const idx = s.selectedPrompt | 0;
    return (Array.isArray(s.prompts) && idx >= 0 && idx < s.prompts.length) ? s.prompts[idx] : null;
}

function getCurrentPromptText() {
    return getCurrentPrompt()?.text || '';
}

// プロンプトセレクトの選択肢を再構築(現在選択を維持)
function refreshPromptSelect() {
    const s = settings();
    const $sel = $('#irodori_tts_prompt_select');
    $sel.empty();
    if (!Array.isArray(s.prompts) || s.prompts.length === 0) {
        $sel.append('<option value="">(none)</option>');
        return;
    }
    for (let i = 0; i < s.prompts.length; i++) {
        $sel.append($('<option />').val(String(i)).text(s.prompts[i].name));
    }
    const idx = (typeof s.selectedPrompt === 'number' && s.selectedPrompt >= 0 && s.selectedPrompt < s.prompts.length) ? s.selectedPrompt : 0;
    s.selectedPrompt = idx;
    $sel.val(String(idx));
}

// + ボタン: 名前入力 → 新規プロンプト追加・選択
async function addPrompt() {
    const s = settings();
    const name = await Popup.show.input(
        'New Prompt',
        'Enter a prompt name',
        '',
        { okButton: 'OK', cancelButton: 'Cancel', large: false },
    );
    if (name == null) return; // キャンセル
    const trimmed = name.trim();
    if (!trimmed) {
        toastr.warning('Prompt name is empty', EXT);
        return;
    }
    // 同名チェック(警告するが許可はする)
    const dup = (s.prompts || []).some(p => p.name === trimmed);
    if (dup) toastr.info(`A prompt with the same name already exists: ${trimmed}`, EXT, { timeOut: 3000 });
    if (!Array.isArray(s.prompts)) s.prompts = [];
    s.prompts.push({ name: trimmed, text: DEFAULTS.sysprompt });
    s.selectedPrompt = s.prompts.length - 1;
    refreshPromptSelect();
    $('#irodori_tts_sysprompt').val(DEFAULTS.sysprompt);
    saveSettingsDebounced();
    toastr.success(`Prompt "${trimmed}" added`, EXT, { timeOut: 2000 });
}

// ❌ ボタン: 現在のプロンプトを確認の上削除(最低1件は保持)
async function deletePrompt() {
    const s = settings();
    const cur = getCurrentPrompt();
    if (!cur) {
        toastr.warning('No prompt to delete', EXT);
        return;
    }
    if ((s.prompts || []).length <= 1) {
        toastr.warning('At least one prompt is required (cannot delete)', EXT, { timeOut: 4000 });
        return;
    }
    const ok = await Popup.show.confirm(
        'Delete Prompt',
        `Delete "${cur.name}"?`,
        { okButton: 'OK', cancelButton: 'Cancel' },
    );
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return; // キャンセル

    const idx = s.selectedPrompt | 0;
    s.prompts.splice(idx, 1);
    // 選択インデックス調整
    s.selectedPrompt = Math.min(idx, s.prompts.length - 1);
    refreshPromptSelect();
    $('#irodori_tts_sysprompt').val(getCurrentPromptText());
    saveSettingsDebounced();
    toastr.success(`Prompt "${cur.name}" deleted`, EXT, { timeOut: 2000 });
}

// ✏ リネームボタン: 現在のプロンプト名を変更
async function renamePrompt() {
    const s = settings();
    const cur = getCurrentPrompt();
    if (!cur) {
        toastr.warning('No prompt to rename', EXT);
        return;
    }
    const name = await Popup.show.input(
        'Rename Prompt',
        'Enter a new name',
        cur.name || '',
        { okButton: 'OK', cancelButton: 'Cancel', large: false },
    );
    if (name == null) return; // キャンセル
    const trimmed = name.trim();
    if (!trimmed) {
        toastr.warning('Prompt name is empty', EXT);
        return;
    }
    if (trimmed !== cur.name) {
        const dup = (s.prompts || []).some(p => p.name === trimmed && p !== cur);
        if (dup) toastr.info(`A prompt with the same name already exists: ${trimmed}`, EXT, { timeOut: 3000 });
        cur.name = trimmed;
        refreshPromptSelect();
        saveSettingsDebounced();
        toastr.success(`Prompt renamed to "${trimmed}"`, EXT, { timeOut: 2000 });
    }
}

// ── コネクションプロファイル (Connection Manager) ──────────────────────
// extension_settings.connectionManager.profiles: [{id, name, ...}]
// 現在選択中: extension_settings.connectionManager.selectedProfile (id)
function getConnectionProfiles() {
    try {
        const st = getContext();
        return st?.extensionSettings?.connectionManager?.profiles || [];
    } catch { return []; }
}

function getCurrentProfileId() {
    try {
        const st = getContext();
        return st?.extensionSettings?.connectionManager?.selectedProfile || '';
    } catch { return ''; }
}

// Connection Manager が有効か(無効なら sendRequest 不可)
function isConnectionManagerActive() {
    try {
        const st = getContext();
        return !!st?.ConnectionManagerRequestService?.sendRequest
            && !st?.extensionSettings?.disabledExtensions?.includes('connection-manager')
            && !!st?.extensionSettings?.connectionManager;
    } catch { return false; }
}

function refreshProfileSelect(selected) {
    const $sel = $('#irodori_tts_profile');
    const cur = $sel.val();
    $sel.empty();
    $sel.append('<option value="">(Current Profile)</option>');
    for (const p of getConnectionProfiles()) {
        $sel.append($('<option />').val(p.name).text(p.name));
    }
    const target = selected || cur || '';
    if (target && getConnectionProfiles().some(p => p.name === target)) {
        $sel.val(target);
    } else {
        $sel.val('');
    }
}

// 設定のプロファイル名 → プロファイルID を解決。
// '' (未選択) なら Connection Manager の現在選択プロファイルIDを返す。
// 見つからなければ null を返す。
function resolveProfileId(profileName) {
    const profiles = getConnectionProfiles();
    if (profileName) {
        const p = profiles.find(x => x.name === profileName);
        return p ? p.id : null;
    }
    return getCurrentProfileId() || null;
}

// ConnectionManagerRequestService.sendRequest で指定プロファイルへ直接リクエストする。
// (グローバルの接続切替は発生しない)
// messages: [{role, content}, ...] / signal: AbortSignal
// 戻り値: 応答テキスト (エラー時は throw)
async function generateViaProfile(profileId, messages, signal) {
    const st = getContext();
    const svc = st?.ConnectionManagerRequestService;
    if (!svc?.sendRequest) {
        throw new Error('ConnectionManagerRequestService is unavailable');
    }
    const result = await svc.sendRequest(
        profileId,
        messages,
        undefined, // maxTokens: プリセット既定値を使用
        { stream: false, extractData: true, includePreset: true, signal },
    );
    // 非ストリーム + extractData:true なら ExtractedData { content, reasoning } が返る
    return result?.content || '';
}

function stopCurrentAudio() {
    if (!currentAudio) return;
    const a = currentAudio;
    currentAudio = null; // 先に参照を切る(後続リスナが無視するように)
    try { a.pause(); } catch (_) { /* noop */ }
    a.onended = null;
    a.onerror = null;
    const url = a.src;
    if (url && url.startsWith('blob:')) {
        try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
    }
    a.src = '';
}

// TTS 中断フラグ。ttsLastMessage は各フェーズでこれを確認し、中断する。
// 中断時は現在再生中の音声も即座に停止し、次以降をスキップする。
let ttsAbort = { aborted: false };

// 実行中 TTS の世代ID。旧実行が終わった際に新しい実行の状態を壊さないようにする。
let ttsRunId = 0;

// 生成済み音声キュー (生成→再生のパイプライン用)。再生は先頭から順に消費する。
let playQueue = [];
let queueProducerDone = false; // 生成側が全コマンドを処理済み
let queueWakeup = null;        // 再生側を起こす resolver

// TTS 中断要求: 再生中の音声を即座に停止し、次以降をスキップ、アイコンを停止中に戻す。
// AI リクエスト待ち中なら HTTP リクエスト自体も中断する。
function cancelCurrentTts() {
    ttsAbort.aborted = true;
    resetPauseState();
    if (currentAbortController) {
        try { currentAbortController.abort(); } catch (_) { /* noop */ }
        currentAbortController = null;
    }
    stopCurrentAudio();
    setSpeaking(false);
}

// ── 参照音声リストUI ─────────────────────────────────────────────────────────────
function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRefItems() {
    const $box = $('#irodori_tts_ref_items');
    $box.empty();
    if (refAudioMap.size === 0) {
        $box.append('<div class="irodori_tts_ref_empty irodori_tts_hint">Added: none</div>');
        refreshTestRefSelect();
        return;
    }
    $box.append(`<div class="irodori_tts_hint">Added: ${refAudioMap.size}</div>`);
    const $ul = $('<ul class="irodori_tts_ref_list"></ul>');
    for (const [name, entry] of refAudioMap) {
        const isFolder = entry.type === 'folder';
        const icon = isFolder ? 'fa-folder' : 'fa-file-audio';
        const sub = isFolder ? ` (${entry.files.length} audio)` : '';
        const $li = $(`<li data-name="${escapeAttr(name)}">
            <i class="fa-solid ${icon}"></i>
            <span class="irodori_tts_ref_name"></span>
            <span class="irodori_tts_ref_del" title="Remove"><i class="fa-solid fa-xmark"></i></span>
        </li>`);
        $li.find('.irodori_tts_ref_name').text(name + sub);
        $li.find('.irodori_tts_ref_del').on('click', () => {
            refAudioMap.delete(name);
            renderRefItems();
        });
        $ul.append($li);
    }
    $box.append($ul);
    refreshTestRefSelect();
}

// 音声テストの参照音声セレクトを音声リストと同期
function refreshTestRefSelect() {
    const $sel = $('#irodori_tts_test_ref_select');
    if ($sel.length === 0) return;
    const prev = $sel.val() || '';
    $sel.empty().append($('<option value="">No Reference</option>'));
    for (const name of refAudioMap.keys()) {
        $sel.append($('<option></option>').val(name).text(name));
    }
    // 以前の選択がまだ存在すれば復元
    if (prev && refAudioMap.has(prev)) $sel.val(prev);
}

// フォルダ内音声を名前順でソート(0_alice_normal.wav < 1_alice_happy.wav になる)
function sortAudioFiles(files) {
    return files.slice().sort((a, b) => {
        const an = a.name || '';
        const bn = b.name || '';
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
    });
}

// 音声ファイルか(.wav/.mp3/.flac/.ogg/.m4a 等)
function isAudioFile(f) {
    if (!f) return false;
    if (f.type && f.type.startsWith('audio/')) return true;
    return /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i.test(f.name || '');
}

// fileList から単ファイルとフォルダを仕分けして refAudioMap に追加
// フォルダ選択(webkitdirectory)の場合、file.webkitRelativePath が "folder/sub.wav" 形式。
function addRefFiles(fileList) {
    const arr = Array.from(fileList || []);
    if (arr.length === 0) return;

    let added = 0;
    let dup = 0;

    // フォルダ選択か判定: webkitRelativePath が "dir/..." 形式のものがあればフォルダ
    const hasFolder = arr.some(f => (f.webkitRelativePath || '').includes('/'))
                     && arr.some(f => isAudioFile(f));

    if (hasFolder) {
        // フォルダ名を抽出(webkitRelativePath の先頭要素)
        const firstWithRel = arr.find(f => (f.webkitRelativePath || '').includes('/'));
        const folderName = (firstWithRel.webkitRelativePath || '').split('/')[0] || firstWithRel.name;
        // フォルダ内の音声のみ抽出してソート
        const audios = sortAudioFiles(arr.filter(f => isAudioFile(f)));
        if (audios.length === 0) {
            toastr.warning(`No audio files in folder "${folderName}"`, EXT, { timeOut: 4000 });
            return;
        }
        if (refAudioMap.has(folderName)) {
            toastr.info(`Folder "${folderName}" is already added`, EXT, { timeOut: 3000 });
            return;
        }
        refAudioMap.set(folderName, { type: 'folder', files: audios });
        added = 1;
    } else {
        // 単ファイル選択
        for (const f of arr) {
            if (!isAudioFile(f)) continue;
            if (refAudioMap.has(f.name)) {
                dup++;
                continue;
            }
            refAudioMap.set(f.name, { type: 'file', files: [f] });
            added++;
        }
    }

    renderRefItems();
    if (added) toastr.success(`${added} added`, EXT, { timeOut: 1500 });
    if (dup) toastr.info(`${dup} skipped (duplicate names)`, EXT, { timeOut: 2000 });
}

// ── コマンド解析 ─────────────────────────────────────────────────────────────
// 形式: ["TTS", "<音声名>", "<セリフ>"] が1つ以上。複数はカンマ区切りで並べる。
// 寬容に: 文中から [ ... ] ブロックを正規表現で全抽出 → 各々を JSON.parse →
// ["TTS", voice, text] として扱う。破損ブロックはスキップ。
// 戻り値: [{ voice: string, text: string, caption: string }, ...]
function extractBlocks(str) {
    const out = [];
    // 入れ子対応のため [ から始まり、対応する ] までを貪欲に取る簡易スキャン
    let i = 0;
    while (i < str.length) {
        const open = str.indexOf('[', i);
        if (open < 0) break;
        // 対応する ] を深さで探す
        let depth = 0;
        let close = -1;
        for (let j = open; j < str.length; j++) {
            const ch = str[j];
            if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) { close = j; break; }
            }
        }
        if (close < 0) break;
        const chunk = str.slice(open, close + 1);
        out.push(chunk);
        i = close + 1;
    }
    return out;
}

function parseOneBlock(chunk) {
    let parsed;
    try {
        parsed = JSON.parse(chunk);
    } catch {
        return null; // 破損ブロックはスキップ
    }
    if (!Array.isArray(parsed) || parsed.length < 2) return null;

    // 配列の配列 (例: [["TTS", "v.wav", "text"], ...]) → 内側の各要素を処理
    const items = Array.isArray(parsed[0]) ? parsed : [parsed];
    const results = [];
    for (const item of items) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const head = String(item[0] ?? '');
        if (head.toUpperCase() !== 'TTS') continue;
        if (item.length < 3) continue;
        const voice = String(item[1] ?? '').trim();
        const text = String(item[2] ?? '').trim();
        if (!text) continue;
        const caption = (item.length >= 4 && item[3] != null) ? String(item[3]).trim() : '';
        results.push({ voice, text, caption });
    }
    return results.length > 0 ? results : null;
}

function parseCommands(raw) {
    const str = (raw || '').trim();
    if (!str) throw new Error('Command is empty');
    const blocks = extractBlocks(str);
    if (blocks.length === 0) throw new Error('No [ ... ] block found in command');
    const cmds = [];
    for (const b of blocks) {
        const c = parseOneBlock(b);
        if (Array.isArray(c)) cmds.push(...c);
    }
    if (cmds.length === 0) throw new Error('No valid ["TTS", voice, text] blocks');
    return cmds;
}

// ── 共通: TTS 音声生成 (送信のみ。再生はしない) ─────────────────────────────
// refFiles: File[] (空配列なら参照なし)
// 成功: 音声 Blob。失敗: null (トースト済み)。
async function ttsSynthesize(text, caption, refFiles) {
    let url;
    try {
        url = endpointUrl() + '/tts';
    } catch (e) {
        toastr.warning(String(e.message || e), EXT);
        return null;
    }

    // 中断済みなら何もしない(エラートーストなし)
    if (ttsAbort.aborted) return null;

    const form = new FormData();
    form.append('text', text);
    if (caption) form.append('caption', caption);
    form.append('ref_count', String(refFiles.length));
    refFiles.forEach((f, i) => form.append(`ref_${i}`, f));

    // 送信内容をコンソールに表示
    console.log(`[${EXT}] TTS 送信: text=${JSON.stringify(text)} caption=${JSON.stringify(caption || '')} refs=${refFiles.length}${refFiles.length ? ' [' + refFiles.map(f => f.name).join(', ') + ']' : ''}`);

    try {
        const res = await fetch(url, { method: 'POST', body: form });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            toastr.error(`HTTP ${res.status}: ${detail.slice(0, 200)}`, EXT, { timeOut: 10000 });
            return null;
        }

        const ct = res.headers.get('content-type') || '';
        if (!ct.startsWith('audio/')) {
            const body = await res.text().catch(() => '');
            toastr.error(`Non-audio response (${ct}): ${body.slice(0, 200)}`, EXT, { timeOut: 10000 });
            return null;
        }

        const blob = await res.blob();

        // 取得中にキャンセルされたら破棄(トーストなし)
        if (ttsAbort.aborted) return null;

        return blob;
    } catch (e) {
        toastr.error(`Send failed: ${e?.message || e}`, EXT, { timeOut: 10000 });
        return null;
    }
}

// ── 共通: 生成済み音声を再生 (終了まで待つ) ─────────────────────────────────
// 戻り値: Promise<true|false> 再生完了で true。エラー/切替で false。
async function playBlob(blob) {
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.volume = getVolume() / 100; // 設定の音量 (0〜100) を 0〜1 に変換
    stopCurrentAudio(); // 念のため(通常は前の音声が終わっている)
    currentAudio = audio;

    // 再生終了で resolve する Promise
    const finished = new Promise((resolve) => {
        audio.onended = () => {
            if (audio !== currentAudio) { resolve(false); return; } // 別音声に切替
            resetPauseState();
            stopCurrentAudio();
            resolve(true);
        };
        audio.onerror = () => {
            if (audio !== currentAudio) { resolve(false); return; }
            resetPauseState();
            stopCurrentAudio();
            resolve(false);
        };
        // 外部停止(切替)時: stopCurrentAudio は onended/onerror を null にするため、
        // この onpause 経由で Promise を解決しないと待ちが永久に続く。
        // 一時停止(ユーザー操作)の場合は現行実行のまま待ち続けたいので、
        // currentAudio が同一のまま停まっているときは解決しない。
        audio.onpause = () => {
            if (audio !== currentAudio) resolve(false);
        };
    });

    try {
        await audio.play();
    } catch (playErr) {
        if (audio === currentAudio) {
            toastr.error(`Playback start failed: ${playErr?.message || playErr}`, EXT);
            stopCurrentAudio();
        }
        return false;
    }

    // 再生が終わるのを待つ
    const ok = await finished;
    return ok;
}

// ── テスト用: 生成してすぐ再生 (音声テスト用の薄いラッパ) ──────────────────
async function ttsAndPlay(text, caption, refFiles) {
    const blob = await ttsSynthesize(text, caption, refFiles);
    if (!blob) return false;
    // 生成中にキャンセルされたら再生しない(トーストなし)
    if (ttsAbort.aborted) return false;
    return await playBlob(blob);
}

// ── 接続確認 ─────────────────────────────────────────────────────────────────
async function checkHealth() {
    let url;
    try {
        url = endpointUrl() + '/health';
    } catch (e) {
        toastr.warning(String(e.message || e), EXT);
        return;
    }
    try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) {
            toastr.error(`HTTP ${res.status}`, EXT);
            return;
        }
        const data = await res.json().catch(() => ({}));
        toastr.success(
            `Connection OK — device=${data.device || '?'} / speaker=${data.speaker_condition} / caption=${data.caption_condition}`,
            EXT,
        );
    } catch (e) {
        toastr.error(`Connection failed: ${e?.message || e}`, EXT);
    }
}

// ── 音声テスト: 送信して再生 ───────────────────────────────────────────
async function sendAndPlay() {
    // 中断状態をリセットする。
    // キャンセル後に ttsAbort.aborted が true のまま残っていると、以後の音声テストが
    // ttsSynthesize() の中断チェックで黙って失敗し、テストボイスが一切再生されなくなる。
    // runId を進めて新しい中断世代を作ることで、残留した旧 TTS パイプライン
    // (生成/再生ループ)も runId 不一致で確実に停止させる。
    // 実行中の TTS があった場合は currentAudio の停止とアイコン復元もここで行う。
    ttsAbort = { aborted: false, runId: ++ttsRunId };
    stopCurrentAudio();
    setSpeaking(false);

    persist();
    const s = settings();
    const text = (s.text || '').trim();
    if (!text) {
        toastr.warning('Please enter dialogue text', EXT);
        return;
    }
    // 音声テストは音声リストからの選択(単一)を使う
    const voiceName = $('#irodori_tts_test_ref_select').val() || '';
    const files = voiceName ? (resolveRefFiles(voiceName) || []) : [];
    await ttsAndPlay(text, '', files);
}

// ── 参照音声リストから File を解決 ─────────────────────────────────────────
function resolveRefFiles(voiceName) {
    if (!voiceName) return null;
    const entry = refAudioMap.get(voiceName);
    if (!entry) return null;
    // フォルダの場合は既にソート済みで保持しているのでそのまま返す
    return entry.files;
}

// ── コマンドを生成しながら順次再生 (生成と再生のパイプライン) ───────────────
// cmds: [{voice, text, caption}, ...]
// 生成は常に先回りで進める(再生中も次の生成を行う)。完成した音声はキューに積み、
// 再生はキューの先頭から順番に消費する。
// 生成エラーで生成を打ち切り、再生エラーで以降を中断する。
async function playCommandsSequentially(cmds, runId) {
    playQueue = [];
    queueProducerDone = false;
    queueWakeup = null;
    const stopGen = { stop: false }; // 生成打ち切りフラグ(再生エラー時など)
    let genErrorIdx = null;          // 生成に失敗したコマンド番号

    // 生成側(producer): 次々に音声を作り、完成したらキューへ積む
    // finally で必ず queueProducerDone を立てて consumer を起こす(生成エラー/打ち切りでも再生側が永久待機しないように)
    const producer = (async () => {
        try {
            for (let idx = 0; idx < cmds.length; idx++) {
                if (ttsAbort.aborted || ttsAbort.runId !== runId || stopGen.stop) return;
                const c = cmds[idx];
                // 参照音声が指定されているがリストに無い → このセリフはスキップ
                if (c.voice && !refAudioMap.has(c.voice)) {
                    toastr.warning(`Reference audio "${c.voice}" not found.`, EXT, { timeOut: 5000 });
                    continue;
                }
                const refFiles = resolveRefFiles(c.voice) || [];
                const blob = await ttsSynthesize(c.text, c.caption, refFiles);
                // 取得中に中断/新実行/打ち切りが来たら破棄して生成を止める
                if (ttsAbort.aborted || ttsAbort.runId !== runId || stopGen.stop) return;
                if (!blob) { genErrorIdx = idx; return; } // 生成エラー: これ以上作らない
                playQueue.push({ idx, blob });
                wakePlayConsumer();
            }
        } finally {
            queueProducerDone = true;
            wakePlayConsumer();
        }
    })();

    // 再生側(consumer): キューを先頭から順番に再生していく
    let ok = true;
    let waitProducer = true;
    let playedCount = 0; // 再生間隔は「最初の音声の前」には適用しないためのカウンタ
    while (true) {
        // 一時停止ゲート: 一時停止中は次のセリフを開始させない。
        // (生成側は止めないため、停止中も音声化は続きキューへ蓄積される)
        while (isPaused && !ttsAbort.aborted && ttsAbort.runId === runId) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (ttsAbort.aborted || ttsAbort.runId !== runId) {
            // 中断: 以降の生成は producer が自律的に破棄する
            stopGen.stop = true;
            ok = false;
            waitProducer = false;
            break;
        }
        if (playQueue.length > 0) {
            const item = playQueue.shift();

            // 再生間隔: 最初の音声の前では待たず、音声と音声の「間」でのみ待つ
            if (playedCount > 0 && getInterval() > 0) {
                const ms = getInterval() * 1000;
                const until = Date.now() + ms;
                // 一時停止中は残り時間のカウントダウンを凍結する(待ちが停止時間分延びないように)
                while (Date.now() < until || isPaused) {
                    // 待っている間に中断/新実行が来たら待ちを打ち切り
                    if (ttsAbort.aborted || ttsAbort.runId !== runId) break;
                    await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
                }
                // 待ち/wait 中に中断されたら以降をスキップ
                if (ttsAbort.aborted || ttsAbort.runId !== runId) {
                    stopGen.stop = true;
                    ok = false;
                    waitProducer = false;
                    break;
                }
            }

            const played = await playBlob(item.blob);
            if (played) playedCount++;
            if (!played) {
                stopGen.stop = true;
                ok = false;
                if (ttsAbort.aborted || ttsAbort.runId !== runId) {
                    waitProducer = false;
                    break;
                }
                // 再生エラー: 以降を中断 (生成中リクエストは完了次第破棄される)
                toastr.warning(`Playback failed at [${item.idx + 1}]. Stopping.`, EXT);
                waitProducer = false;
                break;
            }
            continue;
        }
        if (queueProducerDone) break;
        // キュー空 & 生成中: 完成したら起こしてもらう
        await new Promise((res) => { queueWakeup = res; });
    }

    if (waitProducer) await producer;
    if (ok && genErrorIdx !== null && !ttsAbort.aborted && ttsAbort.runId === runId) {
        toastr.warning(`Audio generation failed at [${genErrorIdx + 1}]. Stopping.`, EXT);
    }
    playQueue = [];
    queueWakeup = null;
    return ok;
}

// 再生側を起こす(キューに新しい音声が届いた/生成が全完了した)
function wakePlayConsumer() {
    if (queueWakeup) {
        const w = queueWakeup;
        queueWakeup = null;
        w();
    }
}

// ── TTS実行 (AI生成 → 順次再生) ──────────────────────────────────────

async function ttsLastMessage() {
    persist();
    const s = settings();

    // 事前チェック: ここは喋り中にせずトーストだけ出す
    const voiceNames = Array.from(refAudioMap.keys());
    if (voiceNames.length === 0) {
        toastr.warning('Reference audio list is empty. Please add audio.', EXT, { timeOut: 5000 });
        return;
    }

    const sysPromptBase = (getCurrentPromptText() || '').trim();
    if (!sysPromptBase) {
        toastr.warning('TTS Prompt is empty.', EXT);
        return;
    }

    // プロファイル解決(未選択なら現在のプロファイル)。
    // 指定名が見つからない場合も現在のプロファイルで続行(旧実装と同じ挙動)。
    if (!isConnectionManagerActive()) {
        toastr.warning('Connection Manager is unavailable. TTS generation requires it.', EXT, { timeOut: 6000 });
        return;
    }
    const profileId = resolveProfileId(s.profile || '');
    if (s.profile && profileId === null) {
        toastr.warning(`Connection Profile "${s.profile}" not found. Continuing with the current profile.`, EXT);
    }
    const effectiveProfileId = profileId || getCurrentProfileId();
    if (!effectiveProfileId) {
        toastr.error('No connection profile selected. Select one in Connection Manager.', EXT);
        return;
    }

    // ── AIへ送るメッセージを構築: キャラカード → チャット履歴 → TTS指示 ──
    const st = getContext();

    // (1) キャラカード (description のみ。空ならセクション自体を省略)
    const ctxMessages = [];
    const char = st?.characters?.[st?.characterId];
    const description = (char?.description || '').trim();
    if (description) {
        ctxMessages.push({ role: 'system', content: `<characters>\n<description>${description}</description>\n</characters>` });
    }

    // (2) チャット履歴 (設定件数、0=全件)。role は発言者種別に応じて正規化
    const chat = st?.chat || [];
    const limit = getHistoryLimit();
    const start = limit > 0 ? Math.max(0, chat.length - limit) : 0;
    let historyCount = 0;
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        const content = (m?.mes || '').trim();
        if (!content) continue;
        const isUser = m?.is_user === true || m?.is_user === 'true';
        const isSystem = m?.is_system === true || m?.is_system === 'true';
        ctxMessages.push({
            role: isUser ? 'user' : isSystem ? 'system' : 'assistant',
            content,
        });
        historyCount++;
    }
    if (historyCount === 0) {
        toastr.warning('No chat message to speak.', EXT);
        return;
    }

    // 末尾に利用可能音声一覧を付与 (カンマ区切り)
    const voiceListStr = voiceNames.join(', ');
    const fullSysPrompt = `${sysPromptBase}\n\nAvailable voices (you must choose ONLY from these): ${voiceListStr}`;

    // AI に送るメッセージ構成をブラウザコンソールに出力
    console.log(`[${EXT}] ===== AI へ送信するリクエスト (カード: ${ctxMessages[0]?.role === 'system' ? '有' : '無'} / 履歴: ${historyCount}件${limit > 0 ? '' : ' (全件)'} / Role: ${s.role || 'user'}) =====`);
    console.log(fullSysPrompt);
    console.log(ctxMessages);
    console.log(`[${EXT}] ============================================================`);

    // ここからが「喋り中」: AI生成〜再生まで。finally で必ず停止中に戻す。
    const runId = ++ttsRunId;
    ttsAbort = { aborted: false, runId };
    setSpeaking(true);
    setWaitingAi(true);
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    try {
        // 指定プロファイルへ直接リクエスト(接続切替なし)。
        // メッセージは自前構築: キャラカード → チャット履歴 → TTS指示(末尾)
        // (TTS指示の role には Role設定の system/user を適用)
        const roleKey = (s.role || 'user').toLowerCase() === 'system' ? 'system' : 'user';
        let response;
        try {
            response = await generateViaProfile(effectiveProfileId, [
                ...ctxMessages,
                { role: roleKey, content: fullSysPrompt },
            ], signal);
        } catch (e) {
            // キャンセルによる中断ならトーストを出さずに静かに終わる
            if (signal.aborted || ttsAbort.aborted || ttsAbort.runId !== runId) return;
            toastr.error(`AI request failed: ${e?.message || e}`, EXT, { timeOut: 8000 });
            return;
        }

        // ユーザーが生成中にキャンセルした場合 / 新実行が始まった場合
        if (ttsAbort.aborted || ttsAbort.runId !== runId) return;

        // AI 応答待ち終了: 以後は再生フェーズ(circle-stop → comment-dots)
        setWaitingAi(false);

        console.log(`[${EXT}] ===== AI 応答 =====`);
        console.log(response);
        console.log(`[${EXT}] ==================`);

        if (!response || !response.trim()) {
            toastr.error('AI returned an empty response.', EXT);
            return;
        }

        // AI 応答から ["TTS", voice, text] ブロックを抽出
        let cmds;
        try {
            cmds = parseCommands(response);
        } catch (e) {
            toastr.error(`Failed to parse AI response: ${e.message || e}`, EXT, { timeOut: 8000 });
            return;
        }

        await playCommandsSequentially(cmds, runId);
    } finally {
        currentAbortController = null;
        // この実行が最新のときだけアイコンを戻す(キャンセル済みの旧実行が上書きしない)
        if (ttsAbort.runId === runId) setSpeaking(false);
    }
}

// ── リスナ ───────────────────────────────────────────────────────────────────
function initListeners() {
    // 設定値の永続化(debounce で保存)
    $('#irodori_tts_endpoint').on('input', () => persist());
    $('#irodori_tts_text').on('input', () => persist());
    $('#irodori_tts_sysprompt').on('input', () => persist());
    $('#irodori_tts_role').on('change', () => persist());
    $('#irodori_tts_history').on('input change', () => persist());
    $('#irodori_tts_profile').on('focus', () => refreshProfileSelect());
    $('#irodori_tts_profile').on('change', () => persist());
    $('#irodori_tts_enable').on('change', () => persist());

    // ボリューム: 入力中は表示を更新(即座に反映)、保存は debounce
    $('#irodori_tts_volume').on('input', function () {
        const v = Number(this.value) || 0;
        $('#irodori_tts_volume_val').text(`${v}%`);
        if (currentAudio) currentAudio.volume = v / 100; // 再生中の音声にも即座に反映
    });
    $('#irodori_tts_volume').on('change', () => persist());
    $('#irodori_tts_interval').on('input', function () {
        const iv = Number(this.value) || 0;
        $('#irodori_tts_interval_val').text(`${iv.toFixed(1)}s`);
    });
    $('#irodori_tts_interval').on('change', () => persist());

    // プロンプトリスト: 選択切替 → その本文を textarea へ
    $('#irodori_tts_prompt_select').on('change', function () {
        const s = settings();
        const idx = parseInt($(this).val(), 10);
        if (!isNaN(idx) && idx >= 0 && idx < (s.prompts || []).length) {
            s.selectedPrompt = idx;
            $('#irodori_tts_sysprompt').val(s.prompts[idx].text || '');
            saveSettingsDebounced();
        }
    });
    $('#irodori_tts_prompt_add').on('click', () => { void addPrompt(); });
    $('#irodori_tts_prompt_rename').on('click', () => { void renamePrompt(); });
    $('#irodori_tts_prompt_del').on('click', () => { void deletePrompt(); });

    // 参照音声: ボタンクリックで隠し input を開く → 選択でリストに追加
    $('#irodori_tts_ref_pick').on('click', () => {
        $('#irodori_tts_ref_files').trigger('click');
    });
    $('#irodori_tts_ref_files').on('change', function () {
        addRefFiles(this.files);
        // 同じファイルを連続選択できるよう input をクリア
        this.value = '';
    });

    // フォルダ選択: webkitdirectory でフォルダを開き、中の音声をまとめて追加
    $('#irodori_tts_ref_pickdir').on('click', () => {
        $('#irodori_tts_ref_dir').trigger('click');
    });
    $('#irodori_tts_ref_dir').on('change', function () {
        addRefFiles(this.files);
        this.value = '';
    });

    // 参考音声セレクト: 特に処理なし(select だけで選択が完結)

    $('#irodori_tts_send').on('click', () => { void sendAndPlay(); });
    $('#irodori_tts_health').on('click', () => { void checkHealth(); });
}

// ── 起動 ─────────────────────────────────────────────────────────────────────
jQuery(async () => {
    // 設定UI読込(st-pi-sync と同じ $.get 方式: 配置場所に依存しない)
    try {
        const html = await $.get(`${FOLDER}/settings.html`);
        $('#extensions_settings').append($('<div>').html(html).children());
    } catch (e) {
        console.error(`[${EXT}] settings.html 読込失敗:`, e);
        return;
    }

    await loadSettings();
    renderRefItems();
    initListeners();

    // APP_READY 後にもアイコンボタンを再構築(#send_but が確実に存在するタイミング)
    if (eventSource && event_types?.APP_READY) {
        eventSource.on(event_types.APP_READY, () => refreshSpeakButton());
    }
    // 念のため少し遅れても再試行(起動順の保険)
    setTimeout(refreshSpeakButton, 1500);
});
