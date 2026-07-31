# Automatic Reading Trees

Reading Trees starts automatically whenever a PDF or EPUB is open. There is no
setup step and no Start button. Only active reading time accepted by
`ActiveReadingTracker` grows the current tree: the document must be open, the
reader screen visible, the tab visible, the window focused, and the session not
paused or idle for more than four minutes. Tree growth is a continuous focus
streak: an interruption resets the current tree to zero.

## Default tree ladder

The ladder is defined in
`assets/rewards/trees/catalog.json`. The first incomplete tier is selected
deterministically:

| Tier | Active reading per tree | Trees before next tier |
| --- | ---: | ---: |
| Minute Sprout | 1 minute | 1 |
| Reading Sapling | 5 minutes | 1 |
| Aurora Pine | 6 minutes | 1 |
| Violet Blossom Tree | 7 minutes | 1 |
| Coral Canopy | 8 minutes | 1 |
| Crystal Willow | 9 minutes | 1 |
| Sunset Maple | 10 minutes | 1 |
| Ember Bonsai | 11 minutes | 1 |
| Firefly Fig | 12 minutes | 1 |
| Geometric Cypress | 13 minutes | 1 |
| Rainbow Baobab | 14 minutes | 1 |
| Moonlit Oak | 15 minutes | 1 |
| Starlight Birch | 16 minutes | 1 |
| Tea Cloud Tree | 17 minutes | 1 |
| Wind Song Tree | 18 minutes | 1 |
| Ancient Jequitibá | 19 minutes | 1 |
| Golden Ipê | 20 minutes | 1 |
| Twilight Ipê-roxo | 21 minutes | 1 |
| Araucária-do-Paraná | 22 minutes | 1 |
| Pau-brasil Red Heart | 23 minutes | 1 |
| Jabuticaba Night Orchard | 24 minutes | 1 |
| Silver Embaúba | 25 minutes | 1 |
| Mangue-vermelho Tide Tree | 26 minutes | 1 |
| Amazon Castanheira | 27 minutes | 1 |
| Buriti Sun Palm | 28, then 29, then 30 minutes | Repeats at 30 |

Growth is based on consecutive verified active milliseconds. Timer ticks retain
partial progress, but pausing, hiding or leaving the tab, losing window focus,
leaving the reader, changing or closing the document, becoming idle, or
reloading the application resets the current tree. Navigating normally inside
the same PDF or EPUB does not reset it. At 20%, 45%, 75%, and 100%, the tree
advances through its visual stages. When a tree reaches 100%, it is completed
and placed automatically, and the next tier starts without interrupting
reading.

Already accumulated reading totals and earned rewards are retained when a
focus streak resets; only the unfinished tree returns to zero.

The completion notice is queued until the reader reaches the next sentence
boundary or TTS playback finishes. The neutral notification reads:
`You earned one Reading Tree — <tree name>.`

## Changing trees and images

Edit `assets/rewards/trees/catalog.json` to change the order, reading duration,
number of completions needed to advance, display name, rarity, palette, or image
path. Tree IDs must remain unique. `requiredCompletions: null` makes a tier
repeat indefinitely, so it is normally used on the last entry.
`repeatDurationIncrementMinutes` increases that repeating tier's duration after
each completion. `maximumDurationMinutes` caps that increase.

`groundAnchor` is the vertical position of the image's ground shadow as a
fraction of its SVG height. For example, `0.92` means the shadow is 92% down the
image. Adjust this value when replacing artwork so the shadow remains aligned
with the cell's slightly lowered planting point.

Original SVG placeholders live beside the catalog:

- `assets/rewards/trees/minute-sprout.svg`
- `assets/rewards/trees/reading-sapling.svg`
- `assets/rewards/trees/aurora-pine.svg`
- `assets/rewards/trees/violet-blossom.svg`
- `assets/rewards/trees/coral-canopy.svg`
- `assets/rewards/trees/crystal-willow.svg`
- `assets/rewards/trees/sunset-maple.svg`
- `assets/rewards/trees/ember-bonsai.svg`
- `assets/rewards/trees/firefly-fig.svg`
- `assets/rewards/trees/geometric-cypress.svg`
- `assets/rewards/trees/rainbow-baobab.svg`
- `assets/rewards/trees/moonlit-oak.svg`
- `assets/rewards/trees/starlight-birch.svg`
- `assets/rewards/trees/tea-cloud-tree.svg`
- `assets/rewards/trees/wind-song-tree.svg`
- `assets/rewards/trees/jequitiba-ancient.svg`
- `assets/rewards/trees/ipe-amarelo-golden-rain.svg`
- `assets/rewards/trees/ipe-roxo-twilight.svg`
- `assets/rewards/trees/araucaria-parana.svg`
- `assets/rewards/trees/pau-brasil-red-heart.svg`
- `assets/rewards/trees/jabuticaba-night-orchard.svg`
- `assets/rewards/trees/embauba-silver-fan.svg`
- `assets/rewards/trees/mangue-vermelho-tide.svg`
- `assets/rewards/trees/castanheira-amazonia.svg`
- `assets/rewards/trees/buriti-sun-palm.svg`

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

- Tree growth is the uninterrupted active-reading fraction
  `activeReadingMs / goalMs`; interruptions reset this value to zero.
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
3. Partially grow a tree, then hide the tab, blur the window, open a non-reading
   dialog, close the document, pause, and exceed idle timeout; confirm each
   interruption resets the unfinished tree to zero.
4. Reach one active minute and confirm the debug tree is placed automatically.
5. Finish or navigate to the next sentence and confirm one earned-tree notice.
6. Reload midway through a tree and confirm its focus streak restarts at zero.
7. After the Minute Sprout, confirm each completed tree advances the goal from
   five to six, seven, and then one minute at a time until it repeats at 30.
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
