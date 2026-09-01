// Vendor / AP Workspace Upgrade (specs/001-vendor-ap-workspace) — owner-
// review remediation round 2 (findings AREA8-2/AREA8-3): pure, DOM-free,
// side-effect-free logic shared between public/index.html's browser-side
// rendering code and this repo's Jest test suite, so neither the F1
// open-items predicate nor calcVendorBalance()'s formula ever exists as
// two independently-maintained copies. No DOM access, no fetch, no
// mutation of any argument. Safe to `require()` directly in Node and to
// load via a plain <script> tag in the browser (served statically from
// public/, exactly like index.html itself).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VendorWorkspaceLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // finding F1 (research.md Decision 4): a bill is "open" only when it is
  // neither cancelled nor fully paid AND still carries a real outstanding
  // balance — a bill fully offset via credits alone never transitions to
  // PAID (postVendorBillCredit() never touches status), so status alone
  // is never sufficient on its own.
  function isOpenBill(b) {
    return !!b && b.status !== 'CANCELLED' && b.status !== 'PAID' && (b.outstandingAmount || 0) > 0.001;
  }

  function isOverdueBill(b, todayStr) {
    return !!(b && b.dueDate && b.dueDate < todayStr);
  }

  // T015 (open-items list) / T029 ("overdue only" toggle) — the exact
  // filter renderVndOpenItems()/renderVndBillsSection() apply to
  // _vndWorkspaceBills in public/index.html.
  function filterOpenItems(bills, opts) {
    opts = opts || {};
    const todayStr = opts.todayStr || new Date().toISOString().slice(0, 10);
    let items = (bills || []).filter(isOpenBill);
    if (opts.overdueOnly) items = items.filter(function (b) { return isOverdueBill(b, todayStr); });
    return items;
  }

  // The vendor-list "outstanding only" filter's own real computation
  // (public/index.html's calcVendorBalance()) — sums credit-debit over
  // every journal-entry line matching the vendor's account, by either
  // accountId or accountCode.
  function calcVendorBalanceFromEntries(journalEntries, accountId) {
    const aid = String(accountId == null ? '' : accountId);
    let balance = 0;
    (journalEntries || []).forEach(function (e) {
      (e.lines || []).forEach(function (l) {
        if (String(l.accountId) === aid || String(l.accountCode) === aid) {
          balance += (parseFloat(l.credit) || 0) - (parseFloat(l.debit) || 0);
        }
      });
    });
    return balance;
  }

  return {
    isOpenBill: isOpenBill,
    isOverdueBill: isOverdueBill,
    filterOpenItems: filterOpenItems,
    calcVendorBalanceFromEntries: calcVendorBalanceFromEntries,
  };
});
