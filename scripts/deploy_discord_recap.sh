#!/bin/sh
set -eu

: "${DISCORD_APPLICATION_ID:?Set DISCORD_APPLICATION_ID to the Discord app client ID.}"
: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN to the Discord bot token.}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID to the Dirigo server ID.}"

WORKER_DIR="${DISCORD_WORKER_DIR:-dirigo-email-ingest}"
WORKER_NAME="${DISCORD_WORKER_NAME:-dirigo-email-ingest}"
COMMAND_SCOPE="${DISCORD_COMMAND_SCOPE:-guild}"
CONTRACT_FILE="${DISCORD_CONTRACT_FILE:-dirigo-email-ingest/discord-contract.json}"
LAST_COMMAND_ERROR_CODE=0

# Touch this file to trigger Discord command deployment after workflow changes.

cd "$(dirname "$0")/.."

# Discord rejects a command when a required option follows an optional one.
if jq -e '
  any(.commands[].registration;
    ((.options // []) | reduce .[] as $opt ({seen_optional: false, bad: false};
      if $opt.required == true and .seen_optional then .bad = true
      elif $opt.required != true then .seen_optional = true
      else . end
    ) | .bad)
  )
' "$CONTRACT_FILE" >/dev/null; then
  echo "Discord command options are invalid: required options must come before optional options." >&2
  exit 1
fi

cd "$WORKER_DIR"
npx wrangler deploy --name "$WORKER_NAME"

cd ..

api_get() {
  endpoint="$1"
  curl -sS -X GET "https://discord.com/api/v10${endpoint}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}"
}

api_delete() {
  endpoint="$1"
  curl -sS -X DELETE "https://discord.com/api/v10${endpoint}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" >/dev/null
}

cleanup_dirigo_commands() {
  endpoint="$1"
  list_file="$(mktemp)"
  api_get "$endpoint" > "$list_file"
  if ! jq -e 'type == "array"' "$list_file" >/dev/null; then
    rm -f "$list_file"
    return 0
  fi
  jq -r '.commands[].name' "$CONTRACT_FILE" | while IFS= read -r command_name; do
    [ -n "$command_name" ] || continue
    jq -r --arg name "$command_name" '.[] | select(.name == $name) | .id' "$list_file" | while IFS= read -r command_id; do
      [ -n "$command_id" ] || continue
      api_delete "${endpoint}/${command_id}"
    done
  done
  rm -f "$list_file"
}

put_commands() {
  endpoint="$1"
  payload_file="$(mktemp)"
  response_file="$(mktemp)"
  jq -c '[.commands[].registration]' "$CONTRACT_FILE" > "$payload_file"
  http_code="$(curl -sS -o "$response_file" -w '%{http_code}' -X PUT "https://discord.com/api/v10${endpoint}" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@${payload_file}")"
  rm -f "$payload_file"

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    jq . "$response_file"
    rm -f "$response_file"
    LAST_COMMAND_ERROR_CODE=0
    return 0
  fi

  if jq -e '.code == 50001' "$response_file" >/dev/null 2>&1; then
    LAST_COMMAND_ERROR_CODE=50001
    rm -f "$response_file"
    return 1
  fi

  jq . "$response_file"
  rm -f "$response_file"
  LAST_COMMAND_ERROR_CODE="$http_code"
  return 1
}

# Replace a scope in one request. Discord leaves the previous commands in place
# when the body is invalid, so a rejected /revise cannot delete the live one.
if [ "$COMMAND_SCOPE" = "global" ]; then
  if put_commands "/applications/${DISCORD_APPLICATION_ID}/commands"; then
    cleanup_dirigo_commands "/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"
    exit 0
  fi
  exit 1
fi

if put_commands "/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"; then
  cleanup_dirigo_commands "/applications/${DISCORD_APPLICATION_ID}/commands"
  exit 0
fi

if [ "$LAST_COMMAND_ERROR_CODE" -eq 50001 ]; then
  echo "Guild registration returned Discord Missing Access (50001). Falling back to a global command registration." >&2
  if put_commands "/applications/${DISCORD_APPLICATION_ID}/commands"; then
    exit 0
  fi
  exit 1
fi

exit 1
