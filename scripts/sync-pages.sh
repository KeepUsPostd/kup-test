#!/bin/bash
# ============================================================
# sync-pages.sh — Keep /app/ and /pages/inner/ HTML files in sync
# ============================================================
#
# CONTEXT: The KUP platform has duplicate HTML pages in two directories:
#   /public/app/          — secondary copies
#   /public/pages/inner/  — PRIMARY (user navigates here)
#
# This script syncs files between them so edits to either location
# are reflected in both. It uses the NEWER file as the source of truth.
#
# Usage:
#   ./scripts/sync-pages.sh          # Dry run (shows what would change)
#   ./scripts/sync-pages.sh --apply  # Actually sync files
#
# ============================================================

APP_DIR="public/app"
INNER_DIR="public/pages/inner"
APPLY=false

if [ "$1" = "--apply" ]; then
  APPLY=true
fi

echo "🔄 KUP Page Sync — Checking for drift between /app/ and /pages/inner/"
echo "=================================================================="
echo ""

DRIFT_COUNT=0

for file in "$INNER_DIR"/*.html; do
  filename=$(basename "$file")
  app_file="$APP_DIR/$filename"

  # Skip if no matching file in /app/
  if [ ! -f "$app_file" ]; then
    continue
  fi

  # Compare files
  if ! diff -q "$app_file" "$file" > /dev/null 2>&1; then
    DRIFT_COUNT=$((DRIFT_COUNT + 1))

    app_mod=$(stat -f %m "$app_file")
    inner_mod=$(stat -f %m "$file")
    app_size=$(stat -f %z "$app_file")
    inner_size=$(stat -f %z "$file")

    if [ "$app_mod" -gt "$inner_mod" ]; then
      echo "⚠️  $filename — /app/ is NEWER ($app_size bytes vs $inner_size bytes)"
      if [ "$APPLY" = true ]; then
        cp "$app_file" "$file"
        echo "   ✅ Copied /app/ → /pages/inner/"
      else
        echo "   → Would copy /app/ → /pages/inner/"
      fi
    elif [ "$inner_mod" -gt "$app_mod" ]; then
      echo "⚠️  $filename — /pages/inner/ is NEWER ($inner_size bytes vs $app_size bytes)"
      if [ "$APPLY" = true ]; then
        cp "$file" "$app_file"
        # Fix relative paths for /app/ directory (../../ → / absolute)
        sed -i '' 's|../../js/|/js/|g' "$app_file"
        sed -i '' 's|../../css/|/css/|g' "$app_file"
        sed -i '' 's|../../assets/|/assets/|g' "$app_file"
        sed -i '' "s|href=\"../login.html\"|href=\"/pages/login.html\"|g" "$app_file"
        sed -i '' "s|href='../login.html'|href='/pages/login.html'|g" "$app_file"
        echo "   ✅ Copied /pages/inner/ → /app/ (paths fixed)"
      else
        echo "   → Would copy /pages/inner/ → /app/"
      fi
    else
      echo "⚠️  $filename — Same age but different content ($app_size vs $inner_size bytes)"
      echo "   → Manual review needed"
    fi
  fi
done

# Check for files only in /app/
for file in "$APP_DIR"/*.html; do
  filename=$(basename "$file")
  if [ ! -f "$INNER_DIR/$filename" ]; then
    echo "📄 $filename — exists only in /app/ (no /pages/inner/ copy)"
  fi
done

echo ""
if [ "$DRIFT_COUNT" -eq 0 ]; then
  echo "✅ All files are in sync!"
else
  echo "Found $DRIFT_COUNT file(s) with drift."
  if [ "$APPLY" = false ]; then
    echo "Run with --apply to sync: ./scripts/sync-pages.sh --apply"
  fi
fi
