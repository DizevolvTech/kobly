// jsdom não traz matchMedia/ResizeObserver/IntersectionObserver; o app usa os três.
if (!window.matchMedia) {
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
class Noop { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
window.ResizeObserver = window.ResizeObserver || Noop;
window.IntersectionObserver = window.IntersectionObserver || Noop;
window.scrollTo = window.scrollTo || (() => {});
