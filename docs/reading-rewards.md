# Automatic Reading Trees

Reading Trees starts automatically whenever a PDF or EPUB is open. There is no
setup step and no Start button. Only active reading time accepted by
`ActiveReadingTracker` grows the current tree: TTS playback must be active, the
document and reader screen must be open, and the tab and window must be visible
and focused. Loading, speech generation, stopped playback, and intentional
pauses never advance the clock.

## Default tree ladder

The ladder is defined in
`assets/rewards/trees/catalog.json`. The first incomplete tier is selected
deterministically:

The first tree requires 5:00 of active reading. Every completed automatic tree
adds exactly one second to the next tree's goal: 5:01, 5:02, 5:03, and so on.
The increase stops at 10:00, and all later trees keep that ten-minute goal.

Growth is based on accumulated verified playback milliseconds. An intentional
pause freezes the current tree, including while the reader switches away to
search or take notes. Loading and other non-reading time also freeze it. Losing
tab or window focus while playback is still active resets the current tree's
clock to zero. At 20%, 45%, 75%, and 100%, the tree advances through
its visual stages. When a tree reaches 100%, it is completed and placed
automatically, and the next tier starts without interrupting reading.

Every completed tree requires the reader to write a paragraph about what they
read during that tree's timed block. Phrase/TTS playback and the next tree's
active-reading clock pause while the modal prompt is open. The prompt cannot be
skipped or dismissed; saving a valid paragraph closes it and resumes reading
from the current phrase. The paragraph is shown as that tree's reading note in
the garden.

The completion notice is queued until the reader reaches the next sentence
boundary or TTS playback finishes. The neutral notification reads:
`You earned one Reading Tree — <tree name>.`

## Changing trees and images

Edit `assets/rewards/trees/catalog.json` to change the order, reading duration,
number of completions needed to advance, display name, rarity, palette, or image
path. Tree IDs must remain unique. `requiredCompletions: null` makes a tier
repeat indefinitely, so it is normally used on the last entry. The initial,
increment, and maximum durations are configured centrally in `src/config.js`.

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

The quiet top-right garden button shows the current tree inside a one-pixel
rounded progress outline. The outline fills with the active-reading fraction of
the current tree goal, while the exact elapsed and target times remain available
to assistive technology. The garden dialog includes the isometric
Canvas, a keyboard-accessible textual list, weekly status, occupancy, and the
append-only reward history.

Each user has exactly one Reading Garden. The garden dialog has Week, Month,
and Year views derived from each tree's local completion date. These views are
projections of the same garden rather than separate plots, and changing the
view does not mutate stored tree positions. Trees have separate pointer targets,
using their visible pixels rather than their transparent image rectangles, and
selecting one shows the reading note saved when that tree was completed. The
isometric garden is rendered as a raised grass-and-soil plot. It starts at 25
blocks (5 by 5) and automatically adds rows as needed; period views likewise
include enough blocks to show every Week, Month, or Year tree. Within each view,
trees are scattered deterministically from their saved reading note and tree ID;
the layout remains stable and duplicate notes cannot cause cell conflicts.

After a tree is planted, its required paragraph is available by selecting the
tree in the garden. Selecting a tree also exposes a **Remove tree** action. The
action asks for confirmation and removes the tree from synchronized garden
views without deleting its reading time, earned points, session, or saved note.
Trees completed before the current application run are never replayed as a
backlog of mandatory paragraph dialogs when a document is opened.

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

1. Open a PDF or EPUB and confirm a 5:00 Minute Sprout appears without
   clicking Start.
2. Navigate/read normally and confirm the quiet top-right outline advances with
   the current tree's active reading.
3. Partially grow a tree, then hide the tab, blur the window, open a non-reading
   dialog, close the document, pause, and exceed idle timeout; confirm each
   interruption retains the unfinished tree's progress while counting stops.
4. Reach 5:00 of active reading and confirm the first tree is placed automatically.
5. Finish or navigate to the next sentence and confirm one earned-tree notice.
6. Reload midway through a tree and confirm its partial progress is retained.
7. Confirm each new tree requires exactly one second more than the previous tree,
   up to the 10:00 cap. Confirm playback pauses at the required paragraph prompt
   and resumes only after the paragraph is saved.
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
