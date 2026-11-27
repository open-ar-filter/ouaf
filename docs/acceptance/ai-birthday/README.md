# AI acceptance test: `ai-birthday` (#38)

Can an AI agent write a filter from [`AUTHORING.md`](../../../AUTHORING.md) alone? This folder keeps one run of the
test: the request, the rules, the [`filter.ts`](filter.ts) the agent wrote, and what it reported. The demo
[`filters/ai-birthday/`](../../../filters/ai-birthday/) is the package `ouaf pack` builds from this `filter.ts`
(`packages/cli/test/demo-filters.test.ts` checks that they match).

## The run

- **Date and agent**: 2026-11-26, Claude Opus 5.5 (Claude Code), a fresh sub-agent without the context of the
  session that set up the test.
- **Request**, as a user would phrase it: "Make me a birthday filter. Put a party hat on my head, and 'Happy
  birthday, \<name\>!' above it, where I can change the name. When I open my mouth wide, like blowing out candles,
  confetti rains down over the whole screen for a couple of seconds. It should work with two people in the picture
  too: each one gets their own hat." Filter id `ai-birthday`.
- **Rules**: read only `AUTHORING.md` and what it links to (`llms.txt`, the spec, the JSON Schema); not the engine,
  the tests or the other filters. Write only `filters/ai-birthday/`, create every asset (no download, no photo of a
  person). Follow section 17: validate (or pack) until there are no errors or warnings, preview and look at the
  screenshots, then report, with a log of every place where the guide was not enough.

## Result

- **Passed.** One `filter.ts` (166 lines, no asset file): a hat made from model shapes (cone, three tori, a
  sphere) with head occlusion on every face, the greeting in `builtin:font/rounded-bold` set by the script from a
  `string` parameter, and confetti drawn on a full-screen canvas for 2.6 s on `mouthOpen` (threshold 0.5).
- **Validation**: about six `ouaf pack` runs, each one valid without warnings; no validator hint was needed.
- **Preview**: four runs on the default set, each leading to a visual fix (greeting cut at the top, underside of
  the cone visible from below, pom-pom over the text); then exit 0 with `--strict` on the default and the full set
  (26 references, `faces` equal to `expectedFaces` everywhere). Two faces get two hats.
- **Events**: no test clip opens the mouth beyond `jawOpen` ≈ 0.35, so the agent checked the confetti on copies of
  the filter with the threshold lowered to 0.25 (they rain over the whole width, fade out, restart on a new event).
  The shipped threshold of 0.5 has not fired in a test.

## Friction log, and what was done

| Where the guide was not enough | Done |
|---|---|
| `llms.txt` and §15 point to the demo filters and the script types, which the test forbids; the runtime types of `f.params` and `paramChange` values were unknown | §7: the value types in a script |
| A text made of a parameter and fixed words needs a script; does `paramChange` fire at load, is `f.params` set in `setup`, does a `set()` without face reach later faces? | §7 and §10: no, yes, yes |
| Text: does `\n` break a line, how a long word wraps, where a block grows | §5 `text` |
| A full-screen canvas: how `size` and the width work on screen, clipping, the screen's aspect ratio | §5 `canvas`: full-screen recipe |
| Does a hidden canvas still redraw? | §5 `canvas`: yes, use `fps: 0` and `invalidate()` |
| `particles` (spec §6.4, reserved) not listed as unavailable | §14 |
| Events carry no time; may `draw` change `f.state`? | §9 and §10: frame order and shared state |
| "Works with two people" depends on the host's `maxFaces` | §4 |
| How far talking moves `jawOpen`, to choose a threshold | §9 |
| A hat from several shapes: the rotation pivot, no grouping | §4: pivot, offsets computed in `filter.ts` |
| Does the head occluder cover the crown? | §5 `model` |
| `--from` and `--max-faces` only in `ouaf preview --help`; events fire only between `--from` and `--at` | §17 |
| `ouaf preview` reported `faces: 1` with nothing drawn (a face lost less than 0.5 s before, in its grace delay) | fixed in #196 |
| `ouaf preview` cannot set a parameter or report the events that fired | #197 |
| Text: no template (`"Happy birthday, {name}!"`), no anchoring at the bottom of a block, no measuring outside a canvas | #198 |
| Models: one color per shape, no grouping of parts | #199 |
| No sound on the event (`f.sound()`, §14) | known (§14) |

## Running it again

Give a fresh agent the request and the rules above, in an empty `filters/<id>/` of an up-to-date checkout, and
compare its report with this one: a guide change should shorten the friction log, never lengthen it. Keep the
result as a new folder of `docs/acceptance/` when it adds something (another kind of filter, another agent).
