/**
 * A host for mounting a component through `react-dom/client` in node, so
 * a test can run React's effects, remounts and click handlers with no
 * browser and no DOM library (the unit suite runs in the node
 * environment, and a DOM dependency moves the lockfile, which reopens
 * the Gate 1 dependency audit).
 *
 * It is a stored tree, nothing more: nodes with children, attributes,
 * a style bag, listeners, and event dispatch in the capture and bubble
 * phases. It computes no layout and no style, parses no HTML, and offers
 * only the members react-dom's client touches while rendering plus the
 * few a test reads back (`querySelectorAll` over a tag, a class or an
 * attribute, `textContent`, `disabled`, `click`, `closest`). Anything else is
 * absent on purpose; a test that needs it needs a browser.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;

type Listener = { fn: (event: HostEvent) => void; capture: boolean };

/** The node and its ancestors, nearest first. */
function ancestry(node: HostNode): HostNode[] {
  const out: HostNode[] = [];
  for (let n: HostNode | null = node; n; n = n.parentNode) out.push(n);
  return out;
}
type ListenerOptions = boolean | { capture?: boolean; passive?: boolean } | undefined;

export class HostEvent {
  target: HostNode | null = null;
  currentTarget: HostNode | null = null;
  defaultPrevented = false;
  timeStamp = Date.now();
  stopped = false;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  constructor(readonly type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

export class HostNode {
  parentNode: HostNode | null = null;
  readonly childNodes: HostNode[] = [];
  private listeners = new Map<string, Listener[]>();
  ownerDocument: HostDocument | null;
  constructor(readonly nodeType: number, readonly nodeName: string, ownerDocument: HostDocument | null) {
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): HostNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): HostNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): HostNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): HostNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get parentElement(): HostElement | null { return this.parentNode instanceof HostElement ? this.parentNode : null; }
  get isConnected(): boolean { return ancestry(this).at(-1)?.nodeType === DOCUMENT_NODE; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(value));
  }

  appendChild<T extends HostNode>(child: T): T { return this.insertBefore(child, null); }
  insertBefore<T extends HostNode>(child: T, reference: HostNode | null): T {
    child.parentNode?.removeChild(child);
    if (reference === null) this.childNodes.push(child);
    else {
      const at = this.childNodes.indexOf(reference);
      if (at === -1) throw new Error("insertBefore: the reference is not a child");
      this.childNodes.splice(at, 0, child);
    }
    child.parentNode = this;
    return child;
  }
  removeChild<T extends HostNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at === -1) throw new Error("removeChild: not a child");
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(node: HostNode | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  addEventListener(type: string, fn: (event: HostEvent) => void, options?: ListenerOptions) {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: HostEvent) => void, options?: ListenerOptions) {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn || l.capture !== capture));
  }
  /** Capture from the root down to the target, then bubble back up when the event bubbles. */
  dispatchEvent(event: HostEvent): boolean {
    event.target = this;
    const path = ancestry(this);
    for (const node of [...path].reverse()) {
      if (event.stopped) break;
      node.invoke(event, true);
    }
    for (const node of event.bubbles ? path : [this]) {
      if (event.stopped) break;
      node.invoke(event, false);
    }
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
  private invoke(event: HostEvent, capture: boolean) {
    event.currentTarget = this;
    for (const l of [...(this.listeners.get(event.type) ?? [])]) if (l.capture === capture) l.fn(event);
  }
}

export class HostText extends HostNode {
  nodeValue: string;
  constructor(document: HostDocument, text: string, nodeType = TEXT_NODE) {
    super(nodeType, nodeType === COMMENT_NODE ? "#comment" : "#text", document);
    this.nodeValue = text;
  }
  get data() { return this.nodeValue; }
  set data(value: string) { this.nodeValue = value; }
  override get textContent() { return this.nodeType === TEXT_NODE ? this.nodeValue : ""; }
  override set textContent(value: string) { this.nodeValue = value; }
}

/** The style bag react-dom writes: `setProperty` for custom properties, plain keys otherwise. */
export class HostStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string) { this[name] = value; }
  removeProperty(name: string) { delete this[name]; }
  getPropertyValue(name: string) { return String(this[name] ?? ""); }
}

export class HostElement extends HostNode {
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attributes = new Map<string, string>();
  readonly style = new HostStyle();
  private valueField: string | null = null;
  selected = false;
  defaultSelected = false;
  checked = false;
  defaultChecked = false;
  multiple = false;
  constructor(document: HostDocument, tag: string, namespace = HTML_NS) {
    super(ELEMENT_NODE, tag.toUpperCase(), document);
    this.tagName = namespace === HTML_NS ? tag.toUpperCase() : tag;
    this.namespaceURI = namespace;
  }
  get localName() { return this.tagName.toLowerCase(); }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  setAttributeNS(_ns: string | null, name: string, value: unknown) { this.setAttribute(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  get id() { return this.getAttribute("id") ?? ""; }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(value: boolean) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get type() { return this.getAttribute("type") ?? ""; }
  set type(value: string) { this.setAttribute("type", value); }
  get name() { return this.getAttribute("name") ?? ""; }
  set name(value: string) { this.setAttribute("name", value); }
  /** A form control's value: what was assigned, else its attribute, else an option's text. */
  get value(): string { return this.valueField ?? this.getAttribute("value") ?? (this.tagName === "OPTION" ? this.textContent : ""); }
  set value(value: string) { this.valueField = String(value); }
  get defaultValue() { return this.getAttribute("value") ?? ""; }
  set defaultValue(value: string) { this.setAttribute("value", value); }
  get children(): HostElement[] { return this.childNodes.filter((c): c is HostElement => c instanceof HostElement); }
  /** A select's options, as react-dom reads them. */
  get options(): HostElement[] { return this.descendants().filter((e) => e.tagName === "OPTION"); }
  descendants(): HostElement[] {
    const out: HostElement[] = [];
    const walk = (node: HostNode) => {
      for (const child of node.childNodes) {
        if (child instanceof HostElement) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null; }
  /** A click as a browser sends it: a bubbling event, none on a disabled control. */
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new HostEvent("click", { bubbles: true, cancelable: true }));
  }
  /** One compound selector: an optional tag, then any number of `.class` and `[attr]` / `[attr="value"]` parts. */
  matches(selector: string): boolean {
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector.trim());
    if (!m) throw new Error(`dom-host: unsupported selector "${selector}"`);
    if (m[1] && m[1].toUpperCase() !== this.tagName.toUpperCase()) return false;
    for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
      if (part.startsWith(".")) {
        if (!this.className.split(/\s+/).includes(part.slice(1))) return false;
      } else {
        const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)!;
        if (!this.hasAttribute(name)) return false;
        if (value !== undefined && this.getAttribute(name) !== value) return false;
      }
    }
    return true;
  }
  /** The element or its nearest ancestor matching one compound selector. */
  closest(selector: string): HostElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  querySelectorAll(selector: string): HostElement[] { return this.descendants().filter((e) => e.matches(selector)); }
  querySelector(selector: string): HostElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

export class HostDocument extends HostNode {
  readonly documentElement: HostElement;
  readonly head: HostElement;
  readonly body: HostElement;
  activeElement: HostElement | null = null;
  defaultView: HostWindow | null = null;
  constructor() {
    super(DOCUMENT_NODE, "#document", null);
    this.ownerDocument = this;
    this.documentElement = this.appendChild(new HostElement(this, "html"));
    this.head = this.documentElement.appendChild(new HostElement(this, "head"));
    this.body = this.documentElement.appendChild(new HostElement(this, "body"));
  }
  createElement(tag: string) { return new HostElement(this, tag); }
  createElementNS(namespace: string | null, tag: string) { return new HostElement(this, tag, namespace ?? HTML_NS); }
  createTextNode(text: string) { return new HostText(this, text); }
  createComment(text: string) { return new HostText(this, text, COMMENT_NODE); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector: string) { return this.documentElement.querySelector(selector); }
}

/** The window react-dom reads while rendering: its document, the event
 * priority probe, the iframe class its focus walk tests against, and the
 * frame identity its devtools notice compares; plus a listener bus, since
 * the app's own stores broadcast on the window. */
export interface HostWindow {
  document: HostDocument;
  event: undefined;
  HTMLIFrameElement: new () => object;
  top: HostWindow;
  self: HostWindow;
  addEventListener: (type: string, fn: (event: unknown) => void) => void;
  removeEventListener: (type: string, fn: (event: unknown) => void) => void;
  dispatchEvent: (event: { type: string }) => boolean;
}

/**
 * Install a fresh document as the global `window` and `document` for the
 * duration of a test, and return the handle that removes them. React's
 * `act` environment flag is set alongside, since mounting outside act is
 * never what a test here wants.
 */
export function installDomHost(): { document: HostDocument; window: HostWindow; uninstall: () => void } {
  const document = new HostDocument();
  const bus = new Map<string, ((event: unknown) => void)[]>();
  const window = {
    document, event: undefined, HTMLIFrameElement: class {},
    addEventListener(type, fn) { bus.set(type, [...(bus.get(type) ?? []), fn]); },
    removeEventListener(type, fn) { bus.set(type, (bus.get(type) ?? []).filter((l) => l !== fn)); },
    dispatchEvent(event) { for (const fn of [...(bus.get(event.type) ?? [])]) fn(event); return true; },
  } as HostWindow;
  window.top = window;
  window.self = window;
  document.defaultView = window;
  const g = globalThis as Record<string, unknown>;
  const had = { window: "window" in g, document: "document" in g, act: g.IS_REACT_ACT_ENVIRONMENT };
  const previous = { window: g.window, document: g.document };
  g.window = window;
  g.document = document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    document,
    window,
    uninstall() {
      if (had.window) g.window = previous.window; else delete g.window;
      if (had.document) g.document = previous.document; else delete g.document;
      g.IS_REACT_ACT_ENVIRONMENT = had.act;
    },
  };
}
