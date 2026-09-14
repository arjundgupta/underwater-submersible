/**
 * The plates on the cover.
 *
 * Every image on the cover comes from this list — the plate panel beside the
 * letter shows them in order, and terms in the letter point at them by id, so
 * a term marked `fig: 'hull'` raises the plate carrying that id.
 *
 * ---------------------------------------------------------------------------
 * ADDING A PLATE
 *
 * Drop the image in `public/figures/` and add an entry here pointing `src` at
 * it. Anything the browser can show works (.webp, .jpg, .png); landscape suits
 * the frame best — it is cropped to fill, from the centre. `alt` describes
 * what is actually in the picture. The panel, its index and the `NN / NN`
 * counter all follow this array; the index only appears once there is more
 * than one plate to choose from.
 *
 * A term in the letter that names an id no plate carries is simply left
 * unmarked, so the references in `foreword` (lib/content.ts) can stay where
 * they are while the plates they wait for are still to come.
 * ---------------------------------------------------------------------------
 */

export type Figure = {
  /** Referenced from the letter — see `fig` in lib/content.ts. */
  id: string
  code: string
  caption: string
  src: string
  alt: string
}

export const figures: Figure[] = [
  {
    id: 'assembly',
    code: 'PL-01',
    caption: 'Assembly — see-through view',
    src: '/figures/assembly-see-through.webp',
    alt: 'See-through render of the assembled machine: the pressure housing, chassis, battery cells and autopilot inside the translucent hull, with the thrusters, camera and connector mounted around it',
  },
]

export const figureById = new Map(figures.map((figure) => [figure.id, figure]))
