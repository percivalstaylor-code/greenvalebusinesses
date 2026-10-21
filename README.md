# Greenvale Business Map

An interactive Google map of businesses in **Greenvale District**, the Victorian Legislative Assembly electorate. It is not the Greenvale suburb, postcode 3059, the City of Hume or any federal division. Businesses are found live through Google Maps Platform. A searchable sidebar stays in sync with the map, and a review workflow handles locations whose electorate membership is uncertain.

It is a private research tool, **not a business register**. It shows what Google lists, says which listings Google places inside the electorate, and never stores business details.

- [Quick start](#quick-start)
- [Google Cloud setup (actions for you)](#google-cloud-setup-actions-for-you)
- [How it works](#how-it-works)
- [Google terms: what shaped the design](#google-terms-what-shaped-the-design)
- [Costs](#costs)
- [Coverage limitations](#coverage-limitations)
- [Deployment recommendation](#deployment-recommendation)
- [Development](#development)
- [Verification record](docs/verification.md)

---

## Quick start

Requirements: Node.js 20.12 or later (22 LTS recommended).

```bash
npm install
cp .env.example .env        # then fill in keys, or set them as environment variables
npm run check-config        # shows which credentials are set (never their values) and probes the APIs for free
npm start                   # http://127.0.0.1:8080
```

The server listens on `127.0.0.1` only, unless you set an access password or put it behind Identity-Aware Proxy.

| Command | What it does |
| --- | --- |
| `npm start` / `npm run dev` | Run the app (`dev` restarts on file changes). |
| `npm test` | Unit and integration tests. Uses synthetic data and makes no Google calls. |
| `npm run check-config` | Credential and API diagnostics. Add `-- --aggregate` to also probe the Aggregate API (1 billable request). |
| `npm run smoke:live` | Small live check of the Google integration (about 3 requests). |
| `npm run verify:ui` | Browser checks of map, boundary and layout. Add `-- --live` for searches (about 30–110 requests). |
| `npm run fetch-boundary` | Re-download the official boundary from Vicmap and record its provenance. |

---

## Google Cloud setup (actions for you)

Checked in this environment on 20 October 2026, without printing any key:

| Item | Status |
| --- | --- |
| `GOOGLE_MAPS_BROWSER_KEY` | Present, standard key format. |
| Maps JavaScript API | Works with this key; the map loads in a browser. |
| Places API (New) | Enabled; live requests succeed. |
| Places Aggregate API | Enabled; live requests succeed. |
| Key restrictions | **None on the browser key.** It accepts server-side calls with no `Referer`, so it is not website-restricted. Anyone who copies it from the page could use it for any enabled API on your bill. |
| Server key for Places | **Not present.** In development the app falls back to the browser key for Places calls. This is disabled in production. |
| Network-secret proxy | No Places credential is injected for `places.googleapis.com`. A keyless call returned 403. |

Do these steps in the Google Cloud console for the project that owns the key. **Do steps 1 and 2 together**: once the browser key is website-restricted, the development fallback stops working.

1. **Restrict the browser key.** Go to *APIs & Services → Credentials → (browser key)*.
   - Application restrictions → **Websites**: `http://localhost:8080/*`, `http://127.0.0.1:8080/*`, plus your deployed URL, e.g. `https://greenvale-business-map-xxxx.a.run.app/*`.
   - API restrictions → **Restrict key** → **Maps JavaScript API** only. The browser never calls Places directly.
2. **Create a server key for Places.** Go to *Credentials → Create credentials → API key*.
   - API restrictions → **Places API (New)** and **Places Aggregate API**.
   - Application restrictions → none. Cloud Run has no fixed egress IP unless you add Cloud NAT; if you do, use IP addresses.
   - In Claude Code on the web, add it to this cloud environment's settings as the environment variable **`GOOGLE_PLACES_SERVER_KEY`**. It takes effect in a new session. Never paste keys into chat or commit them.
   - *Alternative for development only:* if you add the key as a **network secret** that injects `X-Goog-Api-Key` for `places.googleapis.com` and `areainsights.googleapis.com`, set `PLACES_AUTH_MODE=proxy` and the server will send no key itself. A deployed app cannot rely on this; it needs `GOOGLE_PLACES_SERVER_KEY` from Secret Manager.
3. **Create a Map ID.** Go to *Google Maps Platform → Map management → Create map ID* (JavaScript, Vector) and set it as `GOOGLE_MAPS_MAP_ID`. Optionally attach a map style that hides Google's business POI icons so they don't compete with this app's markers. Until you do this, the app uses `DEMO_MAP_ID`, which is development-only.
4. **Cap spend.** Under *Google Maps Platform → Quotas*, set requests-per-day caps on Places API (New) and Places Aggregate API slightly above this app's own limits (see [Costs](#costs)). Then add a budget alert under *Billing → Budgets & alerts*.
5. **For data that survives sessions and deployments,** create a **Firestore (Native mode)** database, location `australia-southeast2` (Melbourne). See [Deployment](#deployment-recommendation). In Claude Code cloud sessions, which have no Google Application Default Credentials, provide a service-account key with only the *Cloud Datastore User* role as `FIRESTORE_CREDENTIALS_JSON`, and set `STORAGE_BACKEND=firestore`.

Required APIs, all on the same billing-enabled project: **Maps JavaScript API** (browser key), **Places API (New)** and **Places Aggregate API** (server key). The legacy Places API is not used.

---

## How it works

### Map area: the official boundary

| | |
| --- | --- |
| Boundary | Greenvale District (`district_code` 35), Northern Metropolitan Region |
| Source | [Vicmap Admin – State Assembly Polygon 2022](https://discover.data.vic.gov.au/dataset/vicmap-admin-state-assembly-polygon-2022), published by the Victorian Electoral Commission on DataVic (WFS layer `open-data-platform:state_assembly_2022`) |
| Effective | **1 November 2022**. The 2020–21 redivision "came into effect on 1 November 2022 and will remain in place until the writ for the 2030 State election is issued, unless triggered sooner" ([EBC](https://www.ebc.vic.gov.au/Past-Redivisions/Default.html)). Vicmap record created 19 November 2021. |
| Checks | 6,707 vertices; geodesic area 60.084 km², against the VEC's published 60.08 km². Matches the VEC district page's own KML to within 1.55 m (a GDA94/GDA2020 datum offset). |
| Licence | © State of Victoria (Victorian Electoral Commission), CC BY 4.0 |
| Files | `data/boundary/greenvale-district.geojson`, plus `.meta.json` holding the full provenance |

The map fits its initial view to this boundary, draws it in purple and dims everything outside it.

### Discovering businesses

Nothing is preloaded. Every search runs only when a user clicks.

- **Search map area:** one Text Search (New) request per Google place type in the chosen category, for example 8 types for Automotive and 28 for Retail. Each is restricted to the visible rectangle, clipped to the electorate's surroundings, and returns the first page of up to 20 results. Choosing a single type uses one request, and "Load more" fetches the next page.
- **Search Google here:** a free-text search, such as "mechanic", within the visible area.
- **Sweep whole electorate:** every type in the category, plus keyword searches for trades and industrial businesses that have no Google type. The sweep searches across the electorate's bounding rectangle and follows pagination. Text Search returns at most **60 results per query**, so any query that hits the cap is re-run over four sub-rectangles, up to two levels deep. Results are **merged by place ID**; the live test merged 303 duplicate listings in one sweep.

Categories and Google types: Retail (28), Hospitality (16), Health (13), Beauty & personal care (11), Professional services (12), Automotive (8), Trades (6 + 6 keyword searches, including service-area businesses), Industrial & wholesale (8 + 5 keyword searches), Other local services (8). See `server/categories.js`.

### Deciding what is inside the electorate

Text Search accepts only rectangles (or circles), and Google's terms forbid using Places coordinates for point-in-polygon analysis. So this app never tests Google coordinates against the boundary itself. Instead:

1. **Google's own electorate check.** The [Places Aggregate API](https://developers.google.com/maps/documentation/places-aggregate/overview) accepts a custom polygon. The app sends the official boundary and the category's types, and Google returns the IDs of matching places inside it. It returns IDs only when 100 or fewer match, so larger categories are split into overlapping pieces of the official polygon until every piece has 100 or fewer. Places on a cut line are kept, and results are de-duplicated by ID. The check counts as **complete** only when Google returned as many IDs as it counted.
2. **Matching by place ID only.** Each search result gets one status:

| Status | Meaning |
| --- | --- |
| **Inside** (green) | Google returned this place ID for the electorate polygon. |
| **Likely outside** (grey) | Google listed every place of the category inside the polygon (a complete check) and this one wasn't among them. |
| **Needs review** (orange) | No complete check covers it yet: no check run, a check incomplete or failed, or found only by keyword. |
| **Reviewed: inside / outside / unsure** | A person compared the marker with the boundary and recorded a decision. This overrides the automatic status. |
| **Service-area business** | No public premises according to Google. Listed in its own tab with no marker or electorate status. |

3. **Gaps.** Google may list places inside the electorate that Text Search never returned; in the live test this was 77 of 232 automotive places. The app reports how many and loads them on request, up to 100 per click with a cost confirmation, using Place Details (Pro).
4. **Review queue.** The Review tab lists unverified places from this session, plus stored place IDs from earlier sessions. Names aren't stored, so opening one loads it live from Google.

Google's verdicts are tied to the boundary version (a hash of the geometry) and re-checked after 30 days (`MEMBERSHIP_MAX_AGE_DAYS`).

### Interface

The interface includes:
- Google Map with the boundary, status-coloured markers, clustering and a legend.
- A sidebar list kept in sync with the map: hovering highlights, and clicking selects in both directions.
- Category and type selectors.
- An instant text filter, status chips, category filter, a "latest search vs all searches" scope, and an optional "only what's visible" filter. None of these make Google requests.
- A details panel with name, category, address, phone, website, opening hours and Google Maps link. Fields Google doesn't have show "Not listed on Google"; nothing is invented.
- Loading, empty, not-configured, daily-limit, Google-quota, Google-error and connection-lost states.
- A Coverage tab that keeps three measures apart:
  - **this session's results** (live, in browser memory)
  - **accumulated coverage** (stored place-ID counts)
  - **Google's live counts** from this session (displayed, never stored)
- "Google Maps" text attribution with every block of Places content, third-party attributions when Google supplies them, and Google's ranking explainer.
- A terms and privacy page (`/legal`) for you to complete.

### What is stored

| Stored (Firestore or JSON file) | Never stored |
| --- | --- |
| Google **place IDs**, which Google exempts from caching limits | Names, addresses, phone numbers, websites, opening hours |
| Google's inside/outside verdict per place ID, with date and boundary version | Coordinates (would be allowed for 30 days, but not needed) |
| Which of this app's categories found each place ID | Places Aggregate counts (Service Terms §13.2) |
| Human review decisions, notes and initials | Anything in browser storage |
| Request counters and sweep history (counts only) | |

API responses are sent with `Cache-Control: no-store`. **Export reviews** writes only place IDs and your decisions and notes.

---

## Google terms: what shaped the design

Checked against the Maps Platform Terms of Service (last modified 26 Aug 2026), the Service Specific Terms (15 Oct 2026) and the Places API policies (updated 20 Oct 2026).

| Request | Constraint | What was built |
| --- | --- | --- |
| Show only businesses inside the electorate | ToS §3.2.3(c)(iv) forbids using "latitude/longitude values from the Places API as an input for point-in-polygon analysis". | Google's own polygon check via Places Aggregate `customArea`, matched by place ID, plus human review. The rectangle or circle search area is never presented as the electorate. |
| A saved directory or exported business list | ToS §3.2.3(a)–(b): no pre-fetching, storing or copying of business names and addresses; caching only as the Service Terms allow. Place IDs are exempt; Places coordinates may be cached for 30 days. | Only place IDs, Google's verdicts and your reviews persist. Business details are fetched live each time. Export covers IDs and reviews only. |
| Broad discovery | Bulk downloading of places information is prohibited (§3.2.3(a)(ii)). | User-initiated searches only, with per-sweep and daily limits and no background crawling. |
| A public listing of businesses | §3.2.3(d)(iii): the Core Services must not be used "in a listings or directory service". | Built as a **private** analysis tool whose own value lies in the official boundary, membership checks, review workflow and coverage tracking. **Don't publish it as a public business directory.** If you plan anything public-facing, take legal advice first. |
| Coverage figures | Service Terms §13.2: Aggregate POI counts may be cached for 30 days, solely to calculate derived values. | Counts are shown live and never stored. |
| Attribution, terms and privacy | Places policies require Google Maps attribution, third-party attributions, and published terms of use and privacy policy. | All implemented. The `/legal` template needs your organisation's details. |

Google Maps remains the only provider. No third-party data or providers are used.

---

## Costs

Global list prices in USD, checked 20 Oct 2026. Each SKU has its own **monthly free allowance per billing account**, and your invoice may be in AUD.

| Action in the app | Google SKU | Free per month | Price after free allowance |
| --- | --- | --- | --- |
| Page load | Dynamic Maps | 10,000 | $7 / 1,000 |
| Search map area (one per type) or one page of a sweep | Text Search **Pro** (field mask excludes phone, website and hours) | 5,000 | $32 / 1,000 |
| Open a business (phone, website, hours) | Place Details **Enterprise** | 1,000 | $20 / 1,000 |
| Load a gap place | Place Details **Pro** | 5,000 | $17 / 1,000 |
| Electorate check (per polygon piece) | Places Aggregate | 5,000 | $10 / 1,000 |
| Free probes in `check-config` | Text Search Essentials (IDs only) | Unlimited | $0 |

**Measured** for one Automotive sweep, live on 20 Oct: 52 Text Search and 9 Aggregate requests found 232 places inside the electorate per Google, and 77 more could be loaded with Place Details Pro.

**Estimated full pass** of all 9 categories, using Google's live counts of about 1,955 category matches inside the electorate (overlapping):

| | Requests | If entirely beyond free allowances |
| --- | --- | --- |
| Text Search Pro | about 400–550 | about $13–18 |
| Places Aggregate | about 80–120 | about $1 |
| Gap fill, Place Details Pro | about 400–650 | about $7–11 |
| **Total** | | **about $21–30** |

That falls well inside the monthly free allowances, so it costs **about $0 if nothing else on the billing account uses these SKUs**. With the default daily limits a full pass spans two to three days; raise `DAILY_TEXT_SEARCH_LIMIT` (and `SWEEP_MAX_TEXT_SEARCH` to about 200 for Retail) if you want it in one sitting.

**Ongoing use.** A small team that loads the map 1,000 times a month, opens 300 businesses and re-runs a full pass monthly stays within the free allowances. **Worst case at the default daily limits:** if every limit were exhausted every day, about $130 Text Search + $70 opened details + $170 gap fill (Aggregate stays free) ≈ **$370 a month**. That is why step 4 of the setup recommends Google-side quota caps and a budget alert.

Hosting is not included. Cloud Run scaled to zero and Firestore at this volume (a few thousand small documents) usually cost a few dollars a month or less; check the [Google Cloud pricing calculator](https://cloud.google.com/products/calculator) for your settings. The Coverage tab reads the whole `places` collection on each view, which is cheap at this size.

---

## Coverage limitations

- **Not a complete register.** The app only includes businesses with a Google listing under one of the searched types, or matching a keyword search. Home-based, unlisted and unusually-typed businesses are missing. Google's ranking (relevance, distance, prominence) decides which results Text Search returns.
- The **electorate check** covers places Google marks as operating or temporarily closed. Permanently closed listings are excluded from the check and hidden by default.
- **Keyword-only results** (e.g. "builder", "factory") may have no Google type in the category. They stay "Needs review" unless they appear in another category's check.
- **Service-area businesses** without premises can't be placed in or out of the electorate.
- Text Search caps each query at 60 results. Splitting the area recovers most of the shortfall, and dense types can still hit the cap after two levels; the sweep notes this when it happens. The Aggregate gap list is the safety net.
- Google's verdicts come from Google's place locations. A business whose entrance and listed location differ may need human review.
- Coverage figures count unique place IDs found by this app. They are not an official business count.

---

## Deployment recommendation

**Google Cloud Run (australia-southeast2) + Firestore + Identity-Aware Proxy**, private by default:

**Easiest:** in [Google Cloud Shell](https://shell.cloud.google.com), run:

```bash
gcloud config set project YOUR_PROJECT_ID
git clone -b claude/greenvale-business-map-hfym7p https://github.com/percivalstaylor-code/greenvalebusinesses.git   # or: cd greenvalebusinesses && git pull
cd greenvalebusinesses && bash scripts/deploy-cloud-run.sh
```

The script asks one question at a time: browser key, server key, app password and an optional Map ID. Keys and the password go into Secret Manager, never the command line. It then:
- enables the APIs
- creates Firestore in Melbourne
- grants the service account its permissions
- deploys with password protection
- prints the URL to add to the browser key's website restrictions

Re-run it to update the app, pressing Enter to keep stored secrets.

The manual equivalent, using IAP (Google sign-in) instead of a password, is below.

```bash
PROJECT=your-project; REGION=australia-southeast2
gcloud firestore databases create --location=$REGION --project=$PROJECT
printf '%s' "$GOOGLE_PLACES_SERVER_KEY" | gcloud secrets create places-server-key --data-file=- --project=$PROJECT
gcloud run deploy greenvale-business-map --source . --region=$REGION --project=$PROJECT \
  --max-instances=1 --no-cpu-throttling --memory=512Mi \
  --set-env-vars=NODE_ENV=production,STORAGE_BACKEND=firestore,TRUST_UPSTREAM_AUTH=true,GOOGLE_MAPS_MAP_ID=YOUR_MAP_ID,GOOGLE_MAPS_BROWSER_KEY=YOUR_RESTRICTED_BROWSER_KEY \
  --set-secrets=GOOGLE_PLACES_SERVER_KEY=places-server-key:latest \
  --no-allow-unauthenticated --iap
# --iap enables Identity-Aware Proxy directly on Cloud Run. Not tested here: if your gcloud version rejects the
# flag, enable IAP for the service in the console instead. Then grant users "IAP-secured Web App User", and give
# the Cloud Run service account "Cloud Datastore User" and "Secret Manager Secret Accessor".
```

- `--max-instances=1`: sweep progress and the daily-limit counters' in-process lock live in one instance.
- `--no-cpu-throttling`: sweeps keep running between the browser's progress polls.
- Without IAP, set `APP_ACCESS_PASSWORD` (sent as HTTP Basic auth) instead of `TRUST_UPSTREAM_AUTH`, and allow unauthenticated invocations.
- Add the Cloud Run URL to the browser key's website restrictions.
- `Dockerfile` is included for other container hosts.
- The production server refuses to start on a public interface without access control, and never falls back to the browser key for Places.

---

## Development

```
server/
  index.js        start-up, configuration validation
  app.js          HTTP API, security headers, Basic auth, coverage, reviews
  discovery.js    area searches, sweeps, Aggregate electorate check, classification, gap fill
  places.js       Places API (New) + Places Aggregate client, field masks, error mapping
  categories.js   categories → Google place types
  budget.js       daily limits, usage counters, cost estimates
  geo.js          geometry on the official boundary only (splitting, rectangles)
  storage/        memory, file (JSON) and Firestore adapters
public/           static front end (no build step): index.html, css/, js/, legal.html
data/boundary/    official boundary + provenance
scripts/          fetch-boundary, check-config, smoke-live, verify-ui
test/             node:test suites (synthetic data; Firestore test runs against the emulator)
```

To run the Firestore adapter test:

```bash
npx firebase-tools emulators:exec --only firestore --project demo-gbm "npm test"
```

The emulator needs Java. If port 8080 is busy, set the emulator port in a `firebase.json`.
