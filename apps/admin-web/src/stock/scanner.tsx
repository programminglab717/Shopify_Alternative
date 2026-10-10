import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';

/** The browser's barcode reader, where it has one: Chrome on Android does, Safari does not. */
interface BarcodeReader {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type BarcodeReaderClass = new (options?: { formats?: string[] }) => BarcodeReader;

/** Barcodes on goods and the shop's own labels: EAN and UPC, Code 128 and 39, QR. */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

/** How often a frame is read: often enough to feel at once, rarely enough for an old phone. */
const EVERY_MS = 250;

/** In a count, the wait after a code is read, for the box to be put down and the next held up. */
const BETWEEN_MS = 1500;

function readerClass(): BarcodeReaderClass | null {
  const found = (globalThis as { BarcodeDetector?: BarcodeReaderClass }).BarcodeDetector;
  return found && typeof navigator !== 'undefined' && navigator.mediaDevices ? found : null;
}

/** Whether this browser can read a barcode through the camera. */
export function canScan(): boolean {
  return readerClass() !== null;
}

/**
 * The back camera, read until a barcode is seen; then the camera is let go and the code given to
 * `onCode`, or, `continuous`, kept reading for the next after a pause. Refused or missing, it says
 * so, and a code can still be typed.
 */
export function Scanner({
  onCode,
  onClose,
  continuous = false,
}: {
  onCode: (code: string) => void;
  onClose: () => void;
  continuous?: boolean;
}) {
  const { t } = useLocale();
  const video = useRef<HTMLVideoElement>(null);
  const [refused, setRefused] = useState(false);
  const done = useRef(onCode);
  done.current = onCode;

  useEffect(() => {
    const Reader = readerClass();
    if (!Reader) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
    const reader = new Reader({ formats: FORMATS });
    const look = async () => {
      if (stopped || !video.current) return;
      try {
        const [first] = await reader.detect(video.current);
        if (first?.rawValue && !stopped) {
          if (!continuous) stop();
          done.current(first.rawValue.trim());
          if (continuous) timer = setTimeout(() => void look(), BETWEEN_MS);
          return;
        }
      } catch {
        // A frame not ready yet; the next one is read.
      }
      if (!stopped) timer = setTimeout(() => void look(), EVERY_MS);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (opened) => {
        stream = opened;
        if (stopped) return stop();
        if (video.current) {
          video.current.srcObject = opened;
          await video.current.play?.();
        }
        void look();
      })
      .catch(() => {
        if (!stopped) setRefused(true);
      });
    return stop;
  }, [continuous]);

  return (
    <div className="flex flex-col gap-2">
      {refused ? (
        <Alert tone="danger">{t('stock.cameraRefused')}</Alert>
      ) : (
        <>
          <video
            ref={video}
            muted
            playsInline
            aria-label={t('stock.scanning')}
            className="aspect-video w-full rounded-card bg-black object-cover"
          />
          <p className="text-secondary">{t('stock.scanning')}</p>
        </>
      )}
      <Button variant="tertiary" className="self-start" onClick={onClose}>
        {t('stock.scanStop')}
      </Button>
    </div>
  );
}
