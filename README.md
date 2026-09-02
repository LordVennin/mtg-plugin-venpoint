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
  On **Windows**, double-click `host-draft.bat` for the same thing (needs
  node; curl is built into Windows 10+). Both fetch a private copy of
  cloudflared automatically if it isn't installed;
  `install-cloudflared.bat` installs it on Windows by downloading the
  official binary directly from Cloudflare's GitHub releases — no
  Microsoft Store or winget needed, so it works on debloated installs.

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

## Game modes

- **Cube draft** and **Jumpstart** — draft from a shared pool (below). Cube
  drafting comes in three flavors, picked in the host panel:
  - **Standard** — classic booster draft, then build a 40-card deck.
  - **Commander cube** — the same draft, but the deck builder gains a
    **commander slot** (★ a card to claim it, required to submit) and the
    game starts commander-style at 40 life with a command zone.
  - **Vanguard cube** — before the draft, each player is dealt X random
    cards from a **separate side pool** (the vanguard list); they land in
    your build pool alongside your picks. The builder has an *optional*
    commander slot and **any card may sit in it** — vanguard cards, legends,
    whatever the table agrees on; it starts in your command zone at 20 life.
- **Constructed** — no draft: everyone pastes their own deck in the lobby
  (each client resolves its own list from Scryfall and submits it), then the
  host starts a game with **all** players in it, 2-8.
- **Commander** — constructed with a command zone and 40 life. Mark your
  commander with a `Commander` section header or a `*CMDR*` marker; it
  starts in your command zone, casts from it (recasts log the commander
  tax), and can return there from anywhere. Full pods of 3-6 work.

All cube variants require **at least 40 cards** (spells + basics +
commander) before a deck can be submitted.

## Preset lists (`lists/` directory)

The site owner can drop `.txt` files into `lists/` and they appear in-app
as **📚 Preset lists…** dropdowns — next to the cube, vanguard-pool,
jumpstart, and deck-upload boxes — so nobody has to paste anything. Each
file is the normal paste format plus a couple of `@` metadata lines:

```
@name Ven's 360 Cube
@format cube
1 Lightning Bolt
...
```

`@format` is one of `cube`, `vanguard`, `jumpstart`, `deck`, `commander`
and decides which box offers the preset. The relay server indexes the
directory automatically (`/api/lists`); on plain static hosting list the
filenames in `lists/manifest.json` instead. See `lists/README.md`.

The repo ships **16 ready-made block cubes** (every unique card in the
block, basics excluded): Alpha/Beta/Revised, Mirage, Tempest, Urza's,
Invasion, Onslaught, Mirrodin, Kamigawa, Ravnica, Lorwyn, Shadowmoor,
Zendikar, Scars of Mirrodin, Innistrad, Return to Ravnica, and Theros.
Every line is **pinned to the block's own printing** — `1 Lightning Bolt
(LEA)` — so you draft with the era's art, not modern reprints. The same
`(SET)` suffix works in anything you paste yourself; the shown TCG price
is that printing's price.

Also included, built from MTGJSON's official product lists:

- **Jumpstart packs** — all 121 packs each from the original **Jumpstart
  (JMP)**, **Jumpstart 2022 (J22)**, and **Foundations Jumpstart (J25)**,
  offered next to the jumpstart box.
- **Ready constructed decks** — the 15 **Innistrad-block intro packs**
  (ISD/DKA/AVR) and every **Duel Deck** from Elves vs. Goblins through
  Merfolk vs. Goblins (50 decks; the Anthology reprints are skipped as
  duplicates), offered in the lobby's deck-upload box.

## Card mirror (works when Scryfall is down)

The relay server keeps a **local mirror of Scryfall's card database**: on
first start it downloads the "Oracle Cards" bulk file (~150MB, streamed —
never held in memory), slims it to just the fields the app uses (~20MB in
`data/card-mirror.json`), and refreshes it weekly. The app always asks
Scryfall first (freshest prices); if Scryfall is unreachable it falls back
to the relay's `/api/cards/collection` + `/api/cards/named` endpoints, so
card lists still resolve with full oracle text, faces, and prices during
an outage. Card *images* keep hotlinking Scryfall's separate CDN.

- `--no-mirror` disables it (the app then degrades to text-only cards when
  Scryfall is down, as before).
- `--mirror-file <path>` builds the mirror from a local bulk JSON file
  instead of downloading (air-gapped setups, tests).

Each browser also caches every card it has ever resolved in
`localStorage`, so returning players' lists resolve offline either way.

## Matches and spectating (3+ players)

After a draft with three or more players, the host gets a **match panel**:
tick any 2+ players and start the match — everyone else spectates live
(battlefields, graveyards, life, and the log; never anyone's hand — hidden
information stays on the host and is never sent to spectators). The host's
**⏹ End match** button returns everyone to the deck screen to set up the
next pairing — round-robin, winner-stays, whatever the table wants. With
exactly two players everything still flows automatically like before.

## How a draft works

1. Everyone enters a name. One player clicks **Create room** and shares the
   room code; the others **Join**.
2. The host picks a mode and pastes card lists (see formats below), clicks
   **Load & validate** — card names, images, and types are resolved from
   Scryfall automatically (unrecognized names are kept as text-only cards, so
   custom cards work too) — then **Start draft**.
3. **Cube:** everyone opens a pack (default 15 cards × 3 packs), picks one
   card at a time, packs pass left/right by round. Classic booster draft.
   Afterwards everyone gets a **deck builder**: click cards to move them
   between your pool and your main deck, add basic lands with +/− steppers
   (art included), hover to read cards, and copy the finished list. A live
   **stats bar** shows the deck's total TCG value, its mana curve (0–7+,
   lands excluded), and a type breakdown (creatures / instants / sorceries
   / enchantments / artifacts / planeswalkers / lands…), updating with
   every click. With
   exactly two players, both hit **Ready** and the 1v1 play surface opens
   with your *built* decks — lands and all.
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

- **Click any card** — yours or the opponent's — to read it full-size in the
  preview pane on the left, with its oracle text, mana cost, type line,
  power/toughness, and **TCGplayer price** (`TCG: $x.xx`, shown as `??` when
  no price is available) below the image. Your own cards also get action buttons:
  Hand: *Play* / *Discard*. Battlefield: *Tap*, *Attach to…* / *Detach*,
  *± Counter*, *⇅ Row*, *→ Graveyard*, *→ Exile*, *→ Hand*, *→ Shuffle in*.
  Graveyard and exile: *→ Hand*, *→ Battlefield*, *→ Exile*/*→ Graveyard*,
  *→ Shuffle in* — reanimation, flashback, impulse-exile all work.
- **Whose turn it is** glows green — the active player's whole board area is
  highlighted on both screens.
- **London mulligan**: each mulligan draws a fresh 7, then the board tells
  you to put N cards on the bottom (N = mulligans taken) — select a hand
  card and hit *⤓ Bottom of library* until the debt is paid. In games with
  3+ players the **first mulligan is free**, and the Mulligan button only
  exists on turn 1.
- **Right-click your own cards** for the full action menu (tap, attach,
  notes, copy, counters, zone moves…); the inline bar keeps quick actions
  for hand/graveyard/exile cards.
- **Double-click** shortcuts: hand card = play it, battlefield card = tap it
  (implemented as two rapid clicks, so it works in Firefox too).
- **Hotkeys**: `u` untap all · `d` draw · `s` search · `e` scry · `k` token ·
  `c` coin · `r` d20 · `t` tap selected · `Esc` clear selection.
- **Drag your hand** to organize it (private, silent), and drag battlefield
  cards to arrange your board. Drags also move cards **between zones**:
  hand → battlefield plays a card, battlefield → hand returns it,
  battlefield → the graveyard/exile pile sends it there, hand → graveyard
  discards, and the top card of your graveyard or exile drags straight onto
  the battlefield.
- **Annotate cards** (📝 Note in the right-click menu) — a short label shown
  in the middle of the card, visible to everyone, and shown in full under
  the big image in the preview pane. Creatures show their
  **power/toughness** in the bottom-right corner.
- **Three counter types per card** (purple ⬤ top-right, red top-left, blue
  bottom-left) plus **player counters** (☠ Counter: poison, energy,
  experience…) shown as chips by each player's name with ± on your own.
  *# Counters…* adds X at once (`5`, `-3`, or `r4`/`b2` for the red/blue
  kind), and **right-clicking the life ±** buttons prompts for a bigger
  life swing.
- **⧉ Copy…** duplicates any face-up permanent X times — copies are tokens
  and vanish when they leave the battlefield. **Manifest** in the scry
  window puts a top-of-library card onto the battlefield face down,
  namelessly.
- **🤝 Give control…** hands one of your permanents to another player — it
  moves to their battlefield (Ragavan steals, trades, "you gain control"
  effects). **✂ Unattach all** clears everything stuck to one of your
  permanents, including other players' auras.
- **👁 Reveal** shows the top X cards of your library to the whole table,
  live — as you draw, the window slides down. Reveal 0 (or *Stop
  revealing*) ends it. **🖐 Reveal hand** is a toggle that shows your whole
  hand to the table the same way (cards drawn while it's on are visible
  too); hit it again to hide. **🎲🗑 Discard random** discards a card chosen
  by the host's engine, publicly logged.
- **🏳 Resign** clears your battlefield and turns your seat into a
  spectator; the turn order skips you from then on.
- **Two battlefield rows**: lands go to the row nearest their owner, spells
  to the row nearest the middle (auto-sorted by card type; *⇅ Row* overrides).
- **Attachments**: select an equipment/aura, hit *Attach to…*, click the
  target — works across the table (Pacifism their creature). Attached cards
  render tucked behind their target and auto-detach when it leaves.
- **Library search** (Demonic Tutor, Cultivate, fetches): hit *🔍 Search* —
  only you see your library; take cards to hand (logged without naming the
  card), battlefield, or graveyard, then it shuffles.
- **Scry / look at top X** (*👁 Scry*): see the top X of your library —
  owner-only, in order. Send cards to top (reorder), bottom, hand,
  battlefield, or graveyard; the library is NOT shuffled after. Counts are
  logged; names only when a card goes somewhere public.
- **Tokens** (*➕ Token*): type a name or "3 Treasure" to create up to 10 at
  once. Tokens render with a dashed border and cease to exist when they
  leave the battlefield, like the real thing.
- **Face-down cards** (morph/manifest): *🂠 Play face down* from hand, or
  turn any permanent face down. Opponents see only a card back — the
  identity never even reaches their browser — while you see a small peek
  label. Turning it face up reveals it in the log.
- **Transform / double-faced cards** (Delver, werewolves, MDFCs): a
  *⟳ Transform* button appears on any DFC; both players see the new face,
  and the preview pane shows the current face plus the other face's text.
- Bottom bar: **Draw**, **🔍 Search**, **Untap all**, **Shuffle**,
  **Mulligan** (turn 1 only), life **±**, **🎲 d6 / d20 / dX** (any sides, or several dice at once like `3d8`), **🪙 coin flip**
  (rolled by the host's engine and publicly logged, so nobody can fudge
  them), **👁 Reveal**, **🏳 Resign**, **Pass turn** — the turn marker
  always advances in seat order from the active player, no matter who
  presses Pass.
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
