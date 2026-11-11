/* @ds-bundle: {"format":4,"namespace":"Gather","components":[{"name":"Button"},{"name":"TextField"},{"name":"Segmented"},{"name":"ChoiceList"},{"name":"Switch"},{"name":"Disclosure"},{"name":"CommandBlock"},{"name":"Status"},{"name":"Stat"},{"name":"LogView"},{"name":"Notice"}]} */
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
    ring: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"
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
    var rest = omit(p, ["label", "hint", "error", "prefix", "mono", "className", "id"]);
    return h("div", { className: cx("g-field", p.className) },
      h("label", { className: "g-label", htmlFor: id }, p.label),
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

    return h("div", { role: "radiogroup", "aria-label": p.label, className: cx("g-seg", p.size === "sm" && "g-seg--sm", p.className) },
      opts.map(function (o, i) {
        var on = o.value === st[0];
        return h("button", {
          key: o.value, type: "button", role: "radio", "aria-checked": on, tabIndex: on ? 0 : -1,
          disabled: o.disabled, className: cx("g-seg__opt", on && "is-on"),
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

  window.Gather = Object.assign(window.Gather || {}, {
    Button: Button, TextField: TextField, Segmented: Segmented, ChoiceList: ChoiceList, Switch: Switch,
    Disclosure: Disclosure, CommandBlock: CommandBlock, Status: Status, Stat: Stat, LogView: LogView, Notice: Notice
  });
})();
