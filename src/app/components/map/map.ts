import { Component, OnInit } from '@angular/core';
import * as L from 'leaflet';
import { Ors } from '../../services/ors';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Subject, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap, catchError, map } from 'rxjs/operators';

type NominatimItem = {
  place_id: string | number;
  display_name: string;
  lat: string;
  lon: string;
};

@Component({
  selector: 'app-map',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './map.html',
  styleUrls: ['./map.css']
})
export class MapComponent implements OnInit {
  map!: L.Map;

  profile: string = 'driving-car';
  markers: L.Marker[] = [];
  routeLayer: L.GeoJSON | null = null;
  snappedLayer: L.GeoJSON | null = null;

  poisLayer: L.LayerGroup = L.layerGroup();

  distance: number | null = null;
  duration: number | null = null;

  error: string | null = null;
  sidebarOpen = true;
  mode: 'gps' | 'zone' = 'gps';
  bufferMeters = 500;
  userLoc: L.LatLng | null = null;
  gpsMarker: L.Marker | null = null;
  gpsCircle: L.Circle | null = null;
  isoLayer: L.GeoJSON | null = null;
  isoProfile: 'driving-car' | 'cycling-regular' | 'foot-walking' = 'cycling-regular';
  isoMethod: 'distance' | 'time' = 'distance';
  isoRange = 1;
  isoInterval = 1;
  categoryIds: number[] = [];

  // ---- Autocomplete ----
  searchQuery = '';
  searchResults: NominatimItem[] = [];
  highlightIndex = -1;
  private searchInput$ = new Subject<string>();
  searchMarker: L.Marker | null = null;

  constructor(private ors: Ors, private http: HttpClient) {}

  ngOnInit(): void {
    this.map = L.map('map').setView([36.8065, 10.1815], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    this.poisLayer.addTo(this.map);
    this.map.on('click', (e: L.LeafletMouseEvent) => this.addMarker([e.latlng.lat, e.latlng.lng]));

    this.searchInput$
      .pipe(
        debounceTime(300),
        map(q => q?.trim() ?? ''),
        distinctUntilChanged(),
        switchMap(q => {
          if (!q) return of<NominatimItem[]>([]);
          const url = 'https://nominatim.openstreetmap.org/search';
          const b = this.map.getBounds(); 
          let params = new HttpParams()
            .set('q', q)
            .set('format', 'jsonv2')
            .set('addressdetails', '0')
            .set('limit', '8');
          params = params
            .set('viewbox', `${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`)
            .set('bounded', '1');
          const headers = new HttpHeaders({
            'Accept': 'application/json',
            'User-Agent': 'ors-maps-demo/1.0 (you@example.com)'
          });
          return this.http.get<any[]>(url, { params, headers }).pipe(
            catchError(() => of([] as any[]))
          );
        })
      )
      .subscribe(list => {
        this.searchResults = Array.isArray(list) ? list as NominatimItem[] : [];
        this.highlightIndex = this.searchResults.length ? 0 : -1;
      });

    this.locateMe(true);
  }

  // ---------- UI helpers ----------
  labelProfile(p: string){
    switch(p){
      case 'driving-car': return 'Car';
      case 'cycling-regular': return 'Bike';
      case 'foot-walking': return 'Foot';
      default: return p;
    }
  }
  setModeGPS() { this.mode = 'gps'; }
  setModeZone() { this.mode = 'zone'; }

  // ---------- Markers / Routing ----------
  setProfile(p: string): void {
    this.profile = p;
    if (this.markers.length === 2) this.getRoute();
  }

  addMarker(latlng: [number, number]): void {
    if (this.markers.length >= 2) this.clearAll();
    const m = L.marker(latlng).addTo(this.map);
    this.markers.push(m);
    if (this.markers.length === 2) this.getRoute();
  }

  getRoute(): void {
    const s = this.markers[0].getLatLng();
    const e = this.markers[1].getLatLng();
    this.ors.getRoute([s.lat, s.lng], [e.lat, e.lng], this.profile).subscribe({
      next: (geojson) => {
        if (this.routeLayer) this.map.removeLayer(this.routeLayer);
        this.routeLayer = L.geoJSON(geojson, { style: { color: 'blue', weight: 5 } }).addTo(this.map);
        const summary = geojson.features[0]?.properties?.summary;
        this.distance = summary?.distance ?? null;
        this.duration = summary?.duration ?? null;
      },
      error: () => this.error = 'Erreur lors du calcul de l’itinéraire.'
    });
  }

  snapMarkers(): void {
    if (this.markers.length === 0) return;
    const pts: [number, number][] = this.markers.map(m => {
      const p = m.getLatLng();
      return [p.lng, p.lat];
    });
    this.ors.snapPoints(pts, this.profile).subscribe({
      next: (geojson) => {
        if (this.snappedLayer) this.map.removeLayer(this.snappedLayer);
        this.snappedLayer = L.geoJSON(geojson, {
          style: { color: 'red', weight: 4 },
          pointToLayer: (_f, latlng) =>
            L.circleMarker(latlng, { radius: 6, fillColor: 'red', color: '#900', weight: 2, opacity: 1, fillOpacity: 0.8 })
        }).addTo(this.map);
      },
      error: () => this.error = 'Erreur lors de la correction des points.'
    });
  }

  // ---------- Geolocation ----------
  async locateMe(pan = true) {
    this.error = null;

    const getPos = (opts: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, opts)
      );

    const attempts: PositionOptions[] = [
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 },
      { enableHighAccuracy: true,  timeout: 12000, maximumAge: 0 },
    ];

    let pos: GeolocationPosition | null = null;
    let lastErr: any = null;

    for (const a of attempts) {
      try { pos = await getPos(a); break; } catch (e) { lastErr = e; }
    }
    if (!pos) {
      const code = (lastErr && (lastErr as GeolocationPositionError).code) || 0;
      this.error = code === 1
        ? 'رفض الوصول للموقع. اسمح بالوصول وجرب ثانية.'
        : code === 2
        ? 'موضع غير متاح حالياً.'
        : code === 3
        ? 'انتهى الوقت (TIMEOUT).'
        : 'تعذّر تحديد الموقع.';
      return;
    }

    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    this.userLoc = L.latLng(lat, lng);

    if (this.gpsMarker) this.map.removeLayer(this.gpsMarker);
    if (this.gpsCircle) this.map.removeLayer(this.gpsCircle);

    this.gpsMarker = L.marker(this.userLoc).addTo(this.map)
      .bindPopup(`Accuracy: ${Math.round(accuracy)} m`);
    this.gpsCircle = L.circle(this.userLoc, { radius: accuracy, color: '#3388ff', fillOpacity: 0.15 }).addTo(this.map);

    if (pan) this.map.setView(this.userLoc, Math.max(this.map.getZoom(), 16));
  }

  // ---------- POIs ----------
  loadPois() {
    this.error = null;

    if (this.mode === 'gps') {
      const center = this.userLoc ?? this.map.getCenter();
      this.ors.getPoisGeneric({
        mode: 'point',
        center,
        bufferMeters: this.bufferMeters,
        categoryIds: this.categoryIds
      }).subscribe({
        next: data => this.displayPois(data.features),
        error: err => this.handlePoiError(err)
      });
    } else {
      const b = this.map.getBounds();
      const bbox: [[number, number], [number, number]] = [
        [b.getSouthWest().lng, b.getSouthWest().lat],
        [b.getNorthEast().lng, b.getNorthEast().lat]
      ];
      this.ors.getPoisGeneric({
        mode: 'bbox',
        bbox,
        categoryIds: this.categoryIds
      }).subscribe({
        next: (data)=> this.displayPois(data.features),
        error: (err) => this.handlePoiError(err)
      });
    }
  }

  private handlePoiError(err: any) {
    console.error('Erreur POIs:', err);
    if (err?.error) console.error('Erreur body:', err.error);
    this.error = `Erreur POIs : ${err.message ?? err}`;
  }

  private displayPois(features: any[]) {
    this.poisLayer.clearLayers();
    if (!features?.length) { this.error = 'ما فما حتى نقاط اهتمام في النطاق المحدّد.'; return; }

    const group: L.LatLng[] = [];
    features.forEach(f => {
      if (f?.geometry?.type !== 'Point') return;
      const [lon, lat] = f.geometry.coordinates ?? [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      const m = L.marker([lat, lon]).bindPopup(f.properties?.name || f.properties?.osm_tags?.name || 'POI');
      this.poisLayer.addLayer(m);
      group.push(L.latLng(lat, lon));
    });
    if (group.length) this.map.fitBounds(L.latLngBounds(group).pad(0.2));
  }

  // ---------- Isochrones ----------
  drawIsochrones() {
    this.error = null;

    const center = this.mode === 'gps'
      ? (this.userLoc ? [this.userLoc.lat, this.userLoc.lng] as [number, number] : [this.map.getCenter().lat, this.map.getCenter().lng] as [number, number])
      : [this.map.getCenter().lat, this.map.getCenter().lng] as [number, number];

    this.ors.getIsochrones({
      profile: this.isoProfile,
      center,
      method: this.isoMethod,
      range: this.isoRange,
      interval: this.isoInterval
    }).subscribe({
      next: (geojson: any) => {
        if (this.isoLayer) this.map.removeLayer(this.isoLayer);
        this.isoLayer = L.geoJSON(geojson, {
          style: () => ({ color: '#cc0000', weight: 2, fillOpacity: 0.35 })
        }).addTo(this.map);

        try { this.map.fitBounds(this.isoLayer.getBounds().pad(0.2)); } catch {}
      },
      error: (err) => this.error = `Erreur isochrones : ${err.message ?? err}`
    });
  }

  clearIsochrones() {
    if (this.isoLayer) { this.map.removeLayer(this.isoLayer); this.isoLayer = null; }
  }

  // ---------- Search / Autocomplete ----------
  onSearchInput(q: string) {
    this.searchInput$.next(q);
  }

  triggerSearch() {
    if (this.searchResults.length && this.highlightIndex >= 0) {
      this.goToSearchResult(this.searchResults[this.highlightIndex]);
    } else {
      this.searchInput$.next(this.searchQuery);
    }
  }

  onSearchKeydown(ev: KeyboardEvent) {
    if (!this.searchResults.length) return;

    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.highlightIndex = (this.highlightIndex + 1) % this.searchResults.length;
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.highlightIndex = (this.highlightIndex - 1 + this.searchResults.length) % this.searchResults.length;
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (this.highlightIndex >= 0) {
        this.goToSearchResult(this.searchResults[this.highlightIndex]);
      }
    } else if (ev.key === 'Escape') {
      this.searchResults = [];
      this.highlightIndex = -1;
    }
  }

  onDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const isInsideTopbar = target.closest('.ors-topbar');
    if (!isInsideTopbar) {
      this.searchResults = [];
      this.highlightIndex = -1;
    }
  }

  goToSearchResult(item: Pick<NominatimItem, 'display_name'|'lat'|'lon'>) {
    const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    if (this.searchMarker) this.map.removeLayer(this.searchMarker);
    this.searchMarker = L.marker([lat, lon]).bindPopup(item.display_name).addTo(this.map).openPopup();
    this.map.setView([lat, lon], 15);

    this.searchResults = [];
    this.highlightIndex = -1;
  }

  // ---------- Clear ----------
  clearAll(): void {
    this.clearMarkers(); this.clearRoute(); this.clearSnapped(); this.clearPois(); this.clearIsochrones();
    this.distance = this.duration = null; this.error = null;
  }
  clearMarkers(): void { this.markers.forEach(m => this.map.removeLayer(m)); this.markers = []; }
  clearRoute(): void { if (this.routeLayer) { this.map.removeLayer(this.routeLayer); this.routeLayer = null; } }
  clearSnapped(): void { if (this.snappedLayer) { this.map.removeLayer(this.snappedLayer); this.snappedLayer = null; } }
  clearPois(): void { this.poisLayer.clearLayers(); }
}
