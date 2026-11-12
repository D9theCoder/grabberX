import { describe, expect, it } from "vitest";
import { buildCommand, formatCommand, parallelBlock, probeArgv, stepTargetDir, workerArgv, workerCount } from "@/lib/command";
import { DEFAULT_ADVANCED, type JobSpec, type Settings } from "@/lib/spec";

const ROOT = "D:/Photos/p/scrapper";

const settings: Pick<Settings, "mediaRoot" | "cookies"> = {
  mediaRoot: ROOT,
  cookies: { browser: "firefox" },
};

function makeSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    site: "x",
    account: "username",
    media: "images",
    layout: { kind: "byType" },
    simulate: false,
    advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" } },
    ...overrides,
  };
}

/** The reference commands in AGENTS.md, with gallery-dl's own retweets/replies defaults. */
function referenceSpec(overrides: Partial<JobSpec> = {}): JobSpec {
  return makeSpec({
    advanced: {
      ...DEFAULT_ADVANCED,
      cookies: { browser: "firefox" },
      retweets: false,
      replies: true,
    },
    ...overrides,
  });
}

function imagesArgv(spec: JobSpec): string[] {
  const [step] = buildCommand(spec, settings);
  return step.argv;
}

function directoryOf(argv: string[]): string[] {
  const value = argv.find((token) => token.startsWith("directory="));
  if (!value) throw new Error("no directory option");
  return JSON.parse(value.slice("directory=".length)) as string[];
}

describe("buildCommand: media", () => {
  const agentsImages = [
    "-o",
    'directory=["username","Image"]',
    "-o",
    "twitter.videos=false",
    "-o",
    "twitter.gifs=false",
    "--filter",
    "extension in ('jpg','jpeg','png','webp')",
    "--download-archive",
    `${ROOT}/username/archive.sqlite3`,
    "--cookies-from-browser",
    "firefox",
    "https://x.com/username/media",
  ];

  const agentsVideos = [
    "-o",
    'directory=["username","Video"]',
    "-o",
    "twitter.videos=true",
    "-o",
    "twitter.gifs=true",
    "--filter",
    "extension in ('mp4','webm','mov','m4v')",
    "--download-archive",
    `${ROOT}/username/archive.sqlite3`,
    "--cookies-from-browser",
    "firefox",
    "https://x.com/username/media",
  ];

  it("matches the AGENTS.md images command plus -d and --no-colors", () => {
    expect(buildCommand(referenceSpec({ media: "images" }), settings)).toEqual([
      {
        label: "images",
        argv: [
          "-d",
          ROOT,
          ...agentsImages.slice(0, 10),
          "--no-colors",
          ...agentsImages.slice(10),
        ],
      },
    ]);
  });

  it("matches the AGENTS.md videos command plus -d and --no-colors", () => {
    expect(buildCommand(referenceSpec({ media: "videos" }), settings)).toEqual([
      {
        label: "videos",
        argv: [
          "-d",
          ROOT,
          ...agentsVideos.slice(0, 10),
          "--no-colors",
          ...agentsVideos.slice(10),
        ],
      },
    ]);
  });

  it("runs images then videos for media all", () => {
    const steps = buildCommand(referenceSpec({ media: "all" }), settings);
    expect(steps.map((step) => step.label)).toEqual(["images", "videos"]);
    expect(steps[0].argv).toContain("twitter.videos=false");
    expect(steps[1].argv).toContain("twitter.videos=true");
  });

  it("puts the URL last for every step", () => {
    for (const step of buildCommand(referenceSpec({ media: "all" }), settings)) {
      expect(step.argv[step.argv.length - 1]).toBe("https://x.com/username/media");
    }
  });
});

describe("buildCommand: layout", () => {
  const cases: [JobSpec["layout"], string[], string[]][] = [
    [{ kind: "byType" }, ["username", "Image"], ["username", "Video"]],
    [
      { kind: "byTypeYear" },
      ["username", "Image", "{date:%Y}"],
      ["username", "Video"],
    ],
    [
      { kind: "byMonth" },
      ["username", "{date:%Y-%m}"],
      ["username", "{date:%Y-%m}"],
    ],
    [{ kind: "flat" }, ["username"], ["username"]],
    [
      { kind: "custom", template: ["{date:%Y}", "{tweet_id}"] },
      ["username", "{date:%Y}", "{tweet_id}"],
      ["username", "{date:%Y}", "{tweet_id}"],
    ],
  ];

  it.each(cases)("maps %o to a gallery-dl directory", (layout, images, videos) => {
    expect(directoryOf(imagesArgv(makeSpec({ layout })))).toEqual(images);
    expect(
      directoryOf(imagesArgv(makeSpec({ layout, media: "videos" }))),
    ).toEqual(videos);
  });

  it("uses the folder override for the directory and the archive", () => {
    const argv = imagesArgv(makeSpec({ folder: "renamed" }));
    expect(directoryOf(argv)).toEqual(["renamed", "Image"]);
    expect(argv).toContain(`${ROOT}/renamed/archive.sqlite3`);
    expect(argv[argv.length - 1]).toBe("https://x.com/username/media");
  });

  it("joins the archive path with / and trims trailing separators", () => {
    const forward = imagesArgv(makeSpec()).join(" ");
    expect(forward).toContain(`${ROOT}/username/archive.sqlite3`);

    const [step] = buildCommand(makeSpec(), {
      mediaRoot: "D:\\Photos\\p\\scrapper\\",
      cookies: { browser: "firefox" },
    });
    expect(step.argv[1]).toBe("D:\\Photos\\p\\scrapper");
    expect(step.argv).toContain("D:\\Photos\\p\\scrapper/username/archive.sqlite3");
  });

  it("keeps the slash of a drive root or a POSIX root", () => {
    const drive = buildCommand(makeSpec(), { mediaRoot: "D:\\", cookies: { browser: "firefox" } })[0];
    expect(drive.argv[1]).toBe("D:/");
    expect(drive.argv).toContain("D:/username/archive.sqlite3");

    const posix = buildCommand(makeSpec(), { mediaRoot: "/", cookies: { browser: "firefox" } })[0];
    expect(posix.argv[1]).toBe("/");
    expect(posix.argv).toContain("/username/archive.sqlite3");
  });
});

describe("buildCommand: options", () => {
  it("emits every advanced flag in order", () => {
    const spec = makeSpec({
      dateFrom: "2025-01-01",
      dateTo: "2025-12-31",
      simulate: true,
      advanced: {
        imageSize: "large",
        sleepRequest: 2,
        sleep: 1.5,
        sleep429: 30,
        retries: 8,
        limitRate: "2M",
        filesizeMin: "200k",
        filesizeMax: "5M",
        abortAfterSkipped: 20,
        range: 50,
        retweets: true,
        replies: false,
        writeMetadata: true,
        noSkip: true,
        cookies: { browser: "firefox", profile: "prof" },
        proxy: "socks5://127.0.0.1:1080",
      },
    });

    expect(imagesArgv(spec)).toEqual([
      "-d",
      ROOT,
      "-o",
      'directory=["username","Image"]',
      "-o",
      "twitter.videos=false",
      "-o",
      "twitter.gifs=false",
      "--filter",
      "extension in ('jpg','jpeg','png','webp')",
      "--download-archive",
      `${ROOT}/username/archive.sqlite3`,
      "-o",
      'twitter.size=["large"]',
      "-o",
      "twitter.retweets=true",
      "-o",
      "twitter.replies=false",
      "--date-after",
      "2025-01-01",
      "--date-before",
      "2026-01-01",
      "--sleep-request",
      "2",
      "--sleep",
      "1.5",
      "--sleep-429",
      "30",
      "-R",
      "8",
      "--limit-rate",
      "2M",
      "--filesize-min",
      "200k",
      "--filesize-max",
      "5M",
      "-A",
      "20",
      "--range",
      "1-50",
      "--write-metadata",
      "--no-skip",
      "--proxy",
      "socks5://127.0.0.1:1080",
      "--no-colors",
      "--cookies-from-browser",
      "firefox:prof",
      "--simulate",
      "https://x.com/username/media",
    ]);
  });

  it("omits flags that match the gallery-dl defaults", () => {
    const argv = imagesArgv(
      makeSpec({
        advanced: {
          ...DEFAULT_ADVANCED,
          cookies: { browser: "firefox" },
          retweets: false,
          replies: true,
          retries: 4,
          sleep: 0,
        },
      }),
    );
    expect(argv).not.toContain("twitter.retweets=true");
    expect(argv).not.toContain("twitter.replies=false");
    expect(argv).not.toContain("-R");
    expect(argv).not.toContain("--sleep");
  });

  it("emits twitter.replies=false only when replies are turned off", () => {
    const off = imagesArgv(
      makeSpec({ advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" }, replies: false } }),
    );
    expect(off).toContain("twitter.replies=false");
    expect(imagesArgv(makeSpec())).not.toContain("twitter.replies=false");
  });

  it("builds the AGENTS.md commands from the app defaults alone", () => {
    expect(imagesArgv(makeSpec())).toEqual(imagesArgv(referenceSpec()));
  });

  it("includes the whole 'To' day by sending the next day to --date-before", () => {
    const argv = imagesArgv(makeSpec({ dateTo: "2025-02-28" }));
    expect(argv[argv.indexOf("--date-before") + 1]).toBe("2025-03-01");
    const leap = imagesArgv(makeSpec({ dateTo: "2024-12-31" }));
    expect(leap[leap.indexOf("--date-before") + 1]).toBe("2025-01-01");
  });

  it("emits twitter.retweets=true when retweets are wanted", () => {
    const spec = makeSpec({
      advanced: {
        ...DEFAULT_ADVANCED,
        cookies: { browser: "firefox" },
        retweets: true,
        replies: true,
      },
    });
    expect(imagesArgv(spec)).toContain("twitter.retweets=true");
  });

  it("only sends a size option when it is not orig", () => {
    expect(imagesArgv(makeSpec()).join(" ")).not.toContain("twitter.size");
    const large = makeSpec({
      advanced: {
        ...DEFAULT_ADVANCED,
        cookies: { browser: "firefox" },
        imageSize: "large",
      },
    });
    expect(imagesArgv(large)).toContain('twitter.size=["large"]');
  });

  it("drops the cookies flag when the browser is none", () => {
    const spec = makeSpec({
      advanced: {
        ...DEFAULT_ADVANCED,
        cookies: { browser: "none" },
        replies: true,
      },
    });
    expect(imagesArgv(spec)).not.toContain("--cookies-from-browser");
  });

  it("lets the spec cookies win over the settings cookies", () => {
    const [step] = buildCommand(
      makeSpec({
        advanced: {
          ...DEFAULT_ADVANCED,
          cookies: { browser: "firefox", profile: "work" },
          replies: true,
        },
      }),
      { mediaRoot: ROOT, cookies: { browser: "edge" } },
    );
    expect(step.argv).toContain("firefox:work");
    expect(step.argv).not.toContain("edge");
  });
});

describe("buildCommand: other sites", () => {
  it("uses the pasted URL for site url and derives a folder from it", () => {
    const spec = makeSpec({
      site: "url",
      account: "https://example.com/gallery/abc",
      media: "images",
    });
    const argv = imagesArgv(spec);
    expect(argv[argv.length - 1]).toBe("https://example.com/gallery/abc");
    expect(directoryOf(argv)).toEqual(["example.com_abc", "Image"]);
    expect(argv).toContain(`${ROOT}/example.com_abc/archive.sqlite3`);
    expect(argv.join(" ")).not.toContain("twitter.");
  });

  it("uses the instagram profile URL", () => {
    const argv = imagesArgv(makeSpec({ site: "instagram", account: "someone" }));
    expect(argv[argv.length - 1]).toBe("https://www.instagram.com/someone/");
  });

  it("does not send twitter-only options to other sites", () => {
    const spec = makeSpec({
      site: "reddit",
      account: "someone",
      advanced: {
        ...DEFAULT_ADVANCED,
        cookies: { browser: "firefox" },
        retweets: true,
        replies: true,
        imageSize: "large",
      },
    });
    const flat = imagesArgv(spec).join(" ");
    expect(flat).not.toContain("twitter.");
  });
});

describe("formatCommand", () => {
  it("prints one flag per line with backtick continuations", () => {
    expect(
      formatCommand(buildCommand(referenceSpec(), settings)[0].argv),
    ).toBe(
      [
        "gallery-dl `",
        "  -d D:/Photos/p/scrapper `",
        "  -o 'directory=[\"username\",\"Image\"]' `",
        "  -o twitter.videos=false `",
        "  -o twitter.gifs=false `",
        "  --filter \"extension in ('jpg','jpeg','png','webp')\" `",
        "  --download-archive D:/Photos/p/scrapper/username/archive.sqlite3 `",
        "  --no-colors `",
        "  --cookies-from-browser firefox `",
        '  "https://x.com/username/media"',
      ].join("\n"),
    );
  });

  it("keeps a switch on its own line instead of gluing the next argument to it", () => {
    const text = formatCommand(["--simulate", "https://x.com/username/media"]);
    expect(text.split(/\r?\n/)).toEqual(["gallery-dl `", "  --simulate `", '  "https://x.com/username/media"']);
  });

  it("keeps a single token on one line", () => {
    expect(formatCommand(["--version"], "C:\\tools\\gallery-dl.exe")).toBe(
      "C:\\tools\\gallery-dl.exe `\n  --version",
    );
  });

  it("doubles single quotes when double quotes would expand", () => {
    expect(formatCommand(["--filter", "a'b$c"], "gallery-dl")).toBe(
      "gallery-dl `\n  --filter 'a''b$c'",
    );
  });

  it("quotes values with spaces and leaves plain values bare", () => {
    expect(formatCommand(["-d", "D:/a b", "--range", "1-10"])).toBe(
      "gallery-dl `\n  -d 'D:/a b' `\n  --range 1-10",
    );
  });

  it("leaves flag-only lines alone", () => {
    expect(formatCommand(["--no-skip", "--write-metadata"])).toBe(
      "gallery-dl `\n  --no-skip `\n  --write-metadata",
    );
  });

  it("returns just the exe for an empty argv", () => {
    expect(formatCommand([])).toBe("gallery-dl");
  });
});

describe("parallel downloads", () => {
  const bluesky = (advanced: Partial<JobSpec["advanced"]> = {}, overrides: Partial<JobSpec> = {}) =>
    makeSpec({
      site: "bluesky",
      account: "name.bsky.social",
      media: "all",
      advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" }, parallel: 4, ...advanced },
      ...overrides,
    });

  it("gives each step one argv per worker, each with its slice and its own part folder", () => {
    const steps = buildCommand(bluesky(), settings);
    expect(steps.map((step) => step.workers?.length)).toEqual([4, 4]);
    const [first, , , fourth] = steps[0]!.workers!;
    const base = steps[0]!.argv;
    expect(first!.at(-1)).toBe(base.at(-1));
    expect(first).toEqual([
      ...base.slice(0, -1),
      "--range",
      "1::4",
      "-o",
      `downloader.part-directory="${ROOT}/name.bsky.social/.gather-parts/w1"`,
      base.at(-1),
    ]);
    expect(fourth).toContain("4::4");
    expect(steps[1]!.workers![1]).toContain(`downloader.part-directory="${ROOT}/name.bsky.social/.gather-parts/w2"`);
  });

  it("keeps the single-process argv unchanged", () => {
    const single = buildCommand(bluesky({ parallel: undefined }), settings);
    const parallel = buildCommand(bluesky(), settings);
    expect(parallel.map((step) => step.argv)).toEqual(single.map((step) => step.argv));
    expect(single[0]!.workers).toBeUndefined();
  });

  it("slices only the newest files when a limit is set", () => {
    const [step] = buildCommand(bluesky({ range: 100, parallel: 3 }), settings);
    expect(step!.argv).toContain("1-100");
    expect(step!.workers!.map((argv) => argv[argv.indexOf("--range") + 1])).toEqual(["1:101:3", "2:101:3", "3:101:3"]);
    for (const argv of step!.workers!) expect(argv.filter((token) => token === "--range")).toHaveLength(1);
  });

  it("refuses sites that limit requests and layouts that create folders mid-run", () => {
    expect(parallelBlock({ site: "x", account: "username", layout: { kind: "byType" } })).toMatch(/limits requests/);
    expect(parallelBlock({ site: "bluesky", account: "name.bsky.social", layout: { kind: "byTypeYear" } })).toMatch(/By type or Flat/);
    expect(parallelBlock({ site: "url", account: "https://example.com/gallery", layout: { kind: "flat" } })).toBeNull();
    expect(parallelBlock({ site: "url", account: "https://bsky.app/profile/name", layout: { kind: "flat" } })).toBeNull();
    expect(workerCount(makeSpec({ advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" }, parallel: 4 } }))).toBe(1);
    expect(workerCount(bluesky({}, { layout: { kind: "byMonth" } }))).toBe(1);
    expect(buildCommand(bluesky({}, { layout: { kind: "byMonth" } }), settings)[0]!.workers).toBeUndefined();
  });

  it("keeps the rate limit of a named site pasted as another URL", () => {
    for (const url of ["https://x.com/username/media", "https://www.instagram.com/username/", "https://old.reddit.com/user/username"]) {
      expect(parallelBlock({ site: "url", account: url, layout: { kind: "flat" } }), url).toMatch(/limits requests/);
    }
    const spec = makeSpec({
      site: "url",
      account: "https://x.com/username/media",
      layout: { kind: "flat" },
      advanced: { ...DEFAULT_ADVANCED, cookies: { browser: "firefox" }, parallel: 4 },
    });
    expect(workerCount(spec)).toBe(1);
  });

  it("slices any first-last range and refuses one it cannot split", () => {
    const url = "https://example.com/a";
    const sliceOf = (range: string, index: number) => {
      const argv = workerArgv(["--range", range, "--filter", "True", url], index, 2, `${ROOT}/a/.gather-parts/w${index}`);
      return argv[argv.indexOf("--range") + 1];
    };
    expect([sliceOf("5-20", 1), sliceOf("5-20", 2)]).toEqual(["5:21:2", "6:21:2"]);
    expect(sliceOf("3-", 2)).toBe("4::2");
    expect(() => workerArgv(["--range", "1:10", url], 1, 2, `${ROOT}/a/.gather-parts/w1`)).toThrow(/cannot split/);
  });

  it("adds a pass-everything filter to a step without one", () => {
    const argv = workerArgv(["-d", ROOT, "https://example.com/a"], 2, 2, `${ROOT}/a/.gather-parts/w2`);
    expect(argv).toEqual([
      "-d",
      ROOT,
      "--filter",
      "True",
      "--range",
      "2::2",
      "-o",
      `downloader.part-directory="${ROOT}/a/.gather-parts/w2"`,
      "https://example.com/a",
    ]);
  });

  it("names the folder to create before the workers start", () => {
    expect(stepTargetDir(bluesky(), settings, "videos")).toBe(`${ROOT}/name.bsky.social/Video`);
    expect(stepTargetDir(bluesky({}, { layout: { kind: "flat" } }), settings, "images")).toBe(`${ROOT}/name.bsky.social`);
  });
});

describe("probeArgv", () => {
  it("asks for one item, from the page a run downloads", () => {
    expect(probeArgv(makeSpec({ media: "all" }), settings).at(-1)).toBe("https://x.com/username/media");
    expect(probeArgv(makeSpec(), settings).slice(0, 3)).toEqual(["-j", "--range", "1"]);
  });
});
