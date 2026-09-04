#!/usr/bin/env bash
set -euo pipefail

# Re-encodes a video with a short keyframe interval for smoother WebCodecs
# scrubbing (see README "Production notes" for why), then rebuilds the site.
#
# Usage:
#   ./optimize.sh public/your-video.mp4 [gop] [crf]
#
# Defaults to a 6-frame GOP at CRF 23 — what this repo's demo clip uses.
# Overwrites the input file in place; run `git diff --stat` after to see the
# size change before committing.

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path/to/video.mp4> [gop=6] [crf=23]" >&2
  exit 1
fi

input="$1"
gop="${2:-6}"
crf="${3:-23}"

if [ ! -f "$input" ]; then
  echo "error: $input not found" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg is required (brew install ffmpeg)" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
tmp_file="$tmp_dir/reencoded.mp4"

echo "Re-encoding $input with a ${gop}-frame GOP at CRF ${crf}..."
ffmpeg -y -i "$input" \
  -c:v libx264 -preset medium -crf "$crf" \
  -g "$gop" -keyint_min "$gop" -sc_threshold 0 \
  -c:a copy \
  "$tmp_file"

before="$(du -h "$input" | cut -f1)"
mv "$tmp_file" "$input"
after="$(du -h "$input" | cut -f1)"

echo "Done: $input ($before -> $after)"
echo "Rebuilding site..."
pnpm build

echo "Rebuilt docs/. Review with git status/diff before committing."
