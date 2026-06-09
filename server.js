require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = 3000;

// ===== PATHS =====
const DATA_FILE = path.join(__dirname, 'data', 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(path.join(__dirname, 'data'));
fs.ensureDirSync(UPLOADS_DIR);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: UPLOADS_DIR });

// ===== DATABASE =====
function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      doctors: [
        { name: 'DR.NASSER',      target: 4000, commission: 20, lab: 10, insurance: 45 },
        { name: 'DR.KAMAL',       target: 3500, commission: 20, lab: 8,  insurance: 45 },
        { name: 'Dr.VASIM',       target: 3000, commission: 20, lab: 12, insurance: 45 },
        { name: 'DR. ABDULWAHAB', target: 2000, commission: 15, lab: 5,  insurance: 45 },
        { name: 'DR.SAJEDA',      target: 2000, commission: 15, lab: 5,  insurance: 45 },
      ],
      dailyData: [],
      paymentsData: [],
      commissionHistory: [],
      uploadedFiles: [],
      expenses: []
    };
    fs.writeJsonSync(DATA_FILE, initial, { spaces: 2 });
    return initial;
  }
  return fs.readJsonSync(DATA_FILE);
}

function saveDB(db) {
  fs.writeJsonSync(DATA_FILE, db, { spaces: 2 });
}

// ===== EXCEL PARSER =====
function parseDailyIncome(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  const records = [];
  
  // Find header row and map column positions
  let colMap = null;
  let headerRowIdx = -1;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowStr = row.map(c => String(c)).join('|').toLowerCase();
    if (rowStr.includes('date') && rowStr.includes('cash') && rowStr.includes('k-net')) {
      headerRowIdx = i;
      // Map columns by name
      colMap = {};
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j]).trim().toLowerCase();
        if (h === 'date') colMap.date = j;
        else if (h === 'cash') colMap.cash = j;
        else if (h === 'k-net') colMap.knet = j;
        else if (h === 'visa') colMap.visa = j;
        else if (h === 'master') colMap.master = j;
        else if (h === 'insurance') colMap.insurance = j;
        else if (h === 'cheque') colMap.cheque = j;
        else if (h === 'link') colMap.link = j;
        else if (h === 'total') colMap.total = j;
        else if (h === 'advance') colMap.advance = j;
      }
      break;
    }
  }
  
  if (!colMap) return records;
  
  // Parse data rows
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const firstCell = String(row[colMap.date] || '').trim();
    
    if (!firstCell || firstCell === '0') continue;
    if (!/\d{2}\/\d{2}\/\d{4}/.test(firstCell)) continue;
    
    const parts = firstCell.split('/');
    const isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    
    const getVal = (col) => col !== undefined ? (parseFloat(row[col]) || 0) : 0;
    
    const record = {
      date:      isoDate,
      cash:      getVal(colMap.cash),
      knet:      getVal(colMap.knet),
      visa:      getVal(colMap.visa),
      master:    getVal(colMap.master),
      insurance: getVal(colMap.insurance),
      cheque:    getVal(colMap.cheque),
      link:      getVal(colMap.link),
      total:     getVal(colMap.total),
      advance:   getVal(colMap.advance),
    };
    
    records.push(record);
  }
  return records;
}

function parsePaymentsDetails(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  const records = [];
  let colMap = null;
  let headerRowIdx = -1;
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowStr = row.map(c => String(c)).join('|').toLowerCase();
    if (rowStr.includes('doctor') && (rowStr.includes('inv id') || rowStr.includes('inv. total'))) {
      headerRowIdx = i;
      colMap = {};
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j]).trim().toLowerCase();
        if (h === 'inv id') colMap.invId = j;
        else if (h === 'patient name') colMap.patient = j;
        else if (h === 'file no') colMap.fileNo = j;
        else if (h === 'date') colMap.date = j;
        else if (h === 'doctor') colMap.doctor = j;
        else if (h === 'k-net') colMap.knet = j;
        else if (h === 'visa') colMap.visa = j;
        else if (h === 'master') colMap.master = j;
        else if (h === 'link') colMap.link = j;
        else if (h === 'gig-globmed') colMap.gig = j;
        else if (h === 'inv. total') colMap.total = j;
      }
      break;
    }
  }
  
  if (!colMap) return records;
  
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const invId = parseInt(row[colMap.invId]);
    if (!invId || isNaN(invId)) continue;
    
    const dateStr = String(row[colMap.date] || '').trim();
    if (!/\d{2}\/\d{2}\/\d{4}/.test(dateStr)) continue;
    const parts = dateStr.split('/');
    const isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    
    const getVal = (col) => col !== undefined ? (parseFloat(row[col]) || 0) : 0;
    
    records.push({
      invId,
      patient: String(row[colMap.patient] || '').trim(),
      fileNo:  String(row[colMap.fileNo] || '').trim(),
      date:    isoDate,
      doctor:  String(row[colMap.doctor] || '').trim(),
      knet:    getVal(colMap.knet),
      visa:    getVal(colMap.visa),
      master:  getVal(colMap.master),
      link:    getVal(colMap.link),
      gig:     getVal(colMap.gig),
      total:   getVal(colMap.total),
    });
  }
  return records;
}

function calcCommission(dr, revenue) {
  const aboveTarget = Math.max(0, revenue - dr.target);
  const afterLab = aboveTarget * (1 - dr.lab / 100);
  const commission = Math.max(0, afterLab * (dr.commission / 100));
  return parseFloat(commission.toFixed(3));
}

function getMonth(dateStr) {
  return dateStr.substring(0, 7); // yyyy-mm
}

// ===== API ROUTES =====

// Get all data
app.get('/api/data', (req, res) => {
  const db = loadDB();
  res.json(db);
});

// Upload Excel
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const db = loadDB();
    const filePath = req.file.path;
    const fileName = req.file.originalname.toLowerCase();
    
    let parsed = [];
    let type = '';
    
    if (fileName.includes('dailyincome')) {
      parsed = parseDailyIncome(filePath);
      type = 'daily';
      
      // Merge — avoid duplicates by date
      const existing = new Set(db.dailyData.map(d => d.date));
      let added = 0;
      for (const rec of parsed) {
        if (!existing.has(rec.date)) {
          db.dailyData.push(rec);
          added++;
        } else {
          // Update existing
          const idx = db.dailyData.findIndex(d => d.date === rec.date);
          db.dailyData[idx] = rec;
        }
      }
      db.dailyData.sort((a, b) => b.date.localeCompare(a.date));
      
    } else if (fileName.includes('payments')) {
      parsed = parsePaymentsDetails(filePath);
      type = 'payments';
      
      // Merge by invId
      const existingIds = new Set(db.paymentsData.map(d => d.invId));
      let added = 0;
      for (const rec of parsed) {
        if (!existingIds.has(rec.invId)) {
          db.paymentsData.push(rec);
          added++;
        }
      }
      db.paymentsData.sort((a, b) => b.date.localeCompare(a.date));
      
      // Auto-calculate commissions per doctor per month
      updateCommissions(db);
    }
    
    // Log upload
    db.uploadedFiles.push({
      name: req.file.originalname,
      type,
      records: parsed.length,
      date: new Date().toISOString(),
    });
    
    saveDB(db);
    fs.removeSync(filePath);
    
    res.json({ success: true, type, records: parsed.length, message: `تم رفع ${parsed.length} سجل بنجاح` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في قراءة الملف: ' + err.message });
  }
});

function updateCommissions(db) {
  // Group payments by doctor+month
  const groups = {};
  for (const p of db.paymentsData) {
    const month = getMonth(p.date);
    const doctor = p.doctor;
    if (doctor === 'Advance' || !doctor) continue;
    const key = `${doctor}|${month}`;
    if (!groups[key]) groups[key] = { doctor, month, revenue: 0 };
    groups[key].revenue += p.total;
  }
  
  // Update commission history
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const dr = db.doctors.find(d => d.name === g.doctor);
    if (!dr) continue;
    const commission = calcCommission(dr, g.revenue);
    
    const existing = db.commissionHistory.find(c => c.doctor === g.doctor && c.month === g.month);
    if (existing) {
      existing.revenue = g.revenue;
      existing.commission = commission;
    } else {
      db.commissionHistory.push({
        id: Date.now() + Math.random(),
        doctor: g.doctor,
        month: g.month,
        revenue: g.revenue,
        commission,
        paid: false,
        payMethod: '',
        payDate: ''
      });
    }
  }
}

// Save doctors
app.post('/api/doctors', (req, res) => {
  const db = loadDB();
  db.doctors = req.body.doctors;
  updateCommissions(db);
  saveDB(db);
  res.json({ success: true });
});

// Mark commission paid
app.post('/api/commission/pay', (req, res) => {
  const { doctor, month, payMethod, payDate } = req.body;
  const db = loadDB();
  const entry = db.commissionHistory.find(c => c.doctor === doctor && c.month === month);
  if (entry) {
    entry.paid = true;
    entry.payMethod = payMethod;
    entry.payDate = payDate;
    saveDB(db);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: 'لم يتم إيجاد العمولة' });
  }
});

// Add expense
app.post('/api/expenses', (req, res) => {
  const db = loadDB();
  db.expenses.push({ ...req.body, id: Date.now() });
  saveDB(db);
  res.json({ success: true });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const { from, to } = req.query;
  const db = loadDB();
  
  let daily = db.dailyData;
  if (from) daily = daily.filter(d => d.date >= from);
  if (to) daily = daily.filter(d => d.date <= to);
  
  const totalRevenue = daily.reduce((s, d) => s + d.total, 0);
  const insRecorded = daily.reduce((s, d) => s + d.insurance, 0);
  const insOriginal = insRecorded > 0 ? insRecorded / 0.75 : 0;
  const insShare = insOriginal * 0.25;
  const workDays = daily.filter(d => d.total > 0).length;
  const totalComm = db.commissionHistory.reduce((s, c) => s + c.commission, 0);
  const pendingComm = db.commissionHistory.filter(c => !c.paid).reduce((s, c) => s + c.commission, 0);
  
  res.json({
    totalRevenue: parseFloat(totalRevenue.toFixed(3)),
    insRecorded: parseFloat(insRecorded.toFixed(3)),
    insOriginal: parseFloat(insOriginal.toFixed(3)),
    insShare: parseFloat(insShare.toFixed(3)),
    insNet: parseFloat(insRecorded.toFixed(3)),
    netCash: parseFloat((totalRevenue - insRecorded).toFixed(3)),
    workDays,
    totalComm: parseFloat(totalComm.toFixed(3)),
    pendingComm: parseFloat(pendingComm.toFixed(3)),
  });
});

// ===== TELEGRAM BOT =====
let bot = null;

app.post('/api/telegram/start', (req, res) => {
  const { token } = req.body;
  if (bot) { try { bot.stopPolling(); } catch(e) {} }
  
  try {
    bot = new TelegramBot(token, { polling: true });
    setupBot(bot);
    
    // Save token
    const db = loadDB();
    db.telegramToken = token;
    saveDB(db);
    
    res.json({ success: true, message: 'البوت شغال ✅' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function setupBot(bot) {
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    
    // File received
    if (msg.document) {
      const fileName = msg.document.file_name || '';
      bot.sendMessage(chatId, `📂 استلمت الملف: ${fileName}\nجاري المعالجة...`);
      
      try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const https = require('https');
        const http = require('http');
        const client = fileLink.startsWith('https') ? https : http;
        const tempPath = path.join(UPLOADS_DIR, `tg_${Date.now()}_${fileName}`);
        
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tempPath);
          client.get(fileLink, res => { res.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });
        
        const db = loadDB();
        const lowerName = fileName.toLowerCase();
        let parsed = [];
        let type = '';
        
        if (lowerName.includes('dailyincome')) {
          parsed = parseDailyIncome(tempPath);
          type = 'daily';
          const existing = new Set(db.dailyData.map(d => d.date));
          for (const rec of parsed) {
            if (!existing.has(rec.date)) db.dailyData.push(rec);
            else { const idx = db.dailyData.findIndex(d => d.date === rec.date); db.dailyData[idx] = rec; }
          }
          db.dailyData.sort((a, b) => b.date.localeCompare(a.date));
        } else if (lowerName.includes('payments')) {
          parsed = parsePaymentsDetails(tempPath);
          type = 'payments';
          const existingIds = new Set(db.paymentsData.map(d => d.invId));
          for (const rec of parsed) { if (!existingIds.has(rec.invId)) db.paymentsData.push(rec); }
          db.paymentsData.sort((a, b) => b.date.localeCompare(a.date));
          updateCommissions(db);
        }
        
        db.uploadedFiles.push({ name: fileName, type, records: parsed.length, date: new Date().toISOString() });
        saveDB(db);
        fs.removeSync(tempPath);
        
        bot.sendMessage(chatId, `✅ تم حفظ ${parsed.length} سجل بنجاح!\nاكتب /stats لرؤية الإحصائيات`);
      } catch (err) {
        bot.sendMessage(chatId, `❌ خطأ: ${err.message}`);
      }
      return;
    }
    
    // Photo received — invoice AI reader
    if (msg.photo) {
      bot.sendMessage(chatId, '🔍 جاري قراءة الفاتورة...');
      try {
        const photos = msg.photo;
        const largestPhoto = photos[photos.length - 1];
        const fileLink = await bot.getFileLink(largestPhoto.file_id);
        
        const https = require('https');
        const http = require('http');
        const client = fileLink.startsWith('https') ? https : http;
        const tempPath = path.join(UPLOADS_DIR, `invoice_${Date.now()}.jpg`);
        
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tempPath);
          client.get(fileLink, res => { res.pipe(file); file.on('finish', resolve); }).on('error', reject);
        });
        
        // Read image and convert to base64
        const imageData = fs.readFileSync(tempPath);
        const base64Image = imageData.toString('base64');
        fs.removeSync(tempPath);
        
        // Send to Claude AI to extract invoice data
        const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
                },
                {
                  type: 'text',
                  text: `استخرج بيانات هذه الفاتورة وأجب بـ JSON فقط بهذا الشكل بدون أي نص إضافي:
{"vendor":"اسم المورد أو الجهة","amount":المبلغ الرقمي بدون عملة,"date":"التاريخ بصيغة YYYY-MM-DD","category":"تصنيف (مواد مختبر/رواتب/إيجار/كهرباء/صيانة/أخرى)","description":"وصف قصير"}
إذا ما قدرت تقرأ قيمة حط null. التاريخ اليوم هو ${new Date().toISOString().split('T')[0]}`
                }
              ]
            }]
          })
        });
        
        const aiData = await aiResponse.json();
        const rawText = aiData.content?.[0]?.text || '{}';
        
        let invoice;
        try {
          invoice = JSON.parse(rawText.replace(/```json|```/g, '').trim());
        } catch(e) {
          invoice = {};
        }
        
        // Store pending invoice for confirmation
        const db = loadDB();
        if (!db.pendingInvoices) db.pendingInvoices = {};
        db.pendingInvoices[chatId] = invoice;
        saveDB(db);
        
        // Escape special chars for Markdown
        const esc = (s) => String(s||'').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        
        const confirmMsg = 
          '📄 قرأت الفاتورة:\n\n' +
          '🏢 المورد: ' + esc(invoice.vendor || 'غير واضح') + '\n' +
          '💰 المبلغ: ' + esc(invoice.amount ? invoice.amount + ' د.ك' : 'غير واضح') + '\n' +
          '📅 التاريخ: ' + esc(invoice.date || 'غير واضح') + '\n' +
          '📂 التصنيف: ' + esc(invoice.category || 'غير واضح') + '\n' +
          '📝 الوصف: ' + esc(invoice.description || '—') + '\n\n' +
          'هل تأكد الحفظ؟\n/confirm_invoice نعم حفظ\n/cancel_invoice الغاء';
        
        bot.sendMessage(chatId, confirmMsg);
      } catch(err) {
        bot.sendMessage(chatId, '❌ خطأ في قراءة الفاتورة: ' + err.message);
      }
      return;
    }

    // Confirm invoice
    if (text === '/confirm_invoice') {
      const db = loadDB();
      const invoice = db.pendingInvoices?.[chatId];
      if (!invoice) { bot.sendMessage(chatId, '❌ لا يوجد فاتورة معلّقة.'); return; }
      const amount = parseFloat(invoice.amount) || 0;
      const date = invoice.date || new Date().toISOString().split('T')[0];
      const desc = invoice.description || invoice.vendor || 'فاتورة';
      if (!db.expenses) db.expenses = [];
      db.expenses.push({ id: Date.now(), desc, cat: invoice.category || 'أخرى', amount, date, vendor: invoice.vendor || '', source: 'telegram_photo' });
      if (!db.journalEntries) db.journalEntries = [];
      const accounts = db.chartOfAccounts || [];
      const catMap = {'مواد مختبر':'5210','رواتب':'5100','إيجار':'5510','كهرباء':'5520','كهرباء/ماء':'5520','صيانة':'5540','تسويق':'5610','إقامة':'5720','تأشيرات':'5170','تأمين':'5740','هاتف':'5530','أخرى':'5670'};
      const expenseCode = catMap[invoice.category || 'أخرى'] || '5670';
      const expenseAcc = accounts.find(a => a.code === expenseCode) || { id: expenseCode, code: expenseCode, name: invoice.category || 'مصاريف متنوعة' };
      const cashAcc = accounts.find(a => a.code === '1100') || { id: '1100', code: '1100', name: 'الصندوق — نقدي' };
      db.journalEntries.push({
        id: 'JE-TG-' + Date.now(), date, desc, ref: 'TG-INV', type: 'ai',
        totalDebit: amount, totalCredit: amount, createdAt: new Date().toISOString(),
        lines: [
          { accountId: expenseAcc.id, accountCode: expenseAcc.code, accountName: expenseAcc.name, debit: amount, credit: 0 },
          { accountId: cashAcc.id, accountCode: cashAcc.code, accountName: cashAcc.name, debit: 0, credit: amount }
        ]
      });
      db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
      delete db.pendingInvoices[chatId];
      saveDB(db);
      bot.sendMessage(chatId,
        '✅ تم الحفظ!\n\n' +
        '💸 المصروف: ' + desc + ' — ' + amount + ' د.ك\n\n' +
        '📝 القيد المحاسبي:\n' +
        '  مدين: ' + expenseAcc.code + ' — ' + expenseAcc.name + '\n' +
        '  دائن: ' + cashAcc.code + ' — ' + cashAcc.name + '\n\n' +
        'القيد موجود في القيود اليومية على الموقع'
      );
      return;
    }

    // Cancel invoice
    if (text === '/cancel_invoice') {
      const db = loadDB();
      if (db.pendingInvoices) delete db.pendingInvoices[chatId];
      saveDB(db);
      bot.sendMessage(chatId, '❌ تم إلغاء الفاتورة.');
      return;
    }

    // Manual expense entry: /expense 50 مواد مختبر
    if (text.startsWith('/expense ')) {
      const parts = text.replace('/expense ', '').split(' ');
      const amount = parseFloat(parts[0]);
      const desc = parts.slice(1).join(' ');
      if (!amount || !desc) {
        bot.sendMessage(chatId, '❌ الصيغة: /expense [المبلغ] [الوصف]\nمثال: /expense 50 مواد مختبر');
        return;
      }
      const db = loadDB();
      db.expenses.push({
        id: Date.now(),
        desc,
        cat: 'أخرى',
        amount,
        date: new Date().toISOString().split('T')[0],
        source: 'telegram_manual'
      });
      saveDB(db);
      bot.sendMessage(chatId, '✅ تم تسجيل المصروف: ' + desc + ' — ' + amount + ' د.ك');
      return;
    }

    // Show expenses
    if (text === '/expenses') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const expenses = (db.expenses || []).filter(e => e.date && e.date.startsWith(thisMonth));
      if (!expenses.length) { bot.sendMessage(chatId, 'لا توجد مصاريف هذا الشهر.\nأضف مصروف: /expense [مبلغ] [وصف]'); return; }
      const total = expenses.reduce((s,e) => s + (e.amount||0), 0);
      let msg = '💸 *مصاريف ' + thisMonth + ':*\n\n';
      expenses.forEach(e => { msg += '• ' + e.desc + ': ' + e.amount + ' د.ك (' + e.cat + ')\n'; });
      msg += '\n*الإجمالي: ' + total.toFixed(3) + ' د.ك*';
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      return;
    }

    // Text commands
    if (text === '/start') {
      bot.sendMessage(chatId,
        'مرحباً محمد 👋\n\nأنا نظام محاسبة بوبيان الذكي.\n\n' +
        '📊 *الإيرادات:*\n/stats — إحصائيات الشهر\n/stats 2026-04 — شهر محدد\n\n' +
        '👨‍⚕️ *العمولات:*\n/comm — عمولات الدكاترة\n/pending — غير المدفوعة\n\n' +
        '💸 *المصاريف:*\n📸 صوّر فاتورة وابعثها — AI يقرأها تلقائياً\n/expense 50 مواد مختبر — إدخال يدوي\n/expenses — عرض مصاريف الشهر\n\n' +
        '📂 ابعث Excel — يتحفظ تلقائياً',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (text === '/stats' || text.startsWith('/stats ')) {
      const db = loadDB();
      const monthNames = {'01':'يناير','02':'فبراير','03':'مارس','04':'أبريل','05':'مايو','06':'يونيو','07':'يوليو','08':'أغسطس','09':'سبتمبر','10':'أكتوبر','11':'نوفمبر','12':'ديسمبر'};
      const allMonths = [...new Set(db.dailyData.map(d => d.date.substring(0,7)))].sort().reverse();
      if (!allMonths.length) { bot.sendMessage(chatId, '❌ لا توجد بيانات. ارفع ملف Excel أولاً.'); return; }
      const requestedMonth = text.split(' ')[1];
      const targetMonth = requestedMonth || allMonths[0];
      const daily = db.dailyData.filter(d => d.date.startsWith(targetMonth));
      const total = daily.reduce((s, d) => s + d.total, 0);
      const ins = daily.reduce((s, d) => s + d.insurance, 0);
      const insOrig = ins > 0 ? ins / 0.75 : 0;
      const insShare = insOrig * 0.25;
      const days = daily.filter(d => d.total > 0).length;
      const [y, m] = targetMonth.split('-');
      const monthLabel = (monthNames[m] || m) + ' ' + y;
      const otherMonths = allMonths.filter(mo => mo !== targetMonth).slice(0, 5);
      const otherStr = otherMonths.length ? '\n\n📅 *أشهر أخرى:*\n' + otherMonths.map(mo => {
        const [y2,m2] = mo.split('-'); return '• /stats ' + mo + ' — ' + (monthNames[m2]||m2) + ' ' + y2;
      }).join('\n') : '';
      bot.sendMessage(chatId,
        '📊 *إحصائيات ' + monthLabel + '*\n\n' +
        '💰 إجمالي الإيرادات: *' + total.toFixed(3) + '* د.ك\n' +
        '🏥 حصة التأمين: ' + insShare.toFixed(3) + ' د.ك\n' +
        '✅ صافي العيادة: *' + (total - insShare).toFixed(3) + '* د.ك\n' +
        '📅 أيام العمل: ' + days + ' يوم' + otherStr,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (text === '/comm') {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const comms = db.commissionHistory.filter(c => c.month === thisMonth);
      
      if (!comms.length) { bot.sendMessage(chatId, 'لا توجد عمولات للشهر الحالي'); return; }
      
      let msg2 = `👨‍⚕️ *عمولات ${thisMonth}*\n\n`;
      for (const c of comms) {
        msg2 += `${c.doctor}\n`;
        msg2 += `  إيراد: ${c.revenue.toFixed(3)} | عمولة: ${c.commission.toFixed(3)} د.ك\n`;
        msg2 += `  ${c.paid ? '✅ مدفوع' : '⏳ غير مدفوع'}\n\n`;
      }
      bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
      return;
    }
    
    if (text === '/pending') {
      const db = loadDB();
      const pending = db.commissionHistory.filter(c => !c.paid);
      if (!pending.length) { bot.sendMessage(chatId, '✅ كل العمولات مدفوعة!'); return; }
      
      let msg3 = `⏳ *العمولات غير المدفوعة*\n\n`;
      const total = pending.reduce((s, c) => s + c.commission, 0);
      for (const c of pending) {
        msg3 += `• ${c.doctor} — ${c.month}: ${c.commission.toFixed(3)} د.ك\n`;
      }
      msg3 += `\n*الإجمالي: ${total.toFixed(3)} د.ك*`;
      bot.sendMessage(chatId, msg3, { parse_mode: 'Markdown' });
      return;
    }
    
    // AI answer using Anthropic
    try {
      const db = loadDB();
      const thisMonth = new Date().toISOString().substring(0, 7);
      const daily = db.dailyData.filter(d => d.date.startsWith(thisMonth));
      const total = daily.reduce((s, d) => s + d.total, 0);
      const ins = daily.reduce((s, d) => s + d.insurance, 0);
      const comms = db.commissionHistory.filter(c => c.month === thisMonth);
      
      const context = `بيانات عيادة بوبيان لطب الأسنان - ${thisMonth}:
إجمالي الإيرادات: ${total.toFixed(3)} د.ك
التأمين المسجّل: ${ins.toFixed(3)} د.ك
أيام العمل: ${daily.filter(d=>d.total>0).length}
العمولات: ${comms.map(c=>`${c.doctor}: ${c.commission.toFixed(3)} د.ك (${c.paid?'مدفوع':'غير مدفوع'})`).join(', ')}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: `أنت مساعد محاسبي لعيادة بوبيان. ${context}. أجب باختصار بالعربي.`,
          messages: [{ role: 'user', content: text }]
        })
      });
      const data = await response.json();
      const answer = data.content?.[0]?.text || 'ما قدرت أجاوب';
      bot.sendMessage(chatId, answer);
    } catch(e) {
      bot.sendMessage(chatId, 'اكتب /stats أو /comm أو /pending للحصول على المعلومات');
    }
  });
}

// Auto-start bot if token saved
const db = loadDB();
if (db.telegramToken) {
  try {
    bot = new TelegramBot(db.telegramToken, { polling: true });
    setupBot(bot);
    console.log('✅ Telegram bot started automatically');
  } catch(e) {
    console.log('⚠️  Telegram token invalid, skipping bot start');
  }
}

app.listen(PORT, () => {
  console.log(`\n✅ بوبيان للمحاسبة - يعمل على http://localhost:${PORT}`);
  console.log(`📂 البيانات محفوظة في: ${DATA_FILE}`);
});

// COA endpoint
app.post('/api/coa', (req, res) => {
  const db = loadDB();
  db.chartOfAccounts = req.body.chartOfAccounts;
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/coa', (req, res) => {
  const db = loadDB();
  res.json(db.chartOfAccounts || []);
});

// Journal endpoints
app.post('/api/journal', (req, res) => {
  const db = loadDB();
  if (!db.journalEntries) db.journalEntries = [];
  const entry = req.body;
  const existing = db.journalEntries.findIndex(e => e.id === entry.id);
  if (existing >= 0) db.journalEntries[existing] = entry;
  else db.journalEntries.push(entry);
  db.journalEntries.sort((a,b) => b.date.localeCompare(a.date));
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/journal/:id', (req, res) => {
  const db = loadDB();
  db.journalEntries = (db.journalEntries || []).filter(e => e.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// AI Journal Entry from invoice image
app.post('/api/ai/journal', async (req, res) => {
  try {
    const { image, accounts } = req.body;
    const accountList = accounts.map(a => `${a.code}: ${a.name} (${a.type})`).join('\n');
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: `أنت محاسب خبير. اقرأ هذه الفاتورة وولّد قيد محاسبي.

شجرة الحسابات المتاحة:
${accountList}

أجب بـ JSON فقط بدون أي نص إضافي:
{
  "description": "بيان القيد",
  "ref": "رقم الفاتورة إن وجد",
  "lines": [
    {"accountId": "رقم الحساب من الشجرة", "debit": 0, "credit": 0},
    {"accountId": "رقم الحساب من الشجرة", "debit": 0, "credit": 0}
  ]
}

القواعد: مجموع المدين = مجموع الدائن. للمصروف: مدين حساب المصروف، دائن الصندوق أو البنك. للإيراد: مدين الصندوق أو البنك، دائن حساب الإيراد.` }
          ]
        }]
      })
    });
    
    const data = await response.json();
    const raw = data.content?.[0]?.text || '{}';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, ...result });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Recurring expenses endpoints
app.post('/api/recurring', (req, res) => {
  const db = loadDB();
  if (!db.recurringExpenses) db.recurringExpenses = [];
  db.recurringExpenses.push(req.body);
  saveDB(db);
  res.json({ success: true });
});

app.delete('/api/recurring/:id', (req, res) => {
  const db = loadDB();
  db.recurringExpenses = (db.recurringExpenses||[]).filter(r => r.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/recurring/run', (req, res) => {
  const db = loadDB();
  const items = db.recurringExpenses || [];
  const today = new Date();
  const thisMonth = today.toISOString().substring(0, 7);
  let applied = 0;

  items.forEach(r => {
    if (!r.active) return;
    if (r.lastApplied && r.lastApplied.startsWith(thisMonth)) return; // already applied this month

    // Add expense
    if (!db.expenses) db.expenses = [];
    const date = `${thisMonth}-${String(r.day).padStart(2,'0')}`;
    db.expenses.push({
      id: Date.now() + Math.random(),
      desc: r.desc + ' (متكرر)',
      cat: r.cat,
      amount: r.amount,
      date,
      source: 'recurring'
    });

    // Add journal entry
    if (!db.journalEntries) db.journalEntries = [];
    const accounts = db.chartOfAccounts || [];
    const expAcc = accounts.find(a => a.id === r.accountId) || { id: r.accountId||'5670', code: '5670', name: r.cat };
    const cashAcc = accounts.find(a => a.code === '1100') || { id: '1100', code: '1100', name: 'الصندوق' };
    db.journalEntries.push({
      id: 'JE-REC-' + Date.now(),
      date, desc: r.desc + ' (متكرر)',
      ref: 'REC', type: 'expense',
      totalDebit: r.amount, totalCredit: r.amount,
      createdAt: new Date().toISOString(),
      lines: [
        { accountId: expAcc.id, accountCode: expAcc.code, accountName: expAcc.name, debit: r.amount, credit: 0 },
        { accountId: cashAcc.id, accountCode: cashAcc.code, accountName: cashAcc.name, debit: 0, credit: r.amount }
      ]
    });

    r.lastApplied = date;
    applied++;
  });

  saveDB(db);
  res.json({ success: true, applied });
});
