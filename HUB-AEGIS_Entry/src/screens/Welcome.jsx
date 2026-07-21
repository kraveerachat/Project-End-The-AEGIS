import { AnimatePresence, motion } from 'framer-motion'
import { AegisMark } from '../components/AegisMark.jsx'
import { SparkleButton } from '../components/ui.jsx'
import { useMediaQuery, useReducedMotion } from '../lib/hooks.js'
import { EASE, SPRING } from '../lib/motion.js'

/* The door's idle. Not decoration and not a loading state — the machine
   is powered and breathing while it waits for you. It exists only on the
   Welcome state, where the user's whole job is to look at it and press
   one button; the moment there is a task on screen it stops. 4.6s is
   slow enough to read as weight rather than as a bobbing toy. */
const LEVITATE = { duration: 4.6, repeat: Infinity, ease: 'easeInOut' }

/**
 * Screen 1 — the door. Boxless: the mark, wordmark, tagline and the one
 * ENTER button sit directly on the photograph, with `.gate-halo` (owned
 * by App) calming the streaks behind them.
 *
 * Login state: the whole lockup shrinks and glides into the left branding
 * panel (top panel below `md`) as the card materializes around it; only
 * the button leaves. Every size change here is instant in layout terms —
 * the `layout` props let framer-motion spring the whole move as one gesture.
 */
export function Welcome({ t, isWelcome, onEnter }) {
  const reduced = useReducedMotion()
  const isMd = useMediaQuery('(min-width: 768px)')
  // The door is the one screen with a height budget, not just a width one:
  // it is a fixed stack (mark → wordmark → tagline → the one button) and
  // the mark is by far the largest term. Sized on width alone, a 1366×768
  // laptop got the full 360 and pushed ENTER under the fold — the door's
  // entire job is that button. 288 is the next size down that still hits a
  // whole-pixel multiple of the 642px source at 2x.
  const isTall = useMediaQuery('(min-height: 860px)')
  const markSize = isWelcome ? (isMd ? (isTall ? 360 : 288) : 260) : 160
  const levitating = isWelcome && !reduced

  return (
    <motion.div
      layout
      transition={SPRING}
      className={`flex flex-col items-center justify-center text-center min-w-0 ${
        isWelcome ? 'w-full px-6 py-10' : 'md:w-[42%] px-8 pt-10 pb-8 md:py-12'
      }`}
    >
      {/* Two elements, two transforms. `layout` owns position/scale for the
          shrink; the inner div owns the levitation `y`. One element cannot
          do both — framer would be writing the same transform twice and the
          mark would jitter against its own landing. */}
      <motion.div layout transition={SPRING}>
        <motion.div
          animate={levitating ? { y: [0, -15, 0] } : { y: 0 }}
          transition={levitating ? LEVITATE : { duration: 0.4, ease: EASE }}
        >
          <AegisMark size={markSize} />
        </motion.div>
      </motion.div>

      {/* 124px is the wordmark ceiling: five letters of a brand lockup on a
          full-bleed door, not a content heading. It still has to clear 320px
          viewports, hence the clamp — the viewport is part of the design.

          `lang="en"` is load-bearing, not metadata. `:lang(th) { 1.7 }` in
          index.css is UNLAYERED, and Tailwind's utilities live in
          @layer utilities — unlayered declarations beat every layered one,
          so `leading-*` on this element was silently dead for as long as the
          page has been Thai. The wordmark measured 211px against the 102px
          it asked for: 124px × 1.7. That phantom ~54px of half-leading under
          the baseline WAS the gap to the tagline, and no margin can subtract
          it. Do not "fix" this by layering the Thai rule — it is unlayered so
          that the tone-mark floor cannot be overridden by accident, which is
          exactly what DESIGN.md wants. Fix it where it is actually wrong: the
          rule matches on the document's language, and this element is not
          Thai in any language. It is five Latin caps.

          leading-[0.82] is then safe because there is nothing to clip: caps
          reach 0.73em and the box still holds 0.82em. A word with a descender
          here would need this reconsidered. It does mean the baseline now sits
          only ~0.05em above the box bottom, so the gap below is entirely the
          margin's job — which is why that margin is stated here and not on the
          tagline.

          BOTH lockup gaps are owned here, both in `em`. Three things forced it:

          1. em resolves against THIS element's font-size, so one number rides
             the clamp 52→124px and then down to the lock's 46px. A px gap held
             no constant relationship — it measured 0.065em of the wordmark at
             1440 and 0.15em at 320, cramped exactly where the wordmark was
             largest.
          2. The gap that reads is the RATIO of the two, not either alone: the
             eye compares the space above the wordmark to the space below it.
             At 40px top / 0.18em bottom that ratio was 2.1 at desktop and 3.85
             on a phone — the tagline welded to the wordmark while the mark
             floated free. Scaling only the bottom gap made the phone WORSE,
             because a fixed 40px top gap does not shrink with the wordmark.
             Equal em on both holds the ratio at 1.2–1.5 everywhere.
          3. It needs to be generous, not merely correct: `productTag` renders
             ~1.9× WIDER than "AEGIS". A long thin tracked-caps line set close
             under a short fat word stops reading as a subtitle and starts
             reading as a rule underlining the wordmark. Width is why it needs
             air. At 0.38em the optical gap (baseline → tagline cap-top) is
             0.48–0.53em of the wordmark in every state.

          The two gaps are equal in em but NOT equal optically, and that is
          deliberate: the mark PNG carries ~6% transparent padding under its
          art (40 of 642 rows), which lands the top gap ~1.25× the bottom one —
          mark apart, wordmark and tagline paired. Reskinning the mark with
          different padding changes that ratio; re-measure if it does. */}
      <motion.h1
        lang="en"
        layout
        transition={SPRING}
        className="font-bold tracking-[-0.04em] text-ink leading-[0.82]"
        style={{
          fontSize: isWelcome ? 'clamp(52px, 13vw, 124px)' : 46,
          marginTop: '0.38em',
          marginBottom: '0.38em',
        }}
      >
        AEGIS
      </motion.h1>

      {/* --ink-2, not --ink-3. Measured against the actual photograph, ink-3
          hits 3.34:1 here: at desktop width the tagline is wide enough to
          reach the fibre streaks, and a grey streak behind it (backdrop
          luminance 0.598) eats the margin the halo was carrying. It is the
          product descriptor, not a caption — DESIGN.md reserves ink-3 for
          captions precisely so functional text never lands sub-AA.

          `lang="en"` for the same reason as the wordmark above: productTag
          is the SAME Latin string in both languages (strings.js), so the
          document's `th` was buying tone-mark clearance for a line that has
          no tone marks — only half-leading holding the lockup apart. With
          the rule correctly not matching, leading-[1.4] finally applies.

          No marginTop: the lockup gap lives on the wordmark's marginBottom in
          em (see above). These are flex children, so margins do NOT collapse —
          a margin here would ADD to that one and put the gap back under two
          numbers that have to be kept in step through the morph. One owner. */}
      <motion.p
        lang="en"
        layout
        transition={SPRING}
        className="font-bold tracking-[0.12em] text-balance leading-[1.4] bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 bg-clip-text text-transparent"
        style={{
          fontSize: isWelcome ? 'clamp(13px, 1.6vw, 20px)' : 14,
        }}
      >
        {t('productTag')}
      </motion.p>

      <AnimatePresence initial={false}>
        {isWelcome && (
          <motion.div
            layout
            key="enter"
            className="w-full flex justify-center"
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.18, ease: EASE } }}
          >
            {/* `sparkles="idle"` — the door is the one screen licensed to
                loop (DESIGN.md · Motion): no task, and the whole job is to
                look at the machine. It stops when the lock appears, because
                the button unmounts. mt-14 stays deliberately wide: the
                lockup above tightened, so the gap here is what keeps the
                logo one object and the action clearly a separate one. */}
            <SparkleButton
              sparkles="idle"
              size="xl"
              className="mt-14 min-w-[240px]"
              onClick={onEnter}
              autoFocus
            >
              {t('enter')}
            </SparkleButton>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
