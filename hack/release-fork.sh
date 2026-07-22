#!/usr/bin/env bash
# release-fork.sh — build and publish a linux/amd64 "-fork" release of this Tilt
# fork, in the exact tarball shape tilt-overlay's `update` script consumes.
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

PUBLISH=false
[[ "${1:-}" == "--publish" ]] && PUBLISH=true

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

# --- build -----------------------------------------------------------------
# build-js populates pkg/assets/build so the binary embeds the web UI. The
# ldflags set main.version (non-empty => TiltBuild.Dev stays false => embedded
# assets / ProdWebMode, no build.go edit needed) and stamp the commit that the
# `tilt version` output reports.
DIST="$ROOT/dist/fork-release"
rm -rf "$DIST"
mkdir -p "$DIST"

echo "==> building web assets (make build-js)"
make build-js

echo "==> building tilt $VERSION (linux/amd64)"
CGO_ENABLED=1 go build -tags=osusergo -mod=vendor \
  -ldflags "-s -w \
    -X main.version=${VERSION} \
    -X main.date=${DATE_ISO} \
    -X github.com/tilt-dev/tilt/internal/cli.commitSHA=${FULL_SHA}" \
  -o "$DIST/tilt" ./cmd/tilt

# --- archive ---------------------------------------------------------------
# Name and layout match upstream goreleaser exactly: tilt.<version>.linux.x86_64
# with the `tilt` binary at the archive root, plus a sha256sum-format
# checksums.txt — the two files tilt-overlay's `update` script downloads/parses.
ARCHIVE="tilt.${VERSION}.linux.x86_64.tar.gz"
tar -C "$DIST" -czf "$DIST/$ARCHIVE" tilt
( cd "$DIST" && sha256sum "$ARCHIVE" > checksums.txt )

echo
echo "built: $DIST/$ARCHIVE"
"$DIST/tilt" version
echo
echo "release plan:"
echo "  repo:    $REPO"
echo "  tag:     $TAG (prerelease)"
echo "  assets:  $ARCHIVE, checksums.txt"
echo

if [[ "$PUBLISH" != true ]]; then
  echo "dry run — nothing published. Re-run with --publish to tag + release."
  exit 0
fi

# --- publish (BOUNDARY) ----------------------------------------------------
echo "==> tagging $TAG"
git tag -a "$TAG" -m "fork release $VERSION"
git push origin "$TAG"

echo "==> creating GitHub release $TAG"
gh release create "$TAG" --repo "$REPO" --prerelease \
  --title "$VERSION" \
  --notes "Fork build of Tilt with the log-pipeline memory fixes. Base: $BASE ($FULL_SHA). linux/amd64 only." \
  "$DIST/$ARCHIVE" "$DIST/checksums.txt"

echo "published: https://github.com/$REPO/releases/tag/$TAG"
