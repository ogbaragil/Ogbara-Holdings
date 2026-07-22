# Allocate — Investment Rebalancing Assistant

A small installable PWA that replaces the "LGH" tab of your Excel notes. Set a target
allocation, enter your current holdings, enter the cash you have available to invest,
and it recommends where that cash should go this round. It never suggests selling —
only how to deploy new money toward your most underweight positions. All data is
stored locally in your browser (localStorage) — nothing is sent to a server. Use the
Export/Import buttons (under Settings) to back up or move data between devices.

**Screens:**
- **Portfolio** — total value, current allocation donut chart, available cash / target
  accuracy / holdings count, and a holdings table with current vs. target weight.
- **Targets** — edit your target allocation, current holdings, cash to invest, and a
  max-trades limit (caps how many positions get a buy recommendation in one round).
  Tap **Generate Plan** to move to the Plan tab.
- **Plan** — step 1 shows recommended buys per ticker with a progress bar (% of cash
  used) and explains any skipped positions; step 2 shows a before/after allocation
  comparison and a target-accuracy score. **Save Plan** applies the buys to your
  holdings, reduces cash to whatever's left over, and logs the event under Activity.
- **Activity** — history of saved plans.
- **Settings** — Export/Import/Reset and app info.

**Allocation logic (greedy waterfall):** positions are ranked by how far below target
they are, in dollar terms. Cash is used to fully close the gap for the most underweight
position first, then the next, and so on. If there isn't enough cash left to *fully*
close a position's gap, or the max-trades limit is reached, that position is skipped
this round (not partially funded) and whatever's left over cash is reported as
unallocated. Overweight positions never receive money and are never sold.

**Left out of this version:** a "fractional shares" toggle (would need live share
prices, which this app doesn't fetch) and a portfolio value change badge (would need
a historical baseline). Both are easy to add later if useful.

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
