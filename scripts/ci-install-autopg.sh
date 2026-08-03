#!/usr/bin/env bash
# Binary-only autopg install for CI (and postinstall when CEDAR_PG_INSTALL_AUTOPG=1).
# Fetches pinned release, verifies attestation, installs binary — no pm2.
# Version pin: scripts/autopg-version (override with AUTOPG_VERSION).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${AUTOPG_VERSION:-}" ]; then
  AUTOPG_VERSION="$(tr -d '[:space:]' <"${SCRIPT_DIR}/autopg-version")"
fi
VERSION="${AUTOPG_VERSION}"
REPO="${AUTOPG_REPO:-automagik-dev/autopg}"
LEGACY_REPO="${AUTOPG_LEGACY_REPO:-namastexlabs/pgserve}"

detect_libc() {
  if [ -e /lib/ld-musl-x86_64.so.1 ] || (ldd --version 2>&1 | grep -qi musl); then
    echo musl
  else
    echo glibc
  fi
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM="linux-x64-$(detect_libc)" ;;
  Linux-aarch64) PLATFORM="linux-arm64" ;;
  Darwin-arm64) PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  *)
    echo "[ci-install-autopg] unsupported platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

if [ -x "${HOME}/.local/bin/autopg" ]; then
  echo "[ci-install-autopg] already present: ${HOME}/.local/bin/autopg"
  exit 0
fi

TARBALL="autopg-${VERSION#v}-${PLATFORM}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[ci-install-autopg] fetching ${URL}"
curl -fsSL --output "${TMP}/${TARBALL}" "${URL}"

if ! command -v gh >/dev/null 2>&1; then
  echo "[ci-install-autopg] gh CLI required for attestation verify" >&2
  exit 1
fi

echo "[ci-install-autopg] verifying attestation"
if ! gh attestation verify "${TMP}/${TARBALL}" --repo "${REPO}" \
  && ! gh attestation verify "${TMP}/${TARBALL}" --repo "${LEGACY_REPO}"; then
  echo "[ci-install-autopg] attestation verify failed" >&2
  exit 1
fi

echo "[ci-install-autopg] extracting binary tree"
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}"
SRC="${TMP}/autopg"
if [ ! -x "${SRC}/autopg" ]; then
  echo "[ci-install-autopg] unexpected tarball layout: ${SRC}/autopg missing" >&2
  exit 1
fi

INSTALL_DIR="${HOME}/.local/share/autopg/${VERSION}"
mkdir -p "${INSTALL_DIR}" "${HOME}/.local/bin"
cp -a "${SRC}/." "${INSTALL_DIR}/"
ln -sfn "${INSTALL_DIR}/autopg" "${HOME}/.local/bin/autopg"

echo "[ci-install-autopg] ok — $(command -v autopg || echo "${HOME}/.local/bin/autopg")"
"${HOME}/.local/bin/autopg" --help >/dev/null
