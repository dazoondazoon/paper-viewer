"use strict";
const $ = (s) => document.querySelector(s);
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
let token = null, viewerDir = null;
try { const t = JSON.parse(sessionStorage.getItem("token")); if (t && t.exp > Date.now()) token = t.v; } catch { /* 無ければログインし直す */ }

let loggingIn = null;
function login() {
  // 図の読み込みの途中でトークンが切れても本文を消さないよう、本文の上に重ねて出す。同時に何件切れても窓は1つ
  return loggingIn || (loggingIn = new Promise((ok, ng) => {
    const box = document.createElement("div");
    box.className = "login";
    box.innerHTML = `<div><p>Drive の論文を読むには、Papers のある Google アカウントでログインしてください。</p><button>Google でログイン</button></div>`;
    document.body.appendChild(box);
    // iPhone ではログインの窓はタップからしか開けないので、トークンが切れたときもボタンを押してもらう
    box.querySelector("button").onclick = () => google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: "https://www.googleapis.com/auth/drive.readonly",
      callback: (r) => {
        box.remove(); loggingIn = null;
        if (r.error) return ng(new Error("ログインできません：" + r.error));
        token = r.access_token;
        try { sessionStorage.setItem("token", JSON.stringify({ v: token, exp: Date.now() + (r.expires_in - 60) * 1000 })); } catch { /* 次のページでもう一度ログイン */ }
        ok();
      },
    }).requestAccessToken();
  }));
}

async function drive(url) {
  if (!token) await login();
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 401) {  // 1時間でトークンが切れた
    token = null;
    try { sessionStorage.removeItem("token"); } catch { /* 無視 */ }
    return drive(url);
  }
  if (!r.ok) throw new Error(`Drive API ${r.status}：${await r.text()}`);
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
const blobs = new Map(), sizes = {};
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
  // 図（動画は表紙だけ）は、読み進めて出るのを待たずに論文の順にすべて取る。同時は3本までにして、いま図の欄に出す1枚の取得が後ろで待たされないようにする
  const queue = figs.filter((f) => f.src).map((f) => f.src.slice(DRIVE_SRC.length));
  const worker = async () => { while (queue.length) await blobUrl(queue.shift()).catch(() => {}); };
  for (let i = 0; i < 3; i++) worker();
}

let P, figs = [], list = [], cur = 0, filter = "all";
let lang = store.get("lang", "ja"), follow = store.get("follow", true);
const flipped = new Set();

async function main() {
  try {
    if (ON_DRIVE) await loadScript("https://accounts.google.com/gsi/client");
    if (!paperId) return renderLibrary((await load(null, "library.js", "LIBRARY")).data || []);
    const { parent, data } = await load(paperId, "paper_data.js", "PAPER_DATA");
    P = data;
    figs = P.figures;
    if (ON_DRIVE) await driveFigs(parent);
    else {
      const base = encodeURIComponent(paperId) + "/";
      figs.forEach((f) => { if (f.img) f.src = base + f.img; if (f.video) f.vsrc = base + f.video; });
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
  requestAnimationFrame(() => { $("#text").scrollTop = pos; });
}

function strip(h) { const d = document.createElement("div"); d.innerHTML = h; return d.textContent; }

// ---------- 論文一覧 ----------
function renderLibrary(items) {
  document.body.classList.add("lib");
  $("#bar-title").textContent = `論文一覧（${items.length} 本）`;
  const box = document.createElement("div");
  box.className = "library";
  for (const it of items) {
    const a = document.createElement("a");
    a.className = "item"; a.href = "?p=" + encodeURIComponent(it.id);
    a.innerHTML = `<div class="t">${it.title_ja || it.title_en}</div>
      <div class="s">${it.authors.join(", ")} — ${it.journal} ${it.year} ・ 図 ${it.n_figs} ・ 翻訳 ${Math.round(it.translated * 100)}%</div>`;
    box.appendChild(a);
  }
  $("#text").appendChild(box);
}

// ---------- 本文 ----------
function renderText() {
  const art = document.createElement("article");
  const m = P.meta;
  art.innerHTML = `<h1>${m.title_ja || m.title_en}</h1>
    <div class="meta">${m.title_ja ? m.title_en + "<br>" : ""}${m.authors.join(", ")}<br>
    ${m.journal} ${m.year} ・ <a href="https://doi.org/${m.doi}" target="_blank">doi:${m.doi}</a></div>`;
  const toc = $("#toc");
  for (const b of P.blocks) {
    let el;
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
    }
    el.id = b.id;
    art.appendChild(el);
  }
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
    if (e.target.closest("a")) return;
    const p = e.target.closest("p[id], .tbl[id]");
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

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

const blockById = () => P._byId || (P._byId = Object.fromEntries(P.blocks.map((b) => [b.id, b])));
const figById = (id) => figs.find((f) => f.id === id);
function paintPara(p) {
  const b = blockById()[p.id];
  const t = b.type === "table" ? figById(b.fig) : null;
  let want = flipped.has(p.id) ? (lang === "ja" ? "en" : "ja") : lang;
  const untranslated = want === "ja" && !(t ? (t.html ? t.html_ja : t.title_ja || !t.title_en) : b.ja);  // 画像の表は題名だけが訳の対象
  if (untranslated) want = "en";
  p.innerHTML = t ? tableHtml(t, want === "ja") : want === "ja" ? b.ja : b.en;
  p.classList.toggle("en-shown", want === "en");
  p.classList.toggle("untranslated", untranslated && lang === "ja");
}
function paintParas() { document.querySelectorAll("article p[id], article .tbl[id]").forEach(paintPara); markCurrentRefs(); }
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
