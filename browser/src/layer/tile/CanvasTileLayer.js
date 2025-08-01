/* -*- js-indent-level: 8; fill-column: 100 -*- */
/*
 * L.CanvasTileLayer is a layer with canvas based rendering.
 */

/* global app L JSDialog CanvasSectionContainer GraphicSelection CanvasOverlay CDarkOverlay CursorHeaderSection $ _ CPointSet CPolyUtil CPolygon Cursor CCellSelection PathGroupType UNOKey UNOModifier cool OtherViewCellCursorSection TileManager MultiPageViewLayout SplitSection TextSelections CellSelectionMarkers URLPopUpSection CalcValidityDropDown */

function clamp(num, min, max)
{
	return Math.min(Math.max(num, min), max);
}

// CStyleData is used to obtain CSS property values from style data
// stored in DOM elements in the form of custom CSS properties/variables.
var CStyleData = L.Class.extend({

	initialize: function (styleDataDiv) {
		this._div = styleDataDiv;
	},

	getPropValue: function (name) {
		return getComputedStyle(this._div).getPropertyValue(name);
	},

	getIntPropValue: function(name) { // (String) -> Number
		return parseInt(this.getPropValue(name));
	},

	getFloatPropValue: function(name) { // (String) -> Number
		return parseFloat(this.getPropValue(name));
	},

	getFloatPropWithoutUnit: function(name) { // (String) -> Number
		var value = this.getPropValue(name);
		if (value.indexOf('px'))
			value = value.split('px')[0];
		return parseFloat(value);
	}
});

// CSelections is used to add/modify/clear selections (text/cell-area(s)/ole)
// on canvas using polygons (CPolygon).
var CSelections = L.Class.extend({
	initialize: function (pointSet, canvasOverlay, selectionsDataDiv, map, isView, viewId, selectionType) {
		this._pointSet = pointSet ? pointSet : new CPointSet();
		this._overlay = canvasOverlay;
		this._styleData = new CStyleData(selectionsDataDiv);
		this._map = map;
		this._name = 'selections' + (isView ? '-viewid-' + viewId : '');
		this._isView = isView;
		this._viewId = viewId;
		this._isText = selectionType === 'text';
		this._isOle = selectionType === 'ole';
		this._selection = undefined;
		this._updateSelection();
		this._selectedMode = 0;
	},

	empty: function () {
		return !this._pointSet || this._pointSet.empty();
	},

	clear: function () {
		this.setPointSet(new CPointSet());
	},

	setPointSet: function(pointSet) {
		this._pointSet = pointSet;
		this._updateSelection();
	},

	contains: function(corePxPoint) {
		if (!this._selection)
			return false;

		return this._selection.anyRingBoundContains(corePxPoint);
	},

	getBounds: function() {
		return this._selection.getBounds();
	},

	_updateSelection: function() {
		if (!this._selection) {
			if (!this._isOle) {
				var fillColor = this._isView ?
					app.LOUtil.rgbToHex(this._map.getViewColor(this._viewId)) :
					this._styleData.getPropValue('background-color');
				var opacity = this._styleData.getFloatPropValue('opacity');
				var weight = this._styleData.getFloatPropWithoutUnit('border-top-width');
				var attributes = this._isText ? {
					viewId: this._isView ? this._viewId : undefined,
					groupType: PathGroupType.TextSelection,
					name: this._name,
					pointerEvents: 'none',
					fillColor: fillColor,
					fillOpacity: opacity,
					color: fillColor,
					opacity: 0.60,
					stroke: true,
					fill: true,
					weight: 1.0
				} : {
					viewId: this._isView ? this._viewId : undefined,
					name: this._name,
					pointerEvents: 'none',
					color: fillColor,
					fillColor: fillColor,
					fillOpacity: opacity,
					opacity: 1.0,
					weight: Math.round(weight * app.dpiScale)
				};
			}
			else {
				var attributes = {
					pointerEvents: 'none',
					fillColor: 'black',
					fillOpacity: 0.25,
					weight: 0,
					opacity: 0.25
				};
			}

			if (this._isText) {
				this._selection = new CPolygon(this._pointSet, attributes);
			}
			else if (this._isOle) {
				this._selection = new CDarkOverlay(this._pointSet, attributes);
			}
			else {
				this._selection = new CCellSelection(this._pointSet, attributes);
			}

			if (this._isText)
				this._overlay.initPath(this._selection);
			else
				this._overlay.initPathGroup(this._selection);
			return;
		}

		this._selection.setPointSet(this._pointSet);
	},

	remove: function() {
		if (!this._selection)
			return;
		if (this._isText)
			this._overlay.removePath(this._selection);
		else
			this._overlay.removePathGroup(this._selection);
	},
});

// CReferences is used to store and manage the CPath's of all
// references in the current sheet.
var CReferences = L.Class.extend({

	initialize: function (canvasOverlay) {

		this._overlay = canvasOverlay;
		this._marks = [];
	},

	// mark should be a CPath.
	addMark: function (mark) {
		this._overlay.initPath(mark);
		this._marks.push(mark);
	},

	// mark should be a CPath.
	hasMark: function (mark) {
		for (var i = 0; i < this._marks.length; ++i) {
			if (mark.getBounds().equals(this._marks[i].getBounds()))
				return true;
		}

		return false;
	},

	clear: function () {
		for (var i = 0; i < this._marks.length; ++i)
			this._overlay.removePath(this._marks[i]);
		this._marks = [];
	}

});

L.TileSectionManager = L.Class.extend({

	initialize: function (layer) {
		this._layer = layer;
		this._canvas = this._layer._canvas;
		this._map = this._layer._map;
		var mapSize = this._map.getPixelBoundsCore().getSize();
		this._tilesSection = null; // Shortcut.

		if (L.Browser.cypressTest) // If cypress is active, create test divs.
			app.sectionContainer.testing = true;

		app.sectionContainer.onResize(mapSize.x, mapSize.y);

		var splitPanesContext = this._layer.getSplitPanesContext();
		this._splitPos = splitPanesContext ?
			splitPanesContext.getSplitPos() : new L.Point(0, 0);
		this._updatesRunning = false;
		this._mirrorEventsFromSourceToCanvasSectionContainer(document.getElementById('map'));

		var canvasContainer = document.getElementById('document-container');
		var that = this;
		this.resObserver = new ResizeObserver(function() {
			that._layer._syncTileContainerSize();
		});
		this.resObserver.observe(canvasContainer);

		this._zoomAtDocEdgeX = true;
		this._zoomAtDocEdgeY = true;
	},

	// Map and TilesSection overlap entirely. Map is above tiles section. In order to handle events in tiles section, we need to mirror them from map.
	_mirrorEventsFromSourceToCanvasSectionContainer: function (sourceElement) {
		sourceElement.addEventListener('mousedown', function (e) { app.sectionContainer.onMouseDown(e); }, true);
		sourceElement.addEventListener('click', function (e) { app.sectionContainer.onClick(e); }, true);
		sourceElement.addEventListener('dblclick', function (e) { app.sectionContainer.onDoubleClick(e); }, true);
		sourceElement.addEventListener('contextmenu', function (e) { app.sectionContainer.onContextMenu(e); }, true);
		sourceElement.addEventListener('wheel', function (e) { app.sectionContainer.onMouseWheel(e); }, true);
		sourceElement.addEventListener('mouseleave', function (e) { app.sectionContainer.onMouseLeave(e); }, true);
		sourceElement.addEventListener('mouseenter', function (e) { app.sectionContainer.onMouseEnter(e); }, true);
		sourceElement.addEventListener('touchstart', function (e) { app.sectionContainer.onTouchStart(e); }, true);
		sourceElement.addEventListener('touchmove', function (e) { app.sectionContainer.onTouchMove(e); }, true);
		sourceElement.addEventListener('touchend', function (e) { app.sectionContainer.onTouchEnd(e); }, true);
		sourceElement.addEventListener('touchcancel', function (e) { app.sectionContainer.onTouchCancel(e); }, true);
	},

	getSplitPos: function () {
		var splitPanesContext = this._layer.getSplitPanesContext();
		return splitPanesContext ?
			splitPanesContext.getSplitPos().multiplyBy(app.dpiScale) :
			new L.Point(0, 0);
	},

	// Details of tile areas to render
	_paintContext: function() {
		var viewBounds = this._map.getPixelBoundsCore();
		var splitPanesContext = this._layer.getSplitPanesContext();
		var paneBoundsList = splitPanesContext ?
		    splitPanesContext.getPxBoundList(viewBounds) :
		    [viewBounds];

		return {
			 viewBounds: viewBounds,
			 paneBoundsList: paneBoundsList,
			 paneBoundsActive: splitPanesContext ? true: false,
			 splitPos: this.getSplitPos(),
		};
	},

	// Debug tool. Splits are enabled for only Calc for now.
	_addSplitsSection: function () {
		const splitSection = new SplitSection();
		app.sectionContainer.addSection(splitSection);
	},

	_removeSplitsSection: function () {
		var section = app.sectionContainer.getSectionWithName('calc grid');
		if (section) {
			section.setDrawingOrder(L.CSections.CalcGrid.drawingOrder);
			section.sectionProperties.strokeStyle = '#c0c0c0';
		}
		app.sectionContainer.removeSection(L.CSections.Debug.Splits.name);
	},

	// Debug tool
	_addTilePixelGridSection: function () {
		app.sectionContainer.addSection(new app.definitions.pixelGridSection());
	},

	_removeTilePixelGridSection: function () {
		app.sectionContainer.removeSection(L.CSections.Debug.TilePixelGrid.name);
	},

	_addDebugOverlaySection: function () {
		app.sectionContainer.addSection(new app.definitions.debugOverlaySection(this._map._debug));
	},

	_removeDebugOverlaySection: function () {
		app.sectionContainer.removeSection(L.CSections.Debug.DebugOverlay.name);
	},

	_addPreloadMap: function () {
		app.sectionContainer.addSection(new app.definitions.preloadMapSection());
	},

	_removePreloadMap: function () {
		app.sectionContainer.removeSection(L.CSections.Debug.PreloadMap.name);
	},

	update: function () {
		app.sectionContainer.requestReDraw();
	},

	/**
	 * Everything in this doc comment is speculation: I didn't write the code that supplies it and I'm guessing to
	 * have something to work on for this function. That said, given my observations, they seem incredibly likely to be correct
	 *
	 * @param pinchCenter {{x: number, y: number}} The current pinch center in doc core-pixels
	 * Normally expressed as an L.Point instance
	 *
	 * @param pinchStartCenter {{x: number, y: number}} The pinch center at the start of the pinch in doc core-pixels
	 * Normally expressed as an L.Point instance
	 *
	 * @param paneBounds {{min: {x: number, y: number}, max: {x: number, y: number}}} The edges of the current pane
	 * Traditionally this is the map border at the start of the pinch
	 *
	 * @param freezePane {{freezeX: boolean, freezeY: boolean}} Whether the pane is frozen in the x or y directions
	 *
	 * @param splitPos {{x: number, y: number}} The inset in core-pixels into the document caused by any splits (e.g. a frozen row at the start of the document)
	 *
	 * @param scale {number} The scale, relative to the initial size, of the document currently
	 * Or rather this is equivalent to: old_width / new_width
	 *
	 * @param findFreePaneCenter {boolean} Wether to return a center point
	 *
	 * @returns {{topLeft: {x: number, y: number}, center?: {x: number, y: number}}} An object with a top left point in core-pixels and optionally a center point
	 * Center is included iff findFreePaneCenter is true
	 * (probably this should be encoded into the type, e.g. with an overload when this is converted to TypeScript)
	 **/
	_getZoomDocPos: function (pinchCenter, pinchStartCenter, paneBounds, freezePane, splitPos, scale, findFreePaneCenter) {
		let xMin = 0;
		const hasXMargin = !this._layer.isCalc();
		if (hasXMargin) {
			xMin = -Infinity;
		} else if (paneBounds.min.x > 0) {
			xMin = splitPos.x;
		}

		let yMin = 0;
		if (paneBounds.min.y < 0) {
			yMin = -Infinity;
		} else if (paneBounds.min.y > 0) {
			yMin = splitPos.y;
		}

		const minTopLeft = new L.Point(xMin, yMin);

		const paneSize = paneBounds.getSize();

		pinchCenter = pinchCenter.subtract(this._offset);

		let centerOffset = {
			x: pinchCenter.x - pinchStartCenter.x,
			y: pinchCenter.y - pinchStartCenter.y,
		};

		// Portion of the pane away that our pinchStart (which should be where we zoom round) is
		const panePortion = {
			x: (pinchStartCenter.x - this._offset.x - paneBounds.min.x) / paneSize.x,
			y: (pinchStartCenter.y - this._offset.y - paneBounds.min.y) / paneSize.y,
		};

		let docTopLeft = new L.Point(
			pinchStartCenter.x + (centerOffset.x - paneSize.x * panePortion.x) / scale,
			pinchStartCenter.y + (centerOffset.y - paneSize.y * panePortion.y) / scale
		);

		// Top left in document coordinates.
		const clampedDocTopLeft = new L.Point(
			Math.max(minTopLeft.x, docTopLeft.x),
			Math.max(minTopLeft.y, docTopLeft.y)
		);

		const offset = clampedDocTopLeft.subtract(docTopLeft);

		if (freezePane.freezeX) {
			docTopLeft.x = paneBounds.min.x;
		} else {
			this._offset.x = Math.round(Math.max(this._offset.x, offset.x));
			docTopLeft.x += this._offset.x;
		}

		if (freezePane.freezeY) {
			docTopLeft.y = paneBounds.min.y;
		} else {
			this._offset.y = Math.round(Math.max(this._offset.y, offset.y));
			docTopLeft.y += this._offset.y;
		}

		if (!findFreePaneCenter) {
			return { offset: this._offset, topLeft: docTopLeft };
		}

		const newPaneCenter = new L.Point(
			(docTopLeft.x - splitPos.x + (paneSize.x + splitPos.x) * 0.5 / scale),
			(docTopLeft.y - splitPos.y + (paneSize.y + splitPos.y) * 0.5 / scale));

		return {
			offset: this._offset,
			topLeft: docTopLeft.add(this._offset),
			center: this._map.rescale(newPaneCenter, this._map.getZoom(), this._map.getScaleZoom(scale)),
		};
	},

	_getZoomMapCenter: function (zoom) {
		var scale = this._calcZoomFrameScale(zoom);
		var ctx = this._paintContext();
		var splitPos = ctx.splitPos;
		var viewBounds = ctx.viewBounds;
		var freePaneBounds = new L.Bounds(viewBounds.min.add(splitPos), viewBounds.max);

		return this._getZoomDocPos(
			this._newCenter,
			this._layer._pinchStartCenter,
			freePaneBounds,
			{ freezeX: false, freezeY: false },
			splitPos,
			scale,
			true /* findFreePaneCenter */
		).center;
	},

	_zoomAnimation: function () {
		var painter = this;
		var ctx = this._paintContext();
		var canvasOverlay = this._layer._canvasOverlay;

		var rafFunc = function (timeStamp, final) {
			painter._layer._refreshRowColumnHeaders();

			// Draw zoom frame with grids and directly from the tiles.
			// This will clear the doc area first.
			painter._tilesSection.drawZoomFrame(ctx);
			// Draw the overlay objects.
			canvasOverlay.onDraw();

			if (!final)
				painter._zoomRAF = requestAnimationFrame(rafFunc);
		};
		this.rafFunc = rafFunc;
		rafFunc();
	},

	_calcZoomFrameScale: function (zoom) {
		zoom = this._layer._map._limitZoom(zoom);
		var origZoom = this._layer._map.getZoom();
		// Compute relative-multiplicative scale of this zoom-frame w.r.t the starting zoom(ie the current Map's zoom).
		return this._layer._map.zoomToFactor(zoom - origZoom + this._layer._map.options.zoom);
	},

	_calcZoomFrameParams: function (zoom, newCenter) {
		this._zoomFrameScale = this._calcZoomFrameScale(zoom);
		this._newCenter = this._layer._map.project(newCenter).multiplyBy(app.dpiScale); // in core pixels
	},

	setWaitForTiles: function (wait) {
		this._waitForTiles = wait;
	},

	waitForTiles: function () {
		return this._waitForTiles;
	},

	zoomStep: function (zoom, newCenter) {
		if (this._finishingZoom) // finishing steps of animation still going on.
			return;

		this._calcZoomFrameParams(zoom, newCenter);

		if (!this._inZoomAnim) {
			app.sectionContainer.setInZoomAnimation(true);
			this._inZoomAnim = true;
			// Start RAF loop for zoom-animation
			this._zoomAnimation();
		}
	},

	zoomStepEnd: function (zoom, newCenter, mapUpdater, runAtFinish, noGap) {

		if (!this._inZoomAnim || this._finishingZoom)
			return;

		this._finishingZoom = true;

		this._map.disableTextInput();
		// Do a another animation from current non-integral log-zoom to
		// the final integral zoom, but maintain the same center.
		var steps = 10;
		var stepId = noGap ? steps : 0;

		var startZoom = this._zoomFrameScale;
		var endZoom = this._calcZoomFrameScale(zoom);
		var painter = this;
		var map = this._map;

		// Calculate the final center at final zoom in advance.
		var newMapCenter = this._getZoomMapCenter(zoom).divideBy(app.dpiScale);
		var newMapCenterLatLng = map.unproject(newMapCenter, zoom);
		app.sectionContainer.setZoomChanged(true);

		var stopAnimation = noGap ? true : false;
		var waitForTiles = false;
		var waitTries = 30;
		var finishingRAF = undefined;

		var finishAnimation = function () {

			if (stepId < steps) {
				// continue animating till we reach "close" to 'final zoom'.
				painter._zoomFrameScale = startZoom + (endZoom - startZoom) * stepId / steps;
				stepId += 1;
				if (stepId >= steps)
					stopAnimation = true;
			}

			if (stopAnimation) {
				stopAnimation = false;
				cancelAnimationFrame(painter._zoomRAF);
				painter._calcZoomFrameParams(zoom, newCenter);
				// Draw one last frame at final zoom.
				painter.rafFunc(undefined, true /* final? */);
				painter._zoomFrameScale = undefined;
				app.sectionContainer.setInZoomAnimation(false);
				painter._inZoomAnim = false;

				painter.setWaitForTiles(true);
				// Set view and paint the tiles if all available.
				mapUpdater(newMapCenterLatLng);
				waitForTiles = true;
			}

			if (waitForTiles) {
				// Wait until we get all tiles or wait time exceeded.
				if (waitTries <= 0 || painter._tilesSection.haveAllTilesInView()) {
					// All done.
					waitForTiles = false;
					cancelAnimationFrame(finishingRAF);
					painter.setWaitForTiles(false);
					app.sectionContainer.setZoomChanged(false);
					map.enableTextInput();
					map.focus(map.canAcceptKeyboardInput());
					// Paint everything.
					app.sectionContainer.requestReDraw();
					// Don't let a subsequent pinchZoom start before finishing all steps till this point.
					painter._finishingZoom = false;
					// Run the finish callback.
					runAtFinish();
					return;
				}
				else
					waitTries -= 1;
			}

			finishingRAF = requestAnimationFrame(finishAnimation);
		};

		finishAnimation();
	},

	getTileSectionPos : function () {
		return new L.Point(this._tilesSection.myTopLeft[0], this._tilesSection.myTopLeft[1]);
	}
});

L.CanvasTileLayer = L.Layer.extend({

	options: {
		tileSize: window.tileSize,
		opacity: 1,

		updateWhenIdle: (window.mode.isMobile() || window.mode.isTablet()),
		updateInterval: 200,

		attribution: null,
		zIndex: null,
		bounds: null,

		previewInvalidationTimeout: 1000,
	},

	_pngCache: [],

	initialize: function (options) {

		L.Layer.prototype.initialize.call(this);

		options = L.setOptions(this, options);

		// text, presentation, spreadsheet, etc
		this._docType = options.docType;
		this._documentInfo = '';
		if (this._docType !== 'text')
			app.setCursorVisibility(false); // Don't change the default for Writer.
		// Last cursor position for invalidation
		this.lastCursorPos = null;
		// Are we zooming currently ? - if so, no cursor.
		this._isZooming = false;

		app.calc.cellCursorVisible = false;
		this._prevCellCursorAddress = null;
		this._shapeGridOffset = new app.definitions.simplePoint(0, 0);

		// Position and size of the selection start (as if there would be a cursor caret there).

		// View selection of other views
		this._viewSelections = {};

		this._lastValidPart = -1;
		// Cursor marker
		this._cursorMarker = null;

		this._initializeTableOverlay();

		this._msgQueue = [];
		this._toolbarCommandValues = {};
		this._previewInvalidations = [];

		this._editorId = -1;
		app.setFollowingUser(options.viewId);

		this._selectedTextContent = '';

		this._moveInProgress = false;
		// tile requests issued while _moveInProgress is true,
		// i.e. issued between moveStart and moveEnd
		this._moveTileRequests = [];
		this._canonicalIdInitialized = false;

		TileManager.initialize();
	},

	_initContainer: function () {
		if (this._canvasContainer) {
			window.app.console.error('called _initContainer() when this._canvasContainer is present!');
		}

		if (this._container) { return; }

		this._container = L.DomUtil.create('div', 'leaflet-layer');
		this._updateZIndex();

		this.getPane().appendChild(this._container);

		var mapContainer = document.getElementById('document-container');
		var canvasContainerClass = 'leaflet-canvas-container';
		this._canvasContainer = L.DomUtil.create('div', canvasContainerClass, mapContainer);
		this._canvasContainer.id = 'canvas-container';
		this._setup();
	},

	_setup: function () {

		if (!this._canvasContainer) {
			window.app.console.error('canvas container not found. _initContainer failed ?');
		}

		this._canvas = L.DomUtil.createWithId('canvas', 'document-canvas', this._canvasContainer);
		this._canvas.style.visibility = 'hidden';
		app.sectionContainer = new CanvasSectionContainer(this._canvas, this.isCalc() /* disableDrawing? */);
		this._container.style.position = 'absolute';
		this._cursorDataDiv = L.DomUtil.create('div', 'cell-cursor-data', this._canvasContainer);
		this._selectionsDataDiv = L.DomUtil.create('div', 'selections-data', this._canvasContainer);
		this._splittersDataDiv = L.DomUtil.create('div', 'splitters-data', this._canvasContainer);
		this._cursorOverlayDiv = L.DomUtil.create('div', 'cursor-overlay', this._canvasContainer);
		if (L.Browser.cypressTest) {
			this._emptyDeltaDiv = L.DomUtil.create('div', 'empty-deltas', this._canvasContainer);
			this._emptyDeltaDiv.innerText = 0;
		}
		this._splittersStyleData = new CStyleData(this._splittersDataDiv);

		this._painter = new L.TileSectionManager(this);

		app.sectionContainer.addSection(L.getNewTilesSection());
		this._painter._tilesSection = app.sectionContainer.getSectionWithName('tiles');
		app.sectionContainer.setDocumentAnchorSection(L.CSections.Tiles.name);

		app.sectionContainer.getSectionWithName('tiles').onResize();

		this._canvasOverlay = new CanvasOverlay(this._map, app.sectionContainer.getContext());
		app.sectionContainer.addSection(this._canvasOverlay);

		app.sectionContainer.addSection(L.getNewScrollSection(() => this.isCalcRTL()));

		// For mobile/tablet the hammerjs swipe handler already uses a requestAnimationFrame to fire move/drag events
		// Using L.TileSectionManager's own requestAnimationFrame loop to do the updates in that case does not perform well.
		if (window.mode.isMobile() || window.mode.isTablet()) {
			this._map.on('move', this._painter.update, this._painter);
			this._map.on('moveend', function () {
				setTimeout(this.update.bind(this), 200);
			}, this._painter);
		}
		this._map.on('zoomend', this._painter.update, this._painter);
		this._map.on('splitposchanged', function () {
			TileManager.update();
		}, this);
		this._map.on('sheetgeometrychanged', this._painter.update, this._painter);
		this._map.on('move', this._syncTilePanePos, this);

		this._map.on('viewrowcolumnheaders', this._painter.update, this._painter);
		this._map.on('messagesdone', TileManager.sendProcessedResponse, TileManager);

		if (this._docType === 'spreadsheet') {
			const calcGridSection = new app.definitions.calcGridSection();
			calcGridSection.sectionProperties.tsManager = this._painter;
			this._painter._calcGridSection = calcGridSection;
			app.sectionContainer.addSection(calcGridSection);
		}

		// Add it regardless of the file type.
		app.sectionContainer.addSection(new app.definitions.CommentSection());

		this._syncTileContainerSize();
		this._setupTableOverlay();
	},

	// Returns true if the document type is Writer.
	isWriter: function() {
		return this._docType === 'text';
	},

	// Returns true if the document type is Calc.
	isCalc: function() {
		return this._docType === 'spreadsheet';
	},

	// Returns true if the document type is Impress.
	isImpress: function() {
		return this._docType === 'presentation';
	},

	getContainer: function () {
		return this._container;
	},

	_updateZIndex: function () {
		if (this._container && this.options.zIndex !== undefined && this.options.zIndex !== null) {
			this._container.style.zIndex = this.options.zIndex;
		}
	},

	_reset: function (hard) {
		var tileZoom = Math.round(this._map.getZoom()),
		    tileZoomChanged = this._tileZoom !== tileZoom;

		if (hard || tileZoomChanged) {
			this._resetClientVisArea();

			this._tileZoom = tileZoom;
			if (tileZoomChanged) {
				this._updateTileTwips();
				this._updateMaxBounds();
			}

			if (app.tile.size.x === 0 || app.tile.size.y === 0) {
				let tileWidthTwips = this.options.tileWidthTwips;
				app.twipsToPixels =  TileManager.tileSize / tileWidthTwips;
				app.pixelsToTwips = 1 / app.twipsToPixels;
				app.tile.size.pX = app.tile.size.pY = TileManager.tileSize;
			}

			if (!L.Browser.mobileWebkit)
				TileManager.update(this._map.getCenter(), tileZoom);

			if (tileZoomChanged)
				TileManager.pruneTiles();

			if (this._docType === 'spreadsheet')
				this._syncTileContainerSize();
		}
	},

	// These variables indicates the clientvisiblearea sent to the server and stored by the server
	// We need to reset them when we are reconnecting to the server or reloading a document
	// because the server needs new data even if the client is unmodified.
	_resetClientVisArea: function ()  {
		this._clientZoom = '';
		this._clientVisibleArea = '';
	},

	_resetCanonicalIdStatus: function() {
		this._canonicalIdInitialized = false;
	},

	_resetViewId: function () {
		this._viewId = undefined;
	},

	_resetDocumentInfo: function () {
		this._documentInfo = "";
	},

	_getViewId: function () {
		return this._viewId;
	},

	_updateTileTwips: function () {
		// smaller zoom = zoom in
		const factor = Math.pow(1.2, (this._map.options.zoom - this._tileZoom));
		const tileWidthTwips = Math.round(this.options.tileWidthTwips * factor);

		app.twipsToPixels = TileManager.tileSize / tileWidthTwips;
		app.pixelsToTwips = 1 / app.twipsToPixels;
		app.tile.size.pX = app.tile.size.pY = TileManager.tileSize;

		if (this._docType === 'spreadsheet')
			this._syncTileContainerSize();
	},

	_checkSpreadSheetBounds: function (newZoom) {
		// for spreadsheets, when the document is smaller than the viewing area
		// we want it to be glued to the row/column headers instead of being centered
		// In the future we probably want to remove this and set the bonds only on the
		// left/upper side of the spreadsheet so that we can have an 'infinite' number of
		// cells downwards and to the right, like we have on desktop
		var viewSize = this._map.getSize();
		var scale = this._map.getZoomScale(newZoom);
		var width = app.file.size.x / app.tile.size.x * TileManager.tileSize * scale;
		var height = app.file.size.y / app.tile.size.y * TileManager.tileSize * scale;
		if (width < viewSize.x || height < viewSize.y) {
			// if after zoomimg the document becomes smaller than the viewing area
			width = Math.max(width, viewSize.x);
			height = Math.max(height, viewSize.y);
			if (!this._map.options._origMaxBounds) {
				this._map.options._origMaxBounds = this._map.options.maxBounds;
			}
			scale = this._map.options.crs.scale(1);
			this._map.setMaxBounds(new L.LatLngBounds(
				this._map.unproject(new L.Point(0, 0)),
				this._map.unproject(new L.Point(width * scale, height * scale))));
		}
		else if (this._map.options._origMaxBounds) {
			// if after zoomimg the document becomes larger than the viewing area
			// we need to restore the initial bounds
			this._map.setMaxBounds(this._map.options._origMaxBounds);
			this._map.options._origMaxBounds = null;
		}
	},

	_moveStart: function () {
		TileManager.resetPreFetching();
		this._moveInProgress = true;
		this._moveTileRequests = [];
	},

	_move: function () {
		// We throttle the "move" event, but in moveEnd we always call
		// a _move anyway, so if there are throttled moves still
		// pending by the time moveEnd is called then there is no point
		// processing them after _moveEnd because we are up to date
		// already when they arrive and to do would just duplicate tile
		// requests
		if (!this._moveInProgress)
			return;

		TileManager.update();
		TileManager.resetPreFetching(true);
	},

	_isLatLngInView: function (position) {
		var centerOffset = this._map._getCenterOffset(position);
		var viewHalf = this._map.getSize()._divideBy(2);
		var positionInView =
			centerOffset.x > -viewHalf.x && centerOffset.x < viewHalf.x &&
			centerOffset.y > -viewHalf.y && centerOffset.y < viewHalf.y;
		return positionInView;
	},

	_moveEnd: function () {
		this._move();
		this._moveInProgress = false;
		this._moveTileRequests = [];
		app.updateFollowingUsers();
	},

	_requestNewTiles: function () {
		this.handleInvalidateTilesMsg('invalidatetiles: EMPTY');
		TileManager.update();
	},

	_sendClientZoom: function (forceUpdate) {
		if (!this._map._docLoaded)
			return;

		var newClientZoom = 'tilepixelwidth=' + TileManager.tileSize + ' ' +
		    'tilepixelheight=' + TileManager.tileSize + ' ' +
		    'tiletwipwidth=' + app.tile.size.x + ' ' +
		    'tiletwipheight=' + app.tile.size.y + ' ' +
		    'dpiscale=' + window.devicePixelRatio + ' ' +
		    'zoompercent=' + this._map.getZoomPercent()

		if (this._clientZoom !== newClientZoom || forceUpdate) {
			// the zoom level has changed
			app.socket.sendMessage('clientzoom ' + newClientZoom);

			if (!this._map._fatal && app.idleHandler._active && app.socket.connected())
				this._clientZoom = newClientZoom;
		}
	},

	_twipsRectangleToPixelBounds: function (strRectangle) {
		// TODO use this more
		// strRectangle = x, y, width, height
		var strTwips = strRectangle.match(/\d+/g);
		if (!strTwips) {
			return null;
		}
		var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
		var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
		var bottomRightTwips = topLeftTwips.add(offset);
		return new L.Bounds(
			this._twipsToPixels(topLeftTwips),
			this._twipsToPixels(bottomRightTwips));
	},

	_twipsRectanglesToPixelBounds: function (strRectangles) {
		// used when we have more rectangles
		strRectangles = strRectangles.split(';');
		var boundsList = [];
		for (var i = 0; i < strRectangles.length; i++) {
			var bounds = this._twipsRectangleToPixelBounds(strRectangles[i]);
			if (bounds) {
				boundsList.push(bounds);
			}
		}
		return boundsList;
	},

	getMaxDocSize: function () {
		return undefined;
	},

	getSnapDocPosX: function (docPosPixX) {
		return docPosPixX;
	},

	getSnapDocPosY: function (docPosPixY) {
		return docPosPixY;
	},

	getSplitPanesContext: function () {
		return undefined;
	},

	_createNewMouseEvent: function (type, inputEvent) {
		var event = inputEvent;
		if (inputEvent.type == 'touchstart' || inputEvent.type == 'touchmove') {
			event = inputEvent.touches[0];
		}
		else if (inputEvent.type == 'touchend') {
			event = inputEvent.changedTouches[0];
		}
		var newEvent = document.createEvent('MouseEvents');
		newEvent.initMouseEvent(
			type, true, true, window, 1,
			event.screenX, event.screenY,
			event.clientX, event.clientY,
			false, false, false, false, 0, null
		);
		return newEvent;
	},

	_getToolbarCommandsValues: function() {
		for (var i = 0; i < this._map.unoToolbarCommands.length; i++) {
			var command = this._map.unoToolbarCommands[i];
			app.socket.sendMessage('commandvalues command=' + command);
		}
	},

	_parseCellRange: function(cellRange) {
		var strTwips = cellRange.match(/\d+/g);
		var startCellAddress = [parseInt(strTwips[0]), parseInt(strTwips[1])];
		var endCellAddress = [parseInt(strTwips[2]), parseInt(strTwips[3])];
		return new L.Bounds(startCellAddress, endCellAddress);
	},

	_cellRangeToTwipRect: function(cellRange) {
		var startCell = cellRange.getTopLeft();
		var startCellRectPixel = this.sheetGeometry.getCellRect(startCell.x, startCell.y);
		var topLeftTwips = this._corePixelsToTwips(startCellRectPixel.min);
		var endCell = cellRange.getBottomRight();
		var endCellRectPixel = this.sheetGeometry.getCellRect(endCell.x, endCell.y);
		var bottomRightTwips = this._corePixelsToTwips(endCellRectPixel.max);
		return new L.Bounds(topLeftTwips, bottomRightTwips);
	},

	_onMessage: function (textMsg, img) {
		this._saveMessageForReplay(textMsg);
		// 'tile:' is the most common message type; keep this the first.
		if (textMsg.startsWith('tile:') || textMsg.startsWith('delta:')) {
			TileManager.onTileMsg(textMsg, img);
		}
		else if (textMsg.startsWith('commandvalues:')) {
			this._onCommandValuesMsg(textMsg);
		}
		else if (textMsg.startsWith('cursorvisible:')) {
			this._onCursorVisibleMsg(textMsg);
		}
		else if (textMsg.startsWith('downloadas:')) {
			this._onDownloadAsMsg(textMsg);
		}
		else if (textMsg.startsWith('error:')) {
			this._onErrorMsg(textMsg);
		}
		else if (textMsg.startsWith('getchildid:')) {
			this._onGetChildIdMsg(textMsg);
		}
		else if (textMsg.startsWith('shapeselectioncontent:')) {
			GraphicSelection.onShapeSelectionContent(textMsg);
		}
		else if (textMsg.startsWith('graphicselection:')) {
			this._map.fire('resettopbottompagespacing');
			GraphicSelection.onMessage(textMsg);
		}
		else if (textMsg.startsWith('graphicinnertextarea:')) {
			return; // Not used.
		}
		else if (textMsg.startsWith('cellcursor:')) {
			this._onCellCursorMsg(textMsg);
		}
		else if (textMsg.startsWith('celladdress:')) {
			this._onCellAddressMsg(textMsg);
		}
		else if (textMsg.startsWith('cellformula:')) {
			this._onCellFormulaMsg(textMsg);
		}
		else if (textMsg.startsWith('referencemarks:')) {
			this._onReferencesMsg(textMsg);
		}
		else if (textMsg.startsWith('referenceclear:')) {
			this._clearReferences();
		}
		else if (textMsg.startsWith('invalidatecursor:')) {
			this._onInvalidateCursorMsg(textMsg);
		}
		else if (textMsg.startsWith('invalidatetiles:')) {
			console.error("Message should be filterd during slurp");
		}
		else if (textMsg.startsWith('mousepointer:')) {
			this._onMousePointerMsg(textMsg);
		}
		else if (textMsg.startsWith('renderfont:')) {
			this._onRenderFontMsg(textMsg, img);
		}
		else if (textMsg.startsWith('searchnotfound:')) {
			this._onSearchNotFoundMsg(textMsg);
		}
		else if (textMsg.startsWith('searchresultselection:')) {
			this._onSearchResultSelection(textMsg);
		}
		else if (textMsg.startsWith('setpart:')) {
			this._onSetPartMsg(textMsg);
		}
		else if (textMsg.startsWith('statechanged:')) {
			this._onStateChangedMsg(textMsg);
		}
		else if (textMsg.startsWith('status:') || textMsg.startsWith('statusupdate:')) {
			this._onStatusMsg(textMsg);

			// update tiles and selection because mode could be changed
			TileManager.update();
			app.definitions.otherViewGraphicSelectionSection.updateVisibilities();
			app.definitions.otherViewCursorSection.updateVisibilities();
			this.updateAllTextViewSelection();
		}
		else if (textMsg.startsWith('textselection:')) {
			this._onTextSelectionMsg(textMsg);
		}
		else if (textMsg.startsWith('textselectioncontent:')) {
			let textMsgContent = textMsg.substr(22);
			let textMsgHtml = '';
			let textMsgPlainText = '';
			if (textMsgContent.startsWith('{')) {
				// Multiple formats: JSON.
				let textMsgJson = JSON.parse(textMsgContent);
				textMsgHtml = textMsgJson['text/html'];
				textMsgPlainText = textMsgJson['text/plain;charset=utf-8'];
			} else {
				// Single format: as-is.
				textMsgHtml = textMsgContent;
			}
			const hyperlinkTextBox = document.getElementById('hyperlink-text-box');
			if (hyperlinkTextBox) {
				// Hyperlink dialog is open, the text selection is for the link text
				// widget.
				const extracted = this._map.extractContent(textMsgHtml);
				hyperlinkTextBox.value = extracted.trim();

				const hyperlinkLinkBoxInput = document.getElementById('hyperlink-link-box-input');
				if (extracted !== '' && hyperlinkLinkBoxInput) {
					hyperlinkLinkBoxInput.focus();
				}
			} else if (this._map._clip) {
				this._map._clip.setTextSelectionHTML(textMsgHtml, textMsgPlainText);
			} else
				// hack for ios and android to get selected text into hyperlink insertion dialog
				this._selectedTextContent = textMsgHtml;
		}
		else if (textMsg.startsWith('clipboardchanged')) {
			var jMessage = textMsg.substr(17);
			jMessage = JSON.parse(jMessage);

			if (jMessage.mimeType === 'text/plain') {
				this._map._clip.setTextSelectionHTML(jMessage.content);

				// If _navigatorClipboardWrite is available, use it.
				if (L.Browser.clipboardApiAvailable || window.ThisIsTheiOSApp)
					this._map.fire('clipboardchanged', { commandName: '.uno:CopyHyperlinkLocation' });
				else // Or use previous method.
					this._map._clip._execCopyCutPaste('copy');
			}
		}
		else if (textMsg.startsWith('textselectionend:')) {
			this._onTextSelectionEndMsg(textMsg);
		}
		else if (textMsg.startsWith('textselectionstart:')) {
			this._onTextSelectionStartMsg(textMsg);
		}
		else if (textMsg.startsWith('cellselectionarea:')) {
			this._onCellSelectionAreaMsg(textMsg);
		}
		else if (textMsg.startsWith('cellautofillarea:')) {
			this._onCellAutoFillAreaMsg(textMsg);
		}
		else if (textMsg.startsWith('complexselection:')) {
			if (this._map._clip)
				this._map._clip.onComplexSelection(textMsg.substr('complexselection:'.length));
		}
		else if (textMsg.startsWith('windowpaint:')) {
			this._onDialogPaintMsg(textMsg, img);
		}
		else if (textMsg.startsWith('window:')) {
			this._onDialogMsg(textMsg);
		}
		else if (textMsg.startsWith('unocommandresult:')) {
			this._onUnoCommandResultMsg(textMsg);
		}
		else if (textMsg.startsWith('hrulerupdate:')) {
			this._onRulerUpdate(textMsg);
		}
		else if (textMsg.startsWith('vrulerupdate:')) {
			this._onRulerUpdate(textMsg);
		}
		else if (textMsg.startsWith('contextmenu:')) {
			this._onContextMenuMsg(textMsg);
		}
		else if (textMsg.startsWith('invalidateviewcursor:')) {
			this._onInvalidateViewCursorMsg(textMsg);
		}
		else if (textMsg.startsWith('viewcursorvisible:')) {
			this._onViewCursorVisibleMsg(textMsg);
		}
		else if (textMsg.startsWith('cellviewcursor:')) {
			this._onCellViewCursorMsg(textMsg);
		}
		else if (textMsg.startsWith('viewinfo:')) {
			this._onViewInfoMsg(textMsg);
		}
		else if (textMsg.startsWith('textviewselection:')) {
			this._onTextViewSelectionMsg(textMsg);
		}
		else if (textMsg.startsWith('graphicviewselection:')) {
			this._onGraphicViewSelectionMsg(textMsg);
		}
		else if (textMsg.startsWith('tableselected:')) {
			this._onTableSelectedMsg(textMsg);
		}
		else if (textMsg.startsWith('editor:')) {
			this._updateEditor(textMsg);
		}
		else if (textMsg.startsWith('validitylistbutton:')) {
			this._onValidityListButtonMsg(textMsg);
		}
		else if (textMsg.startsWith('validityinputhelp:')) {
			this._onValidityInputHelpMsg(textMsg);
		}
		else if (textMsg.startsWith('signaturestatus:')) {
			var signstatus = textMsg.substring('signaturestatus:'.length + 1);
			this._map.onChangeSignStatus(signstatus);
		}
		else if (textMsg.startsWith('removesession')) {
			var viewId = parseInt(textMsg.substring('removesession'.length + 1));
			if (this._map._docLayer._viewId === viewId)
				app.dispatcher.dispatch('closeapp');
		}
		else if (textMsg.startsWith('calcfunctionlist:')) {
			this._onCalcFunctionListMsg(textMsg.substring('calcfunctionlist:'.length + 1));
		}
		else if (textMsg.startsWith('tooltip:')) {
			var tooltipInfo = JSON.parse(textMsg.substring('tooltip:'.length + 1));
			if (tooltipInfo.type === 'formulausage') {
				this._onCalcFunctionUsageMsg(tooltipInfo.text);
			}
			else if (tooltipInfo.type === 'generaltooltip') {
				var tooltipInfo = JSON.parse(textMsg.substring(textMsg.indexOf('{')));
				this._map.uiManager.showDocumentTooltip(tooltipInfo);
			}
			else if (tooltipInfo.type === 'autofillpreviewtooltip') {

				var strTwips = textMsg.match(/\d+/g);
				if (strTwips != null && this._map.isEditMode())
					this._map.fire('openautofillpreviewpopup', { data: tooltipInfo });
			}
			else {
				console.error('unknown tooltip type');
			}
		}
		else if (textMsg.startsWith('tabstoplistupdate:')) {
			this._onTabStopListUpdate(textMsg);
		}
		else if (textMsg.startsWith('context:')) {
			var message = textMsg.substring('context:'.length + 1);
			message = message.split(' ');
			if (message.length > 1) {
				var old = this._map.context || {};
				var newContext = {appId: message[0], context: message[1]};
				if (old.appId !== newContext.appId || old.context !== newContext.context) {
					this._map.context = newContext;
					app.events.fire('contextchange', {
						appId: newContext.appId, context: newContext.context,
						oldAppId: old.appId, oldContext: old.context
					});
				}
			}
		}
		else if (textMsg.startsWith('formfieldbutton:')) {
			this._onFormFieldButtonMsg(textMsg);
		}
		else if (textMsg.startsWith('canonicalidchange:')) {
			var payload = textMsg.substring('canonicalidchange:'.length + 1);
			var viewRenderedState = payload.split('=')[3].split(' ')[0];
			if (this._debug.overlayOn) {
				var viewId = payload.split('=')[1].split(' ')[0];
				var canonicalId = payload.split('=')[2].split(' ')[0];
				this._debug.setOverlayMessage('canonicalViewId',
					'Canonical id changed to: ' + canonicalId + ' for view id: ' + viewId + ' with view renderend state: ' + viewRenderedState
				);
			}
			if (!this._canonicalIdInitialized) {
				this._canonicalIdInitialized = true;
				TileManager.update();
			} else {
				this._requestNewTiles();
				this._invalidateAllPreviews();
				TileManager.redraw();
			}
		}
		else if (textMsg.startsWith('comment:')) {
			var obj = JSON.parse(textMsg.substring('comment:'.length + 1));
			app.sectionContainer.getSectionWithName(L.CSections.CommentList.name).onACKComment(obj);
		}
		else if (textMsg.startsWith('redlinetablemodified:')) {
			obj = JSON.parse(textMsg.substring('redlinetablemodified:'.length + 1));
			app.sectionContainer.getSectionWithName(L.CSections.CommentList.name).onACKComment(obj);
		}
		else if (textMsg.startsWith('redlinetablechanged:')) {
			obj = JSON.parse(textMsg.substring('redlinetablechanged:'.length + 1));
			app.sectionContainer.getSectionWithName(L.CSections.CommentList.name).onACKComment(obj);
		}
		else if (textMsg.startsWith('applicationbackgroundcolor:')) {
			app.sectionContainer.setClearColor('#' + textMsg.substring('applicationbackgroundcolor:'.length + 1).trim());
			app.sectionContainer.requestReDraw();
		}
		else if (textMsg.startsWith('documentbackgroundcolor:')) {
			app.sectionContainer.setDocumentBackgroundColor('#' + textMsg.substring('documentbackgroundcolor:'.length + 1).trim());
		}
		else if (textMsg.startsWith('contentcontrol:')) {
			textMsg = textMsg.substring('contentcontrol:'.length + 1);
			if (!app.sectionContainer.doesSectionExist(L.CSections.ContentControl.name)) {
				app.sectionContainer.addSection(new cool.ContentControlSection());
			}
			var section = app.sectionContainer.getSectionWithName(L.CSections.ContentControl.name);
			section.drawContentControl(JSON.parse(textMsg));
		}
		else if (textMsg.startsWith('versionbar:')) {
			obj = JSON.parse(textMsg.substring('versionbar:'.length + 1));
			this._map.fire('versionbar', obj);
		}
		else if (textMsg.startsWith('lockaccessibilityon')) {
			// a11y forced on by DocumentBroker, from view settings overrides.
			this._map.lockAccessibilityOn();
		}
		else if (textMsg.startsWith('a11y')) {
			if (!window.prefs.getBoolean('accessibilityState'))
				throw 'A11y events come from the core while it is disabled in the client session.';

			if (textMsg.startsWith('a11yfocuschanged:')) {
				obj = JSON.parse(textMsg.substring('a11yfocuschanged:'.length + 1));
				var listPrefixLength = obj.listPrefixLength !== undefined ? parseInt(obj.listPrefixLength) : 0;
				this._map._textInput.onAccessibilityFocusChanged(
					obj.content, parseInt(obj.position), parseInt(obj.start), parseInt(obj.end),
					listPrefixLength, parseInt(obj.force) > 0);
			}
			else if (textMsg.startsWith('a11ycaretchanged:')) {
				obj = JSON.parse(textMsg.substring('a11yfocuschanged:'.length + 1));
				this._map._textInput.onAccessibilityCaretChanged(parseInt(obj.position));
			}
			else if (textMsg.startsWith('a11ytextselectionchanged:')) {
				obj = JSON.parse(textMsg.substring('a11ytextselectionchanged:'.length + 1));
				this._map._textInput.onAccessibilityTextSelectionChanged(parseInt(obj.start), parseInt(obj.end));
			}
			else if (textMsg.startsWith('a11yfocusedcellchanged:')) {
				obj = JSON.parse(textMsg.substring('a11yfocusedcellchanged:'.length + 1));
				var outCount = obj.outCount !== undefined ? parseInt(obj.outCount) : 0;
				var inList = obj.inList !== undefined ? obj.inList : [];
				var row = parseInt(obj.row);
				var col = parseInt(obj.col);
				var rowSpan = obj.rowSpan !== undefined ? parseInt(obj.rowSpan) : 1;
				var colSpan = obj.colSpan !== undefined ? parseInt(obj.colSpan) : 1;
				this._map._textInput.onAccessibilityFocusedCellChanged(
					outCount, inList, row, col, rowSpan, colSpan, obj.paragraph);
			}
			else if (textMsg.startsWith('a11yeditinginselectionstate:')) {
				obj = JSON.parse(textMsg.substring('a11yeditinginselectionstate:'.length + 1));
				this._map._textInput.onAccessibilityEditingInSelectionState(
					parseInt(obj.cell) > 0, parseInt(obj.enabled) > 0, obj.selection, obj.paragraph);
			}
			else if (textMsg.startsWith('a11yselectionchanged:')) {
				obj = JSON.parse(textMsg.substring('a11yselectionchanged:'.length + 1));
				this._map._textInput.onAccessibilitySelectionChanged(
					parseInt(obj.cell) > 0, obj.action, obj.name, obj.text);
			}
			else if (textMsg.startsWith('a11yfocusedparagraph:')) {
				obj = JSON.parse(textMsg.substring('a11yfocusedparagraph:'.length + 1));
				this._map._textInput.setA11yFocusedParagraph(
					obj.content, parseInt(obj.position), parseInt(obj.start), parseInt(obj.end));
			}
			else if (textMsg.startsWith('a11ycaretposition:')) {
				var pos = textMsg.substring('a11ycaretposition:'.length + 1);
				this._map._textInput.setA11yCaretPosition(parseInt(pos));
			}
		}
		else if (textMsg.startsWith('colorpalettes:')) {
			var json = JSON.parse(textMsg.substring('colorpalettes:'.length + 1));

			for (var key in json) {
				if(key === 'ColorNames') {
					window.app.colorNames = json[key];
					continue;
				}
				if (app.colorPalettes[key]) {
					app.colorPalettes[key].colors = json[key];
				} else {
					window.app.console.warn('Unknown palette: "' + key + '"');
				}
			}

			// Remove empty palettes, eg. Document colors in Impress are empty
			for (var key in app.colorPalettes) {
				if (!app.colorPalettes[key].colors || !app.colorPalettes[key].colors.length) {
					delete app.colorPalettes[key];
				}
			}
		} else if (textMsg.startsWith('serveraudit:')) {
			var serverAudit = textMsg.substr(12).trim();
			if (serverAudit !== 'disabled') {
				// if isAdminUser property is not set by integration - enable audit dialog for all users
				if (app.isAdminUser !== false)
					this._map.serverAuditDialog = JSDialog.serverAuditDialog(this._map);

				var json = JSON.parse(serverAudit);
				app.setServerAuditFromCore(json.serverAudit);
			}
		} else if (textMsg.startsWith('adminuser:')) {
			var value = textMsg.substr(10).trim();
			if (value === 'true')
				app.isAdminUser = true;
			else if (value === 'false')
				app.isAdminUser = false;
			else
				app.isAdminUser = null;

			this._map.fire('adminuser');
		} else if (textMsg.startsWith('presentationinfo:')) {
			var content = JSON.parse(textMsg.substring('presentationinfo:'.length + 1));
			this._map.fire('presentationinfo', content);
		}
	},

	_onInvalidateTilesMsg: function (textMsg) {
		const command = app.socket.parseServerCmd(textMsg);
		if (command.x === undefined || command.y === undefined || command.part === undefined) {
			var strTwips = textMsg.match(/\d+/g);
			command.x = parseInt(strTwips[0]);
			command.y = parseInt(strTwips[1]);
			command.width = parseInt(strTwips[2]);
			command.height = parseInt(strTwips[3]);
			command.part = this._selectedPart;
		}

		if (isNaN(command.mode))
			command.mode = this._selectedMode;

		const invalidArea = new app.definitions.simpleRectangle(command.x, command.y, command.width, command.height);
		TileManager.overlapInvalidatedRectangleWithView(command.part, command.mode, command.wireId, invalidArea, textMsg);

		if (this._docType === 'presentation' || this._docType === 'drawing') {
			if (command.part === this._selectedPart &&
				command.mode === this._selectedMode &&
				command.part !== this._lastValidPart) {
				this._map.fire('updatepart', {part: this._lastValidPart, docType: this._docType});
				this._lastValidPart = command.part;
				this._map.fire('updatepart', {part: command.part, docType: this._docType});
			}

			const preview = this._map._docPreviews ? this._map._docPreviews[command.part] : null;
			if (preview) { preview.invalid = true; }

			const topLeftTwips = new L.Point(command.x, command.y);
			const offset = new L.Point(command.width, command.height);
			const bottomRightTwips = topLeftTwips.add(offset);
			this._previewInvalidations.push(new L.Bounds(topLeftTwips, bottomRightTwips));
			// 1s after the last invalidation, update the preview
			clearTimeout(this._previewInvalidator);
			this._previewInvalidator = setTimeout(L.bind(this._invalidatePreviews, this), this.options.previewInvalidationTimeout);
		}
	},

	handleInvalidateTilesMsg: function(textMsg) {
		var payload = textMsg.substring('invalidatetiles:'.length + 1);
		if (!payload.startsWith('EMPTY')) {
			this._onInvalidateTilesMsg(textMsg);
		}
		else {
			var msg = 'invalidatetiles: ';

			// see invalidatetiles: in wsd/protocol.txt for structure
			var tmp = payload.substring('EMPTY'.length).replaceAll(',', ' , ');
			var tokens = tmp.split(/[ \n]+/);

			var wireIdToken = undefined;
			var commaargs = [];

			var commaarg = false;
			for (var i = 0; i < tokens.length; i++) {
				if (tokens[i] === ',') {
					commaarg = true;
					continue;
				}
				if (commaarg) {
					commaargs.push(tokens[i]);
					commaarg = false;
				}
				else if (tokens[i].startsWith('wid=')) {
					wireIdToken = tokens[i];
				}
				else if (tokens[i])
					console.error('unsupported invalidatetile token: ' + tokens[i]);
			}

			if (this.isWriter()) {
				msg += 'part=0 ';
			} else {

				var part = parseInt(commaargs.length > 0 ? commaargs[0] : '');
				var mode = parseInt(commaargs.length > 1 ? commaargs[1] : '');

				mode = (isNaN(mode) ? this._selectedMode : mode);
				msg += 'part=' + (isNaN(part) ? this._selectedPart : part)
					+ ((mode && mode !== 0) ? (' mode=' + mode) : '')
					+ ' ';
			}
			msg += 'x=0 y=0 ';
			msg += 'width=' + app.file.size.x + ' ';
			msg += 'height=' + app.file.size.y;
			if (wireIdToken !== undefined)
				msg += ' ' + wireIdToken;
			this._onInvalidateTilesMsg(msg);
		}
	},

	// Process messages early that won't mess with the DOM
	filterSlurpedMessage: function(evt) {
		var textMsg = evt.textMsg;

		if (textMsg.startsWith('invalidatetiles:')) {
			app.socket._logSocket('INCOMING', textMsg);
			this.handleInvalidateTilesMsg(textMsg);
			return true; // filter
		}

		return false; // continue processing
	},

	_onTabStopListUpdate: function (textMsg) {
		textMsg = textMsg.substring('tabstoplistupdate:'.length + 1);
		var json = JSON.parse(textMsg);
		this._map.fire('tabstoplistupdate', json);
	},

	_onCommandValuesMsg: function (textMsg) {
		var jsonIdx = textMsg.indexOf('{');
		if (jsonIdx === -1) {
			return;
		}
		var obj = JSON.parse(textMsg.substring(jsonIdx));
		if (obj.commandName === '.uno:DocumentRepair') {
			this._onDocumentRepair(obj);
		}
		else if (obj.commandName === '.uno:CellCursor') {
			this._onCellCursorMsg(obj.commandValues);
		}
		else if (this._map.unoToolbarCommands.indexOf(obj.commandName) !== -1) {
			this._toolbarCommandValues[obj.commandName] = obj.commandValues;
			this._map.fire('updatetoolbarcommandvalues', {
				commandName: obj.commandName,
				commandValues: obj.commandValues
			});
		}
		else {
			this._map.fire('commandvalues', {
				commandName: obj.commandName,
				commandValues: obj.commandValues
			});
		}
	},

	_onCellAddressMsg: function (textMsg) {
		// When the user moves the focus to a different cell, a 'cellformula'
		// message is received from coolwsd, *then* a 'celladdress' message.
		var address = textMsg.substring(13);
		if (this._map._clip && !this._map['wopi'].DisableCopy) {
			this._map._clip.setTextSelectionText(this._lastFormula);
		}
		this._map.fire('celladdress', {address: address});
	},

	_onCellFormulaMsg: function (textMsg) {
		// When a 'cellformula' message from coolwsd is received,
		// store the text contents of the cell, but don't push
		// them to the clipboard container (yet).
		// This is done because coolwsd will send several 'cellformula'
		// messages during text composition, and resetting the contents
		// of the clipboard container mid-composition will easily break it.

		let newFormula = textMsg.substring(13);
		if (this._lastFormula) {
			let minLength = Math.min(newFormula.length, this._lastFormula.length);
			let index = -1;
			for (let i = 0; i < minLength; i++) {
				if (newFormula.charAt(i) !== this._lastFormula.charAt(i)) {
					index = i;
					break;
				}
			}

			if (index === -1)
				index = newFormula.length-1;

			// newFormulaDiffIndex have index of last added character in formula
			// It is used during Formula Autocomplete to find partial remaining text
			this._newFormulaDiffIndex = index;
		}
		this._lastFormula = newFormula;
		this._map.fire('cellformula', {formula: newFormula});
	},

	_onCalcFunctionUsageMsg: function (textMsg) {
		this._map.fire('closepopup');
		this._map.fire('sendformulausagetext', {data: textMsg});
	},

	_onCalcFunctionListMsg: function (textMsg) {
		if (textMsg.startsWith('hidetip')) {
			this._map.fire('closepopup');
		} else {
			var funcData = JSON.parse(textMsg);

			if (window.mode.isMobile()) {
				this._closeMobileWizard();

				var data = {
					id: 'funclist',
					type: '',
					text: _('Functions'),
					enabled: true,
					children: []
				};

				if (funcData.categories)
					this._onCalcFunctionListWithCategories(funcData, data);
				else
					this._onCalcFunctionList(funcData, data);

				if (funcData.wholeList)
					this._map._functionWizardData = data;

				this._openMobileWizard(data);
			}
			else {
				var functionList = this._getFunctionList(textMsg);
				this._map.fire('sendformulatext', {data: functionList});
			}
		}
	},

	_getCalcFunctionListEntry: function(name, category, index, signature, description) {
		return  {
			id: '',
			type: 'calcfuncpanel',
			text: name,
			functionName: name,
			index: index,
			category: category,
			enabled: true,
			children: [
				{
					id: '',
					type: 'fixedtext',
					html: '<div class="func-info-sig">' + signature + '</div>' + '<div class="func-info-desc">' + description + '</div>',
					enabled: true,
					style: 'func-info'
				}
			]
		};
	},

	_onCalcFunctionList: function (funcList, data) {
		var entries = data.children;
		for (var idx = 0; idx < funcList.length; ++idx) {
			var func =  funcList[idx];
			var name = func.signature.split('(')[0];
			entries.push(this._getCalcFunctionListEntry(
				name, undefined, func.index, func.signature, func.description));
		}
	},

	_onCalcFunctionListWithCategories: function (funcData, data) {
		var categoryList = funcData.categories;
		var categoryEntries = data.children;
		for (var idx = 0; idx < categoryList.length; ++idx) {
			var category = categoryList[idx];
			var categoryEntry = {
				id: '',
				type: 'panel',
				text: category.name,
				index: idx,
				enabled: true,
				children: []
			};
			categoryEntries.push(categoryEntry);
		}

		var funcList = funcData.functions;
		for (idx = 0; idx < funcList.length; ++idx) {
			var func =  funcList[idx];
			var name = func.signature.split('(')[0];
			var funcEntries = categoryEntries[func.category].children;
			funcEntries.push(this._getCalcFunctionListEntry(
				name, func.category, func.index, func.signature, func.description));
		}
	},

	_onCursorVisibleMsg: function(textMsg) {
		var command = textMsg.match('cursorvisible: true');
		app.setCursorVisibility(command ? true : false);
		this._onUpdateCursor();
		app.events.fire('TextCursorVisibility', { visible: app.file.textCursor.visible });
	},

	_onDownloadAsMsg: function (textMsg) {
		var command = app.socket.parseServerCmd(textMsg);
		var parser = document.createElement('a');
		parser.href = window.host;

		var url = window.makeHttpUrlWopiSrc('/' + this._map.options.urlPrefix + '/',
			this._map.options.doc, '/download/' + command.downloadid);

		this._map.hideBusy();
		if (this._map['wopi'].DownloadAsPostMessage) {
			this._map.fire('postMessage', {msgId: 'Download_As', args: {Type: command.id, URL: url}});
		}
		else if (command.id === 'print') {
			if (this._map.options.print === false || L.Browser.cypressTest) {
				// open the pdf in a new tab, it can be printed directly in the browser's pdf viewer
				url = window.makeHttpUrlWopiSrc('/' + this._map.options.urlPrefix + '/',
					this._map.options.doc, '/download/' + command.downloadid,
					'attachment=0');

				if ('processCoolUrl' in window) {
					url = window.processCoolUrl({ url: url, type: 'print' });
				}

				window.open(url, '_blank');
			}
			else {
				if ('processCoolUrl' in window) {
					url = window.processCoolUrl({ url: url, type: 'print' });
				}

				this._map.fire('filedownloadready', {url: url});
			}
		}
		else if (command.id === 'slideshow') {
			this._map.fire('slidedownloadready', {url: url});
		}
		else if (command.id === 'export') {
			if ('processCoolUrl' in window) {
				url = window.processCoolUrl({ url: url, type: 'export' });
			}

			// Don't do a real download during testing
			if (!L.Browser.cypressTest)
				this._map._fileDownloader.src = url;
			else
				this._map._fileDownloader.setAttribute('data-src', url);
		}
	},

	_onErrorMsg: function (textMsg) {
		var command = app.socket.parseServerCmd(textMsg);

		// let's provide some convenience error codes for the UI
		var errorId = 1; // internal error
		if (command.errorCmd === 'load') {
			errorId = 2; // document cannot be loaded
		}
		else if (command.errorCmd === 'save' || command.errorCmd === 'saveas') {
			errorId = 5; // document cannot be saved
		}

		var errorCode = -1;
		if (command.errorCode !== undefined) {
			errorCode = command.errorCode;
		}

		this._map.fire('error', {cmd: command.errorCmd, kind: command.errorKind, id: errorId, code: errorCode});
	},

	_onGetChildIdMsg: function (textMsg) {
		var command = app.socket.parseServerCmd(textMsg);
		this._map.fire('childid', {id: command.id});
	},

	_openMobileWizard: function(data) {
		this._map.fire('mobilewizard', {data: data});
	},

	_closeMobileWizard: function() {
		this._map.fire('closemobilewizard');
	},

	_onGraphicViewSelectionMsg: function (textMsg) {
		var obj = JSON.parse(textMsg.substring('graphicviewselection:'.length + 1));
		var viewId = parseInt(obj.viewId);

		// Ignore if viewid is ours or not in our db
		if (viewId === this._viewId || !this._map._viewInfo[viewId]) {
			return;
		}

		var strTwips = obj.selection.match(/\d+/g);

		app.definitions.otherViewGraphicSelectionSection.addOrUpdateGraphicSelectionIndicator(viewId, strTwips, parseInt(obj.part), obj.mode !== undefined ? parseInt(obj.mode): 0);

		if (this.isCalc()) {
			this._saveMessageForReplay(textMsg, viewId);
		}
	},

	_onCellCursorMsg: function (textMsg) {
		var autofillMarkerSection = app.sectionContainer.getSectionWithName(L.CSections.AutoFillMarker.name);

		var oldCursorAddress = app.calc.cellAddress.clone();

		if (textMsg.match('EMPTY')) {
			app.calc.cellCursorVisible = false;
			if (autofillMarkerSection)
				autofillMarkerSection.calculatePositionViaCellCursor(null);
			if (this._map._clip)
				this._map._clip.clearSelection();
		}
		else {
			var strTwips = textMsg.match(/\d+/g);
			var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
			var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
			var bottomRightTwips = topLeftTwips.add(offset);
			let _cellCursorTwips = this._convertToTileTwipsSheetArea(new L.Bounds(topLeftTwips, bottomRightTwips));

			app.calc.cellAddress = new app.definitions.simplePoint(parseInt(strTwips[4]), parseInt(strTwips[5]));
			let tempRectangle = _cellCursorTwips.toRectangle();
			app.calc.cellCursorRectangle = new app.definitions.simpleRectangle(tempRectangle[0], tempRectangle[1], tempRectangle[2], tempRectangle[3]);
			this._cellCursorSection.size[0] = app.calc.cellCursorRectangle.pWidth;
			this._cellCursorSection.size[1] = app.calc.cellCursorRectangle.pHeight;
			this._cellCursorSection.setPosition(app.calc.cellCursorRectangle.pX1, app.calc.cellCursorRectangle.pY1);
			app.calc.cellCursorVisible = true;

			app.sectionContainer.onCellAddressChanged();
			if (autofillMarkerSection)
				autofillMarkerSection.calculatePositionViaCellCursor([app.calc.cellCursorRectangle.pX2, app.calc.cellCursorRectangle.pY2]);
		}

		var sameAddress = oldCursorAddress.equals(app.calc.cellAddress.toArray());

		var isFollowingOwnCursor = parseInt(app.getFollowedViewId()) === parseInt(this._viewId);
		var notJump = sameAddress || !isFollowingOwnCursor;
		var scrollToCursor = this._sheetSwitch.tryRestore(notJump, this._selectedPart);

		this._onUpdateCellCursor(scrollToCursor, notJump);

		// Remove input help if there is any:
		app.definitions.validityInputHelpSection.removeValidityInputHelp();
	},

	_onDocumentRepair: function (textMsg) {
		if (!this._docRepair) {
			this._docRepair = L.control.documentRepair();
		}

		if (!this._docRepair.isVisible()) {
			this._docRepair.addTo(this._map);
			this._docRepair.fillActions(textMsg);
			this._docRepair.show();
		}
	},

	_onMousePointerMsg: function (textMsg) {
		textMsg = textMsg.substring(14); // "mousepointer: "
		textMsg = Cursor.getCustomCursor(textMsg) || textMsg;
		var mapPane = $('.leaflet-pane.leaflet-map-pane');
		if (mapPane.css('cursor') !== textMsg) {
			mapPane.css('cursor', textMsg);
		}
	},

	_getFunctionList: function(textMsg) {
		var resultList = [];
		var suggestionArray = JSON.parse(textMsg);
		for (var i = 0; i < suggestionArray.length; i++) {
			var signature = suggestionArray[i].signature;
			var namedRange = suggestionArray[i].namedRange;
			var name, description;
			if (namedRange) {
				name = signature;
				description = _('Named Range');
			} else {
				name = signature.substring(0,signature.indexOf('('));
				description = suggestionArray[i].description;
			}
			resultList.push({'name': name, 'description': description, 'namedRange': namedRange});
		}
		return resultList;
	},

	_onInvalidateCursorMsg: function (textMsg) {
		textMsg = textMsg.substring('invalidatecursor:'.length + 1);
		var obj = JSON.parse(textMsg);
		var recCursor = this._getEditCursorRectangle(obj);
		if (recCursor === undefined || this.persistCursorPositionInWriter) {
			this.persistCursorPositionInWriter = false;
			return;
		}

		// tells who trigerred cursor invalidation, but recCursors is still "ours"
		var modifierViewId = parseInt(obj.viewId);
		var weAreModifier = (modifierViewId === this._viewId);
		if (weAreModifier && app.isFollowingOff())
			app.setFollowingUser(this._viewId);

		this._cursorAtMispelledWord = obj.mispelledWord ? Boolean(parseInt(obj.mispelledWord)).valueOf() : false;

		// Remember the last position of the caret (in core pixels).
		this._cursorPreviousPositionCorePixels = app.file.textCursor.rectangle.clone();

		app.file.textCursor.rectangle = new app.definitions.simpleRectangle(recCursor.getTopLeft().x, recCursor.getTopLeft().y, recCursor.getSize().x, recCursor.getSize().y);

		if (this._docType === 'text') {
			app.sectionContainer.onCursorPositionChanged();
		}

		this._map.hyperlinkUnderCursor = obj.hyperlink;
		URLPopUpSection.closeURLPopUp();
		if (obj.hyperlink && obj.hyperlink.link)
			URLPopUpSection.showURLPopUP(obj.hyperlink.link, new app.definitions.simplePoint(app.file.textCursor.rectangle.x1, app.file.textCursor.rectangle.y1));

		if (!this._map.editorHasFocus() && app.file.textCursor.visible && weAreModifier) {
			// Regain cursor if we had been out of focus and now have input.
			// Unless the focus is in the Calc Formula-Bar, don't steal the focus.
			if (!this._map.calcInputBarHasFocus())
				this._map.fire('editorgotfocus');
		}

		//first time document open, set last cursor position
		if (!this.lastCursorPos)
			this.lastCursorPos = app.file.textCursor.rectangle.clone();

		var updateCursor = false;
		if (!this.lastCursorPos.equals(app.file.textCursor.rectangle.toArray())) {
			updateCursor = true;
			this.lastCursorPos = app.file.textCursor.rectangle.clone();
		}

		// If modifier view is different than the current view
		// we'll keep the caret position at the same point relative to screen.
		this._onUpdateCursor(
			/* scroll */ updateCursor && weAreModifier,
			/* zoom */ undefined,
			/* keepCaretPositionRelativeToScreen */ !weAreModifier);

		// Only for reference equality comparison.
		this._lastVisibleCursorRef = app.file.textCursor.rectangle.clone();
	},

	_updateEditor: function(textMsg) {
		textMsg = textMsg.substring('editor:'.length + 1);
		var editorId = parseInt(textMsg);
		var docLayer = this._map._docLayer;

		docLayer._editorId = editorId;

		if (app.isFollowingEditor()) {
			app.setFollowingEditor(editorId);
		}

		if (this._map._viewInfo[editorId])
			this._map.fire('updateEditorName', {username: this._map._viewInfo[editorId].username});
	},

	_onInvalidateViewCursorMsg: function (textMsg) {
		var obj = JSON.parse(textMsg.substring('invalidateviewcursor:'.length + 1));
		var viewId = parseInt(obj.viewId);

		// Ignore if viewid is same as ours or not in our db
		if (viewId === this._viewId || !this._map._viewInfo[viewId]) {
			return;
		}

		const username = this._map._viewInfo[viewId].username;
		const mode = obj.mode ? parseInt(obj.mode): 0;

		let rectangle;
		if (obj.refpoint) {
			let refPoint = obj.refpoint.split(',');
			refPoint = new app.definitions.simplePoint(parseInt(refPoint[0]), parseInt(refPoint[1]));

			if (this.sheetGeometry) {
				this.sheetGeometry.convertToTileTwips(refPoint);

				rectangle = obj.relrect.split(',');
				for (let i = 0; i < rectangle.length; i++) rectangle[i] = parseInt(rectangle[i]);

				rectangle[0] += refPoint.x;
				rectangle[1] += refPoint.y;
			}
		}
		else {
			rectangle = obj.rectangle.split(',');
			for (let i = 0; i < rectangle.length; i++) rectangle[i] = parseInt(rectangle[i]);
		}

		app.definitions.otherViewCursorSection.addOrUpdateOtherViewCursor(viewId, username, rectangle, parseInt(obj.part), mode);

		if (app.getFollowedViewId() === viewId && (app.isFollowingEditor() || app.isFollowingUser())) {
			if (this._map.getDocType() === 'text' || this._map.getDocType() === 'presentation') {
				this.goToViewCursor(viewId);
			}
			else if (this._map.getDocType() === 'spreadsheet') {
				this.goToCellViewCursor(viewId);
			}
		}

		this._saveMessageForReplay(textMsg, viewId);
	},

	_convertRawTwipsToTileTwips: function(strTwips) {
		if (!strTwips)
			return null;

		var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
		var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
		var bottomRightTwips = topLeftTwips.add(offset);
		strTwips = this._convertToTileTwipsSheetArea(new L.Bounds(topLeftTwips, bottomRightTwips)).toRectangle();
		return strTwips;
	},

	_onCellViewCursorMsg: function (textMsg) {
		var obj = JSON.parse(textMsg.substring('cellviewcursor:'.length + 1));
		var viewId = parseInt(obj.viewId);

		// Ignore if viewid is same as ours
		if (viewId === this._viewId) {
			return;
		}

		if (obj.rectangle.match('EMPTY'))
			OtherViewCellCursorSection.removeView(viewId);
		else {
			let strTwips = obj.rectangle.match(/\d+/g);
			strTwips = this._convertRawTwipsToTileTwips(strTwips);

			OtherViewCellCursorSection.addOrUpdateOtherViewCellCursor(viewId, this._map.getViewName(viewId), strTwips, parseInt(obj.part));
			CursorHeaderSection.deletePopUpNow(viewId);
		}

		if (this.isCalc()) {
			this._saveMessageForReplay(textMsg, viewId);
		}
	},

	goToCellViewCursor: function(viewId) {
		if (OtherViewCellCursorSection.doesViewCursorExist(viewId)) {
			const viewCursorSection = OtherViewCellCursorSection.getViewCursorSection(viewId);

			if (this._selectedPart !== viewCursorSection.sectionProperties.part)
				this._map.setPart(viewCursorSection.sectionProperties.part);

			if (!viewCursorSection.isVisible) {
				const scrollX = viewCursorSection.position[0];
				const scrollY = viewCursorSection.position[1];
				this.scrollToPos(new app.definitions.simplePoint(scrollX * app.pixelsToTwips, scrollY * app.pixelsToTwips));
			}

			OtherViewCellCursorSection.showPopUpForView(viewId);
		}
	},

	_onViewCursorVisibleMsg: function(textMsg) {
		textMsg = textMsg.substring('viewcursorvisible:'.length + 1);
		var obj = JSON.parse(textMsg);
		var viewId = parseInt(obj.viewId);

		// Ignore if viewid is same as ours or not in our db
		if (viewId === this._viewId || !this._map._viewInfo[viewId]) {
			return;
		}

		const section = app.definitions.otherViewCursorSection.getViewCursorSection(viewId);
		if (section) {
			const showCursor = obj.visible === 'true';
			section.sectionProperties.showCursor = showCursor;
			section.setShowSection(showCursor);
		}
	},

	_addView: function(viewInfo) {
		if (viewInfo.color === 0 && this._map.getDocType() !== 'text') {
			viewInfo.color = app.LOUtil.getViewIdColor(viewInfo.id);
		}

		this._map.addView(viewInfo);
	},

	_removeView: function(viewId) {
		// Remove selection, if any.
		if (this._viewSelections[viewId]) {
			if (this._viewSelections[viewId].selection) {
				this._viewSelections[viewId].selection.remove();
				this._viewSelections[viewId].selection = undefined;
			}
			delete this._viewSelections[viewId];
		}

		app.definitions.otherViewCursorSection.removeView(viewId);

		OtherViewCellCursorSection.removeView(viewId);
		app.definitions.otherViewGraphicSelectionSection.removeView(viewId);
		this._map.removeView(viewId);
	},

	removeAllViews: function() {
		for (var viewInfoIdx in this._map._viewInfo) {
			this._removeView(parseInt(viewInfoIdx));
		}
	},

	_onViewInfoMsg: function(textMsg) {
		textMsg = textMsg.substring('viewinfo: '.length);
		var viewInfo = JSON.parse(textMsg);
		this._map.fire('viewinfo', viewInfo);

		// A new view
		var viewIds = [];
		for (var viewInfoIdx in viewInfo) {
			if (!(parseInt(viewInfo[viewInfoIdx].id) in this._map._viewInfo)) {
				this._addView(viewInfo[viewInfoIdx]);
			}
			viewIds.push(viewInfo[viewInfoIdx].id);
		}

		// Check if any view is deleted
		for (viewInfoIdx in this._map._viewInfo) {
			if (viewIds.indexOf(parseInt(viewInfoIdx)) === -1) {
				this._removeView(parseInt(viewInfoIdx));
			}
		}

		// Sending postMessage about View_Added / View_Removed is
		// deprecated, going forward we prefer sending the entire information.
		this._map.fire('updateviewslist');
	},

	_onRenderFontMsg: function (textMsg, img) {
		var command = app.socket.parseServerCmd(textMsg);
		this._map.fire('renderfont', {
			font: command.font,
			char: command.char,
			img: img
		});
	},

	_onSearchNotFoundMsg: function (textMsg) {
		this._clearSearchResults();
		var originalPhrase = textMsg.substring(16);
		this._map.fire('search', {originalPhrase: originalPhrase, count: 0});
	},

	_getSearchResultRectangles: function (obj, results) {
		for (var i = 0; i < obj.searchResultSelection.length; i++) {
			results.push({
				part: parseInt(obj.searchResultSelection[i].part),
				rectangles: this._twipsRectanglesToPixelBounds(obj.searchResultSelection[i].rectangles),
				twipsRectangles: obj.searchResultSelection[i].rectangles
			});
		}
	},

	_getSearchResultRectanglesFileBasedView: function (obj, results) {
		var additionPerPart = this._partHeightTwips + this._spaceBetweenParts;

		for (var i = 0; i < obj.searchResultSelection.length; i++) {
			var rectangles = obj.searchResultSelection[i].rectangles;
			var part = parseInt(obj.searchResultSelection[i].part);
			rectangles = rectangles.split(',');
			rectangles = rectangles.map(function(element, index) {
				element = parseInt(element);
				if (index < 2)
					element += additionPerPart * part;
				return element;
			});

			rectangles = String(rectangles[0]) + ', ' + String(rectangles[1]) + ', ' + String(rectangles[2]) + ', ' + String(rectangles[3]);

			results.push({
				part: parseInt(obj.searchResultSelection[i].part),
				rectangles: this._twipsRectanglesToPixelBounds(rectangles),
				twipsRectangles: rectangles
			});
		}
	},

	_onSearchResultSelection: function (textMsg) {
		textMsg = textMsg.substring(23);
		var obj = JSON.parse(textMsg);
		var originalPhrase = obj.searchString;
		var count = obj.searchResultSelection.length;
		var highlightAll = obj.highlightAll;
		var results = [];

		if (!app.file.fileBasedView)
			this._getSearchResultRectangles(obj, results);
		else
			this._getSearchResultRectanglesFileBasedView(obj, results);

		// do not cache search results if there is only one result.
		// this way regular searches works fine
		if (count > 1)
		{
			this._clearSearchResults();
			this._searchResults = results;
			if (!app.file.fileBasedView)
				this._map.setPart(results[0].part); // go to first result.
			else
				this._map._docLayer._preview._scrollViewToPartPosition(results[0].part);
		} else if (count === 1) {
			this._lastSearchResult = results[0];
		}
		this._searchTerm = originalPhrase;
		this._map.fire('search', {originalPhrase: originalPhrase, count: count, highlightAll: highlightAll, results: results});

		app.setFollowingUser(this._viewId);

		// always jump to search result - we already received cell / text cursor before so we need
		// to force it in case we had following OFF
		if (app.file.textCursor.visible)
			this._onUpdateCursor(/* scroll */ true);
		else if (app.calc.cellCursorVisible)
			this._onUpdateCellCursor(/* scroll */ true);
	},

	_clearSearchResults: function() {
		if (this._searchTerm) {
			this._textCSelections.clear();
		}
		this._lastSearchResult = null;
		this._searchResults = null;
		this._searchTerm = null;
		this._searchResultsLayer.clearLayers();
	},

	_onStateChangedMsg: function (textMsg) {
		textMsg = textMsg.substr(14);

		var isPureJSON = textMsg.indexOf('=') === -1 && textMsg.indexOf('{') !== -1;
		if (isPureJSON) {
			var json = JSON.parse(textMsg);
			// json.state as empty string is fine, for example it means no selection
			// when json.commandName is '.uno:RowColSelCount'.
			if (json.commandName && json.state !== undefined) {
				this._map.fire('commandstatechanged', json);
			}
		} else {
			var index = textMsg.indexOf('=');
			var commandName = index !== -1 ? textMsg.substr(0, index) : '';
			var state = index !== -1 ? textMsg.substr(index + 1) : '';
			this._map.fire('commandstatechanged', {commandName : commandName, state : state});
		}
	},

	_onUnoCommandResultMsg: function (textMsg) {
		// window.app.console.log('_onUnoCommandResultMsg: "' + textMsg + '"');
		textMsg = textMsg.substring(18);
		var obj = JSON.parse(textMsg);
		var commandName = obj.commandName;
		if (obj.success === 'true' || obj.success === true) {
			var success = true;
		}
		else if (obj.success === 'false' || obj.success === false) {
			success = false;
		}

		this._map.hideBusy();
		this._map.fire('commandresult', {commandName: commandName, success: success, result: obj.result});

		if (this._map.CallPythonScriptSource != null) {
			this._map.CallPythonScriptSource.postMessage(JSON.stringify({'MessageId': 'CallPythonScript-Result',
										     'SendTime': Date.now(),
										     'Values': obj
										    }),
								     '*');
			this._map.CallPythonScriptSource = null;
		}
	},

	_onRulerUpdate: function (textMsg) {
		var horizontalRuler = true;
		if(textMsg.startsWith('vrulerupdate:')) {
			horizontalRuler = false;
		}
		textMsg = textMsg.substring(13);
		var obj = JSON.parse(textMsg);
		if (!horizontalRuler) {
			this._map.fire('vrulerupdate', obj);
		}
		else {
			this._map.fire('rulerupdate', obj);
		}
	},

	_onContextMenuMsg: function (textMsg) {
		textMsg = textMsg.substring(13);
		var obj = JSON.parse(textMsg);

		this._map.fire('locontextmenu', obj);
	},

	_convertToPointSet(rectangleArray) {
		const result = CPolyUtil.rectanglesToPointSet(rectangleArray,
			function (twipsPoint) {
				var corePxPt = app.map._docLayer._twipsToCorePixels(twipsPoint);
				corePxPt.round();
				return corePxPt;
			});

		return result;
	},

	_onTextSelectionMsg: function (textMsg) {
		var rectArray = this._getTextSelectionRectangles(textMsg);

		if (rectArray.length && !this._cellSelectionArea) {
			TextSelections.activate();

			var rectangles = rectArray.map(function (rect) {
				return rect.getPointArray();
			});

			if (app.file.fileBasedView && this._lastSearchResult) {
				// We rely on that _lastSearchResult has been updated before this function is called.
				var additionPerPart = this._partHeightTwips + this._spaceBetweenParts;
				for (var i = 0; i < rectangles.length; i++) {
					for (var j = 0; j < rectangles[i].length; j++) {
						rectangles[i][j].y += additionPerPart * this._lastSearchResult.part;
					}
				}
				this._map._docLayer._preview._scrollViewToPartPosition(this._lastSearchResult.part);
				TileManager.updateFileBasedView();
				setTimeout(function () {app.sectionContainer.requestReDraw();}, 100);
			}

			var pointSet = this._convertToPointSet(rectangles);

			this._textCSelections.setPointSet(pointSet);

			this._map.removeLayer(this._map._textInput._cursorHandler); // User selected a text, we remove the carret marker.
			if (L.Browser.clipboardApiAvailable) {
				// Just set the selection type, no fetch of the content.
				this._map._clip.setTextSelectionType('text');
			} else {
				// Trigger fetching the selection content, we already need to have
				// it locally by the time 'copy' is executed.
				if (this._selectionContentRequest) {
					clearTimeout(this._selectionContentRequest);
				}
				this._selectionContentRequest = setTimeout(L.bind(function () {
					app.socket.sendMessage('gettextselection mimetype=text/html,text/plain;charset=utf-8');}, this), 100);
			}
		}
		else {
			TextSelections.deactivate();
			this._textCSelections.clear();
			this._selectedTextContent = '';
			if (this._map._clip && this._map._clip._selectionType === 'complex')
				this._map._clip.clearSelection();
		}
	},

	_onTextViewSelectionMsg: function (textMsg) {
		var obj = JSON.parse(textMsg.substring('textviewselection:'.length + 1));
		var viewId = parseInt(obj.viewId);
		var viewPart = parseInt(obj.part);
		var viewMode = (obj.mode !== undefined) ? parseInt(obj.mode) : 0;

		// Ignore if viewid is same as ours or not in our db
		if (viewId === this._viewId || !this._map._viewInfo[viewId]) {
			return;
		}

		var rectArray = this._getTextSelectionRectangles(obj.selection);
		this._viewSelections[viewId] = this._viewSelections[viewId] || {};

		if (rectArray.length) {

			var rectangles = rectArray.map(function (rect) {
				return rect.getPointArray();
			});

			this._viewSelections[viewId].part = viewPart;
			this._viewSelections[viewId].mode = viewMode;
			var docLayer = this;
			this._viewSelections[viewId].pointSet = CPolyUtil.rectanglesToPointSet(rectangles,
				function (twipsPoint) {
					var corePxPt = docLayer._twipsToCorePixels(twipsPoint);
					corePxPt.round();
					return corePxPt;
				});
		} else {
			this._viewSelections[viewId].pointSet = new CPointSet();
		}

		this._onUpdateTextViewSelection(viewId);

		this._saveMessageForReplay(textMsg, viewId);
	},

	_updateReferenceMarks: function() {
		this._clearReferences();

		if (!this._referencesAll)
			return;

		for (var i = 0; i < this._referencesAll.length; i++) {
			// Avoid doubled marks, add only marks for current sheet
			if (!this._references.hasMark(this._referencesAll[i].mark)
				&& this._selectedPart === this._referencesAll[i].part) {
				this._references.addMark(this._referencesAll[i].mark);
			}
		}
	},

	_onReferencesMsg: function (textMsg) {
		textMsg = textMsg.substr(textMsg.indexOf(' ') + 1);
		var marks = JSON.parse(textMsg);
		marks = marks.marks;
		var references = [];
		this._referencesAll = [];

		for (var mark = 0; mark < marks.length; mark++) {
			var strTwips = marks[mark].rectangle.match(/\d+/g);
			var strColor = marks[mark].color;
			var part = parseInt(marks[mark].part);

			if (strTwips != null) {
				var rectangles = [];
				for (var i = 0; i < strTwips.length; i += 4) {
					var topLeftTwips = new L.Point(parseInt(strTwips[i]), parseInt(strTwips[i + 1]));
					var offset = new L.Point(parseInt(strTwips[i + 2]), parseInt(strTwips[i + 3]));
					var boundsTwips = this._convertToTileTwipsSheetArea(
						new L.Bounds(topLeftTwips, topLeftTwips.add(offset)));
					rectangles.push([boundsTwips.getBottomLeft(), boundsTwips.getBottomRight(),
						boundsTwips.getTopLeft(), boundsTwips.getTopRight()]);
				}

				var docLayer = this;
				var pointSet = CPolyUtil.rectanglesToPointSet(rectangles, function (twipsPoint) {
					var corePxPt = docLayer._twipsToCorePixels(twipsPoint);
					corePxPt.round();
					return corePxPt;
				});
				var reference = new CPolygon(pointSet, {
					pointerEvents: 'none',
					fillColor: '#' + strColor,
					fillOpacity: 0.25,
					weight: 2 * app.dpiScale,
					opacity: 0.25});

				references.push({mark: reference, part: part});
			}
		}

		for (i = 0; i < references.length; i++) {
			this._referencesAll.push(references[i]);
		}

		this._updateReferenceMarks();
	},

	_getStringPart: function (string) {
		var code = '';
		var i = 0;
		while (i < string.length) {
			if (string.charCodeAt(i) < 48 || string.charCodeAt(i) > 57) {
				code += string.charAt(i);
			}
			i++;
		}
		return code;
	},

	_getNumberPart: function (string) {
		var number = '';
		var i = 0;
		while (i < string.length) {
			if (string.charCodeAt(i) >= 48 && string.charCodeAt(i) <= 57) {
				number += string.charAt(i);
			}
			i++;
		}
		return parseInt(number);
	},

	_isWholeColumnSelected: function (cellAddress) {
		if (!cellAddress)
			cellAddress = document.querySelector('#addressInput input').value;

		var startEnd = cellAddress.split(':');
		if (startEnd.length === 1)
			return false; // Selection is not a range.

		var rangeStart = this._getNumberPart(startEnd[0]);
		if (rangeStart !== 1)
			return false; // Selection doesn't start at first row.

		var rangeEnd = this._getNumberPart(startEnd[1]);
		if (rangeEnd === 1048576) // Last row's number.
			return true;
		else
			return false;
	},

	_isWholeRowSelected: function (cellAddress) {
		if (!cellAddress)
			cellAddress = document.querySelector('#addressInput input').value;

		var startEnd = cellAddress.split(':');
		if (startEnd.length === 1)
			return false; // Selection is not a range.

		var rangeStart = this._getStringPart(startEnd[0]);
		if (rangeStart !== 'A')
			return false; // Selection doesn't start at first column.

		var rangeEnd = this._getStringPart(startEnd[1]);
		if (rangeEnd === 'XFD') // Last column's code.
			return true;
		else
			return false;
	},

	_updateScrollOnCellSelection: function (oldSelection, newSelection) {
		if (this.isCalc() && oldSelection) {
			if (!app.file.viewedRectangle.containsRectangle(newSelection.toArray()) && !newSelection.equals(oldSelection.toArray())) {
				var spacingX = Math.abs(app.calc.cellCursorRectangle.pWidth) / 4.0;
				var spacingY = Math.abs(app.calc.cellCursorRectangle.pHeight) / 2.0;

				var scrollX = 0, scrollY = 0;
				if (newSelection.pX2 > app.file.viewedRectangle.pX2 && newSelection.pX2 > oldSelection.pX2)
					scrollX = newSelection.pX2 - app.file.viewedRectangle.pX2 + spacingX;
				else if (newSelection.pX1 < app.file.viewedRectangle.pX1 && newSelection.pX1 < oldSelection.pX1)
					scrollX = newSelection.pX1 - app.file.viewedRectangle.pX1 - spacingX;
				if (newSelection.pY2 > app.file.viewedRectangle.pY2 && newSelection.pY2 > oldSelection.pY2)
					scrollY = newSelection.pY2 - app.file.viewedRectangle.pY2 + spacingY;
				else if (newSelection.pY1 < app.file.viewedRectangle.pY1 && newSelection.pY1 < oldSelection.pY1)
					scrollY = newSelection.pY1 - app.file.viewedRectangle.pY1 - spacingY;
				if (scrollX !== 0 || scrollY !== 0) {
					if (!this._map.wholeColumnSelected && !this._map.wholeRowSelected) {
						var address = document.querySelector('#addressInput input').value;
						if (!this._isWholeColumnSelected(address) && !this._isWholeRowSelected(address)) {
							let scroll = new app.definitions.simplePoint(0,0);
							scroll.pX = scrollX;
							scroll.pY = scrollY;
							this.scrollByPoint(scroll);
						}
					}
				}
			}
		}
	},

	_onTextSelectionEndMsg: function (textMsg) {
		var rectangles = this._getTextSelectionRectangles(textMsg);

		if (rectangles.length) {
			var topLeftTwips = rectangles[0].getTopLeft();
			var bottomRightTwips = rectangles[0].getBottomRight();
			var oldSelection = TextSelections.getEndRectangle();
			TextSelections.setEndRectangle(new app.definitions.simpleRectangle(topLeftTwips.x, topLeftTwips.y, (bottomRightTwips.x - topLeftTwips.x), (bottomRightTwips.y - topLeftTwips.y)));
			this._updateScrollOnCellSelection(oldSelection, TextSelections.getEndRectangle());
		}
		else
			TextSelections.setEndRectangle(null);
	},

	_onTextSelectionStartMsg: function (textMsg) {
		var rectangles = this._getTextSelectionRectangles(textMsg);

		if (rectangles.length) {
			var topLeftTwips = rectangles[0].getTopLeft();
			var bottomRightTwips = rectangles[0].getBottomRight();
			let oldSelection = TextSelections.getStartRectangle();
			TextSelections.setStartRectangle(new app.definitions.simpleRectangle(topLeftTwips.x, topLeftTwips.y, (bottomRightTwips.x - topLeftTwips.x), (bottomRightTwips.y - topLeftTwips.y)));
			this._updateScrollOnCellSelection(oldSelection, TextSelections.getStartRectangle());
		}
		else
			TextSelections.setStartRectangle(null);
	},

	_refreshRowColumnHeaders: function () {
		if (app.sectionContainer.doesSectionExist(L.CSections.RowHeader.name))
			app.sectionContainer.getSectionWithName(L.CSections.RowHeader.name)._updateCanvas();
		if (app.sectionContainer.doesSectionExist(L.CSections.ColumnHeader.name))
			app.sectionContainer.getSectionWithName(L.CSections.ColumnHeader.name)._updateCanvas();
	},

	_onCellSelectionAreaMsg: function (textMsg) {
		var autofillMarkerSection = app.sectionContainer.getSectionWithName(L.CSections.AutoFillMarker.name);
		var strTwips = textMsg.match(/\d+/g);
		if (strTwips != null) {
			var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
			var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));
			var bottomRightTwips = topLeftTwips.add(offset);
			var boundsTwips = this._convertToTileTwipsSheetArea(new L.Bounds(topLeftTwips, bottomRightTwips));

			var oldSelection = this._cellSelectionArea ? this._cellSelectionArea.clone(): null;
			const adjustedTwipsWidth = boundsTwips.max.x - boundsTwips.min.x;
			const adjustedTwipsHeight = boundsTwips.max.y - boundsTwips.min.y;
			this._cellSelectionArea = new app.definitions.simpleRectangle(boundsTwips.min.x, boundsTwips.min.y, adjustedTwipsWidth, adjustedTwipsHeight);

			if (autofillMarkerSection)
				autofillMarkerSection.calculatePositionViaCellSelection([this._cellSelectionArea.pX2, this._cellSelectionArea.pY2]);

			this._updateScrollOnCellSelection(oldSelection, this._cellSelectionArea);

			const rectArray = this._getTextSelectionRectangles(textMsg);
			const rectangles = rectArray.map(function (rect) { return rect.getPointArray(); });
			const pointSet =  this._convertToPointSet(rectangles);
			this._cellCSelections.setPointSet(pointSet);
			CellSelectionMarkers.update();
		} else {
			this._cellSelectionArea = null;
			if (autofillMarkerSection)
				autofillMarkerSection.calculatePositionViaCellSelection(null);
			this._cellSelections = Array(0);
			this._cellCSelections.clear();
			this._map.wholeColumnSelected = false; // Message related to whole column/row selection should be on the way, we should update the variables now.
			this._map.wholeRowSelected = false;
			if (this._refreshRowColumnHeaders)
				this._refreshRowColumnHeaders();
		}
	},

	_onCellAutoFillAreaMsg: function (textMsg) {
		var strTwips = textMsg.match(/\d+/g);
		if (strTwips != null && this._map.isEditMode()) {
			var topLeftTwips = new L.Point(parseInt(strTwips[0]), parseInt(strTwips[1]));
			var offset = new L.Point(parseInt(strTwips[2]), parseInt(strTwips[3]));

			var topLeftPixels = this._twipsToCorePixels(topLeftTwips);
			var offsetPixels = this._twipsToCorePixels(offset);
			this._cellAutoFillAreaPixels = app.LOUtil.createRectangle(topLeftPixels.x, topLeftPixels.y, offsetPixels.x, offsetPixels.y);
		}
		else {
			this._cellAutoFillAreaPixels = null;
		}
	},

	_onDialogPaintMsg: function(textMsg, img) {
		var command = app.socket.parseServerCmd(textMsg);

		// app.socket.sendMessage('DEBUG _onDialogPaintMsg: hash=' + command.hash + ' img=' + typeof(img) + (typeof(img) == 'string' ? (' (length:' + img.length + ':"' + img.substring(0, 30) + (img.length > 30 ? '...' : '') + '")') : '') + ', cache size ' + this._pngCache.length);
		if (command.nopng) {
			var found = false;
			for (var i = 0; i < this._pngCache.length; i++) {
				if (this._pngCache[i].hash == command.hash) {
					found = true;
					// app.socket.sendMessage('DEBUG - Found in cache');
					img = this._pngCache[i].img;
					// Remove item (and add it below at the start of the array)
					this._pngCache.splice(i, 1);
					break;
				}
			}
			if (!found) {
				var message = 'windowpaint: message assumed PNG for hash ' + command.hash
				    + ' is cached here in the client but not found';
				if (L.Browser.cypressTest)
					throw new Error(message);
				app.socket.sendMessage('ERROR ' + message);
				// Not sure what to do. Ask the server to re-send the windowpaint: message but this time including the PNG?
			}
		} else {
			// Sanity check: If we get a PNG it should be for a hash that we don't have cached
			for (i = 0; i < this._pngCache.length; i++) {
				if (this._pngCache[i].hash == command.hash) {
					message = 'windowpaint: message included PNG for hash ' + command.hash
					    + ' even if it was already cached here in the client';
					if (L.Browser.cypressTest)
						throw new Error(message);
					app.socket.sendMessage('ERROR ' + message);
					// Remove the extra copy, code below will add it at the start of the array
					this._pngCache.splice(i, 1);
					break;
				}
			}
		}

		// If cache is max size, drop the last element
		if (this._pngCache.length == app.socket.TunnelledDialogImageCacheSize) {
			// app.socket.sendMessage('DEBUG - Dropping last cache element');
			this._pngCache.pop();
		}

		// Add element to cache
		this._pngCache.unshift({hash: command.hash, img:img});

		// app.socket.sendMessage('DEBUG - Cache size now ' + this._pngCache.length);

		this._map.fire('windowpaint', {
			id: command.id,
			img: img,
			width: command.width,
			height: command.height,
			rectangle: command.rectangle,
			hash: command.hash
		});
	},

	_onDialogMsg: function(textMsg) {
		textMsg = textMsg.substring('window: '.length);
		var dialogMsg = JSON.parse(textMsg);
		// e.type refers to signal type
		dialogMsg.winType = dialogMsg.type;
		this._map.fire('window', dialogMsg);
	},

	_mapOnError: function (e) {
		if (e.msg && this._map.isEditMode() && e.critical !== false) {
			this._map.setPermission('view');
		}
	},

	_clearSelections: function (calledFromSetPartHandler) {
		// hide the cursor if not editable
		this._onUpdateCursor(calledFromSetPartHandler);
		// hide the text selection
		this._textCSelections.clear();
		// hide the cell selection
		this._cellCSelections.clear();
		// hide the ole selection
		this._oleCSelections.clear();

		this._onUpdateCellCursor();
		if (this._map._clip)
			this._map._clip.clearSelection();
		else
			this._selectedTextContent = '';
	},

	containsSelection: function (latlng) {
		var corepxPoint = this._map.project(latlng);
		return this._textCSelections.empty() ?
			this._cellCSelections.contains(corepxPoint) :
			this._textCSelections.contains(corepxPoint);
	},

	_clearReferences: function () {
		this._references.clear();
	},

	_resetReferencesMarks: function (type) {
		this._clearReferences();

        if (type === undefined)
		    this._referencesAll = [];
        else if (type === 'focuscell')
            this._referencesAll = this._referencesAll.filter(function(e) { return e.type !== 'focuscell' });

		this._updateReferenceMarks();
	},

	_postMouseEvent: function(type, x, y, count, buttons, modifier) {
		if (!this._map._docLoaded)
			return;

		if (this._map.calcInputBarHasFocus() && type === 'move') {
			// When the Formula-bar has the focus, sending
			// mouse move with the document coordinates
			// hides the cursor (lost focus?). This is clearly
			// a bug in Core, but we need to work around it
			// until fixed. Just don't send mouse move.
			return;
		}

		const verticalOffset = this.getFiledBasedViewVerticalOffset();
		if (verticalOffset) {
			y -= verticalOffset;
		}

		app.socket.sendMessage('mouse type=' + type +
				' x=' + x + ' y=' + y + ' count=' + count +
				' buttons=' + buttons + ' modifier=' + modifier);


		const tempPageLinks = this._map['stateChangeHandler'].getItemValue('PageLinks');
		const thereArePageLinks =  tempPageLinks && tempPageLinks.length > 0;
		if (type === 'buttonup' && thereArePageLinks) {
			URLPopUpSection.closeURLPopUp();
			for (const link of this._map['stateChangeHandler'].getItemValue('PageLinks')) {
				if (link.rectangle.containsPoint([x, y])) {
					URLPopUpSection.showURLPopUP(link.uri, new app.definitions.simplePoint(x, y + this.getFiledBasedViewVerticalOffset()), undefined, /*linkIsClientSide:*/true);
				}
			}
		}

		if (type === 'buttondown')
			this._clearSearchResults();

		if (this._map && this._map._docLayer && (type === 'buttondown' || type === 'buttonup'))
			this._map.userList.followUser(this._map._docLayer._getViewId(), false);
	},

	// If viewing multi-page PDF files, get the twips offset of the current part. This is
	// needed, because core has multiple draw pages in such a case, but we have just one canvas.
	getFiledBasedViewVerticalOffset: function() {
		if (!app.file.fileBasedView) {
			return;
		}

		const additionPerPart = this._partHeightTwips + this._spaceBetweenParts;
		const verticalOffset = additionPerPart * this._selectedPart;

		return verticalOffset;
	},

	// If viewing multi-page PDF files, no precise tracking of invalidations is implemented yet,
	// so this allows requesting new tiles when we know a viewed PDF changes for some special
	// reason.
	requestNewFiledBasedViewTiles: function() {
		if (!app.file.fileBasedView) {
			return;
		}

		this._requestNewTiles();
		TileManager.redraw();
	},

	// Given a character code and a UNO keycode, send a "key" message to coolwsd.
	//
	// "type" is either "input" for key presses (akin to the DOM "keypress"
	// / "beforeinput" events) and "up" for key releases (akin to the DOM
	// "keyup" event).
	//
	// PageUp/PageDown and select column & row are handled as special cases for spreadsheets - in
	// addition of sending messages to coolwsd, they move the cell cursor around.
	postKeyboardEvent: function(type, charCode, unoKeyCode) {
		if (!this._map._docLoaded)
			return;

		if (L.Browser.mac) {
			// Map Mac standard shortcuts to the LO shortcuts for the corresponding
			// functions when possible. Note that the Cmd modifier comes here as CTRL.

			// Cmd+UpArrow -> Ctrl+Home
			if (unoKeyCode == UNOKey.UP + UNOModifier.CTRL)
				unoKeyCode = UNOKey.HOME + UNOModifier.CTRL;
			// Cmd+DownArrow -> Ctrl+End
			else if (unoKeyCode == UNOKey.DOWN + UNOModifier.CTRL)
				unoKeyCode = UNOKey.END + UNOModifier.CTRL;
			// Cmd+LeftArrow -> Home
			else if (unoKeyCode == UNOKey.LEFT + UNOModifier.CTRL)
				unoKeyCode = UNOKey.HOME;
			// Cmd+RightArrow -> End
			else if (unoKeyCode == UNOKey.RIGHT + UNOModifier.CTRL)
				unoKeyCode = UNOKey.END;
			// Option+LeftArrow -> Ctrl+LeftArrow
			else if (unoKeyCode == UNOKey.LEFT + UNOModifier.ALT)
				unoKeyCode = UNOKey.LEFT + UNOModifier.CTRL;
			// Option+RightArrow -> Ctrl+RightArrow (Not entirely equivalent, should go
			// to end of word (or next), LO goes to beginning of next word.)
			else if (unoKeyCode == UNOKey.RIGHT + UNOModifier.ALT)
				unoKeyCode = UNOKey.RIGHT + UNOModifier.CTRL;
		}

		var completeEvent = app.socket.createCompleteTraceEvent('L.TileSectionManager.postKeyboardEvent', { type: type, charCode: charCode });

		var winId = this._map.getWinId();
		if (
			this.isCalc() &&
			type === 'input' &&
			winId === 0
		) {
			if (unoKeyCode === UNOKey.SPACE + UNOModifier.CTRL) { // Select whole column.
				this._map.wholeColumnSelected = true;
			}
			else if (unoKeyCode === UNOKey.SPACE + UNOModifier.SHIFT) { // Select whole row.
				this._map.wholeRowSelected = true;
			}
		}

		if (winId === 0) {
			app.socket.sendMessage(
				'key' +
				' type=' + type +
				' char=' + charCode +
				' key=' + unoKeyCode +
				'\n'
			);
		} else {
			app.socket.sendMessage(
				'windowkey id=' + winId +
				' type=' + type +
				' char=' + charCode +
				' key=' + unoKeyCode +
				'\n'
			);
		}
		if (completeEvent)
			completeEvent.finish();
	},

	_postSelectTextEvent: function(type, x, y) {
		app.socket.sendMessage('selecttext type=' + type +
				' x=' + x + ' y=' + y);
	},

	// Is rRectangle empty?
	_isEmptyRectangle: function (bounds) {
		if (!bounds) {
			return true;
		}
		return bounds.getSouthWest().equals(new L.LatLng(0, 0)) && bounds.getNorthEast().equals(new L.LatLng(0, 0));
	},

	_onZoomStart: function () {
		this._isZooming = true;
	},


	_onZoomEnd: function () {
		this._isZooming = false;
		if (!this.isCalc())
			this._replayPrintTwipsMsgs(false);
		this._onUpdateCursor(null, true);
		app.definitions.otherViewCursorSection.updateVisibilities();
	},

	_updateCursorPos: function () {
		var cursorPos = new L.Point(app.file.textCursor.rectangle.pX1, app.file.textCursor.rectangle.pY1);
		var cursorSize = new L.Point(app.file.textCursor.rectangle.pWidth, app.file.textCursor.rectangle.pHeight);

		if (!this._cursorMarker) {
			this._cursorMarker = new Cursor(cursorPos, cursorSize, this._map, { blink: true });
		} else {
			this._cursorMarker.setPositionSize(cursorPos, cursorSize);
		}
	},

	goToTarget: function(target) {
		var command = {
			'Name': {
				type: 'string',
				value: 'URL'
			},
			'URL': {
				type: 'string',
				value: '#' + target
			}
		};

		this._map.sendUnoCommand('.uno:OpenHyperlink', command);
	},

	_allowViewJump: function() {
		return (!this._map._clip || this._map._clip._selectionType !== 'complex');
	},

	// Scrolls the view to selected position
	scrollToPos: function(pos) {
		if (pos instanceof app.definitions.simplePoint) // Turn into lat/lng if required (pos may also be a simplePoint.).
			pos = this._twipsToLatLng({ x: pos.x, y: pos.y });

		var center = this._map.project(pos);

		let needsXScroll = false;
		let needsYScroll = false;
		const CSSPixelsToTwips = app.dpiScale * app.pixelsToTwips;

		// If x coordinate is already within visible area, we won't scroll to that direction.
		if (app.isXVisibleInTheDisplayedArea(Math.round(center.x * CSSPixelsToTwips)))
			center.x = app.file.viewedRectangle.cX1;
		else {
			center.x -= this._map.getSize().divideBy(2).x;
			center.x = Math.round(center.x < 0 ? 0 : center.x);
			needsXScroll = true;
		}

		// If y coordinate is already within visible area, we won't scroll to that direction.
		const controlYDown = center.y + (app.file.textCursor.visible ? app.file.textCursor.rectangle.cHeight :
			(app.calc.cellCursorVisible ? app.calc.cellCursorRectangle.cHeight : 0));

		const controlYUp = center.y - (app.file.textCursor.visible ? app.file.textCursor.rectangle.cHeight :
			(app.calc.cellCursorVisible ? app.calc.cellCursorRectangle.cHeight : 0));

		if (app.isYVisibleInTheDisplayedArea(Math.round(controlYDown * CSSPixelsToTwips)) && app.isYVisibleInTheDisplayedArea(Math.round(controlYUp * CSSPixelsToTwips)))
			center.y = app.file.viewedRectangle.cY1;
		else {
			center.y -= this._map.getSize().divideBy(2).y;
			center.y = Math.round(center.y < 0 ? 0 : center.y);
			needsYScroll = true;
		}

		if (needsXScroll || needsYScroll) {
			const section = app.sectionContainer.getSectionWithName(L.CSections.Scroll.name);
			if (section) {
				section.onScrollTo({x: center.x, y: center.y});
			}
		}
	},

	// Scroll the view by an amount given by a simplePoint
	scrollByPoint: function(offset) {
		this._map.fire('scrollby', {x: offset.cX, y: offset.cY});
	},

	// Update cursor layer (blinking cursor).
	_onUpdateCursor: function (scroll, zoom, keepCaretPositionRelativeToScreen) {

		if (this._map.ignoreCursorUpdate()) {
			return;
		}

		if (!app.file.textCursor.visible) {
			this._updateCursorAndOverlay();
			app.definitions.otherViewCursorSection.updateVisibilities(true);
			return;
		}

		if (!zoom
		&& scroll !== false
		&& (app.file.textCursor.visible || GraphicSelection.hasActiveSelection())
		// Do not center view in Calc if no new cursor coordinates have arrived yet.
		// ie, 'invalidatecursor' has not arrived after 'cursorvisible' yet.
		&& (!this.isCalc() || (this._lastVisibleCursorRef && !this._lastVisibleCursorRef.equals(app.file.textCursor.rectangle.toArray())))
		&& this._allowViewJump()) {

			// Cursor invalidation should take most precedence among all the scrolling to follow the cursor
			// so here we disregard all the pending scrolling
			app.sectionContainer.getSectionWithName(L.CSections.Scroll.name).pendingScrollEvent = null;
			var correctedCursor = app.file.textCursor.rectangle.clone();

			if (this._docType === 'text') {
				// For Writer documents, disallow scrolling to cursor outside of the page (horizontally)
				// Use document dimensions to approximate page width
				correctedCursor.x1 = clamp(correctedCursor.x1, 0, app.view.size.x);
				correctedCursor.x2 = clamp(correctedCursor.x2, 0, app.view.size.x);
			}

			if (!app.isPointVisibleInTheDisplayedArea(new app.definitions.simplePoint(correctedCursor.x1, correctedCursor.y1).toArray()) ||
				!app.isPointVisibleInTheDisplayedArea(new app.definitions.simplePoint(correctedCursor.x2, correctedCursor.y2).toArray())) {
				if (app.isFollowingUser() && app.getFollowedViewId() === this._viewId && !this._map.calcInputBarHasFocus()) {
					this.scrollToPos(new app.definitions.simplePoint(correctedCursor.x1, correctedCursor.y1));
				}
			}
		}
		else if (keepCaretPositionRelativeToScreen) {
			/* We should be here when:
				Another view updated the text.
				That edit changed our cursor position.
			Now we already set the cursor position to another point.
			We want to keep the cursor position at the same point relative to screen.
			Do that only when we are reaching the end of screen so we don't flicker.
			*/
			var that = this;

			var isCursorVisible = app.isPointVisibleInTheDisplayedArea(app.file.textCursor.rectangle.toArray());

			if (!isCursorVisible) {
				setTimeout(function () {
					var y = app.file.textCursor.rectangle.pY1 - that._cursorPreviousPositionCorePixels.pY1;
					if (y) {
						app.sectionContainer.getSectionWithName(L.CSections.Scroll.name).scrollVerticalWithOffset(y);
					}
				}, 0);
			}
		}

		this._updateCursorAndOverlay();

		app.definitions.otherViewCursorSection.updateVisibilities();
	},

	activateCursor: function () {
		this._replayPrintTwipsMsg('invalidatecursor');
	},

	// enable or disable blinking cursor and the cursor overlay depending on
	// the state of the document (if the flags are set)
	_updateCursorAndOverlay: function (/*update*/) {
		if (app.file.textCursor.visible   // only when LOK has told us it is ok
			&& this._map.editorHasFocus()   // not when document is not focused
			&& !this._map.isSearching()  	// not when searching within the doc
			&& !this._isZooming             // not when zooming
			&& this._map._permission !== 'readonly' // not when we don't have permission to edit
		) {
			this._updateCursorPos();

			var scrollSection = app.sectionContainer.getSectionWithName(L.CSections.Scroll.name);
			if (!scrollSection.sectionProperties.mouseIsOnVerticalScrollBar && !scrollSection.sectionProperties.mouseIsOnHorizontalScrollBar) {
				this._map._textInput.showCursor();
			}

			var hasMobileWizardOpened = this._map.uiManager.mobileWizard ? this._map.uiManager.mobileWizard.isOpen() : false;
			var hasIframeModalOpened = $('.iframe-dialog-modal').is(':visible');
			// Don't show the keyboard when the Wizard is visible.
			if (!window.mobileWizard && !window.pageMobileWizard &&
				!window.insertionMobileWizard && !hasMobileWizardOpened &&
				!JSDialog.IsAnyInputFocused() && !hasIframeModalOpened) {
				// If the user is editing, show the keyboard, but don't change
				// anything if nothing is changed.

				// We will focus map if no comment is being edited (writer only for now).
				if (this._docType === 'text') {
					var section = app.sectionContainer.getSectionWithName(L.CSections.CommentList.name);
					if (!section || !section.sectionProperties.selectedComment || !section.sectionProperties.selectedComment.isEdit())
						this._map.focus(true);
				}
				else
					this._map.focus(true);
			}
		} else {
			this._map._textInput.hideCursor();
			// Maintain input if a dialog or search-box has the focus.
			if (this._map.editorHasFocus() && !this._map.uiManager.isAnyDialogOpen() && !this._map.isSearching()
				&& !JSDialog.IsAnyInputFocused() && (this._map._docLayer._preview && !this._map._docLayer._preview.partsFocused))
				this._map.focus(false);
		}

		// when first time we updated the cursor - document is loaded
		// let's move cursor to the target
		if (this._map.options.docTarget !== '') {
			this.goToTarget(this._map.options.docTarget);
			this._map.options.docTarget = '';
		}
	},

	updateAllTextViewSelection: function() {
		this.eachView(this._viewSelections, this._onUpdateTextViewSelection, this, false);
	},

	goToViewCursor: function(viewId) {
		if (viewId === this._viewId) {
			this._onUpdateCursor();
			return;
		}

		const section = app.definitions.otherViewCursorSection.getViewCursorSection(viewId);

		if (section && section.showSection) {
			const point = new app.definitions.simplePoint(section.position[0] * app.pixelsToTwips, section.position[1] * app.pixelsToTwips);
			var isNewCursorVisible = app.isPointVisibleInTheDisplayedArea(point.toArray());
			if (!isNewCursorVisible)
				this.scrollToPos(point);
			app.definitions.cursorHeaderSection.showCursorHeader(viewId);
		}
	},

	_onUpdateTextViewSelection: function (viewId) {
		viewId = parseInt(viewId);
		var viewPointSet = this._viewSelections[viewId].pointSet;
		var viewSelection = this._viewSelections[viewId].selection;
		var viewPart = this._viewSelections[viewId].part;
		var viewMode = this._viewSelections[viewId].mode ? this._viewSelections[viewId].mode : 0;

		if (viewPointSet &&
		    (this.isWriter() || (this._selectedPart === viewPart && this._selectedMode === viewMode))) {

			if (viewSelection) {
				if (!this._map.hasInfoForView(viewId)) {
					viewSelection.clear();
					return;
				}
				// change previous selections
				viewSelection.setPointSet(viewPointSet);
			} else {
				viewSelection = new CSelections(viewPointSet, this._canvasOverlay,
					this._selectionsDataDiv, this._map, true /* isView */, viewId, true /* isText */);
				this._viewSelections[viewId].selection = viewSelection;
			}
		}
		else if (viewSelection) {
			viewSelection.clear();
		}
	},

	eachView: function (views, method, context, item) {
		for (var key in views) {
			method.call(context, item ? views[key] : key);
		}
	},

	// TODO: used only in calc: move to CalcTileLayer
	_onUpdateCellCursor: function (scrollToCursor, sameAddress) {
		CellSelectionMarkers.update();

		if (app.calc.cellCursorVisible) {
			if (scrollToCursor &&
			    !this._map.calcInputBarHasFocus()) {
				const scroll = this._calculateScrollForNewCellCursor();
				if (scroll.x !== 0 || scroll.y !== 0) {
					const section = app.sectionContainer.getSectionWithName(L.CSections.Scroll.name);
					if (section) {
						section.moveMapBy(scroll.cX, scroll.cY, true);
					}
				}
				this._prevCellCursorAddress = app.calc.cellAddress.clone();
			}

			this._addCellDropDownArrow();

			var focusOutOfDocument = document.activeElement === document.body;
			var dontFocusDocument = JSDialog.IsAnyInputFocused() || focusOutOfDocument;
			var dontStealFocus = sameAddress && this._map.calcInputBarHasFocus();
			dontFocusDocument = dontFocusDocument || dontStealFocus;

			// when the cell cursor is moving, the user is in the document,
			// and the focus should leave the cell input bar
			// exception: when dialog opened don't focus the document
			if (!dontFocusDocument)
				this._map.fire('editorgotfocus');
		}

		this._removeCellDropDownArrow();
		URLPopUpSection.closeURLPopUp();
	},

	_onValidityListButtonMsg: function(textMsg) {
		var strXY = textMsg.match(/\d+/g);
		var validatedCellAddress = new app.definitions.simplePoint(parseInt(strXY[0]), parseInt(strXY[1])); // Cell address of the validity list.
		var show = parseInt(strXY[2]) === 1;
		if (show) {
			if (this._validatedCellAddress && !validatedCellAddress.equals(this._validatedCellAddress.toArray())) {
				this._validatedCellAddress = null;
				this._removeCellDropDownArrow();
			}
			this._validatedCellAddress = validatedCellAddress;
			this._addCellDropDownArrow();
		}
		else if (this._validatedCellAddress && validatedCellAddress.equals(this._validatedCellAddress.toArray())) {
			this._validatedCellAddress = null;
			this._removeCellDropDownArrow();
		}
	},

	_onValidityInputHelpMsg: function(textMsg) {
		app.definitions.validityInputHelpSection.removeValidityInputHelp();
		app.definitions.validityInputHelpSection.showValidityInputHelp(textMsg, new app.definitions.simplePoint(app.calc.cellCursorRectangle.x2, app.calc.cellCursorRectangle.y1));
	},

	_addCellDropDownArrow: function () {
		if (this._validatedCellAddress && app.calc.cellCursorVisible && this._validatedCellAddress.equals(app.calc.cellAddress.toArray())) {
			let position;
			if (this.sheetGeometry) {
				position = this.sheetGeometry.getCellRect(this._validatedCellAddress.x, this._validatedCellAddress.y);
				position = new app.definitions.simplePoint(app.calc.cellCursorRectangle.x2, (position.max.y - CalcValidityDropDown.dropDownArrowSize * app.dpiScale) * app.pixelsToTwips);
			}
			else
				position = new app.definitions.simplePoint(app.calc.cellCursorRectangle.x2, app.calc.cellCursorRectangle.y2 - CalcValidityDropDown.dropDownArrowSize * app.dpiScale * app.pixelsToTwips);

			if (!app.sectionContainer.getSectionWithName(L.CSections.CalcValidityDropDown.name)) {
				let dropDownSection = new CalcValidityDropDown(position);
				app.sectionContainer.addSection(dropDownSection);
			}
			else {
				app.sectionContainer.getSectionWithName(L.CSections.CalcValidityDropDown.name).setPosition(position.pX, position.pY);
			}
		}
	},

	_removeCellDropDownArrow: function () {
		if (!this._validatedCellAddress)
			app.sectionContainer.removeSection(L.CSections.CalcValidityDropDown.name);
	},

	_removeSelection: function() {
		this._selectedTextContent = '';
		this._textCSelections.clear();
	},

	_onDragOver: function (e) {
		e = e.originalEvent;
		e.preventDefault();
	},

	_onDrop: function (e) {
		// Move the cursor, so that the insert position is as close to the drop coordinates as possible.
		var latlng = e.latlng;
		var docLayer = this._map._docLayer;
		var mousePos = docLayer._latLngToTwips(latlng);
		var count = 1;
		var buttons = 1;
		var modifier = this._map.keyboard.modifier;
		this._postMouseEvent('buttondown', mousePos.x, mousePos.y, count, buttons, modifier);
		this._postMouseEvent('buttonup', mousePos.x, mousePos.y, count, buttons, modifier);

		e = e.originalEvent;
		e.preventDefault();

		if (this._map._clip) {
			// Always capture the html content separate as we may lose it when we
			// pass the clipboard data to a different context (async calls, f.e.).
			var htmlText = e.dataTransfer.getData('text/html');
			this._map._clip.dataTransferToDocument(e.dataTransfer, /* preferInternal = */ false, htmlText);
		}
	},

	// This is really just called on zoomend
	_fitWidthZoom: function (e, maxZoom) {
		if (this.isCalc())
			return;

		if (app.file.size.x === 0) { return; }
		var oldSize = e ? e.oldSize : this._map.getSize();
		var newSize = e ? e.newSize : this._map.getSize();

		newSize.x *= app.dpiScale;
		newSize.y *= app.dpiScale;
		oldSize.x *= app.dpiScale;
		oldSize.y *= app.dpiScale;

		if (this.isWriter() && newSize.x - oldSize.x === 0) { return; }

		var widthTwips = newSize.x * app.tile.size.x / TileManager.tileSize;
		var ratio = widthTwips / app.file.size.x;

		maxZoom = maxZoom ? maxZoom : 10;
		var zoom = this._map.getScaleZoom(ratio, 10);

		zoom = Math.min(maxZoom, Math.max(0.1, zoom));
		// Not clear why we wanted to zoom in the past.
		// This resets the view & scroll area and does a 'panTo'
		// to keep the cursor in view.
		// But of course, zoom to fit the first time.
		if (this._firstFitDone)
			zoom = this._map._zoom;
		this._firstFitDone = true;

		if (zoom > 1)
			zoom = Math.floor(zoom);

		this._map.setZoom(zoom, {animate: false});
	},

	// Cells can change position during changes of zoom level in calc
	// hence we need to request an updated cell cursor position for this level.
	_onCellCursorShift: function (force) {
		if ((this._cellCursorSection && !this.options.sheetGeometryDataEnabled) || force) {
			this.requestCellCursor();
		}
	},

	requestCellCursor: function() {
		app.socket.sendMessage('commandvalues command=.uno:CellCursor'
			+ '?outputHeight=' + TileManager.tileSize
			+ '&outputWidth=' + TileManager.tileSize
			+ '&tileHeight=' + app.tile.size.x
			+ '&tileWidth=' + app.tile.size.y);
	},

	_invalidateAllPreviews: function () {
		this._previewInvalidations = [];
		for (var key in this._map._docPreviews) {
			var preview = this._map._docPreviews[key];
			preview.invalid = true;
			this._previewInvalidations.push(new L.Bounds(new L.Point(0, 0), new L.Point(preview.maxWidth, preview.maxHeight)));
		}
		this._invalidatePreviews();
	},

	_invalidatePreviews: function () {
		if (this._map && this._map._docPreviews && this._previewInvalidations.length > 0) {
			var toInvalidate = {};
			for (var i = 0; i < this._previewInvalidations.length; i++) {
				var invalidBounds = this._previewInvalidations[i];
				for (var key in this._map._docPreviews) {
					// find preview tiles that need to be updated and add them in a set
					var preview = this._map._docPreviews[key];
					if (preview.index >= 0) {
						// we have a preview for a part
						if (preview.invalid || preview.index === this._selectedPart ||
								(preview.index === this._prevSelectedPart && this._prevSelectedPartNeedsUpdate)) {
							// if the current part needs its preview updated OR
							// the part has been changed and we need to update the previous part preview
							if (preview.index === this._prevSelectedPart) {
								this._prevSelectedPartNeedsUpdate = false;
							}
							toInvalidate[key] = true;
						}
					}
					else {
						// we have a custom preview
						var bounds = new L.Bounds(
							new L.Point(preview.tilePosX, preview.tilePosY),
							new L.Point(preview.tilePosX + preview.tileWidth, preview.tilePosY + preview.tileHeight));
						if (preview.invalid || (preview.part === this._selectedPart ||
								(preview.part === this._prevSelectedPart && this._prevSelectedPartNeedsUpdate)) &&
								invalidBounds.intersects(bounds)) {
							// if the current part needs its preview updated OR
							// the part has been changed and we need to update the previous part preview
							if (preview.index === this._prevSelectedPart) {
								this._prevSelectedPartNeedsUpdate = false;
							}
							toInvalidate[key] = true;
						}

					}
				}

			}

			for (key in toInvalidate) {
				// update invalid preview tiles
				preview = this._map._docPreviews[key];
				if (preview.autoUpdate) {
					if (preview.index >= 0) {
						this._map.getPreview(preview.id, preview.index, preview.maxWidth, preview.maxHeight, {autoUpdate: true});
					}
					else {
						this._map.getCustomPreview(preview.id, preview.part, preview.width, preview.height, preview.tilePosX,
							preview.tilePosY, preview.tileWidth, preview.tileHeight, {autoUpdate: true});
					}
				}
			}
		}
		this._previewInvalidations = [];
	},

	_onFormFieldButtonMsg: function (textMsg) {
		textMsg = textMsg.substring('formfieldbutton:'.length + 1);
		var json = JSON.parse(textMsg);
		if (json.action === 'show') {
			this._formFieldButton = new L.FormFieldButton(json);
			this._map.addLayer(this._formFieldButton);
		} else if (this._formFieldButton) {
			this._map.removeLayer(this._formFieldButton);
		}
	},

	// converts rectangle in print-twips to tile-twips rectangle of the smallest cell-range that encloses it.
	_convertToTileTwipsSheetArea: function (rectangle) {
		if (!(rectangle instanceof L.Bounds) || !this.options.printTwipsMsgsEnabled || !this.sheetGeometry) {
			return rectangle;
		}

		return this.sheetGeometry.getTileTwipsSheetAreaFromPrint(rectangle);
	},

	_convertCalcTileTwips: function (point, offset) {
		if (!this.options.printTwipsMsgsEnabled || !this.sheetGeometry)
			return point;
		var newPoint = new L.Point(parseInt(point.x), parseInt(point.y));
		var _offset = offset ? new L.Point(parseInt(offset.x), parseInt(offset.y)) : new L.Point(this._shapeGridOffset.x, this._shapeGridOffset.y);
		return newPoint.add(_offset);
	},

	_getEditCursorRectangle: function (msgObj) {

		if (typeof msgObj !== 'object' || !Object.prototype.hasOwnProperty.call(msgObj,'rectangle')) {
			window.app.console.error('invalid edit cursor message');
			return undefined;
		}

		return L.Bounds.parse(msgObj.rectangle);
	},

	_getTextSelectionRectangles: function (textMsg) {

		if (typeof textMsg !== 'string') {
			window.app.console.error('invalid text selection message');
			return [];
		}

		return L.Bounds.parseArray(textMsg);
	},

	// Needed for the split-panes feature to determine the active split-pane.
	// Needs to be implemented by the app specific TileLayer.
	getCursorPos: function () {
		window.app.console.error('No implementations available for getCursorPos!');
		return new L.Point(0, 0);
	},

	/// onlyThread - takes annotation indicating which thread will be generated
	getCommentWizardStructure: function(menuStructure, onlyThread) {
		var customTitleBar = L.DomUtil.create('div');
		L.DomUtil.addClass(customTitleBar, 'mobile-wizard-titlebar-btn-container');
		var title = L.DomUtil.create('span', '', customTitleBar);
		title.innerText = _('Comment');
		var button = L.DomUtil.createWithId('button', 'insert_comment', customTitleBar);
		L.DomUtil.addClass(button, 'mobile-wizard-titlebar-btn');
		button.innerText = '+';
		button.onclick = this._map.insertComment.bind(this._map);

		if (menuStructure === undefined) {
			menuStructure = {
				id : 'comment',
				type : 'mainmenu',
				enabled : true,
				text : _('Comment'),
				executionType : 'menu',
				data : [],
				children : []
			};

			if (app.isCommentEditingAllowed())
				menuStructure['customTitle'] = customTitleBar;
		}

		app.sectionContainer.getSectionWithName(L.CSections.CommentList.name).createCommentStructure(menuStructure, onlyThread);

		if (menuStructure.children.length === 0) {
			var noComments = {
				id: 'emptyWizard',
				enable: true,
				type: 'emptyCommentWizard',
				text: _('No Comments'),
				children: []
			};
			menuStructure['children'].push(noComments);
		}
		return menuStructure;
	},

	_openCommentWizard: function(annotation) {
		window.commentWizard = true;
		var menuData = this._map._docLayer.getCommentWizardStructure();
		this._map.fire('mobilewizard', {data: menuData});

		// if annotation is provided we can select particular comment
		if (annotation) {
			$('#comment' + annotation.sectionProperties.data.id).click();
		}
	},

	_saveMessageForReplay: function (textMsg, viewId) {
		// We will not get some messages (with coordinates)
		// from core when zoom changes because print-twips coordinates are zoom-invariant. So we need to
		// remember the last version of them and replay, when zoom is changed.
		// In calc we need to replay the messages when sheet-geometry changes too. This is because it is possible for
		// the updated print-twips messages to arrive before the sheet-geometry update message arrives.

		if (!this._printTwipsMessagesForReplay) {
			var ownViewTypes = this.isCalc() ? [
				'cellcursor',
				'referencemarks',
				'cellselectionarea',
				'textselection',
				'invalidatecursor',
				'textselectionstart',
				'textselectionend',
				'graphicselection',
			] : [
				'invalidatecursor',
				'textselection',
				'graphicselection'
			];

			if (this.isWriter())
				ownViewTypes.push('contentcontrol');

			var otherViewTypes = this.isCalc() ? [
				'cellviewcursor',
				'textviewselection',
				'invalidateviewcursor',
				'graphicviewselection',
			] : [
				'textviewselection',
				'invalidateviewcursor'
			];

			this._printTwipsMessagesForReplay = new L.MessageStore(ownViewTypes, otherViewTypes);
		}

		var colonIndex = textMsg.indexOf(':');
		if (colonIndex === -1) {
			return;
		}

		var msgType = textMsg.substring(0, colonIndex);
		this._printTwipsMessagesForReplay.save(msgType, textMsg, viewId);
	},

	_clearMsgReplayStore: function (notOtherMsg) {
		if (!this._printTwipsMessagesForReplay) {
			return;
		}

		this._printTwipsMessagesForReplay.clear(notOtherMsg);
	},

	_replayPrintTwipsMsgs: function (differentSheet) {
		if (!this._printTwipsMessagesForReplay) {
			return;
		}

		this._printTwipsMessagesForReplay.forEach(function (msg) {
			// don't try and replace graphic selection if the sheet/page has changed
			var skipMessage = differentSheet && msg.startsWith('graphicselection:');
			if (!skipMessage)
				this._onMessage(msg);
		}.bind(this));
	},

	_replayPrintTwipsMsg: function (msgType) {
		var msg = this._printTwipsMessagesForReplay.get(msgType);
		this._onMessage(msg);
	},

	_replayPrintTwipsMsgAllViews: function (msgType) {
		Object.keys(this._map._viewInfo).forEach(function (viewId) {
			var msg = this._printTwipsMessagesForReplay.get(msgType, parseInt(viewId));
			if (msg)
				this._onMessage(msg);
		}.bind(this));
	},

	_syncTilePanePos: function () {
		if (this._container) {
			var mapPanePos = this._map._getMapPanePos();
			L.DomUtil.setPosition(this._container, new L.Point(-mapPanePos.x , -mapPanePos.y));
		}
		var documentBounds = this._map.getPixelBoundsCore();
		var documentPos = documentBounds.min;
		var documentEndPos = documentBounds.max;
		app.sectionContainer.setDocumentBounds([documentPos.x, documentPos.y, documentEndPos.x, documentEndPos.y]);
		if (app.file.writer.multiPageView)
			MultiPageViewLayout.reset();
	},

	pauseDrawing: function () {
		if (this._painter && app.sectionContainer)
			app.sectionContainer.pauseDrawing();
	},

	resumeDrawing: function (topLevel) {
		if (this._painter && app.sectionContainer)
			app.sectionContainer.resumeDrawing(topLevel);
	},

	// used in Calc, see CalcTileLayer
	allowDrawing: function() {},

	enableDrawing: function () {
		if (this._painter && app.sectionContainer)
			app.sectionContainer.enableDrawing();
	},

	_getUIWidth: function () {
		var section = app.sectionContainer.getSectionWithName(L.CSections.RowHeader.name);
		if (section) {
			return Math.round(section.size[0] / app.dpiScale);
		}
		else {
			return 0;
		}
	},

	_getUIHeight: function () {
		var section = app.sectionContainer.getSectionWithName(L.CSections.ColumnHeader.name);
		if (section) {
			return Math.round(section.size[1] / app.dpiScale);
		}
		else {
			return 0;
		}
	},

	_getGroupWidth: function () {
		var section = app.sectionContainer.getSectionWithName(L.CSections.RowGroup.name);
		if (section) {
			return Math.round(section.size[0] / app.dpiScale);
		}
		else {
			return 0;
		}
	},

	_getGroupHeight: function () {
		var section = app.sectionContainer.getSectionWithName(L.CSections.ColumnGroup.name);
		if (section) {
			return Math.round(section.size[1] / app.dpiScale);
		}
		else {
			return 0;
		}
	},

	_getTilesSectionRectangle: function () {
		var section = app.sectionContainer.getSectionWithName(L.CSections.Tiles.name);
		if (section) {
			return app.LOUtil.createRectangle(section.myTopLeft[0] / app.dpiScale, section.myTopLeft[1] / app.dpiScale, section.size[0] / app.dpiScale, section.size[1] / app.dpiScale);
		}
		else {
			return app.LOUtil.createRectangle(0, 0, 0, 0);
		}
	},

	_getRealMapSize: function() {
		this._map._sizeChanged = true; // force using real size
		return this._map.getPixelBounds().getSize();
	},

	_getDocumentContainerSize: function() {
		let documentContainerSize = document.getElementById('document-container').getBoundingClientRect();
		documentContainerSize = [documentContainerSize.width, documentContainerSize.height];
		return documentContainerSize;
	},

	_resizeMapElementAndTilesLayer: function(sizeRectangle) {
		const mapElement = document.getElementById('map'); // map's size = tiles section's size.
		mapElement.style.left = sizeRectangle.getPxX1() + 'px';
		mapElement.style.top = sizeRectangle.getPxY1() + 'px';
		mapElement.style.width = sizeRectangle.getPxWidth() + 'px';
		mapElement.style.height = sizeRectangle.getPxHeight() + 'px';

		this._container.style.width = sizeRectangle.getPxWidth() + 'px';
		this._container.style.height = sizeRectangle.getPxHeight() + 'px';
	},

	_mobileChecksAfterResizeEvent: function(heightIncreased) {
		if (!window.mode.isMobile()) return;

		const hasMobileWizardOpened = this._map.uiManager.mobileWizard ? this._map.uiManager.mobileWizard.isOpen() : false;
		const hasIframeModalOpened = $('.iframe-dialog-modal').is(':visible');
		// when integrator has opened dialog in parent frame (eg. save as) we shouldn't steal the focus
		const focusedUI = document.activeElement === document.body;
		if (!hasMobileWizardOpened && !hasIframeModalOpened && !focusedUI) {
			if (heightIncreased) {
				// if the keyboard is hidden - be sure we setup correct state in TextInput
				this._map.setAcceptInput(false);
			} else
				this._onUpdateCursor(true);
		}
	},

	_nonDesktopChecksAfterResizeEvent: function(heightIncreased) {
		// We want to keep cursor visible when we show the keyboard on mobile device or tablet
		if (!window.mode.isMobile() && !window.mode.isTablet()) return;

		const hasVisibleCursor = app.file.textCursor.visible
			&& this._map._docLayer._cursorMarker && this._map._docLayer._cursorMarker.isDomAttached();
		if (!heightIncreased && this._map._docLoaded && hasVisibleCursor) {
			const cursorPos = this._map._docLayer._twipsToLatLng({ x: app.file.textCursor.rectangle.x1, y: app.file.textCursor.rectangle.y2 });
			const cursorPositionInView = this._isLatLngInView(cursorPos);
			if (!cursorPositionInView)
				this._map.panTo(cursorPos);
		}
	},

	_syncTileContainerSize: function () {
		if (!this._map) return;

		if (this._docType === 'presentation' || this._docType === 'drawing') this.onResizeImpress();

		if (!this._container) return;

		const documentContainerSize = this._getDocumentContainerSize();

		app.sectionContainer.onResize(documentContainerSize[0], documentContainerSize[1]); // Canvas's size = documentContainer's size.

		const oldSize = this._getRealMapSize();

		this._resizeMapElementAndTilesLayer(this._getTilesSectionRectangle());

		const newSize = this._getRealMapSize();
		const heightIncreased = oldSize.y < newSize.y;
		const widthIncreased = oldSize.x < newSize.x;

		if (oldSize.x !== newSize.x || oldSize.y !== newSize.y)
			this._map.invalidateSize(false, oldSize);

		this._mobileChecksAfterResizeEvent(heightIncreased);

		this._fitWidthZoom();

		// Center the view w.r.t the new map-pane position using the current zoom.
		this._map.setView(this._map.getCenter());

		this._nonDesktopChecksAfterResizeEvent(heightIncreased);

		if (heightIncreased || widthIncreased) {
			app.sectionContainer.requestReDraw();
			this._map.fire('sizeincreased');
		}
	},

	hasSplitPanesSupport: function () {
		// Only enabled for Calc for now
		// It may work without this.options.sheetGeometryDataEnabled but not tested.
		// The overlay-pane with split-panes is still based on svg renderer,
		// and not available for VML or canvas yet.
		if (this.isCalc() &&
			this.options.sheetGeometryDataEnabled) {
			return true;
		}

		return false;
	},

	setZoomChanged: function (zoomChanged) {
		app.sectionContainer.setZoomChanged(zoomChanged);
	},

	onAdd: function (map) {
		this._initContainer();

		// Initiate selection handles.
		TextSelections.initiate();

		// Initiate cell selection handles.
		CellSelectionMarkers.initiate();

		if (this.isCalc()) {
			var cursorStyle = new CStyleData(this._cursorDataDiv);
			var weight = cursorStyle.getFloatPropWithoutUnit('border-top-width') * app.dpiScale;
			var color = cursorStyle.getPropValue('border-top-color');
			this._cellCursorSection = new app.definitions.cellCursorSection(color, weight);
			app.sectionContainer.addSection(this._cellCursorSection);
		}

		this._getToolbarCommandsValues();
		this._textCSelections = new CSelections(undefined, this._canvasOverlay,
			this._selectionsDataDiv, this._map, false /* isView */, undefined, 'text');
		this._cellCSelections = new CSelections(undefined, this._canvasOverlay,
			this._selectionsDataDiv, this._map, false /* isView */, undefined, 'cell');
		this._oleCSelections = new CSelections(undefined, this._canvasOverlay,
			this._selectionsDataDiv, this._map, false /* isView */, undefined, 'ole');
		this._references = new CReferences(this._canvasOverlay);
		this._referencesAll = [];

		// This layergroup contains all the layers corresponding to other's view
		this._viewLayerGroup = new L.LayerGroup();
		if (!app.isReadOnly()) {
			map.addLayer(this._viewLayerGroup);
		}

		this._debug = map._debug;

		this._searchResultsLayer = new L.LayerGroup();
		map.addLayer(this._searchResultsLayer);

		app.socket.sendMessage('commandvalues command=.uno:AcceptTrackedChanges');

		map._fadeAnimated = false;
		this._viewReset();

		map.on('dragover', this._onDragOver, this);
		map.on('drop', this._onDrop, this);

		map.on('zoomstart', this._onZoomStart, this);
		map.on('zoomend', this._onZoomEnd, this);
		if (this._docType === 'spreadsheet') {
			map.on('zoomend', this._onCellCursorShift, this);
		}
		map.on('error', this._mapOnError, this);
		if (map.options.autoFitWidth !== false) {
			// always true since autoFitWidth is never set
			map.on('resize', this._fitWidthZoom, this);
		}
		this._map.on('resize', this._syncTileContainerSize, this);
		// Retrieve the initial cell cursor position (as LOK only sends us an
		// updated cell cursor when the selected cell is changed and not the initial
		// cell).
		map.on('statusindicator',
			function (e) {
				if (e.statusType === 'alltilesloaded' && this._docType === 'spreadsheet') {
					if (!this._map.uiManager.isAnyDialogOpen())
						this._onCellCursorShift(true);
				}
			},
			this);

		app.events.on('updatepermission', function(e) {
			if (e.detail.perm !== 'edit') {
				this._clearSelections();
			}
		}.bind(this));

		map.setPermission(app.file.permission);

		map.fire('statusindicator', {statusType: 'coolloaded'});

		this._map.sendInitUNOCommands();

		this._resetClientVisArea();
		this._requestNewTiles();

		map.setZoom();

		// This is called when page size is increased
		// the content of the page that become visible may stay empty
		// unless we have the tiles in the cache already
		// This will only fetch the tiles which are invalid or does not exist
		map.on('sizeincreased', function() {
			TileManager.update();
		}.bind(this));
	},

	onRemove: function (map) {
		L.DomUtil.remove(this._container);
		map._removeZoomLimit(this);
		this._container = null;
		this._tileZoom = null;
		TileManager.clearPreFetch();
		clearTimeout(this._previewInvalidator);

		if (!this._cellCSelections.empty()) {
			this._cellCSelections.clear();
		}

		if (!this._textCSelections.empty()) {
			this._textCSelections.clear();
		}

		if (!this._oleCSelections.empty()) {
			this._oleCSelections.clear();
		}

		if (this._cursorMarker && this._cursorMarker.isDomAttached()) {
			this._cursorMarker.remove();
		}

		TextSelections.dispose();

		this._removeSplitters();
		L.DomUtil.remove(this._canvasContainer);
	},

	getEvents: function () {
		var events = {
			viewreset: this._viewReset,
			movestart: this._moveStart,
			// update tiles on move, but not more often than once per given interval
			move: app.util.throttle(this._move, this.options.updateInterval, this),
			moveend: this._moveEnd,
			splitposchanged: this._move,
		};

		return events;
	},

	// zoom is the new intermediate zoom level (log scale : 1 to 14)
	zoomStep: function (zoom, newCenter) {
		this._painter.zoomStep(zoom, newCenter);
	},

	zoomStepEnd: function (zoom, newCenter, mapUpdater, runAtFinish, noGap) {
		this._painter.zoomStepEnd(zoom, newCenter, mapUpdater, runAtFinish, noGap);
	},

	preZoomAnimation: function (pinchStartCenter) {
		this._pinchStartCenter = this._map.project(pinchStartCenter).multiplyBy(app.dpiScale); // in core pixels
		this._painter._offset = new L.Point(0, 0);

		if (this._cursorMarker && app.file.textCursor.visible) {
			this._cursorMarker.setOpacity(0);
		}
		if (this._map._textInput._cursorHandler) {
			this._map._textInput._cursorHandler.setOpacity(0);
		}

		if (this.isCalc()) {
			this._cellCursorSection.setShowSection(false);
		}

		TextSelections.hideHandles();

		app.definitions.otherViewCursorSection.updateVisibilities(true);
	},

	postZoomAnimation: function () {
		if (app.file.textCursor.visible) {
			this._cursorMarker.setOpacity(1);
		}
		if (this._map._textInput._cursorHandler) {
			this._map._textInput._cursorHandler.setOpacity(1);
		}

		if (this.isCalc()) {
			this._cellCursorSection.setShowSection(true);
		}

		TextSelections.showHandles();

		if (this._annotations) {
			var annotations = this._annotations;
			if (annotations.update)
				setTimeout(function() {
					annotations.update();
				}, 250 /* ms */);
		}
	},

	// Meant for desktop case, where the ending zoom and centers are all known in advance.
	runZoomAnimation: function (zoomEnd, pinchCenter, mapUpdater, runAtFinish) {

		if (this._map.getDocType() === 'spreadsheet')
			OtherViewCellCursorSection.closePopups();

		this.preZoomAnimation(pinchCenter);
		this.zoomStep(this._map.getZoom(), pinchCenter);
		var thisObj = this;
		this.zoomStepEnd(zoomEnd, pinchCenter,
			mapUpdater,
			// runAtFinish
			function () {
				thisObj.postZoomAnimation();
				runAtFinish();
			});
	},

	_viewReset: function (e) {
		this._reset(e && e.hard);
		if (this._docType === 'spreadsheet' && this._annotations !== undefined) {
			app.socket.sendMessage('commandvalues command=.uno:ViewAnnotationsPosition');
		}
	},

	_removeSplitters: function () {
		if (this._xSplitter) {
			this._canvasOverlay.removePath(this._xSplitter);
			this._xSplitter = undefined;
		}

		if (this._ySplitter) {
			this._canvasOverlay.removePath(this._ySplitter);
			this._ySplitter = undefined;
		}
	},

	_cssPixelsToCore: function (cssPixels) {
		return cssPixels.multiplyBy(app.dpiScale);
	},

	_twipsToCorePixels: function (twips) {
		return new L.Point(
			twips.x * app.twipsToPixels,
			twips.y * app.twipsToPixels);
	},

	_twipsToCorePixelsBounds: function (twips) {
		return new L.Bounds(
			this._twipsToCorePixels(twips.min),
			this._twipsToCorePixels(twips.max)
		);
	},

	_corePixelsToTwips: function (corePixels) {
		return new L.Point(
			corePixels.x * app.pixelsToTwips,
			corePixels.y * app.pixelsToTwips);
	},

	_twipsToCssPixels: function (twips) {
		return new L.Point(
			(twips.x / app.tile.size.x) * (TileManager.tileSize / app.dpiScale),
			(twips.y / app.tile.size.y) * (TileManager.tileSize / app.dpiScale));
	},

	_cssPixelsToTwips: function (pixels) {
		return new L.Point(
			(pixels.x * app.dpiScale) * app.pixelsToTwips,
			(pixels.y * app.dpiScale) * app.pixelsToTwips);
	},

	_twipsToLatLng: function (twips, zoom) {
		var pixels = this._twipsToCssPixels(twips);
		return this._map.unproject(pixels, zoom);
	},

	_latLngToTwips: function (latLng, zoom) {
		var pixels = this._map.project(latLng, zoom);
		return this._cssPixelsToTwips(pixels);
	},

	_twipsToPixels: function (twips) { // css pixels
		return this._twipsToCssPixels(twips);
	},

	_pixelsToTwips: function (pixels) { // css pixels
		return this._cssPixelsToTwips(pixels);
	},

	_updateMaxBounds: function (sizeChanged) {
		if (app.file.size.x === 0 || app.file.size.y === 0) {
			return;
		}

		var docPixelLimits = new L.Point(app.file.size.pX / app.dpiScale, app.file.size.pY / app.dpiScale);
		var scrollPixelLimits = new L.Point(app.view.size.pX / app.dpiScale, app.view.size.pY / app.dpiScale);
		var topLeft = this._map.unproject(new L.Point(0, 0));

		if (this._documentInfo === '' || sizeChanged) {
			// we just got the first status so we need to center the document
			this._map.setDocBounds(new L.LatLngBounds(topLeft, this._map.unproject(docPixelLimits)));
			this._map.setMaxBounds(new L.LatLngBounds(topLeft, this._map.unproject(scrollPixelLimits)));
		}

		this._docPixelSize = {x: docPixelLimits.x, y: docPixelLimits.y};
		this._map.fire('scrolllimits', {});
	},

	// Used with filebasedview.
	_getMostVisiblePart: function (queue) {
		var parts = [];
		var found = false;

		for (var i = 0; i < queue.length; i++) {
			for (var j = 0; j < parts.length; j++) {
				if (parts[j].part === queue[i].part) {
					found = true;
					break;
				}
			}
			if (!found)
				parts.push({part: queue[i].part});
			found = false;
		}

		var ratio = TileManager.tileSize / app.tile.size.y;
		var partHeightPixels = Math.round((this._partHeightTwips + this._spaceBetweenParts) * ratio);
		var partWidthPixels = Math.round(this._partWidthTwips * ratio);

		var rectangle;
		var maxArea = -1;
		var mostVisiblePart = 0;
		const viewedRectangle = app.file.viewedRectangle.pToArray();
		for (i = 0; i < parts.length; i++) {
			rectangle = [0, partHeightPixels * parts[i].part, partWidthPixels, partHeightPixels];
			rectangle = app.LOUtil._getIntersectionRectangle(rectangle, viewedRectangle);
			if (rectangle) {
				if (rectangle[2] * rectangle[3] > maxArea) {
					maxArea = rectangle[2] * rectangle[3];
					mostVisiblePart = parts[i].part;
				}
			}
		}
		return mostVisiblePart;
	},

	highlightCurrentPart: function (part) {
		var previews = document.getElementsByClassName('preview-frame');
		for (var i = 0; i < previews.length; i++) {
			const img = previews[i].querySelector('img');
			if (parseInt(previews[i].id.replace('preview-frame-part-', '')) === part) {
				L.DomUtil.addClass(img, 'preview-img-currentpart');
			}
			else {
				L.DomUtil.removeClass(img, 'preview-img-currentpart');
			}
		}
	},

	// Used with file based view. Check the most visible part and set the selected part if needed.
	_checkSelectedPart: function () {
		var queue = TileManager.updateFileBasedView(true);
		if (queue.length > 0) {
			var partToSelect = this._getMostVisiblePart(queue);
			if (this._selectedPart !== partToSelect) {
				this._selectedPart = partToSelect;
				this._preview._scrollToPart();
				this.highlightCurrentPart(partToSelect);
				app.socket.sendMessage('setclientpart part=' + this._selectedPart);
			}
		}
	},

	_sendClientVisibleArea: function (forceUpdate) {
		if (!this._map._docLoaded)
			return;

		if (app.file.writer.multiPageView)
			return; // This view mode sends the client visible area after modifying the document position.

		var splitPos = this._splitPanesContext ? this._splitPanesContext.getSplitPos() : new L.Point(0, 0);

		var visibleArea = this._map.getPixelBounds();
		visibleArea = new L.Bounds(
			this._pixelsToTwips(visibleArea.min),
			this._pixelsToTwips(visibleArea.max)
		);
		splitPos = this._corePixelsToTwips(splitPos);
		var size = visibleArea.getSize();
		var visibleTopLeft = visibleArea.min;
		var newClientVisibleArea = 'clientvisiblearea x=' + Math.round(visibleTopLeft.x)
					+ ' y=' + Math.round(visibleTopLeft.y)
					+ ' width=' + Math.round(size.x)
					+ ' height=' + Math.round(size.y)
					+ ' splitx=' + Math.round(splitPos.x)
					+ ' splity=' + Math.round(splitPos.y);

		if (this._clientVisibleArea !== newClientVisibleArea || forceUpdate) {
			// Only update on some change
			if (this._ySplitter) {
				this._ySplitter.onPositionChange();
			}
			if (this._xSplitter) {
				this._xSplitter.onPositionChange();
			}
			// Visible area is dirty, update it on the server
			app.socket.sendMessage(newClientVisibleArea);
			if (!this._map._fatal && app.idleHandler._active && app.socket.connected())
				this._clientVisibleArea = newClientVisibleArea;
		}
	},

	// Update debug overlay for a tile
	_showDebugForTile: function(key) {
		if (!this._debug.debugOn)
			return;

		const tile = TileManager.get(key);
		tile._debugTime = this._debug.getTimeArray();
	},

	_coordsToPixBounds: function (coords) {
		// coords.x and coords.y are the pixel coordinates of the top-left corner of the tile.
		var topLeft = new L.Point(coords.x, coords.y);
		var bottomRight = topLeft.add(new L.Point(TileManager.tileSize, TileManager.tileSize));
		return new L.Bounds(topLeft, bottomRight);
	},

	hasXSplitter: function () {
		return !!(this._xSplitter);
	},

	hasYSplitter: function () {
		return !!(this._ySplitter);
	},

	getTileSectionPos: function () {
		return this._painter.getTileSectionPos();
	},

	isLayoutRTL: function () {
		return !!this._layoutIsRTL;
	},

	isCalcRTL: function () {
		return this.isCalc() && this.isLayoutRTL();
	}

});

L.MessageStore = L.Class.extend({

	// ownViewTypes : The types of messages related to own view.
	// otherViewTypes: The types of messages related to other views.
	initialize: function (ownViewTypes, otherViewTypes) {

		if (!Array.isArray(ownViewTypes) || !Array.isArray(otherViewTypes)) {
			window.app.console.error('Unexpected argument types');
			return;
		}

		var ownMessages = {};
		ownViewTypes.forEach(function (msgType) {
			ownMessages[msgType] = '';
		});
		this._ownMessages = ownMessages;

		var othersMessages = {};
		otherViewTypes.forEach(function (msgType) {
			othersMessages[msgType] = [];
		});
		this._othersMessages = othersMessages;
	},

	clear: function (notOtherMsg) {
		var msgs = this._ownMessages;
		Object.keys(msgs).forEach(function (msgType) {
			msgs[msgType] = '';
		});

		if (!notOtherMsg) {
			msgs = this._othersMessages;
			Object.keys(msgs).forEach(function (msgType) {
				msgs[msgType] = [];
			});
		}
	},

	save: function (msgType, textMsg, viewId) {

		var othersMessage = (typeof viewId === 'number');

		if (!othersMessage && Object.prototype.hasOwnProperty.call(this._ownMessages, msgType)) {
			this._ownMessages[msgType] = textMsg;
			return;
		}

		if (othersMessage && Object.prototype.hasOwnProperty.call(this._othersMessages, msgType)) {
			this._othersMessages[msgType][viewId] = textMsg;
		}
	},

	get: function (msgType, viewId) {

		var othersMessage = (typeof viewId === 'number');

		if (!othersMessage && Object.prototype.hasOwnProperty.call(this._ownMessages, msgType)) {
			return this._ownMessages[msgType];
		}

		if (othersMessage && Object.prototype.hasOwnProperty.call(this._othersMessages, msgType)) {
			return this._othersMessages[msgType][viewId];
		}
	},

	forEach: function (callback) {
		if (typeof callback !== 'function') {
			window.app.console.error('Invalid callback type');
			return;
		}

		this._cleanUpSelectionMessages(this._ownMessages);

		var ownMessages = this._ownMessages;
		Object.keys(this._ownMessages).forEach(function (msgType) {
			callback(ownMessages[msgType]);
		});

		var othersMessages = this._othersMessages;
		Object.keys(othersMessages).forEach(function (msgType) {
			othersMessages[msgType].forEach(callback);
		});
	},

	_cleanUpSelectionMessages: function(messages) {
		// must be called only from _replayPrintTwipsMsg !!
		// check if textselection is empty
		// if it is, we need to handle textselectionstart and textselectionend
		// otherwise we get handles without selection and they also may appear in the wrong cell
		// but it is also reproducible on the same cell too. e.g. selection handles without selection
		if (!messages && !messages['textselection'] && messages['textselection'] !== 'textselection: ')
			return;
		messages['textselectionstart'] = 'textselectionstart: ';
		messages['textselectionend'] = 'textselectionend: ';
	}
});
