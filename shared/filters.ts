/**
 * The filter catalogue, shared by pictures and video.
 *
 * A filter is a named recipe of colour adjustments and nothing else. That is a
 * deliberately small idea, and it is small on purpose: every engine that can
 * render one - the CPU raster path for pictures, ffmpeg's `-vf` for video, the
 * MCP tools an agent calls - reads the *same* list from here. The moment a
 * filter is defined twice, once per engine, the two copies drift and the
 * picture a user edited stops matching the video they applied the same look to,
 * which is the sort of thing nobody notices until someone compares them.
 *
 * So this file declares intent only. It has no dependencies, imports nothing, and
 * is read by three TypeScript projects (node, web, mcp) the same way
 * `shared/edit.ts` and `shared/video.ts` are: a filter id crosses the process
 * boundary as a string, and the work happens on the far side.
 *
 * What is *not* here is the arithmetic. `core/edit/filters.ts` has the picture
 * version and `core/video/edit.ts` has the ffmpeg version, and they will not be
 * pixel-identical - ffmpeg works in YUV with its own colour maths, a CPU loop
 * works in RGBA - so the ordering below is the contract rather than any
 * individual formula. Change the order and you change the look of every existing
 * preset in both places.
 */

/**
 * One knob a filter may turn.
 *
 * The ranges are the ones the sliders accept and the ones both engines clamp to,
 * so a recipe cannot ask for a contrast of 400 and get something the user cannot
 * undo by dragging back. Values are all "more is stronger" except `gamma`, which
 * is a multiplier: below 1 lifts the midtones, above 1 pushes them down.
 */
export interface FilterAdjustments {
  /** -100 to 100. Positive lightens. */
  brightness?: number
  /** -100 to 100. Positive raises contrast about mid grey. */
  contrast?: number
  /** -100 to 100. Positive saturates, negative desaturates. */
  saturation?: number
  /** 0.2 to 3. 1 leaves midtones alone. */
  gamma?: number
  /** -100 to 100. Positive warms, negative cools. */
  temperature?: number
  /** 0 to 100. The classic brown tone-map, blended by this much. */
  sepia?: number
  /** 0 to 100. Lifts the blacks towards flat grey. */
  fade?: number
  /** 0 to 100. Darkens the corners. */
  vignette?: number
}

/**
 * A filter as chosen in the UI or passed to a tool.
 *
 * `id` is a string rather than a union of the catalogue's ids so that a value
 * read back from a saved session, or sent by an agent that is a version behind,
 * is a thing to be validated and reported - not a value the compiler pretends
 * cannot happen. `amount` is optional because 100% is the overwhelmingly common
 * case and making it mandatory would put a redundant number in every saved
 * document and every tool call.
 */
export interface FilterSettings {
  /** A catalogue id, or `'none'` for no filter at all. */
  id: string
  /** 0 to 100. Defaults to 100. */
  amount?: number
}

export interface FilterPreset {
  id: string
  /** Shown on the button. Short enough for a chip. */
  label: string
  /**
   * What it is for, in the words someone would actually use.
   *
   * "Vivid" tells a user nothing. "Sunlight and late afternoon" tells them
   * whether to try it, which is the only question a filter picker ever answers.
   */
  hint: string
  /** The full-strength recipe. `amount` scales it down from here. */
  recipe: FilterAdjustments
}

/**
 * The order adjustments are applied in.
 *
 * Exported because both engines need it and because it is the part of a filter
 * that is easy to break by accident:
 *
 * 1. `gamma` first, so the contrast below pivots around corrected midtones. A
 *    contrast applied before a gamma curve raises contrast about the wrong grey,
 *    which is why a gamma-then-contrast photo and a contrast-then-gamma photo
 *    are not the same photo.
 * 2. brightness, contrast and saturation next, as one tone pass.
 * 3. `temperature` after the tone pass, because a colour cast reads as a cast on
 *    a correctly exposed image; applied first it turns into a contrast problem.
 * 4. `sepia` after the cast, since it is a tone-map over an already-chosen colour.
 * 5. `fade` last of the flat operations, because it lifts blacks and anything
 *    lifted before it gets lifted twice.
 * 6. `vignette` absolutely last, because it darkens the corners of whatever the
 *    rest of the filter produced rather than of the original.
 */
export const FILTER_ORDER = ['gamma', 'brightness', 'contrast', 'saturation', 'temperature', 'sepia', 'fade', 'vignette'] as const

/** The knob names, in application order. Derived from the one list above. */
export const FILTER_ADJUSTMENT_KEYS = FILTER_ORDER

export const FILTERS: readonly FilterPreset[] = [
  {
    id: 'none',
    label: 'None',
    hint: 'The picture as it is.',
    recipe: {}
  },
  {
    id: 'punch',
    label: 'Punch',
    hint: 'More contrast and colour. Food, travel, anything outdoors in daylight.',
    recipe: { contrast: 16, saturation: 20, gamma: 0.98 }
  },
  {
    id: 'mono',
    label: 'Mono',
    hint: 'Black and white, a little firmer than plain desaturation.',
    recipe: { saturation: -100, contrast: 10 }
  },
  {
    id: 'sepia',
    label: 'Sepia',
    hint: 'The old photographic brown.',
    recipe: { sepia: 80, fade: 10 }
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: 'Sunlight and late afternoon.',
    recipe: { temperature: 30, saturation: 10, brightness: 3 }
  },
  {
    id: 'cool',
    label: 'Cool',
    hint: 'Overcast light, blue shade, winter.',
    recipe: { temperature: -32, contrast: 8 }
  },
  {
    id: 'faded',
    label: 'Faded',
    hint: 'Washed out, like a print left in a drawer.',
    recipe: { fade: 34, contrast: -14, saturation: -16 }
  },
  {
    id: 'noir',
    label: 'Noir',
    hint: 'Hard black and white with darkened corners.',
    recipe: { saturation: -100, contrast: 28, vignette: 45 }
  },
  {
    id: 'vintage',
    label: 'Vintage',
    hint: 'Warm, soft and slightly darkened.',
    recipe: { temperature: 22, sepia: 26, fade: 26, vignette: 28 }
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    hint: 'Cool shadows and darkened edges.',
    recipe: { contrast: 18, temperature: -16, fade: 16, vignette: 32 }
  }
]

/** Catalogue ids in display order, for building a validation list. */
export const FILTER_IDS: readonly string[] = FILTERS.map((f) => f.id)

const BY_ID = new Map(FILTERS.map((f) => [f.id, f]))

/** The id that means "no filter", which is also the first button. */
export const NO_FILTER = 'none'

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.max(low, Math.min(high, value))
}

/** The preset for an id, or undefined if the catalogue has no such entry. */
export function findFilter(id: string): FilterPreset | undefined {
  return BY_ID.get(id)
}

/**
 * The recipes that carry no colour, in the order they are applied.
 *
 * A filter whose recipe is entirely `none`-able collapses to nothing, and the
 * caller uses an empty result to skip the work entirely rather than copying every
 * pixel to produce an identical picture.
 */
export function isEmptyAdjustments(adjustments: FilterAdjustments): boolean {
  return Object.values(adjustments).every((v) => v === undefined || v === 0 || v === 1)
}

function clampKnob(key: keyof FilterAdjustments, value: number): number {
  switch (key) {
    case 'gamma':
      return clamp(value, 0.2, 3)
    case 'sepia':
    case 'fade':
    case 'vignette':
      return clamp(value, 0, 100)
    default:
      return clamp(value, -100, 100)
  }
}

/**
 * Scales a recipe by a percentage.
 *
 * `gamma` is the odd one out: it is a multiplier pivoted on 1, so "half as
 * strong" means moving halfway from 1 to the recipe's value, not multiplying it
 * by a half. Multiplying would send a gamma of 0.98 - a subtle midtone lift, the
 * kind of thing that reads as "nothing" in a recipe - to 0.49 at half strength,
 * which is a different picture entirely.
 *
 * A knob that is 0, 1 or absent in the recipe stays there: 0 stays 0, and an
 * absent `gamma` is not the same as a gamma of 1 and is left absent so the engine
 * skips it rather than running a curve that does nothing.
 */
export function scaleAdjustments(recipe: FilterAdjustments, amount: number): FilterAdjustments {
  const scale = clamp(amount, 0, 100) / 100
  if (scale === 0) return {}
  if (scale === 1) return { ...recipe }

  const out: FilterAdjustments = {}
  for (const key of FILTER_ORDER) {
    const value = recipe[key]
    if (value === undefined) continue
    out[key] = key === 'gamma' ? 1 + (value - 1) * scale : clampKnob(key, value * scale)
  }
  return out
}

/** Whether these settings ask for no change at all. */
export function isNoFilter(settings: FilterSettings | null | undefined): boolean {
  if (!settings) return true
  if (settings.id === NO_FILTER) return true
  // A filter at zero percent is also nothing, and treating it as a real filter
  // would make it show up in the UI as a selection that does nothing.
  return (settings.amount ?? 100) <= 0
}

/**
 * Turns settings into the concrete adjustments to apply.
 *
 * Returns `{}` for `none` and for a zero amount, which every caller is expected
 * to read as "skip this entirely".
 *
 * An unknown id throws rather than resolving to nothing. A filter that silently
 * did nothing is the worst outcome available: the user picks a look, the button
 * lights up, the preview agrees, and the saved file is the untouch original. A
 * message naming the ids that do exist turns the same mistake into something the
 * caller - a person or an agent - can correct.
 */
export function resolveFilter(settings: FilterSettings | null | undefined): FilterAdjustments {
  if (isNoFilter(settings)) return {}
  const preset = findFilter(settings!.id)
  if (!preset) {
    throw new Error(`unknown filter "${settings!.id}"; the available filters are ${FILTER_IDS.join(', ')}`)
  }
  return scaleAdjustments(preset.recipe, settings!.amount ?? 100)
}

/** A one-line summary for a tool reply, so an agent can confirm what it applied. */
export function describeFilter(settings: FilterSettings | null | undefined): string {
  if (isNoFilter(settings)) return 'no filter'
  const preset = findFilter(settings!.id)
  const label = preset ? preset.label : settings!.id
  const amount = clamp(settings!.amount ?? 100, 0, 100)
  return amount === 100 ? `${label} (${preset?.id ?? settings!.id})` : `${label} (${preset?.id ?? settings!.id}) at ${amount}%`
}

/*
 * The rest of this file is the part of a recipe both engines have to agree on
 * exactly, because these are not implementation details of either one. The
 * picture loop turns them into per-pixel arithmetic; ffmpeg turns them into
 * `colorchannelmixer` and `colorlevels` arguments. If they lived in
 * `core/edit/filters.ts` the video side would have a second copy, and a
 * half-sepia in a picture and a different half-sepia in a clip is precisely the
 * drift this file exists to prevent.
 */

/** The classic sepia matrix, as nine coefficients in row order. */
export const SEPIA_MATRIX = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131] as const

/** What a channel-mixer starts as: pass-through. */
export const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const

/**
 * Sepia blended from the identity by `amount` percent.
 *
 * Blended, not substituted, which is why the three diagonal terms move *down* from
 * 1 while the six off-diagonal terms move up from 0. A half-strength sepia is
 * half-way between the picture and the matrix. Writing `1 - amount/100` for the
 * diagonal instead of interpolating towards the matrix's own value would darken
 * every pixel in the sepia, which is the bug this function exists to prevent.
 */
export function sepiaMatrix(amount: number): number[] {
  const a = clamp(amount, 0, 100) / 100
  const out: number[] = []
  for (let k = 0; k < 9; k++) out.push(IDENTITY_MATRIX[k]! + a * (SEPIA_MATRIX[k]! - IDENTITY_MATRIX[k]!))
  return out
}

/**
 * How far `fade` at 100% lifts a pure black pixel, out of 255.
 *
 * 82: a bit under a third of the way towards white, which is what "faded" looks
 * like on a print and is enough to read as deliberate. Higher and the picture
 * looks like it was shot through fog; lower and the control does nothing anyone
 * would notice.
 */
export const MAX_FADE_LIFT = 82

/**
 * How far apart `temperature` at 100% pushes the red and blue planes.
 *
 * 30%: enough to notice on skin, not enough to make a blue sky look like a
 * mistake.
 */
export const MAX_TEMPERATURE_GAIN = 0.3

/**
 * How far green travels during a full temperature shift.
 *
 * A fifth of the red/blue gap. Green moving with them is what turns a warm cast
 * into a yellow cast, and yellow reads as a fault rather than as evening.
 */
export const MAX_TEMPERATURE_GREEN_GAIN = 0.06

/**
 * Where a vignette starts to bite, as a fraction of the half-diagonal, and where
 * it is fully dark.
 *
 * The centre of the frame is 0 and a corner is `Math.SQRT2`. Starting at 0.45
 * rather than 0 keeps the middle of the frame - where the subject usually is -
 * completely untouched, so the filter darkens a picture's edges without
 * darkening its face.
 */
export const VIGNETTE_START = 0.45
export const VIGNETTE_END = Math.SQRT2