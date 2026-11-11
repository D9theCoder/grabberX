import { describe, expect, it } from "vitest";
import { maskSecrets } from "@/lib/mask";

describe("maskSecrets", () => {
  it("hides the value after known cookie names", () => {
    expect(maskSecrets("values auth_token=abc123def and csrftoken=zzz999")).toBe(
      "values auth_token=•••• and csrftoken=••••",
    );
  });

  it("is case-insensitive on the name", () => {
    expect(maskSecrets("Auth_Token=secret")).toBe("Auth_Token=••••");
  });

  it("leaves other text alone", () => {
    expect(maskSecrets("[twitter][info] saved 3 files")).toBe("[twitter][info] saved 3 files");
  });

  it("does not touch names that merely contain the word", () => {
    expect(maskSecrets("not_auth_token=keep")).toBe("not_auth_token=keep");
  });

  it("stops the cookie value at a query separator", () => {
    expect(maskSecrets("sessionid=abc&x=1")).toBe("sessionid=••••&x=1");
  });

  describe("URL credentials", () => {
    it("keeps the user name and hides the password", () => {
      expect(maskSecrets("proxy http://user:hunter2@127.0.0.1:8080/api")).toBe(
        "proxy http://user:••••@127.0.0.1:8080/api",
      );
    });

    it("hides a password that itself contains a colon", () => {
      expect(maskSecrets("https://user:a:b@host/x")).toBe("https://user:••••@host/x");
    });

    it("hides a bare token used as the whole user info", () => {
      expect(maskSecrets("socks5h://abcdef123@host:1080")).toBe("socks5h://••••@host:1080");
    });

    it("works for any scheme and keeps its case", () => {
      expect(maskSecrets("SOCKS5://token@h")).toBe("SOCKS5://••••@h");
      expect(maskSecrets("ftp://u:p@h/f")).toBe("ftp://u:••••@h/f");
    });

    it("masks every credential URL on one line", () => {
      expect(maskSecrets("http://a:b@h1 and http://c:d@h2")).toBe("http://a:••••@h1 and http://c:••••@h2");
    });

    it("hides a password that contains an @", () => {
      expect(maskSecrets("proxy http://user:p@ss@host:8080/x")).toBe("proxy http://user:••••@host:8080/x");
    });

    it("leaves an @ later in the path, query or fragment alone", () => {
      const url = "https://example.com/path?email=a@b.c&x=1#@frag";
      expect(maskSecrets(url)).toBe(url);
    });

    it("leaves a plain email alone", () => {
      expect(maskSecrets("contact a@b.c for details")).toBe("contact a@b.c for details");
    });
  });

  describe("header values", () => {
    it("masks a Cookie header", () => {
      expect(maskSecrets("Cookie: auth_token=x; ct0=y")).toBe("Cookie: ••••");
    });

    it("masks Set-Cookie and Authorization headers", () => {
      expect(maskSecrets("Set-Cookie: session=abc; Path=/")).toBe("Set-Cookie: ••••");
      expect(maskSecrets("Authorization: Bearer abc.def")).toBe("Authorization: ••••");
    });

    it("keeps the text before the header", () => {
      expect(maskSecrets("[twitter][error] Authorization: Bearer abc")).toBe(
        "[twitter][error] Authorization: ••••",
      );
    });

    it("masks a quoted key from a dumped dict", () => {
      expect(maskSecrets("{'Cookie': 'a=b', 'Host': 'x'}")).toBe("{'Cookie': ••••");
    });

    it("does not swallow the next line", () => {
      expect(maskSecrets("Cookie: a=b\n[twitter][info] saved 3 files")).toBe(
        "Cookie: ••••\n[twitter][info] saved 3 files",
      );
    });

    it("does not touch a sentence that merely mentions cookies", () => {
      const line = "[cookies][info] Extracted 129 cookies from Firefox";
      expect(maskSecrets(line)).toBe(line);
    });
  });
});
