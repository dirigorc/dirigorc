#!/usr/bin/env bash

set -euo pipefail

site_root="${1:-_site}"
images_dir="${site_root%/}/assets/images"
cache_dir="${IMAGE_OPTIMIZER_CACHE_DIR:-}"

if [[ ! -d "$images_dir" ]]; then
  echo "No assets/images directory found under $site_root; skipping image optimization."
  exit 0
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick (magick) is required for image optimization." >&2
  exit 1
fi

file_size_bytes() {
  local file="$1"
  if stat -f%z "$file" >/dev/null 2>&1; then
    stat -f%z "$file"
  else
    stat -c%s "$file"
  fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

optimize_raster() {
  local file="$1"
  local ext="${file##*.}"
  ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  local original_size
  original_size="$(file_size_bytes "$file")"
  local source_hash=""
  local cached_file=""

  if [[ -n "$cache_dir" ]]; then
    source_hash="$(sha256_file "$file")"
    cached_file="${cache_dir}/${source_hash}.${ext}"
    if [[ -f "$cached_file" ]]; then
      local cached_size
      cached_size="$(file_size_bytes "$cached_file")"
      if [[ "$cached_size" -lt "$original_size" ]]; then
        cp "$cached_file" "$file"
        echo "Reused cached optimization for ${file#$site_root/}: ${original_size} -> ${cached_size} bytes"
        return 0
      fi
    fi
  fi

  local tmp_file
  tmp_file="${file}.opt"

  case "$ext" in
    jpg|jpeg)
      [[ "$original_size" -lt 1500000 ]] && return 1
      magick "$file" \
        -auto-orient \
        -strip \
        -resize '2400x2400>' \
        -sampling-factor 4:2:0 \
        -interlace Plane \
        -quality 82 \
        "$tmp_file"
      ;;
    png)
      [[ "$original_size" -lt 1200000 ]] && return 1
      magick "$file" \
        -strip \
        -resize '2400x2400>' \
        -define png:compression-level=9 \
        -define png:compression-filter=5 \
        "$tmp_file"
      ;;
    webp)
      [[ "$original_size" -lt 1200000 ]] && return 1
      magick "$file" \
        -auto-orient \
        -strip \
        -resize '2400x2400>' \
        -quality 80 \
        "$tmp_file"
      ;;
    *)
      return 1
      ;;
  esac

  local optimized_size
  optimized_size="$(file_size_bytes "$tmp_file")"

  if [[ "$optimized_size" -lt "$original_size" ]]; then
    mv "$tmp_file" "$file"
    if [[ -n "$cache_dir" && -n "$source_hash" ]]; then
      cp "$file" "${cache_dir}/${source_hash}.${ext}"
    fi
    echo "Optimized ${file#$site_root/}: ${original_size} -> ${optimized_size} bytes"
    return 0
  fi

  rm -f "$tmp_file"
  return 1
}

before_kb="$(du -sk "$images_dir" | awk '{print $1}')"
optimized_count=0
checked_count=0

if [[ -n "$cache_dir" ]]; then
  mkdir -p "$cache_dir"
  echo "Using optimizer cache at $cache_dir"
fi

if [[ "$#" -gt 1 ]]; then
  shift
  for relative_path in "$@"; do
    case "${relative_path##*.}" in
      jpg|JPG|jpeg|JPEG|png|PNG|webp|WEBP)
        ;;
      *)
        continue
        ;;
    esac

    local_file="${site_root%/}/${relative_path#./}"
    if [[ -f "$local_file" ]]; then
      checked_count=$((checked_count + 1))
      if optimize_raster "$local_file"; then
        optimized_count=$((optimized_count + 1))
      fi
    fi
  done
else
  while IFS= read -r -d '' file; do
    checked_count=$((checked_count + 1))
    if optimize_raster "$file"; then
      optimized_count=$((optimized_count + 1))
    fi
  done < <(find "$images_dir" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) -print0)
fi

after_kb="$(du -sk "$images_dir" | awk '{print $1}')"
saved_kb=$((before_kb - after_kb))

echo "Checked $checked_count image(s); optimized $optimized_count image(s); saved ${saved_kb}KB in ${images_dir#$site_root/}."