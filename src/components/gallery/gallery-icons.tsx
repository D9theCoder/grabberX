import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function createIcon(path: string) {
  return function Icon(props: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        <path d={path} />
      </svg>
    );
  };
}

export const TrashIcon = createIcon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3");
export const ExpandIcon = createIcon("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5");
export const PrevIcon = createIcon("M15 6l-6 6 6 6");
export const NextIcon = createIcon("M9 6l6 6-6 6");
export const LoopIcon = createIcon("M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4");
export const AutoplayIcon = createIcon("M8 5.5v13l10-6.5zM3 5v14");
