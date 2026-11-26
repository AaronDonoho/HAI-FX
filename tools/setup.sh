#!/usr/bin/env bash
# Installs what tools/fx.mjs verify needs in a fresh Linux container.
# Idempotent: skips anything already present.
set -euo pipefail
GODOT_VER=4.7-stable
DEFOLD_VER=1.14.1
TOOLS=${TOOLS_DIR:-/home/user/tools}
mkdir -p "$TOOLS"

if ! [ -x /usr/lib/jvm/java-25-openjdk-amd64/bin/java ] || ! ldconfig -p | grep -q libGLU.so.1; then
  apt-get update -qq
  apt-get install -y -qq openjdk-25-jdk-headless libglu1-mesa libopenal1 xvfb ffmpeg >/dev/null
fi

if ! [ -x "$TOOLS/godot" ]; then
  curl -sSL -o "$TOOLS/godot.zip" "https://github.com/godotengine/godot/releases/download/$GODOT_VER/Godot_v${GODOT_VER}_linux.x86_64.zip"
  unzip -o -q "$TOOLS/godot.zip" -d "$TOOLS" && rm "$TOOLS/godot.zip"
  ln -sf "$TOOLS/Godot_v${GODOT_VER}_linux.x86_64" "$TOOLS/godot"
fi

if ! [ -f "$TOOLS/bob.jar" ]; then
  curl -sSL -o "$TOOLS/bob.jar" "https://github.com/defold/defold/releases/download/$DEFOLD_VER/bob.jar"
fi

(cd "$(dirname "$0")" && npm install --silent)
echo "godot: $("$TOOLS/godot" --version)  bob: $TOOLS/bob.jar  java25: ok"
