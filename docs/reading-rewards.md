# Automatic Reading Trees

Reading Trees starts automatically whenever a PDF or EPUB is open. There is no
setup step and no Start button. Only active reading time accepted by
`ActiveReadingTracker` grows the current tree: the document must be open, the
reader screen visible, the tab visible, the window focused, and the session not
paused or idle for more than four minutes.

## Default tree ladder

The ladder is defined in
`assets/rewards/trees/catalog.json`. The first incomplete tier is selected
deterministically:

| Tier | Active reading per tree | Trees before next tier |
| --- | ---: | ---: |
| Minute Sprout | 1 minute | 1 |
| Reading Sapling | 5 minutes | 5 |
| Violet Blossom Tree | 7 minutes | 5 |
| Sunset Maple | 10 minutes | 5 |
| Moonlit Oak | 15 minutes | Repeats |

Growth is based on verified active milliseconds, so partial time is retained
across timer ticks and application restarts. At 20%, 45%, 75%, and 100%, the
tree advances through its visual stages. When a tree reaches 100%, it is
completed and placed automatically, and the next tier starts without
interrupting reading.

When a session is explicitly paused, the active-reading clock freezes
immediately. Reading interactions, TTS playback, automatic startup checks,
document changes, and application reloads cannot silently restart it.

The completion notice is queued until the reader reaches the next sentence
boundary or TTS playback finishes. The neutral notification reads:
`You earned one Reading Tree — <tree name>.`

## Changing trees and images

Edit `assets/rewards/trees/catalog.json` to change the order, reading duration,
number of completions needed to advance, display name, rarity, palette, or image
path. Tree IDs must remain unique. `requiredCompletions: null` makes a tier
repeat indefinitely, so it is normally used on the last entry.

`groundAnchor` is the vertical position of the image's ground shadow as a
fraction of its SVG height. For example, `0.92` means the shadow is 92% down the
image. Adjust this value when replacing artwork so the shadow remains aligned
with the cell's slightly lowered planting point.

Original SVG placeholders live beside the catalog:

- `assets/rewards/trees/minute-sprout.svg`
- `assets/rewards/trees/reading-sapling.svg`
- `assets/rewards/trees/violet-blossom.svg`
- `assets/rewards/trees/sunset-maple.svg`
- `assets/rewards/trees/moonlit-oak.svg`

An image can be replaced in place or a new SVG/PNG can be added to that folder
and referenced by its page-relative path, for example
`./assets/rewards/trees/my-tree.svg`. Add new offline assets to `staticFiles` in
`sw.js`. The Canvas renderer loads each configured image independently and
falls back to its built-in original vector-like drawing if an image fails.

## UI and styling

Reward UI uses the application's existing Tailwind utility classes and
`primary`, `background-light`, and `background-dark` theme tokens.
`src/css/rewards.css` contains only behavior that is awkward to express as
utilities: visually-hidden content, the dialog backdrop/centering rule, Canvas
filter reset, and radio accent color. Reward dialogs use native modal semantics
and are centered with `position: fixed`, `inset: 0`, and automatic margins.

The quiet top-right garden button shows only the current tree image and name.
There is no ticking timer, moving progress bar, percentage, or second reward
toolbar over the reader controls. The garden dialog includes the isometric
Canvas, a keyboard-accessible textual list, weekly status, occupancy, and the
append-only reward history.

Each user has exactly one Reading Garden. The garden dialog has Week, Month,
and Year views derived from each tree's local completion date. These views are
projections of the same garden rather than separate plots, and changing the
view does not mutate stored tree positions.

After a tree is planted, the next sentence boundary may show a small non-modal
note card. The note is optional, does not take focus automatically, and can be
dismissed while reading continues.

## Reward and persistence behavior

Tree growth and points are related but deliberately separate:

- Tree growth is the active-reading fraction `activeReadingMs / goalMs`.
- Time rewards remain one growth point per complete five active minutes, up to
  the configured daily cap. A partial five-minute interval is never rounded up.
- Completing an automatic tree commits the configured completion reward once.
- Engagement, weekly consistency, and recovery points continue to use the
  centralized values in `config.js`.
- Excess or capped points are never used to fake additional reading time.

The versioned reward state is stored through `RewardStorage`. It retains active
time, day/document buckets, sessions, plants, the single garden, reflections,
unlocks, weekly consistency, caps, and the append-only idempotent ledger.
Cross-device merging uses transaction/entity IDs and deterministically
relocates garden-cell conflicts.

## Event ownership

- `ReadingEventAdapter` owns normalized document and activity events.
- `ActiveReadingTracker` is the sole owner of accepted timer deltas.
- `ReadingSessionManager` owns automatic session lifecycle, progress, goal, and
  stage events.
- `RewardEngine` owns ledger grants, daily caps, plant maturation, and weekly
  rewards.
- `GardenManager` mutates garden entities; `GardenRenderer` only renders
  serializable snapshots.
- `RewardsController` composes the modules, updates UI, and delays the earned
  tree notice until a real sentence/TTS boundary.

## Manual test checklist

1. Open a PDF or EPUB and confirm a one-minute Minute Sprout appears without
   clicking Start.
2. Navigate/read normally and confirm the quiet top-right tree indicator stays
   visually static.
3. Hide the tab, blur the window, open a non-reading dialog, close the document,
   and exceed idle timeout; confirm those intervals do not count.
4. Reach one active minute and confirm the debug tree is placed automatically.
5. Finish or navigate to the next sentence and confirm one earned-tree notice.
6. Reload midway through a tree and confirm the saved session resumes without
   losing partial time.
7. After the Minute Sprout, earn five Reading Saplings and confirm the next tree requires seven active
   minutes.
8. Open the garden in light and dark modes and at narrow/mobile widths; confirm
   the modal remains centered and keyboard cell selection works.
9. Switch between Week, Month, and Year and confirm only trees completed in the
   selected local-calendar period are shown.
10. Confirm there is no plot selector or action for adding another garden.
11. Open the application in a second tab and confirm only one tab owns the
    active reading session.

## Migration and rollback

Existing flower species remain registered so older persisted gardens continue
to render. Schema version 2 consolidates any older multiple plots into the
oldest canonical Reading Garden, expands it enough to retain already placed
trees, and deterministically relocates cell conflicts. It does not remove
legacy plants, ledger entries, sessions, or reflections.

To disable automatic trees without deleting reward history, set
`REWARDS.automaticTreesEnabled` to `false` in `src/config.js`. For a code
rollback, keep the legacy plant definitions and stored schema migration in
place; removing the new asset files is safe only after removing their catalog
and service-worker references.
