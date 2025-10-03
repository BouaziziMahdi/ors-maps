import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MapComponent } from './components/map/map';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, MapComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('ors-maps');
}
