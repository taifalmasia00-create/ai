const FN_URL = window.APP_CONFIG.SUPABASE_FUNCTIONS_URL;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileChip = document.getElementById('fileChip');
const fileName = document.getElementById('fileName');
const rowCountEl = document.getElementById('rowCount');

const stationConfig = document.getElementById('station-config');
const sourceColumnsGrid = document.getElementById('sourceColumnsGrid');
const targetsList = document.getElementById('targetsList');
const addTargetBtn = document.getElementById('addTargetBtn');
const headersListEl = document.getElementById('headersList');
const startBtn = document.getElementById('startBtn');
const etaNote = document.getElementById('etaNote');

const stationBelt = document.getElementById('station-belt');
const beltFill = document.getElementById('beltFill');
const progressCount = document.getElementById('progressCount');
const progressPct = document.getElementById('progressPct');
const beltStatus = document.getElementById('beltStatus');
const quotaPause = document.getElementById('quotaPause');
const quotaPauseText = document.getElementById('quotaPauseText');
const resumeBtn = document.getElementById('resumeBtn');
const downloadPartialBtn = document.getElementById('downloadPartialBtn');
const newApiKeyInput = document.getElementById('newApiKeyInput');
const useNewKeyBtn = document.getElementById('useNewKeyBtn');

const stationDone = document.getElementById('station-done');
const downloadBtn = document.getElementById('downloadBtn');

const errorBox = document.getElementById('errorBox');
const logoutBtn = document.getElementById('logoutBtn');

let currentJobId = null;
let currentRowCount = 0;
let currentHeaders = [];
const MAX_TARGETS = 6;

// مفتاح Gemini API جديد المستخدم حطه أثناء الوقفة (لو حصلت) — بيتبعت مع
// نداء process-step الجاي بس، وبعد كده السيرفر بيحفظه على الوظيفة ويستخدمه
// تلقائي في كل الخطوات اللي بعدها.
let pendingApiKey = null;

// ---------- حفظ رقم الشغلانة في الجهاز عشان لو النت قطع أو الصفحة اتقفلت نقدر نكمل ----------
const JOB_STORAGE_KEY = 'itqan_current_job';

function saveJobState(stage) {
  try {
    localStorage.setItem(
      JOB_STORAGE_KEY,
      JSON.stringify({ jobId: currentJobId, stage, rowCount: currentRowCount }),
    );
  } catch (e) {
    // مفيش localStorage؟ متهمش، بس المعالجة مش هتكمل تلقائي لو حصل قطع
  }
}

function clearJobState() {
  try {
    localStorage.removeItem(JOB_STORAGE_KEY);
  } catch (e) {}
}

function loadJobState() {
  try {
    const raw = localStorage.getItem(JOB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function getToken() {
  return localStorage.getItem('app_token') || '';
}

function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, 'x-app-token': token } : extra;
}

// api() بترجع خطأ فيه isRetryable=true لو المشكلة مؤقتة (قطع نت، أو خطأ
// سيرفر عابر زي Cloudflare 520/502/503/504) — الحالات دي مش خطأ حقيقي في
// بياناتك أو إعداداتك، وغالباً بتزول لوحدها لو جربنا تاني بعد لحظات.
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${FN_URL}/${path}`, {
      ...options,
      headers: authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
    });
  } catch (networkErr) {
    // لو الجهاز نفسه فعلاً أوفلاين، ده سبب واضح. لو لأ (يعني عندك نت
    // شغال زي ما يوضحه navigator.onLine)، الأرجح إن الانقطاع مؤقت من
    // ناحية السيرفر مش من ناحيتك — بنوضح الفرق للمستخدم بدل ما نتهم نته دايماً.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const e = new Error(
      offline
        ? 'مفيش اتصال إنترنت على الجهاز دلوقتي'
        : 'تعذر الوصول للسيرفر مؤقتاً (مش بالضرورة مشكلة في نتك)',
    );
    e.isRetryable = true;
    throw e;
  }

  // أخطاء سيرفر/بنية تحتية مؤقتة (زي صفحة Cloudflare 520 اللي بترجع HTML
  // مش JSON) — نعاملها كقطع اتصال عابر بدل ما نوقف الشغلانة كلها
  if (res.status >= 500) {
    const e = new Error(`انقطاع مؤقت في الاتصال بالسيرفر (كود ${res.status})`);
    e.isRetryable = true;
    throw e;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حصل خطأ غير متوقع');
  return data;
}

function toArabicDigits(n) {
  return String(n).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
}

// بيحول عدد الدقايق لنص "س دقيقة" أو "س ساعة و س دقيقة" لو الرقم كبير
function formatMinutes(totalMinutes) {
  const mins = Math.ceil(totalMinutes);
  if (mins < 60) return `${toArabicDigits(mins)} دقيقة`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0
    ? `${toArabicDigits(hours)} ساعة و ${toArabicDigits(rem)} دقيقة`
    : `${toArabicDigits(hours)} ساعة`;
}

function showError(msg) {
  errorBox.hidden = false;
  errorBox.textContent = msg;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

// ---------- التحقق من تسجيل الدخول ----------
(async function checkAuthStatus() {
  try {
    const data = await api('auth-status', { method: 'GET' });
    if (data.passwordRequired) {
      logoutBtn.hidden = false;
      if (!data.loggedIn) {
        window.location.href = 'login.html';
        return;
      }
    }
    // بعد ما نتأكد إن الدخول تمام، نشوف لو فيه شغلانة واقفة نكملها
    tryResumeJob();
  } catch (err) {
    // تجاهل، مش حرج لعرض الصفحة
    tryResumeJob();
  }
})();

// ---------- استكمال شغلانة كانت شغالة قبل ما الصفحة تتقفل أو النت يقطع ----------
function tryResumeJob() {
  const saved = loadJobState();
  if (!saved || !saved.jobId) return;

  currentJobId = saved.jobId;
  currentRowCount = saved.rowCount || 0;

  if (saved.stage === 'done') {
    stationDone.hidden = false;
    stationDone.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (saved.stage === 'processing') {
    stationBelt.hidden = false;
    beltStatus.textContent = 'رجعنا نكمل من حيث ما وقفنا…';
    stationBelt.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pollStep();
  }
}

logoutBtn.addEventListener('click', async () => {
  try {
    await api('logout', { method: 'POST' });
  } finally {
    localStorage.removeItem('app_token');
    window.location.href = 'login.html';
  }
});

// ---------- Drag & drop ----------
['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag-over'); })
);
dropzone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

// بيحول الملف لـ base64 عشان نبعته زي ما هو للسيرفر (نفس البايتات بالظبط)
async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000; // تقسيم عشان نتفادى حدود String.fromCharCode.apply مع ملفات كبيرة
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------- رفع نفس ملف الإكسيل زي ما هو (بايتات خام) للسيرفر ----------
// الملف مش بيتفكك لـ JSON هنا؛ السيرفر هو اللي بيفتحه، وهو نفسه اللي هيتعدل
// عليه وهيرجع تاني بعد المعالجة — مفيش نسخة تانية بتتبني من الصفر.
async function handleFile(file) {
  clearError();
  clearJobState(); // ملف جديد = شغلانة جديدة، امسح أي رقم شغلانة قديم محفوظ

  try {
    const fileBase64 = await fileToBase64(file);

    const data = await api('upload', {
      method: 'POST',
      body: JSON.stringify({ fileBase64, fileName: file.name }),
    });

    currentJobId = data.jobId;
    currentRowCount = data.rowCount;

    fileName.textContent = file.name;
    rowCountEl.textContent = `${toArabicDigits(data.rowCount)} صف`;
    fileChip.hidden = false;

    populateColumns(data.headers);
    stationConfig.hidden = false;
    stationConfig.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError(err.message);
  }
}

function populateColumns(headers) {
  currentHeaders = headers;

  sourceColumnsGrid.innerHTML = '';
  headers.forEach((h, idx) => {
    const label = document.createElement('label');
    label.className = 'checkbox-item';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = h;
    input.checked = idx === 0; // اختار أول عمود افتراضياً عشان المستخدم ميبتديش من فاضي

    const span = document.createElement('span');
    span.textContent = h;

    input.addEventListener('change', () => {
      label.classList.toggle('is-checked', input.checked);
    });
    if (input.checked) label.classList.add('is-checked');

    label.appendChild(input);
    label.appendChild(span);
    sourceColumnsGrid.appendChild(label);
  });

  headersListEl.innerHTML = '';
  headers.forEach(h => headersListEl.appendChild(new Option(h, h)));

  targetsList.innerHTML = '';
  addTargetRow();
  updateAddTargetBtnState();
}

function addTargetRow() {
  if (targetsList.children.length >= MAX_TARGETS) return;

  const row = document.createElement('div');
  row.className = 'target-row';

  const head = document.createElement('div');
  head.className = 'target-row-head';

  const colInput = document.createElement('input');
  colInput.type = 'text';
  colInput.className = 'target-column-input';
  colInput.setAttribute('list', 'headersList');
  colInput.placeholder = 'اسم العمود (موجود أو جديد)';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-target-btn';
  removeBtn.textContent = '✕';
  removeBtn.title = 'احذف عمود الهدف ده';
  removeBtn.addEventListener('click', () => {
    if (targetsList.children.length <= 1) return; // سيب عمود هدف واحد على الأقل
    row.remove();
    updateAddTargetBtnState();
  });

  head.appendChild(colInput);
  head.appendChild(removeBtn);

  const instrInput = document.createElement('textarea');
  instrInput.className = 'target-instruction-input';
  instrInput.rows = 5;
  instrInput.maxLength = 20000;
  instrInput.placeholder = 'قول للذكاء الاصطناعي عايزه يكتب ايه في العمود ده بالظبط — تقدر تكتب برومبت مفصّل قد ما تحب';

  row.appendChild(head);
  row.appendChild(instrInput);
  targetsList.appendChild(row);
  updateAddTargetBtnState();
}

function updateAddTargetBtnState() {
  addTargetBtn.disabled = targetsList.children.length >= MAX_TARGETS;
}

addTargetBtn.addEventListener('click', () => addTargetRow());

function collectSourceColumns() {
  return Array.from(sourceColumnsGrid.querySelectorAll('input[type="checkbox"]:checked')).map(el => el.value);
}

function collectTargets() {
  return Array.from(targetsList.children).map(row => ({
    column: row.querySelector('.target-column-input').value.trim(),
    instruction: row.querySelector('.target-instruction-input').value.trim(),
  }));
}

// ---------- بدء المعالجة ----------
startBtn.addEventListener('click', async () => {
  clearError();

  const sourceColumns = collectSourceColumns();
  if (sourceColumns.length === 0) {
    showError('اختار عمود مصدر واحد على الأقل');
    return;
  }

  const targets = collectTargets();
  if (targets.some(t => !t.column || !t.instruction)) {
    showError('كل عمود هدف لازم يكون له اسم وتعليمات');
    return;
  }
  const targetCols = targets.map(t => t.column);
  if (new Set(targetCols).size !== targetCols.length) {
    showError('في عمود هدف مكرر أكتر من مرة، خليه اسم مختلف');
    return;
  }

  startBtn.disabled = true;
  const estSeconds = currentRowCount * targets.length * 4.2;
  etaNote.textContent = `الوقت المتوقع تقريباً: ${formatMinutes(estSeconds / 60)} (بسبب حدود الـ API المجاني)`;

  try {
    await api('start-process', {
      method: 'POST',
      body: JSON.stringify({
        jobId: currentJobId,
        sourceColumns,
        targets,
      }),
    });

    stationBelt.hidden = false;
    quotaPause.hidden = true;
    stationBelt.scrollIntoView({ behavior: 'smooth', block: 'start' });
    saveJobState('processing');
    pollStep();
  } catch (err) {
    showError(err.message);
    startBtn.disabled = false;
  }
});

// ---------- المعالجة صف بصف (كل نداء process-step بيعالج خطوة واحدة، ويعدّل
// خلية واحدة في نفس ملف الإكسيل الأصلي ويحفظه) ----------
let reconnectAttempts = 0;
const MAX_AUTO_RETRIES = 10;

async function pollStep() {
  try {
    const payload = { jobId: currentJobId };
    if (pendingApiKey) {
      payload.apiKey = pendingApiKey;
      pendingApiKey = null; // بيتبعت مرة واحدة، السيرفر بيحفظه على الوظيفة
    }

    const data = await api('process-step', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    reconnectAttempts = 0; // الاتصال رجع تمام، صفّر عداد المحاولات

    const pct = data.total ? Math.round((data.processed / data.total) * 100) : 0;
    beltFill.style.width = pct + '%';
    progressCount.textContent = `${toArabicDigits(data.processed)} / ${toArabicDigits(data.total)}`;
    progressPct.textContent = `٪${toArabicDigits(pct)}`;

    if (data.paused) {
      beltStatus.textContent = 'الأداة واقفة مؤقتاً بسبب حد استخدام Gemini';
      quotaPauseText.textContent = data.message || 'وصلت لحد الطلبات المسموح بيه دلوقتي.';
      resumeBtn.textContent = 'استكمل المعالجة';
      quotaPause.hidden = false;
      return; // وقّف الـ polling التلقائي، المستخدم هيكمل بنفسه من الزرار
    }

    quotaPause.hidden = true;

    if (data.status === 'error') {
      showError('حصل خطأ أثناء المعالجة: ' + data.error);
      startBtn.disabled = false;
      clearJobState();
      return;
    }

    if (data.status === 'done') {
      beltStatus.textContent = 'تمام، خلصنا كل الصفوف';
      quotaPause.hidden = true;
      stationDone.hidden = false;
      saveJobState('done');
      stationDone.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (data.etaSeconds) {
      beltStatus.textContent = `متبقي تقريباً ${formatMinutes(data.etaSeconds / 60)}…`;
    }

    setTimeout(pollStep, data.pollAfterMs || 4300);
  } catch (err) {
    // مشكلة مؤقتة (قطع نت أو خطأ سيرفر عابر زي Cloudflare 520)؟ جرّب تاني
    // لوحدك كذا مرة من غير ما توقف الشغلانة أو تحتاج تتدخل يدوي
    if (err.isRetryable && reconnectAttempts < MAX_AUTO_RETRIES) {
      reconnectAttempts++;
      const delay = Math.min(30000, 3000 * reconnectAttempts); // 3, 6, 9, 12, 15 ثانية
      beltStatus.textContent = `انقطاع مؤقت في الاتصال، بنحاول تاني تلقائي (محاولة ${toArabicDigits(reconnectAttempts)} من ${toArabicDigits(MAX_AUTO_RETRIES)})…`;
      setTimeout(pollStep, delay);
      return;
    }

    if (err.isRetryable) {
      beltStatus.textContent = 'فيه مشكلة مستمرة في الوصول للسيرفر';
      quotaPauseText.textContent = err.message + '. جربنا نتصل تلقائي كذا مرة ومكملناش. الشغلانة محفوظة وهتكمل من نفس المكان — دوس الزرار لما تحب تجرب تاني.';
      resumeBtn.textContent = 'حاول تاني';
      quotaPause.hidden = false;
      return;
    }

    showError(err.message);
    startBtn.disabled = false;
  }
}

resumeBtn.addEventListener('click', () => {
  quotaPause.hidden = true;
  reconnectAttempts = 0;
  pollStep();
});

useNewKeyBtn.addEventListener('click', () => {
  const key = newApiKeyInput.value.trim();
  if (!key) {
    showError('الصق مفتاح Gemini API الأول');
    return;
  }
  clearError();
  pendingApiKey = key;
  newApiKeyInput.value = '';
  quotaPause.hidden = true;
  reconnectAttempts = 0;
  beltStatus.textContent = 'بنجرب بالمفتاح الجديد…';
  pollStep();
});

// ---------- تحميل الملف (نفس الملف اللي رفعته، بعد التعديل) ----------
// نفس الدالة بتتستخدم في حالتين: زرار "تحميل الملف النهائي" لما الشغلانة
// تخلص كلها، وزرار "تحميل اللي اتعالج لحد دلوقتي" لو المعالجة وقفت في النص
// (قطع نت / وصلنا لحد Gemini). الملف على السيرفر بيتحفظ بعد كل صف بيتعالج،
// يعني حتى لو الشغلانة لسه شغالة، تنزيله بيرجّعلك الأعمدة اللي خلصت فعلاً
// والباقي لسه فاضي، بدون ما يأثر على استكمال المعالجة بعدين.
async function downloadFile(triggerBtn) {
  clearError();
  triggerBtn.disabled = true;
  try {
    const res = await fetch(`${FN_URL}/download?jobId=${encodeURIComponent(currentJobId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'فشل تحميل الملف');
    }

    // بناخد اسم الملف من هيدر Content-Disposition اللي بعته السيرفر (نفس
    // اسم الملف الأصلي غالباً) بدل اسم ثابت
    let downloadName = 'نتيجة-المعالجة.xlsx';
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) downloadName = match[1];

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(err.message);
  } finally {
    triggerBtn.disabled = false;
  }
}

downloadBtn.addEventListener('click', () => downloadFile(downloadBtn));
downloadPartialBtn.addEventListener('click', () => downloadFile(downloadPartialBtn));
