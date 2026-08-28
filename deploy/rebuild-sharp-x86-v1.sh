#!/bin/bash
# Rebuild sharp against a baseline-x86-64 libvips so DSH can run on hosts whose
# CPU (or KVM model) lacks x86-64-v2 / SSE4.2. sharp's linux-x64 prebuilds refuse
# to load on those machines ("Unsupported CPU: ... require v2 microarchitecture").
#
# Intended to run during the DSH image deps stage, after `pnpm install`.
set -euo pipefail

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  # The x86-64-v1/v2 (SSE4.2) split this script works around is an x86-64
  # concept only. /proc/cpuinfo on other architectures never has an
  # "sse4_2" flag either, so the check below would false-positive into
  # rebuilding libvips with x86-64 -march flags on a non-x86 compiler
  # (e.g. "Compiler cc can not compile programs" on arm64/aarch64 hosts).
  echo "mindportalix-dsh: host arch is ${ARCH}, not x86_64 — keeping sharp prebuilds"
  exit 0
fi

if grep -qw sse4_2 /proc/cpuinfo 2>/dev/null; then
  echo "mindportalix-dsh: host has SSE4.2 — keeping sharp prebuilds"
  exit 0
fi

echo "mindportalix-dsh: no SSE4.2 — building libvips + sharp for x86-64-v1"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  pkg-config meson ninja-build ca-certificates curl xz-utils \
  libglib2.0-dev libexpat1-dev \
  libjpeg62-turbo-dev libpng-dev libwebp-dev libtiff-dev \
  libexif-dev libfftw3-dev liborc-0.4-dev

VIPS_VERSION="${VIPS_VERSION:-8.18.6}"
VIPS_PREFIX="${VIPS_PREFIX:-/usr/local}"
BUILD_ROOT="${BUILD_ROOT:-/tmp/vips-build}"
mkdir -p "$BUILD_ROOT"
cd "$BUILD_ROOT"

curl -fsSL \
  "https://github.com/libvips/libvips/releases/download/v${VIPS_VERSION}/vips-${VIPS_VERSION}.tar.xz" \
  -o "vips-${VIPS_VERSION}.tar.xz"
tar -xf "vips-${VIPS_VERSION}.tar.xz"
cd "vips-${VIPS_VERSION}"

# Baseline microarchitecture — no SSE4.2 / x86-64-v2 opcodes.
export CFLAGS="${CFLAGS:--O2 -march=x86-64 -mtune=generic}"
export CXXFLAGS="${CXXFLAGS:--O2 -march=x86-64 -mtune=generic}"

meson setup _build \
  --prefix="$VIPS_PREFIX" \
  --libdir=lib \
  --buildtype=release \
  -Dintrospection=disabled \
  -Dmodules=disabled
meson compile -C _build
meson install -C _build
ldconfig

export PKG_CONFIG_PATH="${VIPS_PREFIX}/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export LD_LIBRARY_PATH="${VIPS_PREFIX}/lib:${LD_LIBRARY_PATH:-}"
pkg-config --modversion vips-cpp

npm install -g node-gyp@10 node-addon-api@8 >/dev/null

SHARP_DIR="$(ls -d /app/node_modules/.pnpm/sharp@*/node_modules/sharp | head -1)"
test -n "$SHARP_DIR"
cd "$SHARP_DIR"

mkdir -p node_modules
ln -sfn "$(npm root -g)/node-gyp" node_modules/node-gyp
ln -sfn "$(npm root -g)/node-addon-api" node_modules/node-addon-api

export SHARP_FORCE_GLOBAL_LIBVIPS=1
export PKG_CONFIG_PATH="${VIPS_PREFIX}/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export LD_LIBRARY_PATH="${VIPS_PREFIX}/lib:${LD_LIBRARY_PATH:-}"
npm run build

test -f "src/build/Release/sharp-linux-x64-"*.node \
  || test -n "$(find src/build/Release -name 'sharp-linux-x64-*.node' -print -quit)"

node --input-type=module -e "
import sharp from './dist/index.mjs';
const buf = await sharp({
  create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 128, b: 255 } },
}).png().toBuffer();
if (!buf.length) throw new Error('sharp produced empty buffer');
console.log('mindportalix-dsh: sharp x86-64-v1 rebuild OK (' + buf.length + ' bytes)');
"

# Drop the v2-only prebuild so nothing can accidentally load it later.
rm -rf node_modules/@img/sharp-linux-x64 \
  ../../@img/sharp-linux-x64 \
  /app/node_modules/.pnpm/@img+sharp-linux-x64@* \
  /app/node_modules/.pnpm/@img+sharp-libvips-linux-x64@* \
  || true

rm -rf "$BUILD_ROOT"
apt-get purge -y -qq meson ninja-build curl xz-utils >/dev/null || true
apt-get autoremove -y -qq >/dev/null || true
rm -rf /var/lib/apt/lists/*

echo "mindportalix-dsh: sharp rebuild complete"
