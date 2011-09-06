// Copyright (c) 2009-2011 by Kris Maglione <maglione.k@gmail.com>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

var EXPORTED_SYMBOLS = ["Overlay", "overlay"];

var { DOM, util } = require("util");

lazyRequire("config", ["config"]);
lazyRequire("messages", ["_"]);

var getAttr = function getAttr(elem, ns, name)
    elem.hasAttributeNS(ns, name) ? elem.getAttributeNS(ns, name) : null;
var setAttr = function setAttr(elem, ns, name, val) {
    if (val == null)
        elem.removeAttributeNS(ns, name);
    else
        elem.setAttributeNS(ns, name, val);
}

var Overlay = Class("Overlay", {
    init: function init(window) {
        this.window = window;
    },

    cleanups: Class.Memoize(function () []),
    objects: Class.Memoize(function () ({})),

    get doc() this.window.document,

    get win() this.window,

    $: function $(sel, node) DOM(sel, node || this.doc),

    cleanup: function cleanup(window, reason) {
        for (let fn in values(this.cleanups))
            util.trapErrors(fn, this, window, reason);
    }
});

var overlay = Singleton("overlay", XPCOM([Ci.nsIObserver, Ci.nsISupportsWeakReference]), {
    init: function init() {
        util.addObserver(this);
        this.overlays = {};

        this.onWindowVisible = [];
    },

    id: Class.Memoize(function () config.addon.id),

    cleanup: function cleanup(reason) {
        for (let doc in util.iterDocuments()) {
            for (let elem in values(this.getData(doc, "overlayElements")))
                if (elem.parentNode)
                    elem.parentNode.removeChild(elem);

            for (let [elem, ns, name, orig, value] in values(this.getData(doc, "overlayAttributes")))
                if (getAttr(elem, ns, name) === value)
                    setAttr(elem, ns, name, orig);

            for (let callback in values(this.getData(doc, "cleanup")))
                util.trapErrors(callback, doc, reason);

            this.unlisten(doc, true);

            delete doc[this.id];
            delete doc.defaultView[this.id];
        }
    },

    /**
     * Adds an event listener for this session and removes it on
     * dactyl shutdown.
     *
     * @param {Element} target The element on which to listen.
     * @param {string} event The event to listen for.
     * @param {function} callback The function to call when the event is received.
     * @param {boolean} capture When true, listen during the capture
     *      phase, otherwise during the bubbling phase.
     * @param {boolean} allowUntrusted When true, allow capturing of
     *      untrusted events.
     */
    listen: function (target, event, callback, capture, allowUntrusted) {
        let doc = target.ownerDocument || target.document || target;
        let listeners = this.getData(doc, "listeners");

        if (!isObject(event))
            var [self, events] = [null, array.toObject([[event, callback]])];
        else
            [self, events] = [event, event[callback || "events"]];

        for (let [event, callback] in Iterator(events)) {
            let args = [Cu.getWeakReference(target),
                        event,
                        util.wrapCallback(callback, self),
                        capture,
                        allowUntrusted];

            target.addEventListener.apply(target, args.slice(1));
            listeners.push(args);
        }
    },

    /**
     * Remove an event listener.
     *
     * @param {Element} target The element on which to listen.
     * @param {string} event The event to listen for.
     * @param {function} callback The function to call when the event is received.
     * @param {boolean} capture When true, listen during the capture
     *      phase, otherwise during the bubbling phase.
     */
    unlisten: function (target, event, callback, capture) {
        let doc = target.ownerDocument || target.document || target;
        let listeners = this.getData(doc, "listeners");
        if (event === true)
            target = null;

        this.setData(doc, "listeners", listeners.filter(function (args) {
            if (target == null || args[0].get() == target && args[1] == event && args[2].wrapped == callback && args[3] == capture) {
                args[0].get().removeEventListener.apply(args[0].get(), args.slice(1));
                return false;
            }
            return !args[0].get();
        }));
    },

    observers: {
        "toplevel-window-ready": function (window, data) {
            window.addEventListener("DOMContentLoaded", util.wrapCallback(function listener(event) {
                if (event.originalTarget === window.document) {
                    window.removeEventListener("DOMContentLoaded", listener.wrapper, true);
                    overlay._loadOverlays(window);
                }
            }), true);
        },
        "chrome-document-global-created": function (window, uri) { this.observe(window, "toplevel-window-ready", null); },
        "content-document-global-created": function (window, uri) { this.observe(window, "toplevel-window-ready", null); },
        "xul-window-visible": function () {
            if (this.onWindowVisible)
                this.onWindowVisible.forEach(function (f) f.call(this), this);
            this.onWindowVisible = null;
        }
    },

    getData: function getData(obj, key, constructor) {
        let { id } = this;

        if (!(id in obj))
            obj[id] = {};

        if (obj[id][key] === undefined)
            obj[id][key] = (constructor || Array)();

        return obj[id][key];
    },

    setData: function setData(obj, key, val) {
        let { id } = this;

        if (!(id in obj))
            obj[id] = {};

        return obj[id][key] = val;
    },

    overlayWindow: function (url, fn) {
        if (url instanceof Ci.nsIDOMWindow)
            overlay._loadOverlay(url, fn);
        else {
            Array.concat(url).forEach(function (url) {
                if (!this.overlays[url])
                    this.overlays[url] = [];
                this.overlays[url].push(fn);
            }, this);

            for (let doc in util.iterDocuments())
                if (~["interactive", "complete"].indexOf(doc.readyState)) {
                    this.observe(doc.defaultView, "xul-window-visible");
                    this._loadOverlays(doc.defaultView);
                }
                else {
                    if (!this.onWindowVisible)
                        this.onWindowVisible = [];
                    this.observe(doc.defaultView, "toplevel-window-ready");
                }
        }
    },

    _loadOverlays: function _loadOverlays(window) {
        let overlays = this.getData(window, "overlays");

        for each (let obj in overlay.overlays[window.document.documentURI] || []) {
            if (~overlays.indexOf(obj))
                continue;
            overlays.push(obj);
            this._loadOverlay(window, obj(window));
        }
    },

    _loadOverlay: function _loadOverlay(window, obj) {
        let doc = window.document;
        let elems = this.getData(doc, "overlayElements");
        let attrs = this.getData(doc, "overlayAttributes");

        function insert(key, fn) {
            if (obj[key]) {
                let iterator = Iterator(obj[key]);
                if (!isObject(obj[key]))
                    iterator = ([elem.@id, elem.elements(), elem.@*::*.(function::name() != "id")] for each (elem in obj[key]));

                for (let [elem, xml, attr] in iterator) {
                    if (elem = doc.getElementById(elem)) {
                        let node = DOM.fromXML(xml, doc, obj.objects);
                        if (!(node instanceof Ci.nsIDOMDocumentFragment))
                            elems.push(node);
                        else
                            for (let n in array.iterValues(node.childNodes))
                                elems.push(n);

                        fn(elem, node);
                        for each (let attr in attr || []) {
                            let ns = attr.namespace(), name = attr.localName();
                            attrs.push([elem, ns, name, getAttr(elem, ns, name), String(attr)]);
                            if (attr.name() != "highlight")
                                elem.setAttributeNS(ns, name, String(attr));
                            else
                                highlight.highlightNode(elem, String(attr));
                        }
                    }
                }
            }
        }

        insert("before", function (elem, dom) elem.parentNode.insertBefore(dom, elem));
        insert("after", function (elem, dom) elem.parentNode.insertBefore(dom, elem.nextSibling));
        insert("append", function (elem, dom) elem.appendChild(dom));
        insert("prepend", function (elem, dom) elem.insertBefore(dom, elem.firstChild));
        if (obj.ready)
            util.trapErrors("ready", obj, window);

        function load(event) {
            util.trapErrors("load", obj, window, event);
            if (obj.visible)
                if (!event || !overlay.onWindowVisible || window != util.topWindow(window))
                    util.trapErrors("visible", obj, window);
                else
                    overlay.onWindowVisible.push(function () { obj.visible(window) });
        }

        if (obj.load)
            if (doc.readyState === "complete")
                load();
            else
                window.addEventListener("load", util.wrapCallback(function onLoad(event) {
                    if (event.originalTarget === doc) {
                        window.removeEventListener("load", onLoad.wrapper, true);
                        load(event);
                    }
                }), true);

        if (obj.unload || obj.cleanup)
            this.listen(window, "unload", function unload(event) {
                if (event.originalTarget === doc) {
                    overlay.unlisten(window, "unload", unload);
                    if (obj.unload)
                        util.trapErrors("unload", obj, window, event);

                    if (obj.cleanup)
                        util.trapErrors("cleanup", obj, window, "unload", event);
                }
            });

        if (obj.cleanup)
            this.getData(doc, "cleanup").push(bind("cleanup", obj, window));
    },

    /**
     * Overlays an object with the given property overrides. Each
     * property in *overrides* is added to *object*, replacing any
     * original value. Functions in *overrides* are augmented with the
     * new properties *super*, *supercall*, and *superapply*, in the
     * same manner as class methods, so that they man call their
     * overridden counterparts.
     *
     * @param {object} object The object to overlay.
     * @param {object} overrides An object containing properties to
     *      override.
     * @returns {function} A function which, when called, will remove
     *      the overlay.
     */
    overlayObject: function (object, overrides) {
        let original = Object.create(object);
        overrides = update(Object.create(original), overrides);

        Object.getOwnPropertyNames(overrides).forEach(function (k) {
            let orig, desc = Object.getOwnPropertyDescriptor(overrides, k);
            if (desc.value instanceof Class.Property)
                desc = desc.value.init(k) || desc.value;

            if (k in object) {
                for (let obj = object; obj && !orig; obj = Object.getPrototypeOf(obj))
                    if (orig = Object.getOwnPropertyDescriptor(obj, k))
                        Object.defineProperty(original, k, orig);

                if (!orig)
                    if (orig = Object.getPropertyDescriptor(object, k))
                        Object.defineProperty(original, k, orig);
            }

            // Guard against horrible add-ons that use eval-based monkey
            // patching.
            let value = desc.value;
            if (callable(desc.value)) {

                delete desc.value;
                delete desc.writable;
                desc.get = function get() value;
                desc.set = function set(val) {
                    if (!callable(val) || Function.prototype.toString(val).indexOf(sentinel) < 0)
                        Class.replaceProperty(this, k, val);
                    else {
                        let package_ = util.newURI(util.fixURI(Components.stack.caller.filename)).host;
                        util.reportError(Error(_("error.monkeyPatchOverlay", package_)));
                    }
                };
            }

            try {
                Object.defineProperty(object, k, desc);

                if (callable(value)) {
                    var sentinel = "(function ScriptifyOverlay() {}())"
                    value.toString = function toString() toString.toString.call(this).replace(/\}?$/, sentinel + "; $&");
                    value.toSource = function toSource() toSource.toSource.call(this).replace(/\}?$/, sentinel + "; $&");
                }
            }
            catch (e) {
                try {
                    if (value) {
                        object[k] = value;
                        return;
                    }
                }
                catch (f) {}
                util.reportError(e);
            }
        }, this);

        return function unwrap() {
            for each (let k in Object.getOwnPropertyNames(original))
                if (Object.getOwnPropertyDescriptor(object, k).configurable)
                    Object.defineProperty(object, k, Object.getOwnPropertyDescriptor(original, k));
                else {
                    try {
                        object[k] = original[k];
                    }
                    catch (e) {}
                }
        };
    }
});

// vim: set fdm=marker sw=4 ts=4 et ft=javascript: