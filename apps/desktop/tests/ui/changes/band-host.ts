/**
 * W3's topic band hosts ChangesOpener in its changes slot. Until that is merged nothing in the composed app shows or opens
 * What changed, so tests that go through the app to reach it are skipped. Flip this to true when the band is merged.
 */
export const BAND_HOST_LANDED = false;
