#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"

NATIVES_PACKAGE="$ROOT_DIR/packages/natives/package.json"
NATIVES_PACKAGE_INITIAL="$WORK_DIR/natives-package.initial.json"
cp "$NATIVES_PACKAGE" "$NATIVES_PACKAGE_INITIAL"
restore_workspace() {
   cp "$NATIVES_PACKAGE_INITIAL" "$NATIVES_PACKAGE"
   rm -rf "$WORK_DIR"
}
trap restore_workspace EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

find_tarball() {
   local pattern="$1"
   local matches=()
   shopt -s nullglob
   matches=("$pattern")
   shopt -u nullglob

   if [ "${#matches[@]}" -ne 1 ]; then
      echo "Expected exactly one tarball matching: $pattern"
      exit 1
   fi

   echo "${matches[0]}"
}

align_native_manifest() {
   local addon_version=""
   local addon
   local candidate_version
   local candidates=()
   shopt -s nullglob
   candidates=("$ROOT_DIR"/packages/natives/native/pi_natives.*.node)
   shopt -u nullglob

   if [ "${#candidates[@]}" -eq 0 ]; then
      echo "No native addon found for install smoke" >&2
      exit 1
   fi
   for addon in "${candidates[@]}"; do
      candidate_version="$(bun "$ROOT_DIR/scripts/install-tests/native-version.ts" "$addon")" || exit 1
      if [ -z "$addon_version" ]; then
         addon_version="$candidate_version"
      elif [ "$addon_version" != "$candidate_version" ]; then
         echo "Native addon version mismatch: $addon_version vs $candidate_version ($addon)" >&2
         exit 1
      fi
   done

   local declared_version
   declared_version="$(jq -r '.version' "$NATIVES_PACKAGE")"
   if [ "$declared_version" = "$addon_version" ]; then return; fi

   echo "Aligning install smoke native manifest $declared_version → $addon_version"
   jq --arg version "$addon_version" '.version = $version' "$NATIVES_PACKAGE" > "$WORK_DIR/natives-package.aligned.json"
   mv "$WORK_DIR/natives-package.aligned.json" "$NATIVES_PACKAGE"
}

section "Build Runtime package assets"
if [ "${OMP_INSTALL_TEST_SKIP_NATIVE_BUILD:-0}" != "1" ]; then
   bun --cwd=packages/natives run build
fi
align_native_manifest
bun run gen:tool-views
bun --cwd=packages/coding-agent run build

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
host_tag="$(bun -e "process.stdout.write(\`${process.platform}-${process.arch}\`)")"

bun --cwd=packages/natives run gen:npm --tag "$host_tag" >/dev/null
(
   cd "$ROOT_DIR/packages/natives/npm/$host_tag"
   bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
)

natives_pkg_backup="$WORK_DIR/natives-package.json.orig"
cp "$ROOT_DIR/packages/natives/package.json" "$natives_pkg_backup"
core_rc=0
{
   bun -e 'import { prepareNativeCorePackage } from "./scripts/ci-release-publish.ts"; await prepareNativeCorePackage("packages/natives", true);' &&
      (cd "$ROOT_DIR/packages/natives" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || core_rc=$?
cp "$natives_pkg_backup" "$ROOT_DIR/packages/natives/package.json"
[ "$core_rc" -eq 0 ] || exit "$core_rc"

for pkg in utils wire omptype hashline catalog ai mnemopi snapcompact agent stats coding-agent; do
   (
      cd "$ROOT_DIR/packages/$pkg"
      bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
   )
done

utils_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-utils-*.tgz)"
wire_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-wire-*.tgz)"
omptype_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-omptype-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-[0-9]*.tgz)"
natives_leaf_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-natives-"$host_tag"-*.tgz)"
hashline_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-hashline-*.tgz)"
catalog_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-catalog-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-ai-*.tgz)"
mnemopi_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-mnemopi-*.tgz)"
snapcompact_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-snapcompact-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-agent-core-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-omp-stats-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-pi-pi-coding-agent-*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
   cd "$TARBALL_APP_DIR"
   bun init -y >/dev/null

   jq \
      --arg utils "$utils_tgz" \
      --arg wire "$wire_tgz" \
      --arg omptype "$omptype_tgz" \
      --arg natives "$natives_tgz" \
      --arg native_leaf "$natives_leaf_tgz" \
      --arg hashline "$hashline_tgz" \
      --arg catalog "$catalog_tgz" \
      --arg ai "$ai_tgz" \
      --arg mnemopi "$mnemopi_tgz" \
      --arg snapcompact "$snapcompact_tgz" \
      --arg agent "$agent_tgz" \
      --arg stats "$stats_tgz" \
      --arg coding_agent "$coding_agent_tgz" \
      --arg host_tag "$host_tag" \
      '.overrides = {
         "@oh-my-pi/pi-utils": $utils,
         "@oh-my-pi/pi-wire": $wire,
         "@oh-my-pi/omptype": $omptype,
         "@oh-my-pi/pi-natives": $natives,
         ("@oh-my-pi/pi-natives-" + $host_tag): $native_leaf,
         "@oh-my-pi/hashline": $hashline,
         "@oh-my-pi/pi-ai": $ai,
         "@oh-my-pi/pi-catalog": $catalog,
         "@oh-my-pi/pi-mnemopi": $mnemopi,
         "@oh-my-pi/snapcompact": $snapcompact,
         "@oh-my-pi/pi-agent-core": $agent,
         "@oh-my-pi/omp-stats": $stats,
         "@oh-my-pi/pi-coding-agent": $coding_agent
      }' package.json > package.runtime.json
   mv package.runtime.json package.json

   bun add "$utils_tgz" "$wire_tgz" "$omptype_tgz" "$natives_tgz" "$hashline_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$stats_tgz" "$coding_agent_tgz"

   leaf_dir="node_modules/@oh-my-pi/pi-natives-$host_tag"
   [ -d "$leaf_dir" ] || {
      echo "Platform leaf package not installed: $leaf_dir"
      exit 1
   }

   wire_proto="$(bun -e 'import { COLLAB_PROTO } from "@oh-my-pi/pi-wire"; process.stdout.write(String(COLLAB_PROTO));')"
   [ "$wire_proto" = "3" ] || {
      echo "Unexpected @oh-my-pi/pi-wire COLLAB_PROTO: $wire_proto"
      exit 1
   }

   omptype_probe="$(bun -e '
      import { type } from "@oh-my-pi/omptype";
      import { Type } from "@oh-my-pi/omptype/typebox";
      const root = type({ name: "string", enabled: "boolean = false" }).assert({ name: "runtime" });
      const typebox = Type.Object({ name: Type.String() }).assert({ name: "tb" });
      process.stdout.write(\`${root.name}:${root.enabled}:${typebox.name}\`);
   ')"
   [ "$omptype_probe" = "runtime:false:tb" ] || {
      echo "Unexpected @oh-my-pi/omptype probe result: $omptype_probe"
      exit 1
   }

   bun -e '
      import { AgentSession, RpcClient, createAgentSession } from "@oh-my-pi/pi-coding-agent";
      import { createAgentSession as createEmbeddedSession } from "@oh-my-pi/pi-coding-agent/runtime";
      import { exportSessionToHtml } from "@oh-my-pi/pi-coding-agent/export/html";
      import { runRuntimeRpcHost } from "@oh-my-pi/pi-coding-agent/runtime-rpc-host";
      import { runRuntimeAcpHost } from "@oh-my-pi/pi-coding-agent/runtime-acp-host";
      if (
         typeof AgentSession !== "function" ||
         typeof RpcClient !== "function" ||
         typeof createAgentSession !== "function" ||
         createAgentSession !== createEmbeddedSession ||
         typeof exportSessionToHtml !== "function" ||
         typeof runRuntimeRpcHost !== "function" ||
         typeof runRuntimeAcpHost !== "function"
      ) throw new Error("Agent Runtime package surface is incomplete");
   '

   [ -f "node_modules/@oh-my-pi/pi-coding-agent/src/export/html/tool-views.generated.js" ] || {
      echo "Agent Runtime tarball is missing the embedded HTML tool renderer"
      exit 1
   }
   [ ! -e "node_modules/.bin/omp" ] || {
      echo "Agent Runtime tarball unexpectedly installed the legacy omp CLI"
      exit 1
   }
)

echo ""
echo "Agent Runtime tarball install smoke passed"
