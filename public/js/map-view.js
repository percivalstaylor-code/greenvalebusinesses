// Google Map, official boundary overlay, business markers and clustering.

export class MapView {
  constructor(el, lib, { mapId, onSelect, onHover, onUserMove }) {
    this.lib = lib;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.markers = new Map(); // place id -> { marker, el }
    this.map = new lib.Map(el, {
      mapId,
      center: { lat: -37.64, lng: 144.9 },
      zoom: 12,
      clickableIcons: false, // keep Google's own POI cards from competing with our selection
      gestureHandling: 'greedy',
      streetViewControl: false,
      mapTypeControl: true,
      mapTypeControlOptions: { position: lib.ControlPosition?.TOP_RIGHT },
      fullscreenControl: false,
    });
    this.userMoved = false;
    this.programmatic = false;
    this.map.addListener('dragstart', () => (this.userMoved = true));
    this.map.addListener('zoom_changed', () => {
      if (!this.programmatic) this.userMoved = true;
    });
    this.map.addListener('idle', () => {
      this.programmatic = false;
      onUserMove?.(this.userMoved);
    });
    const MC = window.markerClusterer?.MarkerClusterer;
    this.clusterer = MC ? new MC({ map: this.map, markers: [], algorithmOptions: { maxZoom: 16 } }) : null;
  }

  drawBoundary(geojson) {
    const ring = geojson.features[0].geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }));
    // Light mask outside the electorate makes the boundary unmistakable. The outer
    // box runs clockwise; the GeoJSON ring is counter-clockwise, so it forms a hole.
    const lats = ring.map((p) => p.lat);
    const lngs = ring.map((p) => p.lng);
    const pad = 1.5;
    const s = Math.min(...lats) - pad, n = Math.max(...lats) + pad, w = Math.min(...lngs) - pad, e = Math.max(...lngs) + pad;
    const outer = [{ lat: s, lng: w }, { lat: n, lng: w }, { lat: n, lng: e }, { lat: s, lng: e }];
    this.mask = new this.lib.Polygon({
      map: this.map,
      paths: [outer, ring],
      strokeOpacity: 0,
      fillColor: '#3c4043',
      fillOpacity: 0.16,
      clickable: false,
    });
    this.outline = new this.lib.Polygon({
      map: this.map,
      paths: ring,
      strokeColor: '#3b2ca8',
      strokeOpacity: 0.95,
      strokeWeight: 3,
      fillOpacity: 0,
      clickable: false,
      zIndex: 1,
    });
    const b = new this.lib.LatLngBounds();
    ring.forEach((p) => b.extend(p));
    this.boundaryBounds = b;
    this.fitBoundary();
  }

  fitBoundary() {
    this.programmatic = true;
    this.userMoved = false;
    this.map.fitBounds(this.boundaryBounds, 24);
  }

  /** Current viewport as [west, south, east, north]. */
  viewportBox() {
    const b = this.map.getBounds();
    if (!b) return null;
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    return [sw.lng(), sw.lat(), ne.lng(), ne.lat()];
  }

  /** Display-only check used for the optional “only list what is visible” filter. */
  inViewport(place) {
    const b = this.map.getBounds();
    return Boolean(b && place.location && b.contains(place.location));
  }

  setPlaces(places, selectedId) {
    const keep = new Set();
    const toAdd = [];
    for (const p of places) {
      if (!p.location || p.serviceAreaOnly) continue;
      keep.add(p.id);
      let m = this.markers.get(p.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'mk';
        const marker = new this.lib.AdvancedMarkerElement({ position: p.location, content: el, title: p.name || 'Unnamed place', gmpClickable: true });
        marker.addListener('click', () => this.onSelect(p.id, 'map'));
        el.addEventListener('mouseenter', () => this.onHover(p.id, true));
        el.addEventListener('mouseleave', () => this.onHover(p.id, false));
        m = { marker, el, visible: false };
        this.markers.set(p.id, m);
      }
      const reviewed = p.membership.status.startsWith('reviewed_');
      m.el.className = `mk s-${p.membership.status}${reviewed ? ' reviewed' : ''}${p.id === selectedId ? ' selected' : ''}`;
      m.marker.zIndex = p.id === selectedId ? 1000 : null;
      if (!m.visible) toAdd.push(m.marker);
      m.visible = true;
    }
    const toRemove = [];
    for (const [id, m] of this.markers) {
      if (!keep.has(id) && m.visible) {
        toRemove.push(m.marker);
        m.visible = false;
      }
    }
    if (this.clusterer) {
      if (toRemove.length) this.clusterer.removeMarkers(toRemove, true);
      if (toAdd.length) this.clusterer.addMarkers(toAdd, true);
      this.clusterer.render();
    } else {
      toRemove.forEach((mk) => (mk.map = null));
      toAdd.forEach((mk) => (mk.map = this.map));
    }
  }

  highlight(id, on) {
    this.markers.get(id)?.el.classList.toggle('hover', on);
  }

  focus(place) {
    if (!place?.location) return;
    this.programmatic = true;
    if (this.map.getZoom() < 16) this.map.setZoom(16);
    this.map.panTo(place.location);
  }

  clear() {
    this.setPlaces([], null);
  }
}
