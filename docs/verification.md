# Verification record

Carried out on 20–21 October 2026 in a Claude Code cloud session, using the environment's `GOOGLE_MAPS_BROWSER_KEY` as a development fallback for Places. No credential values were printed or committed.

## Environment and credentials

| Check | Result |
| --- | --- |
| `GOOGLE_MAPS_BROWSER_KEY` present | Yes; standard API key format. |
| `GOOGLE_PLACES_SERVER_KEY` present | **No.** The development fallback to the browser key was used. |
| Network-secret proxy injects a Places credential | **No.** A keyless call to `places.googleapis.com` returned 403. |
| Browser key website restriction | **None.** Server-side calls with no `Referer` succeed. See README step 1. |
| Outbound network | Google APIs, VEC, DataVic, the Vicmap WFS and npm are all reachable. |
| gcloud credentials | None, so the key's restrictions could not be inspected through the API Keys API. |

## Official boundary

- WFS `open-data-platform:state_assembly_2022`, feature `district = 'GREENVALE'` (one polygon, one ring, 6,707 vertices).
- Matches the VEC Greenvale District page's own KML: Hausdorff distance 1.55 m, which is a datum offset. Both measure 60.084 km² geodesic; the VEC publishes 60.08 km².
- Effective date from the EBC: 1 November 2022. The boundaries stay until the 2030 election writ unless a redivision is triggered sooner. There is no newer Legislative Assembly layer in Vicmap.

## Live Google checks (all within monthly free allowances)

| Check | Result |
| --- | --- |
| Maps JavaScript API in Chromium | Loads; no `gm_authFailure`; no console or CSP errors. |
| Boundary on the map; initial view fits the electorate | Yes (6,707-vertex outline, outside dimmed). |
| `npm run smoke:live`: supermarkets | 1 Text Search returned 20 places. The Aggregate check counted **15 inside**, matching 13 search results by ID and finding 2 inside places the search missed. The 7 not in Google's results are in Broadmeadows, Campbellfield and Coolaroo, all outside the district. Place Details returned phone, website, hours and Maps link. |
| Aggregate API with the full official polygon | Accepted without simplification. |
| Aggregate behaviour above 100 places | Returns **HTTP 429 RESOURCE_EXHAUSTED** with the count in the message. The app now treats this as "split the area", and a regression test pins it. |
| Automotive electorate check | Google counted 232; split pieces with a 30 m overlap returned all 232 IDs (check complete, 9 requests). Without the overlap, one place on a cut line was lost (231/232), and the app correctly refused to call that check complete. |
| Live UI run (`npm run verify:ui -- --live`) | **27/27 checks passed**. Highlights below. |

Highlights of the live UI run:
- Area search: 159 results, markers and list identical.
- Electorate check: 27 inside, 132 likely outside.
- Status filter applied to map and list together.
- Details panel complete; selection synced both ways; attribution present.
- Review saved, overrode the status, and clearing it restored the status.
- Automotive sweep: 523 unique results, 303 duplicate listings merged by place ID, 77 gaps.
- Gap fill: 10 places, all confirmed inside.
- Markers and list agreed (570/570) at every step.
- Mobile (390 × 844): no horizontal scroll, map above list, a single-type search worked, details opened full-screen.

Live counts per category inside the electorate (operating or temporarily closed; shown once here, not stored by the app):

| Category | Google count |
| --- | --- |
| Retail | 518 |
| Hospitality | 191 |
| Health | 113 |
| Beauty & personal care | 143 |
| Professional services | 171 |
| Automotive | 232 |
| Trades | 57 |
| Industrial & wholesale | 440 |
| Other local services | 90 |

Categories overlap, for example the generic `store` type.

## Other checks

- `npm test`: 24 passed, plus 1 Firestore test that is skipped without the emulator. These tests check:
  - dedupe, 60-cap splitting and gap detection
  - incomplete checks never produce "Likely outside"
  - a failed Aggregate call produces "Needs review"
  - reviews override statuses
  - **no business content reaches storage**
  - keys are redacted from errors and no key header is sent in proxy mode
  - limits are enforced
  - the server refuses public binding without access control
- Firestore adapter: passed against the Firestore emulator (round-trip, merge, atomic increments, daily limits).
- Production install (`npm ci --omit=dev`, `NODE_ENV=production`): refuses `0.0.0.0` without access control; Basic auth returns 401, then 200; no browser-key fallback.
- UI error states, each checked in a browser: Places not configured (banner, search disabled); daily limit reached (banner); app server stopped mid-session (connection banner).

## Not verified

- **A separate server key and a website-restricted browser key.** Neither exists yet. After README steps 1–2, run `npm run check-config` and `npm run verify:ui`.
- **`PLACES_AUTH_MODE=proxy`.** No network secret was configured. A unit test confirms that no key header is sent in this mode.
- **Firestore against a real Google Cloud project**, including `FIRESTORE_CREDENTIALS_JSON`. Only the emulator was tested.
- **The Docker image build.** No Docker daemon was available. The production install path was simulated with `npm ci --omit=dev` instead.
- **The Cloud Run deployment, IAP and a custom Map ID.**
- **Full sweeps of categories other than Automotive.** The cost table extrapolates from the Automotive measurement and Google's live counts.
