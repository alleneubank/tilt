#!/usr/bin/env bash
# release-fork.sh — build and publish a multi-platform "-fork" release of this
# Tilt fork, in the exact tarball shape tilt-overlay's sources.json consumes.
#
# Fork-only tooling (subject prefix [fork] on the commit that introduced it).
# Canonical product history lives on `master` of this fork (see AGENTS.md).
# Releases are cut from master; do not maintain a parallel product branch.
#
# Produces github.com/<REPO> releases tagged
#   v<base>-fork.<date>.g<sha>   e.g. v0.37.5-fork.20260711.g4c1d05bf6
# where <base> is the nearest upstream release tag this fork builds on. The
# "-fork.*" suffix is a valid SemVer prerelease, so GitHub's /releases/latest
# endpoint never surfaces a fork build — the overlay selects fork versions
# explicitly (TILT_VERSION / tiltVersion).
#
# Covers exactly the three platforms the overlay's consumers request via
# canton-monorepo's tiltForkSystems. aarch64-linux is deliberately absent:
# consumers fall back to upstream Tilt there.
#
# Host requirement: darwin/arm64 with Docker. Both darwin slices are built
# natively (clang is a cross-compiler on macOS, so one host covers arm64 and
# x86_64); linux/amd64 is built in a container because the binary needs CGO
# against glibc. There is no supported way to produce the darwin artifacts off
# a Mac, so this script does not try.
#
# Safe by default: a bare run BUILDS and prints the release plan but publishes
# nothing. Publishing (git tag + gh release) is a boundary action gated behind
# --publish, which the human runs deliberately.
#
# Usage:
#   hack/release-fork.sh              # dry run: build + local artifacts + plan
#   hack/release-fork.sh --publish    # also tag and create the GitHub release
set -euo pipefail

REPO="${FORK_REPO:-alleneubank/tilt}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pinned so the linux artifact is reproducible independently of whatever Go the
# host happens to carry; keep in step with the `go` directive in go.mod.
GO_IMAGE="${FORK_GO_IMAGE:-golang:1.26.5-bookworm}"

# Persists the container's build cache across runs — a cold CGO build under
# emulation is slow enough that this is the difference between minutes and tens
# of minutes.
GO_CACHE_VOLUME="${FORK_GO_CACHE_VOLUME:-tilt-fork-gocache}"

# goos/goarch : archive infix. The infix mirrors upstream goreleaser's
# name_template (darwin => "mac", amd64 => "x86_64"), which is what the overlay
# expects to find at the release URL.
TARGETS=(
  "darwin/arm64:mac.arm64"
  "darwin/amd64:mac.x86_64"
  "linux/amd64:linux.x86_64"
)

PUBLISH=false
[[ "${1:-}" == "--publish" ]] && PUBLISH=true

# --- host preconditions ----------------------------------------------------
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: must run on darwin/arm64 — the mac.* artifacts need a Mac host" >&2
  exit 1
fi
for cmd in docker go make git gh; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd not found" >&2; exit 1; }
done

# macOS ships shasum, not GNU sha256sum; emit the sha256sum format either way
# because that is what checksums.txt consumers parse.
sha256_lines() {
  if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# --- version ---------------------------------------------------------------
# Base pins which upstream release this fork tracks; the date is human-readable
# and the short SHA makes every build uniquely traceable to a commit. The `g`
# prefix keeps the SHA segment non-numeric so it can never trip SemVer's
# "no leading zero in a numeric identifier" rule.
# Nearest *upstream* semver tag only — never a prior -fork release, or BASE
# stacks as 0.37.5-fork.<date>.g<sha>-fork.<date2>.g...
BASE="$(
  git tag -l 'v[0-9]*' --sort=-v:refname \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | head -1 \
    | sed 's/^v//'
)"
if [[ -z "$BASE" ]]; then
  echo "error: no upstream-style vX.Y.Z tag found for BASE" >&2
  exit 1
fi
DATE="$(date -u +%Y%m%d)"
SHA="$(git rev-parse --short=9 HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
VERSION="${BASE}-fork.${DATE}.g${SHA}"
TAG="v${VERSION}"
DATE_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# A dirty tree means the artifact would not be reproducible from the tag. The
# perf harness under hack/ is git-excluded (.git/info/exclude), so it never
# counts here; any tracked change must be committed before releasing.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit or stash before releasing" >&2
  git status --short >&2
  exit 1
fi

DIST="$ROOT/dist/fork-release"
rm -rf "$DIST"
mkdir -p "$DIST"

LDFLAGS="-s -w \
  -X main.version=${VERSION} \
  -X main.date=${DATE_ISO} \
  -X github.com/tilt-dev/tilt/internal/cli.commitSHA=${FULL_SHA}"

# --- web assets ------------------------------------------------------------
# build-js only copies web/build over the top of pkg/assets/build, so without a
# clean the directory accumulates every previously built bundle and each one is
# embedded in the binary forever. git clean drops the ignored build output and
# keeps the two tracked files (.gitignore, robots.txt).
echo "==> cleaning pkg/assets/build"
git clean -xfdq pkg/assets/build

echo "==> building web assets (make build-js)"
make build-js

# The binary embeds whatever is in pkg/assets/build; more than one main bundle
# means the clean above failed and the artifact is carrying dead weight.
bundle_count="$(find pkg/assets/build/static/js -name 'main.*.js' -type f | wc -l | tr -d ' ')"
if [[ "$bundle_count" != "1" ]]; then
  echo "error: expected exactly 1 main bundle in pkg/assets/build, found $bundle_count" >&2
  exit 1
fi

# --- builds ----------------------------------------------------------------
# Guards against the failure this script previously shipped: an archive labelled
# for one platform holding a binary built for another. Reads the Go build info
# rather than `file`, so it is exact and not locale/format dependent.
assert_platform() {
  local bin="$1" want_goos="$2" want_goarch="$3" got_goos got_goarch
  got_goos="$(go version -m "$bin" | awk -F= '$1 ~ /GOOS$/ {print $2}')"
  got_goarch="$(go version -m "$bin" | awk -F= '$1 ~ /GOARCH$/ {print $2}')"
  if [[ "$got_goos" != "$want_goos" || "$got_goarch" != "$want_goarch" ]]; then
    echo "error: $bin is ${got_goos:-?}/${got_goarch:-?}, expected $want_goos/$want_goarch" >&2
    exit 1
  fi
}

build_darwin() {
  local goarch="$1" outdir="$2" arch_flag
  # clang selects the slice with -arch and links against the host SDK, so the
  # amd64 build needs no osxcross toolchain the way goreleaser's CI does.
  case "$goarch" in
    arm64) arch_flag=arm64 ;;
    amd64) arch_flag=x86_64 ;;
    *) echo "error: unsupported darwin arch $goarch" >&2; exit 1 ;;
  esac
  CGO_ENABLED=1 GOOS=darwin GOARCH="$goarch" \
    CC="clang -arch $arch_flag" CXX="clang++ -arch $arch_flag" \
    go build -tags=osusergo -mod=vendor -ldflags "$LDFLAGS" -o "$outdir/tilt" ./cmd/tilt
}

build_linux() {
  local goarch="$1" outdir="$2"
  # -mod=vendor keeps the container offline: everything it compiles is already
  # in the repo, so no module cache or network is needed. The output path is
  # repo-relative because the repo is the mount point.
  docker run --rm --platform "linux/$goarch" \
    -v "$ROOT:/src" -w /src \
    -v "$GO_CACHE_VOLUME:/root/.cache/go-build" \
    -e CGO_ENABLED=1 \
    "$GO_IMAGE" \
    go build -tags=osusergo -mod=vendor -ldflags "$LDFLAGS" \
      -o "${outdir#"$ROOT"/}/tilt" ./cmd/tilt
}

ARCHIVES=()
for target in "${TARGETS[@]}"; do
  platform="${target%%:*}"
  infix="${target##*:}"
  goos="${platform%%/*}"
  goarch="${platform##*/}"
  outdir="$DIST/$infix"
  mkdir -p "$outdir"

  echo "==> building tilt $VERSION ($platform)"
  case "$goos" in
    darwin) build_darwin "$goarch" "$outdir" ;;
    linux)  build_linux  "$goarch" "$outdir" ;;
    *) echo "error: unsupported goos $goos" >&2; exit 1 ;;
  esac
  assert_platform "$outdir/tilt" "$goos" "$goarch"

  # Layout matches upstream goreleaser: the `tilt` binary at the archive root.
  archive="tilt.${VERSION}.${infix}.tar.gz"
  tar -C "$outdir" -czf "$DIST/$archive" tilt
  ARCHIVES+=("$archive")
  echo "    $archive ($(du -h "$DIST/$archive" | cut -f1))"
done

# One checksums.txt covering every archive, in the sha256sum format the overlay
# parses when it records each platform's hash.
( cd "$DIST" && sha256_lines "${ARCHIVES[@]}" > checksums.txt )

# Only the host-native slice can be executed here; running it is the cheapest
# proof that the version stamping actually took.
echo
echo "==> host-native smoke test (mac.arm64)"
"$DIST/mac.arm64/tilt" version

echo
echo "release plan:"
echo "  repo:    $REPO"
echo "  tag:     $TAG (prerelease)"
echo "  base:    $BASE ($FULL_SHA)"
echo "  assets:  ${ARCHIVES[*]} checksums.txt"
echo

if [[ "$PUBLISH" != true ]]; then
  echo "dry run — nothing published. Re-run with --publish to tag + release."
  exit 0
fi

# --- publish (BOUNDARY) ----------------------------------------------------
echo "==> tagging $TAG"
git tag -a "$TAG" -m "fork release $VERSION"
git push origin "$TAG"

ASSET_PATHS=("$DIST/checksums.txt")
for archive in "${ARCHIVES[@]}"; do ASSET_PATHS+=("$DIST/$archive"); done

echo "==> creating GitHub release $TAG"
gh release create "$TAG" --repo "$REPO" --prerelease \
  --title "$VERSION" \
  --notes "Fork build of Tilt. Base: $BASE ($FULL_SHA). Platforms: x86_64-linux, x86_64-darwin, aarch64-darwin." \
  "${ASSET_PATHS[@]}"

echo "published: https://github.com/$REPO/releases/tag/$TAG"
