import { Component } from '@angular/core';
import { DataToQr } from './data-to-qr/data-to-qr';

@Component({
  selector: 'app-root',
  imports: [DataToQr],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
