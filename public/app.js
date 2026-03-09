function splitCodes(text) {
  return text
    .split(/[\n,]/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeDx(code) {
  return String(code || '').toUpperCase().replace(/\s/g, '');
}

function normalizeProc(code) {
  return String(code || '').toUpperCase().replace(/\s/g, '').replace(/\./g, '');
}

function formToPayload(form) {
  const fd = new FormData(form);
  const num = (key) => {
    const v = fd.get(key);
    return v === null || v === '' ? undefined : Number(v);
  };
  return {
    hcode: String(fd.get('hcode') || ''),
    an: String(fd.get('an') || ''),
    pdx: normalizeDx(fd.get('pdx')),
    sdx: splitCodes(normalizeDx(fd.get('sdx'))),
    proc: splitCodes(normalizeProc(fd.get('proc'))),
    sex: num('sex'),
    age: num('age'),
    ageDay: num('ageDay'),
    dateAdm: String(fd.get('dateAdm') || ''),
    timeAdm: String(fd.get('timeAdm') || '').replace(/[:.]/g, ''),
    dateDsc: String(fd.get('dateDsc') || ''),
    timeDsc: String(fd.get('timeDsc') || '').replace(/[:.]/g, ''),
    leaveDays: num('leaveDays') || 0,
    admWt: num('admWt'),
    source: 'ui',
  };
}

function showCodeNames(data) {
  const pdxNameEl = document.getElementById('pdx-name');
  const sdxNamesEl = document.getElementById('sdx-names');
  const procNamesEl = document.getElementById('proc-names');
  if (!data) {
    pdxNameEl.textContent = '-';
    sdxNamesEl.textContent = '-';
    procNamesEl.textContent = '-';
    return;
  }
  pdxNameEl.textContent = data.pdx?.code ? `${data.pdx.code}: ${data.pdx.name || '(ไม่พบชื่อ)'}` : '-';
  sdxNamesEl.textContent = data.sdx?.length
    ? data.sdx.map((v) => `${v.code}: ${v.name || '(ไม่พบชื่อ)'}`).join(' | ')
    : '-';
  procNamesEl.textContent = data.proc?.length
    ? data.proc.map((v) => `${v.code}: ${v.name || '(ไม่พบชื่อ)'}`).join(' | ')
    : '-';
}

async function lookupCodeNames() {
  const pdxInput = document.querySelector('input[name="pdx"]');
  const sdxInput = document.querySelector('textarea[name="sdx"]');
  const procInput = document.querySelector('textarea[name="proc"]');
  const payload = {
    pdx: normalizeDx(pdxInput.value),
    sdx: splitCodes(normalizeDx(sdxInput.value)),
    proc: splitCodes(normalizeProc(procInput.value)),
  };
  try {
    const resp = await fetch('http://localhost:3000/code-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    if (!json.ok) {
      showCodeNames(null);
      return;
    }
    showCodeNames(json.data);
  } catch (_error) {
    showCodeNames(null);
  }
}

function showSummary(data) {
  const el = document.getElementById('summary');
  el.classList.remove('hidden');
  el.innerHTML = `
    <h3>Result summary</h3>
    <p><b>DRG:</b> ${data.drg} | <b>MDC:</b> ${data.mdc} | <b>DC:</b> ${data.dc}</p>
    <p><b>DRG Description:</b> ${data.drgDescription || '-'}</p>
    <p><b>Warnings:</b> ${data.warningCodeSum || 0} ${data.warnings?.length ? `| ${data.warnings.map((w) => `${w.code} ${w.name}: ${w.description}`).join(' ; ')}` : ''}</p>
    <p><b>RW:</b> ${data.rw} | <b>AdjRW:</b> ${data.adjrw} | <b>CMI:</b> ${data.cmi}</p>
    <p><b>WtLOS:</b> ${data.wtlos} | <b>OT:</b> ${data.ot} | <b>Rw0Day:</b> ${data.rw0day} | <b>LOS:</b> ${data.los}</p>
  `;
}

function showTrace(trace) {
  const el = document.getElementById('trace');
  el.classList.remove('hidden');
  el.innerHTML = '<h3>Analysis steps</h3>' + trace.map((t) => `
    <div class="trace-step ${t.status}">
      <div><b>${t.step}</b> (${t.status})</div>
      <pre>${JSON.stringify(t.details, null, 2)}</pre>
    </div>
  `).join('');
}

document.getElementById('drg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const payload = formToPayload(form);
  const summary = document.getElementById('summary');
  const trace = document.getElementById('trace');
  const raw = document.getElementById('raw');
  const analyzeBtn = document.getElementById('analyze-btn');
  const loadingSpinner = document.getElementById('loading-spinner');

  summary.classList.add('hidden');
  summary.innerHTML = '';
  trace.classList.add('hidden');
  trace.innerHTML = '';
  raw.textContent = '';
  analyzeBtn.disabled = true;
  loadingSpinner.classList.remove('hidden');
  raw.classList.add('hidden');

  try {
    const resp = await fetch('http://localhost:3000/drg-grouper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    const requestAndResponse = { request: payload, response: json };

    if (!json.ok) {
      raw.classList.remove('hidden');
      if (json.error_code) {
        raw.innerHTML = `<div class="error">DRG Error ${json.error_code} (${json.error_name}): ${json.error_description}</div>\n\nRequest\n${JSON.stringify(payload, null, 2)}\n\nResponse\n${JSON.stringify(json, null, 2)}`;
        // raw.innerHTML = `<div class="error">DRG Error ${json.error_code} (${json.error_name}): ${json.error_description}</div>\n\n${JSON.stringify(requestAndResponse, null, 2)}`;
        return;
      }
      raw.textContent = JSON.stringify(requestAndResponse, null, 2);
      return;
    }

    showSummary(json.data);
    showTrace(json.data.trace || []);
    raw.classList.remove('hidden');
    raw.textContent = JSON.stringify(requestAndResponse, null, 2);
    raw.innerHTML = `<span class="title">Request</span>\n${JSON.stringify(payload, null, 2)}\n\n<span class="title">Response</span>\n${JSON.stringify(json, null, 2)}`;
  } catch (error) {
    raw.classList.remove('hidden');
    raw.innerHTML = `<div class="error">Request failed: ${error instanceof Error ? error.message : 'Unknown error'}</div>`;
  } finally {
    analyzeBtn.disabled = false;
    loadingSpinner.classList.add('hidden');
  }
});

document.querySelector('input[name="pdx"]').addEventListener('change', lookupCodeNames);
document.querySelector('textarea[name="sdx"]').addEventListener('change', lookupCodeNames);
document.querySelector('textarea[name="proc"]').addEventListener('change', lookupCodeNames);
lookupCodeNames();
