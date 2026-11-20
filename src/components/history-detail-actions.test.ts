import { describe, expect, it } from "vitest";
import { extractFailedUrls } from "@/components/history-detail-actions";

describe("extractFailedUrls", () => {
  it("extracts unique URLs only from error/warning lines", () => {
    const lines = [
      "username/Image/1_1.jpg",
      "[twitter][info] https://x.com/alice/media",
      "[twitter][error] HTTP 404 Not Found: https://pbs.twimg.com/media/abc.jpg.",
      "[twitter][warning] failed to download https://pbs.twimg.com/media/abc.jpg",
      "[urllib3][error] Connection failed for https://video.twimg.com/ext_tw_video/123.mp4,",
    ];
    expect(extractFailedUrls(lines)).toEqual([
      "https://pbs.twimg.com/media/abc.jpg",
      "https://video.twimg.com/ext_tw_video/123.mp4",
    ]);
  });
});
