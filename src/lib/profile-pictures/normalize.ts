import { ApiError } from "@/lib/api/errors";
import { imageTooLarge, PICTURE_LIMITS, pictureQueueFull, processingTimeout, unsupportedImage } from "./limits";
import { recognisePicture, type StillKind } from "./recognise";

type Engine = typeof import("sharp").default;

/** What a normalization hands back: the stored picture's bytes or the
 * refusal, answered by the deadline at the latest, and the moment no native
 * work reads the input any more, which may come later. */
export interface PictureWork {
  readonly picture: Promise<Buffer>;
  readonly settled: Promise<void>;
}

interface Turn { start(): void }
interface ProcessingState {
  /** Whether a normalization holds the one slot. */
  running: boolean;
  /** Pictures waiting for the slot, in arrival order. */
  readonly waiting: Turn[];
  /** Header reads and decodes begun, for the refusals that must come first. */
  readonly counts: { inspected: number; decoded: number };
  engine?: Promise<Engine>;
}

// One slot for the whole instance, shared by every compiled copy of the
// routes that process pictures.
const key = Symbol.for("dezfil.profile-picture-processing");
const host = globalThis as typeof globalThis & { [key]?: ProcessingState };
const processing = host[key] ??= { running: false, waiting: [], counts: { inspected: 0, decoded: 0 } };

/** How many header reads and decodes the processor has begun. */
export function pictureProcessorCounts(): { inspected: number; decoded: number } {
  return { ...processing.counts };
}
function count(stage: keyof ProcessingState["counts"]): void {
  processing.counts[stage] += 1;
}

/** The image library loads on first use, with its operation cache off, so
 * no account's pixels stay in it after an operation. A library that cannot
 * load refuses pictures and nothing else. */
function engine(): Promise<Engine> {
  return (processing.engine ??= import("sharp").then((module) => {
    const sharp: Engine = module.default;
    sharp.cache(false);
    return sharp;
  })).catch((failure: unknown) => {
    processing.engine = undefined;
    console.error("The picture library did not load", failure);
    throw new ApiError("internal", "This instance cannot process pictures: its image library did not load.", 500);
  });
}

/** Take the slot, or a place in the waiting room, or refuse. */
function admit(): { ready: Promise<void>; withdraw(): boolean } {
  if (!processing.running) {
    processing.running = true;
    return { ready: Promise.resolve(), withdraw: () => false };
  }
  if (processing.waiting.length >= PICTURE_LIMITS.waiting) throw pictureQueueFull();
  const turn = Promise.withResolvers<void>();
  const entry: Turn = { start: turn.resolve };
  processing.waiting.push(entry);
  return {
    ready: turn.promise,
    withdraw() {
      const index = processing.waiting.indexOf(entry);
      if (index < 0) return false;
      processing.waiting.splice(index, 1);
      return true;
    },
  };
}

function release(): void {
  const next = processing.waiting.shift();
  if (next) next.start();
  else processing.running = false;
}

const damaged = () => unsupportedImage("The image is damaged or incomplete.");

/** The header alone: format, size and frames, no pixel decoded. */
async function inspect(sharp: Engine, path: string, kind: StillKind): Promise<void> {
  count("inspected");
  const metadata = await sharp(path, { failOn: "warning", limitInputPixels: false }).metadata().catch(() => { throw damaged(); });
  if (metadata.format !== kind || !metadata.width || !metadata.height) throw damaged();
  if (metadata.width * metadata.height > PICTURE_LIMITS.pixels) throw imageTooLarge(metadata.width, metadata.height);
  if ((metadata.pages ?? 1) > 1) throw unsupportedImage("The image is animated.");
}

/** Turn the image the way its orientation says, cut the largest centred
 * square, scale it to the stored side and write one WebP. Transparency is
 * kept; every embedded record is dropped, since nothing asks to keep one. */
async function render(sharp: Engine, path: string, seconds: number, deadlineMs: number): Promise<Buffer> {
  count("decoded");
  return sharp(path, { failOn: "warning", limitInputPixels: PICTURE_LIMITS.pixels, autoOrient: true, sequentialRead: true })
    .resize(PICTURE_LIMITS.side, PICTURE_LIMITS.side, { fit: "cover", position: "centre" })
    .timeout({ seconds })
    .webp({ quality: 82, effort: 4 })
    .toBuffer()
    .catch((failure: unknown) => {
      throw failure instanceof Error && /timeout/i.test(failure.message) ? processingTimeout(deadlineMs) : damaged();
    });
}

/** Normalize one received picture. One normalization runs at a time on the
 * instance, eight more may wait, and the rest are refused. One deadline,
 * counted from the call, covers the wait, the header read and the
 * processing: at it the picture is refused and the work cancelled, and the
 * slot passes on only once the native work has settled. */
export function normalizePicture(path: string, deadlineMs: number = PICTURE_LIMITS.processMs): PictureWork {
  const deadline = performance.now() + deadlineMs;
  let turn: ReturnType<typeof admit>;
  try {
    turn = admit();
  } catch (error) {
    return { picture: Promise.reject(error), settled: Promise.resolve() };
  }
  const expired = Promise.withResolvers<never>();
  void expired.promise.catch(() => undefined);
  let cancelled = false;
  const timer = setTimeout(() => {
    cancelled = true;
    expired.reject(processingTimeout(deadlineMs));
  }, deadlineMs);
  const stopIfCancelled = () => { if (cancelled) throw processingTimeout(deadlineMs); };
  const work = (async () => {
    const started = await Promise.race([turn.ready.then(() => true), expired.promise.catch(() => false)]);
    if (!started) {
      // Withdrawn while waiting, no native work begun; a turn granted in
      // the same moment is passed straight on.
      if (!turn.withdraw()) { await turn.ready; release(); }
      throw processingTimeout(deadlineMs);
    }
    try {
      stopIfCancelled();
      const kind = await recognisePicture(path);
      stopIfCancelled();
      const sharp = await engine();
      stopIfCancelled();
      await inspect(sharp, path, kind);
      stopIfCancelled();
      const seconds = Math.max(1, Math.ceil((deadline - performance.now()) / 1000));
      return await render(sharp, path, seconds, deadlineMs);
    } finally {
      release();
    }
  })();
  const settled = work.then(() => undefined, () => undefined).finally(() => clearTimeout(timer));
  const picture = Promise.race([work, expired.promise]);
  void picture.catch(() => undefined);
  return { picture, settled };
}
