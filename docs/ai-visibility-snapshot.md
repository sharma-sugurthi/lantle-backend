# AI visibility snapshot (runbook)

The deliverable bundled with a featured listing: a one-page report that shows whether ChatGPT, Perplexity, Gemini and
Google AI Overviews name the vendor for the questions its buyers actually ask, before listing and again 60 days later.
It is a measurement, not a promise. Never sell it as "guaranteed ChatGPT ranking".

## Method

1. Pick 20 buyer prompts for the tool's category from `scripts/visibility-prompts.json` (edit them to the tool's real use
   case; keep them phrased the way a buyer types, not the way a marketer does).
2. Run each prompt 5 times on each engine on the same day, logged out or in a fresh session, and record for every run:
   engine, prompt, run number, whether the vendor is named, its position in the list if any, and every source URL cited.
3. Store the raw runs in a CSV with the columns in `scripts/visibility-report-template.csv`. Keep the raw file; the report
   is derived from it and the client may ask to see it.
4. Report: share of runs where the vendor is named (per engine), average position when named, the top ten cited domains
   across all runs (this is the list of pages that influence the answers and is the actionable part), and the
   competitors named more often than the vendor.
5. Repeat at day 60 with the identical prompt set and report the deltas. Cite the Lantle pages that were cited, if any.

## Automation options

- Ahrefs Brand Radar (available in this workspace's Ahrefs plan) reports AI mentions and cited pages per brand and can
  replace step 2 for the engines it covers. Use the `brand-radar-mentions-overview` and `brand-radar-cited-pages`
  endpoints with the vendor as the entity and keep the manual run for anything it does not cover.
- Do not scrape the engines in violation of their terms. Manual runs or official APIs only.

## What the report must never claim

- A ranking position in an AI answer that was not observed in the logged runs.
- Causation from a single data point. Say "after listing" and "at day 60", not "because of the listing".
- Anything about llms.txt. A 137,000-domain server-log study found 97 percent of llms.txt files are never requested.
