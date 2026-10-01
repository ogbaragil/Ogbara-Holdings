# Allocate — Investment Rebalancing Assistant

A small installable PWA that replaces the "LGH" tab of your Excel notes. Set a target
allocation, enter your current holdings, enter the cash you have available to invest,
and it recommends where that cash should go this round. It never suggests selling —
only how to deploy new money toward your most underweight positions. All data is
stored locally in your browser (localStorage) — nothing is sent to a server. Use the
Export/Import buttons (under Settings) to back up or move data between devices.

**Screens:**
- **Portfolio** — invested-holdings total (matches the donut chart below it exactly),
  a breakdown line showing available cash and the combined total separately, current
  allocation donut chart, available cash / target accuracy / holdings count, a
  holdings table with current vs. target weight, and an **Edit Holdings** action.
  A warning banner surfaces here automatically if your saved data has any validation
  issues, even if you never open the editor.
- **Holdings** (reached via Edit Holdings) — edit your current positions in a staged
  draft: every row is validated live (duplicate ticker, blank ticker, negative value)
  and **Save Changes** stays disabled until everything's clean, so a bad edit can
  never silently corrupt your data.
- **Strategy** — set your target allocation, same staged-draft pattern as Holdings.
  A target with no matching holding is flagged as informational ("no current holding
  — allowed if intentional"); the **Allow intentional new positions** checkbox controls
  whether that's treated as fine (default) or as something you must explicitly
  acknowledge before generating a plan.
- **Contribute** — enter cash to invest, minimum trade amount, max trades, and a
  rounding increment for today's contribution. **Generate Plan** is disabled until
  every validation issue (see below) is resolved.
- **Pre-flight Check** — a checklist confirming targets sum to 100%, no duplicate or
  blank tickers, no negative values, and cash is positive, plus non-blocking notices
  for holdings without a matching target or targets without a matching holding.
  Generating a plan never changes your data by itself.
- **Plan** — step 1 shows recommended buys per ticker with a progress bar (% of cash
  used) and explains any skipped positions; step 2 shows a before/after allocation
  comparison and a target-accuracy score, then three actions:
  - **Mark as Completed** — opens a confirmation screen where you can adjust the
    actual amount per ticker (in case what you bought differs from the recommendation)
    before it updates your holdings, reduces cash, and logs a **Completed** entry.
  - **Save as Planned** — logs the recommendation under Activity as **Planned**
    without touching your holdings or cash. Useful when you want to decide later.
  - **Discard** — throws the plan away, nothing is recorded.
- **Activity** — history of saved plans, tagged Planned or Completed. Planned entries
  have their own **Mark Completed** button so you can execute them later, at which
  point they update in place (edited amounts and all) rather than duplicating.
- **Settings** — currency, Export/Import/Reset, and app info.

**Validation, in full:** targets must sum to 100%; no duplicate tickers within
Targets or within Holdings; no blank ticker symbols; no negative values; cash must
be greater than zero; a holding with no matching target is flagged (informational,
non-blocking — it just won't factor into target-based buys); a target with no
matching holding is flagged as needing deliberate acknowledgment (the "Allow
intentional new positions" checkbox, on by default). Duplicates specifically matter
because internal lookups key tickers into a map — an unnoticed duplicate would
silently overwrite an earlier entry and throw off every calculation downstream, so
Holdings and Strategy are edited as drafts and can only be saved once they're clean.

**Allocation logic:** buying any amount of an underweight position (without
overshooting its target) reduces total tracking error by the same amount per dollar,
regardless of which underweight ticker absorbs it. So the accuracy-maximizing move is
simple: never leave cash idle while an underweight position could still use it.
Positions are ranked by gap size (biggest first, so the fewest trades are needed to
make progress); cash fully funds each in turn, and when it runs short of closing the
next gap, it invests whatever's left rather than skipping it, then moves to the next
(smaller-gap) candidate with whatever cash remains. Three settings shape this:
**max trades** caps how many positions can receive a buy in one round; **minimum
trade amount** skips a position rather than recommend a trade smaller than that;
**rounding** rounds each buy down to the nearest increment you choose (e.g. nearest
$10). Overweight positions never receive money and are never sold.

**Left out of this version:** a "fractional shares" / whole-share-only mode (would
need live share prices, which this app doesn't fetch) and a portfolio value change
badge (would need a historical baseline). Both are easy to add later if useful.

## Run it locally

No build step required. From this folder:

```
python3 -m http.server 8000
```

Then open http://localhost:8000 in your browser. (Opening index.html directly via
`file://` will work for the UI, but the service worker/offline caching only activates
over http/https.)

## Deploy: GitHub + Cloudflare Pages

1. Create a new GitHub repo (e.g. `rebalance-pwa`) and push this folder's contents to it:

   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/rebalance-pwa.git
   git push -u origin main
   ```

2. Go to the Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Select the `rebalance-pwa` repo.
4. Build settings: leave the build command empty and set the output directory to `/`
   (this is a static site with no build step).
5. Deploy. Cloudflare gives you a `*.pages.dev` URL immediately, and you can attach a
   custom domain from the project's settings if you want one.

Every push to `main` will auto-redeploy.

## Installing as an app

Once deployed (must be https, so `*.pages.dev` or a custom domain works — localhost
also works for testing), open the URL on your phone or desktop and use your browser's
"Install app" / "Add to Home Screen" option. It'll behave like a native app and keep
working offline after the first load.

## Data & backup

- Data auto-saves to your browser's localStorage as you type.
- Because it's local-first, data does **not** sync across devices automatically.
  Use **Export JSON** on one device and **Import JSON** on another to move it over.
- **Reset** wipes back to the example data that shipped with the app.

## File structure

```
index.html        UI markup (Portfolio/Strategy/Contribute/Activity/Settings tabs,
                  plus pushed screens: Edit Holdings, Pre-flight Check, Plan steps)
styles.css        Styling (light theme)
app.js            App logic: state, calculations, persistence, import/export
manifest.webmanifest PWA manifest (name, icons, theme)
service-worker.js Offline caching
icons/            App icons (192px, 512px)
```
