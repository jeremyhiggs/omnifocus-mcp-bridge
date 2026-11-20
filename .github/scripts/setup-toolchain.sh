#!/usr/bin/env bash
set -euo pipefail

# Digests from the signed Node.js v24.22.3 release manifest.
version=24.22.3
case "$(uname -s):$(uname -m)" in
  Linux:x86_64)
    platform=linux-x64
    digest=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2
    ;;
  Darwin:arm64)
    platform=darwin-arm64
    digest=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
    ;;
  Darwin:x86_64)
    platform=darwin-x64
    digest=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7
    ;;
  *)
    echo "Unsupported CI runner platform: $(uname -sm)" >&2
    exit 1
    ;;
esac

if [[ "$(cat .node-version)" != "${version%%.*}" ]]; then
  echo "The verified CI Node release must match the major in .node-version" >&2
  exit 1
fi

toolchain=$(mktemp -d "${RUNNER_TEMP:?}/bridge-toolchain.XXXXXX")
archive="node-v${version}-${platform}.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
  "https://nodejs.org/dist/v${version}/${archive}" -o "$toolchain/$archive"
printf '%s  %s\n' "$digest" "$toolchain/$archive" | shasum -a 256 --check
tar -xzf "$toolchain/$archive" -C "$toolchain" --strip-components=1

export PATH="$toolchain/bin:$PATH"
export COREPACK_HOME="$toolchain/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack install
corepack enable --install-directory "$toolchain/bin" pnpm
pnpm --version

printf '%s\n' "$toolchain/bin" >> "${GITHUB_PATH:?}"
printf 'COREPACK_HOME=%s\n' "$COREPACK_HOME" >> "${GITHUB_ENV:?}"
