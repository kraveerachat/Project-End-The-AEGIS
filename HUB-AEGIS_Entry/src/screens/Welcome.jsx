import { AnimatePresence, motion } from 'framer-motion'
import { AegisMark } from '../components/AegisMark.jsx'
import { Btn } from '../components/ui.jsx'
import { EASE, SPRING } from '../lib/motion.js'

/**
 * Screen 1 — the door, rendered as the brand panel of the vault card.
 * Welcome state: it IS the compact card — mark, wordmark, tagline and
 * the one ENTER button, all centered. Login state: it glides into the
 * left branding panel (top panel below `md`); only the button leaves.
 * Every size change here is instant in layout terms — the `layout`
 * props let framer-motion spring the whole move as one gesture.
 */
export function Welcome({ t, isWelcome, onEnter }) {
  return (
    <motion.div
      layout
      transition={SPRING}
      className={`flex flex-col items-center justify-center text-center min-w-0 ${
        isWelcome ? 'w-full px-8 py-14' : 'md:w-[42%] px-8 pt-10 pb-8 md:py-12'
      }`}
    >
      <motion.div layout transition={SPRING}>
        <AegisMark size={isWelcome ? 168 : 126} />
      </motion.div>
      {/* 92px is the editorial ceiling here: the display cap is ~96px, and
          the wordmark still has to clear 320px viewports at this weight. */}
      <motion.h1
        layout
        transition={SPRING}
        className="font-bold tracking-[-0.03em] text-ink leading-none"
        style={{ fontSize: isWelcome ? 'clamp(64px, 17vw, 92px)' : 46, marginTop: isWelcome ? 32 : 24 }}
      >
        AEGIS
      </motion.h1>
      <motion.p
        layout
        transition={SPRING}
        className="font-medium tracking-[0.12em] text-ink-3 text-balance"
        style={{ fontSize: isWelcome ? 19 : 14, marginTop: isWelcome ? 20 : 14 }}
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
            <Btn variant="primary" size="lg" className="mt-11 min-w-[220px]" onClick={onEnter} autoFocus>
              {t('enter')}
            </Btn>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
