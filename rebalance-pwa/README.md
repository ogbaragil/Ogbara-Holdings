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
  allocation donut chart, available cash / target accuracy / holdings count, and a
  holdings table with current vs. target weight.
- **Targets** — edit your target allocation, current holdings, cash to invest, max
  trades, minimum trade amount, and a rounding increment. Tap **Generate Plan** to
  move to the Plan tab.
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
index.html        UI markup (Portfolio/Targets/Plan/Activity/Settings tabs)
styles.css        Styling (light theme)
app.js            App logic: state, calculations, persistence, import/export
manifest.json     PWA manifest (name, icons, theme)
service-worker.js Offline caching
icons/            App icons (192px, 512px)
```
