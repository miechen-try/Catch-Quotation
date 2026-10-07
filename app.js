/* PDF 維修單自動判讀工具
 *
 * 主要判讀：
 * 1. 聯絡人／門市名稱
 * 2. SR單號
 * 3. 機器型號／報修設備
 * 4. 序號／設備序號
 * 5. 客戶維修單號
 * 6. 故障現象／故障原因
 * 7. 檢測說明／廠商檢測回覆
 * 8. 收費方式
 * 9. 料號
 * 10. 品名
 * 11. 數量
 * 12. 單價／未稅報價
 *
 * PDF.js：文字型 PDF 直接擷取。
 * Tesseract.js：若文字太少，對 PDF 頁面做 OCR。
 */

const FIELD_DEFS = [
  { key: "caseNumber", label: "案件編號", type: "input" },
  { key: "srNumber", label: "SR單號", type: "input" },
  { key: "fillDate", label: "填寫日期", type: "input" },
  { key: "contact", label: "門市名稱", type: "input" },
  { key: "model", label: "報修設備", type: "textarea" },
  { key: "serial", label: "設備序號", type: "textarea" },
  { key: "problem", label: "故障原因", type: "textarea" },
  { key: "inspection", label: "廠商檢測回覆", type: "textarea" },
  { key: "feeType", label: "收費方式", type: "input" },
  { key: "partNumbers", label: "更換零件料號", type: "textarea" },
  { key: "products", label: "更換零件品名", type: "textarea" },
  { key: "quantities", label: "更換零件數量", type: "textarea" },
  { key: "unitPrices", label: "未稅報價", type: "textarea" },
];

const state = {
  pdfjs: null,
  files: [],
  currentIndex: 0,
  pdfDoc: null,
  currentPage: 1,
  currentFile: null,
  fields: emptyFields(),
  rawText: "",
  layout: null,
  ocrUsed: false,
  originalFields: emptyFields(),
  modifiedKeys: new Set(),
  updated: false
};

function emptyFields() {
  return {
    contact: "",
    caseNumber: "",
    srNumber: "",
    fillDate: "",
    model: "",
    serial: "",
    problem: "",
    inspection: "",
    feeType: "耗材收費",
    partNumbers: "",
    products: "",
    quantities: "",
    unitPrices: ""
  };
}

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function setStatus(text) {
  $("statusPill").textContent = text;
}

function normalizeText(text) {
  let normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // PDF 可能把欄位標題拆成「聯 絡 人」，
  // 只針對已知標題還原，不要把所有中文字中間的空白都刪掉。
  const headers = [
    [/聯\s*絡\s*人/g, "聯絡人"],
    [/報\s*價\s*日\s*期/g, "報價日期"],
    [/統\s*一\s*編\s*號/g, "統一編號"],
    [/公\s*司\s*地\s*址/g, "公司地址"],
    [/承\s*辦\s*人\s*員/g, "承辦人員"],
    [/公\s*司\s*電\s*話/g, "公司電話"],
    [/SR\s*單\s*號/g, "SR單號"],
    [/客\s*戶\s*維\s*修\s*單\s*號/g, "客戶維修單號"],
    [/機\s*器\s*品\s*號/g, "機器品號"],
    [/序\s*號/g, "序號"],
    [/故\s*障\s*現\s*象/g, "故障現象"],
    [/檢\s*測\s*說\s*明/g, "檢測說明"]
  ];

  for (const [pattern, replacement] of headers) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized;
}

function cleanValue(value) {
  if (!value) return "";
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function cleanSingleLine(value) {
  if (!value) return "";

  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r?\n/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}
function cleanIssueText(value, serial = "") {
  if (!value) return "";

  let result = value
    .replace(/\u00a0/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  // PDF 換行可能把序號殘留到檢測說明中，先移除。
  if (serial) {
    result = result.replace(new RegExp(escapeRegExp(serial), "gi"), "");
  }

  // 中文句子因 PDF 換行產生的空白要合併，例如「無 法」→「無法」。
  result = result.replace(/([\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, "$1");

  return result.replace(/[ \t]+/g, " ").trim();
}
function cleanProductName(value) {
  if (!value) return "";

  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r?\n/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/_+\s*$/g, "")
    .trim();
}
function formatUploadDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

const MODEL_SHEET_MAP = {
  "MS838": "有線掃碼槍MS838",
  "MS842": "無線掃瑪槍MS842P",
  "MS852": "無線掃碼槍MS852P",
  "RP-700": "熱感應機RP-700",
  "Sewoo": "熱感應機Sewoo",
  "SBarco": "標籤機SBarco",
  "SBarco(含裁刀)": "標籤機SBarco(含裁刀)",
  "ZD230": "標籤機ZD230",
  "PA760": "PDA(PA760)",
  "PA768": "PDA(PA768)",
  "PA760槍把": "PDA槍把(PA760)",
  "PA768槍把": "PDA槍把(PA768)",
  "DA210": "藍芽標籤機DA210",
  "TSC ALPHA-40L": "攜帶式藍芽標籤機TSC ALPHA-40L"
};

function getSheetModel(model) {
  const raw = String(model || "").trim();
  if (MODEL_SHEET_MAP[raw]) return MODEL_SHEET_MAP[raw];

  // 容許 PDF 中多一點空白或大小寫差異。
  const normalized = raw.replace(/\s+/g, " ");
  const key = Object.keys(MODEL_SHEET_MAP).find(k =>
    k.toLowerCase() === normalized.toLowerCase()
  );
  return key ? MODEL_SHEET_MAP[key] : raw;
}

function joinForSheet(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .join("、");
}

function buildQuotationFileName() {
  const f = getEditedFields();

  const contact = (f.contact || "").trim();
  const model = (f.model || "").trim();
  const srNumber = (f.srNumber || "").trim();

  if (!contact && !model && !srNumber) return "";

  // 複製／顯示的檔名只回傳「檔名本體」，不包含 .pdf。
  // 實際 PDF 檔案本身仍保留原本的 .pdf 副檔名。
  const sheetModel = getSheetModel(model);

  const baseName = [
    contact,
    sheetModel && srNumber ? `${sheetModel}-${srNumber}` : sheetModel || srNumber
  ]
    .filter(Boolean)
    .join("_");

  return baseName || "";
}

function buildGoogleSheetRows() {
  const f = getEditedFields();

  // Google Sheet 從 C 欄開始：
  // C SR單號
  // D 填寫日期
  // E 保留空白
  // F 門市名稱
  // G 報修設備
  // H 設備序號
  // I 故障原因
  // J 廠商檢測回覆
  // K 收費方式（預設：耗材收費）
  // L 更換零件料號
  // M 更換零件品名
  // N 更換零件數量
  // O 未稅報價
  //
  // 每一個零件各自一列；共同欄位會在每一列重複。

  const splitRows = (value) => String(value || "")
    .split(/\r?\n/)
    .map(x => x.trim());

  const parts = splitRows(f.partNumbers).filter(Boolean);
  const names = splitRows(f.products).filter(Boolean);
  const quantities = splitRows(f.quantities).filter(Boolean);
  const prices = splitRows(f.unitPrices).filter(Boolean);
  const models = splitRows(f.model);
  const serials = splitRows(f.serial);
  const problems = splitRows(f.problem);
  const inspections = splitRows(f.inspection);

  const rowCount = Math.max(
    parts.length, names.length, quantities.length, prices.length,
    models.length, serials.length, problems.length, inspections.length, 1
  );
  const rows = [];

  for (let i = 0; i < rowCount; i++) {
    const row = [
      f.caseNumber,
      f.srNumber,
      f.fillDate,
      "",
      f.contact,
      getSheetModel(models[i] || models[0] || ""),
      serials[i] || serials[0] || "",
      problems[i] || problems[0] || "",
      inspections[i] || inspections[0] || "",
      f.feeType || "耗材收費",
      parts[i] || "",
      names[i] || "",
      quantities[i] || "",
      prices[i] || ""
    ];

    rows.push(
      row
        .map(value => String(value ?? "")
          .replace(/\t/g, " ")
          .replace(/\r?\n/g, " "))
        .join("\t")
    );
  }

  return rows;
}

function buildGoogleSheetPreview() {
  return buildGoogleSheetRows().join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) return cleanValue(m[1]);
  }
  return "";
}

/* 以欄位標題為起點，抓到下一個指定標題以前。 */
function sectionBetween(text, starts, ends) {
  const startPattern = starts.map(escapeRegExp).join("|");
  const endPattern = ends.map(escapeRegExp).join("|");

  const re = new RegExp(
    "(?:" + startPattern + ")\\s*[:：]?\\s*([\\s\\S]*?)(?=(?:" + endPattern + ")|$)",
    "i"
  );

  const m = text.match(re);
  return cleanValue(m?.[1] || "");
}

function isLikelyStoreName(value) {
  const v = cleanSingleLine(value);
  if (!v) return false;

  // 明顯是地址、電話、公司/人員資訊時，不當作門市名稱。
  if (/[縣市區鄉鎮路街巷弄號樓室段村里鄰|市話|電話]/.test(v)) return false;
  if (/(?:先生|小姐|女士|先生小姐|聯絡人|承辦|收件人)/.test(v)) return false;
  if (/(?:@|\b09\d{8}\b|\b0\d{1,2}-\d{6,8}\b)/.test(v)) return false;
  if (/\b\d{3,}\b/.test(v) && !/智取店|門市|店/.test(v)) return false;

  // 純 2~4 個中文字、沒有店家關鍵字，通常是人名；避免把它帶進判讀結果。
  const compact = v.replace(/[\s·•・]/g, '');
  if (/^[\u3400-\u4dbf\u4e00-\u9fff]{2,4}$/.test(compact) && !/(?:店|門市|分店|據點|智取)/.test(compact)) {
    return false;
  }

  return true;
}

function sanitizeContact(value) {
  const v = cleanSingleLine(value);
  return isLikelyStoreName(v) ? v : '';
}

// 蝦皮特殊倉別判讀：依「聯絡人」直接決定 Google Sheet 的門市名稱。
// 這是判讀規則，不影響其他一般報價單的門市名稱擷取。
function mapContactToWarehouse(contact) {
  const raw = cleanSingleLine(contact);
  const lower = raw.toLowerCase();

  // 蝦皮倉別規則一律使用「包含」判斷。
  // 例如「Emily Hsu / 其他資訊」或「陳俐瑾(採購)」都要能命中。

  // SOC 北倉
  if (
    lower.includes('emily hsu') ||
    lower.includes('emma lin') ||
    lower.includes('benson kuo')
  ) {
    return 'SOC北倉';
  }

  // SOC 南倉
  if (
    lower.includes('tiana') ||
    lower.includes('ann chen') ||
    raw.includes('孫健豪') ||
    raw.includes('侯淑婷')
  ) {
    return 'SOC南倉';
  }

  // IM 北倉
  if (
    raw.includes('陳俐瑾') ||
    raw.includes('林嘉祥') ||
    lower.includes('elaine lei') ||
    lower.includes('claire pang')
  ) {
    return 'IM北倉';
  }

  return raw;
}


function groupLayoutLines(items, tolerance = 3.5) {
  const sorted = [...(items || [])]
    .filter(item => item && item.str && item.str.trim())
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const groups = [];
  for (const item of sorted) {
    let group = groups.find(g => Math.abs(g.y - item.y) <= tolerance);
    if (!group) {
      group = { y: item.y, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    group.y = group.items.reduce((sum, x) => sum + x.y, 0) / group.items.length;
  }

  return groups
    .sort((a, b) => b.y - a.y)
    .map(group => ({
      y: group.y,
      items: group.items.sort((a, b) => a.x - b.x),
      text: group.items
        .sort((a, b) => a.x - b.x)
        .map(item => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    }));
}

function layoutLineContains(line, pattern) {
  return pattern.test(String(line?.text || ""));
}

function extractRepairTableByColumns(layoutPages) {
  if (!Array.isArray(layoutPages) || !layoutPages.length) return null;

  for (const pageItems of layoutPages) {
    const lines = groupLayoutLines(pageItems);
    const header = lines.find(line =>
      /機\s*器\s*品\s*號\s*\/\s*序\s*號/i.test(line.text) &&
      /故\s*障\s*現\s*象/i.test(line.text) &&
      /檢\s*測\s*說\s*明/i.test(line.text)
    );

    if (!header) continue;

    const headerY = header.y;
    const repairLine = lines.find(line =>
      line.y < headerY && /客\s*戶\s*維\s*修\s*單\s*號/i.test(line.text)
    );
    const bottomY = repairLine ? repairLine.y : headerY - 90;

    // PDF 的欄位標題常由多個字元組成，因此用文字項目的 x 範圍
    // 找出三個欄位標題的中心，再以資料列實際 x 起點微調欄位界線。
    const headerItems = header.items;
    const findSpan = (regex) => {
      const matched = headerItems.filter(item => regex.test(item.str));
      if (!matched.length) return null;
      return {
        left: Math.min(...matched.map(item => item.x)),
        right: Math.max(...matched.map(item => item.x + (item.width || 0))),
        center: (Math.min(...matched.map(item => item.x)) + Math.max(...matched.map(item => item.x + (item.width || 0)))) / 2
      };
    };

    // 因為「故障現象／檢測說明」在 PDF 中通常是逐字文字項目，
    // 這裡直接依 x 位置搜尋關鍵字字元群。
    const issueChars = headerItems.filter(item => /故|障|現|象/.test(item.str));
    const inspectionChars = headerItems.filter(item => /檢|測|說|明/.test(item.str));
    if (!issueChars.length || !inspectionChars.length) continue;

    const issueHeaderCenter = (
      Math.min(...issueChars.map(item => item.x)) +
      Math.max(...issueChars.map(item => item.x + (item.width || 0)))
    ) / 2;
    const inspectionHeaderCenter = (
      Math.min(...inspectionChars.map(item => item.x)) +
      Math.max(...inspectionChars.map(item => item.x + (item.width || 0)))
    ) / 2;

    // 找出資料區中最常見的文字左起點，通常就是三個欄位的實際內容起點。
    const dataItems = pageItems.filter(item => item.y < headerY - 3 && item.y > bottomY + 3);
    const xClusters = [];
    for (const item of dataItems) {
      if (!item.str || !item.str.trim()) continue;
      let cluster = xClusters.find(x => Math.abs(x.x - item.x) <= 4);
      if (!cluster) {
        cluster = { x: item.x, count: 0 };
        xClusters.push(cluster);
      }
      cluster.count += 1;
    }
    xClusters.sort((a, b) => b.count - a.count);

    // 注意：欄位標題是「置中」的，但資料內容通常是「靠左」的。
    // 因此不能拿「故障現象標題中心」當作機器欄／故障欄的界線。
    // 例如這份 PDF 的實際資料起點約為：機器 32、故障 195、檢測 405。
    // 正確做法是先找三個欄位的資料左起點，再取相鄰起點的中點作為界線。
    const dataClusters = xClusters
      .filter(c => c.x >= 20 && c.x <= 550)
      .sort((a, b) => a.x - b.x);

    const issueStart = xClusters
      .filter(c => c.x > 140 && c.x < issueHeaderCenter + 60)
      .sort((a, b) => Math.abs(a.x - issueHeaderCenter) - Math.abs(b.x - issueHeaderCenter))[0]?.x;

    const inspectionStart = xClusters
      .filter(c => c.x > (issueStart ?? issueHeaderCenter - 100) + 60 && c.x < 570)
      .sort((a, b) => Math.abs(a.x - inspectionHeaderCenter) - Math.abs(b.x - inspectionHeaderCenter))[0]?.x;

    // 找故障欄前面的機器欄資料起點。若找不到，才退回既有的固定範圍估算。
    const machineStart = issueStart != null
      ? dataClusters
          .filter(c => c.x < issueStart - 20)
          .sort((a, b) => Math.abs(a.x - 32) - Math.abs(b.x - 32))[0]?.x
      : undefined;

    const resolvedMachineStart = machineStart ?? 30;
    const resolvedIssueStart = issueStart ?? Math.max(resolvedMachineStart + 100, issueHeaderCenter - 90);
    const resolvedInspectionStart = inspectionStart ?? Math.max(resolvedIssueStart + 100, inspectionHeaderCenter - 90);

    // 兩條真正的欄位界線：機器↔故障、故障↔檢測。
    const machineBoundary = (resolvedMachineStart + resolvedIssueStart) / 2;
    const issueBoundary = (resolvedIssueStart + resolvedInspectionStart) / 2;

    const rows = lines.filter(line => line.y < headerY - 3 && line.y > bottomY + 3);
    const machineParts = [];
    const problemParts = [];
    const inspectionParts = [];

    for (const row of rows) {
      const machine = [];
      const problem = [];
      const inspection = [];

      for (const item of row.items) {
        if (item.x < machineBoundary) machine.push(item.str);
        else if (item.x < issueBoundary) problem.push(item.str);
        else inspection.push(item.str);
      }

      const machineText = machine.join(" ").replace(/\s+/g, " ").trim();
      const problemText = problem.join(" ").replace(/\s+/g, " ").trim();
      const inspectionText = inspection.join(" ").replace(/\s+/g, " ").trim();

      if (machineText) machineParts.push({ y: row.y, text: machineText });
      if (problemText) problemParts.push({ y: row.y, text: problemText });
      if (inspectionText) inspectionParts.push({ y: row.y, text: inspectionText });
    }

    // 設備序號：除了原本的 UTA / UT / 純數字格式，也支援
    // C6261408 這類「英文字母 + 6 碼以上數字」的序號。
    // 由於機器品號與設備序號通常同在同一欄，先排除第一個機器品號，
    // 再從同欄後續文字尋找序號，避免把 GPHS67811003K03.001 當成序號。
    const machineCode = machineParts
      .map(x => x.text.match(/\b[A-Z0-9][A-Z0-9._-]{7,}\b/i)?.[0])
      .find(Boolean) || "";

    const serialCandidates = [];
    for (const part of machineParts) {
      const matches = part.text.match(/\b[A-Z][A-Z0-9._-]{5,}\b|\b\d{7,}\b/gi) || [];
      for (const candidate of matches) {
        if (candidate.toLowerCase() === machineCode.toLowerCase()) continue;
        if (!serialCandidates.some(x => x.toLowerCase() === candidate.toLowerCase())) {
          serialCandidates.push(candidate);
        }
      }
    }

    const serial =
      machineParts
        .map(x => x.text.match(/\b(UTA[A-Z0-9]{6,}|UT\d{8,}|\d{12,})\b/i)?.[1])
        .find(Boolean) ||
      serialCandidates.find(candidate => /^[A-Z]\d{6,}$/i.test(candidate)) ||
      serialCandidates.find(candidate => /^\d{7,}$/.test(candidate)) ||
      serialCandidates[0] ||
      "";

    const problem = cleanIssueText(
      problemParts
        .map(x => x.text)
        .filter(x => !/^\d+$/.test(x))
        .join(" "),
      serial
    );

    const inspection = cleanIssueText(
      inspectionParts
        .map(x => x.text)
        .join(" "),
      serial
    );

    if (problem || inspection || serial) {
      return { serial, problem, inspection };
    }
  }

  return null;
}

function parseQuotation(text, layoutPages = null) {
  const normalized = normalizeText(text);
  const fields = emptyFields();
  const lines = normalized.split("\n").map(x => x.trim()).filter(Boolean);

  // 1. 門市名稱
  // 先保留「原始聯絡人」，再套用特殊倉別規則。
  // 不能先 sanitizeContact，否則像「陳俐瑾」這類純 2~4 字中文姓名
  // 會被一般門市名稱防呆規則過濾掉，導致特殊倉別無法命中。
  const rawContact = cleanSingleLine(firstMatch(normalized, [
    /聯絡人\s*[:：]?\s*(.*?)\s*報價日期\s*[:：]/i,
    /聯絡人\s*[:：]?\s*(.{1,80}?)(?=報價日期|統一編號|公司地址|承辦人員|公司電話|SR單號)/i
  ]));

  const mappedWarehouse = mapContactToWarehouse(rawContact);
  fields.contact = mappedWarehouse !== rawContact
    ? mappedWarehouse
    : sanitizeContact(rawContact);

  // 2. SR 單號
  fields.srNumber = firstMatch(normalized, [
    /SR\s*單號\s*[:：]?\s*([0-9]+)/i,
    /SR單號\s*[:：]?\s*([A-Z0-9-]+)/i
  ]);

  // 3. 案件編號 + 原始報修設備
  const repairMatch = normalized.match(
    /客戶維修單號\s*[:：]?\s*(.*?)\s*-\s*(RR[A-Z0-9-]+)/i
  );
  if (repairMatch) {
    const repairPrefix = cleanValue(repairMatch[1]);
    fields.caseNumber = repairMatch[2];
    fields.model = repairPrefix;
  }

  if (!fields.caseNumber) {
    const rrMatch = normalized.match(/\b(RR\d{6,})\b/i);
    if (rrMatch) fields.caseNumber = rrMatch[1];
  }

  if (!fields.model) {
    const modelMatch = normalized.match(/\b(PA\d+(?:槍把)?|MS\d+|RP-700|Sewoo|SBarco(?:\(含裁刀\))?|ZD230|DA210|TSC\s+ALPHA-40L)\b/i);
    if (modelMatch) fields.model = cleanValue(modelMatch[1]);
  }

  // 4. 找「機器品號 / 序號」表格列。
  // PDF.js / pdftotext 可能有兩種排列：
  // A.「1 機器品號 故障原因 檢測說明」+ 下一行序號
  // B.「1」→下一行機器品號→下一行序號→再下一行故障原因
  const machineHeaderIndex = lines.findIndex(line =>
    /機\s*器\s*品\s*號\s*\/\s*序\s*號/i.test(line)
  );

  let serialIndex = -1;
  let issueBlock = "";

  if (machineHeaderIndex >= 0) {
    const repairLineIndex = lines.findIndex((line, i) =>
      i > machineHeaderIndex && /客戶維修單號/i.test(line)
    );
    const endIndex = repairLineIndex >= 0 ? repairLineIndex : Math.min(lines.length, machineHeaderIndex + 12);

    for (let i = machineHeaderIndex + 1; i < endIndex; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      // 找第一個資料列的編號，例如「1 PA760-...」或單獨的「1」。
      if (!/^\d+\s*(?:$|\s)/.test(line)) continue;

      line = line.replace(/^\d+\s*/, "").trim();
      if (!line) continue;

      // 若機器品號單獨一行，下一行就是序號，再下一行才是故障內容。
      const firstToken = line.split(/\s+/)[0];
      const looksLikeMachineCode =
        /^(?:PA\d+|MS\d+|RP-?\d+|ZD\d+|DA\d+|TSC|Sewoo|SBarco|[A-Z0-9]+(?:-[A-Z0-9]+){2,})/i.test(firstToken);

      if (!looksLikeMachineCode) continue;

      // 移除機器品號後，剩下的就是同一列中的故障/檢測文字。
      const rest = line.slice(firstToken.length).trim();

      let serialRemainder = "";
      for (let j = i + 1; j < endIndex; j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;

        const serialCandidate = candidate.match(/^([A-Z0-9][A-Z0-9._-]{7,})(?:\s+(.+))?$/i);
        if (serialCandidate) {
          fields.serial = serialCandidate[1];
          serialRemainder = cleanValue(serialCandidate[2] || "");
          serialIndex = j;
          break;
        }

        // 若下一行不是序號，最多再往後找幾行。
        if (j > i + 3) break;
      }

      // 同一行已經有故障內容（格式 A）。
      const issueParts = [];
      if (rest && serialRemainder && /\s1\.\s*/.test(rest)) {
        const marker = rest.search(/\s1\.\s*/);
        const problemPart = rest.slice(0, marker).trim();
        const inspectionPart = rest.slice(marker).trim();

        // 若序號後的文字本身也包含「1.」，代表 PDF 把「故障現象續行」
        // 與「檢測說明」一起放在序號同一行；先在序號後文字內再切一次。
        if (serialRemainder && /(?:^|\s)1\./.test(serialRemainder)) {
          const serialMarker = serialRemainder.search(/(?:^|\s)1\./);
          const serialProblemTail = serialRemainder.slice(0, serialMarker).trim();
          const serialInspectionTail = serialRemainder.slice(serialMarker).trim();

          issueParts.push(problemPart + (serialProblemTail ? " " + serialProblemTail : ""));
          issueParts.push(
            inspectionPart + (serialInspectionTail ? " " + serialInspectionTail : "")
          );
        } else {
          // 如果序號後文字沒有再次出現「1.」，要判斷它是「故障現象續行」
          // 還是「檢測說明續行」。PDF 版面常把兩者拆到下一行；
          // 短小、以標點結尾的片段（例如「良,清潔」）通常是檢測欄續文，
          // 完整語句（例如「列印出滿版畫面」）則屬於故障欄續文。
          const looksLikeInspectionContinuation =
            serialRemainder &&
            (/^[.,，。:：]/.test(serialRemainder) ||
            (serialRemainder.length <= 8 && /[,，。:：]/.test(serialRemainder)));

          if (looksLikeInspectionContinuation) {
            issueParts.push(problemPart);
            issueParts.push(
              inspectionPart + " " + serialRemainder
            );
          } else {
            issueParts.push(
              problemPart + (serialRemainder ? " " + serialRemainder : "")
            );
            issueParts.push(inspectionPart);
          }
        }
      } else {
        if (rest) issueParts.push(rest);
        if (serialRemainder) issueParts.push(serialRemainder);
      }

      // 如果序號後還有故障內容（格式 B），收集序號後到維修單號前的文字。
      // 若同一列已經出現「1.」檢測說明標記，後續換行文字一定屬於
      // 檢測說明的續行，不能再回頭併進故障現象。
      const issueStart = serialIndex >= 0 ? serialIndex + 1 : i + 1;
      const continuationParts = [];
      for (let j = issueStart; j < endIndex; j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (/^\d+\s+/.test(candidate)) break;
        continuationParts.push(candidate);
      }

      const restAlreadyHasInspection = rest && /(?:^|\s)1\./.test(rest);
      if (restAlreadyHasInspection && continuationParts.length) {
        // 把換行續文直接接在「1.」後面，讓後面的分界邏輯一次處理。
        issueParts.push(continuationParts.join(" "));
      } else {
        issueParts.push(...continuationParts);
      }

      // 這裡先保留「詞與詞之間的空白」，因為後面要靠空白找故障/檢測分界。
      issueBlock = issueParts.join(" ")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      break;
    }
  }

  // 4.5 表格欄位優先使用 PDF 的實際 x/y 座標。
  // 這比單純依文字先後順序穩定，尤其能處理「故障現象」與「檢測說明」
  // 同一行、但位於不同欄位的情況。
  const coordinateTable = extractRepairTableByColumns(layoutPages);
  if (coordinateTable) {
    if (coordinateTable.serial) fields.serial = coordinateTable.serial;
    if (coordinateTable.problem) fields.problem = coordinateTable.problem;
    if (coordinateTable.inspection) fields.inspection = coordinateTable.inspection;
  }

  // 通用序號備援：不限 UTA，支援 UT、純數字等。
  if (!fields.serial) {
    // 通用備援仍優先使用既有 UTA / UT / 純數字格式。
    // C6261408 這類序號若沒有成功走座標判讀，則只從「機器品號/序號」
    // 表頭後的資料列尋找，避免直接從整份 PDF 把機器品號誤當成設備序號。
    const serialMatch = normalized.match(
      /機\s*器\s*品\s*號\s*\/\s*序\s*號[\s\S]{0,180}?\b[A-Z0-9][A-Z0-9._-]{7,}\b\s*\n\s*([A-Z]\d{6,})\b/i
    );
    if (serialMatch) {
      fields.serial = serialMatch[1];
    } else {
      const legacySerialMatch = normalized.match(/\b(UTA[A-Z0-9]{6,}|UT\d{8,}|\d{12,})\b/i);
      if (legacySerialMatch) fields.serial = legacySerialMatch[1];
    }
  }

  const coordinateProblem = fields.problem;
  const coordinateInspection = fields.inspection;

  // 5. 故障原因 + 廠商檢測回覆
  // 先處理最可靠的「1.」分隔；沒有編號時，再依常見檢測語句切分。
  if (issueBlock && (!fields.problem || !fields.inspection)) {
    const numbered = issueBlock.match(/^(.*?)(?=\s*1\.\s*)((?:1\.\s*).*)$/);

    if (numbered) {
      fields.problem = cleanIssueText(numbered[1], fields.serial);
      fields.inspection = cleanIssueText(numbered[2], fields.serial);
    } else {
      // 例如：
      // 9/29 列印模糊不清 印表機印字頭斷針
      // 10/1 觸控不良 螢幕觸控不良，電池膨脹，報價更換
      const splitAt = issueBlock.search(
        /\s+(?=(?:主電池|電池|螢幕|印表機|裁刀|印字頭|卡勾|列印|觸控|充電).*(?:不良|故障|斷針|磨損|膨脹|無法|正常|報價|清潔|更換|異常))/i
      );

      if (splitAt > 0) {
        fields.problem = cleanIssueText(issueBlock.slice(0, splitAt), fields.serial);
        fields.inspection = cleanIssueText(issueBlock.slice(splitAt), fields.serial);
      } else {
        fields.problem = cleanIssueText(issueBlock, fields.serial);
      }
    }
  }

  // 全域備援：即使表格文字排序被打散，也至少抓日期開頭的故障現象。
  if (!fields.problem) {
    const m = normalized.match(/\b(\d{1,2}\/\d{1,2}\s+.*?)(?=\s*客戶維修單號)/i);
    if (m) fields.problem = cleanIssueText(m[1], fields.serial);
  }

  if (!fields.inspection) {
    const m = normalized.match(/(\b1\.\s*.*?)(?=\s*客戶維修單號)/i);
    if (m) fields.inspection = cleanIssueText(m[1], fields.serial);
  }

  // 全域備援：即使表格欄位順序被 PDF.js 打散，也優先擷取日期開頭的故障現象。
  if (!fields.problem) {
    const m = normalized.match(/\b(\d{1,2}\/\d{1,2}\s+.*?)(?=\s*客戶維修單號)/i);
    if (m) fields.problem = cleanIssueText(m[1], fields.serial);
  }

  if (!fields.inspection) {
    const m = normalized.match(/(\b1\.\s*.*?)(?=\s*客戶維修單號)/i);
    if (m) fields.inspection = cleanIssueText(m[1], fields.serial);
  }

  // 若已由座標表格判讀成功，以座標結果為最高優先，避免後面的文字備援覆蓋。
  if (coordinateProblem) fields.problem = coordinateProblem;
  if (coordinateInspection) fields.inspection = coordinateInspection;

  // 6. 收費方式：PDF 沒有欄位時固定預設「耗材收費」。
  fields.feeType = firstMatch(normalized, [
    /收費方式\s*[:：]?\s*(.*?)(?=更換零件|料號|品名|數量|單價|金額|客戶維修單號|$)/i
  ]) || "耗材收費";

  // 7. 產品表：以「No. 料號 品名」到「合計」之間為唯一解析範圍。
  const productStart = lines.findIndex(line => /No\.\s*料\s*號\s*品\s*名/i.test(line));
  const productEnd = productStart >= 0
    ? (() => {
        const idx = lines.slice(productStart + 1).findIndex(line => /^合計\s*[:：]?/i.test(line));
        return idx >= 0 ? productStart + 1 + idx : lines.length;
      })()
    : -1;

  const partNumbers = [];
  const productNames = [];
  const quantities = [];
  const unitPrices = [];

  if (productStart >= 0) {
    let buffer = "";

    for (let i = productStart + 1; i < productEnd; i++) {
      const line = lines[i];
      if (!line || /^No\.\s*料\s*號/i.test(line)) continue;

      // 新的一筆產品列開始。
      if (/^\d+\s+/.test(line)) {
        if (buffer) {
          parseProductBuffer(buffer, partNumbers, productNames, quantities, unitPrices);
        }
        buffer = line;
      } else if (buffer) {
        // PDF 常把料號最後一個字母拆到下一行，例如：
        // 84-T400-017-003.SR
        // P
        // 印字頭...
        // 這裡要把 P 接回料號，而不是接到金額後面。
        if (/^[A-Z0-9]{1,3}$/.test(line) && /\.[A-Z]{2}\s+[\u3400-\u4dbf\u4e00-\u9fff]/i.test(buffer)) {
          buffer = buffer.replace(/(\.[A-Z]{2})(?=\s+[\u3400-\u4dbf\u4e00-\u9fff])/i, `$1${line}`);
        } else {
          // 其他拆行內容才接到目前產品列尾端。
          buffer += " " + line;
        }
      }
    }

    if (buffer) {
      parseProductBuffer(buffer, partNumbers, productNames, quantities, unitPrices);
    }
  }

  fields.partNumbers = partNumbers.join("\n");
  fields.products = productNames.join("\n");
  fields.quantities = quantities.join("\n");
  fields.unitPrices = unitPrices.join("\n");

  return fields;
}

function parseProductBuffer(buffer, partNumbers, productNames, quantities, unitPrices) {
  const text = cleanValue(buffer).replace(/\s+/g, " ").replace(/(\.[A-Z]{2})\s+([A-Z])\b/gi, "$1$2");

  // 從右側固定抓：單位、數量、單價、金額；前面才是料號與品名。
  const m = text.match(
    /^\s*\d+\s+(.+)\s+(EA|PCS|SET|個|件)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s*$/i
  );

  if (!m) return;

  let beforeUnit = cleanValue(m[1]);
  let name = "";

  // 料號與品名通常以第一個中文字為分界。
  // 這可以正確處理：
  // 84-T400-017-003.SR P 印字頭
  // BENCH SERVICE. 庫內維修
  const chineseIndex = beforeUnit.search(/[\u3400-\u4dbf\u4e00-\u9fff]/);
  if (chineseIndex >= 0) {
    const possiblePart = beforeUnit.slice(0, chineseIndex).trim();
    const possibleName = beforeUnit.slice(chineseIndex).trim();
    if (possiblePart) {
      beforeUnit = possiblePart;
      name = possibleName;
    }
  }

  // PDF 可能把 .SRP 拆成「.SR P」，合併回正確料號。
  let partNumber = beforeUnit
    .replace(/(\.[A-Z]{2})\s+([A-Z])$/i, "$1$2")
    .replace(/\.+$/, "")
    .trim();

  name = cleanProductName(name);

  if (!partNumber || !name) return;
  if (/^(品名|單位|數量|單價|金額)$/i.test(name)) return;

  partNumbers.push(partNumber);
  productNames.push(name);
  quantities.push(m[3].trim());
  unitPrices.push(Number(m[4].replace(/,/g, "")).toLocaleString("en-US"));
}

function renderFields() {
  const container = $("resultFields");
  container.innerHTML = "";

  for (const def of FIELD_DEFS) {
    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = def.label;

    const el = document.createElement(
  def.type === "textarea" ? "textarea" : "input"
);

el.className =
  def.type === "textarea"
    ? "field-textarea"
    : "field-input";

el.id = `field-${def.key}`;
el.value = state.fields[def.key] || "";
el.dataset.key = def.key;

if (def.type === "textarea") {
  el.wrap = "off";
}

    el.addEventListener("input", () => {
      state.fields[def.key] = el.value;

      // 人工修改後立即標示；按下「更新資料」後也維持標示。
      const before = String(state.originalFields[def.key] || "").trim();
      const after = String(el.value || "").trim();
      if (before !== after) {
        state.modifiedKeys.add(def.key);
      } else {
        // 若使用者把內容改回原始判讀結果，則取消該欄位標示。
        state.modifiedKeys.delete(def.key);
      }
      row.classList.toggle("field-updated", state.modifiedKeys.has(def.key));
      state.updated = state.modifiedKeys.size > 0;
      updateQuotationFileName();
      updateGoogleSheetPreview();
    });

    row.appendChild(label);
    row.appendChild(el);
    container.appendChild(row);
  }

  updateQuotationFileName();
  updateGoogleSheetPreview();
}


function getEditedFields() {
  const result = {};
  for (const def of FIELD_DEFS) {
    result[def.key] = $(`field-${def.key}`)?.value ?? "";
  }
  return result;
}

function updateQuotationFileName() {
  const fileName = buildQuotationFileName();

  const el = $("quotationFileName");
  if (el) el.textContent = fileName || "—";

  // 上方工具列的檔名也使用「修改後」的報價單檔名，
  // 讓「複製報價單檔名」複製的內容與紅框顯示完全一致。
  const toolbarFileName = $("fileName");
  if (toolbarFileName && fileName) {
    toolbarFileName.textContent = fileName;
  }
}

function updateGoogleSheetPreview() {
  const el = $("googleSheetPreview");
  if (!el) return;
  el.textContent = buildGoogleSheetPreview() || "—";
}

function buildResultText() {
  const f = getEditedFields();

  return [
    `SR單號：${f.srNumber}`,
    `填寫日期：${f.fillDate}`,
    `門市名稱：${f.contact}`,
    `報修設備：${f.model}`,
    `設備序號：${f.serial}`,
    `案件編號：${f.caseNumber}`,
    "",
    "故障原因：",
    f.problem,
    "",
    "廠商檢測回覆：",
    f.inspection,
    "",
    `收費方式：${f.feeType}`,
    "更換零件：",
    ...buildGoogleSheetRows().map(row => {
      const cells = row.split("\t");
      return [cells[9], cells[10], cells[11], cells[12]].join(" | ");
    }),
    "",
    `報價單檔名：${buildQuotationFileName()}`
  ].join("\n").trim();
}

async function copyResult() {
  const text = buildGoogleSheetPreview();

  if (!text.replace(/[\t\r\n]/g, "").trim()) {
    showToast("目前沒有可複製的結果");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast("已複製，可從 Google Sheet 的 B 欄直接貼上");
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("已複製，可從 Google Sheet 的 B 欄直接貼上");
  }
}


async function copyQuotationFileName() {
  const fileName = buildQuotationFileName();

  if (!fileName) {
    showToast("目前沒有可複製的報價單檔名");
    return;
  }

  try {
    await navigator.clipboard.writeText(fileName);
    showToast("已複製報價單檔名");
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = fileName;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("已複製報價單檔名");
  }
}

async function loadPdfJs() {
  if (state.pdfjs) return state.pdfjs;

  try {
    state.pdfjs = await import(
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs"
    );

    state.pdfjs.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

    return state.pdfjs;
  } catch (error) {
    console.error(error);
    throw new Error("無法載入 PDF.js。請確認網路連線。");
  }
}

async function extractPdfText(pdf) {
  let allText = "";

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    const pageText = content.items
  .map(item => `${item.str || ""}${item.hasEOL ? "\n" : " "}`)
  .join("");

    allText += `\n--- 第 ${pageNo} 頁 ---\n${pageText}\n`;
  }

  return normalizeText(allText);
}

async function extractPdfLayout(pdf) {
  const pages = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    pages.push(content.items
      .filter(item => item && item.str && item.str.trim())
      .map(item => ({
        str: item.str,
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0),
        width: Number(item.width || 0),
        height: Number(item.height || Math.abs(item.transform?.[3] || 0))
      })));
  }

  return pages;
}

async function renderPage(pageNo) {
  if (!state.pdfDoc) return;

  state.currentPage = Math.max(1, Math.min(pageNo, state.pdfDoc.numPages));

  const page = await state.pdfDoc.getPage(state.currentPage);
  const viewport = page.getViewport({ scale: state.pdfZoom || 1.45 });
  const canvas = $("pdfCanvas");
  const context = canvas.getContext("2d");

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  $("viewerEmpty").classList.add("hidden");

  await page.render({
    canvasContext: context,
    viewport
  }).promise;

  $("pageLabel").textContent =
    `第 ${state.currentPage} / ${state.pdfDoc.numPages} 頁`;

  $("prevPageBtn").disabled = state.currentPage <= 1;
  $("nextPageBtn").disabled = state.currentPage >= state.pdfDoc.numPages;
}

async function ocrPdf(pdf) {
  if (!window.Tesseract) {
    throw new Error("OCR 模組尚未載入。");
  }

  const worker = await Tesseract.createWorker("chi_tra+eng", 1, {
    logger: message => {
      if (message.status === "recognizing text" && message.progress) {
        setStatus(`OCR ${Math.round(message.progress * 100)}%`);
      }
    }
  });

  let result = "";

  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      setStatus(`OCR 第 ${pageNo} / ${pdf.numPages} 頁`);

      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 2.0 });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const context = canvas.getContext("2d");
      await page.render({
        canvasContext: context,
        viewport
      }).promise;

      const { data } = await worker.recognize(canvas);
      result += `\n--- 第 ${pageNo} 頁 ---\n${data.text}\n`;
    }
  } finally {
    await worker.terminate();
  }

  return normalizeText(result);
}

async function processFile(file) {
  if (!file || file.type !== "application/pdf") {
    showToast("請選擇 PDF 檔案");
    return;
  }

  state.currentFile = file;
  state.fields = emptyFields();
  state.fields.fillDate = formatUploadDate(new Date());
  state.rawText = "";
  state.layout = null;
  state.ocrUsed = false;

  $("fileName").textContent = file.name;
  $("fileMeta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $("toolbar").classList.remove("hidden");
  $("workspace").classList.remove("hidden");
  $("batchCard").classList.toggle("hidden", state.files.length <= 1);

  setStatus("讀取 PDF…");

  try {
    const pdfjs = await loadPdfJs();
    const buffer = await file.arrayBuffer();

    state.pdfDoc = await pdfjs.getDocument({
      data: buffer
    }).promise;

    await renderPage(1);

    let text = await extractPdfText(state.pdfDoc);
    state.layout = await extractPdfLayout(state.pdfDoc);

    /*
     * 如果擷取到的文字太少，視為掃描 PDF，改走 OCR。
     * 閾值可依實際文件調整。
     */
    if (text.replace(/[\s-]/g, "").length < 80) {
      state.ocrUsed = true;
      setStatus("文字不足，啟動 OCR…");
      text = await ocrPdf(state.pdfDoc);
      state.layout = null;
    }

    state.rawText = text;
    state.fields = parseQuotation(text, state.layout);
    state.fields.fillDate = formatUploadDate(new Date());

    renderFields();
    updateQuotationFileName();
    $("rawText").textContent = text;

    const filled = FIELD_DEFS.filter(d => state.fields[d.key]?.trim()).length;
    $("confidenceBadge").textContent =
      state.ocrUsed
        ? `OCR・${filled}/${FIELD_DEFS.length} 欄位`
        : `文字擷取・${filled}/${FIELD_DEFS.length} 欄位`;

    setStatus("判讀完成");
    showToast(`判讀完成：${filled}/${FIELD_DEFS.length} 個欄位有資料`);
  } catch (error) {
    console.error(error);
    setStatus("判讀失敗");
    $("confidenceBadge").textContent = "判讀失敗";
    showToast(error.message || "PDF 判讀失敗");
  }
}

function addFiles(fileList) {
  const pdfs = [...fileList].filter(
    file => file.type === "application/pdf" || /\.pdf$/i.test(file.name)
  );

  if (!pdfs.length) {
    showToast("沒有找到 PDF 檔案");
    return;
  }

  state.files = pdfs;
  state.currentIndex = 0;
  renderFileList();
  processFile(state.files[0]);
}

function renderFileList() {
  const list = $("fileList");
  list.innerHTML = "";

  state.files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = `file-item ${index === state.currentIndex ? "active" : ""}`;

    const name = document.createElement("div");
    name.className = "file-item-name";
    name.textContent = `${index + 1}. ${file.name}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "開啟";
    btn.addEventListener("click", () => {
      state.currentIndex = index;
      renderFileList();
      processFile(file);
    });

    item.appendChild(name);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function clearAll() {
  state.files = [];
  state.currentIndex = 0;
  state.pdfDoc = null;
  state.currentFile = null;
  state.fields = emptyFields();
  state.originalFields = emptyFields();
  state.modifiedKeys = new Set();
  state.updated = false;
  state.rawText = "";
  state.layout = null;
  state.ocrUsed = false;

  $("pdfInput").value = "";
  $("toolbar").classList.add("hidden");
  $("workspace").classList.add("hidden");
  $("batchCard").classList.add("hidden");
  $("resultFields").innerHTML = "";
  $("quotationFileName").textContent = "—";
  $("googleSheetPreview").textContent = "—";
  $("rawText").textContent = "";
  $("confidenceBadge").textContent = "待判讀";
  $("fileList").innerHTML = "";
  $("viewerEmpty").classList.remove("hidden");
  $("pageLabel").textContent = "第 1 / 1 頁";
  $("pdfCanvas").getContext("2d").clearRect(
    0, 0,
    $("pdfCanvas").width,
    $("pdfCanvas").height
  );
  setStatus("尚未載入");
  showToast("已清除");
}

$("chooseBtn").addEventListener("click", () => $("pdfInput").click());

$("pdfInput").addEventListener("change", event => {
  addFiles(event.target.files);
});

$("dropZone").addEventListener("dragover", event => {
  event.preventDefault();
  $("dropZone").classList.add("dragover");
});

$("dropZone").addEventListener("dragleave", () => {
  $("dropZone").classList.remove("dragover");
});

$("dropZone").addEventListener("drop", event => {
  event.preventDefault();
  $("dropZone").classList.remove("dragover");
  addFiles(event.dataTransfer.files);
});

$("copyBtn").addEventListener("click", copyResult);
$("copyFileNameBtn").addEventListener("click", copyQuotationFileName);
$("clearBtn").addEventListener("click", clearAll);

$("prevPageBtn").addEventListener("click", () => {
  renderPage(state.currentPage - 1);
});

$("nextPageBtn").addEventListener("click", () => {
  renderPage(state.currentPage + 1);
});

$("pdfZoomOutBtn").addEventListener("click", async () => {
  state.pdfZoom = Math.max(0.6, +(state.pdfZoom - 0.15).toFixed(2));
  $("pdfZoomLabel").textContent = `${Math.round(state.pdfZoom * 100)}%`;
  await renderPage(state.currentPage);
});

$("pdfZoomInBtn").addEventListener("click", async () => {
  state.pdfZoom = Math.min(3.5, +(state.pdfZoom + 0.15).toFixed(2));
  $("pdfZoomLabel").textContent = `${Math.round(state.pdfZoom * 100)}%`;
  await renderPage(state.currentPage);
});

$("pdfZoomFitBtn").addEventListener("click", async () => {
  state.pdfZoom = 1.45;
  $("pdfZoomLabel").textContent = "145%";
  await renderPage(state.currentPage);
});

// PDF：在固定大小的預覽框內放大、縮小與拖曳移動。
// Canvas 會以實際 PDF 尺寸渲染，因此放大後不會再被 max-width 壓回原尺寸。
(() => {
  const viewer = $("pdfViewer");
  const canvas = $("pdfCanvas");
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  viewer.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target !== canvas) return;
    dragging = true;
    viewer.classList.add("is-panning");
    startX = e.clientX;
    startY = e.clientY;
    startLeft = viewer.scrollLeft;
    startTop = viewer.scrollTop;
    viewer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  viewer.addEventListener("pointermove", e => {
    if (!dragging) return;
    viewer.scrollLeft = startLeft - (e.clientX - startX);
    viewer.scrollTop = startTop - (e.clientY - startY);
    e.preventDefault();
  });

  const stop = e => {
    if (!dragging) return;
    dragging = false;
    viewer.classList.remove("is-panning");
    try { viewer.releasePointerCapture(e.pointerId); } catch (_) {}
  };

  viewer.addEventListener("pointerup", stop);
  viewer.addEventListener("pointercancel", stop);
  viewer.addEventListener("pointerleave", e => {
    if (dragging && !viewer.hasPointerCapture(e.pointerId)) stop(e);
  });

  // 滑鼠滾輪也可縮放；以滑鼠所在位置為縮放中心。
  viewer.addEventListener("wheel", async e => {
    if (!state.pdfDoc || e.ctrlKey || e.metaKey) return;
    e.preventDefault();

    const oldZoom = state.pdfZoom || 1.45;
    const direction = e.deltaY < 0 ? 1 : -1;
    const newZoom = Math.max(0.6, Math.min(3.5, +(oldZoom + direction * 0.12).toFixed(2)));
    if (newZoom === oldZoom) return;

    const rect = viewer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left + viewer.scrollLeft;
    const mouseY = e.clientY - rect.top + viewer.scrollTop;
    const ratio = newZoom / oldZoom;

    state.pdfZoom = newZoom;
    $("pdfZoomLabel").textContent = `${Math.round(newZoom * 100)}%`;
    await renderPage(state.currentPage);

    viewer.scrollLeft = mouseX * ratio - (e.clientX - rect.left);
    viewer.scrollTop = mouseY * ratio - (e.clientY - rect.top);
  }, { passive: false });
})();

$("rawToggleBtn").addEventListener("click", () => {
  $("rawText").classList.toggle("hidden");
});
