#!/usr/bin/env bash
# Mandatory post-redaction check, per image. Two checks, not one:
#   1. negative - none of the forbidden (real, sensitive) strings appear
#   2. positive - the placeholder actually reads back as text (catches a
#      redaction that LOOKS right to the eye but rendered garbled/invisible)
#
# Runs OCR at both 1x and a 3x upscale. This is not belt-and-suspenders -
# tesseract genuinely failed to resolve dialog body text on a downscaled
# 1280x800 store image in testing, returning empty output that would read as
# a false PASS on the negative check. Always trust the upscaled pass; a 1x
# "found nothing" is not sufficient on its own.
#
# Usage: verify_ocr.sh IMAGE.png PLACEHOLDER forbidden1 [forbidden2 ...]
#   e.g. verify_ocr.sh docs/images/import-dialog.png acme-poc realtenant-prod
set -euo pipefail
if [ "$#" -lt 3 ]; then
  echo "usage: verify_ocr.sh IMAGE.png PLACEHOLDER forbidden1 [forbidden2 ...]" >&2
  exit 2
fi
img="$1"; placeholder="$2"; shift 2

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
upscaled="$tmp/upscaled.png"
python3 - "$img" "$upscaled" <<'PY'
import sys
from PIL import Image
img = Image.open(sys.argv[1])
img.resize((img.width * 3, img.height * 3), Image.LANCZOS).save(sys.argv[2])
PY

text_1x=$(tesseract "$img" - 2>/dev/null || true)
text_3x=$(tesseract "$upscaled" - 2>/dev/null || true)
combined="$text_1x
$text_3x"

status=0

if grep -qi -- "$placeholder" <<<"$combined"; then
  echo "PASS (positive): placeholder '$placeholder' reads back via OCR in $img"
else
  echo "FAIL (positive): placeholder '$placeholder' did NOT read back via OCR (1x or 3x) in $img - redaction may be garbled or the placeholder was never drawn"
  status=1
fi

for s in "$@"; do
  if grep -qi -- "$s" <<<"$combined"; then
    echo "FAIL (negative): sensitive string '$s' found in OCR text of $img"
    status=1
  else
    echo "PASS (negative): '$s' not found in OCR text of $img"
  fi
done

exit "$status"
