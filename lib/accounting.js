'use strict';
// دوال المحاسبة النقية — القطعة الثانية من تفكيك server.js (CLAUDE.md بند 6)
// نقية وقابلة للاختبار: تحويل فئة مصروف/طريقة دفع إلى حساب موجود فعلاً بالشجرة.

// Map expense category → debit account code
function expCatToAccount(cat, coa) {
  const catNorm = (cat||'').trim();
  coa = coa || [];
  const byCode = code => coa.find(a => String(a.code) === code && a.status !== 'inactive');
  // خريطة الفئات → أكواد الشجرة الفعلية (DEFAULT_COA). الخريطة القديمة كانت
  // ترجع أكواداً غير موجودة (5510/5560/5699...) فيختفي المصروف من قائمة الدخل
  // ويختل ميزان المعادلة المحاسبية — لذلك نضمن دائماً حساباً موجوداً فعلاً.
  const MAP = [
    ['إيجار',    '5300'], ['راتب', '5120'], ['رواتب', '5120'],
    ['كهرباء',   '5400'], ['ماء', '5400'], ['مرافق', '5400'],
    ['اتصال',    '5710'], ['هاتف', '5710'], ['إنترنت', '5710'],
    ['زين',      '5710'], ['STC', '5710'], ['ooredoo', '5710'],
    ['مختبر',    '5210'], ['مواد', '5220'], ['دواء', '5220'], ['مستلزم', '5220'],
    ['صيانة',    '5500'], ['إصلاح', '5500'],
    ['تأمين',    '5730'],
    ['تسويق',    '5600'], ['إعلان', '5600'],
    ['قرطاسية',  '5740'], ['مطبوعات', '5740'],
    ['إقامة',    '5720'], ['تأشيرة', '5720'],
    ['عمولة',    '5750'], ['بنكية', '5750'],
    ['اهتلاك',   '5800'], ['استهلاك', '5800'], ['إهلاك', '5800'],
  ];
  for (const [key, code] of MAP) {
    if (catNorm.includes(key)) {
      const acc = byCode(code);
      if (acc) return { code: String(acc.code), name: acc.name };
    }
  }
  // ثم الشجرة — حساب مصروف اسمه يحتوي الفئة
  if (coa.length) {
    const match = coa.find(a => a.type==='expense' && a.status!=='inactive' && !a.isGroup
      && catNorm.length >= 3 && (a.name||'').includes(catNorm.substring(0,4)));
    if (match) return { code: String(match.code), name: match.name };
  }
  // احتياط مضمون: «مصاريف أخرى متنوعة» ثم أي ورقة مصاريف موجودة
  const misc = byCode('5900')
    || coa.find(a => a.type==='expense' && !a.isGroup && a.status!=='inactive' && /أخرى|متنوع|عام/.test(a.name||''))
    || coa.find(a => a.type==='expense' && !a.isGroup && a.status!=='inactive');
  if (misc) return { code: String(misc.code), name: misc.name };
  return { code: '5900', name: 'مصاريف أخرى متنوعة' };
}

// Map payment method → credit account (أكواد موجودة فعلاً في الشجرة)
function payMethodToAccount(method) {
  const m = (method||'').toLowerCase();
  if (m.includes('بنك') || m.includes('bank') || m.includes('تحويل') || m.includes('شيك')) return { code:'1110', name:'البنك — الحساب الجاري' };
  if (m.includes('knet') || m.includes('كي') || m.includes('visa') || m.includes('master') || m.includes('فيزا') || m.includes('ماستر')) return { code:'1120', name:'K-Net / Visa / Master — مستحقات' };
  return { code:'1100', name:'الصندوق — نقدي' }; // default: cash
}

module.exports = { expCatToAccount, payMethodToAccount };
