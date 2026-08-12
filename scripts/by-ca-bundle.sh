#!/usr/bin/env bash
# Build the ГосСУОК trust bundle needed to VERIFY Priorbank's production server certificate,
# and check it against the live host (issue #459).
#
# WHY. The live probe (#457) proved the crypto works but ended on
# `Verify return code: 21 (unable to verify the first certificate)`: the channel is encrypted while
# the peer is unproven, which is not something to ship. The bank's certificate is issued by
# «Республиканский удостоверяющий центр ГосСУОК» (РУП «НЦЭУ») and the server sends ONLY its own leaf
# — no intermediate — so the bundle must carry BOTH the intermediate (РУЦ) and the root (КУЦ).
#
# ⚠ NOT a client certificate. No ГосСУОК key, no hardware token, no accountant involved: these are
# PUBLIC CA certificates, the same ones every browser-side BY crypto tool ships with.
#
# ⚠ RUN FROM BELARUS (the deploy server). nces.by answers 503 to foreign egress, which is why this
# step cannot be done from a dev container.
#
# Usage: bash scripts/by-ca-bundle.sh [--out DIR] [--host HOST] [--port PORT] [--openssl PATH]
#   --openssl  path to the bee2evp-patched openssl (default: the one bee2evp-probe.sh built)

set -uo pipefail

OUT="${TMPDIR:-/tmp}/by-ca"
HOST="apibel.priorbank.by"
PORT="9345"
OSSL=""
PROBE_WORK="${TMPDIR:-/tmp}/bee2evp-probe"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?--out requires a path}"; shift ;;
    --host) HOST="${2:?--host requires a value}"; shift ;;
    --port) PORT="${2:?--port requires a value}"; shift ;;
    --openssl) OSSL="${2:?--openssl requires a path}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n=== %s ===\n' "$1"; }

# Prefer the patched build — only it can TALK to the bank. Plain openssl is still fine for the
# certificate arithmetic below (parsing, hashing, verifying), so a missing build is not fatal until
# the final live check.
if [[ -z "$OSSL" ]]; then
  OSSL="$(find "$PROBE_WORK" -type f -name openssl -perm -u+x 2>/dev/null | grep -E '/local/bin/openssl$' | head -1)"
fi
if [[ -n "$OSSL" && -x "$OSSL" ]]; then
  LIBDIR="$(dirname "$(dirname "$OSSL")")/lib"
  PATCHED=1
else
  OSSL="$(command -v openssl)"; LIBDIR=""; PATCHED=0
fi
ossl() { LD_LIBRARY_PATH="${LIBDIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$OSSL" "$@"; }

# `-nameopt utf8,-esc_msb` — without it OpenSSL prints Cyrillic as \D0\9A escapes, and the whole
# point of this script is that a human can SEE which CA each file belongs to.
name_of() { ossl x509 -in "$1" -inform "${2:-PEM}" -noout -subject -nameopt utf8,-esc_msb,sep_comma_plus_space 2>/dev/null; }
# Just the CN. Byte-slicing a UTF-8 line (`cut -c1-90`) chops Cyrillic mid-character and prints
# mojibake — measured on the live run. The CN is short enough to need no truncation at all.
cn_of() { name_of "$1" "${2:-PEM}" | grep -oE 'CN *= *[^,]+' | head -1 | sed 's/CN *= *//'; }

mkdir -p "$OUT" || { echo "не могу создать $OUT" >&2; exit 1; }

say "1. Сертификат сервера ${HOST}:${PORT} — кто его издатель"
leaf="$OUT/leaf.pem"
if [[ $PATCHED -eq 1 ]]; then
  timeout 40 env LD_LIBRARY_PATH="$LIBDIR" "$OSSL" s_client -connect "${HOST}:${PORT}" \
    -servername "$HOST" -showcerts </dev/null 2>/dev/null \
    | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' > "$leaf"
fi
if [[ ! -s "$leaf" ]]; then
  echo "не удалось забрать сертификат сервера."
  [[ $PATCHED -eq 0 ]] && echo "  причина: не найден пропатченный openssl — сначала прогоните scripts/bee2evp-probe.sh"
  echo "  (без него дальше можно только собрать bundle, но не проверить его)"
else
  echo "  subject: $(ossl x509 -in "$leaf" -noout -subject -nameopt utf8,-esc_msb,sep_comma_plus_space | sed 's/^subject=//')"
  echo "  issuer : $(ossl x509 -in "$leaf" -noout -issuer  -nameopt utf8,-esc_msb,sep_comma_plus_space | sed 's/^issuer=//')"
  want_hash="$(ossl x509 -in "$leaf" -noout -issuer_hash 2>/dev/null)"
  echo "  ищем УЦ с subject_hash = $want_hash"
fi

say "2. Скачиваю кандидатов из ГосСУОК (nces.by)"
# The candidate list mirrors what AvTunProxy's trust firmware fetches: ruc* = Республиканский УЦ
# (intermediate), kuc* = Корневой УЦ (root). Several generations coexist, so we download all and
# pick by hash rather than guessing which one is current.
BASE="https://nces.by/wp-content/uploads/certificates/pki"
CANDIDATES=(ruc.cer ruc2.cer ruc3.cer kuc1.cer kuc2.cer)
got=0
for f in "${CANDIDATES[@]}"; do
  printf '  %-10s ' "$f"
  if timeout 60 curl -sS -fL -o "$OUT/$f" "$BASE/$f" 2>/dev/null && [[ -s "$OUT/$f" ]]; then
    # Files are published DER; normalise to PEM so everything downstream is uniform.
    if ossl x509 -inform DER -in "$OUT/$f" -out "$OUT/${f%.cer}.pem" 2>/dev/null \
       || ossl x509 -inform PEM -in "$OUT/$f" -out "$OUT/${f%.cer}.pem" 2>/dev/null; then
      got=$((got+1))
      echo "ok — $(cn_of "$OUT/${f%.cer}.pem")"
    else
      echo "скачан, но это не сертификат"
    fi
  else
    echo "НЕ СКАЧАЛСЯ"
  fi
done
if [[ $got -eq 0 ]]; then
  echo
  echo "Ни один файл не скачался. Если вы ВНЕ Беларуси — так и будет: nces.by отдаёт 503 чужому"
  echo "трафику. Запускайте с деплой-сервера."
  exit 1
fi

say "3. Собираю цепочку: промежуточный (РУЦ) → корень (КУЦ)"
# Walk UP by hashes instead of trusting filenames: `ruc3.cer` is not guaranteed to be the current
# issuer, and a wrong guess produces a bundle that fails only at the live check — far from the cause.
bundle="$OUT/gossuok-bundle.pem"
: > "$bundle"
chain_ok=0
if [[ -n "${want_hash:-}" ]]; then
  cur="$want_hash"
  for _ in 1 2 3 4; do
    found=""
    for p in "$OUT"/*.pem; do
      [[ "$p" == "$leaf" ]] && continue
      [[ "$(ossl x509 -in "$p" -noout -subject_hash 2>/dev/null)" == "$cur" ]] && { found="$p"; break; }
    done
    [[ -z "$found" ]] && { echo "  не нашёл сертификат с subject_hash=$cur среди скачанных"; break; }
    echo "  + $(basename "$found") — $(cn_of "$found")"
    cat "$found" >> "$bundle"
    sub="$(ossl x509 -in "$found" -noout -subject_hash)"
    iss="$(ossl x509 -in "$found" -noout -issuer_hash)"
    [[ "$sub" == "$iss" ]] && { echo "  (самоподписанный — это корень, цепочка замкнута)"; chain_ok=1; break; }
    cur="$iss"
  done
else
  echo "  сертификат сервера не получен — кладу в bundle всё скачанное (менее точно, но рабочее)"
  cat "$OUT"/*.pem > "$bundle" 2>/dev/null
fi

say "4. Что вошло в bundle и до каких пор оно живёт"
# Split and inspect each certificate SEPARATELY. `pkcs7 -print_certs` over the whole bundle prints
# nothing here — these certificates carry bign (СТБ 34.101.45) public keys, and that print path
# trips over them. Measured on the live bundle, not assumed.
rm -f "$OUT"/split-*.pem
awk -v d="$OUT" 'BEGIN{c=0} /BEGIN CERT/{c++} c>0 {print > (d "/split-" c ".pem")}' "$bundle" 2>/dev/null
for p in "$OUT"/split-*.pem; do
  [[ -s "$p" ]] || continue
  nd="$(ossl x509 -in "$p" -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
  echo "  $(cn_of "$p")"
  echo "      издатель: $(ossl x509 -in "$p" -noout -issuer -nameopt utf8,-esc_msb,sep_comma_plus_space 2>/dev/null | grep -oE 'CN *= *[^,]+' | sed 's/CN *= *//')"
  echo "      действует до: ${nd:-?}"
done
echo
echo "  файл:   $bundle"
echo "  sha256: $(sha256sum "$bundle" | cut -d' ' -f1)"
echo
echo "  ⚠ Эти сертификаты НЕ читаются обычным openssl — ключи на bign (СТБ 34.101.45), стоковый"
echo "    OpenSSL отдаёт 'X509_PUBKEY_get0: decode error'. Любая обвязка вокруг bundle (мониторинг"
echo "    сроков, проверка ротации — #462) обязана использовать пропатченную сборку."

say "5. Живая проверка"
if [[ $PATCHED -eq 1 && -s "$bundle" ]]; then
  out="$(timeout 40 env LD_LIBRARY_PATH="$LIBDIR" "$OSSL" s_client -connect "${HOST}:${PORT}" \
    -servername "$HOST" -CAfile "$bundle" </dev/null 2>&1)"
  grep -E "Cipher is|Verify return code" <<<"$out" | sed 's/^/  /'
  if grep -q "Verify return code: 0 (ok)" <<<"$out"; then
    echo
    echo "✅ СЕРТИФИКАТ БАНКА ПРОВЕРЕН. Канал шифруется И собеседник подтверждён — цель #459."
    echo "   Передайте этот bundle в шлюз (#460): $bundle"
  else
    echo
    echo "❌ Проверка не прошла. Смотрите строку выше."
    echo "   Если 'unable to get local issuer' — в bundle не хватает звена: проверьте раздел 3."
  fi
else
  echo "  пропущено: нет пропатченного openssl (см. scripts/bee2evp-probe.sh) или пустой bundle"
fi
