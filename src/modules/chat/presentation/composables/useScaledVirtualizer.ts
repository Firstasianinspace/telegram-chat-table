import { computed } from 'vue';
import {
  useVirtualizer,
  elementScroll,
  observeElementOffset,
  type VirtualizerOptions,
  type PartialKeys,
} from '@tanstack/vue-virtual';

type ScaledVirtualizerOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
> = PartialKeys<
  VirtualizerOptions<TScrollElement, TItemElement>,
  'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
>;

/**
 * Browser engines hard-clamp how tall a single scrollable element's content
 * can be (Chromium ~33,554,428px / 2^25-4; other engines cap lower). A
 * virtualized list whose real content height (count * itemSize) exceeds this
 * becomes partially unscrollable: rows past the clamp point can never be
 * scrolled into view, no matter how correct the underlying data is.
 *
 * Picked with headroom under the smallest documented cross-browser cap,
 * rather than cutting it close to Chromium's specific limit.
 */
const SAFE_SCROLL_HEIGHT = 8_000_000;

/**
 * Wraps `useVirtualizer` with a linear offset scale so the DOM never has to
 * render a scrollable area taller than `SAFE_SCROLL_HEIGHT`, while item
 * visibility math still resolves every logical index correctly.
 *
 * `observeElementOffset`/`scrollToFn` are the only two hooks that ever touch
 * DOM scroll pixels; everything else in the virtualizer (`getVirtualItems`,
 * measurements) operates purely in the real/logical coordinate space
 * (index * itemSize) and is unaffected by the DOM clamp. So converting at
 * exactly those two boundaries is sufficient — no need to reimplement or
 * patch the library itself.
 *
 * Callers must scale the *invisible padding* spacers they render (by
 * `scaleFactor`) before writing them as pixel heights — never the rendered
 * rows themselves, which must stay at true size or content becomes unreadable.
 */
export function useScaledVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: ScaledVirtualizerOptions<TScrollElement, TItemElement>,
) {
  const realTotalSize = computed(() => options.count * options.estimateSize(0));
  const scaleFactor = computed(() =>
    realTotalSize.value > SAFE_SCROLL_HEIGHT
      ? SAFE_SCROLL_HEIGHT / realTotalSize.value
      : 1,
  );

  // `options` carries live getters (e.g. `get count()` reading a ref) that
  // must be re-read on every change, not snapshotted once. Spreading it
  // directly into a plain object here would freeze those getters' values at
  // setup time. Wrapping the spread in `computed` — the same pattern
  // `useVirtualizer` itself uses internally for its own defaults spread —
  // keeps it reactive: Vue re-runs this evaluator (and re-reads `options`'
  // getters fresh) whenever a dependency they touch changes.
  const virtualizer = useVirtualizer<TScrollElement, TItemElement>(
    computed(() => ({
      ...options,
      observeElementOffset: (instance, callback) =>
        observeElementOffset(instance, (domOffset, isScrolling) => {
          callback(domOffset / scaleFactor.value, isScrolling);
        }),
      scrollToFn: (offset, adjustOptions, instance) =>
        elementScroll(
          offset * scaleFactor.value,
          {
            ...adjustOptions,
            adjustments: (adjustOptions.adjustments ?? 0) * scaleFactor.value,
          },
          instance,
        ),
    })),
  );

  return {
    virtualizer,
    scaleFactor,
  };
}
