/**
 * Muse Dashboard — write-only daily backup intake (FRESH; replaces the old v1.10).
 *
 * Receives a one-way daily export from the Cloudflare Worker and appends it to
 * dated backup tabs. The app NEVER reads from this spreadsheet — it is a backup
 * only. There are deliberately NO config/read/queue-clear endpoints here.
 *
 * Payload (POST JSON from the Worker):
 *   {
 *     action: "dailyBackup",
 *     date: "YYYY-MM-DD",
 *     summary: { customers, revenue },
 *     transactions: { columns: [...], rows: [[...], ...] },
 *     turns:        { columns: [...], rows: [[...], ...] },
 *     queue:        { columns: [...], rows: [[...], ...] }
 *   }
 *
 * Deploy:
 *   1. Create a NEW Google Sheet (the backup workbook).
 *   2. Extensions → Apps Script → paste this file → set MANAGER_EMAIL below.
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   4. Copy the /exec URL → set it as the Worker secret:  wrangler secret put SHEETS_URL
 *   5. Retire the old v1.10 deployment.
 */

var MANAGER_EMAIL = '';            // manager email for the daily summary; '' = no email
var TIMEZONE      = 'America/Los_Angeles';

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.action !== 'dailyBackup') {
      return _json({ ok: false, error: 'unknown action: ' + data.action });
    }
    writeSection('Transactions', data.date, data.transactions);
    writeSection('Turns',        data.date, data.turns);
    writeSection('Queue',        data.date, data.queue);
    if (MANAGER_EMAIL && data.summary) sendSummary(data.date, data.summary, data.turns);
    return _json({ ok: true, date: data.date });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

// Backups are POST-only; a GET just confirms the endpoint is alive.
function doGet() {
  return _json({ ok: true, info: 'Muse backup intake — POST { action: "dailyBackup", ... } only.' });
}

/**
 * Append a { columns, rows } section to a tab, tagging each row with the backup
 * date. Creates the tab + header row on first use. Idempotent header.
 */
function writeSection(tabName, dateStr, section) {
  if (!section || !section.columns) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(tabName);
  var header = ['Backup Date'].concat(section.columns);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(header);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(header);
    sh.setFrozenRows(1);
  }
  var rows = section.rows || [];
  if (!rows.length) { sh.appendRow([dateStr, '(no data)']); return; }
  var out = rows.map(function (r) { return [dateStr].concat(r); });
  // Pad ragged rows to the header width so setValues doesn't throw.
  var width = header.length;
  out.forEach(function (r) { while (r.length < width) r.push(''); });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, width).setValues(out);
}

function sendSummary(dateStr, summary, turns) {
  try {
    var body = 'Daily Summary — ' + dateStr + '\n\n'
      + 'Customers served : ' + (summary.customers || 0) + '\n'
      + 'Total revenue    : $' + Number(summary.revenue || 0).toFixed(2) + '\n';
    if (turns && turns.rows && turns.rows.length) {
      body += '\nBy technician:\n';
      turns.rows.forEach(function (r) {
        // turns columns: [Technician, Customers, Billed $]
        body += '  ' + r[0] + ': ' + r[1] + ' customer(s), $' + Number(r[2] || 0).toFixed(2) + '\n';
      });
    }
    body += '\n— Muse Dashboard (automated backup)';
    GmailApp.sendEmail(MANAGER_EMAIL, 'Muse Summary — ' + dateStr, body);
  } catch (err) { /* email is best-effort */ }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
