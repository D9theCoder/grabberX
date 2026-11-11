import Link from "next/link";
import { Fragment } from "react";

export interface Crumb {
  label: string;
  href: string;
}

/** Where you are in the library. Every crumb but the last is a link; the last carries `aria-current`. */
export function Breadcrumb({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-small text-ink-2">
      <ol className="m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-1 p-0">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <Fragment key={item.href}>
              {index > 0 ? (
                <li aria-hidden="true" className="text-ink-3">
                  /
                </li>
              ) : null}
              <li className={last ? "font-mono text-code text-ink" : "font-mono text-code"}>
                {last ? (
                  <span aria-current="page">{item.label}</span>
                ) : (
                  <Link
                    href={item.href}
                    className="rounded-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors duration-120 hover:text-ink"
                  >
                    {item.label}
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
