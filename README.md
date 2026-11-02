# stream

Rooms for watching each other's screens and games. See [PLAN.md](PLAN.md).

## Dev

```bash
npm install
cp .dev.vars.example .dev.vars   # set CREATOR_KEY
npm run dev                       # http://localhost:5173
```

Run `npm run cf-typegen` after changing `wrangler.jsonc` or `.dev.vars`.

## Deploy

```bash
npx wrangler secret put CREATOR_KEY
npm run deploy
```

The Worker is bound to `stream.hartwigdev.ca` as a custom domain.
