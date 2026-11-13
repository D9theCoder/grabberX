import { describe, expect, it } from "vitest";
import {
  clampZoomScale,
  clampZoomView,
  doubleTapScale,
  FIT_VIEW,
  MAX_ZOOM_SCALE,
  panZoomView,
  pinchZoomAt,
  zoomAt,
} from "./zoom";

const bounds = {
  stageWidth: 400,
  stageHeight: 600,
  mediaWidth: 400,
  mediaHeight: 300,
};

describe("gallery zoom helpers", () => {
  it("clamps scale within [1, MAX_ZOOM_SCALE] and snaps <= 1 to FIT_VIEW", () => {
    expect(clampZoomScale(0.5)).toBe(1);
    expect(clampZoomScale(Number.NaN)).toBe(1);
    expect(clampZoomScale(32)).toBe(MAX_ZOOM_SCALE);
    expect(zoomAt(FIT_VIEW, 0.8, 40, -20, bounds)).toEqual(FIT_VIEW);
  });

  it("keeps the focal point fixed and clamps pan to the zoomed media overflow", () => {
    const zoomed = zoomAt(FIT_VIEW, 2, 100, 0, bounds);
    // At 2x on a 400x300 media in 400x600 stage:
    // mediaW*2 = 800 => maxX = (800-400)/2 = 200; mediaH*2 = 600 => maxY = 0
    expect(zoomed.scale).toBe(2);
    expect(zoomed.x).toBe(-100);
    expect(zoomed.y).toBe(0);

    const panned = panZoomView(zoomed, -500, 200, bounds);
    expect(panned).toEqual({ scale: 2, x: -200, y: 0 });
  });

  it("supports simultaneous pinch scale and two-finger pan", () => {
    const view = pinchZoomAt(FIT_VIEW, 100, 0, 0, 300, 50, 0, bounds);
    expect(view.scale).toBe(3);
    // 3x mediaW=1200 => maxX=(1200-400)/2=400; x=50-(0-0)*3=50
    expect(view.x).toBe(50);
    expect(view.y).toBe(0);
  });

  it("clamps scale-down pan back inside bounds", () => {
    const start = { scale: 4, x: 550, y: 250 };
    const shrunk = clampZoomView({ ...start, scale: 2 }, bounds);
    expect(shrunk).toEqual({ scale: 2, x: 200, y: 0 });
  });

  it("picks 1:1 native pixel scale when larger than rendered size, or fallbackScale otherwise", () => {
    expect(doubleTapScale(1920, 480)).toBe(4);
    expect(doubleTapScale(400, 400)).toBe(2.5);
    expect(doubleTapScale(0, 400)).toBe(2.5);
  });
});
