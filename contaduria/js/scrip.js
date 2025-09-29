// app.js — Conciliador con soporte XML/PDF/CSV
// Nota: PDF es heurístico. Para máxima precisión, acompaña con CSV.

// ========= UTILIDADES BASE =========
function parseCSV(text) {
    const lines = text.replace(/\r/g,'').split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) return [];
    const headers = splitCSVLine(lines[0]);
    const rows = lines.slice(1).map(line => {
      const parts = splitCSVLine(line);
      const obj = {};
      for (let i=0;i<headers.length;i++){
        obj[headers[i]] = (parts[i] || '').trim();
      }
      return obj;
    });
    return rows;
  }
  function splitCSVLine(line){
    // maneja comillas "valor, con, comas"
    const res=[]; let cur=''; let inQ=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c === '"' ){
        if(inQ && line[i+1] === '"'){ cur+='"'; i++; }
        else inQ = !inQ;
      } else if(c === ',' && !inQ){
        res.push(cur); cur='';
      } else {
        cur+=c;
      }
    }
    res.push(cur);
    return res.map(x=>x.trim());
  }
  
  function normalizeHeaderKey(k){
    if(!k) return '';
    return k.toString().trim().toLowerCase()
      .replace(/\s+/g,'')
      .replace(/[^a-z0-9]/g,'');
  }
  function normalizeObjectKeys(obj){
    const out = {};
    for (const k in obj) out[normalizeHeaderKey(k)] = obj[k];
    return out;
  }
  function parseDate(s){
    if(!s) return null;
    s = String(s).trim();
    // ISO
    const d1 = new Date(s);
    if(!isNaN(d1)) return d1;
    // DD/MM/YYYY
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if(m){
      const d = new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
      if(!isNaN(d)) return d;
    }
    return null;
  }
  function toNumber(s){
    if (s === null || s === undefined) return NaN;
    const cleaned = String(s).replace(/\s/g,'')
      .replace(/[^\d\.\-]/g,'')
      .replace(/(\..*)\./g,'$1'); // evitar dobles puntos
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }
  function daysBetween(d1,d2){
    const ms = Math.abs(d1 - d2);
    return Math.round(ms / (1000*60*60*24));
  }
  function rowDate(d){
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function escapeHtml(str){
    return String(str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]));
  }
  
  // ========= PARSERS DE FORMATO =========
  
  // --- XML CFDI (3.3/4.0) ---
  async function parseCFDI_XML(text){
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");
  
    // namespaces posibles
    // comprobante: cfdi:Comprobante
    // timbre: tfd:TimbreFiscalDigital
    const comp = xml.getElementsByTagNameNS("*","Comprobante")[0] || xml.getElementsByTagName("cfdi:Comprobante")[0];
    if(!comp) return [];
  
    const version = comp.getAttribute("Version") || comp.getAttribute("version") || "";
    const serie = comp.getAttribute("Serie") || comp.getAttribute("serie") || "";
    const folio = comp.getAttribute("Folio") || comp.getAttribute("folio") || "";
    const fecha = comp.getAttribute("Fecha") || comp.getAttribute("fecha") || "";
    // En CFDI 3.3/4.0 el atributo es "Total" (ojo mayúscula)
    const total = comp.getAttribute("Total") || comp.getAttribute("total") || "";
  
    const receptor = xml.getElementsByTagNameNS("*","Receptor")[0] || xml.getElementsByTagName("cfdi:Receptor")[0];
    const rfcReceptor = receptor ? (receptor.getAttribute("Rfc") || receptor.getAttribute("rfc") || "") : "";
  
    // UUID en TimbreFiscalDigital
    let uuid = "";
    const timbre = xml.getElementsByTagNameNS("*","TimbreFiscalDigital")[0] || xml.getElementsByTagName("tfd:TimbreFiscalDigital")[0];
    if (timbre) uuid = timbre.getAttribute("UUID") || timbre.getAttribute("Uuid") || "";
  
    const invoiceNumber = (serie || "") + (folio ? (serie ? "-" : "") + folio : "");
    const amount = toNumber(total);
    const date = parseDate(fecha);
  
    return [{
      invoiceNumber: uuid || invoiceNumber || "", // prioriza UUID si existe
      invoiceDate: date,
      invoiceAmount: amount,
      client: rfcReceptor || "",
      source: "xml"
    }];
  }
  
  // --- PDF (facturas o estado de cuenta) usando PDF.js ---
  async function extractPDFText(file){
    if (!window['pdfjsLib']) throw new Error("PDF.js no está cargado");
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let p=1; p<=pdf.numPages; p++){
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      fullText += content.items.map(it => it.str).join(" ") + "\n";
    }
    return fullText;
  }
  
  // Heurísticas para PDF de FACTURAS → filas tipo { invoiceNumber, invoiceDate, invoiceAmount, client }
  function parseInvoicePDFText(txt){
    const rows = [];
    // Busca UUID (CFDI)
    const uuidRegex = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/i;
    const folioRegex = /\b(Folio|Factura|No\.? Factura|Folio Fiscal)\s*[:#]?\s*([A-Z0-9\-]{4,})/i;
    const dateRegex = /\b(\d{2}\/\d{2}\/\d{4}|\d{4}\-\d{2}\-\d{2})\b/;
    const amountRegex = /\$?\s?([0-9]{1,3}(?:[.,][0-9]{3})*(?:\.[0-9]{2})|\d+\.\d{2})/;
  
    const uuid = (txt.match(uuidRegex) || [])[0] || "";
    const folio = (txt.match(folioRegex) || [,"",""])[2] || "";
    const date = parseDate((txt.match(dateRegex) || [])[0] || "");
    const amtRaw = (txt.match(amountRegex) || [,""])[1];
    const amount = toNumber(amtRaw);
  
    const clientMatch = txt.match(/\b(RFC|Cliente|Receptor)\s*[:#]?\s*([A-Z0-9&\-]{6,13})/i);
    const client = clientMatch ? clientMatch[2] : "";
  
    if (uuid || folio || (!Number.isNaN(amount) && date)) {
      rows.push({
        invoiceNumber: uuid || folio || "",
        invoiceDate: date || null,
        invoiceAmount: amount,
        client,
        source: "pdf"
      });
    }
    return rows;
  }
  
  // Heurísticas para PDF de ESTADO DE CUENTA → filas tipo movimientos { reference, date, amount, description }
  function parseStatementPDFText(txt){
    const lines = txt.split(/\n/).map(l=>l.trim()).filter(Boolean);
    const rows = [];
    // Regla: intenta capturar "Fecha ... Descripción ... Monto"
    const dateRegex = /\b(\d{2}\/\d{2}\/\d{4}|\d{4}\-\d{2}\-\d{2})\b/;
    const amountRegex = /(-?\$?\s?[0-9]{1,3}(?:[.,][0-9]{3})*(?:\.[0-9]{2})|-?\d+\.\d{2})/;
  
    for (const ln of lines){
      const dm = ln.match(dateRegex);
      const am = ln.match(amountRegex);
      if (dm && am){
        const date = parseDate(dm[0]);
        const amount = toNumber(am[0]);
        // referencia: lo que quede sin fecha/monto
        const ref = ln.replace(dm[0],'').replace(am[0],'').trim();
        rows.push({
          reference: ref || "movimiento",
          date,
          amount,
          description: ref
        });
      } else {
        // fallback: busca posibles "Folio/Factura XXXX" + monto
        const folioMatch = ln.match(/\b(Factura|Folio|Ref)\s*[:#]?\s*([A-Z0-9\-]{4,})/i);
        const am2 = ln.match(amountRegex);
        if (folioMatch && am2){
          rows.push({
            reference: folioMatch[2],
            date: null,
            amount: toNumber(am2[0]),
            description: ln
          });
        }
      }
    }
    return rows;
  }
  
  // --- XML de ESTADO (si existiera) => lo tratamos como genérico: date/amount/reference ---
  async function parseGeneric_XML(text){
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");
    const items = Array.from(xml.getElementsByTagName("*"));
    const rows = [];
    // Busca nodos que tengan al menos dos de: fecha/monto/referencia
    items.forEach(node => {
      const attrs = node.attributes ? Array.from(node.attributes) : [];
      const map = {};
      attrs.forEach(a => { map[normalizeHeaderKey(a.name)] = a.value; });
      const date = parseDate(map['fecha'] || map['date']);
      const amount = toNumber(map['amount'] || map['monto'] || map['importe']);
      const reference = map['reference'] || map['referencia'] || map['ref'] || "";
      if (reference || (!Number.isNaN(amount)) || date){
        rows.push({ reference: reference || "", date: date || null, amount: amount, description: node.nodeName });
      }
    });
    return rows;
  }
  
  // ========= MATCHING =========
  function matchInvoices(invoices, movements, dayTolerance = 3, amountTolerance = 0.01) {
    const results = invoices.map((inv, i) => ({
      idx: i+1,
      invoiceNumber: inv.invoiceNumber || "",
      invoiceDate: inv.invoiceDate || null,
      invoiceAmount: inv.invoiceAmount,
      client: inv.client || "",
      matched: false,
      matchedMovement: null,
      source: inv.source || ""
    }));
  
    const movs = movements.map(m => ({
      reference: m.reference || m.description || "",
      date: m.date || null,
      amount: m.amount,
      description: m.description || "",
      used: false
    }));
  
    // 1) por número/UUID en referencia
    for (const r of results){
      if (!r.invoiceNumber) continue;
      for (const m of movs){
        if (m.used) continue;
        if (!m.reference) continue;
        if (m.reference.includes(r.invoiceNumber) || r.invoiceNumber.includes(m.reference)){
          const amtOk = (Number.isNaN(r.invoiceAmount) || Number.isNaN(m.amount)) ? true : Math.abs(r.invoiceAmount - m.amount) <= amountTolerance;
          if (amtOk){
            r.matched = true;
            r.matchedMovement = m;
            m.used = true;
            break;
          }
        }
      }
    }
  
    // 2) por monto + fecha
    for (const r of results){
      if (r.matched) continue;
      if (Number.isNaN(r.invoiceAmount)) continue;
      for (const m of movs){
        if (m.used) continue;
        if (Number.isNaN(m.amount)) continue;
        if (Math.abs(r.invoiceAmount - m.amount) <= amountTolerance){
          if (r.invoiceDate && m.date){
            if (daysBetween(r.invoiceDate, m.date) <= dayTolerance){
              r.matched = true; r.matchedMovement = m; m.used = true; break;
            }
          } else {
            r.matched = true; r.matchedMovement = m; m.used = true; break;
          }
        }
      }
    }
  
    return { results, movs };
  }
  
  // ========= UI =========
  const invoicesFilesInput = document.getElementById('invoicesFiles');
  const statementFilesInput = document.getElementById('statementFiles');
  const parseBtn = document.getElementById('parseBtn');
  const resultsTableBody = document.querySelector('#resultsTable tbody');
  const filterSelect = document.getElementById('filterSelect');
  const summaryDiv = document.getElementById('summary');
  const exportBtn = document.getElementById('exportBtn');
  const dayToleranceInput = document.getElementById('dayTolerance');
  const amountToleranceInput = document.getElementById('amountTolerance');
  
  let lastResults = null;
  
  function renderTable(results, filter='all'){
    resultsTableBody.innerHTML = '';
    let count = 0;
    for (const r of results){
      const show = (filter==='all') || (filter==='matched' && r.matched) || (filter==='unmatched' && !r.matched);
      if(!show) continue;
      count++;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.idx}</td>
        <td>${escapeHtml(r.invoiceNumber || '')} <small>${escapeHtml(r.source)}</small></td>
        <td>${r.invoiceDate ? rowDate(r.invoiceDate) : ''}</td>
        <td>${!Number.isNaN(r.invoiceAmount) && r.invoiceAmount!==undefined ? r.invoiceAmount.toFixed(2) : ''}</td>
        <td><small>${escapeHtml(r.client || '')}</small></td>
        <td class="${r.matched ? 'status-matched' : 'status-unmatched'}">${r.matched ? 'Conciliada' : 'No conciliada'}</td>
        <td>${r.matchedMovement ? escapeHtml(r.matchedMovement.reference) : ''}</td>
        <td>${r.matchedMovement && r.matchedMovement.date ? rowDate(r.matchedMovement.date) : ''}</td>
        <td>${r.matchedMovement && !Number.isNaN(r.matchedMovement.amount) ? r.matchedMovement.amount.toFixed(2) : ''}</td>
        <td><button class="btn-mark">${r.matched ? 'Marcar No' : 'Marcar Sí'}</button></td>
      `;
      tr.querySelector('.btn-mark').addEventListener('click', () => {
        r.matched = !r.matched;
        renderTable(results, filterSelect.value);
        renderSummary(results);
        exportBtn.disabled = results.filter(x => !x.matched).length === 0;
      });
      resultsTableBody.appendChild(tr);
    }
    if(count === 0){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="10" style="text-align:center;color:var(--muted)">Sin resultados en este filtro.</td>`;
      resultsTableBody.appendChild(tr);
    }
  }
  function renderSummary(results){
    const total = results.length;
    const matched = results.filter(r => r.matched).length;
    const unmatched = total - matched;
    summaryDiv.innerHTML = `<strong>Total facturas:</strong> ${total} — <span class="status-matched">${matched} conciliadas</span> — <span class="status-unmatched">${unmatched} no conciliadas</span>`;
  }
  function exportUnmatchedToCSV(results){
    const unmatched = results.filter(r => !r.matched);
    if (unmatched.length === 0){ alert('No hay facturas no conciliadas.'); return; }
    const headers = ['invoiceNumber','invoiceDate','invoiceAmount','client','status'];
    const lines = [headers.join(',')];
    for (const u of unmatched){
      const row = [
        `"${(u.invoiceNumber || '').toString().replace(/"/g,'""')}"`,
        u.invoiceDate ? rowDate(u.invoiceDate) : '',
        (!Number.isNaN(u.invoiceAmount) && u.invoiceAmount!==undefined) ? u.invoiceAmount.toFixed(2) : '',
        `"${(u.client || '').toString().replace(/"/g,'""')}"`,
        'no_conciliada'
      ];
      lines.push(row.join(','));
    }
    const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facturas_no_conciliadas_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  
  // ========= CARGA DE ARCHIVOS =========
  async function readAsText(file){
    return new Promise((res,rej) => {
      const fr = new FileReader();
      fr.onload = e => res(e.target.result);
      fr.onerror = e => rej(e);
      fr.readAsText(file, 'UTF-8');
    });
  }
  
  async function parseInvoicesFiles(files){
    const out = [];
    for (const f of files){
      const ext = f.name.split('.').pop().toLowerCase();
      try{
        if (ext === 'csv'){
          const rows = parseCSV(await readAsText(f));
          rows.forEach(r => {
            const n = normalizeObjectKeys(r);
            out.push({
              invoiceNumber: n.invoicenumber || n.invoice || n.folio || n.uuid || '',
              invoiceDate: parseDate(n.date || n.fecha || ''),
              invoiceAmount: toNumber(n.amount || n.total || n.importe || ''),
              client: n.client || n.cliente || n.rfc || '',
              source: 'csv'
            });
          });
        } else if (ext === 'xml'){
          const text = await readAsText(f);
          const rows = await parseCFDI_XML(text);
          rows.forEach(r => out.push(r));
        } else if (ext === 'pdf'){
          const txt = await extractPDFText(f);
          const rows = parseInvoicePDFText(txt);
          rows.forEach(r => out.push(r));
        }
      } catch (e){
        console.warn('Error leyendo factura', f.name, e);
      }
    }
    return out;
  }
  
  async function parseStatementFiles(files){
    const out = [];
    for (const f of files){
      const ext = f.name.split('.').pop().toLowerCase();
      try{
        if (ext === 'csv'){
          const rows = parseCSV(await readAsText(f));
          rows.forEach(r => {
            const n = normalizeObjectKeys(r);
            out.push({
              reference: n.reference || n.ref || n.descripcion || n.description || '',
              date: parseDate(n.date || n.fecha || ''),
              amount: toNumber(n.amount || n.monto || n.importe || ''),
              description: n.description || n.descripcion || ''
            });
          });
        } else if (ext === 'xml'){
          const text = await readAsText(f);
          const rows = await parseGeneric_XML(text);
          rows.forEach(r => out.push(r));
        } else if (ext === 'pdf'){
          const txt = await extractPDFText(f);
          const rows = parseStatementPDFText(txt);
          rows.forEach(r => out.push(r));
        }
      } catch (e){
        console.warn('Error leyendo estado', f.name, e);
      }
    }
    return out;
  }
  
  // ========= EVENTOS =========
  parseBtn.addEventListener('click', async () => {
    const invFiles = Array.from(invoicesFilesInput.files || []);
    const stFiles  = Array.from(statementFilesInput.files || []);
    if (invFiles.length === 0 || stFiles.length === 0){
      alert('Selecciona archivos para Facturas y Estado de cuenta (XML/PDF/CSV).');
      return;
    }
  
    parseBtn.disabled = true;
    parseBtn.textContent = 'Procesando...';
  
    try {
      const [invoices, movements] = await Promise.all([
        parseInvoicesFiles(invFiles),
        parseStatementFiles(stFiles)
      ]);
  
      const dayTol = Number(dayToleranceInput.value) || 3;
      const amtTol = Number(amountToleranceInput.value) || 0.01;
  
      const { results } = matchInvoices(invoices, movements, dayTol, amtTol);
      lastResults = results;
  
      renderSummary(results);
      renderTable(results, filterSelect.value);
      exportBtn.disabled = results.filter(x => !x.matched).length === 0;
    } catch (err) {
      console.error(err);
      alert('Ocurrió un error al procesar archivos. Revisa formatos y que PDF.js cargó correctamente.');
    } finally {
      parseBtn.disabled = false;
      parseBtn.textContent = 'Procesar y Conciliar';
    }
  });
  
  filterSelect.addEventListener('change', () => {
    if (!lastResults) return;
    renderTable(lastResults, filterSelect.value);
  });
  exportBtn.addEventListener('click', () => {
    if (!lastResults) return;
    exportUnmatchedToCSV(lastResults);
  });
  