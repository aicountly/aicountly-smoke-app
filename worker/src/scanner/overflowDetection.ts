/**
 * Pure overflow helpers shared with pageScanner's evaluate body. Wide tables
 * and tall modals that already live inside overflow:auto|scroll containers are
 * not viewport overflow — they are intended scroll regions (attendance grids,
 * ledgers, GST registers).
 */

export type OverflowAxis = 'x' | 'y';

export type ScrollContainerProbe = {
  overflowX: string;
  overflowY: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

/** True when the probe is an overflow auto/scroll container on the given axis. */
export function isScrollContainer(probe: ScrollContainerProbe, axis: OverflowAxis): boolean {
  if (axis === 'x') {
    const ox = (probe.overflowX || '').toLowerCase();
    if (ox !== 'auto' && ox !== 'scroll') return false;
    // Constrained width, or already horizontally scrollable content.
    return probe.clientWidth > 0 && (probe.scrollWidth > probe.clientWidth || ox === 'auto' || ox === 'scroll');
  }
  const oy = (probe.overflowY || '').toLowerCase();
  if (oy !== 'auto' && oy !== 'scroll') return false;
  return probe.clientHeight > 0 && (probe.scrollHeight > probe.clientHeight || oy === 'auto' || oy === 'scroll');
}

export function hasScrollableAncestor(
  ancestors: ScrollContainerProbe[],
  axis: OverflowAxis,
): boolean {
  return ancestors.some((ancestor) => isScrollContainer(ancestor, axis));
}

/**
 * True when the element extends past the viewport AND no ancestor already
 * provides a scroll container on that axis.
 */
export function isViewportOverflow(
  size: number,
  viewport: number,
  ancestors: ScrollContainerProbe[],
  axis: OverflowAxis,
  slack = 10,
): boolean {
  if (size <= viewport + slack) return false;
  return !hasScrollableAncestor(ancestors, axis);
}

/**
 * Source text for the ancestor-walk helper embedded in pageScanner's evaluate
 * string. Kept next to the pure Node helpers so the contract stays documented
 * and testable without a browser.
 */
export const HAS_SCROLLABLE_ANCESTOR_JS = `
  const hasScrollableAncestor = (el, axis) => {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      const style = getComputedStyle(cur);
      const overflow = axis === 'x' ? style.overflowX : style.overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        if (axis === 'x' && cur.clientWidth > 0) return true;
        if (axis === 'y' && cur.clientHeight > 0) return true;
      }
      cur = cur.parentElement;
    }
    return false;
  };
`;
