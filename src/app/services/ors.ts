import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, EMPTY, map, tap } from 'rxjs';
import { environment } from '../environment';
import * as L from 'leaflet';

type BBoxNested = [[number, number], [number, number]];
type FlatBBox = [number, number, number, number];
@Injectable({ providedIn: 'root' })
export class Ors{
  private apiUrl = '/ors-api';

  constructor(private http: HttpClient) {}

  private getHeaders(contentType: string = 'application/json'): HttpHeaders {
    return new HttpHeaders({
      'Authorization': environment.orsApiKey,
      'Content-Type': contentType
    });
  }

  getRoute(start: [number, number], end: [number, number], profile = 'driving-car'): Observable<any> {
    const url = `${this.apiUrl}/v2/directions/${profile}/geojson`;
    const body = { coordinates: [[start[1], start[0]], [end[1], end[0]]] };
    return this.http.post(url, body, { headers: this.getHeaders() });
  }
  snapPoints(points: [number, number][], profile = 'driving-car', radius = 300): Observable<any> {
    const url = `${this.apiUrl}/v2/snap/${profile}/geojson`;
    const body = { locations: points, radius };
    return this.http.post(url, body, { headers: this.getHeaders() });
  }

  getPoisGeneric(opts: {
    mode: 'point' | 'bbox',
    center?: L.LatLng,                
    bufferMeters?: number,            
    bbox?: BBoxNested,               
    categoryIds?: number[]           
  }): Observable<any> {
    const url = `${this.apiUrl}/pois`;
    const body: any = {
      request: 'pois',
      limit: 100
    };

    if (opts.mode === 'point') {
      if (!opts.center || !Number.isFinite(opts.center.lat) || !Number.isFinite(opts.center.lng)) {
        console.warn('Invalid center for POIs.');
        return EMPTY;
      }
      const buffer = Math.max(50, Math.min(opts.bufferMeters ?? 500, 5000)); // 50..5000m
      body.geometry = {
        geojson: { type: 'Point', coordinates: [opts.center.lng, opts.center.lat] },
        buffer
      };
    } else {
      if (!opts.bbox) {
        console.warn('Missing bbox for POIs.');
        return EMPTY;
      }
      body.geometry = { bbox: opts.bbox }; // [[minLon,minLat],[maxLon,maxLat]]
    }

    if (opts.categoryIds && opts.categoryIds.length) {
      body.filters = { category_ids: opts.categoryIds };
    }

    return this.http.post(url, body, {
      headers: this.getHeaders(),
      responseType: 'text' as const // pour corriger NaN
    }).pipe(
      tap(txt => console.log('POIs raw text:', txt)),
      map(txt => {
        const fixed = txt.replace(/\bNaN\b/g, 'null');
        const data = JSON.parse(fixed);

        if (data?.bbox && data.bbox.some((v: any) => v === null || Number.isNaN(v))) {
          if (Array.isArray(data.features) && data.features.length > 0) {
            data.bbox = this.computeBboxFromFeatures(data.features);
          } else {
            delete data.bbox;
          }
        }

        if (!data || !Array.isArray(data.features)) {
          throw new Error('Réponse POIs inattendue.');
        }
        return data;
      })
    );
  }

  private computeBboxFromFeatures(features: any[]): FlatBBox | null {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const f of features) {
      if (f?.geometry?.type === 'Point') {
        const [lon, lat] = f.geometry.coordinates ?? [];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (minLon === Infinity) return null;
    return [minLon, minLat, maxLon, maxLat];
  }
 getIsochrones(opts: {
  profile: 'driving-car' | 'cycling-regular' | 'foot-walking' | string,
  center: [number, number],       
  method: 'distance' | 'time',    
  range: number,                   
  interval: number                
}) {
  const url = `${this.apiUrl}/v2/isochrones/${opts.profile}`;

  const toMeters = (km: number) => Math.max(1, Math.round(km * 1000));
  const toSeconds = (min: number) => Math.max(1, Math.round(min * 60));

  const steps: number[] = [];
  const n = Math.max(1, Math.floor(opts.range / Math.max(1, opts.interval)));
  for (let i = 1; i <= n; i++) steps.push(i * opts.interval);

  const rangeArr = opts.method === 'distance'
    ? steps.map(toMeters)
    : steps.map(toSeconds);

  const body = {
    locations: [[opts.center[1], opts.center[0]]], 
    range_type: opts.method,
    range: rangeArr
  };

  return this.http.post(url, body, {
    headers: this.getHeaders(),
    responseType: 'json'
  });
}

}


