#!/usr/bin/env bash
set -uo pipefail

OUT=sdk-reference
rm -rf "$OUT"; mkdir -p "$OUT"

for pkg in @x402/core @x402/svm @x402/express @x402/fetch @solana/kit; do
  base="${pkg#@}"; base="${base//\//-}"

  find node_modules/.pnpm -maxdepth 4 -type d -path "*/node_modules/$pkg" 2>/dev/null \
  | sort | while read -r dir; do
      ver=$(node -p "require('$PWD/$dir/package.json').version")
      slug="${base}@${ver}"

      # list type files, skipping any nested node_modules INSIDE the package
      files=$(find "$dir" -type d -name node_modules -prune -o \
                   -type f \( -name '*.d.ts' -o -name '*.d.mts' \) -print | sort)

      {
        echo "### $pkg@$ver"
        echo "### from: $dir"
        echo "### type files found: $(echo "$files" | grep -c . )"
        echo
        echo "### legal import paths"
        node -p "JSON.stringify(require('$PWD/$dir/package.json').exports ?? null,null,2)"
        echo
        echo "### exported symbols"
        for f in $files; do
          grep -nE '^[[:space:]]*(export|declare)[[:space:]]+(declare[[:space:]]+)?(abstract[[:space:]]+)?(class|interface|type|function|const|enum)|^[[:space:]]*export[[:space:]]*\{' "$f" \
            | sed "s#^#${f#$dir/}:#"
        done
      } > "$OUT/${slug}.outline.txt"

      {
        echo "### $pkg@$ver  (from $dir)"
        for f in $files; do
          echo; echo "// ===== ${f#$dir/} ====="; echo
          cat "$f"
        done
      } > "$OUT/${slug}.full.txt"

      echo "$slug"
    done
done

echo
wc -l "$OUT"/*.outline.txt
