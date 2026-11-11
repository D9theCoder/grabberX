import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAllowedHost } from "@/server/hosts";

/**
 * DNS-rebinding guard: a page on another domain must not reach this app through a mapped
 * hostname.
 */
export function proxy(request: NextRequest): Response {
  if (!isAllowedHost(request.headers.get("host"))) {
    return new NextResponse("gather only answers on 127.0.0.1:3210.\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}
