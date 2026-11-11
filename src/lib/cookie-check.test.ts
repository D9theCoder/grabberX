import { describe, expect, it } from "vitest";
import {
  browserLabel,
  classifyCookieCheck,
  cookieNotice,
  cookieSiteLabel,
} from "@/lib/cookie-check";
import type { CookieCheckOutput } from "@/lib/cookie-check";

/**
 * These strings are copied from gallery-dl 1.32.19 on Windows. The paths in the locked-database
 * sample are shortened; the classifier only reads the words around them.
 */
const OK = [
  "[cookies][info] Extracted 129 cookies from Firefox",
  "[twitter][info] Initializing client transaction keys",
  "[twitter][info] No results for https://x.com/example_user/media",
].join("\n");

const SIGNED_OUT = [
  "[cookies][info] Extracted 99 cookies from Firefox",
  "[twitter][error] AuthRequired: authenticated cookies needed to access this timeline",
].join("\n");

const LOCKED = [
  "[twitter][warning] cookies: [Errno 13] Permission denied: 'C:\\\\Users\\\\username\\\\AppData\\\\Local\\\\Temp\\\\profile\\\\cookies.sqlite'",
  "[twitter][error] AuthRequired: authenticated cookies needed to access this timeline",
].join("\n");

const NO_PROFILE = [
  "[twitter][warning] cookies: Unable to find Firefox cookies database",
  "[twitter][info] Requesting guest token",
  "[twitter][error] AuthRequired: authenticated cookies needed to access this timeline",
].join("\n");

const DECRYPT_FAILED = [
  "[cookies][warning] Failed to decrypt cookie (DPAPI)",
  "[twitter][warning] cookies: 'NoneType' object has no attribute 'decode'",
  "[twitter][error] AuthRequired: authenticated cookies needed to access this timeline",
].join("\n");

const CORRUPT = [
  "[twitter][warning] cookies: file is not a database",
  "[twitter][error] AuthRequired: authenticated cookies needed to access this timeline",
].join("\n");

function result(overrides: Partial<CookieCheckOutput> = {}): CookieCheckOutput {
  return { code: 0, output: "", timedOut: false, ...overrides };
}

describe("classifyCookieCheck", () => {
  it("reads a successful probe", () => {
    expect(classifyCookieCheck(result({ code: 0, output: OK }))).toBe("ok");
  });

  it("reads a signed-out session", () => {
    expect(classifyCookieCheck(result({ code: 16, output: SIGNED_OUT }))).toBe("signedOut");
  });

  it("calls a locked cookie database unreadable, even though gallery-dl also says the cookies are missing", () => {
    expect(classifyCookieCheck(result({ code: 16, output: LOCKED }))).toBe("unreadable");
  });

  it("calls a missing profile unreadable", () => {
    expect(classifyCookieCheck(result({ code: 16, output: NO_PROFILE }))).toBe("unreadable");
  });

  it("calls a cookie it cannot decrypt unreadable", () => {
    expect(classifyCookieCheck(result({ code: 16, output: DECRYPT_FAILED }))).toBe("unreadable");
  });

  it("calls a corrupt cookie database unreadable", () => {
    expect(classifyCookieCheck(result({ code: 16, output: CORRUPT }))).toBe("unreadable");
  });

  it("stays quiet about a missing exe and a timeout", () => {
    expect(classifyCookieCheck(result({ code: null, spawnError: "ENOENT" }))).toBe("unknown");
    expect(classifyCookieCheck(result({ code: 16, timedOut: true }))).toBe("unknown");
  });

  it("stays quiet about an unexplained failure", () => {
    expect(classifyCookieCheck(result({ code: 1, output: "something else" }))).toBe("unknown");
  });

  it("does not read a file name with a status code in it as a sign-in problem", () => {
    expect(classifyCookieCheck(result({ code: 0, output: "username/Image/1403_1.jpg" }))).toBe("ok");
  });
});

describe("cookieNotice", () => {
  it("names the browser and the site", () => {
    expect(cookieNotice("signedOut", { browser: "Firefox", site: "x.com" })).toBe(
      "Firefox cookies for x.com look signed out. Sign in to x.com in Firefox, then try again.",
    );
    expect(cookieNotice("unreadable", { browser: "Chrome", site: "x.com" })).toBe(
      "gather can't read Chrome's cookies. Close Chrome, or pick another browser in Settings.",
    );
  });

  it("says nothing when the check passed or could not decide", () => {
    expect(cookieNotice("ok", { browser: "Firefox", site: "x.com" })).toBeNull();
    expect(cookieNotice("skipped", { browser: "Firefox", site: "x.com" })).toBeNull();
    expect(cookieNotice("unknown", { browser: "Firefox", site: "x.com" })).toBeNull();
  });
});

describe("labels", () => {
  it("title-cases the browser name", () => {
    expect(browserLabel("firefox")).toBe("Firefox");
    expect(browserLabel("chrome")).toBe("Chrome");
    expect(browserLabel("edge")).toBe("Edge");
    expect(browserLabel("none")).toBe("no browser");
  });

  it("uses x.com for X and the site's own label elsewhere", () => {
    expect(cookieSiteLabel("x")).toBe("x.com");
    expect(cookieSiteLabel("instagram")).toBe("Instagram");
  });
});
