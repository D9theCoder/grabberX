export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export interface ZoomBounds {
  stageWidth: number;
  stageHeight: number;
  mediaWidth: number;
  mediaHeight: number;
}

export const FIT_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };
export const MAX_ZOOM_SCALE = 16;

export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM_SCALE, Math.max(1, scale));
}

export function clampZoomView(view: ZoomView, bounds?: ZoomBounds | null): ZoomView {
  const scale = clampZoomScale(view.scale);
  if (scale <= 1.001) return FIT_VIEW;
  let { x, y } = view;
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  if (bounds && bounds.stageWidth > 0 && bounds.mediaWidth > 0) {
    const maxX = Math.max(0, (bounds.mediaWidth * scale - bounds.stageWidth) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
  }
  if (bounds && bounds.stageHeight > 0 && bounds.mediaHeight > 0) {
    const maxY = Math.max(0, (bounds.mediaHeight * scale - bounds.stageHeight) / 2);
    y = Math.min(maxY, Math.max(-maxY, y));
  }
  return { scale, x, y };
}

/** Zooms around a point relative to the stage center so the pixel under the cursor stays put. */
export function zoomAt(view: ZoomView, nextScale: number, px: number, py: number, bounds?: ZoomBounds | null): ZoomView {
  const scale = clampZoomScale(nextScale);
  if (scale <= 1.001) return FIT_VIEW;
  const ratio = scale / Math.max(1, view.scale);
  return clampZoomView(
    {
      scale,
      x: px - (px - view.x) * ratio,
      y: py - (py - view.y) * ratio,
    },
    bounds,
  );
}

/** Scales and pans continuously around a moving two-finger pinch midpoint. */
export function pinchZoomAt(
  startView: ZoomView,
  startDistance: number,
  startPx: number,
  startPy: number,
  currentDistance: number,
  currentPx: number,
  currentPy: number,
  bounds?: ZoomBounds | null,
): ZoomView {
  const scale = clampZoomScale(startView.scale * (currentDistance / Math.max(1, startDistance)));
  if (scale <= 1.001) return FIT_VIEW;
  const ratio = scale / Math.max(1, startView.scale);
  return clampZoomView(
    {
      scale,
      x: currentPx - (startPx - startView.x) * ratio,
      y: currentPy - (startPy - startView.y) * ratio,
    },
    bounds,
  );
}

export function panZoomView(view: ZoomView, dx: number, dy: number, bounds?: ZoomBounds | null): ZoomView {
  if (view.scale <= 1.001) return FIT_VIEW;
  return clampZoomView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, bounds);
}

export function doubleTapScale(intrinsicWidth: number, renderedWidth: number, fallbackScale = 2.5): number {
  if (intrinsicWidth > 0 && renderedWidth > 0) {
    const actual = intrinsicWidth / renderedWidth;
    if (actual > 1.15) return clampZoomScale(actual);
  }
  return clampZoomScale(fallbackScale);
}

export function mediaBoundsOf(stage: HTMLElement | null, media: HTMLElement | null): ZoomBounds | null {
  if (!stage || !media) return null;
  return {
    stageWidth: stage.clientWidth,
    stageHeight: stage.clientHeight,
    mediaWidth: media.clientWidth,
    mediaHeight: media.clientHeight,
  };
}
