# CircloO TAS

A SvelteKit TAS workspace for CircloO. The app embeds a same-origin GameMaker HTML5 runtime from Engineering.com and surrounds it with automatic script replay, telemetry, and a hidden-iframe bruteforce tool.

## Development

```sh
npm install
npm run dev -- --host 127.0.0.1
```

Open the dev server URL and use the workspace directly.

## Build

```sh
npm run check
npm run build
```

The project uses `@sveltejs/adapter-cloudflare` so GitHub pushes can deploy through Cloudflare Pages.

## Script Format

Scripts are input-change rows:

```txt
0 .
12 R
68 .
90 L
```

Valid inputs are `.`, `L`, `R`, and `LR`.
