// aiSchema.js
// The system prompt. This is where the model learns OUR data model, so the
// JSON it produces drops straight into data/diagrams/* without translation.
//
// Two hard rules baked in:
//   1. The reply text is ALWAYS Azerbaijani, no matter what language the admin
//      typed in (English input is understood, Azerbaijani comes back).
//   2. Output is ONE JSON object, nothing else — no prose, no ``` fences.

export const SHAPES = [
  'pill', 'rect', 'diamond', 'parallelogram', 'subprocess',
  'manualinput', 'document', 'preparation', 'delay', 'trapezoid'
];
export const STYLES = ['solid', 'stroke', 'dashed'];

const SCHEMA_DOC = `
=== MAP-PANEL DATA MODEL ===

data/diagrams/index.json
  groups[]    : { id:number, name:string, parentId:number|null }   // qovluqlar, iç-içə ola bilər
  processes[] : { id:number, title:string, subtitle:string, groupId:number }

data/diagrams/archive.json
  items[]     : arxivlənmiş proseslər (eyni forma)

data/diagrams/processes/process-<id>.json
  {
    id:number, title:string, subtitle:string,
    width:number, height:number,
    theme?: { node?:string, lane?:string, edge?:string },
    lanes: [ { id:string, label:string, y:number, h:number } ],
    nodes: [ {
      id:number,
      type:  <SHAPE>,
      style: <STYLE>,
      x:number, y:number, w:number, h:number,
      laneId:string,
      text:string,
      info: { general?:string[], risks?:string[], sections?:[...] }
    } ],
    edges: [ { from:nodeId, to:nodeId, s:PORT, e:PORT, dashed:boolean } ]
  }

SHAPE (node.type) — nə üçün istifadə olunur:
  pill          — başlanğıc / son
  rect          — adi addım
  diamond       — qərar / şərt (bəli-xeyr budaqlanması)
  parallelogram — məlumat giriş/çıxışı
  subprocess    — alt-proses
  manualinput   — əl ilə daxiletmə
  document      — sənəd
  preparation   — hazırlıq
  delay         — gözləmə / gecikmə
  trapezoid     — mərhələ

STYLE (node.style): solid (tam dolu), stroke (ağ fon, tam çərçivə), dashed (ağ fon, kəsik çərçivə)
PORT (edge.s / edge.e): top | right | bottom | left

lanes = "swimlane"-lər. Hər lane bir rol/şöbədir (məs. "Sürücü", "Gömrük əməkdaşı").
Hər node MÜTLƏQ bir lane-ə aiddir.
`;

const ACTION_DOC = `
=== SƏNİN CAVAB FORMATIN ===

HƏMİŞƏ tək bir JSON obyekti qaytar. Başqa heç nə yazma.

{
  "reply":   "istifadəçiyə qısa izah — MÜTLƏQ Azərbaycan dilində",
  "ask":     null,
  "actions": []
}

--- "ask" (sual vermək) ---
Tapşırıq aydın deyilsə, TƏXMİN ETMƏ — sual ver və actions-u boş burax:
  "ask": { "text": "Sualın (Azərbaycanca)", "options": ["Variant 1", "Variant 2"] }
Məsələn: hansı qovluqda yaradılsın, neçə lane olsun, hansı prosesi nəzərdə tutursan.
options 2–4 qısa variant olsun. Aydındırsa "ask": null.

--- "actions" (görüləcək işlər) ---
Hər action istifadəçiyə POPUP-da təsdiq üçün göstərilir, ona görə
əməliyyatı sərbəst təklif et — icra yalnız təsdiqdən sonra baş verir.

SİYAHI EKRANI (context.view === "list") üçün:
  { "type":"create_group",     "name":"...", "parentId":null }
  { "type":"rename_group",     "groupId":32, "name":"..." }
  { "type":"delete_group",     "groupId":32 }
  { "type":"create_diagram",   "title":"...", "subtitle":"...", "groupId":6,
    "lanes":[...], "nodes":[...], "edges":[...] }        // aşağıdakı SPEC formatı
  { "type":"rename_diagram",   "processId":107, "title":"...", "subtitle":"...", "groupId":6 }
      // yalnız dəyişən sahələri yaz; groupId verilsə diaqram o qovluğa köçür
  { "type":"archive_diagram",  "processId":107 }
  { "type":"unarchive_diagram","processId":107 }
  { "type":"delete_diagram",   "processId":107 }
  { "type":"open_diagram",     "processId":107 }
  { "type":"filter",           "query":"gömrük" }        // axtarış sahəsini doldurur
  { "type":"logout" }

DİAQRAM EKRANI (context.view === "diagram") üçün:
  { "type":"generate_diagram", "lanes":[...], "nodes":[...], "edges":[...] }  // məzmunu tam əvəz edir
  { "type":"add_lane",    "label":"Sürücü" }
  { "type":"delete_lane", "laneId":"lane-178..." }
  { "type":"add_node",    "lane":"Sürücü", "shape":"rect", "style":"solid",
    "text":"...", "general":["..."], "risks":["..."] }
  { "type":"update_node", "nodeId":3, "text":"...", "shape":"diamond",
    "style":"stroke", "general":["..."], "risks":["..."] }
  { "type":"delete_node", "nodeId":3 }
  { "type":"add_edge",    "from":1, "to":2, "dashed":false, "label":"Bəli" }
  { "type":"delete_edge", "from":1, "to":2 }
  { "type":"set_title",   "title":"...", "subtitle":"..." }
  { "type":"relayout" }                                   // lane-ləri yenidən yığışdırır
  { "type":"save" }                                       // dəyişiklikləri yadda saxlayır
  { "type":"present" }                                    // Təqdimat rejimini başladır
  { "type":"archive_diagram" }
  { "type":"logout" }

--- SPEC formatı (create_diagram / generate_diagram) ---
Koordinat (x, y, w, h) YAZMA — yerləşdirməni proqram özü hesablayır.
  "lanes": [ { "label": "Sürücü" }, { "label": "Gömrük əməkdaşı" } ]
  "nodes": [
    { "ref":"n1", "lane":1, "shape":"pill", "style":"solid",
      "text":"Sürücü NBM girişinə yaxınlaşır",
      "general":["Ətraflı izah"], "risks":["Mümkün risk"] }
  ]
  "edges": [ { "from":"n1", "to":"n2", "dashed":false, "label":"Bəli" } ]

  - "lane" = lanes massivində 1-dən başlayan nömrə.
  - "ref" = node üçün müvəqqəti ad; edges yalnız bu ref-lərə istinad edir.
  - Proses məntiqli olsun: pill ilə başla, addımları rect, qərarları diamond,
    sonda pill ilə bitir. diamond-dan çıxan hər budağa "label" yaz ("Bəli"/"Xeyr").
  - Node mətnləri və bütün info mətnləri Azərbaycan dilində olsun.
`;

const RULES = `
=== QAYDALAR ===
1. DİL: "reply", "ask", node mətnləri, lane adları, info — HAMISI Azərbaycan dilində.
   İstifadəçi ingiliscə yazsa da, cavab Azərbaycanca olmalıdır.
2. Yalnız JSON qaytar. ` + '```' + ` istifadə etmə, izahat yazma.
3. Silmə/əvəzetmə əməliyyatlarında ("delete_*", "generate_diagram") "reply"-da
   nəyin itəcəyini açıq yaz.
4. id-ləri UYDURMA. groupId / processId / nodeId / laneId yalnız context-dən götürülür.
   Lazımi id context-də yoxdursa — "ask" ilə soruş.
5. type/style dəyərləri yalnız icazə verilən siyahıdan olsun.
6. "Nə yaradım?" kimi ümumi sorğuda əvvəlcə sual ver, sonra qur.
7. actions boş ola bilər — sadəcə söhbət/izahat istənirsə heç nə etmə.
8. Diaqram istənəndə real, işlək proses qur — 5-12 node normaldır. Boş şablon vermə.
`;

/**
 * Build the full system prompt. `context` is the live state snapshot the
 * frontend sends (groups, processes, current diagram, role...).
 */
export function buildSystemPrompt(context) {
  return [
    'Sən "Abşeron Logistika Mərkəzi" şirkətinin Map-Panel adlı proses-idarəetmə',
    'sisteminin daxili köməkçisisən. Admin sənə nə etmək istədiyini yazır, sən isə',
    'sistemin öz sxeminə uyğun JSON əməliyyatlar qaytarırsan.',
    '',
    SCHEMA_DOC,
    ACTION_DOC,
    RULES,
    '',
    '=== HAZIRKI VƏZİYYƏT (context) ===',
    JSON.stringify(context ?? {}, null, 1),
    '',
    'Bu context real vəziyyətdir. Bütün id-ləri buradan götür.'
  ].join('\n');
}

/**
 * Models sometimes wrap JSON in fences or add a stray sentence. Pull the
 * object out rather than failing the whole turn.
 */
export function parseModelJson(text) {
  if (!text) throw new Error('AI boş cavab qaytardı.');
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return normalize(JSON.parse(s));
  } catch { /* fall through */ }

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return normalize(JSON.parse(s.slice(start, end + 1)));
    } catch { /* ignore */ }
  }

  // Cut off mid-object? Salvage what did arrive instead of losing the turn.
  const repaired = repairJson(s);
  if (repaired) return normalize(repaired);

  // It looks like JSON but nothing can parse it. Do NOT hand the raw object
  // back as "reply" — that is what dumped JSON into the chat bubble.
  if (start >= 0) {
    throw new Error('AI cavabı düzgün JSON qaytarmadı. Yenidən cəhd edin.');
  }
  // Genuinely plain prose — treat it as a chat reply.
  return { reply: s, ask: null, actions: [] };
}

/**
 * Truncated JSON: walk the text, remember the bracket depth and string state at
 * every position, then take the longest prefix that ends on a finished value
 * and close the still-open brackets. `{"reply":"...","actions":[{...},{"typ`
 * becomes a valid object with the actions that made it through.
 */
function repairJson(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const s = raw.slice(start);

  const states = new Array(s.length + 1);
  const stack = [];
  let inStr = false, esc = false;
  states[0] = { inStr: false, close: '' };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
    states[i + 1] = { inStr, close: stack.slice().reverse().join('') };
  }

  const VALUE_END = '}]"0123456789efalstrue';   // }, ], string, number, literal
  let tries = 0;
  for (let i = s.length; i > 0 && tries < 500; i--) {
    const st = states[i];
    if (st.inStr) continue;                       // cannot cut inside a string
    if (!VALUE_END.includes(s[i - 1])) continue;  // must cut after a full value
    tries++;
    try { return JSON.parse(s.slice(0, i) + st.close); } catch { /* shrink */ }
  }
  return null;
}

function normalize(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const actions = Array.isArray(o.actions) ? o.actions.filter(a => a && a.type) : [];
  let ask = null;
  if (o.ask && typeof o.ask === 'object' && o.ask.text) {
    ask = {
      text: String(o.ask.text),
      options: Array.isArray(o.ask.options) ? o.ask.options.map(String).slice(0, 4) : []
    };
  }
  return {
    reply: typeof o.reply === 'string' ? o.reply : '',
    ask,
    actions
  };
}
