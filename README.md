# wa0rc-web

Website for the Waypoint Amateur Radio Club (WA0RC) in Olathe, Kansas.

## Overview

A simple static site providing club officer information, VE testing details,
and contact info. Deployed to [Cloudflare Pages](https://pages.cloudflare.com/)
using Wrangler.

## Structure

```text
index.html                   - Club website (single-page)
src/worker.js                - Worker: serves the site and GET /api/status (live station status)
src/worker.test.mjs          - Tests for the status logic (node --test src/worker.test.mjs)
events-upcoming.yml          - Upcoming club events data
events-past.yml              - Past club events data
events-maintenance.yml       - Club station maintenance and announcements
wrangler.jsonc               - Cloudflare Pages / Wrangler configuration
.assetsignore                - Files excluded from Cloudflare Pages deployment
.github/workflows/           - GitHub Actions CI/CD
.github/schemas/events.json  - JSON Schema for event YAML validation
.github/schemas/maintenance.json - JSON Schema for maintenance validation
.github/scripts/             - Automation scripts
```

## Updating Events

Club events are managed in two YAML files: `events-upcoming.yml` and `events-past.yml`.

### Event Format

```yaml
events:
  - name: "ARRL Field Day"
    date: "2026-06-27"              # required, YYYY-MM-DD
    end_date: "2026-06-28"          # optional, for multi-day events
    url: "https://www.arrl.org/field-day"  # optional, makes name a clickable link
    location: "Olathe Prairie Center"      # optional, shown below event name
```

### Adding or Editing Events

1. Edit `events-upcoming.yml` to add or modify upcoming events.
2. Open a pull request with your changes (see [Contributing](#contributing) below).
3. When the PR is opened, a GitHub Actions workflow automatically:
   - Validates the YAML against the schema (catches typos and formatting errors)
   - Runs the update script to inject event HTML into `index.html`
   - Commits the result back to your PR branch
   - Triggers a Cloudflare preview deployment so you can review the live result

Past events do not need to be manually moved - the workflow automatically
migrates events from `events-upcoming.yml` to `events-past.yml` once their
date has passed.

### YAML Rules

- `name` and `date` are required; all other fields are optional
- `date` must use `YYYY-MM-DD` format
- `url` must start with `http://` or `https://`
- No extra/misspelled fields are allowed - the schema validator will catch them

### Station Maintenance and Announcements

Club station maintenance is managed in `events-maintenance.yml`. Entries use
Central Standard Time (UTC-6), and date-only values mean 12:01 AM on that date.
Use exactly one of `station` or `repeater`, with `start-datetime` required;
`stop-datetime` and `description` are optional. An entry without
`stop-datetime` remains visible until it is removed. Active and future entries
are sorted by start time and rendered in a station announcements tile above
About Us. The tile is removed automatically when no entries remain active or
upcoming.

## Contributing

To submit changes (events, content fixes, etc.):

1. [Fork this repository](https://github.com/gx1400/wa0rc-web/fork) on GitHub.
2. Create a new branch on your fork for your changes.
3. Make your edits (e.g., update `events-upcoming.yml`).
4. Open a Pull Request from your branch back to `main` in this repo.
5. A Cloudflare preview deployment will be generated automatically - the URL
   will appear in the PR checks once the workflow completes.
6. A maintainer will review and merge your PR.

## Local Development

Preview the site locally with Wrangler:

```bash
npx wrangler pages dev .
```

## Deployment

Merges to `main` automatically deploy to Cloudflare Pages. A separate workflow
also updates the `lastUpdated` date in `index.html` on each merge.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for
details.

## Live Station Status

The Club Stations card shows live status for WA0RC-B, KD0JWD-5 and KD0JWD.

- The page calls `/api/status` on load and every 60 s while the tab is visible.
- `src/worker.js` answers it by reading the public Grafana dashboards behind
  [dstar.wa0rc.org](https://dstar.wa0rc.org), [igate.wa0rc.org](https://igate.wa0rc.org) and
  [dmr.wa0rc.org](https://dmr.wa0rc.org), and caches the result at the edge for 60 s.
- Each station's callsign links to its live status page.
- States: On the air, Degraded, Off the air, Maintenance, Status unknown. Missing or stale data is
  "Status unknown", never "Off the air".
- An active entry in `events-maintenance.yml` shows that station as Maintenance.
- If the request fails, the page keeps its static text.

Testing:

- `node --test src/worker.test.mjs` runs the tests. No npm needed.
- `npx wrangler@4 dev` runs the site and the API locally.
- The Station Status API workflow runs the tests on PRs, and checks the live endpoint every hour.
