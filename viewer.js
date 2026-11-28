"use strict";
const $ = (s) => document.querySelector(s);
// Google のログインから戻ったとき：?code= を受け取り、ログイン前の ?p=… に戻す（state に入れておいた）
const authBack = new URLSearchParams(location.search);
let authCode = authBack.get("code"), authError = authBack.get("error");
if (authCode || authError) history.replaceState(null, "", location.pathname + (authBack.get("state") || ""));
const params = new URLSearchParams(location.search);
const paperId = params.get("p");
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても表示は続ける */ } },
};
const isPortrait = () => matchMedia("(max-width: 899px) and (orientation: portrait)").matches;
// scrollIntoView は iPhone で画面全体まで動かし、上のボタンが画面の外に出て押せなくなるので、欄の中だけを動かす
function scrollInto(box, el, center) {
  const d = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTop += center ? d - (box.clientHeight - el.offsetHeight) / 2 : d;
}

// file:// でも動くよう、データは fetch ではなく <script> で読む
function loadScript(src) {
  return new Promise((ok, ng) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => ng(new Error(src + " を読めません"));
    document.head.appendChild(s);
  });
}

// ---------- Drive 版：http(s) で開いたとき（GitHub Pages）は、Drive の Papers/viewer を API で読む ----------
const CLIENT_ID = "864436920728-1mlldj31a498l8hkbnaaglumsb63gj6u.apps.googleusercontent.com";  // Google Cloud の OAuth クライアント（ウェブ アプリケーション）の ID。手順は SETUP_iphone.md
const ON_DRIVE = location.protocol !== "file:";
const API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SRC = "data:,drive:";  // 図の src に入れる仮の値。<img> には認証ヘッダーを付けられないので、後で blob の URL に差し替える
const CLIENT_SECRET = "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";  // 同じクライアントのシークレット。ページから見えるが、それだけでは Drive を読めない（本人の許可が要る）。手順は SETUP_iphone.md
const SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";  // drive.file は論文を追加する（inbox に書く）ため
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, "");  // Google Cloud の「承認済みのリダイレクト URI」と1文字も違わないこと
let token = null, viewerDir = null;
// localStorage に置くのは、タブを閉じたりホーム画面から開き直したりしても1時間は取り直さずに済むようにするため
try { const t = JSON.parse(localStorage.getItem("token")); if (t && t.exp > Date.now()) token = t.v; } catch { /* 無ければ取り直す */ }

async function getToken(body) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error("ログインできません：" + (j.error_description || j.error)), { code: j.error });
  token = j.access_token;
  try {
    localStorage.setItem("token", JSON.stringify({ v: token, exp: Date.now() + (j.expires_in - 60) * 1000 }));
    if (j.refresh_token) localStorage.setItem("refresh", j.refresh_token);
  } catch { /* 次に開いたときにもう一度ログイン */ }
}

let loggingIn = null;
function login() {
  // 図の読み込みの途中で同時に何件切れても、取り直すのは1回
  return loggingIn || (loggingIn = (async () => {
    if (authError) { const e = authError; authError = null; throw new Error("ログインできません：" + e); }
    if (authCode) { const code = authCode; authCode = null; return getToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }); }  // 一度しか使えない
    let refresh = null;
    try { refresh = localStorage.getItem("refresh"); } catch { /* 無ければログインの画面へ */ }
    if (refresh) {
      // 1時間で切れるアクセス トークンを、画面を出さずに取り直す。ボタンを要らなくするため
      try { return await getToken({ grant_type: "refresh_token", refresh_token: refresh }); }
      catch (e) { if (e.code !== "invalid_grant") throw e; try { localStorage.removeItem("refresh"); } catch { /* 無視 */ } }  // 取り消された・半年使わなかった
    }
    // 窓ではなくページごと移るので、iPhone でもタップ無しで開ける。prompt=consent は、更新用の鍵を確実にもらうため（最初の1回だけ）
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT,
      response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state: location.search });
    return new Promise(() => {});  // 移る間に続きを動かさない
  })().finally(() => { loggingIn = null; }));
}

async function drive(url, opts = {}, retry = true) {
  if (!token) await login();
  const r = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: "Bearer " + token } });
  const text = r.ok ? "" : await r.text();
  // 401 は1時間でトークンが切れた。403 の insufficient は drive.file を足す前のトークンで書こうとした
  if (r.status === 401 || r.status === 403 && /insufficient/i.test(text) && retry) {
    token = null;
    try { localStorage.removeItem("token"); } catch { /* 無視 */ }
    return drive(url, opts, r.status === 401);
  }
  if (!r.ok) throw new Error(`Drive API ${r.status}：${text}`);
  return r;
}
async function files(q) {
  let out = [], page = "";
  do {
    const r = await (await drive(`${API}?pageSize=1000&fields=nextPageToken,files(id,name,size)&q=${encodeURIComponent(q + " and trashed=false")}${page && "&pageToken=" + page}`)).json();
    out = out.concat(r.files); page = r.nextPageToken;
  } while (page);
  return out;
}
const quote = (s) => "'" + s.replace(/['\\]/g, "\\$&") + "'";
async function child(name, parent) {
  const f = (await files(`name=${quote(name)} and ${quote(parent)} in parents`))[0];
  if (!f) throw new Error(name + " が Drive にありません");
  return f.id;
}
async function driveData(dir, file) {
  if (!viewerDir) {
    // 拡張が作った Papers と手で作った Papers が並ぶことがあるので、viewer を持つほうを使う
    const papers = await files(`name='Papers' and 'root' in parents and mimeType='application/vnd.google-apps.folder'`);
    if (!papers.length) throw new Error("Drive に Papers がありません");
    const v = await files(`name='viewer' and (${papers.map((p) => quote(p.id) + " in parents").join(" or ")})`);
    if (!v.length) throw new Error("Drive に Papers/viewer がありません");
    viewerDir = v[0].id;
  }
  const parent = dir ? await child(dir, viewerDir) : viewerDir;
  const t = await (await drive(`${API}/${await child(file, parent)}?alt=media`)).text();
  return { parent, data: JSON.parse(t.slice(t.indexOf("=") + 1).trim().replace(/;$/, "")) };  // Drive のファイルはコードとして実行せず、データとして読む
}
async function load(dir, file, name) {
  if (ON_DRIVE) return driveData(dir, file);
  await loadScript((dir ? encodeURIComponent(dir) + "/" : "") + file);
  return { data: window[name] };
}

// 仮の src の付いた図・動画が画面に入ったら、Drive から取って差し替える（図は開いたときに裏ですべて取ってあるので、取り終えていればすぐ出る）
const blobs = new Map(), sizes = {}, suppIds = {};
function blobUrl(id) {
  if (!blobs.has(id)) blobs.set(id, drive(`${API}/${id}?alt=media`).then((r) => r.blob()).then((b) => URL.createObjectURL(b)));
  return blobs.get(id);
}
function swap(el) {
  for (const a of ["src", "poster"]) {
    const v = el.getAttribute(a);
    if (!v || !v.startsWith(DRIVE_SRC)) continue;
    el.removeAttribute(a);
    if (el.tagName === "VIDEO" && a === "src") { holdVideo(el, v.slice(DRIVE_SRC.length)); continue; }
    blobUrl(v.slice(DRIVE_SRC.length)).then((u) => el.setAttribute(a, u), () => { el.alt = "図を読めません"; });
  }
}
// 動画は1本 1〜9MB あり、図の欄に出ただけで全部を取ると iPhone の回線では重いので、押されてから取る（blob なので途中から再生はできない）
function holdVideo(el, id) {
  const b = document.createElement("button");
  b.className = "vload";
  b.textContent = `▶ 動画を読み込む${sizes[id] ? `（${(sizes[id] / 1e6).toFixed(1)} MB）` : ""}`;
  b.onclick = () => {
    b.textContent = "読み込み中…"; b.disabled = true;
    blobUrl(id).then((u) => { el.src = u; b.remove(); }, () => { b.textContent = "動画を読めません"; });
  };
  el.after(b);
}
const lazy = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { lazy.unobserve(e.target); swap(e.target); } }));
if (ON_DRIVE) new MutationObserver((ms) => {
  for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    for (const el of [n, ...n.querySelectorAll("img, video")]) {
      if (!el.matches("img, video")) continue;
      el.loading === "lazy" ? lazy.observe(el) : swap(el);
    }
  }
}).observe(document.body, { childList: true, subtree: true });
async function driveFigs(dir) {
  const ids = {};
  for (const f of await files(`${quote(await child("figures", dir))} in parents`)) { ids["figures/" + f.name] = f.id; sizes[f.id] = +f.size; }
  figs.forEach((f) => { if (ids[f.img]) f.src = DRIVE_SRC + ids[f.img]; if (ids[f.video]) f.vsrc = DRIVE_SRC + ids[f.video]; });
  P.blocks.forEach((b) => { if (ids[b.img]) b.src = DRIVE_SRC + ids[b.img]; });  // 画像の数式
  if ((P.supp || []).some((s) => s.file)) for (const f of await files(`${quote(await child("supp", dir))} in parents`)) suppIds["supp/" + f.name] = f.id;
  // 図（動画は表紙だけ）は、読み進めて出るのを待たずに論文の順にすべて取る。同時は3本までにして、いま図の欄に出す1枚の取得が後ろで待たされないようにする
  const queue = figs.filter((f) => f.src).map((f) => f.src.slice(DRIVE_SRC.length));
  const worker = async () => { while (queue.length) await blobUrl(queue.shift()).catch(() => {}); };
  for (let i = 0; i < 3; i++) worker();
}

// ---------- 論文の追加（iPhone から）：拡張と同じ形で Papers/inbox/{論文ID}/request.json を書く。処理は自宅PCの run_inbox.py ----------
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const API_ONLY = /^10\.(7554|1101|64898)\//;  // eLife、bioRxiv。自宅PCが API で取る
// 拡張の background.js の toDoi と同じ
function toDoi(input) {
  const s = decodeURIComponent(input.trim());
  let m;
  if ((m = s.match(/elifesciences\.org\/(?:articles|reviewed-preprints)\/(\d+)/))) return "10.7554/eLife." + m[1];
  if ((m = s.match(/nature\.com\/articles\/([^/?#.]+)/))) return "10.1038/" + m[1];
  if ((m = s.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/))) return "10.48550/arXiv." + m[1];
  if ((m = s.match(/biorxiv\.org\/content\/(10\.\d+\/[^?#]+?)(?:v\d+)?(?:\.full.*|\.abstract|\/)?(?:[?#].*)?$/))) return m[1];
  m = s.match(/10\.\d{4,9}\/[^\s?#]+/);
  return m ? m[0] : null;
}
async function addPaper(input) {
  const doi = toDoi(input);
  if (!doi) throw new Error("URL・DOI から DOI を読めません");
  const id = doi.replaceAll("/", "_");  // パイプラインの論文ID と同じ
  const papers = await files(`name='Papers' and 'root' in parents and mimeType='application/vnd.google-apps.folder'`);
  const inbox = papers.length && (await files(`name='inbox' and (${papers.map((p) => quote(p.id) + " in parents").join(" or ")})`))[0];
  if (!inbox) throw new Error("Drive に Papers/inbox がありません（Mac の拡張で一度保存すると作られます）");
  if ((await files(`name=${quote(id)} and ${quote(inbox.id)} in parents`)).length) return "保存済み：" + id;
  const dir = (await (await drive(API, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: id, mimeType: "application/vnd.google-apps.folder", parents: [inbox.id] }) })).json()).id;
  const source = API_ONLY.test(doi) ? (doi.startsWith("10.7554/") ? "elife" : "biorxiv") : doi.startsWith("10.1038/") ? "html" : "pdf";
  // Nature はページ無しで置く。自宅PCが公開のページを取り、購読が要れば「Mac で保存が必要」にする。3誌以外は自宅PCが本文を取れないので、必ず「Mac で PDF の保存が必要」になる
  const req = { doi, url: "https://doi.org/" + doi, title: null, journal: null, id, source, page: null, saved_at: new Date().toISOString(), from: "viewer" };
  const b = "paper" + Date.now();
  await drive(UPLOAD + "?uploadType=multipart", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b },
    body: `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: "request.json", parents: [dir] })}\r\n`
      + `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(req, null, 1)}\r\n--${b}--` });
  return `追加しました：${id}（自宅PCが処理すると一覧に出ます）`;
}

// ---------- 論文の中の検索：単語リスト（terms.js）の語はその場で探し、それ以外は Drive の Papers/search 経由で自宅PCに頼む（plan/search_spec.md） ----------
// 照らし合わせ方は search_spec.md のとおり（自宅PCの検索係・単語リストと同じ規則）
function termRe(t) {
  const e = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!/^[\x00-\x7f]+$/.test(t)) return new RegExp(e, "g");
  const lower = !/[A-Z]/.test(t);
  return new RegExp(`(?<![A-Za-z0-9])${e}${lower ? "(?:e?s)?" : ""}(?![A-Za-z0-9])`, lower ? "gi" : "g");
}
const parseQuery = (q) => [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] || m[2]).trim()).filter(Boolean);
function markHtml(text, res) {
  const rs = [];
  // matchAll は lastIndex の位置から探すので、snippet の exec で進んだ位置を戻す
  for (const r of res) { r.lastIndex = 0; for (const m of text.matchAll(r)) if (m[0]) rs.push([m.index, m.index + m[0].length]); }
  rs.sort((a, b) => a[0] - b[0]);
  let out = "", at = 0;
  for (const [s, e] of rs) { if (s < at) continue; out += esc(text.slice(at, s)) + "<mark>" + esc(text.slice(s, e)) + "</mark>"; at = e; }
  return out + esc(text.slice(at));
}
// 訳と原文のうち、読む言葉の側で当たればそちらを、当たらなければもう一方を、当たった所の前後だけ出す
function snippet(ja, en, res) {
  const texts = lang === "ja" ? [ja, en] : [en, ja];
  let text = texts.find((t) => t && res.some((r) => { r.lastIndex = 0; return r.test(t); })) || texts.find(Boolean) || "";
  let i = 0;
  for (const r of res) { r.lastIndex = 0; const m = r.exec(text); if (m) { i = m.index; break; } }
  const s = Math.max(0, i - 40), part = text.slice(s, s + 160);
  return (s ? "…" : "") + markHtml(part, res) + (s + 160 < text.length ? "…" : "");
}
const hitLink = (pid, block, terms) => `?p=${encodeURIComponent(pid)}&b=${encodeURIComponent(block)}&hl=${encodeURIComponent(terms.join("|"))}`;

let TERMS = null;
async function loadTerms() {
  if (!ON_DRIVE) { await loadScript("terms.js"); return window.TERMS; }
  await driveData(null, "library.js");  // viewerDir を決める（一覧で読み済みなら Drive には問い合わせない）
  const f = (await (await drive(`${API}?fields=files(id,modifiedTime)&q=${encodeURIComponent(`name='terms.js' and ${quote(viewerDir)} in parents and trashed=false`)}`)).json()).files[0];
  if (!f) return null;
  // 数MB あるので、自宅PCが作り直したときだけ読み直す（入らなければ毎回読む）
  const c = store.get("terms", null);
  if (c && c.t === f.modifiedTime) return c.data;
  const t = await (await drive(`${API}/${f.id}?alt=media`)).text();
  const data = JSON.parse(t.slice(t.indexOf("=") + 1).trim().replace(/;$/, ""));
  store.set("terms", { t: f.modifiedTime, data });
  return data;
}
// 単語リストの語のうち、入れた語と同じもの。英語の語は search_spec.md の規則（小文字だけの語は大文字・小文字を区別しない）
function findTerm(q) {
  return TERMS.terms.find((t) => (t.en && (t.en === q || !/[A-Z]/.test(t.en) && t.en === q.toLowerCase())) || t.ja.includes(q));
}
function suggest(q) {
  const l = q.toLowerCase();
  return TERMS.terms.filter((t) => (t.en && t.en.toLowerCase().startsWith(l)) || t.ja.some((j) => j.startsWith(q))).sort((a, b) => b.n - a.n).slice(0, 8);
}

const paperCache = {};
function paperText(pid) {
  return paperCache[pid] || (paperCache[pid] = load(pid, "paper_data.js", "PAPER_DATA").then(({ data }) => {
    const out = {};
    for (const b of data.blocks) if (b.type === "para") out[b.id] = [strip(b.ja || ""), strip(b.en || "")];
    for (const f of data.figures) out[f.id] = [strip((f.title_ja || "") + " " + (f.caption_ja || "")), strip((f.title_en || "") + " " + (f.caption_en || ""))];
    return out;
  }));
}
function showTerm(res, t, titles) {
  const forms = [t.en, ...t.ja].filter(Boolean), re = forms.map(termRe);
  const byPaper = new Map();
  for (const [i, b, n] of t.hits) { const k = TERMS.papers[i]; if (!byPaper.has(k)) byPaper.set(k, []); byPaper.get(k).push([b, n]); }
  res.innerHTML = `<div class="sum"><b>${esc(forms.join("／"))}</b> ${t.n} 回・${byPaper.size} 本（単語リスト）</div>`
    + [...byPaper].map(([pid, hs]) => `<details data-pid="${esc(pid)}" data-n="${hs.reduce((s, h) => s + h[1], 0)}"><summary>${titles[pid] || esc(pid)} <span class="n">${hs.reduce((s, h) => s + h[1], 0)} 回・${hs.length} 段落</span></summary><div class="hits">読み込み中…</div></details>`).join("");
  sortHits(res, "word");
  res.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => {
    if (!d.open || d.dataset.done) return;
    d.dataset.done = 1;
    const pid = d.dataset.pid;
    paperText(pid).then((txt) => {
      d.querySelector(".hits").innerHTML = byPaper.get(pid).map(([b]) => `<a class="hit" href="${hitLink(pid, b, forms)}">${txt[b] ? snippet(txt[b][0], txt[b][1], re) : esc(b)}</a>`).join("");
    }, (e) => { d.querySelector(".hits").textContent = "読めません：" + e.message; });
  }));
}
function showResult(res, r, titles) {
  if (r.state !== "done") return (res.innerHTML = `<div class="sum">失敗：${esc(r.message)}</div>`);
  const terms = r.mode === "word" ? parseQuery(r.q) : [], re = terms.map(termRe);
  const byPaper = new Map();
  for (const h of r.hits) { if (!byPaper.has(h.paper)) byPaper.set(h.paper, []); byPaper.get(h.paper).push(h); }
  res.innerHTML = `<div class="sum"><b>${esc(r.q)}</b>（${r.mode === "word" ? `単語：${r.total} 段落${r.total > r.hits.length ? `、先頭の ${r.hits.length} 件` : ""}` : "意味：似ている順"}・自宅PCで ${r.took_s} 秒）</div>`
    + [...byPaper].map(([pid, hs]) => `<details open data-pid="${esc(pid)}" data-n="${r.mode === "word" ? hs.reduce((s, h) => s + h.score, 0) : hs.length}"><summary>${titles[pid] || esc(hs[0].title || pid)} <span class="n">${hs.length} 段落</span></summary><div class="hits">`
      + hs.map((h) => `<a class="hit" href="${hitLink(pid, h.block, terms)}">${r.mode === "meaning" ? `<span class="n">${h.score.toFixed(2)}</span> ` : ""}${snippet(h.ja, h.en, re)}</a>`).join("") + "</div></details>").join("");
  sortHits(res, r.mode);
}

// 並べ替え。題名・著者は読み（かな）のデータが無いので、文字の順で並べる
const byText = (f) => (a, b) => f(a).localeCompare(f(b), "ja");
const sortSelect = (sorts, key) => `<select class="sort">${Object.entries(sorts).map(([k, [l]]) => `<option value="${k}"${k === key ? " selected" : ""}>${l}</option>`).join("")}</select>`;
let paperYear = {};  // 論文ID → 年（renderFind で一覧から作る）
const HIT_SORT = {
  best: ["似ている順", null],
  new: ["年が新しい順", (a, b) => (paperYear[b.dataset.pid] || 0) - (paperYear[a.dataset.pid] || 0)],
  old: ["年が古い順", (a, b) => (paperYear[a.dataset.pid] || 0) - (paperYear[b.dataset.pid] || 0)],
  many: ["当たった数が多い順", (a, b) => b.dataset.n - a.dataset.n],
  title: ["題名の順", byText((d) => d.querySelector("summary").textContent)],
};
// 論文ごとのまとまり（details）を並べ替える。論文の中の段落の順は変えない
function sortHits(res, mode) {
  const ds = [...res.querySelectorAll("details")];  // 届いた順（意味検索なら似ている順）
  const sorts = Object.fromEntries(Object.entries(HIT_SORT).filter(([k]) => mode === "meaning" || k !== "best"));
  const key = store.get("hitSort:" + mode, mode === "meaning" ? "best" : "new");
  res.querySelector(".sum").insertAdjacentHTML("beforeend", " " + sortSelect(sorts, sorts[key] ? key : Object.keys(sorts)[0]));
  const sel = res.querySelector(".sum select");
  const apply = () => { const f = sorts[sel.value][1]; (f ? ds.slice().sort(f) : ds).forEach((d) => res.appendChild(d)); };
  sel.onchange = () => { store.set("hitSort:" + mode, sel.value); apply(); };
  apply();
}

// ビューアの権限（drive.file）では自分の作ったフォルダにしか書けないので、拡張の作った Papers（inbox を持つほう）の下に search を作る
let searchDir = null;
async function searchFolder(create) {
  if (searchDir) return searchDir;
  const papers = await files(`name='Papers' and 'root' in parents and mimeType='application/vnd.google-apps.folder'`);
  let parent = null;
  for (const p of papers) if ((await files(`name='inbox' and ${quote(p.id)} in parents`)).length) { parent = p.id; break; }
  if (!parent) throw new Error("Drive に Papers/inbox がありません（Mac の拡張で一度保存すると作られます）");
  const f = (await files(`name='search' and ${quote(parent)} in parents and mimeType='application/vnd.google-apps.folder'`))[0];
  if (f || !create) return (searchDir = f ? f.id : null);
  return (searchDir = (await (await drive(API, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "search", mimeType: "application/vnd.google-apps.folder", parents: [parent] }) })).json()).id);
}
async function askPc(q, mode) {
  const dir = await searchFolder(true);
  const qid = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const b = "search" + Date.now();
  await drive(UPLOAD + "?uploadType=multipart", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b },
    body: `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: qid + ".json", parents: [dir] })}\r\n`
      + `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ q, mode, at: new Date().toISOString(), from: "viewer" })}\r\n--${b}--` });
  return qid;
}
async function recentSearches() {
  const dir = await searchFolder(false);
  if (!dir) return [];
  const fs = await files(`${quote(dir)} in parents`);
  const ids = Object.fromEntries(fs.map((f) => [f.name, f.id]));
  const qs = fs.map((f) => f.name).filter((n) => /^\d+-[a-z0-9]+\.json$/.test(n)).sort().reverse().slice(0, 10);
  return Promise.all(qs.map(async (n) => {
    const qid = n.slice(0, -5), rid = ids[qid + ".result.json"];
    return { qid, done: !!rid, data: await (await drive(`${API}/${rid || ids[n]}?alt=media`)).json() };
  }));
}

function renderFind(box, items) {
  const titles = Object.fromEntries(items.map((it) => [it.id, it.title_ja || it.title_en]));
  paperYear = Object.fromEntries(items.map((it) => [it.id, it.year]));
  box.insertAdjacentHTML("beforeend", `<form class="find"><input type="search" placeholder="論文の中を検索（英語・日本語）" autocapitalize="off" autocorrect="off">
    <button data-mode="word">単語</button><button data-mode="meaning">意味</button>
    <div class="note">単語リストを読んでいます…</div><div class="sug"></div><div class="res"></div><div class="recent"></div></form>`);
  const f = box.querySelector("form.find"), input = f.querySelector("input"), res = f.querySelector(".res"), note = f.querySelector(".note");
  loadTerms().then((t) => {
    TERMS = t;
    note.textContent = t ? `単語リストの ${t.terms.length} 語は、入れるとすぐに出ます。ほかの語・文は「単語」「意味」で自宅PCが探します（数分）` : "単語リストはまだありません（自宅PCが作ります）";
  }, () => { note.textContent = "単語リストを読めません。「単語」「意味」で自宅PCが探します"; });
  if (!ON_DRIVE) f.querySelectorAll("button").forEach((b) => { b.disabled = true; b.title = "自宅PCでの検索は、GitHub Pages のビューアから"; });
  let timer;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value.trim(), sug = f.querySelector(".sug");
      sug.innerHTML = "";
      if (!q || !TERMS) return;
      const t = parseQuery(q).length === 1 && findTerm(parseQuery(q)[0]);
      if (t) return showTerm(res, t, titles);
      sug.innerHTML = suggest(q).map((t) => `<button type="button" data-q="${esc(t.en || t.ja[0])}">${esc([t.en, ...t.ja].filter(Boolean).join("／"))} <span class="n">${t.n}</span></button>`).join("");
    }, 200);
  };
  f.querySelector(".sug").onclick = (e) => { const b = e.target.closest("button"); if (b) { input.value = b.dataset.q; input.oninput(); } };
  const showRecent = () => recentSearches().then((rs) => {
    const r = f.querySelector(".recent");
    r.innerHTML = rs.length ? "<div class=\"h\">最近の検索（自宅PC）</div>" + rs.map((x, i) => `<button type="button" data-i="${i}">${x.data.mode === "meaning" ? "意味" : "単語"}｜${esc(x.data.q)} <span class="n">${!x.done ? "検索中…" : x.data.state === "done" ? (x.data.mode === "word" ? x.data.total + " 段落" : x.data.hits.length + " 件") : "失敗"}</span></button>`).join("") : "";
    r.onclick = (e) => { const b = e.target.closest("button"); if (b && rs[b.dataset.i].done) showResult(res, rs[b.dataset.i].data, titles); };
    return rs;
  }, () => []);
  if (ON_DRIVE) showRecent();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode || "word", q = input.value.trim();
    if (!q) return;
    res.innerHTML = `<div class="sum">自宅PCに頼んでいます…</div>`;
    try {
      const qid = await askPc(q, mode);
      res.innerHTML = `<div class="sum">自宅PCが探しています（Drive の同期を挟むので数分かかります。閉じても後で「最近の検索」から見られます）</div>`;
      showRecent();
      const started = Date.now();
      // 待つ間は結果のファイルがあるかだけを見る（問い合わせ1回。最近の検索の10件を毎回読むと1回に11回になる）。
      // 結果は自宅PCの Drive の同期しだいで数十秒〜数分で来るので、最初の5分は3秒おき（Drive API の上限 毎分12,000回に比べて十分少ない）、その後は電池と通信を減らすため15秒おき
      const poll = async () => {
        try {
          if ((await files(`name=${quote(qid + ".result.json")} and ${quote(await searchFolder(false))} in parents`)).length) {
            const r = (await showRecent()).find((x) => x.qid === qid);
            if (r && r.done) return showResult(res, r.data, titles);
          }
        } catch {}  // iPhone の通信が一時的に切れても待ち続ける
        const t = Date.now() - started;
        if (t < 30 * 60e3) setTimeout(poll, t < 5 * 60e3 ? 3e3 : 15e3);  // 自宅PCが翻訳中でも検索係は別に動くので、30分で来なければ自宅PCが止まっている
        else res.innerHTML = `<div class="sum">30分たっても結果がありません。自宅PCが動いているかを確かめてください</div>`;
      };
      setTimeout(poll, 3e3);
    } catch (err) { res.innerHTML = `<div class="sum">失敗：${esc(err.message)}</div>`; }
  };
}

let P, figs = [], list = [], cur = 0, filter = "all";
let lang = store.get("lang", "ja"), follow = store.get("follow", true);
const flipped = new Set();
const hitBlock = params.get("b"), hlRes = (params.get("hl") || "").split("|").filter(Boolean).map(termRe);
// 検索した語に印を付ける。タグをまたぐ語（<i>Ndc</i>80 など）には付かない
function markText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), ns = [];
  while (w.nextNode()) ns.push(w.currentNode);
  for (const n of ns) {
    const h = markHtml(n.data, hlRes);
    if (!h.includes("<mark>")) continue;
    const s = document.createElement("span");
    s.innerHTML = h;
    n.replaceWith(...s.childNodes);
  }
}

async function main() {
  try {
    if (!paperId) {
      const items = (await load(null, "library.js", "LIBRARY")).data || [];
      // 保存待ちの一覧は自宅PCが mac_wait の論文があるときに書く。まだ一度も書かれていなければ無い
      const waiting = await load(null, "waiting.js", "WAITING").then((r) => r.data || [], () => []);
      return renderLibrary(items, waiting);
    }
    const { parent, data } = await load(paperId, "paper_data.js", "PAPER_DATA");
    P = data;
    figs = P.figures;
    if (ON_DRIVE) await driveFigs(parent);
    else {
      const base = encodeURIComponent(paperId) + "/";
      figs.forEach((f) => { if (f.img) f.src = base + f.img; if (f.video) f.vsrc = base + f.video; });
      P.blocks.forEach((b) => { if (b.img) b.src = base + b.img; });
    }
  } catch (e) { $("#text").textContent = e.message; return; }
  document.title = strip(P.meta.title_ja || P.meta.title_en);
  $("#bar-title").innerHTML = P.meta.title_ja || P.meta.title_en;
  restoreLayout();
  renderText();
  renderTabs();
  setFilter("all");
  setupZoom();
  setupSplit();
  setupControls();
  const pos = store.get("pos:" + paperId, 0);
  // 検索の結果から開いたときは、当たったブロックへ動かす（図の説明で当たったときは図の欄にその図を出す）
  const hit = hitBlock && document.getElementById(hitBlock);
  if (hitBlock && figById(hitBlock)) showFigById(hitBlock, true);
  requestAnimationFrame(() => {
    if (!hit) return ($("#text").scrollTop = pos);
    scrollInto($("#text"), hit, true);
    hit.classList.add("flash");
    setTimeout(() => hit.classList.remove("flash"), 2000);
  });
}

function strip(h) { const d = document.createElement("div"); d.innerHTML = h; return d.textContent; }

// ---------- 論文一覧 ----------
function renderLibrary(items, waiting) {
  document.body.classList.add("lib");
  $("#bar-title").textContent = `論文一覧（${items.length} 本）`;
  const box = document.createElement("div");
  box.className = "library";
  renderFind(box, items);
  if (ON_DRIVE) {  // Mac で同期フォルダから開いたとき（file://）は Drive に書けないので、追加は拡張で行う
    box.insertAdjacentHTML("beforeend", `<form class="add"><input type="text" placeholder="論文の URL・DOI" autocapitalize="off" autocorrect="off">
      <button>追加</button><div class="msg"></div></form>`);
    const f = box.querySelector("form.add");
    f.querySelector("input").value = params.get("add") || "";  // iPhone の共有ボタンのショートカットが ?add= に URL を入れて開く
    f.onsubmit = (e) => {
      e.preventDefault();
      const msg = f.querySelector(".msg");
      msg.textContent = "追加しています…";
      addPaper(f.querySelector("input").value).then((m) => { msg.textContent = m; }, (err) => { msg.textContent = "失敗：" + err.message; });
    };
  }
  for (const w of waiting) {
    box.insertAdjacentHTML("beforeend", `<div class="item wait"><div class="t">${esc(w.title || w.doi)}</div>
      <div class="s">${w.need === "pdf" ? "Mac で PDF の保存が必要" : "Mac で保存が必要"}：<a href="https://doi.org/${esc(w.doi)}" target="_blank" rel="noopener">論文を開く</a> → ${w.need === "pdf" ? "PDF をダウンロードし、拡張の「PDF ファイルから保存」" : "拡張の「このページを保存」"}</div></div>`);
  }
  box.insertAdjacentHTML("beforeend", `<div class="tools"><input type="search" placeholder="一覧を絞り込む（題名・著者・雑誌・年）" autocapitalize="off" autocorrect="off">
    ${sortSelect(LIB_SORT, LIB_SORT[store.get("libSort", "new")] ? store.get("libSort", "new") : "new")}
    <select class="mkfilter"><option value="">マーカー：すべて</option><option value="none">マーカーなし</option>${Object.entries(MARKS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div><div class="list"></div>`);
  const rows = items.map((it) => {
    const a = document.createElement("a");
    a.className = "item"; a.href = "?p=" + encodeURIComponent(it.id);
    a.innerHTML = `<div class="t">${it.title_ja || it.title_en}</div>
      <div class="s">${it.authors.join(", ")} — ${it.journal} ${it.year} ・ 図 ${it.n_figs} ・ 翻訳 ${Math.round(it.translated * 100)}%</div><div class="mk"></div>`;
    const mk = a.querySelector(".mk");
    const draw = () => {
      mk.innerHTML = Object.entries(MARKS).filter(([k]) => markOpen.has(it.id) || hasMark(it, k)).map(([k, l]) => `<button type="button" data-k="${k}" class="${hasMark(it, k) ? "on" : ""}">${l}</button>`).join("")
        + `<button type="button" data-open class="edit">${markOpen.has(it.id) ? "閉じる" : "マーカー"}</button>`;
    };
    // 行全体が論文へのリンクなので、マーカーの操作ではリンクを開かない
    mk.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      e.preventDefault();
      if (b.dataset.open !== undefined) markOpen.has(it.id) ? markOpen.delete(it.id) : markOpen.add(it.id);
      else toggleMark(it, b.dataset.k);
      draw();
      // 並べ方・絞り込みがマーカーに関わるときだけ並べ直す（そうでないと押した行が動く）
      if (/^mark|^none$/.test(sel.value) || mkSel.value) paint();
    };
    draw();
    return { it, a, hay: [strip(it.title_ja || ""), strip(it.title_en), ...it.authors, it.journal, it.year].join(" ").toLowerCase() };
  });
  const list = box.querySelector(".list"), narrow = box.querySelector(".tools input"), sel = box.querySelector(".tools select.sort"), mkSel = box.querySelector(".mkfilter");
  const paint = () => {
    const ws = narrow.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const okMark = (it) => !mkSel.value || (mkSel.value === "none" ? !hasMark(it) : hasMark(it, mkSel.value));
    const shown = rows.filter((r) => okMark(r.it) && ws.every((w) => r.hay.includes(w))).sort((a, b) => LIB_SORT[sel.value][1](a.it, b.it));
    list.replaceChildren(...shown.map((r) => r.a));
    $("#bar-title").textContent = `論文一覧（${ws.length ? shown.length + " / " : ""}${items.length} 本）`;
  };
  narrow.oninput = paint;
  sel.onchange = () => { store.set("libSort", sel.value); paint(); };
  mkSel.onchange = paint;
  paint();
  $("#text").appendChild(box);
}
// マーカーは、この端末のブラウザ（localStorage）に論文ID → マーカー名の一覧で持つ。端末をまたいでは共有されない
const MARKS = { unread: "未読", reading: "読書中", read: "読了", star: "重要", later: "あとで読む", check: "要確認" };
let marks = store.get("marks", {});
const markOpen = new Set();  // マーカーの選択欄を開いている論文
const hasMark = (it, k) => { const m = marks[it.id] || []; return k ? m.includes(k) : m.length > 0; };
function toggleMark(it, k) {
  const m = new Set(marks[it.id] || []);
  m.has(k) ? m.delete(k) : m.add(k);
  if (m.size) marks[it.id] = [...m]; else delete marks[it.id];
  store.set("marks", marks);
}
const byAdded = (a, b) => (b.added_at || "").localeCompare(a.added_at || "");
const LIB_SORT = {
  added_new: ["追加が新しい順", byAdded],
  added_old: ["追加が古い順", (a, b) => -byAdded(a, b)],
  mark_first: ["マーカーありを先に", (a, b) => hasMark(b) - hasMark(a) || byAdded(a, b)],
  mark_last: ["マーカーなしを先に", (a, b) => hasMark(a) - hasMark(b) || byAdded(a, b)],
  new: ["年が新しい順", (a, b) => b.year - a.year],
  old: ["年が古い順", (a, b) => a.year - b.year],
  title: ["題名の順", byText((it) => strip(it.title_ja || it.title_en))],
  journal: ["雑誌の順", byText((it) => it.journal)],
  author: ["第一著者の順", byText((it) => it.authors[0] || "")],
  done: ["翻訳の進んだ順", (a, b) => b.translated - a.translated],
};

// ---------- 本文 ----------
function renderText() {
  const art = document.createElement("article");
  const m = P.meta;
  art.innerHTML = `<h1>${m.title_ja || m.title_en}</h1>
    <div class="meta">${m.title_ja ? m.title_en + "<br>" : ""}${m.authors.join(", ")}<br>
    ${m.journal} ${m.year} ・ <a href="https://doi.org/${m.doi}" target="_blank">doi:${m.doi}</a></div>`;
  const toc = $("#toc");
  let listed = false;
  for (const b of P.blocks) {
    let el;
    if (b.supp && !listed) { suppList(art, toc); listed = true; }  // PDF から取り出した補足資料の中身は、補足資料の一覧の後に並べる
    if (b.type === "heading") {
      el = document.createElement(b.level <= 2 ? "h2" : "h3");
      el.innerHTML = b.ja || b.en;
      const a = document.createElement("a");
      a.className = "l" + Math.min(b.level, 3); a.innerHTML = el.innerHTML; a.href = "#" + b.id;
      // 目次を先に閉じる。閉じると本文の幅が広がって行が組み直されるので、後に閉じると横持ちの iPhone で行き過ぎる
      a.onclick = (e) => { e.preventDefault(); document.body.classList.remove("toc-open"); scrollInto($("#text"), el); };
      toc.appendChild(a);
    } else if (b.type === "para") {
      el = document.createElement("p");
      el.dataset.figs = b.figs.join(" ");
    } else if (b.type === "table") {
      el = document.createElement("div");
      el.className = "tbl";
      el.dataset.figs = b.fig;
    } else {
      el = document.createElement("div");
      el.textContent = b.en;
      if (b.src) { el.className = "formula"; el.insertAdjacentHTML("afterbegin", `<img alt="数式" src="${b.src}"> `); }
    }
    el.id = b.id;
    art.appendChild(el);
  }
  if (!listed) suppList(art, toc);
  if (P.refs.length) {
    art.insertAdjacentHTML("beforeend", "<h2>References</h2>");
    const ol = document.createElement("ol");
    ol.className = "refs";
    for (const r of P.refs) {
      const li = document.createElement("li");
      li.id = r.id;
      li.innerHTML = esc(r.text) + (r.doi ? ` <a href="https://doi.org/${esc(r.doi)}" target="_blank">DOI</a>` : "");
      ol.appendChild(li);
    }
    art.appendChild(ol);
  }
  $("#text").appendChild(art);
  paintParas();

  art.addEventListener("click", (e) => {
    const f = e.target.closest("a.fig");
    if (f) { e.preventDefault(); showFigById(f.dataset.fig, true); return; }
    const c = e.target.closest("a.cite");
    if (c) { e.preventDefault(); showRef(c.dataset.ref); return; }
    const o = e.target.closest("a[data-file]");
    if (o) { e.preventDefault(); openDrive(o.dataset.file); return; }
    if (e.target.closest("a")) return;
    const p = e.target.closest("p[id], .tbl[id], .supp[id]");
    if (p && !String(getSelection())) {  // 文字を選択しているときは切り替えない
      flipped.has(p.id) ? flipped.delete(p.id) : flipped.add(p.id);
      paintPara(p);
    }
  });

  // 読んでいる段落（画面の上から3割付近）が参照する図を表示する
  const io = new IntersectionObserver((ents) => {
    if (!follow) return;
    for (const en of ents) {
      if (en.isIntersecting && en.target.dataset.figs) showFigById(en.target.dataset.figs.split(" ")[0], false);
    }
  }, { root: $("#text"), rootMargin: "-25% 0px -65% 0px" });
  art.querySelectorAll("[data-figs]").forEach((p) => { if (p.dataset.figs) io.observe(p); });

  let t;
  $("#text").addEventListener("scroll", () => {
    clearTimeout(t);
    t = setTimeout(() => store.set("pos:" + paperId, $("#text").scrollTop), 300);
  });
}

function suppList(art, toc) {
  if (!P.supp || !P.supp.length) return;
  // PDF は Drive に置いてある。zip などの元データは論文1本で100MB を超えることがあるので、元の場所へのリンクにしてある（fetch_supp.py）
  const h = document.createElement("h2");
  h.id = "supp"; h.textContent = "補足資料";
  art.appendChild(h);
  const a = document.createElement("a");
  a.className = "l1"; a.textContent = "補足資料"; a.href = "#supp";
  a.onclick = (e) => { e.preventDefault(); document.body.classList.remove("toc-open"); scrollInto($("#text"), h); };
  toc.appendChild(a);
  for (const s of P.supp) {
    const d = document.createElement("div");
    d.className = "supp"; d.id = "supp-" + s.id;
    art.appendChild(d);
  }
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

const blockById = () => P._byId || (P._byId = Object.fromEntries(P.blocks.map((b) => [b.id, b])));
const figById = (id) => figs.find((f) => f.id === id);
function paintPara(p) {
  if (p.classList.contains("supp")) return paintSupp(p);
  const b = blockById()[p.id];
  const t = b.type === "table" ? figById(b.fig) : null;
  let want = flipped.has(p.id) ? (lang === "ja" ? "en" : "ja") : lang;
  const untranslated = want === "ja" && !(t ? (t.html ? t.html_ja : t.title_ja || !t.title_en) : b.ja);  // 画像の表は題名だけが訳の対象
  if (untranslated) want = "en";
  p.innerHTML = t ? tableHtml(t, want === "ja") : want === "ja" ? b.ja : b.en;
  p.classList.toggle("en-shown", want === "en");
  p.classList.toggle("untranslated", untranslated && lang === "ja");
  if (hlRes.length) markText(p);
}
function paintSupp(d) {
  const s = P.supp.find((x) => "supp-" + x.id === d.id);
  let want = flipped.has(d.id) ? (lang === "ja" ? "en" : "ja") : lang;
  const untranslated = want === "ja" && (s.title_en && !s.title_ja || s.caption_en && !s.caption_ja);
  if (untranslated) want = "en";
  const ja = want === "ja";
  const ext = (s.file || s.url || "").split("?")[0].split(".").pop().toUpperCase();
  const href = s.file ? (ON_DRIVE ? "#" : encodeURIComponent(paperId) + "/" + s.file) : s.url;
  d.innerHTML = `<div class="t"><b>${s.label}</b> ${(ja ? s.title_ja : s.title_en) || ""}</div>`
    + ((ja ? s.caption_ja : s.caption_en) || "").split("\n").map((x) => x && `<p>${x}</p>`).join("")
    + (href ? `<a class="open" href="${esc(href)}" target="_blank" rel="noopener"${s.file && ON_DRIVE ? ` data-file="${esc(s.file)}"` : ""}>`
      + `${s.file ? "開く" : "元の場所から取る"}（${ext}${s.size ? "・" + (s.size < 1e6 ? Math.ceil(s.size / 1e3) + " KB" : (s.size / 1e6).toFixed(1) + " MB") : ""}）</a>` : "");
  d.classList.toggle("en-shown", !ja);
  d.classList.toggle("untranslated", untranslated && lang === "ja");
}
// iPhone では、Drive から取り終えてから開く窓はポップアップとして止められるので、押したときに先に窓を開いておく
function openDrive(file) {
  const w = window.open("", "_blank");
  blobUrl(suppIds[file]).then((u) => { w.location.href = u; }, () => { w.close(); alert("補足資料を読めません"); });
}
function paintParas() { document.querySelectorAll("article p[id], article .tbl[id], article .supp[id]").forEach(paintPara); markCurrentRefs(); }
function tableHtml(t, ja) {
  const title = ja ? t.title_ja || t.title_en : t.title_en;
  const cap = ja ? t.caption_ja || t.caption_en : t.caption_en;
  const body = t.html ? (ja ? t.html_ja : t.html) : t.src ? `<img alt="" src="${t.src}">` : "";
  return `<div class="t"><b>${t.label}</b> ${title || ""}</div>${body}` + (cap || "").split("\n").map((p) => p && `<p>${p}</p>`).join("");
}

function showRef(id) {
  const r = P.refs.find((x) => x.id === id);
  if (!r) return;
  const pop = $("#pop");
  pop.innerHTML = esc(r.text) + (r.doi ? ` <a href="https://doi.org/${esc(r.doi)}" target="_blank">DOI</a>` : "");
  pop.hidden = false;
}

// ---------- 図 ----------
const KINDS = [["all", "全て"], ["main", "本図"], ["supp", "補足"], ["video", "動画"], ["table", "表"]];
function renderTabs() {
  const box = $("#figtabs");
  for (const [k, name] of KINDS) {
    if (k !== "all" && !figs.some((f) => f.kind === k)) continue;
    const b = document.createElement("button");
    b.textContent = name; b.dataset.k = k;
    b.onclick = () => setFilter(k);
    box.appendChild(b);
  }
}
function setFilter(k, keepId) {
  filter = k;
  list = figs.filter((f) => k === "all" || f.kind === k);
  document.querySelectorAll("#figtabs button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
  const i = keepId ? list.findIndex((f) => f.id === keepId) : 0;
  show(Math.max(i, 0));
}
function showFigById(id, byUser) {
  // 本文が参照する id が補足図などで、今の絞り込みに無ければ「全て」に戻す
  if (!list.some((f) => f.id === id)) {
    if (!figs.some((f) => f.id === id)) return;
    setFilter("all", id);
  } else show(list.findIndex((f) => f.id === id));
  if (byUser && isPortrait()) {
    const h = $("#figpane").getBoundingClientRect().height;
    if (h < 120) setFigSize(window.innerHeight * 0.42);
  }
}
function show(i) {
  if (!list.length) return;
  const next = (i + list.length) % list.length;
  if (next === cur && $("#zoom").dataset.id === list[next].id) return;
  cur = next;
  const f = list[cur];
  const z = $("#zoom");
  z.dataset.id = f.id;
  resetZoom();
  // 表は縦に長いので、拡大縮小の代わりにスクロールで読み、＋−で文字の大きさを変える（中身は paintCap で言語に合わせて入れる）
  z.innerHTML = f.kind === "table" && f.html ? `<div class="tblview"></div>` : f.kind === "video" && f.vsrc
    ? `<video controls playsinline preload="metadata" src="${f.vsrc}" ${f.src ? `poster="${f.src}"` : ""}></video>`
    : f.src ? `<img alt="" src="${f.src}">` : `<p style="padding:1em">画像がありません</p>`;
  $("#fig-label").textContent = `${shortLabel(f.label)}（${cur + 1}/${list.length}）`;
  $("#fig-label").title = f.label + "（図の一覧：g）";
  paintCap();
  markCurrentRefs();
  refCursor = -1;
}
function paintCap() {
  const f = list[cur];
  if (!f) return;
  const useJa = (lang === "ja") !== capFlipped;  // 説明の無い図・表でも題名は訳を出す
  const title = useJa ? f.title_ja || f.title_en : f.title_en;
  const cap = useJa ? f.caption_ja || f.caption_en : f.caption_en;
  $("#cap").innerHTML = `<div class="t">${f.label}. ${title || ""}</div>` + (cap || "").split("\n").map((p) => `<p>${p}</p>`).join("");
  const tv = $("#zoom .tblview");
  if (tv) tv.innerHTML = (lang === "ja") !== capFlipped && f.html_ja ? f.html_ja : f.html;
}
let capFlipped = false;
// 「Figure 2—figure supplement 2」のような長い名前は図の欄では短くする（一覧と説明には正式な名前を出す）
function shortLabel(s) {
  return s.replace(/^Figure (\d+)\s*[—–-]\s*figure supplement (\d+)/i, "Fig. $1–S$2")
    .replace(/^Figure /i, "Fig. ").replace(/^Extended Data Fig(ure)?\.? /i, "ED Fig. ").replace(/^Supplementary Fig(ure)?\.? /i, "Supp. Fig. ");
}

// 図の一覧：本図は行の先頭から始め、その補足図・動画が続くように並べる
function toggleMenu(open) {
  const m = $("#figmenu");
  open = open === undefined ? m.hidden : open;
  if (!open) { m.hidden = true; return; }
  const id = list[cur] && list[cur].id;
  m.innerHTML = `<div class="head"><span>図の一覧（${figs.length}）</span><button data-close>×</button></div><div class="grid">` +
    figs.map((f) => `<button class="it ${f.kind}${f.id === id ? " cur" : ""}" data-id="${f.id}">
      ${f.src ? `<img loading="lazy" alt="" src="${f.src}">` : `<div class="noimg">${f.kind === "table" ? "表" : "画像なし"}</div>`}
      <span class="l">${f.kind === "video" ? "▶ " : ""}${esc(shortLabel(f.label))}</span><span class="d">${f.title_ja || f.title_en || ""}</span></button>`).join("") + "</div>";
  m.hidden = false;
  const c = m.querySelector(".it.cur");
  if (c) scrollInto(m, c, true);
}
function markCurrentRefs() {
  const id = list[cur] && list[cur].id;
  document.querySelectorAll("article a.fig").forEach((a) => a.classList.toggle("cur", a.dataset.fig === id));
}

// この図に言及している段落へ順に移動する
let refCursor = -1;
function gotoMention() {
  const id = list[cur].id;
  const ps = [...document.querySelectorAll("article p[data-figs]")].filter((p) => p.dataset.figs.split(" ").includes(id));
  if (!ps.length) return;
  refCursor = (refCursor + 1) % ps.length;
  const p = ps[refCursor];
  const wasFollow = follow;
  follow = false;  // 移動中に自動追従で別の図へ切り替わらないようにする
  scrollInto($("#text"), p, true);
  setTimeout(() => { follow = wasFollow; }, 800);
  p.classList.add("flash");
  setTimeout(() => p.classList.remove("flash"), 1200);
}

// ---------- 拡大縮小（ピンチ・ホイール・ダブルタップ・スワイプ） ----------
let zs = 1, zx = 0, zy = 0;
function applyZoom() {
  const r = $("#stage").getBoundingClientRect();
  if (zs <= 1.001) { zs = 1; zx = 0; zy = 0; }
  // 画像が枠の外へ逃げ切らないよう、はみ出し分の範囲に収める
  zx = Math.min(0, Math.max(r.width * (1 - zs), zx));
  zy = Math.min(0, Math.max(r.height * (1 - zs), zy));
  $("#zoom").style.transform = `translate(${zx}px, ${zy}px) scale(${zs})`;
}
function zoomAt(ns, px, py) {
  ns = Math.min(8, Math.max(1, ns));
  zx = px - (px - zx) * (ns / zs);
  zy = py - (py - zy) * (ns / zs);
  zs = ns;
  applyZoom();
}
let tblFont = 13;
const isTextTable = (f) => f && f.kind === "table" && f.html;  // bioRxiv の表は画像なので、図と同じく拡大縮小する
const isNative = () => list[cur] && (list[cur].kind === "video" || isTextTable(list[cur]));  // 自前の拡大縮小を使わない種類
function setTblFont(v) { tblFont = Math.min(32, Math.max(8, v)); const tv = $("#zoom .tblview"); if (tv) tv.style.fontSize = tblFont + "px"; }
function resetZoom() { zs = 1; applyZoom(); setTblFont(13); }
function zoomCenter(k) {
  if (isTextTable(list[cur])) return setTblFont(tblFont * k);
  const r = $("#stage").getBoundingClientRect(); zoomAt(zs * k, r.width / 2, r.height / 2);
}

function setupZoom() {
  const st = $("#stage");
  const pts = new Map();
  let pinch = null, start = null, lastTap = 0;
  const local = (e) => { const r = st.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  st.addEventListener("pointerdown", (e) => {
    if (isNative()) return;
    st.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) start = { p: local(e), t: Date.now(), x: zx, y: zy };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: zs, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], x: zx, y: zy };
    }
  });
  st.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ns = Math.min(8, Math.max(1, pinch.s * d / pinch.d));
      zx = m[0] - (pinch.m[0] - pinch.x) * (ns / pinch.s);
      zy = m[1] - (pinch.m[1] - pinch.y) * (ns / pinch.s);
      zs = ns;
      applyZoom();
    } else if (pts.size === 1 && start && zs > 1) {
      const p = local(e);
      zx = start.x + p[0] - start.p[0];
      zy = start.y + p[1] - start.p[1];
      applyZoom();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size || !start) return;
    const dx = p[0] - start.p[0], dy = p[1] - start.p[1], dt = Date.now() - start.t;
    if (zs === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600) show(cur + (dx < 0 ? 1 : -1));
    else if (Math.hypot(dx, dy) < 10 && dt < 300) {
      if (Date.now() - lastTap < 320) { zs > 1 ? resetZoom() : zoomAt(2.5, p[0], p[1]); lastTap = 0; }
      else lastTap = Date.now();
    }
    start = null;
  };
  st.addEventListener("pointerup", end);
  st.addEventListener("pointercancel", end);
  // Mac のトラックパッドのピンチは ctrlKey 付きの wheel として届く。普通の2本指スクロールは拡大中だけ移動に使う
  st.addEventListener("wheel", (e) => {
    if (isNative()) return;
    e.preventDefault();
    const [px, py] = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(zs * Math.exp(-e.deltaY * 0.01), px, py);
    else if (zs > 1) { zx -= e.deltaX; zy -= e.deltaY; applyZoom(); }
  }, { passive: false });
  new ResizeObserver(applyZoom).observe(st);
}

// ---------- 境目のドラッグ、ボタン、キー ----------
function setFigSize(v) {
  const root = document.documentElement.style;
  if (isPortrait()) {
    const h = Math.min(window.innerHeight * 0.8, Math.max(0, v));
    root.setProperty("--fig-h", h + "px"); store.set("figh", h);
  } else {
    const w = Math.min(window.innerWidth * 0.75, Math.max(window.innerWidth * 0.2, v));
    root.setProperty("--fig-w", w + "px"); store.set("figw", w);
  }
}
function restoreLayout() {
  const w = store.get("figw", null), h = store.get("figh", null);
  if (w) document.documentElement.style.setProperty("--fig-w", w + "px");
  if (h !== null) document.documentElement.style.setProperty("--fig-h", h + "px");
  if (store.get("toc", false) && !isPortrait()) document.body.classList.add("toc-open");
}
function setupSplit() {
  const sp = $("#split");
  let on = false;
  sp.addEventListener("pointerdown", (e) => { on = true; sp.setPointerCapture(e.pointerId); });
  sp.addEventListener("pointermove", (e) => {
    if (!on) return;
    setFigSize(isPortrait() ? e.clientY - $("#app").getBoundingClientRect().top : window.innerWidth - e.clientX);
  });
  sp.addEventListener("pointerup", () => { on = false; });
  sp.addEventListener("dblclick", () => setFigSize(isPortrait() ? window.innerHeight * 0.42 : window.innerWidth * 0.46));
}
function setupControls() {
  const setLang = () => { $("#btn-lang").textContent = lang === "ja" ? "訳" : "原"; $("#btn-lang").classList.toggle("on", lang === "ja"); };
  const setFollow = () => $("#btn-follow").classList.toggle("on", follow);
  setLang(); setFollow();
  $("#btn-lang").onclick = () => { lang = lang === "ja" ? "en" : "ja"; flipped.clear(); capFlipped = false; store.set("lang", lang); setLang(); paintParas(); paintCap(); };
  $("#btn-follow").onclick = () => { follow = !follow; store.set("follow", follow); setFollow(); };
  $("#btn-toc").onclick = () => { document.body.classList.toggle("toc-open"); store.set("toc", document.body.classList.contains("toc-open")); };
  $("#fig-prev").onclick = () => show(cur - 1);
  $("#fig-next").onclick = () => show(cur + 1);
  $("#fig-in").onclick = () => zoomCenter(1.5);
  $("#fig-out").onclick = () => zoomCenter(1 / 1.5);
  $("#fig-ref").onclick = gotoMention;
  $("#fig-label").onclick = () => toggleMenu();
  $("#figmenu").onclick = (e) => {
    if (e.target.closest("[data-close]")) return toggleMenu(false);
    const it = e.target.closest(".it");
    if (it) { toggleMenu(false); showFigById(it.dataset.id, true); }
  };
  $("#fig-full").onclick = () => { document.body.classList.toggle("figfull"); };
  $("#cap").onclick = (e) => { if (e.target.closest("a") || String(getSelection())) return; capFlipped = !capFlipped; paintCap(); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#pop, a.cite")) $("#pop").hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "ArrowRight") show(cur + 1);
    else if (e.key === "ArrowLeft") show(cur - 1);
    else if (e.key === "+" || e.key === "=") zoomCenter(1.5);
    else if (e.key === "-") zoomCenter(1 / 1.5);
    else if (e.key === "0") resetZoom();
    else if (e.key === "f") document.body.classList.toggle("figfull");
    else if (e.key === "g") toggleMenu();
    else if (e.key === "Escape") { toggleMenu(false); document.body.classList.remove("figfull"); $("#pop").hidden = true; }
  });
}

main();
