import SandboxBase from '../../base';
import IframeSandbox from '../../iframe';
import nativeMethods from '../../native-methods';
import domProcessor from '../../../dom-processor';
import * as urlUtils from '../../../utils/url';
import { isIE, isIE9, isIE10 } from '../../../utils/browser';
import { isIframeWithoutSrc, getFrameElement } from '../../../utils/dom';
import DocumentWriter from './writer';
import ShadowUI from './../../shadow-ui';

export default class DocumentSandbox extends SandboxBase {
    constructor (nodeSandbox) {
        super();

        this.nodeSandbox     = nodeSandbox;
        this.readyStateForIE = null;
        this.documentWriter  = null;
    }

    _isUninitializedIframeWithoutSrc (doc) {
        const wnd          = doc.defaultView;
        const frameElement = getFrameElement(wnd);

        return wnd !== wnd.top && frameElement && isIframeWithoutSrc(frameElement) &&
               !IframeSandbox.isIframeInitialized(frameElement);
    }

    _beforeDocumentCleaned () {
        this.nodeSandbox.mutation.onBeforeDocumentCleaned({ document: this.document });
    }

    _onDocumentClosed () {
        this.nodeSandbox.mutation.onDocumentClosed({ document: this.document });
    }

    _overridedDocumentWrite (args, ln) {
        const shouldEmitEvents = (this.readyStateForIE || this.document.readyState) !== 'loading' &&
                               this.document.readyState !== 'uninitialized';

        if (shouldEmitEvents)
            this._beforeDocumentCleaned();

        const result = this.documentWriter.write(args, ln, shouldEmitEvents);

        if (!shouldEmitEvents)
            // NOTE: B234357
            this.nodeSandbox.processNodes(null, this.document);

        return result;
    }

    attach (window, document) {
        if (!this.documentWriter || this.window !== window || this.document !== document)
            this.documentWriter = new DocumentWriter(window, document);

        super.attach(window, document);

        // NOTE: https://connect.microsoft.com/IE/feedback/details/792880/document-readystat
        const frameElement = getFrameElement(window);

        if (frameElement && !isIframeWithoutSrc(frameElement) && (isIE9 || isIE10)) {
            this.readyStateForIE = 'loading';

            nativeMethods.addEventListener.call(this.document, 'DOMContentLoaded', () => {
                this.readyStateForIE = null;
            });
        }

        const documentSandbox = this;

        document.open = (...args) => {
            const isUninitializedIframe = this._isUninitializedIframeWithoutSrc(document);

            if (!isUninitializedIframe)
                this._beforeDocumentCleaned();

            const result = nativeMethods.documentOpen.apply(document, args);

            if (!isUninitializedIframe)
                this.nodeSandbox.mutation.onDocumentCleaned({ window, document });
            else
            // NOTE: If iframe initialization is in progress, we need to override the document.write and document.open
            // methods once again, because they were cleaned after the native document.open method call.
                this.attach(window, document);

            return result;
        };

        document.close = (...args) => {
            // NOTE: IE10 and IE9 raise the "load" event only when the document.close method is called. We need to
            // restore the overrided document.open and document.write methods before Hammerhead injection, if the
            // window is not initialized.
            if (isIE && !IframeSandbox.isWindowInited(window))
                nativeMethods.restoreDocumentMeths(document);

            // NOTE: IE doesn't run scripts in iframe if iframe.documentContent.designMode equals 'on' (GH-871)
            if (typeof document.designMode === 'string' && document.designMode.toLowerCase() === 'on')
                ShadowUI.removeSelfRemovingScripts(document);

            const result = nativeMethods.documentClose.apply(document, args);

            if (!this._isUninitializedIframeWithoutSrc(document))
                this._onDocumentClosed();

            return result;
        };

        document.createElement = (...args) => {
            const el = nativeMethods.createElement.apply(document, args);

            domProcessor.processElement(el, urlUtils.convertToProxyUrl);
            this.nodeSandbox.processNodes(el);

            return el;
        };

        document.createElementNS = (...args) => {
            const el = nativeMethods.createElementNS.apply(document, args);

            domProcessor.processElement(el, urlUtils.convertToProxyUrl);
            this.nodeSandbox.processNodes(el);

            return el;
        };

        document.write = function () {
            return documentSandbox._overridedDocumentWrite(arguments);
        };

        document.writeln = function () {
            return documentSandbox._overridedDocumentWrite(arguments, true);
        };

        document.createDocumentFragment = (...args) => {
            const fragment = nativeMethods.createDocumentFragment.apply(document, args);

            documentSandbox.nodeSandbox.processNodes(fragment);

            return fragment;
        };
    }
}
