#!/usr/bin/env bash
# Probe whether the OPEN-SOURCE Belarusian crypto stack (bee2 + bee2evp, github.com/bcrypto)
# can establish a STB 34.101.65 TLS session with Priorbank's production Open Banking host —
# i.e. whether we can drop the dependency on AVEST's proprietary СКЗИ entirely (issue #457).
#
# WHY THIS EXISTS. The only working path to Priorbank prod found so far is AvTunProxy (ЗАО «АВЕСТ»),
# and it is blocked on one entry in a vendor-signed resource list we cannot edit (#41). AVEST is a
# monopolist with no obligation to us. This script answers the one question that would remove that
# dependency: does the open implementation speak the same ciphersuite the bank's server does?
#
# WHAT WE ALREADY KNOW (from #41, measured — not assumed):
#   - Plain OpenSSL cannot negotiate with apibel.priorbank.by:9345 at all ("unknown cipher returned").
#   - AvTunProxy negotiated ciphersuite 65303 = 0xFF17 with openapi.mtbank.by — in bee2evp's patch
#     that id is BDHT-BIGN_WITH-BELT-CTR-MAC-HBELT, i.e. the open stack implements the very suite
#     Belarusian bank infrastructure runs on. That is what makes this probe worth running.
#
# ⚠ MUST RUN FROM A HOST WITH NETWORK ACCESS TO THE BANK (the deploy server). Port 9345 is not
# reachable from dev containers, and a network failure here looks nothing like a crypto failure —
# see the verdict block at the end, which distinguishes them explicitly.
#
# ⚠ Passing this probe is NOT permission to ship. Whether a NON-CERTIFIED implementation satisfies
# СПР 6.02 is a legal question for the bank, asked in writing, and it is independent of this result.
#
# Usage:  bash scripts/bee2evp-probe.sh [--keep] [--host HOST] [--port PORT]
#   --keep   suppress the reminder to clean up the build directory. The directory is NEVER
#            deleted automatically — an OpenSSL build takes minutes and the next run reuses
#            it. It is multi-GB and lives in $TMPDIR, so on the deploy server (which also
#            runs Postgres and Redis) remove it by hand when you are done.

set -uo pipefail

HOST="apibel.priorbank.by"
PORT="9345"
KEEP=0
CAFILE=""
WORK="${TMPDIR:-/tmp}/bee2evp-probe"
# Keep these two in step with deploy/crypto-gateway/Dockerfile — the whole point of the probe
# is to answer a question about the stack we actually ship.
OPENSSL_TAG="openssl-3.5.6"
BEE2EVP_COMMIT="2ae3c71e8b24b6904367850e5963933236a1539f"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --host) HOST="${2:?--host requires a value}"; shift ;;
    --port) PORT="${2:?--port requires a value}"; shift ;;
    --cafile) CAFILE="${2:?--cafile requires a path}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [[ -n "$CAFILE" && ! -r "$CAFILE" ]]; then
  echo "--cafile: файл не читается: $CAFILE" >&2; exit 2
fi

say() { printf '\n=== %s ===\n' "$1"; }

say "0. Предусловия"
missing=""
for c in git gcc cmake make python3 openssl; do
  command -v "$c" >/dev/null || missing="$missing $c"
done
if [[ -n "$missing" ]]; then
  echo "НЕ ХВАТАЕТ:$missing"
  echo "Debian/Ubuntu:  sudo apt-get install -y git gcc cmake make python3 openssl"
  exit 1
fi
echo "всё на месте"

# Baseline first: a plain-OpenSSL failure here is the CONTROL for the probe below. Without it a
# later success proves nothing (the host might simply have started accepting ordinary TLS), and a
# later failure cannot be told apart from the network being down.
say "1. Контроль: обычный OpenSSL против ${HOST}:${PORT}"
base_out="$(timeout 25 openssl s_client -connect "${HOST}:${PORT}" -servername "$HOST" </dev/null 2>&1)"
if grep -q "unknown cipher returned" <<<"$base_out"; then
  echo "ОЖИДАЕМО: обычный TLS не согласуется (сервер отвечает белорусским шифром)"
elif grep -qE "Cipher is (TLS|ECDHE|AES)" <<<"$base_out"; then
  echo "⚠ НЕОЖИДАННО: обычный OpenSSL СОГЛАСОВАЛ шифр — хост принимает обычный TLS."
  echo "  Тогда СКЗИ для него не нужен вовсе, и эта проверка теряет смысл. Проверьте адрес."
  exit 0
else
  echo "⚠ Ни того, ни другого — вероятно, нет сети до банка. Дальше идти бессмысленно:"
  grep -m1 -E "connect:|socket|timeout" <<<"$base_out" || echo "$base_out" | head -3
  exit 1
fi

say "2. Сборка bee2evp + OpenSSL с патчем BTLS (${OPENSSL_TAG})"
if [[ -x "$WORK/bee2evp/build/openssl/apps/openssl" ]]; then
  echo "уже собрано, переиспользую: $WORK"
else
  mkdir -p "$WORK"
  # Same commit the shipped image pins (deploy/crypto-gateway/Dockerfile, BEE2EVP_COMMIT).
  # Probing a moving HEAD would eventually answer a question about code we do not deploy.
  if [[ ! -d "$WORK/bee2evp/.git" ]]; then
    git clone -q https://github.com/bcrypto/bee2evp "$WORK/bee2evp"
    git -C "$WORK/bee2evp" checkout -q "$BEE2EVP_COMMIT" || {
      echo "не удалось перейти на коммит $BEE2EVP_COMMIT — сверьтесь с Dockerfile шлюза"; exit 1; }
  fi
  echo "собираю (это долго — сборка OpenSSL из исходников)…"
  ( cd "$WORK/bee2evp" && bash ./scripts/build.sh -s -b "$OPENSSL_TAG" ) \
    > "$WORK/build.log" 2>&1 || { echo "СБОРКА УПАЛА, хвост лога:"; tail -20 "$WORK/build.log"; exit 1; }
  echo "готово"
fi

# The build script lays OpenSSL out under the work dir; find the binary rather than hardcoding a
# path, because the layout has changed between bee2evp revisions. Prefer the INSTALLED copy
# (build/local/bin) over the in-tree one (build/openssl/apps) — only the former sits next to the
# matching libs.
OSSL="$(find "$WORK" -type f -name openssl -perm -u+x 2>/dev/null | grep -E '/local/bin/openssl$' | head -1)"
[[ -n "$OSSL" ]] || OSSL="$(find "$WORK" -type f -name openssl -perm -u+x 2>/dev/null | grep -E '/apps/openssl$' | head -1)"
if [[ -z "$OSSL" ]]; then
  echo "не нашёл собранный openssl под $WORK — смотрите $WORK/build.log"; exit 1
fi

# ⚠ WITHOUT THIS the binary silently binds the SYSTEM libssl/libcrypto and dies with
# "version `OPENSSL_3.3.0' not found" — or, worse on a host whose system OpenSSL happens to be new
# enough, LOADS IT and reports no BTLS suites at all. That reads as «bee2evp does not support the
# ciphersuites» and would kill the investigation on a false negative. Measured, not theoretical.
LIBDIR="$(dirname "$(dirname "$OSSL")")/lib"
[[ -d "$LIBDIR" ]] || LIBDIR="$(dirname "$OSSL")"
ossl() { LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$OSSL" "$@"; }
echo "openssl: $OSSL"
echo "библиотеки: $LIBDIR"
ossl version 2>&1 | head -1

say "3. Есть ли шифронаборы СТБ 34.101.65 в сборке"
suites="$(ossl ciphers -v 'ALL:eNULL' 2>/dev/null | grep -iE "BIGN|BELT" || true)"
if [[ -z "$suites" ]]; then
  echo "НЕТ — сборка без BTLS-наборов. Дальше проверять нечего."
  echo "Проверьте, что build.sh применил патч из btls/patch/${OPENSSL_TAG}.patch"
  exit 1
fi
echo "$suites"

say "4. Рукопожатие с ${HOST}:${PORT} через bee2evp"
verify_args=()
[[ -n "$CAFILE" ]] && verify_args=(-CAfile "$CAFILE" -verify_return_error)
probe_out="$(timeout 40 env LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$OSSL" s_client -connect "${HOST}:${PORT}" -servername "$HOST" -showcerts \
  "${verify_args[@]}" </dev/null 2>&1)"
echo "$probe_out" | grep -iE "Cipher is|Protocol|Verify return code|handshake has read|unknown cipher|alert" | head -8

# The chain the server actually sends, plus WHERE its issuer can be fetched. Without this the
# «which root do we need» question turns into guesswork across nces.by / avest.by / belpost /
# nalog.gov.by — while the certificate itself names its issuer and (via the AIA extension) the URL
# to download it from. Cheap to print, saves a round of blind downloading (#459).
say "5. Цепочка, которую прислал сервер (кто издатель и где его взять)"
chain="$(printf '%s\n' "$probe_out" | ossl crl2pkcs7 -nocrl -certfile /dev/stdin 2>/dev/null \
  | ossl pkcs7 -print_certs -noout 2>/dev/null || true)"
if [[ -n "$chain" ]]; then
  printf '%s\n' "$chain"
else
  printf '%s\n' "$probe_out" | grep -E "^ *[0-9]+ s:|^ *i:|^subject=|^issuer=" | head -10
fi
aia="$(printf '%s\n' "$probe_out" | ossl x509 -noout -text 2>/dev/null \
  | grep -A2 -iE "Authority Information Access|CRL Distribution" | grep -oE "URI:[^ ]+" | sort -u || true)"
if [[ -n "$aia" ]]; then
  echo "--- откуда качать издателя / списки отзыва ---"
  printf '%s\n' "$aia"
else
  echo "(AIA/CRL в сертификате не указаны — издателя искать по имени: nces.by / avest.by)"
fi

say "ВЕРДИКТ"
if grep -qiE "Cipher is (BDH|DHE-BIGN|DHT-BIGN)" <<<"$probe_out"; then
  echo "✅ ШИФР СОГЛАСОВАН. Открытая реализация говорит с сервером банка."
  # Encryption without authentication is NOT the goal: an unverified peer means the channel is
  # private but the counterparty is unproven. Report the two independently — conflating them is
  # exactly how «работает» gets declared a step too early.
  if grep -q "Verify return code: 0 (ok)" <<<"$probe_out"; then
    echo "✅ СЕРТИФИКАТ ПРОВЕРЕН — собеседник подтверждён. Это и есть цель этапа #459."
  elif [[ -z "$CAFILE" ]]; then
    echo "⚠ Сертификат НЕ проверялся: корни не переданы. Канал шифруется, но собеседник"
    echo "   не подтверждён — от подмены это не защищает. Повторите с --cafile <bundle> (#459),"
    echo "   издателя и адрес для скачивания смотрите в разделе 5 выше."
  else
    echo "❌ СЕРТИФИКАТ НЕ ПРОШЁЛ ПРОВЕРКУ переданным bundle:"
    grep -m1 "Verify return code" <<<"$probe_out"
    echo "   Частая причина — сервер не прислал ПРОМЕЖУТОЧНЫЙ сертификат: его надо добыть"
    echo "   отдельно (адрес — в разделе 5) и положить в bundle рядом с корнем."
  fi
elif grep -q "unknown cipher returned" <<<"$probe_out"; then
  echo "❌ НЕ СОГЛАСОВАН — тот же отказ, что и у обычного OpenSSL."
  echo "   Значит патч BTLS не подхватился либо банк использует набор вне реализованных."
  echo "   Полный вывод сохранён: $WORK/probe.log"
else
  echo "⚠ НЕОДНОЗНАЧНО — смотрите $WORK/probe.log целиком."
fi
printf '%s\n' "$probe_out" > "$WORK/probe.log"

[[ $KEEP -eq 1 ]] || echo "(каталог сборки оставлен в $WORK — удалите вручную, если не нужен)"
