# Preset lists

Drop `.txt` files in this directory and they show up inside the app as
one-click presets — no pasting needed. The relay server indexes this
directory automatically (`/api/lists`); if you host the app as plain static
files instead, also list the filenames in `lists/manifest.json`.

## File format

A few `@key value` metadata lines at the top, then the normal list body —
the same syntax you would paste into the matching box in the app:

```
@name Ven's 360 Cube
@format cube
1 Lightning Bolt
1 Counterspell
...
```

`@format` decides where the preset is offered:

| format      | offered as                                        | body syntax |
|-------------|---------------------------------------------------|-------------|
| `cube`      | cube list (standard / commander / vanguard draft) | one card per line |
| `vanguard`  | vanguard card pool (dealt before a vanguard draft)| one card per line |
| `jumpstart` | jumpstart packs                                   | `# Pack Name` headers + cards |
| `deck`      | ready deck (constructed lobby)                    | one card per line |
| `commander` | ready deck (commander lobby)                      | deck list + `Commander` section or `*CMDR*` marker |

`@name` is the label players see; it defaults to the filename.

## Static hosting fallback

`lists/manifest.json` is just an array of filenames:

```json
["example-cube.txt", "example-jumpstart.txt"]
```

The app tries `/api/lists` first (relay server) and falls back to the
manifest, so keeping the manifest in sync only matters when you are NOT
using `relay-server.mjs` / `host-draft.sh`.
