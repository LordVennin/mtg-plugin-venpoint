# MTG Draft Companion

A standalone, serverless draft app for you and your friends: **cube booster
drafts** and **Jumpstart (20-card pack) drafts** over peer-to-peer WebRTC.
One person hosts and gets a 5-letter room code; everyone else joins with it.
No accounts, no backend to run — the host's browser tab *is* the server.

Built as the standalone first step of a future
[VenCord](https://github.com/LordVennin/VenCord) plugin: the draft engines,
list parser, and networking are deliberately separated from the UI so they can
be lifted into a Discord client plugin later (see "Porting to VenCord" below).

## Running it

It's a static site — no build step, no dependencies to install.

- **Easiest for a group:** enable GitHub Pages on this repo (Settings → Pages →
  deploy from branch), then everyone opens the same URL.
- **Locally:** `python3 -m http.server` (or any static server) in the repo
  folder, or just double-click `index.html`.
- **One-command hosting for remote friends:** `./host-draft.sh` (Linux;
  needs node + npm, curl) runs the relay server behind a Cloudflare quick
  tunnel and prints a single URL for you and your friends to open — no
  open firewall ports, no WebRTC. The URL changes on every run.

### Two transports

The app picks its transport from the URL:

- **Default (no params): WebRTC.** Signaling via the public PeerJS broker
  (or self-hosted, `?peerhost=...`), then direct browser-to-browser
  traffic. Zero infrastructure, but NAT traversal can fail behind VPNs
  (e.g. "Negotiation of connection failed" with NordVPN active) or
  carrier-grade NAT.
- **`?relay=1`: WebSocket relay.** All traffic flows through
  `relay-server.mjs` (which also serves the app), so it works from **any**
  network — VPNs, CGNAT, strict NATs, hotel Wi-Fi. This is what
  `host-draft.sh` uses. Run it yourself with `npm install && npm start`,
  or point at a relay on another machine with `?relayhost=some.host`.

Signaling goes through the free public PeerJS broker; after the handshake all
draft traffic is direct browser-to-browser. To use your own
[peerjs-server](https://github.com/peers/peerjs-server) instead:
`index.html?peerhost=your.server&peerport=9000` (add `&peerinsecure=1` for
plain `ws://` during local testing).

## How a draft works

1. Everyone enters a name. One player clicks **Create room** and shares the
   room code; the others **Join**.
2. The host picks a mode and pastes card lists (see formats below), clicks
   **Load & validate** — card names, images, and types are resolved from
   Scryfall automatically (unrecognized names are kept as text-only cards, so
   custom cards work too) — then **Start draft**.
3. **Cube:** everyone opens a pack (default 15 cards × 3 packs), picks one
   card at a time, packs pass left/right by round. Classic booster draft.
4. **Jumpstart:** in snake order, each player is offered up to 3 random packs
   *by name only*, keeps one, and the rest go back in the pool. Two rounds →
   two 20-card packs → a 40-card deck.
5. When it's done, every player gets their deck as a plain text list with a
   **Copy** button — paste it straight into Moxfield/Archidekt/Cockatrice.
6. **After a 1v1 jumpstart draft** the host can hit **Play it out** to open a
   built-in play surface and battle right there (see below).

## The play surface (1v1)

A Cockatrice-style honor-system board — it enforces zones and hidden
information, not the rules of the game. Decks are shuffled, both players
draw 7, and you go:

- **Click a card** to select it; buttons appear for what it can do.
  Hand: *Play* / *Discard*. Battlefield: *Tap*, *± Counter*, *→ Graveyard*,
  *→ Exile*, *→ Hand*, *→ Shuffle in*. Graveyard: *→ Hand*.
- **Double-click** shortcuts: hand card = play it, battlefield card = tap it.
- Bottom bar: **Draw**, **Untap all**, **Shuffle**, **Mulligan**, life **±**,
  and **Pass turn**.
- Your hand is yours alone; the opponent sees a count. Battlefields,
  graveyards, exile, life, and the action log are public — every action is
  logged so nothing happens silently.
- Disconnected players can rejoin with the same name mid-game, same as
  during a draft. (The host's tab is still the server.)

Your cube list, packs, and settings are saved in your browser between
sessions. If a guest disconnects mid-draft, they can rejoin with the same
name and room code to reclaim their seat.

## Import formats

**Cube list** — one card per line, Moxfield/CubeCobra/MTGO/Arena style all
work:

```
1 Lightning Bolt
4x Counterspell
Llanowar Elves
1 Fable of the Mirror-Breaker (NEO) 141 *F*
```

Counts, `x` suffixes, set/collector-number tags, foil markers, `SB:` prefixes,
comments (`//`), and section headers (`Deck`, `Sideboard`, …) are all handled.

**Jumpstart packs** — same card lines, with a header starting each pack
(`# Name`, `=== Name ===`, or `[Name]` all work):

```
# Goblins
2 Goblin Guide
1 Krenko, Mob Boss
...
7 Mountain

# Angels
1 Serra Angel
...
```

## Known limitations

- The **host's tab must stay open** for the whole draft — the host holds all
  state. If the host refreshes, the draft is lost (guests refreshing is fine).
- The public PeerJS broker occasionally has hiccups; if room creation fails,
  try again or point at a self-hosted peerjs-server.
- Strict corporate/school NAT setups can block WebRTC entirely.

## Code layout

| File | What it is |
| --- | --- |
| `js/parser.js` | Decklist / jumpstart-pack text parsing (pure, no DOM) |
| `js/draft.js` | `CubeDraft` and `JumpstartDraft` state machines (pure) |
| `js/scryfall.js` | Batch card resolution + localStorage cache |
| `js/net.js` | Transport layer: WebRTC (PeerJS) or WebSocket relay, same API |
| `relay-server.mjs` | Static file server + dumb WebSocket relay (rooms, forwarding) |
| `js/game.js` | 1v1 play-surface state machine (zones, hidden hands — pure) |
| `js/gameui.js` | Play-surface rendering + click-to-select controls |
| `js/app.js` | Screens, host/guest message protocol, rendering |
| `tests/run.js` | Unit tests for the pure modules — `node tests/run.js` |

The host is authoritative: guests only ever send `pick` messages and render
the per-player view the host sends back, so nobody can peek at other players'
packs or offers.

## Porting to VenCord / Venpoint

The plan is for this to become a plugin in
[VenCord](https://github.com/LordVennin/VenCord) (the Venpoint E2EE chat
client). The code is structured for that move:

- `parser.js`, `draft.js`, and `scryfall.js` are dependency-free and
  DOM-free — they drop into the Vite/TS web client as-is (or with a light
  TypeScript conversion).
- All networking goes through the tiny `net.js` wrapper and the small
  JSON message protocol documented at the top of `app.js`. Porting means
  swapping `net.js` for a transport that wraps the draft messages in a new
  Venpoint `MessagePayload` kind (e.g. `{v:1, kind:"draft", ...}`) and
  fans them out over the existing Signal-encrypted mailbox, instead of a
  PeerJS DataConnection. The host-authoritative model is unchanged — the
  server never sees draft state, which matches Venpoint's zero-knowledge
  design.
- The UI is plain DOM in the same style as Venpoint's client (no
  framework), so screens port mostly verbatim.
