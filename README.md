This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Line Betting tab (`/line-betting`)

Cross-checks every **standard** PrizePicks pick against sportsbook money lines
(via [The Odds API](https://the-odds-api.com)) and Kalshi, removes the vig to get
each market's real opinion, takes the side the market leans, and deals the best
30 picks into **10 unique 3-pick Power Plays** (no player + stat ever repeats
across the slate; a player can reappear with a different stat).

Setup: copy `.env.example` to `.env.local` and set `ODDS_API_KEY`. Without it the
tab runs on Kalshi (+ the trained model as a filler) only.
Code: `src/lib/lineShop/*`, `src/app/api/line-betting/route.ts`, `src/app/line-betting/page.tsx`.
Tests: `npx tsx --test src/lib/lineShop/lineShop.test.ts`.

## Daily model retraining

Models retrain **every day** (`scripts/daily-cycle.ts`; odd days also run the
walk-forward backtest). Two schedulers, whichever runs first wins the lock:

- **GitHub Actions** — `.github/workflows/daily-train.yml`, 3:07 AM PT. Trains each
  sport in parallel and commits fresh artifacts to `main`. Run on demand from
  Actions → "Daily model retrain" → Run workflow. `git pull` to pick them up locally.
- **launchd on the Mac** — `scripts/install-cron.sh` (3:15 AM local).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
