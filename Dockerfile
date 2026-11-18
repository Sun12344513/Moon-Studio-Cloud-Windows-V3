# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: iso-downloader (No /dev/kvm required)
# Downloads & verifies genuine Windows 10 / Windows 7 ISOs via dockurr/windows
# mirrors using pure HTTP/TLS curl + 7z verification.
#
# Usage (optional prefetch during build):
#   docker build --target iso-downloader --build-arg DOWNLOAD_WIN7=true -t moon-iso .
#   docker compose --profile iso run --rm iso-downloader windows-10
# ==============================================================================
FROM debian:bookworm-slim AS iso-downloader

ARG DEBIAN_FRONTEND=noninteractive
ARG DOWNLOAD_WIN10=false
ARG DOWNLOAD_WIN7=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    p7zip-full \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/data/iso

COPY <<'EOF' /usr/local/bin/download-windows-iso.sh
#!/usr/bin/env bash
set -euo pipefail

OS_ID="${1:-}"
ISO_DIR="${ISO_DIR:-/app/data/iso}"
mkdir -p "$ISO_DIR"

download_with_fallback() {
  local dest="$1"
  shift
  local tmp="${dest}.downloading"
  for url in "$@"; do
    echo "[Dockerfile-ISO] Attempting download (resumable, no /dev/kvm needed): $url -> $dest"
    if curl -fL -sS -C - --connect-timeout 15 --speed-time 45 --speed-limit 1024 \
         --retry 3 --retry-delay 3 \
         -A "Mozilla/5.0 (X11; Linux x86_64) dockurr-windows/1.0" \
         -o "$tmp" "$url"; then
      if [ -s "$tmp" ] && 7z l -ba "$tmp" 2>/dev/null | grep -qiE "install\.(wim|esd|swm)"; then
        mv "$tmp" "$dest"
        echo "[Dockerfile-ISO] Verified genuine Windows ISO: $dest"
        return 0
      fi
      echo "[Dockerfile-ISO] Downloaded file failed Windows ISO payload check, trying next mirror..."
      rm -f "$tmp"
    else
      echo "[Dockerfile-ISO] Mirror failed or interrupted: $url"
    fi
  done
  return 1
}

case "$OS_ID" in
  windows-10|10)
    download_with_fallback "${ISO_DIR}/windows-10-x64.iso" \
      "https://archive.org/download/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96_202302/en-us_windows_10_enterprise_ltsc_2021_x64_dvd_d289cf96.iso" \
      "https://archive.org/download/windows-10-business-editions-version-22h2-updated-oct-2025-en-us/en-us_windows_10_business_editions_version_22h2_updated_oct_2025_x64_dvd_d2eef4b0.iso" \
      "https://dl.bobpony.com/windows/10/en-us_windows_10_22h2_x64.iso"
    ;;
  windows-7|7u)
    download_with_fallback "${ISO_DIR}/windows-7-sp1-x64.iso" \
      "https://files.dog/MSDN/Windows%207/en_windows_7_ultimate_with_sp1_x64_dvd_u_677332.iso" \
      "https://archive.org/download/win7-ult-sp1-english/Win7_Ult_SP1_English_x64.iso"
    ;;
  *)
    echo "Usage: download-windows-iso.sh <windows-10|windows-7>"
    exit 1
    ;;
esac
EOF
RUN chmod +x /usr/local/bin/download-windows-iso.sh

RUN if [ "$DOWNLOAD_WIN10" = "true" ]; then /usr/local/bin/download-windows-iso.sh windows-10; fi && \
    if [ "$DOWNLOAD_WIN7" = "true" ]; then /usr/local/bin/download-windows-iso.sh windows-7; fi

CMD ["bash", "-c", "echo 'Use: download-windows-iso.sh windows-10 | windows-7'"]

# ==============================================================================
# Stage 2: runtime (Moon Studio Cloud Windows — TCG / KVM=N compatible)
# Runs without requiring /dev/kvm: auto-downloads ISOs via dockurr/windows
# mirrors and executes QEMU x86_64 + OVMF + swtpm + XFCE4/xrdp.
# ==============================================================================
FROM node:22-bookworm-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive

ENV NODE_ENV=production \
    PORT=3000 \
    KVM=N \
    ACCEL=tcg

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    genisoimage \
    ovmf \
    p7zip-full \
    procps \
    qemu-system-x86 \
    qemu-utils \
    swtpm \
    swtpm-tools \
    xrdp \
    xfce4 \
    xfce4-terminal \
    dbus-x11 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
COPY --from=iso-downloader /usr/local/bin/download-windows-iso.sh /usr/local/bin/download-windows-iso.sh
COPY --from=iso-downloader /app/data/iso /app/data/iso

RUN npm run build && mkdir -p /app/data/disks /app/data/tpm /app/data/provisioning /app/data/iso

EXPOSE 3000 3389

CMD ["npm", "start"]
