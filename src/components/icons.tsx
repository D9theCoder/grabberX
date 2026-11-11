import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number };

function createIcon(path: string) {
  return function Icon({ strokeWidth = 1.75, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        <path d={path} />
      </svg>
    );
  };
}

export const CheckIcon = createIcon("M5 12.5l4.5 4.5L19 7.5");
export const CrossIcon = createIcon("M6 6l12 12M18 6L6 18");
export const ChevronIcon = createIcon("M9 6l6 6-6 6");
export const CopyIcon = createIcon("M9 9h10v10H9zM5 15V5h10");
export const FolderIcon = createIcon(
  "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
);
export const ClockIcon = createIcon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2");
export const AlertIcon = createIcon("M12 3l9.5 17h-19zM12 10v4M12 17.5v.5");
export const InfoIcon = createIcon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5");
export const StopIcon = createIcon("M7 7h10v10H7z");
export const PlayIcon = createIcon("M8 5.5v13l10-6.5z");
export const ExternalIcon = createIcon("M14 4h6v6M20 4l-9 9M18 14v5H5V6h5");
export const GearIcon = createIcon(
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
);
export const MoreIcon = createIcon("M5 12h.01M12 12h.01M19 12h.01");
