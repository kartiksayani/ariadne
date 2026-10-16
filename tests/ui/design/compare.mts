// The pixel comparison shared by the v2 handoff spec (design.spec.mts) and the final-board spec (final.spec.mts).
import { expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pixels whose channels differ by more than this count as mismatched.
export const tolerance = 16;

/** Pixel diff in the browser canvas: mismatch ratio and a diff image (mismatches red over the dimmed app). */
export async function compare(page: Page, design: Buffer, app: Buffer, regions: readonly Region[] = [], masks: readonly Region[] = [], shifts: readonly Shift[] = []) {
  return page.evaluate(async ({ design, app, tolerance, regions, masks, shifts }) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = `data:image/png;base64,${base64}`;
    });
    const [left, right] = await Promise.all([load(design), load(app)]);
    const width = Math.max(left.width, right.width), height = Math.max(left.height, right.height);
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); return context.getImageData(0, 0, width, height).data;
    };
    const a = pixels(left), b = pixels(right), canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!, out = context.createImageData(width, height);
    let mismatched = 0;
    const inRegion = regions.map(() => 0);
    for (let index = 0; index < a.length; index += 4) {
      const x = (index / 4) % width, y = Math.floor(index / 4 / width);
      // A masked region is left out of the ratio (the frame's full area still divides it) and shown tinted blue in the diff.
      if (masks.some(mask => x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height)) {
        out.data.set([b[index] * 0.3, b[index + 1] * 0.3 + 24, b[index + 2] * 0.3 + 64, 255], index);
        continue;
      }
      // A shifted band is compared with the design's pixel `dy` rows lower: the app's row sits higher by an intended change.
      const shift = shifts.find(band => x >= band.x && x < band.x + band.width && y >= band.y && y < band.y + band.height);
      const other = shift && y + shift.dy < height ? index + shift.dy * width * 4 : index;
      const differs = [0, 1, 2, 3].some(channel => Math.abs(a[other + channel] - b[index + channel]) > tolerance);
      if (differs) {
        mismatched++;
        regions.forEach((region, at) => { if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) inRegion[at]++; });
        out.data.set([255, 0, 64, 255], index);
      } else out.data.set([b[index] * 0.3, b[index + 1] * 0.3, b[index + 2] * 0.3, 255], index);
    }
    context.putImageData(out, 0, 0);
    return { ratio: mismatched / (width * height), regions: regions.map((region, at) => inRegion[at] / Math.max(1, region.width * region.height)), width, height,
      png: canvas.toDataURL('image/png').split(',')[1] };
  }, { design: design.toString('base64'), app: app.toString('base64'), tolerance, regions, masks, shifts });
}
export interface Region { readonly name: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** App rows [y, y + height) of the columns [x, x + width) are compared with the design's rows `dy` lower. */
export interface Shift extends Region { readonly dy: number }

/** The rectangle of a PNG, as a PNG: the Claude Design screenshots carry a label above each frame, which is cut off before comparing. */
export async function crop(page: Page, png: Buffer, rect: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ png, rect }) => {
    const image = new Image();
    await new Promise<void>((done, fail) => { image.onload = () => done(); image.onerror = fail; image.src = `data:image/png;base64,${png}`; });
    const canvas = document.createElement('canvas'); canvas.width = rect.width; canvas.height = rect.height;
    canvas.getContext('2d')!.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, { png: png.toString('base64'), rect });
  return Buffer.from(base64, 'base64');
}

export type CompareResult = Awaited<ReturnType<typeof compare>>;
export interface CaptureInput {
  readonly id: string; readonly design: Buffer; readonly app: Buffer;
  /** Where the three PNGs go; the frame's JSON goes to <directory>/frames/<id>.json. */
  readonly directory: string;
  /** The largest mismatch ratio that passes; null records the ratio without asserting it (a pending state). */
  readonly threshold: number | null;
  readonly regions?: readonly Region[]; readonly masks?: readonly Region[]; readonly shifts?: readonly Shift[];
  /**
   * With `regions`: the largest mismatch ratio each region may reach, index for index (null records without asserting). The
   * ratio is the region's own (mismatched pixels over the region's area). Pass `threshold: null` to assert only the regions.
   */
  readonly regionThresholds?: readonly (number | null)[];
  /** The frame's report: the ratio and threshold are added to what this returns. */
  readonly report?: (result: CompareResult) => object;
  /**
   * Every request the render asked for outside what it is allowed (from the blocking routes). Written into the frame's JSON as
   * `denied`, and asserted empty after the files are written, so a frame with a denied request still leaves its evidence.
   */
  readonly denied?: readonly string[];
}

/** Compares the design frame with the app's, writes <id>-design.png, -app.png, -diff.png and the frame's JSON, then asserts nothing was denied and the thresholds. */
export async function captureFrame(canvas: Page, input: CaptureInput): Promise<CompareResult> {
  const result = await compare(canvas, input.design, input.app, input.regions, input.masks, input.shifts);
  writeFileSync(resolve(input.directory, `${input.id}-design.png`), input.design);
  writeFileSync(resolve(input.directory, `${input.id}-app.png`), input.app);
  writeFileSync(resolve(input.directory, `${input.id}-diff.png`), Buffer.from(result.png, 'base64'));
  const report = { ratio: Number(result.ratio.toFixed(4)), threshold: input.threshold, tolerance, ...input.report?.(result), ...input.denied && { denied: [...input.denied] } };
  writeFileSync(resolve(input.directory, 'frames', `${input.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  if (input.denied) expect(input.denied, `${input.id}: nothing outside the allowed files was asked for`).toEqual([]);
  if (input.threshold !== null) expect(result.ratio, `${input.id} mismatch ratio`).toBeLessThanOrEqual(input.threshold);
  input.regionThresholds?.forEach((limit, at) => {
    if (limit !== null) expect(result.regions[at], `${input.id} ${input.regions?.[at]?.name ?? at} mismatch ratio`).toBeLessThanOrEqual(limit);
  });
  return result;
}
