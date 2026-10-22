// Test tool: moves Date.now() and new Date() of this Node process by
// TEMPOLOOM_E2E_SHIFT_MS, so that the E2E suite runs as if the real time were
// another day and hour (order 29 checks). scripts/e2e-at.sh loads it into the
// test runner; tests/e2e/fixtures.ts passes it on to the server and the browser.
const shift = Number(process.env.TEMPOLOOM_E2E_SHIFT_MS ?? 0);
if (shift) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...args);
    }
    static now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ShiftedDate;
}
