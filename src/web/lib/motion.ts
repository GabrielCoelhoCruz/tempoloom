// Motion values for code (docs/specs/ui-refresh.md MOT-8). They come from the
// tokens in styles.css, read on first use, so CSS stays the one source.
let tokens: CSSStyleDeclaration | undefined;
const token = (name: string) => {
  tokens ??= getComputedStyle(document.documentElement);
  return tokens.getPropertyValue(name).trim();
};
const ms = (name: string) => Number.parseFloat(token(name));

export const easeOut = () => token("--ease-out");
export const easeInOut = () => token("--ease-in-out");
export const moveMs = () => ms("--duration-move");
export const exitMs = () => ms("--duration-exit");
export const fadeMs = () => ms("--duration-fade");

/** False when the user asks for reduced motion (MOT-9): code-driven motion checks it itself. */
export const motionOK = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A click with no pointer came from Enter or Space (MOT-6): an overlay it opens shows at once. */
export const byKeyboard = (e: MouseEvent) => e.detail === 0;
