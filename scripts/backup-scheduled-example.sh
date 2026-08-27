#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# قالب جاهز للاستخدام — P0.5A Step 16.
#
# هذا سكربت مثال (template) فقط — لا يُشغَّل تلقائيًا من هذا المستودع ولا
# من أي CI/CD مرتبط به. لا وجود لأي مهمة مجدولة (cron) حيّة في هذا الكود.
# انسخه وشغّله يدويًا من جدولة المشغّل الخاصة به (راجع
# docs/PRODUCTION_RUNBOOK.md §5.1 لأمثلة Linux cron / Render Cron Job /
# GitHub Actions).
#
# التدفّق: نسخ احتياطي → تحقّق → نقل خارجي (اختياري، يتطلب ضبط
# OFFSITE_UPLOAD_CMD) → تنبيه عند أي فشل (اختياري، يتطلب ضبط
# BACKUP_ALERT_WEBHOOK_URL).
#
# ⚠️ يجب تشغيله من بيئة لها MONGO_URI فعلي يصل لقاعدة الإنتاج — وليس على
# نفس خادم التطبيق إن كان قرصه المحلي غير دائم (راجع §5 في الدليل).
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL_HOOK_URL="${BACKUP_ALERT_WEBHOOK_URL:-}"

alert() {
  echo "❌ $1" >&2
  if [ -n "$FAIL_HOOK_URL" ]; then
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"Boubyan backup failed: $1\"}" "$FAIL_HOOK_URL" || true
  fi
}

if ! node scripts/backup.js; then
  alert "scripts/backup.js exited non-zero"
  exit 1
fi

LATEST_BACKUP=$(ls -t backups/backup-*.json 2>/dev/null | head -n1 || true)
if [ -z "$LATEST_BACKUP" ]; then
  alert "no backup file found after scripts/backup.js ran"
  exit 1
fi

if ! node scripts/verify-backup.js "$LATEST_BACKUP"; then
  alert "verify-backup.js rejected $LATEST_BACKUP"
  exit 1
fi

# OFFSITE_UPLOAD_CMD مثال: 'aws s3 cp' أو 'rclone copyto remote:bucket/' —
# غير مضبوط افتراضيًا (لا اعتماد على أي مزوّد سحابي بعينه في هذا الكود).
if [ -n "${OFFSITE_UPLOAD_CMD:-}" ]; then
  if ! eval "$OFFSITE_UPLOAD_CMD \"$LATEST_BACKUP\" \"$LATEST_BACKUP.sha256\""; then
    alert "off-site upload command failed for $LATEST_BACKUP"
    exit 1
  fi
  echo "✅ نُقلت النسخة خارج الخادم أيضًا."
else
  echo "⚠️  OFFSITE_UPLOAD_CMD غير مضبوط — النسخة محلية فقط (ليست off-site). راجع docs/PRODUCTION_RUNBOOK.md §5.1."
fi

echo "✅ اكتمل: نسخ + تحقّق لـ $LATEST_BACKUP"
