# Game Runtime

This directory vendors the self-contained CircloO HTML5 runtime downloaded from `https://games.engineering.com/circloO/index.html`.

The Svelte app embeds `index.html` in a same-origin iframe so the TAS bridge can patch GameMaker input and run hidden simulations without a browser extension.
