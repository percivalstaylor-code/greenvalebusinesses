#!/usr/bin/env bash
# One-command deployment of Greenvale Business Map to Google Cloud Run (Melbourne),
# intended for Google Cloud Shell. Safe to run again: it updates what already exists.
#
#   gcloud config set project YOUR_PROJECT_ID
#   bash scripts/deploy-cloud-run.sh
#
# It asks for: the browser (Maps) key, the server (Places) key, an app password and an
# optional Map ID. Keys and the password go into Secret Manager — never onto the command
# line, into shell history, or into this repository.

set -euo pipefail

SERVICE="${SERVICE:-greenvale-business-map}"
REGION="${REGION:-australia-southeast2}"
KEY_RE='^AIza[0-9A-Za-z_-]{35}$'

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."
[ -f Dockerfile ] && [ -f server/index.js ] || fail "run this from inside the greenvalebusinesses folder."

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$PROJECT" ] || fail "no project selected. Run: gcloud config set project YOUR_PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
[ -n "$PROJECT_NUMBER" ] || fail "could not read project $PROJECT."
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say "Deploying '$SERVICE' to project '$PROJECT' in $REGION."
read -r -p "Continue? [y/N] " ok
[[ "$ok" =~ ^[Yy] ]] || exit 0

secret_exists() { gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1; }

store_secret() { # name value
  if secret_exists "$1"; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --project="$PROJECT" --data-file=- >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --project="$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
  fi
  echo "  saved to Secret Manager as '$1'"
}

# ask_key <secret-name> <description>: hidden input; Enter keeps an existing secret.
ask_key() {
  local name="$1" what="$2" value=""
  while true; do
    if secret_exists "$name"; then
      read -r -s -p "Paste your $what (or just press Enter to keep the one already stored): " value; echo
      [ -z "$value" ] && { echo "  keeping existing '$name'"; return; }
    else
      read -r -s -p "Paste your $what: " value; echo
    fi
    value="$(printf '%s' "$value" | tr -d '[:space:]')"
    if [[ "$value" =~ $KEY_RE ]]; then
      store_secret "$name" "$value"
      LAST_KEY="$value"
      return
    fi
    echo "  That doesn't look like a Google API key (they start with AIza and are 39 characters). Try again."
  done
}

say "Step 1 of 5 — keys and password (input is hidden; nothing appears as you paste)"
LAST_KEY=""
ask_key maps-browser-key "BROWSER key (the Maps key that shows the map)"
BROWSER_KEY="$LAST_KEY"
LAST_KEY=""
ask_key places-server-key "SERVER key (the key restricted to Places API (New) + Places Aggregate API)"
if [ -n "$BROWSER_KEY" ] && [ "$BROWSER_KEY" = "$LAST_KEY" ]; then
  echo "  Warning: the server key is the same as the browser key. Create a separate server key (see README) for proper security."
fi
unset BROWSER_KEY LAST_KEY

while true; do
  if secret_exists app-password; then
    read -r -s -p "Choose an app password, at least 10 characters (or press Enter to keep the stored one): " P1; echo
    [ -z "$P1" ] && { echo "  keeping existing 'app-password'"; break; }
  else
    read -r -s -p "Choose an app password, at least 10 characters: " P1; echo
  fi
  read -r -s -p "Type it again: " P2; echo
  if [ "$P1" != "$P2" ]; then echo "  They didn't match. Try again."; continue; fi
  if [ "${#P1}" -lt 10 ]; then echo "  Too short. Try again."; continue; fi
  store_secret app-password "$P1"
  break
done
unset P1 P2

read -r -p "Map ID (optional — press Enter to skip for now): " MAP_ID
MAP_ID="$(printf '%s' "$MAP_ID" | tr -d '[:space:]')"
[[ -z "$MAP_ID" || "$MAP_ID" =~ ^[A-Za-z0-9_-]+$ ]] || fail "that Map ID contains unexpected characters."

say "Step 2 of 5 — switching on Google services (about a minute)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com --project="$PROJECT"

say "Step 3 of 5 — Firestore database"
if gcloud firestore databases describe --database='(default)' --project="$PROJECT" >/dev/null 2>&1; then
  echo "  already exists"
else
  gcloud firestore databases create --location="$REGION" --project="$PROJECT"
fi

say "Step 4 of 5 — permissions for the app's service account ($SA)"
for role in roles/datastore.user roles/run.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$role" \
    --condition=None --quiet >/dev/null
  echo "  granted $role"
done
for s in maps-browser-key places-server-key app-password; do
  gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT" --member="serviceAccount:$SA" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  echo "  can read secret '$s'"
done

say "Step 5 of 5 — building and deploying (3–6 minutes)"
ENV_VARS="NODE_ENV=production,STORAGE_BACKEND=firestore"
[ -n "$MAP_ID" ] && ENV_VARS="$ENV_VARS,GOOGLE_MAPS_MAP_ID=$MAP_ID"
gcloud run deploy "$SERVICE" --source . --region="$REGION" --project="$PROJECT" --quiet \
  --allow-unauthenticated --max-instances=1 --no-cpu-throttling --memory=512Mi \
  --set-env-vars="$ENV_VARS" \
  --set-secrets="GOOGLE_MAPS_BROWSER_KEY=maps-browser-key:latest,GOOGLE_PLACES_SERVER_KEY=places-server-key:latest,APP_ACCESS_PASSWORD=app-password:latest"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT" --format='value(status.url)')"
say "Done. Your app: $URL"
cat <<EOF

Last step (in the Google Cloud console → APIs & Services → Credentials → your browser key):
  add this under Application restrictions → Websites, then Save and wait ~5 minutes:
    $URL/*

Open the address above. Your browser will ask for a username and password:
  username: anything   password: the app password you chose.

To update the app later:  git pull && bash scripts/deploy-cloud-run.sh  (press Enter to keep stored secrets)
EOF
