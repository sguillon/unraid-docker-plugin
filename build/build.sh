#!/usr/bin/env bash
# Build the Slackware package and update version + MD5 in the .plg.
#   build/build.sh [version]      (default: today's date, YYYY.MM.DD)
set -euo pipefail
cd "$(dirname "$0")/.."

name=docker-template-editor
version="${1:-$(date +%Y.%m.%d)}"
pkg="archive/$name-$version-noarch-1.txz"

php tests/TemplatesTest.php >/dev/null || { echo "tests failed"; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R src/usr "$stage/"
find "$stage" -name '.DS_Store' -delete
find "$stage" -type d -exec chmod 755 {} +
find "$stage" -type f -exec chmod 644 {} +

mkdir -p archive
rm -f "$pkg"
if tar --version 2>/dev/null | grep -q GNU; then
  owner=(--owner=root:0 --group=root:0)
else
  owner=(--uid 0 --gid 0 --uname root --gname root)   # bsdtar (macOS)
fi
# Package only ./usr: never include "." itself, installpkg would apply its mode to /.
COPYFILE_DISABLE=1 tar -C "$stage" "${owner[@]}" -cJf "$pkg" usr

md5=$( (md5sum "$pkg" 2>/dev/null || md5 -r "$pkg") | cut -d' ' -f1)
sed -i.bak -E \
  -e "s|(<!ENTITY version +\")[^\"]*|\1$version|" \
  -e "s|(<!ENTITY md5 +\")[^\"]*|\1$md5|" \
  "$name.plg"
rm -f "$name.plg.bak"
grep -q "^###$version\$" "$name.plg" || echo "note: add a ###$version entry to <CHANGES> in $name.plg"

echo "built $pkg"
echo "md5   $md5"
tar -tJf "$pkg"
