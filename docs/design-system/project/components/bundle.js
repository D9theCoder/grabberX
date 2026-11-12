/* @ds-bundle: {"format":4,"namespace":"grabberX","components":[{"name":"Button"},{"name":"TextField"},{"name":"Segmented"},{"name":"ChoiceList"},{"name":"Switch"},{"name":"Disclosure"},{"name":"CommandBlock"},{"name":"Status"},{"name":"Stat"},{"name":"LogView"},{"name":"Notice"},{"name":"Breadcrumb"},{"name":"FolderCard"},{"name":"Thumbnail"},{"name":"Toolbar"},{"name":"Lightbox"},{"name":"ThemeToggle"},{"name":"ContextMenu"},{"name":"SelectionBar"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  var useState = React.useState;
  var useId = React.useId;

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }

  function omit(obj, keys) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && keys.indexOf(k) === -1) out[k] = obj[k];
    }
    return out;
  }

  // Works controlled (value + onChange) or uncontrolled (defaultValue).
  function useControlled(value, initial, onChange) {
    var s = useState(initial);
    var current = value !== undefined ? value : s[0];
    return [current, function (next) {
      if (value === undefined) s[1](next);
      if (onChange) onChange(next);
    }];
  }

  var PATHS = {
    check: "M5 12.5l4.5 4.5L19 7.5",
    cross: "M6 6l12 12M18 6L6 18",
    chevron: "M9 6l6 6-6 6",
    copy: "M9 9h10v10H9zM5 15V5h10",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
    alert: "M12 3l9.5 17h-19zM12 10v4M12 17.5v.5",
    info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5",
    stop: "M7 7h10v10H7z",
    folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    play: "M8 5.5v13l10-6.5z",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    prev: "M15 6l-6 6 6 6",
    next: "M9 6l6 6-6 6",
    loop: "M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4",
    ring: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
    select: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 17l2 2 4-4",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
  };

  function Icon(p) {
    return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: p.strokeWidth || 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", className: p.className },
      h("path", { d: PATHS[p.name] }));
  }

  function Spinner() {
    return h("span", { className: "g-spin", "aria-hidden": "true" });
  }

  function Button(p) {
    var variant = p.variant || "secondary";
    var size = p.size || "md";
    var rest = omit(p, ["variant", "size", "loading", "className", "children", "disabled"]);
    return h("button", Object.assign({ type: "button" }, rest, {
      className: cx("g-btn", "g-btn--" + variant, size === "sm" && "g-btn--sm", p.loading && "is-loading", p.className),
      disabled: p.disabled || p.loading,
      "aria-busy": p.loading || undefined
    }), p.loading ? h(Spinner) : null, p.children);
  }

  function TextField(p) {
    var autoId = useId();
    var id = p.id || autoId;
    var hintId = id + "-hint";
    var message = p.error || p.hint;
    var rest = omit(p, ["label", "tag", "hint", "error", "prefix", "mono", "className", "id"]);
    return h("div", { className: cx("g-field", p.className) },
      h("label", { className: "g-label", htmlFor: id }, p.label, p.tag ? h("span", { className: "g-seg__tag g-label__tag" }, p.tag) : null),
      h("div", { className: cx("g-input", p.error && "is-error", p.mono && "is-mono", p.disabled && "is-disabled") },
        p.prefix ? h("span", { className: "g-input__prefix", "aria-hidden": "true" }, p.prefix) : null,
        h("input", Object.assign({ id: id, "aria-invalid": p.error ? true : undefined, "aria-describedby": message ? hintId : undefined }, rest))),
      message ? h("div", { id: hintId, className: cx("g-hint", p.error && "is-error") }, p.error || p.hint) : null);
  }

  function normalize(options) {
    return (options || []).map(function (o) { return typeof o === "string" ? { value: o, label: o } : o; });
  }

  function Segmented(p) {
    var opts = normalize(p.options);
    var initial = p.defaultValue !== undefined ? p.defaultValue : (opts[0] && opts[0].value);
    var st = useControlled(p.value, initial, p.onChange);

    function onKey(e, i) {
      var step = (e.key === "ArrowRight" || e.key === "ArrowDown") ? 1 : (e.key === "ArrowLeft" || e.key === "ArrowUp") ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      var next = (i + step + opts.length) % opts.length;
      st[1](opts[next].value);
      var sibling = e.currentTarget.parentNode.children[next];
      if (sibling) sibling.focus();
    }

    return h("div", { role: "radiogroup", "aria-label": p.label, className: cx("g-seg", p.size === "sm" && "g-seg--sm", p.columns && "g-seg--grid g-seg--cols-" + p.columns, p.className) },
      opts.map(function (o, i) {
        var on = o.value === st[0];
        return h("button", {
          key: o.value, type: "button", role: "radio", "aria-checked": on, tabIndex: on ? 0 : -1,
          disabled: o.disabled, title: o.title, className: cx("g-seg__opt", on && "is-on"),
          onClick: function () { st[1](o.value); },
          onKeyDown: function (e) { onKey(e, i); }
        }, o.label, o.tag ? h("span", { className: "g-seg__tag" }, o.tag) : null);
      }));
  }

  function ChoiceList(p) {
    var name = useId();
    var st = useControlled(p.value, p.defaultValue, p.onChange);
    return h("fieldset", { className: cx("g-choices", p.className) },
      p.legend ? h("legend", { className: "g-label" }, p.legend) : null,
      normalize(p.options).map(function (o) {
        var on = o.value === st[0];
        return h("label", { key: o.value, className: cx("g-choice", on && "is-on") },
          h("input", { type: "radio", name: name, value: o.value, checked: on, onChange: function () { st[1](o.value); } }),
          h("span", { className: "g-choice__body" },
            h("span", { className: "g-choice__label" }, o.label),
            o.detail ? h("span", { className: "g-choice__detail", title: o.detail }, o.detail) : null));
      }));
  }

  function Switch(p) {
    var id = useId();
    var st = useControlled(p.checked, !!p.defaultChecked, p.onChange);
    return h("div", { className: cx("g-switch", p.className) },
      h("div", { className: "g-switch__text" },
        h("label", { className: "g-label", htmlFor: id }, p.label),
        p.hint ? h("span", { className: "g-hint" }, p.hint) : null),
      h("button", { id: id, type: "button", role: "switch", "aria-checked": st[0], disabled: p.disabled, className: "g-switch__btn",
        onClick: function () { st[1](!st[0]); } }));
  }

  function Disclosure(p) {
    return h("details", { className: cx("g-disc", p.className), open: p.defaultOpen },
      h("summary", null,
        h(Icon, { name: "chevron", className: "g-disc__chev", strokeWidth: 2 }),
        p.title,
        p.meta ? h("span", { className: "g-disc__meta" }, p.meta) : null),
      h("div", { className: "g-disc__body" }, p.children));
  }

  // Values in ink, flags in ink-2: the values are what change between runs.
  function highlight(text) {
    return text.split(/(\s+)/).map(function (part, i) {
      return /^-{1,2}[A-Za-z]/.test(part) ? h("span", { key: i, className: "g-cmd__flag" }, part) : part;
    });
  }

  function CommandBlock(p) {
    var steps = p.steps || [{ label: p.label || "Command", command: p.command || "" }];
    var tab = useState(0);
    var copied = useState(false);
    var current = steps[Math.min(tab[0], steps.length - 1)];

    function copy() {
      try { navigator.clipboard.writeText(current.command); } catch (e) { /* clipboard blocked in some frames */ }
      copied[1](true);
      setTimeout(function () { copied[1](false); }, 1500);
      if (p.onCopy) p.onCopy(current.command);
    }

    return h("div", { className: cx("g-cmd", p.className) },
      h("div", { className: "g-cmd__head" },
        h("div", { className: "g-cmd__tabs", role: steps.length > 1 ? "tablist" : undefined },
          steps.map(function (s, i) {
            return steps.length > 1
              ? h("button", { key: i, type: "button", role: "tab", "aria-selected": i === tab[0], className: "g-cmd__tab", onClick: function () { tab[1](i); } }, (i + 1) + " · " + s.label)
              : h("span", { key: i, className: "g-cmd__tab" }, s.label);
          })),
        h(Button, { variant: "ghost", size: "sm", onClick: copy, "aria-label": "Copy command" },
          h(Icon, { name: copied[0] ? "check" : "copy", className: "g-ico" }), copied[0] ? "Copied" : "Copy"),
        h("span", { "aria-live": "polite", style: { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" } }, copied[0] ? "Copied" : "")),
      h("pre", null, highlight(current.command)));
  }

  var STATUS = {
    queued: { word: "Queued", icon: "clock" },
    running: { word: "Running", icon: null },
    stopping: { word: "Stopping", icon: null },
    done: { word: "Done", icon: "check" },
    failed: { word: "Failed", icon: "cross" },
    stopped: { word: "Stopped", icon: "stop" },
    interrupted: { word: "Interrupted", icon: "alert" }
  };

  function Status(p) {
    var s = STATUS[p.state] || STATUS.queued;
    return h("span", { className: cx("g-status", "g-status--" + p.state, p.className) },
      s.icon ? h(Icon, { name: s.icon, strokeWidth: 2.25 }) : h(Spinner),
      s.word,
      p.children ? h("span", { className: "g-status__detail" }, p.children) : null);
  }

  function Stat(p) {
    var value = typeof p.value === "number" ? p.value.toLocaleString("en-US") : p.value;
    return h("div", { role: "group", className: cx("g-stat", p.tone && "g-stat--" + p.tone, p.className), "aria-label": value + " " + p.label },
      h("span", { className: "g-stat__value", "aria-hidden": "true" }, value),
      h("span", { className: "g-stat__label", "aria-hidden": "true" }, p.label));
  }

  function lineLevel(line) {
    if (line.level) return line.level;
    var t = line.text;
    if (t.indexOf("# ") === 0) return "skip";
    if (/\]\[error\]/.test(t)) return "error";
    if (/\]\[warning\]/.test(t)) return "warning";
    return "info";
  }

  function LogView(p) {
    var lines = (p.lines || []).map(function (l) { return typeof l === "string" ? { text: l } : l; });
    if (p.maxLines) lines = lines.slice(-p.maxLines);
    return h("pre", { className: cx("g-log", p.className), role: "log", "aria-label": p.label || "Run log", style: p.maxHeight ? { maxHeight: p.maxHeight } : undefined },
      lines.map(function (l, i) {
        return h("span", { key: i, className: "g-log__line g-log__line--" + lineLevel(l) }, l.text);
      }));
  }

  function Notice(p) {
    var tone = p.tone || "info";
    var icon = tone === "danger" ? "alert" : tone === "warning" ? "clock" : "info";
    return h("div", { className: cx("g-notice", "g-notice--" + tone, p.className), role: tone === "danger" ? "alert" : "status" },
      h(Icon, { name: p.icon || icon }),
      h("div", null,
        p.title ? h("div", { className: "g-notice__title" }, p.title) : null,
        p.children ? h("div", { className: p.title ? "g-notice__body" : undefined }, p.children) : null,
        p.action ? h("div", { className: "g-notice__action" }, p.action) : null));
  }

  function Breadcrumb(p) {
    var items = p.items || [];
    return h("nav", { className: "g-crumbs", "aria-label": "Breadcrumb" },
      h("ol", null, items.map(function (item, i) {
        var last = i === items.length - 1;
        return h(React.Fragment, { key: i },
          i > 0 ? h("li", { "aria-hidden": "true", className: "g-crumbs__sep" }, "/") : null,
          h("li", { className: last ? "is-current" : undefined },
            last ? h("span", { "aria-current": "page" }, item.label) : h("a", { href: item.href || "#" }, item.label)));
      })));
  }

  function FolderCard(p) {
    return h("a", { className: cx("g-folder", p.className), href: p.href || "#" }, h(Icon, { name: "folder" }), h("span", null, p.name));
  }

  function Thumbnail(p) {
    return h("button", { type: "button", className: cx("g-thumb", p.active && "is-active", p.selected && "is-selected", p.className), "aria-label": p.name,
      "aria-pressed": p.selectable ? !!p.selected : undefined, style: { width: p.width || 160, height: p.height || 120 } },
      h("span", { className: "g-thumb__image", style: { background: p.tone || "var(--sunken)" } }),
      p.selectable ? h("span", { className: "g-thumb__check", "aria-hidden": "true" }, p.selected ? h(Icon, { name: "check", strokeWidth: 2.5 }) : null) : null,
      p.kind === "video" ? h("span", { className: "g-thumb__badge" }, h(Icon, { name: "play" }), p.duration || "") : null);
  }

  function ThemeToggle(p) {
    var st = useControlled(p.theme, p.defaultTheme || "light", p.onChange);
    var dark = st[0] === "dark";
    var label = dark ? "Switch to light mode" : "Switch to dark mode";
    return h("button", { type: "button", className: cx("g-theme", p.className), "aria-label": label, title: label,
      onClick: function () { st[1](dark ? "light" : "dark"); } },
      h(Icon, { name: dark ? "sun" : "moon" }));
  }

  function ContextMenu(p) {
    return h("div", { role: "menu", "aria-label": p.label, className: cx("g-menu", p.className), style: p.style },
      (p.items || []).map(function (item, i) {
        if (item === "-" || item.separator) return h("div", { key: "s" + i, role: "separator", className: "g-menu__sep" });
        return h("button", { key: item.label, type: "button", role: "menuitem", disabled: item.disabled,
          className: cx("g-menu__item", item.danger && "is-danger"), onClick: item.onSelect },
          item.icon ? h(Icon, { name: item.icon }) : h("span", null),
          h("span", null, item.label),
          item.shortcut ? h("kbd", { className: "g-menu__key" }, item.shortcut) : null);
      }));
  }

  function SelectionBar(p) {
    var count = p.count || 0;
    var text = count === 0 ? "Nothing selected" : count.toLocaleString("en-US") + (count === 1 ? " file selected" : " files selected");
    return h("div", { role: "toolbar", "aria-label": "Selection", className: cx("g-selbar", p.className) },
      h("span", { className: "g-selbar__count", "aria-live": "polite" }, text),
      h("div", { className: "g-selbar__group" },
        h(Button, { variant: "ghost", size: "sm", onClick: p.onSelectAll }, "Select all"),
        h(Button, { variant: "ghost", size: "sm", onClick: p.onClear, disabled: count === 0 }, "Clear")),
      h("div", { className: "g-selbar__group g-selbar__end" },
        h(Button, { variant: "secondary", size: "sm", onClick: p.onDownload, disabled: count === 0 }, h(Icon, { name: "download" }), "Download"),
        h(Button, { variant: "danger", size: "sm", onClick: p.onDelete, disabled: count === 0 }, h(Icon, { name: "trash" }), "Delete"),
        h(Button, { variant: "ghost", size: "sm", onClick: p.onDone }, "Done")));
  }

  function Toolbar(p) {
    return h("div", { className: cx("g-toolbar", p.className), role: "toolbar", "aria-label": p.label }, (p.actions || []).map(function (a) {
      return h("button", { key: a.label, type: "button", className: cx("g-toolbar__btn", a.pressed && "is-pressed"), "aria-label": a.label, "aria-pressed": a.pressed, disabled: a.disabled },
        h(Icon, { name: a.icon }), h("span", { role: "tooltip", className: "g-toolbar__tip" }, a.label));
    }));
  }

  function Lightbox(p) {
    return h("div", { className: cx("g-lightbox", p.className), role: "dialog", "aria-modal": "true", "aria-label": p.name + ", " + p.position + " of " + p.total },
      h("div", { className: "g-lightbox__top" },
        h("span", null, h("strong", null, p.position + " of " + p.total), h("span", { className: "g-lightbox__name" }, p.name)),
        h(Toolbar, { label: "Viewer actions", actions: p.actions || [] })),
      h("div", { className: "g-lightbox__stage" },
        h("span", { className: "g-lightbox__image" }),
        h("button", { type: "button", className: "g-toolbar__btn g-lightbox__nav g-lightbox__nav--prev", "aria-label": "Previous" }, h(Icon, { name: "prev" })),
        h("button", { type: "button", className: "g-toolbar__btn g-lightbox__nav g-lightbox__nav--next", "aria-label": "Next" }, h(Icon, { name: "next" }))));
  }

  window.grabberX = Object.assign(window.grabberX || {}, {
    Breadcrumb: Breadcrumb, FolderCard: FolderCard, Thumbnail: Thumbnail, Toolbar: Toolbar, Lightbox: Lightbox, ThemeToggle: ThemeToggle, ContextMenu: ContextMenu, SelectionBar: SelectionBar,
    Button: Button, TextField: TextField, Segmented: Segmented, ChoiceList: ChoiceList, Switch: Switch,
    Disclosure: Disclosure, CommandBlock: CommandBlock, Status: Status, Stat: Stat, LogView: LogView, Notice: Notice
  });
})();
