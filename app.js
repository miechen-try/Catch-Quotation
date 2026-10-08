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
  ocrUsed: false,
  initialValues: emptyFields()
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

  result = result.replace(/(\d)\s+\./g, "$1.");
  result = result.replace(/\.\s+([A-Z]{2,4})(?=\s|$)/g, ".$1");
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
  "TSC ALPHA-40L": "攜帶式藍芽標籤機TSC ALPHA-40L",
  "Cino A678(RS232)": "無線掃碼槍CinoA678(RS232)",
  "TC200": "標籤機TC200"
};

function getSheetModel(model) {
  const raw = String(model || "").trim();
  if (MODEL_SHEET_MAP[raw]) return MODEL_SHEET_MAP[raw];

  // 容許 PDF 中多一點空白或大小寫差異。
  const normalized = raw.replace(/\s+/g, " ");
  const compact = normalized.replace(/\s+/g, "").toLowerCase();
  const key = Object.keys(MODEL_SHEET_MAP).find(k =>
    k.toLowerCase() === normalized.toLowerCase() ||
    k.replace(/\s+/g, "").toLowerCase() === compact
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
  const models = String(f.model || "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
  const srs = String(f.srNumber || "")
    .split(/\r?\n|[/、,，]+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!contact && !models.length && !srs.length) return "";

  const sheetModels = [...new Set(models.map(getSheetModel).filter(Boolean))];
  const modelText = sheetModels.join("、");
  const srText = [...new Set(srs)].join("、");

  // 多筆 SR（同一份報價單）時：門市名稱_報修設備(只取一次型號)-SR1、SR2、...
  const modelPart = modelText ? modelText.split("、")[0] : "";
  const body = modelPart && srText
    ? `${modelPart}-${srText}`
    : modelPart || srText;

  const baseName = [contact, body].filter(Boolean).join("_");
  return baseName ? `${baseName}.pdf` : "";
}

function buildGoogleSheetRows() {
  const f = getEditedFields();

  const splitRows = (value) => String(value || "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  const parts = splitRows(f.partNumbers);
  const names = splitRows(f.products);
  const quantities = splitRows(f.quantities);
  const prices = splitRows(f.unitPrices);
  const models = splitRows(f.model);
  const serials = splitRows(f.serial);
  const problems = splitRows(f.problem);
  const inspections = splitRows(f.inspection);
  const cases = splitRows(f.caseNumber);
  const srs = splitRows(f.srNumber);

  const rowCount = Math.max(
    parts.length, names.length, quantities.length, prices.length,
    models.length, serials.length, problems.length, inspections.length,
    cases.length, srs.length, 1
  );

  const pick = (arr, i) => arr[i] || (arr.length === 1 ? arr[0] : "");
  const rows = [];

  for (let i = 0; i < rowCount; i++) {
    const row = [
      pick(cases, i),
      pick(srs, i),
      f.fillDate,
      "",
      f.contact,
      getSheetModel(pick(models, i)),
      pick(serials, i),
      pick(problems, i),
      pick(inspections, i),
      f.feeType || "耗材收費",
      pick(parts, i),
      pick(names, i),
      pick(quantities, i),
      pick(prices, i)
    ];

    rows.push(
      row.map(value => String(value ?? "")
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

function normalizeRepairModel(raw) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  const m = value.match(/(Cino\s*A678\s*\(RS232\)|MS\d+|PA\d+(?:槍把)?|TC\d+|RP-?\d+|ZD\d+|DA\d+|SBarco(?:\(含裁刀\))?|Sewoo|TSC\s+ALPHA-40L)/i);
  return m ? m[1] : value;
}

function extractRepairTableByColumns(layoutPages) {
  const allRows = [];
  if (!Array.isArray(layoutPages)) return allRows;

  for (const page of layoutPages) {
    const items = Array.isArray(page) ? page : [];
    if (!items.length) continue;

    const lines = [];
    const sorted = [...items].sort((a, b) => {
      const dy = a.y - b.y;
      return Math.abs(dy) > 4.5 ? dy : a.x - b.x;
    });

    for (const item of sorted) {
      if (!item.str || !item.str.trim()) continue;
      let line = lines.find(l => Math.abs(l.y - item.y) <= 4.5);
      if (!line) {
        line = { y: item.y, items: [] };
        lines.push(line);
      }
      line.items.push(item);
    }

    lines.sort((a, b) => a.y - b.y);

    const header = lines.find(line => {
      const txt = line.items.map(x => x.str).join("").replace(/\s+/g, "");
      return /機器品號.*序號/.test(txt) && /故障現象/.test(txt) && /檢測說明/.test(txt);
    });
    if (!header) continue;

    const machineHead = header.items.find(x => /機/.test(x.str));
    const problemHead = header.items.find(x => /故/.test(x.str));
    const inspectionHead = header.items.find(x => /檢/.test(x.str));
    if (!machineHead || !problemHead || !inspectionHead) continue;

    const xMachine = machineHead.x;
    const xProblem = problemHead.x;
    const xInspection = inspectionHead.x;
    const b1 = (xMachine + xProblem) / 2;
    const b2 = (xProblem + xInspection) / 2;

    const startIndex = lines.indexOf(header) + 1;
    const endIndex = lines.findIndex((line, i) =>
      i > startIndex && line.items.some(x => /客戶維修單號/.test(x.str.replace(/\s+/g, "")))
    );

    const rowGroups = [];
    let current = null;

    for (let i = startIndex; i < (endIndex >= 0 ? endIndex : lines.length); i++) {
      const line = lines[i];
      const ordered = [...line.items].sort((a, b) => a.x - b.x);
      const text = ordered.map(x => x.str).join("").trim();
      if (!text) continue;

      const machineTexts = ordered.filter(x => x.x < b1).map(x => x.str).join("").trim();
      const looksLikeMachine = /(?:MS\d+|PA\d+|RP-?\d+|ZD\d+|DA\d+|TC\d+|TSC|SBarco|Sewoo|Cino\s*A678)/i.test(machineTexts);

      if (looksLikeMachine) {
        if (current) rowGroups.push(current);
        current = { machine: [], problem: [], inspection: [], firstY: line.y };
      }

      if (!current) continue;

      for (const item of ordered) {
        if (item.x < b1) current.machine.push(item.str);
        else if (item.x < b2) current.problem.push(item.str);
        else current.inspection.push(item.str);
      }
    }
    if (current) rowGroups.push(current);

    for (const row of rowGroups) {
      const machineText = row.machine.join(" ").replace(/\s+/g, " ").trim();
      const problemText = row.problem.join(" ").replace(/\s+/g, " ").trim();
      const inspectionText = row.inspection.join(" ").replace(/\s+/g, " ").trim();
      if (!machineText) continue;

      const model = normalizeRepairModel(machineText);
      const serialMatch = machineText.match(/(?:^|\s)(UTA[A-Z0-9]{6,}|UT[A-Z0-9]{6,}|C[A-Z0-9]{6,}|\d{8,})(?:\s|$)/i);
      const serial = serialMatch ? serialMatch[1] : "";
      if (!model || !serial) continue;

      const rowSr = inspectionText.match(/\((\d{6,})\)/)?.[1] || "";
      const inspection = inspectionText
        .replace(/\(\d{6,}\)/g, "")
        .replace(/[\u3400-\u4dbf\u4e00-\u9fff]\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, "$&")
        .replace(/\s+/g, " ")
        .trim();

      const problem = problemText
        .replace(/\s+/g, " ")
        .replace(/([\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, "$1")
        .trim();

      allRows.push({ model, serial, problem, inspection, sr: rowSr });
    }
  }

  return allRows;
}

function extractRepairNumbers(text) {
  const m = text.match(/客戶維修單號\s*[:：]?[\s\S]*?(?=\n\s*(?:1、|1\.|附\s*註|附註)|$)/i);
  if (!m) return [];
  const compact = m[0].replace(/\s+/g, "");
  return [...compact.matchAll(/RR\d{6,}/gi)].map(x => x[0].toUpperCase());
}

function parseQuotation(text, layoutPages = null) {
  const normalized = normalizeText(text);
  const fields = emptyFields();
  const lines = normalized.split("\n").map(x => x.trim()).filter(Boolean);

  // 先從「客戶維修單號」完整區塊擷取所有 RR 編號，避免 PDF 換行把 RR 拆斷。
  const repairNumbers = extractRepairNumbers(normalized);
  const layoutRepairRows = extractRepairTableByColumns(layoutPages);

  // 1. 門市名稱
  fields.contact = firstMatch(normalized, [
    /聯絡人\s*[:：]?\s*(.*?)\s*報價日期\s*[:：]/i,
    /聯絡人\s*[:：]?\s*(.{1,80}?)(?=報價日期|統一編號|公司地址|承辦人員|公司電話|SR單號)/i
  ]);

  // 2. SR 單號
  fields.srNumber = firstMatch(normalized, [
    /SR\s*單號\s*[:：]?\s*([0-9/、,，\s]+)/i,
    /SR單號\s*[:：]?\s*([A-Z0-9\-_/、,，\s]+)/i
  ]);
  if (layoutRepairRows.length > 1) {
    const rowSrs = layoutRepairRows.map(r => r.sr).filter(Boolean);
    if (rowSrs.length) fields.srNumber = rowSrs.join("\n");
  }

  // 3. 案件編號 + 原始報修設備
  const repairMatch = normalized.match(
    /客戶維修單號\s*[:：]?\s*(.*?)\s*-\s*(RR[A-Z0-9-]+)/i
  );
  if (repairMatch) {
    const repairPrefix = cleanValue(repairMatch[1]);
    fields.caseNumber = repairNumbers.join("\n") || repairMatch[2];
    fields.model = repairPrefix;
  } else if (repairNumbers.length) {
    fields.caseNumber = repairNumbers.join("\n");
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

  // 通用序號備援：不限 UTA，支援 UT、純數字等。
  if (!fields.serial) {
    const serialMatch = normalized.match(/\b(UTA[A-Z0-9]{6,}|UT\d{8,}|\d{12,})\b/i);
    if (serialMatch) fields.serial = serialMatch[1];
  }

  // 5. 故障原因 + 廠商檢測回覆
  // 先處理最可靠的「1.」分隔；沒有編號時，再依常見檢測語句切分。
  if (issueBlock) {
    const numbered = issueBlock.match(/^(.*?)(?=\s*1\.\s*)((?:1\.\s*).*)$/);

    if (numbered) {
      fields.problem = cleanIssueText(numbered[1], fields.serial);
      fields.inspection = cleanIssueText(numbered[2], fields.serial);
    } else {
      // 例如：
      // 9/29 列印模糊不清 印表機印字頭斷針
      // 10/1 觸控不良 螢幕觸控不良，電池膨脹，報價更換
      const splitAt = issueBlock.search(
        /\s+(?=(?:螢幕|印表機|裁刀|印字頭|電池).*(?:不良|故障|斷針|磨損|膨脹|無法|正常|報價|清潔|更換))/i
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
        if (/^\.[A-Z]{2,4}$/i.test(line) && /[A-Z0-9][A-Z0-9._-]*$/i.test(buffer)) {
          buffer += line;
        } else if (/^[A-Z0-9]{1,3}$/.test(line) && /\.[A-Z]{2}\s+[\u3400-\u4dbf\u4e00-\u9fff]/i.test(buffer)) {
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

  // 座標判讀優先：同一份報價單有多台設備時，逐列保留 SR／序號／故障／檢測，
  // 同時把 PDF 因欄寬造成的換行合併，不再讓換行被誤認成另一筆資料。
  if (layoutRepairRows.length) {
    const cases = repairNumbers.slice(0, layoutRepairRows.length);
    fields.model = layoutRepairRows.map(r => getSheetModel(r.model)).join("\n");
    fields.serial = layoutRepairRows.map(r => r.serial).join("\n");
    fields.problem = layoutRepairRows.map(r => cleanIssueText(r.problem, r.serial)).join("\n");
    fields.inspection = layoutRepairRows.map(r => cleanIssueText(r.inspection, r.serial)).join("\n");
    if (cases.length) fields.caseNumber = cases.join("\n");
    const rowSrs = layoutRepairRows.map(r => r.sr).filter(Boolean);
    if (rowSrs.length) fields.srNumber = rowSrs.join("\n");
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
    /^\s*\d+\s+(.+)\s+(EA|PCS|SET|個|件)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)(?:\s+(.+))?\s*$/i
  );

  if (!m) return;

  let beforeUnit = cleanValue(m[1] + (m[6] ? " " + m[6] : ""));
  let name = "";

  // 優先處理「標準料號 + 空白 + 品名」；這同時涵蓋英文品名與中英混合品名。
  // 例如：1550-905920G.SRP ESD USB/AM Cable...維護 產品線
  const leadingPart = beforeUnit.match(/^([A-Z0-9][A-Z0-9._-]{5,})\s+(.+)$/i);
  if (leadingPart) {
    beforeUnit = leadingPart[1].trim();
    name = leadingPart[2].trim();
  } else {
    // 料號與品名通常以第一個中文字為分界。
    // 這可以正確處理：84-T400-017-003.SRP 印字頭、BENCH SERVICE. 庫內維修
    const chineseIndex = beforeUnit.search(/[\u3400-\u4dbf\u4e00-\u9fff]/);
    if (chineseIndex >= 0) {
    const possiblePart = beforeUnit.slice(0, chineseIndex).trim();
    const possibleName = beforeUnit.slice(chineseIndex).trim();
      if (possiblePart) {
        beforeUnit = possiblePart;
        name = possibleName;
      }
    } else {
      // 英文品名沒有中文字時，PDF 仍通常以「料號 + 空白 + 品名」排列。
      const englishPart = beforeUnit.match(/^([A-Z0-9][A-Z0-9._-]{5,})(?:\s+)(.+)$/i);
      if (englishPart) {
        beforeUnit = englishPart[1].trim();
        name = englishPart[2].trim();
      }
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

function updateConfidenceBadge() {
  const badge = $("confidenceBadge");
  if (!badge) return;
  const filled = FIELD_DEFS.filter(d => String($(`field-${d.key}`)?.value || "").trim()).length;
  const prefix = state.ocrUsed ? "OCR" : "文字擷取";
  badge.textContent = `${prefix}・${filled}/${FIELD_DEFS.length} 欄位`;
  badge.classList.toggle("incomplete", filled < FIELD_DEFS.length);
}

function updateFieldVisual(row, el, def) {
  row.classList.remove("field-error", "field-manual");
  const oldTag = row.querySelector(".field-note");
  if (oldTag) oldTag.remove();

  const value = String(el.value || "").trim();
  const initial = String(state.initialValues?.[def.key] || "").trim();
  const note = document.createElement("span");
  note.className = "field-note";

  if (!value) {
    row.classList.add("field-error");
    note.textContent = "資料異常";
    row.querySelector(".field-label")?.appendChild(note);
  } else if (value !== initial) {
    row.classList.add("field-manual");
    note.textContent = "已手動修改";
    row.querySelector(".field-label")?.appendChild(note);
  }

  if (def.key === "quantities" && value) {
    const nums = value.split(/\r?\n/).map(x => Number(x.replace(/,/g, "").trim())).filter(Number.isFinite);
    if (nums.some(n => n > 1)) {
      const qnote = document.createElement("span");
      qnote.className = "quantity-note";
      qnote.textContent = "數量異常";
      row.querySelector(".field-label")?.appendChild(qnote);
    }
  }
}

function updateConfidenceBadge() {
  const badge = $("confidenceBadge");
  if (!badge) return;
  const filled = FIELD_DEFS.filter(d => String($(`field-${d.key}`)?.value || "").trim()).length;
  const prefix = state.ocrUsed ? "OCR" : "文字擷取";
  badge.textContent = `${prefix}・${filled}/${FIELD_DEFS.length} 欄位`;
  badge.classList.toggle("incomplete", filled < FIELD_DEFS.length);
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
      updateFieldVisual(row, el, def);
      updateQuotationFileName();
      updateGoogleSheetPreview();
      updateConfidenceBadge();
    });

    updateFieldVisual(row, el, def);

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
    const items = content.items.map(item => ({
      str: item.str || "",
      x: Number(item.transform?.[4] || 0),
      y: Number(item.transform?.[5] || 0),
      width: Number(item.width || 0),
      height: Number(item.height || 0)
    })).filter(item => item.str.trim());
    // PDF 座標 Y 從下往上；這裡轉成「由上到下」排序使用。
    if (items.length) {
      const maxY = Math.max(...items.map(i => i.y));
      for (const item of items) item.y = maxY - item.y;
    }
    pages.push(items);
  }
  return pages;
}

async function renderPage(pageNo) {
  if (!state.pdfDoc) return;

  state.currentPage = Math.max(1, Math.min(pageNo, state.pdfDoc.numPages));

  const page = await state.pdfDoc.getPage(state.currentPage);
  const viewport = page.getViewport({ scale: 1.45 });
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

    /*
     * 如果擷取到的文字太少，視為掃描 PDF，改走 OCR。
     * 閾值可依實際文件調整。
     */
    if (text.replace(/[\s-]/g, "").length < 80) {
      state.ocrUsed = true;
      setStatus("文字不足，啟動 OCR…");
      text = await ocrPdf(state.pdfDoc);
    }

    state.rawText = text;
    let layoutPages = [];
    try {
      layoutPages = await extractPdfLayout(state.pdfDoc);
    } catch (layoutError) {
      console.warn("座標判讀失敗，改用文字判讀：", layoutError);
    }
    state.fields = parseQuotation(text, layoutPages);
    state.fields.fillDate = formatUploadDate(new Date());
    state.initialValues = { ...state.fields };

    renderFields();
    updateQuotationFileName();
    $("rawText").textContent = text;

    const filled = FIELD_DEFS.filter(d => state.fields[d.key]?.trim()).length;
    updateConfidenceBadge();

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

    name.title = "點擊切換此文件";
    name.style.cursor = "pointer";
    name.addEventListener("click", () => {
      state.currentIndex = index;
      renderFileList();
      processFile(file);
    });

    item.appendChild(name);
    list.appendChild(item);
  });
}

function clearAll() {
  state.files = [];
  state.currentIndex = 0;
  state.pdfDoc = null;
  state.currentFile = null;
  state.fields = emptyFields();
  state.rawText = "";
  state.ocrUsed = false;
  state.initialValues = emptyFields();

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

$("rawToggleBtn").addEventListener("click", () => {
  $("rawText").classList.toggle("hidden");
});
