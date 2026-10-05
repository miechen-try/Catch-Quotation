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
  { key: "model", label: "報修設備", type: "input" },
  { key: "serial", label: "設備序號", type: "input" },
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
  ocrUsed: false
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

  const modelText = model ? `PDA(${model})` : "";

  return [
    contact,
    modelText && srNumber ? `${modelText}-${srNumber}` : modelText || srNumber
  ]
    .filter(Boolean)
    .join("_");
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

  const parts = String(f.partNumbers || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const names = String(f.products || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const quantities = String(f.quantities || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const prices = String(f.unitPrices || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  const rowCount = Math.max(parts.length, names.length, quantities.length, prices.length, 1);
  const rows = [];

  for (let i = 0; i < rowCount; i++) {
    const row = [
      f.caseNumber,
      f.srNumber,
      f.fillDate,
      "",
      f.contact,
      f.model,
      f.serial,
      f.problem,
      f.inspection,
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

function parseQuotation(text) {
  const normalized = normalizeText(text);
  const fields = emptyFields();

  /*
   * 1. 聯絡人
   *
   * PDF 有可能變成：
   * 聯絡人 : 羅東中山二 - 智取店報價日期 : 2026-10-01
   *
   * 也可能變成：
   * 聯絡人 : 羅東中山二 - 智取店
   * 報價日期 : 2026-10-01
   *
   * 所以直接抓「聯絡人」到「報價日期」之前，
   * 不要求中間一定有空白或換行。
   */
  fields.contact = firstMatch(normalized, [
    /聯絡人\s*[:：]?\s*(.*?)\s*報價日期\s*[:：]/i
  ]);

  /*
   * 如果上面仍抓不到，再從聯絡人後面抓，
   * 並把報價日期切掉。
   */
  if (!fields.contact) {
    const contactMatch = normalized.match(
      /聯絡人\s*[:：]?\s*(.{1,50}?)(?=報價日期|統一編號|公司地址|承辦人員|公司電話|SR單號)/i
    );

    if (contactMatch) {
      fields.contact = cleanValue(contactMatch[1]);
    }
  }

  /*
   * 2. SR單號
   */
  fields.srNumber = firstMatch(normalized, [
    /SR\s*單號\s*[:：]?\s*([0-9]+)/i,
    /SR單號\s*[:：]?\s*([A-Z0-9-]+)/i
  ]);

  /*
   * 4. 設備序號
   *
   * 先找「機器品號 / 序號」表格，從機器品號的下一行取得設備序號。
   * 同時保留 UTA 開頭序號的通用備援。
   */
  const serialMatch = normalized.match(/\b(UTA[A-Z0-9]{6,})\b/i);
  if (serialMatch) {
    fields.serial = serialMatch[1];
  }

  if (!fields.serial) {
    const tableLines = normalized
      .split(/\n/)
      .map(x => x.trim())
      .filter(Boolean);

    const headerIndex = tableLines.findIndex(line =>
      /機器品號\s*\/\s*序號/i.test(line)
    );

    if (headerIndex >= 0) {
      for (let i = headerIndex + 1; i < Math.min(tableLines.length, headerIndex + 10); i++) {
        // 機器品號可能單獨一行，也可能與故障原因在同一行。
        const hasMachineCode = /(?:^|\s)(?:\d+\s+)?[A-Z0-9]+(?:-[A-Z0-9]+){2,}\.?(?=\s|$)/i.test(tableLines[i]);

        if (!hasMachineCode) continue;

        // 機器品號下一行通常就是序號；最多往後找 3 行。
        for (let j = i + 1; j <= Math.min(tableLines.length - 1, i + 3); j++) {
          const serialCandidate = tableLines[j].match(
            /^([A-Z0-9][A-Z0-9._-]{7,})(?=\s|$)/i
          );

          if (serialCandidate) {
            fields.serial = serialCandidate[1];
            break;
          }
        }

        if (fields.serial) break;
      }
    }
  }

  /*
   * 5. 案件編號／報修設備
   */
  const repairMatch = normalized.match(
    /客戶維修單號\s*[:：]?\s*(.*?)\s*-\s*(RR[A-Z0-9-]+)/i
  );

  if (repairMatch) {
    const repairPrefix = cleanValue(repairMatch[1]);
    fields.caseNumber = repairMatch[2];
    if (repairPrefix && !fields.model) {
      fields.model = repairPrefix;
    }
  }

  if (!fields.caseNumber) {
    const rrMatch = normalized.match(/\b(RR\d{6,})\b/i);
    if (rrMatch) {
      fields.caseNumber = rrMatch[1];
    }
  }

  /*
   * 若案件資料沒有提供設備名稱，才使用舊版 PA 型號規則。
   */
  if (!fields.model) {
    const modelMatch = normalized.match(/\b(PA\d+)(?=-[A-Z0-9.-]+|\b)/i);
    if (modelMatch) {
      fields.model = modelMatch[1];
    }
  }

  /*
   * 6. 故障原因／廠商檢測回覆
   *
   * 不再依賴設備序號的位置。
   * 直接找「9/29」這類故障日期到「客戶維修單號」以前，
   * 再以第一個「1.」切開：
   *   1. 前面 = 故障原因
   *   1. 開始 = 廠商檢測回覆
   */
  const issueBlockMatch = normalized.match(
    /\b9\/\d{1,2}\s+[\s\S]*?(?=\s*客戶維修單號)/i
  );

  if (issueBlockMatch) {
    const issueBlock = issueBlockMatch[0].trim();
    const inspectionIndex = issueBlock.search(/\s1\.\s*|^1\.\s*/);

    if (inspectionIndex >= 0) {
      const oneDotIndex = issueBlock.indexOf("1.", inspectionIndex);
      fields.problem = cleanIssueText(
        issueBlock.slice(0, oneDotIndex),
        fields.serial
      );
      fields.inspection = cleanIssueText(
        issueBlock.slice(oneDotIndex),
        fields.serial
      );
    } else {
      fields.problem = cleanIssueText(issueBlock, fields.serial);
    }
  }

  /* 備援：如果 PDF 沒有「客戶維修單號」緊接在檢測說明後面。 */
  if (!fields.problem) {
    const problemMatch = normalized.match(
      /\b(9\/\d{1,2}\s+.*?)(?=\s*1\.)/i
    );
    if (problemMatch) {
      fields.problem = cleanIssueText(problemMatch[1], fields.serial);
    }
  }

  if (!fields.inspection) {
    const inspectionMatch = normalized.match(
      /(\b1\.\s*[\s\S]*?)(?=\s*客戶維修單號)/i
    );
    if (inspectionMatch) {
      fields.inspection = cleanIssueText(inspectionMatch[1], fields.serial);
    }
  }

  /*
   * 9. 收費方式
   *
   * 如果 PDF 本身有「收費方式」欄位就擷取；
   * PDF 沒有提供時保持空白，不自行猜測。
   */
  fields.feeType = firstMatch(normalized, [
    /收費方式\s*[:：]?\s*(.*?)(?=更換零件|料號|品名|數量|單價|金額|客戶維修單號|$)/i
  ]) || "耗材收費";

  /*
   * 10. 品名／料號／數量／單價
   */
  const productNames = [];
  const partNumbers = [];
  const quantities = [];
  const unitPrices = [];

const lines = normalized
  .split("\n")
  .map(x => x.trim())
  .filter(Boolean);

for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
  const line = lines[lineIndex];
  /*
   * 產品列格式：
   *
   * 1 620079G. 上蓋模組 EA 1 3,060 3,060
   *
   * 2 401661G.SRP 玻璃保護貼 EA 1 250 250
   *
   * 3 1400-900072G. 厚電池 EA 1 1,800 1,800
   *
   * 4 BENCH SERVICE. 庫內維修 EA 1 1,000 1,000
   */

  const m = line.match(
    /^\s*\d+\s+((?:[A-Z0-9._-]+(?:\s+|$))+?)([\u3400-\u4dbf\u4e00-\u9fff].+?)\s+(EA|PCS|SET|個|件)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+[\d,]+(?:\.\d+)?\s*$/i
  );

  if (m) {
    /*
     * 料號
     * 最後面的 "." 自動刪除
     *
     * 620079G.       → 620079G
     * 1400-900072G.  → 1400-900072G
     * 401661G.SRP    → 401661G.SRP
     * BENCH SERVICE. → BENCH SERVICE
     */
    let partNumber = cleanValue(m[1])
      .replace(/\.+$/, "")
      .trim();

    // PDF 可能把料號最後一個字母拆到下一行，例如 .SR + P。
    const nextLine = lines[lineIndex + 1] || "";
    if (/^[A-Z0-9]{1,3}$/.test(nextLine) && /\.[A-Z0-9]+$/i.test(partNumber)) {
      partNumber += nextLine;
      lineIndex++;
    }

    /*
     * 品名
     */
    const name = cleanProductName(m[2]);

    /*
     * 單價
     *
     * 保留千分位：
     * 3060 → 3,060
     */
    const quantity = m[4].trim();

    const unitPrice = m[5]
      .replace(/,/g, "")
      .trim();

    if (
      partNumber &&
      name &&
      !/^(品名|單位|數量|單價|金額)$/i.test(name)
    ) {
      partNumbers.push(partNumber);
      quantities.push(quantity);
      unitPrices.push(
        Number(unitPrice).toLocaleString("en-US")
      );
      productNames.push(name);
    }
  }
}
  /*
   * 10. 品名備援
   */
  if (productNames.length === 0) {
    const candidates = [
      "上蓋模組",
      "玻璃保護貼",
      "厚電池",
      "庫內維修"
    ];

    for (const name of candidates) {
      if (normalized.includes(name)) {
        productNames.push(name);
      }
    }
  }

  fields.partNumbers = partNumbers.join("\n");
  fields.products = productNames.join("\n");
  fields.quantities = quantities.join("\n");
  fields.unitPrices = unitPrices.join("\n");

  return fields;
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
  const el = $("quotationFileName");
  if (!el) return;
  el.textContent = buildQuotationFileName() || "—";
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
    state.fields = parseQuotation(text);
    state.fields.fillDate = formatUploadDate(new Date());

    renderFields();
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
  state.rawText = "";
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

$("rawToggleBtn").addEventListener("click", () => {
  $("rawText").classList.toggle("hidden");
});
