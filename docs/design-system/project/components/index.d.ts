import type * as React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary: once per view (Download). secondary: the alternative. ghost: low weight. danger: Stop / Cancel. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  /** Shows a spinner before the label and disables the button; width stays the same. */
  loading?: boolean;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label: string;
  hint?: React.ReactNode;
  /** Replaces the hint and turns the border danger. */
  error?: string;
  /** Fixed text before the input, e.g. "@". */
  prefix?: string;
  /** Use the mono family (handles, paths, sizes like 2M). */
  mono?: boolean;
}
export declare function TextField(props: TextFieldProps): React.ReactElement;

export interface SegmentedOption { value: string; label: string; tag?: string; disabled?: boolean }
export interface SegmentedProps {
  /** Accessible name of the group. */
  label: string;
  options: Array<SegmentedOption | string>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  size?: 'md' | 'sm';
}
export declare function Segmented(props: SegmentedProps): React.ReactElement;

export interface ChoiceOption { value: string; label: string; detail?: string }
export interface ChoiceListProps {
  legend?: string;
  options: ChoiceOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}
export declare function ChoiceList(props: ChoiceListProps): React.ReactElement;

export interface SwitchProps {
  label: string;
  hint?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
}
export declare function Switch(props: SwitchProps): React.ReactElement;

export interface DisclosureProps {
  title: string;
  /** Quiet text after the title, e.g. "2 changed". */
  meta?: string;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}
export declare function Disclosure(props: DisclosureProps): React.ReactElement;

export interface CommandStep { label: string; command: string }
export interface CommandBlockProps {
  /** One command… */
  command?: string;
  label?: string;
  /** …or several steps (Media = All runs images, then videos). */
  steps?: CommandStep[];
  onCopy?: (command: string) => void;
}
export declare function CommandBlock(props: CommandBlockProps): React.ReactElement;

export interface StatusProps {
  state: 'queued' | 'running' | 'stopping' | 'done' | 'failed' | 'stopped' | 'interrupted';
  /** Quiet detail after the word, e.g. "username · 02:14". */
  children?: React.ReactNode;
}
export declare function Status(props: StatusProps): React.ReactElement;

export interface StatProps {
  value: number | string;
  label: string;
  tone?: 'default' | 'muted' | 'danger';
}
export declare function Stat(props: StatProps): React.ReactElement;

export interface LogLine { text: string; level?: 'info' | 'skip' | 'warning' | 'error' }
export interface LogViewProps {
  /** Strings are classified: "# " = skip, "[x][warning]" = warning, "[x][error]" = error. */
  lines: Array<LogLine | string>;
  maxLines?: number;
  maxHeight?: number | string;
  label?: string;
}
export declare function LogView(props: LogViewProps): React.ReactElement;

export interface NoticeProps {
  tone?: 'info' | 'warning' | 'danger';
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}
export declare function Notice(props: NoticeProps): React.ReactElement;

export interface BreadcrumbProps { items: Array<{ label: string; href?: string }>; }
export declare function Breadcrumb(props: BreadcrumbProps): React.ReactElement;

export interface FolderCardProps { name: string; href?: string; }
export declare function FolderCard(props: FolderCardProps): React.ReactElement;

export interface ThumbnailProps {
  /** The file name; it is the button's accessible name. */
  name: string;
  width?: number;
  height?: number;
  kind?: 'image' | 'video';
  duration?: string;
  active?: boolean;
  /** Select mode: shows the check box and sets aria-pressed. */
  selectable?: boolean;
  selected?: boolean;
}
export declare function Thumbnail(props: ThumbnailProps): React.ReactElement;

export interface ToolbarAction { label: string; icon: string; pressed?: boolean; disabled?: boolean; }
export interface ToolbarProps { label: string; actions: ToolbarAction[]; }
export declare function Toolbar(props: ToolbarProps): React.ReactElement;

export interface LightboxProps {
  name: string;
  position: number;
  total: number;
  actions?: ToolbarAction[];
}
export declare function Lightbox(props: LightboxProps): React.ReactElement;

export interface ThemeToggleProps {
  theme?: 'light' | 'dark';
  defaultTheme?: 'light' | 'dark';
  onChange?: (theme: 'light' | 'dark') => void;
}
export declare function ThemeToggle(props: ThemeToggleProps): React.ReactElement;

export interface ContextMenuItem { label: string; icon?: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect?: () => void }
export interface ContextMenuProps {
  label: string;
  /** "-" draws a separator. */
  items: Array<ContextMenuItem | '-'>;
}
export declare function ContextMenu(props: ContextMenuProps): React.ReactElement;

export interface SelectionBarProps {
  count: number;
  onSelectAll?: () => void;
  onClear?: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
  onDone?: () => void;
}
export declare function SelectionBar(props: SelectionBarProps): React.ReactElement;

declare global {
  interface Window {
    Gather: {
      Button: typeof Button; TextField: typeof TextField; Segmented: typeof Segmented; ChoiceList: typeof ChoiceList;
      Switch: typeof Switch; Disclosure: typeof Disclosure; CommandBlock: typeof CommandBlock; Status: typeof Status;
      Stat: typeof Stat; LogView: typeof LogView; Notice: typeof Notice;
      Breadcrumb: typeof Breadcrumb; FolderCard: typeof FolderCard; Thumbnail: typeof Thumbnail;
      Toolbar: typeof Toolbar; Lightbox: typeof Lightbox;
      ThemeToggle: typeof ThemeToggle; ContextMenu: typeof ContextMenu; SelectionBar: typeof SelectionBar;
    };
  }
}
