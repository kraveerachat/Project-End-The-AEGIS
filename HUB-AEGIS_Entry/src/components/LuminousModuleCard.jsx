import { motion } from 'framer-motion'
import { EASE } from '../lib/motion.js'

/**
 * A module launcher — a machined device with a slot of light across its face.
 * One per entitled module, so this renders 1 card for `user` and 3 for
 * `admin`; the grid centres whatever survives (DESIGN.md · The module index).
 *
 * The card IS the button: the whole face, one tab stop, one accessible name,
 * and no focusable descendant. Nothing inside it may become a control — a
 * second control would need its own tab stop and would be promising something
 * reversible, and launching a module is a one-way trip.
 *
 * `live` holds the lit state through the "Entering…" beat — `:active` would
 * die with the pointer, and the light is the thing telling you the machine
 * took the command.
 *
 * The wrapper owns the stagger (framer writes `transform`); the button owns
 * hover/press via CSS `translate`/`scale`, which compose with that instead
 * of fighting it. See DESIGN.md · Motion.
 */
export function LuminousModuleCard({ title, description, icon: Icon, live = false, dimmed = false, variants, onClick }) {
  return (
    /* No padding here to "make room" for the bracket frame: the frame is
       absolutely positioned and out of flow, so padding would not reserve
       space for it — it would only shrink the card (width:100% of a padded
       320px box is 288px). The frame bleeds 1rem into the grid's 3rem gap
       and into main's px-6, which is where it belongs. */
    <motion.div variants={variants} className="w-full">
      {/* SVG Gradient definitions for the dual-tone/gradient icon style */}
      <svg width="0" height="0" style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
        <defs>
          <linearGradient id="icon-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
      </svg>
      <motion.button
        type="button"
        onClick={onClick}
        animate={{ opacity: dimmed ? 0.3 : 1 }}
        transition={{ duration: 0.24, ease: EASE }}
        className={`lum-card ${live ? 'is-live' : ''}`}
      >
        <span className="lum-light" aria-hidden>
          <span className="lum-slit" />
          <span className="lum-lumen">
            <i className="min" />
            <i className="mid" />
            <i className="hi" />
          </span>
          <span className="lum-darken">
            <i className="sl" />
            <i className="ll" />
            <i className="slt" />
            <i className="srt" />
          </span>
        </span>

        {/* strokeWidth stays 1.5 at hero size rather than scaling with the box:
            held constant, the line thins optically and reads as an engraving in
            the housing instead of a blown-up UI glyph. Size is paired with
            `.lum-icon`'s top in index.css — the two together centre it in the
            card's upper half, so neither moves alone. */}
        <span className="lum-icon" aria-hidden>
          <Icon size={56} strokeWidth={1.5} color="url(#icon-grad)" style={{ stroke: 'url(#icon-grad)' }} />
        </span>

        <span className="lum-bottom">
          <span className="lum-title">{title}</span>
          <span className="lum-desc">{description}</span>
        </span>
      </motion.button>
    </motion.div>
  )
}
