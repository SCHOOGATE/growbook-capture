// GrowBook Capture v0.7 2026-11-21（配布用：setup の表示を「合言葉」だけにする＝導入ページの枠に貼る）
// v0.6 2026-11-21（アプリから本のフォルダを作る＝action 'newbook'）
// v0.5 2026-11-21（同時送信で同じ名前のフォルダが重なる不具合を直す＝フォルダ作りは1つずつ順番に＋作ったフォルダのIDを覚える・重なりは action 'tidy' でまとめる）
// v0.4 2026-11-21（手順4：PCの取り込み道具に材料の一覧とファイルを渡す＝action 'list' / 'get'。ドライブ側は消さない・材料フォルダの外は渡さない）
// v0.3 2026-11-07（手順3：10分ごとに音声を Gemini で書き起こし、日付ごとに 材料メモ_YYYY-MM-DD.md を作る）
// v0.2.1 2026-11-07（保存先フォルダのリンクを返す＝画面の「保存先を開く」用）
// v0.2 2026-11-07（画面を GitHub Pages に出し、doPost で受ける。Androidでも録音アプリは開かなかった＝実測）
//   公開設定：実行＝自分／アクセス＝全員（外の画面から送るため）。本人以外は合言葉（t）で弾く
// v0.1.1 2026-11-07（画面内の録音はApps Scriptの枠でマイクが禁止＝NotAllowedError実測 → 録音アプリを開く方式へ）
// v0.1 2026-11-07（手順2：最小版＝写真と音声をドライブに保存するまで）
// スマホのページ → 本人のドライブ「GrowBookForge材料/<本の名前>/<YYYY-MM-DD>/」に原本を保存
// 公開設定：実行＝自分／アクセス＝自分のみ（Googleログインした本人だけが開ける）＋合言葉（?t=）
// 文字起こし・材料メモは手順3（v0.2）で足す

var VERSION = 'growbook-capture v0.7';
var ROOT_NAME = 'GrowBookForge材料';
var TMP_NAME = '_送信中';            // 分割送信の一時置き場（送信完了で消す）
var DEFAULT_BOOK = '未分類';

// ---------- 入口 ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.v) return ContentService.createTextOutput(VERSION);
  if (!checkToken_(p.t)) {
    return HtmlService.createHtmlOutput('<p style="font-size:18px;padding:24px">このリンクは使えません。設定の手順書にある「自分専用のリンク」から開いてください。</p>')
      .setTitle('GrowBook 材料');
  }
  var html = PAGE_HTML.replace('__TOKEN__', String(p.t).replace(/[^A-Za-z0-9]/g, ''));
  return HtmlService.createHtmlOutput(html)
    .setTitle('本の材料を送る')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 外の画面（GitHub Pages）からの送信。本文は JSON（Content-Type: text/plain で送られてくる）
// { t, action: 'books'|'chunk'|'finish'|'memo', ... } → { ok:true, data } / { ok:false, error }
function doPost(e) {
  var out;
  try {
    var q = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var t = q.t;
    var data;
    if (q.action === 'books') data = listBooks(t);
    else if (q.action === 'chunk') data = putChunk(t, q.sid, q.idx, q.b64);
    else if (q.action === 'finish') data = finish(t, q.meta || {});
    else if (q.action === 'memo') data = saveMemo(t, q.book, q.memo);
    else if (q.action === 'ping') { guard_(t); data = VERSION; }
    else if (q.action === 'root') { guard_(t); data = root_().getUrl(); }
    else if (q.action === 'list') data = listMaterials(t, q.book, q.since);
    else if (q.action === 'get') data = getPart(t, q.id, q.off, q.len);
    else if (q.action === 'tidy') data = tidy(t);
    else if (q.action === 'newbook') data = newBook(t, q.name);
    else throw new Error('不明な操作です');
    out = { ok: true, data: data };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function token_() {
  return PropertiesService.getScriptProperties().getProperty('CAPTURE_TOKEN') || '';
}

function checkToken_(t) {
  var k = token_();
  return !!k && String(t || '') === k;
}

function guard_(t) {
  if (!checkToken_(t)) throw new Error('合言葉が違います');
}

// ---------- フォルダ ----------
// v0.5：写真を同時に送ると「今日のフォルダが無い」と同時に判断して同じ名前のフォルダが複数できた（11/21実測・3つ）。
// → フォルダを探す・作るところは1つずつ順番に（LockService）。作ったフォルダのIDを覚えて次からはIDで開く（名前の検索は反映が遅れることがある）
// log を渡したとき（tidy）は、同じ名前のフォルダが複数あれば古いものへ中身を移し、空になった方はゴミ箱へ（30日は戻せる）
function child_(parent, name, log) {
  var lock = LockService.getScriptLock(), mine = !lock.hasLock();
  if (mine) lock.waitLock(30000);
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'fid_' + parent.getId() + '_' + name;
    var id = props.getProperty(key);
    if (id && !log) {
      try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
    }
    var list = [], it = parent.getFoldersByName(name);
    while (it.hasNext()) list.push(it.next());
    var keep;
    if (!list.length) keep = parent.createFolder(name);
    else {
      list.sort(function (a, b) { return a.getDateCreated().getTime() - b.getDateCreated().getTime(); });
      keep = list[0];
      if (list.length > 1) mergeFolders_(keep, list.slice(1), log);
    }
    props.setProperty(key, keep.getId());
    return keep;
  } finally {
    if (mine) lock.releaseLock();
  }
}

function mergeFolders_(keep, others, log) {
  others.forEach(function (o) {
    var n = 0, fs = o.getFiles(), ds = o.getFolders();
    while (fs.hasNext()) { fs.next().moveTo(keep); n++; }
    while (ds.hasNext()) { ds.next().moveTo(keep); n++; }
    o.setTrashed(true);
    if (log) log.push('まとめた: ' + keep.getName() + '（' + n + '件を移し、空のフォルダをゴミ箱へ）');
  });
}

function root_() {
  return child_(DriveApp.getRootFolder(), ROOT_NAME);
}

// 同じ名前で重なった本・日付のフォルダをまとめる（合言葉つき action 'tidy'）
function tidy(t) {
  guard_(t);
  var log = [], r = child_(DriveApp.getRootFolder(), ROOT_NAME, log);
  var names = {}, it = r.getFolders();
  while (it.hasNext()) names[it.next().getName()] = 1;
  Object.keys(names).forEach(function (bn) {
    var b = child_(r, bn, log), dn = {}, d = b.getFolders();
    while (d.hasNext()) dn[d.next().getName()] = 1;
    Object.keys(dn).forEach(function (n) { child_(b, n, log); });
  });
  if (!log.length) log.push('重なったフォルダはありません');
  return log;
}

function cleanName_(s) {
  return String(s || '').replace(/[\\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 60);
}

// ---------- スマホのページから呼ばれる ----------
function listBooks(t) {
  guard_(t);
  var out = [], it = root_().getFolders();
  while (it.hasNext()) {
    var n = it.next().getName();
    if (n !== TMP_NAME) out.push(n);
  }
  out.sort();
  return out;
}

// 本のフォルダを作る（スマホの「＋ 新しい本を作る」から）。同じ名前があればそれを使う
function newBook(t, name) {
  guard_(t);
  name = cleanName_(name);
  if (!name || name === TMP_NAME) throw new Error('本の名前を入れてください');
  child_(root_(), name);
  return { name: name, books: listBooks(t) };
}

// 分割送信：1かけらずつ一時ファイルにする
function putChunk(t, sid, idx, b64) {
  guard_(t);
  sid = String(sid).replace(/[^A-Za-z0-9_-]/g, '');
  var tmp = child_(root_(), TMP_NAME);
  tmp.createFile(sid + '_' + ('0000' + idx).slice(-5) + '.part', String(b64), 'text/plain');
  return idx;
}

// 送信完了：かけらをつないで本の日付フォルダに保存
// meta = { sid, n, book, kind('写真'|'音声'), mime, ext, memo }
function finish(t, meta) {
  guard_(t);
  var sid = String(meta.sid).replace(/[^A-Za-z0-9_-]/g, '');
  var tmp = child_(root_(), TMP_NAME);
  var bytes = [], parts = [];
  for (var i = 0; i < meta.n; i++) {
    var it = tmp.getFilesByName(sid + '_' + ('0000' + i).slice(-5) + '.part');
    if (!it.hasNext()) throw new Error('送信の一部が届いていません（' + (i + 1) + '/' + meta.n + '）。もう一度送ってください');
    var f = it.next();
    parts.push(f);
    bytes = bytes.concat(Utilities.base64Decode(f.getBlob().getDataAsString()));
  }
  var now = new Date();
  var day = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  var hms = Utilities.formatDate(now, 'Asia/Tokyo', 'HHmmss');
  var book = cleanName_(meta.book) || DEFAULT_BOOK;
  var kind = meta.kind === '音声' ? '音声' : '写真';
  var ext = String(meta.ext || (kind === '音声' ? 'm4a' : 'jpg')).replace(/[^a-z0-9]/gi, '').slice(0, 5);
  var folder = child_(child_(root_(), book), day);
  var name = hms + '_' + kind + '_' + sid.slice(-4) + '.' + ext;
  var file = folder.createFile(Utilities.newBlob(bytes, String(meta.mime || 'application/octet-stream'), name));
  if (meta.memo) file.setDescription(String(meta.memo).slice(0, 2000));
  for (var j = 0; j < parts.length; j++) parts[j].setTrashed(true);
  return { name: name, folder: ROOT_NAME + '/' + book + '/' + day, size: bytes.length, url: file.getUrl(), folderUrl: folder.getUrl() };
}

// メモだけ送る
function saveMemo(t, book, memo) {
  guard_(t);
  memo = String(memo || '').trim();
  if (!memo) throw new Error('メモが空です');
  var now = new Date();
  var day = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  var hms = Utilities.formatDate(now, 'Asia/Tokyo', 'HHmmss');
  book = cleanName_(book) || DEFAULT_BOOK;
  var folder = child_(child_(root_(), book), day);
  var name = hms + '_メモ.txt';
  var file = folder.createFile(name, memo, 'text/plain');
  return { name: name, folder: ROOT_NAME + '/' + book + '/' + day, url: file.getUrl(), folderUrl: folder.getUrl() };
}

// ---------- PCの取り込み道具から呼ばれる（v0.4・手順4） ----------
// list: { book?（省くと全部の本）, since?（'YYYY-MM-DD' 以降の日付だけ） }
//   → [{ book, day, id, name, size, mime, updated }]（_送信中 は渡さない）
function listMaterials(t, book, since) {
  guard_(t);
  var want = book ? cleanName_(book) : '';
  since = /^\d{4}-\d{2}-\d{2}$/.test(String(since || '')) ? String(since) : '';
  var out = [], books = root_().getFolders();
  while (books.hasNext()) {
    var b = books.next(), bn = b.getName();
    if (bn === TMP_NAME || (want && bn !== want)) continue;
    var days = b.getFolders();
    while (days.hasNext()) {
      var d = days.next(), dn = d.getName();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dn) || (since && dn < since)) continue;
      var fs = d.getFiles();
      while (fs.hasNext()) {
        var f = fs.next();
        out.push({ book: bn, day: dn, id: f.getId(), name: f.getName(), size: f.getSize(),
                   mime: f.getMimeType(), updated: f.getLastUpdated().toISOString() });
      }
    }
  }
  out.sort(function (a, c) { return (a.book + a.day + a.name) < (c.book + c.day + c.name) ? -1 : 1; });
  return out;
}

// get: { id, off（先頭からのバイト位置）, len（最大 GET_MAX） } → { b64, off, len, size }
// 材料フォルダ（GrowBookForge材料/<本>/<日付>/）の中のファイルだけ渡す
var GET_MAX = 6 * 1024 * 1024;
function getPart(t, id, off, len) {
  guard_(t);
  var f = DriveApp.getFileById(String(id || ''));
  if (!inMaterials_(f)) throw new Error('材料フォルダの外のファイルは渡せません');
  var bytes = f.getBlob().getBytes();
  off = Math.max(0, Number(off) || 0);
  len = Math.min(GET_MAX, Math.max(1, Number(len) || GET_MAX));
  var part = bytes.slice(off, off + len);
  return { b64: Utilities.base64Encode(part), off: off, len: part.length, size: bytes.length };
}

function inMaterials_(f) {
  var rootId = root_().getId(), ps = f.getParents();
  while (ps.hasNext()) {
    var day = ps.next();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.getName())) continue;
    var bs = day.getParents();
    while (bs.hasNext()) {
      var b = bs.next();
      if (b.getName() === TMP_NAME) continue;
      var rs = b.getParents();
      while (rs.hasNext()) if (rs.next().getId() === rootId) return true;
    }
  }
  return false;
}

// ---------- 設定（エディタから1回実行） ----------
// 権限の承認・材料フォルダ作成・合言葉の発行を行い、自分専用リンクの末尾をログに出す
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CAPTURE_TOKEN')) {
    props.setProperty('CAPTURE_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  var r = root_();
  child_(r, DEFAULT_BOOK);
  Logger.log('材料フォルダ: ' + r.getUrl());
  Logger.log('合言葉: ' + props.getProperty('CAPTURE_TOKEN'));
  Logger.log('↑ この合言葉と、デプロイした「ウェブアプリのURL」を、導入ページの枠に貼ってください（人には見せない）');
}

// ---------- 文字起こし・材料メモ（v0.3・時間トリガーで10分ごと） ----------
// 送信時は保存だけ（6分制限に当てない）。ここで新しい音声を Gemini で文字にし、日付フォルダごとに 材料メモ_YYYY-MM-DD.md を作り直す
// 文字起こしは「材料」であって事実の確定ではない（原稿に使う前に本人が読む＝GrowBookForge の企画確認で見せる）
var GEMINI_MODEL = 'gemini-3.5-flash-lite';
var TRANSCRIPT_SUFFIX = '_書き起こし.txt';
var MEMO_PREFIX = '材料メモ_';
var DAYS_BACK = 30;                 // さかのぼって見る日数
var INLINE_MAX = 14 * 1024 * 1024;  // これより大きい音声は Files API で送る（送信20MBまで・base64で約1.33倍）
var TIME_BUDGET_MS = 4.5 * 60 * 1000;

function geminiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

function isAudio_(name) { return /_音声_.*\.(m4a|mp4|aac|webm|ogg|mp3|wav|amr|3gp|bin)$/i.test(name); }
function isPhoto_(name) { return /_写真_.*\.(jpg|jpeg|png|heic)$/i.test(name); }
function isMemo_(name) { return /_メモ\.txt$/.test(name); }
function base_(name) { return name.replace(/\.[^.]+$/, ''); }

function geminiMime_(name, mime) {
  var m = /\.([a-z0-9]+)$/i.exec(name);
  var ext = m ? m[1].toLowerCase() : '';
  var map = { m4a: 'audio/m4a', mp4: 'audio/m4a', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mp3', wav: 'audio/wav' };
  return map[ext] || mime || 'audio/m4a';
}

var TRANSCRIBE_PROMPT = [
  'この音声は、本を書こうとしている人が自分の体験や考えを話した録音です。日本語で、話した言葉をそのまま書き起こしてください。',
  '・要約しない。言い換えない。話していないことを足さない',
  '・「えー」「あのー」などのつなぎ言葉だけは省いてよい',
  '・聞き取れないところは［聞き取れず］と書く',
  '・話の切れ目で改行する',
  '・最初の行に「要点：」として、話の中身を30字以内で1行だけ書き、その次の行から書き起こしを書く',
  '・音声がない、または無音のときは「（音声なし）」とだけ書く'
].join('\n');

function geminiGenerate_(key, part) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);
  var payload = { contents: [{ parts: [{ text: TRANSCRIBE_PROMPT }, part] }], generationConfig: { temperature: 0 } };
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('Gemini ' + code + ' ' + res.getContentText().slice(0, 200));
  var j = JSON.parse(res.getContentText());
  var parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini の返事が空です');
  return text;
}

// 大きい音声：Files API（再開可能アップロード）→ 処理完了を待って file_uri を返す
function geminiUpload_(key, blob, mime) {
  var bytes = blob.getBytes();
  var start = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + encodeURIComponent(key), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
               'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': mime },
    payload: JSON.stringify({ file: { display_name: blob.getName() } })
  });
  var h = start.getAllHeaders();
  var up = h['x-goog-upload-url'] || h['X-Goog-Upload-URL'];
  if (!up) throw new Error('Files API 開始失敗 ' + start.getResponseCode());
  var fin = UrlFetchApp.fetch(up, {
    method: 'post', muteHttpExceptions: true, contentType: mime,
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, payload: bytes
  });
  var f = JSON.parse(fin.getContentText()).file;
  if (!f || !f.uri) throw new Error('Files API 送信失敗 ' + fin.getResponseCode());
  for (var i = 0; i < 20 && f.state === 'PROCESSING'; i++) {
    Utilities.sleep(3000);
    f = JSON.parse(UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/' + f.name + '?key=' + encodeURIComponent(key), { muteHttpExceptions: true }).getContentText());
  }
  if (f.state && f.state !== 'ACTIVE') throw new Error('Files API 処理が終わりません（' + f.state + '）');
  return f.uri;
}

function transcribeFile_(key, file) {
  var blob = file.getBlob();
  var mime = geminiMime_(file.getName(), blob.getContentType());
  var part;
  if (blob.getBytes().length <= INLINE_MAX) {
    part = { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } };
  } else {
    part = { file_data: { mime_type: mime, file_uri: geminiUpload_(key, blob, mime) } };
  }
  return geminiGenerate_(key, part);
}

function hhmm_(name) {
  var m = /^(\d{2})(\d{2})(\d{2})_/.exec(name);
  return m ? m[1] + ':' + m[2] + ':' + m[3] : '';
}

// 日付フォルダ1つ分の材料メモを作り直す
function buildMemo_(book, dayFolder) {
  var day = dayFolder.getName();
  var files = [], transcripts = {}, it = dayFolder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.forEach(function (f) {
    var n = f.getName();
    if (n.slice(-TRANSCRIPT_SUFFIX.length) === TRANSCRIPT_SUFFIX) transcripts[n.slice(0, -TRANSCRIPT_SUFFIX.length)] = f.getBlob().getDataAsString();
  });
  var items = files.filter(function (f) { var n = f.getName(); return isAudio_(n) || isPhoto_(n) || isMemo_(n); });
  if (!items.length) return null;
  items.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  var nA = 0, nP = 0, nM = 0, body = [];
  items.forEach(function (f) {
    var n = f.getName(), memo = f.getDescription() || '';
    if (isAudio_(n)) {
      nA++;
      body.push('## ' + hhmm_(n) + ' 音声 `' + n + '`');
      body.push('- 原本: ' + f.getUrl());
      if (memo) body.push('- ひとことメモ: ' + memo.replace(/\n/g, ' '));
      body.push('');
      var tx = transcripts[base_(n)];
      body.push(tx ? tx.trim() : '（書き起こしはまだです。次の自動処理を待ってください）');
    } else if (isPhoto_(n)) {
      nP++;
      body.push('## ' + hhmm_(n) + ' 写真 `' + n + '`');
      body.push('- 原本: ' + f.getUrl());
      if (memo) body.push('- ひとことメモ: ' + memo.replace(/\n/g, ' '));
    } else {
      nM++;
      body.push('## ' + hhmm_(n) + ' メモ `' + n + '`');
      body.push('');
      body.push(f.getBlob().getDataAsString().trim());
    }
    body.push('');
  });
  var head = [
    '# 材料メモ ' + day + '（' + book + '）',
    '',
    '- 本: ' + book,
    '- 日付: ' + day,
    '- 中身: 音声 ' + nA + ' 本／写真 ' + nP + ' 枚／メモ ' + nM + ' 件',
    '- 作成: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') + '（GrowBook Capture が自動で作成）',
    '- 注意: 書き起こしは機械の聞き取りです。原稿に使う前に本人が読んで確かめてください',
    ''
  ];
  var name = MEMO_PREFIX + day + '.md', text = head.concat(body).join('\n');
  var old = dayFolder.getFilesByName(name);
  if (old.hasNext()) { var o = old.next(); o.setContent(text); return o; }
  return dayFolder.createFile(name, text, 'text/markdown');
}

function recentDayFolders_() {
  var out = [], cutoff = Utilities.formatDate(new Date(Date.now() - DAYS_BACK * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  var books = root_().getFolders();
  while (books.hasNext()) {
    var b = books.next();
    if (b.getName() === TMP_NAME) continue;
    var days = b.getFolders();
    while (days.hasNext()) {
      var d = days.next(), n = d.getName();
      if (/^\d{4}-\d{2}-\d{2}$/.test(n) && n >= cutoff) out.push({ book: b.getName(), folder: d });
    }
  }
  return out;
}

// 時間トリガーから呼ばれる本体（エディタから手で実行してもよい）
function processNew() {
  var t0 = Date.now(), key = geminiKey_();
  var props = PropertiesService.getScriptProperties();
  var log = [];
  recentDayFolders_().forEach(function (x) {
    var changed = false, it = x.folder.getFiles(), names = {}, audios = [];
    while (it.hasNext()) { var f = it.next(); names[f.getName()] = f; if (isAudio_(f.getName())) audios.push(f); }
    audios.forEach(function (f) {
      if (Date.now() - t0 > TIME_BUDGET_MS) return;
      var tname = base_(f.getName()) + TRANSCRIPT_SUFFIX;
      if (names[tname]) return;
      if (!key) { log.push('キー未設定のため書き起こしを飛ばしました: ' + f.getName()); return; }
      var ek = 'err_' + f.getId(), errs = Number(props.getProperty(ek) || 0);
      if (errs >= 3) return;
      try {
        var text = transcribeFile_(key, f);
        names[tname] = x.folder.createFile(tname, text, 'text/plain');
        props.deleteProperty(ek);
        changed = true;
        log.push('書き起こし: ' + x.book + '/' + x.folder.getName() + '/' + f.getName());
      } catch (err) {
        props.setProperty(ek, String(errs + 1));
        log.push('失敗(' + (errs + 1) + '/3): ' + f.getName() + ' ' + err.message);
      }
    });
    var memoName = MEMO_PREFIX + x.folder.getName() + '.md';
    var memo = names[memoName];
    var newest = 0;
    Object.keys(names).forEach(function (n) { if (n !== memoName) newest = Math.max(newest, names[n].getDateCreated().getTime()); });
    if (changed || !memo || memo.getLastUpdated().getTime() < newest) {
      if (buildMemo_(x.book, x.folder)) log.push('材料メモ更新: ' + x.book + '/' + x.folder.getName());
    }
  });
  log.forEach(function (s) { Logger.log(s); });
  return log;
}

// エディタから1回実行：10分ごとの自動処理を入れる（二重に入れない）
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'processNew') ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('processNew').timeBased().everyMinutes(10).create();
  Logger.log('10分ごとの自動処理を入れました。キー: ' + (geminiKey_() ? 'あり' : 'なし（スクリプト プロパティ GEMINI_API_KEY を入れてください）'));
}

// 動作確認：キーが通り、モデルが使えるか
function checkGemini() {
  var key = geminiKey_();
  if (!key) { Logger.log('キーがありません'); return; }
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + '?key=' + encodeURIComponent(key);
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('モデル確認 ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 150));
}

// ---------- 画面 ----------
var PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
+ '<style>'
+ 'body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#222}'
+ 'h1{font-size:20px;margin:4px 0 12px}'
+ 'label.t{display:block;font-size:14px;color:#555;margin:14px 0 4px}'
+ 'select,input[type=text],textarea{width:100%;box-sizing:border-box;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:10px;background:#fff}'
+ 'textarea{height:80px}'
+ '.btn{display:block;width:100%;box-sizing:border-box;padding:22px 0;font-size:20px;font-weight:bold;border:0;border-radius:16px;background:#1f5f9e;color:#fff;text-align:center;margin-top:12px}'
+ '.rec{background:#c0392b}.rec.on{background:#7f1d1d}'
+ '.sub{background:#fff;color:#1f5f9e;border:2px solid #1f5f9e;padding:14px 0;font-size:16px}'
+ '.card{background:#fff;border-radius:12px;padding:12px;margin-top:12px;font-size:15px;line-height:1.6;box-shadow:0 1px 3px rgba(0,0,0,.08)}'
+ '.ok{color:#1f7a4d;font-weight:bold}.ng{color:#c0392b;font-weight:bold}.wait{color:#888}'
+ '.hint{font-size:13px;color:#666;margin:6px 4px 0;line-height:1.5}'
+ '</style></head><body>'
+ '<h1>本の材料を送る</h1>'
+ '<label class="t" for="book">どの本の材料ですか</label>'
+ '<select id="book"><option>未分類</option></select>'
+ '<input id="newbook" type="text" placeholder="新しい本の名前（新しく作るときだけ）" style="margin-top:8px">'
+ '<label class="t" for="memo">ひとことメモ（任意）</label>'
+ '<textarea id="memo" placeholder="いつ・どこで・何の話か など"></textarea>'
+ '<label class="btn rec" for="recin">🎙 録音する（録音アプリが開きます）</label>'
+ '<input id="recin" type="file" accept="audio/*" capture style="display:none">'
+ '<label class="btn sub" for="afile">録音ファイルを選ぶ（ボイスメモなど）</label>'
+ '<input id="afile" type="file" accept="audio/*,.m4a,.mp3,.wav,.aac" style="display:none">'
+ '<p class="hint">前に録ったものを送るとき用。Googleドライブが開いたら、左上の「≡」からスマホ本体の保存場所を選んでください</p>'
+ '<label class="btn" for="cam">📷 写真を撮る</label>'
+ '<input id="cam" type="file" accept="image/*" capture="environment" style="display:none">'
+ '<label class="btn sub" for="lib">写真から選ぶ（複数可）</label>'
+ '<input id="lib" type="file" accept="image/*" multiple style="display:none">'
+ '<button class="btn sub" id="memobtn">メモだけ送る</button>'
+ '<div id="list"></div>'
+ '<script>'
+ 'var T="__TOKEN__",CH=3000000;'   // base64 で約3MBずつ（4の倍数）
+ 'function $(i){return document.getElementById(i);}'
+ 'function book(){var n=$("newbook").value.trim();return n||$("book").value;}'
+ 'function card(msg){var d=document.createElement("div");d.className="card";d.innerHTML=msg;var L=$("list");L.insertBefore(d,L.firstChild);return d;}'
+ 'function run(fn,args,ok,ng){var r=google.script.run.withSuccessHandler(ok).withFailureHandler(ng);r[fn].apply(r,args);}'
+ 'run("listBooks",[T],function(bs){var s=$("book");bs.forEach(function(b){if(b!=="未分類"){var o=document.createElement("option");o.textContent=b;s.appendChild(o);}});'
+ 'try{var last=localStorage.getItem("gb_book");if(last)s.value=last;}catch(e){}},function(){});'
+ 'function sid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}'
+ 'function upload(b64,kind,mime,ext,label){var bk=book();try{localStorage.setItem("gb_book",bk);}catch(e){}'
+ 'var memo=$("memo").value,id=sid(),n=Math.ceil(b64.length/CH)||1,done=0,d=card("<span class=wait>"+label+"：送信中… 0/"+n+"</span>");'
+ 'function next(i){if(i>=n){run("finish",[T,{sid:id,n:n,book:bk,kind:kind,mime:mime,ext:ext,memo:memo}],function(r){'
+ 'd.innerHTML="<div class=ok>"+label+"を保存しました</div>"+r.folder+"/"+r.name+"<br>"+Math.round(r.size/1024)+" KB";},fail);return;}'
+ 'run("putChunk",[T,id,i,b64.slice(i*CH,(i+1)*CH)],function(){done++;d.innerHTML="<span class=wait>"+label+"：送信中… "+done+"/"+n+"</span>";next(i+1);},fail);}'
+ 'function fail(e){d.innerHTML="<span class=ng>"+label+"：失敗しました（"+(e&&e.message||e)+"）</span>";}'
+ 'next(0);}'
+ 'function readB64(blob,cb){var fr=new FileReader();fr.onload=function(){cb(String(fr.result).split(",")[1]||"");};fr.readAsDataURL(blob);}'
+ 'function extOf(name,mime){var m=/\\.([a-z0-9]{2,5})$/i.exec(name||"");if(m)return m[1].toLowerCase();'
+ 'if(/mp4|m4a|aac/.test(mime))return "m4a";if(/webm/.test(mime))return "webm";if(/ogg/.test(mime))return "ogg";if(/wav/.test(mime))return "wav";if(/mpeg|mp3/.test(mime))return "mp3";return "bin";}'
+ 'function shrink(file,cb){var fr=new FileReader();fr.onload=function(){var im=new Image();im.onload=function(){'
+ 'var max=2400,w=im.width,h=im.height,s=Math.min(1,max/Math.max(w,h));var c=document.createElement("canvas");'
+ 'c.width=Math.round(w*s);c.height=Math.round(h*s);c.getContext("2d").drawImage(im,0,0,c.width,c.height);'
+ 'cb(c.toDataURL("image/jpeg",0.88).split(",")[1]);};im.onerror=function(){cb(String(fr.result).split(",")[1]);};im.src=fr.result;};fr.readAsDataURL(file);}'
+ 'function pickImg(ev){var fs=ev.target.files;for(var i=0;i<fs.length;i++)(function(f){shrink(f,function(b){upload(b,"写真","image/jpeg","jpg","写真");});})(fs[i]);ev.target.value="";}'
+ '$("cam").addEventListener("change",pickImg);$("lib").addEventListener("change",pickImg);'
+ 'function pickAud(ev){var f=ev.target.files[0];if(!f)return;var mime=f.type||"audio/mp4";'
+ 'readB64(f,function(b){upload(b,"音声",mime,extOf(f.name,mime),"音声");});ev.target.value="";}'
+ '$("afile").addEventListener("change",pickAud);$("recin").addEventListener("change",pickAud);'
+ '$("memobtn").addEventListener("click",function(){var m=$("memo").value.trim();if(!m){card("<span class=ng>メモが空です</span>");return;}'
+ 'var d=card("<span class=wait>メモ：送信中…</span>");run("saveMemo",[T,book(),m],function(r){d.innerHTML="<div class=ok>メモを保存しました</div>"+r.folder+"/"+r.name;$("memo").value="";},'
+ 'function(e){d.innerHTML="<span class=ng>メモ：失敗しました（"+(e&&e.message||e)+"）</span>";});});'
+ '</script></body></html>';
